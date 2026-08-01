#!/usr/bin/env node
/**
 * Seed the three walk-data tables in appYX9df4lGO6G2uz from the extracted
 * bundle asset. Idempotent-ish: refuses to run if a table already has records,
 * so a rerun cannot double-insert.
 *
 *   node dev/seed-walk-tables.js <walk-asset.js> <live-jobs.json> [--go]
 *
 * Without --go it is a dry run and writes nothing.
 *
 * The PAT is read from ~/.config/olh-qa-tracker/config.json and is never
 * printed, logged or written anywhere. dev/ is gitignored and 404'd.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const [ASSET, LIVE] = process.argv.slice(2);
const GO = process.argv.includes('--go');
if (!ASSET || !LIVE) {
  console.error('usage: node dev/seed-walk-tables.js <walk-asset.js> <live-jobs.json> [--go]');
  process.exit(2);
}

const PAT = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/olh-qa-tracker/config.json'), 'utf8')
).airtable_pat;
if (!PAT) { console.error('no airtable_pat in local config'); process.exit(1); }

const BASE = 'appYX9df4lGO6G2uz';
const T_ROSTER = 'tblhDm8OD4jSR0tey';
const T_DRIVE = 'tblVnYFUc4xuovVEC';
const T_MAP = 'tblvkWF5QULxhqFiX';
const API = 'https://api.airtable.com/v0';

const F = {
  roster: { personId: 'fldqmFuxPY0W8jHHz', name: 'fldKRuy06aNp8hXKU', role: 'fldoATuFKE60qHdd0',
            home: 'fldAer4brpeGanAyB', active: 'fldBXrgIn4sSjgUi7', notes: 'fldloHiAuqXCv7s9G' },
  drive:  { pair: 'fld1MjUAbznTRdRd4', from: 'fld2rIebF0fkD0DHw', to: 'fldsM9YZ9nOnlEx2u',
            minutes: 'fld3vLNFUGbBesPYd' },
  map:    { product: 'fldC7lQRGvXEXiQtW', base: 'flddPaLcxCUuHT534', status: 'fldLjj2yhvEcuhhFF',
            live: 'fldXkixFzTIRjrNko' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function air(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Never echo the request body — it is data, not secrets, but keep output tight.
    throw new Error(method + ' ' + url.split('?')[0] + ' -> ' + res.status + ' ' +
      ((json && json.error && (json.error.message || json.error.type)) || ''));
  }
  return json;
}

async function count(tableId) {
  const j = await air('GET', `${API}/${BASE}/${tableId}?pageSize=1`);
  return (j.records || []).length;
}

/* Airtable caps 10 records per create call and 5 req/s per base. */
async function insert(tableId, records, label) {
  let done = 0;
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    await air('POST', `${API}/${BASE}/${tableId}`, { records: chunk, typecast: false });
    done += chunk.length;
    process.stdout.write('\r  ' + label + ': ' + done + '/' + records.length);
    if (i + 10 < records.length) await sleep(220);
  }
  process.stdout.write('\r  ' + label + ': ' + done + '/' + records.length + ' done\n');
}

/* --- load the extracted reference data ------------------------------------ */
const w = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
const CE = function (t, o) { this.type = t; Object.assign(this, o || {}); };
new Function('window', 'CustomEvent', 'Event', 'document', fs.readFileSync(ASSET, 'utf8'))(
  w, CE, CE, { dispatchEvent: () => true });

const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const liveCount = {};
for (const j of live.jobs) { const c = j.fields.Community; if (c) liveCount[c] = (liveCount[c] || 0) + 1; }

