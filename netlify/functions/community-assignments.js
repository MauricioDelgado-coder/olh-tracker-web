/**
 * Community -> manager (Area Construction Manager) assignments.
 *
 *   GET  /api/community-assignments
 *        -> {communities:[{community,key,homesites,managerId,managerName}],
 *            managers:[{id,name,role,roleLabel,division,eligible}],
 *            pendingApply, duplicates:[...]}
 *   PUT  /api/community-assignments {changes:[{community, from, to}]}
 *        -> {saved, apply:{updated, remaining}}
 *   POST /api/community-assignments {action:"apply"}
 *        -> {updated, remaining}
 *
 * Every method requires roster.manage -- this is the admin console's tab.
 *
 * ---- Where the data lives -------------------------------------------------
 *
 * The Community Assignments table (tblRI49xlslFx3wEL) holds ONE row per
 * community. That is what makes "a community can only belong to one manager"
 * true by construction rather than by UI convention: there is nowhere to put a
 * second manager. A blank manager is the unassigned bucket. If someone ever
 * hand-creates a second row for the same community, GET reports it and PUT
 * refuses to save until it is cleaned up -- guessing which row wins would make
 * the page show one answer and the sync write another.
 *
 * Jobs.'Area Construction Manager' is DERIVED from this table: the daily sync
 * (dev/sync_coe_to_airtable.py) recomputes it from Community on every run, and
 * this endpoint's apply step writes the same derivation immediately so a
 * reassignment shows on the Completion Report now rather than tomorrow. Both
 * use the same key -- whitespace squashed, upper-cased -- and the same scope:
 * Active rows that are not Manual Archive, which is exactly the set the sync
 * touches. Closed rows keep whatever they had when they closed.
 *
 * ---- Why PUT carries `from` -----------------------------------------------
 *
 * Two admins with the page open could otherwise each move the same community
 * and the second save would silently take it from the first. Every change says
 * who the client believed owned the community; if that is no longer true the
 * whole save is refused (409) and nothing is written.
 *
 * ---- Why apply is resumable ----------------------------------------------
 *
 * Moving a large community touches hundreds of Jobs rows at 10 per request and
 * 5 requests/second. Static Web Apps cuts an HTTP request off well before a
 * worst case (every community at once) would finish, so apply works for a time
 * budget, reports what is left, and the page calls POST {action:"apply"} until
 * remaining is 0. Apply only ever writes rows whose value differs, so calling
 * it again after a partial run -- or after the sync already caught up -- is a
 * no-op rather than a second write.
 */

'use strict';

const A = require('../lib/olh-auth');
const JobsCache = require('../lib/jobs-cache');

const TABLE = 'tblRI49xlslFx3wEL';
const ACM_FIELD = 'Area Construction Manager';
// SAN-only roles never manage an OLH community; leaving them out keeps the
// picker to people who can actually hold one.
const EXCLUDED_ROLES = ['sandbox', 'san_admin'];
const APPLY_BUDGET_MS = 15 * 1000;
const BATCH = 10;           // Airtable caps record writes at 10 per request
const MAX_CHANGES = 500;

/** Same comparison key as acm_for() in dev/sync_coe_to_airtable.py. */
const key = (s) => String(s == null ? '' : s).split(/\s+/).filter(Boolean).join(' ').toUpperCase();
const clean = (s) => String(s == null ? '' : s).split(/\s+/).filter(Boolean).join(' ');

function bad(status, message, extra) {
  const e = new Error(message);
  e.statusCode = status;
  if (extra) e.extra = extra;
  return e;
}

/** Page through a table asking only for the named fields. */
async function pageAll(tableId, fields, formula) {
  const out = [];
  let offset = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    (fields || []).forEach((f) => qs.append('fields[]', f));
    if (formula) qs.set('filterByFormula', formula);
    if (offset) qs.set('offset', offset);
    const json = await A.airtable('GET', '/' + tableId + '?' + qs.toString());
    if (json && Array.isArray(json.records)) out.push(...json.records);
    offset = (json && json.offset) || null;
    pages += 1;
    if (offset) await A.sleep(220);
  } while (offset && pages < 60);
  return out;
}

async function loadAssignments() {
  const recs = await pageAll(TABLE, ['Community', 'Manager Name', 'Manager User Id']);
  const byKey = new Map();
  const dupes = new Set();
  for (const r of recs) {
    const f = r.fields || {};
    const name = clean(f.Community);
    if (!name) continue;
    const k = key(name);
    if (byKey.has(k)) { dupes.add(name); continue; }
    byKey.set(k, {
      rowId: r.id,
      community: name,
      managerId: String(f['Manager User Id'] || '').trim() || null,
      managerName: clean(f['Manager Name'])
    });
  }
  return { byKey, dupes: Array.from(dupes).sort() };
}

