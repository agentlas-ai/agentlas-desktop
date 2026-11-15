import { createHash, timingSafeEqual } from "node:crypto";
import { getAuthenticatedSessionBinding, getSessionCookieHeader, webBaseUrl } from "../auth";
import { getServer } from "../mcp-tools/registry";
import { mcpServerConfigurationDigest, preparedMcpTargetTransport, type PreparedMcpBinding, type PreparedMcpTransport } from "../mcp-tools/prepared-transport";
import { getCredentialStateRevision, getEnvConfigurationRevision } from "../secrets/vault";
import { currentRemoteCurationRuntime, scheduleRemoteCuration } from "../runtime/remote-curation-binding";

const REQUEST_SCHEMA = "agentlas.automatic-memory-request.v1";
const COMPLETE_TOOL = "agentlas.complete_memory_curation";
type Request = { schemaVersion: typeof REQUEST_SCHEMA; jobId: string; leaseToken: string; inputDigest: string;
  system: string; input: string; tools: never[]; requireNoTools: true; completeTool: typeof COMPLETE_TOOL;
  maxOutputTokens: number; timeoutMs: number; owner: { workspaceId: string; userId: string }; bindingId: string; sourceRef: string;
  visibilityDomain: string | null; originTaskId: string | null; requestedRuntime: unknown };
type CompleteArgs = { jobId: string; leaseToken: string; inputDigest: string; model: string; output: string };
type RemoteTransport = Exclude<PreparedMcpTransport, { kind: "stdio" }>;
/** One process-memory row per job, content-free. `done` = a commit was attempted (never sent twice); `retry` = failed before the commit attempt and waiting; `ended` = the job's own
 * failures reached the cap, so the row is kept (no more model calls for this job in this process until the 24 h row life ends). */
