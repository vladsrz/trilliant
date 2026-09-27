// Repeating timers that keep their pace in background tabs. Browsers slow page
// timers in hidden tabs (Chrome to once a minute after five minutes), which would
// make a player who switched tabs look offline. Timers inside a worker aren't
// throttled that way, so a tiny worker ticks once a second and drives them all.

const subs = new Set();
let worker = null;
let fallback = null;

function tick() {
  const now = Date.now();
  for (const s of subs) {
    if (now - s.last >= s.ms - 50) {
      s.last = now;
      try { s.fn(); } catch { /* one bad subscriber shouldn't stop the rest */ }
    }
  }
}

function ensureRunning() {
  if (worker || fallback) return;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') throw new Error('no worker');
    const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = tick;
  } catch {
    fallback = setInterval(tick, 1000);
  }
}

function stopIfIdle() {
  if (subs.size) return;
  if (worker) { worker.terminate(); worker = null; }
  if (fallback) { clearInterval(fallback); fallback = null; }
}

// Call `fn` every `ms` milliseconds (1 s resolution). Returns a cancel function.
export function every(ms, fn) {
  const sub = { ms, fn, last: Date.now() };
  subs.add(sub);
  ensureRunning();
  return () => { subs.delete(sub); stopIfIdle(); };
}
