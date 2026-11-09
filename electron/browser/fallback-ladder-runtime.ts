/*
 * The fallback ladder's hands (electron/browser/fallback-ladder.ts decides; this file only acts).
 *
 * Entry points:
 *  - onAgentlasBrowserToolFailure: the MCP bridge (proxy-session.ts) calls it when an agentlas-browser call
 *    returns an error. It measures the surface (relay health, dedicated-Chrome ownership, the page's URL and
 *    visible frame URLs), classifies, runs the bounded ladder and returns how to answer the waiting call:
 *    replay a read-only call on the recovered surface, or annotate the error with a machine block + one line.
 *  - observeBrowserToolForHumanCheck: after a successful page-changing call, a human check on the page arms
 *    the human-check rung (card + live browser in front + watcher that records when the page clears).
 *  - bindBrowserLadderRun: the run (client.ts) lends its chat/run ids, locale and notice sink.
 *  - browserLadderOwnerAction: the owner card's single button.
 *
 * Every transition is a run_events row (kind browser_fallback_ladder) so a soak can count rungs, and the AGI
 * goal manager reads the stop reason (electron/agi/goal-facts.ts).
 */
import { randomUUID } from "node:crypto";
import type { McpInvocationEvent } from "../../shared/types";
import { registrableDomain } from "../../shared/registrable-domain";
import {
  BROWSER_HUMAN_CHECK_NOTICE,
  BROWSER_LADDER_EVENT_KIND,
  BROWSER_LADDER_SCHEMA,
  HUMAN_CHECK_BACKSTOP_MS,
  HUMAN_CHECK_SLOW_WATCH_MS,
  LADDER_STOP_COOLDOWN_MS,
  SELF_HEAL_DELAYS_MS,
  agentlasBrowserMarkers,
  classifyBrowserFailure,
  detectHumanCheck,
  isBrowserErrorPage,
  isBrowserDomToolError,
  isSelfHealingBrowserFailure,
  ladderOwnerCard,
  ladderStopPlainSentence,
  runBrowserLadder,
  type BrowserFailureCode,
  type BrowserFailureFacts,
  type BrowserLadderDeps,
  type BrowserLadderEvent,
  type BrowserSurface,
  type LadderOwnerCard,
  type LadderRung,
  type LadderRunResult,
  type RungOutcome,
} from "./fallback-ladder";
import { detectLoginWall } from "./login-wall";
import { reportHostAlertToOne } from "../one/host-alerts";
import { remoteNativeBrowserGrantForEndpoint, remoteNativeBrowserOwnerScopeForId } from "./main-browser-channel";
import { PAGE_FRAME_PROBE_SOURCE } from "./page-frame-probe";
import type { NativeBrowserRelayGrant, NativeBrowserRelayPage, NativeBrowserRelayOwnerScope } from "./native-cdp-relay";

type Notice = NonNullable<McpInvocationEvent["notice"]>;

interface RunBinding { chatId: string; runId: string; locale: "ko" | "en"; notify?: (notice: Notice) => void;
  nativeGrant?: NativeBrowserRelayGrant | null; nativeRequired?: boolean; nativeComputerUseAvailable?: boolean;
  /** False once the owner stopped the run or it ended. What the app does in the background for this run (the browser self-mend) ends with it. */
  isLive?: () => boolean }
const runs = new Map<string, RunBinding>();

/** The run is still the chat's current run and has not been stopped or ended. */
function runStillLive(binding: RunBinding | undefined): binding is RunBinding {
  if (!binding || runs.get(binding.chatId) !== binding) return false;
  try { return binding.isLive?.() !== false; } catch { return false; }
}

/** The run lends its ids and notice sink; returns the unbind. */
export function bindBrowserLadderRun(binding: RunBinding): () => void {
  runs.set(binding.chatId, binding);
  return () => {
    // The run ended or was stopped: the background mend that was started for it ends with it, in every case.
    cancelSelfHealsOfRun(binding);
    if (runs.get(binding.chatId) !== binding) return;
    runs.delete(binding.chatId);
    // The run ended: its computer-use window grant ends with it.
    computerUseGrants.get(binding.chatId)?.();
    computerUseGrants.delete(binding.chatId);
  };
}

async function localNativeGrant(endpoint: string | null): Promise<NativeBrowserRelayGrant | null> {
  if (!endpoint) return null;
  const remote = remoteNativeBrowserGrantForEndpoint(endpoint);
  if (remote) return remote;
  if (process.type !== "browser" || process.env.ELECTRON_RUN_AS_NODE === "1") return null;
  return (await import("./native-cdp-relay")).nativeBrowserRelayGrantForEndpoint(endpoint);
}

async function ownerScopeForId(id: string): Promise<NativeBrowserRelayOwnerScope | null> {
  const remote = remoteNativeBrowserOwnerScopeForId(id);
  if (remote) return remote;
  if (process.type !== "browser" || process.env.ELECTRON_RUN_AS_NODE === "1") return null;
  return (await import("./native-cdp-relay")).nativeBrowserRelayOwnerScopeForId(id);
}

// ── Surface reading (measurement only) ──────────────────────────────────────────────────────────────────────

/** One page the ladder can look at and act on, on whichever surface the run is on. */
interface LadderPage {
  url: string;
  surface: BrowserSurface;
  evaluate: (expression: string) => Promise<unknown>;
  reload: () => Promise<string | null>;
  present: () => Promise<void>;
  /** Stable tab identity on its surface (the watcher follows the tabs that showed the check, not "the first page"). */
  id?: string;
  /** Calls `onSignal` when this tab navigates, finishes loading or goes away. A signal wakes a re-read; it is never evidence. Returns the stop. */
  watch?: (onSignal: () => void) => () => void;
}

async function dedicatedPages(): Promise<LadderPage[]> {
  const runtime = await import("./login-recovery-runtime");
  const targets = await runtime.dedicatedBrowserPages();
  return targets.map((target) => ({
    url: target.url,
    surface: "dedicated" as const,
    id: target.id,
    watch: (onSignal: () => void) => runtime.watchDedicatedPageSignals(target, onSignal),
    evaluate: (expression: string) => runtime.evaluateCdpPage(target, expression),
    reload: async () => {
      // A blocked command must not be reported as a successful reload merely
      // because the old target still has a non-error URL.
      try { await runtime.evaluateCdpPage(target, "location.reload(), true"); }
      catch { return null; }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const next = (await runtime.dedicatedBrowserPages()).find((page) => page.id === target.id);
      return next?.url ?? null;
    },
    present: async () => {
      // The dedicated browser is headless; the owner's one intentional headful window opens this site.
      const site = siteOf(target.url);
      if (!site) return;
      const { browserOpenLogin } = await import("./connect");
      await browserOpenLogin(site).catch(() => undefined);
    },
  }));
}

