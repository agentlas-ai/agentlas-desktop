"use strict";

/**
 * Colour–magnitude / Hertzsprung–Russell diagram: absolute magnitudes from
 * parallax with a fractional-error guard and optional extinction/reddening,
 * first-order uncertainties in both axes, comparison against a caller-declared
 * main-sequence locus (vertical offset and its significance), and a CMD figure
 * with error bars and the locus.
 *
 * The locus is supplied explicitly (colour, absolute magnitude pairs) so that the
 * result never depends on an embedded, unverifiable calibration table.
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-colour-magnitude-diagram-result/v1";
const FIVE_OVER_LN10 = 5 / Math.LN10;
const EXTINCTION_MODES = ["none", "uniform", "per-row"];
const EXCLUSION_REASONS = common.deepFreeze([
  "user-excluded", "parallax-missing", "parallax-nonpositive", "parallax-error-missing", "parallax-fractional-error-exceeded",
  "magnitude-missing", "magnitude-error-missing", "colour-missing", "colour-error-missing", "extinction-missing", "reddening-missing",
]);
const LIMITS = common.deepFreeze({ minRows: 1, maxRows: 5000, maxLocusPoints: 500 });
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.colour-magnitude-diagram",
  version: "1.0.0",
  absoluteMagnitude: "M = m + 5 log10(parallax[mas]) - 10 - A_band; sigma_M^2 = sigma_m^2 + (5 / ln 10)^2 (sigma_parallax / parallax)^2 + sigma_A^2",
  intrinsicColour: "(colour)_0 = colour - E(colour); sigma^2 = sigma_colour^2 + sigma_E^2",
  guard: "rows with sigma_parallax / parallax above the declared threshold are reported but excluded from the diagram and the locus comparison",
  locusComparison: "the declared locus (colour, M) is linearly interpolated at each intrinsic colour inside its colour range; delta M = M - M_locus(colour_0); significance = delta M / sqrt(sigma_M^2 + (dM_locus/dcolour)^2 sigma_colour^2)",
  classification: "above-locus when delta M < -threshold (brighter), below-locus when delta M > threshold, on-locus otherwise; threshold = max(3 sigma, declared locusToleranceMag)",
  references: [
    { title: "Estimating distances from parallaxes", authors: "C. A. L. Bailer-Jones", journal: "PASP 127, 994 (2015)", doi: "10.1086/683116" },
    { title: "Gaia Data Release 2: Observational Hertzsprung-Russell diagrams", authors: "Gaia Collaboration, C. Babusiaux et al.", journal: "A&A 616, A10 (2018)", doi: "10.1051/0004-6361/201832843" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "Absolute magnitudes use the naive inverse parallax; the fractional-error guard limits, but does not remove, the resulting bias, and the uncertainty is first order.",
  "Extinction and reddening are caller-declared values (none, uniform, or per row); no dust map is queried and no extinction law is applied.",
  "The main-sequence locus is a caller-declared table; the tool does not embed a calibration and the comparison is only as good as that locus and its photometric system.",
  "No evolutionary tracks, isochrones, binarity, or metallicity dependence are modelled; a locus offset is a screen, not a classification.",
]);

function normalizeInput(input) {
  const code = "astronomy-cmd-input-invalid";
  common.exactObject(input, ["sourceContentSha256", "sampleId", "bandName", "colourName", "maxFractionalParallaxError", "extinction", "locus", "locusToleranceMag", "measurements"], code);
  common.requiredOwn(input, ["sourceContentSha256", "sampleId", "bandName", "colourName", "measurements"], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-cmd-source-hash-invalid");
  const sampleId = common.text(input.sampleId, "astronomy-cmd-sample-id-invalid", 500);
  const bandName = common.text(input.bandName, "astronomy-cmd-band-name-invalid", 40);
  const colourName = common.text(input.colourName, "astronomy-cmd-colour-name-invalid", 40);
  const maxFractionalParallaxError = common.optional(input.maxFractionalParallaxError, 0.2, (value) => common.number(value, "astronomy-cmd-threshold-invalid", 0.01, 1));
  const extinction = common.optional(input.extinction, { mode: "none" }, (value) => {
    common.exactObject(value, ["mode", "extinctionMag", "extinctionErrorMag", "reddeningMag", "reddeningErrorMag"], "astronomy-cmd-extinction-invalid");
    common.requiredOwn(value, ["mode"], "astronomy-cmd-extinction-invalid");
    const mode = common.enumeration(value.mode, EXTINCTION_MODES, "astronomy-cmd-extinction-invalid");
    if (mode !== "uniform") {
      if (Object.keys(value).length !== 1) throw new AstronomyDataError("astronomy-cmd-extinction-invalid", "only mode is accepted unless mode is uniform");
      return { mode };
    }
    common.requiredOwn(value, ["extinctionMag", "reddeningMag"], "astronomy-cmd-extinction-invalid");
    return {
      mode,
      extinctionMag: common.number(value.extinctionMag, "astronomy-cmd-extinction-invalid", 0, 50),
      extinctionErrorMag: common.optional(value.extinctionErrorMag, 0, (entry) => common.number(entry, "astronomy-cmd-extinction-invalid", 0, 50)),
      reddeningMag: common.number(value.reddeningMag, "astronomy-cmd-extinction-invalid", -5, 50),
      reddeningErrorMag: common.optional(value.reddeningErrorMag, 0, (entry) => common.number(entry, "astronomy-cmd-extinction-invalid", 0, 50)),
    };
  });
  const locus = common.optional(input.locus, null, (value) => {
    if (value === null) return null;
    common.exactObject(value, ["label", "points"], "astronomy-cmd-locus-invalid");
    common.requiredOwn(value, ["label", "points"], "astronomy-cmd-locus-invalid");
    if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > LIMITS.maxLocusPoints) throw new AstronomyDataError("astronomy-cmd-locus-invalid", `locus needs 2 through ${LIMITS.maxLocusPoints} points`);
    const points = value.points.map((point, index) => {
      common.exactObject(point, ["colour", "absoluteMagnitude"], `astronomy-cmd-locus-point-${index}-invalid`);
      common.requiredOwn(point, ["colour", "absoluteMagnitude"], `astronomy-cmd-locus-point-${index}-invalid`);
      return { colour: common.number(point.colour, `astronomy-cmd-locus-point-${index}-invalid`, -10, 10), absoluteMagnitude: common.number(point.absoluteMagnitude, `astronomy-cmd-locus-point-${index}-invalid`, -30, 40) };
    });
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].colour <= points[index - 1].colour) throw new AstronomyDataError("astronomy-cmd-locus-invalid", "locus colours must be strictly increasing");
    }
    return { label: common.text(value.label, "astronomy-cmd-locus-invalid", 160), points };
  });
  const locusToleranceMag = common.optional(input.locusToleranceMag, 0.25, (value) => common.number(value, "astronomy-cmd-locus-tolerance-invalid", 0, 10));
  if (!Array.isArray(input.measurements) || input.measurements.length < LIMITS.minRows || input.measurements.length > LIMITS.maxRows) {
    throw new AstronomyDataError("astronomy-cmd-measurements-invalid", `measurements must contain ${LIMITS.minRows} through ${LIMITS.maxRows} rows`);
  }
  const measurements = input.measurements.map((row, index) => {
    const rowCode = `astronomy-cmd-row-${index}`;
    common.exactObject(row, ["objectId", "parallaxMas", "parallaxErrorMas", "magnitude", "magnitudeError", "colour", "colourError", "extinctionMag", "reddeningMag", "use"], `${rowCode}-invalid`);
    common.requiredOwn(row, ["objectId", "parallaxMas", "parallaxErrorMas", "magnitude", "magnitudeError", "colour", "colourError", "use"], `${rowCode}-invalid`);
    return {
      objectId: common.text(row.objectId, `${rowCode}-object-id-invalid`, 160),
      parallaxMas: common.nullableNumber(row.parallaxMas, `${rowCode}-parallax-invalid`, -1e4, 1e4),
      parallaxErrorMas: common.nullableNumber(row.parallaxErrorMas, `${rowCode}-parallax-error-invalid`, 0, 1e4, { minimumExclusive: true }),
      magnitude: common.nullableNumber(row.magnitude, `${rowCode}-magnitude-invalid`, -30, 40),
      magnitudeError: common.nullableNumber(row.magnitudeError, `${rowCode}-magnitude-error-invalid`, 0, 10, { minimumExclusive: true }),
      colour: common.nullableNumber(row.colour, `${rowCode}-colour-invalid`, -10, 10),
      colourError: common.nullableNumber(row.colourError, `${rowCode}-colour-error-invalid`, 0, 10, { minimumExclusive: true }),
      extinctionMag: common.optional(row.extinctionMag, null, (value) => common.nullableNumber(value, `${rowCode}-extinction-invalid`, 0, 50)),
      reddeningMag: common.optional(row.reddeningMag, null, (value) => common.nullableNumber(value, `${rowCode}-reddening-invalid`, -5, 50)),
      use: common.boolean(row.use, `${rowCode}-use-invalid`),
    };
  }).sort((left, right) => common.compareText(left.objectId, right.objectId));
  common.uniqueIds(measurements, "objectId", "astronomy-cmd-duplicate-object-id");
  return { sourceContentSha256, sampleId, bandName, colourName, maxFractionalParallaxError, extinction, locus, locusToleranceMag, measurements };
}

function interpolateLocus(points, colour) {
  if (colour < points[0].colour || colour > points[points.length - 1].colour) return null;
  let index = 1;
  while (index < points.length - 1 && points[index].colour < colour) index += 1;
  const left = points[index - 1];
  const right = points[index];
  const slope = (right.absoluteMagnitude - left.absoluteMagnitude) / (right.colour - left.colour);
  return { absoluteMagnitude: left.absoluteMagnitude + slope * (colour - left.colour), slope };
}

function analyzeColourMagnitudeDiagram(input) {
  const normalized = normalizeInput(input);
  const warnings = [];
  const { extinction, locus } = normalized;
  const rows = normalized.measurements.map((row) => {
    const exclusionReasons = [];
    if (!row.use) exclusionReasons.push("user-excluded");
    if (row.parallaxMas === null) exclusionReasons.push("parallax-missing");
    else if (row.parallaxMas <= 0) exclusionReasons.push("parallax-nonpositive");
    if (row.parallaxErrorMas === null) exclusionReasons.push("parallax-error-missing");
    const fractionalParallaxError = row.parallaxMas !== null && row.parallaxMas > 0 && row.parallaxErrorMas !== null ? row.parallaxErrorMas / row.parallaxMas : null;
    if (fractionalParallaxError !== null && fractionalParallaxError > normalized.maxFractionalParallaxError) exclusionReasons.push("parallax-fractional-error-exceeded");
    if (row.magnitude === null) exclusionReasons.push("magnitude-missing");
    if (row.magnitudeError === null) exclusionReasons.push("magnitude-error-missing");
    if (row.colour === null) exclusionReasons.push("colour-missing");
    if (row.colourError === null) exclusionReasons.push("colour-error-missing");
    let extinctionMag = 0; let extinctionErrorMag = 0; let reddeningMag = 0; let reddeningErrorMag = 0;
    if (extinction.mode === "uniform") {
      extinctionMag = extinction.extinctionMag; extinctionErrorMag = extinction.extinctionErrorMag;
      reddeningMag = extinction.reddeningMag; reddeningErrorMag = extinction.reddeningErrorMag;
    } else if (extinction.mode === "per-row") {
      if (row.extinctionMag === null) exclusionReasons.push("extinction-missing"); else extinctionMag = row.extinctionMag;
      if (row.reddeningMag === null) exclusionReasons.push("reddening-missing"); else reddeningMag = row.reddeningMag;
    }
    const eligible = exclusionReasons.length === 0;
    const distancePc = row.parallaxMas !== null && row.parallaxMas > 0 ? 1000 / row.parallaxMas : null;
    const absoluteMagnitude = eligible ? row.magnitude + 5 * Math.log10(row.parallaxMas) - 10 - extinctionMag : null;
    const absoluteMagnitudeError = eligible ? Math.sqrt(row.magnitudeError ** 2 + (FIVE_OVER_LN10 * row.parallaxErrorMas / row.parallaxMas) ** 2 + extinctionErrorMag ** 2) : null;
    const intrinsicColour = eligible ? row.colour - reddeningMag : null;
    const intrinsicColourError = eligible ? Math.sqrt(row.colourError ** 2 + reddeningErrorMag ** 2) : null;
    let locusAbsoluteMagnitude = null; let locusOffsetMag = null; let locusOffsetSigma = null; let locusClass = null;
    if (eligible && locus) {
      const interpolated = interpolateLocus(locus.points, intrinsicColour);
      if (interpolated === null) locusClass = "outside-locus-colour-range";
      else {
        locusAbsoluteMagnitude = interpolated.absoluteMagnitude;
        locusOffsetMag = absoluteMagnitude - interpolated.absoluteMagnitude;
        const combined = Math.sqrt(absoluteMagnitudeError ** 2 + (interpolated.slope * intrinsicColourError) ** 2);
        locusOffsetSigma = combined > 0 ? locusOffsetMag / combined : null;
        const threshold = Math.max(3 * combined, normalized.locusToleranceMag);
        locusClass = locusOffsetMag < -threshold ? "above-locus" : locusOffsetMag > threshold ? "below-locus" : "on-locus";
      }
    }
    return {
      objectId: row.objectId, use: row.use, parallaxMas: row.parallaxMas, parallaxErrorMas: row.parallaxErrorMas, fractionalParallaxError, distancePc,
      apparentMagnitude: row.magnitude, apparentMagnitudeError: row.magnitudeError, observedColour: row.colour, observedColourError: row.colourError,
      extinctionMag: eligible ? extinctionMag : null, reddeningMag: eligible ? reddeningMag : null,
      absoluteMagnitude, absoluteMagnitudeError, intrinsicColour, intrinsicColourError,
      locusAbsoluteMagnitude, locusOffsetMag, locusOffsetSigma, locusClass,
      diagramEligible: eligible, exclusionReasons,
    };
  });
  const eligible = rows.filter((row) => row.diagramEligible);
  if (!eligible.length) warnings.push("no-row-eligible-for-diagram");
  if (rows.some((row) => row.exclusionReasons.includes("parallax-fractional-error-exceeded"))) warnings.push("rows-excluded-by-parallax-fractional-error-guard");
  if (extinction.mode === "none" && eligible.length) warnings.push("no-extinction-correction-applied");
  if (!locus) warnings.push("no-main-sequence-locus-declared-comparison-skipped");
  else if (eligible.some((row) => row.locusClass === "outside-locus-colour-range")) warnings.push("some-rows-outside-declared-locus-colour-range");
  const classCounts = Object.fromEntries(["above-locus", "on-locus", "below-locus", "outside-locus-colour-range"].map((label) => [label, eligible.filter((row) => row.locusClass === label).length]));
  const settings = {
    sampleId: normalized.sampleId, bandName: normalized.bandName, colourName: normalized.colourName, maxFractionalParallaxError: normalized.maxFractionalParallaxError,
    extinction, locus: locus ? { label: locus.label, pointCount: locus.points.length, colourRange: [locus.points[0].colour, locus.points[locus.points.length - 1].colour] } : null,
    locusToleranceMag: normalized.locusToleranceMag,
  };
  const summary = {
    inputRows: rows.length, diagramEligibleRows: eligible.length, excludedRows: rows.length - eligible.length,
    exclusionCounts: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, rows.filter((row) => row.exclusionReasons.includes(reason)).length])),
    locusClassCounts: locus ? classCounts : null,
    absoluteMagnitudeRange: eligible.length ? [Math.min(...eligible.map((row) => row.absoluteMagnitude)), Math.max(...eligible.map((row) => row.absoluteMagnitude))] : null,
    intrinsicColourRange: eligible.length ? [Math.min(...eligible.map((row) => row.intrinsicColour)), Math.max(...eligible.map((row) => row.intrinsicColour))] : null,
    medianAbsoluteMagnitudeError: eligible.length ? common.median(eligible.map((row) => row.absoluteMagnitudeError)) : null,
  };
  const table = common.publicationTable(`${normalized.sampleId}: ${normalized.colourName} versus M_${normalized.bandName}`, [
    { key: "objectId", label: "Object", unit: null, datatype: "string" },
    { key: "distancePc", label: "Distance (1/parallax)", unit: "pc", datatype: "number|null" },
    { key: "apparentMagnitude", label: `m_${normalized.bandName}`, unit: "mag", datatype: "number|null" },
    { key: "absoluteMagnitude", label: `M_${normalized.bandName}`, unit: "mag", datatype: "number|null" },
    { key: "absoluteMagnitudeError", label: `M_${normalized.bandName} s.e.`, unit: "mag", datatype: "number|null" },
    { key: "intrinsicColour", label: `(${normalized.colourName})_0`, unit: "mag", datatype: "number|null" },
    { key: "intrinsicColourError", label: `(${normalized.colourName})_0 s.e.`, unit: "mag", datatype: "number|null" },
    { key: "extinctionMag", label: `A_${normalized.bandName}`, unit: "mag", datatype: "number|null" },
    { key: "locusOffsetMag", label: "Delta M from locus", unit: "mag", datatype: "number|null" },
    { key: "locusOffsetSigma", label: "Delta M / sigma", unit: null, datatype: "number|null" },
    { key: "locusClass", label: "Locus position", unit: null, datatype: "string|null" },
    { key: "diagramEligible", label: "Diagram eligible", unit: null, datatype: "boolean" },
    { key: "exclusionReasons", label: "Exclusion reasons", unit: null, datatype: "string[]" },
  ], rows.map((row) => ({
    objectId: row.objectId, distancePc: row.distancePc, apparentMagnitude: row.apparentMagnitude, absoluteMagnitude: row.absoluteMagnitude, absoluteMagnitudeError: row.absoluteMagnitudeError,
    intrinsicColour: row.intrinsicColour, intrinsicColourError: row.intrinsicColourError, extinctionMag: row.extinctionMag, locusOffsetMag: row.locusOffsetMag, locusOffsetSigma: row.locusOffsetSigma,
    locusClass: row.locusClass, diagramEligible: row.diagramEligible, exclusionReasons: row.exclusionReasons,
  })), [
    `Absolute magnitudes from naive inverse parallax with sigma_parallax/parallax <= ${normalized.maxFractionalParallaxError}; extinction mode: ${extinction.mode}.`,
    locus ? `Locus comparison against "${locus.label}" (${locus.points.length} declared points); negative Delta M means brighter than the locus.` : "No locus declared; no comparison performed.",
    "Uncertainties are first-order combinations of photometric, parallax, and declared extinction errors.",
  ]);
  const yTitle = `M_${normalized.bandName} (mag)`;
  const xTitle = `(${normalized.colourName})_0 (mag)`;
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.sampleId}: colour-magnitude diagram`,
    `Colour-magnitude diagram of ${eligible.length} stars: intrinsic ${normalized.colourName} against absolute ${normalized.bandName} magnitude (axis reversed) with horizontal and vertical one-sigma error bars${locus ? `, the declared main-sequence locus "${locus.label}" as a line, and points coloured by locus position` : ""}.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "Colour-magnitude diagram with error bars and declared locus.",
      width: 640, height: 460,
      layer: [
        ...(locus ? [{ data: { values: locus.points.map((point, order) => ({ ...point, order })) }, mark: { type: "line", color: "#9CA3AF", strokeWidth: 1.6 },
          encoding: { x: { field: "colour", type: "quantitative", title: xTitle }, y: { field: "absoluteMagnitude", type: "quantitative", title: yTitle, scale: { reverse: true } }, order: { field: "order", type: "quantitative" } } }] : []),
        { data: { values: eligible.map((row) => ({ objectId: row.objectId, intrinsicColour: row.intrinsicColour, lower: row.intrinsicColour - row.intrinsicColourError, upper: row.intrinsicColour + row.intrinsicColourError, absoluteMagnitude: row.absoluteMagnitude })) },
          mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
          encoding: { x: { field: "lower", type: "quantitative", title: xTitle }, x2: { field: "upper" }, y: { field: "absoluteMagnitude", type: "quantitative", title: yTitle, scale: { reverse: true } } } },
        { data: { values: eligible.map((row) => ({ objectId: row.objectId, intrinsicColour: row.intrinsicColour, lower: row.absoluteMagnitude - row.absoluteMagnitudeError, upper: row.absoluteMagnitude + row.absoluteMagnitudeError })) },
          mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
          encoding: { x: { field: "intrinsicColour", type: "quantitative" }, y: { field: "lower", type: "quantitative", scale: { reverse: true } }, y2: { field: "upper" } } },
        { data: { values: eligible.map((row) => ({ objectId: row.objectId, intrinsicColour: row.intrinsicColour, absoluteMagnitude: row.absoluteMagnitude, locusClass: row.locusClass ?? "no-locus", locusOffsetMag: row.locusOffsetMag, distancePc: row.distancePc })) },
          mark: { type: "point", filled: true, size: 56, stroke: "#FFFFFF", strokeWidth: 0.7 },
          encoding: {
            x: { field: "intrinsicColour", type: "quantitative", title: xTitle }, y: { field: "absoluteMagnitude", type: "quantitative", title: yTitle, scale: { reverse: true } },
            color: { field: "locusClass", type: "nominal", title: "Locus position", scale: { domain: ["above-locus", "on-locus", "below-locus", "outside-locus-colour-range", "no-locus"], range: ["#C2415D", "#255C99", "#D97706", "#9CA3AF", "#255C99"] } },
            tooltip: [{ field: "objectId", type: "nominal", title: "Object" }, { field: "intrinsicColour", type: "quantitative", title: xTitle, format: ".4f" }, { field: "absoluteMagnitude", type: "quantitative", title: yTitle, format: ".4f" }, { field: "locusOffsetMag", type: "quantitative", title: "Delta M (mag)", format: ".3f" }, { field: "distancePc", type: "quantitative", title: "Distance (pc)", format: ".4g" }],
          } },
      ],
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA, algorithm: ALGORITHM, normalizedInput: normalized, sourceContentSha256: normalized.sourceContentSha256,
    sections: { settings, summary, warnings, boundaries: BOUNDARIES, rows, locus },
    table, buildFigure,
  });
}

module.exports = {
  CMD_ALGORITHM: ALGORITHM,
  CMD_BOUNDARIES: BOUNDARIES,
  CMD_EXTINCTION_MODES: EXTINCTION_MODES,
  CMD_LIMITS: LIMITS,
  CMD_SCHEMA: SCHEMA,
  analyzeColourMagnitudeDiagram,
  interpolateLocus,
};
