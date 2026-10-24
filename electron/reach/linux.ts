import { createHash } from "node:crypto";
import * as path from "node:path";
import type { PlatformProvider } from "./provider";
import type { AppCandidate, Capability, HarvestOutcome, ReachHost } from "./types";

// Linux discovery: XDG desktop entries. They are the one list every desktop environment, launcher and sandbox format agrees on,
// and they already carry the first published capabilities of an app: its desktop actions and the file types it opens.

const MAX_DESKTOP_FILE_BYTES = 256 * 1024;
const MAX_FILES = 6000;

export interface DesktopGroup {
  name: string;
  entries: Record<string, string>;
}

// Desktop Entry Specification: "[Group]" headers, "Key=Value" lines, "Key[locale]=Value" translations, "#" comments.
// Reach keeps the unlocalized key so a map does not change when the user changes language.
export function parseDesktopEntry(source: string): DesktopGroup[] {
  const groups: DesktopGroup[] = [];
  let current: DesktopGroup | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = { name: header[1], entries: {} };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes("[")) continue;
    if (key in current.entries) continue;
    current.entries[key] = unescapeValue(line.slice(eq + 1).trim());
  }
  return groups;
}

function unescapeValue(value: string): string {
  return value.replace(/\\(s|n|t|r|;|\\)/g, (_all, ch: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", ";": ";", "\\": "\\" })[ch] as string);
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  const items: string[] = [];
  let buffer = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\" && value[i + 1] === ";") {
      buffer += ";";
      i += 1;
    } else if (ch === ";") {
      if (buffer) items.push(buffer);
      buffer = "";
    } else buffer += ch;
  }
  if (buffer) items.push(buffer);
  return items;
}

export function dataDirectories(host: ReachHost): string[] {
  const home = host.homedir;
  const dataHome = host.env.XDG_DATA_HOME && path.isAbsolute(host.env.XDG_DATA_HOME) ? host.env.XDG_DATA_HOME : path.join(home, ".local", "share");
  const systemDirs = (host.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter((dir) => path.isAbsolute(dir));
  const flatpak = [path.join(home, ".local", "share", "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share"];
  const snap = ["/var/lib/snapd/desktop"];
  const ordered = [dataHome, ...systemDirs, ...flatpak, ...snap];
  return [...new Set(ordered)];
}

async function walkDesktopFiles(host: ReachHost, applications: string): Promise<Array<{ id: string; file: string }>> {
  const found: Array<{ id: string; file: string }> = [];
  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await host.fs.readdir(folder); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink && depth < 3) await walk(full, `${prefix}${entry.name}-`, depth + 1);
      else if (entry.name.endsWith(".desktop") && (entry.isFile || entry.isSymbolicLink)) found.push({ id: `${prefix}${entry.name.slice(0, -8)}`, file: full });
    }
  };
  await walk(applications, "", 0);
  return found;
}

function describeOrigin(file: string, exec: string, entries: Record<string, string>): string[] {
  const signals: string[] = [];
  if (entries["X-Flatpak"] || file.includes("/flatpak/exports/") || /^flatpak\s+run\b/.test(exec)) signals.push("flatpak");
  if (file.startsWith("/var/lib/snapd/") || file.includes("/snap/") || entries["X-SnapInstanceName"]) signals.push("snap");
  if (/\.AppImage\b/i.test(exec) || entries["X-AppImage-Version"]) signals.push("appimage");
  if (entries.DBusActivatable === "true") signals.push("dbus-activatable");
  return signals;
}

export const linuxProvider: PlatformProvider = {
  platform: "linux",

  installDirectories: (host) => dataDirectories(host).map((dataDir) => path.join(dataDir, "applications")),

  async discover(host: ReachHost): Promise<AppCandidate[]> {
    const byId = new Map<string, AppCandidate>();
    let files = 0;
    for (const dataDir of dataDirectories(host)) {
      for (const { id, file } of await walkDesktopFiles(host, path.join(dataDir, "applications"))) {
        if (byId.has(id)) continue; // an earlier directory overrides a later one, as the specification says
        files += 1;
        if (files > MAX_FILES) break;
        let source: string;
        try { source = await host.fs.readFile(file, MAX_DESKTOP_FILE_BYTES); } catch { continue; }
        const groups = parseDesktopEntry(source);
        const main = groups.find((group) => group.name === "Desktop Entry");
        if (!main) continue;
        const entries = main.entries;
        if (entries.Type !== "Application" || entries.Hidden === "true" || entries.NoDisplay === "true" || !entries.Name || !entries.Exec) continue;
        const actions = splitList(entries.Actions);
        const signals = describeOrigin(file, entries.Exec, entries);
        if (actions.length > 0) signals.push(`desktop-actions:${actions.length}`);
        if (splitList(entries.MimeType).length > 0) signals.push(`mime-types:${splitList(entries.MimeType).length}`);
        if (entries.Terminal === "true") signals.push("terminal-app");
        const mtime = await host.fs.mtimeMs(file);
        byId.set(id, {
          key: `desktop:${id}`,
          platform: "linux",
          name: entries.Name,
          path: file,
          kind: "unknown",
          signals,
          fingerprint: createHash("sha1").update(`${mtime ?? 0}|${entries.Exec}|${entries.Actions ?? ""}`).digest("hex").slice(0, 16),
        });
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  },

  async harvest(host: ReachHost, app: AppCandidate): Promise<HarvestOutcome[]> {
    const started = Date.now();
    let source: string;
    try { source = await host.fs.readFile(app.path, MAX_DESKTOP_FILE_BYTES); } catch {
      return [{ record: { source: "desktop-entry", tier: "published", status: "failed", count: 0, ms: Date.now() - started, detail: "desktop file unreadable" }, capabilities: [] }];
    }
    const groups = parseDesktopEntry(source);
    const entries = groups.find((group) => group.name === "Desktop Entry")?.entries ?? {};
    const capabilities: Capability[] = [];
    for (const id of splitList(entries.Actions)) {
      const group = groups.find((item) => item.name === `Desktop Action ${id}`);
      if (!group?.entries.Name) continue;
      capabilities.push({
        id: `${app.key}#published:desktop-action/${id}`,
        tier: "published",
        source: { kind: "desktop-action", ref: id },
        name: group.entries.Name,
        suite: "Desktop Actions",
        kind: "command",
        granularity: "operation",
        parameters: [],
        effect: { class: "unknown", basis: "unverified" },
      });
    }
    for (const mime of splitList(entries.MimeType)) {
      capabilities.push({
        id: `${app.key}#published:mime/${mime}`,
        tier: "published",
        source: { kind: "mime-type", ref: mime },
        name: `open ${mime}`,
        suite: "MimeType",
        kind: "command",
        granularity: "operation",
        // Every viewer lists file types; that says which files route to the app, not what the app can do with them.
        generic: true,
        parameters: [{ name: "file", type: "path", required: true }],
        // Opening a file in a viewer changes nothing in the file; the handler decides the rest.
        effect: { class: "unknown", basis: "unverified" },
      });
    }
    return [{
      record: {
        source: "desktop-entry",
        tier: "published",
        status: capabilities.length > 0 ? "ok" : "empty",
        count: capabilities.length,
        ms: Date.now() - started,
        detail: `${splitList(entries.Actions).length} desktop actions, ${splitList(entries.MimeType).length} file types`,
      },
      capabilities,
    }];
  },
};
