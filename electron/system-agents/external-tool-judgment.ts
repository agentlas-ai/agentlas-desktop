import fs from "node:fs";
import path from "node:path";
import { runToolChoiceProbe, type ToolChoiceProbeResult } from "../local-model-hub/tool-choice-probe";
import type { RuntimeSelection } from "../../shared/types";
import type { ToolChoiceMeasurement } from "./judgment-competence";

/**
 * Background tool-judgment measurement for every owner-loaded local model — the hub's own (agentlas-local) and those the
 * owner serves from Ollama, LM Studio or MLX — with the one probe and verdict rule of tool-choice-probe.ts. Nothing for
 * the owner to press: the first time a judgment needs a model that has no receipt, the judgment is skipped (as before)
 * and the model is measured in the background; a later judgment uses the receipt.
 *
 * - Keyed by the model's identity: hub = installation + file sha256; Ollama = digest; LM Studio = id + quantization /
 *   arch / context as the server reports them; MLX = id (the server reports no version). Another identity = no receipt.
 * - Runs only while no turn or model call is running in this process (runtime/turn-activity.ts), and waits again before
 *   every ask: a turn that starts mid-measurement pauses it after the ask already sent.
 * - Transports: the hub daemon's toolProbeAsk (task id only, rebuilt on the hub side); the server's OpenAI-compatible
 *   endpoint for Ollama / LM Studio / MLX.
 * - One measurement per model at a time; a server that does not answer leaves no receipt and backs off 10 minutes; a
 *   failing verdict is re-measured after 7 days, a passing one holds until the model changes.
 * - Receipts in user data (local-model-tool-judgment.json), value-free: verdicts and pass counts, no prompt or answer.
 *   The hub's own "Check capabilities" receipts still count (judgment-competence.ts reads both; the latest wins).
 */

export type ExternalJudgeKind = "agentlas-local" | "ollama" | "lmstudio" | "mlx";
const MEASURED_KINDS: ReadonlySet<string> = new Set(["agentlas-local", "ollama", "lmstudio", "mlx"]);
const RECEIPTS_FILE = "local-model-tool-judgment.json";
const RECEIPTS_MAX = 100;
const IDENTITY_TTL_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** A failing verdict is re-measured after this long (a capable model can still miss a majority ~6% of the time);
 *  a passing one holds until the model changes. */
const FAILED_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const CALL_TIMEOUT_MS = 180_000;
const PROBE_MAX_TOKENS = 1_024;
const HUB_HOST = "local-model-hub";
/** Nothing may have run for this long before an ask is sent. */
const IDLE_QUIET_MS = 2_000;

export interface ExternalToolJudgmentReceipt {
  schemaVersion: "agentlas.external-tool-judgment-receipt.v1";
  kind: ExternalJudgeKind;
  host: string;
  model: string;
  /** agentlas-local: the hub installation measured. */
  installationId?: string;
  identity: string;
  toolUse: ToolChoiceProbeResult["toolUse"];
  toolJudgment: ToolChoiceProbeResult["toolJudgment"];
  tasks: ToolChoiceProbeResult["tasks"];
  reasonCodes: string[];
  testedAt: string;
}

type HubInventory = { resident: { installationId: string } | null; modelInstallations: Array<{ installationId: string; fileName: string; fileSha256?: string }> };

export interface ExternalToolJudgmentDeps {
  host: (kind: Exclude<ExternalJudgeKind, "agentlas-local">) => string;
  fetch: typeof fetch;
  receiptsPath: () => string;
  now: () => number;
  /** The hub's inventory (agentlas-local identity), or null when no hub is configured. */
  hubInventory: () => Promise<HubInventory | null>;
  /** One probe ask on the resident hub model, or null when this host cannot (older daemon). */
  hubProbeAsk: () => ((installationId: string, taskId: string, signal?: AbortSignal) => Promise<{ name: string; arguments: string } | null>) | null;
  /** Resolves once no turn or model call has run for a quiet period. */
  waitIdle: () => Promise<void>;
}

