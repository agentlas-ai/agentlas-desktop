/*
 * The computer's half of "the connected apps the person attached on the phone, seen from the computer's own answers"
 * (Agentlas 2.0 DD; contracts/desktop-server-tools.md). The keys of those apps stay in the server's vault: this file holds no key, no
 * address and no token. The home computer signs three requests with its device key (`POST one-home/tools/{list,call,tasks}`, signed like every
 * mirror call: one/home.ts) and the server calls the app with its own key.
 *
 * What lives here, and nothing else:
 *   - the stored list (`meta` row `one_server_apps:v1:<userId>`): what the server last said the person has attached (names, tool names,
 *     descriptions, schemas, read-or-write marks) and the revision (`rev`) it said it with. Read by: the turn that builds its tool config, the
 *     signals below. Gone: the account slot forgotten or another account signing in (`forget`), and replaced whole when `rev` changes.
 *   - the signals that may read the list again (one request each, never a timer): the mirror's `start` and `home`, the `appsRev` the mirror's upload answer
 *     carries when it differs from the stored one, the start of a turn that came from the phone, and a call the server refused because the app is gone.
 *     A turn never waits for the answer: it uses what is stored.
 *   - one call (`tools/call`), whose `callId` is made here once per logical call and is the same for every signed attempt of it.
 *   - the long jobs (`pending`, at most 4, 24 hours): read once per signal (`tasks`), the end is attached to the conversation.
 * Every failure is a closed word of the contract (never a sentence of the server): the turn goes on answering, only that app is "not usable now".
 *
 * No Electron import (the background service loads it); everything outside is a port, so a gate drives it with a fake server.
 */
import { createHash, randomBytes } from "node:crypto";

export const SERVER_APPS_CONFIG_KEY = "agentlas-server-apps";
export const SERVER_APPS_META_PREFIX = "one_server_apps:v1:";
export const SERVER_APPS_STATUS_TOOL = "server_apps_status";

/*
 * Numbers. Every one is a value that already exists elsewhere (contract section 9: "no new number").
 *  descriptionChars  240: the text the service gives the model for the same tool on the phone's turns (contract section 5).
 *  schemaBytes       4,096: the server's own `inputSchema` ceiling (contract section 2); a larger schema arrives as `inputSchemaOmitted`.
 *  argumentBytes     16 KiB: the server's `arguments` ceiling (contract section 2); a larger one is refused here, nothing is sent.
 *  stateBytes        1 MiB: the server's answer ceiling (contract section 2 `list`); the stored list is a trimmed copy of one answer.
 *  pendingMax        4: the server's concurrent-call number (contract section 2: "동시 4").
 *  pendingMs         24 h: the server's task lifetime (receipts 24 h, contract section 0).
 *  callWaitMs        65 s: the server's tool wait (60 s) plus its 5 s (contract section 7).
 * listWaitMs 10 s (; was 8 s, the home's ordinary request wait): basis: the server answers a list within its own inner deadline of 8 s per app (`TOOL_LIST_TIMEOUT_MS`,
 *                    dw-web RESULT: a slow app is then `unavailable: upstream_timeout` and the answer is still a 200) plus the margin of 2 s the wait chain table keeps between an inner and an
 *                    outer deadline (`companion-waits.mjs` marginMs). At 8 s the computer gave up on the same tick the server answered and one slow app made the whole list `server_unreachable`.
 *                    Reached: the request ends `server_unreachable` and the stored list stays. The `tasks` read uses the same wait.
 *  ticketMs          60 s: the longest the proxy lets pass between the approval answer and the call (its own request wait, requestTimeoutMs(0)).
 * (F6: `attachChars` is gone.) A finished long job no longer puts the app's words into the conversation: the signal's sweep writes ONE notice (the fact and the tool's name; a display row the
 *                    model's history does not read) and keeps the job in `pending` (<= 4, 24 h, the same row, `done` mark) until the model asks `server_apps_status`; the server holds the result for the
 *                    same 24 h, so nothing is copied here. Reached: a fifth job drops the oldest (finished or not); after 24 h an unread job is dropped (its notice stays).
 * Reached: a longer description or schema is cut/replaced; a longer argument is refused (`arguments_too_large`); a fifth job drops the oldest from the list
 * (the server still holds it for 24 h); a list over 1 MiB is not stored (the previous one stays and `unavailable` is the contract's own word).
 */
