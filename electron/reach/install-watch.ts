import { createHash } from "node:crypto";
import type { PlatformProvider } from "./provider";
import type { ReachHost } from "./types";

// Notices that an app was installed or removed without running discovery: the names of the entries in the folders where apps land, hashed.
// A new app is a new name, a removed one a missing name; a file that is rewritten in place (Finder's .DS_Store, an app updating itself)
// changes nothing, so the signature moves only when the set of apps moved. Reading is cheap (a handful of directory listings), which is why
// the service can look at it on every tick instead of waiting for the daily refresh.

export async function installSignature(host: ReachHost, providers: readonly PlatformProvider[]): Promise<string> {
  const directories = [...new Set(providers.filter((provider) => provider.platform === host.platform).flatMap((provider) => provider.installDirectories?.(host) ?? []))].sort();
  const lines: string[] = [];
  for (const directory of directories) {
    let names: string[];
    try { names = (await host.fs.readdir(directory)).map((entry) => entry.name).filter((name) => !name.startsWith(".")).sort(); }
    catch { names = ["<unreadable>"]; }
    lines.push(`${directory}\n${names.join("\n")}`);
  }
  return createHash("sha256").update(lines.join("\n--\n")).digest("hex").slice(0, 16);
}
