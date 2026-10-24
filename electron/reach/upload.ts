import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Capability, CapabilityParameter } from "./types";

// What leaves this machine, and how. The rule is: only descriptions of what an app can do, never anything about the person or their
// content. Every record is rebuilt field by field from an allowlist (nothing is passed through), every string is screened, and anything
// the screen is unsure of is dropped, not sent. The server screens again and rejects unknown fields; this is the first line, not the only
// one. Contract: agentlas.reach.capability-record/v1 (agentlas/AgentsAtlas/app/src/lib/capability/records.ts).

export const UPLOAD_SCHEMA = "agentlas.reach.capability-record/v1";
export const MAX_RECORDS_PER_BATCH = 20;
export const MAX_BODY_BYTES = 90 * 1024;
// Something seen once is a sighting; something seen on two different days is established. Explored capabilities wait for the second day.
export const MIN_EXPLORED_DAYS = 2;

export interface UploadApp {
  key: string;
  platform: "darwin" | "win32" | "linux";
  name: string;
  version?: string;
  fingerprint: string;
}

export interface UploadRecord {
  app: { platform: string; id: string; name: string; version?: string; fingerprint: string };
  capability: {
    id: string;
    tier: "published" | "explored";
    kind: string;
    name: string;
    description?: string;
    parameters: Array<{ name: string; type: string; required: boolean; description?: string }>;
    result?: string;
    effect: { class: string; basis: string };
    body: { kind: "steps"; steps: Array<{ tool: string; args: Record<string, string | number | boolean | string[]> }> } | { kind: "adapter"; interface: string; ref: string };
    status: "verified";
  };
  evidence: { verification: "published" | "structural" | "behavioral"; observations: number; firstSeenDay: string; lastSeenDay: string };
}

