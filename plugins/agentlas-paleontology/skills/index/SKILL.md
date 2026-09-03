---
name: agentlas-paleontology
description: Retrieve and reason over evidence-bounded fossil taxon and occurrence records with exact provenance.
---

# Agentlas Paleontology

Use PBDB occurrence evidence only for taxonomic, geographic, stratigraphic, temporal, and literature-reference claims. Preserve exact identified and accepted names, synonym relationships, qualified identifications, nulls, age intervals, coordinates and precision, and source hashes. Reject duplicate provider occurrence identifiers instead of silently deduplicating them. Never relabel these records as morphology, DNA, genome, embryo, hatching, or de-extinction evidence.

For a dinosaur revival question, route to `deextinction-feasibility`. The workflow must remain an evidence and feasibility assessment and must hand off its stage ledger to the built-in Research Director.
