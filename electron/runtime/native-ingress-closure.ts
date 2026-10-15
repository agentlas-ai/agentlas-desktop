import type { NativeIngressBinding } from "../invocation/native-ingress-source";
const frontiers = new WeakMap<object, { binding: Readonly<NativeIngressBinding>; assertClosed(): void }>();
function missing(): never { throw Object.assign(new Error("native_ingress_closed_frontier_required"), { code: "native_ingress_closed_frontier_required" }); }
/** Bootstrap-owned probe over actual source state; never a wire or request factory. */
export function createNativeIngressClosureSource(binding: Readonly<NativeIngressBinding>, assertSourceClosed: () => void) {
  return Object.freeze({ capture(assertClosed: () => void): object {
    const verify = () => { assertSourceClosed(); assertClosed(); };
    verify(); const proof = Object.freeze({}); frontiers.set(proof, { binding, assertClosed: verify }); return proof;
  } });
}
export function readClosedNativeIngressFrontier(proof: object): Readonly<NativeIngressBinding> {
  const original = frontiers.get(proof); if (!original) missing(); original.assertClosed(); return original.binding;
}
export function consumeClosedNativeIngressFrontier(proof: object): void {
  readClosedNativeIngressFrontier(proof); frontiers.delete(proof);
}
