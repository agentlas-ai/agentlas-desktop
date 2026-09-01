---
name: direct-study
description: Direct a single scientific study through explicit gated phases while preserving exact source, run, artifact, decision, analysis-plan, manuscript, and journal-validation lineage.
---

# Direct One Study

Read `../../agent/agent.md` as the operating contract and `../../contracts/research-state.schema.json`
as the durable state shape.

1. Call `inspect_research_workspace`, then load the latest study state. Use the returned bounded
   SourceVersion, ResearchRun, Lab, and artifact identities as the starting inventory. If none exists,
   create `intake` revision 1; never infer completed work or an artifact ID from prose alone.
   Immediately call `inspect_evidence_graph` for the current question or next gate. Treat its exact
   traversal, review, evidence-scope, and missing-requirement fields as active planning input, not as
   a decorative network. Rejected candidates stay out of later work; accepted candidates authorize
   only the exact reviewed content. Use `materialize_evidence_graph_inference` for an accepted
   hypothesis proposal so the exact graph, candidate, human-review, EvidenceSpan, Research Contract,
   and proposed-hypothesis hashes are durably linked. The proposed hypothesis still needs its normal
   human approval successor before any Research Episode. Use the corresponding canonical decision,
   plan, or Research Episode tools for other accepted work.
2. Determine the next legal phase from the state transition table. Perform only work belonging to
   that phase and only with host-advertised Science capabilities.
3. During intake, call `propose_research_contract` when no approved contract exists. Never approve
   the draft yourself or infer approval from chat prose; wait until the human decision surface returns
   the exact contract as approved.
4. Before each tool call, record its intended capability, bound inputs, and expected receipt kinds.
   Afterward, retain the exact IDs and hashes returned by the host.
5. Ask a bottom-sheet decision only when the answer changes the estimand, design, frozen plan,
   execution authority, interpretation, or target-journal package. Continue independent work while
   a non-blocking decision is pending. Before presenting any method or result, privately resolve in order:
   when the operation is needed, what scientific decision is live, what exact evidence/artifact view must
   be shown, whether the researcher needs to inspect/compare/choose/edit/authorize/report, and what valid
   next action follows. Use those answers to compose the surface; do not answer a generic feature checklist.
6. After academic search, call `retrieve_open_access_full_text` before making any body-dependent
   methods/results/limitations claim, then stage byte-exact evidence from that immutable full-text
   SourceVersion. When lawful OA retrieval is unavailable, use
   `promote_source_abstract_to_evidence` only for explicitly abstract-only claims and retain every
   body-dependent question as a gap. Confirm staged evidence in the committed ledger on the next
   turn; metadata-only and rejected stages never count as evidence.
7. Create one evidence-bound primary hypothesis and at least one evidence-bound alternative, append
   approval as immutable successor revisions, and use the host-computed hypothesis manifest at the
   analysis-plan gate.
8. After the approved contract and current hypothesis exist, inspect or start the authoritative
   Research Loop. Persist and start an exact Research Episode before Lab execution; after execution,
   settle it exactly once with terminal run IDs, run-backed artifact versions/hashes, and committed
   evidence spans. Revise a hypothesis only after that result exists, binding its exact episode ID in
   `episode_result_ids`; supported or contradicted states without a matching succeeded episode result
   are invalid. Before loop completion, call `verify_research_success_criterion` for every approved
   criterion using only evidence and exact artifact versions already bound to succeeded episodes;
   completion without the current passing receipt set is invalid. Before interpreting any visual,
   spatial, molecular, genomic, astronomical, network,
   graphical, or tabular result, pair `inspect_science_artifact` with
   `inspect_science_artifact_visual` for the same exact current version and verify that the MCP image
   block, capture ID, pixel hash, and artifact content hash agree. Metadata alone does not count as
   seeing the result. Respect the contract's episode and wall-time budgets.
