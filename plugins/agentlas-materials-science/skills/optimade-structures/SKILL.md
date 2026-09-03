---
name: oqmd-optimade-structures
description: Find OQMD materials by exact element set while preserving lattice, site, occupancy, and source evidence.
---

# OQMD OPTIMADE Structures

1. Confirm the required element symbols and choose the smallest useful page (`limit <= 50`).
2. Call `search_oqmd_optimade_structures`; use `offset` for explicit bounded paging, never provider `links.next`.
3. Treat `cartesianSitePositions`, `speciesAtSites`, `species`, and `latticeVectors` as the normalized structural record.
4. Render `poscarText` with the host 3Dmol VASP/POSCAR parser only when it is non-null. If null, explain that disorder or partial occupancy cannot be encoded without loss.
5. Reject any returned structure whose exact sorted element set differs from the requested set; the query filter alone is not proof.
6. Use the table for comparison plots, and retain the standalone attempt receipt plus raw-response and normalized hashes with every derivative.
7. When the result must become citable Science evidence, call the host `search_materials_structures` route instead. The standalone MCP receipt has `hostPersisted: false` and is not a committed ResearchRun, Source, or artifact.
