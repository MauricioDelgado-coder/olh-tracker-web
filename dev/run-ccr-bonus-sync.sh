#!/bin/bash
# Daily refresh: pull CCR bonus metrics from Salesforce (Cases_Closed_Last_Month2's
# filters, replicated via direct SOQL) and push them into the Airtable
# "CCR Bonus SF Source" table that bonus.html reads to pre-fill a CCR's monthly
# bonus form.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.ccr-bonus-sync.plist) daily, and
# safe to run by hand:
#
#   bash dev/run-ccr-bonus-sync.sh
#
# Mirrors dev/run-daily-sync.sh's PAT-reading logic exactly (Keychain first,
# same fallbacks) so there is one convention for "how does an unattended OLH
# script get its Airtable token" rather than two slightly different ones.
set -uo pipefail

REPO="$HOME/olh-tracker-web"
LOG_DIR="$HOME/.ccr_bonus_sync"
LOG="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== CCR bonus SF sync starting ==="

KEYCHAIN_SERVICE="${OLH_PAT_KEYCHAIN_SERVICE:-olh-tracker-airtable-pat}"
SWA_NAME="${OLH_SWA_NAME:-webtracker}"
SWA_RESOURCE_GROUP="${OLH_SWA_RESOURCE_GROUP:-webtracker_group}"

read_pat() {
  local pat=''

  if [ -n "${AIRTABLE_PAT:-}" ]; then
    printf 'the environment\t%s' "$AIRTABLE_PAT"
    return 0
  fi

  pat="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"
  if [ -n "$pat" ]; then
    printf 'the Keychain (%s)\t%s' "$KEYCHAIN_SERVICE" "$pat"
    return 0
  fi

  if command -v az >/dev/null 2>&1; then
    pat="$(az staticwebapp appsettings list \
            --name "$SWA_NAME" \
            --resource-group "$SWA_RESOURCE_GROUP" \
            --query "properties.AIRTABLE_PAT" -o tsv 2>/dev/null \
          | grep -o 'pat[A-Za-z0-9._]*' | head -1)"
    if [ -n "$pat" ]; then
      printf 'Azure Static Web Apps (%s)\t%s' "$SWA_NAME" "$pat"
      return 0
    fi
  fi

  if command -v netlify >/dev/null 2>&1; then
    pat="$(netlify env:get AIRTABLE_PAT 2>/dev/null | grep -o 'pat[A-Za-z0-9._]*' | head -1)"
    if [ -n "$pat" ]; then
      printf 'Netlify (legacy)\t%s' "$pat"
      return 0
    fi
  fi

  return 1
}

PAT_RAW="$(read_pat)"
PAT_SOURCE="${PAT_RAW%%$'\t'*}"
PAT="${PAT_RAW#*$'\t'}"
if [ "$PAT" = "$PAT_SOURCE" ]; then PAT=''; PAT_SOURCE=''; fi
if [ -z "$PAT" ]; then
  say "FAILED: could not read AIRTABLE_PAT from any source."
  say "        Tried: \$AIRTABLE_PAT, Keychain ($KEYCHAIN_SERVICE), az staticwebapp, netlify env:get."
  exit 1
fi
say "read AIRTABLE_PAT from $PAT_SOURCE"

cd "$REPO" || { say "FAILED: no repo at $REPO"; exit 1; }

if AIRTABLE_PAT="$PAT" python3 dev/sync_ccr_bonus_source.py >> "$LOG" 2>&1; then
  say "=== done ==="
  exit 0
fi

status=$?
say "=== FAILED (exit $status) -- bonus.html's Salesforce pre-fill is still showing the previous pull ==="
say "    Read the lines above. A verification failure usually means the sf CLI session"
say "    expired, or the ccr-monthly-bonus skill's roster.json/build_ccr_bonus.py moved."
exit "$status"
