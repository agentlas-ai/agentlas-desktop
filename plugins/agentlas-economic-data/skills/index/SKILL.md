---
name: economic-data
description: Route requests for official, reproducible country-level economic indicator observations from the anonymous World Bank Indicators API.
---

# Economic Data Router

Use `fetch-world-bank-indicator` when the user asks for a World Bank country or approved aggregate indicator over an annual date range.

Before calling the fetch tool, identify exactly one country code, one World Bank indicator code, and an inclusive start and end year. If any of those are ambiguous, ask for the missing choice instead of selecting a series silently.

Use `describe_economic_data_capabilities` when the user asks what the plugin can access, whether a key is required, or which resource and normalization boundaries apply.

Do not describe provider data as live until `fetch_world_bank_indicator` has returned successfully. Preserve `null` observations in summaries and distinguish them from numeric zero.
