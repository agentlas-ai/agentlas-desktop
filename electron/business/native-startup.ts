import { createBusinessNativeComposition, type BusinessNativeCompositionPorts } from './native-composition';
import { createBusinessNativeActionComposition, createBusinessToolchainNativeActionComposition,
  type BusinessNativeActionCompositionPorts, type BusinessToolchainNativeCompositionPorts } from './native-action-composition';

/** These exact trusted ports belong to one authenticated authority domain. All
 * families receive the same session/identity/authority/registry object references.
 * No session, authority, SQLite registry or notification/TTL admission is fabricated. */
export type BusinessNativeStartupSharedPorts = Pick<BusinessNativeCompositionPorts,
  'sessions' | 'identity' | 'authority' | 'registry'>;
export type BusinessNativeStartupVaultPorts = Pick<BusinessNativeCompositionPorts, 'intents' | 'admission'>;
export type BusinessNativeStartupDataPorts = Pick<BusinessNativeActionCompositionPorts, 'contexts' | 'admission' | 'documents'>;
export type BusinessNativeStartupToolchainPorts = Pick<BusinessToolchainNativeCompositionPorts, 'contexts' | 'admission' | 'effects'>;
export interface BusinessNativeStartupInput {
  readonly shared: Readonly<BusinessNativeStartupSharedPorts>;
  readonly vault: Readonly<BusinessNativeStartupVaultPorts> | null;
  readonly data: Readonly<BusinessNativeStartupDataPorts> | null;
  readonly toolchains?: Readonly<BusinessNativeStartupToolchainPorts> | null;
}

/** Pure owner hookup factory. Import/construction does not register One authority,
 * activate an account/tenant/collector, open a DB, request a grant or dispatch effects.
 * One's sole routing owner consumes these exports and performs its once-only binding.
 * Absent family/owner ports are forwarded as null, retaining existing fail-closed
 * blocker codes and the separate Vault/data/document protocol guards. */
export function createBusinessNativeStartupBindings(input: BusinessNativeStartupInput, now: () => number = Date.now) {
  const shared = Object.freeze({
    sessions: input.shared.sessions,
    identity: input.shared.identity ?? null,
    authority: input.shared.authority ?? null,
    registry: input.shared.registry ?? null,
  });
  const vault = createBusinessNativeComposition({
    ...shared,
    intents: input.vault?.intents ?? null,
    admission: input.vault?.admission ?? null,
  }, now);
  const data = createBusinessNativeActionComposition({
    ...shared,
    contexts: input.data?.contexts ?? null,
    admission: input.data?.admission ?? null,
    documents: input.data?.documents ?? null,
  }, now);
  const toolchains = createBusinessToolchainNativeActionComposition({
    ...shared,
    contexts: input.toolchains?.contexts ?? null,
    admission: input.toolchains?.admission ?? null,
    effects: input.toolchains?.effects ?? null,
  }, now);
  let cleanupUnknown = false;
  return Object.freeze({
    vault,
    data,
    toolchains,
    /** Attempt all families unconditionally. An unconfirmed original cleanup remains
     * sticky; invalidating local authority is not an owner release acknowledgment. */
    invalidate(): void {
      for (const family of [vault, data, toolchains]) {
        try { family.invalidate(); } catch { cleanupUnknown = true; }
      }
      if (cleanupUnknown) throw new Error('business_native_cleanup_unconfirmed');
    },
  });
}
export type BusinessNativeStartupBindings = ReturnType<typeof createBusinessNativeStartupBindings>;
