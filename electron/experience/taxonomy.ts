import type { CanonicalExperienceEnvironmentProfile } from "../../shared/experience";
import { judgeSubset, peekSubsetJudgment } from "../system-agents/judgment";

export const EXPERIENCE_TASK_PREFIX = "agentlas.task.v1/";
export const EXPERIENCE_ENV_PREFIX = "agentlas.env.v1/";

export const EXPERIENCE_TASK_SLUGS = [
  "research",
  "writing",
  "coding",
  "debugging",
  "design",
  "image-generation",
  "video-production",
  "presentation",
  "document",
  "data-analysis",
  "browser-automation",
  "social-publishing",
  "marketing",
  "sales",
  "customer-support",
  "ecommerce",
  "legal-review",
  "finance",
  "project-planning",
  "agent-building",
  "workflow-automation",
  "file-operations",
  "translation",
] as const;

export type ExperienceTaskSlug = typeof EXPERIENCE_TASK_SLUGS[number];

const TASK_SLUG_SET = new Set<string>(EXPERIENCE_TASK_SLUGS);
const ENV_OS_VALUES = new Set(["macos", "windows", "linux", "ios", "android", "unknown"]);
const ENV_ARCH_VALUES = new Set(["arm64", "x64", "unknown"]);
const ENV_RUNTIME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TASK_RULES: ReadonlyArray<{ slug: ExperienceTaskSlug; pattern: RegExp }> = [
  {
    slug: "debugging",
    pattern: /\b(?:debug(?:ging)?|bug(?:\s+fix)?|fix\s+bug|error|exception|failure|failed|troubleshoot)\b|디버그|디버깅|버그(?:\s*수정)?|오류(?:\s*수정)?|에러|실패/iu,
  },
  { slug: "coding", pattern: /\b(?:code|coding|implement|refactor|typescript|javascript|python|swift|kotlin)\b|코드|구현|리팩터|개발/iu },
  { slug: "research", pattern: /\b(?:research|investigate|study|evidence|source)\b|리서치|연구|조사|근거|출처/iu },
  {
    slug: "writing",
    pattern: /\b(?:writing|copywriting|article|essay|rewrite|write (?:an? )?(?:article|copy|blog|essay|text|content))\b|글쓰기|글 작성|카피 작성|원고 작성|문구|카피|기사|에세이/iu,
  },
  { slug: "design", pattern: /\b(?:design|ui|ux|layout|wireframe)\b|디자인|화면|레이아웃|와이어프레임/iu },
  { slug: "image-generation", pattern: /\b(?:image|photo|illustration|poster|thumbnail)\b|이미지|사진|일러스트|포스터|썸네일/iu },
  { slug: "video-production", pattern: /\b(?:video|film|cinematic|subtitle|shot)\b|영상|비디오|영화|자막|촬영/iu },
  { slug: "presentation", pattern: /\b(?:presentation|slides?|pptx|deck)\b|발표|프레젠테이션|슬라이드|피피티/iu },
  { slug: "document", pattern: /\b(?:document|docx|pdf|contract draft)\b|문서|워드|계약서|보고서/iu },
  { slug: "data-analysis", pattern: /\b(?:data|analysis|analytics|metric|sql|spreadsheet|excel)\b|데이터|분석|지표|엑셀|스프레드시트/iu },
  { slug: "browser-automation", pattern: /\b(?:browser|playwright|selenium|navigate|click)\b|브라우저|클릭|웹 자동화/iu },
  { slug: "social-publishing", pattern: /\b(?:instagram|tiktok|threads|linkedin|social publish)\b|인스타|틱톡|스레드|소셜 발행|게시/iu },
  { slug: "marketing", pattern: /\b(?:marketing|campaign|seo|growth|brand)\b|마케팅|캠페인|성장|브랜드/iu },
  { slug: "sales", pattern: /\b(?:sales|lead|prospect|crm|pipeline)\b|영업|리드|잠재고객/iu },
  { slug: "customer-support", pattern: /\b(?:customer support|support ticket|helpdesk|cs)\b|고객지원|고객 성공|문의 대응/iu },
  { slug: "ecommerce", pattern: /\b(?:ecommerce|commerce|shop|store|product listing)\b|이커머스|커머스|쇼핑몰|상품 등록/iu },
  { slug: "legal-review", pattern: /\b(?:legal|law|litigation|compliance|contract review)\b|법률|소송|준법|계약 검토/iu },
  { slug: "finance", pattern: /\b(?:finance|financial|stock|investment|trading|accounting)\b|금융|재무|주식|투자|회계/iu },
  { slug: "project-planning", pattern: /\b(?:project plan|roadmap|milestone|specification|prd)\b|기획|로드맵|마일스톤|요구사항/iu },
  { slug: "agent-building", pattern: /\b(?:agent build|build agent|agent architecture|multi-agent)\b|에이전트 빌드|에이전트 설계|멀티에이전트/iu },
  {
    slug: "workflow-automation",
    pattern: /\b(?:workflow automation|automate workflow|automation workflow|schedule|cron|pipeline)\b|워크플로 자동화|업무 자동화|스케줄|파이프라인/iu,
  },
  { slug: "file-operations", pattern: /\b(?:file|folder|directory|rename|move|copy files?)\b|파일|폴더|디렉터리|이름 변경|이동/iu },
  { slug: "translation", pattern: /\b(?:translate|translation|localize|localization)\b|번역|현지화/iu },
];

