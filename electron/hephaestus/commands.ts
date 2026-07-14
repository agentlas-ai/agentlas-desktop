// Hephaestus 고수준 명령 래퍼.
//
// 데스크탑 기능 ↔ 엔진 서브커맨드 매핑을 한 곳에 모은다. bin/hephaestus(bash)의 디스패치를
// 그대로 따른다(프로그래matic JSON 명령만 사용; hep-build 같은 LLM-라우팅 텍스트 surface 는
// 데스크탑 런타임 + 빌더 에이전트 프롬프트로 별도 구동한다 — builder.ts 참조).
import { runHephaestus, type HephaestusResult, type HephaestusRunOptions } from "./engine";
import { currentUiLocale } from "../ui-locale";
import { createHash } from "node:crypto";

export type UploadVisibility = "private-link" | "marketplace";

type PositionalKind = "query" | "folder" | "shortcut" | "slug" | "agent" | "context" | "directory";

const POSITIONAL_LABEL: Record<PositionalKind, { ko: string; en: string }> = {
  query: { ko: "쿼리", en: "query" },
  folder: { ko: "폴더", en: "folder" },
  shortcut: { ko: "숏컷", en: "shortcut" },
  slug: { ko: "슬러그", en: "slug" },
  agent: { ko: "에이전트", en: "agent" },
  context: { ko: "컨텍스트", en: "context" },
  directory: { ko: "디렉터리", en: "directory" },
};

export interface CoreStormbreakerHarness {
  schema_version: "agentlas.stormbreaker.goal-ultracode-harness.v1";
  harness_id: "agentlas-core/stormbreaker-goal-ultracode";
  owner: string;
  mode: "stormbreaker-goal-ultracode";
  system_prompt: string;
  prompt_sha256: string;
  host_rule: string;
  inventory_rule: string;
  completion_rule: string;
}

function validateCoreStormbreakerHarness(value: unknown): CoreStormbreakerHarness {
  const harness = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (
    !harness ||
    harness.schema_version !== "agentlas.stormbreaker.goal-ultracode-harness.v1" ||
    harness.harness_id !== "agentlas-core/stormbreaker-goal-ultracode" ||
    harness.mode !== "stormbreaker-goal-ultracode" ||
    typeof harness.system_prompt !== "string" ||
    !harness.system_prompt.trim() ||
    typeof harness.prompt_sha256 !== "string"
  ) {
    throw new Error("Installed Agentlas Core returned an invalid Stormbreaker harness contract.");
  }
  const digest = createHash("sha256").update(harness.system_prompt, "utf8").digest("hex");
  if (digest !== harness.prompt_sha256) {
    throw new Error("Installed Agentlas Core Stormbreaker harness failed its SHA-256 integrity check.");
  }
  if (
    harness.system_prompt.split("GOAL MODE:").length - 1 !== 1 ||
    harness.system_prompt.split("ULTRACODE MODE:").length - 1 !== 1
  ) {
    throw new Error("Installed Agentlas Core harness must contain exactly one Goal mode and one UltraCode mode.");
  }
  return harness as unknown as CoreStormbreakerHarness;
}

/** Load the one canonical Goal + UltraCode prompt from the installed Agentlas Core. */
export async function stormbreakerHarness(
  opts: HephaestusRunOptions = {},
): Promise<CoreStormbreakerHarness> {
  const result = await runHephaestus("agentlas_cloud", ["stormbreaker", "harness"], {
    timeoutMs: 30_000,
    ...opts,
  });
  if (!result.ok || !result.json) {
    throw new Error(
      result.error || result.stderr.trim() || "Installed Agentlas Core Stormbreaker harness is unavailable.",
    );
  }
  return validateCoreStormbreakerHarness(result.json);
}

/** 엔진 argparse 가 '-' 로 시작하는 위치 인자를 플래그로 오해석하는 것을 막는다(인자 인젝션 방어).
 *  cross-spawn 은 shell 을 안 쓰므로 OS 메타문자 인젝션은 불가하나, 엔진 CLI 플래그 변조는 가능하다. */
