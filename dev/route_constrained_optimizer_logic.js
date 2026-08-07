/* ------------------------------------------------------------------------
 * ROUTE-CONSTRAINED WALK OPTIMIZER -- logic module
 *
 * Rebuilt 2026-08-07. Grew out of the manual 8/13 and 8/14 walk calendar
 * reviews: the existing in-page optimizer (_suggestForDay() in
 * workload.html) picks candidates by a single point-to-point drive cost
 * from a manager's last-known community, but never checks whether the
 * manager's WHOLE day still makes sense as a drivable route once a walk
 * is added. That gap produced days with 5+ hours of driving on top of
 * walk work, and the exact pattern -- three different managers each
 * making a solo trip to Grove at Grenelefe while both home QAMs were
 * elsewhere that day -- is what home-affinity ranking below exists to
 * catch automatically.
 *
 * This module is intentionally separate from workload.html's live
 * _suggestForDay(). It is designed to run as an UNATTENDED background
 * job (the same mechanism as the existing 6:15am COE sync via launchd),
 * not as part of the page's interactive Bulk Optimization panel. See
 * isInBackgroundScope()/nextBusinessDay() below for why the two contexts
 * need different rules, and isLocked()/LOCK_FIELD_BY_CODE for why an
 * unattended job needs an escape hatch a human reviewer doesn't.
 *
 * Nothing in this file talks to Airtable or the network. Every function
 * takes plain data and a driveFn callback; the caller is responsible for
 * building stopsByMgr/loadByMgr from live data and for writing back
 * whatever this module decides.
 * ---------------------------------------------------------------------- */

const MAX_LEG_MINUTES = 45;        // no single drive leg in a day's route may exceed this
const MAX_BETWEEN_MINUTES = 90;    // total drive time between stops (excludes first/last home legs)
const WORKLOAD_MAX_LEG_MINUTES = 60; // MAX_LEG_MINUTES + 15 -- auto-commit ceiling for REBALANCING only, never initial placement
const BACKGROUND_LOOKAHEAD_DAYS = 14; // how many days ahead an unattended run is allowed to touch

/* ------------------------------------------------------------------------
 * ROUTING
 * ------------------------------------------------------------------------ */

/* Cheapest-insertion routing: given a home base and a set of stops (each
 * { community }), returns an ORDERED array of communities that approximates
 * the lowest-drive route starting and ending at home. Not exact TSP --
 * cheapest-insertion is O(stops^2) and good enough at the scale this runs
 * at (a single manager's single day, typically 1-4 stops). Ties broken by
 * community name so the result is deterministic and diffable.
 *
 * driveFn(a, b) must return minutes (number) or null if unknown. A null
 * leg is treated as infinitely expensive for ordering purposes -- routing
 * still produces an order, but routeFeasible()/worstLeg() are what decide
 * whether that order is actually safe to use. */
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

/* The single worst (longest) leg in a manager's built route, plus the full
 * leg list for a between-stops check. Returns { worst: null, legs } if any
 * leg's drive time is unknown -- callers MUST treat worst === null as
 * "can't evaluate this move," never as "no problem found." That contract
 * is deliberately fail-closed: an unattended job silently proceeding on
 * an unverifiable drive time is worse than it flagging nothing that day. */
function worstLeg(home, stops, driveFn) {
  const order = buildRoute(home, stops, driveFn);
  const full = [home, ...order, home];
  const legs = [];
  for (let i = 0; i < full.length - 1; i++) legs.push(driveFn(full[i], full[i + 1]));
  if (legs.some(l => l === null)) return { worst: null, legs };
  return { worst: Math.max(...legs), legs };
}

/* Total drive time between stops, excluding the unavoidable first and
 * last home legs (a manager always starts and ends somewhere -- that
 * commute isn't the walk schedule's fault). legs here is the FULL leg
 * list from worstLeg (home->s1->s2->...->home), so slicing off the first
 * and last entries gives exactly the between-stops portion. */
function betweenOk(legs) {
  if (legs.length <= 2) return true;
  const between = legs.slice(1, -1).reduce((a, b) => a + b, 0);
  return between <= MAX_BETWEEN_MINUTES;
}

/* A stop set is feasible when every leg is known and <= MAX_LEG_MINUTES,
 * and the between-stops total is within budget. Fail-closed: an unknown
 * leg (worst === null) is NOT feasible, since there's nothing to verify
 * it against -- this is the same contract worstLeg() documents. */
function routeFeasible(home, stops, driveFn) {
  const { worst, legs } = worstLeg(home, stops, driveFn);
  if (worst === null) return false;
  if (worst > MAX_LEG_MINUTES) return false;
  return betweenOk(legs);
}

