/**
 * 중단된 스트림 본문에 붙는 표식 — 순수 함수(게이트가 직접 호출한다).
 *
 * ★중단된 스트림은 중단됐다고 적힌 채로 남아야 한다.
 *
 * 취소·실패로 끝난 실행의 스트리밍 본문은 보존한다(그 자체가 사용자가 이미 본 작업이다).
 * 그런데 표식 없이 저장하면 마지막 문단이 곧 최종 답으로 읽힌다. 런 원장이
 * `runner-failed`(hasFinalText=false)를 적고 있는데 대화창만 완료처럼 보이는 상태가 되고,
 * 그 차이는 사용자가 결과를 신뢰할지 다시 돌릴지를 정반대로 만든다.
 *
 * U+FFFD는 별도 사실이다 — agy의 text_delta는 UTF-8 바이트 경계에서 찢겨 양쪽 조각이
 * 대체 문자가 된다(원본 바이트 소실이라 접합 쪽 복원 불가). 정상 종료 경로는 최종
 * result.response를 정본으로 써서 이를 피하지만, 중단 경로에는 그 정본이 없다.
 * 고칠 수 없다면 최소한 깨졌다고 말한다.
 */
export function markInterruptedPartial(text: string, locale: string): string {
  const corrupted = text.includes("�");
  const banner = locale === "ko"
    ? [
      "> ⚠️ **중단된 답변입니다 — 완료된 결과가 아닙니다.**",
      "> 아래는 실행이 끝나기 전까지 스트리밍된 부분 내용이며, 검증되지 않았습니다.",
      ...(corrupted ? ["> 전송 중 일부 글자가 깨졌습니다(`�`)."] : []),
    ]
    : [
      "> ⚠️ **Interrupted answer — this is not a completed result.**",
      "> Below is the partial text streamed before the run ended. It was not finished or verified.",
      ...(corrupted ? ["> Some characters were corrupted in transit (`�`)."] : []),
    ];
  return `${banner.join("\n")}\n\n${text}`;
}

/** True when the text already carries the banner (either language). */
export function isInterruptedPartial(text: string): boolean {
  return /^> ⚠️ \*\*(중단된 답변입니다|Interrupted answer)/.test(text);
}

/**
 * ★이미 저장한 글을 "중단된 답변"으로 한 번 더 저장하지 않는다.
 *
 * 실측(2026-09-27, One "X 마케팅", 1.2.45): 목표 연속 실행의 1턴 본문이 끝나자 client가
 * 그 본문을 대화 행으로 곧바로 저장했다(10:49:51). 2턴이 아직 한 글자도 흘리지 않은 6초 뒤
 * 오너의 새 지시가 실행을 끊었고, Main의 실시간 버퍼(record.partialText)에는 **이미 저장한
 * 1턴 본문**이 그대로 남아 있었다. 그래서 같은 글이 "⚠️ 중단된 답변입니다" 머리를 달고
 * 확인 답 **뒤에** 한 번 더 저장됐다(10:49:58) — 순서가 뒤집힌 중복.
 *
 * 규칙: 턴 본문을 대화 행으로 확정한 순간 client는 이 경계 이벤트를 보낸다. 빈 전문 +
 * 확정된 행 id. Main은 빈 전문을 받아 버퍼를 비우고(중단 저장 대상이 사라진다),
 * 화면은 지금까지 흘린 글을 그 행 id로 굳히고 새 말풍선을 연다.
 */
export interface LivePartialCommitBoundary {
  kind: "partial";
  text: "";
  durableMessageId: string;
}

export function livePartialCommitBoundary(durableMessageId: string): LivePartialCommitBoundary {
  return { kind: "partial", text: "", durableMessageId };
}

export function isLivePartialCommitBoundary(event: {
  kind?: string;
  text?: string;
  delta?: string;
  durableMessageId?: string;
  agentId?: string;
}): event is LivePartialCommitBoundary {
  return event.kind === "partial"
    && !event.agentId
    && typeof event.durableMessageId === "string"
    && event.durableMessageId.length > 0
    && typeof event.delta !== "string"
    && event.text === "";
}

/**
 * Main의 실시간 본문 버퍼 한 걸음. partial의 `text`는 누적 전문이다.
 * - 이어 붙은 글이면 델타만 보낸다(`delta`), 새로 늘어난 게 없으면 버린다(`drop`).
 * - 이어 붙지 않으면(다음 턴·경계·재동기화) 전문을 보낸다(`delta: null`).
 * 반환한 `partialText`가 곧 중단 시 저장 후보다 — 경계 뒤에는 비어 있다.
 */
export function advanceMainLivePartial(previous: string, full: string): {
  partialText: string;
  delta: string | null;
  drop: boolean;
} {
  const probe = Math.min(32, previous.length);
  const appended =
    full.length >= previous.length &&
    (probe === 0 || full.slice(previous.length - probe, previous.length) === previous.slice(-probe));
  if (appended) {
    const delta = full.slice(previous.length);
    return { partialText: full, delta, drop: !delta };
  }
  return { partialText: full, delta: null, drop: false };
}
