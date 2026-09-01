---
name: agentlas-astronomy
description: Route bounded sky-position questions to official SIMBAD, uncertainty-aware astrometric tables to deterministic kinematics, and irregular light curves to bounded generalized Lomb-Scargle analysis.
---

# Astronomy Router

Use `search_simbad_catalog` only when the user supplies or approves an ICRS center and cone radius. Prefer the smallest useful radius and result limit. Describe SIMBAD as an astronomical object database, not a complete catalogue or survey. Retain the request URL hash, exact raw-response hash, normalized hash, and provider limitations beside every derived table or artifact.

Use `analyze_astrometric_kinematics` only with an exact source-content SHA-256 and explicit nullable measurement fields. It may produce a publication table and Vega-Lite FigureSpec, but it must not be described as a rendered figure. Never impute absent errors or present naive inverse-parallax distance as a Bayesian estimate. Use `describe_astronomy_capabilities` when provider, calculation, or guard details matter.

Use `analyze_light_curve_periodicity` only after the time system, constant day offset, period bounds, frequency count, weighting policy, and exact source hash are explicit. Preserve nullable observations and user exclusions. Inspect the sampling-window curve and cadence warnings. A grid peak is not a detection probability: the tool deliberately does not compute a false-alarm probability, period interval, red-noise model, detrending, or a multi-harmonic/transit fit.
