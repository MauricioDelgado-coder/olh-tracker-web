#!/usr/bin/env python3
"""
One-time sync: Dynamics 'QA - All Homes' export -> Airtable Jobs table.

    python3 dev/sync_qa_export_to_airtable.py --in dev/qa_export.csv --dry-run
    python3 dev/sync_qa_export_to_airtable.py --in dev/qa_export.csv --apply

Rule for every field this script touches: fill-if-blank only. If the Airtable
field already has a value (checked box, a date, a linked manager, a note), this
script leaves it alone -- it never overwrites and never unchecks a box. That
was Mauricio's explicit call for every field below, since these are the same
manually-maintained fields the daily Salesforce sync already refuses to touch.

Column map (CSV -> Airtable field), decided field-by-field with Mauricio:
    BusinessUnit               -> Job # (join key; CSV's "BusinessUnit" column
                                   is actually the homesite job number)
    QAI Manager                -> QAI Manager      (linked record, Managers)
    QAA Manager                -> QAA Manager      (linked record, Managers)
    CEL CRM                    -> CEL Manager       (linked record, Managers)
    ACC CRM                    -> ACC Manager       (linked record, Managers)
    CEL Letter Sent            -> CEL Letter Sent   (checkbox)
    QAI Date                   -> QAI Date          (date)
    QAA Date                   -> QAA Date          (date)
    CEL Date                   -> CEL Date          (dateTime)
    ACC Date                   -> ACC Date          (dateTime)
    Closing Date (Scheduled)   -> SKIPPED -- owned by the daily D365 sync
    DOC Validation Y/N         -> QA Ready          (checkbox)
    QAI Completed              -> QAI Complete      (checkbox)
    QAA Accepted                -> QAA Accepted      (checkbox)
    CEL Completed               -> CEL Completed     (checkbox)
    Ready to Close               -> ACC Completed     (checkbox)
    Construction Risk            -> Construction Risk (checkbox)
    Construction Risk Details    -> Construction Risk Notes (multilineText)
    Land Risk                    -> Land Risk         (checkbox)
    Land Risk Details            -> Land Risk Notes    (multilineText)
    Insulation NOC Lock Date     -> NOC Lock Date      (date)
    Electric Meter                -> Power Meter        (checkbox)
    Water Meter                   -> Water Meter        (checkbox)
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE_ID = 'appYX9df4lGO6G2uz'
JOBS_TABLE = 'tblqpmwtZ6i4gtogl'
MANAGERS_TABLE = 'tble8SiAKDLl7eS5D'
AIRTABLE_API = 'https://api.airtable.com/v0'


def die(msg):
    sys.exit('ERROR: ' + msg)


def pat():
    v = os.environ.get('AIRTABLE_PAT', '').strip()
    if not v:
        die('AIRTABLE_PAT is not set. Try:\n'
            '  AIRTABLE_PAT=$(netlify env:get AIRTABLE_PAT | grep -o "pat[A-Za-z0-9._]*") \\\n'
            '    python3 dev/sync_qa_export_to_airtable.py --in dev/qa_export.csv --dry-run')
    return v


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
    """Every record in a table, paginated 100 at a time."""
    records, offset = [], None
    while True:
        path = '/%s?pageSize=100%s' % (table_id, ('&offset=' + offset) if offset else '')
        page = airtable('GET', path)
        records.extend(page.get('records', []))
        offset = page.get('offset')
        if not offset:
            break
    return records


def build_jobs_index(records):
    """Job # -> record. Reports blanks and duplicates rather than hiding them."""
    by_job, blank, dupes = {}, [], {}
    for r in records:
        job = str((r.get('fields') or {}).get('Job #', '')).strip()
        if not job:
            blank.append(r['id'])
        elif job in by_job:
            dupes.setdefault(job, [by_job[job]['id']]).append(r['id'])
        else:
            by_job[job] = r
    return by_job, blank, dupes


def build_managers_index(records):
    """Name (lowercased, trimmed) -> record id. Airtable Managers table."""
    by_name = {}
    for r in records:
        name = str((r.get('fields') or {}).get('Name', '')).strip()
        if name:
            by_name[name.lower()] = r['id']
    return by_name


