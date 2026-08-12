/**
 * POST /api/resolve-conflict
 * Body: { recordId: "recXXXXXXXXXXXXXX", field: "<merge field>", action: "keep" | "accept" }
 *
 * Backs the Sync Conflicts page. The daily Salesforce->Airtable sync
 * (olh_qa_tracker_sync.py) protects a leader's manual edit on eight fields
 * (QAI/QAA/CEL/ACC Date and Manager) whenever Salesforce has ALSO moved that
 * field since the sync's own last-pushed value -- it never overwrites the
 * leader silently, it just appends a line to "Sync Conflicts" for a human to
 * decide.
 *
 * The one thing the sync script itself cannot do is clear that flag: it only
 * updates its memory ("Sync Baseline", a per-field JSON blob of the last value
 * it considered settled) when it WRITES a value, never when it records a
 * conflict. Left alone, a flagged line reappears on every subsequent run
 * forever, even after a human resolves it by hand in Airtable, because the
 * baseline never moves. This endpoint is the fix: resolving a field here
 * writes the field (if the human accepted Salesforce's value), then re-stamps
 * Sync Baseline for that field to match, and drops that field's line out of
 * Sync Conflicts -- so a resolved conflict actually stays resolved, and the
 * next sync run only re-flags it if Salesforce genuinely moves again.
 *
 * Permission: roster.manage (admin only), same gate as the console itself.
 * This endpoint never widens the update-job.js whitelist -- it only ever
 * touches the eight sync-owned merge fields plus the two sync bookkeeping
 * fields (Sync Baseline, Sync Conflicts), none of which update-job.js permits.
 */

'use strict';

const A = require('../lib/olh-auth');

const JOBS_TABLE = A.TABLES.jobs;
const MANAGERS_TABLE = A.TABLES.managers;

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const BASELINE_FIELD = 'Sync Baseline';
const CONFLICT_FIELD = 'Sync Conflicts';

/** The eight fields the daily sync merges, and how each is written. */
const MERGE_FIELDS = {
  'QAI Date': 'date',
  'QAA Date': 'date',
  'CEL Date': 'datetime',
  'ACC Date': 'datetime',
  'QAI Manager': 'link',
  'QAA Manager': 'link',
  'CEL Manager': 'link',
  'ACC Manager': 'link'
};

/* Mirrors MANAGER_NAME_ALIASES in olh_qa_tracker_sync.py exactly. Keep the two
 * in sync -- this is the one place a Salesforce spelling is translated to the
 * roster's spelling for a manager-field "accept". */
const MANAGER_NAME_ALIASES = {
  'jeffrey boyd': 'jeff boyd',
  'ray kollar': 'raymond kollar'
};

// One line per flagged field, written by the Python sync as:
//   "<Field>: kept <display> / Salesforce says <display>"
const LINE_RE = /^(.+?): kept (.*) \/ Salesforce says (.*)$/;

function parseConflictLines(note) {
  return String(note || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = LINE_RE.exec(line);
      return m ? { raw: line, field: m[1], kept: m[2], salesforce: m[3] } : { raw: line, field: null };
    });
}

