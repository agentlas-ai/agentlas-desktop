---
name: physics-dataset
description: Normalize a bounded user measurement table without truncation and prepare a typed artifact for an installed statistics or Vega lab.
---

# Physics dataset

1. Define every column's name, number/string type, and optional unit.
2. Call `normalize_physics_dataset`; do not truncate rows or coerce non-finite values.
3. Preserve the canonical dataset URI and normalized hash with downstream analyses.
4. Open a host-provided Vega/statistics lab only after the dataset artifact is bound.

## Outputs

- A typed `agentlas.science-table/v1` inside an `agentlas.physics.user-dataset/v1` envelope.

## Verification

- Row width equals column count for every row.
- Row, column, and byte caps pass without truncation.
- The dataset URI contains the canonical table SHA-256.
