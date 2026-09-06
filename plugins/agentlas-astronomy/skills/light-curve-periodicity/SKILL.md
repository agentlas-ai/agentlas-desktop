---
name: light-curve-periodicity
description: Analyze an irregular astronomical light curve with a bounded generalized Lomb-Scargle grid while preserving time-system, uncertainties, missing observations, sampling aliases, and publication provenance.
---

# Irregular light-curve periodicity

1. Bind the exact source file or table SHA-256. Do not copy values from a plot or invent missing observations.
2. Confirm the numeric time system and any constant day offset. Never silently treat UTC, TDB, JD, MJD, HJD, or BJD as interchangeable.
3. Preserve one stable observation ID, nullable time, nullable value, nullable positive standard error, and the explicit `use` flag for every input row.
4. Choose the period bounds and finite frequency count before calling `analyze_light_curve_periodicity`. The grid is linearly spaced in frequency, inclusive, and capped at 5,000 frequencies over at most 2,000 observations.
5. Prefer `weighted` when every usable measurement has a defensible standard error. In `weighted` mode, otherwise complete rows without an error are excluded rather than imputed. `auto` falls back to a fully unweighted fit if any otherwise complete row lacks an error.
6. Interpret `power` as the declared floating-mean GLS standard normalization, not a probability. Inspect the sampling-window curve and cadence warnings before calling a peak astrophysical.
7. Treat reported peaks as local maxima on the requested grid. The basic tool reports a Baluev analytic false-alarm upper bound and a Montgomery-O'Donoghue period standard-error estimate when numerically resolvable; neither is a calibrated detection probability or confidence interval, and a returned zero is a numerical floor. It does not compute red-noise corrections, detrending, multi-harmonic fits, or transit templates.
8. Use `analyze_light_curve_periodicity_depth` for the separately bounded depth pass: seeded permutation-bootstrap FAP, local peak refinement, peak-width/analytic/bootstrap period uncertainty, daily/sidereal alias screening, and a fixed two-harmonic comparison. A zero bootstrap exceedance must be reported with its finite-sample upper bound, not as exact FAP=0.
9. Use the observation, peak, and periodogram tables as publication payloads. The Vega-Lite output is a FigureSpec until the host renderer and export pipeline separately validate it.
10. For magnitudes, the folded panel reverses the value axis. `phase`, fitted values, residuals, amplitudes, and offsets are derived model quantities, not new measurements.

## Verification

Require the selected result schema and verify all provenance hashes. Confirm every input row remains in the observation table, state the exact time system, weighting resolution, grid bounds, baseline, cadence warnings, strongest grid period, sampling-window power, and the method/limitations for any FAP or period-error value. The host chart artifact must retain the analysis payload and its source binding.
