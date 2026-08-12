"use client";

import { useEffect, useMemo, useState } from "react";

import {
  IconCode,
  IconFileUp,
  IconImage,
  IconShield,
  IconSparkles,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { OneRuntimeFeedbackItem } from "@/lib/one-runtime-feedback";
import type { TextFilePreview } from "@shared/types";
import styles from "./OneShell.module.css";

function FeedbackIcon({ item }: { item: OneRuntimeFeedbackItem }) {
  if (item.kind === "image") return <IconImage size={14} />;
  if (item.kind === "file") return <IconFileUp size={14} />;
  if (item.kind === "notice") return <IconShield size={14} />;
  if (item.kind === "tool") return <IconCode size={14} />;
  return <IconSparkles size={14} />;
}

export function OneRuntimeFeedbackList({
  items,
  locale,
}: {
  items: OneRuntimeFeedbackItem[];
  locale: "ko" | "en";
}) {
  const visible = items.slice(-12);
  if (visible.length === 0) return null;
  return (
    <section
      className={styles.runtimeFeedback}
      aria-label={locale === "ko" ? "현재 작업 과정" : "Current work progress"}
      data-one-runtime-feedback="true"
    >
      {visible.map((item) => item.detail ? (
        <details key={item.id} className={styles.runtimeFeedbackRow} data-kind={item.kind} data-error={item.isError ? "true" : "false"}>
          <summary>
            <span className={styles.runtimeFeedbackIcon}><FeedbackIcon item={item} /></span>
            <span className={styles.runtimeFeedbackLabel}>{item.label}</span>
            {item.agentName && <small>{item.agentName}</small>}
          </summary>
          <pre>{item.detail}</pre>
        </details>
      ) : (
        <div key={item.id} className={styles.runtimeFeedbackRow} data-kind={item.kind} data-error={item.isError ? "true" : "false"}>
          <span className={styles.runtimeFeedbackIcon}><FeedbackIcon item={item} /></span>
          <span className={styles.runtimeFeedbackLabel}>{item.label}</span>
          {item.agentName && <small>{item.agentName}</small>}
        </div>
      ))}
    </section>
  );
}

async function openArtifactExternal(item: OneRuntimeFeedbackItem) {
  const target = item.path || item.previewUrl;
  if (!target) return;
  const bridge = ipc();
  if (bridge?.fs?.openPath) {
    const result = await bridge.fs.openPath(target).catch(() => ({ ok: false, message: "" }));
    if (result.ok) return;
  }
  window.open(item.previewUrl || target, "_blank", "noopener,noreferrer");
}

export function OneRuntimeArtifactRail({
  items,
  locale,
  chatId,
}: {
  items: OneRuntimeFeedbackItem[];
  locale: "ko" | "en";
  chatId: string | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<TextFilePreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const selected = useMemo(
    () => items.find((item) => (item.path || item.previewUrl || item.id) === selectedPath) ?? null,
    [items, selectedPath],
  );
  useEffect(() => {
    if (selectedPath && !items.some((item) => (item.path || item.previewUrl || item.id) === selectedPath)) {
      setSelectedPath(null);
    }
  }, [items, selectedPath]);
  useEffect(() => {
    setTextPreview(null);
    setPreviewError(false);
    if (!selected?.path || selected.kind === "image" || !chatId) return;
    const bridge = ipc();
    if (!bridge?.fs?.readTextFile) return;
    let cancelled = false;
    void bridge.fs.readTextFile(selected.path, { kind: "chat-workspace", chatId })
      .then((preview) => { if (!cancelled) setTextPreview(preview); })
      .catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; };
  }, [chatId, selected]);
  if (items.length === 0) return null;
  return (
    <aside className={styles.runtimeArtifactRail} aria-label={locale === "ko" ? "작업 산출물" : "Work outputs"} data-one-runtime-artifacts="true">
      <header>
        <strong>{locale === "ko" ? "출력" : "Outputs"}</strong>
        <span>{items.length}</span>
      </header>
      <div className={styles.runtimeArtifactList}>
        {items.map((item) => (
          <button
            key={`${item.kind}:${item.path || item.id}`}
            type="button"
            className={styles.runtimeArtifact}
            data-active={selected === item ? "true" : "false"}
            onClick={() => setSelectedPath((current) => current === (item.path || item.previewUrl || item.id)
              ? null
              : (item.path || item.previewUrl || item.id))}
            title={item.path || item.label}
          >
            {item.previewUrl ? (
              <img src={item.previewUrl} alt="" className={styles.runtimeArtifactPreview} />
            ) : (
              <span className={styles.runtimeArtifactFileIcon}><IconFileUp size={16} /></span>
            )}
            <span>
              <strong>{item.label}</strong>
              <small>{item.kind === "image" ? (locale === "ko" ? "이미지" : "Image") : (locale === "ko" ? "파일" : "File")}</small>
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <section className={styles.runtimeArtifactViewer} data-kind={selected.kind}>
          <header>
            <strong title={selected.path || selected.label}>{selected.label}</strong>
            <button type="button" onClick={() => void openArtifactExternal(selected)}>
              {locale === "ko" ? "외부 열기" : "Open"}
            </button>
          </header>
          {selected.previewUrl ? (
            <img src={selected.previewUrl} alt={selected.label} />
          ) : textPreview ? (
            <>
              {textPreview.truncated && <small>{locale === "ko" ? "큰 파일의 앞부분만 표시합니다" : "Showing the start of a large file"}</small>}
              <pre>{textPreview.content}</pre>
            </>
          ) : (
            <p>{previewError
              ? (locale === "ko" ? "이 채팅의 작업 폴더에서 파일을 읽지 못했습니다." : "Could not read this file from the chat workspace.")
              : (locale === "ko" ? "미리보기를 불러오는 중…" : "Loading preview…")}</p>
          )}
        </section>
      )}
    </aside>
  );
}