/* Gate function for candidate selection: would adding newStop to mgrName's
 * current day still leave every leg <= MAX_LEG_MINUTES and the between-
 * stops total <= MAX_BETWEEN_MINUTES? dayStopsByMgr is a plain object
 * keyed by manager name, each value an array of { community, sortTime }
 * stops already committed to that manager's day (before the addition). */
function canAddStop(mgrName, newStop, dayStopsByMgr, homeOf, driveFn) {
  const home = homeOf(mgrName);
  if (!home) return false;
  const current = dayStopsByMgr[mgrName] || [];
  return routeFeasible(home, current.concat([newStop]), driveFn);
}

/* ------------------------------------------------------------------------
 * RANKING
 * ------------------------------------------------------------------------ */

/* Tiered preference for who should take a walk in `community`:
 *   0 -- mgrName's home community IS community (best: no drive at all)
 *   1 -- mgrName already has a stop there today (already driving that way)
 *   2 -- neither (fall back to raw drive cost, handled by the caller)
 * This is the piece that catches the Grove at Grenelefe pattern: three
 * managers each making a solo trip while the two home QAMs were elsewhere
 * ranks those solo trips behind the home managers automatically, instead
 * of needing a person to notice the pattern by eye. */
function homeAffinity(mgrName, community, dayStopsByMgr, homeOf) {
  if (!community) return 2;
  if (homeOf(mgrName) === community) return 0;
  const stops = dayStopsByMgr[mgrName] || [];
  if (stops.some(s => s.community === community)) return 1;
  return 2;
}

/* Sorts candidates for a single walk: home-affinity tier first, then raw
 * drive cost (costFn), then current load (loadFn, lower first -- prefer
 * the less-booked manager on a tie), then name for determinism. */
function rankCandidates(candidates, community, dayStopsByMgr, homeOf, costFn, loadFn) {
  return candidates.slice().sort((a, b) => {
    const ta = homeAffinity(a, community, dayStopsByMgr, homeOf);
    const tb = homeAffinity(b, community, dayStopsByMgr, homeOf);
    if (ta !== tb) return ta - tb;
    const ca = costFn(a), cb = costFn(b);
    const x = ca === null ? Infinity : ca, y = cb === null ? Infinity : cb;
    if (x !== y) return x - y;
    const la = loadFn(a), lb = loadFn(b);
    if (la !== lb) return la - lb;
    return a.localeCompare(b);
  });
}

/* ------------------------------------------------------------------------
 * INTEGRATION NOTE for workload.html's _suggestForDay, if this is ever
 * wired into the interactive page rather than run only as a background
 * job (see header comment for why those are currently kept separate):
 *
 *   const cands = (r, not) => {
 *     const ok = pool.filter(n =>
 *       n !== not &&
 *       (load[n] || 0) + HOURS[r.code] <= DAILY_CAP &&
 *       free(n, r) &&
 *       canAddStop(n, { community: r.community, sortTime: r.sortTime },
 *                  dayStopsByMgr, homeOf, drive));   // <-- NEW gate
 *     return rankCandidates(ok, r.community, dayStopsByMgr, homeOf,   // <-- NEW rank
 *       n => cost(n, r), n => load[n] || 0);
 *   };
 *
 * dayStopsByMgr would need to be built and kept in sync alongside the
 * existing load/cc/commList/times bookkeeping in credit()/debit() --
 * every credit pushes { community, sortTime } onto dayStopsByMgr[n],
 * every debit pops the matching entry back off.
 *
 * PRODUCTION CAVEAT: buildRoute()'s cheapest-insertion is O(stops^2) per
 * candidate check, and canAddStop() reruns it for every candidate on
 * every walk. For a single day's ~54 walks across ~19 managers this is
 * cheap. It has not been load-tested at multi-week batch scale; if that's
 * ever needed, cache each manager's current route between calls instead
 * of rebuilding it from scratch per candidate.
 * ---------------------------------------------------------------------- */

/* ------------------------------------------------------------------------
 * REBALANCING
 *
 * Three tiers, decided by the RECEIVING manager's worst leg after the
 * move:
 *   worst <= MAX_LEG_MINUTES (45)              -- committed, unrestricted
 *   MAX_LEG_MINUTES < worst <= WORKLOAD_MAX_LEG_MINUTES (60)
 *                                               -- committed, REBALANCING ONLY
 *                                                  (never offered for initial
 *                                                  placement -- see canAddStop,
 *                                                  which has no such allowance)
 *   worst > WORKLOAD_MAX_LEG_MINUTES            -- never auto-applied; the
 *                                                  single closest-to-threshold
 *                                                  option is flagged for a
 *                                                  person to review
 *
 * This design traces back to Lissette Ortiz sitting 62 minutes from
 * Wellness Ridge during the 8/14 review -- 2 minutes over a strict 60-min
 * line, on a move that would otherwise have relieved real overload. A
 * hard cutoff there would silently do nothing; surfacing it as a flagged
 * candidate lets a person make the 2-minute call instead of the algorithm
 * making it unattended.
 * ------------------------------------------------------------------------ */

