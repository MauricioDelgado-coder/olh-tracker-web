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

> **Superseded 2026-08.** The site now has real accounts and every data endpoint
> requires a session. See *Accounts and permissions* at the end of this file.
> The layers below still apply on top of that — an authenticated user is not the
> same thing as a trusted one — but the framing in the next paragraph is history.

The site was originally deployed at an **unlisted URL with no login gate**.
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

---

# Walk-planning pages (added 2026-07-30)

`/scheduler`, `/workload` and `/walk-calendar` join `/`, `/tracker` and
`/completion`. All six are bundled single-file documents exported from the design
tool and post-processed by `dev/build-live-pages.js`.

## No page ships a data fixture

The design exports embed `olh-data.demo-fixture.js` — **900 synthetic homesites**
with fabricated ids (`recJOB…`, `recCM…`) labelled `Dynamics Export · 900
homesites`. The build step deletes that asset from the manifest and removes its
script tag, so the fixture is not merely unused, it is absent.

This matters because the previous failure mode was silent. `tracker.html` called
`loadLive(false, false)` on mount — `announce=false` — and its catch block left
`window.OLH_DATA` pointing at the fixture. A failed first load therefore rendered
900 invented homesites with **no message at all**. The build now also patches
that call to `loadLive(false, true)` and rewrites the toast, which used to
promise "Showing sample records instead."

Rule: a page that cannot reach the API shows nothing and says so. Nobody should
schedule a real walk from invented records.

## Where the reference data lives

`GET /api/walk-config` (`netlify/functions/walk-config.js`) serves the roster,
drive matrix and product map from three tables in `appYX9df4lGO6G2uz` — the same
base `/api/jobs` reads, so there is one base and one PAT:

| Table | Id | Records |
|---|---|---|
| Walk Roster | `tblhDm8OD4jSR0tey` | 35 (19 QAM, 16 CCR) |
| Walk Drive Times | `tblVnYFUc4xuovVEC` | 729 — one per ordered community pair |
| Walk Product Map | `tblvkWF5QULxhqFiX` | 74 |

Long-form drive times because Airtable has no matrix field type; the endpoint
pivots them back into `WALK_DRIVE[from][to]`. Cache is 5 minutes, longer than the
30s on `/api/jobs`, because reference data changes far less often.

Editing a drive time or adding a community is now an Airtable edit. It used to
require rebuilding and redeploying three 1 MB documents.

## Known gaps, surfaced on screen

`/api/walk-config` returns an `unscheduled` array, and the pages render it as a
banner naming the affected communities. Two gaps are live today:

- **9 communities, 29 homesites have no drive times** (Championsgate is 14 of
  them). They are in `Walk Product Map` flagged `NEW — needs drive times`.
  Filling the matrix to 36×36 means 284 new symmetric measurements.
- **16 of 35 roster members have a `Home Community` that is not one of the 27**
  in the drive matrix, so their day starts unanchored. Each carries a `Notes`
  explaining why.

Both are deliberately visible rather than silently dropped — 63 of 935 homesites
would otherwise vanish from these pages with no indication (29 unmapped, 19 with
no `Community` value, plus the excluded `The Cove`).

## Rebuilding after a design re-export

    node dev/build-live-pages.js <export-folder> public
    node dev/verify-server.js "$PWD/public" 8902 &
    bash dev/verify-pages.sh http://localhost:8902

Every patch asserts an exact single match and the emitted payload is re-parsed
the way the browser loader does, so a re-export that moves the anchors fails the
build loudly instead of shipping a page stuck on no data. `verify-pages.sh`
drives real headless Chrome and asserts on script-stripped visible text — the
loader's own source contains strings like "Live data unavailable", so grepping
the raw DOM makes those assertions tautological.

The loader stamps `data-olh-source` and `data-olh-jobs` on `<body>`, which is how
pages with an empty initial state (walk-calendar) can be verified at all, and a
quick way to check a live page.

