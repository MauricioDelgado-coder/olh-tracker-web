#!/usr/bin/env node
/**
 * Rework scheduler.html's CEL/ACC date-suggestion logic to anchor off the
 * Scheduled Closing Date instead of QAA/CEL-relative gaps, plus:
 *   - short-turn detection (red CEL/ACC dates + confirm-to-save when the
 *     final gap between them is under 5 calendar days)
 *   - click-to-edit on the CEL/ACC stage boxes, with a custom-date field
 *     that regenerates ranked options from whatever date is typed in
 *   - hard blocks (suggestions, manual entry, and the commit path itself)
 *     against any CEL/ACC date before Projected Completion or on/after
 *     Scheduled Closing
 *
 * Same decode/replace/re-encode/round-trip-validate pattern as
 * dev/fix-scheduler-optimistic-update.js and dev/add-completion-multiselect.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'scheduler.html');

function decodeTemplateLine(html) {
  const tagOpen = '<script type="__bundler/template">';
  const idx = html.indexOf(tagOpen);
  if (idx === -1) throw new Error('no __bundler/template tag found');
  let prefixEnd = idx + tagOpen.length;
  if (html[prefixEnd] === '\n') prefixEnd += 1;
  const lineEnd = html.indexOf('\n', prefixEnd);
  const lineTail = lineEnd === -1 ? html.length : lineEnd;
  const suffix = '</script>';
  const jsonStr = html.slice(prefixEnd, lineTail - suffix.length);
  return { idx, prefixEnd, lineTail, suffix, jsonStr, template: JSON.parse(jsonStr) };
}

function replaceOnce(str, from, to, label) {
  const fromCount = str.split(from).length - 1;
  if (fromCount === 1) return str.split(from).join(to);
  const toCount = str.split(to).length - 1;
  if (fromCount === 0 && toCount === 1) {
    console.log('  [' + label + '] already applied, skipping');
    return str;
  }
  throw new Error('expected exactly 1 occurrence of [' + label + '], found ' + fromCount +
    ' (and ' + toCount + ' of the replacement already present)');
}

const html = fs.readFileSync(FILE, 'utf8');
const { prefixEnd, lineTail, suffix, template } = decodeTemplateLine(html);
let tpl = template;

// ---------------------------------------------------------------------------
// 1. New date-math helpers, inserted right after earliestAfter().
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  'function earliestAfter(prior, gap) {\n' +
  '  let d = adjustWeekend(addDays(prior, gap));\n' +
  '  while (d.getTime() <= prior.getTime() || isWeekend(d)) d = addDays(d, 1);\n' +
  '  return d;\n' +
  '}\n' +
  '\n' +
  'const JOB_LINK = function(job){',

  'function earliestAfter(prior, gap) {\n' +
  '  let d = adjustWeekend(addDays(prior, gap));\n' +
  '  while (d.getTime() <= prior.getTime() || isWeekend(d)) d = addDays(d, 1);\n' +
  '  return d;\n' +
  '}\n' +
  '\n' +
  '/* Step backward from `d` skipping weekends until `n` business days have\n' +
  '   been crossed. Used to anchor ACC one business day before the Scheduled\n' +
  '   Closing Date. */\n' +
  'function businessDaysBefore(d, n) {\n' +
  '  let x = new Date(d), left = n;\n' +
  '  while (left > 0) { x = addDays(x, -1); if (!isWeekend(x)) left--; }\n' +
  '  return x;\n' +
  '}\n' +
  '\n' +
  '/* CEL anchors 5-6 calendar days before ACC. 5 and 6 days back from any\n' +
  '   weekday land on a weekday too, EXCEPT when ACC itself is a Friday (5\n' +
  '   back = Sunday, 6 back = Saturday) -- so keep stepping back a day at a\n' +
  '   time until a weekday turns up, which only ever reaches for a 7th day. */\n' +
  'function celAnchorFromAcc(acc) {\n' +
  '  for (let delta = 5; delta <= 9; delta++) {\n' +
  '    const d = addDays(acc, -delta);\n' +
  '    if (!isWeekend(d)) return d;\n' +
  '  }\n' +
  '  return addDays(acc, -5);\n' +
  '}\n' +
  '\n' +
  '/* Closing-date-driven CEL/ACC suggestion (2026-08). ACC = 1 business day\n' +
  '   before Scheduled Closing. CEL = 5-6 calendar days before ACC, UNLESS\n' +
  '   that date would land on or before QAA -- meaning the QAA-to-ACC gap is\n' +
  '   too tight for the normal CEL-to-ACC spacing (a short-turn job) -- in\n' +
  '   which case CEL falls back to the next business day after QAA instead,\n' +
  '   same as the old QAA-relative rule. Returns { acc, cel, shortTurn };\n' +
  '   acc/cel are null when there is no Scheduled Closing Date to anchor\n' +
  '   from. */\n' +
  'function suggestedCelAcc(h) {\n' +
  '  if (!h.close) return { acc: null, cel: null, shortTurn: false };\n' +
  '  const acc = businessDaysBefore(h.close, 1);\n' +
  '  let cel = celAnchorFromAcc(acc);\n' +
  '  let shortTurn = false;\n' +
  '  if (h.qaa && cel.getTime() <= h.qaa.getTime()) {\n' +
  '    cel = earliestAfter(h.qaa, 1);\n' +
  '    shortTurn = true;\n' +
  '  }\n' +
  '  return { acc, cel, shortTurn };\n' +
  '}\n' +
  '\n' +
  'const JOB_LINK = function(job){',
  'date-math helpers');

