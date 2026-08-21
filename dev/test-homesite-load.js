/* Prove the homesite mount order actually sets state.live now.
 *
 * Lifts componentDidMount / _wireAuth / loadLive out of the built page and runs
 * them against a fake OLHAuth whose restore() resolves asynchronously -- the
 * exact timing that made the old code fire loadLive unauthenticated. Asserts
 * the fetch carries an Authorization header and that live ends up true.
 */
const fs = require('fs');
const PAGE = '/Users/mauricio.delgado/olh-tracker-web/public/homesite.html';
const raw = fs.readFileSync(PAGE, 'utf8');
const OPEN = '<script type="__bundler/template">';
const start = raw.indexOf(OPEN) + OPEN.length;
const tpl = JSON.parse(raw.slice(start, raw.indexOf('</script>', start)));

function lift(sig) {
  const i = tpl.indexOf(sig);
  if (i < 0) throw new Error('not found: ' + sig);
  let j = tpl.indexOf('{', i), d = 0, k = j;
  for (; k < tpl.length; k++) {
    if (tpl[k] === '{') d++;
    else if (tpl[k] === '}') { d--; if (!d) break; }
  }
  return tpl.slice(i, k + 1);
}

const src = [
  lift('  _wireAuth(tries){'),
  lift('  async loadLive(){'),
  lift('  _authHeaders(extra){')
].join('\n');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `  (got ${got}, want ${want})`));
  ok ? pass++ : fail++;
};

async function run({ withAuth, restoreDelay, apiOk }) {
  const calls = [];
  global.window = {};
  if (withAuth) {
    window.OLHAuth = {
      configure() {},
      onChange() { return () => {}; },
      authHeaders: (base) => Object.assign({ Authorization: 'Bearer TOKEN' }, base || {}),
      restore: () => new Promise((r) => setTimeout(() => r({ name: 'Mauricio' }), restoreDelay))
    };
  }
  global.fetch = async (url, opts) => {
    calls.push((opts && opts.headers && opts.headers.Authorization) || 'NO-AUTH');
    return apiOk
      ? { ok: true, json: async () => ({ jobs: [{ id: 'rec1', fields: {} }], managers: [] }) }
      : { ok: false, status: 401, json: async () => ({ error: 'Not signed in.' }) };
  };

  const C = new Function(`
    return class {
      constructor(){ this.state = { live:false, user:null, tick:0 }; this.toasts = []; }
      setState(u){ Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); }
      apiBase(){ return '/api'; }
      toast(kind, title, body){ this.toasts.push(kind + ': ' + title); }
      ${src}
    };
  `)();

  const c = new C();
  c._wireAuth(0);                                     // what componentDidMount now does
  await new Promise((r) => setTimeout(r, restoreDelay + 60));
  return { live: c.state.live, calls, toasts: c.toasts };
}

(async () => {
  console.log('restore() resolves after 40ms — the timing that broke the old code');
  let r = await run({ withAuth: true, restoreDelay: 40, apiOk: true });
  check('fetch happened exactly once', r.calls.length, 1);
  check('fetch carried the session header', r.calls[0], 'Bearer TOKEN');
  check('state.live is true -> edits enabled', r.live, true);
  check('no error toast', r.toasts.length, 0);

  console.log('\nAPI rejects the session');
  r = await run({ withAuth: true, restoreDelay: 10, apiOk: false });
  check('state.live stays false', r.live, false);
  check('failure is reported, not swallowed', r.toasts.length, 1);
  check('toast names the load, not the save', r.toasts[0], 'err: Homesite Data Not Loaded');

  console.log('\ndesign preview — no OLHAuth at all');
  r = await run({ withAuth: false, restoreDelay: 0, apiOk: false });
  check('preview stays silent', r.toasts.length, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
