// Node-safe entrypoint. Only a real Electron Main process imports the native host.
import http from "node:http";
import type { NativeBrowserRelayGrant, NativeBrowserRelayHealth, NativeBrowserRelayPage } from "./native-cdp-relay";
import type { LoginRecoveryOutcome, LoginPrerequisiteRef } from "./login-recovery";
import { onHostShutdown } from "../host-lifecycle";

export type CanonicalNativeBrowserGrantInput = {
  chatId: string; runId: string; permission: "read" | "write" | "full"; signal: AbortSignal;
  presentation?: "foreground" | "background";
  onScreenshot?: (capture: { png: Buffer; isCurrent: () => boolean }) => void | Promise<void>;
};
export interface NativeBrowserMainCapability {
  endpoint: string; token: string; mainPid: number; daemonPid: number; bootId: string; generation: string;
}
export type NativeBrowserDaemonBinding = { daemonPid: number; bootId: string; serviceIdentity: string };
type Snapshot = { nativeComputerUse?: NativeBrowserRelayGrant["nativeComputerUse"]; pages: { id: string; url: string }[]; health: NativeBrowserRelayHealth;
  screenshot?: { sequence: number; png: string }; screenshotCurrentSequence: number | null };
type RemoteState = { capability: NativeBrowserMainCapability; watch: http.ClientRequest; ready: Promise<void>; closed: boolean;
  releases: Set<() => void>; captures: Map<string, () => void>; recoveries: Map<string, () => void>; restorations: Map<string, (prerequisite: LoginPrerequisiteRef) => void> };
let remote: RemoteState | null = null;
const remoteGrants = new Map<string, NativeBrowserRelayGrant>();
const remoteOwnerScopes = new Map<string, { ownerScopeId: string; chatId: string; runId: string; grant: NativeBrowserRelayGrant }>();
export function remoteNativeBrowserOwnerScopeForId(id: string | null | undefined): { ownerScopeId: string; chatId: string; runId: string; grant: NativeBrowserRelayGrant } | null {
  return id ? remoteOwnerScopes.get(id) ?? null : null;
}
export function remoteNativeBrowserGrantForEndpoint(endpoint: string | null | undefined): NativeBrowserRelayGrant | null {
  return endpoint ? remoteGrants.get(endpoint) ?? null : null;
}
const MAX_RESPONSE = 8 * 1024 * 1024;
export const NATIVE_BROWSER_HOST_UNAVAILABLE = "native-browser-host-unavailable";

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function validateNativeBrowserMainCapability(value: unknown, daemonPid = process.pid, mainPid?: number): NativeBrowserMainCapability {
  const c = value as NativeBrowserMainCapability | null;
  if (!c || typeof c.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(c.endpoint)
    || typeof c.token !== "string" || !/^[a-f0-9]{64}$/.test(c.token)
    || typeof c.bootId !== "string" || !/^[a-f0-9-]{36}$/i.test(c.bootId)
    || typeof c.generation !== "string" || !/^[a-f0-9-]{36}$/i.test(c.generation)
    || !Number.isSafeInteger(c.mainPid) || c.mainPid <= 1 || c.daemonPid !== daemonPid
    || (mainPid !== undefined && c.mainPid !== mainPid)) throw new Error("native-browser-capability-invalid");
  return { endpoint: c.endpoint, token: c.token, mainPid: c.mainPid, daemonPid: c.daemonPid, bootId: c.bootId, generation: c.generation };
}
export function clearCanonicalNativeBrowserCapability(): void {
  const state = remote;
  remote = null;
  if (!state) return;
  state.closed = true;
  for (const release of state.releases) release();
  for (const ended of state.recoveries.values()) ended();
  state.recoveries.clear();
  state.restorations.clear();
  state.watch.destroy();
}
onHostShutdown(clearCanonicalNativeBrowserCapability);

