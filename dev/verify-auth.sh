#!/usr/bin/env bash
# Assert the auth boundary against a running server.
#
#   node dev/seed-admin.js … first, then:
#   bash dev/verify-auth.sh http://localhost:8899 '<set-password-token>' <email>
#
# Every data endpoint must refuse an anonymous caller. That is the whole point of
# the 2026-08 change, and it is the one thing most worth a test: a regression here
# is silent and looks exactly like a working site.
#
# Run sections 4-5 against a DISPOSABLE account, never a real one: this script
# sets a known password, so whatever account it touches has a compromised
# credential afterwards and should be deleted.
set -u

BASE="${1:-http://localhost:8899}"
TOKEN="${2:-}"
EMAIL="${3:-olh.verify.disposable@lennar.com}"
PASS='Verify-OLH-2026!x'

pass=0; fail=0
say() { printf '%-58s' "$1"; }
ok()  { printf '\033[32mPASS\033[0m %s\n' "${1:-}"; pass=$((pass+1)); }
no()  { printf '\033[31mFAIL\033[0m %s\n' "${1:-}"; fail=$((fail+1)); }

# code <method> <path> [data] [bearer]
code() {
  local m="$1" p="$2" d="${3:-}" b="${4:-}"
  local args=(-s -o /tmp/olh-verify-body -w '%{http_code}' -X "$m" "$BASE$p")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  [ -n "$b" ] && args+=(-H "Authorization: Bearer $b")
  curl "${args[@]}"
}
body() { cat /tmp/olh-verify-body; }

expect() { # expect <want> <method> <path> [data] [bearer] -- label
  local want="$1" m="$2" p="$3" d="${4:-}" b="${5:-}" label="${6:-$2 $3}"
  say "$label"
  local got; got=$(code "$m" "$p" "$d" "$b")
  if [ "$got" = "$want" ]; then ok "($got)"; else no "expected $want, got $got: $(body | head -c 160)"; fi
}

echo
echo "=== 1. Anonymous callers must be refused ==============================="
expect 401 GET  /api/jobs        '' '' 'GET /api/jobs           anonymous -> 401'
expect 401 GET  /api/walk-config '' '' 'GET /api/walk-config    anonymous -> 401'
expect 401 GET  /api/session     '' '' 'GET /api/session        anonymous -> 401'
expect 401 GET  /api/users       '' '' 'GET /api/users          anonymous -> 401'
expect 401 GET  /api/roles       '' '' 'GET /api/roles          anonymous -> 401'
expect 401 GET  '/api/audit?recordId=recAAAAAAAAAAAAAA' '' '' 'GET /api/audit          anonymous -> 401'
expect 401 POST /api/update-job  '{"recordId":"recAAAAAAAAAAAAAA","fields":{"QA Ready":true}}' '' \
       'POST /api/update-job    anonymous -> 401'
expect 401 POST /api/audit       '{"recordId":"recAAAAAAAAAAAAAA"}' '' 'POST /api/audit         anonymous -> 401'
expect 401 POST /api/invite      '{"userId":"recAAAAAAAAAAAAAA"}' '' 'POST /api/invite        anonymous -> 401'

echo
echo "=== 2. A forged or malformed token must be refused ====================="
expect 401 GET /api/jobs '' 'not-a-token'                'GET /api/jobs           garbage token -> 401'
expect 401 GET /api/jobs '' 'eyJ1IjoieCJ9.deadbeef'      'GET /api/jobs           bad signature -> 401'

echo
echo "=== 3. Enumeration resistance ========================================="
expect 400 POST /api/sign-in '{"email":"","password":""}' '' 'POST /api/sign-in       empty -> 400'
expect 200 POST /api/forgot-password '{"email":"nobody.here@lennar.com"}' '' \
       'POST /api/forgot-password unknown -> 200'

# forgot-password on a PENDING account must be a no-op. issueToken overwrites
# Invite Token Hash, so if this were not skipped an anonymous caller could void
# anybody's outstanding invite by naming their address. The set-password test in
# section 5 uses a token issued before this call and would fail if it were voided.
expect 200 POST /api/forgot-password "{\"email\":\"$EMAIL\"}" '' \
       'POST /api/forgot-password pending -> 200 no-op'

echo
echo "=== 4. Password policy is enforced server-side ========================"
# Sections 4-5 need $EMAIL to be a PENDING account, because section 5 consumes an
# invite token and then activates it. Running twice against the same account fails
# on the second pass: once activated, the forgot-password call above legitimately
# issues a reset token and voids the seeded invite. Delete the account and re-seed
# rather than loosening either behaviour.
PENDING=no
if [ -n "$TOKEN" ]; then
  code POST /api/sign-in "{\"email\":\"$EMAIL\",\"password\":\"probe-only-not-a-guess\"}" > /dev/null
  grep -q 'mustSetPassword' /tmp/olh-verify-body && PENDING=yes
fi

if [ -z "$TOKEN" ]; then
  echo "  (skipped: pass a set-password token as the 2nd argument)"
elif [ "$PENDING" = "no" ]; then
  echo "  (skipped: $EMAIL already has a password."
  echo "   Delete it from the Users table and re-run dev/seed-admin.js for a clean pass.)"
