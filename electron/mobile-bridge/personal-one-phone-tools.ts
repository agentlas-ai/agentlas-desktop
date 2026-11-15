import { createHash } from "node:crypto";

/** A Main-owned, targeted phone-tool rendezvous. This is not a broadcast channel.
 * The caller supplies an already authenticated, host-derived binding. Every
 * poll and answer rechecks it with the live account, pairing and run owner.
 * A transport reconnect may keep the same binding; revocation never does.
 */
export type PhoneToolBinding = Readonly<{
  userId: string; workspaceId: string; accountSubject: string; deviceId: string;
  hostId: string; oneId: string; runId: string; generation: string;
}>;
export type PhoneToolName = "phone.location.get" | "phone.device.context";
export type PhoneToolResult = { status: "ok" | "refused" | "unavailable" | "failed"; data?: Record<string, unknown>; reason?: string };
export type PhoneToolRequest = { callId: string; runId: string; name: PhoneToolName; input: Record<string, unknown> };
type Entry = { binding: PhoneToolBinding; request: PhoneToolRequest; done: boolean; timer: ReturnType<typeof setTimeout>;
  finish(result: PhoneToolResult): void };
const unavailable = (): PhoneToolResult => ({ status: "unavailable", reason: "phone_no_answer" });
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const keys: readonly (keyof PhoneToolBinding)[] = ["userId", "workspaceId", "accountSubject", "deviceId", "hostId", "oneId", "runId", "generation"];
const validBinding = (b: PhoneToolBinding) => !!b && keys.every((key) => id(b[key]));
const same = (a: PhoneToolBinding, b: PhoneToolBinding) => keys.every((key) => a[key] === b[key]);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function hasPhoneConnection(connections: ReadonlyMap<string, ReadonlySet<string>>, deviceId: string): boolean {
  return (connections.get(deviceId)?.size ?? 0) > 0;
}
function validInput(name: PhoneToolName, input: unknown): input is Record<string, unknown> {
  if (!plain(input)) return false;
  return name === "phone.location.get"
    ? Object.keys(input).every((key) => key === "precise" && typeof input[key] === "boolean")
    : name === "phone.device.context" && Object.keys(input).length === 0;
}
function cleanResult(name: PhoneToolName, result: unknown): PhoneToolResult | null {
  if (!plain(result) || !["ok", "refused", "unavailable", "failed"].includes(String(result.status)) ||
      Object.keys(result).some((key) => !["status", "data", "reason"].includes(key))) return null;
  if (result.status !== "ok") {
    if (result.data !== undefined || (result.reason !== undefined && !id(result.reason))) return null;
    return { status: result.status as PhoneToolResult["status"], ...(result.reason === undefined ? {} : { reason: result.reason as string }) };
  }
  if (!plain(result.data) || result.reason !== undefined) return null;
  const data = result.data;
  if (name === "phone.location.get") {
    if (Object.keys(data).some((key) => !["lat", "lng", "accuracyM", "precision", "observedAt"].includes(key)) ||
        typeof data.lat !== "number" || !Number.isFinite(data.lat) || Math.abs(data.lat) > 90 ||
        typeof data.lng !== "number" || !Number.isFinite(data.lng) || Math.abs(data.lng) > 180 ||
        Math.abs(data.lat * 100 - Math.round(data.lat * 100)) > 1e-7 ||
        Math.abs(data.lng * 100 - Math.round(data.lng * 100)) > 1e-7 ||
        data.precision !== "area" || typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt)) ||
        Date.parse(data.observedAt) % 60_000 !== 0 ||
        (data.accuracyM !== undefined && ![1000, 2000, 5000, 10000, 50000].includes(data.accuracyM as number))) return null;
  } else {
    if (Object.keys(data).some((key) => !["timeZoneOffsetMinutes", "locale", "batteryPercent", "charging", "network"].includes(key)) ||
        (data.timeZoneOffsetMinutes !== undefined && (!Number.isInteger(data.timeZoneOffsetMinutes) || Math.abs(data.timeZoneOffsetMinutes as number) > 840)) ||
        (data.locale !== undefined && (typeof data.locale !== "string" || data.locale.length > 64)) ||
        (data.batteryPercent !== undefined && (!Number.isInteger(data.batteryPercent) || (data.batteryPercent as number) < 0 || (data.batteryPercent as number) > 100)) ||
        (data.charging !== undefined && typeof data.charging !== "boolean") ||
        (data.network !== undefined && !["wifi", "mobile", "none", "other"].includes(String(data.network)))) return null;
  }
  return { status: "ok", data: { ...data } };
}

