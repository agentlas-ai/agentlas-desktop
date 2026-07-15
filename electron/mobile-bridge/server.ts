import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

import {
  MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  MOBILE_BRIDGE_WRITE_METHODS,
  isMobileBridgeEventName,
  isMobileBridgeJsonValue,
  mobileBridgeFailure,
  mobileBridgePairFailure,
  mobileBridgeSuccess,
  parseMobileBridgePairExchangeRequest,
  parseMobileBridgeRequest,
  type MobileBridgeEventEnvelope,
  type MobileBridgeEventName,
  type MobileBridgeJsonValue,
  type MobileBridgePairExchangeRequest,
  type MobileBridgePairExchangeResponse,
  type MobileBridgeRpcRequest,
  type MobileBridgeServerMessage,
  type MobileBridgeSnapshot,
} from "../../shared/mobile-bridge";
import {
  fingerprintMobileBridgeRequest,
  type MobileBridgeReplayResponse,
  type MobileBridgeRequestReplayStore,
} from "./replay";
import { mobileBridgeJsonBytes } from "./sanitize";

// `ws` is currently present only as a transitive dependency of @google/genai.
// DESKTOP_MOBILE_BRIDGE: package.json must declare `ws` directly before the
// bridge is enabled in main.ts. Local structural types keep this isolated module
// typecheckable without editing the user's concurrently modified package file.
interface BridgeWebSocket {
  readyState: number;
  bufferedAmount: number;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "pong" | "close" | "error", listener: (...args: unknown[]) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface BridgeWebSocketServer {
  on(event: "connection", listener: (socket: BridgeWebSocket, request: http.IncomingMessage) => void): this;
  handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: BridgeWebSocket) => void,
  ): void;
  emit(event: "connection", socket: BridgeWebSocket, request: http.IncomingMessage): boolean;
  close(callback: (error?: Error) => void): void;
}

