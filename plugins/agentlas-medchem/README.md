# Agentlas Medchem

A common Agentlas plugin for medicinal-chemistry calculations with RDKit: molecular properties, drug-likeness rules
(Lipinski, Veber, Egan, Ghose), QED, PAINS/Brenk alerts, SMILES standardization and labelled compound grids.

## Managed RDKit environment

RDKit runs in this plugin's own Python environment under `<installed plugin>/.state/python/`, never in the Science
kernel, a system site-packages or the owner's environment. It is built once, when the plugin's server first starts,
from PyPI binary wheels only (`rdkit==2026.3.6`; Intel Macs `rdkit==2025.9.3`, the last release with macOS x86_64
wheels). The interpreter is, in order: the Python shipped with Agentlas, the uv Agentlas provisions for uvx servers (or
a uv on PATH; its downloads and cache stay inside `.state`), or a python3 3.10-3.14 on PATH. Until it is ready, a call
returns `status: "runtime-preparing"`; `describe_medchem_runtime` reports the state and `prepare: true` retries after
a failure. Calculations never use the network.

## Artifacts

Every molecule carries `ketcher: { contract: "agentlas.smiles-to-ketcher", input: { title, smiles } }`, the exact input
of Agentlas Science's Ketcher document tool. `draw_compound_grid` saves SVG and PNG under `agentlas-medchem/` in the
working folder.

## Honest boundaries

All values are RDKit calculations, not measurements; rules and alerts are triage heuristics.
