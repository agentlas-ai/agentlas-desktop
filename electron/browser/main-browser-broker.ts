// Main-owned broker. No Electron import is needed to exercise its security and
// lifetime boundaries with synthetic grants in Node.
import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NativeBrowserRelayGrant, NativeBrowserRelayHealth, NativeBrowserRelayPage } from "./native-cdp-relay";
import type { CanonicalNativeBrowserGrantInput, NativeBrowserDaemonBinding, NativeBrowserMainCapability } from "./main-browser-channel";
import type { LoginRecoveryOutcome, LoginPrerequisiteRef } from "./login-recovery";

const MAX_REQUEST = 128 * 1024;
const MAX_GRANTS = 8;
const MAX_CAPTURE = 4 * 1024 * 1024;
type Entry = { controller: AbortController; grant: NativeBrowserRelayGrant | null; expiresAt: number;
  chatId: string; runId: string; sequence: number; screenshot?: { png: Buffer; current: () => boolean; sequence: number }; pages: Map<string, NativeBrowserRelayPage> };
type Owner = { binding: NativeBrowserDaemonBinding; capability: NativeBrowserMainCapability;
  grants: Map<string, Entry>; recoveries: Map<string, RecoveryScope>; cancelled: Map<string, number>; watch: http.ServerResponse | null; issuedAt: number };
type RecoveryScope = { controller: AbortController; pending: number; observing: number; endedDuringObservation: number; ended: () => void };
export interface MainBrowserBroker {
  issue(binding: NativeBrowserDaemonBinding): NativeBrowserMainCapability;
  close(): Promise<void>;
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,191}$/.test(value); }
function health(grant: NativeBrowserRelayGrant): NativeBrowserRelayHealth {
  return grant.health?.() ?? { current: true, lastRefusal: null, leases: 0, liveSockets: 0, revived: 0, failedOver: false };
}
function release(owner: Owner, id: string, cancelRecovery = true): void {
  // Cancel can arrive before grant admission on a separate HTTP connection.
  // Retain bounded tombstones so that acquisition cannot outlive its caller.
  owner.cancelled.set(id, Date.now() + 30_000);
  if (owner.cancelled.size > 1_024) owner.cancelled.delete(owner.cancelled.keys().next().value!);
  if (cancelRecovery) {
    const recovery = owner.recoveries.get(id);
    owner.recoveries.delete(id);
    recovery?.controller.abort();
  }
  const entry = owner.grants.get(id);
  if (!entry) return;
  owner.grants.delete(id);
  try { entry.controller.abort(); }
  finally {
    try { entry.grant?.release(); } catch { /* Cleanup of one grant must not strand sibling leases. */ }
    entry.screenshot = undefined;
    entry.pages.clear();
  }
}
function machineError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  // Never return arbitrary errors from Chromium/page evaluation to the caller.
  return /^native-browser-[a-z-]{1,96}$/.test(code) ? code : "native-browser-broker-operation-failed";
}