## Still outstanding

`tracker-new.html` was **deleted on 2026-08-01**. It was the superseded "New
Views" prototype, it still carried the 994 KB / 900-record fixture, and it
predated the shared auth module — so once sign-in became real it was a page with
no gate whose own `loadLive()` fell back to the fixture. An anonymous visitor
hitting a 401 would have been shown 900 invented homesites. `/tracker-new` now
301s to `/tracker`.

---

# Accounts and permissions (added 2026-08-01)

The 07/31 design export inlines a 134 KB shared module, "OLH shared
authentication + change tracking", into all eight pages. It puts a sign-in gate
and an audit trail on every screen and expects eleven backend endpoints. None of
them existed. This section is what was built to meet it.

## Why it could not just be deployed

The module degrades to a local DEMO mode when no backend answers: the sign-in
screen accepts any name off the bundled roster, the session lives in
localStorage, and the audit log is browser-local. That is right for a prototype
and wrong for the deployed site, and it left two options that were both broken:

- **Fixture stripped** (what the no-fake-data rule requires) — `demoDirectory()`
  reads `window.WALK_ROSTER`, which the build deletes, so the directory is empty
  and *everyone* is told "that name is not on the OLH roster". The site becomes
  unusable behind a login nobody can pass.
- **Fixture kept** — sign-in matches any roster name and sets `token = null`
  with no password check at all. That ships a login screen that admits anyone,
  over 935 real homesites. A gate that looks real and is not is worse than the
  honest no-gate posture it replaced.

So the backend was not optional, and neither was patching the module.

## The endpoints

| Route | Function | Who |
|---|---|---|
| `POST /api/sign-in` | `auth.js` | anyone |
| `GET /api/session` | `auth.js` | valid token |
| `POST /api/sign-out` | `auth.js` | anyone (revokes by bumping `Session Epoch`) |
| `POST /api/invite` | `password.js` | `roster.manage` |
| `GET /api/invite/:token` | `password.js` | anyone with the link |
| `POST /api/set-password` | `password.js` | anyone with the link |
| `POST /api/forgot-password` | `password.js` | anyone |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | `users.js` | `roster.manage` |
| `GET /api/roles` / `PUT /api/roles` | `roles.js` | session / `roster.manage` |
| `GET/POST /api/audit` | `audit.js` | session |

Shared helpers live in `netlify/lib/olh-auth.js`, outside `netlify/functions/`
so it is never itself deployed as an endpoint.

New Airtable tables in `appYX9df4lGO6G2uz`: **Users** (`tblTesJj3P7BSiErH`),
**Audit Log** (`tblgiEqKXRbBHLg1i`), **Roles** (`tblIhpTZyCupEaASH`).

## The data endpoints are the boundary

`/api/jobs`, `/api/walk-config` and `/api/update-job` now require a session
*before any Airtable read*. This is the point of the change. Guarding only the UI
would have left every homesite readable by anyone who knew the path, which was
the actual pre-existing exposure — the login screen would have been decoration.

`update-job.js` additionally checks per-field capability: reassigning a walk
(`QAI/QAA/CEL/ACC Manager`) needs `walk.schedule`, so a Construction Manager can
correct a date but cannot move someone else's walk.

## Choices worth knowing

- **`crypto.scrypt`, not bcrypt/argon2.** The repo has no `package.json` and the
  functions use only Node builtins; scrypt is memory-hard, built in, and avoids a
  native binary that has to compile on every deploy. Stored as
  `scrypt$<salt>$<key>`, both hex.
- **Sessions are stateless HMACs**, 12h, carrying the user id and a
  `Session Epoch`. Bumping the epoch — on sign-out, suspension, role change or
  password change — invalidates every outstanding token for that person at once,
  with no session table.
