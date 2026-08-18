#!/usr/bin/env node
/*
 * MCP 프록시 자식 — 런타임에게는 MCP 서버, 실제 서버에게는 클라이언트.
 *
 * ★왜 있나. 도구 호출을 실제로 막는 지점은 벤더 CLI 의 훅뿐인데, 그 훅은 벤더마다
 * 다르고 어떤 벤더는 CLI 에서 아예 발화하지 않는다(cursor CLI 는 beforeMCPExecution 을
 * 쏘지 않고, copilot 의 훅은 서브에이전트 내부 호출에 안 걸린다). 남의 훅에 기대는 한
 * 그 구멍은 우리가 못 막는다.
 *
 * 그래서 도구를 **우리 손으로 건넨다**. 런타임 설정에 실제 서버 대신 이 프록시를
 * 적으면, 누가 부르든(에이전트든 서브에이전트든) 모든 tools/call 이 이 프로세스를
 * 지난다. 훅이 없어도, 훅이 죽어도, 벤더가 이벤트를 안 쏴도 경계는 유지된다.
 *
 * 계약:
 *  - initialize / tools/list / resources·prompts 등은 **그대로 통과**시킨다. 우리가
 *    도구 목록을 각색하면 모델이 보는 세계와 실제가 갈린다.
 *  - tools/call 만 승인 관문을 지난다. 거절은 JSON-RPC 에러가 아니라 `isError` 결과로
 *    돌려준다 — 모델이 사유를 읽고 다른 길을 찾을 수 있어야 하고, 프로토콜 오류로
 *    만들면 세션 자체가 끊긴다.
 *  - 승인 서버에 못 닿으면 **거부**다. 관문에 못 물어본 것과 허용된 것은 다르다.
 *
 * stdout 은 JSON-RPC 전용이다. 어떤 진단도 stdout 에 쓰지 않는다(stderr 만).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");

const CONTROL_FILE = process.env.AGENTLAS_MCP_PROXY_CONTROL || "";
const TARGET_RAW = process.env.AGENTLAS_MCP_PROXY_TARGET || "";
const SERVER_KEY = process.env.AGENTLAS_MCP_PROXY_SERVER_KEY || "mcp";
const SESSION_RAW = process.env.AGENTLAS_MCP_PROXY_SESSION || "";

function warn(message) {
  try { process.stderr.write(`[agentlas-mcp-proxy] ${message}\n`); } catch { /* ignore */ }
}

let target;
try {
  target = JSON.parse(TARGET_RAW);
} catch {
  warn("target spec is unreadable — refusing to start");
  process.exit(2);
}
let session = {};
try {
  session = SESSION_RAW ? JSON.parse(SESSION_RAW) : {};
} catch {
  session = {};
}

/** 승인 서버 좌표. 매 호출 읽는다 — 앱이 재시작하면 포트·토큰이 바뀐다. */
function control() {
  if (!CONTROL_FILE) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
    if (typeof parsed?.port === "number" && parsed.port > 0 && typeof parsed?.token === "string") {
      return parsed;
    }
  } catch { /* 파일이 아직 없거나 앱이 죽었다 */ }
  return null;
}

function askApproval(toolName) {
  return new Promise((resolve) => {
    const info = control();
    if (!info) {
      // 관문에 못 물어봤다 = 거부. 이 프록시가 존재하는 이유가 관문이므로,
      // 관문 부재를 허용으로 바꾸면 프록시가 통과 파이프로 전락한다.
      warn("approval channel is unavailable — denying");
      resolve(false);
      return;
    }
    const body = JSON.stringify({
      serverKey: SERVER_KEY,
      toolName,
      sessionKey: session.sessionKey,
      runtime: session.runtime,
      permission: session.permission,
      cwd: session.cwd,
      chatId: session.chatId,
      unattended: session.unattended === true,
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: info.port,
        path: "/approve",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${info.token}`,
        },
        // 사람이 카드를 볼 시간을 준다. 초과하면 거부다.
        timeout: 10 * 60_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw)?.decision === "allow");
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

// ── 실제 서버로의 stdio 연결 ────────────────────────────────
if (!target || typeof target.command !== "string" || !target.command) {
  warn("target has no command — refusing to start");
  process.exit(2);
}
const upstream = spawn(target.command, Array.isArray(target.args) ? target.args : [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ...(target.env && typeof target.env === "object" ? target.env : {}) },
});
upstream.on("error", (error) => {
  warn(`upstream failed to start: ${error && error.message ? error.message : error}`);
  process.exit(3);
});
upstream.on("exit", (code) => process.exit(code == null ? 0 : code));

function send(stream, message) {
  try { stream.write(`${JSON.stringify(message)}\n`); } catch { /* peer went away */ }
}

// 승인 대기 중인 tools/call 의 id → 원래 요청. 위로 보내지 않고 여기서 답한다.
const deniedIds = new Set();

// ── 런타임(우리 stdin) → 실제 서버 ─────────────────────────
let downBuffer = "";
process.stdin.on("data", (chunk) => {
  downBuffer += chunk.toString("utf8");
  let nl;
  while ((nl = downBuffer.indexOf("\n")) >= 0) {
    const line = downBuffer.slice(0, nl).trim();
    downBuffer = downBuffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // 우리가 해석 못 하는 줄은 그대로 흘린다 — 프로토콜을 우리가 좁히지 않는다.
      try { upstream.stdin.write(`${line}\n`); } catch { /* ignore */ }
      continue;
    }
    if (message?.method !== "tools/call") {
      send(upstream.stdin, message);
      continue;
    }
    const toolName = message?.params?.name ?? "";
    const id = message?.id;
    void askApproval(String(toolName)).then((allowed) => {
      if (allowed) {
        send(upstream.stdin, message);
        return;
      }
      if (id === undefined || id === null) return; // 알림이면 답할 곳이 없다.
      deniedIds.add(id);
      // 거절은 프로토콜 오류가 아니라 도구 결과다 — 모델이 읽고 다른 길을 찾게.
      send(process.stdout, {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool call denied: "${toolName}" was not approved for this run.`,
            },
          ],
        },
      });
    });
  }
});
process.stdin.on("end", () => {
  try { upstream.stdin.end(); } catch { /* ignore */ }
});

// ── 실제 서버 → 런타임(우리 stdout) ────────────────────────
let upBuffer = "";
upstream.stdout.on("data", (chunk) => {
  upBuffer += chunk.toString("utf8");
  let nl;
  while ((nl = upBuffer.indexOf("\n")) >= 0) {
    const line = upBuffer.slice(0, nl).trim();
    upBuffer = upBuffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      try { process.stdout.write(`${line}\n`); } catch { /* ignore */ }
      continue;
    }
    // 거절한 id 에 상류가 뒤늦게 답하면 버린다 — 같은 id 로 두 번 답하면
    // 클라이언트 상태가 깨진다.
    if (message?.id !== undefined && deniedIds.has(message.id)) {
      deniedIds.delete(message.id);
      continue;
    }
    send(process.stdout, message);
  }
});
