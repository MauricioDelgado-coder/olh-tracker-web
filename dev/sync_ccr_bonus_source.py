#!/usr/bin/env python3
"""
Sync Salesforce-sourced CCR bonus metrics into the "CCR Bonus SF Source"
Airtable table (base appYX9df4lGO6G2uz, tbl8eMWVp2Dx1YcDg).

    python3 dev/sync_ccr_bonus_source.py [--month YYYY-MM] [--dry-run]

Replicates Salesforce report "#Cases Closed Last Month" (OLH Customer Care
folder, DeveloperName Cases_Closed_Last_Month2) via direct SOQL against Case
and Homesite__c -- the report itself is Summary format and the Analytics REST
API caps synchronous report runs at 2,000 rows, but this dataset runs ~7,000+
rows, so the report can never be pulled through the report-run API. See
~/.claude/skills/ccr-monthly-bonus/references/salesforce.md for the full
rationale, exact filter values, and CLI gotchas -- this script borrows that
skill's query-building and SF-CLI helper functions directly (imported, not
copy-pasted) so the two can never drift on what "closed case" or "aged case"
means.

Unlike the ccr-monthly-bonus skill's xlsx build (which always targets the
prior calendar month), this sync writes BOTH the current month-to-date AND
the prior full month on every run, by default -- see MONTHS_TO_SYNC. A CCR
choosing "this month" mid-month should see their pace so far, not nothing;
the OLH Suite side (bonus.html) always lets them override with their own
number regardless of what Salesforce shows.

One row per (Associate Email, Bonus Month), upserted every run: existing rows
are updated in place, never duplicated, matched by a "<email>|<month>" Key.
This never touches CCR Bonus Submissions -- that table only gets written when
a CCR actually clicks Submit (see submit-bonus.js), and a snapshot of these
numbers is copied onto the submission at that moment specifically so a later
resync here can never retroactively change what a past submission looked
like next to Salesforce.

Run by launchd (~/Library/LaunchAgents/com.olh.ccr-bonus-sync.plist) daily, and
safe to run by hand. See dev/run-ccr-bonus-sync.sh for the wrapper that reads
the Airtable PAT from Keychain.
"""

import argparse
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE_ID = 'appYX9df4lGO6G2uz'
SOURCE_TABLE = 'tbl8eMWVp2Dx1YcDg'   # CCR Bonus SF Source
AIRTABLE_API = 'https://api.airtable.com/v0'

# ---------------------------------------------------------------------------
# Borrow the ccr-monthly-bonus skill's query-building and SF-CLI helpers
# rather than copy-pasting the SOQL. The skill lives at a fixed path under
# ~/.claude/skills (not one of the session-scoped "Library/Application
# Support/Claude" locations another OLH sync had to work around), but this
# still falls back to a glob search for resilience if that ever changes.
# ---------------------------------------------------------------------------

def find_skill_script():
    fixed = os.path.expanduser(
        '~/.claude/skills/ccr-monthly-bonus/scripts/build_ccr_bonus.py')
    if os.path.exists(fixed):
        return fixed
    roots = [
        os.path.expanduser('~/Library/Application Support/Claude'),
        os.path.expanduser('~/.claude'),
    ]
    hits = []
    for root in roots:
        hits += glob.glob(os.path.join(
            root, '**', 'skills', 'ccr-monthly-bonus', 'scripts', 'build_ccr_bonus.py'),
            recursive=True)
    if not hits:
        return None
    return max(hits, key=os.path.getmtime)


def die(msg):
    sys.exit('\nFAILED: %s\n' % msg)


def load_skill_module(override_path=None):
    path = override_path or find_skill_script()
    if not path or not os.path.exists(path):
        die('cannot find the ccr-monthly-bonus skill\'s build_ccr_bonus.py.\n'
            'This sync depends on it for the SOQL query builders and roster -- '
            'pass --skill-script <path> if it has moved.')
    import importlib.util
    spec = importlib.util.spec_from_file_location('build_ccr_bonus', path)
    mod = importlib.util.module_from_spec(spec)
    # ensure_deps() runs at import time and may re-exec into a venv for
    # openpyxl -- harmless here since this script needs no xlsx output, but we
    # let it run rather than forking the module to avoid the import.
    spec.loader.exec_module(mod)
    return mod, path


# ---------------------------------------------------------------------------
# Which months to sync
# ---------------------------------------------------------------------------

