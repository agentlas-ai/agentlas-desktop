// 자동 업데이트 — electron-updater 래퍼.
// production에서만 동작. dev 환경에선 dev-app-update.yml이 없으면 throw하므로 skip.
//
// 흐름 (Claude Code / Codex 데스크톱과 동일 패턴):
//   1. 앱 시작 후 N초 뒤 checkForUpdates() — 트래픽 부담 최소화
//   2. 주기적으로 (1시간마다) 재확인
//   3. update-available  → 자동 다운로드 (electron-updater 기본값)
//   4. download-progress → renderer에 broadcast (%)
//   5. update-downloaded → renderer에 "재시작 업데이트" 배지 노출
//   6. 사용자가 클릭 → quitAndInstall()
//
// publish 채널은 electron-builder.yml의 publish:github 그대로.
// 사용자 토큰 없이도 public release면 동작.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { compareSemVer, parseSemVer } from "../shared/semver";

// electron-updater는 main 프로세스 ESM 호환 모듈. import는 CJS interop으로.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간
const INITIAL_DELAY_MS = 15 * 1000; // 15초

export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "not-available"
    | "error";
  /** update-available / update-downloaded 시 채워짐 */
  version?: string;
  /** download-progress의 백분율 (0-100). downloading 상태일 때만 의미 있음 */
  progress?: number;
  error?: string;
}

let timer: NodeJS.Timeout | null = null;
let currentState: UpdateState = { status: "idle" };

/** main → renderer로 상태 broadcast. all-windows에 동시 전송 (창이 여러 개 열려 있어도 동기화). */
function broadcast(state: UpdateState): void {
  currentState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send("updater:state", state);
  }
}

export function getUpdaterState(): UpdateState {
  return currentState;
}

function isNewerThanCurrent(version: string | undefined): boolean {
  const comparison = compareSemVer(version, app.getVersion());
  return comparison !== null && comparison > 0;
}

function updateConfigPath(): string {
  return path.join(process.resourcesPath, "app-update.yml");
}

function hasBundledUpdateConfig(): boolean {
  try {
    return fs.existsSync(updateConfigPath());
  } catch {
    return false;
  }
}

function markUpdateConfigMissing(): void {
  console.warn(`[updater] app-update.yml missing — skipping auto-update for this local build (${updateConfigPath()})`);
  broadcast({ status: "not-available" });
}

function pendingUpdateDir(): string | null {
  if (process.platform !== "darwin") return null;
  return path.join(app.getPath("home"), "Library", "Caches", "agentlas-desktop-updater", "pending");
}

function pendingUpdateVersion(pendingDir: string): string | null {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(pendingDir, "update-info.json"), "utf8"));
    const fileName = typeof payload.fileName === "string" ? payload.fileName : "";
    const match = fileName.match(/Agentlas-(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-(?:arm64|x64)/);
    const candidate = match?.[1] ?? null;
    return candidate && parseSemVer(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function pruneStalePendingUpdate(): void {
  const pendingDir = pendingUpdateDir();
  if (!pendingDir || !fs.existsSync(pendingDir)) return;
  const pendingVersion = pendingUpdateVersion(pendingDir);
  if (!pendingVersion || isNewerThanCurrent(pendingVersion)) return;
  try {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    console.log(`[updater] removed stale pending update v${pendingVersion}; current is v${app.getVersion()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[updater] failed to remove stale pending update", message);
  }
}

/**
 * production에서 호출. dev에서는 dev-app-update.yml이 없으면 throw하므로 NODE_ENV check 후 skip.
 */
export function initAutoUpdater(): void {
  if (process.env.NODE_ENV === "development") {
    console.log("[updater] dev mode — skipping auto-update");
    return;
  }
  // QA 모드(별도 userData) — Playwright/release 검증용 빌드는 자동 업데이트 비활성.
  if (process.env.AGENTLAS_QA_USER_DATA_DIR?.trim()) {
    console.log("[updater] QA mode — skipping auto-update");
    return;
  }
  if (!hasBundledUpdateConfig()) {
    markUpdateConfigMissing();
    return;
  }

  pruneStalePendingUpdate();

  // 사용자 동의 없이 자동 다운로드. 설치는 사용자가 "재시작 업데이트"를 눌렀을 때만
  // 진행한다. autoInstallOnAppQuit=true면 root-owned /Applications 앱에서
  // 종료할 때마다 ShipIt 권한 프롬프트가 반복될 수 있다.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    broadcast({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    broadcast({ status: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    // idle로 되돌리지 않고 not-available로 한 번 알린 뒤 idle. UI는 노출 안 함.
    broadcast({ status: "not-available" });
  });

  autoUpdater.on("download-progress", (p) => {
    broadcast({
      status: "downloading",
      progress: Math.round(p.percent),
      version: currentState.version,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    if (!isNewerThanCurrent(info.version)) {
      pruneStalePendingUpdate();
      broadcast({ status: "not-available" });
      return;
    }
    broadcast({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[updater] error", message);
    broadcast({ status: "error", error: message });
  });

  // 첫 체크는 시작 직후가 아니라 약간 늦춰 — 첫 윈도우 렌더 끝난 뒤
  setTimeout(() => {
    void checkSafely();
  }, INITIAL_DELAY_MS);

  // 주기적 재확인 — 앱이 며칠씩 켜져 있을 수 있으므로
  timer = setInterval(() => {
    void checkSafely();
  }, CHECK_INTERVAL_MS);
  // 이 타이머만으로 이벤트루프를 붙잡아 종료를 막지 않게(automation-scheduler 패턴과 동일).
  if (timer.unref) timer.unref();
}

export function disposeAutoUpdater(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 사용자가 "지금 확인" 버튼을 누르거나 메뉴에서 호출. 실패해도 throw 안 함 (에러는 broadcast로). */
export async function checkSafely(): Promise<void> {
  try {
    if (!hasBundledUpdateConfig()) {
      markUpdateConfigMissing();
      return;
    }
    pruneStalePendingUpdate();
    await autoUpdater.checkForUpdates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[updater] checkForUpdates failed", message);
    broadcast({ status: "error", error: message });
  }
}

/** "재시작 업데이트" 버튼 핸들러. 다운로드 완료된 상태에서만 호출되어야 함. */
export function quitAndInstall(): void {
  if (currentState.status !== "downloaded") {
    console.warn("[updater] quitAndInstall called but no update downloaded");
    return;
  }
  if (!isNewerThanCurrent(currentState.version)) {
    pruneStalePendingUpdate();
    broadcast({ status: "not-available" });
    console.warn("[updater] quitAndInstall ignored because downloaded version is not newer than current");
    return;
  }
  // isSilent=false: 사용자에게 macOS 표준 설치 progress가 보임
  // isForceRunAfter=true: 설치 후 자동 재실행
  autoUpdater.quitAndInstall(false, true);
}
