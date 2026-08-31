/**
 * Shared auth / Airtable helpers for the OLH Suite functions.
 *
 * Lives outside netlify/functions so it is never itself deployed as an
 * endpoint; esbuild bundles it into each function that requires it.
 *
 * Dependency policy: Node builtins and global fetch only. The repo has no
 * package.json and the existing three functions add no dependencies, so
 * password hashing uses crypto.scrypt (built in, memory-hard) rather than
 * pulling in a native bcrypt/argon2 binary that has to compile per deploy.
 *
 * Nothing here logs a token, a password, or a hash.
 */

'use strict';

const crypto = require('crypto');

const BASE_ID = 'appYX9df4lGO6G2uz';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const TABLES = {
  jobs: 'tblqpmwtZ6i4gtogl',
  managers: 'tble8SiAKDLl7eS5D',
  walkRoster: 'tblhDm8OD4jSR0tey',
  walkDrive: 'tblVnYFUc4xuovVEC',
  walkProduct: 'tblvkWF5QULxhqFiX',
  users: 'tblTesJj3P7BSiErH',
  audit: 'tblgiEqKXRbBHLg1i',
  roles: 'tblIhpTZyCupEaASH',
  walkMissLog: 'tblLA3n0SRgUA9A0z',
  syncHistory: 'tblBHVI7HelUb6vyk',
  bonusSubmissions: 'tblfFcCeZGUHEvj4N',
  bonusSource: 'tbl8eMWVp2Dx1YcDg',
  caseAgingExceptions: 'tblF6CAPJkW4WgZmS',
  dailySummary: 'tbllmzusPJehWJDxj',
  monthly1on1: 'tbl2GraVFEzPi7Myx',
  qaBonusSource: 'tblQokbgOBiRZ8bDM',
  qaBonusSubmissions: 'tblnV7tfJAULckLiV'
};

/* ---- HTTP plumbing (shape matches the existing jobs.js) ------------------- */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function reply(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: extraHeaders ? Object.assign({}, JSON_HEADERS, extraHeaders) : JSON_HEADERS,
    body: JSON.stringify(body)
  };
}

function readJson(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try { return JSON.parse(raw) || {}; }
  catch (_) {
    const e = new Error('Request body is not valid JSON.');
    e.statusCode = 400;
    throw e;
  }
}

/**
 * Path segments addressed to a function, whichever way it was reached.
 *
 * A netlify.toml rewrite leaves event.path as the ORIGINAL request path, so the
 * same handler sees /api/sign-in in production and /.netlify/functions/auth/sign-in
 * when called directly. Both must resolve to ["sign-in"], and /api/users/rec123
 * must resolve to ["rec123"] rather than ["users","rec123"].
 */
function route(event, fnName) {
  const parts = String(event.path || '').split('/').filter(Boolean);
  let i = 0;
  if (parts[0] === '.netlify' && parts[1] === 'functions') i = 2;
  else if (parts[0] === 'api') i = 1;
  if (parts[i] === fnName) i += 1;
  return parts.slice(i).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
}

/* ---- Airtable ------------------------------------------------------------- */

const PAGE_DELAY_MS = 220;
const MAX_PAGES = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pat() {
  const v = process.env.AIRTABLE_PAT;
  if (!v || !String(v).trim()) {
    const e = new Error(
      // Names both hosts because the app now runs on both, and a message that
      // sends you to the wrong product is worse than one that names neither.
      // On Azure the setting takes effect at the next cold start; only Netlify
      // needs the redeploy.
      'Server is not configured: AIRTABLE_PAT is unset. Set it under ' +
      'Environment variables for this site -- Azure Static Web Apps: Settings -> ' +
      'Environment variables; Netlify: Site configuration -> Environment ' +
      'variables, then redeploy.'
    );
    e.statusCode = 500;
    throw e;
  }
  return String(v).trim();
}

async function airtable(method, pathSuffix, body) {
  const res = await fetch(AIRTABLE_API + '/' + BASE_ID + pathSuffix, {
    method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + pat() },
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && (j.error.message || j.error.type)) || '';
    } catch (_) { /* non-JSON error body */ }
    const e = new Error(
      'Airtable returned ' + res.status + ' for ' + method + ' ' + pathSuffix +
      (detail ? ': ' + detail : '')
    );
    // Never surface an Airtable 401/403 as our own 401 -- that would read to the
    // client as "your session is invalid" when the server's own PAT is at fault.
    e.statusCode = 502;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/** Page through a table, optionally filtered. */
