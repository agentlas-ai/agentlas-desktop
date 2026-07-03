// 설정 — BYOC 연결 관리. PRD 3.1 FRE 6단계 + 10번 리스크 "키 저장 위치 명시".
"use client";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT, type LocalePref } from "@/lib/i18n";
import { useTheme, type ThemePref } from "@/lib/theme";
import type {
  MultimodalModality,
  AgentConcurrencyInfo,
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
  RuntimeBackend,
  RuntimeStatus,
  UpdaterState,
  LaunchdStatus,
} from "@/lib/types";
import {
  type ByokBackend,
  BYOK_MODELS,
  findByokModel,
  needsLongContextToggle,
} from "@shared/models";
import { AUTO_PROVIDER } from "@shared/multimodal";
import { navigate } from "@/lib/navigation";
import { IconCheck, IconFilm, IconImage, IconKey, IconLock, IconRefresh, IconWand } from "@/components/Icon";
import { MigrationPanel } from "@/components/MigrationPanel";

// BYOK 백엔드 목록은 shared/models.ts의 ByokBackend(단일 출처)를 그대로 쓴다.
const BYOK_BACKENDS: ByokBackend[] = [
  "anthropic",
  "openai",
  "google",
  "upstage",
  // Anthropic 호환 서드파티(구독/종량제) — base URL은 프리셋 자동, 사용자는 키만 입력.
  "glm",
  "kimi",
  "deepseek",
  "custom",
];

const BACKEND_LABEL_KO: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (로컬)",
  upstage: "Upstage Solar (🇰🇷 한국 소버린)",
  custom: "Custom OpenAI (호환 모델)",
  glm: "GLM (Z.ai)",
  kimi: "Kimi (Moonshot)",
  deepseek: "DeepSeek",
};

const BACKEND_LABEL_EN: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (local)",
  upstage: "Upstage Solar (🇰🇷 Korean sovereign)",
  custom: "Custom OpenAI (compatible model)",
  glm: "GLM (Z.ai)",
  kimi: "Kimi (Moonshot)",
  deepseek: "DeepSeek",
};

function backendLabel(b: RuntimeBackend, locale: string): string {
  return (locale === "ko" ? BACKEND_LABEL_KO : BACKEND_LABEL_EN)[b];
}

const BACKEND_KEY_HINT_KO: Record<ByokBackend, string> = {
  anthropic: "console.anthropic.com/settings/keys",
  openai: "platform.openai.com/api-keys",
  google: "aistudio.google.com/app/apikey",
  upstage: "console.upstage.ai/api-keys",
  custom: "Your Base URL's Provider",
  glm: "z.ai/subscribe · 구독 코딩 플랜",
  kimi: "platform.moonshot.ai · 구독 코딩 플랜",
  deepseek: "platform.deepseek.com/api_keys · 종량제",
};

const BACKEND_KEY_HINT_EN: Record<ByokBackend, string> = {
  anthropic: "console.anthropic.com/settings/keys",
  openai: "platform.openai.com/api-keys",
  google: "aistudio.google.com/app/apikey",
  upstage: "console.upstage.ai/api-keys",
  custom: "Your Base URL's Provider",
  glm: "z.ai/subscribe · subscription coding plan",
  kimi: "platform.moonshot.ai · subscription coding plan",
  deepseek: "platform.deepseek.com/api_keys · pay-as-you-go",
};

function backendKeyHint(b: ByokBackend, locale: string): string {
  return (locale === "ko" ? BACKEND_KEY_HINT_KO : BACKEND_KEY_HINT_EN)[b];
}


