// Presentational pieces of the table. No network or game logic in here beyond
// reading the view the host sent.

import { html } from '../../vendor/preact-htm.js';
import { CARDS, NOBLES, COLORS, TOKEN_COLORS } from '../data.js';
import { COLOR_NAMES, bonusesOf, pointsOf, tokenTotal, MAX_TOKENS, WIN_POINTS } from '../engine.js';

export const cls = (...xs) => xs.filter(Boolean).join(' ');
export const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Gem({ color, cls: extra = '', title }) {
  return html`<svg class=${cls('gem', extra)} viewBox="0 0 64 64" role=${title ? 'img' : undefined} aria-label=${title} aria-hidden=${title ? undefined : 'true'}><use href=${`#gem-${color}`} /></svg>`;
}

export function Chip({ color, n, hideZero = false }) {
  return html`<span class=${cls('chip', `chip--${color}`, !n && 'is-zero')}>${hideZero && !n ? '' : n}</span>`;
}

export function cardLabel(card) {
  const cost = COLORS.filter((c) => card.cost[c]).map((c) => `${card.cost[c]} ${COLOR_NAMES[c]}`).join(', ');
  const pts = card.points ? `, ${plural(card.points, 'point')}` : '';
  return `Level ${card.level} ${COLOR_NAMES[card.color]} card${pts}. Costs ${cost}.`;
}

// A development card. Rendered as a button only when it can be acted on.
export function Card({ id, onClick, buyable, selected, isNew, flash, covered, size }) {
  const card = CARDS[id];
  const Tag = onClick ? 'button' : 'div';
  const style = size ? `--cw:${size}px` : undefined;
  return html`<${Tag}
      type=${onClick ? 'button' : undefined}
      class=${cls('card', `card--${card.color}`, onClick && 'is-clickable', buyable && 'is-buyable', selected && 'is-selected', isNew && 'is-new', flash && 'is-flash')}
      style=${style}
      onClick=${onClick}
      aria-label=${cardLabel(card)}
      aria-pressed=${onClick ? String(!!selected) : undefined}
      role=${onClick ? undefined : 'img'}>
    <span class="card__band">
      ${card.points ? html`<span class="card__pts">${card.points}</span>` : null}
      <svg class="card__bonus" viewBox="0 0 64 64" aria-hidden="true"><use href=${`#gem-${card.color}`} /></svg>
    </span>
    <span class="card__body">
      <span class="card__cost">
        ${COLORS.filter((c) => card.cost[c] > 0).map((c) => html`
          <span class=${cls('cost', covered && covered[c] >= card.cost[c] && 'is-covered')}>
            <${Gem} color=${c} />${card.cost[c]}
          </span>`)}
      </span>
    </span>
  <//>`;
}

export function Deck({ level, count, onClick, selected, flash, hiddenCard }) {
  const Tag = onClick ? 'button' : 'div';
  const label = hiddenCard ? `Face-down level ${level} card` : `Level ${level} deck, ${plural(count, 'card')} left`;
  return html`<${Tag}
      type=${onClick ? 'button' : undefined}
      class=${cls('deck', onClick && 'is-clickable', selected && 'is-selected', flash && 'is-flash', !hiddenCard && count === 0 && 'is-empty')}
      onClick=${onClick}
      aria-label=${label}
      aria-pressed=${onClick ? String(!!selected) : undefined}
      role=${onClick ? undefined : 'img'}>
    <span class="deck__numeral">${ROMAN[level]}</span>
    ${hiddenCard ? null : html`<span class="deck__count">${count} left</span>`}
  <//>`;
}

export function Noble({ id, onClick, flash }) {
  const n = NOBLES[id];
  const Tag = onClick ? 'button' : 'div';
  const req = COLORS.filter((c) => n.req[c] > 0);
  const label = `Noble, 3 points. Needs ${req.map((c) => `${n.req[c]} ${COLOR_NAMES[c]} cards`).join(', ')}.`;
  return html`<${Tag} type=${onClick ? 'button' : undefined} class=${cls('noble', onClick && 'is-choice', flash && 'is-flash')} onClick=${onClick} aria-label=${label} role=${onClick ? undefined : 'img'}>
    <span class="noble__pts">${n.points}</span>
    <span class="noble__req">${req.map((c) => html`<${Chip} color=${c} n=${n.req[c]} />`)}</span>
  <//>`;
}

export function Well({ color, count, onClick, picked, flash }) {
  const Tag = onClick ? 'button' : 'div';
  const name = COLOR_NAMES[color];
  return html`<${Tag}
      type=${onClick ? 'button' : undefined}
      class=${cls('well', color === 'gold' && 'well--gold', onClick && 'is-clickable', !count && 'is-empty', picked && 'is-picked', flash && 'is-flash')}
      onClick=${onClick}
      aria-label=${`${count} ${name}${count === 1 ? '' : 's'} in the bank${picked ? `, ${picked} picked` : ''}`}
      role=${onClick ? undefined : 'img'}>
    <${Gem} color=${color} />
    <span class="well__count">${count}</span>
  <//>`;
}

