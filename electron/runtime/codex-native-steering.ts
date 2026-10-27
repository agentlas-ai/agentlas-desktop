import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AcpRpcError } from "./acp-protocol";
import { observeCliExecutableIdentity } from "./cli-executable-identity";
import { detachedSpawnOpts, killCliTree, spawnCli } from "./exec";
import type { RunnerNativeSteerResult, RunnerNativeTurnBinding, RunnerNativeTurnController } from "./runner";

export interface CodexNativeSteeringCapability {
  readonly schemaDigest: string;
  readonly executableGeneration: string;
  readonly clientUserMessageId: boolean;
  /** TurnStartParams.clientUserMessageId is in this executable's own schema (the session echoes it as the user item's
   * clientId: a typed acknowledgement of the turn's request). Schema proof only; false when the file is absent. */
  readonly turnStartClientUserMessageId: boolean;
}

/** Schema proof that turn/start accepts a client user message id. */
export function codexTurnStartClientIdSchema(params: any): boolean {
  const type = params?.type === "object" ? params.properties?.clientUserMessageId?.type : undefined;
  return type === "string" || (Array.isArray(type) && type.includes("string"));
}

/** Schema proof, not a version guess or a provider prompt. */
export function codexNativeSteeringSchema(client: any, params: any, response: any): { clientUserMessageId: boolean } | null {
  const required = (schema: any, fields: string[]): boolean => schema?.type === "object"
    && Array.isArray(schema.required) && fields.every((field) => schema.required.includes(field));
  const request = client?.oneOf?.find((branch: any) => branch?.properties?.method?.enum?.includes("turn/steer"));
  if (!required(request, ["id", "method", "params"])
    || request.properties.params?.$ref !== "#/definitions/TurnSteerParams"
    || !required(params, ["threadId", "expectedTurnId", "input"])
    || params.properties?.threadId?.type !== "string" || params.properties?.expectedTurnId?.type !== "string"
    || params.properties?.input?.type !== "array" || params.properties.input.items?.$ref !== "#/definitions/UserInput"
    || !required(response, ["turnId"]) || response.properties?.turnId?.type !== "string") return null;
  const text = params.definitions?.UserInput?.oneOf?.find((branch: any) => branch.properties?.type?.enum?.includes("text"));
  if (!required(text, ["type", "text"]) || text.properties?.text?.type !== "string") return null;
  const clientIdType = params.properties?.clientUserMessageId?.type;
  return { clientUserMessageId: clientIdType === "string" || (Array.isArray(clientIdType) && clientIdType.includes("string")) };
}

const schemaProbes = new Map<string, Promise<CodexNativeSteeringCapability | null>>();
/**
 * Probes that could not ask (a spawn error, a timeout, a failed exit, an unreadable file) prove nothing about the executable,
 * so they are never cached as "unsupported": the same folder is asked again after a growing pause, and another folder is not
 * held back by it. Only a schema that was read and lacks turn/steer is cached for the generation.
 */
const probeBackoff = new Map<string, { failures: number; retryAt: number }>();
const PROBE_RETRY_BASE_MS = 15_000;
const PROBE_RETRY_MAX_MS = 10 * 60_000;

type SchemaProbeOutcome =
  | { kind: "supported"; capability: CodexNativeSteeringCapability }
  /** The schema was generated and read, and it has no native steering. */
  | { kind: "unsupported" }
  /** The probe could not run to a proof. */
  | { kind: "unavailable" };

/** Cache a proof only for the exact selected executable generation; an infrastructure failure is not a proof. */
export async function probeCodexNativeSteering(input: { bin: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<CodexNativeSteeringCapability | null> {
  let identity;
  try { identity = observeCliExecutableIdentity(input); } catch { return null; }
  if (!identity) return null;
  const key = `${identity.fingerprint}:${identity.generation}`;
  const previous = schemaProbes.get(key);
  if (previous) return previous;
  const attemptKey = `${key}\0${path.resolve(input.cwd)}`;
  const paused = probeBackoff.get(attemptKey);
  if (paused && Date.now() < paused.retryAt) return null;
  const outcomePromise = (async (): Promise<SchemaProbeOutcome> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-codex-steer-schema-"));
    try {
      const child = spawnCli(input.bin, ["app-server", "generate-json-schema", "--out", dir], {
        cwd: input.cwd, env: input.env, stdio: "ignore", ...detachedSpawnOpts(),
      });
      const generated = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { killCliTree(child, 0); resolve(false); }, 3_000);
        timer.unref?.();
        child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
        child.once("error", () => { clearTimeout(timer); resolve(false); });
      });
      if (!generated) return { kind: "unavailable" };
      let raw: string[];
      try {
        raw = await Promise.all(["ClientRequest.json", "v2/TurnSteerParams.json", "v2/TurnSteerResponse.json"]
          .map((file) => fs.readFile(path.join(dir, file), "utf8")));
      } catch (error) {
        // A finished generation that has no such schema file is an executable without turn/steer; any other read failure proves nothing.
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "unsupported" } : { kind: "unavailable" };
      }
      let parsed: [any, any, any];
      try { parsed = raw.map((text) => JSON.parse(text)) as [any, any, any]; } catch { return { kind: "unavailable" }; }
      const capability = codexNativeSteeringSchema(...parsed);
      if (!capability) return { kind: "unsupported" };
      let turnStartClientUserMessageId = false;
      try { turnStartClientUserMessageId = codexTurnStartClientIdSchema(JSON.parse(await fs.readFile(path.join(dir, "v2/TurnStartParams.json"), "utf8"))); }
      catch { /* An absent or unreadable file proves nothing: the id is not sent. */ }
      return { kind: "supported", capability: Object.freeze({ ...capability, turnStartClientUserMessageId, executableGeneration: identity.generation,
        schemaDigest: createHash("sha256").update(JSON.stringify(raw)).digest("hex") }) };
    } catch { return { kind: "unavailable" }; }
    finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  })().catch((): SchemaProbeOutcome => ({ kind: "unavailable" }));
  const probe: Promise<CodexNativeSteeringCapability | null> = outcomePromise.then((outcome) => {
    if (outcome.kind === "unavailable") {
      const failures = (probeBackoff.get(attemptKey)?.failures ?? 0) + 1;
      probeBackoff.set(attemptKey, { failures, retryAt: Date.now() + Math.min(PROBE_RETRY_BASE_MS * 2 ** (failures - 1), PROBE_RETRY_MAX_MS) });
      if (probeBackoff.size > 256) probeBackoff.delete(probeBackoff.keys().next().value!);
      if (schemaProbes.get(key) === probe) schemaProbes.delete(key);
      return null;
    }
    probeBackoff.delete(attemptKey);
    return outcome.kind === "supported" ? outcome.capability : null;
  });
  schemaProbes.set(key, probe);
  if (schemaProbes.size > 64) schemaProbes.delete(schemaProbes.keys().next().value!);
  return probe;
}

