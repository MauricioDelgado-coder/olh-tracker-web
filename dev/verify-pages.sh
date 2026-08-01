#!/usr/bin/env bash
# Load each built page in headless Chrome and assert the SIGNED-OUT contract.
#
#   bash dev/verify-pages.sh [base-url]
#
# What changed in 2026-08, and why this file shrank:
#
# This script used to load every page anonymously and assert that live homesite
# data rendered. That assertion is now the opposite of correct -- /api/jobs and
# /api/walk-config require a session, so an anonymous page MUST show no data. The
# old checks were left failing for a while and every one of those failures was the
# auth boundary working, which is exactly the kind of test that teaches people to
# ignore red output. They are gone.
#
# What is asserted here now:
#   - no page leaks the demo fixture, in any state
#   - an anonymous visitor gets a sign-in gate, not data
#   - a page that cannot load data says so instead of showing a stale sample
#
# What is NOT asserted here: rendering WITH data. Preseeding a session into
# localStorage from the CLI would mean serving a bootstrap page that mints a
# session from a URL parameter, which is an auth bypass sitting in public/ -- not
# worth it for test convenience. The data path is covered at the API level by
# dev/verify-auth.sh (which asserts real homesite counts), and signed-in rendering
# is a manual pass. That gap is real; it is written down rather than papered over.
#
# --dump-dom includes <script> bodies, so grepping the raw dump matches the
# inlined loader's own source (e.g. the string "Live data unavailable") and every
# assertion becomes a tautology. Everything below runs against script-stripped
# text instead.
set -uo pipefail

BASE="${1:-http://localhost:8899}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
FAILED=0
trap 'rm -rf "$TMP"' EXIT

dumpraw () {
  "$CHROME" --headless=new --disable-gpu --no-sandbox --dump-dom \
    --virtual-time-budget=8000 --run-all-compositor-stages-before-draw \
    "$BASE$1" 2>/dev/null
}

visible_from () {
  python3 -c '
import sys, re, html
s = sys.stdin.read()
s = re.sub(r"(?is)<script.*?</script>", " ", s)
s = re.sub(r"(?is)<style.*?</style>", " ", s)
s = re.sub(r"(?is)<!--.*?-->", " ", s)
s = re.sub(r"(?s)<[^>]+>", " ", s)
print(re.sub(r"[ \t\r\f\v]+", " ", html.unescape(s)))
' < "$1"
}

check () { # check <label> <file> <pattern> <expect-present:1|0>
  local label="$1" file="$2" pat="$3" want="$4" got
  if grep -qiE "$pat" "$file"; then got=1; else got=0; fi
  if [ "$got" = "$want" ]; then
    printf '   ok    %s\n' "$label"
  else
    printf '   FAIL  %s  (wanted present=%s, got %s)\n' "$label" "$want" "$got"
    FAILED=$((FAILED+1))
  fi
}

# The fixture's own label. Matching a bare "900 homesites" was a false positive:
# the completion report legitimately renders "Showing 200 of 900 homesites" from
# the REAL division snapshot, which happens to cover 900 homesites.
FIXTURE_LABEL='Dynamics Export.{0,6}900 homesites'

for page in index tracker completion scheduler workload workload-visualizer walk-calendar admin; do
  route="/$page"
  [ "$page" = index ] && route="/"
  echo ""
  echo "=== $page ($route) ==="
  f="$TMP/$page.txt"
  raw="$TMP/$page.dom"
  dumpraw "$route" > "$raw"
  visible_from "$raw" > "$f"
  echo "   visible chars: $(wc -c < "$f" | tr -d ' ')"

  # 1. No synthetic record may reach the screen, signed in or out.
  check "no recJOB fixture ids"   "$f" 'recJOB[0-9]{6}'   0
  check "no recCM fixture ids"    "$f" 'recCM[0-9]{6}'    0
  check "no fixture label"        "$f" "$FIXTURE_LABEL"   0
  check "no 'sample records' promise" "$f" 'Showing sample records' 0
  # An empty page must not label itself as showing sample data. The tracker's
  # status line fell through to "Sample data · —" once the fixture was removed.
  #
  # The middot is load bearing. Matching a bare "sample data" also matched the
  # tracker's own replacement message -- "this page does not fall back to sample
  # data" -- so the check failed on the very sentence that fixed the problem.
  # Only the "Sample data · <when>" status-line form is wrong.
  check "does not claim sample data"  "$f" 'Sample data[[:space:]]*·' 0

  # 2. Anonymous means no data. The loader stamps its outcome on <body>; on the
  #    wired pages it must report the refusal rather than a successful load.
  case "$page" in
    scheduler|workload|workload-visualizer|walk-calendar|admin)
      src=$(grep -o 'data-olh-source="[a-z]*"' "$raw" | head -1 | sed 's/.*="\(.*\)"/\1/')
      njobs=$(grep -o 'data-olh-jobs="[0-9]*"' "$raw" | head -1 | sed 's/.*="\(.*\)"/\1/')
      if [ "$src" = "error" ] && [ "${njobs:-0}" = "0" ]; then
        printf '   ok    anonymous load refused (source=%s jobs=%s)\n' "$src" "${njobs:-0}"
      else
        printf '   FAIL  anonymous load returned data: source=%s jobs=%s (wanted error/0)\n' \
               "${src:-none}" "${njobs:-none}"
        FAILED=$((FAILED+1))
      fi
      check "says data is unavailable" "$f" 'Live data unavailable' 1
      check "names the reason"         "$f" 'Not signed in'         1
      ;;
  esac

  # 3. The sign-in gate. index is the landing page and gates on navigation
  #    rather than on load, so it is exempt; completion reads a real bundled
  #    snapshot and has no API dependency to gate.
  case "$page" in
    tracker|scheduler|workload|workload-visualizer|walk-calendar|admin)
      check "sign-in gate shown" "$f" 'Sign In to Continue|Lennar Email' 1
      ;;
  esac
done

echo ""
if [ "$FAILED" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILED CHECK(S) FAILED"; fi
exit "$FAILED"