// ---------------------------------------------------------------------------
// 2. findOptions: take the homesite (for pcd/close bounds) instead of just
//    the community string, and enforce those bounds while walking days.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '  findOptions(code, earliest, continuityId, community) {\n' +
  '    const bk = this.bookings();\n' +
  '    const hours = HOURS[code];\n' +
  '    const cont = this.person(continuityId);\n' +
  '    const groups = [\n' +
  '      cont && cont.role === "QAM" ? [cont] : [],\n' +
  '      this.qams().filter(m => m.id !== continuityId)\n' +
  '    ].filter(g => g.length);\n' +
  '    let day = earliest.getTime() > TODAY.getTime() ? new Date(earliest) : new Date(TODAY);\n' +
  '    const out = [];\n' +
  '    for (let n = 0; n < 30 && out.length < 4; n++) {\n' +
  '      if (!isWeekend(day)) {\n' +
  '        const k = key(day);\n' +
  '        for (const slot of SLOTS) {\n' +
  '          if (out.length >= 4) break;\n' +
  '          let chosen = null;\n' +
  '          for (const g of groups) {\n' +
  '            const avail = g.filter(p => !this.isOff(p.id, k, slot) &&\n' +
  '              this.dayHours(p.id, k, bk) + hours <= DAILY_CAP && !this.slotTaken(p.id, k, slot, bk));\n' +
  '            if (!avail.length) continue;\n' +
  '            chosen = avail.length === 1 ? avail[0] : this.rank(avail, k, community, bk)[0];\n' +
  '            break;\n' +
  '          }\n' +
  '          if (chosen) out.push({\n' +
  '            date: new Date(day), slot, person: chosen,\n' +
  '            primary: chosen.id === continuityId,\n' +
  '            reason: this.reason(chosen, continuityId, k, community, bk)\n' +
  '          });\n' +
  '        }\n' +
  '      }\n' +
  '      day = addDays(day, 1);\n' +
  '    }\n' +
  '    return out;\n' +
  '  }',

  '  findOptions(code, earliest, continuityId, h) {\n' +
  '    const community = h.community;\n' +
  '    const bk = this.bookings();\n' +
  '    const hours = HOURS[code];\n' +
  '    const cont = this.person(continuityId);\n' +
  '    const groups = [\n' +
  '      cont && cont.role === "QAM" ? [cont] : [],\n' +
  '      this.qams().filter(m => m.id !== continuityId)\n' +
  '    ].filter(g => g.length);\n' +
  '    /* Hard bounds: never offer a slot before Projected Completion or\n' +
  '       on/after Scheduled Closing. */\n' +
  '    const floor = h.pcd && h.pcd.getTime() > TODAY.getTime() ? h.pcd : TODAY;\n' +
  '    let day = earliest.getTime() > floor.getTime() ? new Date(earliest) : new Date(floor);\n' +
  '    const out = [];\n' +
  '    for (let n = 0; n < 30 && out.length < 4; n++) {\n' +
  '      if (h.close && day.getTime() >= h.close.getTime()) break;\n' +
  '      if (!isWeekend(day)) {\n' +
  '        const k = key(day);\n' +
  '        for (const slot of SLOTS) {\n' +
  '          if (out.length >= 4) break;\n' +
  '          let chosen = null;\n' +
  '          for (const g of groups) {\n' +
  '            const avail = g.filter(p => !this.isOff(p.id, k, slot) &&\n' +
  '              this.dayHours(p.id, k, bk) + hours <= DAILY_CAP && !this.slotTaken(p.id, k, slot, bk));\n' +
  '            if (!avail.length) continue;\n' +
  '            chosen = avail.length === 1 ? avail[0] : this.rank(avail, k, community, bk)[0];\n' +
  '            break;\n' +
  '          }\n' +
  '          if (chosen) out.push({\n' +
  '            date: new Date(day), slot, person: chosen,\n' +
  '            primary: chosen.id === continuityId,\n' +
  '            reason: this.reason(chosen, continuityId, k, community, bk)\n' +
  '          });\n' +
  '        }\n' +
  '      }\n' +
  '      day = addDays(day, 1);\n' +
  '    }\n' +
  '    return out;\n' +
  '  }',
  'findOptions bounds');

