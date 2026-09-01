---
name: agentlas-academic-search
description: Route every prior-research, literature-review, novelty, citation, related-paper, and state-of-the-art request through the Agentlas Science academic search workflow.
---

# Academic Search Router

Use `$search` whenever a Science turn asks for or relies on prior research, literature review, novelty, state of the art, related papers, citations, or what has already been tried.

After discovery, use `$full-text` when a claim depends on the article body and the selected Source has a DOI or PMID. Prefer the exact Open Access full-text route over abstract-only promotion. If OA full text is unavailable, preserve the abstract-only limitation.

Do not invoke it for a purely local calculation or for manipulating an already-bound artifact unless that work introduces a new literature claim.

The search workflow requires `search_academic_literature`; full-text verification requires `retrieve_open_access_full_text`. If either tool is absent, state the exact unavailable step and do not substitute invented sources or arbitrary publisher scraping.
