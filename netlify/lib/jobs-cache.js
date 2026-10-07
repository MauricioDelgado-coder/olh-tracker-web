'use strict';

/**
 * Shared, write-through cache for GET /api/jobs (added 2026-10).
 *
 * WHY THIS EXISTS
 * jobs.js kept its 30s cache in a module-local variable that nothing else
 * could reach. update-job.js wrote to Airtable and never told it, so for up
 * to 30s after any edit every /api/jobs read served the PRE-edit record.
 * dev/live-loader.js refetches /api/jobs on tab focus and replaces
 * window.OLH_DATA wholesale, so the symptom on the Completion Report was a
 * risk chip that saved, then flipped back to blank the moment the tab
 * regained focus -- and the tracker / homesite pages, opened right after,
 * showed the old value too. Reproduced in dev/test-jobs-cache-coherence.js.
 *
 * WHAT IT DOES
 *  - set(payload, startedAt): store a freshly read payload. Any write that
 *    landed AFTER that read began is re-applied on top first, because the
 *    read may have paged past the record before the PATCH reached Airtable.
 *  - applyWrite(id, fields): called by update-job.js once Airtable accepts a
 *    PATCH. Replaces that record's fields in the cached payload with the
 *    record Airtable returned (the full post-write record), and logs the
 *    write for set() above.
 *
 * Patching in place rather than dropping the cache keeps the reason the
 * cache exists: a full read is ~10+ Airtable pages, and invalidating on
 * every chip click would put one on nearly every focus refetch.
 *
 * SCOPE / LIMIT
 * Module state is per Node process. On Azure every route runs in the one
 * function-app process (api/src/index.js), so jobs and update-job share
 * this on a given instance. If the platform runs more than one instance, a
 * read served by a different instance than the write can still be up to
 * CACHE_TTL_MS stale -- that residual window is the TTL, not this module.
 * On Netlify each function is its own bundle, so this does not help there;
 * Netlify is not the production host.
 */

const CACHE_TTL_MS = 30 * 1000;
// Writes are kept slightly longer than any read could take to finish
// (60 pages x 220ms delay ~ 13s) plus the TTL, then pruned.
const WRITE_LOG_MS = CACHE_TTL_MS + 60 * 1000;

let cache = { at: 0, payload: null };
let writes = []; // { at, id, fields }

function prune(now) {
  writes = writes.filter((w) => now - w.at < WRITE_LOG_MS);
}

function patchPayload(payload, id, fields) {
  if (!payload || !Array.isArray(payload.jobs)) return;
  const job = payload.jobs.find((j) => j.id === id);
  if (job) job.fields = { ...fields };
}

function get(now) {
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return { payload: cache.payload, ageMs: now - cache.at };
  }
  return null;
}

function set(payload, startedAt) {
  const now = Date.now();
  prune(now);
  for (const w of writes) {
    if (w.at >= startedAt) patchPayload(payload, w.id, w.fields);
  }
  cache = { at: now, payload };
}

function applyWrite(id, fields) {
  if (!id || !fields || typeof fields !== 'object') return;
  const now = Date.now();
  prune(now);
  writes.push({ at: now, id, fields: { ...fields } });
  patchPayload(cache.payload, id, fields);
}

module.exports = { CACHE_TTL_MS, get, set, applyWrite };