// ---------------------------------------------------------------------------
// 3. openStep: anchor off the new suggestedCelAcc() instead of the old
//    QAA/CEL-relative earliestAfter() call, clamp to pcd, reset customAnchor.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '  openStep(code, h) {\n' +
  '    const a = this.planFor(h.job);\n' +
  '    const prior = code === "CEL" ? h.qaa : (a.CEL ? parseKey(a.CEL.date) : h.cel);\n' +
  '    const earliest = earliestAfter(prior, code === "CEL" ? 1 : 5);\n' +
  '    const start = earliest.getTime() > TODAY.getTime() ? earliest : TODAY;\n' +
  '    this.setState({ step: code, mDate: key(start), mSlot: SLOTS[0], mWarn: "" });\n' +
  '  }',

  '  openStep(code, h) {\n' +
  '    const sug = suggestedCelAcc(h);\n' +
  '    let anchor = code === "CEL" ? sug.cel : sug.acc;\n' +
  '    if (!anchor) {\n' +
  '      // No Scheduled Closing Date to anchor from -- fall back to the old\n' +
  '      // QAA/CEL-relative gap so the tool still offers something.\n' +
  '      const a = this.planFor(h.job);\n' +
  '      const prior = code === "CEL" ? h.qaa : (a.CEL ? parseKey(a.CEL.date) : h.cel);\n' +
  '      anchor = earliestAfter(prior, code === "CEL" ? 1 : 5);\n' +
  '    }\n' +
  '    if (h.pcd && anchor.getTime() < h.pcd.getTime()) anchor = new Date(h.pcd);\n' +
  '    const start = anchor.getTime() > TODAY.getTime() ? anchor : TODAY;\n' +
  '    this.setState({ step: code, customAnchor: "", mDate: key(start), mSlot: SLOTS[0], mWarn: "" });\n' +
  '  }',
  'openStep anchor');

// ---------------------------------------------------------------------------
// 4. pick(): hard guard at the actual commit chokepoint, belt-and-suspenders
//    on top of findOptions/manual() already refusing out-of-bounds dates.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '  pick(code, h, date, slot, personId) {\n' +
  '    const a = Object.assign({}, this.state.draft[h.job] || {});\n' +
  '    a[code] = { date: key(date), slot, personId, community: h.community };\n' +
  '    if (code === "CEL") delete a.ACC;\n' +
  '    const next = Object.assign({}, this.state.draft);\n' +
  '    next[h.job] = a;\n' +
  '    this.setState({ draft: next, step: null, mWarn: "" }, () => {\n' +
  '      if (code === "CEL") this.openStep("ACC", h);\n' +
  '    });\n' +
  '  }',

  '  pick(code, h, date, slot, personId) {\n' +
  '    if (h.pcd && date.getTime() < h.pcd.getTime()) {\n' +
  '      this.setState({ mWarn: code + " can\'t be scheduled before the projected completion date." }); return;\n' +
  '    }\n' +
  '    if (h.close && date.getTime() >= h.close.getTime()) {\n' +
  '      this.setState({ mWarn: code + " can\'t be scheduled on or after the scheduled closing date." }); return;\n' +
  '    }\n' +
  '    const a = Object.assign({}, this.state.draft[h.job] || {});\n' +
  '    a[code] = { date: key(date), slot, personId, community: h.community };\n' +
  '    if (code === "CEL") delete a.ACC;\n' +
  '    const next = Object.assign({}, this.state.draft);\n' +
  '    next[h.job] = a;\n' +
  '    this.setState({ draft: next, step: null, mWarn: "" }, () => {\n' +
  '      if (code === "CEL") this.openStep("ACC", h);\n' +
  '    });\n' +
  '  }',
  'pick hard guard');

// ---------------------------------------------------------------------------
// 5. manual(): add pcd/close checks alongside the existing prior/weekend/
//    past-today checks.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    if (prior && d.getTime() <= prior.getTime()) {\n' +
  '      this.setState({ mWarn: code + " must fall after the prior walk on " + fmt(prior) + "." }); return;\n' +
  '    }\n' +
  '    if (isWeekend(d)) { this.setState({ mWarn: "Walks are weekdays only." }); return; }',

  '    if (prior && d.getTime() <= prior.getTime()) {\n' +
  '      this.setState({ mWarn: code + " must fall after the prior walk on " + fmt(prior) + "." }); return;\n' +
  '    }\n' +
  '    if (h.pcd && d.getTime() < h.pcd.getTime()) {\n' +
  '      this.setState({ mWarn: code + " can\'t be scheduled before the projected completion date (" + fmt(h.pcd) + ")." }); return;\n' +
  '    }\n' +
  '    if (h.close && d.getTime() >= h.close.getTime()) {\n' +
  '      this.setState({ mWarn: code + " can\'t be scheduled on or after the scheduled closing date (" + fmt(h.close) + ")." }); return;\n' +
  '    }\n' +
  '    if (isWeekend(d)) { this.setState({ mWarn: "Walks are weekdays only." }); return; }',
  'manual pcd/close checks');

