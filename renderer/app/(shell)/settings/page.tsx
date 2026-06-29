// 설정 — BYOC 연결 관리. PRD 3.1 FRE 6단계 + 10번 리스크 "키 저장 위치 명시".
"use client";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT, type LocalePref } from "@/lib/i18n";
import { useTheme, type ThemePref } from "@/lib/theme";
import type {
  MultimodalModality,
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
  RuntimeBackend,
  RuntimeStatus,
  UpdaterState,
} from "@/lib/types";
import {
  BYOK_MODELS,
  CONTEXT_MANAGED_BY,
  findByokModel,
  needsLongContextToggle,
} from "@shared/models";
import { IconCheck, IconFilm, IconImage, IconKey, IconLock, IconRefresh, IconWand } from "@/components/Icon";
import { MigrationPanel } from "@/components/MigrationPanel";

// BYOK는 API 키를 직접 넣는 클라우드 3종 (Ollama는 로컬이라 키 없음).
type ByokBackend = "anthropic" | "openai" | "google" | "upstage" | "custom";
const BYOK_BACKENDS: ByokBackend[] = ["anthropic", "openai", "google", "upstage", "custom"];

const BACKEND_LABEL: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (로컬)",
  upstage: "Upstage Solar (🇰🇷 한국 소버린)",
  custom: "Custom OpenAI (호환 모델)",
};

