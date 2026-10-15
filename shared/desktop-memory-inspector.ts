import type { AgentAppMemorySharing, AgentAppMemorySharingInput } from "./agent-app-memory";
import type { OneMemoryMapSnapshot, OneMemoryMapScope } from "./one-memory-map";

/** Desktop owner UI capability. Never embedded in Mobile map1.0.0 or a model prompt. */
export const DESKTOP_MEMORY_INSPECTOR_VERSION = "agentlas.desktop-memory-inspector.v1" as const;
export type DesktopMemoryStatus = "active" | "disabled" | "superseded" | "forgotten";
export interface DesktopMemoryQuery { actorId?: string | null; projectId?: string | null; scope?: OneMemoryMapScope | null;
  status?: DesktopMemoryStatus | "all"; limit?: number }
export interface DesktopMemoryTarget { memoryId: string; ownerRef: string; actorId: string | null;
  expectedRevision: string; expectedEpoch: number }
export interface DesktopMemoryEntry extends DesktopMemoryTarget {
  kind: string; scope: string; content: string; title: string; status: DesktopMemoryStatus; createdAt: string;
  actorName: string; projectSlug: string | null;
}
export interface DesktopMemoryDetail extends DesktopMemoryEntry {
  contentEnglish: string; contentNative: string | null; sensitivity: string; confidence: string;
  originRefs: Array<{ kind: string; id: string; revision: string | null }>;
  projects: Array<{ id: string; relation: "origin" | "applies_to" }>;
  applicability: { scope: string; projectIds: string[]; actorId: string | null; chatId: string | null;
    enabled: boolean; recallChannel: string; compatibilityScope: { scope: string; scopeRef: string | null } | null };
  audience: { declaration: "existing_scope" | "unknown"; scope: string; sensitivity: string; recallChannel: string };
  curationActor: string; policyVersion: string | null; authorityRevision: number; bindingRevision: number | null;
  supersededAt: string | null; editable: boolean;
}
export interface DesktopMemoryQueryResult {
  schemaVersion: typeof DESKTOP_MEMORY_INSPECTOR_VERSION; ownerRef: string; revocationEpoch: number; authorityRevision: number;
  entries: DesktopMemoryEntry[]; map: OneMemoryMapSnapshot; total: number; truncated: boolean;
  actors: Array<{ id: string | null; name: string }>;
  projects: Array<{ id: string; name: string }>;
}
export interface DesktopMemoryMutationResult { ok: true; memoryId: string; replacementId: string | null;
  revocationEpoch: number; authorityRevision: number; affectedMemoryIds: string[] }
export interface DesktopMemoryInspectorAPI {
  query(input?: DesktopMemoryQuery): Promise<DesktopMemoryQueryResult>;
  detail(input: { memoryId: string; ownerRef: string }): Promise<DesktopMemoryDetail>;
  edit(input: DesktopMemoryTarget & { content: string }): Promise<DesktopMemoryMutationResult>;
  forget(input: DesktopMemoryTarget): Promise<DesktopMemoryMutationResult>;
  appSharing?(input: DesktopMemoryTarget): Promise<AgentAppMemorySharing>;
  setAppSharing?(input: AgentAppMemorySharingInput): Promise<DesktopMemoryMutationResult>;
}
