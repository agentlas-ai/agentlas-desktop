---
name: analysis
description: Run the deterministic physics analysis catalogue (peak fits, significance and limits, uncertainty propagation, dimensional analysis, ODE simulation, signal spectra, York fits, teaching-lab checks) with declared boundaries and exact lineage.
---

# Physics analysis catalogue

1. For table-based analyses (`fit_physics_spectrum_peaks`, `analyze_physics_signal`, `fit_physics_york_line`, `check_physics_lab_experiment`) first materialize the measurement table with `$physics-dataset`; inside Agentlas Science pass its `dataset_run_id`, standalone pass the normalized `table`. Column names refer to that table and units come from its column declarations.
2. Parameter analyses (`compute_physics_significance_limits`, `propagate_physics_uncertainty`, `analyze_physics_units`, `simulate_physics_ode`) take explicit numbers; state every input the result depends on (background uncertainty, seed, tolerances, unit strings).
3. Starting values for peak fits and York fits are the caller's responsibility: read them off the data first, then check `summary.converged`, `stopReason`, `at-bound` parameters, and χ²/ndf before quoting any parameter.
4. Every result carries `boundaries` (method limits) and `warnings` (data-specific cautions). Quote them with the numbers; never promote an asymptotic or first-order result beyond what the boundaries allow.
5. Preserve `analysisSha256` and `figure.figureSha256` with the publication table and the Vega figure; a replay with the same inputs reproduces both hashes.
6. Cross-check expectations: each analysis has a numpy/scipy oracle under `tests/<name>-crosscheck.py`; tolerances are documented in `docs/science/physics-tools.md`.