const BACKEND_KEY_HINT: Record<ByokBackend, string> = {
  anthropic: "console.anthropic.com/settings/keys",
  openai: "platform.openai.com/api-keys",
  google: "aistudio.google.com/app/apikey",
  upstage: "console.upstage.ai/api-keys",
  custom: "Your Base URL's Provider",
};

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  ollama: "Ollama",
};

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
  });
  const [hasKey, setHasKey] = useState<Record<ByokBackend, boolean>>({
    anthropic: false,
    openai: false,
    google: false,
    upstage: false,
    custom: false,
  });
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [draftCustomBaseUrl, setDraftCustomBaseUrl] = useState("");
  const [multimodalProviders, setMultimodalProviders] = useState<MultimodalProvider[]>([]);
  const [multimodalSettings, setMultimodalSettings] = useState<MultimodalSettings | null>(null);
  const [multimodalStatus, setMultimodalStatus] = useState<MultimodalProviderStatus[]>([]);
  const [multimodalDraft, setMultimodalDraft] = useState<Record<string, string>>({});
  const [runtimeMessage, setRuntimeMessage] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [s, a, o, g, u, c, baseUrl, providers, mmSettings, mmStatus] = await Promise.all([
      api.runtime.detect(),
      api.secrets.hasApiKey("anthropic"),
      api.secrets.hasApiKey("openai"),
      api.secrets.hasApiKey("google"),
      api.secrets.hasApiKey("upstage"),
      api.secrets.hasApiKey("custom"),
      api.config.getCustomBaseUrl(),
      api.multimodal.listProviders(),
      api.multimodal.getSettings(),
      api.multimodal.status(),
    ]);
    setStatuses(s);
    setHasKey({ anthropic: a, openai: o, google: g, upstage: u, custom: c });
    setCustomBaseUrl(baseUrl);
    setDraftCustomBaseUrl(baseUrl);
    setMultimodalProviders(providers);
    setMultimodalSettings(mmSettings);
    setMultimodalStatus(mmStatus);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function activateRuntime(runtime: RuntimeStatus) {
    const api = ipc();
    if (!api) return;
    try {
      const updated = await api.runtime.setActive({
        kind: runtime.kind,
        backend: runtime.backend,
        source: runtime.source,
        model: runtime.model ?? undefined,
      });
      setStatuses(updated);
      setRuntimeMessage("");
    } catch (err) {
      setRuntimeMessage(locale === "ko" ? `런타임을 바꾸지 못했습니다. 이전 설정이 유지됩니다. ${String(err)}` : `Runtime did not change. The previous setting was kept. ${String(err)}`);
    }
  }

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
    const next = await api.multimodal.saveSettings({ ...multimodalSettings, ...patch });
    setMultimodalSettings(next);
    setMultimodalStatus(await api.multimodal.status());
  }

  async function saveMultimodalEnv(key: string) {
    const api = ipc();
    const value = multimodalDraft[key]?.trim();
    if (!api || !value) return;
    await api.env.set(key, value);
    setMultimodalDraft((draft) => ({ ...draft, [key]: "" }));
    await refresh();
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

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.detected")}
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
        {statuses.length === 0 && (
          <div
            style={{
              padding: 12,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 13,
            }}
          >
            {t("settings.no_backends")}
          </div>
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {statuses.map((s) => (
            <li
              key={`${s.kind}-${s.backend}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: s.active ? "var(--green-deep)" : "var(--paper-edge)",
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {(s.kind === "byok" ? t("settings.runtime.byok") : RUNTIME_LABEL[s.kind] ?? s.kind)} · {BACKEND_LABEL[s.backend]}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                  {s.source}
                  {s.version && ` · v${s.version}`}
                </div>
                {/* 컨텍스트·압축을 누가 관리하는가 — CLI는 자동(런타임), BYOK/Ollama는 Agentlas */}
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                  {CONTEXT_MANAGED_BY[s.kind] === "runtime"
                    ? t("settings.runtime.managed_runtime")
                    : t("settings.runtime.managed_agentlas")}
                </div>
              </div>
              {!s.active && (
                <button
                  onClick={() => void activateRuntime(s)}
                  style={{
                    fontSize: 12,
                    color: "var(--accent)",
                    fontWeight: 600,
                  }}
                >
                  {t("settings.active")}
                </button>
              )}
              {s.active && (
                <span style={{ fontSize: 11, color: "var(--green-deep)", fontWeight: 600 }}>
                  {t("settings.activated")}
                </span>
              )}
            </li>
          ))}
        </ul>        <MultimodalFallbackPanel
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
              <strong style={{ fontSize: 13 }}>{BACKEND_LABEL[b]}</strong>
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
                placeholder={`sk-...  (${BACKEND_KEY_HINT[b]})`}
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

        <MigrationPanel />
      </section>
    </div>
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
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
        {t("settings.multimodal.title")}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px", lineHeight: 1.55 }}>
        {t("settings.multimodal.note")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {modalities.map((modality) => {
          const items = providers.filter((provider) => provider.modality === modality.id);
          return (
            <div key={modality.id} style={multimodalGroupStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ color: "var(--accent)", display: "inline-flex" }}>{modality.icon}</span>
                <strong style={{ fontSize: 13 }}>{modality.label}</strong>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
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
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ fontWeight: 700, color: "var(--ink)", lineHeight: 1.25 }}>{providerName}</span>
                        {active && <IconCheck size={14} style={{ color: "var(--green-deep)", flexShrink: 0 }} />}
                      </span>
                      <span style={{ color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.45 }}>
                        {locale === "en" ? provider.summary : provider.summaryKo}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
                        {provider.defaultModel ?? provider.mode}
                      </span>
                      {active && providerStatus && providerStatus.env.length > 0 && (
                        <span style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                          {providerStatus.env.map((env) => (
                            <span key={env.key} style={multimodalEnvRowStyle}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                                <IconKey size={11} />
                                <code style={{ overflowWrap: "anywhere" }}>{env.key}</code>
                              </span>
                              <span style={{ color: env.hasValue ? "var(--green-deep)" : "var(--peach-ink)", fontWeight: 700 }}>
                                {env.hasValue ? t("settings.multimodal.key_saved") : t("settings.multimodal.key_missing")}
                              </span>
                            </span>
                          ))}
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
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
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
  padding: 14,
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
};

const multimodalProviderStyle: CSSProperties = {
  textAlign: "left",
  padding: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper-2)",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  minHeight: 128,
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
