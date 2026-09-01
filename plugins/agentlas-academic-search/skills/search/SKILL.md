---
name: academic-search
description: Search public scholarly metadata providers, preserve deduplicated records as project Sources, and disclose discovery-versus-verification limits.
---

# Search Academic Literature

1. Turn the research question into one precise scholarly query. Add a domain hint and year range only when the user or project makes them meaningful.
2. Call `search_academic_literature` with `providers: "auto"`. Override providers only for a concrete coverage reason.
3. Inspect `coverage`, every provider receipt, warnings, retraction flags, and each returned `sourceId`.
4. Summarize convergence, disagreement, missing coverage, and promising research gaps. Prefer records seen by multiple providers, but never treat provider count as scientific validation.
5. When a claim depends on findings rather than metadata, retrieve and verify the abstract or full text in a later evidence step before calling the claim supported.

## Outputs

- A deduplicated list of project Source records with DOI, PMID, or arXiv identity when available.
- Provider-level request and response hashes, coverage, partial-failure warnings, and deterministic ranking metadata.
- A clear boundary between discovered metadata and content-verified evidence.

## Verification

- At least one provider receipt must have `status: "ok"`.
- Every cited search result must carry a non-null `sourceId` and `sourceVersionId`.
- A result with `isRetracted: true` may be discussed only as retracted literature.
- Never claim full-text verification from this search workflow alone.
