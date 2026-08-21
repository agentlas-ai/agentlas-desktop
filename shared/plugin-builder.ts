import type { OnePluginBuildSignal } from "./one-suggestions";

export const PLUGIN_BUILDER_PHASES = [
  "interview",
  "draft",
  "verify",
  "install",
  "prove",
] as const;

export type PluginBuilderPhase = typeof PLUGIN_BUILDER_PHASES[number];

export type PluginBuilderSeed =
  | { kind: "mention"; request: string }
  | { kind: "suggestion"; suggestionId: string; signal: OnePluginBuildSignal }
  | { kind: "agent-offer"; chatId: string; request: string };

export type PluginBuilderFileWrite = "none" | "project-only" | "ask" | "full";
export type PluginBuilderNetwork = "none" | "ask" | "allow";
export type PluginBuilderShell = "deny" | "ask" | "allow";

export interface PluginBuilderWorkflowAnswer {
  name: string;
  description: string;
  steps: string[];
  outputs: string[];
  verification: string[];
}

export interface PluginBuilderAnswers {
  slug: string;
  name: string;
  description: string;
  category: "design" | "dev" | "data" | "web" | "productivity" | "communication" | "custom";
  workflows: PluginBuilderWorkflowAnswer[];
  requiresTools: string[];
  permissions: {
    fileWrite: PluginBuilderFileWrite;
    network: PluginBuilderNetwork;
    shell: PluginBuilderShell;
  };
  state: {
    files: string[];
    assets: boolean;
  };
}

export interface PluginBuilderSession {
  id: string;
  chatId: string;
  slug: string | null;
  phase: PluginBuilderPhase;
  stagingDir: string | null;
  answers: PluginBuilderAnswers | null;
  gateReport: PluginGateReport | null;
  seed: PluginBuilderSeed;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGateReport {
  ok: boolean;
  packageDir: string;
  violations: string[];
  checkedAt: string;
  manifestSha256?: string;
  stdout?: string;
  stderr?: string;
}

export interface PluginDraftResult {
  session: PluginBuilderSession;
  packageDir: string;
  files: string[];
  manifest: Record<string, unknown>;
  summary: string;
}

export interface PluginInstallReceipt {
  sessionId: string;
  slug: string;
  installedDir: string;
  installManifestPath: string;
  updated: boolean;
  installedAt: string;
  manifestSha256: string;
  verified: true;
  summary: string;
}

export interface PluginProofReceipt {
  sessionId: string;
  slug: string;
  installed: true;
  routerInjected: boolean;
  workflowRun: { name: string; ok: boolean; summary: string } | null;
  proven: boolean;
  reason?: string;
}

export interface PluginBuilderProgressEvent {
  sessionId: string;
  phase: PluginBuilderPhase;
  line: string;
}

export interface PluginBuilderStartInput {
  chatId: string;
  seed: PluginBuilderSeed;
}

export interface PluginBuilderDraftInput {
  sessionId: string;
  answers: PluginBuilderAnswers;
}

export interface PluginBuilderSessionInput {
  sessionId: string;
}