// ---------------------------------------------------------------------------
// 6. State defaults: track a custom scheduling anchor and the short-turn
//    save confirmation.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    assignments: {}, draft: {}, timeOff: [],\n' +
  '    mDate: "2026-08-05", mSlot: SLOTS[0], mPerson: "", mWarn: "",\n' +
  '    showRules: false,\n' +
  '    saving: false, celSaving: false, resetting: false, confirmingReset: false,',

  '    assignments: {}, draft: {}, timeOff: [],\n' +
  '    mDate: "2026-08-05", mSlot: SLOTS[0], mPerson: "", mWarn: "",\n' +
  '    customAnchor: "",\n' +
  '    showRules: false,\n' +
  '    saving: false, celSaving: false, resetting: false, confirmingReset: false, confirmingShortTurn: false,',
  'state defaults');

// ---------------------------------------------------------------------------
// 7. Homesite list onClick: clear the new state too when switching homesites.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '        onClick: () => this.setState({ selected: h.id, step: null, mWarn: "", confirmingReset: false })',
  '        onClick: () => this.setState({ selected: h.id, step: null, mWarn: "", confirmingReset: false, confirmingShortTurn: false, customAnchor: "" })',
  'homesite list onClick reset');

// ---------------------------------------------------------------------------
// 8. Milestone flags: pcd violations are hard errors now, not warnings, and
//    ACC is checked against pcd too (previously only CEL was).
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      if (sel.pcd && cel && cel.getTime() < sel.pcd.getTime()) flags.pcd = { tone: "warn", note: "CEL precedes projected completion" };',

  '      if (sel.pcd && cel && cel.getTime() < sel.pcd.getTime()) flags.pcd = { tone: "error", note: "CEL precedes projected completion \\u2014 not allowed" };\n' +
  '      if (sel.pcd && acc && acc.getTime() < sel.pcd.getTime()) flags.pcd = { tone: "error", note: "ACC precedes projected completion \\u2014 not allowed" };',
  'pcd flag tone');

