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
