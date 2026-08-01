/**
 * The append-only change log.
 *
 *   POST /api/audit {recordId, job, field, label, from, to, action, page}
 *        -> {entry, conflict?:{by,at,value}}
 *   GET  /api/audit?recordId=rec…[&field=…][&since=ISO] -> {entries:[…]}
 *
 * Three things are deliberate:
 *
 * 1. "Changed By" and "Changed At" are taken from the session and the server
 *    clock, never from the body. A client that could name someone else as the
 *    author would make the log worth less than no log.
 * 2. Entry Id is an idempotency key. The tracker retries on a flaky connection,
 *    and a retry must not append a second row saying the same change happened
 *    twice.
 * 3. conflict is computed on the way in: if somebody else already changed this
 *    field after the timestamp the caller is working from, the response says so
 *    and the tracker can warn instead of silently overwriting.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));

function entryOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Entry Id'] || rec.id,
    recordId: f['Record Id'] || '',
    job: f['Job #'] || '',
    field: f.Field || '',
    label: f.Label || '',
    from: f.From || '',
    to: f.To || '',
    action: f.Action || '',
    page: f.Page || '',
    by: f['Changed By'] || '',
    byId: f['Changed By Id'] || '',
    byRole: f['Changed By Role'] || '',
    at: f['Changed At'] || ''
  };
}

async function append(event) {
  const session = await A.requireSession(event);
  const body = A.readJson(event);

  const recordId = str(body.recordId).trim();
  const field = str(body.field).trim();
  if (!recordId) return A.reply(400, { error: 'An audit entry needs a recordId.' });

  const entryId = str(body.id).trim() ||
    ('a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same entry returns the row already written.
  const existing = await A.findOne(A.TABLES.audit, '{Entry Id} = "' + A.esc(entryId) + '"');
  if (existing) return A.reply(200, { entry: entryOf(existing), conflict: null });

  // Has anyone else touched this field since the caller last read the record?
  let conflict = null;
  if (field && body.since) {
    const since = Date.parse(body.since);
    if (!Number.isNaN(since)) {
      const recent = await A.listRecords(A.TABLES.audit, {
        filterByFormula: 'AND({Record Id} = "' + A.esc(recordId) + '", {Field} = "' + A.esc(field) + '")',
        'sort[0][field]': 'Changed At',
        'sort[0][direction]': 'desc',
        maxRecords: '20'
      });
      const other = recent.map(entryOf).find(
        (e) => e.byId !== session.user.id && e.at && Date.parse(e.at) > since
      );
      if (other) conflict = { by: other.by, at: other.at, value: other.to };
    }
  }

  const created = await A.createRecord(A.TABLES.audit, {
    'Entry Id': entryId,
    'Record Id': recordId,
    'Job #': str(body.job),
    Field: field,
    Label: str(body.label),
    From: str(body.from),
    To: str(body.to),
    Action: str(body.action) || 'edit',
    Page: str(body.page),
    // From the session, not the body.
    'Changed By': session.user.name,
    'Changed By Id': session.user.id,
    'Changed By Role': session.user.role,
    'Changed At': new Date().toISOString()
  });

  return A.reply(201, { entry: entryOf(created), conflict });
}

async function history(event) {
  const session = await A.requireSession(event);
  const q = event.queryStringParameters || {};
  const recordId = str(q.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'Pass ?recordId=rec…' });

  const clauses = ['{Record Id} = "' + A.esc(recordId) + '"'];
  if (q.field) clauses.push('{Field} = "' + A.esc(q.field) + '"');

  const recs = await A.listRecords(A.TABLES.audit, {
    filterByFormula: clauses.length > 1 ? 'AND(' + clauses.join(', ') + ')' : clauses[0],
    'sort[0][field]': 'Changed At',
    'sort[0][direction]': 'desc',
    maxRecords: '200'
  });

  let entries = recs.map(entryOf);
  if (q.since) {
    const since = Date.parse(q.since);
    if (!Number.isNaN(since)) {
      entries = entries.filter((e) => e.at && Date.parse(e.at) > since);
    }
  }
  // Referenced so the signature matches append() and the session is provably read.
  void session;
  return A.reply(200, { entries });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') return await append(event);
    if (event.httpMethod === 'GET') return await history(event);
    return A.reply(405, { error: 'GET or POST only.' });
  } catch (err) {
    return A.fail(err);
  }
};
