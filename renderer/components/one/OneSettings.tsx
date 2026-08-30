"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconApps,
  IconArrowLeft,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconImage,
  IconKey,
  IconLayers,
  IconLock,
  IconRoute,
  IconSettings,
  IconShield,
  IconSparkles,
  IconUsers,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import {
  AUTO_PROVIDER,
  DEFAULT_MULTIMODAL_SETTINGS,
  MULTIMODAL_PROVIDERS,
  type MultimodalModality,
  type MultimodalProvider,
  type MultimodalProviderStatus,
  type MultimodalSettings,
} from "@shared/multimodal";
import type {
  AgentConcurrencyInfo,
  InstalledMcpServer,
  McpServerStatus,
  McpToolCatalogEntry,
  RuntimeStatus,
} from "@shared/types";
import type { ComputerHistoryState } from "@shared/computer-history";
import type { OneBriefingCadence, OneBriefingPreferences } from "@shared/one-briefing";
import type { OneComposerModelOption, OnePermissionMode } from "./OneComposerControls";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import { OneBottomSheet, type OneBottomSheetSize } from "./OneBottomSheet";
import { MediaDisplaySettings } from "../MediaDisplaySettings";
import styles from "./OneSettings.module.css";

export type OneSettingsKey = "mcp" | "plugins" | "permission" | "models" | "multimodal" | "media" | "concurrency" | "history" | "briefing";

/**
 * 시트 폭은 내용이 정한다.
 *
 * 예전에는 항목과 무관하게 전부 `wide`(1120px)로 열려서, 스위치 두 개짜리 설정도 도구 목록과
 * 같은 폭을 차지했다 — 라벨과 컨트롤이 화면 양 끝으로 벌어져 읽기 어려웠다(2026-08-23 지적).
 * 여러 열로 늘어놓을 것이 있는 화면만 넓게 연다.
 */
const SHEET_WIDTH: Record<OneSettingsKey, OneBottomSheetSize> = {
  mcp: "wide",
  plugins: "wide",
  models: "wide",
  multimodal: "wide",
  media: "compact",
  permission: "compact",
  concurrency: "compact",
  history: "compact",
  briefing: "compact",
};

type RailProps = {
  locale: string;
  profileName: string;
  pendingMemoryCount: number;
  onBack: () => void;
  onOpen: (key: OneSettingsKey) => void;
  onOpenProfile: () => void;
  onOpenMemory: () => void;
  onToggleLocale: () => void;
};

type SheetProps = {
  open: OneSettingsKey | null;
  locale: string;
  installedPlugins: InstalledMcpServer[];
  pluginCatalog: McpToolCatalogEntry[];
  pluginStatuses: McpServerStatus[];
  permission: OnePermissionMode;
  runtime: RuntimeStatus | null;
  models: OneComposerModelOption[];
  history: ComputerHistoryState | null;
  onClose: () => void;
  onTogglePlugin: (id: string, enabled: boolean) => Promise<void>;
  onSelectPermission: (permission: OnePermissionMode) => void;
  onSelectModel: (runtime: RuntimeStatus, model: string) => Promise<void>;
  onHistoryConsent: (enabled: boolean) => Promise<void>;
  onOpenMcpLibrary: () => void;
  onToolTabChange: (tab: "plugins" | "mcp") => void;
};

const SETTINGS_META: Record<OneSettingsKey, { titleKo: string; titleEn: string; descriptionKo: string; descriptionEn: string }> = {
  mcp: { titleKo: "MCP 서버", titleEn: "MCP servers", descriptionKo: "직접 등록한 MCP 서버의 연결과 실행 상태를 관리합니다.", descriptionEn: "Manage connections and runtime state for custom MCP servers." },
  briefing: { titleKo: "브리핑 알림", titleEn: "Briefing notifications", descriptionKo: "One이 먼저 알려 주는 빈도와 방식, 방해 금지 시간을 정합니다.", descriptionEn: "Choose how often One reaches out, where it shows up, and when to stay quiet." },
  plugins: { titleKo: "플러그인", titleEn: "Plugins", descriptionKo: "카탈로그에서 설치한 도구를 켜거나 끕니다.", descriptionEn: "Enable or disable tools installed from the catalog." },
  permission: { titleKo: "실행 권한", titleEn: "Execution permission", descriptionKo: "One이 대화와 작업에서 사용할 기본 권한을 정합니다.", descriptionEn: "Choose One's default authority for conversations and work." },
  models: { titleKo: "모델", titleEn: "Models", descriptionKo: "CEO 오케스트레이터인 One의 기본 모델을 정합니다.", descriptionEn: "Choose the default model for One, the CEO orchestrator." },
  multimodal: { titleKo: "멀티모달", titleEn: "Multimodal", descriptionKo: "이미지·영상 작업에 사용할 엔진과 키를 연결합니다.", descriptionEn: "Connect engines and keys for image and video work." },
  media: { titleKo: "결과 미디어", titleEn: "Result media", descriptionKo: "사이드바 결과에서 사진·영상·음성을 표시할지 정합니다.", descriptionEn: "Choose which photos, videos, and audio appear in result sidebars." },
  concurrency: { titleKo: "동시 실행", titleEn: "Concurrency", descriptionKo: "One과 터미널 에이전트가 동시에 사용할 수 있는 슬롯 수입니다.", descriptionEn: "Set how many slots One and terminal agents may use at once." },
  /* ko 라벨은 웹 "컴퓨터 사용 기록" 과 통일(A3) — 채널마다 같은 설정이 다른
     이름으로 불리면 안 된다. */
  history: { titleKo: "컴퓨터 사용 기록", titleEn: "Computer History", descriptionKo: "로컬 작업 요약과 에이전트 빌드 추천의 기록 범위를 관리합니다.", descriptionEn: "Manage local work summaries and agent-build recommendations." },
};

