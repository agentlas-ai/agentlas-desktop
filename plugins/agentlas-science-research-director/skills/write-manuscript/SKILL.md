---
name: write-manuscript
description: Compose a journal-quality IMRaD manuscript in the Agentlas manuscript Markdown dialect, with every figure, table, citation, and equation bound to an exact project artifact or source version, then profile the target journal and validate the submission package.
---

# Write the Manuscript

Read `../../agent/agent.md` for the operating contract and `../direct-study/SKILL.md` for the
phases that precede this one. This skill covers the `manuscript`, `journal_profile`, and
`submission_validation` phases. It never invents a result, a citation, or a journal rule.

## Preconditions

- The lifecycle head is at `conclusions` with a bounded-conclusions gate, or a later phase.
- `inspect_research_workspace` and `inspect_evidence_graph` have been called this turn; every claim
  you intend to write has a non-invalidated support path, or is known to be unsupported.
- Every figure to be placed has an exact run-backed export artifact (SVG via
  `export_statistics_figure_svg`, PNG via `export_statistics_figure_png`, or a domain renderer's
  run-backed image artifact) that passed `validate_artifact_for_manuscript`.
- Every table to be placed is an exact run-backed table artifact version.
- Every source to be cited is an exact `sourceId + sourceVersionId` from the committed evidence
  ledger (`list_project_evidence`).

Manuscript drafting is one phase of a continuing study. Unless the researcher explicitly requested a
bounded manuscript deliverable, a completed section, assembled manuscript version, page/word target,
or first draft is not goal completion. After each material manuscript action, re-read the durable
Research Loop and study state, preserve the exact claim and artifact receipts, and continue any
unmet success criteria, robustness, conclusions, journal profiling, or validation. Close the study
only through the canonical loop criterion receipts and lifecycle gates; never stop because one
provider turn or manuscript pass ended.

## Build the manuscript blueprint before prose

Do not start by filling an IMRaD skeleton. A heading-only document or one sentence under each
heading is an editor scaffold, not a manuscript, and must never be described as journal-ready.
Before `create_science_manuscript`, build a durable manuscript blueprint from the project's already
retrieved literature and the target article type. This is not a prose-only checklist:

- Call `inspect_source_text_structure` for every candidate exact SourceVersion. Only candidates
  whose returned index has `evidenceScope: full-text` are eligible. Map the returned stable source
  section IDs to the functional roles they actually perform; a heading label alone is not a role.
- Before a candidate can affect any numeric word, paragraph, or section range, call
  `record_manuscript_comparable_eligibility` with the exact SourceVersion, article family, project
  field, target-journal relationship, and at least two exact byte-quote locators from distinct
  full-text sections. Re-read it with `inspect_manuscript_comparable_eligibility`. Only a `current`
  receipt whose decision is `quantitative-calibration` may enter the Blueprint, and its exact
  receipt ID must be supplied as `eligibility_receipt_id` on that comparable.
- A same-field paper of another article family, a book chapter, or a cross-field paper may be a
  `rhetorical-analogue-only` source for ideas and flow discussion, but it must never enter the
  quantitative corpus. Do not combine several related project domains into one calibration cohort;
  every comparable in one Blueprint must carry the same exact source-domain classification.
- Call `create_manuscript_blueprint` with those exact SourceVersion identities, section mappings,
  and the planned rhetorical section jobs. The host recomputes body and per-role word/paragraph
  distributions from the indexed source bytes. It also emits an immutable
  `ScienceManuscriptCorpusStructureProfile/v1` containing each comparable's observed section
  order, abstract/reference/appendix depth, explicit Figure/Table/Equation/reference counts,
  corpus role-order consensus, and transition support. These measurements are host-derived;
  never supply, rewrite, or invent them or a passing threshold.
- Compare the stored `structureProfile.plannedOrder` with the corpus consensus before drafting.
  A non-empty `conflicts` list is not silently reordered: the Blueprint records an explicit
  limitation. Resolve it by correcting the section plan or documenting an exact article- or
  journal-specific reason. Do not describe a conflicting unexplained plan as corpus-conformant.
- Re-read the stored blueprint with `inspect_manuscript_blueprint`. One to four comparable full
  texts remain `collecting`; five or more permit a current corpus calibration. Do not create a
  Research Director manuscript or close one out against `collecting` or `stale`.