type JobRow = { at: number; n: number; m: number; until: number; epoch: number | null; state: "running" | "retry" | "done" | "ended" };
const seen = new Map<string, JobRow>();
let pending = 0;
/** Counts every judgment that came back usable. A job that failed because the model call failed waits until the next answer of any job (the model is back) or its wait. */
let answerEpoch = 0, lastAnswerAt = 0;
const ROW_LIFE_MS = 24 * 60 * 60_000, JOB_FAULT_CAP = 3, WAIT_MS = 10 * 60_000, ENDED_WAIT_MS = 5 * 60_000;
const jobFaultWait = (n: number) => WAIT_MS * 2 ** (n - 1);
/** What a failure before the commit attempt says about whose fault it is: the job's (the model answered and the answer cannot be used), the model's (the call itself failed), or neither. */
function classifyFailure(error: unknown, deadlineHit: boolean): "job" | "model" | "ended" | "not_ready" {
  const code = error instanceof Error ? error.message : "";
  if (code === "remote_memory_model_result_unavailable") return "job";
  const aborted = code === "remote_memory_cancelled" || error instanceof Error && error.name === "AbortError";
  if (code === "remote_memory_runtime_ended" || aborted && !deadlineHit) return "ended";
  if (code === "remote_memory_runtime_unavailable") return "not_ready";
  return "model";
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Constant-time compare of a credential-bearing header with the expected value, as computer-use/control-server.ts
 * bearerMatches does: length check first, an empty expected value never matches. */
function credentialMatches(actual: string | null, expected: string): boolean {
  if (actual === null || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && !value.includes("\0");
}
function request(value: unknown): Request | null {
  const row = record(value), owner = record(row?.owner);
  if (!row || row.schemaVersion !== REQUEST_SCHEMA || row.requireNoTools !== true || row.completeTool !== COMPLETE_TOOL
    || !Array.isArray(row.tools) || row.tools.length !== 0 || !text(row.jobId, 512) || !text(row.leaseToken, 512)
    || !text(row.inputDigest, 128) || !/^[a-f0-9]{64}$/.test(row.inputDigest) || !text(row.system, 16 * 1024) || !text(row.input, 128 * 1024)
    || row.inputDigest !== hash(row.input)
    || !text(owner?.workspaceId, 512) || !text(owner?.userId, 512) || !text(row.bindingId, 512) || !text(row.sourceRef, 1_024)
    || !(row.visibilityDomain === null || text(row.visibilityDomain, 512)) || !(row.originTaskId === null || text(row.originTaskId, 512))
    || !Number.isInteger(row.maxOutputTokens) || Number(row.maxOutputTokens) < 1 || Number(row.maxOutputTokens) > 1_600
    || !Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 250 || Number(row.timeoutMs) > 300_000) return null;
  // Copy only this version's fields. requestedRuntime is advisory and never
  // selects a provider, account, tools, permission or model for this host.
  return { schemaVersion: REQUEST_SCHEMA, jobId: row.jobId, leaseToken: row.leaseToken, inputDigest: row.inputDigest,
    system: row.system, input: row.input, tools: [], requireNoTools: true, completeTool: COMPLETE_TOOL,
    maxOutputTokens: Number(row.maxOutputTokens), timeoutMs: Number(row.timeoutMs),
    owner: { workspaceId: owner!.workspaceId as string, userId: owner!.userId as string }, bindingId: row.bindingId,
    sourceRef: row.sourceRef, visibilityDomain: row.visibilityDomain as string | null,
    originTaskId: row.originTaskId as string | null, requestedRuntime: null };
}
function extract(result: unknown): Request | null {
  const raw = record(result);
  if (!raw || raw.isError === true) return null;
  const packets: Request[] = [];
  const take = (value: unknown) => {
    const envelope = record(value);
    if (!envelope) return;
    const candidate = request(envelope.curation ?? envelope.request ?? envelope);
    if (candidate) packets.push(candidate);
  };
  take(raw.structuredContent);
  if (Array.isArray(raw.content)) for (const content of raw.content.slice(0, 8)) {
    const block = record(content);
    if (block?.type !== "text" || typeof block.text !== "string" || Buffer.byteLength(block.text, "utf8") > 512 * 1024) continue;
    try { take(JSON.parse(block.text)); } catch { /* Only a whole JSON protocol packet is accepted. */ }
  }
  if (!packets.length || packets.some(packet => hash(packet) !== hash(packets[0]))) return null;
  return packets[0];
}

function settleFailure(key: string, row: JobRow, failure: unknown, deadlineHit: boolean): void {
  const now = Date.now(), kind = classifyFailure(failure, deadlineHit);
  row.at = now; row.epoch = null;
  if (kind === "not_ready") { // nothing was asked of the model: no wait, no count; a row with no history is dropped
    if (row.n === 0 && row.m === 0) seen.delete(key); else { row.state = "retry"; row.until = 0; }
    return;
  }
  if (kind === "ended") { row.state = "retry"; row.until = now + ENDED_WAIT_MS; return; }
  // A call that failed is the job's only when the model answered another job in the last 24 h (as the terminal engine's ledger does); otherwise it is the model's and counts nothing against the job.
  if (kind === "job" || kind === "model" && now - lastAnswerAt < ROW_LIFE_MS && lastAnswerAt > 0) {
    row.n++;
    if (row.n >= JOB_FAULT_CAP) { row.state = "ended"; return; }
    row.state = "retry"; row.until = now + jobFaultWait(row.n); return;
  }
  row.m++; row.state = "retry"; row.until = now + Math.min(ROW_LIFE_MS, WAIT_MS * 2 ** (row.m - 1)); row.epoch = answerEpoch;
}

/** The auxiliary source snapshot belongs to the background consumer. Returning
 * it plus a "judge then complete" nextAction to the chat would create a second
 * model/commit lane. Preserve the original operation fields and hide only this
 * protocol's request, including malformed packets that this host cannot run. */
function foregroundProjection(result: unknown, state: "background_pending" | "awaiting_runtime" | "deferred"): unknown {
  const raw = record(result);
  if (!raw) return result;
  const project = (value: unknown): unknown => {
    const envelope = record(value);
    if (!envelope) return value;
    if (envelope.schemaVersion === REQUEST_SCHEMA) return { status: "automatic_curation", state };
    const curation = record(envelope.curation), requested = record(envelope.request);
    if (curation?.schemaVersion !== REQUEST_SCHEMA && requested?.schemaVersion !== REQUEST_SCHEMA) return value;
    const copy = { ...envelope };
    if (curation?.schemaVersion === REQUEST_SCHEMA) delete copy.curation;
    if (requested?.schemaVersion === REQUEST_SCHEMA) delete copy.request;
    delete copy.nextAction;
    delete copy.source;
    copy.automaticMemory = { state };
    return copy;
  };
  const output: Record<string, unknown> = { ...raw, ...(raw.structuredContent ? { structuredContent: project(raw.structuredContent) } : {}) };
  if (Array.isArray(raw.content)) output.content = raw.content.map(item => {
    const block = record(item);
    if (block?.type !== "text" || typeof block.text !== "string" || Buffer.byteLength(block.text, "utf8") > 512 * 1024) return item;
    try {
      const value = JSON.parse(block.text), projected = project(value);
      return projected === value ? item : { ...block, text: JSON.stringify(projected) };
    } catch { return item; }
  });
  return output;
}

/** Native-only capture from a live prepared target before inference. Identity is
 * the existing local session, never packet prose, a decoded OAuth token or a nonce.
 * The resulting background capability survives ordinary foreground cleanup;
 * account, source configuration and credential rotation revoke it independently. */
export function captureRemoteCurationConsumer(binding: PreparedMcpBinding | undefined,
  complete: (target: RemoteTransport, args: CompleteArgs, signal: AbortSignal) => Promise<unknown>,
): ((rawResult: unknown) => unknown) | null {
  if (!binding) return null;
  try {
    const runtime = currentRemoteCurationRuntime(binding);
    const target = preparedMcpTargetTransport(binding, binding.server);
    if (target.kind === "stdio") return null;
    const configured = new URL(`${webBaseUrl()}/api/mcp/v1`), url = new URL(target.url);
    if (url.href !== configured.href || url.username || url.password || url.hash || url.search
      || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    const actor = getAuthenticatedSessionBinding(), cookie = getSessionCookieHeader();
    if (!actor || !cookie) return null;
    const headers = new Headers(target.headers), authorization = headers.get("authorization");
    // A different bearer overrides cookies at the Web server. Its actor is
    // unknown locally, even if the response happens to name our signed-in user.
    if (!(authorization ? credentialMatches(authorization, `Bearer ${cookie.slice("agentlas_session=".length)}`)
      : credentialMatches(headers.get("cookie"), cookie))) return null;
    const account = hash(actor), configuration = mcpServerConfigurationDigest(binding.server);
    const credentialRevision = getCredentialStateRevision(), envRevision = getEnvConfigurationRevision();
    const captured: RemoteTransport = { ...target, headers: { ...target.headers } };
    const current = () => { try {
      const installed = getServer(binding.server.id);
      return (!runtime || runtime.current()) && hash(getAuthenticatedSessionBinding()) === account && getSessionCookieHeader() === cookie
        && new URL(`${webBaseUrl()}/api/mcp/v1`).href === configured.href && installed?.enabled === true
        && installed.configurationValid !== false && mcpServerConfigurationDigest(installed) === configuration
        && credentialRevision === getCredentialStateRevision() && envRevision === getEnvConfigurationRevision();
    } catch { return false; } };
    if (!current()) return null;
    return rawResult => {
      const packet = extract(rawResult);
      if (!packet || packet.owner.workspaceId !== actor.workspaceId || packet.owner.userId !== actor.userId || !current() || pending >= 8) return foregroundProjection(rawResult, "deferred");
      if (!runtime?.available) return foregroundProjection(rawResult, "awaiting_runtime");
      // Job identity has no authority. This content-free process tombstone only
      // suppresses replay; an ambiguous completion is never retried automatically.
      const key = hash([account, configured.href, binding.server.id, packet.jobId]);
      const now = Date.now();
      for (const [entry, row] of seen) if (row.state !== "running" && now - row.at > ROW_LIFE_MS) seen.delete(entry);
      const previous = seen.get(key);
      if (previous) {
        // Repair (curation retry 1): a failure before the commit attempt is tried again only after its wait; the job's own failures end at three. A model that failed to answer is tried
        // again as soon as any job gets an answer (the model is back) or when the wait is over.
        const waiting = previous.state === "retry" && now < previous.until && !(previous.epoch !== null && previous.epoch !== answerEpoch);
        if (previous.state !== "retry" || waiting) return foregroundProjection(rawResult, "background_pending");
      } else if (seen.size >= 4_096) return foregroundProjection(rawResult, "deferred");
      const row: JobRow = previous ?? { at: now, n: 0, m: 0, until: 0, epoch: null, state: "running" };
      row.state = "running"; row.at = now; seen.set(key, row); pending++;
      // Audit 62 (memory D3): the tombstone exists for one reason - a commit that may or may not have reached the server must never be sent twice. A job that failed BEFORE the commit
      // attempt (the judgment failed or was cancelled, the account or configuration changed) left nothing at the server, so it is not "ambiguous": its tombstone is taken back and the
      // server's next delivery of the job is run again, instead of reading "in progress" for 24 hours.
      // Audit 63 / curation retry 1: that take-back had no end (a job whose judgment fails every time cost one model call per delivery for ever). The row now counts.
      let commitAttempted = false, failure: unknown = null, deadlineHit = false;
      scheduleRemoteCuration(async () => {
        const controller = new AbortController();
        const deadline = setTimeout(() => { deadlineHit = true; controller.abort(); }, packet.timeoutMs);
        const fence = setInterval(() => { try { if (!current()) controller.abort(); } catch { controller.abort(); } }, 50);
        try {
          if (!current()) throw new Error("remote_memory_runtime_unavailable");
          const work = runtime.generate({ system: packet.system, input: packet.input, maxOutputTokens: packet.maxOutputTokens }, controller.signal);
          const abort = new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("remote_memory_cancelled")), { once: true });
          });
          const answer = await Promise.race([work, abort]);
          controller.signal.throwIfAborted();
          answerEpoch++; lastAnswerAt = Date.now();
          if (!current()) throw new Error("remote_memory_runtime_ended");
          // Exactly one server commit attempt; no retries after a lost response.
          commitAttempted = true;
          await complete(captured, { jobId: packet.jobId, leaseToken: packet.leaseToken, inputDigest: packet.inputDigest,
            model: answer.model, output: answer.output }, controller.signal);
        } catch (error) { failure = error; /* Server lease/fence or inference failure leaves the job with Web, without payload logging. */ }
        finally {
          clearTimeout(deadline); clearInterval(fence); pending--;
          if (commitAttempted) row.state = "done";
          else settleFailure(key, row, failure, deadlineHit);
        }
      });
      return foregroundProjection(rawResult, "background_pending");
    };
  } catch { return null; }
}
