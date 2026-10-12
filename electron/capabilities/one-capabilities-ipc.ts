// IPC for One's capability inventory (one-capabilities.ts). Permissive by owner decision 2026-10-11: no approval
// prompt for toggling, so One can switch items on request through the same handlers the screen calls.
//
//   oneCapabilities:list          ({ source?, kind? }?)                       -> { items: CapabilityItem[]; counts }
//   oneCapabilities:detail        ({ id })                                    -> CapabilityDetail | null
//   oneCapabilities:setEnabled    ({ id, enabled })                           -> CapabilityItem | null
//   oneCapabilities:setSourceEnabled ({ source, enabled, kind? })             -> { source, changed }
//
// Agentlas built-ins are not listed and cannot be switched; neither can an item whose runtime loads it on its own.
// Both setters throw `capability_not_switchable` for those instead of storing a state no run would honor.
import type { IpcMain } from "electron";
import { registerAppControlDomainIpc } from "../app-control/ipc-registry";
import {
  capabilityDetail,
  listCapabilities,
  setCapabilityEnabled,
  setSourceEnabled,
  type CapabilityKind,
  type CapabilitySource,
} from "./one-capabilities";

const SOURCES: readonly CapabilitySource[] = ["codex", "claude", "cursor", "grok", "gemini", "copilot", "agentlas"];
const KINDS: readonly CapabilityKind[] = ["skill", "plugin", "hook", "memory", "connector"];

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
function source(value: unknown): CapabilitySource | undefined {
  return SOURCES.find((candidate) => candidate === value);
}
function kind(value: unknown): CapabilityKind | undefined {
  return KINDS.find((candidate) => candidate === value);
}

export function registerOneCapabilitiesIpc(ipc: Pick<IpcMain, "handle">): void {
  registerAppControlDomainIpc(ipc, "oneCapabilities:list", (input?: unknown) => {
    const filter = record(input);
    const s = source(filter.source), k = kind(filter.kind);
    const all = listCapabilities();
    const items = all.filter((item) => (!s || item.source === s) && (!k || item.kind === k));
    const counts: Record<string, { total: number; enabled: number }> = {};
    for (const item of all) {
      const key = `${item.source}:${item.kind}`;
      counts[key] ??= { total: 0, enabled: 0 };
      counts[key].total += 1;
      if (item.enabled) counts[key].enabled += 1;
    }
    return { items, counts };
  });
  registerAppControlDomainIpc(ipc, "oneCapabilities:detail", (input: unknown) => {
    const id = record(input).id;
    return typeof id === "string" ? capabilityDetail(id) : null;
  });
  registerAppControlDomainIpc(ipc, "oneCapabilities:setEnabled", (input: unknown) => {
    const { id, enabled } = record(input);
    if (typeof id !== "string" || typeof enabled !== "boolean") throw new Error("oneCapabilities:setEnabled needs { id: string, enabled: boolean }");
    return setCapabilityEnabled(id, enabled);
  });
  registerAppControlDomainIpc(ipc, "oneCapabilities:setSourceEnabled", (input: unknown) => {
    const body = record(input);
    const s = source(body.source);
    if (!s || typeof body.enabled !== "boolean") throw new Error("oneCapabilities:setSourceEnabled needs { source, enabled: boolean, kind? }");
    return setSourceEnabled(s, body.enabled, kind(body.kind));
  });
}
