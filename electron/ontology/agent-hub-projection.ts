import { app } from "electron";

import type { AgentOntologyHubProjection } from "../../shared/types";
import {
  getDefaultOntologyHubClient,
  type OntologyHubProjectionResult,
} from "../mobile-bridge/ontology-hub-client";
import { getInstalledAgentHubBinding } from "./hub-bindings";

interface ProjectionClient {
  query(
    bindings: ReadonlyArray<{ agentDefinitionId: string; agentReleaseId: string }>,
    force?: boolean,
  ): Promise<OntologyHubProjectionResult>;
}

function sameExactBinding(
  left: { agentDefinitionId: string; agentReleaseId: string } | null,
  right: { agentDefinitionId: string; agentReleaseId: string } | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.agentDefinitionId === right.agentDefinitionId &&
    left.agentReleaseId === right.agentReleaseId,
  );
}

/**
 * Read-only My Agents projection over one exact v59 Hub binding.
 *
 * There is intentionally no slug, package hash, local display name, or
 * "latest" fallback. A binding that changes while the Hub request is in
 * flight invalidates the whole response so a prior release can never be shown
 * as the selected agent's current loadout.
 */
export async function getAgentOntologyHubProjection(
  installedAgentId: string,
  options: { force?: boolean; client?: ProjectionClient } = {},
): Promise<AgentOntologyHubProjection> {
  const before = getInstalledAgentHubBinding(installedAgentId);
  if (!before) {
    return {
      schemaVersion: 1,
      status: "unbound",
      supported: false,
      binding: null,
      projection: null,
    };
  }

  const binding = {
    agentDefinitionId: before.agentDefinitionId,
    agentReleaseId: before.agentReleaseId,
  };
  const client = options.client ?? getDefaultOntologyHubClient(app.getPath("userData"));
  const result = await client.query([binding], options.force === true);
  const after = getInstalledAgentHubBinding(installedAgentId);
  if (!sameExactBinding(binding, after)) {
    return {
      schemaVersion: 1,
      status: "binding-changed",
      supported: false,
      binding: null,
      projection: null,
    };
  }

  const projection = result.projections.find((item) =>
    item.agentDefinitionId === binding.agentDefinitionId &&
    item.agentReleaseId === binding.agentReleaseId,
  ) ?? null;
  return {
    schemaVersion: 1,
    status: result.status === "live" && !projection ? "projection-missing" : result.status,
    supported: result.supported,
    binding,
    projection,
  };
}
