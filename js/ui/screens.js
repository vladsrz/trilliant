import { html, useState, useEffect, useRef, useMemo } from '../../vendor/preact-htm.js';
import { CARDS, COLORS, TOKEN_COLORS } from '../data.js';
import {
  COLOR_NAMES, autoPayment, netCost, bonusesOf, pointsOf, tokenTotal, takeRules, hasMainAction,
  MAX_TOKENS, MAX_RESERVED, WIN_POINTS,
} from '../engine.js';
import { Gem, Card, Deck, Noble, Well, Holdings, Reserved, SeatCard, LogItem, cls, ROMAN, describeCard } from './parts.js';
import { NAME_MAX, CHAT_MAX, TIMER_CHOICES } from '../net/room.js';
import { TARGET_CHOICES } from '../engine.js';
import { every } from '../net/ticker.js';

const TIMER_LABELS = { 0: 'Off', 60: '1 min', 120: '2 min', 180: '3 min' };
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// Seconds left until `deadline`, ticking once a second. Runs on the worker
// ticker so the countdown in a background tab's title keeps moving.
function useSecondsLeft(deadline) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    setNow(Date.now());
    return every(1000, () => setNow(Date.now()));
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
const nameList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`);

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ======================================================================
// Home
// ======================================================================

export function Home({ name, onName, onCreate, tables, onResume, onForget, busy }) {
  const [confirm, setConfirm] = useState(false);
  const hosted = tables.find((t) => t.role === 'host');
  // One hosted game per browser: a new one ends the old, so ask first if friends were in it.
  const submit = (e) => {
    e.preventDefault();
    if (hosted && hosted.players > 0) setConfirm(true);
    else onCreate(hosted);
  };
  return html`<main class="home">
    <div class="home__inner">
      <div class="home__gems" aria-hidden="true">
        ${['white', 'blue', 'green', 'red', 'black', 'gold'].map((c) => html`<${Gem} color=${c} />`)}
      </div>
      <h1 class="home__mark">Trilliant</h1>
      <p class="home__lede">Trade gems, buy cards, win nobles. Create a game and send the link to a friend.</p>
      <form class="panel home__form" onSubmit=${submit}>
        <div>
          <label class="label" for="name">Your name</label>
          <div class="home__row">
            <input id="name" class="field" value=${name} maxlength=${NAME_MAX} autocomplete="nickname"
              onInput=${(e) => onName(e.currentTarget.value)} />
            <button class="btn btn--primary" type="submit" disabled=${busy}>${busy ? 'Creating…' : 'Create game'}</button>
          </div>
        </div>
        ${tables.length ? html`<div class="tables">
          <h2 class="tables__title">Pick up where you left off</h2>
          ${[...tables].sort((a, b) => (a.role === b.role ? 0 : a.role === 'host' ? -1 : 1)).map((t) => html`<div class="tables__row">
            <div class="tables__what">
              <strong>${t.title || (t.role === 'host' ? 'Your game' : 'A friend’s game')}</strong>
              <span>${t.role === 'host' ? 'You’re the host' : 'You joined'} · ${ago(t.at)}</span>
            </div>
            <button type="button" class="btn btn--small" onClick=${() => onResume(t)}>Rejoin</button>
            <button type="button" class="btn btn--small btn--ghost" onClick=${() => onForget(t)}>${t.role === 'host' ? 'End' : 'Remove'}</button>
          </div>`)}
        </div>` : null}
      </form>
      <p class="home__small">Free, no sign-up. Plays by the rules of Splendor; fan-made, not affiliated with Space Cowboys or Asmodee.</p>
    </div>
    ${confirm ? html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="replace-title">
      <section class="panel sheet notice">
        <h2 class="sheet__title" id="replace-title">You already have a game going</h2>
        <p class="sheet__sub">You can host one game at a time. Starting a new one ends ${hosted.title ? hosted.title.replace(/^Your game/, 'your game') : 'your current game'}, and nobody can continue it.</p>
        <div class="sheet__actions">
          <button type="button" class="btn" onClick=${() => setConfirm(false)}>Keep it</button>
          <button type="button" class="btn btn--danger-solid" onClick=${() => { setConfirm(false); onCreate(hosted); }}>End it and start new</button>
        </div>
      </section>
    </div>` : null}
  </main>`;
}

