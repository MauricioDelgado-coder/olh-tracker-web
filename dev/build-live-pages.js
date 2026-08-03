#!/usr/bin/env node
/**
 * Turn a design export into the deployable pages under public/.
 *
 *   node dev/build-live-pages.js <src-folder> <public-dir>
 *
 * Per page, in order:
 *   1. DELETE the demo data. 900 synthetic homesites (recJOB…/recCM…, labelled
 *      "Dynamics Export · 900 homesites") plus the WALK_* reference snapshot.
 *      Removing them is what makes "no page ships fake data" a structural fact
 *      rather than a runtime hope, and it drops ~1 MB per page.
 *   2. Patch the shared auth module so a backend that ANSWERS is never mistaken
 *      for a backend that is absent. See AUTH_PATCHES.
 *   3. Invalidate the components' memo caches inside the existing tick(), so
 *      data arriving after mount re-renders instead of serving a cached empty
 *      computation.
 *   4. Inline dev/live-loader.js, which fetches /api/jobs and /api/walk-config,
 *      sets the globals and fires the olh-data / walk-ref events.
 *
 * Where the demo data lives changed with the 07/31 export. It used to be two
 * compressed assets in the __bundler/manifest, addressed by uuid from a
 * <script src="…"> tag. It is now two plain inline <script> blocks in the
 * template. Both shapes are handled: whichever one the export uses, at least one
 * snapshot must be found on a page declared to carry data, or the build fails.
 * That is the point of the assertion -- the 07/31 export tripped it, which is how
 * the change was noticed instead of shipping 900 invented homesites.
 *
 * Every patch asserts an exact match count, and the emitted payload is re-parsed
 * the way the browser loader does, so a re-export that moves this code fails the
 * build loudly rather than shipping a page stuck on no data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [SRC, PUB] = process.argv.slice(2);
if (!SRC || !PUB) {
  console.error('usage: node dev/build-live-pages.js <src-folder> <public-dir>');
  process.exit(2);
}

const die = (msg) => { console.error('BUILD FAILED: ' + msg); process.exit(1); };
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

const LOADER = fs.readFileSync(path.join(__dirname, 'live-loader.js'), 'utf8');
if (!/\/walk-config/.test(LOADER)) die('live-loader.js does not reference /walk-config');

/* completion-loader.js is GONE (08/01). The Completion Report used to read a
   COMPLETION_DATA global in a flat per-homesite shape and needed its own loader
   to build it; the export now reads window.OLH_DATA.jobs like every other page,
   so it takes the same live-loader.js as the walk pages. */

/** The globals a bundled snapshot defines. Finding any of these means demo data. */
const SNAPSHOT_GLOBALS = ['OLH_DATA', 'WALK_ROSTER', 'WALK_DRIVE', 'WALK_PRODUCT_MAP', 'WALK_COMMUNITIES'];

/**
 * A declaration the bundler will corrupt: var/let/const followed by a
 * lowerCamelCase name.
 *
 * The bundler rewrites camelCase to sc-camel-kebab-case for its own template
 * attributes (sc-camel-on-click). It also applies that rewrite to the copy of
 * each inline script it appends at render time, so `var mkField` is emitted as
 * `var sc-camel-mk-field` -- a syntax error that kills the entire script. The
 * rewrite matches only the declaration, and only when the name starts lowercase
 * and contains an uppercase letter; ALL_CAPS and all-lowercase names are safe.
 *
 * The 07/31 export shipped one of these (`mkField`) and a patch here added a
 * second (`noSess`). Both put "[bundle] SyntaxError: Unexpected token '-'" across
 * the top of every page. This is checked on every build so it cannot come back
 * with the next re-export.
 */
