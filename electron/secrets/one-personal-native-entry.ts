import { AsyncLocalStorage } from "node:async_hooks";
import type { McpInvocationRequest } from "../../shared/types";
import { authorizeSupervisorNativeOrigin } from "../one/supervisor-native-runtime";

export interface OnePersonalNativeOriginal {
  readonly origin: object;
  readonly request: Readonly<McpInvocationRequest>;
}

const originals = new AsyncLocalStorage<Readonly<OnePersonalNativeOriginal>>();

/** Keep the actual host capability in this process while execution clones its DTO.
 * This scope grants no storage, provider, resource or payment permission. */
export function withOnePersonalNativeOriginal<T>(
  origin: object,
  request: Readonly<McpInvocationRequest>,
  body: () => T,
): T {
  authorizeSupervisorNativeOrigin(origin, request);
  const original = Object.freeze(structuredClone(request));
  authorizeSupervisorNativeOrigin(origin, original);
  return originals.run(Object.freeze({ origin, request: original }), body);
}

/** Native consumers must still validate their own current grant and exact pending request. */
export function currentOnePersonalNativeOriginal(): Readonly<OnePersonalNativeOriginal> | null {
  const original = originals.getStore();
  if (!original) return null;
  authorizeSupervisorNativeOrigin(original.origin, original.request);
  return original;
}

/**
 * Run `body` outside any personal-native original that is current on this async stack.
 *
 * A turn that is started from inside another turn's code (a queued follow-up drained when the previous run settles)
 * would otherwise inherit that turn's original through AsyncLocalStorage: the new run then read the OLD run's already
 * settled source and failed with ordinary_one_turn_source_changed (condition=settled_phase_mode), seen on production
 * 1.2.96 at 2026-10-11 10:26Z and reproduced in the isolated QA app. Each run captures its own original.
 */
export function withoutOnePersonalNativeOriginal<T>(body: () => T): T {
  return originals.exit(body);
}
