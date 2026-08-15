/**
 * 에이전트 응답에 섞여 오는 **제어 블록**을 표시용 텍스트에서 제거하는 순수 함수.
 *
 * 호스트는 이 블록들을 구조화 데이터로 따로 소비한다(기억 티켓, 위임, 자동화 등록,
 * 질문, 후속 행동). 사용자에게는 절대 원문이 보이면 안 된다.
 *
 * WIRE FORMAT 정본은 각 파서다 — 여기서 규칙을 새로 만들지 않는다:
 *  - `## Memory Events` + ```json  → electron/memory/events.ts parseMemoryEvents
 *  - `## Delegate`     + ```json  → electron/mcp/delegate.ts parseDelegations
 *  - `## Automation`   + ```json  → electron/automation-emitter.ts parseAutomations
 *  - `<<agentlas-ask>>…<</agentlas-ask>>`             → renderer/lib/ask-question.ts
 *  - `<<agentlas-one-followups>>…<</…>>`              → shared/one-friendly-followups.ts
 *  - `<<agentlas-surface>>…<</agentlas-surface>>`     → electron/surface-emitter.ts parseSurfaces
 *  - `<<agentlas-goal-complete: …>>`                 → host goal-loop completion marker
 *
 * 이 파일은 **표시 전용**이다. 파싱·적용은 위 정본들이 계속 소유한다.
 * Mobile(Dart)에도 같은 규칙이 이식되어 있고, 공유 픽스처로 두 표면의 출력이
 * 바이트 단위로 같은지 게이트가 검사한다.
 *
 * ★2026-08-12 사용자 제보: followups와 surface 원문이 **동시에** 화면에 떴다.
 * 원인은 손코딩 스트리퍼 3벌이 서로 다른 마커만 알고 있었던 것 —
 * 이 파일(모바일 브리지·텔레그램)은 surface를 몰랐고, 반대로
 * electron/mcp/final-display-backstop.ts는 followups를 몰랐다. 마커 목록은
 * 여기 한 벌만 두고, 다른 표면은 상수를 **가져다 쓴다**(surface-emitter가
 * SURFACE_*_FENCE를 여기서 재수출). 표면마다 목록을 다시 적으면 또 한 표면만
 * 빠진다 — telegram/connect.ts에 같은 사고가 이미 기록돼 있다.
 */

export const AGENT_CONTROL_HEADINGS = [
  "## Memory Events",
  "## Delegate",
  "## Automation",
] as const;

export const AGENT_ASK_OPEN = "<<agentlas-ask>>";
export const AGENT_ASK_CLOSE = "<</agentlas-ask>>";
export const AGENT_FOLLOWUPS_OPEN = "<<agentlas-one-followups>>";
export const AGENT_FOLLOWUPS_CLOSE = "<</agentlas-one-followups>>";
/** surface 울타리의 **정본 상수**. electron/surface-emitter.ts가 이걸 재수출한다. */
export const AGENT_SURFACE_OPEN = "<<agentlas-surface>>";
export const AGENT_SURFACE_CLOSE = "<</agentlas-surface>>";
export const AGENT_MULTIMODAL_MARKER = "<<agentlas-multimodal-setup>>";
/** 값 없는 제어 마커(runtime/runner.ts SURFACE_INTENT_MARKER). 표시되면 안 된다. */
export const AGENT_SURFACE_INTENT_MARKER = "<<surface-intent>>";
/** Host-only completion marker. It is control metadata, never answer content. */
export const AGENT_GOAL_COMPLETE_PREFIX = "<<agentlas-goal-complete";

/**
 * One owns assistant identity in product chrome. Provider/persona badges such
 * as `[Hope]` or `[희망]` are not answer content and can also leak the wrong
 * locale. Remove only compact capitalized or Hangul name badges surrounded by
 * whitespace; redaction markers such as `[local path]` remain intact.
 */
