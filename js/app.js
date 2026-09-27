import { html, render, useState, useEffect, useRef, useCallback, useErrorBoundary } from '../vendor/preact-htm.js';
import { injectSprite } from './ui/gems.js';
import { Home, Lobby, Game, Notice, Connecting } from './ui/screens.js';
import { roomFromSecret, newRoomSecret } from './net/crypto.js';
import { HostRoom, GuestRoom, cleanName } from './net/room.js';
import {
  browserStorage, resolveIdentity, holdIdentity, loadHostRecord, listTables, rememberTable, forgetTable, sweepStorage, loadName, saveName,
} from './net/identity.js';

const storage = browserStorage();

const ADJECTIVES = ['Lucky', 'Sly', 'Gilded', 'Quiet', 'Bold', 'Clever', 'Rogue', 'Polished', 'Shrewd', 'Velvet', 'Midnight', 'Brisk', 'Dapper', 'Canny', 'Nimble'];
const NOUNS = ['Magpie', 'Jeweler', 'Prospector', 'Merchant', 'Cutter', 'Miner', 'Baron', 'Duchess', 'Smuggler', 'Trader', 'Banker', 'Collector', 'Courier', 'Setter'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
function defaultName() {
  let n = loadName(storage);
  if (!n) {
    n = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    saveName(storage, n);
  }
  return n;
}

// Invite links look like  …/#<22-char room secret>.<12-char host id>
function parseHash() {
  const m = /^#?([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{12})$/.exec(location.hash);
  return m ? { secret: m[1], hostId: m[2] } : null;
}

function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const notify = useCallback((text) => {
    clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  return [toast, notify];
}

// If a bad message ever breaks rendering, say so instead of going blank.
function Fence({ children }) {
  const [error] = useErrorBoundary();
  if (error) {
    return html`<${Notice} title="Something broke on this page"
      actions=${html`<button class="btn btn--primary" onClick=${() => location.reload()}>Reload</button>`}>
      Reloading picks the game back up where it was.</${Notice}>`;
  }
  return children;
}

// ======================================================================

function App() {
  const [route, setRoute] = useState(parseHash);
  const [bad, setBad] = useState(() => location.hash.length > 1 && !parseHash());
  const [toast, notify] = useToast();

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); setBad(location.hash.length > 1 && !parseHash()); };
    addEventListener('hashchange', onHash);
    // Coming back from the back/forward cache leaves sockets dead: reload clean.
    const onShow = (e) => { if (e.persisted) location.reload(); };
    addEventListener('pageshow', onShow);
    return () => { removeEventListener('hashchange', onHash); removeEventListener('pageshow', onShow); };
  }, []);

  let screen;
  if (bad) {
    screen = html`<${Notice} title="That link doesn’t work"
      actions=${html`<a class="btn btn--primary" href="./#">Back to start</a>`}>
      It looks cut off. Ask for the link again, or create your own game.</${Notice}>`;
  } else if (route) {
    screen = html`<${RoomScreen} key=${route.secret + route.hostId} ...${route} notify=${notify} />`;
  } else {
    screen = html`<${HomeScreen} notify=${notify} />`;
  }
  return html`<${Fence}>${screen}</${Fence}>${toast ? html`<div class="toast" role="status">${toast}</div>` : null}`;
}

// ======================================================================

function HomeScreen({ notify }) {
  const [name, setName] = useState(defaultName);
  const [tables, setTables] = useState(() => { sweepStorage(storage); return listTables(storage); });
  const [busy, setBusy] = useState(false);

  const onName = (v) => { setName(v); if (v.trim()) saveName(storage, cleanName(v)); };
  // `replacing` is the game this browser already hosts: creating a new one ends it.
  const onCreate = async (replacing) => {
    setBusy(true);
    try {
      if (replacing) forgetTable(storage, replacing.roomId);
      saveName(storage, cleanName(name));
      const secret = newRoomSecret();
      const room = await roomFromSecret(secret);
      const { identity } = await resolveIdentity(storage, room.id);
      location.hash = `${secret}.${identity.id}`;
    } catch {
      notify('Couldn’t create a game in this browser.');
      setBusy(false);
    }
  };
  const onResume = (t) => { location.hash = `${t.secret}.${t.hostId}`; };
  const onForget = (t) => { forgetTable(storage, t.roomId); setTables(listTables(storage)); };

  useEffect(() => { document.title = 'Trilliant · gem trading for 2–4 players'; }, []);
  return html`<${Home} name=${name} onName=${onName} onCreate=${onCreate} tables=${tables} onResume=${onResume} onForget=${onForget} busy=${busy} />`;
}

// ======================================================================

