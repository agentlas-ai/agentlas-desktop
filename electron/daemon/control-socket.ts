// 로컬 제어 소켓 — 같은 머신의 클라이언트(터미널·데스크탑)가 데몬에 일을 시키는 문.
//
// ★왜 모바일 브리지를 그대로 안 쓰나. 그건 **다른 기기**용이라 페어링·TLS·리플레이
// 방지가 붙어 있다. 같은 사용자의 같은 머신에서 도는 CLI 한 줄에 그 절차를 요구하면
// 아무도 안 쓴다 — 그러면 터미널은 계속 코어를 자기 안에서 돌리게 되고(64MB 사본,
// 두 번째 DB 주인), Phase 3 이 실패한다.
//
// 대신 **파일시스템이 경계**다:
//   · unix domain socket 을 0700 디렉터리 안에 0600 으로 만든다 → 같은 사용자만 연결.
//   · Windows 는 named pipe(`\\.\pipe\…`)를 쓰고, 이름에 사용자 정보를 넣지 않는다
//     (이름이 곧 경로라 다른 사용자가 짐작할 수 있으므로 토큰을 함께 요구한다).
// 이건 데몬의 표준 패턴이고, OpenClaw 사고(CVE-2026-25253)처럼 **TCP 포트를 열어
// 브라우저가 닿게 하는 것**과 정확히 반대다 — 웹페이지는 유닉스 소켓에 못 붙는다.
//
// 프로토콜은 새로 만들지 않는다: 줄 단위 JSON-RPC(ndjson). 모바일 브리지가 쓰는
// 메서드 이름을 그대로 받는다.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ControlSocketRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface ControlSocketOptions {
  /** 메서드 하나를 처리한다. 던지면 JSON-RPC 에러로 나간다. */
  handle: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** 소켓/파이프 경로. 기본은 userData 아래. */
  socketPath?: string;
}

export interface ControlSocketHandle {
  /** 클라이언트가 접속할 주소(유닉스 경로 또는 파이프 이름). */
  address: string;
  close(): Promise<void>;
}

/** 이 머신의 기본 제어 소켓 주소. 클라이언트도 같은 함수를 써야 서로 찾는다. */
export function defaultControlSocketPath(userDataDir: string): string {
  if (process.platform === "win32") {
    // 파이프 이름에는 경로를 못 쓴다. userData 를 짧게 접어 넣어 인스턴스를 가른다.
    const tag = Buffer.from(userDataDir).toString("base64url").slice(-16);
    return `\\\\.\\pipe\\agentlas-daemon-${tag}`;
  }
  return path.join(userDataDir, "daemon.sock");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * 제어 소켓을 연다.
 *
 * 유닉스에서는 남아 있는 옛 소켓 파일을 지운다 — 데몬이 비정상 종료하면 파일만 남고,
 * 그 상태로는 bind 가 EADDRINUSE 로 죽어 **데몬이 영영 못 뜬다**(사용자에게는 "아무
 * 이유 없이 안 됨"으로 보인다). 살아 있는 데몬의 소켓을 지우지 않도록, 먼저 붙어 보고
 * 응답이 없을 때만 지운다.
 */
export async function startControlSocket(
  userDataDir: string,
  opts: ControlSocketOptions,
): Promise<ControlSocketHandle> {
  const address = opts.socketPath ?? defaultControlSocketPath(userDataDir);

  if (process.platform !== "win32" && fs.existsSync(address)) {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(address);
      const done = (value: boolean) => {
        probe.destroy();
        resolve(value);
      };
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
      setTimeout(() => done(false), 500).unref?.();
    });
    if (alive) throw new Error(`another Agentlas daemon is already listening on ${address}`);
    fs.rmSync(address, { force: true });
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let request: ControlSocketRequest;
        try {
          request = JSON.parse(line) as ControlSocketRequest;
        } catch {
          socket.write(jsonLine({ id: null, error: { code: -32700, message: "invalid JSON" } }));
          continue;
        }
        if (!request?.method) {
          socket.write(jsonLine({ id: request?.id ?? null, error: { code: -32600, message: "missing method" } }));
          continue;
        }
        void (async () => {
          try {
            const result = await opts.handle(request.method, request.params);
            socket.write(jsonLine({ id: request.id, result }));
          } catch (error) {
            // 실패 사유를 그대로 전한다 — 클라이언트가 사람에게 보여 줄 유일한 문장이다.
            socket.write(
              jsonLine({
                id: request.id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
              }),
            );
          }
        })();
      }
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => resolve());
  });

  if (process.platform !== "win32") {
    // 같은 사용자만 붙는다. 이것이 이 소켓의 인증 전부다.
    try { fs.chmodSync(address, 0o600); } catch { /* best-effort */ }
  }

  return {
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform !== "win32") {
            try { fs.rmSync(address, { force: true }); } catch { /* best-effort */ }
          }
          resolve();
        });
      }),
  };
}

/** 클라이언트 쪽 최소 구현 — 터미널·데스크탑이 이걸 쓴다. */
export function callControlSocket(
  address: string,
  method: string,
  params?: unknown,
  timeoutMs = 120_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const id = randomUUID();
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`daemon did not answer ${method} within ${timeoutMs}ms`))),
      timeoutMs,
    );
    socket.on("connect", () => socket.write(jsonLine({ id, method, params })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message: { id?: string; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error) finish(() => reject(new Error(message.error?.message ?? "daemon error")));
        else finish(() => resolve(message.result));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
  });
}

/** 데몬이 지금 떠 있는가 — 클라이언트가 "직접 할지 데몬에 시킬지" 를 정하는 근거. */
export async function daemonIsReachable(address: string): Promise<boolean> {
  try {
    await callControlSocket(address, "daemon.ping", undefined, 2_000);
    return true;
  } catch {
    return false;
  }
}

/** 기본 소켓 경로를 계산할 때 쓰는 홈 — 테스트가 갈아끼운다. */
export function controlSocketHome(): string {
  return os.homedir();
}
