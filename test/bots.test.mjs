import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomFromSecret, newRoomSecret, createIdentity } from '../js/net/crypto.js';
import { HostRoom } from '../js/net/room.js';
import { testStorage, loadHostRecord } from '../js/net/identity.js';
import { newGame, applyAction, viewFor, seededRandom, MAX_PLAYERS } from '../js/engine.js';
import { botAction, greedyAction } from '../js/bot.js';

// A host alone in the lobby; no relays, everything local.
async function lobby() {
  const secret = newRoomSecret();
  const room = await roomFromSecret(secret);
  const me = await createIdentity();
  const storage = testStorage();
  const host = new HostRoom({ room, secret, identity: me, name: 'Ana', storage, relays: [] });
  return { host, me, room, secret, storage };
}

// Let every bot whose turn it is move, without waiting out the thinking pause.
function runBots(host) {
  let now = Date.now();
  for (let i = 0; i < 40; i++) {
    const g = host.record.game;
    if (host.record.status !== 'playing' || !host.isBot(g.players[g.turn].id)) return;
    now += 5000;
    host.playBots(now);
  }
  assert.fail('bots never handed the turn back');
}

test('the host seats bots in the lobby, up to a full game, and can take them out again', async () => {
  const { host } = await lobby();
  assert.equal(host.startGame().ok, false, 'one player is not a game');
  for (let i = 1; i < MAX_PLAYERS; i++) assert.ok(host.addBot().ok);
  assert.equal(host.addBot().ok, false, 'no fifth seat');
  const seats = host.lobbyPublic().seats;
  assert.equal(seats.length, MAX_PLAYERS);
  assert.deepEqual(seats.map((s) => s.bot), [false, true, true, true]);
  assert.ok(seats.every((s) => s.online), 'bots are always there');
  assert.equal(new Set(seats.map((s) => s.name)).size, MAX_PLAYERS, 'each bot gets its own name');

  host.removeSeat(seats[3].id);
  assert.equal(host.record.seats.length, 3);
  assert.deepEqual(host.record.blocked, [], 'a removed bot is not a banned player');
  assert.ok(host.addBot().ok);

  assert.ok(host.startGame().ok);
  assert.equal(host.addBot().ok, false, 'not mid-game');
});

test('nobody can knock or move as a bot', async () => {
  const { host } = await lobby();
  host.addBot();
  const botId = host.record.seats[1].id;
  const stranger = await createIdentity();
  assert.equal(await host.client(botId, stranger.pub), null, 'a bot id is never the fingerprint of a key');
  assert.ok(host.startGame().ok);
  const before = host.record.game.version;
  await host.onAct({ f: botId, d: { box: 'x'.repeat(40) } });
  assert.equal(host.record.game.version, before);
});

test('a bot waits a beat, then plays its turn through the same checks as a player', async () => {
  const { host } = await lobby();
  host.addBot();
  assert.ok(host.startGame().ok);
  const g = () => host.record.game;
  const botSeat = g().players.findIndex((p) => host.isBot(p.id));
  if (g().turn !== botSeat) assert.ok((await host.act({ type: 'take', gems: ['white', 'blue', 'green'] })).ok);
  assert.equal(g().turn, botSeat);
  const version = g().version;
  const now = Date.now();
  host.playBots(now);
  host.playBots(now + 500);
  assert.equal(g().version, version, 'still thinking');
  host.playBots(now + 1000);
  assert.equal(g().version, version + 1, 'moved');
  assert.equal(g().log.at(-1).p, botSeat);
});

test('a bot whose move is refused gets its turn skipped instead of stalling the game', async () => {
  const { host } = await lobby();
  host.addBot();
  assert.ok(host.startGame().ok);
  const botSeat = host.record.game.players.findIndex((p) => host.isBot(p.id));
  if (host.record.game.turn !== botSeat) assert.ok((await host.act({ type: 'take', gems: ['white', 'blue', 'green'] })).ok);
  const real = host.process;
  host.process = () => ({ ok: false, error: 'nope' });
  runBots(host);
  host.process = real;
  assert.notEqual(host.record.game.turn, botSeat);
  assert.equal(host.record.game.log.at(-1).t, 'timeout');
});

test('one player and three bots play a whole game, and it survives a reload', async () => {
  const { host, me, room, secret, storage } = await lobby();
  for (let i = 0; i < 3; i++) host.addBot();
  assert.ok(host.startGame().ok);
  let room2 = host;
  for (let turns = 0; room2.record.status === 'playing'; turns++) {
    assert.ok(turns < 400, 'game should finish');
    runBots(room2);
    if (room2.record.status !== 'playing') break;
    const view = room2.snapshot().game;
    assert.equal(view.turn, view.you, 'bots handed the turn to the human');
    assert.ok((await room2.act(greedyAction(view, view.you))).ok);
    // Halfway through, the host closes the tab and comes back.
    if (turns === 12) room2 = new HostRoom({ room, secret, identity: me, name: 'Ana', record: loadHostRecord(storage, room.id), storage, relays: [] });
  }
  const r = room2.record;
  assert.equal(r.status, 'over');
  assert.equal(Object.values(r.tally).reduce((a, b) => a + b, 0), r.game.result.winners.length, 'wins are counted, bots included');
});

test('the bot only needs its own view, always moves legally, and beats the simple player', () => {
  const policies = [botAction, greedyAction];
  let wins = 0;
  const games = 120;
  for (let seed = 1; seed <= games; seed++) {
    const rand = seededRandom(seed * 104729);
    const n = 2 + (seed % 3);
    const seat = seed % n;
    let s = newGame(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rand, target: seed % 7 === 0 ? 24 : 15 });
    for (let steps = 0; s.phase !== 'over'; steps++) {
      assert.ok(steps < 3000, `seed ${seed}: game should finish`);
      const pi = s.turn;
      const view = viewFor(s, s.players[pi].id);
      const action = policies[pi === seat ? 0 : 1](view, pi, rand);
      const res = applyAction(s, s.players[pi].id, action);
      assert.ok(res.ok, `seed ${seed} step ${steps}: ${JSON.stringify(action)} -> ${res.error}`);
      s = res.state;
    }
    // Count a win as 1 against the fair share of 1/n, so 2-, 3- and 4-player games weigh the same.
    if (s.result.winners.includes(seat)) wins += n / 2;
  }
  console.log(`  bot vs simple player: ${(wins / games * 100).toFixed(0)} (50 = even)`);
  assert.ok(wins / games > 0.75, `bot should clearly beat the simple player, got ${wins}/${games}`);
});