function readBaseline(fields) {
  const raw = fields && fields[BASELINE_FIELD];
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

/** "Salesforce says" text -> a value ready to PATCH, per MERGE_FIELDS[field]. */
function parseSalesforceValue(field, kind, text, managerByName) {
  if (text === '(empty)') return kind === 'link' ? [] : null;

  if (kind === 'date' || kind === 'datetime') {
    const plain = /^\d{4}-\d{2}-\d{2}$/;
    if (plain.test(text)) {
      return kind === 'date' ? text : new Date(text + 'T00:00:00.000Z').toISOString();
    }
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) {
      const e = new Error(`Could not parse the Salesforce value for "${field}" ("${text}") as a date.`);
      e.statusCode = 409;
      throw e;
    }
    return d.toISOString();
  }

  // kind === 'link': one or more manager names, joined by ", " in the note.
  const names = text.split(',').map((s) => s.trim()).filter(Boolean);
  const ids = [];
  const unmatched = [];
  for (const name of names) {
    const key = MANAGER_NAME_ALIASES[name.toLowerCase()] || name.toLowerCase();
    const id = managerByName.get(key);
    if (id) ids.push(id);
    else unmatched.push(name);
  }
  if (unmatched.length) {
    const e = new Error(
      `Could not match Salesforce manager name(s) to the roster for "${field}": ${unmatched.join(', ')}. ` +
      'Add them under Users first, or resolve this row directly in Airtable.'
    );
    e.statusCode = 409;
    throw e;
  }
  return ids;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...A.JSON_HEADERS, Allow: 'POST' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return A.reply(405, { error: 'Method not allowed. This endpoint accepts POST only.' });
  }

  let session;
  try {
    session = await A.requireSession(event);
    A.requirePerm(session, 'roster.manage');
  } catch (err) {
    return A.fail(err);
  }

  let body;
  try {
    body = A.readJson(event);
  } catch (err) {
    return A.fail(err);
  }

  const { recordId, field, action } = body || {};

  if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) {
    return A.reply(400, { error: 'recordId must be a single Airtable record id matching ^rec[A-Za-z0-9]{14}$.' });
  }
  if (!Object.prototype.hasOwnProperty.call(MERGE_FIELDS, field)) {
    return A.reply(400, {
      error: `"${field}" is not a field this endpoint resolves.`,
      allowedFields: Object.keys(MERGE_FIELDS)
    });
  }
  if (action !== 'keep' && action !== 'accept') {
    return A.reply(400, { error: 'action must be "keep" or "accept".' });
  }

  const kind = MERGE_FIELDS[field];

  try {
    // Fresh read -- the browser's copy of Sync Conflicts may be up to 30s
    // stale (jobs.js caches), and acting on a stale note could resolve a line
    // that already changed or no longer exists.
    const record = await A.airtable('GET', `/${JOBS_TABLE}/${recordId}`);
    const fields = record.fields || {};

    const lines = parseConflictLines(fields[CONFLICT_FIELD]);
    const hit = lines.find((l) => l.field === field);
    if (!hit) {
      return A.reply(409, {
        error: `"${field}" is not currently flagged as a conflict on this record. ` +
          'It may have already been resolved, or Sync Conflicts changed since this page loaded. Refresh and try again.'
      });
    }

    let writeValue; // value to PATCH into `field` -- only for action === 'accept'
    if (action === 'accept') {
      let managerByName = null;
      if (kind === 'link') {
        const managers = await A.listRecords(MANAGERS_TABLE);
        managerByName = new Map();
        for (const m of managers) {
          const name = (m.fields && (m.fields.Name || m.fields.name)) || '';
          if (name) managerByName.set(String(name).trim().toLowerCase(), m.id);
        }
      }
      writeValue = parseSalesforceValue(field, kind, hit.salesforce, managerByName);
    }

    // What the record will hold for `field` once this write lands -- the new
    // reference point for "untouched since the sync last saw this."
    const settledValue = action === 'accept'
      ? writeValue
      : (fields[field] != null ? fields[field] : (kind === 'link' ? [] : null));

    const baseline = readBaseline(fields);
    baseline[field] = settledValue;

    const remaining = lines.filter((l) => l.field !== field).map((l) => l.raw);
    const newNote = remaining.length ? remaining.join('\n') : null;

    const patch = {
      [BASELINE_FIELD]: JSON.stringify(baseline),
      [CONFLICT_FIELD]: newNote
    };
    if (action === 'accept') patch[field] = writeValue;

    const updated = await A.updateRecord(JOBS_TABLE, recordId, patch);

    return A.reply(200, {
      ok: true,
      recordId,
      field,
      action,
      value: action === 'accept' ? writeValue : undefined,
      remainingConflicts: remaining.length,
      fields: updated.fields || {}
    });
  } catch (err) {
    return A.fail(err);
  }
};