export interface ScreenContext {
  // The things that identify this machine or person: never allowed to appear in anything sent.
  username: string;
  hostname: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const PERSONAL_PATH = /(?:^|[\s"'(=])(?:\/Users\/|\/home\/|\/Volumes\/|\/var\/folders\/|\/run\/media\/|[A-Za-z]:\\Users\\|\\\\wsl\$\\|\\\\[^\\\s]+\\)/i;
const LONG_DIGITS = /\d{12,}/;
const SENSITIVE_WORD = /(password|passwd|passphrase|secret|token|api[_ -]?key|bearer)/i;
const SECRET_SHAPES = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// null = fine; otherwise why it is not.
export function unsafeReason(text: string, context: ScreenContext): string | null {
  if (CONTROL.test(text)) return "control_character";
  if (URL_CREDENTIALS.test(text)) return "url_credentials"; // before the e-mail check: user:pw@host also looks like an address
  if (EMAIL.test(text)) return "email";
  if (PERSONAL_PATH.test(text)) return "personal_path";
  if (LONG_DIGITS.test(text)) return "long_number";
  if (SECRET_SHAPES.test(text)) return "secret_shape";
  const lower = text.toLowerCase();
  for (const identity of [context.username, context.hostname]) {
    const name = identity.trim().toLowerCase();
    if (name.length >= 3 && lower.includes(name)) return "machine_identity";
  }
  return null;
}

const APP_ID_PATTERN = /^(bundle|appx|desktop):[A-Za-z0-9._:@+\-!/ ]+$/;

function placeholder(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

type StepArg = string | number | boolean | string[];

// The runner keeps a step's target as an object; the wire format only allows flat values, so it is flattened: targetRole, targetLabel,
// targetNth. Nothing else is invented.
function flattenArgs(args: Record<string, unknown>, context: ScreenContext): Record<string, StepArg> | null {
  const out: Record<string, StepArg> = {};
  const put = (key: string, value: unknown): boolean => {
    if (typeof value === "string") {
      if (value.length > 200) return false;
      // A placeholder is a parameter slot, not data; its name may contain the word "token" etc. and is judged on the slot alone.
      if (!placeholder(value)) {
        if (SENSITIVE_WORD.test(value) || unsafeReason(value, context)) return false;
      }
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.length <= 16 && value.every((item) => typeof item === "string" && item.length <= 200 && !SENSITIVE_WORD.test(item) && !unsafeReason(item, context))) out[key] = [...(value as string[])];
    else return false;
    return true;
  };
  for (const [key, value] of Object.entries(args)) {
    if (key === "target" && value && typeof value === "object" && !Array.isArray(value)) {
      const target = value as Record<string, unknown>;
      for (const [inner, innerValue] of Object.entries(target)) {
        const flat = `target${inner[0].toUpperCase()}${inner.slice(1)}`;
        if (innerValue !== undefined && !put(flat, innerValue)) return null;
      }
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)) return null;
    if (!put(key, value)) return null;
  }
  return out;
}

function sanitizeParameters(parameters: readonly CapabilityParameter[], context: ScreenContext): UploadRecord["capability"]["parameters"] | null {
  if (parameters.length > 24) return null;
  const out: UploadRecord["capability"]["parameters"] = [];
  for (const parameter of parameters) {
    if (!/^[A-Za-z][A-Za-z0-9_ .\-]{0,59}$/.test(parameter.name)) return null;
    // Option lists can run long and are captions, not structure: a long list is shortened to the bare type.
    let type = parameter.type;
    if (type.length > 60) type = type.startsWith("enum:") ? "enum" : type.slice(0, 60);
    if (unsafeReason(type, context)) type = type.startsWith("enum:") ? "enum" : "string";
    let description = parameter.description;
    if (description !== undefined && (description.length > 160 || unsafeReason(description, context))) description = undefined;
    out.push({ name: parameter.name, type, required: parameter.required, ...(description ? { description } : {}) });
  }
  return out;
}

const ADAPTER_BY_SOURCE: Record<string, string> = {
  sdef: "applescript",
  dbus: "dbus",
  "windows-app-action": "appx-action",
  "desktop-action": "desktop-action",
  "uri-protocol": "uri-protocol",
  "execution-alias": "execution-alias",
};

export type RecordVerdict = { ok: true; record: UploadRecord } | { ok: false; reason: string };

export function toUploadRecord(app: UploadApp, capability: Capability, day: string, context: ScreenContext): RecordVerdict {
  const no = (reason: string): RecordVerdict => ({ ok: false, reason });
  if (!APP_ID_PATTERN.test(app.key) || app.key.length > 160) return no("app_id");
  if (capability.generic) return no("generic");
  if (capability.tier !== "published" && capability.tier !== "explored") return no("tier");
  if (capability.tier === "explored" && capability.status !== "verified") return no("not_verified");
  if (capability.tier === "published" && capability.status !== undefined && capability.status !== "verified") return no("not_verified");
  if (capability.granularity === "property" && capability.tier === "published") return no("property_entry"); // thousands of getters add nothing a dictionary does not already say
  if (capability.name.length > 120 || capability.id.length > 240) return no("too_long");

  let evidence: UploadRecord["evidence"];
  let body: UploadRecord["capability"]["body"];
  if (capability.tier === "published") {
    const iface = ADAPTER_BY_SOURCE[capability.source.kind];
    if (!iface) return no("source_not_shared");
    if (capability.source.ref.length > 240) return no("too_long");
    body = { kind: "adapter", interface: iface, ref: capability.source.ref };
    evidence = { verification: "published", observations: 1, firstSeenDay: day, lastSeenDay: day };
  } else {
    if (capability.body?.kind !== "steps") return no("no_steps");
    if (capability.verification !== "structural" && capability.verification !== "behavioral") return no("verification");
    const seen = capability.evidence;
    if (!seen || seen.observations < MIN_EXPLORED_DAYS || seen.firstSeenDay >= seen.lastSeenDay) return no("seen_once");
    const steps: Array<{ tool: string; args: Record<string, StepArg> }> = [];
    for (const step of capability.body.steps) {
      const args = flattenArgs(step.args, context);
      if (!args) return no("unsafe_step");
      steps.push({ tool: step.tool, args });
    }
    if (steps.length === 0 || steps.length > 32) return no("steps");
    body = { kind: "steps", steps };
    evidence = { verification: capability.verification, observations: Math.min(seen.observations, 1000), firstSeenDay: seen.firstSeenDay, lastSeenDay: seen.lastSeenDay };
  }

  for (const text of [app.name, app.version ?? "", capability.name, capability.description ?? "", capability.result ?? "", capability.source.ref]) {
    if (text && unsafeReason(text, context)) return no(`unsafe_${unsafeReason(text, context)}`);
  }
  const parameters = sanitizeParameters(capability.parameters, context);
  if (!parameters) return no("parameters");
  const description = capability.description && capability.description.length <= 300 ? capability.description : undefined;
  return {
    ok: true,
    record: {
      app: { platform: app.platform, id: app.key, name: app.name.slice(0, 80), ...(app.version && app.version.length <= 32 ? { version: app.version } : {}), fingerprint: app.fingerprint },
      capability: {
        id: capability.id,
        tier: capability.tier,
        kind: capability.kind,
        name: capability.name,
        ...(description ? { description } : {}),
        parameters,
        ...(capability.result && capability.result.length <= 80 ? { result: capability.result } : {}),
        effect: { class: capability.effect.class, basis: capability.effect.basis },
        body,
        status: "verified",
      },
      evidence,
    },
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// The same key the server dedupes on, so "already sent" can be remembered locally.
export function recordKey(record: UploadRecord): string {
  return createHash("sha256").update([record.app.platform, record.app.id, record.capability.id, stable(record.capability.body), stable(record.capability.parameters)].join("|")).digest("hex");
}

// Split into requests the server will accept: at most 20 records and 90 KB each.
export function batchRecords(records: readonly UploadRecord[], installId: string, client: { version: string; reach: string }): string[] {
  const bodies: string[] = [];
  let current: UploadRecord[] = [];
  const build = (list: UploadRecord[]): string => JSON.stringify({ schema: UPLOAD_SCHEMA, installId, client: { app: "agentlas-desktop", version: client.version, reach: client.reach }, records: list });
  for (const record of records) {
    const next = [...current, record];
    if (current.length > 0 && (next.length > MAX_RECORDS_PER_BATCH || Buffer.byteLength(build(next), "utf8") > MAX_BODY_BYTES)) {
      bodies.push(build(current));
      current = [record];
    } else current = next;
  }
  if (current.length > 0) bodies.push(build(current));
  return bodies.filter((body) => Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES);
}

export interface OutboxState {
  sent: Record<string, string>; // recordKey -> day sent
  rejected: Record<string, string>; // recordKey -> why (never retried)
  failures: number;
  nextAttemptAt: number;
}

const EMPTY: OutboxState = { sent: {}, rejected: {}, failures: 0, nextAttemptAt: 0 };
const MAX_REMEMBERED = 20_000;
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export class Outbox {
  constructor(private readonly file: string) {}
  async read(): Promise<OutboxState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as OutboxState;
      return { sent: parsed.sent ?? {}, rejected: parsed.rejected ?? {}, failures: parsed.failures ?? 0, nextAttemptAt: parsed.nextAttemptAt ?? 0 };
    } catch {
      return { ...EMPTY, sent: {}, rejected: {} };
    }
  }
  async write(state: OutboxState): Promise<void> {
    const trim = (map: Record<string, string>): Record<string, string> => {
      const entries = Object.entries(map);
      return entries.length <= MAX_REMEMBERED ? map : Object.fromEntries(entries.slice(entries.length - MAX_REMEMBERED));
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ...state, sent: trim(state.sent), rejected: trim(state.rejected) }), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}

export interface UploadPorts {
  endpoint: string;
  installId: () => string | null;
  client: { version: string; reach: string };
  context: ScreenContext;
  post: (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;
  outbox: Outbox;
  now: () => number;
  day: () => string;
  origin?: string;
}

export interface UploadCandidate { app: UploadApp; capability: Capability }

export interface FlushResult {
  status: "sent" | "nothing" | "waiting" | "no_install_id" | "blocked" | "failed";
  sent: number;
  dropped: Record<string, number>;
  requests: number;
}

// Priority: what was proven by exploration first, then published operations; at most this many records per flush, so one run never turns
// into hundreds of requests (the server allows 30 per hour per installation).
const MAX_RECORDS_PER_FLUSH = 400;

export async function flushUploads(ports: UploadPorts, candidates: readonly UploadCandidate[]): Promise<FlushResult> {
  const dropped: Record<string, number> = {};
  const drop = (reason: string): void => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const installId = ports.installId();
  if (!installId) return { status: "no_install_id", sent: 0, dropped, requests: 0 };
  const state = await ports.outbox.read();
  if (state.nextAttemptAt > ports.now()) return { status: "waiting", sent: 0, dropped, requests: 0 };

  const day = ports.day();
  const ready: Array<{ key: string; record: UploadRecord }> = [];
  const seenKeys = new Set<string>();
  const ordered = [...candidates].sort((a, b) => (a.capability.tier === b.capability.tier ? 0 : a.capability.tier === "explored" ? -1 : 1));
  for (const candidate of ordered) {
    const verdict = toUploadRecord(candidate.app, candidate.capability, day, ports.context);
    if (!verdict.ok) { drop(verdict.reason); continue; }
    const key = recordKey(verdict.record);
    if (state.sent[key] || state.rejected[key] || seenKeys.has(key)) continue;
    seenKeys.add(key);
    ready.push({ key, record: verdict.record });
    if (ready.length >= MAX_RECORDS_PER_FLUSH) break;
  }
  if (ready.length === 0) return { status: "nothing", sent: 0, dropped, requests: 0 };

  const bodies = batchRecords(ready.map((item) => item.record), installId, ports.client);
  const keysPerBody: string[][] = [];
  let cursor = 0;
  for (const body of bodies) {
    const count = (JSON.parse(body) as { records: unknown[] }).records.length;
    keysPerBody.push(ready.slice(cursor, cursor + count).map((item) => item.key));
    cursor += count;
  }
  let sent = 0;
  let requests = 0;
  const headers: Record<string, string> = { "content-type": "application/json", "x-agentlas-client": "desktop", ...(ports.origin ? { origin: ports.origin } : {}) };
  for (let i = 0; i < bodies.length; i += 1) {
    let status = 0;
    try { status = (await ports.post(ports.endpoint, bodies[i], headers)).status; } catch { status = 0; }
    requests += 1;
    if (status === 200 || status === 201) {
      for (const key of keysPerBody[i]) state.sent[key] = day;
      sent += keysPerBody[i].length;
      state.failures = 0;
      continue;
    }
    if (status === 400 || status === 413) {
      // The server refuses this batch for what it contains: remember it as rejected so it is never sent again, and carry on.
      for (const key of keysPerBody[i]) state.rejected[key] = `http_${status}`;
      continue;
    }
    if (status === 403) { state.nextAttemptAt = ports.now() + 24 * 3_600_000; await ports.outbox.write(state); return { status: "blocked", sent, dropped, requests }; }
    // 429, 5xx, no network: wait, with the backoff growing
    state.failures += 1;
    state.nextAttemptAt = ports.now() + (status === 429 ? 3_600_000 : BACKOFF_MS[Math.min(state.failures - 1, BACKOFF_MS.length - 1)]);
    await ports.outbox.write(state);
    return { status: "failed", sent, dropped, requests };
  }
  await ports.outbox.write(state);
  return { status: "sent", sent, dropped, requests };
}