- **No email provider.** `POST /api/invite` *returns* a one-time link for an
  admin to send from Outlook. The admin page's Resend button was patched to copy
  it to the clipboard, because the stock button discarded the response.
  Consequence: `forgot-password` cannot deliver anything. It still always answers
  200 (so it is not an account-existence oracle) and files an Audit Log row an
  admin can act on, and it deliberately **skips pending accounts** — otherwise
  any anonymous caller could void someone's outstanding invite by naming their
  address.
- **Sign-in leaks one thing on purpose.** A pending account answers 409
  `mustSetPassword` where an unknown address answers 401, because the frontend
  keys its set-password screen off that and a generic 401 strands every new user.
  Wrong-password and unknown-address are byte-identical, and an unknown address
  still pays the scrypt cost so timing does not separate them. The trade-off is
  written up in `auth.js`.
- **Audit rows are attributed from the session, never the body**, and `Entry Id`
  is an idempotency key so a retry does not append the same change twice.
- **You cannot demote, suspend or delete yourself**, and the last active admin is
  protected. Locking yourself out of the only console that can unlock you is not
  a recoverable mistake.

## Seeding the first admin

```bash
AIRTABLE_PAT=$(netlify env:get AIRTABLE_PAT) \
  node dev/seed-admin.js "Full Name" someone@lennar.com
```

Prints a single 24h set-password link. Deliberately a local script and not an
endpoint: an `ADMIN_EMAIL` bootstrap would be a permanent production code path
that mints a privileged account without one already existing. Re-running it
issues a fresh invite rather than duplicating or resetting anything, so a lost
link is recoverable.

Required Netlify env vars: `AIRTABLE_PAT`, `SESSION_SECRET` (32+ chars,
`openssl rand -hex 32`), `SITE_URL` (optional; falls back to the request host).

## Verifying

```bash
netlify dev --port 8899
bash dev/verify-auth.sh  http://localhost:8899 '<token>' <email>   # API contract
bash dev/verify-pages.sh http://localhost:8899                     # signed-out contract
```

`verify-auth.sh` asserts the boundary: every data endpoint refuses an anonymous
or forged caller, the password policy holds server-side, tokens are single-use,
and audit attribution cannot be forged. Run sections 4–5 against a **disposable**
account — it sets a known password.

`verify-pages.sh` used to load every page anonymously and assert that live data
rendered. That is now the opposite of correct, and the old checks sat failing
while each failure was the auth boundary working — which is how people learn to
ignore red output. It now asserts the signed-out contract instead: no fixture in
any state, a sign-in gate, and an honest "no data" rather than a stale sample.

**Known gap, stated rather than papered over:** signed-in *rendering* is not
automated. Preseeding a session into `localStorage` from the CLI would mean
serving a bootstrap page that mints a session from a URL parameter — an auth
bypass living in `public/` — which is not worth test convenience. The data path
is covered at the API level; rendering with data is a manual pass.

---

# Where the data comes from (changed 2026-08-01)

The Jobs table is now populated from the **no-Actual-COE Salesforce pull**, not the
Dynamics Export. The question the table answers changed from "what came out of the
Dynamics report" to "which homesites in OLH have not closed yet, and where are they
in construction".

    bash dev/run-daily-sync.sh          # the whole thing, and what launchd runs
    python3 dev/sync_coe_to_airtable.py --out "<folder>" --dry-run
    python3 dev/sync_coe_to_airtable.py --out "<folder>" --skip-report

## What changed in the table

| | rows |
|---|---|
| before (Dynamics Export scope) | 1021 |
| after | 1492 total — **1400 Active**, 92 archived |
| added | 471 — 390 unsold/construction started, 63 unsold/complete, 15 sold, 3 data issues |
| archived, not deleted | 92 |

The additions are mostly **unsold** homesites where construction has started or
finished. They are open work even though nobody has bought them, which is the
point of the new scope — but it does mean QA managers now see lots with no buyer
attached.

## The scope lives in the skill, not here

