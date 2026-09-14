/**
 * ★작업 블록 줄 — 데스크탑 One/Work 와 Science 가 같은 규칙 한 벌로 만든다.
 *
 * 오너 지시 2026-09-14: "추론 과정 디스플레이는 모듈화해서 One 것을 쓰라." 실측(연구자 앱 한 턴 60줄):
 *   · "생각함" 30줄 — 1초 미만 생각마다 한 줄. One 은 연속된 생각을 합쳐 누적 시간을 보인다.
 *   · "도구 unknown" — 이름 없는 tool-use 727건이 전부 런타임 상태 하트비트였다. 도구가 아니다.
 *   · 도구 줄 객체에 셸 원문·절대 경로·영어 도구 이름이 그대로.
 *
 * 규칙(둘 다 이 함수를 부른다):
 *   1. 연속된 생각(reasoning)은 한 줄로 합치고 시간을 누적한다. 상태 하트비트는 생각을 끊지 않는다.
 *   2. 이름 없는/"unknown" 도구 이벤트는 줄이 되지 않는다(요약이 있으면 그 요약으로 남긴다).
 *   3. 도구 객체는 사람이 읽는 한 줄: 프로젝트 폴더·홈 경로 축약, 공백 정리, 96자 상한.
 *   4. 상태(status)는 줄이 아니다 — 작성창 상태 줄의 재료일 뿐이다.
 *   5. 오류·중단 요청은 그대로 남는다. 최근 80줄만 돌려준다.
 *
 * 이 파일은 의존성이 없고 프레임워크를 모른다. 정본은 agentlas_desktop/shared/turn-activity-rows.ts,
 * agentlas-science/src/turn-activity-rows.ts 는 바이트 동일 사본이며 계약이 두 파일의 해시를 대조한다
 * (런타임 닥터 3제품 싱크와 같은 방식). 사본을 고치지 말고 정본을 고친 뒤 복사하라.
 */

export type TurnActivityEventKind = "tool" | "reasoning" | "status" | "lifecycle" | "error";

export interface TurnActivityEvent {
  sequence: number;
  kind: TurnActivityEventKind;
  code: string;
  at: string;
  toolName?: string | null;
  toolSummary?: string | null;
  isError?: boolean;
  phase?: string | null;
  durationMs?: number | null;
  message?: string | null;
  status?: string | null;
}

export interface TurnActivityRow {
  sequence: number;
  kind: "tool" | "reasoning" | "lifecycle" | "error";
  code: string;
  at: string;
  toolName?: string | null;
  toolSummary?: string | null;
  isError?: boolean;
  phase?: string | null;
  durationMs?: number | null;
  message?: string | null;
}

export interface TurnActivityRowOptions {
  /** 프로젝트 폴더(작업 디렉터리). 이 아래의 절대 경로는 상대 경로로 줄인다. */
  cwd?: string | null;
  /** 홈 디렉터리. 이 아래의 절대 경로는 `~/` 로 줄인다. 없으면 /Users/<x>/·/home/<x>/ 를 줄인다. */
  homeDir?: string | null;
  /** 도구 객체 한 줄의 상한(기본 96). */
  maxObjectLength?: number;
  /** 돌려줄 최근 줄 수(기본 80). */
  maxRows?: number;
}

export const TURN_ACTIVITY_MERGED_THOUGHT_CODE = "runtime-thought";

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripPrefix(value: string, prefix: string, replacement: string): string {
  const base = prefix.replace(/[/\\]+$/, "");
  if (!base) return value;
  let out = value;
  for (const separator of ["/", "\\"]) {
    out = out.split(`${base}${separator}`).join(replacement);
  }
  return out === value ? value : out;
}

