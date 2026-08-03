#!/usr/bin/env bash
#
# What is actually deployed, on both hosts, versus what is in this repo?
#
#   bash dev/whats-live.sh
#
# Answers the question that used to require an investigation. dev/release.sh
# writes public/version.json with the commit it built from; both hosts serve it
# at /version.json. So a deployed site can be asked what it is.
#
# There is deliberately no build stamp rendered into the pages themselves. The
# eight pages are bundled output from the design tool, and every UI element this
# repo has ever added to them lives in the patch tables in build-live-pages.js --
# each one an exact-match assertion that a re-export can move or delete. Adding a
# ninth patch, on all eight pages, to display a string that a JSON file already
# serves would buy a glance at the cost of a thing that breaks on re-export. If
# the stamp ever does need to be visible, put it in dev/live-loader.js (already
# inlined into seven of the eight) rather than in a per-page patch -- and note
# that index.html takes no loader, so it would need its own.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

NETLIFY="https://dynamics2olh.netlify.app"
AZURE="https://jolly-mud-0ff2f8910.7.azurestaticapps.net"

HEAD_SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "repo"
printf '  %-14s %s (%s)\n' "HEAD" "$HEAD_SHA" "$BRANCH"
if [ -f public/version.json ]; then
  printf '  %-14s %s\n' "built from" \
    "$(node -e 'const v=require("./public/version.json");console.log(v.gitSha+"  export "+v.exportDate+"  built "+v.builtAt)')"
fi
if ! git diff --quiet -- public; then
  printf '  %-14s \033[33m%s\033[0m\n' "warning" "public/ has uncommitted changes"
fi
UNPUSHED="$(git log --oneline "origin/$BRANCH..$BRANCH" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${UNPUSHED:-0}" != "0" ]; then
  printf '  %-14s \033[33m%s commit(s) not pushed — neither host has them\033[0m\n' \
    "warning" "$UNPUSHED"
fi

probe() {
  local label="$1" base="$2"
  local body
  body="$(curl -fsS --max-time 15 "$base/version.json" 2>/dev/null)" || {
    printf '\n%s\n  \033[31munreachable, or no /version.json yet\033[0m\n' "$label"
    printf '  (expected until the first release.sh build is pushed)\n'
    return
  }
  local sha
  sha="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(v.gitSha||"?")}catch(e){console.log("?")}})')"
  printf '\n%s\n' "$label"
  printf '  %-14s %s\n' "serving" "$(printf '%s' "$body" | tr -d '\n ' )"
  if [ "$sha" = "$HEAD_SHA" ]; then
    printf '  %-14s \033[32mmatches HEAD\033[0m\n' "status"
  else
    printf '  %-14s \033[33mbuilt from %s, HEAD is %s\033[0m\n' "status" "$sha" "$HEAD_SHA"
    printf '  %-14s %s\n' "" "(one commit behind is normal: version.json records the"
    printf '  %-14s %s\n' "" " commit it was built ON TOP OF, not the commit that ships it)"
  fi
}

probe "netlify  $NETLIFY" "$NETLIFY"
probe "azure    $AZURE" "$AZURE"

echo
echo "Both hosts publish from main on push. If either is behind, the fix is"
echo "\`git push\` — not \`netlify deploy --prod\`, which would make them disagree."
