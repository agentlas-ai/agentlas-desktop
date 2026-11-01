/**
 * Which refusals of a phone's Science chat request pass by themselves (the phone keeps the transcript and the message and shows one calm line).
 *
 * A closed list of the codes the Science daemon client and the chat commands raise when the Science host or its daemon is starting, handing off,
 * or briefly not answering. It replaces a substring test (`unavailable|not_ready|connection|timeout|closed`) that also matched refusals that do not
 * pass by themselves: a project folder or extension that is not available, an installed package that is missing, and the validation error
 * `science_daemon_request_timeout_invalid`. Those are the owner's state or a defect, and the phone must say so (the access sentence), not "not ready yet".
 *
 * No electron import: the bridge and the gates load this without Electron.
 */
const SELF_CLEARING_SCIENCE_CHAT_CODES: ReadonlySet<string> = new Set([
  "science_chat_unavailable",
  "science_daemon_not_ready",
  "science_daemon_unavailable",
  "science_daemon_admission_closed",
  "science_daemon_reply_timeout",
  "science_daemon_connect_timeout",
  "science_daemon_connection_closed",
  "science_daemon_connection_failed",
  "science_daemon_client_closed",
  "science_daemon_bootstrap_unavailable",
  "science_daemon_science_unavailable",
  "science_daemon_store_unavailable",
  "science-daemon-ipc-closed",
]);

export function scienceChatRefusalPassesByItself(code: string): boolean {
  return SELF_CLEARING_SCIENCE_CHAT_CODES.has(code);
}
