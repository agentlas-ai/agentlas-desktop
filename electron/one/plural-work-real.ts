/*
 * The real wiring behind plural-work-core.ts: lazy requires only, so the core can be driven by a fake server and a scratch store.
 * Two halves, because the process that HEARS a hand-off row and the process that RUNS the Work are not always the same one:
 *   - intake (`startPluralWorkIntake`): in the process that holds the mobile bridge (Desktop Main, or the background service when the window is closed), next to the place link and the shared-memory sync.
 *     The Work goes to the supervisor wherever the personal domain lives (the same choice the phone bridge makes), so a Work heard in Main can run in the service and the other way round.
 *   - host (`startPluralWorkHost`): in the process that hosts the Work queue (supervisor.ts). It sends the end of a plural Work when the store says it ended, and gives the host gate its port to the row
 *     (`setPluralRowAsker`: ask / answer / close of a question by its request id). There is no five-minute cancel of the Work any more: a question of a row sits until the sender answers or the row ends.
 * What an ended Work answered, and whether a job still goes, is read from the supervisor's own tables (one_supervisor_work_jobs / _requests / _notices): this wiring owns no table and no timer.
 */
import type Database from "better-sqlite3";
import { createPluralWorkReceiver, isPluralCommand, type PluralWorkPorts, type PluralWorkReceiver, PLURAL_RUNNING_IDS_MAX } from "./plural-work-core";
import type { AskAnswer, FinishWhy, PluralEnd, RemoteAsk } from "./plural-handoff-wire";
import { realCall } from "./shared-memory-real";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import type { PluralAnswer } from "../mobile-bridge/places-link";

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;

/** A request of the web service with the login session's cookie (the same call every desktop route here uses). */
export interface PluralRequestDeps {
  origin(): string;
  request(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }> | null;
  log?(line: string): void;
}
/** Basis: the same bound the place link and the shared-memory push use for one request to the web service. At the limit: the request counts as a time-out and the ladder repeats it. */
export const PLURAL_REQUEST_TIMEOUT_MS = 20_000;

export function realPluralPort(hostId: () => string | null, deps: PluralRequestDeps): PluralWorkPorts["post"] {
  const call = realCall(deps);
  return async (body) => {
    const host = hostId();
    if (!host) return { ok: false, status: 0, unreachable: true, code: "no_host" };
    return call("POST", "/api/desktop/plural", { ...body, hostId: host });
  };
}

export function readHostId(): string | null {
  try {
    const fs = req<typeof import("node:fs")>("node:fs");
    const pairing = req<typeof import("../mobile-bridge/pairing")>("../mobile-bridge/pairing");
    const { userDataDir } = req<typeof import("../runtime-paths")>("../runtime-paths");
    const row: unknown = JSON.parse(fs.readFileSync(pairing.mobileBridgeHostIdentityPath(userDataDir()), "utf8"));
    const id = row && typeof row === "object" ? (row as { hostId?: unknown }).hostId : null;
    return typeof id === "string" && /^host_[a-f0-9]{32}$/.test(id) ? id : null;
  } catch { return null; }
}

const TERMINAL_PHASES = "'completed','failed','cancelled'";
const ENDED_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
type JobRow = { command_id: string; one_id: string; task_id: string; chat_id: string; run_id: string; phase: string; reason: string | null; generation: number; owner_epoch: string | null };

/**
 * Reasons that say the Work never went into execution (the receipt's / the job's own word; the executor writes them before any native start): the row's `started` is false and its end may be tried again by hand.
 * Locked by a source assertion in scripts/test-e1-plural-work.cjs against supervisor-work-executor.ts / supervisor-service.ts / supervisor-work-queue.ts.
 */
export const NOT_STARTED_REASONS: ReadonlySet<string> = new Set(["cancelled_before_dispatch", "owner_stopped_before_start", "companion_start_unavailable", "supervisor_start_retry_exhausted", "work_owner_unconfirmed"]);
/** The Work was cut short without a known outcome: a quit, a crash, or a dispatch whose result nobody can tell (after the queue's own resends). */
export const INTERRUPTED_REASONS: ReadonlySet<string> = new Set(["interrupted_requires_review", "native_dispatch_outcome_unknown", "owner_stopped_outcome_unknown"]);

/** A run's typed error code to the closed word of the wire; a code this table does not know is `error`. */
export function failedWhyOf(code: string): FinishWhy {
  if (/quota|rate_limit|rate_limited|usage_limit|limit_reached|credit|overloaded/.test(code)) return "limit";
  if (/login_required|remote_ask_shell_gate_unavailable|runtime_unavailable|not_signed_in|no_runtime|sign_in|runtime_not_installed/.test(code)) return "no_runner";
  if (/version_mismatch|update_required|desktop_update/.test(code)) return "desktop_update";
  return "error";
}

