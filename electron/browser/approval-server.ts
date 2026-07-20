// Browser 승인 서버 — agentlas-browser 런처(.mjs)가 되돌릴 수 없는 행동(전송/게시/결제/삭제)을
// 실행하기 전에 이 로컬 엔드포인트를 때려 사용자 승인을 받는다. webhook-server.ts 선례를 따라
// 127.0.0.1의 임의 포트에만 바인딩하고, 포트+토큰을 현재 앱 인스턴스의
// userData/browser/approval.json에 써서 런처가 찾게 한다. 설치본과 개발본이 같이 떠도
// 서로의 포트·DB·승인 창을 덮어쓰지 않는 인스턴스별 capability이다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { browserRequestApproval } from "./connect";
import { browserApprovalInfoPath } from "./approval-channel";

let server: http.Server | null = null;
let boundPort = 0;
let token = "";

function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total <= maxBytes) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export function startBrowserApprovalServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  token = randomUUID();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/approve")) {
        res.writeHead(404).end("not found");
        return;
      }
      if ((req.headers["authorization"] ?? "") !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      void readBody(req).then(async (body) => {
        let parsed: { site?: string; actionType?: string; summary?: string; target?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        try {
          const decision = await browserRequestApproval({
            site: parsed.site ?? "",
            actionType: parsed.actionType ?? "action",
            summary: parsed.summary ?? "Approve browser action",
            target: parsed.target,
          }, { signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision }));
        } catch (err) {
          if (controller.signal.aborted || res.destroyed) return;
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ decision: "denied", error: String(err) }));
        }
      });
    });

    srv.on("error", () => {
      server = null;
      boundPort = 0;
      resolve(0);
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      boundPort = typeof addr === "object" && addr ? addr.port : 0;
      server = srv;
      try {
        const infoPath = browserApprovalInfoPath();
        const infoDir = path.dirname(infoPath);
        fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(infoDir, 0o700); } catch { /* best-effort */ }
        const temp = `${infoPath}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ port: boundPort, token }), { mode: 0o600 });
        try { fs.chmodSync(temp, 0o600); } catch { /* best-effort */ }
        fs.renameSync(temp, infoPath);
      } catch {
        /* best-effort */
      }
      resolve(boundPort);
    });
  });
}

export function stopBrowserApprovalServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  server = null;
  boundPort = 0;
  try {
    fs.rmSync(browserApprovalInfoPath(), { force: true });
  } catch {
    /* ignore */
  }
}
