import { createHash } from "node:crypto";
import * as path from "node:path";
import { harvestScriptingDictionary } from "./sdef";
import type { AppCandidate, AppKind, HarvestOutcome, ReachHost } from "./types";
import type { PlatformProvider } from "./provider";

// macOS discovery: bundles in the standard application folders, read from their Info.plist, never launched.
//
// Reading an app's dictionary must not start the app either. `/usr/bin/sdef` reads a static dictionary file (Info.plist OSAScriptingDefinition)
// without starting anything, but for an app that has none it asks the app over Apple events, and that LAUNCHES it (measured on this Mac,
// 2026-10-23: TextEdit, Preview, Automator, Script Editor, OneDrive and others came up in the Dock, one second apart, every time the map was
// drawn; Notes and Numbers, which have a static file, did not). So `sdef` runs only for an app whose static dictionary file exists in its bundle.

const APP_ROOTS = (home: string): string[] => [
  "/Applications",
  "/System/Applications",
  "/System/Library/CoreServices/Applications",
  path.join(home, "Applications"),
];
// Finder is the one system app that lives outside those folders.
const EXTRA_BUNDLES = ["/System/Library/CoreServices/Finder.app"];
const MAX_FOLDER_DEPTH = 2;
const MAX_APPS = 4000;

interface PlistFacts {
  identifier?: string;
  name?: string;
  displayName?: string;
  version?: string;
  scriptable: boolean;
  scriptingDefinition?: string;
  backgroundOnly: boolean;
  agent: boolean;
}

async function readPlist(host: ReachHost, plistPath: string): Promise<PlistFacts | null> {
  const whole = await host.exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", plistPath], { timeoutMs: 5_000, maxBytes: 4 * 1024 * 1024 });
  if (whole.code === 0 && whole.stdout.trim()) {
    try {
      const data = JSON.parse(whole.stdout) as Record<string, unknown>;
      const text = (key: string): string | undefined => (typeof data[key] === "string" && (data[key] as string).trim() ? (data[key] as string).trim() : undefined);
      return {
        identifier: text("CFBundleIdentifier"),
        name: text("CFBundleName"),
        displayName: text("CFBundleDisplayName"),
        version: text("CFBundleShortVersionString") ?? text("CFBundleVersion"),
        scriptable: data.NSAppleScriptEnabled === true || data.NSAppleScriptEnabled === "YES",
        scriptingDefinition: text("OSAScriptingDefinition"),
        backgroundOnly: data.LSBackgroundOnly === true || data.LSBackgroundOnly === "1",
        agent: data.LSUIElement === true || data.LSUIElement === "1",
      };
    } catch {
      return null;
    }
  }
  // A plist that holds raw data cannot be written as JSON; read only the keys Reach needs, one at a time.
  const key = async (name: string): Promise<string | undefined> => {
    const one = await host.exec("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", "--", plistPath], { timeoutMs: 3_000, maxBytes: 64 * 1024 });
    const value = one.code === 0 ? one.stdout.trim() : "";
    return value || undefined;
  };
  const identifier = await key("CFBundleIdentifier");
  if (!identifier) return null;
  return {
    identifier,
    name: await key("CFBundleName"),
    displayName: await key("CFBundleDisplayName"),
    version: (await key("CFBundleShortVersionString")) ?? (await key("CFBundleVersion")),
    scriptable: ["true", "YES", "1"].includes((await key("NSAppleScriptEnabled")) ?? ""),
    scriptingDefinition: await key("OSAScriptingDefinition"),
    backgroundOnly: ["true", "1"].includes((await key("LSBackgroundOnly")) ?? ""),
    agent: ["true", "1"].includes((await key("LSUIElement")) ?? ""),
  };
}

async function detectKind(host: ReachHost, bundle: string): Promise<AppKind> {
  const frameworks = path.join(bundle, "Contents", "Frameworks");
  if (await host.fs.exists(path.join(frameworks, "Electron Framework.framework"))) return "electron";
  if (await host.fs.exists(path.join(frameworks, "Chromium Embedded Framework.framework"))) return "cef";
  try {
    const names = (await host.fs.readdir(frameworks)).map((entry) => entry.name);
    if (names.some((name) => name.startsWith("QtCore"))) return "qt";
  } catch { /* an app without a Frameworks folder is simply native */ }
  if ((await host.fs.exists(path.join(bundle, "Contents", "Java"))) || (await host.fs.exists(path.join(bundle, "Contents", "PlugIns", "jre")))) return "java";
  return "native";
}

async function collectBundles(host: ReachHost): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (found.length >= MAX_APPS) return;
    let entries;
    try { entries = await host.fs.readdir(folder); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.name.endsWith(".app")) {
        // A symlinked bundle is accepted (Safari lives behind one); a symlinked folder is not followed, so loops cannot form.
        if (entry.isDirectory || entry.isSymbolicLink) found.push(full);
      } else if (entry.isDirectory && !entry.isSymbolicLink && depth < MAX_FOLDER_DEPTH) {
        await walk(full, depth + 1);
      }
    }
  };
  for (const root of APP_ROOTS(host.homedir)) await walk(root, 0);
  for (const extra of EXTRA_BUNDLES) if (await host.fs.exists(extra)) found.push(extra);
  return found;
}

