// Registered-asset upload targets shared by Electron IPC and the Mobile Bridge.
//
// A registered target (installed agent / installed team) is the only local
// source a remote caller may nominate for an Agent Cloud upload. The actual
// filesystem authority stays in main: the caller passes an opaque local id and
// main re-resolves it against the live registry before any packaging read.
import fs from "node:fs";
import { getAgentById, listInstalledAgents } from "../mcp/registry";
import { getFirm, listFirms } from "../store/firms";
import type {
  CloudAgentRegisteredTarget,
  CloudAgentRegisteredUploadOption,
} from "../../shared/types";

/**
 * Strip the local-registry namespace from a registered row's slug.
 *
 * `local-` (imported agent) and `firm-local-` (its team projection) exist only
 * to keep this machine's rows unique; they are not part of the asset's cloud
 * identity. Left in place they either mint a second public identity for an
 * asset that already has one (server: `slug_identity_conflict`) or publish a
 * Hub listing literally named `firm-local-…`.
 */
export function publishSlugFromRegistrySlug(registrySlug: string): string {
  return String(registrySlug || "")
    .replace(/^firm-local-/, "")
    .replace(/^firm-/, "")
    .replace(/^local-/, "");
}

export function registeredUploadRoot(
  target: CloudAgentRegisteredTarget,
): { rootPath: string; slug: string; preferPackageSlug: true } {
  if (!target || typeof target !== "object") throw new Error("registered-upload-target-invalid");
  if (target.entityKind === "team" && "firmId" in target) {
    const firm = getFirm(String(target.firmId || ""));
    const ceo = firm ? getAgentById(firm.ceoAgentId) : null;
    if (!firm) throw new Error("registered-team-not-found");
    if (!ceo?.localPath || !fs.existsSync(ceo.localPath) || !fs.statSync(ceo.localPath).isDirectory()) {
      throw new Error("registered-team-source-unavailable");
    }
    return { rootPath: ceo.localPath, slug: publishSlugFromRegistrySlug(firm.slug), preferPackageSlug: true };
  }
  if ("agentId" in target) {
    const agent = getAgentById(String(target.agentId || ""));
    if (!agent) throw new Error("registered-agent-not-found");
    if (target.entityKind === "agent" && agent.kind === "team") throw new Error("registered-target-kind-mismatch");
    if (target.entityKind === "team" && agent.kind !== "team") throw new Error("registered-target-kind-mismatch");
    if (!agent.localPath || !fs.existsSync(agent.localPath) || !fs.statSync(agent.localPath).isDirectory()) {
      throw new Error("registered-agent-source-unavailable");
    }
    return { rootPath: agent.localPath, slug: publishSlugFromRegistrySlug(agent.slug), preferPackageSlug: true };
  }
  throw new Error("registered-upload-target-invalid");
}

export function registeredUploadOptions(): CloudAgentRegisteredUploadOption[] {
  const firms = listFirms();
  const firmMemberIds = new Set(firms.flatMap((firm) => firm.orgChart.map((node) => node.agentId)));
  const teamOptions = firms.map((firm): CloudAgentRegisteredUploadOption => {
    const ceo = getAgentById(firm.ceoAgentId);
    return {
      target: { entityKind: "team", firmId: firm.id },
      name: firm.nameEn || firm.name,
      slug: firm.slug,
      entityKind: "team",
      sourceReady: Boolean(ceo?.localPath && fs.existsSync(ceo.localPath)),
    };
  });
  const agentOptions = listInstalledAgents()
    .filter((agent) => agent.visibility !== "background" && !firmMemberIds.has(agent.id))
    .map((agent): CloudAgentRegisteredUploadOption => ({
      target: agent.kind === "team"
        ? { entityKind: "team", agentId: agent.id }
        : { entityKind: "agent", agentId: agent.id },
      name: agent.localDisplayName || agent.nameEn || agent.name,
      slug: agent.slug,
      entityKind: agent.kind === "team" ? "team" : "agent",
      sourceReady: Boolean(agent.localPath && fs.existsSync(agent.localPath)),
    }));
  return [...teamOptions, ...agentOptions];
}
