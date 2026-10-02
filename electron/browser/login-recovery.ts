/*
 * 로그인 복구 사다리 — 에이전트가 로그인 벽에 섰을 때 오너에게 묻기 전에 제품이 먼저 푼다.
 *
 * 오너 2026-09-28: "쿠키 가져왔는데 안 되는 게 말이 안 됨. 일단 1회 안 되면 로그인도 다 다른 방법을
 * 찾아봐야 함." 이 결정은 예전 기록("전용 창에서 한 번 수동 로그인이 정답")을 대체한다. 1.2.47 의
 * 수리(fcecf95c — 실행마다 강제 가져오기 금지, 더 새 쿠키 덮어쓰기 금지)는 그대로 두고, 여기서는
 * **벽을 만난 그 사이트만** 겨냥해 복구한다.
 *
 * 왜 이런 모양인가 — 실측(오너 기기, 읽기 전용, 이름·만료만):
 *   - 대화 창이 열린 One 실행은 Electron 파티션(persist:agentlas-browser-default)을 쓰고, 창 없는
 *     자동화는 전용 크롬(~/.agentlas/chrome-cdp-profile)을 쓴다. 가져오기는 전용 크롬에만 하루 82회
 *     들어갔고, 파티션은 최초 1회 "이관"(완료 표식) 뒤로 다시 먹지 않았다. 2026-09-27T21:26Z One 실행이
 *     파티션에서 accounts.google.com/v3/signin/accountchooser 에 섰고, 21:28:27 파티션에 새 구글 SID 가
 *     생겼다(= 사람이 그 창에서 직접 로그인). 다음 실행 21:29:27 은 Studio 대시보드에 들어갔다.
 *   - 같은 시각 자동화(전용 크롬)도 21:23:38·21:52:29 에 같은 벽에 섰다. 21:45:18 에 크롬의 새 SID 를
 *     받은 뒤인데도 그랬다 → 쿠키가 "있어도" 벽일 수 있다. 그래서 판정은 주소로 하고, 쿠키는 원인
 *     분류에만 쓴다.
 *
 * 순서(각 단계는 타입 있는 사건으로 남는다 — AGI/진단이 나중에 읽는다):
 *   0) detected      — 주소가 로그인 벽. 저장소의 세션 쿠키 유무를 함께 적는다.
 *   1) targeted-reimport — 그 사이트 + 신원 제공자 도메인만, 에이전트가 **실제로 쓴 저장소**에,
 *                      원본이 이기게(그 도메인에 한해). 3일 주기 안에서도 허용하되 도메인당 N분에 1회.
 *                      다시 읽기 → 재판정.
 *   2) store-check   — 두 저장소의 세션 쿠키 수를 비교. 쓰는 쪽이 비었고 다른 쪽에 있으면 그건 우리
 *                      결함이다 → 쓰는 쪽을 채운다 → 다시 읽기 → 재판정.
 *   3) source-check  — 원본(평소 크롬)의 세션 쿠키가 없거나 만료됐으면 오너가 크롬에서도 로그아웃된
 *                      것이다. 그때, 그리고 그때만 오너에게 **한 번** 묻는다. 원본이 살아 있는데도
 *                      사이트가 거절하면 남은 수단이 없으므로 같은 카드를 다른 사유 코드로 한 번 낸다.
 *   4) owner-card    — 사이트당 하나. 세션이 생기면(이벤트) 목표를 스스로 이어 간다.
 *
 * 안전: 비밀번호·Login Data 는 읽지 않는다. 비밀번호를 치지 않는다. 쿠키 값은 이 파일을 지나지 않는다.
 */
import type {
  BrowserCookieSurface,
  CookieMetadata,
  LoginWallDetection,
  SessionCookieEvidence,
  SourceSessionState,
} from "./login-wall";
import { detectLoginWall, evaluateSessionCookies, evaluateSourceSession, signInUrlFor, siteDisplayName } from "./login-wall";
import { createHash, randomUUID } from "node:crypto";

export const LOGIN_RECOVERY_EVENT_SCHEMA = "agentlas.login-recovery.v1" as const;
/** 도메인당 겨냥 가져오기 간격. 벽이 계속 서도 가져오기가 폭주하지 않게(1.2.47 의 교훈). */
export const LOGIN_RECOVERY_REIMPORT_INTERVAL_MS = 10 * 60 * 1000;

