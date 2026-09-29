/*
 * Agentlas browser fallback ladder — what happens when an agent's browser use fails.
 *
 * Owner 2026-09-29: "agentlas browser 안되면? 만약에 안되면 어캄?" / "agentlas browser면 다 되야" /
 * "유료작업 빼고 다 하셈". Before this module a failed browser call was the end of the road: the agent read a
 * prose error, retried the same broken surface a few times and stopped (measured on the owner's machine,
 * 2026-09-26T21Z..09-29T12Z: 192 failed agentlas-browser calls; 45 calls in 17 runs were a native relay session
 * answering 404 on every reconnect for the rest of the run, 3 calls an unverifiable ownership state, 11 calls a
 * dropped bridge wire, 13 closed targets, 1 tab-limit refusal, 9 login-wall pages).
 *
 * Shape: a bounded state machine. Input is a machine failure code (classifyBrowserFailure reads measured facts
 * and our own fixed markers, never tool prose). Each code has an ordered list of rungs; each rung has an attempt
 * cap and a time cap; the whole ladder has a time budget; every transition is one typed event. The runner takes
 * its hands (reestablish, switch surface, login ladder, connector hand-off, computer use, human-check wait, stop
 * card) as injected deps so the contract can drive every rung with fault injection.
 *
 * Safety (unchanged by this module): no CAPTCHA solving, no bot-detection evasion, no paid actions. A human check
 * (CAPTCHA/anti-bot wall) is not a dead stop: the owner sees one card with the live browser brought forward, the
 * page is watched until the check clears, and the run resumes (reason code human_check_required).
 */

export const BROWSER_LADDER_SCHEMA = "agentlas.browser-fallback-ladder.v1" as const;
/** run_events.kind for every ladder transition (a soak counts these). */
export const BROWSER_LADDER_EVENT_KIND = "browser_fallback_ladder" as const;
/** Notice codes the chat renders with one action button. */
export const BROWSER_LADDER_STOP_NOTICE = "browser-ladder-stopped" as const;
export const BROWSER_HUMAN_CHECK_NOTICE = "browser-human-check" as const;
/** Reason code recorded while a person must pass a site's human check. */
export const HUMAN_CHECK_REASON = "human_check_required" as const;

export type BrowserSurface = "native" | "dedicated";

export const BROWSER_FAILURE_CODES = [
  /** The MCP bridge wire under an in-flight call was cut (proxy-child reconnects on its own). */
  "bridge-wire-dropped",
  /** The dedicated Chrome could not be started. */
  "chrome-launch-failed",
  /** The dedicated Chrome we own is gone or its CDP port stopped answering. */
  "chrome-crashed",
  /** The CDP port listener could not be attributed to our dedicated profile (lsof failed, etc.). */
  "ownership-unverifiable",
  /** The CDP port is held by a browser outside the Agentlas profile (never killed, never driven). */
  "port-foreign",
  /** The in-app relay no longer knows this run's session (HTTP 410). */
  "native-session-ended",
  /** The in-app browser refused a new tab (tab limit). */
  "native-tab-limit",
  /** The in-app browser grant lost its window/guest (window closed, chat moved). */
  "native-guest-destroyed",
  /** The page is a sign-in wall. */
  "login-wall",
  /** The page is a site's human check (CAPTCHA / anti-bot interstitial). */
  "human-check-required",
  /** The page never loaded (browser error page). */
  "page-load-failed",
  /** The run needed the browser and the agentlas-browser MCP was not attached. */
  "browser-mcp-not-attached",
] as const;
export type BrowserFailureCode = (typeof BROWSER_FAILURE_CODES)[number];

export type LadderRung =
  | "reestablish"
  | "switch-surface"
  | "login-recovery"
  | "connector-alternative"
  | "computer-use-dedicated"
  | "human-check-wait"
  | "stop";

/** Per-rung bounds. The runner races each attempt against timeoutMs. */
export const LADDER_RUNG_LIMITS: Readonly<Record<Exclude<LadderRung, "stop">, { attempts: number; timeoutMs: number }>> = Object.freeze({
  "reestablish": { attempts: 2, timeoutMs: 15_000 },
  "switch-surface": { attempts: 1, timeoutMs: 20_000 },
  "login-recovery": { attempts: 1, timeoutMs: 30_000 },
  "connector-alternative": { attempts: 1, timeoutMs: 5_000 },
  "computer-use-dedicated": { attempts: 1, timeoutMs: 5_000 },
  // Only the arming (card + watcher start) is bounded here; the watcher has its own cap.
  "human-check-wait": { attempts: 1, timeoutMs: 10_000 },
});
/**
 * Whole-ladder budget for the synchronous part: the failed tool call is waiting on it, and an MCP client's own
 * tool timeout (Codex: 60 s by default) must not fire first.
 */
