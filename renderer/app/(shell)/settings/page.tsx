// 설정 — BYOC 연결 관리. PRD 3.1 FRE 6단계 + 10번 리스크 "키 저장 위치 명시".
"use client";
import { updaterCanUseOfficialInstaller } from "@shared/types";
import { useCallback, useEffect, useState, type CSSProperties , useMemo} from "react";
import { ipc, ipcEvents, updaterEvents } from "@/lib/ipc";
import { useT, type LocalePref } from "@/lib/i18n";
import { DARK_THEME_ENABLED, useTheme, type ThemePref } from "@/lib/theme";
import type {
  MultimodalModality,
  AgentConcurrencyInfo,
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
  RuntimeBackend,
  RuntimeStatus,
  TerminalProfile,
  UpdaterState,
} from "@/lib/types";
import {
  type ByokBackend,
} from "@shared/models";
import { AUTO_PROVIDER } from "@shared/multimodal";
import { navigate } from "@/lib/navigation";
import { IconCheck, IconFilm, IconImage, IconKey, IconLock, IconRefresh, IconWand } from "@/components/Icon";
import { AgentFileEditor, runtimeEditorSource } from "@/components/AgentFileEditor";
import { MigrationPanel } from "@/components/MigrationPanel";
import { MediaDisplaySettings } from "@/components/MediaDisplaySettings";
import QRCode from "qrcode";
import type { HephaestusUpdateJournal, MobileBridgeDeviceSummary, MobileBridgeRuntimeStatus } from "@shared/types";
import type { MobileBridgePairingPayload } from "@shared/mobile-bridge";
import { classifyHephaestusUpdateJournal, hephaestusPendingHostLabels } from "@shared/hephaestus-update-contract";
import { ScienceExtensionPanel } from "@/components/settings/ScienceExtensionPanel";

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
  "minimax",
  "xai",
  "openrouter",
  "custom",
];

const BACKEND_LABEL_KO: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (로컬)",
  lmstudio: "LM Studio (로컬)",
  mlx: "MLX (로컬)",
  upstage: "Upstage Solar (🇰🇷 한국 소버린)",
  custom: "Custom OpenAI (호환 모델)",
  glm: "GLM (Z.ai)",
  kimi: "Kimi (Moonshot)",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xai: "xAI (Grok API)",
  openrouter: "OpenRouter",
  cursor: "Cursor",
  agentlas: "Agentlas (포함된 모델)",
};

const BACKEND_LABEL_EN: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  mlx: "MLX (local)",
  upstage: "Upstage Solar (🇰🇷 Korean sovereign)",
  custom: "Custom OpenAI (compatible model)",
  glm: "GLM (Z.ai)",
  kimi: "Kimi (Moonshot)",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xai: "xAI (Grok API)",
  openrouter: "OpenRouter",
  cursor: "Cursor",
  agentlas: "Agentlas (included models)",
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
  minimax: "platform.minimax.io",
  xai: "console.x.ai",
  openrouter: "openrouter.ai/settings/keys",
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
  minimax: "platform.minimax.io",
  xai: "console.x.ai",
  openrouter: "openrouter.ai/settings/keys",
};

function backendKeyHint(b: ByokBackend, locale: string): string {
  return (locale === "ko" ? BACKEND_KEY_HINT_KO : BACKEND_KEY_HINT_EN)[b];
}


