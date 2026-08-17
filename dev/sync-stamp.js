/* Shared "Last synced" header stamp.
 *
 * Injected as a sibling of the bundler's own bootstrap script (same outer-
 * injection reasoning as live-loader.js -- see the "WHERE THE LOADER IS
 * INJECTED" note in dev/build-live-pages.js), so it is defined before any
 * bundler replay work starts and cannot get stuck behind a slow CDN script.
 *
 * Reads the same window.OLH_DATA.jobs global that live-loader.js (or a
 * page's own inline loader) sets, takes the newest "Last Synced" field
 * across all rows, and renders it as a small chip next to <olh-user-chip>.
 * Blank until data exists; blank forever if it never does, rather than
 * showing a stale or invented time.
 */
(function () {
  'use strict';

  function fmtStamp(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return 'Last synced ' + (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2) +
      ' \u00b7 ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function newestSync() {
    var jobs = (window.OLH_DATA && window.OLH_DATA.jobs) || [];
    var best = 0;
    for (var i = 0; i < jobs.length; i++) {
      var f = jobs[i] && jobs[i].fields;
      var t = f && Date.parse(f['Last Synced']);
      if (!isNaN(t) && t > best) best = t;
    }
    return best;
  }

  class OlhSyncStampEl extends HTMLElement {
    connectedCallback() {
      this.style.fontSize = '11px';
      this.style.color = 'rgba(255,255,255,.55)';
      this.style.whiteSpace = 'nowrap';
      this._render();
      this._onData = this._render.bind(this);
      window.addEventListener('olh-data', this._onData);
      this._poll = setInterval(this._render.bind(this), 2000);
    }
    disconnectedCallback() {
      window.removeEventListener('olh-data', this._onData);
      if (this._poll) { clearInterval(this._poll); this._poll = null; }
    }
    _render() {
      var text = fmtStamp(newestSync());
      if (text === this._last) return;
      this._last = text;
      this.textContent = text;
    }
  }
  if (!customElements.get('olh-sync-stamp')) customElements.define('olh-sync-stamp', OlhSyncStampEl);
})();
