---
name: search-inspire
description: Search INSPIRE HEP literature with bounded pagination and preserve request, raw-response, and normalized hashes.
---

# INSPIRE literature

1. Form one precise INSPIRE query and choose relevance, most recent, or most cited ordering. Keep page size at or below the plugin's 100-record safety bound.
2. Call `search_inspire_literature` with no more than 100 records per page.
3. Preserve the provenance receipt and distinguish paper metadata/abstract discovery from content verification.

## Outputs

- A deterministic `agentlas.physics.inspire-literature/v1` result with paper identities, provider total/next-page metadata, and a source receipt.

## Verification

- Every paper carries an INSPIRE id and title.
- Duplicate record ids, off-host next-page URLs, and provider results larger than the requested page are rejected.
- The raw-response and normalized hashes are distinct receipt fields.
- No result is described as full-text verified unless a later evidence step verifies it.
