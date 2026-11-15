/*
 * What a real call proved about the KEYS of a connected app (Agentlas 2.0 VD item 1; section 4, the server's own rule for a key it takes: "saved" until a real call, "connected" only after one).
 *
 * A connection that holds keys is "connected" only when the provider ACCEPTED them in a real call. Two kinds of call exist here, and only a status code (never a sentence of an error) says what happened:
 *   - a REMOTE server (http / sse) authenticates at connect time: the probe (initialize + tools/list, `testServerConnection`) with the saved key either lists the tools (the provider took the key: `verified`),
 *     is refused with 401 / 403 (`rejected`, `keyRetry: "tap"` - only the owner can change a wrong key) or does not answer with a status the provider would give for a bad key (429, 5xx, a connection that
 *     fails before any status: `provider_down`, `keyRetry: "auto"` - nothing is wrong with the key; the next status read asks again, no timer and no loop of this file).
 *   - a LOCAL program (stdio) starts and lists its tools whether or not its key is right (the key is only used when a tool calls the provider), so the probe proves the program, not the key: `saved`. The first tool
 *     call that returns a result that is not an error (client.ts `markKeyProven`) turns it into `verified` for exactly those key values (the digest changes with the key; a new key is `saved` again).
 * A connection with no keys has no verdict (null): OAuth and keyless servers keep the states they had.
 *
 * Nothing here reads a word of an error or of a result. The proofs are kept in memory only, bounded; after a restart a local program is `saved` until its first good call (no new table or column: what the
 * provider accepted is a fact of this run, and a stored "accepted" would outlive the key it was about).
 * No Electron import (the daemon loads mcp-tools too).
 */
import { createHash } from "node:crypto";
import { getEnvConfigurationRevision } from "../secrets/vault";

export type KeyVerdict = "verified" | "saved" | "rejected" | "provider_down";
export type KeyRetry = "auto" | "tap";
export interface KeyVerdictFields { keyVerdict: KeyVerdict; keyRetry?: KeyRetry }

interface ServerFacts { transport: string; envKeys: readonly string[] }
interface StatusFacts { connected: boolean; tools: readonly unknown[]; missingEnv: readonly string[]; failureCode?: string; httpStatus?: number; deferred?: string }

/** The verdict of one probe, from facts only. `proven`: a real tool call with exactly these key values returned a result that was not an error. */
export function keyVerdictOf(server: ServerFacts, status: StatusFacts, proven: boolean): KeyVerdictFields | null {
  if (server.envKeys.length === 0) return null;
  if (status.missingEnv.length > 0 || status.failureCode === "configuration_missing" || status.deferred) return null;
  const remote = server.transport !== "stdio";
  if (status.connected) {
    if (status.tools.length === 0) return null;
    return remote || proven ? { keyVerdict: "verified" } : { keyVerdict: "saved" };
  }
  const code = status.httpStatus;
  if (code === 401 || code === 403 || status.failureCode === "authentication_required") return { keyVerdict: "rejected", keyRetry: "tap" };
  if (remote && (code === 429 || (typeof code === "number" && code >= 500) || (code === undefined && status.failureCode === "connection_unavailable"))) return { keyVerdict: "provider_down", keyRetry: "auto" };
  return null;
}

/** The same digest of the resolved key values the call session already uses (client.ts), so a proof is about these values and no others. */
export function credentialDigestOf(resolved: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
}

/**
 * basis for 256: the same bound as the tool readiness observations (one/tool-readiness.ts keeps at most 256); a person has far fewer connected apps. Past it the oldest proof goes (that app reads `saved`
 * again until its next good call - never a false `verified`).
 */
const PROOF_MAX = 256;
const proofs = new Map<string, { digest: string | null; revision: number | null }>();
function remember(serverId: string, entry: { digest: string | null; revision: number | null }): void {
  proofs.delete(serverId); proofs.set(serverId, entry);
  if (proofs.size > PROOF_MAX) proofs.delete(proofs.keys().next().value as string);
}
/** A good call made by this app's own MCP client, which knows the key values it used: the proof is about exactly those values. */
export function markKeyProven(serverId: string, digest: string): void { remember(serverId, { digest, revision: null }); }
/**
 * A good call made through the proxy a subscription CLI talks to (proxy-session.ts): the CLI's own program holds the key values, this app does not see them. The proof is then about "the saved keys as they are now":
 * it holds until ANY key of the vault changes (`getEnvConfigurationRevision` moves on every save / delete) - coarser than a digest, never a false `verified`.
 */
export function markKeyProvenNow(serverId: string): void { remember(serverId, { digest: null, revision: getEnvConfigurationRevision() }); }
export function isKeyProven(serverId: string, digest: string): boolean {
  const entry = proofs.get(serverId);
  return !!entry && (entry.digest === digest || (entry.revision !== null && entry.revision === getEnvConfigurationRevision()));
}
export function forgetKeyProof(serverId: string): void { proofs.delete(serverId); }
export function _resetKeyProofsForTests(): void { proofs.clear(); }
