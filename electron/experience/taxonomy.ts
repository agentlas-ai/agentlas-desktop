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

/**
 * Exact structure only: a value that IS a canonical task id, or a typed task-class
 * field whose whole value is a catalog slug (e.g. `taskClass: "coding"`). The host
 * never infers a task class from the words of a request.
 */
function exactCanonicalTaskIds(values: ReadonlyArray<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const token = value.normalize("NFKC").trim().toLowerCase();
    if (TASK_SLUG_SET.has(token)) found.add(canonicalTaskId(token as ExperienceTaskSlug));
  }
  return EXPERIENCE_TASK_SLUGS.map(canonicalTaskId).filter((id) => found.has(id));
}

function exactTaskIds(text: string, values: ReadonlyArray<string | null | undefined>): string[] {
  const found = new Set([...explicitDeclaredTaskIds(text), ...exactCanonicalTaskIds(values)]);
  return EXPERIENCE_TASK_SLUGS.map(canonicalTaskId).filter((id) => found.has(id));
}

/**
 * The resident judge decides which kinds of work the text genuinely involves
 * (resolveCanonicalTaskIds warms the subset cache this peeks). Explicit
 * `agentlas.task.v1/*` ids and exact slug-valued fields are closed-form and win
 * outright. A cache miss, a failed judge, or no connected model is UNKNOWN ([]):
 * there is no wordlist/regex fallback, so no experience prior/overlay is applied.
 */
export function classifyCanonicalTaskIds(...values: Array<string | null | undefined>): string[] {
  const text = taskClassJudgmentInput(...values);
  const exact = exactTaskIds(text, values);
  if (exact.length > 0) return exact;
  const peeked = peekSubsetJudgment<ExperienceTaskSlug>(EXPERIENCE_TASK_JUDGMENT_KIND, EXPERIENCE_TASK_SLUGS, text);
  if (peeked && peeked.source === "llm") {
    const selected = new Set(peeked.selected);
    return EXPERIENCE_TASK_SLUGS.filter((slug) => selected.has(slug)).map(canonicalTaskId);
  }
  return [];
}

export interface ResolvedCanonicalTaskIds {
  taskIds: string[];
  /** "llm" = the model decided; "fallback" = unknown (empty) unless exact ids were declared. */
  source: "llm" | "fallback";
  reason: string;
}

/**
 * Async resolver: judge the canonical task classes by meaning (kind
 * "experience-task-class", labels = canonical slugs, no word hints), warming
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
  const declared = exactTaskIds(text, values);
  if (declared.length > 0) {
    // Declared canonical ids are closed-form and win outright (never judged).
    return { taskIds: declared, source: "fallback", reason: "explicit canonical ids declared" };
  }
  if (!text.trim()) return { taskIds: [], source: "fallback", reason: "empty text" };
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
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  } catch {
    // No verdict: UNKNOWN, never a wordlist guess.
    return { taskIds: [], source: "fallback", reason: "judge failed" };
  }
  if (verdict.source !== "llm") {
    return { taskIds: [], source: "fallback", reason: verdict.reason };
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
    // Sync sites stay UNKNOWN.
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
