/**
 * 런타임 연결 팝업 계약 — main(runtime-connect.ts)과 renderer 가 같은 모양을 본다.
 * 초록불(설치됨·연결됨)은 probe.state === "signed-in" 일 때만. 그 밖의 모든 상태는 할 일을 말한다.
 */
export type ConnectableRuntime = "codex" | "claude-code" | "antigravity" | "grok" | "kimi" | "cursor";

export const CONNECTABLE_RUNTIMES: readonly ConnectableRuntime[] = ["codex", "claude-code", "antigravity", "grok", "kimi", "cursor"];

/** Ollama defaults a missing tag to `latest`. Compare inventory names without
 * rewriting the selected model sent to the server. */
export function ollamaModelNamesEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  // Do not equate digest or URL-like references with a different name.
  if ([left, right].some(name => /[@?#\s]/.test(name) || name.includes("://")
    || name.endsWith(":") || name.endsWith("/"))) return false;
  const withDefaultTag = (name: string): string =>
    name.lastIndexOf(":") > name.lastIndexOf("/") ? name : `${name}:latest`;
  return withDefaultTag(left) === withDefaultTag(right);
}

export function ollamaModelListIncludes(models: readonly string[], requested: string): boolean {
  return models.some(model => ollamaModelNamesEqual(requested, model));
}

/**
 * 온보딩의 "로컬 모델" 칸이 세는 런타임 — 칸과 첫 역할 배정(first-run-roles)이 같은 목록을 읽는다.
 * detect.ts 가 로컬 런타임으로 내는 네 종류 전부다. ollama 는 1.3.43(2026-10-15)부터 실제로 감지·실행되는
 * 런타임인데 이 목록에는 옛 "이관용 투영" 시절 규칙대로 빠져 있어서, Windows 실측(1.3.88, 2026-10-23)에서
 * Ollama 가 돌고 실행도 되는데 이 칸은 "모델 없음"이었다.
 */
export const FIRST_RUN_LOCAL_MODEL_KINDS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "mlx", "agentlas-local"]);

/** 이 감지 행이 온보딩 "로컬 모델" 칸을 켜는가: 로컬 종류 + 확인이 끝났고(pending 아님) 고를 모델이 있다. 칸·다시 확인·첫 역할이 같이 읽는다. */
export function firstRunLocalModelReady(row: {
  kind: string;
  model?: string | null;
  availableModels?: readonly string[];
  localObservation?: { state?: string } | null;
}): boolean {
  return FIRST_RUN_LOCAL_MODEL_KINDS.has(row.kind)
    && row.localObservation?.state !== "pending"
    && Boolean(row.model || (row.availableModels?.length ?? 0) > 0);
}

/** 온보딩의 Agentlas 칸이 "사용 가능"을 켜는 조건(유료 플랜 + 남은 크레딧). 칸과 첫 역할 배정이 같이 읽는다. */
export function agentlasServingReady(credits: { authenticated: boolean; plan?: string; remainingCredits?: number } | null | undefined): boolean {
  const plan = credits?.authenticated && credits.plan && credits.plan.toLowerCase() !== "free" ? credits.plan : null;
  return Boolean(plan && (credits?.remainingCredits ?? 0) > 0);
}

export type RuntimeAuthState = "signed-in" | "signed-out" | "not-installed" | "unknown";

export interface RuntimeAuthProbe {
  kind: ConnectableRuntime;
  state: RuntimeAuthState;
  /** 가린 계정(예: co***@e***.com). 런타임이 알려주지 않으면 null. */
  account: string | null;
  /** 로그인 방식·요금제(예: "ChatGPT", "max", "grok.com"). */
  method: string | null;
  latencyMs: number | null;
  checkedAt: string;
  /** 실제로 돌린 명령과 결과(예: "codex login status → exit 0"). */
  evidence: string;
  /** Machine reason for an inconclusive or unavailable measurement; never provider prose. */
  reason?: "not-installed" | "probe-unavailable" | "timeout" | "aborted" | "spawn-failed" | "unrecognized";
}

export type RuntimeConnectStep = "checking" | "installing" | "login" | "verifying" | "done";
export type RuntimeConnectPhase = "running" | "done" | "failed" | "cancelled";
export type RuntimeConnectReasonCode =
  | "install_network"
  | "install_failed"
  | "install_timeout"
  | "install_verify_failed"
  | "install_cancelled"
  | "install_manual_only"
  | "login_spawn_failed"
  | "login_exited"
  | "login_timeout"
  | "probe_failed"
  | "probe_unavailable"
  | "cancelled";

export interface RuntimeConnectSnapshot {
  kind: ConnectableRuntime;
  sessionId: string;
  step: RuntimeConnectStep;
  phase: RuntimeConnectPhase;
  startedAt: string;
  endedAt: string | null;
  /** 가린 로그 꼬리(최근 40줄). */
  log: string[];
  reasonCode: RuntimeConnectReasonCode | null;
  message: string | null;
  /** CLI 가 찍은 공식 로그인 주소(브라우저가 안 열렸을 때 다시 열기용). */
  loginUrl: string | null;
  probe: RuntimeAuthProbe | null;
  /** 설치 도중 취소 — 다음 연결이 처음부터 다시 설치한다는 사실을 화면이 말한다. */
  partialInstall: boolean;
  /** 우리가 설치하지 않는 런타임의 공식 설치 명령/주소. */
  manualInstall: string | null;
}

/** contact@example.com → co***@e***.com. 이메일이 아니면 앞 2글자만 남긴다. */
export function maskAccount(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const at = raw.indexOf("@");
  if (at <= 0) return raw.length <= 2 ? `${raw[0]}*` : `${raw.slice(0, 2)}***`;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, Math.min(2, local.length))}***@${host.slice(0, 1)}***${tld}`;
}
