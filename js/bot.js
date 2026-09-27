// Legal-move generator plus a simple greedy player. Works on the full state or
// on a player's view (views carry deckCounts instead of decks).

import { CARDS, NOBLES, COLORS, TOKEN_COLORS } from './data.js';
import { autoPayment, takeRules, bonusesOf, MAX_RESERVED } from './engine.js';

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
