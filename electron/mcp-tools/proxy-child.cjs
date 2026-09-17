#!/usr/bin/env node
// Native CLI MCP wire adapter. Main owns the actual upstream, policy and schema.
// No target process, permission, credential or descriptor is accepted from this child.
//
// 재접속(2026-09-14, 페르소나 루프 라운드 3 실측): 데스크탑 다리(bridge) 응답이 끊기면 이 자식이 그 자리에서 죽었고,
// CLI 가 소유한 stdio 서버가 프로세스째 사라져 그 턴의 모든 호출이 `MCP server "cua-driver" is not connected` 가 됐다(35건).
// 자식이 살아 있기만 하면 CLI 는 같은 파이프로 계속 말을 걸므로, 다리가 끊겨도 죽지 않고 같은 핸들로 다시 붙는다:
// 첫 연결에서 본 initialize 핸드셰이크를 새 연결에 되풀이하고(그 응답은 삼킨다), 끊긴 순간 진행 중이던 호출에는
// "일시적 연결 재설정, 다시 호출하라"는 JSON-RPC 오류를 돌려준다. 핸들이 거절(403)되면 되살릴 길이 없으니 그때만 끝낸다.
const fs = require("node:fs");
const http = require("node:http");
const handle = process.env.AGENTLAS_MCP_PROXY_LAUNCH || "";
const file = process.env.AGENTLAS_MCP_PROXY_CONTROL || "";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RECONNECT_BASE_MS = 250, RECONNECT_MAX_MS = 8_000, RECONNECT_GIVE_UP_MS = 5 * 60_000;
let info;
try {
  info = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[a-f0-9-]{36}$/.test(handle) || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== "string") throw new Error();
} catch {
  process.stderr.write("[agentlas-mcp-proxy] mcp_proxy_launch_unavailable\n");
  process.exit(2);
}
const idKey = (id) => JSON.stringify(id);
let closed = false, stdinEnded = false, request = null, response = null, connected = false, connectedOnce = false;
let downBuffer = "", upBuffer = "", outbox = [], outboxBytes = 0, attempt = 0, firstDropAt = 0, reconnectTimer = null;
const handshake = { initialize: null, initialized: null };
const pending = new Map();      // 상류 응답을 기다리는 CLI 요청 id → true
const swallow = new Set();      // 되풀이한 initialize 의 응답 id — CLI 는 이미 첫 응답을 받았다
function log(reason) { process.stderr.write(`[agentlas-mcp-proxy] ${reason}\n`); }
function close(code, reason) {
  if (closed) return; closed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reason) log(reason);
  try { request?.destroy(); } catch {}
  try { response?.destroy(); } catch {}
  process.exit(code);
}
function toStdout(line) { if (!process.stdout.write(line)) response?.pause(); }
function trackUp(line) {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (!frame || typeof frame !== "object") return;
  if (frame.method === "initialize" && frame.id !== undefined) handshake.initialize = line;
  else if (frame.method === "notifications/initialized") handshake.initialized = line;
  if (frame.id !== undefined && typeof frame.method === "string") pending.set(idKey(frame.id), true);
}
function sendUp(line) {
  if (connected && request) { if (!request.write(line)) process.stdin.pause(); return; }
  outboxBytes += Buffer.byteLength(line);
  if (outboxBytes > MAX_FRAME_BYTES) { close(3, "mcp_proxy_frame_limit"); return; }
  outbox.push(line);
}
function failPending(reason) {
  for (const key of pending.keys()) {
    const id = JSON.parse(key);
    toStdout(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `agentlas proxy reconnecting (${reason}): temporary connection reset — call the tool again` } }) + "\n");
  }
  pending.clear();
}
function dropped(reason) {
  if (closed) return;
  const wasConnected = connected; connected = false; request = null; response = null; downBuffer = "";
  if (stdinEnded) { close(0); return; }
  if (wasConnected) { attempt = 0; firstDropAt = Date.now(); failPending(reason); }
  if (!firstDropAt) firstDropAt = Date.now();
  if (Date.now() - firstDropAt > RECONNECT_GIVE_UP_MS) { close(3, "mcp_proxy_bridge_unavailable"); return; }
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6)); attempt += 1;
  log(`reconnecting in ${delay}ms (${reason})`);
  reconnectTimer = setTimeout(connect, delay); reconnectTimer.unref?.();
}
function connect() {
  if (closed) return;
  reconnectTimer = null;
  const req = http.request({ host: "127.0.0.1", port: info.port, path: `/bridge/${handle}`, method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/x-ndjson" } });
  request = req;
  req.on("response", res => {
    if (req !== request) { res.destroy(); return; }
    if (res.statusCode === 403) { close(3, "mcp_proxy_bridge_refused"); return; }
    if (res.statusCode !== 200) { res.destroy(); dropped(`bridge_status_${res.statusCode}`); return; }
    const replay = connectedOnce;
    response = res; connected = true; connectedOnce = true;
    if (replay && handshake.initialize) {
      try { swallow.add(idKey(JSON.parse(handshake.initialize).id)); } catch {}
      req.write(handshake.initialize);
      if (handshake.initialized) req.write(handshake.initialized);
    }
    for (const line of outbox) req.write(line);
    outbox = []; outboxBytes = 0; process.stdin.resume();
    res.setEncoding("utf8");
    res.on("data", chunk => {
      if (res !== response) return;
      downBuffer += chunk;
      if (Buffer.byteLength(downBuffer) > MAX_FRAME_BYTES) { close(3, "mcp_proxy_frame_limit"); return; }
      let newline;
      while ((newline = downBuffer.indexOf("\n")) >= 0) {
        const line = downBuffer.slice(0, newline + 1); downBuffer = downBuffer.slice(newline + 1);
        let frame = null; try { frame = JSON.parse(line); } catch {}
        if (frame && typeof frame === "object" && frame.id !== undefined && typeof frame.method !== "string") {
          const key = idKey(frame.id);
          if (swallow.has(key)) { swallow.delete(key); continue; }
          pending.delete(key);
        }
        toStdout(line);
      }
    });
    res.on("error", () => { if (res === response) dropped("bridge_response_error"); });
    res.on("end", () => { if (res === response) dropped("bridge_response_ended"); });
  });
  req.on("error", () => { if (req === request) dropped("bridge_request_error"); });
  req.on("drain", () => process.stdin.resume());
  req.flushHeaders();
}
process.stdout.on("drain", () => response?.resume());
process.stdout.on("error", () => close(0));
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  upBuffer += chunk;
  if (Buffer.byteLength(upBuffer) > MAX_FRAME_BYTES) { close(3, "mcp_proxy_frame_limit"); return; }
  let newline;
  while ((newline = upBuffer.indexOf("\n")) >= 0) {
    const line = upBuffer.slice(0, newline + 1); upBuffer = upBuffer.slice(newline + 1);
    trackUp(line); sendUp(line);
  }
});
process.stdin.on("end", () => { stdinEnded = true; if (connected && request) { request.end(); } else close(0); });
process.stdin.on("error", () => close(0));
process.on("SIGTERM", () => close(0));
process.on("SIGINT", () => close(0));
connect();
