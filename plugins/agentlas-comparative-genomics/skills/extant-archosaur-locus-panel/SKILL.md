# Extant archosaur locus panel

Use this workflow only after a succeeded Ensembl Compara cDNA gene-tree run and a succeeded extant reference-assembly manifest run are available in the same Science project.

Select two to four extant avian leaves and two to four extant crocodilian leaves. The deterministic operation computes the within-tree MRCA/path quality, cross-group callable and differing site bins, and an editable publication table plus Vega figure. It intentionally emits no raw aligned sequence, ancestral sequence, extinct-species genome, chromosome reconstruction, phenotype, embryo, viability, or hatching claim.

Treat `candidate-for-exploratory-asr` as a workflow gate only. `review-required` and `blocked` must be surfaced to the researcher before any downstream hypothetical analysis. Preserve the returned ResearchRun and artifact lineage when inserting the table or figure into a manuscript.