const JOB_SCOPE = 'AND({Record Status}="Active", NOT({Manual Archive - Do Not Resync}))';

/* The Jobs read is the slow part (~13 pages, 10-25s when Airtable is busy),
 * and a save is GET -> PUT -> apply -> apply... back to back. Re-reading it
 * every call put a save plus its apply past Static Web Apps' request limit,
 * so it is held for JOBS_TTL_MS and patched in place by apply() as rows are
 * written -- the cached value is always what Airtable last accepted. Only two
 * fields are read, and only this file writes the ACM field outside the sync. */
const JOBS_TTL_MS = 60 * 1000;
let jobsCache = { at: 0, jobs: null };

async function loadJobs() {
  if (jobsCache.jobs && Date.now() - jobsCache.at < JOBS_TTL_MS) return jobsCache.jobs;
  const recs = await pageAll(A.TABLES.jobs, ['Community', ACM_FIELD], JOB_SCOPE);
  const jobs = recs.map((r) => ({
    id: r.id,
    community: clean(r.fields && r.fields.Community),
    acm: clean(r.fields && r.fields[ACM_FIELD])
  }));
  jobsCache = { at: Date.now(), jobs };
  return jobs;
}

async function loadUsers() {
  const recs = await A.listRecords(A.TABLES.users);
  return recs.map((r) => {
    const u = A.publicUser(r);
    return {
      id: u.id, name: u.name, role: u.role, roleLabel: A.roleLabel(u.role),
      division: u.division,
      eligible: u.active && EXCLUDED_ROLES.indexOf(u.role) < 0 && !!u.name
    };
  });
}

/** What Jobs.'Area Construction Manager' should read for one job. */
function desiredFor(job, byKey) {
  const row = byKey.get(key(job.community));
  return (row && row.managerId && row.managerName) ? row.managerName : '';
}

async function apply(byKey, budgetMs) {
  const jobs = await loadJobs();
  const pending = jobs
    .map((j) => ({ id: j.id, from: j.acm, to: desiredFor(j, byKey) }))
    .filter((j) => j.from !== j.to);
  const started = Date.now();
  let updated = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    if (Date.now() - started > budgetMs) break;
    const batch = pending.slice(i, i + BATCH);
    const json = await A.airtable('PATCH', '/' + A.TABLES.jobs, {
      records: batch.map((j) => ({ id: j.id, fields: { [ACM_FIELD]: j.to || null } }))
    });
    // Keep GET /api/jobs coherent on this instance, same as update-job.js.
    const byId = new Map(jobs.map((j) => [j.id, j]));
    ((json && json.records) || []).forEach((rec) => {
      if (rec && rec.id && rec.fields) JobsCache.applyWrite(rec.id, rec.fields);
      const j = rec && byId.get(rec.id);
      if (j) j.acm = clean(rec.fields && rec.fields[ACM_FIELD]);
    });
    updated += batch.length;
    if (i + BATCH < pending.length) await A.sleep(220);
  }
  return { updated, remaining: pending.length - updated };
}

async function getState() {
  const [{ byKey, dupes }, jobs, users] = await Promise.all([loadAssignments(), loadJobs(), loadUsers()]);

  // Communities = every community with an active homesite, plus every row in
  // the table (a community can be assigned ahead of its first homesite).
  const comm = new Map();
  for (const j of jobs) {
    if (!j.community) continue;
    const k = key(j.community);
    const c = comm.get(k) || { key: k, community: j.community, homesites: 0 };
    c.homesites += 1;
    comm.set(k, c);
  }
  for (const [k, row] of byKey) {
    if (!comm.has(k)) comm.set(k, { key: k, community: row.community, homesites: 0 });
  }

  const usersById = new Map(users.map((u) => [u.id, u]));
  const communities = Array.from(comm.values()).map((c) => {
    const row = byKey.get(c.key);
    const mgr = row && row.managerId ? usersById.get(row.managerId) : null;
    return Object.assign(c, {
      managerId: row ? row.managerId : null,
      // Prefer the live Users name; fall back to the stored one if the user
      // record is gone, so an orphaned assignment is still visible.
      managerName: row && row.managerId ? ((mgr && mgr.name) || row.managerName) : ''
    });
  }).sort((a, b) => a.community.localeCompare(b.community));

  // Eligible people, plus anyone who still holds a community but no longer
  // qualifies (suspended, moved to a SAN role) so their communities are shown
  // under them and can be moved off rather than vanishing.
  const holderIds = new Set(communities.map((c) => c.managerId).filter(Boolean));
  const managers = users
    .filter((u) => u.eligible || holderIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const id of holderIds) {
    if (!usersById.has(id)) {
      const c = communities.find((x) => x.managerId === id);
      managers.push({ id, name: (c && c.managerName) || id, role: '', roleLabel: 'No longer in Users',
        division: '', eligible: false });
    }
  }

  const pendingApply = jobs.filter((j) => j.acm !== desiredFor(j, byKey)).length;
  return { communities, managers, pendingApply, duplicates: dupes };
}

