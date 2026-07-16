import { createHash } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const AGENTLAS_COMPUTER_USE_CATALOG_ID = "cua-driver";
export const AGENTLAS_COMPUTER_USE_TOOL_NAMES = [
  "computer_status",
  "list_apps",
  "get_screen",
  "get_app_state",
  "focus_app",
  "move_mouse",
  "click",
  "double_click",
  "perform_secondary_action",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "select_text",
  "set_value",
] as const;

const COMPUTER_USE_MCP_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_FILE_ENV = "AGENTLAS_COMPUTER_USE_CONTROL_FILE";
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
let activeSourceId = null;

const point = {
  x: { type: "number", minimum: 0, maximum: 8192 },
  y: { type: "number", minimum: 0, maximum: 8192 },
  source_id: { type: "string", maxLength: 256 },
  app: { type: "string", minLength: 1, maxLength: 160 },
};
const exact = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const tools = [
  {
    name: "computer_status",
    description: "Check Agentlas Computer Use driver and macOS Accessibility/Screen Recording readiness.",
    inputSchema: exact({}, []),
  },
  {
    name: "list_apps",
    description: "List currently running foreground-capable macOS applications.",
    inputSchema: exact({}, []),
  },
  {
    name: "get_screen",
    description: "Capture the current macOS display. Coordinates returned by this image are the coordinate space used by mouse tools.",
    inputSchema: exact({ source_id: point.source_id }, []),
  },
  {
    name: "get_app_state",
    description: "Focus an optional running app, then capture the current display for visual state inspection.",
    inputSchema: exact({ app: point.app, source_id: point.source_id }, ["app"]),
  },
  {
    name: "focus_app",
    description: "Bring a running macOS application to the foreground by app name, bundle identifier, or pid:<number> from list_apps.",
    inputSchema: exact({ app: point.app }, ["app"]),
  },
  {
    name: "move_mouse",
    description: "Move the pointer to x,y in the latest screenshot coordinate space without clicking.",
    inputSchema: exact(point, ["x", "y"]),
  },
  {
    name: "click",
    description: "Click x,y in the latest screenshot coordinate space.",
    inputSchema: exact({ ...point, button: { type: "string", enum: ["left", "right", "middle"] } }, ["app", "x", "y"]),
  },
  {
    name: "double_click",
    description: "Double-click x,y in the latest screenshot coordinate space.",
    inputSchema: exact({ ...point, button: { type: "string", enum: ["left", "right", "middle"] } }, ["app", "x", "y"]),
  },
  {
    name: "perform_secondary_action",
    description: "Right-click x,y to open the contextual/secondary action menu.",
    inputSchema: exact(point, ["app", "x", "y"]),
  },
  {
    name: "drag",
    description: "Drag between two points in the latest screenshot coordinate space.",
    inputSchema: exact({
      from_x: point.x, from_y: point.y, to_x: point.x, to_y: point.y,
      source_id: point.source_id, app: point.app,
      duration_ms: { type: "integer", minimum: 50, maximum: 5000 },
      button: { type: "string", enum: ["left", "right", "middle"] },
    }, ["app", "from_x", "from_y", "to_x", "to_y"]),
  },
  {
    name: "scroll",
    description: "Scroll the current app; positive delta_y scrolls down and negative delta_y scrolls up.",
    inputSchema: exact({
      delta_x: { type: "integer", minimum: -4000, maximum: 4000 },
      delta_y: { type: "integer", minimum: -4000, maximum: 4000 },
      app: point.app,
    }, ["app"]),
  },
  {
    name: "type_text",
    description: "Type Unicode text into the currently focused field. Never use this for secrets unless the user explicitly authorized that secret entry.",
    inputSchema: exact({ text: { type: "string", minLength: 1, maxLength: 16384 }, app: point.app }, ["app", "text"]),
  },
  {
    name: "press_key",
    description: "Press a keyboard key with optional command/shift/option/control/fn modifiers.",
    inputSchema: exact({
      key: { type: "string", minLength: 1, maxLength: 32 },
      modifiers: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["command", "shift", "option", "control", "fn"] } },
      repeat: { type: "integer", minimum: 1, maximum: 20 },
      app: point.app,
    }, ["app", "key"]),
  },
  {
    name: "select_text",
    description: "Select all text in the currently focused editable field using Command+A.",
    inputSchema: exact({ app: point.app }, ["app"]),
  },
  {
    name: "set_value",
    description: "Optionally click a field, select its existing value, and type replacement Unicode text.",
    inputSchema: exact({
      text: { type: "string", minLength: 1, maxLength: 16384 },
      x: point.x, y: point.y, source_id: point.source_id, app: point.app,
    }, ["app", "text"]),
  },
];

