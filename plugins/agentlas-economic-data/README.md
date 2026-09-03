# Agentlas Economic Data

This plugin retrieves one official World Bank indicator series at a time for Agentlas Science. It is designed for reproducible research inputs: a call returns normalized observations, provider pagination and update metadata, plus the SHA-256 digest and byte count of the exact JSON response body.

## Workflows

| Skill | Use it for |
|---|---|
| `index` | Route a request to the supported economic-data workflow and state the source boundary. |
| `fetch-world-bank-indicator` | Validate a country, indicator, year range, and page before fetching and citing a World Bank series. |

## Tool calls

`fetch_world_bank_indicator` accepts one `country`, one `indicator`, `startYear`, `endYear`, and optional `page` / `per_page`. Example arguments:

```json
{
  "country": "KOR",
  "indicator": "NY.GDP.MKTP.CD",
  "startYear": 2019,
  "endYear": 2023,
  "page": 1,
  "per_page": 100
}
```

`describe_economic_data_capabilities` returns the exact provider, normalization, input, and resource-limit contract without making a network request.

## Known limitations

- This package supports annual observations returned by the country/indicator endpoint. Monthly, quarterly, multi-country, multi-indicator, source-selection, download, and JSONP queries are deliberately out of scope.
- A `null` observation means the provider returned a missing value. It is not replaced with zero and is not interpolated.
- Provider revisions are possible. Reproducibility depends on retaining the returned request URL, raw byte count, SHA-256 digest, provider update metadata, and normalized result together.
- The package reports World Bank data; it does not infer causality, make forecasts, or provide investment advice.

Official API documentation: [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation) and [basic call structure](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures).
