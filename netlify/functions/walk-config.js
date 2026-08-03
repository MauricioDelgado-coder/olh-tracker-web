/**
 * GET /api/walk-config
 *
 * Reference data for the scheduler, workload and walk-calendar pages. These
 * three read four globals that /api/jobs does not supply -- WALK_ROSTER,
 * WALK_DRIVE, WALK_PRODUCT_MAP and WALK_COMMUNITIES. Until this endpoint
 * existed they came from a snapshot baked into each bundle, which meant a
 * drive-time change required rebuilding and redeploying three 1 MB pages.
 *
 * Returns:
 *   { roster:      [{ id, name, role, home, homeKnown }],
 *     drive:       { [from]: { [to]: minutes } },
 *     productMap:  { [communityValue]: baseCommunity },
 *     communities: [ ...base community names, sorted ],
 *     unscheduled: [{ product, baseCommunity, homesites }],
 *     meta:        { rosterCount, pairCount, productCount, communityCount,
 *                    unscheduledHomesites, fetchedAt, cached } }
 *
 * `unscheduled` is deliberately part of the contract rather than an error: 9
 * communities (29 homesites) have no drive times yet, and the pages render that
 * list on screen so the gap is visible instead of homesites silently vanishing.
 *
 * Requires a valid session with suite.view. The roster is 35 named employees
 * with their home communities, so this is staff data even though it carries no
 * homesite records.
 *
 * The Airtable PAT is read ONLY from process.env.AIRTABLE_PAT. It is never
 * returned to the client and never logged. GET only -- there is no write path.
 */

'use strict';

const A = require('../lib/olh-auth');

const BASE_ID = 'appYX9df4lGO6G2uz';
const ROSTER_TABLE = 'tblhDm8OD4jSR0tey';
const DRIVE_TABLE = 'tblVnYFUc4xuovVEC';
const PRODUCT_TABLE = 'tblvkWF5QULxhqFiX';
const AIRTABLE_API = 'https://api.airtable.com/v0';

// Reference data changes far less often than jobs do, so this cache is longer
// than the 30s on /api/jobs. A drive-time edit shows up within 5 minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_DELAY_MS = 220;
const MAX_PAGES = 40;

const NEEDS_DRIVE_TIMES = 'NEW — needs drive times';
const EXCLUDED = 'Removed / Excluded';

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

const selectName = (v) => (v && typeof v === 'object' && v.name ? v.name : v);

/** Page through a table via Airtable's `offset` cursor. Mirrors jobs.js. */
async function fetchAllRecords(tableId, pat) {
  const records = [];
  let offset = null;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ pageSize: '100' });
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
      err.statusCode = 502;
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

  // Fails closed before any Airtable read.
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
        'Set it under Environment variables for this site (Azure: Settings → ' +
        'Environment variables; Netlify: Site configuration → Environment ' +
        'variables, then redeploy).'
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
    const driveRecords = await fetchAllRecords(DRIVE_TABLE, pat);
    await sleep(PAGE_DELAY_MS);
    const rosterRecords = await fetchAllRecords(ROSTER_TABLE, pat);
    await sleep(PAGE_DELAY_MS);
    const productRecords = await fetchAllRecords(PRODUCT_TABLE, pat);

    // --- drive matrix: long form -> WALK_DRIVE[from][to] --------------------
    const drive = {};
    let pairCount = 0;
    for (const r of driveRecords) {
      const f = r.fields || {};
      const from = f['From Community'];
      const to = f['To Community'];
      const min = f['Drive Minutes'];
      if (!from || !to || typeof min !== 'number') continue;
      if (!drive[from]) drive[from] = {};
      drive[from][to] = min;
      pairCount += 1;
    }
    const communities = Object.keys(drive).sort((a, b) => a.localeCompare(b));

    // --- roster ------------------------------------------------------------
    // homeKnown lets the pages avoid silently seating someone at a community
    // the matrix has never heard of. 16 of 35 are in that state today.
    const roster = rosterRecords
      .filter((r) => r.fields && r.fields.Active !== false)
      .map((r) => {
        const f = r.fields || {};
        const home = f['Home Community'] || '';
        return {
          id: f['Person Id'] || r.id,
          name: f.Name || '(unnamed)',
          role: selectName(f.Role) || '',
          home,
          homeKnown: !!home && Object.prototype.hasOwnProperty.call(drive, home)
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // --- product map -------------------------------------------------------
    const productMap = {};
    const unscheduled = [];
    for (const r of productRecords) {
      const f = r.fields || {};
      const product = f['Product / Community Value'];
      const base = f['Base Community'];
      const status = selectName(f.Status) || '';
      if (!product || status === EXCLUDED) continue;

      // A community with no drive times cannot be sequenced. Surface it by name
      // instead of mapping it and letting the page place it at distance zero.
      if (status === NEEDS_DRIVE_TIMES || (base && !drive[base])) {
        unscheduled.push({
          product,
          baseCommunity: base || '',
          homesites: typeof f['Live Homesites'] === 'number' ? f['Live Homesites'] : 0
        });
        continue;
      }
      if (base) productMap[product] = base;
    }
    unscheduled.sort((a, b) => b.homesites - a.homesites || a.product.localeCompare(b.product));

    const payload = {
      roster,
      drive,
      productMap,
      communities,
      unscheduled,
      meta: {
        rosterCount: roster.length,
        rosterHomeUnknown: roster.filter((p) => !p.homeKnown).length,
        pairCount,
        productCount: Object.keys(productMap).length,
        communityCount: communities.length,
        unscheduledCount: unscheduled.length,
        unscheduledHomesites: unscheduled.reduce((a, u) => a + u.homesites, 0),
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
