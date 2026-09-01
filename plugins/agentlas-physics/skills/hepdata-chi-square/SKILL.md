---
name: hepdata-chi-square
description: Compare one normalized HEPData measurement series with an explicit prediction using caller-declared independent uncertainty labels and exact hash lineage.
---

# HEPData chi-square

1. Bind an untampered `agentlas.physics.hepdata-table/v1` artifact and choose one dependent-series index.
2. Supply exactly one prediction per point, preserving missing predictions as `null`; prediction units must exactly equal the HEPData series units.
3. Select only uncertainty labels that the scientific model explicitly treats as mutually independent. The tool combines those components in quadrature and uses the asymmetric side pointing from the measurement toward the prediction.
4. Inspect exclusions, residuals, pulls, chi-square contributions, degrees of freedom, reduced chi-square, and p-value. A missing selected component, zero uncertainty, unit mismatch, tampered hash, or nonpositive degrees of freedom fails closed.
5. Preserve `sourceLineage.normalizedTableSha256` and `analysisSha256` with the publication table and Vega artifacts.

Do not call this a fit. The tool does not estimate parameters or infer covariance, correlation, nuisance parameters, or prediction uncertainty.
