# Agentlas Astronomy

An installable Agentlas Science provider plugin for anonymous, bounded searches of the official CDS SIMBAD TAP astronomical object database.

## What works

- ICRS cone queries with strict right-ascension, declination, radius, and result bounds.
- One fixed ADQL projection over SIMBAD `basic`: main identifier, coordinates, object type, spectral type, parallax, proper motion, radial velocity, and redshift.
- Official TAP JSON, CSV, and TSV responses normalized to one deterministic object contract. Optional empty or null measurements remain `null`.
- Stable object IDs, a canonical normalized hash, a SHA-256 hash of the exact final request URL, and a SHA-256 hash of the exact successful response bytes.
- A fixed `agentlas.astronomy.official-source/v1` authority receipt naming the CDS operator, official TAP endpoint, official SIMBAD documentation, and anonymous public-access mode.
- A credential-free stdio MCP server exposing `search_simbad_catalog`, `analyze_astrometric_kinematics`, `analyze_light_curve_periodicity`, `analyze_light_curve_periodicity_depth`, and `describe_astronomy_capabilities`.
- A pure `analyze_astrometric_kinematics` calculation over 1–500 explicit measurement rows. It derives total proper motion, naive inverse-parallax distance, and transverse velocity; reconstructs proper-motion covariance from a SIMBAD-style error ellipse; and propagates available errors with a declared first-order delta method.
- Deterministic publication payloads: a typed table containing every input row and exclusion reason, plus a Vega-Lite FigureSpec containing only inference-eligible rows and horizontal/vertical 95% intervals.
- SHA-256 receipts for the normalized analysis input, fixed algorithm descriptor, publication table, FigureSpec, and complete result. The required source-content SHA-256 remains bound through every output.
- A pure `analyze_light_curve_periodicity` calculation over 5–2,000 irregular observations and 32–5,000 inclusive, linearly spaced trial frequencies. The caller must declare the astronomical time system, constant day offset, value semantics, finite period range, weighting policy, and exact source-content SHA-256.
- A weighted floating-mean generalized Lomb-Scargle fit using the standard `1 - residual sum at frequency / constant-model residual sum` normalization described by [Zechmeister & Kuerster (2009)](https://doi.org/10.1051/0004-6361:200811296). The same finite grid includes a deterministic sampling-window diagnostic.
- Period-analysis publication payloads: every original row and exclusion reason, the complete periodogram grid, ranked local grid peaks, folded best-period values and residuals, plus a two-panel Vega-Lite FigureSpec. Magnitude figures reverse the value axis.
- A pure `analyze_light_curve_periodicity_depth` calculation that extends the bounded GLS result with Baluev analytic upper-bound FAP, optional seeded permutation-bootstrap FAP, local peak refinement, analytic/peak-width/bootstrap period uncertainty, daily and sidereal alias screening, a fixed two-harmonic refinement, and a second publication table plus FigureSpec.

## Provider safety

The runtime permits only HTTPS GET requests to `https://simbad.cds.unistra.fr/simbad/sim-tap/sync`. It emits exactly the uppercase TAP parameters `REQUEST`, `LANG`, `FORMAT`, and `QUERY`; arbitrary ADQL and alternate endpoints are rejected. Redirects are denied. Content types are format-specific, `Content-Length` is checked before reading, and the response stream is stopped at 8 MiB. Requests use a 15-second timeout, a 500 ms minimum interval, at most two retries, and a capped `Retry-After` delay. No API key is read or accepted.

## Honest boundary

SIMBAD describes astronomical objects and their bibliography; it is not a general catalogue or a complete sky survey. This plugin therefore labels the operation as a bounded object-database cone query even though the required public tool identifier is `search_simbad_catalog`. Missing rows do not prove that an object is absent from the sky.

The kinematics tool does not fetch or infer missing uncertainties. A positive parallax can yield a descriptive inverse-parallax point estimate, but a row is excluded from inference when a required uncertainty is absent, parallax is nonpositive, proper motion is incomplete, or a declared fractional-error threshold is exceeded. The calculation is not a Bayesian distance estimator. It reconstructs covariance only between the two proper-motion components and explicitly assumes zero covariance between parallax and proper motion. First-order normal intervals are an approximation, not a substitute for a domain-specific hierarchical model.

The light-curve tool never converts the caller's declared time system. BJD, HJD, JD, MJD, UTC, and TDB are not interchangeable; a wrong declaration produces a provenance-preserving but scientifically wrong analysis. Inverse-variance weighting is used only when resolved as `weighted`. In that mode, otherwise complete observations without positive standard errors are excluded and retained in the table. `auto` uses weights only when every otherwise complete row has an error; otherwise it runs one fully unweighted fit and emits a warning.

The strongest basic period is a local maximum on the requested finite grid. The basic tool reports a Baluev analytic false-alarm upper bound and a Montgomery-O'Donoghue period standard-error estimate when numerically resolvable; those are model estimates rather than calibrated detection probabilities or confidence intervals, and a returned FAP of 0 is a numerical floor rather than exact certainty. The depth tool adds seeded bootstrap and local diagnostics, but does not correct red noise, detrend, convert time systems, fit a transit, or fit more than two harmonics. All periodicity results require independent domain review before a periodicity claim.

No visualization library is bundled. The new chart output is a Vega-Lite JSON payload, not evidence that a renderer or image exporter ran. When the Desktop host materializes `agentlas.d3-sky`, that separate artifact carries the pinned D3 package, runtime-asset, and ISC-license hashes; the provider plugin does not claim that renderer receipt.

## Contract test

```sh
node plugins/agentlas-astronomy/tests/contract.cjs
node plugins/agentlas-astronomy/tests/periodogram-contract.cjs
node scripts/science-astronomy-kinematics-oracle.cjs
node scripts/science-astronomy-lomb-scargle-oracle.cjs
node scripts/plugin-spec-gate.cjs plugins/agentlas-astronomy
```

The contract uses deterministic local fixtures and never contacts SIMBAD. A provider live smoke is a separate release verification step.