export const LADDER_TOTAL_BUDGET_MS = 50_000;
/** How long the human-check watcher waits for the page to clear before it gives up (recorded, no loop). */
export const HUMAN_CHECK_WATCH_MS = 15 * 60_000;
export const HUMAN_CHECK_POLL_MS = 2_000;
/** A stopped ladder for the same key and code is not re-run inside this window (no retry storm). */
export const LADDER_STOP_COOLDOWN_MS = 5 * 60_000;

/**
 * Ordered rungs per failure. Human checks never switch surface (a different browser to get past a check would
 * be evasion); they wait for the owner. A foreign port is re-inspected, never killed.
 */
export const LADDER_POLICY: Readonly<Record<BrowserFailureCode, readonly LadderRung[]>> = Object.freeze({
  "bridge-wire-dropped": ["reestablish", "switch-surface", "stop"],
  "chrome-launch-failed": ["reestablish", "switch-surface", "connector-alternative", "stop"],
  "chrome-crashed": ["reestablish", "switch-surface", "connector-alternative", "stop"],
  "ownership-unverifiable": ["reestablish", "switch-surface", "connector-alternative", "computer-use-dedicated", "stop"],
  "port-foreign": ["reestablish", "switch-surface", "connector-alternative", "stop"],
  "native-session-ended": ["reestablish", "switch-surface", "connector-alternative", "computer-use-dedicated", "stop"],
  "native-tab-limit": ["reestablish", "switch-surface", "connector-alternative", "computer-use-dedicated", "stop"],
  "native-guest-destroyed": ["reestablish", "switch-surface", "connector-alternative", "computer-use-dedicated", "stop"],
  "login-wall": ["login-recovery", "switch-surface", "connector-alternative", "stop"],
  "human-check-required": ["human-check-wait", "stop"],
  "page-load-failed": ["reestablish", "switch-surface", "connector-alternative", "stop"],
  "browser-mcp-not-attached": ["connector-alternative", "stop"],
});

/**
 * recovered   the same or the other surface works again (a read-only call may be replayed)
 * handed-off  the agent was pointed at a different path (installed connector / computer use)
 * waiting     a person was asked (login card, human-check card) and a watcher resumes the run
 * failed      tried and it did not work (counts against the rung's attempts)
 * unavailable the rung's precondition does not hold here (moves on at once, no attempt spent)
 * timeout     the attempt hit its time cap (counts as failed)
 */
export type RungResult = "recovered" | "handed-off" | "waiting" | "failed" | "unavailable" | "timeout";

export interface RungOutcome {
  result: RungResult;
  /** Bounded machine detail (codes, counts, ids). Never page text, never secrets. */
  detail?: Record<string, string | number | boolean | null>;
  /** The surface the run is on after this rung (a switch changes it). */
  surface?: BrowserSurface;
}

export type LadderFinal = "recovered" | "handed-off" | "waiting-owner" | "stopped";

export interface LadderTried { rung: LadderRung; attempt: number; result: RungResult; detail?: RungOutcome["detail"] }

export interface LadderState {
  code: BrowserFailureCode;
  surface: BrowserSurface;
  startSurface: BrowserSurface;
  rungIndex: number;
  attempts: Partial<Record<LadderRung, number>>;
  startedAt: number;
  transitions: number;
  tried: LadderTried[];
  final: LadderFinal | null;
  /** The rung that ended the ladder. */
  finalRung: LadderRung | null;
}

export function startLadder(code: BrowserFailureCode, surface: BrowserSurface, now: number): LadderState {
  return { code, surface, startSurface: surface, rungIndex: 0, attempts: {}, startedAt: now, transitions: 0, tried: [], final: null, finalRung: null };
}

/** Hard ceiling on transitions: every rung's attempts plus one per rung. A ladder cannot loop. */
export function ladderTransitionCap(code: BrowserFailureCode): number {
  return LADDER_POLICY[code].reduce((sum, rung) => sum + (rung === "stop" ? 1 : LADDER_RUNG_LIMITS[rung].attempts + 1), 0);
}

