import test from 'node:test';
import assert from 'node:assert/strict';
import { newMoveEntries } from '../js/ui/motion.js';

test('motion only replays newly accepted moves when the log rolls over', () => {
  const old = Array.from({ length: 80 }, (_, i) => ({ t: 'take', p: 0, gems: { red: i } }));
  const next = [...old.slice(2), { t: 'buy', p: 1, card: 12 }, { t: 'noble', p: 1, noble: 3 }];
  assert.deepEqual(newMoveEntries({ log: old }, { log: next }), next.slice(-2));
  assert.deepEqual(newMoveEntries({ log: next }, { log: next }), []);
});