`dev/sync_coe_to_airtable.py` does not contain the SOQL. It runs the
`homesites-no-actual-coe` skill's `run_report.py`, which owns the query, the
exclusions (Z and H job numbers), the bucket and construction-state derivation,
the duplicate reconciliation and the verification pass — then reads the workbook it
produced. Two definitions of "open work" would drift apart, and the subtleties are
real: a Certificate of Occupancy or CCC date does **not** mean complete, only
`Actual_Completion_Date__c` does.

`run_report.py` exits non-zero when its own verification fails, and the sync
refuses to run on an unverified workbook. That chain is deliberate: a day when
Salesforce changes shape should stop at the report, not become 1400 wrong rows.

## Nothing hand-entered is ever touched

585 rows carry QA data that exists nowhere else — walk dates, walk managers, key
handover, risk notes. The sync writes only the fields in `SF_OWNED`,
`assert_disjoint()` fails the run if a field is ever listed as both
Salesforce-owned and manual, and the check runs again on the actual write payloads
rather than just on the map.

A homesite that leaves the pull is set `Record Status = Closed` with a
`Closed Date`. **The row is kept.** 66 of the 92 archived rows hold hand-entered
data; deleting them would be unrecoverable. A row that reappears goes back to
Active. Verified with `dev/verify-qa-preserved.js`: 4966 hand-entered values across
585 rows, zero changed, zero rows lost.

## Field mapping, and the two traps in it

Mapping was decided by measuring agreement against the 929 job numbers already in
Airtable, not by matching names. Two pairs are actively misleading:

- **`Scheduled_Close_Date__c` is labelled "Estimated COE Date" in Salesforce.** It
  is the estimate. The actual is `Actual_COE_Date_New__c`. The skill warns that
  swapping these inverts the whole report.
- **Airtable's "Scheduled Closing Date" is not an ECOE at all.** It comes from
  `Opportunity.Scheduled_Closing_Date__c` via `Primary_Opportunity_ID__r` — 91.7%
  agreement, against 74.9% for the Homesite ECOE — and it disagrees with the ECOE
  on 129 of 784 rows, often by weeks. The tracker resolves urgency as
  `Scheduled Closing Date || Estimated COE Date`, so feeding it an ECOE would have
  silently moved the date it sorts and flags on. Note `Opportunity.Closing_Date__c`
  is the field whose label literally reads "Closing Date" and it is **empty
  org-wide** in this scope; it is not a substitute.

New columns: `Lot`, `City`, `Zip`, `Homesite Status`, `Bucket`,
`Construction State`, `Actual Completion Date`, `Salesforce Id`,
`Address Dup Check`.

Deliberately not synced: `State` (constant "FL"), `Actual COE Date` (null by
definition — the pull is rows *without* one), `JDE Sched Close (ECOE)` (identical
to Estimated COE in all 1378 rows where both are set), `Construction Stage`
(populated on 3 of 1400 rows).

Two fields come from a supplementary SOQL because the workbook lacks them:
`Construction Stage 7 (JDE) Date` and `Scheduled Closing Date`. The first is a
**dateTime** and Salesforce returns a full timestamp, so it is not truncated to a
date — doing that would drop the time on every row and a date-only comparison
would not even report the change.

## Two bugs this shook out, both now guarded

**Whitespace.** Salesforce returns `Construction Manager` internally padded
(`"Layton, Brian                      (OLH)"`) while the existing data is
collapsed. Without normalising, 885 of 929 manager names "changed" on every run —
and worse than cosmetic, because the walk pages match roster members by exact name,
so a padded copy silently stops matching. `norm_text` collapses whitespace runs.

**Duplicates.** Job # is the primary field but Airtable does not enforce
uniqueness on it. Two concurrent runs each read the table, each computed the same
471 creates, and each wrote them — 1963 rows, every new homesite twice, nothing
erroring. Fixed three ways: a lock file in `~/.homesite_coe_report`, `fetch_jobs`
now reports duplicates and the sync refuses to run when any exist, and
`dev/dedupe-jobs.js` cleans up (keeping the row with hand-entered data, or the
oldest; it refuses to touch a group where more than one copy has real data).