/* One rebalancing pass over the day's current assignments.
 *   qamNames: pool of manager names in scope.
 *   loadByMgr: { name: hours } current load.
 *   stopsByMgr: { name: [{ community, sortTime }] } current stops.
 *   homeOf: (mgr) => home community.
 *   driveFn: (a, b) => minutes or null.
 *   dailyCap: same DAILY_CAP used everywhere else in the optimizer.
 *   hoursByCode: e.g. { QAI: 2, QAA: 1, CEL: 2, ACC: 1 } -- passed in
 *     rather than hardcoded so this can never drift from whatever the
 *     caller (workload.html's HOURS, or any other caller) actually uses.
 *
 * Returns { committed, flagged }:
 *   committed -- moves already applied to loadByMgr/stopsByMgr in place.
 *     Each is route-feasible for BOTH the giving and receiving manager,
 *     and the receiving side's worst leg is <= WORKLOAD_MAX_LEG_MINUTES.
 *   flagged -- at most ONE entry per still-overloaded manager who did not
 *     receive a committed move: the closest-to-threshold option that
 *     would help but exceeds WORKLOAD_MAX_LEG_MINUTES. Never applied.
 *     Present these to a person; only apply on explicit approval, same
 *     as the existing Bulk Optimization panel's Apply/Skip.
 *
 * Caller is expected to loop this (re-evaluate after committed moves are
 * applied) until committed comes back empty, mirroring how the 8/13 and
 * 8/14 reviews iterated by hand. */
