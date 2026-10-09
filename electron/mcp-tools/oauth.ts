// 원격 MCP 서버 OAuth — MCP authorization spec(2026-07-28) 클라이언트.
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
//   4. issuer에 바인딩된 사전 등록 → HTTPS Client ID Metadata Document → 동적 등록
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
import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

import { deleteSecret, readSecret, setSecret } from "../secrets/vault";
import {
  browserCdpPort,
  browserCdpPortReady,
  browserCdpProfilePath,
  ensureBrowserCdpProfilePrivate,
  reconcileBrowserCdpOwnerWithRetry,
  resolveChromeExe,
  scheduleBrowserCdpGuardian,
  withBrowserCdpMaintenance,
} from "./browser-cdp-launcher";

/** 발견·등록·토큰의 만료 없는 부분. 값(토큰)은 별도 시크릿에 둔다. */
export interface McpOAuthSession {
  /** 이 세션이 붙은 MCP 서버의 canonical URI (RFC 8707 resource). */
  resource: string;
  /** 새 세션은 issuer에 바인딩한다. 기존 vault 세션은 그대로 읽을 수 있다. */
  issuer?: string;
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
/** The SDK's LATEST_PROTOCOL_VERSION denotes its legacy default; modern uses discovery. */
const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_OAUTH_CLIENT_METADATA_URL = "https://agentlas.cloud/oauth/desktop-client-metadata.json";
/** Hosted metadata declares this exact native redirect; DCR still uses an ephemeral port. */
export const MCP_OAUTH_CIMD_REDIRECT_URI = "http://127.0.0.1:27843/callback";

function secureOAuthUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("OAuth URLs require HTTPS (HTTP is allowed only on loopback)");
  }
  return url;
}

