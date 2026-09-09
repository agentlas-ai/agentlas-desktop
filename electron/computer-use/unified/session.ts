import { createUnifiedComputerUse } from "./adapter";
import type { BrowserTransport, NativeTransport, UnifiedComputerUse } from "./types";

export interface UnifiedComputerUseSessionBinding {
  /** Caller-owned composite identity, for example `one:<session>:<run>`. */
  bindingKey: string;
  runId: string;
  browser?: BrowserTransport;
  native?: NativeTransport;
}

interface BoundSession {
  api: UnifiedComputerUse;
  controller: AbortController;
}

function identifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || value.length > 512) throw new Error(`unified-cua-${label}-required`);
  return value;
}

function scopedBrowser(transport: BrowserTransport | undefined, signal: AbortSignal): BrowserTransport | undefined {
  if (!transport) return undefined;
  return {
    browserId: transport.browserId,
    async call(tool, args) {
      if (signal.aborted) throw new Error("unified-cua-session-revoked");
      const invoke = transport.call as (tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>;
      return invoke.call(transport, tool, args, signal);
    },
  };
}

function scopedNative(transport: NativeTransport | undefined, signal: AbortSignal): NativeTransport | undefined {
  if (!transport) return undefined;
  return {
    ...(transport.platform ? { platform: transport.platform } : {}),
    async call(tool, args) {
      if (signal.aborted) throw new Error("unified-cua-session-revoked");
      const invoke = transport.call as (tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>;
      return invoke.call(transport, tool, args, signal);
    },
  };
}

/**
 * Runtime-owned persistent object registry. It stores API objects, never grants
 * or raw endpoints. Revoking a run disposes the object and its scoped callbacks.
 * The runtime remains responsible for forwarding AbortSignal through each
 * callback to its ordinary MCP invocation path.
 */
export class UnifiedComputerUseSessions {
  private readonly sessions = new Map<string, BoundSession>();

  bind(binding: UnifiedComputerUseSessionBinding): UnifiedComputerUse {
    const bindingKey = identifier(binding.bindingKey, "binding-key");
    identifier(binding.runId, "run-id");
    const previous = this.sessions.get(bindingKey);
    if (previous) previous.controller.abort("unified-cua-session-rebound");
    const controller = new AbortController();
    const api = createUnifiedComputerUse({
      browser: scopedBrowser(binding.browser, controller.signal),
      native: scopedNative(binding.native, controller.signal),
    });
    this.sessions.set(bindingKey, { api, controller });
    return api;
  }

  get(bindingKey: string): UnifiedComputerUse | undefined {
    return this.sessions.get(bindingKey)?.api;
  }

  revoke(bindingKey: string): boolean {
    const bound = this.sessions.get(bindingKey);
    if (!bound) return false;
    bound.controller.abort("unified-cua-session-revoked");
    return this.sessions.delete(bindingKey);
  }

  clear(): void {
    for (const bound of this.sessions.values()) bound.controller.abort("unified-cua-sessions-cleared");
    this.sessions.clear();
  }
}
