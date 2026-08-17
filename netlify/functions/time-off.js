/**
 * GET    /api/time-off              -> { entries: [{id, personId, personName, date, reason, addedBy, startTime, endTime}] }
 * POST   /api/time-off  {personId, personName, date, reason?, startTime?, endTime?} -> { entry }
 * DELETE /api/time-off  {id}        -> { ok: true }
 *
 * Backs the standalone Time Off page and is read by every page that assigns
 * a QA Manager to a walk -- scheduler.html, walk-calendar.html, and the
 * workload pages -- so a manager on time off is excluded from candidate
 * pools and manual-assignment dropdowns on every one of them, not just
 * whichever page happens to have its own copy of the list in React state.
 *
 * startTime/endTime are both optional and both-or-neither: omitting them
 * means the whole day is off, same as before this field existed. Setting
 * both blocks only that clock-hour window on that date -- scheduler.html
 * checks a CEL/ACC walk's fixed slot (9am/12pm/3pm) against the window
 * rather than blacking out the entire day for a half-day appointment.
 * Format is 24-hour "HH:MM", validated below; stored as plain text since
 * Airtable has no bare time-of-day field type.
 *
 * This table lives in its OWN Airtable base (separate from the main OLH QA &
 * Closing Tracker base) because there is no tool available to add a table to
 * an existing base -- only to create a new one. Person Id is a plain string
 * matched against Walk Roster's Person Id in the main base's /api/walk-config
 * response; it is not a linked-record field, so no cross-base link is needed.
 *
 * Requires a valid session with suite.view to read (same tier as
 * /api/walk-config). Adding or removing an entry requires walk.schedule --
 * the same permission that gates reassigning a walk, since taking someone
 * off the board for a day is the same class of scheduling decision.
 *
 * The Airtable PAT is read ONLY from process.env.AIRTABLE_PAT. It is never
 * returned to the client and never logged.
 */

'use strict';

const A = require('../lib/olh-auth');

const BASE_ID = 'appNSVerTjL8xtKJU';
const TIME_OFF_TABLE = 'tbl3usD3WtyJweN1h';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
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
    const e = new Error(
      'Server is not configured: the AIRTABLE_PAT environment variable is unset.'
    );
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

async function listAll() {
  const records = [];
  let offset = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const json = await airtable('GET', `/${TIME_OFF_TABLE}?${qs.toString()}`);
    if (json && Array.isArray(json.records)) records.push(...json.records);
    offset = (json && json.offset) || null;
    pages += 1;
    if (offset && pages < 20) await new Promise((r) => setTimeout(r, 220));
  } while (offset && pages < 20);
  return records;
}

function toEntry(r) {
  const f = r.fields || {};
  return {
    id: r.id,
    personId: f['Person Id'] || '',
    personName: f['Person Name'] || '',
    date: f.Date || '',
    reason: f.Reason || '',
    addedBy: f['Added By'] || '',
    startTime: f['Start Time'] || '',
    endTime: f['End Time'] || ''
  };
}

function trimmed(v, max) {
  if (v == null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...JSON_HEADERS, Allow: 'GET, POST, DELETE' }, body: '' };
  }

  let session;
  try {
    session = await A.requireSession(event);
  } catch (err) {
    return A.fail(err);
  }

  try {
    if (event.httpMethod === 'GET') {
      const records = await listAll();
      const entries = records
        .map(toEntry)
        .sort((a, b) => a.date.localeCompare(b.date) || a.personName.localeCompare(b.personName));
      return reply(200, { entries });
    }

    if (event.httpMethod === 'POST') {
      A.requirePerm(session, 'walk.schedule');

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (_) {
        return reply(400, { error: 'Request body must be valid JSON.' });
      }

      const personId = trimmed(body.personId, MAX_TEXT_LEN);
      const personName = trimmed(body.personName, MAX_TEXT_LEN);
      const date = trimmed(body.date, 10);
      const reason = trimmed(body.reason, MAX_TEXT_LEN);
      const startTime = trimmed(body.startTime, 5);
      const endTime = trimmed(body.endTime, 5);

      if (!personId) return reply(400, { error: 'personId is required.' });
      if (!date || !DATE_RE.test(date)) {
        return reply(400, { error: 'date must be formatted YYYY-MM-DD.' });
      }
      if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
        return reply(400, { error: 'date is not a real calendar date.' });
      }
      // Both-or-neither: a lone start or end time is ambiguous (open-ended
      // off period? typo?) so it is rejected rather than guessed at.
      if ((startTime && !endTime) || (endTime && !startTime)) {
        return reply(400, { error: 'startTime and endTime must be set together, or both left blank for a full day off.' });
      }
      if (startTime && !TIME_RE.test(startTime)) {
        return reply(400, { error: 'startTime must be formatted 24-hour HH:MM.' });
      }
      if (endTime && !TIME_RE.test(endTime)) {
        return reply(400, { error: 'endTime must be formatted 24-hour HH:MM.' });
      }
      if (startTime && endTime && startTime >= endTime) {
        return reply(400, { error: 'endTime must be later than startTime.' });
      }

      const fields = {
        'Person Id': personId,
        'Person Name': personName,
        Date: date,
        'Added By': session.user.name || ''
      };
      if (reason) fields.Reason = reason;
      if (startTime && endTime) { fields['Start Time'] = startTime; fields['End Time'] = endTime; }

      const created = await airtable('POST', `/${TIME_OFF_TABLE}`, { fields, typecast: true });
      return reply(200, { entry: toEntry(created) });
    }

    if (event.httpMethod === 'DELETE') {
      A.requirePerm(session, 'walk.schedule');

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (_) {
        return reply(400, { error: 'Request body must be valid JSON.' });
      }
      const id = trimmed(body.id, 40);
      if (!/^rec[A-Za-z0-9]{14}$/.test(id)) {
        return reply(400, { error: 'id must be a single Airtable record id matching ^rec[A-Za-z0-9]{14}$.' });
      }
      await airtable('DELETE', `/${TIME_OFF_TABLE}/${encodeURIComponent(id)}`);
      return reply(200, { ok: true });
    }

    return reply(405, { error: 'Method not allowed. This endpoint accepts GET, POST and DELETE.' });
  } catch (err) {
    return A.fail(err);
  }
};