const SAFE = {
  'Brentwood TH': 'Brentwood', 'Crosswinds 50s': 'Crosswinds', 'Hunt Club Groves 50s': 'Hunt Club',
  'Ranches at Mcleod 40s CORE': 'Ranches', 'Ranches at Mcleod 60s': 'Ranches',
  'Waterstone 50': 'Waterstone', 'Westview 22 TH': 'Westview', 'Westview 40s GC': 'Westview',
  'Wynnstone 40s': 'Wynnstone'
};
const NEWC = {
  'Championsgate 3 50 Str': 'Championsgate', 'Estates at Wellington': 'Estates at Wellington',
  'Hidden Ridge 50': 'Hidden Ridge', 'Lake Hamilton': 'Lake Hamilton', 'Lake Hamilton 50s': 'Lake Hamilton',
  'Orchid Terrace 50s': 'Orchid Terrace', 'Storey Grove 70': 'Storey Grove',
  'Storey Park K 60': 'Storey Park', "Waterside 90's": 'Waterside',
  "Whaley's Creek Ph3 50-Land": "Whaley's Creek"
};

const liveByName = new Map(live.managers.map((m) => [String(m.name).toLowerCase(), m]));

const rosterRecs = w.WALK_ROSTER.map((r) => {
  const matched = liveByName.has(String(r.name).toLowerCase());
  const homeKnown = w.WALK_COMMUNITIES.includes(r.home);
  const notes = [
    matched ? null : 'Not found in the Managers table',
    homeKnown ? null : 'Home Community "' + r.home + '" is not one of the 27 base communities — needs review'
  ].filter(Boolean).join('; ');
  return { fields: {
    [F.roster.personId]: r.id,
    [F.roster.name]: r.name,
    [F.roster.role]: r.role,
    [F.roster.home]: r.home,
    [F.roster.active]: true,
    ...(notes ? { [F.roster.notes]: notes } : {})
  } };
});

const driveRecs = [];
for (const from of w.WALK_COMMUNITIES) {
  for (const to of w.WALK_COMMUNITIES) {
    const v = w.WALK_DRIVE[from] && w.WALK_DRIVE[from][to];
    if (v == null) continue;
    driveRecs.push({ fields: {
      [F.drive.pair]: from + ' > ' + to,
      [F.drive.from]: from,
      [F.drive.to]: to,
      [F.drive.minutes]: v
    } });
  }
}

const allProducts = new Set([...Object.keys(w.WALK_PRODUCT_MAP), ...Object.keys(liveCount)]);
const mapRecs = [...allProducts].sort((a, b) => a.localeCompare(b)).map((p) => {
  const n = liveCount[p] || 0;
  let base = w.WALK_PRODUCT_MAP[p];
  let status;
  if (base === 'Removed / Excluded') { status = 'Removed / Excluded'; base = ''; }
  else if (base && n) status = 'existing — in use';
  else if (base && !n) status = 'existing — STALE, no live homesites';
  else if (SAFE[p]) { base = SAFE[p]; status = 'NEW — safe, parent already in matrix'; }
  else if (NEWC[p]) { base = NEWC[p]; status = 'NEW — needs drive times'; }
  else { base = ''; status = 'NEW — needs drive times'; }
  return { fields: {
    [F.map.product]: p,
    ...(base ? { [F.map.base]: base } : {}),
    [F.map.status]: status,
    [F.map.live]: n
  } };
});

(async () => {
  console.log('plan:');
  console.log('  Walk Roster       ' + rosterRecs.length + ' records');
  console.log('  Walk Drive Times  ' + driveRecs.length + ' records');
  console.log('  Walk Product Map  ' + mapRecs.length + ' records');

  for (const [id, label] of [[T_ROSTER, 'Walk Roster'], [T_DRIVE, 'Walk Drive Times'], [T_MAP, 'Walk Product Map']]) {
    const n = await count(id);
    if (n > 0) { console.error('\nABORT: ' + label + ' already has records. Refusing to double-insert.'); process.exit(1); }
  }
  console.log('  all three tables are empty — safe to seed');

  if (!GO) { console.log('\ndry run. rerun with --go to write.'); return; }

  console.log('\nwriting:');
  await insert(T_ROSTER, rosterRecs, 'Walk Roster');
  await insert(T_DRIVE, driveRecs, 'Walk Drive Times');
  await insert(T_MAP, mapRecs, 'Walk Product Map');
  console.log('\nseeded.');
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
