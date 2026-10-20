import { clearRuntimeSession, getRuntimeSession } from "../store/runtime-sessions";

/**
 * Forgets one owner's native session so that its next turn starts cold, whichever way the runtime would have resumed it: the stored row
 * (the ACP kinds keep theirs under `acp:<spec id>`, a different row from the legacy driver of the same CLI), and the resident process that
 * still holds the session in memory. A turn that returns a typed failure hands its resident process back to the pool as healthy, and the
 * next turn on that pool key resumes the very thread that failed, so deleting the row alone is not enough: an idle process is closed now,
 * one still checked out is closed when it is released. Antigravity's process key does not name its conversation (the id is stripped from the
 * argv before hashing), so its resident is retired by owner like claude's. Resident pools are loaded on use only, because their modules
 * reach back into the runner selection. Nothing here throws: closing a process never blocks forgetting the row.
 *
 * `acpAgentId` is the open ACP seat's spec id (kind "acp", e.g. github-copilot-cli); the built-in ACP kinds (kimi, grok, cursor) are their
 * own spec id.
 */
export function dropOwnerNativeSession(input: { chatId: string; kind: string; ownerId: string; acpAgentId?: string | null }): void {
  const { chatId, kind, ownerId } = input;
  let specId: string | null = null;
  let acpSessionKind: ((id: string) => string) | null = null;
  let acpModule: typeof import("./acp") | null = null;
  try {
    acpModule = require("./acp") as typeof import("./acp");
    acpSessionKind = acpModule.acpSessionKind;
    specId = kind === "acp" ? (input.acpAgentId?.trim() || null) : acpModule.ACP_PREFERRED_KINDS.has(kind) ? kind : null;
  } catch { /* the kind's own row is still cleared below */ }
  const rowKinds = specId && acpSessionKind ? (kind === "acp" ? [acpSessionKind(specId)] : [kind, acpSessionKind(specId)]) : [kind];
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
    } else if (kind === "antigravity") {
      const { antigravitySessionPool } = require("./antigravity-session") as typeof import("./antigravity-session");
      antigravitySessionPool().retireMatching((session) => session.executableOwner.chatId === chatId
        && session.executableOwner.sessionOwnerId === ownerId && session.executableOwner.isolateOwner === true);
    } else if (specId && acpModule) {
      acpModule.acpSessionPool().retireMatching((session) => session.executableOwner?.specId === specId
        && session.executableOwner.chatId === chatId && session.executableOwner.sessionOwnerId === ownerId
        && session.executableOwner.isolateOwner === true);
    }
  } catch { /* closing a process never blocks forgetting the row */ }
  for (const rowKind of rowKinds) {
    try { clearRuntimeSession(chatId, rowKind, ownerId, { isolateOwner: true }); } catch { /* the next row is still cleared */ }
  }
}
