#!/usr/bin/env node
/**
 * Show every "sc-camel-" token the bundler injected into the scripts a page
 * appends, with surrounding source.
 *
 *   node dev/dump-mangled.js <url>
 *
 * The bundler rewrites camelCase to sc-camel-kebab-case for its own template
 * attributes (sc-camel-on-click). Applied to an inline <script> body it corrupts
 * JavaScript identifiers, and `var mkField` becomes `var sc-camel-mk-field`,
 * which is a syntax error that kills the whole script.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
if (!URL_) { console.error('usage: node dev/dump-mangled.js <url>'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + (process.pid % 199);

const HOOK = `
(function () {
  window.__scripts = [];
  var realAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    try {
      if (node && node.tagName === 'SCRIPT') {
        var t = node.text || node.textContent || '';
        if (t) window.__scripts.push(t);
      }
    } catch (_) {}
    return realAppend.apply(this, arguments);
  };
})();
`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/olh-dump-' + process.pid,
  'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let t = null;
  for (let i = 0; i < 40 && !t; i += 1) {
    await sleep(250);
    try { t = (await getJson('/json/list')).find((x) => x.type === 'page'); } catch (_) {}
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (m, p) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p || {} })); });
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await call('Page.navigate', { url: URL_ });
  await sleep(9000);

  const r = await call('Runtime.evaluate', {
    expression: `JSON.stringify((window.__scripts||[]).map(function (t, i) {
      var hits = [];
      var re = /sc-camel-[a-z0-9-]+/g, m;
      while ((m = re.exec(t)) && hits.length < 40) {
        hits.push({ token: m[0], ctx: t.slice(Math.max(0, m.index - 70), m.index + m[0].length + 30) });
      }
      return { i: i, len: t.length, count: (t.match(/sc-camel-/g)||[]).length, hits: hits };
    }))`,
    returnByValue: true
  });

  let list = [];
  try { list = JSON.parse(r.result.value); } catch (_) {}
  for (const s of list) {
    console.log('\n=== script #' + s.i + '  ' + s.len + ' chars  ' + s.count + ' sc-camel- token(s)');
    for (const h of s.hits) {
      console.log('  ' + h.token);
      console.log('     ...' + h.ctx.replace(/\s+/g, ' ') + '...');
    }
  }
  try { ws.close(); } catch (_) {}
  chrome.kill();
  process.exit(0);
})();
