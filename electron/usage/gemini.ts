// Gemini CLI 구독 사용량 — Code Assist retrieveUserQuota.
// 자격증명: ~/.gemini/oauth_creds.json 의 access_token (만료 시 refresh는 client secret이 필요해 생략 — 만료면 graceful).
// 흐름: loadCodeAssist(project 확보) → retrieveUserQuota({project}) → buckets[{modelId,remainingFraction,resetTime}].
// (방식 출처: oss agentcat-connectors gemini_live_limits)
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { toResetMs } from "./util";

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";

async function readGeminiToken(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(os.homedir(), ".gemini", "oauth_creds.json"), "utf8");
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const token = creds?.access_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

async function post(method: string, body: unknown, token: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${CODE_ASSIST}:${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Agentlas/1.0",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function prettyModel(model: string): string {
  if (!model) return "Gemini";
  return (
    model
      .replace(/^gemini-?/i, "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || model
  );
}

export async function getGeminiUsage(): Promise<ProviderUsage | null> {
  const token = await readGeminiToken();
  if (!token) return null; // 미연결

  const base = {
    provider: "gemini",
    backend: "google" as const,
    label: "Gemini",
    fetchedAt: Date.now(),
  };
  try {
    const projectEnv =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "";
    const metadata: Record<string, unknown> = {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    };
    if (projectEnv) metadata.duetProject = projectEnv;

    const tier = await post(
      "loadCodeAssist",
      { cloudaicompanionProject: projectEnv || null, metadata },
      token,
    );
    const projectId = String(tier?.cloudaicompanionProject ?? projectEnv ?? "");
    if (!projectId) return { ...base, status: "no_quota", windows: [] };

    const quota = await post("retrieveUserQuota", { project: projectId }, token);
    const buckets = Array.isArray(quota?.buckets) ? quota.buckets : [];
    const windows: UsageWindow[] = [];
    for (const raw of buckets) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      const rf = Number(b.remainingFraction);
      if (!Number.isFinite(rf)) continue;
      const model = String(b.modelId ?? "");
      windows.push({
        id: `gemini:${model || windows.length}`,
        label: prettyModel(model),
        kind: "daily",
        usedPercent: Math.max(0, Math.min(100, 100 - rf * 100)),
        resetAt: toResetMs(b.resetTime),
        model: model || null,
      });
    }
    // pro 모델 우선, 최대 4개
    windows.sort(
      (a, b) =>
        (a.model?.toLowerCase().includes("pro") ? 0 : 1) -
        (b.model?.toLowerCase().includes("pro") ? 0 : 1),
    );
    return { ...base, status: windows.length ? "ok" : "no_quota", windows: windows.slice(0, 4) };
  } catch (err) {
    return {
      ...base,
      status: "error",
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
