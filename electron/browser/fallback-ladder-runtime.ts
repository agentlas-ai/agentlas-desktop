/*
 * The fallback ladder's hands (electron/browser/fallback-ladder.ts decides; this file only acts).
 *
 * Entry points:
 *  - onAgentlasBrowserToolFailure: the MCP bridge (proxy-session.ts) calls it when an agentlas-browser call
 *    returns an error. It measures the surface (relay health, dedicated-Chrome ownership, the page's URL and
 *    visible frame URLs), classifies, runs the bounded ladder and returns how to answer the waiting call:
 *    replay a read-only call on the recovered surface, or annotate the error with a machine block + one line.
 *  - observeBrowserToolForHumanCheck: after a successful page-changing call, a human check on the page arms
 *    the human-check rung (card + live browser in front + watcher that resumes when the page clears).
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
  BROWSER_LADDER_EVENT_KIND,
  BROWSER_LADDER_SCHEMA,
  HUMAN_CHECK_POLL_MS,
  HUMAN_CHECK_WATCH_MS,
  LADDER_STOP_COOLDOWN_MS,
  agentlasBrowserMarkers,
  classifyBrowserFailure,
  detectHumanCheck,
  isBrowserErrorPage,
  ladderOwnerCard,
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
import { PAGE_FRAME_PROBE_SOURCE, nativeBrowserRelayGrantForEndpoint, type NativeBrowserRelayGrant, type NativeBrowserRelayPage } from "./native-cdp-relay";

type Notice = NonNullable<McpInvocationEvent["notice"]>;

interface RunBinding { chatId: string; runId: string; locale: "ko" | "en"; notify?: (notice: Notice) => void }
const runs = new Map<string, RunBinding>();

/** The run lends its ids and notice sink; returns the unbind. */
export function bindBrowserLadderRun(binding: RunBinding): () => void {
  runs.set(binding.chatId, binding);
  return () => {
    if (runs.get(binding.chatId) !== binding) return;
    runs.delete(binding.chatId);
    // The run ended: its computer-use window grant ends with it.
    computerUseGrants.get(binding.chatId)?.();
    computerUseGrants.delete(binding.chatId);
  };
}

// ── Surface reading (measurement only) ──────────────────────────────────────────────────────────────────────

/** One page the ladder can look at and act on, on whichever surface the run is on. */
interface LadderPage {
  url: string;
  surface: BrowserSurface;
  evaluate: (expression: string) => Promise<unknown>;
  reload: () => Promise<string | null>;
  present: () => Promise<void>;
}

async function dedicatedPages(): Promise<LadderPage[]> {
  const runtime = await import("./login-recovery-runtime");
  const targets = await runtime.dedicatedBrowserPages();
  return targets.map((target) => ({
    url: target.url,
    surface: "dedicated" as const,
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
      evaluate: page.evaluate,
      reload: page.reload,
      present: async () => { page.present?.(); },
    }));
}

