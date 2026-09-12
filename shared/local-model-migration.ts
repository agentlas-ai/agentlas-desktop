import type { RuntimeSelection } from "./types";

export const LOCAL_MODEL_MIGRATION_SCHEMA_VERSION = 1 as const;

export type OllamaMigrationAuthority =
  | "active-runtime"
  | "runtime-memory"
  | "chat"
  | "automation"
  | "agent-override"
  | "model-role"
  | "model-role-member"
  | "long-run-history"
  | "one-local-storage";

export type OllamaMigrationState =
  | "mapped"
  | "migration-needed"
  | "paused-migration-needed"
  | "conflict"
  | "history-preserved";

export interface OllamaMigrationBinding {
  kind: "ollama" | "agentlas-local";
  backend: "ollama" | "agentlas-local";
  source: string;
  model: string | null;
  enginePackageId: string | null;
  installationId: string | null;
  fileSha256: string | null;
  repository: string | null;
  revision: string | null;
  quantization: string | null;
}

export interface OllamaMigrationEntry {
  schemaVersion: typeof LOCAL_MODEL_MIGRATION_SCHEMA_VERSION;
  migrationId: string;
  authority: OllamaMigrationAuthority;
  referenceHash: `sha256:${string}`;
  state: OllamaMigrationState;
  requested: OllamaMigrationBinding;
  actual: OllamaMigrationBinding;
  reasonCodes: string[];
  automationPaused: boolean;
  observedAt: string;
}

export interface OllamaMigrationSnapshot {
  schemaVersion: typeof LOCAL_MODEL_MIGRATION_SCHEMA_VERSION;
  generatedAt: string;
  entries: OllamaMigrationEntry[];
  counts: Record<OllamaMigrationState, number>;
  externalOllamaModified: false;
  systemOllamaUninstalled: false;
}

export interface LocalModelMigrationAPI {
  snapshot: () => Promise<OllamaMigrationSnapshot>;
  reconcile: () => Promise<OllamaMigrationSnapshot>;
  inspectOneSelection: (payload: { selection: RuntimeSelection | null }) => Promise<OllamaMigrationEntry | null>;
  commitOneSelection: (payload: { requested: RuntimeSelection; actual: RuntimeSelection }) => Promise<OllamaMigrationEntry>;
}
