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
 *
 * WHERE THE LOADER IS INJECTED (fixed 2026-08-04, was inside state.template):
 *
 * The bundler's own bootstrap script -- the plain, un-bundled <script> that
 * every exported page carries alongside its __bundler/manifest and
 * __bundler/template blocks -- reconstructs the real page from the template
 * via DOMParser, then replaces document.documentElement with it. Scripts
 * inserted that way are inert per spec, so the bootstrap walks
 * document.scripts afterward and manually re-creates each one with
 * createElement, IN DOCUMENT ORDER -- and for any script with a src (React,
 * ReactDOM, Babel, the CDN/blob chunks), it AWAITS that one script's
 * load/error event before moving to the next, with no timeout.
 *
 * A script placed at the end of state.template (which is where this used to
 * live, anchored on the template's own "</body>") sits last in that replay
 * queue. If any earlier external script is slow, or never fires load/error at
 * all -- a flaky CDN fetch, a throttled background tab -- the whole replay
 * hangs on that one `await`, and every script after it, including this one,
 * never executes. No exception is thrown (a stuck promise doesn't throw), so
 * this fails completely silently: no console error, no network request, and
 * the loader's own diagnostic attributes (data-olh-source and friends) never
 * get set. That is exactly what shipped on completion.html and
 * walk-calendar.html on 2026-08-04 -- both carry page-specific `patches`
 * (unlike scheduler.html/workload.html, which carry none), though the actual
 * trigger is CDN timing, not the patches themselves, which is why it read as
 * intermittent rather than deterministically broken.
 *
 * The fix: inject the loader as a real <script> in the OUTER file, a sibling
 * of the bootstrap script itself, rather than inside state.template. The
 * bootstrap script is not bundled -- it is literal markup in the served file
 * -- so the browser's ordinary HTML parser reaches and executes a sibling of
 * it on the initial, synchronous parse, before the async
 * fetch-manifest/parse-template/replay-scripts sequence even starts. It can
 * never get stuck behind a CDN load because it never enters that queue at
 * all. See the insertion in build() below, and the "WHERE THIS RUNS" note at
 * the top of dev/live-loader.js for why boot() now polls for window.OLHAuth
 * instead of trusting document.readyState.
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

/* Shared "Last synced" header stamp -- see dev/sync-stamp.js. Injected the
 * same outer-sibling way as LOADER, on EVERY page in PAGES[] regardless of
 * inject:true/false: it only reads window.OLH_DATA if some other loader (or
 * the page's own inline one) has already set it, so it has none of LOADER's
 * fetch/stall risk and costs nothing on a page with no data of its own -- it
 * just renders blank. */
const SYNC_STAMP = fs.readFileSync(path.join(__dirname, 'sync-stamp.js'), 'utf8');
if (!/olh-sync-stamp/.test(SYNC_STAMP)) die('sync-stamp.js does not define olh-sync-stamp');

/* Shared multi-select filter dropdown (<olh-multiselect>, see
 * dev/multiselect.js) -- a drop-in replacement for a native <select> used as
 * a column/list filter. Injected the same outer-sibling way as LOADER, only
 * on pages whose PAGES[] entry sets `multiselect: true`, since most pages
 * have no filter dropdowns to convert. */
const MULTISELECT = fs.readFileSync(path.join(__dirname, 'multiselect.js'), 'utf8');
if (!/olh-multiselect/.test(MULTISELECT)) die('multiselect.js does not define olh-multiselect');

/* Three-pass walk scheduler, generated from three_pass_scheduler_logic.js
 * by dev/build-three-pass-client.js -- see that script before hand-editing
 * this output. Injected the same way and for the same reason as LOADER above:
 * pages needing window.OLHThreePassScheduler (workload.html, walk-calendar.html)
 * via the `optimizer:true` PAGES[] flag. (Flag name kept as `optimizer` to
 * avoid touching every PAGES[] entry; it now points at the three-pass
 * scheduler, not the old route-constrained optimizer, which has been
 * removed in full.) */
const OPTIMIZER = fs.readFileSync(path.join(__dirname, 'three-pass-scheduler-client.js'), 'utf8');
if (!/OLHThreePassScheduler/.test(OPTIMIZER)) die('three-pass-scheduler-client.js does not define window.OLHThreePassScheduler');

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
/* --- the "back to the homepage" link: RETIRED 2026-08-03 (evening) ----------
 *
 * There used to be a HOME_LINK constant here and two patches that grafted it
 * into the tracker and completion headers. Through the 08-01 export those two
 * were the only inner pages the design tool shipped without a way back to
 * index.html, and a page with no way home is a dead end for anyone arriving on
 * a bookmark. The 08-03 (evening) export ships "← All Views" on all nine inner
 * pages itself, so both patches are gone and so is the constant.
 *
 * Worth keeping the account, because the two failed differently and the quiet
 * one is the lesson:
 *
 *   tracker     the anchor moved (a Refresh button landed in the header), so
 *               the patch matched 0 times and stopped the build. Loud, correct.
 *   completion  the anchor did NOT move. The patch would have applied cleanly
 *               on top of the link the design now provides and shipped a header
 *               with two "All Views" links, on a green build.
 *
 * Which is the argument for deleting a patch the moment the design absorbs what
 * it was adding, rather than leaving it in because it still applies. An
 * exact-match patch asserts that something is ABSENT, and nothing here can
 * check that on its behalf -- sub() verifies the anchor exists, not that the
 * edit is still wanted. */

/* --- design-tool link names ------------------------------------------------
 *
 * The design tool writes inter-page links using its own SOURCE filenames, not
 * the deployed ones. Through the 08/01 export it happened to emit deployed
 * names ("tracker.html") and nobody noticed this was luck rather than contract;
 * the 08/03 export switched to source names ("OLH Tracker - Current.dc.html")
 * and every link between pages became a 404 -- all seven landing-page tiles and
 * the "All Views" back-link on six pages, thirteen in total.
 *
 * Nothing caught it. The pages built clean, loaded clean in headless Chrome and
 * threw nothing, because a dead <a href> is not an error until somebody clicks
 * it. checkStaticRefs() only ever resolved assets/ and fonts/. checkPageLinks()
 * below now closes that gap, and this map is the fix it enforces.
 *
 * Keys are what the design tool writes; values must exist in the publish dir.
 * A key with no matching page is a page nobody wired -- deliberately fatal
 * rather than silently left as a broken link.
 */
const DESIGN_LINKS = {
  'OLH Home.dc.html': 'index.html',
  'OLH Tracker - Current.dc.html': 'tracker.html',
  'OLH Completion Report.dc.html': 'completion.html',
  'Walk Schedule Export.dc.html': 'walk-calendar.html',
  'QA Management.dc.html': 'qa-management.html',
  'Scheduler.dc.html': 'scheduler.html',
  'Workload Predictor.dc.html': 'workload.html',
  'Workload Visualizer.dc.html': 'workload-visualizer.html',
  'OLH User Admin.dc.html': 'admin.html',
  'Homesite Detail.dc.html': 'homesite.html',
  // Superseded prototype, deleted 2026-08. The /tracker-new 301s were removed in
  // the 2026-08-03 (evening) release because nothing points there any more, so
  // this mapping is now the only thing that would catch a stray link to it.
  // Mapped rather than ignored so such a link lands on the page that replaced it
  // instead of on a 404.
  'OLH Tracker - New Views.dc.html': 'tracker.html'
};

/** Point every design-tool page link at the page that actually ships. */
function rewriteDesignLinks(text) {
  let n = 0;
  for (const [from, to] of Object.entries(DESIGN_LINKS)) {
    const parts = text.split('href="' + from + '"');
    n += parts.length - 1;
    text = parts.join('href="' + to + '"');
  }
  return { text, n };
}

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
/* 2026-08-11: page.walkstoschedule was added to walks-to-schedule.html's own
 * (standalone) copy of this module, but never to the shared copy these nine
 * pages carry, nor to admin.html's copy, nor to missed-walks.html/time-off.html's
 * copies. Result: no nav link to Walks To Schedule anywhere else in the suite,
 * and -- because admin.html's Roles & Permissions grid renders from its own
 * PAGES array -- no way to grant or revoke the permission there either. The
 * live public/*.html files were hand-patched to add a
 * { key: "page.walkstoschedule", ... } PAGES entry (right after page.qamgmt)
 * and a matching "page.walkstoschedule" addition to DEFAULT_ROLES for
 * qam/ccr/leadership (admin gets it for free via ALL_PAGES), plus the Airtable
 * Roles table was updated to actually grant it. If the next export overwrites
 * these nine pages and admin.html from a fresh design-tool copy, reapply the
 * same two edits to production/*.html before running this build -- neither is
 * captured by AUTH_PATCHES below because admin.html's PAGES array already
 * differs from the other nine (it also carries page.missedwalks/page.timeoff,
 * which nobody backfilled into the other nine or into missed-walks.html's own
 * nav either -- that gap predates this fix and is unresolved).
 *
 * 2026-08-11 (later same day): the frontend-only half of that hand-patch was
 * never enough. netlify/lib/olh-auth.js's ALL_PAGES/PERMS allow-list still
 * didn't include page.walkstoschedule, so normalizeMatrix() silently
 * stripped the permission out of every save -- admin.html could render the
 * checkbox and PUT it, but the backend dropped it before it ever reached
 * Airtable, and the very next loadMatrix() re-normalized it back out. Ticking
 * the box looked like it worked and didn't. Fixed by adding
 * 'page.walkstoschedule' to ALL_PAGES, DEFAULT_ROLES (qam/ccr/leadership;
 * admin already gets it via ALL_PAGES), and PAGE_LABEL in olh-auth.js. The
 * frontend-only gaps described above (missing nav link on the other pages,
 * missing PAGES grid entry on admin.html/missed-walks.html/time-off.html)
 * are still open -- this fix only unblocks the save itself.
 *
 * 2026-08-12: added a new role, "concierge" (view-only: page.home,
 * page.tracker, page.scheduler -- homesite.html carries no permission of its
 * own, it only checks suite.view and is reached by drilling into a record
 * from the tracker, so it needed no separate grant). Added to ROLE_ALIAS,
 * ROLE_LABEL and DEFAULT_ROLES in netlify/lib/olh-auth.js, to the Airtable
 * Roles table, and hand-patched into every one of the thirteen pages'
 * DEFAULT_ROLES copies (all ten bundled pages plus missed-walks.html,
 * time-off.html, walks-to-schedule.html's standalone copies) with the
 * identical { label: "Concierge", can: [...] } entry, inserted right after
 * the leadership entry. Same class of gap as the walkstoschedule fixes
 * above: a role that only exists in some copies is a role the admin console
 * cannot fully see or grant. If the next export overwrites these pages from
 * a fresh design-tool copy, reapply the concierge DEFAULT_ROLES entry to
 * each one before running this build -- not captured by AUTH_PATCHES below
 * for the same reason page.walkstoschedule wasn't: this is a per-page
 * DEFAULT_ROLES literal, not a shared find/replace target.
 *
 * 2026-08-12 (later same day): the DEFAULT_ROLES fix above still left the
 * Users list unable to show or set the role. admin.html's Role <select> for
 * each user row (and the matching one in the Add User form) is a THIRD,
 * independent copy of the role list -- hardcoded <option> tags baked into
 * admin.html's own __bundler/template markup, not read from DEFAULT_ROLES or
 * anything else this file touches. Its five options (admin/qam/cm/ccr/
 * leadership) had no "concierge" entry, so a concierge user's <select>
 * bound to a value matching no <option> and rendered wrong (as leadership --
 * the specific mechanism wasn't tracked down further since the fix is the
 * same regardless), and there was no way to pick "Concierge" for anyone
 * through the UI at all. Added <option value="concierge">Concierge</option>
 * right after the leadership option in all three occurrences of that select
 * in admin.html's template. Editing the template requires re-escaping "</"
 * as "<\u002F" before writing it back (see emit() below) -- plain
 * JSON.stringify corrupts the file by letting an embedded "</script>"
 * terminate the host tag early. If the next export overwrites admin.html,
 * reapply this option to its Role select(s) before running this build. */
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

  /* 2026-08-11: saveMatrix applied a permissions-grid change to the local
   * matrix and localStorage BEFORE the PUT to /api/roles, then swallowed any
   * failure of that PUT and resolved anyway -- so a rejected save (expired
   * session, lost network, a 403) still showed "Saved -- in effect across the
   * suite" on admin.html, with the real Airtable Roles table left unchanged.
   * Found via a report that Division Leadership couldn't edit the tracker
   * despite the grid showing tracker.edit checked for that role -- Airtable's
   * copy had never actually received it. Fixed by snapshotting the matrix
   * before the optimistic apply and, on a rejected PUT, reverting to that
   * snapshot and re-throwing so the caller (admin.html's onSave) can tell the
   * admin it did not take instead of reporting success either way. */
  ['saveMatrix: a rejected PUT must not read as a save',
   '    saveMatrix: function (next) {\n' +
   '      applyMatrix(next);\n' +
   '      writeStore(ROLES_KEY, matrixOf());\n' +
   '      emit();\n' +
   '      if (state.demo) return Promise.resolve(matrixOf());\n' +
   '      return api("/roles", { method: "PUT", body: { roles: matrixOf() } })\n' +
   '        .then(function () { return matrixOf(); })\n' +
   '        .catch(function () { return matrixOf(); });\n' +
   '    },',
   '    saveMatrix: function (next) {\n' +
   '      var prev = matrixOf();\n' +
   '      applyMatrix(next);\n' +
   '      writeStore(ROLES_KEY, matrixOf());\n' +
   '      emit();\n' +
   '      if (state.demo) return Promise.resolve(matrixOf());\n' +
   '      return api("/roles", { method: "PUT", body: { roles: matrixOf() } })\n' +
   '        .then(function () { return matrixOf(); })\n' +
   '        .catch(function (err) {\n' +
   '          // A save that never reached Airtable must not read as a save.\n' +
   '          // Revert the optimistic local apply so this browser reflects the\n' +
   '          // same matrix everyone else is still enforcing, and re-throw so\n' +
   '          // the caller can tell the admin it did not take -- silently\n' +
   '          // resolving here is what let "Saved" show on screen while\n' +
   '          // Airtable kept the old permissions.\n' +
   '          applyMatrix(prev);\n' +
   '          writeStore(ROLES_KEY, matrixOf());\n' +
   '          emit();\n' +
   '          throw err;\n' +
   '        });\n' +
   '    },'],

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

  /* The companion to the authHeaders patch above, and the reason the first
     attempt at this fix looked like it worked and did not.

     There are exactly two places the client attaches the session: authHeaders()
     for the four data loaders, and api() for everything the auth module owns --
     sign-in, /session, /users, /roles. Patching only the first fixed the data
     endpoints while leaving /session broken, and /session is what every page
     calls on load to restore the session. So on Azure each page decided the
     user was signed out and bounced to the sign-in screen, which reads as
     "login does not stick" rather than as a header problem.

     Same reasoning as authHeaders(): Azure Static Web Apps overwrites
     Authorization before a managed function sees it, so send both and let
     bearer() prefer the one that survives. */
  ['api(): send the session in a header Azure cannot overwrite',
   '    if (state.token) headers.Authorization = "Bearer " + state.token;',
   '    if (state.token) {\n' +
   '      headers.Authorization = "Bearer " + state.token;\n' +
   '      headers["X-OLH-Token"] = "Bearer " + state.token;\n' +
   '    }'],

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
  /* The sign-in landing page and tile menu. It carries the auth module, which
   * is why it was here even when it was otherwise a straight copy.
   *
   * data/inject FLIPPED to true in the 2026-08-03 export. The page stopped
   * being static: it now polls for window.OLH_DATA, listens for the olh-data
   * event, and derives its "Data updated" stamp in updatedLabel() from the
   * newest "Last Synced" across the dataset. So it ships with the 2.2 MB
   * snapshot like every other page and needs the same graft.
   *
   * The build refused to run until this was changed, which is the assertion
   * doing its job: a page declared data:false that turns out to carry a
   * snapshot would otherwise have published 900 synthetic homesites' sync
   * dates as the suite's freshness stamp.
   *
   * walkRef:false -- the page reads OLH_DATA.jobs and nothing WALK_*.
   */
  'index.html': {
    data: true, inject: true, walkRef: false, caches: [],
    patches: [
      // GONE (08/03 export): "drop the hardcoded data-updated date". The page
      // used to print "Data updated 7/29/26" as a literal, which aged into a
      // false claim beside links to pages that read Airtable live, so the patch
      // deleted it rather than faking it. updatedLabel() now computes the same
      // line from the data itself and falls back to the empty string when there
      // is none. Deleted rather than re-anchored: the design owns this now, and
      // a patch searching for a string that no longer exists is a build failure
      // waiting for the next re-export.

      // GONE (08/01 export): "supply isAdmin". The template used to gate the
      // User Administration link on {{ isAdmin }}, which renderVals() never
      // returned, so the link was invisible to everyone including admins. The
      // design now computes canAdmin: this.can("page.admin") itself and gates
      // every tile the same way, so the patch has nothing left to fix. It is
      // deleted rather than re-anchored -- re-adding isAdmin beside canAdmin
      // would leave two answers to one question.

      /* Found 2026-08-05, auditing the page. can(key) defaulted to `true`
       * whenever OLHAuth hadn't loaded or hadn't resolved a user yet -- which
       * meant every tile, including User Administration, rendered as
       * accessible to anyone during that window, and stayed that way forever
       * if OLHAuth never resolved a user (e.g. the auth script failed to
       * load, or restore() never settled). The API enforces every permission
       * server-side regardless (see netlify/lib/olh-auth.js requirePerm), so
       * this was never a data leak -- but the landing page dressed itself as
       * if any visitor had full access, which is its own bug and confusing
       * on its own. Fails closed now: can() returns false until auth has
       * definitively resolved, noPages waits for the same signal so it
       * doesn't flash "no access" during the load window, and two banners
       * (authLoading / authError) tell the person what's actually happening
       * instead of silently doing nothing. */
      ['fail closed on auth: can() defaults to false, add authReady/authFailed state',
       'class Component extends DCLogic {\n' +
       '  state = { user: null, narrow: window.OLHViewport ? window.OLHViewport.narrow() : false };\n' +
       '\n' +
       '  /* The helmet scripts can still be loading when this mounts (in the bundled\n' +
       '     build every script is a blob URL), so wait for them instead of throwing. */\n' +
       '  componentDidMount() {\n' +
       '    const bump = () => this.forceUpdate();\n' +
       '    window.addEventListener("olh-data", this._od = bump);\n' +
       '    let tries = 0;\n' +
       '    this._poll = setInterval(() => {\n' +
       '      if(window.OLH_DATA || ++tries > 60){ clearInterval(this._poll); this._poll = null; bump(); }\n' +
       '    }, 50); this._boot(0); }\n' +
       '  _boot(tries) {\n' +
       '    if ((!window.OLHViewport || !window.OLHAuth) && tries < 120) {\n' +
       '      this._bootT = setTimeout(() => this._boot(tries + 1), 50);\n' +
       '      return;\n' +
       '    }\n' +
       '    this._mounted();\n' +
       '  }\n' +
       '  _mounted() {\n' +
       '    if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    if (!window.OLHAuth) return;\n' +
       '    this._off = window.OLHAuth.onChange(u => this.setState({ user: u }));\n' +
       '    window.OLHAuth.restore().then(u => this.setState({ user: u }));\n' +
       '  }\n' +
       '  componentWillUnmount() {\n' +
       '    window.removeEventListener("olh-data", this._od);\n' +
       '    if(this._poll) clearInterval(this._poll); if (this._bootT) clearTimeout(this._bootT); if (this._off) this._off(); if (this._offVp) this._offVp(); }\n' +
       '\n' +
       '  /* Tiles follow the role\'s page access — a page you cannot open is not\n' +
       '     advertised here. Admin-only links stay admin-only. */\n' +
       '  can(key) {\n' +
       '    const a = window.OLHAuth;\n' +
       '    if (!a || !this.state.user) return true;\n' +
       '    return a.can(key);\n' +
       '  }',
       'class Component extends DCLogic {\n' +
       '  state = { user: null, narrow: window.OLHViewport ? window.OLHViewport.narrow() : false, authReady: false, authFailed: false };\n' +
       '\n' +
       '  /* The helmet scripts can still be loading when this mounts (in the bundled\n' +
       '     build every script is a blob URL), so wait for them instead of throwing. */\n' +
       '  componentDidMount() {\n' +
       '    const bump = () => this.forceUpdate();\n' +
       '    window.addEventListener("olh-data", this._od = bump);\n' +
       '    let tries = 0;\n' +
       '    this._poll = setInterval(() => {\n' +
       '      if(window.OLH_DATA || ++tries > 60){ clearInterval(this._poll); this._poll = null; bump(); }\n' +
       '    }, 50); this._boot(0); }\n' +
       '  _boot(tries) {\n' +
       '    if ((!window.OLHViewport || !window.OLHAuth) && tries < 120) {\n' +
       '      this._bootT = setTimeout(() => this._boot(tries + 1), 50);\n' +
       '      return;\n' +
       '    }\n' +
       '    if (!window.OLHAuth) {\n' +
       '      // Auth script never showed up after ~6s of polling. Fail closed instead\n' +
       '      // of leaving every tile at can()\'s default -- see can() for why the\n' +
       '      // default matters.\n' +
       '      this.setState({ authReady: true, authFailed: true });\n' +
       '      return;\n' +
       '    }\n' +
       '    this._mounted();\n' +
       '  }\n' +
       '  _mounted() {\n' +
       '    if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    this._off = window.OLHAuth.onChange(u => this.setState({ user: u }));\n' +
       '    window.OLHAuth.restore()\n' +
       '      .then(u => this.setState({ user: u, authReady: true }))\n' +
       '      .catch(() => this.setState({ authFailed: true, authReady: true }));\n' +
       '  }\n' +
       '  componentWillUnmount() {\n' +
       '    window.removeEventListener("olh-data", this._od);\n' +
       '    if(this._poll) clearInterval(this._poll); if (this._bootT) clearTimeout(this._bootT); if (this._off) this._off(); if (this._offVp) this._offVp(); }\n' +
       '\n' +
       '  /* Tiles follow the role\'s page access — a page you cannot open is not\n' +
       '     advertised here. Admin-only links stay admin-only.\n' +
       '     Fails CLOSED: until auth has definitively resolved (successfully or\n' +
       '     not), every tile is hidden. The API enforces every permission\n' +
       '     server-side regardless, so the old default was never a data leak --\n' +
       '     but it dressed the landing page as if any visitor had full access. */\n' +
       '  can(key) {\n' +
       '    if (!this.state.authReady || !window.OLHAuth || !this.state.user) return false;\n' +
       '    return window.OLHAuth.can(key);\n' +
       '  }'],

      ['renderVals: expose authLoading/authError, gate noPages on authReady',
       '  renderVals() {\n' +
       '    const n = this.state.narrow;\n' +
       '    const tiles = ["page.tracker", "page.completion", "page.walks", "page.qamgmt", "page.admin", "page.scheduler"].filter(k => this.can(k));\n' +
       '    const extras = this.can("page.workload");\n' +
       '    return {\n' +
       '      canTracker: this.can("page.tracker"),\n' +
       '      canCompletion: this.can("page.completion"),\n' +
       '      canWalks: this.can("page.walks"),\n' +
       '      canScheduler: this.can("page.scheduler"),\n' +
       '      canQaMgmt: this.can("page.qamgmt"),\n' +
       '      canWorkload: this.can("page.workload"),\n' +
       '      canAdmin: this.can("page.admin"),\n' +
       '      updatedLabel: this.updatedLabel(),\n' +
       '      noPages: !tiles.length && !extras,\n' +
       '      noPagesNote: "Your role does not have access to any pages yet. Ask an admin to grant page access under Roles & Permissions.",',
       '  renderVals() {\n' +
       '    const n = this.state.narrow;\n' +
       '    const ready = this.state.authReady;\n' +
       '    const failed = this.state.authFailed;\n' +
       '    const tiles = ["page.tracker", "page.completion", "page.walks", "page.qamgmt", "page.admin", "page.scheduler"].filter(k => this.can(k));\n' +
       '    const extras = this.can("page.workload");\n' +
       '    return {\n' +
       '      canTracker: this.can("page.tracker"),\n' +
       '      canCompletion: this.can("page.completion"),\n' +
       '      canWalks: this.can("page.walks"),\n' +
       '      canScheduler: this.can("page.scheduler"),\n' +
       '      canQaMgmt: this.can("page.qamgmt"),\n' +
       '      canWorkload: this.can("page.workload"),\n' +
       '      canAdmin: this.can("page.admin"),\n' +
       '      updatedLabel: this.updatedLabel(),\n' +
       '      authLoading: !ready,\n' +
       '      authError: ready && failed,\n' +
       '      // Only claims "no access" once auth has actually resolved -- otherwise\n' +
       '      // this flashed for every user during the load window before authReady.\n' +
       '      noPages: ready && !failed && !tiles.length && !extras,\n' +
       '      noPagesNote: "Your role does not have access to any pages yet. Ask an admin to grant page access under Roles & Permissions.",'],

      ['add authLoading/authError banners under the hero heading',
       '<h1 style="margin:10px 0 0;max-width:24ch;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:{{ heroSize }};line-height:1.04;letter-spacing:-.035em;color:#1B2A58;text-wrap:pretty">Where Would You Like to Start?</h1>\n    ',
       '<h1 style="margin:10px 0 0;max-width:24ch;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:{{ heroSize }};line-height:1.04;letter-spacing:-.035em;color:#1B2A58;text-wrap:pretty">Where Would You Like to Start?</h1>\n\n' +
       '    <sc-if value="{{ authLoading }}" hint-placeholder-val="{{ false }}">\n' +
       '      <p style="margin:16px 0 0;font-size:13.5px;color:#908A82">Checking your access…</p>\n' +
       '    </sc-if>\n' +
       '\n' +
       '    <sc-if value="{{ authError }}" hint-placeholder-val="{{ false }}">\n' +
       '      <p style="margin:16px 0 0;padding:12px 14px;border-radius:8px;background:#FBEAEA;border:1px solid #E8C7C7;font-size:13.5px;color:#8A3A3A">Couldn\'t verify your sign-in. Refresh the page, and if this keeps happening, ask an admin to check your account.</p>\n' +
       '    </sc-if>\n    '],
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
    data: true, inject: true, walkRef: false, multiselect: true, caches: [],
    patches: [
      /* 08/17: Lot Type/Stage/Community/Construction Manager/Area
       * Construction Manager converted from single-value <sc-raw-select> to
       * <olh-multiselect> (dev/multiselect.js), matching the same-day
       * conversion already done on tracker.html/qa-management.html. This
       * was applied directly to public/completion.html via
       * dev/add-completion-multiselect.js + dev/inject-completion-multiselect-
       * script.js rather than as inline patch strings here (the change
       * touches markup, five state defaults, filtered(), opts(), the top-
       * communities bar-chart toggle, the removable filter chips, the
       * Reset handler, and adds selRefs/syncSelects/componentDidUpdate --
       * closer to a rewrite of those sections than a small patch). A
       * future re-export from the design tool will regenerate
       * completion.html with the ORIGINAL single-select markup and drop
       * this; re-run both of those two scripts against the fresh export
       * to reapply it, in that order. multiselect: true above only
       * controls re-injecting the MULTISELECT script itself -- it does not
       * regenerate the markup/JS conversion. */
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
      /* 08/05: reverted the field-name half of this patch. The 08/04 version
       * (see git history) swapped Actual Completion Date / Projected
       * Completion Date for the no-"Date"-suffix fields, on the theory that
       * the suffixed pair were frozen Dynamics-era leftovers. That theory was
       * wrong: dev/sync_coe_to_airtable.py's COLUMN_MAP maps the live
       * Homesite__c Actual_Completion_Date__c / Projected_Completion_Date__c
       * pull (via the homesites-no-actual-coe skill's run_report.py SOQL)
       * straight into the Airtable fields NAMED "Actual Completion Date" and
       * "Projected Completion Date" -- despite the suffix looking legacy,
       * those are exactly what gets refreshed daily. Nothing currently
       * writes the no-suffix "Actual Completion" / "Projected Completion"
       * fields at all. Confirmed 08/05 against live data: 6 homesites that
       * completed and synced same-day, plus 1 brand-new job created same-day,
       * were mis-scoped (1002 vs the correct 997) because the no-suffix pair
       * hadn't been (and never gets) populated for them.
       *
       * The Active/no-COE additions from the 08/04 patch are correct and
       * stay. */
      ['scope the report to live, unclosed homesites',
       'const LOTS = { B: 1, S: 1, W: 1, M: 1 };\n' +
       '    // Report scope: started, not yet complete, projected to finish 7/1/26 or later, lot status B/S/W/M\n' +
       '    const inScope = f => !!iso(f["Actual Start Date"])\n' +
       '      && !iso(f["Actual Completion Date"])\n' +
       '      && iso(f["Projected Completion Date"]) >= "2026-07-01"\n' +
       '      && LOTS[(f["Lot Status"] || "").trim().toUpperCase()] === 1;',
       'const LOTS = { B: 1, S: 1, W: 1, M: 1 };\n' +
       '    // Report scope: still in the Salesforce pull, started, not yet complete,\n' +
       '    // no Actual COE, projected to finish 7/1/26 or later, lot status B/S/W/M.\n' +
       '    // Reads Actual Completion Date / Projected Completion Date -- despite\n' +
       '    // the "Date" suffix, these are the fields dev/sync_coe_to_airtable.py\n' +
       '    // actually writes daily from the live Homesite__c SOQL pull. The\n' +
       '    // no-suffix "Actual Completion"/"Projected Completion" fields are the\n' +
       '    // ones nothing currently writes -- do not scope off them.\n' +
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

      /* GONE (08/03 export): "group the tile by community rather than stage",
       * "retitle the tile" and "pass the community bars to the view".
       *
       * The right-hand tile used to group by Construction Stage, whose two-digit
       * codes told you almost nothing at a glance -- "03 - 166" needs the JDE
       * stage table to read -- so these three patches regrouped it by community,
       * which is how the division is actually organised. The design has now
       * adopted that wholesale: it computes the same top-8-by-count bars off
       * this.filtered("comm") under the comment "top communities by homesite
       * count", drives the comm filter on click, and titles the tile itself.
       *
       * Deleted rather than re-anchored. All three would now be searching for
       * stage-bar code that no longer exists, which is a hard build failure, and
       * the second and third would be rewriting a variable the design already
       * spells the way we want. Note the design kept the name `stageBars` for
       * what are now community bars -- that is its business, not something to
       * patch, and renaming it here would only break on the next export.
       *
       * The fourth patch in that group, "give the bars room for a community
       * name", is gone with them and for the same reason. It widened the label
       * column, truncated long names with an ellipsis instead of wrapping (a
       * wrapped name makes its row taller than the rest, and this tile's height
       * is what the left card is aligned against) and put the full name on a
       * hover title. The design now ships all three: the heading reads "Top
       * Communities", the grid is minmax(0,1fr) 76px 30px, and the label span
       * carries both the ellipsis rules and title="{{ s.label }}". Nothing was
       * lost in the handover. */

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

      /* RE-ANCHORED for the 08/03 export, which changed the slicer wrapper from
       * margin-top:2px to margin-top:auto;padding-top:2px -- the design solving
       * the ragged bottom edge its own way, by pushing the slicer down inside
       * whatever height the card happens to have.
       *
       * Complementary rather than a replacement, so the patch stays: the auto
       * margin PINS the slicer to the bottom, flex:1 1 auto GROWS it, and only
       * the second gives the "longer slicer" this was asked for. Kept also
       * because it cannot be dropped on its own -- "scale the month bars" below
       * scales h to 100 rather than 40 and the bar markup is height:{{ m.h }}px,
       * so a fixed 58px box with 100px bars overflows by 42px. That changes no
       * text and throws nothing, which is to say neither check-export-errors.sh
       * nor verify-pages.sh would say a word about it. */
      ['let the EDD slicer absorb the extra height',
       '<div style="display:flex;flex-direction:column;gap:5px;margin-top:auto;padding-top:2px">\n' +
       '        <span style="font-size:11px;font-weight:600;color:#6F6963">' +
       'EDD Range \u00b7 click months to filter</span>\n' +
       '        <div style="display:flex;align-items:flex-end;gap:3px;height:58px">',
       '<div style="display:flex;flex-direction:column;gap:5px;margin-top:auto;padding-top:2px;' +
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

      // REMOVED in the 08-03 (evening) release: 'give the header a path back to
      // the homepage'. See the note where HOME_LINK used to be defined. This one
      // is the more instructive of the two: its anchor still matched, so the
      // build would have gone green and shipped a header with two "All Views"
      // links. Only the tracker's copy failed loudly.

      /* Added 2026-08-05, by request: Power Meter, Water Meter, NOC Lock Date,
       * Construction Risk(+Notes) and Land Risk(+Notes) become inline-editable
       * in the table, the same way the Tracker grid already edits them. All
       * five are already on update-job.js's whitelist, so nothing changes
       * server-side.
       *
       * This page had NO auth or edit machinery at all before this -- it was
       * built read-only. The auth wiring below is written fail-closed from
       * the start (can() returns false until authReady, never true by
       * default), following the audit that found and fixed the opposite
       * default on index.html and tracker.html the same day. */
      ['state adds auth/edit/save/toasts',
       'state = {\n' +
       '    narrow: window.OLHViewport ? window.OLHViewport.narrow() : false,\n' +
       '    lot: "", comm: "", cm: "", acm: "", stage: "",\n' +
       '    months: [], day: "", q: "",\n' +
       '    sort: "close", dir: 1, limit: 200, detail: null,\n' +
       '    landRisk: false, constRisk: false,\n' +
       '    calY: TODAY.getFullYear(), calM: TODAY.getMonth()\n' +
       '  };',
       'state = {\n' +
       '    narrow: window.OLHViewport ? window.OLHViewport.narrow() : false,\n' +
       '    lot: "", comm: "", cm: "", acm: "", stage: "",\n' +
       '    months: [], day: "", q: "",\n' +
       '    sort: "close", dir: 1, limit: 200, detail: null,\n' +
       '    landRisk: false, constRisk: false,\n' +
       '    calY: TODAY.getFullYear(), calM: TODAY.getMonth(),\n' +
       '    user: null, authReady: false, authFailed: false,\n' +
       '    edit: null, save: {}, toasts: []\n' +
       '  };'],

      ['componentDidMount wires auth; add commit/persist/toast/can',
       'componentDidMount() {\n' +
       '    if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    else this._vpT = setTimeout(() => {\n' +
       '      if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    }, 400);\n' +
       '    if (window.OLH_DATA && window.OLH_DATA.jobs) return;\n' +
       '    const ready = () => {\n' +
       '      if (!(window.OLH_DATA && window.OLH_DATA.jobs)) return false;\n' +
       '      clearInterval(this._poll);\n' +
       '      this._rows = null;\n' +
       '      this.forceUpdate();\n' +
       '      return true;\n' +
       '    };\n' +
       '    window.addEventListener("olh-data", ready);\n' +
       '    this._poll = setInterval(ready, 120);\n' +
       '    setTimeout(() => clearInterval(this._poll), 20000);\n' +
       '    ready();\n' +
       '  }\n' +
       '\n' +
       '  componentWillUnmount() { clearInterval(this._poll); }',
       'componentDidMount() {\n' +
       '    if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    else this._vpT = setTimeout(() => {\n' +
       '      if (window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    }, 400);\n' +
       '    this._wireAuth(0);\n' +
       '    if (!(window.OLH_DATA && window.OLH_DATA.jobs)) {\n' +
       '      const ready = () => {\n' +
       '        if (!(window.OLH_DATA && window.OLH_DATA.jobs)) return false;\n' +
       '        clearInterval(this._poll);\n' +
       '        this._rows = null;\n' +
       '        this.forceUpdate();\n' +
       '        return true;\n' +
       '      };\n' +
       '      window.addEventListener("olh-data", ready);\n' +
       '      this._poll = setInterval(ready, 120);\n' +
       '      setTimeout(() => clearInterval(this._poll), 20000);\n' +
       '      ready();\n' +
       '    }\n' +
       '  }\n' +
       '\n' +
       '  _wireAuth(tries) {\n' +
       '    if (!window.OLHAuth) {\n' +
       '      if (tries < 120) { this._authT = setTimeout(() => this._wireAuth(tries + 1), 50); return; }\n' +
       '      this.setState({ authReady: true, authFailed: true });\n' +
       '      return;\n' +
       '    }\n' +
       '    window.OLHAuth.configure(\'/api\');\n' +
       '    this._offAuth = window.OLHAuth.onChange(u => this.setState({ user: u }));\n' +
       '    window.OLHAuth.restore()\n' +
       '      .then(u => this.setState({ user: u, authReady: true }))\n' +
       '      .catch(() => this.setState({ authFailed: true, authReady: true }));\n' +
       '  }\n' +
       '\n' +
       '  _authHeaders(extra) {\n' +
       '    if (!window.OLHAuth || typeof window.OLHAuth.authHeaders !== "function") {\n' +
       '      throw new Error("The sign-in module has not loaded, so this page cannot authenticate. Reload the page.");\n' +
       '    }\n' +
       '    return window.OLHAuth.authHeaders(extra);\n' +
       '  }\n' +
       '\n' +
       '  can(p) { return this.state.authReady && !!window.OLHAuth && window.OLHAuth.can(p); }\n' +
       '\n' +
       '  toast(kind, title, body) {\n' +
       '    const id = "t" + Date.now() + Math.random();\n' +
       '    this.setState(s => ({ toasts: s.toasts.concat([{ id, kind, title, body }]) }));\n' +
       '    setTimeout(() => this.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), kind === "err" ? 9000 : 2600);\n' +
       '  }\n' +
       '\n' +
       '  commit(id, field, value) {\n' +
       '    if (!this.can("tracker.edit")) {\n' +
       '      this.setState({ edit: null });\n' +
       '      this.toast("err", "Read-Only Access", window.OLHAuth.denyReason("tracker.edit"));\n' +
       '      return;\n' +
       '    }\n' +
       '    const rec = ((window.OLH_DATA && window.OLH_DATA.jobs) || []).find(r => r.id === id);\n' +
       '    if (!rec) return;\n' +
       '    const prev = rec.fields[field];\n' +
       '    if (prev === value || (prev == null && value == null)) { this.setState({ edit: null }); return; }\n' +
       '    rec.fields[field] = value;\n' +
       '    this._rows = null;\n' +
       '    this.setState(s => ({ edit: null, save: Object.assign({}, s.save, { [id]: "saving\\u2026" }) }));\n' +
       '    this.persist(rec, id, field, value, prev);\n' +
       '  }\n' +
       '\n' +
       '  async persist(rec, id, field, value, prev) {\n' +
       '    try {\n' +
       '      const res = await fetch("/api/update-job", {\n' +
       '        method: "POST",\n' +
       '        headers: this._authHeaders({ "Content-Type": "application/json" }),\n' +
       '        body: JSON.stringify({ recordId: id, fields: { [field]: value } })\n' +
       '      });\n' +
       '      const data = await res.json().catch(() => null);\n' +
       '      if (!res.ok) throw new Error((data && data.error) || ("Save failed (" + res.status + ")"));\n' +
       '      if (data && data.fields && Object.prototype.hasOwnProperty.call(data.fields, field)) {\n' +
       '        rec.fields[field] = data.fields[field];\n' +
       '      }\n' +
       '      this._rows = null;\n' +
       '      this.setState(s => ({ save: Object.assign({}, s.save, { [id]: "saved" }) }));\n' +
       '      setTimeout(() => this.setState(s => { const n = Object.assign({}, s.save); delete n[id]; return { save: n }; }), 2100);\n' +
       '    } catch (err) {\n' +
       '      rec.fields[field] = prev;\n' +
       '      this._rows = null;\n' +
       '      this.setState(s => ({ save: Object.assign({}, s.save, { [id]: "not saved" }) }));\n' +
       '      this.toast("err", "Job " + (rec.fields["Job #"] || id) + " \\u2014 \\u201c" + field + "\\u201d not saved",\n' +
       '        (err.message || String(err)) + " The change was reverted.");\n' +
       '    }\n' +
       '  }\n' +
       '\n' +
       '  componentWillUnmount() {\n' +
       '    clearInterval(this._poll);\n' +
       '    if (this._vpT) clearTimeout(this._vpT);\n' +
       '    if (this._authT) clearTimeout(this._authT);\n' +
       '    if (this._offVp) this._offVp();\n' +
       '    if (this._offAuth) this._offAuth();\n' +
       '  }'],

      ['data() carries the Airtable record id',
       'this._rows = src.filter(j => inScope(j.fields || {})).map(j => {\n' +
       '      const f = j.fields || {};\n' +
       '      return {\n' +
       '        job: f["Job #"], community: f["Community"] || "", street: f["Street Address"] || "",',
       'this._rows = src.filter(j => inScope(j.fields || {})).map(j => {\n' +
       '      const f = j.fields || {};\n' +
       '      return {\n' +
       '        id: j.id, job: f["Job #"], community: f["Community"] || "", street: f["Street Address"] || "",'],

      ['rows: power/water/noc/risk become interactive',
       'const rows = shown.map((r, i) => {\n' +
       '      const late = r.close && r.close < TODAY_ISO;\n' +
       '      const age = r.start ? days(new Date(r.start), TODAY) : null;\n' +
       '      const w = r;\n' +
       '      const mile = (iso, done) => iso ? fmt(iso) : done ? "Done" : "\\u2014";\n' +
       '      return {\n' +
       '        community: r.community || "\\u2014", job: r.job, jobHref: JOB_LINK(r.job), start: fmt(r.start), edd: fmt(r.edd),\n' +
       '        ecoe: fmt(r.ecoe), close: fmt(r.close), ccc: fmt(r.ccc), co: fmt(r.co),\n' +
       '        qai: mile(w.qai, w.qaiDone), qaa: mile(w.qaa, w.qaaDone), cel: mile(w.cel, w.celDone), acc: mile(w.acc, w.accDone),\n' +
       '        noc: fmt(r.noc),\n' +
       '        power: r.power ? "\\u2713" : "\\u2014", powerColor: r.power ? "#0D773C" : "#BFB8AB",\n' +
       '        water: r.water ? "\\u2713" : "\\u2014", waterColor: r.water ? "#0D773C" : "#BFB8AB",\n' +
       '        risk: r.landRisk && r.constRisk ? "L+C" : r.landRisk ? "L" : r.constRisk ? "C" : "\\u2014",\n' +
       '        riskColor: r.landRisk || r.constRisk ? "#AA1F23" : "#BFB8AB",\n' +
       '        riskTitle: [r.landRisk ? "Land risk" + (r.landNote ? ": " + r.landNote : "") : "", r.constRisk ? "Construction risk" + (r.constNote ? ": " + r.constNote : "") : ""].filter(Boolean).join(" \\u00b7 ") || "No risk flagged",\n' +
       '        areaCm: r.acm || "\\u2014", planName: r.planName || "\\u2014",\n' +
       '        planNumber: r.planNumber || "\\u2014", elevation: r.elevation || "\\u2014",\n' +
       '        lot: r.lot || "\\u2014", cm: r.cm || "\\u2014", stage: r.stage || "\\u2014",\n' +
       '        age: age === null ? "\\u2014" : age, ageColor: age !== null && age > 240 ? "#AA1F23" : "#6F6963",\n' +
       '        closeColor: late ? "#AA1F23" : "#303030",\n' +
       '        bg: i % 2 ? "#FCFAF6" : "#fff",\n' +
       '        onClick: () => this.setState({ detail: r })\n' +
       '      };\n' +
       '    });',
       'const canEdit = this.can("tracker.edit");\n' +
       '    const ed = this.state.edit;\n' +
       '    const rows = shown.map((r, i) => {\n' +
       '      const late = r.close && r.close < TODAY_ISO;\n' +
       '      const age = r.start ? days(new Date(r.start), TODAY) : null;\n' +
       '      const w = r;\n' +
       '      const mile = (iso, done) => iso ? fmt(iso) : done ? "Done" : "\\u2014";\n' +
       '      const sv = this.state.save[r.id] || "";\n' +
       '      const stop = e => e.stopPropagation();\n' +
       '      const nocEditing = !!ed && ed.id === r.id && ed.field === "NOC Lock Date";\n' +
       '      const constNoteEditing = !!ed && ed.id === r.id && ed.field === "Construction Risk Notes";\n' +
       '      const landNoteEditing = !!ed && ed.id === r.id && ed.field === "Land Risk Notes";\n' +
       '      return {\n' +
       '        id: r.id, stop,\n' +
       '        community: r.community || "\\u2014", job: r.job, jobHref: JOB_LINK(r.job), start: fmt(r.start), edd: fmt(r.edd),\n' +
       '        ecoe: fmt(r.ecoe), close: fmt(r.close), ccc: fmt(r.ccc), co: fmt(r.co),\n' +
       '        qai: mile(w.qai, w.qaiDone), qaa: mile(w.qaa, w.qaaDone), cel: mile(w.cel, w.celDone), acc: mile(w.acc, w.accDone),\n' +
       '\n' +
       '        power: r.power,\n' +
       '        powerCursor: canEdit ? "pointer" : "default",\n' +
       '        powerBoxStyle: "display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:4px;border:1.5px solid " + (r.power ? "#0D773C" : "#BFB8AB") + ";background:" + (r.power ? "#0D773C" : "#fff"),\n' +
       '        onPower: e => { stop(e); if (canEdit) this.commit(r.id, "Power Meter", !r.power); },\n' +
       '\n' +
       '        water: r.water,\n' +
       '        waterCursor: canEdit ? "pointer" : "default",\n' +
       '        waterBoxStyle: "display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:4px;border:1.5px solid " + (r.water ? "#0D773C" : "#BFB8AB") + ";background:" + (r.water ? "#0D773C" : "#fff"),\n' +
       '        onWater: e => { stop(e); if (canEdit) this.commit(r.id, "Water Meter", !r.water); },\n' +
       '\n' +
       '        noc: fmt(r.noc), nocRaw: r.noc || "", nocEditing,\n' +
       '        nocCursor: canEdit ? "pointer" : "default",\n' +
       '        onNocOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: "NOC Lock Date" } }); },\n' +
       '        onNocChange: e => { this.commit(r.id, "NOC Lock Date", e.target.value || null); },\n' +
       '        onNocBlur: () => this.setState({ edit: null }),\n' +
       '\n' +
       '        constRiskOn: r.constRisk, landRiskOn: r.landRisk,\n' +
       '        constRiskChipStyle: "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;border:1px solid " + (r.constRisk ? "#AA1F23" : "#BFB8AB") + ";background:" + (r.constRisk ? "#AA1F23" : "#fff") + ";color:" + (r.constRisk ? "#fff" : "#908A82") + ";font-size:10px;font-weight:700;padding:0;cursor:" + (canEdit ? "pointer" : "default"),\n' +
       '        landRiskChipStyle: "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;border:1px solid " + (r.landRisk ? "#AA1F23" : "#BFB8AB") + ";background:" + (r.landRisk ? "#AA1F23" : "#fff") + ";color:" + (r.landRisk ? "#fff" : "#908A82") + ";font-size:10px;font-weight:700;padding:0;cursor:" + (canEdit ? "pointer" : "default"),\n' +
       '        onConstRisk: e => { stop(e);\n' +
       '          if (!canEdit) return;\n' +
       '          const next = !r.constRisk;\n' +
       '          this.commit(r.id, "Construction Risk", next);\n' +
       '          if (next && !r.constNote) this.setState({ edit: { id: r.id, field: "Construction Risk Notes" } });\n' +
       '        },\n' +
       '        onLandRisk: e => { stop(e);\n' +
       '          if (!canEdit) return;\n' +
       '          const next = !r.landRisk;\n' +
       '          this.commit(r.id, "Land Risk", next);\n' +
       '          if (next && !r.landNote) this.setState({ edit: { id: r.id, field: "Land Risk Notes" } });\n' +
       '        },\n' +
       '        onConstNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: "Construction Risk Notes" } }); },\n' +
       '        onLandNoteOpen: e => { stop(e); if (canEdit) this.setState({ edit: { id: r.id, field: "Land Risk Notes" } }); },\n' +
       '        constNoteEditing, landNoteEditing,\n' +
       '        constNoteValue: r.constNote || "", landNoteValue: r.landNote || "",\n' +
       '        onConstNoteBlur: e => this.commit(r.id, "Construction Risk Notes", e.target.value),\n' +
       '        onLandNoteBlur: e => this.commit(r.id, "Land Risk Notes", e.target.value),\n' +
       '        riskTitle: [r.landRisk ? "Land risk" + (r.landNote ? ": " + r.landNote : " \\u2014 click the pencil to add a note") : "", r.constRisk ? "Construction risk" + (r.constNote ? ": " + r.constNote : " \\u2014 click the pencil to add a note") : ""].filter(Boolean).join(" \\u00b7 ") || "No risk flagged",\n' +
       '\n' +
       '        saveState: sv, saveColor: sv === "saved" ? "#0D773C" : "#908A82",\n' +
       '\n' +
       '        areaCm: r.acm || "\\u2014", planName: r.planName || "\\u2014",\n' +
       '        planNumber: r.planNumber || "\\u2014", elevation: r.elevation || "\\u2014",\n' +
       '        lot: r.lot || "\\u2014", cm: r.cm || "\\u2014", stage: r.stage || "\\u2014",\n' +
       '        age: age === null ? "\\u2014" : age, ageColor: age !== null && age > 240 ? "#AA1F23" : "#6F6963",\n' +
       '        closeColor: late ? "#AA1F23" : "#303030",\n' +
       '        bg: i % 2 ? "#FCFAF6" : "#fff",\n' +
       '        onClick: () => this.setState({ detail: r })\n' +
       '      };\n' +
       '    });'],

      ['renderVals return adds readOnly/readOnlyNote/toasts',
       'detail,\n' +
       '      stop: e => e.stopPropagation(),\n' +
       '      onCloseDetail: () => this.setState({ detail: null }),\n' +
       '      chips\n' +
       '    };\n' +
       '  }\n' +
       '}',
       'detail,\n' +
       '      stop: e => e.stopPropagation(),\n' +
       '      onCloseDetail: () => this.setState({ detail: null }),\n' +
       '      chips,\n' +
       '\n' +
       '      readOnly: s.authFailed || (!!s.user && !canEdit),\n' +
       '      readOnlyNote: s.authFailed\n' +
       '        ? "Couldn\\u2019t verify your sign-in, so Power/Water/NOC/Risk fields are read-only for now. Refresh the page \\u2014 if this keeps happening, ask an admin to check your account."\n' +
       '        : (s.user && !canEdit\n' +
       '          ? "Signed in as " + window.OLHAuth.roleLabel(s.user.role) + " \\u2014 Power/Water/NOC/Risk fields are view only. " + window.OLHAuth.denyReason("tracker.edit")\n' +
       '          : ""),\n' +
       '      toasts: s.toasts.map(t => ({\n' +
       '        title: t.title, body: t.body,\n' +
       '        style: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "4px",\n' +
       '          background: "#fff", border: "1px solid #D8CFBE",\n' +
       '          borderLeft: "3px solid " + (t.kind === "err" ? "#AA1F23" : "#0D773C"),\n' +
       '          boxShadow: "0 6px 20px rgba(48,48,48,.12)", fontSize: "12.5px", lineHeight: 1.4 },\n' +
       '        titleStyle: { fontWeight: 600, display: "block", marginBottom: "1px", color: t.kind === "err" ? "#AA1F23" : "#303030" },\n' +
       '        onClose: () => this.setState(p => ({ toasts: p.toasts.filter(x => x.id !== t.id) }))\n' +
       '      }))\n' +
       '    };\n' +
       '  }\n' +
       '}'],

      ['add read-only banner after header',
       '  </header>\n' +
       '\n' +
       '  <div style="display:grid;grid-template-columns:{{ panelCols }};gap:14px;flex:0 0 auto;padding:{{ mainPad }};align-items:stretch">',
       '  </header>\n' +
       '\n' +
       '  <sc-if value="{{ readOnly }}" hint-placeholder-val="{{ false }}">\n' +
       '    <div style="display:flex;align-items:center;gap:12px;flex:0 0 auto;padding:9px 22px;background:#FBEDED;border-bottom:1px solid #EFCFCF">\n' +
       '      <span style="height:19px;padding:0 9px;border-radius:999px;background:#fff;color:#AA1F23;font-size:9.5px;font-weight:700;line-height:19px;letter-spacing:.09em;flex:0 0 auto">READ ONLY</span>\n' +
       '      <span style="font-size:12.5px;font-weight:500;color:#AA1F23;text-wrap:pretty">{{ readOnlyNote }}</span>\n' +
       '    </div>\n' +
       '  </sc-if>\n' +
       '\n' +
       '  <div style="display:grid;grid-template-columns:{{ panelCols }};gap:14px;flex:0 0 auto;padding:{{ mainPad }};align-items:stretch">'],

      ['job cell shows save-state marker',
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;font-variant-numeric:tabular-nums;white-space:nowrap"><a href="{{ r.jobHref }}" title="Open homesite detail" style="color:inherit;text-decoration:none" style-hover="color:#005DAA;text-decoration:underline">{{ r.job }}</a></sc-raw-td>',
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;font-variant-numeric:tabular-nums;white-space:nowrap"><a href="{{ r.jobHref }}" title="Open homesite detail" style="color:inherit;text-decoration:none" style-hover="color:#005DAA;text-decoration:underline">{{ r.job }}</a> <sc-if value="{{ r.saveState }}" hint-placeholder-val="{{ false }}"><span style="margin-left:5px;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:{{ r.saveColor }}">{{ r.saveState }}</span></sc-if></sc-raw-td>'],

      ['power/water cells become checkboxes',
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;text-align:center;font-weight:600;color:{{ r.powerColor }}">{{ r.power }}</sc-raw-td>\n' +
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;text-align:center;font-weight:600;color:{{ r.waterColor }}">{{ r.water }}</sc-raw-td>',
       '            <sc-raw-td sc-camel-on-click="{{ r.onPower }}" title="Click to toggle" style="padding:7px 10px;border-bottom:1px solid #F1EBE1;text-align:center;cursor:{{ r.powerCursor }}">\n' +
       '              <span style="{{ r.powerBoxStyle }}"><sc-if value="{{ r.power }}" hint-placeholder-val="{{ false }}"><span style="display:inline-block;width:5px;height:9px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(40deg);margin-top:-2px"></span></sc-if></span>\n' +
       '            </sc-raw-td>\n' +
       '            <sc-raw-td sc-camel-on-click="{{ r.onWater }}" title="Click to toggle" style="padding:7px 10px;border-bottom:1px solid #F1EBE1;text-align:center;cursor:{{ r.waterCursor }}">\n' +
       '              <span style="{{ r.waterBoxStyle }}"><sc-if value="{{ r.water }}" hint-placeholder-val="{{ false }}"><span style="display:inline-block;width:5px;height:9px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(40deg);margin-top:-2px"></span></sc-if></span>\n' +
       '            </sc-raw-td>'],

      ['risk cell becomes editable chips + notes',
       '            <sc-raw-td title="{{ r.riskTitle }}" style="padding:7px 10px;border-bottom:1px solid #F1EBE1;text-align:center;font-size:11px;font-weight:700;letter-spacing:.04em;color:{{ r.riskColor }}">{{ r.risk }}</sc-raw-td>',
       '            <sc-raw-td title="{{ r.riskTitle }}" style="padding:6px 8px;border-bottom:1px solid #F1EBE1;text-align:center;position:relative">\n' +
       '              <span style="display:inline-flex;align-items:center;gap:4px">\n' +
       '                <button sc-camel-on-click="{{ r.onConstRisk }}" style="{{ r.constRiskChipStyle }}">C</button>\n' +
       '                <button sc-camel-on-click="{{ r.onLandRisk }}" style="{{ r.landRiskChipStyle }}">L</button>\n' +
       '                <sc-if value="{{ r.constRiskOn }}" hint-placeholder-val="{{ false }}">\n' +
       '                  <button sc-camel-on-click="{{ r.onConstNoteOpen }}" title="Edit construction risk note" style="width:16px;height:16px;padding:0;border:0;background:transparent;color:#AA1F23;font-size:11px;cursor:pointer">&#9998;</button>\n' +
       '                </sc-if>\n' +
       '                <sc-if value="{{ r.landRiskOn }}" hint-placeholder-val="{{ false }}">\n' +
       '                  <button sc-camel-on-click="{{ r.onLandNoteOpen }}" title="Edit land risk note" style="width:16px;height:16px;padding:0;border:0;background:transparent;color:#AA1F23;font-size:11px;cursor:pointer">&#9998;</button>\n' +
       '                </sc-if>\n' +
       '              </span>\n' +
       '              <sc-if value="{{ r.constNoteEditing }}" hint-placeholder-val="{{ false }}">\n' +
       '                <textarea sc-camel-default-value="{{ r.constNoteValue }}" sc-camel-on-blur="{{ r.onConstNoteBlur }}" sc-camel-on-click="{{ r.stop }}" placeholder="Construction risk note\\u2026" style="position:absolute;left:0;top:100%;z-index:20;width:240px;height:80px;margin-top:2px;padding:7px 8px;background:#fff;border:1px solid #AA1F23;border-radius:4px;box-shadow:0 8px 24px rgba(48,48,48,.14);resize:vertical;line-height:1.4;font-size:12px;outline:none;text-align:left;white-space:pre-wrap"></textarea>\n' +
       '              </sc-if>\n' +
       '              <sc-if value="{{ r.landNoteEditing }}" hint-placeholder-val="{{ false }}">\n' +
       '                <textarea sc-camel-default-value="{{ r.landNoteValue }}" sc-camel-on-blur="{{ r.onLandNoteBlur }}" sc-camel-on-click="{{ r.stop }}" placeholder="Land risk note\\u2026" style="position:absolute;left:0;top:100%;z-index:20;width:240px;height:80px;margin-top:2px;padding:7px 8px;background:#fff;border:1px solid #AA1F23;border-radius:4px;box-shadow:0 8px 24px rgba(48,48,48,.14);resize:vertical;line-height:1.4;font-size:12px;outline:none;text-align:left;white-space:pre-wrap"></textarea>\n' +
       '              </sc-if>\n' +
       '            </sc-raw-td>'],

      ['noc cell becomes click-to-edit date',
       '            <sc-raw-td style="padding:7px 10px;border-bottom:1px solid #F1EBE1;color:#6F6963;white-space:nowrap">{{ r.noc }}</sc-raw-td>',
       '            <sc-raw-td sc-camel-on-click="{{ r.onNocOpen }}" style="padding:7px 10px;border-bottom:1px solid #F1EBE1;color:#6F6963;white-space:nowrap;cursor:{{ r.nocCursor }};position:relative">\n' +
       '              {{ r.noc }}\n' +
       '              <sc-if value="{{ r.nocEditing }}" hint-placeholder-val="{{ false }}">\n' +
       '                <input type="date" sc-camel-default-value="{{ r.nocRaw }}" sc-camel-on-change="{{ r.onNocChange }}" sc-camel-on-blur="{{ r.onNocBlur }}" sc-camel-on-click="{{ r.stop }}" style="position:absolute;left:0;top:100%;z-index:20;margin-top:2px;height:28px;padding:0 6px;background:#fff;border:1px solid #005DAA;border-radius:4px;box-shadow:0 8px 24px rgba(48,48,48,.14);font-size:12px;outline:none">\n' +
       '              </sc-if>\n' +
       '            </sc-raw-td>'],

      ['add toast container',
       '  </sc-if>\n' +
       '</div>\n' +
       '\n' +
       '\n' +
       '</x-dc>',
       '  </sc-if>\n' +
       '</div>\n' +
       '\n' +
       '<div style="position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:400px" aria-live="polite">\n' +
       '  <sc-for list="{{ toasts }}" as="t" hint-placeholder-count="0">\n' +
       '    <div style="{{ t.style }}">\n' +
       '      <div><span style="{{ t.titleStyle }}">{{ t.title }}</span><span style="color:#6F6963">{{ t.body }}</span></div>\n' +
       '      <button sc-camel-on-click="{{ t.onClose }}" style="margin-left:auto;border:0;background:transparent;color:#908A82;cursor:pointer;font-size:15px;line-height:1;padding:0 2px">×</button>\n' +
       '    </div>\n' +
       '  </sc-for>\n' +
       '</div>\n' +
       '\n' +
       '</x-dc>'],
    ]
  },

  /* Homesite Detail -- one homesite, opened from a job number anywhere in the
   * suite. New in the 2026-08-03 (evening) export; it is the page tracker-new
   * was a prototype for, and JOB_LINK() on seven pages now resolves to
   * 'homesite.html?job=<job#>'.
   *
   * It WRITES, and unlike qa-management it needs no patch to do so: commit()
   * already calls persist(), which POSTs {apiBase}/update-job one field at a
   * time and restores the previous value on failure. Verified in the export
   * before shipping rather than assumed -- that is the check qa-management
   * taught us to run on any page with an editable field.
   *
   * walkRef:true -- mgrById() merges window.WALK_ROSTER over OLH_DATA.managers
   * to resolve walk-manager names, per the grep-for-WALK_ rule from
   * walk-calendar. Without walk-config every milestone manager renders blank.
   *
   * caches:[] with an explicit patch, for the same reason walk-calendar needs
   * one: the caches mechanism anchors on "const tick = …" and this page's
   * handler is "const settle = …".
   */
  'homesite.html': {
    data: true, inject: true, walkRef: true, caches: [],
    patches: [
      /* This page could not save AT ALL, and said "Saved" while failing.
       *
       * loadLive() and persist() both fetched /api with `{Accept:...}` and no
       * Authorization header. /api/* is Bearer-only (olh-auth.js
       * requireSession, no cookie fallback), so loadLive() 401s, state.live
       * stays false, and commit()'s `if(this.state.live)` branch is never
       * taken -- the edit is not merely rejected, it is never sent anywhere.
       * The user sees flash('Saved') and the value stick, because commit() has
       * already written it into the local rec.fields.
       *
       * The page still DISPLAYED data because the injected live-loader (outer
       * file, not this component) fetches /jobs with auth and sets
       * window.OLH_DATA -- which is why this read as a working page.
       *
       * The audit was also written before any of that, so the homesite history
       * asserted edits that never reached Airtable. Confirmed on job
       * 16447720100 (2026-08-21): three CEL/ACC Date entries logged from
       * Homesite Detail, record empty. Logging now happens only after the
       * PATCH is accepted, matching walk-calendar.html and qa-management.html. */
      ['add _authHeaders() to the component',
       '  /* Same contract as the tracker: GET {apiBase}/jobs. When the endpoint is not\n' +
       '     reachable (design preview) the bundled dataset stays and edits stay local. */\n' +
       '  async loadLive(){',
       '  /* /api/* reads the session from an Authorization: Bearer header and has no\n' +
       '     cookie fallback (olh-auth.js requireSession), so a request without this\n' +
       '     is a guaranteed 401. Same helper every other writing page uses. Returns\n' +
       '     plain headers when OLHAuth is absent so the design preview still renders\n' +
       '     rather than throwing on mount. */\n' +
       '  _authHeaders(extra){\n' +
       "    const base = Object.assign({Accept:'application/json'}, extra || {});\n" +
       "    if(window.OLHAuth && typeof window.OLHAuth.authHeaders === 'function')\n" +
       '      return window.OLHAuth.authHeaders(base);\n' +
       '    return base;\n' +
       '  }\n' +
       '\n' +
       '  /* Same contract as the tracker: GET {apiBase}/jobs. When the endpoint is not\n' +
       '     reachable (design preview) the bundled dataset stays and edits stay local. */\n' +
       '  async loadLive(){'],

      ['loadLive() sends the session header',
       "      const res = await fetch(this.apiBase() + '/jobs', {headers:{Accept:'application/json'}});",
       "      const res = await fetch(this.apiBase() + '/jobs', {headers: this._authHeaders()});"],

      ['persist() sends the session header',
       "        headers:{'Content-Type':'application/json', Accept:'application/json'},",
       "        headers: this._authHeaders({'Content-Type':'application/json'}),"],

      ['record the audit entry only after the save is confirmed',
       '    if(window.OLHAudit){\n' +
       '      window.OLHAudit.record({\n' +
       "        recordId: rec.id, job: rec.fields['Job #'] || rec.id, field,\n" +
       '        label: LABEL[field] || field, from: show(prev), to: show(value),\n' +
       "        action: 'edit', page: 'Homesite Detail'\n" +
       '      }).then(() => this.loadHistory(true)).catch(() => {});\n' +
       '    }\n' +
       '    rec.fields[field] = value;\n' +
       "    this.setState(s => ({tick: s.tick + 1, save: 'Saving\\u2026'}));\n" +
       '    if(this.state.live){ this.persist(rec, field, value, prev); return; }\n' +
       "    this.flash('Saved');",
       '    /* Logged only once the PATCH has actually succeeded -- /api/audit is\n' +
       '       append-only, so logging first left the history asserting changes\n' +
       '       that never reached Airtable. */\n' +
       '    const logEdit = () => {\n' +
       '      if(!window.OLHAudit) return;\n' +
       '      window.OLHAudit.record({\n' +
       "        recordId: rec.id, job: rec.fields['Job #'] || rec.id, field,\n" +
       '        label: LABEL[field] || field, from: show(prev), to: show(value),\n' +
       "        action: 'edit', page: 'Homesite Detail'\n" +
       '      }).then(() => this.loadHistory(true)).catch(() => {});\n' +
       '    };\n' +
       '    rec.fields[field] = value;\n' +
       "    this.setState(s => ({tick: s.tick + 1, save: 'Saving\\u2026'}));\n" +
       '    if(this.state.live){ this.persist(rec, field, value, prev, logEdit); return; }\n' +
       '    logEdit();\n' +
       "    this.flash('Saved');"],

      ['persist() takes the logger and fires it on success',
       '  async persist(rec, field, value, prev){',
       '  async persist(rec, field, value, prev, logEdit){'],

      ['persist() logs after the response is accepted',
       '      this.setState(s => ({tick: s.tick + 1}));\n' +
       "      this.flash('Saved');\n" +
       '    }catch(err){',
       '      this.setState(s => ({tick: s.tick + 1}));\n' +
       '      if(logEdit) logEdit();\n' +
       "      this.flash('Saved');\n" +
       '    }catch(err){'],

      /* mgrById() memoises into this._mgr on first render, which happens before
       * any data has arrived -- so it freezes an EMPTY map and every milestone
       * manager, buyer and person field renders blank for the life of the page.
       *
       * The page's own loadLive() clears _mgr correctly, but it is not the only
       * way data arrives: the injected loader fetches /api/jobs too and
       * announces it with the olh-data event, and settle() is what runs then.
       * Whichever of the two lands first wins, so the invalidation has to be on
       * both paths or the bug is a race rather than a certainty. */
      ['invalidate the manager index when reference data arrives',
       'const settle = () => {\n' +
       '      if(!this._offVp && window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({narrow:n}));\n' +
       '      this._vpSeed();\n' +
       '      this.setState(s => ({tick: s.tick + 1}));\n' +
       '    };',
       'const settle = () => {\n' +
       '      if(!this._offVp && window.OLHViewport) this._offVp = window.OLHViewport.watch(n => this.setState({narrow:n}));\n' +
       '      this._vpSeed();\n' +
       '      this._mgr = null;\n' +
       '      this.setState(s => ({tick: s.tick + 1}));\n' +
       '    };'],

      /* CEL Letter Sent (see the matching tracker.html patch for the field's
       * full background) had no page anywhere in the suite that let anyone
       * check it. Added as an ordinary checkRow() entry in the readiness
       * section (Meters, NOC & Keys), right after Water Meter -- it is the
       * same toggle/commit/audit-log path Power Meter and Water Meter already
       * use, so this is data only, no new logic. LABEL gets an entry too, so
       * the change-history panel prints "CEL Letter Sent" instead of falling
       * back to the raw field name. */
      ['add CEL Letter Sent to the change-log label map',
       "'QA Ready':'QA Ready', 'Power Meter':'Power', 'Water Meter':'Water',\n" +
       "  'NOC Lock Date':'NOC Lock',",
       "'QA Ready':'QA Ready', 'Power Meter':'Power', 'Water Meter':'Water',\n" +
       "  'CEL Letter Sent':'CEL Letter Sent',\n" +
       "  'NOC Lock Date':'NOC Lock',"],

      ['add a CEL Letter Sent checkRow to the readiness section',
       "checkRow('Water Meter Set', 'Water Meter'),\n" +
       "        dateRow('NOC Lock Date', 'NOC Lock Date'),",
       "checkRow('Water Meter Set', 'Water Meter'),\n" +
       "        checkRow('CEL Letter Sent', 'CEL Letter Sent'),\n" +
       "        dateRow('NOC Lock Date', 'NOC Lock Date'),"],

      /* Read-only milestone view mashed date+time into one string ("Aug 20,
       * 2026 · 2pm") and only for CEL/ACC, since hasTime was a static flag on
       * WALKS rather than a check of the actual field. Split into its own
       * labeled Time field, matching the edit-mode Date/Time layout, and
       * drive hasTime off whether the raw value actually carries a
       * time-of-day -- so it shows for QAI/QAA too once the scheduler starts
       * writing a time onto those fields, with zero further changes needed
       * here. */
      ['split milestone date/time in the read-only view',
       "date: d ? fmtLong(raw) + (time ? ' \\u00b7 ' + time : '') : 'Not scheduled',\n" +
       "        dateStyle: {fontSize:'13px',fontWeight:500,color: d ? (overdue ? '#AA1F23' : '#303030') : '#908A82'},\n" +
       "        mgr: mgr || 'Unassigned', mgrColor: mgr ? '#303030' : '#AA1F23',\n" +
       "        hasBuyer: !!w.buyer, buyer: w.buyer ? (f[w.buyer] ? 'Yes' : 'No') : '',\n" +
       "\n" +
       "        dateValue: isoDay(raw),\n" +
       "        onDate: e => this.commitDate(w.date, e.target.value, raw),\n" +
       "        hasTime: !!w.hasTime,\n" +
       "        timeValue: isoTime24(raw),\n" +
       "        onTime: e => this.commitTime(w.date, e.target.value, raw),\n" +
       "        gridCols: n ? '1fr' : (w.hasTime ? '150px 110px minmax(0,1fr)' : '170px minmax(0,1fr)'),",
       "date: d ? fmtLong(raw) : 'Not scheduled',\n" +
       "        time: time || '',\n" +
       "        dateStyle: {fontSize:'13px',fontWeight:500,color: d ? (overdue ? '#AA1F23' : '#303030') : '#908A82'},\n" +
       "        mgr: mgr || 'Unassigned', mgrColor: mgr ? '#303030' : '#AA1F23',\n" +
       "        hasBuyer: !!w.buyer, buyer: w.buyer ? (f[w.buyer] ? 'Yes' : 'No') : '',\n" +
       "\n" +
       "        dateValue: isoDay(raw),\n" +
       "        onDate: e => this.commitDate(w.date, e.target.value, raw),\n" +
       "        hasTime: !!w.hasTime || !!time,\n" +
       "        timeValue: isoTime24(raw),\n" +
       "        onTime: e => this.commitTime(w.date, e.target.value, raw),\n" +
       "        gridCols: n ? '1fr' : ((w.hasTime || !!time) ? '150px 110px minmax(0,1fr)' : '170px minmax(0,1fr)'),"],

      ['add the read-only Time field beside Date in the milestone view',
       '<sc-if value="{{ noEdit }}" hint-placeholder-val="{{ true }}">\n' +
       '                    <span style="display:flex;gap:24px;flex-wrap:wrap">\n' +
       '                      <span style="display:flex;flex-direction:column;gap:1px">\n' +
       '                        <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#908A82">Date</span>\n' +
       '                        <span style="{{ m.dateStyle }}">{{ m.date }}</span>\n' +
       '                      </span>\n' +
       '                      <span style="display:flex;flex-direction:column;gap:1px;min-width:0">',
       '<sc-if value="{{ noEdit }}" hint-placeholder-val="{{ true }}">\n' +
       '                    <span style="display:flex;gap:24px;flex-wrap:wrap">\n' +
       '                      <span style="display:flex;flex-direction:column;gap:1px">\n' +
       '                        <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#908A82">Date</span>\n' +
       '                        <span style="{{ m.dateStyle }}">{{ m.date }}</span>\n' +
       '                      </span>\n' +
       '                      <sc-if value="{{ m.hasTime }}" hint-placeholder-val="{{ false }}">\n' +
       '                        <span style="display:flex;flex-direction:column;gap:1px">\n' +
       '                          <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#908A82">Time</span>\n' +
       '                          <span style="{{ m.dateStyle }}">{{ m.time }}</span>\n' +
       '                        </span>\n' +
       '                      </sc-if>\n' +
       '                      <span style="display:flex;flex-direction:column;gap:1px;min-width:0">']
    ]
  },

  'scheduler.html': {
    data: true, inject: true, walkRef: true, caches: ['_sites', '_byLen', '_unmapped', '_seed'],
    patches: [
      ['add celLetterSent + the Manager links to the homesite record',
       'celTime: f["CEL Date"] || null, accTime: f["ACC Date"] || null,\n',
       'celTime: f["CEL Date"] || null, accTime: f["ACC Date"] || null,\n' +
       '        celLetterSent: !!f["CEL Letter Sent"],\n' +
       '        /* The Manager link arrays, so seed() can attribute a walk to the\n' +
       '           person actually assigned to it instead of guessing. Raw Airtable\n' +
       '           shape: an array of Managers-table record ids, or absent. */\n' +
       '        qaiMgr: f["QAI Manager"] || [], qaaMgr: f["QAA Manager"] || [],\n' +
       '        celMgr: f["CEL Manager"] || [], accMgr: f["ACC Manager"] || [],\n'],

      /* Reset used to wipe both CEL and ACC unconditionally, even after the
       * physical CEL letter had already gone out to the buyer with a specific
       * date/time on it. Once that letter is on record, locking Reset stops
       * someone from clearing the walk and re-saving a different date the
       * homeowner was never told about. */
      ['gate the Reset button on CEL Letter Sent',
       'saveCursor: unsaved && !s.saving ? "pointer" : "not-allowed",\n      onReset: () => {\n        const committed = Object.assign({}, s.assignments);\n        const drafts = Object.assign({}, s.draft);\n        if (sel) { delete committed[sel.job]; delete drafts[sel.job]; }\n        this.setState({ assignments: committed, draft: drafts, step: null, mWarn: "" });\n      },\n',
       'saveCursor: unsaved && !s.saving ? "pointer" : "not-allowed",\n      resetOff: !!(sel && sel.celLetterSent),\n      resetCursor: (sel && sel.celLetterSent) ? "not-allowed" : "pointer",\n      resetOpacity: (sel && sel.celLetterSent) ? ".5" : "1",\n      resetTitle: (sel && sel.celLetterSent) ? "CEL letter already sent for this homesite \\u2014 walks can not be reset." : "",\n      onReset: () => {\n        if (sel && sel.celLetterSent) return;\n        const committed = Object.assign({}, s.assignments);\n        const drafts = Object.assign({}, s.draft);\n        if (sel) { delete committed[sel.job]; delete drafts[sel.job]; }\n        this.setState({ assignments: committed, draft: drafts, step: null, mWarn: "" });\n      },\n'],

      ['disable and grey out the Reset button when locked',
       '<button sc-camel-on-click="{{ onReset }}" style="height:30px;padding:0 12px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#F1EBE1">Reset</button>',
       '<button sc-camel-on-click="{{ onReset }}" disabled="{{ resetOff }}" title="{{ resetTitle }}" style="height:30px;padding:0 12px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;color:#303030;font-size:12px;font-weight:600;cursor:{{ resetCursor }};opacity:{{ resetOpacity }};white-space:nowrap" style-hover="background:#F1EBE1">Reset</button>'],

      /* Time Off gained optional Start Time/End Time (see netlify/functions/
       * time-off.js): a lone date still means the whole day is off, but a
       * date with both times set now blocks only that clock-hour window.
       * isOff() takes the slot being checked ("9:00 AM"/"12:00 PM"/"3:00 PM")
       * and only excludes a QAM when that slot's hour falls inside the
       * window -- both existing call sites already have a slot in scope. */
      ['add slotHour()/clockHour() helpers',
       'const adjustWeekend = d => d.getDay() === 6 ? addDays(d, -1) : d.getDay() === 0 ? addDays(d, 1) : new Date(d);',
       'const adjustWeekend = d => d.getDay() === 6 ? addDays(d, -1) : d.getDay() === 0 ? addDays(d, 1) : new Date(d);\n' +
       '/* "9:00 AM" / "12:00 PM" / "3:00 PM" -> 24h decimal hour (9, 12, 15), for\n' +
       '   comparing a fixed CEL/ACC slot against a partial-day time-off window. */\n' +
       'const slotHour = slot => { const m = /^(\\d+):(\\d+)\\s*(AM|PM)$/i.exec(String(slot).trim()); if (!m) return null;\n' +
       '  let h = parseInt(m[1], 10) % 12; if (/PM/i.test(m[3])) h += 12; return h + parseInt(m[2], 10) / 60; };\n' +
       '/* "HH:MM" -> 24h decimal hour, for the same comparison against startTime/endTime. */\n' +
       'const clockHour = hhmm => { const m = /^(\\d\\d):(\\d\\d)$/.exec(String(hhmm).trim()); if (!m) return null;\n' +
       '  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60; };'],

      ['loadTimeOff() carries startTime/endTime',
       'this.setState({ timeOff: data.entries.map(e => ({ personId: e.personId, date: e.date })) });',
       'this.setState({ timeOff: data.entries.map(e => ({ personId: e.personId, date: e.date, startTime: e.startTime || "", endTime: e.endTime || "" })) });'],

      ['isOff() checks the slot hour against a partial-day window',
       'isOff(id, k) { return this.state.timeOff.some(t => t.personId === id && t.date === k); }',
       'isOff(id, k, slot) { return this.state.timeOff.some(t => {\n' +
       '    if (t.personId !== id || t.date !== k) return false;\n' +
       '    if (!t.startTime || !t.endTime) return true; // full day off\n' +
       '    if (!slot) return true; // no slot to check against -- treat as blocked, same as before\n' +
       '    const sh = slotHour(slot), start = clockHour(t.startTime), end = clockHour(t.endTime);\n' +
       '    return sh != null && start != null && end != null && sh >= start && sh < end;\n' +
       '  }); }'],

      ['candidate-pool filter passes slot to isOff()',
       'const avail = g.filter(p => !this.isOff(p.id, k) &&',
       'const avail = g.filter(p => !this.isOff(p.id, k, slot) &&'],

      ['manual-assign guard passes the chosen slot to isOff()',
       'if (this.isOff(p.id, k)) { this.setState({ mWarn: p.name + " is on time off that day." }); return; }',
       'if (this.isOff(p.id, k, this.state.mSlot)) { this.setState({ mWarn: p.name + " is on time off " + (this.state.mSlot ? "during the " + this.state.mSlot + " slot." : "that day.") }); return; }'],

      /* The availability engine read a snapshot taken at first render.
       *
       * slotTaken()/dayHours() -- the two functions that decide whether a slot
       * is free -- both read bookings(), which is seed() plus this session's
       * picks. seed() was memoized on `if (this._seed) return this._seed` and
       * `this._seed` was assigned in one place and cleared in NONE: not by
       * _commitPlan, not by resetWalks, not by the olh-data tick, not by the
       * tab-focus refetch added in fb04567. So a slot that had just been booked
       * -- here, on walk-calendar, or by another person -- stayed on offer for
       * the life of the page, and the next homesite could be scheduled straight
       * on top of it.
       *
       * Three linked fixes, which have to land together:
       *
       *  1. Cache on the homesites() array IDENTITY. homesites() returns a new
       *     array whenever _sites is invalidated, so seed() recomputes exactly
       *     when the data changed. This needs no matching `_seed = null` at
       *     each write site, which is what let it drift in the first place.
       *     ('_seed' is in `caches` above as well, for the tick path.)
       *
       *  2. Attribute a walk to its REAL manager. seed() round-robined every
       *     homesite's walks onto a home QAM and never read the Manager fields,
       *     so a walk charged the wrong person's day -- and immediately after a
       *     save it moved to the home QAM instead of whoever was just picked.
       *     The round-robin stays as the estimate for UNASSIGNED walks only, so
       *     baseline load is unchanged where nobody is assigned yet. A homesite
       *     with a real manager but no home QAM now counts (it was skipped
       *     entirely before, by the `if (!pool.length) return`).
       *
       *  3. bookings() carries drafts ONLY. Once (1) is in, a committed walk
       *     already arrives via seed() -- _commitPlan patches window.OLH_DATA
       *     in place before returning -- so also adding state.assignments would
       *     count it twice and over-block the assignee's day. */
      ['seed(): self-invalidating cache + real-manager attribution',
       '  seed() {\n' +
       '    if (this._seed) return this._seed;\n' +
       '    const out = [];\n' +
       '    this.homesites().forEach((h, idx) => {\n' +
       '      const pool = this.homeQams(h.community);\n' +
       '      if (!pool.length) return;\n' +
       '      const who = pool[idx % pool.length].id;\n' +
       '      const add = (code, date, slot) => {\n' +
       '        if (!date) return;\n' +
       '        out.push({ personId: who, date: key(date), slot: slot || null, hours: HOURS[code], community: h.community, label: code + " \\u00b7 job " + h.job });\n' +
       '      };\n' +
       '      add("QAI", h.qai, null);\n' +
       '      add("QAA", h.qaa, null);\n' +
       '      add("CEL", h.cel, this.slotOf(h.celTime));\n' +
       '      add("ACC", h.acc, this.slotOf(h.accTime));\n' +
       '    });\n' +
       '    this._seed = out;\n' +
       '    return out;\n' +
       '  }',
       '  seed() {\n' +
       '    /* Keyed on the homesites() array IDENTITY, not a bare truthiness\n' +
       '       check -- see the note on this patch in dev/build-live-pages.js. */\n' +
       '    const sites = this.homesites();\n' +
       '    if (this._seed && this._seedFor === sites) return this._seed;\n' +
       '    const out = [];\n' +
       '    sites.forEach((h, idx) => {\n' +
       '      const pool = this.homeQams(h.community);\n' +
       '      const who = pool.length ? pool[idx % pool.length].id : null;\n' +
       '      /* Prefer the manager actually assigned to THIS walk; `who` is only\n' +
       '         an estimate for walks nobody has been given yet. */\n' +
       '      const add = (code, date, slot, links) => {\n' +
       '        if (!date) return;\n' +
       '        const owner = this.rosterIdForLink(links) || who;\n' +
       '        if (!owner) return;\n' +
       '        out.push({ personId: owner, date: key(date), slot: slot || null, hours: HOURS[code], community: h.community, label: code + " \\u00b7 job " + h.job });\n' +
       '      };\n' +
       '      add("QAI", h.qai, null, h.qaiMgr);\n' +
       '      add("QAA", h.qaa, null, h.qaaMgr);\n' +
       '      add("CEL", h.cel, this.slotOf(h.celTime), h.celMgr);\n' +
       '      add("ACC", h.acc, this.slotOf(h.accTime), h.accMgr);\n' +
       '    });\n' +
       '    this._seedFor = sites;\n' +
       '    this._seed = out;\n' +
       '    return out;\n' +
       '  }'],

      ['add rosterIdForLink() (inverse of resolveMgrId)',
       '  homeQams(community) {',
       '  /* Inverse of resolveMgrId(): a QAI/QAA/CEL/ACC Manager cell links to the\n' +
       '     Managers table, but capacity is tracked against Walk Roster person ids.\n' +
       '     Bridged by name, the same join resolveMgrId() uses in the other\n' +
       '     direction. Returns null when the link is empty or the person is not on\n' +
       '     the walk roster -- the caller then falls back to the home-QAM estimate\n' +
       '     rather than dropping the load. */\n' +
       '  rosterIdForLink(links) {\n' +
       '    if (!Array.isArray(links) || !links.length) return null;\n' +
       '    const mgrs = (window.OLH_DATA && window.OLH_DATA.managers) || [];\n' +
       '    const m = mgrs.find(x => x.id === links[0]);\n' +
       '    if (!m) return null;\n' +
       '    const p = this.roster().find(r => r.name === m.name);\n' +
       '    return p ? p.id : null;\n' +
       '  }\n' +
       '\n' +
       '  homeQams(community) {'],

      ['bookings(): only uncommitted drafts, so a saved walk is not counted twice',
       '  bookings() {\n' +
       '    const extra = [];\n' +
       '    const jobs = new Set(Object.keys(this.state.assignments).concat(Object.keys(this.state.draft)));\n' +
       '    jobs.forEach(job => {\n' +
       '      const a = this.planFor(job);',
       '  bookings() {\n' +
       '    /* Drafts only -- a committed walk already arrives via seed(). */\n' +
       '    const extra = [];\n' +
       '    const jobs = new Set(Object.keys(this.state.draft));\n' +
       '    jobs.forEach(job => {\n' +
       '      const a = this.state.draft[job] || {};']
    ]
  },

  /* QAI/QAA carry only a date, no time-of-day. _suggestForDay's slot-conflict
   * check (free()) keyed on r.sortTime, so every same-day QAI/QAA walk parsed
   * to an identical midnight timestamp -- the moment a QA Manager held one,
   * they read as double-booked for every subsequent same-day QAI/QAA, leaving
   * walks stuck unassigned despite full drive-time coverage. CEL/ACC carry
   * real scheduled times and keep the exact check; only QAI/QAA are loosened. */
  'workload.html': {
    data: true, inject: true, walkRef: true, optimizer: true, caches: ['_walks', '_byLen', '_unattributed'],
    patches: [
      ['loosen the QAI/QAA slot-conflict check (real times still enforced for CEL/ACC)',
       'const free = (n, r) => !(times[n + "|" + r.sortTime] || []).length;',
       'const free = (n, r) => (r.code === "QAI" || r.code === "QAA") ? true : !(times[n + "|" + r.sortTime] || []).length;'],

      /* This page already gates CEL/ACC walks entirely behind CEL Letter Sent
       * (optimizableWalks()'s `gated` flag) -- a CEL/ACC row can only appear
       * here once the letter is checked, so there is nothing to mark. What
       * was missing was any indication of WHY a CEL/ACC pill is schedulable
       * at all. Adds a title attribute to both pill spans (Walk Detail's wide
       * table and its narrow-card fallback) and a pillTitle field that reads
       * "<code> — Celebration letter sent" for CEL/ACC and just the plain
       * code for QAI/QAA, so hovering the pill explains the gating instead of
       * showing nothing. */
      ['add a title attribute to the Walk Detail wide-table pill',
       '<span style="display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:20px;padding:0 9px;border-radius:999px;background:{{ r.pillBg }};color:{{ r.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em">{{ r.code }}</span>\n                </sc-raw-td>',
       '<span title="{{ r.pillTitle }}" style="display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:20px;padding:0 9px;border-radius:999px;background:{{ r.pillBg }};color:{{ r.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em">{{ r.code }}</span>\n                </sc-raw-td>'],

      ['add a title attribute to the Walk Detail narrow-card pill',
       '<span style="display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:20px;padding:0 9px;border-radius:999px;background:{{ r.pillBg }};color:{{ r.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em;flex:0 0 auto">{{ r.code }}</span>',
       '<span title="{{ r.pillTitle }}" style="display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:20px;padding:0 9px;border-radius:999px;background:{{ r.pillBg }};color:{{ r.pillColor }};font-size:10px;font-weight:700;letter-spacing:.06em;flex:0 0 auto">{{ r.code }}</span>'],

      ['compute pillTitle for the Walk Detail rows',
       'code: w.code, pillBg: COLOR[w.code], pillColor: "#fff",',
       'code: w.code, pillBg: COLOR[w.code], pillColor: "#fff",\n            pillTitle: (w.code === "CEL" || w.code === "ACC") ? w.code + " \\u2014 Celebration letter sent (that gates this walk)" : w.code,']
    ]
  },

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
    data: true, inject: true, walkRef: true, optimizer: true, caches: [],
    patches: [
      ['invalidate the community index when reference data arrives',
       'this._h = () => this.setState({ ready: true });',
       'this._h = () => { this._byLen = null; this.setState({ ready: true }); };'],

      /* This page already gates CEL/ACC walks entirely behind CEL Letter Sent
       * (build()'s `gated` flag on the WALKS array) -- a CEL/ACC row can only
       * appear here once the letter is checked, so there is nothing to mark.
       * Appends a note to the existing pillTitle field explaining why, so
       * hovering a CEL/ACC pill says so instead of just repeating the walk
       * name. Mirrors the matching workload.html patch. */
      ['note the letter-sent gating in the CEL/ACC pill tooltip',
       'pillBg: r.accent, pillColor: "#fff", pillBorder: r.accent, pillTitle: r.walk,',
       'pillBg: r.accent, pillColor: "#fff", pillBorder: r.accent, pillTitle: r.walk + (r.code === "CEL" || r.code === "ACC" ? " \\u2014 Celebration letter sent (this is why it can be scheduled)" : ""),']
    ]
  },

  /* QA Management -- today's walks by community, marked completed or missed.
   *
   * Shipped 2026-08-03 after being held back on its first export. The design
   * gives it a save() that only mutates window.OLH_DATA and then posts to
   * /api/audit, so a QA Manager marked twelve walks, saw "Batch Saved",
   * refreshed, and found nothing -- while the append-only change log
   * permanently recorded twelve completions that never reached Airtable. An
   * audit trail that can be wrong in that direction is worse than none, and
   * nothing downstream reconciles it. The patches below give save() a real
   * write path; see dev/../qa-management-handoff.md for the full account.
   *
   * walkRef:true -- the page reads window.WALK_ROSTER to resolve manager names
   * (mgrNames/_mgr). The build deletes the bundled WALK_* fixture, so getting
   * this wrong ships a page whose every walk is attributed to nobody. This is
   * the same mistake walk-calendar shipped with; the rule from that one is to
   * grep the page for WALK_ rather than reason about what it "should" need.
   */
  'qa-management.html': {
    data: true, inject: true, walkRef: true, multiselect: true, caches: [],
    patches: [
      /* Each writes.push() gains a `patch` -- the exact /api/update-job fields
       * payload for that one mark. Kept beside the audit entry it belongs to so
       * the log and the write cannot describe different things, and anchored on
       * the pushes themselves rather than on save() as a whole, so a re-export
       * that reflows the method does not silently drop the write path. */
      ['carry the completion write beside its audit entry',
       "        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.done,\n" +
       "          label:w.spec.label + ' completed', from:'No', to:'Yes', action:'edit'});",
       "        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.done,\n" +
       "          label:w.spec.label + ' completed', from:'No', to:'Yes', action:'edit',\n" +
       "          patch:{[w.spec.done]:true}});"],

      /* A missed walk had no representation anywhere: the design logged it
       * against the walk's DATE field with the prose value "Missed - reason",
       * which only survived because /api/audit takes any string. It now writes
       * the three real fields added to the Jobs table on 2026-08-03, and the
       * audit entry names the field it actually wrote rather than a date field
       * it did not. The note is optional and omitted when blank -- an empty
       * string would overwrite a note left by an earlier save. */
      ['write a missed walk to its own fields, not to the date field',
       "        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.date,\n" +
       "          label:w.spec.label + ' missed', from:fmtD(w.raw),\n" +
       "          to:'Missed \\u2014 ' + reason + (note ? ' \\u00b7 ' + note : ''), action:'edit'});",
       "        const miss = {};\n" +
       "        miss[w.spec.code + ' Missed'] = true;\n" +
       "        miss[w.spec.code + ' Miss Reason'] = reason;\n" +
       "        if(note) miss[w.spec.code + ' Miss Note'] = note;\n" +
       "        rec.fields[w.spec.code + ' Missed'] = true;\n" +
       "        rec.fields[w.spec.code + ' Miss Reason'] = reason;\n" +
       "        writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId,\n" +
       "          field:w.spec.code + ' Missed',\n" +
       "          label:w.spec.label + ' missed', from:'No',\n" +
       "          to:'Yes \\u2014 ' + reason + (note ? ' \\u00b7 ' + note : ''), action:'edit',\n" +
       "          patch:miss});"],

      /* Walk Miss Log (tblLA3n0SRgUA9A0z, added 2026-08-12) is the append-only
       * history the Jobs-level Missed/Miss Reason/Miss Note fields never were --
       * those three get overwritten by the next miss on the same walk type, so a
       * home missed twice in a row shows only the second one. missLog rides on
       * the same writes.push() this constructs, carried as a sibling of `patch`
       * rather than folded into it, because it targets a different table
       * (/api/walk-miss-log, not /api/update-job) and _commit has to know which
       * calls go where. w.raw is the walk's own scheduled date/time, captured
       * before this miss (unlike a reschedule) ever changes it -- see the
       * `from:fmtD(w.raw)` a few lines up, same value, same reason. */
      ['carry the Walk Miss Log payload beside the same write',
       "          patch:miss});",
       "          patch:miss,\n" +
       "          missLog:{walkType:w.spec.code, missedDate:w.raw || null, reason:reason, note:note || ''}});"],

      /* The rescheduled value has to be captured before it is formatted: the
       * audit entry carries fmtD(d.resched) for a human, and Airtable needs the
       * ISO value with the original time component preserved. */
      ['carry the reschedule write beside its audit entry',
       "        if(d.resched){\n" +
       "          const old = rec.fields[w.spec.date];\n" +
       "          rec.fields[w.spec.date] = /T\\d/.test(String(old)) ? d.resched + String(old).slice(10) : d.resched;\n" +
       "          moved++;\n" +
       "          writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.date,\n" +
       "            label:w.spec.label + ' rescheduled', from:fmtD(old), to:fmtD(d.resched), action:'schedule'});\n" +
       "        }",
       "        if(d.resched){\n" +
       "          const old = rec.fields[w.spec.date];\n" +
       "          const next = /T\\d/.test(String(old)) ? d.resched + String(old).slice(10) : d.resched;\n" +
       "          rec.fields[w.spec.date] = next;\n" +
       "          moved++;\n" +
       "          writes.push({recordId:w.recordId, job:rec.fields['Job #'] || w.recordId, field:w.spec.date,\n" +
       "            label:w.spec.label + ' rescheduled', from:fmtD(old), to:fmtD(d.resched), action:'schedule',\n" +
       "            patch:{[w.spec.date]:next}});\n" +
       "        }"],

      /* The tail of save() fired the audit posts, cleared the draft and toasted
       * "Batch Saved" synchronously -- all three before anything had been
       * written. _commit owns that tail now so each one follows its write. */
      ['hand the tail of save() to the real write path',
       "    if(window.OLHAudit) writes.forEach(x => window.OLHAudit.record(Object.assign({page:'QA Management'}, x)).catch(() => {}));\n" +
       "    this._mgr = null;\n" +
       "    this.writeDraft({});\n" +
       "    setTimeout(() => this.setState(s => ({saving:false, draft:{}, tick:s.tick+1})), 320);\n" +
       "    const bits = [done + ' completed', missed + ' missed'];\n" +
       "    if(moved) bits.push(moved + ' rescheduled');\n" +
       "    this.toast('ok','Batch Saved', bits.join(' \\u00b7 ') + '.');",
       "    this._commit(writes, done, missed, moved);"],

      ['add the write path itself',
       "  save(){\n" +
       "    if(!this.can('walk.schedule')){",
       "  /* Authorization header or a legible failure -- never an anonymous write.\n" +
       "     /api/update-job reads Bearer and has no cookie fallback, so a request\n" +
       "     without this header is a guaranteed 401. olh-auth.js is a bundler asset\n" +
       "     and may not have executed yet, which is why this is a check and not an\n" +
       "     assumption. */\n" +
       "  _authHeaders(){\n" +
       "    if(!window.OLHAuth || typeof window.OLHAuth.authHeaders !== 'function'){\n" +
       "      throw new Error('The sign-in module has not loaded, so this page cannot save. Reload the page.');\n" +
       "    }\n" +
       "    return window.OLHAuth.authHeaders({'Content-Type':'application/json'});\n" +
       "  }\n" +
       "\n" +
       "  /* PATCH first, audit second, and report per record.\n" +
       "\n" +
       "     The ordering is the whole point. /api/audit is append-only and takes\n" +
       "     its author from the session and its timestamp from the server clock,\n" +
       "     deliberately, so that the log is trustworthy. Recording before the\n" +
       "     write inverts that guarantee: it produces an authoritative entry,\n" +
       "     attributed to a real person at a real time, for a change that never\n" +
       "     happened. So nothing is logged until the PATCH it describes returns.\n" +
       "\n" +
       "     Per record, because update-job.js takes one record at a time and there\n" +
       "     is no batch endpoint -- a twelve-walk save is twelve requests and any\n" +
       "     one of them can fail alone. A blanket 'Batch Saved' over a partial\n" +
       "     failure is the same lie in a smaller font.\n" +
       "\n" +
       "     On failure the draft is deliberately LEFT IN PLACE. It is in\n" +
       "     localStorage under olh.qamgmt.draft.v1, so the marks that did not land\n" +
       "     survive a reload and can be saved again; clearing it would discard the\n" +
       "     only remaining record of them. */\n" +
       "  async _commit(writes, done, missed, moved){\n" +
       "    let ok = 0;\n" +
       "    const failed = [];\n" +
       "    for(const x of writes){\n" +
       "      if(!x.patch){ ok++; continue; }\n" +
       "      try{\n" +
       "        const res = await fetch('/api/update-job', {\n" +
       "          method:'POST', headers:this._authHeaders(),\n" +
       "          body: JSON.stringify({recordId:x.recordId, fields:x.patch})\n" +
       "        });\n" +
       "        const data = await res.json().catch(() => null);\n" +
       "        if(!res.ok) throw new Error((data && data.error) || ('Save failed (' + res.status + ')'));\n" +
       "        ok++;\n" +
       "        if(window.OLHAudit){\n" +
       "          const entry = Object.assign({page:'QA Management'}, x);\n" +
       "          delete entry.patch;\n" +
       "          await window.OLHAudit.record(entry).catch(() => {});\n" +
       "        }\n" +
       "        if(x.missLog){\n" +
       "          /* Best-effort and after the Jobs write, not before: the Jobs\n" +
       "             fields are the record of truth for today's queues (Missed\n" +
       "             Walks, workload) and must land even if this history table is\n" +
       "             unreachable. A failed log call is swallowed rather than added\n" +
       "             to `failed`, so it never turns a saved miss into a reported\n" +
       "             failure the QA Manager would otherwise have to re-save. */\n" +
       "          try{\n" +
       "            await fetch('/api/walk-miss-log', {\n" +
       "              method:'POST', headers:this._authHeaders(),\n" +
       "              body: JSON.stringify(Object.assign({recordId:x.recordId, job:x.job, page:'QA Management'}, x.missLog))\n" +
       "            });\n" +
       "          }catch(_e){ /* Jobs fields already saved; nothing to roll back. */ }\n" +
       "        }\n" +
       "      }catch(err){\n" +
       "        failed.push((x.job || x.recordId) + ' \\u00b7 ' + x.label + ': ' + ((err && err.message) || err));\n" +
       "      }\n" +
       "    }\n" +
       "    if(failed.length){\n" +
       "      this.setState(s => ({saving:false, tick:s.tick+1}));\n" +
       "      this.toast('err', ok ? 'Partly Saved' : 'Nothing Saved',\n" +
       "        ok + ' of ' + (ok + failed.length) + ' written. ' + failed[0] +\n" +
       "        (failed.length > 1 ? ' (and ' + (failed.length - 1) + ' more)' : ''));\n" +
       "      return;\n" +
       "    }\n" +
       "    this._mgr = null;\n" +
       "    this.writeDraft({});\n" +
       "    this.setState(s => ({saving:false, draft:{}, tick:s.tick+1}));\n" +
       "    const bits = [done + ' completed', missed + ' missed'];\n" +
       "    if(moved) bits.push(moved + ' rescheduled');\n" +
       "    this.toast('ok','Batch Saved', bits.join(' \\u00b7 ') + '.');\n" +
       "  }\n" +
       "\n" +
       "  save(){\n" +
       "    if(!this.can('walk.schedule')){"],

      /* Community was the one native <select> filter on this page (Walk Type
       * is already a set of toggle chips, so nothing to convert there).
       * Converted to <olh-multiselect> (see dev/multiselect.js) the same way
       * as tracker.html's filters: a ref, pushed down via componentDidUpdate
       * since the element takes its options through setOptions() rather than
       * nested <option> markup. */
      ['state: comm string -> array',
       "day: null, comm: '', types: [], openOnly: false, q: '', sortBy: 'type',",
       "day: null, comm: [], types: [], openOnly: false, q: '', sortBy: 'type',"],

      ['add componentDidUpdate + syncComm() to push options/value into the ref',
       "componentDidMount(){",
       "componentDidUpdate(){ this.syncComm(); }\n\n" +
       "  /* <olh-multiselect> is a plain custom element, not a native <select> --\n" +
       "     it takes its option list via setOptions() rather than nested <option>\n" +
       "     markup, and this pushes the current value down too, the same way\n" +
       "     tracker.html's syncSelects() does for its own filter refs. */\n" +
       "  syncComm(){\n" +
       "    const n = this.commRef && this.commRef.current;\n" +
       "    if(!n) return;\n" +
       "    if(n.setOptions && this._commOptions) n.setOptions(this._commOptions);\n" +
       "    if(n.value !== this.state.comm) n.value = this.state.comm;\n" +
       "  }\n\n" +
       "  componentDidMount(){"],

      ['filter predicate: equality -> array includes (shown)',
       "let shown = s.comm ? all.filter(w => w.community === s.comm) : all.slice();",
       "let shown = s.comm.length ? all.filter(w => s.comm.indexOf(w.community) > -1) : all.slice();"],

      ['filter predicate: equality -> array includes (scope, for the stat tiles)',
       "const scope = s.comm ? all.filter(w => w.community === s.comm) : all;",
       "const scope = s.comm.length ? all.filter(w => s.comm.indexOf(w.community) > -1) : all;"],

      ['stash raw community options right after they are computed',
       "const comms = Array.from(new Set(all.map(w => w.community))).sort((a,b) => a.localeCompare(b));",
       "const comms = Array.from(new Set(all.map(w => w.community))).sort((a,b) => a.localeCompare(b));\n" +
       "    /* <olh-multiselect> takes its option list via setOptions() rather than\n" +
       "       nested <option> markup (see syncComm()), so stash it here instead of\n" +
       "       returning it from renderVals() for the template to loop over. */\n" +
       "    this._commOptions = comms.map(c => ({v:c}));"],

      ['drop comm/commOptions from the return object, ref instead of controlled value',
       "comm: s.comm,\n" +
       "      onComm: e => this.setState({comm: e.target.value === 'All communities' ? '' : e.target.value}),\n" +
       "      commOptions: [{v:'All communities'}].concat(comms.map(c => ({v:c}))),",
       "refComm: this.commRef || (this.commRef = React.createRef()),\n" +
       "      onComm: e => this.setState({comm: e.target.value}),"],

      ['markup: Community filter -> <olh-multiselect>',
       '<sc-raw-select value="{{ comm }}" sc-camel-on-change="{{ onComm }}" style="height:38px;min-width:{{ selW }};padding:0 28px 0 11px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:15px;color:#303030;cursor:pointer">\n' +
       '          <sc-for list="{{ commOptions }}" as="o"><option value="{{ o.v }}" label="{{ o.v }}"></option></sc-for>\n' +
       '        </sc-raw-select>',
       '<olh-multiselect ref="{{ refComm }}" sc-camel-on-change="{{ onComm }}" placeholder="All communities" style="height:38px;min-width:{{ selW }};padding:0 28px 0 11px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:15px;color:#303030;cursor:pointer"></olh-multiselect>']
    ]
  },

  // The tracker ships its own loadLive() and the /update-job write path. It
  // still needs the fixture gone: its catch block left window.OLH_DATA pointing
  // at the mock and componentDidMount called loadLive(false, false) --
  // announce=false -- so a failed FIRST load rendered fabricated records with no
  // message at all.
  'tracker.html': {
    data: true, inject: false, multiselect: true, caches: [],
    patches: [
      /* Refetch when the tab comes back to the front.
       *
       * This is the one page built with inject:false, so dev/live-loader.js --
       * and the visibilitychange refetch added to it in 2026-08 -- is never
       * injected here. Every other page picked that up for free; the tracker
       * silently did not. Its data arrived once from loadLive() on mount and
       * then only via the Refresh button, so a walk saved on scheduler.html,
       * or any edit by another person, stayed invisible in an already-open
       * tracker tab until someone reloaded it. That is the second, independent
       * reason a save "doesn't show up in the tracker" -- separate from the
       * write-path bugs fixed in homesite.html and scheduler.html.
       *
       * force=true bypasses the 30s cache in jobs.js: the whole point is to
       * show a change that was just made, and a cached pre-save payload would
       * defeat it. announce=false keeps the toast for the explicit Refresh
       * button. 15s floor so alt-tabbing is not a fetch storm. Guarded on
       * state.live so the design preview never fetches.
       *
       * The component had no componentWillUnmount at all, so one is added
       * rather than leaving a document-level listener behind. */
      ['refetch on tab focus',
       "    window.addEventListener('walk-ref', this._wr = () => { this._mgr = null; this.setState(s => ({tick:s.tick+1})); });\n" +
       '    this.editRef = React.createRef();',
       "    window.addEventListener('walk-ref', this._wr = () => { this._mgr = null; this.setState(s => ({tick:s.tick+1})); });\n" +
       '    this._lastFocusLoad = Date.now();\n' +
       '    this._onVis = () => {\n' +
       "      if(document.visibilityState !== 'visible') return;\n" +
       '      const now = Date.now();\n' +
       '      if(now - this._lastFocusLoad < 15000) return;\n' +
       '      this._lastFocusLoad = now;\n' +
       '      if(this.state.live) this.loadLive(true, false);\n' +
       '    };\n' +
       "    document.addEventListener('visibilitychange', this._onVis);\n" +
       '    this.editRef = React.createRef();'],

      ['detach the visibility listener on unmount',
       '  componentDidUpdate(){\n    this.syncSelects();',
       '  componentWillUnmount(){\n' +
       "    if(this._onVis) document.removeEventListener('visibilitychange', this._onVis);\n" +
       '    if(this._settle) { clearInterval(this._settle); this._settle = null; }\n' +
       '    if(this._offVp) this._offVp();\n' +
       '  }\n' +
       '  componentDidUpdate(){\n    this.syncSelects();'],

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
      //
      // The 08-03 (evening) export appended a ` + loaded` page-load stamp to all
      // three branches of syncedLabel, which moved this anchor and stopped the
      // build -- the assertion working as intended. The suffix is carried through
      // rather than dropped: it is the design's own stamp and the other two
      // branches keep it, so removing it here would make the failure state the
      // one label that cannot tell you how old the tab is.
      ['do not call an empty tracker "Sample data"',
       "return 'Sample data · ' + when + loaded;",
       "return 'No data loaded · ' + when + loaded;"],

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

      // REMOVED in the 08-03 (evening) release: 'give the header a path back to
      // the homepage'. See the note where HOME_LINK used to be defined -- the
      // design now ships the link on all nine inner pages, so this patch was
      // adding a second one.

      /* Found 2026-08-05, auditing the page. can(p) returned true whenever
       * window.OLHAuth was not yet loaded, so every cell rendered and
       * behaved as editable before sign-in was confirmed -- and forever, if
       * OLHAuth failed to load at all. The API enforces tracker.edit
       * server-side regardless (see netlify/functions/update-job.js), so
       * this was never a way to actually save an unauthorized change -- it
       * just let the grid look editable when it silently wasn't, and every
       * attempted edit would revert with a "not saved" toast. Mirrors the
       * authReady/authFailed fix already applied to index.html. */
      ['state adds authReady/authFailed',
       'edit: null, save: {}, toasts: [], live: false, loading: false,\n' +
       '    user: null, history: null, hEntries: null, hLoading: false, conflict: null\n' +
       '  };',
       'edit: null, save: {}, toasts: [], live: false, loading: false,\n' +
       '    user: null, history: null, hEntries: null, hLoading: false, conflict: null,\n' +
       '    authReady: false, authFailed: false\n' +
       '  };'],

      ['_wireAuth sets authReady/authFailed, fails closed on timeout',
       '  _wireAuth(tries) {\n' +
       '    if (!window.OLHAuth) {\n' +
       '      if (tries < 120) this._authT = setTimeout(() => this._wireAuth(tries + 1), 50);\n' +
       '      return;\n' +
       '    }\n' +
       '    window.OLHAuth.configure(this.apiBase());\n' +
       '    this._offAuth = window.OLHAuth.onChange(u => this.setState({ user: u }));\n' +
       '    window.OLHAuth.restore().then(u => this.setState({ user: u }));\n' +
       '  }',
       '  _wireAuth(tries) {\n' +
       '    if (!window.OLHAuth) {\n' +
       '      if (tries < 120) { this._authT = setTimeout(() => this._wireAuth(tries + 1), 50); return; }\n' +
       '      this.setState({ authReady: true, authFailed: true });\n' +
       '      return;\n' +
       '    }\n' +
       '    window.OLHAuth.configure(this.apiBase());\n' +
       '    this._offAuth = window.OLHAuth.onChange(u => this.setState({ user: u }));\n' +
       '    window.OLHAuth.restore()\n' +
       '      .then(u => this.setState({ user: u, authReady: true }))\n' +
       '      .catch(() => this.setState({ authFailed: true, authReady: true }));\n' +
       '  }'],

      ['can() fails closed instead of defaulting to true',
       "  can(p){ return !window.OLHAuth || window.OLHAuth.can(p); }",
       "  can(p){ return this.state.authReady && !!window.OLHAuth && window.OLHAuth.can(p); }"],

      ['readOnly/readOnlyNote surface a real authFailed message',
       "      readOnly: !!s.user && !canEdit,\n" +
       "      readOnlyNote: s.user && !canEdit\n" +
       "        ? 'Signed in as ' + window.OLHAuth.roleLabel(s.user.role) + ' \\u2014 view only. ' + window.OLHAuth.denyReason('tracker.edit')\n" +
       "        : '',",
       "      readOnly: s.authFailed || (!!s.user && !canEdit),\n" +
       "      readOnlyNote: s.authFailed\n" +
       "        ? 'Couldn\\u2019t verify your sign-in, so this view is read-only for now. Refresh the page \\u2014 if this keeps happening, ask an admin to check your account.'\n" +
       "        : (s.user && !canEdit\n" +
       "          ? 'Signed in as ' + window.OLHAuth.roleLabel(s.user.role) + ' \\u2014 view only. ' + window.OLHAuth.denyReason('tracker.edit')\n" +
       "          : ''),"],

      /* Found 2026-08-05, auditing the page. The "Homes in Progress" tile
       * carried its own `act` boolean, ANDed against Record Status ===
       * 'Active' in view(), completely independent of the Status dropdown's
       * `rs` filter -- which defaults to 'Active' on every page load. Two
       * consequences: with the default filters, clicking the tile was a
       * silent no-op (rs already restricts to Active, so `act` added
       * nothing); with the dropdown set to anything else (e.g. 'Closed'),
       * clicking the tile ANDed 'Active' with the dropdown's value and
       * produced a contradiction that matches zero rows -- the table went
       * silently blank with no explanation. Folding the tile into `rs`
       * directly removes the second, uncoordinated source of truth so the
       * two controls can never disagree. */
      ['remove the redundant act filter clause from view()',
       "      if(s.act && x['Record Status'] !== 'Active') return false;\n" +
       "      if(s.bkl && String(x['Lot Status']||'').trim().toUpperCase() !== 'B') return false;",
       "      if(s.bkl && String(x['Lot Status']||'').trim().toUpperCase() !== 'B') return false;"],

      ['bind the Homes in Progress tile to rs instead of a separate act flag',
       "      tileProgress: this.tile(s.act), onTileProgress: () => this.set({act:!s.act}),",
       "      tileProgress: this.tile(s.rs === 'Active'), onTileProgress: () => this.set({rs: s.rs === 'Active' ? '' : 'Active'}),"],

      ['onTileClear drops the now-removed act flag',
       "        this.set({act:false, bkl:false, nq:false, lt:false, rk:false,\n" +
       "          qa:false, cr:false, lr:false, rs:'', cm:'', ac:'', lot:'', q:''});",
       "        this.set({bkl:false, nq:false, lt:false, rk:false,\n" +
       "          qa:false, cr:false, lr:false, rs:'', cm:'', ac:'', lot:'', q:''});"],

      ['anyFilter drops the now-removed act flag',
       "    const anyFilter = !!(s.act || s.bkl || s.nq || s.lt || s.rk || s.qa || s.cr || s.lr\n" +
       "      || s.rs || s.cm || s.ac || s.lot || s.q);",
       "    const anyFilter = !!(s.bkl || s.nq || s.lt || s.rk || s.qa || s.cr || s.lr\n" +
       "      || s.rs || s.cm || s.ac || s.lot || s.q);"],

      /* Actual Completion Date is the field the current no-COE sync actually
       * writes (dev/sync_coe_to_airtable.py maps the live Homesite__c
       * Actual_Completion_Date__c pull straight into this field), but the
       * tracker never surfaced it as a column -- there was no way to see
       * completion status without opening the homesite detail page. Added
       * to the Salesforce read-only group right after Projected Completion,
       * so the header group width and the outer grid width both grow by
       * this column's 92px (1058->1150, 4158->4250), and the loading-hint
       * placeholder count moves from 39 to 40 columns. */
      ['add an Actual Completion Date column next to Projected Completion',
       "{k:'Projected Completion Date',h:'Proj Compl',t:'d',g:'sf',ro:1,w:92},\n  {k:'Estimated COE Date'",
       "{k:'Projected Completion Date',h:'Proj Compl',t:'d',g:'sf',ro:1,w:92},\n  {k:'Actual Completion Date',h:'Actual Compl',t:'d',g:'sf',ro:1,w:92},\n  {k:'Estimated COE Date'"],

      ['widen the Salesforce read-only header group for the new column',
       'flex:0 0 1058px', 'flex:0 0 1150px'],

      ['widen the outer grid scroll container for the new column',
       'width:4158px', 'width:4250px'],

      ['bump the column-count loading hint for the new column',
       'hint-placeholder-count="39"', 'hint-placeholder-count="40"'],

      /* CEL Letter Sent is a manual checkbox field (see MANUAL_FIELDS in
       * dev/sync_coe_to_airtable.py -- Salesforce never touches it) that gates
       * whether a homesite's Celebration/Acceptance walks are even schedulable
       * on walk-calendar.html and workload.html. There was previously no page
       * anywhere in the suite that let anyone check the box, other than
       * editing Airtable directly. Added as an ordinary editable checkbox
       * column between CEL Manager and CEL Completed, in the existing 'cel'
       * family, so it inherits the same click-to-toggle/commit/audit-log path
       * every other 'cb' column already has -- no new code, just a new COLS
       * entry. Widens the CEL header band (388->470px) and the outer grid
       * scroll container (4250->4332px, stacking on top of the 4158->4250
       * widening two patches up) to match, and bumps the column-count loading
       * hint again (40->41). */
      ['add a CEL Letter Sent column between CEL Manager and CEL Completed',
       "{k:'CEL Manager',h:'CEL Mgr',t:'link',g:'cel',w:118},\n  {k:'CEL Completed'",
       "{k:'CEL Manager',h:'CEL Mgr',t:'link',g:'cel',w:118},\n  {k:'CEL Letter Sent',h:'CEL Letter',t:'cb',g:'cel',ctr:1,good:1,w:82},\n  {k:'CEL Completed'"],

      ['widen the CEL header band for the new column',
       'flex:0 0 388px;box-sizing:border-box;display:flex;align-items:center;padding:0 8px;background:#EAF1F9;color:#203F7C;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;border-bottom:1px solid #D8CFBE;border-left:1px solid #CFDDEB;white-space:nowrap">CEL',
       'flex:0 0 470px;box-sizing:border-box;display:flex;align-items:center;padding:0 8px;background:#EAF1F9;color:#203F7C;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;border-bottom:1px solid #D8CFBE;border-left:1px solid #CFDDEB;white-space:nowrap">CEL'],

      ['widen the outer grid scroll container for the CEL Letter Sent column',
       'width:4250px', 'width:4332px'],

      ['bump the column-count loading hint for the CEL Letter Sent column',
       'hint-placeholder-count="40"', 'hint-placeholder-count="41"'],

      /* Status/Constr. Mgr/Concierge/Homesite filters converted from single-
       * value native selects to multi-select (<olh-multiselect>, see
       * dev/multiselect.js). Ten small patches, in dependency order: state
       * shape, the filter predicates and anyFilter check that read it, the
       * "Homes in Progress" tile (which shares state with the Status filter
       * and keeps its old single-value-toggle behavior on click), the
       * reset-all paths, where the option lists get stashed now that the
       * element takes them via setOptions() instead of nested <option>
       * markup, syncSelects() pushing those options down through the refs,
       * and finally the four markup swaps themselves. */
      ['filter state: rs/cm/ac/lot from single strings to arrays',
       "q: '', rs: 'Active', cm: '', ac: '', lot: '',",
       "q: '', rs: ['Active'], cm: [], ac: [], lot: [],"],

      ['filter predicates: equality -> array includes',
       "if(s.rs && (x['Record Status']||'') !== s.rs) return false;\n" +
       "      if(s.cm && (x['Construction Manager']||'') !== s.cm) return false;\n" +
       "      if(s.ac && (x['Assigned Concierge']||'') !== s.ac) return false;\n" +
       "      if(s.lot && String(x['Lot Status']||'') !== s.lot) return false;",
       "if(s.rs.length && s.rs.indexOf(x['Record Status']||'') < 0) return false;\n" +
       "      if(s.cm.length && s.cm.indexOf(x['Construction Manager']||'') < 0) return false;\n" +
       "      if(s.ac.length && s.ac.indexOf(x['Assigned Concierge']||'') < 0) return false;\n" +
       "      if(s.lot.length && s.lot.indexOf(String(x['Lot Status']||'')) < 0) return false;"],

      ['anyFilter: truthy string check -> .length check',
       "const anyFilter = !!(s.bkl || s.nq || s.lt || s.rk || s.qa || s.cr || s.lr\n" +
       "      || s.rs || s.cm || s.ac || s.lot || s.q);",
       "const anyFilter = !!(s.bkl || s.nq || s.lt || s.rk || s.qa || s.cr || s.lr\n" +
       "      || s.rs.length || s.cm.length || s.ac.length || s.lot.length || s.q);"],

      /* Per decision: a tile click still just replaces the whole Status
       * selection with that one value (or clears it, if that is already the
       * only thing selected) -- it does not merge into whatever else is
       * checked in the dropdown. */
      ["tileProgress toggle: array-aware, still single-value on click",
       "tileProgress: this.tile(s.rs === 'Active'), onTileProgress: () => this.set({rs: s.rs === 'Active' ? '' : 'Active'}),",
       "tileProgress: this.tile(s.rs.length === 1 && s.rs[0] === 'Active'), onTileProgress: () => this.set({rs: (s.rs.length === 1 && s.rs[0] === 'Active') ? [] : ['Active']}),"],

      ['onTileClear: array defaults',
       "this.set({bkl:false, nq:false, lt:false, rk:false,\n" +
       "          qa:false, cr:false, lr:false, rs:'', cm:'', ac:'', lot:'', q:''});",
       "this.set({bkl:false, nq:false, lt:false, rk:false,\n" +
       "          qa:false, cr:false, lr:false, rs:[], cm:[], ac:[], lot:[], q:''});"],

      ['stash raw option lists for setOptions(), drop the now-unused opt() helper',
       "const all = this.jobs();\n" +
       "    const opt = (label, vals) => [{v:'',l:label}].concat(vals);\n" +
       "    const stageOrder = (a,b) => { const na = parseInt(a,10), nb = parseInt(b,10);\n" +
       "      const ka = Number.isNaN(na) ? (a === 'PR' ? -2 : -1) : na;\n" +
       "      const kb = Number.isNaN(nb) ? (b === 'PR' ? -2 : -1) : nb; return ka - kb; };",
       "const all = this.jobs();\n" +
       "    const stageOrder = (a,b) => { const na = parseInt(a,10), nb = parseInt(b,10);\n" +
       "      const ka = Number.isNaN(na) ? (a === 'PR' ? -2 : -1) : na;\n" +
       "      const kb = Number.isNaN(nb) ? (b === 'PR' ? -2 : -1) : nb; return ka - kb; };\n" +
       "    /* Raw option lists for the multi-select filters, stashed so syncSelects()\n" +
       "       (called after every render, from componentDidMount/componentDidUpdate)\n" +
       "       can push them down to the <olh-multiselect> refs imperatively -- these\n" +
       "       are plain custom elements, not native <select>, so they take their\n" +
       "       options via setOptions() rather than nested <option> markup. */\n" +
       "    this._filterOptions = {\n" +
       "      rs: this.uniq('Record Status').sort().map(v => ({v,l:v})),\n" +
       "      cm: this.uniq('Construction Manager').sort((a,b)=>a.localeCompare(b)).map(v => ({v,l:v.replace(/\\s*\\(OLH\\)\\s*$/i,'')})),\n" +
       "      ac: this.uniq('Assigned Concierge').sort((a,b)=>a.localeCompare(b)).map(v => ({v,l:v})),\n" +
       "      lot: this.uniq('Lot Status').sort().map(v => ({v,l:v}))\n" +
       "    };"],

      ['drop optRS/optCM/optAC/optLOT from the renderVals() return object',
       "optRS: opt('All statuses', this.uniq('Record Status').sort().map(v => ({v,l:v}))),\n" +
       "      optCM: opt('All managers', this.uniq('Construction Manager').sort((a,b)=>a.localeCompare(b)).map(v => ({v,l:v.replace(/\\s*\\(OLH\\)\\s*$/i,'')}))),\n" +
       "      optAC: opt('All concierges', this.uniq('Assigned Concierge').sort((a,b)=>a.localeCompare(b)).map(v => ({v,l:v}))),\n" +
       "      optLOT: opt('All homesite statuses', this.uniq('Lot Status').sort().map(v => ({v,l:v}))),\n" +
       "      fRS: s.rs, fCM: s.cm, fAC: s.ac, fLOT: s.lot,",
       "fRS: s.rs, fCM: s.cm, fAC: s.ac, fLOT: s.lot,"],

      ['syncSelects() also pushes the stashed option lists down through the refs',
       "syncSelects(){\n" +
       "    Object.keys(this.selRefs).forEach(k => {\n" +
       "      const n = this.selRefs[k].current;\n" +
       "      if(n && n.value !== this.state[k]) n.value = this.state[k];\n" +
       "    });\n" +
       "  }",
       "syncSelects(){\n" +
       "    Object.keys(this.selRefs).forEach(k => {\n" +
       "      const n = this.selRefs[k].current;\n" +
       "      if(!n) return;\n" +
       "      if(n.setOptions && this._filterOptions) n.setOptions(this._filterOptions[k] || []);\n" +
       "      if(n.value !== this.state[k]) n.value = this.state[k];\n" +
       "    });\n" +
       "  }"],

      ['markup: Status filter -> <olh-multiselect>',
       '<sc-raw-select sc-camel-default-value="{{ fRS }}" ref="{{ refRS }}" sc-camel-on-change="{{ onRS }}" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer">\n' +
       '        <sc-for list="{{ optRS }}" as="o" hint-placeholder-count="3"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n' +
       '      </sc-raw-select>',
       '<olh-multiselect ref="{{ refRS }}" sc-camel-on-change="{{ onRS }}" placeholder="All statuses" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer"></olh-multiselect>'],

      ['markup: Constr. Mgr filter -> <olh-multiselect>',
       '<sc-raw-select sc-camel-default-value="{{ fCM }}" ref="{{ refCM }}" sc-camel-on-change="{{ onCM }}" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer">\n' +
       '        <sc-for list="{{ optCM }}" as="o" hint-placeholder-count="4"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n' +
       '      </sc-raw-select>',
       '<olh-multiselect ref="{{ refCM }}" sc-camel-on-change="{{ onCM }}" placeholder="All managers" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer"></olh-multiselect>'],

      ['markup: Concierge filter -> <olh-multiselect>',
       '<sc-raw-select sc-camel-default-value="{{ fAC }}" ref="{{ refAC }}" sc-camel-on-change="{{ onAC }}" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer">\n' +
       '        <sc-for list="{{ optAC }}" as="o" hint-placeholder-count="4"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n' +
       '      </sc-raw-select>',
       '<olh-multiselect ref="{{ refAC }}" sc-camel-on-change="{{ onAC }}" placeholder="All concierges" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer"></olh-multiselect>'],

      ['markup: Homesite filter -> <olh-multiselect>',
       '<sc-raw-select sc-camel-default-value="{{ fLOT }}" ref="{{ refLOT }}" sc-camel-on-change="{{ onLOT }}" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer">\n' +
       '        <sc-for list="{{ optLOT }}" as="o" hint-placeholder-count="4"><option value="{{ o.v }}">{{ o.l }}</option></sc-for>\n' +
       '      </sc-raw-select>',
       '<olh-multiselect ref="{{ refLOT }}" sc-camel-on-change="{{ onLOT }}" placeholder="All homesite statuses" style="height:30px;padding:0 22px 0 9px;max-width:190px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:12.5px;color:#303030;cursor:pointer"></olh-multiselect>'],
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
       '            : s.sent[u.id] ? "Invite Created" : "Resend Invite",'],

      /* 2026-08-11: paired with the saveMatrix AUTH_PATCH above. Even once
       * saveMatrix rejects on a failed PUT, admin.html's own onSave had no
       * .catch -- the rejection would have surfaced as nothing more than an
       * unhandled promise rejection in the console, with the grid left
       * showing the unsaved draft and no explanation. This makes a failed
       * save visible in the same note/button that already reports "Unsaved
       * changes" and "Saved". */
      ['track an in-flight and failed permissions save',
       'tab: "users", draft: null, saved: false, sent: {},',
       'tab: "users", draft: null, saved: false, saving: false, saveError: null, sent: {},'],

      ['surface a failed permissions save instead of assuming success',
       'note: dirty ? "Unsaved changes" : this.state.saved ? "Saved \\u2014 in effect across the suite" : "",\n' +
       '      noteColor: dirty ? "#83553C" : "#0D773C",\n' +
       '      saveLabel: dirty ? "Save Permissions" : "Saved",\n' +
       '      saveBg: dirty ? "#005DAA" : "#F1EBE1",\n' +
       '      saveColor: dirty ? "#fff" : "#908A82",\n' +
       '      saveCursor: dirty ? "pointer" : "not-allowed",\n' +
       '      footnote: "Anyone signed in picks up a change the next time their page loads. Page access hides a page and blocks it on load \\u2014 your API should still check the caller\'s role on every request.",\n' +
       '      onSave: () => { if (!this.dirty()) return;\n' +
       '        window.OLHAuth.saveMatrix(this.state.draft).then(() => this.setState({ draft: null, saved: true })); },\n' +
       '      onReset: () => { window.OLHAuth.resetMatrix(); this.setState({ draft: null, saved: true }); }',
       'note: this.state.saveError ? this.state.saveError\n' +
       '        : this.state.saving ? "Saving\\u2026"\n' +
       '        : dirty ? "Unsaved changes" : this.state.saved ? "Saved \\u2014 in effect across the suite" : "",\n' +
       '      noteColor: this.state.saveError ? "#AA1F23" : dirty ? "#83553C" : "#0D773C",\n' +
       '      saveLabel: this.state.saving ? "Saving\\u2026" : dirty ? "Save Permissions" : "Saved",\n' +
       '      saveBg: dirty && !this.state.saving ? "#005DAA" : "#F1EBE1",\n' +
       '      saveColor: dirty && !this.state.saving ? "#fff" : "#908A82",\n' +
       '      saveCursor: dirty && !this.state.saving ? "pointer" : "not-allowed",\n' +
       '      footnote: "Anyone signed in picks up a change the next time their page loads. Page access hides a page and blocks it on load \\u2014 your API should still check the caller\'s role on every request.",\n' +
       '      onSave: () => { if (!this.dirty() || this.state.saving) return;\n' +
       '        const draft = this.state.draft;\n' +
       '        this.setState({ saving: true, saveError: null });\n' +
       '        window.OLHAuth.saveMatrix(draft)\n' +
       '          .then(() => this.setState({ draft: null, saved: true, saving: false }))\n' +
       '          .catch((err) => this.setState({ saving: false,\n' +
       '            saveError: "Not saved \\u2014 " + ((err && err.message) || "the server rejected the change") +\n' +
       '              ". Your edits are still shown below; try Save again." })); },\n' +
       '      onReset: () => { window.OLHAuth.resetMatrix(); this.setState({ draft: null, saved: true, saveError: null }); }']
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

  // 3b. Point design-tool page links at the pages that actually ship. Runs
  //     BEFORE the page patches so a patch can still anchor on a rewritten
  //     link, and covers the auth module asset too -- its PAGES[].href carries
  //     the same source names, and although nothing navigates by it today, a
  //     table of page links where every href is a 404 is a trap for whatever
  //     reads it next.
  {
    const r = rewriteDesignLinks(state.template);
    state.template = r.text;
    let inAuth = 0;
    for (const entry of Object.values(state.manifest)) {
      const txt = assetText(entry);
      if (!txt || !txt.includes('.dc.html')) continue;
      const a = rewriteDesignLinks(txt);
      // PAGES[].href is a bare property, not an href="…" attribute, so rewrite
      // those by value as well. Same map, so the two cannot drift.
      let t = a.text;
      let m = a.n;
      for (const [from, to] of Object.entries(DESIGN_LINKS)) {
        const parts = t.split('href: "' + from + '"');
        m += parts.length - 1;
        t = parts.join('href: "' + to + '"');
      }
      if (m) { writeAssetText(entry, t); inAuth += m; }
    }
    if (r.n || inAuth) {
      console.log('  page links rewritten     ' + r.n + ' in template, ' + inAuth + ' in assets');
    }
  }

  // 4. Page-specific patches.
  for (const [label, find, replace] of (spec.patches || [])) {
    sub(state, name, label, find, replace);
    console.log('  patched                  ' + label);
  }

  // 4b. "Last synced" header stamp -- every page, unconditionally, right
  //     beside <olh-user-chip>. One markup insertion, asserted exact-match
  //     like every other patch above; the sibling script that backs it goes
  //     in with LOADER below (step 5b).
  sub(state, name, 'add <olh-sync-stamp> beside <olh-user-chip>',
    '<olh-user-chip', '<olh-sync-stamp></olh-sync-stamp><olh-user-chip');

  // 5. Inject the loader OUTSIDE state.template -- as a sibling of the
  //    bundler's own bootstrap script in the OUTER file -- rather than inside
  //    the template blob. See the "WHERE THE LOADER IS INJECTED" note at the
  //    top of this file for why: a script inside the template can get stuck
  //    behind a slow or stalled external <script src> in the runtime's
  //    sequential replay loop and never run at all, silently.
  //
  //    state.iManifest points at the __bundler/manifest CONTENT line, so
  //    state.iManifest - 1 is the "<script type=\"__bundler/manifest\">" tag
  //    line -- inserting just before it places the loader as literal markup
  //    that the browser's ordinary parser reaches before any of the bundler's
  //    own async work starts. Splicing shifts every later line, so iManifest
  //    and iTemplate (both used by emit() below) move with it.
  {
    // SYNC_STAMP goes in unconditionally -- every page, inject:true or not.
    // It has no fetch of its own (see the const's comment above), so unlike
    // LOADER/OPTIMIZER it carries no stall risk and costs nothing on a page
    // that never sets window.OLH_DATA.
    const blocks = [
      '<script>',
      '/* "Last synced" header stamp — injected by dev/build-live-pages.js,',
      '   OUTSIDE the __bundler/template blob for the same reason as the live',
      '   data loader below. See dev/sync-stamp.js. */',
      SYNC_STAMP,
      '</script>'
    ];
    if (spec.inject) {
      blocks.push(
        '<script>',
        'window.__OLH_LIVE = { walkRef: ' + (spec.walkRef ? 'true' : 'false') + ' };',
        '/* live data loader — injected by dev/build-live-pages.js, OUTSIDE the',
        '   __bundler/template blob so the runtime\'s script-replay loop cannot',
        '   starve it. See the note in dev/build-live-pages.js. */',
        LOADER,
        '</script>'
      );
    }
    // Same outer-injection reasoning as LOADER above, added as a second
    // sibling script rather than folded into the same tag: OPTIMIZER has no
    // async work of its own (pure functions, no fetch), so it has none of
    // LOADER's stall risk, but keeping it separate means a change to one
    // script's content never has to touch the other's.
    if (spec.optimizer) {
      blocks.push(
        '<script>',
        '/* three-pass walk scheduler — injected by dev/build-live-pages.js,',
        '   generated from dev/three_pass_scheduler_logic.js. See',
        '   dev/build-three-pass-client.js. */',
        OPTIMIZER,
        '</script>'
      );
    }
    // Multi-select filter dropdowns -- only pages that actually have one to
    // convert opt in via `multiselect: true`, same reasoning as `optimizer`.
    if (spec.multiselect) {
      blocks.push(
        '<script>',
        '/* multi-select filter dropdown — injected by dev/build-live-pages.js.',
        '   See dev/multiselect.js. */',
        MULTISELECT,
        '</script>'
      );
    }
    const outerBlock = blocks.join('\n');
    const insertAt = state.iManifest - 1;
    if (!/^\s*<script type="__bundler\/manifest">\s*$/.test(state.lines[insertAt])) {
      die(name + ': expected the __bundler/manifest opening tag immediately before its content line');
    }
    const added = outerBlock.split('\n');
    state.lines.splice(insertAt, 0, ...added);
    state.iManifest += added.length;
    state.iTemplate += added.length;
    console.log('  sync stamp injected (outer)' + (spec.inject ? '  loader walkRef=' + (spec.walkRef ? 'true' : 'false') : '') +
      (spec.optimizer ? ' optimizer=true' : ''));
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
    // The loader now lives outside state.template (see step 5), so check the
    // whole emitted file rather than `round`, which is only the template.
    const emitted = fs.readFileSync(out, 'utf8');
    if (!/\/walk-config/.test(emitted)) die(name + ': loader missing from emitted page');
    if (!/dispatchEvent\(new Event\('olh-data'\)\)/.test(emitted)) die(name + ': loader lost the olh-data dispatch');
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

/* Every internal <a href> in a built page must lead somewhere.
 *
 * This exists because thirteen of them did not, and everything else said the
 * build was fine. The 08/03 export renamed inter-page links to design-tool
 * source names, so all seven landing-page tiles and the "All Views" back-link
 * on six pages 404'd. The pages built clean, every assertion passed, and
 * headless Chrome loaded all ten without an uncaught error -- because a dead
 * link throws nothing until somebody clicks it. The first report was a person
 * saying the admin console "is not working".
 *
 * checkStaticRefs() above is the same idea for assets/ and fonts/. The gap was
 * that nothing did it for pages, on the tacit assumption that the design tool
 * emits deployed names. It does not; through 08/01 it coincided.
 *
 * Three things are deliberately NOT failures:
 *   - "{{ expr }}"     a template expression, resolved per row at runtime
 *                      (r.jobHref and friends open Salesforce).
 *   - a bare UUID      a bundler asset handle, resolved by the runtime from the
 *                      manifest, not by the server.
 *   - external schemes  http(s), mailto, tel, data, and in-page #anchors.
 */
function checkPageLinks(pub) {
  const present = new Set(fs.readdirSync(pub));
  // The extensionless routes both hosts rewrite. Kept in sync by hand with
  // netlify.toml and public/staticwebapp.config.json -- a link to a route that
  // neither host declares is as dead as a link to a missing file.
  const routes = new Set(['/', '/tracker', '/completion', '/qa-management', '/scheduler',
    '/walk-calendar', '/workload', '/workload-visualizer', '/admin', '/homesite']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const bad = new Map();
  let checked = 0;
  for (const name of fs.readdirSync(pub).filter((f) => f.endsWith('.html'))) {
    const file = path.join(pub, name);
    const texts = [];
    if (isBundle(file)) {
      const state = loadBundle(file);
      texts.push(state.template);
      for (const entry of Object.values(state.manifest)) {
        const txt = assetText(entry);
        if (txt !== null) texts.push(txt);
      }
    } else {
      texts.push(fs.readFileSync(file, 'utf8'));
    }
    for (const txt of texts) {
      for (const m of txt.matchAll(/href="([^"]*)"/g)) {
        const href = m[1].trim();
        if (!href) continue;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;  // external or anchor
        if (href.includes('{{')) continue;                            // template expression
        if (UUID.test(href)) continue;                                // bundler asset handle
        const target = href.split(/[?#]/)[0];
        checked++;
        const ok = routes.has(target) || present.has(target.replace(/^\.?\//, ''));
        if (!ok) {
          if (!bad.has(href)) bad.set(href, new Set());
          bad.get(href).add(name);
        }
      }
    }
  }
  if (bad.size) {
    die('the built pages link to ' + bad.size + ' target(s) that do not exist in ' + pub + ':\n' +
        [...bad].sort().map(([href, pages]) =>
          '         ' + href + '  <- ' + [...pages].sort().join(', ')).join('\n') +
        '\n       These are 404s on the live site and nothing else in this build ' +
        'would notice.\n       If the design tool renamed its links again, add the ' +
        'new name to DESIGN_LINKS.');
  }
  console.log('  ok       ' + checked + ' internal link(s), all resolve');
}

console.log('\nstatic references');
checkStaticRefs(PUB);

console.log('\npage links');
checkPageLinks(PUB);

const saved = results.reduce((a, r) => a + (r.before - r.after), 0);
console.log('\nbuilt ' + results.length + ' pages, removed ' + kb(saved) + ' of bundled snapshot data');
