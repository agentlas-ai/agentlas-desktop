// IPC for Settings → company server (Agentlas Enterprise Server) card. Status only crosses to the renderer.
//   enterpriseServer:status     ()                                                  -> EnterpriseServerStatus
//   enterpriseServer:enroll     ({ enrollmentCode, serverUrl?, serverKeyFingerprint? }) -> EnterpriseServerActionResult
//   enterpriseServer:recheck    ()                                                  -> EnterpriseServerActionResult
//   enterpriseServer:disconnect ({ confirm: true })                                 -> EnterpriseServerActionResult
// Every input is checked here, in Main: closed key sets, the code shape, https-only addresses (http for loopback), a 64-hex pin.
// The model cannot reach these (electron/app-control/policy.ts denies and omits enterpriseServer.*).
import type { IpcMain } from "electron";
import { registerAppControlDomainIpc } from "../app-control/ipc-registry";
import { normalizeServerUrl } from "./connection";
import { enterpriseServerFetch } from "./os-trust-fetch";
import {
  configureEnterpriseServerHost, disconnectEnterpriseDevice, enrollEnterpriseDevice, enterpriseServerStatus, recheckEnterpriseServer,
  type EnterpriseHost,
} from "./runtime";
import {
  ENROLLMENT_CODE_RE, SERVER_KEY_FINGERPRINT_RE, type EnterpriseErrorCode, type EnterpriseServerActionResult,
} from "../../shared/enterprise-server";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: EnterpriseErrorCode };

function plainObject(raw: unknown, allowed: readonly string[]): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(raw).every((k) => typeof k === "string" && allowed.includes(k));
}

/** Codes are typed by people: spaces trimmed, case folded. Fingerprints may be pasted with spaces or colons. */
export function parseEnrollInput(raw: unknown): Parsed<{ enrollmentCode: string; serverUrl: string | null; serverKeyFingerprint: string | null }> {
  if (!plainObject(raw, ["enrollmentCode", "serverUrl", "serverKeyFingerprint"])) return { ok: false, error: "invalid_request" };
  const code = typeof raw.enrollmentCode === "string" && raw.enrollmentCode.length <= 40 ? raw.enrollmentCode.trim().toUpperCase() : "";
  if (!ENROLLMENT_CODE_RE.test(code)) return { ok: false, error: "enrollment_code_format" };
  const urlGiven = raw.serverUrl !== undefined && raw.serverUrl !== null && raw.serverUrl !== "";
  const fpGiven = raw.serverKeyFingerprint !== undefined && raw.serverKeyFingerprint !== null && raw.serverKeyFingerprint !== "";
  let serverUrl: string | null = null, serverKeyFingerprint: string | null = null;
  if (urlGiven || fpGiven) {
    serverUrl = normalizeServerUrl(raw.serverUrl);
    if (!serverUrl) return { ok: false, error: "server_url_invalid" };
    const fp = typeof raw.serverKeyFingerprint === "string" && raw.serverKeyFingerprint.length <= 200
      ? raw.serverKeyFingerprint.replace(/[\s:]/g, "").toLowerCase() : "";
    if (!SERVER_KEY_FINGERPRINT_RE.test(fp)) return { ok: false, error: "fingerprint_invalid" };
    serverKeyFingerprint = fp;
  }
  return { ok: true, value: { enrollmentCode: code, serverUrl, serverKeyFingerprint } };
}

/** Disconnecting needs the literal confirmation the card's dialog sends. */
export function parseDisconnectInput(raw: unknown): Parsed<true> {
  return plainObject(raw, ["confirm"]) && raw.confirm === true ? { ok: true, value: true } : { ok: false, error: "confirm_required" };
}

const refused = (error: EnterpriseErrorCode): EnterpriseServerActionResult => ({ ok: false, error, status: enterpriseServerStatus() });

export function registerEnterpriseServerIpc(ipc: Pick<IpcMain, "handle">, hostOptions: EnterpriseHost): void {
  // OS trust store (a company server signed by an internal CA) unless the caller supplies its own transport.
  configureEnterpriseServerHost({ ...hostOptions, fetchImpl: hostOptions.fetchImpl ?? enterpriseServerFetch });
  registerAppControlDomainIpc(ipc, "enterpriseServer:status", () => enterpriseServerStatus());
  registerAppControlDomainIpc(ipc, "enterpriseServer:enroll", (raw: unknown) => {
    const parsed = parseEnrollInput(raw);
    return parsed.ok ? enrollEnterpriseDevice(parsed.value) : refused(parsed.error);
  });
  registerAppControlDomainIpc(ipc, "enterpriseServer:recheck", () => recheckEnterpriseServer());
  registerAppControlDomainIpc(ipc, "enterpriseServer:disconnect", (raw: unknown) => {
    const parsed = parseDisconnectInput(raw);
    return parsed.ok ? disconnectEnterpriseDevice() : refused(parsed.error);
  });
}