9. Before selecting any statistical method or visualization, call
   `describe_statistics_capabilities` and preserve its exact method, diagnostic, independent-oracle,
   size-limit, Figure-template, renderer, 3D, and export boundaries. Do not substitute an absent
   method or claim R/MATLAB parity. After a successful statistical run, require one exact
   `agentlas.science.statistics.research-decision-linkage/v1`; verify its five ordered questions,
   exact returned `artifactRoles`, and evidence-triggered `nextActions`. Show the selected action's
   scientific `reason`, but do not treat a suggestion as authority to exclude data, change the
   estimand/model, execute a new confirmatory run, or bind a manuscript artifact. A missing, stale,
   or artifact-mismatched linkage is a runtime failure. Then inspect the exact analysis
   artifact and select only a returned `visualization_index`. Use `materialize_statistics_figure`
   for ordinary two-dimensional roles. For the exact `response-surface-grid` role returned by
   `response_surface_regression`, instead call `materialize_statistics_numeric_surface` with the exact
   parent version, content hash, and source artifact index. Require a run-backed `chart.numeric-3d` v2
   artifact whose observed points, convex-hull support mask, support counts, hashes, and parent lineage
   validate; masked cells are neither observations nor safe extrapolation. Inspect the resulting
   artifact and its adopted pixels as the same current version. A durable camera receipt preserves
   collaborative inspection state only and must remain bound to that artifact version/content hash and
   renderer version; it is not manuscript evidence. Those pixels are screen-review evidence, not publication raster bytes.
   For a
   manuscript-selected Figure, use `export_statistics_figure_svg` for a vector requirement or
   `export_statistics_figure_png` with an explicit width and 300/600 DPI for a raster requirement. The
   SVG call persists a new run-backed `image` artifact whose sole CAS run output is the exact UTF-8 SVG;
   its PNG capture is inspection-only. Inspect and validate the vector export artifact, bind its exact
   version and validation receipt, require a verified `figure-vector-profile` allowing only `svg`, and
   require the submission ZIP to contain the same SVG SHA-256 and bytes. The PNG call persists a new
   run-backed `image` artifact and exact CAS capture. Inspect and validate that raster export artifact,
   then bind its exact version, capture ID, and validation receipt to the manuscript; never bind the
   parent chart capture to satisfy a DPI rule. Require the journal profile's exact
   `figure-raster-profile` rule to pass before raster export. PDF, CMYK, and TIFF remain unavailable
   unless the live capability manifest says otherwise. The ordinary two-dimensional exporters do not
   export the interactive 3D response surface; require a dedicated live numeric-surface export with
   exact camera, lineage, and rendered-byte receipts or preserve that publication gap.
   For a continuous outcome repeated or clustered within exactly one grouping variable, consider
   `gaussian_random_intercept_lmm` only after ruling out the need for random slopes, multiple/nested/crossed
   groups, residual correlation or heteroscedasticity, weights, missing-data estimation, generated
   interactions, or a non-Gaussian model. Independent OLS and group-mean aggregation are not silent
   fallbacks. Before confirmatory execution, freeze an exact AnalysisSpec with `mixed-effects`, `normal`,
   `identity`, one `groupingVariables` entry, one `(1|<group>)` random effect, explicit numeric and
   reference-coded categorical fixed main effects, complete-case/exclusion policy, ML-versus-REML purpose,
   residual `n-p` inference boundary, diagnostics, sensitivity analyses, and the required diagnostic token
   `agentlas.statistics.method:gaussian_random_intercept_lmm`. Bind the exact spec/version/content/model
   hashes to execution. Use ML for prespecified fixed-structure comparison and refit the final model with
   REML; default final estimation to REML and never compare REML criteria across different fixed designs.
   After execution, inspect the exact artifact and pixels, then connect its returned fixed-effect,
   variance/ICC, BLUP, fitted/residual, trajectory/profile, caterpillar, and diagnostic roles to one next
   action: interpret/report, final REML refit, design/grouping review after `STAT_SINGULAR_FIT`, residual-
   model sensitivity, source review for extreme BLUPs, or an explicit unsupported random-slope/covariance/
   GLMM gap. BLUP intervals are conditional plug-in uncertainty, not group tests; an interval crossing zero
   never authorizes automatic term deletion.
