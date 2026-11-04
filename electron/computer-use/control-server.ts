import { captureOneContextExecution } from "../one/context-platform";
import { configuredOneOsLeaseBroker, oneOsLeaseBroker, markOneOsHostAvailable, HUMAN_INPUT_ACTION_WAIT_MS, HUMAN_INPUT_ARRANGE_WAIT_MS } from "../one/context-lease";
import { handleNativeGuestComputerUse, revokeNativeGuestComputerUseScopes } from "./native-guest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
  type NativeObservedElement,
  type NativeInputAction,
  type NativeInputResult,
} from "./native-driver";
import { currentUiLocale } from "../ui-locale";
import { checkComputerUseWindowScope } from "./window-scope";
import { supervisorDock } from "./supervisor-dock";
import { invalidValueMessage } from "../../shared/did-you-mean";
import { abortableDelay, assertRequestCurrent, linkedAbortSignals } from "./request-lifetime";
import { learnTap } from "./learn-tap";
import { launchApp, waitUntil } from "../reach/launch";
import { nodeExec } from "../reach/host";
import { isSensitiveApp } from "../reach/explore-policy";

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
let starting: Promise<number> | null = null;
let generation = 0;
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
  labels: ElementLabel[];
  frames: Array<{x:number;y:number;width:number;height:number}|undefined>;
}>();
/**
 * What each observed element was (role and captions, never a value), kept after the observation itself is consumed or the screen moved.
 * An element index from an earlier observation is then found again by what it is on the fresh tree, instead of ending the call with
 * "stale-element-reference" / "invalid-observation" (observed in use: two clicks on the owner's own Agentlas window failed this way).
 */
interface ElementLabel { role: string; subrole?: string; title?: string; description?: string; lineage: string }
const retiredObservations = new Map<string, { app: string; expiresAt: number; labels: ElementLabel[]; frames: Array<{x:number;y:number;width:number;height:number}|undefined> }>();
function retireObservations(): void {
  const now = Date.now();
  for (const [id, observation] of observations) {
    retiredObservations.delete(id);
    retiredObservations.set(id, { app: observation.app, expiresAt: now + OBSERVATION_TTL_MS, labels: observation.labels, frames: observation.frames });
  }
  observations.clear();
  for (const [id, retired] of retiredObservations) if (retired.expiresAt <= now) retiredObservations.delete(id);
  while (retiredObservations.size > MAX_OBSERVATIONS) { const oldest = retiredObservations.keys().next().value as string | undefined; if (!oldest) break; retiredObservations.delete(oldest); }
}
/** What encloses an element, nearest three ancestors (role and caption): the same caption inside another window or panel is another control. */
function lineages(elements: readonly NativeObservedElement[]): string[] {
  const byPath = new Map(elements.map((element) => [element.ref.path.join("/"), element]));
  return elements.map((element) => {
    const chain: string[] = [];
    for (let length = element.ref.path.length - 1; length >= 0 && chain.length < 3; length -= 1) {
      const ancestor = byPath.get(element.ref.path.slice(0, length).join("/"));
      if (ancestor) chain.push(`${ancestor.role}|${ancestor.title ?? ancestor.description ?? ""}`);
    }
    return `${element.ref.path.length}:${chain.join("/")}`;
  });
}
const labelsOf = (elements: readonly NativeObservedElement[]): ElementLabel[] => {
  const lineage = lineages(elements);
  return elements.map((element, index) => ({ role: element.role, ...(element.subrole ? { subrole: element.subrole } : {}), ...(element.title ? { title: element.title } : {}), ...(element.description ? { description: element.description } : {}), lineage: lineage[index] }));
};
/** The one element of a fresh observation that is what the label says; null when none or several fit (a wrong press is worse than a refusal). */
function findByLabel(observation: NativeAppObservation, label: ElementLabel): NativeElementReference | null {
  if (!label.title && !label.description) return null;
  const fresh = labelsOf(observation.elements);
  const same = observation.elements.filter((element, index) => fresh[index].role === label.role && (fresh[index].subrole ?? "") === (label.subrole ?? "")
    && (fresh[index].title ?? "") === (label.title ?? "") && (fresh[index].description ?? "") === (label.description ?? "") && fresh[index].lineage === label.lineage);
  return same.length === 1 ? same[0].ref : null;
}
const pendingRequests = new Set<AbortController>();

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
  // Reach's learning (reach/learn-recorder.ts) sees the observed controls' roles and captions, never more; a no-op unless the owner's Reach switch is on.
  if (learnTap.active()) {
    learnTap.observed({
      app, ...(observation.app.bundleIdentifier ? { bundleId: observation.app.bundleIdentifier } : {}), observationId, at: Date.now(),
      elements: observation.elements.map((element, index) => {
        const parent = element.ref.path.length > 0 ? elementIndexByPath.get(element.ref.path.slice(0, -1).join("/")) : undefined;
        const label = element.title ?? element.description;
        return { index, role: element.role, ...(label ? { label } : {}), ...(element.value !== undefined ? { value: element.value } : {}), ...(parent !== undefined ? { parent } : {}) };
      }),
    });
  }
  observations.set(observationId, {
    app,
    expiresAt: Date.now() + OBSERVATION_TTL_MS,
    refs: observation.elements.map((element) => element.ref),
    labels: labelsOf(observation.elements),
    frames: observation.elements.map((element) => element.frame),
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
      body: currentUiLocale() === "ko"
        ? (result.ok ? `컴퓨터에서 ${action} 작업이 수행되었습니다.` : `컴퓨터에서 ${action} 작업이 실패했습니다.`)
        : (result.ok ? `The ${action} action ran on the computer.` : `The ${action} action failed on the computer.`),
      apps: [],
    })).catch(() => undefined);
  } catch {
    // 부가 기록 실패는 동작을 삼키지 않는다.
  }
}

