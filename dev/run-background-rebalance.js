#!/usr/bin/env node
/* ------------------------------------------------------------------------
 * BACKGROUND REBALANCE RUNNER
 *
 *   node dev/run-background-rebalance.js            (dry run -- logs only)
 *   node dev/run-background-rebalance.js --apply     (writes to Airtable)
 *
 * Intended to run unattended every 10-15 min on weekdays via launchd, the
 * same mechanism as the existing 6:15am COE sync (dev/run-daily-sync.sh).
 * See dev/launchd/com.olh.background-rebalance.plist.
 *
 * WHAT THIS DOES, each run:
 *   1. Pull reference data (drive matrix, walk roster, product->community
 *      map, Managers table) and every Jobs record.
 *   2. Build each in-scope calendar day's stops per manager, using the exact
 *      eligibility rules public/workload.html's optimizableWalks() uses
 *      (Record Status != Closed, real date present -- never a derived/
 *      forecast one, milestone not yet complete, CEL/ACC additionally
 *      gated on CEL Letter Sent) plus this job's own additions: skip
 *      Manual-Archive rows, and skip any walk assigned to more than one
 *      manager (ambiguous which one to move -- fail closed).
 *   3. For each day, run findSingleCommunityConsolidations() once, then
 *      rebalanceWorkload() in a loop until it stops finding moves -- exactly
 *      the caller contract both functions document.
 *   4. Write back every COMMITTED move (Tier 1 + Tier 2) to the relevant
 *      milestone's Manager field, and log an Audit Log row with
 *      Action = "optimizer-apply" -- the same action string the live Bulk
 *      Optimization panel already uses, so reporting doesn't need to know
 *      these came from a different code path.
 *   5. Write Tier 3 (flagged) walks to the Jobs table's "Rebalance Flagged" /
 *      "Rebalance Flag Detail" fields for a human to review, and clear those
 *      same fields on any previously-flagged walk this run no longer flags
 *      (the situation resolved on its own -- a walk got moved, a day's mix
 *      changed, etc).
 *
 * WHAT THIS NEVER DOES:
 *   - Touch a walk locked via QAI/QAA/CEL/ACC Manager Lock. Enforced inside
 *     route_constrained_optimizer_logic.js itself (rebalanceWorkload and
 *     findSingleCommunityConsolidations both skip locked stops) -- this
 *     file does not need its own lock check on top of that.
 *   - Touch today, or a day already in the past, or a weekend. Enforced by
 *     isInBackgroundScope()/nextBusinessDay() from the same module.
 *   - Fill an unassigned or off-roster walk. That is a DIFFERENT tier of
 *     work (see the INTEGRATION NOTE in route_constrained_optimizer_logic.js
 *     and _suggestForDay's "1. Unassigned" case) -- this job only rebalances
 *     walks that already have one (and only one) valid QAM assigned.
 *   - Guess at an unverifiable drive time. Every feasibility check in the
 *     optimizer module is fail-closed: null blocks the move, never allows it.
 *
 * ONE FLAG FIELD PER JOB RECORD, NOT PER MILESTONE: "Rebalance Flagged" /
 * "Rebalance Flag Detail" are single fields on Jobs, not four (one per
 * QAI/QAA/CEL/ACC). In the overwhelmingly common case a job has exactly one
 * open milestone at a time, so this is fine. If a job ever has two milestones
 * flagged in the same run, the later one processed wins the detail text --
 * an accepted simplification, not a bug, matching the "single field/view on
 * Jobs" scope this was built to.
 *
 * The Airtable PAT is read ONLY from process.env.AIRTABLE_PAT -- retrieve it
 * from Keychain first, e.g.:
 *   export AIRTABLE_PAT=$(security find-generic-password -s olh-tracker-airtable-pat -w)
 * ---------------------------------------------------------------------- */

'use strict';

