# Statistics method modules

Every file listed in `index.cjs` `MODULE_FILES` is a family module that exports `{ methods: [definition, ...] }`.
The engine, the JSON request contract, the research-decision linkage, the coverage manifest, the MATLAB
parity manifest, and the product-level figure/table coverage contract are all derived from these definitions,
so a new method never edits `engine.cjs`.

## Hard rules

1. **No `require("../engine.cjs")`** (circular). Everything numeric arrives through the `H` helper object
   (see `HELPERS` in `engine.cjs`: validation, distributions, matrices, OLS, artifacts, `sha256`, …).
   Modules may `require` only `node:` builtins and sibling files inside `runtime/methods/`.
2. **Pure JavaScript, deterministic, no network, no filesystem, no Date/Math.random.** Same request ⇒ byte-identical result.
   Use a seeded generator (e.g. SplitMix64/xoshiro on `BigInt`) with a `seed` custom option for any resampling.
3. **Fail closed** with `H.fail("STAT_INVALID_INPUT" | "STAT_DEGENERATE" | "STAT_LIMIT_EXCEEDED" | "STAT_NON_CONVERGENCE" | "STAT_SINGULAR_FIT" | "STAT_RANK_DEFICIENT" | "STAT_INSUFFICIENT_SAMPLE", message)`.
   Never return NaN/Infinity silently; validate shapes with `H.assertKeys` / `H.numericVector` / `H.label`.
4. Call `budget.check()` inside loops so the worker timeout stays deterministic.
5. `analyze` returns `{ sample, estimates, tests, confidenceIntervals, effectSizes, assumptions, diagnostics, artifacts }`
   with **at least one `H.tableArtifact(...)` and one `H.vegaArtifact(...)`**. Every artifact must pass `H.validateArtifact`
   (Vega-Lite v6 spec only, inline `data.values`, no URLs, no `transform` that re-derives what the table already states).
   Rows in Vega `data.values` must be the exact rows the tables report — the renderer contract forbids re-derivation.
6. Every diagnostic that reports a boundary must say so (`status: "not_established" | "asymptotic" | "requires_design_review" …`).
   Do not emit APA prose; emit typed fields (`statistic`, `df`, `pValue`, `estimate`, `lower`, `upper`, `method`).
7. Each method needs an **independent Python oracle** (`contracts/<module>-scipy-crosscheck.py`, scipy/numpy/statsmodels/
   lifelines/pingouin/sklearn are available locally) and a node contract (`contracts/<module>-contract.cjs`) that
   (a) runs every method of the module through `engine.analyze` on fixed fixtures, (b) asserts numeric agreement with
   the oracle to a stated tolerance, (c) asserts determinism (`resultHash` identical on rerun), (d) asserts fail-closed
   rejections (`assert.throws` with the exact code), (e) prints one JSON summary line. The node contract spawns the
   python oracle with `spawnSync("python3", [...])` and compares JSON; if `python3` or a library is absent it must
   print `{"skipped": true, "reason": ...}` and exit 0 only for the oracle part, never for the deterministic checks.
8. `coverage.oracle.evidence` must name the python file; `verifiedOutputs` / `excludedOutputs` must be truthful.
   `coverage.implementedBoundary`, `knownGaps`, and every string must avoid the forbidden claims
   (`R/MATLAB parity`, `complete validation`, `journal-grade`).
9. `fixture` is one realistic request (`data`, optional `options`) with ≥ 8 observations that exercises the common path.
10. `matlabParity.taxonomyIds` ⊂ `matlab.stats.*` ids (see `index.cjs`).
11. Keep each module under ~2,500 lines; split families if needed (add the file name to `MODULE_FILES`).

## Definition template

```js
"use strict";

const tukeyHsd = {
  method: "tukey_hsd",
  family: "anova",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    // key: { schema: <json-schema>, default, parse(value, H, path) }
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["groups"],
    properties: {
      groups: { type: "array", minItems: 3, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } } } } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "outcomeLabel"], "data");
    const groups = H.parseGroups({ groups: data.groups }, 3);
    return { groups, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    // ... numeric work using H.anovaCore, H.pFromF, H.tCritical, etc.
    return {
      sample: { groups: parsed.groups.length, n: total },
      estimates: [...],
      tests: [...],
      confidenceIntervals: [...],
      effectSizes: [...],
      assumptions: [...],
      diagnostics: [...],
      artifacts: [H.tableArtifact("Tukey HSD pairwise contrasts", "…", columns, rows, notes, "tukey-hsd-table"), H.vegaArtifact("tukey-hsd-contrasts", "…", spec)],
    };
  },
  linkage: {
    neededWhen: "…", decision: "…", mustShow: "…", userGoal: "…",
    nextActions: [{ trigger: "…", action: "…", reason: "…" }],
  },
  fixture: { data: { groups: [...] }, options: { confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "…",
    oracle: { level: "external-library-partial", evidence: ["contracts/anova-extended-scipy-crosscheck.py"], verifiedOutputs: ["…"], excludedOutputs: ["…"] },
    diagnostic: { level: "method-specific-partial", emitted: ["…"], limitations: ["…"] },
    knownGaps: ["…"],
  },
};

module.exports = { methods: [tukeyHsd] };
```

## Verify locally

```bash
node -e 'const e=require("./runtime/engine.cjs");console.log(e.METHODS.length, e.METHOD_REGISTRY.files)'
node contracts/<module>-contract.cjs
node contracts/statistics-contract.cjs            # core still green
node contracts/decision-linkage-contract.cjs
node ../../scripts/science-statistics-manifests.cjs --write   # regenerate derived manifests (owner runs this last)
```