export function createPersonalOnePhoneTools(options: { current(binding: PhoneToolBinding): Promise<boolean>; timeoutMs?: number; maxPending?: number }) {
  const timeoutMs = options.timeoutMs ?? 65_000, maxPending = options.maxPending ?? 64;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new TypeError("phone_tool_config");
  const pending = new Map<string, Entry>();
  // Remember only a digest, not the phone's location or device data, for lost ACKs.
  const settled = new Map<string, { binding: PhoneToolBinding; digest: string; expiresAt: number }>();
  const prune = () => { const now = Date.now(); for (const [key, row] of settled) if (row.expiresAt <= now) settled.delete(key); };
  const digest = (value: PhoneToolResult) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const keyOf = (binding: PhoneToolBinding, callId: string) => JSON.stringify([binding.userId, binding.workspaceId, binding.deviceId, binding.oneId, binding.runId, callId]);
  const current = async (binding: PhoneToolBinding) => { try { return validBinding(binding) && await options.current(binding) === true; } catch { return false; } };
  async function request(binding: PhoneToolBinding, callId: string, name: PhoneToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<PhoneToolResult> {
    if (!id(callId) || !validBinding(binding) || !validInput(name, input) || signal?.aborted || pending.size >= maxPending || !(await current(binding))) return unavailable();
    const key = keyOf(binding, callId);
    prune();
    if (pending.has(key) || settled.has(key)) return unavailable();
    return new Promise((resolve) => {
      const request = { callId, runId: binding.runId, name, input: { ...input } };
      const finish = (result: PhoneToolResult) => { const entry = pending.get(key); if (!entry || entry.done) return; entry.done = true; clearTimeout(entry.timer); pending.delete(key); signal?.removeEventListener("abort", aborted); resolve(result); };
      const aborted = () => finish(unavailable());
      const timer = setTimeout(aborted, timeoutMs); timer.unref?.();
      pending.set(key, { binding: { ...binding }, request, done: false, timer, finish });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  async function list(binding: PhoneToolBinding): Promise<PhoneToolRequest[]> {
    if (!(await current(binding))) return [];
    return [...pending.values()].filter((entry) => !entry.done && same(entry.binding, binding)).map((entry) => ({ ...entry.request, input: { ...entry.request.input } }));
  }
  async function answer(binding: PhoneToolBinding, callId: string, result: unknown): Promise<boolean> {
    if (!id(callId) || !(await current(binding))) return false;
    const key = keyOf(binding, callId);
    const entry = pending.get(key);
    if (!entry || entry.done || !same(entry.binding, binding)) {
      prune();
      const previous = settled.get(key);
      if (!previous || !same(previous.binding, binding)) return false;
      const clean = cleanResult("phone.location.get", result) ?? cleanResult("phone.device.context", result);
      return !!clean && digest(clean) === previous.digest;
    }
    const clean = cleanResult(entry.request.name, result);
    if (!clean) return false;
    // An account change or revoke can close the entry during an async check.
    if (!(await current(entry.binding)) || pending.get(key) !== entry || entry.done) return false;
    prune();
    if (settled.size >= 256) settled.delete(settled.keys().next().value!);
    settled.set(key, { binding: entry.binding, digest: digest(clean), expiresAt: Date.now() + 600_000 });
    entry.finish(clean); return true;
  }
  function revoke(predicate: (binding: PhoneToolBinding) => boolean) {
    for (const entry of [...pending.values()]) if (predicate(entry.binding)) entry.finish(unavailable());
    for (const [key, row] of settled) if (predicate(row.binding)) settled.delete(key);
  }
  return Object.freeze({ request, list, answer, revoke, close: () => revoke(() => true) });
}

/** Main installs one authority per host; the native/daemon adapter must supply
 * a validated supervisor run, never an identity from model arguments. */
export type PersonalOnePhoneBridge = {
  requestForRun(oneId: string, runId: string, callId: string, name: PhoneToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<PhoneToolResult>;
};
const bridges = new Map<string, Set<PersonalOnePhoneBridge>>();
export function installPersonalOnePhoneBridge(hostId: string, bridge: PersonalOnePhoneBridge): () => void {
  if (!id(hostId)) throw new Error("phone_bridge_invalid");
  const entries = bridges.get(hostId) ?? new Set<PersonalOnePhoneBridge>();
  entries.add(bridge); bridges.set(hostId, entries);
  return () => { entries.delete(bridge); if (entries.size === 0 && bridges.get(hostId) === entries) bridges.delete(hostId); };
}
export async function requestPersonalOnePhoneTool(hostId: string, oneId: string, runId: string, callId: string, name: PhoneToolName,
  input: Record<string, unknown>, signal?: AbortSignal): Promise<PhoneToolResult> {
  const entries = bridges.get(hostId);
  if (!entries || entries.size !== 1) return unavailable();
  return entries.values().next().value!.requestForRun(oneId, runId, callId, name, input, signal);
}

/** The run's stored source selects the phone; a model cannot select a host. */
export async function requestPersonalOnePhoneToolForRun(oneId: string, runId: string, callId: string, name: PhoneToolName,
  input: Record<string, unknown>, signal?: AbortSignal): Promise<PhoneToolResult> {
  const entries = [...bridges.values()].flatMap((set) => [...set]);
  if (entries.length !== 1) return unavailable();
  return entries[0]!.requestForRun(oneId, runId, callId, name, input, signal);
}
