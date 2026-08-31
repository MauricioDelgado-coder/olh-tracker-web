#!/usr/bin/env python3
"""
Sync per-QAM-per-month QA bonus metrics into the "QA Bonus Source" Airtable
table (base appYX9df4lGO6G2uz, tblQokbgOBiRZ8bDM) -- this is what
qa-bonus.html's pre-fill (via netlify/functions/qa-bonus-source.js) reads.
Mirrors dev/sync_ccr_bonus_source.py's shape (argparse, SF CLI plumbing,
Airtable upsert-by-Key), against the Quality Assurance Manager (QAM) Bonus
Agreement (1/30/2025) instead of the CCR Bonus Agreement.

    python3 dev/sync_qa_bonus_source.py [--month YYYY-MM] [--dry-run]

With no --month: syncs BOTH the current month-to-date and the prior full
month (recomputed live every run), same convention as the CCR sync.

TWO METRIC GROUPS, ONE SCRIPT, BECAUSE ONE BONUS AGREEMENT:

1. WALK COMPLETION (the Bonus Agreement's Frequency Bonus table): counts of
   QAI, QAA, NHO, and NHA walks this QAM completed in the bonus month, where
   walk date is scoped by clock time in America/New_York (Salesforce returns
   these datetimes in UTC). NHO/NHA are the Bonus Agreement's own names for
   what Homesite__c calls Celebration and Acceptance:

     Bonus Agreement term -> Homesite__c field(s)
     QAI  -> QAI_Walk_Date_Time__c / QAI_Manager__r.Name
     QAA  -> QA_Walk_1_Date__c      / QAA_Manager__r.Name  (misleading API name)
     NHO  -> Walk_Through_1_Date__c / Celebration_Manager__r.Name (label: "Celebration Date/Time")
     NHA  -> Acceptance_Date__c     / Acceptance_Manager__r.Name

2. QUALITY (the Bonus Agreement's Quality Bonus table): for homes this QAM
   did the QAI on that CLOSED in the bonus month, the count of qualifying
   Case work orders opened 0-29 days after Actual COE Date. This is exactly
   the pull built by hand for the July 2026 OLH homes-closed/issue-rate
   analysis -- same Homesite__c + Case filter criteria, generalized to any
   month here. See the Case filter block below for the exact criteria
   (Record Type, Case Subtype, Status, Days since COE, WO Trade Partner
   exclusion) -- these came directly from Mauricio's own report definition,
   not invented here.

Dollar amounts are NEVER computed or stored by this script -- qa-bonus.js
computes those server-side, at submission time, from these raw counts. This
script's only job is the raw counts.

ROSTER / NAME MATCHING: Salesforce manager names on Homesite__c are matched
against the Users table's Name field to find each QAM's account/email. Two
known mismatches, found comparing the two sources directly:

  - Salesforce "Ray Kollar" vs Users table "Raymond Kollar" -- aliased below.
  - Two names that show walk/manager activity on Homesite__c in Salesforce
    (Kimberly Neuman, Yalimar Gonzalez) are Customer Care accounts in the
    Users table, not QA Manager -- almost certainly a wrong-manager data
    entry on a small number of homesites, not a second job these two people
    hold. EXCLUDED from the QAM roster this script syncs against; logged
    under "Salesforce QAI/walk activity for non-QAM accounts" so the
    anomaly stays visible rather than silently sweeping in bad rows.

One row per (QAM Email, Bonus Month), upserted by Key, same convention as
the CCR bonus source table.
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
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

BASE_ID = 'appYX9df4lGO6G2uz'
SOURCE_TABLE = 'tblQokbgOBiRZ8bDM'   # QA Bonus Source
USERS_TABLE = 'tblTesJj3P7BSiErH'
AIRTABLE_API = 'https://api.airtable.com/v0'

DIVISION = 'OLH'
ET = ZoneInfo('America/New_York')

# Salesforce name -> Users-table name, where they genuinely differ. Anything
# not listed here is matched as an exact string.
NAME_ALIASES = {
    'Ray Kollar': 'Raymond Kollar',
    'Jeffrey Boyd': 'Jeff Boyd',
}

# Salesforce shows QAI/CEL/ACC manager activity under these names too, but
# neither has a QA Manager account in the Users table (both are Customer
# Care) -- see the module docstring. Excluded from the roster; any
# Salesforce activity under these names is logged, not synced.
KNOWN_NON_QAM_NAMES = {'Kimberly Neuman', 'Yalimar Gonzalez'}

# ---------------------------------------------------------------------------
# Case filter criteria for the Quality Bonus's "issues within 30 days" count.
# Verbatim from Mauricio's own report definition (the same filter run by hand
# for the July 2026 OLH homes-closed/issue-rate analysis) -- see the module
# docstring. Status values use the picklist's underlying API values, not the
# display labels that have since been renamed (On Hold -> Inactive, On Hold
# Pending Approval -> Inactive - pending approval).
# ---------------------------------------------------------------------------
CASE_RECORD_TYPES = ['Case', 'Case Item', 'Service Request', 'Feedback']
CASE_SUBTYPES = [
    '1st Escalation', '2nd Escalation', 'Agreement', 'Auto Homesite Closing', 'Awaiting refund',
    'Build', 'Build time', 'Community related', 'Complaints about sales', 'Compliments',
    'Delayed closing', 'Dislikes overall customer experience', 'Earnest money refund',
    'Emergency Service Call', 'Exception List', 'General request for information',
    'Home Automation', 'Hurricane', 'Incomplete Items from Closing', 'Inspection',
    'Inspection Report', 'Leak', 'Lost opportunity', 'No local response',
    'Poor construction quality', 'Poor customer service', 'Post Orientation Request',
    'Product Quality', 'Product Remediation', 'Regional Request', 'Sales issue',
    'Social Media Complaint', 'Standard Warranty', 'Trade partners',
    'Unethical business practices', 'Unknown', 'Construction',
]
CASE_STATUSES = [
    'New', 'Coordinator - In Progress', 'Pending/First Contact', 'Open',
    'Inspection/Assessment Scheduled', 'Pending Virtual Contact', 'Virtual \u2013 In Progress',
    'Pending Field Contact', 'Field \u2013 In Progress', 'Trades Scheduled', 'Work Completed',
    'Awaiting DocuSign', 'Closed', 'Inactive', 'Delayed', 'Ready for Review',
    'Inactive - pending approval', 'Under Construction', 'No Appointment Selected',
    'Awaiting Homeowner',
]
TRADE_PARTNER_EXCLUDE = 'Lennar Service'


def die(msg):
    sys.exit('\nFAILED: %s\n' % msg)


def g(rec, path):
    cur = rec
    for p in path.split('.'):
        if cur is None:
            return None
        cur = cur.get(p)
    return cur


def months_to_sync(explicit_month):
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


def soql_list(vals):
    return ','.join("'%s'" % v.replace("'", "\\'") for v in vals)


def build_walk_query(pad_start, pad_end):
    """One query per sync run (not per month) -- walk dates span whatever
    window months_to_sync() needs, and this pulls a superset filtered in
    Python per-month in Eastern time, same reasoning as the original manual
    August 2026 walk-count pull: SOQL datetime comparisons against UTC-shifted
    month boundaries are error-prone right at month edges, so pull a padded
    range and bucket precisely in Python.

    CRITICAL: unlike the CCR sync's build_walk_query (which only ever covers
    one month and so never needed a WHERE on the walk-date fields themselves),
    Homesite__c has ~61,000+ OLH rows total. A query with no walk-date bound
    at all silently hit Salesforce's default 50,000-row query cap on first
    run here -- confirmed by dry-run, before any Airtable write -- returning
    a truncated, essentially-random slice of the whole table's walk history
    instead of "this sync window's walks." The four-field OR-of-ranges below
    is required, not optional, and pad_start/pad_end must stay generous
    (currently one full day on each side) so a walk at a month boundary is
    never dropped by the UTC/Eastern offset."""
    def rng(field):
        return "(%s >= %sT00:00:00Z AND %s <= %sT23:59:59Z)" % (
            field, pad_start.isoformat(), field, pad_end.isoformat())
    return """SELECT Name, DivisionCode__c,
       QAI_Walk_Date_Time__c, QAI_Manager__r.Name,
       QA_Walk_1_Date__c, QAA_Manager__r.Name,
       Walk_Through_1_Date__c, Celebration_Manager__r.Name,
       Acceptance_Date__c, Acceptance_Manager__r.Name