/**
 * Supervisor right-dock (electron/computer-use/supervisor-dock.ts): only a supervisor-run execution carries a scoped
 * capability, so a bearer-authorized tool call from any other agent never docks anything. Cosmetic and best effort:
 * an unreadable capability simply means no dock; it never changes the outcome of the action.
 */
function dockRunOf(capability: unknown): { runId: string; hasContextGrant: boolean } | null {
  if (capability === undefined || !supervisorDock()) return null;
  try { const binding = oneOsLeaseBroker().executionBinding(capability); return { runId: binding.runId, hasContextGrant: Boolean(binding.contextGrantId) }; }
  catch { return null; }
}
/** A refusal the One OS lease, the context grant or the request lifetime raised with its own code. */
function typedOsRefusal(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  return /^(?:one-os-|one-context-|computer-use-request-aborted$)/.test(code);
}
/**
 * What a typed refusal means and what to do next, in words. The code alone ("one-os-human-active") reached the owner's chat verbatim
 * (observed in use: Hope told the owner to "finish using the computer and ask again"). The code stays last, for diagnostics.
 */
const OS_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  "one-os-human-active": "The owner is typing or moving the mouse right now, so this step was held back (nothing was pressed). Wait about ten seconds and repeat the same call; only if it is still refused after a minute, say the owner is using the computer.",
  "one-os-resource-busy": "Another run is using the screen at this moment. Wait a few seconds and repeat the same call.",
  "one-os-session-unavailable": "The screen is locked or asleep, so nothing can be pressed now. Do the parts that need no screen and continue when it is unlocked.",
  "one-os-lease-expired": "The screen turn ended before this step ran (nothing was pressed). Repeat the call.",
  "one-os-lease-unavailable": "The screen turn ended before this step ran (nothing was pressed). Repeat the call.",
  "one-os-target-not-foreground": "That app is not in front. Call focus_app with the app name, then repeat the call.",
  "one-os-target-unavailable": "That app has no window on screen. Call focus_app with the app name (it opens the app when it is not running), then repeat the call.",
  "one-os-target-identity-changed": "The app restarted since it was looked at. Call get_app_state again and use the new element indices.",
  "one-os-window-changed": "The app's front window changed. Call get_app_state again and use the new element indices.",
  "one-os-window-not-foreground": "That window is not in front. Call focus_app with the app name, then repeat the call.",
  "one-os-input-unavailable": "Screen control is not ready on this computer (a macOS permission is missing). Say so plainly: the owner enables Accessibility for Agentlas in System Settings > Privacy & Security.",
  "one-os-input-permission-denied": "This run may only look at the screen, not press anything. Say that pressing needs the run's write permission.",
  "one-os-element-frame-unavailable": "That element's position is not known. Call get_app_state again and use the new element indices.",
  "one-os-action-target-required": "Name the app to act on (the app argument).",
  "one-os-execution-capability-unavailable": "This screen turn has ended (the run was stopped, finished or restarted), so nothing was pressed. Continue without the screen, or start the step again from a new turn.",
  "one-os-execution-revoked": "This screen turn has ended (the run was stopped, finished or restarted), so nothing was pressed. Continue without the screen, or start the step again from a new turn.",
  "one-os-execution-capability-invalid": "This screen turn could not be confirmed, so nothing was pressed. Repeat the call once; if it fails again, continue without the screen.",
  "one-os-authority-unavailable": "Screen control could not be confirmed for this run. Repeat the call once; if it fails again, continue without the screen.",
};
function osFailure(error: unknown): NativeInputResult {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "one-os-authority-unavailable";
  const text = OS_REFUSAL_TEXT[code];
  return { ok: false, error: code, ...(text ? { message: `${text} [${code}]` } : {}) };
}
const NOT_RUNNING_HINT = " If you meant to open it, call focus_app with the same app name: it opens an app that is not running.";
/** A native answer "no such running app" with the one step that fixes it (the sentence the classifier keys on stays first). */
function withOpenHint<T extends { ok?: unknown; error?: unknown; message?: unknown }>(result: T): T {
  return result.ok === false && result.error === "app-not-found" && typeof result.message === "string" && !result.message.includes("focus_app")
    ? { ...result, message: `${result.message}${NOT_RUNNING_HINT}` } : result;
}
const BUNDLE_LIKE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;
const APP_OPEN_WAIT_MS = 6_000;
/**
 * focus_app on an app that is not running opens it first (macOS). An app the owner asked to "open" had no tool that could open it:
 * "No running application matched" (14 times in 14 days, Calculator) and the run fell back to typing into Spotlight. Only focus_app does
 * this, never an observation: get_app_state on an app that is gone stays an honest answer ("check that it closed"). Not for a read-only
 * run, a window-scoped grant, a pid target, an app Reach treats as sensitive, or a machine with too many apps to prove "not running".
 * Returns whether an app was opened.
 */
