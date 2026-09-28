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

export const LOGIN_RECOVERY_EVENT_SCHEMA = "agentlas.login-recovery.v1" as const;
/** 도메인당 겨냥 가져오기 간격. 벽이 계속 서도 가져오기가 폭주하지 않게(1.2.47 의 교훈). */
export const LOGIN_RECOVERY_REIMPORT_INTERVAL_MS = 10 * 60 * 1000;

export type LoginRecoveryStep =
  | "detected"
  | "targeted-reimport"
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
  | "recovery-in-flight";

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
  at: string;
}

export interface TargetedImportReport {
  state: "imported" | "not-consented" | "failed" | "unsupported";
  /** 실제로 쓴 쿠키 수(값 없음). */
  written: number;
}

export interface OwnerLoginCard {
  site: string;
  surface: BrowserCookieSurface;
  reason: Extract<LoginRecoveryReason, "source-missing" | "source-expired" | "source-rejected-by-site">;
  signInUrl: string;
  /** 오너에게 보이는 한 줄. */
  message: { ko: string; en: string };
}

/** 한 번의 벽 — 호출자(실행)가 준다. */
export interface LoginRecoveryContext {
  surface: BrowserCookieSurface;
  /** 에이전트가 서 있는 페이지를 다시 읽고, 다시 읽은 뒤의 주소를 돌려준다. */
  reload: () => Promise<string | null>;
  /** 이 실행에 알림을 붙인다(카드 포함). 실행이 끝났으면 아무것도 안 해도 된다. */
  notify?: (card: OwnerLoginCard) => void;
  /** 세션이 돌아왔을 때 목표를 이어 간다. */
  resume?: () => void;
  /** 이 표면에서 로그인 창을 여는 방법(네이티브: 같은 탭에서 로그인 주소). 없으면 deps.openSignIn. */
  openSignIn?: (card: OwnerLoginCard) => Promise<void>;
  runId?: string;
  chatId?: string;
  returnUrl?: string | null;
}

export interface LoginRecoveryDeps {
  now: () => number;
  /** 저장소의 쿠키 메타데이터(이름·도메인·만료). 값은 읽지 않는다. 못 읽으면 null. */
  readStore: (surface: BrowserCookieSurface, domains: readonly string[]) => Promise<CookieMetadata[] | null>;
  /** 원본(평소 크롬) 쿠키 메타데이터. 값은 읽지 않는다. 못 읽으면 null. */
  readSource: (domains: readonly string[]) => Promise<CookieMetadata[] | null>;
  /** 승인 범위 안의 도메인만, 원본이 이기게, 지정한 저장소에 넣는다. */
  targetedImport: (input: { domains: string[]; surface: BrowserCookieSurface }) => Promise<TargetedImportReport>;
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
  | { state: "recovered"; via: "targeted-reimport" | "store-feed"; site: string }
  | { state: "awaiting-owner"; site: string; card: OwnerLoginCard; newCard: boolean }
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
  const ko = input.reason === "source-rejected-by-site"
    ? `${name} 로그인이 크롬에서 가져온 세션으로도 열리지 않습니다 — 이 창에서 한 번 로그인해 주세요`
    : `${name} 로그인이 크롬에도 없습니다 — 이 창에서 한 번 로그인해 주세요`;
  const en = input.reason === "source-rejected-by-site"
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
  /** 열려 있는 카드(사이트 → 카드). 진단용. */
  openCards: () => OwnerLoginCard[];
  dispose: () => void;
}

