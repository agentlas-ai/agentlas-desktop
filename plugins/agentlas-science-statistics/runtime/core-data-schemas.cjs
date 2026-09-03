"use strict";

/**
 * Declared data shapes for the CORE statistical methods.
 *
 * The extension methods each declare a `dataSchema` in the method registry, and that declaration is
 * what lets an uploaded Data Table be projected into the shape a method needs -- 139 of 147 of them.
 * The 31 core methods declare nothing: they parse their input imperatively in `engine.cjs`, inside
 * one long switch. So the analyses a researcher reaches for FIRST -- a t-test, a correlation, a
 * linear regression, a chi-square -- could not be run on a table they uploaded. Six could, through
 * projections written by hand one method at a time; twenty-five could not.
 *
 * These are the same shapes the parser already accepts, written down. Writing a fact down twice is
 * how the copies drift, so this file is not trusted: `science-statistics-core-projection-contract`
 * builds data from every schema here, projects it through the real projector, and RUNS the method.
 * A schema that disagrees with the parser fails there rather than reaching a researcher.
 *
 * Shapes, all of which the declared projector already understands:
 *   - `values` / `x` / `y` / `time` / `pValues`  : a flat column
 *   - `groups` / `predictors` / `variables`      : one named series per column, or a long layout
 *   - `studies`                                  : one entry per row, a column per field
 *   - `table`                                    : a count matrix, one column per matrix column
 *   - labels and options                         : a declared parameter
 */

const numbers = (minItems) => ({ type: "array", minItems, maxItems: 100_000, items: { type: "number" } });
const text = { type: "string", minLength: 1, maxLength: 128 };
const namedSeries = (minEntries, minValues) => ({
  type: "array",
  minItems: minEntries,
  maxItems: 64,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "values"],
    properties: { name: text, values: numbers(minValues) },
  },
});
const schema = (required, properties) => ({ type: "object", additionalProperties: false, required, properties });

/** Two paired columns, plus their display names. */
const paired = schema(["x", "y"], { x: numbers(3), y: numbers(3), xLabel: text, yLabel: text });

/** Two or more groups of measurements. `exact` pins a two-sample test to two. */
const groups = (minimum) => schema(["groups"], { groups: namedSeries(minimum, 2) });

/**
 * An outcome column and one named series per predictor.
 *
 * The outcome's own constraint is part of the shape, not a detail of the parser: a logistic
 * regression needs 0/1 and a Poisson regression needs non-negative counts. Declaring only "numbers"
 * would let the screen offer any numeric column and let the projection build data the method then
 * refuses -- which is exactly what the core-projection contract caught when this said `numbers(4)`
 * for all three.
 */
const regression = (outcome) => schema(["y", "predictors"], {
  y: outcome,
  predictors: namedSeries(1, 4),
  outcomeLabel: text,
  exposure: numbers(4),
  logOffset: numbers(4),
});
const continuousOutcome = numbers(4);
const binaryOutcome = { type: "array", minItems: 4, maxItems: 100_000, items: { type: "integer", minimum: 0, maximum: 1 } };
const countOutcome = { type: "array", minItems: 4, maxItems: 100_000, items: { type: "integer", minimum: 0 } };

