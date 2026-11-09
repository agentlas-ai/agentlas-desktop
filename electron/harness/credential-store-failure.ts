/*
 * A saved key the credential store could not read is not a key that is not saved.
 *
 * Production..22:58 (Yotube room, 3 runs): the Mac Keychain stopped answering for about an hour. The keyed
 * harness ports swallowed the read failure and answered "provider_key_missing" / "no_transcribe_route" ("the owner saves a
 * key ... in Settings") for an ElevenLabs key the owner had saved and used that same day, auth.login surfaced the raw
 * "keychain_unavailable: read [redacted] — automatic retry suppressed" text, and the team told the owner the key was not set.
 * The failure is the credential store's (the OS Keychain is locked, or waiting for the owner's allow), so it is said as that:
 * a typed refusal that names the real cause and the one place the owner clears it. No dependency: the daemon loads this.
 */

/** True for an error that means "the credential store did not answer", never for "no such key". */
export function isCredentialStoreFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "keychain_unavailable" || code === "credential_read_failed") return true;
  const name = (error as { name?: unknown }).name;
  return name === "KeychainUnavailableError" || name === "CredentialRecoveryStateError";
}

export const CREDENTIAL_STORE_UNAVAILABLE = "credential_store_unavailable";

/** One plain line for the model to pass on: the key is saved, the store is not answering, where the owner clears it. */
export const CREDENTIAL_STORE_NEXT = "the computer's saved-key storage (the macOS Keychain, Windows Credential Manager or Linux keyring) did not answer, so the owner's saved keys cannot be read right now; this is not a missing key and asking for it again will not help. It clears when the owner unlocks the storage or allows Agentlas to use it and presses Retry access on the Saved connection access needs attention card in Settings. Hold this step only, continue the rest, and call again later";
