// Small synthesized cues: no downloads, autoplay, or sounds while the tab is hidden.
let context = null;

export function unlockAudio() {
  if (!context) {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    context = new Audio();
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
}

function note(frequency, at, length, volume, type = 'sine') {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.015);
}

export function playMoveSound(entries) {
  if (!context || context.state !== 'running' || document.hidden || !entries.length) return;
  const move = entries.find((e) => ['take', 'reserve', 'buy', 'discard', 'noble'].includes(e.t));
  if (!move) return;
  const now = context.currentTime;
  if (move.t === 'take') {
    note(620, now, 0.095, 0.027);
    note(840, now + 0.07, 0.12, 0.021);
  } else if (move.t === 'buy') {
    note(420, now, 0.11, 0.026, 'triangle');
    note(700, now + 0.09, 0.18, 0.025);
  } else if (move.t === 'reserve') {
    note(510, now, 0.13, 0.022, 'triangle');
  } else if (move.t === 'discard') {
    note(370, now, 0.11, 0.018, 'triangle');
  }
  if (entries.some((e) => e.t === 'noble')) {
    note(680, now + 0.12, 0.22, 0.03);
    note(910, now + 0.22, 0.26, 0.025);
  }
}