const CORE_DATA_SCHEMAS = Object.freeze({
  descriptive: schema(["values"], { values: numbers(2), label: text }),
  confidence_interval: schema(["values"], { values: numbers(2), label: text }),
  // `candidates` is a CHOICE, not a column: it names which distributions to fit, and no cell of a
  // researcher's table holds it. Declared as an enum-backed list so the screen offers the options
  // beside the value column, which is the only way this method is reachable from a table at all.
  distribution_fit: schema(["values", "candidates"], {
    values: numbers(8),
    label: text,
    candidates: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["normal", "lognormal", "exponential"] } },
  }),

  pearson_correlation: paired,
  spearman_correlation: paired,
  kendall_correlation: paired,
  paired_t_test: paired,
  wilcoxon_signed_rank: paired,

  independent_t_test: groups(2),
  welch_t_test: groups(2),
  mann_whitney_u: groups(2),
  one_way_anova: groups(2),
  kruskal_wallis: groups(2),

  linear_regression: regression(continuousOutcome),
  logistic_regression: regression(binaryOutcome),
  poisson_regression: regression(countOutcome),

  two_way_anova: schema(["y", "factorA", "factorB"], {
    y: numbers(4),
    // Factor levels are labels, so they arrive as a text column rather than a number column.
    factorA: { type: "array", minItems: 4, maxItems: 100_000, items: { type: "string" } },
    factorB: { type: "array", minItems: 4, maxItems: 100_000, items: { type: "string" } },
    outcomeLabel: text,
    factorALabel: text,
    factorBLabel: text,
  }),

  chi_square_test: schema(["table"], {
    table: { type: "array", minItems: 2, maxItems: 64, items: { type: "array", minItems: 2, maxItems: 64, items: { type: "integer", minimum: 0 } } },
    rowLabels: { type: "array", minItems: 2, maxItems: 64, items: text },
    columnLabels: { type: "array", minItems: 2, maxItems: 64, items: text },
  }),

  multiple_testing_correction: schema(["pValues"], {
    // The range is part of the shape. Declared as plain numbers, the screen would offer any numeric
    // column and the method would refuse the projection it built.
    pValues: { type: "array", minItems: 1, maxItems: 100_000, items: { type: "number", minimum: 0, maximum: 1 } },
    labels: { type: "array", minItems: 1, maxItems: 100_000, items: text },
  }),

  principal_component_analysis: schema(["variables"], {
    variables: namedSeries(2, 3),
    rowLabels: { type: "array", minItems: 3, maxItems: 100_000, items: text },
  }),

  time_series_diagnostics: schema(["values"], {
    values: numbers(8),
    time: numbers(8),
    seriesLabel: text,
    timeLabel: text,
  }),

  cox_proportional_hazards: schema(["time", "event", "predictors"], {
    time: numbers(4),
    event: binaryOutcome,
    predictors: namedSeries(1, 4),
    outcomeLabel: text,
  }),

  // These six had a projection written by hand in the gateway, so the ENGINE could reach them from a
  // table -- but the method picker offers only methods with a declared shape, so the screen never
  // did. Declaring them puts them on the same general path as everything else; the bespoke
  // projections stay in place for artifacts already saved against them.
  welch_one_way_anova: groups(2),
  friedman_test: schema(["conditions"], { conditions: namedSeries(3, 2) }),
  fisher_exact_test: schema(["table"], {
    // Exactly 2x2 -- the parser refuses anything else, and a screen that offered a third column
    // would be building a request the method rejects.
    table: { type: "array", minItems: 2, maxItems: 2, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 0 } } },
    rowLabels: { type: "array", minItems: 2, maxItems: 2, items: text },
    columnLabels: { type: "array", minItems: 2, maxItems: 2, items: text },
  }),
  roc_curve_analysis: schema(["outcomes", "scores"], {
    outcomes: { type: "array", minItems: 4, maxItems: 100_000, items: { type: "integer", minimum: 0, maximum: 1 } },
    scores: numbers(4),
    outcomeLabel: text,
    scoreLabel: text,
  }),
  gaussian_random_intercept_lmm: schema(["y", "groups"], {
    y: numbers(12),
    // The grouping column is labels -- subject, site, batch -- so it is a text column, not numbers.
    // Five distinct groups minimum, two observations each: that is what a random intercept is
    // estimated from, and the parser refuses fewer.
    groups: { type: "array", minItems: 12, maxItems: 100_000, minDistinct: 5, items: { type: "string" } },
    predictors: namedSeries(1, 12),
    outcomeLabel: text,
    groupLabel: text,
  }),

  log_rank_test: schema(["groups"], {
    // Two arms exactly -- the parser refuses a third, so the declaration says two. A survival sheet
    // is one row per subject (time, event, arm), which the grouped-columns mapping projects.
    groups: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "time", "event"],
        properties: { name: text, time: numbers(2), event: binaryOutcome },
      },
    },
  }),

  meta_analysis: schema(["studies"], {
    studies: {
      type: "array",
      minItems: 2,
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "effect", "standardError"],
        properties: { label: text, effect: { type: "number" }, standardError: { type: "number" } },
      },
    },
    effectLabel: text,
    nullValue: { type: "number" },
  }),
});

module.exports = { CORE_DATA_SCHEMAS };
