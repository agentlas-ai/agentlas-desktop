/** Main-private effect references and exact provider-result projection evidence. No authority enters the wire DTO. */
const refsByResult = new WeakMap<object, readonly string[]>();
const invalidResults = new WeakSet<object>();
const proofs = new WeakMap<object, { refs: readonly string[]; body: string }>();
export function bindEffectRefs(result: object, refs: readonly string[]): void {
  if (invalidResults.has(result)) return;
  if (refsByResult.has(result)) { refsByResult.delete(result); invalidResults.add(result); return; }
  refsByResult.set(result, Object.freeze([...new Set(refs)]));
}
export function transferEffectRefs(from: object, to: object): void {
  if (from === to) return;
  const refs = refsByResult.get(from);
  if (refs) bindEffectRefs(to, refs);
}
/** Internal consumers call this only at their own confirmed handoff boundary. */
export function consumeEffectRefs(result: object): readonly string[] | undefined {
  const refs = refsByResult.get(result);
  if (refs) refsByResult.delete(result);
  return refs;
}
type Candidate = { result: object; projection: unknown; path: readonly (string | number)[] };
type Evidence = Readonly<object>;
/** Match each Main-recorded location and its exact projection against the serialized request. */
export function snapshotEffectDelivery(body: string, candidates: readonly Candidate[]): Evidence {
  const parsed: unknown = JSON.parse(body);
  const paths = new Set<string>();
  const refs: string[] = [];
  for (const {result, projection, path} of candidates) {
    const owned = refsByResult.get(result); if (!owned?.length) continue;
    const key = JSON.stringify(path); if (paths.has(key)) continue;
    let actual: unknown = parsed;
    for (const segment of path) {
      if (!actual || typeof actual !== 'object' || !Object.hasOwn(actual, segment)) { actual = undefined; break; }
      actual = (actual as Record<string | number, unknown>)[segment];
    }
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(projection)) continue;
    paths.add(key); refs.push(...owned);
  }
  const evidence = Object.freeze({});
  proofs.set(evidence, {refs: Object.freeze([...new Set(refs)]), body}); return evidence;
}
/** The adapter invokes this only after validating the terminal response to this same exact request. */
export async function confirmEffectDelivery(evidence: Evidence, body: string, valid: boolean, signal: AbortSignal | undefined,
  acknowledge: (ref: string) => Promise<unknown>): Promise<void> {
  const proof = proofs.get(evidence);
  if (!proof || proof.body !== body || !valid || signal?.aborted) return;
  for (const ref of proof.refs) {
    if (signal?.aborted) return;
    await acknowledge(ref);
  }
  proofs.delete(evidence);
}
