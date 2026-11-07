import { getDb } from "../store/db";
import { listProjects } from "../store/projects";
import { sweepOrphanedWorkInputs } from "./work-attachments";
import { chatInputScope, sweepChatInputSpills } from "../store/chat-input-spill";
import { userDataPath } from "../runtime-paths";

/**
 * At the app's start, remove the attachment copies a stopped process left in the folders Work runs use (work-attachments.ts). Staging
 * only looks at the folder of the next attachment run, so without this a private copy of an owner's file could sit in a project folder
 * for as long as the owner never attaches again there. Never throws, never delays startup, and gives up on a folder that does not
 * answer (an unmounted network drive) instead of waiting on it.
 */
const MAX_FOLDERS = 200;
const FOLDER_TIMEOUT_MS = 5_000;
const MAX_UNRESPONSIVE_FOLDERS = 3;

/** Folders a Work run can stage inputs in: every project folder and the working folder of the most recent chats. */
export function workInputFolders(): string[] {
  const folders = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) folders.add(value); };
  try { for (const project of listProjects()) add(project.folderPath); } catch { /* no projects table yet */ }
  try {
    for (const row of getDb().prepare("SELECT DISTINCT working_folder AS folder FROM chats WHERE working_folder IS NOT NULL AND working_folder <> '' ORDER BY updated_at DESC LIMIT ?").all(MAX_FOLDERS) as Array<{ folder: string }>) add(row.folder);
  } catch { /* no chats table yet */ }
  return [...folders].slice(0, MAX_FOLDERS);
}

export async function sweepWorkInputsOfKnownFolders(
  options: { folders?: string[]; sweep?: typeof sweepOrphanedWorkInputs; timeoutMs?: number } = {},
): Promise<{ folders: number; removed: number; unresponsive: number }> {
  const sweep = options.sweep ?? sweepOrphanedWorkInputs;
  const timeoutMs = options.timeoutMs ?? FOLDER_TIMEOUT_MS;
  const summary = { folders: 0, removed: 0, unresponsive: 0 };
  for (const folder of options.folders ?? workInputFolders()) {
    if (summary.unresponsive >= MAX_UNRESPONSIVE_FOLDERS) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        sweep(folder, { force: true }),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }), // cleared below; the wait is bounded
      ]);
      if (outcome === "timeout") { summary.unresponsive += 1; continue; }
      summary.folders += 1; summary.removed += outcome.removed;
    } catch { /* one folder never stops the rest */ }
    finally { if (timer) clearTimeout(timer); }
    await new Promise<void>((resolve) => setImmediate(resolve)); // one folder at a time, the event loop in between
  }
  return summary;
}

/**
 * The same folders also hold the oversized inputs kept as files (store/chat-input-spill.ts); the ones no stored conversation owns and
 * nobody touched for ORPHAN_TTL_MS go. It takes the folder list the work-input sweep already built (no second walk of the stores), each
 * folder's wait is bounded and three folders that do not answer end the sweep, exactly like the work-input sweep. One folder at a time,
 * the event loop in between. Never throws.
 */
export async function sweepChatInputSpillsOfKnownFolders(folders: readonly string[]): Promise<number> {
  let removed = 0, unresponsive = 0;
  try {
    const live = new Map((getDb().prepare("SELECT id, updated_at AS updatedAt FROM chats").all() as Array<{ id: string; updatedAt: string | null }>)
      .map((row) => [chatInputScope(row.id), Date.parse(row.updatedAt ?? "") || Date.now()] as const)); // an unreadable clock counts as active
    for (const folder of folders) {
      if (unresponsive >= MAX_UNRESPONSIVE_FOLDERS) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([sweepChatInputSpills(folder, live), new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), FOLDER_TIMEOUT_MS); })]); // cleared below; the wait is bounded
        if (outcome === "timeout") unresponsive += 1; else removed += outcome;
      } finally { if (timer) clearTimeout(timer); }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch { /* no chats table yet: nothing is judged an orphan */ }
  return removed;
}

/** Called once at startup: the sweep runs shortly after, in the background. */
export function scheduleWorkInputsStartupSweep(delayMs = 20_000): void {
  const timer = setTimeout(() => {
    const folders = workInputFolders();
    void sweepWorkInputsOfKnownFolders({ folders }).then(() => sweepChatInputSpillsOfKnownFolders([...folders, userDataPath("agent-cwd")])).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
}