// ---------------------------------------------------------------------------
// 9. Stages: detect short-turn (CEL/ACC gap under 5 calendar days), color
//    those two dates red, and make CEL/ACC boxes clickable to reopen
//    scheduling for that specific walk (QAI/QAA stay fixed/non-clickable;
//    CEL locks once its letter has been sent, matching the existing Reset
//    lock).
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    let stages = [], canStart = false, startLabel = "", booked = null;\n' +
  '    if (sel) {\n' +
  '      const rows = [\n' +
  '        { code: "QAI", date: sel.qai, who: "Generated upstream", fixed: true },\n' +
  '        { code: "QAA", date: sel.qaa, who: "Generated upstream \\u00b7 QAI + 7 days", fixed: true },\n' +
  '        { code: "CEL", date: selA.CEL ? parseKey(selA.CEL.date) : sel.cel, slot: selA.CEL ? selA.CEL.slot : this.slotOf(sel.celTime), pid: selA.CEL && selA.CEL.personId },\n' +
  '        { code: "ACC", date: selA.ACC ? parseKey(selA.ACC.date) : sel.acc, slot: selA.ACC ? selA.ACC.slot : this.slotOf(sel.accTime), pid: selA.ACC && selA.ACC.personId }\n' +
  '      ];\n' +
  '      stages = rows.map(r => {\n' +
  '        const p = r.pid ? this.person(r.pid) : null;\n' +
  '        return {\n' +
  '          code: r.code,\n' +
  '          pillBg: r.date ? CODE_COLOR[r.code] : "#F1EBE1",\n' +
  '          pillColor: r.date ? "#fff" : "#908A82",\n' +
  '          bg: r.date ? "#fff" : "#FCFAF6",\n' +
  '          date: r.date ? fmt(r.date) : "Not scheduled",\n' +
  '          dateColor: r.date ? "#303030" : "#908A82",\n' +
  '          who: r.fixed ? r.who : p ? (r.slot ? r.slot + " \\u00b7 " : "") + p.name + (p.role === "CCR" ? " (CCR)" : "")\n' +
  '            : r.date ? (r.slot || "On record, manager not set") : "\\u2014"\n' +
  '        };\n' +
  '      });\n' +
  '      canStart = !(selA.CEL && selA.ACC);\n' +
  '      startLabel = (selA.CEL || sel.cel) ? "Schedule Acceptance Walk" : "Schedule Walks";',

  '    let stages = [], canStart = false, startLabel = "", booked = null, isShortTurn = false;\n' +
  '    if (sel) {\n' +
  '      const celDateFinal = selA.CEL ? parseKey(selA.CEL.date) : sel.cel;\n' +
  '      const accDateFinal = selA.ACC ? parseKey(selA.ACC.date) : sel.acc;\n' +
  '      /* Flag (not block) anything already scheduled with less than 5\n' +
  '         calendar days between CEL and ACC -- Save gates on this via\n' +
  '         confirmingShortTurn below. */\n' +
  '      isShortTurn = !!(celDateFinal && accDateFinal &&\n' +
  '        Math.round((accDateFinal.getTime() - celDateFinal.getTime()) / 86400000) < 5);\n' +
  '      const rows = [\n' +
  '        { code: "QAI", date: sel.qai, who: "Generated upstream", fixed: true },\n' +
  '        { code: "QAA", date: sel.qaa, who: "Generated upstream \\u00b7 QAI + 7 days", fixed: true },\n' +
  '        { code: "CEL", date: celDateFinal, slot: selA.CEL ? selA.CEL.slot : this.slotOf(sel.celTime), pid: selA.CEL && selA.CEL.personId },\n' +
  '        { code: "ACC", date: accDateFinal, slot: selA.ACC ? selA.ACC.slot : this.slotOf(sel.accTime), pid: selA.ACC && selA.ACC.personId }\n' +
  '      ];\n' +
  '      stages = rows.map(r => {\n' +
  '        const p = r.pid ? this.person(r.pid) : null;\n' +
  '        const editable = !r.fixed && !(r.code === "CEL" && sel.celLetterSent);\n' +
  '        const redDate = isShortTurn && (r.code === "CEL" || r.code === "ACC");\n' +
  '        return {\n' +
  '          code: r.code,\n' +
  '          pillBg: r.date ? CODE_COLOR[r.code] : "#F1EBE1",\n' +
  '          pillColor: r.date ? "#fff" : "#908A82",\n' +
  '          bg: r.date ? "#fff" : "#FCFAF6",\n' +
  '          date: r.date ? fmt(r.date) : "Not scheduled",\n' +
  '          dateColor: redDate ? "#AA1F23" : (r.date ? "#303030" : "#908A82"),\n' +
  '          who: (r.fixed ? r.who : p ? (r.slot ? r.slot + " \\u00b7 " : "") + p.name + (p.role === "CCR" ? " (CCR)" : "")\n' +
  '            : r.date ? (r.slot || "On record, manager not set") : "\\u2014") + (redDate ? " \\u00b7 short turn" : ""),\n' +
  '          onClick: editable ? () => this.openStep(r.code, sel) : () => {},\n' +
  '          cursor: editable ? "pointer" : "default"\n' +
  '        };\n' +
  '      });\n' +
  '      canStart = !(selA.CEL && selA.ACC);\n' +
  '      startLabel = (selA.CEL || sel.cel) ? "Schedule Acceptance Walk" : "Schedule Walks";',
  'stages short-turn + click-to-edit');

