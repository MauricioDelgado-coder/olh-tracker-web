#!/usr/bin/env bash
#
# Warns when the files backing the olh-airtable-sync skill on Claude.ai --
# scripts/sync_coe_to_airtable.py AND references/field-mapping.md -- have
# changed here since they were last uploaded there.
#
# There is no API that reaches Claude.ai's skill storage from this machine --
# the re-upload has to happen by hand in the skill's UI. This script cannot
# do that step for you. What it CAN do is refuse to let a changed file go
# unnoticed: it compares each current file's hash against the hash recorded
# the last time you told it "I re-uploaded", and fails loudly if they differ.
#
#   bash dev/check-skill-mirror.sh          # check only
#   bash dev/check-skill-mirror.sh --mark   # I just re-uploaded both; record it
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

# path -> label shown in output. Add a line here if the skill ever grows a
# third file worth tracking (e.g. SKILL.md itself).
FILES=(
  "dev/sync_coe_to_airtable.py|scripts/sync_coe_to_airtable.py"
  "docs/skills/olh-airtable-sync-field-mapping.md|references/field-mapping.md"
)
HASHFILE="dev/.skill-sync-hash"

if [ "${1:-}" = "--mark" ]; then
  {
    echo "# sha256 of each file's version last uploaded to the olh-airtable-sync"
    echo "# skill on Claude.ai. Update after every re-upload by re-running:"
    echo "#   bash dev/check-skill-mirror.sh --mark"
    echo "# Checked by dev/check-skill-mirror.sh"
    for entry in "${FILES[@]}"; do
      local_path="${entry%%|*}"
      skill_path="${entry##*|}"
      hash="$(shasum -a 256 "$local_path" | awk '{print $1}')"
      echo "$hash  $local_path  (-> skill's $skill_path)"
    done
  } > "$HASHFILE"
  echo "Recorded current hashes for: ${FILES[*]#*|}"
  echo "Only run --mark AFTER you've actually re-uploaded BOTH files to the skill."
  exit 0
fi

if [ ! -f "$HASHFILE" ]; then
  echo "No recorded hashes yet ($HASHFILE missing). Upload both files to the"
  echo "skill, then run: bash dev/check-skill-mirror.sh --mark"
  exit 1
fi

fail=0
for entry in "${FILES[@]}"; do
  local_path="${entry%%|*}"
  skill_path="${entry##*|}"
  current="$(shasum -a 256 "$local_path" | awk '{print $1}')"
  recorded="$(grep -F "  $local_path  " "$HASHFILE" | awk '{print $1}' || true)"
  if [ -z "$recorded" ]; then
    echo "!!  $local_path has no recorded hash yet -- was it added after the last --mark?"
    fail=1
  elif [ "$current" != "$recorded" ]; then
    echo "!!  $local_path has changed since the skill was last updated."
    echo "    recorded: $recorded"
    echo "    current:  $current"
    echo "    Upload it to the skill's $skill_path on Claude.ai."
    fail=1
  else
    echo "OK -- $local_path matches the skill's $skill_path ($current)"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "After uploading everything above, run: bash dev/check-skill-mirror.sh --mark"
  exit 1
fi
