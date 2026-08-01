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

/* The Completion Report needs a different loader: it reads COMPLETION_DATA in a
   flat per-homesite shape, not the {id,fields} the walk pages consume. */
const COMPLETION_LOADER = fs.readFileSync(path.join(__dirname, 'completion-loader.js'), 'utf8');
if (!/COMPLETION_DATA/.test(COMPLETION_LOADER)) die('completion-loader.js does not set COMPLETION_DATA');

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
   '      if (tok) h.Authorization = "Bearer " + tok;\n' +
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
      // The template wraps the User Administration link in
      // <sc-if value="{{ isAdmin }}">, but renderVals() never returned isAdmin,
      // so it evaluated undefined and the link was invisible to EVERYONE --
      // admins included. Gated on the roster.manage capability rather than the
      // literal role name, which is what users.js and roles.js already enforce
      // server-side, so granting it in the Roles grid surfaces the link too.
      // "Data updated 7/29/26" was hardcoded into the landing page, which has
      // no data of its own and therefore no way to know. It sat beside links to
      // pages that read Airtable live, so it aged into a false claim. Removed
      // rather than faked: the pages it links to each report their own state.
      ['drop the hardcoded data-updated date',
       '<span style="margin-left:auto;font-size:12.5px;color:#908A82">Data updated 7/29/26</span>',
       ''],

      ['supply isAdmin so the User Administration link can render',
       '  renderVals() {\n' +
       '    const n = this.state.narrow;\n' +
       '    return {\n' +
       '      headPad:',
       '  renderVals() {\n' +
       '    const n = this.state.narrow;\n' +
       '    const auth = window.OLHAuth;\n' +
       '    return {\n' +
       '      isAdmin: !!(this.state.user && auth && auth.can("roster.manage")),\n' +
       '      headPad:']
    ]
  },

  // Reads a COMPLETION_DATA asset, which is real and stays. No fixture.
  // Was the last page in the suite on frozen data: the export bakes 900 records
  // from the retired Dynamics Export into the template. completionLive deletes
  // that block and injects completion-loader.js, which reads /api/jobs.
  'completion.html': {
    data: false, inject: false, completionLive: true, caches: [],
    patches: [
      // data() re-reads window.COMPLETION_DATA on every render, so the loader
      // only has to set the global and fire the event -- but something must
      // call setState or React never re-renders. The page's mount handler only
      // watched the viewport.
      ['re-render when live data arrives',
       '  componentDidMount() {\n' +
       '    this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '  }',
       '  componentDidMount() {\n' +
       '    this._offVp = window.OLHViewport.watch(n => this.setState({ narrow: n }));\n' +
       '    this._onData = () => this.setState({ limit: 200 });\n' +
       '    window.addEventListener("olh-data", this._onData);\n' +
       '  }\n\n' +
       '  componentWillUnmount() {\n' +
       '    if (this._offVp) this._offVp();\n' +
       '    if (this._onData) window.removeEventListener("olh-data", this._onData);\n' +
       '  }'],

      // "Data updated 7/29/26" was a hardcoded string. It was wrong the day
      // after it shipped and it sat next to data that is now loaded live.
      ['report the real load state instead of a hardcoded date',
       'Data updated 7/29/26 \u00b7 Orlando Homes division',
       '{{ updatedLabel }}'],

      ['supply updatedLabel',
       '    const nw = s.narrow;\n' +
       '    return {\n' +
       '      narrow: nw,',
       '    const nw = s.narrow;\n' +
       '    const src = (typeof window !== "undefined" && window.COMPLETION_SOURCE) || null;\n' +
       '    return {\n' +
       '      updatedLabel: !src ? "Loading\u2026"\n' +
       '        : src.source === "error" ? "Data unavailable \u00b7 Orlando Homes division"\n' +
       '        : src.count + " homesites \u00b7 loaded " +\n' +
       '          src.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +\n' +
       '          " \u00b7 Orlando Homes division",\n' +
       '      narrow: nw,'],

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
      ['announce initial load failure',
       'this.loadLive(false, false);',
       'this.loadLive(false, true);'],
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
       '        {headers: window.OLHAuth.authHeaders()});'],

      ['authenticate the tracker write',
       "        headers:{'Content-Type':'application/json', Accept:'application/json'},",
       "        headers: window.OLHAuth.authHeaders({'Content-Type':'application/json'}),"],

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

