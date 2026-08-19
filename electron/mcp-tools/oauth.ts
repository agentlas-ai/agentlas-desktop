// 원격 MCP 서버 OAuth — MCP authorization spec(2025-06-18) 클라이언트.
//
// 왜 필요한가: 지금까지 원격 MCP에 인증하는 길은 "사용자가 어딘가에서 토큰을 발급받아
// 손으로 붙여넣기" 하나뿐이었다. 그런데 카탈로그의 원격 MCP 상당수(Linear, Sentry,
// Atlassian, Asana, ClickUp, monday, Cloudflare, Vercel…)는 OAuth로만 인증한다. 즉
// 화면에는 "연결" 버튼이 있는데 실제로 연결되는 경로가 없었다.
//
// 흐름(스펙 그대로):
//   1. 토큰 없이 요청 → 401 + `WWW-Authenticate: Bearer resource_metadata="…"`
//   2. 그 URL에서 Protected Resource Metadata(RFC 9728) → `authorization_servers`
//   3. AS 메타데이터(RFC 8414) → authorization/token/registration 엔드포인트
//   4. 클라이언트 등록(RFC 7591) — 우리는 사전 등록된 client_id가 없으므로 동적 등록
//   5. PKCE(S256) + `resource`(RFC 8707) 인가 → 127.0.0.1 콜백으로 code 수신
//   6. code → 토큰 교환, 이후 `Authorization: Bearer` 로 사용, 만료 전 refresh
//
// ★ 인가 창은 **Agentlas 전용 Chrome**(브라우저 자격증명이 들어간 그 프로필)으로 연다.
//   이것이 이 모듈의 존재 이유 절반이다: 사용자가 이미 Slack/Notion에 로그인해 둔
//   프로필이므로 로그인 화면이 아니라 동의 화면이 뜨고, 버튼 한 번으로 끝난다.
//   기본 브라우저로 열면 그 로그인을 못 쓰고 사용자는 다시 아이디를 친다.
//
// 경계: 토큰 "값"은 Keychain vault에만 있다. 이 파일은 값을 로그로 내보내지 않고,
// 설정 파일에도 값이 아니라 런타임 alias 참조만 나간다(mcp-config.ts).

import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";

import { deleteSecret, readSecret, setSecret } from "../secrets/vault";
import {
  browserCdpProfilePath,
  ensureBrowserCdpProfilePrivate,
  resolveChromeExe,
} from "./browser-cdp-launcher";

