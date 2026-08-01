/* Live data loader, inlined into the scheduler / workload / walk-calendar
 * bundles by dev/build-live-pages.js.
 *
 * The build step DELETES the bundled olh-data demo fixture and the WALK_*
 * snapshot from these pages, so there is no local data at all when this runs.
 * That is deliberate: the fixture held 900 synthetic homesites, and a page that
 * silently degrades to invented records is worse than one that says it is
 * broken. If either fetch fails we render an explicit error and leave the
 * globals empty.
 *
 * Contract:
 *   GET /api/jobs        -> { jobs:[{id,fields}], managers:[...] }
 *   GET /api/walk-config -> { roster, drive, productMap, communities, unscheduled }
 */
(function () {
  'use strict';

  var API = '/api';
  var BAR = 'olh-live-bar';

  function bar() {
    var el = document.getElementById(BAR);
    if (el) return el;
    el = document.createElement('div');
    el.id = BAR;
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:sticky;top:0;z-index:99999;font:500 13px/1.45 system-ui,-apple-system,' +
      'Segoe UI,sans-serif;padding:9px 14px;border-bottom:1px solid rgba(0,0,0,.12)';
    if (document.body.firstChild) document.body.insertBefore(el, document.body.firstChild);
    else document.body.appendChild(el);
    return el;
  }

  function show(kind, html) {
    var el = bar();
    var tone = kind === 'error'
      ? 'background:#fdecea;color:#7f1d1d'
      : 'background:#fff8e1;color:#7c4a03';
    el.style.cssText += ';' + tone;
    el.innerHTML = html;
  }

  function hide() {
    var el = document.getElementById(BAR);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function announce() {
    // All four walk pages listen on both events; firing both keeps the loader
    // indifferent to which one a given page happens to bind. Both are dispatched
    // only after Promise.all resolves, so every global is already set by the time
    // any handler runs.
    window.dispatchEvent(new Event('walk-ref'));
    window.dispatchEvent(new Event('olh-data'));
  }

  /* Record the load outcome on <body> so it can be inspected without reading
   * rendered text. Pages like walk-calendar show an empty state until the user
   * generates a schedule, so "did live data arrive?" is not answerable from the
   * DOM text alone -- and a page that fetched nothing looks identical to one
   * that fetched 935 records. Also handy in prod: check the attribute rather
   * than guessing why a page looks thin.
   */
  function mark(source, jobCount, detail) {
    if (!document.body) return;
    document.body.setAttribute('data-olh-source', source);
    document.body.setAttribute('data-olh-jobs', String(jobCount));
    if (detail) document.body.setAttribute('data-olh-detail', detail);
  }

  function blank() {
    window.OLH_DATA = {
      jobs: [], managers: [], today: new Date(),
      source: 'error', sourceLabel: 'data unavailable'
    };
    window.WALK_ROSTER = [];
    window.WALK_DRIVE = {};
    window.WALK_PRODUCT_MAP = {};
    window.WALK_COMMUNITIES = [];
    window.WALK_UNSCHEDULED = [];
  }

  async function getJson(path) {
    var res = await fetch(API + path, { headers: { Accept: 'application/json' } });
    var body = await res.json().catch(function () { return null; });
    if (!res.ok || !body) {
      throw new Error((body && body.error) || (path + ' failed (' + res.status + ')'));
    }
    return body;
  }

  async function boot() {
    // Set per page by build-live-pages.js. Every page that reads any WALK_*
    // global must set this: the build deletes the bundled WALK_* fixture, so a
    // page left with walkRef:false has no roster, no drive matrix and no product
    // map at all. walk-calendar was mis-registered as walkRef:false on the
    // assumption that it reads only OLH_DATA.jobs/.managers, and rendered an
    // empty walk-manager list until that was corrected -- so when in doubt,
    // grep the page for WALK_ rather than trusting a comment.
    var needsRef = !!(window.__OLH_LIVE && window.__OLH_LIVE.walkRef);

    try {
      var pair = await Promise.all(
        needsRef ? [getJson('/jobs'), getJson('/walk-config')] : [getJson('/jobs')]
      );
      var jobs = pair[0];
      var cfg = needsRef ? pair[1] : null;

      if (!Array.isArray(jobs.jobs)) throw new Error('/jobs returned no job array');
      if (needsRef && (!cfg || !cfg.drive || !cfg.roster)) {
        throw new Error('/walk-config returned no reference data');
      }

      window.OLH_DATA = {
        jobs: jobs.jobs,
        managers: jobs.managers || [],
        today: new Date(),
        source: 'airtable',
        sourceLabel: 'Airtable · ' + jobs.jobs.length.toLocaleString() + ' homesites'
      };
      if (cfg) {
        window.WALK_ROSTER = cfg.roster;
        window.WALK_DRIVE = cfg.drive;
        window.WALK_PRODUCT_MAP = cfg.productMap;
        window.WALK_COMMUNITIES = cfg.communities;
        window.WALK_UNSCHEDULED = cfg.unscheduled || [];
      }

      announce();
      mark('airtable', jobs.jobs.length,
        cfg ? 'roster=' + cfg.roster.length + ' pairs=' + (cfg.meta && cfg.meta.pairCount) : 'jobs-only');

      if (!cfg) { hide(); return; }

      // Surface the coverage gap rather than letting homesites vanish quietly.
      var u = window.WALK_UNSCHEDULED;
      var homeUnknown = (cfg.meta && cfg.meta.rosterHomeUnknown) || 0;
      var notes = [];
      if (u.length) {
        var sites = u.reduce(function (a, x) { return a + (x.homesites || 0); }, 0);
        var comms = [];
        u.forEach(function (x) {
          if (x.baseCommunity && comms.indexOf(x.baseCommunity) === -1) comms.push(x.baseCommunity);
        });
        notes.push(
          '<strong>' + sites + ' homesite' + (sites === 1 ? '' : 's') + ' not scheduled</strong> — ' +
          comms.length + ' communit' + (comms.length === 1 ? 'y' : 'ies') +
          ' have no drive times yet: ' + esc(comms.join(', ')) + '.'
        );
      }
      if (homeUnknown) {
        notes.push(
          homeUnknown + ' roster member' + (homeUnknown === 1 ? '' : 's') +
          ' have a home community that is not in the drive matrix, so their day starts unanchored.'
        );
      }
      if (notes.length) show('warn', notes.join(' &nbsp;·&nbsp; '));
      else hide();
    } catch (err) {
      blank();
      announce();
      mark('error', 0, (err && err.message) || String(err));
      show('error',
        '<strong>Live data unavailable.</strong> ' + esc((err && err.message) || String(err)) +
        ' &nbsp;·&nbsp; This page shows no data rather than a stale sample. ' +
        '<a href="" onclick="location.reload();return false" style="color:inherit;text-decoration:underline">Retry</a>');
      if (window.console && console.warn) console.warn('[olh] live load failed:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