export function canonicalTaskId(slug: ExperienceTaskSlug): string {
  return `${EXPERIENCE_TASK_PREFIX}${slug}`;
}

export function isCanonicalTaskId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(EXPERIENCE_TASK_PREFIX)) return false;
  return TASK_SLUG_SET.has(value.slice(EXPERIENCE_TASK_PREFIX.length));
}

/** Judgment-cache kind (mirrors the terminal engine's experience-task-class contract). */
export const EXPERIENCE_TASK_JUDGMENT_KIND = "experience-task-class";

/** The exact judgment input the resolver warms and the synchronous classifier peeks. */
export function taskClassJudgmentInput(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => typeof value === "string")
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
}

function explicitDeclaredTaskIds(text: string): string[] {
  const explicit = text.match(/agentlas\.task\.v1\/[a-z0-9-]+/g) ?? [];
  const found = new Set(explicit.filter(isCanonicalTaskId));
  return EXPERIENCE_TASK_SLUGS.map(canonicalTaskId).filter((id) => found.has(id));
}

function lexicalCanonicalTaskIds(text: string): string[] {
  const found = new Set(explicitDeclaredTaskIds(text));
  for (const rule of TASK_RULES) {
    if (rule.pattern.test(text)) found.add(canonicalTaskId(rule.slug));
  }
  return EXPERIENCE_TASK_SLUGS.map(canonicalTaskId).filter((id) => found.has(id));
}

/**
 * TASK_RULES no longer make the final classification: the resident judge decides
 * which kinds of work the text genuinely involves, and the wordlists are hints +
 * the labeled fallback. Synchronous overlay/prior paths call this after an async
 * pre-pass warmed the same subset judgment (see resolveCanonicalTaskIds); a cache
 * miss keeps today's deterministic verdict. Explicit `agentlas.task.v1/*` ids in
 * the text are closed-form and always win outright, mirroring the terminal
 * engine's resolveCanonicalTaskClasses contract (declared ids win; the prefilter
 * never invents; a model verdict replaces the prefilter, never pads it).
 */
export function classifyCanonicalTaskIds(...values: Array<string | null | undefined>): string[] {
  const text = taskClassJudgmentInput(...values);
  const declared = explicitDeclaredTaskIds(text);
  if (declared.length > 0) return lexicalCanonicalTaskIds(text);
  const peeked = peekSubsetJudgment<ExperienceTaskSlug>(EXPERIENCE_TASK_JUDGMENT_KIND, EXPERIENCE_TASK_SLUGS, text);
  if (peeked && peeked.source === "llm") {
    const selected = new Set(peeked.selected);
    return EXPERIENCE_TASK_SLUGS.filter((slug) => selected.has(slug)).map(canonicalTaskId);
  }
  return lexicalCanonicalTaskIds(text);
}

export interface ResolvedCanonicalTaskIds {
  taskIds: string[];
  /** "llm" = the model decided; "fallback" = today's wordlist verdict, labeled. */
  source: "llm" | "fallback";
  reason: string;
}

const TASK_CLASS_HINTS: Array<{ label: ExperienceTaskSlug; words: string[] }> = TASK_RULES.map((rule) => ({
  label: rule.slug,
  words: [...new Set(rule.pattern.source
    .split(/[|()]/)
    .map((part) => part.replace(/\\b|\?:|\\s\+|[\\^$*+?.{}[\]]/g, " ").replace(/\s+/g, " ").trim())
    .filter((word) => word.length >= 2 && /^[a-z0-9가-힣][a-z0-9가-힣 -]*$/i.test(word)))]
    .slice(0, 12),
}));

/**
 * Async resolver: judge the canonical task classes by meaning (kind
 * "experience-task-class", labels = canonical slugs, TASK_RULES as hints), warming
 * the subset cache that `classifyCanonicalTaskIds` peeks. Declared explicit ids
 * stay closed-form and skip the judge entirely.
 */
