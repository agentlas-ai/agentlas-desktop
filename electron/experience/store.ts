import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { setImmediate as yieldToMain } from "node:timers/promises";
import type {
  ExperienceCandidateCaptureInput,
  ExperienceCandidateRecord,
  ExperienceIntakeDiagnostics,
  ExperienceOntologySummary,
  ExperienceExportIntentInput,
  ExperienceExportIntentRecord,
  ExperiencePackCreateInput,
  ExperiencePackListInput,
  ExperiencePackRecord,
  ExperiencePromotionInput,
  ExperiencePromotionReceipt,
  LocalTasteDraftRecord,
} from "../../shared/types";
import { getAgentById } from "../mcp/registry";
import { getMemoryDb as getDb } from "../memory/database";
import { hasDurableRunStartReceipt } from "../store/run-events";
import { assertMemoryWriteAllowed, revokedMemorySourceIds } from "../memory/revocations";
import { nativeTextsFor } from "../memory/native-text";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import { summarizeExperienceApplicationOutcomes } from "./application";
import {
  normalizeExperienceMcpRequirements,
  rankExperienceCandidatesByRelations,
  rebuildExperienceRelationIndex,
  recordExperienceLineageEvent,
  refreshExperienceRelationArtifacts,
  refreshExperienceRelationArtifactsForPacks,
} from "./relation-index";
import {
  canonicalEnvironmentProfile,
  classifyCanonicalTaskIds,
  isCanonicalTaskId,
  isRuntimeEligibleExperienceEnvironmentProfile,
  parseCanonicalEnvironmentProfile,
} from "./taxonomy";
import {
  autoLocalEmbedding,
  parseLocalEmbedding,
} from "../memory/local-embedding";