async function listRecords(tableId, params) {
  const records = [];
  let offset = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) qs.append(k, v);
    if (offset) qs.set('offset', offset);
    const json = await airtable('GET', '/' + tableId + '?' + qs.toString());
    if (json && Array.isArray(json.records)) records.push(...json.records);
    offset = (json && json.offset) || null;
    pages += 1;
    if (offset && pages < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (offset && pages < MAX_PAGES);
  return records;
}

const esc = (s) => String(s == null ? '' : s).split('"').join('\\"');

async function findOne(tableId, formula) {
  const recs = await listRecords(tableId, { filterByFormula: formula, maxRecords: '1' });
  return recs[0] || null;
}

const createRecord = (tableId, fields) =>
  airtable('POST', '/' + tableId, { fields, typecast: true });

/**
 * Count of a CCR's Approved Case Aging Exceptions whose underlying case
 * actually CLOSED in the given bonus month -- not the month the exception
 * was submitted or approved. The whole point of an exception is that the
 * case may run long and close later than expected, so the offset has to
 * follow the case to whichever month it actually closes in, per the CCR
 * Bonus Agreement.
 *
 * Requires Case Closed Date to be set (by the CCR, via PATCH /api/case-aging
 * once they close the case in Salesforce) AND Status = Approved. A request
 * that is Approved but not yet closed does not count toward any month yet;
 * one that closed but was never approved never counts at all.
 *
 * Shared by submit-bonus.js (which trusts this, not the client, for the
 * dollar-affecting Aged Case Exceptions Approved figure) and bonus-source.js
 * (which surfaces it to the CCR as a read-only pre-fill before they submit).
 * One copy here rather than two nearly-identical queries, for the same
 * reason bonus math itself lives in one place: a duplicate is exactly the
 * kind of thing that quietly drifts.
 */
function caseAgingExceptionsApprovedCount(email, bonusMonth) {
  const formula = 'AND(LOWER({Submitted By Email}) = "' + esc(normEmail(email)) +
    '", {Status} = "Approved", {Case Closed Date} != "", ' +
    'DATETIME_FORMAT({Case Closed Date}, "YYYY-MM") = "' + esc(bonusMonth) + '")';
  return listRecords(TABLES.caseAgingExceptions, { filterByFormula: formula }).then((recs) => recs.length);
}

const updateRecord = (tableId, id, fields) =>
  airtable('PATCH', '/' + tableId + '/' + id, { fields, typecast: true });

const deleteRecord = (tableId, id) => airtable('DELETE', '/' + tableId + '/' + id);

/* ---- Passwords ------------------------------------------------------------ */

// scrypt at the Node defaults for N/r/p, 32-byte salt and key. maxmem has to be
// raised explicitly: 16384*8*128 exceeds the 32 MB default ceiling.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(32);
  const key = await scrypt(password, salt);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || expected.length !== SCRYPT.keylen) return false;
  const actual = await scrypt(password, salt);
  // Constant-time: both buffers are keylen by construction.
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * The server-side copy of the policy. The client shows the same four rules as
 * guidance while someone types; this one is the control. Returns [] when valid.
 */
function checkPolicy(password) {
  const v = String(password == null ? '' : password);
  const fails = [];
  if (v.length < 12) fails.push('at least 12 characters');
  if (!/[a-z]/.test(v) || !/[A-Z]/.test(v)) fails.push('both upper and lowercase letters');
  if (!/\d/.test(v)) fails.push('a number');
  if (!/[^A-Za-z0-9]/.test(v)) fails.push('a symbol');
  if (v.length > 200) fails.push('no more than 200 characters');
  return fails;
}

/* ---- Tokens -------------------------------------------------------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .split('+').join('-').split('/').join('_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(
  String(s).split('-').join('+').split('_').join('/'), 'base64'
);

function secret() {
  const v = process.env.SESSION_SECRET;
  if (!v || String(v).trim().length < 32) {
    const e = new Error(
      'Server is not configured: SESSION_SECRET is unset or shorter than 32 characters. ' +
      'Generate one with `openssl rand -hex 32` and set it under Environment ' +
      'variables for this site (Azure Static Web Apps: Settings -> Environment ' +
      'variables; Netlify: Site configuration -> Environment variables, then ' +
      'redeploy).'
    );
    e.statusCode = 500;
    throw e;
  }
  return String(v).trim();
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** A single-use invite / reset token. Only its SHA-256 is ever stored. */
const randomToken = () => b64url(crypto.randomBytes(32));

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — one working day, no more.

/** Stateless session token: b64url(payload).b64url(HMAC-SHA256(payload)). */
function mintSession(userId, epoch) {
  const payload = b64url(JSON.stringify({
    u: userId,
    e: Number(epoch) || 0,
    x: Date.now() + SESSION_TTL_MS
  }));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  return payload + '.' + sig;
}

