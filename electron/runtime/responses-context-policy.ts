import type { RunnerRequest } from "./runner";
import { wrapSystemPrompt, cumulativeSurfaceGateText, surfaceFastPathHit } from "./runner";
import { pluginRouterPrompt } from "../plugins/router-prompt";
import { SURFACE_PROTOCOL } from "../surface-emitter";

export interface ResponsesContextPolicy {
  protocol: "responses.v1";
  provider: "openai" | "lmstudio";
  endpoint: string;
}
/** Explicit adapters only; an OpenAI-compatible URL proves no stored context. */
export function responsesContextPolicy(input: { runtimeKind: string; recoveryBackend?: string; host: string }): ResponsesContextPolicy | null {
  let url: URL;
  try { url = new URL(input.host); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const base = input.host.replace(/\/$/, "");
  if (input.runtimeKind === "byok" && input.recoveryBackend === "openai"
    && url.origin === "https://api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1") {
    return { protocol: "responses.v1", provider: "openai", endpoint: `${base}/responses` };
  }
  if (input.runtimeKind === "lmstudio" && ["http:", "https:"].includes(url.protocol)
    && ["", "/"].includes(url.pathname)) {
    return { protocol: "responses.v1", provider: "lmstudio", endpoint: `${base}/v1/responses` };
  }
  return null;
}
export interface RetainedResponsesPromptPacket {
  /** Exact wire system text whose digest binds the retained response chain. */
  systemPrompt: string;
  /** Host-selected per-turn instructions, framed in the current model input. */
  turnContext: string;
  /** Exact host instruction fragments; the context binding dedupes their ACKs. */
  stableBlocks: readonly string[];
}
/** Called by the host BEFORE delivery preparation. The actual agent definition,
 * permission and stable wrapper remain intact. Keyword-selected plugin/Surface
 * guidance travels on this turn without changing the retained system prefix. */
export function retainedResponsesPromptPacket(req: RunnerRequest): Readonly<RetainedResponsesPromptPacket> {
  const systemPrompt = req.minimalObservation ? req.systemPrompt : wrapSystemPrompt(
    req.systemPrompt, req.locale, req.permission, "", false, req.restrictedReadBoundary,
    req.untrustedNoTools, undefined, undefined, undefined, "exclude", undefined,
    req.sciencePromptProfile, req.judgmentOnly === true ? "host-judgment" : undefined,
  );
  // Preserve the existing early-return isolation profiles. A dynamic packet
  // must not reintroduce ordinary tools/plugins/Surface into those boundaries.
  if (req.minimalObservation || req.restrictedReadBoundary || req.untrustedNoTools
    || req.sciencePromptProfile || req.judgmentOnly) return Object.freeze({ systemPrompt, turnContext: "", stableBlocks: Object.freeze([]) });
  const stablePlugin = pluginRouterPrompt(""), selectedPlugin = pluginRouterPrompt(req.userPrompt);
  const plugin = selectedPlugin !== stablePlugin ? selectedPlugin : "";
  const surface = req.forceSurface === true || (req.surfaceGate !== "exclude"
    && surfaceFastPathHit(cumulativeSurfaceGateText(req.history, req.surfaceUserPrompt ?? req.userPrompt)))
    ? SURFACE_PROTOCOL : "";
  const blocks = [plugin, surface].filter(Boolean);
  return Object.freeze({ systemPrompt, stableBlocks: Object.freeze(blocks), turnContext: blocks.length
    ? `[Current turn runtime guidance]\n${blocks.join("\n\n")}\n[End current turn runtime guidance]` : "" });
}