// Per colour: cards owned (card-shaped chip) above gems held (gem with count).
export function Holdings({ player, onGem, marked }) {
  const b = bonusesOf(player);
  return html`<div class="holdings">
    ${TOKEN_COLORS.map((c) => {
      const n = player.tokens[c];
      const left = n - (marked?.[c] || 0);
      const clickable = onGem && n > 0;
      return html`<div class=${cls('hold', !n && 'is-zero')}>
        ${c === 'gold' ? html`<span class="chip" style="visibility:hidden">0</span>` : html`<${Chip} color=${c} n=${b[c]} hideZero />`}
        <span
          class=${cls('hold__gem', clickable && 'is-clickable', marked?.[c] && 'is-picked')}
          role=${clickable ? 'button' : undefined}
          tabindex=${clickable ? 0 : undefined}
          aria-label=${`${n} ${COLOR_NAMES[c]}${marked?.[c] ? `, ${marked[c]} marked to return` : ''}`}
          onClick=${clickable ? () => onGem(c) : undefined}
          onKeyDown=${clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGem(c); } } : undefined}>
          <${Gem} color=${c} />${(marked ? left : n) ? html`<b>${marked ? left : n}</b>` : null}
        </span>
      </div>`;
    })}
  </div>`;
}

export function Reserved({ player, isYou, onPick, selectedId, canAfford, size }) {
  const slots = [];
  for (const r of player.reserved) {
    if (r.id === null) {
      slots.push(html`<${Deck} level=${r.level} hiddenCard />`);
      continue;
    }
    slots.push(html`<${Card}
      id=${r.id}
      size=${size}
      onClick=${isYou && onPick ? () => onPick(r.id) : undefined}
      selected=${selectedId === r.id}
      buyable=${isYou && canAfford?.(r.id)}
      covered=${isYou ? bonusesOf(player) : undefined} />`);
  }
  return html`<div class="reserved">${slots}</div>`;
}

export function SeatCard({ player, view, online, isTurn, flash }) {
  const pts = pointsOf(player);
  const held = tokenTotal(player.tokens);
  return html`<section class=${cls('panel', 'seatcard', 'opp', isTurn && 'is-turn', flash && 'is-flash')} aria-label=${`${player.name}, ${plural(pts, 'point')}`}>
    <div class="seatcard__head">
      <span class=${cls('dot', online && 'is-on')} title=${online ? 'Online' : 'Offline'}></span>
      <span class="seatcard__name">${player.name}</span>
      ${isTurn ? html`<span class="seatcard__turn">Their turn</span>` : null}
      <span class="seatcard__score"><b>${pts}</b><span>/ ${WIN_POINTS}</span></span>
    </div>
    <${Holdings} player=${player} />
    <div class="holdings__foot">
      <span class=${held >= MAX_TOKENS ? 'is-full' : ''}>Gems <b>${held}</b>/${MAX_TOKENS}</span>
      ${player.nobles.length ? html`<span>Nobles <b>${player.nobles.length}</b></span>` : null}
    </div>
    ${player.reserved.length ? html`<${Reserved} player=${player} size=${46} />` : null}
  </section>`;
}

// ---------- log ----------

function GemList({ gems }) {
  const items = [];
  for (const c of TOKEN_COLORS) for (let i = 0; i < (gems[c] || 0); i++) items.push(html`<${Gem} color=${c} title=${COLOR_NAMES[c]} />`);
  return items;
}

export function describeCard(id) {
  const c = CARDS[id];
  return `a level ${ROMAN[c.level]} ${COLOR_NAMES[c.color]}${c.points ? ` (${plural(c.points, 'point')})` : ''}`;
}

export function LogItem({ e, players, you, tag = 'li' }) {
  const who = e.p !== undefined ? (e.p === you ? 'You' : players[e.p]?.name) : '';
  const W = html`<strong>${who}</strong>`;
  const w = html`<strong>${e.p === you ? 'you' : who}</strong>`;
  let body = null;
  let key = false;
  switch (e.t) {
    case 'start': key = true; body = html`${W} ${e.p === you ? 'go' : 'goes'} first.`; break;
    case 'take': body = html`${W} took <${GemList} gems=${e.gems} />`; break;
    case 'reserve': {
      const what = e.card === null || e.card === undefined ? `a face-down level ${ROMAN[e.level]} card` : describeCard(e.card);
      body = html`${W} reserved ${what}${e.blind && e.card != null ? ' from the deck' : ''}${e.gold ? html` and took <${Gem} color="gold" title="gold" />` : ''}`;
      break;
    }
    case 'buy': body = html`${W} bought <${Gem} color=${CARDS[e.card].color} /> ${describeCard(e.card)}${e.fromReserve ? ' from reserve' : ''}`; break;
    case 'discard': body = html`${W} put back <${GemList} gems=${e.gems} />`; break;
    case 'noble': key = true; body = html`A noble visited ${w}. +3`; break;
    case 'pass': body = html`${W} had no move and passed.`; break;
    case 'final': key = true; body = html`${W} reached ${WIN_POINTS}. Last round.`; break;
    case 'end': key = true; body = 'Game over.'; break;
    default: return null;
  }
  const Tag = tag;
  return html`<${Tag} class=${cls('log__item', key && 'is-key')}>${body}<//>`;
}

// One-line summary of a player's latest move, for the tray while you wait.
export function lastMoveText(view) {
  const log = view.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (!['take', 'reserve', 'buy', 'pass'].includes(e.t)) continue;
    return e;
  }
  return null;
}