/** A resource can cover its endpoint's ancestor path, but never a different origin. */
function resourceMatchesServer(resource: string, serverUrl: string): boolean {
  const configured = secureOAuthUrl(resource);
  const requested = secureOAuthUrl(serverUrl);
  const path = (value: string) => value.endsWith("/") ? value : `${value}/`;
  return requested.origin === configured.origin && path(requested.pathname).startsWith(path(configured.pathname)) &&
    (!configured.search || configured.search === requested.search);
}

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
  secureOAuthUrl(url.toString());
  let out = url.toString();
  if (out.endsWith("/") && url.pathname === "/") out = out.slice(0, -1);
  return out;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  secureOAuthUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("metadata response too large");
    }
    if (!response.ok) {
      // Endpoint bodies may contain credentials or codes. Never echo them to the UI/logs.
      throw new Error(`OAuth endpoint returned HTTP ${response.status}`);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * `WWW-Authenticate: Bearer resource_metadata="https://…"` 에서 URL을 뽑는다.
 * 헤더가 없거나 다른 스킴이면 null — 추측해서 만들어내지 않는다.
 */
export function parseResourceMetadataUrl(header: string | null): string | null {
  const raw = bearerChallengeParameter(header, "resource_metadata");
  if (!raw) return null;
  try {
    return secureOAuthUrl(raw).toString();
  } catch {
    return null;
  }
}

function bearerChallengeParameter(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  // Commas inside quoted strings are not challenge separators (RFC 9110).
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      segments.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) return undefined;
  segments.push(header.slice(start).trim());
  const parameters: string[] = [];
  let bearer = false;
  for (const segment of segments) {
    const scheme = segment.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(?![=\s])(.+)$/);
    if (scheme) {
      if (bearer) break;
      bearer = scheme[1].toLowerCase() === "bearer";
      if (bearer) parameters.push(scheme[2]);
    } else if (bearer) parameters.push(segment);
  }
  const match = parameters.join(",").match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^\\s,]+))`, "i"));
  return (match?.[1]?.replace(/\\(.)/g, "$1") ?? match?.[2])?.trim();
}

export interface McpOAuthDiscovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  /** The Bearer challenge's scope takes precedence over advertised default scopes. */
  scope?: string;
  clientIdMetadataDocumentSupported?: boolean;
  authorizationResponseIssuerSupported?: boolean;
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
    const probe = (method: "server/discover" | "initialize") => fetch(serverUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": method === "server/discover" ? MODERN_PROTOCOL_VERSION : LATEST_PROTOCOL_VERSION,
        ...(method === "server/discover" ? { "Mcp-Method": method } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "server/discover" ? {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "Agentlas Desktop", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      } : { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Agentlas Desktop", version: "1" } } }),
      signal: controller.signal,
    });
    response = await probe("server/discover");
    // Authentication walls are not protocol-era evidence. Only an explicit
    // JSON-RPC method-not-found reply permits the legacy initialize probe.
    if (response.status !== 401 && response.status !== 403 &&
        (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json") {
      const body = await response.clone().text();
      if (Buffer.byteLength(body, "utf8") <= MAX_METADATA_BYTES) {
        try {
          const reply = JSON.parse(body) as { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown } };
          if (reply.jsonrpc === "2.0" && reply.id === 1 && reply.error?.code === METHOD_NOT_FOUND) {
            response = await probe("initialize");
          }
        } catch { /* An unusable reply does not identify a legacy server. */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 401 && response.status !== 403) return null;

  const challenge = response.headers.get("www-authenticate");
  const metadataUrl = parseResourceMetadataUrl(challenge);
  // Without an advertised URL, try the resource path and then the origin root.
  if (bearerChallengeParameter(challenge, "resource_metadata") && !metadataUrl) {
    throw new Error("invalid protected resource metadata URL");
  }
  const resourceUrl = new URL(resource);
  const metadataCandidates = metadataUrl ? [metadataUrl] : [
    new URL(`/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`, resource).toString(),
    new URL("/.well-known/oauth-protected-resource", resource).toString(),
  ];
  let resourceMetadata: Record<string, unknown> | undefined;
  for (const candidate of new Set(metadataCandidates)) {
    try {
      const raw = await fetchJson(candidate, { headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS) as Record<string, unknown>;
      if (typeof raw.resource !== "string" || !resourceMatchesServer(raw.resource, resource)) {
        throw new Error("protected resource metadata resource does not match MCP server");
      }
      resourceMetadata = raw;
      break;
    } catch (error) {
      if (metadataUrl || candidate === metadataCandidates[metadataCandidates.length - 1]) throw error;
    }
  }
  if (!resourceMetadata) throw new Error("protected resource metadata not found");

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
    // Preserve the advertised resource string exactly; the AS may compare it verbatim.
    resource: resourceMetadata.resource as string,
    issuer: asMetadata.issuer,
    authorizationEndpoint: asMetadata.authorization_endpoint,
    tokenEndpoint: asMetadata.token_endpoint,
    ...(asMetadata.registration_endpoint ? { registrationEndpoint: asMetadata.registration_endpoint } : {}),
    ...(Array.isArray(resourceMetadata.scopes_supported)
      ? { scopesSupported: resourceMetadata.scopes_supported.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(bearerChallengeParameter(challenge, "scope") !== undefined
      ? { scope: bearerChallengeParameter(challenge, "scope") } : {}),
    clientIdMetadataDocumentSupported: asMetadata.client_id_metadata_document_supported === true,
    authorizationResponseIssuerSupported: asMetadata.authorization_response_iss_parameter_supported === true,
  };
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
}

/**
 * RFC 8414 메타데이터. issuer에 경로가 있으면 well-known 경로를 그 앞에 끼우는 것이
 * 스펙이고, 실제 서버 중에는 OpenID 스타일(`/.well-known/openid-configuration`)만
 * 제공하는 곳도 있어 둘 다 시도한다.
 */
async function fetchAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata> {
  const base = secureOAuthUrl(issuer);
  if (base.search) throw new Error("authorization server issuer must not contain a query");
  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, base).toString(),
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
      if (raw.issuer !== issuer) throw new Error("authorization server metadata issuer mismatch");
      if (!Array.isArray(raw.code_challenge_methods_supported) || !raw.code_challenge_methods_supported.includes("S256")) {
        throw new Error("authorization server must advertise PKCE S256 support");
      }
      secureOAuthUrl(authorization);
      secureOAuthUrl(token);
      if (typeof raw.registration_endpoint === "string") secureOAuthUrl(raw.registration_endpoint);
      return {
        issuer,
        authorization_endpoint: authorization,
        token_endpoint: token,
        ...(typeof raw.registration_endpoint === "string"
          ? { registration_endpoint: raw.registration_endpoint }
          : {}),
        client_id_metadata_document_supported: raw.client_id_metadata_document_supported === true,
        authorization_response_iss_parameter_supported: raw.authorization_response_iss_parameter_supported === true,
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

export interface McpOAuthPreRegisteredClient {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

function loopbackRedirect(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.pathname !== "/callback" || url.search || url.hash || url.username || url.password) {
    throw new Error("OAuth client redirect must be an explicit http://127.0.0.1:port/callback URI");
  }
  return url;
}

async function metadataDocumentClient(rawUrl: string): Promise<{ clientId: string; redirectUri: string }> {
  const url = secureOAuthUrl(rawUrl);
  if (url.protocol !== "https:" || url.pathname === "/") {
    throw new Error("client metadata document URL requires HTTPS and a path");
  }
  const metadata = await fetchJson(rawUrl, { headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS) as Record<string, unknown>;
  if (metadata.client_id !== rawUrl || typeof metadata.client_name !== "string" || !metadata.client_name.trim() ||
      metadata.token_endpoint_auth_method !== "none" || !Array.isArray(metadata.redirect_uris)) {
    throw new Error("client metadata document must declare matching client_id, name, redirects, and public authentication");
  }
  // Use exactly a hosted URI; never assume an AS ignores native redirect ports.
  const redirectUri = metadata.redirect_uris.find((item): item is string => {
    if (typeof item !== "string") return false;
    try { loopbackRedirect(item); return true; } catch { return false; }
  });
  if (!redirectUri) throw new Error("client metadata document declares no supported loopback redirect");
  return { clientId: rawUrl, redirectUri };
}

/**
 * 인가 URL을 Agentlas 전용 Chrome으로 연다.
 *
 * 이 한 줄이 "이미 로그인돼 있으면 동의만 누르면 된다"를 만든다. 기본 브라우저로 열면
 * 사용자가 Agentlas에 붙여 둔 로그인이 쓰이지 않아, 자격증명을 가져온 의미가 사라진다.
 * Chrome을 못 찾으면 호출자가 URL을 사람에게 보여줄 수 있도록 false를 돌려준다 —
 * 조용히 다른 브라우저로 흘려보내지 않는다.
 */
async function openInAgentlasChrome(url: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const exe = resolveChromeExe();
  if (!exe) return false;
  try {
    await withBrowserCdpMaintenance(async () => {
      signal?.throwIfAborted();
      ensureBrowserCdpProfilePrivate();
      const child = spawn(exe, [
        `--user-data-dir=${browserCdpProfilePath()}`,
        `--remote-debugging-port=${browserCdpPort()}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session=false",
        "--disable-session-crashed-bubble",
        "--new-window",
        url,
      ], { detached: true, stdio: "ignore" });
      child.unref();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        signal?.throwIfAborted();
        if (await browserCdpPortReady()) {
          const ownership = await reconcileBrowserCdpOwnerWithRetry({ attempts: 2, delayMs: 50 });
          if (ownership.state === "owned" && ownership.pid) {
            scheduleBrowserCdpGuardian(ownership.pid);
            return;
          }
          if (ownership.state === "foreign") {
            throw new Error(`OAuth browser ownership verification failed (${ownership.reason}).`);
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("OAuth browser did not become ready.");
    });
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
export type McpOAuthAuthorizationInput = {
  serverId: string;
  serverUrl: string;
  discovery?: McpOAuthDiscovery;
  /** Explicitly bound credentials take precedence. No provider credentials are built in. */
  preRegisteredClient?: McpOAuthPreRegisteredClient;
  /** Public deployment override; the remote document must identify this exact URL. */
  clientMetadataUrl?: string;
};
export type McpOAuthAuthorizationStatus = {
  status: "waiting" | "exchanging" | "connected" | "failed" | "cancelled" | "unknown";
  error?: string;
};

