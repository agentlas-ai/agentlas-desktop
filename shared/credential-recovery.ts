/** Value-free Main-owned recovery handles. A renderer cannot choose a service or account. */
export interface CredentialRecoveryFailure {
  retryToken: string;
  kind: "api" | "api-metadata" | "env" | "secret";
  operation: "read" | "list";
  name: string | null;
  status: "unavailable" | "retrying";
  errorCode:
    | "keychain_unavailable"
    | "credential_attempt_incomplete"
    | "credential_recovery_state_invalid"
    | "credential_recovery_busy";
}

export interface CredentialRecoveryResult {
  status: "restored" | "missing" | "unavailable" | "invalid-token";
  /** Refreshed exact env row, produced in Main without a second credential read. */
  env?: { key: string; hasValue: boolean; preview: string | null };
}

/**
 * The failed credential reads a section's Retry button retries explicitly (owner decision 2026-10-24: "the Retry button
 * should actually retry the keys that failed"). Before, Settings > Multimodal "Retry" only reloaded the status, i.e. the
 * same automatic read the failure latch refuses, so nothing changed (VM 2026-10-24, shots/27). Selected: the env-key
 * listing failure (the status reads the stored names first) and each env key the section reads, also under a spelling the
 * Vault resolves to it (case and separators ignored, env-alias.ts). Nothing else: on macOS each explicit retry may show a
 * keychain prompt, so a section never retries keys it does not use. A retry already running is not started twice.
 */
export function credentialRetryTargets(failures: readonly CredentialRecoveryFailure[], envKeys: readonly string[]): CredentialRecoveryFailure[] {
  const fold = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const wanted = new Set(envKeys.map(fold));
  return failures.filter((failure) => failure.status !== "retrying"
    && (failure.operation === "list" || (failure.kind === "env" && failure.name !== null && wanted.has(fold(failure.name)))));
}
