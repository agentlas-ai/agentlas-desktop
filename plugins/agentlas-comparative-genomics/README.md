# Agentlas Comparative Genomics

This plugin first supports a host-run reference-assembly manifest that cross-checks each extant Ensembl species across the release receipt, genome metadata, assembly metadata, FASTA README, and provider CHECKSUMS. It records the exact toplevel FASTA locator and provider BSD checksum in an editable publication table, while explicitly recording that the sequence file was not downloaded or cryptographically verified.

It also retrieves a bounded, rooted Ensembl Compara gene tree with its provider alignment and current Ensembl release receipt. It emits a publication-ready alignment QC table and a Vega tree artifact while preserving the distinction between observed extant sequence bytes, inferred orthology/alignment/tree structure, and hypothetical ancestral states.

The embedded alignment-QC table is a display receipt. For editing or manuscript insertion, the host materializes it into an independently versioned `agentlas.table` artifact whose child ResearchRun seals the exact parent output bytes and can generate editable DOCX and LaTeX tables.

For a deliberately narrow exploratory workflow, the plugin can compute deterministic Fitch-parsimony ambiguity sets for one explicitly selected, non-root internal node. The host accepts this only from a sealed comparative-genomics ResearchRun containing a strictly bifurcating rooted tree and observed extant cDNA alignment. It persists an exact site table and interactive ambiguity Figure in the Comparative Genomics Lab so the researcher can inspect and cite the bounded exploratory result. The result is always labelled `hypothetical`; it has no posterior probabilities, likelihood, confidence, phenotype, organism-level, or feasibility interpretation.

It deliberately does not emit publication-grade ancestral sequences, extinct-species DNA, species-level extinct genomes, chromosome reconstructions, phenotype claims, embryo viability, or hatching claims. A provider gene tree is one model-conditioned homology hypothesis; duplication nodes and low-support branches remain visible. The Fitch operation is a provenance and interaction green slice, not a substitute for alignment sensitivity, substitution-model selection, topology sensitivity, probabilistic ASR, or experimental validation.

Provider documentation:

- <https://rest.ensembl.org/documentation/info/genetree_species_member_id>
- <https://rest.ensembl.org/documentation/info/data>
