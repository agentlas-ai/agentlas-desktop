import type { InstalledAgent } from "../../shared/types";
import type { DesktopOntologyRuntimeSessionDto } from "../../shared/mobile-bridge";
import {
  buildExperienceContext,
  EXPERIENCE_SELECTED_MAX_APPROX_TOKENS,
} from "../experience/context";
import type { OntologyHubProjectionResult } from "../mobile-bridge/ontology-hub-client";
import { resolveDesktopOperationalRuntimeSession } from "./operational-runtime-session";
import { operationalRuntimeOverlayMatchesTask } from "./operational-runtime-contract";
import { resolveDesktopTasteRuntimeSession } from "./taste-runtime-session";
import { tasteRuntimeOverlayMatchesTask } from "./taste-runtime-contract";

interface ProjectionClient {
  query(
    bindings: ReadonlyArray<{ agentDefinitionId: string; agentReleaseId: string }>,
    force?: boolean,
  ): Promise<OntologyHubProjectionResult>;
  resolveRuntimeSession?: (input: {
    agentDefinitionId: string;
    agentReleaseId: string;
    sessionRef: string;
  }) => Promise<DesktopOntologyRuntimeSessionDto>;
}

export interface AgentRuntimeOntologyContext {
  operationalPrompt: string;
  tasteDirective: string;
  prompt: string;
  operationalApproxTokens: number;
  tasteApproxTokens: number;
  combinedApproxTokens: number;
  tasteReleaseId: string | null;
}

/**
 * One executing installed agent, one run-scoped snapshot. Operational and
 * Taste remain separate sections but share the same 800-token dynamic ceiling.
 */
export async function buildAgentRuntimeOntologyContext(input: {
  runSessionId: string;
  installedAgent: InstalledAgent;
  projectId?: string | null;
  projectPath?: string | null;
  runtimeKind: string;
  task: string;
  client?: ProjectionClient;
  /** False on surfaces that did not previously consume host-local Operational Experience. */
  includeOperational?: boolean;
}): Promise<AgentRuntimeOntologyContext> {
  return { operationalPrompt: "", tasteDirective: "", prompt: "", operationalApproxTokens: 0, tasteApproxTokens: 0, combinedApproxTokens: 0, tasteReleaseId: null };
}
