'use strict';
/**
 * FR-16/FR-18. Веб-интерфейс и JSON API на zero-dependency stdlib (node:http).
 *   GET  /                 — форма + результат (граф vis-network, таблица факторов, карточки)
 *   POST /api/check {a, b, mode} — полный отчёт
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { AffiliationEngine } = require('../src/engine');

const PORT = process.env.PORT || 8080;
const staticArg = process.argv.indexOf('--static-dir');
const STATIC = staticArg >= 0 ? path.resolve(process.argv[staticArg + 1]) : path.join(__dirname, 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(res, file) {
  const full = path.join(STATIC, file);
  if (!full.startsWith(STATIC)) { send(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(full, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && staticArg >= 0) {
    serveStatic(res, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStatic(res, 'index.html');
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
    serveStatic(res, url.pathname.replace(/^\/static\//, ''));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const a = String(body.a || '').trim();
      const b = String(body.b || '').trim();
      const mode = ['all', 'live', 'demo', 'manual'].includes(body.mode) ? body.mode : 'all';
      if (!a || !b) { send(res, 400, { error: 'Параметры a и b обязательны' }); return; }
      const engine = new AffiliationEngine({ mode, importFiles: body.importFiles || [] });
      const report = await engine.check(a, b);
      send(res, 200, report);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`affcheck web: http://localhost:${PORT}`);
});
