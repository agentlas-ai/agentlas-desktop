import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { observationCaptureDir } from "../media/capture-artifacts";
import { outsideInvocationJudgmentContext } from "../runtime/judgment-context";
import { memoryNoteToEvent } from "../memory/events";
import { recordTurnAsk, recordTurnMemoryNote, turnNotesKey, TURN_ASK_LIMIT, TURN_MEMORY_NOTE_LIMIT } from "./notes";
import { parseAskFenceBody, type AgentlasAskQuestion } from "../../shared/ask-fence-flatten";
import { GOAL_PLAN_LINE_LIMIT, recordGoalCompleteSignal, recordGoalPlanLine, recordGoalWaitSignal, validateGoalWaitIntent } from "./goal-signals";
import { extractGoalPlanMarkers } from "../../shared/goal-shape";
import { extractAgentStrategyMarkers } from "../../shared/agent-strategy";
import { stripGoalCompleteMarker } from "../hephaestus/loop-engineering";
import { goalCompleteMarkerText } from "./goal-signals";
import { GOAL_PLAN_TOOL_MARKERS, TURN_TOOLS_BASE } from "./mcp-server";

// Main-side handler for the inline agentlas-turn MCP child. Loopback only, one random server token, one capability per
// run config. The capability pins the chat and run; the child can name neither, so a note can only land in the turn
// that holds the capability.

const MAX_REQUEST_BYTES = 768 * 1024;

// The server outlives the turn that first starts it, and Node gives every later request the async context that was
// live at listen() (one-team control server, same defect). Production 2026-10-18 (1.3.67, Yotube room): goal_wait's
// lifecycle judgment ran with the first turn's runtime pin and its aborted signal, stopped before any model call, so
// a daily /goal Goal stayed "finite" and its next-day wait was refused goal_wait_ongoing_authority_required.
// So listen from the module-load context, and handle each request outside any invocation's judgment context.
const hostRootContext = AsyncLocalStorage.snapshot();

export interface TurnToolsCapabilityBinding {
  /** Main-only admission check. Never written to the child capability file. */
  admissionCurrent?: () => boolean;
  /** Host-only account captured at mint time; never serialized into the child capability file. */
  hostAccountBinding?: { workspaceId: string; userId: string; sessionId: string; expiresAt: number | null } | null;
  capabilityId: string;
  chatId: string;
  runId: string;
  /** Graph dry-run or plan mode: nothing is recorded. */
  dryRun?: boolean;
  /** Tools this run may call (the child lists only these; the host re-checks). Default: memory_note. */
  tools?: readonly string[];
  /** The run's tool permission, handed to harness ports that save (graph.draft.commit). */
  permission?: "read" | "write" | "full";
  /** One Team is attached and the run is neither a Toolchain consumer nor a room member (one_graph_* scope). */
  graphAuthoring?: boolean;
  /** Main-only: the sealed MCP config this capability was minted in. Harness ports dispatch the run's host-channel
   * built-ins through it (harness/tool-dispatch.ts runScopedBinding). Never written to the capability file. */
  mcpConfigPath?: string;
  /** Main-only: the run's MCP client reads image content in a tool result (harnessResultWithImages). Measured 2026-10-18:
   * codex 0.163 reads one; grok 1.0.62 stops answering after one (a text result in the same probe finishes). */
  imageResults?: boolean;
}

export type TurnGoalTimerAuthority =
  | { ok: true }
  | { ok: false; reason: string };
/** Resolves the Goal bound to a chat and whether a timer wait is allowed for it (null: no Goal is bound). */
export type TurnGoalResolver = (chatId: string, nowMs: number) => Promise<{ goalId: string; timer: TurnGoalTimerAuthority } | null>;

