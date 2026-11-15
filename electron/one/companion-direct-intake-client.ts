import { isIP } from "node:net";
import { isBlockedAddress } from "../net/public-address-guard";
import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { isCompanionPollHolding } from "../../shared/companion-poll-holding";
import { pollVersion } from "./companion-poll-holding";

const DISCOVERY = "/api/mobile-pair/v1/companion/work-delivery-origin";
const CHALLENGE = "/v2/work/direct/challenge";
const POLL = "/v2/work/direct/poll";
const CLAIM = "/api/companion/work/direct-claim";
const START_CHALLENGE = "/v2/work/direct/start-challenge";
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).sort().join(",") === keys.sort().join(",");
const challenge = (x: unknown): x is string => typeof x === "string" && x.length >= 16 && x.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(x);

/** How long a "not now" answer waits when the service names no time (the rate-limit answer's own default, below). Also the pause of a computer the service does not know yet and of a service route that is not there (companion-computer-gate.ts `noteDirectPollRefused`). */
export const INTAKE_DEFAULT_RETRY_MS = 60_000;
export class CompanionIntakeRetryAfter extends Error {
  constructor(readonly retryAfterMs: number) { super("companion_intake_rate_limited"); }
}
function retryDelay(response: Response): number {
  const value = response.headers.get("retry-after")?.trim();
  if (value && /^\d+$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER - Date.now(), Math.max(1_000, Number(value) * 1_000));
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : INTAKE_DEFAULT_RETRY_MS;
}

function approvedOrigin(raw: string, allowLoopback: boolean): URL | null {
  try {
    const u = new URL(raw), h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(h), ip = isIP(h);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
        (u.protocol !== "https:" && !(allowLoopback && loopback && u.protocol === "http:")) ||
        (!(allowLoopback && loopback) && (loopback || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
          (!ip && !h.includes(".")) || (ip !== 0 && isBlockedAddress(h, ip as 4 | 6))))) return null;
    return u;
  } catch { return null; }
}
async function json(response: Response, max: number): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const p = await reader.read(); if (p.done) break; bytes += p.value.byteLength; if (bytes > max) return null; chunks.push(p.value); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); return object(result) ? result : null;
  } catch { return null; } finally { await reader.cancel().catch(() => undefined); }
}

/** No phone bearer is retained. Every claim uses the current Desktop web
 * session, registered-key signatures and the same target after a retry. */
