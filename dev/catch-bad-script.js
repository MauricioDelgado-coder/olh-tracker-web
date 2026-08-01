#!/usr/bin/env node
/**
 * Find the script the design-tool bundler cannot parse, and print the offending
 * source with context.
 *
 *   node dev/catch-bad-script.js <url>
 *
 * The bundler builds script text at runtime and appends it to the document, so a
 * syntax error surfaces only as "Failed to execute 'appendChild'" with no source.
 * This installs a hook BEFORE any page script runs (Page.addScriptToEvaluate-
 * OnNewDocument), records the text of every script the page appends, compiles
 * each one, and reports the first that fails.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 9000);
if (!URL_) { console.error('usage: node dev/catch-bad-script.js <url>'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9600 + (process.pid % 300);

const HOOK = `
(function () {
  window.__scripts = [];
  var realAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    try {
      if (node && node.tagName === 'SCRIPT') {
        var txt = node.text || node.textContent || '';
        if (txt) {
          var rec = { len: txt.length, text: txt, err: null };
          try { new Function(txt); } catch (e) { rec.err = String(e && e.message || e); }
          window.__scripts.push(rec);
        }
      }
    } catch (_) {}
    return realAppend.apply(this, arguments);
  };
})();
`;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/olh-catch-' + process.pid,
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
    let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(250);
    try { target = (await getJson('/json/list')).find((t) => t.type === 'page'); } catch (_) {}
  }
  if (!target) { console.error('no devtools target'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await call('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  const r = await call('Runtime.evaluate', {
    expression: `JSON.stringify((window.__scripts || []).map(function (s, i) {
      return { i: i, len: s.len, err: s.err, head: s.text.slice(0, 90) };
    }))`,
    returnByValue: true
  });

  let list = [];
  try { list = JSON.parse(r.result.value); } catch (_) {}
  console.log('\nscripts appended: ' + list.length);
  for (const s of list) {
    console.log((s.err ? '  BAD  ' : '  ok   ') + String(s.i).padStart(2) + '  ' +
                (s.len + '').padStart(8) + ' chars  ' + s.head.replace(/\s+/g, ' '));
    if (s.err) console.log('       ' + s.err);
  }

  const badIdx = list.findIndex((s) => s.err);
  if (badIdx >= 0) {
    // Compile the bad one in-page to get a line number, then print that region.
    const detail = await call('Runtime.evaluate', {
      expression: `(function () {
        var t = window.__scripts[${badIdx}].text;
        var line = 0, col = 0;
        try { new Function(t); } catch (e) {
          var m = /<anonymous>:(\\d+):(\\d+)/.exec(e.stack || '');
          if (m) { line = +m[1]; col = +m[2]; }
        }
        var lines = t.split('\\n');
        var from = Math.max(0, line - 4), to = Math.min(lines.length, line + 3);
        return JSON.stringify({
          line: line, col: col, total: lines.length,
          region: lines.slice(from, to).map(function (l, i) { return (from + i + 1) + '| ' + l.slice(0, 300); }),
          hyphenDecls: (t.match(/\\b(?:var|let|const)\\s+[A-Za-z_$][\\w$]*-[\\w$-]*/g) || []).slice(0, 10)
        });
      })()`,
      returnByValue: true
    });
    let d = {};
    try { d = JSON.parse(detail.result.value); } catch (_) {}
    console.log('\n--- failing script #' + badIdx + ', ' + (d.total || '?') + ' lines, error at line ' + d.line + ':' + d.col);
    (d.region || []).forEach((l) => console.log('   ' + l));
    if (d.hyphenDecls && d.hyphenDecls.length) {
      console.log('\n   declarations containing a hyphen:');
      d.hyphenDecls.forEach((h) => console.log('     ' + h));
    }
  }

  try { ws.close(); } catch (_) {}
  chrome.kill();
  process.exit(0);
})();
