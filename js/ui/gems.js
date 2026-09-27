// The gems. Each colour is a different real-world cut, so tokens read by shape
// as well as colour: round brilliant (diamond), kite-set princess (sapphire),
// emerald cut, trillion (ruby), hexagonal step cut (onyx), and a gold coin.
// Facet geometry is computed once and emitted as an SVG sprite.

const C = 32; // viewBox is 64x64, centred on (32, 32)
const rad = (d) => (d * Math.PI) / 180;
const polar = (deg, r, cx = C, cy = C) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
const fmt = (pts) => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Light comes from the upper left. Tone 0..4 (dark..bright) from facet direction,
// with alternating facets nudged apart for the checkerboard sparkle of a real cut.
function tone(pts, i, table = false) {
  if (table) return 3;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length - C;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length - C;
  const len = Math.hypot(cx, cy) || 1;
  const dot = (cx * -0.707 + cy * -0.707) / len; // -1..1
  let t = Math.round((dot + 1) * 1.6 + 0.4 + (i % 2 ? 0.45 : -0.45));
  return Math.max(0, Math.min(4, t));
}

function ringFacets(outer, inner) {
  const out = [];
  const n = outer.length;
  for (let k = 0; k < n; k++) {
    const a = outer[k], b = outer[(k + 1) % n], c = inner[(k + 1) % n], d = inner[k];
    const mo = mid(a, b), mi = mid(d, c);
    out.push([a, mo, mi, d], [mo, b, c, mi]);
  }
  return out;
}

function brilliant() {
  const T = [], S = [], G = [], H = [];
  for (let k = 0; k < 8; k++) {
    T.push(polar(22.5 + 45 * k, 13));
    S.push(polar(45 * k, 21));
    G.push(polar(22.5 + 45 * k, 29));
    H.push(polar(45 * k, 29));
  }
  const facets = [];
  for (let k = 0; k < 8; k++) {
    const n = (k + 1) % 8, p = (k + 7) % 8;
    facets.push([T[k], T[n], S[n]]);
    facets.push([T[k], S[k], G[k], S[n]]);
    facets.push([S[k], G[p], H[k]], [S[k], H[k], G[k]]);
  }
  return { outline: `<circle cx="32" cy="32" r="29"/>`, table: T, facets };
}

function kite() {
  const O = [[32, 3], [61, 32], [32, 61], [3, 32]];
  const I = O.map((p) => lerp([C, C], p, 0.42));
  return { outline: `<polygon points="${fmt(O)}"/>`, table: I, facets: ringFacets(O, I) };
}

function octagon(x0, y0, x1, y1, cut) {
  return [[x0 + cut, y0], [x1 - cut, y0], [x1, y0 + cut], [x1, y1 - cut], [x1 - cut, y1], [x0 + cut, y1], [x0, y1 - cut], [x0, y0 + cut]];
}

function emeraldCut() {
  const O = octagon(12, 4, 52, 60, 9);
  const M = octagon(17.5, 9.5, 46.5, 54.5, 6.5);
  const I = octagon(23, 15, 41, 49, 4);
  const facets = [];
  for (const [a, b] of [[O, M], [M, I]]) {
    for (let k = 0; k < 8; k++) facets.push([a[k], a[(k + 1) % 8], b[(k + 1) % 8], b[k]]);
  }
  return { outline: `<polygon points="${fmt(O)}"/>`, table: I, facets };
}

function trillion() {
  const O = [[32, 3], [61, 53], [3, 53]];
  const cen = [32, (3 + 53 + 53) / 3];
  const I = O.map((p) => lerp(cen, p, 0.4));
  // Slightly convex sides, like a real trillion.
  const bulge = (a, b) => {
    const m = mid(a, b);
    const v = [m[0] - cen[0], m[1] - cen[1]];
    const l = Math.hypot(...v);
    return [m[0] + (v[0] / l) * 3.2, m[1] + (v[1] / l) * 3.2];
  };
  const q = (a, b) => { const c = bulge(a, b); return `Q${c[0].toFixed(2)},${c[1].toFixed(2)} ${b[0]},${b[1]}`; };
  const outline = `<path d="M${O[0][0]},${O[0][1]} ${q(O[0], O[1])} ${q(O[1], O[2])} ${q(O[2], O[0])}Z"/>`;
  const facets = [];
  for (let k = 0; k < 3; k++) {
    const a = O[k], b = O[(k + 1) % 3], c = I[(k + 1) % 3], d = I[k];
    const bm = bulge(a, b), dm = mid(d, c);
    facets.push([a, bm, dm, d], [bm, b, c, dm]);
  }
  return { outline, table: I, facets };
}

