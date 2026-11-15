/*
 * The real ports behind mirror-files.ts (Agentlas 2.0 VD): where the received files go, how an outside address is opened, and how a file reaches the places the conversation's results already live.
 * Lazy requires only; Main builds it once (home.ts). A process with no app database (the background service) gets none: the mirror itself answers `no_store` there.
 *   - folder: `<userData>/generated-assets/mirror-files/<first 12 hex of sha-256 of the account id>` - `generated-assets` is one of the roots the chat-assets scope already admits (fs/access.ts GENERATED_ROOT_NAMES),
 *     so the results binder below accepts a file there the way it accepts a browser capture saved next to it (browser/native-capture-artifacts.ts does the same two steps).
 *   - placing: `bindOneRuntimeToolArtifacts` for the personal agent's own conversation (`one_artifact_bindings`, the table the "Earlier outputs" of that conversation read; its rows live 90 days). No new table.
 *   - an outside address: `openPublicHttps` (net/public-address-guard.ts) - https only, the resolved address checked and pinned, every redirect re-checked.
 *   - the quiet line for an expired file: one assistant line in that conversation, with an id that starts `hope-server:` (the mirror never sends such lines back) and is stable per file (a second try inserts nothing).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { MirrorFilesPorts, OpenedBody, PlaceResult, SignedAnswer } from "./mirror-files";
import { MIRROR_FILE_LIMITS } from "./mirror-files";

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;

export interface RealFilesDeps {
  now(): number;
  /** `POST mirror/file {epoch, id}` signed by this computer for the pointer's epoch (home.ts). */
  signedLink(id: string): Promise<SignedAnswer>;
  /** The 2.0 switch is on and this computer is the confirmed home right now. */
  mayTake(): boolean;
}

export function realMirrorFilesPorts(deps: RealFilesDeps): MirrorFilesPorts {
  const app = (): Database.Database => req<typeof import("../store/db")>("../store/db").getDb();
  const profileMod = (): typeof import("../store/one-profile") => req("../store/one-profile");
  const bundle = (): typeof import("./bundle") => req("./bundle");
  const personalChat = (): { db: Database.Database; chat: string; oneId: string } | null => {
    try {
      const db = app(); const oneId = profileMod().getOneProfile().oneId;
      const chat = bundle().boundPersonalChat(db, oneId);
      return chat ? { db, chat, oneId } : null;
    } catch { return null; }
  };
  const uiKo = (): boolean => { try { return req<typeof import("../ui-locale")>("../ui-locale").currentUiLocale() === "ko"; } catch { return false; } };

  return {
    now: deps.now,
    mayTake: deps.mayTake,
    signedLink: deps.signedLink,
    root: (userId) => {
      try {
        // the profile folder, canonical first (macOS /tmp is /private/tmp): the binder rejects a path that is an alias of an allowed root
        const base = fs.realpathSync(req<typeof import("../runtime-paths")>("../runtime-paths").userDataDir());
        return path.join(base, "generated-assets", "mirror-files", createHash("sha256").update(userId).digest("hex").slice(0, 12));
      } catch { return null; }
    },
    open: async (url, headers, signal): Promise<OpenedBody> => {
      const guard = req<typeof import("../net/public-address-guard")>("../net/public-address-guard");
      const opened = await guard.openPublicHttps(url, { signal, headerTimeoutMs: MIRROR_FILE_LIMITS.headerTimeoutMs, maxRedirects: MIRROR_FILE_LIMITS.maxRedirects, onlyPort: 443, headers: { "Accept-Encoding": "identity", ...headers } });
      return { status: opened.status, headers: opened.headers as OpenedBody["headers"], body: opened.body };
    },
    place: ({ filePath, key }): PlaceResult => {
      const target = personalChat(); if (!target) return "retry";
      const tasks = req<typeof import("../store/tasks")>("../store/tasks");
      const task = tasks.findCanonicalTaskForChat(target.chat) ?? tasks.ensureCanonicalTaskForChat(target.chat);
      if (!task) return "retry";
      const bound = req<typeof import("./artifact-preview")>("./artifact-preview").bindOneRuntimeToolArtifacts({
        taskId: task.id, taskVersion: task.version, chatId: target.chat, runId: `mirror-file:${key}`, toolId: `mirror-file:${key}`, paths: [filePath],
      });
      return bound.length === 1 ? "shown" : "refused";
    },
    unplace: (filePaths) => {
      const target = personalChat(); if (!target || filePaths.length === 0) return;
      const del = target.db.prepare("DELETE FROM one_artifact_bindings WHERE chat_id = ? AND source_path = ?");
      for (const filePath of filePaths) { try { del.run(target.chat, filePath); } catch { /* an older store without the table has nothing to remove */ } }
    },
    note: ({ key, name, bubbleAt, code }) => {
      const target = personalChat(); if (!target) return;
      const ko = uiKo();
      const text = code === "not_shown"
        ? (ko ? `'${name}' 파일은 결과 목록에서 보여 줄 수 있는 크기보다 커서 받지 않았어요.` : `The file '${name}' is larger than the results list can show, so it was not taken.`)
        : (ko ? `보관 기간이 지나서 '${name}' 파일은 받지 못했어요. 서버는 파일을 7일 동안만 둬요.` : `The file '${name}' could not be received: the server keeps a file for 7 days.`);
      const made = Date.parse(bubbleAt);
      bundle().importConversation(target.db, target.oneId, [{ id: `hope-server:file-${key}`, role: "assistant", text, createdAt: new Date((Number.isFinite(made) ? made : deps.now()) + 1).toISOString() }]);
    },
  };
}