/** One immutable turn. Stop revokes publication, never authorizes another send. */
export function createCodexNativeTurnController(input: {
  binding: RunnerNativeTurnBinding;
  capability: CodexNativeSteeringCapability;
  isActive: () => boolean;
  request: (method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal: AbortSignal }) => Promise<any>;
  timeoutMs?: number;
}): { controller: RunnerNativeTurnController; revoke: () => void } {
  const binding = Object.freeze({ ...input.binding });
  const abort = new AbortController();
  const receipts = new Map<string, { text: string; promise: Promise<RunnerNativeSteerResult> }>();
  const rejected = (code: string, reason: string): RunnerNativeSteerResult => ({ status: "rejected", code, reason });
  const controller: RunnerNativeTurnController = Object.freeze({
    binding,
    steer: (request: Parameters<RunnerNativeTurnController["steer"]>[0]): Promise<RunnerNativeSteerResult> => {
      if (!request || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.requestId)
        || typeof request.text !== "string" || !request.text.trim() || request.text.length > 262_144) {
        return Promise.resolve(rejected("native_steer_invalid", "The native direction requires an exact request ID and nonempty bounded text."));
      }
      if (request.expectedThreadId !== binding.threadId || request.expectedTurnId !== binding.turnId) {
        return Promise.resolve(rejected("native_turn_stale", "The direction does not target this confirmed native turn."));
      }
      const previous = receipts.get(request.requestId);
      if (previous) return previous.text === request.text ? previous.promise
        : Promise.resolve(rejected("native_steer_request_conflict", "The request ID is already bound to different text."));
      if (abort.signal.aborted || !input.isActive()) {
        return Promise.resolve(rejected("native_turn_stale", "The confirmed native turn is no longer active."));
      }
      if (receipts.size >= 1024) return Promise.resolve(rejected("native_steer_limit", "This native turn has reached its bounded direction receipt limit."));
      const params = { threadId: binding.threadId, expectedTurnId: binding.turnId,
        input: [{ type: "text", text: request.text }],
        ...(input.capability.clientUserMessageId ? { clientUserMessageId: request.requestId } : {}) };
      // NDJSON writes retain call order. Never wait for an earlier uncertain ACK and then replay it.
      const promise = (async (): Promise<RunnerNativeSteerResult> => {
        try {
          const response = await input.request("turn/steer", params, { timeoutMs: input.timeoutMs ?? 5_000, signal: abort.signal });
          if (response?.turnId !== binding.turnId) return { status: "uncertain", code: "native_steer_ack_mismatch",
            reason: "The native response did not acknowledge the exact requested turn." };
          return { status: "accepted", turnId: response.turnId };
        } catch (error) {
          // Pinned Codex NotSubmitted/invalid-input errors are explicit rejection. Internal/unknown
          // RPC failures and lost transport responses cannot prove absence of a submitted direction.
          if (error instanceof AcpRpcError && [-32600, -32601, -32602].includes(error.code)) {
            return { status: "rejected", code: "native_steer_rejected", rpcCode: error.code, reason: error.message };
          }
          return { status: "uncertain", code: "native_steer_ack_lost",
            ...(error instanceof AcpRpcError ? { rpcCode: error.code } : {}),
            reason: error instanceof Error ? error.message : String(error) };
        }
      })();
      receipts.set(request.requestId, { text: request.text, promise });
      return promise;
    },
  });
  return { controller, revoke: () => abort.abort(new Error("The native turn controller was withdrawn.")) };
}