async function save(session, body) {
  const changes = body && Array.isArray(body.changes) ? body.changes : null;
  if (!changes || !changes.length) throw bad(400, 'Send {changes:[{community, from, to}]}.');
  if (changes.length > MAX_CHANGES) throw bad(400, 'Too many changes in one save.');

  const [{ byKey, dupes }, users, jobs] = await Promise.all([loadAssignments(), loadUsers(), loadJobs()]);
  if (dupes.length) {
    throw bad(409, 'The Community Assignments table has more than one row for: ' + dupes.join(', ') +
      '. Delete the extra row in Airtable, then reload and save again.');
  }
  const usersById = new Map(users.map((u) => [u.id, u]));
  const known = new Map();
  jobs.forEach((j) => { if (j.community) known.set(key(j.community), j.community); });
  byKey.forEach((row, k) => { if (!known.has(k)) known.set(k, row.community); });

  const seen = new Set();
  const stale = [];
  const plan = [];
  for (const ch of changes) {
    const name = clean(ch && ch.community);
    const k = key(name);
    if (!k || !known.has(k)) throw bad(400, 'Unknown community: ' + (name || '(blank)') + '.');
    if (seen.has(k)) throw bad(400, name + ' appears twice in one save.');
    seen.add(k);
    const to = ch.to ? String(ch.to) : null;
    const from = ch.from ? String(ch.from) : null;
    if (to) {
      const u = usersById.get(to);
      if (!u || !u.eligible) throw bad(400, 'That manager cannot be assigned a community (not an active OLH user).');
    }
    const row = byKey.get(k);
    const current = row ? row.managerId : null;
    if (current !== from) stale.push(known.get(k));
    if (current === to) continue;
    plan.push({ k, name: (row && row.community) || known.get(k), row, to });
  }
  if (stale.length) {
    throw bad(409, 'Someone else changed ' + stale.join(', ') + ' since this page loaded. ' +
      'Nothing was saved -- reload to see the current assignments.', { stale });
  }

  const now = new Date().toISOString();
  const by = session.user.name || session.user.email || 'admin';
  const fieldsFor = (p) => {
    const u = p.to ? usersById.get(p.to) : null;
    return {
      'Manager Name': u ? u.name : '',
      'Manager User Id': u ? u.id : '',
      'Updated By': by,
      'Updated At': now
    };
  };
  const updates = plan.filter((p) => p.row);
  const creates = plan.filter((p) => !p.row);
  for (let i = 0; i < updates.length; i += BATCH) {
    await A.airtable('PATCH', '/' + TABLE, {
      records: updates.slice(i, i + BATCH).map((p) => ({ id: p.row.rowId, fields: fieldsFor(p) }))
    });
    await A.sleep(220);
  }
  for (let i = 0; i < creates.length; i += BATCH) {
    await A.airtable('POST', '/' + TABLE, {
      records: creates.slice(i, i + BATCH).map((p) => ({ fields: Object.assign({ Community: p.name }, fieldsFor(p)) }))
    });
    await A.sleep(220);
  }

  // Re-read so apply works from what Airtable now holds, not from the plan.
  const fresh = await loadAssignments();
  const applied = await apply(fresh.byKey, APPLY_BUDGET_MS);
  return { saved: plan.length, apply: applied };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, PUT, POST' }), body: '' };
  }
  try {
    const session = await A.requireSession(event);
    A.requirePerm(session, 'roster.manage');

    if (event.httpMethod === 'GET') return A.reply(200, await getState());
    if (event.httpMethod === 'PUT') return A.reply(200, await save(session, A.readJson(event)));
    if (event.httpMethod === 'POST') {
      const body = A.readJson(event);
      if (!body || body.action !== 'apply') return A.reply(400, { error: 'Send {action:"apply"}.' });
      const { byKey, dupes } = await loadAssignments();
      if (dupes.length) {
        return A.reply(409, { error: 'The Community Assignments table has more than one row for: ' + dupes.join(', ') + '.' });
      }
      return A.reply(200, await apply(byKey, APPLY_BUDGET_MS));
    }
    return A.reply(405, { error: 'GET, PUT, or POST only.' });
  } catch (err) {
    return A.fail(err);
  }
};

// Exposed for dev tests; not routes.
exports._internal = { key, desiredFor };
