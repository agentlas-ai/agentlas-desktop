// agentlas.cloud 구글 로그인 — 데스크톱 패턴.
//
// 흐름:
//   1. signInWithGoogle()이 호출되면 별도 partition session의 BrowserWindow 띄움
//   2. 사용자가 그 안에서 구글 로그인 → 백엔드(POST /api/auth/google)가 agentlas_session cookie 설정
//   3. did-navigate-in-page / did-frame-finish-load 시점에 partition session.cookies에서 추출
//   4. cookie value를 macOS Keychain(keytar)에 저장
//   5. BrowserWindow 닫고 사용자 메타데이터(userId/workspaceId/email)를 main 메모리에 캐시
//
// 보안:
//   - partition은 영구가 아닌 in-memory 형태 — 윈도우가 닫히면 사라짐 (재로그인 시 새 인증)
//   - 실제 인증값은 Keychain에만. 디스크 직저장 X.
//   - signature 검증은 안 함 — 서버를 신뢰하고 cookie value를 그대로 보관/재첨부
//
// 백엔드 가정:
//   - 세션 cookie 이름: agentlas_session
//   - cookie value 포맷: base64url({ userId, workspaceId, exp }).<HMAC>
//   - 성공 redirect 형태: /account?auth=google (POST /api/auth/google 응답의 redirectTo)
//   - 사용자 메타(email, name) 조회 endpoint: /api/account/me (없으면 cookie payload만 표시)
import { BrowserWindow, session as electronSession, shell } from "electron";
import http from "node:http";
import keytar from "keytar";
import type { AuthSession } from "../shared/types";

const COOKIE_NAME = "agentlas_session";
const KEYTAR_SERVICE = "Agentlas Session";
const KEYTAR_ACCOUNT = "default";
const AUTH_PARTITION = "persist:agentlas-auth";

export function webBaseUrl(): string {
  const fromEnv = process.env.AGENTLAS_WEB_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "https://agentlas.cloud";
}

/** main 메모리에 보관하는 세션 — 디스크는 keytar만, 메타데이터는 매 부팅 시 cookie payload + me endpoint로 재구성 */
interface SessionCache {
  cookieValue: string;
  email?: string;
  name?: string;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
}

let _cache: SessionCache | null = null;

/** cookie value의 body 부분만 base64url decode — signature 검증 안 함 (서버 신뢰). */
function decodeSessionCookie(value: string): {
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
} {
  const dot = value.indexOf(".");
  if (dot < 0) return {};
  const body = value.slice(0, dot);
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const obj = JSON.parse(json) as { userId?: string; workspaceId?: string; exp?: number };
    return {
      userId: obj.userId,
      workspaceId: obj.workspaceId,
      expiresAt: typeof obj.exp === "number" ? obj.exp * 1000 : undefined,
    };
  } catch {
    return {};
  }
}

/** cookie value로 세션 조회 — 실제 엔드포인트는 GET /api/auth/session.
 *  (예전의 /api/account/me 는 웹에 존재하지 않아 404 → 이메일이 영영 안 채워지고
 *   계정 칩이 "?"로 표시되는 버그가 있었다.)
 *  반환: meta | "invalid"(서버가 미인증이라고 답함 — 세션 폐기 대상) | null(네트워크/기타 실패). */
