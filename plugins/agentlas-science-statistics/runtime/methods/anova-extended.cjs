"use strict";

/**
 * ANOVA extensions: ANCOVA, one-way repeated measures, Tukey HSD, Games-Howell, Dunnett,
 * Scheffe and unbalanced two-way (Type II / Type III) ANOVA.
 *
 * All numerics arrive through the engine helper surface `H` plus the sibling
 * shared-precision-distributions module (studentized range, Dunnett integral, Cody pnorm).
 */

const { createSupport } = require("./shared-precision-distributions.cjs");

const ORACLE = "contracts/anova-extended-scipy-crosscheck.py";

const GROUPS_SCHEMA = (minItems) => ({
  type: "array",
  minItems,
  maxItems: 64,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
    },
  },
});

const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };

const CONTRAST_COLUMNS = [
  { key: "contrast", label: "Contrast", type: "string" },
  { key: "difference", label: "Mean difference", type: "number" },
  { key: "standardError", label: "SE", type: "number" },
  { key: "statistic", label: "Statistic", type: "number" },
  { key: "df", label: "df", type: "number" },
  { key: "lower", label: "Simultaneous CI lower", type: "number" },
  { key: "upper", label: "Simultaneous CI upper", type: "number" },
  { key: "adjustedPValue", label: "Adjusted p", type: "number" },
  { key: "significant", label: "Significant", type: "boolean" },
];

const ANOVA_COLUMNS = [
  { key: "source", label: "Source", type: "string" },
  { key: "ss", label: "Sum of squares", type: "number" },
  { key: "df", label: "df", type: "number" },
  { key: "ms", label: "Mean square", type: "number" },
  { key: "statistic", label: "F", type: "number" },
  { key: "pValue", label: "p", type: "number" },
  { key: "partialEtaSquared", label: "Partial eta squared", type: "number" },
];

function groupSummaries(groups, H, budget) {
  return groups.map((group) => {
    const n = group.values.length;
    const mean = H.mean(group.values, budget);
    const variance = H.variance(group.values, true, budget);
    return { group: group.name, n, mean, variance, sd: Math.sqrt(variance) };
  });
}

function pairs(count) {
  const out = [];
  for (let first = 0; first < count - 1; first += 1) for (let second = first + 1; second < count; second += 1) out.push([first, second]);
  return out;
}

