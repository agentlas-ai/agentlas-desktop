// Hephaestus 고수준 명령 래퍼.
//
// 데스크탑 기능 ↔ 엔진 서브커맨드 매핑을 한 곳에 모은다. bin/hephaestus(bash)의 디스패치를
// 그대로 따른다(프로그래matic JSON 명령만 사용; hep-build 같은 LLM-라우팅 텍스트 surface 는
// 데스크탑 런타임 + 빌더 에이전트 프롬프트로 별도 구동한다 — builder.ts 참조).
import { runHephaestus, type HephaestusResult, type HephaestusRunOptions } from "./engine";

export type UploadVisibility = "private-link" | "marketplace";

/** 엔진 argparse 가 '-' 로 시작하는 위치 인자를 플래그로 오해석하는 것을 막는다(인자 인젝션 방어).
 *  cross-spawn 은 shell 을 안 쓰므로 OS 메타문자 인젝션은 불가하나, 엔진 CLI 플래그 변조는 가능하다. */
function assertPositional(value: string, label: string): string {
  const v = String(value ?? "");
  if (v.startsWith("-")) {
    throw new Error(`잘못된 ${label}: '-' 로 시작할 수 없습니다.`);
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
  const args = ["route", assertPositional(query, "쿼리"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal", "--auto-run"];
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
  const args = ["route", assertPositional(query, "쿼리"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal"];
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
  const args = ["search", assertPositional(query, "쿼리"), "--project", opts.project ?? ".", "--runtime", opts.runtime ?? "terminal"];
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
    assertPositional(agents, "에이전트"),
    ...context.map((c, i) => assertPositional(c, `컨텍스트[${i}]`)),
    "--project",
    opts.project ?? ".",
    "--runtime",
    opts.runtime ?? "terminal",
  ];
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** hep-cloud: 소유자 본인 Cloud 패키지(보관함)만 라우팅. */
export function hepCloud(query: string, opts: { project?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["route", assertPositional(query, "쿼리"), "--project", opts.project ?? ".", "--scope", "cloud"], {
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
  const args = ["route", assertPositional(query, "쿼리"), "--project", opts.project ?? ".", "--hub-only", "--scope", "network"];
  if (opts.autoRun ?? true) args.push("--auto-run", "--background");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** local-gui: 패키지된 GUI 숏컷(스튜디오 등) 복원/실행. studio 메뉴 연결에 사용. */
export function localGui(
  shortcut: string,
  opts: { detach?: boolean; noOpen?: boolean } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["local-gui", assertPositional(shortcut, "숏컷")];
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
  const args = ["publish", assertPositional(folder, "폴더"), "--visibility", visibility];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.noOpen) args.push("--no-open");
  if (opts.slug) args.push("--slug", assertPositional(opts.slug, "슬러그"));
  if (opts.baseUrl) args.push("--base-url", opts.baseUrl);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 300_000, ...opts });
}

/** package: 업로드 전 패키징 + 정적 검토(리뷰 리포트 JSON). */
export function hepPackage(
  folder: string,
  opts: { visibility?: UploadVisibility } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["package", assertPositional(folder, "폴더")];
  if (opts.visibility) args.push("--visibility", opts.visibility);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** security scan: 정적 보안 규칙(+ 선택적 LLM 판단). 업로드/빌드 게이트. */
export function securityScan(
  folder: string,
  opts: { strict?: boolean } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["security", "scan", assertPositional(folder, "폴더")];
  if (opts.strict) args.push("--strict");
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 180_000, ...opts });
}

/** wizard: 폴더에 agentlas.json 매니페스트 생성/복구. */
export function hepWizard(
  folder: string,
  opts: { name?: string } & HephaestusRunOptions = {},
): Promise<HephaestusResult> {
  const args = ["wizard", assertPositional(folder, "폴더")];
  if (opts.name) args.push("--name", opts.name);
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 120_000, ...opts });
}

/** AO 그래프 요약(정보 흐름 맵의 upstream/downstream 백킹 데이터). */
export function aoGraph(opts: { agent?: string; dir?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  const args = ["ao", "graph"];
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.dir) args.push(assertPositional(opts.dir, "디렉터리"));
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 60_000, ...opts });
}

/** AO 쿼리(에이전트 간 produces/consumes 관계 조회). */
export function aoQuery(query: string, opts: { dir?: string } & HephaestusRunOptions = {}): Promise<HephaestusResult> {
  const args = ["ao", "query", assertPositional(query, "쿼리")];
  if (opts.dir) args.push(assertPositional(opts.dir, "디렉터리"));
  return runHephaestus("agentlas_cloud", args, { timeoutMs: 60_000, ...opts });
}

/** 네트워크 상태(카드 수, 벤치 상태, 자동라우팅 게이트). */
export function networkStatus(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["network", "status"], { timeoutMs: 60_000, ...opts });
}

/** 네트워크 구조 생성/마이그레이션(idempotent). 최초 1회 부트스트랩. */
export function networkInit(opts: HephaestusRunOptions = {}): Promise<HephaestusResult> {
  return runHephaestus("agentlas_cloud", ["network", "init"], { timeoutMs: 60_000, ...opts });
}
