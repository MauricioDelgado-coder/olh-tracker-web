/* Local preview server — mimics Netlify's routing so the page can be viewed
   before deploying. Serves index.html and maps /api/* to the function handlers.
   Run: node local_preview.js   then open http://localhost:8888
   Not deployed; local development only. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.AIRTABLE_PAT = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/olh-qa-tracker/config.json'), 'utf8')
).airtable_pat;

const jobsFn = require('../netlify/functions/jobs.js');
const updateFn = require('../netlify/functions/update-job.js');

const send = (res, status, headers, body) => {
  res.writeHead(status, headers || {});
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
        fs.readFileSync(path.join(__dirname, "..", 'index.html')));
    }
    if (url.pathname === '/selftest.html') {
      // index.html plus an injected click-to-save test; local verification only
      const html = fs.readFileSync(path.join(__dirname, "..", 'index.html'), 'utf8');
      const probe = fs.readFileSync(path.join(__dirname, "..", 'selftest_probe.js'), 'utf8');
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
        html.replace('</body>', `<script>${probe}</script></body>`));
    }
    if (url.pathname === '/robots.txt') {
      return send(res, 200, { 'Content-Type': 'text/plain' },
        fs.readFileSync(path.join(__dirname, "..", 'robots.txt')));
    }
    if (url.pathname === '/api/jobs' || url.pathname === '/api/update-job') {
      const fn = url.pathname === '/api/jobs' ? jobsFn : updateFn;
      let body = '';
      for await (const chunk of req) body += chunk;
      const out = await fn.handler({
        httpMethod: req.method,
        body: body || null,
        headers: req.headers,
        queryStringParameters: Object.fromEntries(url.searchParams)
      });
      return send(res, out.statusCode,
        Object.assign({ 'Content-Type': 'application/json' }, out.headers || {}),
        out.body);
    }
    // /probe/<file>.html — the same file with newviews_probe.js injected ahead
    // of the bundler script, for headless verification.
    const probed = /^\/probe\/([A-Za-z0-9._-]+\.html)$/.exec(url.pathname);
    if (probed) {
      const f = path.join(__dirname, '..', probed[1]);
      if (!fs.existsSync(f)) return send(res, 404, { 'Content-Type': 'text/plain' }, 'no such build');
      const html = fs.readFileSync(f, 'utf8');
      const probe = fs.readFileSync(path.join(__dirname, 'newviews_probe.js'), 'utf8');
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
        html.replace('<body>', '<body>\n<script>' + probe + '</script>'));
    }
    // Any other root-level .html — lets alternate builds (tracker-new.html)
    // be previewed against the real /api/* handlers above.
    if (/^\/[A-Za-z0-9._-]+\.html$/.test(url.pathname)) {
      const f = path.join(__dirname, '..', url.pathname.slice(1));
      if (fs.existsSync(f)) {
        return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, fs.readFileSync(f));
      }
    }
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
  } catch (err) {
    console.error(err);
    send(res, 500, { 'Content-Type': 'text/plain' }, 'Preview server error: ' + err.message);
  }
}).listen(8888, () => console.log('preview on http://localhost:8888'));
