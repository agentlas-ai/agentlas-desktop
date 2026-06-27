// Startup Founder Studio — 패키지의 실제 GUI 를 앱 안에서 그대로 구동.
//
// 재구현하지 않는다. 스튜디오 패키지(studio-pack/)의 자체 런처 scripts/open-studio-gui.py 를
// spawn 하면, 그 런처가 실제 SPA(web/dist) 를 서빙하고 /__studio/* 로 엔진에 브리지한다.
// 렌더러는 이 로컬 URL 을 <iframe> 으로 띄운다 → 진짜 스튜디오가 그대로 앱 안에서 돈다.
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app, session } from "electron";
import type { ChildProcess } from "node:child_process";
import { withCliPath } from "../runtime/exec";
import { resolveHephaestusPython } from "./engine";

let cachedRoot: string | null | undefined;
let proc: ChildProcess | null = null;
let activeUrl: string | null = null;
let mediaGuardInstalled = false;

/** 임베드된 스튜디오 SPA 가 init 시 참조하는 죽은 외부 데모 미디어(cdn.pixabay.com 배경 영상)를
 *  차단해 404 노이즈를 없앤다. 폰트 CDN(jsdelivr/googleapis)·로컬 서버·생성 콘텐츠는 영향 없음
 *  (생성물은 외부 CDN 미사용 규약). 기존 webRequest 핸들러는 없으므로 충돌 없음. */
function installStudioMediaGuard(): void {
  if (mediaGuardInstalled) return;
  mediaGuardInstalled = true;
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://cdn.pixabay.com/*"] }, (_d, cb) =>
      cb({ cancel: true }),
    );
  } catch {
    /* noop */
  }
}

/** studio-pack 루트(런처 + web/dist 포함). dev/packaged. */
export function studioRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const candidates: string[] = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "studio-pack"));
  try {
    candidates.push(path.join(app.getAppPath(), "studio-pack"));
  } catch {
    /* noop */
  }
  candidates.push(path.join(__dirname, "..", "..", "..", "studio-pack"));
  candidates.push(path.join(process.cwd(), "studio-pack"));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, "scripts", "open-studio-gui.py"))) {
        cachedRoot = path.resolve(c);
        return cachedRoot;
      }
    } catch {
      /* 다음 후보 */
    }
  }
  cachedRoot = null;
  return null;
}

/**
 * 쓰기 가능한 로컬 런타임 루트(userData)를 보장한다. 번들 팩은 프로덕션에서 read-only(resourcesPath)
 * 이고, 런처는 root/.studio-runtime 에 생성물(studio-data.json, artifacts)을 쓴다. 그래서 번들을
 * userData 로 한 번 복사하고 거기서 구동한다 → (1) 모든 앱 데이터가 로컬(userData)에 저장되고,
 * (2) .studio-runtime 을 번들에 포함하지 않으므로 데모/목업 없이 블랭크로 시작한다(런처가 {} 서빙 → 아이디어 히어로).
 */
function ensureWritablePack(bundled: string): string {
  let userDataDir: string;
  try {
    userDataDir = app.getPath("userData");
  } catch {
    return bundled; // app 미가용(테스트 등) — 번들(dev 경로) 그대로.
  }
  const dest = path.join(userDataDir, "startup-studio");
  const destLauncher = path.join(dest, "scripts", "open-studio-gui.py");
  let needCopy = !fs.existsSync(destLauncher);
  if (!needCopy) {
    try {
      // 번들 매니페스트가 더 새로우면(앱 업데이트) 재복사.
      if (fs.statSync(path.join(bundled, "manifest.json")).mtimeMs > fs.statSync(path.join(dest, "manifest.json")).mtimeMs) {
        needCopy = true;
      }
    } catch {
      /* 비교 실패 시 기존 사용 */
    }
  }
  if (needCopy) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(bundled, dest, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          // 생성물/의존성/소스/git 제외 — 데모 상태가 따라오지 않게 .studio-runtime 도 제외.
          if (base === ".studio-runtime" || base === "node_modules" || base === ".git") return false;
          if (src.includes(`${path.sep}web${path.sep}src`)) return false;
          return true;
        },
      });
    } catch {
      return bundled; // 복사 실패 — 번들이 쓰기 가능하면(dev) 그대로.
    }
  }
  return dest;
}

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1 > start + 50 ? 0 : p + 1));
      srv.once("listening", () => {
        srv.close(() => resolve(p));
      });
      srv.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}

