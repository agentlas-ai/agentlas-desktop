import type { ServerAppsPorts } from "./server-apps";
import type { MirrorFiles } from "./mirror-files";

/*
 * Main's real ports for the connected apps of the server (server-apps.ts): the three things only Main can answer. Electron-free except through the stores it already
 * loads for the rest of the home (the app database). Loaded only where the mirror's real store is (Main); the background service never loads it.
 *   computerHas  the connectors this computer holds itself: installed, switched on, and their keys present (value-free presence, harness/connector-presence.ts). Only a
 *                "ready" connector hides the same app of the server (the computer's wins, one line only); an unverified or keyless one leaves both visible (the safe side).
 *   files        VD's mirror-files entry (a result's files take the same road as a bubble's, every address rule included).
 *   attach       a finished long job: one quiet display row (the fact and the tool's name) in the personal agent's conversation it was started in; the model reads the result through status.
 */
export function realServerAppsExtras(own: { files(): MirrorFiles | null }): Pick<ServerAppsPorts, "computerHas" | "files" | "attach"> {
  return {
    computerHas: async () => {
      const ids = new Set<string>();
      try {
        const { listInstalledServers } = await import("../mcp-tools/registry");
        const { connectorCredentialPresence } = await import("../harness/connector-presence");
        for (const server of listInstalledServers()) {
          if (!server.enabled || server.configurationValid === false || !server.catalogId) continue;
          const presence = connectorCredentialPresence({ serverId: server.id, transport: server.transport, envKeys: server.envKeys, credentialRefs: (server as { credentialRefs?: Record<string, string> | null }).credentialRefs ?? null });
          if (presence.credentialState === "ready") ids.add(server.catalogId);
        }
      } catch { /* a registry that cannot be read hides nothing */ }
      return ids;
    },
    files: () => { const files = own.files(); return files ? { plan: (userId, items) => files.plan(userId, items), drain: (userId) => files.drain(userId) } : null; },
    attach: (task) => {
      try {
        // A finished job is told to the owner as ONE display row (a 'view' system row, store/chats.ts recordViewNoticeRow): the fact and the tool's name, never the app's words. The row is not
        // the model's history (listChatMessages leaves 'view' rows out, as for the closed-approval line); the model reads the result by asking server_apps_status. Stable id per job, so a second sweep
        // writes nothing. A One conversation hides plain system rows, so it carries the seat marker the phone and the window already open.
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        const chats = require("../store/chats") as typeof import("../store/chats");
        const { seatEventText } = require("../../shared/one-seat-events") as typeof import("../../shared/one-seat-events");
        const { currentUiLocale } = require("../ui-locale") as typeof import("../ui-locale");
        const tool = task.tool.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
        const line = currentUiLocale() === "ko" ? `연결된 앱의 작업이 끝났어요: ${tool}` : `A connected app finished a job: ${tool}`;
        chats.recordViewNoticeRow({ id: `${chats.SERVER_APP_DONE_ROW_PREFIX}${createHash("sha256").update(task.callId).digest("hex").slice(0, 16)}`, chatId: task.chatId,
          text: chats.chatOriginSurface(task.chatId) === "one" ? seatEventText(line) : line, createdAt: new Date().toISOString() });
      } catch { /* the notice is a courtesy: the job's end stays readable through status until its 24 hours pass */ }
    },
  };
}
