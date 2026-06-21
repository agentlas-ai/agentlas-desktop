// forge web 패키지를 localhost로 띄우고 그 url을 renderer(iframe)에 돌려준다.
//
// 흐름: serveStudioPackage(slug)
//   → 레지스트리 조회 (shared/studio-packages.ts)
//   → 이미 서빙 중이면(Map 캐시) 기존 url 반환
//   → 아니면 `python3 <launcher> --no-open --port 0` spawn (cwd = packageDir)
//   → stdout 첫 JSON 라인에서 {"status":"serving"|"reused", "url": "..."} 파싱
//   → url resolve. 10초 타임아웃. spawn 에러/python3 없음/비정상 종료 → {error, message}
//
// 보안/안정: 각 패키지는 python3만 필요(4-tier fallback). 자식 핸들은 Map에 보관해
// 앱 종료 시 stopAllStudios()로 일괄 kill.

import { spawn, type ChildProcess } from "node:child_process";
import { findStudioPackage } from "@shared/studio-packages";

export interface StudioServeOk {
  url: string;
}
export interface StudioServeError {
  error: string;
  message: string;
}
export type StudioServeResult = StudioServeOk | StudioServeError;

const SERVE_TIMEOUT_MS = 10_000;

/** slug → 살아있는 런처 자식 프로세스 */
const running = new Map<string, ChildProcess>();
/** slug → 이미 확정된 serving url (자식 재사용) */
const servedUrls = new Map<string, string>();

function err(error: string, message: string): StudioServeError {
  return { error, message };
}

export async function serveStudioPackage(slug: string): Promise<StudioServeResult> {
  const pkg = findStudioPackage(slug);
  if (!pkg) {
    return err("unknown-package", `알 수 없는 스튜디오 패키지: ${slug}`);
  }

  // 이미 서빙 중이고 url을 알고 있으면 그대로 재사용.
  const cached = servedUrls.get(slug);
  const child = running.get(slug);
  if (cached && child && child.exitCode === null && !child.killed) {
    return { url: cached };
  }
  // 캐시 url은 있는데 프로세스가 죽었으면 정리하고 재시작.
  if (cached && (!child || child.exitCode !== null || child.killed)) {
    servedUrls.delete(slug);
    running.delete(slug);
  }

  return new Promise<StudioServeResult>((resolve) => {
    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const finish = (result: StudioServeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let proc: ChildProcess;
    try {
      proc = spawn("python3", [pkg.launcher, "--no-open", "--port", "0"], {
        cwd: pkg.packageDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(
        err(
          "spawn-failed",
          `런처를 실행하지 못했습니다 (python3): ${(e as Error)?.message ?? String(e)}`,
        ),
      );
      return;
    }

    running.set(slug, proc);

    const timer = setTimeout(() => {
      finish(
        err(
          "timeout",
          `스튜디오 서버 시작이 ${SERVE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`,
        ),
      );
    }, SERVE_TIMEOUT_MS);

    // spawn 자체 실패(python3 없음 등)는 'error' 이벤트로 온다.
    proc.on("error", (e: NodeJS.ErrnoException) => {
      running.delete(slug);
      if (e.code === "ENOENT") {
        finish(err("python3-missing", "python3가 필요합니다. python3를 설치한 뒤 다시 시도하세요."));
      } else {
        finish(err("spawn-failed", `런처 실행 오류: ${e.message}`));
      }
    });

    // 첫 JSON 라인에서 url 파싱 (라인 버퍼링 — chunk가 라인 중간에 끊길 수 있다).
    const tryParseLines = () => {
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          try {
            const obj = JSON.parse(line) as { status?: string; url?: string };
            if (obj && typeof obj.url === "string" && obj.url) {
              servedUrls.set(slug, obj.url);
              finish({ url: obj.url });
              return;
            }
          } catch {
            // JSON이 아닌 로그 라인 — 무시하고 다음 라인.
          }
        }
        nl = stdoutBuf.indexOf("\n");
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      tryParseLines();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    proc.on("exit", (code) => {
      running.delete(slug);
      servedUrls.delete(slug);
      // 아직 url을 못 받았는데 프로세스가 끝났으면 실패로 처리.
      finish(
        err(
          "exited",
          `스튜디오 런처가 비정상 종료했습니다 (code ${code}).` +
            (stderrBuf.trim() ? ` ${stderrBuf.trim().split("\n").slice(-3).join(" ")}` : ""),
        ),
      );
    });
  });
}

export function stopStudioPackage(slug: string): { ok: boolean } {
  const child = running.get(slug);
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  running.delete(slug);
  servedUrls.delete(slug);
  return { ok: true };
}

export function stopAllStudios(): void {
  for (const [, child] of running) {
    try {
      if (child.exitCode === null && !child.killed) child.kill();
    } catch {
      // ignore
    }
  }
  running.clear();
  servedUrls.clear();
}
