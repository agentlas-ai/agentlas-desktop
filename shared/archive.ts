// The Archive: locally stored agents that were not used for 30 days (owner decision 2026-10-13). A move out of sight, never a delete.
export interface ArchivedAgentRow {
  agentId: string;
  name: string;
  archivedAt: string;
  /** "auto-unused": the 30-day sweep. "manual": the owner archived it. */
  reason: "auto-unused" | "manual";
  lastUsedAt: string | null;
  /** Folder size on disk; null when the agent has no local folder. */
  sizeBytes: number | null;
}

export interface ArchiveState {
  autoEnabled: boolean;
  unusedDays: number;
  items: ArchivedAgentRow[];
  totalBytes: number;
}

export interface ArchiveAPI {
  state(): Promise<ArchiveState>;
  /** The on/off switch. On by default. */
  setAuto(enabled: boolean): Promise<ArchiveState>;
  /** The restore button; routing restores through the same function. */
  restore(agentId: string): Promise<ArchiveState>;
}
