"use strict";

const DECISION_LINKAGE_SCHEMA = "agentlas.science.statistics.research-decision-linkage/v1";

const METHOD_DECISION_LINKAGE = Object.freeze({
  descriptive: {
    neededWhen: "Before formal modeling, when the researcher must establish what was observed, what is missing, and whether scale or distribution defects change the analysis plan.",
    decision: "Whether the dataset is analysis-ready and which summaries or transformations are defensible.",
    mustShow: "Exact sample counts, missingness, robust and conventional location and spread, range, quantiles, and the observed distribution without hiding rows.",
    userGoal: "Understand the cohort or experiment, catch data problems, and justify the next inferential method.",
    nextActions: [
      { trigger: "missing-or-impossible-values", action: "open-source-rows-and-create-data-repair-plan", reason: "Inference should not begin until the defect and exclusion policy are explicit." },
      { trigger: "skew-or-outliers", action: "compare-prespecified-robust-or-transformed-analysis", reason: "The visible distribution may invalidate a mean-and-normality-only path." },
      { trigger: "analysis-ready", action: "freeze-primary-analysis-spec", reason: "A reviewed descriptive baseline should precede confirmatory execution." },
    ],
  },
  distribution_fit: {
    neededWhen: "When a simulation, parametric test, reliability model, or probability calculation depends on a named distributional family.",
    decision: "Which supported family is an adequate working model, or whether all supported families should be rejected for the intended use.",
    mustShow: "Observed distribution, fitted density or probability plot, parameter estimates, fit statistics, tail behavior, and the bounded status of any goodness-of-fit screen.",
    userGoal: "Choose a defensible probability model without mistaking a visual fit or descriptive screen for proof.",
    nextActions: [
      { trigger: "tail-or-shape-mismatch", action: "open-source-distribution-and-revise-family-plan", reason: "Tail mismatch can dominate simulation and risk estimates." },
      { trigger: "multiple-plausible-families", action: "run-prespecified-sensitivity-across-families", reason: "Model uncertainty should be propagated rather than hidden." },
      { trigger: "supported-working-fit", action: "bind-fit-receipt-to-downstream-analysis", reason: "The downstream calculation must retain the fitted-family provenance." },
    ],
  },
  pearson_correlation: {
    neededWhen: "When the live question is the strength and direction of an approximately linear association between two continuous measurements.",
    decision: "Whether the prespecified linear association is supported and large enough to matter scientifically.",
    mustShow: "Exact paired sample size, scatterplot, coefficient, confidence interval, p value, influential points, and a clear warning that association is not causation.",
    userGoal: "Quantify a linear relationship and decide whether to model, validate, or report it.",
    nextActions: [
      { trigger: "nonlinear-pattern-or-influential-point", action: "inspect-source-pairs-and-compare-rank-or-model-based-analysis", reason: "A single linear coefficient can conceal shape and influence." },
      { trigger: "scientifically-material-association", action: "create-prespecified-regression-or-validation-plan", reason: "Correlation alone does not adjust confounding or establish prediction." },
      { trigger: "reportable-null-or-estimate", action: "bind-scatter-and-interval-to-manuscript", reason: "The estimate and uncertainty matter whether or not a threshold is crossed." },
    ],
  },
  spearman_correlation: {
    neededWhen: "When the question concerns a monotonic association and ranks are more defensible than raw-scale linearity.",
    decision: "Whether higher values of one measure systematically accompany higher or lower values of the other.",
    mustShow: "Exact paired rows, rank association and interval, raw-value scatter, ties, monotonic shape, and influential observations.",
    userGoal: "Measure an ordered relationship robustly without claiming a linear effect or causal mechanism.",
    nextActions: [
      { trigger: "nonmonotonic-shape", action: "open-scatter-and-specify-nonlinear-model", reason: "A rank coefficient can be near zero despite a strong nonmonotonic relation." },
      { trigger: "heavy-ties-or-small-sample", action: "review-exact-inference-boundary", reason: "Ties and limited support change interpretation and calibration." },
      { trigger: "stable-monotonic-association", action: "bind-rank-result-or-plan-adjusted-model", reason: "Reporting or adjustment should follow the actual research objective." },
    ],
  },
  kendall_correlation: {
    neededWhen: "When concordance of ordered pairs is the target, especially with small samples or an interpretation framed as pairwise ordering.",
    decision: "Whether the observed ordering is predominantly concordant, discordant, or indeterminate.",
    mustShow: "Kendall coefficient, uncertainty, concordant and discordant support, ties, exact paired rows, and the raw relationship.",
    userGoal: "Describe ordinal concordance in a way that maps directly to pairwise ordering.",
    nextActions: [
      { trigger: "tie-dominated-data", action: "review-measurement-resolution-and-tie-policy", reason: "Ties may reflect the instrument rather than the scientific relationship." },
      { trigger: "unexpected-concordance-pattern", action: "inspect-source-pairs-and-subgroups", reason: "Subgroups can reverse or concentrate ordinal association." },
      { trigger: "reportable-concordance", action: "bind-concordance-result-to-manuscript", reason: "The pairwise interpretation should accompany the coefficient." },
    ],
  },
  independent_t_test: {
    neededWhen: "When two independent prespecified groups are compared on a continuous outcome and equal variance is scientifically defensible.",
    decision: "Whether the mean difference and its uncertainty support a scientifically meaningful group contrast.",
    mustShow: "Group sizes and distributions, mean difference with interval, standardized effect, variance evidence, outliers, and the exact group coding.",
    userGoal: "Estimate and report a two-group mean contrast, not merely obtain a p value.",
    nextActions: [
      { trigger: "variance-assumption-not-defensible", action: "run-welch-contrast-under-prespecified-sensitivity", reason: "Pooled variance should not be retained by convenience." },
      { trigger: "outlier-or-shape-defect", action: "inspect-source-rows-and-compare-robust-analysis", reason: "The mean contrast may be driven by unsupported observations or scale." },
      { trigger: "interpretable-contrast", action: "bind-estimate-interval-and-effect-size", reason: "The manuscript needs magnitude, uncertainty, and coding." },
    ],
  },
  welch_t_test: {
    neededWhen: "When two independent groups are compared on a continuous outcome without assuming equal variances.",
    decision: "Whether the prespecified mean contrast is supported under unequal-variance inference.",
    mustShow: "Group distributions and sizes, mean difference and interval, Welch degrees of freedom, effect size, and source-level outliers.",
    userGoal: "Obtain a defensible two-group mean comparison when spread or sample size differs.",
    nextActions: [
      { trigger: "severe-shape-or-outlier-defect", action: "inspect-source-rows-and-compare-rank-or-robust-analysis", reason: "Welch addresses variance inequality, not every distribution defect." },
      { trigger: "covariate-adjustment-needed", action: "create-regression-analysis-spec", reason: "A marginal two-group contrast cannot answer an adjusted question." },
      { trigger: "interpretable-contrast", action: "bind-estimate-interval-and-effect-size", reason: "Magnitude and uncertainty should drive reporting." },
    ],
  },
  paired_t_test: {
    neededWhen: "When the same unit or a matched pair contributes two linked continuous measurements and the mean within-pair change is the estimand.",
    decision: "Whether the average paired change is supported and scientifically meaningful.",
    mustShow: "Complete pair count, pair linkage, change distribution, paired trajectories, mean change and interval, and influential pairs.",
    userGoal: "Separate within-unit change from between-unit variation and report the paired estimand with its actual support.",
    nextActions: [
      { trigger: "broken-or-ambiguous-pairing", action: "open-pair-identifiers-and-repair-linkage", reason: "An incorrect pairing invalidates the estimand." },
      { trigger: "non-normal-or-outlier-differences", action: "compare-wilcoxon-signed-rank-sensitivity", reason: "The assumption concerns differences, not the two raw marginals." },
      { trigger: "reportable-change", action: "bind-paired-trajectory-and-change-interval", reason: "Both individual change and population uncertainty are needed." },
    ],
  },
  one_way_anova: {
    neededWhen: "When a continuous outcome is compared across three or more independent groups under a common-variance model.",
    decision: "Whether any prespecified group mean differs before examining multiplicity-controlled contrasts.",
    mustShow: "Group distributions and sizes, omnibus effect and interval or effect size, variance diagnostics, and clearly separated planned versus post-hoc contrasts.",
    userGoal: "Establish an overall group effect and then identify defensible contrasts.",
    nextActions: [
      { trigger: "unequal-variance-evidence", action: "run-welch-one-way-sensitivity", reason: "The common-variance omnibus result may be unreliable." },
      { trigger: "omnibus-supported", action: "create-multiplicity-controlled-contrast-plan", reason: "Uncontrolled pairwise testing inflates false positives." },
      { trigger: "omnibus-not-supported", action: "bind-estimate-and-stop-unplanned-pairwise-search", reason: "A null omnibus test is not permission for selective comparisons." },
    ],
  },
  welch_one_way_anova: {
    neededWhen: "When three or more independent group means are compared and equal variance is not defensible.",
    decision: "Whether any group mean differs under unequal-variance inference.",
    mustShow: "Group distributions and sizes, Welch omnibus statistic and degrees of freedom, effect magnitude, and the planned contrast boundary.",
    userGoal: "Test a multi-group mean question without pooling incompatible variances.",
    nextActions: [
      { trigger: "omnibus-supported", action: "create-unequal-variance-multiplicity-controlled-contrast-plan", reason: "Follow-up contrasts must preserve the variance and multiplicity model." },
      { trigger: "shape-or-outlier-defect", action: "inspect-source-rows-and-compare-rank-analysis", reason: "Welch does not cure severe distribution defects." },
      { trigger: "reportable-omnibus", action: "bind-group-distribution-and-omnibus-table", reason: "Readers need both the data pattern and formal result." },
    ],
  },
  two_way_anova: {
    neededWhen: "When two categorical factors and their prespecified interaction define the continuous-outcome question.",
    decision: "Whether each main effect and, critically, the interaction changes the interpretation of the other factor.",
    mustShow: "Cell sizes and distributions, interaction plot, model terms with uncertainty, coding, imbalance, and a hierarchy-respecting interpretation.",
    userGoal: "Determine whether an effect differs across the levels of another experimental or observational factor.",
    nextActions: [
      { trigger: "interaction-supported", action: "estimate-prespecified-simple-effects-with-multiplicity-control", reason: "Main effects alone are misleading when interaction is present." },
      { trigger: "empty-or-sparse-cells", action: "open-cell-support-and-revise-estimand", reason: "Unsupported combinations cannot be rescued by a chart." },
      { trigger: "model-defensible", action: "bind-interaction-figure-and-term-table", reason: "The Figure and exact coding must travel together." },
    ],
  },
  mann_whitney_u: {
    neededWhen: "When two independent groups are compared by stochastic ordering or rank location rather than a mean under normality.",
    decision: "Whether observations from one group tend to rank above or below the other under the stated distribution-shape interpretation.",
    mustShow: "Group distributions, ranks and ties, U statistic, uncertainty or effect size, exact group coding, and the limit on median-language claims.",
    userGoal: "Compare independent groups robustly while stating what the rank estimand actually means.",
    nextActions: [
      { trigger: "different-distribution-shapes", action: "revise-stochastic-order-interpretation", reason: "The result is not automatically a pure median difference." },
      { trigger: "covariate-adjustment-needed", action: "create-appropriate-regression-analysis-spec", reason: "A rank test cannot adjust the research question." },
      { trigger: "reportable-rank-contrast", action: "bind-distribution-and-rank-effect", reason: "The visual distribution prevents overclaiming the statistic." },
    ],
  },
  wilcoxon_signed_rank: {
    neededWhen: "When linked pairs are compared through the signed ranks of nonzero differences.",
    decision: "Whether the paired difference distribution is centered away from zero under the symmetry boundary.",
    mustShow: "Pair linkage, signed differences, zero and tie handling, rank statistic, effect direction, and paired trajectories.",
    userGoal: "Assess within-pair change without relying on a Gaussian mean-difference model.",
    nextActions: [
      { trigger: "asymmetric-differences", action: "review-signed-rank-estimand-and-sensitivity", reason: "Symmetry is part of the usual location interpretation." },
      { trigger: "pairing-defect", action: "open-pair-identifiers-and-repair-linkage", reason: "The test is only meaningful for correct pairs." },
      { trigger: "reportable-change", action: "bind-paired-distribution-and-rank-result", reason: "Readers need the actual within-pair pattern." },
    ],
  },
  kruskal_wallis: {
    neededWhen: "When three or more independent groups are compared using ranks rather than a common-variance Gaussian mean model.",
    decision: "Whether at least one group differs in rank distribution under the stated shape interpretation.",
    mustShow: "Group distributions and sizes, ranks and ties, omnibus statistic, effect magnitude, and the boundary for follow-up comparisons.",
    userGoal: "Detect a multi-group distributional or ordered-location difference robustly.",
    nextActions: [
      { trigger: "omnibus-supported", action: "create-multiplicity-controlled-rank-contrast-plan", reason: "The omnibus result does not identify which groups differ." },
      { trigger: "shape-differences-dominate", action: "revise-location-language-and-inspect-distributions", reason: "A rank result need not be a median-only effect." },
      { trigger: "reportable-omnibus", action: "bind-group-distributions-and-rank-table", reason: "The distribution is part of the interpretation." },
    ],
  },
  friedman_test: {
    neededWhen: "When the same blocks or subjects are measured under three or more conditions and the condition ranks are the target.",
    decision: "Whether condition ordering differs after controlling each block by within-block ranks.",
    mustShow: "Complete block-condition support, within-block trajectories or ranks, tie handling, omnibus statistic, and post-hoc boundary.",
    userGoal: "Compare repeated conditions without treating linked observations as independent.",
    nextActions: [
      { trigger: "missing-or-incomplete-block", action: "open-block-support-and-revise-model", reason: "The bounded Friedman path requires the declared repeated-measure structure." },
      { trigger: "omnibus-supported", action: "create-multiplicity-controlled-paired-contrast-plan", reason: "Follow-up tests must preserve pairing and the declared block structure." },
      { trigger: "reportable-condition-effect", action: "bind-block-trajectories-and-omnibus-result", reason: "Within-block variation is scientifically informative." },
    ],
  },
  linear_regression: {
    neededWhen: "When a continuous outcome is modeled as a prespecified linear function of one or more predictors.",
    decision: "Which adjusted associations are supported, with what magnitude, and whether predictions are defensible in the observed support.",
    mustShow: "Exact formula and coding, coefficients and intervals, fit and residual diagnostics, leverage or influence, observed predictor support, and no extrapolation disguised as evidence.",
    userGoal: "Estimate adjusted effects, explain outcome variation, or make bounded predictions.",
    nextActions: [
      { trigger: "residual-nonlinearity-or-heteroscedasticity", action: "create-prespecified-transformation-or-model-sensitivity", reason: "Coefficient interpretation depends on model form and error behavior." },
      { trigger: "influential-row", action: "open-exact-source-row-without-automatic-exclusion", reason: "Influence requires provenance review, not silent deletion." },
      { trigger: "model-defensible", action: "bind-coefficient-and-diagnostic-artifacts", reason: "A coefficient table without diagnostics is incomplete evidence." },
    ],
  },
  logistic_regression: {
    neededWhen: "When a binary outcome probability or odds is related to prespecified predictors.",
    decision: "Which adjusted odds associations are supported and whether predicted probabilities are usable over the observed support.",
    mustShow: "Outcome prevalence, formula and coding, coefficients and odds ratios with intervals, fitted probabilities, calibration or residual evidence, separation warnings, and support.",
    userGoal: "Estimate adjusted binary-outcome associations or generate bounded risk estimates.",
    nextActions: [
      { trigger: "separation-or-sparse-events", action: "stop-and-create-supported-penalized-or-exact-method-plan", reason: "Unstable maximum-likelihood estimates should fail closed." },
      { trigger: "prediction-intent", action: "create-validation-and-calibration-plan", reason: "Association fit is not sufficient evidence for predictive use." },
      { trigger: "model-defensible", action: "bind-odds-ratio-and-probability-diagnostics", reason: "Effect and practical probability interpretation should stay linked." },
    ],
  },
  poisson_regression: {
    neededWhen: "When a nonnegative count outcome is modeled against prespecified predictors within the bounded Poisson mean-variance assumption.",
    decision: "Which adjusted rate associations are supported and whether the Poisson variance structure is defensible.",
    mustShow: "Count distribution and zeros, formula and coding, rate ratios and intervals, fitted counts, residual or dispersion evidence, and exact exposure boundary.",
    userGoal: "Estimate count or rate associations without treating counts as unconstrained continuous data.",
    nextActions: [
      { trigger: "overdispersion-or-zero-inflation", action: "stop-and-create-supported-count-model-extension-plan", reason: "The bounded engine does not silently substitute a different count family." },
      { trigger: "exposure-offset-needed", action: "revise-analysis-spec-before-interpretation", reason: "Counts and rates answer different questions." },
      { trigger: "model-defensible", action: "bind-rate-ratio-and-count-diagnostics", reason: "The mean model and variance evidence must be reported together." },
    ],
  },
  chi_square_test: {
    neededWhen: "When association between two categorical variables is assessed from a contingency table with adequate expected counts.",
    decision: "Whether the observed category pattern departs from independence and which cells contribute.",
    mustShow: "Observed and expected counts, row and column totals, cell residuals, effect size, degrees of freedom, and sparse-cell warnings.",
    userGoal: "Understand where a categorical association occurs, not just whether an omnibus threshold is crossed.",
    nextActions: [
      { trigger: "small-expected-counts", action: "use-supported-exact-test-or-revise-category-plan", reason: "Asymptotic calibration is not defensible in sparse support." },
      { trigger: "omnibus-supported", action: "inspect-standardized-cell-residuals-with-multiplicity-boundary", reason: "The omnibus test does not localize association by itself." },
      { trigger: "reportable-association", action: "bind-mosaic-or-residual-view-and-contingency-table", reason: "Counts and effect size make the association interpretable." },
    ],
  },
  fisher_exact_test: {
    neededWhen: "When a bounded exact association test is required for a small 2-by-2 contingency table.",
    decision: "Whether the observed 2-by-2 association is compatible with independence under the exact conditional model.",
    mustShow: "The exact 2-by-2 counts and margins, odds ratio boundary, exact p value, effect direction, and confidence-interval availability limits.",
    userGoal: "Make a sparse-table association decision without relying on large-sample chi-square calibration.",
    nextActions: [
      { trigger: "zero-cell-or-unstable-effect", action: "report-exact-counts-and-review-estimation-method", reason: "A finite p value does not guarantee a stable odds-ratio estimate." },
      { trigger: "multiple-tables-tested", action: "create-multiplicity-correction-plan", reason: "Exact calibration does not remove multiple-testing risk." },
      { trigger: "reportable-association", action: "bind-exact-table-and-effect-boundary", reason: "The raw counts and fixed margins are essential interpretation context." },
    ],
  },
  multiple_testing_correction: {
    neededWhen: "When a declared family of hypotheses creates a false-positive burden that must be controlled.",
    decision: "Which conclusions remain supported under the prespecified family and error-control method.",
    mustShow: "The complete hypothesis family, raw and adjusted p values, ordering, chosen control method and level, and any omitted or added tests.",
    userGoal: "Control false discoveries or family-wise error without selectively defining the family after seeing results.",
    nextActions: [
      { trigger: "family-definition-unclear", action: "pause-and-freeze-hypothesis-family", reason: "Correction is meaningless without a declared family." },
      { trigger: "conclusions-change-after-adjustment", action: "update-claims-and-mark-exploratory-findings", reason: "The manuscript must follow adjusted, not preferred raw, evidence." },
      { trigger: "family-reviewed", action: "bind-adjusted-decision-table-to-manuscript", reason: "Readers need every member of the family and its disposition." },
    ],
  },
  confidence_interval: {
    neededWhen: "When the research question is about the plausible magnitude and precision of a population quantity rather than a threshold-only test.",
    decision: "Whether the interval includes scientifically meaningful benefit, harm, equivalence, or unacceptable uncertainty.",
    mustShow: "Estimate, interval level and method, sample support, units, scientific decision thresholds, and assumptions.",
    userGoal: "Judge magnitude and precision for reporting, planning, or decision-making.",
    nextActions: [
      { trigger: "interval-too-wide", action: "run-precision-or-sample-size-planning", reason: "A nonsignificant but imprecise result is not evidence of no effect." },
      { trigger: "crosses-scientific-threshold", action: "record-indeterminate-decision-and-plan-more-evidence", reason: "Scientific thresholds should dominate binary p-value language." },
      { trigger: "decision-relevant-precision", action: "bind-estimate-interval-and-threshold", reason: "The interval and decision rule belong together." },
    ],
  },
  kaplan_meier: {
    neededWhen: "When time-to-event experience with right censoring must be described without imposing a covariate model.",
    decision: "What event-free probability and uncertainty are observed over supported follow-up times.",
    mustShow: "Risk set and event counts over time, censoring, survival curve and interval, median only when estimable, and the shrinking support in the tail.",
    userGoal: "Describe when events occur and how much follow-up supports each part of the curve.",
    nextActions: [
      { trigger: "tail-risk-set-small", action: "limit-interpretation-to-supported-follow-up", reason: "A visually extended tail can be statistically fragile." },
      { trigger: "group-comparison-intent", action: "create-log-rank-or-prespecified-survival-model-plan", reason: "A descriptive curve alone does not provide an adjusted contrast." },
      { trigger: "reportable-survival-summary", action: "bind-curve-risk-table-and-censoring-receipt", reason: "The curve without the risk set is incomplete." },
    ],
  },
  log_rank_test: {
    neededWhen: "When prespecified groups are compared across the full right-censored survival experience under a proportional-type weighting interpretation.",
    decision: "Whether the event-time distributions differ across groups under the log-rank contrast.",
    mustShow: "Group survival curves, risk and event counts, censoring, observed-minus-expected contributions, test statistic, and crossing-curve warning.",
    userGoal: "Test an overall unadjusted survival difference while seeing when and where support exists.",
    nextActions: [
      { trigger: "crossing-or-nonproportional-curves", action: "revise-estimand-or-create-time-varying-survival-plan", reason: "A single log-rank result may obscure time-dependent effects." },
      { trigger: "covariate-adjustment-needed", action: "create-cox-analysis-spec-and-ph-check", reason: "The log-rank test is unadjusted and cannot answer a covariate-adjusted question." },
      { trigger: "reportable-group-contrast", action: "bind-curves-risk-table-and-test", reason: "The visual support and omnibus statistic should remain connected." },
    ],
  },
  cox_proportional_hazards: {
    neededWhen: "When a right-censored time-to-event outcome is related to prespecified covariates under a proportional-hazards model.",
    decision: "Which adjusted hazard associations are supported and whether the proportional-hazards structure is defensible.",
    mustShow: "Formula and coding, event and censoring support, hazard ratios and uncertainty boundary, baseline support, diagnostics, and explicit unsupported inference outputs.",
    userGoal: "Estimate adjusted time-to-event associations without confusing hazard with risk or probability.",
    nextActions: [
      { trigger: "proportional-hazards-concern", action: "create-time-interaction-or-stratified-model-plan", reason: "A constant hazard ratio is not defensible when effects vary over time." },
      { trigger: "sparse-events-or-overfit", action: "revise-covariate-plan-before-claiming-effects", reason: "Events, not total rows, support the fitted coefficients." },
      { trigger: "bounded-fit-defensible", action: "bind-hazard-ratio-with-survival-context-and-limitations", reason: "The current engine withholds unsupported inference claims." },
    ],
  },
  principal_component_analysis: {
    neededWhen: "When many correlated numeric variables must be summarized into orthogonal variation directions for exploration or preprocessing.",
    decision: "How many components are interpretable and whether the loading structure supports the intended dimensional reduction.",
    mustShow: "Scaling choice, explained variance and scree, loadings, exact scores, outliers, variable support, and the sign-indeterminacy boundary.",
    userGoal: "Discover multivariate structure, reduce dimensions, or define downstream features without treating components as causal factors.",
    nextActions: [
      { trigger: "single-variable-dominance-or-scale-defect", action: "review-scaling-and-measurement-plan", reason: "PCA structure can be an artifact of units." },
      { trigger: "candidate-cluster-or-gradient", action: "open-score-rows-and-validate-with-external-metadata", reason: "Exploratory separation requires independent interpretation." },
      { trigger: "retained-components-approved", action: "freeze-component-transform-for-downstream-analysis", reason: "The same loadings and scaling must be reused without leakage." },
    ],
  },
  time_series_diagnostics: {
    neededWhen: "When ordered observations may contain trend, seasonality, lag dependence, or shocks that invalidate independent-row analysis.",
    decision: "Which temporal structures require modeling before estimation, forecasting, or intervention analysis.",
    mustShow: "Ordered series with timestamps, missing intervals, trend, lag plots or autocorrelation, seasonal support, anomalies, and the boundary that no ARIMA or stationarity test is silently run.",
    userGoal: "Understand temporal dependence and choose the next valid time-series model or data repair.",
    nextActions: [
      { trigger: "irregular-or-missing-time-grid", action: "open-timestamps-and-freeze-resampling-policy", reason: "Implicit regular spacing can create false lag structure." },
      { trigger: "trend-seasonality-or-autocorrelation", action: "create-supported-time-series-model-analysis-spec", reason: "Diagnostics identify structure but are not a forecast model." },
      { trigger: "shock-or-anomaly", action: "inspect-source-event-and-propose-intervention-sensitivity", reason: "An anomaly may be data error or the scientific event of interest." },
    ],
  },
  roc_curve_analysis: {
    neededWhen: "When a continuous score must discriminate a prespecified binary outcome over candidate thresholds.",
    decision: "Whether discrimination is adequate and which threshold tradeoff matches the actual cost or clinical objective.",
    mustShow: "Class counts, score distributions, exact ROC points, AUC with uncertainty boundary, sensitivity, specificity, threshold, and the absence of calibration or external validation claims.",
    userGoal: "Evaluate ranking discrimination and choose a threshold only under an explicit utility rule.",
    nextActions: [
      { trigger: "threshold-decision-needed", action: "ask-for-cost-benefit-or-clinical-utility-rule", reason: "Youden or visual preference is not a universal decision criterion." },
      { trigger: "model-comparison", action: "create-paired-validation-analysis-plan", reason: "AUCs from different or reused samples need a declared comparison design." },
      { trigger: "discrimination-acceptable", action: "plan-calibration-and-external-validation", reason: "Discrimination alone is insufficient for deployment." },
    ],
  },
  meta_analysis: {
    neededWhen: "When compatible study-level effects must be synthesized while preserving sampling uncertainty and between-study heterogeneity.",
    decision: "What pooled effect is supported, how heterogeneous it is, and whether pooling is scientifically defensible.",
    mustShow: "Every study effect and uncertainty, fixed and selected random summary, heterogeneity and prediction interval, weights, leave-one-out influence, funnel limitations, and effect-scale compatibility.",
    userGoal: "Synthesize the evidence, identify heterogeneity and influence, and produce a transparent review result.",
    nextActions: [
      { trigger: "incompatible-effect-scale-or-population", action: "stop-pooling-and-revise-eligibility-or-stratification", reason: "A mathematical pooled number cannot repair a scientific mismatch." },
      { trigger: "material-heterogeneity", action: "create-prespecified-subgroup-or-meta-regression-plan", reason: "Post-hoc explanations should not be presented as confirmed." },
      { trigger: "influential-study", action: "open-study-provenance-without-automatic-exclusion", reason: "Influence is a sensitivity signal, not an exclusion rule." },
      { trigger: "synthesis-defensible", action: "bind-forest-heterogeneity-and-influence-artifacts", reason: "The pooled estimate must travel with heterogeneity and study-level evidence." },
    ],
  },
  response_surface_regression: {
    neededWhen: "When a bounded experimental region is modeled with linear, interaction, and quadratic terms to understand or optimize a numeric response.",
    decision: "Where the supported response surface suggests improvement and whether a candidate setting lies inside the observed design region.",
    mustShow: "Exact coded model and coefficients, observed design points, surface and contours, convex-hull support mask, residual diagnostics, stationary point, and no extrapolated optimum.",
    userGoal: "Explore factor interactions and choose the next experiment inside defensible support.",
    nextActions: [
      { trigger: "candidate-optimum-outside-support", action: "reject-optimum-and-design-boundary-expansion-experiment", reason: "Unobserved extrapolation is not an experimental result." },
      { trigger: "curvature-or-interaction-supported", action: "propose-confirmatory-runs-around-supported-region", reason: "A fitted surface should guide new measurements, not replace them." },
      { trigger: "model-lack-of-fit", action: "inspect-residuals-and-revise-design-or-model", reason: "Optimization is unsafe when the response model is not defensible." },
    ],
  },
  gaussian_random_intercept_lmm: {
    neededWhen: "When repeated or clustered continuous observations share a group-specific baseline and cannot be treated as independent.",
    decision: "How prespecified population fixed effects behave after accounting for between-group baseline heterogeneity.",
    mustShow: "Exact formula and group support, fixed-effect intervals, variance components and ICC, group BLUP uncertainty, conditional fitted values, and residual and random-effect diagnostics.",
    userGoal: "Decide whether the primary population effect is supported, whether baseline heterogeneity matters, and whether the model is defensible for a manuscript.",
    nextActions: [
      { trigger: "primary-fixed-effect", action: "review-estimate-ci-unit-and-reference-then-bind-table-or-figure", reason: "The exact estimand and coding determine the scientific claim." },
      { trigger: "material-icc-or-varying-trajectory", action: "review-random-slope-requirement-before-any-model-extension", reason: "Random-intercept-only support may be insufficient for changing trajectories." },
      { trigger: "residual-or-qq-defect", action: "create-transformation-or-residual-structure-sensitivity-plan", reason: "Diagnostics should create a declared successor plan, not silent model shopping." },
      { trigger: "extreme-group-blup", action: "open-exact-source-rows-without-automatic-exclusion", reason: "Group influence requires provenance review." },
      { trigger: "ml-fixed-structure-comparison-complete", action: "refit-final-fixed-structure-with-reml", reason: "Final variance estimation should follow the frozen fixed structure." },
    ],
  },
});

function buildResearchDecisionLinkage(method, artifactRoles) {
  const entry = METHOD_DECISION_LINKAGE[method];
  if (!entry) throw new Error(`Missing research decision linkage for ${method}`);
  return {
    name: "research-decision linkage",
    schema: DECISION_LINKAGE_SCHEMA,
    status: "ready",
    method,
    decisionQuestions: [
      { order: 1, question: "When is this analysis needed?", answer: entry.neededWhen },
      { order: 2, question: "What decision is live?", answer: entry.decision },
      { order: 3, question: "What must be visible?", answer: entry.mustShow },
      { order: 4, question: "What does the researcher want to do?", answer: entry.userGoal },
      { order: 5, question: "What should Agentlas do next?", answer: "Offer only evidence-triggered actions below, keep source provenance attached, and never silently change data, estimand, or model." },
    ],
    artifactRoles: [...artifactRoles],
    nextActions: entry.nextActions.map((item) => ({ ...item })),
  };
}

module.exports = {
  DECISION_LINKAGE_SCHEMA,
  METHOD_DECISION_LINKAGE,
  buildResearchDecisionLinkage,
};