const defaultGoalResolver: TurnGoalResolver = async (chatId, nowMs) => {
  const { getChatGoalId } = await import("../store/chats");
  const goalId = getChatGoalId(chatId);
  if (!goalId) return null;
  const { timerWaitAuthority } = await import("../long-run/goal-deadline");
  let authority = timerWaitAuthority(goalId, nowMs);
  if (!authority.ok && authority.reason === "goal_wait_ongoing_authority_required") {
    // A /goal-adopted Goal's "finite" may be an unjudged default: judge the owner's request once before refusing.
    const { settleExplicitGoalLifecycle } = await import("../long-run/explicit-goal-lifecycle");
    if (await settleExplicitGoalLifecycle(goalId).catch(() => null) === "ongoing") authority = timerWaitAuthority(goalId, nowMs);
  }
  return { goalId, timer: authority.ok ? { ok: true } : { ok: false, reason: authority.reason } };
};
let goalResolver: TurnGoalResolver = defaultGoalResolver;
/** Test seam: the gate injects a Goal without a database. */
export function setTurnGoalResolver(resolver: TurnGoalResolver | null): void { goalResolver = resolver ?? defaultGoalResolver; }

/** What the model can do about each refusal; the code before the colon is the same reason the parser/registration uses. */
const GOAL_WAIT_HINTS: Record<string, string> = {
  goal_wait_request_invalid: "Check next_action (1-2000 chars) and that deadline / not_before are ISO timestamps.",
  goal_wait_subject_unsupported: "invocation needs invocation_run_id+chat_id with condition terminal; artifact needs artifact_id and automation needs automation_id with condition changed; timer needs not_before with condition due.",
  goal_wait_ongoing_authority_required: "This is a finite Goal without a deadline, so a timer wait is refused. Do not wait: finish the turn and state what should be re-measured and when.",
  goal_wait_goal_deadline_passed: "The Goal deadline has passed. Do not wait: verify the result against the target now.",
  goal_wait_deadline_elapsed: "deadline is already in the past; omit it or give a future one.",
  goal_wait_no_goal: "No Goal is bound to this chat, so there is nothing to wait for.",
};

let server: http.Server | null = null;
let boundPort = 0;
let serverToken = "";
let serverStarting: Promise<number> | null = null;
let shutdownRegistered = false;
const capabilities = new Map<string, TurnToolsCapabilityBinding>();
const capabilityAborters = new Map<string, AbortController>();
/** capabilityId → its file, so a withheld tool also leaves the list the child reads. */
const capabilityFiles = new Map<string, string>();
/** runId → open team dispatches holding ask_form back, and the capabilities' tool lists to restore. */
const askWithheld = new Map<string, { holders: number; restore: Map<string, readonly string[]> }>();

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || randomUUID();
}
function controlDir(): string { return userDataPath("turn-tools"); }
function capabilityPath(configKey: string, capabilityId: string): string {
  return path.join(controlDir(), `capability-${safeKey(configKey)}-${safeKey(capabilityId)}.json`);
}
function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) { resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" ? value : null);
      } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * The typed code of a harness call that did not succeed, or null. The control server answered every harness result as
 * {ok:true}, so the agentlas-turn child returned refused/unavailable results — and a tool.call whose connector tool
 * failed — as an MCP success: production 2026-10-16 00:00Z (graph cdf732ca) recorded harness_call → one_team_list
 * "One team tools are not connected in this run." as toolIsError 0 with the graph receipt succeeded:true, and the
 * model and the receipts took failed calls for done ones. Failed here: status refused/unavailable (reason is the
 * code), or a tool.call that settled tool-error/failed/cancelled. In flight or unknown effect (dispatching, running,
 * dispatch-unsettled) is not failed: the effect may have happened, so it stays an effect, never "nothing happened".
 */
/** The first non-empty string under these keys, in order. */
export function harnessId(a: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) if (typeof a[key] === "string" && (a[key] as string).trim()) return (a[key] as string).trim();
  return "";
}

/** harness_call arguments under args (or input/arguments), as an object or a JSON object string. */
export function harnessArgs(a: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["args", "input", "arguments"]) {
    let value = a[key];
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { continue; } }
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