- Pass the exact returned `blueprintId + currentVersion + contentSha256` as `blueprint_binding`
  when calling `start_manuscript_drafting_session`. Do not try to fit a full paper into one model
  response. Re-read the returned durable plan and use its exact `session.id + version +
  stateSha256` for every section revision. If the corpus, article family, section plan, or journal
  changes, stop assembly, revise the Blueprint, and begin a new session against that exact version.

Then construct the blueprint content as follows:

1. Classify the article family as `empirical`, `theoretical/proof`, `review/synthesis`,
   `methods/model`, or `data/resource`. Do not force every family into IMRaD. An empirical paper
   normally uses Introduction, Methods, Results, and Discussion; a proof paper normally uses
   definitions, propositions or theorems, lemmas, proofs, and a conclusion; a review normally uses
   an explicit search/scope method followed by thematic synthesis; a methods paper must separate
   formulation, algorithm or apparatus, validation, comparison, and limitations.
2. Select structurally comparable papers from exact project Sources. Prefer lawful full text in the
   same field, article family, and target journal; abstract-only Sources may inform the question but
   cannot calibrate body structure. Record and inspect the immutable eligibility receipt for every
   candidate before calling the Blueprint tool. Use 5--20 quantitatively eligible comparable full
   texts from one source domain. If fewer than five full texts
   are available, retain the host-returned `collecting` state, continue searching,
   and use only explicit official-journal rules as hard constraints. Never pretend an abstract
   reveals the paper's section flow.
3. Inspect the host-derived structure profile for every comparable paper: observed section order,
   words per section, paragraph count, abstract/reference/appendix depth, explicit
   figure/table/equation labels, reference-entry count, consensus role order, and transition
   support. Supply only the rhetorical job and exact section mappings; the host owns the numeric
   observations. Use the observed range, constrained by the official journal maximums, to set a
   target interval; do not copy one paper's length or wording.
4. Build one section card per planned section containing: its research question, rhetorical moves,
   exact Evidence Graph nodes, claims allowed by those nodes, planned figure/table/equation
   locators, citations, unresolved gaps, expected paragraph sequence, and target word interval.
   Every planned paragraph must have a job such as context, gap, design choice, result,
   qualification, contrast, limitation, or transition. Padding has no valid job.
5. Build the document-level flow: what the reader knows before the section, what changes in that
   section, and what question the next section inherits. The Abstract is drafted last from the
   completed and reconciled body, not first from the research question.

The blueprint is a drafting constraint, not evidence. It may shape length and flow, but it cannot
authorize a scientific claim. When a target journal is chosen later, recompute the blueprint
against its verified profile rather than squeezing the old prose into a new word limit.

## Draft in passes

Write the manuscript in passes so that completeness is inspectable:

1. **Claim-to-section matrix.** Assign each supported, contradicted, inconclusive, and unresolved
   claim to the section where it belongs. A citation list is not a literature synthesis.
2. **Section and paragraph outline.** Create the ordered section cards and paragraph jobs before
   prose. Each Results block must point to an exact result/table/figure; each Discussion block must
   point back to a reported result or an explicit evidence gap.
3. **Evidence-bound prose.** Write complete paragraphs with topic, evidence, interpretation within
   scope, and a transition where needed. Do not repeat one result in different words to manufacture
   length.
4. **Cross-section coherence.** Verify that the Introduction's gap becomes the Methods' design,
   every prespecified method has a result or an explained failure, every headline result is
   interpreted in Discussion, and every limitation changes the stated conclusion or next study.
5. **Depth preflight.** Compare observed words, paragraphs, visuals, equations, references, and
   rhetorical moves with the blueprint. Block manuscript closeout when a core section is empty,
   consists of a single placeholder sentence, has no evidence-bearing paragraph, or falls outside
   the blueprint without an explicit journal- or study-specific reason.

Never use a fixed global word count as a substitute for this preflight. Length is article-family,
field, and journal dependent; shallow structure and unsupported filler are both failures.

## Durable section drafting

For a new full manuscript, `start_manuscript_drafting_session` is the only normal creation path.
The direct `create_science_manuscript` tool is a compatibility/import boundary for an already
complete externally authored draft; never use it to bypass section planning or to save an outline.

1. Start the session with the exact current Blueprint and complete binding manifest, then call
   `inspect_manuscript_drafting_session` before writing. The returned plan is host-derived and is
   not rewritten in prose.
