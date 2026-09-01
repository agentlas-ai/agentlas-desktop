export const SCIENCE_RESEARCH_INTENT_SCHEMA = "agentlas.science.research-intent-catalog/v1" as const;

export const SCIENCE_RESEARCH_ANSWER_KINDS = [
  "free-text",
  "single-select",
  "multi-select",
  "numeric",
  "confirmation",
] as const;
export type ScienceResearchAnswerKind = typeof SCIENCE_RESEARCH_ANSWER_KINDS[number];

export const SCIENCE_RESEARCH_DESTINATION_KINDS = [
  "lab",
  "artifact",
  "analysis-plan",
  "human-decision",
  "manuscript",
] as const;
export type ScienceResearchDestinationKind = typeof SCIENCE_RESEARCH_DESTINATION_KINDS[number];

export interface ScienceResearchClarifyingQuestion {
  id: string;
  prompt: string;
  answerKind: ScienceResearchAnswerKind;
  blockingWhen: string;
}

export interface ScienceResearchNextAction {
  trigger: string;
  action: string;
  destinationKind: ScienceResearchDestinationKind;
  destinationId: string | null;
  reason: string;
  requiresHumanDecision: boolean;
}

export interface ScienceLabResearchIntent {
  labId: string;
  neededWhen: string;
  notWhen: string;
  liveDecision: string;
  userGoal: string;
  requiredInputs: string[];
  clarifyingQuestions: ScienceResearchClarifyingQuestion[];
  rendering: {
    mustShow: string[];
    researcherActions: string[];
    aiInspectionSignals: string[];
    claimBoundaries: string[];
  };
  nextActions: ScienceResearchNextAction[];
  manuscript: {
    roles: Array<"figure" | "table" | "supplement">;
    requirements: string[];
  };
}

export interface ScienceResearchIntentCatalog {
  schema: typeof SCIENCE_RESEARCH_INTENT_SCHEMA;
  version: 1;
  intents: ScienceLabResearchIntent[];
}

const q = (
  id: string,
  prompt: string,
  answerKind: ScienceResearchAnswerKind,
  blockingWhen: string,
): ScienceResearchClarifyingQuestion => ({ id, prompt, answerKind, blockingWhen });

const next = (
  trigger: string,
  action: string,
  destinationKind: ScienceResearchDestinationKind,
  destinationId: string | null,
  reason: string,
  requiresHumanDecision = false,
): ScienceResearchNextAction => ({ trigger, action, destinationKind, destinationId, reason, requiresHumanDecision });

