import type { Automation } from "./types";

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
  validation: { state: "untested" | "passed" | "failed"; at: string | null; receipts: string[]; problems: string[] };
}
export interface ToolchainAsset {
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
