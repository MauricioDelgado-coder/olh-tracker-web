/* Headless verification for tracker-new.html. Injected by local_preview.js at
   /probe/<file>.html and captured with `chrome --headless --dump-dom`.

   This has to hang off window, not the DOM: the bundler replaces
   document.documentElement during unpack and re-creates every script in the
   document, so anything parked in the original body is discarded. window
   survives, which is the same reason the bundler's own error sink lives there.

   Never deployed. */
(function () {
  var t0 = Date.now();
  var out = { checks: {}, errors: [] };

  window.addEventListener('error', function (e) {
    if (e.message) out.errors.push('error: ' + e.message);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    out.errors.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason));
  });
  var realError = console.error;
  console.error = function () {
    out.errors.push('console.error: ' + Array.prototype.slice.call(arguments).join(' '));
    return realError.apply(console, arguments);
  };
  var realWarn = console.warn;
  out.warnings = [];
  console.warn = function () {
    out.warnings.push(Array.prototype.slice.call(arguments).join(' '));
    return realWarn.apply(console, arguments);
  };

  function finish() {
    var pre = document.createElement('pre');
    pre.id = 'probe';
    pre.textContent = JSON.stringify(out, null, 1);
    (document.body || document.documentElement).appendChild(pre);
    document.title = 'PROBE ' + (out.ok ? 'OK' : 'FAIL');
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Walk the top nav so every view in the design gets rendered at least once.
  // setState is asynchronous, so measuring straight after .click() reads the
  // *previous* view — every entry then reports an identical length and the
  // check silently proves nothing. Yield to React before sampling.
  async function exerciseViews() {
    var labels = ['My Queue', 'Pipeline Board', 'Homesite Detail',
                  'Division Dashboard', 'Keys Board'];
    var seen = [];
    for (var i = 0; i < labels.length; i++) {
      var want = labels[i];
      var all = Array.prototype.slice.call(
        document.querySelectorAll('button,[role="tab"],a'));
      var btn = all.filter(function (b) {
        return (b.innerText || '').replace(/\s+/g, ' ').toLowerCase()
          .indexOf(want.toLowerCase()) !== -1;
      })[0];
      if (!btn) { seen.push({ nav: want, found: false }); continue; }

      var before = out.errors.length;
      try { btn.click(); } catch (e) { out.errors.push('click "' + want + '": ' + e.message); }
      await sleep(400);

      var text = (document.body.innerText || '');
      seen.push({
        nav: want,
        found: true,
        textLen: text.length,
        domNodes: document.querySelectorAll('*').length,
        // A fingerprint of all on-screen copy, so two views rendering the same
        // thing show up as such instead of hiding behind equal lengths. Must
        // hash the whole string, not a prefix: every view opens with the same
        // page header, so a prefix makes distinct views look identical.
        digest: (function (t) {
          var h = 5381;
          for (var k = 0; k < t.length; k++) h = ((h * 33) ^ t.charCodeAt(k)) >>> 0;
          return h.toString(16);
        })(text.replace(/\s+/g, ' ')),
        newErrors: out.errors.length - before
      });
    }
    return seen;
  }

  var iv = setInterval(async function () {
    var D = window.OLH_DATA;
    var painted = document.querySelectorAll('*').length;
    var liveLoaded = !!(D && D.source === 'airtable');
    var timedOut = Date.now() - t0 > 45000;

    if (!(liveLoaded && painted > 200) && !timedOut) return;
    clearInterval(iv);

    out.elapsedMs = Date.now() - t0;
    out.haveOLHData = !!D;
    out.source = D ? D.source : null;
    out.sourceLabel = D ? D.sourceLabel : null;
    out.jobCount = D && D.jobs ? D.jobs.length : 0;
    out.managerCount = D && D.managers ? D.managers.length : 0;
    out.domNodes = painted;
    out.sampleJobId = D && D.jobs && D.jobs[0] ? D.jobs[0].id : null;

    out.checks.liveDataLoaded = liveLoaded;
    out.checks.notSnapshot = !!(D && D.source !== 'export');
    // Real Airtable ids are random; the snapshot's are recJOB0000000nnnn.
    out.checks.realAirtableIds = !!(out.sampleJobId && !/^recJOB0{5}/.test(out.sampleJobId));
    out.checks.rendered = painted > 200;
    out.checks.hasFonts = /TT Commons/.test(
      (document.head && document.head.textContent) || '');

    out.views = await exerciseViews();
    out.checks.allNavFound = out.views.every(function (v) { return v.found; });
    out.checks.viewsExercised = out.views.length >= 5;
    out.checks.allViewsClean = out.views.every(function (v) { return v.newErrors === 0; });
    // Each view must actually paint something different, otherwise the nav
    // clicks are landing but the router is not switching.
    var digests = out.views.filter(function (v) { return v.found; })
      .map(function (v) { return v.digest; });
    out.checks.viewsDistinct = new Set(digests).size >= 4;
    out.checks.noErrors = out.errors.length === 0;

    out.ok = Object.keys(out.checks).every(function (k) { return out.checks[k]; });
    finish();
  }, 250);
})();
