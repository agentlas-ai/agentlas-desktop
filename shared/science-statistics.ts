import { createHash } from "node:crypto";
import {
  validateScienceFigureSpec,
  type ScienceFigureSpec,
} from "./science-figure";
import {
  SCIENCE_ANALYSIS_MODEL_FAMILIES,
  type ScienceAnalysisModelSpec,
} from "./science-contract";
import {
  SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA,
  validateScienceStatisticsNumericSurfaceSourcePayload,
} from "./science-numeric-3d";

export const SCIENCE_STATISTICS_REQUEST_SCHEMA = "agentlas.science.statistics.request/v1" as const;
export const SCIENCE_STATISTICS_RESULT_SCHEMA = "agentlas.science.statistics.result/v1" as const;
export const SCIENCE_STATISTICS_RECEIPT_SCHEMA = "agentlas.science.statistics.receipt/v1" as const;
export const SCIENCE_STATISTICS_TABLE_SCHEMA = "agentlas.science.statistics-table/v1" as const;
export const SCIENCE_STATISTICS_ARTIFACT_SCHEMA = "agentlas.science.statistics-analysis-artifact/v1" as const;
export const SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA = "agentlas.science.statistics-execution-binding/v1" as const;
export const SCIENCE_STATISTICS_EXECUTION_RECEIPT_SCHEMA = "agentlas.science.statistics-execution-receipt/v1" as const;
export const SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA = "agentlas.science.statistics.data-table-projection-receipt/v1" as const;
export const SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA = "agentlas.science.statistics.data-table-projection-receipt/v2" as const;
export const SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA = "agentlas.science.statistics.data-table-projection-receipt/v3" as const;
/**
 * The receipt for the general projection, which reads a table into whatever shape a method declares
 * for itself.
 *
 * It needs its own schema because every receipt above validates a FIXED set of column names for one
 * named method -- `groupColumn` and `valueColumn`, `outcomeColumn` and `scoreColumn`. That works
 * while there are six projections and stops working the moment the projection is general: the
 * mapping here is keyed by the method's own declared data properties, whatever they are called.
 */
export const SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA = "agentlas.science.statistics.data-table-projection-receipt/v4" as const;
export const SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA = "agentlas.science.statistics-figure-artifact/v1" as const;
export const SCIENCE_STATISTICS_FIGURE_RASTER_ARTIFACT_SCHEMA = "agentlas.science.statistics-figure-raster-artifact/v1" as const;
export const SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA = "agentlas.science.statistics-figure-vector-artifact/v1" as const;
export const SCIENCE_STATISTICS_TOOL_ID = "agentlas.statistics-analysis" as const;
export const SCIENCE_STATISTICS_TOOL_VERSION = "1.10.0" as const;
export const SCIENCE_STATISTICS_LAB_ID = "statistics-analysis" as const;
export const SCIENCE_STATISTICS_FIGURE_LAB_ID = "data-visualization" as const;
export const SCIENCE_STATISTICS_FIGURE_RENDERER_ID = "agentlas.vega" as const;
export const SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION = "6.4.0" as const;
export const SCIENCE_STATISTICS_FIGURE_MATERIALIZER_TOOL_ID = "agentlas.statistics-figure-materializer" as const;
export const SCIENCE_STATISTICS_FIGURE_MATERIALIZER_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_STATISTICS_FIGURE_RASTERIZER_TOOL_ID = "agentlas.statistics-figure-rasterizer" as const;
export const SCIENCE_STATISTICS_FIGURE_RASTERIZER_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_STATISTICS_FIGURE_VECTORIZER_TOOL_ID = "agentlas.statistics-figure-vectorizer" as const;
export const SCIENCE_STATISTICS_FIGURE_VECTORIZER_TOOL_VERSION = "1.0.0" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const STATISTICS_SHA256_RE = /^sha256:[a-f0-9]{64}$/;
export const SCIENCE_STATISTICS_METHODS = [
  "descriptive", "distribution_fit", "pearson_correlation", "spearman_correlation", "kendall_correlation", "independent_t_test", "welch_t_test",
  "paired_t_test", "one_way_anova", "welch_one_way_anova", "two_way_anova", "mann_whitney_u", "wilcoxon_signed_rank", "kruskal_wallis", "friedman_test",
  "linear_regression", "logistic_regression", "poisson_regression", "chi_square_test", "fisher_exact_test",
  "multiple_testing_correction", "confidence_interval",
  "kaplan_meier", "log_rank_test", "cox_proportional_hazards",
  "principal_component_analysis", "time_series_diagnostics", "roc_curve_analysis", "meta_analysis",
  "response_surface_regression",
  "gaussian_random_intercept_lmm",
  // Extension methods contributed by runtime/methods/*.cjs in the statistics plugin. This block and
  // SCIENCE_STATISTICS_EXTENSION_ANALYSIS_MODELS below are generated from the engine registry by
  // scripts/science-statistics-manifests.cjs; scripts/science-statistics-surface-parity-contract.cjs
  // fails closed when they drift, because a method the host does not know is a result the host rejects.
  "ancova", "repeated_measures_anova", "tukey_hsd", "games_howell",
  "dunnett_test", "scheffe_test", "two_way_anova_unbalanced", "shapiro_wilk",
  "anderson_darling_normal", "dagostino_k2", "levene_test", "bartlett_test",
  "fligner_killeen", "kolmogorov_smirnov_two_sample", "durbin_watson", "breusch_pagan",
  "white_test", "variance_inflation_factors", "ordinal_logistic_regression", "multinomial_logistic_regression",
  "negative_binomial_regression", "ridge_regression", "lasso_regression", "elastic_net_regression",
  "quantile_regression", "robust_linear_regression", "polynomial_regression", "nonlinear_least_squares",
  "model_comparison_information_criteria", "augmented_dickey_fuller", "kpss_test", "phillips_perron",
  "arima", "auto_arima", "exponential_smoothing", "seasonal_decomposition",
  "spectral_periodogram", "change_point_detection", "granger_causality", "cross_correlation",
  "vector_autoregression", "power_t_test", "power_anova", "power_proportions",
  "power_correlation", "power_chi_square", "power_regression", "sample_size_precision",
  "bootstrap_confidence_interval", "permutation_test", "jackknife", "cross_validation_regression",
  "bayesian_t_test", "bayesian_proportion", "bayesian_ab_test", "bayesian_linear_regression",
  "bayesian_correlation", "bayesian_anova", "bayesian_meta_analysis", "exploratory_factor_analysis",
  "manova", "hotelling_t2", "linear_discriminant_analysis", "canonical_correlation_analysis",
  "multidimensional_scaling", "partial_correlation", "mahalanobis_outliers", "k_means",
  "hierarchical_clustering", "gaussian_mixture", "dbscan", "cluster_validation",
  "distribution_fit_extended", "probability_calculator", "chi_square_goodness_of_fit", "kernel_density_estimate",
  "empirical_cdf_comparison", "extreme_value_analysis", "weighted_log_rank", "stratified_cox",
  "parametric_survival_regression", "competing_risks_cumulative_incidence", "restricted_mean_survival_time", "nelson_aalen",
  "survival_landmark_analysis", "sign_test", "mood_median_test", "runs_test",
  "jonckheere_terpstra", "page_trend_test", "dunn_test", "conover_iman_test",
  "nemenyi_test", "hodges_lehmann_estimate", "brunner_munzel_test", "quade_test",
  "mcnemar_test", "cochran_q_test", "cochran_armitage_trend_test", "mantel_haenszel_test",
  "fisher_exact_rxc", "g_test", "two_by_two_effect_measures", "chi_square_independence_residuals",
  "binomial_test", "poisson_rate_test", "log_linear_model", "standardized_effect_sizes",
  "effect_size_conversion", "tost_equivalence", "non_inferiority_test", "bland_altman_agreement",
  "cronbach_alpha", "mcdonald_omega", "intraclass_correlation", "cohen_kappa",
  "fleiss_kappa", "krippendorff_alpha", "kendall_w", "difference_in_differences",
  "propensity_score_analysis", "instrumental_variables_2sls", "regression_discontinuity", "mediation_analysis",
  "effect_size_from_arms", "meta_regression", "subgroup_meta_analysis", "trim_and_fill",
  "hartung_knapp_meta_analysis", "cumulative_meta_analysis", "network_meta_analysis_frequentist", "control_chart",
  "process_capability", "gage_rr", "cusum_ewma",
  "missing_data_pattern",
  "multiple_imputation_regression",
  "inverse_probability_weighting",
  "roc_curve_comparison",
  "diagnostic_accuracy_measures",
  "fine_gray_subdistribution_hazard",
  "linear_mixed_model_random_slopes",
  "generalized_estimating_equations",
  "generalized_linear_mixed_model",
  "linear_factor_model",
  "fama_macbeth_regression",
  "grs_test",
  // Order matters: this list is compared element-by-element with the engine's own, and the merge
  // left the two disagreeing on where this one sits. The engine is the runtime truth, and it has
  // this method last.
  "theil_sen_regression",
] as const;
export type ScienceStatisticsMethod = typeof SCIENCE_STATISTICS_METHODS[number];
const METHODS = new Set<string>(SCIENCE_STATISTICS_METHODS);

/**
 * Frozen AnalysisSpec compatibility for every extension method, generated from each module's
 * declared `analysisModel`. The host cannot import the plugin runtime (it is integrity-verified at
 * call time), so this table is the host-side copy and the parity contract keeps it exact.
 */