2. Draft the body in evidence dependency order, not display order: Methods or Theory, Results,
   Introduction and Related Work, Discussion, Limitations, Conclusion, then Abstract. Save one
   section per tool call with `save_manuscript_section_draft` and the exact latest version and state
   hash. Section Markdown is body-only: do not include YAML, `#`, or `##` headings; `###`
   subsections are allowed when the Blueprint needs them.
3. Treat `status: draft` as unfinished. Inspect the host-measured word and substantive-paragraph
   counts, revise the same section into a new immutable revision, and continue only when it is
   `ready`. Readiness is structural depth, not truth or publication approval.
4. Draft the Abstract last. It may synthesize only claims, estimates, uncertainty, scope, and
   limitations already present in ready body sections. The host rejects an early Abstract.
5. After every required section is ready, call `assemble_manuscript_drafting_session`. The host
   assembles the latest section heads in Blueprint order and reruns the whole-document gate before
   creating manuscript v1. A stale Blueprint, stale session CAS, missing section, shallow section,
   short document, or duplicate-paragraph padding blocks assembly.
6. After restart, never infer progress from the chat transcript. Inspect the durable session and
   resume from the returned section heads. Cancelled and assembled sessions are terminal.

## The manuscript Markdown dialect

The renderer in `electron/science/manuscript/` understands exactly this dialect. Write nothing
else for placement, citation, or cross-reference.

### Front matter

Begin the document with YAML front matter:

```yaml
---
title: "Full manuscript title"
authors:
  - name: "Given Family"
    affiliations: [1]
    corresponding: true
    email: "corresponding@example.org"
  - name: "Given Family"
    affiliations: [1, 2]
affiliations:
  - id: 1
    name: "Department, Institution, City, Country"
  - id: 2
    name: "Department, Institution, City, Country"
abstract: >
  Structured or unstructured abstract, written from the reconciled claim ledger.
keywords: ["keyword one", "keyword two", "keyword three"]
---
```

Author and affiliation values come from the researcher or the project; never invent names,
emails, or institutions. If they are missing, leave the field empty and list it as a manual
attestation.

### Section structure

Use the article-family blueprint's section order unless the verified journal profile requires
otherwise. For an empirical article, use `# Introduction`, `# Methods`, `# Results`,
`# Discussion`, then `# Acknowledgements` (optional), `# Data and code availability`, and
`# References`. Sub-sections use `##` and `###`. Methods derive from the frozen analysis plan and
execution receipts; Results from verified outputs only; Discussion from the reconciled claim
ledger, with a Limitations sub-section written from the actual evidence gaps. Theoretical/proof,
review/synthesis, methods/model, and data/resource articles use the section grammar recorded in
their blueprint rather than cosmetic IMRaD headings.

### Placeholders

| Purpose | Syntax | Binds to |
|---|---|---|
| Place a figure | `{{figure:<locator>}}` | exact export artifact `artifactId@version` |
| Place a table | `{{table:<locator>}}` | exact table artifact `artifactId@version` |
| Cite a source | `{{cite:<locator>}}` | exact `sourceId@sourceVersionId` |
| Reference a figure in text | `{{ref:fig:<locator>}}` | the same locator used in `{{figure:...}}` |
| Reference a table in text | `{{ref:tab:<locator>}}` | the same locator used in `{{table:...}}` |
| Reference an equation | `{{eq:<label>}}` | a `$$...$$` block with the label in the binding manifest |

Rules:

- A locator is an opaque token you assign once per asset (for example `fig-lmm-coefficients`); the
  binding manifest maps each locator to its exact artifact or source version and content hash. The
  same locator must not point at two different versions.
- Place a figure or table placeholder on its own line, immediately followed by its caption line.
  Captions are numbered by the renderer in placement order; write the caption text without a
  number: `Figure caption text.` becomes "Figure 1. Figure caption text." Tables use the same
  rule with "Table N.".
- Multiple citations in one sentence use adjacent placeholders: `{{cite:a}}{{cite:b}}`. The
  renderer formats them and generates the numbered or author-year reference list from the bound
  source versions according to the journal profile. Never write a reference entry by hand.
- Refer to figures and tables in prose only through `{{ref:fig:...}}` and `{{ref:tab:...}}`; never
  hard-code "Figure 2".
