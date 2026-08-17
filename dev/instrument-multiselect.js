#!/usr/bin/env node
/**
 * Instruments <olh-multiselect> before the page's own scripts run, by
 * wrapping customElements.define via Page.addScriptToEvaluateOnNewDocument
 * (runs before any page script, including inline ones). Logs every call to
 * connectedCallback/disconnectedCallback/_build with a stack trace and an
 * instance id, so we can see exactly how many times and from where each
 * fires -- rather than guessing from the resulting DOM shape.
 *
 *   node dev/instrument-multiselect.js <url> [millis]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 6000);
if (!URL_) { console.error('usage: node dev/instrument-multiselect.js <url> [millis]'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + (process.pid % 300);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/olh-cdp-instr-' + process.pid,
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

const INSTRUMENT_SCRIPT = `
(function () {
  window.__msLog = [];
  var origDefine = customElements.define.bind(customElements);
  customElements.define = function (name, cls, opts) {
    if (name === 'olh-multiselect') {
      var origConnected = cls.prototype.connectedCallback;
      var origDisconnected = cls.prototype.disconnectedCallback;
      var origBuild = cls.prototype._build;
      var nextId = 1;
      cls.prototype.connectedCallback = function () {
        if (!this.__msId) this.__msId = nextId++;
        window.__msLog.push('connectedCallback id=' + this.__msId + ' _built=' + this._built + '\\n' + new Error().stack);
        return origConnected.apply(this, arguments);
      };
      cls.prototype.disconnectedCallback = function () {
        window.__msLog.push('disconnectedCallback id=' + this.__msId + '\\n' + new Error().stack);
        if (origDisconnected) return origDisconnected.apply(this, arguments);
      };
      cls.prototype._build = function () {
        window.__msLog.push('_build id=' + this.__msId + '\\n' + new Error().stack);
        return origBuild.apply(this, arguments);
      };
    }
    return origDefine(name, cls, opts);
  };
})();
`;

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
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT_SCRIPT });
    await send('Page.navigate', { url: URL_ });
    await sleep(WAIT);
    const result = await send('Runtime.evaluate', {
      expression: '(window.__msLog || []).join("\\n\\n===\\n\\n")',
      returnByValue: true
    });
    console.log(result && result.result && result.result.value || '(no log / eval error: ' + JSON.stringify(result) + ')');
    ws.close();
    chrome.kill();
    process.exit(0);
  };
})();
