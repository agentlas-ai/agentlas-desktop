---
name: earthquake-catalog
description: Retrieve a bounded USGS earthquake catalog, preserve request and response lineage, and hand canonical GeoJSON or a table projection to a compatible host lab.
---

# Earthquake catalog

1. Choose an explicit UTC interval of at most 366 days. Add a bounding box only when the study area is defined.
2. Use `offset` and the returned `pagination.nextOffset` for bounded continuation; do not silently treat a full page as the complete population.
3. Call `search_usgs_earthquakes`; for user-downloaded USGS data call `normalize_usgs_earthquake_geojson` instead.
4. When a candidate event needs quality assessment, call `get_usgs_event_detail` with the exact event id. Use `normalize_usgs_event_detail_geojson` for a downloaded detail Feature.
5. Preserve the returned provenance receipt, normalized hash, warnings, query, quality coverage, pagination, and event count with the artifact.
6. Treat `observations[].quality` values `nst`, `gap`, `dmin`, and `rms` as location-quality diagnostics. `events[]` is the stable legacy map projection. Prefer event-detail origin uncertainty for inferential use; never invent a confidence level when USGS does not provide one.
7. Use GeoJSON for an installed MapLibre/Cesium lab, or the canonical tables for an installed Vega/statistics lab. If a renderer is absent, keep the source artifact and report that boundary.

## Outputs

- A backward-compatible deterministic `agentlas.earth.usgs-earthquake-catalog/v1` catalog carrying contract revision `quality-pagination-detail-compatible/v2`, or an `agentlas.earth.usgs-earthquake-event-detail/v1` detail object.
- Canonical 3D GeoJSON, typed parameter/product tables, and a source receipt with request/raw/normalized SHA-256 values.

## Verification

- The source provider is USGS and at most 2,000 events are present.
- Every feature is a finite longitude/latitude/depth point with a unique USGS event id.
- A full page is continued or explicitly reported as potentially incomplete.
- Detail uncertainty units remain explicit: time in seconds, horizontal/vertical error in kilometers, ellipse axes in meters, angular errors in degrees.
- The artifact hash equals `provenance.normalizedSha256` and the raw response hash remains separate.