export function harnessCallFailureCode(operation: unknown, result: unknown): string | null {
  if (operation !== "harness_call" && operation !== "harness_describe") return null;
  if (!result || typeof result !== "object") return null;
  const r = result as { status?: unknown; reason?: unknown; operationId?: unknown; data?: unknown };
  if (r.status === "refused" || r.status === "unavailable") return typeof r.reason === "string" && r.reason ? r.reason : r.status;
  if (r.status !== "ok" || r.operationId !== "tool.call" || !r.data || typeof r.data !== "object") return null;
  const call = r.data as { state?: unknown; error?: { code?: unknown } | null };
  if (call.state !== "tool-error" && call.state !== "failed" && call.state !== "cancelled") return null;
  return typeof call.error?.code === "string" && call.error.code ? call.error.code : call.state;
}

const RESULT_IMAGE_LIMIT = 4;
const RESULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A harness_call whose app.call answer held images (app-control/service.ts saveResultImages saved each as a host capture
 * and listed it under `images`) reaches the model as the same JSON plus each capture as an MCP image, so every runtime sees
 * it the way it sees a tool's screenshot. Dev 2026-10-18 run30 O8: the firm QA's capturePreview image arrived as cut
 * base64 text and the QA closed inconclusive. Only regular files directly in the host's observation-capture folder are read (at
 * most four, each under 5 MB); the runtimes keep these as observations, not run outputs (codex.ts, local-tool-loop.ts).
 * Only a run whose MCP client reads images gets them (TurnToolsCapabilityBinding.imageResults); the others keep the paths.
 */
export function harnessResultWithImages(operation: unknown, result: unknown): unknown {
  if (operation !== "harness_call" || !result || typeof result !== "object") return result;
  const r = result as { status?: unknown; data?: unknown };
  const listed = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as { images?: unknown }).images : undefined;
  if (!Array.isArray(listed) || listed.length === 0) return result;
  let root: string;
  try { root = fs.realpathSync.native(observationCaptureDir()); } catch { return result; }
  const blocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const image of listed.slice(0, RESULT_IMAGE_LIMIT)) {
    const { file, mediaType } = (image && typeof image === "object" ? image : {}) as { file?: unknown; mediaType?: unknown };
    if (typeof file !== "string" || (mediaType !== "image/png" && mediaType !== "image/jpeg")) continue;
    try {
      const real = fs.realpathSync.native(file);
      const stat = fs.statSync(real);
      if (path.dirname(real) !== root || !stat.isFile() || stat.size === 0 || stat.size > RESULT_IMAGE_MAX_BYTES) continue;
      blocks.push({ type: "image", data: fs.readFileSync(real).toString("base64"), mimeType: mediaType });
    } catch { /* a capture that is gone is still named in the JSON */ }
  }
  return blocks.length ? { content: [{ type: "text", text: JSON.stringify(result) }, ...blocks] } : result;
}

// Constant-time, like the computer-use and workspace-preview control servers: a local process (or a DNS-rebound page)
// cannot time `!==` toward the token. Hashing first makes the lengths equal; an empty expected token never matches.
function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}

