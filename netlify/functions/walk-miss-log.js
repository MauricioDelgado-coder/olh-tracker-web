/**
 * The append-only walk miss history.
 *
 * Jobs carries one set of Missed/Miss Reason/Miss Note fields PER WALK TYPE --
 * QAI, QAA, CEL, ACC. That is a snapshot of the most recent miss, not a count:
 * mark QAI missed twice on the same home and the second write silently erases
 * the first, because there is nowhere else for it to go. This table exists so
 * "how many times has this home been missed, and why" has an actual answer.
 *
 *   POST  /api/walk-miss-log
 *         {recordId, job, walkType, missedDate?, reason, note?, page?}
 *         -> {entry}
 *
 *   GET   /api/walk-miss-log[?recordId=rec…][&walkType=QAI]
 *         -> {entries:[…]}   (newest first; whole log when recordId is omitted,
 *                             which is how the missed-walks reconcile queue
 *                             reads it)
 *
 *   PATCH /api/walk-miss-log
 *         {recordId, walkType, missId?}
 *         -> {entry|null}    marks the most recent unreconciled entry for that
 *                             job+walk type Reconciled -- mirrors the per-type
 *                             "Walk Miss Reconciled" checkbox on Jobs, which
 *                             stays the fast/authoritative signal for today's
 *                             queues. This just keeps the log in sync with it.
 *
 * Three things carried over deliberately from audit.js's shape:
 *
 * 1. "Logged By"/"Logged By Role"/"Logged At" come from the session and the
 *    server clock, never the body -- same reasoning as Changed By/At there.
 * 2. Miss Id is an idempotency key. A caller that retries a flaky POST must
 *    not append the same miss twice.
 * 3. This never overwrites Jobs. It is written ALONGSIDE the existing
 *    update-job PATCH from the page that calls it, not instead of it -- the
 *    per-type checkboxes on Jobs remain the fast read for "is this walk
 *    currently missed", and this table is the history behind that snapshot.
 */

'use strict';

const A = require('../lib/olh-auth');

const WALK_TYPES = Object.freeze(['QAI', 'QAA', 'CEL', 'ACC']);
const MISS_REASONS = Object.freeze([
  'Home not ready',
  'Buyer no-show',
  'Manager unavailable',
  'Other'
]);

const str = (v) => (v == null ? '' : String(v));

function entryOf(rec) {
  const f = rec.fields || {};
  // A linked-record field comes back from the REST API as an array of record
  // IDs, so this is the Jobs record id -- NOT the Job #, despite the `job`
  // key's name. append() overwrites `job` with the real Job # from the body;
  // a GET has no body to take it from, so callers that need to join back to
  // Jobs must use jobRecordId and look the Job # up there.
  const link = (Array.isArray(f.Job) && f.Job[0]) || '';
  return {
    id: f['Miss Id'] || rec.id,
    recordId: rec.id,
    jobRecordId: link,
    job: link,
    walkType: f['Walk Type'] || '',
    missedDate: f['Missed Date'] || '',
    reason: f['Miss Reason'] || '',
    note: f['Miss Note'] || '',
    reconciled: !!f.Reconciled,
    rescheduleFlag: !!f['Reschedule Flag'],
    by: f['Logged By'] || '',
    byRole: f['Logged By Role'] || '',
    at: f['Logged At'] || '',
    page: f.Page || '',
    migrated: !!f['Superseded By Migration']
  };
}

