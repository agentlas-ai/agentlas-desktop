#!/usr/bin/env node
"use strict";

// This harness watches the product's real novice path. It creates a fresh local
// project in the Electron Science view, submits one plain-language dinosaur
// question, and lets the installed Research Director decide which Science MCP
// tools to call. It never seeds a fossil, genome, or manuscript run. The only
// data written by the harness is inside a temporary user-data directory plus a
// private report under output/playwright.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
if (process.versions.electron) {
  console.error("qa-science-dinosaur-prompt-chain: run this with node, not electron");
  process.exit(1);
}

const question = process.env.AGENTLAS_DINOSAUR_QUESTION ||
  "Research on completing dinosaur resurrection genes through the combination of genes from resurrectable dinosaur species, known dinosaur genes, and genes from other extant organisms";
const projectTitle = "Dinosaur resurrection proxy research";
const nudge = process.env.AGENTLAS_DINOSAUR_NUDGE ||
  "이어서 계속 진행해줘. 이미 검증된 다음 단계가 있으면 Research Director가 Science 도구로 실행하고, 사람의 확인이 필요한 결정만 바텀시트 질문으로 남겨줘. 화석 근거를 DNA나 부활 증거로 과장하지 마.";
const requiredRuntimeKind = process.env.AGENTLAS_DINOSAUR_RUNTIME_KIND || "codex";
const runtimeProbeKinds = ["claude-code", "codex", "antigravity", "kimi", "grok", "cursor", "ollama", "lmstudio", "mlx", "acp"];
const disabledRuntimeKinds = [...new Set([
  ...String(process.env.AGENTLAS_DISABLED_RUNTIME_KINDS || "").split(",").map((value) => value.trim()).filter(Boolean),
  ...runtimeProbeKinds.filter((kind) => kind !== requiredRuntimeKind),
])];
const turnBudget = Number(process.env.AGENTLAS_DINOSAUR_TURNS || 8);
const turnTimeoutMs = Number(process.env.AGENTLAS_DINOSAUR_TURN_TIMEOUT_MS || 900_000);
const totalTimeoutMs = Number(process.env.AGENTLAS_DINOSAUR_TOTAL_TIMEOUT_MS || 1_800_000);
const teardownReserveMs = Math.min(60_000, Math.max(10_000, Math.floor(totalTimeoutMs / 10)));
assert.ok(Number.isSafeInteger(turnBudget) && turnBudget >= 1 && turnBudget <= 24, "invalid turn budget");
assert.ok(Number.isSafeInteger(turnTimeoutMs) && turnTimeoutMs >= 1_000, "invalid turn timeout");
assert.ok(Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs > teardownReserveMs, "invalid total timeout");

const MAX_QUIT_CHRONOLOGY_EVENTS = 64;
const MAX_QUIT_CHILD_EXITS = 32;
const quitChronologyEvents = new Set([
  "qa-harness-close-requested",
  "qa-turn-deadline",
  "qa-work-deadline",
  "qa-hard-deadline",
  "electron-app-before-quit",
  "electron-app-will-quit",
  "electron-process-exit",
  "electron-main-window-closed",
  "science-webcontents-destroyed",
  "science-render-process-gone",
  "runtime-child-exit",
  "runtime-child-error",
  "electron-child-process-gone",
  "playwright-page-close",
  "playwright-context-close",
  "playwright-electron-close",
]);

function boundedFirstAndLast(items, limit) {
  if (items.length <= limit) return items;
  const firstCount = Math.ceil(limit / 2);
  return [...items.slice(0, firstCount), ...items.slice(-(limit - firstCount))];
}

function eventSummary(timeline, event) {
  const matches = timeline.filter((entry) => entry?.event === event && typeof entry.at === "string");
  return {
    count: matches.length,
    firstAt: matches[0]?.at || "unknown",
    lastAt: matches.at(-1)?.at || "unknown",
  };
}

function knownOrUnknown(value) {
  return value === undefined ? "unknown" : value === null ? "none" : value;
}

function eventExitCode(entry) {
  if (Object.prototype.hasOwnProperty.call(entry, "code")) return knownOrUnknown(entry.code);
  if (Object.prototype.hasOwnProperty.call(entry, "exitCode")) return knownOrUnknown(entry.exitCode);
  return "unknown";
}

function eventPid(entry) {
  if (Object.prototype.hasOwnProperty.call(entry, "pid")) return knownOrUnknown(entry.pid);
  if (Object.prototype.hasOwnProperty.call(entry, "electronPid")) return knownOrUnknown(entry.electronPid);
  return "unknown";
}

function buildQuitCauseChronology(report, timeline) {
  const relevant = timeline.filter((entry) => quitChronologyEvents.has(entry?.event));
  const childExitEvents = relevant.filter((entry) => entry.event === "runtime-child-exit" || entry.event === "electron-child-process-gone");
  const electronExit = report.electronExit;
  const closeRequest = [...relevant].reverse().find((entry) => entry.event === "qa-harness-close-requested") || null;
  const chronology = boundedFirstAndLast(relevant, MAX_QUIT_CHRONOLOGY_EVENTS).map((entry) => ({
    at: typeof entry.at === "string" ? entry.at : "unknown",
    event: entry.event,
    pid: eventPid(entry),
    code: eventExitCode(entry),
    signal: knownOrUnknown(entry.signal),
    reason: knownOrUnknown(entry.reason),
  }));
  const childExits = boundedFirstAndLast(childExitEvents, MAX_QUIT_CHILD_EXITS).map((entry) => ({
    at: typeof entry.at === "string" ? entry.at : "unknown",
    event: entry.event,
    pid: eventPid(entry),
    type: knownOrUnknown(entry.type),
    name: knownOrUnknown(entry.name),
    code: eventExitCode(entry),
    signal: knownOrUnknown(entry.signal),
    reason: knownOrUnknown(entry.reason),
  }));

  return {
    schema: "agentlas.science.quit-cause-chronology/v1",
    cause: "unknown",
    harness: {
      closeRequestedAt: report.closeRequestedAt || "unknown",
      closeRequestReason: closeRequest?.reason || "unknown",
      deadlines: {
        turnTimeoutMs: report.timeout.turnTimeoutMs,
        totalTimeoutMs: report.timeout.totalTimeoutMs,
        teardownReserveMs: report.timeout.teardownReserveMs,
        turnDeadline: eventSummary(relevant, "qa-turn-deadline"),
        workDeadline: {
          reached: report.timeout.workDeadlineReached,
          ...eventSummary(relevant, "qa-work-deadline"),
        },
        hardDeadline: {
          reached: report.timeout.hardDeadlineReached,
          ...eventSummary(relevant, "qa-hard-deadline"),
        },
      },
    },
    electron: {
      beforeQuit: eventSummary(relevant, "electron-app-before-quit"),
      willQuit: eventSummary(relevant, "electron-app-will-quit"),
      mainWindowClosed: eventSummary(relevant, "electron-main-window-closed"),
      applicationClosed: eventSummary(relevant, "playwright-electron-close"),
      processExit: electronExit ? {
        at: electronExit.at || "unknown",
        code: knownOrUnknown(electronExit.code),
        signal: knownOrUnknown(electronExit.signal),
      } : { at: "unknown", code: "unknown", signal: "unknown" },
    },
    osSignalObservation: {
      availability: "electron-process-exit-event-only",
      electronProcessExitObserved: Boolean(electronExit),
      signalObserved: electronExit ? Boolean(electronExit.signal) : "unknown",
      signal: electronExit ? knownOrUnknown(electronExit.signal) : "unknown",
      nativeActionObservation: "unavailable",
      nativeActionOrigin: "unknown",
    },
    childExits,
    childExitsTruncated: childExitEvents.length > MAX_QUIT_CHILD_EXITS,
    chronology,
    chronologyTruncated: relevant.length > MAX_QUIT_CHRONOLOGY_EVENTS,
  };
}