## The daily schedule

`~/Library/LaunchAgents/com.olh.coe-sync.plist`, weekdays at 06:15, running
`dev/run-daily-sync.sh`. Log at `~/.homesite_coe_report/sync.log`.

```bash
launchctl list | grep olh                                   # is it registered
tail -40 ~/.homesite_coe_report/sync.log                    # what happened
launchctl unload ~/Library/LaunchAgents/com.olh.coe-sync.plist   # stop it
```

The wrapper reads `AIRTABLE_PAT` from `netlify env:get` at run time, so the token
is not stored in the script or the plist. It needs the Netlify CLI to stay logged
in and `sf` auth to stay valid; both failures are logged, and neither corrupts the
table — the tracker simply keeps showing the previous pull.

It only runs while the Mac is awake. This is not a server-side sync and cannot be:
the Salesforce CLI is authenticated on this machine only, so a Netlify scheduled
function has no way to run the pull.

---

## The bundler corrupts `var camelCase` — fixed, and now guarded

Every page of the 07/31 export threw this on load, and it showed as a red
`[bundle] SyntaxError` banner across the top of the live site:

```
Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': Unexpected token '-'
```

**Cause.** The bundler rewrites camelCase to `sc-camel-kebab-case` for its own
template attributes (`sc-camel-on-click`). It also applies that rewrite to the
copy of each inline `<script>` it appends at render time — so

```js
var mkField = function (label, type, ph, name) {   //  as written
var sc-camel-mk-field = function (label, type, ph, name) {   //  as appended
```

which does not parse, and the whole script dies. The rewrite only touches the
**declaration**; later `mkField(...)` calls are left alone. It only matches names
that start lowercase and contain an uppercase letter — `ALL_CAPS` and
all-lowercase are safe, which is why `mkField` was the only casualty in a module
otherwise full of `SESSION_KEY`-style names.

**Why the site still worked.** Each page inlines these scripts twice: once as a
real `<script>` the browser parses normally, and once more as the bundler's
appended copy. The first copy ran, so sign-in and everything else worked. The only
symptom was the banner — which on a production tool reads like the thing is broken.

**Fixed** by renaming every affected identifier to all-lowercase in
`MANGLE_SAFE_RENAMES` (a rename pass, not exact-match patches, because the
declaration and all its uses have to move together):

| identifier | where | occurrences |
|---|---|---|
| `mkField` | auth module — builds the sign-in email/password fields | 3 |
| `nameBytes` | minimal xlsx writer — zip local-header filename bytes | 6 |
| `cdSize` | minimal xlsx writer — central-directory size | 2 |

The xlsx ones were found by the guard, not by the banner: they sit in
`walk-calendar`/`tracker` ahead of the app script, so the Excel export would have
broken the same way.

**Guarded.** `findManglableDecls` runs after every patch and after loader
injection and fails the build on any `var`/`let`/`const` with a lowerCamelCase
name in a plain inline script. A patch that introduces one is exactly how this
regressed — `var noSess`, added by the session patch, shipped for one deploy. If
the build stops with a `manglable declarations` failure, rename, don't relax it.

`dev/catch-bad-script.js` and `dev/dump-mangled.js` hook `appendChild` over CDP to
recover the text of a script the bundler failed to parse, which is the only way to
see this error's actual source. `dev/check-export-errors.sh public` asserts no page
throws on load and is worth running after every re-export.

---

# The 08/01/26 design export

A re-export that changed the shape of the bundle, not just the pixels. The build
stopped on the first page rather than shipping quietly, which is the whole point
of its assertions. Four things moved.

## The auth module moved into the manifest

Through 07/31 every page inlined the 134 KB "OLH shared authentication" module
into its template, and `dev/build-live-pages.js` patched it there — seven patches
that stop the module's demo fallbacks from triggering on a live server's refusal.
The 08/01 export ships it as a gzipped **manifest asset** (47 KB) loaded by
`<script src="uuid">` instead.

