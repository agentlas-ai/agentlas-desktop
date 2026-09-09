import http from "node:http";
import https from "node:https";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { killCliTree } from "../runtime/exec";
import {
  removeWorkspacePreviewCapability,
  writeWorkspacePreviewCapability,
  type WorkspacePreviewCapabilityBinding,
} from "./channel";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 4_000;
const PREVIEW_RECEIPT_DIR = "receipts";

export interface WorkspacePreviewCapability {
  path: string;
  binding: WorkspacePreviewCapabilityBinding;
}

export interface WorkspacePreviewReceipt {
  schemaVersion: 1;
  previewId: string;
  taskScopeId: string;
  chatId: string | null;
  runId: string | null;
  cwd: string;
  commandFingerprint: string;
  expectedUrl: string | null;
  pid: number | null;
  status: "starting" | "running" | "stopping" | "exited" | "stopped" | "failed";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reachable: boolean | null;
  callerPermission: "read" | "write" | "full";
  ownerGrantId: string | null;
  ownerExecutionPermission: "full" | null;
}

interface ActivePreview {
  receipt: WorkspacePreviewReceipt;
  child: ChildProcess;
  binding: WorkspacePreviewCapabilityBinding;
}

interface ControlRequest {
  token?: unknown;
  capabilityId?: unknown;
  operation?: unknown;
  previewId?: unknown;
  command?: unknown;
  expectedUrl?: unknown;
}

let server: http.Server | null = null;
let boundPort = 0;
let serverToken = "";
let serverStarting: Promise<number> | null = null;
let shutdownRegistered = false;
const capabilities = new Map<string, WorkspacePreviewCapabilityBinding>();
const activePreviews = new Map<string, ActivePreview>();

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return resolve(null);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

function nonEmpty(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function loopbackUrl(value: unknown): string | null {
  const raw = nonEmpty(value, 2_000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!(url.protocol === "http:" || url.protocol === "https:") ||
      !(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")) return null;
    if (url.username || url.password) return null;
    if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) return null;
    return url.toString();
  } catch { return null; }
}

function fingerprintCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 32);
}

function shellSpec(): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: process.env.ComSpec?.trim() || "cmd.exe", args: ["/d", "/s", "/c"] };
  const candidates = process.platform === "darwin"
    ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
    : [process.env.SHELL, "/bin/bash", "/bin/sh"];
  const command = candidates.find((candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) return false;
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  }) ?? "/bin/sh";
  return { command, args: ["-lc"] };
}

function receiptDir(): string {
  return userDataPath("workspace-preview", PREVIEW_RECEIPT_DIR);
}

function persistReceipt(receipt: WorkspacePreviewReceipt): void {
  try {
    fs.mkdirSync(receiptDir(), { recursive: true, mode: 0o700 });
    const target = path.join(receiptDir(), `${receipt.previewId}.json`);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
  } catch {
    // The receipt is observability; it must not keep the preview process from running.
  }
}

function closePreview(active: ActivePreview, status: "stopped" | "failed"): void {
  if (active.receipt.status === "exited" || active.receipt.status === "stopped" || active.receipt.status === "failed") return;
  active.receipt.status = status;
  active.receipt.endedAt = new Date().toISOString();
  persistReceipt(active.receipt);
  activePreviews.delete(active.receipt.previewId);
}

function waitForPreviewExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
    timer.unref?.();
  });
}

function stopPreviewProcess(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    // child.kill() only targets the shell leader on Windows. Use taskkill's
    // explicit process-tree mode without a shell so dev servers and their
    // descendants cannot survive a preview stop.
    const treeKill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallback = () => { try { child.kill(); } catch { /* already exited */ } };
    treeKill.once("error", fallback);
    treeKill.once("close", (code) => { if (code !== 0) fallback(); });
    return;
  }
  killCliTree(child);
}

function bindingOwns(binding: WorkspacePreviewCapabilityBinding, receipt: WorkspacePreviewReceipt): boolean {
  // Grants are intentionally turn-scoped and rotate on each invocation. The
  // durable owner is the Main-bound task scope and canonical cwd; requiring the
  // opaque grant id here would strand a live preview when a later goal cycle
  // legitimately rebinds the same task.
  return binding.taskScopeId === receipt.taskScopeId && binding.cwd === receipt.cwd;
}

async function checkReachable(url: string | null): Promise<boolean | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return finish(false); }
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, { method: "GET", timeout: 1_500 }, (response) => {
      response.resume();
      response.once("end", () => finish((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300));
    });
    request.once("error", () => finish(false));
    request.once("timeout", () => { request.destroy(); finish(false); });
    request.end();
  });
}

function requireBinding(request: ControlRequest): WorkspacePreviewCapabilityBinding | null {
  const token = nonEmpty(request.token, 128);
  const capabilityId = nonEmpty(request.capabilityId, 128);
  if (!token || token !== serverToken || !capabilityId) return null;
  return capabilities.get(capabilityId) ?? null;
}

