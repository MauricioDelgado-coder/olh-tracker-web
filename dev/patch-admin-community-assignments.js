#!/usr/bin/env node
/**
 * Add a "Community Assignments" tab to public/admin.html.
 *
 *   node dev/patch-admin-community-assignments.js           # dry run
 *   node dev/patch-admin-community-assignments.js --apply   # write
 *
 * Same find-encode-verify approach as patch-admin-dynamic-role-options.js:
 * decode the __bundler/template JSON, prove a round-trip re-encode is
 * byte-identical BEFORE changing anything (the template escapes "</" as
 * "<\u002F", which a plain JSON.stringify does not reproduce), make four
 * anchored edits that must each match exactly once, re-encode, write, then
 * re-read and verify.
 *
 * The tab mirrors Roles & Permissions' Available/Assigned dual list: pick a
 * manager by chip, move communities between Unassigned and Assigned. The
 * Unassigned list only ever contains communities with NO manager, so a
 * community owned by someone else cannot be picked -- it has to be removed
 * from its current manager first, which sends it back to Unassigned. Data is
 * GET/PUT/POST /api/community-assignments (netlify/functions/
 * community-assignments.js). Nothing in the shared OLHAuth module, the
 * PAGES/PERMS catalog or olh-auth.js changes: the tab sits behind the same
 * roster.manage gate as the rest of the admin page.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'admin.html');
const APPLY = process.argv.includes('--apply');
const MARKER = '<script type="__bundler/template">';
const enc = (t) => JSON.stringify(t).replace(/<\//g, '<\\u002F');

function slice(content) {
  const i = content.indexOf(MARKER);
  if (i < 0) throw new Error('no __bundler/template block');
  const a = i + MARKER.length;
  const b = content.indexOf('</script>', a);
  return { raw: content.slice(a, b) };
}

const content = fs.readFileSync(FILE, 'utf8');
const { raw } = slice(content);
const tpl = JSON.parse(raw);
if (enc(tpl) !== raw) throw new Error('round-trip encoding check FAILED -- aborting before any edit');
if (tpl.includes('commTab')) throw new Error('already patched (commTab present)');

let out = tpl;
function edit(label, oldStr, newStr) {
  const n = out.split(oldStr).length - 1;
  if (n !== 1) throw new Error(label + ': anchor matched ' + n + ' times, expected exactly 1');
  out = out.replace(oldStr, newStr);
}

/* ---- 1. Markup: the tab body, after Roles & Permissions ------------------ */
const BTN_PRIMARY = 'height:32px;padding:0 14px;border:0;border-radius:4px;background:{{ comm.addBg }};color:#fff;font-size:12px;font-weight:600;cursor:{{ comm.addCursor }};white-space:nowrap;opacity:{{ comm.addOpacity }};pointer-events:{{ comm.addPointer }}';
const BTN_PRIMARY_R = 'height:32px;padding:0 14px;border:0;border-radius:4px;background:#005DAA;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap';
const BTN_GHOST_A = 'height:32px;padding:0 14px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:{{ comm.addCursor }};white-space:nowrap;opacity:{{ comm.addOpacity }};pointer-events:{{ comm.addPointer }}';
const BTN_GHOST = 'height:32px;padding:0 14px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap';
const LIST_HEAD = 'padding:10px 14px;border-bottom:1px solid #D8CFBE;background:#F6F2EA;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#6F6963';
const ROW = (list) =>
  '                <sc-for list="{{ comm.' + list + ' }}" as="it" hint-placeholder-count="4">\n' +
  '                  <button sc-camel-on-click="{{ it.onToggle }}" title="{{ it.title }}" aria-label="{{ it.title }}" style="display:flex;width:100%;align-items:flex-start;gap:10px;padding:9px 14px;border:0;border-bottom:1px solid #F1EBE1;background:{{ it.rowBg }};text-align:left;cursor:pointer">\n' +
  '                    <span style="margin-top:1px;width:17px;height:17px;flex:0 0 auto;border:1px solid {{ it.border }};border-radius:4px;background:{{ it.bg }};color:{{ it.color }};font-size:11px;line-height:15px;text-align:center">{{ it.glyph }}</span>\n' +
  '                    <span style="display:flex;flex-direction:column;gap:2px;min-width:0">\n' +
  '                      <b style="font-size:12.5px;font-weight:600;letter-spacing:.012em">{{ it.label }}</b>\n' +
  '                      <span style="font-size:11px;line-height:1.4;color:#908A82;text-wrap:pretty">{{ it.note }}</span>\n' +
  '                    </span>\n' +
  '                  </button>\n' +
  '                </sc-for>\n';

