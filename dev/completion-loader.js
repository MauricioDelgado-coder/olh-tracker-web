/* Completion Report live loader, inlined into completion.html by
 * dev/build-live-pages.js.
 *
 * The Completion Report was the last page in the suite still rendering from a
 * frozen snapshot: the 07/31 export bakes 900 records from the retired Dynamics
 * Export straight into the template as window.COMPLETION_DATA. The build now
 * deletes that block, so this loader is the page's only source of data.
 *
 * The page reads window.COMPLETION_DATA fresh on every render --
 *   data() { return (typeof window !== "undefined" && window.COMPLETION_DATA) || []; }
 * -- so setting the global and firing 'olh-data' is enough; there is no
 * mount-time freeze to work around.
 *
 * Contract:  GET /api/jobs -> { jobs: [{ id, fields }], managers: [...] }
 *
 * NOTE: no var/let/const here may be lowerCamelCase. The bundler rewrites that
 * exact form to sc-camel-kebab-case and the result is a syntax error that kills
 * the whole script. All-lowercase and ALL_CAPS are safe. See MANGLED_DECL.
 */
(function () {
  'use strict';

  var BAR = 'olh-completion-bar';

  /* Airtable field -> the key the page's records use. Every one of these was
   * checked against the Jobs table schema before wiring this up.
   *
   * 'CCC Date' is mapped but is empty on all 1400 rows: the Salesforce no-COE
   * report carries the column and returns nothing in it, so the column renders
   * blank by design rather than by omission. It is kept mapped so it starts
   * working the day the upstream field is populated. */
  var FIELDMAP = [
    ['Job #', 'job'],
    ['Projected Completion Date', 'edd'],
    ['Estimated COE Date', 'ecoe'],
    ['Scheduled Closing Date', 'close'],
    ['CCC Date', 'ccc'],
    ['Construction Stage (JDE)', 'stage'],
    ['Actual Start Date', 'start'],
    ['Certificate of Occupancy Date', 'co'],
    ['Construction Manager', 'cm'],
    ['Assigned Concierge', 'concierge'],
    ['Sale Date', 'sale'],
    ['Lot Status', 'lot'],
    ['Community', 'community'],
    ['Street Address', 'street']
  ];

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
    el.style.cssText += ';' + (kind === 'error'
      ? 'background:#fdecea;color:#7f1d1d'
      : 'background:#fff8e1;color:#7c4a03');
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

  /* The page formats dates by splitting on "-", so anything carrying a time
   * component has to be trimmed to YYYY-MM-DD or it renders as garbage. Blank
   * becomes "" and never undefined: filtered() calls r.edd.slice(0, 7) when a
   * month filter is active, which throws on undefined. */
  function day(v) {
    if (v == null || v === '') return '';
    return String(v).slice(0, 10);
  }

  function text(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }

  var DATEKEYS = { edd: 1, ecoe: 1, close: 1, ccc: 1, start: 1, co: 1, sale: 1 };

  function maprecord(rec) {
    var f = (rec && rec.fields) || {};
    var out = {};
    for (var i = 0; i < FIELDMAP.length; i++) {
      var from = FIELDMAP[i][0];
      var to = FIELDMAP[i][1];
      out[to] = DATEKEYS[to] ? day(f[from]) : text(f[from]);
    }
    return out;
  }

  function stamp(source, count, detail) {
    window.COMPLETION_SOURCE = { source: source, count: count, detail: detail || '', at: new Date() };
  }

  function announce() {
    window.dispatchEvent(new Event('olh-data'));
  }

  function boot() {
    fetch('/api/jobs', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('/api/jobs returned ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then(function (data) {
        var all = (data && data.jobs) || [];
        /* Archived rows dropped out of the Salesforce export and are not open
         * work; the tracker hides them the same way. */
        var rows = all.filter(function (r) {
          var st = r && r.fields && r.fields['Record Status'];
          return st !== 'Closed';
        }).map(maprecord).filter(function (r) { return r.job; });

        window.COMPLETION_DATA = rows;
        stamp('airtable', rows.length);
        announce();
        if (!rows.length) {
          show('warn', '<strong>No homesites returned.</strong> The report is empty rather than stale.');
        } else {
          hide();
        }
      })
      .catch(function (err) {
        /* No fallback. This page used to ship 900 frozen records and showing
         * them here would be indistinguishable from working. */
        window.COMPLETION_DATA = [];
        stamp('error', 0, (err && err.message) || String(err));
        announce();
        var why = (err && err.status === 401)
          ? 'You are not signed in. <a href="index.html" style="color:inherit;text-decoration:underline">Sign in</a> and come back.'
          : esc((err && err.message) || String(err)) +
            ' &nbsp;·&nbsp; <a href="" onclick="location.reload();return false" style="color:inherit;text-decoration:underline">Retry</a>';
        show('error', '<strong>Live data unavailable.</strong> ' + why +
          ' &nbsp;·&nbsp; This page shows no data rather than a stale snapshot.');
        if (window.console && console.warn) console.warn('[olh] completion load failed:', err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