const INTENTS: Readonly<Record<string, ScienceLabResearchIntent>> = Object.freeze({
  "data-table": {
    labId: "data-table",
    neededWhen: "When imported or retrieved observations must be understood, repaired, filtered, joined, or frozen before any scientific analysis.",
    notWhen: "Do not use a table preview as a substitute for a domain renderer, a validated analysis, or evidence that the observed sample represents the target population.",
    liveDecision: "Whether the exact dataset is analysis-ready and which row, column, unit, missingness, and exclusion rules are defensible.",
    userGoal: "See and correct the evidence behind every downstream result instead of trusting an opaque upload or API response.",
    requiredInputs: ["versioned source or dataset", "column meaning and units", "row identity or observation key"],
    clarifyingQuestions: [
      q("observation-unit", "What does one row represent?", "free-text", "Always blocking when the observation unit cannot be inferred from provenance."),
      q("missingness-policy", "How should missing, impossible, duplicate, and censored values be treated?", "multi-select", "Blocking before exclusions, imputation, aggregation, or a confirmatory analysis."),
      q("analysis-cohort", "Which rows define the intended analysis population or experimental batch?", "free-text", "Blocking when the source contains multiple populations, batches, or time windows."),
    ],
    rendering: {
      mustShow: ["exact rows with stable row identities", "types, units, valid ranges, and missingness by column", "filters, transformations, and exclusions as reversible operations", "source and dataset version provenance"],
      researcherActions: ["sort, filter, search, select, and inspect a row", "edit a proposed transformation without overwriting the source", "compare dataset versions and approve a frozen analysis input"],
      aiInspectionSignals: ["missingness pattern", "duplicate or impossible rows", "unit or type inconsistency", "distribution and batch shifts"],
      claimBoundaries: ["A clean-looking table is not evidence of representativeness.", "The AI must not silently delete, impute, recode, or merge observations."],
    },
    nextActions: [
      next("data-quality-defect", "open-exact-rows-and-propose-repair", "artifact", null, "The researcher needs to inspect the observations that would change the analysis."),
      next("analysis-ready", "freeze-versioned-analysis-dataset", "analysis-plan", null, "Every later run must bind to one reviewed dataset version.", true),
      next("distribution-or-relationship-question", "open-statistics-or-visualization-with-selected-columns", "lab", "statistics-analysis", "Selection should flow into the next analysis without re-entry."),
      next("cohort-or-dataset-description-approved", "bind-cohort-table-data-dictionary-and-flow-counts", "manuscript", null, "The paper must describe the exact observations and exclusions used by downstream results.", true),
    ],
    manuscript: { roles: ["table", "supplement"], requirements: ["cohort and exclusion counts", "data dictionary and units", "exact transformation and missingness policy"] },
  },
  "statistics-analysis": {
    labId: "statistics-analysis",
    neededWhen: "When a scientific question must be translated into an estimand, a frozen analysis plan, quantified uncertainty, diagnostics, and a defensible decision.",
    notWhen: "Do not execute a method merely because columns fit its input shape, or when the estimand, dependence structure, data support, and confirmatory status are unresolved.",
    liveDecision: "Which analysis answers the prespecified question, whether its assumptions and support hold, and what conclusion or further evidence is justified.",
    userGoal: "Reach a scientifically interpretable estimate with uncertainty and diagnostics, not merely obtain a p value or attractive chart.",
    requiredInputs: ["frozen dataset version", "outcome, predictor, grouping, pairing, or time roles", "estimand and scientific decision threshold"],
    clarifyingQuestions: [
      q("estimand", "What exact quantity or contrast should this analysis estimate?", "free-text", "Always blocking before method selection when the estimand is absent."),
      q("design", "Which observations are independent, paired, repeated, clustered, censored, or ordered in time?", "multi-select", "Blocking whenever the dependence structure changes uncertainty or the valid method."),
      q("confirmatory-status", "Is this confirmatory, preregistered, exploratory, or a sensitivity analysis?", "single-select", "Blocking before multiplicity handling and manuscript claim language."),
    ],
    rendering: {
      mustShow: ["effect estimate, interval, units, and scientific threshold", "sample and missingness support", "model formula, coding, and assumptions", "diagnostics, influence, multiplicity, and sensitivity results linked to exact source rows"],
      researcherActions: ["inspect a diagnostic point in the source table", "compare approved model or method variants", "approve or revise the analysis plan before execution", "materialize a publication figure or table from the exact result"],
      aiInspectionSignals: ["assumption violation", "unsupported extrapolation", "influence or sparse support", "estimate instability and discordant sensitivity"],
      claimBoundaries: ["Statistical significance is not scientific importance.", "Exploratory method changes must not be relabeled as prespecified confirmation."],
    },
    nextActions: [
      next("estimand-or-design-unclear", "request-blocking-analysis-decision", "human-decision", null, "The valid method depends on the research design.", true),
      next("diagnostic-defect", "open-source-evidence-and-create-sensitivity-plan", "analysis-plan", null, "A visible defect should lead to a declared successor analysis rather than silent model shopping."),
      next("result-reviewed", "materialize-estimate-diagnostic-and-decision-artifacts", "manuscript", null, "Reportable evidence must preserve the estimate, uncertainty, diagnostics, and provenance.", true),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["estimand and analysis population", "effect estimate with uncertainty", "software, method, assumptions, diagnostics, and sensitivity analyses"] },
  },
  "data-visualization": {
    labId: "data-visualization",
    neededWhen: "When a researcher must see distribution, relationship, uncertainty, trend, surface, or anomaly in data before making or communicating a decision.",
    notWhen: "Do not create a visualization only to decorate an answer, conceal source rows, replace numeric evidence, or interpolate beyond observed support.",
    liveDecision: "Which visual encoding reveals the decision-relevant pattern without hiding denominators, uncertainty, missingness, or unsupported regions.",
    userGoal: "Interrogate evidence interactively and produce a figure whose scientific meaning survives export to a manuscript.",
    requiredInputs: ["versioned data or analysis result", "question the figure must answer", "semantic roles, units, and grouping"],
    clarifyingQuestions: [
      q("figure-question", "What decision or comparison must the figure make possible?", "free-text", "Always blocking when the request is only 'make a chart'."),
      q("audience", "Is this for exploration, lab review, a primary paper figure, or a supplement?", "single-select", "Blocking before visual density, annotation, and export choices."),
    ],
    rendering: {
      mustShow: ["axes, units, denominator, sample support, and legend", "uncertainty and missing or censored observations when relevant", "raw observations or an accessible route to them", "exact data and renderer version provenance"],
      researcherActions: ["zoom, filter, brush, inspect, and trace marks to rows", "change valid encodings without mutating data", "save a versioned view and export journal-ready vector or raster output"],
      aiInspectionSignals: ["overplotting", "scale or baseline distortion", "hidden uncertainty", "unsupported interpolation or 3D surface regions"],
      claimBoundaries: ["Visual salience is not effect size.", "A publication figure must not conceal exclusions or replace the underlying numeric result."],
    },
    nextActions: [
      next("unexpected-pattern", "open-linked-rows-and-formulate-testable-explanation", "analysis-plan", null, "The visual pattern should generate a traceable hypothesis or data-quality check."),
      next("encoding-obscures-decision", "revise-view-with-decision-preserving-encoding", "artifact", null, "The renderer exists to support a research decision, not decoration."),
      next("figure-approved", "bind-exact-figure-version-to-manuscript", "manuscript", null, "The manuscript must reference the reviewed artifact and export receipt.", true),
    ],
    manuscript: { roles: ["figure", "supplement"], requirements: ["caption states population, encoding, units, and uncertainty", "source and analysis binding", "journal-compliant dimensions, fonts, and export format"] },
  },
  "economic-indicators": {
    labId: "economic-indicators",
    neededWhen: "When an economic claim depends on selecting, aligning, transforming, comparing, or revising official time-series indicators.",
    notWhen: "Do not use an indicator chart alone to claim causal policy impact or compare series whose definitions, vintages, units, or population bases are incompatible.",
    liveDecision: "Which indicator definition, geography, frequency, price basis, transformation, and vintage answer the research question.",
    userGoal: "Compare economies or periods without mixing incompatible definitions or treating revised values as timeless facts.",
    requiredInputs: ["economic concept and geography", "time range and frequency", "official indicator series or source"],
    clarifyingQuestions: [
      q("indicator-definition", "Which economic concept, unit, price basis, seasonal adjustment, and population basis are intended?", "free-text", "Blocking when multiple official series can match the same plain-language request."),
      q("comparison-basis", "Should values be levels, growth rates, shares, indexed values, or per-capita measures?", "single-select", "Blocking before cross-country or cross-period comparison."),
    ],
    rendering: {
      mustShow: ["series definition, unit, geography, frequency, and source", "observation and retrieval dates plus revision or vintage boundary", "missing periods, transformations, and rebasing", "comparable chart and exact values"],
      researcherActions: ["change country, interval, and defensible transform", "inspect exact observations and metadata", "overlay events or compare official series versions"],
      aiInspectionSignals: ["structural break", "base or unit mismatch", "revision sensitivity", "nominal versus real or aggregate versus per-capita confusion"],
      claimBoundaries: ["Temporal co-movement does not establish causal impact.", "Mixed source definitions must not be plotted as directly comparable without disclosure."],
    },
    nextActions: [
      next("definition-or-vintage-conflict", "request-series-selection-decision", "human-decision", null, "The scientific conclusion can reverse under a different valid series.", true),
      next("time-series-structure", "open-statistical-time-series-diagnostics", "lab", "statistics-analysis", "Trend and autocorrelation change valid inference."),
      next("reportable-indicator-result", "bind-chart-table-and-source-metadata", "manuscript", null, "Readers need both the series and its definition."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["indicator codes and providers", "retrieval date and transformation formula", "revision and comparability limitations"] },
  },
  "literature-network": {
    labId: "literature-network",
    neededWhen: "When the researcher must find prior work, map a field, trace support and opposition, identify gaps, or justify why a new study is needed.",
    notWhen: "Do not treat citation counts, semantic proximity, abstracts, or a visually dense network as proof of scientific support, novelty, or review completeness.",
    liveDecision: "Which works and evidence spans are in scope, how they relate, and whether the proposed question is novel, contested, replicated, or already resolved.",
    userGoal: "Move from search results to a reviewable evidence map that can support hypotheses, methods, and manuscript citations.",
    requiredInputs: ["research question and inclusion concepts", "date, domain, publication-type, and population boundaries", "academic search results or project sources"],
    clarifyingQuestions: [
      q("review-scope", "What population, intervention or phenomenon, comparator, outcome, methods, and date range define relevance?", "free-text", "Blocking before screening when broad keywords would mix distinct questions."),
      q("evidence-priority", "Should the search prioritize foundational work, newest work, systematic reviews, methods, replication, contradiction, or all of them?", "multi-select", "Blocking when ranking policy changes the corpus used for planning."),
    ],
    rendering: {
      mustShow: ["search query and provider coverage", "included, excluded, duplicate, inaccessible, retracted, and unverified records", "citation and semantic clusters without equating citation with support", "claim-to-source-to-evidence-span paths and unresolved contradictions"],
      researcherActions: ["screen, tag, group, open, and inspect a source", "follow citations and related works", "promote exact text to evidence", "create or revise a hypothesis from selected evidence"],
      aiInspectionSignals: ["missing seminal or contrary work", "citation cascade without independent evidence", "publication or recency bias", "unsupported synthesis claim"],
      claimBoundaries: ["A citation edge is not a support edge.", "Abstract-only access cannot be represented as full-text verification."],
    },
    nextActions: [
      next("coverage-gap", "expand-or-narrow-search-with-recorded-rationale", "lab", "literature-network", "Search iteration must remain reproducible."),
      next("material-source", "retrieve-full-text-and-stage-exact-evidence-spans", "artifact", null, "The research plan needs inspectable evidence rather than summaries alone."),
      next("novel-or-contested-gap", "propose-hypothesis-and-discriminating-study", "analysis-plan", null, "A gap becomes useful only when it yields a testable next study.", true),
      next("review-corpus-approved", "bind-search-screening-evidence-map-and-citations", "manuscript", null, "The Introduction and review claims must remain linked to the exact screened corpus.", true),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["reproducible search and screening record", "exact citation metadata", "claim-level evidence and access limitations"] },
  },
  "astronomy-sky": {
    labId: "astronomy-sky",
    neededWhen: "When an astronomical question depends on locating objects, cross-matching catalogs, inspecting sky context, motion, photometry, or time-varying signals.",
    notWhen: "Do not use a sky view as a decorative image or infer counterpart identity, non-detection, population frequency, or periodicity without coverage and measurement support.",
    liveDecision: "Which objects and measurements correspond across catalogs and whether spatial, kinematic, photometric, or temporal evidence supports the hypothesis.",
    userGoal: "Inspect the real sky and measurements, select defensible targets, and carry exact catalog provenance into analysis.",
    requiredInputs: ["coordinates, object identifier, or search region", "coordinate frame, epoch, radius, and catalog", "measurement or target-selection question"],
    clarifyingQuestions: [
      q("sky-region", "Which target, coordinate frame, epoch, and search radius define the sky region?", "free-text", "Blocking before catalog cross-match or proper-motion interpretation."),
      q("selection-function", "What magnitude, quality, class, or completeness constraints define usable objects?", "free-text", "Blocking before population claims or target ranking."),
    ],
    rendering: {
      mustShow: ["sky image or projection with exact coordinate grid and field of view", "catalog objects, uncertainties, quality flags, and source layer", "cross-match radius and ambiguous matches", "time, epoch, filter, and selection-function metadata"],
      researcherActions: ["pan, zoom, query, select, and cross-match objects", "inspect catalog rows and light curves", "save a target set or send measurements to analysis"],
      aiInspectionSignals: ["ambiguous counterpart", "proper-motion or epoch mismatch", "crowding and edge effects", "periodicity, transient, or outlier candidate"],
      claimBoundaries: ["A nearby projected source is not automatically the same object.", "Survey non-detection is not absence without coverage and sensitivity."],
    },
    nextActions: [
      next("ambiguous-cross-match", "request-target-or-match-policy-decision", "human-decision", null, "Different matches produce different physical interpretations.", true),
      next("time-domain-signal", "open-time-series-and-periodicity-analysis", "lab", "statistics-analysis", "The sky view should hand exact measurements to a reproducible temporal analysis."),
      next("candidate-target-set", "save-versioned-target-catalog-and-observation-rationale", "artifact", null, "Target selection must be inspectable and repeatable."),
      next("sky-result-reviewed", "bind-field-view-target-table-and-catalog-provenance", "manuscript", null, "The published target selection must preserve the sky context and catalog release.", true),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["survey and catalog releases", "coordinate frame, epoch, cross-match, and quality cuts", "field-of-view, scale, orientation, and sensitivity in captions"] },
  },
  "biodiversity-map": {
    labId: "biodiversity-map",
    neededWhen: "When occurrence records must reveal species range, diversity, sampling gaps, environmental association, or change across place and time.",
    notWhen: "Do not interpret occurrence density as abundance, absence, habitat suitability, or population change without taxonomic, effort, detectability, and temporal support.",
    liveDecision: "Whether the observed spatial pattern is biological or caused by sampling effort, taxonomy, coordinate quality, or temporal coverage.",
    userGoal: "Explore where organisms were observed and design a defensible ecological analysis or survey.",
    requiredInputs: ["taxon or assemblage", "geographic and temporal extent", "occurrence source and quality policy"],
    clarifyingQuestions: [
      q("taxon-concept", "Which taxon concept, rank, accepted names, and synonym policy define inclusion?", "free-text", "Blocking when taxonomy changes record membership."),
      q("occurrence-policy", "Which basis of record, coordinate uncertainty, geoprivacy, date, and quality flags are acceptable?", "multi-select", "Blocking before range or abundance interpretation."),
    ],
    rendering: {
      mustShow: ["occurrences with uncertainty and record basis", "geographic, temporal, and taxonomic filters", "sampling effort or density alongside the biological pattern", "coordinate quality, duplicates, licenses, and provider provenance"],
      researcherActions: ["pan, zoom, filter, brush, and inspect occurrences", "compare taxa, periods, or regions", "select records for a versioned analysis dataset"],
      aiInspectionSignals: ["sampling hotspot", "coordinate centroid or institution artifact", "taxonomic mismatch", "range edge, invasion, decline, or survey gap candidate"],
      claimBoundaries: ["Occurrence density is not abundance without an effort model.", "Absence cannot be inferred from no records without sampling coverage."],
    },
    nextActions: [
      next("sampling-bias", "open-effort-aware-analysis-plan", "analysis-plan", null, "The visible pattern must be separated from observer effort."),
      next("suspect-occurrence", "open-source-record-and-quality-flags", "artifact", null, "A map outlier may be a valuable range extension or a coordinate defect."),
      next("survey-gap", "create-prioritized-field-survey-design", "human-decision", null, "The map should lead to a concrete next observation plan.", true),
      next("ecological-pattern-reviewed", "bind-map-occurrence-table-and-effort-boundary", "manuscript", null, "The paper must show both the biological pattern and the sampling support behind it.", true),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["taxonomic resolution and occurrence filters", "map projection, extent, effort, and uncertainty", "provider, license, retrieval date, and reproducible query"] },
  },
  "earthquake-observations": {
    labId: "earthquake-observations",
    neededWhen: "When event catalogs must support analysis of seismicity, aftershock sequence, magnitude-frequency relation, spatial clustering, or observational coverage.",
    notWhen: "Do not fit or compare seismic laws, forecast events, or infer hazard from an event set whose magnitude type, completeness, network history, and selection window are unresolved.",
    liveDecision: "Which events form a complete and comparable catalog and whether the observed pattern supports a tectonic or sequence-level interpretation.",
    userGoal: "Inspect exact events in space, time, depth, and magnitude before fitting or reporting a seismic model.",
    requiredInputs: ["region and time window", "catalog provider and magnitude types", "sequence, hazard, or tectonic question"],
    clarifyingQuestions: [
      q("event-window", "Which spatial region, depth range, time window, and mainshock or tectonic context define the event set?", "free-text", "Blocking before sequence or rate analysis."),
      q("completeness-policy", "Which magnitude type, quality flags, duplicates, and completeness threshold are acceptable?", "free-text", "Blocking before Gutenberg-Richter, Omori-Utsu, or rate comparison."),
    ],
    rendering: {
      mustShow: ["events in map, depth, time, and magnitude views", "catalog source, magnitude types, uncertainties, and quality flags", "selection window, detection completeness, and network changes", "exact events behind fitted relations or anomalies"],
      researcherActions: ["filter, brush, inspect, and select events", "change a reviewed spatial or temporal window", "send an exact sequence to magnitude-frequency or aftershock analysis"],
      aiInspectionSignals: ["catalog incompleteness", "duplicate or magnitude-type discontinuity", "cluster, migration, or rate change", "mainshock-window sensitivity"],
      claimBoundaries: ["Catalog rate changes may reflect detection changes.", "A fitted empirical law does not by itself establish a causal mechanism or forecast."],
    },
    nextActions: [
      next("catalog-incomplete-or-inconsistent", "revise-catalog-and-completeness-plan", "analysis-plan", null, "Seismic fit parameters are invalid on an undefined event population."),
      next("aftershock-or-magnitude-frequency-question", "open-prespecified-seismic-model-analysis", "lab", "statistics-analysis", "The exact selected events should flow into the fitted model."),
      next("material-event-or-anomaly", "open-official-event-detail-and-record-review", "artifact", null, "Interpretation requires source-level event metadata."),
      next("seismic-result-reviewed", "bind-event-map-sequence-table-and-catalog-contract", "manuscript", null, "The event population and completeness assumptions must remain visible with the result.", true),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["catalog, query, time and geographic bounds", "magnitude type and completeness method", "event selection, uncertainty, and fit diagnostics"] },
  },
  "physics-data": {
    labId: "physics-data",
    neededWhen: "When published or experimental measurements, bins, uncertainties, covariance, and theory predictions must be compared or reanalyzed.",
    notWhen: "Do not calculate or interpret compatibility when observable definitions, units, cuts, binning, normalization, or material covariance are missing or mismatched.",
    liveDecision: "Whether the measurement and model are compatible under the exact observable definition, units, binning, uncertainty, and correlation structure.",
    userGoal: "Reproduce a physics comparison from the actual numeric data rather than reading values from a plot or abstract.",
    requiredInputs: ["versioned measurement table", "observable definition, units, and phase-space cuts", "model or comparison hypothesis"],
    clarifyingQuestions: [
      q("observable", "What exact observable, frame, units, cuts, bin edges, and normalization should be compared?", "free-text", "Blocking when a named quantity has multiple experiment-specific definitions."),
      q("uncertainty-model", "Which statistical, systematic, asymmetric, and correlated uncertainties are available and required?", "multi-select", "Blocking before compatibility statistics or parameter fitting."),
    ],
    rendering: {
      mustShow: ["central values, units, bin edges, and exact table provenance", "statistical and systematic uncertainty with covariance status", "data-model residual, ratio, or pull view", "selection cuts, normalization, and unsupported-bin warnings"],
      researcherActions: ["inspect bins and uncertainty components", "toggle approved model or nuisance variants", "select bins and export an exact comparison dataset"],
      aiInspectionSignals: ["unit or normalization mismatch", "correlated residual structure", "dominant nuisance uncertainty", "local tension versus look-elsewhere boundary"],
      claimBoundaries: ["Independent-error chi-square is invalid when material covariance is omitted.", "A local discrepancy is not automatically discovery evidence."],
    },
    nextActions: [
      next("definition-or-covariance-missing", "stop-and-request-measurement-contract", "human-decision", null, "The compatibility result is undefined without the observable and uncertainty model.", true),
      next("tension-or-model-mismatch", "create-model-and-systematics-sensitivity-analysis", "analysis-plan", null, "The next test must distinguish physics from representation or nuisance effects."),
      next("comparison-reviewed", "bind-table-comparison-figure-and-reproduction-receipt", "manuscript", null, "The result must remain reproducible from the published numeric source."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["observable, units, cuts, and binning", "uncertainty and covariance treatment", "data source, model version, parameters, and reproduction code or receipt"] },
  },
  "materials-structures": {
    labId: "materials-structures",
    neededWhen: "When crystal structures and computed or measured properties must be inspected, compared, screened, or related to composition and stability.",
    notWhen: "Do not use a database structure or computed property alone to claim phase identity, experimental stability, synthesizability, manufacturability, or device performance.",
    liveDecision: "Which structure, phase, composition, and calculation conditions support the property claim or candidate selection.",
    userGoal: "Move from a materials database hit to an inspectable structure-property hypothesis and a justified next calculation or experiment.",
    requiredInputs: ["composition, structure, or property query", "database and structure version", "target property and operating constraints"],
    clarifyingQuestions: [
      q("materials-target", "Which composition space, phase, property, units, and operating conditions define a useful candidate?", "free-text", "Blocking before candidate ranking."),
      q("structure-equivalence", "How should polymorphs, disorder, defects, conventional cells, and duplicate calculations be treated?", "multi-select", "Blocking before structure comparison or aggregation."),
    ],
    rendering: {
      mustShow: ["interactive crystal structure, lattice, symmetry, and composition", "property values with method, conditions, units, and provenance", "stability or formation-energy context", "comparison table and structure-level uncertainty or quality boundary"],
      researcherActions: ["rotate, select, measure, tile, and inspect sites", "compare phases and property records", "save a candidate set or send exact structures to a calculation plan"],
      aiInspectionSignals: ["phase or structure mismatch", "unstable or metastable candidate", "property-method inconsistency", "outlier motif or composition trend"],
      claimBoundaries: ["A computed property is conditional on method and structure.", "Database stability and practical synthesizability are not equivalent."],
    },
    nextActions: [
      next("phase-or-provenance-conflict", "open-exact-structure-and-calculation-record", "artifact", null, "The property claim must bind to the correct phase and method."),
      next("promising-candidate", "propose-validation-calculation-or-synthesis-plan", "analysis-plan", null, "Screening should end in a falsifiable next experiment.", true),
      next("structure-property-result-reviewed", "bind-structure-view-table-and-method-receipt", "manuscript", null, "The reported value must travel with its structure and calculation context."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["structure identifiers, symmetry, composition, and phase", "calculation or measurement method and conditions", "stability, uncertainty, and provenance"] },
  },
  "genomics-variants": {
    labId: "genomics-variants",
    neededWhen: "When genes, intervals, variants, reads, annotations, and cohorts must be inspected in genomic coordinates and a fixed reference assembly.",
    notWhen: "Do not prioritize or interpret variants while reference assembly, transcript set, allele normalization, sample identity, and technical quality remain ambiguous.",
    liveDecision: "Whether a variant or genomic region is technically credible, biologically relevant, and supported in the intended reference, samples, and annotation versions.",
    userGoal: "See the locus and its evidence, avoid coordinate or annotation mistakes, and select variants for a defensible downstream analysis.",
    requiredInputs: ["reference assembly and contig naming", "gene, interval, or variant set", "sample or cohort and annotation sources"],
    clarifyingQuestions: [
      q("reference-build", "Which reference assembly, transcript set, and coordinate convention are authoritative?", "single-select", "Always blocking before variant placement or annotation."),
      q("variant-scope", "Which samples, inheritance model, quality filters, allele frequency, and consequence classes define relevance?", "multi-select", "Blocking before variant prioritization or association claims."),
    ],
    rendering: {
      mustShow: ["coordinate ruler, reference build, gene and transcript models", "variant, read or signal tracks with sample and quality metadata", "alleles, strand, normalization, and annotation versions", "filter and cohort support behind every selected variant"],
      researcherActions: ["pan, zoom, select, and inspect a locus", "toggle and reorder tracks", "compare samples or annotations", "save a versioned variant set for analysis"],
      aiInspectionSignals: ["build or transcript mismatch", "strand or allele normalization error", "low depth or mapping quality", "population-frequency or batch conflict"],
      claimBoundaries: ["Annotation consequence is not functional proof.", "A displayed variant is not causal without study and evidence support."],
    },
    nextActions: [
      next("coordinate-or-quality-conflict", "stop-and-resolve-reference-or-source-evidence", "human-decision", null, "Downstream analysis must not proceed on an ambiguous locus.", true),
      next("candidate-variant-set", "open-cohort-or-functional-analysis-plan", "analysis-plan", null, "Prioritization should lead to a declared statistical or experimental test."),
      next("locus-reviewed", "bind-track-capture-variant-table-and-provenance", "manuscript", null, "The figure and variant list must share the same reference and filters."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["assembly, transcripts, coordinates, alleles, and normalization", "sample, cohort, and quality filters", "annotation databases, versions, and evidence limitations"] },
  },
  "molecular-structure": {
    labId: "molecular-structure",
    neededWhen: "When protein or macromolecular sequence, fold, confidence, residue environment, domain, interface, ligand, or variant must be inspected in three dimensions.",
    notWhen: "Do not infer binding, function, mechanism, or variant pathogenicity from structural appearance alone or from an incompatible, unresolved, or low-confidence model.",
    liveDecision: "Which structural features are supported by experiment or prediction and whether they justify a mechanistic, mutational, or binding hypothesis.",
    userGoal: "Interrogate a real structure, trace claims to residues and confidence, and design the next structural or biochemical test.",
    requiredInputs: ["structure identifier or versioned coordinate file", "chain, residue, domain, ligand, or variant question", "experimental method or prediction provenance"],
    clarifyingQuestions: [
      q("structure-source", "Which experimental model, biological assembly, prediction, chain, state, and organism should be authoritative?", "free-text", "Blocking when multiple structures represent different conformations or constructs."),
      q("structural-question", "Is the decision about fold, confidence, residue environment, interface, ligand binding, variant effect, or comparison?", "single-select", "Blocking before representation, selection, and measurement choices."),
    ],
    rendering: {
      mustShow: ["interactive structure with sequence and residue identity", "experimental resolution or prediction confidence by region", "chains, domains, ligands, contacts, and selected measurements", "missing residues, alternate states, construct differences, and source version"],
      researcherActions: ["rotate, zoom, select, isolate, measure, and recolor", "compare structures or variants", "save an exact view and residue selection as an artifact version"],
      aiInspectionSignals: ["low-confidence or unresolved region", "steric clash or interaction change", "domain or chain-interface difference", "structure-sequence or residue-numbering mismatch"],
      claimBoundaries: ["A predicted pose or low-confidence region is not experimental evidence.", "Structural proximity alone does not establish biochemical interaction or function."],
    },
    nextActions: [
      next("structure-or-numbering-ambiguous", "request-authoritative-structure-decision", "human-decision", null, "The residue-level claim depends on the selected model and numbering.", true),
      next("mechanistic-or-variant-candidate", "propose-biochemical-mutational-or-simulation-test", "analysis-plan", null, "A structural observation should yield a falsifiable experiment."),
      next("view-reviewed", "bind-exact-structure-view-selection-and-confidence", "manuscript", null, "The figure must retain orientation, selection, model, and confidence provenance."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["structure IDs, chains, residues, constructs, and versions", "method, resolution or confidence, and missing regions", "representation and selection needed to reproduce the view"] },
  },
  chemistry: {
    labId: "chemistry",
    neededWhen: "When a molecule, series, transformation, assay relationship, or design hypothesis must be drawn, edited, compared, validated, or prepared for computation and reporting.",
    notWhen: "Do not treat a valid drawing, similarity, docking score, or predicted property as proof of synthesis feasibility, potency, selectivity, safety, or efficacy.",
    liveDecision: "Whether the exact chemical identity and proposed structural change are valid, relevant to the target objective, and supported enough to justify the next assay or calculation.",
    userGoal: "Co-design molecules with the AI while retaining chemical identity, edit history, property evidence, and a clear experimental next step.",
    requiredInputs: ["versioned chemical structure or query", "target, assay, reaction, or design objective", "constraints such as stereochemistry, charge, property, novelty, or synthesis"],
    clarifyingQuestions: [
      q("chemical-identity", "Which stereoisomer, protonation, tautomer, salt, isotope, and mixture policy defines the molecule?", "multi-select", "Blocking before deduplication, property calculation, docking, or manuscript naming."),
      q("design-objective", "Which target, endpoint, property, liability, or reaction outcome should the structural change improve?", "free-text", "Blocking before proposing or ranking analogs."),
      q("decision-constraints", "Which potency, selectivity, ADME, toxicity, novelty, synthesis, or cost constraints are hard gates?", "multi-select", "Blocking before autonomous optimization or candidate recommendation."),
    ],
    rendering: {
      mustShow: ["editable 2D structure with atom, bond, charge, stereo, and mapping identity", "canonical identifiers and exact structure version", "measured versus predicted properties and assays with units and conditions", "structural diff, uncertainty, alerts, provenance, and synthesis boundary"],
      researcherActions: ["draw, select, edit, annotate, compare, and undo", "open linked 3D structure or assay rows", "save a new immutable molecule version", "approve candidates for calculation, simulation, or experiment"],
      aiInspectionSignals: ["valence or stereochemistry defect", "identity, tautomer, or salt ambiguity", "property tradeoff and out-of-domain prediction", "assay-condition or scaffold-confound mismatch"],
      claimBoundaries: ["A rendered molecule is not a validated compound or feasible synthesis.", "Predicted potency, docking score, or similarity is not experimental efficacy."],
    },
    nextActions: [
      next("identity-or-structure-invalid", "open-exact-atom-level-edit-and-validation", "artifact", null, "No calculation or claim should proceed from an ambiguous chemical identity."),
      next("promising-structural-change", "create-computation-assay-or-synthesis-validation-plan", "analysis-plan", null, "The optimization loop must produce a falsifiable next experiment.", true),
      next("candidate-reviewed", "bind-structure-property-assay-and-version-history", "manuscript", null, "The reported compound must retain exact identity and evidence provenance."),
    ],
    manuscript: { roles: ["figure", "table", "supplement"], requirements: ["unambiguous structures and identifiers", "assay, property, conditions, units, and uncertainty", "compound provenance, synthesis or procurement, and structure-version history"] },
  },
});

export const SCIENCE_RESEARCH_INTENT_LAB_IDS = Object.freeze(Object.keys(INTENTS));

export function scienceResearchIntentCatalog(labIds?: readonly string[]): ScienceResearchIntentCatalog {
  const selected = labIds === undefined ? SCIENCE_RESEARCH_INTENT_LAB_IDS : [...labIds];
  if (selected.length > SCIENCE_RESEARCH_INTENT_LAB_IDS.length || new Set(selected).size !== selected.length) {
    throw new Error("science-research-intent-lab-invalid");
  }
  const intents = selected.map((labId) => {
    const intent = INTENTS[labId];
    if (!intent) throw new Error("science-research-intent-lab-invalid");
    return structuredClone(intent);
  });
  return { schema: SCIENCE_RESEARCH_INTENT_SCHEMA, version: 1, intents };
}
