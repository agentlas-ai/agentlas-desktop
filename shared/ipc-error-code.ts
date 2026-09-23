/*
 * 기계 코드는 IPC 를 건너야 한다.
 *
 * ★2026-09-23 감사 — Electron 은 ipcMain.handle 핸들러가 던진 오류에서 message 만 넘긴다
 *   (`Error invoking remote method '<ch>': Error: <message>`). OneTeamPreflightError·
 *   OneAttachmentError·MobileBridgePairingError·MemoryRevokedError 등이 실은 `.code` 는
 *   화면에 한 번도 도착하지 않았다. 그래서 One 의 "이미 처리됨" 같은 무해한 경합
 *   (already_resolved)이 코드 없이 보여 운영 복구(requestOneOperationalRecovery)로 번졌다.
 *
 *   규칙: Main 의 단일 IPC 경계(developmentIpcBoundary)가 문자열 `code` 를 가진 오류를
 *   `[agentlas:code=<code>] <message>` 로 다시 던진다. 화면의 모든 코드 판정은
 *   ipcErrorCode(err) 하나로 읽는다. 사용자 내용은 코드에 들어가지 않는다.
 */

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const PREFIX_RE = /\[agentlas:code=([A-Za-z][A-Za-z0-9_.:-]{0,95})\]\s?/;

export function isIpcErrorCode(value: unknown): value is string {
  return typeof value === "string" && CODE_RE.test(value);
}

/** Main: message that carries the code across Electron IPC. Idempotent. */
export function encodeIpcErrorMessage(code: string, message: string): string {
  if (PREFIX_RE.test(message)) return message;
  return `[agentlas:code=${code}] ${message}`;
}

/** Own `.code` first (same-process errors), then the IPC prefix in the message. */
export function ipcErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const own = (error as { code?: unknown }).code;
    if (isIpcErrorCode(own)) return own;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  return PREFIX_RE.exec(message)?.[1];
}

/** Human text without Electron's "Error invoking remote method" wrapper or the code prefix. */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .replace(PREFIX_RE, "")
    .trim();
}
