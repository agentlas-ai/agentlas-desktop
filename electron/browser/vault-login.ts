/*
 * Vault sign-in rung of the login-recovery ladder (owner 2026-09-29: "유료작업 빼고 다 하셈").
 *
 * After the cookie import, the owner's own saved credential in the Agentlas autofill vault may complete the
 * sign-in. Everything here runs in Main: the credential is read from the vault and written into the page by a
 * Main-side script; the model never receives, sees or logs the value, and nothing here logs it either. Only a
 * state code leaves this file. A one-time-code step (OTP / 2FA) is never guessed: it is the owner's (card).
 *
 * Matching is structural: the vault record's origin must equal the page origin, or share its registrable domain
 * (accounts.example.com for example.com). Fields are found by autocomplete/type attributes, not by page wording.
 */
import type { VaultFillReport } from "./login-recovery";
import { registrableDomain } from "../../shared/registrable-domain";

/** A page Main can script. evaluate() must run in the page and resolve with the JSON value. */
export interface VaultFillPage {
  /** Read the current document URL, rather than a target-list snapshot. */
  url: () => string | null | Promise<string | null>;
  evaluate: (expression: string) => Promise<unknown>;
  /** Resolves with the page URL once the navigation after a submit has settled (bounded by the caller). */
  settled: () => Promise<string | null>;
}

export interface VaultCredentialSource {
  /** Metadata only (no secrets). */
  list: () => Promise<Array<{ id: string; origin: string; hasPassword: boolean; updatedAt: string }>>;
  /** Main-only secret read by id. */
  read: (id: string) => Promise<{ username: string; password: string } | null>;
}

/** Structural probe: which sign-in fields are visible, and is this a one-time-code step. */
export const VAULT_PROBE_SOURCE = `(() => {
  const visible = (n) => n && !n.disabled && !n.readOnly && n.getClientRects().length > 0;
  const q = (list) => list.map((s) => document.querySelector(s)).find(visible) || null;
  const otp = q(['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[name="totpPin"]', 'input[name*="verification_code" i]']);
  const user = q(['input[autocomplete="username"]', 'input[autocomplete="email"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="login" i]', 'input[name="identifier"]']);
  const pass = q(['input[autocomplete="current-password"]', 'input[autocomplete="password"]', 'input[type="password"]']);
  return { otp: Boolean(otp), user: Boolean(user), pass: Boolean(pass) };
})()`;

/**
 * Fill whatever of username/password is visible and submit that form. The payload is embedded by JSON.stringify
 * into a Main-only evaluation; the returned value names the fields, never their values.
 */
export function vaultFillSource(values: { username: string; password: string }, permittedOrigin: string): string {
  return `((payload) => {
  if (location.origin !== ${JSON.stringify(permittedOrigin)} || window.top !== window) {
    return { user: false, pass: false, submitted: false, reason: 'vault-origin-changed' };
  }
  const visible = (n) => n && !n.disabled && !n.readOnly && n.getClientRects().length > 0;
  const q = (list) => list.map((s) => document.querySelector(s)).find(visible) || null;
  const user = q(['input[autocomplete="username"]', 'input[autocomplete="email"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="login" i]', 'input[name="identifier"]']);
  const pass = q(['input[autocomplete="current-password"]', 'input[autocomplete="password"]', 'input[type="password"]']);
  const set = (node, value) => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (!setter) return false;
    node.focus(); setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const filled = { user: false, pass: false, submitted: false };
  if (user && payload.username) filled.user = set(user, payload.username);
  if (pass && payload.password) filled.pass = set(pass, payload.password);
  const field = pass || user;
  const form = field && field.form;
  if (form && (filled.user || filled.pass)) {
    const button = form.querySelector('button[type="submit"],input[type="submit"]');
    if (button && visible(button)) { button.click(); filled.submitted = true; }
    else if (typeof form.requestSubmit === 'function') { form.requestSubmit(); filled.submitted = true; }
  } else if (field && (filled.user || filled.pass)) {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    filled.submitted = true;
  }
  return filled;
})(${JSON.stringify(values)})`;
}

function originOf(url: string | null): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : null;
  } catch { return null; }
}

