/**
 * The two browser seams the AGI executor calls (plan §3.5 run_login_recovery / D6 restart_agentlas_browser), wired to
 * the real product paths without editing them:
 *
 *  - Login: the login-recovery ladder (cb2f7672, electron/browser/login-recovery-runtime.ts). First the shared
 *    ladder itself is pointed at the live pages (observeBrowserToolForLoginWall, the same entry a browser tool
 *    result uses: wall detection → targeted re-import → store feed → one owner card, auto-resume). Its steps are
 *    read back from run_events (kind browser_login_recovery) under a trace run id. If no live page is on a wall
 *    (e.g. the goal ran on the native partition, whose pages this entry cannot see), rung 1 runs directly through
 *    the ladder's own production deps: a consent-scoped targeted re-import of the domain + its identity provider
 *    into both cookie stores, then a value-free session-cookie check. The owner card stays the ladder's alone.
 *  - Agentlas Browser restart (D6: allowed without asking; the app itself is only ever asked): close the dedicated
 *    browser only when no other run holds a lease, then ensure the host is up and its CDP port answers.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import type { AgiLoginRecoveryOutcome } from "./actions";

const LADDER_WAIT_MS = 20_000;

function ladderSteps(traceRunId: string): string[] {
  try {
    return (getDb().prepare("SELECT json_extract(payload_json, '$.step') AS step FROM run_events WHERE run_id = ? AND kind = 'browser_login_recovery' ORDER BY seq")
      .all(traceRunId) as Array<{ step: string | null }>).map((row) => row.step ?? "");
  } catch { return []; }
}

export async function agiRunLoginRecovery(input: { domain: string; goalId: string; runId: string; chatId: string | null }): Promise<AgiLoginRecoveryOutcome> {
  const runtime = await import("../browser/login-recovery-runtime");
  const wall = await import("../browser/login-wall");
  const traceRunId = `agi-login:${randomUUID()}`;
  // 1. The shared ladder on the live pages (card dedup and auto-resume stay inside it).
  runtime.observeBrowserToolForLoginWall({ toolName: "agentlas-browser.browser_navigate", runId: traceRunId, ...(input.chatId ? { chatId: input.chatId } : {}) });
  const deadline = Date.now() + LADDER_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const steps = ladderSteps(traceRunId);
    if (steps.includes("recovered") || steps.includes("session-restored")) return "recovered";
    if (steps.includes("owner-card")) return "awaiting-owner";
    if (steps.length && !steps.every((step) => step === "detected")) continue;
  }
  if (ladderSteps(traceRunId).length) return "in-flight";
  // 2. No live page on a wall: rung 1 directly, through the ladder's production deps (values never leave Main).
  const deps = runtime.productionLoginRecoveryDeps();
  const probe = wall.detectLoginWall({ url: wall.signInUrlFor(input.domain) });
  const domains = probe.kind === "login-wall" ? probe.targetDomains : [input.domain];
  let imported = false;
  let consented = true;
  for (const surface of ["cdp-profile", "native-partition"] as const) {
    try {
      const report = await deps.targetedImport({ domains, surface });
      if (report.state === "imported") imported = true;
      if (report.state === "not-consented") consented = false;
    } catch { /* one store failing does not stop the other */ }
  }
  if (!consented && !imported) return "unavailable";
  for (const surface of ["cdp-profile", "native-partition"] as const) {
    const cookies = await deps.readStore(surface, domains).catch(() => null);
    if (wall.evaluateSessionCookies(cookies, domains, Date.now() / 1_000) === "present") return "recovered";
  }
  // Chrome itself holds no session for the site: the ladder's owner card is the only human step, opened when a
  // run next lands on the wall (observeBrowserToolForLoginWall), never by AGI directly.
  return "not-a-wall";
}

export async function agiRestartAgentlasBrowser(): Promise<boolean> {
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const closed = await launcher.closeBrowserCdpIfIdle(0).catch(() => ({ closed: false, reason: "close-failed" as const, pid: null }));
  // Another run holds a lease: do not pull the browser out from under it; only make sure a host answers.
  if (!closed.closed && closed.reason === "active-leases" && await launcher.browserCdpPortReady()) return true;
  try { await launcher.ensureBrowserCdpHost(); } catch { return false; }
  return launcher.browserCdpPortReady();
}
