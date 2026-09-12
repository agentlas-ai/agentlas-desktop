import { randomUUID } from "node:crypto";
import { deleteSecret, readSecret, setSecret } from "../secrets/vault";
import {
  BROWSER_AUTOFILL_SCHEMA_VERSION,
  type BrowserAutofillResult,
  type BrowserAutofillSnapshot,
  type BrowserContactField,
  type BrowserContactMetadata,
  type BrowserContactValues,
  type BrowserCredentialMetadata,
} from "../../shared/browser-autofill";

const VAULT_KEY = "browser.autofill.v1";
const MAX_RECORDS = 100;
const MAX_VAULT_BYTES = 256 * 1024;
const CONTACT_FIELDS: BrowserContactField[] = [
  "name", "email", "phone", "organization", "addressLine1", "addressLine2",
  "city", "region", "postalCode", "country",
];

interface CredentialRecord {
  id: string;
  origin: string;
  label: string;
  username: string;
  password: string;
  createdAt: string;
  updatedAt: string;
}

interface ContactRecord {
  id: string;
  label: string;
  fields: BrowserContactValues;
  createdAt: string;
  updatedAt: string;
}

interface AutofillState {
  schemaVersion: typeof BROWSER_AUTOFILL_SCHEMA_VERSION;
  credentials: CredentialRecord[];
  contacts: ContactRecord[];
}

type StateRead = { ok: true; state: AutofillState } | { ok: false; reason: "vault-unavailable" | "vault-corrupt" };
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyState(): AutofillState {
  return { schemaVersion: BROWSER_AUTOFILL_SCHEMA_VERSION, credentials: [], contacts: [] };
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
}

function validId(value: unknown, prefix: "credential" | "contact"): value is string {
  return typeof value === "string" && new RegExp(`^browser_${prefix}_[a-f0-9]{32}$`, "u").test(value);
}

function normalizeOrigin(input: unknown): string | null {
  try {
    const url = new URL(String(input ?? ""));
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !local)) return null;
    return url.origin;
  } catch { return null; }
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCredential(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CredentialRecord>;
  return validId(row.id, "credential") && normalizeOrigin(row.origin) === row.origin
    && typeof row.label === "string" && row.label.length > 0 && row.label.length <= 120
    && typeof row.username === "string" && row.username.length <= 512
    && typeof row.password === "string" && row.password.length > 0 && row.password.length <= 4096
    && validIso(row.createdAt) && validIso(row.updatedAt);
}

function validContact(value: unknown): value is ContactRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ContactRecord>;
  if (!validId(row.id, "contact") || typeof row.label !== "string" || row.label.length < 1 || row.label.length > 120
    || !row.fields || typeof row.fields !== "object" || !validIso(row.createdAt) || !validIso(row.updatedAt)) return false;
  const entries = Object.entries(row.fields);
  return entries.length > 0 && entries.every(([key, field]) => CONTACT_FIELDS.includes(key as BrowserContactField)
    && typeof field === "string" && field.length > 0 && field.length <= 512);
}

async function readState(): Promise<StateRead> {
  let raw: string | null;
  try { raw = await readSecret(VAULT_KEY); }
  catch { return { ok: false, reason: "vault-unavailable" }; }
  if (raw === null) return { ok: true, state: emptyState() };
  if (Buffer.byteLength(raw, "utf8") > MAX_VAULT_BYTES) return { ok: false, reason: "vault-corrupt" };
  try {
    const parsed = JSON.parse(raw) as Partial<AutofillState>;
    if (parsed.schemaVersion !== BROWSER_AUTOFILL_SCHEMA_VERSION
      || !Array.isArray(parsed.credentials) || parsed.credentials.length > MAX_RECORDS
      || !Array.isArray(parsed.contacts) || parsed.contacts.length > MAX_RECORDS
      || !parsed.credentials.every(validCredential) || !parsed.contacts.every(validContact)) {
      return { ok: false, reason: "vault-corrupt" };
    }
    return { ok: true, state: parsed as AutofillState };
  } catch { return { ok: false, reason: "vault-corrupt" }; }
}