// ======================================================================
// Notices
// ======================================================================

export function Notice({ title, children, actions }) {
  return html`<main class="stage"><section class="panel sheet notice">
    <h1 class="sheet__title">${title}</h1>
    <div class="sheet__sub">${children}</div>
    ${actions ? html`<div class="sheet__actions">${actions}</div>` : null}
  </section></main>`;
}

export function Connecting({ snap, waited }) {
  const online = !!snap?.link?.up;
  const guest = snap?.role === 'guest';
  let line = 'Connecting…';
  if (online) line = guest && !snap.hostOnline ? 'Waiting for the host…' : 'Almost there…';
  let help = null;
  if (waited && !online) help = 'Can’t connect. Check your internet. Some school or work Wi-Fi blocks games like this, so try phone data.';
  else if (waited && guest && !snap.hostOnline) help = 'The host needs to have the game open. You’ll join as soon as they do.';
  return html`<main class="stage"><section class="panel sheet notice" aria-live="polite">
    <div class="spinner"><${Gem} color="red" /></div>
    <h1 class="sheet__title">${guest ? 'Joining game' : 'Creating game'}</h1>
    <p class="sheet__sub">${line}</p>
    ${help ? html`<p class="sheet__sub">${help}</p>` : null}
  </section></main>`;
}

// ======================================================================
// Lobby
// ======================================================================

export function Lobby({ snap, room, name, onRename, onLeave, notify }) {
  const lobby = snap.lobby;
  const isHost = snap.role === 'host';
  const hostName = lobby.seats.find((s) => s.host)?.name || 'the host';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const link = location.href;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); notify('Invite link copied.'); } catch { notify('Copy the link from the address bar.'); }
  };
  const canStart = lobby.seats.length >= 2;
  const open = lobby.max - lobby.seats.length;
  const saveName = (e) => {
    e.preventDefault();
    if (draft.trim()) onRename(draft);
    setEditing(false);
  };

  return html`<main class="stage">
    <section class="panel sheet">
      <h1 class="sheet__title">${isHost ? 'Your game' : `${hostName}’s game`}</h1>
      <p class="sheet__sub">${isHost ? 'Send this link to your friends. Keep this tab open while you play.' : 'You’re in.'}</p>

      <div class="invite">
        <span class="invite__link" title=${link}>${link}</span>
        <button type="button" class="btn" onClick=${copy}>Copy invite link</button>
      </div>

      <ul class="seats">
        ${lobby.seats.map((s) => {
          const mine = s.id === snap.selfId;
          const wins = snap.tally?.[s.id] || 0;
          if (mine && editing) {
            return html`<li class="seat"><form class="rename" onSubmit=${saveName}>
              <input class="field" aria-label="Your name" value=${draft} maxlength=${NAME_MAX} autofocus onInput=${(e) => setDraft(e.currentTarget.value)} />
              <button class="btn btn--small btn--primary" type="submit" disabled=${!draft.trim()}>Save</button>
              <button class="btn btn--small btn--ghost" type="button" onClick=${() => { setDraft(name); setEditing(false); }}>Cancel</button>
            </form></li>`;
          }
          return html`<li class="seat">
            <span class=${cls('dot', s.online && 'is-on')} title=${s.online ? 'Online' : 'Offline'}></span>
            <span class="seat__name">${s.name}${mine ? html` <span class="seat__you">(you)</span>` : null}</span>
            ${wins ? html`<span class="seat__wins">${wins} win${wins === 1 ? '' : 's'}</span>` : null}
            ${s.host ? html`<span class="seat__tag">Host</span>` : null}
            ${mine ? html`<button type="button" class="btn btn--small btn--ghost" onClick=${() => setEditing(true)}>Change name</button>` : null}
            ${isHost && !s.host ? html`<button type="button" class="btn btn--small btn--ghost" onClick=${() => room.removeSeat(s.id)}>Remove</button>` : null}
          </li>`;
        })}
        ${open > 0 ? html`<li class="seat seat--empty"><span class="dot"></span>
          <span class="seat__name">${canStart ? `Room for ${open} more` : 'Waiting for someone to join…'}</span></li>` : null}
      </ul>

      <div class="setting">
        <span class="setting__label">Points to win</span>
        ${isHost
          ? html`<div class="segmented" role="radiogroup" aria-label="Points to win">
              ${TARGET_CHOICES.map((pts) => html`<button type="button" role="radio" aria-checked=${String(lobby.target === pts)}
                class=${cls(lobby.target === pts && 'is-on')} onClick=${() => room.setTarget(pts)}>${pts}</button>`)}
            </div>`
          : html`<span class="setting__value">${lobby.target ?? 15}</span>`}
      </div>
      <div class="setting setting--tight">
        <span class="setting__label">Turn timer</span>
        ${isHost
          ? html`<div class="segmented" role="radiogroup" aria-label="Turn timer">
              ${TIMER_CHOICES.map((sec) => html`<button type="button" role="radio" aria-checked=${String(lobby.turnSeconds === sec)}
                class=${cls(lobby.turnSeconds === sec && 'is-on')} onClick=${() => room.setTimer(sec)}>${TIMER_LABELS[sec]}</button>`)}
            </div>`
          : html`<span class="setting__value">${TIMER_LABELS[lobby.turnSeconds] ?? 'Off'}</span>`}
      </div>

      <div class="sheet__actions">
        <button type="button" class="btn btn--danger" onClick=${onLeave}>Leave game</button>
        ${isHost
          ? html`<button type="button" class="btn btn--primary" disabled=${!canStart} onClick=${() => { const r = room.startGame(); if (!r.ok) notify(r.error); }}>Start game</button>`
          : html`<button type="button" class="btn" disabled>Waiting for ${hostName} to start</button>`}
      </div>
    </section>
  </main>`;
}