const PERMISSIONS: Array<{ id: OnePermissionMode; ko: string; en: string; detailKo: string; detailEn: string }> = [
  { id: "auto", ko: "자동 모드", en: "Auto mode", detailKo: "대화는 읽기, 작업은 파일 편집으로 판단하고 실제 적용 권한을 Activity에 남깁니다.", detailEn: "Uses read for conversation and file editing for work, recording the effective mode in Activity." },
  { id: "read", ko: "읽기 전용", en: "Read only", detailKo: "파일이나 외부 상태를 바꾸지 않습니다.", detailEn: "Does not change files or external state." },
  { id: "write", ko: "파일 편집", en: "File editing", detailKo: "현재 작업 폴더의 파일 편집을 허용합니다.", detailEn: "Allows edits in the current workspace." },
  { id: "full", ko: "전체 액세스", en: "Full access", detailKo: "로컬 파일, 명령, 네트워크와 연결된 도구 실행을 허용합니다.", detailEn: "Allows local files, commands, network, and connected tools." },
];

function RailRow({ icon, title, detail, badge, onClick }: { icon: ReactNode; title: string; detail?: string; badge?: string; onClick: () => void }) {
  return <button type="button" className={styles.railRow} onClick={onClick}>
    <span className={styles.railIcon}>{icon}</span>
    <span className={styles.railCopy}><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    {badge && <span className={styles.railBadge}>{badge}</span>}
    <IconChevronRight size={13} />
  </button>;
}

export function OneSettingsRail({ locale, profileName, pendingMemoryCount, onBack, onOpen, onOpenProfile, onOpenMemory, onToggleLocale }: RailProps) {
  const ko = locale === "ko";
  return <section className={styles.railRoot} aria-label={ko ? "One 설정" : "One settings"}>
    <header className={styles.railHeader}>
      <button type="button" onClick={onBack} aria-label={ko ? "조직도로 돌아가기" : "Back to organisation"}><IconArrowLeft size={16} /></button>
      <div><strong>{ko ? "설정" : "Settings"}</strong><small>{ko ? "One과 조직의 실행 환경" : "One and organisation runtime"}</small></div>
    </header>
    <div className={styles.railScroll}>
      <div className={styles.railGroup}><span>{ko ? "One" : "One"}</span>
        <RailRow icon={<IconUsers size={15} />} title={ko ? `프로필 · ${profileName}` : `Profile · ${profileName}`} onClick={onOpenProfile} />
        <RailRow icon={<IconBrain size={15} />} title={ko ? "메모리" : "Memory"} badge={pendingMemoryCount > 0 ? String(pendingMemoryCount) : undefined} onClick={onOpenMemory} />
      </div>
      <div className={styles.railGroup}><span>{ko ? "도구" : "Tools"}</span>
        <RailRow icon={<IconRoute size={15} />} title="MCP" detail={ko ? "직접 등록한 서버" : "Custom servers"} onClick={() => onOpen("mcp")} />
        <RailRow icon={<IconLayers size={15} />} title={ko ? "플러그인" : "Plugins"} detail={ko ? "설치한 연결 도구" : "Installed tools"} onClick={() => onOpen("plugins")} />
      </div>
      <div className={styles.railGroup}><span>{ko ? "실행" : "Execution"}</span>
        <RailRow icon={<IconShield size={15} />} title={ko ? "권한" : "Permission"} onClick={() => onOpen("permission")} />
        <RailRow icon={<IconSparkles size={15} />} title={ko ? "모델" : "Models"} detail={ko ? "One CEO 기본 모델" : "One CEO default"} onClick={() => onOpen("models")} />
        <RailRow icon={<IconImage size={15} />} title={ko ? "멀티모달" : "Multimodal"} onClick={() => onOpen("multimodal")} />
        <RailRow icon={<IconImage size={15} />} title={ko ? "결과 미디어" : "Result media"} detail={ko ? "사이드바에 표시" : "Show in sidebars"} onClick={() => onOpen("media")} />
        <RailRow icon={<IconApps size={15} />} title={ko ? "동시 실행" : "Concurrency"} onClick={() => onOpen("concurrency")} />
      </div>
      <div className={styles.railGroup}><span>{ko ? "알림" : "Notifications"}</span>
        <RailRow icon={<IconSparkles size={15} />} title={ko ? "브리핑" : "Briefing"} detail={ko ? "주기·데스크탑 알림·방해 금지" : "Cadence, desktop alerts, quiet hours"} onClick={() => onOpen("briefing")} />
      </div>
      <div className={styles.railGroup}><span>{ko ? "개인정보" : "Privacy"}</span>
        <RailRow icon={<IconLock size={15} />} title={ko ? "컴퓨터 사용 기록" : "Computer History"} onClick={() => onOpen("history")} />
      </div>
      <div className={styles.railGroup}><span>{ko ? "앱" : "App"}</span>
        <RailRow icon={<IconSettings size={15} />} title={ko ? "언어" : "Language"} detail={ko ? "English로 전환" : "한국어로 전환"} onClick={onToggleLocale} />
      </div>
    </div>
  </section>;
}

