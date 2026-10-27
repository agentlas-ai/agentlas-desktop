import type { Agent as HttpAgent } from "node:http";
import { webSocketAgentFor } from "../net/system-network-core";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getSessionCookieHeader, webBaseUrl } from "../auth";
import type { MobilePushRelayPayload, MobilePushOutcome } from "./push";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const RELAY_FILE = "relay.json";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const CONTROL_HEARTBEAT_MS = 20_000;
const REPAIR_LATCH_MAX_TOKENS = 64;
const REPAIR_LATCH_TTL_MS = 10 * 60_000;

/*
 * 제어 채널 재시도 정책 (2026-09-27, main.log 2026-09-25 실측).
 *
 * ★ 무엇이 있었나
 *   세션이 중계에서 401 로 거절되는 동안 8시간(03:34~11:32Z) 동안 1,222번 다시 붙었다 —
 *   23.4초마다 한 번, 시간당 ~153번 시도·~306줄 경고. 이유는 두 겹이었다.
 *   ① 401 은 "다시 로그인해야 풀리는" 거절인데 네트워크 끊김과 똑같이 1·2·4·8·15초로
 *      다시 두드렸다(상한 15초, 지터 없음).
 *   ② ws 는 `unexpected-response` 리스너가 있으면 요청을 스스로 끊지 않는다. 그래서 401 을
 *      받은 소켓이 8초 핸드셰이크 타임아웃까지 매달려 있다가 "Opening handshake has timed
 *      out" 을 한 줄 더 남겼다 — 로그의 타임아웃 1,223줄은 별개 장애가 아니라 같은 401 의 그림자.
 *      두 줄이 번갈아 나와 상태 중복 제거(logControl)도 한 번도 효과가 없었다.
 *
 * ★ 지금
 *   - 401/403/410 = 인증 거절: 같은 쿠키로는 네트워크에 다시 가지 않는다. 쿠키가 바뀌면(다시
 *     로그인) 즉시 붙고, 안 바뀌면 30분→60분→120분(상한) 에 한 번만 확인한다. 쿠키 비교는
 *     메모리 안이라 공짜다.
 *   - 그 밖(타임아웃·503·429·끊김) = 일시 장애: 1초부터 두 배, 상한 2분, 반은 고정 반은 지터
 *     ("equal jitter") — 중계 재배포 때 모든 데스크탑이 같은 초에 몰리지 않게.
 *   - 연결에 성공하면 둘 다 처음으로 돌아간다.
 */
export const RELAY_TRANSIENT_BASE_MS = 1_000;
export const RELAY_TRANSIENT_CAP_MS = 120_000;
export const RELAY_AUTH_REFUSED_BASE_MS = 30 * 60_000;
export const RELAY_AUTH_REFUSED_CAP_MS = 120 * 60_000;
/** 인증 거절 동안 "쿠키가 바뀌었나"만 보는 로컬 확인 주기 — 네트워크를 쓰지 않는다. */
export const RELAY_AUTH_RECHECK_MS = 30_000;

/** 다시 로그인하기 전엔 같은 결과가 나오는 HTTP 상태. */
export function isRelayAuthRefusal(status: number | null): boolean {
  return status === 401 || status === 403 || status === 410;
}

/** 일시 장애 재시도 대기. attempt 는 0부터. random 은 [0,1). */
export function relayTransientDelayMs(attempt: number, random: number = Math.random()): number {
  const ceiling = Math.min(RELAY_TRANSIENT_CAP_MS, RELAY_TRANSIENT_BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 20));
  return Math.round(ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random, 0), 1));
}

/** 인증 거절 뒤 같은 쿠키로 다시 확인하기까지의 대기. refusals 는 1부터. */
export function relayAuthRefusedDelayMs(refusals: number): number {
  return Math.min(RELAY_AUTH_REFUSED_CAP_MS, RELAY_AUTH_REFUSED_BASE_MS * 2 ** Math.min(Math.max(refusals - 1, 0), 10));
}

interface RelaySocket {
  readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "pong", listener: () => void): this;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): this;
  on(event: "unexpected-response", listener: (request: unknown, response: unknown) => void): this;
  send(data: unknown, options?: { binary?: boolean }): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