function runQuitChronologyContract() {
  const timeline = [
    { at: "2026-09-05T00:00:01.000Z", event: "qa-turn-deadline", reason: "turn-timeout" },
    { at: "2026-09-05T00:00:02.000Z", event: "electron-app-before-quit" },
    { at: "2026-09-05T00:00:03.000Z", event: "electron-app-will-quit" },
    ...Array.from({ length: 70 }, (_, index) => ({
      at: new Date(Date.parse("2026-09-05T00:00:10.000Z") + index * 1_000).toISOString(),
      event: "runtime-child-exit",
      pid: 1_000 + index,
      code: index % 2 === 0 ? 0 : null,
      signal: index % 2 === 0 ? null : "SIGTERM",
    })),
    { at: "2026-09-05T00:01:30.000Z", event: "electron-child-process-gone", type: "Utility", reason: "crashed", exitCode: 9 },
    { at: "2026-09-05T00:02:00.000Z", event: "qa-harness-close-requested", reason: "finally" },
    { at: "2026-09-05T00:02:01.000Z", event: "playwright-electron-close" },
    { at: "2026-09-05T00:02:02.000Z", event: "electron-process-exit", pid: 999, code: 0, signal: null },
  ];
  const chronology = buildQuitCauseChronology({
    closeRequestedAt: "2026-09-05T00:02:00.000Z",
    electronExit: { at: "2026-09-05T00:02:02.000Z", code: 0, signal: null },
    timeout: { turnTimeoutMs: 900_000, totalTimeoutMs: 1_800_000, teardownReserveMs: 60_000, workDeadlineReached: false, hardDeadlineReached: false },
  }, timeline);
  assert.equal(chronology.cause, "unknown");
  assert.equal(chronology.harness.closeRequestReason, "finally");
  assert.equal(chronology.harness.deadlines.turnDeadline.count, 1);
  assert.equal(chronology.electron.beforeQuit.firstAt, "2026-09-05T00:00:02.000Z");
  assert.equal(chronology.electron.applicationClosed.firstAt, "2026-09-05T00:02:01.000Z");
  assert.equal(chronology.electron.processExit.signal, "none");
  assert.equal(chronology.osSignalObservation.signalObserved, false);
  assert.equal(chronology.osSignalObservation.nativeActionOrigin, "unknown");
  assert.equal(chronology.childExits.length, MAX_QUIT_CHILD_EXITS);
  assert.equal(chronology.childExitsTruncated, true);
  assert.equal(chronology.childExits.some((entry) => entry.event === "electron-child-process-gone" && entry.code === 9), true);
  assert.equal(chronology.chronology.length, MAX_QUIT_CHRONOLOGY_EVENTS);
  assert.equal(chronology.chronologyTruncated, true);
  assert.equal(chronology.chronology[0].event, "qa-turn-deadline");
  assert.equal(chronology.chronology.at(-1).event, "electron-process-exit");

  const empty = buildQuitCauseChronology({
    closeRequestedAt: null,
    electronExit: null,
    timeout: { turnTimeoutMs: 1_000, totalTimeoutMs: 2_000, teardownReserveMs: 1_000, workDeadlineReached: false, hardDeadlineReached: false },
  }, []);
  assert.equal(empty.harness.closeRequestedAt, "unknown");
  assert.equal(empty.electron.beforeQuit.firstAt, "unknown");
  assert.equal(empty.electron.processExit.signal, "unknown");
  assert.equal(empty.osSignalObservation.signalObserved, "unknown");
  console.log(JSON.stringify({ ok: true, contract: "quit-cause-chronology", maxEvents: MAX_QUIT_CHRONOLOGY_EVENTS, maxChildExits: MAX_QUIT_CHILD_EXITS }));
}

if (process.argv.includes("--self-test-quit-chronology")) {
  runQuitChronologyContract();
  process.exit(0);
}

const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-dinosaur-prompt-chain-"));
const userData = path.join(qaRoot, "user-data");
const extensionRoot = path.join(qaRoot, "extensions");
const directorRoot = path.join(qaRoot, "research-director");
const runLabel = `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(qaRoot)}`;
const outputDir = path.join(root, "output", "playwright", "science-dinosaur-prompt-chain", runLabel);
const diagnosticTimelinePath = path.join(qaRoot, "electron-diagnostic-timeline.jsonl");
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(diagnosticTimelinePath, "", { encoding: "utf8", mode: 0o600 });

function appendDiagnosticEvent(event, detail = {}) {
  try {
    fs.appendFileSync(diagnosticTimelinePath, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, "utf8");
  } catch (error) {
    // Late Playwright close callbacks may arrive after the private QA root was
    // intentionally removed. Teardown diagnostics are best-effort and must not
    // turn an otherwise clean bounded shutdown into a process failure.
    if (error?.code !== "ENOENT") throw error;
  }
}

function readDiagnosticTimeline() {
  try {
    return fs.readFileSync(diagnosticTimelinePath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function buildScienceExtension() {
  return JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "build-science-extension-qa.cjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 180_000,
  }));
}

function stageResearchDirector() {
  fs.cpSync(path.join(root, "plugins", "agentlas-science-research-director"), directorRoot, { recursive: true });
  const { researchDirectorReleaseDigest } = require(path.join(root, "node_modules", "agentlas-science", "dist", "research-director.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(directorRoot, "plugin.json"), "utf8"));
  fs.writeFileSync(path.join(directorRoot, ".install.json"), `${JSON.stringify({
    schema: "agentlas.plugin-install/v1",
    slug: manifest.slug,
    version: manifest.version,
    digest: researchDirectorReleaseDigest(directorRoot),
    installationId: crypto.randomUUID(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function installScience(built) {
  const { ProductExtensionInstaller } = require(path.join(root, "dist", "electron", "extensions", "installer.js"));
  const installer = new ProductExtensionInstaller({
    rootDir: extensionRoot,
    dataRootDir: path.join(userData, "extensions"),
    desktopVersion: "1.1.1",
    trustedPublicKeys: JSON.parse(built.trustedKeysJson),
  });
  const installed = installer.installFromDirectory(built.packageDir);
  assert.equal(installed.ok, true, JSON.stringify(installed));
}

const built = buildScienceExtension();
installScience(built);
stageResearchDirector();

const env = {
  ...process.env,
  NODE_ENV: "production",
  LANG: "ko_KR.UTF-8",
  AGENTLAS_E2E: "1",
  AGENTLAS_E2E_AUTH: "1",
  AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
  AGENTLAS_QA_USER_DATA_DIR: userData,
  AGENTLAS_STORE_PATH: path.join(qaRoot, "desktop.sqlite"),
  AGENTLAS_DISABLE_DAEMON: "1",
  AGENTLAS_DISABLED_RUNTIME_KINDS: disabledRuntimeKinds.join(","),
  AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON: built.trustedKeysJson,
  AGENTLAS_PRODUCT_EXTENSION_ROOT_DIR: extensionRoot,
  AGENTLAS_SCIENCE_RESEARCH_DIRECTOR_PLUGIN_ROOT: directorRoot,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function trace(stage, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`);
}

function resolveExecutable(name, override, fallbacks = []) {
  const pathCandidates = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name));
  for (const candidate of [override, ...pathCandidates, ...fallbacks].filter(Boolean)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next installed location */ }
  }
  throw new Error(`dinosaur-required-executable-missing ${name}`);
}

async function retryEvaluate(run) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { return await run(); } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/context was destroyed|science-view-missing|not loaded|Target closed/i.test(message)) throw error;
      await sleep(250);
    }
  }
  throw lastError || new Error("science-e2e-evaluate-retries-exhausted");
}

async function waitForScienceView(desktop, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await desktop.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const child = owner?.contentView.children.find((view) => view.webContents?.getTitle() === "Agentlas Science");
      return child ? { loading: child.webContents.isLoading(), crashed: child.webContents.isCrashed() } : null;
    }).catch(() => null);
    if (state && !state.loading && !state.crashed) return;
    await sleep(100);
  }
  throw new Error("science-dinosaur-view-timeout");
}

async function waitForElectronWindow(desktop, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidate = desktop.windows().find((window) => !window.isClosed());
    if (candidate) return candidate;
    await sleep(250);
  }
  throw new Error(`science-dinosaur-electron-window-timeout windows=${desktop.windows().length}`);
}

async function evaluateScience(desktop, source) {
  return retryEvaluate(() => desktop.evaluate(async ({ BrowserWindow }, expression) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const child = owner?.contentView.children.find((view) => view.webContents?.getTitle() === "Agentlas Science");
    if (!child) throw new Error("science-view-missing");
    return child.webContents.executeJavaScript(expression, true);
  }, source));
}

