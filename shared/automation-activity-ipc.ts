/**
 * Wire shapes of the conversation automation view (Main IPC → One, Work, and later the phone bridge).
 * Ledger facts only: names, schedules, hosts, tool names and element labels — no prompts, no model prose.
 */
import type { AutomationRunDigest } from "./automation-activity";

export interface AutomationChatActivityAutomation {
  id: string;
  name: string;
  enabled: boolean;
  scheduleHuman: string;
  timezone: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  link: "origin" | "goal" | "project";
  ledgerChatId: string | null;
  running: boolean;
  liveRun: AutomationRunDigest | null;
}

export interface AutomationChatActivityRunPage {
  automationId: string;
  runs: AutomationRunDigest[];
  /** Pass as `before` to read the next (older) page; null when there is none. */
  nextCursor: string | null;
}

export interface AutomationChatActivitySnapshot {
  schemaVersion: "agentlas.automation-chat-activity.v1";
  chatId: string | null;
  projectId: string | null;
  automations: AutomationChatActivityAutomation[];
}
