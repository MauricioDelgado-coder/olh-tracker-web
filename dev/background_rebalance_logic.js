/* ------------------------------------------------------------------------
 * BACKGROUND REBALANCE -- logic module
 *
 * Recovered 2026-08-17. This is NOT the old route-constrained optimizer --
 * that module's INITIAL-PLACEMENT approach (canAddStop/rankCandidates/
 * homeAffinity, used to build a day from an empty roster) really was
 * superseded by dev/three_pass_scheduler_logic.js and stays retired.
 *
 * But rebalanceWorkload() and findSingleCommunityConsolidations() below
 * never depended on that initial-placement code -- they operate on
 * whatever the day's CURRENT live assignments already are (however they
 * got there) and only ever propose a move when it is a demonstrable
 * improvement. Deleting this file alongside the initial-placement code
 * this morning (commit d6fdf22) swept away a genuinely independent,
 * still-valid piece of logic along with the part that really was
 * superseded. This file un-deletes exactly the rebalance-side functions,
 * unchanged, under a name that no longer implies it competes with the
 * three-pass scheduler -- it runs AFTER a day already has assignments
 * (from three-pass scheduling, manual entry, or anything else), looking
 * for improving trades, not building a day from scratch.
 *
 * Confirmed by a fresh sandbox run against live Aug 2026 data before
 * rebuilding this file for real: a naive "rebuild the whole day with
 * ThreePassScheduler and diff against current state" approach produced
 * ~53 apparent "moves" for a single day, the overwhelming majority at a
 * 0-minute drive leg -- pure churn from a from-scratch algorithm having
 * no preference for leaving a tied assignment alone. Running THIS
 * module's rebalance/consolidation logic against the same live day
 * instead produced 15 genuine moves + 2 real flags, matching what a
 * person reviewing the day by hand would actually want to change.
 *
 * Nothing in this file talks to Airtable or the network. Every function
 * takes plain data and a driveFn callback; the caller (run-background-
 * rebalance.js) is responsible for building stopsByMgr/loadByMgr from
 * live data and for writing back whatever this module decides.
 * ---------------------------------------------------------------------- */

const MAX_LEG_MINUTES = 45;          // no single drive leg in a day's route may exceed this
const MAX_BETWEEN_MINUTES = 90;      // total drive time between stops (excludes first/last home legs)
const WORKLOAD_MAX_LEG_MINUTES = 60; // MAX_LEG_MINUTES + 15 -- auto-commit ceiling for rebalancing only
const BACKGROUND_LOOKAHEAD_DAYS = 30; // how many days ahead an unattended run is allowed to touch

/* ------------------------------------------------------------------------
 * ROUTING (supporting math for the rebalance/consolidation checks below)
 * ------------------------------------------------------------------------ */

function buildRoute(home, stops, driveFn) {
  const communities = stops.map(s => s.community).filter(Boolean);
  if (!communities.length) return [];
  const cost = (a, b) => { const v = driveFn(a, b); return v === null ? Infinity : v; };

  const remaining = communities.slice().sort();
  const route = [remaining.shift()];

  while (remaining.length) {
    let best_idx = 0, bestPos = 0, bestDelta = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      for (let pos = 0; pos <= route.length; pos++) {
        const prev = pos === 0 ? home : route[pos - 1];
        const next = pos === route.length ? home : route[pos];
        const delta = cost(prev, c) + cost(c, next) - cost(prev, next);
        if (delta < bestDelta || (delta === bestDelta && c < remaining[best_idx])) {
          bestDelta = delta; best_idx = i; bestPos = pos;
        }
      }
    }
    route.splice(bestPos, 0, remaining.splice(best_idx, 1)[0]);
  }
  return route;
}

function worstLeg(home, stops, driveFn) {
  const order = buildRoute(home, stops, driveFn);
  const full = [home, ...order, home];
  const legs = [];
  for (let i = 0; i < full.length - 1; i++) legs.push(driveFn(full[i], full[i + 1]));
  if (legs.some(l => l === null)) return { worst: null, legs };
  return { worst: Math.max(...legs), legs };
}

