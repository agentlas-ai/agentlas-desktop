// Startup Founder Studio — 패키지의 실제 GUI 를 앱 안에서 그대로 구동.
//
// 재구현하지 않는다. 스튜디오 패키지(studio-pack/)의 자체 런처 scripts/open-studio-gui.py 를
// spawn 하면, 그 런처가 실제 SPA(web/dist) 를 서빙하고 /__studio/* 로 엔진에 브리지한다.
// 렌더러는 이 로컬 URL 을 <iframe> 으로 띄운다 → 진짜 스튜디오가 그대로 앱 안에서 돈다.
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app } from "electron";
import type { ChildProcess } from "node:child_process";
import { withCliPath } from "../runtime/exec";
import { resolveHephaestusPython } from "./engine";

let cachedRoot: string | null | undefined;
let proc: ChildProcess | null = null;
let activeUrl: string | null = null;

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
  if (proc && activeUrl) {
    if (await probeManifest(Number(new URL(activeUrl).port))) return { ok: true, url: activeUrl };
    stopStudio();
  }
  const root = studioRoot();
  if (!root) return { ok: false, reason: "스튜디오 패키지(studio-pack)를 찾을 수 없습니다." };
  const py = await resolveHephaestusPython();
  if (!py) return { ok: false, reason: "Python 3.9+ 를 찾을 수 없습니다." };

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
    proc = crossSpawn(py.python, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
