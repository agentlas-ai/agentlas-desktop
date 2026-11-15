import type { RuntimeSelection } from "../../shared/types";

/*
 * The runtime a turn started on, kept in memory for the few moments between its start and its settlement, so a follow-up that wants "the model this
 * session used" (the automatic session title, chat/session-title.ts) can read it without a second lookup or a stored row. Written once per run where the
 * turn confirms its runtime (mcp/client.ts, beside the [runtime-selection] line); read-and-removed when the run settles (the title listener takes it for
 * every settled run, whether or not it needs it). Bounded: the oldest note goes first, so a run that never settles cannot grow it.
 * The host that runs the turn is the host that settles it, so Main and the background service each hold their own turns' notes.
 */
const MAX_NOTES = 128;
const notes = new Map<string, Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId" | "label">>();

export function noteTurnRuntime(runId: string | undefined, runtime: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId" | "label">): void {
  if (!runId) return;
  notes.delete(runId);
  notes.set(runId, { kind: runtime.kind, backend: runtime.backend, source: runtime.source, model: runtime.model, acpAgentId: runtime.acpAgentId, label: runtime.label });
  while (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value as string);
}

/** The runtime the run started on, removed from memory; undefined when the run never confirmed one. */
export function takeTurnRuntime(runId: string | undefined): ReturnType<typeof notes.get> {
  if (!runId) return undefined;
  const found = notes.get(runId);
  notes.delete(runId);
  return found;
}
