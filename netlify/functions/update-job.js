/**
 * POST /api/update-job
 * Body: { recordId: "recXXXXXXXXXXXXXX", fields: { "<whitelisted field>": value, ... } }
 *
 * Defense-in-depth. Layer 0 was added in 2026-08 when the suite got real
 * accounts; the four layers under it predate that and still stand on their own,
 * because an authenticated user is not the same thing as a trusted one:
 *   0. A valid session is required, and the caller must hold tracker.edit --
 *      OR, added 2026-08-25, walk.complete, but only for the narrower
 *      COMPLETION_ONLY_FIELDS subset (see below): a My Walks QAM can mark a
 *      walk complete, log buyer attendance, or record a miss without gaining
 *      the tracker.edit capability that opens the tracker itself. Any field
 *      outside that subset still requires full tracker.edit. Reassigning a
 *      walk between managers additionally requires walk.schedule
 *      (see WRITE_PERM), so a Construction Manager can correct a date but cannot
 *      move someone else's walk.
 *   1. POST only. One record per call. PATCH only -- no create, delete, batch or schema access.
 *   2. Strict allow-list: any field name not in EDITABLE below causes a 400 that names
 *      the offending keys. Salesforce-sourced fields, `Record Status`, `Closed Date`
 *      and `Last Synced` are owned by the daily sync and can never be written here.
 *   3. Per-type server-side validation (dates, datetimes, booleans, record-id arrays,
 *      single-select option names, single-line text, long text).
 *   4. noindex/nofollow headers on every response.
 */

'use strict';

const A = require('../lib/olh-auth');

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tblqpmwtZ6i4gtogl';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LEN = 10000;
const MAX_LINE_LEN = 500;
const MAX_LINKS = 10;

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Scheduling-conflict guard (added 2026-08). update-job's five layers above
 * validate shape and permission, but say nothing about whether the write
 * makes sense on the calendar -- a manager could be assigned two overlapping
 * walks, or pushed over their daily cap, with no error at all. This block
 * closes that gap for the one write that matters for it: reassigning a
 * *Manager link field. It does not fire for miss-reason edits, notes, key
 * status, etc. -- only when QAI/QAA/CEL/ACC Manager is present in `fields`.
 *
 * Constants mirror references/three-pass-algorithm.md in the walk-review
 * skill. If that file's numbers ever change, change them here in the same
 * commit (and vice versa) -- there is no single source of truth between an
 * Airtable app and a Claude skill, so this has to be kept in sync by hand.
 *
 * Every manager, including Justin Essigmann, uses the same 480-min cap and
 * the same full CEL/ACC eligibility -- there are no manager-specific
 * exceptions in this app. If the walk-review skill's reference doc still
 * lists a different rule for Justin, that doc is stale, not this file.
 */
const WALK_DURATION_MIN = Object.freeze({ QAI: 120, QAA: 60, CEL: 120, ACC: 60 });
const DAILY_CAP_MIN = 480; // applies to every manager, no exceptions (incl. Justin Essigmann)

const WALK_TYPES = Object.freeze({
  QAI: { managerField: 'QAI Manager', dateField: 'QAI Date', isDatetime: false },
  QAA: { managerField: 'QAA Manager', dateField: 'QAA Date', isDatetime: false },
  CEL: { managerField: 'CEL Manager', dateField: 'CEL Date', isDatetime: true },
  ACC: { managerField: 'ACC Manager', dateField: 'ACC Date', isDatetime: true }
});

