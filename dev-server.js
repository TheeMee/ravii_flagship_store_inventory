/**
 * RAVii local dev server (zero dependencies; uses Node 18+ global fetch).
 *
 *   node dev-server.js          # then open http://localhost:8787/
 *
 * - Serves the app from this folder (/ -> Index.html), so you can edit Index.html
 *   and refresh to see changes.
 * - Proxies /api and /.netlify/functions/api to the Apps Script /exec endpoint
 *   (server-to-server, follows the 302) and adds CORS — so it ALSO works if you
 *   keep using VS Code Live Server on :5500 (the app calls this proxy at :8787).
 *
 * Not deployed anywhere; local only. (Ignored by clasp.)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbwflxt9AoEebPUlKEXTY0WlouILSd4Zx9oQorMyytdIHrsgOghD94dK16iLzzRxNiNX/exec';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json'
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function isApi(p) { return p === '/api' || p === '/.netlify/functions/api'; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // ---- API proxy ----
  if (isApi(u.pathname)) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    try {
      const isGet = req.method === 'GET';
      const target = isGet && u.search ? APPS_SCRIPT_URL + u.search : APPS_SCRIPT_URL;
      let body = '';
      if (!isGet) { for await (const chunk of req) body += chunk; }
      const r = await fetch(target, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isGet ? undefined : (body || '{}'),
        redirect: 'follow'
      });
      const text = await r.text();
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e), code: 'PROXY' }));
    }
  }

  // ---- static files ----
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/Index.html';
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  RAVii dev server running:  http://localhost:${PORT}/`);
  console.log(`  API proxied to Apps Script /exec  (also serves /api for Live Server on :5500)\n`);
});
