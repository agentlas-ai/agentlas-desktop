// 체인 버스(설계 §3.4 Tier 0 #2) — durable scheduler terminal receipt가 이미
// downstream outbox fan-out과 한 SQLite transaction으로 커밋된 뒤 GUI pump를 즉시 깨우는
// 인프로세스 가속 신호. EventEmitter는 체인의 source of truth가 아니며, 헤드리스/재시작은
// terminal receipt + stable dedupe scanner로 같은 occurrence를 복원한다.
import { EventEmitter } from "node:events";

/** 자동화 완료 페이로드 — 체인 대상이 조건 평가에 쓸 최소 정보. */
export interface AutomationCompletion {
  automationId: string;
  ok: boolean;
  /** Stable run receipt used to deduplicate downstream chain deliveries. */
  runId?: string;
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
