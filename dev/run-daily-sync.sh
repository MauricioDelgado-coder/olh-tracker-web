#!/bin/bash
# Daily refresh: pull the no-Actual-COE report from Salesforce and push it into
# the Airtable Jobs table the tracker reads.
#
# Run by launchd (~/Library/LaunchAgents/com.olh.coe-sync.plist) each weekday
# morning, and safe to run by hand:
#
#   bash dev/run-daily-sync.sh
#
# The Airtable token is read from Netlify at run time rather than stored in this
# file or in the launchd plist. The Netlify CLI is already authenticated on this
# Mac, so there is no second copy of the secret to leak or to rotate.
#
# Everything is appended to a log, because an unattended job that fails silently
# is worse than one that does not run: the tracker keeps showing yesterday's data
# and looks fine.
set -uo pipefail

REPO="$HOME/Documents/Claude/olh-tracker-web"
OUT="$HOME/Downloads/production 2"
LOG_DIR="$HOME/.homesite_coe_report"
LOG="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"

# launchd starts with a minimal PATH; node, sf and netlify all live in places it
# does not know about.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== daily COE sync starting ==="

PAT="$(netlify env:get AIRTABLE_PAT 2>/dev/null | grep -o 'pat[A-Za-z0-9._]*' | head -1)"
if [ -z "$PAT" ]; then
  say "FAILED: could not read AIRTABLE_PAT from Netlify. Is the CLI still logged in?"
  say "        try: netlify status"
  exit 1
fi

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