/** Called only by the service-identity fenced daemon.attach control method. */
export function configureCanonicalNativeBrowserCapability(value: unknown, expected: { daemonPid: number; mainPid: number; bootId: string }): void {
  if (value === undefined || value === null) { clearCanonicalNativeBrowserCapability(); return; }
  const capability = validateNativeBrowserMainCapability(value, expected.daemonPid, expected.mainPid);
  if (capability.bootId !== expected.bootId || !alive(capability.mainPid)) throw new Error("native-browser-capability-invalid");
  if (remote && !remote.closed && remote.capability.token === capability.token) return;
  clearCanonicalNativeBrowserCapability();
  let accept!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
  // Attachment is allowed to succeed while the watch connects; suppress an idle
  // rejection and let a browser request observe the bounded failure directly.
  void ready.catch(() => {});
  const watch = http.request(`${capability.endpoint}/watch`, { method: "GET", headers: {
    Authorization: `Bearer ${capability.token}`, "X-Agentlas-Generation": capability.generation,
  } });
  const state: RemoteState = { capability, watch, ready, closed: false, releases: new Set(), captures: new Map(), recoveries: new Map(), restorations: new Map() };
  remote = state;
  const failed = () => {
    reject(new Error(NATIVE_BROWSER_HOST_UNAVAILABLE));
    if (remote === state) clearCanonicalNativeBrowserCapability();
  };
  const timer = setTimeout(() => { watch.destroy(); failed(); }, 5_000);
  timer.unref();
  watch.once("response", response => {
    clearTimeout(timer);
    if (response.statusCode !== 200) { response.resume(); failed(); return; }
    accept();
    let pending = "";
    response.setEncoding("utf8");
    response.on("data", (part: string) => {
      pending += part;
      if (pending.length > 64 * 1024) { failed(); return; }
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line === ".") continue;
        try {
          const notice = JSON.parse(line);
          if (!["capture", "recovery-ended", "recovery-restored"].includes(notice.event) || typeof notice.grantId !== "string" || notice.grantId.length > 192) { failed(); return; }
          if (notice.event === "capture") state.captures.get(notice.grantId)?.();
          else if (notice.event === "recovery-ended") state.recoveries.get(notice.grantId)?.();
          else {
            const ref = notice.prerequisite;
            if (!ref || typeof ref.runId !== "string" || typeof ref.chatId !== "string"
              || (ref.nodeId !== undefined && typeof ref.nodeId !== "string")
              || !/^[a-f0-9-]{36}$/i.test(ref.prerequisiteId) || !/^[a-f0-9-]{36}$/i.test(ref.generation)
              || !/^[a-f0-9]{64}$/i.test(ref.sessionId)) { failed(); return; }
            state.restorations.get(notice.grantId)?.(ref);
          }
        } catch { failed(); return; }
      }
    });
    response.once("close", failed);
    response.once("error", failed);
  });
  watch.once("error", () => { clearTimeout(timer); failed(); });
  watch.end();
}

