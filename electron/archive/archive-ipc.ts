// IPC for the Archive screen (Settings → storage): the list with folder sizes, the on/off switch and the restore button.
//   archive:state    ()                -> ArchiveState
//   archive:setAuto  (enabled)         -> ArchiveState
//   archive:restore  (agentId)         -> ArchiveState
import fs from "node:fs";
import path from "node:path";
import type { IpcMain } from "electron";
import { registerAppControlDomainIpc } from "../app-control/ipc-registry";
import { getDb } from "../store/db";
import { getRoute } from "../agents/routes";
import type { ArchiveState, ArchivedAgentRow } from "../../shared/archive";
import {
  AUTO_ARCHIVE_UNUSED_DAYS, autoArchiveEnabled, listArchivedAgents, restoreAgentForUse, setAutoArchiveEnabled,
} from "./auto-archive";

/** Total bytes under a folder; unreadable entries count as 0 and symbolic links are not followed. */
async function folderBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { pending.push(full); continue; }
      try { total += (await fs.promises.stat(full)).size; } catch { /* vanished while scanning */ }
    }
  }
  return total;
}

export async function archiveState(): Promise<ArchiveState> {
  const archived = listArchivedAgents();
  const names = new Map<string, string>();
  for (const row of getDb().prepare("SELECT id, name, local_display_name AS localName FROM installed_agents").all() as Array<{ id: string; name: string; localName: string | null }>) {
    names.set(row.id, row.localName?.trim() || row.name);
  }
  const items: ArchivedAgentRow[] = [];
  for (const [agentId, record] of Object.entries(archived)) {
    const folder = getRoute(agentId)?.path;
    items.push({
      agentId, name: names.get(agentId) ?? agentId, archivedAt: record.archivedAt, reason: record.reason, lastUsedAt: record.lastUsedAt,
      sizeBytes: folder ? await folderBytes(folder) : null,
    });
  }
  items.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.archivedAt.localeCompare(b.archivedAt));
  return { autoEnabled: autoArchiveEnabled(), unusedDays: AUTO_ARCHIVE_UNUSED_DAYS, items, totalBytes: items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) };
}

export function registerArchiveIpc(ipc: Pick<IpcMain, "handle">): void {
  registerAppControlDomainIpc(ipc, "archive:state", () => archiveState());
  registerAppControlDomainIpc(ipc, "archive:setAuto", (enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new TypeError("archive_switch_invalid");
    setAutoArchiveEnabled(enabled);
    return archiveState();
  });
  registerAppControlDomainIpc(ipc, "archive:restore", (agentId: unknown) => {
    if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 256) throw new TypeError("archive_agent_invalid");
    restoreAgentForUse(agentId);
    return archiveState();
  });
}