async function openAppIfNotRunning(appName: string, body: Record<string, unknown>, signal: AbortSignal, deps: { listApps?: () => Promise<NativeInputResult>; windows?: () => Promise<NativeInputResult>; exec?: typeof nodeExec; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  if (process.platform !== "darwin" || /^pid:/i.test(appName) || appName.startsWith("native-guest:")) return false;
  if (body.oneOsExecution !== undefined) {
    const binding = oneOsLeaseBroker().executionBinding(body.oneOsExecution);
    if (binding.permissions === "read" || binding.contextGrantId) return false;
  }
  const listApps = deps.listApps ?? (() => invokeNativeInputDriver({ action: "listApps" }, undefined, signal));
  const windows = deps.windows ?? (() => invokeNativeInputDriver({ action: "listCaptureTargets" }, undefined, signal));
  const wanted = appName.normalize("NFC").toLowerCase().replace(/\.app$/, "");
  type Row = { name?: unknown; appName?: unknown; bundleIdentifier?: unknown; pid?: unknown };
  const sameApp = (row: Row) =>
    [row.name, row.appName, row.bundleIdentifier].some((value) => typeof value === "string" && value.normalize("NFC").toLowerCase().replace(/\.app$/, "") === wanted);
  const first = await listApps();
  const apps = Array.isArray(first.apps) ? first.apps as Row[] : null;
  if (!first.ok || !apps || apps.length >= 100 || apps.some(sameApp)) return false;
  // The owner types "Calculator" and the helper reports the localized name (계산기): the app that appears after the open is the one that was asked for.
  const before = new Set(apps.map((row) => row.pid));
  const ours = (row: Row) => sameApp(row) || (typeof row.pid === "number" && !before.has(row.pid));
  const bundleId = BUNDLE_LIKE.test(appName) && !/\.app$/i.test(appName) ? appName : undefined;
  if (isSensitiveApp({ name: appName, ...(bundleId ? { bundleId } : {}) })) return false;
  const opened = await launchApp(deps.exec ?? nodeExec, { name: appName.replace(/\.app$/i, ""), ...(bundleId ? { bundleId } : {}) }, "darwin");
  if (!opened) return false;
  const sleep = deps.sleep;
  const running = async () => { const now = await listApps(); return Array.isArray(now.apps) && (now.apps as Row[]).some(ours); };
  if (!await waitUntil(running, { withinMs: APP_OPEN_WAIT_MS, signal, ...(sleep ? { sleep } : {}) })) return false;
  // a window to act on: most apps draw theirs within a second; a menu-bar app has none and is acted on as it is
  await waitUntil(async () => { const now = await windows(); return Array.isArray(now.targets) && (now.targets as Row[]).some(ours); }, { withinMs: 3_000, signal, ...(sleep ? { sleep } : {}) });
  return true;
}
/** Waits (bounded) for another run's screen turn to end instead of refusing; the owner's own input is judged by settleHumanInput, not here. */
async function whileBusy<T>(attempt: () => Promise<T> | T, signal: AbortSignal, withinMs = 10_000): Promise<T> {
  for (let waited = 0; ; waited += 250) {
    try { return await attempt(); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code !== "one-os-resource-busy" || waited >= withinMs) throw error;
      await abortableDelay(250, signal);
    }
  }
}
function executionLifetime(body: Record<string, unknown>, signal?: AbortSignal) {
  assertRequestCurrent(signal);
  return linkedAbortSignals([signal, body.oneOsExecution === undefined ? undefined : oneOsLeaseBroker().executionSignal(body.oneOsExecution)]);
}
async function observationAuthority(body:Record<string,unknown>):Promise<{assertCurrent():void;binding?:import("../one/context-lease").OneOsExecutionBinding}> {
  if(body.oneOsExecution!==undefined)return oneOsLeaseBroker().authorizeObservation(body.oneOsExecution,{appTarget:typeof body.app==="string"?body.app:undefined,sourceId:typeof body.sourceId==="string"?body.sourceId:undefined});
  return {assertCurrent:()=>{if(configuredOneOsLeaseBroker()?.snapshot().state==="held")throw Object.assign(new Error("one-os-resource-busy"),{code:"one-os-resource-busy"});}};
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

/** A size limit the model asked for, read as the largest the host allows when it asks for more (and the smallest when for less). */
function clampedInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

async function observeApp(body: Record<string, unknown>, requestSignal?: AbortSignal): Promise<Record<string, unknown>> {
  // A capability that was revoked (the run ended, was stopped or restarted) is a typed refusal here, not a thrown 500 "observe-failed".
  let lifetime: ReturnType<typeof executionLifetime>;
  try { lifetime = executionLifetime(body, requestSignal); } catch (error) { return osFailure(error) as unknown as Record<string, unknown>; }
  try { return await observeAppWithin(body, lifetime.signal); } finally { lifetime.dispose(); }
}
async function observeAppWithin(body: Record<string, unknown>, requestSignal: AbortSignal): Promise<Record<string, unknown>> {
  assertRequestCurrent(requestSignal);
  const app = safeString(body.app, 160);
  // maxDepth 16 with maxNodes 450 was refused (4 of 4 in 14 days; 1500, 1000, 500 in 2026-10-05): the intent is "a large tree", so a limit above the
  // host's range is the host's range, not an error. Only a value that is no number at all is refused.
  const maxDepth = clampedInteger(body.maxDepth, 1, 32, 24);
  const maxNodes = clampedInteger(body.maxNodes, 1, 300, 200);
  if (!app) return { ok: false, error: "invalid-app", message: "app is required and must be under 160 characters." };
  if (maxDepth === null || maxNodes === null) {
    return { ok: false, error: "invalid-arguments", message: "maxDepth and maxNodes must be numbers (the host uses 1-32 and 1-300; omit them for 24 and 200)." };
  }
  const denied = await checkComputerUseWindowScope({ route: "observe", app });
  assertRequestCurrent(requestSignal);
  if (denied) { recordAudit("observeApp", denied as NativeInputResult); return denied; }
  let authority;try {authority=await observationAuthority(body);authority.assertCurrent();}catch(error){return osFailure(error) as unknown as Record<string,unknown>;}
  const scopedDockRun = dockRunOf(body.oneOsExecution);
  let lease: { signal: AbortSignal; checkpoint(): Promise<void>; release(): void } | undefined;
  let nativeLifetime: ReturnType<typeof linkedAbortSignals> | undefined;
  const checkpoint = async () => { assertRequestCurrent(requestSignal); authority.assertCurrent(); await lease?.checkpoint(); assertRequestCurrent(requestSignal); };
  try {
    // Keep the existing first-observation dock, but only an input-authorized
    // execution may rearrange windows, under the same human/resource fence.
    const readOnly = authority.binding?.permissions === "read";
    // Arranging the windows needs the input lease; observing does not (observationAuthority above admitted it). A lease the target
    // cannot have right now (it is not in front, the owner is typing, another run holds it) skips the arrangement and the app is
    // still observed. e8be532bc made every observation of an app behind the One window fail with a bare 500 "observe-failed".
    let arrange = Boolean(scopedDockRun);
    if (scopedDockRun && !readOnly) {
      const broker = configuredOneOsLeaseBroker()?.forRequest(requestSignal);
      await broker?.settleHumanInput(HUMAN_INPUT_ARRANGE_WAIT_MS);
      try { lease = await oneOsLeaseBroker().acquireForAction(body.oneOsExecution, { appTarget: app }); }
      catch (error) { if (!typedOsRefusal(error)) throw error; arrange = false; }
    }
    nativeLifetime = linkedAbortSignals([requestSignal, lease?.signal]);
    await checkpoint();
    const dockRun = scopedDockRun && arrange ? { ...scopedDockRun, hasContextGrant: scopedDockRun.hasContextGrant || readOnly, signal: nativeLifetime.signal, checkpoint } : null;
    if (dockRun) { const docked = await supervisorDock()?.begin({ ...dockRun, app }); await checkpoint(); if (docked?.layoutChanged) sourceGeometries.clear(); }
    const result = await invokeNativeInputDriver({ action: "observeApp", app, maxDepth, maxNodes }, undefined, nativeLifetime.signal);
    await checkpoint();
    recordAudit("observeApp", result);
    if (!result.ok || !result.observation) return withOpenHint(result) as unknown as Record<string, unknown>;
    return serializeObservation(app, result.observation);
  } catch (error) {
    // A typed refusal (the owner started typing, the lease ended, the request was stopped) is answered with its code, not a 500.
    if (typedOsRefusal(error)) return osFailure(error) as unknown as Record<string, unknown>;
    throw error;
  } finally { nativeLifetime?.dispose(); lease?.release(); }
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

async function runAction(body: Record<string, unknown>, requestSignal?: AbortSignal): Promise<NativeInputResult> {
  // See observeApp: a revoked capability answers with its code and words, not "action-failed".
  let lifetime: ReturnType<typeof executionLifetime>;
  try { lifetime = executionLifetime(body, requestSignal); } catch (error) { return osFailure(error); }
  try { return await runActionWithin(body, lifetime.signal); } finally { lifetime.dispose(); }
}
async function runActionWithin(body: Record<string, unknown>, requestSignal: AbortSignal): Promise<NativeInputResult> {
  assertRequestCurrent(requestSignal);
  const action = safeString(body.action, 40);
  if (!action) return { ok: false, error: "invalid-action", message: "A valid action is required." };

  const appName = body.app === undefined ? null : safeString(body.app, 160);
  if (body.app !== undefined && !appName) {
    return { ok: false, error: "invalid-app", message: "app must be under 160 characters." };
  }
  // The fallback ladder's "our Chrome window only" grant is checked before anything is dispatched, including
  // the focusApp pre-step below (focusing another app is itself an effect).
  {
    const points = [mapPoint(body), mapPoint(body, "from_"), mapPoint(body, "to_")].filter((point): point is Point => point !== null);
    const denied = await checkComputerUseWindowScope({ route: "action", action, app: body.app, points });
    if (denied) { recordAudit(action, denied as NativeInputResult); return denied; }
  }
  let observedElement: { observationId: string; ref: NativeElementReference | null; label: ElementLabel } | null = null;
  if (action === "elementAction") {
    const observationId = safeString(body.observationId, 64);
    const elementIndex = boundedInteger(body.element_index, 0, 299, -1);
    pruneObservations();
    const observation = observationId ? observations.get(observationId) : undefined;
    // An observation used up by an earlier action (or past its time) still says what its elements were: the element is found again below.
    const retired = observationId && !observation ? retiredObservations.get(observationId) : undefined;
    if (retired && retired.expiresAt <= Date.now()) retiredObservations.delete(observationId!);
    const known = observation ?? (retired && retired.expiresAt > Date.now() ? retired : undefined);
    if (!observationId || elementIndex === null || elementIndex < 0 || !known) {
      return { ok: false, error: "invalid-observation", message: "That observation is too old to reuse. Call get_app_state again and use an element index from the new observation." };
    }
    if (known.app !== appName) {
      return { ok: false, error: "observation-app-mismatch", message: "The observation belongs to a different app." };
    }
    const label = known.labels[elementIndex];
    if (!label) return { ok: false, error: "invalid-element-index", message: "The element index is not present in this observation." };
    observedElement = { observationId, ref: observation ? observation.refs[elementIndex] : null, label };
  }
  let targetPid: number | undefined;
  const dockRun = dockRunOf(body.oneOsExecution);
  const dockElementFrame = dockRun && action === "elementAction" && observedElement
    ? (observations.get(observedElement.observationId) ?? retiredObservations.get(observedElement.observationId))?.frames[Number(body.element_index)] : undefined;

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
        return { ok: false, error: "invalid-arguments", message: invalidValueMessage("selectionType", selectionType, ["text", "cursor_before", "cursor_after"]) };
      }
      request = {
        action: "elementAction",
        operation,
        ref: observedElement.ref ?? ({} as NativeElementReference),
        ...(actionName ? { actionName } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(selectedText ? { text: selectedText } : {}),
        ...(prefix !== undefined ? { prefix } : {}),
        ...(suffix !== undefined ? { suffix } : {}),
        ...(selectionType ? { selectionType } : {}),
      };
      // Every supported element operation can mutate state. Consume the opaque
      // observation before dispatch so retries cannot replay a stale element.
      // Consumed immediately before the leased dispatch below.
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
    const geometry = sourceGeometry(sourceId);
    if (geometry) {
      for (const prefix of ["", "from_", "to_"]) {
        const px = finiteNumber(body[`${prefix}x`]), py = finiteNumber(body[`${prefix}y`]);
        if (px !== null && py !== null && (px < 0 || py < 0 || px > geometry.frameWidth || py > geometry.frameHeight)) {
          return { ok: false, error: "point-outside-frame", message: `The point (${Math.round(px)}, ${Math.round(py)}) is outside the captured screen image, which is ${geometry.frameWidth} x ${geometry.frameHeight}. Coordinates are pixels of the latest get_screen image; use a point inside it, or prefer an element from get_app_state.` };
        }
      }
    }
    if (wantsPoint && !geometry) {
      return {
        ok: false,
        error: "screen-not-measured",
        message: "Capture the screen first: frame coordinates only mean something after get_screen, which measures this display.",
      };
    }
    // A mouse button outside left/right/middle is the one enum a click or drag takes: name it and the closest.
    if ((action === "click" || action === "drag") && body.button !== undefined && body.button !== "left" && body.button !== "right" && body.button !== "middle") {
      return { ok: false, error: "invalid-arguments", message: invalidValueMessage("button", body.button, ["left", "right", "middle"]) };
    }
    return { ok: false, error: "invalid-arguments", message: "Computer Use action arguments were rejected." };
  }
  let lease: {signal?:AbortSignal;checkpoint():Promise<void>;release():void}|undefined;
  let actionTarget:import("../one/context-lease").OneOsActionTarget|undefined;
  let nativeLifetime: ReturnType<typeof linkedAbortSignals> | undefined;
  const checkpoint = async () => {
    assertRequestCurrent(requestSignal);
    await lease?.checkpoint();
    assertRequestCurrent(requestSignal);
  };
  const nativeSignal = () => (nativeLifetime ??= linkedAbortSignals([requestSignal, lease?.signal])).signal;
  try {
    assertRequestCurrent(requestSignal);
    // focus_app on an app that is not open: open it first (see openAppIfNotRunning).
    if (action === "focusApp" && appName) { await openAppIfNotRunning(appName, body, requestSignal); assertRequestCurrent(requestSignal); }
    if(action!=="status" && action!=="listApps") {
      const broker=configuredOneOsLeaseBroker()?.forRequest(requestSignal);
      await broker?.settleHumanInput(HUMAN_INPUT_ACTION_WAIT_MS);
      assertRequestCurrent(requestSignal);
      if(body.oneOsExecution!==undefined) {
        if(!appName)return {ok:false,error:"one-os-action-target-required"};
        const points=[mapPoint(body),mapPoint(body,"from_"),mapPoint(body,"to_")].filter((point):point is Point=>point!==null);
        const frame=action==="elementAction" && observedElement ? (observations.get(observedElement.observationId) ?? retiredObservations.get(observedElement.observationId))?.frames[Number(body.element_index)] : undefined;
        if(action==="elementAction"&&oneOsLeaseBroker().hasContextGrant(body.oneOsExecution)&&!frame)return {ok:false,error:"one-os-element-frame-unavailable"};
        // Explicit focus tool or an owner-selected interaction scope may activate its exact target.
        actionTarget={appTarget:appName,allowFocus:action==="focusApp" || oneOsLeaseBroker().hasContextGrant(body.oneOsExecution),sourceId:typeof body.sourceId==="string"?body.sourceId:undefined,points,...(frame?{elementFrame:frame}:{})};
        const target=actionTarget;
        lease=await whileBusy(()=>oneOsLeaseBroker().acquireForAction(body.oneOsExecution,target),requestSignal);
      } else if(broker)lease=await whileBusy(()=>broker.acquireLegacyAction(),requestSignal);
      await checkpoint();
      if(appName && action!=="focusApp" && (body.oneOsExecution===undefined || actionTarget?.allowFocus)) {
        const focused=await invokeNativeInputDriver({action:"focusApp",app:actionTarget?.resolvedPid?`pid:${actionTarget.resolvedPid}`:appName,...(actionTarget?{windowId:actionTarget.resolvedWindowId,processStartMs:actionTarget.resolvedProcessStartMs}:{})},undefined,nativeSignal());
        if(actionTarget)actionTarget.allowFocus=false;
        await checkpoint();recordAudit("focusApp",focused);if(!focused.ok)return withOpenHint(focused);
        if(typeof focused.pid==="number"&&Number.isInteger(focused.pid)&&focused.pid>0)targetPid=focused.pid;
        if(request.action==="typeText"||request.action==="selectText")request={...request,...(targetPid?{targetPid}:{})};
        if(action!=="elementAction")await new Promise(resolve=>setTimeout(resolve,280));
      }
      if(dockRun && appName && action!=="focusApp") {
        // Right-dock layout before the first effect on this app. Screen points were mapped from a capture taken before
        // the windows moved, so a point action stops here and asks for a fresh capture instead of pressing a stale spot.
        const docked=await supervisorDock()?.begin({...dockRun,app:targetPid?`pid:${targetPid}`:actionTarget?.resolvedPid?`pid:${actionTarget.resolvedPid}`:appName,signal:nativeSignal(),checkpoint});
        await checkpoint();
        if(docked?.layoutChanged){
          sourceGeometries.clear();
          if(request.action==="move"||request.action==="click"||request.action==="drag")return {ok:false,error:"screen-layout-changed",message:"The windows were just arranged beside the assistant panel. Capture the screen again, then repeat this action."};
        }
      }
    } else if(body.oneOsExecution!==undefined) { const authority=await observationAuthority(body);authority.assertCurrent(); }
    await checkpoint();
    if(action!=="status"&&action!=="listApps"&&action!=="move")retireObservations();
    if(request.action==="focusApp" && actionTarget)request={...request,app:`pid:${actionTarget.resolvedPid}`,windowId:actionTarget.resolvedWindowId,processStartMs:actionTarget.resolvedProcessStartMs};
    if(dockRun){
      const dock=supervisorDock();
      if(request.action==="move"||request.action==="click")dock?.pointer({x:request.x,y:request.y});
      else if(request.action==="drag")dock?.pointer({x:request.toX,y:request.toY});
      else if(dockElementFrame)dock?.pointer({x:dockElementFrame.x+dockElementFrame.width/2,y:dockElementFrame.y+dockElementFrame.height/2});
    }
    // An element from an observation the screen has since moved on from is found again by what it is (role and captions) on a fresh
    // read of the same app; one that cannot be told from another is refused as before. Reading does not need the owner's screen turn.
    const reresolve=async():Promise<NativeElementReference|null>=>{
      if(!observedElement||!appName)return null;
      const fresh=await invokeNativeInputDriver({action:"observeApp",app:appName,maxDepth:32,maxNodes:300},undefined,nativeSignal());
      return fresh.ok&&fresh.observation?findByLabel(fresh.observation,observedElement.label):null;
    };
    if(request.action==="elementAction"&&observedElement&&!observedElement.ref){
      const found=await reresolve();assertRequestCurrent(requestSignal);
      if(!found)return {ok:false,error:"stale-element-reference",message:"That element could not be found again on the app's current screen. Call get_app_state again and use the new element indices."};
      observedElement.ref=found;request={...request,ref:found};
    }
    const result=await invokeNativeInputDriver(request,undefined,nativeSignal());
    if(request.action==="elementAction"&&observedElement&&result.error==="stale-element-reference"){
      const found=await reresolve();assertRequestCurrent(requestSignal);
      const again:NativeInputResult=found?(request={...request,ref:found},await invokeNativeInputDriver(request,undefined,nativeSignal()))
        :{...result,message:"That element could not be found again on the app's current screen. Call get_app_state again and use the new element indices."};
      for(const key of Object.keys(result))delete result[key];Object.assign(result,again);
    }
    if(action==="focusApp"&&result.error==="app-not-found"&&typeof result.message==="string")result.message+=" It is not running and could not be opened under that name; use the exact name of an installed app (list_apps shows the running ones).";
    assertRequestCurrent(requestSignal);
    if(dockRun){
      const dock=supervisorDock();
      if(action==="focusApp"&&result.ok&&typeof result.pid==="number"){
        const docked=await dock?.begin({...dockRun,app:`pid:${result.pid}`,signal:nativeSignal(),checkpoint});
        await checkpoint();
        if(docked?.layoutChanged)sourceGeometries.clear();
      } else dock?.step();
    }
    if(actionTarget?.allowFocus){actionTarget.allowFocus=false;await checkpoint();}
    // Revocation cannot persist audit/history after native work returns.
    if(body.oneOsExecution!==undefined)oneOsLeaseBroker().assertExecutionCurrent(body.oneOsExecution);
    recordAudit(action,result,action==="typeText"&&typeof body.text==="string"?body.text.length:undefined);
    // What was done, not what was typed: no text, no pixel. A no-op unless the owner's Reach switch is on.
    if (learnTap.active() && action!=="status" && action!=="listApps") {
      learnTap.acted({ app: appName, action, ...(observedElement ? { observationId: observedElement.observationId, elementIndex: Number(body.element_index) } : {}), ...(typeof body.operation==="string" ? { operation: body.operation } : {}), ...(action==="key" && typeof body.key==="string" ? { key: body.key, modifiers: Array.isArray(body.modifiers) ? body.modifiers.filter((value): value is string => typeof value === "string").slice(0, 5) : [] } : {}), ok: result.ok === true, at: Date.now() });
    }
    return result;
  } catch(error) {return osFailure(error);} finally {nativeLifetime?.dispose();lease?.release();}

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

/** Constant-time bearer check, as native-guest.ts does for its scoped tokens. */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const actual = Buffer.from(typeof header === "string" ? header : "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return Boolean(expected) && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function startComputerUseControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);

  if (starting) return starting;
  const ownedGeneration = ++generation;
  token = randomUUID();
  const pending = new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      // A request's body normally closes before its response. Only an aborted
      // upload or an unfinished response disconnect cancels the queued/native work.
      const requestController = new AbortController();
      pendingRequests.add(requestController);
      const cleanup = () => { pendingRequests.delete(requestController); req.removeListener("aborted", disconnected); res.removeListener("close", disconnected); };
      const disconnected = () => { if (!res.writableFinished) requestController.abort(); cleanup(); };
      req.once("aborted", disconnected);
      res.once("close", disconnected);
      res.once("finish", cleanup);
      // Separate authority namespace. Invalid scoped requests never reach OS routes.
      if (req.url?.startsWith("/native-guest/")) {
        if (req.method !== "POST" || req.headers.origin) { req.resume(); writeJson(res, 403, { ok: false, error: "native-guest-route-denied" }); return; }
        const deadline = setTimeout(() => { req.destroy(); }, 5_000);
        void readJsonBody(req).then(async body => {
          clearTimeout(deadline);
          if (!body) return writeJson(res, 400, { ok: false, error: "native-guest-input-invalid" });
          const result = await handleNativeGuestComputerUse(req.url!.slice("/native-guest/".length), req.headers.authorization, body, requestController.signal);
          writeJson(res, 200, result);
        }).catch(() => { clearTimeout(deadline); writeJson(res, 500, { ok: false, error: "native-guest-operation-failed" }); });
        return;
      }
      if (process.platform !== "darwin") { req.resume(); writeJson(res, 403, { ok: false, error: "native-os-driver-unavailable" }); return; }
      if (!bearerMatches(req.headers.authorization, token)) {
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
          let lifetime: ReturnType<typeof linkedAbortSignals>;
          try { lifetime = executionLifetime(body, requestController.signal); }
          catch (error) { writeJson(res, 409, osFailure(error)); return; }
          const checkpoint = () => assertRequestCurrent(lifetime.signal);
          void observationAuthority(body).then(async authority=>{
            checkpoint();
            authority.assertCurrent();
            const preview=authority.binding?.contextGrantId ? await captureOneContextExecution(authority.binding, lifetime.signal) : await captureComputerUsePreview(sourceId);
            checkpoint();
            authority.assertCurrent();
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
              if(!authority.binding?.contextGrantId){checkpoint();authority.assertCurrent();savedPath = saveScreenCaptureArtifact(preview.dataUrl);}
            } catch {
              // 증거 파일을 못 남겨도 에이전트는 화면을 받아야 한다.
            }
            try {
              // Computer History has a separate, explicit-consent retention
              // policy. General CUA evidence remains governed by its own 300-file
              // cap; only an opted-in capture receives the seven-day local copy.
              if(!authority.binding?.contextGrantId){checkpoint();authority.assertCurrent();recordComputerHistoryCapture(preview.dataUrl);}
            } catch {
              // 보관은 동의 기반 부가 기능이다 — 실패해도 캡처를 삼키지 않는다.
            }
            checkpoint();authority.assertCurrent();
            writeJson(res, 200, { ok: true, preview: savedPath ? { ...preview, savedPath } : preview });
          }).catch((error) => {
            // 여기까지 왔다면 응답 쓰기 자체가 실패한 것이다. 그래도 매달아 두지 않는다.
            try { writeJson(res, 409, osFailure(error)); } catch { /* 소켓이 이미 닫혔다 */ }
          }).finally(() => lifetime.dispose());
          return;
        }
        if (req.url === "/observe") {
          const execute = actionQueue.then(() => observeApp(body, requestController.signal), () => observeApp(body, requestController.signal));
          actionQueue = execute.then(() => undefined, () => undefined);
          void execute.then((result) => writeJson(res, result.ok ? 200 : 409, result), () => {
            writeJson(res, 500, { ok: false, error: "observe-failed" });
          });
          return;
        }
        if (req.url === "/action") {
          const execute = actionQueue.then(() => runAction(body, requestController.signal), () => runAction(body, requestController.signal));
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
      if (ownedGeneration === generation && (!server || server === srv)) { server = null; boundPort = 0; }
      try { srv.close(); } catch {}
      resolve(0);
    });
    srv.listen(0, "127.0.0.1", () => {
      if (ownedGeneration !== generation) { srv.close(); resolve(0); return; }
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
      markOneOsHostAvailable(boundPort>0);
      resolve(boundPort);
    });
  });
  starting = pending;
  void pending.then(() => { if (starting === pending) starting = null; });
  return pending;
}

export function stopComputerUseControlServer(): void {
  for (const request of pendingRequests) request.abort();
  pendingRequests.clear();
  markOneOsHostAvailable(false); configuredOneOsLeaseBroker()?.suspend("one-os-host-unavailable");
  generation++; starting = null; revokeNativeGuestComputerUseScopes();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  server = null;
  boundPort = 0;
  token = "";
  auditRows.length = 0;
  sourceGeometries.clear();
  observations.clear();
  retiredObservations.clear();
  try { fs.rmSync(computerUseControlInfoPath(), { force: true }); } catch { /* ignore */ }
}

export const __computerUseTestHooks = { openAppIfNotRunning, findByLabel, withOpenHint, osFailure, whileBusy };
