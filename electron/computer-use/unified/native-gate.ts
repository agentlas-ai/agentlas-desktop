import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface NativeCuaGateSession {
  runtime: string;
  sessionKey: string;
  permission?: "read" | "write" | "full";
  simulation?: true;
  cwd?: string;
  chatId?: string;
  unattended?: boolean;
}

export interface NativeCuaToolGateOptions {
  controlFile: string;
  serverKey: string;
  session: NativeCuaGateSession;
  planPath?: string;
}

export interface NativeCuaToolGate {
  authorize(toolName: string, signal?: AbortSignal): Promise<void>;
}

function exactText(value: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`unified-cua-native-gate-${label}-invalid`);
  return value;
}

function privateJson(file: string, maxBytes: number): Record<string, unknown> {
  if (!path.isAbsolute(file)) throw new Error("unified-cua-native-gate-file-invalid");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error("unified-cua-native-gate-file-invalid");
  }
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
    throw new Error("unified-cua-native-gate-file-permissions-invalid");
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unified-cua-native-gate-file-invalid");
  return parsed as Record<string, unknown>;
}

function assertPlanAllows(planPath: string | undefined, qualifiedTool: string): void {
  if (!planPath) return;
  let plan: Record<string, unknown>;
  try { plan = privateJson(planPath, 1024 * 1024); }
  catch { throw new Error("unified-cua-native-gate-plan-unavailable"); }
  if (Array.isArray(plan.denyExact) && plan.denyExact.includes(qualifiedTool)) {
    throw new Error("unified-cua-native-gate-plan-denied");
  }
  if (plan.denyUndeclaredMcp === true) {
    const prefixes = Array.isArray(plan.allowPrefixes)
      ? plan.allowPrefixes.filter((value): value is string => typeof value === "string")
      : [];
    if (!prefixes.some((prefix) => qualifiedTool.startsWith(prefix))) {
      throw new Error("unified-cua-native-gate-plan-undeclared");
    }
  }
}

function approval(options: NativeCuaToolGateOptions, toolName: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let control: Record<string, unknown>;
  try { control = privateJson(options.controlFile, MAX_CONTROL_BYTES); }
  catch { return Promise.reject(new Error("unified-cua-native-gate-channel-unavailable")); }
  const port = control.port;
  const token = control.token;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof token !== "string" || !token) {
    return Promise.reject(new Error("unified-cua-native-gate-channel-invalid"));
  }
  const body = Buffer.from(JSON.stringify({
    serverKey: options.serverKey,
    toolName,
    sessionKey: options.session.sessionKey,
    runtime: options.session.runtime,
    permission: options.session.permission,
    simulation: options.session.simulation === true,
    cwd: options.session.cwd,
    chatId: options.session.chatId,
    unattended: options.session.unattended === true,
    catalogId: "cua-driver",
  }), "utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      error ? reject(error) : resolve();
    };
    const req = http.request({ host: "127.0.0.1", port: Number(port), path: "/approve", method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(body.length),
    }, timeout: 10 * 60_000 }, (res) => {
      res.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else req.destroy(new Error("unified-cua-native-gate-response-too-large"));
      });
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          finish(new Error("unified-cua-native-gate-unauthorized"));
          return;
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { decision?: unknown };
          if (res.statusCode === 200 && value.decision === "allow") finish();
          else finish(new Error("unified-cua-native-gate-denied"));
        } catch { finish(new Error("unified-cua-native-gate-response-invalid")); }
      });
    });
    const cancel = () => { req.destroy(); finish(new Error("unified-cua-native-gate-cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    req.on("error", () => finish(new Error(signal?.aborted
      ? "unified-cua-native-gate-cancelled" : "unified-cua-native-gate-channel-unavailable")));
    req.on("timeout", () => { req.destroy(); finish(new Error("unified-cua-native-gate-expired")); });
    req.end(body);
  });
}

export function createNativeCuaToolGate(options: NativeCuaToolGateOptions): NativeCuaToolGate {
  const serverKey = exactText(options.serverKey, "server-key", 160);
  exactText(options.session.runtime, "runtime", 160);
  exactText(options.session.sessionKey, "session-key", 512);
  const fixed = { ...options, serverKey, session: { ...options.session } };
  return {
    async authorize(toolName, signal) {
      const name = exactText(toolName, "tool-name", 160);
      assertPlanAllows(fixed.planPath, `mcp__${serverKey}__${name}`);
      await approval(fixed, name, signal);
    },
  };
}
