"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { IconClose, IconFileUp, IconFolder } from "./Icon";
import type { ChatFileItem } from "@/lib/chat-files";
import { formatChatFileSize } from "@/lib/chat-files";
import styles from "./ChatFileExperience.module.css";

export type ChatFileTab = {
  id: string;
  name: string;
  provenance: ChatFileItem["provenance"];
};

function provenanceLabel(provenance: ChatFileItem["provenance"], locale: "ko" | "en"): string {
  if (provenance === "user-attachment") return locale === "ko" ? "내 첨부" : "Your attachment";
  if (provenance === "agent-output") return locale === "ko" ? "에이전트 결과" : "Agent output";
  return locale === "ko" ? "연결된 파일" : "Linked file";
}

export function ChatFileCards({
  files,
  locale,
  onOpen,
}: {
  files: ChatFileItem[];
  locale: "ko" | "en";
  onOpen: (file: ChatFileItem) => void;
}) {
  if (files.length === 0) return null;
  return <div className={styles.cards} data-chat-file-cards="true">
    {files.map((file) => (
      <button
        key={file.tabId}
        type="button"
        className={styles.card}
        data-chat-file-id={file.id}
        data-chat-file-provenance={file.provenance}
        onClick={() => onOpen(file)}
        title={file.sha256 ? `${file.name}\n${file.sha256}` : file.name}
      >
        <span className={styles.cardIcon} aria-hidden="true">
          {file.kind === "directory" ? <IconFolder size={15} /> : <IconFileUp size={15} />}
        </span>
        <span className={styles.cardCopy}>
          <span className={styles.cardName}>{file.name}</span>
          <span className={styles.cardMeta}>
            {provenanceLabel(file.provenance, locale)} · {file.kind === "directory" ? (locale === "ko" ? "폴더" : "Folder") : formatChatFileSize(file.size)}
          </span>
        </span>
      </button>
    ))}
  </div>;
}

export function ChatFileTabs({
  tabs,
  activeId,
  locale,
  onSelect,
  onClose,
}: {
  tabs: ChatFileTab[];
  activeId: string | null;
  locale: "ko" | "en";
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeId) return;
    const active = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-file-tab-id]") ?? [])
      .find((tab) => tab.dataset.fileTabId === activeId);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);
  if (tabs.length === 0) return null;
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    onSelect(tabs[next].id);
    const controls = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    controls?.[next]?.focus();
  };
  return <div ref={listRef} className={styles.tabs} role="tablist" aria-label={locale === "ko" ? "열린 파일" : "Open files"} data-chat-file-tabs="true">
    {tabs.map((tab, index) => (
      <span key={tab.id} className={styles.tab} data-file-tab-id={tab.id} data-active={tab.id === activeId ? "true" : "false"}>
        <button
          type="button"
          role="tab"
          aria-selected={tab.id === activeId}
          className={styles.tabSelect}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => moveWithKeyboard(event, index)}
        >
          <IconFileUp size={12} aria-hidden="true" />
          <span>{tab.name}</span>
        </button>
        <button
          type="button"
          className={styles.tabClose}
          aria-label={locale === "ko" ? `${tab.name} 탭 닫기` : `Close ${tab.name} tab`}
          onClick={() => onClose(tab.id)}
        ><IconClose size={11} /></button>
      </span>
    ))}
  </div>;
}

export function nextFileTabSelection(tabs: ChatFileTab[], closingId: string, activeId: string | null): string | null {
  if (activeId !== closingId) return activeId;
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0) return activeId;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}
