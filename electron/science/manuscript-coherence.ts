import { createHash } from "node:crypto";
import {
  SCIENCE_MANUSCRIPT_COHERENCE_SCHEMA,
  type EvaluateScienceManuscriptCoherenceInput,
  type ScienceCoherenceNumericAssertionInput,
  type ScienceCoherenceNumericExemptionInput,
  type ScienceCoherenceTextOwner,
  type ScienceManuscriptCoherenceContext,
  type ScienceManuscriptCoherenceFinding,
  type ScienceManuscriptCoherenceReport,
} from "../../shared/science-manuscript-coherence";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

type ExactDecimal = { coefficient: bigint; scale: number };
type ParsedNumeric = { grammar: ScienceCoherenceNumericAssertionInput["grammar"]; values: ExactDecimal[]; qualifier: string };

const DECIMAL_SOURCE = String.raw`[+\-−]?(?:(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?|\.\d+)(?:[eE][+\-−]?\d+)?`;
const EFFECT_PATTERN = new RegExp(String.raw`^\s*(OR|HR|RR|IRR|MD|SMD|RD|β|beta)\s*=\s*(${DECIMAL_SOURCE})\s*$`, "iu");
const CI_PATTERN = new RegExp(String.raw`^\s*(${DECIMAL_SOURCE})\s*(?:%|percent)\s*(?:CI|confidence\s+interval)\s*[:,=]?\s*([\[(])\s*(${DECIMAL_SOURCE})\s*(?:,|to|–|—|~)\s*(${DECIMAL_SOURCE})\s*([\])])\s*$`, "iu");
const QUANTITY_PATTERN = new RegExp(String.raw`^\s*(${DECIMAL_SOURCE})\s*([^\s].{0,31})\s*$`, "u");
const UNIT_ALIASES = new Map<string, string>([
  ["%", "%"], ["percent", "%"], ["µm", "um"], ["μm", "um"], ["um", "um"], ["°C", "°C"], ["K", "K"],
  ["ms", "ms"], ["s", "s"], ["min", "min"], ["h", "h"], ["d", "d"], ["nm", "nm"], ["mm", "mm"], ["cm", "cm"],
  ["m", "m"], ["km", "km"], ["mg", "mg"], ["g", "g"], ["kg", "kg"], ["mL", "mL"], ["L", "L"], ["Hz", "Hz"],
  ["kHz", "kHz"], ["MHz", "MHz"], ["Pa", "Pa"], ["kPa", "kPa"], ["MPa", "MPa"], ["m/s", "m/s"],
  ["mg/kg", "mg/kg"], ["copies/mL", "copies/mL"],
]);

