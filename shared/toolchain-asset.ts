import type { Automation, RuntimeSelection } from "./types";
import type { ToolchainInterface } from "./toolchain";

export const TOOLCHAIN_GENERATION_TIMEOUT_MS = 120_000;

/** A published capability has its own identity. Its source graph is provenance only. */
export type ToolchainJsonSchema = Record<string, unknown>;
export interface ToolchainAssetContract {
  name: string;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputSchema: ToolchainJsonSchema;
  outputSchema: ToolchainJsonSchema;
  examples: Array<{ input: Record<string, unknown>; expectedOutput: unknown }>;
  /** Which inputs vary and which behavior stays invariant across those examples. */
  variationStatement: string;
}
export interface ToolchainOutputBinding { nodeId: string; format: "json" | "text" }
/** Actual fresh-session generation + search + selection; separate from example execution. */
export interface ToolchainAssetColdStart extends NonNullable<ToolchainInterface["coldStart"]> {
  schemaVersion: "agentlas.toolchain-asset-cold-start.v1";
  toolchainId: string; version: number; contentHash: string; nativeIntentId: string; catalogDigest: string;
  cases: Array<{ kind: "positive" | "negative"; task: string; found: boolean; selected: boolean; bound: boolean;
    candidates: Array<{ id: string; version: number; contentHash: string }>;
    chosen: { id: string; version: number; contentHash: string } | null; input: Record<string, unknown> }>;
  runtimeReceipts: Array<{ selection: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "role" | "inherit" | "acpAgentId">;
    route: "explicit_pin" | "orchestrator_pool" | "worker_pool" | "legacy"; fingerprint: string;
    execution: "invoked" | "cached" | "not_invoked"; longContext?: boolean; effort?: string;
    capability?: { schemaVersion: "agentlas.judgment-capability.v1"; requirement: "no_tools";
      status: "verified" | "unsupported" | "unknown"; enforcement: "claude_safe_mode" | "main_tool_payload_omitted" | "unsupported" | "unknown"; reason: string } }>;
}
export interface ToolchainAssetVersion {
  version: number;
  contentHash: string;
  /** Identity-free executable definition used to reject duplicate releases. */
  definitionFingerprint?: string;
  /** Same executable contract, independent of validation examples and display copy. */
  implementationFingerprint?: string;
  createdAt: string;
  contract: ToolchainAssetContract;
  implementation: { kind: "graph"; automationId: string; snapshot: Automation; outputBinding: ToolchainOutputBinding };
  provenance: { sourceAutomationId: string; sourceDefinitionDigest: string; creatorChatId: string | null };
  coldStart?: ToolchainAssetColdStart;
  exposedBy?: { kind: "owner" | "one"; chatId: string | null; at: string; authorityRevision: string };
  validation: { state: "untested" | "passed" | "failed"; at: string | null; receipts: string[]; problems: string[] };
}
export interface ToolchainAsset {
  /** Host observation only; never persisted or interpreted as admission. */
  testInProgress?: boolean;
  schemaVersion: "agentlas.toolchain-asset.v1";
  id: string;
  name: string;
  /** Stable capability identity chosen by the generalization service, never its display title. */
  capabilityKey?: string;
  status: "draft" | "callable" | "withdrawn";
  stableVersion: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  versions: ToolchainAssetVersion[];
  legacyAutomationId?: string;
}
export interface ToolchainAssetCreateInput {
  capabilityKey?: string;
  sourceAutomationId: string;
  contract: ToolchainAssetContract;
  outputBinding: ToolchainOutputBinding;
}
export interface ToolchainGenerationInput {
  request: string;
  toolchainId?: string;
  projectId?: string;
  requestId: string;
}
export interface ToolchainGenerationResult {
  asset: ToolchainAsset;
  version: number;
  decision: "reuse" | "new_version" | "new_asset";
  rationale: string;
  generalizationId: string;
}
export interface ToolchainCallReceipt {
  schemaVersion: "agentlas.toolchain-call.v1";
  id: string;
  toolchainId: string;
  version: number;
  requestId: string;
  callerChatId: string | null;
  parentRunId: string | null;
  contentHash: string;
  inputHash: string;
  /** Succeeded means the frozen implementation completed and its output contract passed.
   * Business effects require evidence/readback in that implementation, not a success label. */
  status: "running" | "succeeded" | "failed" | "uncertain";
  ok: boolean;
  result?: unknown;
  error?: string;
  runId: string;
  startedAt: string;
  completedAt: string | null;
  dryRun: boolean;
}
export interface ToolchainAssetsApi {
  generateAsset: (input: ToolchainGenerationInput) => Promise<ToolchainGenerationResult>;
  listAssets: () => Promise<ToolchainAsset[]>;
  getAsset: (id: string) => Promise<ToolchainAsset | null>;
  createAsset: (input: ToolchainAssetCreateInput) => Promise<ToolchainAsset>;
  addVersion: (input: ToolchainAssetCreateInput & { id: string }) => Promise<ToolchainAsset>;
  publishVersion: (input: { id: string; version: number; allowEffectfulValidation?: boolean }) => Promise<ToolchainAsset>;
  withdrawAsset: (id: string) => Promise<ToolchainAsset>;
  runAsset: (input: { id: string; version?: number; input: Record<string, unknown>; requestId: string }) => Promise<ToolchainCallReceipt>;
  assetHistory: (id: string) => Promise<ToolchainCallReceipt[]>;
  assetRuns: (id: string) => Promise<ToolchainCallReceipt[]>;
}
