import { app } from "electron";
import { createHash } from "node:crypto";

import type {
  DesktopOntologyRuntimeSessionDto,
  DesktopOperationalRuntimeOverlayDto,
} from "../../shared/mobile-bridge";
import { getDefaultOntologyHubClient } from "../mobile-bridge/ontology-hub-client";
import { getInstalledAgentHubBinding } from "./hub-bindings";
import {
  operationalRuntimeOverlayIsRuntimeSafe,
  renderDesktopOperationalRuntimeDirective,
} from "./operational-runtime-contract";
import { userDataDir } from "../runtime-paths";

interface RuntimeClient {
  resolveRuntimeSession?: (input: {
    agentDefinitionId: string;
    agentReleaseId: string;
    sessionRef: string;
  }) => Promise<DesktopOntologyRuntimeSessionDto>;
}

export interface DesktopOperationalRuntimeSnapshot {
  schemaVersion: 1;
  activation: "session-start-snapshot";
  installedAgentId: string;
  projectionRevision: string;
  loadoutRevision: string;
  overlay: DesktopOperationalRuntimeOverlayDto;
  directive: string;
}

const sessionSnapshots = new Map<string, DesktopOperationalRuntimeSnapshot | null>();
const sessionSnapshotInflight = new Map<string, Promise<DesktopOperationalRuntimeSnapshot | null>>();
const MAX_SESSION_SNAPSHOTS = 256;

function sessionKey(sessionId: string, installedAgentId: string): string {
  return `${sessionId}\0${installedAgentId}`;
}

function opaqueSessionRef(sessionId: string): string {
  return `desktop-session-${createHash("sha256")
    .update("agentlas-desktop-ontology-session\0", "utf8")
    .update(sessionId, "utf8")
    .digest("hex")
    .slice(0, 48)}`;
}

function trimSessionSnapshots(): void {
  while (sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
    sessionSnapshots.delete(sessionSnapshots.keys().next().value as string);
  }
}

export function selectOperationalRuntimeOverlay(input: {
  session: DesktopOntologyRuntimeSessionDto | null;
  agentDefinitionId: string;
  agentReleaseId: string;
}): DesktopOperationalRuntimeOverlayDto | null {
  const session = input.session;
  const overlay = session?.operational ?? null;
  if (
    !session || session.state !== "ready" || !overlay ||
    session.agentDefinitionId !== input.agentDefinitionId ||
    session.agentReleaseId !== input.agentReleaseId ||
    overlay.baseAgentDefinitionId !== input.agentDefinitionId ||
    overlay.baseAgentReleaseId !== input.agentReleaseId ||
    !operationalRuntimeOverlayIsRuntimeSafe(overlay)
  ) return null;
  return overlay;
}

/**
 * The first turn of a new Desktop chat activates an already-approved Hub
 * loadout and freezes the exact Operational material for the whole chat.
 * The raw local chat id is hashed before it leaves Main.
 */
export async function resolveDesktopOperationalRuntimeSession(input: {
  sessionId: string;
  installedAgentId: string;
  client?: RuntimeClient;
}): Promise<DesktopOperationalRuntimeSnapshot | null> {
  const key = sessionKey(input.sessionId, input.installedAgentId);
  if (sessionSnapshots.has(key)) return sessionSnapshots.get(key) ?? null;
  const existing = sessionSnapshotInflight.get(key);
  if (existing) return existing;
  const resolution = (async (): Promise<DesktopOperationalRuntimeSnapshot | null> => {
    const before = getInstalledAgentHubBinding(input.installedAgentId);
    if (!before) return null;
    const client = input.client ?? getDefaultOntologyHubClient(userDataDir());
    let snapshot: DesktopOperationalRuntimeSnapshot | null = null;
    try {
      if (client.resolveRuntimeSession) {
        const session = await client.resolveRuntimeSession({
          agentDefinitionId: before.agentDefinitionId,
          agentReleaseId: before.agentReleaseId,
          sessionRef: opaqueSessionRef(input.sessionId),
        });
        const after = getInstalledAgentHubBinding(input.installedAgentId);
        if (
          after && after.agentDefinitionId === before.agentDefinitionId &&
          after.agentReleaseId === before.agentReleaseId
        ) {
          const overlay = selectOperationalRuntimeOverlay({
            session,
            agentDefinitionId: before.agentDefinitionId,
            agentReleaseId: before.agentReleaseId,
          });
          if (overlay) {
            snapshot = {
              schemaVersion: 1,
              activation: "session-start-snapshot",
              installedAgentId: input.installedAgentId,
              projectionRevision: session.projectionRevision,
              loadoutRevision: session.loadoutRevision,
              overlay,
              directive: renderDesktopOperationalRuntimeDirective(overlay),
            };
          }
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

export function clearDesktopOperationalRuntimeSessionSnapshots(): void {
  sessionSnapshots.clear();
  sessionSnapshotInflight.clear();
}