// ======================================================================
// Game
// ======================================================================

// Highlights for what changed since the last version, so the other player's
// move is visible at a glance.
function useChanges(g, you) {
  const prev = useRef(null);
  const [fx, setFx] = useState({ v: -1, slots: new Set(), bank: new Set(), seats: new Set(), dealt: new Set() });
  useEffect(() => {
    const p = prev.current;
    prev.current = g;
    if (!p || g.version <= p.version || g.players.length !== p.players.length) return undefined;
    const lastMove = [...g.log].reverse().find((e) => ['take', 'reserve', 'buy', 'discard', 'noble', 'pass', 'timeout'].includes(e.t));
    const theirs = lastMove && lastMove.p !== you;
    const slots = new Set(), dealt = new Set(), bank = new Set(), seats = new Set();
    for (const l of [1, 2, 3]) g.board[l].forEach((id, i) => { if (p.board[l][i] !== id) { dealt.add(`${l}-${i}`); if (theirs) slots.add(`${l}-${i}`); } });
    if (theirs) {
      for (const c of TOKEN_COLORS) if (g.bank[c] !== p.bank[c]) bank.add(c);
      g.players.forEach((pl, i) => {
        const q = p.players[i];
        if (i !== you && (JSON.stringify(pl.tokens) !== JSON.stringify(q.tokens) || pl.cards.length !== q.cards.length || pl.reserved.length !== q.reserved.length || pl.nobles.length !== q.nobles.length)) seats.add(i);
      });
    }
    setFx({ v: g.version, slots, bank, seats, dealt });
    const t = setTimeout(() => setFx((f) => (f.v === g.version ? { ...f, slots: new Set(), bank: new Set(), seats: new Set(), dealt: new Set() } : f)), 2700);
    return () => clearTimeout(t);
  }, [g.version]);
  return fx;
}

