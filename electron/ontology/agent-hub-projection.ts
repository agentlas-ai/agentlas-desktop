import type {
  AgentOntologyAttachDecision,
  AgentOntologyAttachDecisionResult,
  AgentOntologyHubProjection,
} from "../../shared/types";
import type {
  OntologyAttachResolveInput,
  OntologyHubProjectionResult,
} from "../mobile-bridge/ontology-hub-client";
import { experienceChipsRetired } from "../experience/retired";

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

/** Retained for callers that must receive the explicit retirement error. */
export async function getAgentOntologyHubProjection(
  _installedAgentId: string,
  _options: { force?: boolean; client?: ProjectionClient } = {},
): Promise<AgentOntologyHubProjection> {
  return experienceChipsRetired();
}

/** A legacy attachment approval cannot mutate an agent or contact Hub. */
export async function resolveAgentOntologyHubAttach(
  _installedAgentId: string,
  _approvalId: string,
  _decision: AgentOntologyAttachDecision,
  _options: { client?: ProjectionClient } = {},
): Promise<AgentOntologyAttachDecisionResult> {
  return experienceChipsRetired();
}
