import type { createBusinessNativeComposition } from '../business/native-composition';
import type { createBusinessNativeActionComposition } from '../business/native-action-composition';
import { BUSINESS_NATIVE_DATA_ACTIONS } from '../../shared/business/native-action-ports';
import { configureOneBusinessAuthority } from '../one/action-authority';
import type { OneVaultRuntimePolicy } from './one-vault-runtime';

type BusinessNativeComposition = ReturnType<typeof createBusinessNativeComposition>;
type BusinessNativeActionComposition = ReturnType<typeof createBusinessNativeActionComposition>;

/** Route the single One authority to its exact native protocol. An unknown data
 * decision cannot acquire the unrelated Vault admission. */
export function oneBusinessNativeActionAuthority(
  vault: BusinessNativeComposition,
  data: BusinessNativeActionComposition | null,
) {
  return Object.freeze({ current: (request: Parameters<BusinessNativeComposition['actionAuthority']['current']>[0]) => {
    if ((BUSINESS_NATIVE_DATA_ACTIONS as readonly string[]).includes(request.action)) {
      return data?.actionAuthority.current(request) ?? { decision: 'unknown' as const, revision: '', reason: 'business_native_data_admission_unbound' };
    }
    if (request.action.startsWith('vault-') || request.action.startsWith('provider-')) return vault.actionAuthority.current(request);
    return { decision: 'deny' as const, revision: '', reason: 'business_native_action_protocol_unknown' };
  } });
}

/** Bind the existing Business admission once; importing this adapter activates no tenant or grant. */
export function composeOneVaultBusinessPolicy(
  personal: OneVaultRuntimePolicy,
  business: BusinessNativeComposition,
  data: BusinessNativeActionComposition | null = null,
): OneVaultRuntimePolicy {
  configureOneBusinessAuthority(oneBusinessNativeActionAuthority(business, data));
  return Object.freeze({
    ...personal,
    async prepareAuthority(binding, phase) {
      if (binding.scope === 'organization') return business.prepareVaultAuthority(binding, phase);
      if (personal.prepareAuthority) return personal.prepareAuthority(binding, phase);
      return personal.currentGrant(binding, phase);
    },
    async currentGrant(binding, phase) {
      if (binding.scope === 'organization') return business.currentVaultGrant(binding, phase);
      return personal.currentGrant(binding, phase);
    },
    // Retained effects use a distinct source/ACL admission. The active-work composition cannot authorize them.
    prepareRecoveryAuthority: personal.prepareRecoveryAuthority,
  } satisfies OneVaultRuntimePolicy);
}
