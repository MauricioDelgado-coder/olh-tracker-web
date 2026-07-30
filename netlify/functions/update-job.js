/**
 * POST /api/update-job
 * Body: { recordId: "recXXXXXXXXXXXXXX", fields: { "<whitelisted field>": value, ... } }
 *
 * Defense-in-depth, because the site is served from an unlisted URL with no login gate:
 *   1. POST only. One record per call. PATCH only -- no create, delete, batch or schema access.
 *   2. Strict allow-list: any field name not in EDITABLE below causes a 400 that names
 *      the offending keys. Salesforce-sourced fields, `Record Status`, `Closed Date`
 *      and `Last Synced` are owned by the daily sync and can never be written here.
 *   3. Per-type server-side validation (dates, datetimes, booleans, record-id arrays,
 *      single-select option names, single-line text, long text).
 *   4. noindex/nofollow headers on every response.
 */

'use strict';

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
 * Allowed choices for every singleSelect field, keyed by field name.
 * These must match the option names in Airtable EXACTLY -- `typecast` is not
 * used, so Airtable will not create a missing option, and an unlisted value
 * would come back as a 422. Validating here turns that into a clean 400.
 * If an option is renamed in Airtable, change it here in the same commit.
 */
const SELECT_OPTIONS = Object.freeze({
  'Key Status': Object.freeze([
    'Pending',
    'Priority',
    'Received',
    'Delivered to title',
    'Delivered to WHC',
    'Other',
    'Issue'
  ])
});

/**
 * THE WHITELIST. Exactly 26 entries. Anything else is rejected.
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
  'QAA Date': 'date',
  'QAA Manager': 'link',
  'QAA Accepted': 'checkbox',
  'CEL Date': 'datetime',
  'CEL Manager': 'link',
  'CEL Completed': 'checkbox',
  'Buyer Attended CEL': 'checkbox',
  'ACC Date': 'datetime',
  'ACC Manager': 'link',
  'ACC Completed': 'checkbox',
  'Buyer Attended ACC': 'checkbox',
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
  'Notes': 'text'
});

const EDITABLE_KEYS = Object.keys(EDITABLE);

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

  const pat = process.env.AIRTABLE_PAT;
  if (!pat || !String(pat).trim()) {
    return reply(500, {
      error:
        'Server is not configured: the AIRTABLE_PAT environment variable is unset. ' +
        'Set it in Netlify (scopes: data.records:read, data.records:write) and redeploy.'
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
  // ---------------------------------------------------------------------------

  const clean = {};
  for (const key of submitted) {
    const result = coerce(key, fields[key]);
    if (!result.ok) {
      return reply(400, { error: result.message, invalidField: key });
    }
    clean[key] = result.value;
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