export const SERVER_APPS_LIMITS = Object.freeze({
  descriptionChars: 240,
  schemaBytes: 4 * 1024,
  argumentBytes: 16 * 1024,
  stateBytes: 1024 * 1024,
  pendingMax: 4,
  pendingMs: 24 * 3_600_000,
  callWaitMs: 65_000,
  listWaitMs: 10_000,
  ticketMs: 60_000,
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The contract's closed words that a call can end with (nothing else leaves this file as a cause). */
export const SERVER_APP_WORDS: ReadonlySet<string> = new Set([
  "device_proof_invalid", "home_is_server", "stale_epoch", "home_unconfirmed", "authentication_required", "invalid_request", "device_proof_unavailable",
  "account_deleting", "clock_skew", "rate_limited",
  "not_connected", "reconnect_needed", "tool_not_found", "write_not_allowed", "upstream_unavailable", "upstream_timeout", "result_too_large", "storage_full",
  "busy", "duplicate_call", "outcome_unknown", "key_unknown", "key_host_mismatch", "secret_in_request", "address_refused", "bad_request", "arguments_too_large",
  "tools_unavailable", "task_pending", "task_not_found", "task_recovery_unavailable", "task_action_unavailable",
  // the computer's own words (this file / the host): the server never says them
  "server_unreachable", "not_allowed_for_actor", "owner_turn_required", "approval_required", "tool_unknown",
]);
/** A refusal that says the app itself is no longer usable as listed: the list is read again (signal 4). */
const GONE_WORDS: ReadonlySet<string> = new Set(["not_connected", "reconnect_needed", "tool_not_found"]);
/** A refusal of the HOME (not of one app): this computer sees no server apps until a signal finds the home standing again. */
const HOME_HOLD_WORDS: ReadonlySet<string> = new Set(["device_proof_invalid", "home_is_server", "home_unconfirmed", "device_proof_unavailable", "account_deleting", "authentication_required"]);

// ───────────────────────── the stored list ─────────────────────────
/** `costsMoney`: the server's own declaration (`effects.costsMoney: true`, proposed in contracts/desktop-server-tools.md section 12) that a call of this tool spends the person's money. Read only when the server says it; never guessed from a name. */
export interface ServerAppTool { name: string; description: string; inputSchema: Record<string, unknown> | null; readOnly: boolean; destructive: boolean; costsMoney?: true; /** contract section 14: exact lower-case API hosts whose calls of this tool cost the person money (compared with the call's URL host at call time) */ costsMoneyHosts?: string[] }
/** `desktopId`: the id the DESKTOP catalog gives the same app, when it differs from the server's `connectorId` - a column the server's catalog row DECLARES (dw-web RESULT, `MarketplacePlugin.desktopId`).
 *  Absent: the app has the same id on both sides or is server-only. Never derived from a name (no suffix stripping). */
export interface ServerApp { connectorId: string; name: string; desktopId?: string; tools: ServerAppTool[] }
/** `done`: the signal's sweep saw this job finish and wrote its one notice; the job stays (<= 4, 24 h, the same row) until the model reads its result through `server_apps_status`. */
export interface PendingTask { callId: string; chatId: string; tool: string; at: number; done?: true }
export interface ServerAppsState { v: 1; rev: string | null; epoch: number | null; complete: boolean; apps: ServerApp[]; pending: PendingTask[] }
export const emptyServerApps = (): ServerAppsState => ({ v: 1, rev: null, epoch: null, complete: true, apps: [], pending: [] });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REV_RE = /^[a-f0-9]{32}$/;
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Contract section 14: only exact host names count (lower case letters, digits, dots, hyphens; no wildcard, path or port); anything else in the list is left out, an empty result says nothing. */
const HOST_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function costHostsOf(raw: unknown): { costsMoneyHosts?: string[] } {
  if (!Array.isArray(raw)) return {};
  const hosts = [...new Set(raw.slice(0, 64).filter((h): h is string => typeof h === "string" && h.length <= 253 && HOST_NAME_RE.test(h)))].sort();
  return hosts.length ? { costsMoneyHosts: hosts } : {};
}

function parseApp(raw: unknown): ServerApp | null {
  if (!isRecord(raw) || typeof raw.connectorId !== "string" || !ID_RE.test(raw.connectorId) || !Array.isArray(raw.tools)) return null;
  const tools: ServerAppTool[] = [];
  const seen = new Set<string>();
  for (const t of raw.tools.slice(0, 200)) {
    if (!isRecord(t) || typeof t.name !== "string" || !TOOL_RE.test(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    const effects = isRecord(t.effects) ? t.effects : {};
    let schema: Record<string, unknown> | null = null;
    if (isRecord(t.inputSchema) && t.inputSchema !== null && t.inputSchemaOmitted !== true) {
      try { schema = Buffer.byteLength(JSON.stringify(t.inputSchema)) <= SERVER_APPS_LIMITS.schemaBytes ? t.inputSchema : null; } catch { schema = null; }
    }
    // Unknown means "asks": only an explicit readOnly:true is a read.
    tools.push({ name: t.name, description: text(t.description, SERVER_APPS_LIMITS.descriptionChars), inputSchema: schema,
      // A tool the server says costs money is never a read here, whatever else it says: it asks (the window), and the money card is asked every time.
      readOnly: effects.readOnly === true && effects.costsMoney !== true, destructive: effects.destructive === true, ...(effects.costsMoney === true ? { costsMoney: true as const } : {}), ...costHostsOf(effects.costsMoneyHosts) });
  }
  const desktopId = typeof raw.desktopId === "string" && ID_RE.test(raw.desktopId) && raw.desktopId !== raw.connectorId ? raw.desktopId : undefined;
  return { connectorId: raw.connectorId, name: text(raw.name, 80) || raw.connectorId, ...(desktopId ? { desktopId } : {}), tools };
}

function parseState(raw: string | null): ServerAppsState {
  if (!raw) return emptyServerApps();
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v) || v.v !== 1) return emptyServerApps();
    const apps = (Array.isArray(v.apps) ? v.apps : []).map(parseApp).filter((a): a is ServerApp => !!a);
    const pending = (Array.isArray(v.pending) ? v.pending : []).filter(isRecord)
      .filter((p) => typeof p.callId === "string" && CALL_ID_RE.test(p.callId) && typeof p.chatId === "string" && typeof p.tool === "string" && typeof p.at === "number")
      .map((p) => ({ callId: p.callId as string, chatId: (p.chatId as string).slice(0, 200), tool: (p.tool as string).slice(0, 200), at: p.at as number, ...(p.done === true ? { done: true as const } : {}) })).slice(0, SERVER_APPS_LIMITS.pendingMax);
    return { v: 1, rev: typeof v.rev === "string" && REV_RE.test(v.rev) ? v.rev : null, epoch: typeof v.epoch === "number" && Number.isSafeInteger(v.epoch) ? v.epoch : null,
      complete: v.complete !== false, apps, pending };
  } catch { return emptyServerApps(); }
}

// ───────────────────────── names ─────────────────────────
/** The name of one app tool as the runtimes list it: `<connectorId>__<tool>` (contract section 4). */
export function bridgeToolName(connectorId: string, tool: string): string { return `${connectorId}__${tool}`; }
/** The longest a runtime accepts for `mcp__<server>__<tool>` (the Anthropic and OpenAI function-name ceiling; the in-process loop slices at 128 but the CLIs stop at 64). */
export const RUNTIME_TOOL_NAME_MAX = 64;
/** A tool whose bridged name a runtime would refuse (characters outside `[A-Za-z0-9_-]` or too long) is left out, and only that tool (contract section 4). */
export function bridgeNameFits(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name) && `mcp__${SERVER_APPS_CONFIG_KEY}__${name}`.length <= RUNTIME_TOOL_NAME_MAX;
}

