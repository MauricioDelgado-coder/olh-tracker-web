# SOTV3 — Standalone Walk Schedule Optimizer

Complete, self-contained ruleset. Nothing in this document depends on any
other skill's logic. Everything needed to run an optimization pass is here.

## Inputs this tool accepts

Either of:
1. **A date**, if the schedule lives in the Grove Region Airtable base
   (`appYX9df4lGO6G2uz`, Jobs table `tblqpmwtZ6i4gtogl`). Pull walks for that
   date directly.
2. **An uploaded schedule** (xlsx/csv or pasted table) with, at minimum: a
   job/home identifier, community, walk type, date/time, and current manager
   (if any). Work from the uploaded data as given — don't assume it needs to
   match the Airtable field layout exactly; map columns as they're labeled.

Either way, the output and the rules applied are identical. This tool does
not compare its output against any other schedule, tool, or prior run unless
explicitly asked to.

## Constants

- **Daily cap:** 480 min (8h) per manager. No exceptions for any named
  individual — nobody has a reduced cap or a walk-type exclusion unless
  Mauricio states one for that specific run.
- **Walk durations:** QAI = 120 min, CEL = 120 min, QAA = 60 min, ACC = 60
  min.
- **Initial-leg cap:** a manager's first walk of the day must be ≤45 min from
  their home/base location to the walk's community, when that distance data
  is available. This is a soft ceiling, not absolute — see the fallback rule
  below.
- **CEL/ACC walks require a "letter sent" / buyer-facing readiness flag**
  where that field exists in the data; skip walks that don't have it if the
  data model draws that distinction. QAI/QAA have no such requirement.

## Phase 1 — Feasibility

For every walk in scope:
- Drop it if it's marked Closed, archived, or otherwise inactive per whatever
  status field the data provides.
- Check **Lot Status** (Sold / Available / Pending / Reserved / Model /
  Closed / Hold, or equivalent) if present in the data:
  - **QAA and ACC walks on a non-Sold lot are deferral candidates by
    default** — these are buyer-facing milestones and there's no buyer on an
    unsold, on-hold, or pending home. Pull these out of the working set and
    report them separately; don't force an assignment onto them.
  - **QAI walks on a non-Sold lot are a judgment call** — flag but don't
    auto-defer, since QAI is often pre-sale.
- Check time-off / unavailability for every manager on the roster for the
  target date(s); exclude unavailable managers entirely for those dates.

## Phase 2 — Assignment

Process walks grouped by clock time, earliest first. **Any walks that share
an identical clock time on the same day are a group — solve the whole group
together as a one-to-one match, not one walk at a time.** This matters
because processing them independently is exactly how two different walks can
each independently land on the same "best" candidate, producing a
double-booking.

For each clock-time group:
1. Build the candidate pool: every active, available manager not already
   assigned to a *different* walk in this same clock-time group.
2. For each (candidate, walk) pair in the group, compute the drive leg:
   - If this walk would be the candidate's **first** walk of the day so far,
     the leg is `home/base location → walk's community`, and must be ≤45 min
     to remain eligible.
   - If the candidate **already has an earlier walk today**, the leg is
     `that earlier walk's community → this walk's community` — not home.
     Sequence legs across the whole day this way, always chaining from the
     most recent prior stop, never re-measuring from home after the first
     walk.
   - Also check the candidate's running total-minutes-today against the 480
     cap; the walk's duration must fit within remaining capacity to be a
     valid pair, unless Mauricio has explicitly authorized an overload for
     this run.
3. Rank all valid (candidate, walk) pairs in the group by leg minutes,
   ascending. Assign greedily: take the lowest-leg pair, lock in both the
   walk and the manager, remove them from the pool, repeat until every walk
   in the group has a manager or no valid candidates remain.
4. **Tiebreaker when two or more candidates have identical leg minutes:**
   prefer whichever has the lower running total-minutes-today (spreads
   load). If still tied, flag it as a judgment call rather than picking
   silently — name both candidates and ask, or hold the walk open.
5. **Fallback when every remaining candidate fails the 45-min initial-leg
   cap:** do not auto-relax the cap and do not silently leave it unresolved.
   Surface the full ranked candidate list (closest-first, with their leg
   minutes) and let Mauricio choose. Never invent a relaxed cap on your own.

After the timed (CEL/ACC-style) walks are placed, fill any untimed
(QAI/QAA-style) walks using this priority order:
1. **Same-community, already-working manager first.** If a manager is
   already assigned a timed walk in this walk's community today, route the
   untimed walk to them before considering anyone else — it's a zero-leg
   add-on to a trip they're already making, as long as it fits their
   remaining cap.
2. If a community has no already-working manager, or the community's total
   untimed volume exceeds what the already-working manager(s) can absorb,
   fall back to fresh drive-time matching per the ranking method above,
   scoped to whichever managers still have capacity.
3. When a single community's volume badly outstrips nearby capacity, group
   it with its geographic neighbors (communities within roughly 40 minutes
   drive of each other cluster together; a 60+ minute gap marks a cluster
   boundary) and solve the cluster's overflow as a batch — pull in the
   next-nearest manager with zero walks yet today rather than force-loading
   the one or two people already on-site.

## Phase 3 — Rebalance

After every walk has either a manager or a deliberate flag:
- Recompute every manager's daily total. Anyone over 480 min is only
  acceptable if Mauricio explicitly authorized it for this run — state the
  exact over-cap number plainly (e.g. "540/480, 60 over") rather than
  burying it.
- Run a **duplicate-booking check**: no manager should show two different
  walks at the identical clock time. Report this check's result explicitly
  before presenting the final schedule, whether or not it found anything.
- Where a manager ends up over cap and another manager has open room nearby,
  consider a **cap-neutral swap**: give the overloaded manager a walk equal
  in minutes to one you move off them, and give the freed-up walk to whoever
  has capacity. Verify both sides land exactly where the math says before
  calling it resolved.
- CCR/support-staff style roles (any roster member outside the core QAM
  list, if the data distinguishes them) are legitimate overflow candidates
  for leftover CEL/ACC walks — check their current-period workload and
  proximity before parking a walk as permanently unresolved.

## Never do this

- Never move a walk's **date or time slot** to resolve a conflict — only the
  assigned manager may change. If asked to override this for one specific
  walk, treat it as a named, one-time exception and do not carry it forward
  as a new default for the rest of the run.
- Never silently relax the 45-min initial-leg cap, invent a tiebreaker
  preference, or accept an overload without being told to for that specific
  case.
- Never compare this run's output against any other tool's schedule unless
  explicitly asked to.

## Output format

- **Manager Name** on its own line, then each walk as a `-Walk` bullet
  underneath.
- Only state the cap number if it's reduced from standard or if the manager
  is over/under cap in a way worth flagging — state the exact number (e.g.
  "60 min over").
- Include each manager's distinct community count and an estimated total
  drive-time figure; label the drive-time figure as an estimate if it's
  built from leg-by-leg data rather than a full route calculation.
- Convert all displayed times to the relevant local time zone if the source
  data is stored in UTC or another zone.
- List any unresolved or deferred walks separately at the end, with the
  reason each one is unresolved (cap fallback, lot status deferral,
  time-off conflict, etc.).