- Do not place a figure, table, or citation for which no exact binding exists. Leave the sentence
  in the draft, mark it in the claim ledger as unbound, and report it; do not smooth it over.

### Math

Inline math uses `$...$`; display math uses `$$...$$` on its own lines. Give a display equation a
label in the binding manifest and refer to it with `{{eq:<label>}}`. Write estimands and models
explicitly, for example the frozen LMM as
`$$ y_{ij} = \beta_0 + \beta_1 x_{ij} + b_{0j} + \varepsilon_{ij}, \quad b_{0j} \sim \mathcal{N}(0, \sigma_b^2) $$`.

### Tables written inline

Small summary tables that are not run-backed artifacts (for example the PRISMA count table or a
study-characteristics table built from the evidence matrix) may be written as GFM tables. Every
numeric cell in such a table must still trace to a receipt (a committed evidence span or an
artifact value) recorded in the claim ledger; otherwise the table is exploratory and must say so.

### Results prose

Report effect size, interval, and the exact n for every estimate. Use the status words of the
claim ledger. Name the pre-specified analysis and, when a sensitivity analysis changes the
reading, say how. A null or contradicted result is written with the same specificity as a
positive one.

## Procedure

1. Query the Evidence Graph for each substantive sentence and collect its exact support path,
   result/figure/table binding, and evidence scope. Abstract-only support cannot carry a
   methods, results, or limitations sentence.
2. Assemble the binding manifest: locator -> exact artifact version + content hash (figures,
   tables), locator -> exact source version (citations), label -> equation. Only host-returned IDs
   and hashes enter it.
3. Build and inspect the manuscript blueprint, then write the front matter and article-family
   sections in the dialect above, in the researcher's language unless the target journal requires
   another. Do not create version 1 while any section card lacks its evidence path or an explicit
   unresolved marker. An outline stays in planning/chat: never send a heading scaffold, one-line
   section, or visually padded placeholder prose to `create_science_manuscript`. Use at least five
   eligible comparable full texts for a current Blueprint.
   The global anti-stub floor is only a rejection floor, never the writing target; the host-derived
   section and document ranges in the exact Blueprint are the target.
4. Create version 1 through the durable section session and
   `assemble_manuscript_drafting_session`. For every later change, call
   `inspect_science_manuscript` for the current version and
   content hash, then `save_science_manuscript_version` with the complete Markdown and manifest.
   After every created or revised version, call `inspect_science_manuscript` and read its host-made
   `depthPreflight`. If `antiStubPassed` is false, remain in manuscript drafting and resolve every
   reported shallow section. If it is true, still compare the measured section metrics with the
   corpus blueprint; the host explicitly reports that anti-stub success is not journal readiness.
5. Run `prepare_manuscript_claim_context`, then explicitly classify every returned canonical
   sentence before calling `seal_manuscript_claim_ledger` (revision 1), or append a complete sealed
   manifest with `append_manuscript_claim_ledger_revision`. There is no blanket or default
   `non-factual` classification: omission fails closed, and marking a sentence non-factual is
   itself an explicit review decision. For every supported `method` or `result`, first run
   `validate_artifact_for_manuscript`, bind that exact artifact target into the manuscript, include
   its receipt in `prepare_manuscript_claim_context`, and submit `evidence_assessments` that pair the
   exact citation and validation receipt with an explicit direction, relevance, and assessment
   confidence. Never put artifact IDs, versions, or hashes in that assessment: the host derives
   them from the receipt and rejects a missing run-output closure, failed receipt, or artifact not
   bound into the exact manuscript version. Citation-only evidence cannot make a method or result
   publication-ready. Then run `evaluate_manuscript_claim_gate`. Resolve failing
   claims by fixing the sentence or its binding, never by removing the ledger entry. Use the ready
   claim-gate report hash for the `conclusions -> manuscript` gate and the exact manuscript content
   hash for `manuscript -> journal_profile`.
6. Journal profile: when the target journal is named, call `inspect_official_journal_guidelines`
   for each official page that carries manuscript, figure, data, or review rules, then
   `create_journal_profile_from_official_guidelines` from those exact inspection IDs. If no journal
   is named and the researcher wants validation, ask once with two or three fitting candidates and a
   recommendation. Use the verified profile content hash for `journal_profile -> submission_validation`.