function decimal(value: string): ExactDecimal {
  const raw = value.trim();
  if (raw.length < 1 || raw.length > 128 || !new RegExp(`^${DECIMAL_SOURCE}$`, "u").test(raw)) {
    throw new Error("science-coherence-number-invalid");
  }
  const normalized = raw.replace(/−/gu, "-").replace(/,/gu, "").replace(/^\+/u, "");
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [mantissa, exponentText] = unsigned.split(/[eE]/u);
  const exponent = exponentText === undefined ? 0 : Number(exponentText.replace(/−/gu, "-"));
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) throw new Error("science-coherence-number-exponent-invalid");
  const [whole = "0", fraction = ""] = mantissa!.split(".");
  const digits = `${whole || "0"}${fraction}`;
  if (digits.length + Math.max(0, exponent - fraction.length) > 10_000) throw new Error("science-coherence-number-too-large");
  let coefficient = BigInt(`${negative ? "-" : ""}${digits}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizedDecimal({ coefficient, scale });
}

function normalizedDecimal(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return { coefficient, scale };
}

function exactDecimalEqual(left: ExactDecimal, right: ExactDecimal): boolean {
  const a = normalizedDecimal(left);
  const b = normalizedDecimal(right);
  return a.coefficient === b.coefficient && a.scale === b.scale;
}

function roundedDecimalEqual(source: ExactDecimal, target: ExactDecimal): boolean {
  if (target.scale >= source.scale) return exactDecimalEqual(source, target);
  const divisor = 10n ** BigInt(source.scale - target.scale);
  const absolute = source.coefficient < 0n ? -source.coefficient : source.coefficient;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const signed = source.coefficient < 0n ? -rounded : rounded;
  return signed === target.coefficient;
}

function parseNumeric(quote: string, grammar: ScienceCoherenceNumericAssertionInput["grammar"]): ParsedNumeric {
  if (grammar === "sample-size/v1") {
    const match = new RegExp(String.raw`^\s*[Nn]\s*=\s*(${DECIMAL_SOURCE})\s*$`, "u").exec(quote);
    if (!match) throw new Error("science-coherence-sample-size-invalid");
    const value = decimal(match[1]!);
    if (value.scale !== 0 || value.coefficient <= 0n) throw new Error("science-coherence-sample-size-invalid");
    return { grammar, values: [value], qualifier: "n" };
  }
  if (grammar === "effect-estimate/v1") {
    const match = EFFECT_PATTERN.exec(quote);
    if (!match) throw new Error("science-coherence-effect-invalid");
    return { grammar, values: [decimal(match[2]!)], qualifier: match[1]!.toUpperCase() };
  }
  if (grammar === "confidence-interval/v1") {
    const match = CI_PATTERN.exec(quote);
    if (!match) throw new Error("science-coherence-confidence-interval-invalid");
    if ((match[2] === "[" && match[5] !== "]") || (match[2] === "(" && match[5] !== ")")) {
      throw new Error("science-coherence-confidence-interval-bracket-invalid");
    }
    const level = decimal(match[1]!);
    if (level.coefficient <= 0n || level.scale !== 0 || level.coefficient >= 100n) {
      throw new Error("science-coherence-confidence-interval-level-invalid");
    }
    const lower = decimal(match[3]!);
    const upper = decimal(match[4]!);
    const factor = 10n ** BigInt(Math.max(lower.scale, upper.scale));
    const lowerScaled = lower.coefficient * (factor / (10n ** BigInt(lower.scale)));
    const upperScaled = upper.coefficient * (factor / (10n ** BigInt(upper.scale)));
    if (lowerScaled > upperScaled) throw new Error("science-coherence-confidence-interval-order-invalid");
    return { grammar, values: [level, lower, upper], qualifier: "CI" };
  }
  const match = QUANTITY_PATTERN.exec(quote);
  if (!match) throw new Error("science-coherence-quantity-unit-invalid");
  const unit = UNIT_ALIASES.get(match[2]!.normalize("NFKC"));
  if (!unit) throw new Error("science-coherence-quantity-unit-unsupported");
  return { grammar, values: [decimal(match[1]!)], qualifier: unit };
}

function ownerKey(owner: ScienceCoherenceTextOwner): string {
  return owner.kind === "claim" ? `claim:${owner.claimId}` : `visual:${owner.nodeId}`;
}

function expectedComponentRoles(grammar: ScienceCoherenceNumericAssertionInput["grammar"]): string[] {
  return grammar === "confidence-interval/v1" ? ["confidence-level", "lower", "upper"] : ["value"];
}

function normalizedUnit(value: string | null): string | null {
  if (value === null) return null;
  return UNIT_ALIASES.get(value.normalize("NFKC")) ?? null;
}

function ownerText(context: ScienceManuscriptCoherenceContext, owner: ScienceCoherenceTextOwner): string {
  if (owner.kind === "claim") {
    const claim = context.claims.find((candidate) => candidate.claimId === owner.claimId);
    if (!claim || claim.claimContentSha256 !== owner.claimContentSha256) throw new Error("science-coherence-claim-owner-stale");
    return claim.exactText;
  }
  const visual = context.visuals.find((candidate) => candidate.nodeId === owner.nodeId);
  if (!visual || visual.nodeRevision !== owner.nodeRevision || visual.nodeContentSha256 !== owner.nodeContentSha256) {
    throw new Error("science-coherence-visual-owner-stale");
  }
  return visual.caption;
}

function exactSpan(
  context: ScienceManuscriptCoherenceContext,
  input: Pick<ScienceCoherenceNumericAssertionInput | ScienceCoherenceNumericExemptionInput, "owner" | "from" | "to" | "exactQuote">,
): string {
  const text = ownerText(context, input.owner);
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from < 0 || input.to <= input.from
    || input.to > text.length || text.slice(input.from, input.to) !== input.exactQuote) {
    throw new Error("science-coherence-exact-quote-mismatch");
  }
  return text;
}

function evidenceSubset(target: string[], sources: string[]): boolean {
  const sourceSet = new Set(sources);
  return target.every((signature) => sourceSet.has(signature));
}

function numericTokens(text: string): Array<{ from: number; to: number; text: string }> {
  const result: Array<{ from: number; to: number; text: string }> = [];
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_])${DECIMAL_SOURCE}(?![\p{L}\p{N}_])`, "gu");
  for (const match of text.matchAll(pattern)) result.push({ from: match.index!, to: match.index! + match[0].length, text: match[0] });
  return result;
}

