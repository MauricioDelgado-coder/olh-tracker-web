#!/usr/bin/env node
/**
 * Re-inject dev/completion-loader.js into public/completion.html in place.
 *
 *   node dev/reinject-completion-loader.js [public-dir]
 *
 * Why this exists instead of re-running the full build:
 *
 * build-live-pages.js rebuilds every page from a design export, and its patches
 * assert an exact single match so a moved anchor fails loudly. That is the right
 * behaviour for a re-export, but it means the build only succeeds against the
 * export the current public/ was produced from. Several pages in public/ have
 * since been advanced past the newest export on disk -- a full build today dies
 * on index.html ("auth: session: a 200 with no user is still a real answer"
 * matched 0 times) because that anchor no longer exists in the export.
 *
 * A change confined to the completion loader does not need any of that. This
 * script swaps just the injected loader block, which is what the 08/01 13:53
 * commit did by hand: one line of public/completion.html changed, nothing else.
 *
 * Encoding: the page is a bundler document whose real content lives in the
 * __bundler/template line as a JSON string. build-live-pages.js serialises it as
 *   JSON.stringify(template).split('</').join('<\\u002F')
 * and this reproduces that byte for byte, so nothing outside the loader moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUB = process.argv[2] || path.join(__dirname, '..', 'public');
const PAGE = path.join(PUB, 'completion.html');
const LOADER_SRC = path.join(__dirname, 'completion-loader.js');

const die = (m) => { console.error('FAILED: ' + m); process.exit(1); };

// Must match build-live-pages.js exactly (note the em dash).
const OPEN = '<script>\n/* completion live data loader — injected by dev/build-live-pages.js */\n';
const CLOSE = '\n</script>\n</body>';

const loader = fs.readFileSync(LOADER_SRC, 'utf8');
if (!/COMPLETION_DATA/.test(loader)) die('completion-loader.js does not set COMPLETION_DATA');
// The bundler rewrites lowerCamelCase declarations into kebab-case and the page
// dies with a SyntaxError. Cheap to check here, expensive to debug in a browser.
const camel = loader.match(/\b(?:var|let|const)\s+[a-z]+[A-Z]\w*/g);
if (camel) die('lowerCamelCase declaration(s) the bundler will mangle: ' + camel.join(', '));

const lines = fs.readFileSync(PAGE, 'utf8').split('\n');
const idx = lines.findIndex((l) => l.length > 10000 && l.includes('completion live data loader'));
if (idx === -1) die('no bundler template line containing the loader block');

let tpl;
try { tpl = JSON.parse(lines[idx]); } catch (e) { die('template line is not valid JSON: ' + e.message); }

const a = tpl.indexOf(OPEN);
if (a === -1) die('loader open marker not found -- did build-live-pages.js change the wrapper?');
if (tpl.indexOf(OPEN, a + 1) !== -1) die('loader open marker found more than once');
const b = tpl.indexOf(CLOSE, a);
if (b === -1) die('loader close marker not found after the open marker');

const oldLoader = tpl.slice(a + OPEN.length, b);
if (oldLoader === loader) {
  console.log('public/completion.html already carries this loader -- nothing to do.');
  process.exit(0);
}

const next = tpl.slice(0, a + OPEN.length) + loader + tpl.slice(b);
const payload = JSON.stringify(next).split('</').join('<\\u002F');
if (JSON.parse(payload) !== next) die('re-encode is not round-trip safe');

fs.copyFileSync(PAGE, PAGE + '.bak');
lines[idx] = payload;
fs.writeFileSync(PAGE, lines.join('\n'));

// --- verify the file on disk, not the string we just built -------------------
const back = JSON.parse(fs.readFileSync(PAGE, 'utf8').split('\n')[idx]);
const checks = {
  'new loader present in the written file': back.includes(loader),
  'previous loader gone': !back.includes(oldLoader),
  'exactly one loader block': back.split(OPEN).length - 1 === 1,
  /* A fixture is an array of record objects. Matching bare `= [` would also flag
   * the loader's own `window.COMPLETION_DATA = []` error path, which is the line
   * that guarantees a failed fetch renders nothing rather than stale data -- so
   * the check has to look for `= [{`. */
  'no baked COMPLETION_DATA fixture': !/(window\.)?COMPLETION_DATA\s*=\s*\[\s*\{/.test(back),
  'empty-array fallback still present': /COMPLETION_DATA\s*=\s*\[\s*\]/.test(back),
  'page still reads /api/jobs': back.includes("fetch('/api/jobs'"),
  'body close intact': back.includes('</body>'),
  'scope rules carried over': ['Actual Start Date', 'Actual Completion Date', 'Lot Status',
    'Projected Completion Date'].every((k) => back.includes(k)),
};
let ok = true;
console.log('');
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'PASS  ' : 'FAIL  ') + k);
  if (!v) ok = false;
}
if (!ok) die('verification failed -- public/completion.html.bak holds the previous version');

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('\nloader ' + kb(oldLoader.length) + ' -> ' + kb(loader.length) +
            '   page ' + kb(fs.statSync(PAGE).size));
console.log('RESULT: ALL CHECKS PASSED');
