// Crowd Lights — phone light show server. No dependencies: run with `node server.js`.
// Fans:      GET /?s=<section>      (the page the QR codes point to)
// Operator:  GET /control           (PIN protected via CONTROL_PIN env var)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.CONTROL_PIN || '1234');
const PUBLIC = path.join(__dirname, 'public');
const EFFECTS = ['off', 'solid', 'split', 'pulse', 'strobe', 'cycle', 'wave', 'sparkle', 'confetti'];
const LEAD_MS = 300; // changes start slightly in the future so every phone flips together

if (!process.env.CONTROL_PIN) console.warn('WARNING: CONTROL_PIN not set — using default PIN 1234. Set it before game day!');

let show = {
  effect: 'off',
  colors: ['#f7c21b', '#ffffff'],
  speed: 1,
  sections: 4,
  bpm: null,       // beat sync: beats per minute, or null when off
  beatAt: null,    // server time (ms) of a beat, to line effects up with the music
  startAt: Date.now(),
  v: 0,
};

// Sign-in screen photo: any file in /public named team-*.jpg/.jpeg/.png/.webp can be picked from the control panel.
function listPhotos() {
  try { return fs.readdirSync(PUBLIC).filter(f => /^team-[\w-]+\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch { return []; }
}
const settings = { photo: process.env.DEFAULT_PHOTO || 'team-mbb.jpg' };

const fans = new Set();     // { res, section, id }
const watchers = new Set(); // control panels
let winner = null;          // { id, code, prize, claim, section, at }
const history = [];         // past winners (most recent first)
const pastWinnerIds = new Set();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function sendFile(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) return notFound(res);
  fs.readFile(full, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function authed(req) { return req.headers['x-pin'] === PIN; }
function readBody(req, cb) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 32768) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

function sse(event, data) { return (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`; }
function broadcast() {
  const msg = sse(null, show);
  for (const f of fans) f.res.write(msg);
  for (const w of watchers) w.write(msg);
}
function sendToFan(id, event, data) {
  const msg = sse(event, data);
  for (const f of fans) if (f.id === id) f.res.write(msg);
}

const isColor = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const cleanColors = cs => Array.isArray(cs) ? cs.filter(isColor).slice(0, 6).map(c => c.toLowerCase()) : [];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function clean(input) {
  const next = { ...show };
  let restart = !!input.restart;

  if (input.effect === 'routine') {
    const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 60).map(s => ({
      effect: EFFECTS.includes(s && s.effect) ? s.effect : 'off',
      colors: cleanColors(s && s.colors).length ? cleanColors(s.colors) : ['#ffffff'],
      speed: clamp(+(s && s.speed) || 1, 0.25, 4),
      dur: clamp(+(s && s.dur) || 5, 0.5, 600),
    }));
    if (steps.length) {
      if (next.effect !== 'routine') restart = true;
      next.effect = 'routine';
      next.steps = steps;
      next.loop = !!input.loop;
      next.routineName = String(input.routineName || 'Routine').slice(0, 60);
    }
  } else if (EFFECTS.includes(input.effect)) {
    if (input.effect !== next.effect) restart = true;
    next.effect = input.effect;
    delete next.steps; delete next.loop; delete next.routineName;
  }

  const cs = cleanColors(input.colors);
  if (cs.length) next.colors = cs;
  if (Number.isFinite(+input.speed)) next.speed = clamp(+input.speed, 0.25, 4);
  if (Number.isFinite(+input.sections)) next.sections = clamp(Math.round(+input.sections), 1, 50);

  if ('bpm' in input) {
    if (input.bpm === null) { next.bpm = null; next.beatAt = null; }
    else if (Number.isFinite(+input.bpm)) {
      next.bpm = Math.round(clamp(+input.bpm, 40, 220) * 10) / 10;
      const ba = +input.beatAt;
      next.beatAt = Number.isFinite(ba) && Math.abs(ba - Date.now()) < 15000 ? ba : (next.beatAt || Date.now());
    }
  }

  if (restart) next.startAt = Date.now() + LEAD_MS;
  next.v = show.v + 1;
  return next;
}

function stats() {
  const bySection = {};
  const ids = new Set();
  for (const f of fans) { ids.add(f.id); bySection[f.section] = (bySection[f.section] || 0) + 1; }
  const pub = winner ? { code: winner.code, prize: winner.prize, claim: winner.claim, section: winner.section, at: winner.at } : null;
  return { total: fans.size, bySection, show, winner: pub, history: history.slice(0, 20) };
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L mix-ups
function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return c;
}

function pickWinner(input) {
  const section = Number.isFinite(+input.section) && +input.section > 0 ? Math.round(+input.section) : null;
  const pool = new Map(); // unique phones (a phone reconnecting counts once)
  for (const f of fans) {
    if (section && f.section !== section) continue;
    if (pastWinnerIds.has(f.id)) continue;
    pool.set(f.id, f.section);
  }
  if (!pool.size) return { error: section ? `No eligible phones connected in section ${section}.` : 'No eligible phones connected.' };
  if (winner) sendToFan(winner.id, 'winclear', {});
  const ids = [...pool.keys()];
  const id = ids[crypto.randomInt(ids.length)];
  winner = {
    id,
    code: makeCode(),
    prize: String(input.prize || 'A prize!').slice(0, 80),
    claim: String(input.claim || 'Show this screen to a staff member.').slice(0, 120),
    section: pool.get(id),
    at: Date.now(),
  };
  pastWinnerIds.add(id);
  history.unshift({ code: winner.code, prize: winner.prize, section: winner.section, at: winner.at });
  sendToFan(id, 'win', { code: winner.code, prize: winner.prize, claim: winner.claim });
  return { winner: { code: winner.code, prize: winner.prize, claim: winner.claim, section: winner.section, at: winner.at }, eligible: ids.length };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/time') return json(res, 200, { now: Date.now() });
  if (req.method === 'GET' && p === '/settings') {
    const photos = listPhotos();
    const photo = photos.includes(settings.photo) ? settings.photo : (photos[0] || '');
    return json(res, 200, { photo, photos });
  }

  if (req.method === 'GET' && p === '/events') {
    const section = clamp(parseInt(url.searchParams.get('s'), 10) || 1, 1, 50);
    const watcher = url.searchParams.get('role') === 'control';
    const id = (url.searchParams.get('id') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n' + sse(null, show));
    const fan = { res, section, id };
    if (watcher) watchers.add(res);
    else {
      fans.add(fan);
      // A winner whose phone reconnects still sees their prize.
      if (winner && winner.id === id) res.write(sse('win', { code: winner.code, prize: winner.prize, claim: winner.claim }));
    }
    req.on('close', () => { fans.delete(fan); watchers.delete(res); });
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'Wrong PIN' });
    return readBody(req, input => {
      if (!input) return json(res, 400, { error: 'Bad request' });
      if (p === '/api/show') {
        show = clean(input);
        broadcast();
        return json(res, 200, show);
      }
      if (p === '/api/winner') {
        const r = pickWinner(input);
        return json(res, r.error ? 409 : 200, r);
      }
      if (p === '/api/winner/clear') {
        if (winner) sendToFan(winner.id, 'winclear', {});
        winner = null;
        return json(res, 200, { ok: true });
      }
      if (p === '/api/settings') {
        if (typeof input.photo === 'string' && listPhotos().includes(input.photo)) settings.photo = input.photo;
        return json(res, 200, { photo: settings.photo, photos: listPhotos() });
      }
      if (p === '/api/winner/reset') { // let everyone be eligible again (e.g. a new game)
        pastWinnerIds.clear(); history.length = 0;
        if (winner) sendToFan(winner.id, 'winclear', {});
        winner = null;
        return json(res, 200, { ok: true });
      }
      return notFound(res);
    });
  }

  if (p === '/api/stats' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: 'Wrong PIN' });
    return json(res, 200, stats());
  }

  if (req.method !== 'GET') return notFound(res);
  if (p === '/') return sendFile(res, 'index.html');
  if (p === '/control') return sendFile(res, 'control.html');
  return sendFile(res, p.slice(1));
});

// Keep connections alive through proxies / carrier NATs.
setInterval(() => {
  for (const f of fans) f.res.write(': hb\n\n');
  for (const w of watchers) w.write(': hb\n\n');
}, 15000);

server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`Crowd Lights running on http://localhost:${PORT}  (control: /control)`));
