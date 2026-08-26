#!/usr/bin/env node
/**
 * Assert the server's permission matrix agrees with the frontend auth module.
 *
 *   node dev/check-page-perms.js
 *
 * The Page Access grid is only real if BOTH sides know the seven page.*
 * permissions and apply the same rules. They are two implementations of one
 * spec in two languages, so the only thing keeping them together is a check
 * that fails when they drift.
 *
 * Exits non-zero on any disagreement.
 */
'use strict';

process.env.AIRTABLE_PAT = process.env.AIRTABLE_PAT || 'unused-by-these-checks';
const A = require('../netlify/lib/olh-auth.js');

let failed = 0;
const ok = (label) => console.log('   ok    ' + label);
const bad = (label, detail) => { console.log('   FAIL  ' + label + '  -- ' + detail); failed += 1; };
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(label); else bad(label, 'got ' + a + ', wanted ' + b);
};

const PAGES = ['page.home', 'page.mywalks', 'page.tracker', 'page.completion', 'page.walks',
  'page.game', 'page.qamgmt', 'page.missedwalks', 'page.scheduler', 'page.timeoff', 'page.workload',
  'page.walkstoschedule', 'page.admin', 'page.keys', 'page.sanmpr', 'page.synchistory'];

console.log('\n=== the catalog ===');
for (const p of PAGES) {
  if (A.PERMS.includes(p)) ok(p + ' is a known permission');
  else bad(p + ' is a known permission', 'missing from PERMS, so normalizeMatrix drops it');
}
eq('PERMS is capabilities then pages', A.PERMS, [
  'suite.view', 'tracker.edit', 'walk.complete', 'walk.schedule', 'optimizer.apply', 'roster.manage', 'sandbox.edit'
].concat(PAGES));

console.log('\n=== every page has a refusal message ===');
for (const p of PAGES) {
  if (A.DENY[p] && /does not have access to the .+ page\.$/.test(A.DENY[p])) ok(p);
  else bad(p, 'DENY message is ' + JSON.stringify(A.DENY[p]));
}

console.log('\n=== shipped defaults ===');
eq('admin holds every page', PAGES.filter((p) => A.DEFAULT_ROLES.admin.includes(p)), PAGES);
eq('qam has no page.admin', A.DEFAULT_ROLES.qam.includes('page.admin'), false);
eq('leadership is view-only but sees pages',
  A.DEFAULT_ROLES.leadership.includes('page.completion'), true);
eq('leadership cannot edit', A.DEFAULT_ROLES.leadership.includes('tracker.edit'), false);
eq('concierge sees the tracker and scheduler', 
  ['page.tracker', 'page.scheduler'].filter((p) => A.DEFAULT_ROLES.concierge.includes(p)),
  ['page.tracker', 'page.scheduler']);
eq('concierge cannot edit anything',
  ['tracker.edit', 'walk.schedule', 'optimizer.apply', 'roster.manage']
    .some((c) => A.DEFAULT_ROLES.concierge.includes(c)), false);
eq('concierge has no page.admin', A.DEFAULT_ROLES.concierge.includes('page.admin'), false);
eq('roleSlug recognizes concierge', A.roleSlug('Concierge'), 'concierge');
eq('roleLabel for concierge', A.roleLabel('concierge'), 'Concierge');

eq('sandbox role has page.sanmpr and sandbox.edit, nothing more sensitive',
  ['page.sanmpr', 'sandbox.edit', 'tracker.edit', 'page.tracker', 'roster.manage']
    .filter((p) => A.DEFAULT_ROLES.sandbox.includes(p)),
  ['page.sanmpr', 'sandbox.edit']);
eq('roleSlug recognizes sandbox', A.roleSlug('Sandbox'), 'sandbox');
eq('roleLabel for sandbox', A.roleLabel('sandbox'), 'Sandbox');
eq('sandbox.edit does not imply tracker.edit',
  A.normalizeMatrix({ sandbox: ['suite.view', 'sandbox.edit'] }).sandbox.includes('tracker.edit'), false);
eq('sandbox.edit drags page.sanmpr',
  A.normalizeMatrix({ sandbox: ['sandbox.edit'] }).sandbox.includes('page.sanmpr'), true);

console.log('\n=== normalizeMatrix ===');
const norm = A.normalizeMatrix;

// page.admin is admin-only, even by implication. roster.manage implies
// page.admin through NEEDS_PAGE, so this is the case where an ordering mistake
// would hand the console to a non-admin.
const sneaky = norm({ qam: ['suite.view', 'roster.manage'] });
eq('roster.manage cannot smuggle page.admin to qam', sneaky.qam.includes('page.admin'), false);
eq('an explicit page.admin on qam is stripped',
  norm({ qam: ['suite.view', 'page.admin'] }).qam.includes('page.admin'), false);
eq('admin keeps page.admin when the grid clears it',
  norm({ admin: [] }).admin.includes('page.admin'), true);

// A capability without the page it acts on can never fire.
eq('tracker.edit drags page.tracker',
  norm({ cm: ['tracker.edit'] }).cm.includes('page.tracker'), true);
eq('walk.schedule drags page.walks',
  norm({ qam: ['walk.schedule'] }).qam.includes('page.walks'), true);
eq('optimizer.apply drags page.scheduler',
  norm({ qam: ['optimizer.apply'] }).qam.includes('page.scheduler'), true);

// Any page implies being able to sign in and look at it.
eq('a bare page grants suite.view',
  norm({ leadership: ['page.completion'] }).leadership.includes('suite.view'), true);

// Unknown permissions are dropped rather than stored.
eq('an invented permission is dropped',
  norm({ cm: ['suite.view', 'page.invented'] }).cm.includes('page.invented'), false);

// Round-tripping the defaults must be a no-op, or every save drifts.
const twice = norm(norm(undefined));
eq('the defaults are a fixed point', twice, norm(undefined));

console.log('');
if (failed) { console.log(failed + ' CHECK(S) FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
