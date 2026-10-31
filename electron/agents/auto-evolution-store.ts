import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentWorkspaceStorePath } from "./workspace-guard";

/**
 * The owner's per-agent auto-evolution switch and the log of what it applied. Plain files in the agent's workspace store, so
 * every host that reads the store (Main, Terminal engine) sees the same state. Only the trusted owner IPC writes the switch
 * (workspace-ipc.ts "agentWorkspace:setAutoEvolution"); the log is written by auto-evolution.ts.
 */
const SETTING_SCHEMA = "agentlas.auto-evolution.v1";
const LOG_SCHEMA = "agentlas.auto-evolution-log.v1";

/** watching: applied, still compared with the version it replaced and may be rolled back. */
export type AutoEvolutionState = "watching" | "kept" | "kept_unmeasured" | "rolled_back" | "superseded";
export interface AutoEvolutionEntry {
  revisionId: string;
  baseRevisionId: string;
  proposalId: string;
  memoryEntryIds: string[];
  appliedAt: string;
  state: AutoEvolutionState;
  evaluatedAt?: string;
  /** Machine-readable cause of the last state change (kinds of work that got worse, or the reason it stopped being watched). */
  reason?: string;
}

const settingFile = (agentId: string): string => path.join(agentWorkspaceStorePath(agentId), "auto-evolution.json");
const logFile = (agentId: string): string => path.join(agentWorkspaceStorePath(agentId), "auto-evolution-log.json");

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function readAutoEvolutionEnabled(agentId: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(settingFile(agentId), "utf8")) as { schemaVersion?: unknown; enabled?: unknown };
    return value.schemaVersion === SETTING_SCHEMA && value.enabled === true;
  } catch { return false; /* No file, or a corrupt one: off. */ }
}

export function writeAutoEvolutionEnabled(agentId: string, enabled: boolean): void {
  write(settingFile(agentId), { schemaVersion: SETTING_SCHEMA, enabled, changedAt: new Date().toISOString() });
}

export function hasAutoEvolutionRecord(agentId: string): boolean {
  return fs.existsSync(settingFile(agentId)) || fs.existsSync(logFile(agentId));
}

export function readAutoEvolutionLog(agentId: string): AutoEvolutionEntry[] {
  try {
    const value = JSON.parse(fs.readFileSync(logFile(agentId), "utf8")) as { schemaVersion?: unknown; entries?: unknown };
    if (value.schemaVersion !== LOG_SCHEMA || !Array.isArray(value.entries)) return [];
    return value.entries.filter((entry): entry is AutoEvolutionEntry => Boolean(entry) && typeof entry === "object"
      && typeof (entry as AutoEvolutionEntry).revisionId === "string" && typeof (entry as AutoEvolutionEntry).baseRevisionId === "string");
  } catch { return []; }
}

export function writeAutoEvolutionLog(agentId: string, entries: AutoEvolutionEntry[]): void {
  write(logFile(agentId), { schemaVersion: LOG_SCHEMA, entries });
}