function rebalanceWorkload(qamNames, loadByMgr, stopsByMgr, homeOf, driveFn, dailyCap, hoursByCode) {
  const committed = [];
  const flagged_by_mgr = {}; // one slot per overloaded manager; later, closer-to-threshold candidates overwrite earlier ones

  const avg = qamNames.reduce((s, n) => s + (loadByMgr[n] || 0), 0) / (qamNames.length || 1);
  const heavy = qamNames.filter(n => (loadByMgr[n] || 0) > avg + 1)
    .sort((a, b) => (loadByMgr[b] || 0) - (loadByMgr[a] || 0));

  for (const giver of heavy) {
    const giver_stops = stopsByMgr[giver] || [];
    if (!giver_stops.length) continue;

    let best_move = null; // { stop, receiver, receiverWorst }

    for (const stop of giver_stops) {
      for (const receiver of qamNames) {
        if (receiver === giver) continue;
        const hrs = hoursByCode[stop.code] || 0;
        if ((loadByMgr[receiver] || 0) + hrs > dailyCap) continue;

        // Receiving side: would this leave the receiver's day feasible?
        const receiver_home = homeOf(receiver);
        if (!receiver_home) continue;
        const receiver_check = worstLeg(receiver_home, (stopsByMgr[receiver] || []).concat([stop]), driveFn);
        // Fail-closed: an unverifiable leg is not a candidate, full stop --
        // this mirrors the giving-side check below exactly, on purpose.
        if (receiver_check.worst === null || receiver_check.worst > WORKLOAD_MAX_LEG_MINUTES) continue;

        // Giving side: after removing this stop, is the giver's remaining
        // day still feasible? Removing a stop can only reduce a route's
        // worst leg or leave it unchanged EXCEPT when the only known-good
        // leg was the one through the removed stop -- so this still needs
        // a real check, not an assumption. Same fail-closed contract as
        // the receiving side: null or over-threshold means "can't confirm
        // this is safe," which blocks the move rather than allowing it.
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
      // Tier 1: clean, commit immediately.
      applyMove(giver, best_move.receiver, best_move.stop, loadByMgr, stopsByMgr, hoursByCode);
      committed.push({ from: giver, to: best_move.receiver, stop: best_move.stop, worstLeg: best_move.receiverWorst, tier: 1 });
      delete flagged_by_mgr[giver]; // a successful commit supersedes any earlier flagged attempt for this manager
    } else if (best_move) {
      // Tier 2: over 45 but within the 60 rebalancing ceiling -- still commits, but only here.
      applyMove(giver, best_move.receiver, best_move.stop, loadByMgr, stopsByMgr, hoursByCode);
      committed.push({ from: giver, to: best_move.receiver, stop: best_move.stop, worstLeg: best_move.receiverWorst, tier: 2 });
      delete flagged_by_mgr[giver];
    } else {
      // Tier 3: nothing within WORKLOAD_MAX_LEG_MINUTES -- look for the
      // closest-to-threshold option among moves that exceed it, so a
      // person has exactly one concrete thing to review, not a wall of
      // near-duplicate options.
      let closest = null;
      for (const stop of giver_stops) {
        for (const receiver of qamNames) {
          if (receiver === giver) continue;
          const hrs = hoursByCode[stop.code] || 0;
          if ((loadByMgr[receiver] || 0) + hrs > dailyCap) continue;
          const receiver_home = homeOf(receiver);
          if (!receiver_home) continue;
          const check = worstLeg(receiver_home, (stopsByMgr[receiver] || []).concat([stop]), driveFn);
          if (check.worst === null) continue; // unverifiable is not a candidate to show either
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
 *
 * Catches the pattern the 8/13 review kept finding by hand: a lone
 * "foreign" visit to a community where a home QAM (or a manager already
 * stopping there that day) exists, but the walk landed on someone else
 * anyway. Consolidating that visit onto the home/already-there manager
 * is strictly better whenever it doesn't push them over the daily cap or
 * break their route feasibility -- there's no tradeoff to weigh, unlike
 * rebalanceWorkload's workload-vs-drive-time judgment calls.
 *
 * hoursByCode is a parameter for the same reason it is in
 * rebalanceWorkload: one source of truth, supplied by the caller. */
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
      // Only a LONE visit to this community counts -- if the visitor has
      // other reasons to already be in the area that day, moving this one
      // stop doesn't simplify anything and may not even be worth the churn.
      if ((stopsByMgr[visitor] || []).length !== visitor_stops.length) continue;

      for (const stop of visitor_stops) {
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
 *
 * Designed for running this module unattended (e.g. via launchd, same
 * mechanism as the existing 6:15am COE sync) rather than only on manual
 * request the way it's been used in every review so far.
 *
 * SCOPE RULE: the background job may only touch the next business day
 * onward -- never today, never a day already in the past, never a
 * weekend. A manager may already be en route to or standing at their
 * first stop of the day by the time any run fires, even the earliest
 * one -- there's no reliable point in "today" where rewriting someone's
 * day doesn't risk contradicting a plan they've already started acting
 * on. Tomorrow onward has no such problem, since nobody has started that
 * day yet no matter when the job runs.
 *
 * This does NOT account for holidays -- nextBusinessDay() only skips
 * Saturday/Sunday. A holiday would need to be caught some other way
 * (e.g. cross-checked against the Time Off base) before this scope check
 * is trusted for a specific date. */
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
 * Created live on the Jobs table (tblqpmwtZ6i4gtogl) 2026-08-07. All four
 * default to unchecked, so this is a no-op on every existing job until
 * someone deliberately locks a specific milestone.
 *
 * Four separate fields rather than one job-level lock because the four
 * milestones are usually reassigned independently already (QAI Manager,
 * QAA Manager, CEL Manager, ACC Manager are already four separate
 * fields), and this table already uses the same one-field-per-milestone
 * pattern elsewhere (QAI Missed / QAA Missed / etc.) -- a single
 * job-wide lock would be coarser than the data model it sits inside.
 *
 * BEHAVIOR: when a milestone's lock is checked, the background job must
 * skip it entirely in every pass -- not a candidate to GIVE a walk away
 * from, not a candidate to RECEIVE one, and not eligible for the
 * flagged-for-review queue either (flagging still implies "the algorithm
 * thinks this should probably move," and a lock means the algorithm
 * shouldn't have an opinion on it at all).
 *
 * Manual (human-run, on-request) optimizer use is unaffected -- a
 * person reviewing a day by hand can still see and discuss a locked
 * walk; the lock only binds the UNATTENDED background pass. */
const LOCK_FIELD_BY_CODE = {
  QAI: "QAI Manager Lock",   // fldsne7dvyrxlTgZR
  QAA: "QAA Manager Lock",   // fldmQqkMm2yseqfXv
  CEL: "CEL Manager Lock",   // fldHIjoRyt3sMlib5
  ACC: "ACC Manager Lock",   // fldpxpjx0rlEStLPn
};

/* stop: { code, locked } -- the caller is responsible for reading the
 * four lock fields off the Jobs record and attaching the right one as
 * `locked` when building the day's stop list; this function doesn't
 * know about Airtable field IDs, it just enforces the rule once told. */
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
  routeFeasible,
  canAddStop,
  homeAffinity,
  rankCandidates,
  rebalanceWorkload,
  findSingleCommunityConsolidations,
  nextBusinessDay,
  isInBackgroundScope,
  isLocked,
  LOCK_FIELD_BY_CODE,
};