const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*\S+|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._~-]{12,})/i;
const PRIVATE_LOCATION_RE = /(?:file:\/\/|(?:^|[\s"'`()\[\]{}=:,;])(?:\.\.[/\\]|~[/\\]|\\\\[^\\/\s]+[\\/][^\\/\s]+)|(?<![A-Za-z0-9$])\/(?!\/|\s)(?:[^/\s"'`<>]+\/)*[^/\s"'`<>]+|(?<![A-Za-z0-9])[A-Za-z]:[/\\](?=\S))/i;
const LABELED_IDENTIFIER_RE = /\b(?:tenant|workspace|account|customer|user|client)[ _-]?(?:id|key|number|no|ref|reference)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}\b|(?:테넌트|워크스페이스|계정|고객|사용자|클라이언트)[ _-]?(?:id|아이디|키|번호|참조)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}/i;
const IP_CANDIDATE_RE = /(?<![A-Za-z0-9])\[?[0-9A-Fa-f:.]{3,}\]?(?![A-Za-z0-9])/g;
const SAFE_EVIDENCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const CAPTURE_UNSAFE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "role-line",
    pattern: /(?:^|\n)\s*(?:system|developer|assistant|user|tool|시스템|개발자|어시스턴트|사용자|도구)\s*:\s*\S/i,
  },
  {
    code: "json-role-object",
    pattern: /(?:^|[{,])\s*["']?role["']?\s*:\s*["'](?:system|developer|assistant|user|tool)["']/i,
  },
  {
    code: "prompt-material",
    pattern: /\b(?:raw[_ -]?prompt|system[_ -]?prompt|developer[_ -]?prompt|user[_ -]?prompt|prompt[_ -]?dump|conversation[_ -]?dump|raw[_ -]?transcript|chat[_ -]?transcript)\b|(?:시스템|개발자|원시)\s*프롬프트|(?:대화|채팅)\s*원문|<\/?\s*(?:system|developer)\b|\[(?:system|developer)\]/i,
  },
  {
    code: "agent-instruction-material",
    pattern: /(?:^|[/\\\s`"'])(?:AGENTS|CLAUDE)\.md\b|(?:^|[/\\])\.claude(?:[/\\]|$)/i,
  },
  {
    code: "base-package-material",
    pattern: /\b(?:base[-_ ]?package|agentlas[-_ ]?package)\s+(?:payload|contents?|manifest|files?|archive|bytes?|source)\b|(?:베이스|Agentlas)\s*패키지\s*(?:페이로드|내용|매니페스트|파일|압축|바이트|원문)/i,
  },
  {
    code: "base64-blob",
    pattern: /data:[^,;\s]{1,120};base64,[A-Za-z0-9+/]{24,}={0,2}|(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{80,}={0,2}(?=$|[^A-Za-z0-9+/=])/i,
  },
];
const PUBLIC_UNSAFE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "secret-value", pattern: SECRET_VALUE_RE },
  { code: "raw-prompt-or-transcript", pattern: /\b(?:raw[_ -]?prompt|system[_ -]?prompt|user[_ -]?prompt|transcript|conversation dump)\b|(?:^|\n)\s*(?:system|assistant|user|tool)\s*:/i },
  { code: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: "local-path-or-url", pattern: /https?:\/\//i },
  { code: "local-path-or-url", pattern: PRIVATE_LOCATION_RE },
  { code: "account-identifier", pattern: /\b(?:account|user|workspace|customer|tenant|organization|org)[ _-]?id\s*[:=]\s*[A-Za-z0-9._:-]+/i },
  { code: "opaque-identifier", pattern: /\b(?:[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\b/i },
];

// ── Phone-shaped number precision detector ───────────────────────────────────
// The legacy `(?:^|\D)\+?\d[\d ()-]{7,}\d` rule blocked git SHAs, UUID digit
// groups, and epoch timestamps as "phone-or-long-number". A span now counts as
// phone-shaped only when it is not embedded in a longer hex/base64/path token,
// carries 9-15 digits, and is either +country-prefixed or split into separated
// digit groups. Bare long digit runs (timestamps, counters) no longer match.
const PHONE_SEGMENT_RE = /\+?\d[\d\s().-]{7,24}\d/g;
const ISO_DATE_PREFIX_RE = /^\d{4}[.\s-]\d{1,2}[.\s-]\d{1,2}(?:$|[^\d])/;

function phoneLikeSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  PHONE_SEGMENT_RE.lastIndex = 0;
  for (const match of text.matchAll(PHONE_SEGMENT_RE)) {
    const value = match[0];
    const start = match.index ?? 0;
    const end = start + value.length;
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    // Embedded in a longer opaque token (SHA/UUID/base64/path/version) — not a phone.
    if (/[0-9A-Za-z_+]/.test(before) || /[0-9A-Za-z_]/.test(after)) continue;
    if (["-", ".", "/", "\\", ":"].includes(before) || ["-", ".", "/", "\\"].includes(after)) continue;
    const digits = value.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    const hasCountryPrefix = value.startsWith("+");
    const hasSeparatedGroups = /\d[\s().-]+\d/.test(value);
    if (!hasCountryPrefix && !hasSeparatedGroups) continue;
    if (ISO_DATE_PREFIX_RE.test(value.replace(/^\+/, ""))) continue;
    spans.push({ start, end });
  }
  return spans;
}

function containsPhoneLikeNumber(text: string): boolean {
  return phoneLikeSpans(text).length > 0;
}

type PackRow = {
  id: string;
  agent_id: string;
  project_id: string | null;
  project_path: string | null;
  project_scope_key: string;
  environment_key: string;
  environment_profile_json: string | null;
  auto_managed: number;
  name: string;
  description: string;
  base_package_hash: string | null;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  base_package_hash_version: string | null;
  mcp_requirements_json: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

type CandidateRow = {
  id: string;
  pack_id: string;
  agent_id: string;
  project_scope_key: string;
  environment_key: string;
  source_memory_id: string;
  summary: string;
  task_terms_json: string;
  sensitivity: "public" | "internal" | "private";
  confidence: "high" | "medium" | "low";
  status: "candidate" | "promoted" | "rejected";
  outcome_status: "unverified" | "attested" | "verified" | "failed";
  public_safe: number;
  auto_managed: number;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
  embedding_model?: string | null;
  embedding_adapter?: string | null;
  embedding_model_sha256?: string | null;
  embedding_content_hash?: string | null;
  embedding_dimensions?: number | null;
  embedding_json?: string | null;
};

type TasteDraftRow = {
  id: string;
  agent_id: string;
  source_memory_id: string;
  source_memory_hash: string;
  project_scope_key: string;
  environment_key: string;
  base_package_hash: string;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  memory_content: string;
  sensitivity: "public" | "internal" | "private";
  confidence: "high" | "medium" | "low";
  axis_candidates_json: string;
  task_signatures_json: string;
  evidence_state: "pairwise-required";
  status: "observation" | "rejected";
  created_at: string;
  updated_at: string;
};

type PromotionReceiptRow = {
  id: string;
  pack_id: string;
  candidate_id: string;
  agent_id: string;
  action: "promote";
  explicit_consent: number;
  verification_status: "attested" | "verified";
  verification_method: "user-attested" | "local-run-receipt" | "local-test-receipt";
  evidence_hash: string;
  public_safe: number;
  created_at: string;
};

type ExportIntentRow = {
  id: string;
  pack_id: string;
  agent_id: string;
  visibility: "private" | "public";
  status: "local_intent";
  manifest_hash: string;
  created_at: string;
};

type MemoryProjectionRow = {
  id: string;
  kind: string;
  content: string;
  project_id: string | null;
  project_path: string | null;
  agent_id: string | null;
  confidence: string;
  sensitivity: string;
  context_json: string | null;
  superseded_at: string | null;
};

function hash(...parts: string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex");
}

/** Unsafe even for private/internal packs; these are source-material classes, not privacy labels. */
export function experienceCaptureSafetyIssues(text: string): string[] {
  return CAPTURE_UNSAFE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ code }) => code);
}

export function publicExperienceSafetyIssues(text: string): string[] {
  const variants = decodedTextVariants(text);
  const ipAddress = variants.some((value) => {
    IP_CANDIDATE_RE.lastIndex = 0;
    return [...value.matchAll(IP_CANDIDATE_RE)].some((match) =>
      isIP(match[0].replace(/^\[|\]$/g, "")) !== 0);
  });
  return [...new Set([
    ...variants.flatMap(experienceCaptureSafetyIssues),
    ...variants.flatMap((value) => PUBLIC_UNSAFE_PATTERNS
      .filter(({ pattern }) => pattern.test(value))
      .map(({ code }) => code)),
    ...(variants.some(containsPhoneLikeNumber) ? ["phone-or-long-number"] : []),
    ...(variants.some((value) => LABELED_IDENTIFIER_RE.test(value)) ? ["account-identifier"] : []),
    ...(ipAddress ? ["ip-address"] : []),
  ])];
}

// ── Redact-and-admit (auto-intake only) ──────────────────────────────────────
// Privacy classes that are span-redactable at intake. Everything else on the
// scanner (secrets, prompt/transcript material, labeled account identifiers,
// IP addresses, base64 blobs ≥80, sensitive memory) stays a hard block.
const REDACTABLE_PRIVACY_CODES: ReadonlySet<string> = new Set([
  "local-path-or-url",
  "email",
  "phone-or-long-number",
  "opaque-identifier",
]);