# Name mismatches between the CSV and the Managers table, confirmed with
# Mauricio 2026-08-05: nicknames for the same two people, and Markennis
# Calhoun in the CSV is the same person as Kenny Calhoun in Managers.
# Jeffery Myers and Clinton Persaud are not in Managers at all and are left
# unresolved on purpose (their rows' manager fields stay blank).
NAME_ALIASES = {
    "kristopher o'dell": "kris o'dell",
    "jeffrey boyd": "jeff boyd",
    "markennis calhoun": "kenny calhoun",
}


# ---------------------------------------------------------------------------
# Column map. Each entry: csv_column -> (airtable_field, kind)
#   kind is one of: checkbox, date, datetime, note, link
# 'Closing Date (Scheduled)' is deliberately absent -- owned by the daily sync.
# ---------------------------------------------------------------------------
LINK_FIELDS = {
    'QAI Manager': 'QAI Manager',
    'QAA Manager': 'QAA Manager',
    'CEL CRM': 'CEL Manager',
    'ACC CRM': 'ACC Manager',
}

CHECKBOX_FIELDS = {
    'CEL Letter Sent': 'CEL Letter Sent',
    'DOC Validation Y/N': 'QA Ready',
    'QAI Completed': 'QAI Complete',
    'QAA Accepted': 'QAA Accepted',
    'CEL Completed': 'CEL Completed',
    'Ready to Close': 'ACC Completed',
    'Construction Risk': 'Construction Risk',
    'Land Risk': 'Land Risk',
    'Electric Meter': 'Power Meter',
    'Water Meter': 'Water Meter',
}

DATE_FIELDS = {
    'QAI Date': 'QAI Date',
    'QAA Date': 'QAA Date',
    'Insulation NOC Lock Date': 'NOC Lock Date',
}

DATETIME_FIELDS = {
    'CEL Date': 'CEL Date',
    'ACC Date': 'ACC Date',
}

NOTE_FIELDS = {
    'Construction Risk Details': 'Construction Risk Notes',
    'Land Risk Details': 'Land Risk Notes',
}

SKIPPED_COLUMNS = {'Closing Date (Scheduled)'}


def is_yes(v):
    return str(v).strip().lower() == 'yes'


def is_blank(v):
    if v is None:
        return True
    s = str(v).strip().lower()
    return s in ('', 'nat', 'nan', 'none')


def date_only(v):
    """CSV dates come as 'YYYY-MM-DDTHH:MM:SS' -- keep just the date part."""
    return str(v).strip().split('T')[0]


def plan_row_update(csv_row, job_fields, managers_by_name, unresolved_managers):
    """Returns (fields_to_write, field_change_log) for one CSV row against the
    current Airtable fields of its matched Job record. fill-if-blank only."""
    fields = {}
    changes = []

    for csv_col, at_field in CHECKBOX_FIELDS.items():
        raw = csv_row.get(csv_col)
        if is_yes(raw) and not job_fields.get(at_field):
            fields[at_field] = True
            changes.append(at_field)

    for csv_col, at_field in DATE_FIELDS.items():
        raw = csv_row.get(csv_col)
        if not is_blank(raw) and not job_fields.get(at_field):
            fields[at_field] = date_only(raw)
            changes.append(at_field)

    for csv_col, at_field in DATETIME_FIELDS.items():
        raw = csv_row.get(csv_col)
        if not is_blank(raw) and not job_fields.get(at_field):
            fields[at_field] = str(raw).strip()
            changes.append(at_field)

    for csv_col, at_field in NOTE_FIELDS.items():
        raw = csv_row.get(csv_col)
        if not is_blank(raw) and not job_fields.get(at_field):
            fields[at_field] = str(raw).strip()
            changes.append(at_field)

    for csv_col, at_field in LINK_FIELDS.items():
        raw = csv_row.get(csv_col)
        if is_blank(raw):
            continue
        if job_fields.get(at_field):
            continue
        lookup_name = str(raw).strip().lower()
        lookup_name = NAME_ALIASES.get(lookup_name, lookup_name)
        rec_id = managers_by_name.get(lookup_name)
        if rec_id:
            fields[at_field] = [rec_id]
            changes.append(at_field)
        else:
            unresolved_managers.setdefault(str(raw).strip(), 0)
            unresolved_managers[str(raw).strip()] += 1

    return fields, changes