/** 발견·등록·토큰의 만료 없는 부분. 값(토큰)은 별도 시크릿에 둔다. */
export interface McpOAuthSession {
  /** 이 세션이 붙은 MCP 서버의 canonical URI (RFC 8707 resource). */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** 동적 등록이 secret을 준 경우에만. public client면 없다. */
  clientSecret?: string;
  scope?: string;
  /** epoch ms. 만료 전에 갱신한다. refresh 토큰이 없으면 만료 시 재인가가 필요하다. */
  expiresAt?: number;
  obtainedAt: number;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;
/** 사람이 브라우저에서 동의를 마칠 때까지 기다리는 시간. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000;
/** 만료 직전에 미리 갱신하는 여유. 실행 도중 만료돼 호출이 깨지는 것을 막는다. */
const REFRESH_SKEW_MS = 60_000;
const MAX_METADATA_BYTES = 256 * 1024;

function sessionSecretKey(serverId: string): string {
  return `mcp.oauth.session.${serverId}`;
}

function tokenSecretKey(serverId: string): string {
  return `mcp.oauth.token.${serverId}`;
}

/**
 * MCP 서버의 canonical URI (RFC 8707 §2). fragment를 버리고, 의미 없는 끝 슬래시를
 * 떼어 낸다 — 인가 요청과 토큰 요청이 같은 문자열을 보내야 AS가 audience를 맞춘다.
 */
export function canonicalResourceUri(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.username = "";
  url.password = "";
  let out = url.toString();
  if (out.endsWith("/") && url.pathname === "/") out = out.slice(0, -1);
  return out;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("metadata response too large");
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `WWW-Authenticate: Bearer resource_metadata="https://…"` 에서 URL을 뽑는다.
 * 헤더가 없거나 다른 스킴이면 null — 추측해서 만들어내지 않는다.
 */
export function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/resource_metadata\s*=\s*"([^"]+)"/i)
    ?? header.match(/resource_metadata\s*=\s*([^\s,]+)/i);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export interface McpOAuthDiscovery {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

/**
 * 이 서버가 OAuth를 요구하는지, 요구한다면 어디로 가야 하는지.
 *
 * 401이 아니면 `null`을 돌려준다 — "인증이 필요 없다"와 "인증 방법을 모른다"를 같은
 * 값으로 뭉개지 않기 위해, 401인데 메타데이터를 못 찾은 경우는 throw 한다.
 */
export async function discoverMcpOAuth(serverUrl: string): Promise<McpOAuthDiscovery | null> {
  const resource = canonicalResourceUri(serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  let response: Response;
  try {
    // 빈 initialize 시도. 서버는 토큰 없는 요청에 401 + WWW-Authenticate 로 답해야 한다.
    response = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Agentlas Desktop", version: "1" },
      } }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 401 && response.status !== 403) return null;

  const metadataUrl = parseResourceMetadataUrl(response.headers.get("www-authenticate"))
    // 헤더가 없는 서버도 현실에 있다. 스펙이 정한 well-known 위치를 마지막으로 시도하되,
    // 여기서도 못 찾으면 지어내지 않고 실패를 말한다.
    ?? new URL("/.well-known/oauth-protected-resource", resource).toString();

  const resourceMetadata = await fetchJson(metadataUrl, {
    headers: { accept: "application/json" },
  }, DISCOVERY_TIMEOUT_MS) as { authorization_servers?: unknown; scopes_supported?: unknown };

  const servers = Array.isArray(resourceMetadata.authorization_servers)
    ? resourceMetadata.authorization_servers.filter((item): item is string => typeof item === "string")
    : [];
  if (servers.length === 0) {
    throw new Error("protected resource metadata declared no authorization server");
  }

  // 여러 개면 첫 번째. 선택 정책은 스펙 범위 밖이고, 임의로 고르느니 순서를 따른다.
  const asBase = servers[0];
  const asMetadata = await fetchAuthorizationServerMetadata(asBase);

  return {
    resource,
    authorizationEndpoint: asMetadata.authorization_endpoint,
    tokenEndpoint: asMetadata.token_endpoint,
    ...(asMetadata.registration_endpoint ? { registrationEndpoint: asMetadata.registration_endpoint } : {}),
    ...(Array.isArray(resourceMetadata.scopes_supported)
      ? { scopesSupported: resourceMetadata.scopes_supported.filter((s): s is string => typeof s === "string") }
      : {}),
  };
}

interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/**
 * RFC 8414 메타데이터. issuer에 경로가 있으면 well-known 경로를 그 앞에 끼우는 것이
 * 스펙이고, 실제 서버 중에는 OpenID 스타일(`/.well-known/openid-configuration`)만
 * 제공하는 곳도 있어 둘 다 시도한다.
 */
async function fetchAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata> {
  const base = new URL(issuer);
  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, base).toString(),
    new URL(`${path}/.well-known/oauth-authorization-server`, base).toString(),
    new URL(`/.well-known/openid-configuration${path}`, base).toString(),
    new URL(`${path}/.well-known/openid-configuration`, base).toString(),
  ];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const raw = await fetchJson(candidate, { headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS) as
        Record<string, unknown>;
      const authorization = typeof raw.authorization_endpoint === "string" ? raw.authorization_endpoint : "";
      const token = typeof raw.token_endpoint === "string" ? raw.token_endpoint : "";
      if (!authorization || !token) continue;
      return {
        authorization_endpoint: authorization,
        token_endpoint: token,
        ...(typeof raw.registration_endpoint === "string"
          ? { registration_endpoint: raw.registration_endpoint }
          : {}),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `authorization server metadata not found at ${issuer}` +
    (lastError instanceof Error ? ` (${lastError.message})` : ""),
  );
}

