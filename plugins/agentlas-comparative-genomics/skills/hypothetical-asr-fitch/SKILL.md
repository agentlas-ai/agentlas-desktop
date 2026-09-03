---
name: hypothetical-asr-fitch
description: Compute exploratory hypothetical Fitch-parsimony ambiguity sets for one explicit internal node using only a rooted strictly bifurcating tree and observed extant DNA alignment.
---

# Hypothetical Fitch ASR

Use this workflow only as an exploratory inspection of ambiguity sets.

1. Require a sealed comparative-genomics parent ResearchRun with `sequenceType: cdna`.
2. Re-read and hash-verify the exact parent assessment output from CAS.
3. Require a rooted strictly bifurcating tree whose leaves exactly match the observed extant DNA alignment.
4. Require the caller to select a non-root internal node. Do not silently choose a named ancestor or terminal species.
5. Run deterministic Fitch parsimony and preserve all ambiguous state sets. Do not add posterior probability, likelihood, or confidence fields.
6. Label the result and every reconstructed site `hypothetical`.
7. Preserve and open the exact ResearchRun-bound site table and ambiguity-Figure artifact in the Comparative Genomics Lab before interpreting it.
8. Do not call the display sequence a recovered ancestral sequence, extinct genome, chromosome, phenotype, viable embryo, or hatching result.
9. For publication-grade ASR, stop and require independent alignment, substitution-model, topology, taxon-sampling, probabilistic reconstruction, and experimental validation.
