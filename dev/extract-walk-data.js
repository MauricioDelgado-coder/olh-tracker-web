#!/usr/bin/env node
/**
 * Extract the WALK_* reference assets out of a bundled page's manifest and
 * report their shape, so we can spec an endpoint for them.
 *
 *   node dev/extract-walk-data.js <bundle.html> [outdir]
 *
 * Read-only against the bundle. If outdir is given, decompressed assets are
 * written there for inspection. dev/ is gitignored and 404'd by netlify.toml.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC) { console.error('usage: node dev/extract-walk-data.js <bundle.html> [outdir]'); process.exit(2); }
if (OUT) fs.mkdirSync(OUT, { recursive: true });

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const i = lines.findIndex((l) => l.includes('<script type="__bundler/manifest">'));
if (i === -1) { console.error('no manifest block'); process.exit(1); }
const manifest = JSON.parse(lines[i + 1]);

const GLOBALS = ['WALK_ROSTER', 'WALK_DRIVE', 'WALK_PRODUCT_MAP', 'WALK_COMMUNITIES', 'OLH_DATA', 'COMPLETION_DATA'];

for (const [uuid, e] of Object.entries(manifest)) {
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) { try { buf = zlib.gunzipSync(buf); } catch (_) { continue; } }
  const txt = buf.toString('utf8');

  // Skip binaries (fonts, images).
  if (/�/.test(txt.slice(0, 200)) || /^wOF2|^\x00\x01\x00\x00|^\x89PNG/.test(buf.slice(0, 4).toString('latin1'))) continue;

  const hits = GLOBALS.filter((g) => new RegExp('(window\\.)?' + g + '\\s*=').test(txt));
  if (!hits.length) continue;

  console.log('\n=== ' + uuid + '  ' + (buf.length / 1024).toFixed(0) + ' KB  defines: ' + hits.join(', ') + ' ===');
  if (OUT) {
    const f = path.join(OUT, hits[0].toLowerCase() + '.' + uuid.slice(0, 8) + '.js');
    fs.writeFileSync(f, txt);
    console.log('  written: ' + f);
  }

  // Evaluate the asset in a bare sandbox to read the real structures.
  const sandbox = { window: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {}
  } };
  const CE = function (t, o) { this.type = t; Object.assign(this, o || {}); };
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'CustomEvent', 'Event', 'document', txt + '\n;')(
      sandbox.window, CE, CE, { dispatchEvent: () => true });
  } catch (err) {
    console.log('  (could not evaluate standalone: ' + err.message + ')');
    continue;
  }

  for (const g of hits) {
    const v = sandbox.window[g];
    if (v === undefined) { console.log('  ' + g + ': not on window after eval'); continue; }
    describe(g, v);
  }
}

function describe(name, v, indent = '  ') {
  if (Array.isArray(v)) {
    console.log(indent + name + ' : Array(' + v.length + ')');
    if (v.length) {
      const keys = typeof v[0] === 'object' && v[0] ? Object.keys(v[0]) : null;
      if (keys) {
        console.log(indent + '  keys: ' + keys.join(', '));
        console.log(indent + '  sample: ' + JSON.stringify(v[0]).slice(0, 300));
        const types = {};
        for (const k of keys) types[k] = typeof (v.find((r) => r && r[k] != null) || {})[k];
        console.log(indent + '  types: ' + JSON.stringify(types));
      } else {
        console.log(indent + '  sample: ' + JSON.stringify(v.slice(0, 5)));
      }
    }
    return;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    console.log(indent + name + ' : Object(' + keys.length + ' keys)');
    console.log(indent + '  keys: ' + keys.slice(0, 12).join(', ') + (keys.length > 12 ? ' …' : ''));
    const k0 = keys[0];
    if (k0 !== undefined) console.log(indent + '  sample[' + k0 + ']: ' + JSON.stringify(v[k0]).slice(0, 300));
    return;
  }
  console.log(indent + name + ' : ' + typeof v + ' = ' + JSON.stringify(v).slice(0, 120));
}
