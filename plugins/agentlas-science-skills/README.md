# Agentlas Scientific Skills

Established research procedures, filed where the researcher already is.

The library holds 145 procedures — experimental design, statistical analysis,
cheminformatics, quantum computing, astronomy, genomics, time series and more.
Loading all of their descriptions would cost about 14,800 tokens on every turn,
so none of them sit in the prompt. Three tools are exposed instead:

- `scientific_procedures_here` — the procedures filed under the lab you have open
  or the research stage you are at. A place holds 3 to 20 of them.
- `open_scientific_skill` — the full procedure for exactly one of them.
- `find_scientific_skill` — a keyword search, for when you know the method name.

Lab procedures hang off labs. Procedures that belong to no lab — designing an
experiment, forming hypotheses, writing the manuscript, appraising evidence —
hang off the research stage instead, because every study needs them.

## Where this came from

Upstream: https://github.com/K-Dense-AI/scientific-agent-skills (MIT).
Each skill carries its own licence in its SKILL.md frontmatter; only
permissively licensed ones are bundled. Excluded on purpose:

- `alphagenome` — MIT frontmatter, but the service it calls is non-commercial.
- `docx`, `pdf`, `pptx`, `xlsx` — Anthropic proprietary; redistribution forbidden.
