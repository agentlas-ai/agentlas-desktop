---
name: hepdata
description: Retrieve public HEPData record metadata and version-pinned JSON tables, or normalize supplied table JSON, while preserving axes, nulls, qualifiers, and uncertainties.
---

# HEPData

1. Call `fetch_hepdata_record` with an exact `ins...` record id. Request table metadata only when needed.
2. Call `fetch_hepdata_table` with the exact record id, table name, and required known record version. If the provider refuses automated access, surface the refusal; never scrape or bypass a challenge.
3. Use `normalize_hepdata_table` only for an already available JSON body. Supply its version when known; a missing version remains explicitly `null` rather than being guessed.
4. Preserve the record URI, version-pinned table URL, DOI citations, provenance receipt, raw-response hash, and normalized hash.
5. Hand `rendererProjection.series` to a host-provided Vega lab only when installed. The projection keeps labeled components separate. Use `$hepdata-chi-square` only when the research model explicitly declares selected labels mutually independent; never infer covariance or correlations.

## Outputs

- HEPData record metadata or a deterministic table preserving independent/dependent variables, null and empty-string missing measurements, qualifiers, symmetric/asymmetric errors, relative percentages, one-sided errors, and inclusive measurements with no independent variable.
- A renderer projection with numeric bin centers and per-component error-bar endpoints while retaining all source scalars alongside it.

## Verification

- The response record id matches the requested `ins...` id.
- Every variable has the same bounded point count.
- Every uncertainty retains its label and symmetric/asymmetric form.
- Relative and one-sided uncertainty projections retain raw values and never turn a missing side into zero.
