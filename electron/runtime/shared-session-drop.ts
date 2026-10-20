import { clearRuntimeSession, getRuntimeSession } from "../store/runtime-sessions";

/**
 * Forgets one owner's native session so that its next turn starts cold, whichever way the runtime would have resumed it: the stored row
 * (the ACP kinds keep theirs under `acp:<kind>`, a different row from the legacy driver of the same CLI), and the resident process that
 * still holds the session in memory. A turn that returns a typed failure (a refusal, an empty answer, a quota notice) releases its resident
 * process to the pool as healthy, and the next turn on that pool key resumes the very thread that failed, so deleting the row alone is not
 * enough. An idle process is closed now; one still checked out is closed when it is released. Resident pools are loaded on use only, because
 * their modules reach back into the runner selection.
 *
 * Antigravity needs no pool step: its process key names the conversation it was started with, so a cleared row makes the next turn's key
 * differ and an idle process under the old key is never matched again.
 */
export function dropOwnerNativeSession(input: { chatId: string; kind: string; ownerId: string }): void {
  const { chatId, kind, ownerId } = input;
  const acp = require("./acp") as typeof import("./acp");
  const acpKind = acp.ACP_PREFERRED_KINDS.has(kind);
  const rowKinds = acpKind ? [kind, acp.acpSessionKind(kind)] : [kind];
  const nativeIds = new Set<string>();
  for (const rowKind of rowKinds) {
    try {
      const id = getRuntimeSession(chatId, rowKind, ownerId, { isolateOwner: true })?.sessionId;
      if (id) nativeIds.add(id);
    } catch { /* a row that cannot be read is still cleared below */ }
  }
  try {
    if (kind === "claude-code") {
      const { claudeSessionPool } = require("./claude-session") as typeof import("./claude-session");
      claudeSessionPool().retireMatching((session) => session.executableOwner.chatId === chatId
        && session.executableOwner.sessionOwnerId === ownerId && session.executableOwner.isolateOwner === true);
    } else if (kind === "codex") {
      const { codexSessionPool } = require("./codex-session") as typeof import("./codex-session");
      if (nativeIds.size) codexSessionPool().retireMatching((session) => session.threadId !== null && nativeIds.has(session.threadId));
    } else if (acpKind) {
      acp.acpSessionPool().retireMatching((session) => session.executableOwner?.specId === kind
        && session.executableOwner.chatId === chatId && session.executableOwner.sessionOwnerId === ownerId
        && session.executableOwner.isolateOwner === true);
    }
  } catch { /* closing a process never blocks forgetting the row */ }
  for (const rowKind of rowKinds) clearRuntimeSession(chatId, rowKind, ownerId, { isolateOwner: true });
}
