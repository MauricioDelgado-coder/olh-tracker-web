#!/usr/bin/env node
/**
 * Adds the <olh-multiselect> filter dropdown (see dev/multiselect.js) to
 * completion.html's five single-select filters (Lot Type, Stage, Community,
 * Construction Manager, Area Construction Manager), matching the conversion
 * already done for tracker.html and qa-management.html.
 *
 * Does three things:
 *  1. Rewrites the five <sc-raw-select>...</sc-raw-select> blocks in the
 *     __bundler/template blob to <olh-multiselect ref=... ...></olh-multiselect>.
 *  2. Rewrites the component JS (also inside the same template blob) so the
 *     five filter fields are arrays, filtered() does membership checks
 *     instead of equality, opts() drops its old single-select blank-option
 *     entry, selRefs/syncSelects exist and are wired into
 *     componentDidMount/componentDidUpdate (which did not previously exist
 *     on this page), the "top communities" bar chart's own s.comm reads
 *     become array-aware, the removable filter chips read .length, and the
 *     Reset button clears to [] instead of "".
 *  3. Injects dev/multiselect.js verbatim as an outer-sibling <script>,
 *     matching the exact mechanism build-live-pages.js uses for
 *     tracker.html/qa-management.html (PAGES[] multiselect:true), since
 *     completion.html did not have that flag set and has never carried the
 *     widget's definition.
 *
 * Every substitution is done via exact, unique string matches against the
 * DECODED template (verified count===1 before replacing); the result is
 * re-encoded with the same </ -> <\u002F escaping emit() uses, and the
 * whole thing is round-trip validated (parses back to exactly what was
 * built) before writing to disk. Refuses to write on any mismatch.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'completion.html');
const MULTISELECT_SRC = fs.readFileSync(path.join(__dirname, 'multiselect.js'), 'utf8');

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
  // Idempotency: an earlier partial run (e.g. a stray direct edit) may have
  // already applied this exact change. If the target text is already
  // present exactly once and the old text is gone, treat as done and move
  // on rather than failing the whole run.
  const toCount = str.split(to).length - 1;
  if (fromCount === 0 && toCount === 1) {
    console.log('  [' + label + '] already applied, skipping');
    return str;
  }
  throw new Error('expected exactly 1 occurrence of [' + label + '], found ' + fromCount +
    ' (and ' + toCount + ' of the replacement already present)');
}

const html = fs.readFileSync(FILE, 'utf8');
const { idx, prefixEnd, lineTail, suffix, template } = decodeTemplateLine(html);
let tpl = template;

/* ---- 1. markup: five sc-raw-select -> olh-multiselect ---- */
const markupSwaps = [
  {
    label: 'lot select',
    from: '<sc-raw-select value="{{ fLot }}" sc-camel-on-change="{{ onLot }}" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n            <sc-for list="{{ optLot }}" as="o" hint-placeholder-count="3"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n          </sc-raw-select>',
    to: '<olh-multiselect ref="{{ refLot }}" sc-camel-on-change="{{ onLot }}" placeholder="All lot types" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer"></olh-multiselect>'
  },
  {
    label: 'stage select',
    from: '<sc-raw-select value="{{ fStage }}" sc-camel-on-change="{{ onStage }}" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n            <sc-for list="{{ optStage }}" as="o" hint-placeholder-count="4"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n          </sc-raw-select>',
    to: '<olh-multiselect ref="{{ refStage }}" sc-camel-on-change="{{ onStage }}" placeholder="All stages" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer"></olh-multiselect>'
  },
  {
    label: 'community select',
    from: '<sc-raw-select value="{{ fComm }}" sc-camel-on-change="{{ onComm }}" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n          <sc-for list="{{ optComm }}" as="o" hint-placeholder-count="6"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n        </sc-raw-select>',
    to: '<olh-multiselect ref="{{ refComm }}" sc-camel-on-change="{{ onComm }}" placeholder="All communities" style="min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer"></olh-multiselect>'
  },
  {
    label: 'cm select',
    from: '<sc-raw-select value="{{ fCM }}" sc-camel-on-change="{{ onCM }}" style="height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n          <sc-for list="{{ optCM }}" as="o" hint-placeholder-count="6"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n        </sc-raw-select>',
    to: '<olh-multiselect ref="{{ refCM }}" sc-camel-on-change="{{ onCM }}" placeholder="All construction managers" style="height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer"></olh-multiselect>'
  },
  {
    label: 'acm select',
    from: '<sc-raw-select value="{{ fAcm }}" sc-camel-on-change="{{ onAcm }}" style="height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer">\n          <sc-for list="{{ optAcm }}" as="o" hint-placeholder-count="4"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n        </sc-raw-select>',
    to: '<olh-multiselect ref="{{ refAcm }}" sc-camel-on-change="{{ onAcm }}" placeholder="All area construction managers" style="height:30px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;cursor:pointer"></olh-multiselect>'
  }
];
for (const s of markupSwaps) tpl = replaceOnce(tpl, s.from, s.to, s.label);