export async function resolveCanonicalTaskIds(
  values: Array<string | null | undefined>,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    judgeSubsetFn?: typeof judgeSubset;
  } = {},
): Promise<ResolvedCanonicalTaskIds> {
  const text = taskClassJudgmentInput(...values);
  const lexical = lexicalCanonicalTaskIds(text);
  const declared = explicitDeclaredTaskIds(text);
  if (declared.length > 0) {
    return { taskIds: lexical, source: "fallback", reason: "explicit canonical ids declared" };
  }
  if (!text.trim()) return { taskIds: lexical, source: "fallback", reason: "empty text" };
  const run = opts.judgeSubsetFn ?? judgeSubset;
  let verdict: Awaited<ReturnType<typeof judgeSubset>>;
  try {
    verdict = await run({
      kind: EXPERIENCE_TASK_JUDGMENT_KIND,
      question:
        "Which kinds of work does this request actually involve? Judge the user's real task, not words that merely appear.",
      labels: EXPERIENCE_TASK_SLUGS,
      input: text,
      guidance:
        "Return a label only when that kind of work is genuinely part of the request. A word inside an " +
        "unrelated compound or a different sense of the word does not count. Return an empty list for " +
        "content with no identifiable task (hashes, ids, random strings).",
      hints: TASK_CLASS_HINTS,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  } catch {
    return { taskIds: lexical, source: "fallback", reason: "judge failed" };
  }
  if (verdict.source !== "llm") {
    return { taskIds: lexical, source: "fallback", reason: verdict.reason };
  }
  const selected = new Set(verdict.selected);
  return {
    taskIds: EXPERIENCE_TASK_SLUGS.filter((slug) => selected.has(slug)).map(canonicalTaskId),
    source: "llm",
    reason: verdict.reason,
  };
}

/** Warm the task-class judgment the synchronous classifier peeks. Best-effort. */
export async function prejudgeCanonicalTaskIds(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  try {
    await resolveCanonicalTaskIds([text], opts);
  } catch {
    // Sync sites keep the labeled wordlist fallback.
  }
}

function canonicalOs(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (["darwin", "mac", "macos", "osx"].includes(normalized)) return "macos";
  if (["win32", "win", "windows"].includes(normalized)) return "windows";
  if (normalized === "linux") return "linux";
  if (normalized === "ios") return "ios";
  if (normalized === "android") return "android";
  return "unknown";
}

function canonicalArch(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (["arm64", "aarch64"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return "unknown";
}

function canonicalRuntime(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return ENV_RUNTIME_RE.test(normalized) ? normalized : "unknown";
}

export function canonicalEnvironmentProfile(input: {
  platform: string;
  arch?: string;
  runtimeKind: string;
}): CanonicalExperienceEnvironmentProfile {
  const os = `${EXPERIENCE_ENV_PREFIX}os/${canonicalOs(input.platform)}`;
  const arch = `${EXPERIENCE_ENV_PREFIX}arch/${canonicalArch(input.arch ?? "unknown")}`;
  const runtime = `${EXPERIENCE_ENV_PREFIX}runtime/${canonicalRuntime(input.runtimeKind)}`;
  return {
    schema: "agentlas.experience-environment-profile.v1",
    os,
    arch,
    runtime,
    constraints: [os, arch, runtime],
  };
}

export function parseCanonicalEnvironmentProfile(value: unknown): CanonicalExperienceEnvironmentProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.schema !== "agentlas.experience-environment-profile.v1") return null;
  const constraints = Array.isArray(data.constraints)
    ? data.constraints.filter((item): item is string => typeof item === "string")
    : [];
  const osValue = typeof data.os === "string" ? data.os.slice(`${EXPERIENCE_ENV_PREFIX}os/`.length) : "";
  const archValue = typeof data.arch === "string" ? data.arch.slice(`${EXPERIENCE_ENV_PREFIX}arch/`.length) : "";
  const runtimeValue = typeof data.runtime === "string" ? data.runtime.slice(`${EXPERIENCE_ENV_PREFIX}runtime/`.length) : "";
  if (
    typeof data.os !== "string" || typeof data.arch !== "string" || typeof data.runtime !== "string" ||
    !data.os.startsWith(`${EXPERIENCE_ENV_PREFIX}os/`) ||
    !data.arch.startsWith(`${EXPERIENCE_ENV_PREFIX}arch/`) ||
    !data.runtime.startsWith(`${EXPERIENCE_ENV_PREFIX}runtime/`) ||
    !ENV_OS_VALUES.has(osValue) ||
    !ENV_ARCH_VALUES.has(archValue) ||
    !ENV_RUNTIME_RE.test(runtimeValue) ||
    constraints.length !== 3 ||
    ![data.os, data.arch, data.runtime].every((item) => constraints.includes(item))
  ) return null;
  return {
    schema: "agentlas.experience-environment-profile.v1",
    os: data.os,
    arch: data.arch,
    runtime: data.runtime,
    constraints: [data.os, data.arch, data.runtime],
  };
}

/**
 * Portable metadata may retain an explicit `unknown` dimension, but unknown
 * host facts are never sufficient authority to select or learn runtime
 * Experience. Keep this activation predicate separate from portable parsing so
 * storage/export compatibility cannot accidentally become an execution grant.
 */
export function isRuntimeEligibleExperienceEnvironmentProfile(value: unknown): boolean {
  const profile = parseCanonicalEnvironmentProfile(value);
  return Boolean(profile && !profile.constraints.some((constraint) => constraint.endsWith("/unknown")));
}