export function Game({ snap, room, onLeave, notify }) {
  const g = snap.game;
  const you = g.you;
  const me = g.players[you];
  const over = g.phase === 'over';
  const myTurn = g.turn === you && !over;
  const current = g.players[g.turn];
  const isHost = snap.role === 'host';

  const [picks, setPicks] = useState([]);
  const [sel, setSel] = useState(null);
  const [marked, setMarked] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showResult, setShowResult] = useState(over);
  const [fresh, setFresh] = useState(false);
  const fx = useChanges(g, you);

  useEffect(() => { setPicks([]); setSel(null); setMarked({}); setErr(null); }, [g.version]);
  useEffect(() => { if (over) setShowResult(true); }, [over]);

  // Your-turn cue: pulse the tray. (The tab title lives in TurnPill.)
  useEffect(() => {
    if (!myTurn) { setFresh(false); return undefined; }
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 1500);
    return () => clearTimeout(t);
  }, [myTurn, g.turn, g.round]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setPicks([]); setSel(null); setMarked({}); setErr(null); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const send = async (action) => {
    setBusy(true);
    setErr(null);
    const res = await room.act(action);
    setBusy(false);
    if (!res.ok) setErr(res.error);
    return res;
  };

  const playing = myTurn && g.phase === 'play' && !busy;
  const rules = takeRules(g.bank);
  const bonuses = bonusesOf(me);
  const affordable = (id) => !!autoPayment(me, CARDS[id]);

  // ----- gem picking -----
  const clickWell = (c) => {
    if (!playing || c === 'gold') return;
    setSel(null);
    setErr(null);
    const n = picks.filter((x) => x === c).length;
    if (n === 2) return setPicks([]);
    if (n === 1) {
      if (picks.length === 1 && g.bank[c] >= 4) return setPicks([c, c]);
      return setPicks(picks.filter((x) => x !== c));
    }
    if (!g.bank[c]) return;
    if (picks.length === 2 && picks[0] === picks[1]) return setPicks([c]);
    if (picks.length >= 3) return setErr('You can take 3 at most. Tap one to put it back.');
    setPicks([...picks, c]);
  };
  const isPair = picks.length === 2 && picks[0] === picks[1];
  const takeReady = isPair || (picks.length > 0 && new Set(picks).size === picks.length && picks.length === rules.distinctNeeded);

  // ----- cards and decks -----
  const clickCard = (id, from) => {
    if (!playing) return;
    setPicks([]);
    setErr(null);
    setSel(sel?.kind === 'card' && sel.id === id ? null : { kind: 'card', id, from });
  };
  const clickDeck = (level) => {
    if (!playing || !g.deckCounts[level]) return;
    setPicks([]);
    setErr(null);
    setSel(sel?.kind === 'deck' && sel.level === level ? null : { kind: 'deck', level });
  };

  // ----- returning gems -----
  const mustReturn = myTurn && g.phase === 'discard' ? g.pending.count : 0;
  const markedTotal = sum(marked);
  const clickOwnGem = (c) => {
    if (!mustReturn || busy) return;
    const cur = marked[c] || 0;
    if (cur < me.tokens[c] && markedTotal < mustReturn) setMarked({ ...marked, [c]: cur + 1 });
    else if (cur > 0) setMarked({ ...marked, [c]: cur - 1 });
  };

  const opponents = [];
  for (let k = 1; k < g.players.length; k++) opponents.push((you + k) % g.players.length);
  const onlineOf = (id) => snap.lobby?.seats.find((s) => s.id === id)?.online ?? false;

  return html`<div class="game">
    <header class="topbar">
      <p class="topbar__mark">Trilliant</p>
      <div class="topbar__status" aria-live="polite">
        <${TurnPill} g=${g} myTurn=${myTurn} over=${over} current=${current} timer=${snap.timer} />
      </div>
      <div class="topbar__tools">
        <button type="button" class="btn btn--small btn--danger" onClick=${onLeave}>Leave game</button>
      </div>
    </header>

    <div class="main">
      <section class="board" aria-label="Board"><div class="board__in">
        <div class="nobles" aria-label="Nobles">
          ${g.nobles.map((id) => html`<${Noble} id=${id} />`)}
        </div>
        <div class="rows">
          ${[3, 2, 1].map((level) => html`<div class="row">
            <${Deck} level=${level} count=${g.deckCounts[level]}
              onClick=${playing && g.deckCounts[level] && me.reserved.length < MAX_RESERVED ? () => clickDeck(level) : undefined}
              selected=${sel?.kind === 'deck' && sel.level === level} />
            ${g.board[level].map((id, i) => (id === null
              ? html`<div class="slot" aria-label="Empty"></div>`
              : html`<${Card} id=${id}
                  onClick=${playing ? () => clickCard(id, 'board') : undefined}
                  selected=${sel?.kind === 'card' && sel.id === id}
                  buyable=${myTurn && g.phase === 'play' && affordable(id)}
                  covered=${myTurn ? bonuses : undefined}
                  isNew=${fx.dealt.has(`${level}-${i}`)}
                  flash=${fx.slots.has(`${level}-${i}`)} />`))}
          </div>`)}
        </div>
        <div class="bank" aria-label="Bank">
          ${['gold', ...COLORS].map((c) => html`<${Well} color=${c} count=${g.bank[c]}
            onClick=${playing && c !== 'gold' && (g.bank[c] > 0 || picks.includes(c)) ? () => clickWell(c) : undefined}
            picked=${picks.filter((x) => x === c).length}
            flash=${fx.bank.has(c)} />`)}
        </div>
      </div></section>

      <${Tray} ...${{ g, me, you, myTurn, over, current, picks, isPair, takeReady, rules, sel, busy, err, fresh, mustReturn, marked, markedTotal, isHost, snap }}
        onTake=${() => send({ type: 'take', gems: picks })}
        onClear=${() => { setPicks([]); setSel(null); setMarked({}); setErr(null); }}
        onBuy=${(id) => send({ type: 'buy', card: id })}
        onReserveCard=${(id) => send({ type: 'reserve', card: id })}
        onReserveDeck=${(level) => send({ type: 'reserve', level })}
        onReturn=${() => send({ type: 'discard', gems: Object.fromEntries(Object.entries(marked).filter(([, n]) => n > 0)) })}
        onPass=${() => send({ type: 'pass' })}
        onResults=${() => setShowResult(true)} />

      <section class="panel seatcard me" aria-label="Your seat">
        <div class="me__main">
          <div class="seatcard__head">
            <span class="dot is-on"></span>
            <span class="seatcard__name">${me.name} <span class="seat__you">(you)</span></span>
            <span class="seatcard__score"><b>${pointsOf(me)}</b><span>/ ${g.target || WIN_POINTS}</span></span>
          </div>
          <${Holdings} player=${me} onGem=${mustReturn ? clickOwnGem : undefined} marked=${mustReturn ? marked : undefined} />
          <div class="holdings__foot">
            <span class=${tokenTotal(me.tokens) >= MAX_TOKENS ? 'is-full' : ''}>Gems <b>${tokenTotal(me.tokens)}</b>/${MAX_TOKENS}</span>
            ${me.nobles.length ? html`<span>Nobles <b>${me.nobles.length}</b></span>` : null}
          </div>
        </div>
        ${me.reserved.length ? html`<div class="me__reserve">
          <span class="reserved__label">Reserved ${me.reserved.length}/${MAX_RESERVED}</span>
          <${Reserved} player=${me} isYou
            onPick=${playing ? (id) => clickCard(id, 'reserve') : undefined}
            selectedId=${sel?.kind === 'card' ? sel.id : null}
            canAfford=${myTurn && g.phase === 'play' ? affordable : undefined} />
        </div>` : null}
      </section>
    </div>

    <aside class="side">
      <div class="opps">
        ${opponents.map((i) => html`<${SeatCard} player=${g.players[i]} view=${g}
          online=${onlineOf(g.players[i].id)} isTurn=${g.turn === i && !over} flash=${fx.seats.has(i)} />`)}
      </div>
      <${Feed} g=${g} chat=${snap.chat} you=${you} selfId=${snap.selfId}
        onSend=${(text) => room.act({ type: 'chat', text }).then((r) => { if (!r.ok) notify(r.error); return r; })} />
    </aside>

    ${myTurn && g.phase === 'noble' ? html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="noble-title">
      <section class="panel sheet notice">
        <h2 class="sheet__title" id="noble-title">Choose a noble</h2>
        <p class="sheet__sub">You qualify for more than one. Pick one (+3 points).</p>
        <div class="choices">${g.pending.options.map((id) => html`<${Noble} id=${id} onClick=${busy ? undefined : () => send({ type: 'noble', noble: id })} />`)}</div>
      </section>
    </div>` : null}

    ${over && showResult ? html`<${Results} g=${g} snap=${snap} room=${room} isHost=${isHost} onClose=${() => setShowResult(false)} />` : null}
  </div>`;
}

function TurnPill({ g, myTurn, over, current, timer }) {
  const left = useSecondsLeft(!over && timer ? timer.deadline : null);
  const warn = left !== null && left <= 30;
  // Flag the tab when it's your turn and you're elsewhere, with the clock if there is one.
  useEffect(() => {
    const base = 'Trilliant';
    const update = () => {
      document.title = myTurn && document.hidden ? `● ${left !== null ? `${clock(left)} · ` : ''}Your turn` : base;
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); document.title = base; };
  }, [myTurn, left]);
  return html`<span class=${cls('turnpill', myTurn && 'is-mine', warn && 'is-warn')}>
    ${over ? 'Game over' : myTurn ? 'Your turn' : `${current.name}’s turn`}
    ${left !== null ? html`<span class="turnpill__clock" title="Time left this turn">${clock(left)}</span>` : null}
    ${g.finalRound && !over ? html`<span class="turnpill__final">Last round</span>` : null}
  </span>`;
}

function PayLine({ pay }) {
  const items = TOKEN_COLORS.filter((c) => pay[c] > 0);
  if (!items.length) return html`<span>Free with your cards.</span>`;
  return html`<span class="pay">Pay ${items.map((c) => html`<span class="pay__item"><${Gem} color=${c} title=${COLOR_NAMES[c]} />${pay[c]}</span>`)}</span>`;
}

function ShortLine({ me, card }) {
  const need = netCost(me, card);
  const short = COLORS.map((c) => [c, Math.max(0, need[c] - me.tokens[c])]).filter(([, n]) => n > 0);
  const total = short.reduce((a, [, n]) => a + n, 0) - me.tokens.gold;
  return html`<span class="pay">You need ${total} more:${short.map(([c, n]) => html`<span class="pay__item"><${Gem} color=${c} title=${COLOR_NAMES[c]} />${n}</span>`)}${me.tokens.gold ? html`<span>(gold covers ${me.tokens.gold})</span>` : null}</span>`;
}

function Tray(p) {
  const { g, me, you, myTurn, over, current, picks, isPair, takeReady, rules, sel, busy, err, fresh, mustReturn, marked, markedTotal } = p;
  let title, hint, extra = null, buttons = null;

  if (over) {
    const names = g.result.winners.map((w) => (w === you ? 'You' : g.players[w].name));
    title = 'Game over';
    hint = names.length > 1 ? `${nameList(names)} tie.` : `${names[0]} ${names[0] === 'You' ? 'win' : 'wins'}.`;
    buttons = html`<button type="button" class="btn btn--primary" onClick=${p.onResults}>See results</button>`;
  } else if (!myTurn) {
    title = g.phase === 'discard' ? `${current.name} is returning gems` : g.phase === 'noble' ? `${current.name} is choosing a noble` : `${current.name}’s turn`;
    const last = [...g.log].reverse().find((e) => ['take', 'reserve', 'buy', 'pass', 'timeout'].includes(e.t));
    hint = last ? html`<${LogItem} e=${last} players=${g.players} you=${you} target=${g.target} tag="span" />` : 'Waiting for their move.';
  } else if (g.phase === 'discard') {
    title = 'Too many gems';
    hint = `You can hold ${MAX_TOKENS}. Tap ${mustReturn} of your gems below to put back.`;
    const picked = [];
    for (const c of TOKEN_COLORS) for (let i = 0; i < (marked[c] || 0); i++) picked.push(c);
    extra = picked.length ? html`<div class="tray__picks">${picked.map((c) => html`<${Gem} color=${c} title=${COLOR_NAMES[c]} />`)}</div>` : null;
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy || markedTotal !== mustReturn} onClick=${p.onReturn}>Put back ${markedTotal}/${mustReturn}</button>
      ${markedTotal ? html`<button type="button" class="btn btn--ghost" onClick=${p.onClear}>Cancel</button>` : null}`;
  } else if (g.phase === 'noble') {
    title = 'Choose a noble';
    hint = 'Pick one of the nobles that qualify.';
  } else if (sel?.kind === 'card') {
    const card = CARDS[sel.id];
    const pay = autoPayment(me, card);
    const canReserve = sel.from === 'board' && me.reserved.length < MAX_RESERVED;
    title = `Level ${ROMAN[card.level]} ${COLOR_NAMES[card.color]}${card.points ? ` · ${card.points} point${card.points > 1 ? 's' : ''}` : ''}`;
    hint = pay ? html`<${PayLine} pay=${pay} />` : html`<${ShortLine} me=${me} card=${card} />`;
    buttons = html`
      <button type="button" class=${cls('btn', pay && 'btn--primary')} disabled=${busy || !pay} onClick=${() => p.onBuy(sel.id)}>Buy</button>
      ${sel.from === 'board' ? html`<button type="button" class=${cls('btn', !pay && 'btn--primary')} disabled=${busy || !canReserve} onClick=${() => p.onReserveCard(sel.id)}
          title=${canReserve ? '' : `You already hold ${MAX_RESERVED}`}>Reserve${g.bank.gold ? ' + 1 gold' : ''}</button>` : null}
      <button type="button" class="btn btn--ghost" onClick=${p.onClear}>Cancel</button>`;
    if (sel.from === 'board' && !canReserve) hint = `You already hold ${MAX_RESERVED} reserved cards.`;
  } else if (sel?.kind === 'deck') {
    title = `Level ${ROMAN[sel.level]} deck`;
    hint = 'Reserve the top card without showing it.';
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy} onClick=${() => p.onReserveDeck(sel.level)}>Reserve top card${g.bank.gold ? ' + 1 gold' : ''}</button>
      <button type="button" class="btn btn--ghost" onClick=${p.onClear}>Cancel</button>`;
  } else if (picks.length) {
    title = 'Take gems';
    extra = html`<div class="tray__picks">${picks.map((c) => html`<${Gem} color=${c} title=${COLOR_NAMES[c]} />`)}</div>`;
    if (isPair) hint = `Two ${COLOR_NAMES[picks[0]]}s.`;
    else if (takeReady) hint = 'Ready.';
    else {
      const left = rules.distinctNeeded - picks.length;
      hint = `Pick ${left} more color${left === 1 ? '' : 's'}${picks.length === 1 && rules.pairable.includes(picks[0]) ? `, or tap ${COLOR_NAMES[picks[0]]} again for two` : ''}.`;
    }
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy || !takeReady} onClick=${p.onTake}>Take gems</button>
      <button type="button" class="btn btn--ghost" onClick=${p.onClear}>Cancel</button>`;
  } else {
    title = 'Your turn';
    hint = 'Take gems from the bank, or tap a card to buy or reserve it.';
    if (!hasMainAction(g, you)) {
      hint = 'You have no legal move this turn.';
      buttons = html`<button type="button" class="btn btn--primary" disabled=${busy} onClick=${p.onPass}>Pass</button>`;
    }
  }

  return html`<section class=${cls('tray', myTurn && 'is-mine', fresh && 'is-fresh')} aria-live="polite">
    <div class="tray__text">
      <div class="tray__title">${title}</div>
      ${err ? html`<div class="tray__hint is-error">${err}</div>` : hint ? html`<div class="tray__hint">${hint}</div>` : null}
    </div>
    ${extra}
    ${busy && myTurn ? html`<span class="tray__hint">Sending…</span>` : null}
    ${buttons ? html`<div class="tray__buttons">${buttons}</div>` : null}
  </section>`;
}

