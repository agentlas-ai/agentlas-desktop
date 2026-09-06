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

/** Shared selection guard: inaccessible credentials cannot authorize fallback. */
export function isRuntimeCredentialUnavailable(
  runtime: { credentialAccess?: { status: string } } | null | undefined,
): boolean {
  return runtime?.credentialAccess?.status === "unavailable";
}
