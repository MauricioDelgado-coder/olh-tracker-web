#!/usr/bin/env node
/**
 * One-time move of SAN data from the OLH base to the SAN base.
 *
 *   node dev/migrate-san-base.js            # copy Jobs + SAN audit history
 *   node dev/migrate-san-base.js --verify   # compare old vs new, field by field
 *
 * Copies:
 *   Jobs (Sandbox - SAN)  appYX9df4lGO6G2uz/tbltB2CIKBumT6sMK
 *     -> Jobs             appmo8ardxfpsohWH/tblRtKV7IRC6Yd7ce
 *   OLH Audit Log rows whose Record Id is a SAN job
 *     -> SAN Audit Log    appmo8ardxfpsohWH/tblPFPM1OlFbGTKbF  (Record Id remapped)
 *
 * Nothing in the OLH base is changed or deleted. The old rows stay where they
 * are: the OLH Audit Log is append-only, and the old SAN tables are the
 * fallback until the new base has run clean for a while.
 *
 * Refuses to copy into a SAN Jobs table that already has rows, so it cannot
 * double-load. Record-id map is written to dev/san-migration-map.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API = 'https://api.airtable.com/v0';
const OLD = { base: 'appYX9df4lGO6G2uz', jobs: 'tbltB2CIKBumT6sMK', managers: 'tbl5001ngiOsxp49i', audit: 'tblgiEqKXRbBHLg1i' };
const NEW = { base: 'appmo8ardxfpsohWH', jobs: 'tblRtKV7IRC6Yd7ce', managers: 'tblXKnoUr6DTVyfnm', audit: 'tblPFPM1OlFbGTKbF' };
const LINK_FIELDS = ['QAI Manager', 'QAA Manager', 'CEL Manager', 'ACC Manager'];
const AUDIT_FIELDS = ['Entry Id', 'Record Id', 'Job #', 'Field', 'Label', 'From', 'To', 'Action',
  'Page', 'Changed By', 'Changed By Id', 'Changed By Role', 'Changed At'];
const MAP_FILE = path.join(__dirname, 'san-migration-map.json');
const DELAY = 220;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pat() {
  if (process.env.AIRTABLE_PAT) return process.env.AIRTABLE_PAT.trim();
  return execSync('security find-generic-password -s olh-tracker-airtable-pat -w', { encoding: 'utf8' }).trim();
}
const PAT = pat();

async function call(method, base, suffix, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + '/' + base + suffix, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + PAT }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(1000 * attempt); continue; }
    throw new Error(method + ' ' + base + suffix.split('?')[0] + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 400));
  }
}

async function listAll(base, table) {
  for (let restart = 0; restart < 4; restart++) {
    const out = [];
    let offset = null;
    try {
      do {
        const qs = new URLSearchParams({ pageSize: '100' });
        if (offset) qs.set('offset', offset);
        const j = await call('GET', base, '/' + table + '?' + qs.toString());
        out.push(...j.records);
        offset = j.offset || null;
        if (offset) await sleep(DELAY);
      } while (offset);
      return out;
    } catch (e) {
      // Airtable expires a pagination offset after a few minutes; start over.
      if (!/LIST_RECORDS_ITERATOR_NOT_AVAILABLE/.test(e.message)) throw e;
      console.warn('  offset expired, restarting listing of ' + table);
    }
  }
  throw new Error('Could not list ' + table + ' -- offset kept expiring.');
}

async function createBatched(base, table, rows, label) {
  const ids = [];
  for (let i = 0; i < rows.length; i += 10) {
    const j = await call('POST', base, '/' + table, { records: rows.slice(i, i + 10).map((fields) => ({ fields })) });
    ids.push(...j.records.map((r) => r.id));
    if ((i / 10) % 50 === 0) console.log('  ' + label + ': ' + Math.min(i + 10, rows.length) + '/' + rows.length);
    await sleep(DELAY);
  }
  return ids;
}

const norm = (v) => (v === undefined || v === null || v === '' || v === false ? null : JSON.stringify(v));

async function verify() {
  const [oldJobs, newJobs] = [await listAll(OLD.base, OLD.jobs), await listAll(NEW.base, NEW.jobs)];
  const byJob = new Map(newJobs.map((r) => [r.fields['Job #'], r]));
  const diffs = [];
  for (const o of oldJobs) {
    const n = byJob.get(o.fields['Job #']);
    if (!n) { diffs.push(o.fields['Job #'] + ': missing in SAN base'); continue; }
    const keys = new Set([...Object.keys(o.fields), ...Object.keys(n.fields)]);
    for (const k of keys) {
      if (LINK_FIELDS.includes(k)) continue;
      if (norm(o.fields[k]) !== norm(n.fields[k])) diffs.push(o.fields['Job #'] + ' / ' + k + ': ' + norm(o.fields[k]) + ' -> ' + norm(n.fields[k]));
    }
  }
  console.log('old ' + oldJobs.length + ' rows, new ' + newJobs.length + ' rows, ' + diffs.length + ' differences');
  diffs.slice(0, 40).forEach((d) => console.log('  ' + d));
  process.exit(diffs.length || oldJobs.length !== newJobs.length ? 1 : 0);
}

async function migrate() {
  const existing = await call('GET', NEW.base, '/' + NEW.jobs + '?pageSize=1');
  if (existing.records.length) throw new Error('SAN base Jobs already has rows -- refusing to copy twice. Use --verify.');

  const oldMgrs = await call('GET', OLD.base, '/' + OLD.managers + '?pageSize=1');
  if (oldMgrs.records.length) throw new Error('Old SAN Managers is no longer empty -- link remapping is needed and not implemented.');

  console.log('Reading old SAN Jobs...');
  const oldJobs = await listAll(OLD.base, OLD.jobs);
  const linked = oldJobs.filter((r) => LINK_FIELDS.some((k) => Array.isArray(r.fields[k]) && r.fields[k].length));
  if (linked.length) throw new Error(linked.length + ' SAN jobs have manager links -- remapping needed, aborting.');
  console.log('  ' + oldJobs.length + ' rows');

  const newIds = await createBatched(NEW.base, NEW.jobs, oldJobs.map((r) => r.fields), 'Jobs');
  const idMap = {};
  oldJobs.forEach((r, i) => { idMap[r.id] = newIds[i]; });
  fs.writeFileSync(MAP_FILE, JSON.stringify({ createdAt: new Date().toISOString(), from: OLD, to: NEW, jobs: idMap }, null, 2));
  console.log('  wrote ' + path.relative(process.cwd(), MAP_FILE));

  console.log('Reading OLH Audit Log...');
  const audit = await listAll(OLD.base, OLD.audit);
  const sanRows = audit.filter((r) => idMap[r.fields['Record Id']]);
  console.log('  ' + audit.length + ' rows, ' + sanRows.length + ' belong to SAN jobs');
  const auditRows = sanRows.map((r) => {
    const f = {};
    for (const k of AUDIT_FIELDS) if (r.fields[k] !== undefined) f[k] = r.fields[k];
    f['Record Id'] = idMap[r.fields['Record Id']];
    return f;
  });
  if (auditRows.length) await createBatched(NEW.base, NEW.audit, auditRows, 'Audit');

  console.log('Done: ' + newIds.length + ' jobs, ' + auditRows.length + ' audit rows copied.');
}

(process.argv.includes('--verify') ? verify() : migrate()).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