function betweenOk(legs) {
  if (legs.length <= 2) return true;
  const between = legs.slice(1, -1).reduce((a, b) => a + b, 0);
  return between <= MAX_BETWEEN_MINUTES;
}

/* ------------------------------------------------------------------------
 * REBALANCING
 *
 * Three tiers, decided by the RECEIVING manager's worst leg after the
 * move:
 *   worst <= MAX_LEG_MINUTES (45)                -- committed, unrestricted
 *   MAX_LEG_MINUTES < worst <= WORKLOAD_MAX_LEG_MINUTES (60)
 *                                                 -- committed, REBALANCING ONLY
 *   worst > WORKLOAD_MAX_LEG_MINUTES              -- never auto-applied; the
 *                                                    single closest-to-threshold
 *                                                    option is flagged for a
 *                                                    person to review
 * ------------------------------------------------------------------------ */

function rebalanceWorkload(qamNames, loadByMgr, stopsByMgr, homeOf, driveFn, dailyCap, hoursByCode) {
  const committed = [];
  const flagged_by_mgr = {};

  const avg = qamNames.reduce((s, n) => s + (loadByMgr[n] || 0), 0) / (qamNames.length || 1);
  const heavy = qamNames.filter(n => (loadByMgr[n] || 0) > avg + 1)
    .sort((a, b) => (loadByMgr[b] || 0) - (loadByMgr[a] || 0));

  for (const giver of heavy) {
    const giver_stops = stopsByMgr[giver] || [];
    if (!giver_stops.length) continue;

    let best_move = null;

    for (const stop of giver_stops) {
      if (isLocked(stop)) continue;
      for (const receiver of qamNames) {
        if (receiver === giver) continue;
        const hrs = hoursByCode[stop.code] || 0;
        if ((loadByMgr[receiver] || 0) + hrs > dailyCap) continue;

        const receiver_home = homeOf(receiver);
        if (!receiver_home) continue;
        const receiver_check = worstLeg(receiver_home, (stopsByMgr[receiver] || []).concat([stop]), driveFn);
        if (receiver_check.worst === null || receiver_check.worst > WORKLOAD_MAX_LEG_MINUTES) continue;

        const remaining = giver_stops.filter(s => s !== stop);
        const giver_check = remaining.length
          ? worstLeg(homeOf(giver), remaining, driveFn)
          : { worst: 0 };
        if (giver_check.worst === null || giver_check.worst > WORKLOAD_MAX_LEG_MINUTES) continue;

        if (!best_move || receiver_check.worst < best_move.receiverWorst) {
          best_move = { stop, receiver, receiverWorst: receiver_check.worst };
        }
      }
    }

    if (best_move && best_move.receiverWorst <= MAX_LEG_MINUTES) {
      applyMove(giver, best_move.receiver, best_move.stop, loadByMgr, stopsByMgr, hoursByCode);
      committed.push({ from: giver, to: best_move.receiver, stop: best_move.stop, worstLeg: best_move.receiverWorst, tier: 1 });
      delete flagged_by_mgr[giver];
    } else if (best_move) {
      applyMove(giver, best_move.receiver, best_move.stop, loadByMgr, stopsByMgr, hoursByCode);
      committed.push({ from: giver, to: best_move.receiver, stop: best_move.stop, worstLeg: best_move.receiverWorst, tier: 2 });
      delete flagged_by_mgr[giver];
    } else {
      let closest = null;
      for (const stop of giver_stops) {
        if (isLocked(stop)) continue;
        for (const receiver of qamNames) {
          if (receiver === giver) continue;
          const hrs = hoursByCode[stop.code] || 0;
          if ((loadByMgr[receiver] || 0) + hrs > dailyCap) continue;
          const receiver_home = homeOf(receiver);
          if (!receiver_home) continue;
          const check = worstLeg(receiver_home, (stopsByMgr[receiver] || []).concat([stop]), driveFn);
          if (check.worst === null) continue;
          if (!closest || check.worst < closest.worst) closest = { stop, receiver, worst: check.worst };
        }
      }
      if (closest) {
        flagged_by_mgr[giver] = { from: giver, to: closest.receiver, stop: closest.stop, worstLeg: closest.worst, tier: 3 };
      }
    }
  }

  return { committed, flagged: Object.values(flagged_by_mgr) };
}

