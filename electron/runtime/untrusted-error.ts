export const UNTRUSTED_RUNTIME_FAILURE_CODE = "agent-app-runtime-failed";
export const UNTRUSTED_RUNTIME_FAILURE_MESSAGE = "Agent App runtime failed.";

export type UntrustedRuntimeFailure = Error & { code: typeof UNTRUSTED_RUNTIME_FAILURE_CODE };

/**
 * Browser-originated runs must never carry a CLI error's stderr, executable
 * path, MCP config path, cwd, or environment details across the trust boundary.
 * Deliberately do not retain the original error as `cause`: generic Error
 * serializers and durable ledgers may otherwise expose it later.
 */
export function createUntrustedRuntimeFailure(): UntrustedRuntimeFailure {
  const error = new Error(UNTRUSTED_RUNTIME_FAILURE_MESSAGE) as UntrustedRuntimeFailure;
  error.name = "UntrustedRuntimeFailure";
  error.code = UNTRUSTED_RUNTIME_FAILURE_CODE;
  return error;
}

export function untrustedRuntimeFailurePayload(): {
  code: typeof UNTRUSTED_RUNTIME_FAILURE_CODE;
  message: typeof UNTRUSTED_RUNTIME_FAILURE_MESSAGE;
} {
  return {
    code: UNTRUSTED_RUNTIME_FAILURE_CODE,
    message: UNTRUSTED_RUNTIME_FAILURE_MESSAGE,
  };
}
