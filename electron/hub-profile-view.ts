// 허브 소개 페이지 임베드 — agentlas.cloud/p/<slug> 를 앱 안에서 그대로 보여준다.
//
// 왜 미러링이 아니라 임베드인가(2026-08-16 오너 결정): 소개 페이지를 데스크탑에
// 다시 그리면 웹 디자인이 바뀔 때마다 사람이 손으로 맞춰야 한다. 소개는 읽기 전용
// 이라 설치 IPC가 필요 없으므로, 페이지 자체를 띄우는 쪽이 항상 최신이다.
// (설치가 걸린 플러그인 카탈로그는 반대다 — 원격 페이지는 preload가 없어 로컬
//  MCP 설치를 못 하므로 그쪽은 데스크탑 카드가 계속 담당한다.)
//
// WebContentsView는 DOM 위에 떠 있는 별개 표면이다. 그래서 두 규칙을 지킨다:
//  · 렌더러가 준 사각형 밖으로 절대 나가지 않는다(헤더/사이드바를 덮지 않게).
//  · 화면을 떠나면 반드시 파괴한다 — 남으면 다음 화면 위에 유령으로 남는다.
import { BrowserWindow, WebContentsView, session as electronSession, shell } from "electron";
import { getSessionCookieHeader } from "./auth";

const EMBED_PARTITION = "persist:agentlas-hub-profile";

/**
 * 임베드가 앱과 같은 계정으로 보이게 만든다.
 *
 * 이걸 안 하면 임베드는 로그아웃 상태라 웹이 **마케팅 셸**(Product·Pricing·Docs·
 * Back home)과 로그인 카드를 그린다 — 앱은 로그인돼 있는데 안쪽만 "Signed out"이
 * 되는, 2026-08-16 실측에서 나온 그 화면이다.
 * 웹 AppShell은 로그인 상태면 포털 셸로 갈아탄다(AppShell.tsx:115 portalMode),
 * 그래서 쿠키 하나만 넣어 주면 마케팅 내비와 로그인 카드가 통째로 사라진다.
 */
async function primeEmbedSession(locale: "ko" | "en"): Promise<void> {
  const origin = allowedOrigin();
  const store = electronSession.fromPartition(EMBED_PARTITION);
  const header = getSessionCookieHeader();
  const value = header?.includes("=") ? header.slice(header.indexOf("=") + 1) : null;
  const tasks: Array<Promise<unknown>> = [
    // 웹은 이 쿠키로 표시 언어를 정한다(p/[slug]/page.tsx의 agentlas.locale).
    store.cookies.set({ url: origin, name: "agentlas.locale", value: locale, sameSite: "lax" }),
  ];
  if (value) {
    tasks.push(store.cookies.set({
      url: origin,
      name: "agentlas_session",
      value,
      httpOnly: true,
      secure: origin.startsWith("https://"),
      sameSite: "lax",
    }));
  } else {
    // 로그아웃 상태면 남아 있던 쿠키를 지운다 — 앱에서 로그아웃했는데 임베드만
    // 로그인된 채로 남는 편이 더 나쁘다.
    tasks.push(store.cookies.remove(origin, "agentlas_session"));
  }
  await Promise.allSettled(tasks);
}

/**
 * 웹 포털 셸의 사이드바·상단바를 감춘다. 데스크탑이 이미 같은 역할의 사이드바를
 * 그리고 있어, 그대로 두면 내비게이션이 두 겹이 된다.
 *
 * 선택자는 redesign 시스템의 구조 클래스라 문구·디자인이 바뀌어도 남는다.
 * 그래도 사라지면 본문은 그대로 보이고 셸만 다시 나타난다 — 실패해도 빈 화면이
 * 되지 않는 방향으로만 감춘다.
 */
const EMBED_CSS = `
  .portal-shell > .portal-sidebar,
  .portal-shell .portal-sidebar-backdrop,
  .portal-main-column > .portal-topbar { display: none !important; }
  .portal-shell { padding-left: 0 !important; }
  .portal-main-column { padding: 0 !important; }
`;

/** 임베드를 허용하는 오리진. 이 밖으로 가려는 이동은 기본 브라우저로 넘긴다. */
function allowedOrigin(): string {
  const raw = process.env.AGENTLAS_MCP_BASE_URL ?? "https://agentlas.cloud/api/mcp/v1";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://agentlas.cloud";
  }
}

export type HubProfileBounds = { x: number; y: number; width: number; height: number };

type ActiveView = {
  view: WebContentsView;
  window: BrowserWindow;
  slug: string;
};

let active: ActiveView | null = null;
// 열기 요청은 겹친다 — React가 개발 모드에서 효과를 두 번 돌리고, 사용자가 카드를
// 빠르게 연달아 눌러도 겹친다. 두 번째 요청이 같은 webContents에 loadURL을 걸면
// 첫 번째 loadURL이 ERR_ABORTED로 거절되는데, 그 거절을 "실패"로 처리해 뷰를
// 닫아 버리면 **정상적으로 열린 새 뷰가 죽는다**(첫 실측에서 빈 화면 + 오류문구).
// 그래서 순번을 붙여, 추월당한 요청은 아무것도 되돌리지 않고 조용히 물러난다.
let openSequence = 0;