interface AuthorizationAttempt {
  serverId: string;
  attemptId: string;
  status: McpOAuthAuthorizationStatus["status"];
  error?: string;
  controller: AbortController;
  server: http.Server;
  completion: Promise<McpOAuthAuthorizeResult>;
  finishedAt?: number;
  cleanupFailed?: boolean;
}
const authorizationAttempts = new Map<string, AuthorizationAttempt>();
const activeAuthorizations = new Map<string, AuthorizationAttempt>();
const startingAuthorizations = new Set<string>();

function pruneAuthorizationAttempts(): void {
  for (const [id, attempt] of authorizationAttempts) {
    if (attempt.finishedAt && Date.now() - attempt.finishedAt > 10 * 60_000) authorizationAttempts.delete(id);
  }
  if (authorizationAttempts.size > 256) {
    for (const [id, attempt] of authorizationAttempts) {
      if (attempt.finishedAt) authorizationAttempts.delete(id);
      if (authorizationAttempts.size <= 256) break;
    }
  }
}

async function closeAuthorizationCallback(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

/** Restore the previous pair if cancellation or a failed write interrupts persistence. */
async function persistAuthorization(attempt: AuthorizationAttempt, session: McpOAuthSession, tokens: StoredTokens): Promise<void> {
  const signal = attempt.controller.signal;
  const keys = [sessionSecretKey(attempt.serverId), tokenSecretKey(attempt.serverId)];
  const previous = await Promise.all(keys.map((key) => readSecret(key)));
  signal.throwIfAborted();
  try {
    await setSecret(keys[0], JSON.stringify(session));
    signal.throwIfAborted();
    await setSecret(keys[1], JSON.stringify(tokens));
    signal.throwIfAborted();
  } catch (error) {
    // Retry stays locked until these writes settle, so rollback cannot overwrite a new attempt.
    const restored = await Promise.allSettled(keys.map(async (key, index) => {
      if (previous[index] == null) await deleteSecret(key);
      else await setSecret(key, previous[index]!);
    }));
    if (restored.some((result) => result.status === "rejected")) {
      attempt.cleanupFailed = true;
      throw new Error("OAuth credential cleanup failed; reconnect after checking secure storage.");
    }
    throw error;
  }
}

async function beginMcpOAuthAuthorization(input: McpOAuthAuthorizationInput): Promise<{ attempt: AuthorizationAttempt; manualUrl: string }> {
  pruneAuthorizationAttempts();
  if (startingAuthorizations.has(input.serverId) || activeAuthorizations.has(input.serverId)) {
    throw new Error("OAuth authorization is already pending for this server; cancel that attempt before retrying");
  }
  startingAuthorizations.add(input.serverId);
  let server: http.Server | undefined;
  let handedOff = false;
  try {
    const discovery = input.discovery ?? await discoverMcpOAuth(input.serverUrl);
    if (!discovery) throw new Error("this MCP server did not ask for authorization");
    secureOAuthUrl(discovery.issuer);
    secureOAuthUrl(discovery.authorizationEndpoint);
    secureOAuthUrl(discovery.tokenEndpoint);
    if (!resourceMatchesServer(discovery.resource, canonicalResourceUri(input.serverUrl))) {
      throw new Error("OAuth discovery resource does not match MCP server");
    }

    let client: { clientId: string; clientSecret?: string; redirectUri: string } | undefined;
    if (input.preRegisteredClient) {
      if (input.preRegisteredClient.issuer !== discovery.issuer || !input.preRegisteredClient.clientId.trim()) {
        throw new Error("pre-registered OAuth client does not match authorization server issuer");
      }
      loopbackRedirect(input.preRegisteredClient.redirectUri);
      client = input.preRegisteredClient;
    } else if (discovery.clientIdMetadataDocumentSupported) {
      try {
        client = await metadataDocumentClient(input.clientMetadataUrl ?? process.env.AGENTLAS_MCP_OAUTH_CLIENT_METADATA_URL ?? MCP_OAUTH_CLIENT_METADATA_URL);
      } catch {
        if (!discovery.registrationEndpoint) {
          throw new Error("public OAuth client metadata is unavailable or invalid; deploy the Agentlas client metadata document or configure a pre-registered client");
        }
        // A legacy server offering DCR remains usable if the hosted document is unavailable.
      }
    }
    if (!client && !discovery.registrationEndpoint) {
      throw new Error("this authorization server requires configured pre-registered client information (no supported client registration)");
    }

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(16));

    server = http.createServer();
    const callbackServer = server;
    const redirectPort = client ? Number(loopbackRedirect(client.redirectUri).port) : 0;
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(redirectPort, "127.0.0.1", () => {
        callbackServer.removeListener("error", reject);
        resolve();
      });
    }).catch((error: NodeJS.ErrnoException) => {
      callbackServer.close();
      if (error.code === "EADDRINUSE") throw new Error(`OAuth callback port ${redirectPort} is already in use; close the other pending connection and retry`);
      throw error;
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let clientId = client?.clientId ?? "";
    let clientSecret = client?.clientSecret;
    if (!client && discovery.registrationEndpoint) {
      const registered = await registerClient(discovery.registrationEndpoint, redirectUri);
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
    const previous = await readMcpOAuthSession(input.serverId);
    const initialScope = discovery.scope ?? discovery.scopesSupported?.join(" ");
    const scope = Array.from(new Set([
      ...(initialScope?.split(/\s+/).filter(Boolean) ?? []),
      ...(previous?.issuer === discovery.issuer && previous.resource === discovery.resource ? previous.scope?.split(/\s+/).filter(Boolean) ?? [] : []),
    ])).join(" ");

    const authorizeUrl = new URL(discovery.authorizationEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    // RFC 8707 — AS가 지원하든 말든 반드시 보낸다(스펙 MUST).
    authorizeUrl.searchParams.set("resource", discovery.resource);
    if (scope) authorizeUrl.searchParams.set("scope", scope);

    const controller = new AbortController();
    const attempt: AuthorizationAttempt = {
      serverId: input.serverId, attemptId: crypto.randomBytes(24).toString("hex"), status: "waiting",
      controller, server: callbackServer, completion: undefined as unknown as Promise<McpOAuthAuthorizeResult>,
    };
    authorizationAttempts.set(attempt.attemptId, attempt);
    activeAuthorizations.set(input.serverId, attempt);
    const codePromise = waitForAuthorizationCode(callbackServer, state, discovery.issuer, discovery.authorizationResponseIssuerSupported);
    void codePromise.catch(() => {});
    const browserOpened = openInAgentlasChrome(authorizeUrl.toString(), controller.signal);
    attempt.completion = (async () => {
      try {
        const code = await codePromise;
        controller.signal.throwIfAborted();
        attempt.status = "exchanging";
        const tokens = await exchangeAuthorizationCode({ tokenEndpoint: discovery.tokenEndpoint, code, codeVerifier,
          clientId, clientSecret, redirectUri, resource: discovery.resource, scope, signal: controller.signal });
        controller.signal.throwIfAborted();
        const session: McpOAuthSession = {
          resource: discovery.resource, issuer: discovery.issuer,
          authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint,
          clientId, ...(clientSecret ? { clientSecret } : {}),
          ...(tokens.scope !== undefined || scope ? { scope: tokens.scope ?? scope } : {}),
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}), obtainedAt: Date.now(),
        };
        await persistAuthorization(attempt, session, tokens.tokens);
        controller.signal.throwIfAborted();
        attempt.status = "connected";
        return { session, manualUrl: await browserOpened ? null : authorizeUrl.toString() };
      } catch (error) {
        if (controller.signal.aborted && !attempt.cleanupFailed) attempt.status = "cancelled";
        else {
          attempt.status = "failed";
          attempt.error = attempt.cleanupFailed ? "OAuth credential cleanup failed; check secure storage before retrying."
            : "OAuth authorization failed; retry the connection.";
        }
        throw error;
      } finally {
        controller.abort();
        await closeAuthorizationCallback(callbackServer);
        attempt.finishedAt = Date.now();
        if (activeAuthorizations.get(input.serverId) === attempt) activeAuthorizations.delete(input.serverId);
      }
    })();
    // Polling owns the terminal state; rejected background work must never become an unhandled rejection.
    void attempt.completion.catch(() => {});
    handedOff = true;
    return { attempt, manualUrl: authorizeUrl.toString() };
  } finally {
    startingAuthorizations.delete(input.serverId);
    if (server && !handedOff) await closeAuthorizationCallback(server);
  }
}