function manuscriptVisualNumericTokens(text: string): Array<{ from: number; to: number; text: string }> {
  // Figure/Table ordinals are generated presentation labels, not scientific values.
  // Keep every other caption numeral subject to the exact assertion/exemption gate.
  return numericTokens(text).filter((token) => !/(?:^|\s)(?:fig(?:ure)?|table)\s*$/iu.test(text.slice(0, token.from)));
}

function exemptionValid(value: ScienceCoherenceNumericExemptionInput): boolean {
  if (value.reason === "calendar-year") return /^(?:1[5-9]\d{2}|20\d{2}|21\d{2})$/u.test(value.exactQuote.trim());
  if (value.reason === "citation-number") return /^\[\d+(?:\s*[-,]\s*\d+)*\]$/u.test(value.exactQuote.trim());
  return /^[A-Za-z][A-Za-z0-9._-]*\d[A-Za-z0-9._-]*$/u.test(value.exactQuote.trim());
}

export function evaluateScienceManuscriptCoherence(
  input: EvaluateScienceManuscriptCoherenceInput,
  context: ScienceManuscriptCoherenceContext,
): ScienceManuscriptCoherenceReport {
  if (new Set(input.summaryClaimLinks.map((link) => link.summaryClaimId)).size !== input.summaryClaimLinks.length
    || input.summaryClaimLinks.some((link) => new Set(link.bodyClaimIds).size !== link.bodyClaimIds.length)
    || new Set(input.resultsDiscussionLinks.map((link) => link.resultClaimId)).size !== input.resultsDiscussionLinks.length
    || input.resultsDiscussionLinks.some((link) => new Set(link.discussionClaimIds).size !== link.discussionClaimIds.length)) {
    throw new Error("science-coherence-link-duplicated");
  }
  const numericSpans = new Map<string, Array<{ from: number; to: number }>>();
  for (const declaration of [...input.numericAssertions, ...input.numericExemptions]) {
    const key = ownerKey(declaration.owner);
    numericSpans.set(key, [...(numericSpans.get(key) ?? []), { from: declaration.from, to: declaration.to }]);
  }
  for (const spans of numericSpans.values()) {
    const ordered = [...spans].sort((left, right) => left.from - right.from || left.to - right.to);
    if (ordered.some((span, index) => index > 0 && span.from < ordered[index - 1]!.to)) {
      throw new Error("science-coherence-numeric-span-overlap");
    }
  }
  const findings: ScienceManuscriptCoherenceFinding[] = [];
  const claims = new Map(context.claims.map((claim) => [claim.claimId, claim]));
  const contextNumericSources = context.numericSources ?? [];
  const numericSources = new Map(contextNumericSources.map((source) => [source.selectorSha256, source]));
  if (numericSources.size !== contextNumericSources.length) throw new Error("science-coherence-numeric-source-duplicate");
  findings.push({ code: "claim-ledger-ready", severity: "error", status: context.claimLedger.ready ? "pass" : "fail", ownerId: null,
    observed: context.claimLedger.ready ? "ready" : "blocked", required: "the exact current claim ledger gate must be ready" });

  const summaryLinks = new Map(input.summaryClaimLinks.map((link) => [link.summaryClaimId, link.bodyClaimIds]));
  for (const claim of context.claims.filter((candidate) => ["abstract", "conclusion"].includes(candidate.sectionRole)
    && candidate.claimClass !== "non-factual")) {
    const bodyIds = summaryLinks.get(claim.claimId) ?? [];
    const body = bodyIds.map((id) => claims.get(id)).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const validBodies = body.length === bodyIds.length && body.length > 0
      && body.every((candidate) => !["abstract", "conclusion"].includes(candidate.sectionRole));
    findings.push({ code: "summary-claim-body-link", severity: "error", status: validBodies ? "pass" : "fail", ownerId: claim.claimId,
      observed: `${body.length}/${bodyIds.length} exact non-summary body claims`, required: "at least one exact current body claim" });
    const subset = validBodies && evidenceSubset(claim.evidenceSignatures, body.flatMap((candidate) => candidate.evidenceSignatures));
    findings.push({ code: "summary-claim-evidence-subset", severity: "error", status: subset ? "pass" : "fail", ownerId: claim.claimId,
      observed: `${claim.evidenceSignatures.length} summary evidence signatures`, required: "no evidence outside the linked body-claim union" });
  }

  const discussionTargets = new Set<string>();
  const resultLinks = new Map(input.resultsDiscussionLinks.map((link) => [link.resultClaimId, link.discussionClaimIds]));
  for (const result of context.claims.filter((claim) => claim.sectionRole === "results" && claim.claimClass === "result")) {
    const ids = resultLinks.get(result.claimId) ?? [];
    const discussion = ids.map((id) => claims.get(id)).filter((value): value is NonNullable<typeof value> => Boolean(value));
    discussion.forEach((claim) => discussionTargets.add(claim.claimId));
    const valid = discussion.length === ids.length && discussion.length > 0
      && discussion.every((claim) => claim.sectionRole === "discussion" && ["result", "inference"].includes(claim.claimClass));
    findings.push({ code: "results-discussion-link", severity: "error", status: valid ? "pass" : "fail", ownerId: result.claimId,
      observed: `${discussion.length}/${ids.length} exact Discussion claims`, required: "at least one exact result or inference claim in Discussion" });
    const shared = valid && discussion.every((claim) => claim.evidenceSignatures.some((signature) => result.evidenceSignatures.includes(signature)));
    findings.push({ code: "results-discussion-shared-evidence", severity: "error", status: shared ? "pass" : "fail", ownerId: result.claimId,
      observed: shared ? "shared exact evidence closure" : "no shared exact evidence closure", required: "each linked Discussion claim must share evidence with Results" });
  }
  for (const discussion of context.claims.filter((claim) => claim.sectionRole === "discussion" && ["result", "inference"].includes(claim.claimClass))) {
    if (!discussionTargets.has(discussion.claimId)) findings.push({ code: "results-discussion-link", severity: "error", status: "fail", ownerId: discussion.claimId,
      observed: "unlinked Discussion claim", required: "every Discussion result or inference must link back to Results" });
  }

  const assertions = input.numericAssertions.map((assertion) => {
    exactSpan(context, assertion);
    let parsed: ParsedNumeric | null = null;
    try { parsed = parseNumeric(assertion.exactQuote, assertion.grammar); } catch { /* finding below */ }
    const claimOwner = assertion.owner.kind === "claim"
      ? claims.get(assertion.owner.claimId) ?? null
      : null;
    const ownerEligible = assertion.owner.kind === "visual-caption"
      || Boolean(claimOwner && claimOwner.claimClass !== "non-factual" && claimOwner.status !== "not-applicable");
    const valid = Boolean(parsed && ownerEligible);
    findings.push({ code: "numeric-assertion-valid", severity: "error", status: valid ? "pass" : "fail", ownerId: ownerKey(assertion.owner),
      observed: !parsed ? assertion.exactQuote : !ownerEligible ? "numeric assertion owned by a non-factual or not-applicable claim"
        : `${assertion.grammar}:${parsed.qualifier}`,
      required: `a valid ${assertion.grammar} exact quote owned by an evidence-eligible claim or visual caption` });
    const declaredSources = assertion.sources ?? [];
    const expectedRoles = expectedComponentRoles(assertion.grammar);
    const orderedSources = [...declaredSources].sort((left, right) => expectedRoles.indexOf(left.componentRole) - expectedRoles.indexOf(right.componentRole));
    const resolved = orderedSources.map((selector) => numericSources.get(sha256Json(selector)) ?? null);
    const sourceRolesExact = orderedSources.length === expectedRoles.length
      && orderedSources.every((selector, index) => selector.componentRole === expectedRoles[index]);
    const sourceValuesExact = Boolean(parsed && sourceRolesExact && resolved.every(Boolean)
      && resolved.every((source) => source!.allowedOwnerKeys.includes(ownerKey(assertion.owner)))
      && parsed.values.length === resolved.length
      && parsed.values.every((value, index) => {
        const source = resolved[index]!;
        let sourceValue: ExactDecimal;
        try { sourceValue = decimal(source.canonicalDecimal); } catch { return false; }
        return assertion.presentation === "rounded" ? roundedDecimalEqual(sourceValue, value) : exactDecimalEqual(sourceValue, value);
      })
      && (assertion.grammar !== "quantity-unit/v1"
        || (resolved[0]!.canonicalUnit !== null && normalizedUnit(resolved[0]!.canonicalUnit) === parsed!.qualifier)));
    findings.push({ code: "numeric-source-exact", severity: "error", status: sourceValuesExact ? "pass" : "fail",
      ownerId: ownerKey(assertion.owner), observed: sourceValuesExact
        ? resolved.map((source) => `${source!.selector.artifactId}@${source!.selector.artifactVersion}${source!.selector.jsonPointer}`).join(", ")
        : `${resolved.filter(Boolean).length}/${expectedRoles.length} exact reachable source component(s)`,
      required: `host-resolved ${expectedRoles.join(", ")} values from an exact validated run-bound artifact` });
    return { input: assertion, parsed, sourceValuesExact,
      sourceKeys: orderedSources.map((selector) => sha256Json(selector)) };
  });
  const groups = new Map<string, typeof assertions>();
  for (const assertion of assertions) groups.set(assertion.input.groupId, [...(groups.get(assertion.input.groupId) ?? []), assertion]);
  for (const [groupId, members] of groups) {
    const baseline = members.find((member) => member.input.presentation === "exact" && member.parsed)?.parsed ?? members[0]?.parsed ?? null;
    const baselineSourceKeys = members[0]?.sourceKeys ?? [];
    const consistent = Boolean(baseline && members.every((member) => member.parsed && member.sourceValuesExact
      && JSON.stringify(member.sourceKeys) === JSON.stringify(baselineSourceKeys)
      && member.parsed.grammar === baseline.grammar && member.parsed.qualifier === baseline.qualifier
      && member.parsed.values.length === baseline.values.length
      && member.parsed.values.every((value, index) => member.input.presentation === "rounded"
        ? roundedDecimalEqual(baseline.values[index]!, value)
        : exactDecimalEqual(baseline.values[index]!, value))));
    findings.push({ code: "numeric-group-consistent", severity: "error", status: consistent ? "pass" : "fail", ownerId: groupId,
      observed: `${members.length} assertion(s)`, required: "same exact artifact source components, grammar, qualifier, unit and exact or deterministic half-away-from-zero rounded decimals" });
  }

  for (const exemption of input.numericExemptions) {
    exactSpan(context, exemption);
    if (!exemptionValid(exemption)) throw new Error("science-coherence-numeric-exemption-invalid");
  }
  const coveredByOwner = new Map<string, Array<{ from: number; to: number }>>();
  for (const item of [...input.numericAssertions, ...input.numericExemptions]) {
    const key = ownerKey(item.owner);
    coveredByOwner.set(key, [...(coveredByOwner.get(key) ?? []), { from: item.from, to: item.to }]);
  }
  const owners: Array<{ owner: ScienceCoherenceTextOwner; text: string; required: boolean }> = [
    ...context.claims.map((claim) => ({ owner: { kind: "claim" as const, claimId: claim.claimId, claimContentSha256: claim.claimContentSha256 },
      text: claim.exactText, required: claim.claimClass !== "non-factual"
        && ["abstract", "results", "discussion", "conclusion"].includes(claim.sectionRole) })),
    ...context.visuals.map((visual) => ({ owner: { kind: "visual-caption" as const, nodeId: visual.nodeId, nodeRevision: visual.nodeRevision,
      nodeContentSha256: visual.nodeContentSha256 }, text: visual.caption, required: true })),
  ];
  for (const item of owners.filter((owner) => owner.required)) {
    const ranges = coveredByOwner.get(ownerKey(item.owner)) ?? [];
    const tokens = item.owner.kind === "visual-caption" ? manuscriptVisualNumericTokens(item.text) : numericTokens(item.text);
    const uncovered = tokens.filter((token) => !ranges.some((range) => range.from <= token.from && range.to >= token.to));
    findings.push({ code: "numeric-coverage", severity: "error", status: uncovered.length ? "fail" : "pass", ownerId: ownerKey(item.owner),
      observed: uncovered.length ? `uncovered: ${uncovered.map((token) => token.text).join(", ")}` : "all numeric tokens covered",
      required: "every numeral must belong to a parsed assertion or a validated exemption" });
  }

  for (const visual of context.visuals) {
    const captionPresent = visual.caption.trim().length > 0;
    findings.push({ code: "visual-caption-present", severity: "error", status: captionPresent ? "pass" : "fail", ownerId: visual.nodeId,
      observed: captionPresent ? `${visual.caption.trim().length} caption characters` : "empty caption", required: "a non-empty manuscript caption" });
    const bindingExact = !visual.bindingRequired || (visual.binding !== null && visual.locator !== null && visual.binding.role === visual.visualKind
      && visual.binding.locator === visual.locator && visual.binding.validationPassed && visual.binding.runArtifactClosurePassed);
    findings.push({ code: "visual-binding-exact", severity: "error", status: bindingExact ? "pass" : "fail", ownerId: visual.nodeId,
      observed: bindingExact ? (visual.bindingRequired ? `${visual.binding!.artifactId}@${visual.binding!.artifactVersion}` : "inline table; artifact binding not required")
        : "missing, stale, or unvalidated artifact binding",
      required: visual.bindingRequired ? "one exact same-role/same-locator artifact, capture, passed receipt, and run-output closure"
        : "inline table integrity is closed by the manuscript document node" });
  }
  findings.push({ code: "orphan-artifact-binding", severity: "error", status: context.orphanArtifactBindingLocators.length ? "fail" : "pass", ownerId: null,
    observed: context.orphanArtifactBindingLocators.join(", ") || "none", required: "every artifact binding must own one exact manuscript visual node" });

  const findingKey = (finding: ScienceManuscriptCoherenceFinding): string => [
    finding.code,
    finding.ownerId ?? "",
    finding.severity,
    finding.status,
    finding.observed,
    finding.required,
  ].join("\u0000");
  findings.sort((left, right) => findingKey(left).localeCompare(findingKey(right)));
  const declarations = {
    summaryClaimLinks: input.summaryClaimLinks.map((link) => ({ ...link, bodyClaimIds: [...link.bodyClaimIds].sort() }))
      .sort((left, right) => left.summaryClaimId.localeCompare(right.summaryClaimId)),
    resultsDiscussionLinks: input.resultsDiscussionLinks.map((link) => ({ ...link, discussionClaimIds: [...link.discussionClaimIds].sort() }))
      .sort((left, right) => left.resultClaimId.localeCompare(right.resultClaimId)),
    numericAssertions: input.numericAssertions.map((assertion) => ({ ...assertion,
      ...(assertion.sources ? { sources: [...assertion.sources].sort((left, right) => left.componentRole.localeCompare(right.componentRole)) } : {}),
    })).sort((left, right) => `${left.groupId}:${ownerKey(left.owner)}:${left.from}:${left.to}`
      .localeCompare(`${right.groupId}:${ownerKey(right.owner)}:${right.from}:${right.to}`)),
    numericExemptions: [...input.numericExemptions].sort((left, right) => `${ownerKey(left.owner)}:${left.from}:${left.to}:${left.reason}`
      .localeCompare(`${ownerKey(right.owner)}:${right.from}:${right.to}:${right.reason}`)),
  };
  const declarationsSha256 = sha256Json(declarations);
  const referencedSourceKeys = [...new Set(input.numericAssertions.flatMap((assertion) => (assertion.sources ?? []).map(sha256Json)))].sort();
  const provenanceSources = referencedSourceKeys.map((key) => numericSources.get(key)).filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => left.selectorSha256.localeCompare(right.selectorSha256));
  const numericProvenance = { sourceCount: provenanceSources.length,
    sourceManifestSha256: sha256Json(provenanceSources.map((source) => source.contentSha256)), sources: provenanceSources };
  const status = findings.some((finding) => finding.severity === "error" && finding.status === "fail") ? "blocked" as const : "passed" as const;
  const limitations = [
    "This deterministic closure verifies exact linkage, numeric consistency, and visual binding integrity; it does not prove that a scientific interpretation is semantically true.",
  ];
  const core = { schema: SCIENCE_MANUSCRIPT_COHERENCE_SCHEMA, projectId: context.projectId, manuscript: context.manuscript,
    claimLedger: context.claimLedger, declarationsSha256, numericProvenance, findings, status, limitations };
  return { ...core, reportSha256: sha256Json(core) };
}
