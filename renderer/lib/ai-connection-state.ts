/*
 * First-run AI cards (GPT / Claude / Gemini) — honest per-provider state.
 *
 * Three facts are kept apart, because each needs different evidence:
 *   installed  — runtime.detect() found the CLI binary.
 *   signedIn   — a provider usage call succeeded with the CLI's own login
 *                (usage status "ok"/"no_quota" from the real endpoint), or the
 *                runtime is known to need sign-in (signInRequired / auth errors).
 *   usage      — a real `usedPercent` from the provider, with its window name.
 * A binary on disk alone is never "signed in". A local token estimate is never a
 * remaining percentage. No number is ever invented.
 */
import type { ProviderUsage, RuntimeStatus, UsageSnapshot, UsageWindow } from "./types";

export type AiCardId = "gpt" | "claude" | "gemini";

export interface AiCardSpec {
  id: AiCardId;
  /** Runtime kind in detect()/install/login IPC. */
  runtime: "codex" | "claude-code" | "antigravity";
  /** Usage provider id; null = no usage adapter exists for this runtime. */
  usageProvider: "codex" | "claude-code" | null;
  /** Agentlas can install this CLI itself (fixed official package allowlist). */
  installable: boolean;
  logo: string;
}

export const AI_CARDS: readonly AiCardSpec[] = [
  { id: "gpt", runtime: "codex", usageProvider: "codex", installable: true, logo: "/brand/llm/openai.svg" },
  { id: "claude", runtime: "claude-code", usageProvider: "claude-code", installable: true, logo: "/brand/llm/claude.svg" },
  // Google's path in this app is Antigravity (`agy`). There is no official
  // package Agentlas may install for it and no usage endpoint, so the card says
  // so instead of promising an automatic install or a percentage.
  { id: "gemini", runtime: "antigravity", usageProvider: null, installable: false, logo: "/brand/llm/googlegemini.svg" },
];

export type AiLoginState = "not-installed" | "installed-unverified" | "sign-in-required" | "signed-in";

export interface AiUsageFact {
  /** 100 − usedPercent of the chosen window, rounded down, 0–100. */
  remainingPercent: number;
  windowKind: UsageWindow["kind"];
  windowDurationMins: number | null;
}

export interface AiCardState {
  id: AiCardId;
  login: AiLoginState;
  /** Null = usage unknown (no adapter, no data, or only a local estimate). */
  usage: AiUsageFact | null;
}

const AUTH_ERRORS = new Set(["auth_expired", "credentials_corrupt"]);

/**
 * Show the binding limit: the general window with the least left. A roomy 5-hour
 * window next to an almost-spent weekly one must not read as "plenty left"
 * (real run 2026-09-25: Claude 5h 69% left vs weekly 22% left).
 */
function pickWindow(windows: UsageWindow[]): UsageWindow | null {
  const general = windows.filter((w) => !w.model && Number.isFinite(w.usedPercent) && w.kind !== "unknown");
  let best: UsageWindow | null = null;
  for (const w of general) if (!best || w.usedPercent > best.usedPercent) best = w;
  return best;
}

export function aiCardState(spec: AiCardSpec, runtimes: RuntimeStatus[] | null, usage: UsageSnapshot | null): AiCardState {
  const runtime = runtimes?.find((r) => r.kind === spec.runtime) ?? null;
  if (!runtime) return { id: spec.id, login: "not-installed", usage: null };
  if (runtime.signInRequired) return { id: spec.id, login: "sign-in-required", usage: null };
  const provider: ProviderUsage | null = spec.usageProvider
    ? usage?.providers.find((p) => p.provider === spec.usageProvider) ?? null
    : null;
  if (provider?.status === "error" && provider.error && AUTH_ERRORS.has(provider.error)) {
    return { id: spec.id, login: "sign-in-required", usage: null };
  }
  const realCall = provider && (provider.status === "ok" || provider.status === "no_quota") && provider.error !== "local_estimate";
  if (!realCall) return { id: spec.id, login: "installed-unverified", usage: null };
  const window = provider.status === "ok" ? pickWindow(provider.windows) : null;
  return {
    id: spec.id,
    login: "signed-in",
    usage: window
      ? {
          remainingPercent: Math.max(0, Math.min(100, Math.floor(100 - window.usedPercent))),
          windowKind: window.kind,
          windowDurationMins: window.windowDurationMins ?? null,
        }
      : null,
  };
}

/** Window name for "남은 X% · 5시간" style labels. */
export function usageWindowLabel(fact: AiUsageFact, ko: boolean): string {
  switch (fact.windowKind) {
    case "5h": return ko ? "5시간" : "5-hour";
    case "7d": return ko ? "주간" : "weekly";
    case "daily": return ko ? "일일" : "daily";
    case "monthly": return ko ? "월간" : "monthly";
    default: {
      const mins = fact.windowDurationMins;
      if (mins && mins % 60 === 0) return ko ? `${mins / 60}시간` : `${mins / 60}-hour`;
      return ko ? "현재 기간" : "current period";
    }
  }
}