export type LoginRecoveryStep =
  | "detected"
  | "targeted-reimport"
  | "vault-autofill"
  | "store-check"
  | "source-check"
  | "owner-card"
  | "session-restored"
  | "recovered";

export type LoginRecoveryReason =
  | "rate-limited"
  | "not-consented"
  | "source-unreadable"
  | "source-missing"
  | "source-expired"
  | "source-rejected-by-site"
  | "store-mismatch"
  | "store-consistent"
  | "import-failed"
  | "still-walled"
  | "cleared"
  | "card-already-open"
  | "recovery-in-flight"
  | "vault-no-credential"
  | "vault-unavailable"
  | "vault-submitted"
  | "vault-origin-changed"
  | "vault-page-unavailable"
  | "second-factor-required";

export interface LoginRecoveryEvent {
  schemaVersion: typeof LOGIN_RECOVERY_EVENT_SCHEMA;
  step: LoginRecoveryStep;
  site: string;
  surface: BrowserCookieSurface;
  targetDomains: string[];
  reason?: LoginRecoveryReason;
  /** 값 없는 수치만. */
  counts?: Record<string, number>;
  sessionCookies?: SessionCookieEvidence;
  sourceSession?: SourceSessionState;
  prerequisite?: LoginPrerequisiteRef;
  at: string;
}

/**
 * Owner 2026-09-29: "유료작업 빼고 다 하셈". After the cookie import, the owner's own saved credential from the
 * Agentlas autofill vault may complete the sign-in. The fill happens in Main (the model never sees or logs the
 * value); only this state comes back. A one-time-code step is the owner's (second-factor → card).
 */
export interface VaultFillReport {
  state: "submitted" | "no-credential" | "unavailable" | "second-factor" | "failed";
  reason?: "vault-origin-changed" | "vault-page-unavailable";
  /** Page URL after the submit settled (null when unknown). */
  urlAfter?: string | null;
}

export interface TargetedImportReport {
  state: "imported" | "not-consented" | "failed" | "unsupported";
  /** 실제로 쓴 쿠키 수(값 없음). */
  written: number;
}

export interface OwnerLoginCard {
  site: string;
  surface: BrowserCookieSurface;
  reason: Extract<LoginRecoveryReason, "source-missing" | "source-expired" | "source-rejected-by-site" | "second-factor-required">;
  signInUrl: string;
  /** 오너에게 보이는 한 줄. */
  message: { ko: string; en: string };
}

/** 한 번의 벽 — 호출자(실행)가 준다. */
/** Main-owned prerequisite identity. No page URL or credential is an identity. */
export interface LoginPrerequisiteRef {
  prerequisiteId: string;
  runId: string;
  chatId: string;
  nodeId?: string;
  sessionId: string;
  generation: string;
}

export interface LoginRecoveryContext {
  surface: BrowserCookieSurface;
  /** 에이전트가 서 있는 페이지를 다시 읽고, 다시 읽은 뒤의 주소를 돌려준다. */
  reload: () => Promise<string | null>;
  /** 이 실행에 알림을 붙인다(카드 포함). 실행이 끝났으면 아무것도 안 해도 된다. */
  notify?: (card: OwnerLoginCard) => void;
  /** 세션이 돌아왔을 때 목표를 이어 간다. */
  resume?: (prerequisite?: LoginPrerequisiteRef) => void;
  onPrerequisiteRestored?: (prerequisite: LoginPrerequisiteRef) => void;
  retainVerification?: () => { reload: () => Promise<string | null>; current: () => boolean; release: () => void };
  /** 저장된 자격증명으로 Main 에서 채우고 제출한다(값은 이 파일을 지나지 않는다). 없으면 이 단계는 건너뛴다. */
  vaultFill?: (input: { site: string; domains: string[] }) => Promise<VaultFillReport>;
  /** 이 표면에서 로그인 창을 여는 방법(네이티브: 같은 탭에서 로그인 주소). 없으면 deps.openSignIn. */
  openSignIn?: (card: OwnerLoginCard) => Promise<void>;
  runId?: string;
  chatId?: string;
  nodeId?: string;
  /** Main-owned opaque browser/runtime identities, never URLs or cookie values. */
  slotId?: string;
  profileId?: string;
  consentGeneration?: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  /** An owner card's host watcher can outlive its invocation's live browser grant. */
  isPendingCurrent?: () => boolean;
  onPendingScopeReleased?: () => void;
  /** Main's native session is authoritative; never feed it from an alternate CDP profile. */
  canonicalSession?: boolean;
  returnUrl?: string | null;
}