function defaultDeps(): ExternalToolJudgmentDeps {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const adapter = () => require("../local-model-hub/runtime-adapter") as typeof import("../local-model-hub/runtime-adapter");
  return {
    host: (kind) => {
      if (kind === "ollama") return (require("../runtime/local-host") as typeof import("../runtime/local-host")).ollamaHost();
      if (kind === "lmstudio") return (require("../runtime/lmstudio") as typeof import("../runtime/lmstudio")).lmStudioHost();
      return (require("../runtime/mlx") as typeof import("../runtime/mlx")).mlxHost();
    },
    fetch: (...args) => fetch(...args),
    receiptsPath: () => path.join((require("../runtime-paths") as typeof import("../runtime-paths")).userDataDir(), RECEIPTS_FILE),
    now: () => Date.now(),
    hubInventory: () => adapter().readLocalModelInventory(),
    hubProbeAsk: () => adapter().localModelToolProbeAsk(),
    waitIdle: () => (require("../runtime/turn-activity") as typeof import("../runtime/turn-activity")).waitForNoActiveTurn({ quietMs: IDLE_QUIET_MS }),
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
}

let depsOverride: ExternalToolJudgmentDeps | null = null;
const deps = (): ExternalToolJudgmentDeps => depsOverride ?? defaultDeps();
const identityCache = new Map<string, { at: number; identity: string | null }>();
const inFlight = new Map<string, Promise<ExternalToolJudgmentReceipt | null>>();
const lastFailureAt = new Map<string, number>();

/** Test seam only. */
export function __setExternalToolJudgmentDepsForTest(next: ExternalToolJudgmentDeps | null): void {
  depsOverride = next; identityCache.clear(); inFlight.clear(); lastFailureAt.clear();
}

export function isExternalJudgeKind(kind: string): kind is ExternalJudgeKind {
  return MEASURED_KINDS.has(kind);
}

const hostOf = (kind: ExternalJudgeKind): string => (kind === "agentlas-local" ? HUB_HOST : deps().host(kind));

async function getJson(url: string, timeoutMs = 3_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps().fetch(url, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function installationIdFromSource(source: string | null | undefined): string | null {
  if (!source || !source.startsWith("agentlas-local:")) return null;
  const last = source.slice(source.lastIndexOf(":") + 1);
  return last || null;
}

/** The model's identity right now, or null when its server (or the hub) does not list it. */
export async function observeExternalModelIdentity(kind: ExternalJudgeKind, model: string, installationId?: string | null): Promise<string | null> {
  const host = hostOf(kind);
  const key = `${kind}\u0000${host}\u0000${model}\u0000${installationId ?? ""}`;
  const cached = identityCache.get(key);
  if (cached && deps().now() - cached.at < IDENTITY_TTL_MS) return cached.identity;
  let identity: string | null = null;
  if (kind === "agentlas-local") {
    const inventory = await deps().hubInventory().catch(() => null);
    const row = inventory?.modelInstallations.find((item) => item.fileName === model && (!installationId || item.installationId === installationId));
    identity = row ? `agentlas-local:${row.installationId}@${row.fileSha256 ?? "no-digest"}` : null;
  } else if (kind === "ollama") {
    const tags = await getJson(`${host}/api/tags`) as { models?: Array<{ name?: string; model?: string; digest?: string }> } | null;
    const row = tags?.models?.find((item) => item.name === model || item.model === model);
    identity = row ? `ollama:${host}:${model}@${row.digest ?? "no-digest"}` : null;
  } else if (kind === "lmstudio") {
    const rich = await getJson(`${host}/api/v0/models`) as { data?: Array<{ id?: string; quantization?: string; arch?: string; max_context_length?: number }> } | null;
    const row = rich?.data?.find((item) => item.id === model);
    if (row) identity = `lmstudio:${host}:${model}@${row.quantization ?? "?"}:${row.arch ?? "?"}:${row.max_context_length ?? "?"}`;
    else {
      const plain = await getJson(`${host}/v1/models`) as { data?: Array<{ id?: string }> } | null;
      identity = plain?.data?.some((item) => item.id === model) ? `lmstudio:${host}:${model}@unversioned` : null;
    }
  } else {
    const plain = await getJson(`${host}/v1/models`) as { data?: Array<{ id?: string }> } | null;
    identity = plain?.data?.some((item) => item.id === model) ? `mlx:${host}:${model}@unversioned` : null;
  }
  identityCache.set(key, { at: deps().now(), identity });
  return identity;
}

function receiptExpired(receipt: ExternalToolJudgmentReceipt): boolean {
  return receipt.toolJudgment !== "verified" && deps().now() - Date.parse(receipt.testedAt) > FAILED_RECEIPT_TTL_MS;
}

function readReceipts(): ExternalToolJudgmentReceipt[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(deps().receiptsPath(), "utf8")) as { receipts?: unknown };
    return Array.isArray(parsed.receipts) ? parsed.receipts.filter((row): row is ExternalToolJudgmentReceipt =>
      Boolean(row) && (row as ExternalToolJudgmentReceipt).schemaVersion === "agentlas.external-tool-judgment-receipt.v1"
      && MEASURED_KINDS.has((row as ExternalToolJudgmentReceipt).kind)) : [];
  } catch { return []; }
}

function writeReceipt(receipt: ExternalToolJudgmentReceipt): void {
  const file = deps().receiptsPath();
  const receipts = [...readReceipts().filter((row) => row.identity !== receipt.identity), receipt].slice(-RECEIPTS_MAX);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ receipts }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** Receipts whose model identity still matches what is served now (a changed model has no current receipt). */
export async function readExternalToolJudgmentMeasurements(): Promise<ToolChoiceMeasurement[]> {
  const rows: ToolChoiceMeasurement[] = [];
  for (const receipt of readReceipts()) {
    if (receipt.host !== hostOf(receipt.kind)) continue;
    if (receiptExpired(receipt)) continue;
    if (await observeExternalModelIdentity(receipt.kind, receipt.model, receipt.installationId) !== receipt.identity) continue;
    rows.push({ kind: receipt.kind, model: receipt.model, ...(receipt.installationId ? { installationId: receipt.installationId } : {}),
      result: receipt.toolJudgment, testedAt: receipt.testedAt,
      source: "external-runtime-probe", identity: receipt.identity, reasonCodes: receipt.reasonCodes });
  }
  return rows;
}

async function serverAsk(kind: Exclude<ExternalJudgeKind, "agentlas-local">, model: string,
  messages: Parameters<Parameters<typeof runToolChoiceProbe>[0]>[0], tools: Parameters<Parameters<typeof runToolChoiceProbe>[0]>[1]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await deps().fetch(`${deps().host(kind)}/v1/chat/completions`, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, max_tokens: PROBE_MAX_TOKENS, messages, tools }) });
    if (!response.ok) throw new Error(`tool_probe_http_${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
    return call?.name ? { name: call.name, arguments: call.arguments ?? "" } : null;
  } finally { clearTimeout(timer); }
}

async function measure(kind: ExternalJudgeKind, model: string, identity: string, installationId: string | null): Promise<ExternalToolJudgmentReceipt> {
  let transportFailures = 0;
  const hubAsk = kind === "agentlas-local" ? deps().hubProbeAsk() : null;
  if (kind === "agentlas-local" && (!hubAsk || !installationId)) throw new Error("tool_judgment_measurement_hub_unavailable");
  const result = await runToolChoiceProbe(async (messages, tools, task) => {
    // Only between turns: wait before every ask, so a turn that starts mid-measurement pauses it.
    await deps().waitIdle();
    try {
      return kind === "agentlas-local" ? await hubAsk!(installationId!, task.id) : await serverAsk(kind, model, messages, tools);
    } catch (error) {
      transportFailures += 1;
      throw error;
    }
  });
  // A server that did not answer measured nothing about the model: no receipt (a failed one would stick until the model
  // changes); the attempt backs off and is tried again later.
  if (transportFailures > 0) throw new Error("tool_judgment_measurement_transport_failed");
  const receipt: ExternalToolJudgmentReceipt = { schemaVersion: "agentlas.external-tool-judgment-receipt.v1", kind, host: hostOf(kind), model,
    ...(installationId ? { installationId } : {}), identity,
    toolUse: result.toolUse, toolJudgment: result.toolJudgment, tasks: result.tasks, reasonCodes: result.reasonCodes,
    testedAt: new Date(deps().now()).toISOString() };
  writeReceipt(receipt);
  return receipt;
}

/**
 * Start measuring this selection's model in the background unless a current receipt exists, a measurement is already
 * running, or the last attempt failed recently. Never awaited by the judge; the returned promise is for tests and QA.
 */
export function ensureExternalToolJudgmentMeasured(selection: Pick<RuntimeSelection, "kind" | "model" | "source">): Promise<ExternalToolJudgmentReceipt | null> | null {
  if (!isExternalJudgeKind(selection.kind) || !selection.model) return null;
  const kind = selection.kind; const model = selection.model;
  const installationId = kind === "agentlas-local" ? installationIdFromSource(selection.source) : null;
  if (kind === "agentlas-local" && !installationId) return null;
  const key = `${kind}\u0000${hostOf(kind)}\u0000${model}\u0000${installationId ?? ""}`;
  const running = inFlight.get(key);
  if (running) return running;
  const failedAt = lastFailureAt.get(key);
  if (failedAt !== undefined && deps().now() - failedAt < RETRY_AFTER_FAILURE_MS) return null;
  const task = (async () => {
    const identity = await observeExternalModelIdentity(kind, model, installationId);
    if (!identity) return null;
    if (readReceipts().some((row) => row.identity === identity && !receiptExpired(row))) return null;
    return await measure(kind, model, identity, installationId);
  })().then((receipt) => receipt, () => { lastFailureAt.set(key, deps().now()); return null; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
