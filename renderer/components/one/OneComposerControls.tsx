"use client";

import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  IconAtSign,
  IconCheck,
  IconChevronRight,
  IconFileUp,
  IconFolder,
  IconLayers,
  IconRoute,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTarget,
} from "@/components/Icon";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import type { RuntimeStatus } from "@shared/types";
import styles from "./OneShell.module.css";

export type OneComposerMenuKey = "plus" | "agents" | "model" | "effort" | "permission";
export type OnePermissionMode = "auto" | "read" | "write" | "full";

export type OneComposerModelOption = {
  id: string;
  label: string;
  tag?: string;
  runtime: RuntimeStatus;
  /**
   * 벤더 로고 주소. 없으면 기본 아이콘을 그린다 — 모르는 벤더에 아무 로고나 붙이지 않는다.
   * 값을 만드는 곳은 목록을 만드는 쪽이다(오너 지시 2026-08-24: "모델 명과 모델 로고").
   */
  logo?: string | null;
};

export type OneComposerAgentOption = {
  id: string;
  name: string;
  tagline: string;
  selected: boolean;
};

export type OneComposerPluginOption = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  ready: boolean;
  /** 로고 조회용 — 카탈로그 id와 서버 이름 둘 다 slug 후보다. */
  catalogId?: string | null;
  serverName?: string;
  brandColor?: string;
  mark?: string;
};

type OneTurnOptionKey = "goalMode" | "planMode" | "sessionRouting" | "fastMode";

type Props = {
  activeMenu: OneComposerMenuKey;
  locale: "ko" | "en";
  runtime: RuntimeStatus | null;
  models: OneComposerModelOption[];
  agents: OneComposerAgentOption[];
  plugins: OneComposerPluginOption[];
  permission: OnePermissionMode;
  turnOptions: Partial<Record<OneTurnOptionKey, true>>;
  localFilesConnected: boolean;
  onMenuChange: (menu: OneComposerMenuKey | null) => void;
  onAttach: () => void;
  onAddFolder: () => void;
  onClearFolder: () => void;
  onOpenPlugins: () => void;
  /** 플러그인 행 자체가 켜기/끄기 스위치다. 설정이 덜 된 항목은 관리 화면으로 보낸다. */
  onTogglePlugin: (id: string) => void;
  onToggleAgent: (id: string) => void;
  onSelectModel: (runtime: RuntimeStatus, id: string) => void;
  onSelectEffort: (id: string) => void;
  onSelectPermission: (permission: OnePermissionMode) => void;
  onToggleTurnOption: (key: OneTurnOptionKey) => void;
};

const permissionOptions: Array<{ id: OnePermissionMode; ko: string; en: string; descriptionKo: string; descriptionEn: string }> = [
  { id: "auto", ko: "자동 모드", en: "Auto mode", descriptionKo: "대화는 읽기로, 작업은 파일 편집으로 실행하고 적용 권한을 Activity에 기록합니다", descriptionEn: "Conversations use read access; task work allows file edits. Activity records the effective mode" },
  { id: "read", ko: "읽기 전용", en: "Read only", descriptionKo: "파일이나 외부 상태를 바꾸지 않습니다", descriptionEn: "Does not change files or external state" },
  { id: "write", ko: "파일 편집", en: "Accept file edits", descriptionKo: "현재 작업 폴더의 파일 편집을 허용합니다", descriptionEn: "Allows edits in the current workspace" },
  { id: "full", ko: "전체 액세스", en: "Full access", descriptionKo: "모든 로컬 파일, 명령, 네트워크와 도구 실행을 허용합니다", descriptionEn: "Allows all local files, commands, network, and tools" },
];

