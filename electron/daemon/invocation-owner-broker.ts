import { randomUUID } from "node:crypto";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { ControlSocketPeer } from "./control-socket";

export type InvocationOwnerBrokerMethod = "invoke.currentTurn" | "invoke.steerCurrentTurn"
  | "invoke.currentTurnSteerReceipt" | "invoke.cancel";

export interface InvocationOwnerBrokerPorts {
  owners: { getRunOwner(chatId: string, runId: string): InvocationRunOwner | null };
  now?(): number;
  timeoutMs?: number;
  maxPending?: number;
}

export interface InvocationOwnerCompletion {
  requestId: string;
  ownerId: string;
  leaseId: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

type Registration = {
  peer: ControlSocketPeer;
  ownerId: string;
  ownerKind: "desktop" | "terminal";
  removeCloseListener: () => void;
};
type Pending = {
  owner: Readonly<InvocationRunOwner>;
  registration: Registration;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

function unavailable(): Error & { code: "invocation_owner_unavailable" } {
  return Object.assign(new Error("invocation_owner_unavailable"), { code: "invocation_owner_unavailable" as const });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f]/.test(value);
}

/** Only transports controls to the exact leased execution owner. Connection loss
 * ends pending transport requests, never durable custody or the underlying run. */
export function createInvocationOwnerBroker(ports: InvocationOwnerBrokerPorts) {
  const timeoutMs = ports.timeoutMs ?? 8_000;
  const maxPending = ports.maxPending ?? 128;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxPending) || maxPending < 1) throw unavailable();
  const now = ports.now ?? Date.now;
  const registrations = new Map<string, Registration>();
  const peers = new Map<ControlSocketPeer, Registration>();
  const pending = new Map<string, Pending>();
  let closed = false;

  function finish(requestId: string, error?: Error, result?: unknown): void {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  }

  function exactOwner(expected: Readonly<InvocationRunOwner>): boolean {
    try {
      const current = ports.owners.getRunOwner(expected.chatId, expected.runId);
      return !!current && current.chatId === expected.chatId && current.runId === expected.runId
        && current.ownerId === expected.ownerId && current.ownerKind === expected.ownerKind
        && current.leaseId === expected.leaseId && current.createdAt === expected.createdAt
        && (current.state === "active" || current.state === "settling");
    } catch { return false; }
  }

  function unregister(peer: ControlSocketPeer): void {
    const registration = peers.get(peer);
    if (!registration) return;
    peers.delete(peer);
    if (registrations.get(registration.ownerId) === registration) registrations.delete(registration.ownerId);
    try { registration.removeCloseListener(); } catch { /* Cleanup must still reject every pending control. */ }
    for (const [requestId, request] of pending) {
      if (request.registration === registration) finish(requestId, unavailable());
    }
  }

  return {
    registeredOwnerCount: () => registrations.size,
    isRegisteredOwner(ownerId: string): boolean {
      return !closed && registrations.has(ownerId);
    },

    register(peer: ControlSocketPeer, input: { ownerId: string; ownerKind: "desktop" | "terminal" }) {
      if (closed || !input || !validId(input.ownerId)
        || (input.ownerKind !== "desktop" && input.ownerKind !== "terminal")) throw unavailable();
      const prior = registrations.get(input.ownerId);
      const peerPrior = peers.get(peer);
      if (prior || peerPrior) {
        if (prior !== peerPrior || prior?.peer !== peer || prior.ownerKind !== input.ownerKind) throw unavailable();
        return { ownerId: prior.ownerId, ownerKind: prior.ownerKind };
      }
      const registration: Registration = { peer, ownerId: input.ownerId, ownerKind: input.ownerKind,
        removeCloseListener: () => {} };
      registrations.set(input.ownerId, registration);
      peers.set(peer, registration);
      try { registration.removeCloseListener = peer.onClose(() => unregister(peer)); }
      catch { unregister(peer); throw unavailable(); }
      // onClose may synchronously report an already disconnected connection.
      if (peers.get(peer) !== registration) {
        registration.removeCloseListener();
        throw unavailable();
      }
      return { ownerId: registration.ownerId, ownerKind: registration.ownerKind };
    },

    dispatch(owner: InvocationRunOwner, method: InvocationOwnerBrokerMethod, params: unknown): Promise<unknown> {
      try {
        if (closed || pending.size >= maxPending || !owner || !validId(owner.chatId)
          || !validId(owner.runId) || !validId(owner.ownerId) || !validId(owner.leaseId)
          || (owner.state !== "active" && owner.state !== "settling")
          || !["invoke.currentTurn", "invoke.steerCurrentTurn", "invoke.currentTurnSteerReceipt", "invoke.cancel"].includes(method)) {
          throw unavailable();
        }
        const registration = registrations.get(owner.ownerId);
        const expected = Object.freeze({ ...owner });
        if (!registration || registration.ownerKind !== expected.ownerKind || !exactOwner(expected)) throw unavailable();
        if (!params || typeof params !== "object" || Array.isArray(params)
          || !("chatId" in params) || params.chatId !== expected.chatId
          || ("expectedRunId" in params && params.expectedRunId !== expected.runId)) throw unavailable();
        const timestamp = now();
        if (!Number.isFinite(timestamp)) throw unavailable();
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(requestId, unavailable()), timeoutMs);
          const request: Pending = { owner: expected, registration, deadline: timestamp + timeoutMs, timer, resolve, reject };
          pending.set(requestId, request);
          try {
            if (!registration.peer.notify("invoke.ownerControl", { requestId, ownerId: expected.ownerId,
              leaseId: expected.leaseId, method, params, chatId: expected.chatId, runId: expected.runId })) {
              finish(requestId, unavailable());
            }
          } catch { finish(requestId, unavailable()); }
        });
      } catch { return Promise.reject(unavailable()); }
    },

    complete(peer: ControlSocketPeer, input: InvocationOwnerCompletion): boolean {
      if (closed || !input || typeof input.requestId !== "string") return false;
      const request = pending.get(input.requestId);
      if (!request || request.registration.peer !== peer || request.owner.ownerId !== input.ownerId
        || request.owner.leaseId !== input.leaseId) return false;
      // Object identity fences a disconnected peer's previous registration epoch.
      let timestamp: number;
      try { timestamp = now(); } catch { timestamp = NaN; }
      if (peers.get(peer) !== request.registration || registrations.get(input.ownerId) !== request.registration
        || !Number.isFinite(timestamp) || timestamp >= request.deadline || !exactOwner(request.owner)) {
        finish(input.requestId, unavailable());
        return false;
      }
      if (input.error !== undefined) {
        const error = input.error;
        if (!error || typeof error !== "object" || (error.code !== undefined && typeof error.code !== "string")
          || (error.message !== undefined && typeof error.message !== "string")) {
          finish(input.requestId, unavailable());
          return false;
        }
        finish(input.requestId, Object.assign(new Error(error.message ?? error.code ?? "invocation_owner_unavailable"),
          { code: error.code ?? "invocation_owner_unavailable" }));
      } else finish(input.requestId, undefined, input.result);
      return true;
    },

    unregister,

    close(): void {
      if (closed) return;
      closed = true;
      for (const peer of peers.keys()) unregister(peer);
      for (const requestId of pending.keys()) finish(requestId, unavailable());
    },
  };
}
