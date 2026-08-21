#!/usr/bin/env node
/**
 * End-to-end test of homesite.html's write path, in real Chrome.
 *
 *   npm i --no-save puppeteer-core && node dev/test-homesite-e2e.js
 *
 * WHY THIS EXISTS
 *
 * Four bugs shipped on this one path on 2026-08-21, each hidden by the one in
 * front of it:
 *
 *   1. loadLive/persist sent no Authorization header  -> every call 401'd
 *   2. the audit entry was written before the PATCH   -> history recorded
 *                                                        changes that never
 *                                                        happened
 *   3. loadLive ran before OLHAuth.restore() resolved -> state.live never true,
 *                                                        so every edit was
 *                                                        silently discarded
 *   4. the manager dropdown emitted roster Person Ids -> Airtable rejected the
 *                                                        linked-record write
 *
 * Every one was found by a person clicking the page. Unit tests on lifted
 * methods caught none of them, because each lived in a seam -- mount ordering,
 * header assembly, an id namespace crossing between two tables -- and seams
 * only exist when the whole page runs.
 *
 * HOW
 *
 * Loads the BUILT page in headless Chrome with the API stubbed at the network
 * layer, so no credentials are involved. OLHAuth is a stub whose restore()
 * resolves LATE on purpose (that is bug 3's timing), /api/jobs and
 * /api/walk-config return fixtures shaped like the real endpoints, and
 * /api/update-job records whatever the page sends. Then it drives the real
 * <select> and asserts on the request that actually left the page.
 */

'use strict';

const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 'file://' + path.resolve(__dirname, '..', 'public', 'homesite.html') + '?job=TESTJOB1';

