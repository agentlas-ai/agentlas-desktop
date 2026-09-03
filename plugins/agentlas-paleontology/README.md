# Agentlas Paleontology

Evidence-bounded Paleobiology Database access for Agentlas Science. The plugin builds deterministic PBDB Data Service 1.2 requests; the Electron host performs allowlisted network access and preserves exact provider bytes in project Sources and ResearchRuns.

The first release supports fossil taxon, occurrence, location, stratigraphy, age interval, and primary-reference evidence. It also derives an interval-preserving stratigraphic table and Vega figure from a sealed catalog result. The analysis keeps both age bounds, reports missing fields as missing, rejects duplicate occurrence identifiers, and never turns interval midpoints into observations.

## Tools

- `build_pbdb_taxon_request` builds one fixed, allowlisted exact-name PBDB request. It does not accept wildcard, list, or arbitrary query parameters.
- `build_pbdb_occurrence_request` builds a bounded occurrence page with fixed fields, ordering, vocabulary, strict matching, data metadata, and row-count flags.
- `analyze_paleontology_stratigraphic_support` accepts a completed `agentlas.paleontology-catalog-result/v1`, verifies its parent-run and row receipts, and returns a publication table, Vega specification, formation summaries, content hashes, assumptions, and limitations.
- `compare_fossil_candidate_evidence` accepts 2–20 exact catalog-run plus deterministic stratigraphic-analysis-run pairs. It re-derives taxonomy resolution, occurrence returned/available counts, truncation, formation/interval/georeference/primary-reference coverage, age bounds, interval widths, and selected-field missingness. It accepts no caller score and never produces scalar, ordinal, or Pareto ranks. Its `candidateOrdinal` only preserves request order. Ranking status is always `not-produced`, with reason `truncated-parent-evidence` if any parent is truncated and `descriptive-comparison-only` otherwise.
- `assess_deextinction_feasibility` audits two or more candidates under the explicit objective `actual-biological-revival` or `comparative-proxy-research`. It accepts evidence status, finding, and sealed source-run bindings but no numerical score. Actual revival has exactly four hard stops: authenticated endogenous dinosaur DNA, a species-level nuclear genome and karyotype, a viable cell or nucleus, and a validated avian embryo-surrogate platform. Soft researchability is reported separately; PBDB coverage is excluded from its completeness calculation and contributes exactly zero to biological feasibility.
- `describe_paleontology_capabilities` returns the installed provider and evidence boundary contract.

All tool arguments are closed objects: unknown properties are rejected by the runtime as well as declared with `additionalProperties: false` in the tool schema. The stdio server returns a stable machine error code in JSON-RPC error data.

## Dinosaur revival feasibility workflow

The `deextinction-feasibility` workflow is an evidence-decomposition workflow, not a resurrection claim. It first separates actual biological revival from comparative proxy research, then separates fossil researchability, independently authenticated molecular-preservation evidence, GBIF museum records, extant-relative comparative genomics, hypothetical ancestral sequence reconstruction, and developmental feasibility. The deterministic audit emits no biological-feasibility score or probability. A candidate that clears the four evidence gates is only eligible for expert review; it is never labelled viable. Each stage must hand its sealed evidence bindings to the built-in Research Director before the next stage or manuscript drafting.

PBDB evidence can support only fossil occurrence, taxonomic, geographic, stratigraphic, temporal, and cited-literature statements. It explicitly does not provide morphology measurements, recovered DNA, a dinosaur genome, embryo viability, hatching, or de-extinction feasibility. A qualified identification such as `cf.` or `aff.` must remain qualified; an accepted-name synonym must not be silently rewritten as an exact identification.

Candidate comparison never fills missing formation, interval, coordinate, reference, or taxonomic-rank values. It preserves older and younger age bounds separately and reports interval width without treating a midpoint as an observation. Returned and available occurrence counts remain separate. Complete and truncated catalogs remain descriptive; neither can create a winner.

PBDB data is retrieved under the provider response's CC0 declaration. Publication use must retain the exact query, access time, provider metadata, raw-response hash, record-level references, accepted-name relationship, missing values, and age/coordinate uncertainty.
