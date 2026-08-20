/**
 * 도구 승인 계약 — 런타임이 제각각 말하는 "승인"을 한 모양으로 모은다.
 *
 * 전수 조사(2026-08-15)에서 나온 사실은 승인이 **두 종류**라는 것이다. 이 구분을
 * 지우고 하나로 만들면 "허용을 눌렀는데 아무 일도 일어나지 않는" UI가 나온다.
 *
 *  - live: 런타임이 **실행 전에** 물어보고 답을 기다린다. 사용자의 선택이 그대로
 *    이번 호출의 결과가 된다. (acp `session/request_permission`, 그리고 우리 코드가
 *    도구를 직접 도는 local-tool-loop 계열 — 둘 다 아래 중재자 등록소를 지난다)
 *
 * ★이 문서가 한동안 거짓이었다: local-tool-loop 은 여기 이름만 올라 있었을 뿐
 *   `runOneToolCall`이 승인을 한 번도 부르지 않았다(ollama/lmstudio/mlx 는 MCP 도구를
 *   무조건 실행했다). 그래서 중재자 등록소를 이 파일로 옮겨 **두 경로가 같은 한 벌**을
 *   쓰게 했다. 주석이 말한 관문이 실제로 걸려 있어야 이 문장이 사실이다.
 *
 *  - post-denial: 헤드리스라 물어볼 상대가 없어 런타임이 **이미 거부하고 지나갔다.**
 *    이번 호출은 되돌릴 수 없다. 사용자가 할 수 있는 건 다음 실행을 위해 허용 범위를
 *    넓히는 것뿐이다. (claude-code tool_result, antigravity tool 스텝 ERROR)
 *
 * 그리고 둘 다 공통으로 겪는 문제가 있다: 런타임이 그 거부를 **"사용자가 거절했다"**로
 * 기록한다(agy `User denied permission for …`, claude `user-rejected`). 사용자는 손도
 * 대지 않았다. 그래서 이 계약은 `deniedBy`를 명시적으로 들고 다닌다 — 화면이든 원장이든
 * 사람이 거절한 것과 런타임이 자동 거부한 것을 절대 같은 말로 적지 않게 하기 위해서다.
 */

import type { ToolApprovalRequestEvent, ToolApprovalDecision } from "../../shared/types";
import {
  builtinToolByName,
  runBuiltinTool,
  type ToolPermission,
} from "../../shared/builtin-tools";
import { askUser } from "../confirm/ask-user";

/** 승인 요청 하나 — 화면과 같은 정의를 쓴다(shared/types.ts). */
export type ToolApprovalRequest = ToolApprovalRequestEvent;

/*
 * ── 실행 전 중재자 등록소 ────────────────────────────────────────────────────
 *
 * 정책(무엇을 묻고 무엇을 바로 허용/거부할지)은 electron/ipc.ts 한 곳에서 정하고,
 * 그 한 벌을 **실행 전에 물을 수 있는 모든 경로**가 공유한다:
 *   · ACP `session/request_permission` (electron/runtime/acp.ts)
 *   · 우리 in-process 도구 루프 (electron/runtime/local-tool-loop.ts)
 *
 * 등록소를 이 파일에 두는 이유: 경로마다 자기 등록소를 들면 정책이 갈라지고,
 * 갈라진 쪽은 반드시 "묻지 않고 실행"으로 기운다. 이 파일은 shared/types 외에는
 * 아무것도 import 하지 않아서, 러너들이 Electron 없이도 그대로 테스트된다.
 */
export interface RuntimeToolPermissionAsk {
  runtime: string;
  sessionKey: string;
  tool: string;
  /** ACP 도구 종류(read/edit/execute/…). 알 수 없으면 "other". */
  kind: string;
  detail?: string;
  cwd?: string;
  /** 이번 실행의 권한(러너 계약과 같은 값). undefined 는 read 와 같게 취급한다. */
  permission: "read" | "write" | "full" | undefined;
  mutating: boolean;
  /** 이 실행이 붙어 있는 대화 — 승인 카드는 그 대화 안에서만 뜬다(오너 결정 2026-08-15). */
  chatId?: string;
  /** 실행 중인 에이전트 — 에이전트 스코프 능력 규칙(capability_grants)의 대상. */
  agentId?: string;
  /** 자동화·그래프처럼 답할 사람이 없는 실행 — 묻지 않고 즉시 거부한다. */
  unattended?: boolean;
}