export function createCompanionDirectIntakeClient(options: {
  webOrigin: string; cookie(): string | null; assertCurrent(): void;
  signPoll(value: Record<string, unknown>): string; signClaim(binding: Record<string, unknown>, challenge: string): string;
  signLifecycle?(purpose: "start" | "status", binding: Record<string, unknown>, challenge: string, runId: string): string;
  /** TR-desktop (trust-root.md E1): may this computer fetch work for this paired phone at all (it is the confirmed home AND the pairing may vouch: companion-computer-gate.ts).
   * Required for `receive`: without it no request is made, so a road added later that forgets to ask gets nothing from the server. */
  mayTake?(deviceId: string): boolean;
  /** The service refused the signed poll of this computer for this phone (403): the computer is not registered there (the phone has not enrolled it yet, or the account's epoch / the phone's grant moved on). Told once per poll, never an id or a text; the caller pauses that phone's polling (companion-computer-gate.ts). */
  onPollRefused?(deviceId: string): void;
  /** direct-work-capacity R5 (poll v2): the commands this registration holds, read from the durable store at the moment of each poll (companion-poll-holding.ts `readDirectHolding`).
   * Given and a list = a v2 poll (the list is signed with it); null (the store cannot be read) or not given = a v1 poll, which closes nothing on the service - never an empty list for "unknown". */
  holding?(target: { userId: string; deviceId: string; hostId: string; oneId: string }): string[] | null;
  /** R8: a command this store already received is not claimed again, whoever offers it (an older service, a v1 poll). */
  held?(commandId: string): boolean;
  fetchImpl?: typeof fetch; allowLoopback?: boolean;
}) {
  const allowLoopback = options.allowLoopback === true && process.env.AGENTLAS_E2E === "1";
  const web = approvedOrigin(options.webOrigin, allowLoopback);
  if (!web) throw new Error("companion_intake_origin_invalid");
  const fetcher = options.fetchImpl ?? fetch;
  let cached: { origin: URL; until: number } | null = null;
  let lastStatus = 0;   // the HTTP status of the answer `post` read last (read by `receive` right after its poll, nothing else)
  async function discover(): Promise<URL | null> {
    options.assertCurrent();
    if (cached && cached.until > Date.now()) return cached.origin;
    const response = await fetcher(new URL(DISCOVERY, web!), { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    options.assertCurrent();
    if (response.status === 429) { const delay = retryDelay(response); await response.body?.cancel().catch(() => undefined); throw new CompanionIntakeRetryAfter(delay); }
    if (!response.ok || new URL(response.url).origin !== web!.origin) { await response.body?.cancel().catch(() => undefined); return null; }
    const body = await json(response, 2048);
    if (!body || !exact(body, ["schema", "origin"]) || body.schema !== "agentlas.companion.work-delivery-origin.v1" || typeof body.origin !== "string") return null;
    const target = approvedOrigin(body.origin, allowLoopback); if (!target) return null;
    cached = { origin: target, until: Date.now() + 60_000 }; return target;
  }
  async function post(origin: URL, path: string, value: unknown, cookie?: string): Promise<Record<string, unknown> | null> {
    options.assertCurrent();
    const body = JSON.stringify(value); if (Buffer.byteLength(body, "utf8") > 96 * 1024) return null;
    const response = await fetcher(new URL(path, origin), { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", ...(cookie ? { cookie, origin: web!.origin } : {}) }, body });
    options.assertCurrent();
    lastStatus = response.status;
    if (response.status === 429) { const delay = retryDelay(response); await response.body?.cancel().catch(() => undefined); throw new CompanionIntakeRetryAfter(delay); }
    if (!response.ok || new URL(response.url).origin !== origin.origin) { await response.body?.cancel().catch(() => undefined); return null; }
    return json(response, 100 * 1024);
  }
  async function receive(target: { userId: string; deviceId: string; hostId: string; oneId: string }, matches: (b: Record<string, unknown>) => boolean) {
    try {
      if (!options.mayTake || options.mayTake(target.deviceId) !== true) return null;   // before any request
      options.assertCurrent();
      const companion = await discover(); if (!companion) return null;
      const first = await post(companion, CHALLENGE, target);
      if (!first || !exact(first, ["ok", "challenge", "expiresAt"]) || first.ok !== true || !challenge(first.challenge) ||
          !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt) <= Math.floor(Date.now() / 1000) || Number(first.expiresAt) > Math.floor(Date.now() / 1000) + 60) return null;
      const proof = { ...target, challenge: first.challenge };
      options.assertCurrent();
      let holding: string[] | null = null;
      if (options.holding && !pollVersion.isV1("direct", web!.origin)) { try { const list = options.holding(target); holding = isCompanionPollHolding(list) ? list : null; } catch { holding = null; } }
      const sendPoll = (list: string[] | null) => { const body = list ? { ...proof, holding: list } : proof; return post(companion, POLL, { ...body, signature: options.signPoll(body) }); };
      let pending = await sendPoll(holding);
      // A service from before web W8b answers a 7-key poll with the same 403 as an unregistered computer. The v1 poll of the SAME challenge and key tells them apart without reading any
      // text: taken -> the service does not read `holding` (it keeps being polled with v1 until the app restarts); refused too -> the refusal is real (reported below as before).
      if (!pending && lastStatus === 403 && holding) {
        options.assertCurrent();
        pending = await sendPoll(null);
        if (pending && pending.ok === true) { pollVersion.noteV1("direct", web!.origin); try { console.warn("[companion-poll] the service refused the v2 poll and took the v1 poll: this service is polled with v1 until the app restarts"); } catch { /* no log sink */ } }
      }
      if (!pending && lastStatus === 403) { try { options.onPollRefused?.(target.deviceId); } catch { /* a note never changes the answer */ } }
      if (!pending || pending.ok !== true) return null;
      if (exact(pending, ["ok", "binding"]) && pending.binding === null) return null;
      if (!exact(pending, ["ok", "binding", "claimChallenge"]) || !object(pending.binding) || !challenge(pending.claimChallenge)) return null;
      companionHandoffProofBytes(pending.binding);
      if (!matches(pending.binding)) return null;
      if (options.held?.(String(pending.binding.commandId)) === true) return null;   // R8: received already - no claim request is made
      const cookie = options.cookie();
      if (!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie)) return null;
      options.assertCurrent();
      const signed = options.signClaim(pending.binding, pending.claimChallenge);
      const claimed = await post(web!, CLAIM, { binding: pending.binding, claimChallenge: pending.claimChallenge, signature: signed }, cookie);
      if (!claimed || !exact(claimed, ["ok", "status", "binding", "payload", "grant"]) || claimed.ok !== true ||
          !["claimed", "existing"].includes(String(claimed.status)) || !object(claimed.binding) ||
          COMPANION_HANDOFF_PROOF_FIELDS.some(field => (claimed.binding as Record<string, unknown>)[field] !== (pending.binding as Record<string, unknown>)[field]) ||
          typeof claimed.payload !== "string" || typeof claimed.grant !== "string") return null;
      options.assertCurrent();
      return { binding: claimed.binding, payload: claimed.payload, grant: claimed.grant };
    } catch (error) { cached = null; if (error instanceof CompanionIntakeRetryAfter) throw error; return null; }
  }
  async function lifecycle(purpose: "start" | "status", binding: Record<string, unknown>, runId: string): Promise<string | null> {
    try {
      if (!options.signLifecycle || typeof runId !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId)) return null;
      companionHandoffProofBytes(binding);
      const target = { userId: binding.userId, deviceId: binding.deviceId, hostId: binding.hostId, oneId: binding.oneId };
      options.assertCurrent();
      const companion = await discover(); if (!companion) return null;
      const first = await post(companion, START_CHALLENGE, target);
      if (!first || !exact(first, ["ok", "challenge", "expiresAt"]) || first.ok !== true || !challenge(first.challenge) ||
          !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt) <= Math.floor(Date.now() / 1000) || Number(first.expiresAt) > Math.floor(Date.now() / 1000) + 60) return null;
      const cookie = options.cookie(); if (!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie)) return null;
      options.assertCurrent();
      const signature = options.signLifecycle(purpose, binding, first.challenge, runId);
      const answer = await post(web!, `/api/companion/work/direct-${purpose}`, { binding, challenge: first.challenge, runId, signature }, cookie);
      if (!answer || !exact(answer, ["ok", "status"]) || answer.ok !== true || typeof answer.status !== "string") return null;
      options.assertCurrent();
      return (purpose === "start" ? ["authorized", "existing", "cancel"] : ["active", "cancel"]).includes(answer.status) ? answer.status : null;
    } catch (error) { cached = null; if (error instanceof CompanionIntakeRetryAfter) throw error; return null; }
  }
  /** This endpoint can only confirm retirement, even when the web session is gone. */
  async function retirement(binding: Record<string, unknown>, runId: string): Promise<boolean> {
    try {
      if (!options.signLifecycle || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId)) return false;
      companionHandoffProofBytes(binding);
      const companion = await discover(); if (!companion) return false;
      const target = { userId: binding.userId, deviceId: binding.deviceId, hostId: binding.hostId, oneId: binding.oneId };
      const first = await post(companion, START_CHALLENGE, target);
      if (!first || !exact(first, ["ok", "challenge", "expiresAt"]) || first.ok !== true || !challenge(first.challenge) ||
          !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt) <= Math.floor(Date.now() / 1000) || Number(first.expiresAt) > Math.floor(Date.now() / 1000) + 60) return false;
      options.assertCurrent();
      const signature = options.signLifecycle("status", binding, first.challenge, runId);
      const result = await post(companion, "/v2/work/direct/status", {binding, challenge: first.challenge, runId, signature});
      options.assertCurrent();
      return !!result && exact(result, ["ok", "status"]) && result.ok === true && result.status === "cancel";
    } catch (error) { cached = null; if (error instanceof CompanionIntakeRetryAfter) throw error; return false; }
  }
  /** Server-signed current Work authority for the GUI→daemon lease. */
  async function leaseAuthority(binding:Record<string,unknown>,runId:string):Promise<{token:string;executeChallenge:string}|null> {
    try {
      if(!options.signLifecycle || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId))return null;
      companionHandoffProofBytes(binding);
      const target={userId:binding.userId,deviceId:binding.deviceId,hostId:binding.hostId,oneId:binding.oneId};
      const companion=await discover();if(!companion)return null;
      const first=await post(companion,START_CHALLENGE,target);
      if(!first || !exact(first,["ok","challenge","expiresAt"]) || first.ok!==true || !challenge(first.challenge) ||
        !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt)<=Math.floor(Date.now()/1000) || Number(first.expiresAt)>Math.floor(Date.now()/1000)+60)return null;
      const cookie=options.cookie();if(!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie))return null;
      options.assertCurrent();const signature=options.signLifecycle("status",binding,first.challenge,runId);
      const answer=await post(web!,"/api/companion/work/direct-lease",{binding,challenge:first.challenge,runId,signature},cookie);
      if(!answer || !exact(answer,["ok","status","attestation","expiresAt"]) || answer.ok!==true || answer.status!=="active" ||
        typeof answer.attestation!=="string" || answer.attestation.length>8192 || !Number.isSafeInteger(answer.expiresAt) ||
        Number(answer.expiresAt)<=Math.floor(Date.now()/1000) || Number(answer.expiresAt)>Math.floor(Date.now()/1000)+15)return null;
      options.assertCurrent();return {token:answer.attestation,executeChallenge:first.challenge};
    } catch(error) {cached=null;if(error instanceof CompanionIntakeRetryAfter)throw error;return null;}
  }
  return Object.freeze({ receive, lifecycle, retirement, leaseAuthority });
}
