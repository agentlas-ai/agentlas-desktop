import {isOneMobileSecureMethod} from "../secrets/one-mobile-secure";
import {OneVaultError} from "../../shared/one-vault";
import {OneProviderRemoteError} from "../../shared/one-provider-remote";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

import {
  MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  MOBILE_BRIDGE_SELF_IDEMPOTENT_WRITE_METHODS,
  MOBILE_BRIDGE_WRITE_METHODS,
  MOBILE_BRIDGE_VISUAL_FRAME_MAGIC,
  MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES,
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
  type MobileBridgePairExchangeFailure,
  type MobileBridgePairExchangeResponse,
  type MobileBridgeRpcRequest,
  type MobileBridgeServerMessage,
  type MobileBridgeSnapshot,
  type MobileBridgeVisualFrameDto,
  type MobileBridgeVisualSessionRefusalDto,
  type MobileClientCapability,
} from "../../shared/mobile-bridge";
import type { MobileBridgeVisualBinaryFrame } from "./visual-session";
import {
  fingerprintMobileBridgeRequest,
  type MobileBridgeReplayResponse,
  type MobileBridgeRequestReplayStore,
} from "./replay";
import { mobileBridgeJsonBytes } from "./sanitize";
import { mobileBridgeMailReplayMayRerun } from "./mail-replay-policy";
import { mobileBridgeIsOwnerMessage, mobileBridgeOrphanMayRerun, mobileBridgeTransientReplayMayRerun } from "./orphan-rerun-policy";
import { isTransientSendRefusalCode, sendRefusalCode, isStoreBusyRefusedBeforeDispatch, transientSendBackoffMs } from "../../shared/transient-send-refusal";
import { MobileBridgeNotReady, mobileBridgeSpecificRefusal } from "../../shared/mobile-bridge-refusal";
import {
  LONG_OPS_ACK_MS,
  LONG_OPS_MAX_RECEIVED_PER_DEVICE,
  MOBILE_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS,
  buildLongOpsV1,
  longOpWriteMaxMs,
  type RequestAcceptedPayload,
} from "./long-ops";

/**
 * A phone write the Desktop refused only because the chat (or its channel) was not ready yet: the codes of
 * shared/transient-send-refusal.ts, every one refused before anything reached a model. It is not the command's final
 * word (no-dead-end sweep 2026-10-25): it used to be stored in the replay ledger as "authority_error / Desktop rejected
 * the request", so the phone's retry with the same key got the same refusal back for 24 h. The ledger entry is released
 * and the phone gets a retryable, typed answer instead (old apps read it as an ordinary retryable failure: the error
 * object keeps exactly {code, message, retryable}).
 */
export const MOBILE_BRIDGE_DESKTOP_NOT_READY_CODE = "desktop_not_ready";
export function mobileBridgeNotReadyRefusal(error: unknown): string | null {
  if (error instanceof MobileBridgeNotReady) return error.code;
  const code = sendRefusalCode(error);
  if (code && isTransientSendRefusalCode(code)) return code;
  return isStoreBusyRefusedBeforeDispatch(error) ? "store_busy" : null;
}
import {
  RELAY_PAIR_CODE_PLACEHOLDER,
  parseRelayPairRequestFrame,
  relayPairMacMatches,
  relayPairRefusedFrame,
  relayPairRequestMac,
  relayPairResponseFrame,
} from "./relay-pairing";
import type { MobileBridgeRevocationCause } from "./pairing";

// `ws` is currently present only as a transitive dependency of @google/genai.
// DESKTOP_MOBILE_BRIDGE: package.json must declare `ws` directly before the
// bridge is enabled in main.ts. Local structural types keep this isolated module
// typecheckable without editing the user's concurrently modified package file.
interface BridgeWebSocket {
  readyState: number;
  bufferedAmount: number;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "pong" | "close" | "error", listener: (...args: unknown[]) => void): this;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
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

/** The turn-starting doors that refuse with the personal agent's home state (`one_sealed` / `one_away`) besides the `one.supervisor.*` family. */
const ONE_HOME_TURN_METHODS: ReadonlySet<string> = new Set(["one.invoke.start", "invoke.start", "invoke.steer"]);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require("ws") as WsModule;

const WS_OPEN = 1;
const DEFAULT_PATH = "/v1/mobile";
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = MOBILE_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS;
const MAX_INFLIGHT_REQUESTS = 32;
const MAX_BUFFERED_BYTES = 4 * MOBILE_BRIDGE_MAX_MESSAGE_BYTES;
const MAX_CONNECTIONS = 24;
// A device credential identifies one logical Mobile app session. Allowing the
// same credential to accumulate several live sockets hid leaked/retried Mobile
// transports behind one device row, then made the relay's next local hop fail
// with an opaque 503. The newest authenticated socket owns the credential; the
// previous socket is closed with the matching Mobile contract below.
const MAX_CONNECTIONS_PER_DEVICE = 1;
const SUPERSEDED_CONNECTION_CLOSE_CODE = 4001;
const SUPERSEDED_CONNECTION_CLOSE_REASON = "superseded by a newer connection";
// "Try again later" (RFC 6455 1013). The phone treats close code 1008 (policy violation) as a permanent rejection in every build
// (web_socket_desktop_transport.dart onDone): it stops reconnecting until the app returns to the foreground or the
// owner taps retry. A socket this Desktop closes because its own secure channel could not be set up, or was closed, says nothing
// about the phone; a fresh connection starts from the full device authentication again. Those closes use this code instead.
const RETRY_LATER_CLOSE_CODE = 1013;
// How long a phone READ waits for the Desktop to become ready before it is answered desktop_not_ready (readWhenReady).
// Below the phone's own 30 s request timeout, so the phone is answered rather than timing out.
const DEFAULT_READ_NOT_READY_WAIT_MS = 20_000;
// A refused-because-signed-out upgrade is retried by every open phone; log it at most this often.
const SIGNED_OUT_REFUSAL_LOG_INTERVAL_MS = 60_000;
/*
 * 분당 요청 한도.
 * 전에는 301번째 요청에서 소켓을 1008 "request rate exceeded"로 닫았다 — 폰 이후 빌드는 그 낱말을 백오프 재연결로 읽지만
 * (web_socket_desktop_transport.dart:226-230, 1905-1921) 그 이전 빌드는 1008을 영구 거절로 읽어 오너가 다시 누를 때까지 연결을 포기한다.
 * 지금은 한도를 넘은 요청에 **그 요청 하나**를 "재시도 가능한 거절"(`too_many_requests`, retryable — 폰이 이미 아는 모양: 동시 32개 초과·영상 청크 예산이 쓰는
 * 같은 응답, reply_failure_copy.dart:100·app_controller.dart:4475)으로 답하고 소켓은 닫지 않는다. 아무것도 실행하지 않는다. 다음 60초 창이 열리면 스스로 다시 된다.
 * 값 300: **정한 값 — 근거 없음**. 짝 시험대 2차 로그(evidence/pair-rig/round2/logs)에는 폰이 보낸 요청 수 기록이 없어 폰의 실제 분당 최대를 세지 못했다
 * (데스크탑의 request-timing 로그도 느린 요청만 남긴다). 정상 사용에서 닿았다는 보고는 없다.
 * 한도의 두 배(600)를 넘는 폭주는 거절 응답이 또 다른 폭주가 되지 않게 1013(RETRY_LATER)으로 닫는다 — 1013은 모든 폰 빌드가 재연결로 읽는다. 600도 정한 값 — 근거 없음.
 */
const MAX_REQUESTS_PER_MINUTE = 300;
const MAX_REQUESTS_PER_MINUTE_HARD = 2 * MAX_REQUESTS_PER_MINUTE;
// Video and attachment chunks wait (retryable) past this many requests in a minute; the rest of the 300 stays for Stop and approvals.
const MOBILE_CHUNK_REQUEST_BUDGET = 240;
const MAX_PAIR_ATTEMPTS_PER_MINUTE = 10;
const MAX_INITIAL_EVENT_QUEUE = 512;
const MAX_INITIAL_EVENT_QUEUE_BYTES = 4 * MOBILE_BRIDGE_MAX_MESSAGE_BYTES;

import {currentOneMobileSocketOwner,type OneMobileSocketOwner} from '../secrets/one-mobile-socket';
export interface MobileBridgeConnectionContext {
  connectionId: string;
  remoteAddress: string | null;
  connectedAt: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: "ios" | "android" | "dev";
  devBootstrap: boolean;
}