const MGR_REC = 'recCGvFrCe1kkFtHd';    // Anthony Bullard, verbatim from Managers
const MGR_NAME = 'Anthony Bullard';
const COMMUNITY = 'Serenity @ Peace Creek';

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || !detail ? '' : '\n          ' + detail));
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  // The page's editable controls only exist in the wide layout; the headless
  // default of 800x600 renders the narrow, read-only variant.
  await page.setViewport({ width: 1440, height: 950 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

  await page.evaluateOnNewDocument((mgrRec, mgrName, community) => {
    window.__writes = [];
    const roster = [{ id: 'anthonybullard', name: mgrName, role: 'QAM', home: community, homeKnown: true }];
    const stub = {
      configure() {}, onChange() { return () => {}; }, can() { return true; },
      denyReason() { return 'denied'; }, isDemo() { return false; },
      roles: { admin: { label: 'Admin', can: ['suite.view', 'tracker.edit'] } },
      roleLabel() { return 'Admin'; },
      allowedPages() { return []; },
      authHeaders: (base) => Object.assign({ Authorization: 'Bearer TESTTOKEN' }, base || {}),
      restore: () => new Promise((r) => setTimeout(() => r({ name: 'Test', role: 'admin' }), 120))
    };
    /* The real olh-auth.js is a helmet asset and loads AFTER this, so a plain
       assignment gets clobbered and the page falls back to the genuine module
       -- which has no session here and renders READ ONLY, with every editable
       control gone. A getter with a swallowing setter pins the stub without
       throwing in whatever mode that script runs under.
       Stubbing the module rather than the API is deliberate: exercising the
       real module would need a server-signed session token, i.e. a credential,
       and this test must not handle one. */
    Object.defineProperty(window, 'OLHAuth', {
      configurable: false, get: () => stub, set: () => {}
    });
    const J = (o, status) => new Response(JSON.stringify(o),
      { status: status || 200, headers: { 'Content-Type': 'application/json' } });
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      const auth = (opts && opts.headers &&
        (opts.headers.Authorization || opts.headers.authorization)) || null;
      if (u.includes('/api/jobs')) {
        if (!auth) return J({ error: 'Not signed in.' }, 401);
        return J({
          jobs: [{ id: 'recTESTTESTTEST1', fields: {
            'Job #': 'TESTJOB1', 'Community': community, 'Street Address': '1 Test Way',
            'QAI Date': '2026-09-01', 'QAA Date': '2026-09-08',
            'CEL Date': '2026-09-15T13:00:00.000Z', 'ACC Date': '2026-09-22T13:00:00.000Z'
          } }],
          managers: [{ id: mgrRec, name: mgrName, active: true }]
        });
      }
      if (u.includes('/api/walk-config')) {
        return J({ roster, drive: { [community]: { [community]: 0 } },
          productMap: { [community]: community }, communities: [community], unscheduled: [] });
      }
      if (u.includes('/api/update-job')) {
        const body = JSON.parse(opts.body);
        window.__writes.push({ auth, body });
        return J({ id: body.recordId, fields: body.fields });
      }
      if (u.includes('/api/audit')) return J({ entries: [] });
      if (u.includes('/api/')) return J({});
      return realFetch(url, opts);
    };
  }, MGR_REC, MGR_NAME, COMMUNITY);

  await page.goto(PAGE, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1800));

  check('page threw no uncaught errors', pageErrors.length === 0, pageErrors.join(' | '));

  const loaded = await page.evaluate(() => ({
    jobs: ((window.OLH_DATA || {}).jobs || []).length,
    managers: ((window.OLH_DATA || {}).managers || []).length,
    roster: (window.WALK_ROSTER || []).length
  }));
  check('homesite data loaded', loaded.jobs === 1, JSON.stringify(loaded));
  check('walk roster loaded', loaded.roster === 1, JSON.stringify(loaded));

  /* Located by option VALUE, not label text. The custom select renders its
     option values before their text content, so matching on the label was
     flaky in a way that had nothing to do with what is being tested. */
  const sel = await page.evaluate(() => {
    const s = [...document.querySelectorAll('select')]
      .find((x) => [...x.options].some((o) => /^rec[A-Za-z0-9]{14}$/.test(o.value)));
    return s ? [...s.options].map((o) => ({ v: o.value, l: o.textContent.trim() })) : null;
  });
  check('manager dropdown rendered', !!sel, 'no <select> offering an Airtable record id');

  if (sel) {
    const real = sel.filter((o) => o.v !== '');
    check('option values are Airtable record ids',
      real.length > 0 && real.every((o) => /^rec[A-Za-z0-9]{14}$/.test(o.v)), JSON.stringify(real));
    check('no roster Person Id leaked into the options',
      !real.some((o) => o.v === 'anthonybullard'), JSON.stringify(real));
  }

  const picked = await page.evaluate((rec) => {
    const s = [...document.querySelectorAll('select')]
      .find((x) => [...x.options].some((o) => o.value === rec));
    if (!s) return false;
    s.value = rec;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, MGR_REC);
  check('selected the manager in the real DOM', picked);

  await new Promise((r) => setTimeout(r, 900));
  const sent = await page.evaluate(() => window.__writes);
  check('a write reached /api/update-job', sent.length > 0, 'the page never called the API');

  let last = null;
  if (sent.length) {
    last = sent[sent.length - 1];
    const field = Object.keys(last.body.fields)[0];
    const val = last.body.fields[field];
    check('the write carried the session header', last.auth === 'Bearer TESTTOKEN', String(last.auth));
    check('a Manager field was written', /Manager$/.test(field), field);
    check('the value would pass update-job link validation',
      Array.isArray(val) && val.length === 1 && /^rec[A-Za-z0-9]{14}$/.test(val[0]),
      JSON.stringify(val));
  }

  const bad = await page.evaluate(() =>
    (document.body.innerText.match(/Not Saved|Not saved|Not Loaded/g) || []));
  check('no failure toast after a successful save', bad.length === 0, bad.join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (last) console.log('payload sent: ' + JSON.stringify(last.body));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error: ' + e.message); process.exit(2); });
