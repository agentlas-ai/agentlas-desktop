import { buildMcpConfigFile, isKeylessPlaywrightMcpDuplicate, type McpConfigBuildOptions, type McpConfigResult } from "../mcp-tools/mcp-config";
import { listInstalledServers } from "../mcp-tools/registry";
import { createCanonicalNativeBrowserGrant, type CanonicalNativeBrowserGrantInput } from "./main-browser-channel";

/** Prepare an exact native browser binding; a missing Main host never selects another profile. */
export async function buildNativeBrowserMcpConfig(
  options: McpConfigBuildOptions,
  browserScope: CanonicalNativeBrowserGrantInput | null,
): Promise<McpConfigResult | null> {
  if (!browserScope) {
    const selected = (id: string) => options.serverIds ? options.serverIds.includes(id)
      : options.catalogIds ? options.catalogIds.includes(id) : true;
    const requiresNative = options.catalogIds?.includes("agentlas-browser") || listInstalledServers().some(server => server.enabled
      && (selected(server.id) || !options.serverIds && server.catalogId !== null && selected(server.catalogId))
      && (server.catalogId === "agentlas-browser" || isKeylessPlaywrightMcpDuplicate(server)));
    if (requiresNative) throw new Error("native-browser-task-unbound");
    return buildMcpConfigFile(options);
  }
  browserScope.signal.throwIfAborted();
  const grant = await createCanonicalNativeBrowserGrant(browserScope);
  let config: McpConfigResult | null = null;
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    browserScope.signal.removeEventListener("abort", cleanup);
    try { config?.cleanup?.(); } finally { grant.release(); }
  };
  browserScope.signal.addEventListener("abort", cleanup, { once: true });
  try {
    browserScope.signal.throwIfAborted();
    config = await buildMcpConfigFile({ ...options, nativeBrowser: grant });
    browserScope.signal.throwIfAborted();
    if (!config) { cleanup(); return null; }
    if (!config.nativeBrowserBound) throw new Error("native-browser-config-unbound");
    return { ...config, cleanup };
  } catch (error) {
    // An abort may arrive while config creation is still pending. Its returned
    // resources are owned too, even if the grant was already revoked.
    if (released) config?.cleanup?.();
    else cleanup();
    throw error;
  }
}
