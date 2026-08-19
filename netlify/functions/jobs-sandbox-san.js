/**
 * GET /api/jobs-sandbox-san
 *
 * SANDBOX VARIANT of jobs.js -- reads ONLY from Jobs (Sandbox - SAN) /
 * tbltB2CIKBumT6sMK and Managers (Sandbox - SAN) / tbl5001ngiOsxp49i. Not the
 * live OLH Jobs/Managers tables, not read by any live page. Built to power
 * tracker-san-mpr.html without touching the production tracker.
 *
 * Returns every job record in the SAN sandbox plus the sandbox Managers lookup:
 *   { jobs: [{ id, fields }], managers: [{ id, name, email, role, active }],
 *     meta }
 *
 * Same session requirement as the live endpoint (suite.view) -- this is not a
 * separate access boundary, just a separate dataset.
 *
 * The Airtable Personal Access Token is read ONLY from process.env.AIRTABLE_PAT.
 * It is never returned to the client and never logged.
 */

'use strict';

const A = require('../lib/olh-auth');

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tbltB2CIKBumT6sMK';       // Jobs (Sandbox - SAN)
const MANAGERS_TABLE = 'tbl5001ngiOsxp49i';   // Managers (Sandbox - SAN)
const AIRTABLE_API = 'https://api.airtable.com/v0';

// 30s in-memory cache. Netlify may reuse a warm container across invocations,
// so several leaders loading at once will usually share one Airtable fetch.
const CACHE_TTL_MS = 30 * 1000;

// Airtable allows 5 requests/second/base. 220ms between pages keeps us at
// ~4.5 req/s worst case, comfortably under the limit.
const PAGE_DELAY_MS = 220;

// Hard stop so a malformed offset loop can never run away.
const MAX_PAGES = 60;

let cache = { at: 0, payload: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Page through a whole table via Airtable's `offset` cursor.
 * Throws with a readable message (never a raw stack) on a non-2xx response.
 */
async function fetchAllRecords(tableId, pat, extraParams) {
  const records = [];
  let offset = null;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) qs.append(k, v);
    }
    if (offset) qs.set('offset', offset);

    const res = await fetch(`${AIRTABLE_API}/${BASE_ID}/${tableId}?${qs.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat}` }
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body && body.error && (body.error.message || body.error.type)) || '';
      } catch (_) {
        /* non-JSON error body */
      }
      const err = new Error(
        `Airtable returned ${res.status} while reading table ${tableId}` +
          (detail ? `: ${detail}` : '')
      );
      err.statusCode = res.status === 401 || res.status === 403 ? 502 : 502;
      err.airtableStatus = res.status;
      throw err;
    }

    const json = await res.json();
    if (Array.isArray(json.records)) records.push(...json.records);
    offset = json.offset || null;
    pages += 1;

    if (offset && pages < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (offset && pages < MAX_PAGES);

  return records;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...JSON_HEADERS, Allow: 'GET' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed. This endpoint is GET only.' });
  }

  // Fails closed: any missing, expired, revoked or under-privileged session is
  // rejected before a single Airtable read happens.
  try {
    await A.requireSession(event);
  } catch (err) {
    return A.fail(err);
  }

  const pat = process.env.AIRTABLE_PAT;
  if (!pat || !String(pat).trim()) {
    return reply(500, {
      error:
        'Server is not configured: the AIRTABLE_PAT environment variable is unset. ' +
        'Set it under Environment variables for this site ' +
        '(scopes: data.records:read, data.records:write), then redeploy.'
    });
  }

  const bust = event.queryStringParameters && event.queryStringParameters.refresh === '1';
  const now = Date.now();
  if (!bust && cache.payload && now - cache.at < CACHE_TTL_MS) {
    return reply(200, {
      ...cache.payload,
      meta: { ...cache.payload.meta, cached: true, cacheAgeMs: now - cache.at }
    });
  }

  try {
    // Managers first (1 page) so a bad table id fails fast and cheaply.
    const managerRecords = await fetchAllRecords(MANAGERS_TABLE, pat);
    await sleep(PAGE_DELAY_MS);
    const jobRecords = await fetchAllRecords(JOBS_TABLE, pat);

    const managers = managerRecords
      .map((r) => ({
        id: r.id,
        name: (r.fields && (r.fields.Name || r.fields.name)) || '(unnamed)',
        email: (r.fields && r.fields.Email) || '',
        role: (r.fields && r.fields.Role) || [],
        active: !!(r.fields && r.fields.Active)
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const jobs = jobRecords.map((r) => ({ id: r.id, fields: r.fields || {} }));

    /* How current the Salesforce side of this data actually is.
     *
     * The Completion Report prints this as its provenance line, so it has to
     * mean something: fetchedAt is when Airtable was read, which is always
     * "seconds ago" and says nothing about the data's age. `Last Synced` is
     * stamped by the daily sync only on rows it actually changed, so the newest
     * one across the table is the last time Salesforce moved anything -- that
     * is the honest answer to "data updated when?".
     *
     * Null when the column is empty everywhere rather than falling back to
     * today, which would claim a freshness nobody verified. */
    const synced = jobRecords
      .map((r) => (r.fields && r.fields['Last Synced']) || '')
      .filter(Boolean)
      .sort();
    const runDate = synced.length ? String(synced[synced.length - 1]).slice(0, 10) : null;

    const payload = {
      jobs,
      managers,
      meta: {
        count: jobs.length,
        managerCount: managers.length,
        runDate,
        division: 'SAN (San Antonio) -- SANDBOX',
        source: 'Airtable (Jobs), synced from Salesforce Homesite__c',
        fetchedAt: new Date().toISOString(),
        cached: false
      }
    };

    cache = { at: Date.now(), payload };
    return reply(200, payload);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    return reply(status, {
      error: (err && err.message) || 'Unexpected error while reading from Airtable.'
    });
  }
};
