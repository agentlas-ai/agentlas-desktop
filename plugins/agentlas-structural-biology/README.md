# Agentlas Structural Biology

A common Agentlas plugin (One, Work, Finance and Science share it through the same tool selection and search) for
drug-discovery structure and evidence lookup from public, keyless endpoints.

## Tools

| Tool | Source | Effect |
|---|---|---|
| `search_protein_structures` | RCSB Search API v2 + Data API (GraphQL) | read |
| `fetch_protein_structure` | RCSB files + assembly image | writes `agentlas-structures/<ID>/` in the working folder |
| `fetch_alphafold_model` | AlphaFold DB API | writes `agentlas-structures/<model>/` |
| `describe_binding_site` | RCSB mmCIF, computed locally | read |
| `fetch_chembl_activities` | ChEMBL web services | read |
| `fetch_clinical_trials` | ClinicalTrials.gov API v2 | read |
| `describe_structural_biology_capabilities` | this package | read |

Requests send only the plugin User-Agent; no account, e-mail or token. Each provider has a minimum request interval,
three attempts on 429/502/503/504 (Retry-After honoured up to 5 s), a 27 s deadline per call and byte limits. Results
default to a compact summary view; `view: "full"` returns more rows within a bounded size.

## 3D artifact contract

`molstarView` follows Agentlas Science's `agentlas.source-to-molstar` artifact shape (`kind: protein.structure`,
`rendererId: agentlas.molstar`, payload `structure`/`representation`/`colorTheme`, optional
`agentlas.science-residue-interaction/v1`). The structure is referenced by provider entry and exact content SHA-256;
`scienceSourceQuery` is the entry Science retrieves to mint its own source version with the same bytes.

## Honest boundaries

Binding-site residues are a distance criterion on deposited coordinates, not docking or energies. AlphaFold pLDDT is
model confidence. ChEMBL values are reported as curated. ClinicalTrials.gov entries are registrations, not results.