function hexStep() {
  const O = [], M = [], I = [];
  for (let k = 0; k < 6; k++) {
    O.push(polar(-90 + 60 * k, 29));
    M.push(polar(-90 + 60 * k, 22));
    I.push(polar(-90 + 60 * k, 14));
  }
  const facets = [];
  for (const [a, b] of [[O, M], [M, I]]) {
    for (let k = 0; k < 6; k++) facets.push([a[k], a[(k + 1) % 6], b[(k + 1) % 6], b[k]]);
  }
  return { outline: `<polygon points="${fmt(O)}"/>`, table: I, facets };
}

const CUTS = { white: brilliant(), blue: kite(), green: emeraldCut(), red: trillion(), black: hexStep() };

// Five tones dark->bright, plus facet edge and outer rim colours.
const PALETTES = {
  white: { tones: ['#9eacc2', '#c6d0de', '#e4e9f1', '#f6f8fb', '#ffffff'], edge: '#96a5bb', rim: '#6d7c93' },
  blue: { tones: ['#0b2c6e', '#1646a3', '#2962d6', '#5b90f1', '#b2ccff'], edge: '#0c2a66', rim: '#081f4c' },
  green: { tones: ['#053b26', '#0a6843', '#139f69', '#45cb91', '#a6f2cc'], edge: '#053a25', rim: '#03291a' },
  red: { tones: ['#5c0918', '#991a2f', '#d2304a', '#f1697d', '#ffb5c0'], edge: '#5a0918', rim: '#410511' },
  black: { tones: ['#0c0b0f', '#1d1c23', '#302e38', '#4d4a58', '#827e90'], edge: '#060509', rim: '#9a96a8' },
};

function gemSymbol(color) {
  const cut = CUTS[color];
  const pal = PALETTES[color];
  const facets = cut.facets
    .map((pts, i) => `<polygon points="${fmt(pts)}" fill="${pal.tones[tone(pts, i)]}"/>`)
    .join('');
  const table = `<polygon points="${fmt(cut.table)}" fill="${pal.tones[3]}"/>`;
  const glint = `<polygon points="${fmt(cut.table)}" fill="url(#glint)" opacity="0.55"/>`;
  return `<symbol id="gem-${color}" viewBox="0 0 64 64">
    <g stroke="${pal.edge}" stroke-width="0.55" stroke-linejoin="round">${facets}${table}</g>${glint}
    <g fill="none" stroke="${pal.rim}" stroke-width="1.6" stroke-linejoin="round">${cut.outline}</g>
  </symbol>`;
}


const COIN = `<symbol id="gem-gold" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="29" fill="url(#coinRim)" stroke="#6f5210" stroke-width="1.4"/>
  <circle cx="32" cy="32" r="23" fill="url(#coinFace)" stroke="#9a7417" stroke-width="1"/>
  <circle cx="32" cy="32" r="20.5" fill="none" stroke="#b88a22" stroke-width="0.6" stroke-dasharray="1.2 1.6"/>
  <path d="M21 40.5h22l1.6-13.5-6.4 5.2L32 22.6l-6.2 9.6-6.4-5.2z" fill="#a47a1a" stroke="#6f5210" stroke-width="0.9" stroke-linejoin="round"/>
  <path d="M21.8 39.2h20.4" stroke="#ffe7a0" stroke-width="0.8" opacity="0.8"/>
  <circle cx="32" cy="22" r="1.7" fill="#ffe7a0"/><circle cx="19.2" cy="26.4" r="1.4" fill="#ffe7a0"/><circle cx="44.8" cy="26.4" r="1.4" fill="#ffe7a0"/>
  <path d="M14 22a20 20 0 0 1 14-10" fill="none" stroke="#fff3c4" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
</symbol>`;


const DEFS = `<defs>
  <linearGradient id="glint" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="coinRim" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff0b3"/><stop offset="0.35" stop-color="#e2b440"/><stop offset="0.7" stop-color="#b3841d"/><stop offset="1" stop-color="#7a5a12"/>
  </linearGradient>
  <radialGradient id="coinFace" cx="0.38" cy="0.32" r="0.8">
    <stop offset="0" stop-color="#fbe08a"/><stop offset="0.6" stop-color="#e2b440"/><stop offset="1" stop-color="#b98a22"/>
  </radialGradient>
</defs>`;

export const GEM_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="0" height="0">
  ${DEFS}
  ${Object.keys(CUTS).map((c) => gemSymbol(c)).join('')}
  ${COIN}
</svg>`;

export function injectSprite(doc = document) {
  if (doc.getElementById('trilliant-sprite')) return;
  const holder = doc.createElement('div');
  holder.id = 'trilliant-sprite';
  holder.innerHTML = GEM_SPRITE; // static markup generated above, no user data
  doc.body.prepend(holder);
}