7. Call `record_manuscript_blueprint_assessment` for the exact current manuscript and verified
   journal profile, then re-read it with `inspect_manuscript_blueprint_assessment`. Continue only
   when the immutable receipt is `current` and its `structuralStatus` is `passed`. This host-owned
   receipt freezes the assessment-policy hash, full depth report, exact heading-node locators, and
   per-section observed-versus-corpus ranges; never compute or override those values in the agent.
8. Perform the scholarly-flow pass with `record_manuscript_scholarly_assessment`. For every exact
   Blueprint section, inspect the stable manuscript document nodes and attest every rhetorical
   move and evidence role using exact paragraph `nodeId + revision + contentSha256 + from + to +
   exactQuote` locators. State what the reader knows before the section, what the section changes,
   and what question the next section inherits. Do not mark a move satisfied merely because its
   keywords appear, do not reorder Blueprint sections, and do not reuse one paragraph as the sole
   evidence for every distinct move and evidence role in a multi-paragraph section. The host
   independently checks corpus-calibrated paragraph sequence, exact section order, evidence
   distribution, and required visual coverage from exact document nodes and bindings. Re-read the receipt with
   `inspect_manuscript_scholarly_assessment`; remain in drafting when it is stale or blocked. A
   passed receipt proves conformance to this exact Blueprint and evaluator policy, not peer review
   or scientific truth.
9. Close every manuscript number against the data that produced it. Call
   `inspect_science_artifact_numeric_values` with the exact validated artifact version and receipt,
   then select the returned JSON Pointer for each sample size, estimate, confidence-limit component,
   or physical quantity. Call `prepare_manuscript_coherence_context`, submit those host-returned
   selectors to `record_manuscript_coherence_assessment`, and re-read the assessment. Never copy a
   displayed number into the declaration without its exact pointer; never supply a value, unit,
   validation fact, run ID, or provenance hash yourself. The host resolves those fields from the
   immutable artifact, checks that the number is reachable from the owning claim or visual, and
   applies exact or declared half-away-from-zero rounding. A confidence interval binds three
   components (`confidence-level`, `lower`, `upper`); a quantity binds its explicit unit pointer.
   Remain in drafting when the receipt is stale or blocked. A repeated literal from another
   artifact is not the same result.
10. Validate with `validate_manuscript_for_journal` against the exact manuscript and profile
   versions. Fix every error-level finding (re-export a figure at the required format or DPI,
   restructure sections, adjust word counts, bind a missing data statement) and re-validate. List
   warnings and manual attestations for the researcher. Re-run the depth preflight against the
   journal-constrained blueprint; passing a heading-presence rule is not evidence of a complete
   section.
11. Export with `export_journal_submission_bundle`. The ZIP must contain the exact bound figure
   bytes and hashes (SVG for a `figure-vector-profile`, 300/600-DPI PNG for a
   `figure-raster-profile`), the journal profile, validation report, evidence ledger, metadata, and
   cover letter, full-text Blueprint, and immutable Blueprint Assessment receipt. Bind the export
   hash for `submission_validation -> ready_to_submit`.
12. Report: manuscript version and hash, number of bound figures/tables/citations, unresolved
   claims, validation findings by level, and the attestations the researcher must make before
   submitting. Submission itself is the researcher's act.

## Verification

- Every `{{figure:...}}`, `{{table:...}}`, `{{cite:...}}`, `{{ref:...}}`, and `{{eq:...}}` locator
  resolves in the binding manifest to a host-returned ID, version, and hash.
- No reference entry, figure number, or table number was written by hand.
- Every Results sentence maps to a claim-ledger entry with status `supported`; weakened or
  contradicted findings are stated as such in Results and Discussion.
- The article family is explicit, comparable full-text Source versions are named, and the final
  section/paragraph/visual/reference measurements are compared with the manuscript blueprint.
- No core section is a heading-only scaffold, a single placeholder sentence, or unsupported filler.
- The exact scholarly assessment is current and passed; every planned move, evidence role, section
  transition, and conditional visual expectation has exact node-level support.
- The exact manuscript-coherence assessment is current and passed; every non-exempt manuscript
  number resolves through a host-inspected JSON Pointer to a validated run-backed artifact, and the
  exported `submission/numeric-provenance.json` matches the manifest closure.
- The claim gate is ready before the journal profile is built, and validation passes with zero
  error-level findings before export.
