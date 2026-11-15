// Long operations (Agentlas 2.0 L1, contracts/phone-long-ops.md): the value table and the pure functions of "received + late answer".
// Kept free of Main imports so the socket server, the replay ledger and the authority can all use it (and a daemon process can load it).
//
// The phone waits 30 s for a write. A write the Desktop cannot finish in 8 s is *taken* (`request.accepted`), keeps running, and its ordinary
// response for the original request id is sent when it ends. The ledger says "in progress" for as long as the work is alive; it says
// "unknown" only when the operation's own bound passed, its owner process died, or the ledger could not be written (C3).
//
// Every number below carries its ground and what happens when it is reached. "Set value - no ground" means nothing was measured and
// nothing outside forces it; it is on the audit list.

/** The longest a bridge request is given before the Desktop answers "unknown" (the existing default of the server; reads wait inside it). */
export const MOBILE_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * 8 s until a write is "received". basis: the existing MOBILE_INTENT_JUDGE_ACK_BOUND_MS (authority.ts), well under the phone's 30 s with the relay and the
 * Desktop's own work inside it. Reached: `request.accepted` goes out once; the work goes on.
 */
export const LONG_OPS_ACK_MS = 8_000;

/**
 * 10 s the phone adds to `maxMs` before it gives up on the late answer. basis: 정한 값 — 근거 없음 (follows the existing `build.start` 90 -> 100 s example).
 * Reached: the phone asks `request.status` once (C4).
 */
export const LONG_OPS_PHONE_MARGIN_MS = 10_000;

/**
 * 32 received writes per device, kept in memory only. basis: the existing MAX_INFLIGHT_REQUESTS of the server. Reached: the 33rd write is not
 * "received" and behaves exactly as before. A restart empties it; the ledger and the phone's judgement after "unknown" give the answer then.
 */
export const LONG_OPS_MAX_RECEIVED_PER_DEVICE = 32;

/**
 * Registration request to Agent Cloud: 300 s. basis: 정한 값 — 근거 없음 (reuses the 300 s review bound of the same upload; until now there was no bound at all).
 * Reached: that upload ends as "unknown" (the Cloud may or may not have committed it) and the phone reads the agent's Cloud state.
 */
export const CLOUD_REGISTER_REQUEST_MAX_MS = 300_000;

/**
 * 20 min for one Preview turn of a saved Build (`build2.preview.send`, contracts/phone-build2.md section 3). basis: CLI_SILENCE_WINDOW_MS (runtime/runner.ts): a Preview runs with
 * read permission, so it has no long tool run, and that is the time after which the runner already calls a live turn dead. Kept as a number here because this file loads no
 * Main code (the gate asserts the two are equal). Reached: the ledger says "unknown"; the phone reads `build2.preview.read` once (the answer is in the conversation, or `busy`).
 */
const PREVIEW_SEND_MAX_MS = 20 * 60_000;

/**
 * Per-write bounds longer than the default 120 s; every other write keeps the default. Only operations the contract's table (3 B) names. basis: each is a bound already in the code:
 *  - agents.cloudUploadSave / agents.cloudPublishHub: review 300 s + model repair 3 x 300 s (cloud-agents/package.ts 946-952, hephaestus/publish-autofix.ts 246)
 *    + the registration request (CLOUD_REGISTER_REQUEST_MAX_MS) = 1,500 s. basis: the sum of those bounds. Reached: "unknown"; the phone reads the Cloud state.
 *  - one.supervisor.send / startWork / control: 310 s, the daemon channel's own bound (daemon/native-auth-channel.ts 44-64). Reached: "unknown"; the receipt is the proof.
 */
const WRITE_MAX_MS: Readonly<Record<string, number>> = Object.freeze({
  "build2.preview.send": PREVIEW_SEND_MAX_MS,
  "agents.cloudUploadSave": 1_500_000,
  "agents.cloudPublishHub": 1_500_000,
  "one.supervisor.send": 310_000,
  "one.supervisor.startWork": 310_000,
  "one.supervisor.control": 310_000,
});

/** The longest any write may be held "in progress". An owner process that is alive past this is read as gone (a reused process number must not hold a key for a day). */
export const LONG_OPS_LONGEST_WRITE_MAX_MS = Math.max(MOBILE_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS, ...Object.values(WRITE_MAX_MS));

/** How long this write may run before the Desktop calls it "unknown": the default bound, or the longer one of the table. */
export function longOpWriteMaxMs(method: string, defaultMs: number = MOBILE_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS): number {
  return Math.max(defaultMs, WRITE_MAX_MS[method] ?? 0);
}

/**
 * What one read can take on the Desktop, by phone operation key (`method`, or `finance.read.<operation>`): the existing bound of its handler.
 * `null` = the handler has no bound of its own, so only the bridge's 120 s ends it. Each value is a bound already in the code; none is new.
 */
