---
name: verify
description: Run the canonical package gate and recompute generated file hashes.
---

# Steps

1. Run `plugin-spec-gate.cjs` against the staged package.
2. Recompute every declared integrity hash against the actual file.
3. Return the gate's own violation wording when a rule fails, then repair and run again.

# Outputs

- A gate report containing pass/fail status and exact violation lines.

# Verification

- Install is unavailable while any violation remains.
- A passing report includes a manifest hash and a complete file coverage check.
