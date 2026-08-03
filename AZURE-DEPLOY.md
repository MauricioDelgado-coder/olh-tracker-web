# Publishing the OLH Tracker on Azure

Companion to `README.md`, which stays the reference for what the app *is*. This
file covers only the move to Azure Static Web Apps: what was added, what has to
be configured, and the four places Azure does not behave like Netlify.

Nothing in `netlify/` changed. The Netlify deploy still works, so the cutover is
reversible — which matters, because the tracker is the tool 1,400 open homesites
are managed from and a bad Friday afternoon should not be a one-way door.

---

## What was added

```
api/                                 # the Azure Functions app
├── host.json                        # Functions runtime config
├── package.json                     # one dependency: @azure/functions v4
├── local.settings.json.example      # template for `func start` (real one is gitignored)
├── src/index.js                     # the route table — Azure's netlify.toml [[redirects]]
├── src/netlify-adapter.js           # HttpRequest <-> Netlify event translation
└── _netlify/                        # GENERATED, gitignored — see below

public/staticwebapp.config.json      # the rest of netlify.toml
public/404.html                      # Azure has no implicit 404

dev/build-azure-api.js               # stages netlify/{functions,lib} into api/_netlify
dev/verify-azure-adapter.js          # 49 checks over the adapter and the config
.github/workflows/azure-static-web-apps.yml
```

Modified: `dev/run-daily-sync.sh` (token source — see *The daily sync* below) and
`.gitignore`.

### The handlers are not rewritten, and not copied by hand

`api/src/netlify-adapter.js` translates an Azure `HttpRequest` into the `event`
object the eight handlers in `netlify/functions` already expect, and translates
their `{ statusCode, headers, body }` back. The contract is six fields wide —
`httpMethod`, `path`, `headers`, `body`, `isBase64Encoded`,
`queryStringParameters` — and it is enumerated at the top of that file.

The alternative was porting the handlers to Azure's shape. That would fork the
26-key editable whitelist, the per-field capability checks, the scrypt policy and
the stateless-HMAC session across two files. A fork of an auth boundary is the
duplicate that drifts silently: the copy keeps working while it stops meaning the
same thing. This repo has already paid for that pattern twice — two definitions
of "open work", and the hand-maintained `SELECT_OPTIONS` mirror.

Static Web Apps packages `api/` and nothing above it, so
`require('../../netlify/functions/jobs.js')` would resolve on this Mac and be
missing from the deployed bundle — a green deploy where every endpoint 500s.
`dev/build-azure-api.js` copies the handlers into `api/_netlify/` instead. That
copy is generated and gitignored, and `--check` fails the build if it has fallen
behind `netlify/`. CI runs both before every deploy.

---

## Prerequisites

The Azure CLI is not installed on this Mac (checked). You need it for everything
below except the portal path.

```bash
brew install azure-cli
az login                       # opens a browser; use the Lennar account
az account show                # confirm the right subscription is selected
az account set --subscription "<subscription name or id>"
```

**Before any of that: confirm you can create resources in a Lennar
subscription.** If `az login` lands you somewhere with no subscription, or
`az group create` returns `AuthorizationFailed`, this needs IT to provision it.
See *Before you show this to anyone* at the end — there are two things worth
raising with them regardless of who clicks the button.

---

## Create it in the portal (no CLI needed)

Homebrew is not installed on this Mac and `/usr/local/bin` carries `mdatp`, so it
is a managed machine — installing a package manager is a decision for you and
possibly IT. None of it is required. The portal creates the resource and the
GitHub Actions workflow needs only a token, so the CLI never enters the picture.

### 1. Start the create blade

<https://portal.azure.com/#create/Microsoft.StaticApp> — or search *Static Web
Apps* in the portal and press **Create**.

### 2. Basics

| Field | Value |
|---|---|
| Subscription | whichever Lennar subscription you have |
| Resource group | **Create new** → `olh-tracker-rg` |
| Name | `olh-tracker` — the resource name only; Azure generates a random hostname regardless |
| Plan type | **Free** |
| Region | `East US 2` (this sets where the managed functions run) |

> **As actually created, 2026-08-03:** name `webtracker`, resource group
> `webtracker_group`, Free, region `centralus`, subscription
> `Azure subscription 1` (`c8e4192d-73cc-417d-bf55-68029eada037`), default
> hostname `https://jolly-mud-0ff2f8910.7.azurestaticapps.net`. The names differ
> from the table above; `dev/run-daily-sync.sh` has been updated to match, and
> `OLH_SWA_NAME` / `OLH_SWA_RESOURCE_GROUP` override them if this ever moves.
>
> One environment only (`trafficSplitting.environmentDistribution: {default: 100}`),
> `provider: None` and `repositoryUrl: null` — confirming the deployment source was
> left unattached, so the committed workflow is the only thing that deploys.
> `stableInboundIP: 64.236.125.137`, worth keeping if IT ever wants to allowlist it.
>
> **App settings are not in the resource JSON.** They live in the sub-resource
> `.../staticSites/webtracker/config/appsettings`, excluded from the site's ARM
> view because they carry secrets. The JSON View blade therefore cannot confirm
> whether `AIRTABLE_PAT` is set; `az staticwebapp appsettings list` can.

