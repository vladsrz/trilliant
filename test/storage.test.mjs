import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testStorage, rememberTable, listTables, hostedTable, forgetTable, sweepStorage, saveHostRecord, resolveIdentity } from '../js/net/identity.js';

const seed = (st, roomId, extra = {}) => {
  saveHostRecord(st, roomId, { createdAt: Date.now() - 2 * 3600 * 1000, ...extra });
  st.local.setItem(`trilliant:id:${roomId}`, JSON.stringify({ jwk: {}, pub: 'x', at: Date.now() - 2 * 3600 * 1000 }));
};

test('one hosted game at a time: a new one pushes the old one out, data and all', () => {
  const st = testStorage();
  seed(st, 'A');
  rememberTable(st, { roomId: 'A', role: 'host', title: 'Your game', players: 0 });
  seed(st, 'B');
  rememberTable(st, { roomId: 'B', role: 'host', title: 'Your game', players: 0 });
  assert.deepEqual(listTables(st).map((t) => t.roomId), ['B']);
  assert.equal(st.local.getItem('trilliant:room:A'), null);
  assert.equal(st.local.getItem('trilliant:id:A'), null);
  assert.equal(hostedTable(st).roomId, 'B');
});

test('joining a friend keeps your hosted game; only the latest joined game is kept', () => {
  const st = testStorage();
  rememberTable(st, { roomId: 'H', role: 'host', title: 'Your game with Sam', players: 1 });
  rememberTable(st, { roomId: 'J1', role: 'guest', title: 'Sam’s game' });
  rememberTable(st, { roomId: 'J2', role: 'guest', title: 'Ana’s game' });
  const ids = listTables(st).map((t) => t.roomId).sort();
  assert.deepEqual(ids, ['H', 'J2']);
  // Reopening the hosted game moves it to the front without losing anything.
  rememberTable(st, { roomId: 'H', role: 'host', title: 'Your game with Sam', players: 1 });
  assert.equal(listTables(st).length, 2);
});

test('forgetting a game deletes its save', () => {
  const st = testStorage();
  seed(st, 'A');
  rememberTable(st, { roomId: 'A', role: 'host', title: 'Your game' });
  forgetTable(st, 'A');
  assert.equal(listTables(st).length, 0);
  assert.equal(st.local.getItem('trilliant:room:A'), null);
});

test('the sweep clears old unlisted saves but never fresh ones', async () => {
  const st = testStorage();
  seed(st, 'OLD1'); seed(st, 'OLD2');            // leftovers from the old eight-game list
  seed(st, 'KEEP');
  rememberTable(st, { roomId: 'KEEP', role: 'host', title: 'Your game' });
  const { identity } = await resolveIdentity(st, 'OPENING');  // just created in another tab
  assert.ok(identity);
  const removed = sweepStorage(st);
  assert.equal(removed, 4, 'room + id keys of the two old games');
  assert.ok(st.local.getItem('trilliant:room:KEEP'));
  assert.ok(st.local.getItem('trilliant:id:OPENING'), 'a brand-new identity survives');
});
