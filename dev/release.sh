#!/usr/bin/env bash
#
# The only way public/ changes.
#
#   bash dev/release.sh <design-export-folder>
#
# Stages a design export under exports/<date>/, applies dev/export-map.json,
# builds, checks, and only then promotes into public/. Stops before committing.
#
# Why one script instead of the README's list of commands: every step here
# already existed in dev/, and the ordering between them is load-bearing in ways
# that are invisible when you get it wrong. build-azure-api.js --check has to run
# against the same tree that ships, the name map has to be applied before
# build-live-pages.js sees the folder, and the export has to be recorded before
# anything overwrites public/. A checklist you follow by hand is a checklist you
# eventually follow at 11pm.
#
# Nothing writes to public/ until every check has passed: the build targets a
# temp dir and is rsync'd in at the end. A failed release leaves the last good
# build serving.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: bash dev/release.sh <design-export-folder>" >&2
  exit 2
fi
# -P resolves symlinks. Bash's default logical pwd would let a symlink pointing
# into exports/ slip past the self-destruct guard below and get deleted.
SRC="$(cd "$SRC" && pwd -P)"

MAP="dev/export-map.json"
[ -f "$MAP" ] || { echo "missing $MAP" >&2; exit 1; }

DATE="$(date +%Y-%m-%d)"
STAGE="exports/$DATE"
RAW="$STAGE/raw"
PAGES="$STAGE/pages"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[31mRELEASE FAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Refuse to build on top of uncommitted work in public/.
#
# A release has to be reproducible from a known commit. If public/ already holds
# a hand edit, this run silently absorbs it and the next run silently reverts it,
# which is the exact failure the "public/ is generated only" rule exists to stop.
# ---------------------------------------------------------------------------
step "Checking public/ is clean"
# --porcelain, not `git diff`, because diff does not see UNTRACKED files. A
# hand-dropped public/scratch.html is invisible to `git diff`, is seeded into the
# build stage, survives rsync --delete, and ships. publish is an allow-list
# precisely so that a stray file cannot be served -- but a stray file inside the
# allow-list is served, and this is the gate that catches it.
DIRTY="$(git status --porcelain --untracked-files=all -- public)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY"
  die "public/ has uncommitted or untracked files. Commit or remove them first.
  public/ is build output: anything in there that release.sh did not put there
  will be published."
fi
echo "  clean"

# ---------------------------------------------------------------------------
# 2. Stage the export twice, for two different consumers.
#
#   raw/    verbatim. The archival copy, and where the manifest hashes are read
#           from. Includes the loose *.dc.html design source.
#   pages/  only what build-live-pages.js should see: the bundled pages named in
#           the map, plus the asset directories they reference.
#
# pages/ is built by allow-list rather than by excluding things, because
# build-live-pages.js aborts on any .html in its input that is not declared in
# PAGES. Copying the export's production/ folder wholesale drags in
# tracker-new.html and dies. Assembling only what is declared means the failure
# mode is a loud "unmapped page" here, naming the file, instead of an assertion
# deep in the build.
# ---------------------------------------------------------------------------
step "Staging export into $STAGE"
# Refuse if the source is inside exports/. This step rewrites exports/<date>/,
# which would move the input out from under itself; the run then fails later with
# a misleading "the export has no production/ folder". Re-releasing a previously
# staged export is a reasonable thing to want, so say so instead of failing
# obscurely three steps downstream.
case "$SRC" in
  "$REPO/exports"|"$REPO/exports"/*)
    die "the export is inside exports/, which this step rewrites.
  Copy it out first:
      cp -R \"$SRC\" /tmp/olh-export && bash dev/release.sh /tmp/olh-export" ;;
esac
# Two releases in one day is normal -- a failed run, then a re-export. Wiping
# exports/<date>/ would destroy the earlier run's raw/, which is the archival
# copy and exists nowhere else once the download is gone. Move it aside instead.
# These accumulate; exports/ is gitignored and local, so prune it by hand.
if [ -d "$STAGE" ]; then
  SUPERSEDED="$STAGE.superseded-$(date +%H%M%S)"
  mv "$STAGE" "$SUPERSEDED"
  echo "  kept the earlier run of today at $SUPERSEDED"
fi
mkdir -p "$RAW" "$PAGES"
rsync -a --exclude '.DS_Store' --exclude '.thumbnail' "$SRC"/ "$RAW"/
echo "  raw: $(find "$RAW" -maxdepth 1 -type f | wc -l | tr -d ' ') files, $(du -sh "$RAW" | cut -f1)"

step "Applying dev/export-map.json"
node - "$RAW" "$PAGES" "$MAP" <<'NODE'
'use strict';
const fs = require('fs'), path = require('path');
const [raw, pages, mapPath] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const pageMap = map.pages || {};
const ignore = map.ignore || {};
const from = path.join(raw, map.pagesFrom || 'production');

const fail = (m) => { console.error('RELEASE FAILED: ' + m); process.exit(1); };

if (!fs.existsSync(from)) {
  fail('the export has no ' + (map.pagesFrom || 'production') + '/ folder.\n' +
       '  build-live-pages.js needs the BUNDLED pages (with __bundler/manifest\n' +
       '  blocks), not the loose *.dc.html design source. If the design tool\n' +
       '  changed where it writes them, update "pagesFrom" in the map.');
}

// Every bundled page must be either shipped or explicitly ignored. An export
// that grows a page is a decision to make, not a diff to skim past.
const exported = fs.readdirSync(from).filter((f) => f.endsWith('.html')).sort();
const unknown = exported.filter((f) => !pageMap[f] && !ignore[f]);
if (unknown.length) {
  fail('the export contains page(s) the map does not know about:\n    ' +
       unknown.join('\n    ') +
       '\n  Add each to "pages" (and to PAGES in dev/build-live-pages.js) to ship\n' +
       '  it, or to "ignore" with a reason.');
}

// And every mapped page must be in the export. A re-export that silently drops a
// page would otherwise just leave the previous build of it serving forever.
for (const [src, dest] of Object.entries(pageMap)) {
  const p = path.join(from, src);
  if (!fs.existsSync(p)) fail('the export is missing a mapped page: ' + src);
  fs.copyFileSync(p, path.join(pages, dest));
  console.log('  ship     ' + src + (src === dest ? '' : '  -> ' + dest));
}
for (const [f, why] of Object.entries(ignore)) {
  if (fs.existsSync(path.join(from, f))) {
    console.log('  skip     ' + f + '  (' + why.split('.')[0] + ')');
  }
}

// The asset dirs live at the export root, not inside production/. They have to
// be beside the pages: checkStaticRefs() resolves every assets/ and fonts/
// reference against the publish dir, and a missing image is a 404 on every page
// that changes no text and throws nothing.
for (const d of (map.assetDirs || [])) {
  const p = path.join(raw, d);
  if (!fs.existsSync(p)) fail('the export is missing asset dir: ' + d);
  fs.cpSync(p, path.join(pages, d), { recursive: true });
  console.log('  assets   ' + d + '/');
}
NODE

# ---------------------------------------------------------------------------
# 3. Record which export produced this build, without committing the export.
#
# The sources are gitignored for good reason -- olh-data.js is 2 MB of real
# homesite records. The cost of that is a commit history where a design change is
# a 1 MB diff in a generated file with no way to tell which export it came from.
# A manifest of names and content hashes is the cheap half of the tradeoff:
# diffable, committed, and enough to answer "which export is prod running?"
#
# Written to the STAGE, not to exports/manifest.json. The build and the checks
# below can still fail, and a manifest describing an export that was never
# published is worse than no manifest: public/ is correctly left untouched, but
# the committed file now claims prod came from an export it did not. It is
# promoted alongside version.json at the end, so provenance and pages move
# together or not at all.
# ---------------------------------------------------------------------------
step "Recording the export manifest"
node - "$RAW" "$DATE" "$SRC" "$STAGE/manifest.json" <<'NODE'
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [raw, date, origin, out] = process.argv.slice(2);

const hash = (p) => crypto.createHash('sha256')
  .update(fs.readFileSync(p)).digest('hex').slice(0, 16);

const entries = (dir, filter, prefix) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter).sort().map((f) => ({
    file: prefix + f,
    bytes: fs.statSync(path.join(dir, f)).size,
    sha256: hash(path.join(dir, f)),
  }));
};

// Both halves of the export are recorded. The bundled pages are what actually
// gets built, so their hashes are what let you prove a given public/ came from a
// given export. The loose .dc.html source is what a person reads when they want
// to know what changed in the design, so its hashes answer a different and
// equally real question: which design revision was this.
const files = [
  ...entries(path.join(raw, 'production'), (f) => f.endsWith('.html'), 'production/'),
  ...entries(raw, (f) => f.endsWith('.dc.html'), ''),
  ...entries(raw, (f) => f.endsWith('.js'), ''),
];

// The export folder NAME, not its absolute path. The path is transient -- it is
// wherever the zip happened to be unpacked, it embeds a local username, and it
// changes for no reason between machines, which would make this committed file
// churn on every release. The name is the part that identifies the export.
fs.writeFileSync(out,
  JSON.stringify({ exportDate: date, exportName: path.basename(origin), files },
    null, 2) + '\n');
console.log('  ' + files.length + ' source files hashed');
NODE

# ---------------------------------------------------------------------------
# 4. Build into a temp publish dir seeded from public/.
#
# Seeded, because public/ holds files the build does not produce: 404.html,
# robots.txt, staticwebapp.config.json, assets/, fonts/, vendor/. Seeded MINUS
# the eight generated pages, so a page that fails to build is absent from the
# stage rather than silently inherited from the last release.
#
# public/support.js is seeded too, but note it is UNTRACKED -- .gitignore has a
# bare `support.js` pattern that matches it. So it exists on this laptop and on
# neither host. No page references it. It is the design tool's dc-runtime bundle
# and holds nothing sensitive; it is simply stale. Deleting it is safe and would
# stop `netlify deploy --prod` from uploading a file git does not know about.
#
# dev/build-new-views.js is deliberately NOT run. It produced tracker-new.html,
# the superseded "New Views" prototype deleted in 2026-08 -- both netlify.toml
# and staticwebapp.config.json now 301 that path to /tracker. The script is kept
# for history; running it here would republish a page the redirects say is gone.
# ---------------------------------------------------------------------------
step "Building pages"
PUBSTAGE="$(mktemp -d)"
trap 'rm -rf "$PUBSTAGE"' EXIT
rsync -a --exclude '.DS_Store' public/ "$PUBSTAGE"/
node -e '
  const fs=require("fs"),p=require("path");
  const m=JSON.parse(fs.readFileSync("dev/export-map.json","utf8")).pages;
  for(const n of Object.values(m)){const f=p.join(process.argv[1],n);
    if(fs.existsSync(f))fs.unlinkSync(f);}
' "$PUBSTAGE"

node dev/build-live-pages.js "$PAGES" "$PUBSTAGE"

for n in $(node -e 'const m=require("./dev/export-map.json").pages;console.log(Object.values(m).join(" "))'); do
  [ -s "$PUBSTAGE/$n" ] || die "build produced no $n"
done
echo "  all mapped pages present in the stage"

# ---------------------------------------------------------------------------
# 5. Checks, on the tree that is about to ship.
#
# check-export-errors.sh is the one that would have caught the bundler-mangled
# `var mkField` -- a SyntaxError banner across all eight pages that changed no
# text and threw nothing the build could see. It exits with the number of bad
# pages, so `if !` is enough; under `set -e` a bare call would abort the script
# before this could name what went wrong. CI runs it continue-on-error; locally
# there is no reason to be that forgiving, so this aborts.
#
# dev/verify-pages.sh is NOT run here: it takes a base URL, not a folder, and
# needs the site served with functions live. It stays a step you run against a
# deploy preview or `netlify dev`.
# ---------------------------------------------------------------------------
step "Loading every built page in headless Chrome"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  if ! bash dev/check-export-errors.sh "$PUBSTAGE"; then
    die "at least one page throws on load -- see the red line(s) above.
  public/ is untouched. A SyntaxError here is usually the design tool's bundler
  mangling a lowerCamelCase declaration; see MANGLED_DECL in build-live-pages.js."
  fi
else
  echo "  SKIPPED: Google Chrome not installed. CI still runs this on push."
fi

step "Staging the Azure handler copy and asserting it matches netlify/"
node dev/build-azure-api.js
node dev/build-azure-api.js --check

# ---------------------------------------------------------------------------
# 6. Promote, and stamp the build.
#
# --delete is what makes public/ an exact mirror of the stage rather than an
# accumulation of every file that was ever there. netlify.toml makes publish an
# allow-list precisely because a stray file in the published directory is a
# served file; a stale page nobody removed is the same leak by a slower route.
#
# version.json exists so "is prod current?" is a glance at the live site instead
# of an investigation. The SHA is HEAD, i.e. the commit these pages were built
# FROM -- the commit that ships them is its child, so expect an off-by-one and
# read it as "built on top of".
# ---------------------------------------------------------------------------
step "Promoting to public/"
rsync -a --delete --exclude '.DS_Store' "$PUBSTAGE"/ public/

mkdir -p exports
cp "$STAGE/manifest.json" exports/manifest.json

SHA="$(git rev-parse --short HEAD)"
cat > public/version.json <<JSON
{
  "gitSha": "$SHA",
  "exportDate": "$DATE",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "  version.json      built on $SHA, export $DATE"
echo "  manifest.json     promoted from $STAGE"

step "Diff"
git status --short --untracked-files=all -- public exports/manifest.json
git diff --stat -- public exports/manifest.json | tail -20

# `git commit -a` stages tracked files only, so on the first release it would
# silently omit both new files -- and whats-live.sh would then report "no
# /version.json yet", which reads as normal. `-a` is also repo-wide: it would
# sweep an unrelated in-progress edit to the auth boundary into a commit labelled
# "Rebuild on the export" and push it to both hosts. Name the paths.
cat <<'EOF'

Nothing has been committed. Read the diff above, then:

    git add public exports/manifest.json
    git commit -m "Rebuild on the <date> export"
    git push          # deploys AZURE ONLY (.github/workflows/azure-*.yml)

Netlify is NOT git-connected -- `netlify api getSite` returns repo_url: null,
and it never has been. A push does nothing to it: it keeps serving its last CLI
upload perfectly, with no banner and no error, so the only symptom is that the
site is old. On 2026-08-03 it sat three commits behind while Azure was current
and /qa-management 404'd on it alone. Until a repository is linked, updating it
takes a CLI deploy, and the standing warning about that command is why the two
checks come first -- it uploads your WORKING TREE, not main:

    git status --short                      # must be empty
    git rev-parse --short HEAD origin/main  # must match
    netlify deploy --prod --dir public --functions netlify/functions

Then confirm BOTH hosts caught up -- do not assume the push was enough:

    bash dev/whats-live.sh
EOF
