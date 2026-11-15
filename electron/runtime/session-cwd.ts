import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";

/*
 * The folder a session that has no project (and no folder chosen yet) works in: `<userData>/agent-cwd/<chat id>` (Agentlas 2.0
 * §3.5). Before this every such session of every agent used the one `agent-cwd`, so two sessions wrote into each other's files.
 *
 * Who reads it: invocation/service.ts decides `executionCwd` with this as the last choice before the shared folder.
 * When it goes: store/chats.ts removeChat removes `agent-cwd/<chat id>` with the chat (`removeSessionCwd`); nothing else deletes it.
 *
 * Which sessions get one: only a session that has not answered yet. A conversation that already has an answer keeps working in the shared
 * folder — a CLI runtime resumes its own session by working folder, and files the earlier turns made are named relative to it — so an
 * update never moves a running conversation. Once the folder exists the session keeps it for good (the folder is the record of the choice).
 * The contents of `agent-cwd` itself are never moved, listed or deleted here. Same path rule as runtime/room-member-cwd.ts, so a group
 * room's own chat id names one folder for the room lead and its members alike.
 */
const SAFE_CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function sessionCwdPath(chatId: string): string | null {
  if (typeof chatId !== "string" || !SAFE_CHAT_ID.test(chatId)) return null;
  const parent = path.resolve(userDataPath("agent-cwd"));
  const folder = path.resolve(parent, chatId);
  return path.dirname(folder) === parent ? folder : null;
}

/** The session's own folder (made on first use), or null: the caller then uses the shared run folder as before. Never throws. */
export function noProjectSessionCwd(chatId: string, hasAnswered: (chatId: string) => boolean): string | null {
  const folder = sessionCwdPath(chatId);
  if (!folder) return null;
  try {
    if (fs.existsSync(folder)) return folder;
    if (hasAnswered(chatId)) return null;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  } catch { return null; }
}

/** Removes the session's own folder, and only that one: a path outside `agent-cwd/<id>` is never touched. Best effort, never throws. */
export function removeSessionCwd(chatId: string): void {
  try {
    const folder = sessionCwdPath(chatId);
    if (folder && fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
  } catch { /* a folder that cannot be removed now is the session's own and holds nothing the shared folder needs */ }
}

/**
 * Whether [folder] is the app's own work folder: `<userData>/agent-cwd` itself (the one folder every folder-less run used before) or a
 * folder under it (a session's `agent-cwd/<chat id>`). The root is the same constant the folders are made from (sessionCwdPath above,
 * runtime/exec.ts agentRunCwd), never a guess from a path's look. Such a folder is the app's, not the owner's: an approval card says
 * nothing about it (the phone and the Desktop card leave the "Folder" line out). Never throws.
 */
export function isAppWorkFolder(folder: string | null | undefined): boolean {
  if (typeof folder !== "string" || !folder.trim()) return false;
  try {
    const real = (value: string): string => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
    const root = real(userDataPath("agent-cwd"));
    const target = real(folder);
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch { return false; }
}
