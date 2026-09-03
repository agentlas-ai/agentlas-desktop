---
name: agentlas-physics
description: Use real INSPIRE and HEPData records or bounded user datasets for physics research; preserve provenance and never invent measurements or simulations.
---

# Physics router

- Use `$search-inspire` for high-energy-physics literature discovery.
- Use `$hepdata` for public HEPData record metadata, a version-pinned official JSON table, or a supplied HEPData JSON body.
- Use `$hepdata-chi-square` only after a normalized table and unit-matched prediction vector exist.
- Use `$physics-dataset` for a bounded user measurement table.
- Use `$analysis` for the deterministic analysis catalogue: `fit_physics_spectrum_peaks`, `compute_physics_significance_limits`, `propagate_physics_uncertainty`, `analyze_physics_units`, `simulate_physics_ode`, `analyze_physics_signal`, `fit_physics_york_line`, `check_physics_lab_experiment`. Table-based analyses run on a completed `$physics-dataset` run.

The chi-square tool is an explicit independent-diagonal comparison, not a fit or covariance analysis. This package does not run detector simulation, ROOT, Geant4, lattice, symbolic, stiff-ODE, or PDE workloads; the ODE catalogue is an explicit non-stiff Dormand–Prince integrator over nine named systems.