export default function SettingsPage() {
  const { t, pref, setPref, locale } = useT();
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([]);
  const [draftKey, setDraftKey] = useState<Record<ByokBackend, string>>({
    anthropic: "",
    openai: "",
    google: "",
    upstage: "",
    custom: "",
    glm: "",
    kimi: "",
    deepseek: "",
  });
  const [hasKey, setHasKey] = useState<Record<ByokBackend, boolean>>({
    anthropic: false,
    openai: false,
    google: false,
    upstage: false,
    custom: false,
    glm: false,
    kimi: false,
    deepseek: false,
  });
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [draftCustomBaseUrl, setDraftCustomBaseUrl] = useState("");
  const [multimodalProviders, setMultimodalProviders] = useState<MultimodalProvider[]>([]);
  const [multimodalSettings, setMultimodalSettings] = useState<MultimodalSettings | null>(null);
  const [multimodalStatus, setMultimodalStatus] = useState<MultimodalProviderStatus[]>([]);
  const [multimodalDraft, setMultimodalDraft] = useState<Record<string, string>>({});
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [concurrency, setConcurrency] = useState<AgentConcurrencyInfo | null>(null);
  const [interviewMode, setInterviewMode] = useState<"smart" | "build-only" | "off">("build-only");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [s, a, o, g, u, c, glmK, kimiK, dsK, baseUrl, providers, mmSettings, mmStatus] =
      await Promise.all([
        api.runtime.detect(),
        api.secrets.hasApiKey("anthropic"),
        api.secrets.hasApiKey("openai"),
        api.secrets.hasApiKey("google"),
        api.secrets.hasApiKey("upstage"),
        api.secrets.hasApiKey("custom"),
        api.secrets.hasApiKey("glm"),
        api.secrets.hasApiKey("kimi"),
        api.secrets.hasApiKey("deepseek"),
        api.config.getCustomBaseUrl(),
        api.multimodal.listProviders(),
        api.multimodal.getSettings(),
        api.multimodal.status(),
      ]);
    api.system?.concurrencyInfo().then(setConcurrency).catch(() => {});
    api.interview?.getMode().then(setInterviewMode).catch(() => {});
    setStatuses(s);
    setHasKey({
      anthropic: a,
      openai: o,
      google: g,
      upstage: u,
      custom: c,
      glm: glmK,
      kimi: kimiK,
      deepseek: dsK,
    });
    setCustomBaseUrl(baseUrl);
    setDraftCustomBaseUrl(baseUrl);
    setMultimodalProviders(providers);
    setMultimodalSettings(mmSettings);
    setMultimodalStatus(mmStatus);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ollama 모델 선택 — 같은 ollama 런타임을 model만 바꿔 활성화.
  async function activateOllamaModel(model: string) {
    const api = ipc();
    if (!api) return;
    try {
      const updated = await api.runtime.setActive({
        kind: "ollama",
        backend: "ollama",
        source: "ollama",
        model,
      });
      setStatuses(updated);
      setRuntimeMessage("");
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `Ollama 모델을 바꾸지 못했습니다. ${String(err)}` : `Ollama model did not change. ${String(err)}`);
    }
  }

  // BYOK 모델/1M 선택 — 해당 백엔드를 model·longContext와 함께 활성화.
  async function activateByok(backend: ByokBackend, model: string, longContext: boolean) {
    const api = ipc();
    if (!api) return;
    try {
      const updated = await api.runtime.setActive({
        kind: "byok",
        backend,
        source: `byok:${backend}`,
        model,
        longContext,
      });
      setStatuses(updated);
      setRuntimeMessage("");
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `BYOK 런타임을 바꾸지 못했습니다. ${String(err)}` : `BYOK runtime did not change. ${String(err)}`);
    }
  }

  async function saveKey(backend: ByokBackend) {
    const api = ipc();
    if (!api) return;
    try {
      await api.secrets.saveApiKey(backend, draftKey[backend]);
      if (backend === "custom") {
        await api.config.setCustomBaseUrl(draftCustomBaseUrl);
      }
      setDraftKey((d) => ({ ...d, [backend]: "" }));
      setRuntimeMessage(locale === "ko" ? "키를 저장했습니다. 값은 화면에 다시 표시하지 않습니다." : "Key saved. The value will not be shown again.");
      await refresh();
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `키를 저장하지 못했습니다. 이전 값은 그대로입니다. ${String(err)}` : `Key was not saved. The previous value was kept. ${String(err)}`);
    }
  }

  async function clearKey(backend: ByokBackend) {
    const api = ipc();
    if (!api) return;
    try {
      await api.secrets.deleteApiKey(backend);
      setRuntimeMessage(locale === "ko" ? "키를 삭제했습니다." : "Key deleted.");
      await refresh();
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `키를 삭제하지 못했습니다. ${String(err)}` : `Key was not deleted. ${String(err)}`);
    }
  }

  async function saveMultimodalProvider(modality: MultimodalModality, providerId: string) {
    const api = ipc();
    if (!api || !multimodalSettings) return;
    const patch =
      modality === "image"
        ? { imageProvider: providerId }
        : modality === "video"
        ? { videoProvider: providerId }
        : { audioProvider: providerId };
    try {
      const next = await api.multimodal.saveSettings({ ...multimodalSettings, ...patch });
      setMultimodalSettings(next);
      setMultimodalStatus(await api.multimodal.status());
      setRuntimeMessage("");
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `프로바이더를 바꾸지 못했습니다. 이전 설정이 유지됩니다. ${String(err)}` : `Provider did not change. The previous setting was kept. ${String(err)}`);
    }
  }

  async function saveMultimodalEnv(key: string) {
    const api = ipc();
    const value = multimodalDraft[key]?.trim();
    if (!api || !value) return;
    try {
      await api.env.set(key, value);
      setMultimodalDraft((draft) => ({ ...draft, [key]: "" }));
      await refresh();
      setRuntimeMessage("");
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `키를 저장하지 못했습니다. 이전 값은 그대로입니다. ${String(err)}` : `Key was not saved. The previous value was kept. ${String(err)}`);
    }
  }

  const ollama = statuses.find((s) => s.kind === "ollama") ?? null;

  return (
    <div style={{ flex: 1, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          minHeight: 56,
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700 }}>
          {t("settings.title")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 760, margin: "0 auto", padding: 32 }}
      >
        <Banner />
        <UpdatePanel />

        {/* 언어 선택 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.lang.title")}
        </h2>
        <div
          style={{
            padding: 6,
            borderRadius: "var(--radius-md)",
            display: "flex",
            gap: 6,
            background: "var(--paper-2)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-inset)",
          }}
        >
          {(["system", "ko", "en"] as LocalePref[]).map((p) => {
            const active = pref === p;
            return (
              <button
                key={p}
                onClick={() => setPref(p)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  background: active ? "var(--paper)" : "transparent",
                  color: active ? "var(--ink)" : "var(--ink-soft)",
                  boxShadow: active ? "var(--neu-raised)" : "none",
                  border: active ? "1px solid var(--paper-edge)" : "1px solid transparent",
                }}
              >
                {p === "system"
                  ? t("settings.lang.system")
                  : p === "ko"
                  ? t("settings.lang.ko")
                  : t("settings.lang.en")}
              </button>
            );
          })}
        </div>

        {/* 화면 테마 (라이트/다크/시스템) */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.appearance.title")}
        </h2>
        <div
          style={{
            padding: 6,
            borderRadius: "var(--radius-md)",
            display: "flex",
            gap: 6,
            background: "var(--paper-2)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-inset)",
          }}
        >
          {(["system", "light", "dark"] as ThemePref[]).map((p) => {
            const active = themePref === p;
            return (
              <button
                key={p}
                onClick={() => setThemePref(p)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  background: active ? "var(--paper)" : "transparent",
                  color: active ? "var(--ink)" : "var(--ink-soft)",
                  boxShadow: active ? "var(--neu-raised)" : "none",
                  border: active ? "1px solid var(--paper-edge)" : "1px solid transparent",
                }}
              >
                {p === "system"
                  ? t("settings.appearance.system")
                  : p === "light"
                  ? t("settings.appearance.light")
                  : t("settings.appearance.dark")}
              </button>
            );
          })}
        </div>

        {/* 에이전트 동시성(스웜 크기) — 게임 그래픽 세팅처럼 내 컴 사양 기반 추천 + 슬라이더 */}
        {concurrency && (
          <>
            <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
              {locale === "ko" ? "에이전트 동시 실행 (스웜 크기)" : "Parallel agents (swarm size)"}
            </h2>
            <div
              style={{
                padding: 14,
                marginBottom: 12,
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
              }}
            >
              <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
                {locale === "ko"
                  ? "여러 에이전트가 한 번에 몇 명까지 동시에 일할지. 에이전트 1명 = 무거운 프로세스라, 높이면 빨라지지만 컴이 느려질 수 있어요."
                  : "How many agents work at once. Each agent is a heavy process — higher is faster but can slow your machine."}
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  type="range"
                  min={1}
                  max={concurrency.hardMax}
                  value={concurrency.current}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setConcurrency({ ...concurrency, current: v, userSet: true });
                  }}
                  onMouseUp={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    void ipc()?.system?.setConcurrency(v).then((info) => info && setConcurrency(info));
                  }}
                  onTouchEnd={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    void ipc()?.system?.setConcurrency(v).then((info) => info && setConcurrency(info));
                  }}
                  style={{ flex: 1, accentColor: "var(--accent)" }}
                />
                <strong style={{ fontSize: 20, minWidth: 32, textAlign: "center" }}>
                  {concurrency.current}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                  {locale === "ko"
                    ? `내 컴: 코어 ${concurrency.cores}개 · 메모리 ${concurrency.totalMemGB}GB`
                    : `Your machine: ${concurrency.cores} cores · ${concurrency.totalMemGB}GB RAM`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void ipc()?.system?.setConcurrency(concurrency.recommended).then((info) => info && setConcurrency(info));
                  }}
                  style={{
                    fontSize: 11,
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--paper-edge)",
                    background: concurrency.current === concurrency.recommended ? "var(--accent)" : "var(--paper-2)",
                    color: concurrency.current === concurrency.recommended ? "#fff" : "var(--ink)",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {locale === "ko" ? `추천: ${concurrency.recommended}` : `Recommended: ${concurrency.recommended}`}
                </button>
              </div>
              {concurrency.current > concurrency.recommended && (
                <p style={{ fontSize: 11, color: "var(--warn-deep, #b8860b)", margin: "8px 0 0" }}>
                  {locale === "ko"
                    ? "⚠️ 추천보다 높아요 — 이 컴에선 느려지거나 버벅일 수 있어요."
                    : "⚠️ Above recommended — this machine may slow down or stutter."}
                </p>
              )}
            </div>
          </>
        )}

        {/* 브리핑 인터뷰 모드 — 모호한 요청 앞에 배치 질문을 강제할지 (smart/build-only/off) */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {locale === "ko" ? "브리핑 인터뷰" : "Briefing interview"}
        </h2>
        <div
          style={{
            padding: 14,
            marginBottom: 12,
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
          }}
        >
          <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
            {locale === "ko"
              ? "요청이 모호하면 실행 전에 3–5개 질문으로 스코프를 먼저 확정합니다. 명확하거나 사소한 요청엔 질문하지 않아요."
              : "When a request is ambiguous, the agent locks scope with 3–5 questions before executing. Clear or trivial requests are never questioned."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {([
              { id: "smart", ko: "스마트 (챗에서도)", en: "Smart (chat too)" },
              { id: "build-only", ko: "빌드에서만 (기본)", en: "Build only (default)" },
              { id: "off", ko: "끔", en: "Off" },
            ] as const).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  void ipc()?.interview?.setMode(opt.id).then((m) => setInterviewMode(m));
                }}
                style={{
                  fontSize: 12,
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid var(--paper-edge)",
                  background: interviewMode === opt.id ? "var(--accent)" : "var(--paper-2)",
                  color: interviewMode === opt.id ? "#fff" : "var(--ink)",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {locale === "ko" ? opt.ko : opt.en}
              </button>
            ))}
          </div>
        </div>

        <LaunchdPanel />

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {locale === "ko" ? "엔진" : "Engines"}
        </h2>
        {runtimeMessage && (
          <div
            style={{
              padding: 12,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--ink-soft)",
              background: "var(--paper)",
              fontSize: 13,
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            {runtimeMessage}
          </div>
        )}
        {/* 감지된 LLM 목록·활성화는 대시보드(엔진 사용량 카드)로 이관 — 엔진 관리 일원화. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
            fontSize: 13,
            color: "var(--ink-soft)",
            marginBottom: 10,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {locale === "ko"
              ? "엔진 연결·사용량·기본 엔진 선택은 대시보드에서 관리합니다."
              : "Engine connections, usage, and the default engine are managed on the dashboard."}
          </span>
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            style={{
              flexShrink: 0,
              border: "1px solid var(--paper-edge)",
              borderRadius: 8,
              background: "var(--paper-2)",
              color: "var(--ink)",
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {locale === "ko" ? "대시보드 열기" : "Open dashboard"}
          </button>
        </div>
        <MultimodalFallbackPanel
          providers={multimodalProviders}
          settings={multimodalSettings}
          status={multimodalStatus}
          drafts={multimodalDraft}
          onDraftChange={(key, value) => setMultimodalDraft((draft) => ({ ...draft, [key]: value }))}
          onSelect={(modality, providerId) => void saveMultimodalProvider(modality, providerId)}
          onSaveEnv={(key) => void saveMultimodalEnv(key)}
        />

        {/* 로컬 모델 (Ollama) */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("settings.ollama.title")}
        </h2>
        <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
          {t("settings.ollama.note")}
        </p>
        {!ollama ? (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            {t("settings.ollama.unreachable")}
          </div>
        ) : (ollama.availableModels ?? []).length === 0 ? (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            {t("settings.ollama.no_models")}
          </div>
        ) : (
          <div
            style={{
              padding: 14,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginBottom: 8 }}>
              {t("settings.ollama.model_label")}
              {ollama.version && ` · Ollama v${ollama.version}`}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(ollama.availableModels ?? []).map((m) => {
                const isCurrent = ollama.active && ollama.model === m;
                return (
                  <button
                    key={m}
                    onClick={() => void activateOllamaModel(m)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      fontWeight: isCurrent ? 700 : 500,
                      background: isCurrent ? "var(--paper)" : "var(--paper-2)",
                      color: isCurrent ? "var(--ink)" : "var(--ink-soft)",
                      border: "1px solid var(--paper-edge)",
                      boxShadow: isCurrent ? "var(--neu-raised)" : "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {m}
                    {isCurrent && (
                      <span style={{ fontSize: 10, fontFamily: "var(--font-head)" }}>
                        · {t("settings.ollama.using")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("settings.byok")}
        </h2>
        <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
          {t("settings.byok.note")}
        </p>
        {BYOK_BACKENDS.map((b) => (
          <div
            key={b}
            style={{
              padding: 14,
              marginBottom: 12,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{backendLabel(b, locale)}</strong>
              {hasKey[b] && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--green-deep)",
                    background: "rgba(168,217,155,0.20)",
                    padding: "2px 8px",
                    borderRadius: 999,
                  }}
                >
                  {t("settings.saved")}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {b === "custom" && (
                <input
                  type="text"
                  value={draftCustomBaseUrl}
                  onChange={(e) => setDraftCustomBaseUrl(e.target.value)}
                  placeholder="Base URL (e.g. https://api.deepseek.com/v1)"
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper-2)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                />
              )}
              <input
                type="password"
                value={draftKey[b]}
                onChange={(e) => setDraftKey((d) => ({ ...d, [b]: e.target.value }))}
                placeholder={`sk-...  (${backendKeyHint(b, locale)})`}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--paper-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              />
              <button
                onClick={() => void saveKey(b)}
                disabled={!draftKey[b].trim()}
                style={{
                  padding: "8px 14px",
                  borderRadius: "var(--radius-md)",
                  background: draftKey[b].trim() ? "var(--paper)" : "var(--paper-2)",
                  color: draftKey[b].trim() ? "var(--ink)" : "var(--muted-deep)",
                  fontWeight: 600,
                  fontSize: 12,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: draftKey[b].trim() ? "var(--neu-raised)" : "none",
                }}
              >
                {t("settings.save")}
              </button>
              {hasKey[b] && (
                <button
                  onClick={() => void clearKey(b)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    color: "var(--red-deep)",
                    fontWeight: 600,
                    fontSize: 12,
                    border: "1px solid var(--paper-edge)",
                  }}
                >
                  {t("settings.delete")}
                </button>
              )}
            </div>
            {hasKey[b] && (
              <ByokModelControls
                backend={b}
                status={statuses.find((s) => s.kind === "byok" && s.backend === b)}
                onActivate={activateByok}
              />
            )}
          </div>
        ))}

        <MemoryDiagnosticsPanel />

        <MigrationPanel />
      </section>
    </div>
  );
}

/** 메모리 & 진단 — 유휴 드리밍 큐레이션 토글(옵트인) + Hephaestus 엔진 진단/슈퍼바이저.
 *  드리밍: 자리를 비운 유휴 시간에만 큐레이터 메모리를 통합(dedup+LLM 요약). 기본 OFF. */
function MemoryDiagnosticsPanel() {
  const { t, locale } = useT();
  const ko = locale !== "en";
  const [dreaming, setDreaming] = useState<{ enabled: boolean; lastRunAt: string | null; running: boolean } | null>(null);
  const [supervisor, setSupervisor] = useState<boolean | null>(null);
  const [doctorOut, setDoctorOut] = useState<string | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.memoryDreaming.status().then(setDreaming).catch(() => {});
    void api.hephaestus.getSupervisor().then((s) => setSupervisor(s.enabled)).catch(() => {});
  }, []);

  const toggleDreaming = async () => {
    const api = ipc();
    if (!api || !dreaming) return;
    const next = await api.memoryDreaming.setEnabled(!dreaming.enabled);
    setDreaming(next);
  };

  const toggleSupervisor = async () => {
    const api = ipc();
    if (!api || supervisor == null) return;
    try {
      await api.hephaestus.setSupervisor(!supervisor);
      setSupervisor(!supervisor);
    } catch {
      // 엔진 미가용 — 상태 유지
    }
  };

  const runDoctor = async () => {
    const api = ipc();
    if (!api) return;
    setDoctorBusy(true);
    setDoctorOut(null);
    try {
      const res = await api.hephaestus.doctor();
      const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
      setDoctorOut(text.length > 4000 ? `${text.slice(0, 4000)}…` : text);
    } catch (e) {
      setDoctorOut(String(e));
    } finally {
      setDoctorBusy(false);
    }
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 14px",
    borderRadius: "var(--radius-md)",
    background: "var(--paper)",
    border: "1px solid var(--paper-edge)",
    marginBottom: 8,
  };
  const btnStyle: CSSProperties = {
    padding: "7px 12px",
    borderRadius: "var(--radius-md)",
    background: "var(--paper)",
    border: "1px solid var(--paper-edge)",
    boxShadow: "var(--neu-raised)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--ink)",
  };

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "28px 0 12px" }}>
        {ko ? "메모리 & 진단" : "Memory & Diagnostics"}
      </h2>

      <div style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {ko ? "유휴 드리밍 메모리 정리" : "Idle dreaming memory curation"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginTop: 2 }}>
            {ko
              ? "자리를 비운 유휴 시간에만 에이전트 메모리를 자동 통합합니다 (10분 유휴 + 실행 없음 + 6시간 쿨다운). 작업 중에는 절대 켜지지 않습니다."
              : "Consolidates agent memory only while you're away (10min idle + no runs + 6h cooldown). Never fires while you work."}
            {dreaming?.lastRunAt
              ? ` · ${ko ? "마지막 실행" : "Last run"}: ${new Date(dreaming.lastRunAt).toLocaleString()}`
              : ""}
          </div>
        </div>
        <button onClick={() => void toggleDreaming()} style={{ ...btnStyle, minWidth: 64 }} disabled={!dreaming}>
          {dreaming ? (dreaming.enabled ? "ON" : "OFF") : "…"}
        </button>
      </div>

      <div style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {ko ? "Hephaestus 슈퍼바이저" : "Hephaestus supervisor"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginTop: 2 }}>
            {ko ? "Stormbreaker 견고-실행 감독 레이어" : "Stormbreaker robust-execution supervision layer"}
          </div>
        </div>
        <button onClick={() => void toggleSupervisor()} style={{ ...btnStyle, minWidth: 64 }} disabled={supervisor == null}>
          {supervisor == null ? "…" : supervisor ? "ON" : "OFF"}
        </button>
      </div>

      <div style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {ko ? "Hephaestus 엔진 진단" : "Hephaestus engine doctor"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginTop: 2 }}>
              {ko ? "번들 엔진/Python/라우팅 자가진단을 실행합니다" : "Runs the bundled engine self-diagnostics"}
            </div>
          </div>
          <button onClick={() => void runDoctor()} style={btnStyle} disabled={doctorBusy}>
            {doctorBusy ? (ko ? "진단 중…" : "Running…") : ko ? "진단 실행" : "Run doctor"}
          </button>
        </div>
        {doctorOut && (
          <pre
            style={{
              margin: "10px 0 0",
              padding: 10,
              borderRadius: "var(--radius-md)",
              background: "var(--paper-2)",
              border: "1px solid var(--paper-edge)",
              fontSize: 11,
              maxHeight: 260,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {doctorOut}
          </pre>
        )}
      </div>
    </>
  );
}

