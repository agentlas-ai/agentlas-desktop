"use client";

import { useEffect, useMemo, useState } from "react";
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
import type { RuntimeStatus } from "@shared/types";
import styles from "./OneShell.module.css";

export type OneComposerMenuKey = "plus" | "agents" | "model" | "effort" | "permission";
export type OnePermissionMode = "auto" | "read" | "write" | "full";

export type OneComposerModelOption = {
  id: string;
  label: string;
  tag?: string;
  runtime: RuntimeStatus;
};

export type OneComposerAgentOption = {
  id: string;
  name: string;
  tagline: string;
  selected: boolean;
};

type OneTurnOptionKey = "goalMode" | "planMode" | "sessionRouting" | "stormbreakerMode";

type Props = {
  activeMenu: OneComposerMenuKey;
  locale: "ko" | "en";
  runtime: RuntimeStatus | null;
  models: OneComposerModelOption[];
  agents: OneComposerAgentOption[];
  permission: OnePermissionMode;
  turnOptions: Partial<Record<OneTurnOptionKey, true>>;
  onMenuChange: (menu: OneComposerMenuKey) => void;
  onAttach: () => void;
  onAddFolder: () => void;
  onOpenPlugins: () => void;
  onToggleAgent: (id: string) => void;
  onSelectModel: (runtime: RuntimeStatus, id: string) => void;
  onSelectEffort: (id: string) => void;
  onSelectPermission: (permission: OnePermissionMode) => void;
  onToggleTurnOption: (key: OneTurnOptionKey) => void;
};

const permissionOptions: Array<{ id: OnePermissionMode; ko: string; en: string; descriptionKo: string; descriptionEn: string }> = [
  { id: "auto", ko: "자동 모드", en: "Auto mode", descriptionKo: "요청 성격에 맞춰 One이 실행 범위를 고릅니다", descriptionEn: "One chooses the execution scope for the request" },
  { id: "read", ko: "읽기 전용", en: "Read only", descriptionKo: "파일이나 외부 상태를 바꾸지 않습니다", descriptionEn: "Does not change files or external state" },
  { id: "write", ko: "파일 편집", en: "Accept file edits", descriptionKo: "현재 작업 폴더의 파일 편집을 허용합니다", descriptionEn: "Allows edits in the current workspace" },
  { id: "full", ko: "전체 액세스", en: "Full access", descriptionKo: "명령과 도구 실행까지 허용합니다", descriptionEn: "Allows commands and tool execution" },
];

function runtimeLabel(runtime: RuntimeStatus | null): string {
  if (!runtime) return "Model";
  if (runtime.kind === "claude-code") return "Claude";
  if (runtime.kind === "codex") return "Codex";
  if (runtime.kind === "gemini") return "Gemini";
  if (runtime.kind === "grok") return "Grok";
  if (runtime.kind === "kimi") return "Kimi";
  return runtime.backend || runtime.kind;
}

export function OneComposerControls({
  activeMenu,
  locale,
  runtime,
  models,
  agents,
  permission,
  turnOptions,
  onMenuChange,
  onAttach,
  onAddFolder,
  onOpenPlugins,
  onToggleAgent,
  onSelectModel,
  onSelectEffort,
  onSelectPermission,
  onToggleTurnOption,
}: Props) {
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [activeMenu]);
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

  return (
    <section
      className={styles.composerPopover}
      data-one-composer-popover={activeMenu}
      aria-label={locale === "ko" ? "One 입력 설정" : "One composer settings"}
    >
      {activeMenu === "plus" ? (
        <div className={styles.composerPopoverList}>
          <ComposerRow icon={<IconFileUp size={15} />} title={locale === "ko" ? "사진 및 파일 추가" : "Add photos and files"} onClick={onAttach} />
          <ComposerRow icon={<IconFolder size={15} />} title={locale === "ko" ? "폴더 추가" : "Add folder"} onClick={onAddFolder} />
          <ComposerRow icon={<IconLayers size={15} />} title={locale === "ko" ? "플러그인 (MCP 서버)" : "Plugins (MCP servers)"} trailing={<IconChevronRight size={13} />} onClick={onOpenPlugins} />
          <div className={styles.composerPopoverDivider} />
          <ComposerRow icon={<IconRoute size={15} />} title={locale === "ko" ? "플랜 모드" : "Plan mode"} toggle checked={Boolean(turnOptions.planMode)} onClick={() => onToggleTurnOption("planMode")} />
          <ComposerRow icon={<IconTarget size={15} />} title={locale === "ko" ? "목표 추진" : "Goal mode"} toggle checked={Boolean(turnOptions.goalMode)} onClick={() => onToggleTurnOption("goalMode")} />
          <div className={styles.composerPopoverDivider} />
          <ComposerRow icon={<IconAtSign size={15} />} title={locale === "ko" ? "특정 에이전트 지정 (선택)" : "Choose specific agents (optional)"} subtitle={locale === "ko" ? "이 턴에만 수동으로 추가" : "Add manually for this turn"} onClick={() => onMenuChange("agents")} />
        </div>
      ) : (
        <>
          <header className={styles.composerPopoverHeader}>
            <strong>{activeMenu === "agents" ? (locale === "ko" ? "에이전트" : "Agents") : activeMenu === "model" ? runtimeLabel(runtime) : activeMenu === "effort" ? (locale === "ko" ? "추론 강도" : "Reasoning effort") : (locale === "ko" ? "실행 모드" : "Execution mode")}</strong>
          </header>
          <label className={styles.composerPopoverSearch}>
            <IconSearch size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={locale === "ko" ? "검색..." : "Search..."} autoFocus />
          </label>
          <div className={styles.composerPopoverDivider} />
          <div className={styles.composerPopoverScroll} data-one-composer-scroll={activeMenu}>
            {activeMenu === "agents" && filteredAgents.map((item) => (
              <ComposerRow key={item.id} icon={<IconAtSign size={15} />} title={item.name} subtitle={item.tagline} checked={item.selected} onClick={() => onToggleAgent(item.id)} />
            ))}
            {activeMenu === "model" && (
              <>
                {runtime && runtime.kind !== "byok" && (
                  <ComposerRow icon={<IconSparkles size={15} />} title={locale === "ko" ? "구독 기본" : "Subscription default"} checked={!runtime.model} onClick={() => onSelectModel(runtime, "")} />
                )}
                {filteredModels.map((item) => (
                  <ComposerRow key={`${item.runtime.kind}:${item.runtime.backend}:${item.id}`} icon={<IconSparkles size={15} />} title={item.label} subtitle={item.tag} checked={runtime?.kind === item.runtime.kind && runtime?.backend === item.runtime.backend && runtime?.model === item.id} onClick={() => onSelectModel(item.runtime, item.id)} />
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
              <ComposerRow key={item.id} icon={<IconShield size={15} />} title={locale === "ko" ? item.ko : item.en} checked={permission === item.id} onClick={() => onSelectPermission(item.id)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ComposerRow({ icon, title, subtitle, checked, toggle, trailing, onClick }: { icon: React.ReactNode; title: string; subtitle?: string; checked?: boolean; toggle?: boolean; trailing?: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={styles.composerPopoverRow} data-selected={checked ? "true" : undefined} onClick={onClick}>
      <span className={styles.composerPopoverIcon} aria-hidden="true">{icon}</span>
      <span className={styles.composerPopoverCopy}><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      {toggle ? <span className={styles.composerPopoverToggle} data-on={checked ? "true" : "false"}><span /></span> : trailing ?? (checked && <IconCheck size={14} />)}
    </button>
  );
}
