#!/bin/bash
# SANDBOX VARIANT of run-daily-sync.sh -- pulls SAN (San Antonio) from
# Salesforce and pushes it into Jobs (Sandbox - SAN) / tbltB2CIKBumT6sMK only.
#
# Deliberately its own script, own log, own launchd job, own lock file prefix
# (sync-sandbox-SAN.lock, set inside sync_coe_to_airtable_sandbox_san.py) --
# kept fully separate from the live OLH sync per Mauricio's request, so that
# the SAN sandbox can be started, stopped, or broken without ever touching the
# OLH pipeline, and vice versa. When SAN graduates out of the sandbox, retire
# this file and job rather than merging it into run-daily-sync.sh -- folding
# a sandbox schedule into the production one is exactly the kind of merge that
# should wait until the sandbox has actually been promoted.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.coe-sync-sandbox-san.plist),
# and safe to run by hand:
#
#   bash dev/run-daily-sync-sandbox-san.sh
#
# Same AIRTABLE_PAT as the live sync (it is the same Airtable base, just a
# different table), read the same way: environment, then macOS Keychain, then
# Azure Static Web Apps, then Netlify (legacy). See run-daily-sync.sh for why
# that order and why the Keychain is preferred.
set -uo pipefail

REPO="$HOME/olh-tracker-web"
OUT="$HOME/Downloads/production-sandbox-san"
LOG_DIR="$HOME/.homesite_coe_report"
LOG="$LOG_DIR/sync-sandbox-san.log"

mkdir -p "$LOG_DIR" "$OUT"

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== SAN sandbox sync starting ==="

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

if AIRTABLE_PAT="$PAT" python3 dev/sync_coe_to_airtable_sandbox_san.py --out "$OUT" --division SAN >> "$LOG" 2>&1; then
  say "=== done ==="
  exit 0
fi

status=$?
say "=== FAILED (exit $status) -- Jobs (Sandbox - SAN) is still showing the previous pull ==="
say "    Read the lines above. A verification failure usually means the upstream"
say "    data changed shape, not that the script is broken."
exit "$status"