export interface LoginRecoveryDeps {
  now: () => number;
  /** 저장소의 쿠키 메타데이터(이름·도메인·만료). 값은 읽지 않는다. 못 읽으면 null. */
  readStore: (surface: BrowserCookieSurface, domains: readonly string[]) => Promise<CookieMetadata[] | null>;
  /** 원본(평소 크롬) 쿠키 메타데이터. 값은 읽지 않는다. 못 읽으면 null. */
  readSource: (domains: readonly string[]) => Promise<CookieMetadata[] | null>;
  /** 승인 범위 안의 도메인만, 원본이 이기게, 지정한 저장소에 넣는다. */
  targetedImport: (input: { domains: string[]; surface: BrowserCookieSurface; isCurrent?: () => boolean }) => Promise<TargetedImportReport>;
  /** 한 저장소의 쿠키를 다른 저장소로 옮긴다(가져온 쪽이 이긴다). */
  feedStore: (input: { from: BrowserCookieSurface; to: BrowserCookieSurface; domains: string[] }) => Promise<TargetedImportReport>;
  /** 로그인 창을 연다(카드의 동작). */
  openSignIn: (card: OwnerLoginCard) => Promise<void>;
  /**
   * 세션이 생기면 한 번 부르는 구독. 이벤트 기반이어야 한다(분 단위 폴링 금지).
   * 돌려준 함수로 구독을 끊는다.
   */
  watchSession: (input: { surface: BrowserCookieSurface; domains: string[]; since: number; onRestored: () => void }) => () => void;
  record: (event: LoginRecoveryEvent, ctx: LoginRecoveryContext) => void;
}

export type LoginRecoveryOutcome =
  | { state: "not-a-wall" }
  | { state: "recovered"; via: "targeted-reimport" | "vault-autofill" | "store-feed"; site: string }
  | { state: "awaiting-owner"; site: string; card: OwnerLoginCard; newCard: boolean; prerequisite?: LoginPrerequisiteRef }
  | { state: "in-flight"; site: string };

const STORES: readonly BrowserCookieSurface[] = ["native-partition", "cdp-profile"];

function sessionCookieCount(cookies: readonly CookieMetadata[] | null, domains: readonly string[], nowSeconds: number): number {
  if (!cookies) return 0;
  // Count by evaluating each cookie as a store of its own: value-free, name/expiry only.
  let count = 0;
  for (const cookie of cookies) {
    if (evaluateSessionCookies([cookie], [domainOf(cookie)], nowSeconds) === "present"
      && domains.some((domain) => sameSite(domain, domainOf(cookie)))) count += 1;
  }
  return count;
}

function domainOf(cookie: CookieMetadata): string {
  return cookie.domain.replace(/^\./u, "").toLowerCase();
}

function sameSite(a: string, b: string): boolean {
  return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
}

/**
 * 어느 저장소를 무엇으로 채울지 — 순수 판정.
 * 쓰는 쪽에 세션 쿠키가 없고 다른 쪽에 있으면 "다른 쪽 → 쓰는 쪽".
 */
export function decideStoreFeed(input: {
  surface: BrowserCookieSurface;
  counts: Record<BrowserCookieSurface, number>;
}): { action: "feed"; from: BrowserCookieSurface; to: BrowserCookieSurface } | { action: "none" } {
  const other: BrowserCookieSurface = input.surface === "native-partition" ? "cdp-profile" : "native-partition";
  if (input.counts[input.surface] === 0 && input.counts[other] > 0) {
    return { action: "feed", from: other, to: input.surface };
  }
  return { action: "none" };
}