function upgradeStatusCode(response: unknown): number | null {
  if (!response || typeof response !== "object" || !("statusCode" in response)) return null;
  const code = (response as { statusCode?: unknown }).statusCode;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function upgradeStatus(response: unknown): string {
  return response && typeof response === "object" && "statusCode" in response
    ? String((response as { statusCode?: unknown }).statusCode ?? "unknown")
    : "unknown";
}

/**
 * 로컬 브리지가 거절 사유를 실어 보내는 헤더. 이걸 읽지 않으면 재페어링이 필요한
 * 상황과 일시적 장애를 구분할 수 없어 같은 실패를 영원히 반복한다
 * (실측 2026-08-08: 100초에 터널 13개, 전부 401).
 */
function upgradeRefusal(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("headers" in response)) return null;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const raw = (headers as Record<string, unknown>)["x-agentlas-refusal"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/** 재페어링 말고는 회복 경로가 없는 사유 — 터널을 계속 열면 안 된다. */
const TERMINAL_REFUSALS = new Set(["device_unknown_or_revoked", "device_repair_required"]);

/*
 * 터널이 "relay side closed" 로 닫혔을 때, 닫은 쪽이 폰인지 중계인지 로그만으로 가리는 증거.
 *
 * ★ 왜 (2026-10-16)
 *   오너가 5G 에서 "계속 데탑이 끊긴다"고 했을 때 이 줄에는 코드도 사유도 없어서, 폰이 앱 전환·
 *   네트워크 전환으로 소켓을 놓은 건지 중계가 닫은 건지 가를 수 없었다. 중계(mobile-relay.mjs
 *   closeChannel)는 닫을 때 항상 코드와 사유를 싣는다:
 *     - 1000 "device closed"        폰 쪽 소켓이 닫혔다(앱이 내려가 심박 응답이 끊겨 중계가
 *                                   정리한 경우 포함 — 중계는 25초 심박 두 번 못 받으면 끊는다)
 *     - 1012 "relay restarting"     중계 재배포·재시작
 *     - 1012 "relay unavailable"    채널 시간 초과·반대편 오류
 *   코드는 서버가 정한 고정 어휘이고 사용자 데이터가 아니다.
 */
export type RelayCloseSide = "phone" | "relay-restart" | "relay-other" | "unknown";

export function relayCloseSide(code: unknown, reason: unknown): RelayCloseSide {
  const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : typeof reason === "string" ? reason : "";
  if (code === 1000 && text === "device closed") return "phone";
  if (code === 1012 && text === "relay restarting") return "relay-restart";
  if (code === 1012 || code === 1013 || code === 1008 || code === 1009) return "relay-other";
  return "unknown";
}

export function relayCloseDetail(code: unknown, reason: unknown): string {
  const raw = Buffer.isBuffer(reason) ? reason.toString("utf8") : typeof reason === "string" ? reason : "";
  const text = raw.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
  return `code=${typeof code === "number" ? code : "none"}${text ? ` reason="${text}"` : ""} side=${relayCloseSide(code, reason)}`;
}

interface RelaySocketOptions {
  /** The proxying agent when the system proxy applies to this URL (system-network-core). */
  agent?: HttpAgent;
  headers?: Record<string, string>;
  handshakeTimeout?: number;
  perMessageDeflate?: boolean;
  ca?: string;
  rejectUnauthorized?: boolean;
  checkServerIdentity?: (host: string, presented: { raw?: Buffer }) => Error | undefined;
}

interface RelaySocketConstructor {
  new(url: string, options?: RelaySocketOptions): RelaySocket;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RelayWebSocket = require("ws") as RelaySocketConstructor;

interface RelayStateFile {
  version: 1;
  secret: string;
}

/** Host-supplied authority is exclusive: null means unavailable, never cookie fallback. */
export interface MobileBridgeRelayAuthentication {
  current(): Readonly<{ epoch: string; headers: Readonly<Record<string,string>> }> | null;
}
export interface MobileBridgeCloudRelayOptions {
  authentication?: MobileBridgeRelayAuthentication;
  relayEndpoint?: string;
  userDataPath: string;
  hostId: string;
  localEndpoint: string;
  certificateDer: string;
  onStatusChanged?: () => void;
  /**
   * 중계로 들어온 첫 페어링 요청 한 프레임 → 폰에 돌려줄 한 프레임. relay-pairing.ts 참고.
   * 없으면 중계 페어링 신호를 무시한다(폰은 제한 시간 뒤 실패로 끝난다).
   */
  onPairFrame?: (frameText: string) => Promise<string>;
}

function relayFilePath(userDataPath: string): string {
  return path.join(userDataPath, "mobile-bridge", RELAY_FILE);
}

function readOrCreateSecret(userDataPath: string): string {
  const target = relayFilePath(userDataPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<RelayStateFile>;
    if (parsed.version === 1 && typeof parsed.secret === "string" && SECRET_PATTERN.test(parsed.secret)) {
      if (process.platform !== "win32") fs.chmodSync(target, 0o600);
      return parsed.secret;
    }
    throw new Error("invalid Mobile Relay secret file");
  } catch (error) {
    // Only first-run absence may mint a credential. JSON corruption, invalid
    // schema, and permission/I/O failures must leave the durable value in place
    // and fail closed; silently replacing it disconnects every already-paired
    // phone from Cloud Relay with no recovery except re-pairing.
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const secret = randomBytes(32).toString("base64url");
  const temporary = `${target}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, secret }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  return secret;
}

/*
 * 중계 주소는 웹 주소에서 파생하되, **따로 지정할 수 있게 열어 둔다** (2026-08-25).
 *
 * ★ 왜 지금 열어 두는가 — 순서 때문이다
 *   지금 중계는 웹 서버 프로세스 안에 있다. 그래서 ① 웹을 배포할 때마다 폰 연결이 끊기고
 *   ② 웹을 여러 대로 늘리면 데스크탑과 폰이 서로 다른 대에 붙어 못 만난다.
 *   답은 중계를 별도 서비스로 떼는 것이다(같은 구조를 쓰는 다른 제품들이 그렇게 한다).
 *
 *   그런데 **데스크탑이 먼저 준비돼야 한다.** 서버만 옮기면 이미 나가 있는 데스크탑들은
 *   여전히 웹 주소로 찾아오고, 새 릴리스가 사용자에게 도달하는 데는 시간이 걸린다.
 *   그래서 "옮길 수 있는 버전"을 먼저 퍼뜨리고, 그 다음에 서버를 옮긴다.
 *
 *   값을 안 주면 지금과 **완전히 같게** 동작한다 — 이 변경만으로는 아무것도 바뀌지 않는다.
 */
function relayEndpoint(override?: string): string {
  const explicit = override ?? process.env.AGENTLAS_RELAY_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol === "https:") url.protocol = "wss:";
      else if (url.protocol === "http:") url.protocol = "ws:";
      // 경로를 안 적었으면 기본 경로를 붙인다. 적었으면 그대로 존중한다.
      if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/mobile/relay";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // 주소가 잘못돼 있으면 조용히 무시하고 예전 경로로 간다 — 오타 하나로 원격 접속이
      // 통째로 죽는 것보다, 예전처럼 도는 편이 낫다.
      if (override) throw new Error("mobile_relay_host_endpoint_invalid");
      console.warn("[mobile-bridge-relay] AGENTLAS_RELAY_URL is not a valid URL; falling back to the web address");
    }
  }
  const url = new URL(webBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/mobile/relay";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * 서버에 "중계는 어디로 붙나"를 묻는다.
 *
 * ★ 왜 (2026-08-25)
 *   중계를 웹에서 떼어 별도 서비스로 옮겼다. 그런데 주소를 데스크탑이 **자기 안에서**
 *   정하고 있어서, 옮기려면 매번 데스크탑을 새로 배포해야 했다. 환경변수는 실사용자
 *   기계에서 아무도 켜지 않으므로 사실상 옮길 방법이 없었다.
 *   이제 서버가 알려준다 — 앞으로 주소 이전은 서버 설정 한 줄이고 재배포가 없다.
 *
 * ★ 실패는 전부 "예전 주소로 간다"로 끝나야 한다
 *   서버가 죽었든, 느리든, 이상한 값을 주든, 이 판이 아직 그 창구를 모르는 옛 서버에
 *   붙었든 — 어느 경우에도 원격 접속이 끊기면 안 된다. 그래서 모든 실패는 null 이고,
 *   부르는 쪽은 쓰던 주소를 그대로 쓴다.
 */
async function fetchRelayEndpoint(): Promise<string | null> {
  const controller = new AbortController();
  // 연결 시도 전에 붙는 지연이므로 짧게. 못 받으면 그냥 예전 주소로 간다.
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${webBaseUrl()}/api/mobile-pair/v1/relay-endpoint`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const raw = body && typeof body === "object" ? (body as { url?: unknown }).url : null;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
    const url = new URL(raw);
    // 평문은 받지 않는다 — 이 소켓에는 로그인 쿠키가 실린다.
    if (url.protocol !== "wss:") return null;
    if (!url.hostname) return null;
    if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/mobile/relay";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function relayUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function certificatePem(certificateDer: string): string {
  const lines = certificateDer.match(/.{1,64}/g)?.join("\n") ?? certificateDer;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

/**
 * The local hop talks to this Desktop's own bridge, so it trusts exactly one certificate. That certificate's
 * names are frozen when it is created, while a DHCP lease can move the LAN address the bridge listens on
 * (measured 2026-10-20: certificate names 192.168.200.133, bridge on 192.168.200.140, every tunnel closed with
 * "IP is not in the cert's list"). Identity is the pinned certificate itself: the chain check still runs against
 * `ca`, and this replaces only the name check with an exact SHA-256 match of the presented certificate.
 */
function pinnedCertificateIdentity(certificateDer: string) {
  const expected = createHash("sha256").update(Buffer.from(certificateDer, "base64")).digest("hex");
  return (_host: string, presented: { raw?: Buffer }): Error | undefined => {
    const actual = presented?.raw ? createHash("sha256").update(presented.raw).digest("hex") : null;
    return actual === expected ? undefined : new Error("local hop certificate does not match the pinned Desktop certificate");
  };
}

function rawBytes(data: unknown): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === "string") return Buffer.byteLength(data);
  return MAX_PENDING_BYTES + 1;
}

export class MobileBridgeCloudRelay {
  // 서버가 알려주면 갱신된다. 못 받으면 여기 있는 값(환경변수 또는 웹 주소)을 계속 쓴다.
  private endpoint: string;
  // 환경변수로 못 박아 둔 경우에는 서버에 묻지 않는다 — 명시적 지정이 항상 이긴다.
  private readonly endpointIsPinned: boolean;
  private endpointCheckedAt = 0;
  private readonly secret: string;
  private control: RelaySocket | null = null;
  private controlCookie: string | null = null;
  private pushPlatforms: Array<"ios" | "android"> = [];
  private readonly pushPending = new Map<string, { resolve: (outcome: MobilePushOutcome) => void; timer: NodeJS.Timeout }>();
  private retryTimer: NodeJS.Timeout | null = null;
  private controlHeartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private retryAttempt = 0;
  // 인증 거절(401/403/410)을 받은 그 쿠키. 같은 쿠키로는 authRetryAt 전에 네트워크에 가지 않는다.
  private authRefusedCookie: string | null = null;
  private authRefusals = 0;
  private authRetryAt = 0;
  // Deduplicates control-channel diagnostics so a 5s retry loop cannot spam the
  // log. Only transitions are logged, never the cookie or relay secret.
  private lastControlLog: "signed-out" | "connected" | "closed" | "error" | "rejected" | null = null;
  private readonly tunnels = new Set<RelaySocket>();

  constructor(private readonly options: MobileBridgeCloudRelayOptions) {
    this.endpoint = relayEndpoint(options.relayEndpoint);
    this.endpointIsPinned = Boolean(options.relayEndpoint || process.env.AGENTLAS_RELAY_URL?.trim());
    this.secret = readOrCreateSecret(options.userDataPath);
  }

  private authentication(): Readonly<{epoch:string;headers:Readonly<Record<string,string>>}> | null {
    if (this.options.authentication) return this.options.authentication.current();
    const cookie = getSessionCookieHeader();
    return cookie ? { epoch:cookie, headers:{Cookie:cookie} } : null;
  }
  private authenticationEpoch(): string | null { return this.authentication()?.epoch ?? null; }
  ready(): boolean { return !this.stopped && this.control?.readyState === WS_OPEN && this.controlCookie === this.authenticationEpoch(); }

  /** Host-only credential rotation. Pairing records/TLS pins are unchanged. */
  refreshAuthentication(): void {
    if (this.stopped) return;
    this.stop();
    this.clearAuthRefusal();
    this.start();
  }

  pairingInfo(): { endpoint: string; secret: string } {
    return { endpoint: this.endpoint, secret: this.secret };
  }

  supportsPush(platform: "ios" | "android"): boolean {
    return !this.stopped && this.control?.readyState === WS_OPEN &&
      this.controlCookie === this.authenticationEpoch() && this.pushPlatforms.includes(platform);
  }

  /** Control is authenticated independently of phone tunnels. No token/body is logged. */
  publishPush(payload: MobilePushRelayPayload): Promise<MobilePushOutcome> {
    const control = this.control;
    if (!this.supportsPush(payload.platform) || !control || control.readyState !== WS_OPEN ||
        this.controlCookie !== this.authenticationEpoch() || this.pushPending.size >= 32 ||
        payload.notification.hostId !== this.options.hostId) return Promise.resolve("unavailable");
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pushPending.delete(requestId); resolve("unavailable"); }, 12_000);
      timer.unref?.();
      this.pushPending.set(requestId, { resolve, timer });
      try { control.send(JSON.stringify({ type: "relay.push", requestId, ...payload })); }
      catch { clearTimeout(timer); this.pushPending.delete(requestId); resolve("unavailable"); }
    });
  }

  private settlePushes(): void {
    for (const pending of this.pushPending.values()) { clearTimeout(pending.timer); pending.resolve("unavailable"); }
    this.pushPending.clear();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleConnect(0);
  }

  stop(): void {
    this.stopped = true;
    this.settlePushes();
    this.controlCookie = null;
    this.pushPlatforms = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.controlHeartbeatTimer) clearInterval(this.controlHeartbeatTimer);
    this.controlHeartbeatTimer = null;
    this.control?.close(1000, "desktop stopping");
    this.control = null;
    for (const tunnel of this.tunnels) tunnel.close(1000, "desktop stopping");
    this.tunnels.clear();
  }

  private scheduleConnect(delay?: number): void {
    if (this.stopped || this.retryTimer) return;
    const wait = delay ?? relayTransientDelayMs(this.retryAttempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectControl();
    }, wait);
    this.retryTimer.unref?.();
  }

  private clearAuthRefusal(): void {
    this.authRefusedCookie = null;
    this.authRefusals = 0;
    this.authRetryAt = 0;
  }

  private logControl(state: typeof this.lastControlLog, message: string, warn = false): void {
    if (this.lastControlLog === state) return;
    this.lastControlLog = state;
    if (warn) console.warn(`[mobile-bridge-relay] ${message}`);
    else console.info(`[mobile-bridge-relay] ${message}`);
  }

  /**
   * 붙기 직전에 서버에 주소를 한 번 물어본다. 5분에 한 번만 묻고, 못 받으면 쓰던 주소를
   * 그대로 쓴다 — 이 확인이 실패해서 원격 접속이 끊기는 일은 없어야 한다.
   */
  private async refreshEndpoint(): Promise<void> {
    if (this.endpointIsPinned) return;
    const now = Date.now();
    if (now - this.endpointCheckedAt < 300_000) return;
    this.endpointCheckedAt = now;
    const resolved = await fetchRelayEndpoint();
    if (!resolved || resolved === this.endpoint) return;
    console.info(`[mobile-bridge-relay] relay endpoint moved to ${new URL(resolved).host}`);
    this.endpoint = resolved;
  }

  private connectControl(): void {
    if (this.stopped || this.control) return;
    // 주소 확인은 붙는 것을 막지 않는다. 실패해도 그대로 진행한다.
    void this.refreshEndpoint().finally(() => this.openControl());
  }

  private openControl(): void {
    if (this.stopped || this.control) return;
    const authentication = this.authentication();
    const cookie = authentication?.epoch;
    if (!cookie) {
      // The single most common reason remote access silently never works: the
      // relay tunnel requires this Desktop to be signed in to Agentlas.
      this.logControl("signed-out", "remote access paused — this Desktop is not signed in to Agentlas", true);
      this.options.onStatusChanged?.();
      this.scheduleConnect(5_000);
      return;
    }
    if (this.authRefusedCookie !== null) {
      if (cookie !== this.authRefusedCookie) {
        // 다시 로그인했다 — 새 쿠키는 거절된 적이 없으니 지금 바로 붙는다.
        this.clearAuthRefusal();
      } else if (Date.now() < this.authRetryAt) {
        this.scheduleConnect(Math.min(RELAY_AUTH_RECHECK_MS, Math.max(1_000, this.authRetryAt - Date.now())));
        return;
      }
    }
    const controlUrl = relayUrl(this.endpoint, {
      role: "desktop",
      hostId: this.options.hostId,
    });
    const socket = new RelayWebSocket(controlUrl, {
      agent: webSocketAgentFor(controlUrl),
      headers: { ...authentication!.headers, "x-agentlas-relay-secret": this.secret },
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
    });
    this.control = socket;
    this.controlCookie = cookie;
    this.pushPlatforms = [];
    let opened = false;
    let controlAlive = true;
    socket.on("open", () => {
      opened = true;
      this.retryAttempt = 0;
      this.clearAuthRefusal();
      this.logControl("connected", "remote access control channel connected");
      this.options.onStatusChanged?.();
      this.controlHeartbeatTimer = setInterval(() => {
        if (this.stopped || this.control !== socket) {
          if (this.controlHeartbeatTimer) clearInterval(this.controlHeartbeatTimer);
          this.controlHeartbeatTimer = null;
          return;
        }
        if (!controlAlive) {
          socket.terminate();
          return;
        }
        controlAlive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }, CONTROL_HEARTBEAT_MS);
      this.controlHeartbeatTimer.unref?.();
    });
    socket.on("pong", () => {
      controlAlive = true;
    });
    let refusedStatus: number | null = null;
    socket.on("unexpected-response", (_request, response) => {
      const status = upgradeStatusCode(response);
      refusedStatus = status ?? 0;
      const refusal = upgradeRefusal(response);
      // Server-side reason, no secrets: 401 = bad relay credential/session,
      // 503 = relay endpoint unavailable, 429 = too many devices. The relay also
      // names the reason in X-Agentlas-Refusal (session_expired, …).
      if (isRelayAuthRefusal(status)) {
        this.authRefusedCookie = cookie;
        this.authRefusals += 1;
        const wait = relayAuthRefusedDelayMs(this.authRefusals);
        this.authRetryAt = Date.now() + wait;
        this.logControl(
          "rejected",
          `remote access control channel rejected by server (HTTP ${status}${refusal ? `, refusal=${refusal}` : ""}); ` +
            `not retrying with this sign-in for ${Math.round(wait / 60_000)} min — sign in again to reconnect now`,
          true,
        );
      } else {
        this.logControl(
          "rejected",
          `remote access control channel rejected by server (HTTP ${status ?? "unknown"}${refusal ? `, refusal=${refusal}` : ""})`,
          true,
        );
      }
      // ws 는 이 리스너가 있으면 요청을 스스로 끊지 않는다 — 두면 8초 핸드셰이크 타임아웃까지
      // 매달렸다가 "Opening handshake has timed out" 을 한 줄 더 남긴다. 지금 끊는다.
      socket.terminate();
    });
    socket.on("message", (data) => { if (this.control === socket) this.handleControlMessage(data); });
    const disconnected = (...args: unknown[]) => {
      if (this.control !== socket) return;
      this.control = null;
      this.controlCookie = null;
      this.pushPlatforms = [];
      this.settlePushes();
      if (this.controlHeartbeatTimer) clearInterval(this.controlHeartbeatTimer);
      this.controlHeartbeatTimer = null;
      if (refusedStatus !== null) {
        // 거절은 unexpected-response 에서 이미 한 줄 남겼다. terminate() 가 내는 error 는 그 그림자다.
      } else if (!opened) {
        socket.terminate();
        const detail = args[0] instanceof Error ? `: ${args[0].message}` : "";
        this.logControl("error", `remote access control channel unavailable${detail}`, true);
      } else {
        this.logControl(
          "closed",
          `remote access control channel closed (${relayCloseDetail(args[0], args[1])}); retrying`,
        );
      }
      this.options.onStatusChanged?.();
      if (refusedStatus !== null && isRelayAuthRefusal(refusedStatus)) {
        this.scheduleConnect(Math.min(RELAY_AUTH_RECHECK_MS, Math.max(1_000, this.authRetryAt - Date.now())));
      } else {
        this.scheduleConnect();
      }
    };
    socket.on("close", disconnected);
    socket.on("error", disconnected);
  }

  private handleControlMessage(data: unknown): void {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    if (message.type === "relay.ready") {
      const push = message.push as Record<string, unknown> | undefined;
      this.pushPlatforms = push?.provider === "fcm" && push.available === true && Array.isArray(push.platforms)
        ? push.platforms.filter((value): value is "ios" | "android" => value === "ios" || value === "android") : [];
      this.options.onStatusChanged?.();
      return;
    }
    if (message.type === "relay.push.result") {
      if (typeof message.requestId !== "string" || !["accepted", "unregistered", "unavailable", "refused"].includes(String(message.outcome))) return;
      const pending = this.pushPending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pushPending.delete(message.requestId);
      pending.resolve(message.outcome as MobilePushOutcome);
      return;
    }
    if (message.type === "relay.pair") {
      if (typeof message.channelId !== "string" || !CHANNEL_PATTERN.test(message.channelId)) return;
      this.openPairTunnel(message.channelId);
      return;
    }
    if (message.type !== "relay.device") return;
    if (typeof message.channelId !== "string" || !CHANNEL_PATTERN.test(message.channelId)) return;
    if (typeof message.deviceToken !== "string" || !TOKEN_PATTERN.test(message.deviceToken)) return;
    this.openTunnel(message.channelId, message.deviceToken);
  }

  /**
   * 로컬 홉이 "재페어링만이 답"이라고 답한 **그 기기 토큰**에 걸리는 래치(토큰 sha256 앞 16자 → 사유). 걸린 토큰의
   * 터널은 열지 않는다 — 열어도 같은 401이고, 폰은 그 사실을 알 수 없어 계속 두드린다.
   *
   * ★ 기기별이다. 예전에는 릴레이 전체에 문자열 하나였다: 설정에서 지운 폰 A 가 계속 두드리면 정상 폰 B 의 터널까지
   *   열리지 않았고, 데스크탑 화면에는 아무 오류도 없었다. 사유도 토큰의 것이지 다른 기기의 것이 아니다.
   * ★ 64개 LRU, 10분 뒤 스스로 풀린다. 잘못 걸렸더라도(저장소 일시 오류 등) 새 페어링을 기다리며 갇히지 않고, 진짜로
   *   폐기된 폰은 10분에 한 번만 로컬 홉을 두드린다.
   */
  private readonly repairRequiredTokens = new Map<string, { refusal: string; at: number }>();

  private repairLatchKey(deviceToken: string): string {
    return createHash("sha256").update(deviceToken).digest("hex").slice(0, 16);
  }

  private repairRequiredFor(deviceToken: string): { refusal: string; key: string } | null {
    const key = this.repairLatchKey(deviceToken);
    const entry = this.repairRequiredTokens.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= REPAIR_LATCH_TTL_MS) {
      this.repairRequiredTokens.delete(key);
      return null;
    }
    // 쓰인 항목을 뒤로 보내 가득 찼을 때 가장 오래 안 쓰인 것부터 밀려나게 한다.
    this.repairRequiredTokens.delete(key);
    this.repairRequiredTokens.set(key, entry);
    return { refusal: entry.refusal, key };
  }

  private latchRepairRequired(deviceToken: string, refusal: string): string {
    const key = this.repairLatchKey(deviceToken);
    this.repairRequiredTokens.delete(key);
    this.repairRequiredTokens.set(key, { refusal, at: Date.now() });
    while (this.repairRequiredTokens.size > REPAIR_LATCH_MAX_TOKENS) {
      const oldest = this.repairRequiredTokens.keys().next().value;
      if (oldest === undefined) break;
      this.repairRequiredTokens.delete(oldest);
    }
    return key;
  }

  /** 페어링 상태가 바뀌면 래치를 전부 푼다(새 기기가 붙을 수 있게 된다). */
  clearRepairRequiredLatch(): void {
    if (this.repairRequiredTokens.size === 0) return;
    this.repairRequiredTokens.clear();
    console.info("[mobile-bridge-relay] re-pairing latch cleared; tunnels may open again");
  }

  /**
   * 첫 페어링 한 번을 위한 터널. 폰의 요청 한 프레임을 받아 페어링 창구에 넘기고, 응답 한
   * 프레임을 돌려준 뒤 닫는다. 로컬 브리지로 이어 붙이지 않는다 — 아직 기기 토큰이 없다.
   */
  private openPairTunnel(channelId: string): void {
    const onPairFrame = this.options.onPairFrame;
    const authentication = this.authentication();
    const cookie = authentication?.epoch;
    if (!onPairFrame || !cookie || this.stopped) return;
    const tunnelUrl = relayUrl(this.endpoint, {
      role: "tunnel",
      hostId: this.options.hostId,
      channelId,
    });
    const cloud = new RelayWebSocket(tunnelUrl, {
      agent: webSocketAgentFor(tunnelUrl),
      headers: { ...authentication!.headers, "x-agentlas-relay-secret": this.secret },
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
    });
    this.tunnels.add(cloud);
    let handled = false;
    let finished = false;
    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.tunnels.delete(cloud);
      console.info(`[mobile-bridge-relay] pairing tunnel ${channelId} closed: ${why}`);
      if (cloud.readyState === WS_OPEN) cloud.close(1000, "pairing done");
    };
    const timer = setTimeout(() => finish("no pairing request arrived in time"), 30_000);
    timer.unref?.();
    cloud.on("open", () => console.info(`[mobile-bridge-relay] pairing tunnel ${channelId} opened`));
    cloud.on("message", (data, isBinary) => {
      if (handled) return;
      handled = true;
      if (isBinary || rawBytes(data) > 64 * 1024) {
        finish("pairing request frame rejected");
        return;
      }
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      void onPairFrame(text)
        .then((reply) => {
          if (cloud.readyState === WS_OPEN) cloud.send(reply);
          finish("pairing reply sent");
        })
        .catch((error) => finish(`pairing handler failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    cloud.on("close", () => finish("relay side closed"));
    cloud.on("error", (error) => finish(`relay side failed: ${error instanceof Error ? error.message : String(error)}`));
    cloud.on("unexpected-response", (_request, response) => {
      finish(`relay refused the pairing tunnel (HTTP ${upgradeStatus(response)})`);
      cloud.terminate();
    });
  }

  private openTunnel(channelId: string, deviceToken: string): void {
    const authentication = this.authentication();
    const cookie = authentication?.epoch;
    if (!cookie || this.stopped) return;
    const latched = this.repairRequiredFor(deviceToken);
    if (latched) {
      console.warn(
        `[mobile-bridge-relay] tunnel ${channelId} not opened: refusal=${latched.refusal} token=${latched.key.slice(0, 8)} — that phone must be paired again`,
      );
      return;
    }
    const tunnelUrl = relayUrl(this.endpoint, {
      role: "tunnel",
      hostId: this.options.hostId,
      channelId,
    });
    const cloud = new RelayWebSocket(tunnelUrl, {
      agent: webSocketAgentFor(tunnelUrl),
      headers: { ...authentication!.headers, "x-agentlas-relay-secret": this.secret },
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
    });
    this.tunnels.add(cloud);
    let local: RelaySocket | null = null;
    let pending: Array<{ data: unknown; binary: boolean }> = [];
    let pendingBytes = 0;
    let closed = false;
    const openedAt = Date.now();
    // Every tunnel failure used to funnel into closeBoth() with no log on this
    // side and no log on the relay, while the phone was told only "relay
    // unavailable". A remote command that never arrived left no evidence
    // anywhere, on either machine.
    const closeBoth = (why: string, detail?: unknown) => {
      if (closed) return;
      closed = true;
      pending = [];
      this.tunnels.delete(cloud);
      const reachedLocal = local !== null;
      console.warn(
        `[mobile-bridge-relay] tunnel ${channelId} closed: ${why}` +
          ` (localHopStarted=${reachedLocal}, ageSec=${Math.round((Date.now() - openedAt) / 1000)})` +
          (detail ? ` — ${detail instanceof Error ? detail.message : String(detail)}` : ""),
      );
      if (cloud.readyState === WS_OPEN) cloud.close(1012, "tunnel closed");
      if (local?.readyState === WS_OPEN) local.close(1012, "tunnel closed");
      // A hop still in its TLS handshake has no close handshake to run. Left alone it finishes later, the bridge counts it
      // as the device's live (authenticated) connection, supersedes the phone's real one, and nobody reads it.
      else if (local?.readyState === WS_CONNECTING) local.terminate();
    };
    cloud.on("message", (data, isBinary) => {
      if (local?.readyState === WS_OPEN) {
        local.send(data, { binary: isBinary });
        return;
      }
      pendingBytes += rawBytes(data);
      if (pendingBytes > MAX_PENDING_BYTES) {
        closeBoth("local hop did not open before the buffer filled");
        return;
      }
      pending.push({ data, binary: isBinary });
    });
    cloud.on("open", () => {
      local = new RelayWebSocket(this.options.localEndpoint, {
        headers: { Authorization: `Bearer ${deviceToken}` },
        handshakeTimeout: 5_000,
        perMessageDeflate: false,
        ca: certificatePem(this.options.certificateDer),
        rejectUnauthorized: true,
        checkServerIdentity: pinnedCertificateIdentity(this.options.certificateDer),
      });
      local.on("open", () => {
        if (closed) { local?.terminate(); return; }
        for (const frame of pending) local?.send(frame.data, { binary: frame.binary });
        pending = [];
        pendingBytes = 0;
      });
      local.on("message", (data, isBinary) => {
        if (cloud.readyState === WS_OPEN) cloud.send(data, { binary: isBinary });
      });
      local.on("close", () => closeBoth("local hop closed"));
      // The local hop pins this Desktop's own certificate. A LAN address change
      // after the certificate was generated fails exactly here, and used to be
      // completely silent on both ends.
      local.on("error", (error) => closeBoth("local hop failed", error));
      local.on("unexpected-response", (_request, response) => {
        const refusal = upgradeRefusal(response);
        if (refusal && TERMINAL_REFUSALS.has(refusal)) {
          // 사유가 회복 불가면 재시도가 의미 없다. 이 토큰에만 래치를 걸어 이 토큰의 다음 터널 요청을
          // 즉시 거절하고, 사람이 읽을 한 줄을 남긴다. 래치는 페어링이 바뀔 때(또는 10분 뒤) 풀린다.
          const key = this.latchRepairRequired(deviceToken, refusal);
          console.warn(
            `[mobile-bridge-relay] remote access needs re-pairing (refusal=${refusal} token=${key.slice(0, 8)}); ` +
              "not opening further tunnels for this phone's credential until it is paired again",
          );
        }
        closeBoth(
          `local hop refused the upgrade (HTTP ${upgradeStatus(response)}` +
            `${refusal ? `, refusal=${refusal}` : ", refusal=none"})`,
        );
        local?.terminate();
      });
    });
    cloud.on("close", (code, reason) => closeBoth("relay side closed", relayCloseDetail(code, reason)));
    cloud.on("error", (error) => closeBoth("relay side failed", error));
    cloud.on("unexpected-response", (_request, response) => {
      closeBoth(`relay refused the tunnel upgrade (HTTP ${upgradeStatus(response)})`);
      cloud.terminate();
    });
  }
}