const RO = require('./route_constrained_optimizer_logic.js');

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tblqpmwtZ6i4gtogl';
const ROSTER_TABLE = 'tblhDm8OD4jSR0tey';
const DRIVE_TABLE = 'tblVnYFUc4xuovVEC';
const PRODUCT_TABLE = 'tblvkWF5QULxhqFiX';
const MANAGERS_TABLE = 'tble8SiAKDLl7eS5D';
const AUDIT_TABLE = 'tblgiEqKXRbBHLg1i';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const HOURS = { QAI: 2, QAA: 1, CEL: 2, ACC: 1 };
const DAILY_CAP = 8;
const PAGE_DELAY_MS = 220;
const NEEDS_DRIVE_TIMES = 'NEW \u2014 needs drive times';
const EXCLUDED = 'Removed / Excluded';

// Mirrors public/workload.html's `defs` in optimizableWalks() exactly.
const MILESTONE_DEFS = [
  { code: 'QAI', dateField: 'QAI Date', mgrField: 'QAI Manager', doneField: 'QAI Complete', lockField: RO.LOCK_FIELD_BY_CODE.QAI, gated: false },
  { code: 'QAA', dateField: 'QAA Date', mgrField: 'QAA Manager', doneField: 'QAA Accepted', lockField: RO.LOCK_FIELD_BY_CODE.QAA, gated: false },
  { code: 'CEL', dateField: 'CEL Date', mgrField: 'CEL Manager', doneField: 'CEL Completed', lockField: RO.LOCK_FIELD_BY_CODE.CEL, gated: true },
  { code: 'ACC', dateField: 'ACC Date', mgrField: 'ACC Manager', doneField: 'ACC Completed', lockField: RO.LOCK_FIELD_BY_CODE.ACC, gated: true },
];

const DRY_RUN = !process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const selectName = (v) => (v && typeof v === 'object' && v.name ? v.name : v);

function pat() {
  const p = process.env.AIRTABLE_PAT;
  if (!p || !String(p).trim()) {
    throw new Error(
      'AIRTABLE_PAT is not set. Retrieve it from Keychain first:\n' +
      '  export AIRTABLE_PAT=$(security find-generic-password -s olh-tracker-airtable-pat -w)'
    );
  }
  return p;
}

async function fetchAllRecords(tableId) {
  const records = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(`${AIRTABLE_API}/${BASE_ID}/${tableId}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${pat()}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Airtable ${res.status} reading ${tableId}: ${(body && body.error && body.error.message) || ''}`);
    }
    const json = await res.json();
    if (Array.isArray(json.records)) records.push(...json.records);
    offset = json.offset || null;
    if (offset) await sleep(PAGE_DELAY_MS);
  } while (offset);
  return records;
}

async function fetchOneRecord(tableId, recordId) {
  const res = await fetch(`${AIRTABLE_API}/${BASE_ID}/${tableId}/${recordId}`, {
    headers: { Authorization: `Bearer ${pat()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Airtable ${res.status} reading ${tableId}/${recordId}: ${(body && body.error && body.error.message) || ''}`);
  }
  return res.json();
}

/* Has anyone changed this stop's manager field since this run first read it?
 * Compares the exact set of linked record ids, not just the resolved name --
 * two different people can't share a name collision this way. Called
 * immediately before every write that touches a manager field, so the
 * window between "decided this move" and "wrote this move" is as small as
 * one extra round trip, not the whole run's compute time. See the
 * conversation note on 2026-08-12 about update-job.js having no built-in
 * staleness check of its own -- this is that check, added here instead. */
async function stillMatchesOriginal(stop) {
  const fresh = await fetchOneRecord(JOBS_TABLE, stop.recordId);
  const freshIds = Array.isArray(fresh.fields && fresh.fields[stop.mgrField]) ? fresh.fields[stop.mgrField] : [];
  const orig = stop.originalMgrIds || [];
  return freshIds.length === orig.length && freshIds.every((id) => orig.includes(id));
}

async function patchRecord(tableId, recordId, fields) {
  if (DRY_RUN) return { dryRun: true };
  const res = await fetch(`${AIRTABLE_API}/${BASE_ID}/${tableId}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Airtable ${res.status} writing ${tableId}/${recordId}: ${(body && body.error && body.error.message) || ''}`);
  }
  return res.json();
}

