#!/usr/bin/env node
/**
 * Set "Area Construction Manager" on every Jobs row from its Community.
 *
 *   node dev/backfill-acm.js            # dry run, writes nothing
 *   node dev/backfill-acm.js --apply
 *
 * One-time companion to the derivation the daily sync now does in
 * dev/sync_coe_to_airtable.py. Both read dev/acm-map.json, so there is one
 * mapping and not two -- the sync fills the column going forward, this fills
 * the rows that already existed when the column was created.
 *
 * Salesforce has no ACM on Homesite__c; the assignment is by community and
 * lives in the ACM roster workbook. A community absent from the map is left
 * BLANK rather than guessed: on the Completion Report an empty ACM reads as
 * "not mapped yet", which is true and fixable, where a wrong name does not.
 *
 * Only rows whose stored value differs are written, so a re-run is a no-op and
 * nothing else on the row is touched.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tblqpmwtZ6i4gtogl';
const FIELD = 'Area Construction Manager';
const API = 'https://api.airtable.com/v0';
const PAGE_DELAY_MS = 220;   // Airtable allows 5 req/s/base
const BATCH = 10;            // Airtable caps record writes at 10 per request

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('FAILED: ' + m); process.exit(1); };

/* Environment only, exactly like dev/sync_coe_to_airtable.py -- one way in for
   the token, and nothing that reads it off disk. Never printed, never logged. */
function pat() {
  const v = process.env.AIRTABLE_PAT;
  if (v && v.trim()) return v.trim();
  die('AIRTABLE_PAT is not set. Try:\n' +
      '  AIRTABLE_PAT=$(netlify env:get AIRTABLE_PAT) node dev/backfill-acm.js');
}

const squash = (s) => String(s == null ? '' : s).split(/\s+/).filter(Boolean).join(' ').toUpperCase();

const rawMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'acm-map.json'), 'utf8'));
const MAP = new Map(Object.entries(rawMap).map(([k, v]) => [squash(k), v]));

async function airtable(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (json && json.error && (json.error.message || json.error.type)) || '';
    die('Airtable ' + res.status + ' on ' + method + ' ' + url + (detail ? ': ' + detail : ''));
  }
  return json;
}

async function main() {
  const token = pat();

  const records = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable('GET', `${API}/${BASE_ID}/${JOBS_TABLE}?${qs}`, token);
    records.push(...(page.records || []));
    offset = page.offset || null;
    if (offset) await sleep(PAGE_DELAY_MS);
  } while (offset);

  console.log('read ' + records.length + ' job rows');

  const updates = [];
  const unmapped = new Map();
  let blankCommunity = 0;
  let already = 0;

  for (const r of records) {
    const f = r.fields || {};
    const community = f.Community || '';
    if (!community) { blankCommunity += 1; continue; }

    const want = MAP.get(squash(community)) || '';
    if (!want) {
      unmapped.set(community, (unmapped.get(community) || 0) + 1);
      continue;
    }
    if ((f[FIELD] || '') === want) { already += 1; continue; }
    updates.push({ id: r.id, fields: { [FIELD]: want } });
  }

  console.log('  already correct : ' + already);
  console.log('  to write        : ' + updates.length);
  console.log('  blank Community : ' + blankCommunity);
  console.log('  unmapped        : ' + [...unmapped.values()].reduce((a, b) => a + b, 0) +
    ' rows across ' + unmapped.size + ' communities');
  for (const [c, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
    console.log('      ' + String(n).padStart(4) + '  ' + c);
  }

  if (!updates.length) { console.log('\nnothing to do'); return; }
  if (!APPLY) { console.log('\ndry run -- re-run with --apply to write'); return; }

  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    await airtable('PATCH', `${API}/${BASE_ID}/${JOBS_TABLE}`, token, { records: chunk });
    process.stdout.write('\r  wrote ' + Math.min(i + BATCH, updates.length) + '/' + updates.length);
    await sleep(PAGE_DELAY_MS);
  }
  console.log('\ndone');
}

main().catch((e) => die((e && e.message) || String(e)));