export const SCIENCE_STATISTICS_EXTENSION_ANALYSIS_MODELS: Readonly<Record<string, { families: readonly string[]; distributions: readonly (string | null)[]; links: readonly (string | null)[] }>> = Object.freeze({
  missing_data_pattern: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  multiple_imputation_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  inverse_probability_weighting: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial", "bernoulli"], links: [null, "identity", "logit"] },
  roc_curve_comparison: { families: ["diagnostic-accuracy", "classification-evaluation"], distributions: [null, "binary", "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  diagnostic_accuracy_measures: { families: ["diagnostic-accuracy", "classification-evaluation"], distributions: [null, "binary", "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  fine_gray_subdistribution_hazard: { families: ["survival"], distributions: [null], links: [null] },
  linear_mixed_model_random_slopes: { families: ["mixed-models", "lmm", "mixed-effects"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  generalized_estimating_equations: { families: ["gee", "mixed-models"], distributions: [null, "normal", "gaussian", "binomial", "poisson"], links: [null, "identity", "logit", "log"] },
  generalized_linear_mixed_model: { families: ["mixed-models", "mixed-effects", "glm"], distributions: [null, "binomial", "poisson"], links: [null, "logit", "log"] },
  linear_factor_model: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  fama_macbeth_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  grs_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  ancova: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  repeated_measures_anova: { families: ["lm", "lmm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  tukey_hsd: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  games_howell: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  dunnett_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  scheffe_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  two_way_anova_unbalanced: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  shapiro_wilk: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  anderson_darling_normal: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  dagostino_k2: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  levene_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bartlett_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  fligner_killeen: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  kolmogorov_smirnov_two_sample: { families: ["lm"], distributions: [null], links: [null] },
  durbin_watson: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  breusch_pagan: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  white_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  variance_inflation_factors: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  ordinal_logistic_regression: { families: ["glm"], distributions: [null, "multinomial", "ordinal"], links: [null, "logit"] },
  multinomial_logistic_regression: { families: ["glm"], distributions: [null, "multinomial"], links: [null, "logit"] },
  negative_binomial_regression: { families: ["glm"], distributions: [null, "poisson", "negative-binomial", "negative_binomial"], links: [null, "log"] },
  ridge_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  lasso_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  elastic_net_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  quantile_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  robust_linear_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  polynomial_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  nonlinear_least_squares: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  model_comparison_information_criteria: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  augmented_dickey_fuller: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  kpss_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  phillips_perron: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  arima: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  auto_arima: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  exponential_smoothing: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  seasonal_decomposition: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  spectral_periodogram: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  change_point_detection: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  granger_causality: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  cross_correlation: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  vector_autoregression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  power_t_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  power_anova: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  power_proportions: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  power_correlation: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  power_chi_square: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "logit", "log"] },
  power_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  sample_size_precision: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  bootstrap_confidence_interval: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  permutation_test: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  jackknife: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  cross_validation_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bayesian_t_test: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bayesian_proportion: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  bayesian_ab_test: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  bayesian_linear_regression: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bayesian_correlation: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bayesian_anova: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  bayesian_meta_analysis: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  exploratory_factor_analysis: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  manova: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  hotelling_t2: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  linear_discriminant_analysis: { families: ["classification-evaluation"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  canonical_correlation_analysis: { families: ["pca", "lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  multidimensional_scaling: { families: ["pca"], distributions: [null], links: [null] },
  partial_correlation: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  mahalanobis_outliers: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  k_means: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  hierarchical_clustering: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  gaussian_mixture: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  dbscan: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  cluster_validation: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  distribution_fit_extended: { families: ["lm"], distributions: [null, "normal", "student_t", "logistic", "gumbel", "gev", "gamma", "weibull", "beta", "lognormal", "exponential", "uniform", "poisson", "negative_binomial", "binomial", "geometric", "gaussian", "student-t"], links: [null, "identity", "log"] },
  probability_calculator: { families: ["lm"], distributions: [null, "normal", "student_t", "logistic", "gumbel", "gev", "gamma", "weibull", "beta", "lognormal", "exponential", "uniform", "chi_square", "f", "poisson", "negative_binomial", "binomial", "geometric", "gaussian", "student-t"], links: [null, "identity"] },
  chi_square_goodness_of_fit: { families: ["glm"], distributions: [null, "multinomial", "poisson"], links: [null, "identity", "log"] },
  kernel_density_estimate: { families: ["lm"], distributions: [null, "nonparametric"], links: [null, "identity"] },
  empirical_cdf_comparison: { families: ["lm"], distributions: [null, "nonparametric"], links: [null, "identity"] },
  extreme_value_analysis: { families: ["lm"], distributions: [null, "gev", "gpd", "gumbel"], links: [null, "identity"] },
  weighted_log_rank: { families: ["survival"], distributions: [null], links: [null] },
  stratified_cox: { families: ["survival"], distributions: [null], links: [null] },
  parametric_survival_regression: { families: ["survival"], distributions: [null], links: [null] },
  competing_risks_cumulative_incidence: { families: ["survival"], distributions: [null], links: [null] },
  restricted_mean_survival_time: { families: ["survival"], distributions: [null], links: [null] },
  nelson_aalen: { families: ["survival"], distributions: [null], links: [null] },
  survival_landmark_analysis: { families: ["survival"], distributions: [null], links: [null] },
  sign_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  mood_median_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  runs_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  jonckheere_terpstra: { families: ["nonparametric"], distributions: [null], links: [null] },
  page_trend_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  dunn_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  conover_iman_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  nemenyi_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  hodges_lehmann_estimate: { families: ["nonparametric"], distributions: [null], links: [null] },
  brunner_munzel_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  quade_test: { families: ["nonparametric"], distributions: [null], links: [null] },
  mcnemar_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  cochran_q_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  cochran_armitage_trend_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  mantel_haenszel_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  fisher_exact_rxc: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  g_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  two_by_two_effect_measures: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  chi_square_independence_residuals: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  binomial_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  poisson_rate_test: { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] },
  log_linear_model: { families: ["categorical", "glm"], distributions: [null, "poisson", "multinomial"], links: [null, "log"] },
  standardized_effect_sizes: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  effect_size_conversion: { families: ["lm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  tost_equivalence: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  non_inferiority_test: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  bland_altman_agreement: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  cronbach_alpha: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  mcdonald_omega: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  intraclass_correlation: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  cohen_kappa: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "identity"] },
  fleiss_kappa: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "identity"] },
  krippendorff_alpha: { families: ["glm"], distributions: [null, "multinomial", "normal"], links: [null, "identity"] },
  kendall_w: { families: ["lm"], distributions: [null, "normal", "ordinal"], links: [null, "identity"] },
  difference_in_differences: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  propensity_score_analysis: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  instrumental_variables_2sls: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  regression_discontinuity: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  mediation_analysis: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  effect_size_from_arms: { families: ["meta-analysis"], distributions: [null, "normal", "binomial"], links: [null, "identity", "logit", "log"] },
  meta_regression: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  subgroup_meta_analysis: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  trim_and_fill: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  hartung_knapp_meta_analysis: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  cumulative_meta_analysis: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  network_meta_analysis_frequentist: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  control_chart: { families: ["lm"], distributions: [null, "normal", "gaussian", "binomial", "poisson"], links: [null, "identity"] },
  process_capability: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  gage_rr: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  cusum_ewma: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  theil_sen_regression: { families: ["nonparametric"], distributions: [null], links: [null] },
});

const NORMAL_IDENTITY_METHODS = new Set<ScienceStatisticsMethod>([
  "pearson_correlation",
  "independent_t_test",
  "welch_t_test",
  "paired_t_test",
  "one_way_anova",
  "welch_one_way_anova",
  "linear_regression",
  "response_surface_regression",
]);

const RANK_COMPANION_METHODS = new Set<ScienceStatisticsMethod>([
  "spearman_correlation",
  "kendall_correlation",
  "wilcoxon_signed_rank",
]);

type JsonRecord = Record<string, unknown>;

export type ScienceStatisticsPurpose = "descriptive" | "exploratory" | "confirmatory";

export interface ScienceStatisticsInputArtifactBinding {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceStatisticsKaplanMeierSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  timeColumn: string;
  eventColumn: string;
  label: string;
}

/**
 * Every shape a stored data table can be projected into before an analysis reads it.
 *
 * This is a runtime array, not a type-only union, because the MCP tool schema advertises one
 * `source_table` branch per projection and a gate has to be able to check that the two agree.
 * When the list was type-only the gate could only pin a count, so adding a projection turned it
 * red for no product reason and dropping one could pass unnoticed.
 */
export const SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_KINDS = Object.freeze([
  "welch-one-way-anova-long",
  "friedman-long",
  "roc-curve-analysis",
  "response-surface-regression",
  "gaussian-random-intercept-lmm-long",
  // The general one. Every projection above names a single method and was written by hand; this one
  // projects against whatever data shape a method declares for itself, which is what made the other
  // 172 registered methods reachable from an uploaded table at all.
  "declared-columns",
] as const);

export type ScienceStatisticsDataTableProjectionKind =
  typeof SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_KINDS[number];

export interface ScienceStatisticsWelchSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  method: "welch_one_way_anova";
  projectionKind: "welch-one-way-anova-long";
  groupColumn: string;
  valueColumn: string;
}

export interface ScienceStatisticsFriedmanSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  method: "friedman_test";
  projectionKind: "friedman-long";
  blockColumn: string;
  conditionColumn: string;
  valueColumn: string;
}

export interface ScienceStatisticsRocSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  method: "roc_curve_analysis";
  projectionKind: "roc-curve-analysis";
  outcomeColumn: string;
  scoreColumn: string;
  observationLabelColumn: string | null;
}

export interface ScienceStatisticsResponseSurfaceSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  method: "response_surface_regression";
  projectionKind: "response-surface-regression";
  responseColumn: string;
  factor1Column: string;
  factor2Column: string;
}

export type ScienceStatisticsLmmFixedEffectSpec =
  | { column: string; type: "numeric" }
  | { column: string; type: "categorical"; levels: string[]; reference: string };

export interface ScienceStatisticsLmmSourceTableBinding extends ScienceStatisticsInputArtifactBinding {
  method: "gaussian_random_intercept_lmm";
  projectionKind: "gaussian-random-intercept-lmm-long";
  outcomeColumn: string;
  groupColumn: string;
  observationLabelColumn: string | null;
  fixedEffects: ScienceStatisticsLmmFixedEffectSpec[];
}

export type ScienceStatisticsSourceTableBinding =
  | ScienceStatisticsKaplanMeierSourceTableBinding
  | ScienceStatisticsWelchSourceTableBinding
  | ScienceStatisticsFriedmanSourceTableBinding
  | ScienceStatisticsRocSourceTableBinding
  | ScienceStatisticsResponseSurfaceSourceTableBinding
  | ScienceStatisticsLmmSourceTableBinding;

export type ScienceStatisticsSourceTableInput =
  | (Omit<ScienceStatisticsKaplanMeierSourceTableBinding, "label"> & { label?: string })
  | ScienceStatisticsWelchSourceTableBinding
  | ScienceStatisticsFriedmanSourceTableBinding
  | (Omit<ScienceStatisticsRocSourceTableBinding, "observationLabelColumn"> & { observationLabelColumn?: string | null })
  | ScienceStatisticsResponseSurfaceSourceTableBinding
  | (Omit<ScienceStatisticsLmmSourceTableBinding, "observationLabelColumn"> & { observationLabelColumn?: string | null });

export interface ScienceStatisticsDataTableProjectionReceipt {
  schema: typeof SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA;
  sourceArtifact: ScienceStatisticsInputArtifactBinding;
  sourceTableSha256: string;
  timeColumn: string;
  eventColumn: string;
  label: string;
  includedRowCount: number;
  includedRowsSha256: string;
  projectedDataSha256: string;
  receiptSha256: string;
}

export type ScienceStatisticsDataTableProjectionColumns =
  | { groupColumn: string; valueColumn: string }
  | { blockColumn: string; conditionColumn: string; valueColumn: string }
  | { outcomeColumn: string; scoreColumn: string; observationLabelColumn: string | null }
  | { responseColumn: string; factor1Column: string; factor2Column: string };

export interface ScienceStatisticsDataTableProjectionReceiptV2 {
  schema: typeof SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA;
  method: "welch_one_way_anova" | "friedman_test" | "roc_curve_analysis" | "response_surface_regression";
  projectionKind: ScienceStatisticsDataTableProjectionKind;
  sourceArtifact: ScienceStatisticsInputArtifactBinding;
  sourceTableSha256: string;
  columns: ScienceStatisticsDataTableProjectionColumns;
  includedRowCount: number;
  includedRowsSha256: string;
  projectedDataSha256: string;
  receiptSha256: string;
}

export interface ScienceStatisticsDataTableProjectionReceiptV3 {
  schema: typeof SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA;
  method: "gaussian_random_intercept_lmm";
  projectionKind: "gaussian-random-intercept-lmm-long";
  sourceArtifact: ScienceStatisticsInputArtifactBinding;
  sourceTableSha256: string;
  columns: {
    outcomeColumn: string;
    groupColumn: string;
    observationLabelColumn: string | null;
    fixedEffects: ScienceStatisticsLmmFixedEffectSpec[];
  };
  includedRowCount: number;
  includedRowsSha256: string;
  projectedDataSha256: string;
  receiptSha256: string;
}

export interface ScienceStatisticsDataTableProjectionReceiptV4 {
  schema: typeof SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA;
  method: string;
  projectionKind: "declared-columns";
  sourceArtifact: ScienceStatisticsInputArtifactBinding;
  sourceTableSha256: string;
  /** What each declared data property was read from, keyed by the property's own name. */
  columns: Record<string, unknown>;
  includedRowCount: number;
  includedRowsSha256: string;
  projectedDataSha256: string;
  receiptSha256: string;
}

export type ScienceStatisticsAnyDataTableProjectionReceipt =
  | ScienceStatisticsDataTableProjectionReceipt
  | ScienceStatisticsDataTableProjectionReceiptV2
  | ScienceStatisticsDataTableProjectionReceiptV3
  | ScienceStatisticsDataTableProjectionReceiptV4;

export interface ScienceStatisticsFrozenPlanBinding {
  analysisSpecId: string;
  version: number;
  contentSha256: string;
  status: "frozen";
  plannedMethodToken: string;
  model: ScienceAnalysisModelSpec;
  modelSha256: string;
}

export interface ScienceStatisticsExecutionBinding {
  schema: typeof SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA;
  purpose: ScienceStatisticsPurpose;
  inputArtifacts: ScienceStatisticsInputArtifactBinding[];
  analysisPlan: ScienceStatisticsFrozenPlanBinding | null;
  bindingSha256: string;
}

export interface ScienceStatisticsExecutionReceipt {
  schema: typeof SCIENCE_STATISTICS_EXECUTION_RECEIPT_SCHEMA;
  inputSha256: string;
  engineRequestHash: string;
  executionBindingSha256: string;
  visualizationsSha256: string;
  projectionReceiptSha256?: string;
  receiptSha256: string;
}

export interface ScienceStatisticsTableColumn {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
}

export interface ScienceStatisticsTableArtifact {
  kind: "table";
  role: string;
  schema: typeof SCIENCE_STATISTICS_TABLE_SCHEMA;
  payload: {
    schema: typeof SCIENCE_STATISTICS_TABLE_SCHEMA;
    title: string;
    caption: string;
    columns: ScienceStatisticsTableColumn[];
    rows: Array<Record<string, string | number | boolean | null>>;
    notes: string[];
  };
}

export interface ScienceStatisticsVisualization {
  sourceArtifactIndex: number;
  sourceArtifactSha256: string;
  sourceSpecSha256: string;
  role: string;
  title: string;
}

export interface ScienceStatisticsAnalysisArtifactPayload {
  schema: typeof SCIENCE_STATISTICS_ARTIFACT_SCHEMA;
  inputSha256: string;
  method: string;
  executionBinding: ScienceStatisticsExecutionBinding;
  executionReceipt: ScienceStatisticsExecutionReceipt;
  projectionReceipt?: ScienceStatisticsAnyDataTableProjectionReceipt;
  result: JsonRecord & {
    schema: typeof SCIENCE_STATISTICS_RESULT_SCHEMA;
    artifacts: Array<ScienceStatisticsTableArtifact | JsonRecord>;
    artifactReceipts: Array<{ index: number; kind: string; role: string; sha256: string; bytes: number }>;
    resultHash: string;
    receipt: JsonRecord;
  };
  selectedTableIndex: number;
  visualizations: ScienceStatisticsVisualization[];
}

export interface ScienceStatisticsFigureArtifactPayload {
  schema: typeof SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA;
  statisticsArtifact: ScienceStatisticsInputArtifactBinding;
  method: string;
  visualization: {
    index: number;
    sourceArtifactIndex: number;
    sourceArtifactSha256: string;
    sourceSpecSha256: string;
    role: string;
    title: string;
  };
  sourceSpec: JsonRecord;
  originalSpecSha256: string;
  spec: JsonRecord;
  figureSpec: ScienceFigureSpec;
}

export interface ScienceStatisticsFigureRasterArtifactPayload {
  schema: typeof SCIENCE_STATISTICS_FIGURE_RASTER_ARTIFACT_SCHEMA;
  figureArtifact: ScienceStatisticsInputArtifactBinding;
  export: {
    mimeType: "image/png";
    renderer: { id: "agentlas.vega"; version: string };
    sourceSpecSha256: string;
    sourceSvgSha256: string;
    exportProfile: "journal-raster-300dpi" | "journal-raster-600dpi";
    dpi: 300 | 600;
    widthMm: number;
    heightMm: number;
    width: number;
    height: number;
    colorSpace: "srgb";
    background: "#ffffff";
    byteSize: number;
    sha256: string;
  };
  exportSha256: string;
}

export interface ScienceStatisticsFigureVectorArtifactPayload {
  schema: typeof SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA;
  figureArtifact: ScienceStatisticsInputArtifactBinding;
  export: {
    mimeType: "image/svg+xml";
    renderer: { id: "agentlas.vega"; version: string };
    sourceSpecSha256: string;
    exportProfile: "journal-vector-svg";
    width: number;
    height: number;
    byteSize: number;
    sha256: string;
  };
  exportSha256: string;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceStatisticsSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

export function isScienceStatisticsMethod(value: unknown): value is ScienceStatisticsMethod {
  return typeof value === "string" && METHODS.has(value);
}

/** Fail-closed compatibility registry between an executable method and a frozen AnalysisSpec model. */
export function scienceStatisticsMethodMatchesAnalysisModel(method: unknown, value: unknown): boolean {
  if (!isScienceStatisticsMethod(method)) return false;
  const model = record(value);
  if (!model || typeof model.family !== "string" || !SCIENCE_ANALYSIS_MODEL_FAMILIES.includes(model.family as ScienceAnalysisModelSpec["family"])) return false;
  if (model.distribution !== null && typeof model.distribution !== "string") return false;
  if (model.link !== null && typeof model.link !== "string") return false;
  const family = model.family;
  const distribution = model.distribution === null ? null : model.distribution.trim().toLowerCase();
  const link = model.link === null ? null : model.link.trim().toLowerCase();
  if (NORMAL_IDENTITY_METHODS.has(method)) {
    return family === "lm" && (distribution === null || distribution === "normal" || distribution === "gaussian")
      && (link === null || link === "identity");
  }
  if (RANK_COMPANION_METHODS.has(method)) {
    // A confirmatory plan often freezes a Pearson/t-test primary analysis and a rank-based
    // companion on the same outcome/predictor relation. One AnalysisSpec has one model binding, so
    // accept the primary lm identity model as well as an explicitly rank/nonparametric model; the
    // method receipt still records which calculation actually ran.
    return (family === "lm" && (distribution === null || distribution === "normal" || distribution === "gaussian")
      && (link === null || link === "identity"))
      || (["rank-test", "nonparametric"].includes(family) && distribution === null && link === null);
  }
  if (method === "friedman_test") {
    return family === "rank-test" && (distribution === null || distribution === "friedman") && link === null;
  }
  if (method === "roc_curve_analysis") {
    return family === "classification-evaluation" && (distribution === null || distribution === "binary") && link === null;
  }
  if (method === "logistic_regression") return family === "glm" && distribution === "binomial" && link === "logit";
  if (method === "poisson_regression") return family === "glm" && distribution === "poisson" && link === "log";
  if (method === "chi_square_test" || method === "fisher_exact_test") {
    return family === "glm" && (distribution === "binomial" || distribution === "multinomial")
      && (link === "logit" || link === "log" || link === null);
  }
  if (method === "kaplan_meier") {
    return family === "glm" && (distribution === "kaplan-meier" || distribution === "kaplan meier" || distribution === "survival") && link === null;
  }
  if (method === "cox_proportional_hazards") {
    return family === "glm" && (distribution === "cox" || distribution === "cox-ph" || distribution === "cox proportional hazards" || distribution === "cox-proportional-hazards")
      && (link === "log hazard" || link === "log-hazard");
  }
  if (method === "principal_component_analysis") return family === "pca" && distribution === null && link === null;
  if (method === "time_series_diagnostics") {
    return family === "time-series-diagnostics" && (distribution === null || distribution === "deterministic-trend-diagnostics")
      && (link === null || link === "identity");
  }
  if (method === "meta_analysis") {
    return family === "mixed-effects" && (distribution === null || distribution === "normal" || distribution === "gaussian")
      && (link === null || link === "identity");
  }
  if (method === "gaussian_random_intercept_lmm") {
    const groupingVariables = Array.isArray(model.groupingVariables) ? model.groupingVariables : [];
    const randomEffects = Array.isArray(model.randomEffects) ? model.randomEffects : [];
    const grouping = groupingVariables.length === 1 && typeof groupingVariables[0] === "string" ? groupingVariables[0].trim() : "";
    const randomEffect = randomEffects.length === 1 && typeof randomEffects[0] === "string" ? randomEffects[0].replace(/\s+/gu, "") : "";
    return family === "mixed-effects" && (distribution === null || distribution === "normal" || distribution === "gaussian")
      && (link === null || link === "identity") && Boolean(grouping)
      && ["(1|" + grouping + ")", "1|" + grouping, "random-intercept:" + grouping].includes(randomEffect);
  }
  const extension = SCIENCE_STATISTICS_EXTENSION_ANALYSIS_MODELS[method];
  if (extension) {
    return extension.families.includes(family)
      && extension.distributions.includes(distribution)
      && extension.links.includes(link);
  }
  return false;
}

function validateScienceStatisticsDataTableProjectionReceiptV1(value: unknown): ScienceStatisticsDataTableProjectionReceipt {
  const receipt = record(value);
  if (!receipt || !exactKeys(receipt, [
    "schema", "sourceArtifact", "sourceTableSha256", "timeColumn", "eventColumn", "label",
    "includedRowCount", "includedRowsSha256", "projectedDataSha256", "receiptSha256",
  ]) || receipt.schema !== SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA
    || typeof receipt.sourceTableSha256 !== "string" || !SHA256_RE.test(receipt.sourceTableSha256)
    || !Number.isSafeInteger(receipt.includedRowCount) || Number(receipt.includedRowCount) < 1 || Number(receipt.includedRowCount) > 5_000
    || typeof receipt.includedRowsSha256 !== "string" || !SHA256_RE.test(receipt.includedRowsSha256)
    || typeof receipt.projectedDataSha256 !== "string" || !SHA256_RE.test(receipt.projectedDataSha256)
    || typeof receipt.receiptSha256 !== "string" || !SHA256_RE.test(receipt.receiptSha256)) {
    throw new Error("science-statistics-data-table-projection-receipt-invalid");
  }
  const sourceArtifacts = validateInputArtifactBindings([receipt.sourceArtifact]);
  const core = {
    schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA,
    sourceArtifact: sourceArtifacts[0],
    sourceTableSha256: receipt.sourceTableSha256,
    timeColumn: safeText(receipt.timeColumn, 240, "science-statistics-data-table-projection-receipt-invalid"),
    eventColumn: safeText(receipt.eventColumn, 240, "science-statistics-data-table-projection-receipt-invalid"),
    label: safeText(receipt.label, 128, "science-statistics-data-table-projection-receipt-invalid"),
    includedRowCount: Number(receipt.includedRowCount),
    includedRowsSha256: receipt.includedRowsSha256,
    projectedDataSha256: receipt.projectedDataSha256,
  };
  if (core.timeColumn === core.eventColumn || scienceStatisticsSha256(core) !== receipt.receiptSha256) {
    throw new Error("science-statistics-data-table-projection-receipt-invalid");
  }
  return { ...core, receiptSha256: receipt.receiptSha256 };
}

function normalizeScienceStatisticsLmmFixedEffects(value: unknown, code: string): ScienceStatisticsLmmFixedEffectSpec[] {
  if (!Array.isArray(value) || value.length > 48) throw new Error(code);
  let expandedTerms = 0;
  const normalized = value.map((raw) => {
    const item = record(raw);
    if (!item || typeof item.type !== "string") throw new Error(code);
    if (item.type === "numeric") {
      if (!exactKeys(item, ["column", "type"])) throw new Error(code);
      expandedTerms += 1;
      return { column: safeText(item.column, 128, code), type: "numeric" as const };
    }
    if (item.type !== "categorical" || !exactKeys(item, ["column", "type", "levels", "reference"])
      || !Array.isArray(item.levels) || item.levels.length < 2 || item.levels.length > 32) throw new Error(code);
    const levels = item.levels.map((level) => safeText(level, 128, code)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (new Set(levels).size !== levels.length) throw new Error(code);
    const reference = safeText(item.reference, 128, code);
    if (!levels.includes(reference)) throw new Error(code);
    expandedTerms += levels.length - 1;
    return { column: safeText(item.column, 128, code), type: "categorical" as const, levels, reference };
  });
  if (new Set(normalized.map((item) => item.column)).size !== normalized.length || expandedTerms > 32) throw new Error(code);
  return normalized;
}

function validateScienceStatisticsDataTableProjectionReceiptV3(value: unknown): ScienceStatisticsDataTableProjectionReceiptV3 {
  const code = "science-statistics-data-table-projection-receipt-v3-invalid";
  const receipt = record(value);
  if (!receipt || !exactKeys(receipt, [
    "schema", "method", "projectionKind", "sourceArtifact", "sourceTableSha256", "columns",
    "includedRowCount", "includedRowsSha256", "projectedDataSha256", "receiptSha256",
  ]) || receipt.schema !== SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA
    || receipt.method !== "gaussian_random_intercept_lmm" || receipt.projectionKind !== "gaussian-random-intercept-lmm-long"
    || typeof receipt.sourceTableSha256 !== "string" || !SHA256_RE.test(receipt.sourceTableSha256)
    || !Number.isSafeInteger(receipt.includedRowCount) || Number(receipt.includedRowCount) < 12 || Number(receipt.includedRowCount) > 10_000
    || typeof receipt.includedRowsSha256 !== "string" || !SHA256_RE.test(receipt.includedRowsSha256)
    || typeof receipt.projectedDataSha256 !== "string" || !SHA256_RE.test(receipt.projectedDataSha256)
    || typeof receipt.receiptSha256 !== "string" || !SHA256_RE.test(receipt.receiptSha256)) throw new Error(code);
  const columns = record(receipt.columns);
  if (!columns || !exactKeys(columns, ["outcomeColumn", "groupColumn", "observationLabelColumn", "fixedEffects"])) throw new Error(code);
  const normalizedColumns = {
    outcomeColumn: safeText(columns.outcomeColumn, 128, code),
    groupColumn: safeText(columns.groupColumn, 128, code),
    observationLabelColumn: columns.observationLabelColumn === null ? null : safeText(columns.observationLabelColumn, 128, code),
    fixedEffects: normalizeScienceStatisticsLmmFixedEffects(columns.fixedEffects, code),
  };
  const selectedColumns = [normalizedColumns.outcomeColumn, normalizedColumns.groupColumn,
    ...(normalizedColumns.observationLabelColumn === null ? [] : [normalizedColumns.observationLabelColumn]),
    ...normalizedColumns.fixedEffects.map((item) => item.column)];
  if (new Set(selectedColumns).size !== selectedColumns.length) throw new Error(code);
  const sourceArtifact = validateInputArtifactBindings([receipt.sourceArtifact])[0];
  const core = {
    schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA,
    method: "gaussian_random_intercept_lmm" as const,
    projectionKind: "gaussian-random-intercept-lmm-long" as const,
    sourceArtifact,
    sourceTableSha256: receipt.sourceTableSha256,
    columns: normalizedColumns,
    includedRowCount: Number(receipt.includedRowCount),
    includedRowsSha256: receipt.includedRowsSha256,
    projectedDataSha256: receipt.projectedDataSha256,
  };
  if (scienceStatisticsSha256(core) !== receipt.receiptSha256) throw new Error("science-statistics-data-table-projection-receipt-v3-hash-invalid");
  return { ...core, receiptSha256: receipt.receiptSha256 };
}

/** Validates an immutable Data Table projection receipt without weakening the legacy Kaplan-Meier v1 rail. */
/**
 * The general projection's receipt.
 *
 * The method name is checked for shape, not against a list: this receipt exists precisely so that a
 * method the registry adds later is covered without editing this file. What is still checked
 * exactly is everything that makes the run reproducible -- the source artifact and its content
 * hash, the row count, the hash of the rows that were read, the hash of what was produced, and the
 * receipt's own hash over all of it.
 */
function validateScienceStatisticsDataTableProjectionReceiptV4(value: unknown): ScienceStatisticsDataTableProjectionReceiptV4 {
  const code = "science-statistics-data-table-projection-receipt-v4-invalid";
  const receipt = record(value);
  if (!receipt || !exactKeys(receipt, [
    "schema", "method", "projectionKind", "sourceArtifact", "sourceTableSha256", "columns",
    "includedRowCount", "includedRowsSha256", "projectedDataSha256", "receiptSha256",
  ]) || receipt.schema !== SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA
    || receipt.projectionKind !== "declared-columns"
    || typeof receipt.method !== "string" || !/^[a-z][a-z0-9_]{2,63}$/u.test(receipt.method)
    || typeof receipt.sourceTableSha256 !== "string" || !SHA256_RE.test(receipt.sourceTableSha256)
    || !Number.isSafeInteger(receipt.includedRowCount) || Number(receipt.includedRowCount) < 1 || Number(receipt.includedRowCount) > 1_000_000
    || typeof receipt.includedRowsSha256 !== "string" || !SHA256_RE.test(receipt.includedRowsSha256)
    || typeof receipt.projectedDataSha256 !== "string" || !SHA256_RE.test(receipt.projectedDataSha256)
    || typeof receipt.receiptSha256 !== "string" || !SHA256_RE.test(receipt.receiptSha256)) {
    throw new Error(code);
  }
  const columns = record(receipt.columns);
  if (!columns || !Object.keys(columns).length || Object.keys(columns).length > 48) throw new Error(code);
  const core = {
    schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA,
    method: receipt.method,
    projectionKind: "declared-columns" as const,
    sourceArtifact: validateInputArtifactBindings([receipt.sourceArtifact])[0],
    sourceTableSha256: receipt.sourceTableSha256,
    columns,
    includedRowCount: Number(receipt.includedRowCount),
    includedRowsSha256: receipt.includedRowsSha256,
    projectedDataSha256: receipt.projectedDataSha256,
  };
  if (scienceStatisticsSha256(core) !== receipt.receiptSha256) throw new Error(code);
  return { ...core, receiptSha256: receipt.receiptSha256 };
}

export function validateScienceStatisticsDataTableProjectionReceipt(value: unknown): ScienceStatisticsAnyDataTableProjectionReceipt {
  const candidate = record(value);
  if (candidate?.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA) {
    return validateScienceStatisticsDataTableProjectionReceiptV1(value);
  }
  if (candidate?.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA) {
    return validateScienceStatisticsDataTableProjectionReceiptV3(value);
  }
  if (candidate?.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA) {
    return validateScienceStatisticsDataTableProjectionReceiptV4(value);
  }
  if (!candidate || !exactKeys(candidate, [
    "schema", "method", "projectionKind", "sourceArtifact", "sourceTableSha256", "columns",
    "includedRowCount", "includedRowsSha256", "projectedDataSha256", "receiptSha256",
  ]) || candidate.schema !== SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA
    || !["welch_one_way_anova", "friedman_test", "roc_curve_analysis", "response_surface_regression"].includes(String(candidate.method))
    || !["welch-one-way-anova-long", "friedman-long", "roc-curve-analysis", "response-surface-regression"].includes(String(candidate.projectionKind))
    || typeof candidate.sourceTableSha256 !== "string" || !SHA256_RE.test(candidate.sourceTableSha256)
    || !Number.isSafeInteger(candidate.includedRowCount) || Number(candidate.includedRowCount) < 1 || Number(candidate.includedRowCount) > 100_000
    || typeof candidate.includedRowsSha256 !== "string" || !SHA256_RE.test(candidate.includedRowsSha256)
    || typeof candidate.projectedDataSha256 !== "string" || !SHA256_RE.test(candidate.projectedDataSha256)
    || typeof candidate.receiptSha256 !== "string" || !SHA256_RE.test(candidate.receiptSha256)) {
    throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
  }
  const method = candidate.method as ScienceStatisticsDataTableProjectionReceiptV2["method"];
  const projectionKind = candidate.projectionKind as ScienceStatisticsDataTableProjectionKind;
  if ((method === "welch_one_way_anova" && projectionKind !== "welch-one-way-anova-long")
    || (method === "friedman_test" && projectionKind !== "friedman-long")
    || (method === "roc_curve_analysis" && projectionKind !== "roc-curve-analysis")
    || (method === "response_surface_regression" && projectionKind !== "response-surface-regression")) {
    throw new Error("science-statistics-data-table-projection-receipt-v2-method-mismatch");
  }
  const columns = record(candidate.columns);
  if (!columns) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
  let normalizedColumns: ScienceStatisticsDataTableProjectionColumns;
  if (projectionKind === "welch-one-way-anova-long") {
    if (!exactKeys(columns, ["groupColumn", "valueColumn"])) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
    normalizedColumns = {
      groupColumn: safeText(columns.groupColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      valueColumn: safeText(columns.valueColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
    };
    if (normalizedColumns.groupColumn === normalizedColumns.valueColumn) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
  } else if (projectionKind === "friedman-long") {
    if (!exactKeys(columns, ["blockColumn", "conditionColumn", "valueColumn"])) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
    normalizedColumns = {
      blockColumn: safeText(columns.blockColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      conditionColumn: safeText(columns.conditionColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      valueColumn: safeText(columns.valueColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
    };
    if (new Set(Object.values(normalizedColumns)).size !== 3) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
  } else if (projectionKind === "roc-curve-analysis") {
    if (!exactKeys(columns, ["outcomeColumn", "scoreColumn", "observationLabelColumn"])) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
    normalizedColumns = {
      outcomeColumn: safeText(columns.outcomeColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      scoreColumn: safeText(columns.scoreColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      observationLabelColumn: columns.observationLabelColumn === null ? null
        : safeText(columns.observationLabelColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
    };
    if (normalizedColumns.outcomeColumn === normalizedColumns.scoreColumn
      || normalizedColumns.observationLabelColumn === normalizedColumns.outcomeColumn
      || normalizedColumns.observationLabelColumn === normalizedColumns.scoreColumn) {
      throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
    }
  } else {
    if (!exactKeys(columns, ["responseColumn", "factor1Column", "factor2Column"])) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
    normalizedColumns = {
      responseColumn: safeText(columns.responseColumn, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      factor1Column: safeText(columns.factor1Column, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
      factor2Column: safeText(columns.factor2Column, 240, "science-statistics-data-table-projection-receipt-v2-invalid"),
    };
    if (new Set(Object.values(normalizedColumns)).size !== 3) throw new Error("science-statistics-data-table-projection-receipt-v2-invalid");
  }
  const sourceArtifact = validateInputArtifactBindings([candidate.sourceArtifact])[0];
  const core = {
    schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
    method,
    projectionKind,
    sourceArtifact,
    sourceTableSha256: candidate.sourceTableSha256,
    columns: normalizedColumns,
    includedRowCount: Number(candidate.includedRowCount),
    includedRowsSha256: candidate.includedRowsSha256,
    projectedDataSha256: candidate.projectedDataSha256,
  };
  if (scienceStatisticsSha256(core) !== candidate.receiptSha256) throw new Error("science-statistics-data-table-projection-receipt-v2-hash-invalid");
  return { ...core, receiptSha256: candidate.receiptSha256 };
}

function validateInputArtifactBindings(value: unknown): ScienceStatisticsInputArtifactBinding[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("science-statistics-input-artifact-binding-invalid");
  const bindings = value.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["artifactId", "artifactVersion", "contentSha256"])
      || typeof item.artifactId !== "string" || !item.artifactId.trim() || item.artifactId.length > 160
      || !Number.isSafeInteger(item.artifactVersion) || Number(item.artifactVersion) < 1
      || typeof item.contentSha256 !== "string" || !SHA256_RE.test(item.contentSha256)) {
      throw new Error("science-statistics-input-artifact-binding-invalid");
    }
    return { artifactId: item.artifactId, artifactVersion: Number(item.artifactVersion), contentSha256: item.contentSha256 };
  });
  if (new Set(bindings.map((item) => `${item.artifactId}:${item.artifactVersion}`)).size !== bindings.length) throw new Error("science-statistics-input-artifact-binding-duplicate");
  return bindings;
}

function validateFrozenPlanBinding(value: unknown, method: string): ScienceStatisticsFrozenPlanBinding {
  const plan = record(value);
  if (!plan || !exactKeys(plan, ["analysisSpecId", "version", "contentSha256", "status", "plannedMethodToken", "model", "modelSha256"])
    || typeof plan.analysisSpecId !== "string" || !plan.analysisSpecId.trim() || plan.analysisSpecId.length > 160
    || !Number.isSafeInteger(plan.version) || Number(plan.version) < 1 || plan.status !== "frozen"
    || typeof plan.contentSha256 !== "string" || !SHA256_RE.test(plan.contentSha256)
    || plan.plannedMethodToken !== `agentlas.statistics.method:${method}`
    || typeof plan.modelSha256 !== "string" || !SHA256_RE.test(plan.modelSha256)) throw new Error("science-statistics-analysis-plan-binding-invalid");
  const model = record(plan.model);
  if (!model || !exactKeys(model, ["family", "formula", "distribution", "link", "groupingVariables", "randomEffects", "rationale"])
    || !SCIENCE_ANALYSIS_MODEL_FAMILIES.includes(String(model.family) as ScienceAnalysisModelSpec["family"])
    || typeof model.formula !== "string" || !model.formula.trim() || typeof model.rationale !== "string" || !model.rationale.trim()
    || (model.distribution !== null && typeof model.distribution !== "string") || (model.link !== null && typeof model.link !== "string")
    || !Array.isArray(model.groupingVariables) || !model.groupingVariables.every((item) => typeof item === "string")
    || !Array.isArray(model.randomEffects) || !model.randomEffects.every((item) => typeof item === "string")
    || scienceStatisticsSha256(model) !== plan.modelSha256) throw new Error("science-statistics-analysis-model-binding-invalid");
  if (!scienceStatisticsMethodMatchesAnalysisModel(method, model)) throw new Error("science-statistics-analysis-method-model-mismatch");
  return {
    analysisSpecId: plan.analysisSpecId, version: Number(plan.version), contentSha256: plan.contentSha256, status: "frozen",
    plannedMethodToken: plan.plannedMethodToken, model: model as unknown as ScienceAnalysisModelSpec, modelSha256: plan.modelSha256,
  };
}

/** Structural and hash validation for the binding copied into the run input and artifact. */
export function validateScienceStatisticsExecutionBinding(value: unknown, method: string): ScienceStatisticsExecutionBinding {
  const binding = record(value);
  if (!binding || !exactKeys(binding, ["schema", "purpose", "inputArtifacts", "analysisPlan", "bindingSha256"])
    || binding.schema !== SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA
    || !["descriptive", "exploratory", "confirmatory"].includes(String(binding.purpose))
    || typeof binding.bindingSha256 !== "string" || !SHA256_RE.test(binding.bindingSha256)) throw new Error("science-statistics-execution-binding-invalid");
  const purpose = binding.purpose as ScienceStatisticsPurpose;
  const inputArtifacts = validateInputArtifactBindings(binding.inputArtifacts);
  const analysisPlan = purpose === "confirmatory"
    ? validateFrozenPlanBinding(binding.analysisPlan, method)
    : binding.analysisPlan === null ? null : (() => { throw new Error("science-statistics-analysis-plan-forbidden"); })();
  if (purpose === "confirmatory" && inputArtifacts.length < 1) throw new Error("science-statistics-confirmatory-input-binding-required");
  const core = { schema: SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA, purpose, inputArtifacts, analysisPlan };
  if (scienceStatisticsSha256(core) !== binding.bindingSha256) throw new Error("science-statistics-execution-binding-hash-invalid");
  return { ...core, bindingSha256: binding.bindingSha256 };
}

function safeText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}

function validateTableArtifact(value: unknown): ScienceStatisticsTableArtifact {
  const artifact = record(value);
  if (!artifact || !exactKeys(artifact, ["kind", "role", "schema", "payload"])
    || artifact.kind !== "table" || artifact.schema !== SCIENCE_STATISTICS_TABLE_SCHEMA) throw new Error("science-statistics-table-artifact-invalid");
  const payload = record(artifact.payload);
  if (!payload || !exactKeys(payload, ["schema", "title", "caption", "columns", "rows", "notes"])
    || payload.schema !== SCIENCE_STATISTICS_TABLE_SCHEMA || !Array.isArray(payload.columns) || !Array.isArray(payload.rows) || !Array.isArray(payload.notes)
    || payload.columns.length < 1 || payload.columns.length > 256 || payload.rows.length > 10_000) throw new Error("science-statistics-table-payload-invalid");
  const columns = payload.columns.map((entry) => {
    const column = record(entry);
    if (!column || !exactKeys(column, ["key", "label", "type"]) || !["string", "number", "boolean"].includes(String(column.type))) throw new Error("science-statistics-table-column-invalid");
    return { key: safeText(column.key, 128, "science-statistics-table-column-invalid"), label: safeText(column.label, 256, "science-statistics-table-column-invalid"), type: column.type as ScienceStatisticsTableColumn["type"] };
  });
  if (new Set(columns.map((column) => column.key)).size !== columns.length) throw new Error("science-statistics-table-column-duplicate");
  const keys = new Set(columns.map((column) => column.key));
  const rows = payload.rows.map((entry) => {
    const row = record(entry);
    if (!row || Object.keys(row).some((key) => !keys.has(key))) throw new Error("science-statistics-table-row-invalid");
    const normalized: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      const cell = row[column.key] ?? null;
      if (cell !== null && typeof cell !== column.type) throw new Error("science-statistics-table-cell-invalid");
      if (typeof cell === "number" && !Number.isFinite(cell)) throw new Error("science-statistics-table-cell-invalid");
      if (typeof cell === "string" && (Buffer.byteLength(cell, "utf8") > 16 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cell))) throw new Error("science-statistics-table-cell-invalid");
      normalized[column.key] = cell as string | number | boolean | null;
    }
    return normalized;
  });
  return {
    kind: "table", role: safeText(artifact.role, 160, "science-statistics-table-role-invalid"), schema: SCIENCE_STATISTICS_TABLE_SCHEMA,
    payload: {
      schema: SCIENCE_STATISTICS_TABLE_SCHEMA,
      title: safeText(payload.title, 500, "science-statistics-table-title-invalid"),
      caption: safeText(payload.caption, 4_000, "science-statistics-table-caption-invalid"),
      columns, rows,
      notes: payload.notes.map((note) => safeText(note, 2_000, "science-statistics-table-note-invalid")),
    },
  };
}

/** Validates the exact statistics result, its receipt chain, and local-only compiled visualizations. */
export function validateScienceStatisticsAnalysisPayload(value: unknown): ScienceStatisticsAnalysisArtifactPayload {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024 * 1024) throw new Error("science-statistics-artifact-size-limit");
  const payload = record(value);
  const hasProjectionReceipt = Boolean(payload && Object.hasOwn(payload, "projectionReceipt"));
  const expectedPayloadKeys = ["schema", "inputSha256", "method", "executionBinding", "executionReceipt", "result", "selectedTableIndex", "visualizations"];
  if (hasProjectionReceipt) expectedPayloadKeys.push("projectionReceipt");
  if (!payload || !exactKeys(payload, expectedPayloadKeys)
    || payload.schema !== SCIENCE_STATISTICS_ARTIFACT_SCHEMA || typeof payload.inputSha256 !== "string" || !SHA256_RE.test(payload.inputSha256)
    || !METHODS.has(String(payload.method)) || !Number.isSafeInteger(payload.selectedTableIndex) || !Array.isArray(payload.visualizations)) {
    throw new Error("science-statistics-artifact-invalid");
  }
  const result = record(payload.result);
  if (!result || result.schema !== SCIENCE_STATISTICS_RESULT_SCHEMA || result.method !== payload.method || result.status !== "ok"
    || !Array.isArray(result.artifacts) || !Array.isArray(result.artifactReceipts) || typeof result.resultHash !== "string" || !STATISTICS_SHA256_RE.test(result.resultHash)) {
    throw new Error("science-statistics-result-invalid");
  }
  const executionBinding = validateScienceStatisticsExecutionBinding(payload.executionBinding, String(payload.method));
  const projectionReceipt = hasProjectionReceipt
    ? validateScienceStatisticsDataTableProjectionReceipt(payload.projectionReceipt)
    : null;
  if (!projectionReceipt && executionBinding.inputArtifacts.length > 0) {
    throw new Error("science-statistics-inline-artifact-binding-forbidden");
  }
  if (projectionReceipt && ((projectionReceipt.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA && payload.method !== "kaplan_meier")
    || (projectionReceipt.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA && payload.method !== projectionReceipt.method)
    || executionBinding.inputArtifacts.length !== 1
    || scienceStatisticsSha256(executionBinding.inputArtifacts[0]) !== scienceStatisticsSha256(projectionReceipt.sourceArtifact))) {
    throw new Error("science-statistics-data-table-projection-binding-invalid");
  }
  const resultArtifacts = result.artifacts as unknown[];
  const resultArtifactReceipts = result.artifactReceipts as unknown[];
  const engine = record(result.engine);
  if (!engine || !exactKeys(engine, ["id", "version", "algorithmRevision"]) || engine.id !== "agentlas-science-statistics"
    || engine.version !== SCIENCE_STATISTICS_TOOL_VERSION || engine.algorithmRevision !== "gaussian-random-intercept-lmm-v9-js-2026-09-01") throw new Error("science-statistics-engine-invalid");
  if (typeof result.requestHash !== "string" || !STATISTICS_SHA256_RE.test(result.requestHash) || resultArtifacts.length < 1 || resultArtifacts.length > 32
    || resultArtifactReceipts.length !== resultArtifacts.length) throw new Error("science-statistics-result-invalid");
  const artifactReceipts = resultArtifactReceipts.map((entry, index) => {
    const receipt = record(entry);
    const artifact = resultArtifacts[index];
    if (!receipt || !exactKeys(receipt, ["index", "kind", "role", "sha256", "bytes"]) || receipt.index !== index
      || typeof receipt.sha256 !== "string" || !STATISTICS_SHA256_RE.test(receipt.sha256) || receipt.sha256 !== `sha256:${scienceStatisticsSha256(artifact)}`
      || receipt.bytes !== Buffer.byteLength(JSON.stringify(canonicalValue(artifact)), "utf8")) throw new Error("science-statistics-artifact-receipt-invalid");
    return receipt as { index: number; kind: string; role: string; sha256: string; bytes: number };
  });
  const tableIndexes = resultArtifacts.flatMap((artifact, index) => record(artifact)?.kind === "table" ? [index] : []);
  if (!tableIndexes.includes(Number(payload.selectedTableIndex))) throw new Error("science-statistics-selected-table-invalid");
  validateTableArtifact(resultArtifacts[Number(payload.selectedTableIndex)]);
  for (const index of tableIndexes) validateTableArtifact(resultArtifacts[index]);
  const artifactsForRole = (role: string): JsonRecord[] => resultArtifacts.flatMap((artifact) => {
    const item = record(artifact);
    return item?.role === role ? [item] : [];
  });
  const exactArtifactForRole = (role: string, kind: string, code: string): JsonRecord => {
    const matches = artifactsForRole(role);
    if (matches.length !== 1 || matches[0].kind !== kind) throw new Error(code);
    return matches[0];
  };
  const tableRowsForRole = (role: string, code: string): unknown[] => {
    const rows = record(exactArtifactForRole(role, "table", code).payload)?.rows;
    if (!Array.isArray(rows)) throw new Error(code);
    return rows;
  };
  const vegaRowsForRole = (role: string, code: string): unknown[] => {
    const values = record(record(exactArtifactForRole(role, "vega-lite", code).payload)?.data)?.values;
    if (!Array.isArray(values)) throw new Error(code);
    return values;
  };
  if (payload.method === "distribution_fit") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const comparisons = estimates?.comparisons;
    const comparisonRows = tableRowsForRole("distribution-fit-comparison-table", "science-statistics-distribution-fit-renderer-contract-invalid");
    const qqRows = vegaRowsForRole("distribution-fit-qq", "science-statistics-distribution-fit-renderer-contract-invalid");
    const ppRows = vegaRowsForRole("distribution-fit-pp", "science-statistics-distribution-fit-renderer-contract-invalid");
    const figureBindings = rendererContract?.figureBindings;
    const tests = result.tests;
    if (!rendererContract || !exactKeys(rendererContract, [
      "inlineRows", "sampling", "aggregation", "observationCount", "candidateCount", "observationValuesHash",
      "comparisonRowsHash", "qqRowCount", "qqRowsHash", "ppRowCount", "ppRowsHash", "figureBindings",
    ]) || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || !Number.isSafeInteger(rendererContract.observationCount) || Number(rendererContract.observationCount) < 8 || Number(rendererContract.observationCount) > 100_000
      || !Number.isSafeInteger(rendererContract.candidateCount) || Number(rendererContract.candidateCount) < 1 || Number(rendererContract.candidateCount) > 3
      || !Array.isArray(comparisons) || comparisons.length !== rendererContract.candidateCount
      || comparisonRows.length !== rendererContract.candidateCount
      || rendererContract.comparisonRowsHash !== `sha256:${scienceStatisticsSha256(comparisonRows)}`
      || rendererContract.qqRowCount !== Number(rendererContract.observationCount) * Number(rendererContract.candidateCount)
      || rendererContract.ppRowCount !== Number(rendererContract.observationCount) * Number(rendererContract.candidateCount)
      || qqRows.length !== rendererContract.qqRowCount || ppRows.length !== rendererContract.ppRowCount
      || rendererContract.qqRowsHash !== `sha256:${scienceStatisticsSha256(qqRows)}`
      || rendererContract.ppRowsHash !== `sha256:${scienceStatisticsSha256(ppRows)}`
      || !Array.isArray(figureBindings) || figureBindings.length !== 2
      || scienceStatisticsSha256(figureBindings) !== scienceStatisticsSha256([
        { templateId: "distribution-fit-qq", artifactRole: "distribution-fit-qq", rowsHash: rendererContract.qqRowsHash },
        { templateId: "distribution-fit-pp", artifactRole: "distribution-fit-pp", rowsHash: rendererContract.ppRowsHash },
      ])
      || !Array.isArray(tests) || tests.length !== rendererContract.candidateCount
      || tests.some((item) => record(item)?.pValue !== null || record(item)?.decision !== null
        || record(item)?.pValueStatus !== "not-reported-parameters-estimated")) {
      throw new Error("science-statistics-distribution-fit-renderer-contract-invalid");
    }
  }
  if (payload.method === "welch_one_way_anova") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const estimateRows = estimates?.groupSummaries;
    const tableRows = tableRowsForRole("welch-group-summary-table", "science-statistics-welch-renderer-contract-invalid");
    const vegaRows = vegaRowsForRole("estimate-plot", "science-statistics-welch-renderer-contract-invalid");
    if (!rendererContract || !exactKeys(rendererContract, ["inlineRows", "sampling", "aggregation", "rowCount", "groupSummaryRowsHash", "tableRole", "vegaRole"])
      || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || rendererContract.tableRole !== "welch-group-summary-table" || rendererContract.vegaRole !== "estimate-plot"
      || !Array.isArray(estimateRows) || estimateRows.length < 2 || rendererContract.rowCount !== estimateRows.length
      || rendererContract.groupSummaryRowsHash !== `sha256:${scienceStatisticsSha256(estimateRows)}`
      || scienceStatisticsSha256(tableRows) !== scienceStatisticsSha256(vegaRows)
      || scienceStatisticsSha256(tableRows) !== scienceStatisticsSha256(estimateRows)) {
      throw new Error("science-statistics-welch-renderer-contract-invalid");
    }
  }
  if (payload.method === "friedman_test") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const estimateRows = estimates?.conditionRanks;
    const tableRows = tableRowsForRole("friedman-rank-summary-table", "science-statistics-friedman-renderer-contract-invalid");
    const vegaRows = vegaRowsForRole("paired-rank-profile", "science-statistics-friedman-renderer-contract-invalid");
    if (!rendererContract || !exactKeys(rendererContract, ["inlineRows", "sampling", "aggregation", "rowCount", "conditionRankRowsHash", "tableRole", "vegaRole"])
      || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || rendererContract.tableRole !== "friedman-rank-summary-table" || rendererContract.vegaRole !== "paired-rank-profile"
      || !Array.isArray(estimateRows) || estimateRows.length < 3 || rendererContract.rowCount !== estimateRows.length
      || rendererContract.conditionRankRowsHash !== `sha256:${scienceStatisticsSha256(estimateRows)}`
      || scienceStatisticsSha256(tableRows) !== scienceStatisticsSha256(vegaRows)
      || scienceStatisticsSha256(tableRows) !== scienceStatisticsSha256(estimateRows)) {
      throw new Error("science-statistics-friedman-renderer-contract-invalid");
    }
  }
  if (payload.method === "roc_curve_analysis") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const estimateThresholdRows = estimates?.thresholdRows;
    const thresholdRows = tableRowsForRole("roc-threshold-table", "science-statistics-roc-renderer-contract-invalid");
    const observationRows = tableRowsForRole("roc-observation-table", "science-statistics-roc-renderer-contract-invalid");
    const rocRows = vegaRowsForRole("roc-curve", "science-statistics-roc-renderer-contract-invalid");
    const precisionRecallRows = vegaRowsForRole("precision-recall-curve", "science-statistics-roc-renderer-contract-invalid");
    const firstThreshold = record(thresholdRows[0]);
    const positiveCount = Number(firstThreshold?.truePositive) + Number(firstThreshold?.falseNegative);
    const negativeCount = Number(firstThreshold?.falsePositive) + Number(firstThreshold?.trueNegative);
    const syntheticOrigin = {
      threshold: null,
      truePositive: 0,
      falsePositive: 0,
      trueNegative: negativeCount,
      falseNegative: positiveCount,
      sensitivity: 0,
      specificity: 1,
      falsePositiveRate: 0,
      precision: 1,
      recall: 0,
    };
    if (!rendererContract || !exactKeys(rendererContract, [
      "inlineRows", "sampling", "aggregation", "thresholdRowCount", "thresholdRowsHash", "observationRowCount", "observationRowsHash",
    ]) || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "tie-aware score blocks only"
      || !Array.isArray(estimateThresholdRows) || thresholdRows.length < 1 || observationRows.length < 4
      || rendererContract.thresholdRowCount !== thresholdRows.length || rendererContract.observationRowCount !== observationRows.length
      || rendererContract.thresholdRowsHash !== `sha256:${scienceStatisticsSha256(thresholdRows)}`
      || rendererContract.observationRowsHash !== `sha256:${scienceStatisticsSha256(observationRows)}`
      || scienceStatisticsSha256(estimateThresholdRows) !== scienceStatisticsSha256(thresholdRows)
      || scienceStatisticsSha256(precisionRecallRows) !== scienceStatisticsSha256(thresholdRows)
      || !Number.isSafeInteger(positiveCount) || positiveCount < 1 || !Number.isSafeInteger(negativeCount) || negativeCount < 1
      || scienceStatisticsSha256(rocRows) !== scienceStatisticsSha256([syntheticOrigin, ...thresholdRows])) {
      throw new Error("science-statistics-roc-renderer-contract-invalid");
    }
  }
  if (payload.method === "poisson_regression") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const fittedTableArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "fitted-mean-table");
    const fittedVegaArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "observed-fitted-plot");
    const fittedTableRows = record(record(fittedTableArtifact)?.payload)?.rows;
    const fittedVegaRows = record(record(record(fittedVegaArtifact)?.payload)?.data)?.values;
    const fittedMeans = Array.isArray(estimates?.fittedMeans) ? estimates.fittedMeans : null;
    if (!rendererContract || !exactKeys(rendererContract, ["rowCount", "fittedRowsHash", "inlineRows", "tableRole", "vegaRole"])
      || rendererContract.inlineRows !== "all" || rendererContract.tableRole !== "fitted-mean-table" || rendererContract.vegaRole !== "observed-fitted-plot"
      || !Number.isSafeInteger(rendererContract.rowCount) || Number(rendererContract.rowCount) < 1 || Number(rendererContract.rowCount) > 5_000
      || typeof rendererContract.fittedRowsHash !== "string" || !STATISTICS_SHA256_RE.test(rendererContract.fittedRowsHash)
      || !fittedMeans || !Array.isArray(fittedTableRows) || !Array.isArray(fittedVegaRows)
      || fittedTableRows.length !== rendererContract.rowCount || fittedVegaRows.length !== rendererContract.rowCount
      || `sha256:${scienceStatisticsSha256(fittedTableRows)}` !== rendererContract.fittedRowsHash
      || scienceStatisticsSha256(fittedTableRows) !== scienceStatisticsSha256(fittedVegaRows)
      || fittedMeans.length !== rendererContract.rowCount
      || fittedTableRows.some((row, index) => record(row)?.fittedMean !== fittedMeans[index])) {
      throw new Error("science-statistics-poisson-renderer-contract-invalid");
    }
  }
  if (payload.method === "principal_component_analysis") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const requiredTableRoles = ["pca-variance-table", "pca-loading-table", "pca-score-table"];
    const requiredVegaRoles = ["pca-scree-plot", "pca-score-plot", "pca-loading-heatmap"];
    const scoreArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "pca-score-table");
    const scoreRows = record(record(scoreArtifact)?.payload)?.rows;
    const scoreVegaArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "pca-score-plot");
    const scoreVegaRows = record(record(scoreVegaArtifact)?.payload)?.data;
    const inlineScoreRows = record(scoreVegaRows)?.values;
    if (!rendererContract || !exactKeys(rendererContract, ["inlineRows", "sampling", "aggregation", "rowCount", "componentScoresHash"])
      || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || !Number.isSafeInteger(rendererContract.rowCount) || Number(rendererContract.rowCount) < 3 || Number(rendererContract.rowCount) > 10_000
      || typeof rendererContract.componentScoresHash !== "string" || !STATISTICS_SHA256_RE.test(rendererContract.componentScoresHash)
      || !requiredTableRoles.every((role) => resultArtifacts.some((artifact) => record(artifact)?.kind === "table" && record(artifact)?.role === role))
      || !requiredVegaRoles.every((role) => resultArtifacts.some((artifact) => record(artifact)?.kind === "vega-lite" && record(artifact)?.role === role))
      || !Array.isArray(scoreRows) || !Array.isArray(inlineScoreRows)
      || scoreRows.length !== rendererContract.rowCount || inlineScoreRows.length !== rendererContract.rowCount
      || `sha256:${scienceStatisticsSha256(scoreRows)}` !== rendererContract.componentScoresHash
      || scienceStatisticsSha256(scoreRows) !== scienceStatisticsSha256(inlineScoreRows)) {
      throw new Error("science-statistics-pca-renderer-contract-invalid");
    }
  }
  if (payload.method === "time_series_diagnostics") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const requiredTableRoles = ["time-series-observation-table", "time-series-correlation-table"];
    const requiredVegaRoles = ["time-series-plot", "autocorrelation-plot"];
    const seriesArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "time-series-observation-table");
    const seriesRows = record(record(seriesArtifact)?.payload)?.rows;
    const seriesVegaArtifact = resultArtifacts.find((artifact) => record(artifact)?.role === "time-series-plot");
    const seriesVegaRows = record(record(seriesVegaArtifact)?.payload)?.data;
    const inlineSeriesRows = record(seriesVegaRows)?.values;
    if (!rendererContract || !exactKeys(rendererContract, ["inlineRows", "sampling", "aggregation", "rowCount", "seriesRowsHash"])
      || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || !Number.isSafeInteger(rendererContract.rowCount) || Number(rendererContract.rowCount) < 7 || Number(rendererContract.rowCount) > 10_000
      || typeof rendererContract.seriesRowsHash !== "string" || !STATISTICS_SHA256_RE.test(rendererContract.seriesRowsHash)
      || !requiredTableRoles.every((role) => resultArtifacts.some((artifact) => record(artifact)?.kind === "table" && record(artifact)?.role === role))
      || !requiredVegaRoles.every((role) => resultArtifacts.some((artifact) => record(artifact)?.kind === "vega-lite" && record(artifact)?.role === role))
      || !Array.isArray(seriesRows) || !Array.isArray(inlineSeriesRows)
      || seriesRows.length !== rendererContract.rowCount || inlineSeriesRows.length !== rendererContract.rowCount
      || `sha256:${scienceStatisticsSha256(seriesRows)}` !== rendererContract.seriesRowsHash
      || scienceStatisticsSha256(seriesRows) !== scienceStatisticsSha256(inlineSeriesRows)) {
      throw new Error("science-statistics-time-series-renderer-contract-invalid");
    }
  }
  if (payload.method === "meta_analysis") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const estimateStudyRows = estimates?.studyRows;
    const estimateLeaveRows = estimates?.leaveOneOut;
    const studyRows = tableRowsForRole("meta-study-table", "science-statistics-meta-renderer-contract-invalid");
    const leaveRows = tableRowsForRole("meta-leave-one-out-table", "science-statistics-meta-renderer-contract-invalid");
    const forestRows = vegaRowsForRole("meta-analysis-forest", "science-statistics-meta-renderer-contract-invalid");
    const funnelRows = vegaRowsForRole("meta-analysis-funnel", "science-statistics-meta-renderer-contract-invalid");
    const influenceRows = vegaRowsForRole("meta-analysis-influence", "science-statistics-meta-renderer-contract-invalid");
    const influenceMatchesLeaveOut = Array.isArray(estimateLeaveRows) && influenceRows.every((row, index) => {
      const influence = record(row);
      const leave = record(estimateLeaveRows[index]);
      return influence && leave
        && influence.omittedStudy === leave.omittedStudy
        && influence.fixedEffect === leave.fixedEffect
        && influence.randomEffect === leave.randomEffect
        && influence.deltaFixed === leave.deltaFixed
        && influence.deltaRandom === leave.deltaRandom
        && influence.tauSquared === leave.tauSquared
        && influence.q === leave.q;
    });
    if (!rendererContract || !exactKeys(rendererContract, [
      "inlineRows", "sampling", "aggregation",
      "studyRowCount", "forestRowCount", "funnelRowCount", "influenceRowCount",
      "studyRowsHash", "forestRowsHash", "funnelRowsHash", "influenceRowsHash",
    ]) || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none"
      || rendererContract.aggregation !== "declared inverse-variance pooling only"
      || !Number.isSafeInteger(rendererContract.studyRowCount) || Number(rendererContract.studyRowCount) < 2 || Number(rendererContract.studyRowCount) > 1_000
      || rendererContract.forestRowCount !== Number(rendererContract.studyRowCount) + 2
      || rendererContract.funnelRowCount !== rendererContract.studyRowCount
      || rendererContract.influenceRowCount !== rendererContract.studyRowCount
      || !Array.isArray(estimateStudyRows) || !Array.isArray(estimateLeaveRows)
      || studyRows.length !== rendererContract.studyRowCount || leaveRows.length !== rendererContract.influenceRowCount
      || forestRows.length !== rendererContract.forestRowCount || funnelRows.length !== rendererContract.funnelRowCount || influenceRows.length !== rendererContract.influenceRowCount
      || rendererContract.studyRowsHash !== `sha256:${scienceStatisticsSha256(studyRows)}`
      || rendererContract.forestRowsHash !== `sha256:${scienceStatisticsSha256(forestRows)}`
      || rendererContract.funnelRowsHash !== `sha256:${scienceStatisticsSha256(funnelRows)}`
      || rendererContract.influenceRowsHash !== `sha256:${scienceStatisticsSha256(influenceRows)}`
      || scienceStatisticsSha256(studyRows) !== scienceStatisticsSha256(estimateStudyRows)
      || scienceStatisticsSha256(leaveRows) !== scienceStatisticsSha256(estimateLeaveRows)
      || !influenceMatchesLeaveOut
      || !resultArtifacts.some((artifact) => record(artifact)?.kind === "table" && record(artifact)?.role === "meta-summary-table")) {
      throw new Error("science-statistics-meta-renderer-contract-invalid");
    }
  }
  if (payload.method === "gaussian_random_intercept_lmm") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const fixedRows = tableRowsForRole("lmm-fixed-effects-table", "science-statistics-lmm-renderer-contract-invalid");
    const groupRows = tableRowsForRole("lmm-group-effects-table", "science-statistics-lmm-renderer-contract-invalid");
    const observationRows = tableRowsForRole("lmm-observation-diagnostics-table", "science-statistics-lmm-renderer-contract-invalid");
    const fixedFigureRows = vegaRowsForRole("lmm-fixed-effects-plot", "science-statistics-lmm-renderer-contract-invalid");
    const profileRows = vegaRowsForRole("lmm-marginal-mean-profile", "science-statistics-lmm-renderer-contract-invalid");
    const trajectoryRows = vegaRowsForRole("lmm-subject-trajectory-plot", "science-statistics-lmm-renderer-contract-invalid");
    const randomRows = vegaRowsForRole("lmm-random-intercept-plot", "science-statistics-lmm-renderer-contract-invalid");
    const diagnostics = exactArtifactForRole("lmm-diagnostic-grid", "vega-lite", "science-statistics-lmm-renderer-contract-invalid");
    const diagnosticPanels = record(diagnostics.payload)?.vconcat;
    if (!rendererContract || !exactKeys(rendererContract, [
      "inlineRows", "sampling", "aggregation", "fixedEffectRows", "groupEffectRows", "observationRows", "profileRows",
      "fixedRowsHash", "groupRowsHash", "observationRowsHash", "profileRowsHash",
    ]) || rendererContract.inlineRows !== "all" || rendererContract.sampling !== "none" || rendererContract.aggregation !== "none"
      || rendererContract.fixedEffectRows !== fixedRows.length || rendererContract.groupEffectRows !== groupRows.length
      || rendererContract.observationRows !== observationRows.length || rendererContract.profileRows !== profileRows.length
      || rendererContract.fixedRowsHash !== `sha256:${scienceStatisticsSha256(fixedRows)}`
      || rendererContract.groupRowsHash !== `sha256:${scienceStatisticsSha256(groupRows)}`
      || rendererContract.observationRowsHash !== `sha256:${scienceStatisticsSha256(observationRows)}`
      || rendererContract.profileRowsHash !== `sha256:${scienceStatisticsSha256(profileRows)}`
      || scienceStatisticsSha256(fixedFigureRows) !== scienceStatisticsSha256(fixedRows)
      || scienceStatisticsSha256(randomRows) !== scienceStatisticsSha256(groupRows)
      || scienceStatisticsSha256(trajectoryRows) !== scienceStatisticsSha256(observationRows)
      || !Array.isArray(diagnosticPanels) || diagnosticPanels.length !== 3
      || !resultArtifacts.some((artifact) => record(artifact)?.role === "lmm-model-summary-table")
      || !resultArtifacts.some((artifact) => record(artifact)?.role === "lmm-variance-components-table")) {
      throw new Error("science-statistics-lmm-renderer-contract-invalid");
    }
  }
  if (payload.method === "response_surface_regression") {
    const estimates = record(result.estimates);
    const rendererContract = record(estimates?.rendererDataContract);
    const sourceArtifact = exactArtifactForRole(
      "response-surface-grid",
      "numeric-surface",
      "science-statistics-response-surface-renderer-contract-invalid",
    );
    const sourcePayload = validateScienceStatisticsNumericSurfaceSourcePayload(sourceArtifact.payload);
    const coefficientRows = tableRowsForRole(
      "response-surface-coefficient-table",
      "science-statistics-response-surface-renderer-contract-invalid",
    );
    const observationRows = tableRowsForRole(
      "response-surface-observation-table",
      "science-statistics-response-surface-renderer-contract-invalid",
    );
    const modelSha256 = scienceStatisticsSha256({
      model: sourcePayload.model,
      coefficients: coefficientRows,
      coding: estimates?.coding,
    });
    const outputSha256 = scienceStatisticsSha256({
      modelSha256,
      coefficientRowsSha256: scienceStatisticsSha256(coefficientRows),
      observationRowsSha256: scienceStatisticsSha256(observationRows),
      gridSha256: sourcePayload.grid.gridSha256,
      supportMaskSha256: sourcePayload.grid.supportMaskSha256,
      pointsSha256: sourcePayload.observations.pointsSha256,
      hullSha256: sourcePayload.support.hullSha256,
      supportReceiptSha256: sourcePayload.support.receiptSha256,
    });
    if (!rendererContract || !exactKeys(rendererContract, [
      "schema", "sourceArtifactSchema", "destinationPayloadSchema", "destinationRendererId", "destinationRendererVersion",
      "inputSha256", "modelSha256", "outputSha256", "coefficientRowsSha256", "observationRowsSha256",
      "gridSha256", "supportMaskSha256", "pointsSha256", "hullSha256", "supportReceiptSha256",
      "gridSize", "valueCount", "supportedValueCount", "sampling", "extrapolation", "sourceArtifactRole",
    ])
      || sourceArtifact.schema !== SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA
      || rendererContract.schema !== "agentlas.science.statistics-numeric-surface-lineage/v1"
      || rendererContract.sourceArtifactSchema !== SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA
      || rendererContract.destinationPayloadSchema !== "agentlas.science.numeric-surface-artifact/v2"
      || rendererContract.destinationRendererId !== "agentlas.three-numeric"
      || rendererContract.destinationRendererVersion !== "1.0.0"
      || rendererContract.sourceArtifactRole !== "response-surface-grid"
      || rendererContract.sampling !== "none"
      || rendererContract.extrapolation !== "masked-outside-observed-convex-hull"
      || rendererContract.modelSha256 !== modelSha256
      || rendererContract.outputSha256 !== outputSha256
      || rendererContract.coefficientRowsSha256 !== scienceStatisticsSha256(coefficientRows)
      || rendererContract.observationRowsSha256 !== scienceStatisticsSha256(observationRows)
      || rendererContract.gridSha256 !== sourcePayload.grid.gridSha256
      || rendererContract.supportMaskSha256 !== sourcePayload.grid.supportMaskSha256
      || rendererContract.pointsSha256 !== sourcePayload.observations.pointsSha256
      || rendererContract.hullSha256 !== sourcePayload.support.hullSha256
      || rendererContract.supportReceiptSha256 !== sourcePayload.support.receiptSha256
      || rendererContract.gridSize !== sourcePayload.grid.x.length
      || sourcePayload.grid.x.length !== sourcePayload.grid.y.length
      || rendererContract.valueCount !== sourcePayload.grid.valueCount
      || rendererContract.supportedValueCount !== sourcePayload.grid.supportedValueCount
      || typeof rendererContract.inputSha256 !== "string" || !SHA256_RE.test(rendererContract.inputSha256)) {
      throw new Error("science-statistics-response-surface-renderer-contract-invalid");
    }
  }
  const resultCore = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resultHash" && key !== "receipt"));
  if (`sha256:${scienceStatisticsSha256(resultCore)}` !== result.resultHash) throw new Error("science-statistics-result-hash-invalid");
  const inferenceReceipt = record(result.inferenceReceipt);
  if (!inferenceReceipt || !exactKeys(inferenceReceipt, ["schema", "effectSizesHash", "assumptionsHash", "diagnosticsHash"])
    || inferenceReceipt.schema !== "agentlas.science.statistics.inference-receipt/v1"
    || !Array.isArray(result.effectSizes) || !Array.isArray(result.assumptions) || !Array.isArray(result.diagnostics)
    || inferenceReceipt.effectSizesHash !== `sha256:${scienceStatisticsSha256(result.effectSizes)}`
    || inferenceReceipt.assumptionsHash !== `sha256:${scienceStatisticsSha256(result.assumptions)}`
    || inferenceReceipt.diagnosticsHash !== `sha256:${scienceStatisticsSha256(result.diagnostics)}`) throw new Error("science-statistics-inference-receipt-invalid");
  const receipt = record(result.receipt);
  if (!receipt || !exactKeys(receipt, ["schema", "engine", "method", "requestHash", "resultHash", "artifactReceipts", "inferenceReceipt", "receiptId"])
    || receipt.schema !== SCIENCE_STATISTICS_RECEIPT_SCHEMA || receipt.method !== result.method || receipt.requestHash !== result.requestHash
    || receipt.resultHash !== result.resultHash || scienceStatisticsSha256(receipt.artifactReceipts) !== scienceStatisticsSha256(artifactReceipts)
    || scienceStatisticsSha256(receipt.inferenceReceipt) !== scienceStatisticsSha256(inferenceReceipt)
    || typeof receipt.receiptId !== "string" || !STATISTICS_SHA256_RE.test(receipt.receiptId)) throw new Error("science-statistics-receipt-invalid");
  const receiptCore = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptId"));
  if (`sha256:${scienceStatisticsSha256(receiptCore)}` !== receipt.receiptId) throw new Error("science-statistics-receipt-hash-invalid");
  const executionReceipt = record(payload.executionReceipt);
  const expectedExecutionReceiptKeys = ["schema", "inputSha256", "engineRequestHash", "executionBindingSha256", "visualizationsSha256", "receiptSha256"];
  if (projectionReceipt) expectedExecutionReceiptKeys.push("projectionReceiptSha256");
  if (!executionReceipt || !exactKeys(executionReceipt, expectedExecutionReceiptKeys)
    || executionReceipt.schema !== SCIENCE_STATISTICS_EXECUTION_RECEIPT_SCHEMA || executionReceipt.inputSha256 !== payload.inputSha256
    || executionReceipt.engineRequestHash !== result.requestHash || executionReceipt.executionBindingSha256 !== executionBinding.bindingSha256
    || typeof executionReceipt.visualizationsSha256 !== "string" || !SHA256_RE.test(executionReceipt.visualizationsSha256)
    || executionReceipt.visualizationsSha256 !== scienceStatisticsSha256(payload.visualizations)
    || (projectionReceipt !== null && executionReceipt.projectionReceiptSha256 !== projectionReceipt.receiptSha256)
    || typeof executionReceipt.receiptSha256 !== "string" || !SHA256_RE.test(executionReceipt.receiptSha256)) throw new Error("science-statistics-execution-receipt-invalid");
  const executionReceiptCore = Object.fromEntries(Object.entries(executionReceipt).filter(([key]) => key !== "receiptSha256"));
  if (scienceStatisticsSha256(executionReceiptCore) !== executionReceipt.receiptSha256) throw new Error("science-statistics-execution-receipt-hash-invalid");
  const visualizations = payload.visualizations.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["sourceArtifactIndex", "sourceArtifactSha256", "sourceSpecSha256", "role", "title"])
      || !Number.isSafeInteger(item.sourceArtifactIndex) || Number(item.sourceArtifactIndex) < 0 || Number(item.sourceArtifactIndex) >= resultArtifacts.length
      || typeof item.sourceArtifactSha256 !== "string" || item.sourceArtifactSha256 !== artifactReceipts[Number(item.sourceArtifactIndex)]?.sha256
      || typeof item.sourceSpecSha256 !== "string" || !SHA256_RE.test(item.sourceSpecSha256)
      || record(resultArtifacts[Number(item.sourceArtifactIndex)])?.kind !== "vega-lite") throw new Error("science-statistics-visualization-binding-invalid");
    const sourceArtifact = record(resultArtifacts[Number(item.sourceArtifactIndex)]);
    const sourceArtifactPayload = record(sourceArtifact?.payload);
    const serializedSourceSpec = JSON.stringify(sourceArtifactPayload);
    if (!sourceArtifactPayload || item.role !== sourceArtifact?.role
      || scienceStatisticsSha256(sourceArtifactPayload) !== item.sourceSpecSha256
      || Buffer.byteLength(serializedSourceSpec, "utf8") > 8 * 1024 * 1024
      || /\bhttps?:\/\//u.test(serializedSourceSpec.replaceAll("https://vega.github.io/schema/vega-lite/v6.json", ""))) {
      throw new Error("science-statistics-visualization-invalid");
    }
    return {
      sourceArtifactIndex: Number(item.sourceArtifactIndex), sourceArtifactSha256: item.sourceArtifactSha256,
      sourceSpecSha256: item.sourceSpecSha256,
      role: safeText(item.role, 160, "science-statistics-visualization-role-invalid"), title: safeText(item.title, 500, "science-statistics-visualization-title-invalid"),
    };
  });
  return {
    schema: SCIENCE_STATISTICS_ARTIFACT_SCHEMA,
    inputSha256: payload.inputSha256,
    method: String(payload.method),
    executionBinding,
    executionReceipt: executionReceipt as unknown as ScienceStatisticsExecutionReceipt,
    ...(projectionReceipt ? { projectionReceipt } : {}),
    result: result as ScienceStatisticsAnalysisArtifactPayload["result"],
    selectedTableIndex: Number(payload.selectedTableIndex),
    visualizations,
  };
}