/** Returns {userId, epoch} or null. Verifies the signature before parsing. */
function readSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest();
  const given = unb64url(sig);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(unb64url(payload).toString('utf8')); }
  catch (_) { return null; }
  if (!data || !data.u || !data.x || Date.now() > Number(data.x)) return null;
  return { userId: String(data.u), epoch: Number(data.e) || 0 };
}

/* ---- Roles and permissions ----------------------------------------------- */

/* The seven page.* permissions arrived with the 08/01 export, which put a Page
 * Access grid beside Capabilities in the admin console. They are permissions
 * like any other -- one grid, one save, one can() check -- so they have to be
 * known HERE too. PERMS is an allow-list: normalizeMatrix() drops anything not
 * in it, so until these were added the console could show the grid, let an
 * admin tick it, PUT it, and have every page.* silently discarded on the way
 * in. A control that appears to save and does not is worse than no control.
 *
 * Kept in the same order and with the same rules as the frontend module so the
 * matrix an admin sees is the matrix that gets stored.
 */
const ALL_PAGES = [
  'page.home', 'page.mywalks', 'page.tracker', 'page.completion', 'page.walks', 'page.game',
  'page.qamgmt', 'page.missedwalks', 'page.scheduler', 'page.timeoff', 'page.workload',
  'page.walkstoschedule', 'page.admin', 'page.keys', 'page.sanmpr', 'page.synchistory', 'page.redflags',
  'page.bonus', 'page.bonusapproval', 'page.caseaging', 'page.dailysummary', 'page.monthly1on1', 'page.qabonus'
];

// Mirrors DEFAULT_ROLES in the frontend auth module. Used when the Roles table
// has no row for a slug, so an empty table is a safe state.
// page.missedwalks follows page.qamgmt exactly -- reconciling a miss is the same
// tier of work as recording one, so whoever can mark a walk missed can also
// clear it once it's been handled.
// page.timeoff follows page.scheduler exactly -- taking someone off the board
// for a day is the same tier of scheduling decision as reassigning a walk, so
// it's granted (and view-only for leadership) alongside it, not alongside
// page.qamgmt.
const DEFAULT_ROLES = {
  admin: ['suite.view', 'tracker.edit', 'walk.schedule', 'optimizer.apply', 'roster.manage', 'sandbox.edit'].concat(ALL_PAGES),
  // Restricted 2026-08-25 to the My Walks self-service page only
  // (public/my-walks.html, sandboxed/unlinked like game.html). QAMs no
  // longer get the tracker, completion, scheduler, qa-management,
  // missed-walks, time-off, workload, or walks-to-schedule pages.
  // Updated same day: tracker.edit swapped for the narrower walk.complete,
  // added specifically so a My Walks completion write no longer implies
  // the full tracker.edit capability (see WRITE_PERM/COMPLETION_ONLY_FIELDS
  // in update-job.js and walk-miss-log.js). page.home is kept so sign-in
  // still lands on a real page (an empty tile view) instead of erroring.
  // Restore the previous line below if this ever needs undoing.
  // qam: ['suite.view', 'tracker.edit', 'walk.schedule', 'optimizer.apply',
  //   'page.home', 'page.tracker', 'page.completion', 'page.walks', 'page.qamgmt', 'page.missedwalks',
  //   'page.scheduler', 'page.timeoff', 'page.workload', 'page.walkstoschedule'],
  // 2026-08-29: page.monthly1on1 added to qam so QAMs can complete their own
  // associate-side check-in too, same as ccr/cm below -- everyone with a
  // monthly one-on-one has the associate half of the page even if their role
  // otherwise carries no other tracker/case pages.
  // 2026-08-31: page.qabonus added -- QAMs self-report their own monthly
  // bonus here, same as page.bonus does for ccr below.
  qam: ['suite.view', 'walk.complete', 'page.home', 'page.mywalks', 'page.monthly1on1', 'page.qabonus'],
  cm: ['suite.view', 'tracker.edit', 'page.home', 'page.tracker', 'page.completion', 'page.walks', 'page.redflags',
    'page.monthly1on1'],
  ccr: ['suite.view', 'tracker.edit', 'page.home', 'page.tracker', 'page.walks', 'page.qamgmt', 'page.missedwalks',
    'page.walkstoschedule', 'page.bonus', 'page.caseaging', 'page.dailysummary', 'page.monthly1on1'],
  // page.dailysummary and page.monthly1on1 both live here too, view-only in
  // effect for the associate-authored fields (the frontend gates writing
  // those to the record's own owner) -- leadership is who the "Support
  // Needed" side of a one-on-one and the "Reviewed By" side of a daily
  // summary actually belongs to, mirroring page.bonusapproval's role.
  leadership: ['suite.view', 'page.home', 'page.tracker', 'page.completion',
    'page.walks', 'page.qamgmt', 'page.missedwalks', 'page.scheduler', 'page.timeoff', 'page.workload',
    'page.walkstoschedule', 'page.keys', 'page.synchistory', 'page.redflags', 'page.bonusapproval',
    'page.dailysummary', 'page.monthly1on1'],
  // View-only: the tracker grid, the schedule optimizer, and homesite.html
  // (which has no permission of its own -- it checks only suite.view and is
  // reached by drilling into a record from the tracker). No tracker.edit,
  // walk.schedule, or optimizer.apply: a concierge can see dates and
  // proposed moves but not change them.
  concierge: ['suite.view', 'page.home', 'page.tracker', 'page.scheduler'],
  // Added for the SAN MPR tracker sandbox (San Antonio, isolated Airtable
  // data). Deliberately minimal: page.home + page.sanmpr + sandbox.edit only,
  // and NOT tracker.edit -- see the note on sandbox.edit below for why the two
  // capabilities are kept apart even though they validate the same field
  // whitelist shape.
  sandbox: ['suite.view', 'page.home', 'page.sanmpr', 'sandbox.edit']
};
const PERMS = ['suite.view', 'tracker.edit', 'walk.complete', 'walk.schedule', 'optimizer.apply', 'roster.manage', 'sandbox.edit']
  .concat(ALL_PAGES);