else
  expect 400 POST /api/set-password "{\"token\":\"$TOKEN\",\"password\":\"short\"}" '' \
         'too short                       -> 400'
  expect 400 POST /api/set-password "{\"token\":\"$TOKEN\",\"password\":\"alllowercase123!\"}" '' \
         'no uppercase                    -> 400'
  expect 400 POST /api/set-password "{\"token\":\"$TOKEN\",\"password\":\"NoSymbolsHere123\"}" '' \
         'no symbol                       -> 400'
  expect 404 POST /api/set-password '{"token":"bogus-token-value","password":"Verify-OLH-2026!x"}' '' \
         'bogus token                     -> 404'

  echo
  echo "=== 5. The happy path ================================================="
  say 'set-password consumes the token'
  c=$(code POST /api/set-password "{\"token\":\"$TOKEN\",\"password\":\"$PASS\"}")
  if [ "$c" = "200" ]; then ok; else no "got $c: $(body | head -c 200)"; fi
  SESSION=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/olh-verify-body","utf8"));process.stdout.write(d.token||"")}catch(e){}')

  expect 404 POST /api/set-password "{\"token\":\"$TOKEN\",\"password\":\"$PASS\"}" '' \
         'same token is single use        -> 404'

  say 'sign-in with the new password'
  c=$(code POST /api/sign-in "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
  if [ "$c" = "200" ]; then ok; else no "got $c: $(body | head -c 200)"; fi
  cp /tmp/olh-verify-body /tmp/olh-verify-session
  SESSION=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/olh-verify-body","utf8"));process.stdout.write(d.token||"")}catch(e){}')

  if [ -n "$SESSION" ]; then
    expect 200 GET /api/session     '' "$SESSION" 'GET /api/session        signed in -> 200'
    expect 200 GET /api/roles       '' "$SESSION" 'GET /api/roles          signed in -> 200'
    expect 200 GET /api/users       '' "$SESSION" 'GET /api/users          admin     -> 200'
    expect 200 GET /api/jobs        '' "$SESSION" 'GET /api/jobs           signed in -> 200'
    expect 200 GET /api/walk-config '' "$SESSION" 'GET /api/walk-config    signed in -> 200'

    # Re-fetch: /tmp/olh-verify-body holds whatever the LAST request returned,
    # and reading it after the walk-config check counted zero jobs.
    say 'GET /api/jobs returns real homesites, not the 900 fixture'
    code GET /api/jobs '' "$SESSION" > /dev/null
    n=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/olh-verify-body","utf8"));process.stdout.write(String((d.jobs||[]).length))}catch(e){process.stdout.write("0")}')
    if [ "$n" != "900" ] && [ "$n" -gt 100 ] 2>/dev/null; then ok "($n real jobs)"; else no "got $n jobs"; fi

    expect 404 DELETE /api/users/recAAAAAAAAAAAAAA '' "$SESSION" \
           'DELETE unknown user     admin     -> 404'

    # The self-protection rules. Locking yourself out of the console that is the
    # only way back in is not a recoverable mistake, so the server refuses.
    ME=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/olh-verify-session","utf8"));process.stdout.write(d.user.id)}catch(e){}')
    if [ -n "$ME" ]; then
      expect 403 PATCH "/api/users/$ME" '{"role":"cm"}'      "$SESSION" 'cannot change your own role       -> 403'
      expect 403 PATCH "/api/users/$ME" '{"active":false}'   "$SESSION" 'cannot suspend your own account   -> 403'
      expect 403 DELETE "/api/users/$ME" ''                  "$SESSION" 'cannot delete your own account    -> 403'
    fi

    # Now that the account is activated, the two wrong-credential cases must be
    # indistinguishable. (A PENDING account deliberately answers 409
    # mustSetPassword instead -- see the note in auth.js signIn.)
    say 'unknown email and wrong password give one answer'
    u=$(code POST /api/sign-in '{"email":"nobody.here@lennar.com","password":"whatever-123!X"}'); ub=$(body)
    w=$(code POST /api/sign-in "{\"email\":\"$EMAIL\",\"password\":\"definitely-wrong-1!X\"}"); wb=$(body)
    if [ "$u" = "$w" ] && [ "$ub" = "$wb" ]; then ok "(both $u, identical body)"; else
      no "unknown=$u $(echo "$ub" | head -c 70) / wrong=$w $(echo "$wb" | head -c 70)"; fi

    say 'audit write is attributed to the session, not the body'
    c=$(code POST /api/audit '{"recordId":"recAAAAAAAAAAAAAA","field":"QA Ready","label":"QA Ready","from":"","to":"true","by":"Somebody Else","byId":"recFORGED0000000"}' "$SESSION")
    who=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/olh-verify-body","utf8"));process.stdout.write((d.entry&&d.entry.by)||"")}catch(e){}')
    if [ "$c" = "201" ] && [ "$who" != "Somebody Else" ] && [ -n "$who" ]; then
      ok "(recorded as \"$who\")"
    else no "status $c, attributed to \"$who\""; fi
  else
    no 'no session token returned; skipping authenticated checks'
  fi
fi

echo
echo "======================================================================="
printf 'passed %d, failed %d\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
