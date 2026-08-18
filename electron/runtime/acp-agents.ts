// Which ACP agents does this machine offer as kind "acp"? (PRD 2026-08-15 B-1)
//
// Two sources, one shape (AcpAgentSpec):
//   1. built-in specs from acp.ts (ACP_AGENTS) that are NOT already served by a
//      dedicated RuntimeKind — cursor/grok/kimi keep their kinds; github-copilot-cli
//      enters through "acp" (GitHub Copilot subscription = a real auth asset).
//   2. TerminalProfiles the user saved in ACP mode (settings → Terminal profiles),
//      id "profile:<id>", command/args from the profile. This is the Paseo-style
//      "add a provider" seat: registering any ACP agent is data, not code.
//
// Reading the profile store needs the DB; detection already runs on main with the
// store open. Everything degrades to "no profiles" if the store is unavailable.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TerminalProfile } from "../../shared/types";
import { ACP_AGENTS, type AcpAgentSpec } from "./acp";
import { probeCliVersion } from "./exec";

/** Built-in ACP specs served through kind "acp" (the rest have their own kind). */
export const ACP_KIND_BUILTINS = ["github-copilot-cli"] as const;

export function profileAcpId(profileId: string): string {
  return `profile:${profileId}`;
}

export function specFromProfile(profile: TerminalProfile): AcpAgentSpec | null {
  if (profile.mode !== "acp" || !profile.enabled) return null;
  const command = String(profile.acp?.command ?? "").trim();
  if (!command) return null;
  const args = Array.isArray(profile.acp?.args) ? profile.acp!.args.map(String) : [];
  return { id: profileAcpId(profile.id), label: profile.name || command, command, args };
}

let readProfiles: (() => TerminalProfile[]) | null = null;
/** Main wires the profile reader (store-backed) once; tests may inject their own. */
export function setAcpProfileReader(reader: (() => TerminalProfile[]) | null): void {
  readProfiles = reader;
}

function safeProfiles(): TerminalProfile[] {
  if (!readProfiles) return [];
  try {
    const list = readProfiles();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** All specs kind "acp" should consider on this machine (built-ins first, then profiles). */
export function listAcpKindSpecs(): AcpAgentSpec[] {
  const out: AcpAgentSpec[] = [];
  for (const id of ACP_KIND_BUILTINS) {
    const spec = ACP_AGENTS[id];
    if (spec) out.push(spec);
  }
  for (const profile of safeProfiles()) {
    const spec = specFromProfile(profile);
    if (spec) out.push(spec);
  }
  return out;
}

/** Spec for a RuntimeStatus.acpAgentId (built-in or profile). */
export function resolveAcpAgentSpec(acpAgentId: string | undefined | null): AcpAgentSpec | null {
  if (!acpAgentId) return null;
  if (ACP_AGENTS[acpAgentId]) return ACP_AGENTS[acpAgentId];
  if (acpAgentId.startsWith("profile:")) {
    const profileId = acpAgentId.slice("profile:".length);
    for (const profile of safeProfiles()) {
      if (profile.id === profileId) return specFromProfile(profile);
    }
  }
  return null;
}

/**
 * Where does this spec's command live? Absolute paths are checked directly;
 * bare names are resolved on PATH; `npx` specs count as present when npx is.
 * Returns the executable path detection verified, or null.
 */
export async function resolveAcpCommand(spec: AcpAgentSpec): Promise<{ path: string; version: string | null } | null> {
  const command = spec.command;
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command);
    } catch {
      return null;
    }
    return { path: command, version: await probeCliVersion(command, 2_500) };
  }
  const found = await whichOnPath(command);
  if (!found) return null;
  // `npx …` specs are network-backed; a version probe would download. Report present, version unknown.
  const version = command === "npx" ? null : await probeCliVersion(found, 2_500);
  return { path: found, version };
}

async function whichOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* next */
      }
    }
  }
  return null;
}
