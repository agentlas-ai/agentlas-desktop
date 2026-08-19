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
  const projection = input.projection;
  if (
    !projection ||
    projection.state !== "live" ||
    projection.loadout.state !== "ready" ||
    projection.agentDefinitionId !== input.agentDefinitionId ||
    projection.agentReleaseId !== input.agentReleaseId
  ) return null;
  const selected = projection.loadout.entries.filter((entry) => entry.kind === "taste");
  if (selected.length !== 1) return null;
  const attached = selected[0];
  if (attached.state !== "attached" && attached.state !== "update-available") return null;
  const catalog = projection.tasteChips.filter((chip) =>
    chip.kind === "taste" &&
    chip.verification === "verified" &&
    chip.chipId === attached.chipId &&
    chip.releaseId === attached.releaseId,
  );
  if (catalog.length !== 1) return null;
  const overlay = catalog[0].runtimeOverlay;
  if (
    !overlay ||
    overlay.chipId !== attached.chipId ||
    overlay.releaseId !== attached.releaseId ||
    overlay.baseAgentDefinitionId !== input.agentDefinitionId ||
    overlay.baseAgentReleaseId !== input.agentReleaseId ||
    !tasteRuntimeOverlayIsRuntimeSafe(overlay)
  ) return null;
  return overlay;
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
  const key = sessionKey(input.sessionId, input.installedAgentId);
  if (sessionSnapshots.has(key)) return sessionSnapshots.get(key) ?? null;
  const existing = sessionSnapshotInflight.get(key);
  if (existing) return existing;
  const resolution = (async (): Promise<DesktopTasteRuntimeSnapshot | null> => {
    const before = getInstalledAgentHubBinding(input.installedAgentId);
    if (!before) return null;
    const client = input.client ?? getDefaultOntologyHubClient(userDataDir());
    let snapshot: DesktopTasteRuntimeSnapshot | null = null;
    try {
      // force=true means a pinned release is usable only after this new session
      // revalidates it against the authoritative Hub projection.
      const result = await client.query([{
        agentDefinitionId: before.agentDefinitionId,
        agentReleaseId: before.agentReleaseId,
      }], true);
      const after = getInstalledAgentHubBinding(input.installedAgentId);
      const projection = result.status === "live"
        ? result.projections.find((item) =>
            item.agentDefinitionId === before.agentDefinitionId &&
            item.agentReleaseId === before.agentReleaseId,
          ) ?? null
        : null;
      if (
        after &&
        after.agentDefinitionId === before.agentDefinitionId &&
        after.agentReleaseId === before.agentReleaseId
      ) {
        const overlay = selectTasteRuntimeOverlay({
          projection,
          agentDefinitionId: before.agentDefinitionId,
          agentReleaseId: before.agentReleaseId,
        });
        if (overlay && projection) {
          snapshot = {
            schemaVersion: 1,
            activation: "session-start-snapshot",
            installedAgentId: input.installedAgentId,
            projectionRevision: projection.revision,
            loadoutRevision: projection.loadout.revision,
            overlay,
            directive: renderTasteRuntimeDirective(overlay),
          };
        }
      }
    } catch {
      snapshot = null;
    }
    sessionSnapshots.set(key, snapshot);
    trimSessionSnapshots();
    return snapshot;
  })();
  sessionSnapshotInflight.set(key, resolution);
  try {
    return await resolution;
  } finally {
    if (sessionSnapshotInflight.get(key) === resolution) sessionSnapshotInflight.delete(key);
  }
}

/** Test/process-lifecycle hook; product code relies on unique chat ids. */
export function clearDesktopTasteRuntimeSessionSnapshots(): void {
  sessionSnapshots.clear();
  sessionSnapshotInflight.clear();
}