def months_to_sync(explicit_month):
    """[(year, mon, label), ...]. Explicit --month syncs just that one month.
    With no --month, syncs BOTH the current month-to-date and the prior full
    month, recomputed live at run time -- never cached from a previous run."""
    if explicit_month:
        y, m = map(int, explicit_month.split('-'))
        return [(y, m, explicit_month)]
    today = datetime.now().date()
    cur_label = '%04d-%02d' % (today.year, today.month)
    first_of_this_month = today.replace(day=1)
    last_month_end = first_of_this_month - __import__('datetime').timedelta(days=1)
    prev_label = '%04d-%02d' % (last_month_end.year, last_month_end.month)
    return [
        (last_month_end.year, last_month_end.month, prev_label),
        (today.year, today.month, cur_label),
    ]


# ---------------------------------------------------------------------------
# Airtable
# ---------------------------------------------------------------------------

def pat():
    v = os.environ.get('AIRTABLE_PAT', '').strip()
    if not v:
        die('AIRTABLE_PAT is not set. See dev/run-ccr-bonus-sync.sh for how the '
            'wrapper reads it from Keychain.')
    return v


def esc(s):
    return str(s).replace('"', '\\"')


def airtable(method, path, body=None, attempts=4):
    url = AIRTABLE_API + '/' + BASE_ID + path
    payload = json.dumps(body).encode() if body else None
    delay = 1.0
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            url, method=method, data=payload,
            headers={'Authorization': 'Bearer ' + pat(),
                     **({'Content-Type': 'application/json'} if body else {})})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            if e.code in (429, 500, 502, 503, 504) and attempt < attempts:
                print('    Airtable %d, retrying in %.0fs' % (e.code, delay), flush=True)
            else:
                die('Airtable %s on %s %s\n  %s' % (e.code, method, path, detail))
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt >= attempts:
                die('could not reach Airtable after %d attempts on %s %s\n  %s'
                    % (attempts, method, path, e))
            print('    %s reaching Airtable, retrying in %.0fs'
                  % (type(e).__name__, delay), flush=True)
        time.sleep(delay)
        delay *= 2


def fetch_existing_for_month(month_label):
    """Existing CCR Bonus SF Source rows for one month, keyed by lowercased
    Associate Email, so an update is a single PATCH rather than a create."""
    records, offset = {}, None
    formula = "{Bonus Month} = \"%s\"" % esc(month_label)
    while True:
        qs = 'pageSize=100&filterByFormula=' + urllib.parse.quote(formula)
        if offset:
            qs += '&offset=' + offset
        page = airtable('GET', '/%s?%s' % (SOURCE_TABLE, qs))
        for r in page.get('records', []):
            email = str((r.get('fields') or {}).get('Associate Email', '')).strip().lower()
            if email:
                records[email] = r
        offset = page.get('offset')
        if not offset:
            break
    return records


def write_batches(verb, payload):
    if not payload:
        return 0
    done = 0
    for i in range(0, len(payload), 10):
        chunk = payload[i:i + 10]
        airtable('PATCH' if verb == 'update' else 'POST', '/' + SOURCE_TABLE,
                 {'records': chunk, 'typecast': True})
        done += len(chunk)
        time.sleep(0.25)
    return done


# ---------------------------------------------------------------------------
# Roster -> email
# ---------------------------------------------------------------------------

