---
name: pbdb-occurrences
description: Retrieve bounded PBDB taxon and occurrence evidence.
---

# PBDB occurrences

Resolve the exact taxon, including any accepted-name synonym relationship, retrieve deterministic bounded pages, preserve every raw response and provider record identity, and report truncation. Preserve `cf.`, `aff.`, and other qualified identifications verbatim. Keep absent ages, coordinates, stratigraphic units, and references as null; do not impute them. Reject duplicate occurrence identifiers and stop on ambiguous or stale accepted taxonomy. Treat numerical ages as intervals.

This workflow can establish occurrence coverage and collection context only. It cannot establish anatomical measurements, molecular preservation, endogenous DNA, a genome, embryo viability, hatching, or de-extinction feasibility.