FROM Homesite__c
WHERE DivisionCode__c = '%s'
AND (%s OR %s OR %s OR %s)
""" % (DIVISION,
       rng('QAI_Walk_Date_Time__c'), rng('QA_Walk_1_Date__c'),
       rng('Walk_Through_1_Date__c'), rng('Acceptance_Date__c'))


def build_closed_homes_query(start, end):
    """Homes closed in [start, end] (inclusive), OLH, with their QAI manager.
    Actual_COE_Date_New__c is a plain date field, no UTC conversion needed."""
    return """SELECT Id, Name, QAI_Manager__r.Name, Actual_COE_Date_New__c
FROM Homesite__c
WHERE DivisionCode__c = '%s'
AND Actual_COE_Date_New__c >= %s
AND Actual_COE_Date_New__c <= %s
""" % (DIVISION, start.isoformat(), end.isoformat())


def build_case_query(homesite_ids):
    ids_clause = ','.join("'%s'" % i for i in homesite_ids)
    return """SELECT Id, Homesite__c, Days_since_COE__c,
       WO_Trade_Partner_to_Group_By_Lookup__r.Name
FROM Case
WHERE Homesite__c IN (%s)
AND RecordType.Name IN (%s)
AND Type IN (%s)
AND Status IN (%s)
AND Days_since_COE__c >= 0
AND Days_since_COE__c < 30
""" % (ids_clause, soql_list(CASE_RECORD_TYPES), soql_list(CASE_SUBTYPES), soql_list(CASE_STATUSES))


def to_et(iso_dt):
    """Salesforce datetime string -> aware datetime in America/New_York, or
    None if unparseable/blank."""
    if not iso_dt:
        return None
    v = str(iso_dt).strip().replace('+0000', '+00:00')
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt.astimezone(ET)


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
            email = str((r.get('fields') or {}).get('QAM Email', '')).strip().lower()
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


def load_qam_roster():
    """QA Manager Users-table accounts, keyed by both their own Name and any
    alias that points at them, so Salesforce names resolve either way."""
    users = fetch_all(USERS_TABLE)
    roster = {}  # display name (as it appears on Homesite__c) -> {name, email}
    for u in users:
        f = u.get('fields') or {}
        # Role is a singleSelect; the raw REST API (what this script and every
        # Netlify function call) returns its plain option-name string, not an
        # object -- unlike some MCP/tooling wrappers that box select fields as
        # {id, color, name}. Comparing f.get('Role') directly against the
        # string is the same pattern netlify/lib/olh-auth.js uses for Status.
        if f.get('Role') != 'QA Manager':
            continue
        name = str(f.get('Name', '')).strip()
        email = str(f.get('Email', '')).strip().lower()
        if name and email:
            roster[name] = {'name': name, 'email': email}
    # Point each Salesforce-side alias at the same account.
    by_alias = dict(roster)
    for sf_name, users_name in NAME_ALIASES.items():
        if users_name in roster:
            by_alias[sf_name] = roster[users_name]
    return by_alias


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

    roster = load_qam_roster()
    print('%d QA Manager account(s) in the Users table (OLH).' % len(set(v['email'] for v in roster.values())), flush=True)

    months = months_to_sync(args.month)
    # One padded window covering every month this run needs, so the walk
    # query runs once (not once per month) and still never risks the
    # unbounded-query mistake caught in testing -- see build_walk_query()'s
    # docstring. One day of padding on each side is enough to absorb the
    # UTC/Eastern offset at either boundary.
    all_starts = [date(y, m, 1) for y, m, _ in months]
    all_ends = [date(y, m, calendar.monthrange(y, m)[1]) for y, m, _ in months]
    pad_start = min(all_starts) - timedelta(days=1)
    pad_end = max(all_ends) + timedelta(days=1)

    print('Querying QAI/QAA/NHO/NHA walk assignments (%s to %s)...' % (pad_start, pad_end), flush=True)
    walk_records = run_sf_query(build_walk_query(pad_start, pad_end), args.alias)
    print('  %d OLH homesites with a walk in this window.' % len(walk_records), flush=True)

    # Surface Salesforce activity under names with no QAM account at all
    # (roster miss) or under the two known non-QAM names, once per run
    # rather than once per month -- the set doesn't change month to month.
    all_walk_managers = set()
    for r in walk_records:
        for field in ('QAI_Manager__r.Name', 'QAA_Manager__r.Name',
                      'Celebration_Manager__r.Name', 'Acceptance_Manager__r.Name'):
            n = g(r, field)
            if n:
                all_walk_managers.add(n)
    unmatched = sorted(n for n in all_walk_managers if n not in roster and n not in KNOWN_NON_QAM_NAMES)
    non_qam_active = sorted(n for n in all_walk_managers if n in KNOWN_NON_QAM_NAMES)
    if unmatched:
        print('NOTE: Salesforce walk-manager name(s) with no QA Manager account match: %s'
              % ', '.join(unmatched), flush=True)
    if non_qam_active:
        print('NOTE: Salesforce QAI/walk activity for non-QAM accounts (excluded from sync): %s'
              % ', '.join(non_qam_active), flush=True)

    for year, mon, month_label in months:
        print('\n=== %s ===' % month_label, flush=True)
        start = date(year, mon, 1)
        last_day = calendar.monthrange(year, mon)[1]
        end = date(year, mon, last_day)

        # ---- Walk completion counts, bucketed by Eastern clock time -----
        walk_counts = defaultdict(lambda: {'qai': 0, 'qaa': 0, 'nho': 0, 'nha': 0})
        walk_defs = [
            ('qai', 'QAI_Walk_Date_Time__c', 'QAI_Manager__r.Name'),
            ('qaa', 'QA_Walk_1_Date__c', 'QAA_Manager__r.Name'),
            ('nho', 'Walk_Through_1_Date__c', 'Celebration_Manager__r.Name'),
            ('nha', 'Acceptance_Date__c', 'Acceptance_Manager__r.Name'),
        ]
        for r in walk_records:
            for key, datefield, mgrfield in walk_defs:
                et = to_et(g(r, datefield))
                if et is None or et.year != year or et.month != mon:
                    continue
                mgr = g(r, mgrfield)
                if not mgr:
                    continue
                walk_counts[mgr][key] += 1

        # ---- Homes closed this month, by QAI manager --------------------
        print('Querying homes closed %s to %s...' % (start, end), flush=True)
        closed_homes = run_sf_query(build_closed_homes_query(start, end), args.alias)
        print('  %d homes closed.' % len(closed_homes), flush=True)

        homes_by_mgr = defaultdict(list)
        for h in closed_homes:
            mgr = g(h, 'QAI_Manager__r.Name')
            if mgr:
                homes_by_mgr[mgr].append(h['Id'])

        # ---- Qualifying work orders (0-29 days since COE) on those homes -
        issues_by_mgr = defaultdict(int)
        all_ids = [hid for ids in homes_by_mgr.values() for hid in ids]
        if all_ids:
            print('Querying qualifying work orders for %d closed homesite(s)...' % len(all_ids), flush=True)
            # Chunk the IN clause defensively -- fine at this volume (a few
            # hundred homes/month), but avoids an unbounded query string if
            # OLH closing volume ever spikes.
            cases = []
            for i in range(0, len(all_ids), 300):
                cases += run_sf_query(build_case_query(all_ids[i:i + 300]), args.alias)
            print('  %d cases pulled before the trade-partner exclusion.' % len(cases), flush=True)

            excluded = 0
            homesite_to_mgr = {hid: mgr for mgr, ids in homes_by_mgr.items() for hid in ids}
            for c in cases:
                tp = (g(c, 'WO_Trade_Partner_to_Group_By_Lookup__r.Name') or '')
                if TRADE_PARTNER_EXCLUDE.lower() in tp.lower():
                    excluded += 1
                    continue
                mgr = homesite_to_mgr.get(g(c, 'Homesite__c'))
                if mgr:
                    issues_by_mgr[mgr] += 1
            print('  %d excluded for "%s" trade partner, %d counted.'
                  % (excluded, TRADE_PARTNER_EXCLUDE, sum(issues_by_mgr.values())), flush=True)

        now = datetime.now(timezone.utc).isoformat()
        existing = fetch_existing_for_month(month_label) if not args.dry_run else {}

        # Union of every manager name seen in either metric group this month,
        # restricted to the known roster (see KNOWN_NON_QAM_NAMES/unmatched above).
        all_names = sorted(set(walk_counts.keys()) | set(homes_by_mgr.keys()))
        creates, updates = [], []
        for name in all_names:
            acct = roster.get(name)
            if not acct:
                continue  # already logged above, once per run

            wc = walk_counts.get(name, {'qai': 0, 'qaa': 0, 'nho': 0, 'nha': 0})
            n_homes = len(homes_by_mgr.get(name, []))
            n_issues = issues_by_mgr.get(name, 0)
            avg = round(n_issues / n_homes, 2) if n_homes else 0

            fields = {
                'Key': acct['email'] + '|' + month_label,
                'QAM Name': acct['name'],
                'QAM Email': acct['email'],
                'Division': DIVISION,
                'Bonus Month': month_label,
                'QAI Walks (SF)': wc['qai'],
                'QAA Walks (SF)': wc['qaa'],
                'NHO Walks (SF)': wc['nho'],
                'NHA Walks (SF)': wc['nha'],
                'Homes Closed (SF)': n_homes,
                'Issues Within 30 Days (SF)': n_issues,
                'Avg Issues Per Home (SF)': avg,
                'Last Synced': now,
                'Sync Run Note': ('%d QAI, %d QAA, %d NHO, %d NHA walks; %d homes closed with '
                                  '%d qualifying work orders (%.2f avg/home)') % (
                    wc['qai'], wc['qaa'], wc['nho'], wc['nha'], n_homes, n_issues, avg),
            }

            hit = existing.get(acct['email'])
            if hit:
                updates.append({'id': hit['id'], 'fields': fields})
            else:
                creates.append({'fields': fields})

        print('  %d QAM(s) with activity this month: %d update, %d create.'
              % (len(all_names), len(updates), len(creates)), flush=True)

        if args.dry_run:
            print('  DRY RUN -- nothing written.', flush=True)
            continue

        n1 = write_batches('update', updates)
        n2 = write_batches('create', creates)
        print('  Wrote %d update(s), %d create(s).' % (n1, n2), flush=True)

    print('\nDone.', flush=True)


if __name__ == '__main__':
    main()
