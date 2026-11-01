/**
 * Refusals of a phone request that the owner can act on, with a code of their own.
 *
 * Every error the Desktop authority throws reached the phone as `authority_error` / "Desktop rejected the request" (server.ts), so the
 * phone could only say "The request could not be completed. Please try again shortly." for a project with no working folder, a
 * runtime whose sign-in ended, a conversation that is still running. These few causes now carry their own code. The sentence is
 * the phone's (localized); the `message` stays the Desktop's fixed English text, which is what every phone printed before.
 *
 * Only a phone that reported the `refusal.specific.v1` capability (device.capabilities) receives them; every other phone keeps
 * `authority_error`, byte for byte. The One supervisor (one.supervisor.*) and history paging also keep `authority_error`: the phone
 * treats exactly that code as a settled refusal there (personal_one_controller.dart _settledRefusals, the history cursor fallback).
 *
 * No electron import: the bridge server, the authority and the gates load this without Electron.
 */
export const MOBILE_BRIDGE_SPECIFIC_REFUSAL_CODES = [
  /** The project has no connected working folder: connect one on Desktop. */
  "project_folder_missing",
  /** The project is gone from this Desktop (deleted, or another Desktop's): refresh the list. */
  "project_unavailable",
  /** The AI the phone picked is not available on this Desktop (not installed, off, model or effort not offered). */
  "runtime_unavailable",
  /** The AI the phone picked needs its sign-in again on this Desktop. */
  "runtime_credential_unavailable",
  /** The conversation is running: Stop it first. */
  "chat_still_running",
  /** Stop was asked for a run that has already ended. */
  "run_no_longer_active",
] as const;
export type MobileBridgeSpecificRefusalCode = (typeof MOBILE_BRIDGE_SPECIFIC_REFUSAL_CODES)[number];

const CODES: ReadonlySet<string> = new Set(MOBILE_BRIDGE_SPECIFIC_REFUSAL_CODES);

export class MobileBridgeRefusal extends Error {
  readonly code: MobileBridgeSpecificRefusalCode;
  constructor(code: MobileBridgeSpecificRefusalCode, message: string) {
    super(message);
    this.name = "MobileBridgeRefusal";
    this.code = code;
  }
}

/** The typed refusal of a thrown value, or null. Only an instance thrown by the authority counts: a plain `.code` never does. */
export function mobileBridgeSpecificRefusal(error: unknown): { code: MobileBridgeSpecificRefusalCode; message: string } | null {
  if (!(error instanceof MobileBridgeRefusal) || !CODES.has(error.code)) return null;
  return { code: error.code, message: error.message };
}
