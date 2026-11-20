/**
 * "Connected" for a subscription CLI, as one rule every screen reads (the Dashboard's Connections row, the model panel's note, Settings > Connections).
 *
 * Why one rule: a runtime ROW only says the command was found (Copilot is found through `npx`, so its row is there on every machine), and a CLI's sign-in
 * probe only says the account is signed in. Neither says the runtime accepts this account. The Dashboard drew "connected" from the row alone for the ACP
 * seats (no sign-in probe, so a missing kind read as "connected") while the model panel next to it said the model list could not be read and the log held a
 * 403: one fact, two words. The evidence, strongest first:
 *   1. a login failure a run met and nothing has cleared (`signInRequired`)         -> signed-out
 *   2. the runtime's own typed answer to its model listing: "not signed in"          -> signed-out
 *                                                           an account refusal (401/403) -> refused
 *   3. the live sign-in probe, for the CLIs that have one                            -> connected / signed-out / unverified
 *   4. no probe (an ACP seat): the session handshake - a model list, or an answered handshake that offers no model option -> connected
 * Anything else the evidence does not settle is `unverified`: it is never drawn as connected, and never as signed out.
 */
import { discoveryEntitlementRefused, discoverySignInRequired, type ModelDiscoverySummary } from "./model-discovery";
import type { RuntimeAuthState } from "./runtime-connect";

export type EngineConnectionState = "connected" | "signed-out" | "refused" | "unverified" | "not-installed";

export interface EngineConnectionInput {
  /** The runtime row Main detected for this engine; none = not installed (no row). */
  runtime: { modelDiscovery?: ModelDiscoverySummary; signInRequired?: unknown } | null | undefined;
  /** Does this engine have a live sign-in probe (the six `ConnectableRuntime` kinds)? An ACP seat such as GitHub Copilot does not. */
  hasProbe: boolean;
  /** The probe's answer; undefined while it has not answered. Only read when `hasProbe`. */
  probe?: RuntimeAuthState;
}

/** The one ACP answer that settles "the account works" without a model list: the handshake completed and the agent simply offers no model choice (acp.ts probeAcpModels). */
const ACP_HANDSHAKE_WITHOUT_MODEL_OPTION = "acp:no-model-config-option";

export function engineConnection(input: EngineConnectionInput): EngineConnectionState {
  const { runtime } = input;
  if (!runtime) return "not-installed";
  if (runtime.signInRequired) return "signed-out";
  const discovery = runtime.modelDiscovery;
  if (discovery?.status === "failed") {
    if (discoverySignInRequired(discovery.reason)) return "signed-out";
    if (discoveryEntitlementRefused(discovery.reason)) return "refused";
  }
  if (input.hasProbe) {
    if (input.probe === "signed-in") return "connected";
    if (input.probe === "signed-out") return "signed-out";
    return "unverified";
  }
  if (discovery?.status === "ok") return "connected";
  if (discovery?.status === "unsupported" && discovery.reason === ACP_HANDSHAKE_WITHOUT_MODEL_OPTION) return "connected";
  return "unverified";
}
