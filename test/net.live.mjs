// Live end-to-end test over the real public relays: a host and a guest in one
// process play a full game through the actual protocol, then both "reload"
// mid-game and carry on. Run with: npm run test:live
import assert from 'node:assert/strict';
import { roomFromSecret, newRoomSecret, createIdentity, fingerprint } from '../js/net/crypto.js';
import { HostRoom, GuestRoom } from '../js/net/room.js';
import { testStorage, loadHostRecord } from '../js/net/identity.js';
import { greedyAction } from '../js/bot.js';
import { CARDS } from '../js/data.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (check()) return Date.now() - t0;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const secret = newRoomSecret();
const room = await roomFromSecret(secret);
const hostStorage = testStorage();
const hostId = await createIdentity();
const guestId = await createIdentity();
assert.equal(hostId.id, await fingerprint(hostId.pub));

let host = new HostRoom({ room, secret, identity: hostId, name: 'Vlad', storage: hostStorage });
let guest = new GuestRoom({ room, hostId: hostId.id, identity: guestId, name: 'Sam' });
host.start();
guest.start();

const tSeat = await until(() => host.record.seats.length === 2 && guest.snapshot().seated, 'guest seated');
console.log(`guest seated after ${tSeat} ms; relays up host=${host.bus.status().up} guest=${guest.bus.status().up}`);

// An intruder with the link but a different identity cannot move the guest's seat.
const intruder = await createIdentity();
await host.onMessage({ f: guestId.id, t: 'hi', d: { pub: intruder.pub, box: 'AAAA' } });
await host.onMessage({ f: guestId.id, t: 'hi', d: { pub: guestId.pub, box: 'AAAA' } });
assert.equal(host.record.seats.length, 2, 'forged hi is ignored');

// Chat both ways.
await host.act({ type: 'chat', text: 'gl hf' });
assert.ok((await guest.act({ type: 'chat', text: 'you too <b>bold</b>' })).ok);
await until(() => guest.snapshot().chat.some((m) => m.text === 'gl hf'), 'chat reaches guest');

assert.ok(host.startGame().ok);
await until(() => guest.snapshot().game, 'guest gets the game');

const latencies = [];
let moves = 0;
let reloaded = false;
while (host.record.status === 'playing') {
  const hostSnap = host.snapshot();
  const g = hostSnap.game;
  const me = g.players[g.turn].id;
  if (me === hostId.id) {
    const res = await host.act(greedyAction(host.record.game, g.turn));
    assert.ok(res.ok, res.error);
  } else {
    // Guest decides from ITS OWN view, like the real UI does.
    await until(() => guest.snapshot().game?.version === host.record.game.version, 'guest view caught up');
    const view = guest.snapshot().game;
    const t0 = Date.now();
    const res = await guest.act(greedyAction(view, view.turn));
    latencies.push(Date.now() - t0);
    assert.ok(res.ok, res.error);
  }
  moves++;

  // Guest can never see deck contents or the host's blind reservations.
  const gv = guest.snapshot().game;
  if (gv) {
    assert.equal(gv.decks, undefined);
    const hostSeat = gv.players.findIndex((p) => p.id === hostId.id);
    host.record.game.players[hostSeat].reserved.forEach((r, k) => {
      if (r.blind) assert.equal(gv.players[hostSeat].reserved[k].id, null, 'blind reserve hidden');
    });
  }

  if (moves === 20 && !reloaded) {
    reloaded = true;
    // Guest closes the tab and comes back with the same identity.
    guest.stop();
    await sleep(400);
    guest = new GuestRoom({ room, hostId: hostId.id, identity: guestId, name: 'Sam' });
    guest.start();
    await until(() => guest.snapshot().game?.version === host.record.game.version, 'guest recovers after reload');
    // Host reloads from its saved record.
    const saved = loadHostRecord(hostStorage, room.id);
    assert.equal(saved.game.version, host.record.game.version);
    host.stop();
    await sleep(400);
    host = new HostRoom({ room, secret, identity: hostId, record: saved, storage: hostStorage });
    host.start();
    await until(() => host.isOnline(guestId.id), 'guest seen by reloaded host');
    console.log(`reloads recovered at move ${moves}`);
  }
}

await until(() => guest.snapshot().game?.phase === 'over', 'guest sees the end');
const final = host.record.game;
const gv = guest.snapshot().game;
assert.deepEqual(gv.result, final.result);
assert.deepEqual(gv.bank, final.bank);
for (let i = 0; i < final.players.length; i++) {
  assert.deepEqual(gv.players[i].cards, final.players[i].cards);
  assert.deepEqual(gv.players[i].tokens, final.players[i].tokens);
}
const winners = final.result.winners.map((w) => final.players[w].name).join(' & ');
const pts = final.result.ranking.map((r) => `${final.players[r.p].name} ${r.points}`).join(', ');
console.log(`game over after ${moves} moves: ${winners} wins (${pts}); tally ${JSON.stringify(host.record.tally)}`);
latencies.sort((a, b) => a - b);
console.log(`guest move round-trip: median ${latencies[latencies.length >> 1]} ms, p90 ${latencies[Math.floor(latencies.length * 0.9)]} ms, max ${latencies.at(-1)} ms over ${latencies.length} moves`);
assert.ok(CARDS.length === 90);

host.stop();
guest.stop();
await sleep(300);
console.log('LIVE TEST PASSED');
process.exit(0);