const MANGLED_DECL = /\b(?:var|let|const)\s+([a-z_$][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\s*=/g;

/**
 * Identifiers renamed to survive that rewrite, applied to every page.
 *
 * The rewrite corrupts only the declaration and leaves later uses alone, so
 * `var mkField` becomes an invalid name while the six `mkField(...)` calls below
 * it stay as they were. Renaming just the declaration would therefore trade a
 * syntax error for an undefined function -- every occurrence has to move
 * together, which is why this is a rename pass and not a set of exact-match
 * patches.
 *
 * Names are chosen all-lowercase. Not every page contains every one of these
 * (the xlsx writer only ships on walk-calendar), so a rename matching nothing on
 * a given page is fine; findManglableDecls is the assertion that none was missed.
 *
 *   mkField    auth module, builds the sign-in form's email/password fields
 *   nameBytes  minimal xlsx writer, zip local-header filename bytes
 *   cdSize     minimal xlsx writer, central-directory size
 */
/* The "back to the homepage" link in each page's header.
 *
 * Five of the seven inner pages ship one from the design tool; tracker and
 * completion do not, and a page with no way back to index.html is a dead end
 * for anyone who lands on it from a bookmark. Kept here so both patches below
 * stay identical to the five the export already provides. */
const HOME_LINK =
  '<a href="index.html" style="flex:0 0 auto;font-size:12.5px;font-weight:500;' +
  'color:#BFB8AB;white-space:nowrap">← All Views</a>';

const MANGLE_SAFE_RENAMES = [
  ['mkField', 'mkfield'],
  ['nameBytes', 'namebytes'],
  ['cdSize', 'cdsize']
];

/* --- the shared auth module ------------------------------------------------
 *
 * Every page in the export inlines the same 134 KB "OLH shared authentication +
 * change tracking" module. It was written to degrade to a local DEMO mode when
 * no backend is reachable, which is the right instinct for a design prototype
 * and the wrong one for the deployed site: its fallbacks trigger on ANY failed
 * request, including a 401 from a live server.
 *
 * Left alone, that means a wrong password signs you in against the bundled
 * roster, a rejected audit write lands in localStorage instead, and a 403 on
 * /users quietly shows a fabricated directory. All four patches below draw the
 * same line: err.status exists only when the server answered, and an answer --
 * including a refusal -- is authoritative. Demo mode is reserved for a genuine
 * network failure or the 3.5s timeout.
 */
const AUTH_PATCHES = [
  // NOTE for anyone adding a patch here: do NOT introduce a `var`/`let`/`const`
  // whose name is lowerCamelCase. See MANGLED_DECL below -- the bundler rewrites
  // exactly that form and the resulting identifier is a syntax error. This patch
  // used `var noSess` for one deploy and produced a red error banner on every
  // page. Assign onto the error object instead of declaring a variable.
  ['session: a 200 with no user is still a real answer',
   '        if (!data || !data.user) throw new Error("no session");',
   '        if (!data || !data.user) throw Object.assign(new Error("no session"), { status: 401 });'],


  ['restore: an HTTP status means the backend is alive',
   '      }).catch(function () {\n' +
   '        state.demo = true;\n' +
   '        state.user = stored && stored.user ? stored.user : null;\n' +
   '      }).then(function () {\n' +
   '        return Auth.loadMatrix().catch(function () {});',
   '      }).catch(function (err) {\n' +
   '        // A backend that ANSWERED -- 401 for no session, 403 for suspended --\n' +
   '        // is a live backend, and being signed out is not preview mode. Only a\n' +
   '        // network failure or the timeout above may fall back to demo.\n' +
   '        if (err && err.status) {\n' +
   '          state.demo = false; state.user = null; state.token = null;\n' +
   '          try { localStorage.removeItem(SESSION_KEY); } catch (e) {}\n' +
   '          return;\n' +
   '        }\n' +
   '        state.demo = true;\n' +
   '        state.user = stored && stored.user ? stored.user : null;\n' +
   '      }).then(function () {\n' +
   '        return Auth.loadMatrix().catch(function () {});'],

  ['signIn: a rejected password must not become a demo sign-in',
   '          if (err && err.mustSetPassword) throw err;\n' +
   '          // No backend: fall back to the roster directory.',
   '          if (err && err.mustSetPassword) throw err;\n' +
   '          // The server answered and said no. Falling through to the roster\n' +
   '          // below would turn a wrong password into a successful sign-in.\n' +
   '          if (err && err.status) throw err;\n' +
   '          // No backend: fall back to the roster directory.'],

  ['signIn: name the real problem when the server is unreachable',
   '          if (!hit) throw new Error(state.demo ? "That name is not on the OLH roster." : (err.message || "Sign-in failed."));',
   '          if (!hit) throw new Error(state.demo ? "Cannot reach the OLH server, so sign-in is unavailable. Check your connection and try again." : (err.message || "Sign-in failed."));'],

  ['audit: a rejected write is not a local write',
   '        .catch(function () {\n' +
   '          var log = localLog(); log.push(entry); writeStore(LOG_KEY, log);\n' +
   '          return { entry: entry, conflict: null };\n' +
   '        });',
   '        .catch(function (err) {\n' +
   '          // The Audit Log is append-only and shared. Diverting a refused\n' +
   '          // write into localStorage would leave it missing a change that the\n' +
   '          // person watched succeed on screen.\n' +
   '          if (err && err.status) throw err;\n' +
   '          var log = localLog(); log.push(entry); writeStore(LOG_KEY, log);\n' +
   '          return { entry: entry, conflict: null };\n' +
   '        });'],

  /* Every data endpoint authenticates with Authorization: Bearer <token> and
     nothing else -- bearer() in netlify/lib/olh-auth.js reads that header and
     there is no cookie fallback. OLHAuth.api() sends it, which is why sign-in,
     /session, /users and /roles all work. But the four loaders that fetch
     homesite data were written before the auth gate existed and send no header
     at all, so every one of them got a 401 and every page showed zero rows
     while the user chip in the corner said they were signed in.

     Exposing the token here rather than having each loader reach into
     localStorage keeps one owner of the session. The localStorage fallback
     matters because a loader can boot before the app calls OLHAuth.restore(),
     which is what sets state.token. */
  ['expose the session token so the data loaders can authenticate',
   '    isDemo: function () { return state.demo; },',
   '    isDemo: function () { return state.demo; },\n' +
   '    token: function () {\n' +
   '      if (state.token) return state.token;\n' +
   '      var st = readStore(SESSION_KEY, null);\n' +
   '      return (st && st.token) || "";\n' +
   '    },\n' +
   '    authHeaders: function (extra) {\n' +
   '      var h = extra || {};\n' +
   '      h.Accept = "application/json";\n' +
   '      var tok = Auth.token();\n' +
   '      if (tok) {\n' +
   '        /* Both, deliberately. Azure Static Web Apps overwrites\n' +
   '           Authorization with its own bearer token before a managed\n' +
   '           function sees it (Azure/static-web-apps#158), so on Azure the\n' +
   '           only copy that survives is the one in a header its proxy does\n' +
   '           not recognise. bearer() in netlify/lib/olh-auth.js prefers\n' +
   '           X-OLH-Token and falls back to Authorization, so one build works\n' +
   '           on both hosts and neither header is load-bearing alone. */\n' +
   '        h.Authorization = "Bearer " + tok;\n' +
   '        h["X-OLH-Token"] = "Bearer " + tok;\n' +
   '      }\n' +
   '      return h;\n' +
   '    },'],

  ['users: do not show a fabricated directory when the server refuses',
   '      }).catch(seedUsers);',
   '      }).catch(function (err) { if (err && err.status) throw err; return seedUsers(); });']
];

/* --- per-page work ---------------------------------------------------------
 *
 * data:    page ships the demo snapshots and they must be removed.
 * inject:  page needs live-loader.js. The tracker has its own loadLive();
 *          giving it a second loader would double every fetch.
 * walkRef: page reads WALK_* and so needs /api/walk-config, not just /api/jobs.
 * caches:  memo caches to clear inside tick() when data arrives.
 */
const PAGES = {
  // No data of its own, but it is the sign-in landing page, so it carries the
  // auth module and needs its patches. It used to be a straight copy.
  'index.html': {
    data: false, inject: false, caches: [],
    patches: [
      // "Data updated 7/29/26" was hardcoded into the landing page, which has
      // no data of its own and therefore no way to know. It sat beside links to
      // pages that read Airtable live, so it aged into a false claim. Removed
      // rather than faked: the pages it links to each report their own state.
      ['drop the hardcoded data-updated date',
       '<span style="margin-left:auto;font-size:12.5px;color:#908A82">Data updated 7/29/26</span>',
       '']

      // GONE (08/01 export): "supply isAdmin". The template used to gate the
      // User Administration link on {{ isAdmin }}, which renderVals() never
      // returned, so the link was invisible to everyone including admins. The
      // design now computes canAdmin: this.can("page.admin") itself and gates
      // every tile the same way, so the patch has nothing left to fix. It is
      // deleted rather than re-anchored -- re-adding isAdmin beside canAdmin
      // would leave two answers to one question.
    ]
  },

  /* Rewired by the 08/01 export, which made window.OLH_DATA the single source
   * of truth for the whole suite and deleted completion-data.js and
   * no-coe-data.js. This page now takes the same graft as the walk pages: drop
   * the bundled snapshot, inject live-loader.js, done.
   *
   * Everything the old completionLive path had to patch in, the design now owns
   * and does better, so all three patches are DELETED rather than re-anchored:
   *
   *   - componentDidMount polls for window.OLH_DATA.jobs, listens for the
   *     olh-data event and clears its own row memo. The old patch bolted a
   *     listener onto a mount handler that only watched the viewport.
   *   - stamp() derives the provenance line from OLH_DATA.meta.runDate and
   *     .division, which is why live-loader.js now forwards meta from
   *     /api/jobs. It replaces the hardcoded "Data updated 7/29/26".
   *   - data() applies the report scope in the page itself: started, not
   *     complete, projected completion on or after 7/1/26, lot status B/S/W/M.
   *     That is the same scope commit 1a0e637 put into completion-loader.js, so
   *     the narrowing survives the move -- it is enforced one layer up now.
   *
   * walkRef:false -- the page reads OLH_DATA and nothing WALK_*.
   */
  'completion.html': {
    data: true, inject: true, walkRef: false, caches: [],
    patches: [
      /* The export added three columns sourced from uploads/ACM.xlsx rather
       * than from Salesforce: Homesite Plan Name, Homesite Plan Number and
       * Elevation. The Airtable Jobs table has no such fields and the daily
       * sync has nothing to fill them from, so live they would render a column
       * of em-dashes on every row -- which reads as missing data rather than
       * absent plumbing. Header and body cells are removed together so the two
       * stay aligned.
       *
       * Area Construction Manager is NOT removed: it is derived from the
       * community map and is a real field on the Jobs table. */
      /* Two conditions the design's own scope is missing.
       *
       * Record Status = Active is the important one. The sync ARCHIVES a job
       * when it stops appearing in the Salesforce export -- it stays in
       * Airtable for history and its Salesforce columns freeze at whatever they
       * last were. Frozen means it still looks started-and-unfinished forever,
       * so every archived row matched the scope and stayed on the report for
       * good. 34 of them had accumulated in three days (7/30-8/1) and the count
       * would have kept climbing. They are not open work; they are not in the
       * pull at all any more.
       *
       * Actual COE Date is belt and braces. Every row in the table is blank
       * here today because the whole table comes from the "homesites with no
       * Actual COE" pull, so this changes no count right now -- but that is a
       * property of the upstream query, not of this page, and a closed home has
       * no business on a completion report if the pull ever widens.
       *
       * The 7/1/26 projected-completion floor is deliberately KEPT. It hides 11
       * started-but-unfinished homesites with a projection already in the past
       * (one from 2018) and 3 with no projection at all. Confirmed 08/01 as
       * intended: this report is the forward-looking view, and those 14 are a
       * data-quality question for the tracker rather than rows to schedule
       * against. Scope total: 1,013.
       */
      ['scope the report to live, unclosed homesites',
       'const LOTS = { B: 1, S: 1, W: 1, M: 1 };\n' +
       '    // Report scope: started, not yet complete, projected to finish 7/1/26 or later, lot status B/S/W/M\n' +
       '    const inScope = f => !!iso(f["Actual Start Date"])\n' +
       '      && !iso(f["Actual Completion Date"])\n' +
       '      && iso(f["Projected Completion Date"]) >= "2026-07-01"\n' +
       '      && LOTS[(f["Lot Status"] || "").trim().toUpperCase()] === 1;',
       'const LOTS = { B: 1, S: 1, W: 1, M: 1 };\n' +
       '    // Report scope: still in the Salesforce pull, started, not yet complete,\n' +
       '    // no Actual COE, projected to finish 7/1/26 or later, lot status B/S/W/M\n' +
       '    const inScope = f => (f["Record Status"] || "") === "Active"\n' +
       '      && !!iso(f["Actual Start Date"])\n' +
       '      && !iso(f["Actual Completion Date"])\n' +
       '      && !iso(f["Actual COE Date"])\n' +
       '      && iso(f["Projected Completion Date"]) >= "2026-07-01"\n' +
       '      && LOTS[(f["Lot Status"] || "").trim().toUpperCase()] === 1;'],

      ['drop the plan/elevation body cells (no Airtable source)',
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;' +
       'white-space:nowrap">{{ r.planName }}</sc-raw-td>\n' +
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;' +
       'font-variant-numeric:tabular-nums;white-space:nowrap">{{ r.planNumber }}</sc-raw-td>\n' +
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;' +
       'white-space:nowrap">{{ r.elevation }}</sc-raw-td>\n',
       ''],

      ['drop the plan/elevation column headers',
       ', ["planName", "Homesite Plan Name", "left"], ' +
       '["planNumber", "Homesite Plan Number", "left"], ' +
       '["elevation", "Elevation", "left"]',
       ''],

      ['drop the Plan row from the homesite drawer',
       '\n        { k: "Plan", v: d.planName ? d.planName + ' +
       '(d.elevation ? " \\u00b7 Elevation " + d.elevation : "") : "\\u2014", ' +
       'color: "#303030" },',
       ''],

      // GONE (08/01 export): "re-render when live data arrives", "report the
      // real load state instead of a hardcoded date" and "supply updatedLabel".
      // The page now carries its own olh-data listener and its own stamp() over
      // OLH_DATA.meta, so all three would re-implement what is already there --
      // and the last of them still referenced window.COMPLETION_SOURCE, a
      // global nothing sets any more.

      /* Regroup the right-hand tile from Construction Stage to Community.
       *
       * Stage codes are two digits and told you almost nothing at a glance:
       * "03 - 166" needs the JDE stage table to read. Community is how the
       * division is actually organised and how this report gets used. The tile
       * keeps its behaviour -- click a bar to filter, click again to clear --
       * it just drives the comm filter now instead of stage. Both filters are
       * still available as selects in the Filters card.
       *
       * Still the top 8 by count, deliberately: the tile's height sets the
       * bottom of the whole right-hand column, and there are 50-odd
       * communities. Everything outside the top 8 is reachable from the
       * Community select. */
      ['group the tile by community rather than stage',
       '    // ---- stage bars\n' +
       '    const sBase = this.filtered("stage");\n' +
       '    const sc = {};\n' +
       '    sBase.forEach(r => { if (r.stage) sc[r.stage] = (sc[r.stage] || 0) + 1; });\n' +
       '    const sKeys = Object.keys(sc).sort((a, b) => sc[b] - sc[a]).slice(0, 8);\n' +
       '    const sMax = Math.max(1, ...sKeys.map(k => sc[k]));\n' +
       '    const stageBars = sKeys.map(k => ({\n' +
       '      label: k, count: sc[k], pct: Math.round(sc[k] / sMax * 100),\n' +
       '      color: s.stage === k ? "#005DAA" : "#A8C8E2",\n' +
       '      labelColor: s.stage === k ? "#005DAA" : "#303030",\n' +
       '      onClick: () => this.set({ stage: s.stage === k ? "" : k })\n' +
       '    }));',
       '    // ---- community bars\n' +
       '    const cBase = this.filtered("comm");\n' +
       '    const cc = {};\n' +
       '    cBase.forEach(r => { if (r.community) cc[r.community] = (cc[r.community] || 0) + 1; });\n' +
       '    const cKeys = Object.keys(cc).sort((a, b) => cc[b] - cc[a] || (a < b ? -1 : 1)).slice(0, 8);\n' +
       '    const cMax = Math.max(1, ...cKeys.map(k => cc[k]));\n' +
       '    const commBars = cKeys.map(k => ({\n' +
       '      label: k, count: cc[k], pct: Math.round(cc[k] / cMax * 100),\n' +
       '      color: s.comm === k ? "#005DAA" : "#A8C8E2",\n' +
       '      labelColor: s.comm === k ? "#005DAA" : "#303030",\n' +
       '      title: k + " \\u00b7 " + cc[k] + " homesite" + (cc[k] === 1 ? "" : "s"),\n' +
       '      onClick: () => this.set({ comm: s.comm === k ? "" : k })\n' +
       '    }));'],

      ['retitle the tile',
       '>Homesites by Stage</span>',
       '>Homesites by Community</span>'],

      ['pass the community bars to the view',
       'eddMonths, stageBars,',
       'eddMonths, commBars,'],

      /* Community names are long where stage codes were two digits, so the
       * label column has to carry the width and the bar gives some up. Names
       * are truncated with an ellipsis rather than wrapped -- a wrapped name
       * makes its row taller than the rest, and this tile's height is what the
       * left card is aligned against. The full name is on the button title. */
      ['give the bars room for a community name',
       '<sc-for list="{{ stageBars }}" as="s" hint-placeholder-count="6">\n' +
       '          <button sc-camel-on-click="{{ s.onClick }}" style="display:grid;' +
       'grid-template-columns:34px 1fr 34px;align-items:center;gap:8px;padding:2px 0;' +
       'border:0;background:transparent;cursor:pointer;text-align:left">\n' +
       '            <span style="font-size:11.5px;font-weight:600;color:{{ s.labelColor }};' +
       'font-variant-numeric:tabular-nums">{{ s.label }}</span>',
       '<sc-for list="{{ commBars }}" as="s" hint-placeholder-count="6">\n' +
       '          <button sc-camel-on-click="{{ s.onClick }}" title="{{ s.title }}" style="display:grid;' +
       'grid-template-columns:minmax(0,1fr) 72px 34px;align-items:center;gap:8px;padding:2px 0;' +
       'border:0;background:transparent;cursor:pointer;text-align:left">\n' +
       '            <span style="font-size:11.5px;font-weight:600;color:{{ s.labelColor }};' +
       'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.label }}</span>'],

      /* Align the bottom of the Filters card with the rest of the top row.
       *
       * The three panels share one grid row under align-items:start, so each is
       * only as tall as its own content and the Filters card -- the shortest --
       * left a ragged edge under the EDD slicer.
       *
       * align-self:stretch rather than a taller slicer. A pixel nudge can only
       * be right for one data state: the row is as tall as the tallest panel,
       * and the tallest panel is the community tile, whose height is however
       * many bars the current filters leave (8 normally, 1 when a community is
       * selected). Stretch tracks that for free, at any viewport, and the
       * slicer absorbs the slack because it is the only growable child.
       *
       * Bar heights move from px to % for the same reason -- a 40px-scaled bar
       * in a box that is now taller would just sit at the bottom with headroom
       * above it. As a percentage the chart actually fills the space it was
       * given, which is the "longer slicer" this was asked for. */
      /* The calendar is the third panel in that row and was left 54px short by
       * the same align-items:start, so fixing only the Filters card just moved
       * the ragged edge. Its week rows take the slack via grid-auto-rows:1fr --
       * a few px per row, which reads as slightly roomier day cells rather than
       * a card with a gap at the bottom. */
      ['let the calendar card fill the row',
       '<section style="border:1px solid #E4DED2;border-radius:12px;background:#fff;' +
       'box-shadow:0 1px 2px rgba(27,42,88,.05);overflow:hidden">',
       '<section style="display:flex;flex-direction:column;align-self:stretch;' +
       'border:1px solid #E4DED2;border-radius:12px;background:#fff;' +
       'box-shadow:0 1px 2px rgba(27,42,88,.05);overflow:hidden">'],

      ['let the calendar weeks take the slack',
       '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;' +
       'padding:2px 10px 12px">',
       '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;' +
       'padding:2px 10px 12px;flex:1 1 auto;grid-auto-rows:1fr">'],

      ['let the Filters card fill the row',
       '<section style="display:flex;flex-direction:column;gap:10px;min-width:0;' +
       'padding:12px 14px 14px;border:1px solid #E4DED2;border-radius:12px;' +
       'background:#fff;box-shadow:0 1px 2px rgba(27,42,88,.05)">',
       '<section style="display:flex;flex-direction:column;gap:10px;min-width:0;' +
       'align-self:stretch;padding:12px 14px 14px;border:1px solid #E4DED2;' +
       'border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(27,42,88,.05)">'],

      ['let the EDD slicer absorb the extra height',
       '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px">\n' +
       '        <span style="font-size:11px;font-weight:600;color:#6F6963">' +
       'EDD Range \u00b7 click months to filter</span>\n' +
       '        <div style="display:flex;align-items:flex-end;gap:3px;height:58px">',
       '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px;' +
       'flex:1 1 auto;min-height:0">\n' +
       '        <span style="font-size:11px;font-weight:600;color:#6F6963">' +
       'EDD Range \u00b7 click months to filter</span>\n' +
       '        <div style="display:flex;align-items:flex-end;gap:3px;' +
       'flex:1 1 auto;min-height:58px">'],

      ['scale the month bars to the space they are given',
       'h: Math.max(4, Math.round(mc[k] / max * 40)),',
       'h: Math.max(5, Math.round(mc[k] / max * 100)),'],

      ['draw the month bars as a share of the slicer height',
       '<span style="width:100%;height:{{ m.h }}px;border-radius:2px 2px 0 0;',
       '<span style="width:100%;height:{{ m.h }}%;border-radius:2px 2px 0 0;'],

      ['give the header a path back to the homepage',
       '<span style="margin-left:auto"><olh-user-chip style="flex:0 0 auto">' +
       '</olh-user-chip></span>',
       '<span style="margin-left:auto;display:flex;align-items:center;gap:14px">' +
       '<olh-user-chip style="flex:0 0 auto"></olh-user-chip>' +
       '<span style="width:1px;height:22px;background:rgba(255,255,255,.28)"></span>' +
       HOME_LINK + '</span>']
    ]
  },

  'scheduler.html': { data: true, inject: true, walkRef: true, caches: ['_sites', '_byLen', '_unmapped'] },
  'workload.html': { data: true, inject: true, walkRef: true, caches: ['_walks', '_byLen', '_unattributed'] },

  // A second workload view from the same design export: same three memo caches,
  // same snapshots, same graft. Carries no loadLive() of its own.
  'workload-visualizer.html': { data: true, inject: true, walkRef: true, caches: ['_walks', '_byLen', '_unattributed'] },

  // The Walk Schedule Export reads all four walk globals -- walkRoster()/qams()
  // off WALK_ROSTER, drive() off WALK_DRIVE, core() off WALK_PRODUCT_MAP and
  // WALK_COMMUNITIES -- so it needs walk-config. It also memoises its community
  // index lazily and mounts before the fetch lands, freezing the index as [];
  // the caches mechanism cannot clear it because that patches "const tick = …"
  // and this page's handler is "this._h = …", hence the explicit patch.
  'walk-calendar.html': {
    data: true, inject: true, walkRef: true, caches: [],
    patches: [
      ['invalidate the community index when reference data arrives',
       'this._h = () => this.setState({ ready: true });',
       'this._h = () => { this._byLen = null; this.setState({ ready: true }); };']
    ]
  },

  // The tracker ships its own loadLive() and the /update-job write path. It
  // still needs the fixture gone: its catch block left window.OLH_DATA pointing
  // at the mock and componentDidMount called loadLive(false, false) --
  // announce=false -- so a failed FIRST load rendered fabricated records with no
  // message at all.
  'tracker.html': {
    data: true, inject: false, caches: [],
    patches: [
      /* The first load must WAIT for the auth module, and must announce when
       * it fails.
       *
       * Two bugs, one patch. The original call was loadLive(false, false) --
       * announce=false -- so a failed first load rendered nothing and said
       * nothing.
       *
       * The wait is new in 08/2026 and is the more serious of the two. The auth
       * module used to be inlined in the template and was therefore defined
       * before any component mounted; the 08/01 export ships it as a manifest
       * asset that the bundler injects asynchronously. loadLive reads
       * OLHAuth.authHeaders() directly, so mounting first threw "undefined is
       * not an object (evaluating \'window.OLHAuth.authHeaders\')" straight into
       * the error toast. Even a null-safe header would not have been right:
       * /api/jobs answers 401 without an Authorization header, so the page
       * would still show an empty grid over a problem that was only ordering.
       *
       * Same 6s budget and the same polling shape as the design\'s own
       * _wireAuth, which exists for exactly this reason. Past it, the toast
       * names the real cause instead of a type error. */
      ['wait for the auth module, then load, and announce a failure',
       'this.loadLive(false, false);',
       'this._loadWhenAuthed(0);'],

      ['add the auth-aware load and header helpers',
       '  /* olh-auth.js is a helmet script and may not have run yet in the bundled\n' +
       '     build, so keep looking for it rather than giving up on first miss. */\n' +
       '  _wireAuth(tries) {',
       '  /* Authorization header or a legible failure -- never an anonymous\n' +
       '     request. Every data endpoint reads Bearer and has no cookie\n' +
       '     fallback, so a request without this header is a guaranteed 401. */\n' +
       '  _authHeaders(extra) {\n' +
       '    if (!window.OLHAuth || typeof window.OLHAuth.authHeaders !== "function") {\n' +
       '      throw new Error("The sign-in module has not loaded, so this page cannot authenticate. Reload the page.");\n' +
       '    }\n' +
       '    return window.OLHAuth.authHeaders(extra);\n' +
       '  }\n' +
       '\n' +
       '  /* The auth module is a bundler asset and may not have executed when this\n' +
       '     component mounts. Wait for it rather than firing an unauthenticated\n' +
       '     read that can only 401. */\n' +
       '  _loadWhenAuthed(tries) {\n' +
       '    if (window.OLHAuth && typeof window.OLHAuth.authHeaders === "function") {\n' +
       '      this.loadLive(false, true);\n' +
       '      return;\n' +
       '    }\n' +
       '    if (tries < 120) {\n' +
       '      this._loadT = setTimeout(() => this._loadWhenAuthed(tries + 1), 50);\n' +
       '      return;\n' +
       '    }\n' +
       '    this.setState({ loading: false });\n' +
       '    this.toast("err", "Could Not Load Homesite Data",\n' +
       '      "The sign-in module did not load, so this page cannot authenticate. Reload the page." +\n' +
       '      " No homesite records are shown \\u2014 this page does not fall back to sample data.");\n' +
       '  }\n' +
       '\n' +
       '  /* olh-auth.js is a helmet script and may not have run yet in the bundled\n' +
       '     build, so keep looking for it rather than giving up on first miss. */\n' +
       '  _wireAuth(tries) {'],
      ['drop the sample-records promise',
       "' Showing sample records instead.'",
       "' No homesite records are shown — this page does not fall back to sample data.'"],

      // The status line reads window.OLH_DATA.source and falls through to
      // "Sample data" for anything it does not recognise, so a tracker showing
      // zero rows labelled itself "Sample data · —" -- announcing fake data while
      // displaying none. Someone reading that concludes the zeros are
      // placeholders rather than a failure to load.
      //
      // The fallback is replaced outright rather than made conditional on
      // source==='error'. The tracker carries its own loadLive() and gets no
      // injected loader, so nothing sets window.OLH_DATA at all when the fetch
      // fails -- src is undefined, not 'error', and a conditional on 'error'
      // silently did nothing (it shipped once that way). With the fixture deleted
      // there is no sample data on this page in any state, so the branch cannot
      // legitimately be reached and saying "Sample data" is never correct.
      ['do not call an empty tracker "Sample data"',
       "return 'Sample data · ' + when;",
       "return 'No data loaded · ' + when;"],

      // The tracker has its own loadLive()/persist() and never went through
      // OLHAuth.api(), so both its read and its write were anonymous. The read
      // returned 401 and rendered an empty grid; the write would have failed
      // the same way on the first edit anyone tried to save.
      ['authenticate the tracker read',
       "        {headers:{Accept:'application/json'}});",
       '        {headers: this._authHeaders()});'],

      ['authenticate the tracker write',
       "        headers:{'Content-Type':'application/json', Accept:'application/json'},",
       "        headers: this._authHeaders({'Content-Type':'application/json'}),"],

      // The only inner page with no way back to index.html besides completion.
      ['give the header a path back to the homepage',
       'color:#303030">Refresh</button>\n  </header>',
       'color:#303030">Refresh</button>\n    ' + HOME_LINK + '\n  </header>']
    ]
  },

  // New in the 07/31 export: the user + permissions console. There is no email
  // provider, so POST /api/invite returns the one-time link instead of mailing
  // it, and the admin sends it themselves. The stock button fires invite() and
  // throws the response away, which would leave the link nowhere; the patch puts
  // it on the clipboard and says so.
  'admin.html': {
    data: true, inject: true, walkRef: true, caches: [],
    patches: [
      ['surface the invite link instead of discarding it',
       '            window.OLHPasswords.invite(u.id);\n' +
       '            this.setState(st => ({ sent: Object.assign({}, st.sent, { [u.id]: 1 }) }));',
       '            window.OLHPasswords.invite(u.id).then(d => {\n' +
       '              // No mail is sent. The link is shown once and must reach the\n' +
       '              // person some other way, so put it on the clipboard.\n' +
       '              var url = d && d.inviteUrl;\n' +
       '              if (url) { try { navigator.clipboard.writeText(url); } catch (e) {} }\n' +
       '              this.setState(st => ({ sent: Object.assign({}, st.sent, { [u.id]: url ? 2 : 1 }) }));\n' +
       '            }).catch(() => {\n' +
       '              this.setState(st => ({ sent: Object.assign({}, st.sent, { [u.id]: 3 }) }));\n' +
       '            });'],
      // The console gated on u.role === "admin" while the Roles & Permissions
      // grid it renders lets an admin grant roster.manage to any role -- so
      // ticking "Manage users & permissions" for, say, Leadership did nothing.
      // ROLE_LOCKS pins roster.manage to the Admin role in both the browser
      // module and netlify/lib/olh-auth.js, so reading the live matrix here
      // cannot lock every admin out of the console.
      ['gate the console on roster.manage rather than the role name',
       '  isAdmin(u) { return !!(u && u.role === "admin"); }',
       '  isAdmin(u) {\n' +
       '    if (!u) return false;\n' +
       '    const roles = window.OLHAuth && window.OLHAuth.roles;\n' +
       '    const r = roles && roles[u.role];\n' +
       '    return r ? r.can.indexOf("roster.manage") >= 0 : u.role === "admin";\n' +
       '  }'],

      ['name the missing capability on the blocked screen',
       'blockedTitle: "This Console Is for Admins"',
       'blockedTitle: "You Cannot Manage the Roster"'],

      ['explain the blocked screen in terms of the capability',
       '"). Managing who can use the OLH Suite is limited to admins \\u2014 ask one to change your role if you need access."',
       '"). Managing who can use the OLH Suite needs the \\u201cManage users & permissions\\u201d capability \\u2014 ask an admin to grant it to your role, or to change your role."'],

      ['label the copied link',
       'resendLabel: s.sent[u.id] ? "Invite Sent" : "Resend Invite",',
       'resendLabel: s.sent[u.id] === 2 ? "Link Copied \\u2014 Paste Into an Email"\n' +
       '            : s.sent[u.id] === 3 ? "Could Not Create Link \\u2014 Try Again"\n' +
       '            : s.sent[u.id] ? "Invite Created" : "Resend Invite",']
    ]
  }
};

/* --- bundle helpers -------------------------------------------------------- */

/**
 * Pages in the publish directory that are legitimately not design bundles.
 *
 * Deliberately a short, explicit list rather than a shape test: see the comment
 * in checkStaticRefs(). Anything else with an .html extension in publish is
 * something nobody declared, and publish is served.
 */
const HAND_WRITTEN_PAGES = ['404.html'];

/**
 * Is this file a design-tool bundle at all?
 *
 * loadBundle() is deliberately fatal on a malformed bundle -- a page declared in
 * PAGES that has lost its manifest is a broken export and must stop the build.
 * But "not a bundle" and "a broken bundle" are different facts, and only the
 * caller knows which one is an error. checkStaticRefs() walks every .html in the
 * publish directory, where hand-written pages legitimately live.
 */
function isBundle(file) {
  return fs.readFileSync(file, 'utf8').includes('<script type="__bundler/manifest">');
}

function loadBundle(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const find = (type) => {
    const i = lines.findIndex((l) => l.includes('<script type="__bundler/' + type + '">'));
    if (i === -1) die(path.basename(file) + ': no __bundler/' + type + ' block');
    return i + 1;
  };
  const iManifest = find('manifest');
  const iTemplate = find('template');
  let manifest;
  let template;
  try { manifest = JSON.parse(lines[iManifest]); }
  catch (e) { die(path.basename(file) + ': manifest is not valid JSON: ' + e.message); }
  try { template = JSON.parse(lines[iTemplate]); }
  catch (e) { die(path.basename(file) + ': template is not valid JSON: ' + e.message); }
  return { lines, iManifest, iTemplate, manifest, template };
}

/** Binary assets (fonts, png) are not source and are never read as text. */
function isBinary(buf) {
  const head = buf.slice(0, 4).toString('latin1');
  return /^wOF2|^\x00\x01\x00\x00|^\x89PNG|^OTTO|^true/.test(head);
}

/** Decompressed text of a manifest asset, or null if it is binary or unreadable. */
function assetText(entry) {
  let buf = Buffer.from(entry.data || '', 'base64');
  if (entry.compressed) { try { buf = zlib.gunzipSync(buf); } catch (_) { return null; } }
  return isBinary(buf) ? null : buf.toString('utf8');
}

/** Put text back into an asset using the encoding the bundler gave it. */
function writeAssetText(entry, txt) {
  const raw = Buffer.from(txt, 'utf8');
  entry.data = (entry.compressed ? zlib.gzipSync(raw) : raw).toString('base64');
}

/** Which snapshot globals a manifest asset defines. */
function assetGlobals(entry) {
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) { try { buf = zlib.gunzipSync(buf); } catch (_) { return { globals: [], size: 0 }; } }
  if (isBinary(buf)) return { globals: [], size: buf.length };
  const txt = buf.toString('utf8');
  const globals = SNAPSHOT_GLOBALS.filter((g) => new RegExp('(window\\.)?' + g + '\\s*=').test(txt));
  return { globals, size: buf.length };
}

/** Assert-exactly-once substitution against a string. */
function subText(txt, file, label, find, replace) {
  const n = txt.split(find).length - 1;
  if (n !== 1) die(file + ': patch "' + label + '" matched ' + n + ' times, expected exactly 1');
  return txt.replace(find, replace);
}

/** Assert-exactly-once substitution against the template. */
function sub(state, file, label, find, replace) {
  state.template = subText(state.template, file, label, find, replace);
}

/* --- the auth module, wherever this export put it ---------------------------
 *
 * Through 07/31 the module was inlined into each page's template. The 08/01
 * export moved it into the bundler manifest as a gzipped asset loaded by
 * <script src="uuid">, which is why the build stopped on index.html rather than
 * quietly shipping seven unpatched sign-in gates. Both shapes are handled and
 * exactly one of them must hold the module.
 *
 * Only the location changed -- all seven patches below match the asset
 * byte-for-byte. Patching it means decompress, substitute, re-compress with the
 * same encoding, then read it back the way the bundler will.
 */
const AUTH_MARKER = 'OLH shared authentication';

/** Manifest assets carrying the auth module. Should be exactly one, or none. */
function findAuthAssets(state) {
  const hits = [];
  for (const [uuid, entry] of Object.entries(state.manifest)) {
    const txt = assetText(entry);
    if (txt !== null && txt.includes(AUTH_MARKER)) hits.push({ uuid, entry, txt });
  }
  return hits;
}

function patchAuth(state, name) {
  const inline = state.template.includes(AUTH_MARKER);
  const assets = findAuthAssets(state);

  if (inline && assets.length) {
    die(name + ': the auth module is BOTH inline and in the manifest (' +
        assets.map((a) => a.uuid).join(', ') + '). Patching one leaves the other ' +
        'unpatched, and which copy wins at runtime is not decidable from here.');
  }
  if (!inline && !assets.length) {
    die(name + ': the shared auth module is missing. Every page in the export ' +
        'carries it; a page without it has no sign-in gate at all.');
  }
  if (assets.length > 1) {
    die(name + ': ' + assets.length + ' manifest assets carry the auth module (' +
        assets.map((a) => a.uuid).join(', ') + '), expected exactly 1. Patching ' +
        'one of several would leave a live unpatched copy on the page.');
  }

  if (inline) {
    for (const [label, find, replace] of AUTH_PATCHES) {
      sub(state, name, 'auth: ' + label, find, replace);
    }
    console.log('  auth patches             ' + AUTH_PATCHES.length + ' applied (inline)');
    return;
  }

  const a = assets[0];
  let txt = a.txt;
  for (const [label, find, replace] of AUTH_PATCHES) {
    txt = subText(txt, name, 'auth: ' + label, find, replace);
  }
  writeAssetText(a.entry, txt);
  if (assetText(a.entry) !== txt) die(name + ': the patched auth asset does not round-trip');

  console.log('  auth patches             ' + AUTH_PATCHES.length + ' applied (asset ' +
    a.uuid.slice(0, 8) + ', ' + kb(txt.length) + ')');
}

function emit(state, outFile) {
  // A literal "</script>" inside the JSON payload would close the host <script>
  // early and truncate it. The shipped bundles escape the slash; match that.
  const payload = JSON.stringify(state.template).split('</').join('<\\u002F');
  if (payload.includes('</')) die(outFile + ': failed to neutralise a close tag');
  state.lines[state.iTemplate] = payload;
  state.lines[state.iManifest] = JSON.stringify(state.manifest);
  fs.writeFileSync(outFile, state.lines.join('\n'));

  // Re-parse exactly as the browser loader does.
  const check = fs.readFileSync(outFile, 'utf8').split('\n');
  let round;
  try { round = JSON.parse(check[state.iTemplate]); }
  catch (e) { die(outFile + ': emitted template is not valid JSON: ' + e.message); }
  if (round !== state.template) die(outFile + ': template does not round-trip');
  try { JSON.parse(check[state.iManifest]); }
  catch (e) { die(outFile + ': emitted manifest is not valid JSON: ' + e.message); }
  return round;
}

/* --- step 1: delete the demo data ------------------------------------------ */

/**
 * Snapshots bundled as manifest assets, referenced by <script src="uuid">.
 * This is the pre-07/31 shape; kept so an older export still builds.
 */
function dropAssetSnapshots(state, name) {
  const drop = [];
  for (const [uuid, entry] of Object.entries(state.manifest)) {
    const { globals, size } = assetGlobals(entry);
    if (globals.length) drop.push({ uuid, globals, size });
  }
  for (const d of drop) {
    const tag = '<script src="' + d.uuid + '"></script>';
    if (state.template.includes(tag)) {
      state.template = state.template.split(tag).join('');
    } else if (state.template.includes('"' + d.uuid + '"')) {
      die(name + ': asset ' + d.uuid + ' (' + d.globals.join(',') + ') is referenced but not as a plain script tag');
    }
    delete state.manifest[d.uuid];
    console.log('  dropped asset snapshot   ' + d.globals.join(', ').padEnd(42) + kb(d.size));
  }
  for (const d of drop) {
    if (state.template.includes(d.uuid)) die(name + ': a reference to removed asset ' + d.uuid + ' survived');
  }
  return drop;
}

/**
 * Walk the plain inline <script> blocks of a template.
 *
 * "Plain" means no src= and no type=. Asset references carry src, and the app's
 * own code carries type="text/x-dc" and goes through a different path in the
 * bundler -- it is full of camelCase and is not rewritten, so including it here
 * would produce hundreds of false positives.
 */
function eachPlainInlineScript(template, fn) {
  const CLOSE = '</script>';
  let i = 0;
  for (;;) {
    const open = template.indexOf('<script', i);
    if (open === -1) return;
    const gt = template.indexOf('>', open);
    const close = gt === -1 ? -1 : template.indexOf(CLOSE, gt);
    if (gt === -1 || close === -1) return;
    const attrs = template.slice(open + '<script'.length, gt);
    if (!/\bsrc\s*=/.test(attrs) && !/\btype\s*=/.test(attrs)) {
      fn(template.slice(gt + 1, close));
    }
    i = close + CLOSE.length;
  }
}

/**
 * Rename an identifier everywhere it appears in the template.
 *
 * Word-boundary anchored on both sides, so `mkField` does not match inside
 * `mkFieldset` and the replacement cannot run twice. These names are distinctive
 * enough not to collide with markup, CSS or copy; a name that could is not a
 * candidate for this list.
 */
function renameIdentifier(state, from, to) {
  const re = new RegExp('\\b' + from + '\\b', 'g');
  const hits = (state.template.match(re) || []).length;
  if (!hits) return 0;
  state.template = state.template.replace(re, to);
  if (new RegExp('\\b' + from + '\\b').test(state.template)) {
    die('rename ' + from + ' -> ' + to + ' left occurrences behind');
  }
  return hits;
}

/** Declarations the bundler's camelCase rewrite would turn into syntax errors. */
function findManglableDecls(template) {
  const out = [];
  eachPlainInlineScript(template, (body) => {
    let m;
    MANGLED_DECL.lastIndex = 0;
    while ((m = MANGLED_DECL.exec(body))) {
      const name = m[1];
      out.push({
        name,
        mangled: 'sc-camel-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      });
    }
  });
  return out;
}

/**
 * Snapshots written straight into the template as plain inline <script> blocks.
 * This is the 07/31 shape.
 *
 * Only attribute-less scripts are considered. The app's own code carries
 * type="text/x-dc" and asset references carry src=, and both read these globals
 * without defining them -- so requiring `NAME = ` followed by the start of a
 * literal is what separates "defines the fixture" from "uses the data".
 */
function dropInlineSnapshots(state, name) {
  const defines = (body) => SNAPSHOT_GLOBALS.filter(
    (g) => new RegExp('(window\\.)?' + g + '\\s*=\\s*[[{"\\d]').test(body)
  );

  const tpl = state.template;
  const CLOSE = '</script>';
  let out = '';
  let i = 0;
  const drop = [];

  for (;;) {
    const open = tpl.indexOf('<script', i);
    if (open === -1) { out += tpl.slice(i); break; }
    const gt = tpl.indexOf('>', open);
    const close = gt === -1 ? -1 : tpl.indexOf(CLOSE, gt);
    if (gt === -1 || close === -1) { out += tpl.slice(i); break; }

    const attrs = tpl.slice(open + '<script'.length, gt);
    const body = tpl.slice(gt + 1, close);
    const end = close + CLOSE.length;
    const plain = !/\bsrc\s*=/.test(attrs) && !/\btype\s*=/.test(attrs);
    const globals = plain ? defines(body) : [];

    if (globals.length) {
      drop.push({ globals, size: body.length });
      out += tpl.slice(i, open);          // drop the whole block
      console.log('  dropped inline snapshot  ' + globals.join(', ').padEnd(42) + kb(body.length));
    } else {
      out += tpl.slice(i, end);           // keep it verbatim
    }
    i = end;
  }

  state.template = out;
  return drop;
}


/* --- the graft ------------------------------------------------------------- */

function build(name, spec) {
  const src = path.join(SRC, name);
  const out = path.join(PUB, name);
  const before = fs.statSync(src).size;
  const state = loadBundle(src);

  console.log('\n' + name);

  // 1. Delete the demo data, whichever shape this export used.
  const dropped = dropAssetSnapshots(state, name).concat(dropInlineSnapshots(state, name));
  if (spec.data && !dropped.length) {
    die(name + ': declared as carrying demo data but no snapshot was found. ' +
        'If the export stopped bundling it, set data:false for this page; if it moved ' +
        'again, teach dropInlineSnapshots/dropAssetSnapshots the new shape. Do not ' +
        'relax this check -- it is the only thing standing between a re-export and ' +
        '900 invented homesites in production.');
  }
  if (!spec.data && dropped.length) {
    die(name + ': declared as carrying no demo data, but ' + dropped.length +
        ' snapshot(s) were found. Set data:true for this page.');
  }

  // 2. Patch the shared auth module, inline or in the manifest.
  patchAuth(state, name);

  // 2b. Rename the identifiers the bundler's camelCase rewrite would corrupt.
  //     Template-only, deliberately: the rewrite is applied to the plain inline
  //     scripts the bundler re-emits at render time, not to manifest assets --
  //     the bundler's own 68 KB runtime is an asset and carries 59 camelCase
  //     declarations of its own. So while the auth module lives in the manifest
  //     these all match nothing, which is the correct answer, and they start
  //     applying again by themselves if a later export re-inlines it.
  const renamed = [];
  for (const [from, to] of MANGLE_SAFE_RENAMES) {
    const n = renameIdentifier(state, from, to);
    if (n) renamed.push(from + '->' + to + ' (' + n + ')');
  }
  if (renamed.length) console.log('  renamed for bundler      ' + renamed.join(', '));

  // 3. Invalidate memo caches when data arrives.
  if (spec.caches && spec.caches.length) {
    const find = 'const tick = () => this.setState(s => ({ ready: s.ready + 1 }));';
    const clear = spec.caches.map((c) => 'this.' + c + ' = null;').join(' ');
    sub(state, name, 'tick cache invalidation', find,
      'const tick = () => { ' + clear + ' this.setState(s => ({ ready: s.ready + 1 })); };');
    console.log('  memo invalidation        ' + spec.caches.join(', '));
  }

  // 4. Page-specific patches.
  for (const [label, find, replace] of (spec.patches || [])) {
    sub(state, name, label, find, replace);
    console.log('  patched                  ' + label);
  }

  // 5. Inline the loader last, so it runs after the app has mounted and the
  //    event listeners are registered.
  if (spec.inject) {
    if (!state.template.includes('</body>')) die(name + ': no </body> to inject the loader before');
    sub(state, name, 'loader injection', '</body>',
      '<script>window.__OLH_LIVE = { walkRef: ' + (spec.walkRef ? 'true' : 'false') + ' };</script>\n' +
      '<script>\n/* live data loader — injected by dev/build-live-pages.js */\n' + LOADER + '\n</script>\n</body>');
    console.log('  loader injected          walkRef=' + (spec.walkRef ? 'true' : 'false'));
  }

  // 6. Nothing in any plain inline script may carry a declaration the bundler
  //    will corrupt. Runs last so it covers the injected loader as well as the
  //    auth module and every patch above -- a patch that introduces one is the
  //    way this last regressed.
  const mangled = findManglableDecls(state.template);
  if (mangled.length) {
    die(name + ': ' + mangled.length + " declaration(s) will be corrupted by the bundler's " +
        'camelCase rewrite, which breaks the entire script they appear in:\n' +
        mangled.map((m) => '         ' + m.name + '  ->  ' + m.mangled).join('\n') +
        '\n       Rename each to all-lowercase or ALL_CAPS, or avoid the declaration.' +
        '\n       See the MANGLED_DECL comment at the top of this file.');
  }
  console.log('  manglable declarations   none');

  const round = emit(state, out);

  /* Post-conditions. Each of these would be a silently broken page.
   *
   * The fixture ids are the decisive test and they are checked by name: the old
   * regex looked for `jobs:[{` and the 07/31 fixture writes `"jobs":[{`, so it
   * would have passed a page that still contained all 900 records. */
  if (round.includes('recJOB')) die(name + ': emitted page still contains fixture job ids (recJOB…)');
  if (round.includes('recCM')) die(name + ': emitted page still contains fixture manager ids (recCM…)');
  if (round.includes('900 homesites')) die(name + ': emitted page still advertises the 900-homesite fixture');
  // A POPULATED inline job array. The bracket-then-brace is load bearing: the
  // injected loader legitimately assigns `OLH_DATA = { jobs: [], … }` as its
  // empty state, and an earlier version of this check flagged that as a fixture.
  if (/(window\.)?OLH_DATA\s*=\s*[[{]\s*["']?jobs["']?\s*:\s*\[\s*\{/.test(round)) {
    die(name + ': emitted page still contains a populated inline job array');
  }

  if (spec.inject) {
    if (!/\/walk-config/.test(round)) die(name + ': loader missing from emitted page');
    if (!/dispatchEvent\(new Event\('olh-data'\)\)/.test(round)) die(name + ': loader lost the olh-data dispatch');
  }
  if (name === 'tracker.html' && !/loadLive/.test(round)) {
    die(name + ': expected the page to carry its own loadLive()');
  }

  const after = fs.statSync(out).size;
  console.log('  ' + kb(before) + ' -> ' + kb(after) + '  (' +
    (after < before ? '-' + kb(before - after) : '+' + kb(after - before)) + ')');
  return { name, before, after };
}

/* --- run ------------------------------------------------------------------- */

fs.mkdirSync(PUB, { recursive: true });

// A page present in the export but absent from PAGES would be silently skipped,
// so a new page has to be declared before it can ship.
const exported = fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).sort();
const undeclared = exported.filter((f) => !PAGES[f]);
if (undeclared.length) {
  die('the export contains page(s) this build does not know about: ' + undeclared.join(', ') +
      '. Add them to PAGES (with data/inject/walkRef/caches) so they are wired ' +
      'deliberately rather than shipped raw.');
}

const results = [];
for (const [name, spec] of Object.entries(PAGES)) {
  if (!fs.existsSync(path.join(SRC, name))) die('missing input: ' + name);
  results.push(build(name, spec));
}

/* Every /assets/… and /fonts/… the built pages ask for must exist in publish.
 *
 * netlify.toml deliberately makes publish an allow-list -- only what is copied
 * into public/ is served -- which means a design re-export that introduces a
 * new image produces a 404 rather than a file, on every page, silently. The
 * 08/01 export switched the header to lennar-logo-blue.png and shipped a broken
 * logo on all eight pages; nothing caught it because a missing <img> changes no
 * text and throws no exception. Only a network probe saw it.
 *
 * References are read out of the decompressed text assets too, not just the
 * template, because that is where this one lived. */
function checkStaticRefs(pub) {
  const refs = new Map();
  for (const name of fs.readdirSync(pub).filter((f) => f.endsWith('.html'))) {
    /* Not every page in publish is a design-tool bundle. 404.html is hand
       written, and loadBundle() calls die() on anything with no
       __bundler/manifest block -- so pointing this build at a publish dir that
       contains one killed the whole run at the very last step, AFTER every page
       had already been written:

         BUILD FAILED: 404.html: no __bundler/manifest block

       It went unnoticed because 404.html was added on 08/03, after the 08/01
       build, so no release had reached this line since.

       Skipped by NAME, not by "does it happen to be a bundle". Walking every
       .html and refusing to read anything unexpected was, by accident, the only
       thing in the release path that noticed a file in publish that nobody put
       there deliberately -- and publish is an allow-list precisely because a
       file in it is a served file. Turning the hard failure into a soft "not a
       bundle, skipping" would have handed that back. So a non-bundle page is
       fine only if it is on this list, and a new one has to be added here on
       purpose.

       Note this check is about asset references the bundler HID inside
       compressed manifest entries. A hand-written page's <img src> is in plain
       sight, but "visible" is not "verified" -- if 404.html ever references an
       image, add the reference scan for it rather than assuming someone looked. */
    if (!isBundle(path.join(pub, name))) {
      if (!HAND_WRITTEN_PAGES.includes(name)) {
        die('unexpected file in the publish directory: ' + name + '\n' +
            '  It is not a design bundle and not a known hand-written page, which\n' +
            '  means nobody declared it -- and everything in publish is served.\n' +
            '  Delete it, or add it to HAND_WRITTEN_PAGES if it belongs.');
      }
      console.log('  skipped  ' + name + '  (declared hand-written, not a bundle)');
      continue;
    }
    const state = loadBundle(path.join(pub, name));
    const texts = [state.template];
    for (const entry of Object.values(state.manifest)) {
      const txt = assetText(entry);
      if (txt !== null) texts.push(txt);
    }
    for (const txt of texts) {
      for (const m of txt.matchAll(/(?:\/|\.\/)?((?:assets|fonts)\/[A-Za-z0-9._-]+)/g)) {
        if (!refs.has(m[1])) refs.set(m[1], new Set());
        refs.get(m[1]).add(name);
      }
    }
  }

  const missing = [...refs].filter(([rel]) => !fs.existsSync(path.join(pub, rel)));
  for (const [rel, pages] of [...refs].sort()) {
    if (fs.existsSync(path.join(pub, rel))) {
      console.log('  ok       ' + rel + '  (' + pages.size + ' page' + (pages.size === 1 ? '' : 's') + ')');
    }
  }
  if (missing.length) {
    die('the built pages reference file(s) that are not in ' + pub + ':\n' +
        missing.map(([rel, pages]) =>
          '         ' + rel + '  <- ' + [...pages].sort().join(', ')).join('\n') +
        '\n       publish is an allow-list, so these 404 on the live site. Copy them ' +
        'from the export\'s assets/ or fonts/ folder into ' + pub + '.');
  }
}

console.log('\nstatic references');
checkStaticRefs(PUB);

const saved = results.reduce((a, r) => a + (r.before - r.after), 0);
console.log('\nbuilt ' + results.length + ' pages, removed ' + kb(saved) + ' of bundled snapshot data');
