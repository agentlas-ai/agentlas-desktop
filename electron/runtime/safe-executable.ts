// The one place that turns a bare command name (`python`, `npx`, `node`) into the absolute file a child process runs.
//
// Why: on Windows, libuv (child_process.spawn), cmd.exe and cross-spawn's `which` all look in the CHILD'S working
// folder before PATH. Desktop starts CLIs, the engine's Python and MCP servers with the user's project folder (or a
// chat workspace) as that folder, so a `python.exe` / `node.exe` / `npx.cmd` placed in a cloned project ran instead of
// the real one (verified on Windows 11 ARM64, Node 22; evidence docs/Agentlas2.0/evidence/desktop-exe-resolution/).
// macOS and Linux only have the problem when PATH carries a relative entry (`.`, an empty entry, `node_modules/.bin`),
// which resolves against that same folder.
//
// Rules (pure; the platform is a parameter so the Windows rules run in a macOS gate):
//  - A command with a path separator (or a drive prefix) is explicit and is returned unchanged: an absolute path is the
//    user's choice, `./tool` keeps meaning "relative to the working folder" exactly as before.
//  - A bare name is looked up ONLY in the absolute entries of PATH, in PATH order. The working folder, empty entries
//    and relative entries are never searched. Windows tries PATHEXT order restricted to what CreateProcess can start
//    (.com .exe .bat .cmd); an extensionless file is never a Windows program.
//  - A name that is not found is NOT left bare: the caller gets a path that cannot exist, so the start fails with the
//    same ENOENT as before instead of falling back to the working folder.
import fs from "node:fs";
import path from "node:path";

export type PathPlatform = NodeJS.Platform;

export type CommandResolution =
  | { kind: "explicit"; command: string }
  | { kind: "resolved"; command: string }
  | { kind: "missing"; command: string };

const WINDOWS_STARTABLE = [".com", ".exe", ".bat", ".cmd"];

function pathApi(platform: PathPlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function envValueIgnoringCase(env: NodeJS.ProcessEnv, name: string, platform: PathPlatform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).filter((candidate) => candidate.toUpperCase() === name.toUpperCase()).sort()[0];
  return key ? env[key] : undefined;
}

/** A PATH entry that means one fixed folder: a drive path or UNC path on Windows, a `/` path elsewhere. */
export function isAbsolutePathEntry(entry: string, platform: PathPlatform): boolean {
  const value = platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
  if (!value) return false;
  return platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(value) : value.startsWith("/");
}

/** PATH with every empty and relative entry removed (they resolve against the child's working folder). */
export function absolutePathValue(value: string | undefined, platform: PathPlatform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  return (value ?? "").split(delimiter).filter((entry) => isAbsolutePathEntry(entry, platform)).join(delimiter);
}

export function isBareCommandName(command: string, platform: PathPlatform): boolean {
  if (!command) return false;
  if (/[\\/]/.test(command) && (platform === "win32" || command.includes("/"))) return false;
  if (platform === "win32" && /^[A-Za-z]:/.test(command)) return false;
  return true;
}

function usableFile(candidate: string, platform: PathPlatform): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    if (platform !== "win32") return false;
    // App-execution aliases (WindowsApps\python.exe) are reparse points Node's stat can refuse; the name exists.
    try { return !fs.lstatSync(candidate).isDirectory(); } catch { return false; }
  }
}

export function resolveBareCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: PathPlatform = process.platform,
  isFile: (candidate: string) => boolean = (candidate) => usableFile(candidate, platform),
): CommandResolution {
  if (!isBareCommandName(command, platform)) return { kind: "explicit", command };
  const api = pathApi(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  let names: string[] = [command];
  if (platform === "win32") {
    const configured = (envValueIgnoringCase(env, "PATHEXT", platform) ?? "")
      .split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
    const order = (configured.length ? configured : WINDOWS_STARTABLE).filter((ext) => WINDOWS_STARTABLE.includes(ext));
    const exts = order.length ? order : WINDOWS_STARTABLE;
    names = WINDOWS_STARTABLE.some((ext) => command.toLowerCase().endsWith(ext)) ? [command] : exts.map((ext) => command + ext);
  }
  for (const raw of (envValueIgnoringCase(env, "PATH", platform) ?? "").split(delimiter)) {
    if (!isAbsolutePathEntry(raw, platform)) continue;
    const dir = platform === "win32" ? raw.replace(/^"(.*)"$/, "$1") : raw;
    for (const name of names) {
      const candidate = api.join(dir, name);
      if (isFile(candidate)) return { kind: "resolved", command: candidate };
    }
  }
  return { kind: "missing", command };
}

/** An absolute path that cannot exist, so a start that must fail fails with ENOENT and never searches the working folder. */
export function commandNotFoundPath(command: string, platform: PathPlatform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const root = envValueIgnoringCase(env, "SystemRoot", platform) ?? "C:\\Windows";
    return path.win32.join(root, "agentlas-command-not-found", command);
  }
  return path.posix.join("/agentlas-command-not-found", command);
}

/** What to hand to the OS: the explicit command, the absolute file a bare name resolves to, or the never-exists path. */
export function commandForSpawn(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: PathPlatform = process.platform,
  isFile?: (candidate: string) => boolean,
): string {
  const resolution = resolveBareCommand(command, env, platform, isFile);
  return resolution.kind === "missing" ? commandNotFoundPath(command, platform, env) : resolution.command;
}

/**
 * cmd.exe searches ".;%PATH%" unless NoDefaultCurrentDirectoryInExePath exists (its presence, not its value, is read):
 * https://learn.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-needcurrentdirectoryforexepathw
 * Set only for children that cmd.exe itself starts.
 */
export function withNoCurrentDirectoryExeSearch(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const base = env ?? process.env;
  if (Object.keys(base).some((key) => key.toUpperCase() === "NODEFAULTCURRENTDIRECTORYINEXEPATH")) return base;
  return { ...base, NoDefaultCurrentDirectoryInExePath: "1" };
}
