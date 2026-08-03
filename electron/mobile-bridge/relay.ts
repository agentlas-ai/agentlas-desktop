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

function relayEndpoint(): string {
  const url = new URL(webBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/mobile/relay";
  url.search = "";
  url.hash = "";
  return url.toString();
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
  private readonly endpoint = relayEndpoint();
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

  private connectControl(): void {
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

  private openTunnel(channelId: string, deviceToken: string): void {
    const cookie = getSessionCookieHeader();
    if (!cookie || this.stopped) return;
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
      local.on("unexpected-response", (_request, response) =>
        closeBoth(`local hop refused the upgrade (HTTP ${upgradeStatus(response)})`),
      );
    });
    cloud.on("close", () => closeBoth("relay side closed"));
    cloud.on("error", (error) => closeBoth("relay side failed", error));
    cloud.on("unexpected-response", (_request, response) =>
      closeBoth(`relay refused the tunnel upgrade (HTTP ${upgradeStatus(response)})`),
    );
  }
}
