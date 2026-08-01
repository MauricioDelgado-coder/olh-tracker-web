#!/usr/bin/env node
/**
 * Load a URL in headless Chrome over CDP and print every console message,
 * uncaught exception (with stack) and failed request.
 *
 *   node dev/console-probe.js <url> [millis]
 *
 * --dump-dom only shows what the page ended up rendering. When a script fails to
 * evaluate the page can still look fine, so this exists to see the failure
 * itself rather than its absence.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 7000);
if (!URL_) { console.error('usage: node dev/console-probe.js <url> [millis]'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + (process.pid % 300);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/olh-cdp-' + process.pid,
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await getJson('/json/list');
      target = list.find((t) => t.type === 'page');
    } catch (_) { /* not up yet */ }
  }
  if (!target) { console.error('could not reach Chrome devtools'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

  const seen = [];
  ws.onopen = () => {
    send('Runtime.enable');
    send('Log.enable');
    send('Network.enable');
    send('Page.enable');
    send('Page.navigate', { url: URL_ });
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }

    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      seen.push('EXCEPTION  ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
      const frames = (d.stackTrace && d.stackTrace.callFrames) || [];
      frames.slice(0, 6).forEach((f) => {
        seen.push('           at ' + (f.functionName || '(anon)') + ' ' + f.url + ':' + (f.lineNumber + 1) + ':' + (f.columnNumber + 1));
      });
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      seen.push(m.params.type.toUpperCase().padEnd(10) + ' ' + String(txt).slice(0, 220));
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.level === 'warning') {
        seen.push(e.level.toUpperCase().padEnd(10) + ' ' + String(e.text).slice(0, 220) +
                  (e.url ? '  (' + e.url + ':' + (e.lineNumber || 0) + ')' : ''));
      }
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) seen.push('HTTP ' + r.status + '   ' + r.url.slice(0, 150));
    }
    if (m.method === 'Network.loadingFailed') {
      seen.push('NETFAIL    ' + (m.params.errorText || '') + ' ' + (m.params.type || ''));
    }
  };

  await sleep(WAIT);
  try { ws.close(); } catch (_) {}
  chrome.kill();

  if (!seen.length) console.log('  (no console errors, exceptions or failed requests)');
  else seen.forEach((l) => console.log('  ' + l));
  process.exit(0);
})();