Free covers everything the tracker needs: managed functions, a custom domain with
a free certificate, 100 GB/month. Standard (~$9/month) buys `allowedIpRanges`
network restrictions, private endpoints and an SLA — worth revisiting if IT wants
the site reachable only from the Lennar network, but not needed to get running.

### 3. Deployment details — choose **Other**, not GitHub

This is the one screen where the obvious choice is the wrong one.

Picking **GitHub** runs an OAuth flow and then *commits its own workflow file* to
the repo — `.github/workflows/azure-static-web-apps-<random>.yml` — with
`app_location` and `api_location` guessed by Azure's build detection. It guesses
wrong here: it will not run `dev/build-azure-api.js`, so `api/_netlify` ships
empty and every endpoint 500s behind a green deploy. Worse, it would sit
*alongside* `.github/workflows/azure-static-web-apps.yml`, and both would fire on
every push and race each other.

**Other** creates the resource with no deployment source attached. You then wire
it up with a token, and the committed workflow — which already stages the
handlers and asserts they match `netlify/` — is the only thing that deploys.

Then **Review + create** → **Create**. About a minute.

### 4. Copy the deployment token into GitHub

1. The new resource → **Overview** → note the URL (`https://<something>.azurestaticapps.net`).
2. Overview toolbar → **Manage deployment token** → copy it.
3. GitHub → `olh-tracker-web` → Settings → Secrets and variables → Actions →
   **New repository secret**:
   - Name: `AZURE_STATIC_WEB_TOKEN` — must match the workflow exactly. Azure's
     own generated workflows call this `AZURE_STATIC_WEB_APPS_API_TOKEN`; the
     name is arbitrary, but a mismatch resolves to an empty string and the
     deploy fails with `deployment_token was not provided` rather than anything
     that mentions a secret. The `Check the deployment token is set` step exists
     to catch that.
   - Secret: the token

Confirm the repo is **private** while you are on that page.

### 5. Application settings

Left nav → **Environment variables** (older portals call this *Configuration →
Application settings*), Production scope, **+ Add** each:

| Name | Value |
|---|---|
| `AIRTABLE_PAT` | the existing token — `netlify env:get AIRTABLE_PAT` |
| `SESSION_SECRET` | `netlify env:get SESSION_SECRET` to copy it across, **or** a fresh `openssl rand -hex 32` |
| `SITE_URL` | the hostname from step 4, no trailing slash |

Copying `SESSION_SECRET` across makes the cutover silent. A fresh value signs
everyone out, because sessions are stateless HMACs over that key. Either is fine
as long as it is deliberate.

Set `SITE_URL` before inviting anyone. Without it `password.js` falls back to the
request `Host`, and invite links would point at the generated
`*.azurestaticapps.net` name — which reads like phishing once you have a real
domain.

**Save.** Settings are read at cold start, so the next request picks them up.

### 6. Push

```bash
cd ~/Documents/Claude/olh-tracker-web
git add api .github AZURE-DEPLOY.md public/staticwebapp.config.json public/404.html \
        dev/build-azure-api.js dev/verify-azure-adapter.js \
        dev/run-daily-sync.sh netlify.toml README.md .gitignore
git commit -m "Add the Azure Static Web Apps deploy alongside Netlify"
git push
```

`api/_netlify/` is gitignored on purpose and CI regenerates it. `api/package-lock.json`
is committed, so the deploy installs the same `@azure/functions` you tested with.

In the Actions log, the line to look for is **`api/_netlify is current (9 files)`**.
If it says out of date, the deploy is about to ship handlers that differ from the
repo and the build stops itself.

---

## Create the resources from the CLI (alternative)

Free tier is enough to run this: 100 GB bandwidth a month, managed functions
included, custom domains with free certificates. The reasons to pick Standard
(~$9/month) are `allowedIpRanges` network restrictions, private endpoints, and a
higher function timeout. Neither tier changes the app's own sign-in.

```bash
RG=olh-tracker-rg
NAME=olh-tracker
LOCATION=eastus2                # SWA is available in a limited set of regions

az group create --name "$RG" --location "$LOCATION"

az staticwebapp create \
  --name "$NAME" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Free
```

If you keep the names above, `dev/run-daily-sync.sh` finds the app settings
without further configuration. Different names go in `OLH_SWA_NAME` and
`OLH_SWA_RESOURCE_GROUP`.

---

## Application settings