async function surfacePages(grant: NativeBrowserRelayGrant | null): Promise<LadderPage[]> {
  if (grant && grant.health?.().failedOver !== true) return nativePages(grant);
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
  const health = input.grant?.health?.();
  const surface: BrowserSurface = input.grant ? "native" : "dedicated";
  const pages = await surfacePages(input.grant).catch(() => []);
  const page = pages[0];
  const facts: BrowserFailureFacts = {
    surface, markers,
    ...(health ? { native: { current: health.current, lastRefusal: health.lastRefusal, failedOver: health.failedOver } } : {}),
    ...(!input.grant || health?.failedOver ? { dedicated: await dedicatedFacts().catch(() => ({ ownership: "unverifiable" as const, portReady: false })) } : {}),
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

function cardNotice(card: LadderOwnerCard, locale: "ko" | "en", level: Notice["level"]): Notice {
  return { level, code: card.code, message: locale === "ko" ? card.message.ko : card.message.en,
    i18n: { ko: card.message.ko, en: card.message.en }, details: card.details };
}

// ── Rungs (production) ───────────────────────────────────────────────────────────────────────────────────────

interface LadderScope {
  grant: NativeBrowserRelayGrant | null;
  binding: RunBinding | undefined;
  page: LadderPage | undefined;
  site: string | null;
  suggestions: string[];
  handoff?: { kind: "connector" | "computer-use"; id: string };
}

async function reestablish(code: BrowserFailureCode, scope: LadderScope): Promise<RungOutcome> {
  if (code === "page-load-failed") {
    const page = scope.page;
    if (!page) return { result: "unavailable", detail: { reason: "no-page" } };
    const url = await page.reload().catch(() => null);
    return url && !isBrowserErrorPage(url) ? { result: "recovered", detail: { reloaded: true } } : { result: "failed", detail: { reloaded: false } };
  }
  const grant = scope.grant;
  if (grant && grant.health?.().failedOver !== true) {
    const before = grant.health?.();
    if (!before?.current) return { result: "unavailable", detail: { reason: "grant-not-current" } };
    // A full tab list is not fixed by reconnecting; the other surface has no such limit.
    if (code === "native-tab-limit") return { result: "unavailable", detail: { reason: "tab-limit" } };
    const after = grant.reestablish?.();
    return after?.current ? { result: "recovered", detail: { revived: after.revived, leases: after.leases } } : { result: "failed" };
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
  const grant = scope.grant;
  if (!grant || grant.health?.().failedOver === true) {
    // Dedicated → in-app needs a window-bound grant, which only a new run can mint (the card's retry).
    return { result: "unavailable", detail: { reason: grant ? "already-failed-over" : "no-in-app-grant" } };
  }
  if (!grant.health?.().current || !grant.failover) return { result: "unavailable", detail: { reason: "grant-not-current" } };
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  try { await launcher.ensureBrowserCdpHost(); }
  catch (error) { return { result: "failed", detail: { host: launcher.browserCdpHostFailureDiagnostic(error).code } }; }
  const owned = await launcher.reconcileBrowserCdpOwnerWithRetry().catch(() => null);
  if (owned?.state !== "owned") return { result: "failed", detail: { ownership: owned?.state ?? "unknown" } };
  const port = launcher.browserCdpPort();
  const { fetchCdpJson } = await import("./native-session-cookie-import");
  const version = await fetchCdpJson(port, "/json/version").catch(() => null) as { webSocketDebuggerUrl?: unknown } | null;
  const ws = typeof version?.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : "";
  let parsed: URL | null = null;
  try { parsed = new URL(ws); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== port) return { result: "failed", detail: { reason: "no-devtools-endpoint" } };
  // Carry the site session the in-app browser holds (the owner's own login) into the dedicated profile.
  let carried = 0;
  if (scope.site) {
    const { productionLoginRecoveryDeps } = await import("./login-recovery-runtime");
    const { identityDomainsFor } = await import("./login-wall");
    const domains = [...new Set([scope.site, ...identityDomainsFor(scope.site)])];
    const report = await productionLoginRecoveryDeps().feedStore({ from: "native-partition", to: "cdp-profile", domains }).catch(() => ({ state: "failed" as const, written: 0 }));
    carried = report.written;
  }
  const lease = await launcher.acquireBrowserCdpLease("ladder-failover").catch(() => null);
  grant.failover({ webSocketDebuggerUrl: parsed.toString(), port, release: () => launcher.releaseBrowserCdpLease(lease) });
  return grant.health?.().failedOver ? { result: "recovered", surface: "dedicated", detail: { carriedCookies: carried } } : { result: "failed", detail: { reason: "failover-refused" } };
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

async function computerUseDedicated(scope: LadderScope): Promise<RungOutcome> {
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
  const release = grantComputerUseWindowScope({ pid: headed.pid, windows: () => dedicatedBrowserWindowBounds(), reason: "browser-ladder-rung-5" });
  computerUseGrants.set(key, release);
  scope.handoff = { kind: "computer-use", id: String(headed.pid) };
  return { result: "handed-off", detail: { pid: headed.pid, relaunched: headed.relaunched, scope: "window" } };
}

const humanWatchers = new Map<string, { stop: () => void; present: () => Promise<void> }>();

async function humanCheckWait(scope: LadderScope, ladderId: string): Promise<RungOutcome> {
  const page = scope.page;
  if (!page) return { result: "unavailable", detail: { reason: "no-page" } };
  const key = `${scope.binding?.chatId ?? "unbound"}:${scope.site ?? "site"}`;
  if (humanWatchers.has(key)) return { result: "waiting", detail: { watcher: "already-open" } };
  await page.present().catch(() => undefined);
  const startedAt = Date.now();
  let stopped = false;
  const binding = scope.binding;
  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      const pages = await surfacePages(scope.grant).catch(() => [] as LadderPage[]);
      const facts = await pageFacts(pages.find((p) => siteOf(p.url) === scope.site) ?? pages[0]).catch(() => undefined);
      const cleared = facts !== undefined && !facts.humanCheck;
      const expired = Date.now() - startedAt >= HUMAN_CHECK_WATCH_MS;
      if (!cleared && !expired) return;
      stop();
      recordEvent({ schemaVersion: BROWSER_LADDER_SCHEMA, ladderId, code: "human-check-required", step: "final", rung: "human-check-wait",
        result: cleared ? "recovered" : "timeout", surface: page.surface, final: cleared ? "recovered" : "stopped",
        reasonCode: cleared ? "human_check_cleared" : "human_check_timeout", site: scope.site, elapsedMs: Date.now() - startedAt }, binding);
      if (cleared) {
        const { triggerBrowserRecoveryResume } = await import("./login-recovery-runtime");
        triggerBrowserRecoveryResume();
      }
    })().catch(() => undefined);
  }, HUMAN_CHECK_POLL_MS);
  timer.unref?.();
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); humanWatchers.delete(key); };
  humanWatchers.set(key, { stop, present: page.present });
  return { result: "waiting", detail: { watcher: "started" } };
}