`BUILD FAILED: index.html: the shared auth module is missing.` That check exists
because a page without the module has no sign-in gate at all, and it fired
correctly — the module was there, just not where the build looked.

`patchAuth()` now handles both shapes and requires exactly one of them: inline,
or a single asset. Both present is an error rather than a preference, because
whichever copy the runtime picks is not knowable from the build. All seven
patches matched the asset byte-for-byte; only the location changed.

The `MANGLE_SAFE_RENAMES` pass stays template-only on purpose. The bundler's
camelCase rewrite (`var mkField` → `var sc-camel-mk-field`, a syntax error that
kills the whole script) is applied to the plain inline scripts it re-emits at
render time, not to assets — the bundler's own 68 KB runtime is an asset and
carries 59 camelCase declarations of its own. So while the module sits in the
manifest those renames match nothing, which is correct, and they resume by
themselves if a later export re-inlines it.

## The Completion Report is on the same loader as everything else

The export made `window.OLH_DATA` the single source of truth for the suite and
deleted `completion-data.js` and `no-coe-data.js`. The Completion Report reads
`OLH_DATA.jobs[].fields` in the same `{id,fields}` shape the walk pages consume,
so it now takes the same graft: strip the bundled snapshot, inject
`dev/live-loader.js`.

`dev/completion-loader.js` and `dev/reinject-completion-loader.js` are **deleted**,
along with `dropCompletionSnapshot()` and the `completionLive` branch. Three page
patches went with them, because the design now does all three itself and does
them better:

| Was patched in | Now |
|---|---|
| an `olh-data` listener bolted onto a mount handler that only watched the viewport | `componentDidMount` polls for `OLH_DATA.jobs`, listens for `olh-data`, clears its own row memo |
| `updatedLabel` computed from `window.COMPLETION_SOURCE` | `stamp()` reads `OLH_DATA.meta.runDate` and `.division` |
| the report scope, added to the loader by commit `1a0e637` | `data()` applies it in the page: started, not complete, projected completion ≥ 7/1/26, lot status B/S/W/M |

The scope survived the move — it is enforced one layer up now, in the component
rather than in the loader feeding it.

`/api/jobs` gained `meta.runDate` and `meta.division` for that provenance line.
`runDate` is the newest `Last Synced` across the table, not `fetchedAt`:
`fetchedAt` is when Airtable was read, which is always "seconds ago" and says
nothing about how current the Salesforce data is. It is `null` when the column is
empty everywhere rather than falling back to today, which would claim a freshness
nobody checked.

## Page permissions became real permissions

The export added a **Page Access** grid to the admin console: seven `page.*`
permissions (`page.home`, `page.tracker`, `page.completion`, `page.walks`,
`page.scheduler`, `page.workload`, `page.admin`) sharing one grid and one
`Auth.can()` check with the five capabilities.

`netlify/lib/olh-auth.js` knew only the five. `PERMS` is an allow-list and
`normalizeMatrix()` drops anything not in it, so the console would have shown the
grid, accepted the ticks, `PUT` them, and discarded every `page.*` on the way in.
A control that looks like it saves and does not is worse than no control.

The server now mirrors the frontend rules exactly:

- `page.admin` is in `ROLE_LOCKS.admin` and in `ADMIN_ONLY_PAGES`, so only admin
  can hold it — filtered **after** `NEEDS_PAGE`, so `roster.manage` implying
  `page.admin` cannot smuggle the console to another role.
- `NEEDS_PAGE` drags the page along with the capability that edits it: an
  editing permission without its page is a permission that can never fire.
- Every `page.*` is in `IMPLIES_VIEW`, so granting any page grants `suite.view`.
- `DENY` builds the same sentence the frontend does, so a refusal reads
  identically whether it came from the page or the API behind it.