/** Pick the owner's saved credential for this page: exact origin first, then the same registrable domain. */
export function pickVaultCredential(pageUrl: string | null, records: Array<{ id: string; origin: string; hasPassword: boolean; updatedAt: string }>): string | null {
  const page = originOf(pageUrl);
  if (!page) return null;
  const usable = records.filter((row) => row.hasPassword);
  const byRecent = (a: { updatedAt: string }, b: { updatedAt: string }) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const exact = usable.filter((row) => row.origin === page.origin).sort(byRecent);
  if (exact.length) return exact[0].id;
  const site = registrableDomain(page.hostname);
  const same = usable.filter((row) => {
    try { return registrableDomain(new URL(row.origin).hostname) === site; } catch { return false; }
  }).sort(byRecent);
  return same[0]?.id ?? null;
}

type Probe = { otp: boolean; user: boolean; pass: boolean };
function asProbe(value: unknown): Probe | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return { otp: row.otp === true, user: row.user === true, pass: row.pass === true };
}

/** Up to two phases (identifier page, then password page). Bounded; never retries a rejected password. */
export async function vaultFillSignIn(page: VaultFillPage, vault: VaultCredentialSource): Promise<VaultFillReport> {
  let records: Awaited<ReturnType<VaultCredentialSource["list"]>>;
  try { records = await vault.list(); } catch { return { state: "unavailable" }; }
  const currentUrl = async () => { try { return await page.url(); } catch { return null; } };
  const initialUrl = await currentUrl();
  const permitted = originOf(initialUrl);
  if (!permitted) return { state: "failed", reason: "vault-page-unavailable", urlAfter: initialUrl };
  const id = pickVaultCredential(initialUrl, records);
  if (!id) return { state: "no-credential" };
  let urlAfter: string | null = initialUrl;
  const checkOrigin = async (): Promise<VaultFillReport | null> => {
    urlAfter = await currentUrl();
    const current = originOf(urlAfter);
    if (!current) return { state: "failed", reason: "vault-page-unavailable", urlAfter };
    if (current.origin !== permitted.origin) return { state: "failed", reason: "vault-origin-changed", urlAfter };
    return null;
  };
  for (let phase = 0; phase < 2; phase += 1) {
    const denied = await checkOrigin();
    if (denied) return denied;
    const probe = asProbe(await page.evaluate(VAULT_PROBE_SOURCE).catch(() => null));
    if (!probe) return { state: "failed", urlAfter };
    if (probe.otp) return { state: "second-factor", urlAfter };
    if (!probe.user && !probe.pass) return phase === 0 ? { state: "failed", urlAfter } : { state: "submitted", urlAfter };
    const secret = await vault.read(id).catch(() => null);
    if (!secret) return { state: "unavailable" };
    // A vault read may yield while the page navigates. Recheck before sending any secret to that document;
    // the script also checks in the executing document to close the navigation race after this read.
    const changed = await checkOrigin();
    if (changed) return changed;
    const values = { username: probe.user ? secret.username : "", password: probe.pass ? secret.password : "" };
    const filled = await page.evaluate(vaultFillSource(values, permitted.origin)).catch(() => null) as { submitted?: unknown; pass?: unknown; reason?: unknown } | null;
    if (filled?.reason === "vault-origin-changed") return { state: "failed", reason: "vault-origin-changed", urlAfter: await currentUrl() };
    if (!filled || filled.submitted !== true) return { state: "failed", urlAfter };
    urlAfter = await page.settled().catch(() => null);
    if (filled.pass === true) {
      const after = asProbe(await page.evaluate(VAULT_PROBE_SOURCE).catch(() => null));
      if (after?.otp) return { state: "second-factor", urlAfter };
      return { state: "submitted", urlAfter };
    }
  }
  return { state: "submitted", urlAfter };
}

/** Production vault access (Main only). */
export function productionVaultSource(): VaultCredentialSource {
  return {
    list: async () => {
      const { browserAutofillSnapshot } = await import("./autofill-vault");
      const snapshot = await browserAutofillSnapshot();
      if (snapshot.state !== "ready") throw new Error("vault-unavailable");
      return snapshot.credentials.map((row) => ({ id: row.id, origin: row.origin, hasPassword: row.hasPassword, updatedAt: row.updatedAt }));
    },
    read: async (id) => {
      const { browserCredentialForFill } = await import("./autofill-vault");
      const saved = await browserCredentialForFill(id);
      return saved.ok ? { username: saved.record.username, password: saved.record.password } : null;
    },
  };
}