async function fetchAccountMeta(cookieValue: string): Promise<{ email?: string; name?: string } | "invalid" | null> {
  try {
    const url = `${webBaseUrl()}/api/auth/session`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { cookie: `${COOKIE_NAME}=${cookieValue}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null; // 429/5xx 등은 판단 보류 — 다음 시도에서 재확인
      const json = (await res.json()) as {
        authenticated?: boolean;
        user?: { email?: string };
        workspace?: { name?: string };
      };
      if (json.authenticated === false) return "invalid";
      return { email: json.user?.email, name: json.workspace?.name };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 세션은 있는데 이메일이 아직 비어 있으면 백그라운드로 다시 채운다(30초 스로틀).
 *  서버가 "미인증"이라고 답하면 세션을 폐기해 크레딧 위젯/계정 칩 상태가 어긋나지 않게 한다. */
let _metaRefreshAt = 0;
function scheduleMetaRefresh(): void {
  const cache = _cache;
  if (!cache || cache.email) return;
  const now = Date.now();
  if (now - _metaRefreshAt < 30_000) return;
  _metaRefreshAt = now;
  void fetchAccountMeta(cache.cookieValue).then((meta) => {
    if (!_cache || _cache.cookieValue !== cache.cookieValue) return;
    if (meta === "invalid") {
      _cache = null;
      void keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      return;
    }
    if (meta) _cache = { ..._cache, email: meta.email, name: meta.name };
  });
}

/** 부팅 시 keytar에서 cookie를 복원 — TTL이 만료됐으면 null. */
export async function bootAuthFromKeychain(): Promise<void> {
  try {
    const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    if (!stored) return;
    const decoded = decodeSessionCookie(stored);
    if (decoded.expiresAt && decoded.expiresAt < Date.now()) {
      // 만료 — 정리하고 끝.
      await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      return;
    }
    _cache = {
      cookieValue: stored,
      userId: decoded.userId,
      workspaceId: decoded.workspaceId,
      expiresAt: decoded.expiresAt,
    };
    // 이메일/이름은 백그라운드로 fetch (실패해도 무방; 실패 시 getAuthSession 폴링이 재시도)
    scheduleMetaRefresh();
  } catch (err) {
    console.warn("[auth] boot from keychain failed", err);
  }
}

export function getAuthSession(): AuthSession {
  if (!_cache) return { signedIn: false };
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) {
    _cache = null;
    void keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return { signedIn: false };
  }
  scheduleMetaRefresh();
  return {
    signedIn: true,
    email: _cache.email,
    name: _cache.name,
    workspaceId: _cache.workspaceId,
    expiresAt: _cache.expiresAt,
  };
}

/** cookie value를 keytar + 메모리 캐시에 영구화하고 메타를 채운다. 두 로그인 경로(창/브라우저)가 공유. */
async function persistSession(value: string): Promise<AuthSession> {
  try {
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, value);
  } catch (err) {
    console.warn("[auth] keytar set failed — keeping session in memory only", err);
  }
  const decoded = decodeSessionCookie(value);
  _cache = {
    cookieValue: value,
    userId: decoded.userId,
    workspaceId: decoded.workspaceId,
    expiresAt: decoded.expiresAt,
  };
  const meta = await fetchAccountMeta(value);
  if (meta && meta !== "invalid" && _cache) {
    _cache = { ..._cache, email: meta.email, name: meta.name };
  }
  return getAuthSession();
}

/** 마켓플레이스 fetch에 첨부할 cookie 헤더 값 — 미로그인이면 null. */
export function getSessionCookieHeader(): string | null {
  if (!_cache) return null;
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) return null;
  return `${COOKIE_NAME}=${_cache.cookieValue}`;
}

export async function signInWithGoogle(parent: BrowserWindow | null): Promise<AuthSession> {
  const ses = electronSession.fromPartition(AUTH_PARTITION);
  // 로그인 창은 시스템 BrowserWindow — 별도 partition으로 격리해 메인 앱의 쿠키와 섞이지 않음
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    // 비모달 — 메인 앱을 막지 않아 "닫기 못 함" 상황을 방지. 표준 프레임(좌상단 닫기) 유지.
    modal: false,
    closable: true,
    minimizable: true,
    title: "Agentlas — 로그인 (Esc 또는 ⌘W로 닫기)",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 어떤 페이지 상태에서도 확실히 닫을 수 있게: Esc / ⌘W → 창 닫기.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const isEsc = input.key === "Escape";
    const isCmdW = (input.meta || input.control) && input.key.toLowerCase() === "w";
    if (isEsc || isCmdW) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
  });

  const loginUrl = `${webBaseUrl()}/account?desktop=1`;

  return new Promise<AuthSession>((resolve, reject) => {
    let settled = false;

    async function maybeFinish() {
      if (settled) return;
      // cookie를 partition session에서 추출
      const cookies = await ses.cookies.get({ name: COOKIE_NAME });
      if (cookies.length === 0) return;
      // 가장 fresh한 cookie 선택 — expirationDate가 큰 것
      cookies.sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
      const cookie = cookies[0];
      const value = cookie.value;
      settled = true;
      const session = await persistSession(value);
      try {
        win.close();
      } catch {
        // ignore
      }
      resolve(session);
    }

    // 사용자가 그냥 창을 닫으면 reject
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve({ signedIn: false });
      }
    });

    win.webContents.on("did-finish-load", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate-in-page", () => {
      void maybeFinish();
    });

    win.loadURL(loginUrl).catch((err) => {
      if (settled) return;
      settled = true;
      try {
        win.close();
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

/**
 * 시스템 기본 브라우저(이미 로그인된 크롬 등)로 로그인 — 그 브라우저의 기존 세션을 재사용해
 * 가능하면 클릭 한 번으로 끝낸다. loopback(127.0.0.1) 콜백으로 세션 값을 돌려받는다.
 *
 * 흐름:
 *   1. 127.0.0.1의 임의 포트로 임시 http 서버를 띄운다.
 *   2. shell.openExternal로 agentlas.cloud 로그인 페이지를 기본 브라우저에서 연다.
 *      (callback=http://127.0.0.1:<port>/callback 을 쿼리로 전달)
 *   3. 웹앱이 로그인 완료 후 callback?session=<cookie> 로 리다이렉트하면 값을 받아 저장.
 *   4. 180초 내 콜백이 없으면 {signedIn:false} 로 resolve (호출측이 창 로그인으로 폴백).
 *
 * 주의: 끝까지 매끄러우려면 웹앱(agentlas.cloud)이 desktop callback 쿼리를 존중해야 한다.
 *       그렇지 않으면 타임아웃 후 폴백된다 — 안전(기존 동작 비파괴).
 */
export async function signInWithBrowser(): Promise<AuthSession> {
  return new Promise<AuthSession>((resolve) => {
    let settled = false;
    const finish = (session: AuthSession, server?: http.Server) => {
      if (settled) return;
      settled = true;
      try {
        server?.close();
      } catch {
        // ignore
      }
      resolve(session);
    };

    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404).end("not found");
        return;
      }
      const value = url.searchParams.get("session") ?? url.searchParams.get("token") ?? "";
      res.writeHead(value ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(!!value));
      if (!value) return;
      void persistSession(value).then((session) => finish(session, server));
    });

    server.on("error", () => finish({ signedIn: false }));

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish({ signedIn: false }, server);
        return;
      }
      const callback = `http://127.0.0.1:${port}/callback`;
      const loginUrl = `${webBaseUrl()}/account?desktop=1&callback=${encodeURIComponent(callback)}`;
      void shell.openExternal(loginUrl);
      setTimeout(() => finish({ signedIn: false }, server), 180000);
    });
  });
}

function callbackHtml(ok: boolean): string {
  const msg = ok
    ? "Signed in. You can close this tab and return to Agentlas."
    : "Sign-in could not be completed. Please return to Agentlas and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentlas</title></head><body style="font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#1a1a1a"><div style="text-align:center"><h2 style="font-weight:700">Agentlas</h2><p>${msg}</p></div></body></html>`;
}

export async function signOut(): Promise<void> {
  _cache = null;
  try {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } catch (err) {
    console.warn("[auth] keytar delete failed", err);
  }
  // 로그인 partition의 쿠키도 모두 비움 — 다음 signIn 시 깨끗한 상태에서 시작
  try {
    const ses = electronSession.fromPartition(AUTH_PARTITION);
    await ses.clearStorageData({ storages: ["cookies", "localstorage"] });
  } catch (err) {
    console.warn("[auth] clearStorageData failed", err);
  }
}
