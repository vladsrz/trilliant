import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomFromSecret, newRoomSecret, createIdentity } from '../js/net/crypto.js';
import { HostRoom } from '../js/net/room.js';
import { testStorage } from '../js/net/identity.js';
import { tokenTotal } from '../js/engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A host with a second seat filled in directly; no relays, everything local.
async function table() {
  const secret = newRoomSecret();
  const room = await roomFromSecret(secret);
  const me = await createIdentity();
  const other = await createIdentity();
  const host = new HostRoom({ room, secret, identity: me, name: 'Ana', storage: testStorage(), relays: [] });
  host.record.seats.push({ id: other.id, name: 'Ben', pub: other.pub });
  return { host, me, other };
}

test('the clock defaults to Slow (3 min) and only takes the offered presets, in the lobby', async () => {
  const { host } = await table();
  assert.equal(host.turnSeconds, 180);
  host.setTimer(55);
  assert.equal(host.turnSeconds, 180, 'not an offered preset');
  host.setTimer(60);
  assert.equal(host.turnSeconds, 60);
  assert.equal(host.lobbyPublic().turnSeconds, 60, 'guests see the setting');
  assert.ok(host.startGame().ok);
  host.setTimer(120);
  assert.equal(host.turnSeconds, 60, 'no changes mid-game');
  const info = host.timerInfo();
  assert.equal(info.seconds, 60);
  assert.ok(info.remainingMs > 58000 && info.remainingMs <= 60000);
  host.stop();
});

test('a saved lobby with an unknown timer value falls back to Slow', async () => {
  const { host } = await table();
  host.record.settings.turnSeconds = 175;
  assert.equal(host.turnSeconds, 180);
});

test('points to win: default 15, any whole number up to 30, lobby only', async () => {
  const { host } = await table();
  assert.equal(host.target, 15);
  for (const bad of [14, 31, 22.5]) host.setTarget(bad);
  assert.equal(host.target, 15);
  host.setTarget(24);
  assert.equal(host.lobbyPublic().target, 24);
  assert.ok(host.startGame().ok);
  assert.equal(host.record.game.target, 24);
  host.setTarget(30);
  assert.equal(host.target, 24, 'no changes mid-game');
});

test('when time runs out the host skips the turn and starts a fresh clock', async () => {
  const { host } = await table();
  host.start();
  assert.ok(host.startGame().ok);
  const g0 = host.record.game;
  const rev0 = host.record.rev;
  host.deadline = Date.now() + 200;
  await sleep(2300);
  const g = host.record.game;
  assert.equal(g.turn, (g0.turn + 1) % 2, 'turn passed on');
  assert.equal(g.log.at(-1).t, 'timeout');
  assert.ok(host.record.rev > rev0, 'players get synced');
  assert.ok(host.deadline - Date.now() > 170000, 'next player gets a full clock');
  host.stop();
});

test('a player who has to put gems back gets at least 30 more seconds', async () => {
  const { host, me } = await table();
  assert.ok(host.startGame().ok);
  const g = host.record.game;
  // Make it the host's turn with 9 gems, then take 3 so a put-back is due.
  g.turn = g.players.findIndex((p) => p.id === me.id);
  g.players[g.turn].tokens = { white: 2, blue: 2, green: 2, red: 2, black: 1, gold: 0 };
  host.deadline = Date.now() + 1000;
  const res = await host.act({ type: 'take', gems: ['white', 'blue', 'green'] });
  assert.ok(res.ok, res.error);
  assert.equal(host.record.game.phase, 'discard');
  assert.ok(host.deadline - Date.now() > 29000, 'grace period applied');
  host.deadline = Date.now() - 1;
  host.checkClock();
  const after = host.record.game;
  assert.equal(tokenTotal(after.players[g.turn].tokens), 10, 'extra gems went back automatically');
  assert.notEqual(after.turn, g.turn);
  host.stop();
});

test('timer off means no clock and no timeouts', async () => {
  const { host } = await table();
  host.setTimer(0);
  host.start();
  assert.ok(host.startGame().ok);
  assert.equal(host.deadline, null);
  assert.equal(host.timerInfo(), null);
  const turn = host.record.game.turn;
  await sleep(1300);
  assert.equal(host.record.game.turn, turn);
  host.stop();
});

test('a reopened game restarts the clock instead of skipping someone at once', async () => {
  const { host } = await table();
  assert.ok(host.startGame().ok);
  host.deadline = Date.now() - 60000; // as if the tab had been closed for a while
  host.start();
  assert.ok(host.deadline - Date.now() > 170000);
  host.stop();
});
