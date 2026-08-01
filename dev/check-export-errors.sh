#!/usr/bin/env bash
# Load every page of an export in headless Chrome and report uncaught JS errors.
#
#   bash dev/check-export-errors.sh <folder-of-html>
#
# Run this on a RAW export before building. A page that throws on load is a
# design-tool bug, not a build bug, and knowing which side it came from saves
# hours of chasing a patch that was never the cause.
set -u

DIR="${1:?usage: check-export-errors.sh <folder>}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bad=0

for f in "$DIR"/*.html; do
  name=$(basename "$f" .html)
  printf '%-26s' "$name"
  err=$("$CHROME" --headless=new --disable-gpu --no-sandbox --dump-dom \
        --virtual-time-budget=5000 "file://$f" 2>/dev/null \
        | grep -o 'Uncaught [A-Za-z]*Error[^<]\{0,90\}' | head -1)
  if [ -n "$err" ]; then
    printf '\033[31m%s\033[0m\n' "$err"
    bad=$((bad+1))
  else
    printf '\033[32mno uncaught errors\033[0m\n'
  fi
done

echo
if [ "$bad" -eq 0 ]; then echo "all pages loaded clean"; else echo "$bad page(s) throw on load"; fi
exit "$bad"
