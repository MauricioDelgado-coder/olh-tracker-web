# OLH QA & Closing Tracker — Web Front End

An internal tool for viewing and editing QA / closing milestones on ~930 live
job records held in Airtable. No npm dependencies for the front end, and no
build step on Netlify — the HTML is served straight from the repo root.

```
olh-tracker-web/
├── index.html                     # the tracker — read/write, the tool people use
├── tracker-new.html               # "New Views" dashboards — READ-ONLY, same live data
├── netlify.toml                   # publish dir, function dir, /api/* redirects, headers
├── robots.txt                     # disallow all
├── .gitignore                     # excludes local env files + design-export sources
├── fonts/                         # self-hosted brand faces — see fonts/README.md
└── netlify/functions/
    ├── jobs.js                    # GET  /api/jobs        (read all jobs + managers)
    └── update-job.js              # POST /api/update-job   (whitelisted single-record PATCH)
```

Both HTML files are **self-contained bundles** produced by the design tool: a
manifest of gzip+base64 assets (the dc-runtime, React, ReactDOM, five brand
fonts, and a static data snapshot) plus the page template, unpacked into blob
URLs in the browser on load. That is why `fonts/` holds only a README — the
font files are inlined. Neither bundle contains a credential, and neither talks
to Airtable directly; both go through `/api/*` exactly as described below.

## The two pages

| Path | Reads | Writes | What it is |
|---|---|---|---|
| `/` | `GET /api/jobs` | `POST /api/update-job` | The editable tracker: one row per homesite, 26 editable columns. |
| `/tracker-new.html` | `GET /api/jobs` | **none** | My Queue, Pipeline Board, Homesite Detail, Division Dashboard, Keys Board. |

`tracker-new.html` is deliberately **not** a replacement for `/`. It makes no
write call at all, so swapping it in at the root would silently remove editing.

It is generated from the design export rather than hand-edited:

```bash
unzip "OLH Tracker design exploration.zip" -d /tmp/olh-export
node dev/build-new-views.js /tmp/olh-export
```

The design tool exports that page as a prototype rendering from the bundled
`olh-data.js` snapshot, with no API call. The build script grafts on the live
fetch layer — both pages read `window.OLH_DATA`, which holds the same
`{id, fields}` Airtable shape, so nothing had to be rewritten. The snapshot
stays bundled as a fallback: if `/api/jobs` is unreachable the page renders
stale sample records and logs a warning instead of going blank.

The script resolves asset ids by content hash and asserts each source patch
matched exactly once, so a re-export that moves things fails the build loudly
rather than quietly shipping a page still stuck on snapshot data. Re-run it
after any design change and redeploy.

> Note: Airtable has no `Community` or `Street Address` field (0 of 932
> records). The New Views page never references them, but the tracker at `/`
> does, so those two columns read blank there.

## How it is wired

The browser **never** talks to Airtable. It calls two of your own endpoints:

| Browser call | Netlify Function | Airtable call |
|---|---|---|
| `GET /api/jobs` | `jobs.js` | paginated `GET` of Jobs + Managers, cached 30s in memory |
| `POST /api/update-job` | `update-job.js` | `PATCH` one record, whitelisted fields only |

The Airtable Personal Access Token is read only from `process.env.AIRTABLE_PAT`
inside those functions. It is never sent to the browser and appears in no file
in this repo.

---

## ⚠️ The token — read this first

**Never commit the Airtable PAT.** It must be created in Airtable and pasted
directly into the **Netlify UI** as an environment variable. Do not put it in
`netlify.toml`, `index.html`, a `.env` file that gets committed, a comment, or a
commit message. `.gitignore` in this repo already excludes `.env`, `.env.*`,
`*.env`, `secrets.json`, `*.pem`, `*.key`.

If a PAT is ever pasted anywhere it shouldn't be, revoke it at
<https://airtable.com/create/tokens> and issue a new one. Rotating is cheap;
cleaning a token out of git history is not.

### Creating the token

1. Go to <https://airtable.com/create/tokens> → **Create new token**.
2. Name it something like `olh-tracker-web (netlify)`.
3. **Scopes — add exactly these two, nothing more:**
   - `data.records:read`
   - `data.records:write`
   (Do **not** add `schema.bases:write`. The app never touches schema, and
   withholding that scope means a compromised token cannot alter the base
   structure.)
4. **Access** → add only the base `appYX9df4lGO6G2uz` (OLH tracker). Do not
   grant workspace-wide access.
5. Copy the token once — Airtable will not show it again.

