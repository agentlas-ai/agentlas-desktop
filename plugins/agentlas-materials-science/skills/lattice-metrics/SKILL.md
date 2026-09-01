---
name: materials-lattice-metrics
description: Compute validated cell volume from a hash-verified CIF or OPTIMADE structure and withhold density unless all required crystallographic inputs are explicit.
---

# Lattice metrics

1. Bind one untampered normalized COD CIF or an OQMD OPTIMADE result plus exact structure ID.
2. Call `analyze_lattice_metrics`. COD volume uses the six cell parameters and the triclinic formula; OPTIMADE volume uses the absolute determinant of its three lattice vectors.
3. For CIF with `_cell_volume`, require the computed value to fall within the explicit relative tolerance. A mismatch fails closed.
4. Report density only when the normalized CIF explicitly contains composition, `_cell_formula_units_Z`, and `_chemical_formula_weight`. Never derive formula weight, atomic masses, Z, occupancy expansion, or symmetry equivalents.
5. Preserve the normalized source hash, raw CIF hash when present, analysis hash, constants, validation result, and publication table.
