---
name: agentlas-structural-biology
description: Drug-discovery structure and evidence lookup — find protein structures in RCSB PDB, open one for 3D (Mol*) viewing, fetch AlphaFold models, list the residues of a ligand binding site, and pull ChEMBL bioactivity and ClinicalTrials.gov registrations, each with exact provenance.
---

# Structural biology router

- `$structure-3d` — find an entry (`search_protein_structures`), then fetch it for 3D viewing (`fetch_protein_structure`) or fetch a predicted model (`fetch_alphafold_model`).
- `$binding-site` — residues, covalent bonds and a Mol* focus around one bound ligand (`describe_binding_site`).
- `$bioactivity-trials` — potency records (`fetch_chembl_activities`) and trial registrations (`fetch_clinical_trials`).

Every result carries a provenance receipt (URLs, status, byte hashes). Summary views are the default; ask for `view: "full"` only when the summary lacks a needed field. Structure files, the Mol* view state and RCSB's preview image are saved under `agentlas-structures/<ID>/` in the working folder; the `molstarView` object has the same shape as Agentlas Science's `agentlas.source-to-molstar` artifact, and inside Science its `scienceSourceQuery` names the exact entry Science retrieves to mint the source version with the same content hash.
