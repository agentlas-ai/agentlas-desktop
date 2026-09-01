---
name: gutenberg-richter-analysis
description: Estimate a provenance-bound Gutenberg–Richter b-value from one complete USGS earthquake catalog using an explicit Mc, magnitude type, and bin width; return an exact audit, publication table, and Vega-Lite figure.
---

# Gutenberg–Richter analysis

Use this workflow only for a bounded magnitude–frequency analysis of observed USGS ComCat events.

1. Retrieve a USGS catalog with `search_usgs_earthquakes`. Use offset 1 and narrow the UTC window or rectangular region until `pagination.nextOffset` is null and `pagination.completeness` is `page-complete`.
2. Ask the researcher for the magnitude-completeness threshold `Mc`, the magnitude discretization `ΔM` (normally the catalog precision), and the single magnitude type to analyze. Never infer `Mc` or convert magnitude scales.
3. Call `analyze_usgs_gutenberg_richter` with the exact returned catalog. Do not reconstruct its provenance fields or hashes.
4. Inspect `selection` and the complete `eventAuditTable` before interpreting the estimate. Missing magnitudes remain explicit nulls; magnitude-type mismatches and sub-`Mc` events are separate exclusion reasons.
5. Use `publicationTable` for numerical reporting and `vegaLite` for the magnitude–frequency figure. Keep the raw-response, normalized-catalog, table, figure, and analysis hashes with the result.

The estimator is `b=log10(e)/(mean(M)-(Mc-ΔM/2))`. Report the asymptotic Aki standard error and normal confidence interval as such. This workflow fails below 50 included events, below three occupied magnitude bins, for incomplete pagination, or for values not aligned to the declared magnitude grid.

This workflow does not estimate completeness, decluster aftershocks, test spatial stationarity, convert magnitude scales, perform bootstrap uncertainty, or support forecast and causal claims. Those limitations belong in any manuscript methods and limitations sections.
