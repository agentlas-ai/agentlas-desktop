import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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
const element = {
  observation_id: { type: "string", minLength: 1, maxLength: 64 },
  element_index: { type: "integer", minimum: 0, maximum: 299 },
};
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
    description: "Capture the current macOS display. Coordinates returned by this image are the coordinate space used by mouse tools. The capture is also saved to disk; the JSON metadata's savedPath is its absolute file path. To show the capture in your chat answer, embed exactly that path as a markdown image: ![screen](savedPath). Never invent a screenshot file path.",
    inputSchema: exact({ source_id: point.source_id }, []),
  },
  {
    name: "get_app_state",
    description: "Read the app accessibility tree and observation-scoped element indices. Prefer element actions; reobserve after every mutation or stale reference. Set screenshot=true for visual fallback; screenshots use display coordinates.",
    inputSchema: exact({ app: point.app, source_id: point.source_id, screenshot: { type: "boolean" }, maxDepth: { type: "integer", minimum: 1, maximum: 32 }, maxNodes: { type: "integer", minimum: 1, maximum: 300 } }, ["app"]),
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
    description: "Press an observed accessibility element, or click screenshot x,y as a fallback. Supply observation_id and element_index together for element actions.",
    inputSchema: exact({ ...point, ...element, button: { type: "string", enum: ["left", "right", "middle"] } }, ["app"]),
  },
  {
    name: "double_click",
    description: "Double-click x,y in the latest screenshot coordinate space.",
    inputSchema: exact({ ...point, button: { type: "string", enum: ["left", "right", "middle"] } }, ["app", "x", "y"]),
  },
  {
    name: "perform_secondary_action",
    description: "Perform an exact action exposed by the observed element, or right-click screenshot x,y.",
    inputSchema: exact({ ...point, ...element, action: { type: "string", maxLength: 120 } }, ["app"]),
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
    description: "Select an unambiguous substring in an observed editable element, using optional prefix/suffix. Without an element, select all in the focused field.",
    inputSchema: exact({ app: point.app, ...element, text: { type: "string", maxLength: 16384 }, prefix: { type: "string", maxLength: 500 }, suffix: { type: "string", maxLength: 500 }, selection_type: { type: "string", enum: ["text", "cursor_before", "cursor_after"] } }, ["app"]),
  },
  {
    name: "set_value",
    description: "Optionally click a field, select its existing value, and type replacement Unicode text.",
    inputSchema: exact({
      text: { type: "string", minLength: 0, maxLength: 16384 },
      x: point.x, y: point.y, source_id: point.source_id, app: point.app, ...element,
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
// ★신원 없는 입력 금지 — 서버측 강제.
// 스키마는 이미 app 을 필수로 선언하지만, 스키마 검증은 클라이언트(런타임)의 성의에
// 달려 있다. app 없이 도착한 입력은 frontmost 창에 그대로 들어간다 — 실측
// 2026-08-19: 자동화가 로그아웃된 다른 X 창을 잡아 입력을 시도했다(캡처 존재).
// 입력·클릭류는 app 이 있어야만 실행되고, 그러면 control-server 가 pid 기반
// 재포커스로 대상 신원을 보장한다. 관측(get_screen/scroll/move)은 자유다.
const IDENTITY_REQUIRED_ACTIONS = new Set([
  "typeText", "key", "selectText", "click", "drag", "elementAction",
]);
async function callAction(body) {
  if (IDENTITY_REQUIRED_ACTIONS.has(body.action) && !body.app) {
    return errorResult({
      message:
        "This action needs an explicit app target. Input without a named app lands on whatever window happens to be frontmost. Pass app (for example Google Chrome) so the driver can focus and verify the target first.",
    });
  }
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
    if (args.screenshot) {
      const focused = await controlRequest("/action", { action: "focusApp", app: args.app });
      if (!focused || !focused.ok) return errorResult(focused);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const observed = await controlRequest("/observe", { app: args.app, maxDepth: args.maxDepth, maxNodes: args.maxNodes }, 12000);
    if (!observed || !observed.ok) return errorResult(observed);
    const state = textResult(observed);
    if (args.screenshot) {
      const screen = await capture(args);
      if (screen.isError) {
        state.content.push({ type: "text", text: JSON.stringify({ screenshot: {
          ok: false,
          error: screen.content && screen.content[0] && screen.content[0].text || "capture-failed",
        } }) });
      } else {
        state.content.push(...screen.content);
      }
    }
    return state;
  }
  const hasElement = args.element_index !== undefined || args.observation_id !== undefined;
  if (hasElement) {
    if (!Number.isInteger(args.element_index) || typeof args.observation_id !== "string") return errorResult({ message: "Provide both observation_id and element_index from get_app_state." });
    const operation = { click: "click", perform_secondary_action: "secondaryAction", select_text: "selectText", set_value: "setValue" }[name];
    if (!operation) return errorResult({ message: "This tool does not support accessibility element actions." });
    if (name === "click" && args.button && args.button !== "left") return errorResult({ message: "Use an exposed secondary action or screenshot coordinates for non-left clicks." });
    return callAction({ action: "elementAction", app: args.app, observationId: args.observation_id, element_index: args.element_index, operation, actionName: args.action, value: args.text, text: args.text, prefix: args.prefix, suffix: args.suffix, selectionType: args.selection_type || "text" });
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

/**
 * 이 실행이 우리가 만든 컴퓨터 유즈 드라이버인가.
 *
 * ★압축된 바이트를 비교하면 안 된다 (실측 2026-09-07, 오너 "컴퓨터 유즈를 못하네").
 *
 *   저장된 서버 행과 현재 빌드를 실제로 대조했더니:
 *     압축해제 소스 sha256   현재 2c22587e…5020  ==  저장 2c22587e…5020   (**바이트까지 동일**)
 *     base64 압축 payload    현재 6372자          !=  저장 6424자
 *   **gzip 출력은 재현되지 않는다.** zlib 버전이 바뀌면 같은 소스가 다른 바이트로 압축된다.
 *
 *   그래서 앱을 업데이트하면 설치된 cua-driver 행이 "위조"로 판정되고
 *   (mcp-config.ts / client.ts 가 이 함수로 거른다) MCP 설정에서 **통째로 빠진다.**
 *   화면에는 아무 오류도 안 뜬다 — 그냥 컴퓨터 유즈가 없어진다. One 과 Work 둘 다.
 *
 * 우리가 실제로 지키려는 것은 "저 인자가 **우리 코드**를 실행하는가"이지
 * "저 바이트가 오늘 빌드의 압축 결과와 같은가"가 아니다. 그러니 소스로 판정한다:
 *   ① 실행 파일이 지금 이 실행 파일이고
 *   ② 부트스트랩이 우리 것이며(그 안에 소스 해시 핀이 박혀 있다 — 런타임 검증의 주체)
 *   ③ payload 를 풀었을 때 **소스 해시가 우리 것과 같다**
 * 이 셋이면 압축 방식이 무엇이든 실행되는 코드는 우리 것이다. 압축 바이트 비교보다
 * 약해지지 않는다 — 오히려 우연한 재압축에 안 깨지면서 같은 것을 증명한다.
 */
export function isAuthenticComputerUseMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  if (!computerUseMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== INLINE_BOOTSTRAP) return false;
  return computerUseInlinePayloadDigest(args[2]) === SOURCE_SHA256;
}

/**
 * 인라인 payload 를 풀어 그 소스의 sha256 을 낸다. 못 풀면 null(짐작하지 않는다).
 * 부트스트랩과 같은 상한(131072)을 건다 — 압축 폭탄으로 메인 프로세스를 묶을 수 없다.
 */
export function computerUseInlinePayloadDigest(payloadBase64: string): string | null {
  try {
    if (typeof payloadBase64 !== "string" || payloadBase64.length > AGENTLAS_COMPUTER_USE_INLINE_ARGS_MAX_JSON_CHARS) return null;
    const source = gunzipSync(Buffer.from(payloadBase64, "base64"), { maxOutputLength: 131_072 });
    if (source.length > 131_072) return null;
    return createHash("sha256").update(source).digest("hex");
  } catch {
    return null;
  }
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