/* ---- 2. state defaults: single strings -> arrays ---- */
tpl = replaceOnce(tpl,
  'lot: "", comm: "", cm: "", acm: "", stage: "",',
  'lot: [], comm: [], cm: [], acm: [], stage: [],',
  'state defaults');

/* ---- 3. filtered(except): equality -> membership ---- */
tpl = replaceOnce(tpl,
  '      if (except !== "lot" && s.lot && r.lot !== s.lot) return false;\n' +
  '      if (except !== "comm" && s.comm && r.community !== s.comm) return false;\n' +
  '      if (except !== "cm" && s.cm && r.cm !== s.cm) return false;\n' +
  '      if (except !== "acm" && s.acm && r.acm !== s.acm) return false;\n' +
  '      if (except !== "stage" && s.stage && r.stage !== s.stage) return false;',
  '      if (except !== "lot" && s.lot.length && !s.lot.includes(r.lot)) return false;\n' +
  '      if (except !== "comm" && s.comm.length && !s.comm.includes(r.community)) return false;\n' +
  '      if (except !== "cm" && s.cm.length && !s.cm.includes(r.cm)) return false;\n' +
  '      if (except !== "acm" && s.acm.length && !s.acm.includes(r.acm)) return false;\n' +
  '      if (except !== "stage" && s.stage.length && !s.stage.includes(r.stage)) return false;',
  'filtered() membership checks');

/* ---- 4. opts(): drop the old single-select blank/placeholder entry ---- */
tpl = replaceOnce(tpl,
  '  opts(key, label) {\n' +
  '    const counts = {};\n' +
  '    const f = key === "comm" ? "community" : key;\n' +
  '    this.filtered(key).forEach(r => { if (r[f]) counts[r[f]] = (counts[r[f]] || 0) + 1; });\n' +
  '    const list = Object.keys(counts).sort().map(v => ({ v, l: v + "  (" + counts[v] + ")" }));\n' +
  '    return [{ v: "", l: label }].concat(list);\n' +
  '  }',
  '  opts(key) {\n' +
  '    const counts = {};\n' +
  '    const f = key === "comm" ? "community" : key;\n' +
  '    this.filtered(key).forEach(r => { if (r[f]) counts[r[f]] = (counts[r[f]] || 0) + 1; });\n' +
  '    return Object.keys(counts).sort().map(v => ({ v, l: v + "  (" + counts[v] + ")" }));\n' +
  '  }',
  'opts() definition');

/* ---- 5. top-communities bar chart: s.comm scalar -> array membership/toggle ---- */
tpl = replaceOnce(tpl,
  '      color: s.comm === k ? "#005DAA" : "#A8C8E2",\n' +
  '      labelColor: s.comm === k ? "#005DAA" : "#303030",\n' +
  '      onClick: () => this.set({ comm: s.comm === k ? "" : k })',
  '      color: s.comm.includes(k) ? "#005DAA" : "#A8C8E2",\n' +
  '      labelColor: s.comm.includes(k) ? "#005DAA" : "#303030",\n' +
  '      onClick: () => this.set({ comm: s.comm.includes(k) ? s.comm.filter(x => x !== k) : s.comm.concat([k]) })',
  'top communities bar toggle');

/* ---- 6. removable filter chips: scalar truthy -> .length, clear to [] ---- */
tpl = replaceOnce(tpl,
  '    if (s.lot) chip("Lot Type: " + s.lot, { lot: "" });\n' +
  '    if (s.stage) chip("Stage: " + s.stage, { stage: "" });\n' +
  '    if (s.comm) chip(s.comm, { comm: "" });\n' +
  '    if (s.cm) chip("CM: " + s.cm, { cm: "" });\n' +
  '    if (s.acm) chip("ACM: " + s.acm, { acm: "" });',
  '    if (s.lot.length) chip("Lot Type: " + (s.lot.length === 1 ? s.lot[0] : s.lot.length + " selected"), { lot: [] });\n' +
  '    if (s.stage.length) chip("Stage: " + (s.stage.length === 1 ? s.stage[0] : s.stage.length + " selected"), { stage: [] });\n' +
  '    if (s.comm.length) chip(s.comm.length === 1 ? s.comm[0] : s.comm.length + " communities", { comm: [] });\n' +
  '    if (s.cm.length) chip("CM: " + (s.cm.length === 1 ? s.cm[0] : s.cm.length + " selected"), { cm: [] });\n' +
  '    if (s.acm.length) chip("ACM: " + (s.acm.length === 1 ? s.acm[0] : s.acm.length + " selected"), { acm: [] });',
  'filter chips');

/* ---- 7. Reset button: clear to [] instead of "" ---- */
tpl = replaceOnce(tpl,
  'this.setState({ lot: "", comm: "", cm: "", acm: "", stage: "", months: [], day: "", q: "", limit: 200, detail: null, landRisk: false, constRisk: false });',
  'this.setState({ lot: [], comm: [], cm: [], acm: [], stage: [], months: [], day: "", q: "", limit: 200, detail: null, landRisk: false, constRisk: false });',
  'Reset button');

