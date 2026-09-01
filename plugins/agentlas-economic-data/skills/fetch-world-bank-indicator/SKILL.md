---
name: fetch-world-bank-indicator
description: Fetch and report one bounded annual World Bank indicator series with provider metadata and exact-response provenance.
---

# Fetch World Bank Indicator

1. Bind the request to one ISO2/ISO3 country code or an aggregate named by `describe_economic_data_capabilities`.
2. Bind one dot-delimited World Bank indicator code and an inclusive annual range.
3. Call `fetch_world_bank_indicator`; use pagination explicitly when the result reports more than one page.
4. Report units and decimal precision from the normalized series. Keep missing observations as `null` or label them unavailable.
5. Keep the provider `sourceId`, `lastUpdated`, request URL, exact raw byte count, and SHA-256 digest with any reproducibility record.

## Outputs

Return the normalized observations and a concise source note naming the World Bank Indicators API. Do not add interpolated or forecast values unless the user separately requests an analysis that clearly labels them.

## Verification

Confirm that the returned schema is `agentlas.economic-data.world-bank-indicator.v1`, the country and indicator match the request, pagination is present, and `raw.sha256` matches `sha256:` followed by 64 lowercase hexadecimal characters.
