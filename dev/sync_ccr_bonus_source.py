#!/usr/bin/env python3
"""
Sync per-rep-per-month CCR bonus metrics into the "CCR Bonus SF Source"
Airtable table (base appYX9df4lGO6G2uz, tbl8eMWVp2Dx1YcDg) -- this is what
bonus.html's "Salesforce Data" pre-fill (via netlify/functions/bonus-source.js)
actually reads. It is a DIFFERENT table from "CCR Bonus Case Log" (the raw
per-case rows written by dev/sync_ccr_bonus_case_log.py) -- that table is an
audit-trail feed, this one is the monthly-aggregate feed the app reads.

    python3 dev/sync_ccr_bonus_source.py [--month YYYY-MM] [--dry-run]

With no --month: syncs BOTH the current month-to-date and the prior full
month (recomputed live every run), matching the removed script's behavior.

Case filter (Status=Closed, Division_Code__c in OLH/TPU/SAN/GFC, Record Type
and Case Subtype lists) is identical to dev/sync_ccr_bonus_case_log.py --
same RECORD_TYPES / TYPE_VALUES lists, so the two can never drift on what
"closed case" means.

DIFFERENCE FROM THE REMOVED SCRIPT (git 0e5c74d): "Cases Closed (SF)" and its
derived stats (avg cycle, aged, pct-within-7) now EXCLUDE cases whose Record
Type is "Touchpoint". bonus.html's manual-entry hint under Cases Closed reads
"Excludes touchpoint cases" -- the removed script counted every matched case
regardless of record type, which contradicted that hint. Flagged here
explicitly: if this is wrong, the fix is the TOUCHPOINT_EXCLUDED_FROM_CLOSED
flag below.

DIFFERENCE FROM THE REMOVED SCRIPT, #2: owner-name -> email matching no
longer dynamically imports the ccr-monthly-bonus skill's build_ccr_bonus.py
(fragile glob-search + re-exec-into-venv side effects for no reason this
script needs). The roster of *who is bonus-eligible* is still read from that
skill's references/roster.json directly (static, human-curated, changes
rarely) but the query building and SF-CLI plumbing are self-contained here.

APPROVED CASE AGING EXCEPTIONS: for each month synced, this also pulls
Approved rows from the Case Aging Exceptions Airtable table
(tblF6CAPJkW4WgZmS) whose Case Closed Date falls in that month, and builds
a set of excluded Case Numbers. Any case in that set is dropped entirely
from Average Cycle Time / Aged Cases 21+ / Pct Closed Within 7 Days --
matched case-by-case, not a blunt count subtraction -- but is STILL counted
toward Cases Closed (SF). This means Aged Cases 21+ (SF) is now already net
of approved exceptions; see the matching change in submit-bonus.js and
bonus.html (both stopped separately subtracting
A.caseAgingExceptionsApprovedCount from the aged count, which would
otherwise double-discount every excepted case).

One row per (Associate Email, Bonus Month), upserted -- never duplicated,
matched by "<email>|<month>" Key, same as before.
"""

import argparse
import calendar
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE_ID = 'appYX9df4lGO6G2uz'
SOURCE_TABLE = 'tbl8eMWVp2Dx1YcDg'   # CCR Bonus SF Source
USERS_TABLE = 'tblTesJj3P7BSiErH'
CASE_AGING_TABLE = 'tblF6CAPJkW4WgZmS'   # Case Aging Exceptions
AIRTABLE_API = 'https://api.airtable.com/v0'
ROSTER_PATH = os.path.expanduser(
    '~/.claude/skills/ccr-monthly-bonus/references/roster.json')

DIVISIONS = ['OLH', 'TPU', 'SAN', 'GFC']
WALK_DIVISIONS = ['OLH', 'TPU', 'AUS', 'SAN', 'GFC']

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

# See module docstring "DIFFERENCE FROM THE REMOVED SCRIPT" -- flip this to
# False to restore the old (pre-removal) behavior of counting every matched
# case regardless of record type.
TOUCHPOINT_EXCLUDED_FROM_CLOSED = True


def die(msg):
    sys.exit('\nFAILED: %s\n' % msg)


def g(rec, path):
    cur = rec
    for p in path.split('.'):
        if cur is None:
            return None
        cur = cur.get(p)
    return cur


def eastern_offset(dt):
    """Rough US Eastern DST check: 2nd Sunday in March to 1st Sunday in November."""
    year = dt.year
    march = date(year, 3, 1)
    dst_start = march + timedelta(days=(6 - march.weekday()) % 7 + 7)
    nov = date(year, 11, 1)
    dst_end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    return '-04:00' if dst_start <= dt < dst_end else '-05:00'