/** The MCP child dials 127.0.0.1:<port>; any other Host (a rebound browser page) is refused before the body is read. */
function loopbackHost(host: string | undefined, port: number): boolean {
  return port > 0 && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

export async function handleTurnToolsControlRequest(request: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> {
  if (!tokenMatches(request.token, serverToken)) throw new Error("turn-tools-capability-invalid");
  const binding = typeof request.capabilityId === "string" ? capabilities.get(request.capabilityId) : undefined;
  if (!binding) throw new Error("turn-tools-capability-invalid");
  const lifetime = capabilityAborters.get(binding.capabilityId);
  if (!lifetime) throw new Error("turn-tools-capability-invalid");
  switch (request.operation) {
    case "goal_wait": {
      if (!binding.tools?.includes("goal_wait")) throw new Error("turn-tools-operation-invalid");
      const a = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args as Record<string, unknown> : null;
      const refuse = (reason: string): never => { throw new Error(`${reason}: ${GOAL_WAIT_HINTS[reason] ?? "The wait was not registered."}`); };
      if (!a) return refuse("goal_wait_request_invalid");
      const allowed = ["subject_kind", "condition", "invocation_run_id", "chat_id", "artifact_id", "automation_id", "not_before", "next_action", "deadline"];
      const unknown = Object.keys(a).find((key) => !allowed.includes(key));
      if (unknown) throw new Error(`goal_wait_unknown_field: ${unknown}`);
      // Only the fields of the chosen subject kind may be present: the parser refuses unknown subject keys.
      const subjectFields: Record<string, string[]> = { invocation: ["invocation_run_id", "chat_id"], artifact: ["artifact_id"], automation: ["automation_id"], timer: ["not_before"] };
      const kind = typeof a.subject_kind === "string" ? a.subject_kind : "";
      const own = subjectFields[kind];
      if (!own) return refuse("goal_wait_subject_unsupported");
      const stray = ["invocation_run_id", "chat_id", "artifact_id", "automation_id", "not_before"].find((key) => a[key] !== undefined && !own.includes(key));
      if (stray) throw new Error(`goal_wait_subject_field_mismatch: ${stray} does not belong to subject_kind ${kind}. ${GOAL_WAIT_HINTS.goal_wait_subject_unsupported}`);
      const subject: Record<string, unknown> = { kind };
      if (kind === "invocation") { subject.invocationRunId = a.invocation_run_id; subject.chatId = a.chat_id; }
      else if (kind === "artifact") subject.artifactId = a.artifact_id;
      else if (kind === "automation") subject.automationId = a.automation_id;
      else subject.notBefore = a.not_before;
      const validated = validateGoalWaitIntent({
        schemaVersion: "agentlas.goal-wait-intent.v1", subject, condition: a.condition,
        nextAction: a.next_action, deadline: a.deadline === undefined ? null : a.deadline,
      });
      if (!validated.ok) return refuse(validated.reason);
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      const now = Date.now();
      const goal = await goalResolver(binding.chatId, now);
      if (!goal) return refuse("goal_wait_no_goal");
      if (validated.intent.deadline && Date.parse(validated.intent.deadline) <= now) return refuse("goal_wait_deadline_elapsed");
      if (validated.intent.subject.kind === "timer" && !goal.timer.ok) return refuse(goal.timer.reason);
      const outcome = recordGoalWaitSignal(turnNotesKey(binding.chatId, binding.runId), validated.intent);
      if (outcome !== "recorded") throw new Error(`goal_wait_${outcome}: one wait per turn, and not together with goal_complete.`);
      return { registered: "pending_host", note: "End this turn now; the host registers the wait and wakes this Goal when it is met." };
    }
    case "goal_complete": {
      if (!binding.tools?.includes("goal_complete")) throw new Error("turn-tools-operation-invalid");
      const a = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args as Record<string, unknown> : null;
      if (!a) throw new Error("goal_complete_invalid: arguments must be an object");
      const unknown = Object.keys(a).find((key) => key !== "evidence" && key !== "summary");
      if (unknown) throw new Error(`goal_complete_unknown_field: ${unknown}`);
      for (const key of ["evidence", "summary"]) if (a[key] !== undefined && typeof a[key] !== "string") throw new Error(`goal_complete_invalid: ${key} must be a string`);
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      const goal = await goalResolver(binding.chatId, Date.now());
      if (!goal) throw new Error("goal_complete_no_goal: No Goal is bound to this chat.");
      // Same extraction the marker gets: whatever the text parser would read as this claim's evidence.
      const claim = stripGoalCompleteMarker(goalCompleteMarkerText(((a.evidence as string | undefined) || (a.summary as string | undefined) || "").trim() || null));
      const outcome = recordGoalCompleteSignal(turnNotesKey(binding.chatId, binding.runId), claim.evidence);
      if (outcome !== "recorded") throw new Error(`goal_complete_${outcome}: a turn either requests a wait or declares completion, once.`);
      return { declared: true, note: "The host closes the Goal only if its ledger also shows no open work." };
    }
    case "goal_tactic":
    case "goal_plan_op":
    case "goal_kpi": {
      const operation = request.operation;
      if (!binding.tools?.includes(operation)) throw new Error("turn-tools-operation-invalid");
      const a = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args as Record<string, unknown> : null;
      if (!a) throw new Error(`${operation}_invalid: arguments must be an object`);
      // The line the text protocol would carry; the unchanged parser decides whether it is well formed.
      const line = GOAL_PLAN_TOOL_MARKERS[operation] + JSON.stringify(a);
      const parsed = operation === "goal_kpi" ? extractAgentStrategyMarkers(line).kpis.length : (() => {
        const result = extractGoalPlanMarkers(line);
        return operation === "goal_tactic" ? result.tactics.length : result.ops.length;
      })();
      if (parsed !== 1) throw new Error(`${operation}_invalid: the host could not read this ${operation === "goal_kpi" ? "KPI sample" : operation === "goal_tactic" ? "tactic report" : "plan change"}; check the required fields`);
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      const goal = await goalResolver(binding.chatId, Date.now());
      if (!goal) throw new Error(`${operation}_no_goal: No Goal is bound to this chat.`);
      if (!recordGoalPlanLine(turnNotesKey(binding.chatId, binding.runId), line)) throw new Error(`${operation}_limit: at most ${GOAL_PLAN_LINE_LIMIT} plan reports per turn`);
      return { recorded: "pending_host", note: "The host applies it when this turn ends and re-checks it against the plan." };
    }
    case "ask_form": {
      if (!binding.tools?.includes("ask_form")) throw new Error("turn-tools-operation-invalid");
      const a = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args as Record<string, unknown> : null;
      if (!a) throw new Error("ask_form_invalid: arguments must be an object");
      const unknownField = Object.keys(a).find((key) => key !== "questions");
      if (unknownField) throw new Error(`ask_form_unknown_field: ${unknownField}`);
      if (!Array.isArray(a.questions) || a.questions.length < 1 || a.questions.length > TURN_ASK_LIMIT) throw new Error(`ask_form_invalid: questions must hold 1-${TURN_ASK_LIMIT} items`);
      // Same parser the text block goes through (limits, template rejection); one bad question refuses the whole call.
      const asks: AgentlasAskQuestion[] = [];
      for (let i = 0; i < a.questions.length; i += 1) {
        const parsed = parseAskFenceBody(JSON.stringify(a.questions[i]));
        if (!parsed) throw new Error(`ask_form_invalid: question ${i + 1} needs a filled question text and 2-8 options with labels`);
        asks.push(parsed);
      }
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      if (!recordTurnAsk(turnNotesKey(binding.chatId, binding.runId), asks)) throw new Error(`ask_form_limit: at most ${TURN_ASK_LIMIT} questions per turn; ask the rest after the answer`);
      return { shown: "pending_host", note: "End your turn now; the person's answer arrives as the next message." };
    }
    case "memory_note": {
      if (binding.tools && !binding.tools.includes("memory_note")) throw new Error("turn-tools-operation-invalid");
      const parsed = memoryNoteToEvent(request.args);
      if (!parsed.ok) throw new Error(parsed.error);
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      const slot = recordTurnMemoryNote(turnNotesKey(binding.chatId, binding.runId), parsed.event);
      if (slot === null) throw new Error(`memory_note_limit: at most ${TURN_MEMORY_NOTE_LIMIT} notes per turn; merge the rest into one note`);
      return { recorded: true, note: slot, status: "queued_for_curator" };
    }
    case "harness_search":
    case "harness_describe":
    case "harness_call": {
      const operation = request.operation;
      if (!binding.tools?.includes(operation)) throw new Error("turn-tools-operation-invalid");
      const a = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args as Record<string, unknown> : {};
      const harness = await import("../harness/capability-ports");
      if (capabilities.get(binding.capabilityId) !== binding) throw new Error("turn-tools-capability-invalid");
      const ctx = { chatId: binding.chatId, runId: binding.runId, dryRun: binding.dryRun === true,
        signal: requestSignal ? AbortSignal.any([lifetime.signal, requestSignal]) : lifetime.signal,
        hostAccountBinding: binding.hostAccountBinding ?? null,
        ...(binding.permission ? { permission: binding.permission } : {}), ...(binding.graphAuthoring === true ? { graphAuthoring: true } : {}),
        ...(binding.mcpConfigPath ? { mcpConfigPath: binding.mcpConfigPath } : {}) };
      if (operation === "harness_search") {
        const kind = typeof a.kind === "string" ? a.kind as Parameters<typeof harness.searchHarness>[1] : undefined;
        return { items: await harness.searchHarness(typeof a.query === "string" ? a.query.slice(0, 500) : "", kind) };
      }
      // A model passes the id it just read under the key that result used: dev replay r09 (2026-10-17) Film sent
      // harness_call {id:"media.listen",args} (harness_search items are {id}) and then {operationId:"media.listen",
      // input:"{…}"} (harness_describe answers {operationId}); both were refused operation_unknown before it found
      // `operation`. The id is the same under any of these keys, and arguments may arrive as an object or a JSON string.
      if (operation === "harness_describe") return harness.describeHarness(harnessId(a, ["id", "operationId", "operation", "name"]), ctx);
      // Cancellation crosses the host boundary; no signal or authority comes from model JSON.
      const checkAdmission = () => {
        try { if (binding.admissionCurrent && !binding.admissionCurrent()) capabilityAborters.get(binding.capabilityId)?.abort(); }
        catch { capabilityAborters.get(binding.capabilityId)?.abort(); }
      };
      checkAdmission();
      const timer = binding.admissionCurrent ? setInterval(checkAdmission, 100) : undefined;
      timer?.unref();
      try { return await harness.callHarnessPort(harnessId(a, ["operation", "operationId", "id", "name"]), harnessArgs(a), ctx); }
      finally { if (timer) clearInterval(timer); }
    }
    default:
      throw new Error("turn-tools-operation-invalid");
  }
}

function dispose(): void {
  for (const controller of capabilityAborters.values()) controller.abort();
  capabilityAborters.clear();
  capabilities.clear();
  capabilityFiles.clear();
  askWithheld.clear();
  if (server) { try { server.close(); } catch { /* best effort */ } }
  server = null;
  boundPort = 0;
  serverToken = "";
}

export function startTurnToolsControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = hostRootContext(() => new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/turn") return writeJson(res, 404, { ok: false, error: "not-found" });
      if (!loopbackHost(req.headers.host, boundPort)) return writeJson(res, 403, { ok: false, error: "invalid-host" });
      const requestLifetime = new AbortController();
      res.once("close", () => { if (!res.writableFinished) requestLifetime.abort(); });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          const result = await outsideInvocationJudgmentContext(() => handleTurnToolsControlRequest(body, requestLifetime.signal));
          // A failed harness call reaches the model and every receipt as an MCP tool error with its typed code.
          const errorCode = harnessCallFailureCode(body.operation, result);
          const imageResults = typeof body.capabilityId === "string" && capabilities.get(body.capabilityId)?.imageResults === true;
          const wire = errorCode || !imageResults ? result : harnessResultWithImages(body.operation, result);
          if (!res.destroyed) writeJson(res, 200, { ok: true, result: wire, ...(errorCode ? { isError: true, errorCode } : {}) });
        } catch (error) {
          if (!res.destroyed) writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "turn-tool-failed" });
        }
      });
    });
    srv.once("error", () => { server = null; boundPort = 0; resolve(0); });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      srv.unref();
      if (!shutdownRegistered) { shutdownRegistered = true; onHostShutdown(dispose); }
      resolve(boundPort);
    });
  }));
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

