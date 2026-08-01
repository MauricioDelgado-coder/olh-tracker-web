#!/usr/bin/env node
/**
 * Inventory a design-export folder: which pages carry the inline data fixture,
 * the walk reference snapshot, the shared auth module, and their own loadLive.
 *
 *   node dev/probe-export.js <export-folder>
 *
 * Read-only. Used to decide what build-live-pages.js has to patch per page.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node dev/probe-export.js <export-folder>'); process.exit(2); }

const GLOBALS = ['OLH_DATA', 'WALK_ROSTER', 'WALK_DRIVE', 'WALK_PRODUCT_MAP', 'WALK_COMMUNITIES'];

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('page', 24) + pad('fixture', 9) + pad('walkref', 9) +
            pad('auth', 6) + pad('loadLive', 9) + pad('recJOB', 8) + 'inline scripts');

for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).sort()) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  const at = (t) => lines.findIndex((l) => l.includes('<script type="__bundler/' + t + '">')) + 1;
  const ti = at('template');
  if (!ti) { console.log(pad(file, 24) + '(not a bundled export)'); continue; }
  const tpl = JSON.parse(lines[ti]);

  let fixture = false, walkref = false, auth = false, inline = 0;
  const re = /<script\b([^>]*)>/g;
  let m;
  while ((m = re.exec(tpl))) {
    const s = re.lastIndex;
    const close = tpl.indexOf('</script>', s);
    if (close === -1) continue;
    const body = tpl.slice(s, close);
    if (!body.trim()) continue;
    inline += 1;
    const attrs = m[1];
    const plain = !/\bsrc\s*=/.test(attrs) && !/\btype\s*=/.test(attrs);
    if (plain && /(window\.)?OLH_DATA\s*=\s*[[{"\d]/.test(body)) fixture = true;
    if (plain && GLOBALS.slice(1).some((g) => new RegExp('(window\\.)?' + g + '\\s*=\\s*[[{"\\d]').test(body))) walkref = true;
    if (/OLH shared authentication/.test(body)) auth = true;
  }

  console.log(
    pad(file, 24) + pad(fixture ? 'YES' : '-', 9) + pad(walkref ? 'YES' : '-', 9) +
    pad(auth ? 'YES' : '-', 6) + pad(/loadLive/.test(tpl) ? 'YES' : '-', 9) +
    pad(tpl.split('recJOB').length - 1, 8) + inline
  );
}
