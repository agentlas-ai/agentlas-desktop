# Agentlas Physics

An installable Agentlas Science data plugin for high-energy-physics discovery, bounded experimental-table preparation, and a deterministic physics analysis catalogue.

## Implemented

- Anonymous INSPIRE literature search with fixed metadata fields, bounded page/size inputs, provider `total`/`next` metadata, duplicate-record rejection, and 15-requests/5-seconds-compatible local pacing.
- Public HEPData record metadata/table-resource catalog retrieval.
- Version-pinned official HEPData JSON-table retrieval when the provider permits automated access, plus offline normalization with axes, qualifiers, null/missing sentinels, inclusive measurements without an x-axis, and symmetric/asymmetric/relative/one-sided uncertainties.
- Renderer-ready point series with numeric bin centers and separate labeled error bars.
- Deterministic diagonal chi-square analysis against an explicit prediction vector with directional asymmetric-error propagation, residuals, pulls, reduced chi-square, survival p-value, publication table, and inline Vega payload generation with input/output hashes.
- Offline normalization of bounded user numeric/string datasets.
- Analysis catalogue (`runtime/*.cjs`, pure JavaScript, seeded randomness only, every result hash-bound and carrying declared boundaries):
  - `fit_physics_spectrum_peaks` — Levenberg–Marquardt multi-peak fits (Gaussian, Lorentzian, pseudo-Voigt, Voigt via Weideman Faddeeva, Crystal Ball, relativistic Breit–Wigner) on none/polynomial/exponential backgrounds with covariance, χ²/ndf, pulls, FWHM/area, and a data+model+pull figure.
  - `compute_physics_significance_limits` — profile-likelihood Z0 with a Gaussian-constrained background (Cowan et al. 2011), exact and marginalised Poisson p-values, asymptotic CLs upper limit with expected bands, and an explicit Feldman–Cousins interval.
  - `propagate_physics_uncertainty` — safe expression parser (no code execution), exact dual-number gradients with covariance, seeded Monte Carlo, uncertainty budget, and a linear-vs-Monte-Carlo comparison.
  - `analyze_physics_units` — SI base-exponent unit conversion over a curated table, CODATA 2018 constants with uncertainties, natural-units conversion, and equation dimension checks.
  - `simulate_physics_ode` — adaptive Dormand–Prince RK5(4) over nine catalogue systems with conserved-quantity drift diagnostics and analytic cross-checks (Bateman, elliptic-integral period, steady-state amplitude, closed forms).
  - `analyze_physics_signal` — radix-2/Bluestein FFT amplitude and power spectra with window corrections, refined dominant peaks, autocorrelation, SNR estimate, and optional STFT spectrogram.
  - `fit_physics_york_line` — York (2004) errors-in-variables straight line with per-point correlation, compared with OLS and WLS.
  - `check_physics_lab_experiment` — free-fall, pendulum (finite-amplitude corrected), and Ohm's-law checkers with uncertainties, reference comparison, and residual diagnostics.
- Deterministic normalization plus request/raw/normalized SHA-256 receipts, response byte counts, bounded retries, redirect denial, strict JSON MIME checks, and a streaming byte cap.

## Honest boundary

This package does not bundle Vega or vtk.js, does not bypass provider challenges or protected downloads, and does not execute ROOT, CERN event analysis, detector simulation, Geant4, lattice, symbolic, stiff-ODE, or PDE workloads. The chi-square slice is diagonal only. The spectrum fit is a chi-square (not Poisson-likelihood) fit that converges to a local minimum from caller-supplied starting values. Significance and CLs limits use asymptotic formulae that are approximate for small counts; the Feldman–Cousins construction treats the background as exactly known. Uncertainty propagation is first-order plus Monte Carlo and does not check units. The ODE integrator is explicit and non-stiff; drift diagnostics are evidence, not proof. Signal analysis requires uniform sampling. Lab checkers model no systematic errors. Every result lists its boundaries; see `docs/science/physics-tools.md` in the host repository.

## Focused contract

```bash
node tests/contract.cjs
node ../../scripts/science-physics-hepdata-chi-square-oracle.cjs
node ../../scripts/science-physics-analysis-runtime-contract.cjs            # node contracts for the analysis catalogue
node ../../scripts/science-physics-analysis-runtime-contract.cjs --oracle   # plus python numpy/scipy cross-checks
node ../../scripts/science-physics-plugin-integrity.cjs                     # integrity manifest
```