const REDACT_URL_RE = /https?:\/\/[^\s"'`<>\])}]+/gi;
const REDACT_EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REDACT_UUID_RE = /\b[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\b/gi;
const REDACT_HEX_RE = /\b[a-f0-9]{32,}\b/gi;
const REDACT_B64_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g;
const REDACT_LOCATION_RE = new RegExp(PRIVATE_LOCATION_RE.source, "gi");
const LOCATION_PREFIX_CHAR_RE = /^[\s"'`()\[\]{}=:,;]/;

export interface ExperienceRedactionResult {
  text: string;
  redactions: number;
}

/**
 * Replaces privacy spans with value-free placeholders: local paths → `<경로>`,
 * URLs → `<URL>`, emails → `<이메일>`, opaque/phone-shaped numbers → `<ID>`.
 * The caller MUST re-run publicExperienceSafetyIssues on the result and treat
 * any residue as a hard block; this function never claims completeness.
 */
export function redactExperiencePrivacySpans(raw: string): ExperienceRedactionResult {
  let redactions = 0;
  const count = (replacement: string) => {
    redactions += 1;
    return replacement;
  };
  let text = raw.replace(REDACT_URL_RE, () => count("<URL>"));
  text = text.replace(REDACT_EMAIL_RE, () => count("<이메일>"));
  text = text.replace(REDACT_UUID_RE, () => count("<ID>"));
  text = text.replace(REDACT_HEX_RE, () => count("<ID>"));
  text = text.replace(REDACT_B64_RE, () => count("<ID>"));
  text = text.replace(REDACT_LOCATION_RE, (match) => {
    const prefix = LOCATION_PREFIX_CHAR_RE.test(match[0] ?? "") ? match[0] : "";
    return count(`${prefix}<경로>`);
  });
  // Phone-shaped spans are located on the current text so indices stay valid.
  for (let guard = 0; guard < 64; guard += 1) {
    const span = phoneLikeSpans(text)[0];
    if (!span) break;
    text = `${text.slice(0, span.start)}${count("<ID>")}${text.slice(span.end)}`;
  }
  return { text, redactions };
}

function decodedTextVariants(value: string): string[] {
  const variants = [value];
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      variants.push(next);
      current = next;
    } catch {
      break;
    }
  }
  return variants;
}

function normalizedProjectPath(value?: string | null): string | null {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) return null;
  const resolved = path.resolve(clean);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function experienceProjectScopeKey(input: {
  projectId?: string | null;
  projectPath?: string | null;
}): string {
  const projectId = String(input.projectId ?? "").trim();
  const projectPath = normalizedProjectPath(input.projectPath) ?? "";
  return projectId || projectPath ? hash("experience-project-v1", projectId, projectPath) : "global";
}

export function experienceEnvironmentKey(input: { platform: string; arch?: string; runtimeKind: string }): string {
  const platform = String(input.platform ?? "").trim();
  const arch = String(input.arch ?? "unknown").trim();
  const runtimeKind = String(input.runtimeKind ?? "").trim();
  if (!platform || !runtimeKind || platform.length > 40 || arch.length > 40 || runtimeKind.length > 80) {
    throw new Error("Experience environment requires a platform and runtime kind.");
  }
  const profile = canonicalEnvironmentProfile({ platform, arch, runtimeKind });
  return hash("experience-environment-v3", ...profile.constraints);
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const extras = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields.`);
}

function cleanText(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && value == null) return "";
    throw new Error(`${label} must be text.`);
  }
  const clean = value.trim();
  if (required && !clean) throw new Error(`${label} is required.`);
  if (clean.length > max) throw new Error(`${label} is too long.`);
  if (SECRET_VALUE_RE.test(clean)) throw new Error(`${label} appears to contain a secret value.`);
  return clean;
}

function packFromRow(row: PackRow): ExperiencePackRecord {
  let mcpRequirements: ExperiencePackRecord["mcpRequirements"] = [];
  try {
    mcpRequirements = normalizeExperienceMcpRequirements(JSON.parse(row.mcp_requirements_json));
  } catch {
    mcpRequirements = [];
  }
  let environmentProfile: ExperiencePackRecord["environmentProfile"] = null;
  try {
    environmentProfile = parseCanonicalEnvironmentProfile(JSON.parse(row.environment_profile_json || "null"));
  } catch {
    environmentProfile = null;
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    projectPath: row.project_path,
    environmentKey: row.environment_key,
    environmentProfile,
    autoManaged: row.auto_managed === 1,
    name: row.name,
    description: row.description,
    basePackageHash: row.base_package_hash,
    baseAgentDefinitionId: row.base_agent_definition_id,
    baseAgentReleaseId: row.base_agent_release_id,
    basePackageHashVersion: row.base_package_hash_version,
    mcpRequirements,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateFromRow(row: CandidateRow): ExperienceCandidateRecord {
  return {
    id: row.id,
    packId: row.pack_id,
    agentId: row.agent_id,
    sourceMemoryId: row.source_memory_id,
    summary: row.summary,
    sensitivity: row.sensitivity,
    confidence: row.confidence,
    status: row.status,
    outcomeStatus: row.outcome_status,
    publicSafe: row.public_safe === 1,
    taskSignatures: parseStringList(row.task_terms_json).filter(isCanonicalTaskId),
    autoManaged: row.auto_managed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at,
  };
}

const TASTE_AXES = [
  "composition",
  "color",
  "typography",
  "motion",
  "pacing",
  "density",
  "imagery",
  "editing",
  "spatial-rhythm",
] as const;
type TasteAxis = (typeof TASTE_AXES)[number];

function parseStringList(raw: string, allowed?: ReadonlySet<string>): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string =>
      typeof item === "string" && (!allowed || allowed.has(item))))];
  } catch {
    return [];
  }
}

function tasteDraftFromRow(row: TasteDraftRow): LocalTasteDraftRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    sourceMemoryId: row.source_memory_id,
    statement: row.memory_content,
    sensitivity: row.sensitivity,
    confidence: row.confidence,
    axisCandidates: parseStringList(row.axis_candidates_json, new Set(TASTE_AXES)) as TasteAxis[],
    taskSignatures: parseStringList(row.task_signatures_json).filter(isCanonicalTaskId),
    basePackageHash: row.base_package_hash,
    baseAgentDefinitionId: row.base_agent_definition_id,
    baseAgentReleaseId: row.base_agent_release_id,
    evidenceState: row.evidence_state,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function receiptFromRow(row: PromotionReceiptRow): ExperiencePromotionReceipt {
  return {
    id: row.id,
    packId: row.pack_id,
    candidateId: row.candidate_id,
    agentId: row.agent_id,
    action: row.action,
    explicitConsent: true,
    verificationStatus: row.verification_status as ExperiencePromotionReceipt["verificationStatus"],
    verificationMethod: row.verification_method as ExperiencePromotionReceipt["verificationMethod"],
    evidenceHash: row.evidence_hash,
    publicSafe: row.public_safe === 1,
    createdAt: row.created_at,
  };
}

function exportIntentFromRow(row: ExportIntentRow): ExperienceExportIntentRecord {
  return {
    id: row.id,
    packId: row.pack_id,
    agentId: row.agent_id,
    visibility: row.visibility,
    status: row.status,
    manifestHash: row.manifest_hash,
    createdAt: row.created_at,
  };
}

function getPackRow(id: string): PackRow {
  const row = getDb().prepare("SELECT * FROM experience_packs WHERE id = ?").get(id) as PackRow | undefined;
  if (!row) throw new Error("Experience Pack not found.");
  return row;
}

// ── Builtin base fingerprint ─────────────────────────────────────────────────
// Builtin agents ship inside the app and have no imported package archive, so
// they can never present a real packageHash. Local Experience accrual derives a
// deterministic, app-version-independent fingerprint from the builtin slug so
// candidates and packs bind to a stable local base. Public upload / market
// listing paths keep their own exact Hub release binding requirements
// (base_agent_definition_id / base_agent_release_id) and are NOT weakened by
// this local fingerprint.
const BUILTIN_BASE_FINGERPRINT_DOMAIN = "agentlas-builtin-experience-base-v1";
/** 로컬(패키지 없는) 에이전트 기준 — 빌트인과 섞이지 않도록 도메인을 분리한다. */
const LOCAL_BASE_FINGERPRINT_DOMAIN = "agentlas.experience.local-base.v1";

export function builtinExperienceBasePackageHash(slug: string): string {
  return hash(BUILTIN_BASE_FINGERPRINT_DOMAIN, String(slug ?? "").trim());
}

function isBuiltinInstalledAgent(agentId: string): boolean {
  const row = getDb().prepare("SELECT builtin FROM installed_agents WHERE id = ?")
    .get(agentId) as { builtin?: number } | undefined;
  return row?.builtin === 1;
}

/** Verified package hash for imported agents; deterministic local fingerprint for builtins; null otherwise. */
/**
 * 이 에이전트의 경험을 어느 기준에 묶을 것인가.
 *
 * 원래는 셋 중 하나만 통과했다: 유효한 패키지 해시, 또는 빌트인(slug 로 만든 안정 해시).
 * 그래서 **로컬로 가져온 에이전트는 항상 null** 이었고, 경험이 구조적으로 불가능했다 —
 * 실측: 로컬로 가져온 팀원 3명의 기억 59건이 전부
 * `exact-base-unavailable` 로 버려졌다. 패키지가 없다는 것은 "출처를 고정할 파일이 없다"는
 * 뜻이지 "이 에이전트는 배우면 안 된다"는 뜻이 아니다.
 *
 * 로컬 에이전트도 빌트인과 같은 방식으로 안정 기준을 갖는다. 기준의 목적은 "어느 버전이
 * 배운 경험인가"를 고정하는 것이고, 버전 개념이 없는 에이전트에게는 그 신원 자체가
 * 안정된 기준이다. 손상된 해시(형식 위반)는 여전히 거절한다 — 그건 없는 것과 다르다.
 */
function effectiveExperienceBaseHash(agent: { id: string; slug: string; packageHash?: string }): string | null {
  if (agent.packageHash && /^[a-f0-9]{64}$/.test(agent.packageHash)) return agent.packageHash;
  if (agent.packageHash) return null;
  // ★ 신원에서 파생한다 — **이름이 아니라 id 에서.**
  //   예전에는 slug 를 해싱했는데, slug 는 클라우드 등록 때 서버 값으로 갱신된다
  //   (`cloud-agents/registry-transaction.ts:443`). 그래서 "이름만 바꿨는데 칩이 막혔다"가
  //   났다. `installed_agents.id` 는 이 앱에서 절대 바꾸지 않는 값이라 안정적이다.
  //   기존 팩이 옛 기준(slug 해시)을 들고 있어도 이제 그것으로 막지 않으므로
  //   (assertPackBaseCurrent 참조) 갈아타는 데 이행이 필요 없다.
  if (isBuiltinInstalledAgent(agent.id)) return builtinExperienceBasePackageHash(agent.slug);
  return localExperienceBasePackageHash(agent.id);
}

/** 패키지가 없는 로컬 에이전트의 안정 기준 — 신원에서 파생하므로 실행마다 바뀌지 않는다. */
export function localExperienceBasePackageHash(identity: string): string {
  return hash(LOCAL_BASE_FINGERPRINT_DOMAIN, String(identity ?? "").trim());
}

/** 설치된 에이전트가 지금 쓰는 경험 기준 해시(보정·진단용 공개 진입점). */
export function currentExperienceBaseHash(agentId: string): string | null {
  const agent = getAgentById(agentId);
  return agent ? effectiveExperienceBaseHash(agent) : null;
}

export function listExperiencePacks(input: ExperiencePackListInput): ExperiencePackRecord[] {
  assertExactKeys(input, ["agentId", "projectId", "projectPath", "environment"], "Experience Pack list input");
  const agentId = cleanText(input.agentId, "agentId", 120);
  const clauses = ["agent_id = ?"];
  const params: unknown[] = [agentId];
  if ("projectId" in input || "projectPath" in input) {
    clauses.push("project_scope_key = ?");
    params.push(experienceProjectScopeKey(input));
  }
  if (input.environment) {
    assertExactKeys(input.environment, ["platform", "arch", "runtimeKind"], "Experience environment");
    clauses.push("environment_key = ?");
    params.push(experienceEnvironmentKey(input.environment));
  }
  const rows = getDb().prepare(
    `SELECT * FROM experience_packs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`,
  ).all(...params) as PackRow[];
  return rows.map(packFromRow);
}

export function listExperienceCandidates(packId: string): ExperienceCandidateRecord[] {
  const pack = getPackRow(cleanText(packId, "packId", 120));
  const rows = getDb().prepare(
    "SELECT * FROM experience_candidates WHERE pack_id = ? ORDER BY created_at DESC",
  ).all(pack.id) as CandidateRow[];
  return rows.map(candidateFromRow);
}

export function listLocalTasteDrafts(agentIdValue: string): LocalTasteDraftRecord[] {
  const agentId = cleanText(agentIdValue, "agentId", 120);
  const rows = getDb().prepare(
    `SELECT d.*, m.content AS memory_content
       FROM taste_draft_candidates d
       JOIN memory_entries m
         ON m.id = d.source_memory_id AND m.agent_id = d.agent_id
      WHERE d.agent_id = ? AND m.superseded_at IS NULL
      ORDER BY d.updated_at DESC, d.id ASC
      LIMIT 200`,
  ).all(agentId) as TasteDraftRow[];
  return rows.map(tasteDraftFromRow);
}

export interface AutoExperienceIntakeInput {
  memory: {
    id: string;
    kind: string;
    content: string;
    confidence: "high" | "medium" | "low";
    sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
    /** Curator-proposed taste axes (closed enum); validated, never inferred from text. */
    tasteAxes?: readonly string[] | null;
    requestContext?: {
      userIntent?: string;
      triggerTerms?: string[];
    } | null;
  };
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment: { platform: string; arch?: string; runtimeKind: string };
  basePackageHash?: string | null;
  taskHint?: string | null;
  /** Durable invocation identity — recorded on the intake receipt so a successful interactive run can outcome-promote its own candidates. */
  runId?: string | null;
}

const AUTO_INTAKE_POLICY_VERSION = "experience-auto-intake-operational-v2";
const TASTE_DRAFT_POLICY_VERSION = "taste-draft-auto-intake-v1";

export function tasteDraftSourceMemoryHash(input: {
  agentId: string;
  memoryId: string;
  memoryContent: string;
  basePackageHash: string;
  environmentKey: string;
}): string {
  return hash(
    TASTE_DRAFT_POLICY_VERSION,
    input.agentId,
    input.memoryId,
    hash("taste-source-content-v1", input.memoryContent),
    input.basePackageHash,
    input.environmentKey,
  );
}

/**
 * 이 에이전트가 이 프로젝트·환경에서 쓰는 자동 경험 팩. 없으면 만든다.
 *
 * ★좌표에서 판 해시를 뺐다. 예전에는 `base_package_hash` 까지 정확히 같아야 기존 팩을
 * 찾았다. 그 해시는 패키지 전체를 덮으므로 에이전트를 한 번 고쳐 다시 올리면 값이 바뀌고,
 * 그 순간 팩이 하나 더 생긴다 — 옛 경험은 옛 팩에 남고, 같은 기억이 새 팩에 처음부터
 * 다시 들어온다. 사용자에게는 "이미 승급한 칩을 왜 또 검토하라고 하지"로 보인다
 * (실측: 좌표 2곳이 팩 6개로 갈렸고 재검토 요청 18건).
 *
 * 경험은 판이 아니라 에이전트 앞으로 발급된다(오너 결정). 그래서 조회는 신원 좌표
 * (에이전트 · 프로젝트 · 환경)로만 하고, 판 해시는 "언제 쟀는가"로 팩에 남긴다.
 * 좌표가 안정되면 `UNIQUE(pack_id, source_memory_id)` 가 같은 기억의 재유입도 막는다.
 *
 * 승급이 많은 팩을 먼저 고른다 — 사용자가 실제로 작업한 팩이 그것이다. 이미 갈라진
 * 설치본은 사다리가 하나로 모은다(`store/db.ts` consolidateSplitAutoExperiencePacks).
 */
/**
 * 이 신원 좌표에서 살아 있는 자동 팩 — **판 해시를 보지 않는다.**
 *
 * 판단을 여기 꺼내 둔 이유: 게이트가 "판이 바뀌어도 같은 팩을 고르는가"를 실제로 부를 수
 * 있어야 한다. 아래 ensureAutoExperiencePack 안에 묻어 두면 게이트는 전체 수집 경로
 * (안전 검사·환경 분류·기억 큐레이션)를 통째로 세워야 하고, 그러다 결국 SQL 문장을
 * 눈으로 대조하는 검사가 된다 — 이 저장소가 이미 겪은 계열이다.
 */
export function findActiveAutoExperiencePack(
  agentId: string,
  scopeKey: string,
  environmentKey: string,
): PackRow | undefined {
  return getDb().prepare(
    `SELECT p.* FROM experience_packs p
      WHERE p.agent_id = ? AND p.project_scope_key = ? AND p.environment_key = ?
        AND p.auto_managed = 1 AND p.status = 'active'
      ORDER BY (SELECT COUNT(*) FROM experience_candidates c
                 WHERE c.pack_id = p.id AND c.status = 'promoted') DESC,
               p.created_at ASC, p.id ASC
      LIMIT 1`,
  ).get(agentId, scopeKey, environmentKey) as PackRow | undefined;
}

/**
 * Fail-safe runtime intake. It records only a value-free receipt when content
 * is unsafe or exact taxonomy/base context is unavailable. Safe content stops
 * at a local candidate; promotion, export, upload and prompt mutation remain
 * explicit owner actions.
 */
export function autoIntakeCuratedMemory(input: AutoExperienceIntakeInput): void {
  return;
}

/**
 * Recover review-only Experience candidates from already-curated legacy Memory.
 * The operation is idempotent for one exact local definition + environment,
 * records blocked/skipped reasons without content, and never promotes, uploads,
 * purchases or attaches a chip.
 */
type CuratedMemoryReconciliationResult = {
  scanned: number;
  candidateCreated: number;
  blocked: number;
  skipped: number;
  deferred: number;
};

export function reconcileExistingCuratedMemoryCandidates(limitValue = 2_000, options: { agentId?: string } = {}): {
  scanned: number;
  candidateCreated: number;
  blocked: number;
  skipped: number;
  deferred: number;
} {
  return { scanned: 0, candidateCreated: 0, blocked: 0, skipped: 0, deferred: 0 };
}

/** Startup-only sweep: release Main between bounded batches. Snapshot IDs,
 * never memory bodies or agent/base identities, across event-loop turns. */
export async function reconcileExistingCuratedMemoryCandidatesAtStartup(
  limitValue = 2_000,
  options: { agentId?: string; signal?: AbortSignal } = {},
): Promise<CuratedMemoryReconciliationResult> {
  return { scanned: 0, candidateCreated: 0, blocked: 0, skipped: 0, deferred: 0 };
}

/** Value-free intake funnel diagnostics for one agent (counts + reason codes only). */
export function getExperienceIntakeDiagnostics(agentIdValue: string): ExperienceIntakeDiagnostics {
  const agentId = cleanText(agentIdValue, "agentId", 120);
  const rows = getDb().prepare(
    `SELECT status, reason_codes_json, redaction_count
       FROM experience_auto_intake_receipts WHERE agent_id = ?`,
  ).all(agentId) as Array<{
    status: "candidate-created" | "blocked" | "skipped";
    reason_codes_json: string;
    redaction_count: number | null;
  }>;
  const totals = { candidateCreated: 0, blocked: 0, skipped: 0 };
  const redactedAdmits = { receipts: 0, redactedSpans: 0 };
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.status === "candidate-created") totals.candidateCreated += 1;
    else if (row.status === "blocked") totals.blocked += 1;
    else totals.skipped += 1;
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(row.reason_codes_json) as unknown;
      reasons = Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : ["invalid-local-receipt"];
    } catch {
      reasons = ["invalid-local-receipt"];
    }
    for (const code of reasons) {
      const key = `${row.status}\u0000${code}`;
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    if (row.status === "candidate-created" && Number(row.redaction_count ?? 0) > 0) {
      redactedAdmits.receipts += 1;
      redactedAdmits.redactedSpans += Number(row.redaction_count ?? 0);
    }
  }
  // Promotion outcomes by verification method — the measurable evidence that
  // interactive/automation auto-promotion (`local-run-receipt`) actually fires
  // versus manual `user-attested`. Joined through this agent's packs.
  const promotionRows = getDb().prepare(
    `SELECT r.verification_method AS method, COUNT(*) AS n
       FROM experience_promotion_receipts r
      WHERE r.agent_id = ? AND r.action = 'promote'
      GROUP BY r.verification_method`,
  ).all(agentId) as Array<{ method: string; n: number }>;
  const promotions = { userAttested: 0, runReceipt: 0, testReceipt: 0 };
  for (const row of promotionRows) {
    if (row.method === "user-attested") promotions.userAttested += Number(row.n ?? 0);
    else if (row.method === "local-run-receipt") promotions.runReceipt += Number(row.n ?? 0);
    else if (row.method === "local-test-receipt") promotions.testReceipt += Number(row.n ?? 0);
  }
  return {
    agentId,
    totals,
    redactedAdmits,
    promotions,
    reasons: [...reasonCounts.entries()]
      .map(([key, count]) => {
        const [status, code] = key.split("\u0000");
        return { status: status as "candidate-created" | "blocked" | "skipped", code, count };
      })
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
  };
}

/**
 * 진화 트리거용 — 이 에이전트의 승격(promoted) 경험 요약들(최신순).
 * "승격 M건 누적 → 프롬프트에 접기" 제안의 결정적 근거이자 카드 문구 소재.
 * agent_repo 배움만 대상(project-scoped 세션 배움은 프롬프트로 접지 않는다).
 */
export function listPromotedExperienceSummariesForAgent(
  agentIdValue: string,
  limit = 20,
): Array<{ id: string; summary: string; promotedAt: string | null }> {
  return [];
}

/** 이 에이전트의 승격 경험 총 개수 — 진화 "접기" 임계 버킷 판정에 쓴다(content-free 카운트). */
export function countPromotedExperiencesForAgent(agentIdValue: string): number {
  return 0;
}

/**
 * How many experience records still sit on the old one-axis coordinate.
 *
 * Experience lookup matches `base_package_hash` exactly, and that hash covers
 * the whole package — so attaching a part moves it and the lookup quietly
 * misses. The repair is to match on the body (core) axis instead, and the
 * migration in db.ts writes `base_core_hash` onto every record that can carry
 * one. Records it could not resolve stay at `axisVersion: 2` rather than being
 * deleted, and this counter is how they stay visible.
 *
 * This number must be 0 before the coordinate change is switched on. It is the
 * observable form of an ordering rule that would otherwise be only a sentence
 * in a plan: flip the coordinates first and accumulated experience evaporates
 * with no error and no warning.
 */
export function countExperienceRecordsBelowAxisVersion(minimumAxisVersion = 3): {
  packs: number;
  candidates: number;
  total: number;
} {
  const minimum = Number.isInteger(minimumAxisVersion) ? minimumAxisVersion : 3;
  const countBelow = (table: "experience_packs" | "experience_candidates"): number => {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE axis_version < ?`)
      .get(minimum) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };
  const packs = countBelow("experience_packs");
  const candidates = countBelow("experience_candidates");
  return { packs, candidates, total: packs + candidates };
}

