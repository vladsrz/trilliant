// Which identity this tab plays as, and the small amount of browser storage the
// app keeps. Storage is injected so the same code runs in tests.

import { createIdentity, loadIdentity, randomId } from './crypto.js';
import { every } from './ticker.js';

const TAB_TOKEN = randomId(6);
const LIVE_MS = 5000;

function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function safe(store) {
  try {
    const probe = '__trilliant_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return memoryStore();
  }
}

export function browserStorage() {
  return {
    local: safe(globalThis.localStorage ?? memoryStore()),
    session: safe(globalThis.sessionStorage ?? memoryStore()),
  };
}

export const testStorage = () => ({ local: memoryStore(), session: memoryStore() });

function readJSON(store, key) {
  try { return JSON.parse(store.getItem(key)); } catch { return null; }
}
const writeJSON = (store, key, value) => {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
};

// ---------- identity per room ----------

function isLiveElsewhere(storage, roomId, id) {
  const rec = readJSON(storage.local, `trilliant:live:${roomId}`);
  return !!rec && rec.id === id && rec.tab !== TAB_TOKEN && Date.now() - rec.at < LIVE_MS;
}

// Returns { identity } or { conflict: true } when this browser's identity for
// the room is already in use by another open tab.
export async function resolveIdentity(storage, roomId, { forceNew = false } = {}) {
  const tabKey = `trilliant:tab:${roomId}`;
  const localKey = `trilliant:id:${roomId}`;
  const mine = readJSON(storage.session, tabKey);
  if (mine && !forceNew) return { identity: await loadIdentity(mine) };
  const shared = readJSON(storage.local, localKey);
  if (shared && !forceNew) {
    const identity = await loadIdentity(shared);
    if (isLiveElsewhere(storage, roomId, identity.id)) return { conflict: true };
    writeJSON(storage.session, tabKey, shared);
    return { identity };
  }
  const identity = await createIdentity();
  const stored = { ...identity.stored, at: Date.now() };
  writeJSON(storage.session, tabKey, stored);
  if (!shared) writeJSON(storage.local, localKey, stored);
  return { identity };
}

// Keep a heartbeat so a second tab can tell the identity is taken.
export function holdIdentity(storage, roomId, id) {
  const beat = () => writeJSON(storage.local, `trilliant:live:${roomId}`, { id, tab: TAB_TOKEN, at: Date.now() });
  beat();
  const stop = every(2000, beat);
  return () => {
    stop();
    const rec = readJSON(storage.local, `trilliant:live:${roomId}`);
    if (rec && rec.tab === TAB_TOKEN) storage.local.removeItem(`trilliant:live:${roomId}`);
  };
}

// ---------- host records and recent tables ----------

export const loadHostRecord = (storage, roomId) => readJSON(storage.local, `trilliant:room:${roomId}`);
export const saveHostRecord = (storage, roomId, record) => writeJSON(storage.local, `trilliant:room:${roomId}`, record);

export function listTables(storage) {
  const list = readJSON(storage.local, 'trilliant:tables');
  return Array.isArray(list) ? list : [];
}

function dropGame(storage, roomId) {
  for (const k of [`trilliant:room:${roomId}`, `trilliant:id:${roomId}`, `trilliant:live:${roomId}`]) storage.local.removeItem(k);
}

// One game you host and one game you joined, at most. Anything pushed out is
// deleted along with its saved state, so nothing piles up in the browser.
export function rememberTable(storage, entry) {
  const list = [{ ...entry, at: Date.now() }, ...listTables(storage).filter((t) => t.roomId !== entry.roomId)];
  const keep = [];
  const roles = new Set();
  for (const t of list) {
    if (roles.has(t.role)) dropGame(storage, t.roomId);
    else { roles.add(t.role); keep.push(t); }
  }
  writeJSON(storage.local, 'trilliant:tables', keep);
}

export function hostedTable(storage) {
  return listTables(storage).find((t) => t.role === 'host') || null;
}

export function forgetTable(storage, roomId) {
  writeJSON(storage.local, 'trilliant:tables', listTables(storage).filter((t) => t.roomId !== roomId));
  dropGame(storage, roomId);
}

// Saved games that aren't on the list any more (older versions kept up to
// eight). Only runs from the start page, and skips anything touched in the
// last hour so a game being opened in another tab is never caught.
export function sweepStorage(storage, now = Date.now()) {
  const store = storage.local;
  if (typeof store.length !== 'number' || typeof store.key !== 'function') return 0;
  const listed = new Set(listTables(storage).map((t) => t.roomId));
  const doomed = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    const m = /^trilliant:(room|id|live):(.+)$/.exec(key || '');
    if (!m || listed.has(m[2])) continue;
    const rec = readJSON(store, key);
    const at = rec?.createdAt || rec?.at || 0;
    if (now - at > 3600 * 1000) doomed.push(key);
  }
  for (const key of doomed) store.removeItem(key);
  return doomed.length;
}

export const loadName = (storage) => {
  const n = storage.local.getItem('trilliant:name');
  return typeof n === 'string' ? n : '';
};
export const saveName = (storage, name) => storage.local.setItem('trilliant:name', name);
