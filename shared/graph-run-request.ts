// 바깥에서 그래프를 켜는 **하나의 문** (커넥터 C47·C48 / graph/1 trigger.command).
//
// 왜 한 곳이어야 하나: 지금 켜는 입구가 여럿이다 — 사람이 누르는 버튼, 터미널의 실행 요청,
// 앞으로 붙을 SDK와 MCP 도구. 입구마다 각자 검사하면 **같은 그래프가 부르는 쪽에 따라
// 다르게 돈다.** 실제로 터미널은 SQL을 직접 써서 켜고, 데스크탑은 IPC에서 따로 검사한다.
//
// 그래서 "켜도 되는가"의 판단을 여기 한 곳에 둔다. 입구는 이 판단을 **가져다 쓴다**.
import type { Automation } from "./types";
import { graphInputRequirement } from "./graph-trigger-input";

export type GraphRunRequestDecision =
  | { ok: true; automationId: string; input: Record<string, string> }
  | { ok: false; code: string; reason: string; nextAction: string };

/**
 * 이름 또는 id로 그래프를 찾는다.
 *
 * ★id가 정본이다. 이름은 사람이 바꾸고, 같은 이름이 둘일 수도 있다 — 이름으로 부른 것이
 * 어느 날 다른 그래프를 켜면 그건 조용한 사고다. 그래서 이름이 여럿과 맞으면 거절한다.
 */
export function resolveGraphRef(
  ref: string,
  automations: Automation[],
): { ok: true; automation: Automation } | { ok: false; code: string; reason: string; nextAction: string } {
  const needle = String(ref ?? "").trim();
  if (!needle) {
    return {
      ok: false, code: "RUN_REQUEST_REF_MISSING",
      reason: "어느 자동화를 실행할지가 없습니다.",
      nextAction: "자동화 이름이나 id를 함께 보내 주세요.",
    };
  }
  const byId = automations.find((a) => a.id === needle);
  if (byId) return { ok: true, automation: byId };
  const byName = automations.filter((a) => a.name.trim() === needle);
  if (byName.length === 1) return { ok: true, automation: byName[0] };
  if (byName.length > 1) {
    return {
      ok: false, code: "RUN_REQUEST_REF_AMBIGUOUS",
      reason: `"${needle}"라는 이름의 자동화가 ${byName.length}개입니다.`,
      nextAction: "id로 지정해 주세요 — 이름은 겹칠 수 있습니다.",
    };
  }
  return {
    ok: false, code: "RUN_REQUEST_NOT_FOUND",
    reason: `"${needle}"와 맞는 자동화가 없습니다.`,
    nextAction: "자동화 목록에서 이름이나 id를 확인해 주세요.",
  };
}

/**
 * 이 요청으로 켜도 되는가. **거절도 코드·사유·다음 행동을 갖는다.**
 *
 * 검사 순서에 뜻이 있다: 없는 것 → 꺼진 것 → 값이 빠진 것. 뒤로 갈수록 사용자가
 * 고치기 쉬운 것이라, 앞에서 막힌 사람에게 뒤엣것을 말해 봐야 소용이 없다.
 */
export function decideGraphRunRequest(input: {
  ref: string;
  automations: Automation[];
  input?: Record<string, unknown>;
  /** 시뮬레이션은 값이 없어도 돌 수 있다 — 바깥으로 아무것도 안 나가기 때문. */
  dryRun?: boolean;
  /**
   * 누가 어떻게 부르는가. 기본은 `"queued"`(터미널·플러그인이 데스크탑에 남기는 요청).
   *
   * ★`"immediate"`는 **사람이 그 화면 앞에서 직접 누른** 실행이다. 이 둘을 같은 규칙으로
   * 다루면 안 된다: 꺼진 자동화에 대한 대기열 요청은 조용히 앉아 있다가 사용자를
   * 속이므로 거절이 맞지만, 직접 실행은 그 자리에서 바로 돌고 결과가 눈앞에 뜬다.
   * 하나로 묶어 뒀더니 제품이 스스로 모순을 만들었다(실측 2026-08-06): 새 자동화는
   * "꺼진 상태로 저장됩니다 — 직접 켜기 전에는 돌지 않습니다"라고 약속해 놓고,
   * 켜기 전에 살펴보라던 [지금 실행]·[시뮬레이션]을 바로 그 이유로 거절했다.
   * 결국 20분 크론을 **무장한 다음에야** 한 번 돌려볼 수 있었다.
   */
  mode?: "queued" | "immediate";
}): GraphRunRequestDecision {
  const found = resolveGraphRef(input.ref, input.automations);
  if (!found.ok) return found;
  const automation = found.automation;

  if (!automation.enabled && input.mode !== "immediate") {
    // ★꺼진 것을 켜 주지 않는다. 요청이 조용히 대기열에 앉으면 사용자는 실행된 줄 안다.
    // 직접 실행(mode:"immediate")은 대기열에 앉지 않으므로 이 위험이 없다.
    return {
      ok: false, code: "RUN_REQUEST_DISABLED",
      reason: `"${automation.name}"이(가) 꺼져 있어 실행 요청이 읽히지 않습니다.`,
      nextAction: "자동화를 먼저 켜 주세요.",
    };
  }

  const requirement = graphInputRequirement(automation.graph);
  const collected: Record<string, string> = {};
  if (requirement && input.dryRun !== true) {
    const raw = input.input?.[requirement.varName];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      // 값 없이 시작하면 {{구멍}}이 빈 문자열로 메꿔져, 주제 없이 지어낸 결과가
      // 정상 완료로 기록된다. 그래서 거절한다.
      return {
        ok: false, code: "RUN_REQUEST_INPUT_REQUIRED",
        reason: `"${automation.name}"은(는) 시작할 때 값을 받습니다 — ${requirement.label}.`,
        nextAction: `${requirement.varName} 값을 함께 보내 주세요.`,
      };
    }
    collected[requirement.varName] = value;
  }
  return { ok: true, automationId: automation.id, input: collected };
}
