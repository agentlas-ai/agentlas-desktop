---
name: astrometric-kinematics
description: Derive uncertainty-aware distance and transverse-velocity results from a bounded astrometric table without imputing missing measurements.
---

# Astrometric Kinematics

1. Preserve the exact source table or provider-response SHA-256 and pass it as `source_content_sha256`.
2. Project no more than 500 unique objects. Every row must carry explicit values or `null` for parallax, parallax error, both proper-motion components, and the proper-motion error ellipse.
3. Use the SIMBAD convention `pmra = mu_alpha*cos(dec)`. The error-ellipse position angle is measured north through east in `[0, 180)` degrees.
4. Call `analyze_astrometric_kinematics`. The calculation performs no network access and cannot execute arbitrary code.
5. Treat inverse-parallax distance as a bounded descriptive estimator, not a Bayesian distance. Do not use excluded rows for inference; review every `exclusionReasons` value.
6. Keep the returned input, algorithm, table, figure, and result hashes with any manuscript export. The FigureSpec is data, not proof that a Vega-Lite renderer or image exporter ran.

## Scientific boundary

The tool reconstructs proper-motion component covariance from the supplied error ellipse, then uses first-order delta propagation and a two-sided normal 95% interval. It assumes zero parallax/proper-motion covariance because that covariance is not present in the input. Missing uncertainties remain null. Nonpositive parallaxes and rows exceeding the declared fractional-error thresholds are excluded from inference, although available point estimates remain visible where mathematically defined.
