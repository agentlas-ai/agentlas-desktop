import type { CanonicalExperienceEnvironmentProfile } from "../../shared/experience";

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
  { slug: "coding", pattern: /\bcode|coding|implement|refactor|typescript|javascript|python|swift|kotlin\b|코드|구현|리팩터|개발/iu },
  { slug: "research", pattern: /\bresearch|investigate|study|evidence|source\b|리서치|연구|조사|근거|출처/iu },
  {
    slug: "writing",
    pattern: /\b(?:writing|copywriting|article|essay|rewrite|write (?:an? )?(?:article|copy|blog|essay|text|content))\b|글쓰기|글 작성|카피 작성|원고 작성|문구|카피|기사|에세이/iu,
  },
  { slug: "design", pattern: /\bdesign|ui|ux|layout|wireframe\b|디자인|화면|레이아웃|와이어프레임/iu },
  { slug: "image-generation", pattern: /\bimage|photo|illustration|poster|thumbnail\b|이미지|사진|일러스트|포스터|썸네일/iu },
  { slug: "video-production", pattern: /\bvideo|film|cinematic|subtitle|shot\b|영상|비디오|영화|자막|촬영/iu },
  { slug: "presentation", pattern: /\bpresentation|slides?|pptx|deck\b|발표|프레젠테이션|슬라이드|피피티/iu },
  { slug: "document", pattern: /\bdocument|docx|pdf|contract draft\b|문서|워드|계약서|보고서/iu },
  { slug: "data-analysis", pattern: /\bdata|analysis|analytics|metric|sql|spreadsheet|excel\b|데이터|분석|지표|엑셀|스프레드시트/iu },
  { slug: "browser-automation", pattern: /\bbrowser|playwright|selenium|navigate|click\b|브라우저|클릭|웹 자동화/iu },
  { slug: "social-publishing", pattern: /\binstagram|tiktok|threads|linkedin|social publish\b|인스타|틱톡|스레드|소셜 발행|게시/iu },
  { slug: "marketing", pattern: /\bmarketing|campaign|seo|growth|brand\b|마케팅|캠페인|성장|브랜드/iu },
  { slug: "sales", pattern: /\bsales|lead|prospect|crm|pipeline\b|영업|리드|잠재고객/iu },
  { slug: "customer-support", pattern: /\bcustomer support|support ticket|helpdesk|cs\b|고객지원|고객 성공|문의 대응/iu },
  { slug: "ecommerce", pattern: /\becommerce|commerce|shop|store|product listing\b|이커머스|커머스|쇼핑몰|상품 등록/iu },
  { slug: "legal-review", pattern: /\blegal|law|litigation|compliance|contract review\b|법률|소송|준법|계약 검토/iu },
  { slug: "finance", pattern: /\bfinance|financial|stock|investment|trading|accounting\b|금융|재무|주식|투자|회계/iu },
  { slug: "project-planning", pattern: /\bproject plan|roadmap|milestone|specification|prd\b|기획|로드맵|마일스톤|요구사항/iu },
  { slug: "agent-building", pattern: /\bagent build|build agent|agent architecture|multi-agent\b|에이전트 빌드|에이전트 설계|멀티에이전트/iu },
  {
    slug: "workflow-automation",
    pattern: /\b(?:workflow automation|automate workflow|automation workflow|schedule|cron|pipeline)\b|워크플로 자동화|업무 자동화|스케줄|파이프라인/iu,
  },
  { slug: "file-operations", pattern: /\bfile|folder|directory|rename|move|copy files?\b|파일|폴더|디렉터리|이름 변경|이동/iu },
  { slug: "translation", pattern: /\btranslate|translation|localize|localization\b|번역|현지화/iu },
];

export function canonicalTaskId(slug: ExperienceTaskSlug): string {
  return `${EXPERIENCE_TASK_PREFIX}${slug}`;
}

export function isCanonicalTaskId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(EXPERIENCE_TASK_PREFIX)) return false;
  return TASK_SLUG_SET.has(value.slice(EXPERIENCE_TASK_PREFIX.length));
}

export function classifyCanonicalTaskIds(...values: Array<string | null | undefined>): string[] {
  const text = values.filter((value): value is string => typeof value === "string")
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
  const explicit = text.match(/agentlas\.task\.v1\/[a-z0-9-]+/g) ?? [];
  const found = new Set(explicit.filter(isCanonicalTaskId));
  for (const rule of TASK_RULES) {
    if (rule.pattern.test(text)) found.add(canonicalTaskId(rule.slug));
  }
  return EXPERIENCE_TASK_SLUGS.map(canonicalTaskId).filter((id) => found.has(id));
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
