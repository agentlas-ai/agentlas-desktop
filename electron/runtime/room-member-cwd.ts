import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { captureRoomOwnFolderBinding, type InvocationWorkspaceBinding } from "../invocation/workspace-binding";

/*
 * Where the members of a group room that has no folder of its own work: `<userData>/agent-cwd/<room chat id>` (one folder per
 * session). Before this every such room of every agent used the one `agent-cwd`, so two rooms of the same agent wrote into each other's
 * files. The folder is made on the first member turn, shared by the members of THAT room, and removed with the room (store/chats.ts
 * removeChat). The existing contents of `agent-cwd` itself are never moved, listed or deleted by this module.
 */
// A chat id is a UUID: only a folder named like one is ever a room's own (a project folder inside agent-cwd, "dino-world", is not).
const SAFE_ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roomMemberCwdPath(roomChatId: string): string | null {
  if (!SAFE_ROOM_ID.test(roomChatId)) return null;
  const parent = path.resolve(userDataPath("agent-cwd"));
  const folder = path.resolve(parent, roomChatId);
  return path.dirname(folder) === parent ? folder : null;
}

/** Is this folder one of the rooms' own folders (`agent-cwd/<room id>`)? Such a folder is a scratch space, not a project: no map is seeded in it. */
export function isRoomMemberCwd(folder: string): boolean {
  try {
    const real = (value: string): string => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
    const resolved = real(folder);
    const name = path.basename(resolved);
    return SAFE_ROOM_ID.test(name) && path.dirname(resolved) === real(userDataPath("agent-cwd"));
  } catch { return false; }
}

/** The binding for this room's own folder (made if missing), or null when it cannot be made (the turn then uses the default run folder). */
export function roomMemberBinding(roomChatId: string): InvocationWorkspaceBinding | null {
  const folder = roomMemberCwdPath(roomChatId);
  if (!folder) return null;
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return captureRoomOwnFolderBinding(folder);
  } catch { return null; }
}

/** Removes the room's own folder. Only that one folder: a path outside `agent-cwd/<id>` is never touched. Best effort, never throws. */
export function removeRoomMemberCwd(roomChatId: string): void {
  try {
    const folder = roomMemberCwdPath(roomChatId);
    if (folder && fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
  } catch { /* a folder that cannot be removed now is left; it is the room's own and holds nothing the shared folder needs */ }
}