function applyMove(giver, receiver, stop, loadByMgr, stopsByMgr, hoursByCode) {
  const hrs = hoursByCode[stop.code] || 0;
  loadByMgr[giver] = Math.max(0, (loadByMgr[giver] || 0) - hrs);
  loadByMgr[receiver] = (loadByMgr[receiver] || 0) + hrs;
  stopsByMgr[giver] = (stopsByMgr[giver] || []).filter(s => s !== stop);
  stopsByMgr[receiver] = (stopsByMgr[receiver] || []).concat([stop]);
}

/* ------------------------------------------------------------------------
 * SINGLE-COMMUNITY CONSOLIDATION
 * ------------------------------------------------------------------------ */

function findSingleCommunityConsolidations(qamNames, stopsByMgr, loadByMgr, homeOf, driveFn, dailyCap, hoursByCode) {
  const moves = [];
  for (const community of new Set(qamNames.flatMap(n => (stopsByMgr[n] || []).map(s => s.community)).filter(Boolean))) {
    const visitors = qamNames.filter(n => (stopsByMgr[n] || []).some(s => s.community === community));
    const target = qamNames.find(n => homeOf(n) === community && visitors.includes(n))
      || visitors.find(n => (stopsByMgr[n] || []).filter(s => s.community === community).length > 1);
    if (!target) continue;

    for (const visitor of visitors) {
      if (visitor === target) continue;
      const visitor_stops = (stopsByMgr[visitor] || []).filter(s => s.community === community);
      if ((stopsByMgr[visitor] || []).length !== visitor_stops.length) continue;

      for (const stop of visitor_stops) {
        if (isLocked(stop)) continue;
        const hrs = hoursByCode[stop.code] || 0;
        if ((loadByMgr[target] || 0) + hrs > dailyCap) continue;
        const target_home = homeOf(target);
        if (!target_home) continue;
        const check = worstLeg(target_home, (stopsByMgr[target] || []).concat([stop]), driveFn);
        if (check.worst === null || check.worst > MAX_LEG_MINUTES) continue;
        if (!betweenOk(check.legs)) continue;

        applyMove(visitor, target, stop, loadByMgr, stopsByMgr, hoursByCode);
        moves.push({ from: visitor, to: target, stop, community, worstLeg: check.worst });
      }
    }
  }
  return moves;
}

/* ------------------------------------------------------------------------
 * BACKGROUND SCHEDULING SCOPE
 * ------------------------------------------------------------------------ */

function nextBusinessDay(from) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function isInBackgroundScope(date, today) {
  const start = nextBusinessDay(today || new Date());
  const end = new Date(start);
  end.setDate(end.getDate() + BACKGROUND_LOOKAHEAD_DAYS);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  return d >= start && d <= end;
}

/* ------------------------------------------------------------------------
 * MANAGER LOCKS
 *
 * SCHEMA: four checkbox fields on Jobs, one per milestone code --
 *   QAI Manager Lock, QAA Manager Lock, CEL Manager Lock, ACC Manager Lock
 * Created live on the Jobs table (tblqpmwtZ6i4gtogl) 2026-08-07, and
 * never removed even while this module was briefly deleted.
 * ------------------------------------------------------------------------ */

const LOCK_FIELD_BY_CODE = {
  QAI: "QAI Manager Lock",
  QAA: "QAA Manager Lock",
  CEL: "CEL Manager Lock",
  ACC: "ACC Manager Lock",
};

function isLocked(stop) {
  return stop.locked === true;
}

module.exports = {
  MAX_LEG_MINUTES,
  MAX_BETWEEN_MINUTES,
  WORKLOAD_MAX_LEG_MINUTES,
  BACKGROUND_LOOKAHEAD_DAYS,
  buildRoute,
  worstLeg,
  betweenOk,
  rebalanceWorkload,
  findSingleCommunityConsolidations,
  nextBusinessDay,
  isInBackgroundScope,
  isLocked,
  LOCK_FIELD_BY_CODE,
};
