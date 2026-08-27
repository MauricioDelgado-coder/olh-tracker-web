# Field mapping — Airtable Jobs table vs. Salesforce

**Source of truth.** This file, not any copy uploaded to a Claude.ai skill,
is canonical. It lives in the repo next to the script it documents
(`dev/sync_coe_to_airtable.py`) so a field-mapping change and the code change
that goes with it land in the same commit and the same code review, instead
of drifting apart silently.

The `olh-airtable-sync` skill on Claude.ai carries its own copy of this file
(`references/field-mapping.md`) for sessions that don't have Desktop
Commander access to this repo. That copy is a **distribution mirror**,
refreshed by hand the same way `scripts/sync_coe_to_airtable.py` is — see
`dev/check-skill-mirror.sh`, which hashes both files and fails loudly if
either has changed here since the last upload. After editing this file AND
re-uploading it to the skill, run `bash dev/check-skill-mirror.sh --mark`.

Cross-check here before changing `COLUMN_MAP` or `EXTRA_FIELDS` in
`scripts/sync_coe_to_airtable.py`, and before assuming a blank field is a
data error rather than an intentional exclusion.

## Salesforce-sourced fields (synced automatically)

| Airtable Field | Salesforce Object.Field | Notes |
|---|---|---|
| Lot | `Homesite__c.Lot__c` | |
| Street Address | `Homesite__c.Homesite_Street__c` | |
| City | `Homesite__c.Homesite_City__c` | |
| Zip | `Homesite__c.Homesite_Postal_Code__c` | |
| Community | `Homesite__c.Homesite_Community__r.Name` | |
| Homesite Status | `Homesite__c.Homesite_Status__c` | |
| Lot Status | `Homesite__c.Lot_Status__c` | |
| Sale Date | `Homesite__c.Sale_Date__c` | |
| Actual Start Date | `Homesite__c.Actual_Start_Date__c` | |
| Construction Stage (JDE) | `Homesite__c.Construction_Stage_JDE__c` | |
| Projected Completion Date | `Homesite__c.Projected_Completion_Date__c` | |
| Actual Completion Date | `Homesite__c.Actual_Completion_Date__c` | The only field that means "complete" |
| Certificate of Occupancy Date | `Homesite__c.CofODate__c` | Permitting milestone, not completion |
| Estimated COE Date | `Homesite__c.Scheduled_Close_Date__c` | Label says "Estimated COE" and that is genuinely what it is — not the JDE ECOE duplicate |
| Construction Manager | `Homesite__c.Construction_Manager__c` | Anchor-tag HTML stripped |
| Assigned Concierge | `Homesite__c.Assigned_Concierge__c` | Anchor-tag HTML stripped |
| PHI Inspection Date | `Homesite__c.PHI_Inspection_Date__c` | Added 2026-08-26. Blank across the current no-COE scope as of that date — homes in this population haven't reached this milestone yet, not a sync gap |
| Home Inspection Report Received | `Homesite__c.HomeInspectionReportReceived__c` | Added 2026-08-26. Boolean — see "Boolean fields" note below |
| Home Inspection Approved | `Homesite__c.HomeInspectionApproved__c` | Added 2026-08-26. Boolean — see "Boolean fields" note below |
| Salesforce Id | `Homesite__c.Id` | |
| Address Dup Check | *derived* | Computed in the no-COE report, not a raw SF field |
| Construction Stage 7 (JDE) Date | *removed 2026-08-17* | Was pulled via supplementary SOQL; dropped at Mauricio's request after a supplementary-pull failure investigation. The field still exists on Homesite__c and the query still works — this was a product decision, not staleness |
| Scheduled Closing Date | `Opportunity.Scheduled_Closing_Date__c` (via `Homesite__c.Primary_Opportunity_ID__r`) | **Not** the Homesite ECOE — sourced from the linked Opportunity because it disagrees with ECOE on ~129/784 rows, often by weeks |
| CCC Date | `Opportunity.CCC_Date__c` (via `Homesite__c.Primary_Opportunity_ID__r`) | `Homesite__c.CCC_Date__c` is always null for OLH — moved to Opportunity intentionally, verified 2026-08-05 |

### Boolean fields

`Home Inspection Report Received` and `Home Inspection Approved` are the
first plain boolean fields pulled through `EXTRA_FIELDS` (everything else
there is a date). Salesforce's CSV export renders booleans as the literal
strings `"true"`/`"false"`; `supplementary()` converts those to a real Python
`bool` at the point of query, and `normalise()` routes them through
`norm_bool()` rather than `norm_text()` — comparing the string `"true"`
against the Airtable API's real `True` would report every row as changed on
every run. See the `kind == 'boolean'` branch in `sync_coe_to_airtable.py`
if extending this pattern to another boolean field.

## Derived, not a direct Salesforce field

| Airtable Field | Derived from |
|---|---|
| Bucket | Computed in the no-COE report (sold/committed vs. unsold + construction state) |
| Construction State | Computed from start/completion dates |
| Area Construction Manager | Looked up from `Community` via `scripts/acm-map.json` — no Salesforce field exists for this; blank means an unmapped community, not a missing manager |

## Sync-managed, not from Salesforce at all

| Airtable Field | Managed by |
|---|---|
| Record Status | Sync logic — Active/Closed based on presence in the current Salesforce pull |
| Closed Date | Sync logic |
| Last Synced | Sync logic — timestamp of the last field-level change, not the last run |

## Deliberately excluded from the sync

Per the script's own comments — these are intentional omissions, not oversights:

| Field | Why excluded |
|---|---|
| State | Constant `FL` on every row — a column of noise |
| Actual COE Date | Null by definition — the pull is rows *without* one |
| JDE Sched Close (ECOE) | Identical to Estimated COE Date in 1,378 of 1,389 rows — duplicate column |
| Construction Stage | Populated on only 3 of 1,400 OLH rows |

## Hand-entered fields — no Salesforce source, never overwritten by this sync

QA Ready, QAI Date, QAI Manager, QAI Complete, QAA Date, QAA Manager, QAA
Accepted, CEL Date, CEL Manager, CEL Completed, Buyer Attended CEL, ACC Date,
ACC Manager, ACC Completed, Buyer Attended ACC, NOC Lock Date, Power Meter,
Water Meter, Construction Risk, Construction Risk Notes, Land Risk, Land Risk
Notes, Key Status, Delivered To, Delivery Date, Notes, CEL Letter Sent.

The sync asserts this list and the Salesforce-owned list above are disjoint on
every run and refuses to write anything if they ever overlap — see
`assert_disjoint()` in `scripts/sync_coe_to_airtable.py`.

Construction Risk and Land Risk are a partial exception: the sync is allowed
to check (never clear) either one when Salesforce says the risk is real and
the box isn't already checked — see `POPULATE_IF_BLANK` and
`fetch_risk_flags()`. They stay in this hand-entered list because a leader
can still check or clear them freely; the sync only ever adds a checkmark it
didn't already see.
