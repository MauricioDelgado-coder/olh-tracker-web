#!/usr/bin/env node
/**
 * Local server for verifying the built pages against live Airtable data.
 *
 *   node dev/verify-server.js <built-dir> [port]
 *
 * Serves the built pages and runs the real netlify functions at /api/jobs,
 * /api/update-job and /api/walk-config. PAT comes from the local-only config
 * and is never logged. Add ?fail=1 to a page URL to force the API to 500 so the
 * error state can be checked.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = process.argv[2];
const PORT = Number(process.argv[3] || 8899);
if (!DIR) { console.error('usage: node dev/verify-server.js <built-dir> [port]'); process.exit(2); }

process.env.AIRTABLE_PAT = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/olh-qa-tracker/config.json'), 'utf8')
).airtable_pat;

const jobsFn = require('../netlify/functions/jobs.js');
const walkFn = require('../netlify/functions/walk-config.js');
const updateFn = require('../netlify/functions/update-job.js');

/* Extensionless routes, the way Netlify serves them.
 *
 * This was a hardcoded list of six and it silently rotted: workload-visualizer
 * and admin were added to the suite and never added here, so verify-pages.sh
 * was fetching a 404 body for both and reporting four failures each. Eight red
 * checks that said nothing about the pages -- which is worse than no check,
 * because it trains you to skim past the red.
 *
 * Derived from what is actually in the directory now, so a new page is routed
 * the moment it is built. */
const ROUTES = { '/': 'index.html' };
for (const f of fs.readdirSync(DIR)) {
  if (f.endsWith('.html') && f !== 'index.html') ROUTES['/' + f.slice(0, -5)] = f;
}

let forceFail = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/__fail') { forceFail = url.searchParams.get('on') === '1'; res.end('fail=' + forceFail); return; }

  if (p.startsWith('/api/')) {
    if (forceFail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forced failure for error-state verification' }));
      return;
    }
    const fn = p === '/api/jobs' ? jobsFn : p === '/api/walk-config' ? walkFn
      : p === '/api/update-job' ? updateFn : null;
    if (!fn) { res.writeHead(404); res.end('no such api'); return; }
    let body = '';
    for await (const c of req) body += c;
    const out = await fn.handler({
      httpMethod: req.method,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: body || undefined,
      headers: req.headers
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }

  const file = ROUTES[p] || (/^\/[A-Za-z0-9._-]+\.html$/.test(p) ? p.slice(1) : null);
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) { res.writeHead(404); res.end('missing ' + file); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(full));
});

server.listen(PORT, () => console.log('verify server on http://localhost:' + PORT));
