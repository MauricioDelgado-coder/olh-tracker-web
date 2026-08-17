#!/usr/bin/env node
/**
 * Isolated correctness check for multiselect.js's setOptions(), independent
 * of the app/auth: loads the widget class directly in headless Chrome,
 * creates one, feeds it the {v,l}-shaped option objects every real caller
 * in this codebase actually uses, opens the panel, and reads back the
 * rendered checkbox row labels -- proving the {v,l} fallback works without
 * needing a live authenticated session or real Airtable data.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + (process.pid % 300);

const MULTISELECT_SRC = fs.readFileSync(path.join(__dirname, 'multiselect.js'), 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/olh-cdp-unit-' + process.pid,
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
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
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);

    await send('Runtime.evaluate', { expression: MULTISELECT_SRC });

    const testExpr = `
      (function () {
        const el = document.createElement('olh-multiselect');
        el.setAttribute('placeholder', 'All construction managers');
        document.body.appendChild(el);
        // exact shape completion.html's opts() / tracker.html's
        // _filterOptions actually produce -- {v,l}, not {value,label}
        el.setOptions([
          { v: 'jeff-boyd', l: 'Jeff Boyd  (12)' },
          { v: 'blake-b', l: 'Blake Beauchene  (7)' }
        ]);
        el._setOpen(true);
        const rows = Array.from(el._panel.querySelectorAll('label span:last-child')).map(s => s.textContent);
        el.setValues(['jeff-boyd']);
        const fieldLabel = el._label.textContent;
        return JSON.stringify({ optionRowLabels: rows, selectedFieldLabel: fieldLabel });
      })()
    `;
    const result = await send('Runtime.evaluate', { expression: testExpr, returnByValue: true });
    console.log(result && result.result && result.result.value);
    ws.close();
    chrome.kill();
    process.exit(0);
  };
})();
