// Renderer-facing shapes for One's capability inventory (skills, plugins, hooks, memory, connectors).
// The Main side lives in electron/capabilities/one-capabilities.ts; the shapes are structurally identical.
export type OneCapabilityKind = "skill" | "plugin" | "hook" | "memory" | "connector";
export type OneCapabilitySource = "codex" | "claude" | "cursor" | "grok" | "gemini" | "copilot" | "agentlas";

export interface OneCapabilityItem {
  id: string;
  kind: OneCapabilityKind;
  source: OneCapabilitySource;
  name: string;
  /** Display name when it differs from the runtime key in `name`. */
  title?: string;
  description: string;
  path: string;
  enabled: boolean;
  /** False: no switch is offered; `limit` says why. Agentlas built-ins never reach the renderer at all. */
  applies: boolean;
  /** runtime_reads_itself: the runtime loads it on its own. agentlas_managed: Agentlas connects it when a turn needs it. */
  limit?: "runtime_reads_itself" | "agentlas_managed";
}

export interface OneCapabilityDetail {
  id: string;
  kind: OneCapabilityKind;
  source: OneCapabilitySource;
  name: string;
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
}

export interface OneCapabilitiesAPI {
  list(input?: { source?: OneCapabilitySource; kind?: OneCapabilityKind }): Promise<{ items: OneCapabilityItem[]; counts: Record<string, { total: number; enabled: number }> }>;
  detail(input: { id: string }): Promise<OneCapabilityDetail | null>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<OneCapabilityItem | null>;
  setSourceEnabled(input: { source: OneCapabilitySource; enabled: boolean; kind?: OneCapabilityKind }): Promise<{ source: OneCapabilitySource; changed: number }>;
}
