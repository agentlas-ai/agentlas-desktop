"use client";

import {
  IconCode,
  IconFileUp,
  IconImage,
  IconShield,
  IconSparkles,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { OneRuntimeFeedbackItem } from "@/lib/one-runtime-feedback";
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

async function openArtifact(item: OneRuntimeFeedbackItem) {
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
}: {
  items: OneRuntimeFeedbackItem[];
  locale: "ko" | "en";
}) {
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
            onClick={() => void openArtifact(item)}
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
    </aside>
  );
}
