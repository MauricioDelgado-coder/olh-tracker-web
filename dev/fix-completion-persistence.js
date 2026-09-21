#!/usr/bin/env node
/* Three fixes to public/completion.html, applied in place.
 *
 * public/completion.html is a design-tool export whose whole component lives
 * inside the escaped JSON string on line 903, so every anchor below is written
 * with LITERAL backslash-n and backslash-quote, not real newlines/quotes.
 *
 * Same arrangement as dev/add-completion-multiselect.js: this page's changes
 * are applied to the built file rather than as inline patch strings in
 * dev/build-live-pages.js, because a re-export regenerates the page from
 * scratch. Re-run this script after any fresh export of completion.html.
 *
 * 1. Read-only clicks said nothing. Power/Water/NOC/Construction Risk/Land
 *    Risk all guard with `if (canEdit)` or `if (!canEdit) return;` BEFORE
 *    reaching commit(), and commit() is the only place the deny toast lives.
 *    A user without tracker.edit -- every ACM, who sits on the `cm` role --
 *    clicked the chip and got nothing at all: no save, no error, only the
 *    READ ONLY banner at the top of a long table.
 *
 * 2. The olh-data listener was registered only when OLH_DATA was absent at
 *    mount. dev/live-loader.js refetches /api/jobs on tab focus and fires
 *    olh-data; homesite.html and scheduler.html bind that listener
 *    unconditionally, this page did not. Whenever the fetch landed before the
 *    component mounted -- the common case -- the page ignored every refresh
 *    and kept serving its stale _rows memo.
 *
 * 3. No audit entry was ever written here. 0 rows out of 11,196, while every
 *    other editable page logs. A risk flag set on this report saved to
 *    Airtable but left the homesite Change History empty, which reads as a
 *    failed save. Logged only AFTER the PATCH is confirmed, matching the
 *    homesite.html rule. Posts straight to /api/audit: window.OLHAudit is not
 *    loaded on this page.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'completion.html');

const EDITS = [
  ['Power Meter toggle explains a refusal',
   'onPower: e => { stop(e); if (canEdit) this.commit(r.id, \\"Power Meter\\", !r.power); },',
   'onPower: e => { stop(e); if (canEdit) this.commit(r.id, \\"Power Meter\\", !r.power); else this.denyEdit(); },'],

  ['Water Meter toggle explains a refusal',
   'onWater: e => { stop(e); if (canEdit) this.commit(r.id, \\"Water Meter\\", !r.water); },',
   'onWater: e => { stop(e); if (canEdit) this.commit(r.id, \\"Water Meter\\", !r.water); else this.denyEdit(); },'],

  ['NOC Lock cell explains a refusal',
   'onNocOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"NOC Lock Date\\" } }); },',
   'onNocOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"NOC Lock Date\\" } }); else this.denyEdit(); },'],

  ['Construction Risk chip explains a refusal',
   'onConstRisk: e => { stop(e);\\n          if (!canEdit) return;',
   'onConstRisk: e => { stop(e);\\n          if (!canEdit) { this.denyEdit(); return; }'],

  ['Land Risk chip explains a refusal',
   'onLandRisk: e => { stop(e);\\n          if (!canEdit) return;',
   'onLandRisk: e => { stop(e);\\n          if (!canEdit) { this.denyEdit(); return; }'],

  ['Construction Risk note pencil explains a refusal',
   'onConstNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"Construction Risk Notes\\" } }); },',
   'onConstNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"Construction Risk Notes\\" } }); else this.denyEdit(); },'],

  ['Land Risk note pencil explains a refusal',
   'onLandNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"Land Risk Notes\\" } }); },',
   'onLandNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: \\"Land Risk Notes\\" } }); else this.denyEdit(); },'],

  ['add denyEdit()',
   '  commit(id, field, value) {',
   '  /* Every inline guard above returns before commit(), so commit()\\u2019s own\\n' +
   '     deny toast never fired for them -- the click was simply inert. This is\\n' +
   '     that message, reachable from the guards. */\\n' +
   '  denyEdit() {\\n' +
   '    const why = (window.OLHAuth && typeof window.OLHAuth.denyReason === \\"function\\")\\n' +
   '      ? window.OLHAuth.denyReason(\\"tracker.edit\\")\\n' +
   '      : \\"Your sign-in could not be verified, so this page is read-only. Reload the page.\\";\\n' +
   '    this.toast(\\"err\\", \\"Read-Only Access\\", why);\\n' +
   '  }\\n\\n' +
   '  commit(id, field, value) {'],

  ['olh-data listener binds unconditionally',
   '    this._wireAuth(0);\\n' +
   '    if (!(window.OLH_DATA && window.OLH_DATA.jobs)) {\\n' +
   '      const ready = () => {\\n' +
   '        if (!(window.OLH_DATA && window.OLH_DATA.jobs)) return false;\\n' +
   '        clearInterval(this._poll);\\n' +
   '        this._rows = null;\\n' +
   '        this.forceUpdate();\\n' +
   '        return true;\\n' +
   '      };\\n' +
   '      window.addEventListener(\\"olh-data\\", ready);\\n' +
   '      this._poll = setInterval(ready, 120);\\n' +
   '      setTimeout(() => clearInterval(this._poll), 20000);\\n' +
   '      ready();\\n' +
   '    }\\n',
   '    this._wireAuth(0);\\n' +
   '    /* Bound unconditionally. dev/live-loader.js refetches /api/jobs on tab\\n' +
   '       focus and fires olh-data every time; this listener used to live inside\\n' +
   '       the \\"no data yet\\" branch, so on any load where the fetch beat the\\n' +
   '       component to the DOM it was never bound and the page ignored every\\n' +
   '       later refresh -- serving a _rows memo built from the first payload for\\n' +
   '       the life of the tab. homesite.html and scheduler.html bind theirs in\\n' +
   '       componentDidMount outright; this now matches. */\\n' +
   '    this._onData = () => {\\n' +
   '      if (!(window.OLH_DATA && window.OLH_DATA.jobs)) return false;\\n' +
   '      clearInterval(this._poll);\\n' +
   '      this._rows = null;\\n' +
   '      this.forceUpdate();\\n' +
   '      return true;\\n' +
   '    };\\n' +
   '    window.addEventListener(\\"olh-data\\", this._onData);\\n' +
   '    if (!(window.OLH_DATA && window.OLH_DATA.jobs)) {\\n' +
   '      this._poll = setInterval(this._onData, 120);\\n' +
   '      setTimeout(() => clearInterval(this._poll), 20000);\\n' +
   '      this._onData();\\n' +
   '    }\\n'],

  ['unbind olh-data on unmount',
   'componentWillUnmount() {\\n    clearInterval(this._poll);',
   'componentWillUnmount() {\\n    clearInterval(this._poll);\\n    if (this._onData) window.removeEventListener(\\"olh-data\\", this._onData);'],

  ['log the edit once Airtable has accepted it',
   "{ [id]: 'saved' }) }));\\n" +
   '      setTimeout(() => this.setState(s => { const n = Object.assign({}, s.save); delete n[id]; return { save: n }; }), 2100);',
   "{ [id]: 'saved' }) }));\\n" +
   '      this.logEdit(rec, id, field, value, prev);\\n' +
   '      setTimeout(() => this.setState(s => { const n = Object.assign({}, s.save); delete n[id]; return { save: n }; }), 2100);'],

  ['add logEdit()',
   '  async persist(rec, id, field, value, prev) {',
   '  /* Until 2026-09 this page wrote no audit entry at all -- the only\\n' +
   '     editable page in the suite that did not. A risk flag set here saved to\\n' +
   '     Airtable but left the homesite Change History blank, so the edit looked\\n' +
   '     lost to anyone checking there. Posts directly to /api/audit because\\n' +
   '     window.OLHAudit is not one of this page\\u2019s bundled assets. Called only\\n' +
   '     after the PATCH resolves: /api/audit is append-only, so a pre-emptive\\n' +
   '     entry would claim a change that never landed. A failed log is swallowed\\n' +
   '     -- the save itself already succeeded. */\\n' +
   '  logEdit(rec, id, field, value, prev) {\\n' +
   '    const show = v => v === true ? \\"Yes\\" : v === false ? \\"No\\"\\n' +
   '      : (v == null || v === \\"\\") ? \\"\\\\u2014\\" : String(v);\\n' +
   '    fetch(\\"/api/audit\\", {\\n' +
   '      method: \\"POST\\",\\n' +
   '      headers: this._authHeaders({ \\"Content-Type\\": \\"application/json\\" }),\\n' +
   '      body: JSON.stringify({\\n' +
   '        recordId: id, job: rec.fields[\\"Job #\\"] || id, field,\\n' +
   '        label: AUDIT_LABEL[field] || field,\\n' +
   '        from: show(prev), to: show(value),\\n' +
   '        action: \\"edit\\", page: \\"Completion Report\\"\\n' +
   '      })\\n' +
   '    }).catch(() => {});\\n' +
   '  }\\n\\n' +
   '  async persist(rec, id, field, value, prev) {'],

  ['add AUDIT_LABEL',
   'const JOB_LINK = function(job){',
   '/* Short field labels for the change log, so an entry from this page reads\\n' +
   '   the same as the one the tracker and homesite pages write for the very\\n' +
   '   same field. Keep in step with LABEL in homesite.html. */\\n' +
   'const AUDIT_LABEL = {\\n' +
   '  \\"Power Meter\\": \\"Power\\", \\"Water Meter\\": \\"Water\\", \\"NOC Lock Date\\": \\"NOC Lock\\",\\n' +
   '  \\"Construction Risk\\": \\"C Risk\\", \\"Construction Risk Notes\\": \\"Construction Risk Notes\\",\\n' +
   '  \\"Land Risk\\": \\"L Risk\\", \\"Land Risk Notes\\": \\"Land Risk Notes\\"\\n' +
   '};\\n\\n' +
   'const JOB_LINK = function(job){']
];

let text = fs.readFileSync(FILE, 'utf8');
const before = text;
let failed = 0;

for (const [label, find, replace] of EDITS) {
  const hits = text.split(find).length - 1;
  if (hits === 0 && text.indexOf(replace) > -1) {
    console.log('  skip  ' + label + '  (already applied)');
    continue;
  }
  if (hits !== 1) {
    console.error('  FAIL  ' + label + '  (anchor matched ' + hits + ' times, expected 1)');
    failed++;
    continue;
  }
  text = text.replace(find, replace);
  console.log('  ok    ' + label);
}

if (failed) {
  console.error('\n' + failed + ' anchor(s) did not match exactly once. Nothing written.');
  process.exit(1);
}
if (text === before) {
  console.error('\nNo change produced. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE, text);
console.log('\nWrote ' + FILE + ' (' + before.length + ' -> ' + text.length + ' bytes)');