/**
 * Validates the renderer payload of a materialized statistics Figure. Database
 * scope and parent-version closure are intentionally verified by ScienceStore;
 * this parser proves the payload is self-consistent and publication-spec bound.
 */
export function validateScienceStatisticsFigureArtifactPayload(value: unknown): ScienceStatisticsFigureArtifactPayload {
  const payload = record(value);
  if (!payload || !exactKeys(payload, [
    "schema", "statisticsArtifact", "method", "visualization", "sourceSpec", "originalSpecSha256", "spec", "figureSpec",
  ]) || payload.schema !== SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA || !METHODS.has(String(payload.method))) {
    throw new Error("science-statistics-figure-artifact-invalid");
  }
  const parent = record(payload.statisticsArtifact);
  if (!parent || !exactKeys(parent, ["artifactId", "artifactVersion", "contentSha256"])
    || typeof parent.artifactId !== "string" || !parent.artifactId.trim() || parent.artifactId.length > 160
    || !Number.isSafeInteger(parent.artifactVersion) || Number(parent.artifactVersion) < 1
    || typeof parent.contentSha256 !== "string" || !SHA256_RE.test(parent.contentSha256)) {
    throw new Error("science-statistics-figure-parent-invalid");
  }
  const visualization = record(payload.visualization);
  if (!visualization || !exactKeys(visualization, [
    "index", "sourceArtifactIndex", "sourceArtifactSha256", "sourceSpecSha256", "role", "title",
  ]) || !Number.isSafeInteger(visualization.index) || Number(visualization.index) < 0 || Number(visualization.index) > 999
    || !Number.isSafeInteger(visualization.sourceArtifactIndex) || Number(visualization.sourceArtifactIndex) < 0 || Number(visualization.sourceArtifactIndex) > 999
    || typeof visualization.sourceArtifactSha256 !== "string" || !STATISTICS_SHA256_RE.test(visualization.sourceArtifactSha256)
    || typeof visualization.sourceSpecSha256 !== "string" || !SHA256_RE.test(visualization.sourceSpecSha256)
    || typeof visualization.role !== "string" || !visualization.role.trim() || visualization.role.length > 160
    || typeof visualization.title !== "string" || !visualization.title.trim() || visualization.title.length > 500) {
    throw new Error("science-statistics-figure-visualization-invalid");
  }
  const sourceSpec = record(payload.sourceSpec);
  const spec = record(payload.spec);
  if (!sourceSpec || !spec || typeof payload.originalSpecSha256 !== "string" || !SHA256_RE.test(payload.originalSpecSha256)
    || scienceStatisticsSha256(sourceSpec) !== visualization.sourceSpecSha256
    || scienceStatisticsSha256(spec) !== payload.originalSpecSha256) {
    throw new Error("science-statistics-figure-spec-invalid");
  }
  const serialized = JSON.stringify({ sourceSpec, spec });
  if (Buffer.byteLength(serialized, "utf8") > 3 * 1024 * 1024
    || /\bhttps?:\/\//u.test(serialized
      .replaceAll("https://vega.github.io/schema/vega-lite/v6.json", "")
      .replaceAll("https://vega.github.io/schema/vega/v6.json", ""))) {
    throw new Error("science-statistics-figure-spec-unsafe");
  }
  const figureSpec = validateScienceFigureSpec(payload.figureSpec);
  if (figureSpec.data.length !== 1 || figureSpec.data[0]?.artifactId !== parent.artifactId
    || figureSpec.data[0]?.artifactVersion !== Number(parent.artifactVersion)
    || figureSpec.data[0]?.artifactContentSha256 !== parent.contentSha256) {
    throw new Error("science-statistics-figure-binding-invalid");
  }
  return {
    schema: SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA,
    statisticsArtifact: {
      artifactId: parent.artifactId,
      artifactVersion: Number(parent.artifactVersion),
      contentSha256: parent.contentSha256,
    },
    method: String(payload.method),
    visualization: {
      index: Number(visualization.index),
      sourceArtifactIndex: Number(visualization.sourceArtifactIndex),
      sourceArtifactSha256: visualization.sourceArtifactSha256,
      sourceSpecSha256: visualization.sourceSpecSha256,
      role: visualization.role.trim(),
      title: visualization.title.trim(),
    },
    sourceSpec,
    originalSpecSha256: payload.originalSpecSha256,
    spec,
    figureSpec,
  };
}

