import type { WebContents } from "electron";
import type {
  BrowserAutofillResult,
  BrowserContactField,
  BrowserContactValues,
} from "../../shared/browser-autofill";
import type { BrowserUiTarget } from "../../shared/browser-ui";
import { nativeBrowserGuest, nativeBrowserGuestDocument } from "../work-live-view";
import { browserContactForFill, browserCredentialForFill } from "./autofill-vault";

function validTarget(input: BrowserUiTarget): boolean {
  return Boolean(input) && /^[A-Za-z0-9_-]{8,80}$/u.test(String(input.viewId ?? ""))
    && /^[A-Za-z0-9_:.-]{8,200}$/u.test(String(input.taskScopeId ?? ""));
}

function documentOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const local = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.protocol === "https:" || local ? parsed.origin : null;
  } catch { return null; }
}

function sameDocument(a: { webContentsId: number; navigationEpoch: number }, b: { webContentsId: number; navigationEpoch: number } | null): boolean {
  return Boolean(b) && a.webContentsId === b!.webContentsId && a.navigationEpoch === b!.navigationEpoch;
}

function guestAndDocument(ownerId: number, input: BrowserUiTarget): { contents: WebContents; document: { webContentsId: number; navigationEpoch: number; state: string; url: string } } | null {
  if (!validTarget(input)) return null;
  const contents = nativeBrowserGuest(ownerId, input.taskScopeId, input.viewId);
  const document = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  return contents && document?.state === "ready" ? { contents, document } : null;
}

const FILL_SCRIPT = String.raw`((payload) => {
  const selectors = {
    username: ['input[autocomplete="username"]','input[autocomplete="email"]','input[type="email"]','input[name*="user" i]','input[name*="login" i]'],
    password: ['input[autocomplete="current-password"]','input[autocomplete="password"]','input[type="password"]'],
    name: ['input[autocomplete="name"]','input[name="name" i]','input[name*="full-name" i]','input[name*="fullname" i]'],
    email: ['input[autocomplete="email"]','input[type="email"]','input[name*="email" i]'],
    phone: ['input[autocomplete="tel"]','input[type="tel"]','input[name*="phone" i]','input[name*="mobile" i]'],
    organization: ['input[autocomplete="organization"]','input[name*="organization" i]','input[name*="company" i]'],
    addressLine1: ['input[autocomplete="address-line1"]','input[name*="address1" i]','input[name*="address-line1" i]','input[name*="street" i]'],
    addressLine2: ['input[autocomplete="address-line2"]','input[name*="address2" i]','input[name*="address-line2" i]'],
    city: ['input[autocomplete="address-level2"]','input[name*="city" i]'],
    region: ['input[autocomplete="address-level1"]','input[name*="state" i]','input[name*="region" i]'],
    postalCode: ['input[autocomplete="postal-code"]','input[name*="postal" i]','input[name*="zip" i]'],
    country: ['input[autocomplete="country-name"]','input[name*="country" i]']
  };
  const visible = (node) => !node.disabled && !node.readOnly && node.getClientRects().length > 0;
  const setValue = (node, value) => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const filled = [];
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value !== 'string' || !value || !selectors[field]) continue;
    const node = selectors[field].map((selector) => document.querySelector(selector)).find((candidate) => candidate && visible(candidate));
    if (node && setValue(node, value)) filled.push(field);
  }
  return filled;
})`;

async function inject(contents: WebContents, values: Record<string, string>): Promise<string[] | null> {
  try {
    const result = await contents.executeJavaScript(`${FILL_SCRIPT}(${JSON.stringify(values)})`, true);
    return Array.isArray(result) && result.every((value) => typeof value === "string") ? result : null;
  } catch { return null; }
}

export async function fillBrowserCredential(ownerId: number, input: BrowserUiTarget & {
  credentialId: string;
  userConfirmed: true;
}): Promise<BrowserAutofillResult & {
  filled?: { username: boolean; password: boolean };
  document?: { webContentsId: number; navigationEpoch: number };
}> {
  if (input?.userConfirmed !== true) return { ok: false, reason: "user-confirmation-required" };
  const scoped = guestAndDocument(ownerId, input);
  if (!scoped) return { ok: false, reason: validTarget(input) ? "guest-unavailable" : "invalid-request" };
  const saved = await browserCredentialForFill(String(input.credentialId ?? ""));
  if (!saved.ok) return { ok: false, reason: saved.reason };
  if (documentOrigin(scoped.document.url) !== saved.record.origin) return { ok: false, reason: "origin-mismatch" };
  const filled = await inject(scoped.contents, { username: saved.record.username, password: saved.record.password });
  const latest = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  if (!sameDocument(scoped.document, latest)) return { ok: false, reason: "guest-changed" };
  if (!filled) return { ok: false, reason: "operation-failed" };
  return { ok: true, filled: { username: filled.includes("username"), password: filled.includes("password") },
    document: { webContentsId: scoped.document.webContentsId, navigationEpoch: scoped.document.navigationEpoch } };
}

export async function fillBrowserContact(ownerId: number, input: BrowserUiTarget & {
  contactId: string;
  userConfirmed: true;
}): Promise<BrowserAutofillResult & {
  filledFields?: BrowserContactField[];
  document?: { webContentsId: number; navigationEpoch: number };
}> {
  if (input?.userConfirmed !== true) return { ok: false, reason: "user-confirmation-required" };
  const scoped = guestAndDocument(ownerId, input);
  if (!scoped) return { ok: false, reason: validTarget(input) ? "guest-unavailable" : "invalid-request" };
  if (!documentOrigin(scoped.document.url)) return { ok: false, reason: "origin-mismatch" };
  const saved = await browserContactForFill(String(input.contactId ?? ""));
  if (!saved.ok) return { ok: false, reason: saved.reason };
  const filled = await inject(scoped.contents, saved.record.fields as Record<string, string>);
  const latest = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  if (!sameDocument(scoped.document, latest)) return { ok: false, reason: "guest-changed" };
  if (!filled) return { ok: false, reason: "operation-failed" };
  return { ok: true, filledFields: filled as BrowserContactField[],
    document: { webContentsId: scoped.document.webContentsId, navigationEpoch: scoped.document.navigationEpoch } };
}
