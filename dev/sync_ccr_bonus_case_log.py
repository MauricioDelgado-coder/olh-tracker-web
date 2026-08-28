#!/usr/bin/env python3
"""
Sync closed Salesforce cases into the "CCR Bonus Case Log" Airtable table
(base appYX9df4lGO6G2uz, tblMPsfjjermgPJOe).

    python3 dev/sync_ccr_bonus_case_log.py [--days 7] [--dry-run]
    python3 dev/sync_ccr_bonus_case_log.py --since 2026-07-01 [--dry-run]

Pulls Case records with Status = Closed and ClosedDate within a window
across Division_Code__c in OLH, TPU, SAN, GFC. Default window is a rolling
last 7 days from run time (--days); pass --since YYYY-MM-DD for an
explicit start date (interpreted as Eastern midnight) through now instead
-- --since and --days are mutually exclusive. Record Type and Case Subtype
filters mirror the
Salesforce "#Cases Closed Last Month" report exactly (see
~/.claude/skills/ccr-monthly-bonus/references/salesforce.md) -- same
RECORD_TYPES / TYPE_VALUES lists as that skill's build_ccr_bonus.py, so the
two can never drift on what "closed case" means.

One row per Case Number, upserted every run -- never duplicated. A case
that later ages out of the 7-day window is left in place (Last Synced just
stops advancing), not deleted, so this is an accumulating log, not a
point-in-time snapshot.

"Case Aged (21+ Days)" and "Closed Within 7 Days" are Airtable formula
fields on Age (Days) -- this script does not write them.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE_ID = 'appYX9df4lGO6G2uz'
TABLE_ID = 'tblMPsfjjermgPJOe'   # CCR Bonus Case Log
AIRTABLE_API = 'https://api.airtable.com/v0'
DIVISIONS = ['OLH', 'TPU', 'SAN', 'GFC']

RECORD_TYPES = ["Corporate", "Case", "Case Item", "Service Request", "Touchpoint"]
TYPE_VALUES = [
    "1st Escalation", "2nd Escalation", "Agreement", "Auto Homesite Closing", "Awaiting refund",
    "Build", "Build time", "Chinese Drywall Inquiry", "Community related",
    "Complaints about sales", "Compliments", "Delayed closing",
    "Dislikes overall customer experience", "Earnest money refund", "Emergency Service Call",
    "Exception List", "Fifth TLC", "Financial Services Issues", "Fourth TLC",
    "General request for information", "Home Automation", "Hurricane",
    "Incomplete Items from Closing", "Inspection", "Leak", "Lost opportunity",
    "No local response", "Poor construction quality", "Poor customer service",
    "Post Orientation Request", "Product Quality", "Product Remediation", "QA/QC",
    "Regional Request", "Sales issue", "Seventh TLC", "Sixth TLC", "Social Media Complaint",
    "Special TLC Issues", "Standard Warranty", "TLC - Admin", "Trade partners",
    "Unethical business practices", "Unknown",
]


def die(msg):
    sys.exit('\nFAILED: %s\n' % msg)


def eastern_offset(dt):
    """Rough US Eastern DST check: 2nd Sunday in March to 1st Sunday in November."""
    year = dt.year
    march = datetime(year, 3, 1)
    dst_start = march + timedelta(days=(6 - march.weekday()) % 7 + 7)
    nov = datetime(year, 11, 1)
    dst_end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    return '-04:00' if dst_start <= dt < dst_end else '-05:00'


def g(rec, path):
    cur = rec
    for p in path.split('.'):
        if cur is None:
            return None
        cur = cur.get(p)
    return cur


# ---------------------------------------------------------------------------
# Salesforce
# ---------------------------------------------------------------------------

def check_org(alias):
    r = subprocess.run(['sf', 'org', 'list'], capture_output=True, text=True)
    if alias not in r.stdout or 'Connected' not in r.stdout:
        die("org alias '%s' not found or not Connected. Re-authenticate first.\n%s"
            % (alias, r.stdout))


def build_case_query(start_s, end_s, divisions):
    rt_clause = ' OR '.join("RecordType.Name = '%s'" % v for v in RECORD_TYPES) + ' OR RecordType.Name = null'
    type_clause = ' OR '.join("Type = '%s'" % v for v in TYPE_VALUES) + ' OR Type = null'
    div_clause = ','.join("'%s'" % d for d in divisions)
    return """SELECT CaseNumber, Age_Days__c, ClosedDate, Owner.Name, Division_Code__c,
       Total_Case_Items__c, Status, Type
