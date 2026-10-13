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
import { newGame, applyAction, applyTimeout, viewFor, MAX_PLAYERS, MIN_PLAYERS, isValidTarget, WIN_POINTS } from '../engine.js';
import { botAction } from '../bot.js';
import { saveHostRecord, lobbyExpired, expireHostRecord } from './identity.js';
import { every } from './ticker.js';

const HEARTBEAT_MS = 3000;
const ONLINE_MS = 10000;
const ACT_RETRY_MS = 2500;
const ACT_TRIES = 8;
const CHAT_KEEP = 120;
const CLIENTS_MAX = 24;
const CHAT_SEND = 60;
export const NAME_MAX = 20;
// Turn timer presets in seconds: Slow 3 min, Normal 2 min, Fast 1 min, or Off (0).
export const TIMER_CHOICES = [180, 120, 60, 0];
const DEFAULT_TURN_SECONDS = 180;
const GRACE_MS = 30000;
// A bot waits a beat before it moves, so people can follow what it did.
const BOT_THINK_MS = 900;
const BOT_NAMES = ['Opal', 'Jasper', 'Garnet', 'Beryl', 'Topaz', 'Agate'];
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

function parseTimer(t) {
  if (!t || typeof t !== 'object' || !TIMER_CHOICES.includes(t.seconds) || !t.seconds) return null;
  const ms = Number(t.remainingMs);
  if (!Number.isFinite(ms) || ms < 0 || ms > t.seconds * 1000 + GRACE_MS) return null;
  return { seconds: t.seconds, deadline: Date.now() + ms };
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
      settings: { turnSeconds: DEFAULT_TURN_SECONDS, target: WIN_POINTS, hints: false },
      rev: 1,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.deadline = null;
    this.clients = new Map();
    this.bus = new Bus({
      topic: `trilliant/v1/${room.id}`,
      key: room.key,
      selfId: identity.id,
      relays,
      onMessage: (env) => this.onMessage(env).catch(() => {}),
      onStatus: () => { this.announce(); this.emit(); },
    });
  }

  start() {
    if (this.expireIfIdle() || this.record.status === 'expired') return;
    // The clock doesn't run while the host is away, so a reopened game never
    // skips someone on the spot. It picks up where it stopped: reloading the
    // host tab must not hand anyone a fresh turn.
    this.resumeClock();
    this.persist();
    this.bus.start();
    this.stopTicks = every(HEARTBEAT_MS, () => this.tick());
    this.stopClock = every(1000, () => this.checkClock());
    this.stopBots = every(1000, () => this.playBots());
  }

  stop() {
    this.stopTicks?.();
    this.stopClock?.();
    this.stopBots?.();
    this.bus.send('bye', {}).catch(() => {});
    setTimeout(() => this.bus.stop(), 150);
  }

  wake() { if (!this.expireIfIdle()) { this.bus.wake(); this.announce(); } }

  expireIfIdle(now = Date.now()) {
    if (this.record.status === 'expired') return true;
    if (!lobbyExpired(this.record, now)) return false;
    this.record = expireHostRecord(this.storage, this.room.id, this.record, now);
    this.deadline = null;
    this.stopTicks?.();
    this.stopClock?.();
    this.stopBots?.();
    this.emit();
    for (const [id] of this.clients) this.sendSync(id);
    this.announce();
    return true;
  }

  // ----- presence -----

  isBot(id) { return !!this.record.seats.find((s) => s.id === id)?.bot; }

  isOnline(id) {
    if (id === this.record.hostId || this.isBot(id)) return true;
    const c = this.clients.get(id);
    return !!c && Date.now() - c.lastSeen < ONLINE_MS;
  }

  lobbyPublic() {
    const r = this.record;
    return {
      status: r.status,
      max: MAX_PLAYERS,
      turnSeconds: this.turnSeconds,
      target: this.target,
      hints: this.hints,
      seats: r.seats.map((s) => ({ id: s.id, name: s.name, host: s.id === r.hostId, online: this.isOnline(s.id), bot: !!s.bot })),
    };
  }

  // ----- turn clock -----

  get target() {
    const t = this.record.settings?.target;
    return isValidTarget(t) ? t : WIN_POINTS;
  }

  setTarget(points) {
    if (this.expireIfIdle()) return;
    const r = this.record;
    if (r.status === 'playing' || !isValidTarget(points) || points === this.target) return;
    r.settings = { ...(r.settings || {}), target: points };
    this.bump();
  }

  // Hints mark the cards a player can buy and spell out what they are short.
  // Off unless the host turns them on.
  get hints() { return this.record.settings?.hints === true; }

  setHints(on) {
    if (this.expireIfIdle()) return;
    const r = this.record;
    if (r.status === 'playing' || typeof on !== 'boolean' || on === this.hints) return;
    r.settings = { ...(r.settings || {}), hints: on };
    this.bump();
  }

  get turnSeconds() {
    const t = this.record.settings?.turnSeconds;
    return TIMER_CHOICES.includes(t) ? t : DEFAULT_TURN_SECONDS;
  }

  restartClock() {
    const playing = this.record.status === 'playing' && this.record.game;
    this.deadline = playing && this.turnSeconds ? Date.now() + this.turnSeconds * 1000 : null;
  }

  // Time left on the current turn, as last saved. A guest also gets the grace
  // period to reconnect; the host doesn't, or reloading would top up their clock.
  resumeClock() {
    const r = this.record;
    const saved = r.clock;
    const playing = r.status === 'playing' && r.game;
    if (!playing || !this.turnSeconds || !saved || saved.version !== r.game.version || !Number.isFinite(saved.left)) {
      this.restartClock();
      return;
    }
    const hostTurn = r.game.players[r.game.turn]?.id === r.hostId;
    const left = Math.min(Math.max(saved.left, hostTurn ? 0 : GRACE_MS), this.turnSeconds * 1000);
    this.deadline = Date.now() + left;
  }

  // A new player gets a full clock. A player still putting gems back or
  // choosing a noble keeps theirs, but gets at least a short grace period.
  clockAfterMove(prevTurn) {
    const g = this.record.game;
    if (!g || this.record.status !== 'playing') this.deadline = null;
    else if (g.turn !== prevTurn) this.restartClock();
    else if (this.deadline) this.deadline = Math.max(this.deadline, Date.now() + GRACE_MS);
  }

  checkClock() {
    const r = this.record;
    if (r.status !== 'playing' || !r.game || !this.deadline) return;
    if (Date.now() < this.deadline) { this.persist(); return; }
    const prevTurn = r.game.turn;
    const out = applyTimeout(r.game);
    if (!out.ok) { this.deadline = null; return; }
    r.game = out.state;
    if (r.game.phase === 'over') this.finishGame();
    this.clockAfterMove(prevTurn);
    this.bump();
  }

  timerInfo() {
    if (this.record.status !== 'playing' || !this.deadline) return null;
    return { seconds: this.turnSeconds, remainingMs: Math.max(0, this.deadline - Date.now()) };
  }

  setTimer(seconds) {
    if (this.expireIfIdle()) return;
    const r = this.record;
    if (r.status === 'playing' || !TIMER_CHOICES.includes(seconds) || seconds === this.turnSeconds) return;
    r.settings = { ...(r.settings || {}), turnSeconds: seconds };
    this.bump();
  }

  tick() {
    if (this.expireIfIdle()) return;
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
    this.expireIfIdle();
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
    if (this.expireIfIdle()) return { ok: false, error: 'This lobby expired.' };
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
    if (base !== undefined && base !== r.game.version) return { ok: false, error: 'The game moved on. Try that again.' };
    const prevTurn = r.game.turn;
    const out = applyAction(r.game, playerId, action);
    if (!out.ok) return out;
    r.game = out.state;
    if (r.game.phase === 'over') this.finishGame();
    this.clockAfterMove(prevTurn);
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
    if (this.expireIfIdle()) return { ok: false, error: 'This lobby expired.' };
    const r = this.record;
    if (r.status === 'playing') return { ok: false, error: 'A game is already running.' };
    if (r.seats.length < MIN_PLAYERS) return { ok: false, error: 'Waiting for at least one more player.' };
    r.game = newGame(r.seats.map((s) => ({ id: s.id, name: s.name })), { target: this.target });
    r.status = 'playing';
    this.restartClock();
    this.chatSystem(`New game. ${r.game.players[r.game.start].name} goes first.`);
    this.bump();
    return { ok: true };
  }

  backToLobby() {
    const r = this.record;
    if (r.status === 'expired') return;
    r.status = 'lobby';
    r.game = null;
    this.deadline = null;
    this.bump();
  }

  removeSeat(id) {
    if (this.expireIfIdle()) return;
    const r = this.record;
    if (r.status === 'playing' || id === r.hostId) return;
    const seat = r.seats.find((s) => s.id === id);
    if (!seat) return;
    r.seats = r.seats.filter((s) => s.id !== id);
    if (!seat.bot) {
      r.blocked.push(id);
      this.chatSystem(`${seat.name} was removed from the table.`);
    }
    this.bump();
  }

  // ----- bots -----

  // A bot is a seat the host plays. Its id has a colon in it, which a real
  // player's id (the fingerprint of their key) never does, so nobody can knock
  // as a bot or move for one.
  addBot() {
    if (this.expireIfIdle()) return { ok: false, error: 'This lobby expired.' };
    const r = this.record;
    if (r.status !== 'lobby') return { ok: false, error: 'Add bots before the game starts.' };
    if (r.seats.length >= MAX_PLAYERS) return { ok: false, error: 'The game is full.' };
    const taken = new Set(r.seats.map((s) => s.name));
    const free = BOT_NAMES.filter((n) => !taken.has(n));
    const name = free[Math.floor(Math.random() * free.length)] || 'Bot';
    r.seats.push({ id: `bot:${randomId(6)}`, name, bot: true });
    this.bump();
    return { ok: true };
  }

  // Plays the seat whose turn it is when that seat is a bot. The bot decides
  // from the same view a guest in its seat would be sent, and its move goes
  // through `process` like anyone else's.
  playBots(now = Date.now()) {
    const r = this.record;
    const g = r.status === 'playing' ? r.game : null;
    const id = g && g.players[g.turn].id;
    if (!g || !this.isBot(id)) { this.botMove = null; return; }
    if (this.botMove?.version !== g.version) { this.botMove = { version: g.version, at: now + BOT_THINK_MS }; return; }
    if (now < this.botMove.at) return;
    let res;
    try { res = this.process(id, { action: botAction(viewFor(g, id), g.turn) }); } catch { res = { ok: false }; }
    if (res.ok) { this.bump(); return; }
    // A bot must never hold the game up: if its move didn't go through, skip the turn.
    const out = applyTimeout(g);
    if (!out.ok) return;
    r.game = out.state;
    if (r.game.phase === 'over') this.finishGame();
    this.clockAfterMove(g.turn);
    this.bump();
  }

  setName(name) {
    if (this.expireIfIdle()) return;
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
    if (this.record.status === 'lobby') this.record.lastActivityAt = Date.now();
    this.record.rev += 1;
    this.persist();
    this.emit();
    for (const [id] of this.clients) if (this.isOnline(id)) this.sendSync(id);
    this.announce();
    this.playBots();
  }

  persist() {
    const r = this.record;
    r.clock = r.status === 'playing' && r.game && this.deadline
      ? { version: r.game.version, left: this.deadline - Date.now() }
      : null;
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
      timer: seated ? this.timerInfo() : null,
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
      timer: r.status === 'playing' && this.deadline ? { seconds: this.turnSeconds, deadline: this.deadline } : null,
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
    this.timer = null;
    this.lastHost = 0;
    this.pending = new Map();
    this.bus = new Bus({
      topic: `trilliant/v1/${room.id}`,
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
    await this.bus.send('hi', { pub: this.identity.pub, box }).catch(() => {});
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
      this.timer = parseTimer(msg.timer);
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

  // Give the seat back (lobby only; mid-game the host keeps it for a rejoin).
  async leaveSeat() {
    this.want = 'leave';
    await this.hi();
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
      timer: this.timer,
      rev: this.rev,
    };
  }
}
