---
name: analyze
description: Run deterministic local descriptive, explicit probability-distribution fitting, inferential, nonparametric, regression, bounded Gaussian random-intercept mixed-model, two-factor response-surface, survival, multivariate PCA, time-series diagnostic, contingency, correction, and confidence-interval analyses with publication artifacts and diagnostics.
---

# Run Statistical Analysis

1. Confirm the estimand, unit of analysis, pairing/grouping, outcome scale, predictors, and missing-data policy from the research plan.
2. Construct one strict `agentlas.science.statistics.request/v1` object. Never paste values from an unverified visual; use a bound dataset artifact.
3. Call `run_statistical_analysis`. Do not hand-calculate or invent a result when the tool rejects input.
4. Inspect the primary test, confidence interval, effect size, assumptions, diagnostics, warnings, artifact receipts, and result receipt.
5. Preserve the returned table and Vega-Lite artifacts as derived project artifacts, linked to the exact input dataset and request hash.
6. Report material assumption problems and convergence failures alongside the result. A small p value does not establish scientific importance.
7. For exact rank inference, inspect the returned eligibility boundary and method; never relabel an asymptotic result as exact. For categorical regression, preserve the declared reference level and expanded term names.
8. For probability-distribution fitting, require the researcher to name the candidate families. Preserve the zero-location convention, support checks, every Q-Q/P-P row hash, and the fitted-parameter KS boundary. Never turn the descriptive KS D into a p value or accept/reject decision without a calibrated bootstrap or validated family-specific correction.
9. For Poisson regression, preserve the exposure or fixed-one log-offset semantics and the complete fitted-row hash. Treat the 1.5 Pearson-dispersion limit as a screen, not as an automatic replacement-model rule.
10. For PCA, declare correlation or covariance scaling, preserve the requested component count and exact score-row hash, and treat KMO/Bartlett as adequacy screens rather than automatic retention rules.
11. For time series, verify equal spacing and the declared difference order. Treat the trend, ACF/PACF, white-noise bounds, and final-lag Ljung-Box output as diagnostics; they are not a stationarity test, ARIMA fit, or forecast.
12. For meta-analysis, verify a common effect scale and direction, independent studies, and exactly one positive standard error or variance per study. Report both tau-squared estimators, the selected random-effects estimator, heterogeneity, prediction interval, leave-one-out sensitivity, and the Egger/funnel interpretation boundary.
13. For response surfaces, require exactly two explicitly center/half-range coded factors and keep all observations inside the declared coded domain. Preserve the exact observed coordinates, residuals, prediction grid, convex hull, support mask, and lineage hashes. Never interpret a masked cell as observed support or claim extrapolation, optimization, or automatic scaling.
14. For Gaussian random-intercept LMMs, first answer five research questions in order: when repeated or clustered dependence makes the method necessary; which population effect the researcher must decide; which group sizes, coding, variance components, ICC, fixed-effect intervals, BLUPs, and residual diagnostics must be shown; what claim or design decision the researcher wants to make; and which source-row review, sensitivity analysis, Figure Lab action, or manuscript binding should follow. Require one explicit grouping variable, a continuous outcome, a fixed intercept, complete rows, at least five groups with at least two observations each, and explicit treatment coding for every categorical fixed effect. Use REML for final estimation by default and ML only for a declared fixed-structure comparison. Reject random slopes, multiple/nested/crossed grouping factors, residual correlation, weights, missing-data estimation, GLMMs, or silent OLS fallback.

## Outputs

- A deterministic statistical result with estimates, tests, confidence intervals, effect sizes, assumptions, and diagnostics.
- Typed publication-table artifacts and one or more self-contained Vega-Lite or numeric-surface source artifacts.
- Request, result, artifact, and receipt hashes suitable for provenance binding.

## Verification

- `status` must be `ok`, and `receipt.requestHash` must equal the top-level `requestHash`.
- Every artifact used in a manuscript must match its `artifactReceipts` hash and byte count.
- Regression results require a converged or non-degenerate model; failed models are not publication results.
- HC0-HC3 covariance is heteroscedasticity-consistent, not cluster-robust. Two-way ANOVA is limited to balanced complete fixed-effects cells and rejects unbalanced input.
- Distribution fitting is limited to explicit normal, zero-location lognormal, and zero-location exponential candidates. AIC/BIC do not establish absolute fit, and fitted-parameter KS D has no reported p value or decision.
- Poisson regression is limited to a log link, non-negative integer counts, at most 5,000 rows, and either positive exposure or an explicit log offset. It does not implement quasi-Poisson, negative-binomial, zero-inflated, GEE, mixed-effects, or Bayesian count models.
- Survival analysis is limited to right censoring. Verify censoring semantics, declared Cox tie handling, and the PH screen boundary before manuscript use.
- PCA is complete-case numeric decomposition only; it does not supply rotation, factor analysis, missing-data estimation, MANOVA, or component-retention uncertainty.
- Time-series diagnostics require complete even spacing and do not supply ADF/KPSS, ARIMA/SARIMA, state-space, seasonal, spectral, change-point, or forecast models.
- Meta-analysis consumes already-computed study effects. It does not derive effect sizes from raw arms, fit meta-regression or dependent-effect models, apply Hartung-Knapp/profile/bootstrap/Bayesian intervals, or turn Egger/funnel asymmetry into a publication-bias conclusion.
- Response-surface regression is one fixed six-term two-factor quadratic model. It does not supply a third factor, automatic coding or term selection, ridge analysis, desirability optimization, robust or clustered covariance, mixed models, uncertainty bands, adaptive design, or extrapolation outside the observed convex hull.
- Gaussian random-intercept LMM is a bounded one-grouping-factor model, not a general `fitlme`, `lmer`, or `lme` replacement. Verify convergence, the fixed-design rank and condition boundary, the singular-fit boundary, ML/REML purpose, residual `n - p` Student-t inference, categorical reference levels, group-size distribution, variance components, ICC, conditional BLUP uncertainty, and every exact row hash before publication. Satterthwaite, Kenward-Roger, random-slope, covariance-structure, and variance-component hypothesis tests are not implemented.
- Method choice and study-design assumptions remain researcher decisions even when numeric execution succeeds.
