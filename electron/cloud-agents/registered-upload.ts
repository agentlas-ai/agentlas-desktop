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
    /*
     * ★올릴 꾸러미가 애초에 없는 것은 후보로 보여주지 않는다.
     *
     * 이 목록은 설치된 것을 **전부** 후보로 올렸다. 그래서 One 에서 만든 **좌석**이
     * 여기 끼어들어 "원본 폴더 없음"으로 비활성인 채 늘 떠 있었다. 좌석은 사무실 자리이지
     * 올릴 물건이 아니다 — 앉는 사람은 언제든 바뀐다. 그런데 목록이 그것을 "올릴 수는
     * 있는데 뭔가 빠진 것"처럼 보여주니, 사람이 그 앞에서 무엇이 잘못됐는지 찾게 된다.
     * (2026-08-26: 내가 그 줄을 보고 "One 팀원을 Cloud 에 못 올리는 결함"으로 읽었다.
     *  결함이 아니라 애초에 올리는 물건이 아니었다.)
     *
     * 경계는 "폴더를 가진 적이 있는가"다. 폴더가 등록돼 있는데 지금 사라진 것은 계속
     * 보여준다 — 그건 진짜로 올릴 수 있었던 물건이고, 왜 지금 안 되는지 말해 주는 것이
     * 정직하다. 가진 적조차 없는 것만 뺀다.
     */
    .filter((agent) => Boolean(agent.localPath))
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
