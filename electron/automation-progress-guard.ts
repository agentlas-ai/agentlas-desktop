import type { McpInvocationEvent } from "../shared/types";
import { normalizeProgressText } from "../shared/progress-key";
import { couldHaveChangedTheOutsideWorld } from "../shared/tool-activity";
import { readOnlyBrowserToolIsMutating } from "./mcp-tools/proxy-server";

/**
 * ★무인 실행의 "제자리 도는" 도구 호출을 호스트가 센다 — 모델의 자기 보고가 아니라.
 *
 * 실측(Threads 자동화 f7a61706, 프로덕션 1.2.38·1.2.39, 2026-09-23 16:00Z·17:00Z):
 * agy 가 한 실행 안에서 browser_find ×28·×15, browser_navigate ×19·×14 를 부르고 게시·이미지는 0건.
 * browser_find 에 스냅샷 ref 를 글자로 넣어(e826·e833·e839·e845·e851) 같은 페이지를 다시 뒤졌고,
 * 같은 프로필 URL 로 다섯 단계가 번갈아 다시 들어갔다. 감시견(automation-watchdog)은
 * "이벤트가 끊겼나"만 봐서 — 이벤트는 계속 왔으니 — 아무것도 멈추지 않았고, 실행은 "ok"로 끝났다.
 *
 * 규칙(모두 "상태를 바꾸는 호출이 한 번도 없었던 구간" 안에서만 센다 — 바꾸는 호출은 진전의 증거다):
 *  - 같은 관찰 호출(도구 + 정규화 인자, 숫자는 #)이 한 단계 안에서 5번 → 멈춘다.
 *  - 같은 URL 로 이동이 한 단계 안에서 3번, 실행 전체에서 6번 → 멈춘다.
 *  - 어떤 도구든 똑같은 호출(정규화 전 원문)이 한 단계 안에서 연속 4번 → 멈춘다(바꾸는 호출의 헛돌기 포함).
 * 문턱은 정상 운영을 막지 않는 쪽으로 넉넉하다 — 위 실측의 16:00Z 실행(e### ×5)은 걸리고,
 * 단계마다 프로필을 한 번씩 확인하는 설계(실행 전체 4번)는 걸리지 않는다.
 *
 * 순수 상태 기계 — DB·시계·런타임 없음. 결정은 기계 표식(reasonCode)으로만 나간다.
 */

export const AUTOMATION_NO_PROGRESS_LOOP = "automation_no_progress_loop" as const;

export const NO_PROGRESS_LIMITS = Object.freeze({
  /** 같은 관찰(정규화 지문) 반복 — 한 단계 안. */
  sameObservationPerNode: 5,
  /** 같은 URL 이동 — 한 단계 안. */
  sameUrlPerNode: 3,
  /** 같은 URL 이동 — 실행 전체(단계를 가로질러). */
  sameUrlPerRun: 6,
  /** 원문까지 똑같은 호출이 끊김 없이 연속 — 한 단계 안. */
  identicalStreakPerNode: 4,
});

/**
 * 페이지·계정·파일을 바꾸지 않는 호출인가 — 손 목록 없이 두 정본에 묻는다.
 *  - shared/tool-activity couldHaveChangedTheOutsideWorld: 런타임별 읽기 도구(Read·view_file·list_dir…)의 정본.
 *    브라우저 도구는 여기서 전부 "바꿨을 수 있다"(보수적)라서, 그것만 쓰면 모든 조회가 진전으로 보인다.
 *  - mcp-tools/proxy-server readOnlyBrowserToolIsMutating: Main 이 소유한 agentlas-browser 읽기 전용 프로필
 *    (효과 관찰이 쓰는 그 관문) — 도구 이름과 인자 모양까지 본다(탭 닫기·파일 저장 인자는 변이).
 * 둘 중 하나라도 "읽기"라고 하면 관찰로 센다. 나머지(클릭·입력·게시·파일 쓰기·이미지 생성·모르는 이름)는 진전.
 */
function isObservation(name: string, args: unknown): boolean {
  if (!couldHaveChangedTheOutsideWorld(name)) return true;
  return !readOnlyBrowserToolIsMutating({ toolName: name, args });
}

type Scope = string;
const RUN_SCOPE = "\u0000run";

interface ScopeState {
  observationCounts: Map<string, number>;
  urlCounts: Map<string, number>;
  lastExact: string | null;
  exactStreak: number;
  seenToolIds: Set<string>;
}

export interface NoProgressGuardState {
  scopes: Map<Scope, ScopeState>;
  runUrlCounts: Map<string, number>;
  tripped: NoProgressDecision | null;
}

export interface NoProgressDecision {
  reasonCode: typeof AUTOMATION_NO_PROGRESS_LOOP;
  rule: "same_observation" | "same_url_node" | "same_url_run" | "identical_streak";
  tool: string;
  /** 정규화된 지문 요약(원문 인자 아님 — 사적인 글자가 영수증에 남지 않게 길이를 자른다). */
  fingerprint: string;
  count: number;
  nodeId: string | null;
}

export function createNoProgressGuard(): NoProgressGuardState {
  return { scopes: new Map(), runUrlCounts: new Map(), tripped: null };
}

function scopeState(state: NoProgressGuardState, scope: Scope): ScopeState {
  let current = state.scopes.get(scope);
  if (!current) {
    current = { observationCounts: new Map(), urlCounts: new Map(), lastExact: null, exactStreak: 0, seenToolIds: new Set() };
    state.scopes.set(scope, current);
  }
  return current;
}