function RoomScreen({ secret, hostId, notify }) {
  const [phase, setPhase] = useState('connecting'); // connecting | conflict | ready | broken
  const [snap, setSnap] = useState(null);
  const [forceNew, setForceNew] = useState(false);
  const [waited, setWaited] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [name, setName] = useState(defaultName);
  const roomRef = useRef(null);

  useEffect(() => {
    let dead = false;
    let release = null;
    let unsub = null;
    let room = null;
    let titleKey = '';
    setWaited(false);
    (async () => {
      let r;
      try { r = await roomFromSecret(secret); } catch { setPhase('broken'); return; }
      const res = await resolveIdentity(storage, r.id, { forceNew });
      if (dead) return;
      if (res.conflict) { setPhase('conflict'); return; }
      const { identity } = res;
      const myName = defaultName();
      room = identity.id === hostId
        ? new HostRoom({ room: r, secret, identity, name: myName, record: loadHostRecord(storage, r.id), storage })
        : new GuestRoom({ room: r, hostId, identity, name: myName });
      roomRef.current = room;
      release = holdIdentity(storage, r.id, identity.id);
      const refresh = () => {
        const s = room.snapshot();
        setSnap(s);
        // Keep "Your games" on the start page labelled with who is playing.
        const seats = s.lobby?.seats || [];
        const others = seats.filter((x) => x.id !== s.selfId).map((x) => x.name);
        const hostName = seats.find((x) => x.host)?.name;
        const title = s.role === 'host'
          ? (others.length ? `Your game with ${others.join(', ')}` : 'Your game')
          : (hostName ? `${hostName}’s game` : '');
        if (title !== titleKey) {
          titleKey = title;
          rememberTable(storage, { roomId: r.id, secret, hostId, role: room.role, title, players: others.length });
        }
      };
      unsub = room.subscribe(refresh);
      room.start();
      refresh();
      setPhase('ready');
    })();

    const wake = () => { if (document.visibilityState === 'visible') roomRef.current?.wake(); };
    const bye = () => roomRef.current?.stop();
    const timer = setTimeout(() => setWaited(true), 7000);
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    addEventListener('pagehide', bye);
    return () => {
      dead = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('online', wake);
      removeEventListener('pagehide', bye);
      unsub?.();
      release?.();
      room?.stop();
      roomRef.current = null;
    };
  }, [secret, hostId, forceNew]);

  const room = roomRef.current;
  const goHome = () => { location.hash = ''; };
  const onLeave = () => setConfirmLeave(true);
  // A guest leaving the lobby gives the seat back; mid-game the seat is kept
  // so they can rejoin, since the game can't go on without them.
  const leaveNow = async () => {
    if (snap?.role === 'guest' && snap.lobby?.status === 'lobby') await room?.leaveSeat();
    goHome();
  };
  const onRename = (v) => {
    const clean = cleanName(v);
    saveName(storage, clean);
    setName(clean);
    room?.setName(clean);
  };

  if (phase === 'broken') {
    return html`<${Notice} title="That link doesn’t work" actions=${html`<button class="btn btn--primary" onClick=${goHome}>Back to start</button>`}>
      It looks damaged. Ask for the link again.</${Notice}>`;
  }
  if (phase === 'conflict') {
    return html`<${Notice} title="This game is open in another tab"
      actions=${html`<button class="btn" onClick=${goHome}>Back to start</button>
        <button class="btn btn--primary" onClick=${() => { setPhase('connecting'); setForceNew(true); }}>Join as another player</button>`}>
      Keep playing in that tab, or join from this one as a separate player.</${Notice}>`;
  }
  if (phase !== 'ready' || !snap || !room) return html`<${Connecting} snap=${snap} waited=${waited} />`;

  let screen;
  const lobby = snap.lobby;
  if (!snap.synced || !lobby) {
    screen = html`<${Connecting} snap=${snap} waited=${waited} />`;
  } else if (snap.seated && snap.game && lobby.status !== 'lobby') {
    screen = html`<${Game} snap=${snap} room=${room} onLeave=${onLeave} notify=${notify} />`;
  } else if (lobby.status === 'lobby' && snap.seated) {
    screen = html`<${Lobby} snap=${snap} room=${room} name=${name} onRename=${onRename} onLeave=${onLeave} notify=${notify} />`;
  } else if (lobby.status === 'lobby' && lobby.seats.length >= lobby.max) {
    screen = html`<${Notice} title="This game is full" actions=${html`<button class="btn btn--primary" onClick=${goHome}>Back to start</button>`}>
      All ${lobby.max} seats are taken. Keep this page open to grab one if it frees up, or create your own game.</${Notice}>`;
  } else if (lobby.status === 'lobby' && waited) {
    screen = html`<${Notice} title="You can’t join this game" actions=${html`<button class="btn btn--primary" onClick=${goHome}>Back to start</button>`}>
      The host may have removed you. Ask them about it, or create your own game.</${Notice}>`;
  } else if (lobby.status === 'lobby') {
    screen = html`<${Connecting} snap=${snap} waited=${false} />`;
  } else {
    const hostName = lobby.seats.find((s) => s.host)?.name || 'The host';
    screen = html`<${Notice} title="This game already started" actions=${html`<button class="btn btn--primary" onClick=${goHome}>Back to start</button>`}>
      Keep this page open and you’ll get a seat for the next one.</${Notice}>`;
  }

  const hostName = lobby?.seats.find((s) => s.host)?.name || 'The host';
  return html`
    ${screen}
    ${snap.role === 'guest' && snap.synced && !snap.hostOnline ? html`<div class="banner" role="status">${hostName} is offline. The game continues when they’re back.</div>` : null}
    ${snap.link && !snap.link.up && snap.synced ? html`<div class="banner" role="status">Connection lost. Reconnecting…</div>` : null}
    ${confirmLeave ? html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="leave-title">
      <section class="panel sheet notice">
        <h2 class="sheet__title" id="leave-title">Leave the game?</h2>
        <p class="sheet__sub">${snap.role === 'host'
          ? 'Everyone waits until you come back. You can reopen it from “Your games” on the start page.'
          : lobby?.status === 'lobby'
            ? 'You’ll give up your seat. The same link lets you rejoin.'
            : 'The game waits for you. Open the same link to jump back in.'}</p>
        <div class="sheet__actions">
          <button class="btn" onClick=${() => setConfirmLeave(false)}>Stay</button>
          <button class="btn btn--danger-solid" onClick=${leaveNow}>Leave</button>
        </div>
      </section>
    </div>` : null}`;
}

// ======================================================================

injectSprite();
render(html`<${App} />`, document.getElementById('app'));