export async function startMainBrowserBroker(options: {
  createGrant: (input: CanonicalNativeBrowserGrantInput) => Promise<NativeBrowserRelayGrant>;
  recoverLogin?: (grant: NativeBrowserRelayGrant, input: { chatId: string; runId: string; nodeId?: string; signal: AbortSignal; onPendingScopeReleased: () => void; onPrerequisiteRestored: (prerequisite: LoginPrerequisiteRef) => void }) => Promise<LoginRecoveryOutcome[]>;
  allowedReadEvaluationSources?: readonly string[];
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}): Promise<MainBrowserBroker> {
  const alive = options.isProcessAlive ?? processAlive;
  const allowedReadEvaluations = new Set(["location.href", ...(options.allowedReadEvaluationSources ?? [])]);
  const now = options.now ?? Date.now;
  let owner: Owner | null = null;
  let closed = false;
  const sockets = new Set<import("node:net").Socket>();
  const revoke = (old: Owner) => {
    if (owner === old) owner = null;
    for (const id of [...old.grants.keys()]) release(old, id);
    for (const recovery of old.recoveries.values()) recovery.controller.abort();
    old.recoveries.clear();
    old.watch?.end();
    old.watch = null;
  };
  const current = (candidate: Owner) => !closed && owner === candidate && alive(candidate.binding.daemonPid);
  const snapshot = (candidate: Owner, entry: Entry, screenshotAfter = 0) => {
    if (!current(candidate) || entry.controller.signal.aborted || !entry.grant) throw new Error("native-browser-grant-revoked");
    const grant = entry.grant;
    const pages = grant.pages().slice(0, 32);
    entry.pages.clear();
    const output = pages.map((page, index) => {
      const id = page.id ?? `page-${index}`;
      entry.pages.set(id, page);
      return { id, url: page.url.slice(0, 8_192) };
    });
    const capture = entry.screenshot;
    const captureCurrent = Boolean(capture?.current());
    return { pages: output, health: health(grant), ...(grant.nativeComputerUse ? { nativeComputerUse: grant.nativeComputerUse } : {}), ...(grant.ownerScopeId ? { ownerScopeId: grant.ownerScopeId } : {}),
      screenshotCurrentSequence: captureCurrent ? capture!.sequence : null,
      ...(capture && capture.sequence > screenshotAfter && captureCurrent
      ? { screenshot: { sequence: capture.sequence, png: capture.png.toString("base64") } } : {}) };
  };
  const server = http.createServer(async (req, res) => {
    const candidate = owner;
    const supplied = req.headers.authorization;
    const wanted = candidate ? `Bearer ${candidate.capability.token}` : "";
    if (!candidate || !current(candidate) || typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(wanted)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(wanted))
      || req.headers["x-agentlas-generation"] !== candidate.capability.generation || req.headers.origin) {
      req.resume(); res.writeHead(403); res.end('{"error":"native-browser-broker-unauthorized"}'); return;
    }
    if (req.method === "GET" && req.url === "/watch") {
      if (candidate.watch) { res.writeHead(409); res.end('{"error":"native-browser-broker-peer-exists"}'); return; }
      candidate.watch = res;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
      res.flushHeaders();
      const beat = setInterval(() => { if (current(candidate)) res.write(".\n"); else revoke(candidate); }, 30_000);
      beat.unref();
      res.once("close", () => { clearInterval(beat); if (candidate.watch === res) revoke(candidate); });
      return;
    }
    if (req.method !== "POST" || !candidate.watch || !/^\/(grant|release|snapshot|reestablish|page|recover-login)$/.test(req.url ?? "")) {
      req.resume(); res.writeHead(400); res.end('{"error":"native-browser-broker-payload-invalid"}'); return;
    }
    const operation = req.url!.slice(1);
    let pendingId: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    const fail = (error: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: machineError(error) }));
    };
    try {
      const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const readTimer = setTimeout(() => { reject(new Error("native-browser-broker-timeout")); req.destroy(); }, 5_000);
        req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_REQUEST) { reject(new Error("native-browser-broker-payload-invalid")); req.destroy(); } else chunks.push(chunk); });
        req.once("error", () => { clearTimeout(readTimer); reject(new Error("native-browser-broker-disconnected")); });
        req.once("end", () => { clearTimeout(readTimer); try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("native-browser-broker-payload-invalid");
          resolve(parsed);
        } catch { reject(new Error("native-browser-broker-payload-invalid")); } });
      });
      if (!safeId(body.id) || !current(candidate)) throw new Error("native-browser-broker-payload-invalid");
      const id = body.id;
      timer = setTimeout(() => { if (pendingId) release(candidate, pendingId); fail(new Error("native-browser-broker-timeout")); }, 20_000);
      let reply: unknown;
      if (operation === "release") { release(candidate, id, body.cancelled === true); reply = { released: true }; }
      else if (operation === "grant") {
        if (!safeId(body.chatId) || !safeId(body.runId) || !["read", "write", "full"].includes(String(body.permission))
          || !["foreground", "background"].includes(String(body.presentation)) || typeof body.screenshots !== "boolean"
          || candidate.grants.has(id) || candidate.grants.size >= MAX_GRANTS) throw new Error("native-browser-broker-payload-invalid");
        if (candidate.cancelled.has(id)) throw new Error("native-browser-grant-revoked");
        pendingId = id;
        const entry: Entry = { controller: new AbortController(), grant: null, chatId: body.chatId, runId: body.runId,
          expiresAt: now() + 20_000, sequence: 0, pages: new Map() };
        candidate.grants.set(id, entry);
        const disconnect = () => { if (!res.writableEnded) release(candidate, id); };
        res.once("close", disconnect);
        const grant = await options.createGrant({ chatId: body.chatId, runId: body.runId,
          permission: body.permission as CanonicalNativeBrowserGrantInput["permission"],
          presentation: body.presentation as "foreground" | "background", signal: entry.controller.signal,
          ...(body.screenshots ? { onScreenshot: (capture: { png: Buffer; isCurrent: () => boolean }) => {
            if (!current(candidate) || entry.controller.signal.aborted || !capture.isCurrent()) return;
            // Retain one bounded frame, never credentials or profile copies.
            if (capture.png.length > MAX_CAPTURE) throw new Error("native-browser-capture-budget-exceeded");
            {
              entry.screenshot = { png: Buffer.from(capture.png), current: capture.isCurrent, sequence: ++entry.sequence };
              const notice = `${JSON.stringify({ event: "capture", grantId: id })}\n`;
              const watch = candidate.watch;
              if (watch && watch.writableLength < 64 * 1024) watch.write(notice);
              else if (watch) revoke(candidate);
            }
          } } : {}) });
        if (!current(candidate) || entry.controller.signal.aborted || candidate.grants.get(id) !== entry) {
          grant.release(); throw new Error("native-browser-grant-revoked");
        }
        entry.grant = grant;
        // A live attached task is governed by its signal and authenticated
        // peer/process lifetime, never an arbitrary wall-clock duration.
        entry.expiresAt = Infinity;
        reply = { endpoint: grant.endpoint, token: grant.token, ...snapshot(candidate, entry) };
      } else {
        const entry = candidate.grants.get(id);
        if (!entry?.grant || entry.expiresAt <= now()) { release(candidate, id); throw new Error("native-browser-grant-revoked"); }
        pendingId = id;
        if (operation === "snapshot") reply = snapshot(candidate, entry, typeof body.screenshotAfter === "number" ? body.screenshotAfter : 0);
        else if (operation === "reestablish") { await entry.grant.reestablish?.(); reply = snapshot(candidate, entry); }
        else if (operation === "recover-login") {
          if (body.nodeId !== undefined && !safeId(body.nodeId)) throw new Error("native-browser-broker-payload-invalid");
          if (!options.recoverLogin) throw new Error("native-browser-login-recovery-unavailable");
          let recovery = candidate.recoveries.get(id);
          if (!recovery) {
            if (candidate.recoveries.size >= 128) throw new Error("native-browser-login-recovery-scope-limit");
            const owned: RecoveryScope = { controller: new AbortController(), pending: 0, observing: 0, endedDuringObservation: 0, ended: () => {} };
            const finish = () => {
              if (candidate.recoveries.get(id) !== owned || owned.observing || owned.pending) return;
              candidate.recoveries.delete(id);
              const watch = candidate.watch;
              if (watch && watch.writableLength < 64 * 1024) watch.write(`${JSON.stringify({ event: "recovery-ended", grantId: id })}\n`);
            };
            owned.ended = () => {
              if (owned.observing) owned.endedDuringObservation++;
              else { owned.pending = 0; finish(); }
            };
            candidate.recoveries.set(id, owned);
            recovery = owned;
          }
          recovery.observing++;
          const outcomes = await options.recoverLogin(entry.grant, { chatId: entry.chatId, runId: entry.runId,
            ...(typeof body.nodeId === "string" ? { nodeId: body.nodeId } : {}), signal: recovery.controller.signal,
            onPendingScopeReleased: recovery.ended, onPrerequisiteRestored: (prerequisite) => {
              if (!current(candidate) || recovery.controller.signal.aborted || candidate.recoveries.get(id) !== recovery
                || prerequisite.runId !== entry.runId || prerequisite.chatId !== entry.chatId
                || prerequisite.nodeId !== body.nodeId) return;
              const watch = candidate.watch;
              if (watch && watch.writableLength < 64 * 1024) watch.write(`${JSON.stringify({ event: "recovery-restored", grantId: id, prerequisite })}\n`);
            } });
          recovery.observing--;
          if (!Array.isArray(outcomes) || outcomes.length > 32) throw new Error("native-browser-broker-response-invalid");
          // Runtime invokes the callback once after ALL pending pages in this
          // observation batch end, so the broker tracks one aggregate lifetime.
          recovery.pending = recovery.endedDuringObservation ? 0
            : outcomes.some(outcome => outcome.state === "awaiting-owner" || outcome.state === "in-flight") ? 1 : 0;
          recovery.endedDuringObservation = 0;
          if (!recovery.pending && !recovery.observing) {
            candidate.recoveries.delete(id);
            candidate.watch?.write(`${JSON.stringify({ event: "recovery-ended", grantId: id })}\n`);
          }
          // Explicit projection: raw cookies, vault data, and diagnostic extras
          // cannot cross this Main-to-daemon recovery boundary.
          reply = outcomes.map(outcome => {
            if (outcome.state === "not-a-wall") return { state: outcome.state };
            if (outcome.state === "in-flight") return { state: outcome.state, site: outcome.site };
            if (outcome.state === "recovered") return { state: outcome.state, via: outcome.via, site: outcome.site };
            if (outcome.state === "awaiting-owner") return { state: outcome.state, site: outcome.site, newCard: outcome.newCard, ...(outcome.prerequisite ? { prerequisite: outcome.prerequisite } : {}),
              card: { site: outcome.card.site, surface: outcome.card.surface, reason: outcome.card.reason,
                signInUrl: outcome.card.signInUrl, message: { ko: outcome.card.message.ko, en: outcome.card.message.en } } };
            throw new Error("native-browser-broker-response-invalid");
          });
        }
        else {
          // Pages come only from this run's grant. No global guest lookup,
          // cookie-store API, browser endpoint selection, or profile IPC exists.
          snapshot(candidate, entry);
          const page = typeof body.pageId === "string" ? entry.pages.get(body.pageId) : null;
          if (!page || !["reload", "navigate", "evaluate", "present"].includes(String(body.action))) throw new Error("native-browser-target-missing");
          if (body.action === "reload") reply = await page.reload();
          else if (body.action === "present") reply = (await page.present?.()) === true;
          else {
            if (typeof body.args !== "string" || body.args.length > 64_000) throw new Error("native-browser-broker-payload-invalid");
            if (body.action === "navigate") {
              const url = new URL(body.args);
              if (!["https:", "http:", "about:"].includes(url.protocol) || url.username || url.password) throw new Error("native-browser-broker-payload-invalid");
              await page.navigate(body.args); reply = null;
            } else {
              if (!allowedReadEvaluations.has(body.args)) throw new Error("native-browser-broker-evaluation-not-authorized");
              reply = await page.evaluate?.(body.args) ?? null;
            }
          }
        }
      }
      if (!current(candidate)) throw new Error("native-browser-grant-revoked");
      if (operation !== "release" && operation !== "recover-login"
        && (!candidate.grants.has(id) || candidate.grants.get(id)?.controller.signal.aborted)) throw new Error("native-browser-grant-revoked");
      const encoded = JSON.stringify(reply);
      if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error("native-browser-broker-response-invalid");
      if (!res.writableEnded && !res.destroyed) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(encoded); }
    } catch (error) { if (pendingId) release(candidate, pendingId); fail(error); }
    finally { if (timer) clearTimeout(timer); }
  });
  server.requestTimeout = 6_000;
  server.headersTimeout = 6_000;
  server.maxHeadersCount = 32;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  server.unref();
  const port = (server.address() as import("node:net").AddressInfo).port;
  const sweep = setInterval(() => {
    const candidate = owner;
    if (!candidate) return;
    if (!current(candidate) || (!candidate.watch && now() - candidate.issuedAt > 10_000)) { revoke(candidate); return; }
    for (const [id, entry] of candidate.grants) if (entry.expiresAt <= now()) release(candidate, id);
    for (const [id, expires] of candidate.cancelled) if (expires <= Date.now()) candidate.cancelled.delete(id);
  }, 1_000);
  sweep.unref();
  return {
    issue(binding) {
      if (closed || !Number.isSafeInteger(binding.daemonPid) || binding.daemonPid <= 1 || !alive(binding.daemonPid)
        || !/^[a-f0-9-]{36}$/i.test(binding.bootId) || typeof binding.serviceIdentity !== "string"
        || binding.serviceIdentity.length < 1 || binding.serviceIdentity.length > 256) throw new Error("native-browser-broker-owner-invalid");
      if (owner && current(owner) && owner.binding.daemonPid === binding.daemonPid && owner.binding.bootId === binding.bootId
        && owner.binding.serviceIdentity === binding.serviceIdentity) return { ...owner.capability };
      if (owner) revoke(owner);
      const capability: NativeBrowserMainCapability = { endpoint: `http://127.0.0.1:${port}`, token: randomBytes(32).toString("hex"),
        mainPid: process.pid, daemonPid: binding.daemonPid, bootId: binding.bootId, generation: randomUUID() };
      owner = { binding: { ...binding }, capability, issuedAt: now(), grants: new Map(), recoveries: new Map(), cancelled: new Map(), watch: null };
      return { ...capability };
    },
    async close() { closed = true; clearInterval(sweep); if (owner) revoke(owner); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