def write_batches(payload, apply_):
    # Airtable rejects a batch that updates the same record id twice (this
    # happens when the CSV has duplicate Job #s pointing at one Airtable
    # row). Merge by record id first-write-wins so each id appears once.
    merged = {}
    for item in payload:
        if item['id'] not in merged:
            merged[item['id']] = dict(item['fields'])
        else:
            for k, v in item['fields'].items():
                merged[item['id']].setdefault(k, v)
    payload = [{'id': rid, 'fields': f} for rid, f in merged.items()]

    if not payload:
        return 0
    if not apply_:
        return len(payload)
    done = 0
    for i in range(0, len(payload), 10):
        chunk = payload[i:i + 10]
        airtable('PATCH', '/' + JOBS_TABLE, {'records': chunk, 'typecast': True})
        done += len(chunk)
        if done % 100 == 0 or done == len(payload):
            print('    updated %d/%d' % (done, len(payload)), flush=True)
        time.sleep(0.25)
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='infile', required=True)
    ap.add_argument('--apply', action='store_true',
                     help='Actually write. Default is a dry run.')
    args = ap.parse_args()
    apply_ = args.apply

    print('Fetching current Jobs and Managers from Airtable...', flush=True)
    jobs_records = fetch_all(JOBS_TABLE)
    managers_records = fetch_all(MANAGERS_TABLE)
    jobs_by_job, blank_jobs, dupe_jobs = build_jobs_index(jobs_records)
    managers_by_name = build_managers_index(managers_records)
    print('  %d Jobs rows, %d Managers rows' % (len(jobs_records), len(managers_records)))

    with open(args.infile, newline='', encoding='utf-8') as fh:
        csv_rows = list(csv.DictReader(fh))
    print('  %d rows in %s' % (len(csv_rows), args.infile))


    seen_csv_jobs, csv_dupes = set(), []
    unmatched, unresolved_managers = [], {}
    field_change_counts = {}
    payload = []
    rows_with_changes = 0

    for row in csv_rows:
        job = str(row.get('BusinessUnit', '')).strip()
        if not job:
            continue
        if job in seen_csv_jobs:
            csv_dupes.append(job)
        seen_csv_jobs.add(job)

        at_record = jobs_by_job.get(job)
        if not at_record:
            unmatched.append(job)
            continue

        fields, changes = plan_row_update(
            row, at_record.get('fields') or {}, managers_by_name, unresolved_managers)
        if fields:
            rows_with_changes += 1
            payload.append({'id': at_record['id'], 'fields': fields})
            for c in changes:
                field_change_counts[c] = field_change_counts.get(c, 0) + 1

    print()
    print('=== %s ===' % ('APPLY' if apply_ else 'DRY RUN'))
    print('CSV rows with a Job #:      %d' % len(seen_csv_jobs))
    print('CSV duplicate Job #s:       %d' % len(csv_dupes))
    print('Matched an Airtable Job:    %d' % (len(seen_csv_jobs) - len(unmatched)))
    print('No matching Airtable Job:   %d' % len(unmatched))
    print('Rows that would change:     %d' % rows_with_changes)
    print()
    print('Field-level writes (fill-if-blank only):')
    for f in sorted(field_change_counts, key=lambda k: -field_change_counts[k]):
        print('  %-28s %d' % (f, field_change_counts[f]))
    if unresolved_managers:
        print()
        print('Manager names in the CSV with no match in the Managers table:')
        for name, n in sorted(unresolved_managers.items(), key=lambda kv: -kv[1]):
            print('  %-28s (%d rows)' % (name, n))
    if unmatched:
        print()
        print('First 20 unmatched Job #s: %s' % ', '.join(unmatched[:20]))
    if dupe_jobs:
        print()
        print('WARNING: %d duplicate Job #s already exist in Airtable' % len(dupe_jobs))

    written = write_batches(payload, apply_)
    print()
    print('%s %d row(s).' % ('Wrote' if apply_ else 'Would write', written))


if __name__ == '__main__':
    main()
