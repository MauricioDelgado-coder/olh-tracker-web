#!/usr/bin/env node
/**
 * Apply the same 3 role-registry patches made to missed-walks.html's inline
 * OLHAuth module (knownRoleKeys/normalizeMatrix/applyMatrix broadened to
 * include roles beyond DEFAULT_ROLES; normRole gains a slug-shape passthrough
 * instead of collapsing every unrecognized role to leadership) to every OTHER
 * plain-inline copy of the same module -- the ones dev/patch-stale-auth-
 * module.js does not touch because that script only rewrites the
 * gzip+base64 __bundler/manifest asset copies.
 *
 *   node dev/patch-plain-auth-role-registry.js [--apply]
 *
 * Each of the three patches requires an exact, unique match in a page before
 * it is applied there -- a page not carrying the exact pre-patch text (e.g.
 * because it already diverged some other way) is reported and skipped rather
 * than guessed at.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const APPLY = process.argv.includes('--apply');

const PAGES = [
  'admin.html', 'time-off.html', 'sync-conflicts.html',
  'walks-to-schedule.html', 'keys.html', 'sync-history.html'
];

const PATCHES = [
  {
    name: 'normalizeMatrix/applyMatrix broadened to include roles beyond DEFAULT_ROLES',
    old: `  function normalizeMatrix(src) {
    var out = {};
    Object.keys(DEFAULT_ROLES).forEach(function (r) {
      var can = (src && src[r]) ? src[r].slice() : DEFAULT_ROLES[r].can.slice();
      (ROLE_LOCKS[r] || []).forEach(function (p) { if (can.indexOf(p) < 0) can.push(p); });
      if (can.some(function (p) { return IMPLIES_VIEW.indexOf(p) >= 0; }) && can.indexOf("suite.view") < 0)
        can.push("suite.view");
      Object.keys(NEEDS_PAGE).forEach(function (cap) {
        if (can.indexOf(cap) >= 0 && can.indexOf(NEEDS_PAGE[cap]) < 0) can.push(NEEDS_PAGE[cap]);
      });
      if (r !== "admin") can = can.filter(function (p) { return ADMIN_ONLY_PAGES.indexOf(p) < 0; });
      out[r] = can;
    });
    return out;
  }

  function applyMatrix(src) {
    var norm = normalizeMatrix(src);
    Object.keys(DEFAULT_ROLES).forEach(function (r) {
      ROLES[r] = { label: DEFAULT_ROLES[r].label, can: norm[r] };
    });
  }`,
    new: `  function knownRoleKeys(src) {
    var out = Object.keys(DEFAULT_ROLES).slice();
    Object.keys(src || {}).forEach(function (r) { if (out.indexOf(r) < 0) out.push(r); });
    return out;
  }

  function normalizeMatrix(src) {
    var out = {};
    knownRoleKeys(src).forEach(function (r) {
      var base = DEFAULT_ROLES[r] ? DEFAULT_ROLES[r].can.slice() : ["suite.view"];
      var can = (src && src[r]) ? src[r].slice() : base;
      (ROLE_LOCKS[r] || []).forEach(function (p) { if (can.indexOf(p) < 0) can.push(p); });
      if (can.some(function (p) { return IMPLIES_VIEW.indexOf(p) >= 0; }) && can.indexOf("suite.view") < 0)
        can.push("suite.view");
      Object.keys(NEEDS_PAGE).forEach(function (cap) {
        if (can.indexOf(cap) >= 0 && can.indexOf(NEEDS_PAGE[cap]) < 0) can.push(NEEDS_PAGE[cap]);
      });
      if (r !== "admin") can = can.filter(function (p) { return ADMIN_ONLY_PAGES.indexOf(p) < 0; });
      out[r] = can;
    });
    return out;
  }

  function applyMatrix(src) {
    var norm = normalizeMatrix(src);
    Object.keys(norm).forEach(function (r) {
      ROLES[r] = { label: (DEFAULT_ROLES[r] && DEFAULT_ROLES[r].label) || titleCase(r), can: norm[r] };
    });
  }`
  },
  {
    name: 'normRole gains slug-shape passthrough',
    old: `  function normRole(r) { return ROLE_ALIAS[String(r || "").toLowerCase().trim()] || "leadership"; }`,
    new: `  function normRole(r) {
    var k = String(r || "").toLowerCase().trim();
    if (ROLE_ALIAS[k]) return ROLE_ALIAS[k];
    if (/^[a-z][a-z0-9_-]{1,40}$/.test(k)) return k;
    return "leadership";
  }`
  }
];

let totalApplied = 0, totalSkipped = 0;

for (const page of PAGES) {
  const filePath = path.join(PUB, page);
  let content = fs.readFileSync(filePath, 'utf8');
  let pageOk = true;
  const results = [];

  for (const patch of PATCHES) {
    const count = content.split(patch.old).length - 1;
    if (count !== 1) {
      results.push(patch.name + ': found ' + count + ' times (expected 1) -- SKIPPING this page');
      pageOk = false;
      continue;
    }
    results.push(patch.name + ': OK, unique match found');
    if (APPLY) content = content.split(patch.old).join(patch.new);
  }

  console.log('\n' + page + ':');
  results.forEach((r) => console.log('  ' + r));

  if (APPLY && pageOk) {
    fs.writeFileSync(filePath, content);
    const verify = fs.readFileSync(filePath, 'utf8');
    if (!verify.includes('function knownRoleKeys(src)') || !verify.includes('if (/^[a-z][a-z0-9_-]{1,40}$/.test(k)) return k;')) {
      throw new Error(page + ': verification FAILED after write -- manual review needed.');
    }
    console.log('  -> patched and verified.');
    totalApplied++;
  } else if (!pageOk) {
    totalSkipped++;
  }
}

console.log('\n' + totalApplied + ' page(s) patched, ' + totalSkipped + ' skipped due to mismatch.');
if (!APPLY) console.log('Dry run only. Re-run with --apply to write changes.');