export interface BridgeTool { name: string; connectorId: string; tool: string; appName: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; destructive: boolean; costsMoney?: true; costsMoneyHosts?: string[] }
/**
 * The tools a turn gets from a stored list: apps the computer also has itself are left out whole (the computer's wins unless `serverFirst` names it, one line only), a tool whose name does not fit
 * is left out alone, order is fixed (connector id, then tool name: the same bytes every turn while `rev` does not change). No app gives no tools.
 */
export function bridgeTools(state: ServerAppsState, computerHas: ReadonlySet<string>, serverFirst: ReadonlySet<string> = new Set()): BridgeTool[] {
  const out: BridgeTool[] = [];
  const names = new Set<string>();
  for (const app of [...state.apps].sort((a, b) => (a.connectorId < b.connectorId ? -1 : a.connectorId > b.connectorId ? 1 : 0))) {
    // The same app on the computer under either id (the server's, or the one its catalog row declares for the desktop): the computer's wins, one line only.
    // (API first: when the computer's road to this service is LOWER than the server's and the server's is ready, the app stays in the list - `serverFirst`, connectors/route-gate.ts - because the computer's call
    // is refused toward it. Empty = what it always was.)
    if ((computerHas.has(app.connectorId) || (app.desktopId !== undefined && computerHas.has(app.desktopId))) && !serverFirst.has(app.connectorId)) continue;
    for (const tool of [...app.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = bridgeToolName(app.connectorId, tool.name);
      if (!bridgeNameFits(name) || names.has(name)) continue;
      names.add(name);
      out.push({ name, connectorId: app.connectorId, tool: tool.name, appName: app.name, description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true }, readOnly: tool.readOnly, destructive: tool.destructive, ...(tool.costsMoney ? { costsMoney: true as const } : {}), ...(tool.costsMoneyHosts ? { costsMoneyHosts: tool.costsMoneyHosts } : {}) });
    }
  }
  return out;
}

