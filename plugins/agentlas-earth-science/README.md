# Agentlas Earth Science

An installable Agentlas Science data and bounded-analysis plugin for official Earth-observation research. It exposes a stdio MCP server, strict input schemas, deterministic GeoJSON/table/figure normalization, source and network receipts, and explicit host-renderer compatibility for USGS ComCat and NOAA CO-OPS observed water levels.

## Implemented

- Anonymous USGS FDSN Event catalog query with UTC interval, rectangular bounds, magnitude/depth filters, source-faithful ordering, and one-based pagination.
- Exact USGS event-detail lookup using `query?eventid=...&format=geojson`; the redirecting feed alias is deliberately not used.
- Offline normalization of user-supplied USGS catalog and event-detail GeoJSON.
- Request URL, raw response, and normalized output SHA-256 receipts.
- USGS `nst`, `gap`, `dmin`, and `rms` quality fields in additive `observations[]`, while the legacy hash-sensitive `events[]` projection stays host-compatible; event detail adds preferred-origin time/location/depth/magnitude uncertainty and error-ellipsoid fields.
- Backward-compatible `agentlas.earth.usgs-earthquake-catalog/v1` output with a `quality-pagination-detail-compatible/v2` contract revision, canonical three-dimensional GeoJSON for MapLibre/Cesium hosts, and typed parameter/product tables for Vega/statistics hosts.
- Fixed official hostname/path, denied redirects, strict JSON MIME types, UTF-8 validation, streamed byte caps, retry bounds, 8 MiB response, 2,000-event, 1,000-product, 366-day, 15-second, and one-request-per-second guards.
- Exact NOAA CO-OPS production `water_level` requests for a seven-digit station, inclusive UTC-minute interval, explicit vertical datum, and metric or English units, bounded to 31 days and 7,500 observations.
- NOAA station coordinates normalized to EPSG:4326, observation times normalized to UTC ISO instants, units retained as meters or feet, missing values retained as null, and preliminary/verified state plus provider flags preserved.
- Deterministic NOAA Science Table, station GeoJSON, and Vega-Lite time-series projections, each with its own canonical content receipt, plus an exact request/response/network receipt over the raw official JSON bytes.
- Publication-auditable Gutenberg–Richter magnitude–frequency analysis from one complete first-page USGS catalog. The researcher must provide magnitude completeness `Mc`, magnitude bin width `ΔM`, and one exact magnitude type. The tool applies the Aki maximum-likelihood estimator with discrete-bin correction, returns its asymptotic standard error and confidence interval, and preserves the exact raw-response and normalized-catalog hashes.
- Exact inclusion accounting for every source event. Missing preferred magnitudes remain null in the audit table; wrong magnitude types and events below `Mc` are counted separately. Analysis fails closed below 50 included events, below three occupied bins, on mixed/unaligned magnitude grids, or when pagination indicates that more USGS results may exist.
- Deterministic publication table and tooltip-only Vega-Lite magnitude–frequency chart, each with a content receipt, plus an overall analysis SHA-256.
- Bounded Omori–Utsu aftershock-decay analysis from the same complete, provenance-bound USGS catalog. The researcher supplies the mainshock, observation window, time-completeness boundary, `Mc`, exact magnitude type, fixed time-bin width, and `p/c` bounds. A deterministic profile-Poisson grid/refinement estimator returns `p`, `c`, and `K`, an exact event audit, zero-preserving publication bins, Pearson diagnostics, decay and residual Vega-Lite payloads, and content/analysis receipts.
- Omori–Utsu returns `insufficient-data` below 20 included events, five distinct event instants, or four occupied time bins. Numerical failure or an optimum on a declared bound returns `invalid` rather than silently presenting the fit as complete.

## Honest boundary

The package does not bundle a renderer and does not fetch linked product content. It inventories USGS phase-data and other product files but does not parse their XML, waveform, ShakeMap, NetCDF, GRIB, GeoTIFF, or DEM content. NOAA support is limited to observed CO-OPS water levels: predictions, currents, meteorology, broader NOAA climate products, and NASA Earthdata collection discovery remain unsupported. The Gutenberg–Richter tool does not estimate `Mc`, decluster a catalog, convert magnitude scales, establish spatial homogeneity, or make forecast/causal claims. Omori–Utsu does not infer the mainshock or completeness boundaries, separate background seismicity, model secondary triggering, calculate confidence intervals, or validate a forecast. Neither a USGS catalog observation nor a NOAA water-level observation is a forecast or causal model.

## Focused contract

```bash
node tests/contract.cjs
node ../../scripts/science-earth-gutenberg-richter-contract.cjs
node ../../scripts/science-earth-omori-utsu-contract.cjs
```
