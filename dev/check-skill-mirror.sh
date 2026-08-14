#!/usr/bin/env bash
#
# Warns when dev/sync_coe_to_airtable.py has changed since it was last
# uploaded to the olh-airtable-sync skill on Claude.ai.
#
# There is no API that reaches Claude.ai's skill storage from this machine --
# the re-upload has to happen by hand in the skill's UI. This script cannot
# do that step for you. What it CAN do is refuse to let a changed sync script
# go unnoticed: it compares the current file's hash against the hash recorded
# the last time you told it "I re-uploaded", and fails loudly if they differ.
#
#   bash dev/check-skill-mirror.sh          # check only
#   bash dev/check-skill-mirror.sh --mark   # I just re-uploaded; record it
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

SCRIPT="dev/sync_coe_to_airtable.py"
HASHFILE="dev/.skill-sync-hash"

CURRENT="$(shasum -a 256 "$SCRIPT" | awk '{print $1}')"

if [ "${1:-}" = "--mark" ]; then
  {
    echo "$CURRENT  $SCRIPT"
    echo "# ^ sha256 of the sync_coe_to_airtable.py version last uploaded to the"
    echo "# olh-airtable-sync skill (scripts/sync_coe_to_airtable.py) on Claude.ai."
    echo "# Update this after every re-upload: shasum -a 256 dev/sync_coe_to_airtable.py"
    echo "# Checked by dev/check-skill-mirror.sh"
  } > "$HASHFILE"
  echo "Recorded $CURRENT as the mirrored hash. Only run --mark AFTER you've"
  echo "actually re-uploaded scripts/sync_coe_to_airtable.py to the skill."
  exit 0
fi

RECORDED="$(head -1 "$HASHFILE" | awk '{print $1}')"

if [ "$CURRENT" != "$RECORDED" ]; then
  echo ""
  echo "!!  dev/sync_coe_to_airtable.py has changed since the skill was last updated."
  echo "    recorded: $RECORDED"
  echo "    current:  $CURRENT"
  echo ""
  echo "    Upload the current $SCRIPT to the olh-airtable-sync skill's"
  echo "    scripts/sync_coe_to_airtable.py on Claude.ai, then run:"
  echo "      bash dev/check-skill-mirror.sh --mark"
  echo ""
  exit 1
fi

echo "OK -- skill mirror matches dev/sync_coe_to_airtable.py ($CURRENT)"
