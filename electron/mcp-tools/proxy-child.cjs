#!/usr/bin/env node
// Native CLI MCP wire adapter. Main owns the actual upstream, policy and schema.
// No target process, permission, credential or descriptor is accepted from this child.
const fs = require("node:fs");
const http = require("node:http");
const handle = process.env.AGENTLAS_MCP_PROXY_LAUNCH || "";
const file = process.env.AGENTLAS_MCP_PROXY_CONTROL || "";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
let info;
try {
  info = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[a-f0-9-]{36}$/.test(handle) || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== "string") throw new Error();
} catch {
  process.stderr.write("[agentlas-mcp-proxy] mcp_proxy_launch_unavailable\n");
  process.exit(2);
}
let closed = false, response = null, downBuffer = "", upBuffer = "";
const request = http.request({ host: "127.0.0.1", port: info.port, path: `/bridge/${handle}`, method: "POST",
  headers: { authorization: `Bearer ${info.token}`, "content-type": "application/x-ndjson" } });
function close(code, reason) {
  if (closed) return; closed = true;
  if (reason) process.stderr.write(`[agentlas-mcp-proxy] ${reason}\n`);
  request.destroy(); response?.destroy(); process.exit(code);
}
request.on("response", res => {
  response = res;
  if (res.statusCode !== 200) { close(3, "mcp_proxy_bridge_refused"); return; }
  res.setEncoding("utf8");
  res.on("data", chunk => {
    downBuffer += chunk;
    if (Buffer.byteLength(downBuffer) > MAX_FRAME_BYTES) { close(3, "mcp_proxy_frame_limit"); return; }
    let newline;
    while ((newline = downBuffer.indexOf("\n")) >= 0) {
      const line = downBuffer.slice(0, newline + 1); downBuffer = downBuffer.slice(newline + 1);
      if (!process.stdout.write(line)) res.pause();
    }
  });
  res.on("error", () => close(3, "mcp_proxy_bridge_unavailable"));
  res.on("end", () => close(0));
});
process.stdout.on("drain", () => response?.resume());
process.stdout.on("error", () => close(0));
request.on("error", () => close(3, "mcp_proxy_bridge_unavailable"));
request.on("drain", () => process.stdin.resume());
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  upBuffer += chunk;
  if (Buffer.byteLength(upBuffer) > MAX_FRAME_BYTES) { close(3, "mcp_proxy_frame_limit"); return; }
  let newline;
  while ((newline = upBuffer.indexOf("\n")) >= 0) {
    const line = upBuffer.slice(0, newline + 1); upBuffer = upBuffer.slice(newline + 1);
    if (!request.write(line)) process.stdin.pause();
  }
});
process.stdin.on("end", () => { request.end(); close(0); });
process.stdin.on("error", () => close(0));
process.on("SIGTERM", () => close(0));
process.on("SIGINT", () => close(0));
request.flushHeaders();