/** Genuine accepted socket lifetime. Host-only; never parsed from an RPC. */
export interface MobileBridgeConnectionLease { current(): boolean }

export interface MobileBridgeAuthorityEvent {
  event: MobileBridgeEventName;
  payload: MobileBridgeJsonValue;
  occurredAt?: string;
  /** Delivered only to connections whose device reported this decoder capability (device.capabilities). */
  requiresClientCapability?: MobileClientCapability;
  /** Delivered only to connections whose device reported every one of these. */
  requiresClientCapabilities?: readonly MobileClientCapability[];
  /** Withheld from connections whose device reported every one of these: they receive a twin event instead. */
  withheldForClientCapabilities?: readonly MobileClientCapability[];
}

/**
 * What the Desktop's durable rows say became of an owner message whose request-ledger entry a previous Desktop instance
 * left unsettled (MobileBridgeAuthority.reconcileOwnerMessage).
 */
export type MobileBridgeOwnerMessageVerdict =
  /** The intake took the message; `result` is what the original call answered. */
  | { kind: "taken"; result: MobileBridgeJsonValue }
  /** The intake took the message and could not start it: the original call was refused. */
  | { kind: "failed" }
  /** No durable row exists: nothing happened, the same key may be sent again. */
  | { kind: "never-taken" }
  | { kind: "unknown" };

/**
 * DESKTOP_MOBILE_BRIDGE: main.ts must inject the same authority used by Electron
 * IPC. The server never opens SQLite, creates an independent active-run registry,
 * or calls a model directly.
 */
