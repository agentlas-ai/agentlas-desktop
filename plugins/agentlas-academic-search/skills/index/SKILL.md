---
name: agentlas-academic-search
description: Route every prior-research, literature-review, novelty, citation, related-paper, and state-of-the-art request through the Agentlas Science academic search workflow.
---

# Academic Search Router

Use `$search` whenever a Science turn asks for or relies on prior research, literature review, novelty, state of the art, related papers, citations, or what has already been tried.

After discovery, use `$full-text` when a claim depends on the article body and the selected Source has a DOI or PMID. Prefer the exact Open Access full-text route over abstract-only promotion. If OA full text is unavailable, preserve the abstract-only limitation.

Do not invoke it for a purely local calculation or for manipulating an already-bound artifact unless that work introduces a new literature claim.

The search workflow requires `search_academic_literature`. Full-text verification uses `retrieve_open_access_full_text` for the Europe PMC Open Access route or `retrieve_source_full_text_from_location` for a lawful public HTTPS article location or a project-folder file. If the relevant tool or lawful location is unavailable, state the exact unavailable step; never substitute invented sources or arbitrary publisher scraping.