const MARKUP =
'\n    <sc-if value="{{ commTab }}" hint-placeholder-val="{{ false }}">\n' +
'      <section style="display:flex;flex-direction:column;gap:14px">\n' +
'\n' +
'        <sc-if value="{{ commError }}" hint-placeholder-val="{{ false }}">\n' +
'          <div style="padding:11px 15px;border:1px solid #EFCFCF;border-radius:8px;background:#FBEDED;font-size:12.5px;font-weight:500;line-height:1.5;color:#AA1F23;text-wrap:pretty">{{ commError }}</div>\n' +
'        </sc-if>\n' +
'        <sc-if value="{{ commMsg }}" hint-placeholder-val="{{ false }}">\n' +
'          <div style="padding:11px 15px;border:1px solid #E4DED2;border-radius:8px;background:#fff;font-size:12.5px;font-weight:500;line-height:1.5;color:{{ commMsgColor }};text-wrap:pretty">{{ commMsg }}</div>\n' +
'        </sc-if>\n' +
'\n' +
'        <sc-if value="{{ comm.loading }}" hint-placeholder-val="{{ false }}">\n' +
'          <span style="padding:18px 16px;border:1px solid #E4DED2;border-radius:12px;background:#fff;font-size:13px;color:#908A82">Loading communities and assignments\u2026 this reads every active homesite, so it can take up to half a minute.</span>\n' +
'        </sc-if>\n' +
'\n' +
'        <sc-if value="{{ comm.ready }}" hint-placeholder-val="{{ true }}">\n' +
'\n' +
'        <sc-if value="{{ comm.dupes }}" hint-placeholder-val="{{ false }}">\n' +
'          <div style="padding:11px 15px;border:1px solid #E7D6B4;border-radius:8px;background:#FFFCF4;font-size:12.5px;font-weight:500;line-height:1.5;color:#83553C;text-wrap:pretty">{{ comm.dupeNote }}</div>\n' +
'        </sc-if>\n' +
'\n' +
'        <div style="display:flex;flex-direction:column;gap:7px">\n' +
'          <span style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">\n' +
'            <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:#908A82">Manager</span>\n' +
'            <span style="font-size:12px;color:#908A82;text-wrap:pretty">Pick a manager, then move communities between Unassigned and Assigned. Nothing takes effect until you save.</span>\n' +
'          </span>\n' +
'          <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">\n' +
'            <sc-for list="{{ comm.mgrChips }}" as="mc" hint-placeholder-count="3">\n' +
'              <button sc-camel-on-click="{{ mc.onClick }}" style="height:32px;padding:0 15px;border:1px solid {{ mc.border }};border-radius:999px;background:{{ mc.bg }};color:{{ mc.color }};font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background 160ms cubic-bezier(.2,.6,.2,1)">{{ mc.label }}</button>\n' +
'            </sc-for>\n' +
'            <sc-raw-select value="{{ comm.otherValue }}" sc-camel-on-change="{{ comm.onOther }}" aria-label="Pick another manager" style="height:32px;padding:0 8px;border:1px solid #BFB8AB;border-radius:999px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer;max-width:100%">\n' +
'              <sc-for list="{{ comm.otherOptions }}" as="mo" hint-placeholder-count="6">\n' +
'                <option value="{{ mo.value }}">{{ mo.label }}</option>\n' +
'              </sc-for>\n' +
'            </sc-raw-select>\n' +
'          </span>\n' +
'          <span style="font-size:12px;color:#6F6963;text-wrap:pretty">{{ comm.selNote }}</span>\n' +
'        </div>\n' +
'\n' +
'        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:stretch">\n' +
'\n' +
'          <div style="flex:1 1 260px;min-width:220px;display:flex;flex-direction:column;border:1px solid #E4DED2;border-radius:12px;background:#fff;overflow:hidden">\n' +
'            <span style="' + LIST_HEAD + '">Unassigned ({{ comm.availLabel }})</span>\n' +
'            <input type="search" value="{{ comm.q }}" sc-camel-on-change="{{ comm.onQ }}" placeholder="Filter communities\u2026" aria-label="Filter unassigned communities" style="height:34px;margin:8px 10px;padding:0 10px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030">\n' +
'            <div style="max-height:360px;overflow:auto">\n' +
ROW('avail') +
'              <sc-if value="{{ comm.availEmpty }}" hint-placeholder-val="{{ false }}">\n' +
'                <span style="display:block;padding:16px 14px;font-size:12px;color:#908A82">{{ comm.availEmptyNote }}</span>\n' +
'              </sc-if>\n' +
'            </div>\n' +
'          </div>\n' +
'\n' +
'          <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:4px 0">\n' +
'            <div style="display:flex;flex-direction:column;gap:8px">\n' +
'              <button sc-camel-on-click="{{ comm.onAdd }}" style="' + BTN_PRIMARY + '">Add &gt;</button>\n' +
'              <button sc-camel-on-click="{{ comm.onRemove }}" style="' + BTN_PRIMARY_R + '" style-hover="background:#203F7C">&lt; Remove</button>\n' +
'              <button sc-camel-on-click="{{ comm.onAddAll }}" style="' + BTN_GHOST_A + '">Add All &gt;&gt;</button>\n' +
'              <button sc-camel-on-click="{{ comm.onRemoveAll }}" style="' + BTN_GHOST + '" style-hover="background:#F1EBE1">&lt;&lt; Remove All</button>\n' +
'            </div>\n' +
'          </div>\n' +
'\n' +
'          <div style="flex:1 1 260px;min-width:220px;display:flex;flex-direction:column;border:1px solid #E4DED2;border-radius:12px;background:#fff;overflow:hidden">\n' +
'            <span style="' + LIST_HEAD + '">{{ comm.assignedHead }}</span>\n' +
'            <div style="max-height:402px;overflow:auto">\n' +
ROW('assigned') +
'              <sc-if value="{{ comm.assignedEmpty }}" hint-placeholder-val="{{ false }}">\n' +
'                <span style="display:block;padding:16px 14px;font-size:12px;color:#908A82">{{ comm.assignedEmptyNote }}</span>\n' +
'              </sc-if>\n' +
'            </div>\n' +
'          </div>\n' +
'\n' +
'        </div>\n' +
'\n' +
'        <span style="font-size:11.5px;line-height:1.5;color:#908A82;text-wrap:pretty">{{ comm.hiddenNote }}</span>\n' +
'\n' +
'        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">\n' +
'          <span style="font-size:12px;font-weight:500;color:{{ comm.noteColor }};text-wrap:pretty">{{ comm.note }}</span>\n' +
'          <span style="margin-left:auto;display:flex;align-items:center;gap:9px;flex-wrap:wrap">\n' +
'            <sc-if value="{{ comm.showApply }}" hint-placeholder-val="{{ false }}">\n' +
'              <button sc-camel-on-click="{{ comm.onApply }}" style="height:34px;padding:0 14px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#005DAA;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#EAF2F9">Update Homesites Now</button>\n' +
'            </sc-if>\n' +
'            <button sc-camel-on-click="{{ comm.onDiscard }}" style="height:34px;padding:0 14px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#F1EBE1">{{ comm.discardLabel }}</button>\n' +
'            <button sc-camel-on-click="{{ comm.onSave }}" style="height:34px;padding:0 18px;border:0;border-radius:4px;background:{{ comm.saveBg }};color:{{ comm.saveColor }};font-size:12.5px;font-weight:600;cursor:{{ comm.saveCursor }};white-space:nowrap" style-hover="background:#203F7C">{{ comm.saveLabel }}</button>\n' +
'          </span>\n' +
'        </div>\n' +
'\n' +
'        <span style="font-size:11.5px;line-height:1.5;color:#908A82;text-wrap:pretty">{{ comm.footnote }}</span>\n' +
'\n' +
'        </sc-if>\n' +
'      </section>\n' +
'    </sc-if>\n';

