---
name: properties
description: Compare compounds by RDKit-calculated properties and drug-likeness rules, reporting calculated values as calculations.
---

# Properties and drug-likeness

1. Collect each compound's SMILES from a source (ChEMBL, PDB ligand, PubChem or the user) and keep its name.
2. Call `compute_molecular_properties` with all compounds in one call. The `table` is ready for a comparison table; per-molecule rows hold rule results and PAINS/Brenk alerts.
3. Report MW, cLogP, TPSA, HBD/HBA, rotatable bonds, QED and rule results as RDKit calculations (Crippen cLogP, Ertl TPSA, Bickerton QED), not measurements. A Brenk Michael-acceptor alert on an acrylamide is the covalent warhead of inhibitors such as sotorasib.
4. Use `view: "full"` for InChI, QED components, alert names and molfiles.