const ROLE_LOCKS = { admin: ['suite.view', 'roster.manage', 'page.admin'] };

/* Only admins run the console, so page.admin is never handed to anyone else --
   enforced here and not just in the grid, because the grid is a UI and this is
   the boundary. */
const ADMIN_ONLY_PAGES = ['page.admin'];
const IMPLIES_VIEW = ['tracker.edit', 'walk.complete', 'walk.schedule', 'optimizer.apply', 'roster.manage', 'sandbox.edit']
  .concat(ALL_PAGES);

/* An editing capability is meaningless without the page it edits, so granting
   one drags the other along rather than storing a permission that can never
   fire. */
const NEEDS_PAGE = {
  'tracker.edit': 'page.tracker',
  'walk.complete': 'page.mywalks',
  'walk.schedule': 'page.walks',
  'optimizer.apply': 'page.scheduler',
  'roster.manage': 'page.admin',
  'sandbox.edit': 'page.sanmpr'
};

const ROLE_ALIAS = {
  'admin': 'admin',
  'qa manager': 'qam', 'qam': 'qam',
  'construction manager': 'cm', 'cm': 'cm',
  'customer care': 'ccr', 'customer care rep': 'ccr', 'ccr': 'ccr',
  'leadership': 'leadership', 'division leadership': 'leadership',
  'concierge': 'concierge', 'homebuyer concierge': 'concierge',
  'sandbox': 'sandbox'
};
const ROLE_LABEL = {
  admin: 'Admin', qam: 'QA Manager', cm: 'Construction Manager',
  ccr: 'Customer Care', leadership: 'Division Leadership', concierge: 'Concierge',
  sandbox: 'Sandbox'
};

/**
 * Dynamic role registry, sourced from the Roles table's Role (slug) + Label
 * (display name) fields. Roles are no longer only the seven shipped in
 * DEFAULT_ROLES -- an admin can create new ones (see createRole below) --
 * so ROLE_ALIAS/ROLE_LABEL alone are not a complete answer to "what roles
 * exist" any more. They remain the bootstrap defaults (what a brand-new,
 * empty Roles table falls back to) and the fast path for the seven original
 * roles, which never needs a network round trip to resolve.
 *
 * Populated as a side effect of loadMatrix() (which already reads the whole
 * Roles table every ~60s) rather than its own separate fetch. On a genuine
 * cold start, before the first loadMatrix() call in this process, dyn is
 * null and roleSlug()/roleLabel() fall through to the static maps plus the
 * slug-shaped passthrough below -- which is exactly correct for the one
 * thing that matters on a cold start: recognizing the Roles table's own
 * Role field, which is already a slug, not a label needing translation.
 */
let roleRegistryCache = { at: 0, value: null };

