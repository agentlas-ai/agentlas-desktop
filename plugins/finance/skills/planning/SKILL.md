---
name: planning
description: Calculate cashflow, income goals, allocation and rebalancing scenarios.
---

Use plan for deterministic cashflow, income-capital goals and target-weight rebalancing. Use the user's explicit assumptions and ask only for missing inputs that affect the calculation. Honor supplied product and trading constraints. Distinguish scenario assumptions from verified account rules; do not infer return, tax, currency, fees or legal rules from nationality. Research current rules when they are needed for the requested result. A target-weight plan is not an income-portfolio optimizer or a trade. Use calculate for actual aligned-history allocation, bootstrap scenarios and explicit option assumptions. Inspect returned computed values, status and limitations before report_text writes the conclusion into the saved artifact. A depletion chart is not a probability of retirement success. In a Work conversation, call `finance_plan` with every required field (explicit zeros included) and keep the conclusion as a Finance report (`finance.report.create`, then `finance.apply` with a report section holding the computed values, assumptions and limits), never as a file.
