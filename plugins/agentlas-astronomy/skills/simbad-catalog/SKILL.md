---
name: simbad-catalog
description: Run a safe SIMBAD TAP cone query and interpret its fixed astrometric and classification projection without implying survey completeness.
---

# SIMBAD Object Search

1. Convert the requested center to ICRS decimal degrees before calling the tool. Right ascension must be in `[0, 360)`, declination in `[-90, 90]`, and radius in `[0.001, 10]` degrees.
2. Choose `limit <= 500` and one response format. JSON is the default; CSV and TSV exist to prove replay-equivalent normalization.
3. Call `search_simbad_catalog`. Do not write arbitrary ADQL or follow provider links.
4. Treat `spectralType`, `parallaxMas`, proper motions, radial velocity, and redshift as nullable measurements. Never replace a missing value with zero.
5. Preserve `stableObjectId`, `provenance.sourceAuthority`, `provenance.request.requestSha256`, `provenance.response.rawSha256`, and `normalizedSha256` with downstream analysis.
6. State that SIMBAD is an object database and that cone results are not a complete survey catalogue.
7. The fixed ten-column search projection does not include uncertainty columns. Do not invent them; retrieve a separately evidenced measurement projection before using the astrometric-kinematics workflow.

## Verification

Verify the returned schema is `agentlas.astronomy.simbad-catalog/v1`, the reported object count matches the rows, all coordinates remain within their physical bounds, and all three hashes are 64 lowercase hexadecimal characters.
