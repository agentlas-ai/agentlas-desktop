/**
 * Settings > Update "engine account" line, from Core `hephaestus auth status`.
 *
 * Core answers `refreshable` for a saved sign-in whose one-hour access token
 * aged out; the saved grant renews it silently on the next engine call. Reading
 * that as "not signed in" made the line say the engine was signed out after
 * every app update (the app restarts more than an hour after the last call),
 * and the owner signed in again by browser for nothing (2026-10-23, 1.3.88).
 * Newer Core renews before answering; this mapping also covers the bundled
 * older Core that still answers `refreshable`.
 */
export type CoreAccountState = "unknown" | "authenticated" | "signed_out";

export function coreAccountState(status: string | undefined): CoreAccountState {
  if (status === "authenticated" || status === "refreshable") return "authenticated";
  return status ? "signed_out" : "unknown";
}
