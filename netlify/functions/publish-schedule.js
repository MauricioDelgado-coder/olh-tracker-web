/**
 * GET  /api/publish-schedule?date=YYYY-MM-DD
 *      -> { published: null } or
 *         { published: { date, locked, publishedBy, publishedAt, rowCount } }
 *
 * POST /api/publish-schedule  { date, rows, action? }
 *      action defaults to "publish":
 *        "publish" -> upserts the Published Schedules record for `date`,
 *                     stores `rows` as the frozen Snapshot, sets Locked = true.
 *        "unlock"  -> sets Locked = false on the existing record for `date`
 *                     (the Snapshot is kept, not deleted, so history survives
 *                     an accidental unlock/relock).
 *      -> { published: {...} }
 *
 * This is the write side of the public schedule. /api/public-schedule is the
 * read side and takes NO session -- it only ever reads the Snapshot this
 * endpoint writes, never the Jobs table, so a street address never has to be
 * a public-page decision: it is simply not part of what gets stored here.
 * (Snapshot rows are job #, community, walk type, time, and manager only.)
 *
 * Requires walk.schedule -- the same tier as reassigning a walk, since
 * publishing freezes a day's assignments for the world to see and un-freezing
 * it is exactly as consequential.
 *
 * Lives in its own Airtable base for the same reason netlify/functions/time-off.js
 * does: there is no tool available to add a table to an existing base, only
 * to create a new one.
 */

'use strict';

const A = require('../lib/olh-auth');

const BASE_ID = 'appypFnJwp8DpNuBv';
const TABLE = 'Published Schedules';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 500;
const MAX_TEXT_LEN = 200;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function reply(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function airtable(method, pathSuffix, body) {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat || !String(pat).trim()) {
    const e = new Error('Server is not configured: the AIRTABLE_PAT environment variable is unset.');
    e.statusCode = 500;
    throw e;
  }
  const res = await fetch(`${AIRTABLE_API}/${BASE_ID}${pathSuffix}`, {
    method,
    headers: Object.assign(
      { Authorization: `Bearer ${pat}` },
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
      `Airtable returned ${res.status} for ${method} ${pathSuffix}` + (detail ? `: ${detail}` : '')
    );
    e.statusCode = 502;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

function esc(s) { return String(s == null ? '' : s).split('"').join('\\"'); }

async function findByDate(date) {
  const qs = new URLSearchParams({
    filterByFormula: `{Date} = "${esc(date)}"`,
    maxRecords: '1'
  });
  const json = await airtable('GET', `/${encodeURIComponent(TABLE)}?${qs.toString()}`);
  return (json && json.records && json.records[0]) || null;
}

function toPublished(rec) {
  const f = rec.fields || {};
  let rows = [];
  try { rows = JSON.parse(f.Snapshot || '[]'); } catch (_) { rows = []; }
  return {
    date: f.Date || '',
    locked: !!f.Locked,
    publishedBy: f['Published By'] || '',
    publishedAt: f['Published At'] || '',
    rowCount: Array.isArray(rows) ? rows.length : 0
  };
}

function trimmed(v, max) {
  if (v == null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Only the fields the public page needs ever get stored -- no address, no ids. */
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) {
    const e = new Error('rows must be an array.');
    e.statusCode = 400;
    throw e;
  }
  if (rows.length > MAX_ROWS) {
    const e = new Error(`rows exceeds the ${MAX_ROWS}-row limit.`);
    e.statusCode = 400;
    throw e;
  }
  return rows.map((r) => ({
    job: trimmed(r && r.job, MAX_TEXT_LEN),
    community: trimmed(r && r.community, MAX_TEXT_LEN),
    code: trimmed(r && r.code, 10),
    walk: trimmed(r && r.walk, MAX_TEXT_LEN),
    when: trimmed(r && r.when, 40),
    manager: trimmed(r && r.manager, MAX_TEXT_LEN)
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...JSON_HEADERS, Allow: 'GET, POST' }, body: '' };
  }

  let session;
  try {
    session = await A.requireSession(event);
  } catch (err) {
    return A.fail(err);
  }

  try {
    if (event.httpMethod === 'GET') {
      const date = trimmed((event.queryStringParameters || {}).date, 10);
      if (!date || !DATE_RE.test(date)) {
        return reply(400, { error: 'date must be formatted YYYY-MM-DD.' });
      }
      const rec = await findByDate(date);
      return reply(200, { published: rec ? toPublished(rec) : null });
    }

    if (event.httpMethod === 'POST') {
      A.requirePerm(session, 'walk.schedule');

      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (_) { return reply(400, { error: 'Request body must be valid JSON.' }); }

      const date = trimmed(body.date, 10);
      if (!date || !DATE_RE.test(date)) {
        return reply(400, { error: 'date must be formatted YYYY-MM-DD.' });
      }
      if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
        return reply(400, { error: 'date is not a real calendar date.' });
      }
      const action = body.action === 'unlock' ? 'unlock' : 'publish';

      const existing = await findByDate(date);

      if (action === 'unlock') {
        if (!existing) return reply(404, { error: 'No published schedule exists for that date.' });
        const updated = await airtable('PATCH', `/${encodeURIComponent(TABLE)}/${existing.id}`, {
          fields: { Locked: false },
          typecast: true
        });
        return reply(200, { published: toPublished(updated) });
      }

      const rows = sanitizeRows(body.rows);
      const fields = {
        Date: date,
        Snapshot: JSON.stringify(rows),
        Locked: true,
        'Published By': session.user.name || '',
        'Published At': new Date().toISOString()
      };

      const saved = existing
        ? await airtable('PATCH', `/${encodeURIComponent(TABLE)}/${existing.id}`, { fields, typecast: true })
        : await airtable('POST', `/${encodeURIComponent(TABLE)}`, { fields, typecast: true });

      return reply(200, { published: toPublished(saved) });
    }

    return reply(405, { error: 'Method not allowed. This endpoint accepts GET and POST.' });
  } catch (err) {
    return A.fail(err);
  }
};