/**
 * Validates a persisted publication raster. The PNG bytes live in the normal
 * artifact capture CAS; this payload closes the physical export profile and
 * the exact parent Figure before the asset can be bound to a manuscript.
 */
export function validateScienceStatisticsFigureRasterArtifactPayload(value: unknown): ScienceStatisticsFigureRasterArtifactPayload {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "figureArtifact", "export", "exportSha256"])
    || payload.schema !== SCIENCE_STATISTICS_FIGURE_RASTER_ARTIFACT_SCHEMA
    || typeof payload.exportSha256 !== "string" || !SHA256_RE.test(payload.exportSha256)) {
    throw new Error("science-statistics-figure-raster-artifact-invalid");
  }
  const parent = record(payload.figureArtifact);
  if (!parent || !exactKeys(parent, ["artifactId", "artifactVersion", "contentSha256"])
    || typeof parent.artifactId !== "string" || !parent.artifactId.trim() || parent.artifactId.length > 160
    || !Number.isSafeInteger(parent.artifactVersion) || Number(parent.artifactVersion) < 1
    || typeof parent.contentSha256 !== "string" || !SHA256_RE.test(parent.contentSha256)) {
    throw new Error("science-statistics-figure-raster-parent-invalid");
  }
  const exported = record(payload.export);
  if (!exported || !exactKeys(exported, [
    "mimeType", "renderer", "sourceSpecSha256", "sourceSvgSha256", "exportProfile", "dpi",
    "widthMm", "heightMm", "width", "height", "colorSpace", "background", "byteSize", "sha256",
  ]) || exported.mimeType !== "image/png"
    || ![300, 600].includes(Number(exported.dpi))
    || exported.exportProfile !== `journal-raster-${Number(exported.dpi)}dpi`
    || typeof exported.widthMm !== "number" || !Number.isFinite(exported.widthMm) || exported.widthMm < 20 || exported.widthMm > 200
    || typeof exported.heightMm !== "number" || !Number.isFinite(exported.heightMm) || exported.heightMm < 10 || exported.heightMm > 400
    || !Number.isSafeInteger(exported.width) || Number(exported.width) < 64 || Number(exported.width) > 50_000
    || !Number.isSafeInteger(exported.height) || Number(exported.height) < 64 || Number(exported.height) > 50_000
    || !Number.isSafeInteger(exported.byteSize) || Number(exported.byteSize) < 24 || Number(exported.byteSize) > 64 * 1024 * 1024
    || exported.colorSpace !== "srgb" || exported.background !== "#ffffff"
    || typeof exported.sourceSpecSha256 !== "string" || !SHA256_RE.test(exported.sourceSpecSha256)
    || typeof exported.sourceSvgSha256 !== "string" || !SHA256_RE.test(exported.sourceSvgSha256)
    || typeof exported.sha256 !== "string" || !SHA256_RE.test(exported.sha256)) {
    throw new Error("science-statistics-figure-raster-export-invalid");
  }
  const renderer = record(exported.renderer);
  if (!renderer || !exactKeys(renderer, ["id", "version"]) || renderer.id !== "agentlas.vega"
    || typeof renderer.version !== "string" || !renderer.version.trim() || renderer.version.length > 64) {
    throw new Error("science-statistics-figure-raster-renderer-invalid");
  }
  const expectedWidth = Number(exported.widthMm) / 25.4 * Number(exported.dpi);
  const expectedHeight = Number(exported.heightMm) / 25.4 * Number(exported.dpi);
  if (Math.abs(Number(exported.width) - expectedWidth) > 1.01 || Math.abs(Number(exported.height) - expectedHeight) > 1.01) {
    throw new Error("science-statistics-figure-raster-physical-dimensions-invalid");
  }
  const core = {
    schema: SCIENCE_STATISTICS_FIGURE_RASTER_ARTIFACT_SCHEMA,
    figureArtifact: {
      artifactId: parent.artifactId,
      artifactVersion: Number(parent.artifactVersion),
      contentSha256: parent.contentSha256,
    },
    export: {
      mimeType: "image/png" as const,
      renderer: { id: "agentlas.vega" as const, version: renderer.version.trim() },
      sourceSpecSha256: exported.sourceSpecSha256,
      sourceSvgSha256: exported.sourceSvgSha256,
      exportProfile: exported.exportProfile as "journal-raster-300dpi" | "journal-raster-600dpi",
      dpi: Number(exported.dpi) as 300 | 600,
      widthMm: Number(exported.widthMm),
      heightMm: Number(exported.heightMm),
      width: Number(exported.width),
      height: Number(exported.height),
      colorSpace: "srgb" as const,
      background: "#ffffff" as const,
      byteSize: Number(exported.byteSize),
      sha256: exported.sha256,
    },
  };
  if (scienceStatisticsSha256(core) !== payload.exportSha256) {
    throw new Error("science-statistics-figure-raster-hash-invalid");
  }
  return { ...core, exportSha256: payload.exportSha256 };
}

