import { randomUUID } from "node:crypto";

/** Ownership of one unsaved Graph authoring request, scoped to its actual window. */
interface AuthoringSender {
  id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export class GraphAuthoringError extends Error {
  constructor(readonly code: "GRAPH_AUTHORING_CANCELLED" | "GRAPH_AUTHORING_TIMEOUT" | "GRAPH_AUTHORING_REQUEST_INVALID") {
    super(code);
  }
}

const active = new Map<string, AbortController>();
// A cancellation can arrive before an asynchronous handler reaches admission.
// Remember it for the same maximum request lifetime; there is no independent timer loop.
const closed = new Map<string, number>();
const MAX_REQUEST_MS = 120_000;

function requestKey(senderId: number, requestId: unknown): string {
  if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 128) {
    throw new GraphAuthoringError("GRAPH_AUTHORING_REQUEST_INVALID");
  }
  return `${senderId}:${requestId}`;
}

function pruneClosed(): void {
  const now = Date.now();
  for (const [key, expiry] of closed) if (expiry <= now) closed.delete(key);
}

export function cancelGraphAuthoringRequest(senderId: number, requestId: unknown): void {
  const key = requestKey(senderId, requestId);
  pruneClosed();
  closed.set(key, Date.now() + MAX_REQUEST_MS);
  active.get(key)?.abort(new GraphAuthoringError("GRAPH_AUTHORING_CANCELLED"));
}

export function beginGraphAuthoringRequest(sender: AuthoringSender, requestId?: unknown) {
  const id = requestId === undefined ? randomUUID() : requestId;
  const key = requestKey(sender.id, id);
  pruneClosed();
  if (closed.has(key) || active.has(key) || sender.isDestroyed()) {
    throw new GraphAuthoringError("GRAPH_AUTHORING_CANCELLED");
  }
  const controller = new AbortController();
  const deadline = Date.now() + MAX_REQUEST_MS;
  active.set(key, controller);
  const destroyed = () => controller.abort(new GraphAuthoringError("GRAPH_AUTHORING_CANCELLED"));
  sender.once("destroyed", destroyed);
  const timer = setTimeout(() => controller.abort(new GraphAuthoringError("GRAPH_AUTHORING_TIMEOUT")), MAX_REQUEST_MS);
  let finished = false;
  return {
    requestId: id as string,
    signal: controller.signal,
    deadline,
    assertCurrent(): void {
      // The absolute clock closes the gap when the event loop delays the timer.
      if (Date.now() >= deadline) {
        controller.abort(new GraphAuthoringError("GRAPH_AUTHORING_TIMEOUT"));
        throw new GraphAuthoringError("GRAPH_AUTHORING_TIMEOUT");
      }
      if (controller.signal.aborted || sender.isDestroyed() || active.get(key) !== controller) {
        throw new GraphAuthoringError("GRAPH_AUTHORING_CANCELLED");
      }
    },
    finish(): void {
      if (finished) return;
      finished = true;
      controller.abort(new GraphAuthoringError("GRAPH_AUTHORING_CANCELLED"));
      clearTimeout(timer);
      sender.removeListener("destroyed", destroyed);
      if (active.get(key) === controller) active.delete(key);
      closed.set(key, Date.now() + MAX_REQUEST_MS);
    },
  };
}