export function ownerLoginCardFor(input: {
  site: string;
  surface: BrowserCookieSurface;
  reason: OwnerLoginCard["reason"];
  returnUrl?: string | null;
}): OwnerLoginCard {
  const name = siteDisplayName(input.site);
  const ko = input.reason === "second-factor-required"
    ? `${name} 로그인에 2단계 인증 코드가 필요합니다 — 이 창에서 코드를 한 번 입력해 주세요`
    : input.reason === "source-rejected-by-site"
      ? `${name} 로그인이 크롬에서 가져온 세션으로도 열리지 않습니다 — 이 창에서 한 번 로그인해 주세요`
      : `${name} 로그인이 크롬에도 없습니다 — 이 창에서 한 번 로그인해 주세요`;
  const en = input.reason === "second-factor-required"
    ? `${name} needs a one-time sign-in code — please enter it once in this window`
    : input.reason === "source-rejected-by-site"
      ? `${name} rejected even the session imported from Chrome — please sign in once in this window`
      : `${name} is not signed in in Chrome either — please sign in once in this window`;
  return {
    site: input.site,
    surface: input.surface,
    reason: input.reason,
    signInUrl: signInUrlFor(input.site, input.returnUrl),
    message: { ko, en },
  };
}

export interface LoginRecoveryLadder {
  /** 에이전트가 방금 도착한 주소를 알려 준다. 벽이 아니면 아무것도 하지 않는다. */
  observe: (url: string | null | undefined, ctx: LoginRecoveryContext) => Promise<LoginRecoveryOutcome>;
  /** 열려 있는 실행/브라우저 범위별 카드. 진단용. */
  openCards: () => OwnerLoginCard[];
  /** Invocation settlement/revocation removes its cards, watchers and observations. */
  releaseScope: (scope: { runId: string; nodeId?: string }) => void;
  dispose: () => void;
}

