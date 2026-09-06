import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, withCliPath } from "../runtime/exec";

export const SCIENCE_MCP_SERVER_KEY = "agentlas-science";

/**
 * Exact Science MCP operations that do not replace a human research decision.
 *
 * These calls either read state, create a derived/pre-review record, verify an approval that the
 * Science UI already persisted, or close terminal episode bookkeeping. Analysis execution,
 * manuscript application/export, publication, and human decisions deliberately remain outside
 * this list and continue through the ordinary approval boundary.
 */
export const SCIENCE_CODEX_EXACT_TOOL_APPROVALS = [
  { toolName: "inspect_research_workspace", effect: "bounded-read" },
  { toolName: "list_research_hypotheses", effect: "bounded-read" },
  { toolName: "inspect_evidence_graph", effect: "derived-projection-refresh" },
  { toolName: "inspect_research_loop", effect: "bounded-read" },
  { toolName: "describe_statistics_capabilities", effect: "bounded-read" },
  { toolName: "list_analysis_plans", effect: "bounded-read" },
  { toolName: "prepare_paired_statistics_table", effect: "derived-artifact-preparation" },
  { toolName: "propose_analysis_plan", effect: "pre-review-draft" },
  { toolName: "freeze_analysis_plan", effect: "verify-existing-human-approval" },
  { toolName: "settle_research_episode", effect: "terminal-bookkeeping" },
] as const;

export function scienceCodexExactToolApprovalConfigArgs(
  supported: boolean,
  toolNames: readonly string[] = SCIENCE_CODEX_EXACT_TOOL_APPROVALS.map(({ toolName }) => toolName),
): string[] {
  if (!supported) return [];
  const exactNames = [...new Set(toolNames)];
  if (exactNames.length < 1 || exactNames.length > 300
    || exactNames.some((toolName) => !/^[a-z][a-z0-9_]{0,79}$/u.test(toolName))) {
    throw new Error("science-codex-tool-approval-catalog-invalid");
  }
  return exactNames.flatMap((toolName) => [
    "-c",
    `mcp_servers.${SCIENCE_MCP_SERVER_KEY}.tools.${toolName}.approval_mode="approve"`,
  ]);
}

const capabilityByInstalledCli = new Map<string, Promise<boolean>>();

export interface ScienceCodexExecutableIdentity {
  realPath: string;
  fingerprint: string;
}

function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return env[key] ?? "";
}

function executableExtensions(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || path.extname(command)) return [""];
  const key = Object.keys(env).find((name) => name.toLowerCase() === "pathext") ?? "PATHEXT";
  return (env[key] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

/** Resolve the same PATH surface used by spawnCli and bind the cache to the actual file identity. */
export function scienceCodexExecutableIdentity(command: string): ScienceCodexExecutableIdentity | null {
  const env = withCliPath(process.env);
  const hasSeparator = command.includes("/") || command.includes("\\");
  const bases = path.isAbsolute(command) || hasSeparator
    ? [path.resolve(command)]
    : pathValue(env).split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  for (const base of bases) {
    for (const extension of executableExtensions(command, env)) {
      const candidate = `${base}${extension}`;
      try {
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        const realPath = fs.realpathSync(candidate);
        const stat = fs.statSync(realPath, { bigint: true });
        if (!stat.isFile()) continue;
        return {
          realPath,
          fingerprint: [realPath, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":").toString(),
        };
      } catch {
        // Keep searching PATH. Missing, unreadable, and broken symlink candidates are not usable.
      }
    }
  }
  return null;
}

/**
 * Ask the installed CLI parser and app-server handshake, rather than guessing from a version.
 * Unknown CLI, strict-config rejection, startup failure, timeout, or malformed response all fail
 * closed: the caller receives no automatic-approval overrides and Codex keeps prompting normally.
 */
export async function installedCodexSupportsExactMcpToolApproval(): Promise<boolean> {
  const commands = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  const identity = commands.map(scienceCodexExecutableIdentity).find((value) => value !== null) ?? null;
  if (!identity) return false;
  const version = await probeCliVersion(identity.realPath, 3_000);
  if (!version) return false;
  const key = `${identity.fingerprint}\0${version}`;
  let probe = capabilityByInstalledCli.get(key);
  if (!probe) {
    try {
      probe = probeExactMcpToolApproval(identity.realPath);
    } catch {
      return false;
    }
    capabilityByInstalledCli.set(key, probe);
  }
  try {
    const supported = await probe;
    // A transient spawn/startup/timeout failure must not become a process-lifetime capability fact.
    if (!supported && capabilityByInstalledCli.get(key) === probe) capabilityByInstalledCli.delete(key);
    return supported;
  } catch {
    if (capabilityByInstalledCli.get(key) === probe) capabilityByInstalledCli.delete(key);
    return false;
  }
}

function validInitializeResult(value: unknown, probeHome: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (
    typeof result.userAgent !== "string" || !result.userAgent.trim()
    || typeof result.codexHome !== "string" || !result.codexHome.trim()
    || typeof result.platformFamily !== "string" || !result.platformFamily.trim()
    || typeof result.platformOs !== "string" || !result.platformOs.trim()
  ) return false;
  try {
    return fs.realpathSync(result.codexHome) === fs.realpathSync(probeHome);
  } catch {
    return false;
  }
}

function probeExactMcpToolApproval(bin: string): Promise<boolean> {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-tool-approval-"));
  const args = [
    "app-server",
    "--strict-config",
    "-c", "analytics.enabled=false",
    "-c", `mcp_servers.${SCIENCE_MCP_SERVER_KEY}.command=${JSON.stringify(process.execPath)}`,
    ...scienceCodexExactToolApprovalConfigArgs(true),
    "--listen", "stdio://",
  ];

  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let stdout = "";
    const cleanup = () => {
      try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) killCliTree(child, 250);
      resolve(supported);
    };
    const timeout = setTimeout(() => finish(false), 5_000);
    timeout.unref?.();

    try {
      child = spawnCli(bin, args, {
        ...detachedSpawnOpts(),
        env: {
          ...process.env,
          CODEX_HOME: probeHome,
          // The parser/handshake probe has no reason to contact analytics or persisted remote control.
          CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(false);
      return;
    }

    child.once("error", () => finish(false));
    child.once("close", () => {
      cleanup();
      finish(false);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-32_768);
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
            if (message.id === 1) {
              finish(!message.error && validInitializeResult(message.result, probeHome));
              return;
            }
          } catch {
            // Ignore logs; only a valid JSON-RPC initialize response proves support.
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.stdin?.on("error", () => finish(false));
    try {
      child.stdin?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agentlas-desktop-capability-probe", version: "1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`);
    } catch {
      finish(false);
    }
  });
}
