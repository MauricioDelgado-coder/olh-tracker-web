#!/usr/bin/env node
/**
 * Dump the inline <script> blocks of a bundled design export to a folder, so the
 * shared modules (auth, breakpoint, xlsx writer) can be read and diffed as real
 * files instead of grepped through a 2 MB single-line bundle.
 *
 *   node dev/extract-inline-scripts.js <bundle.html> <out-dir>
 *
 * Writes NN-<slug>.js per inline script, plus template.html for the shell.
 * Read-only: it never modifies the input.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error('usage: node dev/extract-inline-scripts.js <bundle.html> <out-dir>');
  process.exit(2);
}

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const findBlock = (type) => {
  const i = lines.findIndex((l) => l.includes('<script type="__bundler/' + type + '">'));
  if (i === -1) { console.error('no __bundler/' + type + ' block'); process.exit(1); }
  return i + 1;
};
const template = JSON.parse(lines[findBlock('template')]);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'template.html'), template);

const slug = (body) => {
  const m = body.match(/\/\*+\s*([^\n*]{4,70})/);
  const raw = m ? m[1] : (body.slice(0, 60).replace(/\s+/g, ' '));
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 46) || 'anon';
};

const re = /<script\b([^>]*)>/g;
let m;
let n = 0;
while ((m = re.exec(template))) {
  const start = re.lastIndex;
  const end = template.indexOf('</script>', start);
  if (end === -1) continue;
  const body = template.slice(start, end);
  if (!body.trim()) continue; // <script src=...> asset reference
  const name = String(n).padStart(2, '0') + '-' + slug(body) + '.js';
  fs.writeFileSync(path.join(OUT, name), body);
  console.log(name.padEnd(56) + (body.length / 1024).toFixed(0) + ' KB' +
              (m[1].trim() ? '   attrs: ' + m[1].trim().slice(0, 60) : ''));
  n += 1;
}
console.log('\n' + n + ' inline scripts -> ' + OUT);
