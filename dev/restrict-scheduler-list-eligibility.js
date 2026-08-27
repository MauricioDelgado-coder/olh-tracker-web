#!/usr/bin/env node
/**
 * scheduler.html list eligibility + concierge scoping (2026-08).
 *
 * New rules for what shows in the homesite list:
 *   - QAI must be actually COMPLETE (not just dated) to be schedulable.
 *   - Hide Airtable records that are not Record Status = Active.
 *   - Hide anything whose Scheduled Closing Date has already passed.
 *   - Hide anything with CEL Completed or ACC Completed already true.
 *   - A signed-in Concierge only ever sees their own assigned homesites;
 *     the "Assigned Concierge" dropdown is hidden for that role.
 *
 * IMPORTANT: these rules are applied to the LIST only, never to
 * homesites() itself. seed() also reads homesites() to build the booking/
 * conflict baseline (dayHours/slotTaken) from every QAI/QAA/CEL/ACC date
 * that has ever existed -- filtering homesites() would silently drop real
 * commitments from conflict detection for any home the list now hides,
 * and the optimizer could double-book a manager into a slot that a hidden
 * home already occupies. So homesites() keeps returning everything; only
 * the list-building filter in renderVals() got stricter.
 *
 * Same decode/replace/re-encode/round-trip-validate pattern as the other
 * scheduler.html patch scripts in this directory.
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
// 1. homesites(): add the new eligibility fields. Data only -- no filtering
//    here, so seed()'s capacity/conflict baseline stays complete.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '        id: f["Job #"], recordId: j.id, job: f["Job #"], productLine: pl, community,\n' +
  '        address: f["Street Address"] || "", qai, qaa, cel, acc,\n' +
  '        celTime: f["CEL Date"] || null, accTime: f["ACC Date"] || null,\n' +
  '        /* The Manager link arrays, so seed() can attribute a walk to the\n' +
  '           person actually assigned to it instead of guessing. Raw Airtable\n' +
  '           shape: an array of Managers-table record ids, or absent. */\n' +
  '        qaiMgr: f["QAI Manager"] || [], qaaMgr: f["QAA Manager"] || [],\n' +
  '        celMgr: f["CEL Manager"] || [], accMgr: f["ACC Manager"] || [],\n' +
  '        celLetterSent: !!f["CEL Letter Sent"],\n' +
  '        concierge: f["Assigned Concierge"] || "",\n' +
  '        pcd: f["Projected Completion Date"] ? parseKey(f["Projected Completion Date"]) : null,\n' +
  '        ecoe: f["Estimated COE Date"] ? parseKey(f["Estimated COE Date"]) : null,\n' +
  '        close: f["Scheduled Closing Date"] ? parseKey(f["Scheduled Closing Date"]) : null\n' +
  '      };',

  '        id: f["Job #"], recordId: j.id, job: f["Job #"], productLine: pl, community,\n' +
  '        address: f["Street Address"] || "", qai, qaa, cel, acc,\n' +
  '        celTime: f["CEL Date"] || null, accTime: f["ACC Date"] || null,\n' +
  '        /* The Manager link arrays, so seed() can attribute a walk to the\n' +
  '           person actually assigned to it instead of guessing. Raw Airtable\n' +
  '           shape: an array of Managers-table record ids, or absent. */\n' +
  '        qaiMgr: f["QAI Manager"] || [], qaaMgr: f["QAA Manager"] || [],\n' +
  '        celMgr: f["CEL Manager"] || [], accMgr: f["ACC Manager"] || [],\n' +
  '        celLetterSent: !!f["CEL Letter Sent"],\n' +
  '        concierge: f["Assigned Concierge"] || "",\n' +
  '        pcd: f["Projected Completion Date"] ? parseKey(f["Projected Completion Date"]) : null,\n' +
  '        ecoe: f["Estimated COE Date"] ? parseKey(f["Estimated COE Date"]) : null,\n' +
  '        close: f["Scheduled Closing Date"] ? parseKey(f["Scheduled Closing Date"]) : null,\n' +
  '        /* List-eligibility inputs -- see the filter in renderVals(). Kept\n' +
  '           here as plain data so seed() (which needs EVERY homesite for its\n' +
  '           booking/conflict baseline, not just the ones on display) is\n' +
  '           unaffected. */\n' +
  '        qaiComplete: !!f["QAI Complete"],\n' +
  '        active: (f["Record Status"] || "") === "Active",\n' +
  '        celCompleted: !!f["CEL Completed"],\n' +
  '        accCompleted: !!f["ACC Completed"]\n' +
  '      };',
  'homesites() eligibility fields');