async function startPreview(binding: WorkspacePreviewCapabilityBinding, request: ControlRequest, signal?: AbortSignal): Promise<WorkspacePreviewReceipt> {
  const command = nonEmpty(request.command, MAX_COMMAND_LENGTH);
  if (!command) throw new Error("workspace-preview-command-invalid");
  if (!path.isAbsolute(binding.cwd)) throw new Error("workspace-preview-cwd-invalid");
  let cwdStat: fs.Stats;
  try { cwdStat = fs.statSync(binding.cwd); } catch { throw new Error("workspace-preview-cwd-invalid"); }
  if (!cwdStat.isDirectory()) throw new Error("workspace-preview-cwd-invalid");
  let canonicalCwd: string;
  try { canonicalCwd = fs.realpathSync(binding.cwd); } catch { throw new Error("workspace-preview-cwd-invalid"); }
  if (canonicalCwd !== binding.cwd) throw new Error("workspace-preview-cwd-changed");
  const expectedUrl = request.expectedUrl === undefined ? null : loopbackUrl(request.expectedUrl);
  if (request.expectedUrl !== undefined && !expectedUrl) throw new Error("workspace-preview-url-must-be-loopback");

  if (binding.ownerExecutionPermission !== "full" || !binding.ownerGrantId) {
    throw new Error("workspace-preview-owner-full-grant-required");
  }
  if (binding.permission === "read") throw new Error("workspace-preview-requires-write-access");
  if (signal?.aborted) throw new Error("workspace-preview-request-cancelled");

  for (const active of activePreviews.values()) {
    if (!bindingOwns(binding, active.receipt)) continue;
    if (active.receipt.commandFingerprint === fingerprintCommand(command)) {
      if (active.receipt.expectedUrl !== expectedUrl) throw new Error("workspace-preview-url-mismatch");
      return active.receipt;
    }
    throw new Error("workspace-preview-already-running");
  }

  // A preview receives normal project tooling but never Main's opaque credential aliases.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/iu.test(key)));
  const shell = shellSpec();
  const child = spawn(shell.command, [...shell.args, command], {
      cwd: binding.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  child.unref();
  const receipt: WorkspacePreviewReceipt = {
    schemaVersion: 1,
    previewId: randomUUID(),
    taskScopeId: binding.taskScopeId,
    chatId: binding.chatId,
    runId: binding.runId,
    cwd: binding.cwd,
    commandFingerprint: fingerprintCommand(command),
    expectedUrl,
    pid: child.pid ?? null,
    status: "starting",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    reachable: null,
    callerPermission: binding.permission,
    ownerGrantId: binding.ownerGrantId,
    ownerExecutionPermission: binding.ownerExecutionPermission,
  };
  const active: ActivePreview = { receipt, child, binding };
  activePreviews.set(receipt.previewId, active);
  persistReceipt(receipt);
  // Drain output so a chatty dev server cannot block on a pipe. Output is
  // deliberately not returned or persisted: it may contain project secrets.
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  child.once("spawn", () => {
    if (receipt.status === "starting") receipt.status = "running";
    persistReceipt(receipt);
  });
  child.once("error", (error) => {
    closePreview(active, "failed");
  });
  child.once("exit", (code, signal) => {
    receipt.exitCode = code;
    receipt.signal = signal;
    if (receipt.status === "stopping") {
      receipt.status = "stopped";
      receipt.endedAt = new Date().toISOString();
      persistReceipt(receipt);
      activePreviews.delete(receipt.previewId);
    } else if (receipt.status !== "stopped" && receipt.status !== "failed") {
      receipt.status = "exited";
      receipt.endedAt = new Date().toISOString();
      persistReceipt(receipt);
      activePreviews.delete(receipt.previewId);
    }
  });
  return receipt;
}

async function statusPreview(binding: WorkspacePreviewCapabilityBinding, request: ControlRequest): Promise<WorkspacePreviewReceipt> {
  const previewId = nonEmpty(request.previewId, 128);
  if (!previewId) throw new Error("workspace-preview-id-invalid");
  const active = activePreviews.get(previewId);
  if (!active) {
    const persisted = readPersistedReceipt(previewId);
    if (persisted && bindingOwns(binding, persisted)
      && ["stopped", "exited", "failed"].includes(persisted.status)) return persisted;
    // A persisted starting/running receipt is historical evidence only. This
    // process has no live child for it and must never present it as live after
    // an app restart or worker handoff outside the Main process.
    throw new Error(persisted ? "workspace-preview-process-not-live" : "workspace-preview-not-found");
  }
  if (!bindingOwns(binding, active.receipt)) throw new Error("workspace-preview-not-found");
  if (active.receipt.status === "starting" || active.receipt.status === "running" || active.receipt.status === "stopping") {
    active.receipt.reachable = await checkReachable(active.receipt.expectedUrl);
    persistReceipt(active.receipt);
  }
  return active.receipt;
}

async function stopPreview(binding: WorkspacePreviewCapabilityBinding, request: ControlRequest): Promise<WorkspacePreviewReceipt> {
  const previewId = nonEmpty(request.previewId, 128);
  if (!previewId) throw new Error("workspace-preview-id-invalid");
  const active = activePreviews.get(previewId);
  if (!active) {
    const persisted = readPersistedReceipt(previewId);
    if (persisted && bindingOwns(binding, persisted) && ["stopped", "exited", "failed"].includes(persisted.status)) return persisted;
    throw new Error("workspace-preview-not-found");
  }
  if (!bindingOwns(binding, active.receipt)) throw new Error("workspace-preview-not-found");
  if (active.receipt.status !== "stopping") {
    active.receipt.status = "stopping";
    persistReceipt(active.receipt);
  }
  stopPreviewProcess(active.child);
  await waitForPreviewExit(active.child);
  if (activePreviews.has(active.receipt.previewId) && active.receipt.status === "stopping") {
    // Keep the receipt visibly stopping until the OS confirms process exit.
    persistReceipt(active.receipt);
  }
  return active.receipt;
}

function listPreviews(binding: WorkspacePreviewCapabilityBinding): WorkspacePreviewReceipt[] {
  return [...activePreviews.values()]
    .filter((active) => bindingOwns(binding, active.receipt))
    .map((active) => active.receipt);
}

async function handleRequest(request: ControlRequest, signal?: AbortSignal): Promise<unknown> {
  const binding = requireBinding(request);
  if (!binding) throw new Error("workspace-preview-capability-invalid");
  switch (request.operation) {
    case "start": return startPreview(binding, request, signal);
    case "status": return statusPreview(binding, request);
    case "stop": return stopPreview(binding, request);
    case "list": return listPreviews(binding);
    default: throw new Error("workspace-preview-operation-invalid");
  }
}

function readPersistedReceipt(previewId: string): WorkspacePreviewReceipt | null {
  try {
    const raw = fs.readFileSync(path.join(receiptDir(), `${previewId}.json`), "utf8");
    const value = JSON.parse(raw) as WorkspacePreviewReceipt;
    return value && value.schemaVersion === 1 && value.previewId === previewId ? value : null;
  } catch { return null; }
}

function disposePreviews(): void {
  for (const active of [...activePreviews.values()]) stopPreviewProcess(active.child);
  activePreviews.clear();
  capabilities.clear();
  if (server) { try { server.close(); } catch { /* best effort */ } }
  server = null;
  boundPort = 0;
  serverToken = "";
}

export function startWorkspacePreviewControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/preview") return writeJson(res, 404, { ok: false, error: "not-found" });
      const requestAbort = new AbortController();
      req.once("aborted", () => requestAbort.abort());
      res.once("close", () => { if (!res.writableEnded) requestAbort.abort(); });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          const result = await handleRequest(body as ControlRequest, requestAbort.signal);
          writeJson(res, 200, { ok: true, result });
        } catch (error) {
          writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "workspace-preview-failed" });
        }
      });
    });
    srv.once("error", () => { server = null; boundPort = 0; resolve(0); });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        onHostShutdown(disposePreviews);
      }
      resolve(boundPort);
    });
  });
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

