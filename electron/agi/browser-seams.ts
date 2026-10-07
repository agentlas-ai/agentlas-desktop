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
import type { AgiLoginRecoveryOutcome, AgiLoginRecoveryControl, AgiLoginRecoveryResult, AgiBrowserRestartControl, AgiBrowserRestartOutcome } from "./actions";

const LADDER_WAIT_MS = 20_000;

function ladderSteps(traceRunId: string): string[] {
  try {
    return (getDb().prepare("SELECT json_extract(payload_json, '$.step') AS step FROM run_events WHERE run_id = ? AND kind = 'browser_login_recovery' ORDER BY seq")
      .all(traceRunId) as Array<{ step: string | null }>).map((row) => row.step ?? "");
  } catch { return []; }
}

export async function agiRunLoginRecovery(input: { domain: string; goalId: string; runId: string; chatId: string | null }, control?: AgiLoginRecoveryControl): Promise<AgiLoginRecoveryOutcome | AgiLoginRecoveryResult> {
  let directEffect: AgiLoginRecoveryResult["directEffect"] = "not-started";
  let acknowledgedWritten = 0;
  let observer: Promise<unknown> | undefined;
  let acceptedObserver = (): AgiLoginRecoveryOutcome | null => null;
  const current = () => {
    if (!control) return;
    if (control.signal.aborted) throw control.signal.reason ?? new Error("agi.decision.control-changed");
    control.assertCurrent();
  };
  const finish = (state: AgiLoginRecoveryResult["state"]): AgiLoginRecoveryOutcome | AgiLoginRecoveryResult => control
    ? { state, directEffect, acknowledgedWritten, observerEffect: observer ? "unknown" : "not-started" }
    : state as AgiLoginRecoveryOutcome;
  try {
    current();
    const runtime = await import("../browser/login-recovery-runtime");
    current();
    const wall = await import("../browser/login-wall");
    current();
    const traceRunId = `agi-login:${randomUUID()}`;
    acceptedObserver = () => {
      const steps = ladderSteps(traceRunId);
      return steps.includes("recovered") || steps.includes("session-restored") ? "recovered"
        : steps.includes("owner-card") ? "awaiting-owner" : null;
    };
    // Own the admitted observer Promise, not its pending-card watcher. The latter
    // keeps its existing scope/consent lifetime, independently of this decision.
    observer = runtime.observeBrowserToolForLoginWall({ toolName: "agentlas-browser.browser_navigate", runId: traceRunId, ...(input.chatId ? { chatId: input.chatId } : {}) });
    const deadline = Date.now() + LADDER_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const accepted = acceptedObserver();
      if (accepted) return finish(accepted);
      current();
      const steps = ladderSteps(traceRunId);
      if (steps.length && !steps.every((step) => step === "detected")) continue;
    }
    // A slow observer must not race a second direct writer after the poll window.
    if (control) await observer;
    const accepted = acceptedObserver();
    if (accepted) return finish(accepted);
    current();
    const steps = ladderSteps(traceRunId);
    if (steps.length) return finish("in-flight");
    const deps = runtime.productionLoginRecoveryDeps();
    const probe = wall.detectLoginWall({ url: wall.signInUrlFor(input.domain) });
    const domains = probe.kind === "login-wall" ? probe.targetDomains : [input.domain];
    let imported = false;
    let consented = true;
    for (const surface of ["cdp-profile", "native-partition"] as const) {
      current();
      if (control) {
        const report = await runtime.guardedLoginTargetedImport({ domains, surface }, control);
        // Capture measured/unknown effects before checking authority for successors.
        acknowledgedWritten += report.acknowledgedWritten;
        if (report.effect === "unknown") directEffect = "unknown";
        else if (report.effect === "imported" && directEffect !== "unknown") directEffect = "imported";
        if (report.state === "cancelled" || report.state === "unknown") return finish(report.state);
        current();
        if (report.state === "imported") imported = true;
        if (report.state === "not-consented") consented = false;
      } else {
        try {
          const report = await deps.targetedImport({ domains, surface });
          if (report.state === "imported") imported = true;
          if (report.state === "not-consented") consented = false;
        } catch { /* legacy callers retain their cross-store behavior */ }
      }
    }
    if (!consented && !imported) return finish("unavailable");
    for (const surface of ["cdp-profile", "native-partition"] as const) {
      current();
      const cookies = await deps.readStore(surface, domains).catch(() => null);
      current();
      if (wall.evaluateSessionCookies(cookies, domains, Date.now() / 1_000) === "present") return finish("recovered");
    }
    return finish("not-a-wall");
  } catch (error) {
    if (!control) throw error;
    await observer?.catch(() => undefined);
    // A real observer receipt is not undone by a later refusal to start direct work.
    const accepted = directEffect === "not-started" ? acceptedObserver() : null;
    if (accepted) return finish(accepted);
    let revoked = false;
    try { current(); } catch { revoked = true; }
    return finish(directEffect === "unknown" ? "unknown" : revoked ? "cancelled" : "unknown");
  } finally {
    // Do not release original custody while an already-started observer is still
    // settling, including early event returns and Stop during the poll window.
    if (control) await observer?.catch(() => undefined);
  }
}