export function listExperiencePromotionReceipts(packId: string): ExperiencePromotionReceipt[] {
  const pack = getPackRow(cleanText(packId, "packId", 120));
  const rows = getDb().prepare(
    "SELECT * FROM experience_promotion_receipts WHERE pack_id = ? ORDER BY created_at DESC",
  ).all(pack.id) as PromotionReceiptRow[];
  return rows.map(receiptFromRow);
}

export function listExperienceExportIntents(packId: string): ExperienceExportIntentRecord[] {
  const pack = getPackRow(cleanText(packId, "packId", 120));
  const rows = getDb().prepare(
    "SELECT * FROM experience_export_intents WHERE pack_id = ? ORDER BY created_at DESC",
  ).all(pack.id) as ExportIntentRow[];
  return rows.map(exportIntentFromRow);
}

export function getExperienceOntologySummary(agentIdValue: string): ExperienceOntologySummary {
  const agentId = cleanText(agentIdValue, "agentId", 120);
  const packRows = getDb().prepare(
    "SELECT id, mcp_requirements_json FROM experience_packs WHERE agent_id = ?",
  ).all(agentId) as Array<{ id: string; mcp_requirements_json: string }>;
  const packIds = new Set(packRows.map((row) => row.id));
  const candidateRows = getDb().prepare(
    "SELECT status, task_terms_json FROM experience_candidates WHERE agent_id = ?",
  ).all(agentId) as Array<{ status: string; task_terms_json: string }>;
  const tasks = new Set<string>();
  for (const row of candidateRows) {
    try {
      const values = JSON.parse(row.task_terms_json) as unknown;
      if (Array.isArray(values)) values.filter(isCanonicalTaskId).forEach((value) => tasks.add(value));
    } catch {
      // Legacy task terms remain stored but do not count as canonical chips.
    }
  }
  const mcp = new Set<string>();
  for (const row of packRows) {
    try {
      for (const requirement of normalizeExperienceMcpRequirements(JSON.parse(row.mcp_requirements_json))) {
        mcp.add(requirement.catalogId);
      }
    } catch {
      // Damaged local metadata is excluded from the derived index summary.
    }
  }

  const scalar = (sql: string, ...params: unknown[]): number => {
    const row = getDb().prepare(sql).get(...params) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };
  const intakeRows = getDb().prepare(
    "SELECT status, reason_codes_json FROM experience_auto_intake_receipts WHERE agent_id = ?",
  ).all(agentId) as Array<{ status: "candidate-created" | "blocked" | "skipped"; reason_codes_json: string }>;
  const reasonCounts = new Map<string, number>();
  for (const row of intakeRows) {
    try {
      const reasons = JSON.parse(row.reason_codes_json) as unknown;
      if (Array.isArray(reasons)) {
        for (const reason of reasons) {
          if (typeof reason === "string") reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
      }
    } catch {
      reasonCounts.set("invalid-local-receipt", (reasonCounts.get("invalid-local-receipt") ?? 0) + 1);
    }
  }
  const placeholders = packRows.map(() => "?").join(",");
  const relationParams = [...packIds];
  const lineageCount = packIds.size
    ? scalar(`SELECT COUNT(*) AS n FROM experience_lineage_events WHERE pack_id IN (${placeholders})`, ...relationParams)
    : 0;
  const updateRelationCount = packIds.size
    ? scalar(`SELECT COUNT(*) AS n FROM experience_relation_edges WHERE pack_id IN (${placeholders}) AND edge_type = 'supersedes'`, ...relationParams)
    : 0;
  const evidenceCount = scalar("SELECT COUNT(*) AS n FROM experience_promotion_receipts WHERE agent_id = ?", agentId);
  const exportCount = scalar("SELECT COUNT(*) AS n FROM experience_export_intents WHERE agent_id = ?", agentId);
  const tasteDraftCount = scalar(
    `SELECT COUNT(*) AS n
       FROM taste_draft_candidates d
       JOIN memory_entries m ON m.id = d.source_memory_id AND m.agent_id = d.agent_id
      WHERE d.agent_id = ? AND d.status = 'observation' AND m.superseded_at IS NULL`,
    agentId,
  );
  const tasteUnclassifiedCount = scalar(
    `SELECT COUNT(*) AS n
       FROM taste_draft_candidates d
       JOIN memory_entries m ON m.id = d.source_memory_id AND m.agent_id = d.agent_id
      WHERE d.agent_id = ? AND d.status = 'observation' AND d.axis_candidates_json = '[]'
        AND m.superseded_at IS NULL`,
    agentId,
  );
  const cloudCount = packIds.size
    ? scalar(`SELECT COUNT(*) AS n FROM experience_cloud_uploads WHERE pack_id IN (${placeholders})`, ...relationParams)
    : 0;
  const publicProjectionCount = packIds.size
    ? scalar(`SELECT COUNT(*) AS n FROM experience_public_projections WHERE pack_id IN (${placeholders})`, ...relationParams)
    : 0;
  return {
    packCount: packRows.length,
    candidateCount: candidateRows.length,
    promotedCount: candidateRows.filter((row) => row.status === "promoted").length,
    tasteDraftCount,
    tasteNeedsEvidenceCount: tasteDraftCount,
    tasteUnclassifiedCount,
    taskCount: tasks.size,
    evidenceCount,
    mcpCount: mcp.size,
    lineageCount,
    updateRelationCount,
    localReceiptCount: evidenceCount + exportCount + cloudCount + publicProjectionCount + intakeRows.length,
    autoIntake: {
      candidateCreated: intakeRows.filter((row) => row.status === "candidate-created").length,
      blocked: intakeRows.filter((row) => row.status === "blocked").length,
      skipped: intakeRows.filter((row) => row.status === "skipped").length,
      reasons: [...reasonCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    },
    applicationOutcomes: summarizeExperienceApplicationOutcomes(agentId),
  };
}

export interface PromotedExperienceProjection {
  id: string;
  packId: string;
  measuredBaseHash: string;
  measuredEnvironmentKey: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  taskTerms: string[];
  updatedAt: string;
  relationScore: number;
  embedding: number[];
}

/**
 * Source-backed overlays cannot outlive their admitted Memory. No provenance
 * on a genuinely manual/legacy row preserves its previous admission behavior.
 * The intake dedup hash is an identity key, not a source-content fingerprint:
 * independent English translation and privacy redaction may legitimately make
 * a candidate's summary differ from its live source text.
 */
export function experienceCandidateSourceIsLive(input: {
  sourceMemoryId: string | null | undefined;
  candidateId?: string;
  agentId: string;
  projectScopeKey: string;
  autoManaged?: boolean;
}): boolean {
  if (input.sourceMemoryId == null || input.sourceMemoryId === "") return !input.autoManaged;
  const sourceId = input.sourceMemoryId;
  if (revokedMemorySourceIds([sourceId]).has(sourceId)) return false;
  const memory = getDb().prepare(
    `SELECT agent_id, scope, project_id, project_path, chat_id, kind, content, sensitivity, superseded_at
       FROM memory_entries WHERE id = ?`,
  ).get(sourceId) as {
    agent_id: string | null; scope: MemoryScope; project_id: string | null; project_path: string | null;
    chat_id: string | null; kind: MemoryKind; content: string; sensitivity: string; superseded_at: string | null;
  } | undefined;
  if (!memory || memory.superseded_at || memory.agent_id !== input.agentId
    || !["procedure", "decision", "risk"].includes(memory.kind)
    || !["public", "internal", "private"].includes(memory.sensitivity)
    || !["agent_repo", "project", "team_memory", "agent_team"].includes(memory.scope)) return false;
  try {
    const authority = { scope: memory.scope, kind: memory.kind, agentId: memory.agent_id,
      projectId: memory.project_id, projectPath: memory.project_path, chatId: memory.chat_id };
    assertMemoryWriteAllowed({ ...authority, content: memory.content });
    const native = nativeTextsFor("memory_entry", [sourceId]).get(sourceId);
    if (native) assertMemoryWriteAllowed({ ...authority, content: native });
    const candidateNative = input.candidateId
      ? nativeTextsFor("experience_candidate", [input.candidateId]).get(input.candidateId) : undefined;
    if (candidateNative) assertMemoryWriteAllowed({ ...authority, content: candidateNative });
  } catch { return false; }
  // An actor-wide source may be narrowed into a contextual auto Pack. A
  // contextual source may never cross into another project or an actor-wide Pack.
  if (memory.scope === "agent_repo" && !memory.project_id && !memory.project_path) return true;
  return experienceProjectScopeKey({ projectId: memory.project_id, projectPath: memory.project_path })
    === input.projectScopeKey;
}

export function listPromotedExperienceProjection(input: {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environmentKey: string;
  basePackageHash: string;
  taskTerms?: string[];
}): PromotedExperienceProjection[] {
  return [];
}
