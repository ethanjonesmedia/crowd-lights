// Shared effect engine — used by the fan page and the control-panel preview.
// Every phone computes its own colour from (show settings, synced clock, section, random seed),
// so the server only has to send a message when the operator changes something.
// Routines (a list of timed steps) and beat sync (BPM) are also computed locally on each phone,
// so a whole routine plays in perfect sync from a single message.
(function (g) {
  const EFFECTS = {
    off:      { label: 'Blackout',  desc: 'All screens dark' },
    solid:    { label: 'Solid',     desc: 'Everyone shows colour 1' },
    split:    { label: 'Sections',  desc: 'Each section gets the next colour' },
    pulse:    { label: 'Pulse',     desc: 'Breathing fade' },
    strobe:   { label: 'Strobe',    desc: 'Flashes on the beat (max 3/sec)' },
    cycle:    { label: 'Cycle',     desc: 'Whole crowd steps through the colours' },
    wave:     { label: 'Wave',      desc: 'A band of light rolls across sections' },
    sparkle:  { label: 'Sparkle',   desc: 'Random phones twinkle on and off' },
    confetti: { label: 'Confetti',  desc: 'Every phone a random colour, changing on the beat' },
  };

  function hex(h) {
    const n = parseInt(String(h).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const BLACK = [0, 0, 0];
  const scale = (c, k) => c.map(v => v * k);
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const frac = x => x - Math.floor(x);
  const smooth = t => t * t * (3 - 2 * t);

  // Deterministic 0..1 hash of two integers (same result on every device).
  function hash(a, b) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // One effect. t = seconds since it started; bt = seconds since the beat anchor (or null if no BPM).
  function single(s, t, bt, section, seed) {
    const C = (s.colors && s.colors.length ? s.colors : ['#ffffff']).map(hex);
    const n = C.length;
    const sp = s.speed || 1;
    const S = Math.max(1, s.sections || 1);
    const sec = Math.min(Math.max(1, section | 0), S);
    const bpm = bt != null && s.bpm ? s.bpm : 0;
    // Position along the effect's own timeline: locked to beats when BPM is on, else uses speed.
    const pos = (perBeat, perSecond) => bpm ? Math.max(0, bt) * (bpm / 60) * perBeat : t * sp * perSecond;
    if (t < 0) t = 0;

    switch (s.effect) {
      case 'solid':
        return C[0];
      case 'split':
        return C[(sec - 1) % n];
      case 'pulse': {
        const x = pos(1, 0.5);
        const k = 0.5 + 0.5 * Math.cos(2 * Math.PI * x); // brightest on the beat
        return scale(C[Math.floor(x) % n], 0.06 + 0.94 * k);
      }
      case 'strobe': {
        // Capped at 3 flashes/sec for photosensitive safety (fast BPMs flash every other beat).
        const x = bpm ? Math.max(0, bt) * (bpm > 180 ? bpm / 120 : bpm / 60) : t * Math.min(3, 1.5 * sp);
        return frac(x) < 0.35 ? C[Math.floor(x) % n] : BLACK;
      }
      case 'cycle': {
        const x = pos(1, 0.5);
        const i = Math.floor(x), f = frac(x);
        const fade = bpm ? 0 : (f < 0.7 ? 0 : smooth((f - 0.7) / 0.3)); // snap on the beat when synced
        return mix(C[i % n], C[(i + 1) % n], fade);
      }
      case 'wave': {
        const bg = n > 1 ? scale(C[1], 0.35) : BLACK;
        const p = (sec - 1) / S;
        const ph = frac(pos(0.25, 0.4) - p); // one pass per 4 beats when synced
        const width = Math.max(0.12, 1.2 / S);
        const k = ph < width ? Math.sin((ph / width) * Math.PI) : 0;
        return mix(bg, C[0], k);
      }
      case 'sparkle': {
        const step = Math.floor(pos(2, 3));
        const on = hash(seed, step) > 0.72;
        return on ? C[Math.floor(hash(seed + 7, step) * n)] : scale(C[0], 0.04);
      }
      case 'confetti': {
        const step = Math.floor(pos(1, 1));
        return C[Math.floor(hash(seed, step) * n)];
      }
      default:
        return BLACK;
    }
  }

  // Where a routine is at time t. Returns {index, step, stepStart, total, done}.
  function routineAt(show, t) {
    const steps = show.steps || [];
    const total = steps.reduce((a, s) => a + (s.dur || 0), 0);
    if (!steps.length || total <= 0) return { index: -1, total: 0, done: true };
    let tt = Math.max(0, t);
    if (show.loop) tt = tt % total;
    else if (tt >= total) return { index: -1, total, done: true };
    let acc = 0;
    for (let i = 0; i < steps.length; i++) {
      if (tt < acc + steps[i].dur) return { index: i, step: steps[i], stepStart: acc, t: tt, total, done: false };
      acc += steps[i].dur;
    }
    return { index: -1, total, done: true };
  }

  // show: server state; now: server time in ms; section: 1..N; seed: per-phone integer. Returns [r,g,b].
  function frame(show, now, section, seed) {
    if (!show) return BLACK;
    const t = (now - show.startAt) / 1000;
    const bt = show.bpm && show.beatAt ? (now - show.beatAt) / 1000 : null;
    if (show.effect === 'routine') {
      const r = routineAt(show, t);
      if (r.done) return BLACK;
      const s = { ...r.step, sections: show.sections, bpm: show.bpm };
      return single(s, r.t - r.stepStart, bt, section, seed);
    }
    return single(show, t, bt, section, seed);
  }

  const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const luminance = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

  g.LightFX = { EFFECTS, frame, routineAt, css, luminance, hash };
})(typeof window !== 'undefined' ? window : globalThis);
