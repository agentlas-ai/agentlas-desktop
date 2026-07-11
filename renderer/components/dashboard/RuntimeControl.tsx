"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { RuntimeStatus } from "@/lib/types";
import { cliModelTagLabel } from "@shared/models";

type ModelRow = { id: string; label: string; tag?: string };

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  byok: "BYOK API",
  ollama: "Ollama",
};

const BACKEND_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  upstage: "Upstage",
  custom: "Custom",
};

function runtimeLabel(runtime: RuntimeStatus): string {
  if (runtime.kind === "byok") return `${BACKEND_LABEL[runtime.backend] ?? runtime.backend} API`;
  if (runtime.kind === "gemini" && /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(runtime.source ?? "")) {
    return "Antigravity";
  }
  return RUNTIME_LABEL[runtime.kind] ?? runtime.kind;
}

function runtimeSubLabel(runtime: RuntimeStatus, ko: boolean): string {
  const model = runtime.model?.trim();
  const effort = runtime.effort?.trim();
  const version = runtime.version && runtime.version !== "unknown" ? runtime.version : "";
  return [
    version ? `v${version}` : runtime.source,
    model || (runtime.kind === "byok" || runtime.kind === "ollama" ? "" : ko ? "구독 기본" : "subscription default"),
    effort ? `effort ${effort}` : "",
  ].filter(Boolean).join(" · ");
}

export function RuntimeControl() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const activeIndex = Math.max(0, runtimes.findIndex((runtime) => runtime.active));
  const active = runtimes[activeIndex] ?? null;

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const detected = await api.runtime.detect();
      setRuntimes(detected);
      setMessage("");
    } catch {
      setRuntimes([]);
      setMessage(ko ? "런타임을 불러오지 못했습니다." : "Could not load runtimes.");
    } finally {
      setLoading(false);
    }
  }, [ko]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const api = ipc();
    if (!api || !active) {
      setModels([]);
      return;
    }
    let alive = true;
    void api.runtime
      .listModels({
        kind: active.kind,
        backend: active.backend,
        availableModels: active.availableModels,
      })
      .then((rows) => {
        if (alive) setModels(rows);
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [active?.kind, active?.backend, active?.source, active?.availableModels?.join("|")]);

  const runtimeOptions = useMemo(
    () => runtimes.map((runtime, index) => ({ runtime, index, label: runtimeLabel(runtime) })),
    [runtimes],
  );

  async function activateRuntime(indexValue: string) {
    const next = runtimes[Number(indexValue)];
    const api = ipc();
    if (!api || !next || busy) return;
    setBusy(true);
    try {
      const updated = await api.runtime.setActive({
        kind: next.kind,
        backend: next.backend,
        source: next.source,
        model: next.model ?? undefined,
        longContext: next.kind === "byok" ? next.longContextEnabled ?? false : undefined,
        effort: next.kind === "claude-code" ? next.effort ?? undefined : undefined,
      });
      setRuntimes(updated);
      setMessage(ko ? "전역 오케스트레이터 엔진을 바꿨습니다." : "Global orchestrator engine changed.");
    } catch (err) {
      setMessage(ko ? `변경하지 못했습니다. ${String(err)}` : `Could not change it. ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function activateModel(model: string) {
    const api = ipc();
    if (!api || !active || busy) return;
    setBusy(true);
    try {
      const updated = await api.runtime.setActive({
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: model || undefined,
        longContext: active.kind === "byok" ? active.longContextEnabled ?? false : undefined,
      });
      setRuntimes(updated);
      setMessage(ko ? "전역 모델을 바꿨습니다." : "Global model changed.");
    } catch (err) {
      setMessage(ko ? `모델을 바꾸지 못했습니다. ${String(err)}` : `Could not change the model. ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function activateEffort(effort: string) {
    const api = ipc();
    if (!api || !active || busy) return;
    setBusy(true);
    try {
      const updated = await api.runtime.setActive({
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: active.model ?? undefined,
        longContext: active.kind === "byok" ? active.longContextEnabled ?? false : undefined,
        effort,
      });
      setRuntimes(updated);
      setMessage(ko ? "작업 강도를 바꿨습니다." : "Effort changed.");
    } catch (err) {
      setMessage(ko ? `작업 강도를 바꾸지 못했습니다. ${String(err)}` : `Could not change effort. ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard-module dashboard-runtime-control" data-busy={busy ? "true" : "false"}>
      <div className="dashboard-module-head">
        <span>{ko ? "전역 오케스트레이터 모델" : "Global orchestrator model"}</span>
        {active && <span className="dashboard-module-meta">{runtimeSubLabel(active, ko)}</span>}
      </div>
      {loading ? (
        <div className="dashboard-module-empty">{ko ? "런타임 확인 중…" : "Checking runtimes…"}</div>
      ) : !active ? (
        <div className="dashboard-module-empty">{ko ? "연결된 런타임이 없습니다." : "No runtime connected."}</div>
      ) : (
        <>
          <div className="dashboard-runtime-row">
            <label>
              <span>{ko ? "엔진" : "Engine"}</span>
              <select value={String(activeIndex)} onChange={(event) => void activateRuntime(event.target.value)} disabled={busy}>
                {runtimeOptions.map(({ runtime, index, label }) => (
                  <option key={`${runtime.kind}:${runtime.backend}:${runtime.source}`} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{ko ? "모델" : "Model"}</span>
              <select value={active.model ?? ""} onChange={(event) => void activateModel(event.target.value)} disabled={busy || models.length === 0}>
                {active.kind !== "byok" && active.kind !== "ollama" && (
                  <option value="">{ko ? "구독 기본" : "Subscription default"}</option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}{model.tag ? ` · ${cliModelTagLabel(model.tag, locale)}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {(active.efforts?.length ?? 0) > 0 && (
              <label>
                <span>{ko ? "작업량" : "Effort"}</span>
                <select value={active.effort ?? ""} onChange={(event) => void activateEffort(event.target.value)} disabled={busy}>
                  <option value="">{ko ? "기본" : "Default"}</option>
                  {active.efforts?.map((effort) => (
                    <option key={effort.id} value={effort.id}>{effort.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="dashboard-runtime-note">
            {message || (ko ? "채팅, 팀 오케스트레이션, Hub에서 빌려온 에이전트 호출이 이 전역 기본값을 따릅니다." : "Chats, team orchestration, and borrowed Hub agent calls use this global default.")}
          </div>
        </>
      )}
    </div>
  );
}