/**
 * Validates a persisted publication vector receipt. The exact UTF-8 SVG bytes
 * are stored as the sole output of the vectorizer research run rather than in
 * this JSON payload; ScienceStore closes that CAS output back to this receipt
 * and the immutable parent Figure.
 */
export function validateScienceStatisticsFigureVectorArtifactPayload(value: unknown): ScienceStatisticsFigureVectorArtifactPayload {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "figureArtifact", "export", "exportSha256"])
    || payload.schema !== SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA
    || typeof payload.exportSha256 !== "string" || !SHA256_RE.test(payload.exportSha256)) {
    throw new Error("science-statistics-figure-vector-artifact-invalid");
  }
  const parent = record(payload.figureArtifact);
  if (!parent || !exactKeys(parent, ["artifactId", "artifactVersion", "contentSha256"])
    || typeof parent.artifactId !== "string" || !parent.artifactId.trim() || parent.artifactId.length > 160
    || !Number.isSafeInteger(parent.artifactVersion) || Number(parent.artifactVersion) < 1
    || typeof parent.contentSha256 !== "string" || !SHA256_RE.test(parent.contentSha256)) {
    throw new Error("science-statistics-figure-vector-parent-invalid");
  }
  const exported = record(payload.export);
  if (!exported || !exactKeys(exported, [
    "mimeType", "renderer", "sourceSpecSha256", "exportProfile", "width", "height", "byteSize", "sha256",
  ]) || exported.mimeType !== "image/svg+xml" || exported.exportProfile !== "journal-vector-svg"
    || !Number.isSafeInteger(exported.width) || Number(exported.width) < 1 || Number(exported.width) > 8_192
    || !Number.isSafeInteger(exported.height) || Number(exported.height) < 1 || Number(exported.height) > 8_192
    || !Number.isSafeInteger(exported.byteSize) || Number(exported.byteSize) < 128 || Number(exported.byteSize) > 24 * 1024 * 1024
    || typeof exported.sourceSpecSha256 !== "string" || !SHA256_RE.test(exported.sourceSpecSha256)
    || typeof exported.sha256 !== "string" || !SHA256_RE.test(exported.sha256)) {
    throw new Error("science-statistics-figure-vector-export-invalid");
  }
  const renderer = record(exported.renderer);
  if (!renderer || !exactKeys(renderer, ["id", "version"]) || renderer.id !== "agentlas.vega"
    || renderer.version !== SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION) {
    throw new Error("science-statistics-figure-vector-renderer-invalid");
  }
  const core = {
    schema: SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA,
    figureArtifact: {
      artifactId: parent.artifactId,
      artifactVersion: Number(parent.artifactVersion),
      contentSha256: parent.contentSha256,
    },
    export: {
      mimeType: "image/svg+xml" as const,
      renderer: { id: "agentlas.vega" as const, version: renderer.version.trim() },
      sourceSpecSha256: exported.sourceSpecSha256,
      exportProfile: "journal-vector-svg" as const,
      width: Number(exported.width),
      height: Number(exported.height),
      byteSize: Number(exported.byteSize),
      sha256: exported.sha256,
    },
  };
  if (scienceStatisticsSha256(core) !== payload.exportSha256) {
    throw new Error("science-statistics-figure-vector-hash-invalid");
  }
  return { ...core, exportSha256: payload.exportSha256 };
}