async function request<T>(state: RemoteState, operation: string, payload: unknown, timeoutMs = 25_000): Promise<T> {
  if (state.closed || !alive(state.capability.mainPid)) throw new Error(NATIVE_BROWSER_HOST_UNAVAILABLE);
  await state.ready;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error("native-browser-broker-payload-invalid");
  return new Promise<T>((resolve, reject) => {
    const req = http.request(`${state.capability.endpoint}/${operation}`, { method: "POST", headers: {
      Authorization: `Bearer ${state.capability.token}`, "X-Agentlas-Generation": state.capability.generation,
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    } }, res => {
      let size = 0;
      const parts: Buffer[] = [];
      res.on("data", (part: Buffer) => { size += part.length; if (size > MAX_RESPONSE) req.destroy(new Error("native-browser-broker-response-invalid")); else parts.push(part); });
      res.once("error", () => reject(new Error(NATIVE_BROWSER_HOST_UNAVAILABLE)));
      res.once("end", () => {
        try {
          const reply = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (res.statusCode !== 200) throw new Error(typeof reply.error === "string" && /^native-browser-[a-z-]+$/.test(reply.error) ? reply.error : "native-browser-broker-refused");
          resolve(reply as T);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("native-browser-broker-timeout")));
    req.once("error", error => reject(error));
    req.end(body);
  });
}

export async function createCanonicalNativeBrowserGrant(input: CanonicalNativeBrowserGrantInput): Promise<NativeBrowserRelayGrant> {
  if (process.type === "browser" && process.env.ELECTRON_RUN_AS_NODE !== "1") {
    return (await import("./native-cdp-relay")).createNativeBrowserRelayGrant(input);
  }
  const state = remote;
  if (!state || state.closed) throw new Error(NATIVE_BROWSER_HOST_UNAVAILABLE);
  if (input.signal.aborted) throw new Error("native-browser-grant-revoked");
  // Client-chosen nonce lets cancellation release an acquisition still pending
  // on Main. This also avoids leaking the created grant when its reply is lost.
  const id = (await import("node:crypto")).randomUUID();
  let released = false;
  let remoteGrant: NativeBrowserRelayGrant | null = null;
  let recoveryRequested = false;
  const expectedRestorations = new Map<string, LoginPrerequisiteRef>();
  const restoredIds = new Set<string>();
  const restorationCallbacks = new Map<string | undefined, ((prerequisite: LoginPrerequisiteRef) => void) | undefined>();
  const bufferedRestorations = new Map<string, LoginPrerequisiteRef>();
  let observingRecovery = 0;
  const acceptRestoration = (prerequisite: LoginPrerequisiteRef) => {
    if (state.closed || input.signal.aborted || prerequisite.runId !== input.runId || prerequisite.chatId !== input.chatId) return;
    if (observingRecovery) {
      if (bufferedRestorations.size < 32) bufferedRestorations.set(`${prerequisite.prerequisiteId}:${prerequisite.sessionId}:${prerequisite.generation}`, prerequisite);
      return;
    }
    const expected = expectedRestorations.get(prerequisite.prerequisiteId);
    if (!expected || expected.nodeId !== prerequisite.nodeId || expected.sessionId !== prerequisite.sessionId
      || expected.generation !== prerequisite.generation || restoredIds.has(prerequisite.prerequisiteId)) return;
    restoredIds.add(prerequisite.prerequisiteId);
    if (restoredIds.size > 128) restoredIds.delete(restoredIds.values().next().value!);
    expectedRestorations.delete(prerequisite.prerequisiteId);
    try { restorationCallbacks.get(prerequisite.nodeId)?.(prerequisite); } catch { /* consumer cannot revoke the channel */ }
  };
  const recoveryEnded = () => {
    recoveryRequested = false;
    state.recoveries.delete(id);
    state.restorations.delete(id);
    if (released) input.signal.removeEventListener("abort", release);
  };
  let health: NativeBrowserRelayHealth = { current: false, lastRefusal: "session-unavailable", leases: 0, liveSockets: 0, revived: 0, failedOver: false };
  let pages: NativeBrowserRelayPage[] = [];
  let screenshotSequence = 0;
  let screenshotCurrentSequence: number | null = null;
  const release = () => {
    if (released) {
      if (input.signal.aborted) { void request(state, "release", { id, cancelled: true }, 3_000).catch(() => {}); recoveryEnded(); }
      return;
    }
    released = true;
    health = { ...health, current: false, lastRefusal: "grant-revoked" };
    pages = [];
    if (remoteGrant && remoteGrants.get(remoteGrant.endpoint) === remoteGrant) remoteGrants.delete(remoteGrant.endpoint);
    if (remoteGrant?.ownerScopeId) remoteOwnerScopes.delete(remoteGrant.ownerScopeId);
    state.captures.delete(id);
    state.releases.delete(release);
    if (!recoveryRequested || input.signal.aborted) input.signal.removeEventListener("abort", release);
    void request(state, "release", { id, cancelled: input.signal.aborted }, 3_000).catch(() => {});
    if (input.signal.aborted) recoveryEnded();
  };
  state.releases.add(release);
  input.signal.addEventListener("abort", release, { once: true });
  const pageCall = <T>(pageId: string, action: string, args?: string) => {
    if (released || input.signal.aborted) return Promise.reject<T>(new Error("native-browser-grant-revoked"));
    return request<T>(state, "page", { id, pageId, action, args });
  };
  const update = async (snapshot: Snapshot) => {
    if (released || input.signal.aborted) return;
    if (!snapshot || !Array.isArray(snapshot.pages) || snapshot.pages.length > 32
      || snapshot.pages.some(page => !page || typeof page.id !== "string" || page.id.length > 192 || typeof page.url !== "string" || page.url.length > 8_192)
      || !snapshot.health || typeof snapshot.health.current !== "boolean" || typeof snapshot.health.failedOver !== "boolean"
      || ![null, "session-ended", "tab-limit", "session-unavailable", "grant-revoked"].includes(snapshot.health.lastRefusal)
      || [snapshot.health.leases, snapshot.health.liveSockets, snapshot.health.revived].some(value => !Number.isSafeInteger(value) || value < 0)
      || (snapshot.screenshotCurrentSequence !== null && (!Number.isSafeInteger(snapshot.screenshotCurrentSequence) || snapshot.screenshotCurrentSequence < 1))
      || (snapshot.screenshot && (!Number.isSafeInteger(snapshot.screenshot.sequence) || snapshot.screenshot.sequence < 1
        || typeof snapshot.screenshot.png !== "string" || snapshot.screenshot.png.length > 5_592_408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(snapshot.screenshot.png)))) {
      throw new Error("native-browser-broker-response-invalid");
    }
    health = snapshot.health;
    screenshotCurrentSequence = snapshot.screenshotCurrentSequence;
    pages = snapshot.pages.map(page => ({ id: page.id, url: page.url,
      reload: () => pageCall<string | null>(page.id, "reload"),
      navigate: (url: string) => pageCall<void>(page.id, "navigate", url),
      evaluate: (expression: string) => pageCall<unknown>(page.id, "evaluate", expression),
      present: () => pageCall<boolean>(page.id, "present"),
    }));
    const capture = snapshot.screenshot;
    if (capture && capture.sequence > screenshotSequence && input.onScreenshot) {
      screenshotSequence = capture.sequence;
      await input.onScreenshot({ png: Buffer.from(capture.png, "base64"), isCurrent: () => !released && !state.closed && !input.signal.aborted
        && health.current && screenshotCurrentSequence === capture.sequence });
    }
  };
  let refreshing: Promise<void> | null = null;
  let admitted = false;
  let capturePending = false;
  const refresh = () => {
    if (released) return Promise.resolve();
    if (refreshing) return refreshing;
    capturePending = false;
    return refreshing = request<Snapshot>(state, "snapshot", { id, screenshotAfter: screenshotSequence })
      .then(update).catch(error => { release(); throw error; }).finally(() => {
        refreshing = null;
        if (capturePending && !released) void refresh().catch(() => {});
      });
  };
  state.captures.set(id, () => { capturePending = true; if (admitted) void refresh().catch(() => {}); });
  try {
    const result = await request<Snapshot & { endpoint: string; token: string; ownerScopeId?: string }>(state, "grant", {
      id, chatId: input.chatId, runId: input.runId, permission: input.permission,
      presentation: input.presentation ?? "background", screenshots: Boolean(input.onScreenshot),
    });
    if (released || input.signal.aborted) throw new Error("native-browser-grant-revoked");
    if (typeof result.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/[A-Za-z0-9/_-]*)?$/.test(result.endpoint)
      || typeof result.token !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(result.token)) throw new Error("native-browser-broker-response-invalid");
    if (result.ownerScopeId !== undefined && (typeof result.ownerScopeId !== "string" || !/^[a-f0-9-]{36}$/i.test(result.ownerScopeId))) throw new Error("native-browser-broker-response-invalid");
    if (result.nativeComputerUse && (typeof result.nativeComputerUse.endpoint !== "string"
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(result.nativeComputerUse.endpoint)
      || typeof result.nativeComputerUse.token !== "string" || !/^[a-f0-9]{64}$/.test(result.nativeComputerUse.token)
      || typeof result.nativeComputerUse.scopeId !== "string" || !/^[a-f0-9-]{36}$/i.test(result.nativeComputerUse.scopeId))) throw new Error("native-browser-broker-response-invalid");
    await update(result);
    admitted = true;
    if (capturePending) await refresh();
    remoteGrant = { endpoint: result.endpoint, token: result.token, ...(result.ownerScopeId ? { ownerScopeId: result.ownerScopeId } : {}),
      ...(result.nativeComputerUse ? { nativeComputerUse: result.nativeComputerUse } : {}),
      release, pages: () => pages, health: () => health, refresh,
      reestablish: async () => { const result = await request<Snapshot>(state, "reestablish", { id }); await update(result); return health; },
      recoverLoginWalls: async (options: { nodeId?: string; onPrerequisiteRestored?: (prerequisite: LoginPrerequisiteRef) => void }) => {
        recoveryRequested = true;
        state.recoveries.set(id, recoveryEnded);
        restorationCallbacks.set(options.nodeId, options.onPrerequisiteRestored);
        state.restorations.set(id, acceptRestoration);
        observingRecovery++;
        let observationPending = true;
        try {
          const outcomes = await request<LoginRecoveryOutcome[]>(state, "recover-login", { id, ...(options.nodeId ? { nodeId: options.nodeId } : {}) });
          if (!Array.isArray(outcomes) || outcomes.length > 32 || outcomes.some(outcome => !outcome
            || !["not-a-wall", "recovered", "awaiting-owner", "in-flight"].includes(outcome.state))) throw new Error("native-browser-broker-response-invalid");
          for (const [refId, expected] of expectedRestorations) if (expected.nodeId === options.nodeId) expectedRestorations.delete(refId);
          for (const outcome of outcomes) if (outcome.state === "awaiting-owner" && outcome.prerequisite) {
            const ref = outcome.prerequisite;
            if (ref.runId !== input.runId || ref.chatId !== input.chatId || ref.nodeId !== options.nodeId
              || !/^[a-f0-9-]{36}$/i.test(ref.prerequisiteId) || !/^[a-f0-9-]{36}$/i.test(ref.generation)
              || !/^[a-f0-9]{64}$/i.test(ref.sessionId)) throw new Error("native-browser-broker-response-invalid");
            expectedRestorations.set(ref.prerequisiteId, ref);
          }
          observingRecovery--; observationPending = false;
          if (!observingRecovery) {
            const buffered = [...bufferedRestorations.values()]; bufferedRestorations.clear();
            for (const ref of buffered) acceptRestoration(ref);
          }
          await refresh();
          if (!outcomes.some(outcome => outcome.state === "awaiting-owner" || outcome.state === "in-flight")) recoveryEnded();
          return outcomes;
        } catch (error) { if (observationPending) observingRecovery = Math.max(0, observingRecovery - 1); bufferedRestorations.clear(); recoveryEnded(); throw error; }
      } };
    remoteGrants.set(remoteGrant.endpoint, remoteGrant);
    if (remoteGrant.ownerScopeId) remoteOwnerScopes.set(remoteGrant.ownerScopeId, { ownerScopeId: remoteGrant.ownerScopeId,
      chatId: input.chatId, runId: input.runId, grant: remoteGrant });
    return remoteGrant;
  } catch (error) { release(); throw error; }
}