edit('markup', '\n  </main>\n  </sc-if>\n\n  <sc-if value="{{ form }}"', MARKUP + '\n  </main>\n  </sc-if>\n\n  <sc-if value="{{ form }}"');

/* ---- 2. State ------------------------------------------------------------- */
edit('state',
  'matrixRole: "qam", matrixSel: { pAvail: [], pAssigned: [], cAvail: [], cAssigned: [] }\n  };',
  'matrixRole: "qam", matrixSel: { pAvail: [], pAssigned: [], cAvail: [], cAssigned: [] },\n' +
  '    comm: null, commLoading: false, commError: "", commMsg: "", commMsgOk: false,\n' +
  '    commDraft: {}, commMgr: null, commSel: { avail: [], assigned: [] }, commQ: "", commSaving: false\n' +
  '  };');

/* ---- 3. Methods, before renderVals --------------------------------------- */
const METHODS = String.raw`
  /* ---- Community Assignments tab -----------------------------------------
     One manager per community, enforced server-side by the Community
     Assignments table having one row per community. The page keeps a draft
     of {communityKey: managerId|null} on top of what the server returned, so
     nothing changes until Save, and every change carries the manager the
     page believed owned it ("from") so a concurrent edit is refused rather
     than silently overwritten. */
  async commFetch(method, body) {
    const headers = window.OLHAuth.authHeaders(body ? { "Content-Type": "application/json" } : {});
    const res = await fetch("/api/community-assignments", {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().then(d => d, () => null);
    if (!res.ok) {
      const e = new Error((data && data.error) || ("The server answered " + res.status + "."));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  ensureComm() {
    if (!this.state.comm && !this.state.commLoading) this.loadComm();
  }

  defaultCommMgr(data, keep) {
    const ms = (data && data.managers) || [];
    if (keep && ms.some(m => m.id === keep)) return keep;
    const holders = {};
    ((data && data.communities) || []).forEach(c => { if (c.managerId) holders[c.managerId] = true; });
    const first = ms.filter(m => holders[m.id])[0];
    return first ? first.id : null;
  }

  async loadComm() {
    if (window.OLHAuth && window.OLHAuth.isDemo()) {
      this.setState({ commError: "Community assignments need the live backend. This preview has no server to read them from." });
      return;
    }
    this.setState({ commLoading: true, commError: "", commMsg: "" });
    try {
      const data = await this.commFetch("GET");
      this.setState(s => ({
        comm: data, commLoading: false, commDraft: {},
        commSel: { avail: [], assigned: [] },
        commMgr: this.defaultCommMgr(data, s.commMgr)
      }));
    } catch (err) {
      this.setState({ commLoading: false,
        commError: "Could not load community assignments \u2014 " + ((err && err.message) || "the server did not answer") + " Reload the page to try again." });
    }
  }

  commChanges() {
    const d = this.state.comm;
    const draft = this.state.commDraft || {};
    if (!d) return [];
    return d.communities
      .filter(c => Object.prototype.hasOwnProperty.call(draft, c.key) && draft[c.key] !== (c.managerId || null))
      .map(c => ({ community: c.community, from: c.managerId || null, to: draft[c.key] }));
  }

  commSet(keys, to) {
    const d = this.state.comm;
    if (!d || !keys.length) return;
    const server = {};
    d.communities.forEach(c => { server[c.key] = c.managerId || null; });
    const next = Object.assign({}, this.state.commDraft);
    keys.forEach(k => { if (server[k] === to) delete next[k]; else next[k] = to; });
    this.setState({ commDraft: next, commSel: { avail: [], assigned: [] }, commMsg: "", commError: "" });
  }

  toggleCommSel(list, key) {
    const sel = this.state.commSel || { avail: [], assigned: [] };
    const cur = sel[list] || [];
    const next = cur.indexOf(key) >= 0 ? cur.filter(k => k !== key) : cur.concat([key]);
    this.setState({ commSel: Object.assign({}, sel, { [list]: next }) });
  }

  /* Pushes the saved assignments onto Jobs.'Area Construction Manager'. The
     server works for a time budget and reports what is left, so keep asking
     until nothing is, or until a call makes no progress. */
  async drainApply(remaining) {
    let updated = 0;
    let left = remaining;
    let rounds = 0;
    while (left > 0 && rounds < 40) {
      rounds += 1;
      this.setState({ commMsgOk: true, commMsg: "Updating homesites \u2014 " + left + " to go\u2026" });
      const r = await this.commFetch("POST", { action: "apply" });
      updated += r.updated || 0;
      if (!r.updated && r.remaining > 0) { left = r.remaining; break; }
      left = r.remaining || 0;
    }
    return { updated, left };
  }

  async saveComm() {
    const changes = this.commChanges();
    if (!changes.length || this.state.commSaving) return;
    this.setState({ commSaving: true, commError: "", commMsgOk: true, commMsg: "Saving\u2026" });
    let res = null;
    try {
      res = await this.commFetch("PUT", { changes });
    } catch (err) {
      const stale = err && err.status === 409;
      this.setState({ commSaving: false, commMsg: "",
        commError: "Not saved \u2014 " + ((err && err.message) || "the server rejected the change.") +
          (stale ? " Click Reload to see the current assignments." : " Your changes are still shown; try Save again.") });
      return;
    }
    // From here the assignments ARE saved; only the homesite update can fail.
    const n = res.saved || 0;
    const first = (res.apply && res.apply.updated) || 0;
    try {
      const rest = await this.drainApply((res.apply && res.apply.remaining) || 0);
      const data = await this.commFetch("GET");
      const homes = first + rest.updated;
      this.setState(s => ({
        comm: data, commDraft: {}, commSel: { avail: [], assigned: [] }, commSaving: false,
        commMgr: this.defaultCommMgr(data, s.commMgr),
        commMsgOk: rest.left === 0,
        commMsg: rest.left === 0
          ? "Saved " + n + (n === 1 ? " change" : " changes") + " \u2014 " + homes + (homes === 1 ? " homesite" : " homesites") + " now show the new manager."
          : "Saved " + n + (n === 1 ? " change" : " changes") + ", but " + rest.left + " homesites still show the old manager. Click Update Homesites Now, or the nightly sync will finish it."
      }));
    } catch (err) {
      this.setState({ commSaving: false, commDraft: {}, commMsg: "",
        commError: "Saved " + n + (n === 1 ? " change" : " changes") + ", but updating the homesites stopped: " +
          ((err && err.message) || "the server did not answer") + " Click Reload, then Update Homesites Now. The nightly sync will also catch up." });
      this.loadComm();
    }
  }

  async applyComm() {
    if (this.state.commSaving) return;
    this.setState({ commSaving: true, commError: "", commMsg: "" });
    try {
      const rest = await this.drainApply((this.state.comm && this.state.comm.pendingApply) || 1);
      const data = await this.commFetch("GET");
      this.setState({ comm: data, commSaving: false, commMsgOk: rest.left === 0,
        commMsg: rest.left === 0
          ? rest.updated + (rest.updated === 1 ? " homesite" : " homesites") + " updated to match the assignments."
          : rest.updated + " homesites updated; " + rest.left + " still differ. Try again, or the nightly sync will finish it." });
    } catch (err) {
      this.setState({ commSaving: false, commMsg: "",
        commError: "Updating homesites stopped: " + ((err && err.message) || "the server did not answer") + " The assignments themselves are unchanged." });
    }
  }

  commVals() {
    const s = this.state;
    const d = s.comm;
    if (!d) return { loading: !!s.commLoading, ready: false };
    const draft = s.commDraft || {};
    const has = k => Object.prototype.hasOwnProperty.call(draft, k);
    const eff = c => has(c.key) ? draft[c.key] : (c.managerId || null);
    const mgrs = d.managers || [];
    const byId = {};
    mgrs.forEach(m => { byId[m.id] = m; });
    const counts = {}, homes = {};
    d.communities.forEach(c => {
      const m = eff(c);
      if (m) { counts[m] = (counts[m] || 0) + 1; homes[m] = (homes[m] || 0) + c.homesites; }
    });
    const selId = s.commMgr && byId[s.commMgr] ? s.commMgr : null;
    const sel = selId ? byId[selId] : null;
    const canAssign = !!(sel && sel.eligible) && !s.commSaving;
    const sels = s.commSel || { avail: [], assigned: [] };
    const q = (s.commQ || "").trim().toLowerCase();
    const unassigned = d.communities.filter(c => !eff(c));
    const availShown = unassigned.filter(c => !q || c.community.toLowerCase().indexOf(q) >= 0);
    const assigned = selId ? d.communities.filter(c => eff(c) === selId) : [];
    const row = (list, c) => {
      const checked = (sels[list] || []).indexOf(c.key) >= 0;
      const moved = has(c.key) && draft[c.key] !== (c.managerId || null);
      const was = moved && c.managerId && byId[c.managerId] ? " \u00b7 was " + byId[c.managerId].name : "";
      return {
        label: c.community,
        note: c.homesites + (c.homesites === 1 ? " active homesite" : " active homesites") + (moved ? " \u00b7 unsaved" + was : ""),
        rowBg: moved ? "#FFFCF4" : "#fff",
        glyph: checked ? "\u2713" : "",
        bg: checked ? "#005DAA" : "#fff",
        color: checked ? "#fff" : "#BFB8AB",
        border: checked ? "#005DAA" : "#BFB8AB",
        title: (checked ? "Unselect \u201c" : "Select \u201c") + c.community + "\u201d",
        onToggle: () => this.toggleCommSel(list, c.key)
      };
    };
    const changes = this.commChanges();
    const dirty = changes.length > 0;
    const others = d.communities.filter(c => { const m = eff(c); return m && m !== selId; }).length;
    const chipIds = mgrs.filter(m => counts[m.id] || m.id === selId).map(m => m.id);
    const unassignedHomes = unassigned.reduce((a, c) => a + c.homesites, 0);
    return {
      loading: false, ready: true,
      dupes: (d.duplicates || []).length > 0,
      dupeNote: "The Community Assignments table has more than one row for " + (d.duplicates || []).join(", ") +
        ". Saving is blocked until the extra row is deleted in Airtable.",
      mgrChips: chipIds.map(id => {
        const m = byId[id], on = id === selId;
        return {
          label: m.name + " \u00b7 " + (counts[id] || 0) + (m.eligible ? "" : " \u00b7 inactive"),
          bg: on ? "#1B2A58" : "#fff", color: on ? "#fff" : "#303030", border: on ? "#1B2A58" : "#BFB8AB",
          onClick: () => this.setState({ commMgr: id, commSel: { avail: [], assigned: [] } })
        };
      }),
      otherValue: "",
      otherOptions: [{ value: "", label: "+ Another manager\u2026" }].concat(
        mgrs.filter(m => m.eligible && !counts[m.id] && m.id !== selId)
          .map(m => ({ value: m.id, label: m.name + " \u2014 " + m.roleLabel + (m.division ? " (" + m.division + ")" : "") }))),
      onOther: e => { const v = e.target.value; if (v) this.setState({ commMgr: v, commSel: { avail: [], assigned: [] } }); },
      selNote: sel
        ? sel.name + ": " + (counts[selId] || 0) + ((counts[selId] || 0) === 1 ? " community" : " communities") + ", " +
          (homes[selId] || 0) + " active homesites." +
          (sel.eligible ? "" : " This person is no longer an active OLH user, so communities can only be removed from them.")
        : "Pick a manager to start.",
      q: s.commQ || "",
      onQ: e => this.setState({ commQ: e.target.value }),
      avail: availShown.map(c => row("avail", c)),
      availLabel: (q ? availShown.length + " of " : "") + unassigned.length + " \u00b7 " + unassignedHomes + " homesites",
      availEmpty: availShown.length === 0,
      availEmptyNote: unassigned.length ? "No unassigned community matches that filter." : "Every community has a manager.",
      assigned: assigned.map(c => row("assigned", c)),
      assignedHead: sel ? "Assigned to " + sel.name + " (" + assigned.length + ")" : "Assigned",
      assignedEmpty: assigned.length === 0,
      assignedEmptyNote: sel ? "Nothing assigned to " + sel.name + " yet." : "Pick a manager above.",
      addBg: canAssign ? "#005DAA" : "#BFB8AB",
      addCursor: canAssign ? "pointer" : "not-allowed",
      addOpacity: canAssign ? "1" : ".5",
      addPointer: canAssign ? "auto" : "none",
      onAdd: () => {
        if (!canAssign) return;
        const open = {};
        unassigned.forEach(c => { open[c.key] = true; });
        this.commSet((sels.avail || []).filter(k => open[k]), selId);
      },
      onAddAll: () => { if (canAssign) this.commSet(availShown.map(c => c.key), selId); },
      onRemove: () => {
        if (!selId || s.commSaving) return;
        const mine = {};
        assigned.forEach(c => { mine[c.key] = true; });
        this.commSet((sels.assigned || []).filter(k => mine[k]), null);
      },
      onRemoveAll: () => { if (selId && !s.commSaving) this.commSet(assigned.map(c => c.key), null); },
      hiddenNote: others + (others === 1 ? " community is" : " communities are") +
        " assigned to other managers and not offered under Unassigned. To move one, open its manager, remove it, then add it here.",
      note: s.commSaving ? "" : dirty ? changes.length + (changes.length === 1 ? " unsaved change" : " unsaved changes") : "",
      noteColor: "#83553C",
      showApply: !dirty && !s.commSaving && d.pendingApply > 0,
      onApply: () => this.applyComm(),
      discardLabel: dirty ? "Discard Changes" : "Reload",
      onDiscard: () => {
        if (s.commSaving) return;
        if (dirty) this.setState({ commDraft: {}, commSel: { avail: [], assigned: [] }, commMsg: "", commError: "" });
        else this.loadComm();
      },
      saveLabel: s.commSaving ? "Saving\u2026" : dirty ? "Save " + changes.length + (changes.length === 1 ? " Change" : " Changes") : "Saved",
      saveBg: dirty && !s.commSaving ? "#005DAA" : "#F1EBE1",
      saveColor: dirty && !s.commSaving ? "#fff" : "#908A82",
      saveCursor: dirty && !s.commSaving ? "pointer" : "not-allowed",
      onSave: () => this.saveComm(),
      footnote: (d.pendingApply > 0 && !dirty
        ? d.pendingApply + " active homesites still show a different Area Construction Manager than these assignments. Update Homesites Now fixes that immediately; otherwise the nightly sync does. "
        : "") +
        "A save updates Area Construction Manager on every active homesite in the communities you changed, and the nightly sync keeps it that way. Closed homesites keep the manager they had when they closed."
    };
  }

`;
edit('methods', '\n  renderVals() {', METHODS + '  renderVals() {');