/** RFC 7591 동적 등록. 실패해도 흐름을 끝내지 않고 호출자가 판단하도록 throw 한다. */
async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const raw = await fetchJson(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Agentlas Desktop",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  }, TOKEN_TIMEOUT_MS) as Record<string, unknown>;
  const clientId = typeof raw.client_id === "string" ? raw.client_id : "";
  if (!clientId) throw new Error("dynamic client registration returned no client_id");
  return {
    clientId,
    ...(typeof raw.client_secret === "string" ? { clientSecret: raw.client_secret } : {}),
  };
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 인가 URL을 Agentlas 전용 Chrome으로 연다.
 *
 * 이 한 줄이 "이미 로그인돼 있으면 동의만 누르면 된다"를 만든다. 기본 브라우저로 열면
 * 사용자가 Agentlas에 붙여 둔 로그인이 쓰이지 않아, 자격증명을 가져온 의미가 사라진다.
 * Chrome을 못 찾으면 호출자가 URL을 사람에게 보여줄 수 있도록 false를 돌려준다 —
 * 조용히 다른 브라우저로 흘려보내지 않는다.
 */
function openInAgentlasChrome(url: string): boolean {
  const exe = resolveChromeExe();
  if (!exe) return false;
  try {
    ensureBrowserCdpProfilePrivate();
    const child = spawn(exe, [
      `--user-data-dir=${browserCdpProfilePath()}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface McpOAuthAuthorizeResult {
  session: McpOAuthSession;
  /** Chrome을 못 열었을 때 사람이 직접 열도록 돌려주는 URL. 열었으면 null. */
  manualUrl: string | null;
}

/**
 * 인가 코드 흐름 한 판. 콜백을 받을 때까지 기다렸다가 토큰까지 받아 저장한다.
 *
 * 콜백 서버는 127.0.0.1에만 바인딩하고 이 흐름 동안만 산다. state를 검증하지 않으면
 * 다른 탭에서 날아온 응답을 받아들이게 되므로 불일치는 그냥 버린다.
 */
export async function authorizeMcpServer(input: {
  serverId: string;
  serverUrl: string;
  discovery?: McpOAuthDiscovery;
}): Promise<McpOAuthAuthorizeResult> {
  const discovery = input.discovery ?? await discoverMcpOAuth(input.serverUrl);
  if (!discovery) throw new Error("this MCP server did not ask for authorization");

  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    let clientId = "";
    let clientSecret: string | undefined;
    if (discovery.registrationEndpoint) {
      const registered = await registerClient(discovery.registrationEndpoint, redirectUri);
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    } else {
      // 동적 등록이 없는 AS는 사전 등록된 client_id가 필요하다. 우리에게는 없다 —
      // 없는 값을 지어내면 인가 화면이 알 수 없는 오류로 끝나므로, 여기서 정직하게 멈춘다.
      throw new Error(
        "this authorization server requires a pre-registered client (no dynamic registration endpoint)",
      );
    }

    const authorizeUrl = new URL(discovery.authorizationEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    // RFC 8707 — AS가 지원하든 말든 반드시 보낸다(스펙 MUST).
    authorizeUrl.searchParams.set("resource", discovery.resource);
    if (discovery.scopesSupported?.length) {
      authorizeUrl.searchParams.set("scope", discovery.scopesSupported.join(" "));
    }

    const codePromise = waitForAuthorizationCode(server, state);
    const opened = openInAgentlasChrome(authorizeUrl.toString());
    const code = await codePromise;

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: discovery.tokenEndpoint,
      code,
      codeVerifier,
      clientId,
      clientSecret,
      redirectUri,
      resource: discovery.resource,
    });

    const session: McpOAuthSession = {
      resource: discovery.resource,
      authorizationEndpoint: discovery.authorizationEndpoint,
      tokenEndpoint: discovery.tokenEndpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(discovery.scopesSupported?.length ? { scope: discovery.scopesSupported.join(" ") } : {}),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      obtainedAt: Date.now(),
    };
    await persist(input.serverId, session, tokens.tokens);
    return { session, manualUrl: opened ? null : authorizeUrl.toString() };
  } finally {
    server.close();
  }
}

function waitForAuthorizationCode(server: http.Server, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.removeListener("request", onRequest);
      reject(new Error("authorization timed out — the consent window was not completed"));
    }, AUTHORIZE_TIMEOUT_MS);

    function reply(response: http.ServerResponse, message: string): void {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Agentlas</title>` +
        `<body style="font:15px -apple-system,system-ui,sans-serif;padding:48px;text-align:center">` +
        `<p>${message}</p></body>`,
      );
    }

    function onRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      // state가 다르면 이 흐름의 응답이 아니다 — 받아들이면 다른 탭의 코드를 삼킨다.
      if (state !== expectedState) {
        reply(response, "This window does not match the pending Agentlas request.");
        return;
      }
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      if (error) {
        reply(response, "Authorization was refused. You can close this window.");
        reject(new Error(`authorization refused: ${error}`));
        return;
      }
      if (!code) {
        reply(response, "No authorization code was returned. You can close this window.");
        reject(new Error("authorization returned no code"));
        return;
      }
      reply(response, "Connected. You can close this window and go back to Agentlas.");
      resolve(code);
    }

    server.on("request", onRequest);
  });
}