function readControlInfo() {
  const file = process.env[CONTROL_FILE_ENV];
  if (!file || file.length > 4096) throw new Error("Agentlas Computer Use control capability is unavailable.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Agentlas Computer Use control capability is invalid.");
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Agentlas Computer Use control capability permissions are invalid.");
    }
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535 ||
      typeof parsed.token !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.token)) {
    throw new Error("Agentlas Computer Use control capability is invalid.");
  }
  return parsed;
}

function controlRequest(route, body, timeoutMs = 8000) {
  const info = readControlInfo();
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > 64 * 1024) return Promise.reject(new Error("Computer Use request is too large."));
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    const req = http.request({
      host: "127.0.0.1", port: info.port, path: route, method: "POST",
      headers: {
        authorization: "Bearer " + info.token,
        "content-type": "application/json",
        "content-length": String(bytes.length),
      },
      timeout: Math.max(500, Math.min(timeoutMs, 12000)),
    }, (res) => {
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else req.destroy(new Error("Computer Use response is too large."));
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(parsed);
        } catch { reject(new Error("Computer Use returned an invalid response.")); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("Computer Use request timed out.")));
    req.once("error", reject);
    req.end(bytes);
  });
}

function textResult(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function errorResult(value) {
  const message = value && typeof value.message === "string" ? value.message :
    value && typeof value.error === "string" ? value.error : "Computer Use action failed.";
  return { content: [{ type: "text", text: message.slice(0, 500) }], isError: true };
}
function actionBody(action, args) {
  return {
    action,
    ...(args.app ? { app: args.app } : {}),
    ...(args.source_id || activeSourceId ? { sourceId: args.source_id || activeSourceId } : {}),
  };
}
async function callAction(body) {
  const result = await controlRequest("/action", body, body.action === "drag" ? 12000 : 8000);
  return result && result.ok ? textResult(result) : errorResult(result);
}
async function capture(args) {
  const sourceId = args.source_id || activeSourceId || undefined;
  const result = await controlRequest("/capture", sourceId ? { sourceId } : {});
  if (!result || !result.ok || !result.preview) return errorResult(result);
  const preview = result.preview;
  activeSourceId = preview.selectedSourceId || activeSourceId;
  const metadata = { ...preview };
  delete metadata.dataUrl;
  const content = [{ type: "text", text: JSON.stringify(metadata) }];
  const match = typeof preview.dataUrl === "string" ? preview.dataUrl.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (match) content.unshift({ type: "image", mimeType: "image/" + match[1], data: match[2] });
  return { content };
}

async function handle(request) {
  if (request.method === "initialize") {
    const status = await controlRequest("/status", {});
    if (!status || status.available !== true) throw new Error("Agentlas native Computer Use driver is unavailable.");
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-computer-use", version: "1.0.0" } };
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
  const name = request.params && request.params.name;
  const args = request.params && request.params.arguments && typeof request.params.arguments === "object" ? request.params.arguments : {};
  if (name === "computer_status") return textResult(await controlRequest("/status", {}));
  if (name === "list_apps") return callAction({ action: "listApps" });
  if (name === "get_screen") return capture(args);
  if (name === "get_app_state") {
    if (args.app) {
      const focused = await controlRequest("/action", { action: "focusApp", app: args.app });
      if (!focused || !focused.ok) return errorResult(focused);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return capture(args);
  }
  if (name === "focus_app") return callAction({ action: "focusApp", app: args.app });
  if (name === "move_mouse") return callAction({ ...actionBody("move", args), x: args.x, y: args.y });
  if (name === "click") return callAction({ ...actionBody("click", args), x: args.x, y: args.y, button: args.button || "left", clickCount: 1 });
  if (name === "double_click") return callAction({ ...actionBody("click", args), x: args.x, y: args.y, button: args.button || "left", clickCount: 2 });
  if (name === "perform_secondary_action") return callAction({ ...actionBody("click", args), x: args.x, y: args.y, button: "right", clickCount: 1 });
  if (name === "drag") return callAction({
    ...actionBody("drag", args), from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y,
    durationMs: args.duration_ms || 450, button: args.button || "left",
  });
  if (name === "scroll") return callAction({ ...actionBody("scroll", args), deltaX: args.delta_x || 0, deltaY: args.delta_y || 0 });
  if (name === "type_text") return callAction({ ...actionBody("typeText", args), text: args.text });
  if (name === "press_key") return callAction({ ...actionBody("key", args), key: args.key, modifiers: args.modifiers || [], repeat: args.repeat || 1 });
  if (name === "select_text") return callAction({ ...actionBody("selectText", args) });
  if (name === "set_value") {
    if ((args.x === undefined) !== (args.y === undefined)) return errorResult({ message: "set_value requires both x and y when a point is supplied." });
    if (args.x !== undefined) {
      const clicked = await controlRequest("/action", { ...actionBody("click", args), x: args.x, y: args.y, button: "left", clickCount: 1 });
      if (!clicked || !clicked.ok) return errorResult(clicked);
    }
    const selected = await controlRequest("/action", { ...actionBody("selectText", args) });
    if (!selected || !selected.ok) return errorResult(selected);
    return callAction({ ...actionBody("typeText", args), text: args.text });
  }
  return errorResult({ message: "Unknown Computer Use tool." });
}

let pending = Promise.resolve();
function handleLine(line) {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    process.stderr.write("Agentlas Computer Use MCP rejected an oversized request.\n");
    process.exit(78);
  }
  let request;
  try { request = JSON.parse(line); } catch { return; }
  pending = pending.then(async () => {
    try {
      const result = await handle(request);
      if (request.id === undefined || result === undefined) return;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    } catch (error) {
      if (request.id === undefined) return;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        error: { code: Number(error && error.code) || -32603, message: error && error.message ? String(error.message).slice(0, 500) : "Computer Use request failed." },
      }) + "\n");
    }
  });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    handleLine(line);
  }
  if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78);
});
`;

const SOURCE_SHA256 = createHash("sha256").update(COMPUTER_USE_MCP_SOURCE).digest("hex");
const INLINE_BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:131072});` +
  `if(b.length>131072||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-computer-use.cjs"});`;