// ---------------------------------------------------------------------------
// 10. Step panel: anchor from suggestedCelAcc()/customAnchor instead of the
//     old QAA-relative earliestAfter(), pass the homesite into findOptions,
//     and expose a custom-date field.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    let step = null;\n' +
  '    if (sel && s.step) {\n' +
  '      const code = s.step;\n' +
  '      const prior = code === "CEL" ? sel.qaa : (selA.CEL ? parseKey(selA.CEL.date) : sel.cel);\n' +
  '      const earliest = earliestAfter(prior, code === "CEL" ? 1 : 5);\n' +
  '      const contId = this.continuityFor(code, sel);\n' +
  '      const opts = this.findOptions(code, earliest, contId, sel.community);\n' +
  '      const contName = contId ? (this.person(contId) || {}).name : null;\n' +
  '      const overdue = earliest.getTime() < TODAY.getTime();\n' +
  '      step = {\n' +
  '        title: code === "CEL" ? "Celebration Walk Options" : "Acceptance Walk Options",\n' +
  '        sub: "Earliest eligible " + fmt(earliest) +\n' +
  '          (overdue ? " \\u2014 past due, searching from " + fmt(TODAY) : "") + " \\u00b7 " +\n' +
  '          (contName ? "continuity " + contName\n' +
  '            : sel.community ? "no home QA Manager for " + sel.community + ", nearest QAM offered"\n' +
  '            : "community not in the mapping index \\u2014 scheduled unanchored, ranked purely by workload"),\n' +
  '        none: opts.length === 0,\n' +
  '        options: opts.map(o => ({\n' +
  '          date: fmt(o.date), slot: o.slot, person: o.person.name,\n' +
  '          tag: o.primary ? "CONTINUITY" : "OVERFLOW",\n' +
  '          tagBg: o.primary ? "#EAF2F9" : "#F1EBE1",\n' +
  '          tagColor: o.primary ? "#005DAA" : "#6F6963",\n' +
  '          border: o.primary ? "#CFE2F1" : "#E4DED2",\n' +
  '          reason: o.reason,\n' +
  '          onPick: () => this.pick(code, sel, o.date, o.slot, o.person.id)\n' +
  '        }))\n' +
  '      };\n' +
  '    }',

  '    let step = null;\n' +
  '    if (sel && s.step) {\n' +
  '      const code = s.step;\n' +
  '      const sug = suggestedCelAcc(sel);\n' +
  '      let anchor = code === "CEL" ? sug.cel : sug.acc;\n' +
  '      if (!anchor) {\n' +
  '        const prior = code === "CEL" ? sel.qaa : (selA.CEL ? parseKey(selA.CEL.date) : sel.cel);\n' +
  '        anchor = earliestAfter(prior, code === "CEL" ? 1 : 5);\n' +
  '      }\n' +
  '      if (sel.pcd && anchor.getTime() < sel.pcd.getTime()) anchor = new Date(sel.pcd);\n' +
  '      const custom = s.customAnchor ? parseKey(s.customAnchor) : null;\n' +
  '      const earliest = custom || anchor;\n' +
  '      const contId = this.continuityFor(code, sel);\n' +
  '      const opts = this.findOptions(code, earliest, contId, sel);\n' +
  '      const contName = contId ? (this.person(contId) || {}).name : null;\n' +
  '      const overdue = earliest.getTime() < TODAY.getTime();\n' +
  '      const pastClosing = !!(sel.close && earliest.getTime() > sel.close.getTime());\n' +
  '      const anchorNote = custom ? "Custom date " + fmt(earliest)\n' +
  '        : code === "ACC" ? "1 business day before Scheduled Closing \\u2014 " + fmt(earliest)\n' +
  '        : sug.shortTurn ? "Short turn \\u2014 next business day after QAA \\u2014 " + fmt(earliest)\n' +
  '        : sug.acc ? "5\\u20136 days before ACC \\u2014 " + fmt(earliest)\n' +
  '        : "Earliest eligible " + fmt(earliest);\n' +
  '      step = {\n' +
  '        title: code === "CEL" ? "Celebration Walk Options" : "Acceptance Walk Options",\n' +
  '        sub: anchorNote +\n' +
  '          (overdue ? " \\u2014 past due, searching from " + fmt(TODAY) : "") +\n' +
  '          (pastClosing ? " \\u2014 past Scheduled Closing, review before proceeding" : "") + " \\u00b7 " +\n' +
  '          (contName ? "continuity " + contName\n' +
  '            : sel.community ? "no home QA Manager for " + sel.community + ", nearest QAM offered"\n' +
  '            : "community not in the mapping index \\u2014 scheduled unanchored, ranked purely by workload"),\n' +
  '        customDate: s.customAnchor || key(anchor),\n' +
  '        onCustomDate: e => this.setState({ customAnchor: e.target.value }),\n' +
  '        none: opts.length === 0,\n' +
  '        options: opts.map(o => ({\n' +
  '          date: fmt(o.date), slot: o.slot, person: o.person.name,\n' +
  '          tag: o.primary ? "CONTINUITY" : "OVERFLOW",\n' +
  '          tagBg: o.primary ? "#EAF2F9" : "#F1EBE1",\n' +
  '          tagColor: o.primary ? "#005DAA" : "#6F6963",\n' +
  '          border: o.primary ? "#CFE2F1" : "#E4DED2",\n' +
  '          reason: o.reason,\n' +
  '          onPick: () => this.pick(code, sel, o.date, o.slot, o.person.id)\n' +
  '        }))\n' +
  '      };\n' +
  '    }',
  'step panel anchor + custom date');

// ---------------------------------------------------------------------------
// 11. onSave: gate on short-turn confirmation before committing.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      onSave: () => {\n' +
  '        if (!sel || !unsaved || s.saving) return;\n' +
  '        if (!this.can("walk.schedule")) { this.setState({ denied: window.OLHAuth.denyReason("walk.schedule") }); return; }\n' +
  '        this._commitPlan(sel, selDraft);\n' +
  '      },',

  '      onSave: () => {\n' +
  '        if (!sel || !unsaved || s.saving) return;\n' +
  '        if (!this.can("walk.schedule")) { this.setState({ denied: window.OLHAuth.denyReason("walk.schedule") }); return; }\n' +
  '        if (isShortTurn && !s.confirmingShortTurn) { this.setState({ confirmingShortTurn: true }); return; }\n' +
  '        if (s.confirmingShortTurn) this.setState({ confirmingShortTurn: false });\n' +
  '        this._commitPlan(sel, selDraft);\n' +
  '      },',
  'onSave short-turn gate');

