// Room protocol. The host's browser owns the table: it seats players, runs the
// rules engine, persists everything locally, and sends each player a sealed,
// filtered view. Players send moves; the host validates every one of them.
//
// Messages (inside the room-key envelope from bus.js):
//   knock player -> all   {}                         "announce yourself" before a player knows the host key
//   hi    player -> all   { pub, box }               box = pair-sealed { name, want, rev }: presence, seat, catch-up
//   host  host   -> all   { pub, lobby, rev }        presence + public lobby
//   sync  host   -> one   { pub, box }               box = pair-sealed { rev, lobby, game, chat, tally }
//   act   player -> host  { box }                    box = pair-sealed { aid, base, action }
//   res   host   -> one   { box }                    box = pair-sealed { aid, ok, error }
//   bye   any    -> all   {}                         tab closing

import { Bus } from './bus.js';
import { fingerprint, pairKey, sealText, openText, randomId } from './crypto.js';
import { newGame, applyAction, viewFor, MAX_PLAYERS, MIN_PLAYERS } from '../engine.js';
import { saveHostRecord } from './identity.js';
import { every } from './ticker.js';

const HEARTBEAT_MS = 3000;
const ONLINE_MS = 10000;
const ACT_RETRY_MS = 2500;
const ACT_TRIES = 8;
const CHAT_KEEP = 120;
const CLIENTS_MAX = 24;
const CHAT_SEND = 60;
export const NAME_MAX = 20;
export const CHAT_MAX = 240;

export function cleanName(name) {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim() : '';
  return s.slice(0, NAME_MAX) || 'Player';
}

function cleanChat(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim().slice(0, CHAT_MAX);
}

// The host is trusted with the rules, but a view that isn't even shaped like a
// view gets dropped rather than handed to the renderer.
function plausibleSync(m) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(m) || !Number.isInteger(m.rev) || !isObj(m.lobby) || !Array.isArray(m.lobby.seats)) return false;
  if (m.game === null) return true;
  const g = m.game;
  return isObj(g) && Array.isArray(g.players) && g.players.length >= 2 && g.players.length <= MAX_PLAYERS
    && isObj(g.board) && isObj(g.bank) && isObj(g.deckCounts) && Array.isArray(g.log) && Array.isArray(g.nobles)
    && Number.isInteger(g.version) && Number.isInteger(g.turn) && Number.isInteger(g.you);
}

class Emitter {
  constructor() { this.listeners = new Set(); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
}

// Simple token bucket so one noisy client can't flood the host.
function bucket(capacity, perSecond) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// ======================================================================
// Host
// ======================================================================

export class HostRoom extends Emitter {
  constructor({ room, secret, identity, name, record, storage, relays }) {
    super();
    this.role = 'host';
    this.room = room;
    this.identity = identity;
    this.storage = storage;
    this.record = record || {
      v: 1,
      secret,
      hostId: identity.id,
      seats: [{ id: identity.id, name: cleanName(name), pub: identity.pub }],
      blocked: [],
      status: 'lobby', // lobby | playing | over
      game: null,
      chat: [],
      tally: {},
      rev: 1,
      createdAt: Date.now(),
    };
    this.clients = new Map();
    this.bus = new Bus({
      topic: `facet/v1/${room.id}`,
      key: room.key,
      selfId: identity.id,
      relays,
      onMessage: (env) => this.onMessage(env).catch(() => {}),
      onStatus: () => { this.announce(); this.emit(); },
    });
  }

  start() {
    this.persist();
    this.bus.start();
    this.stopTicks = every(HEARTBEAT_MS, () => this.tick());
  }

  stop() {
    this.stopTicks?.();
    this.bus.send('bye', {}).catch(() => {});
    setTimeout(() => this.bus.stop(), 150);
  }

  wake() { this.bus.wake(); this.announce(); }

  // ----- presence -----

  isOnline(id) {
    if (id === this.record.hostId) return true;
    const c = this.clients.get(id);
    return !!c && Date.now() - c.lastSeen < ONLINE_MS;
  }

  lobbyPublic() {
    const r = this.record;
    return {
      status: r.status,
      max: MAX_PLAYERS,
      seats: r.seats.map((s) => ({ id: s.id, name: s.name, host: s.id === r.hostId, online: this.isOnline(s.id) })),
    };
  }

  tick() {
    this.announce();
    for (const [id, c] of this.clients) {
      if (this.isOnline(id) && c.rev < this.record.rev) this.sendSync(id);
    }
    const presence = this.record.seats.map((s) => this.isOnline(s.id)).join();
    if (presence !== this.lastPresence) { this.lastPresence = presence; this.emit(); }
  }