export function agiRestartAgentlasBrowser(): Promise<boolean>;
export function agiRestartAgentlasBrowser(control: AgiBrowserRestartControl): Promise<AgiBrowserRestartOutcome>;
export async function agiRestartAgentlasBrowser(control?: AgiBrowserRestartControl): Promise<boolean | AgiBrowserRestartOutcome> {
  if (control) return guardedAgiBrowserRestart(control);
  // Existing fallback-ladder callers retain their zero-argument boolean contract.
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const closed = await launcher.closeBrowserCdpIfIdle(0).catch(() => ({ closed: false, reason: "close-failed" as const, pid: null }));
  // Another run holds a lease: do not pull the browser out from under it; only make sure a host answers.
  if (!closed.closed && closed.reason === "active-leases") {
    try {
      const ownership = await launcher.reconcileBrowserCdpOwnerWithRetry();
      return ownership.state === "owned" && await launcher.browserCdpPortReady();
    } catch { return false; }
  }
  try { await launcher.ensureBrowserCdpHost(); } catch { return false; }
  return launcher.browserCdpPortReady();
}

async function guardedAgiBrowserRestart(control: AgiBrowserRestartControl): Promise<AgiBrowserRestartOutcome> {
  let closeEffect: AgiBrowserRestartOutcome["closeEffect"] = "not-started";
  let ensureEffect: "not-started" | "unknown" = "not-started";
  const current = () => {
    if (control.signal.aborted) throw control.signal.reason ?? new Error("agi.decision.control-changed");
    control.assertCurrent();
  };
  try {
    current();
    const launcher = await import("../mcp-tools/browser-cdp-launcher");
    current();
    const closed = await launcher.closeBrowserCdpIfIdle(0, control);
    closeEffect = closed.effect ?? "unknown";
    // Retain actual close evidence before checking revocation after the await.
    current();
    if (closeEffect === "unknown" || closed.reason === "close-unknown") return { state: "unknown", closeEffect };
    if (closed.reason === "cancelled") return { state: "cancelled", closeEffect };
    if (closed.reason === "active-leases") {
      const ownership = await launcher.reconcileBrowserCdpOwnerWithRetry();
      current();
      if (ownership.state !== "owned") return { state: "failed", closeEffect };
      const ready = await launcher.browserCdpPortReady();
      current();
      return { state: ready ? "ready" : "failed", closeEffect };
    }
    if (!closed.closed && closed.reason !== "not-owned") return { state: "failed", closeEffect };
    // Each guarded borrower keeps its original control. Other current borrowers
    // and legacy consumers can still finish the same shared ensure flight.
    current();
    ensureEffect = "unknown";
    await launcher.ensureBrowserCdpHost({ control });
    current();
    const ready = await launcher.browserCdpPortReady();
    current();
    return { state: ready ? "ready" : "failed", closeEffect, ensureEffect };
  } catch {
    let revoked = false;
    try { current(); } catch { revoked = true; }
    return { state: closeEffect === "unknown" || ensureEffect === "unknown" ? "unknown" : revoked ? "cancelled" : "failed", closeEffect, ensureEffect };
  }
}
