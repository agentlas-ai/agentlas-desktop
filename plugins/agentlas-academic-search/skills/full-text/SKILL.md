---
name: academic-full-text
description: Retrieve and content-check one exact project Source through the Europe PMC Open Access route or a lawful public/project-file full-text location, then preserve deterministic parsed evidence.
---

# Retrieve Open Access Full Text

1. Start from an exact `sourceId` and current `sourceVersionId` returned by `search_academic_literature`; do not reconstruct an identity from a title.
2. First call `retrieve_open_access_full_text` with those exact IDs when the source is DOI- or PMID-identified and the Europe PMC Open Access route is applicable.
3. If that route reports `not-open-access`, or the research already has a lawful public article PDF/HTML URL or a PDF/HTML/text file inside the project folder, call `retrieve_source_full_text_from_location` with the same exact IDs and exactly one of `url` or `file_path`. The URL must be a public HTTPS article location; the file must be inside the project folder. Do not invent a location or bypass an access boundary.
4. Inspect the route-specific receipt, raw and parsed byte sizes/hashes, and parsed SourceVersion ID. For the Europe PMC route, also inspect PMCID, license, and metadata/full-text response hashes.
5. Use only the returned parsed SourceVersion for later evidence spans. Cite exact UTF-8 byte ranges and preserve the distinction between retrieved bytes and deterministic parsed text.
6. If no lawful full-text route succeeds, the identity differs, the source version is stale, or parsing fails, leave the source body unverified. You may promote a persisted abstract only for explicitly abstract-only claims; do not treat it as full text.

## Verification

- `evidenceScope` must be `full-text`.
- The raw XML hash, parsed text hash, ResearchRun outputs, and current SourceVersion hash must agree.
- The SourceVersion access state must be `parsed` before staging or recording evidence.
- A successful replay must perform no new network request and return the same run and SourceVersion.
