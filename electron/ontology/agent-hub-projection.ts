import { app } from "electron";
import { createHash } from "node:crypto";

import type {
  AgentOntologyAttachDecision,
  AgentOntologyAttachDecisionResult,
  AgentOntologyHubProjection,
} from "../../shared/types";
import {
  getDefaultOntologyHubClient,
  type OntologyAttachResolveInput,
  type OntologyHubProjectionResult,
} from "../mobile-bridge/ontology-hub-client";
import { getInstalledAgentHubBinding } from "./hub-bindings";
import { userDataDir } from "../runtime-paths";

interface ProjectionClient {
  query(
    bindings: ReadonlyArray<{ agentDefinitionId: string; agentReleaseId: string }>,
    force?: boolean,
  ): Promise<OntologyHubProjectionResult>;
  resolveAttach(
    input: OntologyAttachResolveInput,
    idempotencyKey: string,
  ): Promise<import("../../shared/mobile-bridge").MobileBridgeOntologyAttachReceiptDto>;
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
  const client = options.client ?? getDefaultOntologyHubClient(userDataDir());
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

function attachmentIdempotencyKey(input: {
  installedAgentId: string;
  approvalId: string;
  decision: AgentOntologyAttachDecision;
  expectedProjectionRevision: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `desktop-ontology-attach-${digest.slice(0, 48)}`;
}

/**
 * Resolve a Hub-issued pending attachment approval from Desktop My Agents.
 *
 * Renderer input is intentionally narrow: Main re-queries the exact installed
 * agent binding and derives every release, revision, and selected chip from
 * the authenticated Hub projection immediately before the decision. This
 * method never creates an offer, quote, purchase, lease, or entitlement.
 */
export async function resolveAgentOntologyHubAttach(
  installedAgentId: string,
  approvalId: string,
  decision: AgentOntologyAttachDecision,
  options: { client?: ProjectionClient } = {},
): Promise<AgentOntologyAttachDecisionResult> {
  if (decision !== "approve" && decision !== "deny") throw new Error("Unsupported Experience Chip decision.");
  const before = getInstalledAgentHubBinding(installedAgentId);
  if (!before) throw new Error("This agent is not connected to Hub.");
  const binding = {
    agentDefinitionId: before.agentDefinitionId,
    agentReleaseId: before.agentReleaseId,
  };
  const client = options.client ?? getDefaultOntologyHubClient(userDataDir());
  const current = await client.query([binding], true);
  const afterQuery = getInstalledAgentHubBinding(installedAgentId);
  if (!sameExactBinding(binding, afterQuery)) throw new Error("The agent connection changed. Refresh before deciding.");
  const projection = current.status === "live"
    ? current.projections.find((item) => sameExactBinding(binding, item)) ?? null
    : null;
  if (!projection || projection.state !== "live") throw new Error("A current Hub attachment approval is unavailable.");
  const pending = projection.pendingAttachApprovals.find((item) => item.approvalId === approvalId);
  if (!pending) throw new Error("This attachment request is no longer pending.");

  const input: OntologyAttachResolveInput = {
    schemaVersion: 1,
    approvalId: pending.approvalId,
    recommendationId: pending.recommendationId,
    agentDefinitionId: binding.agentDefinitionId,
    agentReleaseId: binding.agentReleaseId,
    expectedProjectionRevision: projection.revision,
    expectedLoadoutRevision: pending.expectedLoadoutRevision,
    decision,
    selectedChips: decision === "approve" ? pending.selectedChips : [],
  };
  const receipt = await client.resolveAttach(input, attachmentIdempotencyKey({
    installedAgentId,
    approvalId: pending.approvalId,
    decision,
    expectedProjectionRevision: projection.revision,
  }));
  const refreshed = await client.query([binding], true);
  const afterResolve = getInstalledAgentHubBinding(installedAgentId);
  const refreshedProjection = sameExactBinding(binding, afterResolve)
    ? refreshed.projections.find((item) => sameExactBinding(binding, item)) ?? null
    : null;
  const rendererProjection: AgentOntologyHubProjection = !sameExactBinding(binding, afterResolve)
    ? { schemaVersion: 1, status: "binding-changed", supported: false, binding: null, projection: null }
    : {
        schemaVersion: 1,
        status: refreshed.status === "live" && !refreshedProjection ? "projection-missing" : refreshed.status,
        supported: refreshed.supported,
        binding,
        projection: refreshedProjection,
      };
  return {
    schemaVersion: 1,
    outcome: receipt.outcome,
    loadoutState: receipt.loadoutState,
    acknowledgedAt: receipt.acknowledgedAt,
    projection: rendererProjection,
  };
}