def months_to_sync(explicit_month):
    """[(year, mon, label), ...]. Explicit --month syncs just that one month.
    With no --month, syncs BOTH the current month-to-date and the prior full
    month, recomputed live at run time."""
    if explicit_month:
        y, m = map(int, explicit_month.split('-'))
        return [(y, m, explicit_month)]
    today = date.today()
    cur_label = '%04d-%02d' % (today.year, today.month)
    first_of_this_month = today.replace(day=1)
    last_month_end = first_of_this_month - timedelta(days=1)
    prev_label = '%04d-%02d' % (last_month_end.year, last_month_end.month)
    return [
        (last_month_end.year, last_month_end.month, prev_label),
        (today.year, today.month, cur_label),
    ]


# ---------------------------------------------------------------------------
# Salesforce
# ---------------------------------------------------------------------------

def check_org(alias):
    r = subprocess.run(['sf', 'org', 'list'], capture_output=True, text=True)
    if alias not in r.stdout or 'Connected' not in r.stdout:
        die("org alias '%s' not found or not Connected. Re-authenticate first.\n%s"
            % (alias, r.stdout))


def build_case_query(start, end, start_off, end_off):
    rt_clause = ' OR '.join("RecordType.Name = '%s'" % v for v in RECORD_TYPES) + ' OR RecordType.Name = null'
    type_clause = ' OR '.join("Type = '%s'" % v for v in TYPE_VALUES) + ' OR Type = null'
    div_clause = ','.join("'%s'" % d for d in DIVISIONS)
    return """SELECT CaseNumber, Age_Days__c, ClosedDate, Owner.Name, Division_Code__c,
       RecordType.Name, Status, Type
FROM Case
WHERE Status = 'Closed'
AND ClosedDate >= %sT00:00:00%s AND ClosedDate <= %sT23:59:59%s
AND Division_Code__c IN (%s)
AND (%s)
AND (%s)
ORDER BY Owner.Name, ClosedDate
""" % (start.isoformat(), start_off, end.isoformat(), end_off, div_clause, rt_clause, type_clause)


def build_walk_query(start, end, start_off, end_off):
    div_clause = ','.join("'%s'" % d for d in WALK_DIVISIONS)
    return """SELECT Name, Walk_Through_1_Date__c, Celebration_Manager__r.Name, Acceptance_Date__c,
       Acceptance_Manager__r.Name, DivisionCode__c
FROM Homesite__c
WHERE DivisionCode__c IN (%s)
AND ((Walk_Through_1_Date__c >= %sT00:00:00%s AND Walk_Through_1_Date__c <= %sT23:59:59%s)
     OR (Acceptance_Date__c >= %sT00:00:00%s AND Acceptance_Date__c <= %sT23:59:59%s))
ORDER BY Name
""" % (div_clause,
       start.isoformat(), start_off, end.isoformat(), end_off,
       start.isoformat(), start_off, end.isoformat(), end_off)


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
        die('AIRTABLE_PAT is not set.')
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


def fetch_all(table_id):
    records, offset = [], None
    while True:
        qs = 'pageSize=100' + (('&offset=' + offset) if offset else '')
        page = airtable('GET', '/%s?%s' % (table_id, qs))
        records += page.get('records', [])
        offset = page.get('offset')
        if not offset:
            break
    return records


def fetch_existing_for_month(month_label):
    records, offset = {}, None
    formula = '{Bonus Month} = "%s"' % esc(month_label)
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


def fetch_approved_excluded_case_numbers(month_label):
    """Case Numbers with an Approved Case Aging Exception whose Case Closed
    Date falls in this month -- these are dropped from Average Cycle Time /
    Aged Cases 21+ / Pct Closed Within 7 Days (but stay in Cases Closed).
    Same criteria as A.caseAgingExceptionsApprovedCount in olh-auth.js,
    minus the per-email scoping (a Case Number is unique to one case/owner
    regardless, so no need to also filter by Submitted By Email here)."""
    formula = ('AND({Status} = "Approved", {Case Closed Date} != "", '
               'DATETIME_FORMAT({Case Closed Date}, "YYYY-MM") = "%s")') % esc(month_label)
    out, offset = set(), None
    while True:
        qs = 'pageSize=100&filterByFormula=' + urllib.parse.quote(formula)
        if offset:
            qs += '&offset=' + offset
        page = airtable('GET', '/%s?%s' % (CASE_AGING_TABLE, qs))
        for r in page.get('records', []):
            cn = str((r.get('fields') or {}).get('Case Number', '')).strip()
            if cn:
                out.add(cn)
        offset = page.get('offset')
        if not offset:
            break
    return out


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