The same three variables Netlify held, set on the static web app rather than
baked into anything. `AIRTABLE_PAT` and `SESSION_SECRET` are credentials: they
belong here and nowhere else, exactly as `README.md` says of the Netlify UI.

```bash
# Prompted rather than passed on the command line, so neither lands in shell
# history. `read -p` is NOT portable -- in zsh (the default shell on this Mac)
# -p means "read from coprocess" and fails with `read: -p: no coprocess`,
# leaving the variable empty and the command running with no credential at all.
printf 'AIRTABLE_PAT: '; read -rs PAT; echo
az staticwebapp appsettings set --name "$NAME" --resource-group "$RG" \
  --setting-names "AIRTABLE_PAT=$PAT"
unset PAT

az staticwebapp appsettings set --name "$NAME" --resource-group "$RG" \
  --setting-names "SESSION_SECRET=$(openssl rand -hex 32)"
```

| Setting | Required | Notes |
|---|---|---|
| `AIRTABLE_PAT` | yes | Scopes `data.records:read` + `data.records:write`, base `appYX9df4lGO6G2uz` only. Reuse the existing token or issue a new one and revoke the old. |
| `SESSION_SECRET` | yes | **Rotating this signs everyone out.** Sessions are stateless HMACs over this key, so a new value invalidates every outstanding token. Copy the Netlify value across if you want a silent cutover; generate a fresh one if you would rather everyone re-authenticates on the new host. |
| `SITE_URL` | strongly recommended | Set it once the real hostname exists. `password.js` falls back to the request `Host` header, which on Azure is the generated `*.azurestaticapps.net` name — invite and reset links would point at the wrong host and read as phishing. |

Azure Functions read app settings at cold start, so a changed setting takes
effect on the next instance. Deploy again if you want it immediately.

---

## Deploy

### Option A — GitHub Actions (recommended)

The repo already has a remote: `github.com/MauricioDelgado-coder/olh-tracker-web`.
Confirm it is **private** before the first push; the tracker's data is real.

1. Portal → your static web app → **Manage deployment token** → copy it.
2. GitHub → repo → Settings → Secrets and variables → Actions → **New repository
   secret**, named `AZURE_STATIC_WEB_TOKEN` (matching the workflow).
3. Push. `.github/workflows/azure-static-web-apps.yml` stages `api/_netlify`,
   asserts it matches `netlify/`, and deploys.

Pull requests get their own staging URL and the `close_pull_request` job tears it
down on merge.

> **Lennar Conditional Access blocks `swa login` (confirmed 2026-08-03).**
> The SWA CLI authenticates with the OAuth **device code flow**, and signing in
> with `mauricio.delgado@lennar.com` returns:
>
> > You don't have access to this. Your sign-in was successful but does not meet
> > the criteria to access this resource.
>
> That is a tenant policy, not a misconfiguration — device code flow is phishable
> and Microsoft recommends blocking it. Portal sign-in is unaffected because
> browser SSO with a passkey is a different flow.
>
> **Consequence: use the deployment token, never `swa login`.** The token is a
> resource-scoped secret issued by the static web app itself, so no Entra sign-in
> happens and Conditional Access does not apply. This is also why the GitHub
> Actions path is the better long-term answer here — it authenticates with the
> same token and needs no Azure login at any point.

### Option B — SWA CLI

```bash
npm install -g @azure/static-web-apps-cli
node dev/build-azure-api.js                    # required: stage the handlers first
swa deploy ./public --api-location ./api --env production \
  --deployment-token "<token from the portal>"
```

The `build-azure-api.js` step is not optional here. The CLI uploads what is on
disk; without it, `api/_netlify` is empty or stale and every endpoint fails.

### Running it locally

```bash
brew install azure-functions-core-tools@4
cp api/local.settings.json.example api/local.settings.json   # then paste the real values
node dev/build-azure-api.js
swa start ./public --api-location ./api                      # http://localhost:4280
```

Then the existing suites, which are host-agnostic:

```bash
node dev/verify-azure-adapter.js                     # the port itself
bash dev/verify-auth.sh  http://localhost:4280 '<token>' <email>
bash dev/verify-pages.sh http://localhost:4280
```

---

## Four ways Azure differs from Netlify

### 1. Extensionless paths are not implicit

This is the big one. Netlify served `/tracker` for `tracker.html` on its own.
Azure only does that for `index.html` inside a folder, so **without explicit
rewrites every internal link in the suite 404s**. All seven non-index pages have
a rewrite in `staticwebapp.config.json`, and `dev/verify-azure-adapter.js` walks
`public/` and fails if a page is ever added without one.

### 2. Route evaluation stops at the first match