// ── Ladder flights (one per surface key; a stopped ladder cools down) ────────────────────────────────────────

const flights = new Map<string, Promise<LadderRunResult>>();
const stopped = new Map<string, { at: number; result: LadderRunResult }>();

export interface BrowserLadderAnswer {
  replay: boolean;
  meta: Record<string, unknown>;
  text: string;
}

const REPLAY_RUNGS: ReadonlySet<LadderRung> = new Set(["reestablish", "switch-surface", "login-recovery"]);

function answerFor(result: LadderRunResult, input: { mutating: boolean }, scope: LadderScope): BrowserLadderAnswer {
  const state = result.state;
  const meta = { schema: BROWSER_LADDER_SCHEMA, code: state.code, final: state.final, rung: state.finalRung, surface: state.surface,
    tried: state.tried.map((t) => `${t.rung}:${t.result}`), ...(result.card ? { reasonCode: result.card.reasonCode } : {}),
    ...(scope.handoff ? { handoff: scope.handoff } : {}) };
  const replay = state.final === "recovered" && !input.mutating && state.finalRung !== null && REPLAY_RUNGS.has(state.finalRung);
  let text: string;
  if (state.final === "recovered") {
    text = state.finalRung === "switch-surface"
      ? "Agentlas browser ladder: switched this run to the dedicated Agentlas browser and carried the site session over. Call the browser tool again."
      : `Agentlas browser ladder: the browser was re-established (${state.code}). Call the browser tool again.`;
  } else if (state.final === "handed-off") {
    text = scope.handoff?.kind === "connector"
      ? `Agentlas browser ladder: the browser path failed (${state.code}); the installed connector "${scope.handoff.id}" covers this site. Use it instead of the browser.`
      : `Agentlas browser ladder: the browser path failed (${state.code}). The dedicated Agentlas browser is now visible; use computer use with app "pid:${scope.handoff?.id}". Computer use is locked to that window until this run ends — other apps, the owner's own Chrome, OS dialogs and password prompts are refused.`;
  } else if (state.final === "waiting-owner") {
    text = state.code === "human-check-required"
      ? "Agentlas browser ladder: human_check_required — the site shows a human check. The owner was shown one card with the browser in front; the run resumes when the page clears. Do not try to solve or bypass it; continue other work."
      : "Agentlas browser ladder: the site needs the owner's sign-in; one card is open and the run resumes when the session appears. Continue other work.";
  } else {
    const suggestion = scope.suggestions.length ? ` Try the tool resolver: agentlas_resolve_plugins with need "${scope.suggestions[0].replace(/ \(agentlas_resolve_plugins\)$/, "")}"; installing stays the owner's decision.` : "";
    text = `Agentlas browser ladder stopped: ${result.card?.reasonCode ?? state.code}. Tried: ${state.tried.map((t) => `${t.rung}=${t.result}`).join(", ")}.${suggestion} The owner has one card; continue with work that does not need this browser.`;
  }
  return { replay, meta, text };
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
        case "computer-use-dedicated": return computerUseDedicated(scope);
        case "human-check-wait": return humanCheckWait(scope, ladderId);
      }
    },
    stop: (card) => {
      try { binding?.notify?.(cardNotice(card, binding.locale, "error")); } catch { /* run ended */ }
    },
    suggestions: () => scope.suggestions,
  };
}

