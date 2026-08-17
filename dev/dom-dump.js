#!/usr/bin/env node
/**
 * Load a URL in headless Chrome, wait for it to settle, then dump the
 * outerHTML of every element matching a selector. Used to get ground truth
 * on DOM duplication bugs rather than guessing from a screenshot.
 *
 *   node dev/dom-dump.js <url> <selector> [millis]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
const SELECTOR = process.argv[3];
const WAIT = Number(process.argv[4] || 4000);
if (!URL_ || !SELECTOR) { console.error('usage: node dev/dom-dump.js <url> <selector> [millis]'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + (process.pid % 300);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/olh-cdp-dom-' + process.pid,
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
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    const handler = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) { ws.removeEventListener('message', handler); resolve(m.result); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  ws.onopen = async () => {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(WAIT);
    const result = await send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll(${JSON.stringify(SELECTOR)})).map(el => el.outerHTML).join('\\n\\n---\\n\\n')`,
      returnByValue: true
    });
    console.log(result && result.result && result.result.value || '(no matches / eval error: ' + JSON.stringify(result) + ')');
    ws.close();
    chrome.kill();
    process.exit(0);
  };
})();
