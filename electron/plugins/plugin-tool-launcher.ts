import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifiedPinnedPluginRelease } from "./materialize";

type LaunchInput = {
  root: string;
  digest: string;
  entry: string;
  args: string[];
};

function parseLaunch(argv: string[]): LaunchInput {
  if (argv.length < 7 || argv[0] !== "--plugin-root" || argv[2] !== "--release-digest" || argv[4] !== "--entry") {
    throw new Error("plugin_tool_launch_contract_invalid");
  }
  const separator = argv.indexOf("--", 6);
  if (separator < 0) throw new Error("plugin_tool_launch_contract_invalid");
  return {
    root: path.resolve(argv[1]),
    digest: argv[3],
    entry: path.resolve(argv[5]),
    args: argv.slice(separator + 1),
  };
}

function assertContainedFile(root: string, target: string): void {
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("plugin_tool_entry_outside_release");
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("plugin_tool_entry_invalid");
}

async function main(): Promise<void> {
  const input = parseLaunch(process.argv.slice(2));
  const release = verifiedPinnedPluginRelease(input.root, input.digest);
  if (!release) throw new Error("plugin_tool_release_changed");
  assertContainedFile(release.directory, input.entry);

  const child = spawn(process.execPath, [input.entry, ...input.args], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch { /* child exit wins */ }
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      try { process.kill(process.pid, signal); } catch { process.exitCode = 1; }
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
