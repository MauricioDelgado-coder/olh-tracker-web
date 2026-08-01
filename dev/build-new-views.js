#!/usr/bin/env node
/**
 * Build tracker-new.html — the "OLH Tracker - New Views" design wired to the
 * live Airtable API.
 *
 *   node dev/build-new-views.js <path-to-unzipped-design-export> [outfile]
 *
 * Why this script exists
 * ---------------------------------------------------------------------------
 * The design tool exports two things that matter here:
 *
 *   production/index.html            the *Current* tracker, already bundled and
 *                                    already deployed. Its wrapper is a proven
 *                                    loader: a manifest of gzip+base64 assets
 *                                    (support.js, React, ReactDOM, 5 fonts,
 *                                    olh-data.js) plus the page template.
 *   OLH Tracker - New Views.dc.html  the *new* design, as loose source that
 *                                    references ./support.js, olh-data.js and
 *                                    fonts/* by relative path.
 *
 * The new design is a prototype: it renders from the static window.OLH_DATA
 * snapshot rather than GET /api/jobs. Both documents read that same global with
 * the same {id, fields} Airtable shape, so this is not a rewrite — it grafts
 * the Current tracker's loadLive() onto New Views and lets it overwrite
 * window.OLH_DATA on mount.
 *
 * So: take the wrapper and manifest from production/index.html verbatim, and
 * swap in the patched New Views template. Nothing about asset loading, React
 * boot order or font resolution changes — that part already works in prod.
 *
 * olh-data.js stays in the manifest and stays referenced, becoming the
 * fallback: if /api/jobs is unreachable the page shows the bundled snapshot
 * instead of going blank, and state.live records which one is on screen.
 *
 * This file lives in dev/, which is gitignored and 404'd by netlify.toml. It is
 * a build tool, not part of the deployed site.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const SRC = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, '..', 'tracker-new.html');

if (!SRC) {
  console.error('usage: node dev/build-new-views.js <unzipped-design-export-dir> [outfile]');
  process.exit(2);
}

const die = (msg) => { console.error('BUILD FAILED: ' + msg); process.exit(1); };
const read = (p) => {
  if (!fs.existsSync(p)) die('missing input: ' + p);
  return fs.readFileSync(p, 'utf8');
};

// ---------------------------------------------------------------------------
// 1. Load the shipped bundle and locate its manifest / template payloads.
// ---------------------------------------------------------------------------
const bundle = read(path.join(SRC, 'production', 'index.html'));
const lines = bundle.split('\n');

const findPayload = (type) => {
  const open = lines.findIndex((l) => l.includes('<script type="__bundler/' + type + '">'));
  if (open === -1) die('no __bundler/' + type + ' block in production/index.html');
  return open + 1; // the payload sits alone on the next line
};

const iManifest = findPayload('manifest');
const iTemplate = findPayload('template');

let manifest;
try { manifest = JSON.parse(lines[iManifest]); }
catch (e) { die('manifest is not valid JSON: ' + e.message); }

// ---------------------------------------------------------------------------
// 2. Map each loose asset path to its manifest uuid by content hash.
//
// Hardcoding uuids would silently rot the next time the design tool re-exports
// with fresh ids. Hashing decompressed manifest bytes against the files on disk
// means a re-export either matches or fails the build loudly.
// ---------------------------------------------------------------------------
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const byHash = new Map();
for (const [uuid, entry] of Object.entries(manifest)) {
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) {
    try { buf = zlib.gunzipSync(buf); }
    catch (e) { die('cannot gunzip manifest entry ' + uuid + ': ' + e.message); }
  }
  byHash.set(md5(buf), uuid);
}

// Relative paths exactly as they appear in the New Views source.
const ASSETS = [
  './support.js',
  'olh-data.js',
  'fonts/Reckless-Light.woff2',
  'fonts/ttcommons-regular.ttf',
  'fonts/ttcommons-medium.ttf',
  'fonts/ttcommons-demibold.ttf',
  'fonts/ttcommons-bold.ttf'
];

const uuidFor = {};
for (const rel of ASSETS) {
  const onDisk = path.join(SRC, rel.replace(/^\.\//, ''));
  if (!fs.existsSync(onDisk)) die('design export is missing ' + rel);
  const uuid = byHash.get(md5(fs.readFileSync(onDisk)));
  if (!uuid) {
    die(rel + ' does not match any asset in the shipped manifest.\n' +
        '  The export was probably rebuilt after production/index.html was\n' +
        '  bundled. Re-bundle from this same export, then rerun.');
  }
  uuidFor[rel] = uuid;
}

// ---------------------------------------------------------------------------
// 3. Patch the New Views source to add the live fetch layer.
// ---------------------------------------------------------------------------
let doc = read(path.join(SRC, 'OLH Tracker - New Views.dc.html'));

// Every patch asserts a single match, so a design re-export that moves this
// code fails the build rather than quietly shipping a page still on snapshot.
const sub = (label, find, replace) => {
  const n = doc.split(find).length - 1;
  if (n !== 1) die('patch "' + label + '" matched ' + n + ' times, expected exactly 1');
  doc = doc.replace(find, replace);
};

// 3a. Declare apiBase so the design tool and the runtime agree it is a prop.
sub('apiBase prop',
  'data-props="{&quot;$preview&quot;',
  'data-props="{&quot;apiBase&quot;:{&quot;editor&quot;:&quot;text&quot;,' +
  '&quot;default&quot;:&quot;/api&quot;,&quot;tsType&quot;:&quot;string&quot;,' +
  '&quot;section&quot;:&quot;Data&quot;},&quot;$preview&quot;');

// 3b. Track load state next to the existing prototype state.
sub('state',
  '    onlySoon: false, onlyRisk: false\n  };',
  '    onlySoon: false, onlyRisk: false,\n' +
  "    live: false, loading: false, loadError: ''\n  };");

// 3c. The fetch layer, lifted from OLH Tracker - Current so both pages share a
//     single contract with netlify/functions/jobs.js.
sub('loadLive', '  componentDidMount(){',
`  apiBase(){ const b = (this.props.apiBase || '').trim(); return b.replace(/\\/$/, '') || '/api'; }

  /* Live data path. Same contract as netlify/functions/jobs.js:
       GET {apiBase}/jobs -> { jobs:[{id,fields}], managers:[{id,name,active}] }
     The bundled Dynamics-export snapshot has already populated window.OLH_DATA
     by the time this runs, so a failure degrades to stale sample records rather
     than an empty page. state.live records which of the two is on screen. */
  async loadLive(force){
    this.setState({loading:true});
    try{
      const res = await fetch(this.apiBase() + '/jobs' + (force ? '?refresh=1' : ''),
        {headers:{Accept:'application/json'}});
      const data = await res.json().catch(() => null);
      if(!res.ok || !data || !Array.isArray(data.jobs)){
        throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      }
      window.OLH_DATA = {
        jobs: data.jobs,
        managers: data.managers || [],
        today: new Date(),
        source: 'airtable',
        sourceLabel: 'Airtable \\u00b7 ' + data.jobs.length.toLocaleString() + ' homesites'
      };
      this.setState(s => ({live:true, loading:false, loadError:'', tick:s.tick+1}));
    }catch(err){
      const msg = (err && err.message) || String(err);
      this.setState(s => ({live:false, loading:false, loadError:msg, tick:s.tick+1}));
      console.warn('[olh] live load failed, showing bundled snapshot instead:', msg);
    }
  }

  componentDidMount(){`);

// 3d. Fetch on mount.
sub('mount call',
  "    if(!window.OLH_DATA) window.addEventListener('olh-data', () => this.setState({tick:1}));\n    this.sync();",
  "    if(!window.OLH_DATA) window.addEventListener('olh-data', () => this.setState({tick:1}));\n" +
  '    this.sync();\n    this.loadLive(false);');

// ---------------------------------------------------------------------------
// 4. Repoint relative asset references at manifest uuids.
// ---------------------------------------------------------------------------
for (const rel of ASSETS) {
  const before = doc;
  doc = doc.split('"' + rel + '"').join('"' + uuidFor[rel] + '"');
  if (doc === before) die('no reference to ' + rel + ' found in the New Views source');
}

if (/(?:src=|url\()["']?(?:\.\/)?(?:fonts\/|support\.js|olh-data\.js)/.test(doc)) {
  die('a relative asset reference survived rewriting');
}

// ---------------------------------------------------------------------------
// 5. Reassemble: shipped wrapper + shipped manifest + patched template.
// ---------------------------------------------------------------------------
// The payload is JSON *inside* a <script> element, so a literal "</script>" in
// the template would close that element early and leave the JSON truncated —
// which is exactly the "Unterminated string in JSON" the loader reports. The
// shipped bundle escapes the slash as a / JSON escape; JSON.parse restores
// it and the HTML parser never sees a close tag. Match that.
const payload = JSON.stringify(doc).split('</').join('<\\u002F');
if (payload.includes('</')) die('failed to neutralise a close tag in the payload');
lines[iTemplate] = payload;
fs.writeFileSync(OUT, lines.join('\n'));

// Re-parse the emitted file the way the browser loader does, so a malformed
// payload fails here rather than as a blank page in production.
{
  const check = fs.readFileSync(OUT, 'utf8').split('\n');
  let round;
  try { round = JSON.parse(check[iTemplate]); }
  catch (e) { die('emitted template payload is not valid JSON: ' + e.message); }
  if (round !== doc) die('template payload does not round-trip');
  try { JSON.parse(check[iManifest]); }
  catch (e) { die('emitted manifest payload is not valid JSON: ' + e.message); }
  if (!/loadLive/.test(round) || !/apiBase/.test(round)) die('patched template lost the fetch layer');
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('wrote ' + OUT + '  (' + kb(fs.statSync(OUT).size) + ')');
console.log('  template : ' + kb(doc.length) + ' — New Views, patched for live /api/jobs');
console.log('  manifest : ' + Object.keys(manifest).length + ' assets, reused verbatim');
for (const rel of ASSETS) console.log('    ' + rel.padEnd(30) + uuidFor[rel]);