export function createLoginRecoveryLadder(deps: LoginRecoveryDeps): LoginRecoveryLadder {
  const lastImportAt = new Map<string, number>();
  const pendingCards = new Map<string, { card: OwnerLoginCard; stop: () => void; resumers: Set<() => void> }>();
  const inFlight = new Map<string, Promise<LoginRecoveryOutcome>>();

  const nowSeconds = () => deps.now() / 1_000;
  const event = (
    ctx: LoginRecoveryContext,
    step: LoginRecoveryStep,
    wall: Extract<LoginWallDetection, { kind: "login-wall" }>,
    extra: Partial<LoginRecoveryEvent> = {},
  ) => {
    try {
      deps.record({
        schemaVersion: LOGIN_RECOVERY_EVENT_SCHEMA,
        step,
        site: wall.site,
        surface: ctx.surface,
        targetDomains: wall.targetDomains,
        at: new Date(deps.now()).toISOString(),
        ...extra,
      }, ctx);
    } catch { /* 기록 실패가 복구를 막지 않는다 */ }
  };

  const recheck = async (ctx: LoginRecoveryContext): Promise<boolean> => {
    let url: string | null = null;
    try { url = await ctx.reload(); } catch { return false; }
    return detectLoginWall({ url }).kind !== "login-wall";
  };

  const run = async (
    wall: Extract<LoginWallDetection, { kind: "login-wall" }>,
    ctx: LoginRecoveryContext,
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
    sourceState = evaluateSourceSession(sourceCookies, domains, nowSeconds());
    if (allowed.length === 0) {
      event(ctx, "targeted-reimport", wall, { reason: "rate-limited", sourceSession: sourceState });
    } else if (sourceState === "missing" || sourceState === "expired") {
      // 원본에 가져올 로그인이 없다 — 가져오기는 아무것도 못 고친다. 도메인 시계도 건드리지 않는다.
      event(ctx, "targeted-reimport", wall, { reason: sourceState === "missing" ? "source-missing" : "source-expired", sourceSession: sourceState });
    } else {
      for (const domain of allowed) lastImportAt.set(domain, now);
      let report: TargetedImportReport;
      try { report = await deps.targetedImport({ domains: allowed, surface: ctx.surface }); }
      catch { report = { state: "failed", written: 0 }; }
      const cleared = report.state === "imported" && await recheck(ctx);
      event(ctx, "targeted-reimport", wall, {
        reason: report.state === "not-consented" ? "not-consented"
          : report.state !== "imported" ? "import-failed"
            : cleared ? "cleared" : "still-walled",
        counts: { domains: allowed.length, written: report.written },
        sourceSession: sourceState,
      });
      if (cleared) {
        event(ctx, "recovered", wall, { reason: "cleared" });
        return { state: "recovered", via: "targeted-reimport", site: wall.site };
      }
    }

    // ── 2) 저장소 대조 ───────────────────────────────────────────────
    const counts = {} as Record<BrowserCookieSurface, number>;
    for (const store of STORES) {
      let cookies: CookieMetadata[] | null = null;
      try { cookies = await deps.readStore(store, domains); } catch { cookies = null; }
      counts[store] = sessionCookieCount(cookies, domains, nowSeconds());
    }
    const feed = decideStoreFeed({ surface: ctx.surface, counts });
    event(ctx, "store-check", wall, {
      reason: feed.action === "feed" ? "store-mismatch" : "store-consistent",
      counts: { nativePartition: counts["native-partition"], cdpProfile: counts["cdp-profile"] },
    });
    if (feed.action === "feed") {
      let report: TargetedImportReport;
      try { report = await deps.feedStore({ from: feed.from, to: feed.to, domains }); }
      catch { report = { state: "failed", written: 0 }; }
      const cleared = report.state === "imported" && await recheck(ctx);
      event(ctx, "store-check", wall, {
        reason: cleared ? "cleared" : report.state === "imported" ? "still-walled" : "import-failed",
        counts: { written: report.written },
      });
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
    ctx: LoginRecoveryContext,
    reason: OwnerLoginCard["reason"],
  ): Promise<LoginRecoveryOutcome> => {
    const existing = pendingCards.get(wall.site);
    if (existing) {
      if (ctx.resume) existing.resumers.add(ctx.resume);
      event(ctx, "owner-card", wall, { reason: "card-already-open" });
      return { state: "awaiting-owner", site: wall.site, card: existing.card, newCard: false };
    }
    const card = ownerLoginCardFor({ site: wall.site, surface: ctx.surface, reason, returnUrl: ctx.returnUrl });
    const resumers = new Set<() => void>();
    if (ctx.resume) resumers.add(ctx.resume);
    const since = deps.now();
    let done = false;
    const entry = { card, resumers, stop: () => { /* replaced below */ } };
    pendingCards.set(wall.site, entry);
    entry.stop = deps.watchSession({
      surface: ctx.surface,
      domains: wall.targetDomains,
      since,
      onRestored: () => {
        if (done) return;
        done = true;
        entry.stop();
        if (pendingCards.get(wall.site) === entry) pendingCards.delete(wall.site);
        event(ctx, "session-restored", wall, { counts: { resumers: entry.resumers.size } });
        for (const resume of entry.resumers) {
          try { resume(); } catch { /* 한 목표의 재개 실패가 다른 목표를 막지 않는다 */ }
        }
      },
    });
    event(ctx, "owner-card", wall, { reason });
    try { ctx.notify?.(card); } catch { /* 알림 실패가 카드를 없애지 않는다 */ }
    try { await (ctx.openSignIn ?? deps.openSignIn)(card); } catch { /* 창 열기 실패 — 카드는 남는다 */ }
    return { state: "awaiting-owner", site: wall.site, card, newCard: true };
  };

  return {
    observe: async (url, ctx) => {
      let storeCookies: CookieMetadata[] | null = null;
      const probe = detectLoginWall({ url });
      if (probe.kind !== "login-wall") return { state: "not-a-wall" };
      try { storeCookies = await deps.readStore(ctx.surface, probe.targetDomains); } catch { storeCookies = null; }
      const wall = detectLoginWall({ url, storeCookies, nowSeconds: nowSeconds() }) as Extract<LoginWallDetection, { kind: "login-wall" }>;
      event(ctx, "detected", wall, { sessionCookies: wall.sessionCookies, counts: { rule: wall.rule === "identity-provider" ? 1 : 2 } });
      const card = pendingCards.get(wall.site);
      if (card) {
        if (ctx.resume) card.resumers.add(ctx.resume);
        event(ctx, "owner-card", wall, { reason: "card-already-open" });
        return { state: "awaiting-owner", site: wall.site, card: card.card, newCard: false };
      }
      const flight = inFlight.get(wall.site);
      if (flight) {
        event(ctx, "detected", wall, { reason: "recovery-in-flight" });
        return { state: "in-flight", site: wall.site };
      }
      const next = run(wall, { ...ctx, returnUrl: ctx.returnUrl ?? url ?? null })
        .finally(() => { if (inFlight.get(wall.site) === next) inFlight.delete(wall.site); });
      inFlight.set(wall.site, next);
      return next;
    },
    openCards: () => [...pendingCards.values()].map((entry) => entry.card),
    dispose: () => {
      for (const entry of pendingCards.values()) entry.stop();
      pendingCards.clear();
    },
  };
}
