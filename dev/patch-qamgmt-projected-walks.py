#!/usr/bin/env python3
"""
Show projected QAI/QAA walks on the QA Management day view.

qa-management.html is a design export whose logic lives escaped inside a
bundler template, so this patches the escaped text rather than real JS. The
same four substitutions are registered in dev/build-live-pages.js so a
re-export replays them instead of silently dropping the behaviour.

Idempotent: re-running detects the marker and exits without touching the file.
"""
import os, sys, shutil, datetime

PATH = os.path.expanduser("~/olh-tracker-web/public/qa-management.html")
MARKER = "projectedWalkDate"

SUBS = [
    # 1. the helper itself, anchored on ORDER
    (
        r"const ORDER = {QAI:0, QAA:1, CEL:2, ACC:3};",
        r"const ORDER = {QAI:0, QAA:1, CEL:2, ACC:3};\n"
        r"/* A QAI/QAA date CALCULATED from Projected Completion, used only when the\n"
        r"   Airtable cell is blank -- the identical rule tracker.html's calcDate()\n"
        r"   renders in blue and game.html's reassignment board schedules against:\n"
        r"   QAI = PCD - 7, QAA = PCD. Not weekend-adjusted, deliberately: the\n"
        r"   tracker's blue date isn't either, and shifting it here would make the\n"
        r"   two pages disagree about the same walk.\n"
        r"\n"
        r"   CEL/ACC are never projected -- they come from the scheduler with a real\n"
        r"   manager and clock time attached.\n"
        r"\n"
        r"   Returns null once the home has an Actual COE or the walk is already\n"
        r"   marked complete: a projection describes work still to come, never a\n"
        r"   backfill of history. */\n"
        r"const PROJ_DONE = {QAI:'QAI Complete', QAA:'QAA Accepted'};\n"
        r"function projectedWalkDate(f, code){\n"
        r"  if(code !== 'QAI' && code !== 'QAA') return null;\n"
        r"  if(f['Actual COE Date']) return null;\n"
        r"  if(f[PROJ_DONE[code]]) return null;\n"
        r"  const pcd = f['Projected Completion Date'];\n"
        r"  if(!pcd) return null;\n"
        r"  const p = String(pcd).slice(0,10).split('-');\n"
        r"  if(p.length !== 3) return null;\n"
        r"  const d = new Date(+p[0], +p[1]-1, +p[2]);\n"
        r"  if(isNaN(d.getTime())) return null;\n"
        r"  if(code === 'QAI') d.setDate(d.getDate()-7);\n"
        r"  return key(d);\n"
        r"}",
    ),
    # 2. dayWalks() falls back to the projection
    (
        r"        const raw = f[w.date];\n        if(!raw || isoDay(raw) !== day) return;",
        r"        let raw = f[w.date];\n"
        r"        let projected = false;\n"
        r"        if(!raw){\n"
        r"          raw = projectedWalkDate(f, w.code);\n"
        r"          if(!raw) return;\n"
        r"          projected = true;\n"
        r"        }\n"
        r"        if(isoDay(raw) !== day) return;",
    ),
    # 3. carry the flag onto the row
    (
        r"          raw: raw, sortTime: rawD ? rawD.getTime() : 0,",
        r"          raw: raw, projected: projected, sortTime: rawD ? rawD.getTime() : 0,",
    ),
    # 4. completing a projected walk must write its date too
    (
        r"        rec.fields[w.spec.done] = true;\n"
        r"        done++;\n"
        r"        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.done,\n"
        r"          label:w.spec.label + ' completed', from:'No', to:'Yes', action:'edit',\n"
        r"          patch:{[w.spec.done]:true}});",
        r"        rec.fields[w.spec.done] = true;\n"
        r"        done++;\n"
        r"        /* A projected walk has no date in Airtable. Setting the done flag\n"
        r"           against a blank date cell would be silent data loss: projectedWalkDate()\n"
        r"           suppresses a completed walk, so it would vanish from every page with\n"
        r"           no date ever recorded. Write the calculated date alongside. */\n"
        r"        const donePatch = {[w.spec.done]:true};\n"
        r"        if(w.projected){ donePatch[w.spec.date] = w.raw; rec.fields[w.spec.date] = w.raw; }\n"
        r"        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.done,\n"
        r"          label:w.spec.label + ' completed', from:'No', to:'Yes', action:'edit',\n"
        r"          patch:donePatch});",
    ),
    # 5. same for a missed projected walk -- the Walk Miss Log stamps missedDate
    #    from w.raw, so the record must actually carry that date.
    (
        r"        if(note) miss[w.spec.code + ' Miss Note'] = note;\n"
        r"        rec.fields[w.spec.code + ' Missed'] = true;",
        r"        if(note) miss[w.spec.code + ' Miss Note'] = note;\n"
        r"        /* Same reason as the completion path above -- and the Walk Miss Log\n"
        r"           entry stamps missedDate from w.raw, so the record has to actually\n"
        r"           carry that date or the log points at a date the job never had. */\n"
        r"        if(w.projected){ miss[w.spec.date] = w.raw; rec.fields[w.spec.date] = w.raw; }\n"
        r"        rec.fields[w.spec.code + ' Missed'] = true;",
    ),
    # 6. Say so on the row. The Walk Manager cell already reads "Unassigned" in
    #    red for a projected walk (no manager link), and this makes the time
    #    column explicit rather than showing the usual untimed "All day" -- so
    #    nobody marks a calculated date "missed" as though it were a commitment.
    (
        r"        time: clockOf(w.raw),",
        r"        time: w.projected ? 'Projected' : clockOf(w.raw),",
    ),
]


def main():
    if not os.path.exists(PATH):
        sys.exit("not found: %s" % PATH)
    src = open(PATH, encoding="utf-8").read()

    if MARKER in src:
        print("already patched (found %r) -- nothing to do" % MARKER)
        return

    out = src
    for i, (old, new) in enumerate(SUBS, 1):
        n = out.count(old)
        if n != 1:
            sys.exit("substitution %d matched %d times, expected exactly 1.\n"
                     "The export probably reflowed. Anchor:\n%s" % (i, n, old[:200]))
        out = out.replace(old, new)
        print("  [%d/%d] ok" % (i, len(SUBS)))

    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    bak = PATH + ".bak-projectedqa-" + stamp
    shutil.copy2(PATH, bak)
    open(PATH, "w", encoding="utf-8").write(out)
    print("\npatched %s" % PATH)
    print("backup  %s" % bak)


if __name__ == "__main__":
    main()
