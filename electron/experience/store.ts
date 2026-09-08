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
import { getDb } from "../store/db";
import { hasDurableRunStartReceipt } from "../store/run-events";
import {
  normalizeExperienceMcpRequirements,
  rankExperienceCandidatesByRelations,
  rebuildExperienceRelationIndex,
  recordExperienceLineageEvent,
  refreshExperienceRelationArtifacts,
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

function assertPublicExperienceText(text: string): void {
  if (publicExperienceSafetyIssues(text).length > 0) {
    throw new Error("Public-safe Experience text contains private, local, prompt, transcript, or opaque identifier data.");
  }
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

const TASTE_AXIS_HINTS: Record<TasteAxis, RegExp> = {
  composition: /\b(?:composition|layouts?|alignment|grid|asymmetr\w*|symmetr\w*|framing)\b|구도|레이아웃|정렬|그리드|비대칭|대칭/i,
  color: /\b(?:colou?r|palette|saturation|contrast|monochrom|hue)\b|색상|컬러|팔레트|채도|대비|명도|흑백/i,
  typography: /\b(?:typograph|font|typeface|lettering|kerning|leading)\b|타이포|글꼴|폰트|서체|자간|행간/i,
  motion: /\b(?:motion|animation|transition|easing|kinetic)\b|모션|애니메이션|전환|이징|움직임/i,
  pacing: /\b(?:pacing|tempo|rhythm|duration|speed|timing)\b|속도감|템포|호흡|타이밍|리듬/i,
  density: /\b(?:density|spacing|whitespace|minimal|maximal|clutter)\b|밀도|여백|미니멀|맥시멀|복잡|정보량/i,
  imagery: /\b(?:image|imagery|photo|illustration|render|cinematic|visual)\b|이미지|사진|일러스트|렌더|시네마틱|비주얼/i,
  editing: /\b(?:editing|edit|cut|montage|sequence)\b|편집|컷|몽타주|시퀀스/i,
  "spatial-rhythm": /\b(?:spatial|proportion|scale|depth|perspective)\b|공간감|비율|스케일|깊이|원근/i,
};

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

function getCandidateRow(id: string): CandidateRow {
  const row = getDb().prepare("SELECT * FROM experience_candidates WHERE id = ?").get(id) as CandidateRow | undefined;
  if (!row) throw new Error("Experience candidate not found.");
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

/**
 * 팩이 아직 이 에이전트의 것인가 — **누구 것인가만 본다. 어느 판인가로 막지 않는다.**
 *
 * 예전에는 지금 설치본의 기준 해시가 팩에 박힌 값과 **정확히 같아야** 통과했다. 그래서
 * 에이전트를 한 번 개선해 다시 올리면 그 순간부터 승급·수집·내보내기·클라우드 동기화가
 * 전부 막혔다 — 사용자에게는 "고쳤더니 경험이 죽었다"로 보인다. 이름만 바꿔도 같았다
 * (패키지 없는 에이전트의 기준값은 slug 해시이고 slug 는 설치 때 갱신된다).
 *
 * 오너 결정: **칩은 에이전트의 부속품이 아니라 그 에이전트 앞으로 발급된 독립 자산이다.**
 * agentId 만 같으면 어느 판에든 붙는다. 판 번호는 지우지 않고 "언제 쟀는가"로 남긴다.
 *
 * 소유자 검증은 여기가 아니라 서버 리스·권리 검사가 한다 — 그쪽은 결제 경계라 그대로 둔다.
 */
function assertPackBaseCurrent(pack: PackRow): void {
  const agent = getAgentById(pack.agent_id);
  if (!agent) {
    throw new Error("Experience Pack has no installed agent.");
  }
  if (effectiveExperienceBaseHash(agent) !== pack.base_package_hash) {
    // 막지 않는다. 기록만 남긴다 — 어느 판에서 잰 경험인지 나중에 되짚을 수 있어야 한다.
    console.log(
      `[experience] pack ${pack.id} was measured on a different build (pack=${String(pack.base_package_hash).slice(0, 12)} current=${String(effectiveExperienceBaseHash(agent)).slice(0, 12)}) — attaching anyway, same agent`,
    );
  }
}

export function createExperiencePack(input: ExperiencePackCreateInput): ExperiencePackRecord {
  assertExactKeys(input, ["agentId", "name", "description", "projectId", "projectPath", "environment", "mcpRequirements"], "Experience Pack input");
  const agentId = cleanText(input.agentId, "agentId", 120);
  const agent = getAgentById(agentId);
  if (!agent) throw new Error("Experience Pack requires an installed agent.");
  if (!agent.packageHash || !/^[a-f0-9]{64}$/.test(agent.packageHash)) {
    throw new Error("Experience Pack requires a verified base package hash.");
  }
  const name = cleanText(input.name, "Experience Pack name", 80);
  const description = cleanText(input.description ?? "", "Experience Pack description", 500, false);
  assertExactKeys(input.environment, ["platform", "arch", "runtimeKind"], "Experience environment");
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim().slice(0, 120) : null;
  const projectPath = normalizedProjectPath(input.projectPath);
  const mcpRequirements = normalizeExperienceMcpRequirements(input.mcpRequirements, agent.mcpServers ?? []);
  const id = randomUUID();
  const now = new Date().toISOString();
  const environmentProfile = canonicalEnvironmentProfile(input.environment);
  getDb().prepare(
    `INSERT INTO experience_packs (
       id, agent_id, project_id, project_path, project_scope_key, environment_key,
       environment_profile_json, auto_managed, name, description, base_package_hash,
       mcp_requirements_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    agentId,
    projectId,
    projectPath,
    experienceProjectScopeKey({ projectId, projectPath }),
    experienceEnvironmentKey(input.environment),
    JSON.stringify(environmentProfile),
    name,
    description,
    agent.packageHash,
    JSON.stringify(mcpRequirements),
    now,
    now,
  );
  try {
    rebuildExperienceRelationIndex();
  } catch (error) {
    console.warn(`[experience-relations] initial rebuild deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return packFromRow(getPackRow(id));
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

function taskTerms(memory: MemoryProjectionRow): string[] {
  const text: string[] = [memory.content];
  try {
    const context = JSON.parse(memory.context_json || "{}") as Record<string, unknown>;
    if (typeof context.userIntent === "string") text.push(context.userIntent);
    if (typeof context.user_intent === "string") text.push(context.user_intent);
    const triggers = Array.isArray(context.triggerTerms)
      ? context.triggerTerms
      : Array.isArray(context.trigger_terms)
        ? context.trigger_terms
        : [];
    text.push(...triggers.filter((item): item is string => typeof item === "string"));
  } catch {
    // Curated content remains sufficient when an old context capsule is malformed.
  }
  return classifyCanonicalTaskIds(...text);
}

export function captureExperienceCandidate(input: ExperienceCandidateCaptureInput): ExperienceCandidateRecord {
  assertExactKeys(input, ["packId", "sourceMemoryId"], "Experience candidate capture input");
  const pack = getPackRow(cleanText(input.packId, "packId", 120));
  if (pack.status !== "active") throw new Error("Archived Experience Packs cannot accept candidates.");
  assertPackBaseCurrent(pack);
  const memoryId = cleanText(input.sourceMemoryId, "sourceMemoryId", 120);
  const memory = getDb().prepare(
    `SELECT id, kind, content, project_id, project_path, agent_id, confidence, sensitivity,
            context_json, superseded_at
       FROM memory_entries WHERE id = ?`,
  ).get(memoryId) as MemoryProjectionRow | undefined;
  if (!memory || memory.superseded_at) throw new Error("Experience capture requires a live curated Memory entry.");
  if (!new Set(["procedure", "decision", "risk"]).has(memory.kind)) {
    throw new Error("Operational Experience accepts procedure, decision, or risk Memory only. Preferences belong to private Taste drafts.");
  }
  if (memory.agent_id !== pack.agent_id) throw new Error("Experience memory must belong to the same agent as the Pack.");
  const memoryScopeKey = experienceProjectScopeKey({ projectId: memory.project_id, projectPath: memory.project_path });
  if (memoryScopeKey !== pack.project_scope_key) throw new Error("Experience memory must belong to the same project scope as the Pack.");
  const summary = cleanText(memory.content, "Curated experience summary", 1_200);
  const captureIssues = publicExperienceSafetyIssues(summary);
  if (captureIssues.length > 0) {
    throw new Error(`Experience candidates must be generic and cannot contain private, local, prompt, transcript, account, or source-package material (${captureIssues.join(", ")}).`);
  }
  if (memory.sensitivity === "secret" || memory.sensitivity === "confidential") {
    throw new Error("Secret or confidential Memory cannot become an Experience candidate.");
  }
  if (memory.sensitivity !== "public" && memory.sensitivity !== "internal" && memory.sensitivity !== "private") {
    throw new Error("Unsupported Memory sensitivity for Experience capture.");
  }
  const existing = getDb().prepare(
    "SELECT * FROM experience_candidates WHERE pack_id = ? AND source_memory_id = ?",
  ).get(pack.id, memory.id) as CandidateRow | undefined;
  if (existing) return candidateFromRow(existing);
  const confidence = memory.confidence === "high" || memory.confidence === "low" ? memory.confidence : "medium";
  const id = randomUUID();
  const now = new Date().toISOString();
  const canonicalTasks = taskTerms(memory);
  const embedding = autoLocalEmbedding(summary);
  getDb().prepare(
    `INSERT INTO experience_candidates (
       id, pack_id, agent_id, project_scope_key, environment_key, source_memory_id,
       summary, task_terms_json, sensitivity, confidence, status, outcome_status,
       public_safe, auto_managed, embedding_model, embedding_adapter,
       embedding_model_sha256, embedding_content_hash, embedding_dimensions,
       embedding_json, created_at, updated_at, promoted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 'unverified', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    pack.id,
    pack.agent_id,
    pack.project_scope_key,
    pack.environment_key,
    memory.id,
    summary,
    JSON.stringify(canonicalTasks),
    memory.sensitivity,
    confidence,
    embedding.model,
    embedding.adapter,
    embedding.modelSha256,
    embedding.contentHash,
    embedding.dimensions,
    JSON.stringify(embedding.vector),
    now,
    now,
  );
  return candidateFromRow(getCandidateRow(id));
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

/**
 * The exact base identity this intake binds to: the supplied verified package
 * hash when it matches the installed agent, or the deterministic builtin
 * fingerprint when the installed agent is builtin (no package archive exists).
 * Null means no exact base is available and operational intake must skip.
 */
function resolveEffectiveIntakeBase(input: Pick<AutoExperienceIntakeInput, "agentId" | "basePackageHash">): string | null {
  const agent = getAgentById(input.agentId);
  if (!agent) return null;
  const effective = effectiveExperienceBaseHash(agent);
  if (!effective) return null;
  const supplied = input.basePackageHash ?? null;
  if (supplied === effective) return effective;
  // Builtin lane: callers pass null because no package hash exists on disk.
  if (supplied === null && !agent.packageHash) return effective;
  return null;
}

function autoIntakeSourceMemoryHash(input: AutoExperienceIntakeInput): string {
  let environmentKey = "environment-unavailable";
  try {
    environmentKey = experienceEnvironmentKey(input.environment);
  } catch {
    // The receipt stays value-free and retryable under a future valid context.
  }
  return hash(
    AUTO_INTAKE_POLICY_VERSION,
    input.agentId,
    input.memory.id,
    resolveEffectiveIntakeBase(input) ?? input.basePackageHash ?? "base-unavailable",
    environmentKey,
  );
}

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

function inferTasteAxes(text: string): TasteAxis[] {
  return TASTE_AXES.filter((axis) => TASTE_AXIS_HINTS[axis].test(text));
}

/**
 * Captures only a private observation. It does not create a Hub Taste release,
 * pairwise receipt, preview, success score, promotion, upload, or loadout.
 */
function autoIntakeTasteDraft(input: AutoExperienceIntakeInput): "created" | "existing" | "deferred" {
  const agent = getAgentById(input.agentId);
  const basePackageHash = resolveEffectiveIntakeBase(input);
  if (!agent || !basePackageHash) return "deferred";
  const profile = canonicalEnvironmentProfile(input.environment);
  if (!isRuntimeEligibleExperienceEnvironmentProfile(profile)) return "deferred";
  const environmentKey = experienceEnvironmentKey(input.environment);
  const sourceMemoryHash = tasteDraftSourceMemoryHash({
    agentId: input.agentId,
    memoryId: input.memory.id,
    memoryContent: input.memory.content,
    basePackageHash,
    environmentKey,
  });
  const existing = getDb().prepare(
    `SELECT id FROM taste_draft_candidates
      WHERE agent_id = ? AND source_memory_hash = ? AND base_package_hash = ? LIMIT 1`,
  ).get(input.agentId, sourceMemoryHash, basePackageHash);
  if (existing) return "existing";

  const tasks = classifyCanonicalTaskIds(
    input.taskHint,
    input.memory.requestContext?.userIntent,
    ...(input.memory.requestContext?.triggerTerms ?? []),
  );
  const binding = agent.assetSource === "hub" || agent.assetSource === "agent-cloud"
    ? getDb().prepare(
      `SELECT agent_definition_id, agent_release_id
         FROM installed_agent_hub_bindings
        WHERE installed_agent_id = ? LIMIT 1`,
    ).get(input.agentId) as { agent_definition_id: string; agent_release_id: string } | undefined
    : undefined;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT OR IGNORE INTO taste_draft_candidates (
       id, agent_id, source_memory_id, source_memory_hash, project_scope_key,
       environment_key, base_package_hash, base_agent_definition_id,
       base_agent_release_id, sensitivity, confidence,
       axis_candidates_json, task_signatures_json, evidence_state, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pairwise-required', 'observation', ?, ?)`,
  ).run(
    randomUUID(),
    input.agentId,
    input.memory.id,
    sourceMemoryHash,
    experienceProjectScopeKey(input),
    environmentKey,
    basePackageHash,
    binding?.agent_definition_id ?? null,
    binding?.agent_release_id ?? null,
    input.memory.sensitivity,
    input.memory.confidence,
    JSON.stringify(inferTasteAxes(input.memory.content)),
    JSON.stringify(tasks),
    now,
    now,
  );
  return "created";
}

function recordAutoIntakeReceipt(input: {
  agentId: string;
  sourceMemoryHash: string;
  memoryKind: string;
  status: "candidate-created" | "blocked" | "skipped";
  reasons: string[];
  packId?: string | null;
  candidateId?: string | null;
  runId?: string | null;
  redactionCount?: number;
}): void {
  const runId = typeof input.runId === "string" && SAFE_EVIDENCE_REF_RE.test(input.runId.trim())
    ? input.runId.trim()
    : null;
  getDb().prepare(
    `INSERT OR IGNORE INTO experience_auto_intake_receipts (
       id, agent_id, pack_id, candidate_id, source_memory_hash, status,
       memory_kind, reason_codes_json, run_id, redaction_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.agentId,
    input.packId ?? null,
    input.candidateId ?? null,
    input.sourceMemoryHash,
    input.status,
    input.memoryKind,
    JSON.stringify([...new Set(input.reasons)].sort()),
    runId,
    Math.max(0, Math.trunc(input.redactionCount ?? 0)),
    new Date().toISOString(),
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

function ensureAutoExperiencePack(input: AutoExperienceIntakeInput): PackRow {
  const environmentKey = experienceEnvironmentKey(input.environment);
  const scopeKey = experienceProjectScopeKey(input);
  const existing = findActiveAutoExperiencePack(input.agentId, scopeKey, environmentKey);
  if (existing) return existing;

  const agent = getAgentById(input.agentId);
  if (!agent) throw new Error("Auto Experience intake requires an installed agent.");
  const profile = canonicalEnvironmentProfile(input.environment);
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO experience_packs (
       id, agent_id, project_id, project_path, project_scope_key, environment_key,
       environment_profile_json, auto_managed, name, description, base_package_hash,
       mcp_requirements_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.projectId ?? null,
    normalizedProjectPath(input.projectPath),
    scopeKey,
    environmentKey,
    JSON.stringify(profile),
    "Auto Experience Draft",
    "Review-only candidates accumulated from privacy-safe curated Memory. Nothing is promoted or uploaded automatically.",
    input.basePackageHash,
    JSON.stringify(normalizeExperienceMcpRequirements(undefined, agent.mcpServers ?? [])),
    now,
    now,
  );
  return getPackRow(id);
}

/**
 * Fail-safe runtime intake. It records only a value-free receipt when content
 * is unsafe or exact taxonomy/base context is unavailable. Safe content stops
 * at a local candidate; promotion, export, upload and prompt mutation remain
 * explicit owner actions.
 */
export function autoIntakeCuratedMemory(input: AutoExperienceIntakeInput): void {
  // experience_auto_intake_receipts and experience_candidates both FK
  // agent_id → installed_agents(id). Org-chart team members bind their memory
  // by agentSlug and have no installed_agents row, so any intake write here
  // would throw a FOREIGN KEY constraint and abort the caller's curation.
  // Skip intake for a non-installed owner (its memory still drives runtime
  // prompts); experience accrual requires a first-class installed agent.
  const ownerInstalled = getDb()
    .prepare("SELECT 1 FROM installed_agents WHERE id = ? LIMIT 1")
    .get(input.agentId);
  if (!ownerInstalled) return;

  const sourceMemoryHash = autoIntakeSourceMemoryHash(input);
  const runId = input.runId ?? null;
  const recordBlocked = (reasons: string[], redactionCount = 0): void => {
    const duplicate = getDb().prepare(
      "SELECT 1 FROM experience_auto_intake_receipts WHERE agent_id = ? AND source_memory_hash = ? LIMIT 1",
    ).get(input.agentId, sourceMemoryHash);
    if (duplicate) return;
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "blocked",
      reasons,
      runId,
      redactionCount,
    });
  };

  // Hard blocks stay hard: secrets/credentials, prompt/transcript/source
  // material, labeled account identifiers, IP addresses, and sensitive memory
  // are never redact-admitted.
  const hardIssues: string[] = [];
  if (input.memory.sensitivity === "secret" || input.memory.sensitivity === "confidential") {
    hardIssues.push("sensitive-memory");
  } else if (!["public", "internal", "private"].includes(input.memory.sensitivity)) {
    hardIssues.push("unsupported-sensitivity");
  }
  const rawIssues = publicExperienceSafetyIssues(input.memory.content);
  hardIssues.push(...rawIssues.filter((code) => !REDACTABLE_PRIVACY_CODES.has(code)));
  if (hardIssues.length > 0) {
    recordBlocked(hardIssues);
    return;
  }

  // Redact-and-admit: span-redact paths/URLs (<경로>/<URL>), emails (<이메일>)
  // and opaque or phone-shaped numbers (<ID>), then re-scan. Any residue after
  // redaction is a hard block — never a partial admit. Raw redacted-out text
  // must not reach the candidate body, relation index, or any receipt.
  let operationalContent = input.memory.content;
  let redactionCount = 0;
  if (rawIssues.length > 0) {
    const redaction = redactExperiencePrivacySpans(input.memory.content);
    const residualIssues = publicExperienceSafetyIssues(redaction.text);
    if (residualIssues.length > 0) {
      recordBlocked([...residualIssues, "redaction-insufficient"], redaction.redactions);
      return;
    }
    operationalContent = redaction.text;
    redactionCount = redaction.redactions;
  }

  // Preference memories take a separate lane. The local row is merely a
  // private observation and is created before consulting the operational
  // receipt so legacy "skipped" receipts can be reconciled without rewriting
  // their append-only decision history.
  const tasteDraftResult = input.memory.kind === "preference"
    ? autoIntakeTasteDraft(input)
    : null;
  const duplicate = getDb().prepare(
    "SELECT 1 FROM experience_auto_intake_receipts WHERE agent_id = ? AND source_memory_hash = ? LIMIT 1",
  ).get(input.agentId, sourceMemoryHash);
  if (duplicate) return;

  const operationalKinds = new Set(["procedure", "decision", "risk"]);
  if (!operationalKinds.has(input.memory.kind)) {
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "skipped",
      reasons: [input.memory.kind === "preference"
        ? tasteDraftResult === "created" || tasteDraftResult === "existing"
          ? "preference-captured-as-private-taste-draft"
          : "preference-requires-taste-evidence"
        : "non-operational-memory-kind"],
      runId,
    });
    return;
  }

  const basePackageHash = resolveEffectiveIntakeBase(input);
  if (!basePackageHash) {
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "skipped",
      reasons: ["exact-base-unavailable"],
      runId,
    });
    return;
  }

  const profile = canonicalEnvironmentProfile(input.environment);
  if (!isRuntimeEligibleExperienceEnvironmentProfile(profile)) {
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "skipped",
      reasons: ["environment-taxonomy-unavailable"],
      runId,
    });
    return;
  }

  const tasks = classifyCanonicalTaskIds(
    input.taskHint,
    operationalContent,
    input.memory.requestContext?.userIntent,
    ...(input.memory.requestContext?.triggerTerms ?? []),
  );
  /*
   * ★분류에 실패했다고 경험을 버리지 않는다(오너 결정 2026-08-16).
   *
   * 작업 분류는 23개 낱말 규칙으로 정해진다. 거기 안 걸리는 일은 늘 있고 — 런타임 정산,
   * 권한 경계, 릴리즈 절차처럼 규칙에 없는 주제 — 예전에는 그런 기억이 통째로 버려졌다
   * (실측 218건, 그 중 174건이 One). 분류는 나중에 이 칩을 **찾기 위한** 꼬리표이지
   * 칩이 존재할 자격이 아니다. 꼬리표가 비면 검색이 조금 불편할 뿐, 버리면 경험 자체가
   * 사라진다. 판정 모델이 붙으면 같은 후보를 다시 분류할 수 있다.
   *
   * 영수증에는 분류가 비었다는 사실을 남긴다 — 규칙이 현실을 얼마나 못 따라가는지
   * 세어 볼 수 있어야 나중에 고칠 수 있다.
   */
  const taskTermsUnavailable = tasks.length === 0;

  const pack = ensureAutoExperiencePack({ ...input, basePackageHash });
  const existingCandidate = getDb().prepare(
    "SELECT * FROM experience_candidates WHERE pack_id = ? AND source_memory_id = ? LIMIT 1",
  ).get(pack.id, input.memory.id) as CandidateRow | undefined;
  if (existingCandidate) {
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "candidate-created",
      reasons: [
        ...(redactionCount > 0 ? ["redacted-admit"] : []),
        // 분류가 비었어도 후보는 만든다 — 세어 볼 수 있게 사실만 남긴다.
        ...(taskTermsUnavailable ? ["task-taxonomy-empty"] : []),
      ],
      packId: pack.id,
      candidateId: existingCandidate.id,
      runId,
      redactionCount,
    });
    return;
  }

  const candidateId = randomUUID();
  const now = new Date().toISOString();
  const summary = cleanText(operationalContent, "Auto Experience candidate", 1_200);
  const embedding = autoLocalEmbedding(summary);
  const transaction = getDb().transaction(() => {
    getDb().prepare(
      `INSERT INTO experience_candidates (
         id, pack_id, agent_id, project_scope_key, environment_key, source_memory_id,
         summary, task_terms_json, sensitivity, confidence, status, outcome_status,
         public_safe, auto_managed, embedding_model, embedding_adapter,
         embedding_model_sha256, embedding_content_hash, embedding_dimensions,
         embedding_json, created_at, updated_at, promoted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 'unverified', 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      candidateId,
      pack.id,
      input.agentId,
      pack.project_scope_key,
      pack.environment_key,
      input.memory.id,
      summary,
      JSON.stringify(tasks),
      input.memory.sensitivity,
      input.memory.confidence,
      embedding.model,
      embedding.adapter,
      embedding.modelSha256,
      embedding.contentHash,
      embedding.dimensions,
      JSON.stringify(embedding.vector),
      now,
      now,
    );
    recordAutoIntakeReceipt({
      agentId: input.agentId,
      sourceMemoryHash,
      memoryKind: input.memory.kind,
      status: "candidate-created",
      reasons: [
        ...(redactionCount > 0 ? ["redacted-admit"] : []),
        // 분류가 비었어도 후보는 만든다 — 세어 볼 수 있게 사실만 남긴다.
        ...(taskTermsUnavailable ? ["task-taxonomy-empty"] : []),
      ],
      packId: pack.id,
      candidateId,
      runId,
      redactionCount,
    });
  });
  transaction();
}

function requestContextFromMemory(raw: string | null): AutoExperienceIntakeInput["memory"]["requestContext"] {
  try {
    const value = JSON.parse(raw || "{}") as Record<string, unknown>;
    const userIntent = typeof value.userIntent === "string"
      ? value.userIntent
      : typeof value.user_intent === "string"
        ? value.user_intent
        : undefined;
    const sourceTerms = Array.isArray(value.triggerTerms)
      ? value.triggerTerms
      : Array.isArray(value.trigger_terms)
        ? value.trigger_terms
        : [];
    const triggerTerms = sourceTerms.filter((item): item is string => typeof item === "string").slice(0, 32);
    return userIntent || triggerTerms.length > 0 ? { ...(userIntent ? { userIntent } : {}), triggerTerms } : null;
  } catch {
    return null;
  }
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

// Keep each intake, including its candidate/receipt transaction, synchronous.
// Both callers share the same privacy, identity and duplicate checks.
function reconcileCuratedMemoryRow(memory: MemoryProjectionRow, result: CuratedMemoryReconciliationResult): void {
  if (!memory.agent_id) return;
  result.scanned += 1;
  try {
    const agent = getAgentById(memory.agent_id);
    const requestContext = requestContextFromMemory(memory.context_json);
    const input: AutoExperienceIntakeInput = {
      memory: {
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        confidence: memory.confidence === "high" || memory.confidence === "low" ? memory.confidence : "medium",
        sensitivity: memory.sensitivity as AutoExperienceIntakeInput["memory"]["sensitivity"],
        requestContext,
      },
      agentId: memory.agent_id,
      projectId: memory.project_id,
      projectPath: memory.project_path,
      environment: { platform: process.platform, arch: process.arch, runtimeKind: "agentlas-desktop" },
      basePackageHash: agent ? effectiveExperienceBaseHash(agent) : null,
      taskHint: requestContext?.userIntent ?? requestContext?.triggerTerms?.join(" ") ?? null,
    };
    autoIntakeCuratedMemory(input);
    const receipt = getDb().prepare(
      "SELECT status FROM experience_auto_intake_receipts WHERE agent_id = ? AND source_memory_hash = ? LIMIT 1",
    ).get(memory.agent_id, autoIntakeSourceMemoryHash(input)) as { status?: string } | undefined;
    if (receipt?.status === "candidate-created") result.candidateCreated += 1;
    else if (receipt?.status === "blocked") result.blocked += 1;
    else if (receipt?.status === "skipped") result.skipped += 1;
    else result.deferred += 1;
  } catch {
    result.deferred += 1;
  }
}

export function reconcileExistingCuratedMemoryCandidates(limitValue = 2_000, options: { agentId?: string } = {}): {
  scanned: number;
  candidateCreated: number;
  blocked: number;
  skipped: number;
  deferred: number;
} {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(limitValue)));
  // 아키텍처 마이그레이션은 에이전트 한 명씩 돈다(원장이 에이전트 단위라 결과도 그 단위여야
  // 한다). 인자가 없으면 예전처럼 전체를 훑는다.
  const only = typeof options.agentId === "string" && options.agentId.trim() ? options.agentId.trim() : null;
  const rows = getDb().prepare(
    `SELECT id, kind, content, project_id, project_path, agent_id, confidence,
            sensitivity, context_json, superseded_at
       FROM memory_entries
      WHERE agent_id IS NOT NULL AND superseded_at IS NULL
        AND (? IS NULL OR agent_id = ?)
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
  ).all(only, only, limit) as MemoryProjectionRow[];
  const result = { scanned: 0, candidateCreated: 0, blocked: 0, skipped: 0, deferred: 0 };

  for (const memory of rows) reconcileCuratedMemoryRow(memory, result);
  return result;
}

/** Startup-only sweep: release Main between bounded batches. Snapshot IDs,
 * never memory bodies or agent/base identities, across event-loop turns. */
export async function reconcileExistingCuratedMemoryCandidatesAtStartup(
  limitValue = 2_000,
  options: { agentId?: string; signal?: AbortSignal } = {},
): Promise<CuratedMemoryReconciliationResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const limit = Math.max(1, Math.min(10_000, Math.trunc(limitValue)));
  const only = typeof options.agentId === "string" && options.agentId.trim() ? options.agentId.trim() : null;
  const ids = getDb().prepare(
    `SELECT id FROM memory_entries
      WHERE agent_id IS NOT NULL AND superseded_at IS NULL
        AND (? IS NULL OR agent_id = ?)
      ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(only, only, limit) as Array<{ id: string }>;
  const readCurrent = getDb().prepare(
    `SELECT id, kind, content, project_id, project_path, agent_id, confidence,
            sensitivity, context_json, superseded_at
       FROM memory_entries WHERE id = ? AND agent_id IS NOT NULL
        AND superseded_at IS NULL AND (? IS NULL OR agent_id = ?)`,
  );
  const result = { scanned: 0, candidateCreated: 0, blocked: 0, skipped: 0, deferred: 0 };
  let batchStarted = performance.now();
  let batchRows = 0;
  for (let index = 0; index < ids.length; index += 1) {
    signal?.throwIfAborted();
    // A user may delete/supersede a Memory or replace an agent while we yield.
    // Read fresh content and resolve the exact current base inside this turn.
    const memory = readCurrent.get(ids[index].id, only, only) as MemoryProjectionRow | undefined;
    if (memory) reconcileCuratedMemoryRow(memory, result);
    batchRows += 1;
    if (index + 1 < ids.length && (batchRows >= 32 || performance.now() - batchStarted >= 8)) {
      await yieldToMain(undefined, { signal });
      signal?.throwIfAborted();
      batchRows = 0;
      batchStarted = performance.now();
    }
  }
  signal?.throwIfAborted();
  return result;
}

function validatedEvidenceRefs(input: ExperiencePromotionInput): string[] {
  const refs = input.verification?.evidenceRefs;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 16) {
    throw new Error("Experience verification requires 1-16 value-free evidence IDs.");
  }
  const clean = refs.map((value) => typeof value === "string" ? value.trim() : "");
  if (clean.some((value) => !SAFE_EVIDENCE_REF_RE.test(value))) {
    throw new Error("Experience evidence must use value-free IDs, not paths, URLs, or raw output.");
  }
  return [...new Set(clean)].sort();
}

export function promoteExperienceCandidate(input: ExperiencePromotionInput): ExperiencePromotionReceipt {
  assertExactKeys(input, ["candidateId", "explicitConsent", "verification", "publicSafe"], "Experience promotion input");
  if (input.explicitConsent !== true) throw new Error("Experience promotion requires explicit consent.");
  assertExactKeys(input.verification, ["status", "method", "evidenceRefs"], "Experience verification");
  if (input.verification.status !== "attested" || input.verification.method !== "user-attested") {
    throw new Error("P0 Experience promotion supports user-attested review only; it is not official verification.");
  }
  const refs = validatedEvidenceRefs(input);
  const candidate = getCandidateRow(cleanText(input.candidateId, "candidateId", 120));
  const pack = getPackRow(candidate.pack_id);
  assertPackBaseCurrent(pack);
  const existing = getDb().prepare(
    "SELECT * FROM experience_promotion_receipts WHERE candidate_id = ? AND action = 'promote'",
  ).get(candidate.id) as PromotionReceiptRow | undefined;
  if (existing) {
    try {
      recordExperienceLineageEvent(existing.pack_id, "promotion");
      refreshExperienceRelationArtifacts(existing.pack_id);
    } catch (error) {
      console.warn(`[experience-relations] existing promotion sync deferred: ${error instanceof Error ? error.message : "unknown"}`);
    }
    return receiptFromRow(existing);
  }
  if (candidate.status !== "candidate") throw new Error("Only pending Experience candidates can be promoted.");
  // Manual review is only an attestation. It must never mint a verified/public
  // receipt in the same action: public release is a separate owner action that
  // re-runs the canonical privacy scan through unsealExperienceCandidatePublic.
  if (input.publicSafe === true) {
    throw new Error("Direct user attestation is not an authoritative local verifier. Promote privately, then use the separate public unseal gate.");
  }
  const publicSafe = false;
  const id = randomUUID();
  const now = new Date().toISOString();
  const evidenceHash = hash("experience-evidence-v1", ...refs);
  const transaction = getDb().transaction(() => {
    getDb().prepare(
      `INSERT INTO experience_promotion_receipts (
         id, pack_id, candidate_id, agent_id, action, explicit_consent,
         verification_status, verification_method, evidence_hash, public_safe, created_at
       ) VALUES (?, ?, ?, ?, 'promote', 1, ?, 'user-attested', ?, ?, ?)`,
    ).run(
      id,
      candidate.pack_id,
      candidate.id,
      candidate.agent_id,
      publicSafe ? "verified" : "attested",
      evidenceHash,
      publicSafe ? 1 : 0,
      now,
    );
    getDb().prepare(
      `UPDATE experience_candidates
          SET status = 'promoted', outcome_status = ?, public_safe = ?,
              updated_at = ?, promoted_at = ?
        WHERE id = ? AND status = 'candidate'`,
    ).run(publicSafe ? "verified" : "attested", publicSafe ? 1 : 0, now, now, candidate.id);
    getDb().prepare("UPDATE experience_packs SET updated_at = ? WHERE id = ?")
      .run(now, candidate.pack_id);
    recordExperienceLineageEvent(candidate.pack_id, "promotion");
  });
  transaction();
  try {
    refreshExperienceRelationArtifacts(candidate.pack_id);
  } catch (error) {
    console.warn(`[experience-relations] promotion projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return receiptFromRow(
    getDb().prepare("SELECT * FROM experience_promotion_receipts WHERE id = ?").get(id) as PromotionReceiptRow,
  );
}

/** 복구 파이프라인이 방금 만든 후보를 소스 메모리로 되찾는다(자율 승격 경로 전용). */
export function findExperienceCandidateBySourceMemory(
  agentId: string,
  sourceMemoryId: string,
): { id: string; status: string } | null {
  const row = getDb().prepare(
    "SELECT id, status FROM experience_candidates WHERE agent_id = ? AND source_memory_id = ? LIMIT 1",
  ).get(agentId, sourceMemoryId) as { id: string; status: string } | undefined;
  return row ?? null;
}

/**
 * Outcome-attested 자율 승격 — 사람 검토(user-attested) 대신 "실제 성공 런 영수증"이
 * 증거인 승격 경로. 스키마의 verification_method 'local-run-receipt' 슬롯을 사용한다.
 * 자율 진화 정책(자동 적용+사후통보+롤백)에 따라 explicit consent는 정책 수준에서
 * 부여된 것으로 간주하되, user-attested와 method로 구분돼 감사 가능하다.
 * 실패 후 방법 전환 → 성공이 확인된 런(runId에 invoke_started 영수증 존재)만 허용된다.
 */
export function promoteExperienceCandidateFromRunReceipt(input: {
  candidateId: string;
  runId: string;
}): ExperiencePromotionReceipt {
  const candidateId = cleanText(input.candidateId, "candidateId", 120);
  const runId = cleanText(input.runId, "runId", 120);
  if (!SAFE_EVIDENCE_REF_RE.test(runId)) {
    throw new Error("Run receipt evidence must be a value-free run id.");
  }
  if (!hasDurableRunStartReceipt(runId)) {
    throw new Error("Outcome promotion requires a durable run receipt for the successful run.");
  }
  const candidate = getCandidateRow(candidateId);
  const pack = getPackRow(candidate.pack_id);
  assertPackBaseCurrent(pack);
  const existing = getDb().prepare(
    "SELECT * FROM experience_promotion_receipts WHERE candidate_id = ? AND action = 'promote'",
  ).get(candidate.id) as PromotionReceiptRow | undefined;
  if (existing) return receiptFromRow(existing);
  if (candidate.status !== "candidate") throw new Error("Only pending Experience candidates can be promoted.");
  const id = randomUUID();
  const now = new Date().toISOString();
  const evidenceHash = hash("experience-evidence-v1", runId);
  const transaction = getDb().transaction(() => {
    getDb().prepare(
      `INSERT INTO experience_promotion_receipts (
         id, pack_id, candidate_id, agent_id, action, explicit_consent,
         verification_status, verification_method, evidence_hash, public_safe, created_at
       ) VALUES (?, ?, ?, ?, 'promote', 1, 'attested', 'local-run-receipt', ?, 0, ?)`,
    ).run(id, candidate.pack_id, candidate.id, candidate.agent_id, evidenceHash, now);
    getDb().prepare(
      `UPDATE experience_candidates
          SET status = 'promoted', outcome_status = 'attested', public_safe = 0,
              updated_at = ?, promoted_at = ?
        WHERE id = ? AND status = 'candidate'`,
    ).run(now, now, candidate.id);
    getDb().prepare("UPDATE experience_packs SET updated_at = ? WHERE id = ?")
      .run(now, candidate.pack_id);
    recordExperienceLineageEvent(candidate.pack_id, "promotion");
  });
  transaction();
  try {
    refreshExperienceRelationArtifacts(candidate.pack_id);
  } catch (error) {
    console.warn(`[experience-relations] outcome promotion projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return receiptFromRow(
    getDb().prepare("SELECT * FROM experience_promotion_receipts WHERE id = ?").get(id) as PromotionReceiptRow,
  );
}

/**
 * ★Owner decision 2026-08-16 — experience chips promote themselves.
 *
 * Promotion used to need a `run_id` on the intake receipt, and only the chat
 * path writes one. Measured on a live library: orchestrator had 21 promoted
 * chips while One sat on 176 candidates and appbridge on 30, every one of them
 * with a null run_id — so those two surfaces could never promote at all, by any
 * route. The owner could not find a way to promote them by hand either, because
 * there is no screen that reaches a candidate the run-receipt query cannot see.
 *
 * A candidate with no run_id is not less true; it just arrived through a path
 * (One durable memory, imports, recovery) that never carried the id. So the
 * agent's next successful turn promotes its waiting candidates too, attested by
 * that run. Everything else stays as it was: only pending candidates, only when
 * the pack base still matches, idempotent through the UNIQUE promote receipt.
 */
export function promoteWaitingExperienceCandidates(input: {
  agentId: string;
  runId: string;
  limit?: number;
}): { eligible: number; promoted: number } {
  const agentId = cleanText(input.agentId, "agentId", 120);
  const runId = cleanText(input.runId, "runId", 120);
  if (!SAFE_EVIDENCE_REF_RE.test(runId)) {
    throw new Error("Run receipt evidence must be a value-free run id.");
  }
  if (!hasDurableRunStartReceipt(runId)) return { eligible: 0, promoted: 0 };
  // A bound keeps one turn from doing unbounded work on a long-neglected
  // library; the rest are picked up by the turns that follow.
  const limit = Math.max(1, Math.min(Number(input.limit ?? 25), 200));
  const rows = getDb().prepare(
    `SELECT c.id
       FROM experience_candidates c
       JOIN experience_packs p ON p.id = c.pack_id
      WHERE c.agent_id = ? AND c.status = 'candidate'
      ORDER BY c.created_at ASC
      LIMIT ?`,
  ).all(agentId, limit) as Array<{ id: string }>;
  if (rows.length === 0) return { eligible: 0, promoted: 0 };
  let promoted = 0;
  for (const row of rows) {
    try {
      promoteExperienceCandidateFromRunReceipt({ candidateId: row.id, runId });
      promoted += 1;
    } catch {
      // A stale pack base or a candidate promoted by a concurrent turn is not a
      // reason to abandon the rest of the batch.
    }
  }
  return { eligible: rows.length, promoted };
}

/**
 * Interactive-run auto-promotion — after a chat turn completes successfully
 * with a durable run start receipt, promote exactly the candidates this run's
 * intake created (receipt-linked by run_id). Uses the same outcome-attested
 * machinery as automation recovery (`local-run-receipt`), stays idempotent via
 * the UNIQUE promote receipt, and promotes nothing without a durable receipt.
 */
export function promoteExperienceCandidatesForRun(input: {
  agentId: string;
  runId: string;
}): { eligible: number; promoted: number } {
  const agentId = cleanText(input.agentId, "agentId", 120);
  const runId = cleanText(input.runId, "runId", 120);
  if (!SAFE_EVIDENCE_REF_RE.test(runId)) {
    throw new Error("Run receipt evidence must be a value-free run id.");
  }
  const rows = getDb().prepare(
    `SELECT r.candidate_id
       FROM experience_auto_intake_receipts r
       JOIN experience_candidates c ON c.id = r.candidate_id AND c.agent_id = r.agent_id
      WHERE r.agent_id = ? AND r.run_id = ? AND r.status = 'candidate-created'
        AND r.candidate_id IS NOT NULL AND c.status = 'candidate'
      ORDER BY r.created_at ASC`,
  ).all(agentId, runId) as Array<{ candidate_id: string }>;
  if (rows.length === 0) return { eligible: 0, promoted: 0 };
  // Failed/cancelled turns never reach this call site, and even a mistaken
  // call cannot promote: the durable start receipt is re-checked here and
  // inside the promotion itself.
  if (!hasDurableRunStartReceipt(runId)) return { eligible: rows.length, promoted: 0 };
  let promoted = 0;
  for (const row of rows) {
    promoteExperienceCandidateFromRunReceipt({ candidateId: row.candidate_id, runId });
    promoted += 1;
  }
  return { eligible: rows.length, promoted };
}

/**
 * Explicit owner-consented public unseal of one already-promoted candidate.
 * ALL of the following must hold, otherwise this throws:
 *  1. explicitConsent === true (owner action, renderer-invoked),
 *  2. the candidate is promoted with a receipt whose method is
 *     'user-attested' or 'local-run-receipt',
 *  3. the stored (post-redaction) summary passes the full public privacy scan,
 *  4. the candidate sensitivity is 'public' or 'internal' — private,
 *     confidential, and secret sources can never be unsealed,
 *  5. the pack base still matches the installed agent.
 * The existing promote receipt is upgraded to verified + public_safe, which is
 * exactly what the public export-intent branch requires.
 */
export function unsealExperienceCandidatePublic(input: {
  candidateId: string;
  explicitConsent: true;
}): ExperiencePromotionReceipt {
  assertExactKeys(input, ["candidateId", "explicitConsent"], "Experience public unseal input");
  if (input.explicitConsent !== true) throw new Error("Public unseal requires explicit owner consent.");
  const candidate = getCandidateRow(cleanText(input.candidateId, "candidateId", 120));
  const pack = getPackRow(candidate.pack_id);
  assertPackBaseCurrent(pack);
  const receipt = getDb().prepare(
    "SELECT * FROM experience_promotion_receipts WHERE candidate_id = ? AND action = 'promote'",
  ).get(candidate.id) as PromotionReceiptRow | undefined;
  if (!receipt) {
    throw new Error("Public unseal requires an existing promotion receipt (user-attested or local-run-receipt).");
  }
  if (receipt.verification_method !== "user-attested" && receipt.verification_method !== "local-run-receipt") {
    throw new Error("Public unseal accepts only user-attested or local-run-receipt promotions.");
  }
  if (candidate.status !== "promoted") throw new Error("Only promoted Experience candidates can be unsealed.");
  if (candidate.sensitivity !== "public" && candidate.sensitivity !== "internal") {
    throw new Error("Private, confidential, or secret candidates can never be unsealed publicly.");
  }
  assertPublicExperienceText(candidate.summary);
  if (receipt.public_safe === 1 && receipt.verification_status === "verified") {
    return receiptFromRow(receipt);
  }
  const now = new Date().toISOString();
  const transaction = getDb().transaction(() => {
    getDb().prepare(
      `UPDATE experience_promotion_receipts
          SET verification_status = 'verified', public_safe = 1
        WHERE id = ?`,
    ).run(receipt.id);
    getDb().prepare(
      `UPDATE experience_candidates
          SET outcome_status = 'verified', public_safe = 1, updated_at = ?
        WHERE id = ? AND status = 'promoted'`,
    ).run(now, candidate.id);
    getDb().prepare("UPDATE experience_packs SET updated_at = ? WHERE id = ?")
      .run(now, candidate.pack_id);
    recordExperienceLineageEvent(candidate.pack_id, "promotion");
  });
  transaction();
  try {
    refreshExperienceRelationArtifacts(candidate.pack_id);
  } catch (error) {
    console.warn(`[experience-relations] public unseal projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return receiptFromRow(
    getDb().prepare("SELECT * FROM experience_promotion_receipts WHERE id = ?").get(receipt.id) as PromotionReceiptRow,
  );
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
  const agentId = cleanText(agentIdValue, "agentId", 120);
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT id, summary, promoted_at
         FROM experience_candidates
        WHERE agent_id = ? AND status = 'promoted'
        ORDER BY datetime(COALESCE(promoted_at, updated_at)) DESC
        LIMIT ?`,
    )
    .all(agentId, capped) as Array<{ id: string; summary: string; promoted_at: string | null }>;
  return rows.map((row) => ({ id: row.id, summary: row.summary, promotedAt: row.promoted_at }));
}

/** 이 에이전트의 승격 경험 총 개수 — 진화 "접기" 임계 버킷 판정에 쓴다(content-free 카운트). */
export function countPromotedExperiencesForAgent(agentIdValue: string): number {
  const agentId = cleanText(agentIdValue, "agentId", 120);
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM experience_candidates WHERE agent_id = ? AND status = 'promoted'")
    .get(agentId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
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

export function createExperienceExportIntent(input: ExperienceExportIntentInput): ExperienceExportIntentRecord {
  assertExactKeys(input, ["packId", "visibility"], "Experience export intent");
  if (input.visibility !== "private" && input.visibility !== "public") {
    throw new Error("Experience export visibility must be private or public.");
  }
  const pack = getPackRow(cleanText(input.packId, "packId", 120));
  if (pack.status !== "active") throw new Error("Archived Experience Packs cannot be exported.");
  assertPackBaseCurrent(pack);
  const rows = getDb().prepare(
    `SELECT c.id, c.source_memory_id, c.summary, c.sensitivity, c.confidence,
            c.outcome_status, c.public_safe, r.id AS receipt_id,
            r.verification_status, r.verification_method, r.evidence_hash,
            r.created_at AS receipt_created_at
       FROM experience_candidates c
       JOIN experience_promotion_receipts r ON r.candidate_id = c.id AND r.action = 'promote'
      WHERE c.pack_id = ? AND c.status = 'promoted'
        AND c.outcome_status IN ('attested','verified')
      ORDER BY c.id ASC`,
  ).all(pack.id) as Array<{
    id: string;
    source_memory_id: string;
    summary: string;
    sensitivity: string;
    confidence: string;
    outcome_status: string;
    public_safe: number;
    receipt_id: string;
    verification_status: string;
    verification_method: string;
    evidence_hash: string;
    receipt_created_at: string;
  }>;
  if (rows.length === 0) throw new Error("Experience export requires at least one promoted attested item.");
  if (input.visibility === "public") {
    assertPublicExperienceText(pack.name);
    assertPublicExperienceText(pack.description);
    for (const row of rows) assertPublicExperienceText(row.summary);
    if (rows.some((row) => row.public_safe !== 1 || row.verification_status !== "verified")) {
      throw new Error("Public Experience export requires authoritative verified public-safe receipts; P0 attestation is insufficient.");
    }
  }
  const canonicalManifest = {
    schemaVersion: "experience-export-intent/1.0",
    visibility: input.visibility,
    pack: {
      id: pack.id,
      agentId: pack.agent_id,
      name: pack.name,
      description: pack.description,
      basePackageHash: pack.base_package_hash,
      projectScopeKey: pack.project_scope_key,
      environmentKey: pack.environment_key,
      status: pack.status,
      mcpRequirements: (() => {
        try {
          return normalizeExperienceMcpRequirements(JSON.parse(pack.mcp_requirements_json));
        } catch {
          return [];
        }
      })(),
    },
    items: rows.map((row) => ({
      candidateId: row.id,
      sourceMemoryId: row.source_memory_id,
      contentHash: hash("experience-summary-v1", row.summary),
      sensitivity: row.sensitivity,
      confidence: row.confidence,
      outcomeStatus: row.outcome_status,
      publicSafe: row.public_safe === 1,
      receipt: {
        id: row.receipt_id,
        verificationStatus: row.verification_status,
        verificationMethod: row.verification_method,
        evidenceHash: row.evidence_hash,
        createdAt: row.receipt_created_at,
      },
    })),
  };
  const manifestHash = hash("experience-export-intent-v1", JSON.stringify(canonicalManifest));
  const existing = getDb().prepare(
    `SELECT * FROM experience_export_intents
      WHERE pack_id = ? AND visibility = ? AND manifest_hash = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(pack.id, input.visibility, manifestHash) as ExportIntentRow | undefined;
  if (existing) {
    try {
      recordExperienceLineageEvent(pack.id, "export-intent");
      refreshExperienceRelationArtifacts(pack.id);
    } catch (error) {
      console.warn(`[experience-relations] existing export lineage sync deferred: ${error instanceof Error ? error.message : "unknown"}`);
    }
    return exportIntentFromRow(existing);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const transaction = getDb().transaction(() => {
    getDb().prepare(
      `INSERT INTO experience_export_intents (
         id, pack_id, agent_id, visibility, status, manifest_hash, created_at
       ) VALUES (?, ?, ?, ?, 'local_intent', ?, ?)`,
    ).run(id, pack.id, pack.agent_id, input.visibility, manifestHash, now);
    recordExperienceLineageEvent(pack.id, "export-intent");
  });
  transaction();
  try {
    refreshExperienceRelationArtifacts(pack.id);
  } catch (error) {
    console.warn(`[experience-relations] export projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return exportIntentFromRow(
    getDb().prepare("SELECT * FROM experience_export_intents WHERE id = ?").get(id) as ExportIntentRow,
  );
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
  };
}

export interface PromotedExperienceProjection {
  id: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  taskTerms: string[];
  updatedAt: string;
  relationScore: number;
  embedding: number[];
}

export function listPromotedExperienceProjection(input: {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environmentKey: string;
  basePackageHash: string;
  taskTerms?: string[];
}): PromotedExperienceProjection[] {
  if (!/^[a-f0-9]{64}$/.test(input.basePackageHash)) return [];
  const rows = getDb().prepare(
    `SELECT c.id, c.summary, c.confidence, c.task_terms_json, c.updated_at,
            c.embedding_model, c.embedding_adapter, c.embedding_model_sha256,
            c.embedding_content_hash, c.embedding_dimensions, c.embedding_json
       FROM experience_candidates c
       JOIN experience_packs p ON p.id = c.pack_id AND p.agent_id = c.agent_id
      WHERE c.agent_id = ? AND c.project_scope_key = ? AND c.environment_key = ?
        AND p.project_scope_key = c.project_scope_key
        AND p.environment_key = c.environment_key
        AND p.status = 'active' AND p.base_package_hash = ?
        AND c.status = 'promoted' AND c.outcome_status IN ('attested','verified')
        AND NOT EXISTS (
          SELECT 1
            FROM experience_governance_relations governance
            JOIN experience_candidates replacement
              ON replacement.id = governance.from_candidate_id
             AND replacement.pack_id = governance.pack_id
             AND replacement.agent_id = governance.agent_id
           WHERE governance.to_candidate_id = c.id
             AND governance.pack_id = c.pack_id
             AND governance.agent_id = c.agent_id
             AND governance.relation_type = 'supersedes'
             AND replacement.status = 'promoted'
             AND replacement.outcome_status IN ('attested','verified')
        )
      ORDER BY c.updated_at DESC`,
  ).all(
    input.agentId,
    experienceProjectScopeKey(input),
    input.environmentKey,
    input.basePackageHash,
  ) as Array<{
    id: string;
    summary: string;
    confidence: "high" | "medium" | "low";
    task_terms_json: string;
    updated_at: string;
    embedding_model: string | null;
    embedding_adapter: string | null;
    embedding_model_sha256: string | null;
    embedding_content_hash: string | null;
    embedding_dimensions: number | null;
    embedding_json: string | null;
  }>;
  let relationScores = new Map<string, number>();
  try {
    relationScores = rankExperienceCandidatesByRelations({
      projectScopeKey: experienceProjectScopeKey(input),
      environmentKey: input.environmentKey,
      basePackageHash: input.basePackageHash,
      taskTerms: input.taskTerms ?? [],
    });
  } catch (error) {
    console.warn(`[experience-relations] relation ranking unavailable: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return rows.map((row) => {
    let terms: string[] = [];
    try {
      const parsed = JSON.parse(row.task_terms_json) as unknown;
      if (Array.isArray(parsed)) terms = parsed.filter((item): item is string => typeof item === "string").slice(0, 32);
    } catch {
      terms = [];
    }
    let embedding = parseLocalEmbedding(row.embedding_model, row.embedding_dimensions, row.embedding_json, {
      adapter: row.embedding_adapter,
      modelSha256: row.embedding_model_sha256,
      contentHash: row.embedding_content_hash,
      text: row.summary,
    });
    if (!embedding) {
      embedding = autoLocalEmbedding(row.summary);
      try {
        getDb().prepare(
          `UPDATE experience_candidates
              SET embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                  embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
            WHERE id = ?`,
        ).run(
          embedding.model,
          embedding.adapter,
          embedding.modelSha256,
          embedding.contentHash,
          embedding.dimensions,
          JSON.stringify(embedding.vector),
          row.id,
        );
      } catch {
        // Keep retrieval read-compatible with a concurrent legacy Desktop peer.
      }
    }
    return {
      id: row.id,
      summary: row.summary,
      confidence: row.confidence,
      taskTerms: terms,
      updatedAt: row.updated_at,
      relationScore: relationScores.get(row.id) ?? 0,
      embedding: embedding.vector,
    };
  }).sort((left, right) => right.relationScore - left.relationScore || right.updatedAt.localeCompare(left.updatedAt));
}
