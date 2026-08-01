#!/usr/bin/env node
/**
 * Syntax-check every text asset in a bundled export's manifest.
 *
 *   node dev/check-assets.js <bundle.html>
 *
 * The bundler appends each asset to the document as a <script>, so one asset
 * that is not valid JavaScript throws "Failed to execute 'appendChild'" and is
 * silently never evaluated -- the page still renders, minus whatever that asset
 * provided. This finds which one.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('usage: node dev/check-assets.js <bundle.html>'); process.exit(2); }

const lines = fs.readFileSync(file, 'utf8').split('\n');
const at = (t) => lines.findIndex((l) => l.includes('<script type="__bundler/' + t + '">')) + 1;
const manifest = JSON.parse(lines[at('manifest')]);

let bad = 0;
for (const [uuid, entry] of Object.entries(manifest)) {
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) { try { buf = zlib.gunzipSync(buf); } catch (_) { continue; } }
  const head = buf.slice(0, 4).toString('latin1');
  if (/^wOF2|^\x00\x01\x00\x00|^\x89PNG|^OTTO|^true/.test(head)) continue;

  const src = buf.toString('utf8');
  const kb = (buf.length / 1024).toFixed(0) + ' KB';
  const first = src.trim().slice(0, 70).replace(/\s+/g, ' ');
  try {
    new vm.Script(src, { filename: uuid });
    console.log('  ok    ' + uuid + '  ' + kb.padStart(8) + '   ' + first);
  } catch (e) {
    bad += 1;
    console.log('  FAIL  ' + uuid + '  ' + kb.padStart(8) + '   ' + first);
    console.log('        ' + e.message);
    // Show the offending line.
    const m = /:(\d+)$/.exec(e.stack.split('\n')[0]) || [];
    const ln = Number((e.stack.split('\n')[0].match(/:(\d+)/) || [])[1]);
    if (ln) {
      const around = src.split('\n').slice(Math.max(0, ln - 2), ln + 1);
      around.forEach((l, i) => console.log('        ' + (ln - 1 + i) + '| ' + l.slice(0, 140)));
    }
    void m;
  }
}
console.log(bad ? '\n' + bad + ' asset(s) are not valid JavaScript' : '\nall text assets parse');
process.exit(bad ? 1 : 0);
