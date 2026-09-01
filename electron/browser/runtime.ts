import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENTLAS_BROWSER_RUNTIME_MANIFEST = "agentlas-browser-runtime.json";
export const AGENTLAS_BROWSER_RUNTIME_SCHEMA = "agentlas.browser-runtime.v1";

export interface AgentlasBrowserRuntimeManifest {
  schemaVersion: typeof AGENTLAS_BROWSER_RUNTIME_SCHEMA;
  runtime: "playwright-chrome-for-testing";
  playwrightVersion: string;
  browserRevision: string;
  browserVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  executableRelativePath: string;
  executableSha256: string;
  runtimeTreeSha256: string;
  macBundleId?: "com.google.chrome.for.testing";
}
export interface AgentlasBrowserRuntimeResolution {
  executable: string;
  root: string;
  manifest: AgentlasBrowserRuntimeManifest | null;
  source: "packaged" | "build-resource" | "playwright-cache" | "test-override";
}

function processResourcesPath(): string | null {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" && path.isAbsolute(value) ? value : null;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function readManifest(root: string): AgentlasBrowserRuntimeManifest | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, AGENTLAS_BROWSER_RUNTIME_MANIFEST), "utf8"),
    ) as Partial<AgentlasBrowserRuntimeManifest>;
    if (
      raw.schemaVersion !== AGENTLAS_BROWSER_RUNTIME_SCHEMA
      || raw.runtime !== "playwright-chrome-for-testing"
      || typeof raw.playwrightVersion !== "string"
      || typeof raw.browserRevision !== "string"
      || typeof raw.browserVersion !== "string"
      || raw.platform !== process.platform
      || raw.arch !== process.arch
      || typeof raw.executableRelativePath !== "string"
      || !/^[0-9a-f]{64}$/u.test(String(raw.executableSha256 ?? ""))
      || !/^[0-9a-f]{64}$/u.test(String(raw.runtimeTreeSha256 ?? ""))
      || (process.platform === "darwin" && raw.macBundleId !== "com.google.chrome.for.testing")
    ) return null;
    return raw as AgentlasBrowserRuntimeManifest;
  } catch {
    return null;
  }
}

function resolveManifestRuntime(root: string): AgentlasBrowserRuntimeResolution | null {
  const manifest = readManifest(root);
  if (!manifest) return null;
  const executable = path.resolve(root, ...manifest.executableRelativePath.split("/"));
  if (!isContained(path.resolve(root), executable) || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    return null;
  }
  return {
    executable,
    root: path.resolve(root),
    manifest,
    source: processResourcesPath() && path.resolve(root).startsWith(path.resolve(processResourcesPath()!))
      ? "packaged"
      : "build-resource",
  };
}

function developmentRuntimeRoot(): string {
  return path.resolve(__dirname, "../../..", "build-resources", "browser-runtime");
}

function playwrightCacheRuntime(): AgentlasBrowserRuntimeResolution | null {
  if (processResourcesPath() && process.env.NODE_ENV === "production") return null;
  try {
    const playwright = require("playwright") as { chromium?: { executablePath?: () => string } };
    const executable = playwright.chromium?.executablePath?.();
    if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) return null;
    const normalized = path.normalize(executable);
    const revisionSegment = normalized
      .split(path.sep)
      .find((segment) => /^chromium-\d+$/u.test(segment));
    if (!revisionSegment) return null;
    const marker = `${path.sep}${revisionSegment}${path.sep}`;
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex < 0) return null;
    const root = normalized.slice(0, markerIndex + marker.length - 1);
    return { executable, root, manifest: null, source: "playwright-cache" };
  } catch {
    return null;
  }
}

/**
 * Resolve only Agentlas-owned Chrome for Testing bytes. System Chrome/Edge is
 * intentionally absent: launching those app bundles makes LaunchServices and
 * the Windows shell conflate hidden automation with the user's browser.
 */
export function resolveAgentlasBrowserRuntime(): AgentlasBrowserRuntimeResolution | null {
  const override = process.env.AGENTLAS_BROWSER_RUNTIME_EXECUTABLE;
  if (
    override
    && process.env.AGENTLAS_BROWSER_RUNTIME_TEST_OVERRIDE === "1"
    && path.isAbsolute(override)
    && fs.statSync(override, { throwIfNoEntry: false })?.isFile()
  ) {
    return {
      executable: path.resolve(override),
      root: path.dirname(path.resolve(override)),
      manifest: null,
      source: "test-override",
    };
  }

  const resources = processResourcesPath();
  if (resources) {
    const packaged = resolveManifestRuntime(path.join(resources, "browser-runtime"));
    if (packaged) return packaged;
    if (process.env.NODE_ENV === "production") return null;
  }
  return resolveManifestRuntime(developmentRuntimeRoot()) ?? playwrightCacheRuntime();
}

export function resolveAgentlasBrowserRuntimeExecutable(): string | null {
  return resolveAgentlasBrowserRuntime()?.executable ?? null;
}

/** Legacy identification only. Never use these values as a spawn fallback. */
export function legacySystemBrowserExecutableCandidates(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      pathApi.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local");
    return [
      pathApi.join(env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      pathApi.join(env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      pathApi.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}
