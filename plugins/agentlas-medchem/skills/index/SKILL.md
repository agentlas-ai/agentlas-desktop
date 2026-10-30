---
name: agentlas-medchem
description: Medicinal-chemistry calculations with RDKit — molecular properties, drug-likeness (Lipinski, Veber, QED), structural alerts, SMILES standardization and compound grid drawings, with Ketcher-ready SMILES for every molecule.
---

# Medchem router

- `$properties` — property table, rule results and alerts for 1-50 molecules (`compute_molecular_properties`).
- `$structures` — clean input structures (`standardize_smiles`) and draw a labelled 2D grid (`draw_compound_grid`).

RDKit runs in this plugin's own managed Python environment, installed once from PyPI binary wheels when the plugin first starts. A result with `status: "runtime-preparing"` means that install is still running; `describe_medchem_runtime` shows its state. Every molecule row carries a `ketcher` handoff whose `input` is exactly the title and SMILES that Agentlas Science's `agentlas.smiles-to-ketcher` accepts.
