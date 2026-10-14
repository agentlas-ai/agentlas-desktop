/** Native occurrence custody identifies one already-authorized logical request.
 * It grants no tool permission and never crosses a JSON/IPC boundary. */
export interface GraphOccurrenceBinding {
  automationId: string;
  occurrenceId: string;
  graphDigest: string;
}
declare const graphOccurrenceCustodyBrand: unique symbol;
export type GraphOccurrenceCustody = { readonly [graphOccurrenceCustodyBrand]: true };
interface Entry {
  binding: GraphOccurrenceBinding;
  assertCurrent(): void;
  active: boolean;
  runId: string | null;
}
const custody = new WeakMap<GraphOccurrenceCustody, Entry>();
function refuses(): never { throw new Error("graph_occurrence_custody_changed"); }
function same(a: GraphOccurrenceBinding, b: GraphOccurrenceBinding): boolean {
  return a.automationId === b.automationId && a.occurrenceId === b.occurrenceId && a.graphDigest === b.graphDigest;
}

/** Call only in the owning native ingress, after its actual claim/owner checks.
 * The native callback revalidates those same fences at every dispatch. */
export async function withGraphOccurrenceCustody<T>(binding: GraphOccurrenceBinding,
  assertCurrent: () => void, execute: (token: GraphOccurrenceCustody) => Promise<T>): Promise<T> {
  if (!binding.automationId || !binding.occurrenceId || binding.occurrenceId.length > 240
    || binding.occurrenceId.includes("\0") || !/^sha256:[a-f0-9]{64}$/.test(binding.graphDigest)
    || typeof assertCurrent !== "function") refuses();
  assertCurrent();
  const token = Object.freeze({}) as GraphOccurrenceCustody;
  const entry: Entry = { binding: Object.freeze({ ...binding }), assertCurrent, active: true, runId: null };
  custody.set(token, entry);
  try { return await execute(token); }
  finally { entry.active = false; custody.delete(token); }
}

export function claimGraphOccurrenceCustody(token: GraphOccurrenceCustody, binding: GraphOccurrenceBinding, runId: string): void {
  const entry = custody.get(token);
  if (!entry?.active || entry.runId !== null || !runId || !same(entry.binding, binding)) refuses();
  entry.assertCurrent();
  entry.runId = runId;
}

export function assertGraphOccurrenceCustody(token: GraphOccurrenceCustody,
  binding: GraphOccurrenceBinding, runId: string): void {
  const entry = custody.get(token);
  if (!entry?.active || entry.runId !== runId || !same(entry.binding, binding)) refuses();
  entry.assertCurrent();
}

/** A declared child inherits the current parent's custody, never a DTO grant. */
export async function withChildGraphOccurrenceCustody<T>(parent: GraphOccurrenceCustody,
  parentBinding: GraphOccurrenceBinding, parentRunId: string, childBinding: GraphOccurrenceBinding,
  assertChildCurrent: () => void, execute: (token: GraphOccurrenceCustody) => Promise<T>): Promise<T> {
  const assertCurrent = () => {
    assertGraphOccurrenceCustody(parent, parentBinding, parentRunId);
    assertChildCurrent();
  };
  return withGraphOccurrenceCustody(childBinding, assertCurrent, execute);
}
