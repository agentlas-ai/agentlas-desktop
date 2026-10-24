import { createHash } from "node:crypto";
import * as path from "node:path";
import { childrenNamed, parseXml, type XmlElement } from "./mini-xml";
import type { PlatformProvider } from "./provider";
import type { AppCandidate, Capability, CapabilityParameter, HarvestOutcome, ReachHost } from "./types";

// Windows discovery. One read-only PowerShell run lists three sources that each miss apps the others catch:
//   Uninstall registry keys  classic Win32 and per-user installs (not portable apps)
//   Get-StartApps            everything with a Start menu entry, with its AppUserModelID
//   Get-AppxPackage          Store and MSIX apps, with the package manifest
// The published capabilities Windows can state without launching anything live in the AppX manifest: URI protocols, execution
// aliases, and "Actions on Windows" providers (registration.json). All parsing is pure so it is tested against fixtures in the
// formats Microsoft documents; the PowerShell run is the only part that needs a real Windows machine.
//
// Paths here are Windows paths on any host: path.win32 is used explicitly.

const win = path.win32;
const MAX_REGISTRATION_BYTES = 512 * 1024;
const POWERSHELL_TIMEOUT_MS = 90_000;
const POWERSHELL_MAX_BYTES = 64 * 1024 * 1024;