---

## Deploy — option A: Netlify CLI (fastest)

```bash
npm install -g netlify-cli          # once
cd "olh-tracker-web"

netlify login
netlify init                        # choose "Create & configure a new site"
                                    # build command: (leave empty)
                                    # publish directory: .
                                    # functions directory: netlify/functions

# Set the token as an environment variable (never in a file):
netlify env:set AIRTABLE_PAT        # CLI will prompt; paste the token, press enter

netlify deploy --prod
```

The CLI prints the live URL, e.g. `https://olh-tracker-abc123.netlify.app`.

> If your shell records history, prefer the interactive prompt above over
> `netlify env:set AIRTABLE_PAT pat123...` on one line.

## Deploy — option B: Git-connected (recommended for a shared tool)

1. Push this folder to a **private** repo (GitHub / GitLab / Bitbucket).
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings:
   - Build command: *(empty)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions` (read from `netlify.toml`)
4. **Site configuration → Environment variables → Add a variable**
   - Key: `AIRTABLE_PAT`
   - Value: the token
   - Scopes: Functions (and Builds); all deploy contexts
5. **Deploy site.** Every push to the main branch redeploys.

> After changing `AIRTABLE_PAT` you must **redeploy** (Deploys → Trigger deploy
> → Clear cache and deploy site). Functions pick up env vars at deploy time.

## Local development

```bash
npm install -g netlify-cli
cd "olh-tracker-web"

# Put the token in a LOCAL-ONLY file. .gitignore already excludes it.
echo 'AIRTABLE_PAT=paste_token_here' > .env