// ---------------------------------------------------------------------------
// 2. renderVals(): compute the signed-in concierge scope right before the
//    list filter uses it.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    const list = sites.filter(h => {\n' +
  '      const st = statusOf(h);\n' +
  '      if (s.filter === "due" && (st === "SCHEDULED" || !inWindow(h))) return false;\n' +
  '      if (s.filter === "done" && st !== "SCHEDULED") return false;\n' +
  '      if (s.concierge && h.concierge !== s.concierge) return false;\n' +
  '      if (q && (h.job + " " + h.productLine + " " + (h.community || "") + " " + h.address + " " + h.concierge).toLowerCase().indexOf(q) < 0) return false;\n' +
  '      return true;\n' +
  '    }).sort((a, b) => (a.close ? a.close.getTime() : Infinity) - (b.close ? b.close.getTime() : Infinity) || a.qaa - b.qaa).slice(0, 120);',

  '    /* A Concierge only ever sees their own assigned homesites, no matter\n' +
  '       what the Assigned Concierge dropdown is set to (it is hidden for\n' +
  '       this role -- see showConciergeFilter below). Matched by name since\n' +
  '       that is what "Assigned Concierge" stores on the Jobs record. */\n' +
  '    const me = window.OLHAuth && window.OLHAuth.user && window.OLHAuth.user();\n' +
  '    const conciergeLocked = !!(me && me.role === "concierge");\n' +
  '    const myConciergeName = conciergeLocked ? String(me.name || "").trim().toLowerCase() : "";\n' +
  '    const list = sites.filter(h => {\n' +
  '      // Ready for scheduling only once QAI has actually been COMPLETED --\n' +
  '      // having a QAI date just means one is planned, not that it happened.\n' +
  '      if (!h.qaiComplete) return false;\n' +
  '      // Never show a record Airtable does not consider Active.\n' +
  '      if (!h.active) return false;\n' +
  '      // Once the closing date itself has passed there is nothing left to\n' +
  '      // schedule for this home.\n' +
  '      if (h.close && h.close.getTime() < TODAY.getTime()) return false;\n' +
  '      // Either milestone already walked and marked complete -- nothing\n' +
  '      // left for the scheduler to do here.\n' +
  '      if (h.celCompleted || h.accCompleted) return false;\n' +
  '      if (conciergeLocked && String(h.concierge || "").trim().toLowerCase() !== myConciergeName) return false;\n' +
  '      const st = statusOf(h);\n' +
  '      if (s.filter === "due" && (st === "SCHEDULED" || !inWindow(h))) return false;\n' +
  '      if (s.filter === "done" && st !== "SCHEDULED") return false;\n' +
  '      if (s.concierge && h.concierge !== s.concierge) return false;\n' +
  '      if (q && (h.job + " " + h.productLine + " " + (h.community || "") + " " + h.address + " " + h.concierge).toLowerCase().indexOf(q) < 0) return false;\n' +
  '      return true;\n' +
  '    }).sort((a, b) => (a.close ? a.close.getTime() : Infinity) - (b.close ? b.close.getTime() : Infinity) || a.qaa - b.qaa).slice(0, 120);',
  'list filter eligibility + concierge scope');

// ---------------------------------------------------------------------------
// 3. Expose showConciergeFilter in the returned render object.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      conciergeOpts, concierge: s.concierge,\n' +
  '      onConcierge: e => this.setState({ concierge: e.target.value }),',

  '      showConciergeFilter: !conciergeLocked,\n' +
  '      conciergeOpts, concierge: s.concierge,\n' +
  '      onConcierge: e => this.setState({ concierge: e.target.value }),',
  'showConciergeFilter render value');

// ---------------------------------------------------------------------------
// 4. HTML: hide the Assigned Concierge dropdown entirely for the concierge
//    role -- it would otherwise let them filter down to zero results.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '        <label style="display:flex;flex-direction:column;gap:3px">\n' +
  '          <span style="font-size:11px;font-weight:600;color:#6F6963">Assigned Concierge</span>\n' +
  '          <sc-raw-select value="{{ concierge }}" sc-camel-on-change="{{ onConcierge }}" style="height:32px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:13px;cursor:pointer">\n' +
  '            <sc-for list="{{ conciergeOpts }}" as="c" hint-placeholder-count="6"><option value="{{ c.v }}">{{ c.l }}</option></sc-for>\n' +
  '          </sc-raw-select>\n' +
  '        </label>',

  '        <sc-if value="{{ showConciergeFilter }}" hint-placeholder-val="{{ true }}">\n' +
  '          <label style="display:flex;flex-direction:column;gap:3px">\n' +
  '            <span style="font-size:11px;font-weight:600;color:#6F6963">Assigned Concierge</span>\n' +
  '            <sc-raw-select value="{{ concierge }}" sc-camel-on-change="{{ onConcierge }}" style="height:32px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:13px;cursor:pointer">\n' +
  '              <sc-for list="{{ conciergeOpts }}" as="c" hint-placeholder-count="6"><option value="{{ c.v }}">{{ c.l }}</option></sc-for>\n' +
  '            </sc-raw-select>\n' +
  '          </label>\n' +
  '        </sc-if>',
  'hide concierge dropdown HTML');

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