/** Test seam: the contract swaps the rung executors and the measurement. */
let depsOverride: ((code: BrowserFailureCode, scope: LadderScope, ladderId: string) => BrowserLadderDeps) | null = null;
let measureOverride: typeof measureBrowserFailure | null = null;
export function setBrowserLadderTestSeams(seams: { deps?: typeof depsOverride; measure?: typeof measureOverride } | null): void {
  depsOverride = seams?.deps ?? null;
  measureOverride = seams?.measure ?? null;
  flights.clear(); stopped.clear();
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
}): Promise<BrowserLadderAnswer | null> {
  const grant = nativeBrowserRelayGrantForEndpoint(input.nativeEndpoint ?? null);
  const binding = input.chatId ? runs.get(input.chatId) : undefined;
  const measured = await (measureOverride ?? measureBrowserFailure)({ grant, resultText: input.resultText });
  const code = classifyBrowserFailure(measured.facts);
  if (!code) return null;
  const key = `${input.nativeEndpoint ?? "dedicated"}:${code}`;
  const pageUrl = measured.facts.page?.url ?? null;
  const wall = measured.facts.page?.loginWall ? detectLoginWall({ url: pageUrl }) : null;
  // A sign-in wall names the site it guards (youtube.com behind accounts.google.com), not the identity host.
  const site = wall && wall.kind === "login-wall" ? wall.site : siteOf(pageUrl);
  const scope: LadderScope = { grant, binding, page: measured.page, site, suggestions: [] };
  const cooled = stopped.get(key);
  if (cooled && Date.now() - cooled.at < LADDER_STOP_COOLDOWN_MS) return answerFor(cooled.result, input, scope);
  let flight = flights.get(key);
  if (!flight) {
    const ladderId = randomUUID();
    const deps = (depsOverride ?? productionDeps)(code, scope, ladderId);
    flight = runBrowserLadder({ ladderId, code, surface: measured.facts.surface, site: scope.site }, deps).then((result) => {
      if (result.card && result.state.final === "waiting-owner") {
        try { binding?.notify?.(cardNotice(result.card, binding.locale, "warning")); } catch { /* run ended */ }
      }
      if (result.state.final === "stopped") stopped.set(key, { at: Date.now(), result });
      return result;
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    flights.set(key, flight);
  }
  return answerFor(await flight, input, scope);
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
    if (!facts?.humanCheck) return;
    await onAgentlasBrowserToolFailure({ chatId: input.chatId ?? null, nativeEndpoint: grant?.endpoint ?? null, toolName: input.toolName, mutating: true, resultText: "" });
  })().catch(() => undefined);
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
export function recordBrowserMcpNotAttached(input: { chatId: string; runId: string; locale: "ko" | "en"; notify?: (notice: Notice) => void }): void {
  const ladderId = randomUUID();
  const binding: RunBinding = { chatId: input.chatId, runId: input.runId, locale: input.locale, ...(input.notify ? { notify: input.notify } : {}) };
  const scope: LadderScope = { grant: null, binding, page: undefined, site: null, suggestions: [] };
  void runBrowserLadder({ ladderId, code: "browser-mcp-not-attached", surface: "dedicated" }, productionDeps("browser-mcp-not-attached", scope, ladderId)).catch(() => undefined);
}

/** The owner card's single button. */
export async function browserLadderOwnerAction(input: { action: "retry" | "open-browser" | "fix"; chatId?: string | null; site?: string | null }): Promise<{ ok: boolean; code: string }> {
  if (input.action === "open-browser") {
    const watcher = [...humanWatchers.entries()].find(([key]) => !input.chatId || key.startsWith(`${input.chatId}:`))?.[1];
    if (watcher) { await watcher.present().catch(() => undefined); return { ok: true, code: "browser-presented" }; }
    const site = input.site && /^[a-z0-9.-]+$/i.test(input.site) ? input.site : null;
    if (!site) return { ok: false, code: "no-site" };
    const { browserOpenLogin } = await import("./connect");
    const opened = await browserOpenLogin(site).catch(() => null);
    return { ok: Boolean(opened && (opened as { ok?: boolean }).ok !== false), code: "login-window-opened" };
  }
  // retry / fix: clear the cooldown, bring the dedicated browser up (never touching a foreign one), resume goals.
  stopped.clear();
  const { agiRestartAgentlasBrowser } = await import("../agi/browser-seams");
  const ready = await agiRestartAgentlasBrowser().catch(() => false);
  const { triggerBrowserRecoveryResume } = await import("./login-recovery-runtime");
  triggerBrowserRecoveryResume();
  return { ok: ready, code: ready ? "browser-ready-goals-resumed" : "browser-not-ready-goals-resumed" };
}

export { ladderOwnerCard };
