// 체인 버스(설계 §3.4 Tier 0 #2) — 자동화 완료 이벤트를 인프로세스로 방출하는 단일
// EventEmitter. "다른 자동화 완료 시 → 이 자동화 실행"이 여기 실린다. 완전 공짜(유휴 0):
// automation-scheduler.ts runOne의 finally에서 emit 한 줄, 트리거 매니저가 구독만 한다.
//
// 프로세스 간에는 통하지 않는다(헤드리스 러너 vs GUI). 체인은 "앱 켜졌을 때만" 동작하는
// Tier 0 이벤트 소스다 — 설계가 명시한 대로 앱이 꺼지면 이벤트도 멈추는 게 정상(안전장치).
import { EventEmitter } from "node:events";

/** 자동화 완료 페이로드 — 체인 대상이 조건 평가에 쓸 최소 정보. */
export interface AutomationCompletion {
  automationId: string;
  ok: boolean;
  /** 이 실행의 최종 텍스트 출력(있으면). 체인 조건/변수에 참조 가능. */
  output?: string;
  at: string;
}

const bus = new EventEmitter();
// 많은 자동화가 같은 선행을 구독할 수 있으므로 상한을 넉넉히(경고 스팸 방지).
bus.setMaxListeners(200);

const EVENT = "automation:done";

/** 자동화가 끝났음을 방출(스케줄러 runOne finally에서 호출). */
export function emitAutomationDone(completion: AutomationCompletion): void {
  bus.emit(EVENT, completion);
}

/** 자동화 완료를 구독. 반환된 함수를 호출하면 구독 해제. */
export function onAutomationDone(handler: (c: AutomationCompletion) => void): () => void {
  bus.on(EVENT, handler);
  return () => bus.off(EVENT, handler);
}
