---
name: ensembl-compara-gene-tree
description: Retrieve a version-receipted rooted Ensembl Compara gene tree for an extant taxon and preserve its scientific claim boundaries.
---

# Ensembl Compara gene tree

1. Resolve one extant Ensembl stable gene ID and reference species.
2. Ask which extant NCBI taxon should prune the returned tree and whether protein or cDNA is required.
3. Call `build_comparative_genomics_gene_tree` and retain both the Ensembl data-release Source and gene-tree Source.
4. Inspect duplication and gene-split nodes before treating any sequence as a one-to-one ortholog.
5. Treat the provider alignment and rooted gene tree as inferred, not observed ancestry.
6. The root is the MRCA of the returned extant lineages. Never rename it as a named extinct terminal species.
7. If the user needs publication-grade ASR, create a later local alignment/model/topology sensitivity plan. This workflow does not emit ancestral sequences.
