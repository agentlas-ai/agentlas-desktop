import { waitForConnectPoll } from "@/components/connect/ServiceConnect";

export interface McpOAuthAPI {
  oauthStart: (id: string) => Promise<{ ok: true; attemptId: string; manualUrl?: string | null } | { ok: false; error: string }>;
  oauthPoll: (id: string, attemptId: string) => Promise<{ status: "waiting" | "exchanging" | "connected" | "failed" | "cancelled" | "unknown"; error?: string }>;
  oauthCancel: (id: string, attemptId: string) => Promise<{ ok: boolean }>;
}

/** Fail closed on an older preload; legacy connect cannot expose a waiting attempt. */
export function mcpOAuthAPI(value: unknown): McpOAuthAPI {
  const api = value as Partial<McpOAuthAPI> | null;
  if (!api || typeof api.oauthStart !== "function" || typeof api.oauthPoll !== "function" || typeof api.oauthCancel !== "function") throw new Error("OAuth attempt controls are unavailable. (oauth_attempt_bridge_unavailable)");
  return api as McpOAuthAPI;
}

type InvocationSettlement = { signal: AbortSignal; settled: Promise<void> };
const invocations = new Map<string, Set<InvocationSettlement>>();

/** Own exactly one Main attempt, including cancellation while start is in flight. */
export async function runMcpOAuthAttempt(input: {
  api: McpOAuthAPI;
  serverId: string;
  signal: AbortSignal;
  update: (value: { status: "waiting" | "exchanging"; manualUrl: string | null }) => void;
}): Promise<void> {
  const { api, serverId, signal, update } = input;
  // Immediate Retry may arrive before an aborted start or rollback has settled.
  // Only cancelled predecessors for this server participate in the barrier.
  const cancelled = [...(invocations.get(serverId) || [])].filter((previous) => previous.signal.aborted);
  if (cancelled.length) await Promise.all(cancelled.map((previous) => previous.settled));
  if (signal.aborted) throw new Error("cancelled");
  let settle!: () => void;
  const invocation: InvocationSettlement = { signal, settled: new Promise<void>((resolve) => { settle = resolve; }) };
  const pending = invocations.get(serverId) || new Set<InvocationSettlement>();
  pending.add(invocation); invocations.set(serverId, pending);
  let attemptId: string | null = null;
  let completed = false;
  let cancellation: Promise<unknown> | null = null;
  const cancel = () => {
    if (!attemptId || completed) return;
    cancellation ??= api.oauthCancel(serverId, attemptId).catch(() => ({ ok: false }));
  };
  const active = () => { if (signal.aborted) throw new Error("cancelled"); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    active();
    const started = await api.oauthStart(serverId);
    if (!started.ok) throw new Error(`${started.error} (oauth_start_failed)`);
    attemptId = started.attemptId;
    if (signal.aborted) { cancel(); active(); }
    const manualUrl = started.manualUrl || null;
    update({ status: "waiting", manualUrl });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      active();
      const current = await api.oauthPoll(serverId, attemptId);
      active();
      if (current.status === "connected") { completed = true; return; }
      if (current.status === "failed") throw new Error(`${current.error || "OAuth authorization failed"} (oauth_failed)`);
      if (current.status === "cancelled") throw new Error("cancelled");
      if (current.status === "unknown") throw new Error(`${current.error || "OAuth attempt could not be found"} (oauth_attempt_unknown)`);
      update({ status: current.status, manualUrl });
      await waitForConnectPoll(signal);
    }
    throw new Error("Sign-in was not verified in time. (login_timeout)");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
    try { if (cancellation) await cancellation; }
    finally {
      pending.delete(invocation);
      if (!pending.size) invocations.delete(serverId);
      settle();
    }
  }
}
