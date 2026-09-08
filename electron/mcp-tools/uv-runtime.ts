// `uvx` 를 앱이 직접 마련한다.
//
// ★왜 (2026-08-20 카탈로그 전수 감사): 허브 플러그인 113개 중 13개가 `uvx <패키지>` 로
// 도는 **공식 벤더 서버**다(Grafana·Redis·Snowflake·PagerDuty·ElevenLabs·Qdrant 등).
// 그런데 이 저장소 어디에도 uv 를 마련하는 코드가 없었다 — 사용자가 직접 uv 를 깔아 두지
// 않았으면 그 13개는 전부 "연결 실패"로 끝난다. 오너 머신에 homebrew uv 가 있어서 개발 중엔
// 보이지 않던 결함이다(pipx 는 그 머신에도 없었다).
//
// 왜 npm 대체 패키지로 갈아타지 않았나: 검색해 보면 같은 이름의 npm 패키지가 나오지만 전부
// 출처 불명의 개인 포크다. 사용자의 자격증명을 넘길 서버를 그런 것으로 바꾸는 편이 훨씬 나쁘다.
//
// 왜 빌드에 바이너리를 더하지 않았나: 그러면 서명·공증 대상이 늘고 플랫폼별 산출물이 갈린다.
// uv 는 PyPI 휠 안에 바이너리를 싣고 있어, **이미 번들된 파이썬**으로 한 번 설치하면 끝난다
// (실측: `pip install --target` 후 bin/uvx 가 나오고, `uvx pagerduty-mcp` 로 공식 서버가 떴다).
//
// 경계
//   · 사용자 시스템 PATH 를 건드리지 않는다. 우리 디렉터리에만 놓고 우리가 띄우는 프로세스의
//     PATH 앞에 붙인다.
//   · 사용자가 이미 uv 를 갖고 있으면 그것을 쓴다(우리 것을 강요하지 않는다).
//   · 설치는 **필요할 때 한 번**만 — uvx 를 쓰는 서버를 처음 띄울 때다. 앱 시작을 늦추지 않는다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { detachedSpawnOpts, killCliTree } from "../runtime/exec";
import { optionalElectronAppPath } from "../runtime-paths";

/** 우리가 마련한 uv 가 사는 곳. 사용자 홈 밑, 우리 이름 아래. */
function uvHome(): string {
  return path.join(os.homedir(), ".agentlas", "uv");
}

function uvBinDir(): string {
  return path.join(uvHome(), "bin");
}

function exists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/** 번들된 standalone Python(있으면). hephaestus/engine.ts 와 같은 자리를 본다. */
function bundledPython(): string | null {
  const rel = process.platform === "win32" ? ["python.exe"] : ["bin", "python3"];
  const candidates: string[] = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "python-runtime", ...rel));
  const appPath = optionalElectronAppPath();
  if (appPath) candidates.push(path.join(appPath, "build-resources", "python-runtime", ...rel));
  // app.getAppPath() 만 믿으면 안 된다 — 그 값은 **진입 스크립트가 있는 곳**이라 개발 중
  // 저장소 안의 다른 스크립트로 들어오면 저장소 루트가 아니다(게이트가 이걸로 실패해서 알았다).
  // 이 모듈은 자기가 어디 있는지 안다: dist/electron/mcp-tools/ → 세 칸 위가 저장소 루트다.
  candidates.push(path.join(__dirname, "..", "..", "..", "build-resources", "python-runtime", ...rel));
  return candidates.find(exists) ?? null;
}

/** 이 PATH 에서 uvx 를 찾을 수 있는가 — 사용자가 이미 갖고 있으면 그것을 쓴다. */
function uvxOnPath(searchPath: string): boolean {
  const exe = process.platform === "win32" ? "uvx.exe" : "uvx";
  return searchPath.split(path.delimiter).some((dir) => dir && exists(path.join(dir, exe)));
}

let installAttempted = false;
type InstallJob = { controller: AbortController; promise: Promise<string | null>; waiters: Set<symbol> };
let installJob: InstallJob | null = null;

export interface UvxPreparationOptions { signal?: AbortSignal; timeoutMs?: number }

function aborted(): Error { return new Error("uv_bootstrap_aborted"); }

function preparedUvxBin(): string | null {
  const executable = process.platform === "win32" ? "uvx.exe" : "uvx";
  // Pre-existing installations keep their original authority. New jobs never
  // write to this legacy directory before completing.
  if (exists(path.join(uvBinDir(), executable))) return uvBinDir();
  try {
    const receiptPath = path.join(uvHome(), "prepared.json");
    if (fs.statSync(receiptPath).size > 1_024) return null;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { directory?: unknown };
    if (typeof receipt.directory !== "string" || !/^runtime-[A-Za-z0-9_-]+$/.test(receipt.directory)) return null;
    const directory = path.join(uvHome(), receipt.directory);
    const bin = path.join(directory, "bin");
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) return null;
    const stat = fs.lstatSync(path.join(bin, executable));
    return stat.isFile() && !stat.isSymbolicLink() ? bin : null;
  } catch { return null; }
}