export function OneComposerControls({
  activeMenu,
  locale,
  runtime,
  models,
  agents,
  plugins,
  permission,
  turnOptions,
  localFilesConnected,
  onMenuChange,
  onAttach,
  onAddFolder,
  onClearFolder,
  onOpenPlugins,
  onTogglePlugin,
  onToggleAgent,
  onSelectModel,
  onSelectEffort,
  onSelectPermission,
  onToggleTurnOption,
}: Props) {
  const [query, setQuery] = useState("");
  const brandMap = usePluginBrandMap();
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({
    left: 12,
    bottom: 156,
    width: 390,
    maxHeight: 420,
  });
  useEffect(() => setQuery(""), [activeMenu]);
  useEffect(() => setPortalHost(document.body), []);
  useLayoutEffect(() => {
    if (!portalHost) return;

    const updatePosition = () => {
      const triggerKey = activeMenu === "agents" ? "plus" : activeMenu;
      const trigger = document.querySelector<HTMLElement>(`[data-one-composer-trigger="${triggerKey}"]`)
        ?? document.querySelector<HTMLElement>('[data-one-composer-trigger="plus"]');
      const composer = document.querySelector<HTMLElement>('[data-one-composer="true"]');
      if (!trigger || !composer) return;

      const composerRect = composer.getBoundingClientRect();
      const viewportMargin = window.innerWidth <= 700 ? 10 : 24;
      const preferredWidth = activeMenu === "permission" ? composerRect.width
          : activeMenu === "effort" ? 240
            : 390;
      const width = Math.min(
        activeMenu === "plus" ? composerRect.width : preferredWidth,
        window.innerWidth - viewportMargin * 2,
      );
      const left = Math.min(
        Math.max(viewportMargin, composerRect.left),
        Math.max(viewportMargin, window.innerWidth - viewportMargin - width),
      );
      const bottom = Math.max(viewportMargin, window.innerHeight - composerRect.top + 10);
      const maxHeight = Math.min(540, Math.max(180, composerRect.top - viewportMargin - 10));
      setPopoverPosition({ left, bottom, width, maxHeight });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    const composer = document.querySelector<HTMLElement>('[data-one-composer="true"]');
    if (composer) observer?.observe(composer);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [activeMenu, portalHost]);
  useLayoutEffect(() => {
    if (!portalHost || activeMenu !== "permission") return;
    const option = document.querySelector<HTMLElement>(
      '[data-one-composer-popover="permission"] [data-one-permission-option][data-selected="true"]',
    ) ?? document.querySelector<HTMLElement>(
      '[data-one-composer-popover="permission"] [data-one-permission-option]',
    );
    option?.focus({ preventScroll: true });
  }, [activeMenu, portalHost, permission]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredModels = useMemo(
    () => models.filter((item) => !normalizedQuery || `${item.label} ${item.tag ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)),
    [models, normalizedQuery],
  );
  const filteredAgents = useMemo(
    () => agents.filter((item) => !normalizedQuery || `${item.name} ${item.tagline}`.toLocaleLowerCase().includes(normalizedQuery)),
    [agents, normalizedQuery],
  );
  const efforts = (runtime?.efforts ?? []).filter((item) => (
    !normalizedQuery || `${item.label} ${item.id}`.toLocaleLowerCase().includes(normalizedQuery)
  ));
  const permissions = permissionOptions.filter((item) => (
    !normalizedQuery || `${item.ko} ${item.en} ${item.descriptionKo} ${item.descriptionEn}`.toLocaleLowerCase().includes(normalizedQuery)
  ));

  const popover = (
    <section
      className={styles.composerPopover}
      id="one-composer-popover"
      data-one-composer-popover={activeMenu}
      role="dialog"
      style={{
        "--one-composer-popover-left": `${popoverPosition.left}px`,
        "--one-composer-popover-bottom": `${popoverPosition.bottom}px`,
        "--one-composer-popover-width": `${popoverPosition.width}px`,
        "--one-composer-popover-max-height": `${popoverPosition.maxHeight}px`,
      } as CSSProperties}
      aria-label={locale === "ko" ? "One 입력 설정" : "One composer settings"}
    >
      {activeMenu === "plus" ? (
        <div className={styles.composerPopoverList}>
          <div className={styles.composerPopoverSectionLabel}>{locale === "ko" ? "추가" : "Add"}</div>
          <ComposerRow icon={<IconFileUp size={15} />} title={locale === "ko" ? "사진 및 파일 추가" : "Add photos and files"} onClick={onAttach} />
          <ComposerRow
            icon={<IconFolder size={15} />}
            title={localFilesConnected
              ? (locale === "ko" ? "로컬 파일 연결됨" : "Local files connected")
              : (locale === "ko" ? "로컬 파일 연결" : "Connect local files")}
            subtitle={localFilesConnected
              ? (locale === "ko" ? "이번 대화의 실행 컨텍스트입니다. 눌러서 바꿀 수 있습니다" : "Execution context for this conversation. Select to change it")
              : (locale === "ko" ? "필요할 때만 원본 위치에서 읽습니다. 업로드하거나 복사하지 않습니다" : "Read in place only when needed. Nothing is uploaded or copied")}
            checked={localFilesConnected}
            onClick={onAddFolder}
          />
          {localFilesConnected ? <ComposerRow
            icon={<IconShield size={15} />}
            title={locale === "ko" ? "로컬 파일 접근 해제" : "Disconnect local files"}
            subtitle={locale === "ko" ? "대화는 유지하고 로컬 파일 경로만 분리합니다" : "Keep the conversation and remove only its local file access"}
            onClick={onClearFolder}
          /> : null}
          <div className={styles.composerPopoverDivider} />
          <ComposerRow icon={<IconRoute size={15} />} title={locale === "ko" ? "플랜 모드" : "Plan mode"} toggle checked={Boolean(turnOptions.planMode)} onClick={() => onToggleTurnOption("planMode")} />
          <ComposerRow icon={<IconTarget size={15} />} title={locale === "ko" ? "목표 추진" : "Goal mode"} toggle checked={Boolean(turnOptions.goalMode)} onClick={() => onToggleTurnOption("goalMode")} />
          <div className={styles.composerPopoverDivider} />
          <ComposerRow icon={<IconAtSign size={15} />} title={locale === "ko" ? "특정 에이전트 지정 (선택)" : "Choose specific agents (optional)"} subtitle={locale === "ko" ? "이 턴에만 수동으로 추가" : "Add manually for this turn"} onClick={() => onMenuChange("agents")} />
          <div className={styles.composerPopoverDivider} />
          <div className={styles.composerPopoverSectionLabel}>{locale === "ko" ? "도구" : "Tools"}</div>
          <div className={styles.composerPluginList}>
            {plugins.length === 0 ? (
              <ComposerRow
                icon={<IconLayers size={15} />}
                title={locale === "ko" ? "연결된 도구 없음" : "No connected tools"}
                subtitle={locale === "ko" ? "도구 설정 열기" : "Open tool settings"}
                trailing={<IconChevronRight size={13} />}
                onClick={onOpenPlugins}
              />
            ) : plugins.map((plugin) => (
              <ComposerRow
                key={plugin.id}
                icon={(
                  <PluginLogo
                    catalogId={plugin.catalogId}
                    name={plugin.serverName ?? plugin.name}
                    size={18}
                    brandColor={plugin.brandColor}
                    mark={plugin.mark}
                    brandMap={brandMap}
                  />
                )}
                title={plugin.name}
                subtitle={plugin.enabled && plugin.ready
                  ? plugin.description
                  : `${plugin.enabled
                    ? (locale === "ko" ? "설정 필요" : "Setup required")
                    : (locale === "ko" ? "비활성화됨" : "Disabled")} · ${plugin.description}`}
                checked={plugin.enabled && plugin.ready}
                onClick={() => onTogglePlugin(plugin.id)}
              />
            ))}
          </div>
          <ComposerRow
            icon={<IconLayers size={15} />}
            title={locale === "ko" ? "도구 관리" : "Manage tools"}
            trailing={<IconChevronRight size={13} />}
            onClick={onOpenPlugins}
          />
        </div>
      ) : (
        <>
          <header className={styles.composerPopoverHeader}>
            <strong id="one-composer-popover-title">{activeMenu === "agents" ? (locale === "ko" ? "에이전트" : "Agents") : activeMenu === "model" ? (locale === "ko" ? "모델" : "Models") : activeMenu === "effort" ? (locale === "ko" ? "추론 강도" : "Reasoning effort") : (locale === "ko" ? "실행 모드" : "Execution mode")}</strong>
          </header>
          {activeMenu !== "permission" && <label className={styles.composerPopoverSearch}>
              <IconSearch size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={locale === "ko" ? "검색..." : "Search..."} autoFocus />
            </label>}
          <div className={styles.composerPopoverDivider} />
          <div className={styles.composerPopoverScroll} data-one-composer-scroll={activeMenu}>
            {activeMenu === "agents" && filteredAgents.map((item) => (
              <ComposerRow key={item.id} icon={<IconAtSign size={15} />} title={item.name} subtitle={item.tagline} checked={item.selected} onClick={() => onToggleAgent(item.id)} />
            ))}
            {activeMenu === "model" && (
              <>
                {runtime && runtimeUsesEngineModelSetting(runtime.kind) && (
                  <ComposerRow icon={<IconSparkles size={15} />} title={runtimeModelFallbackLabel(runtime.kind, locale)} checked={!runtime.model} onClick={() => onSelectModel(runtime, "")} />
                )}
                {filteredModels.map((item) => (
                  <ComposerRow key={`${item.runtime.kind}:${item.runtime.backend}:${item.id}`} icon={item.logo
                    ? /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={item.logo} alt="" className={styles.modelLogo} />
                    : <IconSparkles size={15} />} title={item.label} subtitle={item.tag} checked={runtime?.kind === item.runtime.kind && runtime?.backend === item.runtime.backend && runtime?.model === item.id} onClick={() => onSelectModel(item.runtime, item.id)} />
                ))}
              </>
            )}
            {activeMenu === "effort" && (
              <>
                <ComposerRow icon={<IconRoute size={15} />} title={locale === "ko" ? "기본" : "Default"} checked={!runtime?.effort} onClick={() => onSelectEffort("")} />
                {efforts.map((item) => (
                  <ComposerRow key={item.id} icon={<IconRoute size={15} />} title={item.label} checked={runtime?.effort === item.id} onClick={() => onSelectEffort(item.id)} />
                ))}
              </>
            )}
            {activeMenu === "permission" && permissions.map((item) => (
              <ComposerRow
                key={item.id}
                icon={<IconShield size={15} />}
                title={locale === "ko" ? item.ko : item.en}
                subtitle={locale === "ko" ? item.descriptionKo : item.descriptionEn}
                dataPermission={item.id}
                checked={permission === item.id}
                onClick={() => onSelectPermission(item.id)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );

  return portalHost ? createPortal(popover, portalHost) : null;
}

function ComposerRow({ icon, title, subtitle, checked, toggle, trailing, dataPermission, onClick }: { icon: React.ReactNode; title: string; subtitle?: string; checked?: boolean; toggle?: boolean; trailing?: React.ReactNode; dataPermission?: OnePermissionMode; onClick: () => void }) {
  return (
    <button type="button" className={styles.composerPopoverRow} data-selected={checked ? "true" : undefined} data-one-permission-option={dataPermission} onClick={onClick}>
      <span className={styles.composerPopoverIcon} aria-hidden="true">{icon}</span>
      <span className={styles.composerPopoverCopy}><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      {toggle ? <span className={styles.composerPopoverToggle} data-on={checked ? "true" : "false"}><span /></span> : trailing ?? (checked && <IconCheck size={14} />)}
    </button>
  );
}
