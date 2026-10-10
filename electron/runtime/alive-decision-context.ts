import type { AgentContextCapability } from "./agent-context";
import type { RunnerRequest } from "./runner";

/** Host-only no-tools continuation. Neither a renderer flag nor a copied
 * object can opt a native process into this profile. */
export interface AliveDecisionProfile {
  readonly kind: "alive-no-tools";
  readonly lifeAgentId: string;
  readonly wakeId: string;
  readonly resourceOwnerKey: string;
  readonly bindingKey: string;
  readonly maxHistoryChars: 8192;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Lifetime assertion, independent of a completed wake's turn fence. */
  retainResource(): boolean;
  /** Auxiliary gateway lifetime only. Resident native processes must also
   * use the canonical pool's atomic residency admission. */
  registerResource(key: string, close: () => void | Promise<void>): () => void;
}
interface Held {
  profile: Readonly<AliveDecisionProfile>;
  agentId: string;
  model: string | undefined;
  runtimeSource: RunnerRequest["runtimeSource"];
  schema: string;
}
const profiles = new WeakMap<AgentContextCapability, Held>();
function fail(): never { throw Object.assign(new Error("alive_decision_profile_changed"), { code: "alive_decision_profile_changed" }); }
/** Called only by the daemon decision port inside its current actor turn. */
export function registerAliveDecisionProfile(capability: AgentContextCapability, request: RunnerRequest,
  profile: AliveDecisionProfile): () => void {
  if (profiles.has(capability) || !request.agentId || request.agentContext !== capability) fail();
  profile.assertCurrent();
  const assertActive = () => { if (profiles.get(capability) !== held) fail(); profile.assertCurrent(); };
  const held: Held = { profile: Object.freeze({ ...profile, assertCurrent: assertActive,
    registerResource(key: string, close: () => void | Promise<void>) { assertActive(); return profile.registerResource(key, close); },
  }), agentId: request.agentId,
    model: request.model, runtimeSource: request.runtimeSource, schema: JSON.stringify(request.outputSchema) };
  profiles.set(capability, held);
  aliveDecisionProfileForRequest(request);
  return () => { if (profiles.get(capability) === held) profiles.delete(capability); };
}
export function aliveDecisionProfileForRequest(request: RunnerRequest): Readonly<AliveDecisionProfile> | null {
  if (!request.agentContext) return null;
  const held = profiles.get(request.agentContext);
  if (!held) return null;
  const max = request.maxOutputTokens;
  if (request.agentId !== held.agentId || request.model !== held.model || request.runtimeSource !== held.runtimeSource
    || request.chatId !== undefined || request.permission !== "read" || request.untrustedNoTools !== true
    || request.judgmentOnly !== true || request.surfaceGate !== "exclude" || request.longContext !== false
    || request.cwd !== undefined || request.mcpConfigPath !== undefined || request.toolBrokerSettingsPath !== undefined
    || request.toolBrokerPluginDir !== undefined || request.workforceRuntimeToolGrant !== undefined
    || request.mcpAllowedTools?.length || request.mcpCodexConfigArgs?.length || request.untrustedAllowedMcpTools?.length
    || request.desktopControlGrant || request.browserOnly || request.env !== undefined
    || !Number.isSafeInteger(max) || Number(max) < 1 || Number(max) > 600
    || JSON.stringify(request.outputSchema) !== held.schema || request.signal !== held.profile.signal) fail();
  held.profile.assertCurrent();
  return held.profile;
}
