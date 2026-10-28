/**
 * The owner line for an automatic continuation the host could not start. Pure (no Electron, Node or renderer import), so
 * Main, the daemon and a re-vendored core write the same sentence; the desktop and the phone both draw it, because it is
 * stored as a visible host notice (host-status "needs-owner", or an automation report).
 *
 * Every continuation the host promises ("after sign-in the remaining steps continue", "full access approved, finishing the
 * blocked work", "the automation continues once the login is restored") either starts or says here, with the machine cause
 * and the one step that always works, that it did not. Before, a refused continuation was a log line only: the Mobile turn
 * whose sign-in was verified (2026-10-28 06:07Z, YouTube room) and the two approved full-access continuations refused while
 * the Goal waited for that very answer (2026-10-27 01:31Z and 05:02Z, same room) left the room on its last line for hours.
 *
 * The cause is the refusal's typed code, never prose; anything that is not a bounded machine code is written "unknown".
 */
export type RefusedContinuation = "browser-login" | "permission-escalation" | "graph-login";

/** The notice code each refused continuation publishes (run event notice.code). */
export const CONTINUATION_REFUSED_NOTICE_CODE: Readonly<Record<RefusedContinuation, string>> = Object.freeze({
  "browser-login": "browser-login-resume-refused",
  "permission-escalation": "permission-escalation-resume-refused",
  "graph-login": "graph-login-resume-refused",
});

/** A bounded machine code, or "unknown". */
export function continuationRefusalCause(code: unknown): string {
  return typeof code === "string" && /^[a-z0-9][a-z0-9_.:-]{0,119}$/i.test(code) ? code : "unknown";
}

export function continuationRefusalNotice(input: {
  continuation: RefusedContinuation;
  cause: unknown;
  locale: "ko" | "en";
  /** graph-login only: the automation's own name. */
  automationName?: string;
}): { code: string; cause: string; message: string } {
  const cause = continuationRefusalCause(input.cause);
  const ko = input.locale === "ko";
  const name = (input.automationName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  let message: string;
  switch (input.continuation) {
    case "browser-login":
      message = ko
        ? `로그인은 확인됐지만 이 작업을 자동으로 이어가지 못했습니다 (원인: ${cause}). 메시지를 보내면 이어서 진행합니다.`
        : `Sign-in was verified, but this task could not continue on its own (cause: ${cause}). Send a message to continue.`;
      break;
    case "permission-escalation":
      message = ko
        ? `전체 권한 승인은 받았지만 막혔던 작업을 자동으로 이어가지 못했습니다 (원인: ${cause}). 메시지를 보내면 이어서 진행합니다.`
        : `Full access was approved, but the blocked work could not continue on its own (cause: ${cause}). Send a message to continue.`;
      break;
    case "graph-login":
      message = ko
        ? `로그인은 확인됐지만 자동화${name ? ` "${name}"` : ""}를 자동으로 이어가지 못했습니다 (원인: ${cause}). 자동화에서 지금 실행을 누르면 다시 실행합니다.`
        : `Sign-in was verified, but the automation${name ? ` "${name}"` : ""} could not continue on its own (cause: ${cause}). Use Run now on the automation to run it again.`;
      break;
  }
  return { code: CONTINUATION_REFUSED_NOTICE_CODE[input.continuation], cause, message };
}
