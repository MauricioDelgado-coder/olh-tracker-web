#!/bin/bash
# Unattended interval runner for dev/run-background-rebalance.js.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.background-rebalance.plist)
# every 15 minutes, weekdays. The script itself gates on a 7am-7pm weekday
# window so launchd's schedule can stay a flat interval. Safe to run by hand:
#
#   bash dev/run-background-rebalance.sh            (dry run)
#   bash dev/run-background-rebalance.sh --apply    (writes to Airtable)
#
# Same Keychain-first PAT pattern as run-daily-sync.sh, for the same reason:
# the token belongs to this machine, not to whichever hosting vendor happens
# to be configured this month.
set -uo pipefail

REPO="$HOME/olh-tracker-web"
LOG_DIR="$HOME/.homesite_coe_report"
LOG="$LOG_DIR/background-rebalance.log"
KEYCHAIN_SERVICE="${OLH_PAT_KEYCHAIN_SERVICE:-olh-tracker-airtable-pat}"

mkdir -p "$LOG_DIR"

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

PAT="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"
if [ -z "$PAT" ]; then
  say "FAILED: could not read AIRTABLE_PAT from the Keychain ($KEYCHAIN_SERVICE)."
  say "        Seed it: security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w"
  exit 1
fi

cd "$REPO" || { say "FAILED: no repo at $REPO"; exit 1; }

if AIRTABLE_PAT="$PAT" node dev/run-background-rebalance.js "$@" >> "$LOG" 2>&1; then
  exit 0
fi

status=$?
say "=== run-background-rebalance.js exited $status ==="
exit "$status"
