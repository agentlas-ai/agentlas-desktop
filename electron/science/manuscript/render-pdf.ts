// PDF production for Science manuscripts.
//
// Two engines, always reported honestly:
//   tectonic  — real LaTeX typesetting when the toolchain exists on this machine
//               (`tectonic` on PATH or in the usual Homebrew/user locations).
//   chromium  — Electron's own print engine over the HTML rendering. Zero external
//               dependencies, so a manuscript PDF is always producible.
// The caller decides the preferred engine; when LaTeX fails or is missing, the
// Chromium result carries `degraded` so nobody can present it as typeset LaTeX.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ManuscriptPdfEngine = "tectonic" | "chromium";

export interface LatexCompileDiagnostics {
  logSha256: string;
  overfullBoxCount: number;
  underfullBoxCount: number;
  undefinedReferenceCount: number;
  multiplyDefinedLabelCount: number;
  missingGlyphCount: number;
  rerunWarningCount: number;
}

export interface TectonicToolchainReceipt {
  engine: "tectonic";
  version: string;
  executableSha256: string;
}

export interface ManuscriptPdfResult {
  ok: boolean;
  engine?: ManuscriptPdfEngine;
  bytes?: Buffer;
  degraded?: "toolchain-missing" | "typeset-failed";
  degradedReason?: string;
  reason?: string;
  log?: string;
  diagnostics?: LatexCompileDiagnostics;
  toolchain?: TectonicToolchainReceipt;
}

const TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".cargo/bin")];

export function resolveTectonic(): string | null {
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, process.platform === "win32" ? "tectonic.exe" : "tectonic"));
  for (const candidate of [...TOOL_DIRS.map((dir) => path.join(dir, "tectonic")), ...fromPath]) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

function countMatches(value: string, pattern: RegExp): number { return (value.match(pattern) ?? []).length; }

export function analyzeLatexCompileLog(log: string): LatexCompileDiagnostics {
  return {
    logSha256: createHash("sha256").update(log).digest("hex"),
    overfullBoxCount: countMatches(log, /^Overfull \\[hv]box\b/gm),
    underfullBoxCount: countMatches(log, /^Underfull \\[hv]box\b/gm),
    undefinedReferenceCount: countMatches(log, /(?:LaTeX Warning: (?:Reference|Citation) .+ undefined|There were undefined references)/gi),
    multiplyDefinedLabelCount: countMatches(log, /(?:multiply defined|Label .+ multiply defined)/gi),
    missingGlyphCount: countMatches(log, /Missing character: There is no /gi),
    rerunWarningCount: countMatches(log, /(?:Label\(s\) may have changed|Rerun to get cross-references right)/gi),
  };
}

function tectonicToolchainReceipt(executable: string): TectonicToolchainReceipt {
  const versionRun = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const version = `${versionRun.stdout ?? ""}\n${versionRun.stderr ?? ""}`.trim().split(/\r?\n/u)[0]?.trim() || "unknown";
  return {
    engine: "tectonic",
    version,
    executableSha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
  };
}

function runProcess(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: process.env.HOME ?? os.homedir() } });
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }); });
  });
}

export interface LatexPdfInput {
  tex: string;
  /** Files written next to main.tex (figures/…). */
  files: Array<{ name: string; bytes: Uint8Array }>;
  timeoutMs?: number;
}

/** Typesets with tectonic in a temporary directory. Returns null when the toolchain is absent. */
export async function renderPdfWithTectonic(input: LatexPdfInput): Promise<ManuscriptPdfResult | null> {
  const tectonic = resolveTectonic();
  if (!tectonic) return null;
  const toolchain = tectonicToolchainReceipt(tectonic);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-manuscript-"));
  try {
    fs.writeFileSync(path.join(workDir, "main.tex"), input.tex, "utf8");
    for (const file of input.files) {
      const target = path.join(workDir, file.name);
      if (!target.startsWith(workDir + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    const result = await runProcess(tectonic, ["-X", "compile", "--keep-logs", "--outdir", workDir, "main.tex"], workDir, input.timeoutMs ?? 240_000);
    const pdfPath = path.join(workDir, "main.pdf");
    let log = "";
    try { log = fs.readFileSync(path.join(workDir, "main.log"), "utf8").slice(-200_000); } catch { /* no log */ }
    const diagnostics = analyzeLatexCompileLog(log);
    if (result.code !== 0 || !fs.existsSync(pdfPath)) {
      const errorLines = (log.match(/^!.*$/gm) ?? []).slice(0, 5).join(" | ");
      return { ok: false, engine: "tectonic", reason: errorLines || result.stderr.trim().split("\n").slice(-5).join(" | ") || `tectonic exited ${result.code}`, log, diagnostics, toolchain };
    }
    return { ok: true, engine: "tectonic", bytes: fs.readFileSync(pdfPath), log, diagnostics, toolchain };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Prints the HTML rendering with Electron's Chromium. Only callable from the main process after `app` is ready. */
export async function renderPdfWithChromium(html: string): Promise<ManuscriptPdfResult> {
  let electron: typeof import("electron");
  try { electron = await import("electron"); } catch (error) { return { ok: false, reason: `electron unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  const { BrowserWindow, app } = electron;
  if (!app?.isReady?.()) return { ok: false, reason: "electron app is not ready" };
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, images: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`);
    const bytes = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.87, bottom: 0.87, left: 0.79, right: 0.79 }, preferCSSPageSize: true });
    return { ok: true, engine: "chromium", bytes };
  } catch (error) {
    return { ok: false, engine: "chromium", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export interface ManuscriptPdfInput {
  html: string;
  latex: LatexPdfInput | null;
  prefer: ManuscriptPdfEngine;
}

/** Produces a PDF with the preferred engine and falls back honestly. */
export async function renderManuscriptPdf(input: ManuscriptPdfInput): Promise<ManuscriptPdfResult> {
  if (input.prefer === "tectonic" && input.latex) {
    const latex = await renderPdfWithTectonic(input.latex);
    if (latex?.ok) return latex;
    const fallback = await renderPdfWithChromium(input.html);
    if (!fallback.ok) return { ok: false, reason: [latex?.reason, fallback.reason].filter(Boolean).join(" / ") || "pdf export failed" };
    return { ...fallback, degraded: latex === null ? "toolchain-missing" : "typeset-failed", ...(latex?.reason ? { degradedReason: latex.reason } : {}), log: latex?.log, diagnostics: latex?.diagnostics, toolchain: latex?.toolchain };
  }
  return renderPdfWithChromium(input.html);
}
