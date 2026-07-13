import type { HephaestusBuildRequest } from "../../shared/types";
import { FsAccessDeniedError, pathFromGrant } from "../fs/access";
import { applyMcpBuildConsent } from "../mcp-tools/build-plan";
import type { ResolvedHephaestusBuildRequest } from "./builder";

/**
 * Resolve renderer-supplied capabilities into main-authoritative paths.
 * Raw renderer paths never become a builder cwd or attachment root.
 */
export function resolveHephaestusBuildRequest(
  request: HephaestusBuildRequest,
): ResolvedHephaestusBuildRequest {
  if ((request.attachments?.length ?? 0) > 64) {
    throw new FsAccessDeniedError("A build can include at most 64 attachments.");
  }
  const workspace = pathFromGrant(request.workspaceGrant, "directory");
  const attachments = request.attachments?.map((attachment) => ({
    path: pathFromGrant(attachment.grant),
    name: attachment.name,
  }));
  return {
    request: request.request,
    mode: request.mode,
    workspace,
    runtime: request.runtime,
    runtimePinned: request.runtimePinned === true,
    runtimeSessionId: request.runtimeSessionId,
    attachments,
    history: request.history,
    openCrabOntology: request.openCrabOntology === "use" ? "use" : request.openCrabOntology === "skip" ? "skip" : undefined,
    locale: request.locale,
  };
}

/**
 * Full run boundary: paths and MCP consent are both re-resolved in Main.
 * The original Build request, not a later interview answer, is bound to the plan.
 */
export async function resolveHephaestusBuildRequestForRun(
  request: HephaestusBuildRequest,
): Promise<ResolvedHephaestusBuildRequest> {
  const resolved = resolveHephaestusBuildRequest(request);
  const originalRequest = request.history?.find((entry) => entry.role === "user")?.text ?? request.request;
  const applied = await applyMcpBuildConsent({
    request: originalRequest,
    mode: request.mode,
    runtime: request.runtime,
    consent: request.mcpConsent,
  });
  return {
    ...resolved,
    runtime: applied.runtime ?? request.runtime,
    mcpAttachment: applied.attachment,
  };
}
