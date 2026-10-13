// Legal-move generator plus a simple greedy player. Works on the full state or
// on a player's view (views carry deckCounts instead of decks).

import { CARDS, NOBLES, COLORS, TOKEN_COLORS } from './data.js';
import { autoPayment, takeRules, bonusesOf, pointsOf, MAX_RESERVED } from './engine.js';

const LEVELS = [1, 2, 3];

function combinations(list, k) {
  if (k === 0) return [[]];
  const out = [];
  list.forEach((x, i) => {
    for (const rest of combinations(list.slice(i + 1), k - 1)) out.push([x, ...rest]);
  });
  return out;
}

const deckSize = (s, l) => (s.decks ? s.decks[l].length : s.deckCounts[l]);

export function legalActions(s, pi, rand = Math.random) {
  const p = s.players[pi];
  if (s.phase === 'over' || s.turn !== pi) return [];
  if (s.phase === 'noble') return s.pending.options.map((noble) => ({ type: 'noble', noble }));
  if (s.phase === 'discard') return [{ type: 'discard', gems: randomDiscard(p.tokens, s.pending.count, rand) }];

  const actions = [];
  const { available, pairable, distinctNeeded } = takeRules(s.bank);
  if (distinctNeeded > 0) {
    for (const gems of combinations(available, distinctNeeded)) actions.push({ type: 'take', gems });
  }
  for (const c of pairable) actions.push({ type: 'take', gems: [c, c] });

  const boardCards = LEVELS.flatMap((l) => s.board[l]).filter((id) => id !== null);
  if (p.reserved.length < MAX_RESERVED) {
    for (const card of boardCards) actions.push({ type: 'reserve', card });
    for (const level of LEVELS) if (deckSize(s, level) > 0) actions.push({ type: 'reserve', level });
  }
  for (const card of [...boardCards, ...p.reserved.map((r) => r.id)]) {
    if (card !== null && autoPayment(p, CARDS[card])) actions.push({ type: 'buy', card });
  }
  if (!actions.length) actions.push({ type: 'pass' });
  return actions;
}

function randomDiscard(tokens, count, rand) {
  const pool = [];
  for (const c of TOKEN_COLORS) for (let i = 0; i < tokens[c]; i++) pool.push(c);
  const gems = {};
  for (let i = 0; i < count; i++) {
    const [c] = pool.splice(Math.floor(rand() * pool.length), 1);
    gems[c] = (gems[c] || 0) + 1;
  }
  return gems;
}

export function randomAction(s, pi, rand = Math.random) {
  const actions = legalActions(s, pi, rand);
  const buys = actions.filter((a) => a.type === 'buy');
  if (buys.length && rand() < 0.8) return buys[Math.floor(rand() * buys.length)];
  const takes = actions.filter((a) => a.type === 'take');
  if (takes.length && rand() < 0.85) return takes[Math.floor(rand() * takes.length)];
  return actions[Math.floor(rand() * actions.length)];
}

// Greedy: buy the best card it can, otherwise take gems toward the cheapest
// high-value card, otherwise reserve. Good enough to finish games like a person.
export function greedyAction(s, pi, rand = Math.random) {
  const actions = legalActions(s, pi, rand);
  const p = s.players[pi];
  if (s.phase !== 'play') return actions[0];
  const buys = actions.filter((a) => a.type === 'buy');
  if (buys.length) {
    const b = bonusesOf(p);
    const score = (id) => {
      const c = CARDS[id];
      const nobleHelp = s.nobles.filter((n) => NOBLES[n].req[c.color] > b[c.color]).length;
      return c.points * 10 + nobleHelp * 2 - Object.values(c.cost).reduce((x, y) => x + y, 0) * 0.3;
    };
    return buys.sort((x, y) => score(y.card) - score(x.card))[0];
  }
  const target = LEVELS.flatMap((l) => s.board[l])
    .filter((id) => id !== null)
    .map((id) => {
      const need = COLORS.reduce((sum, c) => sum + Math.max(0, CARDS[id].cost[c] - bonusesOf(p)[c] - p.tokens[c]), 0);
      return { id, value: CARDS[id].points + 1 - need * 0.6 };
    })
    .sort((a, b) => b.value - a.value)[0];
  const takes = actions.filter((a) => a.type === 'take');
  if (target && takes.length) {
    const want = (c) => Math.max(0, CARDS[target.id].cost[c] - bonusesOf(p)[c] - p.tokens[c]);
    const useful = (a) => a.gems.reduce((sum, c) => sum + (want(c) > 0 ? 1 : 0), 0);
    takes.sort((x, y) => useful(y) - useful(x) || rand() - 0.5);
    if (useful(takes[0]) > 0 || rand() < 0.7) return takes[0];
  }
  const reserves = actions.filter((a) => a.type === 'reserve' && a.card !== undefined);
  if (target && reserves.length && rand() < 0.5) return reserves.find((a) => a.card === target.id) || reserves[0];
  return takes[0] || actions[Math.floor(rand() * actions.length)];
}