  announce() {
    this.bus.send('host', { pub: this.identity.pub, lobby: this.lobbyPublic(), rev: this.record.rev }).catch(() => {});
  }

  // ----- inbound -----

  async onMessage(env) {
    if (env.t === 'knock') {
      if (Date.now() - (this.lastKnock || 0) > 800) { this.lastKnock = Date.now(); this.announce(); }
      return;
    }
    if (env.t === 'hi') return this.onHi(env);
    if (env.t === 'act') return this.onAct(env);
    if (env.t === 'bye') {
      const c = this.clients.get(env.f);
      if (c) { c.lastSeen = 0; this.tick(); }
    }
  }

  async client(id, pub) {
    let c = this.clients.get(id);
    if (c) return c;
    if (typeof pub !== 'string' || pub.length > 120 || (await fingerprint(pub)) !== id) return null;
    // Anyone holding the link can mint identities; keep the list bounded and
    // drop the longest-silent unseated one first.
    if (this.clients.size >= CLIENTS_MAX) {
      const seated = new Set(this.record.seats.map((x) => x.id));
      const stale = [...this.clients].filter(([k]) => !seated.has(k)).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!stale) return null;
      this.clients.delete(stale[0]);
    }
    c = {
      pub,
      key: pairKey(this.identity, pub, this.room.secretBytes),
      lastSeen: 0,
      rev: -1,
      aids: new Map(),
      allow: bucket(30, 3),
    };
    this.clients.set(id, c);
    return c;
  }

  async onHi({ f, d: raw }) {
    if (!raw || typeof raw !== 'object' || typeof raw.box !== 'string' || raw.box.length > 2000) return;
    const c = await this.client(f, raw.pub);
    if (!c || !c.allow()) return;
    // Sealed with the pair key, so only the holder of this identity can move its seat.
    const d = await openText(await c.key, raw.box);
    if (!d || typeof d !== 'object') return;
    const wasOnline = this.isOnline(f);
    c.lastSeen = Date.now();
    c.rev = Number.isInteger(d.rev) ? d.rev : -1;
    const r = this.record;
    const name = cleanName(d.name);
    let changed = false;
    let seat = r.seats.find((s) => s.id === f);
    if (r.status === 'lobby') {
      if (d.want === 'seat' && !seat && r.seats.length < MAX_PLAYERS && !r.blocked.includes(f)) {
        seat = { id: f, name, pub: c.pub };
        r.seats.push(seat);
        this.chatSystem(`${name} sat down.`);
        changed = true;
      } else if (d.want === 'leave' && seat) {
        r.seats = r.seats.filter((s) => s.id !== f);
        this.chatSystem(`${seat.name} left the table.`);
        seat = null;
        changed = true;
      }
    }
    if (seat && seat.name !== name) {
      seat.name = name;
      const p = r.game?.players.find((x) => x.id === f);
      if (p) p.name = name;
      changed = true;
    }
    if (changed) this.bump();
    else if (c.rev < r.rev) this.sendSync(f);
    if (!wasOnline) this.tick();
  }

  async onAct({ f, d }) {
    const c = this.clients.get(f);
    if (!c || !d || typeof d.box !== 'string' || d.box.length > 20000 || !c.allow()) return;
    c.lastSeen = Date.now();
    const msg = await openText(await c.key, d.box);
    if (!msg || typeof msg.aid !== 'string' || msg.aid.length > 40) return;
    let res = c.aids.get(msg.aid);
    if (!res) {
      res = this.process(f, msg);
      c.aids.set(msg.aid, res);
      if (c.aids.size > 60) c.aids.delete(c.aids.keys().next().value);
      if (res.ok) this.bump();
    } else if (c.rev < this.record.rev) {
      this.sendSync(f);
    }
    this.sendBox('res', f, { aid: msg.aid, ok: res.ok, error: res.error });
  }

  // One move from one seat. Guests pass `base` (the game version they saw) so a
  // move made against a stale table is refused instead of misapplied.
  process(playerId, { base, action }) {
    const r = this.record;
    if (!action || typeof action !== 'object') return { ok: false, error: 'Unknown move.' };
    const seated = r.seats.some((s) => s.id === playerId);
    if (!seated) return { ok: false, error: "You're not seated at this table." };
    if (action.type === 'chat') {
      const text = cleanChat(action.text);
      if (!text) return { ok: false, error: 'Empty message.' };
      const seat = r.seats.find((s) => s.id === playerId);
      this.pushChat({ from: playerId, name: seat.name, text });
      return { ok: true };
    }
    if (r.status !== 'playing' || !r.game) return { ok: false, error: 'No game in progress.' };
    if (base !== undefined && base !== r.game.version) return { ok: false, error: 'The table changed. Try that again.' };
    const out = applyAction(r.game, playerId, action);
    if (!out.ok) return out;
    r.game = out.state;
    if (r.game.phase === 'over') this.finishGame();
    return { ok: true };
  }

