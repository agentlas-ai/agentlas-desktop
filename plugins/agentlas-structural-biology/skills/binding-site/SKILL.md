---
name: binding-site
description: Summarize the residues around a bound ligand from deposited coordinates, including covalent attachment, for comparison across complexes.
---

# Binding site

1. Identify the ligand component ID from `fetch_protein_structure` (analysis.ligandInstances) or the search hit's ligand list.
2. Call `describe_binding_site` with `pdb_id` and `ligand_id` (and `chain_id` when the entry has several copies). The default radius is 4.5 Å.
3. Report residues by distance, the declared covalent bond (struct_conn covale) and any heavy-atom pair under 2.2 Å, and cofactors in the pocket (for KRAS G12C inhibitors: Cys12 and the switch-II pocket residues).
4. The `molstarView.interaction` focuses Mol* on the ligand and its pocket residues. The residue list is a distance criterion on deposited coordinates, not an energy or docking score; say so when comparing complexes.