// ---------- the bot that fills a seat ----------

// Scores where it would stand after each legal move and plays the best one.
// It only reads what a player in that seat can see, so the host can feed it the
// seat's view: no deck order, nobody else's face-down reserves.

const TUNE = {
  patience: 0.8, // how much a card is worth for each turn it is still away
  bonus: 1.6, // what a card's permanent gem is worth early on, in points
  bonusLate: 0.3, // ...and when someone is about to win
  noble: 0.5, // weight on being part-way to a noble
  backup: [1, 0.5, 0.25], // weights on the best three cards within reach
  contested: 0.6, // discount on a board card someone else can already buy
  open: 0.92, // discount on any card still on the board
  gem: 0.04, // a loose gem in hand
  gold: 0.2,
  slot: 0, // what holding a reserved card costs
  goldOnce: true,
  restless: 0.5,
};

// Turns of gem-taking before `card` can be bought. 0 means it can be bought now.
function turnsAway(card, tokens, bonuses, bank, gold = tokens.gold) {
  const gaps = [];
  let owed = 0;
  for (const c of COLORS) {
    const net = Math.max(0, card.cost[c] - bonuses[c]);
    owed += net;
    if (net > tokens[c]) gaps.push({ c, n: net - tokens[c] });
  }
  // Gold fills the deepest gap first.
  for (let g = gold; g > 0 && gaps.length; g--) {
    gaps.sort((a, b) => b.n - a.n);
    if (!gaps[0].n) break;
    gaps[0].n -= 1;
  }
  let total = 0, deepest = 0, dry = 0;
  for (const { c, n } of gaps) {
    total += n;
    deepest = Math.max(deepest, n);
    dry += Math.max(0, n - bank[c]);
  }
  if (!total) return 0;
  // Three different gems a turn, or two of one color; an empty well or a price
  // above the 10-gem cap costs extra.
  return Math.max(total / 3, deepest * 0.75) + dry * 1.5 + Math.max(0, owed - 10) * 2;
}

// How far along the game is, 0 to 1, by whoever is closest to winning.
function stageOf(s) {
  const target = s.target || 15;
  return Math.min(1, Math.max(...s.players.map(pointsOf)) / target);
}

// What `me` is worth holding these gems, cards and reserves on this table.
function standing(s, me, k) {
  const b = bonusesOf(me);
  const target = s.target || 15;
  const stage = stageOf(s);
  const perBonus = k.bonusLate + (k.bonus - k.bonusLate) * (1 - stage);
  let points = 0;
  for (const id of me.cards) points += CARDS[id].points;
  points += me.nobles.length * 3;

  let nobles = 0;
  for (const id of s.nobles) {
    let missing = 0;
    for (const c of COLORS) missing += Math.max(0, NOBLES[id].req[c] - b[c]);
    if (!missing) points += 3;
    else nobles += 3 * k.noble * k.patience ** (missing * 1.5);
  }

  let score = points * (1 + stage) + nobles;
  if (points >= target) score += 100 + points;
  for (const c of COLORS) score += perBonus * (Math.min(b[c], 4) + Math.max(0, b[c] - 4) * 0.4);
  for (const c of COLORS) score += me.tokens[c] * k.gem;
  score += me.tokens.gold * k.gold - me.reserved.length * k.slot;

  const others = s.players.filter((p) => p.id !== me.id);
  const reach = [];
  const consider = (id, held) => {
    const card = CARDS[id];
    const worth = card.points * (1 + stage) + perBonus + (points + card.points >= target ? 6 : 0);
    let odds = 1;
    if (!held) odds = others.some((o) => autoPayment(o, card)) ? k.contested : k.open;
    const at = (gold) => worth * odds * k.patience ** (turnsAway(card, me.tokens, b, s.bank, gold) + 1);
    reach.push({ gold: at(me.tokens.gold), plain: k.goldOnce ? at(0) : at(me.tokens.gold) });
  };
  for (const l of LEVELS) for (const id of s.board[l]) if (id !== null) consider(id, false);
  for (const r of me.reserved) if (r.id !== null && r.id !== undefined) consider(r.id, true);
  // Gold can only be spent once: it counts toward the best card, not the backups.
  reach.sort((x, y) => y.gold - x.gold);
  const rest = reach.slice(1).map((x) => x.plain).sort((x, y) => y - x);
  score += (reach[0]?.gold || 0) * k.backup[0] + (rest[0] || 0) * k.backup[1] + (rest[1] || 0) * k.backup[2];
  return score;
}

