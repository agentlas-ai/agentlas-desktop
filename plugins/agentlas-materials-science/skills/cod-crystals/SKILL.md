---
name: cod-crystals
description: Resolve bounded COD metadata and retrieve exact, hash-addressed CIF files without pretending to perform full crystallographic interpretation.
---

# COD Crystal Records

1. Search exact COD IDs when known. For formulas, use COD's space-separated Hill notation subset and set `maxMatches` conservatively.
2. If status is `too-broad`, refine the scientific selector. The plugin intentionally does not fetch the unbounded result body.
3. Call `fetch_cod_cif` for selected IDs, optionally pinning a COD revision.
4. Store `cifText`, `rawCifSha256`, provenance, and the selected normalized fields together.
5. A host 3Dmol renderer may open the exact CIF. Do not describe `atomSites` as a full unit cell: they are deposited asymmetric-unit rows and no symmetry expansion was performed.