// ───────────────────────── ports ─────────────────────────
export interface ServerAppsAnswer { ok: boolean; status?: number; code?: string; unreachable?: boolean; retryable?: boolean; body?: Record<string, unknown> | null }
export type ServerAppsRoute = "tools/list" | "tools/call" | "tools/tasks";
export type ServerAppsSignal = "start" | "home" | "phone" | "rejected" | "rev" | "turn";
export interface ServerAppsFilesPort {
  plan(userId: string, items: unknown[]): { ok: boolean; planned: number };
  drain(userId: string): Promise<unknown>;
}
export interface ServerAppsPorts {
  now(): number;
  userId(): string | null;
  /** The 2.0 switch (the mirror's own). Off: no request of any kind. */
  switchOn(): boolean;
  /** This computer is the confirmed home now (the mirror's `standing`). `epoch` is the pointer's. */
  standing(): { ok: true; epoch: number } | { ok: false; why: string };
  /** One signed call with `epoch` already in `fields`; `waitMs` is how long the answer may take. Never throws. */
  call(route: ServerAppsRoute, fields: Record<string, unknown>, waitMs: number): Promise<ServerAppsAnswer>;
  refreshPointer(): Promise<void>;
  loadState(userId: string): string | null;
  saveState(userId: string, json: string): void;
  clearState(userId: string): void;
  /** The connectors this computer has itself, installed, on, and with their keys (the computer's wins). Value-free. */
  computerHas(): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Where the files of a result go (VD's mirror-files entry). Absent: files are not taken. */
  files?(): ServerAppsFilesPort | null;
  /** A finished long job: ONE notice (the fact and the tool's name, never the result) in the conversation it was started in; a display line the model does not read. Stable id per job. */
  attach?(task: PendingTask): void;
  random?(n: number): string;
}

export interface ToolOutcome {
  ok: boolean;
  /** MCP content as the server answered it (already scrubbed by the server). */
  content?: unknown[];
  structuredContent?: unknown;
  isError: boolean;
  truncated?: boolean;
  /** A closed word (the contract's, or this computer's own) when the call did not give a result. */
  word?: string;
  retryAfterSeconds?: number;
  /** The server took the call and it is running: ask `status` with this id. */
  pending?: { callId: string };
}

export interface ListReport { ran: boolean; skipped?: string; code?: string; changed?: boolean; requests: number }

export function createServerApps(ports: ServerAppsPorts) {
  let cachedUser: string | null = null;
  let cached: ServerAppsState | null = null;
  let flight: Promise<ListReport> | null = null;
  let again = false;
  let unsupported = false;       // an older server (404): not asked again in this run of the app, except by `start`
  let held: string | null = null; // the home refused this computer: no server apps until the next list answers
  const random = ports.random ?? ((n) => randomBytes(n).toString("base64url"));

  function state(userId: string): ServerAppsState {
    if (cachedUser !== userId || !cached) { cached = parseState(ports.loadState(userId)); cachedUser = userId; }
    return cached;
  }
  function save(userId: string, s: ServerAppsState): void {
    const json = JSON.stringify(s);
    cached = s; cachedUser = userId;
    if (Buffer.byteLength(json) > SERVER_APPS_LIMITS.stateBytes) return; // the answer cap is the same number: an over-size list is never stored
    ports.saveState(userId, json);
  }
  const live = (): { userId: string; epoch: number } | null => {
    const userId = ports.userId();
    if (!userId || !ports.switchOn()) return null;
    const standing = ports.standing();
    return standing.ok ? { userId, epoch: standing.epoch } : null;
  };

  /** What a turn may use now: the stored list when the home is standing and nothing refused it, else nothing. Reads memory/meta only. */
  function snapshot(): ServerAppsState | null {
    const here = live();
    if (!here || held) return null;
    const s = state(here.userId);
    return s.apps.length ? s : null;
  }

  async function listOnce(why: ServerAppsSignal): Promise<ListReport> {
    const report: ListReport = { ran: false, requests: 0 };
    const here = live();
    if (!here) { report.skipped = !ports.userId() ? "signed_out" : !ports.switchOn() ? "switch_off" : "not_home"; return report; }
    if (why === "start") unsupported = false;
    if (unsupported) { report.skipped = "unsupported"; return report; }
    let s = state(here.userId);
    if (s.epoch !== null && s.epoch !== here.epoch) s = { ...emptyServerApps(), pending: s.pending }; // a new epoch is read whole
    let epoch = here.epoch;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const asked: Record<string, unknown> = { epoch };
      if (s.rev && s.complete) asked.rev = s.rev;
      report.ran = true; report.requests += 1;
      const out = await ports.call("tools/list", asked, SERVER_APPS_LIMITS.listWaitMs);
      if (out.ok && out.body) {
        held = null;
        const body = out.body;
        if (body.same === true) return report;
        const rev = typeof body.rev === "string" && REV_RE.test(body.rev) ? body.rev : null;
        const incoming = (Array.isArray(body.apps) ? body.apps : []).map(parseApp).filter((a): a is ServerApp => !!a);
        const complete = body.complete !== false;
        const unavailable = new Set((Array.isArray(body.unavailable) ? body.unavailable : []).filter(isRecord).map((u) => String(u.connectorId)));
        // An app the server could not read this time keeps its old tools (a moment's trouble is not "gone"); the next signal asks again whole.
        const kept = s.apps.filter((a) => unavailable.has(a.connectorId) && !incoming.some((i) => i.connectorId === a.connectorId));
        const apps = [...incoming, ...kept];
        const next: ServerAppsState = { v: 1, rev: complete ? rev : null, epoch, complete, apps, pending: s.pending };
        const changed = JSON.stringify({ ...next, pending: [] }) !== JSON.stringify({ ...s, pending: [] });
        if (changed) save(here.userId, next);
        report.changed = changed;
        return report;
      }
      report.code = out.code ?? (out.unreachable ? "server_unreachable" : "failed");
      if (out.code === "stale_epoch" && attempt === 0) {
        await ports.refreshPointer();
        const again2 = live();
        if (!again2) { report.skipped = "not_home"; return report; }
        epoch = again2.epoch; s = { ...emptyServerApps(), pending: s.pending };
        continue;
      }
      if (out.status === 404 && !(out.body && typeof out.body.error === "string")) unsupported = true;          // an older server: nothing here, not asked again in this run (a `start` asks once)
      else if (out.code && HOME_HOLD_WORDS.has(out.code)) held = out.code;
      return report;
    }
    return report;
  }

