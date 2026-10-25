// Desktop Main: system trust store at once, then the system proxy as Chromium
// resolves it (WinINET, PAC/WPAD on Windows; System Settings on macOS; env or
// GNOME settings on Linux) — the same answer the app's own browser windows and
// the updater already use. Applied to Node's fetch, http(s) and `ws` through
// system-network-core.ts; with no proxy configured nothing changes.
//
// PAC can send different hosts to different proxies, but Node takes one proxy
// plus a bypass list. The hosts the app actually talks to are probed: the first
// proxy found wins, and probed hosts that the PAC sends DIRECT are bypassed.

import {
  applySystemProxy,
  installSystemCertificates,
  mergeNoProxy,
  noProxyFromWindowsOverride,
  parseWindowsInternetSettings,
  proxyConfigFromEnv,
  proxyUrlFromChromiumRules,
  readWindowsInternetSettingsText,
  systemNetworkStatusLine,
  type SystemProxyConfig,
} from "./system-network-core";
import { LMSTUDIO_DEFAULT_HOST, MLX_DEFAULT_HOST, normalizeLocalHost, OLLAMA_DEFAULT_HOST } from "../runtime/local-host";

const REFRESH_MS = 10 * 60_000;

export type ResolveProxy = (url: string) => Promise<string>;

/** Hosts whose proxy decision matters to the app, most important first. */
export function systemProxyProbeUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const web = env.AGENTLAS_WEB_BASE_URL?.trim() || "https://agentlas.cloud";
  const urls = [
    web,
    env.AGENTLAS_RELAY_URL?.trim() || "",
    "https://api.anthropic.com/",
    "https://api.openai.com/",
    "https://generativelanguage.googleapis.com/",
    "https://registry.npmjs.org/",
    // A local model server on another machine (LAN GPU box) is often DIRECT in a PAC.
    env.OLLAMA_HOST?.trim() ? normalizeLocalHost(env.OLLAMA_HOST, OLLAMA_DEFAULT_HOST) : "",
    env.LMSTUDIO_HOST?.trim() ? normalizeLocalHost(env.LMSTUDIO_HOST, LMSTUDIO_DEFAULT_HOST) : "",
    env.MLX_HOST?.trim() ? normalizeLocalHost(env.MLX_HOST, MLX_DEFAULT_HOST) : "",
  ];
  const out: string[] = [];
  for (const value of urls) {
    if (!value) continue;
    try {
      const url = new URL(value.replace(/^ws/i, "http"));
      const origin = `${url.protocol}//${url.host}/`;
      if (!out.includes(origin)) out.push(origin);
    } catch {
      // An unparsable override is the caller's to report.
    }
  }
  return out;
}

/**
 * Chromium's per-URL answers → one Node proxy config. Probed hosts that go
 * DIRECT while another goes through a proxy become bypass entries; a second,
 * different proxy cannot be represented and is noted.
 */
export async function resolveSystemProxyConfig(
  resolveProxy: ResolveProxy,
  probeUrls: readonly string[],
  windowsOverride = "",
): Promise<SystemProxyConfig | null> {
  const answers: Array<{ host: string; proxy: string | null | "unsupported" }> = [];
  for (const url of probeUrls) {
    let rules = "DIRECT";
    try {
      rules = await resolveProxy(url);
    } catch {
      continue;
    }
    answers.push({ host: new URL(url).hostname.toLowerCase(), proxy: proxyUrlFromChromiumRules(rules) });
  }
  const chosen = answers.find((answer): answer is { host: string; proxy: string } =>
    typeof answer.proxy === "string" && answer.proxy !== "unsupported")?.proxy;
  const notes: string[] = [];
  const unsupported = answers.filter((answer) => answer.proxy === "unsupported").length;
  if (unsupported) notes.push(`unsupported-proxy:${unsupported}`);
  if (!chosen) return null;
  const direct = answers.filter((answer) => answer.proxy === null).map((answer) => answer.host);
  const split = answers.filter((answer) => typeof answer.proxy === "string" && answer.proxy !== "unsupported" && answer.proxy !== chosen).length;
  if (split) notes.push(`pac-split:${split}`);
  const override = noProxyFromWindowsOverride(windowsOverride);
  if (override.skipped) notes.push(`override-wildcards-skipped:${override.skipped}`);
  return {
    httpsProxy: chosen,
    httpProxy: chosen,
    noProxy: mergeNoProxy(direct, override.entries),
    source: "system",
    ...(notes.length ? { notes } : {}),
  };
}

let installed = false;
let lastLine = "";

function logOnce(line: string): void {
  if (line === lastLine) return;
  lastLine = line;
  console.info(line);
}

async function refreshFromChromium(certificates: { added: number; supported: boolean }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { session } = require("electron") as typeof import("electron");
  const windowsOverride = process.platform === "win32"
    ? parseWindowsInternetSettings((await readWindowsInternetSettingsText()) ?? "").proxyOverride
    : "";
  const config = await resolveSystemProxyConfig(
    (url) => session.defaultSession.resolveProxy(url),
    systemProxyProbeUrls(process.env),
    windowsOverride,
  );
  applySystemProxy(config);
  logOnce(systemNetworkStatusLine("main", certificates, config));
}

/**
 * Call once at Main start-up, before networking begins. Trust is installed
 * synchronously; the proxy follows as soon as Chromium can answer, and is
 * re-read every ten minutes (a laptop moving between office and home).
 */
export function installMainSystemNetwork(): void {
  if (installed) return;
  installed = true;
  const certificates = installSystemCertificates();
  const fromEnv = proxyConfigFromEnv(process.env);
  if (fromEnv) {
    // The user's explicit proxy env is what their CLIs already use.
    applySystemProxy(fromEnv);
    logOnce(systemNetworkStatusLine("main", certificates, fromEnv));
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  const refresh = () => {
    void refreshFromChromium(certificates).catch((error) => {
      console.warn("[system-network] proxy resolution failed; staying with the current setting", error instanceof Error ? error.message : String(error));
    });
  };
  void app.whenReady().then(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    timer.unref?.();
  });
}
