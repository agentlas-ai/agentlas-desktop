import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Renderer-provided channel IDs are UUID-only and may never replace an active controller. */
export function resolveInvocationRunId(
  requested: unknown,
  isActive: (runId: string) => boolean,
  generate: () => string = randomUUID,
): string {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !UUID_RE.test(requested)) {
      throw new Error("Invalid invocation runId");
    }
    if (isActive(requested)) throw new Error("Invocation runId is already active");
    return requested;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const generated = generate();
    if (UUID_RE.test(generated) && !isActive(generated)) return generated;
  }
  throw new Error("Could not allocate a unique invocation runId");
}

/** Chat renderer has one stream/stop surface; reject a second live run instead of making one unattachable. */
export function assertInvocationChatAvailable(
  chatId: unknown,
  activeRecords: Iterable<{ chatId: string }>,
): asserts chatId is string {
  if (typeof chatId !== "string" || !chatId.trim()) throw new Error("Invalid invocation chatId");
  for (const record of activeRecords) {
    if (record.chatId === chatId) throw new Error("This chat already has an active invocation");
  }
}