function parseGroupsWithLabel(data, H, minimumGroups, extraKeys = []) {
  H.assertKeys(data, ["groups", "outcomeLabel", ...extraKeys], "data");
  const groups = H.parseGroups({ groups: data.groups }, minimumGroups);
  return { groups, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
}

function pooledCore(groups, H, budget) {
  let core;
  try {
    core = H.anovaCore(groups, budget);
  } catch (error) {
    if (error?.code === "STAT_DEGENERATE") H.fail("STAT_DEGENERATE", "pooled within-group variance is zero or error degrees of freedom are insufficient");
    throw error;
  }
  return core;
}

function omnibusTest(name, core, H) {
  return { name, statistic: core.f, distribution: "F", df1: core.dfBetween, df2: core.dfWithin, pValue: H.pFromF(core.f, core.dfBetween, core.dfWithin) };
}

function baseAssumptions(extra = []) {
  return [
    { name: "independent observations", status: "requires_design_review" },
    { name: "normal residuals within groups", status: "diagnostic_attached" },
    ...extra,
  ];
}

function normalityDiagnostics(groups, H, budget) {
  return groups.map((group) => ({ group: group.name, ...H.jarqueBera(group.values, budget) }));
}

function rendererContract(rows, tableRole, vegaRole, hashKey, H) {
  return { inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, [hashKey]: H.sha256(rows), tableRole, vegaRole };
}

// ---------------------------------------------------------------------------------
// Design-matrix helpers (sum-to-zero contrasts, treatment dummies, nested OLS).
// ---------------------------------------------------------------------------------

function levelsOf(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

function treatmentColumns(values, levels) {
  return values.map((value) => levels.slice(1).map((level) => (value === level ? 1 : 0)));
}

function sumToZeroColumns(values, levels) {
  const last = levels[levels.length - 1];
  return values.map((value) => levels.slice(0, -1).map((level) => (value === level ? 1 : value === last ? -1 : 0)));
}

function bindColumns(n, ...blocks) {
  return Array.from({ length: n }, (_, row) => blocks.flatMap((block) => block[row]));
}

function interactionColumns(left, right) {
  return left.map((leftRow, index) => leftRow.flatMap((a) => right[index].map((b) => a * b)));
}

function nestedF(rssReduced, rssFull, dfEffect, mse, dfError, H) {
  const ss = Math.max(0, rssReduced - rssFull);
  const ms = ss / dfEffect;
  const statistic = ms / mse;
  return { ss, df: dfEffect, ms, statistic, pValue: H.pFromF(statistic, dfEffect, dfError), partialEtaSquared: ss / (ss + mse * dfError) };
}

// ---------------------------------------------------------------------------------
// ANCOVA
// ---------------------------------------------------------------------------------

const ancova = {
  method: "ancova",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "postHoc", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "group", "covariate"],
    properties: {
      y: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } },
      group: { type: "array", minItems: 8, maxItems: 100000, items: { type: "string", minLength: 1, maxLength: 128 } },
      covariate: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } },
      outcomeLabel: LABEL_SCHEMA,
      groupLabel: LABEL_SCHEMA,
      covariateLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "group", "covariate", "outcomeLabel", "groupLabel", "covariateLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 8);
    const group = H.categoryVector(data.group, "data.group", 8);
    const covariate = H.numericVector(data.covariate, "data.covariate", 8);
    if (group.length !== y.length || covariate.length !== y.length) H.fail("STAT_INVALID_INPUT", "ancova requires data.y, data.group and data.covariate of equal length");
    const levels = levelsOf(group);
    if (levels.length < 2 || levels.length > 32) H.fail("STAT_INVALID_INPUT", "ancova requires 2 to 32 group levels");
    const counts = levels.map((level) => group.filter((value) => value === level).length);
    if (counts.some((count) => count < 2)) H.fail("STAT_INSUFFICIENT_SAMPLE", "ancova requires at least two observations per group");
    if (H.minMax(covariate).min === H.minMax(covariate).max) H.fail("STAT_DEGENERATE", "ancova covariate is constant");
    if (y.length - levels.length - 1 < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "ancova residual degrees of freedom must be at least 1");
    return {
      y, group, covariate, levels, counts,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
      groupLabel: H.label(data.groupLabel, "Group", "data.groupLabel"),
      covariateLabel: H.label(data.covariateLabel, "Covariate", "data.covariateLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { y, group, covariate, levels } = parsed;
    const n = y.length;
    const k = levels.length;
    const ones = y.map(() => [1]);
    const groupCols = treatmentColumns(group, levels);
    const covCols = covariate.map((value) => [value]);
    const xFull = bindColumns(n, ones, groupCols, covCols);
    const xCov = bindColumns(n, ones, covCols);
    const xGroup = bindColumns(n, ones, groupCols);
    const full = S.olsFit(y, xFull, budget);
    const covOnly = S.olsFit(y, xCov, budget);
    const groupOnly = S.olsFit(y, xGroup, budget);
    const dfError = n - k - 1;
    const mse = full.rss / dfError;
    if (!(mse > 0)) H.fail("STAT_DEGENERATE", "ancova residual variance is zero");
    const groupRow = { source: parsed.groupLabel, ...nestedF(covOnly.rss, full.rss, k - 1, mse, dfError, H) };
    const covRow = { source: parsed.covariateLabel, ...nestedF(groupOnly.rss, full.rss, 1, mse, dfError, H) };
    const errorRow = { source: "Residual", ss: full.rss, df: dfError, ms: mse, statistic: null, pValue: null, partialEtaSquared: null };
    const anovaRows = [groupRow, covRow, errorRow];

    const covMean = H.mean(covariate, budget);
    const critical = H.tCritical(options.confidenceLevel, dfError);
    const slope = full.beta[k];
    const slopeSe = Math.sqrt(full.inverse[k][k] * mse);
    const adjustedRows = levels.map((level, index) => {
      budget.check();
      const c = xFull[0].map(() => 0);
      c[0] = 1;
      if (index > 0) c[index] = 1;
      c[k] = covMean;
      const estimate = c.reduce((acc, value, j) => acc + value * full.beta[j], 0);
      const se = Math.sqrt(H.quadraticForm(c, full.inverse) * mse);
      const members = y.filter((_, row) => group[row] === level);
      const covMembers = covariate.filter((_, row) => group[row] === level);
      return {
        group: level,
        n: members.length,
        rawMean: H.mean(members, budget),
        covariateMean: H.mean(covMembers, budget),
        adjustedMean: estimate,
        standardError: se,
        lower: estimate - critical * se,
        upper: estimate + critical * se,
      };
    });

    // Homogeneity of regression slopes (group x covariate interaction) as a diagnostic.
    let slopesDiagnostic;
    const dfInteractionError = n - 2 * k;
    if (dfInteractionError >= 1) {
      try {
        const xInt = bindColumns(n, xFull, interactionColumns(groupCols, covCols));
        const interaction = S.olsFit(y, xInt, budget);
        const mseInt = interaction.rss / dfInteractionError;
        const statistic = ((full.rss - interaction.rss) / (k - 1)) / mseInt;
        slopesDiagnostic = { name: "homogeneity of regression slopes", status: "evaluated", statistic, df1: k - 1, df2: dfInteractionError, pValue: H.pFromF(statistic, k - 1, dfInteractionError), method: "nested F test of group x covariate interaction" };
      } catch (error) {
        slopesDiagnostic = { name: "homogeneity of regression slopes", status: "not_evaluated", reason: error.message };
      }
    } else slopesDiagnostic = { name: "homogeneity of regression slopes", status: "not_evaluated", reason: "interaction model has no residual degrees of freedom" };

    const covariateRanges = levels.map((level) => {
      const values = covariate.filter((_, row) => group[row] === level);
      const range = H.minMax(values);
      return { group: level, min: range.min, max: range.max };
    });
    const overlapMin = Math.max(...covariateRanges.map((row) => row.min));
    const overlapMax = Math.min(...covariateRanges.map((row) => row.max));

    let contrastRows = [];
    if (options.postHoc === "holm") {
      const raw = pairs(k).map(([a, b]) => {
        budget.check();
        const c = xFull[0].map(() => 0);
        if (a > 0) c[a] = 1;
        if (b > 0) c[b] -= 1;
        const difference = adjustedRows[a].adjustedMean - adjustedRows[b].adjustedMean;
        const se = Math.sqrt(H.quadraticForm(c, full.inverse) * mse);
        const statistic = difference / se;
        return { contrast: `${levels[a]} - ${levels[b]}`, difference, standardError: se, statistic, df: dfError, rawPValue: H.pFromT(statistic, dfError, "two-sided") };
      });
      const adjusted = H.adjustedPValues(raw.map((row) => row.rawPValue), "holm");
      contrastRows = raw.map((row, index) => ({ ...row, adjustedPValue: adjusted[index], adjustment: "Holm" }));
    }

    const residualGroups = levels.map((level) => ({ name: level, values: full.residuals.filter((_, row) => group[row] === level) }));
    return {
      sample: { n, groups: k, groupSizes: parsed.counts, residualDf: dfError },
      estimates: [
        { name: "covariate slope", estimate: slope, standardError: slopeSe, df: dfError },
        { name: "covariate grand mean", estimate: covMean },
        { name: "residual mean square", estimate: mse },
        ...adjustedRows.map((row) => ({ name: `${row.group} adjusted mean`, estimate: row.adjustedMean, standardError: row.standardError, evaluatedAt: covMean })),
        { name: "renderer data contract", ...rendererContract(adjustedRows, "ancova-adjusted-means-table", "adjusted-means-plot", "adjustedMeanRowsHash", H) },
        ...(contrastRows.length ? [{ name: "adjusted-mean pairwise contrasts", rows: contrastRows }] : []),
      ],
      tests: [
        { name: `ANCOVA: ${parsed.groupLabel} adjusted for ${parsed.covariateLabel}`, statistic: groupRow.statistic, distribution: "F", df1: groupRow.df, df2: dfError, pValue: groupRow.pValue, sumOfSquares: "Type II" },
        { name: `ANCOVA: ${parsed.covariateLabel}`, statistic: covRow.statistic, distribution: "F", df1: 1, df2: dfError, pValue: covRow.pValue, sumOfSquares: "Type II" },
      ],
      confidenceIntervals: [
        { parameter: "covariate slope", level: options.confidenceLevel, lower: slope - critical * slopeSe, upper: slope + critical * slopeSe, method: "Student t" },
        ...adjustedRows.map((row) => ({ parameter: `${row.group} adjusted mean`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Student t on residual df (not simultaneous)" })),
      ],
      effectSizes: [
        { name: `${parsed.groupLabel} partial eta squared`, estimate: groupRow.partialEtaSquared },
        { name: `${parsed.covariateLabel} partial eta squared`, estimate: covRow.partialEtaSquared },
      ],
      assumptions: [
        { name: "independent observations", status: "requires_design_review" },
        { name: "linear covariate-outcome relationship within groups", status: "diagnostic_attached" },
        { name: "homogeneity of regression slopes", status: slopesDiagnostic.status === "evaluated" ? "diagnostic_attached" : "not_established" },
        { name: "covariate measured without error and unaffected by treatment", status: "requires_design_review" },
        { name: "normal residuals", status: "diagnostic_attached" },
        { name: "variance homogeneity of residuals", status: "diagnostic_attached" },
      ],
      diagnostics: [
        slopesDiagnostic,
        { name: "covariate overlap across groups", status: overlapMin < overlapMax ? "evaluated" : "warning", overlapMin, overlapMax, ranges: covariateRanges, interpretation: overlapMin < overlapMax ? "adjusted means are evaluated inside the shared covariate support" : "group covariate ranges do not overlap; adjusted means extrapolate" },
        { name: "Jarque-Bera normality of residuals", ...H.jarqueBera(full.residuals, budget) },
        H.leveneDiagnostic(residualGroups, budget),
        { name: "post-hoc boundary", status: contrastRows.length ? "holm_adjusted_contrasts" : "not_requested", requested: options.postHoc, method: contrastRows.length ? "adjusted-mean pairwise t contrasts with Holm-adjusted p-values" : "none", confidenceIntervals: "not provided for multiplicity-adjusted contrasts" },
        { name: "sum-of-squares boundary", status: "type_ii_via_nested_ols", unsupported: ["multiple covariates", "Type III with interaction in the primary model", "random effects"] },
      ],
      artifacts: [
        H.tableArtifact("Analysis of covariance", `Type II sums of squares for ${parsed.outcomeLabel} by ${parsed.groupLabel} adjusted for ${parsed.covariateLabel}.`, ANOVA_COLUMNS, anovaRows, ["Type II SS from nested OLS fits; the group effect is tested after the covariate and vice versa."], "ancova-table"),
        H.tableArtifact("Covariate-adjusted group means", `Adjusted means of ${parsed.outcomeLabel} evaluated at the grand covariate mean with ${Math.round(options.confidenceLevel * 100)}% confidence intervals.`, [
          { key: "group", label: parsed.groupLabel, type: "string" },
          { key: "n", label: "N", type: "number" },
          { key: "rawMean", label: "Raw mean", type: "number" },
          { key: "covariateMean", label: `Mean ${parsed.covariateLabel}`, type: "number" },
          { key: "adjustedMean", label: "Adjusted mean", type: "number" },
          { key: "standardError", label: "SE", type: "number" },
          { key: "lower", label: "CI lower", type: "number" },
          { key: "upper", label: "CI upper", type: "number" },
        ], adjustedRows, ["Intervals are groupwise and not simultaneous."], "ancova-adjusted-means-table"),
        H.vegaArtifact("adjusted-means-plot", `Covariate-adjusted means of ${parsed.outcomeLabel} with ${Math.round(options.confidenceLevel * 100)}% confidence intervals`, {
          data: { values: adjustedRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: parsed.groupLabel, sort: null }, y: { field: "lower", type: "quantitative", title: `Adjusted mean ${parsed.outcomeLabel}`, scale: H.MEASUREMENT_SCALE }, y2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { x: { field: "group", type: "nominal", sort: null }, y: { field: "adjustedMean", type: "quantitative", scale: H.MEASUREMENT_SCALE }, tooltip: [{ field: "group" }, { field: "adjustedMean", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }, { field: "rawMean", format: ".5g" }, { field: "n" }] } },
            { mark: { type: "point", shape: "diamond", color: "#888888", size: 50 }, encoding: { x: { field: "group", type: "nominal", sort: null }, y: { field: "rawMean", type: "quantitative", scale: H.MEASUREMENT_SCALE }, tooltip: [{ field: "group" }, { field: "rawMean", format: ".5g" }] } },
          ],
        }),
        ...(contrastRows.length ? [H.tableArtifact("ANCOVA Holm adjusted-mean contrasts", "Pairwise differences of covariate-adjusted means; Holm adjusts p-values and no simultaneous intervals are claimed.", [
          { key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Adjusted difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "rawPValue", label: "Raw p", type: "number" }, { key: "adjustedPValue", label: "Holm p", type: "number" }, { key: "adjustment", label: "Adjustment", type: "string" },
        ], contrastRows, [], "ancova-contrast-table")] : []),
      ],
    };
  },
  linkage: {
    neededWhen: "When groups are compared on a continuous outcome and a measured continuous covariate (baseline score, age, dose) must be removed from the comparison to sharpen precision or reduce confounding.",
    decision: "Whether group means still differ after covariate adjustment, how large the adjusted difference is, and whether the common-slope model that licenses the adjustment is defensible.",
    mustShow: "Type II ANOVA table, adjusted means at the covariate grand mean with intervals, the covariate slope, covariate overlap across groups, and the homogeneity-of-slopes diagnostic.",
    userGoal: "Report a covariate-adjusted group effect with its uncertainty and be able to defend the adjustment in review.",
    nextActions: [
      { trigger: "heterogeneous-slopes", action: "fit-separate-slopes-or-moderation-model", reason: "A single adjusted mean per group is not interpretable when the covariate effect differs by group." },
      { trigger: "covariate-ranges-do-not-overlap", action: "restrict-to-common-support-or-revise-estimand", reason: "Adjusted means outside the shared covariate range are extrapolations, not observed comparisons." },
      { trigger: "adjusted-group-effect-supported", action: "run-multiplicity-controlled-adjusted-mean-contrasts", reason: "The omnibus adjusted effect does not say which groups differ once the covariate is removed." },
      { trigger: "residual-defect", action: "inspect-residuals-and-compare-robust-or-transformed-model", reason: "Both the F test and the adjusted-mean intervals rely on homoscedastic residuals." },
    ],
  },
  fixture: {
    data: {
      y: [12.1, 14.3, 13.8, 16.2, 15.0, 17.4, 11.9, 13.2, 15.7, 18.1, 16.9, 19.3, 14.8, 12.6, 17.7, 20.2],
      group: ["control", "control", "control", "control", "control", "control", "treated", "treated", "treated", "treated", "treated", "treated", "placebo", "placebo", "placebo", "placebo"],
      covariate: [3.1, 4.2, 3.9, 5.4, 4.8, 6.0, 2.5, 3.3, 4.4, 5.9, 5.1, 6.7, 4.6, 3.0, 5.8, 7.1],
      outcomeLabel: "post score", groupLabel: "arm", covariateLabel: "baseline",
    },
    options: { confidenceLevel: 0.95, postHoc: "holm" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova", "matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "One factor (2-32 levels) plus one continuous covariate, additive OLS model with Type II sums of squares from nested fits, adjusted means at the covariate grand mean, and a nested-F homogeneity-of-slopes diagnostic.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["Type II SS, df, F, p and partial eta squared for group and covariate (pingouin.ancova, statsmodels anova_lm)", "covariate slope", "adjusted means, SE and CI (numpy OLS contrast oracle)", "homogeneity-of-slopes F and p (statsmodels nested OLS)"], excludedOutputs: ["Holm contrast p-values (engine adjustment reused)", "residual normality and Levene diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["homogeneity of regression slopes", "covariate overlap across groups", "Jarque-Bera normality of residuals", "Brown-Forsythe variance homogeneity"], limitations: ["no linearity plot per group", "no influence measures"] },
    knownGaps: ["multiple covariates", "Type III with interaction retained in the primary model", "simultaneous intervals for adjusted-mean contrasts"],
  },
};

// ---------------------------------------------------------------------------------
// One-way repeated measures ANOVA
// ---------------------------------------------------------------------------------

const repeatedMeasuresAnova = {
  method: "repeated_measures_anova",
  family: "anova",
  analysisModel: { families: ["lm", "lmm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "postHoc", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["conditions"],
    properties: {
      conditions: { type: "array", minItems: 2, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: LABEL_SCHEMA, values: { type: "array", minItems: 3, maxItems: 100000, items: { type: "number" } } } } },
      outcomeLabel: LABEL_SCHEMA,
      conditionLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["conditions", "outcomeLabel", "conditionLabel"], "data");
    if (!Array.isArray(data.conditions) || data.conditions.length < 2 || data.conditions.length > H.LIMITS.maxGroups) {
      H.fail("STAT_INVALID_INPUT", `data.conditions length must be between 2 and ${H.LIMITS.maxGroups}`);
    }
    const names = new Set();
    let blocks = null;
    const conditions = data.conditions.map((raw, index) => {
      const path = `data.conditions[${index}]`;
      const condition = H.assertObject(raw, path);
      H.assertKeys(condition, ["name", "values"], path);
      const name = H.label(condition.name, `Condition ${index + 1}`, `${path}.name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate condition name: ${name}`);
      names.add(name);
      const values = H.numericVector(condition.values, `${path}.values`, 3);
      if (blocks === null) blocks = values.length;
      if (values.length !== blocks) H.fail("STAT_INVALID_INPUT", "repeated_measures_anova requires a complete subject-by-condition matrix with equal condition lengths");
      return { name, values };
    });
    if (conditions.length * blocks > H.LIMITS.maxTotalValues) H.fail("STAT_LIMIT_EXCEEDED", `repeated-measures matrix exceeds ${H.LIMITS.maxTotalValues} values`);
    return { conditions, subjects: blocks, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"), conditionLabel: H.label(data.conditionLabel, "Condition", "data.conditionLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { conditions, subjects: n } = parsed;
    const k = conditions.length;
    const all = conditions.flatMap((condition) => condition.values);
    const grand = H.mean(all, budget);
    const conditionMeans = conditions.map((condition) => H.mean(condition.values, budget));
    const subjectMeans = Array.from({ length: n }, (_, j) => H.mean(conditions.map((condition) => condition.values[j]), budget));
    let ssTotal = 0;
    for (const value of all) {
      budget.check();
      ssTotal += (value - grand) ** 2;
    }
    const ssCondition = n * H.sum(conditionMeans.map((m) => (m - grand) ** 2), budget);
    const ssSubject = k * H.sum(subjectMeans.map((m) => (m - grand) ** 2), budget);
    const ssError = Math.max(0, ssTotal - ssCondition - ssSubject);
    const dfCondition = k - 1;
    const dfSubject = n - 1;
    const dfError = dfCondition * dfSubject;
    if (!(ssError > 0)) H.fail("STAT_DEGENERATE", "repeated-measures error sum of squares is zero");
    const msCondition = ssCondition / dfCondition;
    const msError = ssError / dfError;
    const statistic = msCondition / msError;
    const pValue = H.pFromF(statistic, dfCondition, dfError);

    // Covariance of conditions across subjects and orthonormal (Helmert) contrasts.
    // H.covarianceMatrix expects centered columns (it does not subtract means itself).
    const covariance = H.covarianceMatrix(conditions.map((condition, index) => condition.values.map((value) => value - conditionMeans[index])), budget);
    const contrasts = [];
    for (let i = 1; i < k; i += 1) {
      const row = Array(k).fill(0);
      for (let j = 0; j < i; j += 1) row[j] = 1;
      row[i] = -i;
      const norm = Math.sqrt(i * (i + 1));
      contrasts.push(row.map((value) => value / norm));
    }
    const sc = H.matMul(H.matMul(contrasts, covariance, budget), H.transpose(contrasts), budget);
    const trace = sc.reduce((acc, row, index) => acc + row[index], 0);
    let traceSquare = 0;
    for (let i = 0; i < k - 1; i += 1) for (let j = 0; j < k - 1; j += 1) traceSquare += sc[i][j] * sc[j][i];
    const epsilonLowerBound = 1 / dfCondition;
    let epsilonGG = traceSquare > 0 ? Math.min(1, (trace * trace) / (dfCondition * traceSquare)) : null;
    let epsilonHF = null;
    if (epsilonGG !== null) {
      const denominator = dfCondition * (n - 1 - dfCondition * epsilonGG);
      epsilonHF = denominator > 0 ? Math.min(1, (n * dfCondition * epsilonGG - 2) / denominator) : 1;
      epsilonHF = Math.max(epsilonHF, epsilonLowerBound);
    }
    let mauchly;
    if (k === 2) mauchly = { name: "Mauchly sphericity", status: "not_applicable", reason: "sphericity is automatically satisfied with two conditions", W: 1 };
    else if (n - 1 < k - 1) mauchly = { name: "Mauchly sphericity", status: "not_evaluated", reason: "fewer subjects than conditions; contrast covariance is singular" };
    else {
      try {
        const logDet = H.positiveDefiniteLogDeterminant(sc);
        const W = Math.exp(logDet - dfCondition * Math.log(trace / dfCondition));
        const d = dfCondition;
        const f = 1 - (2 * d * d + d + 2) / (6 * d * (n - 1));
        const chiSquare = -(n - 1) * f * Math.log(W);
        const df = (d * (d + 1)) / 2 - 1;
        // Second-order term of the Box/Anderson expansion (as in R ezANOVA and pingouin.sphericity).
        const w2 = ((d + 2) * (d - 1) * (d - 2) * (2 * d ** 3 + 6 * d * d + 3 * k + 2)) / (288 * ((n - 1) * d * f) ** 2);
        const p1 = H.pFromChiSquare(Math.max(0, chiSquare), df);
        const p2 = H.pFromChiSquare(Math.max(0, chiSquare), df + 4);
        const pValue = Math.min(1, Math.max(0, p1 + w2 * (p2 - p1)));
        mauchly = { name: "Mauchly sphericity", status: "evaluated", W, statistic: chiSquare, df, pValue, method: "chi-square approximation with second-order Box correction" };
      } catch (error) {
        mauchly = { name: "Mauchly sphericity", status: "not_evaluated", reason: error.message };
      }
    }
    const correctedRows = [
      { correction: "none", epsilon: 1, df1: dfCondition, df2: dfError, statistic, pValue },
      ...(epsilonGG === null ? [] : [{ correction: "Greenhouse-Geisser", epsilon: epsilonGG, df1: dfCondition * epsilonGG, df2: dfError * epsilonGG, statistic, pValue: H.pFromF(statistic, dfCondition * epsilonGG, dfError * epsilonGG) }]),
      ...(epsilonHF === null ? [] : [{ correction: "Huynh-Feldt", epsilon: epsilonHF, df1: dfCondition * epsilonHF, df2: dfError * epsilonHF, statistic, pValue: H.pFromF(statistic, dfCondition * epsilonHF, dfError * epsilonHF) }]),
      { correction: "lower bound", epsilon: epsilonLowerBound, df1: dfCondition * epsilonLowerBound, df2: dfError * epsilonLowerBound, statistic, pValue: H.pFromF(statistic, dfCondition * epsilonLowerBound, dfError * epsilonLowerBound) },
    ];
    const anovaRows = [
      { source: parsed.conditionLabel, ss: ssCondition, df: dfCondition, ms: msCondition, statistic, pValue, partialEtaSquared: ssCondition / (ssCondition + ssError) },
      { source: "Subjects", ss: ssSubject, df: dfSubject, ms: ssSubject / dfSubject, statistic: null, pValue: null, partialEtaSquared: null },
      { source: "Error", ss: ssError, df: dfError, ms: msError, statistic: null, pValue: null, partialEtaSquared: null },
      { source: "Total", ss: ssTotal, df: n * k - 1, ms: null, statistic: null, pValue: null, partialEtaSquared: null },
    ];
    const critical = H.tCritical(options.confidenceLevel, dfError);
    const profileRows = conditions.map((condition, index) => {
      const variance = H.variance(condition.values, true, budget);
      const half = critical * Math.sqrt(msError / n);
      return { condition: condition.name, n, mean: conditionMeans[index], sd: Math.sqrt(variance), standardError: Math.sqrt(msError / n), lower: conditionMeans[index] - half, upper: conditionMeans[index] + half };
    });
    let contrastRows = [];
    if (options.postHoc === "holm") {
      const raw = pairs(k).map(([a, b]) => {
        budget.check();
        const differences = conditions[a].values.map((value, j) => value - conditions[b].values[j]);
        const meanDifference = H.mean(differences, budget);
        const sd = Math.sqrt(H.variance(differences, true, budget));
        const se = sd / Math.sqrt(n);
        if (!(se > 0)) H.fail("STAT_DEGENERATE", `paired differences between ${conditions[a].name} and ${conditions[b].name} have zero variance`);
        const t = meanDifference / se;
        return { contrast: `${conditions[a].name} - ${conditions[b].name}`, difference: meanDifference, standardError: se, statistic: t, df: n - 1, rawPValue: H.pFromT(t, n - 1, "two-sided"), cohenDz: meanDifference / sd };
      });
      const adjusted = H.adjustedPValues(raw.map((row) => row.rawPValue), "holm");
      contrastRows = raw.map((row, index) => ({ ...row, adjustedPValue: adjusted[index], adjustment: "Holm" }));
    }
    return {
      sample: { n: n * k, subjects: n, conditions: k, completeBlocks: n },
      estimates: [
        { name: "grand mean", estimate: grand },
        ...profileRows.map((row) => ({ name: `${row.condition} mean`, estimate: row.mean, standardError: row.standardError })),
        { name: "Greenhouse-Geisser epsilon", estimate: epsilonGG },
        { name: "Huynh-Feldt epsilon", estimate: epsilonHF },
        { name: "lower-bound epsilon", estimate: epsilonLowerBound },
        { name: "renderer data contract", ...rendererContract(profileRows, "repeated-measures-profile-table", "within-subject-profile", "profileRowsHash", H) },
        ...(contrastRows.length ? [{ name: "paired post-hoc contrasts", rows: contrastRows }] : []),
      ],
      tests: correctedRows.map((row) => ({ name: `Repeated measures ANOVA (${row.correction})`, statistic: row.statistic, distribution: "F", df1: row.df1, df2: row.df2, pValue: row.pValue, epsilon: row.epsilon })),
      confidenceIntervals: profileRows.map((row) => ({ parameter: `${row.condition} mean`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Student t using the within-subject error mean square" })),
      effectSizes: [
        { name: "partial eta squared", estimate: ssCondition / (ssCondition + ssError) },
        { name: "generalized eta squared", estimate: ssCondition / (ssCondition + ssSubject + ssError) },
      ],
      assumptions: [
        { name: "complete subject-by-condition matrix", status: "verified_by_input_contract" },
        { name: "sphericity of condition differences", status: mauchly.status === "evaluated" ? "diagnostic_attached" : mauchly.status === "not_applicable" ? "satisfied_by_design" : "not_established" },
        { name: "normal within-subject residuals", status: "diagnostic_attached" },
        { name: "no carry-over or order effects", status: "requires_design_review" },
      ],
      diagnostics: [
        mauchly,
        { name: "sphericity corrections", status: epsilonGG === null ? "not_evaluated" : "evaluated", greenhouseGeisser: epsilonGG, huynhFeldt: epsilonHF, lowerBound: epsilonLowerBound, guidance: "report the Greenhouse-Geisser p when epsilon < 0.75, Huynh-Feldt otherwise" },
        ...conditions.map((condition) => ({ condition: condition.name, ...H.jarqueBera(condition.values, budget) })),
        { name: "post-hoc boundary", status: contrastRows.length ? "holm_adjusted_contrasts" : "not_requested", requested: options.postHoc, method: contrastRows.length ? "paired t contrasts with Holm-adjusted p-values" : "none", confidenceIntervals: "not provided for multiplicity-adjusted contrasts" },
        { name: "design boundary", status: "one_within_factor_complete_blocks", unsupported: ["between-subject factors", "missing cells", "multivariate (MANOVA) test", "random slopes"] },
      ],
      artifacts: [
        H.tableArtifact("One-way repeated measures ANOVA", `Within-subject decomposition of ${parsed.outcomeLabel} across ${k} ${parsed.conditionLabel} levels for ${n} subjects.`, ANOVA_COLUMNS, anovaRows, ["Uncorrected F; see the sphericity-corrected table for Greenhouse-Geisser and Huynh-Feldt p-values."], "repeated-measures-anova-table"),
        H.tableArtifact("Sphericity-corrected tests", "Epsilon-adjusted degrees of freedom and p-values.", [
          { key: "correction", label: "Correction", type: "string" }, { key: "epsilon", label: "Epsilon", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "statistic", label: "F", type: "number" }, { key: "pValue", label: "p", type: "number" },
        ], correctedRows, [], "sphericity-correction-table"),
        H.tableArtifact("Condition means", `Condition means with ${Math.round(options.confidenceLevel * 100)}% intervals based on the within-subject error mean square.`, [
          { key: "condition", label: parsed.conditionLabel, type: "string" }, { key: "n", label: "Subjects", type: "number" }, { key: "mean", label: "Mean", type: "number" }, { key: "sd", label: "SD", type: "number" }, { key: "standardError", label: "SE (error MS)", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" },
        ], profileRows, [], "repeated-measures-profile-table"),
        H.vegaArtifact("within-subject-profile", `${parsed.outcomeLabel} across ${parsed.conditionLabel} levels (within-subject error intervals)`, {
          data: { values: profileRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "condition", type: "nominal", title: parsed.conditionLabel, sort: null }, y: { field: "lower", type: "quantitative", title: `Mean ${parsed.outcomeLabel}`, scale: H.MEASUREMENT_SCALE }, y2: { field: "upper" } } },
            { mark: { type: "line", point: true }, encoding: { x: { field: "condition", type: "nominal", sort: null }, y: { field: "mean", type: "quantitative", scale: H.MEASUREMENT_SCALE }, tooltip: [{ field: "condition" }, { field: "mean", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }, { field: "sd", format: ".4g" }] } },
          ],
        }),
        ...(contrastRows.length ? [H.tableArtifact("Repeated measures Holm paired contrasts", "Paired t contrasts between conditions with Holm-adjusted p-values.", [
          { key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Mean difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "rawPValue", label: "Raw p", type: "number" }, { key: "adjustedPValue", label: "Holm p", type: "number" }, { key: "cohenDz", label: "Cohen dz", type: "number" }, { key: "adjustment", label: "Adjustment", type: "string" },
        ], contrastRows, [], "repeated-measures-contrast-table")] : []),
      ],
    };
  },
  linkage: {
    neededWhen: "When every subject is measured under all conditions or time points and the question is whether the condition means differ after removing stable between-subject differences.",
    decision: "Whether the within-subject condition effect is supported once sphericity is checked and, if violated, whether the corrected p-value still supports it.",
    mustShow: "Complete block support, condition means with within-subject error intervals, the ANOVA table, Mauchly's test, epsilon values with corrected p-values, and the post-hoc boundary.",
    userGoal: "Report a repeated-measures effect that survives the sphericity correction and identify which conditions differ.",
    nextActions: [
      { trigger: "sphericity-violated", action: "report-greenhouse-geisser-or-huynh-feldt-corrected-result", reason: "The uncorrected F overstates evidence when condition-difference variances are unequal." },
      { trigger: "condition-effect-supported", action: "run-holm-paired-contrasts-or-planned-comparisons", reason: "The omnibus test does not identify which conditions or time points differ." },
      { trigger: "missing-cells-or-dropout", action: "switch-to-mixed-model-with-random-intercept", reason: "The complete-block ANOVA cannot use subjects with incomplete condition data." },
      { trigger: "reportable-effect", action: "bind-profile-figure-and-corrected-table", reason: "Readers need the within-subject pattern next to the corrected inference." },
    ],
  },
  fixture: {
    data: {
      conditions: [
        { name: "baseline", values: [7.2, 6.8, 8.1, 7.9, 6.5, 7.4, 8.3, 6.9, 7.7, 7.0] },
        { name: "week 4", values: [6.9, 6.1, 7.6, 7.2, 6.4, 6.8, 7.9, 6.2, 7.1, 6.6] },
        { name: "week 8", values: [6.2, 5.7, 7.1, 6.8, 5.9, 6.3, 7.2, 5.8, 6.7, 6.0] },
        { name: "week 12", values: [5.9, 5.6, 6.8, 6.1, 5.8, 6.0, 6.9, 5.7, 6.4, 5.9] },
      ],
      outcomeLabel: "pain score", conditionLabel: "visit",
    },
    options: { confidenceLevel: 0.95, postHoc: "holm" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "One within-subject factor with complete blocks: univariate F, Mauchly's W with chi-square approximation, Greenhouse-Geisser, Huynh-Feldt and lower-bound corrections, partial and generalized eta squared, optional Holm-corrected paired t contrasts.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["F, uncorrected p, Greenhouse-Geisser epsilon and corrected p (pingouin.rm_anova)", "Mauchly W, chi-square, df and p (pingouin.sphericity)", "Huynh-Feldt epsilon (pingouin.epsilon)", "sums of squares and generalized eta squared (numpy decomposition)"], excludedOutputs: ["lower-bound corrected p", "Holm paired contrasts"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Mauchly sphericity", "sphericity corrections", "Jarque-Bera normality per condition"], limitations: ["no multivariate test", "no outlier or influence screen"] },
    knownGaps: ["between-subject factors and mixed designs", "unbalanced or missing cells", "multivariate repeated-measures test"],
  },
};

// ---------------------------------------------------------------------------------
// Pairwise post-hoc families sharing the studentized range / F distributions.
// ---------------------------------------------------------------------------------

function pairwiseArtifacts(H, S, options, parsed, rows, tableRole, vegaRole, title, caption, notes, contractKey) {
  return {
    contract: { name: "renderer data contract", ...rendererContract(rows, tableRole, vegaRole, contractKey, H) },
    artifacts: [
      H.tableArtifact(title, caption, CONTRAST_COLUMNS, rows, notes, tableRole),
      S.forestArtifact(vegaRole, `${title}: pairwise differences with ${Math.round(options.confidenceLevel * 100)}% simultaneous intervals`, rows, `Difference in ${parsed.outcomeLabel}`),
    ],
  };
}

const tukeyHsd = {
  method: "tukey_hsd",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA(3), outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseGroupsWithLabel(data, H, 3);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { groups } = parsed;
    const k = groups.length;
    const core = pooledCore(groups, H, budget);
    const summaries = groupSummaries(groups, H, budget);
    const qCritical = S.qtukey(options.confidenceLevel, k, core.dfWithin, budget);
    const rows = pairs(k).map(([a, b]) => {
      budget.check();
      const difference = summaries[a].mean - summaries[b].mean;
      const se = Math.sqrt((core.msWithin / 2) * (1 / summaries[a].n + 1 / summaries[b].n));
      const q = Math.abs(difference) / se;
      const adjustedPValue = Math.min(1, Math.max(0, 1 - S.ptukey(q, k, core.dfWithin)));
      const half = qCritical * se;
      return { contrast: `${groups[a].name} - ${groups[b].name}`, difference, standardError: se, statistic: q, df: core.dfWithin, lower: difference - half, upper: difference + half, adjustedPValue, significant: adjustedPValue < 1 - options.confidenceLevel };
    });
    const bundle = pairwiseArtifacts(H, S, options, parsed, rows, "tukey-hsd-table", "pairwise-difference-forest", "Tukey HSD pairwise contrasts", `Tukey-Kramer studentized range contrasts on ${parsed.outcomeLabel} using the pooled error mean square.`, ["Statistic is the studentized range q = |difference| / SE with SE = sqrt(MSE/2 (1/n_i + 1/n_j)); intervals are simultaneous at the stated level."], "contrastRowsHash");
    return {
      sample: { n: core.n, groups: k, groupSizes: summaries.map((row) => row.n), balanced: new Set(summaries.map((row) => row.n)).size === 1 },
      estimates: [
        { name: "pooled error mean square", estimate: core.msWithin, df: core.dfWithin },
        { name: "studentized range critical value", estimate: qCritical, groups: k, df: core.dfWithin, level: options.confidenceLevel },
        ...summaries.map((row) => ({ name: `${row.group} mean`, estimate: row.mean, n: row.n, sd: row.sd })),
        bundle.contract,
      ],
      tests: [omnibusTest("One-way ANOVA (omnibus)", core, H), ...rows.map((row) => ({ name: `Tukey HSD: ${row.contrast}`, statistic: row.statistic, distribution: "studentized range", groups: k, df: row.df, pValue: row.adjustedPValue }))],
      confidenceIntervals: rows.map((row) => ({ parameter: row.contrast, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Tukey-Kramer simultaneous" })),
      effectSizes: [{ name: "eta squared", estimate: core.ssBetween / core.ssTotal }],
      assumptions: baseAssumptions([{ name: "equal variances (pooled MSE)", status: "diagnostic_attached" }]),
      diagnostics: [...normalityDiagnostics(groups, H, budget), H.leveneDiagnostic(groups, budget), { name: "studentized range boundary", status: "exact_quadrature", method: "Copenhaver-Holland (AS 190 style) Gauss-Legendre quadrature", unbalancedHandling: "Tukey-Kramer harmonic pair variance" }],
      artifacts: bundle.artifacts,
    };
  },
  linkage: {
    neededWhen: "After a one-way design with three or more groups where every pairwise mean difference is of interest and variances are plausibly equal.",
    decision: "Which specific pairs of groups differ, with family-wise error controlled across all pairwise comparisons, and by how much.",
    mustShow: "Every pairwise difference with its simultaneous interval and adjusted p, the pooled error term, group sizes, and the variance-homogeneity evidence that licenses the pooled MSE.",
    userGoal: "Report defensible pairwise conclusions from a multi-group experiment without inflating false positives.",
    nextActions: [
      { trigger: "unequal-variances", action: "switch-to-games-howell", reason: "Tukey's pooled error term is miscalibrated when group variances differ substantially." },
      { trigger: "one-control-comparison-only", action: "switch-to-dunnett-test", reason: "Many-to-one comparisons waste power when all pairs are corrected." },
      { trigger: "reportable-pairwise-differences", action: "bind-forest-figure-and-contrast-table", reason: "Intervals communicate magnitude while adjusted p-values alone do not." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "control", values: [5.1, 4.8, 5.6, 5.0, 4.7, 5.3] },
      { name: "low dose", values: [5.9, 6.2, 5.7, 6.4, 6.0, 5.8] },
      { name: "high dose", values: [7.1, 6.8, 7.4, 7.0, 6.9, 7.3] },
      { name: "combination", values: [7.8, 8.1, 7.6, 8.3, 7.9] },
    ], outcomeLabel: "response" },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "All pairwise Tukey-Kramer contrasts for 3-64 independent groups using the pooled one-way error mean square and exact studentized-range quadrature for adjusted p-values and simultaneous intervals.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["pairwise differences, adjusted p-values and simultaneous intervals (scipy.stats.tukey_hsd)", "studentized range critical value (scipy.stats.studentized_range.ppf)"], excludedOutputs: ["omnibus F (engine anovaCore reused)", "diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera per group", "Brown-Forsythe variance homogeneity"], limitations: ["no outlier screen"] },
    knownGaps: ["non-pairwise contrasts", "compact letter display"],
  },
};

const gamesHowell = {
  method: "games_howell",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA(3), outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    const parsed = parseGroupsWithLabel(data, H, 3);
    if (parsed.groups.some((group) => group.values.length < 3)) H.fail("STAT_INSUFFICIENT_SAMPLE", "games_howell requires at least three observations per group");
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { groups } = parsed;
    const k = groups.length;
    const summaries = groupSummaries(groups, H, budget);
    if (summaries.some((row) => !(row.variance > 0))) H.fail("STAT_DEGENERATE", "games_howell requires positive variance in every group");
    const rows = pairs(k).map(([a, b]) => {
      budget.check();
      const va = summaries[a].variance / summaries[a].n;
      const vb = summaries[b].variance / summaries[b].n;
      const difference = summaries[a].mean - summaries[b].mean;
      const se = Math.sqrt(va + vb);
      const df = (va + vb) ** 2 / (va * va / (summaries[a].n - 1) + vb * vb / (summaries[b].n - 1));
      const q = Math.abs(difference) * Math.SQRT2 / se;
      const adjustedPValue = Math.min(1, Math.max(0, 1 - S.ptukey(q, k, df)));
      const half = S.qtukey(options.confidenceLevel, k, df, budget) * se / Math.SQRT2;
      return { contrast: `${groups[a].name} - ${groups[b].name}`, difference, standardError: se, statistic: q, df, lower: difference - half, upper: difference + half, adjustedPValue, significant: adjustedPValue < 1 - options.confidenceLevel };
    });
    const bundle = pairwiseArtifacts(H, S, options, parsed, rows, "games-howell-table", "pairwise-difference-forest", "Games-Howell pairwise contrasts", `Unequal-variance studentized range contrasts on ${parsed.outcomeLabel} with Welch-Satterthwaite degrees of freedom per pair.`, ["Statistic is q = |difference| * sqrt(2) / sqrt(s_i^2/n_i + s_j^2/n_j); each pair uses its own Welch df."], "contrastRowsHash");
    return {
      sample: { n: summaries.reduce((acc, row) => acc + row.n, 0), groups: k, groupSizes: summaries.map((row) => row.n) },
      estimates: [...summaries.map((row) => ({ name: `${row.group} mean`, estimate: row.mean, n: row.n, variance: row.variance })), bundle.contract],
      tests: rows.map((row) => ({ name: `Games-Howell: ${row.contrast}`, statistic: row.statistic, distribution: "studentized range", groups: k, df: row.df, pValue: row.adjustedPValue })),
      confidenceIntervals: rows.map((row) => ({ parameter: row.contrast, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Games-Howell simultaneous" })),
      effectSizes: [],
      assumptions: baseAssumptions([{ name: "equal variances", status: "not_required_by_games_howell" }]),
      diagnostics: [...normalityDiagnostics(groups, H, budget), H.leveneDiagnostic(groups, budget), { name: "studentized range boundary", status: "exact_quadrature", method: "Copenhaver-Holland (AS 190 style) Gauss-Legendre quadrature with fractional df" }],
      artifacts: bundle.artifacts,
    };
  },
  linkage: {
    neededWhen: "After a multi-group comparison where group variances or sample sizes differ and every pairwise contrast still matters.",
    decision: "Which pairs of groups differ when the pooled-variance assumption behind Tukey HSD is not defensible.",
    mustShow: "Pairwise differences with simultaneous intervals, adjusted p-values, per-pair Welch degrees of freedom, and the group variances that motivated the unequal-variance procedure.",
    userGoal: "Report robust pairwise conclusions when groups spread differently without pooling incompatible variances.",
    nextActions: [
      { trigger: "variances-similar-and-groups-balanced", action: "compare-with-tukey-hsd-for-power", reason: "Games-Howell is slightly conservative when the pooled model actually holds." },
      { trigger: "small-groups", action: "review-per-pair-degrees-of-freedom-before-reporting", reason: "Very small Welch df make the studentized range calibration fragile." },
      { trigger: "reportable-pairwise-differences", action: "bind-forest-figure-and-contrast-table", reason: "Interval width shows how much each pair's variance limits the conclusion." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "control", values: [4.2, 5.1, 6.7, 4.8, 5.9, 5.3] },
      { name: "treatment A", values: [8.3, 12.4, 9.7, 15.2, 10.5, 13.1] },
      { name: "treatment B", values: [2.1, 2.9, 3.0, 2.8, 2.5] },
    ], outcomeLabel: "response" },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "All pairwise Games-Howell contrasts for 3-64 groups with at least three observations each, Welch-Satterthwaite df per pair, exact studentized-range quadrature for adjusted p-values and simultaneous intervals.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["pairwise differences, Welch df and adjusted p-values (pingouin.pairwise_gameshowell)", "simultaneous interval bounds (scipy.stats.studentized_range.ppf oracle)"], excludedOutputs: ["diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera per group", "Brown-Forsythe variance homogeneity"], limitations: ["no outlier screen"] },
    knownGaps: ["non-pairwise contrasts", "compact letter display"],
  },
};

const dunnettTest = {
  method: "dunnett_test",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups", "control"], properties: { groups: GROUPS_SCHEMA(2), control: LABEL_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    const parsed = parseGroupsWithLabel(data, H, 2, ["control"]);
    if (data.control === undefined) H.fail("STAT_INVALID_INPUT", "data.control must name the control group");
    const control = H.label(data.control, "", "data.control");
    const controlIndex = parsed.groups.findIndex((group) => group.name === control);
    if (controlIndex < 0) H.fail("STAT_INVALID_INPUT", `data.control ${control} does not match any group name`);
    if (parsed.groups.length > 33) H.fail("STAT_LIMIT_EXCEEDED", "dunnett_test supports at most 32 treatment groups");
    return { ...parsed, control, controlIndex };
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { groups, controlIndex } = parsed;
    const k = groups.length;
    const core = pooledCore(groups, H, budget);
    const summaries = groupSummaries(groups, H, budget);
    const control = summaries[controlIndex];
    const treatments = summaries.map((row, index) => ({ row, index })).filter((item) => item.index !== controlIndex);
    const bs = treatments.map((item) => 1 / Math.sqrt(1 + control.n / item.row.n));
    const twoSided = options.alternative === "two-sided";
    const critical = S.dunnettCritical(options.confidenceLevel, bs, core.dfWithin, twoSided, budget);
    const rows = treatments.map((item) => {
      budget.check();
      const difference = item.row.mean - control.mean;
      const se = Math.sqrt(core.msWithin * (1 / item.row.n + 1 / control.n));
      const t = difference / se;
      let adjustedPValue;
      if (twoSided) adjustedPValue = 1 - S.dunnettProbability(Math.abs(t), bs, core.dfWithin, true, budget);
      else if (options.alternative === "greater") adjustedPValue = 1 - S.dunnettProbability(t, bs, core.dfWithin, false, budget);
      else adjustedPValue = 1 - S.dunnettProbability(-t, bs, core.dfWithin, false, budget);
      adjustedPValue = Math.min(1, Math.max(0, adjustedPValue));
      const lower = options.alternative === "less" ? null : difference - critical * se;
      const upper = options.alternative === "greater" ? null : difference + critical * se;
      return { contrast: `${item.row.group} - ${control.group}`, difference, standardError: se, statistic: t, df: core.dfWithin, lower, upper, adjustedPValue, significant: adjustedPValue < 1 - options.confidenceLevel };
    });
    const bundle = pairwiseArtifacts(H, S, options, parsed, rows, "dunnett-table", "pairwise-difference-forest", "Dunnett many-to-one contrasts", `Each treatment versus control ${control.group} on ${parsed.outcomeLabel} using the multivariate t distribution (${options.alternative}).`, ["Adjusted p-values and simultaneous intervals integrate the exact product-correlation multivariate t; one-sided alternatives leave the unbounded side null."], "contrastRowsHash");
    return {
      sample: { n: core.n, groups: k, treatments: k - 1, control: control.group, groupSizes: summaries.map((row) => row.n) },
      estimates: [
        { name: "pooled error mean square", estimate: core.msWithin, df: core.dfWithin },
        { name: "Dunnett critical value", estimate: critical, comparisons: k - 1, df: core.dfWithin, level: options.confidenceLevel, alternative: options.alternative },
        { name: "control mean", estimate: control.mean, n: control.n },
        ...treatments.map((item) => ({ name: `${item.row.group} mean`, estimate: item.row.mean, n: item.row.n })),
        bundle.contract,
      ],
      tests: [omnibusTest("One-way ANOVA (omnibus)", core, H), ...rows.map((row) => ({ name: `Dunnett: ${row.contrast}`, statistic: row.statistic, distribution: "multivariate t", comparisons: k - 1, df: row.df, pValue: row.adjustedPValue, alternative: options.alternative }))],
      confidenceIntervals: rows.map((row) => ({ parameter: row.contrast, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: `Dunnett simultaneous (${options.alternative})` })),
      effectSizes: [{ name: "eta squared", estimate: core.ssBetween / core.ssTotal }],
      assumptions: baseAssumptions([{ name: "equal variances (pooled MSE)", status: "diagnostic_attached" }]),
      diagnostics: [...normalityDiagnostics(groups, H, budget), H.leveneDiagnostic(groups, budget), { name: "multivariate t boundary", status: "numerical_integration", correlationStructure: "product form rho_ij = b_i b_j with b_i = 1/sqrt(1 + n_control/n_i)", quadrature: "Gauss-Legendre in z (48 nodes) and in the chi scale (32 panels x 16 nodes)", correlations: bs.map((b, index) => ({ group: treatments[index].row.group, b })) }],
      artifacts: bundle.artifacts,
    };
  },
  linkage: {
    neededWhen: "When several treatments are each compared against one designated control and comparisons among the treatments themselves are not of interest.",
    decision: "Which treatments differ from control, in the prespecified direction, with family-wise error controlled only over the many-to-one family.",
    mustShow: "Each treatment-minus-control difference with simultaneous interval and adjusted p, the control group size that anchors every contrast, the alternative direction, and the pooled error term.",
    userGoal: "Screen treatments against a control efficiently while keeping a defensible multiplicity adjustment.",
    nextActions: [
      { trigger: "treatment-versus-treatment-question", action: "switch-to-tukey-hsd-or-planned-contrasts", reason: "Dunnett's family does not cover contrasts among treatments." },
      { trigger: "control-group-small", action: "review-control-sample-size-before-interpretation", reason: "Every contrast shares the control variance, so a small control group widens all intervals." },
      { trigger: "unequal-variances", action: "run-welch-based-sensitivity-contrasts", reason: "The pooled multivariate t calibration assumes a common error variance." },
      { trigger: "reportable-control-contrasts", action: "bind-forest-figure-and-contrast-table", reason: "Direction, magnitude and adjusted evidence should be shown together." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "control", values: [10.2, 9.8, 10.5, 10.1, 9.6, 10.4, 9.9, 10.3] },
      { name: "dose 1", values: [10.9, 11.3, 10.7, 11.5, 11.0, 10.8] },
      { name: "dose 2", values: [11.8, 12.4, 11.6, 12.1, 12.7, 11.9] },
      { name: "dose 3", values: [12.9, 13.4, 12.6, 13.8, 13.1] },
    ], control: "control", outcomeLabel: "yield" },
    options: { confidenceLevel: 0.95, alternative: "two-sided" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "Many-to-one Dunnett contrasts for 1-32 treatments versus a named control using the pooled one-way error variance and deterministic numerical integration of the product-correlation multivariate t (two-sided, greater, less).",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["t statistics and differences (numpy)", "adjusted p-values (scipy.stats.dunnett and an independent scipy.integrate quadrature of the multivariate t)", "simultaneous interval bounds (scipy.stats.dunnett.confidence_interval)"], excludedOutputs: ["omnibus F", "diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera per group", "Brown-Forsythe variance homogeneity", "multivariate t boundary"], limitations: ["no unequal-variance Dunnett variant"] },
    knownGaps: ["step-down Dunnett procedures", "unequal-variance (Dunnett T3/C) variants"],
  },
};

const scheffeTest = {
  method: "scheffe_test",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA(3), outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseGroupsWithLabel(data, H, 3);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { groups } = parsed;
    const k = groups.length;
    const core = pooledCore(groups, H, budget);
    const summaries = groupSummaries(groups, H, budget);
    const fCritical = S.fQuantile(options.confidenceLevel, k - 1, core.dfWithin);
    const scheffeCritical = Math.sqrt((k - 1) * fCritical);
    const rows = pairs(k).map(([a, b]) => {
      budget.check();
      const difference = summaries[a].mean - summaries[b].mean;
      const se = Math.sqrt(core.msWithin * (1 / summaries[a].n + 1 / summaries[b].n));
      const t = difference / se;
      const f = (t * t) / (k - 1);
      const adjustedPValue = H.pFromF(f, k - 1, core.dfWithin);
      const half = scheffeCritical * se;
      return { contrast: `${groups[a].name} - ${groups[b].name}`, difference, standardError: se, statistic: f, df: core.dfWithin, lower: difference - half, upper: difference + half, adjustedPValue, significant: adjustedPValue < 1 - options.confidenceLevel };
    });
    const bundle = pairwiseArtifacts(H, S, options, parsed, rows, "scheffe-table", "pairwise-difference-forest", "Scheffe pairwise contrasts", `Scheffe F-protected contrasts on ${parsed.outcomeLabel}; the same critical value covers every linear contrast.`, ["Statistic is F = t^2 / (k - 1) compared with F(k - 1, df); intervals use sqrt((k - 1) F_crit) * SE."], "contrastRowsHash");
    return {
      sample: { n: core.n, groups: k, groupSizes: summaries.map((row) => row.n) },
      estimates: [
        { name: "pooled error mean square", estimate: core.msWithin, df: core.dfWithin },
        { name: "Scheffe critical value", estimate: scheffeCritical, fCritical, df1: k - 1, df2: core.dfWithin, level: options.confidenceLevel },
        ...summaries.map((row) => ({ name: `${row.group} mean`, estimate: row.mean, n: row.n })),
        bundle.contract,
      ],
      tests: [omnibusTest("One-way ANOVA (omnibus)", core, H), ...rows.map((row) => ({ name: `Scheffe: ${row.contrast}`, statistic: row.statistic, distribution: "F", df1: k - 1, df2: row.df, pValue: row.adjustedPValue }))],
      confidenceIntervals: rows.map((row) => ({ parameter: row.contrast, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Scheffe simultaneous (all contrasts)" })),
      effectSizes: [{ name: "eta squared", estimate: core.ssBetween / core.ssTotal }],
      assumptions: baseAssumptions([{ name: "equal variances (pooled MSE)", status: "diagnostic_attached" }]),
      diagnostics: [...normalityDiagnostics(groups, H, budget), H.leveneDiagnostic(groups, budget), { name: "multiplicity boundary", status: "all_linear_contrasts_protected", note: "Scheffe intervals are wider than Tukey for pairwise-only families; use them when contrasts were chosen after seeing the data." }],
      artifacts: bundle.artifacts,
    };
  },
  linkage: {
    neededWhen: "When contrasts among group means were chosen after inspecting the data, or when complex (non-pairwise) contrasts must be protected by the same critical value.",
    decision: "Whether a data-driven or complex contrast survives the most conservative simultaneous protection over all possible linear contrasts.",
    mustShow: "The pairwise differences with Scheffe intervals, the F-based critical value, the pooled error term, and an explicit statement that this protection covers every contrast, not only the pairs shown.",
    userGoal: "Defend exploratory or complex contrasts against the reviewer objection that they were selected post hoc.",
    nextActions: [
      { trigger: "pairwise-only-prespecified", action: "switch-to-tukey-hsd-for-tighter-intervals", reason: "Scheffe over-protects when only pairwise comparisons were planned." },
      { trigger: "complex-contrast-needed", action: "specify-contrast-weights-and-reuse-scheffe-critical-value", reason: "The same critical value applies to any contrast with weights summing to zero." },
      { trigger: "reportable-contrasts", action: "bind-forest-figure-and-contrast-table", reason: "Wide intervals should be visible so readers see the cost of post-hoc selection." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "A", values: [21.4, 22.1, 20.8, 23.0, 21.7, 22.5] },
      { name: "B", values: [24.2, 25.1, 23.8, 24.7, 25.6] },
      { name: "C", values: [27.9, 26.8, 28.3, 27.4, 28.8, 27.1] },
    ], outcomeLabel: "strength" },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "All pairwise Scheffe contrasts for 3-64 groups using the pooled one-way error mean square, the (k-1) F critical value and F-distribution adjusted p-values.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["Scheffe F statistics, adjusted p-values, critical value and simultaneous interval bounds (numpy plus scipy.stats.f first-principles oracle)"], excludedOutputs: ["omnibus F", "diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera per group", "Brown-Forsythe variance homogeneity"], limitations: ["no outlier screen"] },
    knownGaps: ["user-specified complex contrast weights"],
  },
};

// ---------------------------------------------------------------------------------
// Unbalanced two-way ANOVA with Type II and Type III sums of squares.
// ---------------------------------------------------------------------------------

const twoWayAnovaUnbalanced = {
  method: "two_way_anova_unbalanced",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "factorA", "factorB"],
    properties: {
      y: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } },
      factorA: { type: "array", minItems: 8, maxItems: 100000, items: { type: "string", minLength: 1, maxLength: 128 } },
      factorB: { type: "array", minItems: 8, maxItems: 100000, items: { type: "string", minLength: 1, maxLength: 128 } },
      outcomeLabel: LABEL_SCHEMA, factorALabel: LABEL_SCHEMA, factorBLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "factorA", "factorB", "outcomeLabel", "factorALabel", "factorBLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 8);
    const factorA = H.categoryVector(data.factorA, "data.factorA", 8);
    const factorB = H.categoryVector(data.factorB, "data.factorB", 8);
    if (factorA.length !== y.length || factorB.length !== y.length) H.fail("STAT_INVALID_INPUT", "two_way_anova_unbalanced factor vectors must match data.y length");
    const levelsA = levelsOf(factorA);
    const levelsB = levelsOf(factorB);
    if (levelsA.length < 2 || levelsB.length < 2 || levelsA.length > 16 || levelsB.length > 16) H.fail("STAT_INVALID_INPUT", "two_way_anova_unbalanced requires 2 to 16 levels in each factor");
    const cellCounts = new Map();
    for (let index = 0; index < y.length; index += 1) {
      const key = `${factorA[index]}\u0000${factorB[index]}`;
      cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    }
    for (const a of levelsA) for (const b of levelsB) if (!cellCounts.has(`${a}\u0000${b}`)) H.fail("STAT_INVALID_INPUT", `two_way_anova_unbalanced requires every factor-level combination to be observed; cell ${a} x ${b} is empty`);
    const dfError = y.length - levelsA.length * levelsB.length;
    if (dfError < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "two_way_anova_unbalanced needs more observations than cells to estimate error variance");
    return {
      y, factorA, factorB, levelsA, levelsB,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
      factorALabel: H.label(data.factorALabel, "Factor A", "data.factorALabel"),
      factorBLabel: H.label(data.factorBLabel, "Factor B", "data.factorBLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { y, factorA, factorB, levelsA, levelsB } = parsed;
    const n = y.length;
    const ones = y.map(() => [1]);
    const colsA = sumToZeroColumns(factorA, levelsA);
    const colsB = sumToZeroColumns(factorB, levelsB);
    const colsAB = interactionColumns(colsA, colsB);
    const fit = (...blocks) => S.olsFit(y, bindColumns(n, ones, ...blocks), budget);
    const full = fit(colsA, colsB, colsAB);
    const dfA = levelsA.length - 1;
    const dfB = levelsB.length - 1;
    const dfAB = dfA * dfB;
    const dfError = n - levelsA.length * levelsB.length;
    const mse = full.rss / dfError;
    if (!(mse > 0)) H.fail("STAT_DEGENERATE", "two_way_anova_unbalanced within-cell variance is zero");
    const rssAB = fit(colsA, colsB).rss;
    const rssA = fit(colsA).rss;
    const rssB = fit(colsB).rss;
    const rssNoA3 = fit(colsB, colsAB).rss;
    const rssNoB3 = fit(colsA, colsAB).rss;
    const labelAB = `${parsed.factorALabel} × ${parsed.factorBLabel}`;
    const typeII = [
      { ssType: "II", source: parsed.factorALabel, ...nestedF(rssB, rssAB, dfA, mse, dfError, H) },
      { ssType: "II", source: parsed.factorBLabel, ...nestedF(rssA, rssAB, dfB, mse, dfError, H) },
      { ssType: "II", source: labelAB, ...nestedF(rssAB, full.rss, dfAB, mse, dfError, H) },
    ];
    const typeIII = [
      { ssType: "III", source: parsed.factorALabel, ...nestedF(rssNoA3, full.rss, dfA, mse, dfError, H) },
      { ssType: "III", source: parsed.factorBLabel, ...nestedF(rssNoB3, full.rss, dfB, mse, dfError, H) },
      { ssType: "III", source: labelAB, ...nestedF(rssAB, full.rss, dfAB, mse, dfError, H) },
    ];
    const errorRow = { ssType: "residual", source: "Residual", ss: full.rss, df: dfError, ms: mse, statistic: null, pValue: null, partialEtaSquared: null };
    const anovaRows = [...typeII, ...typeIII, errorRow];
    const cellRows = [];
    const cellGroups = [];
    for (const a of levelsA) {
      for (const b of levelsB) {
        budget.check();
        const values = y.filter((_, index) => factorA[index] === a && factorB[index] === b);
        cellGroups.push({ name: `${a} × ${b}`, values });
        cellRows.push({ factorA: a, factorB: b, n: values.length, mean: H.mean(values, budget), standardError: values.length > 1 ? Math.sqrt(H.variance(values, true, budget) / values.length) : null });
      }
    }
    const cellSizes = cellRows.map((row) => row.n);
    const balanced = new Set(cellSizes).size === 1;
    const anovaColumns = [{ key: "ssType", label: "SS type", type: "string" }, ...ANOVA_COLUMNS];
    return {
      sample: { n, factorALevels: levelsA.length, factorBLevels: levelsB.length, cells: cellRows.length, cellSizes, balanced, residualDf: dfError },
      estimates: [
        { name: "residual mean square", estimate: mse, df: dfError },
        { name: "grand mean (sum-to-zero intercept)", estimate: full.beta[0] },
        { name: "renderer data contract", ...rendererContract(cellRows, "cell-means-table", "interaction-plot", "cellMeanRowsHash", H) },
      ],
      tests: [...typeII, ...typeIII].map((row) => ({ name: `Two-way ANOVA (Type ${row.ssType}): ${row.source}`, statistic: row.statistic, distribution: "F", df1: row.df, df2: dfError, pValue: row.pValue, sumOfSquares: `Type ${row.ssType}` })),
      confidenceIntervals: [],
      effectSizes: [...typeII, ...typeIII].map((row) => ({ name: `${row.source} partial eta squared (Type ${row.ssType})`, estimate: row.partialEtaSquared })),
      assumptions: [
        { name: "all factor-level cells observed", status: "verified_by_input_contract" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "normal within-cell residuals", status: "diagnostic_attached" },
        { name: "variance homogeneity across cells", status: "diagnostic_attached" },
      ],
      diagnostics: [
        { name: "balance", status: balanced ? "balanced" : "unbalanced", minCell: Math.min(...cellSizes), maxCell: Math.max(...cellSizes), interpretation: balanced ? "Type II and Type III coincide for balanced data" : "Type II tests main effects assuming no interaction; Type III tests each effect adjusted for all others under sum-to-zero contrasts" },
        { name: "Jarque-Bera normality of residuals", ...H.jarqueBera(full.residuals, budget) },
        H.leveneDiagnostic(cellGroups, budget),
        { name: "sum-of-squares boundary", status: "type_ii_and_type_iii_sum_to_zero", unsupported: ["empty cells", "Type I sequential SS", "random or mixed effects", "covariates"] },
      ],
      artifacts: [
        H.tableArtifact("Unbalanced two-way analysis of variance", `Type II and Type III sums of squares for ${parsed.outcomeLabel} by ${parsed.factorALabel}, ${parsed.factorBLabel} and their interaction (sum-to-zero contrasts).`, anovaColumns, anovaRows, ["Both SS types share the full-model residual mean square; the interaction SS is identical under both types."], "two-way-unbalanced-anova-table"),
        H.tableArtifact("Cell means", "Observed cell counts, means and standard errors.", [
          { key: "factorA", label: parsed.factorALabel, type: "string" }, { key: "factorB", label: parsed.factorBLabel, type: "string" }, { key: "n", label: "N", type: "number" }, { key: "mean", label: "Mean", type: "number" }, { key: "standardError", label: "SE", type: "number" },
        ], cellRows, ["SE is null for singleton cells."], "cell-means-table"),
        H.vegaArtifact("interaction-plot", `${parsed.factorALabel} × ${parsed.factorBLabel} interaction`, { data: { values: cellRows }, mark: { type: "line", point: true }, encoding: { x: { field: "factorA", type: "nominal", title: parsed.factorALabel }, y: { field: "mean", type: "quantitative", title: `Mean ${parsed.outcomeLabel}` }, color: { field: "factorB", type: "nominal", title: parsed.factorBLabel }, detail: { field: "factorB" }, tooltip: [{ field: "factorA" }, { field: "factorB" }, { field: "mean", format: ".5g" }, { field: "standardError", format: ".4g" }, { field: "n" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two crossed categorical factors are studied with unequal cell sizes, so that main effects and the interaction are no longer orthogonal and the sum-of-squares type changes the answer.",
    decision: "Whether each main effect and the interaction is supported under the SS type that matches the hypothesis (Type II when interaction is negligible, Type III otherwise).",
    mustShow: "Cell counts and means, the interaction plot, both Type II and Type III tables with the shared residual term, partial eta squared, and an explicit statement of the contrast coding.",
    userGoal: "Report a factorial result from observational or unbalanced experimental data that a reviewer familiar with SS types will accept.",
    nextActions: [
      { trigger: "interaction-supported", action: "report-type-iii-and-estimate-simple-effects", reason: "Main effects averaged over an interacting factor are not interpretable on their own." },
      { trigger: "interaction-negligible", action: "report-type-ii-main-effects", reason: "Type II has more power for main effects when the interaction can be dropped." },
      { trigger: "severe-imbalance-or-sparse-cells", action: "review-cell-support-and-consider-collapsing-levels", reason: "Cells with one or two observations make the error term and interaction fragile." },
      { trigger: "reportable-factorial-result", action: "bind-interaction-figure-and-ss-table", reason: "The figure and the SS-type choice must travel together." },
    ],
  },
  fixture: {
    data: {
      y: [12.3, 11.8, 13.1, 14.6, 15.2, 13.9, 14.8, 16.1, 17.3, 16.5, 18.2, 19.4, 18.7, 20.1, 21.3, 11.5, 15.9],
      factorA: ["low", "low", "low", "low", "high", "high", "high", "high", "high", "low", "low", "high", "high", "high", "high", "low", "low"],
      factorB: ["ctrl", "ctrl", "ctrl", "drug", "ctrl", "ctrl", "drug", "drug", "drug", "drug", "drug", "ctrl", "drug", "drug", "drug", "ctrl", "ctrl"],
      outcomeLabel: "response", factorALabel: "dose", factorBLabel: "treatment",
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova", "matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Two crossed fixed factors (2-16 levels each) with every cell observed; Type II and Type III sums of squares from nested OLS fits under sum-to-zero contrasts with the interaction retained, partial eta squared, cell means.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["Type II and Type III SS, df, F and p for both main effects and the interaction (statsmodels anova_lm on C(., Sum) formula)", "residual SS and df", "cell means (numpy)"], excludedOutputs: ["diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["balance", "Jarque-Bera normality of residuals", "Brown-Forsythe variance homogeneity across cells"], limitations: ["no influence measures"] },
    knownGaps: ["empty cells", "Type I sequential SS", "three or more factors", "post-hoc simple effects"],
  },
};

module.exports = { methods: [ancova, repeatedMeasuresAnova, tukeyHsd, gamesHowell, dunnettTest, scheffeTest, twoWayAnovaUnbalanced] };
