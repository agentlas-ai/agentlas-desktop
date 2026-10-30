---
name: structures
description: Standardize input structures and draw labelled 2D compound grids saved beside the work.
---

# Structures

1. `standardize_smiles` strips salts (largest fragment), neutralizes and normalizes; report the steps that changed each structure and use the standardized SMILES downstream.
2. `draw_compound_grid` saves an SVG and a PNG under `agentlas-medchem/` in the working folder with each molecule's name as its label; molecules that cannot be parsed are listed, not drawn.
3. Each `ketcher.input` (title, SMILES) opens the same structure as an editable Ketcher document in Agentlas Science.
