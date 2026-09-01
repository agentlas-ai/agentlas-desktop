---
name: academic-full-text
description: Retrieve one DOI- or PMID-identified Europe PMC Open Access article as exact XML, preserve retrieval receipts, and create a deterministic parsed SourceVersion for byte-exact evidence.
---

# Retrieve Open Access Full Text

1. Start from an exact `sourceId` and current `sourceVersionId` returned by `search_academic_literature`; do not reconstruct an identity from a title.
2. Call `retrieve_open_access_full_text` with those exact IDs.
3. Inspect the returned Europe PMC PMCID, license, metadata/full-text response hashes, raw and parsed byte sizes, and parsed SourceVersion ID.
4. Use only the returned parsed SourceVersion for later evidence spans. Cite exact UTF-8 byte ranges and preserve the distinction between raw provider XML and deterministic parsed text.
5. If the article is not in the Europe PMC Open Access subset, the DOI/PMID identity differs, the source version is stale, or parsing fails, leave the source unverified and report that boundary. Do not fall back to scraping an arbitrary publisher page.

## Verification

- `evidenceScope` must be `full-text`.
- The raw XML hash, parsed text hash, ResearchRun outputs, and current SourceVersion hash must agree.
- The SourceVersion access state must be `parsed` before staging or recording evidence.
- A successful replay must perform no new network request and return the same run and SourceVersion.
