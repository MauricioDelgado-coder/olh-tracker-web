#!/usr/bin/env node
/* Reproduces the "risk toggle reverts / doesn't show on other pages" bug.
 *
 *   node dev/test-jobs-cache-coherence.js
 *
 * Loads the real netlify/functions/jobs.js and update-job.js in one process
 * (exactly how api/src/index.js hosts them on Azure), with Airtable and the
 * session check stubbed. Exits non-zero if any check fails.
 *
 *  A. Read-after-write: GET /jobs, PATCH Land Risk=true, GET /jobs again
 *     inside the 30s cache window. Must return Land Risk=true.
 *  B. Un-toggle: PATCH Land Risk=false, GET. Must return no Land Risk.
 *  C. In-flight race: a GET that started reading Airtable BEFORE the PATCH
 *     and finishes AFTER it must not re-cache the pre-edit value.
 */
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'netlify');
const REC = 'recAAAAAAAAAAAAA1';

// ---- fake Airtable -------------------------------------------------------
const store = { [REC]: { 'Job #': '1001', Community: 'Test' } };
let pageHook = null; // called between Jobs pages to simulate a slow read
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (opts.method === 'PATCH') {
    const id = decodeURIComponent(u.split('/').pop());
    const fields = JSON.parse(opts.body).fields;
    for (const [k, v] of Object.entries(fields)) {
      if (v === false || v === '' || v == null) delete store[id][k]; else store[id][k] = v;
    }
    return ok({ id, fields: { ...store[id] } }); // Airtable omits false/empty
  }
  if (u.includes('tble8SiAKDLl7eS5D')) return ok({ records: [] });
  if (u.includes('tblqpmwtZ6i4gtogl')) {
    // snapshot BEFORE the hook, like a page Airtable already served
    const snap = Object.entries(store).map(([id, f]) => ({ id, fields: { ...f } }));
    if (pageHook) { const h = pageHook; pageHook = null; await h(); }
    return ok({ records: snap });
  }
  throw new Error('unexpected fetch ' + u);
};

// ---- stub session --------------------------------------------------------
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (/olh-auth$/.test(req)) {
    return {
      requireSession: async () => ({ can: ['tracker.edit'] }),
      fail: (e) => ({ statusCode: e.statusCode || 401, body: JSON.stringify({ error: e.message }) }),
      DENY: {}
    };
  }
  return origLoad.apply(this, arguments);
};
process.env.AIRTABLE_PAT = 'x';

const jobs = require(path.join(ROOT, 'functions', 'jobs.js')).handler;
const upd = require(path.join(ROOT, 'functions', 'update-job.js')).handler;

const get = async () => JSON.parse((await jobs({ httpMethod: 'GET', queryStringParameters: {} })).body);
const patch = async (fields) => {
  const r = await upd({ httpMethod: 'POST', body: JSON.stringify({ recordId: REC, fields }) });
  if (r.statusCode !== 200) throw new Error('update-job ' + r.statusCode + ' ' + r.body);
};
const landRisk = (p) => !!p.jobs.find((j) => j.id === REC).fields['Land Risk'];

let failed = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failed++;
};

(async () => {
  await get(); // prime the 30s cache

  await patch({ 'Land Risk': true });
  let p = await get();
  check('A. toggle ON visible on next read', landRisk(p) === true, 'cached=' + p.meta.cached);

  await patch({ 'Land Risk': false });
  p = await get();
  check('B. toggle OFF visible on next read', landRisk(p) === false, 'cached=' + p.meta.cached);

  // C. force a real refetch that is mid-flight when the PATCH lands
  pageHook = async () => { await patch({ 'Land Risk': true }); };
  const inflight = await JSON.parse((await jobs({ httpMethod: 'GET', queryStringParameters: { refresh: '1' } })).body);
  p = await get();
  check('C. in-flight read does not re-cache pre-edit value', landRisk(p) === true,
    'inflight=' + landRisk(inflight) + ' next cached=' + p.meta.cached);

  console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