10. For domain analysis, use only a live exact tool whose required parent run and explicit method
   inputs exist. `analyze_earthquake_gutenberg_richter` requires a completed USGS catalog run and
   explicit completeness magnitude/bin width/magnitude type; `analyze_hepdata_chi_square` requires a
   completed HEPData table run, exact-unit prediction vector, selected uncertainty labels, and fitted
   parameter count; `analyze_materials_lattice_metrics` requires a completed OQMD OPTIMADE catalog run
   and exact structure ID. Preserve each child ResearchRun, parent run, raw and normalized hashes,
   method boundary, exclusions, and warnings. Use `analyze_astrometric_kinematics` only for an exact
   uncertainty-bearing source dataset and hash. The current ten-column SIMBAD search result lacks the
   required uncertainty inputs and is not a valid substitute. `analyze_usgs_omori_utsu` additionally
   requires one complete USGS catalog and explicit mainshock, observation, time-completeness,
   magnitude-completeness, magnitude-type, bin-width, and p/c-bound choices; only `status: complete`
   is interpretable. `analyze_light_curve_periodicity` requires exact source/hash, declared time
   system, explicit row exclusions, frequency grid, and weighting policy; its finite-grid GLS peak
   has no FAP, multiplicity correction, or period confidence interval. Inspect each returned artifact and its
   exact visual capture before interpretation; a similar-looking chart is not analysis evidence.
11. Reconcile every manuscript claim against evidence-ledger entries. Unsupported, contradictory,
   or merely metadata-discovered claims stay visibly unresolved. Before creating or revising a
   manuscript, inspect the Evidence Graph for each substantive sentence and its citation, exact
   support path, result/figure/table binding, and evidence scope. An abstract-only source cannot
   support an article-body claim, and a citation without a support path cannot pass the claim gate.
12. Emit a new state revision after every material transition. Never rewrite an earlier revision.
13. For `phase_gate.evidenceSha256`, echo only the canonical hash returned by the current lifecycle,
   evidence/hypothesis manifest, frozen plan, run-backed artifact, claim gate, manuscript, verified
   journal profile, or journal-validation receipt required by that exact edge. Never hash a prose
   explanation locally. Re-read after every versioned mutation; stale and cross-project hashes are
   intentionally rejected.

## Outputs

- A machine-readable research-state revision with exact source/version/run/artifact bindings.
- Decision requests only at material forks, with affected nodes and a recommended option.
- An evidence ledger distinguishing discovered, content-verified, computed, contradicted, and absent evidence.
- A manuscript and journal-validation package only after their required gates pass.

## Verification

- The phase transition is allowed by `research-state.schema.json` and increments revision by one.
- Every scientific assertion names an evidence-ledger entry or is marked unsupported.
- Every bound ID was returned by a host receipt; no ID, hash, output, p-value, figure, or citation is synthesized.
- Every manuscript statistical Figure resolves to one exact analysis visualization, immutable Figure
  version, run-backed export artifact, visually inspected export capture, manuscript-validation
  receipt, and renderer-produced export hash. A journal vector rule resolves to the exact persisted SVG
  bytes in the final ZIP; a journal raster rule resolves to the same persisted PNG bytes. An interactive
  3D response surface is claimed only for the exact run-backed v2 artifact with observed points and a
  convex-hull support mask; unsupported export formats and 3D publication assets are never implied.
- A frozen analysis plan is unchanged during execution unless a recorded post-freeze decision creates a successor plan.
- Every confirmatory LMM run resolves to one exact frozen AnalysisSpec containing the bounded method token,
  one grouping variable and random intercept, fixed-effect coding, fit-method purpose, diagnostic plan, and
  exact model hash; unsupported dependence or outcome structures fail closed without OLS substitution.
- Every phase-gate hash resolves to the current immutable record in the granted project; a valid SHA
  string without that record must fail.
- `complete` requires a passing journal validation receipt and zero unresolved blocking claims.