const runningCache = new WeakMap<object, { at: number; lines: Promise<string[]> }>();

// The executables of the processes that run now, one `ps` per scan (a scan asks about every app).
async function runningExecutables(host: ReachHost): Promise<string[]> {
  const now = host.now().getTime();
  const cached = runningCache.get(host);
  if (cached && now - cached.at < 15_000) return cached.lines;
  const lines = host.exec("/bin/ps", ["-ax", "-o", "comm="], { timeoutMs: 5_000, maxBytes: 4 * 1024 * 1024 })
    .then((result) => (result.code === 0 ? result.stdout.split("\n") : []))
    .catch(() => []);
  runningCache.set(host, { at: now, lines });
  return lines;
}

export async function isAppRunning(host: ReachHost, appPath: string): Promise<boolean> {
  let real = appPath;
  try { real = await host.fs.realpath(appPath); } catch { /* the path as listed */ }
  const prefixes = [...new Set([real, appPath])].map((bundle) => path.join(bundle, "Contents", "MacOS") + path.sep);
  return (await runningExecutables(host)).some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}

async function isRunning(host: ReachHost, app: AppCandidate): Promise<boolean> {
  return isAppRunning(host, app.path);
}

// The app names a dictionary file in its own bundle (OSAScriptingDefinition) and that file is there.
async function hasStaticDictionary(host: ReachHost, app: AppCandidate): Promise<boolean> {
  const signal = app.signals.find((item) => item.startsWith("scripting-definition:"));
  const name = signal?.slice("scripting-definition:".length).trim();
  if (!name || name.includes("/") || name.includes("..")) return false;
  const resources = path.join(app.path, "Contents", "Resources");
  return (await host.fs.exists(path.join(resources, name))) || (await host.fs.exists(path.join(resources, `${name}.sdef`)));
}

export const macosProvider: PlatformProvider = {
  platform: "darwin",

  installDirectories: (host) => [...APP_ROOTS(host.homedir), "/Applications/Utilities"],

  async discover(host: ReachHost): Promise<AppCandidate[]> {
    const bundles = await collectBundles(host);
    const seenReal = new Set<string>();
    const seenKeys = new Map<string, number>();
    const candidates: AppCandidate[] = [];
    for (const bundle of bundles) {
      let real: string;
      try { real = await host.fs.realpath(bundle); } catch { continue; }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      const plistPath = path.join(real, "Contents", "Info.plist");
      const facts = await readPlist(host, plistPath);
      if (!facts) continue;
      const name = facts.displayName ?? facts.name ?? path.basename(bundle, ".app");
      const baseKey = facts.identifier ? `bundle:${facts.identifier}` : `path:${real}`;
      const duplicates = seenKeys.get(baseKey) ?? 0;
      seenKeys.set(baseKey, duplicates + 1);
      const key = duplicates === 0 ? baseKey : `${baseKey}@${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
      const kind = await detectKind(host, real);
      const signals: string[] = [];
      if (facts.scriptable) signals.push("scripting-enabled");
      if (facts.scriptingDefinition) signals.push(`scripting-definition:${facts.scriptingDefinition}`);
      if (kind !== "native") signals.push(kind);
      if (facts.backgroundOnly) signals.push("background-only");
      if (facts.agent) signals.push("agent-app");
      if (duplicates > 0) signals.push("duplicate-bundle-id");
      const mtime = await host.fs.mtimeMs(plistPath);
      candidates.push({
        key,
        platform: "darwin",
        name,
        ...(facts.version ? { version: facts.version } : {}),
        path: bundle,
        kind,
        signals,
        fingerprint: createHash("sha1").update(`${facts.version ?? ""}|${mtime ?? 0}|${real}`).digest("hex").slice(0, 16),
      });
    }
    return candidates.sort((a, b) => a.name.localeCompare(b.name));
  },

  async harvest(host: ReachHost, app: AppCandidate): Promise<HarvestOutcome[]> {
    if (await hasStaticDictionary(host, app)) return [await harvestScriptingDictionary(host, app.path, app.key)];
    const scriptable = app.signals.includes("scripting-enabled");
    // An app that answers over Apple events is asked only while it is already running (asking an app that is not running starts it). A scan made
    // while the owner has the app open reads it; the map keeps what was read (map.ts `previous`) and the service draws the map again when such an
    // app comes up (reach-main.ts dictionaryWaiting), so the apps the owner uses join the map without any of them being started.
    if (scriptable && (await isRunning(host, app))) {
      const outcome = await harvestScriptingDictionary(host, app.path, app.key);
      return [{ ...outcome, record: { ...outcome.record, detail: `${outcome.record.detail ?? ""}${outcome.record.detail ? "; " : ""}read while the app was running` } }];
    }
    return [{
      record: { source: "sdef", tier: "published", status: "unavailable", count: 0, ms: 0, ...(scriptable ? { deferred: true } : {}),
        detail: scriptable ? "its dictionary can only be read while the app is running (asking an app that is not running starts it), so it was not read" : "the app publishes no scripting dictionary" },
      capabilities: [],
    }];
  },
};