function ToolRows({ items, catalog, statuses, locale, onToggle, empty }: { items: InstalledMcpServer[]; catalog: McpToolCatalogEntry[]; statuses: McpServerStatus[]; locale: string; onToggle: (id: string, enabled: boolean) => Promise<void>; empty: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (items.length === 0) return <div className={styles.emptyState}>{empty}</div>;
  return <div className={styles.settingList}>{items.map((item) => {
    const catalogItem = catalog.find((entry) => entry.id === item.catalogId);
    const status = statuses.find((entry) => entry.id === item.id);
    const ready = item.configurationValid !== false && !status?.missingEnv.length;
    return <div className={styles.toolRow} key={item.id}>
      <span className={styles.toolMark}>{catalogItem?.mark || item.name.slice(0, 1).toLocaleUpperCase()}</span>
      <div><strong>{locale === "ko" ? item.name || item.nameEn : item.nameEn || item.name}</strong><small>{ready ? (status?.connected === false ? (locale === "ko" ? "연결 확인 필요" : "Connection check needed") : (locale === "ko" ? "사용 가능" : "Ready")) : (locale === "ko" ? `설정 필요${status?.missingEnv.length ? ` · ${status.missingEnv.join(", ")}` : ""}` : "Setup required")}</small></div>
      <button type="button" className={styles.switch} data-on={item.enabled ? "true" : "false"} disabled={busyId === item.id} onClick={async () => { setBusyId(item.id); try { await onToggle(item.id, !item.enabled); } finally { setBusyId(null); } }} aria-label={`${item.name} ${locale === "ko" ? (item.enabled ? "끄기" : "켜기") : (item.enabled ? "turn off" : "turn on")}`}><span /></button>
    </div>;
  })}</div>;
}

function PermissionSettings({ locale, value, onChange }: { locale: string; value: OnePermissionMode; onChange: (value: OnePermissionMode) => void }) {
  return <div className={styles.choiceList}>{PERMISSIONS.map((item) => <button type="button" key={item.id} data-active={value === item.id ? "true" : "false"} onClick={() => onChange(item.id)}>
    <span><strong>{locale === "ko" ? item.ko : item.en}</strong><small>{locale === "ko" ? item.detailKo : item.detailEn}</small></span>
    {value === item.id && <IconCheck size={15} />}
  </button>)}</div>;
}

function ModelSettings({ locale, runtime, models, onSelect }: { locale: string; runtime: RuntimeStatus | null; models: OneComposerModelOption[]; onSelect: (runtime: RuntimeStatus, model: string) => Promise<void> }) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const options = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((item) => {
      const key = `${item.runtime.kind}:${item.runtime.backend}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [models]);
  const choose = async (nextRuntime: RuntimeStatus, model: string) => {
    const key = `${nextRuntime.kind}:${nextRuntime.backend}:${model || "default"}`;
    setBusyKey(key);
    try { await onSelect(nextRuntime, model); } finally { setBusyKey(null); }
  };
  return <>
    <div className={styles.policyNote}><IconSparkles size={16} /><div><strong>{locale === "ko" ? "직원 모델은 자동 배정" : "Worker models stay automatic"}</strong><span>{locale === "ko" ? "직원을 추가할 때 모델을 강제하지 않습니다. 에이전트 패키지의 선호 백엔드와 작업 조건을 One이 조합합니다. 여기서는 CEO 오케스트레이터 모델만 지정합니다." : "Hiring does not force a model. One combines the package's preferred backend with task requirements. This setting controls the CEO orchestrator only."}</span></div></div>
    {!runtime ? <div className={styles.emptyState}>{locale === "ko" ? "사용 가능한 런타임을 확인하는 중입니다." : "Checking available runtimes."}</div> : <div className={styles.choiceList}>
      {runtimeUsesEngineModelSetting(runtime.kind) && <button type="button" data-active={!runtime.model ? "true" : "false"} disabled={busyKey !== null} onClick={() => void choose(runtime, "")}><span><strong>{runtimeModelFallbackLabel(runtime.kind, locale === "ko" ? "ko" : "en")}</strong><small>{runtime.label || runtime.kind} · {runtime.backend}</small></span>{!runtime.model && <IconCheck size={15} />}</button>}
      {options.map((item) => {
        const active = runtime.kind === item.runtime.kind && runtime.backend === item.runtime.backend && runtime.model === item.id;
        return <button type="button" key={`${item.runtime.kind}:${item.runtime.backend}:${item.id}`} data-active={active ? "true" : "false"} disabled={busyKey !== null} onClick={() => void choose(item.runtime, item.id)}><span><strong>{item.label}</strong><small>{item.tag || `${item.runtime.kind} · ${item.runtime.backend}`}</small></span>{active && <IconCheck size={15} />}</button>;
      })}
    </div>}
  </>;
}

function MultimodalSettingsPanel({ locale, active }: { locale: string; active: boolean }) {
  const [providers, setProviders] = useState<MultimodalProvider[]>(MULTIMODAL_PROVIDERS);
  const [settings, setSettings] = useState<MultimodalSettings>(DEFAULT_MULTIMODAL_SETTINGS);
  const [statuses, setStatuses] = useState<MultimodalProviderStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.multimodal.listProviders(), api.multimodal.getSettings(), api.multimodal.status()]).then(([nextProviders, nextSettings, nextStatuses]) => {
      if (cancelled) return;
      setProviders(nextProviders); setSettings(nextSettings); setStatuses(nextStatuses); setNotice(null);
    }).catch(() => { if (!cancelled) setNotice(locale === "ko" ? "일부 연결 상태를 불러오지 못했습니다. 저장된 설정은 유지됩니다." : "Some connection status could not be loaded. Saved settings are unchanged."); });
    return () => { cancelled = true; };
  }, [active, locale]);
  const selectedFor = (modality: MultimodalModality) => modality === "image" ? settings.imageProvider : modality === "video" ? settings.videoProvider : settings.audioProvider;
  const select = async (modality: MultimodalModality, providerId: string) => {
    const patch = modality === "image" ? { imageProvider: providerId } : modality === "video" ? { videoProvider: providerId } : { audioProvider: providerId };
    const api = ipc();
    if (!api) {
      setNotice(locale === "ko" ? "Desktop에 연결되지 않아 저장하지 못했습니다. 이전 설정을 유지합니다." : "Could not save because Desktop is unavailable. The prior setting remains.");
      return;
    }
    setBusy(true);
    try {
      const next = await api.multimodal.saveSettings({ ...settings, ...patch });
      const acknowledged = modality === "image" ? next?.imageProvider : modality === "video" ? next?.videoProvider : next?.audioProvider;
      if (acknowledged !== providerId) throw new Error("multimodal_settings_receipt_mismatch");
      setSettings(next);
      setNotice(locale === "ko" ? "저장했습니다." : "Saved.");
      try {
        setStatuses(await api.multimodal.status());
      } catch {
        setNotice(locale === "ko"
          ? "설정은 저장했지만 연결 상태를 새로고침하지 못했습니다. 다시 저장하지 말고 이 화면만 다시 열어 주세요."
          : "The setting was saved, but connection status could not refresh. Do not save again; reopen this panel instead.");
      }
    } catch {
      try {
        const readback = await api.multimodal.getSettings();
        const actual = modality === "image" ? readback.imageProvider : modality === "video" ? readback.videoProvider : readback.audioProvider;
        setSettings(readback);
        if (actual === providerId) {
          setNotice(locale === "ko" ? "요청한 엔진 설정이 저장된 것을 다시 확인했습니다." : "Verified that the requested engine setting was saved.");
        } else if (actual === selectedFor(modality)) {
          setNotice(locale === "ko" ? "변경이 반영되지 않아 이전 엔진 설정을 유지합니다." : "The change was not applied, so the prior engine setting remains active.");
        } else {
          setNotice(locale === "ko" ? "요청과 다른 실제 엔진 설정을 다시 읽어 화면에 반영했습니다." : "An actual engine setting different from the request was read back and is now shown.");
        }
      } catch {
        setNotice(locale === "ko"
          ? "저장 요청 뒤 실제 엔진 설정을 확인하지 못했습니다. 화면은 이전 설정을 유지합니다. 반복 저장하지 말고 이 패널을 다시 열어 확인해 주세요."
          : "The actual engine setting could not be read after the save request. This screen keeps the prior setting. Do not save again; reopen this panel to check it.");
      }
    }
    finally { setBusy(false); }
  };
  const saveKey = async (key: string) => {
    const value = drafts[key]?.trim();
    const api = ipc();
    if (!api || !value) return;
    setBusy(true);
    const hadKeyBefore = await api.env.has(key).catch(() => null);
    try {
      await api.env.set(key, value);
      setDrafts((current) => ({ ...current, [key]: "" }));
      setNotice(locale === "ko" ? "키를 저장했습니다. 값은 다시 표시하지 않습니다." : "Key saved. Its value will not be shown again.");
      try {
        setStatuses(await api.multimodal.status());
      } catch {
        setNotice(locale === "ko"
          ? "키는 저장했습니다. 연결 상태만 새로고침하지 못했습니다. 키를 다시 저장하지 말고 이 화면을 다시 열어 주세요."
          : "The key was saved. Only connection status failed to refresh. Do not save the key again; reopen this panel.");
      }
    } catch {
      const hasKeyAfter = await api.env.has(key).catch(() => null);
      if (hasKeyAfter === false) {
        setNotice(locale === "ko" ? "키가 저장되지 않은 것을 확인했습니다. 값을 고친 뒤 다시 시도할 수 있습니다." : "Verified that no key was saved. Correct the value and try again.");
      } else {
        // The vault intentionally cannot return the plaintext, so an existing
        // key cannot prove whether this request or an older value won.
        setDrafts((current) => ({ ...current, [key]: "" }));
        setNotice(locale === "ko"
          ? hasKeyAfter === true && hadKeyBefore === false
            ? "저장 요청 뒤 새 키가 존재하지만 값 자체는 다시 읽을 수 없어 정확한 반영 여부를 확인할 수 없습니다. 다시 저장하지 말고 연결 상태를 확인해 주세요."
            : "저장 요청 뒤 키 값의 최종 상태를 확인할 수 없습니다. 중복 저장하지 말고 이 패널을 다시 열어 연결 상태를 확인해 주세요."
          : hasKeyAfter === true && hadKeyBefore === false
            ? "A new key exists after the save request, but its plaintext cannot be read back, so the exact value is unverified. Do not save again; check connection status."
            : "The key's final value cannot be verified after the save request. Do not save it again; reopen this panel and check connection status.");
      }
    }
    finally { setBusy(false); }
  };
  // 음성(audio) 모달리티는 뺀다 — 프로바이더(openai-audio·elevenlabs-audio)는 정의돼 있지만
  // 그것을 소비해 오디오를 **생성하는 엔진이 아무 데도 없다**(electron/multimodal 에 image·video 만,
  // startAudio ipc/preload 없음; 웹도 media 라우트에 audio 없음). 피커를 보이면 사용자가 키까지
  // 저장하는데 아무 것도 안 만드는 죽은 어포던스가 된다(감사 2026-08-25, 웹·데스크탑 공통).
  // 엔진이 생기면 여기에 { id: "audio", ... } 한 줄만 되살리면 된다.
  const modalities: Array<{ id: MultimodalModality; ko: string; en: string }> = [{ id: "image", ko: "이미지", en: "Image" }, { id: "video", ko: "영상", en: "Video" }];
  return <div className={styles.multimodal}>{notice && <p className={styles.notice} role="status">{notice}</p>}{modalities.map((modality) => {
    const selected = selectedFor(modality.id);
    const items = providers.filter((provider) => provider.modality === modality.id);
    const activeProvider = items.find((provider) => provider.id === selected);
    return <section key={modality.id} className={styles.providerGroup}><header><strong>{locale === "ko" ? modality.ko : modality.en}</strong><small>{selected === AUTO_PROVIDER ? (locale === "ko" ? "자동 선택" : "Automatic") : (locale === "ko" ? activeProvider?.labelKo : activeProvider?.label)}</small></header>
      <div className={styles.providerGrid}>
        <button type="button" data-active={selected === AUTO_PROVIDER ? "true" : "false"} disabled={busy} onClick={() => void select(modality.id, AUTO_PROVIDER)}><span><strong>{locale === "ko" ? "자동 선택 (권장)" : "Auto (recommended)"}</strong><small>{locale === "ko" ? "키 없는 연결을 우선 사용" : "Prefer keyless connections"}</small></span>{selected === AUTO_PROVIDER && <IconCheck size={14} />}</button>
        {items.map((provider) => {
          const status = statuses.find((item) => item.provider.id === provider.id && !item.auto);
          return <button type="button" key={provider.id} data-active={selected === provider.id ? "true" : "false"} disabled={busy} onClick={() => void select(modality.id, provider.id)}><span><strong>{locale === "ko" ? provider.labelKo : provider.label}</strong><small>{status?.ready ? (locale === "ko" ? "연결됨" : "Connected") : provider.mode === "api-key" ? (locale === "ko" ? "API 키 필요" : "API key required") : provider.defaultModel || provider.mode}</small></span>{selected === provider.id && <IconCheck size={14} />}</button>;
        })}
      </div>
      {activeProvider?.envKeys.map((key) => <div className={styles.secretRow} key={key}><IconKey size={14} /><input type="password" value={drafts[key] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} placeholder={`${key} · ${locale === "ko" ? "값은 Keychain에 저장" : "saved in Keychain"}`} /><button type="button" disabled={busy || !drafts[key]?.trim()} onClick={() => void saveKey(key)}>{locale === "ko" ? "저장" : "Save"}</button></div>)}
    </section>;
  })}</div>;
}

function ConcurrencySettings({ locale, active }: { locale: string; active: boolean }) {
  const [info, setInfo] = useState<AgentConcurrencyInfo | null>(null);
  const [draft, setDraft] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const api = ipc();
    if (!api) { const preview = { cores: 10, totalMemGB: 32, recommended: 4, current: 4, hardMax: 8, userSet: false }; setInfo(preview); setDraft(preview.current); return; }
    void api.system.concurrencyInfo().then((next) => { setInfo(next); setDraft(next.current); setNotice(null); }).catch(() => {
      setNotice(locale === "ko" ? "저장된 동시 실행 수를 불러오지 못했습니다." : "The saved concurrency could not be loaded.");
    });
  }, [active, locale]);
  if (!info) return <div className={styles.emptyState}>{locale === "ko" ? "하드웨어 권장값을 확인하는 중입니다." : "Checking the hardware recommendation."}</div>;
  const save = async () => {
    const api = ipc();
    if (!api) {
      setNotice(locale === "ko" ? "Desktop에 연결되지 않아 저장하지 못했습니다." : "Could not save because Desktop is unavailable.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const next = await api.system.setConcurrency(draft);
      if (!next || next.current !== draft) throw new Error("concurrency_receipt_mismatch");
      setInfo(next);
      setDraft(next.current);
      setNotice(locale === "ko" ? `${next.current}개 슬롯을 저장했습니다.` : `Saved ${next.current} slots.`);
    } catch {
      setDraft(info.current);
      try {
        const readback = await api.system.concurrencyInfo();
        setInfo(readback);
        setDraft(readback.current);
        if (readback.current === draft) {
          setNotice(locale === "ko" ? `${readback.current}개 슬롯이 저장된 것을 다시 확인했습니다.` : `Verified that ${readback.current} slots were saved.`);
        } else if (readback.current === info.current) {
          setNotice(locale === "ko" ? "변경이 반영되지 않아 이전 슬롯 수를 유지합니다." : "The change was not applied, so the prior slot count remains active.");
        } else {
          setNotice(locale === "ko" ? `요청과 다른 실제 슬롯 수 ${readback.current}개를 다시 읽었습니다.` : `Read back ${readback.current} actual slots, which differs from the request.`);
        }
      } catch {
        setNotice(locale === "ko"
          ? "저장 요청 뒤 실제 슬롯 수를 확인하지 못했습니다. 화면은 이전 값으로 되돌렸습니다. 반복 저장하지 말고 이 패널을 다시 열어 주세요."
          : "The actual slot count could not be read after the save request. This screen reverted to its prior value. Do not save again; reopen this panel.");
      }
    }
    finally { setBusy(false); }
  };
  return <div className={styles.concurrency}>
    <div className={styles.slotAdjust}>
      <button type="button" aria-label={locale === "ko" ? "슬롯 1개 줄이기" : "Decrease slots"} disabled={draft <= 1} onClick={() => setDraft((value) => Math.max(1, value - 1))}><IconChevronDown size={15} /></button>
      <div className={styles.slotNumber}><strong>{draft}</strong><span>{locale === "ko" ? "동시 슬롯" : "concurrent slots"}</span></div>
      <button type="button" aria-label={locale === "ko" ? "슬롯 1개 늘리기" : "Increase slots"} disabled={draft >= info.hardMax} onClick={() => setDraft((value) => Math.min(info.hardMax, value + 1))}><IconChevronDown size={15} style={{ transform: "rotate(180deg)" }} /></button>
    </div>
    <input type="range" min={1} max={info.hardMax} value={draft} onChange={(event) => setDraft(Number(event.target.value))} aria-label={locale === "ko" ? "동시 실행 슬롯" : "Concurrent slots"} />
    <div className={styles.slotScale}><span>1</span><span>{locale === "ko" ? `권장 ${info.recommended}` : `Recommended ${info.recommended}`}</span><span>{info.hardMax}</span></div>
    <p>{locale === "ko" ? `${info.cores}코어 · ${info.totalMemGB}GB RAM 기준입니다. One도 슬롯 1개를 사용하며 각 직원은 별도 컴퓨터가 아니라 별도 터미널·데몬 세션을 사용합니다.` : `Based on ${info.cores} cores and ${info.totalMemGB}GB RAM. One uses one slot; each worker gets a terminal or daemon session, not a separate computer.`}</p>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.actionRow}><button type="button" disabled={busy} onClick={() => setDraft(info.recommended)}>{locale === "ko" ? "권장값" : "Recommended"}</button><button type="button" className={styles.primary} disabled={busy || draft === info.current} onClick={() => void save()}>{locale === "ko" ? "적용" : "Apply"}</button></div>
  </div>;
}

/**
 * 기록이 어디에 남는지는 제품마다 다르다. 문구를 화면 안에 박아 두면 이식본이 사실과 다른
 * 개인정보 약속을 하게 된다(웹은 서버에 저장한다). 한 함수로 모아 두고 이식 시 여기만 바꾼다.
 */
function historyPrivacyHeadline(locale: string): string {
  return locale === "ko" ? "원본은 이 Mac 밖으로 나가지 않습니다" : "Source activity stays on this Mac";
}

function HistorySettings({ locale, state, onConsent }: { locale: string; state: ComputerHistoryState | null; onConsent: (enabled: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const enabled = state?.consent === "on" || (!ipc() && state === null);
  const update = async (next: boolean) => { setBusy(true); try { await onConsent(next); } finally { setBusy(false); } };
  return <div className={styles.historySettings}>
    <div className={styles.historyHero}><IconLock size={18} /><div><strong>{historyPrivacyHeadline(locale)}</strong><span>{locale === "ko" ? "10분 사실과 6시간 요약만 저장하고 원본 관찰 이벤트는 7일 후 자동 삭제합니다." : "Only 10-minute facts and six-hour summaries are kept; source observation events are removed after seven days."}</span></div></div>
    <div className={styles.toggleRow}><div><strong>{locale === "ko" ? "컴퓨터 기록" : "Computer history"}</strong><small>{enabled ? (locale === "ko" ? "기록과 추천이 켜져 있습니다." : "History and recommendations are on.") : (locale === "ko" ? "명시적으로 켜기 전에는 수집하지 않습니다." : "Nothing is collected until you explicitly enable it.")}</small></div><button type="button" className={styles.switch} data-on={enabled ? "true" : "false"} disabled={busy} aria-label={locale === "ko" ? `컴퓨터 기록 ${enabled ? "끄기" : "켜기"}` : `Turn computer history ${enabled ? "off" : "on"}`} onClick={() => void update(!enabled)}><span /></button></div>
    <p className={styles.inlineNote}>{locale === "ko" ? "에이전트 빌드 추천은 초안만 만듭니다. 검토 버튼을 누르기 전에는 빌드나 설치를 시작하지 않습니다." : "Agent-build recommendations create drafts only. Build and installation never start until you choose Review."}</p>
  </div>;
}

/**
 * PRD §6(데스크탑) — 브리핑 알림 기능은 Main·IPC·preload 까지 전부 배선돼 있는데 **화면에서
 * 부르는 곳이 없었다.** 그래서 15분마다 도는 예약기는 알림을 낼 수 없었고(기본 채널이 앱 안
 * 알림뿐), 주기·방해 금지도 기본값에 고정돼 있었다. 마지막 칸을 잇는다.
 */
function BriefingSettings({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const [preferences, setPreferences] = useState<OneBriefingPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api) return;
    void api.oneBriefing.get()
      .then((snapshot) => { if (!cancelled) setPreferences(snapshot?.preferences ?? null); })
      .catch(() => { if (!cancelled) setError(ko ? "설정을 불러오지 못했습니다." : "Could not load these settings."); });
    return () => { cancelled = true; };
  }, [ko]);

  const save = async (patch: { cadence?: OneBriefingCadence; channels?: OneBriefingPreferences["channels"]; quietHours?: OneBriefingPreferences["quietHours"] }) => {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPreferences(await api.oneBriefing.setPreferences(patch));
    } catch {
      // 실패를 삼키지 않는다 — 저장 안 된 것을 저장된 것처럼 보이게 두지 않는다.
      setError(ko ? "저장하지 못했습니다. 다시 시도해 주세요." : "Could not save. Please try again.");
      const api2 = ipc();
      if (api2) setPreferences(await api2.oneBriefing.get().then((snapshot) => snapshot?.preferences ?? null).catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  if (!preferences) {
    return <div className={styles.emptyState}>{error ?? (ko ? "불러오는 중…" : "Loading…")}</div>;
  }
  const desktopOn = preferences.channels.includes("desktop_notification");
  const cadences: Array<{ id: OneBriefingCadence; ko: string; en: string }> = [
    { id: "important_only", ko: "중요한 것만", en: "Important only" },
    { id: "daily", ko: "매일", en: "Daily" },
    { id: "weekdays", ko: "평일", en: "Weekdays" },
    { id: "weekly", ko: "주 1회", en: "Weekly" },
  ];
  return <div className={styles.settingList}>
    {error && <div className={styles.emptyState}>{error}</div>}
    <div className={styles.settingRow}>
      <span className={styles.settingCopy}>
        <strong>{ko ? "알려 주는 빈도" : "How often One tells you"}</strong>
        <small>{ko ? "One 이 먼저 말을 거는 정도입니다." : "How often One starts the conversation."}</small>
      </span>
      <select
        value={preferences.cadence}
        disabled={busy}
        aria-label={ko ? "브리핑 빈도" : "Briefing cadence"}
        onChange={(event) => void save({ cadence: event.target.value as OneBriefingCadence })}
      >
        {cadences.map((item) => <option key={item.id} value={item.id}>{ko ? item.ko : item.en}</option>)}
      </select>
    </div>
    <div className={styles.settingRow}>
      <span className={styles.settingCopy}>
        <strong>{ko ? "데스크탑 알림" : "Desktop notifications"}</strong>
        <small>{ko ? "앱이 가려져 있을 때 OS 알림으로 알려 줍니다. 내용은 담지 않습니다." : "A generic OS alert when the app is hidden. It never carries details."}</small>
      </span>
      <input
        type="checkbox"
        checked={desktopOn}
        disabled={busy}
        aria-label={ko ? "데스크탑 알림 사용" : "Use desktop notifications"}
        onChange={(event) => void save({
          // 앱 안 알림은 항상 켜져 있다(계약상 최소 채널).
          channels: event.target.checked ? ["in_app", "desktop_notification"] : ["in_app"],
        })}
      />
    </div>
    <div className={styles.settingRow}>
      <span className={styles.settingCopy}>
        <strong>{ko ? "방해 금지" : "Quiet hours"}</strong>
        <small>{ko ? `${preferences.quietHours.startHour}시 ~ ${preferences.quietHours.endHour}시에는 알리지 않습니다.` : `No alerts between ${preferences.quietHours.startHour}:00 and ${preferences.quietHours.endHour}:00.`}</small>
      </span>
      <input
        type="checkbox"
        checked={preferences.quietHours.enabled}
        disabled={busy}
        aria-label={ko ? "방해 금지 사용" : "Use quiet hours"}
        onChange={(event) => void save({ quietHours: { ...preferences.quietHours, enabled: event.target.checked } })}
      />
    </div>
  </div>;
}

export function OneSettingsSheet({ open, locale, installedPlugins, pluginCatalog, pluginStatuses, permission, runtime, models, history, onClose, onTogglePlugin, onSelectPermission, onSelectModel, onHistoryConsent, onOpenMcpLibrary, onToolTabChange }: SheetProps) {
  const ko = locale === "ko";
  const meta = open ? SETTINGS_META[open] : SETTINGS_META.mcp;
  const customServers = installedPlugins.filter((item) => !item.catalogId);
  const catalogPlugins = installedPlugins.filter((item) => Boolean(item.catalogId));
  const toolsOpen = open === "plugins" || open === "mcp";
  const title = toolsOpen ? (ko ? "도구" : "Tools") : (ko ? meta.titleKo : meta.titleEn);
  const description = toolsOpen
    ? (ko ? "플러그인은 카탈로그 도구이고 MCP는 직접 등록한 서버입니다. 서로 다른 목록으로 관리합니다." : "Plugins are catalog tools; MCP contains servers you registered yourself. They stay in separate lists.")
    : (ko ? meta.descriptionKo : meta.descriptionEn);
  return <OneBottomSheet open={open !== null} onClose={onClose} closeLabel={ko ? "설정 닫기" : "Close settings"} size={SHEET_WIDTH[open ?? "permission"]} eyebrow={ko ? "One 설정" : "One settings"} title={title} description={description} titleId="one-settings-sheet-title" ariaLabelledBy="one-settings-sheet-title">
    <div className={styles.sheetBody} data-setting={open || undefined}>
      {toolsOpen && <div className={styles.toolTabs} role="tablist" aria-label={ko ? "도구 종류" : "Tool type"}>
        <button type="button" role="tab" aria-selected={open === "plugins"} data-active={open === "plugins" ? "true" : "false"} onClick={() => onToolTabChange("plugins")}>{ko ? "플러그인" : "Plugins"}</button>
        <button type="button" role="tab" aria-selected={open === "mcp"} data-active={open === "mcp" ? "true" : "false"} onClick={() => onToolTabChange("mcp")}>MCP</button>
      </div>}
      {open === "mcp" && <><ToolRows items={customServers} catalog={pluginCatalog} statuses={pluginStatuses} locale={locale} onToggle={onTogglePlugin} empty={ko ? "직접 등록한 MCP 서버가 없습니다." : "No custom MCP servers are registered."} /><div className={styles.actionRow}><span /><button type="button" className={styles.primary} onClick={onOpenMcpLibrary}>{ko ? "MCP 추가·관리" : "Add or manage MCP"}</button></div></>}
      {open === "plugins" && <><ToolRows items={catalogPlugins} catalog={pluginCatalog} statuses={pluginStatuses} locale={locale} onToggle={onTogglePlugin} empty={ko ? "설치한 플러그인이 없습니다." : "No plugins are installed."} /><div className={styles.actionRow}><span /><button type="button" className={styles.primary} onClick={onOpenMcpLibrary}>{ko ? "플러그인 둘러보기" : "Browse plugins"}</button></div></>}
      {open === "permission" && <PermissionSettings locale={locale} value={permission} onChange={onSelectPermission} />}
      {open === "models" && <ModelSettings locale={locale} runtime={runtime} models={models} onSelect={onSelectModel} />}
      {open === "multimodal" && <MultimodalSettingsPanel locale={locale} active={open === "multimodal"} />}
      {open === "media" && <MediaDisplaySettings locale={locale} compact />}
      {open === "concurrency" && <ConcurrencySettings locale={locale} active={open === "concurrency"} />}
      {open === "history" && <HistorySettings locale={locale} state={history} onConsent={onHistoryConsent} />}
      {open === "briefing" && <BriefingSettings locale={locale} />}
    </div>
  </OneBottomSheet>;
}
