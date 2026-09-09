import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { screen } from "electron";
import { checkComputerUsePermissions } from "../mac-permissions";
import { captureComputerUsePreview } from "./preview";
import { saveScreenCaptureArtifact } from "../media/capture-artifacts";
import { recordComputerHistoryCapture, recordComputerHistorySummary } from "../one/computer-history";
import { computerUseControlInfoPath } from "./channel";
import {
  invokeNativeInputDriver,
  nativeInputDriverAvailable,
  type NativeAppObservation,
  type NativeElementReference,
  type NativeInputAction,
  type NativeInputResult,
} from "./native-driver";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_AUDIT_ROWS = 200;
const MAX_OBSERVATIONS = 32;
const OBSERVATION_TTL_MS = 2 * 60 * 1000;

interface AuditRow {
  at: string;
  action: string;
  ok: boolean;
  error: string | null;
  textLength?: number;
}

interface Point {
  x: number;
  y: number;
}

let server: http.Server | null = null;
let boundPort = 0;
let token = "";
let actionQueue: Promise<unknown> = Promise.resolve();
const auditRows: AuditRow[] = [];
const sourceGeometries = new Map<string, {
  sourceId: string;
  frameWidth: number;
  frameHeight: number;
  bounds: { x: number; y: number; width: number; height: number };
}>();
const observations = new Map<string, {
  app: string;
  expiresAt: number;
  refs: NativeElementReference[];
}>();

function pruneObservations(now = Date.now()): void {
  for (const [id, observation] of observations) {
    if (observation.expiresAt <= now) observations.delete(id);
  }
}

function makeObservationCapacity(): void {
  while (observations.size >= MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value as string | undefined;
    if (!oldest) break;
    observations.delete(oldest);
  }
}

function serializeObservation(app: string, observation: NativeAppObservation): Record<string, unknown> {
  pruneObservations();
  makeObservationCapacity();
  const observationId = randomUUID();
  const elementIndexByPath = new Map(observation.elements.map((element, index) => [element.ref.path.join("/"), index]));
  observations.set(observationId, {
    app,
    expiresAt: Date.now() + OBSERVATION_TTL_MS,
    refs: observation.elements.map((element) => element.ref),
  });
  return {
    ok: true,
    observationId,
    capturedAt: observation.capturedAt,
    app: observation.app,
    truncated: observation.truncated,
    elements: observation.elements.map(({ ref, ...element }, element_index) => {
      const parentPath = ref.path.slice(0, -1).join("/");
      const parent_element_index = ref.path.length > 0 ? elementIndexByPath.get(parentPath) : undefined;
      return {
        element_index,
        depth: ref.path.length,
        ...(parent_element_index !== undefined ? { parent_element_index } : {}),
        ...element,
      };
    }),
  };
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) oversized = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return resolve(null);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function recordAudit(action: string, result: NativeInputResult, textLength?: number): void {
  auditRows.push({
    at: new Date().toISOString(),
    action,
    ok: result.ok,
    error: typeof result.error === "string" ? result.error.slice(0, 120) : null,
    ...(typeof textLength === "number" ? { textLength } : {}),
  });
  if (auditRows.length > MAX_AUDIT_ROWS) auditRows.splice(0, auditRows.length - MAX_AUDIT_ROWS);
  /*
   * ★기록이 동작을 죽이면 안 된다 (실측 2026-09-07).
   *
   * 이 호출이 동기로 던지면 recordAudit 가 던지고, 그러면 runAction 이 던지고,
   * /action 은 500 `action-failed` 로 끝난다 — **모든** 컴퓨터 유즈 동작이. 실측에서
   * 무해한 `move` 조차 action-failed 로 죽었고, 화면에는 이유가 한 글자도 안 나온다.
   * (같은 병을 /capture 에서도 잡았다: 캡처는 성공했는데 뒷정리가 던져 응답이 영영
   *  안 나가고 요청이 매달렸다.)
   *
   * Computer History 는 **동의 기반 부가 기록**이다. 저장소가 아직 안 열렸든 디스크가
   * 찼든, 사람이 시킨 동작의 성패를 쥘 이유가 없다.
   */
  try {
    // Computer History is opt-in inside the summary writer. We record the
    // observable action, never the screen pixels, coordinates, or credentials.
    void Promise.resolve(recordComputerHistorySummary({
      title: result.ok ? `Computer · ${action}` : `Computer action failed · ${action}`,
      body: result.ok ? `컴퓨터에서 ${action} 작업이 수행되었습니다.` : `컴퓨터에서 ${action} 작업이 실패했습니다.`,
      apps: [],
    })).catch(() => undefined);
  } catch {
    // 부가 기록 실패는 동작을 삼키지 않는다.
  }
}