export function stripAgentIdentityBadges(value: string): string {
  return value.replace(
    /(^|\s)(?:\*\*)?\[\s*(?:[A-Z][A-Za-z .'-]{0,31}|[\u3131-\u318e\uac00-\ud7a3]{1,16})\s*\](?:\*\*)?(?=\s|$)/gu,
    "$1",
  ).replace(/[ \t]{2,}/g, " ").trim();
}

/** 여는 토큰이 완성되기 전 스트리밍 조각도 숨기기 위한 탐침(prefix). */
const PAIRED_BLOCKS = [
  { probe: "<<agentlas-one-followups", open: AGENT_FOLLOWUPS_OPEN, close: AGENT_FOLLOWUPS_CLOSE },
  { probe: "<<agentlas-ask", open: AGENT_ASK_OPEN, close: AGENT_ASK_CLOSE },
  { probe: "<<agentlas-surface", open: AGENT_SURFACE_OPEN, close: AGENT_SURFACE_CLOSE },
] as const;

/** 완료 마커는 paired fence가 아니라 `: message >>` 한 토큰으로 온다. */
const GOAL_COMPLETE_RE = /<<agentlas-goal-complete(?::[\s\S]*?)?>>/g;

/** 헤딩 뒤 첫 코드펜스. 정본 파서들과 같은 표현식이다. */
const FENCE_RE = /```(?:json)?\s*[\s\S]*?```/;

/** 스트리밍 꼬리에서 잘라낼 수 있는 미완성 토큰 후보. */
const TAIL_TOKENS: readonly string[] = [
  ...AGENT_CONTROL_HEADINGS,
  AGENT_ASK_OPEN,
  AGENT_FOLLOWUPS_OPEN,
  AGENT_SURFACE_OPEN,
  AGENT_MULTIMODAL_MARKER,
  AGENT_SURFACE_INTENT_MARKER,
  AGENT_GOAL_COMPLETE_PREFIX,
];

/** 값 없이 통째로 지워도 되는 제어 마커. */
const BARE_MARKERS: readonly string[] = [AGENT_MULTIMODAL_MARKER, AGENT_SURFACE_INTENT_MARKER];

/** 미완성 꼬리로 인정하는 최소 길이. 너무 짧으면 정상 본문을 갉아먹는다. */
const MIN_PARTIAL_TAIL = 4;

interface Hit {
  index: number;
  cutTo: number;
}

/**
 * 펜스가 없을 때 어디까지 버리는가 — **정본 파서마다 다르다.**
 *
 * 셋을 한 규칙으로 묶었더니 모바일·텔레그램에서만 답이 잘려 나갔다:
 * - `## Memory Events` → 뒤를 전부 버린다 (electron/memory/events.ts:186)
 * - `## Delegate`      → 제목만 버린다   (electron/mcp/delegate.ts:110)
 * - `## Automation`    → 제목만 버린다   (electron/automation-emitter.ts:420)
 *
 * 미러는 정본을 따라야 한다. 더 파괴적인 미러는 미러가 아니라 별개의 결함이다.
 */
const DANGLING_HEADING_DROPS_TAIL: ReadonlySet<string> = new Set([
  "## Memory Events",
]);

function headingHit(value: string, heading: string): Hit | null {
  const start = value.indexOf(heading);
  if (start < 0) return null;
  const after = value.slice(start + heading.length);
  const fence = after.match(FENCE_RE);
  if (fence && fence.index != null) {
    return { index: start, cutTo: start + heading.length + fence.index + fence[0].length };
  }
  // 펜스가 없다 = dangling heading. 정본이 정한 만큼만 버린다.
  return {
    index: start,
    cutTo: DANGLING_HEADING_DROPS_TAIL.has(heading) ? value.length : start + heading.length,
  };
}

function pairedHit(
  value: string,
  block: (typeof PAIRED_BLOCKS)[number],
): Hit | null {
  const start = value.indexOf(block.probe);
  if (start < 0) return null;
  // 탐침만 맞고 여는 토큰이 아직 완성되지 않았다면 스트리밍 중이다 — 뒤를 전부 숨긴다.
  if (!value.startsWith(block.open, start)) return { index: start, cutTo: value.length };
  const end = value.indexOf(block.close, start + block.open.length);
  return end < 0
    ? { index: start, cutTo: value.length }
    : { index: start, cutTo: end + block.close.length };
}

/**
 * 표시용 텍스트에서 제어 블록을 전부 제거한다.
 *
 * `streaming`이 true면 아직 완성되지 않은 제어 토큰의 앞부분이 꼬리에 남아 있을 때
 * 그 조각까지 감춘다. 완성된 응답에는 적용하지 않는다 — 정상 본문을 자르면 안 된다.
 */
export function stripAgentControlBlocks(value: string, options?: { streaming?: boolean }): string {
  let visible = value.replace(GOAL_COMPLETE_RE, "");
  for (const marker of BARE_MARKERS) visible = visible.split(marker).join("");

  // 모델은 제어 블록을 여러 개 낼 수 있다. 적대적 스팸에도 멈추도록 상한을 둔다.
  for (let guard = 0; guard < 64; guard += 1) {
    let best: Hit | null = null;
    for (const heading of AGENT_CONTROL_HEADINGS) {
      const hit = headingHit(visible, heading);
      if (hit && (best === null || hit.index < best.index)) best = hit;
    }
    for (const block of PAIRED_BLOCKS) {
      const hit = pairedHit(visible, block);
      if (hit && (best === null || hit.index < best.index)) best = hit;
    }
    if (best === null) break;
    const next = visible.slice(0, best.index) + visible.slice(best.cutTo);
    if (next === visible) break;
    visible = next;
  }

  visible = visible
    .split(AGENT_ASK_CLOSE)
    .join("")
    .split(AGENT_FOLLOWUPS_CLOSE)
    .join("")
    .split(AGENT_SURFACE_CLOSE)
    .join("");
  visible = failClosedOnRemainingControlToken(visible);
  visible = stripTrailingMemoryTicketEnvelope(visible);
  if (options?.streaming) visible = trimIncompleteControlTail(visible);
  return visible.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 상한을 넘긴 적대적 반복에서도 **열려서 실패하지 않는다**. 남은 첫 제어 토큰
 * 이후를 통째로 버린다 — electron/memory/events.ts stripAllMemoryEventBlocks의
 * bounded fallback과 같은 규칙이다.
 */
function failClosedOnRemainingControlToken(value: string): string {
  let cut = value.length;
  for (const token of TAIL_TOKENS) {
    const index = value.indexOf(token);
    if (index >= 0 && index < cut) cut = index;
  }
  return cut === value.length ? value : value.slice(0, cut);
}

/** 꼬리에 붙은 ```json 펜스가 **닫힌 스키마**의 기억 티켓 봉투일 때만 제거한다. */
const TAIL_JSON_FENCE_RE = /(?:^|\n)```json\s*([\s\S]*?)```\s*$/i;

function stripTrailingMemoryTicketEnvelope(value: string): string {
  // 모델이 헤딩만 빠뜨리고 봉투는 그대로 낸다. electron/memory/events.ts
  // parseMemoryEvents 와 같은 판정 — 평범한 JSON 코드블록은 건드리지 않는다.
  const match = value.match(TAIL_JSON_FENCE_RE);
  if (!match || match.index == null) return value;
  try {
    const data = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (data?.schema_version === "agentlas.memory-ticket.v1" && Array.isArray(data.candidates)) {
      return value.slice(0, match.index);
    }
  } catch {
    // 닫힌 봉투가 아니다. 사용자가 보려던 JSON일 수 있으므로 그대로 둔다.
  }
  return value;
}

/**
 * 스트리밍 조각이 제어 토큰 중간에서 끊겼을 때 그 꼬리를 감춘다. 다음 청크가
 * 도착하면 온전한 판정이 다시 이루어지므로 손실이 아니라 한 프레임 지연이다.
 */
export function trimIncompleteControlTail(value: string): string {
  let cut = value.length;
  for (const token of TAIL_TOKENS) {
    for (let length = Math.min(token.length - 1, value.length); length >= MIN_PARTIAL_TAIL; length -= 1) {
      if (value.endsWith(token.slice(0, length))) {
        cut = Math.min(cut, value.length - length);
        break;
      }
    }
  }
  return cut === value.length ? value : value.slice(0, cut);
}
