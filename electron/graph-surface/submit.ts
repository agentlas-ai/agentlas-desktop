/**
 * 커넥터 C47·C48 — 바깥에서 온 실행 요청을 **하나의 문**으로 들여보낸다.
 *
 * 문 자체(`shared/graph-run-request.ts`)는 "켜도 되는가"만 판단한다. 여기는 그 판단을
 * 가져다 쓰고, 통과한 요청을 **실행하는 대신 대기열에 적는다**.
 *
 * 왜 여기서 직접 실행하지 않나: 그래프를 도는 것은 실행 중인 Agentlas 프로세스의 일이다
 * (에이전트 세션·런타임·도구가 거기 있다). 바깥 요청이 자기 프로세스에서 그래프를 돌리려
 * 하면 같은 자동화가 두 곳에서 동시에 돌 수 있다. 대기열(automation_trigger_events)은 이미
 * 클레임·리스·중복 제거를 갖고 있으므로, 요청은 거기 적고 실행은 소유자가 한다.
 *
 * ★거절은 문이 만든 코드·사유·행동을 **그대로** 내보낸다. 바깥 표면이 자기 말로 바꿔 쓰면
 * 같은 실패가 입구마다 다르게 보이고, 이 커넥터가 없애려던 바로 그 상태로 돌아간다.
 */
import { randomUUID } from "node:crypto";
import { decideGraphRunRequest } from "../../shared/graph-run-request";
import { listAutomations } from "../store/automations";
import { enqueueTriggerEvent } from "../store/trigger-events";

export type GraphSurfaceSource = "sdk" | "mcp" | "telegram";

export type GraphSubmitResult =
  | { ok: true; automationId: string; automationName: string; eventId: string; input: Record<string, string> }
  | { ok: false; code: string; reason: string; nextAction: string };

export function submitGraphRunRequest(request: {
  ref: string;
  input?: Record<string, unknown>;
  dryRun?: boolean;
  source: GraphSurfaceSource;
}): GraphSubmitResult {
  const automations = listAutomations();
  const decision = decideGraphRunRequest({
    ref: request.ref,
    automations,
    ...(request.input ? { input: request.input } : {}),
    ...(request.dryRun ? { dryRun: true } : {}),
  });
  if (!decision.ok) return decision;

  const automation = automations.find((row) => row.id === decision.automationId)!;
  const eventId = randomUUID();
  try {
    enqueueTriggerEvent({
      id: eventId,
      automationId: decision.automationId,
      triggerKind: "command",
      // 같은 요청을 두 번 보내도 두 번 돌지 않게 하는 열쇠. 요청마다 새로 만드는 이유:
      // 바깥에서 "같은 요청"을 판정할 근거가 없다 — 같은 값으로 두 번 돌리는 것이
      // 정당한 경우가 있다(사람이 다시 눌렀다). 중복 제거는 재전송 사고만 막는다.
      dedupeKey: `graph-surface:${request.source}:${eventId}`,
      payload: {
        source: request.source,
        input: decision.input,
        ...(request.dryRun ? { dryRun: true } : {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      code: "RUN_REQUEST_QUEUE_UNAVAILABLE",
      reason: `실행 요청을 대기열에 적지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      nextAction: "Agentlas가 실행 중인지 확인한 뒤 다시 보내 주세요.",
    };
  }
  return {
    ok: true,
    automationId: decision.automationId,
    automationName: automation.name,
    eventId,
    input: decision.input,
  };
}

/** 바깥에 보여줄 그래프 목록. 실행 권한이 아니라 **부를 수 있는 이름**을 알려주는 것이다. */
export function listGraphsForSurface(): Array<{
  id: string;
  name: string;
  enabled: boolean;
  description: string;
}> {
  return listAutomations().map((row) => ({
    id: row.id,
    name: row.name,
    // ★꺼진 것도 보여준다. 목록에서 감추면 부른 쪽은 "없는 자동화"라는 잘못된 사유를 받는다.
    enabled: row.enabled,
    description: row.scheduleHuman ? `${row.scheduleHuman}에 도는 자동화` : "자동화",
  }));
}
