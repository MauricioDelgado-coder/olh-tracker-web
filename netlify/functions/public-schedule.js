/**
 * GET /api/public-schedule
 *   -> { published: null }
 *   or { published: {
 *          date, publishedAt,
 *          managers: [{ manager, walks: [...] }],
 *          communities: [{ community, walks: [...] }]
 *        } }
 *
 * The one endpoint in this app that takes NO session. It reads ONLY the
 * Published Schedules table -- never Jobs -- and only ever returns what
 * publish-schedule.js explicitly stored there (job #, community, walk type,
 * time, manager; no address, no record ids). That is what makes exposing it
 * without a login safe: the boundary is which table this function can see,
 * not a permission check that could be misconfigured.
 *
 * Fetches every Locked=1 record (there are only ever a handful) and picks
 * the soonest Date that is today or later, comparing as plain YYYY-MM-DD
 * strings -- which sort chronologically without needing Airtable's Date
 * type or any formula-side date math. Returns the SAME snapshot grouped two
 * ways -- by manager and by community -- so the page can offer a sort toggle
 * without a second round trip; an unassigned walk always sorts last within
 * whichever grouping.
 */

'use strict';

const BASE_ID = 'appypFnJwp8DpNuBv';
const TABLE = 'Published Schedules';
const AIRTABLE_API = 'https://api.airtable.com/v0';

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

async function airtable(pathSuffix) {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat || !String(pat).trim()) {
    const e = new Error('Server is not configured: the AIRTABLE_PAT environment variable is unset.');
    e.statusCode = 500;
    throw e;
  }
  const res = await fetch(`${AIRTABLE_API}/${BASE_ID}${pathSuffix}`, {
    headers: { Authorization: `Bearer ${pat}` }
  });
  if (!res.ok) {
    const e = new Error(`Airtable returned ${res.status} for GET ${pathSuffix}`);
    e.statusCode = 502;
    throw e;
  }
  return res.json();
}

async function listLocked() {
  const records = [];
  let offset = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '100', filterByFormula: '{Locked} = 1' });
    if (offset) qs.set('offset', offset);
    const json = await airtable(`/${encodeURIComponent(TABLE)}?${qs.toString()}`);
    if (json && Array.isArray(json.records)) records.push(...json.records);
    offset = (json && json.offset) || null;
    pages += 1;
    if (offset && pages < 10) await new Promise((r) => setTimeout(r, 220));
  } while (offset && pages < 10);
  return records;
}

const CODE_ORDER = { QAI: 0, QAA: 1, CEL: 2, ACC: 3 };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...JSON_HEADERS, Allow: 'GET' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed. This endpoint is GET only.' });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const locked = await listLocked();

    let best = null;
    for (const rec of locked) {
      const d = (rec.fields && rec.fields.Date) || '';
      if (!d || d < today) continue;
      if (!best || d < ((best.fields && best.fields.Date) || '')) best = rec;
    }

    if (!best) return reply(200, { published: null });

    const f = best.fields || {};
    let rows = [];
    try { rows = JSON.parse(f.Snapshot || '[]'); } catch (_) { rows = []; }
    if (!Array.isArray(rows)) rows = [];

    const byManager = new Map();
    const byCommunity = new Map();
    rows.forEach((r) => {
      const mgr = (r && r.manager) || 'Unassigned';
      if (!byManager.has(mgr)) byManager.set(mgr, []);
      byManager.get(mgr).push(r);

      const comm = (r && r.community) || 'Unassigned';
      if (!byCommunity.has(comm)) byCommunity.set(comm, []);
      byCommunity.get(comm).push(r);
    });

    const walkSort = (a, b) =>
      (CODE_ORDER[a.code] || 9) - (CODE_ORDER[b.code] || 9) ||
      String(a.when).localeCompare(String(b.when)) ||
      String(a.community).localeCompare(String(b.community));

    const managers = Array.from(byManager.entries())
      .sort((a, b) => {
        if (a[0] === 'Unassigned') return 1;
        if (b[0] === 'Unassigned') return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([manager, walks]) => ({
        manager,
        walks: walks.slice().sort(walkSort)
      }));

    const communities = Array.from(byCommunity.entries())
      .sort((a, b) => {
        if (a[0] === 'Unassigned') return 1;
        if (b[0] === 'Unassigned') return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([community, walks]) => ({
        community,
        walks: walks.slice().sort((a, b) =>
          (CODE_ORDER[a.code] || 9) - (CODE_ORDER[b.code] || 9) ||
          String(a.when).localeCompare(String(b.when)) ||
          String(a.manager || 'Unassigned').localeCompare(String(b.manager || 'Unassigned'))
        )
      }));

    return reply(200, {
      published: { date: f.Date || '', publishedAt: f['Published At'] || '', managers, communities }
    });
  } catch (err) {
    const status = (err && err.statusCode) || 500;
    return reply(status, { error: (err && err.message) || 'Unexpected error.' });
  }
};
