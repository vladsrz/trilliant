// Move a copy of the actual board piece between its old and new positions.
// This is presentation only: the host's accepted game view remains the source
// of truth, and reconnects or skipped versions never replay old moves.
import { CARDS } from '../data.js';

const MOVE_TYPES = new Set(['take', 'reserve', 'buy', 'discard', 'noble', 'timeout']);
const FLIGHT_MS = 560;
const GEM_STAGGER_MS = 85;

export function capturePieces(root) {
  const pieces = new Map();
  for (const el of root.querySelectorAll('[data-fx-key]')) {
    if (el.dataset.fxKey.startsWith('player:')) continue; // seats are destinations only
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const node = el.cloneNode(true);
    node.classList.remove('is-selected', 'is-new', 'is-flash', 'is-buyable', 'is-clickable');
    pieces.set(el.dataset.fxKey, { rect, node });
  }
  return pieces;
}

function destination(root, key, fallback) {
  let fallbackEl = null;
  for (const el of root.querySelectorAll('[data-fx-key]')) {
    if (el.dataset.fxKey === key) return el;
    if (fallback && el.dataset.fxKey === fallback) fallbackEl = el;
  }
  return fallbackEl;
}

function visible(rect) {
  return rect && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
}

function fly(pieces, root, from, to, fallback, delay = 0) {
  const source = pieces.get(from);
  const target = destination(root, to, fallback);
  if (!source || !target) return;
  const a = source.rect;
  const b = target.getBoundingClientRect();
  if (!visible(a) || !visible(b)) return;

  const ghost = source.node.cloneNode(true);
  ghost.removeAttribute('data-fx-key');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.position = 'fixed';
  ghost.style.left = `${a.left}px`;
  ghost.style.top = `${a.top}px`;
  ghost.style.width = `${a.width}px`;
  ghost.style.height = `${a.height}px`;
  ghost.style.margin = '0';
  ghost.style.zIndex = '70';
  ghost.style.pointerEvents = 'none';
  ghost.style.transition = 'none';
  ghost.style.animation = 'none';
  ghost.style.transformOrigin = 'center center';
  if (ghost.classList.contains('card') || ghost.classList.contains('deck')) ghost.style.setProperty('--cw', `${a.width}px`);
  if (ghost.classList.contains('noble')) ghost.style.setProperty('--nw', `${a.width}px`);
  document.body.append(ghost);

  const dx = b.left + b.width / 2 - a.left - a.width / 2;
  const dy = b.top + b.height / 2 - a.top - a.height / 2;
  const scale = Math.min(1, Math.max(0.23, b.width / a.width));
  const motion = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
    { transform: `translate(${dx * 0.48}px, ${dy * 0.48 - 18}px) scale(${(1 + scale) / 2})`, opacity: 1, offset: 0.52 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.85, offset: 1 },
  ], { duration: FLIGHT_MS, delay, easing: 'cubic-bezier(.2,.68,.2,1)', fill: 'forwards' });
  motion.finished.then(() => {
    ghost.remove();
    target.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.19)' }, { transform: 'scale(1)' },
    ], { duration: 280, easing: 'ease-out' });
  }).catch(() => ghost.remove());
}

function gems(counts, fn) {
  let n = 0;
  for (const [color, count] of Object.entries(counts || {})) {
    for (let i = 0; i < count; i++) fn(color, n++ * GEM_STAGGER_MS);
  }
}

export function newMoveEntries(previous, current) {
  // The log keeps only its latest entries, so its length may stay at 80.
  let overlap = Math.min(previous.log.length, current.log.length);
  while (overlap && previous.log.slice(-overlap).some((entry, i) =>
    JSON.stringify(entry) !== JSON.stringify(current.log[i]))) overlap--;
  return current.log.slice(overlap).filter((entry) => MOVE_TYPES.has(entry.t));
}

export function animateMove(previous, current, pieces, root) {
  const entries = newMoveEntries(previous, current);
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return entries;
  const player = (entry) => current.players[entry.p]?.id;

  for (const entry of entries) {
    const id = player(entry);
    if (!id) continue;
    const seat = `player:${id}`;
    if (entry.t === 'take') {
      gems(entry.gems, (color, delay) => fly(pieces, root, `bank:${color}`, `hold:${id}:${color}`, seat, delay));
    } else if (entry.t === 'discard' || (entry.t === 'timeout' && entry.gems)) {
      gems(entry.gems, (color, delay) => fly(pieces, root, `hold:${id}:${color}`, `bank:${color}`, null, delay));
    } else if (entry.t === 'reserve') {
      const from = entry.blind ? `deck:${entry.level}` : `board:${entry.card}`;
      fly(pieces, root, from, `reserve:${id}:${entry.card}`, seat);
      if (entry.gold) fly(pieces, root, 'bank:gold', `hold:${id}:gold`, seat, 100);
    } else if (entry.t === 'buy') {
      const from = entry.fromReserve ? `reserve:${id}:${entry.card}` : `board:${entry.card}`;
      // The destination is the matching bonus chip, whose color is in card data.
      fly(pieces, root, from, `bonus:${id}:${CARDS[entry.card].color}`, seat);
      gems(entry.pay, (gem, delay) => fly(pieces, root, `hold:${id}:${gem}`, `bank:${gem}`, null, delay + 80));
    } else if (entry.t === 'noble') {
      fly(pieces, root, `noble:${entry.noble}`, seat, null);
    }
  }
  return entries;
}