export function shortToolName(name: string): string {
  const trimmed = (name ?? "").trim();
  // mcp__<server>__<tool> — 서버 이름엔 밑줄 하나가 들어갈 수 있지만 구분자는 늘 두 개다.
  const short = trimmed.startsWith("mcp__") && trimmed.lastIndexOf("__") > 4
    ? trimmed.slice(trimmed.lastIndexOf("__") + 2)
    : trimmed;
  return short.toLowerCase();
}

function parseArgs(raw: string | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 같은 곳이면 같은 키 — www·끝 슬래시·해시·대소문자 차이는 다른 곳이 아니다. */
export function normalizeNavigationUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${host}${pathname.toLowerCase()}${url.search}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function tripped(
  state: NoProgressGuardState,
  decision: Omit<NoProgressDecision, "reasonCode">,
): NoProgressDecision {
  state.tripped = { reasonCode: AUTOMATION_NO_PROGRESS_LOOP, ...decision };
  return state.tripped;
}

/**
 * 도구 호출 하나를 센다. 같은 호출의 요청·결과 이벤트(같은 tool.id)는 한 번만 센다.
 * 문턱을 넘으면 결정을 돌려주고, 이미 넘었으면 계속 같은 결정을 돌려준다.
 */
export function noteNoProgressEvent(
  state: NoProgressGuardState,
  event: McpInvocationEvent,
): NoProgressDecision | null {
  if (state.tripped) return state.tripped;
  if (event.kind !== "tool-use" || !event.tool?.name) return null;
  const tool = event.tool;
  // 상태만 알리는 이벤트(인자 없음)·플러그인 라우팅 표시("Agentlas Plugins · routed")는 호출이 아니다.
  if (tool.args === undefined) return null;
  const nodeId = event.nodeId?.trim() || null;
  const scope = scopeState(state, nodeId ?? RUN_SCOPE);
  const id = tool.id?.trim();
  if (id) {
    if (scope.seenToolIds.has(id)) return null;
    scope.seenToolIds.add(id);
  } else if (tool.result !== undefined || tool.isError === true) {
    // id 없는 결과 이벤트는 짝을 못 찾는다 — 요청 쪽에서 이미 셌다.
    return null;
  }
  let name = shortToolName(tool.name);
  let args = parseArgs(tool.args);
  // agy 의 범용 MCP 호출(call_mcp_tool {ServerName, ToolName, Arguments})은 안쪽 도구로 센다.
  if (name === "call_mcp_tool" && args && typeof args === "object" && !Array.isArray(args)) {
    const envelope = args as Record<string, unknown>;
    if (typeof envelope.ToolName === "string" && envelope.ToolName.trim()) {
      name = shortToolName(envelope.ToolName);
      args = envelope.Arguments ?? {};
    }
  }
  const exact = `${name} ${stableJson(args)}`;
  const nearKey = `${name} ${normalizeProgressText(stableJson(args))}`;
  const fingerprint = nearKey.slice(0, 160);

  scope.exactStreak = scope.lastExact === exact ? scope.exactStreak + 1 : 1;
  scope.lastExact = exact;
  if (scope.exactStreak >= NO_PROGRESS_LIMITS.identicalStreakPerNode) {
    return tripped(state, { rule: "identical_streak", tool: name, fingerprint, count: scope.exactStreak, nodeId });
  }

  if (!isObservation(name, args)) {
    // 바꾸는 호출 = 진전. 이 단계와 실행 전체의 관찰 카운터를 비운다(헛도는 연속 호출은 위에서 이미 잡는다).
    scope.observationCounts.clear();
    scope.urlCounts.clear();
    state.runUrlCounts.clear();
    return null;
  }

  if (name === "browser_navigate" || (name === "browser_tabs" && args && typeof args === "object"
    && (args as Record<string, unknown>).action === "new")) {
    const url = normalizeNavigationUrl((args as Record<string, unknown> | null)?.url);
    if (url) {
      const nodeCount = (scope.urlCounts.get(url) ?? 0) + 1;
      scope.urlCounts.set(url, nodeCount);
      const runCount = (state.runUrlCounts.get(url) ?? 0) + 1;
      state.runUrlCounts.set(url, runCount);
      if (nodeCount >= NO_PROGRESS_LIMITS.sameUrlPerNode) {
        return tripped(state, { rule: "same_url_node", tool: name, fingerprint: url.slice(0, 160), count: nodeCount, nodeId });
      }
      if (runCount >= NO_PROGRESS_LIMITS.sameUrlPerRun) {
        return tripped(state, { rule: "same_url_run", tool: name, fingerprint: url.slice(0, 160), count: runCount, nodeId });
      }
    }
    return null;
  }

  const count = (scope.observationCounts.get(nearKey) ?? 0) + 1;
  scope.observationCounts.set(nearKey, count);
  if (count >= NO_PROGRESS_LIMITS.sameObservationPerNode) {
    return tripped(state, { rule: "same_observation", tool: name, fingerprint, count, nodeId });
  }
  return null;
}

/** 사람이 읽는 한 줄 + 맨 앞 기계 표식. 분류기는 표식만 본다. */
export function noProgressLoopError(decision: NoProgressDecision): string {
  const where = decision.nodeId ? ` in step "${decision.nodeId}"` : "";
  const what = decision.rule === "same_url_node" || decision.rule === "same_url_run"
    ? `opened the same page ${decision.count} times without changing anything`
    : decision.rule === "identical_streak"
      ? `repeated the identical ${decision.tool} call ${decision.count} times in a row`
      : `repeated the same ${decision.tool} lookup ${decision.count} times without changing anything`;
  return `${AUTOMATION_NO_PROGRESS_LOOP}: the run ${what}${where}, so the host stopped it instead of letting it loop.`;
}
