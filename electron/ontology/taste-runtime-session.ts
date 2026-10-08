import { app } from "electron";

import type {
  MobileBridgeOntologyProjectionDto,
  MobileBridgeTasteRuntimeOverlayDto,
} from "../../shared/mobile-bridge";
import {
  getDefaultOntologyHubClient,
  type OntologyHubProjectionResult,
} from "../mobile-bridge/ontology-hub-client";
import { getInstalledAgentHubBinding } from "./hub-bindings";
import {
  renderTasteRuntimeDirective,
  tasteRuntimeOverlayIsRuntimeSafe,
} from "./taste-runtime-contract";
import { userDataDir } from "../runtime-paths";

interface ProjectionClient {
  query(
    bindings: ReadonlyArray<{ agentDefinitionId: string; agentReleaseId: string }>,
    force?: boolean,
  ): Promise<OntologyHubProjectionResult>;
}

export interface DesktopTasteRuntimeSnapshot {
  schemaVersion: 1;
  activation: "session-start-snapshot";
  installedAgentId: string;
  projectionRevision: string;
  loadoutRevision: string;
  overlay: MobileBridgeTasteRuntimeOverlayDto;
  directive: string;
}

const sessionSnapshots = new Map<string, DesktopTasteRuntimeSnapshot | null>();
const sessionSnapshotInflight = new Map<string, Promise<DesktopTasteRuntimeSnapshot | null>>();
const MAX_SESSION_SNAPSHOTS = 256;

function sessionKey(sessionId: string, installedAgentId: string): string {
  return `${sessionId}\0${installedAgentId}`;
}

function trimSessionSnapshots(): void {
  while (sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
    sessionSnapshots.delete(sessionSnapshots.keys().next().value as string);
  }
}

/** Pure fail-closed selector used by Desktop and contract tests. */
export function selectTasteRuntimeOverlay(input: {
  projection: MobileBridgeOntologyProjectionDto | null;
  agentDefinitionId: string;
  agentReleaseId: string;
}): MobileBridgeTasteRuntimeOverlayDto | null {
  return null;
}

/**
 * A chat id is the Desktop runtime-session boundary. The first lookup stores
 * either one exact overlay or an explicit empty snapshot; later turns never
 * hot-swap Taste material into a resumed session.
 */
export async function resolveDesktopTasteRuntimeSession(input: {
  sessionId: string;
  installedAgentId: string;
  client?: ProjectionClient;
}): Promise<DesktopTasteRuntimeSnapshot | null> {
  return null;
}

/** Test/process-lifecycle hook; product code relies on unique chat ids. */
export function clearDesktopTasteRuntimeSessionSnapshots(): void {
  sessionSnapshots.clear();
  sessionSnapshotInflight.clear();
}