function isSameOrigin(target: string): boolean {
  try {
    return new URL(target).origin === allowedOrigin();
  } catch {
    return false;
  }
}

/** 임베드 안에 머물러도 되는 주소인가 — 공개 소개 페이지만. */
function isProfilePath(target: string): boolean {
  try {
    const url = new URL(target);
    return url.origin === allowedOrigin() && /^\/p\/[a-z0-9][a-z0-9-]*\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function sanitizeBounds(bounds: HubProfileBounds): HubProfileBounds {
  const round = (value: unknown) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n : 0;
  };
  return {
    x: Math.max(0, round(bounds.x)),
    y: Math.max(0, round(bounds.y)),
    // 0 크기 뷰는 Electron에서 "안 보이는 게 아니라 크기 미정"으로 남는다 — 최소 1.
    width: Math.max(1, round(bounds.width)),
    height: Math.max(1, round(bounds.height)),
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function closeHubProfileView(): { ok: true } {
  if (!active) return { ok: true };
  const { view, window } = active;
  active = null;
  try {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
  } catch {
    /* 창이 이미 사라졌으면 제거할 것도 없다 */
  }
  try {
    // 파괴하지 않으면 이 webContents가 살아서 계속 렌더링·네트워크를 돈다.
    view.webContents.close();
  } catch {
    /* already gone */
  }
  return { ok: true };
}

export function setHubProfileViewBounds(bounds: HubProfileBounds): { ok: boolean } {
  if (!active) return { ok: false };
  try {
    active.view.setBounds(sanitizeBounds(bounds));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function openHubProfileView(input: {
  slug: string;
  bounds: HubProfileBounds;
  locale?: "ko" | "en";
}): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const slug = String(input?.slug ?? "").trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: "invalid-slug" };

  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return { ok: false, reason: "no-window" };

  const seq = ++openSequence;
  /** 내가 아직 최신 요청인가. 추월당했으면 상태를 건드리지 않고 물러난다. */
  const current = () => seq === openSequence;

  // 같은 창에서 다른 프로필로 갈아타는 흔한 경우 — 새로 만들지 않고 이동만 한다.
  if (active && active.window === window && !active.view.webContents.isDestroyed()) {
    const url = `${allowedOrigin()}/p/${slug}`;
    active.slug = slug;
    setHubProfileViewBounds(input.bounds);
    try {
      await active.view.webContents.loadURL(url);
      return { ok: true, url };
    } catch (error) {
      // 더 새로운 요청이 이 로드를 중단시킨 것이라면 실패가 아니다 — 그쪽이 주인이다.
      if (!current()) return { ok: true, url };
      closeHubProfileView();
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  } else if (active) {
    closeHubProfileView();
  }

  await primeEmbedSession(input.locale === "en" ? "en" : "ko");

  const view = new WebContentsView({
    webPreferences: {
      // 원격 페이지다 — preload도, Node도, 앱 IPC도 붙이지 않는다.
      // 여기에 window.agentlas를 노출하면 웹 콘텐츠가 로컬 MCP를 설치할 수 있게 된다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 앱 로그인 쿠키와 섞이지 않도록 전용 파티션을 쓴다.
      partition: EMBED_PARTITION,
    },
  });

  // 문서마다 다시 넣는다 — 임베드 안에서 다른 프로필로 이동해도 셸이 되살아나지 않게.
  view.webContents.on("dom-ready", () => {
    void view.webContents.insertCSS(EMBED_CSS).catch(() => undefined);
  });

  const url = `${allowedOrigin()}/p/${slug}`;
  view.setBackgroundColor("#00000000");

  // 임베드 안에 머무를 수 있는 건 소개 페이지뿐이다.
  //  · 다른 소개(/p/…)로 가는 링크 → 그대로 안에서 이동.
  //  · 웹의 다른 화면(예: 페이지 안의 "← Marketplace") → 브라우저를 열지 않고
  //    데스크탑 자기 허브 화면으로 돌려보낸다. 앱 안에서 웹 마켓플레이스가
  //    열리면 같은 화면이 두 벌이 된다.
  //  · 바깥 사이트 → 사용자의 기본 브라우저.
  view.webContents.on("will-navigate", (event, target) => {
    if (isProfilePath(target)) return;
    event.preventDefault();
    if (isSameOrigin(target)) {
      if (!window.isDestroyed()) window.webContents.send("marketplace:profileViewExit");
      return;
    }
    void shell.openExternal(target).catch(() => undefined);
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target).catch(() => undefined);
    return { action: "deny" };
  });

  window.contentView.addChildView(view);
  view.setBounds(sanitizeBounds(input.bounds));
  active = { view, window, slug };

  // 창이 닫히면 뷰도 같이 간다 — 창에 붙은 채로 남으면 다음 창에서 유령이 된다.
  window.once("closed", () => {
    if (active?.window === window) closeHubProfileView();
  });

  try {
    await view.webContents.loadURL(url);
    return { ok: true, url };
  } catch (error) {
    // 추월당한 로드는 실패가 아니다. 여기서 닫으면 새 요청이 막 띄운 뷰가 죽는다.
    if (!current()) return { ok: true, url };
    closeHubProfileView();
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 임베드가 지금 떠 있는가 — 라우트 이탈 시 정리 판단에 쓴다. */
export function hubProfileViewSlug(): string | null {
  return active?.slug ?? null;
}
