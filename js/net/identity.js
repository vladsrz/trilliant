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
  writeJSON(storage.session, tabKey, identity.stored);
  if (!shared) writeJSON(storage.local, localKey, identity.stored);
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

export function rememberTable(storage, entry) {
  const list = listTables(storage).filter((t) => t.roomId !== entry.roomId);
  list.unshift({ ...entry, at: Date.now() });
  writeJSON(storage.local, 'trilliant:tables', list.slice(0, 8));
}

export function forgetTable(storage, roomId) {
  writeJSON(storage.local, 'trilliant:tables', listTables(storage).filter((t) => t.roomId !== roomId));
  for (const k of [`trilliant:room:${roomId}`, `trilliant:id:${roomId}`]) storage.local.removeItem(k);
}

export const loadName = (storage) => {
  const n = storage.local.getItem('trilliant:name');
  return typeof n === 'string' ? n : '';
};
export const saveName = (storage, name) => storage.local.setItem('trilliant:name', name);