The Airtable `Roles.Permissions` field is a `multipleSelects`, and writes go
through `typecast: true`, so the seven new options are created on first save —
no schema edit needed.

## Area Construction Manager, and the three columns that were dropped

The export's Completion Report added four fields sourced from `uploads/ACM.xlsx`
rather than from Salesforce, and Airtable had none of them.

**Kept — Area Construction Manager.** The ACM filter replaced Concierge as the
page's main control, so an empty one is a dead page. It is not a Salesforce
field: the assignment is by community. `dev/acm-map.json` holds that mapping (55
communities, 3 ACMs, from the roster sheet), `dev/sync_coe_to_airtable.py`
derives the column from the `Community` value it already writes, and
`dev/backfill-acm.js` filled the rows that predated the field — 1,400 of 1,492.

Deriving it in the same pass that writes `Community` keeps the two consistent by
construction: a job that changes community gets the right ACM in the same run.
An unmapped community yields **blank**, never a guess. 80 rows across 42
communities are blank today, and several are near-misses that are genuinely
different products — `Ranches at Mcleod 40s CORE` is not `Ranches at McLeod 40s
GC`, `Crosswinds 50s` is not `Crosswinds 50s Classic`. Fuzzy-matching those would
put a real manager's name against homesites they do not run. Add the community to
`acm-map.json` when one appears.

**Dropped — Homesite Plan Name, Homesite Plan Number, Elevation.** These come
from the workbook's per-job `Export` sheet, which is a one-off upload with no
sync behind it, and they were populated on 586 of 1,400 rows even there. Live
they would have rendered a column of em-dashes on every row, which reads as
missing data rather than absent plumbing. Header cells, body cells and the
drawer's `Plan` row are removed together so the table stays aligned.

The workbook also carries its own QAI/QAA/CEL/ACC dates. Those are **not**
imported. Airtable's are hand-maintained by the OLH team and the sync has never
touched them; a frozen spreadsheet does not get to overwrite what someone typed.

## The scope, and the archived rows that were inflating it

The Completion Report showed 1,047 homesites when it should have shown 1,013.
Every one of the extra 34 satisfied the stated scope — started, not complete, no
Actual COE, lot status B/S/W/M — because they were **archived**.

The sync sets `Record Status = Closed` when a job stops appearing in the
Salesforce export and freezes its Salesforce columns at whatever they last were.
Frozen is the problem: an archived job looks started-and-unfinished forever, so
it matched the scope permanently. 34 had accumulated over three days (7/30–8/1)
and the count would have climbed every day the sync ran. `Record Status =
Active` is now the first clause in `inScope`.

`Actual COE Date` blank was added as well. It changes no count today — every row
in the table is blank there, because the table comes from the "homesites with no
Actual COE" pull — but that is a property of the upstream query, not of this
page, and a closed home does not belong on a completion report if the pull ever
widens.

The `Projected Completion Date >= 2026-07-01` floor was **kept**, confirmed
08/01. It hides 11 started-but-unfinished homesites whose projection is already
in the past (the oldest is 2018) and 3 with no projection at all. Those 14 are a
data-quality question for the tracker rather than rows to schedule against, and
this report is the forward-looking view.

`dev/check-completion-scope.js` lifts `inScope` out of the built page and runs it
over the live Jobs table, rather than re-deriving the predicate — a re-derived
copy only ever tests itself, and the copy is exactly what drifts:

    AIRTABLE_PAT=… node dev/check-completion-scope.js 1013

## Two things the move to an asset broke, and the checks that now cover them

### The tracker raced the auth module

`Could Not Load Homesite Data — undefined is not an object (evaluating
'window.OLHAuth.authHeaders')`.

The tracker carries its own `loadLive()` rather than the injected loader, and
the build patches it to send `OLHAuth.authHeaders()`. That was safe while the
auth module was inlined in the template: it was defined before any component
mounted. As a manifest asset the bundler injects it asynchronously, so
`componentDidMount` could reach the fetch first. The design already knew this —
its own `_wireAuth` polls for `window.OLHAuth` with the comment "may not have
run yet in the bundled build" — but the initial `loadLive` call never waited.

