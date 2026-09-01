---
name: omori-utsu-analysis
description: Fit a bounded, provenance-auditable Omori–Utsu aftershock decay model only when the researcher supplies every time, completeness, magnitude, bin, and parameter boundary.
---

# Omori–Utsu aftershock analysis

1. Obtain one complete first-page catalog with `search_usgs_earthquakes`. Narrow the time, magnitude, or spatial query until `pagination.completeness` is `page-complete`; never splice pages or discard the raw/normalized receipts.
2. Ask the researcher for the mainshock instant, inclusive observation start/end, the time after which the catalog is considered complete, magnitude completeness `Mc`, one exact magnitude type, fixed rate-bin width in seconds, and bounded `p` and `c` ranges. Do not infer any of these scientific boundaries.
3. Call `analyze_usgs_omori_utsu`. Treat only `status: complete` as an interior numerical optimum. Surface `insufficient-data` and every `statusReasons` item. A parameter-boundary optimum is `invalid`; widen or scientifically revise the bounds rather than relabeling it.
4. Keep the event audit, publication table, both Vega-Lite payloads, source hashes, content receipts, and overall analysis SHA-256 together. Zero-count bins are observations and must remain in tables and residual diagnostics.
5. Report `p`, `c` in seconds, and `K` with its declared unit. State that the model is a single-sequence non-homogeneous Poisson fit and does not model background seismicity, secondary triggering, declustering, confidence intervals, forecast skill, or causality.

The host supplies Vega rendering. This plugin returns deterministic specifications and does not bundle a renderer.