/* ---- 4. renderVals wiring ------------------------------------------------- */
edit('tabs',
  'tabs: [["users", "Users"], ["roles", "Roles & Permissions"]].map(t => ({',
  'tabs: [["users", "Users"], ["roles", "Roles & Permissions"], ["communities", "Community Assignments"]].map(t => ({');
edit('tabClick',
  'onClick: () => this.setState({ tab: t[0] })\n      })),\n      usersTab:',
  'onClick: () => { this.setState({ tab: t[0] }); if (t[0] === "communities" && admin) this.ensureComm(); }\n      })),\n      usersTab:');
edit('flags',
  '      rolesTab: s.tab === "roles",\n      tabEyebrow: s.tab === "roles" ? "Which Pages Each Role Sees, and What They Can Change" : "Who Can Use the OLH Suite",',
  '      rolesTab: s.tab === "roles",\n' +
  '      commTab: s.tab === "communities",\n' +
  '      comm: (s.tab === "communities" && admin) ? this.commVals() : null,\n' +
  '      commError: s.tab === "communities" ? s.commError : "",\n' +
  '      commMsg: s.tab === "communities" ? s.commMsg : "",\n' +
  '      commMsgColor: s.commMsgOk ? "#0D773C" : "#83553C",\n' +
  '      tabEyebrow: s.tab === "roles" ? "Which Pages Each Role Sees, and What They Can Change"\n' +
  '        : s.tab === "communities" ? "Which Manager Owns Each Community" : "Who Can Use the OLH Suite",');
edit('summary',
  '      summary: s.tab === "roles"\n        ? "Grant a page and it appears on their All Views; take it away and it is hidden and blocked. Changes apply to everyone holding that role."\n',
  '      summary: s.tab === "roles"\n        ? "Grant a page and it appears on their All Views; take it away and it is hidden and blocked. Changes apply to everyone holding that role."\n' +
  '        : s.tab === "communities"\n        ? "Each community has exactly one manager. Their name fills Area Construction Manager on every active homesite in that community."\n');

const newRaw = enc(out);
console.log('template ' + tpl.length + ' -> ' + out.length + ' chars');
if (!APPLY) { console.log('Dry run OK (pass --apply to write).'); process.exit(0); }

if (content.split(raw).length !== 2) throw new Error('raw template slice not unique -- refusing to write');
fs.writeFileSync(FILE, content.split(raw).join(newRaw));

const check = JSON.parse(slice(fs.readFileSync(FILE, 'utf8')).raw);
for (const needle of ['commTab', 'Community Assignments', 'async saveComm(', '{{ commError }}', 'comm.onSave']) {
  if (!check.includes(needle)) throw new Error('verification FAILED: missing ' + needle);
}
console.log('admin.html patched and verified.');
