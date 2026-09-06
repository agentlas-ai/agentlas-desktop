"use client";

import { useMemo } from "react";
import { parseMcpResult, type McpResultBlock, type McpResultStatus } from "@shared/mcp-result-rendering";
import { useMediaDisplayPreferences, type MediaDisplayKind } from "@/lib/media-display-preferences";
import styles from "./McpResultPreview.module.css";

function statusLabel(status: McpResultStatus, locale: "ko" | "en"): string {
  if (locale === "ko") {
    return {
      queued: "접수됨",
      pending: "대기 중",
      in_progress: "처리 중",
      completed: "완료",
      failed: "실패",
      cancelled: "취소됨",
    }[status];
  }
  return {
    queued: "Queued",
    pending: "Pending",
    in_progress: "In progress",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }[status];
}

function hostLabel(href: string): string {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return href;
  }
}

function Block({ block, locale }: { block: McpResultBlock; locale: "ko" | "en" }) {
  if (block.kind === "text") return <p className={styles.text}>{block.text}</p>;
  if (block.kind === "status") {
    return (
      <span className={styles.status} data-status={block.status}>
        <span aria-hidden>{block.status === "completed" ? "✓" : block.status === "failed" ? "!" : "•"}</span>
        {statusLabel(block.status, locale)}
        {block.jobId && <small>{block.jobId}</small>}
      </span>
    );
  }
  if (block.kind === "image" || block.kind === "video" || block.kind === "audio") {
    return (
      <div className={styles.mediaCard} data-media-kind={block.kind}>
        {block.kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={block.src} alt={block.label} loading="lazy" referrerPolicy="no-referrer" />
        )}
        {block.kind === "video" && <video src={block.src} aria-label={block.label} controls playsInline preload="metadata" />}
        {block.kind === "audio" && <audio src={block.src} aria-label={block.label} controls preload="metadata" />}
        <span className={styles.mediaLabel}>{block.label}</span>
      </div>
    );
  }
  if (block.kind === "data") {
    /*
     * ★원시 JSON 을 펼친 채로 두지 않는다(2026-09-03 실측).
     *
     * 브라우저 요청 한 번에 채팅이 이런 덩어리로 덮였다:
     *   { "type": "tool_reference",
     *     "tool_name": "mcp__plugin_playwright_playwright__browser_navigate" }
     * 사용자는 내부 도구 이름을 알 필요가 없고, 이 블록은 대화 본문보다 길었다.
     * 증거는 버리지 않는다 — 접어 두고 누르면 그대로 보인다.
     * 라벨도 한국어 화면에서 영어("Structured result")로 남아 있었다.
     */
    return (
      <details className={styles.data}>
        <summary>{block.label === "Structured result" && locale === "ko" ? "자세한 결과" : block.label}</summary>
        <pre>{block.value}</pre>
      </details>
    );
  }
  if (block.kind === "file" || block.kind === "link") {
    return (
      <a className={styles.linkCard} href={block.href} target="_blank" rel="noreferrer" title={block.href}>
        <span className={styles.linkIcon} aria-hidden>{block.kind === "file" ? "▣" : "↗"}</span>
        <span className={styles.linkCopy}>
          <strong>{block.label}</strong>
          <small>{hostLabel(block.href)}</small>
        </span>
      </a>
    );
  }
  return null;
}

export function McpResultPreview({
  result,
  toolName,
  locale = "ko",
  compact = false,
  placement = "chat",
}: {
  result?: string | null;
  toolName?: string;
  locale?: "ko" | "en";
  compact?: boolean;
  placement?: "chat" | "sidebar";
}) {
  const presentation = useMemo(() => parseMcpResult(result, toolName), [result, toolName]);
  const { preferences } = useMediaDisplayPreferences();
  if (!result || presentation.blocks.length === 0) return null;
  const allMedia = presentation.blocks.filter((block) => block.kind === "image" || block.kind === "video" || block.kind === "audio");
  const media = placement === "sidebar"
    ? allMedia.filter((block) => preferences[block.kind as MediaDisplayKind])
    : allMedia;
  const hiddenCount = allMedia.length - media.length;
  const other = presentation.blocks.filter((block) => block.kind !== "image" && block.kind !== "video" && block.kind !== "audio");
  return (
    <section className={styles.preview} data-mcp-result-preview="true" data-compact={compact ? "true" : "false"} aria-label={locale === "ko" ? "MCP 결과" : "MCP result"}>
      <div className={styles.header}>
        <strong>{locale === "ko" ? "MCP 결과" : "MCP result"}</strong>
        {toolName && <span className={styles.provider} title={toolName}>{toolName}</span>}
      </div>
      {presentation.status && presentation.status !== "completed" && (
        <span className={styles.status} data-status={presentation.status}>
          <span aria-hidden>•</span>{statusLabel(presentation.status, locale)}
          {presentation.jobId && <small>{presentation.jobId}</small>}
        </span>
      )}
      {media.length > 0 && <div className={styles.mediaGrid}>{media.map((block) => <Block key={block.id} block={block} locale={locale} />)}</div>}
      {hiddenCount > 0 && <p className={styles.hiddenNotice}>{locale === "ko" ? `미디어 ${hiddenCount}개는 설정에서 숨겨져 있습니다.` : `${hiddenCount} media item(s) hidden by your settings.`}</p>}
      {other.length > 0 && <div className={styles.linkList}>{other.map((block) => <Block key={block.id} block={block} locale={locale} />)}</div>}
      {presentation.warnings.length > 0 && <p className={styles.warning}>{locale === "ko" ? "일부 결과는 안전하지 않은 주소 또는 크기 제한으로 표시하지 않았습니다." : "Some result parts were omitted because their URL or size was unsafe."}</p>}
    </section>
  );
}
