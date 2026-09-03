---
name: alignment-qc
description: Inspect gap, missingness, branch support, and duplication warnings in a sealed Ensembl Compara alignment before downstream inference.
---

# Alignment QC

1. Open the exact comparative-genomics artifact and its ResearchRun-bound QC table.
2. Review alignment length, per-sequence non-gap length, gap fraction, missing fraction, gene/protein IDs, and sampled extant taxa.
3. Flag high-gap or non-overlapping sequences instead of filling missing columns.
4. Review every duplication, gene-split, and low-support branch before selecting an ortholog or target MRCA.
5. A single provider alignment is one homology hypothesis. Record that local alternative alignment, model, and topology sensitivity have not yet been run.
6. Bind the exact artifact version and publication table to the manuscript only after visual capture and publication validation.
