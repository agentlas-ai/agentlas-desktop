import type fs from "node:fs";
import type path from "node:path";

/** Also embedded in the standalone launcher; keep this function self-contained. */
export function assertDedicatedBrowserProfilePath(profile: string, context: {
  platform: NodeJS.Platform;
  home: string;
  env: Partial<Pick<NodeJS.ProcessEnv, "LOCALAPPDATA" | "XDG_CONFIG_HOME">>;
  fs: typeof fs;
  path: typeof path;
}, targets: readonly string[] = []): void {
  const { platform, home, env, fs, path } = context;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const refuse = (): never => {
    const error = new Error("browser-profile-personal-path-refused");
    Object.assign(error, { code: "browser-profile-personal-path-refused" });
    throw error;
  };
  const normalized = (value: string) => {
    const resolved = paths.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  // Resolve existing ancestors too: a missing child below a symlink/junction
  // must be checked before mkdir creates it in the everyday browser profile.
  const canonical = (value: string): string => {
    let ancestor = paths.resolve(value);
    const missing: string[] = [];
    for (;;) {
      try { return normalized(paths.join(fs.realpathSync(ancestor), ...missing)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) return refuse(); }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
        }
        const parent = paths.dirname(ancestor);
        if (parent === ancestor) return refuse();
        missing.unshift(paths.basename(ancestor));
        ancestor = parent;
      }
    }
  };
  const base = platform === "darwin" ? paths.join(home, "Library", "Application Support")
    : platform === "win32" ? env.LOCALAPPDATA || paths.join(home, "AppData", "Local")
      : env.XDG_CONFIG_HOME || paths.join(home, ".config");
  const names = platform === "darwin"
    ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"]
    : platform === "win32"
      ? ["Google/Chrome/User Data", "Google/Chrome Beta/User Data", "Google/Chrome SxS/User Data", "Chromium/User Data", "Microsoft/Edge/User Data", "BraveSoftware/Brave-Browser/User Data"]
      : ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"];
  const requested = normalized(profile);
  const inside = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + paths.sep);
  const roots = names.map((name) => paths.join(base, ...name.split("/")));
  if (roots.some((root) => inside(requested, normalized(root)))) refuse();
  const resolved = canonical(profile);
  if (roots.some((root) => inside(resolved, canonical(root)))) refuse();
  const assertInside = (target: string) => {
    if (!inside(normalized(target), requested) || !inside(canonical(target), resolved)) refuse();
    // realpath cannot distinguish a hard-linked state file from a private file.
    // Refuse shared regular-file inodes without opening their contents.
    try {
      const state = fs.statSync(target);
      if (state.isFile() && state.nlink > 1) refuse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse();
    }
  };
  // Chrome's process singleton links intentionally point outside its profile.
  // State paths do not: a safe user-data root can still contain Default,
  // Network, Preferences or SQLite sidecars aliased to another profile.
  const profileNames = new Set(["Default", "Guest Profile", "System Profile"]);
  try {
    for (const name of fs.readdirSync(profile)) {
      if (/^Profile \d+$/.test(name)) profileNames.add(name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse();
  }
  const statePaths = [
    "Local State", "DevToolsActivePort", ".agentlas-cdp-owner.json", ".agentlas-cdp-backoff.json",
    ".agentlas-cdp-leases", ".agentlas-cdp-shutdown-lock", ".agentlas-cdp-launch-lock",
    ".agentlas-cdp-shutdown-lock/owner.json", ".agentlas-cdp-launch-lock/owner.json",
  ];
  for (const name of profileNames) {
    statePaths.push(name);
    for (const relative of [
      "Network", "Preferences", "Secure Preferences", "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs",
      "Local Storage", "Session Storage", "IndexedDB", "Service Worker", "Storage",
    ]) statePaths.push(`${name}/${relative}`);
    for (const store of ["Cookies", "Network/Cookies", "Login Data", "Login Data For Account", "Web Data"]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) statePaths.push(`${name}/${store}${suffix}`);
    }
  }
  for (const relative of statePaths) assertInside(paths.join(profile, ...relative.split("/")));
  for (const target of targets) assertInside(target);
}
