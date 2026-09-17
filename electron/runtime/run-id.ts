import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Renderer-provided channel IDs are UUID-only and may never replace an active controller. */
export function resolveInvocationRunId(
  requested: unknown,
  isActive: (runId: string) => boolean,
  generate: () => string = randomUUID,
): string {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !UUID_RE.test(requested)) {
      throw new Error("Invalid invocation runId");
    }
    if (isActive(requested)) throw new Error("Invocation runId is already active");
    return requested;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const generated = generate();
    if (UUID_RE.test(generated) && !isActive(generated)) return generated;
  }
  throw new Error("Could not allocate a unique invocation runId");
}

/**
 * Chat renderer has one stream/stop surface; reject a second live run instead of
 * making one unattachable.
 *
 * ★내는 오류에는 푸는 길이 있어야 한다 (오너 기기 로그 실측 2026-09-07).
 *   옛 문구는 "This chat already has an active invocation" 한 줄이었다. 사용자가
 *   할 수 있는 일이 무엇인지 한 글자도 없었고, 로그에는 이 오류가 3초 안에 세 번
 *   연속 찍혔다 — 그 사이 사용자는 "왜안되냐고" 를 쳤다.
 * ★내 앞선 주석 정정 (2026-09-08). 여기 "죽은 자리는 registry.reclaimDeadChatSlot 이
 *   먼저 치운다"고 적혀 있었는데 **그런 함수는 이 저장소에 없다.** 만들었다가 되돌린
 *   변경의 주석만 남은 것이다 — 되돌린 이유는 test-invocation-lifecycle 이
 *   "호스트 자식 프로세스가 살아 있는 동안의 재시도는 막아야 한다"를 옳게 요구했기 때문이다.
 *
 *   그래서 사실은 이렇다: **여기까지 온 것이 살아 있는 실행이라는 보장은 없다.**
 *   기록만 남고 실제 프로세스가 사라진 경우 이 대화는 "멈추고 다시" 를 눌러도
 *   풀리지 않을 수 있다. 그 경우의 회수 경로는 아직 없다.
 *   (주석이 있지도 않은 안전망을 약속하면 다음 세션이 그것을 믿고 딴 데를 판다.)
 */
export const INVOCATION_CHAT_BUSY_CODE = "chat_invocation_active";

export function assertInvocationChatAvailable(
  chatId: unknown,
  activeRecords: Iterable<{ chatId: string; cancelRequestedAt?: string | null }>,
): asserts chatId is string {
  if (typeof chatId !== "string" || !chatId.trim()) throw new Error("Invalid invocation chatId");
  for (const record of activeRecords) {
    if (record.chatId === chatId) {
      /*
       * ★"멈추고 다시" 는 **아직 안 멈춘 사람에게만** 맞는 말이다 (2026-09-08).
       *
       *   중지를 이미 요청했는데도 정산이 안 된 자리에 같은 문장을 내면, 사용자는 방금 한
       *   일을 또 하라는 말을 듣는다. 그리고 두 번째 중지는 "already-requested" 로 아무 일도
       *   안 한다 — 눌러도 화면이 안 변하는 그 상태가 여기서 만들어진다.
       *
       *   그때의 진짜 회수 경로는 앱을 다시 켜는 것이다. 이 잠금은 메모리 안의 명단이라
       *   다시 켜면 남지 않는다(활성 명단은 InvocationLifecycleRegistry 의 Map 이고
       *   디스크에 없다). 짐작이 아니라 자료구조에서 나오는 사실이라 안내해도 된다.
      */
      const error = new Error(
        // Electron IPC preserves the message but can discard custom Error fields.
        `${INVOCATION_CHAT_BUSY_CODE}: ` + (record.cancelRequestedAt
          ? "This chat was asked to stop, but the earlier request has not finished yet. "
            + "Wait a moment; if it never clears, reopening the app releases this chat."
          : "This chat is still running an earlier request. Stop it first, then send this one again."),
      ) as Error & { code?: string; cancelAlreadyRequested?: boolean };
      error.code = INVOCATION_CHAT_BUSY_CODE;
      error.cancelAlreadyRequested = Boolean(record.cancelRequestedAt);
      throw error;
    }
  }
}