export async function createWorkspacePreviewCapability(input: Omit<WorkspacePreviewCapabilityBinding, "capabilityId">, configKey: string): Promise<WorkspacePreviewCapability> {
  const port = await startWorkspacePreviewControlServer();
  if (!port) throw new Error("workspace-preview-control-unavailable");
  if (!path.isAbsolute(input.cwd)) throw new Error("workspace-preview-cwd-invalid");
  let cwd: string;
  try { cwd = fs.realpathSync(input.cwd); } catch { throw new Error("workspace-preview-cwd-invalid"); }
  const binding: WorkspacePreviewCapabilityBinding = { ...input, cwd, capabilityId: randomUUID() };
  capabilities.set(binding.capabilityId, binding);
  const filePath = writeWorkspacePreviewCapability(configKey, {
    schemaVersion: 1,
    port,
    token: serverToken,
    capabilityId: binding.capabilityId,
  });
  return { path: filePath, binding };
}

export function removeWorkspacePreviewCapabilityForConfig(configKey: string, capabilityId?: string): void {
  if (capabilityId) capabilities.delete(capabilityId);
  removeWorkspacePreviewCapability(configKey, capabilityId);
}

/** Stop previews owned by a deleted Goal while keeping unrelated project work alive. */
export function stopWorkspacePreviewsForTaskScope(taskScopeId: string): void {
  for (const active of [...activePreviews.values()]) {
    if (active.receipt.taskScopeId !== taskScopeId) continue;
    active.receipt.status = "stopping";
    persistReceipt(active.receipt);
    stopPreviewProcess(active.child);
  }
}
