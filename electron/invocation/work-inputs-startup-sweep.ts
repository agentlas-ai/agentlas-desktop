import { getDb } from "../store/db";
import { listProjects } from "../store/projects";
import { sweepOrphanedWorkInputs } from "./work-attachments";

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

/** Called once at startup: the sweep runs shortly after, in the background. */
export function scheduleWorkInputsStartupSweep(delayMs = 20_000): void {
  const timer = setTimeout(() => { void sweepWorkInputsOfKnownFolders().catch(() => undefined); }, delayMs);
  timer.unref?.();
}