function assertPositional(value: string, kind: PositionalKind, index?: number): string {
  const v = String(value ?? "");
  if (v.startsWith("-")) {
    const ko = currentUiLocale() === "ko";
    const label = POSITIONAL_LABEL[kind][ko ? "ko" : "en"] + (index != null ? `[${index}]` : "");
    throw new Error(
      ko ? `잘못된 ${label}: '-' 로 시작할 수 없습니다.` : `Invalid ${label}: cannot start with '-'.`,
    );
  }
  return v;
}

/**
 * Stormbreaker 실행: 쿼리를 라우팅하고 가능한 pipeline execution_fabric 을 견고-실행한다.
 * bin/hephaestus 의 `route <q> --auto-run` 경로(= run_stormbreaker_query)와 동일.
 */
export function stormbreakerRun(
  query: string,
  opts: {
    project?: string;
    runtime?: string;
    background?: boolean;
    researchEvidence?: boolean;
    allowLocal?: boolean;
  } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["route", assertPositional(query, "query"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal", "--auto-run"];
  if (opts.background) args.push("--background");
  if (opts.researchEvidence) args.push("--research-evidence");
  if (opts.allowLocal) args.push("--allow-local-routing");
  return runHephaestus("agentlas_cloud", args, opts);
}

/**
 * 순수 라우팅(실행 없음) — 어떤 에이전트/파이프라인이 선택되는지만 확인.
 * Stormbreaker 슈퍼바이저가 invoke 전 "scope/route" 미리보기를 띄울 때 사용.
 */
export function routeOnly(
  query: string,
  opts: {
    project?: string;
    runtime?: string;
    hubOnly?: boolean;
    noHub?: boolean;
    scope?: "network" | "cloud";
    allowLocal?: boolean;
  } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["route", assertPositional(query, "query"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal"];
  if (opts.hubOnly) args.push("--hub-only");
  if (opts.noHub) args.push("--no-hub"); // 오프라인-안전: Hub 네트워크 호출 생략(로컬 라우팅만)
  if (opts.scope) args.push("--scope", opts.scope);
  if (opts.allowLocal) args.push("--allow-local-routing");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 120_000, ...opts });
}

/** Stormbreaker 런 저널 검사: status|verify|repair|gate. 재개/감사에 사용. */
export function stormbreakerJournal(
  action: "status" | "verify" | "repair" | "gate",
  opts: { runId?: string; project?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["stormbreaker", "journal", action, "--project", opts.project ?? "."];
  if (opts.runId) args.push("--run-id", opts.runId);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 60_000, ...opts });
}

/** hep-search: Cloud + Hub 후보를 보여줌(실행 없음). 마켓플레이스/허브 검색에 사용. */
export function hepSearch(
  query: string,
  opts: { limit?: number; project?: string; runtime?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["search", assertPositional(query, "query"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal"];
  if (opts.limit) args.push("--limit", String(opts.limit));
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 120_000, ...opts });
}

/** hep-call: 명시적으로 지정된 Hub/cloud 에이전트를 준비. */
export function hepCall(
  agents: string,
  context: string[],
  opts: { project?: string; runtime?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = [
    "call",
    assertPositional(agents, "agent"),
    ...context.map((c, i) => assertPositional(c, "context", i)),
    "--project",
    opts.project ?? ".",
    "--runtime",
    opts.runtime ?? "terminal",
  ];
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** hep-cloud: 소유자 본인 Cloud 패키지(보관함)만 라우팅. */
export function hepCloud(query: string, opts: { project?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["route", assertPositional(query, "query"), "--project", opts.project ?? ".", "--scope", "cloud"], {
    timeoutMs: 180_000,
    ...opts,
  });
}

/**
 * hep-network: Hub GUI 숏컷(studio 등) 시도 → 실패 시 Hub 라우팅 자동실행.
 * bin/hephaestus 의 hep-network 분기를 그대로 재현한다.
 */
export async function hepNetwork(
  query: string,
  opts: { project?: string; autoRun?: boolean; detach?: boolean; noOpen?: boolean } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  // 1) GUI 숏컷 먼저 시도(예: "창업 스튜디오" → agentlas-startup-founder-studio)
  const gui = await localGui(query, { detach: opts.detach ?? true, noOpen: opts.noOpen, ...opts });
  // exit 4 == 숏컷 없음 → 라우팅 폴백. 그 외 성공/실패는 그대로 반환.
  if (gui.exitCode !== 4 && (gui.ok || gui.exitCode !== null)) {
    if (gui.ok || gui.json) return gui;
  }
  const args = ["route", assertPositional(query, "query"), "--project", opts.project ?? ".", "--hub-only", "--scope", "network"];
  if (opts.autoRun ?? true) args.push("--auto-run", "--background");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** local-gui: 패키지된 GUI 숏컷(스튜디오 등) 복원/실행. studio 메뉴 연결에 사용. */
export function localGui(
  shortcut: string,
  opts: { detach?: boolean; noOpen?: boolean } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["local-gui", assertPositional(shortcut, "shortcut")];
  if (opts.detach) args.push("--detach");
  if (opts.noOpen) args.push("--no-open");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 120_000, ...opts });
}

/** publish: 검토된 에이전트 폴더를 Cloud(private-link) 또는 Hub(marketplace)에 등록. */
export function hepPublish(
  folder: string,
  visibility: UploadVisibility,
  opts: { dryRun?: boolean; noOpen?: boolean; slug?: string; baseUrl?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["publish", assertPositional(folder, "folder"), "--visibility", visibility];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.noOpen) args.push("--no-open");
  if (opts.slug) args.push("--slug", assertPositional(opts.slug, "slug"));
  if (opts.baseUrl) args.push("--base-url", opts.baseUrl);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 300_000, ...opts });
}

/** package: 업로드 전 패키징 + 정적 검토(리뷰 리포트 JSON). */
export function hepPackage(
  folder: string,
  opts: { visibility?: UploadVisibility } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["package", assertPositional(folder, "folder")];
  if (opts.visibility) args.push("--visibility", opts.visibility);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** security scan: 정적 보안 규칙(+ 선택적 LLM 판단). 업로드/빌드 게이트. */
export function securityScan(
  folder: string,
  opts: { strict?: boolean } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["security", "scan", assertPositional(folder, "folder")];
  if (opts.strict) args.push("--strict");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** wizard: 폴더에 agentlas.json 매니페스트 생성/복구. */
export function hepWizard(
  folder: string,
  opts: { name?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["wizard", assertPositional(folder, "folder")];
  if (opts.name) args.push("--name", opts.name);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 120_000, ...opts });
}

/** AO 그래프 요약(정보 흐름 맵의 upstream/downstream 백킹 데이터). */
export function aoGraph(opts: { agent?: string; dir?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  const args = ["ao", "graph"];
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.dir) args.push(assertPositional(opts.dir, "directory"));
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 60_000, ...opts });
}

/** AO 쿼리(에이전트 간 produces/consumes 관계 조회). */
export function aoQuery(query: string, opts: { dir?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  const args = ["ao", "query", assertPositional(query, "query")];
  if (opts.dir) args.push(assertPositional(opts.dir, "directory"));
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 60_000, ...opts });
}

/** Career Graph: rebuildable source-routing index over project memory, sitemap, code map, and ledgers. */
export function careerGraph(
  args: string[],
  opts: { project?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const finalArgs = [...args];
  if (opts.project) finalArgs.push("--project", assertPositional(opts.project, "directory"));
  return runHephaestus("career_graph", finalArgs, { timeoutMs: 60_000, cwd: opts.project ?? opts.cwd, ...opts });
}

export function careerGraphIngest(project: string, opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return careerGraph(["ingest"], { project, timeoutMs: 20_000, ...opts });
}

/** 네트워크 상태(카드 수, 벤치 상태, 자동라우팅 게이트). */
export function networkStatus(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["network", "status"], { timeoutMs: 60_000, ...opts });
}

/** 네트워크 구조 생성/마이그레이션(idempotent). 최초 1회 부트스트랩. */
export function networkInit(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["network", "init"], { timeoutMs: 60_000, ...opts });
}
