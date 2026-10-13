import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { memoryNoteToEvent } from "../memory/events";
import { recordTurnMemoryNote, turnNotesKey, TURN_MEMORY_NOTE_LIMIT } from "./notes";
import { GOAL_PLAN_LINE_LIMIT, recordGoalCompleteSignal, recordGoalPlanLine, recordGoalWaitSignal, validateGoalWaitIntent } from "./goal-signals";
import { extractGoalPlanMarkers } from "../../shared/goal-shape";
import { extractAgentStrategyMarkers } from "../../shared/agent-strategy";
import { stripGoalCompleteMarker } from "../hephaestus/loop-engineering";
import { goalCompleteMarkerText } from "./goal-signals";
import { GOAL_PLAN_TOOL_MARKERS, TURN_TOOLS_BASE } from "./mcp-server";

// Main-side handler for the inline agentlas-turn MCP child. Loopback only, one random server token, one capability per
// run config. The capability pins the chat and run; the child can name neither, so a note can only land in the turn
// that holds the capability.

const MAX_REQUEST_BYTES = 128 * 1024;

export interface TurnToolsCapabilityBinding {
  capabilityId: string;
  chatId: string;
  runId: string;
  /** Graph dry-run or plan mode: nothing is recorded. */
  dryRun?: boolean;
  /** Tools this run may call (the child lists only these; the host re-checks). Default: memory_note. */
  tools?: readonly string[];
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
  const authority = timerWaitAuthority(goalId, nowMs);
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

export async function handleTurnToolsControlRequest(request: Record<string, unknown>): Promise<unknown> {
  if (typeof request.token !== "string" || !serverToken || request.token !== serverToken) throw new Error("turn-tools-capability-invalid");
  const binding = typeof request.capabilityId === "string" ? capabilities.get(request.capabilityId) : undefined;
  if (!binding) throw new Error("turn-tools-capability-invalid");
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
    case "memory_note": {
      if (binding.tools && !binding.tools.includes("memory_note")) throw new Error("turn-tools-operation-invalid");
      const parsed = memoryNoteToEvent(request.args);
      if (!parsed.ok) throw new Error(parsed.error);
      if (binding.dryRun) return { recorded: false, reason: "dry_run" };
      const slot = recordTurnMemoryNote(turnNotesKey(binding.chatId, binding.runId), parsed.event);
      if (slot === null) throw new Error(`memory_note_limit: at most ${TURN_MEMORY_NOTE_LIMIT} notes per turn; merge the rest into one note`);
      return { recorded: true, note: slot, status: "queued_for_curator" };
    }
    default:
      throw new Error("turn-tools-operation-invalid");
  }
}

function dispose(): void {
  capabilities.clear();
  if (server) { try { server.close(); } catch { /* best effort */ } }
  server = null;
  boundPort = 0;
  serverToken = "";
}

export function startTurnToolsControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/turn") return writeJson(res, 404, { ok: false, error: "not-found" });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          writeJson(res, 200, { ok: true, result: await handleTurnToolsControlRequest(body) });
        } catch (error) {
          writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "turn-tool-failed" });
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
  });
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

/** Mint a per-config capability file (0600) that the MCP child reads. */
export async function createTurnToolsCapability(
  input: Omit<TurnToolsCapabilityBinding, "capabilityId">,
  configKey: string,
): Promise<{ path: string; binding: TurnToolsCapabilityBinding }> {
  const port = await startTurnToolsControlServer();
  if (!port) throw new Error("turn-tools-control-unavailable");
  const binding: TurnToolsCapabilityBinding = { ...input, capabilityId: randomUUID() };
  capabilities.set(binding.capabilityId, binding);
  const directory = controlDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const target = capabilityPath(configKey, binding.capabilityId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port, token: serverToken, capabilityId: binding.capabilityId, tools: binding.tools ?? TURN_TOOLS_BASE }), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return { path: target, binding };
}

export function removeTurnToolsCapability(configKey: string, capabilityId: string): void {
  capabilities.delete(capabilityId);
  try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
}

/** Gate hook: how many capabilities are live (a revoked run's token no longer works). */
export function turnToolsCapabilityLive(capabilityId: string): boolean {
  return capabilities.has(capabilityId);
}