A null-safe header would have been the wrong fix. `/api/jobs` answers 401
without an Authorization header, so degrading quietly turns an ordering problem
into an empty grid and a misleading refusal. `_loadWhenAuthed` waits on the same
6s budget `_wireAuth` uses, and `_authHeaders` throws a sentence naming the real
cause if the module genuinely never arrives.

It is a race, so it does not reproduce reliably in headless — the fix removes
the dependency on ordering rather than improving the odds.

### The logo 404'd on all eight pages

The export switched the header to `assets/lennar-logo-blue.png`; `public/assets/`
had only the white one. `publish` is an allow-list by design, so anything not
copied into `public/` is a 404 — on every page, silently. A missing `<img>`
changes no text and throws no exception, so every existing check passed. Only a
network probe saw it.

`checkStaticRefs()` now runs at the end of every build and fails it, reading
references out of the decompressed text assets as well as the template, because
that is where this one lived.

### verify-pages.sh asserts no uncaught exception

Every check in that script was about what the DOM says, and the tracker rendered
a perfectly correct sign-in gate while its data path was dead. A thrown
TypeError is never an expected state. 401s are not failures there — an anonymous
visitor being refused is the boundary working, and section 2 already asserts it.

## The tile groups by community, and the top row lines up

The right-hand tile was "Homesites by Stage": two-digit JDE codes that need the
stage table to read. It groups by **Community** now, which is how the division is
organised and how the report gets used. Same behaviour — click a bar to filter,
click again to clear — driving the `comm` filter instead of `stage`. Both are
still available as selects in the Filters card.

Still the top 8 by count. That is deliberate: the tile's height sets the bottom
of the whole row, there are 50-odd communities, and everything outside the top 8
is reachable from the Community select. Names are truncated with an ellipsis
rather than wrapped — a wrapped name makes its row taller than the others — with
the full name on the button's title.

The three panels share one grid row under `align-items:start`, so each was only
as tall as its own content and the bottom edge was ragged. Both short panels get
`align-self:stretch` rather than a hand-tuned height: the row is as tall as its
tallest panel, and that is the community tile, whose height is however many bars
the current filters leave — 8 normally, 1 when a community is selected. A pixel
nudge could only ever be right for one of those states.

The Filters card gives its slack to the EDD slicer, which is the only growable
child, so the slicer gets taller. Its bars moved from px to a percentage for the
same reason: a 40px-scaled bar in a taller box just sits at the bottom with
headroom above it. The calendar gives its slack to its week rows via
`grid-auto-rows:1fr`, which reads as slightly roomier day cells rather than a gap
under the last week.

`dev/measure-panels.js` reports each panel's height and bottom edge at three
viewport widths and can screenshot the result:

    node dev/measure-panels.js http://localhost:8902/completion 1440 --shot

It seeds an obvious layout fixture first. Measured signed-out the tile has no
bars, so the row is short and the numbers describe a view nobody uses. That
fixture lives in the measuring script only — it is never built and never shipped,
and the values are deliberate nonsense so a measurement screenshot can never be
mistaken for real homesites.

`dev/verify-server.js` now serves `assets/` and `fonts/` too. It served HTML and
nothing else, so a logo missing from `public/` looked exactly like one that was
there — a harness that cannot tell those apart is not checking them.

## tracker-new stayed deleted

The export ships `tracker-new.html` again and links job numbers to it. It is
still not built and `/tracker-new` still 301s to `/tracker` — the page predates
the shared auth module, so it has no sign-in gate, and its own `loadLive()` falls
back to the fixture when `/api/jobs` answers 401. Shipping it would put 900
invented homesites in front of anonymous visitors. Job-number links land on
`/tracker` instead.