function safeString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}

async function observeApp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const app = safeString(body.app, 160);
  const maxDepth = boundedInteger(body.maxDepth, 1, 32, 24);
  const maxNodes = boundedInteger(body.maxNodes, 1, 300, 200);
  if (!app) return { ok: false, error: "invalid-app", message: "app is required and must be under 160 characters." };
  if (maxDepth === null || maxNodes === null) {
    return { ok: false, error: "invalid-arguments", message: "maxDepth or maxNodes is outside the supported range." };
  }
  const result = await invokeNativeInputDriver({ action: "observeApp", app, maxDepth, maxNodes });
  recordAudit("observeApp", result);
  if (!result.ok || !result.observation) return result as unknown as Record<string, unknown>;
  return serializeObservation(app, result.observation);
}

function sourceGeometry(sourceId: string | null): {
  sourceId: string | null;
  frameWidth: number;
  frameHeight: number;
  bounds: { x: number; y: number; width: number; height: number };
} | null {
  if (sourceId) {
    const known = sourceGeometries.get(sourceId);
    if (known) return known;
  }
  /*
   * ★프레임 크기를 지어내지 않는다 (실측 2026-09-07).
   *
   * 예전에는 잰 적 없는 화면에도 `frameWidth: 1120, frameHeight: 700` 을 돌려줬다.
   * 그 700 은 우리가 **요청한** 썸네일 크기이고, 실제로 돌아오는 프레임은 화면 비율에
   * 맞춰 줄어든다 — 실측에서 1120×**630** 이었다. 그래서 같은 좌표가 이렇게 갈렸다:
   *     잰 기하로:  화면 중앙 y=540
   *     지어낸 값:  y=486        ← 10% 어긋난 자리를 누른다
   * 그리고 그 클릭은 **성공으로 보고된다.** 조용히 틀린 좌표는 실패보다 나쁘다:
   * 에이전트는 눌렀다고 믿고 다음 단계로 넘어간다.
   *
   * 프레임 좌표는 캡처가 있어야만 뜻이 있다. 잰 기하가 없으면 정직하게 없다고 답하고,
   * 호출자는 화면을 먼저 찍으면 된다(그때 sourceGeometries 가 채워진다).
   */
  return null;
}

function mapPoint(body: Record<string, unknown>, prefix = ""): Point | null {
  const x = finiteNumber(body[`${prefix}x`]);
  const y = finiteNumber(body[`${prefix}y`]);
  if (x === null || y === null) return null;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 256) : null;
  const geometry = sourceGeometry(sourceId);
  if (!geometry || x < 0 || y < 0 || x > geometry.frameWidth || y > geometry.frameHeight) return null;
  return {
    x: geometry.bounds.x + (x / geometry.frameWidth) * geometry.bounds.width,
    y: geometry.bounds.y + (y / geometry.frameHeight) * geometry.bounds.height,
  };
}