/**
 * 능력 클래스 — "항상 허용"이 영구 부여하는 단위(오너 결정 2026-08-20).
 * ACP 도구 kind 와 내장 도구 성격에서 도출한다. 모르면 other.
 */
export function capabilityClassFor(kind: string, tool: string): string {
  if (kind === "execute" || tool === "bash") return "execute";
  if (kind === "delete") return "delete";
  if (kind === "edit") return "edit";
  if (kind === "fetch" || kind === "network") return "network";
  return "other";
}

/**
 * "항상 허용"이 저장할 인자 패턴 — Claude Code 의 프리픽스 규칙과 같은 일반화.
 * 명령줄(detail)이 있으면 앞 두 토큰 + " *" ("git push *"), 없으면 도구 전체(null).
 */
export function generalizeDetailPattern(detail: string | undefined): string | null {
  if (!detail) return null;
  const tokens = detail.trim().split(/\s+/);
  if (tokens.length <= 2) return detail.trim();
  return `${tokens[0]} ${tokens[1]} *`;
}

export type RuntimeToolPermissionDecision = "allow_once" | "allow_session" | "deny";
export type RuntimeToolPermissionArbiter = (
  ask: RuntimeToolPermissionAsk,
) => Promise<RuntimeToolPermissionDecision>;

let runtimeToolPermissionArbiter: RuntimeToolPermissionArbiter | null = null;

export function setRuntimeToolPermissionArbiter(arbiter: RuntimeToolPermissionArbiter | null): void {
  runtimeToolPermissionArbiter = arbiter;
}

/*
 * ── "항상 허용" 영속 훅 ──────────────────────────────────────────────────
 * 이 파일은 Electron/store 를 import 하지 않는다(러너 단독 테스트 계약). 그래서
 * allow_always 의 영구 기록은 ipc.ts 가 주입한 persister 가 맡는다. persister 가
 * 없으면 allow_always 는 allow_session 과 같게 동작한다 — 조용히 넓어지지 않는다.
 */
export interface AlwaysAllowGrant {
  capability: string;
  pattern: string | null;
  scope: string;
  tool: string;
}
export type CapabilityGrantPersister = (grant: AlwaysAllowGrant) => void;

let capabilityGrantPersister: CapabilityGrantPersister | null = null;

export function setCapabilityGrantPersister(persister: CapabilityGrantPersister | null): void {
  capabilityGrantPersister = persister;
}

function persistAlwaysGrant(request: ToolApprovalRequest): void {
  if (!capabilityGrantPersister) return;
  try {
    capabilityGrantPersister({
      capability: `tool:${request.tool}`,
      pattern: generalizeDetailPattern(request.detail),
      // 규칙은 에이전트들이 공유한다(비전 + Claude Code parity). 에이전트 한정이
      // 필요해지면 request.agentId 로 scope 를 좁히는 선택지를 카드에 더한다.
      scope: "global",
      tool: request.tool,
    });
  } catch {
    /* 영속 실패가 이번 호출의 허용을 깨지는 않는다 — 다음에 다시 묻게 될 뿐이다. */
  }
}

export function getRuntimeToolPermissionArbiter(): RuntimeToolPermissionArbiter | null {
  return runtimeToolPermissionArbiter;
}

/**
 * 중재자가 없을 때의 보수적 기본값 — ACP 경로가 오래 써 온 규칙과 **같은** 문장이다.
 * read 실행에서 바깥을 바꾸는 호출은 거부하고, 나머지는 허용한다. 중재자가 던지면
 * 이 함수를 부르지 말고 곧장 deny 다(실패가 허용으로 바뀌면 안 된다).
 */
export function defaultRuntimeToolPermission(
  ask: Pick<RuntimeToolPermissionAsk, "permission" | "mutating">,
): RuntimeToolPermissionDecision {
  const readOnly = ask.permission === "read" || ask.permission === undefined;
  return readOnly && ask.mutating ? "deny" : "allow_once";
}

export type { ToolApprovalDecision };

export interface ToolApprovalOutcome {
  decision: ToolApprovalDecision;
  decidedAt: string;
}

