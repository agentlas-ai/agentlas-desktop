// 런타임 경로의 **단일 출처** — 데몬 추출(Phase 1)의 첫 관문.
//
// ★왜 있나. `app.getPath("userData")` 가 45개 파일에 흩어져 있고, 그 한 줄이
// **Electron 을 필수로 만든다.** 데몬(`agentlasd`)은 Electron 없이 도는 Node 프로세스라
// 그 호출이 남아 있는 모듈은 데몬으로 옮길 수 없다. 즉 이 45곳이 Phase 1 의 실제 벽이다.
//
// 터미널이 이미 같은 문제를 풀어 뒀다(`desktop-core.cjs` 가 코어를 Electron 없이
// 로드하려고 경로를 손으로 계산한다) — 그건 이 계층이 없어서 생긴 사본이다. 여기로
// 모으면 그 사본도 사라진다(Phase 3).
//
// 규칙:
//  - Electron 안에서는 `app.getPath("userData")` 가 정답이다. 그대로 쓴다.
//  - Electron 이 없으면(데몬·터미널·테스트) 주입된 경로를 쓴다.
//  - **둘 다 없으면 던진다.** 조용히 홈 밑 아무 데나 만들면, 사용자의 실제 데이터와
//    다른 DB 를 열어 놓고 "비어 있다" 고 말하는 사고가 난다.
import path from "node:path";

let injectedUserDataDir: string | null = null;

/**
 * Electron 밖에서 도는 호스트(데몬·터미널·테스트)가 부팅 시 한 번 부른다.
 * Electron 안에서는 부를 필요가 없다 — `app.getPath` 가 이미 정답이다.
 */
export function setUserDataDir(dir: string): void {
  const value = dir?.trim();
  if (!value) throw new Error("setUserDataDir: an empty path is not a user data directory");
  if (!path.isAbsolute(value)) throw new Error(`setUserDataDir: expected an absolute path, got ${value}`);
  injectedUserDataDir = value;
  /*
   * 사이언스는 이제 자기 저장소에 살고 데이터 폴더를 호스트에게 묻는다. 호스트를 통째로
   * 설치하지 않는 자리(계약 검사기)는 이 함수만 부르므로, 여기서 그쪽에도 알려 준다.
   * 사이언스가 아직 설치되지 않은 설치본에서는 조용히 넘어간다.
   */
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("agentlas-science") as { setScienceUserDataDir?: (dir: string) => void })
      .setScienceUserDataDir?.(value);
  } catch { /* 사이언스 없음 */ }
}

/** 주입된 값이 있는가 — 진단·테스트용. 없다고 Electron 이 없다는 뜻은 아니다. */
export function hasInjectedUserDataDir(): boolean {
  return injectedUserDataDir !== null;
}

/**
 * Whether this host must follow packaged-app storage rules.
 *
 * The packaged daemon runs with `ELECTRON_RUN_AS_NODE=1`, so requiring Electron
 * there throws even though the process belongs to an installed app. An injected
 * app user-data directory is the daemon's explicit ownership proof and therefore
 * implies packaged semantics. Regular Electron development still reads the real
 * `app.isPackaged` value.
 */
export function isPackagedRuntime(): boolean {
  if (injectedUserDataDir) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { isPackaged?: boolean } };
    return electron?.app?.isPackaged ?? true;
  } catch {
    return true;
  }
}

/** Optional GUI app root. Headless helpers use resourcesPath/injected paths. */
export function optionalElectronAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getAppPath?: () => string } };
    return electron?.app?.getAppPath?.() ?? null;
  } catch {
    return null;
  }
}

/** Version metadata for headless protocol clients; GUI Electron remains authoritative. */
export function electronAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getVersion?: () => string } };
    return electron?.app?.getVersion?.() || process.env.npm_package_version || "0.0.0";
  } catch {
    return process.env.npm_package_version || "0.0.0";
  }
}

/**
 * 이 프로세스의 사용자 데이터 디렉터리.
 *
 * Electron 이 있으면 그 값이 이긴다 — 앱이 실제로 여는 곳이 거기이고, 주입값이
 * 앱을 이기면 같은 머신에서 두 개의 DB 가 생긴다.
 */
export function userDataDir(): string {
  // require 를 지연시킨다: 데몬에는 electron 모듈 자체가 없다.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getPath?: (name: string) => string } };
    const fromApp = electron?.app?.getPath?.("userData");
    if (fromApp) return fromApp;
  } catch {
    /* Electron 없음 — 아래 주입값으로 */
  }
  if (injectedUserDataDir) return injectedUserDataDir;
  throw new Error(
    "userDataDir: no Electron app and no injected path. A host running outside Electron must call setUserDataDir() before touching the store.",
  );
}

/** userData 아래 경로. `path.join(userDataDir(), ...)` 를 45곳에서 반복하지 않기 위해. */
export function userDataPath(...segments: string[]): string {
  return path.join(userDataDir(), ...segments);
}