interface WsModule {
  WebSocketServer: new (options: {
    noServer: true;
    maxPayload: number;
    perMessageDeflate: false;
    clientTracking: true;
  }) => BridgeWebSocketServer;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require("ws") as WsModule;

const WS_OPEN = 1;
const DEFAULT_PATH = "/v1/mobile";
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_INFLIGHT_REQUESTS = 32;
const MAX_BUFFERED_BYTES = 4 * MOBILE_BRIDGE_MAX_MESSAGE_BYTES;
const MAX_CONNECTIONS = 24;
const MAX_CONNECTIONS_PER_DEVICE = 4;
const MAX_REQUESTS_PER_MINUTE = 300;
const MAX_PAIR_ATTEMPTS_PER_MINUTE = 10;
const MAX_INITIAL_EVENT_QUEUE = 512;
const MAX_INITIAL_EVENT_QUEUE_BYTES = 4 * MOBILE_BRIDGE_MAX_MESSAGE_BYTES;

export interface MobileBridgeConnectionContext {
  connectionId: string;
  remoteAddress: string | null;
  connectedAt: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: "ios" | "android" | "dev";
  devBootstrap: boolean;
}

export interface MobileBridgeAuthorityEvent {
  event: MobileBridgeEventName;
  payload: MobileBridgeJsonValue;
  occurredAt?: string;
}

/**
 * DESKTOP_MOBILE_BRIDGE: main.ts must inject the same authority used by Electron
 * IPC. The server never opens SQLite, creates an independent active-run registry,
 * or calls a model directly.
 */
export interface MobileBridgeAuthority {
  snapshot(context: MobileBridgeConnectionContext): Promise<MobileBridgeSnapshot>;
  request(
    request: MobileBridgeRpcRequest,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeJsonValue | undefined>;
  subscribe(listener: (event: MobileBridgeAuthorityEvent) => void): () => void;
}

export interface MobileBridgeAuthenticatedDevice {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
}

export interface MobileBridgePairingAuthority {
  authenticate(token: string): MobileBridgeAuthenticatedDevice | null;
  exchange(request: MobileBridgePairExchangeRequest): {
    deviceId: string;
    token: string;
    issuedAt: string;
  };
}

export interface AgentlasMobileBridgeServerOptions {
  authority: MobileBridgeAuthority;
  pairing?: MobileBridgePairingAuthority;
  /** Durable write-ahead request ledger. Production runtime always supplies it. */
  replayStore?: MobileBridgeRequestReplayStore;
  /** DESKTOP_MOBILE_BRIDGE: Explicit current-Mac/dev bootstrap only. */
  devBootstrapToken?: string;
  host?: string;
  port?: number;
  path?: string;
  tls?: https.ServerOptions;
  pingIntervalMs?: number;
  requestTimeoutMs?: number;
  relayPairingInfo?: () => { endpoint: string; secret: string } | null;
  onError?: (error: Error) => void;
}

export interface AgentlasMobileBridgeServerAddress {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  url: string;
}

interface ConnectionState {
  socket: BridgeWebSocket;
  context: MobileBridgeConnectionContext;
  alive: boolean;
  inflight: Set<string>;
  initialized: boolean;
  eventSeq: number;
  pendingAuthorityEvents: MobileBridgeAuthorityEvent[];
  pendingAuthorityBytes: number;
  revoked: boolean;
  revocationPending: boolean;
  requestWindowStartedAt: number;
  requestCount: number;
}

interface UpgradeIdentity {
  deviceId: string;
  deviceName: string;
  devicePlatform: "ios" | "android" | "dev";
  devBootstrap: boolean;
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** DESKTOP_MOBILE_BRIDGE: bearer comparison never exits on a matching prefix. */
export function secureMobileBridgeTokenEquals(expected: string, actual: string): boolean {
  const expectedDigest = digestToken(expected);
  const actualDigest = digestToken(actual);
  return timingSafeEqual(expectedDigest, actualDigest);
}

function bearerToken(request: http.IncomingMessage): string | null {
  const raw = request.headers.authorization;
  if (typeof raw !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(raw);
  return match?.[1] ?? null;
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 404 | 405 | 503, message: string): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Rejected"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
  socket.destroy();
}

function rawMessageBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) return Buffer.concat(data);
  return null;
}

function asWireJson(value: unknown): MobileBridgeJsonValue | null {
  return isMobileBridgeJsonValue(value) ? value : null;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function responseForRequest(
  response: MobileBridgeReplayResponse,
  requestId: string,
): MobileBridgeReplayResponse {
  return response.ok
    ? { ...response, id: requestId }
    : { ...response, id: requestId };
}

type PairingFailureCode = "pairing_denied" | "pairing_expired" | "pairing_unavailable";

function pairingFailureCode(value: unknown): PairingFailureCode | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  return code === "pairing_denied" || code === "pairing_expired" || code === "pairing_unavailable"
    ? code
    : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mobile Bridge authority request timed out")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AgentlasMobileBridgeServer {
  readonly host: string;
  readonly port: number;
  readonly path: string;

  private readonly authority: MobileBridgeAuthority;
  private readonly pairing?: MobileBridgePairingAuthority;
  private readonly replayStore?: MobileBridgeRequestReplayStore;
  private readonly devBootstrapToken?: string;
  private readonly tls?: https.ServerOptions;
  private readonly pingIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly relayPairingInfo?: () => { endpoint: string; secret: string } | null;
  private readonly onError: (error: Error) => void;
  private readonly clients = new Set<ConnectionState>();
  private readonly upgradeIdentities = new WeakMap<http.IncomingMessage, UpgradeIdentity>();
  private readonly webSocketServer: BridgeWebSocketServer;
  private readonly pairAttemptsByAddress = new Map<string, number[]>();
  private httpServer: http.Server | https.Server | null = null;
  private unsubscribeAuthority: (() => void) | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private startedAddress: AgentlasMobileBridgeServerAddress | null = null;

  constructor(options: AgentlasMobileBridgeServerOptions) {
    if (!options.pairing && !options.devBootstrapToken) {
      throw new Error("Agentlas Mobile Bridge requires a device pairing authority");
    }
    if (options.devBootstrapToken) {
      if (process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP !== "1") {
        throw new Error("Agentlas Mobile Bridge dev bootstrap requires AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP=1");
      }
      if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.devBootstrapToken)) {
        throw new Error("Agentlas Mobile Bridge dev bootstrap requires a random 256-bit token");
      }
    }
    const route = options.path ?? DEFAULT_PATH;
    if (!route.startsWith("/") || route.includes("?") || route.includes("#")) {
      throw new Error("Agentlas Mobile Bridge path must be an absolute URL path");
    }
    this.authority = options.authority;
    this.pairing = options.pairing;
    this.replayStore = options.replayStore;
    this.devBootstrapToken = options.devBootstrapToken;
    // DESKTOP_MOBILE_BRIDGE: localhost is the constructor default. Runtime may
    // opt into a concrete LAN address only when pinned TLS material is present.
    this.host = options.host ?? "127.0.0.1";
    if (!options.tls && !isLoopbackHost(this.host)) {
      throw new Error("Agentlas Mobile Bridge requires TLS for non-loopback binds");
    }
    this.port = options.port ?? 0;
    this.path = route;
    this.tls = options.tls;
    this.pingIntervalMs = Math.max(5_000, options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.relayPairingInfo = options.relayPairingInfo;
    this.onError = options.onError ?? ((error) => console.error("[mobile-bridge]", error.message));
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.webSocketServer.on("connection", (socket, request) => this.accept(socket, request));
  }

