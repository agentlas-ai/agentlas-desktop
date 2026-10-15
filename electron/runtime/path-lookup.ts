import fs from "node:fs";
import path from "node:path";

/*
 * Find an executable the way the OS would, on every platform (native-harness notyet NH31, C08).
 *
 * The media and document readers split PATH on ":" and checked X_OK only. On Windows PATH is ";"-separated and drive
 * letters contain ":" (C:\Users\…), and a CLI is `grok.cmd` / `codex.exe` found through PATHEXT, so every bin read as
 * absent and the route as not installed. Explicit candidates are tried first (their order is the caller's policy),
 * then PATH with the platform delimiter and, on Windows, each PATHEXT extension. Observation only: nothing is run.
 */

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function usable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findExecutableSync(
  name: string,
  extra: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" && !path.extname(name)
    // PATHEXT first: an extensionless npm shell shim beside grok.cmd cannot be spawned on Windows.
    ? [...(envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase()), ""]
    : [""];
  const withExtensions = (base: string) => extensions.map((ext) => base + ext);
  for (const candidate of extra) {
    for (const option of platform === "win32" && !path.extname(candidate) ? withExtensions(candidate) : [candidate]) {
      if (usable(option, platform)) return option;
    }
  }
  for (const dir of (envValue(env, "PATH", platform) ?? "").split(delimiter).filter(Boolean)) {
    for (const option of withExtensions(path.join(dir.replace(/^"(.*)"$/, "$1"), name))) {
      if (usable(option, platform)) return option;
    }
  }
  return null;
}
