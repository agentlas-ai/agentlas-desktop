// 실행 우선순위 — "사람이 지금 기다리고 있는가"를 실행 경로 전체에 흘려보내는 단일 통로.
//
// ★왜 있나. 전역 실행 슬롯(run-slots.ts)은 FIFO 하나뿐이라, 자동화/그래프/스웜이 슬롯을
// 다 차지하면 사람이 방금 보낸 채팅 턴이 그 뒤에 줄을 선다 — 사람은 "앱이 멈췄다"로 읽는다.
// 우선순위를 요청 객체에 실어 나르려면 run-graph.ts 내부(다른 세션이 편집 중이라 접근 금지)
// 를 지나야 하는 경로가 있으므로, AsyncLocalStorage 로 **호출 문맥**에 싣는다: 자동화
// 스케줄러가 자기 실행을 background 로 감싸면, 그 안에서 스폰되는 모든 러너/자식이
// 코드 변경 없이 같은 우선순위를 물려받는다.
//
// 소비자 두 곳:
//  - run-slots.ts  — background 대기자는 interactive 대기자 뒤로 밀린다(2단 큐).
//  - exec.ts       — 자식 CLI nice 를 차등한다(interactive 2, background 10).
//
// 이 모듈은 의도적으로 의존성이 0이다(exec ↔ run-slots ↔ store 순환을 만들지 않기 위해).
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * owner — the owner's own message (One/Work chat, mobile, Telegram) and the model calls of that turn itself (its main call,
 * a root firm's controller, judgment/router/repair steps). Delegated work the turn starts — a firm/swarm/task-force worker,
 * planner or synthesis, the memory curator, a build — is not the owner's message: it runs interactive. It is admitted ahead
 * of everything and may take one reserved slot above the limit while other work holds the slots, so a message never waits
 * behind automation or teammates (native-harness notyet NH20). interactive — anything else a person may be watching (the
 * default). background — unattended entry points that wrap themselves (automation scheduler, daemon graph.run).
 */
export type RunPriority = "owner" | "interactive" | "background";

const priorityContext = new AsyncLocalStorage<RunPriority>();

/**
 * fn 과 그 안에서 시작되는 모든 비동기 작업을 주어진 우선순위로 표시한다.
 * 자동화 스케줄러·데몬 graph.run 처럼 "사람이 안 기다리는" 진입점이 background 로 감싼다.
 */
export function withRunPriority<T>(priority: RunPriority, fn: () => T): T {
  return priorityContext.run(priority, fn);
}

/**
 * 현재 문맥의 우선순위. 표시가 없으면 interactive — 사람이 기다리는 채팅 턴이
 * 기본이고, background 는 명시적으로 감싼 경로에서만 나온다(조용한 강등 금지).
 */
export function currentRunPriority(): RunPriority {
  return priorityContext.getStore() ?? "interactive";
}

/**
 * The slot priority of one invocation: the owner's own words (not a product-sent continuation, not a teammate report, no
 * unattended execution source except the owner's mobile/Telegram channels) are "owner". Any other invocation started inside
 * an owner turn (a teammate dispatch, a room wake) does not inherit the owner lane: it falls back to interactive; background
 * stays background.
 */
export function invocationRunPriority(input: {
  promptOrigin?: "user" | "system";
  oneTeamReportTurn?: boolean;
  source?: string;
}, inherited: RunPriority = currentRunPriority()): RunPriority {
  const ownerChannel = input.source === undefined || input.source === "mobile" || input.source === "telegram";
  if (input.promptOrigin !== "system" && !input.oneTeamReportTurn && ownerChannel) return "owner";
  return inherited === "owner" ? "interactive" : inherited;
}

/** Model-call roles (model-call-ledger ModelCallRole) that are delegated work, never the owner's own turn. */
const DELEGATED_ROLES: ReadonlySet<string> = new Set(["worker", "planner", "synthesis", "curator", "build"]);

/**
 * The slot lane of one model call: the owner lane stays with the owner's own turn; a delegated call made inside it (its
 * model-call scope names a worker/planner/synthesis/curator/build role) falls back to interactive, so a firm or swarm the
 * owner's message started cannot fill the owner lane ahead of the owner's next message (native-harness notyet NH20).
 */
export function slotPriorityForCall(priority: RunPriority, role: string | undefined): RunPriority {
  return priority === "owner" && role !== undefined && DELEGATED_ROLES.has(role) ? "interactive" : priority;
}

/**
 * 자식 CLI 에 줄 nice 값. interactive 도 0 이 아니라 2 를 준다 — UI/메인 프로세스가
 * 항상 자식보다 응답성이 높아야 하기 때문(기존 일괄 5 에서 분화: 2 vs 10).
 */
export function nicenessForPriority(priority: RunPriority): number {
  return priority === "background" ? 10 : 2;
}
