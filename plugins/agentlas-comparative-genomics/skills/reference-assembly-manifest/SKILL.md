---
name: reference-assembly-manifest
description: Pin extant Ensembl reference assemblies to exact provider metadata, accessions, FASTA locators, and checksums before comparative sequence analysis.
---

# Extant reference assembly manifest

1. Resolve 2–8 exact lowercase Ensembl species names; do not silently substitute unavailable taxa.
2. Call the host `build_extant_reference_assembly_manifest` operation from the Agentlas Science project conversation.
3. Preserve every exact release, genome, assembly, README, and CHECKSUMS Source and the ResearchRun-to-table binding.
4. Confirm the assembly accession matches across genome metadata, assembly metadata, and README.
5. Report the selected `.dna.toplevel.fa.gz` locator and provider BSD sum exactly as returned.
6. Do not call the provider checksum SHA-256. Do not claim FASTA content, annotation content, BUSCO quality, chromosome homology, or base-level analysis unless a later run downloads and validates those assets.
7. These records describe extant assemblies only. They cannot support an extinct genome, ancestral sequence, phenotype, embryo, or hatching claim.