function Feed({ g, chat, you, selfId, onSend }) {
  const [tab, setTab] = useState('log');
  const [text, setText] = useState('');
  const [seenChat, setSeenChat] = useState(() => chat.at(-1)?.id);
  const body = useRef(null);
  const lastChat = chat.at(-1)?.id;

  useEffect(() => { if (tab === 'chat') setSeenChat(lastChat); }, [tab, lastChat]);
  useEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight; }, [tab, g.log.length, chat.length]);

  const seenIndex = chat.findIndex((m) => m.id === seenChat);
  const unread = chat.slice(seenIndex + 1).filter((m) => m.from && m.from !== selfId).length;
  const submit = async (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    const r = await onSend(t);
    if (r && !r.ok) setText(t);
  };

  return html`<section class="panel feed" aria-label="Moves and chat">
    <div class="feed__tabs" role="tablist">
      <button type="button" role="tab" aria-selected=${tab === 'log'} class=${cls('feed__tab', tab === 'log' && 'is-on')} onClick=${() => setTab('log')}>Moves</button>
      <button type="button" role="tab" aria-selected=${tab === 'chat'} class=${cls('feed__tab', tab === 'chat' && 'is-on')} onClick=${() => setTab('chat')}>
        Chat${unread && tab !== 'chat' ? html`<span class="badge">${unread}</span>` : null}
      </button>
    </div>
    <div class="feed__body" ref=${body}>
      ${tab === 'log'
        ? html`<ul class="log">${g.log.map((e) => html`<${LogItem} e=${e} players=${g.players} you=${you} target=${g.target} />`)}</ul>`
        : chat.length
          ? html`<ul class="chat">${chat.map((m) => (m.from
            ? html`<li class="chat__msg"><strong>${m.from === selfId ? 'You' : m.name}</strong><span>${m.text}</span></li>`
            : html`<li class="chat__msg is-system">${m.text}</li>`))}</ul>`
          : html`<p class="empty">No messages yet.</p>`}
    </div>
    ${tab === 'chat' ? html`<form class="chat__form" onSubmit=${submit}>
      <input class="field" aria-label="Message" placeholder="Message" maxlength=${CHAT_MAX} value=${text} onInput=${(e) => setText(e.currentTarget.value)} />
      <button class="btn btn--small" type="submit" disabled=${!text.trim()}>Send</button>
    </form>` : null}
  </section>`;
}

