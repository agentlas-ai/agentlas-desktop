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
