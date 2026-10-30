import type { ResolvedMcpBuildAttachment } from "../mcp-tools/attachment-resolver";
import type { McpConfigResult } from "../mcp-tools/mcp-config";
import type { RunnerRequest } from "../runtime/runner";

/** Keep native WeakMap witnesses when an empty/non-browser plan needs no rebinding. */
export function buildRunRequestWithAttachment<T extends { mcpAttachment?: ResolvedMcpBuildAttachment }>(
  request: T,
  attachment: ResolvedMcpBuildAttachment | undefined,
): T {
  return attachment === request.mcpAttachment ? request : { ...request, mcpAttachment: attachment };
}

/** Add the host-owned binding marker after the Build's environment allowlist. */
export function buildRunMcpRunnerBinding(
  config: McpConfigResult | null | undefined,
  env: NodeJS.ProcessEnv,
): Pick<RunnerRequest, "env" | "isolatedMcpConfig" | "ephemeralToolGrant"> {
  return config?.nativeBrowserBound ? { env: { ...env, AGENTLAS_NATIVE_BROWSER_SCOPE: "task" },
    isolatedMcpConfig: true, ephemeralToolGrant: true } : { env };
}

/** The actual Main-issued Build run owns fresh browser transports until it settles. */
export async function withBuildMcpAttachmentForRun<T>(
  attachment: ResolvedMcpBuildAttachment | undefined,
  runId: string,
  signal: AbortSignal,
  execute: (prepared: ResolvedMcpBuildAttachment | undefined) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let prepared = attachment;
  try {
    if (attachment?.prepareForBuildRun) prepared = await attachment.prepareForBuildRun(runId, signal);
    signal.throwIfAborted();
    return await execute(prepared);
  } finally {
    // The consent plan may be reused by a later interview turn. Only this
    // run's fresh config (and the recovery configs it owns) is revoked here.
    if (prepared !== attachment) prepared?.config?.cleanup?.();
  }
}