/** Start returns before consent; the fallback link is available even while Chrome is starting. */
export async function startMcpOAuthAuthorization(input: McpOAuthAuthorizationInput): Promise<{ attemptId: string; manualUrl: string }> {
  const { attempt, manualUrl } = await beginMcpOAuthAuthorization(input);
  return { attemptId: attempt.attemptId, manualUrl };
}

export function getMcpOAuthAuthorizationStatus(serverId: string, attemptId: string): McpOAuthAuthorizationStatus {
  pruneAuthorizationAttempts();
  const attempt = authorizationAttempts.get(attemptId);
  if (!attempt || attempt.serverId !== serverId) return { status: "unknown" };
  return { status: attempt.status, ...(attempt.error ? { error: attempt.error } : {}) };
}

export async function cancelMcpOAuthAuthorization(serverId: string, attemptId: string): Promise<{ ok: boolean }> {
  const attempt = authorizationAttempts.get(attemptId);
  if (!attempt || attempt.serverId !== serverId) return { ok: false };
  if (attempt.finishedAt) return { ok: attempt.status === "cancelled" };
  if (attempt.status === "connected") return { ok: false };
  attempt.status = "cancelled";
  attempt.controller.abort();
  await closeAuthorizationCallback(attempt.server);
  await attempt.completion.catch(() => {});
  return { ok: attempt.status === "cancelled" };
}

