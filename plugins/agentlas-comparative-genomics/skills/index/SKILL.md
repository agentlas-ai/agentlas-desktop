---
name: comparative-genomics
description: Retrieve and inspect version-receipted Ensembl Compara gene trees and aligned extant sequences without promoting them to extinct-species genomes.
---

# Comparative genomics

Use this workflow when a question requires versioned extant reference assemblies or relationships among extant gene-family sequences.

1. Before base-level comparative work, call `build_extant_reference_assembly_manifest` for 2–8 exact extant Ensembl species. Preserve the exact release, genome, assembly, README, and CHECKSUMS Sources. The returned FASTA checksum is a provider BSD sum, not SHA-256, and does not prove the FASTA was downloaded.
2. Ask for or resolve one extant Ensembl gene ID, a reference species, sequence type, and an extant NCBI taxon to prune the tree.
3. Call the host `build_comparative_genomics_gene_tree` operation. Preserve its exact release and tree response receipts.
4. Treat returned sequence records as observed provider bytes, but orthology, paralogy, alignment, rooting, and the gene tree as inferred.
5. Inspect duplication/gene-split warnings and low-support branches before selecting a one-to-one ortholog.
6. When the alignment-QC table must be edited or inserted into a manuscript, call `materialize_comparative_genomics_publication_table` with the exact parent run ID. Use the returned independent table artifact, not the display-only table embedded in the phylogeny payload.
7. Use the resulting phylogeny and table in the manuscript only through their exact ResearchRun-to-artifact bindings.
8. Do not call the returned root a named extinct terminal species. It denotes only the MRCA of the extant lineages in the returned tree.
9. For an exploratory internal-node inspection only, `run_hypothetical_asr_fitch` may compute deterministic ambiguity sets from a strictly bifurcating rooted tree and observed extant DNA alignment. Open its site-table and ambiguity-Figure artifact in the Comparative Genomics Lab, and keep every site and the whole result labelled `hypothetical`.
10. This plugin does not provide publication-grade ancestral sequence reconstruction. If the user asks for publishable ASR, an extinct genome, phenotype, embryo, viability, or hatching result, stop at the missing model/topology-sensitivity/experimental-validation stage. Never present a Fitch display sequence as a recovered genome.
