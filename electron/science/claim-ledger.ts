import { createHash } from "node:crypto";
import {
  SCIENCE_CLAIM_CLASSES,
  SCIENCE_CLAIM_LEDGER_GATE_SCHEMA,
  SCIENCE_CLAIM_LEDGER_SCHEMA,
  SCIENCE_CLAIM_STATUSES,
  SCIENCE_EVIDENCE_DIRECTIONS,
  SCIENCE_EVIDENCE_LOCATOR_MEDIA,
  type ScienceArtifactEvidenceBinding,
  type ScienceCanonicalArtifactRecord,
  type ScienceCanonicalCitationRecord,
  type ScienceCanonicalEvidenceSpanRecord,
  type ScienceCanonicalManuscriptSentence,
  type ScienceCanonicalSourceRecord,
  type ScienceCanonicalValidationReceiptRecord,
  type ScienceClaimEvidenceAtom,
  type ScienceClaimLedgerGateIssue,
  type ScienceClaimLedgerManifest,
  type ScienceClaimLedgerPublicationGateReport,
  type ScienceClaimLedgerPublicationPolicy,
  type ScienceClaimLedgerValidationContext,
  type ScienceClaimLocator,
  type ScienceClaimRecord,
  type ScienceEvidenceSpanLocator,
  type ScienceManuscriptBinding,
  type ScienceValidationReceiptEvidenceBinding,
} from "../../shared/science-claim-ledger";

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const MAX_EXACT_TEXT = 64 * 1024;
const MAX_LOCATOR_TEXT = 4 * 1024;

function fail(code: string): never {
  throw new Error(`science-claim-ledger-${code}`);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    "value" in descriptor && descriptor.enumerable === true
  ));
}

function record(value: unknown, code: string): JsonRecord {
  if (!isPlainRecord(value)) fail(`${code}-invalid`);
  return value;
}

function exactKeys(value: JsonRecord, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${code}-keys-invalid`);
  }
}

function scalarString(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) fail(`${code}-invalid`);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${code}-unicode-invalid`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(`${code}-unicode-invalid`);
    }
  }
  return value;
}

function identifier(value: unknown, code: string): string {
  const result = scalarString(value, 192, code);
  if (!ID_PATTERN.test(result)) fail(`${code}-invalid`);
  return result;
}

function sectionIdentifier(value: unknown, code: string): string {
  const result = scalarString(value, 192, code);
  if (!SECTION_ID_PATTERN.test(result)) fail(`${code}-invalid`);
  return result;
}

function sha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${code}-invalid`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${code}-invalid`);
  return value as number;
}

function score(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1) fail(`${code}-invalid`);
  return value;
}

