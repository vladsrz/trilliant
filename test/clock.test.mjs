import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomFromSecret, newRoomSecret, createIdentity } from '../js/net/crypto.js';
import { HostRoom } from '../js/net/room.js';
import { testStorage, LOBBY_IDLE_MS, loadHostRecord, listTables, rememberTable } from '../js/net/identity.js';
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

test('hints are off by default and only the host changes them, in the lobby', async () => {
  const { host } = await table();
  assert.equal(host.lobbyPublic().hints, false);
  host.setHints('yes');
  assert.equal(host.hints, false, 'only true or false');
  host.setHints(true);
  assert.equal(host.lobbyPublic().hints, true);
  assert.ok(host.startGame().ok);
  host.setHints(false);
  assert.equal(host.hints, true, 'no changes mid-game');
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

test('reloading the host tab keeps the time left on the turn', async () => {
  const { host, me, other } = await table();
  host.start();
  assert.ok(host.startGame().ok);
  const g = host.record.game;
  g.turn = g.players.findIndex((p) => p.id === me.id);
  host.deadline = Date.now() + 40000;
  host.checkClock(); // the once-a-second save
  host.stop();

  const reopen = () => new HostRoom({
    room: host.room, secret: host.record.secret, identity: me, name: 'Ana',
    record: loadHostRecord(host.storage, host.room.id), storage: host.storage, relays: [],
  });
  const again = reopen();
  again.start();
  const left = again.deadline - Date.now();
  assert.ok(left > 38000 && left <= 40000, `host keeps what was left (${left} ms)`);

  // Almost out of time on the host's own turn: no top-up from a reload.
  again.deadline = Date.now() + 2000;
  again.checkClock();
  again.stop();
  const third = reopen();
  third.start();
  assert.ok(third.deadline - Date.now() <= 2000, 'no grace period for the host');

  // A guest whose turn it is gets time to reconnect.
  third.record.game.turn = third.record.game.players.findIndex((p) => p.id === other.id);
  third.deadline = Date.now() + 2000;
  third.checkClock();
  third.stop();
  const fourth = reopen();
  fourth.start();
  assert.ok(fourth.deadline - Date.now() > 29000, 'guest gets the grace period');
  fourth.stop();
});

test('a lobby expires after one hour without changes, even while its tab is open', async () => {
  const { host } = await table();
  host.start();
  rememberTable(host.storage, { roomId: host.room.id, role: 'host', title: 'Your game' });
  host.record.lastActivityAt = Date.now() - LOBBY_IDLE_MS - 1;
  host.tick();
  assert.equal(host.record.status, 'expired');
  assert.deepEqual(host.record.seats, []);
  assert.equal(loadHostRecord(host.storage, host.room.id).status, 'expired');
  assert.equal(listTables(host.storage).length, 0);
  assert.equal(host.startGame().ok, false);
  host.stop();
});

test('lobby changes reset the idle clock; heartbeats and active games do not expire', async () => {
  const { host } = await table();
  host.record.lastActivityAt = Date.now() - LOBBY_IDLE_MS + 1000;
  const before = host.record.lastActivityAt;
  host.tick();
  assert.equal(host.record.lastActivityAt, before);
  host.setTimer(60);
  assert.ok(host.record.lastActivityAt > before);
  assert.ok(host.startGame().ok);
  host.record.lastActivityAt = Date.now() - 2 * LOBBY_IDLE_MS;
  host.tick();
  assert.equal(host.record.status, 'playing');
  host.backToLobby();
  assert.ok(Date.now() - host.record.lastActivityAt < 1000);
  host.stop();
});