async function runAction(body: Record<string, unknown>): Promise<NativeInputResult> {
  const action = safeString(body.action, 40);
  if (!action) return { ok: false, error: "invalid-action", message: "A valid action is required." };

  const appName = body.app === undefined ? null : safeString(body.app, 160);
  if (body.app !== undefined && !appName) {
    return { ok: false, error: "invalid-app", message: "app must be under 160 characters." };
  }
  let observedElement: { observationId: string; ref: NativeElementReference } | null = null;
  if (action === "elementAction") {
    const observationId = safeString(body.observationId, 64);
    const elementIndex = boundedInteger(body.element_index, 0, 299, -1);
    pruneObservations();
    const observation = observationId ? observations.get(observationId) : undefined;
    if (!observationId || elementIndex === null || elementIndex < 0 || !observation) {
      return { ok: false, error: "invalid-observation", message: "Observe the app again and use an element index from that observation." };
    }
    if (observation.app !== appName) {
      return { ok: false, error: "observation-app-mismatch", message: "The observation belongs to a different app." };
    }
    const ref = observation.refs[elementIndex];
    if (!ref) return { ok: false, error: "invalid-element-index", message: "The element index is not present in this observation." };
    observedElement = { observationId, ref };
  }
  let targetPid: number | undefined;
  if (appName && action !== "focusApp" && action !== "listApps" && action !== "status") {
    const focused = await invokeNativeInputDriver({ action: "focusApp", app: appName });
    recordAudit("focusApp", focused);
    if (!focused.ok) return focused;
    if (typeof focused.pid === "number" && Number.isInteger(focused.pid) && focused.pid > 0) targetPid = focused.pid;
    if (action !== "elementAction") await new Promise((resolve) => setTimeout(resolve, 280));
  }

  let request: NativeInputAction | null = null;
  switch (action) {
    case "status": request = { action: "status" }; break;
    case "listApps": request = { action: "listApps" }; break;
    case "focusApp":
      if (appName) request = { action: "focusApp", app: appName };
      break;
    case "move": {
      const point = mapPoint(body);
      if (point) request = { action: "move", ...point };
      break;
    }
    case "click": {
      const point = mapPoint(body);
      const button = body.button === undefined ? "left" : body.button;
      const clickCount = boundedInteger(body.clickCount, 1, 2, 1);
      if (point && (button === "left" || button === "right" || button === "middle") && clickCount) {
        request = { action: "click", ...point, button, clickCount: clickCount as 1 | 2 };
      }
      break;
    }
    case "drag": {
      const from = mapPoint(body, "from_");
      const to = mapPoint(body, "to_");
      const durationMs = boundedInteger(body.durationMs, 50, 5_000, 450);
      const button = body.button === undefined ? "left" : body.button;
      if (from && to && durationMs && (button === "left" || button === "right" || button === "middle")) {
        request = {
          action: "drag",
          fromX: from.x,
          fromY: from.y,
          toX: to.x,
          toY: to.y,
          durationMs,
          button,
        };
      }
      break;
    }
    case "scroll": {
      const deltaX = boundedInteger(body.deltaX, -4_000, 4_000, 0);
      const deltaY = boundedInteger(body.deltaY, -4_000, 4_000, 0);
      if (deltaX !== null && deltaY !== null && (deltaX !== 0 || deltaY !== 0)) {
        request = { action: "scroll", deltaX, deltaY };
      }
      break;
    }
    case "typeText": {
      const value = safeString(body.text, 16 * 1024);
      if (value && Buffer.byteLength(value, "utf8") <= 16 * 1024) request = { action: "typeText", text: value, targetPid };
      break;
    }
    case "selectText": request = { action: "selectText", targetPid }; break;
    case "elementAction": {
      const operation = body.operation;
      if (!observedElement) return { ok: false, error: "invalid-observation", message: "Observe the app again." };
      if (operation !== "click" && operation !== "secondaryAction" && operation !== "setValue" && operation !== "selectText") {
        return { ok: false, error: "invalid-element-operation", message: "The requested element operation is unsupported." };
      }
      const actionName = body.actionName === undefined ? undefined : safeString(body.actionName, 120) ?? undefined;
      const valueCandidate = body.value === undefined ? undefined : boundedString(body.value, 16 * 1024);
      const value = valueCandidate === null ? undefined : valueCandidate;
      const selectedText = body.text === undefined ? undefined : safeString(body.text, 16 * 1024) ?? undefined;
      const prefixCandidate = body.prefix === undefined ? undefined : boundedString(body.prefix, 500);
      const suffixCandidate = body.suffix === undefined ? undefined : boundedString(body.suffix, 500);
      const prefix = prefixCandidate === null ? undefined : prefixCandidate;
      const suffix = suffixCandidate === null ? undefined : suffixCandidate;
      const selectionType = body.selectionType === undefined ? undefined : body.selectionType;
      if (body.actionName !== undefined && !actionName) return { ok: false, error: "invalid-arguments", message: "actionName was rejected." };
      if (valueCandidate === null) return { ok: false, error: "invalid-arguments", message: "value was rejected." };
      if (body.text !== undefined && !selectedText) return { ok: false, error: "invalid-arguments", message: "text was rejected." };
      if (prefixCandidate === null) return { ok: false, error: "invalid-arguments", message: "prefix was rejected." };
      if (suffixCandidate === null) return { ok: false, error: "invalid-arguments", message: "suffix was rejected." };
      if (selectionType !== undefined && selectionType !== "text" && selectionType !== "cursor_before" && selectionType !== "cursor_after") {
        return { ok: false, error: "invalid-arguments", message: "selectionType was rejected." };
      }
      request = {
        action: "elementAction",
        operation,
        ref: observedElement.ref,
        ...(actionName ? { actionName } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(selectedText ? { text: selectedText } : {}),
        ...(prefix !== undefined ? { prefix } : {}),
        ...(suffix !== undefined ? { suffix } : {}),
        ...(selectionType ? { selectionType } : {}),
      };
      // Every supported element operation can mutate state. Consume the opaque
      // observation before dispatch so retries cannot replay a stale element.
      observations.delete(observedElement.observationId);
      break;
    }
    case "key": {
      const key = safeString(body.key, 32);
      const modifiers = body.modifiers === undefined ? [] : body.modifiers;
      const repeat = boundedInteger(body.repeat, 1, 20, 1);
      if (key && Array.isArray(modifiers) && modifiers.length <= 5 && modifiers.every((value) => typeof value === "string" && value.length <= 16) && repeat) {
        request = { action: "key", key, modifiers: modifiers as string[], repeat };
      }
      break;
    }
  }

  if (!request) {
    /*
     * ★거절에는 푸는 길이 있어야 한다. 이 자리에서 압도적으로 흔한 사유는 "좌표는 왔는데
     * 그 화면을 잰 적이 없다"이다 — 프레임 좌표는 캡처가 있어야만 뜻이 있고, 잰 기하가
     * 없으면 mapPoint 가 null 을 돌려준다(예전에는 1120×700 을 지어내 10% 어긋난 자리를
     * 조용히 눌렀다). 그럴 땐 무엇을 하면 되는지 말한다: 화면을 먼저 찍어라.
     */
    const wantsPoint = finiteNumber(body.x) !== null && finiteNumber(body.y) !== null;
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;
    if (wantsPoint && !sourceGeometry(sourceId)) {
      return {
        ok: false,
        error: "screen-not-measured",
        message: "Capture the screen first: frame coordinates only mean something after get_screen, which measures this display.",
      };
    }
    return { ok: false, error: "invalid-arguments", message: "Computer Use action arguments were rejected." };
  }
  // App labels can alias the same process (localized name, bundle id, pid).
  // Conservatively invalidate every host observation after any mutation.
  if (action !== "status" && action !== "listApps" && action !== "move") observations.clear();
  const result = await invokeNativeInputDriver(request);
  recordAudit(action, result, action === "typeText" && typeof body.text === "string" ? body.text.length : undefined);
  return result;
}

function writePrivateInfoFile(): void {
  const infoPath = computerUseControlInfoPath();
  const infoDir = path.dirname(infoPath);
  fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(infoDir, 0o700);
  const temp = `${infoPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port: boundPort, token }), { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, infoPath);
  if (process.platform !== "win32") fs.chmodSync(infoPath, 0o600);
}

export function startComputerUseControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (process.platform !== "darwin") return Promise.resolve(0);
  token = randomUUID();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 404, { ok: false, error: "not-found" });
        return;
      }
      void readJsonBody(req).then((body) => {
        if (!body) {
          writeJson(res, 400, { ok: false, error: "invalid-request" });
          return;
        }
        if (req.url === "/status") {
          const permissions = checkComputerUsePermissions();
          writeJson(res, 200, {
            ok: true,
            available: nativeInputDriverAvailable(),
            platform: process.platform,
            accessibility: permissions.accessibility,
            screenRecording: permissions.screenRecording,
          });
          return;
        }
        if (req.url === "/capture") {
          const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 256) : undefined;
          void captureComputerUsePreview(sourceId).then((preview) => {
            for (const source of preview.sources) {
              if (source.bounds && source.width > 0 && source.height > 0) {
                sourceGeometries.set(source.id, {
                  sourceId: source.id,
                  frameWidth: source.width,
                  frameHeight: source.height,
                  bounds: source.bounds,
                });
              }
            }
            // 이 라우트는 에이전트(MCP get_screen/get_app_state) 전용이다 — 라이브
            // 미리보기 패널은 IPC로 captureComputerUsePreview 를 직접 부르므로 여기서
            // 저장해도 틱마다 디스크가 불지 않는다. 채팅에 보일 수 있는 캡처는
            // 반드시 정본 파일을 남기고, 그 절대경로(savedPath)를 모델에게 알린다.
            /*
             * ★화면은 이미 찍혔다. 뒷정리가 실패해도 **답은 반드시 나간다.**
             *
             * 실측 2026-09-07: 이 두 줄(증거 파일 저장 · 히스토리 기록) 중 하나가 던지면
             * onFulfilled 가 중단되어 `writeJson` 에 도달하지 못하고, 그 실패는 아래
             * onRejected 가 아니라 **아무도 안 잡는 rejection** 이 된다(`void` 로 버려진다).
             * 결과: HTTP 응답이 영영 안 나가고 요청이 매달린다. 에이전트에게는
             * "Computer Use request timed out." 으로만 보인다 — 화면은 멀쩡히 찍혔는데.
             * (프로브 실측: /status 200, /capture 는 8초 무응답.)
             *
             * 증거 저장과 히스토리는 부가 기능이다. 도구 호출의 성패를 쥐면 안 된다.
             */
            let savedPath: string | null = null;
            try {
              savedPath = saveScreenCaptureArtifact(preview.dataUrl);
            } catch {
              // 증거 파일을 못 남겨도 에이전트는 화면을 받아야 한다.
            }
            try {
              // Computer History has a separate, explicit-consent retention
              // policy. General CUA evidence remains governed by its own 300-file
              // cap; only an opted-in capture receives the seven-day local copy.
              recordComputerHistoryCapture(preview.dataUrl);
            } catch {
              // 보관은 동의 기반 부가 기능이다 — 실패해도 캡처를 삼키지 않는다.
            }
            writeJson(res, 200, { ok: true, preview: savedPath ? { ...preview, savedPath } : preview });
          }, () => {
            writeJson(res, 500, { ok: false, error: "capture-failed" });
          }).catch(() => {
            // 여기까지 왔다면 응답 쓰기 자체가 실패한 것이다. 그래도 매달아 두지 않는다.
            try { writeJson(res, 500, { ok: false, error: "capture-failed" }); } catch { /* 소켓이 이미 닫혔다 */ }
          });
          return;
        }
        if (req.url === "/observe") {
          const execute = actionQueue.then(() => observeApp(body), () => observeApp(body));
          actionQueue = execute.then(() => undefined, () => undefined);
          void execute.then((result) => writeJson(res, result.ok ? 200 : 409, result), () => {
            writeJson(res, 500, { ok: false, error: "observe-failed" });
          });
          return;
        }
        if (req.url === "/action") {
          const execute = actionQueue.then(() => runAction(body), () => runAction(body));
          actionQueue = execute.then(() => undefined, () => undefined);
          void execute.then((result) => writeJson(res, result.ok ? 200 : 409, result), () => {
            writeJson(res, 500, { ok: false, error: "action-failed" });
          });
          return;
        }
        if (req.url === "/logs") {
          writeJson(res, 200, { ok: true, logs: auditRows.slice(-100) });
          return;
        }
        writeJson(res, 404, { ok: false, error: "not-found" });
      });
    });

    srv.on("error", () => {
      server = null;
      boundPort = 0;
      resolve(0);
    });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      try {
        writePrivateInfoFile();
      } catch (error) {
        console.error("[computer-use] capability file failed:", error);
        try { srv.close(); } catch { /* ignore */ }
        server = null;
        boundPort = 0;
      }
      resolve(boundPort);
    });
  });
}

export function stopComputerUseControlServer(): void {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  server = null;
  boundPort = 0;
  token = "";
  auditRows.length = 0;
  sourceGeometries.clear();
  observations.clear();
  try { fs.rmSync(computerUseControlInfoPath(), { force: true }); } catch { /* ignore */ }
}
