// 도구 접근 고지 — 에이전트가 도구를 쓸 수 있는 **모든 표면**이 같은 말을 하게 하는 한 벌.
//
// 왜 한 벌인가: 에이전트가 도구를 받는 진입점은 Desktop 런타임만 20개가 넘고, 터미널과
// OS 플러그인(Claude Code/Codex/Cursor)까지 합치면 더 늘어난다. 진입점마다 안내를 손으로
// 이어 붙이면 반드시 몇 곳이 빠지고, 빠진 곳은 조용하다 — 조용한 표면은 "도구가 없다"와
// "도구가 있는데 안 쓴다"를 구분해 주지 못한다.
//
// ★이 파일이 고치는 결함: 이전 Desktop 생성기는 붙은 도구가 하나도 없으면 안내를 통째로
// 빈 문자열로 만들었다(`tools.length === 0 && hubPluginCount === 0` → `""`). 도구가 없을
// 때야말로 안내가 가장 필요한 순간인데, 정확히 그때 침묵했다. 그래서 에이전트는 "이 기계엔
// 도구가 없다"고 단정하거나, 있지도 않은 도구를 부르거나, 사용자에게 아무 말도 하지 않았다.
//
// 계약(표면 무관):
//   ① 도구가 0개여도 반드시 말한다.
//   ② 없다고 단정하기 전에 Hub까지 확인하라고 말한다(찾는 방법을 이름으로 준다).
//   ③ 설치는 사람이 한다 — 에이전트는 slug와 무엇을 하게 되는지까지만 말하고 멈춘다.
//
// 터미널 미러: agentlas_terminal/engine/tools/access-notice.cjs
// 두 벌이 같은 문장을 내는지 test-tool-access-notice-parity가 검사한다.

export type ToolAccessNoticeInput = {
  /** 이번 실행에 실제로 붙어 쓸 수 있는 도구 이름들. */
  readonly availableTools: readonly string[];
  /** 붙었지만 자격증명이 없어 못 쓰는 것들 — 있으면 사람에게 물어야 한다. */
  readonly blockedTools?: readonly string[];
  /** 승인을 기다리며 꺼져 있는 것들 — 이미 이 기계에 있고 켜기만 하면 된다. */
  readonly pendingApprovalTools?: readonly string[];
  /** Hub 카탈로그를 조회할 수 있는가. 없으면 "찾아보라"고 말하면 안 된다. */
  readonly hubCatalogAvailable: boolean;
  /** Hub 조회가 실패했다면 그 사유(값 없음 = 실패 안 함). */
  readonly hubCatalogError?: string | null;
  /** 이 표면에서 Hub 플러그인을 찾는 도구 이름. 런타임마다 다르다. */
  readonly resolveToolName?: string;
};

const DEFAULT_RESOLVE_TOOL = "agentlas_resolve_plugins";

/**
 * 모든 표면이 공유하는 도구 접근 고지.
 *
 * 절대 빈 문자열을 반환하지 않는다. 붙은 도구가 없다는 사실 자체가 에이전트가 알아야 할
 * 정보이고, 그 순간이 바로 설치를 권해야 하는 순간이다.
 */
export function buildToolAccessNotice(input: ToolAccessNoticeInput): string {
  const resolveTool = input.resolveToolName?.trim() || DEFAULT_RESOLVE_TOOL;
  const available = input.availableTools.filter((name) => name.trim().length > 0);
  const blocked = (input.blockedTools ?? []).filter((name) => name.trim().length > 0);
  const pending = (input.pendingApprovalTools ?? []).filter((name) => name.trim().length > 0);
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger terminal.access-notice.tools.system).
  const lines: string[] = [];

  lines.push("install/enable: user decides → show slug, permissions, credentials needed; never on your own");
  lines.push("nothing covers the need: say so; never describe a tool call you did not make");

  lines.push(available.length > 0 ? `tools: ${available.join(", ")}` : "tools: none");

  if (pending.length > 0) {
    lines.push(`attached but off, awaiting user approval: ${pending.join(", ")} → ask to approve; no new install`);
  }

  if (input.hubCatalogAvailable) {
    lines.push(`before saying a capability is unavailable: call ${resolveTool}(capability) → Hub catalog lists uninstalled integrations`);
  } else if (input.hubCatalogError) {
    lines.push(`Hub catalog unreachable (${input.hubCatalogError}) → say unreachable, not "no such tool"`);
  } else {
    lines.push("Hub catalog not reachable here → state limits; no claims of unconnected capabilities");
  }

  if (blocked.length > 0) {
    lines.push(`blocked until credentials set: ${blocked.join(", ")} → ask only if the task needs them`);
  }

  return lines.join("\n");
}
