---
name: agentlas-materials-science
description: Route materials questions to bounded OQMD OPTIMADE structure search or COD crystal metadata/CIF retrieval with exact provenance.
---

# Materials Science Router

Use `search_oqmd_optimade_structures` for computed structures and provider properties. Use `search_cod_crystals` to resolve COD records, then `fetch_cod_cif` only for explicitly selected COD IDs. Use `$lattice-metrics` after normalization for hash-verified volume and strictly conditional density. Never imply that a normalized site list is a symmetry-expanded crystal. Keep all provenance receipts beside derived artifacts.
