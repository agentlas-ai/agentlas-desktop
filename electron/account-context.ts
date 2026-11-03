import { getAuthenticatedSessionBinding, getSessionCookieHeader, webBaseUrl } from "./auth";
import { managedOneAuthentication, managedOneConfigured, managedOneHeaders, wasManagedOneConfigured } from "./managed-one/auth";

/**
 * The signed-in account's opaque subject, from the web's MCP `agentlas.account_context`. Only the subject leaves the web:
 * no raw user or workspace ids. Used for Workforce goal continuity (--account-subject) and for the memory owner binding,
 * which Core verifies against the same tool (independent review wave 2, engine-w2-03 / handoff H2).
 */
export interface AccountContext {
  schemaVersion: "agentlas.account-context.v1";
  accountSubject: string;
  leaseWindowHours: 24;
  billingAuthority: "agentlas-web";
}

function requireAccountContext(value: unknown): AccountContext {
  const row = value && typeof value === "object" ? value as Partial<AccountContext> : {};
  if (
    row.schemaVersion !== "agentlas.account-context.v1"
    || !/^sha256:[a-f0-9]{64}$/.test(String(row.accountSubject || ""))
    || row.leaseWindowHours !== 24
    || row.billingAuthority !== "agentlas-web"
  ) {
    throw new Error("workforce_account_context_invalid");
  }
  return row as AccountContext;
}

export async function fetchAccountContext(): Promise<AccountContext> {
  // A managed host has no Desktop cookie. Its control capability is accepted
  // only by this narrow endpoint, never by the general MCP endpoint. Keep the
  // captured authentication object through response parsing: even A -> B -> A
  // must not publish a response admitted under an earlier host generation.
  if (managedOneConfigured() || wasManagedOneConfigured()) {
    const owner = managedOneAuthentication();
    const headers = managedOneHeaders("control");
    if (!owner || !headers) throw new Error("workforce_account_sign_in_required");
    const assertCurrent = () => {
      if (!managedOneConfigured() || managedOneAuthentication() !== owner) {
        throw new Error("workforce_account_context_owner_changed");
      }
    };
    const response = await fetch(`${webBaseUrl()}/api/managed-one/host/account-context`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    assertCurrent();
    if (!response.ok) throw new Error(`workforce_account_context_http_${response.status}`);
    const payload: unknown = await response.json();
    assertCurrent();
    return requireAccountContext(payload);
  }

  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("workforce_account_sign_in_required");
  const owner = getAuthenticatedSessionBinding();
  const assertCurrent = () => {
    const active = getAuthenticatedSessionBinding();
    if (wasManagedOneConfigured() || getSessionCookieHeader() !== cookie ||
        (owner ? !active || active.sessionId !== owner.sessionId || active.userId !== owner.userId || active.workspaceId !== owner.workspaceId : active !== null)) {
      throw new Error("workforce_account_context_owner_changed");
    }
  };
  const response = await fetch(`${webBaseUrl()}/api/mcp/v1/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      method: "agentlas.account_context",
      params: {
        name: "agentlas.account_context",
        arguments: {},
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assertCurrent();
  if (!response.ok) throw new Error(`workforce_account_context_http_${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  assertCurrent();
  if (payload.error) throw new Error("workforce_account_context_rejected");
  return requireAccountContext(payload.result);
}