/** The ended job's own end, from the supervisor's tables only (job phase, the request's receipt reason, a stop request that came from the row). No model word is read except the result text. */
export function storeEndOf(db: Database.Database): (commandId: string) => PluralEnd | null {
  return (commandId) => {
    try {
      const job = db.prepare("SELECT * FROM one_supervisor_work_jobs WHERE command_id=?").get(commandId) as JobRow | undefined;
      if (!job) return null;
      const row = db.prepare("SELECT receipt_json FROM one_supervisor_requests WHERE command_id=?").get(commandId) as { receipt_json: string } | undefined;
      let reason = job.reason ?? "";
      try { reason = (JSON.parse(row?.receipt_json ?? "{}") as { reason?: string }).reason ?? reason; } catch { /* the job's own reason */ }
      if (job.phase === "cancelled" || job.phase === "failed") {
        if (INTERRUPTED_REASONS.has(reason) || INTERRUPTED_REASONS.has(job.reason ?? "")) return { state: "stopped", why: "interrupted", started: true };
        if (job.phase === "cancelled") {
          // the stop came from the row (the sender's cancel, a release) when the stop request this wiring makes (`plural_stop_<id>`, see stopWork) exists; any other stop is the person's of this desktop
          const fromRow = Boolean(db.prepare("SELECT 1 FROM one_supervisor_requests WHERE command_id=?").get(stopCommandOf(commandId)));
          return { state: "stopped", why: fromRow ? "cancelled" : "stopped_here", started: !NOT_STARTED_REASONS.has(reason) && !NOT_STARTED_REASONS.has(job.reason ?? "") };
        }
        return { state: "failed", why: failedWhyOf(reason), started: !NOT_STARTED_REASONS.has(reason) };
      }
      if (job.phase !== "completed") return null;
      const notice = db.prepare(`SELECT run_id FROM one_supervisor_notices WHERE one_id=? AND task_id=? AND state='completed' ORDER BY rowid DESC LIMIT 1`).get(job.one_id, job.task_id) as { run_id: string } | undefined;
      const { supervisorExactResult } = req<typeof import("./supervisor-presentation")>("./supervisor-presentation");
      const text = supervisorExactResult(db, job.chat_id, notice?.run_id ?? job.run_id)?.text ?? supervisorExactResult(db, job.chat_id, job.run_id)?.text ?? "";
      return { state: "done", started: true, text };
    } catch { return null; }
  };
}
/** The command id of the stop request this wiring files for a Work (the same word in stopWork and in storeEndOf). */
export const stopCommandOf = (commandId: string): string => `plural_stop_${commandId.slice(7, 47)}`;

/** Row ids of the plural Works this desktop's store has going (not ended), oldest first, bounded: the GET's `running`. */
export function storeRunningRows(db: Database.Database): string[] {
  try {
    const rows = db.prepare(`SELECT command_id FROM one_supervisor_work_jobs WHERE phase NOT IN (${TERMINAL_PHASES}) AND command_id LIKE 'plural\\_%' ESCAPE '\\' ORDER BY rowid LIMIT ?`).all(PLURAL_RUNNING_IDS_MAX) as Array<{ command_id: string }>;
    return rows.map(r => r.command_id).filter(isPluralCommand).map(c => c.slice(7));
  } catch { return []; }
}

export function storeJobOf(db: Database.Database): PluralWorkPorts["jobOf"] {
  return (commandId) => {
    try {
      const job = db.prepare("SELECT phase FROM one_supervisor_work_jobs WHERE command_id=?").get(commandId) as { phase: string } | undefined;
      if (job) return { phase: job.phase as never };
      // admitted but not queued yet is still "going": the request row exists
      return db.prepare("SELECT 1 FROM one_supervisor_requests WHERE command_id=?").get(commandId) ? { phase: "queued" } : null;
    } catch { return null; }
  };
}