/** Compatibility API: resolves only after callback, exchange and persistence complete. */
export async function authorizeMcpServer(input: McpOAuthAuthorizationInput): Promise<McpOAuthAuthorizeResult> {
  const { attempt } = await beginMcpOAuthAuthorization(input);
  return attempt.completion;
}

function waitForAuthorizationCode(server: http.Server, expectedState: string, expectedIssuer: string, issuerRequired = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.removeListener("request", onRequest);
      server.removeListener("close", onClose);
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
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch {
        response.writeHead(400).end();
        return;
      }
      if (request.method !== "GET" || url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      if (["state", "code", "iss", "error"].some((key) => url.searchParams.getAll(key).length > 1)) {
        response.writeHead(400).end();
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
      const issuer = url.searchParams.get("iss");
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      server.removeListener("close", onClose);
      if ((issuerRequired && !issuer) || (issuer !== null && issuer !== expectedIssuer)) {
        reply(response, "Authorization response does not match the selected service.");
        reject(new Error("authorization response issuer is missing or mismatched"));
        return;
      }
      if (error) {
        reply(response, "Authorization was refused. You can close this window.");
        reject(new Error("authorization refused by the service"));
        return;
      }
      if (!code) {
        reply(response, "No authorization code was returned. You can close this window.");
        reject(new Error("authorization returned no code"));
        return;
      }
      reply(response, "Authorization received. You can close this window and go back to Agentlas.");
      resolve(code);
    }

    function onClose(): void {
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      reject(new Error("authorization callback was closed"));
    }
    server.once("close", onClose);
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
  scope?: string;
  signal?: AbortSignal;
}): Promise<{ tokens: StoredTokens; expiresAt?: number; scope?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  if (input.scope) body.set("scope", input.scope);
  const raw = await fetchJson(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: input.signal,
  }, TOKEN_TIMEOUT_MS) as Record<string, unknown>;
  return readTokenResponse(raw);
}