async function writeState(state: AutofillState): Promise<void> {
  if (state.credentials.length === 0 && state.contacts.length === 0) {
    await deleteSecret(VAULT_KEY);
    return;
  }
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json, "utf8") > MAX_VAULT_BYTES) throw new Error("browser_autofill_vault_too_large");
  await setSecret(VAULT_KEY, json);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function masked(value: string): string | null {
  if (!value) return null;
  if (value.includes("@")) {
    const [local, domain] = value.split("@", 2);
    return `${local.slice(0, 1) || "•"}${"•".repeat(Math.min(6, Math.max(2, local.length - 1)))}@${domain}`;
  }
  const digits = value.replace(/\D/gu, "");
  if (digits.length >= 4) return `${"•".repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
  return "•".repeat(Math.min(8, Math.max(3, value.length)));
}

function credentialMetadata(record: CredentialRecord): BrowserCredentialMetadata {
  return { id: record.id, label: record.label, origin: record.origin, maskedUsername: masked(record.username), hasPassword: true, updatedAt: record.updatedAt };
}

function contactMetadata(record: ContactRecord): BrowserContactMetadata {
  return { id: record.id, label: record.label, availableFields: CONTACT_FIELDS.filter((field) => Boolean(record.fields[field])),
    maskedEmail: masked(record.fields.email ?? ""), maskedPhone: masked(record.fields.phone ?? ""), updatedAt: record.updatedAt };
}

export async function browserAutofillSnapshot(): Promise<BrowserAutofillSnapshot> {
  const read = await readState();
  if (!read.ok) return { schemaVersion: BROWSER_AUTOFILL_SCHEMA_VERSION, state: "unavailable", credentials: [], contacts: [], reason: read.reason };
  return { schemaVersion: BROWSER_AUTOFILL_SCHEMA_VERSION, state: "ready",
    credentials: read.state.credentials.map(credentialMetadata), contacts: read.state.contacts.map(contactMetadata) };
}

export function saveBrowserCredential(input: { id?: string; origin: string; label: string; username: string; password: string }) {
  return enqueue(async (): Promise<BrowserAutofillResult & { credential?: BrowserCredentialMetadata }> => {
    const origin = normalizeOrigin(input?.origin);
    const label = clean(input?.label, 120);
    const username = clean(input?.username, 512);
    const password = String(input?.password ?? "").slice(0, 4096);
    if (!origin || !label || !password || (input.id !== undefined && !validId(input.id, "credential"))) return { ok: false, reason: "invalid-request" };
    const read = await readState();
    if (!read.ok) return { ok: false, reason: read.reason };
    const existing = input.id ? read.state.credentials.find((row) => row.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, reason: "item-not-found" };
    const now = new Date().toISOString();
    const record: CredentialRecord = { id: existing?.id ?? `browser_credential_${randomUUID().replace(/-/gu, "")}`,
      origin, label, username, password, createdAt: existing?.createdAt ?? now, updatedAt: now };
    read.state.credentials = [...read.state.credentials.filter((row) => row.id !== record.id), record];
    if (read.state.credentials.length > MAX_RECORDS) return { ok: false, reason: "invalid-request" };
    try { await writeState(read.state); }
    catch { return { ok: false, reason: "vault-unavailable" }; }
    return { ok: true, credential: credentialMetadata(record) };
  });
}

export function removeBrowserCredential(input: { id: string }) {
  return enqueue(async (): Promise<BrowserAutofillResult> => {
    if (!validId(input?.id, "credential")) return { ok: false, reason: "invalid-request" };
    const read = await readState();
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!read.state.credentials.some((row) => row.id === input.id)) return { ok: false, reason: "item-not-found" };
    read.state.credentials = read.state.credentials.filter((row) => row.id !== input.id);
    try { await writeState(read.state); return { ok: true }; }
    catch { return { ok: false, reason: "vault-unavailable" }; }
  });
}

export function saveBrowserContact(input: { id?: string; label: string; fields: BrowserContactValues }) {
  return enqueue(async (): Promise<BrowserAutofillResult & { contact?: BrowserContactMetadata }> => {
    const label = clean(input?.label, 120);
    const fields = Object.fromEntries(CONTACT_FIELDS.map((field) => [field, clean(input?.fields?.[field], 512)])
      .filter(([, value]) => Boolean(value))) as BrowserContactValues;
    if (!label || Object.keys(fields).length === 0 || (input.id !== undefined && !validId(input.id, "contact"))) return { ok: false, reason: "invalid-request" };
    const read = await readState();
    if (!read.ok) return { ok: false, reason: read.reason };
    const existing = input.id ? read.state.contacts.find((row) => row.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, reason: "item-not-found" };
    const now = new Date().toISOString();
    const record: ContactRecord = { id: existing?.id ?? `browser_contact_${randomUUID().replace(/-/gu, "")}`,
      label, fields, createdAt: existing?.createdAt ?? now, updatedAt: now };
    read.state.contacts = [...read.state.contacts.filter((row) => row.id !== record.id), record];
    if (read.state.contacts.length > MAX_RECORDS) return { ok: false, reason: "invalid-request" };
    try { await writeState(read.state); }
    catch { return { ok: false, reason: "vault-unavailable" }; }
    return { ok: true, contact: contactMetadata(record) };
  });
}

export function removeBrowserContact(input: { id: string }) {
  return enqueue(async (): Promise<BrowserAutofillResult> => {
    if (!validId(input?.id, "contact")) return { ok: false, reason: "invalid-request" };
    const read = await readState();
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!read.state.contacts.some((row) => row.id === input.id)) return { ok: false, reason: "item-not-found" };
    read.state.contacts = read.state.contacts.filter((row) => row.id !== input.id);
    try { await writeState(read.state); return { ok: true }; }
    catch { return { ok: false, reason: "vault-unavailable" }; }
  });
}

/** Main-only plaintext access. Callers must never forward the returned record over IPC. */
export async function browserCredentialForFill(id: string): Promise<{ ok: true; record: CredentialRecord } | { ok: false; reason: "vault-unavailable" | "vault-corrupt" | "item-not-found" }> {
  const read = await readState();
  if (!read.ok) return read;
  const record = read.state.credentials.find((row) => row.id === id);
  return record ? { ok: true, record } : { ok: false, reason: "item-not-found" };
}

/** Main-only plaintext access. Callers must never forward the returned record over IPC. */
export async function browserContactForFill(id: string): Promise<{ ok: true; record: ContactRecord } | { ok: false; reason: "vault-unavailable" | "vault-corrupt" | "item-not-found" }> {
  const read = await readState();
  if (!read.ok) return read;
  const record = read.state.contacts.find((row) => row.id === id);
  return record ? { ok: true, record } : { ok: false, reason: "item-not-found" };
}
