import { html, useState, useEffect, useRef, useMemo } from '../../vendor/preact-htm.js';
import { CARDS, COLORS, TOKEN_COLORS } from '../data.js';
import {
  COLOR_NAMES, autoPayment, netCost, bonusesOf, pointsOf, tokenTotal, takeRules, hasMainAction,
  MAX_TOKENS, MAX_RESERVED, WIN_POINTS,
} from '../engine.js';
import { Gem, Card, Deck, Noble, Well, Holdings, Reserved, SeatCard, LogItem, cls, ROMAN, describeCard } from './parts.js';
import { NAME_MAX, CHAT_MAX } from '../net/room.js';

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
  const submit = (e) => { e.preventDefault(); onCreate(); };
  return html`<main class="home">
    <div class="home__inner">
      <div class="home__gems" aria-hidden="true">
        ${['white', 'blue', 'green', 'red', 'black', 'gold'].map((c) => html`<${Gem} color=${c} />`)}
      </div>
      <h1 class="home__mark">Trilliant</h1>
      <p class="home__lede">Trade gems, buy cards, win nobles. First to ${WIN_POINTS} points wins. Open a table and send the link to a friend.</p>
      <form class="panel home__form" onSubmit=${submit}>
        <div>
          <label class="label" for="name">Your name</label>
          <div class="home__row">
            <input id="name" class="field" value=${name} maxlength=${NAME_MAX} autocomplete="nickname"
              onInput=${(e) => onName(e.currentTarget.value)} />
            <button class="btn btn--primary" type="submit" disabled=${busy}>${busy ? 'Opening…' : 'Open a table'}</button>
          </div>
        </div>
        ${tables.length ? html`<div class="tables">
          <h2 class="tables__title">Your tables</h2>
          ${tables.map((t) => html`<div class="tables__row">
            <div class="tables__what">
              <strong>${t.title || (t.role === 'host' ? 'Your table' : 'A friend’s table')}</strong>
              <span>${t.role === 'host' ? 'You host' : 'Guest'} · ${ago(t.at)}</span>
            </div>
            <button type="button" class="btn btn--small" onClick=${() => onResume(t)}>Open</button>
            <button type="button" class="btn btn--small btn--ghost" aria-label="Remove from list" onClick=${() => onForget(t)}>✕</button>
          </div>`)}
        </div>` : null}
      </form>
      <p class="home__small">Plays by the rules of Splendor. Fan-made and free, not affiliated with Space Cowboys or Asmodee.<br />No sign-up: the table runs in the host’s browser and moves travel encrypted.</p>
    </div>
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
  const relays = snap?.link;
  let line = 'Connecting to the relays…';
  if (relays?.up) line = snap.role === 'guest' && !snap.hostOnline ? 'Looking for the host…' : 'Joining the table…';
  return html`<main class="stage"><section class="panel sheet notice" aria-live="polite">
    <div class="spinner"><${Gem} color="green" /></div>
    <h1 class="sheet__title">${snap?.role === 'guest' ? 'Joining the table' : 'Opening the table'}</h1>
    <p class="sheet__sub">${line}</p>
    ${waited && snap?.role === 'guest' && !snap.hostOnline
      ? html`<p class="sheet__sub">The host’s browser runs this table, so their tab needs to be open. It will connect by itself when they’re back.</p>`
      : null}
    ${waited && relays && !relays.up
      ? html`<p class="sheet__sub">Can’t reach any relay. Check your connection, or try another network.</p>`
      : null}
  </section></main>`;
}

// ======================================================================
// Lobby
// ======================================================================

export function Lobby({ snap, room, name, onRename, onLeave, notify }) {
  const lobby = snap.lobby;
  const isHost = snap.role === 'host';
  const hostSeat = lobby.seats.find((s) => s.host);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const link = location.href;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); notify('Invite link copied.'); } catch { notify('Copy the link from the address bar.'); }
  };
  const seats = [...lobby.seats];
  while (seats.length < lobby.max) seats.push(null);
  const canStart = lobby.seats.length >= 2;
  const saveName = (e) => { e.preventDefault(); onRename(draft); };

  return html`<main class="stage">
    <section class="panel sheet">
      <h1 class="sheet__title">${isHost ? 'Your table' : `${hostSeat?.name || 'Host'}’s table`}</h1>
      <p class="sheet__sub">${isHost
        ? 'Send this link to the people you’re playing with. Keep this tab open while you play: your browser runs the table.'
        : snap.seated ? `You’re in. ${hostSeat?.name || 'The host'} starts the game when everyone’s here.` : 'You left your seat.'}</p>

      <div class="invite">
        <span class="invite__link" title=${link}>${link}</span>
        <button type="button" class="btn" onClick=${copy}>Copy invite link</button>
      </div>

      <ul class="seats">
        ${seats.map((s) => s ? html`<li class="seat">
            <span class=${cls('dot', s.online && 'is-on')} title=${s.online ? 'Online' : 'Offline'}></span>
            <span class="seat__name">${s.name}${s.id === snap.selfId ? ' (you)' : ''}</span>
            ${snap.tally?.[s.id] ? html`<span class="seat__wins" title="Wins at this table">${snap.tally[s.id]}</span>` : null}
            ${s.host ? html`<span class="seat__tag">Host</span>` : null}
            ${isHost && !s.host ? html`<button type="button" class="btn btn--small btn--ghost" onClick=${() => room.removeSeat(s.id)}>Remove</button>` : null}
          </li>`
          : html`<li class="seat seat--empty"><span class="dot"></span><span class="seat__name">Open seat</span></li>`)}
      </ul>

      ${snap.seated ? html`<form class="rename" onSubmit=${saveName}>
        <input class="field" aria-label="Your name" value=${draft} maxlength=${NAME_MAX} onInput=${(e) => setDraft(e.currentTarget.value)} />
        <button class="btn btn--small" type="submit" disabled=${!draft.trim() || draft.trim() === name}>Rename</button>
      </form>` : null}

      <div class="sheet__actions">
        <button type="button" class="btn btn--ghost" onClick=${onLeave}>Leave table</button>
        ${!isHost && snap.seated ? html`<button type="button" class="btn" onClick=${() => room.leaveSeat()}>Stand up</button>` : null}
        ${!isHost && !snap.seated ? html`<button type="button" class="btn btn--primary" onClick=${() => room.takeSeat()}>Take a seat</button>` : null}
        ${isHost ? html`<button type="button" class="btn btn--primary" disabled=${!canStart} onClick=${() => { const r = room.startGame(); if (!r.ok) notify(r.error); }}>
          ${canStart ? 'Start game' : 'Waiting for a player…'}</button>` : null}
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
    const lastMove = [...g.log].reverse().find((e) => ['take', 'reserve', 'buy', 'discard', 'noble', 'pass'].includes(e.t));
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

  // Your-turn cue: pulse the tray, and flag the tab title when you're elsewhere.
  useEffect(() => {
    if (!myTurn) { setFresh(false); return undefined; }
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 1500);
    return () => clearTimeout(t);
  }, [myTurn, g.turn, g.round]);
  useEffect(() => {
    const base = 'Trilliant';
    const update = () => { document.title = myTurn && document.hidden ? '● Your turn · Trilliant' : base; };
    update();
    document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); document.title = base; };
  }, [myTurn]);
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
    if (picks.length >= 3) return setErr('That’s three already. Take them, or tap one to put it back.');
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
        <span class=${cls('turnpill', myTurn && 'is-mine')}>
          ${over ? 'Game over' : myTurn ? 'Your turn' : `${current.name}’s turn`}
          ${g.finalRound && !over ? html`<span class="turnpill__final">Last round</span>` : null}
          ${!over ? html`<span class="turnpill__round">Round ${g.round}</span>` : null}
        </span>
      </div>
      <div class="topbar__tools">
        <${NetState} snap=${snap} />
        <button type="button" class="btn btn--small btn--ghost" onClick=${onLeave}>Leave</button>
      </div>
    </header>

    <div class="main">
      <section class="board" aria-label="Table">
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
      </section>

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
            <span class="seatcard__name">${me.name} <span style="color:var(--text-faint);font-weight:500">(you)</span></span>
            <span class="seatcard__score"><b>${pointsOf(me)}</b><span>/ ${WIN_POINTS}</span></span>
          </div>
          <${Holdings} player=${me} onGem=${mustReturn ? clickOwnGem : undefined} marked=${mustReturn ? marked : undefined} />
          <div class="holdings__foot">
            <span class=${tokenTotal(me.tokens) >= MAX_TOKENS ? 'is-full' : ''}>Gems <b>${tokenTotal(me.tokens)}</b>/${MAX_TOKENS}</span>
            <span>Cards <b>${me.cards.length}</b></span>
            <span>Nobles <b>${me.nobles.length}</b></span>
            ${snap.tally?.[me.id] ? html`<span>Wins <b>${snap.tally[me.id]}</b></span>` : null}
          </div>
        </div>
        <div class="me__reserve">
          <span class="reserved__label">Reserved ${me.reserved.length}/${MAX_RESERVED}</span>
          <${Reserved} player=${me} isYou
            onPick=${playing ? (id) => clickCard(id, 'reserve') : undefined}
            selectedId=${sel?.kind === 'card' ? sel.id : null}
            canAfford=${myTurn && g.phase === 'play' ? affordable : undefined} />
        </div>
      </section>
    </div>

    <aside class="side">
      <div class="opps">
        ${opponents.map((i) => html`<${SeatCard} player=${g.players[i]} index=${i} view=${g}
          online=${onlineOf(g.players[i].id)} isTurn=${g.turn === i && !over} flash=${fx.seats.has(i)} wins=${snap.tally?.[g.players[i].id]} />`)}
      </div>
      <${Feed} g=${g} chat=${snap.chat} you=${you} selfId=${snap.selfId}
        onSend=${(text) => room.act({ type: 'chat', text }).then((r) => { if (!r.ok) notify(r.error); return r; })} />
    </aside>

    ${myTurn && g.phase === 'noble' ? html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="noble-title">
      <section class="panel sheet notice">
        <h2 class="sheet__title" id="noble-title">Two nobles want to visit</h2>
        <p class="sheet__sub">Only one can come this turn. Pick who.</p>
        <div class="choices">${g.pending.options.map((id) => html`<${Noble} id=${id} onClick=${busy ? undefined : () => send({ type: 'noble', noble: id })} />`)}</div>
      </section>
    </div>` : null}

    ${over && showResult ? html`<${Results} g=${g} snap=${snap} room=${room} isHost=${isHost} onClose=${() => setShowResult(false)} />` : null}
  </div>`;
}