def load_roster_with_emails():
    with open(ROSTER_PATH) as f:
        roster = json.load(f)['roster']

    users = fetch_all(USERS_TABLE)
    by_name = {}
    for u in users:
        f = u.get('fields') or {}
        name = str(f.get('Name', '')).strip()
        email = str(f.get('Email', '')).strip().lower()
        if name and email:
            by_name[name] = email

    out, unmatched = [], []
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
                     help='YYYY-MM. If omitted, syncs BOTH current month-to-date '
                          'and prior full month.')
    ap.add_argument('--alias', default='sf-prod-observability-observer-claude')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    check_org(args.alias)

    roster, unmatched = load_roster_with_emails()
    if unmatched:
        print('NOTE: no Users-table account (no email) for: %s -- skipped, not synced.'
              % ', '.join(unmatched), flush=True)
    print('Roster: %d of %d bonus-eligible reps have an OLH Suite account.'
          % (len(roster), len(roster) + len(unmatched)), flush=True)
    print('Touchpoint cases excluded from Cases Closed / derived stats: %s'
          % TOUCHPOINT_EXCLUDED_FROM_CLOSED, flush=True)

    for year, mon, month_label in months_to_sync(args.month):
        print('\n=== %s ===' % month_label, flush=True)
        start = date(year, mon, 1)
        last_day = calendar.monthrange(year, mon)[1]
        end = date(year, mon, last_day)
        start_off = eastern_offset(start)
        end_off = eastern_offset(end)

        case_soql = build_case_query(start, end, start_off, end_off)
        print('Querying closed cases...', flush=True)
        case_records = run_sf_query(case_soql, args.alias)
        print('  %d cases pulled.' % len(case_records), flush=True)

        n_touchpoint = sum(1 for c in case_records if g(c, 'RecordType.Name') == 'Touchpoint')
        if n_touchpoint:
            print('  %d of those are Touchpoint record type (%s from Cases Closed).'
                  % (n_touchpoint,
                     'excluded' if TOUCHPOINT_EXCLUDED_FROM_CLOSED else 'INCLUDED'), flush=True)

        walk_soql = build_walk_query(start, end, start_off, end_off)
        print('Querying Celebration/Acceptance walk assignments...', flush=True)
        walk_records = run_sf_query(walk_soql, args.alias)
        print('  %d homesites with a walk this month.' % len(walk_records), flush=True)

        excluded_case_numbers = fetch_approved_excluded_case_numbers(month_label)
        if excluded_case_numbers:
            print('  %d case(s) excluded from Avg Cycle / Aged / Pct-Within-7 via '
                  'Approved Case Aging Exceptions closing this month (still counted '
                  'toward Cases Closed).' % len(excluded_case_numbers), flush=True)

        walk_counts = {}
        for r in walk_records:
            cel_mgr = g(r, 'Celebration_Manager__r.Name')
            acc_mgr = g(r, 'Acceptance_Manager__r.Name')
            if g(r, 'Walk_Through_1_Date__c') and cel_mgr:
                walk_counts.setdefault(cel_mgr, [0, 0])
                walk_counts[cel_mgr][0] += 1
            if g(r, 'Acceptance_Date__c') and acc_mgr:
                walk_counts.setdefault(acc_mgr, [0, 0])
                walk_counts[acc_mgr][1] += 1

        now = datetime.now(timezone.utc).isoformat()
        existing = fetch_existing_for_month(month_label) if not args.dry_run else {}

        creates, updates = [], []
        for rep in roster:
            raw_name = rep['raw_name']
            email = rep['email']
            owned = [c for c in case_records if g(c, 'Owner.Name') == raw_name]
            if TOUCHPOINT_EXCLUDED_FROM_CLOSED:
                counted = [c for c in owned if g(c, 'RecordType.Name') != 'Touchpoint']
            else:
                counted = owned
            n_cases = len(counted)  # Cases Closed (SF) -- exception-excluded cases still count here

            # Avg Cycle / Aged / Pct-Within-7 drop any case with an Approved
            # Case Aging Exception closing this month -- matched by exact
            # Case Number, not a blunt count subtraction.
            age_stat_cases = [c for c in counted if g(c, 'CaseNumber') not in excluded_case_numbers]
            ages = [g(c, 'Age_Days__c') or 0 for c in age_stat_cases]
            n_age_stat = len(age_stat_cases)
            avg_cycle = round(sum(ages) / n_age_stat, 1) if n_age_stat else 0
            aged = sum(1 for a in ages if a > 21)
            within7 = sum(1 for a in ages if a <= 7)
            pct_within7 = round(within7 / n_age_stat, 3) if n_age_stat else 0
            cel, acc = walk_counts.get(raw_name, (0, 0))
            n_excepted_for_rep = n_cases - n_age_stat

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
                'Sync Run Note': ('%d cases pulled total (%d Touchpoint %s), %d walk-tagged '
                                  'homesites, %d case(s) excluded from Avg Cycle/Aged/Within-7 '
                                  'via approved aging exceptions') % (
                    len(case_records), n_touchpoint,
                    'excluded' if TOUCHPOINT_EXCLUDED_FROM_CLOSED else 'included',
                    len(walk_records), n_excepted_for_rep),
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
