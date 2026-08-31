#!/bin/bash
# Weekly refresh: pull QA Manager bonus metrics (walk completions + 30-day
# quality rate) from Salesforce and push them into the Airtable QA Bonus
# Source table qa-bonus.html's pre-fill reads.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.qabonus-sync.plist) every
# Monday morning, and safe to run by hand:
#
#   bash dev/run-weekly-qabonus-sync.sh
#
# Mirrors dev/run-daily-sync.sh's PAT-resolution chain exactly (Keychain
# first, then Azure/Netlify env as fallback) -- see that script's header for
# the full reasoning. Duplicated rather than shared because the two scripts
# call different Python entry points and this one only needs the Keychain
# path in practice; if the fallback chain ever needs a real change, change
# both.
set -uo pipefail

REPO="$HOME/olh-tracker-web"
LOG_DIR="$HOME/.qa_bonus_sync"
LOG="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== weekly QA bonus sync starting ==="

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

  return 1
}

PAT_RAW="$(read_pat)"
PAT_SOURCE="${PAT_RAW%%$'\t'*}"
PAT="${PAT_RAW#*$'\t'}"
if [ "$PAT" = "$PAT_SOURCE" ]; then PAT=''; PAT_SOURCE=''; fi
if [ -z "$PAT" ]; then
  say "FAILED: could not read AIRTABLE_PAT from any source."
  say "        Tried: \$AIRTABLE_PAT, Keychain ($KEYCHAIN_SERVICE), az staticwebapp."
  say "        Seed the Keychain: security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w"
  exit 1
fi
say "read AIRTABLE_PAT from $PAT_SOURCE"

cd "$REPO" || { say "FAILED: no repo at $REPO"; exit 1; }

# No --month: syncs both the current month-to-date and the prior full month
# every run, same convention as the CCR bonus sync. A QAM can see this
# week's progress mid-month, and last month's numbers stay current until
# everyone has submitted.
if AIRTABLE_PAT="$PAT" python3 dev/sync_qa_bonus_source.py >> "$LOG" 2>&1; then
  say "=== done ==="
  exit 0
fi

status=$?
say "=== FAILED (exit $status) -- qa-bonus.html falls back to manual entry until the next run ==="
say "    Read the lines above. A verification failure usually means the upstream data changed shape."
exit "$status"