  finishGame() {
    const r = this.record;
    r.status = 'over';
    for (const w of r.game.result.winners) {
      const id = r.game.players[w].id;
      r.tally[id] = (r.tally[id] || 0) + 1;
    }
  }

  // ----- host's own controls -----

  async act(action) {
    const res = this.process(this.record.hostId, { action });
    if (res.ok) this.bump();
    return res;
  }

  startGame() {
    const r = this.record;
    if (r.status === 'playing') return { ok: false, error: 'A game is already running.' };
    if (r.seats.length < MIN_PLAYERS) return { ok: false, error: 'Waiting for at least one more player.' };
    r.game = newGame(r.seats.map((s) => ({ id: s.id, name: s.name })));
    r.status = 'playing';
    this.chatSystem(`New game. ${r.game.players[r.game.start].name} goes first.`);
    this.bump();
    return { ok: true };
  }

  backToLobby() {
    const r = this.record;
    r.status = 'lobby';
    r.game = null;
    this.bump();
  }

  removeSeat(id) {
    const r = this.record;
    if (r.status === 'playing' || id === r.hostId) return;
    const seat = r.seats.find((s) => s.id === id);
    if (!seat) return;
    r.seats = r.seats.filter((s) => s.id !== id);
    r.blocked.push(id);
    this.chatSystem(`${seat.name} was removed from the table.`);
    this.bump();
  }

  setName(name) {
    const r = this.record;
    const clean = cleanName(name);
    const seat = r.seats.find((s) => s.id === r.hostId);
    if (seat.name === clean) return;
    seat.name = clean;
    const p = r.game?.players.find((x) => x.id === r.hostId);
    if (p) p.name = clean;
    this.bump();
  }

  // ----- outbound -----

  pushChat({ from, name, text }) {
    const chat = this.record.chat;
    chat.push({ id: randomId(6), from, name, text, at: Date.now() });
    if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
  }

  chatSystem(text) { this.pushChat({ from: null, name: null, text }); }

  bump() {
    this.record.rev += 1;
    this.persist();
    this.emit();
    for (const [id] of this.clients) if (this.isOnline(id)) this.sendSync(id);
    this.announce();
  }

  persist() {
    saveHostRecord(this.storage, this.room.id, this.record);
  }

  payloadFor(id) {
    const r = this.record;
    const seated = r.seats.some((s) => s.id === id);
    return {
      rev: r.rev,
      lobby: this.lobbyPublic(),
      game: seated && r.game ? viewFor(r.game, id) : null,
      chat: seated ? r.chat.slice(-CHAT_SEND) : [],
      tally: r.tally,
    };
  }

  async sendSync(id) {
    const c = this.clients.get(id);
    if (!c) return;
    const box = await sealText(await c.key, this.payloadFor(id));
    this.bus.send('sync', { pub: this.identity.pub, box }, id).catch(() => {});
  }

  async sendBox(type, id, payload) {
    const c = this.clients.get(id);
    if (!c) return;
    const box = await sealText(await c.key, payload);
    this.bus.send(type, { box }, id).catch(() => {});
  }

  snapshot() {
    const r = this.record;
    return {
      role: 'host',
      selfId: r.hostId,
      hostId: r.hostId,
      link: this.bus.status(),
      hostOnline: true,
      synced: true,
      seated: true,
      lobby: this.lobbyPublic(),
      game: r.game ? viewFor(r.game, r.hostId) : null,
      chat: r.chat.slice(-CHAT_SEND),
      tally: r.tally,
      rev: r.rev,
    };
  }
}

// ======================================================================
// Guest
// ======================================================================

export class GuestRoom extends Emitter {
  constructor({ room, hostId, identity, name, relays }) {
    super();
    this.role = 'guest';
    this.room = room;
    this.hostId = hostId;
    this.identity = identity;
    this.name = cleanName(name);
    this.want = 'seat';
    this.rev = -1;
    this.lobby = null;
    this.game = null;
    this.chat = [];
    this.tally = {};
    this.lastHost = 0;
    this.pending = new Map();
    this.bus = new Bus({
      topic: `facet/v1/${room.id}`,
      key: room.key,
      selfId: identity.id,
      relays,
      onMessage: (env) => this.onMessage(env).catch(() => {}),
      onStatus: (st) => { if (st.up) this.hi(); this.emit(); },
    });
  }