/** Mint a per-config capability file (0600) that the MCP child reads. */
export async function createTurnToolsCapability(
  input: Omit<TurnToolsCapabilityBinding, "capabilityId" | "hostAccountBinding">,
  configKey: string,
): Promise<{ path: string; binding: TurnToolsCapabilityBinding }> {
  let hostAccountBinding: TurnToolsCapabilityBinding['hostAccountBinding'] = null;
  try { const auth = await import('../auth'); const current = auth.getAuthenticatedSessionBinding(); hostAccountBinding = current ? Object.freeze({ ...current }) : null; }
  catch { /* Other harness domains remain available; Finance refuses an unbound account. */ }
  const port = await startTurnToolsControlServer();
  if (!port) throw new Error("turn-tools-control-unavailable");
  const binding: TurnToolsCapabilityBinding = { ...input, hostAccountBinding, capabilityId: randomUUID() };
  capabilities.set(binding.capabilityId, binding);
  capabilityAborters.set(binding.capabilityId, new AbortController());
  const directory = controlDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const target = capabilityPath(configKey, binding.capabilityId);
  writeCapabilityFile(target, port, binding);
  capabilityFiles.set(binding.capabilityId, target);
  // A capability minted while this run's team dispatch is open starts without ask_form too.
  const held = askWithheld.get(binding.runId);
  if (held && binding.tools?.includes("ask_form")) {
    held.restore.set(binding.capabilityId, binding.tools);
    setCapabilityTools(binding, binding.tools.filter((tool) => tool !== "ask_form"));
  }
  return { path: target, binding };
}