/** Which snapshot globals a manifest asset defines. */
function assetGlobals(entry) {
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) { try { buf = zlib.gunzipSync(buf); } catch (_) { return { globals: [], size: 0 }; } }
  // Binary assets (fonts, png) are not worth evaluating.
  const head = buf.slice(0, 4).toString('latin1');
  if (/^wOF2|^\x00\x01\x00\x00|^\x89PNG|^OTTO|^true/.test(head)) return { globals: [], size: buf.length };
  const txt = buf.toString('utf8');
  const globals = SNAPSHOT_GLOBALS.filter((g) => new RegExp('(window\\.)?' + g + '\\s*=').test(txt));
  return { globals, size: buf.length };
}

/** Assert-exactly-once substitution. */
function sub(state, file, label, find, replace) {
  const n = state.template.split(find).length - 1;
  if (n !== 1) die(file + ': patch "' + label + '" matched ' + n + ' times, expected exactly 1');
  state.template = state.template.replace(find, replace);
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

/**
 * Delete the baked COMPLETION_DATA block from completion.html.
 *
 * This one is separate from dropInlineSnapshots because the data is not a demo
 * fixture -- the 900 records are real homesites from the retired Dynamics
 * Export. They are removed because they are FROZEN (29 July), not because they
 * are fake, and completion-loader.js replaces them with a live /api/jobs read.
 *
 * Asserted to match exactly one block: silently finding none would ship the
 * stale snapshot again with a loader layered uselessly on top of it.
 */
function dropCompletionSnapshot(state, name) {
  const tpl = state.template;
  const CLOSE = '</script>';
  let out = '';
  let i = 0;
  let found = 0;
  let size = 0;

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

    if (plain && /(window\.)?COMPLETION_DATA\s*=\s*\[/.test(body)) {
      found += 1;
      size += body.length;
      out += tpl.slice(i, open);
    } else {
      out += tpl.slice(i, end);
    }
    i = end;
  }

  if (found !== 1) {
    die(name + ': expected exactly 1 baked COMPLETION_DATA block, found ' + found +
        '. The Completion Report reads this global at render time, so a missed ' +
        'block means the page keeps showing the frozen 29 July snapshot while ' +
        'appearing to be wired live.');
  }
  state.template = out;
  console.log('  dropped baked data       ' + 'COMPLETION_DATA'.padEnd(42) + kb(size));
  return size;
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

  // 2. Patch the shared auth module. Every page inlines it.
  if (!state.template.includes('OLH shared authentication')) {
    die(name + ': the shared auth module is missing. Every page in the export ' +
        'carries it; a page without it has no sign-in gate at all.');
  }
  for (const [label, find, replace] of AUTH_PATCHES) {
    sub(state, name, 'auth: ' + label, find, replace);
  }
  console.log('  auth patches             ' + AUTH_PATCHES.length + ' applied');

  // 2b. Rename the identifiers the bundler's camelCase rewrite would corrupt.
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

  // 4b. The Completion Report's own snapshot + loader.
  if (spec.completionLive) {
    dropCompletionSnapshot(state, name);
    if (!state.template.includes('</body>')) die(name + ': no </body> to inject the completion loader before');
    sub(state, name, 'completion loader injection', '</body>',
      '<script>\n/* completion live data loader \u2014 injected by dev/build-live-pages.js */\n' +
      COMPLETION_LOADER + '\n</script>\n</body>');
    console.log('  loader injected          completion -> /api/jobs');
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

const saved = results.reduce((a, r) => a + (r.before - r.after), 0);
console.log('\nbuilt ' + results.length + ' pages, removed ' + kb(saved) + ' of bundled snapshot data');