function dayKeyOf(value, isDatetime) {
  if (!value) return null;
  return isDatetime ? String(value).slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Fetch every Jobs row that has any walk on `dayKey`, excluding `excludeId`.
 * One query covers all four walk types since a manager's cap is summed
 * across QAI/QAA/CEL/ACC together, not per type.
 */
async function fetchJobsOnDay(pat, dayKey, excludeId) {
  const formula = `AND(
    RECORD_ID() != "${excludeId}",
    OR(
      DATESTR({QAI Date}) = "${dayKey}",
      DATESTR({QAA Date}) = "${dayKey}",
      IS_SAME({CEL Date}, "${dayKey}T00:00:00.000Z", 'day'),
      IS_SAME({ACC Date}, "${dayKey}T00:00:00.000Z", 'day')
    )
  )`;
  // 'Job #' is here only so the hard-overlap message can name the colliding
  // homesite. Without it f['Job #'] is undefined and the message read
  // "Job #unknown", which told the person nothing about what to go fix.
  const fieldsParam = ['Job #',
    'QAI Manager', 'QAI Date', 'QAA Manager', 'QAA Date',
    'CEL Manager', 'CEL Date', 'ACC Manager', 'ACC Date']
    .map((f) => `fields%5B%5D=${encodeURIComponent(f)}`).join('&');
  const url = `${AIRTABLE_API}/${BASE_ID}/${JOBS_TABLE}` +
    `?filterByFormula=${encodeURIComponent(formula)}&${fieldsParam}&pageSize=100`;

  const records = [];
  let offset;
  do {
    const res = await fetch(offset ? `${url}&offset=${offset}` : url, {
      headers: { Authorization: `Bearer ${pat}` }
    });
    if (!res.ok) {
      const e = new Error(`Conflict check could not query Airtable (status ${res.status}).`);
      e.statusCode = 502;
      throw e;
    }
    const json = await res.json();
    records.push(...(json.records || []));
    offset = json.offset;
  } while (offset);

  return records;
}

/**
 * currentFields: this record's existing values (fetched fresh, pre-write).
 * clean: the coerced values this request is about to write.
 * Returns { conflict: false } or { conflict: true, message }.
 */
async function checkSchedulingConflict(pat, recordId, currentFields, clean) {
  const changedTypes = Object.keys(WALK_TYPES).filter(
    (t) => Object.prototype.hasOwnProperty.call(clean, WALK_TYPES[t].managerField)
  );
  if (changedTypes.length === 0) return { conflict: false };

  for (const type of changedTypes) {
    const { managerField, dateField, isDatetime } = WALK_TYPES[type];
    const managerLinks = clean[managerField];
    if (!Array.isArray(managerLinks) || managerLinks.length === 0) continue; // clearing a walk is never a conflict
    const managerId = managerLinks[0];

    // The date for this walk: use the value being written if present, else
    // whatever is already on the record. If neither exists there is nothing
    // to schedule against yet.
    const dateValue = Object.prototype.hasOwnProperty.call(clean, dateField)
      ? clean[dateField]
      : (currentFields[dateField] || null);
    const dayKey = dayKeyOf(dateValue, isDatetime);
    if (!dayKey) continue;

    const dayRecords = await fetchJobsOnDay(pat, dayKey, recordId);

    let loadMinutes = WALK_DURATION_MIN[type]; // this walk's own minutes
    let hardOverlap = null;

    for (const rec of dayRecords) {
      const f = rec.fields || {};
      for (const otherType of Object.keys(WALK_TYPES)) {
        const otherDef = WALK_TYPES[otherType];
        const links = f[otherDef.managerField];
        if (!Array.isArray(links) || links.indexOf(managerId) < 0) continue;

        /* This walk has to be on the day we are summing.
         *
         * fetchJobsOnDay() returns a record if ANY of its four walks falls on
         * dayKey -- that is the correct query, because we cannot filter per
         * walk type in one formula. But a returned record's OTHER walks are
         * usually on completely different days. Without this guard every walk
         * that manager holds on that record counted toward this one day: a job
         * whose QAI is today and whose CEL is six weeks out charged the CEL's
         * 120 minutes to today. Summed across a manager's whole book that
         * reached 1740 minutes for a single day and made the 480 cap
         * unsatisfiable, so the save was refused and nothing could be
         * scheduled. */
        if (dayKeyOf(f[otherDef.dateField], otherDef.isDatetime) !== dayKey) continue;

        loadMinutes += WALK_DURATION_MIN[otherType];

        // Hard overlap: same manager, same exact clock time, on a
        // datetime-bearing walk type (CEL/ACC only -- QAI/QAA carry no
        // clock time on the Jobs record, so they can only ever collide via
        // the cap check below, not a literal time clash).
        if (isDatetime && otherDef.isDatetime && f[otherDef.dateField] === dateValue) {
          hardOverlap = { jobNumber: f['Job #'], walkType: otherType };
        }
      }
    }

    if (hardOverlap) {
      return {
        conflict: true,
        message:
          `This manager is already scheduled for a ${hardOverlap.walkType} walk at the exact same ` +
          `time (Job #${hardOverlap.jobNumber || 'unknown'}). Reassign one of the two before saving.`
      };
    }

    if (loadMinutes > DAILY_CAP_MIN) {
      return {
        conflict: true,
        message:
          `This assignment would put the manager at ${loadMinutes} minutes for ${dayKey}, ` +
          `over the ${DAILY_CAP_MIN}-minute daily cap.`
      };
    }
  }

  return { conflict: false };
}

/**
 * Allowed choices for every singleSelect field, keyed by field name.
 * These must match the option names in Airtable EXACTLY -- `typecast` is not
 * used, so Airtable will not create a missing option, and an unlisted value
 * would come back as a 422. Validating here turns that into a clean 400.
 * If an option is renamed in Airtable, change it here in the same commit.
 */
/* Why a missed walk needs a reason list here at all: typecast is off, so
   Airtable will not invent an option. A select on the whitelist whose value is
   not already a choice in the base fails as a 422 that reads like a permissions
   problem, which is a bad half hour. These four lists mirror REASONS in the QA
   Management page and the singleSelect choices on the Jobs table. All three
   have to agree; changing one means changing all three in the same commit. */
const MISS_REASONS = Object.freeze([
  'Home not ready',
  'Buyer no-show',
  'Manager unavailable',
  'Other'
]);

const SELECT_OPTIONS = Object.freeze({
  'Key Status': Object.freeze([
    'Pending',
    'Priority',
    'Received',
    'Delivered to title',
    'Delivered to WHC',
    'Other',
    'Issue'
  ]),
  'QAI Miss Reason': MISS_REASONS,
  'QAA Miss Reason': MISS_REASONS,
  'CEL Miss Reason': MISS_REASONS,
  'ACC Miss Reason': MISS_REASONS
});

/**
 * THE WHITELIST. Exactly 45 entries. Anything else is rejected.
 * Keys are the literal Airtable field names; values are the expected type.
 *   checkbox -> boolean
 *   date     -> 'YYYY-MM-DD'
 *   datetime -> ISO 8601 parseable
 *   link     -> array of Airtable record ids
 *   select   -> string, must be one of SELECT_OPTIONS[field]
 *   line     -> single-line string, trimmed, < 500 chars, no newlines
 *   text     -> string, < 10000 chars
 */
const EDITABLE = Object.freeze({
  'QA Ready': 'checkbox',
  'QAI Date': 'date',
  'QAI Manager': 'link',
  'QAI Complete': 'checkbox',
  'QAI Missed': 'checkbox',
  'QAI Miss Reason': 'select',
  'QAI Miss Note': 'text',
  'QAA Date': 'date',
  'QAA Manager': 'link',
  'QAA Accepted': 'checkbox',
  'QAA Missed': 'checkbox',
  'QAA Miss Reason': 'select',
  'QAA Miss Note': 'text',
  'CEL Date': 'datetime',
  'CEL Manager': 'link',
  'CEL Completed': 'checkbox',
  'Buyer Attended CEL': 'checkbox',
  'CEL Missed': 'checkbox',
  'CEL Miss Reason': 'select',
  'CEL Miss Note': 'text',
  'ACC Date': 'datetime',
  'ACC Manager': 'link',
  'ACC Completed': 'checkbox',
  'Buyer Attended ACC': 'checkbox',
  'ACC Missed': 'checkbox',
  'ACC Miss Reason': 'select',
  'ACC Miss Note': 'text',
  'QAI Walk Miss Reconciled': 'checkbox',
  'QAA Walk Miss Reconciled': 'checkbox',
  'CEL Walk Miss Reconciled': 'checkbox',
  'ACC Walk Miss Reconciled': 'checkbox',
  'CEL Reschedule Flag': 'checkbox',
  'ACC Reschedule Flag': 'checkbox',
  'NOC Lock Date': 'date',
  'Power Meter': 'checkbox',
  'Water Meter': 'checkbox',
  'Construction Risk': 'checkbox',
  'Construction Risk Notes': 'text',
  'Land Risk': 'checkbox',
  'Land Risk Notes': 'text',
  'Key Status': 'select',
  'Delivered To': 'line',
  'Delivery Date': 'date',
  'Notes': 'text',
  'CEL Letter Sent': 'checkbox'
});

const EDITABLE_KEYS = Object.keys(EDITABLE);

/**
 * Fields that need more than tracker.edit. Reassigning a walk is the one write
 * that moves work onto another person's day, which is what walk.schedule means;
 * everything else on the whitelist is a fact about the homesite.
 */
const WRITE_PERM = Object.freeze({
  'QAI Manager': 'walk.schedule',
  'QAA Manager': 'walk.schedule',
  'CEL Manager': 'walk.schedule',
  'ACC Manager': 'walk.schedule'
});

/**
 * The exact subset walk.complete alone is allowed to touch -- everything
 * public/my-walks.html writes, and nothing else. A caller with walk.complete
 * but not tracker.edit is rejected outright if the request names any field
 * outside this set, even if that field is otherwise a legal EDITABLE key.
 */
const COMPLETION_ONLY_FIELDS = new Set([
  'QAI Complete', 'QAI Missed', 'QAI Miss Reason', 'QAI Miss Note',
  'QAA Accepted', 'QAA Missed', 'QAA Miss Reason', 'QAA Miss Note',
  'CEL Completed', 'Buyer Attended CEL', 'CEL Missed', 'CEL Miss Reason', 'CEL Miss Note',
  'ACC Completed', 'Buyer Attended ACC', 'ACC Missed', 'ACC Miss Reason', 'ACC Miss Note'
]);

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

/** Validate & normalise one whitelisted value. Returns {ok, value} or {ok:false, message}. */
function coerce(field, raw) {
  const kind = EDITABLE[field];

  // An explicit clear is always allowed: null / '' / [] empty out the cell.
  const isEmpty =
    raw === null ||
    raw === undefined ||
    raw === '' ||
    (Array.isArray(raw) && raw.length === 0);

  if (kind === 'checkbox') {
    if (typeof raw !== 'boolean') {
      return { ok: false, message: `"${field}" is a checkbox and must be true or false (got ${typeof raw}).` };
    }
    return { ok: true, value: raw };
  }

  if (kind === 'date') {
    if (isEmpty) return { ok: true, value: null };
    if (typeof raw !== 'string' || !DATE_RE.test(raw.trim())) {
      return { ok: false, message: `"${field}" must be a date formatted YYYY-MM-DD.` };
    }
    const d = new Date(`${raw.trim()}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, message: `"${field}" is not a real calendar date.` };
    }
    return { ok: true, value: raw.trim() };
  }

  if (kind === 'datetime') {
    if (isEmpty) return { ok: true, value: null };
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${field}" must be an ISO 8601 date-time string.` };
    }
    // Accept 'YYYY-MM-DDTHH:mm' from <input type="datetime-local"> and full ISO.
    const s = raw.trim();
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, message: `"${field}" is not a parseable ISO 8601 date-time (got "${s.slice(0, 40)}").` };
    }
    return { ok: true, value: d.toISOString() };
  }

  if (kind === 'link') {
    if (isEmpty) return { ok: true, value: [] };
    if (!Array.isArray(raw)) {
      return { ok: false, message: `"${field}" must be an array of Airtable record ids.` };
    }
    if (raw.length > MAX_LINKS) {
      return { ok: false, message: `"${field}" accepts at most ${MAX_LINKS} linked records.` };
    }
    const bad = raw.filter((v) => typeof v !== 'string' || !RECORD_ID_RE.test(v));
    if (bad.length) {
      return {
        ok: false,
        message: `"${field}" contains value(s) that are not Airtable record ids: ${bad
          .map((v) => JSON.stringify(String(v).slice(0, 30)))
          .join(', ')}.`
      };
    }
    return { ok: true, value: raw };
  }

  if (kind === 'select') {
    if (isEmpty) return { ok: true, value: null };
    const allowed = SELECT_OPTIONS[field];
    if (!allowed) {
      return { ok: false, message: `"${field}" has no option list configured; refusing to write.` };
    }
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${field}" must be one of its option names as a string.` };
    }
    // Exact match only. No trimming into a match, no case-folding -- if it does
    // not equal an option name, it is not a valid choice.
    if (!allowed.includes(raw)) {
      return {
        ok: false,
        message:
          `"${field}" must be exactly one of: ${allowed.join(', ')} ` +
          `(got ${JSON.stringify(String(raw).slice(0, 40))}).`
      };
    }
    return { ok: true, value: raw };
  }

  if (kind === 'line') {
    if (isEmpty) return { ok: true, value: '' };
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${field}" must be a string.` };
    }
    const s = raw.trim();
    if (!s) return { ok: true, value: '' };
    if (/[\r\n]/.test(s)) {
      return { ok: false, message: `"${field}" is a single-line field and cannot contain line breaks.` };
    }
    if (s.length > MAX_LINE_LEN) {
      return { ok: false, message: `"${field}" must be ${MAX_LINE_LEN} characters or fewer (got ${s.length}).` };
    }
    return { ok: true, value: s };
  }

  if (kind === 'text') {
    if (isEmpty) return { ok: true, value: '' };
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${field}" must be a string.` };
    }
    if (raw.length >= MAX_NOTE_LEN) {
      return { ok: false, message: `"${field}" must be under ${MAX_NOTE_LEN} characters (got ${raw.length}).` };
    }
    return { ok: true, value: raw };
  }

  return { ok: false, message: `"${field}" has no validator configured; refusing to write.` };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...JSON_HEADERS, Allow: 'POST' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Method not allowed. This endpoint accepts POST only.' });
  }

  // Layer 0. Resolved before the body is even read, so an unauthenticated caller
  // cannot use this endpoint's validation messages to probe the field whitelist.
  // Only session validity is checked here now -- tracker.edit vs. walk.complete
  // is a per-field-set decision that has to wait until `submitted` is known
  // (see THE GATE below), since walk.complete alone is only good for
  // COMPLETION_ONLY_FIELDS, never for the whole EDITABLE whitelist.
  let session;
  try {
    session = await A.requireSession(event);
  } catch (err) {
    return A.fail(err);
  }

  const pat = process.env.AIRTABLE_PAT;
  if (!pat || !String(pat).trim()) {
    return reply(500, {
      error:
        'Server is not configured: the AIRTABLE_PAT environment variable is unset. ' +
        'Set it under Environment variables for this site ' +
        '(scopes: data.records:read, data.records:write).'
    });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { error: 'Request body too large.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (_) {
    return reply(400, { error: 'Request body must be valid JSON.' });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reply(400, { error: 'Request body must be a JSON object: { recordId, fields }.' });
  }

  // Reject batch-style payloads outright -- one record per request, always.
  if ('records' in parsed) {
    return reply(400, {
      error: 'Batch updates are not supported. Send one { recordId, fields } object per request.'
    });
  }

  const { recordId, fields } = parsed;

  if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) {
    return reply(400, {
      error: 'recordId must be a single Airtable record id matching ^rec[A-Za-z0-9]{14}$.'
    });
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return reply(400, { error: 'fields must be a JSON object of field name -> value.' });
  }

  const submitted = Object.keys(fields);
  if (submitted.length === 0) {
    return reply(400, { error: 'fields is empty; nothing to update.' });
  }
  if (submitted.length > EDITABLE_KEYS.length) {
    return reply(400, { error: 'Too many fields in one request.' });
  }

  // ---- THE GATE -------------------------------------------------------------
  // Own-property check only, so inherited names ('toString', '__proto__',
  // 'constructor') can never sneak past the allow-list.
  const rejected = submitted.filter(
    (key) => !Object.prototype.hasOwnProperty.call(EDITABLE, key)
  );
  if (rejected.length) {
    return reply(400, {
      error:
        'Rejected: field(s) not permitted for editing. These columns are owned by the ' +
        'Salesforce sync and are read-only in this app.',
      rejectedFields: rejected,
      allowedFields: EDITABLE_KEYS
    });
  }

  // Base capability. Full tracker.edit clears this unconditionally. Without
  // it, walk.complete is the only other door in, and only for
  // COMPLETION_ONLY_FIELDS -- a My Walks QAM marking a walk complete never
  // needs, and never gets, the capability that opens the tracker itself.
  if (session.can.indexOf('tracker.edit') < 0) {
    if (session.can.indexOf('walk.complete') < 0) {
      return A.fail(Object.assign(new Error(A.DENY['tracker.edit']), { statusCode: 403 }));
    }
    const outOfScope = submitted.filter((key) => !COMPLETION_ONLY_FIELDS.has(key));
    if (outOfScope.length) {
      return reply(403, {
        error: A.DENY['walk.complete'],
        deniedFields: outOfScope
      });
    }
  }

  // Per-field capability check, after the allow-list so an unknown field is
  // still reported as unknown rather than as a permission problem.
  const needs = submitted
    .map((key) => WRITE_PERM[key])
    .filter((perm, i, all) => perm && all.indexOf(perm) === i);
  for (const perm of needs) {
    if (session.can.indexOf(perm) < 0) {
      return reply(403, {
        error: A.DENY[perm] || 'You do not have access to that.',
        deniedFields: submitted.filter((key) => WRITE_PERM[key] === perm)
      });
    }
  }
  // ---------------------------------------------------------------------------

  const clean = {};
  for (const key of submitted) {
    const result = coerce(key, fields[key]);
    if (!result.ok) {
      return reply(400, { error: result.message, invalidField: key });
    }
    clean[key] = result.value;
  }

  // Scheduling-conflict guard. Only runs when a *Manager field is being
  // written, and needs the record's current state to know the walk's date
  // when only the manager (not the date) is changing.
  const touchesManagerField = Object.keys(WALK_TYPES).some((t) =>
    Object.prototype.hasOwnProperty.call(clean, WALK_TYPES[t].managerField)
  );
  if (touchesManagerField) {
    let currentFields = {};
    try {
      const getUrl = `${AIRTABLE_API}/${BASE_ID}/${JOBS_TABLE}/${encodeURIComponent(recordId)}`;
      const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${pat}` } });
      if (getRes.ok) {
        const getJson = await getRes.json();
        currentFields = getJson.fields || {};
      }
      // If the GET fails, fall through with currentFields = {} rather than
      // blocking the save entirely on a transient read error -- the write
      // itself still goes through Airtable's own validation.
    } catch (_) { /* same rationale as above */ }

    try {
      const conflict = await checkSchedulingConflict(pat, recordId, currentFields, clean);
      if (conflict.conflict) {
        return reply(409, { error: conflict.message });
      }
    } catch (err) {
      return reply(err.statusCode || 502, {
        error: err.message || 'Could not verify this assignment does not conflict with another walk.'
      });
    }
  }

  // PATCH a single record by id. Airtable's single-record PATCH endpoint cannot
  // create or delete, and typecast is deliberately omitted so Airtable will not
  // silently coerce or auto-create linked records.
  const url = `${AIRTABLE_API}/${BASE_ID}/${JOBS_TABLE}/${encodeURIComponent(recordId)}`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: clean })
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      /* keep json null */
    }

    if (!res.ok) {
      const atError = (json && json.error) || {};
      const detail =
        (typeof atError === 'string' ? atError : atError.message || atError.type) || '';
      let friendly;
      if (res.status === 401 || res.status === 403) {
        friendly =
          'Airtable rejected the credentials. Check that AIRTABLE_PAT is valid and has ' +
          'data.records:write on this base.';
      } else if (res.status === 404) {
        friendly = `Job record ${recordId} was not found in Airtable.`;
      } else if (res.status === 422) {
        friendly = `Airtable rejected the value${detail ? `: ${detail}` : '.'}`;
      } else if (res.status === 429) {
        friendly = 'Airtable rate limit hit. Wait a moment and try again.';
      } else {
        friendly = `Airtable error ${res.status}${detail ? `: ${detail}` : '.'}`;
      }
      return reply(res.status === 429 ? 429 : 502, { error: friendly });
    }

    return reply(200, {
      ok: true,
      id: (json && json.id) || recordId,
      fields: (json && json.fields) || {},
      updated: Object.keys(clean)
    });
  } catch (err) {
    // Never surface a stack trace to the browser.
    return reply(502, {
      error:
        'Could not reach Airtable to save this change. The edit was not applied. ' +
        'Please retry.'
    });
  }
};