export interface MobileBridgeAuthority {
  /** Only server.accept mints this lifecycle event; never RPC-selectable. */
  connectionOpened?(context: MobileBridgeConnectionContext, lease?: MobileBridgeConnectionLease): void;
  /** Whether this device reported the capability with device.capabilities; absent means none did. */
  clientHasCapability?(deviceId: string, capability: MobileClientCapability): boolean;
  snapshot(context: MobileBridgeConnectionContext): Promise<MobileBridgeSnapshot>;
  pairingVerification?(context: MobileBridgeConnectionContext): Promise<{
    hostId: string;
    sampleTaskId: string | null;
    sampleTaskVersion: number | null;
  }>;
  request(
    request: MobileBridgeRpcRequest,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeJsonValue | undefined>;
  capabilities?(): MobileBridgeJsonValue;
  /** Read-only. Absent: an unsettled owner message of a previous Desktop instance keeps answering "uncertain". */
  reconcileOwnerMessage?(
    request: MobileBridgeRpcRequest,
    context: MobileBridgeConnectionContext,
  ): MobileBridgeOwnerMessageVerdict;
  visualFrame?(
    request: MobileBridgeRpcRequest,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeVisualBinaryFrame | MobileBridgeVisualSessionRefusalDto>;
  connectionClosed?(context: MobileBridgeConnectionContext): void;
  subscribe(listener: (event: MobileBridgeAuthorityEvent) => void): () => void;
}

export interface MobileBridgeAuthenticatedDevice {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
}

export interface MobileBridgePairingAuthority {
  authenticate(token: string): Promise<MobileBridgeAuthenticatedDevice | null> | MobileBridgeAuthenticatedDevice | null;
  exchange(request: MobileBridgePairExchangeRequest, options?: { verifiedCodeHash?: Buffer }): Promise<{
    deviceId: string;
    token: string;
    issuedAt: string;
  }>;
  /** 중계로 온 첫 페어링의 서명 키 — 진행 중인 QR 이 없으면 null. relay-pairing.ts 참고. */
  relayPairingKey?(): Buffer | null;
  /** 중계 요청 서명이 틀렸을 때 틀린 코드와 똑같이 셈한다. */
  recordRelayPairingMismatch?(): void;
  /** Roll back a credential if post-exchange verification cannot be produced. */
  revokeDevice(deviceId: string, cause?: MobileBridgeRevocationCause): boolean;
  /**
   * Why the most recent authenticate() returned null. Without it every refusal
   * is an identical bare 401, so a phone that needs to re-pair is
   * indistinguishable from one hitting a cloud outage and retries forever.
   */
  readonly lastAuthenticationRefusal?: string | null;
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
  /** Longest a phone read waits for a not-ready Desktop before it is answered desktop_not_ready (default 20 s). */
  readNotReadyWaitMs?: number;
  relayPairingInfo?: () => { endpoint: string; secret: string } | null;
  onError?: (error: Error) => void;
  /** A paired non-bootstrap phone completed the authenticated ready snapshot. */
  onPairedDeviceReady?: (deviceId: string) => void;
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
  visualFrameInFlight: boolean;
  /** The socket's transport failed (EPIPE, reset): reported once, nothing more is written to it. */
  transportFailed: boolean;
}

/**
 * L1 (contracts/phone-long-ops.md): a ledgered write of a phone that announced `longOps.v1`. It lives in memory from the moment the write starts until its
 * answer is sent. The phone may hold several request ids on it (the first send and every later send of the same key, C5). It is not the ledger: the ledger
 * is what survives a restart; this only remembers which request ids still wait for the answer and whether they were told "received".
 */
interface LongJob {
  deviceId: string;
  key: string;
  fingerprint: string;
  maxMs: number;
  waiters: Map<string, { accepted: boolean; onAccepted?: () => void }>;
  /** The "received" moment has passed: later requests of this key are told at once. */
  accepted: boolean;
  ackTimer: NodeJS.Timeout | null;
  finished: boolean;
}

function longJobKey(deviceId: string, key: string, fingerprint: string): string {
  return `${deviceId}\0${key}\0${fingerprint}`;
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

function rejectUpgrade(
  socket: Duplex,
  status: 400 | 401 | 404 | 405 | 503,
  message: string,
  reason?: string | null,
): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Rejected"}\r\n` +
      "Connection: close\r\n" +
      (reason ? `X-Agentlas-Refusal: ${reason}\r\n` : "") +
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

type PairingFailureCode = MobileBridgePairExchangeFailure["error"]["code"];

function pairingFailureCode(value: unknown): PairingFailureCode | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  return code === "pairing_denied" ||
    code === "pairing_expired" ||
    code === "pairing_unavailable" ||
    code === "invalid_account_assertion" ||
    code === "account_mismatch" ||
    code === "binding_mismatch" ||
    code === "assertion_replayed" ||
    code === "account_authority_unavailable"
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
  private readonly readNotReadyWaitMs: number;
  private signedOutRefusalLoggedAt = 0;
  private readonly relayPairingInfo?: () => { endpoint: string; secret: string } | null;
  private readonly onError: (error: Error) => void;
  private readonly onPairedDeviceReady?: (deviceId: string) => void;
  private readonly onePhoneOwners = new WeakMap<ConnectionState,OneMobileSocketOwner>();
  private readonly clients = new Set<ConnectionState>();
  private readonly longJobs = new Map<string, LongJob>();
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
    this.readNotReadyWaitMs = Math.max(0, options.readNotReadyWaitMs ?? DEFAULT_READ_NOT_READY_WAIT_MS);
    this.relayPairingInfo = options.relayPairingInfo;
    this.onError = options.onError ?? ((error) => console.error("[mobile-bridge]", error.message));
    this.onPairedDeviceReady = options.onPairedDeviceReady;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.webSocketServer.on("connection", (socket, request) => this.accept(socket, request));
  }

  /** Fully initialized physical/app sessions only. Durable pairing rows are
   * intentionally excluded so Desktop never labels an offline phone as live. */
  connectedDeviceIds(): string[] {
    return [...new Set([...this.clients]
      .filter((state) => state.initialized && !state.revoked && state.socket.readyState === WS_OPEN)
      .map((state) => state.context.deviceId))]
      .sort();
  }

  async start(): Promise<AgentlasMobileBridgeServerAddress> {
    if (this.startedAddress) return this.startedAddress;
    if (this.httpServer) throw new Error("Agentlas Mobile Bridge is already starting");

    const server = this.tls
      ? https.createServer(this.tls, (request, response) => void this.handleHttp(request, response))
      : http.createServer((request, response) => void this.handleHttp(request, response));
    this.httpServer = server;
    server.on("upgrade", (request, socket, head) => void this.handleUpgrade(request, socket, head));
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
    // The subscription is attached per connected client (syncAuthoritySubscription):
    // the authority tears down its upstream per-token pipeline when it has no
    // listeners, so a bridge with no paired phone must not hold one open.
    this.pingTimer = setInterval(() => this.checkLiveness(), this.pingIntervalMs);
    this.pingTimer.unref?.();
    return this.startedAddress;
  }

  private async handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
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
      // ★사유 없는 401 금지(2026-08-08 실측). 이 경로는 로그도 헤더도 없어서,
      // "릴레이가 토큰을 안 실었나 / 폐기됐나"를 로그만으로 가릴 수 없었다.
      console.warn("[mobile-bridge] upgrade refused: no bearer credential presented");
      rejectUpgrade(socket, 401, "unauthorized", "token_missing");
      return;
    }
    let identity: UpgradeIdentity | null = null;
    // lastAuthenticationRefusal is the pairing's one shared "most recent" slot. When authenticate() threw (an unreadable
    // device store) it was never written for THIS token, so reading it would hand the relay another phone's
    // re-pair-required verdict for a credential that may be perfectly valid.
    let authenticationThrew = false;
    try {
      // The explicit development credential is a separate authentication
      // authority, not a production pairing row. Check its exact token before
      // consulting the production authority: production authentication may
      // fail closed by throwing for an unknown credential, and that exception
      // must not make the opt-in QA path unreachable.
      if (
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
      } else {
        const device = this.pairing ? await this.pairing.authenticate(presented) : null;
        if (device) {
          identity = {
            deviceId: device.deviceId,
            deviceName: device.name,
            devicePlatform: device.platform,
            devBootstrap: false,
          };
        }
      }
    } catch (error) {
      authenticationThrew = true;
      this.onError(errorOf(error));
    }
    if (!identity) {
      // A bare 401 was indistinguishable across four very different causes, so
      // the phone retried forever and the user was never told to re-pair.
      // The reason travels in a header the phone can read on the failed
      // upgrade; the body stays generic.
      //
      // ★2026-08-08: `if (refusal)` 때문에 사유가 안 잡힌 경우는 여전히 조용했다.
      // 사유가 비어 있다는 사실 자체가 결함 신호이므로 그것도 적는다 —
      // 로그에 아무것도 없는 상태로는 다음에도 같은 시간을 쓴다.
      const refusal = authenticationThrew ? null : this.pairing?.lastAuthenticationRefusal ?? null;
      const signedOut = refusal === "desktop_signed_out";
      if (!signedOut || this.signedOutRefusalLogDue()) console.warn(
        refusal
          ? `[mobile-bridge] upgrade refused: ${refusal}`
          : authenticationThrew
            ? "[mobile-bridge] upgrade refused: authentication could not be decided (authenticate threw); no refusal reason is sent"
            : "[mobile-bridge] upgrade refused: no reason recorded (authentication path is missing a refusal reason)",
      );
      // "Could not decide right now" is not "unauthorized": an account check that did not answer (or an authentication that
      // threw) is answered 503, which every phone retries with backoff. A 401 latches an older phone on the direct route
      // until the owner taps retry (mobile WS permanent-failure latch), for an outage that fixes itself.
      // The same holds for a Desktop that is signed out: the credentials are kept (pairing.ts authenticate) and the pairing
      // comes back as-is when the owner signs in again (a session that ended after 30 days included), so the phone must keep
      // trying instead of latching. Only a credential this Desktop will never accept again (device_unknown_or_revoked,
      // device_repair_required, account_inactive, token_*) stays 401.
      const undecided = authenticationThrew || refusal === "account_authority_unreachable" || signedOut;
      rejectUpgrade(socket, undecided ? 503 : 401, undecided ? "authentication unavailable" : "unauthorized", refusal);
      return;
    }
    if (!identity.devBootstrap) {
      let superseded = 0;
      for (const state of [...this.clients]) {
        if (state.context.deviceId !== identity.deviceId) continue;
        state.inflight.clear();
        state.pendingAuthorityEvents.length = 0;
        state.pendingAuthorityBytes = 0;
        this.dropClient(state);
        state.socket.close(
          SUPERSEDED_CONNECTION_CLOSE_CODE,
          SUPERSEDED_CONNECTION_CLOSE_REASON,
        );
        superseded += 1;
      }
      if (superseded > 0) {
        console.info(
          `[mobile-bridge] replaced ${superseded} stale session(s) for device ${identity.deviceId}`,
        );
      }
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
      socket.close(RETRY_LATER_CLOSE_CODE, "authentication required");
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
      visualFrameInFlight: false,
      transportFailed: false,
    };
    this.clients.add(state);
    const connectionLease = Object.freeze({ current: () => this.clients.has(state) && !state.revoked && !state.revocationPending && !state.transportFailed && state.socket.readyState === WS_OPEN });
    try { this.authority.connectionOpened?.(state.context, connectionLease); }
    catch { this.clients.delete(state); socket.close(RETRY_LATER_CLOSE_CODE, "secure channel unavailable"); return; }
    const phoneOwner = currentOneMobileSocketOwner();
    if (phoneOwner) {
      this.onePhoneOwners.set(state, phoneOwner);
      const current = () => this.clients.has(state) && !state.revoked && !state.revocationPending && !state.transportFailed && state.socket.readyState === WS_OPEN;
      try { phoneOwner.accepted(state.context, {current,
        send: (frame, stillCurrent) => new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); if (error || !current() || !stillCurrent()) reject(new Error('secure_route_unavailable')); else resolve(); };
          const timer = setTimeout(() => finish(new Error('secure_route_unavailable')), 5000);
          if (!current() || !stillCurrent()) { finish(new Error('secure_route_unavailable')); return; }
          this.send(state, frame as MobileBridgeServerMessage, finish);
        }),
        close: () => { try { state.socket.close(RETRY_LATER_CLOSE_CODE, 'secure channel closed'); } finally { this.dropClient(state); } },
      }); } catch { state.socket.close(RETRY_LATER_CLOSE_CODE, 'secure route unavailable'); this.dropClient(state); return; }
    }
    this.syncAuthoritySubscription();
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data, isBinary) => this.receive(state, data, isBinary));
    socket.on("error", (error) => this.transportError(state, error, "socket"));
    socket.on("close", () => {
      state.inflight.clear();
      state.pendingAuthorityEvents.length = 0;
      state.pendingAuthorityBytes = 0;
      this.dropClient(state);
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
    const outcome = await this.completePairExchange(this.pairing, parsed.value, request.socket.remoteAddress ?? null);
    this.sendPairResponse(response, outcome.status, outcome.payload);
  }

  /**
   * 중계로 들어온 첫 페어링 요청 한 프레임을 처리하고, 폰에 돌려줄 한 프레임을 만든다.
   * LAN 창구와 같은 교환 본체를 쓰고, 달라지는 것은 코드 대신 서명으로 확인한다는 점뿐이다.
   */
  async handleRelayPairFrame(frameText: string): Promise<string> {
    const pairing = this.pairing;
    const key = pairing?.relayPairingKey?.() ?? null;
    if (!pairing || !key) return relayPairRefusedFrame("pairing_unavailable");
    // LAN 창구와 같은 분당 상한. 중계로 오는 요청은 주소가 전부 중계라 한 칸으로 센다.
    if (!this.consumePairAttempt("relay")) return relayPairRefusedFrame("pairing_unavailable");
    const frame = parseRelayPairRequestFrame(frameText);
    if (!frame) return relayPairRefusedFrame("invalid_pairing_request");
    if (!relayPairMacMatches(relayPairRequestMac(key, frame.body), frame.mac)) {
      pairing.recordRelayPairingMismatch?.();
      return relayPairRefusedFrame("pairing_denied");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(frame.body);
    } catch {
      return relayPairRefusedFrame("invalid_pairing_request");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || "code" in raw) {
      return relayPairRefusedFrame("invalid_pairing_request");
    }
    const parsed = parseMobileBridgePairExchangeRequest({ ...raw, code: RELAY_PAIR_CODE_PLACEHOLDER });
    const outcome = parsed.ok
      ? await this.completePairExchange(pairing, parsed.value, "mobile-relay", key)
      : { status: 400, payload: parsed.error };
    return relayPairResponseFrame(key, frame.mac, outcome.status, JSON.stringify(outcome.payload));
  }

  /**
   * 페어링 교환의 본체 — LAN 창구와 중계 창구가 같은 판정을 쓴다. 한쪽만 고치면 두 길의 결과가
   * 달라지므로 응답을 만드는 곳은 여기 하나다.
   */
  private async completePairExchange(
    pairing: MobileBridgePairingAuthority,
    value: MobileBridgePairExchangeRequest,
    remoteAddress: string | null,
    verifiedCodeHash?: Buffer,
  ): Promise<{ status: number; payload: MobileBridgePairExchangeResponse }> {
    let issuedCredential: Awaited<ReturnType<MobileBridgePairingAuthority["exchange"]>> | null = null;
    try {
      const relay = this.relayPairingInfo?.() ?? null;
      const credential = await pairing.exchange(value, verifiedCodeHash ? { verifiedCodeHash } : undefined);
      issuedCredential = credential;
      const pairingContext: MobileBridgeConnectionContext = {
        connectionId: `pair-exchange:${credential.deviceId}`,
        remoteAddress: remoteAddress,
        connectedAt: credential.issuedAt,
        deviceId: credential.deviceId,
        deviceName: value.device.name,
        devicePlatform: value.device.platform,
        devBootstrap: false,
      };
      const seed = this.authority.pairingVerification
        ? await this.authority.pairingVerification(pairingContext)
        : null;
      const verification = seed
        ? {
            verificationId: `pairing_${createHash("sha256")
              .update(`${value.id}:${credential.deviceId}:${credential.issuedAt}`)
              .digest("hex")
              .slice(0, 32)}`,
            hostId: seed.hostId,
            issuedAt: credential.issuedAt,
            sampleTaskId: seed.sampleTaskId,
            sampleTaskVersion: seed.sampleTaskVersion,
          }
        : null;
      return { status: 200, payload: {
        v: MOBILE_BRIDGE_PROTOCOL_VERSION,
        type: "pair.exchange.response",
        id: value.id,
        ok: true,
        credential,
        ...(verification ? { verification } : {}),
        ...(relay ? { relay } : {}),
      } };
    } catch (error) {
      if (issuedCredential) {
        try {
          pairing.revokeDevice(issuedCredential.deviceId, "pairing_rollback");
        } catch {
          // The original failure remains authoritative. A production pairing
          // manager persists revocation synchronously; never expose the token.
        }
      }
      // DESKTOP_MOBILE_BRIDGE: Never log the raw request/code or returned token.
      const code = pairingFailureCode(error) ?? "pairing_unavailable";
      const status = code === "pairing_expired"
        ? 410
        : code === "pairing_denied" || code === "invalid_account_assertion"
          ? 401
          : code === "account_mismatch" || code === "binding_mismatch"
            ? 403
            : code === "assertion_replayed"
              ? 409
              : 503;
      return {
        status,
        payload: mobileBridgePairFailure(
          value.id,
          code,
          code === "pairing_expired"
            ? "Pairing code expired"
            : code === "pairing_denied"
              ? "Pairing denied"
              : code === "invalid_account_assertion"
                ? "Mobile account assertion is invalid"
                : code === "account_mismatch"
                  ? "Desktop and Mobile Agentlas accounts do not match"
                  : code === "binding_mismatch"
                    ? "Mobile account assertion is bound to a different pairing attempt"
                    : code === "assertion_replayed"
                      ? "Mobile account assertion was already used"
                      : "Agentlas account pairing authority is unavailable",
        ),
      };
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
      const authorityCapabilities = this.authority.capabilities?.();
      this.sendEvent(state, "bridge.ready", {
        protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
        connectionId: state.context.connectionId,
        hostId: snapshot.host.id,
        capabilities: {
          ...(authorityCapabilities && typeof authorityCapabilities === "object" && !Array.isArray(authorityCapabilities)
            ? authorityCapabilities
            : {}),
          ...(this.replayStore ? { requestStatusV1: this.replayStore.capability() } : {}),
          // Additive (L1): how long the phone waits for each read, and when a running write is "received". A phone that does not know the key ignores it.
          ...(this.replayStore ? { longOpsV1: buildLongOpsV1({
            notReadyWaitMs: Math.min(this.readNotReadyWaitMs, Math.floor(this.requestTimeoutMs / 2)),
            bridgeBoundMs: this.requestTimeoutMs,
          }) as unknown as MobileBridgeJsonValue } : {}),
        },
        ...(relay ? { relay } : {}),
      });
      this.sendEvent(state, "snapshot.updated", snapshot as unknown as MobileBridgeJsonValue);
      if (state.socket.readyState !== WS_OPEN) return;

      // DESKTOP_MOBILE_BRIDGE: Authority events observed while snapshotting are
      // released only after ready + snapshot. Per-client seq remains contiguous.
      const pending = state.pendingAuthorityEvents.splice(0);
      state.pendingAuthorityBytes = 0;
      state.initialized = true;
      if (!state.context.devBootstrap) {
        try { this.onPairedDeviceReady?.(state.context.deviceId); } catch { /* observer only */ }
      }
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
    if (state.requestCount > MAX_REQUESTS_PER_MINUTE_HARD) {
      state.socket.close(RETRY_LATER_CLOSE_CODE, "request rate exceeded");
      return;
    }
    const overRequestRate = state.requestCount > MAX_REQUESTS_PER_MINUTE;
    if (state.requestCount === MAX_REQUESTS_PER_MINUTE + 1) this.onError(new Error("mobile_request_rate_exceeded"));
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
    if (this.onePhoneOwners.get(state)?.respond(state.context, decoded)) return;
    const parsed = parseMobileBridgeRequest(decoded);
    if (!parsed.ok) {
      this.send(state, parsed.error);
      return;
    }
    if (overRequestRate) {
      // Nothing was started; the answer says so and that it can be sent again (the phone keeps the word for its retry).
      this.send(state, mobileBridgeFailure(parsed.value.id, "too_many_requests",
        "Too many requests in this minute; nothing was run. It can be sent again shortly.", true));
      return;
    }
    // Reserve this connection's request budget for cancellation and control.
    if ((parsed.value.method === "legacy.video.chunk" || parsed.value.method === "chat.file.chunk" || parsed.value.method === "one.video.chunk" || parsed.value.method === "chat.video.chunk" || parsed.value.method === "science.video.chunk") && state.requestCount > MOBILE_CHUNK_REQUEST_BUDGET) {
      this.send(state, mobileBridgeFailure(parsed.value.id, "too_many_requests", "Video transfer is paused to reserve control capacity", true));
      return;
    }
    // chat-attachments-v2: an upload of any size is many 1 MiB chunks. Past 240 requests in this minute a chunk waits (retryable),
    // so the connection never reaches the 300/minute close and keeps room for Stop and other control requests.
    if (parsed.value.method === "chat.attachments.chunk" && state.requestCount > MOBILE_CHUNK_REQUEST_BUDGET) {
      this.send(state, mobileBridgeFailure(parsed.value.id, "too_many_requests", "Attachment upload is paused to reserve control capacity", true));
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
    if (parsed.value.method === "visualSession.frame") {
      if (state.visualFrameInFlight) {
        state.inflight.delete(parsed.value.id);
        this.send(state, mobileBridgeFailure(
          parsed.value.id,
          "too_many_requests",
          "A visual frame is already in flight; control requests remain available",
          true,
        ));
        return;
      }
      state.visualFrameInFlight = true;
    }
    void this.dispatch(state, parsed.value).finally(() => {
      state.inflight.delete(parsed.value.id);
      if (parsed.value.method === "visualSession.frame") state.visualFrameInFlight = false;
    });
  }

  private async dispatch(state: ConnectionState, request: MobileBridgeRpcRequest): Promise<void> {
    if (state.revoked || !this.clients.has(state)) return;
    if (request.method === "visualSession.frame") {
      await this.dispatchVisualFrame(state, request);
      return;
    }
    if (request.method === "request.status") {
      this.dispatchRequestStatus(state, request);
      return;
    }
    const selfRevocation = request.method === "device.revokeSelf";
    const secureRequest = isOneMobileSecureMethod(request.method);
    const writeRequest = MOBILE_BRIDGE_WRITE_METHODS.has(request.method);
    // Self-idempotent writes (e.g. a Science Stop) never wait behind a ledger entry: one whose answer was lost can be sent again.
    const ledgered = writeRequest && !MOBILE_BRIDGE_SELF_IDEMPOTENT_WRITE_METHODS.has(request.method);
    const replayKey = request.idempotencyKey ?? request.id;
    const replayFingerprint = ledgered ? fingerprintMobileBridgeRequest(request) : null;
    if (ledgered) {
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
        let replay = this.replayStore.begin(
          state.context.deviceId,
          replayKey,
          replayFingerprint,
        );
        if (replay.kind === "uncertain" && this.replayStore.isOrphan(state.context.deviceId, replayKey, replayFingerprint)) {
          // A previous Desktop instance left this entry unsettled and nothing alive can ever settle it. Where the command's
          // own durable footprint proves the outcome, settle it from that; where it proves nothing ran, or the command is
          // keyed downstream, let the same key run once more. Anything else stays uncertain, as before.
          const orphan = this.orphanDisposition(state.context, request);
          if (orphan.kind === "settled") {
            this.replayStore.adoptOrphan(state.context.deviceId, replayKey, replayFingerprint, orphan.response);
          } else if (orphan.kind === "rerun") {
            this.replayStore.releaseOrphan(state.context.deviceId, replayKey, replayFingerprint);
          }
          // Ask the ledger again either way: a concurrent resend may have settled or re-admitted the key first, and the
          // answer must describe that (replay / in-progress), not the stale "uncertain" read above.
          if (orphan.kind !== "keep") replay = this.replayStore.begin(state.context.deviceId, replayKey, replayFingerprint);
        }
        if (replay.kind === "replay") {
          this.send(state, responseForRequest(replay.response, request.id));
          return;
        }
        if (replay.kind !== "execute") {
          // C5: the same key again while the work is alive in this process: a phone that holds long operations attaches to it (it is told "received" again
          // and gets the answer for this request id too). Any other phone, and a key whose work lives in another process, gets the answer it always got.
          if (replay.kind === "in-progress" && this.attachToLongJob(state, request, replayKey, replayFingerprint)) return;
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
    // Writes are refused-and-queued by the phone (desktop_not_ready below); a read waits here instead (readWhenReady).
    // L1: a write of a phone that holds long operations is bounded by its own operation's bound (C3), not by the bridge's 120 s, and is "received" after 8 s.
    const writeMaxMs = ledgered ? longOpWriteMaxMs(request.method, this.requestTimeoutMs) : this.requestTimeoutMs;
    const job = ledgered && !selfRevocation && !secureRequest && replayFingerprint
      ? this.startLongJob(state, request, replayKey, replayFingerprint, writeMaxMs)
      : null;
    const authorityPromise = writeRequest || secureRequest || selfRevocation
      ? this.authority.request(request, state.context)
      : this.readWhenReady(state, request);
    // Every answer of this request goes through here: to the socket it came on, or (a received job) to every request id waiting on the key, on the device's live socket.
    const answer = (response: MobileBridgeReplayResponse | ReturnType<typeof mobileBridgeFailure>): void => {
      if (job) { this.finishLongJob(job, response as MobileBridgeReplayResponse); return; }
      if (state.revoked || state.revocationPending || !this.clients.has(state)) return;
      this.send(state, response as MobileBridgeServerMessage);
    };
    const settle = async (): Promise<void> => {
    try {
      const result = await withTimeout(authorityPromise, job ? writeMaxMs : this.requestTimeoutMs);
      let response = this.responseFromAuthority(request.id, result);
      if (writeRequest && this.replayStore && replayFingerprint) {
        response = this.settleReplay(
          request,
          state.context.deviceId,
          replayKey,
          replayFingerprint,
          response,
        );
      }
      if (selfRevocation) {
        this.sendSelfRevocationAckAndDisconnect(state, response);
        return;
      }
      answer(response);
    } catch (error) {
      const normalized = errorOf(error);
      this.onError(secureRequest ? new Error("secure_route_unavailable") : normalized);
      if (selfRevocation) this.clearDeviceRevocationPending(state.context.deviceId);
      // L1 D4: an operation that was cut off by a bound of its own (the Cloud registration request) says so with a machine marker: the outcome is unknown, and
      // the ledger stays "unknown" - the operation has ended, so there is no late answer to wait for.
      const outcomeUnknown = (error as { code?: unknown } | null)?.code === "outcome_unknown";
      const timeout = normalized.message === "Mobile Bridge authority request timed out" || outcomeUnknown;
      if (timeout && writeRequest && this.replayStore && replayFingerprint) {
        // C3: the bridge's 120 s ends the phone's wait, not the work. A phone that holds long operations is bounded by the operation's own bound (above); any
        // other phone is answered "unknown" at 120 s as before, but the ledger keeps saying "in progress" until the operation's own bound if it is longer.
        const keepPendingMs = !job && !outcomeUnknown ? Math.max(0, writeMaxMs - this.requestTimeoutMs) : 0;
        let lateSettled = false;
        let uncertainTimer: NodeJS.Timeout | null = null;
        const markUncertainNow = (): void => {
          try {
            this.replayStore?.markUncertain(state.context.deviceId, replayKey, replayFingerprint);
          } catch (ledgerError) {
            this.onError(errorOf(ledgerError));
          }
        };
        if (keepPendingMs > 0) {
          uncertainTimer = setTimeout(() => { uncertainTimer = null; if (!lateSettled) markUncertainNow(); }, keepPendingMs);
          uncertainTimer.unref?.();
        } else {
          markUncertainNow();
        }
        // The authority promise is deliberately not cancelled. If it eventually
        // settles in this process, apply that method's replay policy. A crash
        // leaves the write-ahead entry uncertain and future retries fail closed.
        if (!outcomeUnknown) void authorityPromise.then(
          (result) => {
            lateSettled = true;
            if (uncertainTimer) { clearTimeout(uncertainTimer); uncertainTimer = null; }
            const response = this.responseFromAuthority(request.id, result);
            this.settleReplay(
              request,
              state.context.deviceId,
              replayKey,
              replayFingerprint,
              response,
            );
          },
          () => {
            lateSettled = true;
            if (uncertainTimer) { clearTimeout(uncertainTimer); uncertainTimer = null; }
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
      const notReady = !timeout && !secureRequest ? mobileBridgeNotReadyRefusal(error) : null;
      if (notReady && !writeRequest && !selfRevocation) {
        // A read that stayed not ready for its whole wait: still not a verdict. Retryable, nothing to release (reads have no ledger entry).
        answer(mobileBridgeFailure(request.id, MOBILE_BRIDGE_DESKTOP_NOT_READY_CODE,
          "Desktop was not ready to answer this yet. It can be asked again.", true));
        return;
      }
      if (notReady && writeRequest && (!ledgered || (this.replayStore && replayFingerprint))) {
        let released = !ledgered;
        if (ledgered && this.replayStore && replayFingerprint) {
          try { this.replayStore.release(state.context.deviceId, replayKey, replayFingerprint); released = true; }
          catch (ledgerError) { this.onError(errorOf(ledgerError)); }
        }
        if (released) {
          answer(mobileBridgeFailure(request.id, MOBILE_BRIDGE_DESKTOP_NOT_READY_CODE,
            "Desktop was not ready to take this yet; nothing was run. It can be sent again.", true));
          return;
        }
      }
      const uncertainWrite = timeout && ledgered;
      // An owner message into a room the personal agent runs (one/personal-agent-rooms.ts): a typed refusal, nothing ran.
      const personalAgentRoom = !timeout && !secureRequest && (error as { code?: unknown } | null)?.code === "supervised_room_read_only";
      // A refusal the owner can act on keeps its own code for a phone that has a sentence for it (shared/mobile-bridge-refusal.ts).
      // The One supervisor and history paging keep authority_error: the phone reads exactly that code there.
      const specific = !timeout && !secureRequest && !personalAgentRoom && !request.method.startsWith("one.supervisor.")
        && this.authority.clientHasCapability?.(state.context.deviceId, "refusal.specific.v1") === true
        ? mobileBridgeSpecificRefusal(error) : null;
      // Audit 59 B10: a word sent while the personal agent's home is moving (`one_sealed`, this computer is packing) or has moved (`one_away`) is not a final refusal: a phone that announced `oneHome.v1` gets the code itself and keeps the word
      // for the new home. A phone that did not (the store versions 168 and 170 decode any code string - web_socket_desktop_transport.dart:2419-2441 at mobile fc30087 - but have no handling for these two) keeps `authority_error`, byte for byte as before.
      // Audit 62 (bridge B6): the ledger entry of a word refused for the home's STATE is released whether or not the phone knows the code (an older phone keeps `authority_error`, byte for byte, but its repeat must run once the home is
      // open again - not read the stored refusal for 24 hours). `oneHomeStateRefusal` decides the release; the capability decides only which code the phone is told.
      // Desktop repair 11: the three doors that start or steer a turn in a One conversation answer the same two codes (authority.ts assertPersonalAgentHomeWritable).
      const oneHomeStateRefusal = !timeout && !secureRequest && !personalAgentRoom && (request.method.startsWith("one.supervisor.") || ONE_HOME_TURN_METHODS.has(request.method))
        && ((error as { code?: unknown } | null)?.code === "one_sealed" || (error as { code?: unknown } | null)?.code === "one_away");
      const oneHomeRefusal = oneHomeStateRefusal && this.authority.clientHasCapability?.(state.context.deviceId, "oneHome.v1") === true
        ? (error as { code: "one_sealed" | "one_away" }).code : null;
      let response: MobileBridgeReplayResponse = personalAgentRoom
        ? mobileBridgeFailure(request.id, "supervised_room_read_only",
          "This room is run by your personal agent. Talk to the personal agent instead.", false)
        : oneHomeRefusal
        ? mobileBridgeFailure(request.id, oneHomeRefusal,
          oneHomeRefusal === "one_sealed" ? "Your personal agent is moving to another computer; nothing was run." : "Your personal agent now lives on another computer; nothing was run.", false)
        : specific
        ? mobileBridgeFailure(request.id, specific.code, specific.message, false)
        : mobileBridgeFailure(
        request.id,
        secureRequest ? (timeout && request.method === "one.vault.submit" ? "store_unknown"
          : error instanceof OneVaultError || error instanceof OneProviderRemoteError ? error.code : "secure_route_unavailable")
          : uncertainWrite ? "outcome_unknown" : timeout ? "request_timeout" : "authority_error",
        uncertainWrite
          ? "Desktop may have accepted this command, but its acknowledgement was not available; check Desktop state before trying again"
          : timeout
            ? "Desktop did not answer in time"
            : "Desktop rejected the request",
        timeout && !ledgered && !secureRequest,
      );
      // Audit 61 B10 (a): `one_sealed` / `one_away` are a state of this computer, not the command's final word. A move that is cancelled or expires makes this computer the home again; the phone sends the same command id again and it must RUN then, not
      // get the stored refusal for 24 hours (the window in which a word is delivered). Like a not-ready refusal the entry is released and nothing is stored; a release that fails falls back to the old ledgered answer (never an entry left pending).
      let oneHomeReleased = false;
      if (oneHomeStateRefusal && ledgered && this.replayStore && replayFingerprint) {
        try { this.replayStore.release(state.context.deviceId, replayKey, replayFingerprint); oneHomeReleased = true; }
        catch (ledgerError) { this.onError(errorOf(ledgerError)); }
      }
      if (!timeout && ledgered && this.replayStore && replayFingerprint && !oneHomeReleased) {
        response = this.completeReplay(
          state.context.deviceId,
          replayKey,
          replayFingerprint,
          response,
          request.id,
        );
      }
      answer(response);
    }
    };
    if (!job) {
      await settle();
      return;
    }
    // A received job: this request ends here once the Desktop has told the phone it holds the write (the in-flight slot is free again), or once it is answered.
    const waiter = job.waiters.get(request.id);
    const received = new Promise<void>((resolve) => { if (waiter) waiter.onAccepted = resolve; else resolve(); });
    const settling = settle().catch((error) => {
      this.onError(errorOf(error));
      if (!job.finished) this.finishLongJob(job, mobileBridgeFailure(request.id, "authority_error", "Desktop rejected the request"));
    });
    await Promise.race([settling, received]);
  }

  /** Whether this device announced `longOps.v1` and still has room for another received write (32 per device, memory only). */
  private longOpsAvailableFor(deviceId: string): boolean {
    if (this.authority.clientHasCapability?.(deviceId, "longOps.v1") !== true) return false;
    let waiting = 0;
    for (const job of this.longJobs.values()) if (job.deviceId === deviceId) waiting += job.waiters.size;
    return waiting < LONG_OPS_MAX_RECEIVED_PER_DEVICE;
  }

  private startLongJob(
    state: ConnectionState,
    request: MobileBridgeRpcRequest,
    key: string,
    fingerprint: string,
    maxMs: number,
  ): LongJob | null {
    const deviceId = state.context.deviceId;
    if (!this.longOpsAvailableFor(deviceId)) return null;
    const job: LongJob = {
      deviceId,
      key,
      fingerprint,
      maxMs,
      waiters: new Map([[request.id, { accepted: false }]]),
      accepted: false,
      ackTimer: null,
      finished: false,
    };
    // One timer per running write of a long-ops phone, ended with the write: this is the "received" moment, not polling.
    job.ackTimer = setTimeout(() => { job.ackTimer = null; this.acceptLongJob(job); }, LONG_OPS_ACK_MS);
    job.ackTimer.unref?.();
    this.longJobs.set(longJobKey(deviceId, key, fingerprint), job);
    return job;
  }

  /** C5: the same key again while the work is alive here. */
  private attachToLongJob(state: ConnectionState, request: MobileBridgeRpcRequest, key: string, fingerprint: string): boolean {
    const deviceId = state.context.deviceId;
    const job = this.longJobs.get(longJobKey(deviceId, key, fingerprint));
    if (!job || job.finished) return false;
    if (!job.waiters.has(request.id)) {
      if (!this.longOpsAvailableFor(deviceId)) return false;
      job.waiters.set(request.id, { accepted: false });
    } else if (this.authority.clientHasCapability?.(deviceId, "longOps.v1") !== true) {
      return false;
    } else if (job.accepted) {
      // The phone sent the very same request id again (its socket was replaced): it is told "received" again.
      const waiter = job.waiters.get(request.id);
      if (waiter) waiter.accepted = false;
    }
    if (job.accepted) this.sendAccepted(job, request.id);
    return true;
  }

  private acceptLongJob(job: LongJob): void {
    if (job.finished) return;
    job.accepted = true;
    for (const requestId of [...job.waiters.keys()]) this.sendAccepted(job, requestId);
  }

  private sendAccepted(job: LongJob, requestId: string): void {
    const waiter = job.waiters.get(requestId);
    if (!waiter || waiter.accepted) return;
    waiter.accepted = true;
    const live = this.liveStateOf(job.deviceId);
    if (live) {
      const payload: RequestAcceptedPayload = { requestId, maxMs: job.maxMs };
      this.sendEvent(live, "request.accepted", payload as unknown as MobileBridgeJsonValue);
    }
    // The request that started the job stops holding an in-flight slot even if its socket is gone; the answer is the job's.
    waiter.onAccepted?.();
  }

  /** The device's current initialized socket (one per device), or null. */
  private liveStateOf(deviceId: string): ConnectionState | null {
    for (const state of this.clients) {
      if (state.context.deviceId === deviceId && state.initialized && !state.revoked && !state.revocationPending && !state.transportFailed && state.socket.readyState === WS_OPEN) return state;
    }
    return null;
  }

  /** C2: the ordinary response, for the original request id (and every later request id of the same key), on the device's socket as it is now. */
  private finishLongJob(job: LongJob, response: MobileBridgeReplayResponse): void {
    if (job.finished) return;
    job.finished = true;
    if (job.ackTimer) { clearTimeout(job.ackTimer); job.ackTimer = null; }
    this.longJobs.delete(longJobKey(job.deviceId, job.key, job.fingerprint));
    const live = this.liveStateOf(job.deviceId);
    for (const [requestId, waiter] of job.waiters) {
      if (live) this.send(live, responseForRequest(response, requestId));
      waiter.onAccepted?.();
    }
    job.waiters.clear();
  }


  /** A signed-out Desktop is retried by every open phone (answered 503): log it once a minute, not on every attempt. */
  private signedOutRefusalLogDue(): boolean {
    const now = Date.now();
    if (now - this.signedOutRefusalLoggedAt < SIGNED_OUT_REFUSAL_LOG_INTERVAL_MS) return false;
    this.signedOutRefusalLoggedAt = now;
    return true;
  }

  private phoneStillThere(state: ConnectionState): boolean {
    return this.clients.has(state) && !state.revoked && !state.revocationPending;
  }

  /**
   * A READ the Desktop refused only because something it needs is not ready yet (the codes of shared/transient-send-refusal.ts:
   * the One supervisor's channel to the background service during a hand-off, a chat still settling, ...) is not a verdict on the
   * request. Writes were already answered `desktop_not_ready` and queued by the phone; reads got a final non-retryable
   * `authority_error`, so the Hope screen failed about three times a second for the whole minute of a daemon hand-off (219 failed
   * reads in four windows, /21) and showed its "needs review" banner. The read waits here instead, with the backoff the
   * send queue uses, and asks again, for at most readNotReadyWaitMs (below the phone's 30 s request timeout). Every other refusal
   * is thrown at once, as before; a read still not ready after the wait is answered desktop_not_ready (retryable) by dispatch.
   * Only refused-before-anything codes qualify (mobileBridgeNotReadyRefusal), so asking again can never run a request twice.
   */
  private async readWhenReady(state: ConnectionState, request: MobileBridgeRpcRequest): Promise<MobileBridgeJsonValue | undefined> {
    const deadline = Date.now() + Math.min(this.readNotReadyWaitMs, Math.floor(this.requestTimeoutMs / 2));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.authority.request(request, state.context);
      } catch (error) {
        if (!mobileBridgeNotReadyRefusal(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !this.phoneStillThere(state)) throw error;
        const delay = Math.min(transientSendBackoffMs(attempt), remaining);
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
        if (!this.phoneStillThere(state)) throw error;
      }
    }
  }

  /**
   * What to do with a ledger entry a previous Desktop instance left unsettled (replay.ts isOrphan):
   *  - settled: the Desktop's durable rows prove the message was taken; this is what the original call answered;
   *  - rerun: nothing ran (`proven`), or the command is keyed downstream (science.chat.send by its request id), so
   *    running the same key again cannot run it twice;
   *  - keep: not provable, so it stays "uncertain" and is never run again.
   */
  private orphanDisposition(
    context: MobileBridgeConnectionContext,
    request: MobileBridgeRpcRequest,
  ): { kind: "settled"; response: MobileBridgeReplayResponse } | { kind: "rerun"; proven: boolean } | { kind: "keep" } {
    if (!mobileBridgeOrphanMayRerun(request)) return { kind: "keep" };
    if (!mobileBridgeIsOwnerMessage(request)) return { kind: "rerun", proven: false };
    let verdict: MobileBridgeOwnerMessageVerdict | undefined;
    try {
      verdict = this.authority.reconcileOwnerMessage?.(request, context);
    } catch (error) {
      this.onError(errorOf(error));
      return { kind: "keep" };
    }
    switch (verdict?.kind) {
      case "never-taken": return { kind: "rerun", proven: true };
      case "taken": return { kind: "settled", response: this.responseFromAuthority(request.id, verdict.result) };
      case "failed": return { kind: "settled", response: mobileBridgeFailure(request.id, "authority_error", "Desktop rejected the request") };
      default: return { kind: "keep" };
    }
  }

  private dispatchRequestStatus(state: ConnectionState, request: MobileBridgeRpcRequest): void {
    if (!this.replayStore) {
      this.send(state, mobileBridgeFailure(
        request.id,
        "idempotency_unavailable",
        "Desktop request reconciliation is unavailable",
      ));
      return;
    }
    const originalRequest: MobileBridgeRpcRequest = {
      v: MOBILE_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id: String(request.params.requestId),
      idempotencyKey: String(request.params.idempotencyKey),
      method: request.params.method as MobileBridgeRpcRequest["method"],
      params: request.params.params as MobileBridgeRpcRequest["params"],
    };
    try {
      let result = this.replayStore.lookup(
        state.context.deviceId,
        originalRequest.idempotencyKey!,
        fingerprintMobileBridgeRequest(originalRequest),
      );
      if (result.kind === "uncertain" && this.replayStore.isOrphan(
        state.context.deviceId,
        originalRequest.idempotencyKey!,
        fingerprintMobileBridgeRequest(originalRequest),
      )) {
        // Read-only: the ledger is not changed here. A resend of the same key settles it (dispatch).
        const orphan = this.orphanDisposition(state.context, originalRequest);
        if (orphan.kind === "settled") result = { kind: "completed", response: orphan.response };
        else if (orphan.kind === "rerun" && orphan.proven) result = { kind: "missing" };
      }
      const statusResult = {
        schemaVersion: 1,
        status: result.kind,
        ...(result.kind === "completed" ? { response: result.response } : {}),
      };
      if (!isMobileBridgeJsonValue(statusResult)) {
        throw new Error("Desktop retained an invalid request receipt");
      }
      this.send(state, mobileBridgeSuccess(request.id, statusResult));
    } catch (error) {
      this.onError(errorOf(error));
      this.send(state, mobileBridgeFailure(
        request.id,
        "idempotency_unavailable",
        "Desktop could not inspect the retained request receipt",
      ));
    }
  }

  private async dispatchVisualFrame(
    state: ConnectionState,
    request: MobileBridgeRpcRequest,
  ): Promise<void> {
    const producer = this.authority.visualFrame;
    if (!producer) {
      this.send(state, mobileBridgeFailure(
        request.id,
        "method_not_allowed",
        "This Desktop does not provide visual sessions",
      ));
      return;
    }
    // A queued frame can never outrank cancellation, approval, or semantic RPC.
    if (state.socket.bufferedAmount > MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES) {
      this.send(state, mobileBridgeFailure(
        request.id,
        "too_many_requests",
        "The visual channel is backpressured; retry after control traffic drains",
        true,
      ));
      return;
    }
    try {
      const result = await withTimeout(producer.call(this.authority, request, state.context), this.requestTimeoutMs);
      if (!("metadata" in result)) {
        this.send(state, mobileBridgeSuccess(
          request.id,
          result as unknown as MobileBridgeJsonValue,
        ));
        return;
      }
      this.sendVisualFrame(state, request.id, result);
    } catch (error) {
      const normalized = errorOf(error);
      this.onError(normalized);
      const timeout = normalized.message === "Mobile Bridge authority request timed out";
      this.send(state, mobileBridgeFailure(
        request.id,
        timeout ? "request_timeout" : "authority_error",
        timeout ? "Desktop did not capture the visual frame in time" : "Desktop rejected the visual frame request",
        timeout,
      ));
    }
  }

  private sendVisualFrame(
    state: ConnectionState,
    requestId: string,
    frame: MobileBridgeVisualBinaryFrame,
  ): void {
    if (state.revoked || state.socket.readyState !== WS_OPEN) return;
    const metadata: MobileBridgeVisualFrameDto = frame.metadata;
    if (
      frame.bytes.byteLength !== metadata.byteLength
      || frame.bytes.byteLength > MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES
    ) {
      this.send(state, mobileBridgeFailure(
        requestId,
        "response_too_large",
        "Desktop produced an invalid visual frame",
      ));
      return;
    }
    const header = Buffer.from(JSON.stringify({
      v: MOBILE_BRIDGE_PROTOCOL_VERSION,
      type: "visual.frame",
      id: requestId,
      ok: true,
      result: metadata,
    }), "utf8");
    if (header.byteLength > 64 * 1024) {
      this.send(state, mobileBridgeFailure(requestId, "response_too_large", "Visual frame metadata is too large"));
      return;
    }
    const prefix = Buffer.allocUnsafe(8);
    prefix.write(MOBILE_BRIDGE_VISUAL_FRAME_MAGIC, 0, 4, "ascii");
    prefix.writeUInt32BE(header.byteLength, 4);
    const packet = Buffer.concat([prefix, header, frame.bytes]);
    if (packet.byteLength > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
      this.send(state, mobileBridgeFailure(requestId, "response_too_large", "Visual frame exceeds the Mobile Bridge limit"));
      return;
    }
    if (state.transportFailed) return;
    state.socket.send(packet, (error) => {
      if (error) this.transportError(state, error, "write");
    });
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

  /** Accepted responses which only name process-local state cannot be replayed
   * after a Desktop restart. The first caller receives the live identifier and
   * retries of that key fail closed as uncertain. Refusals remain replayable.
   */
  private settleReplay(
    request: MobileBridgeRpcRequest,
    deviceId: string,
    key: string,
    fingerprint: string,
    response: MobileBridgeReplayResponse,
  ): MobileBridgeReplayResponse {
    const result = response.ok ? response.result : null;
    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.ok === false &&
      typeof result.code === "string" &&
      (mobileBridgeMailReplayMayRerun(request.method, result.code) || mobileBridgeTransientReplayMayRerun(request.method, result.code))
    ) {
      // Undecided mail answer: never the command's final word (M1, M7).
      if (!this.replayStore) return response;
      try {
        this.replayStore.release(deviceId, key, fingerprint);
        return response;
      } catch (error) {
        this.onError(errorOf(error));
        return this.completeReplay(deviceId, key, fingerprint, response, request.id);
      }
    }
    const acceptedNonReplayableBuild =
      request.method === "build.start" &&
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      typeof result.runId === "string" &&
      result.replayable === false;
    const acceptedNonReplayableVisualSession =
      request.method === "visualSession.create" &&
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.status === "live" &&
      typeof result.visualSessionId === "string";
    const acceptedPendingGoalShape = request.method === "goalPanel.shape" && result !== null
      && typeof result === "object" && !Array.isArray(result) && result.ok === true
      && result.outcome === "accepted" && result.pending === true && result.replayable === false;
    if (!acceptedNonReplayableBuild && !acceptedNonReplayableVisualSession && !acceptedPendingGoalShape) {
      return this.completeReplay(deviceId, key, fingerprint, response, request.id);
    }
    if (!this.replayStore) {
      return mobileBridgeFailure(
        request.id,
        "idempotency_unavailable",
        "Desktop accepted process-local state but cannot preserve its non-replayable marker",
      );
    }
    try {
      this.replayStore.markUncertain(deviceId, key, fingerprint);
      return response;
    } catch (error) {
      this.onError(errorOf(error));
      return mobileBridgeFailure(
        request.id,
        "idempotency_unavailable",
        "Desktop accepted process-local state but could not block unsafe replay; do not retry this key",
      );
    }
  }

  /**
   * Attach the authority subscription only while at least one client is
   * connected. The authority attaches its own expensive upstream listeners
   * (per-token invocation events, store-change snapshot refreshes) on its
   * first subscriber and drops them on its last — so keeping a permanent
   * server subscription made every desktop run pay the mobile projection
   * cost even with zero phones paired.
   */
  private syncAuthoritySubscription(): void {
    if (this.clients.size > 0) {
      if (!this.unsubscribeAuthority) {
        this.unsubscribeAuthority = this.authority.subscribe((event) => this.fanoutAuthorityEvent(event));
      }
      return;
    }
    if (this.unsubscribeAuthority) {
      this.unsubscribeAuthority();
      this.unsubscribeAuthority = null;
    }
  }

  private dropClient(state: ConnectionState): void {
    if (!this.clients.delete(state)) return;
    try { this.onePhoneOwners.get(state)?.closed(state.context); } catch { /* owner keeps sticky cleanup uncertainty */ }
    try {
      this.authority.connectionClosed?.(state.context);
    } catch (error) {
      this.onError(errorOf(error));
    }
    this.syncAuthoritySubscription();
  }

  private fanoutAuthorityEvent(event: MobileBridgeAuthorityEvent): void {
    if (this.clients.size === 0) return;
    if (!isMobileBridgeEventName(event.event) || !isMobileBridgeJsonValue(event.payload)) {
      this.onError(new Error("Mobile Bridge authority emitted an invalid event"));
      return;
    }
    const queuedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    for (const state of this.clients) {
      if (state.revoked || state.revocationPending) continue;
      const has = (capability: MobileClientCapability) =>
        this.authority.clientHasCapability?.(state.context.deviceId, capability) === true;
      if (event.requiresClientCapability && !has(event.requiresClientCapability)) continue;
      if (event.requiresClientCapabilities && !event.requiresClientCapabilities.every(has)) continue;
      if (event.withheldForClientCapabilities?.length && event.withheldForClientCapabilities.every(has)) continue;
      if (!state.initialized) {
        if (
          state.pendingAuthorityEvents.length >= MAX_INITIAL_EVENT_QUEUE ||
          state.pendingAuthorityBytes + queuedBytes > MAX_INITIAL_EVENT_QUEUE_BYTES
        ) {
          state.pendingAuthorityEvents.length = 0;
          state.pendingAuthorityBytes = 0;
          state.socket.close(1013, "initialization backlog exceeded");
          this.dropClient(state);
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

  /*
   * One line per broken connection, then stop writing to it. When a phone's socket drops, every write already
   * queued on it fails with its own EPIPE: 99 "[mobile-bridge] write EPIPE" lines in the same millisecond at
   * 2026-10-05 20:21:44 UTC (17 at 12:38:19), each a write the bridge kept making to a dead socket. The phone
   * reconnects and resynchronizes on its own (20:22:33 that time).
   */
  private transportError(state: ConnectionState, error: unknown, origin: "socket" | "write"): void {
    if (state.transportFailed) return;
    state.transportFailed = true;
    this.onError(errorOf(error));
    // A socket "error" may be a protocol refusal that ws closes itself with its own code (1009 for an oversized
    // frame); only a failed write proves the transport is gone and needs terminating.
    if (origin === "write") {
      try { state.socket.terminate(); } catch { /* already gone */ }
    }
  }

  private send(state: ConnectionState, message: MobileBridgeServerMessage, acknowledged?: (error?: Error) => void): void {
    if (state.revoked || state.transportFailed || state.socket.readyState !== WS_OPEN) { acknowledged?.(new Error('secure_route_unavailable')); return; }
    if (state.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      state.socket.terminate();
      acknowledged?.(new Error('secure_route_unavailable'));
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch (error) {
      this.onError(errorOf(error));
      state.socket.close(1011, "serialization failed");
      acknowledged?.(new Error("secure_route_unavailable"));
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
      this.onError(new Error("Mobile Bridge outbound message exceeded the wire limit"));
      state.socket.close(1009, "message too large");
      acknowledged?.(new Error("secure_route_unavailable"));
      return;
    }
    try { state.socket.send(encoded, (error) => {
      if (error) this.transportError(state, error, "write");
      acknowledged?.(error);
    }); } catch (error) { this.transportError(state, error, "write"); acknowledged?.(errorOf(error)); }
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
      this.dropClient(state);
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

  private lastLivenessAt = Date.now();

  private checkLiveness(): void {
    // A round that runs late (the main thread was blocked, measured 10-77 s on 2026-10-28) may run before the pongs that
    // arrived meanwhile are read: every healthy phone would read as dead and be cut. A late round judges nobody; it pings
    // again and the next on-time round decides.
    const at = Date.now();
    const late = at - this.lastLivenessAt > this.pingIntervalMs * 1.5;
    this.lastLivenessAt = at;
    for (const state of this.clients) {
      if (state.revoked) {
        state.socket.terminate();
        this.dropClient(state);
        continue;
      }
      if (!state.alive && !late) {
        state.socket.terminate();
        this.dropClient(state);
        continue;
      }
      state.alive = false;
      try {
        state.socket.ping();
      } catch (error) {
        this.onError(errorOf(error));
        state.socket.terminate();
        this.dropClient(state);
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
  /**
   * 지금 붙어 있는 전화를 전부 끊는다 — **자격은 지우지 않는다.**
   *
   * ★ 왜 필요한가 (2026-08-24 실측): 전화는 **연결을 맺을 때 한 번만** 인증한다. 그래서
   *   로그아웃해도 이미 붙어 있는 연결은 그대로 살아 계속 명령을 보낼 수 있었다. 계정 교체
   *   경로는 기기를 폐기하며 끊었지만, 로그아웃은 폐기 대상이 비어 있어(로그아웃엔 활성
   *   워크스페이스가 없다) 아무것도 끊지 않았다.
   *
   * 자격을 지우지 않는 이유는 따로 있다 — 예전에 로그아웃/부팅에서 지우다가 실제 기계에서
   * 짝지은 39대가 전부 끊겼다. 다시 로그인하면 그대로 살아나야 한다. 그래서 "끊되 지우지
   * 않는다" 가 옳은 자리다: 다시 붙으려면 로그인해야 하고(서명 게이트), 로그인하면 복구된다.
   */
  disconnectAllDevices(): number {
    const deviceIds = new Set<string>();
    for (const state of this.clients) {
      if (state.context.deviceId) deviceIds.add(state.context.deviceId);
    }
    for (const deviceId of deviceIds) this.disconnectDevice(deviceId);
    return deviceIds.size;
  }

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
      this.dropClient(state);
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
    for (const job of this.longJobs.values()) { if (job.ackTimer) clearTimeout(job.ackTimer); job.ackTimer = null; }
    this.longJobs.clear();
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