async function append(event) {
  const session = await A.requireSession(event);
  // Same OR as update-job.js's COMPLETION_ONLY_FIELDS gate: logging a miss is
  // part of the completion workflow, so walk.complete alone is enough here --
  // there's no field-shape distinction to make since this table has no
  // whitelist of its own, just Job/Walk Type/Reason/Note.
  if (session.can.indexOf('tracker.edit') < 0 && session.can.indexOf('walk.complete') < 0) {
    const e = new Error(A.DENY['walk.complete']);
    e.statusCode = 403;
    throw e;
  }
  const body = A.readJson(event);

  const recordId = str(body.recordId).trim();
  const job = str(body.job).trim();
  const walkType = str(body.walkType).trim().toUpperCase();
  const reason = str(body.reason).trim();
  const note = str(body.note);
  const missedDate = str(body.missedDate).trim();
  const page = str(body.page).trim();

  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return A.reply(400, { error: 'A walk miss log entry needs a valid Jobs recordId.' });
  }
  if (WALK_TYPES.indexOf(walkType) < 0) {
    return A.reply(400, { error: '"walkType" must be one of: ' + WALK_TYPES.join(', ') + '.' });
  }
  if (!reason) {
    return A.reply(400, { error: 'A walk miss log entry needs a reason.' });
  }
  if (MISS_REASONS.indexOf(reason) < 0) {
    return A.reply(400, { error: '"reason" must be one of: ' + MISS_REASONS.join(', ') + '.' });
  }

  const missId = str(body.missId).trim() ||
    ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same entry returns the row already written.
  const existing = await A.findOne(A.TABLES.walkMissLog, '{Miss Id} = "' + A.esc(missId) + '"');
  if (existing) return A.reply(200, { entry: entryOf(existing) });

  const fields = {
    'Miss Id': missId,
    Job: [recordId],
    'Walk Type': walkType,
    'Miss Reason': reason,
    'Logged By': session.user.name,
    'Logged By Role': session.user.role,
    'Logged At': new Date().toISOString(),
    Page: page
  };
  if (note) fields['Miss Note'] = note;
  if (missedDate) fields['Missed Date'] = missedDate;

  const created = await A.createRecord(A.TABLES.walkMissLog, fields);
  // Job # isn't a field on this table (the link carries it) -- fold it into
  // the returned shape for callers that want it without a second lookup.
  const entry = entryOf(created);
  entry.job = job || entry.job;
  return A.reply(201, { entry });
}

async function list(event) {
  const session = await A.requireSession(event);
  const q = event.queryStringParameters || {};
  const recordId = str(q.recordId).trim();

  // {Job} on a linked-record field renders as the linked record's primary
  // field value (Job #) in a filter formula, not the record id -- Airtable's
  // formula language has no direct "does this link contain id X" operator, so
  // list-and-filter client-side instead of trusting a formula on the link.
  //
  // recordId is OPTIONAL: omit it and this returns the whole log, which is
  // what the reconcile queue on missed-walks.html reads. There is no
  // maxRecords cap here either -- listRecords pages on its own, and a cap
  // truncates the OLDEST entries first, which are precisely the unreconciled
  // misses a queue exists to surface.
  void session;
  const recs = await A.listRecords(A.TABLES.walkMissLog, {
    'sort[0][field]': 'Logged At',
    'sort[0][direction]': 'desc'
  });
  let entries = recs
    .filter((r) => !recordId ||
      (Array.isArray(r.fields && r.fields.Job) && r.fields.Job.indexOf(recordId) >= 0))
    .map(entryOf);
  if (q.walkType) {
    const wt = str(q.walkType).trim().toUpperCase();
    entries = entries.filter((e) => e.walkType === wt);
  }
  return A.reply(200, { entries });
}

async function reconcile(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'tracker.edit');
  const body = A.readJson(event);

  const recordId = str(body.recordId).trim();
  const walkType = str(body.walkType).trim().toUpperCase();
  // Optional, and preferred when the caller has it. A job can carry several
  // misses of the SAME walk type on different days (missed, rescheduled,
  // missed again), so "most recent unreconciled" is a guess. missId names the
  // exact row the person clicked instead of guessing.
  const missId = str(body.missId).trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return A.reply(400, { error: 'Pass a valid Jobs recordId.' });
  }
  if (WALK_TYPES.indexOf(walkType) < 0) {
    return A.reply(400, { error: '"walkType" must be one of: ' + WALK_TYPES.join(', ') + '.' });
  }

  // No maxRecords: a cap drops the oldest rows, which are the ones most likely
  // to still be unreconciled.
  const recs = await A.listRecords(A.TABLES.walkMissLog, {
    'sort[0][field]': 'Logged At',
    'sort[0][direction]': 'desc'
  });
  const hit = recs.find((r) =>
    Array.isArray(r.fields && r.fields.Job) && r.fields.Job.indexOf(recordId) >= 0 &&
    (r.fields['Walk Type'] || '') === walkType &&
    (missId ? (r.fields['Miss Id'] || '') === missId : !r.fields.Reconciled)
  );
  if (!hit) return A.reply(200, { entry: null });

  const updated = await A.updateRecord(A.TABLES.walkMissLog, hit.id, {
    Reconciled: true,
    'Logged By': session.user.name,
    'Logged By Role': session.user.role
  });
  return A.reply(200, { entry: entryOf(updated) });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST, PATCH' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') return await append(event);
    if (event.httpMethod === 'GET') return await list(event);
    if (event.httpMethod === 'PATCH') return await reconcile(event);
    return A.reply(405, { error: 'GET, POST, or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