async function createRecord(tableId, fields) {
  if (DRY_RUN) return { dryRun: true };
  const res = await fetch(`${AIRTABLE_API}/${BASE_ID}/${tableId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Airtable ${res.status} creating in ${tableId}: ${(body && body.error && body.error.message) || ''}`);
  }
  return res.json();
}

/* Mirrors public/workload.html's core() exactly: product map first, then
 * longest-match community prefix, then the two named special cases. */
function buildCommunityResolver(driveByFrom, productMapRecords) {
  const communities = Object.keys(driveByFrom);
  const byLen = communities.slice().sort((a, b) => b.length - a.length);
  const productMap = {};
  for (const r of productMapRecords) {
    const f = r.fields || {};
    const product = f['Product / Community Value'];
    const base = f['Base Community'];
    const status = selectName(f.Status) || '';
    if (!product || status === EXCLUDED) continue;
    // A community with no drive times cannot be routed -- leave it unmapped
    // rather than seat it at distance zero. Matches walk-config.js exactly.
    if (status === NEEDS_DRIVE_TIMES || (base && !driveByFrom[base])) continue;
    if (base) productMap[product] = base;
  }
  return function core(productLine) {
    if (!productLine) return null;
    if (productMap[productLine]) return productMap[productLine];
    const low = productLine.toLowerCase();
    for (const c of byLen) if (low.indexOf(c.toLowerCase()) === 0) return c;
    if (/^ranches/i.test(productLine)) return 'Ranches';
    if (/^sanctuary at wellness|^wellness way/i.test(productLine)) return 'Wellness Ridge';
    return null;
  };
}

const dateKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const parseDateOnly = (raw) => {
  const p = String(raw).slice(0, 10).split('-');
  if (p.length !== 3) return null;
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  return isNaN(d.getTime()) ? null : d;
};

// Weekday, 7am-7pm in the machine's local time zone. This does NOT gate what
// gets touched (isInBackgroundScope already restricts that to next-business-
// day onward) -- it only gates whether this run bothers hitting Airtable at
// all, so the launchd schedule can stay a flat 15-min interval instead of a
// calendar rule that has to be kept in sync with business hours by hand.
// Skippable with --force (e.g. for manual testing on a weekend).
function withinRunWindow(now) {
  if (process.argv.includes('--force')) return true;
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getHours();
  return hour >= 7 && hour < 19;
}

