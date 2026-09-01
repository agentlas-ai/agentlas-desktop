---
name: agentlas-science-statistics
description: Route quantitative research questions, statistical inference, effect-size estimation, bounded repeated-measures mixed modeling, model diagnostics, multiple-testing correction, response-surface experiments, publication tables, and statistical charts through the local Agentlas Science statistics runtime.
---

# Statistics Router

Use `$analyze` when a Science research turn needs a statistical calculation or when a numerical claim, table, or figure must be regenerated from bound project data.

Do not infer results from prose or screenshots. The runtime requires explicit numeric data and returns content-hash receipts. If the requested design is unsupported, preserve the analysis plan and state the gap instead of substituting a simpler test without approval.

For repeated or clustered continuous outcomes, route to `gaussian_random_intercept_lmm` only when one explicit grouping factor and a random-intercept-only design answer the research question. Before execution, make the chain visible: why dependence matters, which effect the researcher wants to decide, which tables and diagnostics support that decision, what the result will be used for, and which next artifact or research action follows.
