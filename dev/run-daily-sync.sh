#!/bin/bash
# Daily refresh: pull the no-Actual-COE report from Salesforce and push it into
# the Airtable Jobs table the tracker reads.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.coe-sync.plist) each weekday
# morning, and safe to run by hand:
#
#   bash dev/run-daily-sync.sh
#
# The Airtable token is read at run time rather than stored in this file or in
# the launchd plist, so there is no second copy of the secret to leak or rotate.
#
# It used to come from `netlify env:get`, which quietly coupled the daily data
# pipeline to the hosting vendor: the sync writes to Airtable and has nothing to
# do with Netlify, but pointing the site at Azure — or deleting the Netlify site
# afterwards — would have stopped the 06:15 pull with a "could not read
# AIRTABLE_PAT" the tracker gives no sign of. It keeps serving yesterday's data
# and looks fine, which is the failure this script's logging exists to catch.
#
# read_pat() now prefers the macOS Keychain, which belongs to this machine and
# survives any hosting change, and falls back to whichever host is configured.
#

# Seed the Keychain once (the token is not echoed, and not stored in shell
# history if you let it prompt):
#
#   security add-generic-password -a "$USER" -s olh-tracker-airtable-pat -w
#

# Everything is appended to a log, because an unattended job that fails silently
# is worse than one that does not run: the tracker keeps showing yesterday's data
# and looks fine.
set -uo pipefail

REPO="$HOME/olh-tracker-web"
OUT="$HOME/Downloads/production 2"
LOG_DIR="$HOME/.homesite_coe_report"
LOG="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"

# launchd starts with a minimal PATH; node, sf and netlify all live in places it
# does not know about.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== daily COE sync starting ==="

# Keychain service name, and the Azure resource the site is deployed to. Both are
# overridable from the environment so a second division or a staging site does
# not need a forked copy of this script.
KEYCHAIN_SERVICE="${OLH_PAT_KEYCHAIN_SERVICE:-olh-tracker-airtable-pat}"
# Match the resource actually created on 2026-08-03. These defaults are only used
# by the az fallback in read_pat(); the Keychain path above does not care.
SWA_NAME="${OLH_SWA_NAME:-webtracker}"
SWA_RESOURCE_GROUP="${OLH_SWA_RESOURCE_GROUP:-webtracker_group}"

# Four sources, most-local first. Each is only tried if the previous found
# nothing, and the source that won is logged -- a sync that silently switched to
# a stale copy of the token is a debugging session nobody enjoys.
#
# Emits "source<TAB>token" on one line rather than setting a global, because
# `PAT="$(read_pat)"` runs the function in a SUBSHELL: any variable it assigned
# would be discarded, and the log line would name no source at all. That is
# exactly what the first version of this did.
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
# Guard the no-tab case: parameter expansion leaves both halves equal to the
# whole string, so an unexpected single-field result must not become the token.
if [ "$PAT" = "$PAT_SOURCE" ]; then PAT=''; PAT_SOURCE=''; fi
if [ -z "$PAT" ]; then
  say "FAILED: could not read AIRTABLE_PAT from any source."
  say "        Tried: \$AIRTABLE_PAT, Keychain ($KEYCHAIN_SERVICE), az staticwebapp, netlify env:get."
  say "        Seed the Keychain, which does not depend on a hosting vendor:"
  say "          security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w"
  say "        Or check the host CLI is still logged in: az account show / netlify status"
  exit 1
fi
say "read AIRTABLE_PAT from $PAT_SOURCE"

cd "$REPO" || { say "FAILED: no repo at $REPO"; exit 1; }

# run_report.py refuses to hand over a workbook that fails its own verification,
# and the sync refuses to run on one. That chain is deliberate: a day when
# Salesforce changes shape should stop here, not propagate 1400 wrong rows.
if AIRTABLE_PAT="$PAT" python3 dev/sync_coe_to_airtable.py --out "$OUT" >> "$LOG" 2>&1; then
  say "=== done ==="
  exit 0
fi

status=$?
say "=== FAILED (exit $status) -- the tracker is still showing the previous pull ==="
say "    Read the lines above. A verification failure usually means the upstream"
say "    data changed shape, not that the script is broken."
exit "$status"