type Pending = {
  request: ToolApprovalRequest;
  resolve: (outcome: ToolApprovalOutcome) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();
const sessionGrants = new Map<string, Set<string>>();
const listeners = new Set<(request: ToolApprovalRequest) => void>();
const resolvedListeners = new Set<(id: string, outcome: ToolApprovalOutcome) => void>();

/** 같은 도구·대상을 한 세션에서 다시 묻지 않기 위한 키. */
function grantKey(request: Pick<ToolApprovalRequest, "tool" | "detail">): string {
  return request.detail ? `${request.tool}::${request.detail}` : request.tool;
}

export function onToolApprovalRequested(fn: (request: ToolApprovalRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onToolApprovalResolved(fn: (id: string, outcome: ToolApprovalOutcome) => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

export function listPendingToolApprovals(): ToolApprovalRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}

/** 세션 단위 허용이 이미 있는가. live 요청은 이걸 먼저 본다. */
export function hasSessionGrant(sessionKey: string, request: Pick<ToolApprovalRequest, "tool" | "detail">): boolean {
  return sessionGrants.get(sessionKey)?.has(grantKey(request)) === true;
}

function rememberSessionGrant(sessionKey: string, request: ToolApprovalRequest): void {
  const set = sessionGrants.get(sessionKey) ?? new Set<string>();
  set.add(grantKey(request));
  sessionGrants.set(sessionKey, set);
}

export function clearSessionGrants(sessionKey: string): void {
  sessionGrants.delete(sessionKey);
}

/**
 * live 승인 요청 — 사용자의 답을 실제로 기다린다.
 *
 * 아무도 답하지 않으면 `deny`로 닫는다. **열어둔 채 실행을 매달아 두지 않는다** —
 * 이 제품에서 "끝나지 않는 실행"은 이미 한 번 비싼 대가를 치른 실패 모양이다.
 */
export function requestToolApproval(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "mode"> & { sessionKey: string; timeoutMs?: number },
): Promise<ToolApprovalOutcome> {
  const { sessionKey, timeoutMs = 5 * 60_000, ...rest } = input;
  if (hasSessionGrant(sessionKey, rest)) {
    return Promise.resolve({ decision: "allow_session", decidedAt: new Date().toISOString() });
  }
  const request: ToolApprovalRequest = {
    ...rest,
    id: `approval:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    mode: "live",
    requestedAt: new Date().toISOString(),
  };
  return new Promise<ToolApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      const outcome: ToolApprovalOutcome = { decision: "deny", decidedAt: new Date().toISOString() };
      for (const fn of resolvedListeners) { try { fn(request.id, outcome); } catch { /* 화면 하나가 실행을 깨지 못한다 */ } }
      resolve(outcome);
    }, timeoutMs);
    timer.unref?.();
    pending.set(request.id, {
      request,
      timer,
      resolve: (outcome) => {
        if (outcome.decision === "allow_session" || outcome.decision === "allow_always") {
          rememberSessionGrant(sessionKey, request);
        }
        if (outcome.decision === "allow_always") persistAlwaysGrant(request);
        resolve(outcome);
      },
    });
    for (const fn of listeners) { try { fn(request); } catch { /* 같은 이유 */ } }
  });
}

/*
 * 고지한 post-denial 요청들 — 사용자의 선택("다음부터 허용")을 나중에 반영하려면 그
 * 요청이 어느 세션의 무엇이었는지 알아야 한다. live 요청과 달리 기다리는 실행이 없어서
 * pending 에는 남지 않는다.
 *
 * ★이 맵이 없을 때 "다음부터 허용"은 아무 일도 하지 않았다: 허용 저장이 live 경로의
 *   resolve 안에만 있었고, post-denial 은 그 경로를 지나지 않는다. 누를 수 있는데 아무
 *   효과가 없는 버튼은 선택이 아니라 거짓말이다.
 */
const announced = new Map<string, { request: ToolApprovalRequest; sessionKey?: string }>();
const ANNOUNCED_LIMIT = 200;

/**
 * post-denial 고지 — 이미 거부된 호출을 사용자에게 보이게만 한다.
 * 답을 기다리지 않는다(기다릴 대상이 없다). 선택은 다음 실행의 허용 범위에만 쓰인다.
 */
export function announceToolDenied(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "mode"> & { sessionKey?: string },
): ToolApprovalRequest {
  const { sessionKey, ...rest } = input;
  const request: ToolApprovalRequest = {
    ...rest,
    id: `denied:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    mode: "post-denial",
    requestedAt: new Date().toISOString(),
  };
  announced.set(request.id, { request, sessionKey });
  // 오래된 고지부터 버린다 — 삽입 순서가 곧 시간 순서다.
  while (announced.size > ANNOUNCED_LIMIT) {
    const oldest = announced.keys().next();
    if (oldest.done) break;
    announced.delete(oldest.value);
  }
  for (const fn of listeners) { try { fn(request); } catch { /* 같은 이유 */ } }
  return request;
}

/** 사용자의 선택을 반영한다. live 요청만 대기 중인 실행을 푼다. */
export function resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean {
  const entry = pending.get(id);
  const outcome: ToolApprovalOutcome = { decision, decidedAt: new Date().toISOString() };
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(outcome);
  } else if (decision === "allow_session" || decision === "allow_always") {
    // 이미 거부된 호출이라 이번 실행은 되살릴 수 없다 — 그래서 이 선택이 뜻하는 바는
    // 오직 "다음부터는 묻지 말고 허용하라"이고, 그것만은 반드시 남아야 한다.
    const known = announced.get(id);
    if (known?.sessionKey) rememberSessionGrant(known.sessionKey, known.request);
    if (known && decision === "allow_always") persistAlwaysGrant(known.request);
  }
  for (const fn of resolvedListeners) { try { fn(id, outcome); } catch { /* 같은 이유 */ } }
  return Boolean(entry);
}

/**
 * 내장 도구(shared/builtin-tools.ts)의 승인 + 실행 — **한 벌**.
 *
 * ★로컬 루프(ollama·lmstudio·mlx)와 BYOK 가 각자 승인을 짜면, 한쪽이 관문을
 * 빠뜨렸을 때 그 런타임만 조용히 무방비가 된다. 이 파일이 이미 승인 정책의
 * 소유자이므로 실행까지 여기서 묶는다.
 *
 * 도구의 성격은 **알고 있는 것만** 싣는다: 내장 도구는 우리가 만들었으니
 * read/edit/execute 를 안다. 중재자가 던지면 거부다(fail-closed).
 */
export interface BuiltinApprovalContext {
  runtimeKind: string;
  sessionKey: string;
  permission: RuntimeToolPermissionAsk["permission"];
  cwd?: string;
  chatId?: string;
  unattended: boolean;
  signal?: AbortSignal;
}

export async function runApprovedBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BuiltinApprovalContext,
  events: { onTool?: (name: string, args?: string, result?: string, id?: string, isError?: boolean) => void },
  callId: string,
): Promise<{ ok: boolean; content: string }> {
  const builtin = builtinToolByName(toolName);
  const kind = builtin
    ? builtin.minPerm === "read"
      ? ("read" as const)
      : builtin.name === "bash"
        ? ("execute" as const)
        : ("edit" as const)
    : ("other" as const);
  const ask: RuntimeToolPermissionAsk = {
    runtime: ctx.runtimeKind,
    sessionKey: ctx.sessionKey,
    tool: toolName,
    kind,
    cwd: ctx.cwd,
    permission: ctx.permission,
    mutating: kind !== "read",
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.unattended ? { unattended: true as const } : {}),
  };
  const arbiter = getRuntimeToolPermissionArbiter();
  let approved: boolean;
  if (!arbiter) {
    approved = defaultRuntimeToolPermission(ask) !== "deny";
  } else {
    try {
      approved = (await arbiter(ask)) !== "deny";
    } catch {
      approved = false; // 중재자 실패는 거부다 — 실패가 허용이 되면 관문이 아니다.
    }
  }
  if (!approved) {
    const denied = `tool call denied — "${toolName}" was not approved for this run.`;
    events.onTool?.(toolName, JSON.stringify(args), denied, callId, true);
    return { ok: false, content: denied };
  }
  const outcome = await runBuiltinTool(toolName, args, {
    cwd: ctx.cwd ?? process.cwd(),
    permission: (ctx.permission ?? "read") as ToolPermission,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    askUser: (input) =>
      askUser(
        { ...input, askedBy: ctx.runtimeKind, ...(ctx.chatId ? { chatId: ctx.chatId } : {}) },
        { unattended: ctx.unattended, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      ),
  });
  events.onTool?.(toolName, JSON.stringify(args), outcome.content, callId, !outcome.ok);
  return outcome;
}
