---
name: deextinction-feasibility
description: Decompose a dinosaur revival question into independently evidenced stages with explicit stop conditions and Research Director review.
---

# De-extinction feasibility

Treat “which dinosaur is most revivable, reconstruct its genome, and hatch it” as a sequence of testable evidence questions. Do not present the requested outcome as already feasible. Before comparing candidates, record exactly one objective: `actual-biological-revival` or `comparative-proxy-research`. Never put those objectives on one feasibility scale.

When comparing two or more candidates, call `assess_deextinction_feasibility` only with evidence classifications bound by the host to sealed ResearchRuns. The tool accepts no caller-authored score. Its soft research-evidence completeness is not a biological-feasibility score. PBDB coverage is shown separately and is excluded from completeness, gate decisions, and audit ordering; its biological-feasibility contribution is fixed at zero.

## Required stages

1. **Define the target.** Distinguish biological resurrection of a non-avian dinosaur from engineering a phenotype proxy in an extant avian lineage. Record which outcome the researcher means.
2. **Compare fossil candidates.** Run `analyze_paleontology_stratigraphic_support` for each exact PBDB catalog, then pass 2–20 exact catalog-run plus analysis-run pairs to `compare_fossil_candidate_evidence`. The tool derives taxonomic resolution, returned versus available occurrences, truncation, formation/interval/georeference/primary-reference coverage, separate oldest/youngest bounds, interval width, and missingness. It accepts no score and produces no scalar, ordinal, Pareto, revival, or biological-feasibility ranking. Treat `candidateOrdinal` only as request order. Preserve the descriptive matrix when a parent is truncated, disclose `truncated-parent-evidence`, and retrieve missing pages before making count comparisons outside the tool.
3. **Review molecular preservation.** Search primary literature for specimen-specific, independently authenticated endogenous molecules. Record material, specimen identifier, geological age, authentication controls, contamination tests, replication, molecule type, and usable sequence length. Fossil abundance is not molecular preservation evidence.
4. **Enrich museum holdings.** Query current GBIF or museum records for specimen and collection candidates. Preserve institution, catalog number, basis of record, identifiers, license, and access date. A museum occurrence is not a sequence or morphology measurement.
5. **Compare extant relatives.** Use separately sourced and versioned extant avian/crocodilian genomes, explicit orthology rules, species tree, alignments, missingness, and uncertainty. Do not label an extant-relative consensus as a dinosaur genome.
6. **Run hypothetical ASR.** Only after the comparative-genomics inputs exist, estimate alternative ancestral states with posterior support and sensitivity to topology/model choice. Label every result `hypothetical-ancestral-reconstruction`; never `recovered dinosaur sequence`.
7. **Assess development.** Separate regulatory architecture, chromosome organization, cell-line engineering, germ-line transmission, host compatibility, embryogenesis, and viable hatching into distinct tests. Comparative sequence similarity alone supports none of them.
8. **Handoff.** Send the evidence ledger, negative findings, artifact receipts, unresolved questions, and stop-condition status to the built-in Research Director before advancing a stage or drafting a conclusion.

## Actual biological revival hard stops

Stop advancement and report the failed gate unless observed, supporting, independently reviewable evidence exists for all four of:

- authenticated endogenous dinosaur DNA linked to the target specimen;
- a species-level nuclear genome and karyotype for the target;
- a viable target cell or nucleus;
- a validated avian embryo and surrogate platform capable of the claimed developmental path.

Taxonomy, fossil coverage, extant-relative genomes, orthology, ancestral-state uncertainty, and regulatory models remain important soft researchability or downstream-readiness evidence, but they do not replace or numerically offset a failed biological hard stop. Any attempt to relabel PBDB fossil records as morphology, DNA, a genome, an embryo, hatching, or de-extinction evidence is itself a claim-boundary failure.

The scientifically valid final result may be a negative or conditional feasibility assessment. Preserve that result rather than filling missing stages with model-generated sequence.
