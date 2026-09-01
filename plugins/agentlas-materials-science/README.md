# Agentlas Materials Science

An installable Agentlas Science domain plugin for real, anonymous public materials data.

## What works

- OQMD OPTIMADE v1 element-set search with fixed deterministic sort, bounded paging, lattice vectors, Cartesian sites, species/occupancy preservation, OQMD band-gap and formation-energy fields, exact response hash, and lossless ordered POSCAR when possible.
- Crystallography Open Database metadata search by COD ID or constrained Hill-style formula. A `format=count` request prevents an unbounded JSON download.
- Exact COD CIF and optional revision fetch with raw UTF-8 bytes hash, conservative cell/asymmetric-unit site extraction, and provenance receipts.
- Hash-verified lattice analysis: triclinic cell-parameter volume for COD CIF, absolute lattice-determinant volume for OPTIMADE, declared-volume tolerance validation, and a publication table. Density is calculated only from explicit composition, formula-units Z, and formula weight.
- Stdio MCP tools with strict input schemas and deterministic normalized hashes.

## Honest boundaries

This package contains adapters, deterministic lattice metrics, and contracts, not visualization libraries. The Science Lab may route CIF/POSCAR to a separately installed 3Dmol surface and normalized tables to Vega. Mol* support is not claimed. CIF symmetry is not expanded, disorder is not guessed, and POSCAR is withheld when occupancy would be lost. Density is withheld when any explicit composition, Z, or formula-weight field is absent; the runtime never derives atomic masses from a formula.

OQMD declares credential-free access and CC-BY 4.0. COD's REST endpoint and CIF files are accessible without a key; COD states its data are CC0/public domain. Downstream users remain responsible for dataset attribution and the original paper citation.

## Test

```sh
node plugins/agentlas-materials-science/tests/contract.cjs
node scripts/science-materials-lattice-metrics-oracle.cjs
node scripts/plugin-spec-gate.cjs plugins/agentlas-materials-science
```

Tests use local fixtures and never require a live provider. Live smoke checks are a separate release verification step.