function buildRoleRegistry(recs) {
  const alias = Object.assign({}, ROLE_ALIAS);
  const label = Object.assign({}, ROLE_LABEL);
  const slugs = Object.keys(DEFAULT_ROLES);
  for (const r of recs) {
    const f = (r && r.fields) || {};
    const slug = String(f.Role || '').trim().toLowerCase();
    if (!slug) continue;
    const disp = String(f.Label || '').trim();
    alias[slug] = slug;
    if (disp) alias[disp.toLowerCase()] = slug;
    label[slug] = disp || label[slug] || slug;
    if (slugs.indexOf(slug) < 0) slugs.push(slug);
  }
  return { alias, label, slugs };
}

/**
 * A slug this process has never seen a Roles row for yet (freshly created,
 * cache not refreshed here since) is still recognized as itself rather than
 * collapsed to leadership -- it must already look like a slug we would have
 * generated (lowercase, starts with a letter, alnum/hyphen/underscore only,
 * 2-40 chars) so arbitrary garbage still falls through to the safe default.
 */
const SLUG_SHAPE = /^[a-z][a-z0-9_-]{1,40}$/;

function roleSlug(r) {
  const key = String(r || '').toLowerCase().trim();
  if (ROLE_ALIAS[key]) return ROLE_ALIAS[key];
  const dyn = roleRegistryCache.value;
  if (dyn && dyn.alias[key]) return dyn.alias[key];
  if (SLUG_SHAPE.test(key)) return key;
  return 'leadership';
}
function roleLabel(input) {
  const slug = roleSlug(input);
  const dyn = roleRegistryCache.value;
  if (dyn && dyn.label[slug]) return dyn.label[slug];
  return ROLE_LABEL[slug] || slug;
}
/** All role slugs known to this process right now (static + whatever the last Roles table read found). */
function knownRoleSlugs() {
  const dyn = roleRegistryCache.value;
  return dyn ? dyn.slugs.slice() : Object.keys(DEFAULT_ROLES);
}

/**
 * The same normalisation the frontend applies, enforced here so a hand-edited
 * Roles row cannot lock every admin out of the console or grant an editing
 * permission without the view permission it depends on.
 *
 * roleSlugs defaults to the seven shipped roles for any caller that hasn't
 * loaded the dynamic registry yet (e.g. dev/check-page-perms.js, which calls
 * this directly with no Airtable access at all); loadMatrix passes the full
 * dynamic set once it has one.
 */
function normalizeMatrix(src, roleSlugs) {
  const out = {};
  for (const slug of (roleSlugs || Object.keys(DEFAULT_ROLES))) {
    const base = DEFAULT_ROLES[slug] ? DEFAULT_ROLES[slug].slice() : ['suite.view'];
    let can = (src && Array.isArray(src[slug])) ? src[slug].slice() : base;
    can = can.filter((p) => PERMS.indexOf(p) >= 0);
    for (const p of (ROLE_LOCKS[slug] || [])) if (can.indexOf(p) < 0) can.push(p);
    if (can.some((p) => IMPLIES_VIEW.indexOf(p) >= 0) && can.indexOf('suite.view') < 0) {
      can.push('suite.view');
    }
    for (const cap of Object.keys(NEEDS_PAGE)) {
      if (can.indexOf(cap) >= 0 && can.indexOf(NEEDS_PAGE[cap]) < 0) can.push(NEEDS_PAGE[cap]);
    }
    // Runs after NEEDS_PAGE on purpose: roster.manage implies page.admin, and
    // a non-admin role holding roster.manage must not acquire the console page
    // through the back door of that implication.
    if (slug !== 'admin') can = can.filter((p) => ADMIN_ONLY_PAGES.indexOf(p) < 0);
    out[slug] = PERMS.filter((p) => can.indexOf(p) >= 0);
  }
  return out;
}

/**
 * Per-user permission overrides, applied on top of the role matrix.
 *
 * grants/revokes are each filtered through PERMS first -- an unknown value
 * stored on the Users record (a stale permission key from before a catalog
 * change, or hand-typed junk) is dropped rather than passed through.
 *
 * Order matters: grants apply, then revokes remove (so a revoke always wins
 * over a grant of the same key -- there is no case where you'd want a grant to
 * survive its own explicit revoke), then the same two invariants
 * normalizeMatrix enforces on the role matrix are re-applied here so an
 * override can never produce a state the role grid itself couldn't produce:
 *
 *   - an editing capability without the page it acts on is useless, so
 *     granting one still drags its page along (NEEDS_PAGE)
 *   - page.admin is admin-only even by override; granting it to a non-admin
 *     role here has no effect, same as normalizeMatrix does for the role grid
 *   - an admin's suite.view/roster.manage/page.admin can never be revoked via
 *     override -- ROLE_LOCKS is re-enforced last so no combination of grants
 *     and revokes can lock an admin out of the console that fixes overrides
 */