const INLINE_PAYLOAD = gzipSync(Buffer.from(COMPUTER_USE_MCP_SOURCE, "utf8"), { level: 9 }).toString("base64");

export const AGENTLAS_COMPUTER_USE_INLINE_ARGS_MAX_JSON_CHARS = 24_000;

export function computerUseMcpLaunchArgs(): string[] {
  return ["-e", INLINE_BOOTSTRAP, INLINE_PAYLOAD];
}

export function computerUseMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(computerUseMcpLaunchArgs()).length <= AGENTLAS_COMPUTER_USE_INLINE_ARGS_MAX_JSON_CHARS;
}

export function computerUseMcpSourceDigest(): string {
  return SOURCE_SHA256;
}

export function isAuthenticComputerUseMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  const expected = computerUseMcpLaunchArgs();
  return computerUseMcpLaunchWithinBudget() && args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

export function isCanonicalComputerUseMcpServer(server: {
  catalogId: string | null;
  configurationValid?: boolean;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  envKeys: readonly string[];
}): boolean {
  return server.catalogId === AGENTLAS_COMPUTER_USE_CATALOG_ID &&
    server.configurationValid !== false &&
    server.transport === "stdio" &&
    server.url === null &&
    server.envKeys.length === 0 &&
    isAuthenticComputerUseMcpLaunch(server.command, server.args);
}
