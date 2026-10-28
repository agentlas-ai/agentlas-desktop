/**
 * Agentlas Enterprise release-signing trust roots compiled into this Desktop (Ed25519 raw public keys, base64url).
 *
 * The same list as agentlas_enterprise_server/src/license/trust-roots.mjs (server 1192eb6). Official root `ar_2026_10`
 * was created in the owner's root key ceremony on 2026-10-24 (docs/enterprise-server/02-LICENSE-PROTOCOL.md §2); only
 * the PUBLIC half lives here. A Windows/Linux Desktop that takes its updates from a company mirror verifies the
 * cloud-signed release manifest against these roots (updater/release-integrity.ts) and refuses the update otherwise.
 * Rotating the root needs a Desktop release carrying both roots (§8).
 *
 * There is no environment or file override: a value that could be swapped at run time would not be a root of trust.
 * Tests pass throwaway roots to the pure verifier directly.
 */
export interface ReleaseTrustRoot {
  readonly root: string;
  readonly publicKey: string;
}

export const OFFICIAL_RELEASE_TRUST_ROOTS: readonly ReleaseTrustRoot[] = Object.freeze([
  Object.freeze({ root: "ar_2026_10", publicKey: "iLiPu2zKQImJak8pepq6VO_NR8ZcQxhwbWp5ucj1Id0" }),
]);

/** Signing key ids withdrawn after a compromise. Shipped with Desktop releases, mirrored from the server list. */
export const REVOKED_RELEASE_SIGNING_KIDS: readonly string[] = Object.freeze([]);
