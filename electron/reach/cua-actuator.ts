import { spawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Actuator, ActuatorApp, ActuatorPlatform, ActuatorStatus, ActuatorWindow, CallOptions, ToolOutcome } from "./actuator";
import { McpClientError, StdioMcpClient, defaultMcpSpawn, type McpSpawn } from "./mcp-client";

// The Cua Driver as an Actuator. Two processes, both children of the host app (macOS attributes Accessibility and Screen Recording to
// the responsible process, so the host must spawn them itself; see Cua's EMBEDDING.md):
//   daemon  `cua-driver serve --embedded --socket <private>`   owns the driver runtime
//   proxy   `cua-driver mcp --embedded --socket <private>`     speaks MCP on stdin/stdout, forwards to the daemon
// Hardened on purpose: an allow-listed environment, a home directory of its own (nothing is read from or written to a user's own
// Cua install), telemetry and update checks off, and the permission mode left at the driver's default.

export interface CuaActuatorOptions {
  executable: string;
  reachHome: string;
  hostBundleId: string;
  spawnFn?: McpSpawn;
  daemonSpawn?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
  readyTimeoutMs?: number;
  socketDirectory?: string;
  // Defaults to the platform this process runs on.
  platform?: NodeJS.Platform;
  // Where the Linux session variables come from. Defaults to this process's own environment.
  sessionEnv?: NodeJS.ProcessEnv;
}

// On Linux the driver finds the screen and the accessibility bus through the desktop session's own variables. Only these names are handed
// over (no tokens, no keys, nothing else of the user's environment).
const LINUX_SESSION_VARIABLES = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE"] as const;