function NetState({ snap }) {
  const up = snap.link?.up || 0;
  const ok = up > 0 && (snap.role === 'host' || snap.hostOnline);
  const text = !up ? 'Reconnecting…' : snap.role === 'guest' && !snap.hostOnline ? 'Host offline' : 'Connected';
  return html`<span class="netstate" title=${`${up} of ${snap.link?.total || 3} relays connected`}><span class=${cls('dot', ok && 'is-on')}></span><span>${text}</span></span>`;
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
    const last = [...g.log].reverse().find((e) => ['take', 'reserve', 'buy', 'pass'].includes(e.t));
    hint = last ? html`<${LogItem} e=${last} players=${g.players} you=${you} tag="span" />` : 'Waiting for their move.';
  } else if (g.phase === 'discard') {
    title = `Put back ${mustReturn} gem${mustReturn === 1 ? '' : 's'}`;
    hint = `You can hold ${MAX_TOKENS}. Tap your gems below to choose which go back.`;
    const picked = [];
    for (const c of TOKEN_COLORS) for (let i = 0; i < (marked[c] || 0); i++) picked.push(c);
    extra = picked.length ? html`<div class="tray__picks">${picked.map((c) => html`<${Gem} color=${c} title=${COLOR_NAMES[c]} />`)}</div>` : null;
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy || markedTotal !== mustReturn} onClick=${p.onReturn}>Put back ${markedTotal}/${mustReturn}</button>
      ${markedTotal ? html`<button type="button" class="btn" onClick=${p.onClear}>Clear</button>` : null}`;
  } else if (g.phase === 'noble') {
    title = 'Choose a noble';
    hint = 'Two nobles qualify. Pick one.';
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
    hint = 'Reserve the top card without showing it to anyone.';
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy} onClick=${() => p.onReserveDeck(sel.level)}>Reserve top card${g.bank.gold ? ' + 1 gold' : ''}</button>
      <button type="button" class="btn btn--ghost" onClick=${p.onClear}>Cancel</button>`;
  } else if (picks.length) {
    title = 'Take gems';
    extra = html`<div class="tray__picks">${picks.map((c) => html`<${Gem} color=${c} title=${COLOR_NAMES[c]} />`)}</div>`;
    if (isPair) hint = `Two ${COLOR_NAMES[picks[0]]}s.`;
    else if (takeReady) hint = picks.length === 1 && rules.pairable.includes(picks[0]) ? `Or tap it again to take two.` : 'Ready.';
    else {
      const left = rules.distinctNeeded - picks.length;
      hint = `Pick ${left} more colour${left === 1 ? '' : 's'}${picks.length === 1 && rules.pairable.includes(picks[0]) ? `, or tap ${COLOR_NAMES[picks[0]]} again to take two` : ''}.`;
    }
    buttons = html`
      <button type="button" class="btn btn--primary" disabled=${busy || !takeReady} onClick=${p.onTake}>Take gems</button>
      <button type="button" class="btn btn--ghost" onClick=${p.onClear}>Clear</button>`;
  } else {
    title = 'Your turn';
    hint = 'Tap gems in the bank to take 3 different or 2 of one colour, or tap a card to buy or reserve it.';
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
        ? html`<ul class="log">${g.log.map((e) => html`<${LogItem} e=${e} players=${g.players} you=${you} />`)}</ul>`
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
      <p class="sheet__sub">${g.players.length === 2 ? 'Final score' : 'Final standings'} after ${g.round} round${g.round === 1 ? '' : 's'}.${ranking[1] && ranking[0].points === ranking[1].points ? ' Tied on points, so fewer cards bought wins.' : ''}</p>
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
      ${Object.keys(snap.tally || {}).length ? html`<p class="tally">Wins at this table: ${g.players.map((pl, i) => html`${i ? ' · ' : ''}<b>${pl.name}</b> ${snap.tally[pl.id] || 0}`)}</p>` : null}
      <div class="sheet__actions">
        <button type="button" class="btn btn--ghost" onClick=${onClose}>See the board</button>
        ${isHost
          ? html`<button type="button" class="btn" onClick=${() => room.backToLobby()}>Back to lobby</button>
                 <button type="button" class="btn btn--primary" onClick=${() => room.startGame()}>Rematch</button>`
          : html`<span class="tray__hint">${hostName} can start a rematch.</span>`}
      </div>
    </section>
  </div>`;
}