function timestamp(value: unknown, code: string): string {
  const result = scalarString(value, 64, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) || new Date(result).toISOString() !== result) {
    fail(`${code}-invalid`);
  }
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${code}-invalid`);
  return value as T;
}

function canonicalize(value: unknown, stack: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scalarString(value, Number.MAX_SAFE_INTEGER, "canonical-string", true);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("canonical-number-invalid");
    return value;
  }
  if (typeof value !== "object") fail("canonical-value-invalid");
  if (stack.has(value)) fail("canonical-cycle-invalid");
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((child) => canonicalize(child, stack));
    const input = record(value, "canonical-object");
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key], stack)]));
  } finally {
    stack.delete(value);
  }
}

export function canonicalScienceClaimLedgerJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function scienceClaimLedgerSha256(value: unknown): string {
  return createHash("sha256").update(canonicalScienceClaimLedgerJson(value), "utf8").digest("hex");
}

export function scienceClaimLedgerTextSha256(value: string): string {
  scalarString(value, Number.MAX_SAFE_INTEGER, "text", true);
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function without<T extends JsonRecord>(value: T, key: string): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function sortedUnique<T>(values: readonly T[], key: (value: T) => string, code: string, requireSorted = false): void {
  const seen = new Set<string>();
  let prior: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (seen.has(current)) fail(`${code}-duplicate`);
    if (requireSorted && prior !== null && current.localeCompare(prior) <= 0) fail(`${code}-order-invalid`);
    seen.add(current);
    prior = current;
  }
}

function assertStringArray(value: unknown, code: string, requireSorted = false): string[] {
  if (!Array.isArray(value)) fail(`${code}-invalid`);
  const result = value.map((entry) => identifier(entry, code));
  sortedUnique(result, (entry) => entry, code, requireSorted);
  return result;
}

function validateManuscriptBinding(value: unknown, code: string): ScienceManuscriptBinding {
  const input = record(value, code);
  exactKeys(input, ["manuscriptId", "projectId", "version", "contentSha256"], code);
  identifier(input.manuscriptId, `${code}-id`);
  identifier(input.projectId, `${code}-project-id`);
  integer(input.version, 1, Number.MAX_SAFE_INTEGER, `${code}-version`);
  sha256(input.contentSha256, `${code}-content-sha256`);
  return input as unknown as ScienceManuscriptBinding;
}

function validateEvidenceSpanLocator(value: unknown, code: string): ScienceEvidenceSpanLocator {
  const input = record(value, code);
  exactKeys(input, ["medium", "value"], code);
  enumValue(input.medium, SCIENCE_EVIDENCE_LOCATOR_MEDIA, `${code}-medium`);
  scalarString(input.value, MAX_LOCATOR_TEXT, `${code}-value`);
  return input as unknown as ScienceEvidenceSpanLocator;
}

function validateArtifactBinding(value: unknown, code: string): ScienceArtifactEvidenceBinding {
  const input = record(value, code);
  exactKeys(input, ["artifactId", "artifactVersion", "artifactContentSha256"], code);
  identifier(input.artifactId, `${code}-id`);
  integer(input.artifactVersion, 1, Number.MAX_SAFE_INTEGER, `${code}-version`);
  sha256(input.artifactContentSha256, `${code}-content-sha256`);
  return input as unknown as ScienceArtifactEvidenceBinding;
}

function validateReceiptBinding(value: unknown, code: string): ScienceValidationReceiptEvidenceBinding {
  const input = record(value, code);
  exactKeys(input, ["validationReceiptId", "validationReceiptVersion", "validationReceiptContentSha256"], code);
  identifier(input.validationReceiptId, `${code}-id`);
  integer(input.validationReceiptVersion, 1, Number.MAX_SAFE_INTEGER, `${code}-version`);
  sha256(input.validationReceiptContentSha256, `${code}-content-sha256`);
  return input as unknown as ScienceValidationReceiptEvidenceBinding;
}

function validateLocator(value: unknown): ScienceClaimLocator {
  const input = record(value, "locator");
  exactKeys(input, [
    "sectionId", "sectionOrdinal", "paragraphOrdinal", "sentenceOrdinal", "claimStartOffset", "claimEndOffset",
    "sentenceTextSha256", "locatorSha256",
  ], "locator");
  sectionIdentifier(input.sectionId, "locator-section-id");
  integer(input.sectionOrdinal, 0, 1_000_000, "locator-section-ordinal");
  integer(input.paragraphOrdinal, 0, 10_000_000, "locator-paragraph-ordinal");
  integer(input.sentenceOrdinal, 0, 10_000_000, "locator-sentence-ordinal");
  const start = integer(input.claimStartOffset, 0, MAX_EXACT_TEXT, "locator-start-offset");
  const end = integer(input.claimEndOffset, 1, MAX_EXACT_TEXT, "locator-end-offset");
  if (end <= start) fail("locator-range-invalid");
  sha256(input.sentenceTextSha256, "locator-sentence-text-sha256");
  const locatorHash = sha256(input.locatorSha256, "locator-sha256");
  if (scienceClaimLedgerSha256(without(input, "locatorSha256")) !== locatorHash) fail("locator-integrity-failed");
  return input as unknown as ScienceClaimLocator;
}

function validateEvidenceAtom(value: unknown): ScienceClaimEvidenceAtom {
  const input = record(value, "evidence-atom");
  exactKeys(input, [
    "evidenceAtomId", "evidenceAtomVersion", "citationId", "citationVersion", "citationContentSha256",
    "sourceId", "sourceVersionId", "sourceVersion", "sourceContentSha256", "evidenceSpanId", "evidenceSpanVersion",
    "evidenceSpanContentSha256", "evidenceSpanExactText", "evidenceSpanTextSha256", "evidenceSpanLocator", "artifact",
    "validationReceipt", "direction", "relevance", "assessmentConfidence", "contentSha256",
  ], "evidence-atom");
  identifier(input.evidenceAtomId, "evidence-atom-id");
  integer(input.evidenceAtomVersion, 1, Number.MAX_SAFE_INTEGER, "evidence-atom-version");
  identifier(input.citationId, "evidence-citation-id");
  integer(input.citationVersion, 1, Number.MAX_SAFE_INTEGER, "evidence-citation-version");
  sha256(input.citationContentSha256, "evidence-citation-sha256");
  identifier(input.sourceId, "evidence-source-id");
  identifier(input.sourceVersionId, "evidence-source-version-id");
  integer(input.sourceVersion, 1, Number.MAX_SAFE_INTEGER, "evidence-source-version");
  sha256(input.sourceContentSha256, "evidence-source-sha256");
  identifier(input.evidenceSpanId, "evidence-span-id");
  integer(input.evidenceSpanVersion, 1, Number.MAX_SAFE_INTEGER, "evidence-span-version");
  sha256(input.evidenceSpanContentSha256, "evidence-span-content-sha256");
  const exactText = scalarString(input.evidenceSpanExactText, MAX_EXACT_TEXT, "evidence-span-text");
  const textHash = sha256(input.evidenceSpanTextSha256, "evidence-span-text-sha256");
  if (scienceClaimLedgerTextSha256(exactText) !== textHash) fail("evidence-span-text-integrity-failed");
  validateEvidenceSpanLocator(input.evidenceSpanLocator, "evidence-span-locator");
  const artifact = input.artifact === null ? null : validateArtifactBinding(input.artifact, "evidence-artifact");
  const receipt = input.validationReceipt === null ? null : validateReceiptBinding(input.validationReceipt, "evidence-validation-receipt");
  if (receipt !== null && artifact === null) fail("evidence-validation-receipt-orphaned");
  enumValue(input.direction, SCIENCE_EVIDENCE_DIRECTIONS, "evidence-direction");
  score(input.relevance, "evidence-relevance");
  score(input.assessmentConfidence, "evidence-assessment-confidence");
  const contentHash = sha256(input.contentSha256, "evidence-content-sha256");
  if (scienceClaimLedgerSha256(without(input, "contentSha256")) !== contentHash) fail("evidence-integrity-failed");
  return input as unknown as ScienceClaimEvidenceAtom;
}

function validateStatusSemantics(claim: ScienceClaimRecord): void {
  const support = claim.evidence.filter((atom) => atom.direction === "support").length;
  const contradict = claim.evidence.filter((atom) => atom.direction === "contradict").length;
  if (claim.claimClass === "non-factual") {
    if (claim.status !== "not-applicable" || claim.evidence.length !== 0) fail("non-factual-semantics-invalid");
    return;
  }
  if (claim.status === "not-applicable") fail("claim-status-not-applicable-invalid");
  if (claim.status === "supported" && (support < 1 || contradict !== 0)) fail("claim-status-evidence-mismatch");
  if (claim.status === "contradicted" && (contradict < 1 || support !== 0)) fail("claim-status-evidence-mismatch");
  if (claim.status === "mixed" && (support < 1 || contradict < 1)) fail("claim-status-evidence-mismatch");
  if (claim.status === "unresolved" && (support !== 0 || contradict !== 0)) fail("claim-status-evidence-mismatch");
}

function validateClaim(value: unknown): ScienceClaimRecord {
  const input = record(value, "claim");
  exactKeys(input, [
    "claimId", "logicalClaimId", "manuscript", "locator", "exactText", "exactTextSha256", "claimClass", "status",
    "evidence", "supersedesClaimId", "supersedesClaimContentSha256", "createdAt", "contentSha256",
  ], "claim");
  identifier(input.claimId, "claim-id");
  identifier(input.logicalClaimId, "claim-logical-id");
  validateManuscriptBinding(input.manuscript, "claim-manuscript");
  validateLocator(input.locator);
  const exactText = scalarString(input.exactText, MAX_EXACT_TEXT, "claim-exact-text");
  const exactTextHash = sha256(input.exactTextSha256, "claim-exact-text-sha256");
  if (scienceClaimLedgerTextSha256(exactText) !== exactTextHash) fail("claim-exact-text-integrity-failed");
  enumValue(input.claimClass, SCIENCE_CLAIM_CLASSES, "claim-class");
  enumValue(input.status, SCIENCE_CLAIM_STATUSES, "claim-status");
  if (!Array.isArray(input.evidence)) fail("claim-evidence-invalid");
  const evidence = input.evidence.map(validateEvidenceAtom);
  sortedUnique(evidence, (atom) => atom.evidenceAtomId, "claim-evidence", true);
  if ((input.supersedesClaimId === null) !== (input.supersedesClaimContentSha256 === null)) fail("claim-supersession-pair-invalid");
  if (input.supersedesClaimId === null) {
    if (input.logicalClaimId !== input.claimId) fail("claim-root-logical-id-invalid");
  } else {
    identifier(input.supersedesClaimId, "claim-supersedes-id");
    sha256(input.supersedesClaimContentSha256, "claim-supersedes-sha256");
    if (input.supersedesClaimId === input.claimId) fail("claim-self-supersession-invalid");
  }
  timestamp(input.createdAt, "claim-created-at");
  const contentHash = sha256(input.contentSha256, "claim-content-sha256");
  if (scienceClaimLedgerSha256(without(input, "contentSha256")) !== contentHash) fail("claim-integrity-failed");
  const claim = input as unknown as ScienceClaimRecord;
  validateStatusSemantics(claim);
  return claim;
}

function validateSentence(value: unknown): ScienceCanonicalManuscriptSentence {
  const input = record(value, "canonical-sentence");
  exactKeys(input, ["sectionId", "sectionOrdinal", "paragraphOrdinal", "sentenceOrdinal", "text", "textSha256"], "canonical-sentence");
  sectionIdentifier(input.sectionId, "canonical-sentence-section-id");
  integer(input.sectionOrdinal, 0, 1_000_000, "canonical-sentence-section-ordinal");
  integer(input.paragraphOrdinal, 0, 10_000_000, "canonical-sentence-paragraph-ordinal");
  integer(input.sentenceOrdinal, 0, 10_000_000, "canonical-sentence-sentence-ordinal");
  const text = scalarString(input.text, MAX_EXACT_TEXT, "canonical-sentence-text");
  if (scienceClaimLedgerTextSha256(text) !== sha256(input.textSha256, "canonical-sentence-text-sha256")) fail("canonical-sentence-integrity-failed");
  return input as unknown as ScienceCanonicalManuscriptSentence;
}

function validateCitation(value: unknown): ScienceCanonicalCitationRecord {
  const input = record(value, "canonical-citation");
  exactKeys(input, ["citationId", "projectId", "citationVersion", "sourceId", "sourceVersionId", "evidenceSpanId", "evidenceSpanVersion", "evidenceSpanContentSha256", "contentSha256"], "canonical-citation");
  identifier(input.citationId, "canonical-citation-id");
  identifier(input.projectId, "canonical-citation-project-id");
  integer(input.citationVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-citation-version");
  identifier(input.sourceId, "canonical-citation-source-id");
  identifier(input.sourceVersionId, "canonical-citation-source-version-id");
  identifier(input.evidenceSpanId, "canonical-citation-evidence-span-id");
  integer(input.evidenceSpanVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-citation-evidence-span-version");
  sha256(input.evidenceSpanContentSha256, "canonical-citation-evidence-span-sha256");
  sha256(input.contentSha256, "canonical-citation-content-sha256");
  return input as unknown as ScienceCanonicalCitationRecord;
}

function validateSource(value: unknown): ScienceCanonicalSourceRecord {
  const input = record(value, "canonical-source");
  exactKeys(input, ["sourceId", "projectId", "sourceVersionId", "sourceVersion", "contentSha256"], "canonical-source");
  identifier(input.sourceId, "canonical-source-id");
  identifier(input.projectId, "canonical-source-project-id");
  identifier(input.sourceVersionId, "canonical-source-version-id");
  integer(input.sourceVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-source-version");
  sha256(input.contentSha256, "canonical-source-content-sha256");
  return input as unknown as ScienceCanonicalSourceRecord;
}

function validateEvidenceSpan(value: unknown): ScienceCanonicalEvidenceSpanRecord {
  const input = record(value, "canonical-evidence-span");
  exactKeys(input, [
    "evidenceSpanId", "projectId", "evidenceSpanVersion", "sourceId", "sourceVersionId", "exactText", "exactTextSha256", "locator", "contentSha256",
  ], "canonical-evidence-span");
  identifier(input.evidenceSpanId, "canonical-evidence-span-id");
  identifier(input.projectId, "canonical-evidence-span-project-id");
  integer(input.evidenceSpanVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-evidence-span-version");
  identifier(input.sourceId, "canonical-evidence-span-source-id");
  identifier(input.sourceVersionId, "canonical-evidence-span-source-version-id");
  const text = scalarString(input.exactText, MAX_EXACT_TEXT, "canonical-evidence-span-text");
  if (scienceClaimLedgerTextSha256(text) !== sha256(input.exactTextSha256, "canonical-evidence-span-text-sha256")) fail("canonical-evidence-span-text-integrity-failed");
  validateEvidenceSpanLocator(input.locator, "canonical-evidence-span-locator");
  sha256(input.contentSha256, "canonical-evidence-span-content-sha256");
  return input as unknown as ScienceCanonicalEvidenceSpanRecord;
}

function validateArtifact(value: unknown): ScienceCanonicalArtifactRecord {
  const input = record(value, "canonical-artifact");
  exactKeys(input, ["artifactId", "projectId", "artifactVersion", "contentSha256"], "canonical-artifact");
  identifier(input.artifactId, "canonical-artifact-id");
  identifier(input.projectId, "canonical-artifact-project-id");
  integer(input.artifactVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-artifact-version");
  sha256(input.contentSha256, "canonical-artifact-content-sha256");
  return input as unknown as ScienceCanonicalArtifactRecord;
}

function validateReceipt(value: unknown): ScienceCanonicalValidationReceiptRecord {
  const input = record(value, "canonical-validation-receipt");
  exactKeys(input, [
    "validationReceiptId", "projectId", "validationReceiptVersion", "artifactId", "artifactVersion", "artifactContentSha256",
    "inputSha256", "outputSha256", "contentSha256", "status",
  ], "canonical-validation-receipt");
  identifier(input.validationReceiptId, "canonical-validation-receipt-id");
  identifier(input.projectId, "canonical-validation-receipt-project-id");
  integer(input.validationReceiptVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-validation-receipt-version");
  identifier(input.artifactId, "canonical-validation-receipt-artifact-id");
  integer(input.artifactVersion, 1, Number.MAX_SAFE_INTEGER, "canonical-validation-receipt-artifact-version");
  sha256(input.artifactContentSha256, "canonical-validation-receipt-artifact-sha256");
  sha256(input.inputSha256, "canonical-validation-receipt-input-sha256");
  sha256(input.outputSha256, "canonical-validation-receipt-output-sha256");
  sha256(input.contentSha256, "canonical-validation-receipt-content-sha256");
  enumValue(input.status, ["passed", "failed"] as const, "canonical-validation-receipt-status");
  return input as unknown as ScienceCanonicalValidationReceiptRecord;
}

function locatorKey(value: Pick<ScienceCanonicalManuscriptSentence, "sectionId" | "sectionOrdinal" | "paragraphOrdinal" | "sentenceOrdinal">): string {
  return `${value.sectionOrdinal.toString().padStart(8, "0")}:${value.sectionId}:${value.paragraphOrdinal.toString().padStart(12, "0")}:${value.sentenceOrdinal.toString().padStart(12, "0")}`;
}

export function validateScienceClaimLedgerContext(value: unknown): ScienceClaimLedgerValidationContext {
  const input = record(value, "context");
  exactKeys(input, ["projectId", "manuscript", "manuscriptSentences", "citations", "sources", "evidenceSpans", "artifacts", "validationReceipts"], "context");
  const projectId = identifier(input.projectId, "context-project-id");
  const manuscript = validateManuscriptBinding(input.manuscript, "context-manuscript");
  if (manuscript.projectId !== projectId) fail("context-manuscript-project-mismatch");
  if (!Array.isArray(input.manuscriptSentences) || !Array.isArray(input.citations) || !Array.isArray(input.sources)
    || !Array.isArray(input.evidenceSpans) || !Array.isArray(input.artifacts) || !Array.isArray(input.validationReceipts)) fail("context-registry-invalid");
  const manuscriptSentences = input.manuscriptSentences.map(validateSentence);
  const citations = input.citations.map(validateCitation);
  const sources = input.sources.map(validateSource);
  const evidenceSpans = input.evidenceSpans.map(validateEvidenceSpan);
  const artifacts = input.artifacts.map(validateArtifact);
  const validationReceipts = input.validationReceipts.map(validateReceipt);
  sortedUnique(manuscriptSentences, locatorKey, "context-sentence");
  sortedUnique(citations, (entry) => `${entry.citationId}:${entry.citationVersion}`, "context-citation");
  sortedUnique(sources, (entry) => `${entry.sourceId}:${entry.sourceVersionId}`, "context-source");
  sortedUnique(sources, (entry) => entry.sourceVersionId, "context-source-version");
  sortedUnique(evidenceSpans, (entry) => `${entry.evidenceSpanId}:${entry.evidenceSpanVersion}`, "context-evidence-span");
  sortedUnique(artifacts, (entry) => `${entry.artifactId}:${entry.artifactVersion}`, "context-artifact");
  sortedUnique(validationReceipts, (entry) => `${entry.validationReceiptId}:${entry.validationReceiptVersion}`, "context-validation-receipt");
  for (const entry of [...citations, ...sources, ...evidenceSpans, ...artifacts, ...validationReceipts]) {
    if (entry.projectId !== projectId) fail("context-cross-project-record");
  }
  return input as unknown as ScienceClaimLedgerValidationContext;
}

function sameBinding(left: ScienceManuscriptBinding, right: ScienceManuscriptBinding): boolean {
  return left.manuscriptId === right.manuscriptId && left.projectId === right.projectId
    && left.version === right.version && left.contentSha256 === right.contentSha256;
}

function mapUnique<T>(values: readonly T[], key: (value: T) => string, code: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) fail(`${code}-duplicate`);
    result.set(id, value);
  }
  return result;
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function validateClaimAgainstContext(
  claim: ScienceClaimRecord,
  context: ScienceClaimLedgerValidationContext,
  registries: {
    sentences: Map<string, ScienceCanonicalManuscriptSentence>;
    citations: Map<string, ScienceCanonicalCitationRecord>;
    sources: Map<string, ScienceCanonicalSourceRecord>;
    spans: Map<string, ScienceCanonicalEvidenceSpanRecord>;
    artifacts: Map<string, ScienceCanonicalArtifactRecord>;
    receipts: Map<string, ScienceCanonicalValidationReceiptRecord>;
  },
): void {
  if (claim.manuscript.projectId !== context.projectId || claim.manuscript.manuscriptId !== context.manuscript.manuscriptId) fail("claim-context-manuscript-mismatch");
  if (sameBinding(claim.manuscript, context.manuscript)) {
    const sentence = registries.sentences.get(locatorKey(claim.locator));
    if (!sentence || sentence.textSha256 !== claim.locator.sentenceTextSha256) fail("claim-locator-stale");
    const { claimStartOffset: start, claimEndOffset: end } = claim.locator;
    if (end > sentence.text.length || !isSurrogateBoundary(sentence.text, start) || !isSurrogateBoundary(sentence.text, end)
      || sentence.text.slice(start, end) !== claim.exactText) fail("claim-locator-text-mismatch");
  }
  for (const atom of claim.evidence) {
    const citation = registries.citations.get(`${atom.citationId}:${atom.citationVersion}`);
    if (!citation || citation.citationVersion !== atom.citationVersion || citation.contentSha256 !== atom.citationContentSha256
      || citation.sourceId !== atom.sourceId || citation.sourceVersionId !== atom.sourceVersionId
      || citation.evidenceSpanId !== atom.evidenceSpanId || citation.evidenceSpanVersion !== atom.evidenceSpanVersion
      || citation.evidenceSpanContentSha256 !== atom.evidenceSpanContentSha256) fail("evidence-citation-stale");
    const source = registries.sources.get(`${atom.sourceId}:${atom.sourceVersionId}`);
    if (!source || source.sourceVersionId !== atom.sourceVersionId || source.sourceVersion !== atom.sourceVersion
      || source.contentSha256 !== atom.sourceContentSha256) fail("evidence-source-stale");
    const span = registries.spans.get(`${atom.evidenceSpanId}:${atom.evidenceSpanVersion}`);
    if (!span || span.evidenceSpanVersion !== atom.evidenceSpanVersion || span.contentSha256 !== atom.evidenceSpanContentSha256
      || span.sourceId !== atom.sourceId || span.sourceVersionId !== atom.sourceVersionId || span.exactText !== atom.evidenceSpanExactText
      || span.exactTextSha256 !== atom.evidenceSpanTextSha256
      || canonicalScienceClaimLedgerJson(span.locator) !== canonicalScienceClaimLedgerJson(atom.evidenceSpanLocator)) fail("evidence-span-stale");
    if (atom.artifact !== null) {
      const artifact = registries.artifacts.get(`${atom.artifact.artifactId}:${atom.artifact.artifactVersion}`);
      if (!artifact || artifact.artifactVersion !== atom.artifact.artifactVersion || artifact.contentSha256 !== atom.artifact.artifactContentSha256) fail("evidence-artifact-stale");
    }
    if (atom.validationReceipt !== null) {
      const receipt = registries.receipts.get(`${atom.validationReceipt.validationReceiptId}:${atom.validationReceipt.validationReceiptVersion}`);
      if (!receipt || receipt.validationReceiptVersion !== atom.validationReceipt.validationReceiptVersion
        || receipt.contentSha256 !== atom.validationReceipt.validationReceiptContentSha256 || atom.artifact === null
        || receipt.artifactId !== atom.artifact.artifactId || receipt.artifactVersion !== atom.artifact.artifactVersion
        || receipt.artifactContentSha256 !== atom.artifact.artifactContentSha256) fail("evidence-validation-receipt-stale");
    }
  }
}

export function validateScienceClaimLedgerManifest(
  value: unknown,
  contextValue: unknown,
): ScienceClaimLedgerManifest {
  const context = validateScienceClaimLedgerContext(contextValue);
  const input = record(value, "manifest");
  exactKeys(input, [
    "schema", "ledgerId", "projectId", "revision", "previousManifestSha256", "manuscript", "manuscriptCitations",
    "claims", "activeClaimIds", "createdAt", "manifestSha256",
  ], "manifest");
  if (input.schema !== SCIENCE_CLAIM_LEDGER_SCHEMA) fail("manifest-schema-invalid");
  identifier(input.ledgerId, "manifest-ledger-id");
  const projectId = identifier(input.projectId, "manifest-project-id");
  if (projectId !== context.projectId) fail("manifest-context-project-mismatch");
  const revision = integer(input.revision, 1, Number.MAX_SAFE_INTEGER, "manifest-revision");
  if (revision === 1 ? input.previousManifestSha256 !== null : input.previousManifestSha256 === null) fail("manifest-previous-sha256-invalid");
  if (input.previousManifestSha256 !== null) sha256(input.previousManifestSha256, "manifest-previous-sha256");
  const manuscript = validateManuscriptBinding(input.manuscript, "manifest-manuscript");
  if (!sameBinding(manuscript, context.manuscript) || manuscript.projectId !== projectId) fail("manifest-manuscript-context-mismatch");
  if (!Array.isArray(input.manuscriptCitations)) fail("manifest-citations-invalid");
  const manuscriptCitations = input.manuscriptCitations.map((value) => {
    const binding = record(value, "manifest-citation");
    exactKeys(binding, ["citationId", "citationVersion", "citationContentSha256"], "manifest-citation");
    identifier(binding.citationId, "manifest-citation-id");
    integer(binding.citationVersion, 1, Number.MAX_SAFE_INTEGER, "manifest-citation-version");
    sha256(binding.citationContentSha256, "manifest-citation-sha256");
    return binding as unknown as ScienceClaimLedgerManifest["manuscriptCitations"][number];
  });
  sortedUnique(manuscriptCitations, (entry) => `${entry.citationId}:${entry.citationVersion}`, "manifest-citation", true);
  sortedUnique(manuscriptCitations, (entry) => entry.citationId, "manifest-citation-id");
  if (!Array.isArray(input.claims)) fail("manifest-claims-invalid");
  const claims = input.claims.map(validateClaim);
  sortedUnique(claims, (claim) => claim.claimId, "manifest-claim", true);
  const activeClaimIds = assertStringArray(input.activeClaimIds, "manifest-active-claim-id", true);
  timestamp(input.createdAt, "manifest-created-at");
  const manifestHash = sha256(input.manifestSha256, "manifest-sha256");
  if (scienceClaimLedgerSha256(without(input, "manifestSha256")) !== manifestHash) fail("manifest-integrity-failed");

  const claimsById = mapUnique(claims, (claim) => claim.claimId, "manifest-claim");
  const childByParent = new Map<string, string>();
  const globalEvidenceIds = new Set<string>();
  const activeLocatorRanges = new Set<string>();
  for (const claim of claims) {
    if (claim.manuscript.projectId !== projectId) fail("claim-project-mismatch");
    for (const atom of claim.evidence) {
      if (globalEvidenceIds.has(atom.evidenceAtomId)) fail("manifest-evidence-atom-replay");
      globalEvidenceIds.add(atom.evidenceAtomId);
    }
    if (claim.supersedesClaimId !== null) {
      const parent = claimsById.get(claim.supersedesClaimId);
      if (!parent || parent.contentSha256 !== claim.supersedesClaimContentSha256 || parent.logicalClaimId !== claim.logicalClaimId
        || parent.createdAt >= claim.createdAt) fail("claim-supersession-invalid");
      if (childByParent.has(parent.claimId)) fail("claim-supersession-fork");
      childByParent.set(parent.claimId, claim.claimId);
    }
  }
  for (const claim of claims) {
    const visited = new Set<string>();
    let cursor: ScienceClaimRecord | undefined = claim;
    while (cursor && cursor.supersedesClaimId !== null) {
      if (visited.has(cursor.claimId)) fail("claim-supersession-cycle");
      visited.add(cursor.claimId);
      cursor = claimsById.get(cursor.supersedesClaimId);
    }
  }
  const leaves = claims.filter((claim) => !childByParent.has(claim.claimId)).map((claim) => claim.claimId).sort();
  if (canonicalScienceClaimLedgerJson(leaves) !== canonicalScienceClaimLedgerJson(activeClaimIds)) fail("manifest-active-leaves-mismatch");

  const registries = {
    sentences: mapUnique(context.manuscriptSentences, locatorKey, "context-sentence"),
    citations: mapUnique(context.citations, (entry) => `${entry.citationId}:${entry.citationVersion}`, "context-citation"),
    sources: mapUnique(context.sources, (entry) => `${entry.sourceId}:${entry.sourceVersionId}`, "context-source"),
    spans: mapUnique(context.evidenceSpans, (entry) => `${entry.evidenceSpanId}:${entry.evidenceSpanVersion}`, "context-evidence-span"),
    artifacts: mapUnique(context.artifacts, (entry) => `${entry.artifactId}:${entry.artifactVersion}`, "context-artifact"),
    receipts: mapUnique(context.validationReceipts, (entry) => `${entry.validationReceiptId}:${entry.validationReceiptVersion}`, "context-validation-receipt"),
  };
  for (const binding of manuscriptCitations) {
    const citation = context.citations.find((entry) => entry.citationId === binding.citationId && entry.citationVersion === binding.citationVersion);
    if (!citation || citation.contentSha256 !== binding.citationContentSha256) fail("manifest-citation-stale");
  }
  for (const claim of claims) {
    if (activeClaimIds.includes(claim.claimId)) {
      if (!sameBinding(claim.manuscript, manuscript)) fail("active-claim-manuscript-stale");
      const rangeKey = `${locatorKey(claim.locator)}:${claim.locator.claimStartOffset}:${claim.locator.claimEndOffset}`;
      if (activeLocatorRanges.has(rangeKey)) fail("active-claim-locator-duplicate");
      activeLocatorRanges.add(rangeKey);
    }
    // Old inactive claims retain their immutable hashes, but only current
    // manuscript locators can be checked against the current editor snapshot.
    validateClaimAgainstContext(claim, context, registries);
  }
  return input as unknown as ScienceClaimLedgerManifest;
}

export function validateScienceClaimLedgerTransition(input: {
  previousManifest: unknown;
  nextManifest: unknown;
  previousContext: unknown;
  nextContext: unknown;
}): ScienceClaimLedgerManifest {
  const previous = validateScienceClaimLedgerManifest(input.previousManifest, input.previousContext);
  const next = validateScienceClaimLedgerManifest(input.nextManifest, input.nextContext);
  if (previous.ledgerId !== next.ledgerId || previous.projectId !== next.projectId) fail("transition-identity-mismatch");
  if (next.revision !== previous.revision + 1 || next.previousManifestSha256 !== previous.manifestSha256) fail("transition-revision-stale");
  if (next.createdAt <= previous.createdAt) fail("transition-time-invalid");
  if (next.manuscript.manuscriptId !== previous.manuscript.manuscriptId || next.manuscript.projectId !== previous.manuscript.projectId) fail("transition-manuscript-identity-mismatch");
  if (next.manuscript.version === previous.manuscript.version) {
    if (next.manuscript.contentSha256 !== previous.manuscript.contentSha256) fail("transition-manuscript-content-tampered");
  } else if (next.manuscript.version !== previous.manuscript.version + 1 || next.manuscript.contentSha256 === previous.manuscript.contentSha256) {
    fail("transition-manuscript-version-invalid");
  }
  const nextClaims = mapUnique(next.claims, (claim) => claim.claimId, "transition-next-claim");
  const previousClaimIds = new Set(previous.claims.map((claim) => claim.claimId));
  for (const claim of previous.claims) {
    const retained = nextClaims.get(claim.claimId);
    if (!retained || canonicalScienceClaimLedgerJson(retained) !== canonicalScienceClaimLedgerJson(claim)) fail("transition-claim-history-mutated");
  }
  for (const claim of next.claims) {
    if (!previousClaimIds.has(claim.claimId) && !sameBinding(claim.manuscript, next.manuscript)) fail("transition-new-claim-manuscript-stale");
  }
  return next;
}

function validatePolicy(value: unknown): ScienceClaimLedgerPublicationPolicy {
  const input = record(value, "policy");
  exactKeys(input, [
    "policyId", "policyVersion", "allowedStatuses", "minimumRelevance", "minimumAssessmentConfidence",
    "requirePassedValidationForArtifactEvidence", "contentSha256",
  ], "policy");
  identifier(input.policyId, "policy-id");
  integer(input.policyVersion, 1, Number.MAX_SAFE_INTEGER, "policy-version");
  const allowed = record(input.allowedStatuses, "policy-allowed-statuses");
  exactKeys(allowed, SCIENCE_CLAIM_CLASSES, "policy-allowed-statuses");
  for (const claimClass of SCIENCE_CLAIM_CLASSES) {
    if (!Array.isArray(allowed[claimClass]) || allowed[claimClass].length === 0) fail("policy-allowed-statuses-invalid");
    const statuses = allowed[claimClass].map((status) => enumValue(status, SCIENCE_CLAIM_STATUSES, "policy-status"));
    sortedUnique(statuses, (status) => status, "policy-status");
  }
  score(input.minimumRelevance, "policy-minimum-relevance");
  score(input.minimumAssessmentConfidence, "policy-minimum-assessment-confidence");
  if (typeof input.requirePassedValidationForArtifactEvidence !== "boolean") fail("policy-validation-requirement-invalid");
  const contentHash = sha256(input.contentSha256, "policy-content-sha256");
  if (scienceClaimLedgerSha256(without(input, "contentSha256")) !== contentHash) fail("policy-integrity-failed");
  return input as unknown as ScienceClaimLedgerPublicationPolicy;
}

function issueSortKey(issue: ScienceClaimLedgerGateIssue): string {
  return [issue.code, issue.claimId ?? "", issue.evidenceAtomId ?? "", issue.citationId ?? ""].join(":");
}

export function evaluateScienceClaimLedgerPublicationGate(input: {
  manifest: unknown;
  context: unknown;
  policy?: unknown;
}): ScienceClaimLedgerPublicationGateReport {
  const context = validateScienceClaimLedgerContext(input.context);
  const manifest = validateScienceClaimLedgerManifest(input.manifest, context);
  const policy = validatePolicy(input.policy ?? DEFAULT_SCIENCE_CLAIM_LEDGER_PUBLICATION_POLICY);
  const active = new Map(manifest.claims.map((claim) => [claim.claimId, claim] as const));
  const receiptById = new Map(context.validationReceipts.map((receipt) => [`${receipt.validationReceiptId}:${receipt.validationReceiptVersion}`, receipt] as const));
  const issues: ScienceClaimLedgerGateIssue[] = [];
  const usedCitations = new Set<string>();
  const manuscriptCitationIds = new Set(manifest.manuscriptCitations.map((entry) => entry.citationId));
  for (const claimId of manifest.activeClaimIds) {
    const claim = active.get(claimId)!;
    if (!policy.allowedStatuses[claim.claimClass].includes(claim.status)) {
      issues.push({ code: "active-claim-status-blocked", claimId, evidenceAtomId: null, citationId: null });
    }
    if (["factual", "inference", "method", "result"].includes(claim.claimClass) && claim.evidence.length === 0) {
      issues.push({ code: "active-claim-evidence-required", claimId, evidenceAtomId: null, citationId: null });
    }
    let hasPassedArtifactValidation = false;
    for (const atom of claim.evidence) {
      usedCitations.add(atom.citationId);
      if (!manuscriptCitationIds.has(atom.citationId)) {
        issues.push({ code: "evidence-citation-not-in-manuscript", claimId, evidenceAtomId: atom.evidenceAtomId, citationId: atom.citationId });
      }
      if (atom.relevance < policy.minimumRelevance || atom.assessmentConfidence < policy.minimumAssessmentConfidence) {
        issues.push({ code: "evidence-below-policy-threshold", claimId, evidenceAtomId: atom.evidenceAtomId, citationId: atom.citationId });
      }
      if (atom.artifact !== null) {
        if (policy.requirePassedValidationForArtifactEvidence && atom.validationReceipt === null) {
          issues.push({ code: "artifact-validation-required", claimId, evidenceAtomId: atom.evidenceAtomId, citationId: atom.citationId });
        } else if (atom.validationReceipt !== null) {
          const receipt = receiptById.get(`${atom.validationReceipt.validationReceiptId}:${atom.validationReceipt.validationReceiptVersion}`)!;
          if (receipt.status !== "passed") {
            issues.push({ code: "artifact-validation-not-passed", claimId, evidenceAtomId: atom.evidenceAtomId, citationId: atom.citationId });
          } else {
            hasPassedArtifactValidation = true;
          }
        }
      }
    }
    if (["method", "result"].includes(claim.claimClass) && !hasPassedArtifactValidation) {
      issues.push({ code: "artifact-validation-required", claimId, evidenceAtomId: null, citationId: null });
    }
  }
  for (const citationId of manuscriptCitationIds) {
    if (!usedCitations.has(citationId)) issues.push({ code: "orphan-manuscript-citation", claimId: null, evidenceAtomId: null, citationId });
  }
  const activeRanges = new Map<string, Array<{ start: number; end: number; claimId: string }>>();
  for (const claimId of manifest.activeClaimIds) {
    const claim = active.get(claimId)!;
    const key = locatorKey(claim.locator);
    const ranges = activeRanges.get(key) ?? [];
    ranges.push({ start: claim.locator.claimStartOffset, end: claim.locator.claimEndOffset, claimId });
    activeRanges.set(key, ranges);
  }
  const coverage = context.manuscriptSentences.map((sentence) => {
    const ranges = (activeRanges.get(locatorKey(sentence)) ?? []).sort((left, right) => left.start - right.start || left.end - right.end || left.claimId.localeCompare(right.claimId));
    let covered = true;
    for (let index = 0; index < sentence.text.length; index += 1) {
      if (!/\s/u.test(sentence.text[index]) && !ranges.some((range) => range.start <= index && range.end > index)) { covered = false; break; }
    }
    if (!covered) issues.push({ code: "manuscript-sentence-unclassified", claimId: null, evidenceAtomId: null, citationId: null });
    return { sectionId: sentence.sectionId, sectionOrdinal: sentence.sectionOrdinal, paragraphOrdinal: sentence.paragraphOrdinal,
      sentenceOrdinal: sentence.sentenceOrdinal, textSha256: sentence.textSha256, ranges, covered };
  });
  issues.sort((left, right) => issueSortKey(left).localeCompare(issueSortKey(right)));
  const core = {
    schema: SCIENCE_CLAIM_LEDGER_GATE_SCHEMA,
    projectId: manifest.projectId,
    ledgerId: manifest.ledgerId,
    ledgerRevision: manifest.revision,
    ledgerManifestSha256: manifest.manifestSha256,
    manuscript: manifest.manuscript,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyContentSha256: policy.contentSha256,
    manuscriptSentenceCount: coverage.length,
    classifiedSentenceCount: coverage.filter((entry) => entry.covered).length,
    claimCoverageSha256: scienceClaimLedgerSha256(coverage),
    ready: issues.length === 0,
    issues,
  };
  return { ...core, reportSha256: scienceClaimLedgerSha256(core) };
}

export function sealScienceClaimLocator(input: Omit<ScienceClaimLocator, "locatorSha256">): ScienceClaimLocator {
  const { locatorSha256: _ignored, ...core } = input as ScienceClaimLocator;
  return { ...core, locatorSha256: scienceClaimLedgerSha256(core) };
}

export function sealScienceClaimEvidenceAtom(input: Omit<ScienceClaimEvidenceAtom, "contentSha256">): ScienceClaimEvidenceAtom {
  const { contentSha256: _ignored, ...core } = input as ScienceClaimEvidenceAtom;
  return { ...core, contentSha256: scienceClaimLedgerSha256(core) };
}

export function sealScienceClaimRecord(input: Omit<ScienceClaimRecord, "contentSha256">): ScienceClaimRecord {
  const { contentSha256: _ignored, ...unsealed } = input as ScienceClaimRecord;
  const core = { ...unsealed, evidence: [...input.evidence].sort((left, right) => left.evidenceAtomId.localeCompare(right.evidenceAtomId)) };
  return { ...core, contentSha256: scienceClaimLedgerSha256(core) };
}

export function sealScienceClaimLedgerManifest(input: Omit<ScienceClaimLedgerManifest, "manifestSha256">): ScienceClaimLedgerManifest {
  const { manifestSha256: _ignored, ...unsealed } = input as ScienceClaimLedgerManifest;
  const core = {
    ...unsealed,
    manuscriptCitations: [...input.manuscriptCitations].sort((left, right) => `${left.citationId}:${left.citationVersion}`.localeCompare(`${right.citationId}:${right.citationVersion}`)),
    claims: [...input.claims].sort((left, right) => left.claimId.localeCompare(right.claimId)),
    activeClaimIds: [...input.activeClaimIds].sort(),
  };
  return { ...core, manifestSha256: scienceClaimLedgerSha256(core) };
}

export function sealScienceClaimLedgerPublicationPolicy(
  input: Omit<ScienceClaimLedgerPublicationPolicy, "contentSha256">,
): ScienceClaimLedgerPublicationPolicy {
  const { contentSha256: _ignored, ...core } = input as ScienceClaimLedgerPublicationPolicy;
  return { ...core, contentSha256: scienceClaimLedgerSha256(core) };
}

export const DEFAULT_SCIENCE_CLAIM_LEDGER_PUBLICATION_POLICY = sealScienceClaimLedgerPublicationPolicy({
  policyId: "agentlas.publication.claim-resolution",
  policyVersion: 1,
  allowedStatuses: {
    factual: ["supported"],
    inference: ["supported", "mixed"],
    method: ["supported"],
    result: ["supported"],
    limitation: ["supported", "mixed", "unresolved"],
    "non-factual": ["not-applicable"],
  },
  minimumRelevance: 0.5,
  minimumAssessmentConfidence: 0.5,
  requirePassedValidationForArtifactEvidence: true,
});