function applyOverrides(baseCan, role, grants, revokes) {
  const g = (Array.isArray(grants) ? grants : []).filter((p) => PERMS.indexOf(p) >= 0);
  const r = (Array.isArray(revokes) ? revokes : []).filter((p) => PERMS.indexOf(p) >= 0);
  let can = baseCan.slice();
  for (const p of g) if (can.indexOf(p) < 0) can.push(p);
  can = can.filter((p) => r.indexOf(p) < 0);
  if (role !== 'admin') can = can.filter((p) => ADMIN_ONLY_PAGES.indexOf(p) < 0);
  if (can.some((p) => IMPLIES_VIEW.indexOf(p) >= 0) && can.indexOf('suite.view') < 0) {
    can.push('suite.view');
  }
  for (const cap of Object.keys(NEEDS_PAGE)) {
    if (can.indexOf(cap) >= 0 && can.indexOf(NEEDS_PAGE[cap]) < 0) can.push(NEEDS_PAGE[cap]);
  }
  if (role === 'admin') for (const p of (ROLE_LOCKS.admin || [])) if (can.indexOf(p) < 0) can.push(p);
  return PERMS.filter((p) => can.indexOf(p) >= 0);
}

// 60s cache: the matrix is read on every authenticated request.
let matrixCache = { at: 0, value: null };
const MATRIX_TTL_MS = 60 * 1000;

async function loadMatrix(bust) {
  const now = Date.now();
  if (!bust && matrixCache.value && now - matrixCache.at < MATRIX_TTL_MS) return matrixCache.value;
  let stored = null;
  let recs = [];
  try {
    recs = await listRecords(TABLES.roles);
    if (recs.length) {
      stored = {};
      for (const r of recs) {
        const slug = roleSlug(r.fields && r.fields.Role);
        const perms = (r.fields && r.fields.Permissions) || [];
        stored[slug] = Array.isArray(perms) ? perms : [perms];
      }
    }
  } catch (_) {
    // An unreadable Roles table must not lock everyone out; fall back to the
    // shipped defaults rather than to "no permissions".
    stored = null;
  }
  // Side effect: refresh the dynamic role registry from the same read, so a
  // role created since the last cache cycle becomes resolvable by roleSlug/
  // roleLabel everywhere (not just inside this one matrix computation)
  // without a second network round trip.
  roleRegistryCache = { at: now, value: buildRoleRegistry(recs) };
  const value = normalizeMatrix(stored, knownRoleSlugs());
  matrixCache = { at: now, value };
  return value;
}

async function saveMatrix(next, byName) {
  const roleSlugs = Array.from(new Set(knownRoleSlugs().concat(Object.keys(next || {}))));
  const norm = normalizeMatrix(next, roleSlugs);
  const existing = await listRecords(TABLES.roles);
  const bySlug = new Map(existing.map((r) => [roleSlug(r.fields && r.fields.Role), r]));
  const stamp = new Date().toISOString();
  for (const slug of Object.keys(norm)) {
    const fields = {
      Role: slug,
      Permissions: norm[slug],
      'Updated At': stamp,
      'Updated By': byName || ''
    };
    const hit = bySlug.get(slug);
    if (hit) await updateRecord(TABLES.roles, hit.id, fields);
    else await createRecord(TABLES.roles, fields);
    await sleep(PAGE_DELAY_MS);
  }
  matrixCache = { at: Date.now(), value: norm };
  return norm;
}

/**
 * Create a brand-new role. Admin-only (enforced by the caller via
 * requirePerm(session, 'roster.manage') before this runs -- this function
 * itself does not check a session, same as saveMatrix).
 *
 * label is required and becomes the Roles table's Label field (what people
 * see). slug is optional -- if omitted, it's derived from label the same way
 * a human would abbreviate it (lowercase, spaces to hyphens, strip anything
 * that isn't alnum/hyphen/underscore). Either way the final slug must be
 * SLUG_SHAPE-valid and must not collide with an existing role.
 *
 * The new role starts with only suite.view -- a role that can sign in and
 * see nothing, ready for an admin to check boxes for it on the Roles &
 * Permissions grid. Granting it real access is a second, deliberate step,
 * not a guess this function makes on the admin's behalf.
 */
