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
  let remoteOperational: Awaited<ReturnType<typeof resolveDesktopOperationalRuntimeSession>> = null;
  try {
    // This call is also the next-session activation boundary for Taste-only
    // loadouts. It never sends the local task or raw chat id to Hub.
    remoteOperational = await resolveDesktopOperationalRuntimeSession({
      sessionId: input.runSessionId,
      installedAgentId: input.installedAgent.id,
      client: input.client,
    });
  } catch {
    remoteOperational = null;
  }
  let tasteDirective = "";
  let tasteApproxTokens = 0;
  let tasteReleaseId: string | null = null;
  try {
    const taste = await resolveDesktopTasteRuntimeSession({
      sessionId: input.runSessionId,
      installedAgentId: input.installedAgent.id,
      client: input.client,
    });
    if (taste && tasteRuntimeOverlayMatchesTask(taste.overlay, input.task)) {
      tasteDirective = taste.directive;
      tasteApproxTokens = taste.overlay.estimatedTokens;
      tasteReleaseId = taste.overlay.releaseId;
    }
  } catch {
    // Optional overlay: exact base agent continues without Taste.
  }

  let operationalPrompt = "";
  let operationalApproxTokens = 0;
  if (input.includeOperational !== false) {
    if (remoteOperational && operationalRuntimeOverlayMatchesTask(remoteOperational.overlay, input.task)) {
      operationalPrompt = remoteOperational.directive;
      operationalApproxTokens = remoteOperational.overlay.estimatedTokens;
    } else {
      try {
        const experience = buildExperienceContext({
          agentId: input.installedAgent.id,
          projectId: input.projectId,
          projectPath: input.projectPath,
          environment: {
            platform: process.platform,
            arch: process.arch,
            runtimeKind: input.runtimeKind,
          },
          basePackageHash: input.installedAgent.packageHash ?? null,
          task: input.task,
          reservedApproxTokens: tasteApproxTokens,
        });
        operationalPrompt = experience.prompt;
        operationalApproxTokens = experience.approximateTokens;
      } catch {
        // Operational Experience is independent and optional.
      }
    }
  }

  if (operationalApproxTokens + tasteApproxTokens > EXPERIENCE_SELECTED_MAX_APPROX_TOKENS) {
    // Taste is an exact already-attached release. If a future Operational
    // selector violates its reservation contract, drop that soft layer rather
    // than exceeding the runtime ceiling or canceling Taste.
    operationalPrompt = "";
    operationalApproxTokens = 0;
  }
  const prompt = [operationalPrompt, tasteDirective].filter(Boolean).join("\n\n");
  return {
    operationalPrompt,
    tasteDirective,
    prompt,
    operationalApproxTokens,
    tasteApproxTokens,
    combinedApproxTokens: operationalApproxTokens + tasteApproxTokens,
    tasteReleaseId,
  };
}