async function installUvx(signal: AbortSignal): Promise<string | null> {
  const python = bundledPython();
  if (!python) return null;
  await fs.promises.mkdir(uvHome(), { recursive: true });
  if (signal.aborted) throw aborted();
  let ownedDirectory = await fs.promises.mkdtemp(path.join(uvHome(), ".install-"));
  const receiptTemp = `${ownedDirectory}.json`;
  let published = false;
  try {
    if (signal.aborted) throw aborted();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(python,
        ["-m", "pip", "install", "--quiet", "--upgrade", "--target", ownedDirectory, "uv"],
        { stdio: "ignore", windowsHide: true, ...detachedSpawnOpts() });
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (process.platform === "win32" && child.pid && child.exitCode == null) {
          // Only this still-owned installer child, never an inventory-selected PID.
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
          killer.once("error", () => { try { child.kill(); } catch {} });
        } else killCliTree(child, 500);
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const cleanup = () => signal.removeEventListener("abort", stop);
      child.once("error", (error) => { cleanup(); reject(signal.aborted ? aborted() : error); });
      child.once("close", (status) => { cleanup(); resolve(status); });
    });
    if (signal.aborted) throw aborted();
    if (code !== 0) { console.warn("[uv] provisioning failed", { code }); return null; }
    const executable = path.join(ownedDirectory, "bin", process.platform === "win32" ? "uvx.exe" : "uvx");
    const stat = await fs.promises.lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const destination = path.join(uvHome(), `runtime-${path.basename(ownedDirectory).slice(".install-".length)}`);
    if (signal.aborted) throw aborted();
    await fs.promises.rename(ownedDirectory, destination);
    ownedDirectory = destination;
    await fs.promises.writeFile(receiptTemp, JSON.stringify({ directory: path.basename(destination) }), { flag: "wx", mode: 0o600 });
    if (signal.aborted) throw aborted();
    // A complete pip exit plus validated executable is atomically published.
    await fs.promises.rename(receiptTemp, path.join(uvHome(), "prepared.json"));
    published = true;
    return path.join(destination, "bin");
  } finally {
    await fs.promises.rm(receiptTemp, { force: true }).catch(() => {});
    if (!published) await fs.promises.rm(ownedDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Async single flight: cancelling one caller never cancels another live waiter. */
export async function ensureUvx(currentPath: string, options: UvxPreparationOptions = {}): Promise<string | null> {
  if (options.signal?.aborted) throw aborted();
  if (uvxOnPath(currentPath)) return null;
  // Do not consume a partially installed executable while pip is still running.
  if (installJob?.controller.signal.aborted) {
    throw new Error("uv_bootstrap_stopping");
  }
  if (!installJob) {
    const prepared = preparedUvxBin();
    if (prepared) return prepared;
    if (installAttempted) return null;
    const controller = new AbortController();
    const job: InstallJob = { controller, waiters: new Set(), promise: Promise.resolve(null) };
    installJob = job;
    job.promise = installUvx(controller.signal).catch((error) => {
      if (controller.signal.aborted) throw error;
      console.warn("[uv] provisioning unavailable");
      return null;
    }).finally(() => {
      if (!controller.signal.aborted) installAttempted = true;
      if (installJob === job) installJob = null;
    });
  }
  const job = installJob;
  const token = Symbol();
  job.waiters.add(token);
  let timer: NodeJS.Timeout | undefined;
  let detach = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => reject(aborted());
    options.signal?.addEventListener("abort", stop, { once: true });
    detach = () => options.signal?.removeEventListener("abort", stop);
    timer = setTimeout(() => reject(new Error("uv_bootstrap_timeout")), Math.max(1, Math.min(options.timeoutMs ?? 45_000, 45_000)));
    if (options.signal?.aborted) stop();
  });
  try { return await Promise.race([job.promise, cancelled]); }
  finally {
    if (timer) clearTimeout(timer);
    detach();
    job.waiters.delete(token);
    if (installJob === job && job.waiters.size === 0) job.controller.abort();
  }
}

/** Only uv/uvx commands pay the asynchronous bootstrap cost. */
export async function withUvxPath(command: string, env: NodeJS.ProcessEnv, options: UvxPreparationOptions = {}): Promise<NodeJS.ProcessEnv> {
  if (options.signal?.aborted) throw aborted();
  if (command !== "uvx" && command !== "uv") return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  const dir = await ensureUvx(current, options);
  if (!dir) return env;
  return { ...env, [key]: [dir, current].filter(Boolean).join(path.delimiter) };
}
