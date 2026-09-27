// Rules engine. Pure functions over plain JSON state, so the host's browser can
// run it, persist it, and hand each player a filtered view. Nothing in here
// touches the DOM or the network.

import { CARDS, NOBLES, COLORS, GOLD, TOKEN_COLORS } from './data.js';

export const WIN_POINTS = 15;
// Points needed to trigger the last round: anything from the standard 15 up to 30.
export const MIN_TARGET = 15;
export const MAX_TARGET = 30;
export const isValidTarget = (n) => Number.isInteger(n) && n >= MIN_TARGET && n <= MAX_TARGET;
export const MAX_TOKENS = 10;
export const MAX_RESERVED = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
const GEMS_PER_COLOR = { 2: 4, 3: 5, 4: 7 };
const GOLD_TOKENS = 5;
const LEVELS = [1, 2, 3];
const LOG_KEEP = 400;

export const COLOR_NAMES = {
  white: 'diamond', blue: 'sapphire', green: 'emerald', red: 'ruby', black: 'onyx', gold: 'gold',
};

// ---------- randomness ----------

// Deck order is the one secret worth protecting, so shuffles use the platform
// CSPRNG. A seeded generator is only for tests (a 32-bit seed could be brute
// forced from the visible board).
export function secureRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------- small helpers (work on full state and on views) ----------

export const emptyTokens = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });

export function bonusesOf(player) {
  const b = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const id of player.cards) b[CARDS[id].color] += 1;
  return b;
}

export function pointsOf(player) {
  let pts = 0;
  for (const id of player.cards) pts += CARDS[id].points;
  for (const id of player.nobles) pts += NOBLES[id].points;
  return pts;
}

export function tokenTotal(tokens) {
  let n = 0;
  for (const c of TOKEN_COLORS) n += tokens[c] || 0;
  return n;
}

// What a player still owes per colour after card bonuses.
export function netCost(player, card) {
  const b = bonusesOf(player);
  const need = {};
  for (const c of COLORS) need[c] = Math.max(0, card.cost[c] - b[c]);
  return need;
}

// Default payment: coloured gems first, gold covers the gap. Returns the
// payment (including gold) or null when the card is out of reach.
export function autoPayment(player, card) {
  const need = netCost(player, card);
  const pay = emptyTokens();
  let short = 0;
  for (const c of COLORS) {
    pay[c] = Math.min(need[c], player.tokens[c]);
    short += need[c] - pay[c];
  }
  if (short > player.tokens.gold) return null;
  pay.gold = short;
  return pay;
}

function isValidPayment(player, card, pay) {
  const need = netCost(player, card);
  let short = 0;
  for (const c of COLORS) {
    const p = pay[c];
    if (!Number.isInteger(p) || p < 0 || p > need[c] || p > player.tokens[c]) return false;
    short += need[c] - p;
  }
  return Number.isInteger(pay.gold) && pay.gold === short && pay.gold <= player.tokens.gold;
}

export function nobleFits(noble, bonuses) {
  return COLORS.every((c) => bonuses[c] >= noble.req[c]);
}

// Colours a player may take right now: which are in stock and which can be
// taken as a pair. Mirrors the validation in `take`.
export function takeRules(bank) {
  const available = COLORS.filter((c) => bank[c] > 0);
  const pairable = COLORS.filter((c) => bank[c] >= 4);
  return { available, pairable, distinctNeeded: Math.min(3, available.length) };
}

export function deckCounts(state) {
  return { 1: state.decks[1].length, 2: state.decks[2].length, 3: state.decks[3].length };
}

// ---------- setup ----------