  /** One list request at a time; a signal that comes while one runs is served by one more afterwards, not one per signal. */
  function list(why: ServerAppsSignal): Promise<ListReport> {
    if (flight) { again = true; return flight; }
    const run = (async () => {
      let report = await listOnce(why);
      while (again) {
        again = false;
        if (!report.ran || report.code) break;
        report = await listOnce(why);
      }
      return report;
    })().finally(() => { flight = null; });
    flight = run;
    return run;
  }

  /** The signals. Never waited for by a turn. The mirror's `turn` signal only reads the long jobs. */
  function signal(kind: ServerAppsSignal): void {
    try {
      if (kind === "turn") { void sweepTasks().catch(() => undefined); return; }
      void list(kind).catch(() => undefined);
      if (kind === "start") void sweepTasks().catch(() => undefined);
    } catch { /* a signal never changes its sender */ }
  }
  /** The mirror's upload answer carries `appsRev`: a different one is a signal (no request of its own: the upload happened anyway). */
  function seenRev(rev: unknown): void {
    try {
      if (typeof rev !== "string" || !REV_RE.test(rev)) return;
      const userId = ports.userId(); if (!userId) return;
      const s = state(userId);
      if (s.rev !== rev || !s.complete) signal("rev");
    } catch { /* ignore */ }
  }