def load_roster_with_emails(skill_dir):
    """The ccr-monthly-bonus roster has display_name/raw_name/team but no
    email -- that lives in Airtable's Users table, which this sync also has
    to touch anyway (it's the only source of "who has an OLH Suite account").
    Fetching Users here keeps the roster->email mapping in one place instead
    of hand-maintaining a second copy of it in a JSON file."""
    with open(os.path.join(skill_dir, 'references', 'roster.json')) as f:
        roster = json.load(f)['roster']

    users_table = 'tblTesJj3P7BSiErH'
    users, offset = [], None
    while True:
        qs = 'pageSize=100' + (('&offset=' + offset) if offset else '')
        page = airtable('GET', '/%s?%s' % (users_table, qs))
        users += page.get('records', [])
        offset = page.get('offset')
        if not offset:
            break
    by_name = {}
    for u in users:
        f = u.get('fields') or {}
        name = str(f.get('Name', '')).strip()
        email = str(f.get('Email', '')).strip().lower()
        if name and email:
            by_name[name] = email

    out = []
    unmatched = []
    for rep in roster:
        email = by_name.get(rep['display_name'])
        if email:
            out.append({**rep, 'email': email})
        else:
            unmatched.append(rep['display_name'])
    return out, unmatched


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--month', default=None,
                     help='YYYY-MM. If omitted, syncs BOTH the current month-to-date '
                          'and the prior full month (computed live).')
    ap.add_argument('--alias', default='sf-prod-observability-observer-claude')
    ap.add_argument('--walk-divisions', default='OLH,TPU,AUS,SAN,GFC')
    ap.add_argument('--skill-script', default=None,
                     help="Path to the ccr-monthly-bonus skill's build_ccr_bonus.py, "
                          'if discovery fails')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    mod, skill_path = load_skill_module(args.skill_script)
    skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(skill_path)))

    mod.check_org(args.alias)

    roster, unmatched = load_roster_with_emails(skill_dir)
    if unmatched:
        print('NOTE: no Users-table account (no email) for: %s -- skipped, not synced.'
              % ', '.join(unmatched), flush=True)
    print('Roster: %d of %d bonus-eligible reps have an OLH Suite account.'
          % (len(roster), len(roster) + len(unmatched)), flush=True)

    divisions = [d.strip() for d in args.walk_divisions.split(',')]

    for year, mon, month_label in months_to_sync(args.month):
        print('\n=== %s ===' % month_label, flush=True)
        start = __import__('datetime').date(year, mon, 1)
        import calendar
        last_day = calendar.monthrange(year, mon)[1]
        end = __import__('datetime').date(year, mon, last_day)
        start_off = mod.eastern_offset(start)
        end_off = mod.eastern_offset(end)

        case_soql = mod.build_case_query(start, end, start_off, end_off)
        print('Querying closed cases...', flush=True)
        case_records = mod.run_sf_query(case_soql, args.alias)
        print('  %d cases pulled.' % len(case_records), flush=True)

        walk_soql = mod.build_walk_query(start, end, start_off, end_off, divisions)
        print('Querying Celebration/Acceptance walk assignments...', flush=True)
        walk_records = mod.run_sf_query(walk_soql, args.alias)
        print('  %d homesites with a walk this month.' % len(walk_records), flush=True)

        walk_counts = {}
        for r in walk_records:
            cel_mgr = mod.g(r, 'Celebration_Manager__r.Name')
            acc_mgr = mod.g(r, 'Acceptance_Manager__r.Name')
            if mod.g(r, 'Walk_Through_1_Date__c') and cel_mgr:
                walk_counts.setdefault(cel_mgr, [0, 0])
                walk_counts[cel_mgr][0] += 1
            if mod.g(r, 'Acceptance_Date__c') and acc_mgr:
                walk_counts.setdefault(acc_mgr, [0, 0])
                walk_counts[acc_mgr][1] += 1

        now = datetime.now(timezone.utc).isoformat()
        existing = fetch_existing_for_month(month_label) if not args.dry_run else {}

        creates, updates = [], []
        for rep in roster:
            raw_name = rep['raw_name']
            email = rep['email']
            owned = [c for c in case_records if mod.g(c, 'Owner.Name') == raw_name]
            n_cases = len(owned)
            ages = [mod.g(c, 'Age_Days__c') or 0 for c in owned]
            avg_cycle = round(sum(ages) / n_cases, 1) if n_cases else 0
            aged = sum(1 for a in ages if a > 21)
            within7 = sum(1 for a in ages if a <= 7)
            pct_within7 = round(within7 / n_cases, 3) if n_cases else 0
            cel, acc = walk_counts.get(raw_name, (0, 0))

            fields = {
                'Key': email + '|' + month_label,
                'Associate Name': rep['display_name'],
                'Associate Email': email,
                'Bonus Month': month_label,
                'Cases Closed (SF)': n_cases,
                'Average Cycle Time Days (SF)': avg_cycle,
                'Aged Cases 21+ (SF)': aged,
                'Pct Closed Within 7 Days (SF)': pct_within7,
                'CEL Walks (SF)': cel,
                'ACC Walks (SF)': acc,
                'Last Synced': now,
                'Sync Run Note': '%d cases, %d walk-tagged homesites pulled' % (
                    len(case_records), len(walk_records)),
            }

            hit = existing.get(email)
            if hit:
                updates.append({'id': hit['id'], 'fields': fields})
            else:
                creates.append({'fields': fields})

        print('  %d rep(s): %d update, %d create.'
              % (len(roster), len(updates), len(creates)), flush=True)

        if args.dry_run:
            print('  DRY RUN -- nothing written.', flush=True)
            continue

        n1 = write_batches('update', updates)
        n2 = write_batches('create', creates)
        print('  Wrote %d update(s), %d create(s).' % (n1, n2), flush=True)

    print('\nDone.', flush=True)


if __name__ == '__main__':
    main()