/** The next rung to try, or "stop" when the ladder is out of rungs, attempts, time or transitions. */
export function nextRung(state: LadderState, now: number): { rung: LadderRung; attempt: number } {
  const rungs = LADDER_POLICY[state.code];
  if (state.final) return { rung: "stop", attempt: 0 };
  if (now - state.startedAt >= LADDER_TOTAL_BUDGET_MS || state.transitions >= ladderTransitionCap(state.code)) {
    return { rung: "stop", attempt: 1 };
  }
  let index = state.rungIndex;
  while (index < rungs.length) {
    const rung = rungs[index];
    if (rung === "stop") return { rung, attempt: 1 };
    const used = state.attempts[rung] ?? 0;
    if (used < LADDER_RUNG_LIMITS[rung].attempts) return { rung, attempt: used + 1 };
    index += 1;
  }
  return { rung: "stop", attempt: 1 };
}

/** Pure transition. Unavailable moves on without spending an attempt; failed/timeout spend one. */
export function applyRungResult(state: LadderState, rung: LadderRung, outcome: RungOutcome): LadderState {
  const rungs = LADDER_POLICY[state.code];
  const attempts = { ...state.attempts };
  const next: LadderState = { ...state, attempts, transitions: state.transitions + 1, tried: [...state.tried] };
  if (rung === "stop") {
    next.final = "stopped"; next.finalRung = "stop";
    next.tried.push({ rung, attempt: 1, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    return next;
  }
  const attempt = (attempts[rung] ?? 0) + (outcome.result === "unavailable" ? 0 : 1);
  attempts[rung] = attempt;
  next.tried.push({ rung, attempt: Math.max(1, attempt), result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  if (outcome.surface) next.surface = outcome.surface;
  const at = rungs.indexOf(rung);
  if (at >= 0 && at > next.rungIndex) next.rungIndex = at;
  if (outcome.result === "recovered" || outcome.result === "handed-off" || outcome.result === "waiting") {
    next.final = outcome.result === "waiting" ? "waiting-owner" : outcome.result;
    next.finalRung = rung;
    return next;
  }
  if (outcome.result === "unavailable" || attempt >= LADDER_RUNG_LIMITS[rung].attempts) {
    next.rungIndex = Math.max(next.rungIndex, at + 1);
  }
  return next;
}

// ── Classification: measured facts + our own fixed markers only ───────────────────────────────────────────

/**
 * Fixed strings that Agentlas code itself emits (never upstream prose). Recognising our own marker is reading a
 * machine code, like NEEDS-FULL-ACCESS; a Playwright sentence ("does not look like a DevTools server") is not.
 */
export const AGENTLAS_BROWSER_MARKERS = Object.freeze({
  "proxy-reconnecting": "agentlas proxy reconnecting (",
  "proxy-scope-changed": "agentlas proxy scope changed (",
  "native-session-ended": "native-browser-session-ended",
  "native-tab-limit": "native-browser-tab-limit",
  "native-grant-revoked": "native-browser-grant-revoked",
  "native-session-unavailable": "native-browser-session-unavailable",
  "start-failed": "Agentlas Browser could not start safely",
} as const);
export type AgentlasBrowserMarker = keyof typeof AGENTLAS_BROWSER_MARKERS;

export function agentlasBrowserMarkers(text: string | null | undefined): AgentlasBrowserMarker[] {
  if (!text) return [];
  const bounded = text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text;
  return (Object.keys(AGENTLAS_BROWSER_MARKERS) as AgentlasBrowserMarker[]).filter((key) => bounded.includes(AGENTLAS_BROWSER_MARKERS[key]));
}

export type NativeRelayRefusal = "session-ended" | "tab-limit" | "session-unavailable" | "grant-revoked";
export type DedicatedOwnership = "absent" | "owned" | "adoptable" | "foreign" | "unverifiable";

export interface BrowserFailureFacts {
  surface: BrowserSurface;
  markers: readonly AgentlasBrowserMarker[];
  native?: { current: boolean; lastRefusal: NativeRelayRefusal | null; failedOver: boolean };
  dedicated?: { ownership: DedicatedOwnership; portReady: boolean };
  page?: { url: string | null; loginWall: boolean; humanCheck: boolean; errorPage: boolean };
}

/**
 * null means "not a surface failure": the browser works and the call failed on the page (stale ref, element not
 * found, script error). The agent's own next step handles those; the ladder stays out of the way.
 */
export function classifyBrowserFailure(facts: BrowserFailureFacts): BrowserFailureCode | null {
  const marks = new Set(facts.markers);
  if (facts.page?.humanCheck) return "human-check-required";
  if (facts.page?.loginWall) return "login-wall";
  if (facts.surface === "native" && facts.native && !facts.native.failedOver) {
    if (!facts.native.current || facts.native.lastRefusal === "grant-revoked" || marks.has("native-grant-revoked")) return "native-guest-destroyed";
    if (facts.native.lastRefusal === "session-ended" || marks.has("native-session-ended")) return "native-session-ended";
    if (facts.native.lastRefusal === "tab-limit" || marks.has("native-tab-limit")) return "native-tab-limit";
    if (facts.native.lastRefusal === "session-unavailable" || marks.has("native-session-unavailable")) return "native-session-ended";
  }
  if (facts.surface === "dedicated" || facts.native?.failedOver) {
    const d = facts.dedicated;
    if (d) {
      if (d.ownership === "foreign") return "port-foreign";
      if (d.ownership === "unverifiable") return "ownership-unverifiable";
      if (d.ownership === "absent" || !d.portReady) return marks.has("start-failed") ? "chrome-launch-failed" : "chrome-crashed";
    } else if (marks.has("start-failed")) {
      return "chrome-launch-failed";
    }
  }
  if (facts.page?.errorPage) return "page-load-failed";
  if (marks.has("proxy-reconnecting")) return "bridge-wire-dropped";
  return null;
}

// ── Structural page checks (URLs and frame URLs, never page wording) ──────────────────────────────────────

/** The browser's own error page for a load that never happened. */
export function isBrowserErrorPage(url: string | null | undefined): boolean {
  return typeof url === "string" && /^chrome-error:\/\//u.test(url);
}

const HUMAN_CHECK_PAGE_RULES: readonly RegExp[] = [
  /^https:\/\/(?:www\.|ipv4\.|ipv6\.)?google\.[a-z.]+\/sorry\//u,
  /^https:\/\/challenges\.cloudflare\.com\//u,
  /\/cdn-cgi\/challenge-platform\//u,
  /^https:\/\/geo\.captcha-delivery\.com\//u,
  /^https:\/\/[^/]*\.(?:arkoselabs|funcaptcha)\.com\//u,
  /^https:\/\/(?:www\.)?(?:recaptcha\.net|google\.com)\/recaptcha\/(?:api2|enterprise)\/bframe/u,
  /^https:\/\/(?:[a-z0-9-]+\.)?hcaptcha\.com\/captcha\//u,
];

/** A visible challenge frame counts; an invisible reCAPTCHA badge (size=invisible) on an ordinary form does not. */
export function isHumanCheckUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || !url) return false;
  if (/[?&#]size=invisible\b/u.test(url)) return false;
  return HUMAN_CHECK_PAGE_RULES.some((rule) => rule.test(url));
}

export function detectHumanCheck(input: { url: string | null | undefined; visibleFrameUrls?: readonly string[] }): boolean {
  if (isHumanCheckUrl(input.url)) return true;
  return (input.visibleFrameUrls ?? []).some((frame) => isHumanCheckUrl(frame)
    || /^https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\//u.test(frame)
    || /^https:\/\/(?:www\.)?(?:recaptcha\.net|google\.com)\/recaptcha\/(?:api2|enterprise)\/anchor/u.test(frame) && !/[?&#]size=invisible\b/u.test(frame));
}

// ── Owner card ────────────────────────────────────────────────────────────────────────────────────────────

export type LadderCardAction = "retry" | "open-browser" | "fix";

export interface LadderOwnerCard {
  code: typeof BROWSER_LADDER_STOP_NOTICE | typeof BROWSER_HUMAN_CHECK_NOTICE;
  reasonCode: string;
  action: LadderCardAction;
  message: { ko: string; en: string };
  /** JSON for the notice's details: machine fields only. */
  details: string;
}

const RUNG_LABEL: Record<LadderRung, { ko: string; en: string }> = {
  "reestablish": { ko: "같은 브라우저 다시 연결", en: "reconnect the same browser" },
  "switch-surface": { ko: "다른 Agentlas 브라우저로 전환", en: "switch to the other Agentlas browser" },
  "login-recovery": { ko: "로그인 복구", en: "login recovery" },
  "connector-alternative": { ko: "사이트 API·커넥터 찾기", en: "look for a site API or connector" },
  "computer-use-dedicated": { ko: "전용 창 화면 조작", en: "computer use on the dedicated window" },
  "human-check-wait": { ko: "사람 확인 대기", en: "wait for the human check" },
  "stop": { ko: "중지", en: "stop" },
};

const FAILURE_LABEL: Record<BrowserFailureCode, { ko: string; en: string }> = {
  "bridge-wire-dropped": { ko: "브라우저 도구 연결이 끊겼습니다", en: "The browser tool connection dropped" },
  "chrome-launch-failed": { ko: "전용 브라우저를 시작하지 못했습니다", en: "The dedicated browser could not start" },
  "chrome-crashed": { ko: "전용 브라우저가 종료됐습니다", en: "The dedicated browser stopped" },
  "ownership-unverifiable": { ko: "전용 브라우저를 확인하지 못했습니다", en: "The dedicated browser could not be verified" },
  "port-foreign": { ko: "브라우저 포트를 다른 프로그램이 쓰고 있습니다", en: "Another program holds the browser port" },
  "native-session-ended": { ko: "앱 안 브라우저 연결이 끝났습니다", en: "The in-app browser session ended" },
  "native-tab-limit": { ko: "앱 안 브라우저 탭이 가득 찼습니다", en: "The in-app browser has no free tab" },
  "native-guest-destroyed": { ko: "앱 안 브라우저 창이 닫혔습니다", en: "The in-app browser window closed" },
  "login-wall": { ko: "사이트 로그인이 필요합니다", en: "The site needs a sign-in" },
  "human-check-required": { ko: "사람 확인이 필요해요", en: "A human check is needed" },
  "page-load-failed": { ko: "페이지가 열리지 않았습니다", en: "The page did not load" },
  "browser-mcp-not-attached": { ko: "이 실행에 브라우저 도구가 붙지 않았습니다", en: "The browser tool was not attached to this run" },
};

export function ladderStopReasonCode(code: BrowserFailureCode): string {
  return code === "human-check-required" ? HUMAN_CHECK_REASON : `browser_ladder_exhausted:${code}`;
}

/** The one owner card: what failed, what was tried, one action. */
export function ladderOwnerCard(input: { code: BrowserFailureCode; tried: readonly LadderTried[]; site?: string | null; suggestions?: readonly string[] }): LadderOwnerCard {
  const failure = FAILURE_LABEL[input.code];
  const reasonCode = ladderStopReasonCode(input.code);
  if (input.code === "human-check-required") {
    const site = input.site ? ` (${input.site})` : "";
    return {
      code: BROWSER_HUMAN_CHECK_NOTICE, reasonCode, action: "open-browser",
      message: {
        ko: `사람 확인이 필요해요${site} — 열린 브라우저에서 한 번 확인해 주시면 자동으로 이어갑니다`,
        en: `A human check is needed${site} — pass it once in the open browser and the run continues on its own`,
      },
      details: JSON.stringify({ schema: BROWSER_LADDER_SCHEMA, reasonCode, action: "open-browser", site: input.site ?? null }),
    };
  }
  const tried = [...new Set(input.tried.filter((t) => t.rung !== "stop").map((t) => t.rung))];
  const triedKo = tried.map((rung) => RUNG_LABEL[rung].ko).join(" → ") || "없음";
  const triedEn = tried.map((rung) => RUNG_LABEL[rung].en).join(" → ") || "nothing";
  const action: LadderCardAction = input.code === "port-foreign" || input.code === "browser-mcp-not-attached" ? "fix" : "retry";
  const suggest = input.suggestions?.length ? input.suggestions.slice(0, 3).join(", ") : "";
  return {
    code: BROWSER_LADDER_STOP_NOTICE, reasonCode, action,
    message: {
      ko: `${failure.ko}. 시도: ${triedKo}.${suggest ? ` 대안 커넥터: ${suggest}.` : ""} ${action === "fix" ? "고치기" : "다시 시도"}를 누르면 이어갑니다`,
      en: `${failure.en}. Tried: ${triedEn}.${suggest ? ` Alternative connectors: ${suggest}.` : ""} Press ${action === "fix" ? "Fix" : "Retry"} to continue`,
    },
    details: JSON.stringify({ schema: BROWSER_LADDER_SCHEMA, reasonCode, action, tried: input.tried.map((t) => ({ rung: t.rung, result: t.result })), site: input.site ?? null, suggestions: input.suggestions ?? [] }),
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────────────

export interface BrowserLadderEvent {
  schemaVersion: typeof BROWSER_LADDER_SCHEMA;
  ladderId: string;
  code: BrowserFailureCode;
  step: "start" | "rung" | "final";
  rung?: LadderRung;
  attempt?: number;
  result?: RungResult;
  surface: BrowserSurface;
  final?: LadderFinal;
  reasonCode?: string;
  detail?: RungOutcome["detail"];
  /** Registrable domain of the page (never a full URL). */
  site?: string | null;
  elapsedMs: number;
}

export interface LadderRunContext {
  ladderId: string;
  code: BrowserFailureCode;
  surface: BrowserSurface;
  site?: string | null;
}

export interface BrowserLadderDeps {
  now(): number;
  record(event: BrowserLadderEvent): void;
  rung(rung: Exclude<LadderRung, "stop">, ctx: LadderRunContext & { attempt: number }): Promise<RungOutcome>;
  /** The single owner card at the end (dedupe is the caller's). */
  stop(card: LadderOwnerCard, ctx: LadderRunContext, state: LadderState): void;
  /** Suggestions collected by the connector rung, shown on the stop card. */
  suggestions?(): readonly string[];
  /** Timer seam for the per-rung time cap (tests pass a fast one). */
  setTimer?(fn: () => void, ms: number): { clear(): void };
}

export interface LadderRunResult { state: LadderState; card: LadderOwnerCard | null }

function withTimeout(promise: Promise<RungOutcome>, ms: number, deps: BrowserLadderDeps): Promise<RungOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const timer = (deps.setTimer ?? ((fn, t) => { const id = setTimeout(fn, t); (id as { unref?: () => void }).unref?.(); return { clear: () => clearTimeout(id) }; }))(() => {
      if (done) return; done = true; resolve({ result: "timeout" });
    }, ms);
    promise.then((value) => { if (done) return; done = true; timer.clear(); resolve(value); },
      () => { if (done) return; done = true; timer.clear(); resolve({ result: "failed", detail: { error: "rung-threw" } }); });
  });
}

export async function runBrowserLadder(ctx: LadderRunContext, deps: BrowserLadderDeps): Promise<LadderRunResult> {
  const startedAt = deps.now();
  let state = startLadder(ctx.code, ctx.surface, startedAt);
  const record = (event: Omit<BrowserLadderEvent, "schemaVersion" | "ladderId" | "code" | "elapsedMs">) => {
    try { deps.record({ schemaVersion: BROWSER_LADDER_SCHEMA, ladderId: ctx.ladderId, code: ctx.code, site: ctx.site ?? null, elapsedMs: deps.now() - startedAt, ...event }); }
    catch { /* recording never blocks recovery */ }
  };
  record({ step: "start", surface: state.surface });
  for (;;) {
    const { rung, attempt } = nextRung(state, deps.now());
    if (rung === "stop") {
      state = applyRungResult(state, "stop", { result: "failed" });
      const card = ladderOwnerCard({ code: ctx.code, tried: state.tried, site: ctx.site, suggestions: deps.suggestions?.() ?? [] });
      record({ step: "final", rung: "stop", surface: state.surface, final: "stopped", reasonCode: card.reasonCode });
      try { deps.stop(card, { ...ctx, surface: state.surface }, state); } catch { /* the card is best effort; the event is recorded */ }
      return { state, card };
    }
    const outcome = await withTimeout(deps.rung(rung, { ...ctx, surface: state.surface, attempt }), LADDER_RUNG_LIMITS[rung].timeoutMs, deps);
    state = applyRungResult(state, rung, outcome);
    record({ step: "rung", rung, attempt, result: outcome.result, surface: state.surface, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    if (state.final) {
      let card: LadderOwnerCard | null = null;
      if (state.final === "waiting-owner" && rung === "human-check-wait") {
        card = ladderOwnerCard({ code: ctx.code, tried: state.tried, site: ctx.site });
      }
      record({ step: "final", rung, surface: state.surface, final: state.final, ...(card ? { reasonCode: card.reasonCode } : {}) });
      return { state, card };
    }
  }
}
