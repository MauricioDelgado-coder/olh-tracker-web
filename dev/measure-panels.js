#!/usr/bin/env node
/**
 * Measure the bottom edge of each top-row panel on the Completion Report.
 *
 *   node dev/measure-panels.js <url> [viewport-width]
 *
 * The three panels sit in one grid row with align-items:start, so each is as
 * tall as its own content and the shortest one leaves a ragged bottom edge.
 * Guessing a pixel nudge to fix that is how you get something that lines up on
 * one screen and not the next -- this reports the real numbers, per width.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');

const URL_ = process.argv[2];
const WIDTHS = process.argv[3] ? [Number(process.argv[3])] : [1280, 1440, 1728];
if (!URL_) { console.error('usage: node dev/measure-panels.js <url> [width]'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const grid = [...document.querySelectorAll('div')]
    .find(d => getComputedStyle(d).display === 'grid'
            && d.querySelectorAll(':scope > section').length === 3);
  if (!grid) return { error: 'three-panel grid not found' };
  const g = grid.getBoundingClientRect();
  const panels = [...grid.children].map(el => {
    const r = el.getBoundingClientRect();
    const head = el.querySelector('span');
    return {
      label: (head && head.textContent.trim().slice(0, 26)) || el.tagName,
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height)
    };
  });
  return { gridBottom: Math.round(g.bottom), rowHeight: Math.round(g.height), panels };
})()`;

/* Chrome ships a WebSocket in node 22+ globally; fall back to the CLI's copy. */
async function run(width) {
  const port = 9500 + (width % 100);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + port,
    '--window-size=' + width + ',1000',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    target = await new Promise((res) => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let b = ''; r.on('data', (d) => (b += d));
        r.on('end', () => { try { res(JSON.parse(b).find((t) => t.type === 'page')); } catch (_) { res(null); } });
      }).on('error', () => res(null));
    });
  }
  if (!target) { chrome.kill(); console.log('  chrome did not start at ' + width); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  await new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };

  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(4000);

  /* Layout fixture, and ONLY a layout fixture.
   *
   * The panels are measured signed-out, where /api/jobs answers 401 and the
   * community tile renders zero bars -- so the row is short and the numbers say
   * nothing about the view anyone actually uses. This pushes enough synthetic
   * rows through the page's own data path to make the tile render its full 8
   * bars, purely so the geometry is the geometry of a populated page.
   *
   * It runs in this measuring script against a local server, never in a build
   * and never in anything that ships. The values are deliberately obvious
   * nonsense so a screenshot taken during a measurement can never be mistaken
   * for real homesites. */
  const COMMS = ['LAYOUT FIXTURE A', 'LAYOUT FIXTURE B WITH A LONG NAME',
    'LAYOUT FIXTURE C', 'LAYOUT FIXTURE D', 'LAYOUT FIXTURE E',
    'LAYOUT FIXTURE F', 'LAYOUT FIXTURE G', 'LAYOUT FIXTURE H', 'LAYOUT FIXTURE I'];
  const fixture = `(() => {
    const jobs = [];
    ${JSON.stringify(COMMS)}.forEach((c, ci) => {
      for (let n = 0; n < 20 - ci; n++) {
        jobs.push({ id: 'fixture' + ci + '_' + n, fields: {
          'Job #': 'FIXTURE-' + ci + '-' + n,
          'Record Status': 'Active',
          'Community': c,
          'Street Address': 'not a real address',
          'Lot Status': 'B',
          'Actual Start Date': '2026-03-01',
          'Projected Completion Date': (n % 5 === 0 ? '2027-0' + (1 + (n % 6)) : '2026-' +
            String(7 + (n % 6)).padStart(2, '0')) + '-15',
          'Construction Stage (JDE)': '0' + (1 + (n % 9))
        }});
      }
    });
    window.OLH_DATA = { jobs, managers: [], today: new Date(),
      meta: { runDate: '2026-08-01', division: 'LAYOUT FIXTURE' } };
    window.dispatchEvent(new Event('olh-data'));
    return jobs.length;
  })()`;
  const seeded = await send('Runtime.evaluate', { expression: fixture, returnByValue: true });
  await sleep(1500);
  if (width === WIDTHS[0]) {
    console.log('\n  (seeded ' + ((seeded.result && seeded.result.value) || 0) +
      ' layout-fixture rows so the community tile renders its full 8 bars)');
  }

  const out = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
  const v = out && out.result && out.result.value;

  console.log('\n=== viewport ' + width + 'px ===');
  if (!v || v.error) { console.log('  ' + ((v && v.error) || 'no result')); }
  else {
    for (const p of v.panels) {
      console.log('  ' + p.label.padEnd(28) + 'height ' + String(p.height).padStart(5) +
        '   bottom ' + String(p.bottom).padStart(5));
    }
    const bottoms = v.panels.map((p) => p.bottom);
    const gap = Math.max(...bottoms) - Math.min(...bottoms);
    console.log('  ' + 'ragged edge'.padEnd(28) + String(gap).padStart(12) + 'px' +
      (gap === 0 ? '   (aligned)' : ''));
  }

  if (process.argv.includes('--shot')) {
    /* Hide the sign-in gate for the screenshot only. The panels behind it are
       laid out and measurable either way, but a picture of the gate tells you
       nothing about whether the bottom edges line up. Nothing is bypassed:
       the data on screen is the layout fixture seeded above, and /api/jobs
       has already refused this session. */
    await send('Runtime.evaluate', { expression: `(() => {
      const el = [...document.querySelectorAll('*')]
        .find(n => n.children.length === 0 && /Sign In to Continue/.test(n.textContent || ''));
      if (!el) return 'no gate';
      let n = el;
      while (n && n.parentElement && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
      (n || el).style.display = 'none';
      return 'gate hidden';
    })()`, returnByValue: true });
    await sleep(400);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = '/tmp/completion-' + width + '.png';
    require('fs').writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('  screenshot -> ' + file);
  }

  try { ws.close(); } catch (_) {}
  chrome.kill();
}

(async () => { for (const w of WIDTHS) await run(w); })();