function Results({ g, snap, room, isHost, onClose }) {
  const { ranking, winners } = g.result;
  const names = winners.map((w) => (w === g.you ? 'You' : g.players[w].name));
  const headline = names.length > 1 ? `${nameList(names)} tie` : `${names[0]} ${names[0] === 'You' ? 'win' : 'wins'}`;
  const hostName = snap.lobby?.seats.find((s) => s.host)?.name || 'The host';
  let place = 0;
  let prevKey = null;
  return html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="result-title">
    <section class="panel sheet">
      <h2 class="sheet__title" id="result-title">${headline}</h2>
      ${ranking[1] && ranking[0].points === ranking[1].points ? html`<p class="sheet__sub">Tied on points, so whoever bought fewer cards wins.</p>` : null}
      <ol class="results">
        ${ranking.map((r, i) => {
          const key = `${r.points}-${r.cards}`;
          if (key !== prevKey) { place = i + 1; prevKey = key; }
          const pl = g.players[r.p];
          return html`<li class=${cls('result', winners.includes(r.p) && 'is-winner')}>
            <span class="result__place">${place}</span>
            <span><span class="result__name">${r.p === g.you ? `${pl.name} (you)` : pl.name}</span><br />
              <span class="result__meta">${r.cards} card${r.cards === 1 ? '' : 's'} · ${pl.nobles.length} noble${pl.nobles.length === 1 ? '' : 's'}</span></span>
            <span class="result__pts">${r.points}</span>
          </li>`;
        })}
      </ol>
      ${Object.keys(snap.tally || {}).length ? html`<p class="tally">Wins so far: ${g.players.map((pl, i) => html`${i ? ' · ' : ''}<b>${pl.name}</b> ${snap.tally[pl.id] || 0}`)}</p>` : null}
      <div class="sheet__actions">
        <button type="button" class="btn btn--ghost" onClick=${onClose}>Close</button>
        ${isHost
          ? html`<button type="button" class="btn" onClick=${() => room.backToLobby()}>Back to lobby</button>
                 <button type="button" class="btn btn--primary" onClick=${() => room.startGame()}>Play again</button>`
          : html`<button type="button" class="btn" disabled>Waiting for ${hostName} to play again</button>`}
      </div>
    </section>
  </div>`;
}
