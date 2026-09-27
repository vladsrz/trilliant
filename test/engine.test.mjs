import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, NOBLES, COLORS, TOKEN_COLORS } from '../js/data.js';
import {
  newGame, applyAction, viewFor, seededRandom, pointsOf, tokenTotal, bonusesOf, MAX_TOKENS,
} from '../js/engine.js';
import { randomAction, greedyAction, legalActions } from '../js/bot.js';

const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const game = (n = 2, seed = 1) => newGame(seats(n), { rand: seededRandom(seed) });

function act(state, action, who = state.players[state.turn].id) {
  const res = applyAction(state, who, action);
  assert.ok(res.ok, `expected ok for ${JSON.stringify(action)}: ${res.error}`);
  return res.state;
}
function reject(state, action, pattern, who = state.players[state.turn].id) {
  const res = applyAction(state, who, action);
  assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(action)}`);
  if (pattern) assert.match(res.error, pattern);
}
// Force a known board/bank for targeted tests.
function withPlayer(state, pi, patch) {
  const s = structuredClone(state);
  Object.assign(s.players[pi], patch);
  return s;
}

test('card data matches the base game', () => {
  assert.equal(CARDS.length, 90);
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  for (const c of CARDS) byLevel[c.level]++;
  assert.deepEqual(byLevel, { 1: 40, 2: 30, 3: 20 });
  for (const color of COLORS) {
    const mine = CARDS.filter((c) => c.color === color);
    assert.deepEqual([1, 2, 3].map((l) => mine.filter((c) => c.level === l).length), [8, 6, 4]);
  }
  // Rulebook example: 3 blue + 3 black + 6 white buys a level-3 sapphire worth 4.
  assert.ok(CARDS.some((c) => c.level === 3 && c.color === 'blue' && c.points === 4
    && c.cost.white === 6 && c.cost.blue === 3 && c.cost.black === 3 && c.cost.green === 0 && c.cost.red === 0));
  assert.equal(NOBLES.length, 10);
  assert.ok(NOBLES.every((n) => Object.values(n.req).reduce((a, b) => a + b, 0) === (Object.values(n.req).includes(4) ? 8 : 9)));
});

test('setup scales with player count', () => {
  for (const [n, gems] of [[2, 4], [3, 5], [4, 7]]) {
    const s = game(n);
    assert.equal(s.nobles.length, n + 1);
    for (const c of COLORS) assert.equal(s.bank[c], gems);
    assert.equal(s.bank.gold, 5);
    for (const l of [1, 2, 3]) assert.equal(s.board[l].length, 4);
    assert.deepEqual([s.decks[1].length, s.decks[2].length, s.decks[3].length], [36, 26, 16]);
    assert.ok(s.start >= 0 && s.start < n && s.turn === s.start);
  }
  assert.throws(() => newGame(seats(1)));
  assert.throws(() => newGame(seats(5)));
});

test('taking gems follows the three-different / two-same rule', () => {
  let s = game();
  reject(s, { type: 'take', gems: ['white', 'blue'] }, /3 different/);
  reject(s, { type: 'take', gems: ['white', 'white', 'blue'] }, /different colours/);
  reject(s, { type: 'take', gems: ['gold'] }, /Gold/);
  reject(s, { type: 'take', gems: ['white', 'blue', 'green', 'red'] });
  reject(s, { type: 'take', gems: ['white', 'blue', 'green'] }, /turn/, s.players[(s.turn + 1) % 2].id);
  s = act(s, { type: 'take', gems: ['white', 'white'] });
  assert.equal(s.bank.white, 2);
  // Now white has 2 left: a pair of white is illegal for the next player.
  reject(s, { type: 'take', gems: ['white', 'white'] }, /at least 4/);
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  assert.equal(s.bank.white, 1);
});

test('fewer than three is allowed only when fewer colours remain', () => {
  let s = game();
  s.bank = { white: 0, blue: 0, green: 0, red: 2, black: 1, gold: 5 };
  reject(s, { type: 'take', gems: ['red'] }, /2 different/);
  s = act(s, { type: 'take', gems: ['red', 'black'] });
  assert.equal(s.bank.black, 0);
  s = act(s, { type: 'take', gems: ['red'] });
  assert.equal(s.bank.red, 0);
});

test('ending a turn above 10 gems forces a return', () => {
  let s = game();
  const pi = s.turn;
  s = withPlayer(s, pi, { tokens: { white: 2, blue: 2, green: 2, red: 2, black: 1, gold: 0 } });
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  assert.equal(s.phase, 'discard');
  assert.equal(s.pending.count, 2);
  assert.equal(s.turn, pi);
  reject(s, { type: 'take', gems: ['red', 'black', 'white'] }, /Return gems/);
  reject(s, { type: 'discard', gems: { white: 1 } }, /exactly 2/);
  reject(s, { type: 'discard', gems: { gold: 2 } }, /only have 0/);
  s = act(s, { type: 'discard', gems: { white: 1, red: 1 } });
  assert.equal(tokenTotal(s.players[pi].tokens), 10);
  assert.notEqual(s.turn, pi);
});

test('reserving refills the slot, pays gold, caps at three, and hides blind draws', () => {
  let s = game();
  const pi = s.turn;
  const other = (pi + 1) % 2;
  const card = s.board[2][1];
  const nextTop = s.decks[2].at(-1);
  s = act(s, { type: 'reserve', card });
  assert.equal(s.board[2][1], nextTop);
  assert.equal(s.players[pi].tokens.gold, 1);
  assert.equal(s.bank.gold, 4);
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  const blindTop = s.decks[3].at(-1);
  s = act(s, { type: 'reserve', level: 3 });
  const mine = viewFor(s, s.players[pi].id);
  const theirs = viewFor(s, s.players[other].id);
  assert.equal(mine.players[pi].reserved[1].id, blindTop);
  assert.equal(theirs.players[pi].reserved[1].id, null);
  assert.equal(theirs.players[pi].reserved[1].level, 3);
  assert.equal(theirs.players[pi].reserved[0].id, card, 'face-up reserves stay public');
  assert.equal(theirs.log.at(-1).card, null, 'log hides the blind card from others');
  assert.equal(mine.log.at(-1).card, blindTop);
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  s = act(s, { type: 'reserve', level: 1 });
  s = act(s, { type: 'take', gems: ['red', 'blue', 'green'] });
  reject(s, { type: 'reserve', level: 1 }, /already hold 3/);
});

test('reserving with no gold left still works', () => {
  let s = game();
  s.bank.gold = 0;
  const pi = s.turn;
  s = act(s, { type: 'reserve', level: 1 });
  assert.equal(s.players[pi].tokens.gold, 0);
  assert.equal(s.players[pi].reserved.length, 1);
});

test('buying uses bonuses first, then gems, then gold', () => {
  let s = game();
  const pi = s.turn;
  // Put a known card on the board: level-3 sapphire 4 pts (6 white, 3 blue, 3 black).
  const target = CARDS.find((c) => c.level === 3 && c.color === 'blue' && c.points === 4 && c.cost.white === 6).id;
  s.board[3][0] = target;
  s.decks[3] = s.decks[3].filter((id) => id !== target);
  const whiteCards = CARDS.filter((c) => c.color === 'white' && c.level === 1).slice(0, 4).map((c) => c.id);
  s = withPlayer(s, pi, { cards: whiteCards, tokens: { white: 1, blue: 3, green: 0, red: 0, black: 2, gold: 2 } });
  reject(s, { type: 'buy', card: target, pay: { white: 1, blue: 3, black: 2, gold: 0 } }, /does not add up/);
  const before = structuredClone(s.bank);
  s = act(s, { type: 'buy', card: target });
  const p = s.players[pi];
  assert.ok(p.cards.includes(target));
  // Needed 2 white (6-4), 3 blue, 3 black. Paid 1 white + 1 gold, 3 blue, 2 black + 1 gold.
  assert.deepEqual(p.tokens, { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });
  assert.equal(s.bank.gold, before.gold + 2);
  assert.equal(pointsOf(p), 4 + whiteCards.reduce((a, id) => a + CARDS[id].points, 0));
});

test('custom payment can spend gold instead of a coloured gem', () => {
  let s = game();
  const pi = s.turn;
  const card = s.board[1][0];
  const cost = CARDS[card].cost;
  const tokens = { ...cost, gold: 1 };
  s = withPlayer(s, pi, { tokens });
  const firstColor = COLORS.find((c) => cost[c] > 0);
  const pay = { ...cost, gold: 1 };
  pay[firstColor] -= 1;
  s = act(s, { type: 'buy', card, pay });
  assert.equal(s.players[pi].tokens[firstColor], 1);
  assert.equal(s.players[pi].tokens.gold, 0);
});

test('cannot buy what you cannot afford, or a card that is not there', () => {
  const s = game();
  const card = s.board[3][0];
  reject(s, { type: 'buy', card }, /afford/);
  reject(s, { type: 'buy', card: s.decks[1][0] }, /not available/);
  reject(s, { type: 'buy', card: 999 }, /not available/);
  reject(s, { type: 'buy', card: '3' }, /not available/);
});

test('one qualifying noble visits automatically; several means a choice', () => {
  let s = game(2, 7);
  const pi = s.turn;
  s.nobles = [0, 5, 6]; // W4U4, W3U3G3, U3G3R3
  const pick = (color, n) => CARDS.filter((c) => c.color === color && c.level === 1).slice(0, n).map((c) => c.id);
  // Owns 3W 3U 3G -> qualifies for noble 5 only. Buying a blue card keeps it at one noble.
  s = withPlayer(s, pi, { cards: [...pick('white', 3), ...pick('blue', 2), ...pick('green', 3)] });
  const blue = CARDS.find((c) => c.color === 'blue' && c.level === 1 && !s.players[pi].cards.includes(c.id)
    && Object.values(c.cost).reduce((a, b) => a + b, 0) === 3);
  s.board[1][0] = blue.id;
  s = withPlayer(s, pi, { tokens: { ...blue.cost, gold: 0 } });
  s = act(s, { type: 'buy', card: blue.id });
  assert.deepEqual(s.players[pi].nobles, [5]);
  assert.equal(s.phase, 'play');

  // Fresh setup where two nobles qualify at once.
  s = game(2, 8);
  const qi = s.turn;
  s.nobles = [5, 6, 0]; // W3U3G3 and U3G3R3 both satisfied by 3W 3U 3G 3R
  s = withPlayer(s, qi, { cards: [...pick('white', 3), ...pick('blue', 3), ...pick('green', 3), ...pick('red', 2)] });
  const red = CARDS.find((c) => c.color === 'red' && c.level === 1 && !s.players[qi].cards.includes(c.id));
  s.board[1][1] = red.id;
  s = withPlayer(s, qi, { tokens: { ...red.cost, gold: 0 } });
  s = act(s, { type: 'buy', card: red.id });
  assert.equal(s.phase, 'noble');
  assert.deepEqual(s.pending.options.sort(), [5, 6]);
  reject(s, { type: 'noble', noble: 0 }, /not visiting/);
  s = act(s, { type: 'noble', noble: 6 });
  assert.deepEqual(s.players[qi].nobles, [6]);
  assert.ok(s.nobles.includes(5));
  assert.notEqual(s.turn, qi);
});

test('reaching 15 finishes the round, and ties go to fewer cards', () => {
  let s = game();
  const first = s.start;
  const second = (first + 1) % 2;
  const threes = CARDS.filter((c) => c.points === 5).map((c) => c.id);
  s = withPlayer(s, first, { cards: threes.slice(0, 3) }); // 15 points, 3 cards
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  assert.equal(s.finalRound, true);
  assert.equal(s.phase, 'play', 'second player still gets a turn');
  s = withPlayer(s, second, { cards: [...CARDS.filter((c) => c.points === 3 && c.level === 2).slice(0, 5).map((c) => c.id)] }); // 15 pts, 5 cards
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.result.winners, [first]);
  reject(s, { type: 'take', gems: ['white', 'blue', 'green'] }, /over/);
});

test('when the last seat reaches 15 the game ends immediately', () => {
  let s = game();
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  const last = s.turn;
  s = withPlayer(s, last, { cards: CARDS.filter((c) => c.points === 5).slice(0, 3).map((c) => c.id) });
  s = act(s, { type: 'take', gems: ['white', 'blue', 'green'] });
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.result.winners, [last]);
});

test('pass is only allowed with no other move', () => {
  const s = game();
  reject(s, { type: 'pass' }, /still have a move/);
});

test('rejects junk input without throwing', () => {
  const s = game();
  const who = s.players[s.turn].id;
  for (const junk of [null, 5, 'take', {}, { type: 'hack' }, { type: 'take' }, { type: 'take', gems: 'white' },
    { type: 'reserve' }, { type: 'reserve', level: 4 }, { type: 'reserve', card: -1 },
    { type: 'buy', card: null }, { type: 'discard', gems: { white: 1 } }, { type: 'noble', noble: 1 },
    { type: 'buy', card: s.board[1][0], pay: 'all' }, { type: 'take', gems: ['__proto__', 'constructor', 'white'] }]) {
    const res = applyAction(s, who, junk);
    assert.equal(res.ok, false, JSON.stringify(junk));
  }
  assert.equal(applyAction(s, 'stranger', { type: 'pass' }).ok, false);
});

// ---------- whole-game simulation ----------

function checkInvariants(s, n) {
  const gems = { 2: 4, 3: 5, 4: 7 }[n];
  for (const c of TOKEN_COLORS) {
    const total = s.bank[c] + s.players.reduce((a, p) => a + p.tokens[c], 0);
    assert.equal(total, c === 'gold' ? 5 : gems, `token conservation for ${c}`);
    assert.ok(s.bank[c] >= 0);
    for (const p of s.players) assert.ok(p.tokens[c] >= 0);
  }
  const seen = [
    ...s.decks[1], ...s.decks[2], ...s.decks[3],
    ...[1, 2, 3].flatMap((l) => s.board[l]).filter((x) => x !== null),
    ...s.players.flatMap((p) => [...p.cards, ...p.reserved.map((r) => r.id)]),
  ];
  assert.equal(seen.length, 90, 'card conservation');
  assert.equal(new Set(seen).size, 90, 'no duplicated cards');
  const nobleIds = [...s.nobles, ...s.players.flatMap((p) => p.nobles)];
  assert.equal(nobleIds.length, n + 1);
  assert.equal(new Set(nobleIds).size, n + 1);
  for (const p of s.players) assert.ok(p.reserved.length <= 3);
  if (s.phase === 'play') for (const p of s.players) assert.ok(tokenTotal(p.tokens) <= MAX_TOKENS, 'gem cap at turn start');
  for (const p of s.players) {
    const b = bonusesOf(p);
    for (const id of p.nobles) for (const c of COLORS) assert.ok(b[c] >= NOBLES[id].req[c], 'noble earned');
  }
}

function checkViewSecrecy(s) {
  for (const viewer of s.players) {
    const v = viewFor(s, viewer.id);
    assert.equal(v.decks, undefined);
    assert.equal(v.seed, undefined);
    v.players.forEach((p, i) => {
      s.players[i].reserved.forEach((r, k) => {
        const shown = p.reserved[k].id;
        if (r.blind && s.players[i].id !== viewer.id) assert.equal(shown, null);
        else assert.equal(shown, r.id);
      });
    });
  }
}

test('thousands of random games keep every invariant', () => {
  let games = 0;
  let turnsTotal = 0;
  const endings = { play: 0, over: 0 };
  for (let seed = 1; seed <= 1500; seed++) {
    const n = 2 + (seed % 3);
    const rand = seededRandom(seed * 7919);
    let s = newGame(seats(n), { rand });
    let steps = 0;
    const policy = seed % 2 ? greedyAction : randomAction;
    while (s.phase !== 'over' && steps < 3000) {
      const pi = s.turn;
      const action = policy(s, pi, rand);
      const res = applyAction(s, s.players[pi].id, action);
      assert.ok(res.ok, `seed ${seed} step ${steps}: ${JSON.stringify(action)} -> ${res.error}`);
      s = res.state;
      checkInvariants(s, n);
      if (steps % 7 === 0) checkViewSecrecy(s);
      steps++;
    }
    endings[s.phase]++;
    turnsTotal += steps;
    games++;
    if (s.phase === 'over') {
      const r = s.result;
      const pts = s.players.map(pointsOf);
      const best = Math.max(...pts);
      for (const w of r.winners) assert.equal(pts[w], best);
    }
  }
  assert.equal(endings.play, 0, 'every game finished');
  console.log(`  ${games} games, avg ${(turnsTotal / games).toFixed(1)} actions`);
});

test('legal move generator agrees with the engine', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const rand = seededRandom(seed);
    let s = newGame(seats(2), { rand });
    for (let i = 0; i < 60 && s.phase !== 'over'; i++) {
      const pi = s.turn;
      for (const a of legalActions(s, pi, rand)) {
        const res = applyAction(s, s.players[pi].id, a);
        assert.ok(res.ok, `${JSON.stringify(a)} -> ${res.error}`);
      }
      s = applyAction(s, s.players[pi].id, greedyAction(s, pi, rand)).state;
    }
  }
});