function readTokenResponse(raw: Record<string, unknown>): { tokens: StoredTokens; expiresAt?: number; scope?: string } {
  const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
  if (!accessToken) throw new Error("token endpoint returned no access_token");
  if (typeof raw.token_type === "string" && raw.token_type.toLowerCase() !== "bearer") {
    throw new Error("token endpoint returned an unsupported token type");
  }
  const expiresIn = Number(raw.expires_in);
  return {
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
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
  const pending = activeAuthorizations.get(serverId);
  if (pending) await cancelMcpOAuthAuthorization(serverId, pending.attemptId);
  await deleteSecret(sessionSecretKey(serverId));
  await deleteSecret(tokenSecretKey(serverId));
}

/** Passive readiness only: never refresh, contact a provider, or write credentials. */
export async function hasUsableMcpOAuthCredential(serverId: string, serverUrl: string): Promise<boolean> {
  const session = await readMcpOAuthSession(serverId);
  if (!session) return false;
  try {
    if (!resourceMatchesServer(session.resource, canonicalResourceUri(serverUrl))) return false;
  } catch { return false; }
  if (session.expiresAt !== undefined && (typeof session.expiresAt !== "number" ||
      !Number.isFinite(session.expiresAt) || session.expiresAt - REFRESH_SKEW_MS <= Date.now())) return false;
  const raw = await readSecret(tokenSecretKey(serverId));
  if (!raw) return false;
  try {
    const tokens = JSON.parse(raw) as StoredTokens | null;
    return typeof tokens?.accessToken === "string" && tokens.accessToken.trim().length > 0;
  } catch { return false; }
}

/**
 * 이 서버에 붙일 access token. 만료가 가까우면 먼저 갱신한다.
 *
 * 갱신에 실패하면 null을 돌려준다 — 만료된 토큰을 그대로 실어 보내면 런타임이
 * 401로 죽고 사용자는 "왜 갑자기 안 되지"를 겪는다. null이면 화면이 "다시 연결"을
 * 말할 수 있다.
 */
export async function resolveMcpOAuthAccessToken(serverId: string, serverUrl?: string): Promise<string | null> {
  const session = await readMcpOAuthSession(serverId);
  if (!session) return null;
  if (serverUrl !== undefined) {
    try {
      if (!resourceMatchesServer(session.resource, canonicalResourceUri(serverUrl))) return null;
    } catch { return null; }
  }
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
    if (session.scope) body.set("scope", session.scope);
    const rawResponse = await fetchJson(session.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    }, TOKEN_TIMEOUT_MS) as Record<string, unknown>;
    const next = readTokenResponse(rawResponse);
    await persist(serverId, {
      ...session,
      expiresAt: next.expiresAt,
      ...(next.scope !== undefined ? { scope: next.scope } : {}),
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
