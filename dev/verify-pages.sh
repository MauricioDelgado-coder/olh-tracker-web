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
  #
  #    completion joined this list in 08/2026. It used to carry a real bundled
  #    snapshot and no API dependency, so it had nothing to refuse; the export
  #    made window.OLH_DATA the single source for the whole suite, the build now
  #    strips that snapshot like every other page, and the Completion Report
  #    reads /api/jobs through the same loader. So it must refuse anonymously
  #    too -- and if it ever stops refusing, that is 1,000 real homesites and
  #    their buyers' closing dates on an unauthenticated screen.
  case "$page" in
    completion|scheduler|workload|workload-visualizer|walk-calendar|admin)
      src=$(grep -o 'data-olh-source="[a-z]*"' "$raw" | head -1 | sed 's/.*="\(.*\)"/\1/')

      # These documents are ~1 MB and the loader has to finish a round trip
      # inside the virtual-time budget. walk-calendar, the largest, misses it
      # occasionally over the network -- the attribute is simply absent rather
      # than wrong. Re-dump once with a longer budget before believing it: a
      # check that goes red at random is one people learn to skim past, which
      # costs more than the seconds this takes. A real failure fails twice.
      if [ -z "$src" ]; then
        "$CHROME" --headless=new --disable-gpu --no-sandbox --dump-dom \
          --virtual-time-budget=20000 --run-all-compositor-stages-before-draw \
          "$BASE$route" 2>/dev/null > "$raw"
        visible_from "$raw" > "$f"
        src=$(grep -o 'data-olh-source="[a-z]*"' "$raw" | head -1 | sed 's/.*="\(.*\)"/\1/')
        [ -n "$src" ] && printf '   note  re-dumped at 20s (first pass had not marked <body>)\n'
      fi

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
  #    rather than on load, so it is the only exemption left -- completion used
  #    to be the other one, back when it had a bundled snapshot to show.
  case "$page" in
    tracker|completion|scheduler|workload|workload-visualizer|walk-calendar|admin)
      check "sign-in gate shown" "$f" 'Sign In to Continue|Lennar Email' 1
      ;;
  esac

  # 4. No uncaught exception.
  #
  # Added 08/2026 after a page shipped every check above green while throwing
  # "undefined is not an object (evaluating 'window.OLHAuth.authHeaders')" into
  # its own error toast on load. Everything asserted so far is about what the
  # DOM says, and a page can render a perfectly correct sign-in gate while its
  # data path is dead -- the tracker did. A thrown TypeError is never an
  # expected state, signed in or out.
  #
  # 401s are NOT failures here: an anonymous visitor getting refused by
  # /api/jobs is the boundary working, and section 2 asserts it.
  probe="$TMP/$page.console"
  node "$(dirname "$0")/console-probe.js" "$BASE$route" 6000 > "$probe" 2>&1 || true
  if grep -q '^  EXCEPTION' "$probe"; then
    printf '   FAIL  uncaught exception on load\n'
    sed -n 's/^  \(EXCEPTION.*\)/           \1/p' "$probe" | head -3
    FAILED=$((FAILED+1))
  else
    printf '   ok    no uncaught exception\n'
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILED CHECK(S) FAILED"; fi
exit "$FAILED"
