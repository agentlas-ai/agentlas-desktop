import os from "node:os";
import { redactRunEventSensitiveText } from "../store/run-events";

/** Longest cause text a wait refusal keeps. A ledger row names the exception; it does not carry the whole message. */
export const WAIT_REFUSAL_CAUSE_MAX = 120;

/**
 * A short, bounded, redacted cause for a wait that failed with an exception the host has no code for.
 *
 * Every such failure used to be recorded as `goal_wait_registration_failed` and nothing else (observed in use: 168 ledger
 * rows), so a database lock, an authority gap and a bug could not be told apart afterwards. This keeps the exception's name, its
 * own code when it has one, and the first characters of its message: secrets are redacted (the run-event redaction), the home
 * folder is shortened and the text is cut. It is a diagnostic string only; no decision reads it.
 */
export function boundedWaitRefusalCause(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let text = `${name}${typeof code === "string" && code && code !== message ? `(${code.slice(0, 40)})` : ""}${message ? `: ${message}` : ""}`
    .replace(/\s+/g, " ").trim();
  try {
    const home = os.homedir();
    if (home && home.length > 1) text = text.split(home).join("~");
  } catch { /* the home folder is a cosmetic shortening only */ }
  text = redactRunEventSensitiveText(text);
  return text.length > WAIT_REFUSAL_CAUSE_MAX ? text.slice(0, WAIT_REFUSAL_CAUSE_MAX) : text;
}