function MultimodalFallbackPanel({
  providers,
  settings,
  status,
  drafts,
  onDraftChange,
  onSelect,
  onSaveEnv,
}: {
  providers: MultimodalProvider[];
  settings: MultimodalSettings | null;
  status: MultimodalProviderStatus[];
  drafts: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  onSelect: (modality: MultimodalModality, providerId: string) => void;
  onSaveEnv: (key: string) => void;
}) {
  const { t, locale } = useT();
  const selected = {
    image: settings?.imageProvider ?? "",
    video: settings?.videoProvider ?? "",
    audio: settings?.audioProvider ?? "",
  };
  const statusByProvider = new Map(status.map((item) => [item.provider.id, item]));
  const modalities: Array<{ id: MultimodalModality; icon: JSX.Element; label: string }> = [
    { id: "image", icon: <IconImage size={15} />, label: t("settings.multimodal.image") },
    { id: "video", icon: <IconFilm size={15} />, label: t("settings.multimodal.video") },
    { id: "audio", icon: <IconWand size={15} />, label: t("settings.multimodal.audio") },
  ];

  return (
    <>
      <h2 id="multimodal" style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px", scrollMarginTop: 24 }}>
        {t("settings.multimodal.title")}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px", lineHeight: 1.55 }}>
        {t("settings.multimodal.note")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {modalities.map((modality) => {
          const items = providers.filter((provider) => provider.modality === modality.id);
          // 값이 없거나 알 수 없으면 auto로 취급(기본값이 auto).
          const isAuto =
            selected[modality.id] === AUTO_PROVIDER ||
            !items.some((p) => p.id === selected[modality.id]);
          const autoStatus = status.find((s) => s.modality === modality.id && s.auto);
          const autoResolvedName = autoStatus
            ? locale === "en"
              ? autoStatus.provider.label
              : autoStatus.provider.labelKo
            : null;
          return (
            <div key={modality.id} style={multimodalGroupStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ color: "var(--accent)", display: "inline-flex" }}>{modality.icon}</span>
                <strong style={{ fontSize: 13 }}>{modality.label}</strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button
                  key="auto"
                  onClick={() => onSelect(modality.id, AUTO_PROVIDER)}
                  style={{
                    ...multimodalProviderStyle,
                    borderColor: isAuto ? "var(--accent)" : "var(--paper-edge)",
                    boxShadow: isAuto ? "var(--neu-raised)" : "none",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 220px" }}>
                    {isAuto && <IconCheck size={14} style={{ color: "var(--green-deep)", flexShrink: 0 }} />}
                    <span style={{ fontWeight: 700, color: "var(--ink)", lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {locale === "en" ? "Auto (recommended)" : "자동 선택 (권장)"}
                    </span>
                  </span>
                  <span style={{ color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.35, minWidth: 0, flex: "2 1 280px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {locale === "en"
                      ? "Pick a connected engine automatically — keyless (Codex / Nano Banana) first, then API."
                      : "연결된 엔진을 자동으로 사용 — 키 없는 것(Codex / 나노바나나) 우선, 그다음 API."}
                  </span>
                  {isAuto && autoResolvedName && (
                    <span
                      style={{
                        ...multimodalEnvRowStyle,
                        justifyContent: "flex-start",
                        flex: "0 1 auto",
                        minWidth: 0,
                        overflow: "hidden",
                        color: autoStatus?.ready ? "var(--green-deep)" : "var(--peach-ink)",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {autoStatus?.ready
                        ? `→ ${autoResolvedName}`
                        : locale === "en"
                          ? "no engine connected"
                          : "연결된 엔진 없음"}
                    </span>
                  )}
                </button>
                {items.map((provider) => {
                  const active = selected[modality.id] === provider.id;
                  const providerStatus = statusByProvider.get(provider.id);
                  const providerName = locale === "en" ? provider.label : provider.labelKo;
                  return (
                    <button
                      key={provider.id}
                      onClick={() => onSelect(modality.id, provider.id)}
                      style={{
                        ...multimodalProviderStyle,
                        borderColor: active ? "var(--accent)" : "var(--paper-edge)",
                        boxShadow: active ? "var(--neu-raised)" : "none",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 220px" }}>
                        {active && <IconCheck size={14} style={{ color: "var(--green-deep)", flexShrink: 0 }} />}
                        <span style={{ fontWeight: 700, color: "var(--ink)", lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{providerName}</span>
                      </span>
                      <span style={{ color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.35, minWidth: 0, flex: "2 1 280px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {locale === "en" ? provider.summary : provider.summaryKo}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-mono)", flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {provider.defaultModel ?? provider.mode}
                      </span>
                      {active && providerStatus && providerStatus.env.length > 0 && (
                        <span
                          style={{
                            ...multimodalEnvRowStyle,
                            justifyContent: "flex-start",
                            flex: "0 1 auto",
                            minWidth: 0,
                            overflow: "hidden",
                            color: providerStatus.env.every((e) => e.hasValue) ? "var(--green-deep)" : "var(--peach-ink)",
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <IconKey size={11} />
                          {providerStatus.env.every((e) => e.hasValue)
                            ? t("settings.multimodal.key_saved")
                            : t("settings.multimodal.key_missing")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {items
                .filter((provider) => selected[modality.id] === provider.id)
                .flatMap((provider) => provider.envKeys)
                .map((key) => (
                  <div key={key} style={multimodalSecretRowStyle}>
                    <input
                      type="password"
                      value={drafts[key] ?? ""}
                      onChange={(event) => onDraftChange(key, event.target.value)}
                      placeholder={t("settings.multimodal.key_placeholder", { key })}
                      style={multimodalSecretInputStyle}
                    />
                    <button
                      onClick={() => onSaveEnv(key)}
                      disabled={!(drafts[key] ?? "").trim()}
                      style={{
                        ...multimodalSecretButtonStyle,
                        opacity: (drafts[key] ?? "").trim() ? 1 : 0.45,
                      }}
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function UpdatePanel() {
  const { t } = useT();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<UpdaterState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (api) {
      void api.app.getVersion().then((v) => {
        if (!cancelled) setVersion(v);
      });
      void api.updater.getState().then((s) => {
        if (!cancelled) setState(s);
      });
    }
    const off = updaterEvents()?.onState((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  async function check() {
    const api = ipc();
    if (!api || checking) return;
    setChecking(true);
    try {
      await api.updater.check();
    } finally {
      setTimeout(() => setChecking(false), 900);
    }
  }

  async function install() {
    const api = ipc();
    if (!api) return;
    await api.updater.install();
  }

  const statusText = (() => {
    switch (state.status) {
      case "checking":
        return t("settings.update.checking");
      case "available":
        return t("settings.update.available", { version: state.version ?? "?" });
      case "downloading":
        return t("settings.update.downloading", {
          version: state.version ?? "?",
          pct: state.progress ?? 0,
        });
      case "downloaded":
        return t("settings.update.downloaded", { version: state.version ?? "?" });
      case "not-available":
        return t("settings.update.not_available");
      case "error":
        return t("settings.update.error", { message: state.error ?? "Unknown error" });
      default:
        return t("settings.update.idle");
    }
  })();

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
        {t("settings.update.title")}
      </h2>
      <div
        className="glass-strong"
        style={{
          padding: 14,
          borderRadius: "var(--radius-md)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--muted-deep)", marginBottom: 4 }}>
            {t("settings.update.current")}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>
            v{version || "?"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)", marginTop: 6 }}>
            {statusText}
          </div>
        </div>
        {state.status === "downloaded" ? (
          <button
            onClick={() => void install()}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontWeight: 700,
              fontSize: 12,
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
            }}
          >
            {t("settings.update.install")}
          </button>
        ) : (
          <button
            onClick={() => void check()}
            disabled={checking}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: checking ? "var(--paper-2)" : "var(--paper)",
              color: checking ? "var(--muted-deep)" : "var(--ink)",
              fontWeight: 700,
              fontSize: 12,
              border: "1px solid var(--paper-edge)",
              boxShadow: checking ? "none" : "var(--neu-raised)",
            }}
          >
            {checking ? t("settings.update.checking") : t("settings.update.check")}
          </button>
        )}
      </div>
    </>
  );
}

// ── Agentlas 터미널 CLI 설치 ──────────────────────────────
function AgentlasCliPanel() {
  const { t, locale } = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const usage =
    locale === "ko"
      ? [
          ["agentlas", "설치된 에이전트 목록 보기"],
          ["agentlas <이름>", "claude처럼 바로 대화형 세션 시작"],
          ['agentlas run <이름> "질문"', "1회 실행 (스크립트·파이프용)"],
          ["agentlas firm <회사>", "회사(CEO)에게 위임 실행"],
          ["agentlas ontology", "현재 프로젝트 온톨로지 inbox/source 확인"],
          ["agentlas doctor", "런타임·데이터 점검"],
        ]
      : [
          ["agentlas", "list installed agents"],
          ["agentlas <name>", "start an interactive session (like claude)"],
          ['agentlas run <name> "prompt"', "one-shot run (scripts / pipes)"],
          ["agentlas firm <firm>", "delegate to a firm's CEO"],
          ["agentlas ontology", "project ontology inbox/source status"],
          ["agentlas doctor", "check runtime & data"],
        ];

  async function install() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.runtime.installAgentlasCli();
      setMsg(r.message);
    } catch (err) {
      setMsg((t("settings.cli.install_failed", { cmd: "" }) || "Install failed.") + ` ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
        {t("settings.agentlascli.title")}
      </h2>
      <div
        style={{
          padding: 14,
          border: "1px solid var(--paper-edge)",
          borderRadius: "var(--radius-md)",
          background: "var(--paper)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              <code style={{ fontFamily: "var(--font-mono)" }}>agentlas</code> CLI
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
              {t("settings.agentlascli.desc")}
            </div>
          </div>
          <button
            onClick={() => void install()}
            disabled={busy}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              background: busy ? "var(--paper-2)" : "var(--paper)",
              color: busy ? "var(--muted-deep)" : "var(--ink)",
              border: "1px solid var(--paper-edge)",
              boxShadow: busy ? "none" : "var(--neu-raised)",
              flexShrink: 0,
            }}
          >
            {busy ? t("settings.cli.installing") : t("settings.agentlascli.install")}
          </button>
        </div>
        {msg && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ink-soft)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              background: "var(--paper-2)",
              padding: "8px 10px",
              borderRadius: 8,
            }}
          >
            {msg}
          </div>
        )}

        {/* 사용법 — "터미널 어케 키는지" 안내: 설치 후 터미널에서 바로 입력 */}
        <div
          style={{
            marginTop: 4,
            borderTop: "1px solid var(--paper-edge)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
            {locale === "ko"
              ? "설치한 뒤 터미널(Terminal.app · iTerm 등)을 열고 아래 명령을 입력하세요. 설치가 곧 PATH 등록입니다."
              : "After installing, open a terminal (Terminal.app, iTerm, …) and type a command below. Installing also registers it on your PATH."}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {usage.map(([cmd, desc]) => (
              <div key={cmd} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--ink)",
                    background: "var(--paper-2)",
                    padding: "2px 7px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {cmd}
                </code>
                <span style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                  {desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ── BYOK 모델 선택 + 1M 컨텍스트 토글 ─────────────────────
// 모델 칩을 누르면 해당 백엔드가 그 모델로 활성화된다. 긴 컨텍스트는:
//  - beta-header 모델(Anthropic): 사용자 토글(opt-in) — 켜면 1M 베타 헤더 전송
//  - auto 모델(GPT-4.1 · Gemini): 모델 내장 → "1M 내장" 배지만 표시
function ByokModelControls({
  backend,
  status,
  onActivate,
}: {
  backend: ByokBackend;
  status?: RuntimeStatus;
  onActivate: (backend: ByokBackend, model: string, longContext: boolean) => void | Promise<void>;
}) {
  const { t } = useT();
  const models = BYOK_MODELS[backend];
  const currentModel = status?.model ?? models[0]?.id;
  const longOn = status?.longContextEnabled ?? false;
  const showToggle = needsLongContextToggle(backend, currentModel);
  const autoLong = !!findByokModel(backend, currentModel)?.longContext && !showToggle;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
      <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{t("settings.byok.model_label")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {models.map((m) => {
          const isCurrent = currentModel === m.id;
          return (
            <button
              key={m.id}
              // 다른 모델로 바꾸면 1M 토글은 초기화(off), 같은 모델 재클릭이면 현재 상태 유지.
              onClick={() => void onActivate(backend, m.id, isCurrent ? longOn : false)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                fontWeight: isCurrent ? 700 : 500,
                background: isCurrent ? "var(--paper)" : "var(--paper-2)",
                color: isCurrent ? "var(--ink)" : "var(--ink-soft)",
                border: "1px solid var(--paper-edge)",
                boxShadow: isCurrent ? "var(--neu-raised)" : "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {m.label}
              {m.longContext && (
                <span
                  style={{
                    fontSize: 9.5,
                    fontFamily: "var(--font-head)",
                    padding: "1px 5px",
                    borderRadius: 999,
                    background: isCurrent ? "rgba(255,255,255,0.22)" : "var(--fill-1)",
                    color: isCurrent ? "var(--paper)" : "var(--accent)",
                  }}
                >
                  1M
                </span>
              )}
            </button>
          );
        })}
      </div>
      {showToggle && currentModel && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={longOn}
            onChange={(e) => void onActivate(backend, currentModel, e.target.checked)}
          />
          <span style={{ fontWeight: 600 }}>{t("settings.byok.context1m")}</span>
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {t("settings.byok.context1m_hint")}
          </span>
        </label>
      )}
      {autoLong && (
        <div style={{ fontSize: 11, color: "var(--green-deep)", fontWeight: 600 }}>
          ✓ {t("settings.byok.context1m_auto")}
        </div>
      )}
    </div>
  );
}

// ── launchd "앱 꺼져도 실행"(opt-in, macOS) ────────────────
function LaunchdPanel() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<LaunchdStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.launchd?.status().then(setStatus).catch(() => {});
  }, []);

  async function toggle(on: boolean) {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const next = on ? await api.launchd.enable() : await api.launchd.disable();
      setStatus(next);
      if (next.error) setMsg(next.error);
    } catch (err) {
      setMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  // 미지원(비-macOS 또는 비패키지 빌드)이면 패널 자체를 숨긴다.
  if (status && !status.supported) return null;

  const on = !!status?.loaded;
  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
        {t("settings.launchd.title")}
      </h2>
      <div
        style={{
          padding: 14,
          border: "1px solid var(--paper-edge)",
          borderRadius: "var(--radius-md)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.55 }}>{t("settings.launchd.note")}</div>
          {msg && <div style={{ fontSize: 11.5, color: "var(--red-deep, #b4533a)", marginTop: 6 }}>{msg}</div>}
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: on ? "var(--green-deep)" : "var(--muted-deep)" }}>
          {on ? t("settings.launchd.on") : t("settings.launchd.off")}
        </span>
        <button
          onClick={() => void toggle(!on)}
          disabled={busy || !status}
          style={{
            padding: "8px 14px",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
            fontWeight: 700,
            border: "1px solid var(--paper-edge)",
            background: busy ? "var(--paper-2)" : "var(--paper)",
            color: on ? "var(--red-deep, #b4533a)" : "var(--ink)",
            boxShadow: busy ? "none" : "var(--neu-raised)",
            cursor: busy ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {busy
            ? locale === "ko" ? "처리 중…" : "Working…"
            : on
              ? t("settings.launchd.disable")
              : t("settings.launchd.enable")}
        </button>
      </div>
    </>
  );
}

function Banner() {
  const { t } = useT();
  return (
    <div
      className="glass-strong"
      style={{
        padding: "14px 16px",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 8,
          background: "var(--fill-1)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconLock size={14} />
      </span>
      <div>{t("settings.banner")}</div>
    </div>
  );
}

// ── CLI 설치 패널 (요청 ⑤) ────────────────────────────────
type CliKind = "claude-code" | "codex" | "gemini";
const CLI_DEFS: Array<{ kind: CliKind; name: string; sub: string }> = [
  { kind: "claude-code", name: "Claude Code", sub: "Claude Pro · Max" },
  { kind: "codex", name: "Codex", sub: "ChatGPT Plus · Pro" },
  { kind: "gemini", name: "Gemini", sub: "Google AI" },
];

function CliInstallPanel({
  statuses,
  onChanged,
}: {
  statuses: RuntimeStatus[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [installing, setInstalling] = useState<CliKind | null>(null);
  const [msg, setMsg] = useState<Partial<Record<CliKind, string>>>({});
  const installedKinds = new Set(statuses.map((s) => s.kind));

  async function doInstall(kind: CliKind) {
    const api = ipc();
    if (!api) return;
    setInstalling(kind);
    setMsg((m) => ({ ...m, [kind]: "" }));
    try {
      const r = await api.runtime.installCli(kind);
      if (r.ok) {
        setMsg((m) => ({ ...m, [kind]: t("settings.cli.install_ok") }));
        await onChanged();
      } else {
        setMsg((m) => ({ ...m, [kind]: t("settings.cli.install_failed", { cmd: r.command ?? "" }) }));
      }
    } catch (err) {
      setMsg((m) => ({ ...m, [kind]: `${t("settings.cli.install_failed", { cmd: "" })} ${String(err)}` }));
    } finally {
      setInstalling(null);
    }
  }

  async function doLogin(kind: CliKind) {
    const api = ipc();
    if (!api) return;
    try {
      await api.runtime.openCliLogin(kind);
      setMsg((m) => ({ ...m, [kind]: t("settings.cli.login_hint") }));
    } catch (err) {
      setMsg((m) => ({ ...m, [kind]: `${t("settings.cli.login_hint")} ${String(err)}` }));
    }
  }

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
        {t("settings.cli.title")}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px", lineHeight: 1.6 }}>
        {t("settings.cli.note")}
      </p>
      {CLI_DEFS.map((def) => {
        const installed = installedKinds.has(def.kind);
        const isInstalling = installing === def.kind;
        return (
          <div
            key={def.kind}
            style={{
              padding: 14,
              marginBottom: 10,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{def.name}</div>
                <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{def.sub}</div>
              </div>
              {installed ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--green-deep)",
                      background: "rgba(168,217,155,0.20)",
                      padding: "3px 10px",
                      borderRadius: 999,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <IconCheck size={12} />
                    {t("settings.cli.installed")}
                  </span>
                  {/* 설치돼 있어도 아직 로그인 안 했을 수 있으므로 웹 로그인 버튼 유지 */}
                  <button
                    onClick={() => void doLogin(def.kind)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: "transparent",
                      color: "var(--accent)",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    {t("settings.cli.login")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void doInstall(def.kind)}
                    disabled={isInstalling}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: isInstalling ? "var(--paper-2)" : "var(--paper)",
                      color: isInstalling ? "var(--muted-deep)" : "var(--ink)",
                      border: "1px solid var(--paper-edge)",
                      boxShadow: isInstalling ? "none" : "var(--neu-raised)",
                    }}
                  >
                    {isInstalling ? t("settings.cli.installing") : t("settings.cli.install")}
                  </button>
                  <button
                    onClick={() => void doLogin(def.kind)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: "transparent",
                      color: "var(--accent)",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    {t("settings.cli.login")}
                  </button>
                  <button
                    onClick={() => void onChanged()}
                    title={t("settings.cli.redetect")}
                    aria-label={t("settings.cli.redetect")}
                    style={{
                      padding: 6,
                      borderRadius: 999,
                      color: "var(--muted-deep)",
                      background: "transparent",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    <IconRefresh size={13} />
                  </button>
                </>
              )}
            </div>
            {msg[def.kind] && (
              <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                {msg[def.kind]}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

const multimodalGroupStyle: CSSProperties = {
  padding: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
};

const multimodalProviderStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-sm)",
  background: "var(--paper-2)",
  display: "flex",
  alignItems: "center",
  flexWrap: "nowrap",
  gap: 8,
  minHeight: 38,
  overflow: "hidden",
  width: "100%",
};

const multimodalEnvRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  padding: "5px 7px",
  borderRadius: "var(--radius-sm)",
  background: "var(--paper)",
  fontSize: 10.5,
};

const multimodalSecretRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 10,
};

const multimodalSecretInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const multimodalSecretButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontWeight: 700,
  fontSize: 12,
  border: "1px solid var(--paper-edge)",
  boxShadow: "var(--neu-raised)",
};
