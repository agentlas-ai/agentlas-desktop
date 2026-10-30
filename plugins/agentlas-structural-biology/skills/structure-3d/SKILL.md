---
name: structure-3d
description: Locate the right PDB entry or AlphaFold model for a target or drug and save it for 3D Mol* viewing with provenance.
---

# Structure for 3D viewing

1. If the PDB ID is not given, call `search_protein_structures` with what is known: free text, UniProt accession (KRAS = P01116), bound ligand component ID, or sequence. A drug may be deposited under its code name (sotorasib = AMG 510, component MOV in 6OIM); the ligand list of each hit shows the component IDs.
2. Call `fetch_protein_structure` with the chosen ID. Add `focus_ligand_id` when the question is about a bound drug; `representation` and `color_theme` set the initial view.
3. Report the entry facts (title, method, resolution, chains, ligands) and the saved files: the structure (`.cif`/`.pdb`), the Mol* view state (`.molstar.json`) and RCSB's assembly image (`_assembly-1.jpeg`).
4. In Agentlas Science, the `molstarView.scienceSourceQuery` is the exact entry for Science's own source retrieval; the resulting source version has the same content SHA-256 as `structure.sha256` and opens in Molecular Structure Lab with the same representation and colour theme.
5. For a target without an experimental structure, `fetch_alphafold_model` returns the predicted model with pLDDT bands and low-confidence segments; state that pLDDT is model confidence.