/** The supervisor where the personal domain lives: the service's own when it hosts it, else the endpoint that reaches Main's or the service's (the phone bridge's choice). */
function supervisorTarget(): { call: () => Record<string, (...args: unknown[]) => Promise<unknown>>; ready: () => boolean } {
  const sup = req<typeof import("./supervisor")>("./supervisor");
  const rt = req<typeof import("./supervisor-native-runtime")>("./supervisor-native-runtime");
  const pick = () => (sup.supervisorRunsInDaemon() ? sup.oneSupervisor() : rt.oneSupervisorEndpoint()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const ready = (): boolean => {
    try {
      if (sup.supervisorRunsInDaemon()) return true;
      // a process that is not the domain's own host and has no endpoint to it (the service before it adopted the domain) hands nothing over
      if (process.env.ELECTRON_RUN_AS_NODE === "1") return false;
      return rt.supervisorRuntimeMode() !== "handoff";
    } catch { return false; }
  };
  return { call: pick, ready };
}

export interface PluralIntakeDeps extends PluralRequestDeps {
  hostId(): string | null;
  /** One more GET of the place link. */
  readAgain(): void;
  db?(): Database.Database;
  /** Close the local card of a request with the row's answer. Default: realLocalApprovalAnswer (Main's queue, then the service's card through the native channel). */
  answerApproval?(qid: string, decision: "allow_once" | "deny"): Promise<boolean>;
  /** Told when this account signs out (auth.ts onExplicitSignOut); default: that hook. Tests pass their own. */
  onSignOut?(listener: () => void): () => void;
}

/**
 * The row's answer to a question of this desktop's run, applied to the local card of that request id - the same road the phone's answer and the personal agent's `one_approval_answer` take (supervised-approvals.ts defaultSources().resolveTool):
 * a card Main holds is resolved in this process; a card the background service holds is resolved through the native approval port (a context this module mints). Not found = already closed: true when the closed decision is the same.
 */
const nativeGrants = new WeakMap<object, { requestId: string; chatId: string }>();
export async function realLocalApprovalAnswer(qid: string, decision: "allow_once" | "deny"): Promise<boolean> {
  const approvals = req<typeof import("../runtime/tool-approval")>("../runtime/tool-approval");
  const actionId = toolApprovalActionId(qid, decision);
  type Controls = { hasApproval(id: string): boolean; listAvailableApprovals(): Array<{ id: string; chatId?: string }>; mobileApprovalPort(authorize: (context: object, request: { id: string; chatId?: string }) => void): { select(id: string): { resolve(context: object, decision: "allow_once" | "deny", actionId: string): Promise<unknown> | unknown } | null } };
  const nativeControls = (): Controls | null => { try { return req<typeof import("../invocation/native-gui-controls")>("../invocation/native-gui-controls").configuredNativeGuiControls() as unknown as Controls | null; } catch { return null; } };
  const controls = nativeControls();
  type Receipt = { ok?: boolean; status?: string; resolvedDecision?: string };
  let receipt: Receipt;
  if (controls?.hasApproval(qid)) {
    const request = controls.listAvailableApprovals().find(r => r.id === qid);
    const selection = controls.mobileApprovalPort((context, r) => { const g = nativeGrants.get(context); if (!g || g.requestId !== r.id || g.chatId !== (r.chatId ?? "")) throw new Error("plural_approval_native_unauthorized"); }).select(qid);
    if (!selection) receipt = approvals.getToolApprovalResolution(qid) as Receipt;
    else { const context = Object.freeze({}); nativeGrants.set(context, { requestId: qid, chatId: request?.chatId ?? "" }); receipt = await selection.resolve(context, decision, actionId) as Receipt; }
  } else if (approvals.isRemoteApprovalOpen(qid)) {
    // the row already has this answer: settle the waiting call with it (the local click path would post it to the row once more)
    receipt = (approvals.resolveRemoteApprovalFromRow(qid, decision === "deny" ? "deny" : "allow") ?? approvals.getToolApprovalResolution(qid)) as Receipt;
  } else receipt = approvals.resolveToolApproval(qid, decision, actionId, "phone") as Receipt;
  return (receipt.status === "resolved" || receipt.status === "replayed") && (receipt.resolvedDecision === undefined || receipt.resolvedDecision === decision);
}

/** BO: what a Work another agent handed to this desktop is, as a card row in the personal agent's conversation (plural-handoff-cards.ts). The brief is the words after the fixed first line (core: receivedWorkText). Never throws. */
function recordReceivedCardOf(remoteAsk: RemoteAsk, text: string, phase: "running" | "end", end?: PluralEnd): void {
  try {
    const cards = req<{ recordReceivedCard(input: { rowId: string; fromName: string; brief: string; chatId: string | null; phase: "running" | "end"; end?: PluralEnd }): unknown }>("./plural-handoff-cards");
    const at = text.indexOf("\n");
    cards.recordReceivedCard({ rowId: remoteAsk.rowId, fromName: remoteAsk.fromName, brief: at >= 0 ? text.slice(at + 1) : text, chatId: null, phase, ...(end ? { end } : {}) });
  } catch { /* a card is a courtesy */ }
}
function recordReceivedEnd(db: Database.Database, commandId: string): void {
  try {
    const row = db.prepare("SELECT payload_json FROM one_supervisor_requests WHERE command_id=?").get(commandId) as { payload_json: string } | undefined;
    const payload = JSON.parse(row?.payload_json ?? "{}") as { text?: unknown; remoteAsk?: unknown };
    const remote = req<typeof import("./plural-remote-ask")>("./plural-remote-ask").parseRemoteAsk(payload.remoteAsk);
    const end = storeEndOf(db)(commandId);
    if (remote && end && typeof payload.text === "string") recordReceivedCardOf(remote, payload.text, "end", end);
  } catch { /* a card is a courtesy */ }
}

export function startPluralWorkIntake(deps: PluralIntakeDeps): { stop(): void; receiver: PluralWorkReceiver } {
  const db = (): Database.Database => deps.db ? deps.db() : req<typeof import("../store/db")>("../store/db").getDb();
  const target = supervisorTarget();
  const ports: PluralWorkPorts = {
    post: realPluralPort(deps.hostId, deps),
    sleep: (ms) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
    readAgain: deps.readAgain,
    ready: target.ready,
    jobOf: (id) => storeJobOf(db())(id),
    outcomeOf: (id) => storeEndOf(db())(id),
    runningRows: () => storeRunningRows(db()),
    answerLocal: async (qid, answer: AskAnswer) => (deps.answerApproval ?? realLocalApprovalAnswer)(qid, answer === "deny" ? "deny" : "allow_once"),   // "allow_task" is an allow of this one call; the row keeps what the task allows
    startWork: async ({ commandId, text, doneWhen, remoteAsk }) => {
      await target.call().startWork({ commandId, text, remoteAsk, ...(doneWhen.length ? { doneWhen } : {}) });
      recordReceivedCardOf(remoteAsk, text, "running");   // BO: the received-work card in the conversation (best effort, a card never changes the Work)
    },
    sendMessage: async ({ commandId, text }) => { await target.call().send({ commandId, text }, { surface: "mobile" }); },
    stopWork: async (commandId) => {
      const d = db();
      const job = d.prepare("SELECT * FROM one_supervisor_work_jobs WHERE command_id=?").get(commandId) as JobRow | undefined;
      if (!job) return "none";
      const queue = new (req<typeof import("./supervisor-work-queue")>("./supervisor-work-queue").OneSupervisorWorkQueue)(d, false);
      const lease = queue.get(commandId);
      if (!lease) return "none";
      const oneId = lease.one_id;
      await target.call().stopTask({ oneId, commandId: stopCommandOf(commandId), taskId: lease.task_id, runId: lease.run_id, expectedVersion: queue.version(lease) });
      const after = queue.get(commandId);
      return after && ["cancelled"].includes(after.phase) ? "removed" : "requested";
    },
    ...(deps.log ? { log: (line: string) => deps.log!(`[plural-work] ${line}`) } : {}),
  };
  const receiver = createPluralWorkReceiver(ports);
  const places = req<typeof import("../mobile-bridge/places-link")>("../mobile-bridge/places-link");
  const onAnswer = (a: PluralAnswer): void => { void receiver.handle(a).catch(() => undefined); };
  const off = places.onPluralAnswer(onAnswer);
  places.setPluralRunningProvider(() => storeRunningRows(db()));   // the GET names the Works this desktop has going: the server answers `cancel[]` for the ones it has ended
  // a sign-out tells the server once: it ends the rows of this place and frees it (the cookie is still there when auth.ts emits this; no wait, no error)
  let offSignOut: () => void = () => undefined;
  try { offSignOut = (deps.onSignOut ?? ((l) => req<typeof import("../auth")>("../auth").onExplicitSignOut(() => l())))(() => { void receiver.gone(); }); } catch { /* a process without the auth module has no sign-out of its own */ }
  const last = places.lastPluralAnswer();
  if (last) onAnswer(last);
  return { receiver, stop: () => { receiver.stop(); off(); offSignOut(); places.setPluralRunningProvider(null); } };
}

export interface PluralHostDeps extends PluralRequestDeps {
  db: Database.Database;
  /** The store's "a request or a notice was written" signal (this process wrote it). */
  onActivity(listener: () => void): () => void;
  /** Settled runs of this process (the host's own signal). */
  onSettled(listener: () => void): () => void;
  /** Kept for the callers that still pass it: a Work is no longer cancelled by an unanswered question. */
  cancelRun?(runId: string): unknown;
  hostId?(): string | null;
  /** Kept for the callers that still spread `realApprovalHooks()`: nothing reads them (the five-minute cancel is gone). */
  onApprovalAsked?(listener: (id: string, chatId: string | undefined) => void): () => void;
  onApprovalExpired?(listener: (id: string) => void): () => void;
}

export function startPluralWorkHost(deps: PluralHostDeps): { stop(): void; receiver: PluralWorkReceiver } {
  const sent = new Set<string>();   // ends this process sent in its life: a bounded memory (the server ignores a repeat; this only saves the call)
  const startedAt = new Date().toISOString();
  const hostId = deps.hostId ?? readHostId;
  const receiver = createPluralWorkReceiver({
    post: realPluralPort(hostId, deps),
    sleep: (ms) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
    readAgain: () => undefined, ready: () => false,
    jobOf: (id) => storeJobOf(deps.db)(id), outcomeOf: (id) => storeEndOf(deps.db)(id), runningRows: () => storeRunningRows(deps.db), answerLocal: async () => false,
    startWork: async () => { throw new Error("host_half_does_not_start"); }, sendMessage: async () => { throw new Error("host_half_does_not_place"); }, stopWork: async () => "none",
    ...(deps.log ? { log: (line: string) => deps.log!(`[plural-work] ${line}`) } : {}),
  });
  // the host gate of this process asks the row through this port (B: plural-remote-ask.ts); a build without that module has no gate to serve
  let unregisterAsker: () => void = () => undefined;
  try { const ra = req<{ setPluralRowAsker?(asker: unknown): (() => void) | void }>("./plural-remote-ask"); const off = ra.setPluralRowAsker?.(receiver.asker); if (typeof off === "function") unregisterAsker = off; } catch { /* no gate in this build */ }
  let scanning = false, rescan = false;
  async function scan(): Promise<void> {
    if (scanning) { rescan = true; return; }
    scanning = true;
    try {
      do {
        rescan = false;
        void receiver.flushCloses();
        // ended Works of this process's life whose command is a plural one (the prefix is read with the exact-id check below)
        const rows = deps.db.prepare(`SELECT command_id FROM one_supervisor_work_jobs WHERE phase IN (${TERMINAL_PHASES}) AND updated_at>=? AND command_id LIKE 'plural\\_%' ESCAPE '\\' ORDER BY rowid LIMIT 200`)
          .all(Date.parse(startedAt)) as Array<{ command_id: string }>;
        for (const { command_id } of rows) {
          if (!isPluralCommand(command_id) || sent.has(command_id)) continue;
          const j = deps.db.prepare("SELECT phase, one_id, task_id FROM one_supervisor_work_jobs WHERE command_id=?").get(command_id) as { phase: string; one_id: string; task_id: string } | undefined;
          // a completed end reads its result through the notice of the run: wait until the notice is written
          if (j?.phase === "completed" && !deps.db.prepare("SELECT 1 FROM one_supervisor_notices WHERE one_id=? AND task_id=? AND state='completed' LIMIT 1").get(j.one_id, j.task_id)) continue;
          recordReceivedEnd(deps.db, command_id);
          await receiver.ended(command_id);
          if (!receiver.switchClosed) { sent.add(command_id); if (sent.size > 400) sent.delete(sent.values().next().value as string); }
        }
      } while (rescan);
    } catch { /* the next signal looks again; the server's `held` list carries what was missed */ }
    finally { scanning = false; }
  }
  const stops = [deps.onActivity(() => { void scan(); }), deps.onSettled(() => { const t = setTimeout(() => { void scan(); }, 300); t.unref?.(); })];
  return { receiver, stop: () => { receiver.stop(); unregisterAsker(); for (const stop of stops) { try { stop(); } catch { /* gone */ } } } };
}

/** The login session's request, read from the auth module when it is asked (a process that is signed out answers null: nothing is sent). */
export function realRequestDeps(log?: (line: string) => void): PluralRequestDeps {
  const auth = (): typeof import("../auth") => req<typeof import("../auth")>("../auth");
  return {
    origin: () => auth().webBaseUrl(),
    request: (url, init) => { const cookie = auth().getSessionCookieHeader(); return cookie ? auth().fetchWithHubSession(cookie, url, init, PLURAL_REQUEST_TIMEOUT_MS) : null; },
    ...(log ? { log } : {}),
  };
}

/** Kept so the host's caller keeps compiling: a question of a row no longer ends a Work, so there is nothing to listen to (see startPluralWorkHost). */
export function realApprovalHooks(): Pick<PluralHostDeps, "onApprovalAsked" | "onApprovalExpired"> { return {}; }