// A constant script: nothing from the machine or from a model is ever interpolated into it. It reads, never writes.
export const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$uninstall = foreach ($key in $keys) {
  $hive = $key.Substring(0, 4)
  Get-ItemProperty -Path $key | Where-Object { $_.DisplayName } | ForEach-Object {
    [pscustomobject]@{
      Id = $_.PSChildName; Hive = $hive; DisplayName = [string]$_.DisplayName; DisplayVersion = [string]$_.DisplayVersion
      Publisher = [string]$_.Publisher; InstallLocation = [string]$_.InstallLocation; DisplayIcon = [string]$_.DisplayIcon
      SystemComponent = $_.SystemComponent; ParentKeyName = [string]$_.ParentKeyName; WindowsInstaller = $_.WindowsInstaller
    }
  }
}
$start = Get-StartApps | ForEach-Object { [pscustomobject]@{ Name = [string]$_.Name; AppID = [string]$_.AppID } }
$appx = Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage } | ForEach-Object {
  $manifest = $null
  try { $manifest = (Get-AppxPackageManifest -Package $_.PackageFullName).OuterXml } catch {}
  [pscustomobject]@{
    Name = [string]$_.Name; PackageFamilyName = [string]$_.PackageFamilyName; PackageFullName = [string]$_.PackageFullName
    Version = [string]$_.Version; Publisher = [string]$_.Publisher; InstallLocation = [string]$_.InstallLocation
    SignatureKind = [string]$_.SignatureKind; Manifest = $manifest
  }
}
[pscustomobject]@{ uninstall = @($uninstall); startApps = @($start); appx = @($appx) } | ConvertTo-Json -Depth 4 -Compress
`;

export interface UninstallEntry {
  Id: string;
  Hive?: string;
  DisplayName: string;
  DisplayVersion?: string;
  Publisher?: string;
  InstallLocation?: string;
  DisplayIcon?: string;
  SystemComponent?: number | boolean | null;
  ParentKeyName?: string;
}
export interface StartApp { Name: string; AppID: string }
export interface AppxEntry {
  Name: string;
  PackageFamilyName: string;
  PackageFullName?: string;
  Version?: string;
  Publisher?: string;
  InstallLocation?: string;
  SignatureKind?: string;
  Manifest?: string | null;
}
export interface WindowsInventory { uninstall: UninstallEntry[]; startApps: StartApp[]; appx: AppxEntry[] }

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

// ConvertTo-Json writes a one-element collection as a bare object in some PowerShell versions, and an empty one as null.
export function parseInventory(stdout: string): WindowsInventory {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  const data = JSON.parse(text) as Record<string, unknown>;
  return {
    uninstall: asArray<UninstallEntry>(data.uninstall).filter((item) => typeof item?.DisplayName === "string"),
    startApps: asArray<StartApp>(data.startApps).filter((item) => typeof item?.AppID === "string"),
    appx: asArray<AppxEntry>(data.appx).filter((item) => typeof item?.PackageFamilyName === "string"),
  };
}

const UPDATE_NAME = /^(security update|update|hotfix|service pack)\b.*\bfor\b|^KB\d{6,}\b/i;

function truthy(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function walk(element: XmlElement, visit: (node: XmlElement, parents: XmlElement[]) => void, parents: XmlElement[] = []): void {
  visit(element, parents);
  for (const child of element.children) walk(child, visit, [...parents, element]);
}

export interface ManifestFacts {
  applications: Array<{ id: string; executable?: string; entryPoint?: string }>;
  protocols: string[];
  executionAliases: string[];
  appExtensions: Array<{ name: string; id?: string; publicFolder?: string; registration?: string }>;
  displayName?: string;
}

export function parseAppxManifest(xml: string): ManifestFacts {
  const root = parseXml(xml);
  const facts: ManifestFacts = { applications: [], protocols: [], executionAliases: [], appExtensions: [] };
  walk(root, (node) => {
    const name = localName(node.name);
    if (name === "Application" && node.attrs.Id) {
      facts.applications.push({ id: node.attrs.Id, ...(node.attrs.Executable ? { executable: node.attrs.Executable } : {}), ...(node.attrs.EntryPoint ? { entryPoint: node.attrs.EntryPoint } : {}) });
    } else if (name === "Protocol" && node.attrs.Name) {
      facts.protocols.push(node.attrs.Name);
    } else if (name === "ExecutionAlias" && node.attrs.Alias) {
      facts.executionAliases.push(node.attrs.Alias);
    } else if (name === "AppExtension" && node.attrs.Name) {
      const properties = node.children.find((child) => localName(child.name) === "Properties");
      const registration = properties?.children.find((child) => localName(child.name) === "Registration")?.text;
      facts.appExtensions.push({
        name: node.attrs.Name,
        ...(node.attrs.Id ? { id: node.attrs.Id } : {}),
        ...(node.attrs.PublicFolder ? { publicFolder: node.attrs.PublicFolder } : {}),
        ...(registration ? { registration } : {}),
      });
    } else if (name === "VisualElements" && node.attrs.DisplayName && !facts.displayName && !node.attrs.DisplayName.startsWith("ms-resource:")) {
      facts.displayName = node.attrs.DisplayName;
    }
  });
  return facts;
}

const ACTION_KIND_TYPE: Record<string, string> = {
  Text: "string", StreamingText: "string", Document: "path", File: "path", Photo: "path", RemoteFile: "path", Contact: "object", Table: "object",
};

interface ActionsRegistration {
  actions?: Array<{
    id?: string;
    description?: string;
    usesGenerativeAI?: boolean;
    inputs?: Array<{ name?: string; kind?: string }>;
    inputCombinations?: Array<{ inputs?: string[] }>;
    outputs?: Array<{ name?: string; kind?: string }>;
    invocation?: { type?: string };
  }>;
}

// registration.json of an "Actions on Windows" provider (Microsoft Learn, app-actions/actions-json).
export function parseActionsRegistration(json: string, appKey: string): Capability[] {
  const data = JSON.parse(json.replace(/^\uFEFF/, "")) as ActionsRegistration;
  const capabilities: Capability[] = [];
  for (const action of Array.isArray(data.actions) ? data.actions : []) {
    if (!action.id) continue;
    const combinations = (action.inputCombinations ?? []).map((combo) => combo.inputs ?? []);
    const parameters: CapabilityParameter[] = (action.inputs ?? []).filter((input) => input.name).map((input) => ({
      name: input.name as string,
      type: ACTION_KIND_TYPE[input.kind ?? ""] ?? "any",
      // An input is required when every allowed combination uses it; with no combinations declared, all inputs are required.
      required: combinations.length === 0 ? true : combinations.every((combo) => combo.includes(input.name as string)),
    }));
    const outputs = (action.outputs ?? []).map((output) => `${output.name ?? "output"}:${ACTION_KIND_TYPE[output.kind ?? ""] ?? "any"}`);
    capabilities.push({
      id: `${appKey}#published:windows-app-action/${action.id}`,
      tier: "published",
      source: { kind: "windows-app-action", ref: `${action.id}${action.invocation?.type ? `:${action.invocation.type}` : ""}` },
      name: action.id.split(".").pop() ?? action.id,
      suite: "Actions on Windows",
      ...(action.description ? { description: action.description } : {}),
      kind: "command",
      granularity: "operation",
      parameters,
      ...(outputs.length > 0 ? { result: outputs.join(",") } : {}),
      effect: { class: "unknown", basis: "unverified" },
    });
  }
  return capabilities;
}