/** 도구 객체(무엇에 썼는가)를 사람이 읽는 한 줄로. 비밀 마스킹은 호스트가 이미 했다고 전제한다. */
export function shortenToolObject(text: unknown, options: TurnActivityRowOptions = {}): string {
  let value = typeof text === "string" ? normalizedWhitespace(text) : "";
  if (!value) return "";
  if (options.cwd) value = stripPrefix(value, options.cwd, "");
  if (options.homeDir) value = stripPrefix(value, options.homeDir, "~/");
  value = value.replace(/\/(?:Users|home)\/[^/\s]+\//g, "~/");
  const max = Math.max(24, Math.floor(options.maxObjectLength ?? 96));
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 이름 없는 도구 이벤트인가(런타임 상태 하트비트가 이 모양으로 온다). */
export function isNamelessToolEvent(event: Pick<TurnActivityEvent, "toolName">): boolean {
  const name = typeof event.toolName === "string" ? event.toolName.trim() : "";
  return !name || name === "unknown";
}

/**
 * 이벤트 → 화면 줄. 연속된 생각은 한 줄(code `runtime-thought`, phase `end`, durationMs 누적)이다.
 * 생각 사이의 상태 하트비트는 생각을 끊지 않는다; 도구·오류·수명주기는 끊는다.
 */
export function buildTurnActivityRows(events: readonly TurnActivityEvent[], options: TurnActivityRowOptions = {}): TurnActivityRow[] {
  const rows: TurnActivityRow[] = [];
  let thought: { sequence: number; at: string; durationMs: number; startedAt: string | null } | null = null;
  const flush = () => {
    if (!thought) return;
    rows.push({ sequence: thought.sequence, kind: "reasoning", code: TURN_ACTIVITY_MERGED_THOUGHT_CODE, at: thought.at, phase: "end", durationMs: thought.durationMs });
    thought = null;
  };
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const event of sorted) {
    if (event.kind === "status") continue;
    if (event.kind === "reasoning") {
      if (!thought) thought = { sequence: event.sequence, at: event.at, durationMs: 0, startedAt: null };
      if (event.phase === "start") { thought.startedAt = event.at; continue; }
      let ms = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? event.durationMs : null;
      if (ms === null && thought.startedAt) {
        const span = Date.parse(event.at) - Date.parse(thought.startedAt);
        ms = Number.isFinite(span) ? span : null;
      }
      thought.startedAt = null;
      if (ms !== null && ms > 0) thought.durationMs += ms;
      continue;
    }
    flush();
    if (event.kind === "tool") {
      const summary = shortenToolObject(event.toolSummary, options);
      if (isNamelessToolEvent(event) && !summary) continue;
      rows.push({
        sequence: event.sequence,
        kind: "tool",
        code: event.code,
        at: event.at,
        toolName: isNamelessToolEvent(event) ? null : String(event.toolName).trim(),
        toolSummary: summary || null,
        isError: event.isError === true,
      });
      continue;
    }
    if (event.kind === "lifecycle") {
      rows.push({ sequence: event.sequence, kind: "lifecycle", code: event.code, at: event.at });
      continue;
    }
    if (event.kind === "error") {
      rows.push({ sequence: event.sequence, kind: "error", code: event.code, at: event.at, message: typeof event.message === "string" ? event.message : null });
    }
  }
  flush();
  const max = Math.max(1, Math.floor(options.maxRows ?? 80));
  return rows.slice(-max);
}

/** 이미 만들어진 줄에서 연속된 생각을 다시 합친다(One 의 셀 뒤처리 등에서 쓴다). */
export function mergeConsecutiveThoughts<T extends { kind: string; durationMs?: number | null }>(
  rows: readonly T[],
  isMergeable: (row: T) => boolean = () => true,
  merge: (into: T, from: T) => T = (into, from) => ({ ...into, durationMs: (into.durationMs ?? 0) + (from.durationMs ?? 0) }),
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.kind === "reasoning" && row.kind === "reasoning" && isMergeable(last) && isMergeable(row)) {
      out[out.length - 1] = merge(last, row);
      continue;
    }
    if (last && last.kind === "thought" && row.kind === "thought" && isMergeable(last) && isMergeable(row)) {
      out[out.length - 1] = merge(last, row);
      continue;
    }
    out.push(row);
  }
  return out;
}