async function captureScience(desktop, name) {
  await evaluateScience(desktop, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  await sleep(100);
  const base64 = await retryEvaluate(() => desktop.evaluate(async ({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const child = owner?.contentView.children.find((view) => view.webContents?.getTitle() === "Agentlas Science");
    if (!child) throw new Error("science-view-missing");
    return (await child.webContents.capturePage()).toPNG().toString("base64");
  }));
  const target = path.join(outputDir, name);
  fs.writeFileSync(target, Buffer.from(base64, "base64"), { mode: 0o600 });
  return target;
}

async function startScienceRecorder(desktop) {
  const videoPath = path.join(outputDir, "full-flow.mp4");
  const framesDir = path.join(outputDir, "video-frames");
  fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });
  const ffmpegPath = resolveExecutable("ffmpeg", process.env.AGENTLAS_FFMPEG_PATH, [
    // Personal install locations come from the environment, never from a path baked into a
    // public repository.
    path.join(os.homedir(), ".local/bin/ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);
  let frameCount = 0;
  let captureError = null;
  const frames = [];
  return {
    async capture(label) {
      try {
        const base64 = await retryEvaluate(() => desktop.evaluate(async ({ BrowserWindow }) => {
          const owner = BrowserWindow.getAllWindows()[0];
          const child = owner?.contentView.children.find((view) => view.webContents?.getTitle() === "Agentlas Science");
          if (!child) throw new Error("science-view-missing");
          return (await child.webContents.capturePage()).toPNG().toString("base64");
        }));
        const framePath = path.join(framesDir, `frame-${String(frameCount + 1).padStart(5, "0")}.png`);
        fs.writeFileSync(framePath, Buffer.from(base64, "base64"), { mode: 0o600 });
        frameCount += 1;
        frames.push({ ordinal: frameCount, label, path: framePath });
        return framePath;
      } catch (error) {
        captureError = String(error instanceof Error ? error.message : error);
        return null;
      }
    },
    async stop() {
      let exit = { code: null, signal: null };
      let stderrTail = null;
      if (frameCount > 0) {
        try {
          execFileSync(ffmpegPath, [
            "-y", "-framerate", "1", "-i", path.join(framesDir, "frame-%05d.png"),
            "-vf", "scale=744:-2,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264",
            "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-r", "1", videoPath,
          ], { timeout: 120_000, stdio: ["ignore", "ignore", "pipe"] });
          exit = { code: 0, signal: null };
        } catch (error) {
          exit = { code: Number.isSafeInteger(error?.status) ? error.status : 1, signal: error?.signal || null };
          stderrTail = String(error?.stderr || error?.message || error).slice(-4_000);
        }
      }
      const stats = fs.existsSync(videoPath) ? fs.statSync(videoPath) : null;
      return {
        path: videoPath,
        frameCount,
        frames,
        captureError,
        ffmpegExit: exit,
        bytes: stats?.size || 0,
        sha256: stats ? crypto.createHash("sha256").update(fs.readFileSync(videoPath)).digest("hex") : null,
        stderrTail,
      };
    },
  };
}

async function storeSnapshot(desktop, projectId) {
  return retryEvaluate(() => desktop.evaluate(async (_electron, id) => {
    const localRequire = process.getBuiltinModule("node:module").createRequire(`${process.cwd()}/package.json`);
    const nodePath = process.getBuiltinModule("node:path");
    const nodeCrypto = localRequire("node:crypto");
    const { scienceStore } = localRequire(nodePath.join(process.cwd(), "node_modules", "agentlas-science", "dist", "runtime.js"));
    const store = scienceStore();
    const boundedText = (value, maximum) => typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : null;
    const digest = (value) => nodeCrypto.createHash("sha256").update(value).digest("hex");
    const parseBoundedJson = (resource) => {
      if (!resource || !Number.isSafeInteger(resource.byteSize) || resource.byteSize < 2 || resource.byteSize > 64 * 1024
        || typeof resource.mimeType !== "string" || !/json/iu.test(resource.mimeType)) return null;
      try {
        const value = JSON.parse(store.readRunBlob(resource).toString("utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch { return null; }
    };
    const summarizeSpecies = (value) => {
      const raw = value && typeof value === "object" && !Array.isArray(value) ? value.request?.species ?? value.species : null;
      const species = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      if (species.length < 1) return null;
      const allStrings = species.filter((item) => typeof item === "string");
      const strings = allStrings.slice(0, 8);
      return {
        count: species.length,
        hashedCount: strings.length,
        nonStringCount: species.length - allStrings.length,
        truncated: species.length > strings.length,
        slugs: strings.map((slug, index) => ({ ordinal: index + 1, length: slug.length, sha256: digest(slug) })),
      };
    };
    const summarizeEndpoints = (receipt) => [...new Set([receipt?.endpoint, receipt?.releaseEndpoint, receipt?.treeEndpoint]
      .filter((value) => typeof value === "string" && /^https:\/\//u.test(value))
      .slice(0, 3)
      .map((value) => {
        try {
          const parsed = new URL(value);
          parsed.username = "";
          parsed.password = "";
          parsed.search = "";
          parsed.hash = "";
          return parsed.toString().slice(0, 1_024);
        } catch { return null; }
      }).filter(Boolean))];
    const summarizeRun = (run) => ({
      id: boundedText(run?.id, 80),
      toolId: boundedText(run?.toolId, 160),
      status: boundedText(run?.status, 32),
      parentRunId: boundedText(run?.parentRunId, 80),
      errorCode: run?.status === "failed" ? boundedText(run?.summary, 240) : null,
      inputManifestSha256: boundedText(run?.inputManifestSha256, 64),
      inputCount: Array.isArray(run?.inputs) ? run.inputs.length : 0,
      outputCount: Array.isArray(run?.outputs) ? run.outputs.length : 0,
      inputs: (Array.isArray(run?.inputs) ? run.inputs : []).slice(0, 16).map((resource) => ({
        id: boundedText(resource?.id, 80),
        role: boundedText(resource?.role, 160),
        mimeType: boundedText(resource?.mimeType, 160),
        byteSize: Number.isSafeInteger(resource?.byteSize) ? resource.byteSize : null,
        sha256: boundedText(resource?.sha256, 64),
        species: summarizeSpecies(parseBoundedJson(resource)),
      })),
      failureReceipts: (Array.isArray(run?.outputs) ? run.outputs : [])
        .filter((resource) => typeof resource?.role === "string" && resource.role.endsWith("failure-receipt"))
        .slice(0, 8)
        .map((resource) => {
          const receipt = parseBoundedJson(resource);
          return {
            id: boundedText(resource.id, 80),
            role: boundedText(resource.role, 160),
            byteSize: Number.isSafeInteger(resource.byteSize) ? resource.byteSize : null,
            sha256: boundedText(resource.sha256, 64),
            schema: boundedText(receipt?.schema, 160),
            runId: boundedText(receipt?.runId, 80),
            status: Number.isSafeInteger(receipt?.status) ? receipt.status : boundedText(receipt?.status, 64),
            endpoints: summarizeEndpoints(receipt),
            errorCode: boundedText(receipt?.code, 240) || (run?.status === "failed" ? boundedText(run?.summary, 240) : null),
          };
        }),
    });
    const project = store.getProject(id);
    const conversation = store.listConversations(id)[0] || null;
    const messages = conversation ? store.listMessagesForProject(id, conversation.id) : [];
    const turns = conversation ? store.listTurns(id, conversation.id) : [];
    const currentTurn = turns.at(-1) || null;
    const runs = store.listResearchRuns(id, 500);
    const executions = turns.flatMap((turn) => store.listToolExecutionsForInvocation(turn.invocationRunId));
    const assistant = messages.filter((message) => message.role === "assistant").at(-1) || null;
    const manuscripts = store.listManuscripts(id, 100);
    let runtimeIdentity = null;
    try {
      if (currentTurn?.runtimeChatId) {
        const { getDb } = localRequire(nodePath.join(process.cwd(), "dist", "electron", "store", "db.js"));
        const row = getDb().prepare("SELECT id, agent_id AS agentId, firm_id AS firmId FROM chats WHERE id = ?").get(currentTurn.runtimeChatId);
        runtimeIdentity = row || null;
      }
    } catch (error) { runtimeIdentity = { error: String(error && error.message ? error.message : error) }; }
    let lifecycle = null;
    try {
      const value = store.getResearchLifecycleForProject(id);
      lifecycle = value ? { phase: value.phase, status: value.status, revision: value.revision, stateSha256: value.stateSha256 } : null;
    } catch (error) { lifecycle = { error: String(error && error.message ? error.message : error) }; }
    let contract = null;
    try {
      const value = store.latestResearchContract(id);
      contract = value ? { id: value.id, status: value.status, version: value.version, approvedAt: value.approvedAt || null } : null;
    } catch (error) { contract = { error: String(error && error.message ? error.message : error) }; }
    return {
      project: project ? { id: project.id, title: project.title, question: project.question, domain: project.domain, version: project.version } : null,
      conversationId: conversation?.id || null,
      firstUserMessageId: messages.find((message) => message.role === "user")?.id || null,
      turn: currentTurn ? { id: currentTurn.id, invocationRunId: currentTurn.invocationRunId, runtimeChatId: currentTurn.runtimeChatId, status: currentTurn.status, errorCode: currentTurn.errorCode || null, partialText: currentTurn.partialText } : null,
      turns: turns.map((turn) => ({ id: turn.id, status: turn.status, invocationRunId: turn.invocationRunId, runtimeChatId: turn.runtimeChatId, errorCode: turn.errorCode || null })),
      messages: messages.map((message) => ({ id: message.id, role: message.role, content: String(message.content || "").slice(0, 4000) })),
      executions: executions.map((execution) => ({ id: execution.id, toolId: execution.toolId, phase: execution.phase, labId: execution.labId, runId: execution.runId, artifactId: execution.artifactId || null, failureCode: execution.failureCode || null })),
      runs: runs.slice(0, 100).map((run) => ({
        id: run.id,
        toolId: run.toolId,
        status: run.status,
        parentRunId: run.parentRunId || null,
        summary: run.summary ? String(run.summary).slice(0, 240) : null,
        qaEvidence: summarizeRun(run),
      })),
      manuscripts: manuscripts.map((manuscript) => ({ id: manuscript.id, status: manuscript.status, currentVersion: manuscript.currentVersion, title: manuscript.title, bindingCount: manuscript.version.bindings.length })),
      assistantPreview: assistant ? String(assistant.content || "").replace(/[\\s]+/g, " ").slice(0, 1000) : null,
      assistantMessageId: assistant?.id || null,
      runtimeIdentity,
      lifecycle,
      contract,
    };
  }, projectId));
}

async function sendInitialQuestion(desktop) {
  return evaluateScience(desktop, `(async () => {
    const buttons = [...document.querySelectorAll('[data-action="send-turn"]')];
    const button = buttons.find((candidate) => !candidate.disabled && candidate.getClientRects().length > 0);
    if (!button) {
      const diagnostics = {
        buttons: buttons.map((candidate) => ({ disabled: candidate.disabled, aria: candidate.getAttribute('aria-label'), display: getComputedStyle(candidate).display, rects: candidate.getClientRects().length })),
        textareas: [...document.querySelectorAll('textarea[data-composer-input]')].map((candidate) => ({ disabled: candidate.disabled, valueLength: candidate.value.length, display: getComputedStyle(candidate).display, rects: candidate.getClientRects().length })),
      };
      throw new Error('dinosaur-initial-send-not-ready ' + JSON.stringify(diagnostics));
    }
    button.click();
    return { clicked: true };
  })()`);
}

async function sendNudge(desktop, text) {
  return evaluateScience(desktop, `(async () => {
    const input = document.querySelector('textarea[data-composer-input]');
    if (!input) throw new Error('dinosaur-composer-missing');
    if (input.disabled) throw new Error('dinosaur-composer-disabled');
    input.focus();
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const button = document.querySelector('[data-action="send-turn"]');
      if (button && !button.disabled) { button.click(); return { clicked: true }; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('dinosaur-nudge-send-not-ready');
  })()`);
}

async function approveDraftContract(desktop, projectId) {
  return evaluateScience(desktop, `(async () => {
    const diagnostics = { scopeClicks: 0, openClicks: 0, formObservations: 0, submitAttempts: 0 };
    let displayed = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [project, contract] = await Promise.all([
        window.agentlasScience.projects.get(${JSON.stringify(projectId)}),
        window.agentlasScience.researchContracts.get(${JSON.stringify(projectId)}),
      ]);
      if (!contract) return { found: false, clicked: false, approved: false, status: null, diagnostics };
      if (contract.status === 'approved') {
        return { found: true, clicked: diagnostics.submitAttempts > 0, approved: true, status: contract.status, id: contract.id, version: contract.version, displayed, diagnostics };
      }
      if (contract.status !== 'draft') {
        return { found: true, clicked: false, approved: false, status: contract.status, id: contract.id, version: contract.version, displayed, diagnostics };
      }

      const form = document.querySelector('#research-contract-approval-form');
      const submit = form?.querySelector('.primaryButton[type="submit"]');
      const matchesCurrentVersion = Boolean(form
        && form.dataset.contractId === contract.id
        && Number(form.dataset.contractVersion) === Number(contract.version)
        && Number(form.dataset.projectVersion) === Number(project?.version));
      if (form?.getClientRects().length > 0) diagnostics.formObservations += 1;
      if (matchesCurrentVersion && submit && !submit.disabled) {
        displayed = {
          contractId: form.dataset.contractId,
          contractVersion: Number(form.dataset.contractVersion),
          projectVersion: Number(form.dataset.projectVersion),
          buttonText: submit.textContent.trim(),
        };
        diagnostics.submitAttempts += 1;
        form.requestSubmit(submit);
        return {
          found: true,
          clicked: true,
          approved: false,
          status: contract.status,
          id: contract.id,
          version: contract.version,
          displayed,
          diagnostics,
          pendingCanonicalConfirmation: true,
        };
      }

      const workspace = document.querySelector('.workspace');
      if (workspace?.dataset.projectDestination !== 'scope') {
        const scope = document.querySelector('[data-project-destination="scope"]');
        if (scope && scope.getClientRects().length > 0) {
          scope.click();
          diagnostics.scopeClicks += 1;
        }
      } else if (!form || form.getClientRects().length === 0) {
        const open = [...document.querySelectorAll('[data-action="open-research-contract-sheet"]')]
          .find((candidate) => candidate.getClientRects().length > 0 && !candidate.disabled);
        if (open) {
          open.click();
          diagnostics.openClicks += 1;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [project, contract] = await Promise.all([
      window.agentlasScience.projects.get(${JSON.stringify(projectId)}),
      window.agentlasScience.researchContracts.get(${JSON.stringify(projectId)}),
    ]);
    const form = document.querySelector('#research-contract-approval-form');
    const submit = form?.querySelector('.primaryButton[type="submit"]');
    throw new Error('dinosaur-contract-approval-ui-timeout ' + JSON.stringify({
      projectVersion: project?.version || null,
      contractId: contract?.id || null,
      contractVersion: contract?.version || null,
      status: contract?.status || null,
      formVisible: Boolean(form && form.getClientRects().length > 0),
      formContractId: form?.dataset.contractId || null,
      formContractVersion: Number(form?.dataset.contractVersion) || null,
      formProjectVersion: Number(form?.dataset.projectVersion) || null,
      submitDisabled: submit ? Boolean(submit.disabled) : null,
      displayed,
      diagnostics,
    }));
  })()`);
}

function contractReceiptFromSnapshot(contract, source = "canonical-store") {
  if (contract?.status !== "approved") return null;
  return {
    found: true,
    clicked: false,
    approved: true,
    status: contract.status,
    id: contract.id,
    version: contract.version,
    displayed: null,
    source,
  };
}

async function waitForNextTurn(desktop, projectId, previousTurnId, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await storeSnapshot(desktop, projectId);
    if (snapshot.turn?.id && snapshot.turn.id !== previousTurnId) return snapshot;
    await sleep(100);
  }
  throw new Error(`dinosaur-next-turn-not-created ${JSON.stringify({ previousTurnId, currentTurnId: snapshot?.turn?.id || null })}`);
}

async function listPendingDecisions(desktop, projectId) {
  return evaluateScience(desktop, `(async () => {
    const values = await window.agentlasScience.decisions.list(${JSON.stringify(projectId)}, undefined, ['queued', 'presented', 'deferred']);
    return Array.isArray(values) ? values.map((value) => ({ id: value.id, status: value.status, question: value.question || value.prompt || null, optionCount: Array.isArray(value.options) ? value.options.length : 0 })) : [];
  })()`);
}

async function answerVisibleResearchDecision(desktop, projectId) {
  return evaluateScience(desktop, `(async () => {
    const form = document.querySelector('#research-decision-form');
    if (!form || form.getClientRects().length === 0) return null;
    const pending = await window.agentlasScience.decisions.list(${JSON.stringify(projectId)}, undefined, ['queued', 'presented', 'deferred']);
    const decision = Array.isArray(pending) ? pending.find((item) => item.status === 'presented') || pending[0] : null;
    const checked = form.querySelector('input[name="optionId"]:checked');
    const submit = form.querySelector('.primaryButton[type="submit"]');
    if (!decision || !checked || !submit || submit.disabled) throw new Error('dinosaur-research-decision-ui-not-ready');
    const receipt = { decisionId: decision.id, prompt: decision.prompt?.question || decision.question || null, optionId: checked.value, recommended: checked.closest('[data-recommended]')?.dataset.recommended === 'true', buttonText: submit.textContent.trim() };
    form.requestSubmit(submit);
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const values = await window.agentlasScience.decisions.list(${JSON.stringify(projectId)}, undefined, ['queued', 'presented', 'deferred']);
      if (!Array.isArray(values) || !values.some((item) => item.id === decision.id && item.status === 'presented')) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('dinosaur-research-decision-ui-timeout ' + JSON.stringify(receipt));
  })()`);
}

async function answerVisibleRuntimeQuestion(desktop) {
  return evaluateScience(desktop, `(async () => {
    const layer = document.querySelector('[data-runtime-question-id]');
    if (!layer || layer.getClientRects().length === 0) return null;
    const button = layer.querySelector('[data-action="answer-runtime-question"]');
    if (!button || button.disabled) throw new Error('dinosaur-runtime-question-ui-not-ready');
    const receipt = { requestId: layer.dataset.runtimeQuestionId, question: layer.querySelector('#runtime-question-title')?.textContent?.trim() || null, answer: button.dataset.runtimeQuestionAnswer || button.textContent.trim() };
    button.click();
    for (let attempt = 0; attempt < 240 && document.querySelector('[data-runtime-question-id="' + CSS.escape(receipt.requestId) + '"]'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    return receipt;
  })()`);
}

async function createProject(desktop) {
  return evaluateScience(desktop, `(async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const back = document.querySelector('[data-action="back-to-projects"]');
      const open = [...document.querySelectorAll('[data-action="new"]')].find((candidate) => candidate.getClientRects().length > 0 && !candidate.disabled);
      if (open) break;
      if (attempt === 20 && back && back.getClientRects().length > 0) back.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const open = [...document.querySelectorAll('[data-action="new"]')].find((candidate) => candidate.getClientRects().length > 0 && !candidate.disabled);
    if (!open) throw new Error('dinosaur-new-project-button-missing ' + JSON.stringify({ title: document.title, body: document.body.innerText.slice(0, 500), readyState: document.readyState }));
    open.click();
    for (let attempt = 0; attempt < 100 && !document.querySelector('[data-research-template="paleontology-evidence"]'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const template = document.querySelector('[data-research-template="paleontology-evidence"]');
    if (!template) throw new Error('dinosaur-paleontology-template-missing');
    template.click();
    for (let attempt = 0; attempt < 100 && !document.querySelector('#new-project-form'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const input = document.querySelector('#new-project-form textarea[name="question"]');
    const title = document.querySelector('#new-project-form input[name="title"]');
    const form = document.querySelector('#new-project-form');
    if (!input || !title || !form) throw new Error('dinosaur-new-project-form-missing');
    title.value = ${JSON.stringify(projectTitle)};
    title.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = ${JSON.stringify(question)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const projects = await window.agentlasScience.projects.list();
      const project = projects.find((item) => item.title === ${JSON.stringify(projectTitle)});
      const folder = document.querySelector('.projectFolderView');
      if (project && folder && !document.querySelector('.loadingState') && !document.querySelector('.projectFolderEmpty[aria-live="polite"]')) {
        if (project.question !== ${JSON.stringify(question)}) throw new Error('dinosaur-project-question-mismatch');
        const openWorkspace = document.querySelector('[data-action="open-project-workspace"]');
        if (!openWorkspace || openWorkspace.getClientRects().length === 0) throw new Error('dinosaur-open-workspace-button-missing');
        const folderState = folder.dataset.projectFolderState || null;
        return { created: true, projectEntry: project.id, folderState, templateId: project.researchTemplateId, initialLabId: project.initialLabId };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const send = document.querySelector('[data-action="send-turn"]');
    throw new Error('dinosaur-project-create-timeout ' + JSON.stringify({
      projectId: (await window.agentlasScience.projects.list()).find((item) => item.title === ${JSON.stringify(projectTitle)})?.id || null,
      folder: Boolean(document.querySelector('.projectFolderView')),
      workspace: Boolean(document.querySelector('.workspace')),
      loading: Boolean(document.querySelector('.loadingState')),
      sendDisabled: send?.disabled ?? null,
      sendAria: send?.getAttribute('aria-label') || null,
    }));
  })()`);
}

async function openProjectWorkspace(desktop) {
  return evaluateScience(desktop, `(async () => {
    const open = document.querySelector('[data-action="open-project-workspace"]');
    if (!open || open.getClientRects().length === 0) throw new Error('dinosaur-open-workspace-button-missing');
    open.click();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const workspace = document.querySelector('.workspace');
      if (workspace && !document.querySelector('.projectFolderView') && !document.querySelector('.loadingState')) {
        const send = document.querySelector('[data-action="send-turn"]');
        return { opened: true, sendReady: Boolean(send && !send.disabled) };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('dinosaur-workspace-open-timeout');
  })()`);
}

async function waitForProjectFolderReady(desktop) {
  return evaluateScience(desktop, `(async () => {
    let stableSince = 0;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const folder = document.querySelector('.projectFolderView');
      const loading = document.querySelector('.projectFolderEmpty[aria-live="polite"], .loadingState');
      if (folder && !loading) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 750) return { ready: true, state: folder.dataset.projectFolderState || null, text: folder.innerText.slice(0, 1_000) };
      } else stableSince = 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('dinosaur-project-folder-ready-timeout');
  })()`);
}

async function exportManuscriptPdfThroughUi(desktop, projectId) {
  const target = path.join(outputDir, "dinosaur-research-manuscript.pdf");
  await desktop.evaluate(({ BrowserWindow }, destination) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const child = owner?.contentView.children.find((view) => view.webContents?.getTitle() === "Agentlas Science");
    if (!child) throw new Error("science-view-missing");
    const session = child.webContents.session;
    globalThis.__agentlasDinosaurQaDownload = { destination, status: "waiting", fileName: null, receivedBytes: 0, totalBytes: 0 };
    const handler = (_event, item) => {
      if (!/pdf/i.test(item.getMimeType()) && !/\.pdf$/i.test(item.getFilename())) return;
      globalThis.__agentlasDinosaurQaDownload.fileName = item.getFilename();
      globalThis.__agentlasDinosaurQaDownload.status = "started";
      item.setSavePath(destination);
      item.once("done", (_doneEvent, state) => {
        globalThis.__agentlasDinosaurQaDownload.status = state;
        globalThis.__agentlasDinosaurQaDownload.receivedBytes = item.getReceivedBytes();
        globalThis.__agentlasDinosaurQaDownload.totalBytes = item.getTotalBytes();
        session.removeListener("will-download", handler);
      });
    };
    session.on("will-download", handler);
  }, target);
  const ui = await evaluateScience(desktop, `(async () => {
    const nav = document.querySelector('[data-project-destination="manuscript"]');
    if (!nav || nav.getClientRects().length === 0) throw new Error('dinosaur-manuscript-nav-missing');
    nav.click();
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const button = document.querySelector('[data-action="export-manuscript"][data-format="pdf"]');
      if (button && button.getClientRects().length > 0 && !button.disabled) {
        const manuscript = document.querySelector('[data-manuscript-id]');
        button.click();
        return { clicked: true, buttonText: button.textContent.trim(), manuscriptId: manuscript?.dataset.manuscriptId || null };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('dinosaur-manuscript-pdf-button-timeout');
  })()`);
  let download = null;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    download = await desktop.evaluate(() => globalThis.__agentlasDinosaurQaDownload || null);
    if (["completed", "cancelled", "interrupted"].includes(download?.status)) break;
    await sleep(100);
  }
  const stats = fs.existsSync(target) ? fs.statSync(target) : null;
  return {
    ui,
    download,
    path: target,
    exists: Boolean(stats),
    bytes: stats?.size || 0,
    sha256: stats ? crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") : null,
  };
}

function verifyOutputArtifacts(pdf, video) {
  const verificationDir = path.join(qaRoot, "artifact-verification");
  fs.mkdirSync(verificationDir, { recursive: true, mode: 0o700 });
  const result = { pdf: null, video: null };
  if (pdf?.exists && pdf.bytes > 0) {
    const textPath = path.join(verificationDir, "manuscript.txt");
    const pagePrefix = path.join(verificationDir, "manuscript-page-1");
    const pdftotextPath = resolveExecutable("pdftotext", process.env.AGENTLAS_PDFTOTEXT_PATH, ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"]);
    const pdftoppmPath = resolveExecutable("pdftoppm", process.env.AGENTLAS_PDFTOPPM_PATH, ["/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"]);
    execFileSync(pdftotextPath, [pdf.path, textPath], { timeout: 120_000 });
    execFileSync(pdftoppmPath, ["-f", "1", "-singlefile", "-png", "-r", "120", pdf.path, pagePrefix], { timeout: 120_000, maxBuffer: 128 * 1024 * 1024 });
    const pagePath = `${pagePrefix}.png`;
    const text = fs.readFileSync(textPath, "utf8");
    result.pdf = {
      header: fs.readFileSync(pdf.path).subarray(0, 5).toString("ascii"),
      textPath,
      textBytes: fs.statSync(textPath).size,
      textPreview: text.replace(/\s+/g, " ").trim().slice(0, 1_000),
      renderedPagePath: pagePath,
      renderedPageBytes: fs.statSync(pagePath).size,
      renderedPageSha256: crypto.createHash("sha256").update(fs.readFileSync(pagePath)).digest("hex"),
    };
  }
  if (video?.path && video.bytes > 0) {
    const ffprobePath = resolveExecutable("ffprobe", process.env.AGENTLAS_FFPROBE_PATH, ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);
    const probe = JSON.parse(execFileSync(ffprobePath, [
      "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,nb_frames", "-of", "json", video.path,
    ], { encoding: "utf8", timeout: 120_000 }));
    result.video = probe;
  }
  return result;
}

async function closeDesktop(desktop) {
  if (!desktop) return;
  const pid = desktop.process()?.pid || null;
  await Promise.race([desktop.close().catch(() => undefined), sleep(15_000)]);
  if (pid) {
    try { process.kill(pid, 0); process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

async function main() {
  let desktop = null;
  let recorder = null;
  const report = {
    schema: "agentlas.science.dinosaur-prompt-chain-qa/v1",
    question,
    nudge,
    qaRoot,
    runtime: null,
    project: null,
    folder: null,
    turns: [],
    approvals: [],
    decisions: [],
    runtimeQuestions: [],
    continuations: [],
    activeTurn: null,
    pdf: null,
    video: null,
    artifactVerification: null,
    assertions: {},
    electronExit: null,
    closeRequestedAt: null,
    timeout: { turnTimeoutMs, totalTimeoutMs, teardownReserveMs, workDeadlineReached: false, hardDeadlineReached: false },
    timeline: [],
    quitCauseChronology: null,
  };
  const reportPath = path.join(outputDir, "report.json");
  const persistReport = () => {
    const timeline = readDiagnosticTimeline();
    // A late close callback may persist once more after the private QA root is
    // removed. Preserve the last non-empty diagnostic record rather than
    // replacing it with an empty read from a file that no longer exists.
    if (timeline.length > 0 || report.timeline.length === 0) report.timeline = timeline;
    report.quitCauseChronology = buildQuitCauseChronology(report, report.timeline);
    report.reportPath = reportPath;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  const markHarnessCloseRequested = (reason) => {
    if (report.closeRequestedAt) return;
    report.closeRequestedAt = new Date().toISOString();
    appendDiagnosticEvent("qa-harness-close-requested", { reason, pid: desktop?.process()?.pid || null });
  };
  const startedAt = Date.now();
  const hardDeadlineTimer = setTimeout(() => {
    const electronPid = desktop?.process()?.pid || null;
    report.timeout.hardDeadlineReached = true;
    report.failure ||= {
      message: "science-dinosaur-total-deadline-exceeded",
      stack: null,
    };
    report.elapsedMs = Date.now() - startedAt;
    markHarnessCloseRequested("hard-deadline");
    appendDiagnosticEvent("qa-hard-deadline", { electronPid, elapsedMs: report.elapsedMs });
    persistReport();
    trace("process:hard-deadline", { electronPid, elapsedMs: report.elapsedMs });
    try { desktop?.process()?.kill("SIGKILL"); } catch { /* already gone */ }
    process.exit(124);
  }, totalTimeoutMs);
  hardDeadlineTimer.unref?.();
  // Leave a bounded window for the report/video finalization and Electron
  // shutdown. Otherwise an outer 600-second runner can kill the process while
  // this harness is still attempting post-deadline UI capture.
  const totalDeadline = startedAt + totalTimeoutMs - teardownReserveMs;
  try {
    trace("launch:start", { qaRoot, outputDir });
    desktop = await electron.launch({ args: [root, "--lang=ko-KR"], cwd: root, env, timeout: 120_000 });
    appendDiagnosticEvent("electron-launched", { pid: desktop.process()?.pid || null, turnId: null });
    desktop.once("close", () => {
      appendDiagnosticEvent("playwright-electron-close", { turnId: report.continuations.at(-1)?.nextTurn?.turnId || report.turns.at(-1)?.snapshot?.turn?.id || null });
      persistReport();
    });
    desktop.process()?.once("exit", (code, signal) => {
      report.electronExit = {
        at: new Date().toISOString(),
        code,
        signal,
        closeRequested: Boolean(report.closeRequestedAt),
      };
      appendDiagnosticEvent("electron-process-exit", { pid: desktop?.process()?.pid || null, code, signal });
      trace("electron:exit", report.electronExit);
      persistReport();
    });
    await desktop.evaluate(({ app, BrowserWindow }, target) => {
      const localRequire = process.getBuiltinModule("node:module").createRequire(`${process.cwd()}/package.json`);
      const fs = localRequire("node:fs");
      const nodePath = localRequire("node:path");
      globalThis.__agentlasDinosaurQaProjectId = null;
      const currentTurnId = () => {
        try {
          const projectId = globalThis.__agentlasDinosaurQaProjectId;
          if (!projectId) return null;
          const { scienceStore } = localRequire(nodePath.join(process.cwd(), "node_modules", "agentlas-science", "dist", "runtime.js"));
          const store = scienceStore();
          const conversation = store.listConversations(projectId)[0] || null;
          return conversation ? store.listTurns(projectId, conversation.id).at(-1)?.id || null : null;
        } catch { return null; }
      };
      const write = (event, detail = {}) => {
        try {
          fs.appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), event, turnId: currentTurnId(), ...detail })}\n`, "utf8");
        } catch { /* the QA root may already be gone during final teardown */ }
      };
      const owner = BrowserWindow.getAllWindows()[0] || null;
      owner?.once("closed", () => write("electron-main-window-closed"));
      owner?.webContents.on("render-process-gone", (_event, details) => write("electron-main-render-process-gone", {
        reason: details.reason,
        exitCode: details.exitCode,
      }));
      app.on("before-quit", () => write("electron-app-before-quit"));
      app.on("will-quit", () => write("electron-app-will-quit"));
      app.on("child-process-gone", (_event, details) => write("electron-child-process-gone", {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName || null,
        name: details.name || null,
      }));
      const attachedRuntimePids = new Set();
      const attachRuntimeChildren = () => {
        const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
        for (const child of handles) {
          const pid = Number(child?.pid);
          const executable = typeof child?.spawnfile === "string" ? nodePath.basename(child.spawnfile) : "";
          if (!Number.isInteger(pid) || pid < 1 || attachedRuntimePids.has(pid) || !/(?:codex|claude|kimi|grok|antigravity)/iu.test(executable)) continue;
          attachedRuntimePids.add(pid);
          write("runtime-child-observed", { pid, executable });
          child.once("exit", (code, signal) => write("runtime-child-exit", { pid, executable, code, signal }));
          child.once("error", (error) => write("runtime-child-error", { pid, executable, message: error instanceof Error ? error.message : String(error) }));
        }
      };
      const attachScienceChild = () => {
        const activeOwner = BrowserWindow.getAllWindows()[0] || null;
        for (const view of activeOwner?.contentView.children || []) {
          const contents = view?.webContents;
          if (!contents || contents.__agentlasDinosaurQaDiagnosticsAttached || contents.getTitle() !== "Agentlas Science") continue;
          contents.__agentlasDinosaurQaDiagnosticsAttached = true;
          write("science-webcontents-observed", { webContentsId: contents.id });
          contents.on("render-process-gone", (_event, details) => write("science-render-process-gone", {
            webContentsId: contents.id,
            reason: details.reason,
            exitCode: details.exitCode,
          }));
          contents.once("destroyed", () => write("science-webcontents-destroyed", { webContentsId: contents.id }));
        }
      };
      const timer = setInterval(() => { attachRuntimeChildren(); attachScienceChild(); }, 250);
      timer.unref?.();
      app.once("will-quit", () => clearInterval(timer));
      attachRuntimeChildren();
      attachScienceChild();
    }, diagnosticTimelinePath);
    // A cold packaged Electron launch can exceed one minute when another
    // renderer is compiling or reclaiming memory. Keep the startup gate
    // bounded, but do not misclassify slow startup as a missing runtime.
    // Playwright's firstWindow event can be missed when the product creates
    // its BrowserWindow during a slow cold start. Poll the live window list as
    // a race-free fallback while retaining the same bounded startup budget.
    const page = await waitForElectronWindow(desktop, 180_000);
    page.once("close", () => {
      appendDiagnosticEvent("playwright-page-close", { turnId: report.continuations.at(-1)?.nextTurn?.turnId || report.turns.at(-1)?.snapshot?.turn?.id || null });
      persistReport();
    });
    page.context().once("close", () => {
      appendDiagnosticEvent("playwright-context-close", { turnId: report.continuations.at(-1)?.nextTurn?.turnId || report.turns.at(-1)?.snapshot?.turn?.id || null });
      persistReport();
    });
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 180_000 });
    const runtimes = await retryEvaluate(() => page.evaluate(() => window.agentlas.runtime.detect(true)));
    const requestedRuntime = Array.isArray(runtimes)
      ? runtimes.find((candidate) => candidate.kind === requiredRuntimeKind && candidate.ready !== false) || null
      : null;
    assert.ok(requestedRuntime, `required runtime unavailable (${requiredRuntimeKind}): ${JSON.stringify(runtimes)}`);
    const selectedRuntimes = requestedRuntime.active ? runtimes : await page.evaluate((selection) => window.agentlas.runtime.setActive(selection), {
      kind: requestedRuntime.kind,
      backend: requestedRuntime.backend,
      source: requestedRuntime.source,
      ...(requestedRuntime.model ? { model: requestedRuntime.model } : {}),
      ...(typeof requestedRuntime.longContextEnabled === "boolean" ? { longContext: requestedRuntime.longContextEnabled } : {}),
    });
    const active = Array.isArray(selectedRuntimes) ? selectedRuntimes.find((candidate) => candidate.active) || null : null;
    assert.equal(active?.kind, requiredRuntimeKind, `runtime activation failed (${requiredRuntimeKind}): ${JSON.stringify(selectedRuntimes)}`);
    report.runtime = { id: active.id || null, kind: active.kind || null, backend: active.backend || null, model: active.model || null, source: active.source || null };
    trace("runtime:detected", report.runtime);

    await desktop.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      owner.setContentSize(1488, 986);
    });
    // Navigate through Playwright's page boundary so the owner renderer's old
    // execution context may disappear without also rejecting an Electron-main
    // evaluate that already started loadURL as a side effect. Wait for the host
    // document before polling the separately mounted Science child view.
    await page.goto("agentlas://app/science.html", { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => location.pathname.endsWith("/science.html"), null, { timeout: 180_000 });
    await waitForScienceView(desktop);
    recorder = await startScienceRecorder(desktop);
    await recorder.capture("science-library");
    trace("science:view-ready");
    const created = await createProject(desktop);
    assert.equal(created.created, true);
    await retryEvaluate(() => desktop.evaluate((_electron, projectId) => { globalThis.__agentlasDinosaurQaProjectId = projectId; }, created.projectEntry));
    const folderReady = await waitForProjectFolderReady(desktop);
    report.folder = { ...created, ...folderReady, screenshot: await captureScience(desktop, "project-folder-created.png") };
    await recorder.capture("project-folder-created");
    trace("project:folder-created", { projectId: created.projectEntry, folderState: folderReady.state });
    const opened = await openProjectWorkspace(desktop);
    assert.equal(opened.opened, true);
    await recorder.capture("workspace-opened");
    await sleep(250);
    let snapshot = await storeSnapshot(desktop, created.projectEntry);
    assert.ok(snapshot.project, `project did not persist: ${JSON.stringify(snapshot)}`);
    report.project = snapshot.project;
    assert.equal(snapshot.project.question, question, "persisted project question must exactly match the requested English question");
    const firstUserMessage = snapshot.messages.find((message) => message.role === "user") || null;
    assert.equal(firstUserMessage?.content, question, "first user message must exactly match the requested English question");
    report.promptBinding = { reportQuestion: question, projectQuestion: snapshot.project.question, firstUserMessage: firstUserMessage?.content || null, exactMatch: true };
    trace("prompt:exact-bound", { projectId: snapshot.project.id, exactMatch: true });
    if (!snapshot.turn) await sendInitialQuestion(desktop);

    let approvedContractReceipt = null;
    for (let index = 0; index < turnBudget; index += 1) {
      if (Date.now() >= totalDeadline) break;
      const deadline = Math.min(Date.now() + turnTimeoutMs, totalDeadline);
      let current = snapshot;
      let contractApproval = approvedContractReceipt;
      let lastCaptureAt = 0;
      let lastStatus = null;
      while (Date.now() < deadline) {
        current = await storeSnapshot(desktop, created.projectEntry);
        if (current.turn?.status !== lastStatus) {
          lastStatus = current.turn?.status || null;
          trace("turn:status", { ordinal: index + 1, status: lastStatus, invocationRunId: current.turn?.invocationRunId || null, runs: current.runs.length, executions: current.executions.length });
        }
        const visibleInteraction = await evaluateScience(desktop, `({
          contract: Boolean(document.querySelector('#research-contract-approval-form')),
          runtimeQuestion: Boolean(document.querySelector('[data-runtime-question-id]')),
          researchDecision: Boolean(document.querySelector('#research-decision-form'))
        })`).catch(() => ({ contract: false, runtimeQuestion: false, researchDecision: false }));
        if (Date.now() - lastCaptureAt >= 10_000 || visibleInteraction.contract || visibleInteraction.runtimeQuestion || visibleInteraction.researchDecision) {
          await recorder.capture(`turn-${index + 1}:${current.turn?.status || "none"}${visibleInteraction.runtimeQuestion ? ":runtime-question" : visibleInteraction.contract ? ":contract" : visibleInteraction.researchDecision ? ":decision" : ""}`);
          lastCaptureAt = Date.now();
          // Persist a bounded heartbeat together with the diagnostic timeline.
          // Completed turns are appended below, but a long-running runtime
          // turn must remain distinguishable from a stalled QA parent while it
          // is still producing events.
          report.activeTurn = {
            observedAt: new Date().toISOString(),
            ordinal: index + 1,
            turnId: current.turn?.id || null,
            status: current.turn?.status || null,
            invocationRunId: current.turn?.invocationRunId || null,
            runs: current.runs.length,
            executions: current.executions.length,
            runEvidence: current.runs.map((run) => run.qaEvidence),
          };
          persistReport();
        }
        // The store is the canonical persisted contract surface. Immediately
        // accept its approved state even if the renderer is still showing the
        // previous draft form; retrying that stale form adds a false 30-second
        // approval wait after the approval has already committed.
        if (!contractApproval && current.contract?.status === "approved") {
          contractApproval = contractReceiptFromSnapshot(current.contract);
          approvedContractReceipt = contractApproval;
          if (!report.approvals.some((approval) => approval.kind === "research-contract" && approval.id === contractApproval.id && approval.approved)) {
            report.approvals.push({ kind: "research-contract", at: new Date().toISOString(), ...contractApproval });
          }
          trace("contract:canonical-approved", { id: current.contract.id, version: current.contract.version });
        }
        // Contract approval is the one expected human receipt in this path.
        // Approve it as soon as the runtime has materialized the draft; waiting
        // until the turn deadline would leave a legitimate director turn
        // blocked forever and make the harness cancel the work it is meant to
        // observe.
        if (!contractApproval && current.contract?.status === "draft") {
          const attemptedApproval = await approveDraftContract(desktop, created.projectEntry)
            .catch((error) => ({ error: String(error) }));
          if (attemptedApproval?.approved) {
            contractApproval = attemptedApproval;
            approvedContractReceipt = attemptedApproval;
          }
          if (attemptedApproval?.clicked && !report.approvals.some((approval) => approval.kind === "research-contract" && approval.id === attemptedApproval.id)) {
            report.approvals.push({ kind: "research-contract", at: new Date().toISOString(), ...attemptedApproval });
          }
          trace("contract:ui-result", attemptedApproval || {});
        }
        const runtimeQuestion = await answerVisibleRuntimeQuestion(desktop).catch((error) => ({ error: String(error) }));
        if (runtimeQuestion) {
          const receipt = { at: new Date().toISOString(), ...runtimeQuestion };
          report.runtimeQuestions.push(receipt);
          if (runtimeQuestion.requestId) report.approvals.push({ kind: "runtime-tool", ...receipt });
          trace("runtime-question:ui-answer", receipt);
        }
        const decision = await answerVisibleResearchDecision(desktop, created.projectEntry).catch((error) => ({ error: String(error) }));
        if (decision) {
          const receipt = { at: new Date().toISOString(), ...decision };
          report.decisions.push(receipt);
          trace("research-decision:ui-answer", receipt);
        }
        if (current.turn && ["completed", "failed", "cancelled", "interrupted"].includes(current.turn.status)) {
          report.continuations.push({
            kind: "terminal-observed",
            at: new Date().toISOString(),
            ordinal: index + 1,
            turnId: current.turn.id,
            status: current.turn.status,
          });
          persistReport();
          break;
        }
        await sleep(750);
      }
      if (Date.now() >= totalDeadline) {
        report.timeout.workDeadlineReached = true;
        appendDiagnosticEvent("qa-work-deadline", { elapsedMs: Date.now() - startedAt });
        current = await storeSnapshot(desktop, created.projectEntry).catch(() => current);
        const contract = contractApproval || contractReceiptFromSnapshot(current.contract);
        if (contract?.approved) approvedContractReceipt = contract;
        report.turns.push({ ordinal: index + 1, screenshot: null, snapshot: current, contract, decisions: [], timedOut: true });
        report.activeTurn = null;
        snapshot = current;
        trace("turn:work-deadline", { ordinal: index + 1, status: current.turn?.status || null, runs: current.runs.length, executions: current.executions.length });
        persistReport();
        break;
      }
      const turnDeadlineReached = Date.now() >= deadline;
      const turnReachedTerminalState = Boolean(current.turn
        && ["completed", "failed", "cancelled", "interrupted"].includes(current.turn.status));
      const turnTimedOut = turnDeadlineReached && !turnReachedTerminalState;
      if (turnTimedOut) {
        appendDiagnosticEvent("qa-turn-deadline", {
          reason: "turn-timeout",
          ordinal: index + 1,
          turnId: current.turn?.id || null,
          status: current.turn?.status || null,
          elapsedMs: Date.now() - startedAt,
        });
      }
      const screenshot = await captureScience(desktop, `turn-${String(index + 1).padStart(2, "0")}.png`);
      await recorder.capture(`turn-${index + 1}:terminal`);
      const contract = contractApproval || contractReceiptFromSnapshot(current.contract)
        || await approveDraftContract(desktop, created.projectEntry).catch((error) => ({ error: String(error) }));
      if (contract?.approved) {
        approvedContractReceipt = contract;
        if (contract.clicked && !report.approvals.some((approval) => approval.kind === "research-contract" && approval.id === contract.id)) {
          report.approvals.push({ kind: "research-contract", at: new Date().toISOString(), ...contract });
        }
      }
      const decisions = await listPendingDecisions(desktop, created.projectEntry).catch((error) => [{ error: String(error) }]);
      const turn = { ordinal: index + 1, screenshot, snapshot: current, contract, decisions, timedOut: turnTimedOut };
      report.turns.push(turn);
      report.activeTurn = null;
      trace("turn:recorded", { ordinal: index + 1, status: current.turn?.status || null, runs: current.runs.length, executions: current.executions.length, manuscripts: current.manuscripts.length });
      snapshot = current;
      if (!current.turn || current.turn.status !== "completed") break;
      if (index + 1 >= turnBudget) break;
      const previousTurnId = current.turn.id;
      const continuation = {
        kind: "follow-up",
        ordinal: index + 2,
        previousTurnId,
        nudgeRequestedAt: new Date().toISOString(),
        nudgeReceipt: null,
        nextTurnWaitStartedAt: null,
        nextTurn: null,
        error: null,
      };
      report.continuations.push(continuation);
      persistReport();
      try {
        continuation.nudgeReceipt = { at: new Date().toISOString(), ...await sendNudge(desktop, nudge) };
      } catch (error) {
        continuation.error = { stage: "send-nudge", message: error instanceof Error ? error.message : String(error) };
        persistReport();
        throw error;
      }
      await recorder.capture(`turn-${index + 2}:nudge-sent`);
      trace("turn:nudge-sent", { nextOrdinal: index + 2 });
      continuation.nextTurnWaitStartedAt = new Date().toISOString();
      persistReport();
      try {
        snapshot = await waitForNextTurn(desktop, created.projectEntry, previousTurnId, Math.min(60_000, Math.max(1, totalDeadline - Date.now())));
        continuation.nextTurn = { at: new Date().toISOString(), turnId: snapshot.turn.id, status: snapshot.turn.status };
        persistReport();
      } catch (error) {
        continuation.error = { stage: "wait-next-turn", message: error instanceof Error ? error.message : String(error) };
        persistReport();
        throw error;
      }
      trace("turn:created", { ordinal: index + 2, previousTurnId, turnId: snapshot.turn.id, status: snapshot.turn.status });
    }

    // The runtime persists canonical ResearchRuns even when a tool execution
    // projection has not yet been emitted for the current invocation. Observe
    // both surfaces so the QA result reflects the work the product actually
    // committed, not only the optional projection table.
    const observedRunToolIds = report.turns.flatMap((turn) => turn.snapshot.runs.map((run) => run.toolId));
    const observedExecutionToolIds = report.turns.flatMap((turn) => turn.snapshot.executions.map((execution) => execution.toolId));
    const allToolIds = [...new Set([...observedExecutionToolIds, ...observedRunToolIds])];
    const allRuns = report.turns.at(-1)?.snapshot.runs || [];
    const allManuscripts = report.turns.at(-1)?.snapshot.manuscripts || [];
    const requiredToolAliases = {
      search_paleontology_occurrences: ["search_paleontology_occurrences", "agentlas.pbdb-taxon-occurrences"],
      analyze_paleontology_stratigraphic_support: ["analyze_paleontology_stratigraphic_support", "agentlas.paleontology-stratigraphic-support"],
      build_extant_reference_assembly_manifest: ["build_extant_reference_assembly_manifest", "agentlas.extant-reference-assembly-manifest"],
      build_comparative_genomics_gene_tree: ["build_comparative_genomics_gene_tree", "agentlas.comparative-genomics-gene-tree"],
      run_hypothetical_asr_fitch: ["run_hypothetical_asr_fitch", "agentlas.comparative-genomics-hypothetical-fitch-asr"],
      materialize_extant_archosaur_locus_panel: ["materialize_extant_archosaur_locus_panel", "agentlas.materialize-extant-archosaur-locus-panel"],
      assess_deextinction_feasibility: ["assess_deextinction_feasibility", "agentlas.paleontology-deextinction-feasibility"],
    };
    const requiredTools = Object.keys(requiredToolAliases);
    const observedRequired = requiredTools.filter((toolId) => requiredToolAliases[toolId].some((alias) => allToolIds.includes(alias)));
    const finalSnapshot = report.turns.at(-1)?.snapshot || snapshot;
    const finalAssistant = finalSnapshot.messages.find((message) => message.id === finalSnapshot.assistantMessageId) || null;
    const runtimeChildKindsObserved = [...new Set(readDiagnosticTimeline()
      .filter((event) => event.event === "runtime-child-observed")
      .map((event) => event.executable === "claude" ? "claude-code" : event.executable)
      .filter(Boolean))];
    const unexpectedRuntimeChildKinds = runtimeChildKindsObserved.filter((kind) => kind !== requiredRuntimeKind);
    if (allManuscripts.length >= 1) {
      await recorder.capture("manuscript-before-pdf-export");
      trace("pdf:ui-export-start");
      report.pdf = await exportManuscriptPdfThroughUi(desktop, created.projectEntry);
      await recorder.capture("manuscript-after-pdf-export");
      trace("pdf:ui-export-finished", { status: report.pdf?.download?.status || null, bytes: report.pdf?.bytes || 0 });
    }
    report.video = await recorder.stop();
    recorder = null;
    trace("video:encoded", { frames: report.video.frameCount, bytes: report.video.bytes, exitCode: report.video.ffmpegExit?.code });
    report.artifactVerification = verifyOutputArtifacts(report.pdf, report.video);
    const pdfVerified = Boolean(report.pdf?.download?.status === "completed" && report.pdf.exists && report.pdf.bytes > 0
      && report.pdf.sha256 && report.artifactVerification?.pdf?.header === "%PDF-" && report.artifactVerification.pdf.textBytes > 0
      && report.artifactVerification.pdf.renderedPageBytes > 0);
    const videoVerified = Boolean(report.video?.ffmpegExit?.code === 0 && report.video.bytes > 0 && report.video.sha256
      && Number(report.artifactVerification?.video?.format?.duration) > 0 && report.artifactVerification?.video?.streams?.[0]?.codec_name === "h264");
    report.assertions = {
      actualElectron: true,
      signedScienceExtension: true,
      realRuntimeDetected: Boolean(report.runtime),
      runtimeChildKindsObserved,
      unexpectedRuntimeChildKinds,
      selectedRuntimeIsolationVerified: unexpectedRuntimeChildKinds.length === 0,
      promptCreatedProject: Boolean(report.project?.id),
      exactEnglishQuestionBound: report.promptBinding?.exactMatch === true,
      projectFolderShownBeforeWorkspace: report.folder?.folderState === "empty" && Boolean(report.folder?.screenshot),
      researchDirectorConversationCompletedAtLeastOneTurn: report.turns.some((turn) => turn.snapshot.turn?.status === "completed"),
      observedScienceToolIds: allToolIds,
      requiredToolIdsObserved: observedRequired,
      missingRequiredToolIds: requiredTools.filter((toolId) => !observedRequired.includes(toolId)),
      providerRunsObserved: allRuns.length,
      manuscriptRecordsObserved: allManuscripts.length,
      pdfVerified,
      videoVerified,
      comparativeProxyBoundaryInAssistant: Boolean(finalAssistant && /comparative|proxy|프록시|비교/i.test(finalAssistant.content)),
      biologicalRevivalClaimNotAsserted: Boolean(finalAssistant && !/성공적으로 부활|실제 부화 완료|successfully revived|hatched successfully/i.test(finalAssistant.content)),
      noHorizontalOverflow: await evaluateScience(desktop, "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1").catch(() => false),
      completedFullDinosaurChain: unexpectedRuntimeChildKinds.length === 0 && requiredTools.every((toolId) => observedRequired.includes(toolId)) && allManuscripts.length >= 1 && pdfVerified && videoVerified,
    };
    report.elapsedMs = Date.now() - startedAt;
    persistReport();
    console.log(JSON.stringify(report, null, 2));
    // This is an evidence harness, so a missing chain is a product finding, not
    // a harness crash. The report remains machine-readable for the next loop.
    process.exitCode = report.assertions.completedFullDinosaurChain ? 0 : 2;
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error);
    report.failure = { message: failureMessage, stack: error instanceof Error ? error.stack : null };
    if (desktop && !/Target page, context or browser has been closed|Target closed/iu.test(failureMessage)) {
      report.failure.screenshot = await captureScience(desktop, "failure.png").catch(() => null);
    }
    if (recorder) {
      report.video = await recorder.stop().catch((videoError) => ({ error: String(videoError) }));
      recorder = null;
    }
    report.elapsedMs = Date.now() - startedAt;
    persistReport();
    throw error;
  } finally {
    markHarnessCloseRequested("finally");
    persistReport();
    await closeDesktop(desktop);
    report.elapsedMs = Date.now() - startedAt;
    persistReport();
    if (process.env.AGENTLAS_DINOSAUR_KEEP_QA_ROOT !== "1") {
      fs.rmSync(qaRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    clearTimeout(hardDeadlineTimer);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  },
);