  async start(): Promise<AgentlasMobileBridgeServerAddress> {
    if (this.startedAddress) return this.startedAddress;
    if (this.httpServer) throw new Error("Agentlas Mobile Bridge is already starting");

    const server = this.tls
      ? https.createServer(this.tls, (request, response) => void this.handleHttp(request, response))
      : http.createServer((request, response) => void this.handleHttp(request, response));
    this.httpServer = server;
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    server.on("error", (error) => this.onError(errorOf(error)));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(this.port, this.host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.httpServer = null;
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Agentlas Mobile Bridge did not receive a TCP address");
    }
    const secure = Boolean(this.tls);
    const urlHost = this.host.includes(":") ? `[${this.host}]` : this.host;
    this.startedAddress = {
      host: this.host,
      port: address.port,
      path: this.path,
      secure,
      url: `${secure ? "wss" : "ws"}://${urlHost}:${address.port}${this.path}`,
    };

    // DESKTOP_MOBILE_BRIDGE: Authority events are the only live source. No
    // synthetic progress or reconnect fallback is emitted by the socket layer.
    this.unsubscribeAuthority = this.authority.subscribe((event) => this.fanoutAuthorityEvent(event));
    this.pingTimer = setInterval(() => this.checkLiveness(), this.pingIntervalMs);
    this.pingTimer.unref?.();
    return this.startedAddress;
  }