async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resource: string;
}): Promise<{ tokens: StoredTokens; expiresAt?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const raw = await fetchJson(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  }, TOKEN_TIMEOUT_MS) as Record<string, unknown>;
  return readTokenResponse(raw);
}

function readTokenResponse(raw: Record<string, unknown>): { tokens: StoredTokens; expiresAt?: number } {
  const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
  if (!accessToken) throw new Error("token endpoint returned no access_token");
  const expiresIn = Number(raw.expires_in);
  return {
    tokens: {
      accessToken,
      ...(typeof raw.refresh_token === "string" ? { refreshToken: raw.refresh_token } : {}),
    },
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

async function persist(serverId: string, session: McpOAuthSession, tokens: StoredTokens): Promise<void> {
  await setSecret(sessionSecretKey(serverId), JSON.stringify(session));
  await setSecret(tokenSecretKey(serverId), JSON.stringify(tokens));
}

export async function readMcpOAuthSession(serverId: string): Promise<McpOAuthSession | null> {
  const raw = await readSecret(sessionSecretKey(serverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as McpOAuthSession;
  } catch {
    return null;
  }
}

export async function forgetMcpOAuth(serverId: string): Promise<void> {
  await deleteSecret(sessionSecretKey(serverId));
  await deleteSecret(tokenSecretKey(serverId));
}

/**
 * 이 서버에 붙일 access token. 만료가 가까우면 먼저 갱신한다.
 *
 * 갱신에 실패하면 null을 돌려준다 — 만료된 토큰을 그대로 실어 보내면 런타임이
 * 401로 죽고 사용자는 "왜 갑자기 안 되지"를 겪는다. null이면 화면이 "다시 연결"을
 * 말할 수 있다.
 */
export async function resolveMcpOAuthAccessToken(serverId: string): Promise<string | null> {
  const session = await readMcpOAuthSession(serverId);
  if (!session) return null;
  const raw = await readSecret(tokenSecretKey(serverId));
  if (!raw) return null;
  let tokens: StoredTokens;
  try {
    tokens = JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
  const fresh = !session.expiresAt || session.expiresAt - REFRESH_SKEW_MS > Date.now();
  if (fresh) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: session.clientId,
      resource: session.resource,
    });
    if (session.clientSecret) body.set("client_secret", session.clientSecret);
    const rawResponse = await fetchJson(session.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    }, TOKEN_TIMEOUT_MS) as Record<string, unknown>;
    const next = readTokenResponse(rawResponse);
    await persist(serverId, {
      ...session,
      ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
      obtainedAt: Date.now(),
    }, {
      accessToken: next.tokens.accessToken,
      // 회전하지 않는 AS도 있다 — 새 refresh가 없으면 기존 것을 유지한다.
      ...(next.tokens.refreshToken ?? tokens.refreshToken
        ? { refreshToken: next.tokens.refreshToken ?? tokens.refreshToken }
        : {}),
    });
    return next.tokens.accessToken;
  } catch {
    return null;
  }
}
