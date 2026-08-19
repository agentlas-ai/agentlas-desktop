// 호스트 생명주기 — "이 프로세스가 곧 죽는다" 를 Electron 없이 말할 수 있게 한다.
//
// ★왜 있나 (데몬 Phase 1). 실행 중인 CLI 자식들은 호스트가 죽을 때 함께 정리돼야 한다.
// 지금 그 계약은 `app.once("will-quit", …)` 한 줄이고, 그 줄이 러너를 Electron 에
// 묶는다 — 데몬(agentlasd)에는 `app` 이 없다. 훅이 없는 채로 데몬을 띄우면 데몬이
// 죽어도 CLI 자식들이 살아남아 사용자 머신에 좀비가 쌓인다.
//
// 그래서 "종료 직전" 을 **호스트가 알려 주는 사실**로 만든다:
//  · Electron 호스트: `app.once("will-quit", runShutdownHooks)` 를 부트에서 연결.
//  · 데몬: SIGTERM/SIGINT 핸들러에서 같은 함수를 부른다.
// 러너는 어느 쪽인지 몰라도 된다 — `onHostShutdown()` 에 자기 정리를 등록만 한다.
type ShutdownHook = () => void;

const hooks = new Set<ShutdownHook>();
let ran = false;

/**
 * 호스트가 죽기 직전에 부를 정리 함수를 등록한다.
 * 반환값을 부르면 등록이 해제된다(테스트·재구성용).
 */
export function onHostShutdown(hook: ShutdownHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/**
 * 등록된 정리를 **한 번만** 전부 실행한다.
 *
 * 하나가 던져도 나머지는 돈다 — 정리 중 하나가 실패했다고 나머지 자식들을 좀비로
 * 남길 이유가 없다. 두 번 불려도(예: will-quit 과 SIGTERM 이 겹쳐도) 한 번만 돈다.
 */
export function runHostShutdownHooks(): void {
  if (ran) return;
  ran = true;
  for (const hook of hooks) {
    try {
      hook();
    } catch (error) {
      console.error("[host-lifecycle] shutdown hook failed:", error);
    }
  }
  hooks.clear();
}

/** 테스트 전용 — 같은 프로세스에서 여러 시나리오를 재려면 상태를 되돌려야 한다. */
export function __resetHostShutdownForTests(): void {
  hooks.clear();
  ran = false;
}

/** 아직 정리가 돌지 않았는가 — 진단용. */
export function hostShutdownPending(): boolean {
  return !ran;
}
