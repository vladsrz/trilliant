// Live: host + (N-1) guests over the real relays, bots play a full game.
// Usage: node test/net.multi.live.mjs 3
import assert from 'node:assert/strict';
import { roomFromSecret, newRoomSecret, createIdentity } from '../js/net/crypto.js';
import { HostRoom, GuestRoom } from '../js/net/room.js';
import { testStorage } from '../js/net/identity.js';
import { greedyAction } from '../js/bot.js';

const N = Number(process.argv[2] || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (check()) return Date.now() - t0; await sleep(50); }
  throw new Error(`timed out: ${label}`);
}
const secret = newRoomSecret();
const room = await roomFromSecret(secret);
const hostId = await createIdentity();
const host = new HostRoom({ room, secret, identity: hostId, name: 'P0', storage: testStorage() });
host.start();
const guests = [];
for (let i = 1; i < N; i++) {
  const g = new GuestRoom({ room, hostId: hostId.id, identity: await createIdentity(), name: `P${i}` });
  g.start();
  guests.push(g);
}
const t = await until(() => host.record.seats.length === N && guests.every((g) => g.snapshot().seated), 'all seated');
console.log(`${N} players seated in ${t} ms`);
assert.ok(host.startGame().ok);
await until(() => guests.every((g) => g.snapshot().game), 'all got the game');
const g0 = host.record.game;
const gems = { 2: 4, 3: 5, 4: 7 }[N];
assert.equal(g0.bank.white, gems, 'gem count for player count');
assert.equal(g0.nobles.length, N + 1, 'nobles = players + 1');
let moves = 0;
while (host.record.status === 'playing') {
  const s = host.record.game;
  const pid = s.players[s.turn].id;
  if (pid === hostId.id) {
    assert.ok((await host.act(greedyAction(s, s.turn))).ok);
  } else {
    const g = guests.find((x) => x.identity.id === pid);
    await until(() => g.snapshot().game?.version === host.record.game.version, 'guest caught up');
    const v = g.snapshot().game;
    const r = await g.act(greedyAction(v, v.turn));
    assert.ok(r.ok, r.error);
  }
  moves++;
}
await until(() => guests.every((g) => g.snapshot().game?.phase === 'over'), 'all see the end');
for (const g of guests) assert.deepEqual(g.snapshot().game.result, host.record.game.result);
const fin = host.record.game;
console.log(`${N}p game over after ${moves} moves: ` + fin.result.ranking.map((r) => `${fin.players[r.p].name} ${r.points}`).join(', '));
host.stop(); guests.forEach((g) => g.stop());
await sleep(300);
console.log(`MULTI ${N}P PASSED`);
process.exit(0);
