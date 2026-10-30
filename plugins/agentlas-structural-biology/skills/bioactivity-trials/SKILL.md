---
name: bioactivity-trials
description: Pull curated potency (ChEMBL) and trial registration (ClinicalTrials.gov) evidence for compounds and targets, with mutation filtering and bounded summaries.
---

# Bioactivity and trials

1. `fetch_chembl_activities`: give `molecule_name` or `molecule_chembl_id`, and `target_query` or `target_chembl_id`; set `activity_types` (default IC50) and `mutation` (e.g. G12C) when a variant matters. Report the aggregates (median nM, pChEMBL, record counts) and name the assays behind the strongest values. Censored values (<, >) are counted but not averaged.
2. `fetch_clinical_trials`: search by `intervention` and/or `condition`, filter `phases` and `statuses`. Report NCT IDs, phase, status, enrollment and dates. Registry entries are protocols; efficacy numbers (ORR, PFS) need posted results or publications.
3. Keep the provenance receipt with any table built from these results. Use `view: "full"` or a larger `max_results` only when the summary does not hold the field you need.