export function createLoginRecoveryLadder(deps: LoginRecoveryDeps): LoginRecoveryLadder {
  const lastImportAt = new Map<string, number>();
  const pendingCards = new Map<string, { card: OwnerLoginCard; stop: () => void; resumers: Set<(prerequisite?: LoginPrerequisiteRef) => void> }>();
  const inFlight = new Map<string, Promise<LoginRecoveryOutcome>>();
  type Scope = { key: string; base: string; ctx: LoginRecoveryContext; createdAt: number;
    verification?: { reload: () => Promise<string | null>; current: () => boolean; release: () => void }; prerequisite?: LoginPrerequisiteRef; signature?: string; pending: boolean; releasePending?: () => void; closed: boolean; stopAbort: () => void; stopExpiration: () => void };
  const scopes = new Map<string, Scope>();
  type ScopedContext = LoginRecoveryContext & { recoveryScope: Scope };
  const current = (ctx: LoginRecoveryContext) => !ctx.signal?.aborted && (ctx.isCurrent?.() ?? true);
  const pendingCurrent = (ctx: LoginRecoveryContext) => !ctx.signal?.aborted
    && (ctx.isPendingCurrent?.() ?? ctx.isCurrent?.() ?? true);
  const closeScope = (scope: Scope) => {
    scope.closed = true;
    scope.stopAbort();
    scope.stopExpiration();
    try { scope.verification?.release(); } catch { /* cleanup remains unconditional */ }
    scope.verification = undefined;
    if (scopes.get(scope.key) !== scope) return;
    try { pendingCards.get(scope.key)?.stop(); } catch { /* cleanup must remain unconditional */ }
    pendingCards.delete(scope.key);
    inFlight.delete(scope.key);
    scopes.delete(scope.key);
    if (scope.pending) {
      scope.pending = false;
      try { scope.releasePending?.(); } catch { /* host cleanup cannot block scope cleanup */ }
    }
  };
  const scopeFor = (wall: Extract<LoginWallDetection, { kind: "login-wall" }>, ctx: LoginRecoveryContext): Scope => {
    const base = JSON.stringify([ctx.surface, ctx.slotId ?? "default", ctx.profileId ?? "default",
      wall.site, ctx.runId ?? "", ctx.chatId ?? "", ctx.nodeId ?? ""]);
    const key = JSON.stringify([base, ctx.consentGeneration ?? "legacy"]);
    for (const scope of scopes.values()) {
      if (!(pendingCards.has(scope.key) ? pendingCurrent(scope.ctx) : current(scope.ctx))
        || deps.now() - scope.createdAt >= 6 * 60 * 60 * 1000
        || (scope.base === base && scope.key !== key)) closeScope(scope);
    }
    let scope = scopes.get(key);
    if (!scope) {
      // Callers without an invocation signal still cannot accumulate unbounded watchers.
      while (scopes.size >= 128) closeScope(scopes.values().next().value!);
      const generation = randomUUID();
      const prerequisite: LoginPrerequisiteRef | undefined = ctx.runId && ctx.chatId ? {
        prerequisiteId: randomUUID(), runId: ctx.runId, chatId: ctx.chatId,
        ...(ctx.nodeId ? { nodeId: ctx.nodeId } : {}),
        sessionId: createHash("sha256").update(JSON.stringify([ctx.surface, ctx.profileId ?? "default", ctx.consentGeneration ?? "legacy"])).digest("hex"),
        generation,
      } : undefined;
      scope = { key, base, ctx, prerequisite, createdAt: deps.now(), pending: false,
        releasePending: ctx.onPendingScopeReleased, closed: false, stopAbort: () => {}, stopExpiration: () => {} };
      scopes.set(key, scope);
      const owned = scope;
      const expiration = setTimeout(() => closeScope(owned), 6 * 60 * 60 * 1000);
      expiration.unref?.();
      scope.stopExpiration = () => clearTimeout(expiration);
      const abort = () => closeScope(owned);
      ctx.signal?.addEventListener("abort", abort, { once: true });
      scope.stopAbort = () => ctx.signal?.removeEventListener("abort", abort);
    }
    if (ctx.onPendingScopeReleased) scope.releasePending = ctx.onPendingScopeReleased;
    scope.ctx = ctx;
    return scope;
  };
  const observationSignature = (wall: Extract<LoginWallDetection, { kind: "login-wall" }>, rows: CookieMetadata[] | null) =>
    createHash("sha256").update(JSON.stringify([wall.rule, wall.sessionCookies,
      rows === null ? null : rows.map((row) => [row.domain, row.name, row.expires, row.updatedAt ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest("hex");

  const nowSeconds = () => deps.now() / 1_000;
  const event = (
    ctx: LoginRecoveryContext,
    step: LoginRecoveryStep,
    wall: Extract<LoginWallDetection, { kind: "login-wall" }>,
    extra: Partial<LoginRecoveryEvent> = {},
  ) => {
    if (!current(ctx)) return;
    try {
      deps.record({
        schemaVersion: LOGIN_RECOVERY_EVENT_SCHEMA,
        step,
        site: wall.site,
        surface: ctx.surface,
        targetDomains: wall.targetDomains,
        at: new Date(deps.now()).toISOString(),
        ...((ctx as Partial<ScopedContext>).recoveryScope?.prerequisite ? { prerequisite: (ctx as ScopedContext).recoveryScope.prerequisite } : {}),
        ...extra,
      }, ctx);
    } catch { /* 기록 실패가 복구를 막지 않는다 */ }
  };

  const recheck = async (ctx: LoginRecoveryContext, domains: readonly string[]): Promise<boolean> => {
    let url: string | null = null;
    try { url = await ctx.reload(); } catch { return false; }
    if (typeof url !== "string" || !url.trim()) return false;
    try {
      const measured = new URL(url);
      if (!["http:", "https:"].includes(measured.protocol) || !domains.some(domain => sameSite(measured.hostname, domain))) return false;
    } catch { return false; }
    return detectLoginWall({ url }).kind !== "login-wall";
  };

  const run = async (
    wall: Extract<LoginWallDetection, { kind: "login-wall" }>,
    ctx: ScopedContext,
  ): Promise<LoginRecoveryOutcome> => {
    const domains = wall.targetDomains;

    // ── 1) 겨냥 가져오기 ──────────────────────────────────────────────
    const now = deps.now();
    const allowed = domains.filter((domain) => {
      const last = lastImportAt.get(domain);
      return last === undefined || now - last >= LOGIN_RECOVERY_REIMPORT_INTERVAL_MS;
    });
    let sourceCookies: CookieMetadata[] | null = null;
    let sourceState: SourceSessionState = "unknown";
    try { sourceCookies = await deps.readSource(domains); } catch { sourceCookies = null; }
    if (!current(ctx)) return { state: "not-a-wall" };
    sourceState = evaluateSourceSession(sourceCookies, domains, nowSeconds());
    if (allowed.length === 0) {
      event(ctx, "targeted-reimport", wall, { reason: "rate-limited", sourceSession: sourceState });
    } else if (sourceState === "missing" || sourceState === "expired") {
      // 원본에 가져올 로그인이 없다 — 가져오기는 아무것도 못 고친다. 도메인 시계도 건드리지 않는다.
      event(ctx, "targeted-reimport", wall, { reason: sourceState === "missing" ? "source-missing" : "source-expired", sourceSession: sourceState });
    } else {
      for (const domain of allowed) lastImportAt.set(domain, now);
      let report: TargetedImportReport;
      try { report = await deps.targetedImport({ domains: allowed, surface: ctx.surface, isCurrent: () => current(ctx) }); }
      catch { report = { state: "failed", written: 0 }; }
      if (!current(ctx)) return { state: "not-a-wall" };
      const cleared = report.state === "imported" && await recheck(ctx, wall.targetDomains);
      event(ctx, "targeted-reimport", wall, {
        reason: report.state === "not-consented" ? "not-consented"
          : report.state !== "imported" ? "import-failed"
            : cleared ? "cleared" : "still-walled",
        counts: { domains: allowed.length, written: report.written },
        sourceSession: sourceState,
      });
      if (!current(ctx)) return { state: "not-a-wall" };
      if (cleared) {
        event(ctx, "recovered", wall, { reason: "cleared" });
        return { state: "recovered", via: "targeted-reimport", site: wall.site };
      }
    }

    // ── 1b) 저장된 자격증명(오너 금고) — Main 에서 채우고 제출, 모델은 값을 모른다 ──────────
    if (ctx.vaultFill) {
      if (!current(ctx)) return { state: "not-a-wall" };
      let report: VaultFillReport;
      try { report = await ctx.vaultFill({ site: wall.site, domains }); }
      catch { report = { state: "failed" }; }
      if (!current(ctx)) return { state: "not-a-wall" };
      const cleared = report.state === "submitted" && typeof report.urlAfter === "string"
        && detectLoginWall({ url: report.urlAfter }).kind !== "login-wall";
      event(ctx, "vault-autofill", wall, {
        reason: report.state === "no-credential" ? "vault-no-credential"
          : report.state === "unavailable" ? "vault-unavailable"
            : report.state === "second-factor" ? "second-factor-required"
              : report.state === "failed" ? report.reason ?? "import-failed"
                : cleared ? "cleared" : "vault-submitted",
      });
      if (!current(ctx)) return { state: "not-a-wall" };
      if (cleared) {
        event(ctx, "recovered", wall, { reason: "cleared" });
        return { state: "recovered", via: "vault-autofill", site: wall.site };
      }
      if (report.state === "second-factor") return openCard(wall, ctx, "second-factor-required");
    }

    // ── 2) 저장소 대조 ───────────────────────────────────────────────
    const counts = {} as Record<BrowserCookieSurface, number>;
    for (const store of STORES) {
      if (!current(ctx)) return { state: "not-a-wall" };
      if (ctx.canonicalSession && store !== ctx.surface) { counts[store] = 0; continue; }
      let cookies: CookieMetadata[] | null = null;
      try { cookies = await deps.readStore(store, domains); } catch { cookies = null; }
      counts[store] = sessionCookieCount(cookies, domains, nowSeconds());
    }
    const feed = ctx.canonicalSession ? { action: "none" as const } : decideStoreFeed({ surface: ctx.surface, counts });
    event(ctx, "store-check", wall, {
      reason: feed.action === "feed" ? "store-mismatch" : "store-consistent",
      counts: ctx.canonicalSession ? { nativePartition: counts["native-partition"] }
        : { nativePartition: counts["native-partition"], cdpProfile: counts["cdp-profile"] },
    });
    if (feed.action === "feed") {
      if (!current(ctx)) return { state: "not-a-wall" };
      let report: TargetedImportReport;
      try { report = await deps.feedStore({ from: feed.from, to: feed.to, domains }); }
      catch { report = { state: "failed", written: 0 }; }
      if (!current(ctx)) return { state: "not-a-wall" };
      const cleared = report.state === "imported" && await recheck(ctx, wall.targetDomains);
      event(ctx, "store-check", wall, {
        reason: cleared ? "cleared" : report.state === "imported" ? "still-walled" : "import-failed",
        counts: { written: report.written },
      });
      if (!current(ctx)) return { state: "not-a-wall" };
      if (cleared) {
        event(ctx, "recovered", wall, { reason: "cleared" });
        return { state: "recovered", via: "store-feed", site: wall.site };
      }
    }

    // ── 3) 원본 확인 ─────────────────────────────────────────────────
    const reason: OwnerLoginCard["reason"] = sourceState === "missing" ? "source-missing"
      : sourceState === "expired" ? "source-expired"
        : "source-rejected-by-site";
    event(ctx, "source-check", wall, {
      reason: sourceCookies === null ? "source-unreadable" : reason,
      sourceSession: sourceState,
    });

    // ── 4) 오너 카드(사이트당 한 번) ──────────────────────────────────
    return openCard(wall, ctx, reason);
  };

  const openCard = async (
    wall: Extract<LoginWallDetection, { kind: "login-wall" }>,
    ctx: ScopedContext,
    reason: OwnerLoginCard["reason"],
  ): Promise<LoginRecoveryOutcome> => {
    if (!current(ctx)) return { state: "not-a-wall" };
    const key = ctx.recoveryScope.key;
    const existing = pendingCards.get(key);
    if (existing) {
      if (ctx.resume) { existing.resumers.clear(); existing.resumers.add(ctx.resume); }
      event(ctx, "owner-card", wall, { reason: "card-already-open" });
      return { state: "awaiting-owner", site: wall.site, card: existing.card, newCard: false, ...(ctx.recoveryScope.prerequisite ? { prerequisite: ctx.recoveryScope.prerequisite } : {}) };
    }
    const card = ownerLoginCardFor({ site: wall.site, surface: ctx.surface, reason, returnUrl: ctx.returnUrl });
    const resumers = new Set<(prerequisite?: LoginPrerequisiteRef) => void>();
    if (ctx.resume) resumers.add(ctx.resume);
    const since = deps.now();
    if (ctx.retainVerification) {
      try { ctx.recoveryScope.verification = ctx.retainVerification(); } catch { /* unavailable verification cannot claim restoration */ }
    }
    let done = false;
    const entry = { card, resumers, stop: () => { /* replaced below */ } };
    ctx.recoveryScope.pending = true;
    pendingCards.set(key, entry);
    let checking: Promise<void> | null = null;
    const arm = () => {
      if (done || !pendingCurrent(ctx)) return;
      entry.stop();
      entry.stop = deps.watchSession({ surface: ctx.surface, domains: wall.targetDomains, since,
        onRestored: () => {
          if (done) return;
          if (checking) return;
          checking = (async () => {
            if (!pendingCurrent(ctx)) { closeScope(ctx.recoveryScope); return; }
            const verification = ctx.recoveryScope.verification;
            if (ctx.retainVerification && (!verification || !verification.current())) { closeScope(ctx.recoveryScope); return; }
            const cleared = await recheck(verification ? { ...ctx, reload: verification.reload } : ctx, wall.targetDomains);
            if (verification && !verification.current()) { closeScope(ctx.recoveryScope); return; }
            if (!pendingCurrent(ctx)) { closeScope(ctx.recoveryScope); return; }
            if (!cleared) return;
            done = true;
            entry.stop();
            if (pendingCards.get(key) === entry) pendingCards.delete(key);
            event({ ...ctx, isCurrent: () => pendingCurrent(ctx) }, "session-restored", wall,
              { counts: { resumers: entry.resumers.size } });
            const prerequisite = ctx.recoveryScope.prerequisite;
            if (prerequisite) {
              try { ctx.recoveryScope.ctx.onPrerequisiteRestored?.(prerequisite); } catch { /* consumers cannot invalidate restoration */ }
            }
            for (const resume of entry.resumers) {
              try { resume(prerequisite); } catch { /* one goal cannot strand another */ }
            }
            closeScope(ctx.recoveryScope);
          })().finally(() => {
            checking = null;
            // Re-arm once after a failed verification, disposing the previous watcher.
            if (!done && pendingCurrent(ctx)) arm();
          });
        },
      });
      if (done) entry.stop();
    };
    arm();
    if (done) entry.stop();
    if (!current(ctx)) return { state: "not-a-wall" };
    event(ctx, "owner-card", wall, { reason });
    try { ctx.notify?.(card); } catch { /* 알림 실패가 카드를 없애지 않는다 */ }
    try { await (ctx.openSignIn ?? deps.openSignIn)(card); } catch { /* 창 열기 실패 — 카드는 남는다 */ }
    return done || !pendingCurrent(ctx) ? { state: "not-a-wall" }
      : { state: "awaiting-owner", site: wall.site, card, newCard: true, ...(ctx.recoveryScope.prerequisite ? { prerequisite: ctx.recoveryScope.prerequisite } : {}) };
  };

  return {
    observe: async (url, ctx) => {
      if (!current(ctx)) {
        for (const scope of scopes.values()) {
          if (!(pendingCards.has(scope.key) ? pendingCurrent(scope.ctx) : current(scope.ctx))) closeScope(scope);
        }
        return { state: "not-a-wall" };
      }
      let storeCookies: CookieMetadata[] | null = null;
      const probe = detectLoginWall({ url });
      if (probe.kind !== "login-wall") {
        for (const scope of scopes.values()) {
          if (scope.ctx.surface === ctx.surface && scope.ctx.slotId === ctx.slotId && scope.ctx.profileId === ctx.profileId
            && scope.ctx.runId === ctx.runId && scope.ctx.chatId === ctx.chatId && scope.ctx.nodeId === ctx.nodeId) closeScope(scope);
        }
        return { state: "not-a-wall" };
      }
      const scope = scopeFor(probe, ctx);
      const scoped: ScopedContext = { ...ctx, recoveryScope: scope,
        isCurrent: () => !scope.closed && current(ctx),
        isPendingCurrent: () => !scope.closed && pendingCurrent(ctx) };
      try { storeCookies = await deps.readStore(ctx.surface, probe.targetDomains); } catch { storeCookies = null; }
      if (!current(scoped)) { closeScope(scope); return { state: "not-a-wall" }; }
      const wall = detectLoginWall({ url, storeCookies, nowSeconds: nowSeconds() }) as Extract<LoginWallDetection, { kind: "login-wall" }>;
      const signature = observationSignature(wall, storeCookies);
      const unchanged = scope.signature === signature;
      scope.signature = signature;
      const card = pendingCards.get(scope.key);
      if (card) {
        if (ctx.resume) { card.resumers.clear(); card.resumers.add(ctx.resume); }
        if (!unchanged) {
          event(scoped, "detected", wall, { sessionCookies: wall.sessionCookies, counts: { rule: wall.rule === "identity-provider" ? 1 : 2 } });
          event(scoped, "owner-card", wall, { reason: "card-already-open" });
        }
        return { state: "awaiting-owner", site: wall.site, card: card.card, newCard: false, ...(scope.prerequisite ? { prerequisite: scope.prerequisite } : {}) };
      }
      const flight = inFlight.get(scope.key);
      if (flight) {
        if (ctx.onPendingScopeReleased) scope.pending = true;
        if (!unchanged) event(scoped, "detected", wall, { reason: "recovery-in-flight" });
        const outcome = await flight;
        return outcome.state === "awaiting-owner" ? { ...outcome, newCard: false } : outcome;
      }
      event(scoped, "detected", wall, { sessionCookies: wall.sessionCookies, counts: { rule: wall.rule === "identity-provider" ? 1 : 2 } });
      const next = run(wall, { ...scoped, returnUrl: ctx.returnUrl ?? url ?? null })
        .finally(() => {
          if (inFlight.get(scope.key) === next) inFlight.delete(scope.key);
          if (!pendingCards.has(scope.key)) closeScope(scope);
        });
      inFlight.set(scope.key, next);
      return next;
    },
    openCards: () => [...pendingCards.values()].map((entry) => entry.card),
    releaseScope: (input) => {
      for (const scope of scopes.values()) if (scope.ctx.runId === input.runId
        && (input.nodeId === undefined || scope.ctx.nodeId === input.nodeId)) closeScope(scope);
    },
    dispose: () => {
      for (const scope of scopes.values()) closeScope(scope);
      lastImportAt.clear();
    },
  };
}
