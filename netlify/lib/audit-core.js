/**
 * Shared implementation of the append-only change log, so the OLH log
 * (audit.js -> OLH base) and the SAN log (audit-san.js -> SAN base) are one
 * piece of code bound to two tables. See audit.js for the contract.
 */

'use strict';

const A = require('./olh-auth');

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

async function append(db, table, event) {
  const session = await A.requireSession(event);
  const body = A.readJson(event);

  const recordId = str(body.recordId).trim();
  const field = str(body.field).trim();
  if (!recordId) return A.reply(400, { error: 'An audit entry needs a recordId.' });

  const entryId = str(body.id).trim() ||
    ('a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same entry returns the row already written.
  const existing = await db.findOne(table, '{Entry Id} = "' + A.esc(entryId) + '"');
  if (existing) return A.reply(200, { entry: entryOf(existing), conflict: null });

  // Has anyone else touched this field since the caller last read the record?
  let conflict = null;
  if (field && body.since) {
    const since = Date.parse(body.since);
    if (!Number.isNaN(since)) {
      const recent = await db.listRecords(table, {
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

  const created = await db.createRecord(table, {
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

async function history(db, table, event) {
  const session = await A.requireSession(event);
  const q = event.queryStringParameters || {};
  const recordId = str(q.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'Pass ?recordId=rec…' });

  const clauses = ['{Record Id} = "' + A.esc(recordId) + '"'];
  if (q.field) clauses.push('{Field} = "' + A.esc(q.field) + '"');

  const recs = await db.listRecords(table, {
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

function makeAuditHandler(db, table) {
  return async (event) => {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST' }),
        body: ''
      };
    }

    try {
      if (event.httpMethod === 'POST') return await append(db, table, event);
      if (event.httpMethod === 'GET') return await history(db, table, event);
      return A.reply(405, { error: 'GET or POST only.' });
    } catch (err) {
      return A.fail(err);
    }
  };
}

module.exports = { makeAuditHandler, entryOf };
