// Main-process client for /api/agent-mail/* with the owner's web session.
// Every call re-reads the entitlement on the server; the Desktop never decides
// eligibility or remaining allowance by itself.
import { randomUUID } from "node:crypto";
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "../auth";
import type {
  AgentMailEntitlement,
  AgentMailError,
  AgentMailMailbox,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailResult,
  AgentMailSendInput,
  AgentMailSendReceipt,
  AgentMailStatus,
} from "../../shared/agent-mail";

const TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 45_000;

/** Last server answer, so built-in One tools are offered only to owners who have a mailbox. */
let lastKnown: { entitlement: AgentMailEntitlement | null; mailbox: AgentMailMailbox | null } = { entitlement: null, mailbox: null };

export function agentMailToolsOffered(): boolean {
  return Boolean(lastKnown.entitlement?.available && lastKnown.mailbox?.status === "active");
}

function err(code: string, message: string, status: number | null = null, detail?: Record<string, unknown>): AgentMailError {
  return { ok: false, code, message, status, ...(detail ? { detail } : {}) };
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: true; status: number; json: T } | AgentMailError> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return err("sign_in_required", "Sign in to Agentlas to use agent mail.");
  let res: Response;
  try {
    res = await fetchWithHubSession(
      cookie,
      `${webBaseUrl()}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          // Cookie-authenticated mutations must carry an allowed Origin (web CSRF gate).
          ...(method === "GET" ? {} : { "Content-Type": "application/json", Origin: webBaseUrl() }),
          ...(opts.headers ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      opts.timeoutMs ?? TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return err(aborted ? "timeout" : "network", aborted ? "Agentlas did not answer in time." : "Could not reach Agentlas.");
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (res.status === 401) return err("sign_in_required", "Sign in to Agentlas to use agent mail.", 401);
  if (!res.ok) {
    const { error: message, code, ...detail } = json as { error?: unknown; code?: unknown };
    return err(
      typeof code === "string" ? code : `http_${res.status}`,
      typeof message === "string" ? message : `Agentlas answered ${res.status}.`,
      res.status,
      detail,
    );
  }
  return { ok: true, status: res.status, json: json as T };
}

export async function agentMailStatus(): Promise<AgentMailStatus> {
  if (!getSessionCookieHeader()) {
    lastKnown = { entitlement: null, mailbox: null };
    return { ok: true, signedIn: false, entitlement: null, mailbox: null };
  }
  const res = await call<{ mailbox: AgentMailMailbox | null; agentMail: AgentMailEntitlement }>("GET", "/api/agent-mail/mailboxes");
  if (!res.ok) {
    if (res.code === "agent_mail_not_available") {
      lastKnown = { entitlement: null, mailbox: null };
      return { ok: true, signedIn: true, entitlement: null, mailbox: null };
    }
    if (res.code === "sign_in_required") return { ok: true, signedIn: false, entitlement: null, mailbox: null };
    return res;
  }
  lastKnown = { entitlement: res.json.agentMail ?? null, mailbox: res.json.mailbox ?? null };
  return { ok: true, signedIn: true, entitlement: lastKnown.entitlement, mailbox: lastKnown.mailbox };
}

export async function agentMailIssue(input: { displayName?: string } = {}): Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; entitlement: AgentMailEntitlement | null }>> {
  const res = await call<{ mailbox: AgentMailMailbox; created: boolean; agentMail: AgentMailEntitlement }>(
    "POST",
    "/api/agent-mail/mailboxes",
    { displayName: typeof input.displayName === "string" ? input.displayName.slice(0, 64) : undefined },
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return res;
  lastKnown = { entitlement: res.json.agentMail ?? null, mailbox: res.json.mailbox };
  return { ok: true, mailbox: res.json.mailbox, created: res.json.created === true, entitlement: res.json.agentMail ?? null };
}

export async function agentMailList(input: { cursor?: string | null; limit?: number; direction?: "inbound" | "outbound" } = {}): Promise<AgentMailResult<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", String(input.cursor).slice(0, 512));
  query.set("limit", String(Math.min(Math.max(Number(input.limit) || 25, 1), 100)));
  if (input.direction === "inbound" || input.direction === "outbound") query.set("direction", input.direction);
  const res = await call<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>("GET", `/api/agent-mail/messages?${query.toString()}`);
  if (!res.ok) return res;
  return { ok: true, messages: Array.isArray(res.json.messages) ? res.json.messages : [], nextCursor: res.json.nextCursor ?? null };
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export async function agentMailGet(id: string): Promise<AgentMailResult<{ message: AgentMailMessage }>> {
  if (!validId(id)) return err("invalid_message_id", "Invalid message id.");
  const res = await call<{ message: AgentMailMessage }>("GET", `/api/agent-mail/messages/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  return { ok: true, message: res.json.message };
}

export async function agentMailRemove(id: string): Promise<AgentMailResult<{ deleted: true }>> {
  if (!validId(id)) return err("invalid_message_id", "Invalid message id.");
  const res = await call<{ deleted: true }>("DELETE", `/api/agent-mail/messages/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  return { ok: true, deleted: true };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

/**
 * Send once. The idempotency key is minted here when the caller has none, so a
 * transport retry of the SAME call can never send twice. There is no automatic
 * retry: an uncertain result is returned as-is.
 */
export async function agentMailSend(input: AgentMailSendInput): Promise<AgentMailResult<{ send: AgentMailSendReceipt; replay: boolean; remainingThisMonth: number }>> {
  const idempotencyKey = typeof input?.idempotencyKey === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)
    ? input.idempotencyKey
    : `desk-${randomUUID()}`;
  const res = await call<{ send: AgentMailSendReceipt; replay: boolean; remainingThisMonth: number }>(
    "POST",
    "/api/agent-mail/messages",
    {
      to: stringList(input?.to),
      cc: stringList(input?.cc),
      bcc: stringList(input?.bcc),
      subject: typeof input?.subject === "string" ? input.subject : "",
      text: typeof input?.text === "string" ? input.text : "",
      ...(typeof input?.inReplyTo === "string" ? { inReplyTo: input.inReplyTo } : {}),
    },
    { timeoutMs: SEND_TIMEOUT_MS, headers: { "Idempotency-Key": idempotencyKey } },
  );
  if (!res.ok) {
    // A timeout after the request left is not a refusal: the server may have sent it.
    if (res.code === "timeout" || res.code === "network") {
      return err("send_outcome_unknown", "The send result is unknown. Check Sent before sending again.", null, { idempotencyKey });
    }
    return res;
  }
  return { ok: true, send: res.json.send, replay: res.json.replay === true, remainingThisMonth: res.json.remainingThisMonth };
}