  start() {
    this.bus.start();
    this.stopTicks = every(HEARTBEAT_MS, () => this.tick());
  }

  stop() {
    this.stopTicks?.();
    for (const p of this.pending.values()) { clearInterval(p.timer); p.resolve({ ok: false, error: 'Left the table.' }); }
    this.pending.clear();
    this.bus.send('bye', {}).catch(() => {});
    setTimeout(() => this.bus.stop(), 150);
  }

  wake() { this.bus.wake(); this.hi(); }

  get hostOnline() { return Date.now() - this.lastHost < ONLINE_MS; }

  tick() {
    this.hi();
    const online = this.hostOnline;
    if (online !== this.lastOnline) { this.lastOnline = online; this.emit(); }
  }

  async hi() {
    this.lastHi = Date.now();
    if (!this.key) {
      this.bus.send('knock', {}).catch(() => {});
      return;
    }
    const box = await sealText(this.key, { name: this.name, want: this.want, rev: this.rev });
    this.bus.send('hi', { pub: this.identity.pub, box }).catch(() => {});
  }

  // Only the host whose id is pinned in the invite link is believed.
  async hostKey(pub) {
    if (this.key) return pub === this.hostPub ? this.key : null;
    if (typeof pub !== 'string' || (await fingerprint(pub)) !== this.hostId) return null;
    this.hostPub = pub;
    this.key = await pairKey(this.identity, pub, this.room.secretBytes);
    this.hi();
    return this.key;
  }

  async onMessage(env) {
    if (env.f !== this.hostId || !env.d || typeof env.d !== 'object') return;
    const d = env.d;
    if (env.t === 'bye') { this.lastHost = 0; this.emit(); return; }
    if (env.t === 'host') {
      if (!(await this.hostKey(d.pub))) return;
      this.lastHost = Date.now();
      if (this.rev < 0 && d.lobby) this.lobby = d.lobby;
      if (Number.isInteger(d.rev) && d.rev > this.rev && Date.now() - this.lastHi > 1200) this.hi();
      this.emit();
      return;
    }
    const key = this.key || (await this.hostKey(d.pub));
    if (!key) return;
    const msg = await openText(key, d.box);
    if (msg) this.lastHost = Date.now();
    if (!msg) return;
    if (env.t === 'sync' && plausibleSync(msg) && msg.rev > this.rev) {
      this.rev = msg.rev;
      this.lobby = msg.lobby;
      this.game = msg.game;
      this.chat = Array.isArray(msg.chat) ? msg.chat : [];
      this.tally = msg.tally || {};
      this.emit();
    } else if (env.t === 'res') {
      const p = this.pending.get(msg.aid);
      if (p) {
        clearInterval(p.timer);
        this.pending.delete(msg.aid);
        p.resolve({ ok: !!msg.ok, error: msg.error });
      }
    }
  }

  // Send one move; retried until the host answers, since relays are best-effort.
  act(action) {
    return new Promise((resolve) => {
      if (!this.key) { resolve({ ok: false, error: "Can't reach the host yet." }); return; }
      const aid = randomId(8);
      const payload = { aid, action };
      if (action.type !== 'chat' && this.game) payload.base = this.game.version;
      let tries = 0;
      const send = async () => {
        if (tries++ >= ACT_TRIES) {
          clearInterval(entry.timer);
          this.pending.delete(aid);
          resolve({ ok: false, error: "The host isn't responding. Your move wasn't played." });
          return;
        }
        const box = await sealText(this.key, payload);
        this.bus.send('act', { box }, this.hostId).catch(() => {});
      };
      const entry = { resolve, timer: setInterval(send, ACT_RETRY_MS) };
      this.pending.set(aid, entry);
      send();
    });
  }

  setName(name) {
    this.name = cleanName(name);
    this.hi();
  }

  leaveSeat() {
    this.want = 'leave';
    this.hi();
  }

  takeSeat() {
    this.want = 'seat';
    this.hi();
  }

  snapshot() {
    const seated = !!this.lobby?.seats.some((s) => s.id === this.identity.id);
    return {
      role: 'guest',
      selfId: this.identity.id,
      hostId: this.hostId,
      link: this.bus.status(),
      hostOnline: this.hostOnline,
      synced: this.rev >= 0,
      seated,
      lobby: this.lobby,
      game: this.game,
      chat: this.chat,
      tally: this.tally,
      rev: this.rev,
    };
  }
}
