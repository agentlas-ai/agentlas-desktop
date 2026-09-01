---
name: agentlas-earth-science
description: Use real, provenance-preserved USGS earthquake or NOAA CO-OPS observed water-level data and prepare deterministic geospatial or time-series artifacts; never substitute invented observations.
---

# Earth Science router

Use `$earthquake-catalog` when a research turn needs observed seismic events, a bounded/paginated USGS catalog query, event-level quality and uncertainty, or a geospatial earthquake artifact.

Use `$gutenberg-richter-analysis` only after obtaining a complete provenance-bound USGS catalog when the researcher supplies an explicit magnitude-completeness threshold, magnitude type, and bin width for an auditable b-value analysis.

Use `$omori-utsu-analysis` only after obtaining a complete provenance-bound USGS aftershock catalog when the researcher supplies the exact mainshock, observation window, time-completeness boundary, magnitude completeness, magnitude type, time-bin width, and bounded `p/c` search domain.

Use `$noaa-coops-water-level` when a research turn needs observed coastal water levels from an exact NOAA station, UTC window, vertical datum, and unit system.

This version does not fetch forecasts, NOAA predictions/currents/meteorology, broader climate or remote-sensing products, terrain, or waveform content. Its Gutenberg–Richter and Omori–Utsu workflows do not estimate completeness, decluster catalogs, convert magnitude scales, model background/secondary triggering, or make forecast claims. State those boundaries instead of routing such requests to an unrelated adapter.