/* ---- 8. render() return: drop fXxx/optXxx, add refXxx + _filterOptions ---- */
tpl = replaceOnce(tpl,
  '      fLot: s.lot, fComm: s.comm, fCM: s.cm, fAcm: s.acm, fStage: s.stage,\n' +
  '      optLot: this.opts("lot", "All lot types"),\n' +
  '      optComm: this.opts("comm", "All communities"),\n' +
  '      optCM: this.opts("cm", "All construction managers"),\n' +
  '      optAcm: this.opts("acm", "All area construction managers"),\n' +
  '      optStage: this.opts("stage", "All stages"),\n' +
  '      onLot: e => this.set({ lot: e.target.value }),',
  '      refLot: this.selRefs.lot, refComm: this.selRefs.comm, refCM: this.selRefs.cm,\n' +
  '      refAcm: this.selRefs.acm, refStage: this.selRefs.stage,\n' +
  '      onLot: e => this.set({ lot: e.target.value }),',
  'render return filter props');

/* Stash the option lists as a side effect the same way tracker.html does --
   computed below, right before the chips section, since the markup no
   longer references {{ optXxx }} at all. */

/* Insert the _filterOptions computation just before the render return's
   opening "return {" for the chips/kpi/etc. section -- anchor on a line we
   know sits right before it. */
tpl = replaceOnce(tpl,
  '    // ---- chips\n    const chips = [];',
  '    /* Raw option lists for the multi-select filters, stashed so syncSelects()\n' +
  '       (called after every render, from componentDidMount/componentDidUpdate)\n' +
  '       can push them down to the <olh-multiselect> refs imperatively -- these\n' +
  '       are plain custom elements, not native <select>, so they take their\n' +
  '       options via setOptions() rather than nested <option> markup. */\n' +
  '    this._filterOptions = {\n' +
  '      lot: this.opts("lot"), comm: this.opts("comm"), cm: this.opts("cm"),\n' +
  '      acm: this.opts("acm"), stage: this.opts("stage")\n' +
  '    };\n\n' +
  '    // ---- chips\n    const chips = [];',
  '_filterOptions insertion point');

/* ---- 9. selRefs field + syncSelects() + wire into mount/update ---- */
tpl = replaceOnce(tpl,
  'class Component extends DCLogic {\n  state = {',
  'class Component extends DCLogic {\n' +
  '  selRefs = {lot:React.createRef(), comm:React.createRef(), cm:React.createRef(), acm:React.createRef(), stage:React.createRef()};\n\n' +
  '  state = {',
  'selRefs field insertion');

tpl = replaceOnce(tpl,
  '      window.addEventListener("olh-data", ready);\n' +
  '      this._poll = setInterval(ready, 120);\n' +
  '      setTimeout(() => clearInterval(this._poll), 20000);\n' +
  '      ready();\n' +
  '    }\n' +
  '  }\n\n' +
  '  _wireAuth(tries) {',
  '      window.addEventListener("olh-data", ready);\n' +
  '      this._poll = setInterval(ready, 120);\n' +
  '      setTimeout(() => clearInterval(this._poll), 20000);\n' +
  '      ready();\n' +
  '    }\n' +
  '    this.syncSelects();\n' +
  '  }\n\n' +
  '  syncSelects(){\n' +
  '    Object.keys(this.selRefs).forEach(k => {\n' +
  '      const n = this.selRefs[k].current;\n' +
  '      if(!n) return;\n' +
  '      if(n.setOptions && this._filterOptions) n.setOptions(this._filterOptions[k] || []);\n' +
  '      if(n.value !== this.state[k]) n.value = this.state[k];\n' +
  '    });\n' +
  '  }\n' +
  '  componentDidUpdate(){\n' +
  '    this.syncSelects();\n' +
  '  }\n\n' +
  '  _wireAuth(tries) {',
  'componentDidMount/syncSelects/componentDidUpdate insertion');

/* ---- re-encode and validate ---- */
if (tpl === template) throw new Error('template unchanged -- something matched nothing');

let newJsonStr = JSON.stringify(tpl).split('</').join('<\\u002F');
if (newJsonStr.includes('</')) throw new Error('failed to neutralise a close tag');

const newHtml = html.slice(0, prefixEnd) + newJsonStr + html.slice(lineTail - suffix.length);

// Round-trip validate exactly as the browser will see it.
const idx2 = newHtml.indexOf('<script type="__bundler/template">');
const tagOpen2 = '<script type="__bundler/template">';
const browserSeesEnd = newHtml.indexOf('</script>', idx2 + tagOpen2.length);
const browserJsonStr = newHtml.slice(idx2 + tagOpen2.length, browserSeesEnd);
const browserDecoded = JSON.parse(browserJsonStr);
if (browserDecoded !== tpl) throw new Error('round-trip mismatch after escaping');

fs.copyFileSync(FILE, path.join(__dirname, 'fix-backup', 'completion-pre-multiselect.html'));
fs.writeFileSync(FILE, newHtml);
console.log('completion.html template patched OK, new template length ' + tpl.length + ' (was ' + template.length + ')');
