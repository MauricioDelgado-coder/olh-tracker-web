#!/usr/bin/env node
/**
 * Work out which Opportunity date Airtable's "Scheduled Closing Date" came from.
 *
 *   AIRTABLE_PAT=... node dev/check-opp-close.js /tmp/opp-close.csv
 *
 * Homesite__c has no field matching it -- the value lives on the related
 * Opportunity, reached through Primary_Opportunity_ID__r. Several candidates have
 * near-identical labels ("Closing Date" appears twice, on Closing_Date__c and
 * Close_Date__c), so the right one is decided by agreement against the values
 * already in Airtable rather than by reading labels.
 */
'use strict';

const fs = require('fs');

const BASE = 'appYX9df4lGO6G2uz';
const JOBS = 'tblqpmwtZ6i4gtogl';
const API = 'https://api.airtable.com/v0';
const PAT = process.env.AIRTABLE_PAT;
const csvPath = process.argv[2];
if (!PAT || !csvPath) { console.error('usage: AIRTABLE_PAT=... node dev/check-opp-close.js <csv>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (v) => (v ? String(v).slice(0, 10) : '');

/** Minimal CSV reader: these fields are dates and job numbers, no embedded commas. */
function readCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const hdr = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const o = {};
    hdr.forEach((h, i) => { o[h.trim()] = (c[i] || '').trim(); });
    return o;
  });
}

async function allJobs() {
  const recs = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(`${API}/${BASE}/${JOBS}?${qs}`, { headers: { Authorization: 'Bearer ' + PAT } });
    if (!res.ok) { console.error('Airtable ' + res.status); process.exit(1); }
    const j = await res.json();
    recs.push(...(j.records || []));
    offset = j.offset || null;
    if (offset) await sleep(220);
  } while (offset);
  return recs;
}

(async () => {
  const rows = readCsv(fs.readFileSync(csvPath, 'utf8'));
  const byJob = new Map(rows.map((r) => [r.Name, r]));

  const air = new Map();
  for (const r of await allJobs()) {
    const f = r.fields || {};
    const job = String(f['Job #'] || '').trim();
    if (job) air.set(job, f);
  }

  const cols = Object.keys(rows[0]).filter((c) => c !== 'Name');
  const both = [...byJob.keys()].filter((j) => air.has(j));
  console.log('rows from Salesforce: ' + rows.length + ' | overlapping with Airtable: ' + both.length + '\n');

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Opportunity field', 52) + pad('populated', 11) + pad('both set', 10) + pad('agree', 8) + '%');
  console.log('-'.repeat(88));

  for (const c of cols) {
    let populated = 0;
    let bothSet = 0;
    let agree = 0;
    for (const j of both) {
      const sv = day(byJob.get(j)[c]);
      const av = day(air.get(j)['Scheduled Closing Date']);
      if (sv) populated += 1;
      if (!sv || !av) continue;
      bothSet += 1;
      if (sv === av) agree += 1;
    }
    const pct = bothSet ? ((agree / bothSet) * 100).toFixed(1) : '--';
    console.log(pad(c.replace('Primary_Opportunity_ID__r.', 'Opp.'), 52) +
                pad(populated, 11) + pad(bothSet, 10) + pad(agree, 8) + pct);
  }

  const withAir = both.filter((j) => day(air.get(j)['Scheduled Closing Date'])).length;
  console.log('\nAirtable rows with Scheduled Closing Date set: ' + withAir + ' of ' + both.length);
})();