interface InventoryCache { appx: Map<string, AppxEntry & { appKey: string }> }
const CACHE = new WeakMap<ReachHost, InventoryCache>();

function normalize(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function candidatesFromInventory(host: ReachHost, inventory: WindowsInventory): Promise<{ candidates: AppCandidate[]; appx: Map<string, AppxEntry & { appKey: string }> }> {
  const candidates: AppCandidate[] = [];
  const appxByKey = new Map<string, AppxEntry & { appKey: string }>();
  const startByName = new Map<string, StartApp>();
  const usedStart = new Set<string>();
  for (const start of inventory.startApps) startByName.set(normalize(start.Name), start);

  for (const entry of inventory.appx) {
    let facts: ManifestFacts | null = null;
    if (entry.Manifest) {
      try { facts = parseAppxManifest(entry.Manifest); } catch { facts = null; }
    }
    if (facts && facts.applications.length === 0) continue; // a package with no app in it is a runtime, not something to operate
    const key = `appx:${entry.PackageFamilyName}`;
    const start = inventory.startApps.find((item) => item.AppID.startsWith(`${entry.PackageFamilyName}!`));
    if (start) usedStart.add(start.AppID);
    const signals = ["appx"];
    if (start) signals.push("start-menu");
    if (entry.SignatureKind === "Store") signals.push("store-signed");
    if (facts && facts.protocols.length > 0) signals.push(`protocols:${facts.protocols.length}`);
    if (facts && facts.appExtensions.some((ext) => ext.name === "com.microsoft.windows.ai.actions")) signals.push("windows-app-actions");
    if (facts && facts.appExtensions.some((ext) => ext.name === "com.microsoft.windows.ai.mcpServer")) signals.push("windows-mcp-server");
    if (facts && facts.appExtensions.some((ext) => ext.name === "com.microsoft.windows.ai.agentInfo")) signals.push("windows-agent");
    const location = entry.InstallLocation ?? "";
    const electron = location ? await host.fs.exists(win.join(location, "resources", "app.asar")) : false;
    if (electron) signals.push("electron");
    candidates.push({
      key,
      platform: "win32",
      name: start?.Name || facts?.displayName || entry.Name,
      ...(entry.Version ? { version: entry.Version } : {}),
      path: location,
      kind: electron ? "electron" : "unknown",
      signals,
      fingerprint: createHash("sha1").update(`${entry.Version ?? ""}|${entry.Publisher ?? ""}|${location}|${entry.Manifest ? createHash("sha1").update(entry.Manifest).digest("hex") : ""}`).digest("hex").slice(0, 16),
    });
    appxByKey.set(key, { ...entry, appKey: key });
  }

  const seenUninstall = new Set<string>();
  for (const entry of inventory.uninstall) {
    if (truthy(entry.SystemComponent) || entry.ParentKeyName || UPDATE_NAME.test(entry.DisplayName)) continue;
    if (seenUninstall.has(entry.Id)) continue;
    seenUninstall.add(entry.Id);
    const start = startByName.get(normalize(entry.DisplayName));
    if (start) usedStart.add(start.AppID);
    const signals = ["uninstall-entry"];
    if (start) signals.push("start-menu");
    if (entry.Hive === "HKCU") signals.push("per-user-install");
    const location = entry.InstallLocation ?? "";
    const electron = location ? await host.fs.exists(win.join(location, "resources", "app.asar")) : false;
    if (electron) signals.push("electron");
    candidates.push({
      key: `uninstall:${entry.Id}`,
      platform: "win32",
      name: entry.DisplayName,
      ...(entry.DisplayVersion ? { version: entry.DisplayVersion } : {}),
      path: location,
      kind: electron ? "electron" : "unknown",
      signals,
      fingerprint: createHash("sha1").update(`${entry.DisplayVersion ?? ""}|${entry.Publisher ?? ""}|${location}`).digest("hex").slice(0, 16),
    });
  }

  // An app that has a Start entry and neither of the other two records (a portable app, a shortcut to a tool).
  const claimed = new Set(candidates.map((candidate) => normalize(candidate.name)));
  for (const start of inventory.startApps) {
    if (usedStart.has(start.AppID) || claimed.has(normalize(start.Name)) || !start.Name) continue;
    claimed.add(normalize(start.Name));
    candidates.push({
      key: `aumid:${start.AppID}`,
      platform: "win32",
      name: start.Name,
      path: "",
      kind: "unknown",
      signals: ["start-menu-only"],
      fingerprint: createHash("sha1").update(start.AppID).digest("hex").slice(0, 16),
    });
  }
  return { candidates: candidates.sort((a, b) => a.name.localeCompare(b.name)), appx: appxByKey };
}

function powershellPath(host: ReachHost): string {
  return win.join(host.env.SystemRoot || host.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

// Where an installer puts a program or its Start menu entry; a new app is a new entry in one of these.
export function windowsInstallDirectories(host: ReachHost): string[] {
  const env = host.env;
  const pick = (value: string | undefined, ...rest: string[]): string[] => (value ? [win.join(value, ...rest)] : []);
  return [
    ...pick(env.ProgramFiles), ...pick(env["ProgramFiles(x86)"]),
    ...pick(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"), ...pick(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    ...pick(env.LOCALAPPDATA, "Programs"), ...pick(env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
  ];
}

export const windowsProvider: PlatformProvider = {
  platform: "win32",

  installDirectories: windowsInstallDirectories,

  async discover(host: ReachHost): Promise<AppCandidate[]> {
    const result = await host.exec(
      powershellPath(host),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(INVENTORY_SCRIPT)],
      { timeoutMs: POWERSHELL_TIMEOUT_MS, maxBytes: POWERSHELL_MAX_BYTES },
    );
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`reach_windows_inventory_failed:${result.timedOut ? "timeout" : result.truncated ? "too-large" : `exit-${result.code}`}`);
    const { candidates, appx } = await candidatesFromInventory(host, parseInventory(result.stdout));
    CACHE.set(host, { appx });
    return candidates;
  },

  async harvest(host: ReachHost, app: AppCandidate): Promise<HarvestOutcome[]> {
    const entry = CACHE.get(host)?.appx.get(app.key);
    if (!entry?.Manifest) return []; // Win32 apps: COM type libraries and UI Automation come with later sources
    const started = Date.now();
    const capabilities: Capability[] = [];
    let facts: ManifestFacts;
    try { facts = parseAppxManifest(entry.Manifest); } catch {
      return [{ record: { source: "appx-manifest", tier: "published", status: "failed", count: 0, ms: Date.now() - started, detail: "manifest could not be read" }, capabilities: [] }];
    }
    for (const protocol of facts.protocols) {
      capabilities.push({
        id: `${app.key}#published:uri-protocol/${protocol}`,
        tier: "published",
        source: { kind: "uri-protocol", ref: protocol },
        name: `open ${protocol}:`,
        suite: "URI protocols",
        kind: "command",
        granularity: "operation",
        parameters: [{ name: "uri", type: "string", required: false }],
        effect: { class: "unknown", basis: "unverified" },
      });
    }
    for (const alias of facts.executionAliases) {
      capabilities.push({
        id: `${app.key}#published:execution-alias/${alias}`,
        tier: "published",
        source: { kind: "execution-alias", ref: alias },
        name: `run ${alias}`,
        suite: "Execution aliases",
        kind: "command",
        granularity: "operation",
        parameters: [{ name: "arguments", type: "list<string>", required: false }],
        effect: { class: "unknown", basis: "unverified" },
      });
    }
    let registrationDetail = "";
    for (const extension of facts.appExtensions.filter((item) => item.name === "com.microsoft.windows.ai.actions")) {
      if (!extension.registration || !entry.InstallLocation) continue;
      const file = win.join(entry.InstallLocation, extension.publicFolder ?? "", extension.registration);
      try {
        capabilities.push(...parseActionsRegistration(await host.fs.readFile(file, MAX_REGISTRATION_BYTES), app.key));
      } catch (error) {
        registrationDetail = `, registration.json not read (${error instanceof Error ? error.name : "error"})`;
      }
    }
    return [{
      record: {
        source: "appx-manifest",
        tier: "published",
        status: capabilities.length > 0 ? "ok" : "empty",
        count: capabilities.length,
        ms: Date.now() - started,
        detail: `${facts.protocols.length} protocols, ${facts.executionAliases.length} aliases, ${facts.appExtensions.length} app extensions${registrationDetail}`,
      },
      capabilities,
    }];
  },
};
