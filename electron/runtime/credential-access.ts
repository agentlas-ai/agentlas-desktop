/** Credential presence and a failed read are different observations. */
export type RuntimeCredentialProbe =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable"; errorCode: "keychain_unavailable" | "credential_read_failed" };

/** A single injected read; never retries, logs credentials, or interprets prose. */
export async function probeRuntimeCredentialAccess(
  check: () => Promise<boolean>,
): Promise<RuntimeCredentialProbe> {
  try {
    const present = await check();
    if (present === true) return { status: "available" };
    if (present === false) return { status: "missing" };
    return { status: "unavailable", errorCode: "credential_read_failed" };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return {
      status: "unavailable",
      errorCode: code === "keychain_unavailable" ? "keychain_unavailable" : "credential_read_failed",
    };
  }
}

/**
 * The machine code of the refusal a turn gets while the selected saved key cannot be read (selection.ts). The OS keychain, not
 * the provider, refused: nothing was sent, no sign-in expired, and the key may be readable again the next minute. So this
 * code is never recorded as a runtime cooldown or "signed out" (runtime-cooldown.ts) and never offers a CLI sign-in.
 */
export const RUNTIME_CREDENTIAL_UNAVAILABLE_CODE = "byok_credential_unavailable";

/** Shared selection guard: inaccessible credentials cannot authorize fallback. */
export function isRuntimeCredentialUnavailable(
  runtime: { credentialAccess?: { status: string } } | null | undefined,
): boolean {
  return runtime?.credentialAccess?.status === "unavailable";
}
