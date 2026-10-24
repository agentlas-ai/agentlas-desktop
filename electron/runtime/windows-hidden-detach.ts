// A child that must outlive the process that started it, without a console window on Windows.
//
// POSIX: `detached: true` puts the child in its own process group; it outlives the parent and owns its own tree.
// Windows: Node maps `detached: true` to DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP. DETACHED_PROCESS gives the child no
// console at all, so every console program it starts (python's subprocesses, cmd, git) gets a NEW, visible console
// window — the blank windows of the first Windows runs (2026-10-23/24, Agentlas-OS 098fcabe6 traced the updater's).
// `windowsHide` alone (CREATE_NO_WINDOW) gives a hidden console that grandchildren inherit, but a child spawned without
// `detached` is placed in libuv's kill-on-close job object and dies with its parent — the updater and the service's
// background tasks are meant to keep running after Desktop / the service exits.
//
// Windows therefore starts a tiny launcher: Node (this executable as Node) started detached — it needs no console and
// breaks away from the parent's job — which starts the real program with `windowsHide` (a hidden console its children
// inherit), forwards its stdio handles, waits for it and exits with its code. Stopping the launcher's tree (taskkill /T)
// stops the program; the program also dies with the launcher (it sits in the launcher's job).
//
// Pure (no Electron import) so Desktop Main, the service and a plain-Node gate share it
// (scripts/test-windows-hidden-detached-spawns.cjs).
import type { SpawnOptions, StdioOptions } from "node:child_process";

export const HIDDEN_LAUNCH_ENV = "AGENTLAS_HIDDEN_LAUNCH";
const RESTORE_ERAN_ENV = "AGENTLAS_HIDDEN_LAUNCH_ERAN";

/** The launcher. Reads the program from the environment (no command-line quoting), restores the program's own env. */
export const HIDDEN_LAUNCHER_SOURCE = [
  "const { spawn } = require('node:child_process');",
  `const plan = JSON.parse(process.env.${HIDDEN_LAUNCH_ENV} || 'null');`,
  `const eran = process.env.${RESTORE_ERAN_ENV};`,
  // The launcher's own environment becomes the program's: anything that spawns with process.env merged in sees the same.
  "const env = process.env;",
  `delete env.${HIDDEN_LAUNCH_ENV}; delete env.${RESTORE_ERAN_ENV};`,
  "if (eran) env.ELECTRON_RUN_AS_NODE = eran; else delete env.ELECTRON_RUN_AS_NODE;",
  "if (!plan || typeof plan.command !== 'string') process.exit(2);",
  "let child;",
  "try { child = spawn(plan.command, plan.args, { cwd: plan.cwd, env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: plan.verbatim === true }); }",
  "catch { process.exit(1); }",
  "child.on('error', () => process.exit(1));",
  "child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));",
].join("\n");

export interface SurvivingSpawnInput {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  /** This executable run as Node (Electron with ELECTRON_RUN_AS_NODE=1, or node). Default process.execPath. */
  nodeExecPath?: string;
}

export interface SurvivingSpawnPlan {
  command: string;
  args: string[];
  options: SpawnOptions;
  /** Windows only: the launcher stands between the caller and the program. */
  viaLauncher: boolean;
}

export function survivingHiddenSpawn(input: SurvivingSpawnInput): SurvivingSpawnPlan {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: input.command,
      args: [...input.args],
      options: {
        ...(input.cwd ? { cwd: input.cwd } : {}), env: input.env, stdio: input.stdio, detached: true, windowsHide: true,
        ...(input.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      viaLauncher: false,
    };
  }
  const plan = { command: input.command, args: [...input.args], cwd: input.cwd, verbatim: input.windowsVerbatimArguments === true };
  return {
    command: input.nodeExecPath ?? process.execPath,
    args: ["-e", HIDDEN_LAUNCHER_SOURCE],
    options: {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: {
        ...input.env,
        ELECTRON_RUN_AS_NODE: "1",
        [RESTORE_ERAN_ENV]: input.env.ELECTRON_RUN_AS_NODE ?? "",
        [HIDDEN_LAUNCH_ENV]: JSON.stringify(plan),
      },
      stdio: input.stdio,
      // The launcher itself: detached (no console needed, outside the parent's kill-on-close job), never a window.
      detached: true,
      windowsHide: true,
    },
    viaLauncher: true,
  };
}
