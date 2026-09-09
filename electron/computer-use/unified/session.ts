import { createUnifiedComputerUse } from "./adapter";
import type { BrowserTransport, NativeTransport, UnifiedComputerUse } from "./types";

export interface UnifiedComputerUseSessionBinding {
  runId: string;
  browser?: BrowserTransport;
  native?: NativeTransport;
}

/**
 * Runtime-owned persistent object registry. It stores API objects, never grants
 * or raw endpoints. Revoking a run disposes the object and its scoped callbacks.
 * The runtime remains responsible for forwarding AbortSignal through each
 * callback to its ordinary MCP invocation path.
 */
export class UnifiedComputerUseSessions {
  private readonly sessions = new Map<string, UnifiedComputerUse>();

  bind(binding: UnifiedComputerUseSessionBinding): UnifiedComputerUse {
    if (!binding.runId.trim()) throw new Error("unified-cua-run-id-required");
    const api = createUnifiedComputerUse({ browser: binding.browser, native: binding.native });
    this.sessions.set(binding.runId, api);
    return api;
  }

  get(runId: string): UnifiedComputerUse | undefined {
    return this.sessions.get(runId);
  }

  revoke(runId: string): boolean {
    return this.sessions.delete(runId);
  }

  clear(): void {
    this.sessions.clear();
  }
}
