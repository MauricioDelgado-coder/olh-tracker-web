#!/usr/bin/env node
'use strict';

/**
 * Stage the shared request handlers into api/_netlify/ for an Azure deploy.
 *
 *     node dev/build-azure-api.js            # copy, reporting what changed
 *     node dev/build-azure-api.js --check    # assert the copy is current, no writes
 *
 * ---- Why a copy exists at all --------------------------------------------
 *
 * Static Web Apps packages the api_location folder and nothing above it, so
 * `require('../../netlify/functions/jobs.js')` from inside api/ resolves on
 * this laptop and is absent from the deployed bundle. That failure mode is the
 * bad kind: the deploy goes green, the pages load, and every endpoint 500s.
 *
 * The copy is generated and gitignored rather than committed. A committed
 * second copy of an auth boundary is exactly the duplicate that drifts -- it
 * keeps working while it stops meaning the same thing as the original -- and
 * the README already carries two scars from that pattern (two definitions of
 * "open work", the SELECT_OPTIONS mirror). Generated plus --check in CI is the
 * version that cannot silently disagree with netlify/.
 *
 * Nothing is transformed. The handlers land byte-for-byte, their internal
 * `require('../lib/olh-auth')` resolves because lib/ is copied alongside
 * functions/, and the Netlify event shape they expect is built by
 * api/src/netlify-adapter.js at request time.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'netlify');
const DEST = path.join(ROOT, 'api', '_netlify');

/**
 * The twelve endpoints this API serves. Listed rather than globbed so that a new
 * handler is a deliberate two-line change here and in api/src/index.js, not a
 * file that ships the moment it exists -- the same reason netlify.toml uses an
 * allow-list publish directory instead of the repo root.
 */
const FUNCTIONS = [
  'jobs.js',
  'update-job.js',
  'walk-config.js',
  'time-off.js',
  'publish-schedule.js',
  'public-schedule.js',
  'auth.js',
  'password.js',
  'users.js',
  'roles.js',
  'audit.js',
  'walk-miss-log.js',
  'resolve-conflict.js',
  'jobs-sandbox-san.js',
  'update-job-sandbox-san.js',
  'sync-history.js',
  'submit-bonus.js',
  'bonus-approvals.js',
  'bonus-source.js',
  'case-aging.js',
  'case-aging-approvals.js',
  'qa-bonus.js',
  'qa-bonus-source.js',
  'qa-bonus-approvals.js',
  'daily-summary.js',
  'monthly-1on1.js',
  'team-daily-summary.js',
  'team-1on1.js'
];

/** Shared helpers. Kept outside functions/ on Netlify so it is never itself an
 *  endpoint; the same separation holds here because only src/index.js registers
 *  routes and it never registers this. */
const LIB = ['olh-auth.js'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readOrDie(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    fail(
      'missing ' + label + ': ' + path.relative(ROOT, file) + '\n' +
      '  The handler list in this script disagrees with what is on disk. Either the\n' +
      '  file was renamed (update FUNCTIONS/LIB and api/src/index.js together) or the\n' +
      '  working tree is incomplete.'
    );
  }
}

function fail(message) {
  process.stderr.write('BUILD FAILED: ' + message + '\n');
  process.exit(1);
}

function plan() {
  const entries = [];
  for (const name of FUNCTIONS) {
    entries.push({
      rel: path.join('functions', name),
      from: path.join(SOURCE, 'functions', name),
      label: 'function'
    });
  }
  for (const name of LIB) {
    entries.push({
      rel: path.join('lib', name),
      from: path.join(SOURCE, 'lib', name),
      label: 'shared library'
    });
  }
  for (const entry of entries) entry.bytes = readOrDie(entry.from, entry.label);
  return entries;
}

/**
 * Guard against the one mistake this layout invites: an `api/_netlify` that
 * someone started hand-editing. A file in the destination with no counterpart
 * in netlify/ is either a stale rename or a local patch that will be silently
 * deployed and silently diverge, so it stops the build rather than being
 * quietly deleted.
 */
function strays(entries) {
  if (!fs.existsSync(DEST)) return [];
  const expected = new Set(entries.map((e) => e.rel));
  const found = [];
  for (const dir of ['functions', 'lib']) {
    const abs = path.join(DEST, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = path.join(dir, name);
      if (!expected.has(rel)) found.push(rel);
    }
  }
  return found;
}

function main() {
  const check = process.argv.includes('--check');
  const entries = plan();

  const stray = strays(entries);
  if (stray.length) {
    fail(
      'api/_netlify holds files that are not generated from netlify/:\n' +
      stray.map((s) => '  - ' + s).join('\n') + '\n' +
      '  This directory is generated output. Edit the original in netlify/ and\n' +
      '  re-run this script; delete api/_netlify if you want a clean rebuild.'
    );
  }

  const stale = [];
  for (const entry of entries) {
    const to = path.join(DEST, entry.rel);
    let current = null;
    try { current = fs.readFileSync(to); } catch (_) { /* absent */ }
    if (current == null || sha(current) !== sha(entry.bytes)) stale.push(entry);
  }

  if (check) {
    if (stale.length) {
      fail(
        'api/_netlify is out of date with netlify/ (' + stale.length + ' file(s)):\n' +
        stale.map((e) => '  - ' + e.rel).join('\n') + '\n' +
        '  Run: node dev/build-azure-api.js\n' +
        '  Deploying now would ship handlers that differ from the ones in the repo.'
      );
    }
    process.stdout.write('api/_netlify is current (' + entries.length + ' files).\n');
    return;
  }

  for (const entry of entries) {
    const to = path.join(DEST, entry.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, entry.bytes);
  }

  // A README inside the generated directory, because the thing most likely to
  // happen to a folder full of plausible-looking source is someone editing it.
  fs.writeFileSync(
    path.join(DEST, 'README.md'),
    '# Generated — do not edit\n\n' +
    'Copied verbatim from `netlify/` by `dev/build-azure-api.js` so that the\n' +
    'Azure Static Web Apps deploy package (which contains only `api/`) includes\n' +
    'the handlers. Edit the originals in `netlify/functions` and `netlify/lib`,\n' +
    'then re-run the script. `node dev/build-azure-api.js --check` fails if this\n' +
    'directory has fallen behind, and CI runs that before every deploy.\n'
  );

  process.stdout.write(
    'Staged ' + entries.length + ' file(s) into api/_netlify' +
    (stale.length ? ' (' + stale.length + ' changed: ' + stale.map((e) => e.rel).join(', ') + ')' : ' (no changes)') +
    '\n'
  );
}

main();