export function newGame(seats, { rand = secureRandom, target = WIN_POINTS } = {}) {
  if (!isValidTarget(target)) throw new Error(`Target must be a whole number from ${MIN_TARGET} to ${MAX_TARGET}`);
  const n = seats.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error(`Needs ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
  const decks = { 1: [], 2: [], 3: [] };
  for (const card of CARDS) decks[card.level].push(card.id);
  const board = {};
  for (const l of LEVELS) {
    shuffle(decks[l], rand);
    board[l] = [decks[l].pop(), decks[l].pop(), decks[l].pop(), decks[l].pop()];
  }
  const nobles = shuffle(NOBLES.map((x) => x.id), rand).slice(0, n + 1);
  const gems = GEMS_PER_COLOR[n];
  const bank = { white: gems, blue: gems, green: gems, red: gems, black: gems, gold: GOLD_TOKENS };
  const start = Math.floor(rand() * n);
  return {
    v: 1,
    version: 0,
    players: seats.map((s) => ({
      id: s.id, name: s.name, tokens: emptyTokens(), cards: [], reserved: [], nobles: [],
    })),
    bank,
    decks,
    board,
    nobles,
    start,
    turn: start,
    target,
    round: 1,
    phase: 'play', // play | discard | noble | over
    pending: null,
    finalRound: false,
    passStreak: 0,
    log: [{ t: 'start', p: start }],
    result: null,
  };
}

// ---------- actions ----------

class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

const isLevel = (x) => x === 1 || x === 2 || x === 3;
const isCardId = (x) => Number.isInteger(x) && x >= 0 && x < CARDS.length;

// Apply one action for one player. Never mutates `state`.
// Returns { ok: true, state } or { ok: false, error } with a sentence a player can act on.
export function applyAction(state, playerId, action) {
  try {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') fail('Unknown move.');
    if (state.phase === 'over') fail('The game is over.');
    const pi = state.players.findIndex((p) => p.id === playerId);
    if (pi < 0) fail('You are not seated in this game.');
    if (pi !== state.turn) fail(`It's ${state.players[state.turn].name}'s turn.`);
    const s = structuredClone(state);
    const expected = s.phase === 'discard' ? ['discard'] : s.phase === 'noble' ? ['noble'] : ['take', 'reserve', 'buy', 'pass'];
    if (!expected.includes(action.type)) {
      fail(s.phase === 'discard' ? 'Return gems down to 10 first.' : s.phase === 'noble' ? 'Choose which noble visits you first.' : 'Unknown move.');
    }
    switch (action.type) {
      case 'take': take(s, pi, action.gems); break;
      case 'reserve': reserve(s, pi, action); break;
      case 'buy': buy(s, pi, action); break;
      case 'pass': pass(s, pi); break;
      case 'discard': discard(s, pi, action.gems); break;
      case 'noble': chooseNoble(s, pi, action.noble); break;
    }
    s.version += 1;
    if (s.log.length > LOG_KEEP) s.log.splice(0, s.log.length - LOG_KEEP);
    return { ok: true, state: s };
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.message };
    throw err;
  }
}

function take(s, pi, gems) {
  if (!Array.isArray(gems) || gems.length < 1 || gems.length > 3) fail('Pick up to 3 gems.');
  if (!gems.every((c) => COLORS.includes(c))) fail('Gold only comes from reserving a card.');
  const counts = {};
  for (const c of gems) counts[c] = (counts[c] || 0) + 1;
  const colors = Object.keys(counts);
  const { distinctNeeded } = takeRules(s.bank);

  if (gems.length === 2 && colors.length === 1) {
    const c = colors[0];
    if (s.bank[c] < 4) fail(`Taking two ${COLOR_NAMES[c]}s needs at least 4 in the bank.`);
  } else {
    if (colors.length !== gems.length) fail('Take different colors, or two of the same color.');
    for (const c of colors) if (s.bank[c] < 1) fail(`No ${COLOR_NAMES[c]}s left.`);
    if (gems.length < distinctNeeded) fail(`Take ${distinctNeeded} different colors.`);
  }

  const p = s.players[pi];
  for (const c of gems) { s.bank[c] -= 1; p.tokens[c] += 1; }
  s.log.push({ t: 'take', p: pi, gems: counts });
  s.passStreak = 0;
  afterMainAction(s, pi);
}

function reserve(s, pi, action) {
  const p = s.players[pi];
  if (p.reserved.length >= MAX_RESERVED) fail(`You already hold ${MAX_RESERVED} reserved cards.`);
  let entry;
  if (action.card !== undefined) {
    if (!isCardId(action.card)) fail('That card is not on the table.');
    const spot = findOnBoard(s, action.card);
    if (!spot) fail('That card is not on the table.');
    s.board[spot.level][spot.slot] = s.decks[spot.level].pop() ?? null;
    p.reserved.push({ id: action.card, blind: false });
    entry = { t: 'reserve', p: pi, card: action.card, level: spot.level, slot: spot.slot, blind: false };
  } else if (isLevel(action.level)) {
    if (!s.decks[action.level].length) fail('That deck is empty.');
    const id = s.decks[action.level].pop();
    p.reserved.push({ id, blind: true });
    entry = { t: 'reserve', p: pi, card: id, level: action.level, blind: true };
  } else {
    fail('Choose a card or a deck to reserve.');
  }
  entry.gold = s.bank.gold > 0;
  if (entry.gold) { s.bank.gold -= 1; p.tokens.gold += 1; }
  s.log.push(entry);
  s.passStreak = 0;
  afterMainAction(s, pi);
}

function buy(s, pi, action) {
  const p = s.players[pi];
  if (!isCardId(action.card)) fail('That card is not available.');
  const card = CARDS[action.card];
  const spot = findOnBoard(s, action.card);
  const rIndex = p.reserved.findIndex((r) => r.id === action.card);
  if (!spot && rIndex < 0) fail('That card is not available to you.');

  let pay;
  if (action.pay !== undefined) {
    if (!action.pay || typeof action.pay !== 'object') fail('That payment does not add up.');
    const candidate = emptyTokens();
    for (const c of TOKEN_COLORS) candidate[c] = action.pay[c] ?? 0;
    if (!isValidPayment(p, card, candidate)) fail('That payment does not add up.');
    pay = candidate;
  } else {
    pay = autoPayment(p, card);
    if (!pay) fail("You can't afford that card yet.");
  }

  for (const c of TOKEN_COLORS) { p.tokens[c] -= pay[c]; s.bank[c] += pay[c]; }
  p.cards.push(card.id);
  const entry = { t: 'buy', p: pi, card: card.id, pay, level: card.level };
  if (spot) {
    s.board[spot.level][spot.slot] = s.decks[spot.level].pop() ?? null;
    entry.slot = spot.slot;
  } else {
    p.reserved.splice(rIndex, 1);
    entry.fromReserve = true;
  }
  s.log.push(entry);
  s.passStreak = 0;
  afterMainAction(s, pi);
}

function pass(s, pi) {
  if (hasMainAction(s, pi)) fail('You still have a move available.');
  s.log.push({ t: 'pass', p: pi });
  s.passStreak += 1;
  afterMainAction(s, pi);
}

function discard(s, pi, gems) {
  const p = s.players[pi];
  if (!gems || typeof gems !== 'object' || Array.isArray(gems)) fail('Choose gems to return.');
  let total = 0;
  const back = emptyTokens();
  for (const [c, n] of Object.entries(gems)) {
    if (!TOKEN_COLORS.includes(c) || !Number.isInteger(n) || n < 0) fail('Choose gems to return.');
    if (n > p.tokens[c]) fail(`You only have ${p.tokens[c]} ${COLOR_NAMES[c]}.`);
    back[c] = n;
    total += n;
  }
  if (total !== s.pending.count) fail(`Return exactly ${s.pending.count}.`);
  for (const c of TOKEN_COLORS) { p.tokens[c] -= back[c]; s.bank[c] += back[c]; }
  s.log.push({ t: 'discard', p: pi, gems: back });
  s.phase = 'play';
  s.pending = null;
  checkNobles(s, pi);
}

function chooseNoble(s, pi, noble) {
  if (!s.pending.options.includes(noble)) fail('That noble is not visiting you.');
  awardNoble(s, pi, noble);
  endTurn(s);
}

// ---------- running out of time ----------

// The host plays this for the current player when their turn clock hits zero.
// The turn is skipped; a half-finished turn is finished for them (extra gems
// put back, the first eligible noble chosen). Timeouts don't count as passes,
// so two idle players can't end the game by accident.
export function applyTimeout(state) {
  if (state.phase === 'over') return { ok: false, error: 'The game is over.' };
  const s = structuredClone(state);
  const pi = s.turn;
  const p = s.players[pi];
  const entry = { t: 'timeout', p: pi };
  if (s.phase === 'discard') {
    const back = autoDiscard(p.tokens, s.pending.count);
    for (const c of TOKEN_COLORS) { p.tokens[c] -= back[c]; s.bank[c] += back[c]; }
    entry.gems = back;
    s.log.push(entry);
    const b = bonusesOf(p);
    const eligible = s.nobles.filter((id) => nobleFits(NOBLES[id], b));
    if (eligible.length) awardNoble(s, pi, eligible[0]);
  } else if (s.phase === 'noble') {
    s.log.push(entry);
    awardNoble(s, pi, s.pending.options[0]);
  } else {
    s.log.push(entry);
  }
  endTurn(s);
  s.version += 1;
  if (s.log.length > LOG_KEEP) s.log.splice(0, s.log.length - LOG_KEEP);
  return { ok: true, state: s };
}

// Put back from whichever colour the player holds most of; gold goes last.
function autoDiscard(tokens, count) {
  const left = { ...tokens };
  const back = emptyTokens();
  for (let i = 0; i < count; i++) {
    let pick = null;
    for (const c of COLORS) if (left[c] > 0 && (!pick || left[c] > left[pick])) pick = c;
    if (!pick) pick = GOLD;
    left[pick] -= 1;
    back[pick] += 1;
  }
  return back;
}

// ---------- turn flow ----------

function afterMainAction(s, pi) {
  const extra = tokenTotal(s.players[pi].tokens) - MAX_TOKENS;
  if (extra > 0) {
    s.phase = 'discard';
    s.pending = { type: 'discard', count: extra };
    return;
  }
  checkNobles(s, pi);
}

function checkNobles(s, pi) {
  const b = bonusesOf(s.players[pi]);
  const eligible = s.nobles.filter((id) => nobleFits(NOBLES[id], b));
  if (eligible.length > 1) {
    s.phase = 'noble';
    s.pending = { type: 'noble', options: eligible };
    return;
  }
  if (eligible.length === 1) awardNoble(s, pi, eligible[0]);
  endTurn(s);
}

function awardNoble(s, pi, id) {
  s.nobles = s.nobles.filter((n) => n !== id);
  s.players[pi].nobles.push(id);
  s.log.push({ t: 'noble', p: pi, noble: id });
}

function endTurn(s) {
  const n = s.players.length;
  const pi = s.turn;
  s.phase = 'play';
  s.pending = null;
  if (!s.finalRound && pointsOf(s.players[pi]) >= (s.target || WIN_POINTS)) {
    s.finalRound = true;
    s.log.push({ t: 'final', p: pi });
  }
  const next = (pi + 1) % n;
  const roundDone = next === s.start;
  if ((s.finalRound && roundDone) || s.passStreak >= n) {
    finish(s);
    return;
  }
  if (roundDone) s.round += 1;
  s.turn = next;
}

function finish(s) {
  const ranking = s.players
    .map((p, i) => ({ p: i, points: pointsOf(p), cards: p.cards.length }))
    .sort((a, b) => b.points - a.points || a.cards - b.cards);
  const top = ranking[0];
  s.phase = 'over';
  s.result = {
    ranking,
    winners: ranking.filter((r) => r.points === top.points && r.cards === top.cards).map((r) => r.p),
  };
  s.log.push({ t: 'end', winners: s.result.winners });
}

function findOnBoard(s, id) {
  for (const level of LEVELS) {
    const slot = s.board[level].indexOf(id);
    if (slot >= 0) return { level, slot };
  }
  return null;
}

export function hasMainAction(s, pi) {
  const p = s.players[pi];
  if (COLORS.some((c) => s.bank[c] > 0)) return true;
  const boardCards = LEVELS.flatMap((l) => s.board[l]).filter((id) => id !== null);
  const decksLeft = LEVELS.some((l) => (s.decks ? s.decks[l].length : s.deckCounts[l]) > 0);
  if (p.reserved.length < MAX_RESERVED && (boardCards.length || decksLeft)) return true;
  const reachable = [...boardCards, ...p.reserved.map((r) => r.id)];
  return reachable.some((id) => autoPayment(p, CARDS[id]));
}

// ---------- views ----------

// What one seat is allowed to know. Deck order never leaves the host, and a
// blind-reserved card is visible only to the player holding it.
export function viewFor(s, viewerId) {
  const you = s.players.findIndex((p) => p.id === viewerId);
  return {
    v: s.v,
    version: s.version,
    you,
    phase: s.phase,
    turn: s.turn,
    start: s.start,
    target: s.target || WIN_POINTS,
    round: s.round,
    finalRound: s.finalRound,
    pending: s.pending && (s.turn === you ? s.pending : { type: s.pending.type }),
    players: s.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      tokens: { ...p.tokens },
      cards: [...p.cards],
      nobles: [...p.nobles],
      reserved: p.reserved.map((r) =>
        i === you || !r.blind
          ? { id: r.id, blind: r.blind, level: CARDS[r.id].level }
          : { id: null, blind: true, level: CARDS[r.id].level }),
    })),
    bank: { ...s.bank },
    board: { 1: [...s.board[1]], 2: [...s.board[2]], 3: [...s.board[3]] },
    deckCounts: deckCounts(s),
    nobles: [...s.nobles],
    log: s.log.slice(-80).map((e) => (e.t === 'reserve' && e.blind && e.p !== you ? { ...e, card: null } : e)),
    result: s.result,
  };
}
