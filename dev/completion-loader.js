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

  /* Scope: homes actually under construction right now.
   *
   * A homesite belongs on this report if work has started and has not finished.
   * That is Actual Start Date populated and Actual Completion Date empty, which
   * lines up 1:1 with Construction State = "Under construction" -- 1038 of the
   * 1400 active rows at the time this was written. The two dates are used
   * rather than the status field because they are what the status is derived
   * from; a stale status cannot put a finished home back on the list.
   *
   * Then three narrowing rules, all requested 2026-08-01:
   *
   * 1. Lot Status must be B, S, W or M. This is the saleable-inventory set.
   *    It removes 4 rows today -- two U, one H, one blank -- which are the
   *    condo/model/placeholder records the no-COE report already flags. Note
   *    this tests Lot Status, NOT the Z/H job-number exclusion in the upstream
   *    Salesforce pull; those are different rules that happen to share letters,
   *    and conflating them has caused confusion before.
   *
   * 2. Projected Completion must be present. A row with no projected date has
   *    nothing to sort or schedule by on a report that is entirely about dates,
   *    and it sorts to the bottom as a row of dashes. 3 rows today.
   *
   *    This reverses the earlier "a missing date is not evidence of staleness"
   *    call. That reasoning still holds -- these are not stale -- but absent is
   *    not the same as not-stale, and this report is the wrong place to chase
   *    them. They remain visible in the tracker and in the no-COE workbook.
   *
   * 3. Projected Completion must not be older than STALEDAYS.
   *
   * On the staleness window: this was twelve months and is now 60 days. Twelve
   * months was chosen so a genuinely late home stayed visible for a year rather
   * than vanishing; 60 days is the narrower reading of "still current work".
   * The two pick out the same rows today -- there is nothing in the data with a
   * projected completion between Jan 2024 and Jun 2026, so both drop exactly
   * the same 18 abandoned records (starts as old as 1999, projected dates
   * 2001-2023). They diverge only as real homes slip past 60 days late, and at
   * that point this rule drops them from the report. That is the intended
   * behaviour, but it is the one thing here that will change what you see
   * without anyone editing the code, so it is worth revisiting if late work
   * starts going missing.
   *
   * Combined: 1038 under construction -> 1013 on the report. */
  var STALEDAYS = 60;

  function stalecutoff() {
    var d = new Date();
    d.setDate(d.getDate() - STALEDAYS);
    return d.toISOString().slice(0, 10);
  }

  var LOTSTATUS = { B: 1, S: 1, W: 1, M: 1 };

  function inscope(rec) {
    var f = (rec && rec.fields) || {};
    var filled = function (k) {
      var v = f[k];
      return v !== undefined && v !== null && String(v).trim() !== '';
    };
    if (f['Record Status'] === 'Closed') return false;
    if (!filled('Actual Start Date')) return false;
    if (filled('Actual Completion Date')) return false;
    if (!LOTSTATUS[String(f['Lot Status'] || '').trim().toUpperCase()]) return false;
    if (!filled('Projected Completion Date')) return false;
    if (day(f['Projected Completion Date']) < stalecutoff()) return false;
    return true;
  }

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

  /* Bearer token or nothing -- see the note in live-loader.js. */
  function authheaders() {
    if (window.OLHAuth && typeof window.OLHAuth.authHeaders === 'function') {
      return window.OLHAuth.authHeaders();
    }
    return { Accept: 'application/json' };
  }

  function boot() {
    fetch('/api/jobs', { credentials: 'same-origin', headers: authheaders() })
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
        var rows = all.filter(inscope).map(maprecord).filter(function (r) { return r.job; });

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
