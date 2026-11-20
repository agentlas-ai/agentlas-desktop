/*
 * the words of a card are drawn from the object's state NOW. This reads that state - the schedule's row,
 * the receiving conversation's title, the file's name - and nothing else, so every surface (the desktop's four, the phone through the bridge) says the same
 * thing about the same receipt. An unknown stays unknown (the field is left out), never guessed. No Electron import (the daemon reads it too), no model call, no timer.
 */
import type { ReceiptCardValue, ReceiptLive } from "../../shared/receipt-card";

export interface ReceiptLivePorts {
  automation(id: string): { enabled: boolean; scheduleHuman: string; nextRunAt: string | null; endAt?: string | null } | null;
  chatTitle(chatId: string): { title: string; project: string } | null;
  fileExists(path: string): boolean | null;
  /** The name of the project whose folder holds this file (a card of a file another project received says where it landed:. Optional: a port that cannot say leaves it out. */
  fileProject?(path: string): string | null;
  now(): number;
}

export function receiptLiveOf(value: ReceiptCardValue, ports: ReceiptLivePorts = productionPorts()): ReceiptLive {
  try {
    const ref = value.ref as Record<string, unknown>;
    if (value.kind === "schedule" && typeof ref.automationId === "string") {
      const row = ports.automation(ref.automationId);
      if (!row) return { gone: true };
      const ended = typeof row.endAt === "string" && Number.isFinite(Date.parse(row.endAt)) && Date.parse(row.endAt) < ports.now();
      return { enabled: row.enabled, scheduleText: row.scheduleHuman, nextRunAt: row.nextRunAt, ...(ended ? { ended: true } : {}) };
    }
    if (value.kind === "message" && typeof ref.toChatId === "string") {
      const to = ports.chatTitle(ref.toChatId);
      return to ? { toTitle: to.title, ...(to.project ? { toProject: to.project } : {}) } : {};
    }
    if (value.kind === "file" && typeof ref.path === "string") {
      const exists = ports.fileExists(ref.path);
      let project: string | null = null;
      try { project = ref.root === "project" ? ports.fileProject?.(ref.path) ?? null : null; } catch { project = null; }
      return { name: ref.path.split(/[\\/]/).pop() ?? "", ...(project ? { toProject: project } : {}), ...(exists === false ? { gone: true } : {}) };
    }
  } catch { /* an unreadable object leaves the card with the value's own words */ }
  return {};
}

function productionPorts(): ReceiptLivePorts {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    automation: (id) => {
      const row = (require("../store/automations") as typeof import("../store/automations")).getAutomation(id);
      return row ? { enabled: row.enabled, scheduleHuman: row.scheduleHuman, nextRunAt: row.nextRunAt ?? null, endAt: (row as { endAt?: string | null }).endAt ?? row.monitor?.deadline ?? null } : null;
    },
    chatTitle: (chatId) => {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(chatId);
      if (!chat) return null;
      let project = "";
      try { project = chat.projectId ? (require("../store/projects") as typeof import("../store/projects")).getProject(chat.projectId)?.name ?? "" : ""; } catch { project = ""; }
      return { title: chat.title ?? "", project };
    },
    fileExists: (path) => { try { return (require("node:fs") as typeof import("node:fs")).existsSync(path); } catch { return null; } },
    fileProject: (path) => {
      const rows = (require("../store/db") as typeof import("../store/db")).getDb().prepare("SELECT name, folder_path AS folder FROM projects WHERE folder_path IS NOT NULL AND folder_path <> ''").all() as Array<{ name: string; folder: string }>;
      const { rootOfPath } = require("./turn-receipts") as typeof import("./turn-receipts");
      let best: { name: string; folder: string } | null = null;
      for (const row of rows) if (rootOfPath(path, { project: row.folder }) === "project" && (!best || row.folder.length > best.folder.length)) best = row;
      return best?.name ?? null;
    },
    now: () => Date.now(),
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/** The live state of every receipt of one conversation, by receipt id: what the renderer asks for (chat:receiptLive). */
export function receiptLiveOfChat(chatId: string): Record<string, ReceiptLive> {
  const out: Record<string, ReceiptLive> = {};
  const { receiptsOfChat } = require("./turn-receipts") as typeof import("./turn-receipts"); // eslint-disable-line @typescript-eslint/no-require-imports
  for (const value of receiptsOfChat(chatId)) { const live = receiptLiveOf(value); if (Object.keys(live).length) out[value.id] = live; }
  return out;
}