function nativePages(grant: NativeBrowserRelayGrant): LadderPage[] {
  return grant.pages().filter((page): page is NativeBrowserRelayPage & { evaluate: NonNullable<NativeBrowserRelayPage["evaluate"]> } => typeof page.evaluate === "function")
    .map((page) => ({
      url: page.url, surface: "native" as const,
      ...(page.id ? { id: page.id } : {}),
      ...(page.retainLoginVerification ? { watch: (onSignal: () => void) => {
        const controller = new AbortController();
        let lease: ReturnType<NonNullable<typeof page.retainLoginVerification>> | null = null;
        let stopWatching: (() => void) | undefined;
        try { lease = page.retainLoginVerification!(controller.signal); stopWatching = lease.watchNavigation?.(onSignal); } catch { /* the backstop poll reads the page */ }
        return () => { try { stopWatching?.(); } catch { /* gone */ } try { lease?.release(); } catch { /* gone */ } controller.abort(); };
      } } : {}),
      evaluate: page.evaluate,
      reload: page.reload,
      present: async () => { await page.present?.(); },
    }));
}

async function surfacePages(grant: NativeBrowserRelayGrant | null): Promise<LadderPage[]> {
  await grant?.refresh?.();
  if (grant) return nativePages(grant);
  return dedicatedPages().catch(() => []);
}

function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? registrableDomain(parsed.hostname) || null : null;
  } catch { return null; }
}