// ---------------------------------------------------------------------------
// 12. Wire the short-turn confirm/cancel handlers into the returned object,
//     right next to the existing Reset confirmation.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      onCancelReset: () => this.setState({ confirmingReset: false }),\n' +
  '      onConfirmReset: () => {\n' +
  '        this.setState({ confirmingReset: false });\n' +
  '        if (sel) this.resetWalks(sel);\n' +
  '      },\n' +
  '      step, booked,',

  '      onCancelReset: () => this.setState({ confirmingReset: false }),\n' +
  '      onConfirmReset: () => {\n' +
  '        this.setState({ confirmingReset: false });\n' +
  '        if (sel) this.resetWalks(sel);\n' +
  '      },\n' +
  '      confirmingShortTurn: s.confirmingShortTurn,\n' +
  '      onCancelShortTurnSave: () => this.setState({ confirmingShortTurn: false }),\n' +
  '      onConfirmShortTurnSave: () => {\n' +
  '        this.setState({ confirmingShortTurn: false });\n' +
  '        this._commitPlan(sel, selDraft);\n' +
  '      },\n' +
  '      step, booked,',
  'short-turn save handlers');

// ---------------------------------------------------------------------------
// 13. Rules & Assumptions copy, updated to describe the new logic.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '        "QAA is 7 days after QAI. CEL is 1+ day after QAA. ACC is 5+ days after the actual CEL date.",',

  '        "QAA is 7 days after QAI. ACC defaults to 1 business day before the Scheduled Closing Date; CEL defaults to 5\\u20136 calendar days before ACC.",\n' +
  '        "Short turn: if the QAA-to-ACC gap is too tight for the normal 5\\u20136-day CEL spacing, CEL instead defaults to the next business day after QAA. Fewer than 5 days between CEL and ACC shows both dates in red and asks for confirmation before Save.",\n' +
  '        "CEL and ACC can never be scheduled before the Projected Completion Date or on/after the Scheduled Closing Date \\u2014 the tool blocks both the auto-suggested options and manual entry.",\n' +
  '        "Clicking a CEL or ACC date box reopens scheduling for that walk; a custom date can be entered there to regenerate options starting from that day instead of the suggested one.",',
  'rules copy');

// ---------------------------------------------------------------------------
// 14. HTML: short-turn save-confirmation banner, right after the existing
//     Reset confirmation banner.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '          <sc-if value="{{ confirmingReset }}" hint-placeholder-val="{{ false }}">\n' +
  '            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 14px;border:1px solid #EFCFCF;border-radius:8px;background:#FBEDED">\n' +
  '              <span style="font-size:12.5px;font-weight:500;color:#AA1F23;text-wrap:pretty">Clear the scheduled CEL and ACC walks for this homesite? This can\u2019t be undone.</span>\n' +
  '              <span style="margin-left:auto;display:flex;gap:8px;flex:0 0 auto">\n' +
  '                <button sc-camel-on-click="{{ onCancelReset }}" style="height:28px;padding:0 12px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#F1EBE1">Cancel</button>\n' +
  '                <button sc-camel-on-click="{{ onConfirmReset }}" style="height:28px;padding:0 14px;border:0;border-radius:4px;background:#AA1F23;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#8A1A1D">Yes, Reset</button>\n' +
  '              </span>\n' +
  '            </div>\n' +
  '          </sc-if>',

  '          <sc-if value="{{ confirmingReset }}" hint-placeholder-val="{{ false }}">\n' +
  '            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 14px;border:1px solid #EFCFCF;border-radius:8px;background:#FBEDED">\n' +
  '              <span style="font-size:12.5px;font-weight:500;color:#AA1F23;text-wrap:pretty">Clear the scheduled CEL and ACC walks for this homesite? This can\u2019t be undone.</span>\n' +
  '              <span style="margin-left:auto;display:flex;gap:8px;flex:0 0 auto">\n' +
  '                <button sc-camel-on-click="{{ onCancelReset }}" style="height:28px;padding:0 12px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#F1EBE1">Cancel</button>\n' +
  '                <button sc-camel-on-click="{{ onConfirmReset }}" style="height:28px;padding:0 14px;border:0;border-radius:4px;background:#AA1F23;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#8A1A1D">Yes, Reset</button>\n' +
  '              </span>\n' +
  '            </div>\n' +
  '          </sc-if>\n' +
  '\n' +
  '          <sc-if value="{{ confirmingShortTurn }}" hint-placeholder-val="{{ false }}">\n' +
  '            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 14px;border:1px solid #EFCFCF;border-radius:8px;background:#FBEDED">\n' +
  '              <span style="font-size:12.5px;font-weight:500;color:#AA1F23;text-wrap:pretty">Less than 5 days between CEL and ACC \u2014 this is a short turn. Save anyway?</span>\n' +
  '              <span style="margin-left:auto;display:flex;gap:8px;flex:0 0 auto">\n' +
  '                <button sc-camel-on-click="{{ onCancelShortTurnSave }}" style="height:28px;padding:0 12px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#F1EBE1">Cancel</button>\n' +
  '                <button sc-camel-on-click="{{ onConfirmShortTurnSave }}" style="height:28px;padding:0 14px;border:0;border-radius:4px;background:#AA1F23;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#8A1A1D">Yes, Save Anyway</button>\n' +
  '              </span>\n' +
  '            </div>\n' +
  '          </sc-if>',
  'short-turn confirm banner HTML');

