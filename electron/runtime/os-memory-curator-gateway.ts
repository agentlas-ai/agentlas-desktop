import http, { type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";

export interface OsCuratorRequestLease {
  readonly signals: readonly AbortSignal[];
  assertCurrent(): void;
  generate(input: { system: string; input: string; maxOutputTokens: number }, signal: AbortSignal): Promise<{ model: string; output: string }>;
  release(): void;
}
export interface OsCuratorGateway {
  readonly config: Readonly<{ kind: "openai-compatible"; endpoint: string; model: string; apiKey: string }>;
  /** Closes admission/HTTP and requests cancellation; physical callbacks may still be draining. */
  close(): void;
}
const MAX_INPUT = 160 * 1024, MAX_OUTPUT = 48_000, MAX_ACTIVE = 4;
export class OsCuratorGatewayError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new OsCuratorGatewayError(code); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
async function body(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  const abort = () => req.destroy(new OsCuratorGatewayError("os_curator_cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of req) {
      signal.throwIfAborted(); bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT) fail("os_curator_input_limit");
      chunks.push(Buffer.from(chunk));
    }
    const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!value) fail("os_curator_request_invalid");
    return value;
  } finally { signal.removeEventListener("abort", abort); }
}
/** Pure transport: all selection/custody authority comes from the native lease factory. */
export async function createOsCuratorGateway(input: {
  model: string;
  capture(system: string, user: string): OsCuratorRequestLease;
  signal: AbortSignal;
}, options: { timeoutMs?: number } = {}): Promise<OsCuratorGateway> {
  if (!input.model || input.signal.aborted) fail("os_curator_binding_unavailable");
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail("os_curator_timeout_invalid");
  const route = `/${randomBytes(24).toString("hex")}/v1`, token = randomBytes(32).toString("hex");
  const active = new Set<AbortController>(), sockets = new Set<Socket>(); let closed = false;
  const server = http.createServer(async (req, res) => {
    const control = new AbortController(); let lease: OsCuratorRequestLease | undefined, finished = false;
    const releases: Array<() => void> = [];
    let httpDone = false, callSettled = true, ownershipReleased = false;
    // HTTP cancellation can win the race while a provider ignores its signal.
    // Keep this exact request's custody and capacity until the actual callback settles.
    const finishOwnership = () => {
      if (!httpDone || !callSettled || ownershipReleased) return;
      ownershipReleased = true;
      try { lease?.release(); }
      finally {
        releases.forEach(release => release());
        input.signal.removeEventListener("abort", abort); active.delete(control);
      }
    };
    const abort = () => control.abort(new OsCuratorGatewayError("os_curator_cancelled"));
    const send = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value));
    };
    if (closed || input.signal.aborted || active.size >= MAX_ACTIVE) { send(409, { error: { code: "os_curator_unavailable" } }); return; }
    active.add(control);
    // Deadline includes request body acquisition, not only provider execution.
    const timer = setTimeout(() => control.abort(new OsCuratorGatewayError("os_curator_timeout")), timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    req.once("aborted", abort); res.once("close", () => { if (!finished) abort(); });
    try {
      if (req.method !== "POST" || req.url !== `${route}/chat/completions`
        || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") fail("os_curator_route_invalid");
      const auth = req.headers.authorization || "", expected = `Bearer ${token}`;
      const authBytes = Buffer.from(auth), expectedBytes = Buffer.from(expected);
      if (authBytes.length !== expectedBytes.length || !timingSafeEqual(authBytes, expectedBytes)) fail("os_curator_auth_invalid");
      const value = await body(req, control.signal);
      if (Object.keys(value).some(key => !["model", "messages", "stream", "temperature", "max_tokens"].includes(key))
        || value.model !== input.model || value.stream !== undefined && value.stream !== false
        || value.temperature !== undefined && value.temperature !== 0 || !Number.isSafeInteger(value.max_tokens)
        || Number(value.max_tokens) < 1 || Number(value.max_tokens) > 1600) fail("os_curator_request_invalid");
      const messages = value.messages;
      if (!Array.isArray(messages) || messages.length !== 2) fail("os_curator_messages_invalid");
      const system = record(messages[0]), user = record(messages[1]);
      if (!system || !user || system.role !== "system" || user.role !== "user"
        || Object.keys(system).some(key => !["role", "content"].includes(key))
        || Object.keys(user).some(key => !["role", "content"].includes(key))
        || typeof system.content !== "string" || typeof user.content !== "string"
        || Buffer.byteLength(system.content) > 16 * 1024 || Buffer.byteLength(user.content) > 128 * 1024) fail("os_curator_messages_invalid");
      control.signal.throwIfAborted(); lease = input.capture(system.content, user.content);
      for (const signal of lease.signals) {
        if (signal.aborted) abort();
        else { signal.addEventListener("abort", abort, { once: true }); releases.push(() => signal.removeEventListener("abort", abort)); }
      }
      lease.assertCurrent(); control.signal.throwIfAborted();
      const stopped = new Promise<never>((_, reject) => control.signal.addEventListener("abort", () => reject(control.signal.reason), { once: true }));
      callSettled = false;
      const call = Promise.resolve().then(() => {
        control.signal.throwIfAborted();
        return lease!.generate({ system: system.content as string, input: user.content as string, maxOutputTokens: Number(value.max_tokens) }, control.signal);
      });
      const settled = () => { callSettled = true; finishOwnership(); };
      void call.then(settled, settled);
      const result = await Promise.race([call, stopped]);
      control.signal.throwIfAborted(); lease.assertCurrent();
      if (result.model !== input.model || typeof result.output !== "string" || !result.output.trim()
        || Buffer.byteLength(result.output) > MAX_OUTPUT || !record(JSON.parse(result.output))) fail("os_curator_output_invalid");
      finished = true; send(200, { choices: [{ message: { role: "assistant", content: result.output } }] });
    } catch (error) {
      finished = true;
      const code = control.signal.aborted ? (control.signal.reason instanceof OsCuratorGatewayError && control.signal.reason.code === "os_curator_timeout" ? "os_curator_timeout" : "os_curator_cancelled")
        : error instanceof OsCuratorGatewayError ? error.code : "os_curator_unavailable";
      send(409, { error: { code } });
    } finally {
      clearTimeout(timer); req.removeListener("aborted", abort);
      httpDone = true; finishOwnership();
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.headersTimeout = timeoutMs; server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") fail("os_curator_listen_failed");
  const close = () => {
    if (closed) return; closed = true;
    for (const request of active) request.abort(new OsCuratorGatewayError("os_curator_cancelled"));
    for (const socket of sockets) socket.destroy();
    server.close(); input.signal.removeEventListener("abort", close);
  };
  input.signal.addEventListener("abort", close, { once: true });
  if (input.signal.aborted) { close(); fail("os_curator_binding_unavailable"); }
  return { config: Object.freeze({ kind: "openai-compatible", endpoint: `http://127.0.0.1:${address.port}${route}`, model: input.model, apiKey: token }), close };
}
