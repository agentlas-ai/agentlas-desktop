import type { InstallIdentity } from "./install-identity";
import type { IpcMain } from "electron";
import { normalizeIpcArgsInPlace } from "./ipc-args-normalize";
import { encodeIpcErrorMessage, isIpcErrorCode } from "../shared/ipc-error-code";

// Capture only the launch request. The environment cannot grant admission:
// Main must supply the actual package state and validated install identity.
const requestedAtLaunch = process.env.AGENTLAS_DEV_NO_EXTERNAL_EFFECTS === "1";
let configured: Readonly<{ suppressed: boolean; channel: InstallIdentity["channel"]; packaged: boolean }> | null = null;

/** May only suppress pre-configuration diagnostics; it never grants admission. */
export function developmentEffectPolicyRequested(): boolean { return requestedAtLaunch; }

export class DevelopmentEffectPolicyError extends Error {
  constructor(
    readonly code: "development_effect_policy_unconfigured" | "development_effect_policy_disabled" | "development_effect_policy_refused",
    readonly operation: string,
  ) {
    super(`${code}: ${operation}`);
    this.name = "DevelopmentEffectPolicyError";
  }
}

/** Called once by Main before opening storage or starting application services. */
export function configureDevelopmentEffectPolicy(input: { packaged: boolean; identity: InstallIdentity }): void {
  const suppressed = requestedAtLaunch;
  if (suppressed && (input.packaged || !["dev", "qa"].includes(input.identity.channel))) {
    throw new DevelopmentEffectPolicyError("development_effect_policy_refused", "startup");
  }
  if (configured) {
    if (configured.packaged !== input.packaged || configured.channel !== input.identity.channel) {
      throw new DevelopmentEffectPolicyError("development_effect_policy_refused", "reconfigure");
    }
    return;
  }
  configured = Object.freeze({ suppressed, packaged: input.packaged, channel: input.identity.channel });
}

/** No native imports or probing. A requested but unconfigured process fails closed. */
export function developmentEffectsSuppressed(): boolean {
  if (configured) return configured.suppressed;
  if (requestedAtLaunch) {
    throw new DevelopmentEffectPolicyError("development_effect_policy_unconfigured", "admission");
  }
  return false;
}

export function assertDevelopmentEffectAllowed(operation: string): void {
  if (developmentEffectsSuppressed()) {
    throw new DevelopmentEffectPolicyError("development_effect_policy_disabled", operation);
  }
}

/** Local product assets and the exact loopback development renderer origin only. */
export function developmentRendererRequestAllowed(rawUrl: string, devStartUrl?: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "agentlas:") return ["app", "one-artifact", "one-avatar", "chat-attachment", "localfile"].includes(url.hostname);
    if (url.protocol === "file:") return url.hostname === "";
    if (["data:", "blob:"].includes(url.protocol)) return true;
    if (!devStartUrl) return false;
    const start = new URL(devStartUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(start.hostname)
      || !["http:", "https:"].includes(start.protocol)
      || start.username || start.password || url.username || url.password) return false;
    const transport = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    return transport === start.protocol && url.hostname === start.hostname && url.port === start.port;
  } catch {
    return false;
  }
}

const DEVELOPMENT_LOCAL_IPC_CHANNELS = new Set([
  "auth:getSession", "app:getLocale", "menu:setLocale", "confirm:listPendingAskUser",
  "surfaces:get", "workspace:get",
  "fs:listDirectory", "fs:readTextFile", "chatFiles:listGroup", "oneArtifacts:issuePreview",
  "localModelHub:snapshot", "localModelHub:cancelOperation", "localModelHub:unload",
  "workLiveView:releaseLease",
  "appFactory:releaseLivePreview",
  // These two handlers return explicit suppression before runtime detection.
  "usage:snapshot", "usage:retry",
  // Terminal actions retain their original ownership and argument validation.
  "fs:unwatchFile", "oneArtifacts:revokePreview", "site:stopAgentApp", "multimodal:cancelVideo",
  "marketplace:closeProfileView", "telegram:stop", "browser:stopLiveView", "automations:stopRun",
  "appFactory:stopLivePreview", "workLiveView:close", "invoke:cancel", "hephaestus:cancelBuild",
  "hephaestus:stopStudio", "productExtensions:closeScienceView", "science:composer:cancel", "science:renderers:dispose", "science:manuscripts:cancelRenderJob",
  "browserAnnotation:stop", "browserUi:stopFind",
]);

export function assertDevelopmentIpcAllowed(channel: string, args: readonly unknown[]): void {
  if (!developmentEffectsSuppressed()) return;
  if (DEVELOPMENT_LOCAL_IPC_CHANNELS.has(channel)) return;
  if (channel === "confirm:submitAskUserAnswer" && args[1] === null) return;
  throw new DevelopmentEffectPolicyError("development_effect_policy_disabled", `ipc:${channel}`);
}

/**
 * Local registration adapter; never replaces Electron's global IPC object.
 * Every Main `handle` registration goes through here, so this is also the one
 * place where "key present with value undefined" becomes "key absent" before
 * any handler or validator sees the arguments (see ./ipc-args-normalize).
 */
/*
 * ★2026-09-23 — Electron 은 핸들러 오류의 message 만 화면으로 넘긴다. 코드 붙은 오류
 *   (OneTeamPreflightError·OneAttachmentError·MobileBridgePairingError·MemoryRevokedError…)의
 *   `.code` 가 전부 사라져 화면의 코드 분기가 영원히 안 탔다. 이 경계 한 자리에서
 *   문자열 code 를 message 접두어로 싣는다(shared/ipc-error-code). 화면은 ipcErrorCode() 로 읽는다.
 *   로그에는 채널과 코드만 남긴다(사용자 내용 없음).
 */
function codedIpcError(channel: string, error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const code = (error as { code?: unknown }).code;
  if (!isIpcErrorCode(code)) return error;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  const encoded = encodeIpcErrorMessage(code, message);
  console.warn(`[ipc] refused channel=${channel.slice(0, 96)} code=${code}`);
  if (encoded === message) return error;
  const wrapped = new Error(encoded);
  wrapped.name = error instanceof Error ? error.name : "Error";
  Object.defineProperty(wrapped, "code", { value: code, enumerable: true });
  return wrapped;
}

export function developmentIpcBoundary(source: Pick<IpcMain, "handle">): Pick<IpcMain, "handle"> {
  return {
    handle(channel, listener) {
      source.handle(channel, (event, ...args) => {
        normalizeIpcArgsInPlace(args);
        assertDevelopmentIpcAllowed(channel, args);
        let result: unknown;
        try {
          result = listener(event, ...args);
        } catch (error) {
          throw codedIpcError(channel, error);
        }
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          return Promise.resolve(result).catch((error: unknown) => { throw codedIpcError(channel, error); });
        }
        return result;
      });
    },
  };
}