// ---------------------------------------------------------------------------
// 15. HTML: make the CEL/ACC stage boxes clickable.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '            <sc-for list="{{ sel.stages }}" as="st" hint-placeholder-count="4">\n' +
  '              <div style="display:flex;flex-direction:column;gap:3px;padding:11px 12px 12px;background:{{ st.bg }}">\n' +
  '                <span style="display:inline-flex;align-items:center;justify-content:center;width:fit-content;height:20px;padding:0 9px;border-radius:999px;background:{{ st.pillBg }};color:{{ st.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em">{{ st.code }}</span>\n' +
  '                <span style="font-size:13.5px;font-weight:600;color:{{ st.dateColor }};font-variant-numeric:tabular-nums">{{ st.date }}</span>\n' +
  '                <span style="font-size:11.5px;color:#6F6963;text-wrap:pretty">{{ st.who }}</span>\n' +
  '              </div>\n' +
  '            </sc-for>',

  '            <sc-for list="{{ sel.stages }}" as="st" hint-placeholder-count="4">\n' +
  '              <div sc-camel-on-click="{{ st.onClick }}" style="display:flex;flex-direction:column;gap:3px;padding:11px 12px 12px;background:{{ st.bg }};cursor:{{ st.cursor }}">\n' +
  '                <span style="display:inline-flex;align-items:center;justify-content:center;width:fit-content;height:20px;padding:0 9px;border-radius:999px;background:{{ st.pillBg }};color:{{ st.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em">{{ st.code }}</span>\n' +
  '                <span style="font-size:13.5px;font-weight:600;color:{{ st.dateColor }};font-variant-numeric:tabular-nums">{{ st.date }}</span>\n' +
  '                <span style="font-size:11.5px;color:#6F6963;text-wrap:pretty">{{ st.who }}</span>\n' +
  '              </div>\n' +
  '            </sc-for>',
  'stage box onClick HTML');

// ---------------------------------------------------------------------------
// 16. HTML: custom-date field in the step panel header.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">\n' +
  '            <h3 style="margin:0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:24px;letter-spacing:-.03em;color:#1B2A58">{{ step.title }}</h3>\n' +
  '            <span style="font-size:12.5px;color:#6F6963">{{ step.sub }}</span>\n' +
  '          </div>',

  '          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">\n' +
  '            <h3 style="margin:0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:24px;letter-spacing:-.03em;color:#1B2A58">{{ step.title }}</h3>\n' +
  '            <span style="font-size:12.5px;color:#6F6963">{{ step.sub }}</span>\n' +
  '            <label style="margin-left:auto;display:flex;align-items:center;gap:6px">\n' +
  '              <span style="font-size:11px;font-weight:600;color:#6F6963">Custom date</span>\n' +
  '              <input type="date" value="{{ step.customDate }}" sc-camel-on-change="{{ step.onCustomDate }}" style="height:28px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n' +
  '            </label>\n' +
  '          </div>',
  'custom date input HTML');

if (tpl === template) {
  console.log('No changes made (already applied). Exiting.');
  process.exit(0);
}

let newJsonStr = JSON.stringify(tpl).split('</').join('<\\u002F');
if (newJsonStr.includes('</')) throw new Error('failed to neutralise a close tag');

const newHtml = html.slice(0, prefixEnd) + newJsonStr + html.slice(lineTail - suffix.length);

const idx2 = newHtml.indexOf('<script type="__bundler/template">');
const tagOpen2 = '<script type="__bundler/template">';
const browserSeesEnd = newHtml.indexOf('</script>', idx2 + tagOpen2.length);
const browserJsonStr = newHtml.slice(idx2 + tagOpen2.length, browserSeesEnd);
const browserDecoded = JSON.parse(browserJsonStr);
if (browserDecoded !== tpl) throw new Error('round-trip mismatch after escaping');

fs.writeFileSync(FILE, newHtml);
console.log('Patched ' + FILE + ' (' + (newHtml.length / 1024).toFixed(0) + ' KB)');