async function main() {
  const startedAt = new Date();
  if (!withinRunWindow(startedAt)) {
    console.log(`[${startedAt.toISOString()}] Outside the weekday 7am-7pm run window -- skipping (no Airtable calls made). Use --force to override.`);
    return;
  }
  console.log(`[${startedAt.toISOString()}] Background rebalance starting -- ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writes enabled)'}`);

  // -- reference data -----------------------------------------------------
  const driveRecords = await fetchAllRecords(DRIVE_TABLE);
  const drive = {};
  for (const r of driveRecords) {
    const f = r.fields || {};
    const from = f['From Community'], to = f['To Community'], min = f['Drive Minutes'];
    if (!from || !to || typeof min !== 'number') continue;
    (drive[from] = drive[from] || {})[to] = min;
  }
  const driveFn = (a, b) => {
    if (!a || !b) return null;
    if (a === b) return 0;
    const v = drive[a] && drive[a][b];
    return typeof v === 'number' ? v : null;
  };

  const rosterRecords = await fetchAllRecords(ROSTER_TABLE);
  const homeByName = {};
  const qamNames = [];
  for (const r of rosterRecords) {
    const f = r.fields || {};
    if (f.Active === false) continue;
    const name = f.Name;
    if (!name) continue;
    const home = f['Home Community'] || '';
    // Fail closed exactly like walk-config.js's homeKnown: a home community
    // the drive matrix has never heard of is treated as no home at all.
    homeByName[name] = home && drive[home] ? home : null;
    if (selectName(f.Role) === 'QAM') qamNames.push(name);
  }
  const homeOf = (name) => homeByName[name] || null;

  const productRecords = await fetchAllRecords(PRODUCT_TABLE);
  const core = buildCommunityResolver(drive, productRecords);

  const managerRecords = await fetchAllRecords(MANAGERS_TABLE);
  const managerNameById = {};
  const managerIdByName = {};
  for (const r of managerRecords) {
    const name = (r.fields || {}).Name;
    if (!name) continue;
    managerNameById[r.id] = name;
    managerIdByName[name] = r.id;
  }

  // -- scope window ---------------------------------------------------------
  const scopeStart = RO.nextBusinessDay(startedAt);
  const scopeEnd = new Date(scopeStart);
  scopeEnd.setDate(scopeEnd.getDate() + RO.BACKGROUND_LOOKAHEAD_DAYS);
  console.log(`Scope: ${dateKey(scopeStart)} through ${dateKey(scopeEnd)}, weekdays only`);

  // -- jobs -------------------------------------------------------------
  const jobRecords = await fetchAllRecords(JOBS_TABLE);
  console.log(`Pulled ${jobRecords.length} Jobs records`);

  const skipCounts = {};
  const bump = (reason) => { skipCounts[reason] = (skipCounts[reason] || 0) + 1; };

  // dayGroups: { [dateKey]: [{ recordId, code, mgrField, community, sortTime, code, locked, manager }] }
  const dayGroups = {};
  const previouslyFlagged = []; // records that currently have Rebalance Flagged checked

  for (const rec of jobRecords) {
    const f = rec.fields || {};
    if (f['Rebalance Flagged']) previouslyFlagged.push(rec.id);
    if (f['Record Status'] === 'Closed') continue;
    if (f['Manual Archive - Do Not Resync']) continue;
    const community = core(f['Community'] || '');
    if (!community) { bump('unmapped or unscheduled community'); continue; }

    for (const def of MILESTONE_DEFS) {
      if (def.gated && !f['CEL Letter Sent']) continue; // not eligible yet, not a skip worth counting
      if (f[def.doneField]) continue; // already done, nothing to rebalance
      const raw = f[def.dateField];
      if (!raw) continue; // no real scheduled date -- never touch a derived/forecast one
      const dt = parseDateOnly(raw);
      if (!dt) { bump(`${def.code}: unparseable date`); continue; }
      if (!RO.isInBackgroundScope(dt, startedAt)) continue; // out of scope, not an error

      const mgrIds = Array.isArray(f[def.mgrField]) ? f[def.mgrField] : [];
      if (mgrIds.length === 0) { bump(`${def.code}: unassigned (out of scope for rebalancing)`); continue; }
      if (mgrIds.length > 1) { bump(`${def.code}: more than one manager linked (ambiguous, skipped)`); continue; }
      const manager = managerNameById[mgrIds[0]];
      if (!manager) { bump(`${def.code}: linked manager record not found`); continue; }
      if (!qamNames.includes(manager)) { bump(`${def.code}: assigned manager not an active QAM on Walk Roster`); continue; }

      const k = dateKey(dt);
      (dayGroups[k] = dayGroups[k] || []).push({
        recordId: rec.id,
        job: f['Job #'] || '',
        code: def.code,
        mgrField: def.mgrField,
        community,
        sortTime: dt.getTime(),
        locked: f[def.lockField] === true,
        manager,
        originalMgrIds: mgrIds.slice(),
      });
    }
  }

  const dayKeys = Object.keys(dayGroups).sort();
  console.log(`${dayKeys.length} in-scope day(s) with eligible walks`);
  if (Object.keys(skipCounts).length) {
    console.log('Skipped (not eligible):', JSON.stringify(skipCounts, null, 2));
  }

  // -- per-day passes -------------------------------------------------------
  const applied = [];
  const flaggedThisRun = new Map(); // recordId -> { detail, stop }
  const errors = [];

  for (const day of dayKeys) {
    const stops = dayGroups[day];
    const stopsByMgr = {};
    const loadByMgr = {};
    for (const n of qamNames) { stopsByMgr[n] = []; loadByMgr[n] = 0; }
    for (const s of stops) {
      (stopsByMgr[s.manager] = stopsByMgr[s.manager] || []).push(s);
      loadByMgr[s.manager] = (loadByMgr[s.manager] || 0) + (HOURS[s.code] || 0);
    }

    // Pass 1: no-tradeoff consolidations.
    let consolidations = [];
    try {
      consolidations = RO.findSingleCommunityConsolidations(qamNames, stopsByMgr, loadByMgr, homeOf, driveFn, DAILY_CAP, HOURS);
    } catch (err) {
      errors.push(`${day}: consolidation pass threw: ${err.message}`);
    }
    for (const m of consolidations) applied.push({ day, tier: 'consolidation', ...m });

    // Pass 2: rebalance, looped until it stops finding committed moves --
    // the caller contract rebalanceWorkload() documents. GUARDED against
    // thrash: two managers tied at equal load, with a third who's
    // structurally infeasible to help (e.g. over the drive-time ceiling),
    // both register as "heavy" every call and the algorithm will shuffle
    // the same walks between them forever with no net progress -- a real
    // gap in the underlying heuristic (confirmed 2026-08-12, see commit
    // notes), not something to paper over with a bare iteration cap. The
    // moment any single walk is selected to move a SECOND time in this
    // day's loop, that's the earliest reliable signal of a cycle: stop
    // looping for this day, and don't record or write that repeat move --
    // whatever was already committed up to that point stands as the
    // converged result.
    const movedOnceThisDay = new Set(); // "<recordId>|<code>"
    let guard = 0;
    let thrashDetected = false;
    while (guard++ < 20 && !thrashDetected) {
      let result;
      try {
        result = RO.rebalanceWorkload(qamNames, loadByMgr, stopsByMgr, homeOf, driveFn, DAILY_CAP, HOURS);
      } catch (err) {
        errors.push(`${day}: rebalance pass threw: ${err.message}`);
        break;
      }
      for (const m of result.committed) {
        const key = `${m.stop.recordId}|${m.stop.code}`;
        if (movedOnceThisDay.has(key)) {
          thrashDetected = true;
          console.warn(`${day}: thrash guard tripped on Job ${m.stop.job} ${m.stop.code} (${m.from} <-> ${m.to}) -- stopping this day's rebalance loop, treating prior state as converged.`);
          continue; // don't record/write this repeat move
        }
        movedOnceThisDay.add(key);
        applied.push({ day, ...m });
      }
      for (const flag of result.flagged) {
        const detail =
          `${flag.stop.code}: suggest moving Job ${flag.stop.job || '?'} (${flag.stop.community}) ` +
          `from ${flag.from} to ${flag.to} \u2014 ${flag.worstLeg} min drive, ` +
          `exceeds the ${RO.WORKLOAD_MAX_LEG_MINUTES}-min rebalancing ceiling. Scheduled ${day}.`;
        flaggedThisRun.set(flag.stop.recordId, { detail, stop: flag.stop });
      }
      if (!result.committed.length) break;
    }
    if (guard >= 20 && !thrashDetected) {
      errors.push(`${day}: hit the 20-iteration cap without the thrash guard tripping -- investigate before trusting this day's result.`);
    }
  }

  console.log(`${applied.length} move(s) to apply, ${flaggedThisRun.size} walk(s) to flag for review`);

  // -- write committed moves ------------------------------------------------
  let writeErrors = 0;
  let staleSkippedMoves = 0;
  for (const move of applied) {
    try {
      const receiverId = managerIdByName[move.to];
      if (!receiverId) throw new Error(`${move.to} has no matching Managers-table record`);
      if (!DRY_RUN) {
        const fresh = await stillMatchesOriginal(move.stop);
        if (!fresh) {
          staleSkippedMoves++;
          console.warn(`STALE, skipping: Job ${move.stop.job} ${move.stop.code} manager changed since this run started -- not applying ${move.from} -> ${move.to}. Will be re-evaluated next run against current data.`);
          continue;
        }
      }
      await patchRecord(JOBS_TABLE, move.stop.recordId, { [move.stop.mgrField]: [receiverId] });
      await createRecord(AUDIT_TABLE, {
        'Entry Id': `bgrebal-${move.stop.recordId}-${move.stop.code}-${Date.now()}`,
        'Record Id': move.stop.recordId,
        'Job #': move.stop.job || '',
        Field: move.stop.mgrField,
        Label: `${move.stop.code} Walk Manager`,
        From: move.from,
        To: move.to,
        Action: 'optimizer-apply',
        Page: 'Background Rebalance',
        'Changed By': 'Background Optimizer',
        'Changed By Role': 'system',
        'Changed At': new Date().toISOString(),
      });
      console.log(`${DRY_RUN ? '[dry run] would apply' : 'applied'}: ${move.day} ${move.stop.code} Job ${move.stop.job} ${move.from} -> ${move.to} (worst leg ${move.worstLeg} min, tier ${move.tier || 'consolidation'})`);
    } catch (err) {
      writeErrors++;
      console.error(`FAILED to apply move for Job ${move.stop.job} ${move.stop.code}: ${err.message}`);
    }
  }

  // -- write / clear flags ---------------------------------------------------
  let staleSkippedFlags = 0;
  for (const [recordId, flag] of flaggedThisRun) {
    try {
      if (!DRY_RUN) {
        const fresh = await stillMatchesOriginal(flag.stop);
        if (!fresh) {
          staleSkippedFlags++;
          console.warn(`STALE, skipping flag write: Job ${flag.stop.job} ${flag.stop.code} manager changed since this run started.`);
          continue;
        }
      }
      await patchRecord(JOBS_TABLE, recordId, { 'Rebalance Flagged': true, 'Rebalance Flag Detail': flag.detail });
    } catch (err) {
      writeErrors++;
      console.error(`FAILED to write flag for record ${recordId}: ${err.message}`);
    }
  }
  const toClear = previouslyFlagged.filter((id) => !flaggedThisRun.has(id));
  for (const recordId of toClear) {
    try {
      await patchRecord(JOBS_TABLE, recordId, { 'Rebalance Flagged': false, 'Rebalance Flag Detail': '' });
    } catch (err) {
      writeErrors++;
      console.error(`FAILED to clear flag for record ${recordId}: ${err.message}`);
    }
  }

  console.log(
    `[${new Date().toISOString()}] Done. ${applied.length - staleSkippedMoves} move(s) applied, ` +
    `${staleSkippedMoves} move(s) + ${staleSkippedFlags} flag(s) skipped as stale (changed by someone else since this run started), ` +
    `${flaggedThisRun.size - staleSkippedFlags} flagged, ${toClear.length} flag(s) cleared, ` +
    `${errors.length} pass error(s), ${writeErrors} write error(s).${DRY_RUN ? ' Re-run with --apply to write.' : ''}`
  );
  if (errors.length) console.log('Pass errors:', errors);
  if (writeErrors || errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Background rebalance FAILED: ${err.message}`);
  process.exitCode = 1;
});