const READ_HANDLER_MAX_MS: Readonly<Record<string, number | null>> = Object.freeze({
  "connectors.test": 45_000, // mcp-tools/client.ts:56 connection test
  "usage.snapshot": 44_000, // usage/claude.ts keychain 20 s + two 12 s queries
  "runtime.detect": null, // one 40 s window per ACP sheet, no overall bound (runtime/acp.ts:865-869)
  "hephaestus.routePreview": 30_000, // authority.ts routePreview timeoutMs
  "mail.status": 30_000, // agent-mail/client.ts 15 s + 15 s
  "hub.search": 20_000, // marketplace/mcp-source.ts: 15 s calls + 5 s status
  "hub.detail": 20_000,
  "finance.read.worldMarkets": 90_000, // finance/world-markets.ts overall timer
  "finance.read.dashboardFeeds": 45_000, // finance/dashboard-feeds.ts deadline
});

/**
 * How long the phone should wait for one read: min(the Desktop's not-ready wait + the handler's own bound, the bridge's bound) + the phone's margin.
 * Reached (rare): the phone's read times out and may be asked again; the Desktop finishes anyway (it does not cancel).
 */
export function longOpReadWaitMs(handlerMaxMs: number | null, notReadyWaitMs: number, bridgeBoundMs: number): number {
  const handler = handlerMaxMs === null ? bridgeBoundMs : notReadyWaitMs + handlerMaxMs;
  return Math.min(handler, bridgeBoundMs) + LONG_OPS_PHONE_MARGIN_MS;
}

export interface LongOpsV1 {
  schemaVersion: 1;
  /** When a write that is still running is "received" (ms). */
  ackMs: number;
  /** How long the phone waits for each read (ms), by operation key. A key that is absent keeps the phone's own default (30 s). */
  readWaitMs: Record<string, number>;
}

/** The value `bridge.ready` carries as `capabilities.longOpsV1`. Absent keys mean "your own default". */
export function buildLongOpsV1(options: { notReadyWaitMs: number; bridgeBoundMs: number }): LongOpsV1 {
  const readWaitMs: Record<string, number> = {};
  for (const [key, handlerMax] of Object.entries(READ_HANDLER_MAX_MS)) {
    readWaitMs[key] = longOpReadWaitMs(handlerMax, options.notReadyWaitMs, options.bridgeBoundMs);
  }
  return { schemaVersion: 1, ackMs: LONG_OPS_ACK_MS, readWaitMs };
}

/** The payload of `request.accepted`. */
export interface RequestAcceptedPayload {
  requestId: string;
  maxMs: number;
}

/**
 * A write whose outcome the Desktop cannot know: the work was cut off by a bound of its own (not by the bridge), so it may or may not have happened.
 * Thrown by an operation (a machine marker, never read from the message); the bridge answers `outcome_unknown` and leaves the ledger "unknown".
 */
export class MobileBridgeOutcomeUnknown extends Error {
  readonly code = "outcome_unknown";
  constructor(message = "outcome_unknown") {
    super(message);
    this.name = "MobileBridgeOutcomeUnknown";
  }
}

/**
 * C6: one running job per target. A second request for the same target and the same intent joins the running one and gets the same answer; one with
 * a different intent waits for it to end and then runs (never two at once on one target). Memory only; an entry ends with its job.
 */
export class LongOpJoiner {
  private readonly running = new Map<string, { intent: string; promise: Promise<unknown> }>();

  async run<T>(target: string, intent: string, start: () => Promise<T>): Promise<T> {
    for (;;) {
      const current = this.running.get(target);
      if (!current) break;
      if (current.intent === intent) return current.promise as Promise<T>;
      await current.promise.then(() => undefined, () => undefined);
    }
    const promise = start();
    const entry = { intent, promise };
    this.running.set(target, entry);
    const forget = () => { if (this.running.get(target) === entry) this.running.delete(target); };
    promise.then(forget, forget);
    return promise;
  }

  /** Only for tests and disposal. */
  size(): number { return this.running.size; }
  clear(): void { this.running.clear(); }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * The target of a write that may be joined (C6): the operation plus what it acts on. Uploads and Hub publishes join per agent; a Hub install joins per
 * slug + kind + release. `intent` is what must be equal for two requests to share one answer (flags that change what the operation does).
 */
export function longOpJoinTarget(request: { method: string; params: Record<string, unknown> }): { target: string; intent: string } | null {
  const { method, params } = request;
  if (method === "agents.cloudUploadSave") {
    if (typeof params.agentLocalId !== "string") return null;
    return { target: `${method}\0${params.agentLocalId}`, intent: canonical({ confirmOverwrite: params.confirmOverwrite === true }) };
  }
  if (method === "agents.cloudPublishHub") {
    if (typeof params.agentLocalId !== "string") return null;
    return { target: `${method}\0${params.agentLocalId}`, intent: canonical({ confirmOverwrite: params.confirmOverwrite === true, publicSourceConsent: params.publicSourceConsent === true }) };
  }
  if (method === "hub.install") {
    if (typeof params.slug !== "string" || typeof params.entityKind !== "string") return null;
    return { target: `${method}\0${params.slug}\0${params.entityKind}\0${canonical(params.release ?? null)}`, intent: "" };
  }
  return null;
}
