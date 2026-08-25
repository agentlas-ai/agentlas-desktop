import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getSessionCookieHeader, webBaseUrl } from "../auth";

const WS_OPEN = 1;
const RELAY_FILE = "relay.json";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

interface RelaySocket {
  readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): this;
  on(event: "unexpected-response", listener: (request: unknown, response: unknown) => void): this;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
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

interface RelaySocketOptions {
  headers?: Record<string, string>;
  handshakeTimeout?: number;
  perMessageDeflate?: boolean;
  ca?: string;
  rejectUnauthorized?: boolean;
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

export interface MobileBridgeCloudRelayOptions {
  userDataPath: string;
  hostId: string;
  localEndpoint: string;
  certificateDer: string;
  onStatusChanged?: () => void;
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
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
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
function relayEndpoint(): string {
  const explicit = process.env.AGENTLAS_RELAY_URL?.trim();
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

function rawBytes(data: unknown): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === "string") return Buffer.byteLength(data);
  return MAX_PENDING_BYTES + 1;
}

export class MobileBridgeCloudRelay {
  // 서버가 알려주면 갱신된다. 못 받으면 여기 있는 값(환경변수 또는 웹 주소)을 계속 쓴다.
  private endpoint = relayEndpoint();
  // 환경변수로 못 박아 둔 경우에는 서버에 묻지 않는다 — 명시적 지정이 항상 이긴다.
  private readonly endpointIsPinned = Boolean(process.env.AGENTLAS_RELAY_URL?.trim());
  private endpointCheckedAt = 0;
  private readonly secret: string;
  private control: RelaySocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private retryAttempt = 0;
  // Deduplicates control-channel diagnostics so a 5s retry loop cannot spam the
  // log. Only transitions are logged, never the cookie or relay secret.
  private lastControlLog: "signed-out" | "connected" | "closed" | "error" | "rejected" | null = null;
  private readonly tunnels = new Set<RelaySocket>();

  constructor(private readonly options: MobileBridgeCloudRelayOptions) {
    this.secret = readOrCreateSecret(options.userDataPath);
  }