export default function SettingsPage() {
  const { t, pref, setPref, locale } = useT();
  // 소스 객체를 매 렌더마다 새로 만들면 편집기가 목록을 끝없이 다시 불러온다.
  const runtimeSource = useMemo(() => runtimeEditorSource(locale === "ko"), [locale]);
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
    minimax: "",
    xai: "",
    openrouter: "",
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
    minimax: false,
    xai: false,
    openrouter: false,
  });
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [draftCustomBaseUrl, setDraftCustomBaseUrl] = useState("");
  const [multimodalProviders, setMultimodalProviders] = useState<MultimodalProvider[]>([]);
  const [multimodalSettings, setMultimodalSettings] = useState<MultimodalSettings | null>(null);
  const [multimodalStatus, setMultimodalStatus] = useState<MultimodalProviderStatus[]>([]);
  const [multimodalDraft, setMultimodalDraft] = useState<Record<string, string>>({});
  const [multimodalLoadFailed, setMultimodalLoadFailed] = useState(false);
  const [multimodalRefreshing, setMultimodalRefreshing] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [concurrency, setConcurrency] = useState<AgentConcurrencyInfo | null>(null);
  const [concurrencyDraft, setConcurrencyDraft] = useState<number | null>(null);
  const [concurrencyBusy, setConcurrencyBusy] = useState(false);
  const [concurrencyNotice, setConcurrencyNotice] = useState<string | null>(null);
  // 데몬 자동 시작(로그인 기동) — 기본 off. 값과 부팅 항목이 어긋나면 사유를 그대로 보여준다.
  const [daemonAutostart, setDaemonAutostart] = useState(false);
  const [daemonAutostartBusy, setDaemonAutostartBusy] = useState(false);
  const [daemonAutostartNotice, setDaemonAutostartNotice] = useState<string | null>(null);
  useEffect(() => {
    void ipc()?.getDaemonAutostart?.()
      .then((result) => setDaemonAutostart(Boolean(result?.enabled)))
      .catch(() => {});
  }, []);
  const [interviewMode, setInterviewMode] = useState<"smart" | "build-only" | "off">("build-only");
  const [interviewBusy, setInterviewBusy] = useState(false);
  const [interviewNotice, setInterviewNotice] = useState<string | null>(null);

  const refreshMultimodal = useCallback(async () => {
    const api = ipc();
    if (!api) return false;
    setMultimodalRefreshing(true);
    try {
      const [providers, settings, status] = await Promise.allSettled([
        api.multimodal.listProviders(),
        api.multimodal.getSettings(),
        api.multimodal.status(),
      ]);
      if (providers.status === "fulfilled") setMultimodalProviders(providers.value);
      if (settings.status === "fulfilled") setMultimodalSettings(settings.value);
      if (status.status === "fulfilled") setMultimodalStatus(status.value);
      const failed = [providers, settings, status].some((result) => result.status === "rejected");
      setMultimodalLoadFailed(failed);
      return !failed;
    } finally {
      setMultimodalRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    api.system?.concurrencyInfo().then((info) => {
      setConcurrency(info);
      setConcurrencyDraft(info.current);
      setConcurrencyNotice(null);
    }).catch(() => setConcurrencyNotice(locale === "ko"
      ? "저장된 동시 실행 수를 불러오지 못했습니다. 다시 열어 확인해 주세요."
      : "The saved concurrency could not be loaded. Reopen Settings to check it."));
    api.interview?.getMode().then((mode) => {
      setInterviewMode(mode);
      setInterviewNotice(null);
    }).catch(() => setInterviewNotice(locale === "ko"
      ? "저장된 인터뷰 모드를 불러오지 못했습니다."
      : "The saved interview mode could not be loaded."));
    const runtimeRefresh = api.runtime.detect().then((nextStatuses) => {
      setStatuses(nextStatuses);
      // New provider families are discovered from the runtime inventory rather
      // than adding one secret IPC round-trip per provider forever. This keeps
      // Settings startup bounded as the provider catalog grows.
      setHasKey((current) => ({
        ...current,
        minimax: nextStatuses.some((status) => status.kind === "byok" && status.backend === "minimax"),
        xai: nextStatuses.some((status) => status.kind === "byok" && status.backend === "xai"),
        openrouter: nextStatuses.some((status) => status.kind === "byok" && status.backend === "openrouter"),
      }));
    });
    const keyRefresh = Promise.all([
      api.secrets.hasApiKey("anthropic"),
      api.secrets.hasApiKey("openai"),
      api.secrets.hasApiKey("google"),
      api.secrets.hasApiKey("upstage"),
      api.secrets.hasApiKey("custom"),
      api.secrets.hasApiKey("glm"),
      api.secrets.hasApiKey("kimi"),
      api.secrets.hasApiKey("deepseek"),
      api.config.getCustomBaseUrl(),
    ]).then(([a, o, g, u, c, glmK, kimiK, dsK, baseUrl]) => {
      setHasKey((current) => ({
        ...current,
        anthropic: a,
        openai: o,
        google: g,
        upstage: u,
        custom: c,
        glm: glmK,
        kimi: kimiK,
        deepseek: dsK,
      }));
      setCustomBaseUrl(baseUrl);
      setDraftCustomBaseUrl(baseUrl);
    });

    // 런타임·키·멀티모달은 서로 다른 설정 도메인이다. 한 도메인의 IPC 실패가
    // 나머지 화면까지 초기화하지 못하게 만들지 않도록 각각 독립적으로 정착시킨다.
    await Promise.allSettled([runtimeRefresh, keyRefresh, refreshMultimodal()]);
  }, [locale, refreshMultimodal]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveConcurrency(value: number) {
    const api = ipc();
    if (!api?.system || !concurrency || concurrencyBusy) {
      if (!api?.system) setConcurrencyNotice(locale === "ko"
        ? "Desktop에 연결되지 않아 값을 저장하지 못했습니다."
        : "The value was not saved because Desktop is unavailable.");
      return;
    }
    const requested = Math.max(1, Math.min(concurrency.hardMax, Math.floor(value)));
    setConcurrencyBusy(true);
    setConcurrencyNotice(null);
    try {
      const receipt = await api.system.setConcurrency(requested);
      if (!receipt || receipt.current !== requested) throw new Error("concurrency_receipt_mismatch");
      setConcurrency(receipt);
      setConcurrencyDraft(receipt.current);
      setConcurrencyNotice(locale === "ko" ? `동시 실행 수 ${receipt.current}개를 저장했습니다.` : `Saved ${receipt.current} concurrent slots.`);
    } catch {
      setConcurrencyDraft(concurrency.current);
      try {
        const readback = await api.system.concurrencyInfo();
        setConcurrency(readback);
        setConcurrencyDraft(readback.current);
        if (readback.current === requested) {
          setConcurrencyNotice(locale === "ko" ? `동시 실행 수 ${readback.current}개가 저장된 것을 다시 확인했습니다.` : `Verified that ${readback.current} concurrent slots were saved.`);
        } else if (readback.current === concurrency.current) {
          setConcurrencyNotice(locale === "ko" ? "변경이 반영되지 않아 이전 값으로 돌아왔습니다." : "The change was not applied, so the prior value is shown.");
        } else {
          setConcurrencyNotice(locale === "ko" ? `요청값과 다른 실제 값 ${readback.current}개를 다시 읽었습니다.` : `Read back ${readback.current} actual slots, which differs from the request.`);
        }
      } catch {
        setConcurrencyNotice(locale === "ko"
          ? "저장 요청 뒤 실제 값을 확인하지 못했습니다. 화면은 이전 값으로 되돌렸습니다. 반복 저장하지 말고 설정을 다시 열어 확인해 주세요."
          : "The actual value could not be read after the save request. This screen reverted to its prior value. Do not save again; reopen Settings to check it.");
      }
    } finally {
      setConcurrencyBusy(false);
    }
  }

  async function saveInterviewMode(requested: "smart" | "build-only" | "off") {
    const api = ipc();
    if (!api?.interview || interviewBusy || requested === interviewMode) return;
    setInterviewBusy(true);
    setInterviewNotice(null);
    try {
      const receipt = await api.interview.setMode(requested);
      if (receipt !== requested) throw new Error("interview_mode_receipt_mismatch");
      setInterviewMode(receipt);
      setInterviewNotice(locale === "ko" ? "인터뷰 모드를 저장했습니다." : "Interview mode saved.");
    } catch {
      try {
        const readback = await api.interview.getMode();
        setInterviewMode(readback);
        if (readback === requested) {
          setInterviewNotice(locale === "ko" ? "요청한 인터뷰 모드가 저장된 것을 다시 확인했습니다." : "Verified that the requested interview mode was saved.");
        } else if (readback === interviewMode) {
          setInterviewNotice(locale === "ko" ? "변경이 반영되지 않아 이전 모드를 유지합니다." : "The change was not applied, so the prior mode remains active.");
        } else {
          setInterviewNotice(locale === "ko" ? "요청과 다른 저장 모드를 다시 읽어 화면에 반영했습니다." : "A saved mode different from the request was read back and is now shown.");
        }
      } catch {
        setInterviewNotice(locale === "ko"
          ? "저장 요청 뒤 실제 모드를 확인하지 못했습니다. 화면은 이전 모드를 유지합니다. 반복하지 말고 설정을 다시 열어 확인해 주세요."
          : "The actual mode could not be read after the save request. This screen keeps the prior mode. Do not repeat the action; reopen Settings to check it.");
      }
    } finally {
      setInterviewBusy(false);
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

  // custom 백엔드는 "키"와 "Base URL"이라는 서로 독립적인 두 값을 한 저장 버튼으로 다룬다.
  // 키는 저장 후 다시 표시하지 않으므로(아래 안내 문구), Base URL만 고치려는 사용자의
  // 키 입력칸은 항상 비어 있다. 이때 빈 문자열을 saveApiKey로 넘기면 vault가 기존 키를
  // 삭제해버리므로(electron/secrets/vault.ts saveApiKey), 값이 실제로 입력된 항목만 저장한다.
  function isSaveable(backend: ByokBackend): boolean {
    if (draftKey[backend].trim()) return true;
    // 키를 다시 입력하지 않아도 Base URL 변경만으로 저장할 수 있어야 한다.
    return backend === "custom" && draftCustomBaseUrl.trim() !== customBaseUrl.trim();
  }

  async function saveKey(backend: ByokBackend) {
    const api = ipc();
    if (!api) return;
    const key = draftKey[backend].trim();
    try {
      if (key) {
        await api.secrets.saveApiKey(backend, draftKey[backend]);
      }
      if (backend === "custom") {
        await api.config.setCustomBaseUrl(draftCustomBaseUrl);
      }
      setDraftKey((d) => ({ ...d, [backend]: "" }));
      setRuntimeMessage(
        key
          ? locale === "ko"
            ? "키를 저장했습니다. 값은 화면에 다시 표시하지 않습니다."
            : "Key saved. The value will not be shown again."
          : locale === "ko"
          ? "Base URL을 저장했습니다. 저장된 키는 그대로입니다."
          : "Base URL saved. The stored key was kept.",
      );
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
      await refreshMultimodal();
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
        <ScienceExtensionPanel />
        <MobileBridgePanel />

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

        {/* 엔진 파일 — 스킬·호스트 훅·어댑터 매니페스트를 앱 안에서 직접 고친다.
            지금까지 스킬은 읽기만 됐고 훅은 표면 자체가 없어, 고치려면 앱 밖에서
            런타임 폴더를 찾아야 했다. */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {locale === "ko" ? "엔진 파일 (스킬 · 훅 · 어댑터)" : "Engine files (skills · hooks · adapters)"}
        </h2>
        <AgentFileEditor
          locale={locale}
          source={runtimeSource}
          title={locale === "ko" ? "엔진 파일 편집" : "Edit engine files"}
          subtitle={locale === "ko"
            ? "설치된 엔진의 스킬, 호스트 훅, 어댑터 매니페스트를 여기서 고칩니다. 저장하면 파일에 그대로 씁니다."
            : "Edit the installed engine's skills, host hooks and adapter manifests here. Saving writes straight to the file."}
        />

        {/* 화면 테마 (라이트/다크/시스템) */}
        {/*
          다크가 꺼져 있으면 이 선택지 자체를 감춘다(오너 지시 2026-08-24).
          남겨 두면 눌러도 아무 일이 안 일어나는 죽은 버튼이 된다 — 화면이 고장 난 것처럼 보이고,
          그건 다크가 깨져 보이던 것과 같은 종류의 문제다.
        */}
        {DARK_THEME_ENABLED && <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.appearance.title")}
        </h2>}
        {DARK_THEME_ENABLED && <div
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
        </div>}

        <MediaDisplaySettings locale={locale} />

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
                  value={concurrencyDraft ?? concurrency.current}
                  disabled={concurrencyBusy}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setConcurrencyDraft(v);
                    setConcurrencyNotice(null);
                  }}
                  onPointerUp={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    void saveConcurrency(v);
                  }}
                  onKeyUp={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
                    void saveConcurrency(Number((e.target as HTMLInputElement).value));
                  }}
                  style={{ flex: 1, accentColor: "var(--accent)" }}
                />
                <strong style={{ fontSize: 20, minWidth: 32, textAlign: "center" }}>
                  {concurrencyDraft ?? concurrency.current}
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
                  disabled={concurrencyBusy}
                  onClick={() => void saveConcurrency(concurrency.recommended)}
                  style={{
                    fontSize: 11,
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--paper-edge)",
                    background: concurrency.current === concurrency.recommended ? "var(--accent)" : "var(--paper-2)",
                    color: concurrency.current === concurrency.recommended ? "var(--white)" : "var(--ink)",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {locale === "ko" ? `추천: ${concurrency.recommended}` : `Recommended: ${concurrency.recommended}`}
                </button>
              </div>
              {concurrency.current > concurrency.recommended && (
                <p style={{ fontSize: 11, color: "var(--warn-deep, var(--warn))", margin: "8px 0 0" }}>
                  {locale === "ko"
                    ? "⚠️ 추천보다 높아요 — 이 컴에선 느려지거나 버벅일 수 있어요."
                    : "⚠️ Above recommended — this machine may slow down or stutter."}
                </p>
              )}
              {concurrencyNotice && (
                <p role="status" style={{ fontSize: 11, color: "var(--warn-deep, var(--warn))", margin: "8px 0 0" }}>
                  {concurrencyNotice}
                </p>
              )}
            </div>
          </>
        )}

        {/* 백그라운드 데몬 — 앱을 닫아도 자동화·에이전트가 계속 돌게 한다(기본 off) */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {locale === "ko" ? "백그라운드 데몬" : "Background daemon"}
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
              ? "켜면 로그인할 때 데몬이 자동으로 떠서, 앱을 닫아도 예약 자동화와 상주 에이전트가 계속 동작합니다. 끄면 이 기계의 부팅 항목에서 제거합니다."
              : "When on, the daemon starts at login so scheduled automations and resident agents keep running with the app closed. Turning it off removes the login item from this machine."}
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={daemonAutostart}
              disabled={daemonAutostartBusy}
              onChange={(event) => {
                const next = event.target.checked;
                setDaemonAutostartBusy(true);
                setDaemonAutostart(next);
                void ipc()?.setDaemonAutostart?.(next)
                  .then((result) => {
                    setDaemonAutostart(Boolean(result?.enabled));
                    // 값은 저장됐는데 부팅 항목을 못 고친 경우를 조용히 넘기지 않는다.
                    if (result && result.reconciled === false) {
                      setDaemonAutostartNotice(
                        (locale === "ko" ? "설정은 저장했지만 부팅 항목을 바꾸지 못했습니다: " : "Saved, but the login item could not be updated: ")
                        + (result.reason ?? ""),
                      );
                    } else {
                      setDaemonAutostartNotice(null);
                    }
                  })
                  .catch(() => setDaemonAutostart(!next))
                  .finally(() => setDaemonAutostartBusy(false));
              }}
            />
            {locale === "ko" ? "로그인할 때 자동으로 시작" : "Start automatically at login"}
          </label>
          {daemonAutostartNotice && (
            <p style={{ fontSize: 11, color: "var(--warn-deep, var(--warn))", margin: "8px 0 0" }}>{daemonAutostartNotice}</p>
          )}
        </div>

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
                disabled={interviewBusy}
                onClick={() => void saveInterviewMode(opt.id)}
                style={{
                  fontSize: 12,
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid var(--paper-edge)",
                  background: interviewMode === opt.id ? "var(--accent)" : "var(--paper-2)",
                  color: interviewMode === opt.id ? "var(--white)" : "var(--ink)",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {locale === "ko" ? opt.ko : opt.en}
              </button>
            ))}
          </div>
          {interviewNotice && (
            <p role="status" style={{ fontSize: 11, color: "var(--warn-deep, var(--warn))", margin: "8px 0 0" }}>
              {interviewNotice}
            </p>
          )}
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
          loadFailed={multimodalLoadFailed}
          refreshing={multimodalRefreshing}
          drafts={multimodalDraft}
          onDraftChange={(key, value) => setMultimodalDraft((draft) => ({ ...draft, [key]: value }))}
          onSelect={(modality, providerId) => void saveMultimodalProvider(modality, providerId)}
          onSaveEnv={(key) => void saveMultimodalEnv(key)}
          onRetry={() => void refreshMultimodal()}
        />

        <TerminalProfilesPanel />

        {/* 로컬 모델 (Ollama) */}
        <h2 id="ollama" style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
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

        <ConnectSection
          title={locale === "ko" ? "API 모델" : "API models"}
          hint={t("settings.byok.note")}
          count={BYOK_BACKENDS.length}
          defaultOpen={false}
        >
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
                disabled={!isSaveable(b)}
                style={{
                  padding: "8px 14px",
                  borderRadius: "var(--radius-md)",
                  background: isSaveable(b) ? "var(--paper)" : "var(--paper-2)",
                  color: isSaveable(b) ? "var(--ink)" : "var(--muted-deep)",
                  fontWeight: 600,
                  fontSize: 12,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: isSaveable(b) ? "var(--neu-raised)" : "none",
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
        </ConnectSection>

        <MemoryDiagnosticsPanel />

        <MigrationPanel />
      </section>
    </div>
  );
}

function MobileBridgePanel() {
  const { locale } = useT();
  const [status, setStatus] = useState<MobileBridgeRuntimeStatus | null>(null);
  const [devices, setDevices] = useState<MobileBridgeDeviceSummary[]>([]);
  const [pairing, setPairing] = useState<MobileBridgePairingPayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  // Install gate — asked before a pairing QR is issued, because the QR is only
  // readable by the app's own scanner and is useless to someone without the app.
  const [installGate, setInstallGate] = useState<"closed" | "ask" | "stores">("closed");
  const [storeChoice, setStoreChoice] = useState<"android" | "ios" | null>(null);
  const [storeQrDataUrl, setStoreQrDataUrl] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        api.mobileBridge.status(),
        api.mobileBridge.listDevices(),
      ]);
      setStatus(nextStatus);
      setDevices(nextDevices);
      setLoadError(nextStatus.error ?? "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = ipcEvents()?.onMobileBridgeChanged?.(({ reason }) => {
      if (reason === "device-paired") {
        setPairing(null);
        setQrDataUrl("");
        setMessage(locale === "ko" ? "새 모바일 기기가 연결됐습니다." : "A new mobile device is paired.");
      } else if (reason === "challenge-expired" || reason === "challenge-invalidated") {
        setPairing(null);
        setQrDataUrl("");
        setMessage(locale === "ko" ? "연결 QR이 만료됐습니다. 새 QR을 만들어 주세요." : "The pairing QR expired. Create a new one.");
      } else if (reason === "runtime-rebinding" || reason === "runtime-stopped") {
        setPairing(null);
        setQrDataUrl("");
        setMessage(locale === "ko" ? "Desktop 연결 주소를 다시 확인하고 있습니다." : "Refreshing the Desktop connection address.");
      }
      void refresh();
    });
    return () => off?.();
  }, [locale, refresh]);

  useEffect(() => {
    if (!pairing) return;
    const expiresAt = Date.parse(pairing.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(() => {
      setPairing(null);
      setQrDataUrl("");
      setMessage(locale === "ko" ? "연결 QR이 만료됐습니다. 새 QR을 만들어 주세요." : "The pairing QR expired. Create a new one.");
      void refresh();
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [locale, pairing, refresh]);

  // Unlike the pairing QR, a store QR carries an ordinary https URL, so the
  // phone's default camera opens it. iOS has no listing yet (App Store review),
  // so that branch states the truth instead of producing a dead link.
  const ANDROID_STORE_URL = "https://play.google.com/store/apps/details?id=com.agentai.agentlas";

  async function showStoreQr(platform: "android" | "ios") {
    setStoreChoice(platform);
    if (platform === "ios") {
      setStoreQrDataUrl("");
      return;
    }
    try {
      setStoreQrDataUrl(
        await QRCode.toDataURL(ANDROID_STORE_URL, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 336,
          // QR 인코더는 CSS 변수를 모른다 — 스캐너 대비를 위해 값으로 고정한다.
          color: { dark: "#111210", light: "#FFFFFF" }, // colour-literal-allowed: QR encoder cannot read CSS variables
        }),
      );
    } catch {
      // A failed render must not strand the person on a blank panel; the link
      // itself is still shown by the caller's copy.
      setStoreQrDataUrl("");
    }
  }

  async function issuePairing() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const payload = await api.mobileBridge.issuePairing();
      const encoded = JSON.stringify(payload);
      // Scannability is set by how physically large one module lands on the
      // phone's sensor. The payload used to be 1228 chars, forcing a ~101x101
      // symbol into a ~200px box — under half a millimetre per module, which a
      // slightly blurred camera cannot resolve. The payload is now 410 chars,
      // so the same box carries a far coarser symbol and can afford medium
      // error correction (15% recoverable) instead of the 7% floor.
      const image = await QRCode.toDataURL(encoded, {
        errorCorrectionLevel: "M",
        margin: 3,
        width: 512,
        // QR 인코더는 CSS 변수를 모른다 — 스캐너 대비를 위해 값으로 고정한다.
          color: { dark: "#111210", light: "#FFFFFF" }, // colour-literal-allowed: QR encoder cannot read CSS variables
      });
      setPairing(payload);
      setQrDataUrl(image);
      await refresh();
    } catch (error) {
      setPairing(null);
      setQrDataUrl("");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryBridge() {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setMessage(locale === "ko" ? "모바일 연결을 다시 여는 중입니다…" : "Restarting the mobile connection…");
    try {
      const next = await api.mobileBridge.retry();
      setStatus(next);
      setLoadError(next.error ?? "");
      setMessage(
        next.running
          ? (locale === "ko" ? "모바일 연결을 다시 열었습니다." : "The mobile connection is available again.")
          : (next.error ?? (locale === "ko" ? "모바일 연결을 열지 못했습니다." : "Could not restart the mobile connection.")),
      );
      await refresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setLoadError(detail);
      setMessage(detail);
    } finally {
      setBusy(false);
    }
  }

  async function revealBridgeLog() {
    const api = ipc();
    if (!api) return;
    // The log is the only way to see why remote access (Cloud Relay) is not
    // connecting; a packaged app otherwise discards those diagnostics.
    const result = await api.mobileBridge.revealLog();
    if (!result?.ok) {
      setMessage(
        locale === "ko"
          ? "아직 기록된 로그 파일이 없습니다. 앱을 다시 시작한 뒤 시도해 주세요."
          : "No log file has been written yet. Restart the app and try again.",
      );
    }
  }

  async function copyPairing() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(pairing));
      setMessage(locale === "ko" ? "1회용 연결 내용을 복사했습니다." : "One-time pairing payload copied.");
    } catch {
      setMessage(locale === "ko" ? "클립보드에 복사하지 못했습니다." : "Could not copy to the clipboard.");
    }
  }

  async function revoke(device: MobileBridgeDeviceSummary) {
    const api = ipc();
    if (!api) return;
    const confirmed = window.confirm(
      locale === "ko"
        ? `${device.name}의 모바일 연결을 해제할까요? 즉시 다시 인증해야 합니다.`
        : `Disconnect ${device.name}? It will need to pair again.`,
    );
    if (!confirmed) return;
    try {
      const result = await api.mobileBridge.revokeDevice(device.deviceId);
      if (!result.ok) {
        setMessage(locale === "ko" ? "이미 해제됐거나 찾을 수 없는 기기입니다." : "The device was already revoked or not found.");
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const activeDevices = devices.filter((device) => device.revokedAt === null);
  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
        {locale === "ko" ? "Agentlas Mobile 연결" : "Agentlas Mobile connection"}
      </h2>
      <div
        style={{
          padding: 16,
          border: "1px solid var(--paper-edge)",
          borderRadius: 18,
          background: "var(--paper)",
          boxShadow: "var(--neu-raised)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {status?.running
                ? locale === "ko" ? "이 Desktop을 폰에서 제어할 수 있습니다" : "This Desktop is ready for Mobile"
                : locale === "ko" ? "모바일 연결을 시작하지 못했습니다" : "Mobile connection is unavailable"}
            </div>
            <div style={{ marginTop: 4, color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
              {status?.endpoint ?? (locale === "ko" ? "Desktop Bridge가 준비되지 않았습니다." : "Desktop Bridge is not ready.")}
            </div>
          </div>
          <button
            data-testid="mobile-bridge-retry"
            type="button"
            disabled={busy}
            onClick={() => void retryBridge()}
            style={{
              border: "1px solid var(--paper-edge)",
              borderRadius: 999,
              padding: "9px 14px",
              background: "var(--paper-2)",
              color: busy ? "var(--muted-deep)" : "var(--ink)",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {locale === "ko" ? "연결 다시 열기" : "Restart connection"}
          </button>
          <button
            type="button"
            onClick={() => void revealBridgeLog()}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 999,
              padding: "9px 16px",
              background: "var(--paper)",
              color: "var(--ink)",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {locale === "ko" ? "로그 열기" : "Open log"}
          </button>
          <button
            type="button"
            disabled={!status?.running || busy}
            onClick={() => setInstallGate("ask")}
            style={{
              border: 0,
              borderRadius: 999,
              padding: "9px 16px",
              background: status?.running && !busy ? "var(--ink)" : "var(--paper-2)",
              color: status?.running && !busy ? "var(--paper)" : "var(--muted-deep)",
              fontSize: 12,
              fontWeight: 700,
              boxShadow: status?.running && !busy ? "0 6px 16px -6px rgba(20,20,20,.5)" : "none",
            }}
          >
            {busy
              ? locale === "ko" ? "처리 중…" : "Working…"
              : locale === "ko" ? "새 기기 연결" : "Pair a device"}
          </button>
        </div>

        {/* The pairing QR carries app-only data, so a phone's default camera cannot
            complete a pairing — it just dumps the text (measured: a user's scan
            landed in a notes app). WhatsApp has the same constraint and solves it
            the same way: state the exact in-app path before showing the code.
            This gate also answers the prerequisite question — is the app even
            installed — instead of leaving a person with an unusable QR. */}
        {installGate !== "closed" && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={locale === "ko" ? "모바일 앱 설치 확인" : "Mobile app install check"}
            data-testid="mobile-bridge-install-gate"
            onClick={() => setInstallGate("closed")}
            style={{
              position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center",
              background: "rgba(16,16,16,.44)", padding: 20,
            }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "var(--popup-3-width)", background: "var(--paper)", borderRadius: 18,
                border: "1px solid var(--paper-edge)", boxShadow: "0 24px 60px -24px rgba(0,0,0,.5)",
                padding: 22,
              }}
            >
              {installGate === "ask" ? (
                <>
                  <div style={{ fontSize: 15, fontWeight: 750 }}>
                    {locale === "ko" ? "Agentlas 모바일 앱을 설치하셨나요?" : "Do you have the Agentlas mobile app?"}
                  </div>
                  <p style={{ margin: "8px 0 18px", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.65 }}>
                    {locale === "ko"
                      ? "연결 QR은 Agentlas 앱의 스캐너로만 읽을 수 있습니다. 폰 기본 카메라로 찍으면 연결되지 않습니다."
                      : "The pairing QR only works with the scanner inside the Agentlas app. Your phone's default camera cannot complete the pairing."}
                  </p>
                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      type="button"
                      data-testid="install-gate-have-app"
                      onClick={() => { setInstallGate("closed"); void issuePairing(); }}
                      style={{
                        border: 0, borderRadius: 12, padding: "11px 14px", background: "var(--ink)",
                        color: "var(--paper)", fontSize: 12.5, fontWeight: 700,
                      }}
                    >
                      {locale === "ko" ? "이미 설치했습니다" : "I already have it"}
                    </button>
                    <button
                      type="button"
                      data-testid="install-gate-need-app"
                      onClick={() => setInstallGate("stores")}
                      style={{
                        border: "1px solid var(--paper-edge)", borderRadius: 12, padding: "11px 14px",
                        background: "var(--paper-2)", color: "var(--ink)", fontSize: 12.5, fontWeight: 700,
                      }}
                    >
                      {locale === "ko" ? "설치하러 가기" : "Get the app"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 15, fontWeight: 750 }}>
                    {locale === "ko" ? "설치할 기기를 고르세요" : "Choose your phone"}
                  </div>
                  <p style={{ margin: "8px 0 18px", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.65 }}>
                    {locale === "ko"
                      ? "로고를 누르면 설치용 QR이 나옵니다. 그 QR은 폰 기본 카메라로 찍어도 됩니다."
                      : "Pick a platform to get an install QR. That one does work with your phone's default camera."}
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <button
                      type="button"
                      data-testid="install-gate-android"
                      onClick={() => void showStoreQr("android")}
                      style={{
                        display: "grid", placeItems: "center", gap: 8, padding: "18px 12px",
                        border: `1px solid ${storeChoice === "android" ? "var(--ink)" : "var(--paper-edge)"}`,
                        borderRadius: 14, background: "var(--paper-2)", color: "var(--ink)",
                        fontSize: 11.5, fontWeight: 700,
                      }}
                    >
                      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="var(--ok)" d="M3.6 1.9a1 1 0 0 0-.5.9v18.4a1 1 0 0 0 .5.9l10-10.1z" />
                        <path fill="var(--warn)" d="M17.3 8.3 14 6.4 3.6 1.9c-.1 0-.1 0-.1.1l10.1 10z" />
                        <path fill="var(--danger)" d="M13.6 12.1 3.5 22c0 .1 0 .1.1.1l10.4-4.5 3.3-1.9z" />
                        <path fill="var(--info)" d="M20.7 10.9 17.3 9l-3.7 3.1 3.7 3.4 3.4-1.9c.8-.4.8-2.3 0-2.7z" />
                      </svg>
                      Google Play
                    </button>
                    <button
                      type="button"
                      data-testid="install-gate-ios"
                      onClick={() => void showStoreQr("ios")}
                      style={{
                        display: "grid", placeItems: "center", gap: 8, padding: "18px 12px",
                        border: `1px solid ${storeChoice === "ios" ? "var(--ink)" : "var(--paper-edge)"}`,
                        borderRadius: 14, background: "var(--paper-2)", color: "var(--ink)",
                        fontSize: 11.5, fontWeight: 700,
                      }}
                    >
                      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                        <path d="M16.4 12.7c0-2.2 1.8-3.2 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.8-3.6 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.6.7 2.8.7 1.2 0 1.9-1.1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.2-.9-2.2-3.4zM14.3 5.9c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.7-.9 2.6 1 .1 2-.5 2.6-1.2z" />
                      </svg>
                      App Store
                    </button>
                  </div>

                  {storeChoice === "ios" && (
                    <div
                      data-testid="install-gate-ios-pending"
                      style={{
                        marginTop: 14, padding: "11px 12px", borderRadius: 10,
                        background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.6,
                      }}
                    >
                      {locale === "ko"
                        ? "iOS 앱은 App Store 심사 중입니다. 지금은 Android만 설치할 수 있습니다."
                        : "The iOS app is still in App Store review. Android is the only install available right now."}
                    </div>
                  )}

                  {storeChoice === "android" && storeQrDataUrl && (
                    <div data-testid="install-gate-android-qr" style={{ marginTop: 14, display: "grid", gap: 10, justifyItems: "center" }}>
                      <div style={{ border: "1px solid var(--paper-edge)", borderRadius: 14, background: "var(--paper)", padding: 10 }}>
                        <img
                          src={storeQrDataUrl}
                          alt={locale === "ko" ? "Google Play 설치 QR" : "Google Play install QR"}
                          style={{ display: "block", width: 168, height: 168 }}
                        />
                      </div>
                      <div style={{ color: "var(--muted-deep)", fontSize: 11, textAlign: "center", lineHeight: 1.6 }}>
                        {locale === "ko"
                          ? "폰 카메라로 찍으면 Google Play가 열립니다. 설치 후 이 창에서 “이미 설치했습니다”를 누르세요."
                          : "Scan it with your phone camera to open Google Play. After installing, choose “I already have it”."}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <button
                      type="button"
                      onClick={() => { setStoreChoice(null); setStoreQrDataUrl(""); setInstallGate("ask"); }}
                      style={{
                        flex: 1, border: "1px solid var(--paper-edge)", borderRadius: 12, padding: "9px 12px",
                        background: "var(--paper-2)", color: "var(--ink)", fontSize: 12, fontWeight: 700,
                      }}
                    >
                      {locale === "ko" ? "뒤로" : "Back"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setInstallGate("closed"); void issuePairing(); }}
                      style={{
                        flex: 1, border: 0, borderRadius: 12, padding: "9px 12px",
                        background: "var(--ink)", color: "var(--paper)", fontSize: 12, fontWeight: 700,
                      }}
                    >
                      {locale === "ko" ? "설치했습니다" : "Installed — continue"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {pairing && qrDataUrl && (
          <div data-testid="mobile-bridge-pairing" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 288px) 1fr", gap: 20, marginTop: 18, alignItems: "center" }}>
            <div style={{ border: "1px solid var(--paper-edge)", borderRadius: 18, background: "var(--paper)", padding: 12 }}>
              {/* The data URL is produced locally; the QR contains a two-minute nonce and public certificate only. */}
              <img src={qrDataUrl} alt={locale === "ko" ? "Agentlas Mobile 연결 QR" : "Agentlas Mobile pairing QR"} style={{ display: "block", width: "100%", aspectRatio: "1" }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {locale === "ko"
                  ? "Agentlas 앱에서 스캔하세요 — 기기 추가 → QR 스캔"
                  : "Scan from the Agentlas app — Add device → Scan QR"}
              </div>
              {/* Naming the in-app path is the fix for the reported failure: the
                  instruction used to say only "scan this", so people reached for
                  the default camera, which cannot complete a pairing. */}
              <p style={{ margin: "6px 0 12px", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.6 }}>
                {locale === "ko"
                  ? "폰 기본 카메라로는 연결되지 않습니다. 2분 후 만료되며 한 번만 쓸 수 있고, 장기 기기 키나 Desktop 비밀값은 QR에 들어가지 않습니다."
                  : "Your phone's default camera cannot complete this pairing. It expires in two minutes and works once; the QR never contains a long-lived device key or Desktop secret."}
              </p>
              <button
                type="button"
                onClick={() => void copyPairing()}
                style={{ border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "7px 12px", background: "var(--paper-2)", color: "var(--ink)", fontSize: 11.5, fontWeight: 700 }}
              >
                {locale === "ko" ? "연결 내용 복사" : "Copy pairing payload"}
              </button>
            </div>
          </div>
        )}

        {(loadError || message) && (
          <div role="status" style={{ marginTop: 12, padding: "9px 11px", borderRadius: 10, background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 11.5, overflowWrap: "anywhere" }}>
            {loadError || message}
          </div>
        )}

        <div style={{ marginTop: 16, borderTop: "1px solid var(--paper-edge)", paddingTop: 14 }}>
          <div data-testid="mobile-bridge-device-count" style={{ color: "var(--muted-deep)", fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
            {locale === "ko" ? `연결된 모바일 ${activeDevices.length}대` : `${activeDevices.length} paired mobile device${activeDevices.length === 1 ? "" : "s"}`}
          </div>
          {activeDevices.length === 0 ? (
            <div style={{ color: "var(--muted-deep)", fontSize: 12 }}>
              {locale === "ko" ? "아직 연결된 기기가 없습니다." : "No mobile device is paired yet."}
            </div>
          ) : activeDevices.map((device) => (
            <div key={device.deviceId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 650 }}>{device.name}</div>
                <div style={{ color: "var(--muted-deep)", fontSize: 10.5 }}>
                  {device.platform.toUpperCase()} · {new Date(device.issuedAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void revoke(device)}
                style={{ border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "5px 10px", background: "transparent", color: "var(--red-deep, var(--danger))", fontSize: 11, fontWeight: 700 }}
              >
                {locale === "ko" ? "연결 해제" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** 메모리 & 진단 — 유휴 드리밍 큐레이션 토글(옵트인) + Hephaestus 엔진 진단/슈퍼바이저.
 *  드리밍: 자리를 비운 유휴 시간에만 큐레이터 메모리를 통합(dedup+LLM 요약). 기본 OFF. */
function MemoryDiagnosticsPanel() {
  const { t, locale } = useT();
  const ko = locale !== "en";
  const [dreaming, setDreaming] = useState<{ enabled: boolean; lastRunAt: string | null; running: boolean } | null>(null);
  const [supervisor, setSupervisor] = useState<boolean | null>(null);
  /*
   * 유료 Hub 자동고용. 기본이 켜짐인데 앱 어디에도 끄는 스위치가 없었다
   * (감사 2026-08-25: 값을 읽어 쓰기는 하는데 바꾸는 곳이 0). 돈이 나가는
   * 자동 동작에는 끄는 길이 있어야 한다.
   */
  const [networkAuto, setNetworkAuto] = useState<boolean | null>(null);
  const [toggleBusy, setToggleBusy] = useState<"dreaming" | "supervisor" | "network" | null>(null);
  const [toggleNotice, setToggleNotice] = useState<string | null>(null);
  const [doctorOut, setDoctorOut] = useState<string | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.memoryDreaming.status().then(setDreaming).catch(() => {});
    void api.hephaestus.getSupervisor().then((s) => setSupervisor(s.enabled)).catch(() => {});
    void api.hephaestus.getEngineToggles().then((t) => setNetworkAuto(t?.networkAuto === true)).catch(() => {});
  }, []);

  const toggleDreaming = async () => {
    const api = ipc();
    if (!api || !dreaming || toggleBusy) return;
    const requested = !dreaming.enabled;
    setToggleBusy("dreaming");
    setToggleNotice(null);
    try {
      const receipt = await api.memoryDreaming.setEnabled(requested);
      if (receipt?.enabled !== requested) throw new Error("dreaming_receipt_mismatch");
      const readback = await api.memoryDreaming.status();
      if (readback?.enabled !== requested) throw new Error("dreaming_readback_mismatch");
      setDreaming(readback);
      setToggleNotice(ko ? "드리밍 설정을 저장하고 다시 확인했습니다." : "Dreaming was saved and verified.");
    } catch {
      setToggleNotice(ko
        ? "드리밍 변경의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 반복해서 누르지 말고 설정을 다시 열어 확인해 주세요."
        : "The final dreaming state could not be verified. This screen was not changed. Do not repeat the action; reopen Settings to check it.");
    } finally {
      setToggleBusy(null);
    }
  };

  const toggleSupervisor = async () => {
    const api = ipc();
    if (!api || supervisor == null || toggleBusy) return;
    const requested = !supervisor;
    setToggleBusy("supervisor");
    setToggleNotice(null);
    try {
      const receipt = await api.hephaestus.setSupervisor(requested);
      if (receipt?.enabled !== requested) throw new Error("supervisor_receipt_mismatch");
      const readback = await api.hephaestus.getSupervisor();
      if (readback?.enabled !== requested) throw new Error("supervisor_readback_mismatch");
      setSupervisor(readback.enabled);
      setToggleNotice(ko ? "슈퍼바이저 설정을 저장하고 다시 확인했습니다." : "Supervisor was saved and verified.");
    } catch {
      setToggleNotice(ko
        ? "슈퍼바이저 변경의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 설정을 다시 열어 확인해 주세요."
        : "The final supervisor state could not be verified. This screen was not changed. Reopen Settings to check it.");
    } finally {
      setToggleBusy(null);
    }
  };

  const toggleNetworkAuto = async () => {
    const api = ipc();
    if (!api || networkAuto == null || toggleBusy) return;
    const requested = !networkAuto;
    setToggleBusy("network");
    setToggleNotice(null);
    try {
      const receipt = await api.hephaestus.setEngineToggle({ id: "network", enabled: requested });
      if (receipt?.networkAuto !== requested) throw new Error("network_toggle_receipt_mismatch");
      const readback = await api.hephaestus.getEngineToggles();
      if (readback?.networkAuto !== requested) throw new Error("network_toggle_readback_mismatch");
      setNetworkAuto(readback.networkAuto);
      setToggleNotice(ko ? "Hub 자동 고용 설정을 저장하고 다시 확인했습니다." : "Automatic Hub hiring was saved and verified.");
    } catch {
      setToggleNotice(ko
        ? "유료 Hub 자동 고용의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 반복해서 누르지 말고 설정을 다시 열어 확인해 주세요."
        : "The final paid Hub auto-hiring state could not be verified. This screen was not changed. Do not repeat the action; reopen Settings to check it.");
    } finally {
      setToggleBusy(null);
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
      {toggleNotice && (
        <p role="status" style={{ fontSize: 11.5, color: "var(--warn-deep, var(--warn))", margin: "0 0 10px" }}>
          {toggleNotice}
        </p>
      )}

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
        <button onClick={() => void toggleDreaming()} style={{ ...btnStyle, minWidth: 64 }} disabled={!dreaming || toggleBusy !== null}>
          {toggleBusy === "dreaming" ? "…" : dreaming ? (dreaming.enabled ? "ON" : "OFF") : "…"}
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
        <button onClick={() => void toggleSupervisor()} style={{ ...btnStyle, minWidth: 64 }} disabled={supervisor == null || toggleBusy !== null}>
          {toggleBusy === "supervisor" ? "…" : supervisor == null ? "…" : supervisor ? "ON" : "OFF"}
        </button>
      </div>

      <div style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {ko ? "밖에서 전문가 자동 고용" : "Hire outside specialists automatically"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginTop: 2 }}>
            {ko
              ? "설치된 에이전트로 부족할 때 공개 Hub 에서 사람을 빌립니다 — 크레딧이 나갑니다."
              : "Borrows people from the public Hub when installed agents fall short — this spends credits."}
          </div>
        </div>
        <button onClick={() => void toggleNetworkAuto()} style={{ ...btnStyle, minWidth: 64 }} disabled={networkAuto == null || toggleBusy !== null}>
          {toggleBusy === "network" ? "…" : networkAuto == null ? "…" : networkAuto ? "ON" : "OFF"}
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
  loadFailed,
  refreshing,
  drafts,
  onDraftChange,
  onSelect,
  onSaveEnv,
  onRetry,
}: {
  providers: MultimodalProvider[];
  settings: MultimodalSettings | null;
  status: MultimodalProviderStatus[];
  loadFailed: boolean;
  refreshing: boolean;
  drafts: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  onSelect: (modality: MultimodalModality, providerId: string) => void;
  onSaveEnv: (key: string) => void;
  onRetry: () => void;
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
      {loadFailed && (
        <div
          role="alert"
          data-testid="settings-multimodal-error"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            marginBottom: 10,
            border: "1px solid var(--peach-edge, var(--warn-soft))",
            borderRadius: "var(--radius-md)",
            background: "var(--peach-soft, var(--warn-soft))",
            color: "var(--ink-soft)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <span style={{ flex: 1 }}>
            {locale === "en"
              ? "Some multimodal connection details could not be loaded. Other settings are still available."
              : "일부 멀티모달 연결 정보를 불러오지 못했습니다. 다른 설정은 그대로 사용할 수 있습니다."}
          </span>
          <button type="button" onClick={onRetry} disabled={refreshing} style={multimodalSecretButtonStyle}>
            {refreshing ? (locale === "en" ? "Retrying…" : "다시 확인 중…") : locale === "en" ? "Retry" : "다시 시도"}
          </button>
        </div>
      )}
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

/*
 * The attached Agentlas-OS engine, shown under the app version.
 *
 * Two things this deliberately does that a bare version string does not:
 *
 *  1. It names the SOURCE. `managed` follows its own release train; `bundled`
 *     is the frozen copy inside this app and never advances; `override` is a
 *     developer path. They are functionally different — the bundled fallback
 *     ships without the Workforce goal-continuity tools, so "keep working on
 *     this goal" silently stops persisting while the version still looks fine
 *     and the engine still passes its self-check. A number cannot say that.
 *
 *  2. It says the engine updates separately. This sits directly above a
 *     "check for updates" button that only ever touches the app — the engine
 *     is refreshed by a detached worker at launch. Without the suffix the
 *     button reads as covering both, which is a promise it cannot keep.
 *
 *  3. It can be acted on. Telling someone their engine is stale and giving them
 *     nothing to press is worse than saying nothing — it converts a silent
 *     problem into a visible dead end. The button runs Core's own updater
 *     attached and reports what the journal says it did.
 *
 * The warning line appears only when something is actually off. On a healthy
 * managed runtime this is one quiet monospace line, because a settings panel
 * that explains itself every time trains people to stop reading it.
 */
/*
 * 엔진 계정 — 데스크탑 로그인과 **별개**라는 사실을 사용자에게 처음으로 보여준다.
 *
 * 두 자격증명이 다르다: 데스크탑은 `agentlas_session` 쿠키를 OS 키체인으로 감싸 두고,
 * 엔진은 OAuth access token 을 `~/.agentlas/auth/<host>.json` 에 둔다. 엔진은 쿠키를
 * 받지 않으므로 데스크탑 세션을 그대로 넘겨줄 수 없다(엔진은 수정 범위 밖).
 *
 * 예전에는 이 차이가 **Publish 도중에** 드러났다 — 난데없이 브라우저 로그인 창이 뜨거나
 * 무응답 후 타임아웃. 오늘 그 습격은 막았고(`--no-open`), 대신 여기서 상태를 보여주고
 * 사용자가 원할 때 **한 번** 끝내게 한다. 토큰 값은 데스크탑이 보지도 저장하지도 않는다.
 */
function CoreAccountLine({ attached }: { attached: boolean }) {
  const { t } = useT();
  const [state, setState] = useState<"unknown" | "authenticated" | "signed_out">("unknown");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!attached) return;
    try {
      const result = await ipc()?.hephaestus.coreAuthStatus();
      const status = (result?.json as { status?: string } | null)?.status;
      setState(status === "authenticated" ? "authenticated" : status ? "signed_out" : "unknown");
    } catch {
      setState("unknown");
    }
  }, [attached]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!attached || state === "unknown") return null;

  async function signIn() {
    if (busy) return;
    setBusy(true);
    setNote(t("settings.update.core_account_opening"));
    try {
      const result = await ipc()?.hephaestus.coreAuthLogin();
      const status = (result?.json as { status?: string } | null)?.status;
      setNote(status === "authenticated" ? null : t("settings.update.core_account_failed"));
      await refresh();
    } catch {
      setNote(t("settings.update.core_account_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 6, lineHeight: 1.55 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span>
          {state === "authenticated"
            ? t("settings.update.core_account_in")
            : t("settings.update.core_account_out")}
        </span>
        {state !== "authenticated" && (
          <button
            type="button"
            onClick={() => void signIn()}
            disabled={busy}
            style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--muted-deep)", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? t("settings.update.core_account_opening") : t("settings.update.core_account_signin")}
          </button>
        )}
      </div>
      {note && <div style={{ marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function CoreEngineLine({
  core,
  onUpdated,
}: {
  core: {
    version: string | null;
    root: string | null;
    source: "managed" | "bundled" | "override" | null;
    available: boolean;
    reason: string | null;
  };
  onUpdated: () => void;
}) {
  const { t, locale } = useT();
  const [journal, setJournal] = useState<HephaestusUpdateJournal | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const pendingReloadMessage = (
    state: "applied" | "current" | "unknown" | "unobserved",
    hosts: string,
  ) => state === "applied"
    ? t("settings.update.core_update_applied_pending_reload", { hosts })
    : state === "current"
      ? t("settings.update.core_update_current_pending_reload", { hosts })
      : t("settings.update.core_update_unknown_pending_reload", { hosts });

  useEffect(() => {
    let cancelled = false;
    void ipc()?.hephaestus.updateJournal()
      .then((j) => {
        if (!cancelled) setJournal(j);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceLabel =
    core.source === "managed" ? t("settings.update.core_source_managed")
      : core.source === "bundled" ? t("settings.update.core_source_bundled")
      : core.source === "override" ? t("settings.update.core_source_override")
      : null;
  const warning =
    !core.root ? t("settings.update.core_warn_missing")
      // Files present but unusable — most often no Python 3.9+. This must win
      // over the source note: an engine that cannot run is not a nuance.
      : !core.available ? (core.reason || t("settings.update.core_warn_unusable"))
      : core.source === "bundled" ? t("settings.update.core_warn_bundled")
      : core.source === "override" ? t("settings.update.core_warn_override")
      : null;

  // An explicit override is the user's own pin. Offering to update it would
  // fight the thing they deliberately set.
  const canUpdate = core.source !== "override";

  async function runUpdate() {
    const api = ipc();
    if (!api || running) return;
    setRunning(true);
    setOutcome(null);
    try {
      const result = await api.hephaestus.runUpdate();
      setJournal(result.journal);
      const updateDisposition = classifyHephaestusUpdateJournal(result.journal);
      const pendingHostLabel = hephaestusPendingHostLabels(result.journal).join("/")
        || (locale === "ko" ? "호스트 앱" : "host apps");
      // Every branch here is a state the user can understand and, where it
      // matters, keep waiting on. None of them is a dead end: a long download
      // continues on its own, and no network resolves itself once there is one.
      setOutcome(
        updateDisposition.reloadRequired
          ? pendingReloadMessage(updateDisposition.state, pendingHostLabel)
        : result.outcome === "applied" ? t("settings.update.core_update_applied")
          : result.outcome === "current" ? t("settings.update.core_update_already_current")
          : result.outcome === "working" ? t("settings.update.core_update_working")
          : result.outcome === "busy" ? t("settings.update.core_update_busy")
          : result.outcome === "unknown" ? t("settings.update.core_update_unknown")
          : result.outcome === "offline" ? t("settings.update.core_update_offline")
          : result.outcome === "no_python" ? t("settings.update.core_update_no_python")
          : t("settings.update.core_update_no_engine"),
      );
      if (result.outcome === "applied") onUpdated();
    } catch {
      setOutcome(t("settings.update.core_update_offline"));
    } finally {
      setRunning(false);
    }
  }

  const lastChecked = journal?.lastCheckedEpoch
    ? new Date(journal.lastCheckedEpoch * 1000).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")
    : null;
  const journalDisposition = classifyHephaestusUpdateJournal(journal);
  const journalPendingHostLabel = hephaestusPendingHostLabels(journal).join("/")
    || (locale === "ko" ? "호스트 앱" : "host apps");
  const journalPendingOutcome = journalDisposition.reloadRequired
    ? pendingReloadMessage(journalDisposition.state, journalPendingHostLabel)
    : null;

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted-deep)",
            overflowWrap: "anywhere",
            // Support asks people to read this back. Let them select it.
            userSelect: "text",
          }}
          title={core.root ?? undefined}
        >
          {core.version ? `agentlas-os v${core.version}` : t("settings.update.core_missing")}
          {sourceLabel ? ` · ${sourceLabel}` : ""}
        </div>
        {canUpdate && (
          <button
            type="button"
            onClick={() => void runUpdate()}
            disabled={running}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted-deep)",
              cursor: running ? "default" : "pointer",
              opacity: running ? 0.6 : 1,
            }}
          >
            {running ? t("settings.update.core_update_running") : t("settings.update.core_update_now")}
          </button>
        )}
      </div>
      {warning && (
        <div style={{ fontSize: 11, color: "var(--warn, var(--muted-deep))", marginTop: 3, lineHeight: 1.5 }}>
          {warning}
        </div>
      )}
      <CoreAccountLine attached={Boolean(core.root)} />
      {(outcome || journalPendingOutcome || lastChecked) && (
        <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 3, lineHeight: 1.5 }}>
          {outcome ?? journalPendingOutcome ?? t("settings.update.core_last_checked", { when: lastChecked ?? "" })}
        </div>
      )}
    </div>
  );
}

function UpdatePanel() {
  const { t } = useT();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [installDeferred, setInstallDeferred] = useState(false);
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  /*
   * Desktop's own version is not the whole answer. Build, upload, routing and
   * the Workforce contract all belong to the attached Agentlas-OS Core, which
   * updates on its own release train and is resolved at runtime — managed
   * `~/.agentlas/runtime/current` when healthy, the bundled copy otherwise.
   * Measured 2026-07-28: managed 1.1.73 vs bundled 1.1.62, and the bundled
   * fallback is missing five workforce goal-continuity tools outright. Showing
   * only the app version left no surface anywhere telling the user (or support)
   * which Core they are actually on.
   */
  const [core, setCore] = useState<{
    version: string | null;
    root: string | null;
    source: "managed" | "bundled" | "override" | null;
    // Kept, not dropped. `hephaestusAvailable` still fills root/version/source
    // when Python is missing, so a status line built from those three alone
    // rendered a broken engine as perfectly healthy — while the dashboard, from
    // the same call, said "blocked". Two screens, one moment, opposite answers.
    available: boolean;
    reason: string | null;
  } | null>(null);

  // Shared by first paint and the update button: after an engine update the
  // version on screen must be the new one, not the one we read at mount.
  const refreshCore = useCallback(async () => {
    try {
      const s = await ipc()?.hephaestus.status();
      setCore({
        version: s?.version ?? null,
        root: s?.root ?? null,
        source: s?.source ?? null,
        available: s?.available ?? false,
        reason: s?.reason ?? null,
      });
    } catch {
      setCore({ version: null, root: null, source: null, available: false, reason: null });
    }
  }, []);

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
      // Core absence is a real state, not an error: most of Desktop works
      // without it. Report it plainly rather than hiding the row.
      void refreshCore();
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
    setInstallDeferred(false);
    const result = await api.updater.install();
    setInstallDeferred(result.blockedBy === "active-runs");
  }

  async function revealRecoveryBackup() {
    await ipc()?.updater.revealRecoveryBackup();
  }

  async function retrySafetyAction() {
    const api = ipc();
    if (!api) return;
    if (state.code === "continuity-backup-failed") await api.updater.install();
    else await api.updater.check();
  }

  async function openOfficialInstaller() {
    await ipc()?.updater.openManualDownload();
  }

  const statusText = (() => {
    if (installDeferred) return t("settings.update.active_runs");
    if (state.code === "install-source-untrusted") return t("settings.update.repair_required");
    if (state.code === "install-not-applied") return t("settings.update.install_not_applied");
    if (state.code === "install-start-failed") return t("settings.update.install_start_failed");
    if (state.code === "continuity-backup-failed") return t("settings.update.safety_backup_failed");
    if (state.code === "legacy-cleanup-failed") return t("settings.update.cleanup_failed");
    if (state.code === "compatibility-metadata-missing") return t("settings.update.metadata_missing");
    if (state.code === "minimum-app-version") return t("settings.update.too_old_to_auto_update");
    if (state.code === "minimum-schema-version") return t("settings.update.schema_incompatible");
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
      case "installing":
        return t("settings.update.installing", { version: state.version ?? "?" });
      case "updated":
        return t("settings.update.updated", { version: state.version ?? version ?? "?" });
      case "not-available":
        return t("settings.update.not_available");
      case "manual-required":
        return t("settings.update.manual_required");
      case "incompatible":
        return t("settings.update.incompatible");
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
          alignItems: "flex-start",
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
          {core && <CoreEngineLine core={core} onUpdated={refreshCore} />}
          <div style={{ fontSize: 12, color: "var(--muted-deep)", marginTop: 6, lineHeight: 1.55, whiteSpace: "normal", overflowWrap: "anywhere" }}>
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
              flexShrink: 0,
              maxWidth: 180,
              whiteSpace: "normal",
              lineHeight: 1.35,
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
            }}
          >
            {t("settings.update.install")}
          </button>
        ) : updaterCanUseOfficialInstaller(state) ? (
          <button
            onClick={() => void openOfficialInstaller()}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontWeight: 700,
              fontSize: 12,
              flexShrink: 0,
              maxWidth: 180,
              whiteSpace: "normal",
              lineHeight: 1.35,
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
            }}
          >
            {t("settings.update.open_download")}
          </button>
        ) : (state.status === "manual-required" || state.status === "incompatible") && state.canRetry ? (
          <button
            onClick={() => void retrySafetyAction()}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontWeight: 700,
              fontSize: 12,
              flexShrink: 0,
              maxWidth: 180,
              whiteSpace: "normal",
              lineHeight: 1.35,
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
            }}
          >
            {t("settings.update.retry")}
          </button>
        ) : state.status === "manual-required" || state.status === "incompatible" ? null
        : (
          <button
            onClick={() => void check()}
            disabled={checking || state.status === "installing"}
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
            {state.status === "installing"
              ? t("settings.update.installing", { version: state.version ?? "?" })
              : checking
                ? t("settings.update.checking")
                : t("settings.update.check")}
          </button>
        )}
      </div>
    </>
  );
}


// ── BYOK live model catalog + manual ID escape hatch ─────
// Model generations are provider-owned. Never pin versioned IDs in the UI.
function ByokModelControls({
  backend,
  status,
  onActivate,
}: {
  backend: ByokBackend;
  status?: RuntimeStatus;
  onActivate: (backend: ByokBackend, model: string, longContext: boolean) => void | Promise<void>;
}) {
  const { t, locale } = useT();
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [manualModel, setManualModel] = useState(status?.model ?? "");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const currentModel = status?.model ?? "";

  useEffect(() => {
    let live = true;
    const api = ipc();
    if (!api) {
      setLoading(false);
      return () => { live = false; };
    }
    setLoading(true);
    setLoadError(false);
    void api.runtime
      .listModels({ kind: "byok", backend, availableModels: status?.availableModels })
      .then((next) => {
        if (!live) return;
        const unique = new Map(next.map((model) => [model.id, model] as const));
        if (currentModel && !unique.has(currentModel)) {
          unique.set(currentModel, { id: currentModel, label: currentModel });
        }
        setModels([...unique.values()]);
      })
      .catch(() => {
        if (live) setLoadError(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [backend, currentModel, status?.availableModels]);

  useEffect(() => {
    if (currentModel) setManualModel(currentModel);
  }, [currentModel]);

  const activateManual = () => {
    const model = manualModel.trim();
    if (model) void onActivate(backend, model, false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
      <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{t("settings.byok.model_label")}</div>
      <div style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.5 }}>
        {locale === "ko"
          ? "공급자의 실시간 모델 목록입니다. 새 모델은 앱 업데이트 없이 나타나며, 목록이 없으면 아래에 모델 ID를 직접 입력하세요."
          : "Live provider catalog. New models appear without an app update; enter a model ID below when a provider exposes no catalog."}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {models.map((m) => {
          const isCurrent = currentModel === m.id;
          return (
            <button
              key={m.id}
              onClick={() => void onActivate(backend, m.id, false)}
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
            </button>
          );
        })}
      </div>
      {loading && <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{locale === "ko" ? "모델 목록을 읽는 중…" : "Loading model catalog…"}</div>}
      {!loading && models.length === 0 && (
        <div style={{ fontSize: 11, color: loadError ? "var(--red-deep)" : "var(--muted-deep)" }}>
          {locale === "ko" ? "이 공급자는 모델 목록을 주지 않았습니다. 모델 ID를 직접 입력하세요." : "This provider did not return a model catalog. Enter a model ID manually."}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={manualModel}
          onChange={(event) => setManualModel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              activateManual();
            }
          }}
          placeholder={locale === "ko" ? "모델 ID 직접 입력" : "Enter model ID"}
          style={{
            flex: 1,
            minWidth: 180,
            padding: "8px 10px",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            background: "var(--paper-2)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        />
        <button
          type="button"
          onClick={activateManual}
          disabled={!manualModel.trim()}
          style={{
            padding: "8px 12px",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
            color: "var(--ink)",
            fontSize: 12,
            fontWeight: 700,
            opacity: manualModel.trim() ? 1 : 0.5,
          }}
        >
          {locale === "ko" ? "이 모델 사용" : "Use model"}
        </button>
      </div>
    </div>
  );
}

// ── Desktop local-runtime lifetime ─────────────────────────
function LaunchdPanel() {
  const { t } = useT();
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
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--green-deep)", flexShrink: 0 }}>
          {t("settings.launchd.on")}
        </span>
      </div>
    </>
  );
}

// ── 터미널 프로필(사용자 편집형 CLI 러너) — Paseo식 "프로바이더" ──────────
// 하드코딩된 claude/codex/antigravity 외에, 사용자가 임의 CLI를 등록·편집한다.
// template의 {{{prompt}}}가 메시지로 치환돼 실행된다(예: `claude {{{prompt}}}`).
// ★런타임 dispatch(RuntimeKind 편입)는 후속 단계 — 이 패널은 저장/조회만 담당.
const TP_PRESETS: Array<{ name: string; template: string }> = [
  { name: "Claude Code", template: "claude {{{prompt}}}" },
  { name: "Codex", template: "codex {{{prompt}}}" },
  { name: "Antigravity", template: "agy --prompt {{{prompt}}}" },
];

// ACP(Agent Client Protocol) 프리셋 — 실행 명령은 agentclientprotocol/registry(2026-08-15) 실물 기준.
// 이 모드의 프로필은 저장 즉시 엔진 선택에 kind "acp"로 나타난다(PRD 2026-08-15 B-1).
/**
 * 접이식 연결 섹션 (오너 결정 2026-08-18).
 *
 * 연결 대상이 18개까지 늘면서 한 줄로 늘어놓는 방식은 "무엇을 골라야 하는가"에
 * 답하지 못했다. 두 섹션이 그 질문에 바로 답한다:
 *   · 구독 모델 — 이미 내고 있는 구독으로 추가 비용 없이 (기본 펼침)
 *   · API 모델 — 종량제 키로 (기본 접힘)
 * 구독을 먼저 펼치는 이유: 대부분의 사용자에게 돈이 덜 드는 길이고, 우리가 CLI를
 * 백그라운드로 띄우는 이유 자체가 그 구독 인증이기 때문이다.
 */
function ConnectSection({
  title,
  hint,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ margin: "32px 0 0" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          border: "1px solid var(--paper-edge)",
          borderRadius: "var(--radius-md)",
          background: "var(--paper)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transition: "transform 120ms ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            fontSize: 11,
            color: "var(--muted-deep)",
          }}
        >
          ▶
        </span>
        <span style={{ fontFamily: "var(--font-head)", fontSize: 15, flex: 1, minWidth: 0 }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{count}</span>
      </button>
      {open && (
        <div style={{ padding: "12px 0 0" }}>
          <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px", lineHeight: 1.6 }}>{hint}</p>
          {children}
        </div>
      )}
    </section>
  );
}

// 오너 결정(2026-08-18): 프리셋은 **자체 모델·구독을 가진 제공자**만 남긴다.
// 사용자의 API 키를 중개할 뿐인 껍데기 런타임(OpenCode·Goose·Kilo·Cline)은 우리가
// BYOK로 직접 부르는 것과 결과가 같아 고를 이유가 없고, 목록에 있으면 "무엇을 골라야
// 하나"만 흐린다. Copilot은 구독 섹션(CLI 설치 패널)으로 승격돼 여기서는 뺀다.
// 임의 ACP 에이전트를 붙이는 자리는 그대로 열려 있다 — 그건 사용자가 추가하는 것이다.
const TP_ACP_PRESETS: Array<{ name: string; command: string; args: string[] }> = [
  { name: "Qwen Code", command: "npx", args: ["-y", "@qwen-code/qwen-code@0.21.12", "--acp", "--experimental-skills"] },
  { name: "Gemini CLI (enterprise)", command: "gemini", args: ["--acp"] },
];

function splitArgs(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

function TerminalProfilesPanel() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [profiles, setProfiles] = useState<TerminalProfile[] | null>(null);
  const [editing, setEditing] = useState<TerminalProfile | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.config.getTerminalProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const list = profiles ?? [];

  async function persist(next: TerminalProfile[]) {
    const api = ipc();
    if (!api) return;
    // setter가 정제한 목록을 되돌려준다({{{prompt}}} 없는 항목은 서버가 제거) — 그걸 신뢰.
    const saved = await api.config.setTerminalProfiles(next);
    setProfiles(saved);
  }

  function startAdd() {
    setErr("");
    setEditing({ id: `tp-${crypto.randomUUID()}`, name: "", template: "", enabled: true, mode: "acp", acp: { command: "", args: [] } });
  }
  async function saveEditing() {
    if (!editing) return;
    const name = editing.name.trim();
    const template = editing.template.trim();
    const isAcp = editing.mode === "acp";
    if (!name) { setErr(ko ? "이름을 입력하세요." : "Enter a name."); return; }
    if (isAcp) {
      if (!editing.acp?.command?.trim()) {
        setErr(ko ? "ACP 실행 명령을 입력하세요 (예: gemini)." : "Enter the ACP command (e.g. gemini).");
        return;
      }
    } else if (!template.includes("{{{prompt}}}")) {
      setErr(ko
        ? "명령 템플릿에 {{{prompt}}} 를 반드시 포함하세요 — 메시지가 들어갈 자리입니다."
        : "The command template must contain {{{prompt}}} — that is where the message goes.");
      return;
    }
    const cleaned: TerminalProfile = isAcp
      ? { ...editing, name, template, mode: "acp", acp: { command: editing.acp!.command.trim(), args: editing.acp?.args ?? [] } }
      : { ...editing, name, template, mode: "template" };
    const exists = list.some((p) => p.id === cleaned.id);
    const next = exists ? list.map((p) => (p.id === cleaned.id ? cleaned : p)) : [...list, cleaned];
    await persist(next);
    setEditing(null);
    setErr("");
  }
  async function remove(id: string) { await persist(list.filter((p) => p.id !== id)); }
  async function toggle(id: string) {
    await persist(list.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)));
  }
  async function move(id: string, dir: -1 | 1) {
    const idx = list.findIndex((p) => p.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const next = [...list];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    await persist(next);
  }

  const chip = (bg: string, color: string): CSSProperties => ({
    fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 8,
    border: "1px solid var(--paper-edge)", background: bg, color, cursor: "pointer", flexShrink: 0,
  });
  const inputStyle: CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 12.5,
    border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)",
  };

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
        {ko ? "터미널 프로필" : "Terminal profiles"}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 8px", lineHeight: 1.55 }}>
        {ko
          ? "임의의 CLI를 러너 프로필로 등록합니다. 명령 템플릿의 {{{prompt}}} 자리에 메시지가 치환됩니다. 내장 엔진(Claude·Codex·Antigravity) 외에 원하는 도구를 자유롭게 정의하세요."
          : "Register any CLI as a runner profile. The message is substituted into the {{{prompt}}} slot of the command template. Define whatever tool you want beyond the built-in engines (Claude, Codex, Antigravity)."}
      </p>
      <p style={{ fontSize: 11, color: "var(--muted-deep)", margin: "0 0 12px", opacity: 0.85 }}>
        {ko
          ? "※ ACP 모드 프로필은 저장 즉시 엔진 선택에 나타나 실제 실행 러너가 됩니다(도구 호출·사고 신호 표준 표시). 명령 템플릿 모드는 아직 저장만 지원합니다."
          : "※ ACP-mode profiles become real execution runners as soon as they are saved (standard tool-call and thinking signals). Command-template mode is still save-only."}
      </p>

      <div style={{ border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", overflow: "hidden" }}>
        {list.length === 0 && !editing && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--muted-deep)", textAlign: "center" }}>
            {ko ? "등록된 프로필이 없습니다." : "No profiles yet."}
          </div>
        )}

        {list.map((p, i) => (
          <div key={p.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            borderTop: i === 0 ? "none" : "1px solid var(--paper-edge)",
            opacity: p.enabled ? 1 : 0.5,
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <button type="button" aria-label="up" disabled={i === 0} onClick={() => void move(p.id, -1)}
                style={{ fontSize: 9, lineHeight: 1, padding: "1px 4px", border: "none", background: "none", color: i === 0 ? "var(--paper-edge)" : "var(--muted-deep)", cursor: i === 0 ? "default" : "pointer" }}>▲</button>
              <button type="button" aria-label="down" disabled={i === list.length - 1} onClick={() => void move(p.id, 1)}
                style={{ fontSize: 9, lineHeight: 1, padding: "1px 4px", border: "none", background: "none", color: i === list.length - 1 ? "var(--paper-edge)" : "var(--muted-deep)", cursor: i === list.length - 1 ? "default" : "pointer" }}>▼</button>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{p.name}</div>
              <code style={{ fontSize: 11.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono, monospace)", wordBreak: "break-all" }}>
                {p.mode === "acp" ? `ACP · ${[p.acp?.command ?? "", ...(p.acp?.args ?? [])].join(" ")}` : p.template}
              </code>
            </div>
            <button type="button" onClick={() => void toggle(p.id)}
              style={chip(p.enabled ? "var(--fill-1)" : "var(--paper-2)", p.enabled ? "var(--accent)" : "var(--muted-deep)")}>
              {p.enabled ? (ko ? "켜짐" : "On") : (ko ? "꺼짐" : "Off")}
            </button>
            <button type="button" onClick={() => { setErr(""); setEditing({ ...p }); }} style={chip("var(--paper-2)", "var(--ink)")}>
              {ko ? "편집" : "Edit"}
            </button>
            <button type="button" onClick={() => void remove(p.id)} style={chip("var(--paper-2)", "var(--red-deep, var(--danger))")}>
              {ko ? "삭제" : "Delete"}
            </button>
          </div>
        ))}

        {editing && (
          <div style={{ padding: 14, borderTop: list.length ? "1px solid var(--paper-edge)" : "none", background: "var(--paper-2)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)" }}>
                {ko ? "이름" : "Name"}
                <input value={editing.name} placeholder={ko ? "예: 내 CLI" : "e.g. My CLI"}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  style={{ ...inputStyle, marginTop: 5 }} />
              </label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)" }}>{ko ? "모드" : "Mode"}</span>
                <button type="button" onClick={() => setEditing({ ...editing, mode: "acp", acp: editing.acp ?? { command: "", args: [] } })}
                  style={chip(editing.mode === "acp" ? "var(--fill-1)" : "var(--paper)", editing.mode === "acp" ? "var(--accent)" : "var(--ink-soft)")}>
                  {ko ? "ACP 에이전트 (권장)" : "ACP agent (recommended)"}
                </button>
                <button type="button" onClick={() => setEditing({ ...editing, mode: "template" })}
                  style={chip(editing.mode !== "acp" ? "var(--fill-1)" : "var(--paper)", editing.mode !== "acp" ? "var(--accent)" : "var(--ink-soft)")}>
                  {ko ? "명령 템플릿" : "Command template"}
                </button>
              </div>
              {editing.mode === "acp" ? (
                <>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)" }}>
                    {ko ? "실행 명령" : "Command"}
                    <input value={editing.acp?.command ?? ""} placeholder="gemini" spellCheck={false}
                      onChange={(e) => setEditing({ ...editing, acp: { command: e.target.value, args: editing.acp?.args ?? [] } })}
                      style={{ ...inputStyle, marginTop: 5, fontFamily: "var(--font-mono, monospace)" }} />
                  </label>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)" }}>
                    {ko ? "인자 (공백 구분)" : "Arguments (space separated)"}
                    <input value={(editing.acp?.args ?? []).join(" ")} placeholder="acp" spellCheck={false}
                      onChange={(e) => setEditing({ ...editing, acp: { command: editing.acp?.command ?? "", args: splitArgs(e.target.value) } })}
                      style={{ ...inputStyle, marginTop: 5, fontFamily: "var(--font-mono, monospace)" }} />
                  </label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{ko ? "예시:" : "Presets:"}</span>
                    {TP_ACP_PRESETS.map((preset) => (
                      <button key={preset.name} type="button"
                        onClick={() => setEditing({ ...editing, name: editing.name || preset.name, mode: "acp", acp: { command: preset.command, args: preset.args } })}
                        style={chip("var(--paper)", "var(--ink-soft)")}>{preset.name}</button>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: "var(--muted-deep)", margin: 0, lineHeight: 1.5 }}>
                    {ko
                      ? "에이전트 자체 로그인 세션을 그대로 씁니다(키를 새로 받지 않음). 저장 후 엔진 선택 목록에 이 이름으로 나타나며, 모델 목록은 에이전트가 ACP로 직접 알려줍니다."
                      : "Uses the agent's own login session (no new keys). After saving it appears under this name in the engine picker; the model list comes from the agent over ACP."}
                  </p>
                </>
              ) : (
                <>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)" }}>
                    {ko ? "명령 템플릿" : "Command template"}
                    <input value={editing.template} placeholder="claude {{{prompt}}}" spellCheck={false}
                      onChange={(e) => setEditing({ ...editing, template: e.target.value })}
                      style={{ ...inputStyle, marginTop: 5, fontFamily: "var(--font-mono, monospace)" }} />
                  </label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{ko ? "예시:" : "Presets:"}</span>
                    {TP_PRESETS.map((preset) => (
                      <button key={preset.name} type="button"
                        onClick={() => setEditing({ ...editing, name: editing.name || preset.name, template: preset.template })}
                        style={chip("var(--paper)", "var(--ink-soft)")}>{preset.name}</button>
                    ))}
                  </div>
                </>
              )}
              {err && <div style={{ fontSize: 11.5, color: "var(--red-deep, var(--danger))" }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => { setEditing(null); setErr(""); }} style={chip("var(--paper)", "var(--muted-deep)")}>
                  {ko ? "취소" : "Cancel"}
                </button>
                <button type="button" onClick={() => void saveEditing()}
                  style={{ ...chip("var(--accent)", "var(--white)"), padding: "6px 14px" }}>
                  {ko ? "저장" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!editing && (
        <button type="button" onClick={startAdd}
          style={{
            marginTop: 10, padding: "8px 14px", borderRadius: "var(--radius-md)", fontSize: 12, fontWeight: 700,
            border: "1px dashed var(--paper-edge)", background: "var(--paper)", color: "var(--ink)", cursor: "pointer",
          }}>
          + {ko ? "프로필 추가" : "Add profile"}
        </button>
      )}
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
// 구독 모델 — 이미 내고 있는 구독으로 추가 비용 없이 쓰는 CLI 제공자.
// 판단 기준(오너 결정 2026-08-18): "그 CLI를 통해야만 얻는 것" = 구독 인증.
// 실행되는 런타임과 이 목록은 반드시 일치해야 한다 — 예전에는 grok·cursor가 실제로
// 실행되는데 이 패널에 없어서, 사용자가 설치·로그인할 방법이 화면에 없었다.
type CliKind = "claude-code" | "codex" | "antigravity" | "kimi" | "grok" | "cursor" | "github-copilot-cli";
/**
 * `setup`은 이 CLI를 실제로 쓸 수 있게 만드는 방법이다 — 버튼이 하는 일과 반드시 일치해야 한다.
 *  - install: 우리가 관리 npm으로 설치한다(설치 후 로그인 버튼)
 *  - login:   이미 배포된 앱이라 로그인만 연다(Antigravity)
 *  - manual:  우리가 대신 설치할 수 없다 — 정확한 명령을 보여주고 사용자가 실행한다
 *             (예전에는 이런 CLI가 목록에 아예 없어서, 실행은 되는데 화면에 길이 없었다)
 */
type CliSetup = "install" | "login" | "manual";
const CLI_DEFS: Array<{ kind: CliKind; name: string; sub: string; setup: CliSetup; manual?: string }> = [
  { kind: "claude-code", name: "Claude Code", sub: "Claude Pro · Max", setup: "install" },
  { kind: "codex", name: "Codex", sub: "ChatGPT Plus · Pro", setup: "install" },
  { kind: "antigravity", name: "Antigravity", sub: "Google AI subscription", setup: "login" },
  { kind: "grok", name: "Grok", sub: "X Premium · xAI", setup: "install" },
  { kind: "kimi", name: "Kimi Code", sub: "Kimi Code membership", setup: "install" },
  // Cursor의 공식 배포는 설치 스크립트다. 우리가 대신 실행하지 않고 명령만 보여준다.
  { kind: "cursor", name: "Cursor", sub: "Cursor Pro", setup: "manual", manual: "curl https://cursor.com/install -fsS | bash" },
  // Copilot CLI는 npx로 실행되므로 설치가 필요 없다. 필요한 것은 GitHub 인증뿐.
  { kind: "github-copilot-cli", name: "GitHub Copilot CLI", sub: "GitHub Copilot subscription", setup: "manual", manual: "gh auth login" },
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
  // copilot은 전용 kind가 없고 kind "acp"의 acpAgentId로 감지된다 — 그 신원까지 봐야
  // "설치됨"이 실제와 맞는다(kind만 보면 설치해 놓고도 영원히 미설치로 보인다).
  const installedKinds = new Set<string>([
    ...statuses.map((s) => s.kind),
    ...statuses.flatMap((s) => (s.kind === "acp" && s.acpAgentId ? [s.acpAgentId] : [])),
  ]);

  async function doInstall(kind: CliKind) {
    const api = ipc();
    if (!api) return;
    setInstalling(kind);
    setMsg((m) => ({ ...m, [kind]: "" }));
    const def = CLI_DEFS.find((entry) => entry.kind === kind);
    if (def?.setup === "manual") {
      // 우리가 대신 설치할 수 없는 CLI — 정확한 명령을 보여주고 사용자가 실행한다.
      setMsg((m) => ({ ...m, [kind]: def.manual ?? "" }));
      setInstalling(null);
      return;
    }
    try {
      const r = def?.setup === "login"
        ? await api.runtime.openCliLogin(kind as "antigravity")
        : await api.runtime.installCli(kind as "claude-code" | "codex" | "kimi" | "grok");
      if (r.ok) {
        setMsg((m) => ({ ...m, [kind]: def?.setup === "login" ? t("settings.cli.login_hint") : t("settings.cli.install_ok") }));
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
    const def = CLI_DEFS.find((entry) => entry.kind === kind);
    if (def?.setup === "manual") {
      setMsg((m) => ({ ...m, [kind]: def.manual ?? "" }));
      return;
    }
    try {
      await api.runtime.openCliLogin(kind as "claude-code" | "codex" | "kimi" | "grok" | "antigravity");
      setMsg((m) => ({ ...m, [kind]: t("settings.cli.login_hint") }));
    } catch (err) {
      setMsg((m) => ({ ...m, [kind]: `${t("settings.cli.login_hint")} ${String(err)}` }));
    }
  }

  return (
    <>
      <ConnectSection
        title={t("settings.cli.subscription_title")}
        hint={t("settings.cli.note")}
        count={CLI_DEFS.length}
        defaultOpen
      >
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
                    {isInstalling
                      ? t("settings.cli.installing")
                      : def.kind === "antigravity" ? t("settings.cli.login") : t("settings.cli.install")}
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
      </ConnectSection>
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