Netlify applied `force = true` redirects and separate `[[headers]]` blocks
independently. Azure evaluates `routes` top to bottom and **stops at the first
match**, so order is load-bearing and a rule in the wrong place silently shadows
everything under it. The file is banded: blocks, then the `tracker-new` 301s,
then the page rewrites, then the catch-all header rules. The `301`s must stay
above `/tracker` — `tracker-new` was deleted for having no sign-in gate and a
`loadLive()` that fell back to the 900-record fixture, and it must not become
reachable again.

### 3. There is no implicit 404

Netlify had one. On Azure the usual answer is `navigationFallback` to
`index.html`, which is wrong here: it answers **200 with the landing page** for
every mistyped path, including `/api` typos — handing a `fetch()` an HTML body
where it expects JSON, so a 404 surfaces as a parse error. There is no
`navigationFallback`; `responseOverrides` points 404 at a static `404.html` that
makes no API call and loads no font.

### 4. Cold starts, and the 30-second cache

`jobs.js` caches Airtable responses for 30s in module scope and
`walk-config.js` for 5 minutes. Both still work, but Azure recycles instances
more eagerly than Netlify did, so expect a lower cache hit rate and a slower
first request after idle. Behaviourally identical, just occasionally slower —
worth knowing before someone reports the tracker as sluggish.

Not a difference, but worth recording: the API paths are baked into gzip+base64
manifest assets inside the eight bundled pages, so they had to stay at `/api/*`.
They do — SWA mounts managed functions there. **No page needed rebuilding.**

---

## The daily sync

`dev/run-daily-sync.sh` read the Airtable token with `netlify env:get`. That
quietly coupled the 06:15 Salesforce pull to the hosting vendor: the sync writes
to Airtable and has nothing to do with Netlify, but repointing the site at Azure
— or deleting the Netlify site afterwards — would have stopped it dead. And it
fails invisibly. The tracker keeps serving the previous pull and looks fine.

`read_pat()` now tries four sources, most-local first, and logs which one won:

1. `$AIRTABLE_PAT` in the environment
2. **macOS Keychain** — belongs to this machine, survives any hosting change
3. `az staticwebapp appsettings list`
4. `netlify env:get` (legacy, so nothing breaks mid-migration)

Seed the Keychain once and the pipeline stops depending on where the site is
hosted:

```bash
security add-generic-password -a "$USER" -s olh-tracker-airtable-pat -w
# -w with no value prompts, so the token is not in shell history
```

Unchanged, and unchangeable: the sync runs on this Mac via launchd, only while it
is awake, because the Salesforce CLI is authenticated here and nowhere else. A
serverless function cannot run the pull. Azure Container Apps Jobs with a
Salesforce JWT connected app is the real fix if this ever needs to run without
the laptop; it is a separate piece of work.

---

## Cutover checklist

```
[ ] az login lands in a Lennar subscription that permits resource creation
[ ] resource group + static web app created
[ ] AIRTABLE_PAT and SESSION_SECRET set as application settings
[ ] GitHub repo confirmed PRIVATE, deployment token added as a secret
[ ] first deploy green; check the Actions log for "api/_netlify is current"
[ ] custom domain added, SITE_URL set to it, redeploy
[ ] anonymous request to /api/jobs returns 401 (not 200, not HTML)
[ ] all eight pages load at their extensionless paths, no red bundle banner
[ ] /tracker-new 301s to /tracker
[ ] sign in, edit one cell on /tracker, confirm it saves and audits
[ ] invite link from /admin points at the custom domain, not *.azurestaticapps.net
[ ] Keychain seeded; run `bash dev/run-daily-sync.sh` by hand and read the log
[ ] leave the Netlify site up for a week, then delete it
```

The order matters at two points: `SITE_URL` before you invite anyone, and the
manual sync run before you trust the next morning's 06:15.

---

## Before you show this to anyone

Two things worth raising with Lennar IT, independent of who provisions the
subscription. Neither is a reason not to do this; both are easier to answer now
than after the tool is in daily use by the division.

**The data lives in Airtable, not Azure.** Hosting moves to a Lennar
subscription, but ~1,400 homesite records — addresses, buyer walk dates, manager
assignments — plus the user accounts and password hashes stay in an external
SaaS base. That is the question a security review will ask first, and it is not
affected by which host serves the pages.

**The repo is under a personal GitHub account.** `MauricioDelgado-coder/olh-tracker-web`
holds the tool's source and its deployment token. Confirm it is private at
minimum; a Lennar-owned org is the better home if this becomes official.

If you want a corporate sign-in gate on top of the app's own accounts, Static Web
Apps has Entra ID built in — add `{"route": "/*", "allowedRoles":
["authenticated"]}` and a 401 override redirecting to `/.auth/login/aad`. Be
deliberate about it: users would then sign in twice, once to Entra and once to
the app. The long-term version is replacing the app's own accounts with Entra
rather than stacking them, which is a real piece of work and worth doing properly
if this becomes an official tool.
