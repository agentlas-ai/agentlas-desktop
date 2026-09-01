---
name: noaa-coops-water-level
description: Retrieve exact observed NOAA CO-OPS water levels for one station and UTC window, preserving units, vertical datum, geolocation, raw bytes, network receipt, and deterministic renderer inputs.
---

# NOAA CO-OPS observed water level

1. Require the exact seven-digit NOAA CO-OPS station id, an explicit vertical datum, a unit system, and a timezone-qualified interval whose endpoints resolve to exact minutes and span no more than 31 days.
2. Call `fetch_noaa_coops_water_levels`. Use `normalize_noaa_coops_water_level_json` only for a user-downloaded response and supply the same station, interval, datum, and units that produced it.
3. Preserve `provenance.requestUrl`, `requestSha256`, `responseUrl`, `httpStatus`, `rawResponseSha256`, `rawResponseBytes`, `normalizedSha256`, `retrievedAt`, and the nested network receipt.
4. Keep coordinates in EPSG:4326, observation times in UTC ISO form, and water-level and standard-deviation units exactly as returned for the requested unit system. Never infer or convert the vertical datum.
5. Keep missing values as null. Keep NOAA `preliminary`/`verified` state and quality flags; do not interpolate, predict, or silently promote preliminary data.
6. Use `vegaLite` with its `contentReceipts.timeSeriesFigure` for an installed Vega renderer, `stationGeojson` for a compatible map renderer, or `table` for data inspection. If no renderer exists, retain these deterministic artifacts and report the host-renderer boundary.

## Verification

- `source.endpoint` and `provenance.responseUrl` remain on the exact official `api.tidesandcurrents.noaa.gov/api/prod/datagetter` endpoint with redirects denied.
- The response station matches the requested station; longitude and latitude are finite EPSG:4326 coordinates.
- Every observation is inside the requested UTC interval, timestamps are unique after normalization, and the unit plus vertical datum are explicit.
- Recompute each content receipt from canonical JSON before treating its corresponding table, GeoJSON, or Vega-Lite object as renderable evidence.

## Boundary

This workflow retrieves NOAA CO-OPS observed water level only. It does not retrieve predictions, currents, meteorology, monthly means, climate grids, remote-sensing products, or causal/forecast models.