const cloneSeat = (p) => ({ ...p, tokens: { ...p.tokens }, cards: [...p.cards], reserved: [...p.reserved], nobles: [...p.nobles] });

// The gems to put back that hurt least, one at a time.
function bestDiscard(s, pi, count, k) {
  const table = { ...s, bank: { ...s.bank }, players: s.players.map(cloneSeat) };
  const me = table.players[pi];
  const gems = {};
  for (let i = 0; i < count; i++) {
    let best = null;
    for (const c of TOKEN_COLORS) {
      if (!me.tokens[c]) continue;
      me.tokens[c] -= 1;
      table.bank[c] += 1;
      const score = standing(table, me, k);
      me.tokens[c] += 1;
      table.bank[c] -= 1;
      if (!best || score > best.score) best = { c, score };
    }
    me.tokens[best.c] -= 1;
    table.bank[best.c] += 1;
    gems[best.c] = (gems[best.c] || 0) + 1;
  }
  return { gems, table };
}

// The table as it would look to the mover after `a`. New cards dealt from the
// decks are unknown, so the emptied slot just stays empty.
function after(s, pi, a, k) {
  const table = {
    ...s,
    bank: { ...s.bank },
    board: { 1: [...s.board[1]], 2: [...s.board[2]], 3: [...s.board[3]] },
    players: s.players.map(cloneSeat),
  };
  const me = table.players[pi];
  const lift = (id) => { for (const l of LEVELS) table.board[l] = table.board[l].map((x) => (x === id ? null : x)); };
  if (a.type === 'take') {
    for (const c of a.gems) { me.tokens[c] += 1; table.bank[c] -= 1; }
    const extra = TOKEN_COLORS.reduce((n, c) => n + me.tokens[c], 0) - 10;
    if (extra > 0) return bestDiscard(table, pi, extra, k).table;
  } else if (a.type === 'buy') {
    const pay = autoPayment(me, CARDS[a.card]);
    for (const c of TOKEN_COLORS) { me.tokens[c] -= pay[c]; table.bank[c] += pay[c]; }
    me.cards.push(a.card);
    me.reserved = me.reserved.filter((r) => r.id !== a.card);
    lift(a.card);
  } else if (a.type === 'reserve') {
    me.reserved.push({ id: a.card ?? null });
    if (a.card !== undefined) lift(a.card);
    if (table.bank.gold > 0) { table.bank.gold -= 1; me.tokens.gold += 1; }
    const extra = TOKEN_COLORS.reduce((n, c) => n + me.tokens[c], 0) - 10;
    if (extra > 0) return bestDiscard(table, pi, extra, k).table;
  }
  return table;
}

export function botAction(s, pi, rand = Math.random, k = TUNE) {
  const me = s.players[pi];
  if (s.phase === 'discard') return { type: 'discard', gems: bestDiscard(s, pi, s.pending.count, k).gems };
  const actions = legalActions(s, pi, rand);
  if (s.phase !== 'play' || actions.length < 2) return actions[0];

  // A card that would win it for someone before the bot moves again is worth taking away.
  const target = s.target || 15;
  const threats = new Set();
  for (const o of s.players) {
    if (o.id === me.id) continue;
    for (const l of LEVELS) for (const id of s.board[l]) {
      if (id !== null && pointsOf(o) + CARDS[id].points >= target && autoPayment(o, CARDS[id])) threats.add(id);
    }
  }

  // Turns since this seat last bought anything. The longer the dry spell, the
  // keener it gets to buy whatever it can, which puts gems back in the bank.
  let dry = 0;
  for (let i = s.log.length - 1; i >= 0 && !(s.log[i].t === 'buy' && s.log[i].p === pi); i--) {
    if (s.log[i].p === pi && ['take', 'reserve', 'pass', 'timeout'].includes(s.log[i].t)) dry += 1;
  }

  let best = null;
  for (const a of actions) {
    const table = after(s, pi, a, k);
    let score = standing(table, table.players[pi], k) + rand() * 0.01;
    if (a.type === 'reserve' && threats.has(a.card)) score += 5;
    if (a.type === 'buy' && dry > 6) score += (dry - 6) * k.restless;
    if (!best || score > best.score) best = { a, score };
  }
  return best.a;
}
