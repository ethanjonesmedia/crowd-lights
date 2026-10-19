// Shared effect engine — used by the fan page and the control-panel preview.
// Every phone computes its own colour from (show settings, synced clock, section, random seed),
// so the server only has to send a message when the operator changes something.
(function (g) {
  const EFFECTS = {
    off:      { label: 'Blackout',  desc: 'All screens dark' },
    solid:    { label: 'Solid',     desc: 'Everyone shows colour 1' },
    split:    { label: 'Sections',  desc: 'Each section gets the next colour' },
    pulse:    { label: 'Pulse',     desc: 'Slow breathing fade' },
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

  // show: {effect, colors[], speed, sections}; t: seconds since show.startAt;
  // section: 1..N; seed: integer unique-ish per phone. Returns [r,g,b] 0..255.
  function frame(show, t, section, seed) {
    if (!show) return BLACK;
    const C = (show.colors && show.colors.length ? show.colors : ['#ffffff']).map(hex);
    const n = C.length;
    const sp = show.speed || 1;
    const S = Math.max(1, show.sections || 1);
    const sec = Math.min(Math.max(1, section | 0), S);
    if (t < 0) t = 0;

    switch (show.effect) {
      case 'solid':
        return C[0];
      case 'split':
        return C[(sec - 1) % n];
      case 'pulse': {
        const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * t * sp * 0.5);
        return scale(C[Math.floor(t * sp * 0.5) % n], 0.06 + 0.94 * k);
      }
      case 'strobe': {
        const hz = Math.min(3, 1.5 * sp); // capped for photosensitive safety
        const beat = Math.floor(t * hz);
        return frac(t * hz) < 0.35 ? C[beat % n] : BLACK;
      }
      case 'cycle': {
        const beat = t * sp * 0.5;
        const i = Math.floor(beat), f = frac(beat);
        const fade = f < 0.7 ? 0 : smooth((f - 0.7) / 0.3);
        return mix(C[i % n], C[(i + 1) % n], fade);
      }
      case 'wave': {
        const bg = n > 1 ? scale(C[1], 0.35) : BLACK;
        const pos = (sec - 1) / S;
        const ph = frac(t * sp * 0.4 - pos);
        const width = Math.max(0.12, 1.2 / S);
        const k = ph < width ? Math.sin((ph / width) * Math.PI) : 0;
        return mix(bg, C[0], k);
      }
      case 'sparkle': {
        const step = Math.floor(t * sp * 3);
        const on = hash(seed, step) > 0.72;
        return on ? C[Math.floor(hash(seed + 7, step) * n)] : scale(C[0], 0.04);
      }
      case 'confetti': {
        const step = Math.floor(t * sp);
        return C[Math.floor(hash(seed, step) * n)];
      }
      default:
        return BLACK;
    }
  }

  const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const luminance = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

  g.LightFX = { EFFECTS, frame, css, luminance, hash };
})(typeof window !== 'undefined' ? window : globalThis);
