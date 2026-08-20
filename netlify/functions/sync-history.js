/**
 * Read-only view onto the Sync History table -- one row per OLH Airtable sync
 * run (launchd job), written by dev/sync_coe_to_airtable.py.
 *
 *   GET /api/sync-history[?division=OLH][&limit=200] -> {entries:[…]}
 *
 * Nothing here writes: the sync script is the only thing that appends rows,
 * same append-only contract as Audit Log and Walk Miss Log. This function
 * exists purely so the frontend never needs a raw Airtable PAT of its own.
 */

'use strict';

const A = require('../lib/olh-auth');

function entryOf(rec) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    started: f.Started || '',
    finished: f.Finished || '',
    durationSec: typeof f['Duration (sec)'] === 'number' ? f['Duration (sec)'] : null,
    status: (f.Status && f.Status.name) || f.Status || '',
    exitCode: typeof f['Exit Code'] === 'number' ? f['Exit Code'] : null,
    reason: f.Reason || '',
    rowsRaw: typeof f['Rows Raw'] === 'number' ? f['Rows Raw'] : null,
    rowsFinal: typeof f['Rows Final'] === 'number' ? f['Rows Final'] : null,
    airtableTotalRows: typeof f['Airtable Total Rows'] === 'number' ? f['Airtable Total Rows'] : null,
    airtableActiveRows: typeof f['Airtable Active Rows'] === 'number' ? f['Airtable Active Rows'] : null,
    division: f.Division || ''
  };
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.synchistory');

  const q = event.queryStringParameters || {};
  const division = String(q.division || '').trim();
  const limit = Math.max(1, Math.min(500, parseInt(q.limit, 10) || 200));

  const params = {
    'sort[0][field]': 'Started',
    'sort[0][direction]': 'desc',
    maxRecords: String(limit)
  };
  if (division) params.filterByFormula = '{Division} = "' + A.esc(division) + '"';

  const recs = await A.listRecords(A.TABLES.syncHistory, params);
  return A.reply(200, { entries: recs.map(entryOf) });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET') return await list(event);
    return A.reply(405, { error: 'GET only.' });
  } catch (err) {
    return A.fail(err);
  }
};