  pairingInfo(): { endpoint: string; secret: string } {
    return { endpoint: this.endpoint, secret: this.secret };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleConnect(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.control?.close(1000, "desktop stopping");
    this.control = null;
    for (const tunnel of this.tunnels) tunnel.close(1000, "desktop stopping");
    this.tunnels.clear();
  }

  private scheduleConnect(delay?: number): void {
    if (this.stopped || this.retryTimer) return;
    const wait = delay ?? Math.min(15_000, 1_000 * 2 ** Math.min(this.retryAttempt++, 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectControl();
    }, wait);
    this.retryTimer.unref?.();
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
    const cookie = getSessionCookieHeader();
    if (!cookie) {
      // The single most common reason remote access silently never works: the
      // relay tunnel requires this Desktop to be signed in to Agentlas.
      this.logControl("signed-out", "remote access paused — this Desktop is not signed in to Agentlas", true);
      this.options.onStatusChanged?.();
      this.scheduleConnect(5_000);
      return;
    }
    const socket = new RelayWebSocket(relayUrl(this.endpoint, {
      role: "desktop",
      hostId: this.options.hostId,
    }), {
      headers: { Cookie: cookie, "x-agentlas-relay-secret": this.secret },
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
    });
    this.control = socket;
    let opened = false;
    socket.on("open", () => {
      opened = true;
      this.retryAttempt = 0;
      this.logControl("connected", "remote access control channel connected");
      this.options.onStatusChanged?.();
    });
    socket.on("unexpected-response", (_request, response) => {
      const status =
        response && typeof response === "object" && "statusCode" in response
          ? (response as { statusCode?: unknown }).statusCode
          : "unknown";
      // Server-side reason, no secrets: 401 = bad relay credential/session,
      // 503 = relay endpoint unavailable, 429 = too many devices.
      this.logControl("rejected", `remote access control channel rejected by server (HTTP ${status})`, true);
    });
    socket.on("message", (data) => this.handleControlMessage(data));
    const disconnected = (...args: unknown[]) => {
      if (this.control !== socket) return;
      this.control = null;
      if (!opened) {
        socket.terminate();
        const detail = args[0] instanceof Error ? `: ${args[0].message}` : "";
        this.logControl("error", `remote access control channel unavailable${detail}`, true);
      } else {
        this.logControl("closed", "remote access control channel closed; retrying");
      }
      this.options.onStatusChanged?.();
      this.scheduleConnect();
    };
    socket.on("close", disconnected);
    socket.on("error", disconnected);
  }

  private handleControlMessage(data: unknown): void {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    if (message.type !== "relay.device") return;
    if (typeof message.channelId !== "string" || !CHANNEL_PATTERN.test(message.channelId)) return;
    if (typeof message.deviceToken !== "string" || !TOKEN_PATTERN.test(message.deviceToken)) return;
    this.openTunnel(message.channelId, message.deviceToken);
  }

  /**
   * 로컬 홉이 "재페어링만이 답"이라고 답했을 때 걸리는 래치. 걸린 동안은 터널을
   * 열지 않는다 — 열어도 같은 401이고, 폰은 그 사실을 알 수 없어 계속 두드린다.
   */
  private repairRequiredRefusal: string | null = null;

  /** 페어링 상태가 바뀌면 래치를 푼다(새 기기가 붙을 수 있게 된다). */
  clearRepairRequiredLatch(): void {
    if (!this.repairRequiredRefusal) return;
    this.repairRequiredRefusal = null;
    console.info("[mobile-bridge-relay] re-pairing latch cleared; tunnels may open again");
  }

  private openTunnel(channelId: string, deviceToken: string): void {
    const cookie = getSessionCookieHeader();
    if (!cookie || this.stopped) return;
    if (this.repairRequiredRefusal) {
      console.warn(
        `[mobile-bridge-relay] tunnel ${channelId} not opened: ${this.repairRequiredRefusal} — re-pair this Desktop`,
      );
      return;
    }
    const cloud = new RelayWebSocket(relayUrl(this.endpoint, {
      role: "tunnel",
      hostId: this.options.hostId,
      channelId,
    }), {
      headers: { Cookie: cookie, "x-agentlas-relay-secret": this.secret },
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
    });
    this.tunnels.add(cloud);
    let local: RelaySocket | null = null;
    let pending: Array<{ data: unknown; binary: boolean }> = [];
    let pendingBytes = 0;
    let closed = false;
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
          ` (localHopStarted=${reachedLocal})` +
          (detail ? ` — ${detail instanceof Error ? detail.message : String(detail)}` : ""),
      );
      if (cloud.readyState === WS_OPEN) cloud.close(1012, "tunnel closed");
      if (local?.readyState === WS_OPEN) local.close(1012, "tunnel closed");
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
      });
      local.on("open", () => {
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
          // 사유가 회복 불가면 재시도가 의미 없다. 래치를 걸어 다음 터널 요청을
          // 즉시 거절하고, 사람이 읽을 한 줄을 남긴다. 래치는 페어링이 바뀔 때 풀린다.
          this.repairRequiredRefusal = refusal;
          console.warn(
            `[mobile-bridge-relay] remote access needs re-pairing (${refusal}); ` +
              "not opening further tunnels until this Desktop is paired again",
          );
        }
        closeBoth(
          `local hop refused the upgrade (HTTP ${upgradeStatus(response)}` +
            `${refusal ? `, refusal=${refusal}` : ", refusal=none"})`,
        );
      });
    });
    cloud.on("close", () => closeBoth("relay side closed"));
    cloud.on("error", (error) => closeBoth("relay side failed", error));
    cloud.on("unexpected-response", (_request, response) =>
      closeBoth(`relay refused the tunnel upgrade (HTTP ${upgradeStatus(response)})`),
    );
  }
}
