// Crowd Lights — phone light show server. No dependencies: run with `node server.js`.
// Fans:      GET /?s=<section>      (the page the QR codes point to)
// Operator:  GET /control           (PIN protected via CONTROL_PIN env var)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.CONTROL_PIN || '1234');
const PUBLIC = path.join(__dirname, 'public');
const EFFECTS = ['off', 'solid', 'split', 'pulse', 'strobe', 'cycle', 'wave', 'sparkle', 'confetti'];
const LEAD_MS = 300; // changes start slightly in the future so every phone flips together

if (!process.env.CONTROL_PIN) console.warn('WARNING: CONTROL_PIN not set — using default PIN 1234. Set it before game day!');

let show = {
  effect: 'off',
  colors: ['#ffffff', '#c8102e'],
  speed: 1,
  sections: 4,
  startAt: Date.now(),
  v: 0,
};

const fans = new Set(); // { res, section }

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

function broadcast() {
  const msg = `data: ${JSON.stringify(show)}\n\n`;
  for (const f of fans) f.res.write(msg);
}

function clean(input) {
  const next = { ...show };
  if (EFFECTS.includes(input.effect)) next.effect = input.effect;
  if (Array.isArray(input.colors)) {
    const cs = input.colors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6);
    if (cs.length) next.colors = cs.map(c => c.toLowerCase());
  }
  if (Number.isFinite(+input.speed)) next.speed = Math.min(4, Math.max(0.25, +input.speed));
  if (Number.isFinite(+input.sections)) next.sections = Math.min(50, Math.max(1, Math.round(+input.sections)));
  next.startAt = Date.now() + LEAD_MS;
  next.v = show.v + 1;
  return next;
}

function stats() {
  const bySection = {};
  for (const f of fans) bySection[f.section] = (bySection[f.section] || 0) + 1;
  return { total: fans.size, bySection, show };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/time') return json(res, 200, { now: Date.now() });

  if (req.method === 'GET' && p === '/events') {
    const section = Math.min(50, Math.max(1, parseInt(url.searchParams.get('s'), 10) || 1));
    const watcher = url.searchParams.get('role') === 'control';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify(show)}\n\n`);
    const fan = { res, section };
    if (!watcher) fans.add(fan); else watchers.add(res);
    req.on('close', () => { fans.delete(fan); watchers.delete(res); });
    return;
  }

  if (p === '/api/show' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { error: 'Wrong PIN' });
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      show = clean(input);
      broadcast();
      const msg = `data: ${JSON.stringify(show)}\n\n`;
      for (const w of watchers) w.write(msg);
      json(res, 200, show);
    });
    return;
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

const watchers = new Set();

// Keep connections alive through proxies / carrier NATs.
setInterval(() => {
  for (const f of fans) f.res.write(': hb\n\n');
  for (const w of watchers) w.write(': hb\n\n');
}, 15000);

server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`Crowd Lights running on http://localhost:${PORT}  (control: /control)`));