async function createRole(label, slug, byName) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) {
    const e = new Error('Enter a name for the role.');
    e.statusCode = 400;
    throw e;
  }
  if (cleanLabel.length > 60) {
    const e = new Error('Role name is too long (60 characters max).');
    e.statusCode = 400;
    throw e;
  }
  let cleanSlug = String(slug || '').trim().toLowerCase();
  if (!cleanSlug) {
    cleanSlug = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  if (!SLUG_SHAPE.test(cleanSlug)) {
    const e = new Error('That name does not reduce to a usable role id. Try something simpler, or provide one.');
    e.statusCode = 400;
    throw e;
  }
  await loadMatrix(true); // ensure the registry reflects the latest Roles table before checking collisions
  const existingSlugs = knownRoleSlugs();
  if (existingSlugs.indexOf(cleanSlug) >= 0) {
    const e = new Error('A role with that id already exists.');
    e.statusCode = 409;
    throw e;
  }
  const dyn = roleRegistryCache.value;
  const labelTaken = dyn && Object.keys(dyn.alias).indexOf(cleanLabel.toLowerCase()) >= 0 &&
    dyn.alias[cleanLabel.toLowerCase()] !== cleanSlug;
  if (labelTaken) {
    const e = new Error('That name is already used by another role.');
    e.statusCode = 409;
    throw e;
  }
  const stamp = new Date().toISOString();
  await createRecord(TABLES.roles, {
    Role: cleanSlug,
    Label: cleanLabel,
    Permissions: ['suite.view'],
    'Updated At': stamp,
    'Updated By': byName || ''
  });
  // Bust both caches so the admin who just created this role sees it on
  // their very next request rather than waiting out MATRIX_TTL_MS.
  matrixCache = { at: 0, value: null };
  roleRegistryCache = { at: 0, value: null };
  const roles = await loadMatrix(true);
  return { roles, slug: cleanSlug, label: cleanLabel };
}

/* ---- Users ---------------------------------------------------------------- */

/** The only user shape that may cross the wire. No hash, no token, no expiry. */
function publicUser(rec) {
  const f = (rec && rec.fields) || {};
  const grants = f['Permission Grants'];
  const revokes = f['Permission Revokes'];
  return {
    id: rec.id,
    name: f.Name || '',
    email: String(f.Email || '').toLowerCase(),
    role: roleSlug(f.Role),
    division: f.Division || '',
    active: !!f.Active,
    pending: !!f.Pending,
    grants: Array.isArray(grants) ? grants : (grants ? [grants] : []),
    revokes: Array.isArray(revokes) ? revokes : (revokes ? [revokes] : [])
  };
}

const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();

const userByEmail = (email) =>
  findOne(TABLES.users, 'LOWER({Email}) = "' + esc(normEmail(email)) + '"');

async function userById(id) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(id || ''))) return null;
  try { return await airtable('GET', '/' + TABLES.users + '/' + id); }
  catch (e) { if (e && e.statusCode === 502) return null; throw e; }
}

const userByTokenHash = (hash) =>
  findOne(TABLES.users, '{Invite Token Hash} = "' + esc(hash) + '"');

/* ---- Session resolution --------------------------------------------------- */

/**
 * Read the session token, preferring X-OLH-Token over Authorization.
 *
 * Azure Static Web Apps OVERWRITES the Authorization header on every call to a
 * managed function: its edge proxy puts its own bearer token there before the
 * function is invoked, so whatever the browser sent is gone by the time this
 * runs. The symptom is specific and misleading -- sign-in works (it needs no
 * token), then every data endpoint 401s with "Your session has expired" even
 * though the user chip says they are signed in, because bearer() returns
 * Azure's token and readSession() rightly refuses it.
 *
 * Azure/static-web-apps#158 and #275, open since 2020. There is no setting for
 * it and the original value is not preserved under another name, so the only
 * fix is a header the proxy does not know about. OLHAuth.authHeaders() sends
 * BOTH: Authorization for Netlify and anything else, X-OLH-Token for Azure.
 *
 * Authorization stays as the fallback rather than being replaced, so a client
 * that predates this change keeps working on Netlify, and so does curl.
 */