async function pageFacts(page: LadderPage | undefined): Promise<BrowserFailureFacts["page"]> {
  if (!page) return undefined;
  let frames: string[] = [];
  let url = page.url;
  const probe = await Promise.race([page.evaluate(PAGE_FRAME_PROBE_SOURCE).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
  if (probe && typeof probe === "object") {
    const row = probe as { url?: unknown; frames?: unknown };
    if (typeof row.url === "string") url = row.url;
    if (Array.isArray(row.frames)) frames = row.frames.filter((frame): frame is string => typeof frame === "string").slice(0, 32);
  }
  return {
    url,
    loginWall: detectLoginWall({ url }).kind === "login-wall",
    humanCheck: detectHumanCheck({ url, visibleFrameUrls: frames }),
    errorPage: isBrowserErrorPage(url),
  };
}

async function dedicatedFacts(): Promise<BrowserFailureFacts["dedicated"]> {
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const portReady = await launcher.browserCdpPortReady().catch(() => false);
  if (!portReady) return { ownership: "absent", portReady };
  const ownership = await Promise.race([launcher.inspectBrowserCdpOwnership().catch(() => ({ state: "unverifiable" as const })),
    new Promise<{ state: "unverifiable" }>((r) => setTimeout(() => r({ state: "unverifiable" }), 12_000))]);
  return { ownership: ownership.state, portReady };
}

/** Measure the surface after a failed call. Exported for the contract. */
export async function measureBrowserFailure(input: { grant: NativeBrowserRelayGrant | null; resultText: string }): Promise<{ facts: BrowserFailureFacts; page?: LadderPage }> {
  const markers = agentlasBrowserMarkers(input.resultText);
  const surface: BrowserSurface = input.grant ? "native" : "dedicated";
  const pages = await surfacePages(input.grant).catch(() => []);
  const health = input.grant?.health?.();
  const page = pages[0];
  const facts: BrowserFailureFacts = {
    surface, markers,
    ...(health ? { native: { current: health.current, lastRefusal: health.lastRefusal, failedOver: health.failedOver } } : {}),
    ...(!input.grant ? { dedicated: await dedicatedFacts().catch(() => ({ ownership: "unverifiable" as const, portReady: false })) } : {}),
    page: await pageFacts(page),
  };
  return { facts, ...(page ? { page } : {}) };
}

// ── Recording ────────────────────────────────────────────────────────────────────────────────────────────────

function recordEvent(event: BrowserLadderEvent, binding: RunBinding | undefined): void {
  console.info("[browser-ladder]", JSON.stringify(event));
  const runId = binding?.runId ?? `browser-ladder:${event.ladderId}`;
  void import("../store/run-events").then(({ tryRecordRunEvent }) => {
    tryRecordRunEvent({ runId, chatId: binding?.chatId ?? null, kind: BROWSER_LADDER_EVENT_KIND, payload: { ...event } });
  }).catch(() => undefined);
}

function cardNotice(card: LadderOwnerCard, locale: "ko" | "en", level: Notice["level"], scope: LadderScope): Notice {
  const browserSurface = scope.grant || scope.binding?.nativeRequired ? "native" : "dedicated";
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(card.details); } catch { /* A malformed card never gains a native scope. */ }
  return { level, code: card.code, message: locale === "ko" ? card.message.ko : card.message.en,
    i18n: { ko: card.message.ko, en: card.message.en }, details: JSON.stringify({ ...details, browserSurface,
      ...(scope.grant?.ownerScopeId ? { ownerScopeId: scope.grant.ownerScopeId } : {}) }) };
}

// ── Rungs (production) ───────────────────────────────────────────────────────────────────────────────────────

interface LadderScope {
  grant: NativeBrowserRelayGrant | null;
  binding: RunBinding | undefined;
  page: LadderPage | undefined;
  site: string | null;
  suggestions: string[];
  /** The app continues this run by itself after the owner passes the check (decided when the card goes up; the model is told the truth). */
  resumeEligible?: boolean;
  handoff?: { kind: "connector" | "computer-use" | "native-guest"; id: string };
}

async function reestablish(code: BrowserFailureCode, scope: LadderScope): Promise<RungOutcome> {
  if (code === "page-load-failed") {
    const page = scope.page;
    if (!page) return { result: "unavailable", detail: { reason: "no-page" } };
    const url = await page.reload().catch(() => null);
    return url && !isBrowserErrorPage(url) ? { result: "recovered", detail: { reloaded: true } } : { result: "failed", detail: { reloaded: false } };
  }
  const grant = scope.grant;
  if (grant) {
    const before = grant.health?.();
    // A grant that is not current only because the run's hidden browser window was destroyed under it is brought back by reestablish itself.
    if ((!before?.current && before?.revivable !== true) || before.failedOver) return { result: "unavailable", detail: { reason: "grant-not-current" } };
    // A full tab list is not fixed by reconnecting; the other surface has no such limit.
    if (code === "native-tab-limit") return { result: "unavailable", detail: { reason: "tab-limit" } };
    const after = await grant.reestablish?.();
    return after?.current ? { result: "recovered", detail: { revived: after.revived, leases: after.leases, ...(before.current ? {} : { rebound: true }) } } : { result: "failed" };
  }
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const owned = await launcher.reconcileBrowserCdpOwnerWithRetry().catch(() => ({ state: "unverifiable" as const, pid: null, reason: "inspect-failed" }));
  // Never kill or drive a browser that is not ours.
  if (owned.state === "foreign") return { result: "failed", detail: { ownership: "foreign" } };
  let relaunched = false;
  try {
    // An answering owned port is not sufficient: ensure also verifies the
    // isolation marker and quarantines legacy sessions before replaying tools.
    relaunched = (await launcher.ensureBrowserCdpHost()).started;
  } catch (error) {
    const diagnostic = launcher.browserCdpHostFailureDiagnostic(error);
    return { result: "failed", detail: { stage: diagnostic.stage, host: diagnostic.code } };
  }
  return await launcher.browserCdpPortReady().catch(() => false) ? { result: "recovered", detail: { relaunched } } : { result: "failed", detail: { relaunched: false } };
}

async function switchSurface(scope: LadderScope): Promise<RungOutcome> {
  // Moving a native task into CFT silently changes its login identity and can
  // replay the owner's imported tokens in a second browser. Reconnect/reload
  // the canonical host, or use the remaining explicit recovery steps.
  return { result: "unavailable", detail: { reason: scope.grant ? "canonical-session-surface-fixed" : "no-in-app-grant" } };
}

async function loginRecovery(scope: LadderScope): Promise<RungOutcome> {
  const { recoverLoginWallsNow, ownerLoginCardNotice } = await import("./login-recovery-runtime");
  const binding = scope.binding;
  const outcomes = await recoverLoginWallsNow({
    ...(binding ? { runId: binding.runId, chatId: binding.chatId } : {}),
    ...(scope.grant ? { nativeGrant: scope.grant } : {}),
    notify: (card) => { try { binding?.notify?.(ownerLoginCardNotice(card, binding.locale)); } catch { /* run ended */ } },
  });
  const recovered = outcomes.find((o): o is Extract<typeof o, { state: "recovered" }> => o.state === "recovered");
  if (recovered) return { result: "recovered", detail: { via: recovered.via } };
  if (outcomes.some((o) => o.state === "awaiting-owner" || o.state === "in-flight")) return { result: "waiting", detail: { card: "login" } };
  return { result: "failed", detail: { walls: outcomes.length } };
}

/** Brand token of a site: youtube.com → youtube. */
function brandOf(site: string | null): string | null {
  const head = site?.split(".")[0]?.toLowerCase() ?? "";
  return /^[a-z0-9-]{3,40}$/.test(head) ? head : null;
}

async function connectorAlternative(scope: LadderScope): Promise<RungOutcome> {
  const brand = brandOf(scope.site);
  if (!brand) return { result: "unavailable", detail: { reason: "no-site" } };
  const { listInstalledServers } = await import("../mcp-tools/registry");
  const match = listInstalledServers().find((server) => server.enabled && server.catalogId !== "agentlas-browser"
    && [server.id, server.catalogId ?? "", server.name, server.nameEn].some((field) => field.toLowerCase().includes(brand)));
  if (match) {
    scope.handoff = { kind: "connector", id: match.catalogId ?? match.id };
    return { result: "handed-off", detail: { connector: match.catalogId ?? match.id } };
  }
  // Nothing installed: point the agent at the tool resolver; installing stays the owner's decision.
  scope.suggestions.push(`${brand} API (agentlas_resolve_plugins)`);
  return { result: "unavailable", detail: { resolverNeed: `${brand} api` } };
}

/** Scope releasers per chat: a computer-use grant lives while the ladder's run does (and never past its cap). */
const computerUseGrants = new Map<string, () => void>();

async function computerUseNative(scope: LadderScope): Promise<RungOutcome> {
  if (!scope.grant?.nativeComputerUse || !scope.grant.health?.().current) return { result: "unavailable", detail: { reason: "native-guest-capability-unavailable" } };
  if (!scope.binding?.nativeComputerUseAvailable) return { result: "unavailable", detail: { reason: "native-computer-use-not-selected" } };
  const capability = scope.grant.nativeComputerUse;
  const response = await fetch(`${capability.endpoint}/native-guest/action`, { method: "POST",
    headers: { Authorization: `Bearer ${capability.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scopeId: capability.scopeId, action: "listApps" }), signal: AbortSignal.timeout(3_000) });
  const value = await response.json() as { ok?: boolean; apps?: { name?: string }[] };
  if (!value.ok || value.apps?.length !== 1 || typeof value.apps[0].name !== "string"
    || !value.apps[0].name.startsWith(`native-guest:${capability.scopeId}:`)) return { result: "unavailable", detail: { reason: "native-guest-target-unavailable-or-ambiguous" } };
  scope.handoff = { kind: "native-guest", id: value.apps[0].name };
  return { result: "handed-off", detail: { scope: "native-guest", app: value.apps[0].name } };
}

async function computerUseDedicated(scope: LadderScope): Promise<RungOutcome> {
  if (scope.grant || scope.binding?.nativeRequired) return { result: "unavailable", detail: { reason: "canonical-session-surface-fixed" } };
  const { listInstalledServers } = await import("../mcp-tools/registry");
  const cu = listInstalledServers().find((server) => server.enabled && /computer-use|cua/.test(`${server.id} ${server.catalogId ?? ""}`));
  if (!cu) return { result: "unavailable", detail: { reason: "computer-use-not-installed" } };
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  // Rung 5 decision: make OUR Chrome visible (headed, on screen) — only when no other client holds it.
  const headed = await launcher.ensureBrowserCdpHostHeaded();
  if (!headed.ok) return { result: "unavailable", detail: { reason: headed.reason } };
  const { grantComputerUseWindowScope } = await import("../computer-use/window-scope");
  const { dedicatedBrowserWindowBounds } = await import("./login-recovery-runtime");
  const key = scope.binding?.chatId ?? "unbound";
  computerUseGrants.get(key)?.();
  const binding = scope.binding;
  // While the run lives the lock outlasts the grant's time limit; with no run to ask (unbound) the limit applies as before.
  const release = grantComputerUseWindowScope({ pid: headed.pid, windows: () => dedicatedBrowserWindowBounds(), reason: "browser-ladder-rung-5",
    ...(binding ? { alive: () => runStillLive(binding) } : {}) });
  computerUseGrants.set(key, release);
  scope.handoff = { kind: "computer-use", id: String(headed.pid) };
  return { result: "handed-off", detail: { pid: headed.pid, relaunched: headed.relaunched, scope: "window" } };
}

const humanWatchers = new Map<string, { stop: () => void; present: () => Promise<void> }>();
/** Whether the app continues the run by itself after the check (set when the card goes up; any later answer for the same chat and site tells the same truth). */
const humanResumeEligible = new Map<string, boolean>();

/** The continuation owner (page-release-resume.ts), loaded only when a human-check watcher starts; a load failure leaves the old behavior (the owner writes). */
async function pageResume(): Promise<import("./page-release-resume").PageResumeHandle | null> {
  try { return (await import("./page-release-resume")).pageReleaseResume(); } catch { return null; }
}

const tabKey = (page: LadderPage, index: number): string => page.id ?? `#${index}`;

/** Does a tab of this site still show the check? Only the tabs of the site count; none of them present = the browser is gone. */
async function readSiteTabs(grant: NativeBrowserRelayGrant | null, site: string | null): Promise<Array<{ key: string; page: LadderPage; humanCheck: boolean }>> {
  const pages = await surfacePages(grant).catch(() => [] as LadderPage[]);
  const ofSite = pages.map((page, index) => ({ page, key: tabKey(page, index) })).filter(({ page }) => siteOf(page.url) === site || site === null).slice(0, 8);
  return Promise.all(ofSite.map(async ({ page, key }) => ({ key, page, humanCheck: Boolean((await pageFacts(page).catch(() => undefined))?.humanCheck) })));
}

async function humanCheckWait(scope: LadderScope, ladderId: string): Promise<RungOutcome> {
  const page = scope.page;
  if (!page) return { result: "unavailable", detail: { reason: "no-page" } };
  const key = `${scope.binding?.chatId ?? "unbound"}:${scope.site ?? "site"}`;
  if (humanWatchers.has(key)) return { result: "waiting", detail: { watcher: "already-open" } };
  await page.present().catch(() => undefined);
  const startedAt = Date.now();
  let stopped = false;
  const binding = scope.binding;
  // The tabs that showed the check when the card went up. Only these decide; a wall on another tab is not this one's.
  const first = await readSiteTabs(scope.grant, scope.site);
  const walled = new Set(first.filter((tab) => tab.humanCheck).map((tab) => tab.key));
  if (walled.size === 0) { const own = first.find((tab) => tab.page.id !== undefined && tab.page.id === page.id) ?? first[0]; if (own) walled.add(own.key); }
  // A run with ids can be continued after the owner passes the check; an unbound call has no chat to continue in.
  const resume = binding ? await pageResume() : null;
  if (binding && resume) {
    const begun = resume.begin({ ladderId, chatId: binding.chatId, runId: binding.runId, site: scope.site, locale: binding.locale,
      surface: scope.grant || binding.nativeRequired ? "native" : "dedicated", waitStartedAtIso: new Date(startedAt).toISOString() });
    scope.resumeEligible = begun.eligible;
    humanResumeEligible.set(key, scope.resumeEligible);
  }
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let judging = false;
  const cleanups: Array<() => void> = [];
  // A stop that came in during the awaits below must still release what is registered after it.
  const addCleanup = (cleanup: () => void) => { if (stopped) { try { cleanup(); } catch { /* gone */ } } else cleanups.push(cleanup); };
  const stop = () => {
    if (stopped) return; stopped = true;
    if (backstop) clearTimeout(backstop);
    if (wakeTimer) clearTimeout(wakeTimer);
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* gone */ } }
    humanWatchers.delete(key);
    humanResumeEligible.delete(key);
  };
  const finish = (result: "recovered" | "timeout" | "closed" | "moved-on", resumeOutcome: "released" | "abandoned") => {
    stop();
    // The recorded clear is the fact. A browser event must not wake every Goal (3a60b734 removed that global call), so the continuation is
    // exact: this ladder's own chat, once, through page-release-resume.ts. A blocked Goal continues through its own sweep (blocked-goal-sweep.ts).
    const cleared = result === "recovered";
    recordEvent({ schemaVersion: BROWSER_LADDER_SCHEMA, ladderId, code: "human-check-required", step: "final", rung: "human-check-wait",
      result: cleared ? "recovered" : "timeout", surface: page.surface, final: cleared ? "recovered" : "stopped",
      reasonCode: cleared ? "human_check_cleared" : result === "timeout" ? "human_check_timeout" : "human_check_watch_ended", site: scope.site, elapsedMs: Date.now() - startedAt }, binding);
    if (resumeOutcome === "released") resume?.released(ladderId); else resume?.abandon(ladderId, result === "timeout" ? "watch_expired" : result === "moved-on" ? "chat_moved_on" : "tab_closed");
  };
  // One judgment, from the page itself: a tab that showed the check and now does not = passed (checked BEFORE the time limit, so a sleep of
  // hours still sees what the owner just did); a tab gone or a browser gone = nothing was passed; the check still up = keep waiting.
  const judge = async () => {
    if (stopped || judging) return;
    judging = true;
    try {
      const current = binding ? runs.get(binding.chatId) : undefined;
      if (current && current !== binding) { finish("moved-on", "abandoned"); return; }
      let tabs = await readSiteTabs(scope.grant, scope.site);
      const present = () => tabs.filter((tab) => walled.has(tab.key));
      if (present().length === 0) { await new Promise((r) => setTimeout(r, 1_500)); tabs = await readSiteTabs(scope.grant, scope.site); }
      const mine = present();
      if (mine.some((tab) => !tab.humanCheck)) { finish("recovered", "released"); return; }
      if (mine.length === 0) { finish("closed", "abandoned"); return; }
      if (Date.now() - startedAt >= HUMAN_CHECK_SLOW_WATCH_MS) finish("timeout", "abandoned");
    } catch { /* the next signal or the backstop reads again */ } finally {
      judging = false;
      if (!stopped) { backstop = setTimeout(() => { void judge(); }, HUMAN_CHECK_BACKSTOP_MS); backstop.unref?.(); }
    }
  };
  const wake = () => {
    if (stopped || wakeTimer) return;
    wakeTimer = setTimeout(() => { wakeTimer = undefined; if (backstop) clearTimeout(backstop); void judge(); }, 500);
    wakeTimer.unref?.();
  };
  // Signals: a walled tab navigates / loads / closes, a clearance cookie is written, the app window gets focus (the owner came back).
  for (const tab of first) if (walled.has(tab.key) && tab.page.watch) { try { addCleanup(tab.page.watch(wake)); } catch { /* the backstop reads */ } }
  try {
    const login = await import("./login-recovery-runtime");
    addCleanup(login.watchClearanceCookie(scope.grant || binding?.nativeRequired ? "native-partition" : "cdp-profile", wake));
  } catch { /* the backstop reads */ }
  try {
    if (process.type === "browser" && process.env.ELECTRON_RUN_AS_NODE !== "1") {
      const { app } = await import("electron");
      app.on("browser-window-focus", wake);
      addCleanup(() => app.removeListener("browser-window-focus", wake));
    }
  } catch { /* no window events here */ }
  if (!stopped) {
    backstop = setTimeout(() => { void judge(); }, HUMAN_CHECK_BACKSTOP_MS);
    backstop.unref?.();
    humanWatchers.set(key, { stop, present: page.present });
  }
  return { result: "waiting", detail: { watcher: "started", tabs: walled.size } };
}

/** After an app restart: is the check still up on the site? Only the dedicated Chrome outlives the app; a native guest window does not. */
export async function recheckHumanCheckWait(input: { site: string | null; surface: BrowserSurface }): Promise<"cleared" | "still" | "unknown"> {
  if (input.surface !== "dedicated" || !input.site) return "unknown";
  const tabs = await readSiteTabs(null, input.site);
  if (tabs.length === 0) return "unknown";
  return tabs.some((tab) => tab.humanCheck) ? "still" : "cleared";
}

// ── Ladder flights (one per surface key; a stopped ladder cools down) ────────────────────────────────────────

const flights = new Map<string, Promise<LadderRunResult>>();
const stopped = new Map<string, { at: number; result: LadderRunResult; /** Times this cached stop was answered again: a model that keeps asking is told so. */ repeats: number }>();

export interface BrowserLadderAnswer {
  replay: boolean;
  meta: Record<string, unknown>;
  text: string;
}

/** Markers only the in-app relay writes when it refuses a CONNECTION: the call behind them never reached a page. */
const RELAY_REFUSAL_MARKERS: ReadonlySet<string> = new Set(["native-session-ended", "native-session-unavailable", "native-grant-revoked"]);
const REPLAY_RUNGS: ReadonlySet<LadderRung> = new Set(["reestablish", "switch-surface", "login-recovery"]);

function answerFor(result: LadderRunResult, input: { mutating: boolean; neverRan?: boolean }, scope: LadderScope, again: { mendInMs: number | null; repeats: number } = { mendInMs: null, repeats: 0 }): BrowserLadderAnswer {
  const state = result.state;
  const meta = { schema: BROWSER_LADDER_SCHEMA, code: state.code, final: state.final, rung: state.finalRung, surface: state.surface,
    tried: state.tried.map((t) => `${t.rung}:${t.result}`), ...(result.card ? { reasonCode: result.card.reasonCode } : {}),
    ...(scope.handoff ? { handoff: scope.handoff } : {}) };
  // A call that provably never ran (the launcher could not start the browser, or the relay refused the connection with its own marker)
  // is asked again once even when it changes the page: nothing happened, so there is nothing to repeat.
  const replay = state.final === "recovered" && (!input.mutating || input.neverRan === true) && state.finalRung !== null && REPLAY_RUNGS.has(state.finalRung);
  let text: string;
  if (state.final === "recovered") {
    text = state.finalRung === "switch-surface"
      ? "Agentlas browser ladder: switched this run to the dedicated Agentlas browser and carried the site session over. Call the browser tool again."
      : `Agentlas browser ladder: the browser was re-established (${state.code}). Call the browser tool again.`;
  } else if (state.final === "handed-off") {
    text = scope.handoff?.kind === "connector"
      ? `Agentlas browser ladder: the browser path failed (${state.code}); the installed connector "${scope.handoff.id}" covers this site. Use it instead of the browser.`
      : scope.handoff?.kind === "native-guest"
      ? `Agentlas browser ladder: DOM/CDP failed (${state.code}). Use the selected computer-use tools with app "${scope.handoff.id}". First get_screen for that app, then use its latest source_id for each input. The same Main-owned guest remains in use. Each CUA call still requires its own existing permission/approval gate. File upload, clipboard and OS apps are unavailable. Do not replay the failed mutation automatically.`
      : `Agentlas browser ladder: the browser path failed (${state.code}). The dedicated Agentlas browser is now visible; use computer use with app "pid:${scope.handoff?.id}". Computer use is locked to that window until this run ends — other apps, the owner's own Chrome, OS dialogs and password prompts are refused.`;
  } else if (state.final === "waiting-owner") {
    text = state.code === "human-check-required"
      ? (scope.resumeEligible ?? humanResumeEligible.get(`${scope.binding?.chatId ?? "unbound"}:${scope.site ?? "site"}`)) === true
        ? "Agentlas browser ladder: human_check_required — the site shows a human check. The owner was shown one card with the browser in front. Continue with other work, and if nothing else is left, tell the owner what is waiting and stop. When the owner has passed it, the app continues this task by itself in this chat, and the next browser call goes straight through." + " Do not try to solve or bypass it."
        : "Agentlas browser ladder: human_check_required — the site shows a human check. The owner was shown one card with the browser in front. This run does not resume by itself: continue with other work, and if nothing else is left, tell the owner what is waiting and stop. The next browser call after the owner has dealt with it goes straight through. Do not try to solve or bypass it."
      : "Agentlas browser ladder: the site needs the owner's sign-in; one card is open. This run does not resume by itself: continue with other work, and if nothing else is left, tell the owner what is waiting and stop. The next browser call after the owner has signed in goes straight through.";
  } else {
    const suggestion = scope.suggestions.length ? ` Try the tool resolver: agentlas_resolve_plugins with need "${scope.suggestions[0].replace(/ \(agentlas_resolve_plugins\)$/, "")}"; installing stays the owner's decision.` : "";
    // Plain words: this text is what the model repeats to the owner. The machine code and the per-rung results stay in meta (above).
    const head = `Agentlas browser ladder stopped. ${ladderStopPlainSentence(state.code, state.tried)}${suggestion}`;
    if (!isSelfHealingBrowserFailure(state.code)) text = `${head} The owner has one card; continue with work that does not need this browser.`;
    else if (again.mendInMs === null) text = `${head} The app tried to re-establish this browser and could not; continue with work that does not need it.`;
    else {
      // The app re-establishes the browser by itself while this run lives. A call before its next try is answered from the cache and tries
      // nothing, so the model is told how long that is and that repeating the call does not help (it used to be told "call it again").
      const seconds = Math.max(1, Math.round(again.mendInMs / 1000));
      text = `${again.repeats > 0 ? "Same answer as the last browser call; that call tried nothing. " : ""}${head} The app is re-establishing this browser by itself and the owner has not been asked to do anything; its next try is in about ${seconds} s. Until it works, browser calls only return this message, so repeating the call does not help: continue with work that does not need this browser. If nothing else is left, wait about ${seconds} s if you can, then call the browser tool once more.`;
    }
  }
  return { replay, meta, text };
}

/** Owner One tells the owner instead of a "press Retry" card in this room. The run itself never stopped (the agent was told to
 * continue other work); the card stays only when One cannot take the report. */
function announceStopCard(card: LadderOwnerCard, scope: LadderScope): void {
  const binding = scope.binding;
  if (binding && reportHostAlertToOne({ chatId: binding.chatId, code: card.reasonCode,
    detail: binding.locale === "ko" ? card.summary.ko : card.summary.en })) return;
  try { binding?.notify?.(cardNotice(card, binding.locale, "error", scope)); } catch { /* run ended */ }
}

const ladderKey = (grant: NativeBrowserRelayGrant | null, code: BrowserFailureCode): string => `${grant?.endpoint ?? "dedicated"}:${code}`;
/** One background mend per surface key, bound to the run that started it. */
interface SelfHealState { binding: RunBinding; nextAt: number; cancelTimer?: () => void }
const selfHeals = new Map<string, SelfHealState>();
let selfHealDelays: readonly number[] = SELF_HEAL_DELAYS_MS;
/** Starts a timer; returns how to cancel it (a seam that returns nothing cannot be cancelled, the run check at the firing covers that). */
type SelfHealTimer = (fn: () => void, ms: number) => (() => void) | void;
const realSelfHealTimer: SelfHealTimer = (fn, ms) => { const id = setTimeout(fn, ms); (id as { unref?: () => void }).unref?.(); return () => clearTimeout(id); };
let selfHealTimer: SelfHealTimer = realSelfHealTimer;
const startSelfHealTimer = (fn: () => void, ms: number): (() => void) | undefined => {
  const cancel = selfHealTimer(fn, ms);
  return typeof cancel === "function" ? cancel : undefined;
};

/** Ends a mend. The cached stop goes with it: its answer promised the app is mending, and the next live caller runs the ladder itself. */
function endSelfHeal(key: string, state?: SelfHealState): void {
  const current = selfHeals.get(key);
  if (!current || (state && current !== state)) return;
  selfHeals.delete(key);
  stopped.delete(key);
  try { current.cancelTimer?.(); } catch { /* the timer is already gone */ }
}

/** The owner stopped the run, or it ended: nothing it started in the background goes on. */
function cancelSelfHealsOfRun(binding: RunBinding): void {
  for (const [key, state] of [...selfHeals]) if (state.binding === binding) endSelfHeal(key, state);
}

/**
 * After a stop the app can mend by itself: re-establish the same way the ladder's first rung (and the card's Retry) does, after each delay of
 * SELF_HEAL_DELAYS_MS. A recovery clears the cached stop, so the next browser call goes straight through, and the owner is never told. Only when
 * every try failed is the card raised, once.
 *
 * The mend belongs to the run that hit the failure (owner rule: Stop always wins, a background actor never outlives its run). Before every try and
 * before the card it checks that the run is still the chat's current run and was not stopped; otherwise it ends without relaunching the browser
 * and without any alert. A stop with no live run to mend for (no run bound to the chat) schedules nothing. One schedule per surface key; a second
 * run that hits the same stop rides on it. Returns whether a mend is running for this key.
 */
function scheduleSelfHeal(code: BrowserFailureCode, scope: LadderScope, card: LadderOwnerCard): boolean {
  const key = ladderKey(scope.grant, code);
  const binding = scope.binding;
  if (!runStillLive(binding)) return false;
  if (selfHealDelays.length === 0) { announceStopCard(card, scope); return false; }
  const running = selfHeals.get(key);
  if (running) {
    if (runStillLive(running.binding)) return true;
    endSelfHeal(key, running);
  }
  const state: SelfHealState = { binding, nextAt: Date.now() + selfHealDelays[0] };
  selfHeals.set(key, state);
  let step = 0;
  const attempt = (): void => {
    void (async () => {
      if (selfHeals.get(key) !== state) return;
      if (!runStillLive(state.binding)) { endSelfHeal(key, state); return; }
      let healed = false;
      try { healed = (await reestablish(code, scope)).result === "recovered"; } catch { healed = false; }
      if (selfHeals.get(key) !== state) return;
      // Stopped or ended while the try ran: it was the last one, and nobody is told.
      if (!runStillLive(state.binding)) { endSelfHeal(key, state); return; }
      if (healed) { endSelfHeal(key, state); return; }
      step += 1;
      if (step < selfHealDelays.length) { state.nextAt = Date.now() + selfHealDelays[step]; state.cancelTimer = startSelfHealTimer(attempt, selfHealDelays[step]); return; }
      selfHeals.delete(key);
      announceStopCard(card, scope);
    })();
  };
  state.cancelTimer = startSelfHealTimer(attempt, selfHealDelays[0]);
  return true;
}

/** How soon the running mend tries next, or null when none runs for this key (or its run is gone). */
function mendInMs(key: string): number | null {
  const state = selfHeals.get(key);
  return state && runStillLive(state.binding) ? Math.max(0, state.nextAt - Date.now()) : null;
}

function productionDeps(code: BrowserFailureCode, scope: LadderScope, ladderId: string): BrowserLadderDeps {
  const binding = scope.binding;
  return {
    now: () => Date.now(),
    record: (event) => recordEvent(event, binding),
    rung: async (rung) => {
      switch (rung) {
        case "reestablish": return reestablish(code, scope);
        case "switch-surface": return switchSurface(scope);
        case "login-recovery": return loginRecovery(scope);
        case "connector-alternative": return connectorAlternative(scope);
        case "computer-use-native": return computerUseNative(scope);
        case "computer-use-dedicated": return computerUseDedicated(scope);
        case "human-check-wait": return humanCheckWait(scope, ladderId);
      }
    },
    stop: (card) => {
      // A DOM tool error with no other way in is the agent's to handle, not an owner card (see below).
      if (isBrowserDomToolError(code)) return;
      // A stop the app can mend by itself is not the owner's yet: it tries again in the background and raises the card only if every try fails.
      if (isSelfHealingBrowserFailure(code)) { scheduleSelfHeal(code, scope, card); return; }
      announceStopCard(card, scope);
    },
    suggestions: () => scope.suggestions,
  };
}

/** Test seam: the contract swaps the rung executors and the measurement. */
let depsOverride: ((code: BrowserFailureCode, scope: LadderScope, ladderId: string) => BrowserLadderDeps) | null = null;
let measureOverride: typeof measureBrowserFailure | null = null;
export function setBrowserLadderTestSeams(seams: { deps?: typeof depsOverride; measure?: typeof measureOverride;
  selfHealDelaysMs?: readonly number[]; selfHealTimer?: SelfHealTimer } | null): void {
  depsOverride = seams?.deps ?? null;
  measureOverride = seams?.measure ?? null;
  selfHealDelays = seams?.selfHealDelaysMs ?? SELF_HEAL_DELAYS_MS;
  selfHealTimer = seams?.selfHealTimer ?? realSelfHealTimer;
  for (const state of selfHeals.values()) { try { state.cancelTimer?.(); } catch { /* gone */ } }
  flights.clear(); stopped.clear(); selfHeals.clear();
}

/**
 * The MCP bridge calls this when an agentlas-browser call returned an error. Returns null when the browser
 * itself is fine (a page-level error the agent handles), otherwise how to answer the waiting call.
 */
export async function onAgentlasBrowserToolFailure(input: {
  chatId?: string | null;
  nativeEndpoint?: string | null;
  toolName: string;
  mutating: boolean;
  resultText: string;
  /** Typed by the caller from the launcher's own start-failure mark; the relay's refusal markers are read from resultText below. */
  neverRan?: boolean;
}): Promise<BrowserLadderAnswer | null> {
  const binding = input.chatId ? runs.get(input.chatId) : undefined;
  const grant = await localNativeGrant(input.nativeEndpoint ?? null) ?? binding?.nativeGrant ?? null;
  if ((input.nativeEndpoint || binding?.nativeRequired) && !grant) return { replay: false,
    meta: { schema: BROWSER_LADDER_SCHEMA, code: "native-browser-grant-revoked", final: "stopped", surface: "native" },
    text: "This browser task has ended. A current task grant is required to continue in the same browser session." };
  const measured = await (measureOverride ?? measureBrowserFailure)({ grant, resultText: input.resultText });
  const code = classifyBrowserFailure(measured.facts) ?? (grant && !/permission|approval|denied|cancelled|plan-mode|simulation/i.test(input.resultText)
    ? "native-tool-failed" : null);
  if (!code) return null;
  const key = ladderKey(grant, code);
  const answerInput = { mutating: input.mutating,
    neverRan: input.neverRan === true || (measured.facts.markers ?? []).some((marker) => RELAY_REFUSAL_MARKERS.has(marker)) };
  const pageUrl = measured.facts.page?.url ?? null;
  const wall = measured.facts.page?.loginWall ? detectLoginWall({ url: pageUrl }) : null;
  // A sign-in wall names the site it guards (youtube.com behind accounts.google.com), not the identity host.
  const site = wall && wall.kind === "login-wall" ? wall.site : siteOf(pageUrl);
  const scope: LadderScope = { grant, binding, page: measured.page, site, suggestions: [] };
  const cooled = stopped.get(key);
  // A stopped ladder is not re-run inside the cooldown, whoever mends it: the full ladder (a Chrome relaunch among its rungs) runs at the rate it always did.
  // A browser that comes back sooner is noticed by the background mend, whose recovery clears this cache.
  if (cooled && Date.now() - cooled.at < LADDER_STOP_COOLDOWN_MS) {
    cooled.repeats += 1;
    return answerFor(cooled.result, answerInput, scope, { mendInMs: mendInMs(key), repeats: cooled.repeats });
  }
  let flight = flights.get(key);
  if (!flight) {
    const ladderId = randomUUID();
    const deps = (depsOverride ?? productionDeps)(code, scope, ladderId);
    flight = runBrowserLadder({ ladderId, code, surface: measured.facts.surface, site: scope.site }, deps).then((result) => {
      if (result.card && result.state.final === "waiting-owner") {
        try { binding?.notify?.(cardNotice(result.card, binding.locale, "warning", scope)); } catch { /* run ended */ }
      }
      // A sign-in or human check only the owner can pass: the card brings the browser forward, and One also tells
      // the owner so it is not missed in another room (owner 2026-10-05).
      if (result.state.final === "waiting-owner" && binding) {
        const site = scope.site ? ` (${scope.site})` : "";
        reportHostAlertToOne({ chatId: binding.chatId, code: result.card?.reasonCode ?? code,
          detail: result.card ? (binding.locale === "ko" ? result.card.summary.ko : result.card.summary.en)
            : binding.locale === "ko" ? `사이트 로그인이 필요합니다${site}. 열린 로그인 카드에서 로그인하면 작업이 이어집니다.`
              : `The site needs the owner's sign-in${site}. Signing in from the open login card lets the run continue.` });
      }
      if (result.state.final === "stopped" && !isBrowserDomToolError(code)) stopped.set(key, { at: Date.now(), result, repeats: 0 });
      // The browser works again: a mend still waiting for its next try has nothing left to do.
      if (result.state.final === "recovered") endSelfHeal(key);
      return result;
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    flights.set(key, flight);
  }
  const result = await flight;
  /*
   * Owner rule 2026-10-05 ("직접 대조가 전체중단시키거나 하면안됨"): an unclassified DOM tool error in the
   * in-app browser (a missing element, a click that did not land) is a page-level error the agent handles.
   * When computer use cannot take over, the ladder used to stop with an owner error card ("press Retry to
   * continue") and repeat that answer for 5 minutes; the AGI monitor then reported the Goal as stuck
   * (browser_unavailable:browser_ladder:native-tool-failed, 1.2.55 and 1.2.57). Now the agent gets its own error back.
   */
  if (isBrowserDomToolError(code) && result.state.final === "stopped") return null;
  return answerFor(result, answerInput, scope, { mendInMs: mendInMs(key), repeats: 0 });
}

const PAGE_CHANGING = new Set(["browser_navigate", "browser_navigate_back", "browser_click", "browser_snapshot", "browser_wait_for", "browser_tabs", "browser_press_key"]);

/** After a successful page-changing call: a human check on the page arms the human-check rung. Never blocks. */
export function observeBrowserToolForHumanCheck(input: { toolName: string; chatId?: string; nativeGrant?: NativeBrowserRelayGrant | null }): void {
  const leaf = input.toolName.startsWith("agentlas-browser.") ? input.toolName.slice("agentlas-browser.".length) : "";
  if (!PAGE_CHANGING.has(leaf)) return;
  void (async () => {
    const grant = input.nativeGrant ?? null;
    const page = (await surfacePages(grant).catch(() => [] as LadderPage[]))[0];
    const facts = await pageFacts(page);
    // The page is past the check after a release: this run is already continuing, so the app does not start a second turn.
    if (facts && !facts.humanCheck && input.chatId) void pageResume().then((resume) => resume?.noteBrowserOk(input.chatId!, siteOf(facts.url)));
    if (!facts?.humanCheck) return;
    await onAgentlasBrowserToolFailure({ chatId: input.chatId ?? null, nativeEndpoint: grant?.endpoint ?? null, toolName: input.toolName, mutating: true, resultText: "" });
  })().catch(() => undefined);
}

/**
 * The agent called browser_show_owner: the owner has to do a step in the open browser (a phone code, a consent
 * screen). One card with Open browser; pressing it presents the page the agent acted on last and opens a closed
 * panel. Before this an agent had no way to show the in-app browser and fell back to macOS window scripting
 * (Yotube room 2026-10-13 22:50Z, YouTube phone verification: the owner asked where the screen was).
 */
export function ownerBrowserStepNotice(input: { locale: "ko" | "en"; nativeGrant?: NativeBrowserRelayGrant | null }): Notice {
  const message = { ko: "브라우저에서 직접 하실 단계가 있어요", en: "There is a step for you in the browser" };
  const grant = input.nativeGrant ?? null;
  return { level: "warning", code: BROWSER_HUMAN_CHECK_NOTICE, message: input.locale === "ko" ? message.ko : message.en,
    i18n: message, details: JSON.stringify({ schema: BROWSER_LADDER_SCHEMA, reasonCode: "owner_browser_step", action: "open-browser",
      site: null, browserSurface: grant ? "native" : "dedicated", ...(grant?.ownerScopeId ? { ownerScopeId: grant.ownerScopeId } : {}) }) };
}

const droppedWires = new Map<string, { at: number; ladderId: string; chatId: string | null }>();
/**
 * Bridge wire cut under in-flight browser calls (production 2026-09-26..29: 11 calls "agentlas proxy
 * reconnecting"). proxy-child reconnects by itself; this records the drop and whether the same handle came
 * back within a minute, as ladder rung events a soak can count.
 */
export function noteBrowserBridgeWire(event: "dropped" | "reopened", input: { chatId: string | null; handle: string; inflight: number }): void {
  const binding = input.chatId ? runs.get(input.chatId) : undefined;
  if (event === "dropped") {
    const ladderId = randomUUID();
    for (const [handle, drop] of droppedWires) if (Date.now() - drop.at > 10 * 60_000) droppedWires.delete(handle);
    droppedWires.set(input.handle, { at: Date.now(), ladderId, chatId: input.chatId });
    recordEvent({ schemaVersion: BROWSER_LADDER_SCHEMA, ladderId, code: "bridge-wire-dropped", step: "start", surface: "native",
      detail: { inflight: input.inflight }, elapsedMs: 0 }, binding);
    return;
  }
  const drop = droppedWires.get(input.handle);
  if (!drop) return;
  droppedWires.delete(input.handle);
  const elapsedMs = Date.now() - drop.at;
  recordEvent({ schemaVersion: BROWSER_LADDER_SCHEMA, ladderId: drop.ladderId, code: "bridge-wire-dropped", step: "final", rung: "reestablish",
    result: elapsedMs <= 60_000 ? "recovered" : "timeout", surface: "native", final: elapsedMs <= 60_000 ? "recovered" : "stopped", elapsedMs }, binding);
}

/** A run that needed the browser but had no agentlas-browser attached: one typed stop, one card. */
export function recordBrowserMcpNotAttached(input: { chatId: string; runId: string; locale: "ko" | "en"; notify?: (notice: Notice) => void; nativeRequired?: boolean }): void {
  const ladderId = randomUUID();
  const binding: RunBinding = { chatId: input.chatId, runId: input.runId, locale: input.locale,
    nativeRequired: input.nativeRequired === true, ...(input.notify ? { notify: input.notify } : {}) };
  const scope: LadderScope = { grant: null, binding, page: undefined, site: null, suggestions: [] };
  void runBrowserLadder({ ladderId, code: "browser-mcp-not-attached", surface: "dedicated" }, productionDeps("browser-mcp-not-attached", scope, ladderId)).catch(() => undefined);
}

/** The owner card's single button. */
export async function browserLadderOwnerAction(input: {
  action: "retry" | "open-browser" | "fix"; ownerScopeId?: string | null;
  browserSurface?: "native" | "dedicated"; site?: string | null;
}): Promise<{ ok: boolean; code: string }> {
  if (!["retry", "open-browser", "fix"].includes(input.action)) return { ok: false, code: "invalid-request" };
  if (input.ownerScopeId !== undefined && input.ownerScopeId !== null) {
    if (!/^[a-f0-9-]{36}$/i.test(input.ownerScopeId) || input.browserSurface === "dedicated") {
      return { ok: false, code: "native-browser-owner-scope-invalid" };
    }
    const scope = await ownerScopeForId(input.ownerScopeId);
    if (!scope || scope.ownerScopeId !== input.ownerScopeId || scope.grant.ownerScopeId !== input.ownerScopeId) {
      return { ok: false, code: "native-browser-owner-scope-ended" };
    }
    const grant = scope.grant;
    try {
      await grant.refresh?.();
      const current = () => grant.health?.().current === true && grant.health?.().failedOver !== true;
      if (!current()) return { ok: false, code: "native-browser-owner-scope-ended" };
      if (input.action === "open-browser") {
        const site = input.site && /^[a-z0-9.-]{1,253}$/i.test(input.site) ? input.site : null;
        const pages = grant.pages();
        const siteMatches = site ? pages.filter((page) => {
          const wall = detectLoginWall({ url: page.url });
          return wall.kind === "login-wall" ? wall.site === site : siteOf(page.url) === site;
        }) : pages;
        // Several tabs: the one the agent acted on last is the page it asked the owner to look at.
        const lastActed = siteMatches.filter((page) => page.lastActed);
        const matches = siteMatches.length > 1 && lastActed.length === 1 ? lastActed : siteMatches;
        if (matches.length !== 1 || !matches[0].present) {
          return { ok: false, code: matches.length > 1 ? "native-browser-owner-page-ambiguous" : "native-browser-owner-page-unavailable" };
        }
        const presented = await matches[0].present();
        if (!current()) return { ok: false, code: "native-browser-owner-scope-ended" };
        return presented === true ? { ok: true, code: "native-browser-presented" }
          : { ok: false, code: "native-browser-owner-presentation-unavailable" };
      }
      // Clear only this exact grant's ladder cooldown; keep sibling runs and their waiting cards.
      for (const key of stopped.keys()) if (key.startsWith(`${grant.endpoint}:`)) stopped.delete(key);
      const ready = await grant.reestablish?.();
      // A reconnect does not prove sign-in restored; session-change recovery owns node resumption.
      return current() && ready?.current ? { ok: true, code: "native-browser-ready" } : { ok: false, code: "native-browser-not-ready" };
    } catch { return { ok: false, code: "native-browser-owner-action-unavailable" }; }
  }
  // An old/missing card scope cannot silently turn a canonical action into CFT.
  // Dedicated is an explicit legacy surface choice supplied by a typed host card.
  if (input.browserSurface !== "dedicated") return { ok: false, code: "native-browser-owner-scope-required" };
  if (input.action === "open-browser") {
    const site = input.site && /^[a-z0-9.-]{1,253}$/i.test(input.site) ? input.site : null;
    if (!site) return { ok: false, code: "no-site" };
    const { browserOpenLogin } = await import("./connect");
    const opened = await browserOpenLogin(site).catch(() => null);
    return { ok: Boolean(opened && (opened as { ok?: boolean }).ok !== false), code: "login-window-opened" };
  }
  for (const key of stopped.keys()) if (key.startsWith("dedicated:")) stopped.delete(key);
  const { agiRestartAgentlasBrowser } = await import("../agi/browser-seams");
  const ready = await agiRestartAgentlasBrowser().catch(() => false);
  // A restart proves a ready browser, not a resumed Goal (as the native path above says): the code reports only that.
  // It used to report resumed Goals after a resume call that has done nothing since 3a60b734 removed its handler.
  return { ok: ready, code: ready ? "browser-ready" : "browser-not-ready" };
}

export { ladderOwnerCard };