netlify dev        # serves index.html + functions at http://localhost:8888
```

`netlify dev` loads `.env` automatically. Confirm `git status` never lists
`.env` before you commit.

---

## Security posture

The site is deliberately deployed at an **unlisted URL with no login gate**.
That was the user's explicit choice, so the write endpoint is hardened instead:

1. **Field whitelist.** `update-job.js` holds a frozen 26-key `EDITABLE` map.
   Any submitted key that is not an *own* property of that map returns
   **HTTP 400** with `rejectedFields` naming the offenders. Writes to
   `Record Status`, `Estimated COE Date`, `Closed Date`, `Last Synced` or any
   other Salesforce-sourced column are therefore impossible — the daily sync
   owns those columns.
2. **PATCH only, one record per request.** No create, no delete, no batch
   (`records` in the body is rejected outright), no schema endpoints. Airtable's
   `typecast` option is deliberately not used, so Airtable will not silently
   coerce values or auto-create linked records.
3. **Server-side type validation.** Dates must match `YYYY-MM-DD`; date-times
   must parse as ISO 8601; checkboxes must be real booleans; manager links must
   be arrays of ids matching `^rec[A-Za-z0-9]{14}$`; notes must be strings under
   10,000 characters; single-line text is trimmed, rejected over 500 characters
   or if it contains a line break. Single-select values must match one of the
   option names in `SELECT_OPTIONS` **exactly** — no trimming into a match, no
   case-folding. Body size is capped at 64 KB.

   > `SELECT_OPTIONS` is a hand-maintained mirror of the Airtable option list.
   > `typecast` is off, so Airtable will not invent a missing option; without
   > this list an unknown value would surface as a confusing 422. If a `Key
   > Status` option is renamed or added in Airtable, update `SELECT_OPTIONS`
   > *and* the `KEY_STATUS` array in `index.html` in the same commit.
4. **No indexing.** `robots.txt` disallows everything and
   `X-Robots-Tag: noindex, nofollow, noarchive` is set by `netlify.toml` on every
   path and by both functions on every response.
5. **No secrets client-side.** No token, base id secret, or credential is in
   `index.html`. (The base/table ids live only in the functions.) Because
   `publish = "."` ships the whole folder, `netlify.toml` force-404s everything
   that is not meant to be public: `/netlify/*` (function source), `/dev/*`
   (local harnesses), and the documentation — `/README.md`, `/fonts/README.md`,
   `/.gitignore`, `/.DS_Store`. This README names the base id and describes the
   security posture, which is not something to hand out at an unlisted URL.
   `/fonts/*` is deliberately **not** blocked so the woff2 files still serve.

   > Caveat worth knowing: on a **CLI** deploy the redirect is the protection,
   > not exclusion — `.gitignore` is not consulted, so these files are still
   > uploaded, just unreachable. On a Git-connected deploy `dev/` never ships at
   > all because `.gitignore` excludes it. If you ever want them genuinely
   > absent from the bundle, move `index.html` + `fonts/` into a `public/`
   > subdirectory and set `publish = "public"`.
6. **No browser storage.** The app uses no `localStorage` or `sessionStorage`.
   Filter state lives in memory and in the URL query string, which is what makes
   a filtered view shareable by link.

### Adding password protection later

Pick one, in rough order of effort:

- **Netlify password protection** (Pro plan) — Site configuration → Access &
  security → **Visitor access → Password protection**. One shared password, one
  click, zero code. Simplest match for a small leadership group.
- **Netlify Identity + role gate** — Site configuration → Identity → enable,
  set registration to *Invite only*, invite the leaders. Then add
  `netlify-identity-widget` to `index.html` and require a logged-in user before
  the first `/api/jobs` call. Also add a
  `context.clientContext.user` check at the top of both functions so the API is
  gated, not just the page.
- **Netlify SSO / OIDC with Lennar Azure AD** (Enterprise) — the right long-term
  answer if this becomes an official tool; it removes the shared-password
  problem entirely.
- **Cheap interim measure:** add a shared secret header. Set a second env var
  (e.g. `APP_KEY`), require `?k=<value>` in the URL, and have both functions
  reject requests without it. This is obscurity, not authentication — use it
  only as a stopgap.

---

## Using the app

- **Metric strip** — a full-width row of cards under the top bar: Homes in
  Progress (active homesites), Backlog (homesites at B lot status), Needs QAI,
  Past Close Date, Risk Flagged, In View. The first two count the whole
  dataset; the last four count the rows currently in view. The strip stays a
  single row at every width — below 1100px it scrolls sideways, drops the
  descriptions and drops the *In View* card so the table keeps the screen.
- **Filters** — text search on Job # (debounced), plus Status / Construction
  Manager / Concierge / Stage / Homesite dropdowns. Record Status defaults to
  **Active**. Quick chips: QA Ready, Needs QAI (QA Ready checked but QAI
  Complete unchecked), Construction Risk, Land Risk.
- **Shareable views** — every filter, the sort column, and the page number are
  written to the URL. "Copy View Link" puts the current URL on the clipboard.
- **Editing** — click any cell in a tinted (editable) column. The editable
  columns are the 26 in the server whitelist: QA Ready, the QAI / QAA / CEL /
  ACC date, manager and completion fields, the two Buyer Attended checkboxes,
  NOC Lock Date, the **Power Meter** and **Water Meter** toggles (grouped under
  *Meters Set*), the Construction / Land Risk flags and notes, and the **Keys**
  group at the far right — **Key Status**, **Delivered To**, **Delivery Date**
  and **Notes**. Checkboxes toggle on click; date cells open a native picker;
  manager and Key Status cells are dropdowns; Delivered To is a single-line
  text input; notes cells expand to a textarea (⌘/Ctrl+Enter or click away to
  save, Esc to cancel).
- **Key Status** is a single select offering only the seven values the server
  accepts: Pending, Priority, Received, Delivered to title, Delivered to WHC,
  Other, Issue. It sorts in that workflow order rather than alphabetically, and
  is badged Pending/Other neutral, Priority amber, Received blue, both
  Delivered states green, Issue red.
- **Keyboard** — Tab moves between editable cells, arrow keys move a cell at a
  time, Enter/Space opens the editor or toggles a checkbox, Delete/Backspace
  clears a cell, Esc cancels.
- **Save feedback** — the change appears immediately, the row shows
  *saving… → saved*, and a failure reverts the cell and raises a toast naming the
  job and the field. Writes are coalesced over 300 ms and serialized per record,
  so fast edits to the same job cannot race.
- **Read-only columns** are untinted, carry a small lock in the header, and are
  not focusable or clickable.
- **Visual warnings** — jobs past their scheduled close date get an amber marker
  on the Job # column; risk-flagged jobs get a red one. Empty QAI/QAA/CEL/ACC
  dates read "due soon" (amber, within 21 days of close) or "missing" (red, past
  close).
- **Refresh** bypasses the 30-second server cache.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Server is not configured: AIRTABLE_PAT is unset" | Env var missing, or set but not redeployed. |
| "Airtable rejected the credentials" | Token lacks `data.records:write`, or the base isn't in its access list. |
| "Rejected: field(s) not permitted for editing" | Working as designed — that column is sync-owned. |
| Blank page / 404 on `/api/jobs` | `netlify.toml` redirects didn't deploy; check the functions directory. |