function bearer(event) {
  const h = event.headers || {};
  const raw = h['x-olh-token'] || h['X-OLH-Token'] ||
              h.authorization || h.Authorization || '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/**
 * Resolve the caller. Throws a tagged error the handlers turn into a reply, so
 * every endpoint fails closed by default -- forgetting to check is not possible
 * without also forgetting to call this.
 */
async function requireSession(event) {
  const token = bearer(event);
  if (!token) {
    const e = new Error('Not signed in.');
    e.statusCode = 401;
    throw e;
  }
  const claim = readSession(token);
  if (!claim) {
    const e = new Error('Your session has expired. Sign in again.');
    e.statusCode = 401;
    throw e;
  }
  const rec = await userById(claim.userId);
  if (!rec) {
    const e = new Error('Your account no longer exists.');
    e.statusCode = 401;
    throw e;
  }
  const user = publicUser(rec);
  if (!user.active) {
    const e = new Error('Your account has been suspended.');
    e.statusCode = 403;
    throw e;
  }
  // Epoch mismatch means the account was suspended, reset, or signed out
  // everywhere after this token was minted.
  const epoch = Number((rec.fields && rec.fields['Session Epoch']) || 0);
  if (epoch !== claim.epoch) {
    const e = new Error('Your session is no longer valid. Sign in again.');
    e.statusCode = 401;
    throw e;
  }
  const matrix = await loadMatrix();
  const baseCan = matrix[user.role] || [];
  const can = applyOverrides(baseCan, user.role, user.grants, user.revokes);
  if (can.indexOf('suite.view') < 0) {
    const e = new Error('Your account does not have access to the OLH Suite yet. Ask an admin to grant it.');
    e.statusCode = 403;
    throw e;
  }
  return { user, record: rec, can, matrix };
}

/** Assert a capability, or throw a 403 carrying the frontend's own wording. */
const PAGE_LABEL = {
  'page.home': 'All Views (home)',
  'page.mywalks': 'My Walks',
  'page.tracker': 'QA & Closing Tracker',
  'page.completion': 'Completion Report',
  'page.walks': 'Walk Schedule',
  'page.game': 'Walk Reassignment',
  'page.qamgmt': 'QA Management',
  'page.missedwalks': 'Missed Walks',
  'page.scheduler': 'Schedule Optimizer',
  'page.timeoff': 'Time Off',
  'page.workload': 'Workload Predictor',
  'page.walkstoschedule': 'Walks To Schedule',
  'page.admin': 'User Administration',
  'page.keys': 'Keys',
  'page.sanmpr': 'SAN MPR (Sandbox)',
  'page.synchistory': 'Sync History',
  'page.redflags': 'Red Flags',
  'page.bonus': 'CCR Monthly Bonus',
  'page.bonusapproval': 'Approvals (Bonus + Case Aging + QA Bonus)',
  'page.caseaging': 'Case Aging Exception Request',
  'page.dailysummary': 'Daily Summary',
  'page.monthly1on1': 'Monthly One-on-One',
  'page.qabonus': 'QA Manager Monthly Bonus'
};
const DENY = {
  'suite.view': 'Your account does not have access to the OLH Suite yet. Ask an admin to grant it.',
  'tracker.edit': 'Your role can view the tracker but not change it.',
  'walk.complete': 'Your role can view My Walks but not mark walks complete.',
  'walk.schedule': 'Only QA Managers and admins can schedule or reassign walks.',
  'optimizer.apply': 'Only QA Managers and admins can apply optimizer suggestions.',
  'roster.manage': 'Only admins can change the roster.',
  // Deliberately its own capability rather than reusing tracker.edit: the two
  // validate the same field-whitelist shape, but a role that can only edit the
  // SAN MPR sandbox must never be able to reach the live update-job endpoint
  // just because it holds an editing capability. Keeping them separate means
  // the sandbox role's write access ends at the sandbox table even if someone
  // calls the API directly instead of clicking through the UI.
  'sandbox.edit': 'Your role can view the SAN MPR sandbox but not change it.'
};
// Same sentence the frontend builds, so a refusal reads identically whether it
// came from the page or from the API behind it.
for (const key of ALL_PAGES) {
  DENY[key] = 'Your role does not have access to the ' + PAGE_LABEL[key] + ' page.';
}

function requirePerm(session, perm) {
  if (session.can.indexOf(perm) < 0) {
    const e = new Error(DENY[perm] || 'You do not have access to that.');
    e.statusCode = 403;
    throw e;
  }
}

/** Turn a thrown error into a reply without leaking a stack or a token. */
function fail(err) {
  const status = (err && err.statusCode) || 500;
  const message = (err && err.message) || 'Unexpected server error.';
  const body = { error: message };
  if (err && err.extra) Object.assign(body, err.extra);
  return reply(status, body);
}

module.exports = {
  crypto, BASE_ID, AIRTABLE_API, TABLES, PERMS, DEFAULT_ROLES, DENY,
  JSON_HEADERS, reply, readJson, route, fail, sleep, esc,
  airtable, listRecords, findOne, createRecord, updateRecord, deleteRecord,
  caseAgingExceptionsApprovedCount,
  hashPassword, verifyPassword, checkPolicy,
  sha256, randomToken, mintSession, readSession, SESSION_TTL_MS,
  roleSlug, roleLabel, knownRoleSlugs, normalizeMatrix, applyOverrides, loadMatrix, saveMatrix, createRole,
  publicUser, normEmail, userByEmail, userById, userByTokenHash,
  bearer, requireSession, requirePerm
};