function writeCapabilityFile(target: string, port: number, binding: TurnToolsCapabilityBinding): void {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port, token: serverToken, capabilityId: binding.capabilityId, tools: binding.tools ?? TURN_TOOLS_BASE }), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
}

/** The host check (binding.tools) and the list the child re-reads on every tools/list and tools/call move together. */
function setCapabilityTools(binding: TurnToolsCapabilityBinding, tools: readonly string[]): void {
  binding.tools = tools;
  const file = capabilityFiles.get(binding.capabilityId);
  if (file && boundPort) {
    try { writeCapabilityFile(file, boundPort, binding); } catch { /* the host check above still refuses the call */ }
  }
}

/**
 * Team workers never ask the owner: the orchestrator owns owner questions (owner 2026-10-16, A/B T1). Task-force,
 * swarm and firm delegates share the run's MCP config, so while a dispatch is open ask_form leaves every capability
 * bound to that run — the child lists it no more and the host refuses it. The orchestrator's own turns of those
 * dispatches carry no MCP config and keep their text ask. Nested and parallel dispatches of one run are counted;
 * the last release restores the run's original tools. Returns the release (idempotent).
 */
export function withholdTurnAskForRun(runId: string | undefined | null): () => void {
  if (!runId) return () => {};
  let held = askWithheld.get(runId);
  if (!held) {
    held = { holders: 0, restore: new Map() };
    askWithheld.set(runId, held);
    for (const binding of capabilities.values()) {
      if (binding.runId !== runId || !binding.tools?.includes("ask_form")) continue;
      held.restore.set(binding.capabilityId, binding.tools);
      setCapabilityTools(binding, binding.tools.filter((tool) => tool !== "ask_form"));
    }
  }
  held.holders += 1;
  const entry = held;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holders -= 1;
    if (entry.holders > 0 || askWithheld.get(runId) !== entry) return;
    askWithheld.delete(runId);
    for (const [capabilityId, tools] of entry.restore) {
      const binding = capabilities.get(capabilityId);
      if (binding) setCapabilityTools(binding, tools);
    }
  };
}

export function removeTurnToolsCapability(configKey: string, capabilityId: string): void {
  capabilityAborters.get(capabilityId)?.abort();
  capabilityAborters.delete(capabilityId);
  capabilities.delete(capabilityId);
  capabilityFiles.delete(capabilityId);
  try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
}

/** Gate hook: how many capabilities are live (a revoked run's token no longer works). */
export function turnToolsCapabilityLive(capabilityId: string): boolean {
  return capabilities.has(capabilityId);
}
