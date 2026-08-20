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
import { spawnSync } from "node:child_process";
import { app } from "electron";

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
  try {
    candidates.push(path.join(app.getAppPath(), "build-resources", "python-runtime", ...rel));
  } catch {
    /* app 미가용(테스트) */
  }
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

/**
 * uvx 가 없으면 번들 파이썬으로 한 번 설치한다. 성공하면 그 bin 디렉터리를 돌려준다.
 *
 * 돌려주는 값은 **PATH 에 앞세울 디렉터리**이거나 null 이다. null 은 "마련하지 못했다"는
 * 뜻이고, 그때는 원래대로 사용자 PATH 에 기대는 것 말고 할 수 있는 일이 없다 — 조용히
 * 성공한 척하지 않는다.
 */
export function ensureUvx(currentPath: string): string | null {
  if (uvxOnPath(currentPath)) return null; // 이미 있다. 우리 것을 끼워 넣지 않는다.
  if (exists(path.join(uvBinDir(), process.platform === "win32" ? "uvx.exe" : "uvx"))) {
    return uvBinDir();
  }
  if (installAttempted) return null; // 한 번 실패했으면 서버를 띄울 때마다 재시도하지 않는다.
  installAttempted = true;

  const python = bundledPython();
  if (!python) return null;
  try {
    fs.mkdirSync(uvHome(), { recursive: true });
    const result = spawnSync(
      python,
      ["-m", "pip", "install", "--quiet", "--upgrade", "--target", uvHome(), "uv"],
      { encoding: "utf8", timeout: 5 * 60 * 1000 },
    );
    if (result.status !== 0) {
      console.warn("[uv] could not provision uv:", (result.stderr || "").split("\n")[0]);
      return null;
    }
  } catch (error) {
    console.warn("[uv] could not provision uv:", error instanceof Error ? error.message : error);
    return null;
  }
  return exists(path.join(uvBinDir(), process.platform === "win32" ? "uvx.exe" : "uvx"))
    ? uvBinDir()
    : null;
}

/**
 * uvx 로 도는 서버를 띄우기 직전에 PATH 를 보강한다. uvx 를 쓰지 않는 명령에는 아무 일도
 * 하지 않는다 — 설치 비용을 그 서버들에까지 물리지 않기 위해서다.
 */
export function withUvxPath(command: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (command !== "uvx" && command !== "uv") return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  const dir = ensureUvx(current);
  if (!dir) return env;
  return { ...env, [key]: [dir, current].filter(Boolean).join(path.delimiter) };
}
