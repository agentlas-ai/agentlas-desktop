"use client";

import { useId, useState } from "react";
import { IconChevronDown, IconFileText, IconFileUp, IconImage } from "@/components/Icon";
import { formatChatFileSize, viewerKindForChatFile } from "@/lib/chat-files";
import { requestOneArtifactOpen } from "@/lib/one-artifact-open";
import { ONE_EARLIER_OUTPUTS_REVEAL, type OneEarlierOutputItem, type OneEarlierOutputsView } from "@/lib/one-earlier-outputs";
import styles from "./EarlierOutputsSection.module.css";

type Locale = "ko" | "en";

/** The section's words, in both languages (the workspace panels keep their own ko/en pairs beside the markup that uses them). */
const COPY = {
  ko: {
    title: "이전 결과",
    list: "이전 실행에서 만든 결과",
    open: (name: string) => `${name} 열기`,
    showMore: (count: number) => `${count}개 더 보기`,
    loading: "불러오는 중",
  },
  en: {
    title: "Earlier outputs",
    list: "Outputs made by earlier runs",
    open: (name: string) => `Open ${name}`,
    showMore: (count: number) => `Show ${count} more`,
    loading: "Loading",
  },
} as const;

function extensionOf(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? name;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toUpperCase().slice(0, 6) : "";
}

/** "MD · 2.1 KB · Oct 12": the kind of file, its size and the day the run saved it. */
function rowMeta(item: OneEarlierOutputItem, locale: Locale): string {
  const parts: string[] = [];
  const extension = extensionOf(item.artifact.label);
  if (extension) parts.push(extension);
  if (item.sizeBytes > 0) parts.push(formatChatFileSize(item.sizeBytes));
  const saved = item.savedAt ? new Date(item.savedAt) : null;
  if (saved && Number.isFinite(saved.getTime())) {
    const sameYear = saved.getFullYear() === new Date().getFullYear();
    parts.push(saved.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }));
  }
  return parts.join(" · ");
}

function RowIcon({ item }: { item: OneEarlierOutputItem }) {
  if (item.artifact.kind === "image") return <IconImage size={15} />;
  const kind = viewerKindForChatFile(item.artifact.label, "file");
  return kind === "document" || kind === "pdf" || kind === "markdown" || kind === "text"
    ? <IconFileText size={15} />
    : <IconFileUp size={15} />;
}

/**
 * The Outputs rail's "Earlier outputs": what earlier runs of this conversation saved, under the newest run's own list.
 * Collapsed until the person opens it. Each entry opens through the rail's existing preview path (the exact binding check),
 * so an entry whose file a later run saved again opens the newest save of it.
 */
export function EarlierOutputsSection({ view, locale }: { view: OneEarlierOutputsView; locale: Locale }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const copy = COPY[locale];
  const remaining = Math.max(0, view.count - view.items.length);
  return (
    <section className={styles.section} data-one-earlier-outputs="true" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{copy.title}</span>
        <strong data-one-earlier-outputs-count="true">{view.count}{view.truncated ? "+" : ""}</strong>
        <span className={styles.chevron} aria-hidden="true"><IconChevronDown size={13} /></span>
      </button>
      {open && (
        <div id={listId} className={styles.body}>
          <ul className={styles.list} aria-label={copy.list}>
            {view.items.map((item) => (
              <li key={item.artifact.id}>
                <button
                  type="button"
                  className={styles.row}
                  data-one-earlier-output="true"
                  title={item.artifact.label}
                  aria-label={copy.open(item.artifact.label)}
                  onClick={() => requestOneArtifactOpen({ binding: item.artifact.binding, label: item.artifact.label })}
                >
                  <span className={styles.icon} aria-hidden="true"><RowIcon item={item} /></span>
                  <span className={styles.copy}>
                    <span className={styles.name}>{item.artifact.label}</span>
                    <span className={styles.meta}>{rowMeta(item, locale)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {view.hasMore && (
            <button type="button" className={styles.more} disabled={view.loadingMore} onClick={view.showMore} data-one-earlier-outputs-more="true">
              {view.loadingMore
                ? copy.loading
                : copy.showMore(Math.max(1, Math.min(ONE_EARLIER_OUTPUTS_REVEAL, remaining || ONE_EARLIER_OUTPUTS_REVEAL)))}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