  // ───────────────────────── a call ─────────────────────────
  const fail = (word: string, extra?: Partial<ToolOutcome>): ToolOutcome => ({ ok: false, isError: true, word, ...extra });

  async function call(input: { connectorId: string; tool: string; args: Record<string, unknown>; allowWrite: boolean; chatId: string }): Promise<ToolOutcome> {
    const here = live();
    if (!here || held) return fail("tools_unavailable");
    let argBytes = 0;
    try { argBytes = Buffer.byteLength(JSON.stringify(input.args ?? {})); } catch { return fail("bad_request"); }
    if (argBytes > SERVER_APPS_LIMITS.argumentBytes) return fail("arguments_too_large");
    // Once per logical call and the same for every signed attempt of it: a retry can never run the tool twice (the server's receipt is the ground).
    const callId = `dc-${random(18)}`;
    let epoch = here.epoch;
    let out: ServerAppsAnswer | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      out = await ports.call("tools/call", { epoch, callId, connectorId: input.connectorId, tool: input.tool, arguments: input.args ?? {}, ...(input.allowWrite ? { allowWrite: true } : {}) }, SERVER_APPS_LIMITS.callWaitMs);
      if (out.code === "stale_epoch" && attempt === 0) {
        await ports.refreshPointer();
        const again2 = live();
        if (!again2) return fail("tools_unavailable");
        epoch = again2.epoch;
        continue; // nothing ran: the server refuses an old epoch before it does anything
      }
      break;
    }
    const res = out!;
    const body = res.body ?? null;
    if (res.ok && res.status === 200 && body) {
      const files = Array.isArray(body.files) ? body.files.slice(0, 4) : [];
      if (files.length) takeFiles(here.userId, callId, files);
      return { ok: true, isError: body.isError === true,
        content: Array.isArray(body.content) ? body.content : [],
        ...(body.structuredContent !== undefined ? { structuredContent: body.structuredContent } : {}),
        ...(body.truncated === true ? { truncated: true } : {}) };
    }
    const word = body && typeof body.error === "string" ? body.error : res.code;
    if (res.status === 202 && (word === "task_pending" || (body && body.ok === true))) {
      addPending(here.userId, { callId, chatId: input.chatId, tool: input.tool, at: ports.now() });
      return { ok: true, isError: false, pending: { callId } };
    }
    if (res.unreachable || (!res.status && !word)) {
      // The request may have left. A change is never sent again by this file; the person is told to check.
      return fail(input.allowWrite ? "outcome_unknown" : "server_unreachable");
    }
    const closed = typeof word === "string" && SERVER_APP_WORDS.has(word) ? word : "tools_unavailable";
    if (GONE_WORDS.has(closed)) signal("rejected");
    if (HOME_HOLD_WORDS.has(closed)) held = closed;
    const retry = Number(body?.retryAfterSeconds);
    return fail(closed, Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.min(3600, Math.floor(retry)) } : undefined);
  }

  function takeFiles(userId: string, callId: string, files: unknown[]): void {
    try {
      const port = ports.files?.();
      if (!port) return;
      const planned = port.plan(userId, [{ id: callId, turnId: `sa-${callId}`.slice(0, 64), createdAt: new Date(ports.now()).toISOString(), files }]);
      if (planned.ok) void port.drain(userId).catch(() => undefined);
    } catch { /* a file that cannot be planned now is not asked again: the result text still stands */ }
  }

  // ───────────────────────── long jobs ─────────────────────────
  function addPending(userId: string, task: PendingTask): void {
    const s = state(userId);
    const kept = [...s.pending.filter((p) => p.callId !== task.callId), task].slice(-SERVER_APPS_LIMITS.pendingMax);
    save(userId, { ...s, pending: kept });
  }
  function dropPending(userId: string, callId: string): void {
    const s = state(userId);
    if (s.pending.some((p) => p.callId === callId)) save(userId, { ...s, pending: s.pending.filter((p) => p.callId !== callId) });
  }
  /** The state of one job (or of every waiting one): one `tasks` read each. A finished job leaves the list and is attached to its conversation. */
  async function status(callId?: string, sweep = false): Promise<Array<{ callId: string; state: string; word?: string; result?: unknown }>> {
    const here = live();
    const answers: Array<{ callId: string; state: string; word?: string; result?: unknown }> = [];
    if (!here || held) return answers;
    const now = ports.now();
    let s = state(here.userId);
    const expired = s.pending.filter((p) => now - p.at > SERVER_APPS_LIMITS.pendingMs);
    for (const p of expired) dropPending(here.userId, p.callId);
    s = state(here.userId);
    // A sweep (a signal) looks only at jobs nobody was told about yet; the model's own question reads every job, so a finished one is read once, by the model, and then leaves.
    for (const task of s.pending.filter((p) => (!callId || p.callId === callId) && !(sweep && p.done))) {
      let epoch = here.epoch;
      let out: ServerAppsAnswer | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        out = await ports.call("tools/tasks", { epoch, callId: task.callId }, SERVER_APPS_LIMITS.listWaitMs);
        if (out.code === "stale_epoch" && attempt === 0) { await ports.refreshPointer(); const a = live(); if (!a) break; epoch = a.epoch; continue; }
        break;
      }
      const body = out?.body ?? null;
      const stateWord = body && typeof body.state === "string" ? body.state : "";
      if (out?.ok && stateWord === "completed") {
        if (sweep) {
          // The signal tells the owner it finished (the fact and the tool, never the app's words) and keeps the job for the model's question; the result is not stored here (the server holds it 24 h).
          const kept = state(here.userId);
          if (kept.pending.some((p) => p.callId === task.callId)) save(here.userId, { ...kept, pending: kept.pending.map((p) => (p.callId === task.callId ? { ...p, done: true as const } : p)) });
          try { ports.attach?.(task); } catch { /* the notice is a courtesy */ }
          continue;
        }
        dropPending(here.userId, task.callId);
        answers.push({ callId: task.callId, state: "completed", result: body?.result });
      } else if (out?.status === 404 || out?.code === "task_not_found" || out?.code === "task_recovery_unavailable") {
        dropPending(here.userId, task.callId);
        answers.push({ callId: task.callId, state: "ended", word: out?.code ?? "task_not_found" });
      } else if (stateWord) {
        answers.push({ callId: task.callId, state: stateWord, ...(body?.inputRequests !== undefined ? { result: body.inputRequests } : {}) });
      } else if (out?.unreachable) answers.push({ callId: task.callId, state: "unknown", word: "server_unreachable" });
      else answers.push({ callId: task.callId, state: "unknown", word: typeof out?.code === "string" && SERVER_APP_WORDS.has(out.code) ? out.code : "tools_unavailable" });
    }
    return answers;
  }
  async function sweepTasks(): Promise<void> {
    const here = live();
    if (!here || held) return;
    if (!state(here.userId).pending.some((p) => !p.done)) return; // nothing waits that nobody was told about: no request
    await status(undefined, true);
  }

  return {
    signal, seenRev, snapshot, call, status, list,
    /** The connectors this computer has itself (the computer's wins). */
    computerHas: async (): Promise<ReadonlySet<string>> => { try { return await ports.computerHas(); } catch { return new Set<string>(); } },
    /** An account slot is forgotten, or another account signs in: the stored list goes and so do the memories. */
    forget(userId: string): void { try { ports.clearState(userId); } catch { /* none */ } cached = null; cachedUser = null; unsupported = false; held = null; },
    reset(): void { cached = null; cachedUser = null; unsupported = false; held = null; },
    pendingCount(): number { const u = ports.userId(); return u ? state(u).pending.length : 0; },
    /** A gate's view of the memory (never read by product code). */
    _peek: () => ({ unsupported, held, flight: flight !== null }),
  };
}
export type ServerApps = ReturnType<typeof createServerApps>;

/** The first 32 hex of a digest, for a gate to name a list the way the contract names `rev`. */
export const listDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
