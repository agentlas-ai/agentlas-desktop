/*
 * the durable objects of one conversation: schedules it registered, waits it is owed an answer for, its Goal's wait. Read-only, rows only,
 * no model call and no timer; a conversation with none returns an empty list. The list is the conversation's "scheduled" strip on every surface.
 */
import type { PendingPromiseItem, PendingPromises } from "../../shared/pending-promises";

export interface PendingPromisePorts {
  schedules(chatId: string): Array<{ id: string; name: string; enabled: boolean; nextRunAt: string | null }>;
  waits(chatId: string): Array<{ id: string; targetTitle: string; expiresAt: number }>;
  goalWait(chatId: string): { goalId: string; at: string; cause: string } | null;
}

export function pendingPromisesOfChat(chatId: string, ports: PendingPromisePorts = productionPorts()): PendingPromises {
  const items: PendingPromiseItem[] = [];
  try { for (const row of ports.schedules(chatId)) items.push({ kind: "schedule", id: row.id, at: row.enabled ? row.nextRunAt : null, enabled: row.enabled, label: row.name }); } catch { /* an unreadable list is an empty one, never a made-up one */ }
  try { for (const row of ports.waits(chatId)) items.push({ kind: "wait", id: row.id, at: new Date(row.expiresAt).toISOString(), label: row.targetTitle }); } catch { /* same */ }
  try { const wait = ports.goalWait(chatId); if (wait) items.push({ kind: "goal-wait", id: wait.goalId, at: wait.at, label: wait.cause }); } catch { /* same */ }
  return { chatId, items };
}

function productionPorts(): PendingPromisePorts {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    schedules: (chatId) => (require("../store/automations") as typeof import("../store/automations")).listAutomations()
      .filter((row) => row.monitor?.originChatId === chatId)
      .map((row) => ({ id: row.id, name: row.name, enabled: row.enabled, nextRunAt: row.nextRunAt ?? null })),
    waits: (chatId) => {
      const waits = require("../harness/peer-reply-wait") as typeof import("../harness/peer-reply-wait");
      const db = (require("../store/db") as typeof import("../store/db")).getDb() as unknown as Parameters<typeof waits.listPeerReplyWaits>[0];
      const title = (id: string): string => { try { return (require("../store/chats") as typeof import("../store/chats")).getChat(id)?.title ?? ""; } catch { return ""; } };
      return waits.listPeerReplyWaits(db, chatId).filter((wait) => !wait.state || wait.state === "active").map((wait) => ({ id: wait.id, targetTitle: title(wait.targetChatId), expiresAt: wait.expiresAt }));
    },
    goalWait: (chatId) => {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(chatId);
      if (!chat?.goalId) return null;
      const wake = (require("../long-run/goal-next-wake") as typeof import("../long-run/goal-next-wake")).goalNextWake(chat.goalId);
      return wake ? { goalId: chat.goalId, at: wake.at, cause: wake.cause } : null;
    },
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}