FROM Case
WHERE Status = 'Closed'
AND ClosedDate >= %s AND ClosedDate <= %s
AND Division_Code__c IN (%s)
AND (%s)
AND (%s)
ORDER BY Division_Code__c, Owner.Name, ClosedDate
""" % (start_s, end_s, div_clause, rt_clause, type_clause)


def run_sf_query(soql, alias):
    with tempfile.NamedTemporaryFile('w', suffix='.soql', delete=False) as f:
        f.write(soql)
        path = f.name
    out_path = path + '.json'
    try:
        subprocess.run(
            ['sf', 'data', 'query', '-o', alias, '--file', path,
             '--json', '--result-format', 'json'],
            stdout=open(out_path, 'w'), stderr=subprocess.PIPE, check=True, text=True,
        )
        with open(out_path) as f:
            data = json.load(f)
        if data.get('status') != 0:
            raise RuntimeError('sf data query failed: %s' % data)
        return data['result']['records']
    finally:
        for p in (path, out_path):
            if os.path.exists(p):
                os.remove(p)


# ---------------------------------------------------------------------------
# Airtable
# ---------------------------------------------------------------------------

def pat():
    v = os.environ.get('AIRTABLE_PAT', '').strip()
    if not v:
        die('AIRTABLE_PAT is not set. Export it (see dev/run-daily-sync.sh for the '
            'Keychain-read pattern) before running this script.')
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


def fetch_existing(case_numbers):
    """Existing rows keyed by Case Number, for cases in this run's pull only
    (chunked OR-formula lookups rather than pulling the whole table)."""
    existing = {}
    case_numbers = list(case_numbers)
    for i in range(0, len(case_numbers), 80):
        chunk = case_numbers[i:i + 80]
        formula = 'OR(' + ','.join(
            '{Case Number}="%s"' % esc(cn) for cn in chunk) + ')'
        offset = None
        while True:
            qs = 'pageSize=100&filterByFormula=' + urllib.parse.quote(formula)
            if offset:
                qs += '&offset=' + offset
            page = airtable('GET', '/%s?%s' % (TABLE_ID, qs))
            for r in page.get('records', []):
                cn = str((r.get('fields') or {}).get('Case Number', '')).strip()
                if cn:
                    existing[cn] = r
            offset = page.get('offset')
            if not offset:
                break
    return existing


def write_batches(verb, payload):
    if not payload:
        return 0
    done = 0
    for i in range(0, len(payload), 10):
        chunk = payload[i:i + 10]
        airtable('PATCH' if verb == 'update' else 'POST', '/' + TABLE_ID,
                 {'records': chunk, 'typecast': True})
        done += len(chunk)
        time.sleep(0.25)
    return done


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=None,
                     help='Rolling window size in days (default 7 if --since not given).')
    ap.add_argument('--since', default=None,
                     help='YYYY-MM-DD, Eastern midnight, through now. Mutually exclusive with --days.')
    ap.add_argument('--alias', default='sf-prod-observability-observer-claude')
    ap.add_argument('--divisions', default=','.join(DIVISIONS))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if args.since and args.days:
        die('--since and --days are mutually exclusive.')

    check_org(args.alias)

    divisions = [d.strip() for d in args.divisions.split(',')]
    end_dt_utc = datetime.now(timezone.utc)
    end_s = end_dt_utc.strftime('%Y-%m-%dT%H:%M:%S+00:00')

    if args.since:
        start_date = datetime.strptime(args.since, '%Y-%m-%d')
        off = eastern_offset(start_date)
        start_s = start_date.strftime('%Y-%m-%dT00:00:00') + off
        window_desc = 'since %s Eastern' % args.since
    else:
        days = args.days or 7
        start_dt_utc = end_dt_utc - timedelta(days=days)
        start_s = start_dt_utc.strftime('%Y-%m-%dT%H:%M:%S+00:00')
        window_desc = 'last %d days' % days

    print('Window: %s to %s (%s)' % (start_s, end_s, window_desc), flush=True)
    print('Divisions: %s' % ', '.join(divisions), flush=True)

    soql = build_case_query(start_s, end_s, divisions)
    print('Querying closed cases...', flush=True)
    records = run_sf_query(soql, args.alias)
    print('  %d cases pulled.' % len(records), flush=True)

    by_division = {}
    for r in records:
        by_division.setdefault(g(r, 'Division_Code__c') or '(blank)', 0)
        by_division[g(r, 'Division_Code__c') or '(blank)'] += 1
    for div, n in sorted(by_division.items()):
        print('    %s: %d' % (div, n), flush=True)

    case_numbers = [g(r, 'CaseNumber') for r in records if g(r, 'CaseNumber')]
    dupe_check = len(case_numbers) - len(set(case_numbers))
    if dupe_check:
        print('  NOTE: %d duplicate CaseNumber value(s) in the SF pull itself '
              '(same case matched by more than one filter clause) -- '
              'collapsed to one row per case number below.' % dupe_check, flush=True)

    now = datetime.now(timezone.utc).isoformat()
    existing = fetch_existing(set(case_numbers)) if not args.dry_run else {}

    # Collapse to one row per Case Number before writing (defends against the
    # SF-side duplication noted above).
    by_case_number = {}
    for r in records:
        cn = g(r, 'CaseNumber')
        if cn:
            by_case_number[cn] = r  # last one wins; rows are identical per case anyway

    creates, updates = [], []
    for cn, r in by_case_number.items():
        fields = {
            'Case Number': cn,
            'Age (Days)': g(r, 'Age_Days__c'),
            'Date Closed': g(r, 'ClosedDate'),
            'Case Owner': g(r, 'Owner.Name'),
            'Division': g(r, 'Division_Code__c'),
            'Total Work Orders': g(r, 'Total_Case_Items__c'),
            'Status': g(r, 'Status'),
            'Case Subtype': g(r, 'Type'),
            'Last Synced': now,
        }
        hit = existing.get(cn)
        if hit:
            updates.append({'id': hit['id'], 'fields': fields})
        else:
            creates.append({'fields': fields})

    print('  %d unique case(s): %d update, %d create.'
          % (len(by_case_number), len(updates), len(creates)), flush=True)

    if args.dry_run:
        print('  DRY RUN -- nothing written.', flush=True)
        return

    n1 = write_batches('update', updates)
    n2 = write_batches('create', creates)
    print('Done. Wrote %d update(s), %d create(s).' % (n1, n2), flush=True)


if __name__ == '__main__':
    main()
