#!/usr/bin/env node
/**
 * Produce the Airtable setup pack for the three walk-data tables:
 *   - import-ready CSVs (roster, drive matrix, product map)
 *   - the 19-community mapping draft, split into safe vs needs-drive-times
 *
 *   node dev/build-walk-setup.js <walk-asset.js> <live-jobs.json> <outdir>
 *
 * dev/ is gitignored and 404'd by netlify.toml.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [ASSET, LIVE, OUT] = process.argv.slice(2);
if (!ASSET || !LIVE || !OUT) {
  console.error('usage: node dev/build-walk-setup.js <walk-asset.js> <live-jobs.json> <outdir>');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const w = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
const CE = function (t, o) { this.type = t; Object.assign(this, o || {}); };
new Function('window', 'CustomEvent', 'Event', 'document', fs.readFileSync(ASSET, 'utf8'))(
  w, CE, CE, { dispatchEvent: () => true });

const ROSTER = w.WALK_ROSTER;
const DRIVE = w.WALK_DRIVE;
const MAP = w.WALK_PRODUCT_MAP;
const COMMS = w.WALK_COMMUNITIES;

const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const liveCount = {};
for (const j of live.jobs) {
  const c = j.fields.Community;
  if (c) liveCount[c] = (liveCount[c] || 0) + 1;
}

/* ---------------------------------------------------------------------------
 * The mapping draft. Products whose prefix already resolves to one of the 27
 * base communities are safe -- an existing sibling product proves the parent.
 * Everything else is a community the drive matrix has never seen, so it cannot
 * be scheduled until someone supplies drive times.
 * ------------------------------------------------------------------------- */
const SAFE = {
  'Brentwood TH': 'Brentwood',
  'Crosswinds 50s': 'Crosswinds',
  'Hunt Club Groves 50s': 'Hunt Club',
  'Ranches at Mcleod 40s CORE': 'Ranches',
  'Ranches at Mcleod 60s': 'Ranches',
  'Waterstone 50': 'Waterstone',
  'Westview 22 TH': 'Westview',
  'Westview 40s GC': 'Westview',
  'Wynnstone 40s': 'Wynnstone'
};

const NEW_COMMUNITY = {
  'Championsgate 3 50 Str': 'Championsgate',
  'Estates at Wellington': 'Estates at Wellington',
  'Hidden Ridge 50': 'Hidden Ridge',
  'Lake Hamilton': 'Lake Hamilton',
  'Lake Hamilton 50s': 'Lake Hamilton',
  "Orchid Terrace 50s": 'Orchid Terrace',
  'Storey Grove 70': 'Storey Grove',
  'Storey Park K 60': 'Storey Park',
  "Waterside 90's": 'Waterside',
  "Whaley's Creek Ph3 50-Land": "Whaley's Creek"
};

const STALE = Object.keys(MAP).filter((k) => !(k in liveCount));

/* --- CSV helpers ---------------------------------------------------------- */
const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (rows) => rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
const write = (name, rows) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, csv(rows));
  console.log('  ' + name.padEnd(34) + (rows.length - 1) + ' rows');
  return p;
};

/* --- 1. Walk Roster ------------------------------------------------------- */
const liveByName = new Map(live.managers.map((m) => [String(m.name).toLowerCase(), m]));
write('airtable-1-walk-roster.csv', [
  ['Person Id', 'Name', 'Role', 'Home Community', 'Matches Live Manager', 'Live Manager Email'],
  ...ROSTER.map((r) => {
    const m = liveByName.get(String(r.name).toLowerCase());
    return [r.id, r.name, r.role, r.home, m ? 'yes' : 'NO — not in Managers table', m ? m.email : ''];
  })
]);

/* --- 2. Drive matrix (long form: one row per ordered pair) ---------------- */
const pairs = [['From Community', 'To Community', 'Drive Minutes']];
for (const from of COMMS) {
  for (const to of COMMS) {
    const v = DRIVE[from] && DRIVE[from][to];
    if (v == null) continue;
    pairs.push([from, to, v]);
  }
}
write('airtable-2-drive-times.csv', pairs);

/* --- 3. Product map ------------------------------------------------------- */
const allProducts = new Set([...Object.keys(MAP), ...Object.keys(liveCount)]);
const rows = [['Product / Community Value', 'Base Community', 'Live Homesites', 'Status']];
for (const p of [...allProducts].sort((a, b) => a.localeCompare(b))) {
  const n = liveCount[p] || 0;
  let base = MAP[p];
  let status;
  if (base && n) status = 'existing — in use';
  else if (base && !n) status = 'existing — STALE, no live homesites';
  else if (SAFE[p]) { base = SAFE[p]; status = 'NEW — safe, parent community already in matrix'; }
  else if (NEW_COMMUNITY[p]) { base = NEW_COMMUNITY[p]; status = 'NEW — needs drive times for a new community'; }
  else { base = ''; status = 'UNCLASSIFIED — review'; }
  rows.push([p, base, n, status]);
}
write('airtable-3-product-map.csv', rows);

/* --- 4. The review sheet -------------------------------------------------- */
const safeRows = Object.entries(SAFE).map(([p, b]) => [p, b, liveCount[p] || 0]);
const newRows = Object.entries(NEW_COMMUNITY).map(([p, b]) => [p, b, liveCount[p] || 0]);
const sum = (rs) => rs.reduce((a, r) => a + r[2], 0);
const newComms = [...new Set(Object.values(NEW_COMMUNITY))];

write('review-19-unmapped-communities.csv', [
  ['Group', 'Live Community Value', 'Proposed Base Community', 'Live Homesites', 'Action Needed'],
  ...safeRows.map((r) => ['A — safe', r[0], r[1], r[2], 'none, confirm the parent looks right']),
  ...newRows.map((r) => ['B — new community', r[0], r[1], r[2], 'drive times to all other communities']),
  ...STALE.map((s) => ['C — stale', s, MAP[s], 0, 'confirm removal'])
]);

console.log('\n--- summary ---');
console.log('Group A (safe, deployable now)     : ' + safeRows.length + ' products, ' + sum(safeRows) + ' homesites');
console.log('Group B (needs drive times)        : ' + newRows.length + ' products, ' + sum(newRows) + ' homesites');
console.log('  new communities to add           : ' + newComms.length + ' (' + newComms.join(', ') + ')');
console.log('  matrix grows                     : ' + COMMS.length + '² = ' + COMMS.length ** 2 +
            '  ->  ' + (COMMS.length + newComms.length) + '² = ' + (COMMS.length + newComms.length) ** 2 + ' cells');
console.log('  new ordered pairs to fill        : ' + ((COMMS.length + newComms.length) ** 2 - COMMS.length ** 2) +
            ' (' + Math.round(((COMMS.length + newComms.length) ** 2 - COMMS.length ** 2) / 2) + ' if symmetric)');
console.log('Group C (stale map keys)           : ' + STALE.length);
console.log('\nCoverage now : ' + sum(safeRows.concat()) + ' recoverable of ' +
            (sum(safeRows) + sum(newRows)) + ' currently-dropped homesites');