function probeManifest(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = net.connect({ host: "127.0.0.1", port }, () => {
      req.write(`GET /__studio/manifest HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    let buf = "";
    req.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        req.destroy();
        resolve(/^HTTP\/1\.[01] 200/.test(buf));
      }
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

export interface StudioStartResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

/** 스튜디오 런처를 띄우고(이미 떠있으면 재사용) iframe 용 로컬 URL 을 반환. */
export async function startStudio(): Promise<StudioStartResult> {
  installStudioMediaGuard();
  if (proc && activeUrl) {
    if (await probeManifest(Number(new URL(activeUrl).port))) return { ok: true, url: activeUrl };
    stopStudio();
  }
  const root = studioRoot();
  if (!root) return { ok: false, reason: "스튜디오 패키지(studio-pack)를 찾을 수 없습니다." };
  const py = await resolveHephaestusPython();
  if (!py) return { ok: false, reason: "Python 3.9+ 를 찾을 수 없습니다." };

  // 쓰기 가능한 로컬 런타임 루트(userData)에서 구동 — 데이터는 전부 로컬, 블랭크 시작.
  const runRoot = ensureWritablePack(root);
  // 첫 실행이면 "유효하지만 빈" board 를 시드한다. SPA 는 유효 board 를 받으면 baked 데모 샘플 대신
  // 이 빈 board 를 렌더한다(목업/외부 미디어 없음). 기존 세션 데이터가 있으면 보존(로컬 누적).
  try {
    const runtimeDir = path.join(runRoot, ".studio-runtime");
    const live = path.join(runtimeDir, "studio-data.json");
    const seed = path.join(runRoot, "clean-studio-data.json");
    if (!fs.existsSync(live) && fs.existsSync(seed)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.copyFileSync(seed, live);
    }
  } catch {
    /* 비치명적 — 시드 실패 시 런처 기본 동작 */
  }
  const port = await findFreePort(4173);
  // 데스크탑 임베드는 사용자 본인 머신에서 본인 엔진으로 돈다 → 크레딧 게이트 없이 무료 동작
  // (런처 계약: STUDIO_CREDITS=off 또는 owner 는 free). STUDIO_CREDITS 가 이미 설정돼 있으면 존중.
  const env = withCliPath({
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    STUDIO_CREDITS: "off",
    ...process.env,
    HEPHAESTUS_PYTHON: py.python,
  });
  const args = py.python === "py" ? ["-3", path.join("scripts", "open-studio-gui.py"), "--no-open", "--port", String(port)] : [path.join("scripts", "open-studio-gui.py"), "--no-open", "--port", String(port)];
  try {
    proc = crossSpawn(py.python, args, { cwd: runRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  proc.on("exit", () => {
    proc = null;
    activeUrl = null;
  });

  // 서버 준비 대기(최대 ~12s).
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await probeManifest(port)) {
      activeUrl = `http://127.0.0.1:${port}/`;
      return { ok: true, url: activeUrl };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  stopStudio();
  return { ok: false, reason: "스튜디오 서버 시작 시간 초과." };
}

export function stopStudio(): void {
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* noop */
    }
  }
  proc = null;
  activeUrl = null;
}

// 앱 종료 시 런처 정리.
app.on("before-quit", stopStudio);
app.on("will-quit", stopStudio);