  private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.startedAddress) {
      rejectUpgrade(socket, 503, "bridge unavailable");
      return;
    }
    if (request.method !== "GET") {
      rejectUpgrade(socket, 405, "method not allowed");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://agentlas.local");
    } catch {
      rejectUpgrade(socket, 400, "bad request");
      return;
    }
    if (url.pathname !== this.path || url.search || url.hash) {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    const presented = bearerToken(request);
    if (!presented) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    let identity: UpgradeIdentity | null = null;
    try {
      const device = this.pairing?.authenticate(presented) ?? null;
      if (device) {
        identity = {
          deviceId: device.deviceId,
          deviceName: device.name,
          devicePlatform: device.platform,
          devBootstrap: false,
        };
      } else if (
        this.devBootstrapToken &&
        process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP === "1" &&
        secureMobileBridgeTokenEquals(this.devBootstrapToken, presented)
      ) {
        identity = {
          deviceId: "device_dev_bootstrap",
          deviceName: "Current Mac development client",
          devicePlatform: "dev",
          devBootstrap: true,
        };
      }
    } catch (error) {
      this.onError(errorOf(error));
    }
    if (!identity) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    if (
      this.clients.size >= MAX_CONNECTIONS ||
      [...this.clients].filter((state) => state.context.deviceId === identity.deviceId).length >=
        MAX_CONNECTIONS_PER_DEVICE
    ) {
      rejectUpgrade(socket, 503, "connection limit reached");
      return;
    }
    this.upgradeIdentities.set(request, identity);
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSocketServer.emit("connection", webSocket, request);
    });
  }

  private accept(socket: BridgeWebSocket, request: http.IncomingMessage): void {
    const identity = this.upgradeIdentities.get(request);
    this.upgradeIdentities.delete(request);
    if (!identity) {
      socket.close(1008, "authentication required");
      return;
    }
    const state: ConnectionState = {
      socket,
      context: {
        connectionId: randomUUID(),
        remoteAddress: request.socket.remoteAddress ?? null,
        connectedAt: new Date().toISOString(),
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        devicePlatform: identity.devicePlatform,
        devBootstrap: identity.devBootstrap,
      },
      alive: true,
      inflight: new Set(),
      initialized: false,
      eventSeq: 0,
      pendingAuthorityEvents: [],
      pendingAuthorityBytes: 0,
      revoked: false,
      revocationPending: false,
      requestWindowStartedAt: Date.now(),
      requestCount: 0,
    };
    this.clients.add(state);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data, isBinary) => this.receive(state, data, isBinary));
    socket.on("error", (error) => this.onError(errorOf(error)));
    socket.on("close", () => {
      state.inflight.clear();
      state.pendingAuthorityEvents.length = 0;
      state.pendingAuthorityBytes = 0;
      this.clients.delete(state);
    });
    void this.sendInitialState(state);
  }

  private async handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://agentlas.local");
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }
    if (url.pathname !== MOBILE_BRIDGE_PAIR_EXCHANGE_PATH || url.search || url.hash) {
      response.writeHead(404).end("not found");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end("method not allowed");
      return;
    }
    if (!this.pairing) {
      this.sendPairResponse(response, 503, mobileBridgePairFailure(null, "pairing_unavailable", "Pairing is unavailable"));
      return;
    }
    if (!this.consumePairAttempt(request.socket.remoteAddress ?? "unknown")) {
      response.writeHead(429, { "cache-control": "no-store" }).end("too many pairing attempts");
      return;
    }
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      response.writeHead(415).end("application/json required");
      return;
    }
    const body = await this.readPairBody(request);
    if (body === null) {
      response.writeHead(413).end("request too large");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      this.sendPairResponse(response, 400, mobileBridgePairFailure(null, "invalid_pairing_request", "Invalid pairing request"));
      return;
    }
    const parsed = parseMobileBridgePairExchangeRequest(raw);
    if (!parsed.ok) {
      this.sendPairResponse(response, 400, parsed.error);
      return;
    }
    try {
      const credential = this.pairing.exchange(parsed.value);
      const relay = this.relayPairingInfo?.() ?? null;
      this.sendPairResponse(response, 200, {
        v: MOBILE_BRIDGE_PROTOCOL_VERSION,
        type: "pair.exchange.response",
        id: parsed.value.id,
        ok: true,
        credential,
        ...(relay ? { relay } : {}),
      });
    } catch (error) {
      // DESKTOP_MOBILE_BRIDGE: Never log the raw request/code or returned token.
      const code = pairingFailureCode(error) ?? "pairing_unavailable";
      const status = code === "pairing_expired" ? 410 : code === "pairing_denied" ? 401 : 503;
      this.sendPairResponse(
        response,
        status,
        mobileBridgePairFailure(
          parsed.value.id,
          code,
          code === "pairing_expired" ? "Pairing code expired" : code === "pairing_denied" ? "Pairing denied" : "Pairing unavailable",
        ),
      );
    }
  }

  private readPairBody(request: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      request.setTimeout(10_000, () => {
        finish(null);
        request.destroy();
      });
      request.on("data", (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > 16 * 1024) {
          finish(null);
          request.resume();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
      request.on("error", () => finish(null));
    });
  }

  private sendPairResponse(
    response: http.ServerResponse,
    status: number,
    payload: MobileBridgePairExchangeResponse,
  ): void {
    const encoded = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(encoded),
    });
    response.end(encoded);
  }

  private async sendInitialState(state: ConnectionState): Promise<void> {
    try {
      const snapshot = await this.authority.snapshot(state.context);
      if (!isMobileBridgeJsonValue(snapshot)) throw new Error("Mobile Bridge snapshot is not JSON-safe");
      if (state.revoked || !this.clients.has(state) || state.socket.readyState !== WS_OPEN) return;
      const snapshotProbe: MobileBridgeEventEnvelope = {
        v: MOBILE_BRIDGE_PROTOCOL_VERSION,
        type: "event",
        seq: 2,
        event: "snapshot.updated",
        occurredAt: new Date().toISOString(),
        payload: snapshot as unknown as MobileBridgeJsonValue,
      };
      if (mobileBridgeJsonBytes(snapshotProbe) > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
        this.onError(new Error("Mobile Bridge initial snapshot exceeded the wire limit"));
        state.socket.close(1009, "snapshot too large");
        return;
      }
      // DESKTOP_MOBILE_BRIDGE: The Cloud Relay route is re-advertised on every
      // authenticated connection, not only at pair time. A phone paired before
      // this Desktop had a relay (or before a relay endpoint/secret rotation)
      // otherwise keeps a null route forever and silently refuses to fall back
      // — it just fails against a LAN address it can no longer reach. Sending
      // it here lets an existing pairing recover with no re-pair. This is the
      // same secret-free-per-contract payload the pair exchange returns, and it
      // only ever crosses an already-authenticated, host-verified socket.
      const relay = this.relayPairingInfo?.() ?? null;
      this.sendEvent(state, "bridge.ready", {
        protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
        connectionId: state.context.connectionId,
        hostId: snapshot.host.id,
        ...(relay ? { relay } : {}),
      });
      this.sendEvent(state, "snapshot.updated", snapshot as unknown as MobileBridgeJsonValue);
      if (state.socket.readyState !== WS_OPEN) return;

      // DESKTOP_MOBILE_BRIDGE: Authority events observed while snapshotting are
      // released only after ready + snapshot. Per-client seq remains contiguous.
      const pending = state.pendingAuthorityEvents.splice(0);
      state.pendingAuthorityBytes = 0;
      state.initialized = true;
      for (const event of pending) {
        this.sendEvent(state, event.event, event.payload, event.occurredAt);
        if (state.socket.readyState !== WS_OPEN) break;
      }
    } catch (error) {
      this.onError(errorOf(error));
      state.socket.close(1011, "snapshot unavailable");
    }
  }

  private receive(state: ConnectionState, raw: unknown, isBinary: boolean): void {
    if (state.revoked || state.revocationPending || !this.clients.has(state)) {
      state.socket.terminate();
      return;
    }
    if (!state.initialized) {
      // A client must establish its baseline before issuing stateful commands.
      state.socket.close(1008, "initial state pending");
      return;
    }
    const now = Date.now();
    if (now - state.requestWindowStartedAt >= 60_000) {
      state.requestWindowStartedAt = now;
      state.requestCount = 0;
    }
    state.requestCount += 1;
    if (state.requestCount > MAX_REQUESTS_PER_MINUTE) {
      state.socket.close(1008, "request rate exceeded");
      return;
    }
    if (isBinary) {
      state.socket.close(1003, "text messages only");
      return;
    }
    const bytes = rawMessageBuffer(raw);
    if (!bytes) {
      state.socket.close(1007, "invalid payload");
      return;
    }
    if (bytes.byteLength > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
      state.socket.close(1009, "message too large");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      state.socket.close(1007, "invalid json");
      return;
    }
    const parsed = parseMobileBridgeRequest(decoded);
    if (!parsed.ok) {
      this.send(state, parsed.error);
      return;
    }
    if (state.inflight.has(parsed.value.id)) {
      this.send(state, mobileBridgeFailure(parsed.value.id, "duplicate_request", "Request id is already in flight"));
      return;
    }
    if (state.inflight.size >= MAX_INFLIGHT_REQUESTS) {
      this.send(state, mobileBridgeFailure(parsed.value.id, "too_many_requests", "Too many requests are in flight", true));
      return;
    }
    state.inflight.add(parsed.value.id);
    void this.dispatch(state, parsed.value).finally(() => state.inflight.delete(parsed.value.id));
  }

  private async dispatch(state: ConnectionState, request: MobileBridgeRpcRequest): Promise<void> {
    if (state.revoked || !this.clients.has(state)) return;
    const selfRevocation = request.method === "device.revokeSelf";
    const writeRequest = MOBILE_BRIDGE_WRITE_METHODS.has(request.method);
    const replayKey = request.idempotencyKey ?? request.id;
    const replayFingerprint = writeRequest ? fingerprintMobileBridgeRequest(request) : null;
    if (writeRequest) {
      if (!this.replayStore || !replayFingerprint) {
        this.send(
          state,
          mobileBridgeFailure(
            request.id,
            "idempotency_unavailable",
            "Desktop write protection is unavailable; the command was not run",
          ),
        );
        return;
      }
      try {
        const replay = this.replayStore.begin(
          state.context.deviceId,
          replayKey,
          replayFingerprint,
        );
        if (replay.kind === "replay") {
          this.send(state, responseForRequest(replay.response, request.id));
          return;
        }
        if (replay.kind !== "execute") {
          const response = replay.kind === "conflict"
            ? mobileBridgeFailure(
                request.id,
                "idempotency_conflict",
                "Idempotency key was already used for a different command",
              )
            : replay.kind === "in-progress"
              ? mobileBridgeFailure(
                  request.id,
                  "idempotency_in_progress",
                  "The same Desktop command is still in progress",
                  true,
                )
              : mobileBridgeFailure(
                  request.id,
                  "idempotency_uncertain",
                  "Desktop cannot prove whether the earlier command completed; it will not run it again",
                );
          this.send(state, response);
          return;
        }
      } catch (error) {
        this.onError(errorOf(error));
        this.send(
          state,
          mobileBridgeFailure(
            request.id,
            "idempotency_unavailable",
            "Desktop could not establish durable write protection; the command was not run",
          ),
        );
        return;
      }
    }

    if (selfRevocation) this.markDeviceRevocationPending(state.context.deviceId);
    const authorityPromise = this.authority.request(request, state.context);
    try {
      const result = await withTimeout(authorityPromise, this.requestTimeoutMs);
      let response = this.responseFromAuthority(request.id, result);
      if (writeRequest && this.replayStore && replayFingerprint) {
        response = this.completeReplay(
          state.context.deviceId,
          replayKey,
          replayFingerprint,
          response,
          request.id,
        );
      }
      if (selfRevocation) {
        this.sendSelfRevocationAckAndDisconnect(state, response);
        return;
      }
      if (state.revoked || state.revocationPending || !this.clients.has(state)) return;
      this.send(state, response);
    } catch (error) {
      const normalized = errorOf(error);
      this.onError(normalized);
      if (selfRevocation) this.clearDeviceRevocationPending(state.context.deviceId);
      const timeout = normalized.message === "Mobile Bridge authority request timed out";
      if (timeout && writeRequest && this.replayStore && replayFingerprint) {
        try {
          this.replayStore.markUncertain(state.context.deviceId, replayKey, replayFingerprint);
        } catch (ledgerError) {
          this.onError(errorOf(ledgerError));
        }
        // The authority promise is deliberately not cancelled. If it eventually
        // settles in this process, make its actual result replayable. A crash
        // leaves the write-ahead entry uncertain and future retries fail closed.
        void authorityPromise.then(
          (result) => {
            const response = this.responseFromAuthority(request.id, result);
            this.completeReplay(
              state.context.deviceId,
              replayKey,
              replayFingerprint,
              response,
              request.id,
            );
          },
          () => {
            this.completeReplay(
              state.context.deviceId,
              replayKey,
              replayFingerprint,
              mobileBridgeFailure(request.id, "authority_error", "Desktop rejected the request"),
              request.id,
            );
          },
        ).catch((ledgerError) => this.onError(errorOf(ledgerError)));
      }
      let response: MobileBridgeReplayResponse = mobileBridgeFailure(
        request.id,
        timeout ? "request_timeout" : "authority_error",
        timeout ? "Desktop did not answer in time" : "Desktop rejected the request",
        timeout,
      );
      if (!timeout && writeRequest && this.replayStore && replayFingerprint) {
        response = this.completeReplay(
          state.context.deviceId,
          replayKey,
          replayFingerprint,
          response,
          request.id,
        );
      }
      if (state.revoked || state.revocationPending || !this.clients.has(state)) return;
      this.send(state, response);
    }
  }

  private responseFromAuthority(
    requestId: string,
    result: MobileBridgeJsonValue | undefined,
  ): MobileBridgeReplayResponse {
    const json = result === undefined ? null : asWireJson(result);
    if (json === null && result !== undefined && result !== null) {
      throw new TypeError("Mobile Bridge authority returned a non-JSON result");
    }
    const response = mobileBridgeSuccess(requestId, json);
    if (mobileBridgeJsonBytes(response) > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
      return mobileBridgeFailure(
        requestId,
        "response_too_large",
        "Desktop response exceeds the Mobile Bridge wire budget",
      );
    }
    return response;
  }

  private completeReplay(
    deviceId: string,
    key: string,
    fingerprint: string,
    response: MobileBridgeReplayResponse,
    requestId: string,
  ): MobileBridgeReplayResponse {
    if (!this.replayStore) {
      return mobileBridgeFailure(
        requestId,
        "idempotency_unavailable",
        "Desktop could not persist the command result safely",
      );
    }
    try {
      this.replayStore.complete(deviceId, key, fingerprint, response);
      return response;
    } catch (error) {
      this.onError(errorOf(error));
      try {
        this.replayStore.markUncertain(deviceId, key, fingerprint);
      } catch (ledgerError) {
        this.onError(errorOf(ledgerError));
      }
      return mobileBridgeFailure(
        requestId,
        "idempotency_unavailable",
        "Desktop ran the command but could not persist its replay result; retry is blocked",
      );
    }
  }

  private fanoutAuthorityEvent(event: MobileBridgeAuthorityEvent): void {
    if (!isMobileBridgeEventName(event.event) || !isMobileBridgeJsonValue(event.payload)) {
      this.onError(new Error("Mobile Bridge authority emitted an invalid event"));
      return;
    }
    const queuedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    for (const state of this.clients) {
      if (state.revoked || state.revocationPending) continue;
      if (!state.initialized) {
        if (
          state.pendingAuthorityEvents.length >= MAX_INITIAL_EVENT_QUEUE ||
          state.pendingAuthorityBytes + queuedBytes > MAX_INITIAL_EVENT_QUEUE_BYTES
        ) {
          state.pendingAuthorityEvents.length = 0;
          state.pendingAuthorityBytes = 0;
          state.socket.close(1013, "initialization backlog exceeded");
          this.clients.delete(state);
          continue;
        }
        state.pendingAuthorityEvents.push(event);
        state.pendingAuthorityBytes += queuedBytes;
        continue;
      }
      this.sendEvent(state, event.event, event.payload, event.occurredAt);
    }
  }

  private eventEnvelope(
    state: ConnectionState,
    event: MobileBridgeEventName,
    payload: MobileBridgeJsonValue,
    occurredAt = new Date().toISOString(),
  ): MobileBridgeEventEnvelope {
    state.eventSeq += 1;
    return {
      v: MOBILE_BRIDGE_PROTOCOL_VERSION,
      type: "event",
      seq: state.eventSeq,
      event,
      occurredAt,
      payload,
    };
  }

  private sendEvent(
    state: ConnectionState,
    event: MobileBridgeEventName,
    payload: MobileBridgeJsonValue,
    occurredAt?: string,
  ): void {
    this.send(state, this.eventEnvelope(state, event, payload, occurredAt));
  }

  private send(state: ConnectionState, message: MobileBridgeServerMessage): void {
    if (state.revoked || state.socket.readyState !== WS_OPEN) return;
    if (state.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      state.socket.terminate();
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch (error) {
      this.onError(errorOf(error));
      state.socket.close(1011, "serialization failed");
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
      this.onError(new Error("Mobile Bridge outbound message exceeded the wire limit"));
      state.socket.close(1009, "message too large");
      return;
    }
    state.socket.send(encoded, (error) => {
      if (error) this.onError(error);
    });
  }

  private markDeviceRevocationPending(deviceId: string): void {
    for (const state of this.clients) {
      if (state.context.deviceId === deviceId) state.revocationPending = true;
    }
  }

  private clearDeviceRevocationPending(deviceId: string): void {
    for (const state of this.clients) {
      if (state.context.deviceId === deviceId && !state.revoked) state.revocationPending = false;
    }
  }

  /**
   * Persisted credential revocation happens in authority first. Then every
   * socket sharing that device identity is frozen immediately, while the
   * requesting socket gets exactly one terminal acknowledgement before close.
   */
  private sendSelfRevocationAckAndDisconnect(
    requestingState: ConnectionState,
    response: MobileBridgeReplayResponse,
  ): void {
    let encoded: string;
    try {
      encoded = JSON.stringify(response);
    } catch (error) {
      this.onError(errorOf(error));
      encoded = "";
    }
    const sendable =
      encoded.length > 0 &&
      Buffer.byteLength(encoded, "utf8") <= MOBILE_BRIDGE_MAX_MESSAGE_BYTES &&
      requestingState.socket.readyState === WS_OPEN;

    for (const state of [...this.clients]) {
      if (state.context.deviceId !== requestingState.context.deviceId) continue;
      state.revoked = true;
      state.revocationPending = false;
      state.inflight.clear();
      state.pendingAuthorityEvents.length = 0;
      state.pendingAuthorityBytes = 0;
      this.clients.delete(state);
      if (state !== requestingState) state.socket.terminate();
    }

    if (!sendable) {
      requestingState.socket.terminate();
      return;
    }
    requestingState.socket.send(encoded, (error) => {
      if (error) {
        this.onError(error);
        requestingState.socket.terminate();
        return;
      }
      requestingState.socket.close(1000, "device revoked");
    });
  }

  private checkLiveness(): void {
    for (const state of this.clients) {
      if (state.revoked) {
        state.socket.terminate();
        this.clients.delete(state);
        continue;
      }
      if (!state.alive) {
        state.socket.terminate();
        this.clients.delete(state);
        continue;
      }
      state.alive = false;
      try {
        state.socket.ping();
      } catch (error) {
        this.onError(errorOf(error));
        state.socket.terminate();
        this.clients.delete(state);
      }
    }
  }

  private consumePairAttempt(remoteAddress: string): boolean {
    const now = Date.now();
    const recent = (this.pairAttemptsByAddress.get(remoteAddress) ?? []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (recent.length >= MAX_PAIR_ATTEMPTS_PER_MINUTE) {
      this.pairAttemptsByAddress.set(remoteAddress, recent);
      return false;
    }
    recent.push(now);
    this.pairAttemptsByAddress.set(remoteAddress, recent);
    if (this.pairAttemptsByAddress.size > 512) {
      for (const [address, attempts] of this.pairAttemptsByAddress) {
        if (!attempts.some((timestamp) => now - timestamp < 60_000)) {
          this.pairAttemptsByAddress.delete(address);
        }
      }
    }
    return true;
  }

  /** DESKTOP_MOBILE_BRIDGE: revocation takes effect on live sockets immediately. */
  disconnectDevice(deviceId: string): void {
    for (const state of this.clients) {
      if (state.context.deviceId !== deviceId) continue;
      // DESKTOP_MOBILE_BRIDGE: Mark first so message/dispatch callbacks that
      // are already queued cannot race one final command or response through.
      state.revoked = true;
      state.revocationPending = false;
      state.inflight.clear();
      state.pendingAuthorityEvents.length = 0;
      state.pendingAuthorityBytes = 0;
      this.clients.delete(state);
      state.socket.terminate();
    }
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.unsubscribeAuthority?.();
    this.unsubscribeAuthority = null;
    for (const state of this.clients) {
      state.revoked = true;
      state.socket.terminate();
    }
    this.clients.clear();
    this.pairAttemptsByAddress.clear();

    const webSocketClose = new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    const server = this.httpServer;
    this.httpServer = null;
    this.startedAddress = null;
    const httpClose = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    await Promise.all([webSocketClose, httpClose]);
  }
}
