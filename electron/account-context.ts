import { getSessionCookieHeader, webBaseUrl } from "./auth";

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
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("workforce_account_sign_in_required");
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
  if (!response.ok) throw new Error(`workforce_account_context_http_${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.error) throw new Error("workforce_account_context_rejected");
  return requireAccountContext(payload.result);
}