export function cuaEnvironment(reachHome: string, hostBundleId: string, platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = path.join(reachHome, "drivers", "cua-home");
  const session: NodeJS.ProcessEnv = {};
  if (platform === "linux") for (const name of LINUX_SESSION_VARIABLES) { const value = source[name]; if (value) session[name] = value; }
  return {
    ...session,
    PATH: platform === "win32" ? (source.PATH ?? "") : "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USERPROFILE: home,
    CUA_DRIVER_RS_HOME: home,
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
    // Both spellings, because the driver hands only its own allow-list to children and DO_NOT_TRACK alone is not passed on.
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    DO_NOT_TRACK: "1",
    ...(platform === "win32" && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
}

export function socketCandidate(directory: string, platform: NodeJS.Platform = process.platform): string {
  // The Windows driver listens on a named pipe, not a file (its --socket option says "socket or named-pipe path").
  if (platform === "win32") return `\\\\.\\pipe\\agl-cua-${randomBytes(4).toString("hex")}`;
  // A Unix socket path must stay under ~104 bytes on macOS, so the name is short and the folder is a short temp folder.
  return path.join(directory, `agl-cua-${randomBytes(4).toString("hex")}.sock`);
}

async function waitForSocket(socketPath: string, timeoutMs: number, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive()) throw new McpClientError("mcp_closed", "the Cua daemon exited before it was ready");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    if (Date.now() > deadline) throw new McpClientError("mcp_timeout", "the Cua daemon did not open its socket in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function refusalOf(structured: Record<string, unknown> | undefined): string | undefined {
  const refusal = structured?.refusal as { code?: unknown } | undefined;
  return typeof refusal?.code === "string" ? refusal.code : undefined;
}

export class CuaActuator implements Actuator {
  readonly id = "cua-driver";
  readonly platform: ActuatorPlatform;
  private daemon: ChildProcess | null = null;
  private client: StdioMcpClient | null = null;
  private socketPath = "";
  private socketDirectory = "";
  private version: string | undefined;
  public daemonStderrTail = "";

  private constructor(private readonly options: CuaActuatorOptions) {
    const platform = options.platform ?? process.platform;
    this.platform = platform === "win32" || platform === "linux" ? platform : "darwin";
  }

  static async start(options: CuaActuatorOptions): Promise<CuaActuator> {
    const actuator = new CuaActuator(options);
    await actuator.boot();
    return actuator;
  }

  private async boot(): Promise<void> {
    const { executable, reachHome, hostBundleId } = this.options;
    const env = cuaEnvironment(reachHome, hostBundleId, this.options.platform ?? process.platform, this.options.sessionEnv ?? process.env);
    await fsp.mkdir(env.CUA_DRIVER_RS_HOME as string, { recursive: true, mode: 0o700 });
    this.socketDirectory = this.options.socketDirectory ?? await fsp.mkdtemp(path.join(os.tmpdir(), "agl-"));
    await fsp.chmod(this.socketDirectory, 0o700);
    this.socketPath = socketCandidate(this.socketDirectory, this.options.platform ?? process.platform);
    const daemonSpawn = this.options.daemonSpawn ?? ((command, args, environment) =>
      spawn(command, [...args], { env: environment, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false }));
    const daemon = daemonSpawn(executable, ["serve", "--embedded", "--socket", this.socketPath], env);
    this.daemon = daemon;
    daemon.stderr?.setEncoding("utf8");
    daemon.stderr?.on("data", (chunk: string) => { this.daemonStderrTail = (this.daemonStderrTail + chunk).slice(-2000); });
    let alive = true;
    daemon.once("close", () => { alive = false; });
    daemon.once("error", () => { alive = false; });
    try {
      await waitForSocket(this.socketPath, this.options.readyTimeoutMs ?? 15_000, () => alive);
      const client = new StdioMcpClient(executable, ["mcp", "--embedded", "--socket", this.socketPath], env, this.options.spawnFn ?? defaultMcpSpawn);
      const info = await client.start("agentlas-reach", "1");
      this.version = info.serverVersion;
      this.client = client;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<ToolOutcome> {
    const client = this.client;
    if (!client || !client.running) return { ok: false, text: "the driver is not running", errorCode: "actuator_closed" };
    try {
      const result = await client.callTool(tool, args, { timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal });
      const refusalCode = refusalOf(result.structured);
      return {
        ok: !result.isError,
        text: result.text,
        ...(result.structured ? { structured: result.structured } : {}),
        ...(refusalCode ? { refusalCode } : {}),
      };
    } catch (error) {
      const code = error instanceof McpClientError ? error.code : "actuator_error";
      return { ok: false, text: error instanceof Error ? error.message : "driver call failed", errorCode: code };
    }
  }

  async status(options: CallOptions = {}): Promise<ActuatorStatus> {
    const permissions = await this.call("check_permissions", { prompt: false }, options);
    if (!permissions.ok && permissions.errorCode) return { available: false, reason: permissions.errorCode };
    // macOS reports "Accessibility: granted"; Linux reports which display and which accessibility bus it reached; Windows reports that UI
    // Automation is available and whether messages can be posted to other windows (no permission exists to grant on Windows).
    const linux = this.platform === "linux";
    const windows = this.platform === "win32";
    const accessibility = linux ? /AT-SPI[^\n]*✅/.test(permissions.text) : windows ? /UIA accessibility:\s*available/i.test(permissions.text) : /Accessibility:\s*granted/i.test(permissions.text);
    const screenRecording = linux ? /X11 display:\s*✅/.test(permissions.text) : windows ? /PostMessage injection:\s*available/i.test(permissions.text) : /Screen Recording:\s*granted/i.test(permissions.text);
    return { available: true, ...(this.version ? { version: this.version } : {}), accessibility, screenRecording };
  }

  async listApps(options: CallOptions = {}): Promise<ActuatorApp[]> {
    const result = await this.call("list_apps", {}, options);
    if (!result.ok) return [];
    // "- Finder (pid 812) [com.apple.finder]" for running apps; installed-only apps carry pid 0.
    const apps: ActuatorApp[] = [];
    for (const line of result.text.split("\n")) {
      const match = /^- (.+?) \(pid (\d+)\)(?: \[([^\]]+)\])?/.exec(line.trim());
      if (!match) continue;
      const pid = Number(match[2]);
      apps.push({ name: match[1], pid, running: pid > 0, ...(match[3] ? { bundleId: match[3] } : {}) });
    }
    const structured = result.structured?.apps;
    if (Array.isArray(structured)) {
      return structured.flatMap((item): ActuatorApp[] => {
        const app = item as { name?: unknown; pid?: unknown; bundle_id?: unknown; running?: unknown };
        if (typeof app.name !== "string") return [];
        const pid = typeof app.pid === "number" ? app.pid : 0;
        return [{ name: app.name, pid, running: app.running === true || pid > 0, ...(typeof app.bundle_id === "string" ? { bundleId: app.bundle_id } : {}) }];
      });
    }
    return apps;
  }

  async listWindows(filter: { app?: string; pid?: number }, options: CallOptions = {}): Promise<ActuatorWindow[]> {
    const result = await this.call("list_windows", { ...(filter.app ? { app: filter.app } : {}), ...(filter.pid ? { pid: filter.pid } : {}) }, options);
    const windows = result.structured?.windows;
    if (!result.ok || !Array.isArray(windows)) return [];
    return windows.flatMap((item): ActuatorWindow[] => {
      const w = item as Record<string, unknown>;
      const bounds = w.bounds as Record<string, number> | undefined;
      if (typeof w.window_id !== "number" || typeof w.pid !== "number") return [];
      return [{
        windowId: w.window_id,
        pid: w.pid,
        appName: typeof w.app_name === "string" ? w.app_name : "",
        title: typeof w.title === "string" ? w.title : "",
        onScreen: w.is_on_screen === true,
        layer: typeof w.layer === "number" ? w.layer : 0,
        ...(typeof w.z_index === "number" ? { zIndex: w.z_index } : {}),
        bounds: { x: bounds?.x ?? 0, y: bounds?.y ?? 0, width: bounds?.width ?? 0, height: bounds?.height ?? 0 },
      }];
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
    const daemon = this.daemon;
    this.daemon = null;
    if (daemon && daemon.exitCode === null) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { try { daemon.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
        daemon.once("close", () => { clearTimeout(kill); resolve(); });
        try { daemon.kill("SIGTERM"); } catch { clearTimeout(kill); resolve(); }
      });
    }
    if (this.socketDirectory) await fsp.rm(this.socketDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
