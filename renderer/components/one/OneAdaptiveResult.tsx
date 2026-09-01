"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { LiveOutputViewer } from "@/components/LiveOutputViewer";
import type { Automation, InstalledMcpServer } from "@/lib/types";
import type {
  InvocationRunReceipt,
  OneExperienceReuseRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneValueClosureRecord,
  OneValueClosureState,
} from "@/lib/types";
import type { OneTaskProjection } from "@/lib/one-task-adapter";
import {
  ONE_SURFACE_BLOCK_TYPES,
  type OneSurfaceAgentBuildBlock,
  type OneSurfaceArtifactSummary,
  type OneSurfaceArtifactListBlock,
  type OneSurfaceAutomationBlock,
  type OneSurfaceBudgetBlock,
  type OneSurfaceBlock,
  type OneSurfaceChecklistBlock,
  type OneSurfaceComparisonBlock,
  type OneSurfaceDecisionBlock,
  type OneSurfaceDocumentBlock,
  type OneSurfaceGalleryBlock,
  type OneSurfaceMediaBlock,
  type OneSurfaceManifestV1,
  type OneSurfaceMapBlock,
  type OneSurfaceMcpSetupBlock,
  type OneSurfaceMetricBlock,
  type OneSurfaceNarrativeBlock,
  type OneSurfaceSourceListBlock,
  type OneSurfaceStatusBlock,
  type OneSurfaceSemanticAction,
  type OneSurfaceTableBlock,
  type OneSurfaceTimelineBlock,
  type OneSurfaceBlockType,
} from "@shared/one-surface";
import {
  isOneArtifactPreviewCapabilityV1,
  type OneArtifactBindingRequestV1,
  type OneArtifactPreviewCapabilityV1,
} from "@shared/one-artifacts";
import { redactSecrets } from "@shared/secret-patterns";
import { stripAgentIdentityBadges } from "@shared/agent-control-blocks";
import { ipc } from "@/lib/ipc";
import { tFor } from "@/lib/i18n";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { requestOneArtifactOpen } from "@/lib/one-artifact-open";
import { useMediaDisplayPreferences } from "@/lib/media-display-preferences";
import { designOutputSurfaceProps } from "@/lib/design-output-tokens";
import { OneLiveMap } from "./OneLiveMap";
import styles from "./OneAdaptiveResult.module.css";

export type OneAgentDraftSeed = {
  name: string;
  title?: string;
  description?: string;
};

const DESKTOP_NATIVE_BLOCK_TYPES = new Set<OneSurfaceBlockType>([
  "Narrative",
  "Metric",
  "Table",
  "Comparison",
  "Timeline",
  "Map",
  "Gallery",
  "Media",
  "Document",
  "ArtifactList",
  "SourceList",
  "Decision",
  "Status",
  "Budget",
  "Checklist",
  "ValueClosure",
  "ImprovementProof",
  "Automation",
  "AgentBuild",
  "McpSetup",
]);
const DESKTOP_FALLBACK_BLOCK_TYPES = new Set<OneSurfaceBlockType>(
  ONE_SURFACE_BLOCK_TYPES.filter((type) => !DESKTOP_NATIVE_BLOCK_TYPES.has(type)),
);
const DEDICATED_RESULT_BLOCK_TYPES = new Set<OneSurfaceBlockType>([
  // A structured result is its own final answer, not a second Markdown
  // transcript beneath a provider's progress narration. Keep the complete
  // verification/result surface together in one readable card.
  "ArtifactList",
  "Budget",
  "Checklist",
  "Comparison",
  "Decision",
  "Map",
  "Metric",
  "SourceList",
  "Status",
  "Table",
  "Timeline",
  "Gallery",
  "Media",
  "Document",
  "Automation",
  "AgentBuild",
  "McpSetup",
]);

/**
 * Keep a plain narrative in the chronological conversation like Codex. A
 * structured result owns its complete final card so provider progress prose
 * cannot compete with the actual checks, decision, artifacts, or evidence.
 */
export function oneSurfaceNeedsDedicatedResult(manifest: OneSurfaceManifestV1 | null): boolean {
  return Boolean(manifest?.blocks.some((block) => DEDICATED_RESULT_BLOCK_TYPES.has(block.type)));
}

export function OneAdaptiveResult({
  manifest,
  projection,
  receipt,
  locale,
  onRetryUnfinished,
  onSemanticAction,
  onOpenAgentDraft,
  autoRecovery,
  omitNarrative = false,
  inOutputRail = false,
}: {
  manifest: OneSurfaceManifestV1 | null;
  projection: OneTaskProjection;
  receipt: InvocationRunReceipt | null;
  locale: "ko" | "en";
  /**
   * The thread already shows the model's answer as Markdown (Codex parity).
   * Skip the Surface's flattened Narrative blocks and the title/summary header
   * so the card carries only what the answer text cannot: files, sources,
   * decisions, checklists, actions.
   */
  omitNarrative?: boolean;
  onSemanticAction?: (action: OneSurfaceSemanticAction) => void;
  /** Keep agent definition review inside One instead of navigating to Build. */
  onOpenAgentDraft?: (seed: OneAgentDraftSeed) => void;
  valueClosure?: OneValueClosureRecord | null;
  experienceReuse?: OneExperienceReuseRecord | null;
  onManageExperience?: () => void;
  valueClosureState?: OneValueClosureState | null;
  onValueClosureStateChange?: (state: OneValueClosureState) => void;
  improvementProof?: OneImprovementProofRecord | null;
  onManageImprovementAsset?: (asset: OneImprovementReusedAssetV1) => void;
  /** 끝까지 완료되지 않은 실행을 한 번의 클릭으로 이어서 진행한다. */
  onRetryUnfinished?: () => void;
  /** Render rich media/document surfaces as a full-height in-app result. */
  inOutputRail?: boolean;
  /**
   * One's own recovery state. While One is still routing around the obstacle
   * there is no failure to report yet, so the closure card must not claim one.
   */
  autoRecovery?:
    | { phase: "recovering"; attempt: number; diagnosis: string }
    | { phase: "stopped"; reason: string; diagnosis: string }
    | null;
}) {
  const surface = useMemo(() => manifest && isOneSurfaceManifestV1(manifest) ? manifest : null, [manifest]);
  const renderDecision = useMemo(() => surface ? inspectSurfaceForDesktop(surface, projection.taskId) : null, [projection.taskId, surface]);
  const fallback = useMemo(() => readSafeFallback(manifest, projection.taskId), [manifest, projection.taskId]);
  const dedicatedBlocks = useMemo(
    // ValueClosure·ImprovementProof 는 참조 한 줄만 들고 있고 진짜 카드는 기억 화면에
    // 산다. 결과 카드에서 일부러 빼는 것이지 빠뜨린 게 아니다.
    () => (renderDecision?.blocks ?? []).filter((block) => (
      block.type !== "ValueClosure"
      && block.type !== "ImprovementProof"
      && !(omitNarrative && block.type === "Narrative")
    )),
    [omitNarrative, renderDecision],
  );
  const hasNativeResult = Boolean(
    surface && renderDecision?.native && oneSurfaceNeedsDedicatedResult(surface)
    && (!omitNarrative || dedicatedBlocks.length > 0),
  );
  /*
   * ★ 준비된 대체 카드가 닿지 못하던 자리 (2026-08-24 실측).
   *
   * 검사는 **전부 아니면 전무**다 — 스무 개 블록 중 하나만 규격에 어긋나도
   * `native` 가 통째로 false 가 되고 블록 목록은 빈 배열이 된다. 그런데 대체 카드는
   * `hasDedicatedResult` 안쪽에 있었고, 그 값이 `native` 를 요구했다. 즉 대체 카드가
   * 필요한 유일한 상황에서 그 카드는 절대 그려질 수 없었다 — 사용자는 이유도 없는
   * **빈 카드**를 본다. 실측: fixture 20종 중 Media 하나가 걸리자 20개 전부 사라졌다.
   *
   * 그래서 native 는 "어느 쪽을 그릴지" 고르는 데만 쓰고, 카드를 낼지 말지는
   * 결과 블록이 있느냐로 정한다.
   */
  const hasFallbackResult = Boolean(
    surface && !renderDecision?.native && oneSurfaceNeedsDedicatedResult(surface),
  );
  const hasDedicatedResult = hasNativeResult || hasFallbackResult;
  const showNative = Boolean(surface && renderDecision?.native);
  const hasSourceListBlock = Boolean(surface?.blocks.some((block) => block.type === "SourceList"));
  const semanticActions = showNative && surface
    ? [surface.primaryAction, ...surface.secondaryActions].filter(
        (action): action is OneSurfaceSemanticAction => Boolean(
          action?.enabled && action.intent !== "open_work",
        ),
      )
    : [];
  const artifactContext = useMemo<OneArtifactBindingRequestV1 | null>(() => (
    surface && projection.chatId && receipt?.runId
      ? {
          taskId: projection.taskId,
          taskVersion: projection.canonicalVersion,
          chatId: projection.chatId,
          runId: receipt.runId,
          manifestId: surface.manifestId,
          artifactRef: "one:placeholder",
        }
      : null
  ), [projection.canonicalVersion, projection.chatId, projection.taskId, receipt?.runId, surface]);

  return (
    <section
      {...designOutputSurfaceProps("report", styles.root)}
      data-output-rail={inOutputRail ? "true" : "false"}
      aria-label={tFor(locale, "one.res.aria.work_result")}
    >
      {hasDedicatedResult && (
        <article className={styles.result} data-surface-contract={surface?.contractVersion ?? "invalid"} data-narrative={omitNarrative ? "omitted" : "inline"}>
          {!omitNarrative && (
            <header className={styles.header}>
              <div className={styles.headerCopy}>
                <h3>{showNative && surface ? friendlySurfaceTitle(surface, locale) : tFor(locale, "one.res.title.too_large")}</h3>
                <p className={styles.summary}>{showNative && surface
                  ? friendlySurfaceSummary(surface.summary, locale)
                  : tFor(locale, "one.res.summary.open_work")}</p>
              </div>
            </header>
          )}
          <div className={styles.body}>
            {showNative && renderDecision ? dedicatedBlocks
              .map((block) => (
              <NativeBlock
                key={block.blockId}
                block={block}
                locale={locale}
                artifactContext={artifactContext}
                onSemanticAction={onSemanticAction}
                onOpenAgentDraft={onOpenAgentDraft}
                inOutputRail={inOutputRail}
              />
            )) : (
              <FallbackResult
                fallback={fallback}
                reasons={renderDecision?.reasons ?? ["surface:invalid-manifest"]}
                locale={locale}
              />
            )}
          </div>
          {semanticActions.length > 0 && (
            <div className={styles.actions} aria-label={tFor(locale, "one.res.next_actions")}>
              <strong>{tFor(locale, "one.res.next_actions")}</strong>
              {semanticActions.map((action, index) => (
              <button
                key={action.actionId}
                type="button"
                className={index === 0 ? styles.actionPrimary : styles.action}
                onClick={() => onSemanticAction?.(action)}
                disabled={!onSemanticAction}
              >
                <span>{displayValue(action.label)}</span>
                {action.description && <small>{displayValue(action.description)}</small>}
              </button>
              ))}
            </div>
          )}
          {showNative && surface && surface.evidence.length > 0 && !hasSourceListBlock && (
            <details className={styles.evidence}>
              <summary>{tFor(locale, "one.res.sources_count", { n: surface.evidence.length })}</summary>
              {surface.evidence.map((item) => (
                <span key={item.evidenceRef}>
                  {displayValue(item.label ?? item.evidenceRef)} · {verificationLabel(item.verificationStatus, locale)}
                </span>
              ))}
            </details>
          )}
        </article>
      )}
      {receipt && isTerminal(receipt.status) && receipt.status !== "completed" && (
        <RunClosure
          receipt={receipt}
          locale={locale}
          onRetryUnfinished={onRetryUnfinished}
          autoRecovery={autoRecovery}
        />
      )}
      {/* Value/experience/proof records keep compounding internally. They are
          deliberately absent from the ordinary One conversation surface. */}
    </section>
  );
}

type SafeFallbackArtifact = OneSurfaceArtifactSummary;

interface SafeFallback {
  markdown: string | null;
  artifacts: SafeFallbackArtifact[];
}

function FallbackResult({
  fallback,
  reasons,
  locale,
}: {
  fallback: SafeFallback;
  reasons: string[];
  locale: "ko" | "en";
}) {
  const hasSafeContent = Boolean(fallback.markdown || fallback.artifacts.length > 0);
  return (
    <div className={styles.block} data-render-fallback="true">
      {fallback.markdown ? (
        <SafeFallbackMarkdown markdown={fallback.markdown} />
      ) : (
        <p className={styles.summary}>{tFor(locale, "one.res.fallback.cannot_show")}</p>
      )}
      {fallback.artifacts.length > 0 && (
        <section className={styles.fallbackArtifacts} aria-label={tFor(locale, "one.res.aria.result_files")}>
          <h4>{tFor(locale, "one.res.fallback.checked_files")}</h4>
          <div className={styles.cardGrid}>
            {fallback.artifacts.map((artifact) => (
              <div
                className={styles.card}
                key={artifact.artifactRef}
                data-artifact-ref={artifact.artifactRef}
                data-verification-status={artifact.verificationStatus}
              >
                <strong>{displayValue(artifact.label)}</strong>
                <span>
                  {artifactTypeLabel(artifact.type, locale)} · {verificationLabel(artifact.verificationStatus, locale)}
                  {artifact.sizeBytes != null ? ` · ${formatBytes(artifact.sizeBytes)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {!hasSafeContent && (
        <p className={styles.fallbackNotice}>{tFor(locale, "one.res.fallback.only_safe")}</p>
      )}
      <details className={styles.evidence}>
        <summary>{tFor(locale, "one.res.fallback.why_not_shown")}</summary>
        {reasons.map((reason) => <span key={reason}>{displayValue(reason)}</span>)}
      </details>
    </div>
  );
}

function SafeFallbackMarkdown({ markdown }: { markdown: string }) {
  const sections = markdown.split(/\n{2,}/).map((section) => section.trim()).filter(Boolean);
  return (
    <div className={styles.fallbackMarkdown} data-fallback-markdown="true">
      {sections.map((section, index) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(section);
        if (heading && !heading[2].includes("\n")) {
          return <h4 key={index}>{heading[2]}</h4>;
        }
        const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
          return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
        }
        if (lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line))) {
          return <ol key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{line.replace(/^\d+\.\s+/, "")}</li>)}</ol>;
        }
        return <p key={index}>{lines.join(" ")}</p>;
      })}
    </div>
  );
}

function NativeBlock({
  block,
  locale,
  artifactContext,
  onSemanticAction,
  onOpenAgentDraft,
  inOutputRail,
}: {
  block: OneSurfaceBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  onSemanticAction?: (action: OneSurfaceSemanticAction) => void;
  onOpenAgentDraft?: (seed: OneAgentDraftSeed) => void;
  inOutputRail?: boolean;
}) {
  const title = friendlyBlockTitle(block, locale);
  return (
    <section
      className={styles.block}
      aria-labelledby={`${block.blockId}-title`}
      data-semantic-id={block.blockId}
      data-block-kind={block.type}
    >
      <h4 id={`${block.blockId}-title`}>{title}</h4>
      {block.type === "Narrative" && <NarrativeBlock block={block} />}
      {block.type === "Metric" && <MetricBlock block={block} locale={locale} />}
      {block.type === "Table" && <TableBlock block={block} locale={locale} />}
      {block.type === "Comparison" && <ComparisonBlock block={block} locale={locale} />}
      {block.type === "Timeline" && <TimelineBlock block={block} locale={locale} />}
      {block.type === "Map" && <MapBlock block={block} locale={locale} />}
      {block.type === "Gallery" && (
        <GalleryBlock block={block} locale={locale} artifactContext={artifactContext} inOutputRail={inOutputRail} />
      )}
      {block.type === "Media" && (
        <MediaBlock block={block} locale={locale} artifactContext={artifactContext} inOutputRail={inOutputRail} />
      )}
      {block.type === "Document" && <DocumentBlock block={block} locale={locale} artifactContext={artifactContext} inOutputRail={inOutputRail} />}
      {block.type === "ArtifactList" && <ArtifactListBlock block={block} locale={locale} artifactContext={artifactContext} />}
      {block.type === "SourceList" && <SourceListBlock block={block} locale={locale} />}
      {block.type === "Decision" && <DecisionBlock block={block} locale={locale} />}
      {block.type === "Status" && <StatusBlock block={block} locale={locale} />}
      {block.type === "Budget" && <BudgetBlock block={block} locale={locale} />}
      {block.type === "Checklist" && <ChecklistBlock block={block} locale={locale} />}
      {block.type === "Automation" && <AutomationBlock block={block} locale={locale} onSemanticAction={onSemanticAction} />}
      {block.type === "AgentBuild" && <AgentBuildBlock block={block} locale={locale} onOpenDraft={onOpenAgentDraft} />}
      {block.type === "McpSetup" && <McpSetupBlock block={block} locale={locale} />}
    </section>
  );
}

function NarrativeBlock({ block }: { block: OneSurfaceNarrativeBlock }) {
  const paragraphs = block.paragraphs.map(displayValue).filter(Boolean);
  return <div>{paragraphs.map((paragraph, index) => <p className={styles.summary} key={index}>{paragraph}</p>)}</div>;
}

function MetricBlock({ block, locale }: { block: OneSurfaceMetricBlock; locale: "ko" | "en" }) {
  return (
    <div className={styles.metricGrid}>
      {block.items.map((item) => (
        <div className={styles.metric} key={item.metricId}>
          <strong>{displayValue(item.value)}{item.unit ? ` ${displayValue(item.unit)}` : ""}</strong>
          <span>{displayValue(item.label)} · {verificationLabel(item.verificationStatus, locale)}</span>
        </div>
      ))}
    </div>
  );
}

function TableBlock({ block, locale }: { block: OneSurfaceTableBlock; locale: "ko" | "en" }) {
  const columns = block.columns.filter((column) => !isInternalColumnLabel(column.label));
  const labels = new Map(columns.map((column) => [column.columnId, column.label]));
  if (isStepTable(columns)) return <StepTable block={block} columns={columns} locale={locale} />;
  const renderTable = () => (
    <div className={styles.tableWrap} tabIndex={0} aria-label={tFor(locale, "one.res.table.aria", { title: block.title })}>
      <table className={styles.table}>
        <thead><tr>{columns.map((column) => <th key={column.columnId} scope="col">{displayValue(column.label)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row) => {
          const cells = new Map(row.cells.map((cell) => [cell.columnId, cell.value]));
          return <tr key={row.rowId}>{columns.map((column) => <td key={column.columnId} data-column={labels.get(column.columnId)}>{displayValue(cells.get(column.columnId))}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
  );
  return (
    <>
      <div className={styles.desktopTable}>{renderTable()}</div>
      <details className={styles.mobileTable}>
        <summary>{tFor(locale, "one.res.table.see_full")}</summary>
        {renderTable()}
      </details>
    </>
  );
}

function isInternalColumnLabel(value: string): boolean {
  return /^(?:evidence|source|provenance)[ _-]?(?:id|ids|ref|refs)$/i.test(value.replace(/\s+/g, ""));
}

function isStepTable(columns: OneSurfaceTableBlock["columns"]): boolean {
  return columns.length >= 2 && columns.some((column) => /^(?:순서|단계|step|order)$/i.test(column.label.trim()));
}

function StepTable({ block, columns, locale }: { block: OneSurfaceTableBlock; columns: OneSurfaceTableBlock["columns"]; locale: "ko" | "en" }) {
  const orderColumn = columns.find((column) => /^(?:순서|단계|step|order)$/i.test(column.label.trim())) ?? columns[0];
  const purposeColumn = columns.find((column) => /(?:무엇|검사|내용|purpose|what)/i.test(column.label));
  const commandColumn = columns.find((column) => /(?:명령|command)/i.test(column.label));
  const reasonColumn = columns.find((column) => /(?:왜|이유|reason)/i.test(column.label));
  return (
    <ol className={styles.workflowSteps} aria-label={tFor(locale, "one.res.steptable.aria", { title: block.title })}>
      {block.rows.map((row, index) => {
        const cells = new Map(row.cells.map((cell) => [cell.columnId, cell.value]));
        return <li key={row.rowId}>
          <b aria-hidden="true">{index + 1}</b>
          <div>
            <strong>{displayValue(cells.get(orderColumn.columnId))}</strong>
            {purposeColumn && <p>{displayValue(cells.get(purposeColumn.columnId))}</p>}
            {commandColumn && <code>{displayValue(cells.get(commandColumn.columnId))}</code>}
            {reasonColumn && <small>{displayValue(cells.get(reasonColumn.columnId))}</small>}
          </div>
        </li>;
      })}
    </ol>
  );
}

function friendlyBlockTitle(block: OneSurfaceBlock, locale: "ko" | "en"): string {
  const title = displayValue(block.title);
  if (!/^(?:items?|data|results?|rows?)$/i.test(title.trim())) return title;
  if (block.type === "Table" && isStepTable(block.columns.filter((column) => !isInternalColumnLabel(column.label)))) {
    return tFor(locale, "one.res.block.follow_steps");
  }
  if (block.type === "Checklist") return tFor(locale, "one.res.block.to_do");
  return tFor(locale, "one.res.block.at_a_glance");
}

function friendlySurfaceSummary(value: string, locale: "ko" | "en"): string {
  const summary = displayValue(value);
  if (/^(?:확인한 결과를 한눈에 볼 수 있게 정리했습니다\.|The result is organized for a quick review\.)$/i.test(summary)) {
    return tFor(locale, "one.res.summary.parts_you_need");
  }
  return summary;
}

function friendlySurfaceTitle(surface: OneSurfaceManifestV1, locale: "ko" | "en"): string {
  const title = displayValue(surface.title);
  const looksLikePrompt = title.length > 88
    || /\[local path\]|\b(?:task|작업)\s*[:：]/i.test(title)
    || /\b\d+\s*\/\s*\d+\b/.test(title);
  if (!looksLikePrompt) return title;
  const firstUsefulBlock = surface.blocks.find((block) => DEDICATED_RESULT_BLOCK_TYPES.has(block.type));
  return firstUsefulBlock ? friendlyBlockTitle(firstUsefulBlock, locale) : tFor(locale, "one.res.title.result");
}

function provenanceLabel(
  value: OneSurfaceGalleryBlock["items"][number]["provenance"],
  locale: "ko" | "en",
): string {
  const keys = {
    user_original: "one.res.prov.user_original",
    generated: "one.res.prov.generated",
    edited: "one.res.prov.edited",
    licensed_source: "one.res.prov.licensed_source",
    unknown_source: "one.res.prov.unknown_source",
  } as const;
  return tFor(locale, keys[value]);
}

function formatTimelineAt(value: string, locale: "ko" | "en"): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return displayValue(value);
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function timelineStateLabel(value: string, locale: "ko" | "en"): string {
  const keys = {
    upcoming: "one.res.timeline.upcoming",
    in_progress: "one.res.timeline.in_progress",
    completed: "one.res.timeline.completed",
    failed: "one.res.timeline.failed",
    cancelled: "one.res.timeline.cancelled",
  } as const;
  const key = keys[value as keyof typeof keys];
  return key ? tFor(locale, key) : displayValue(value);
}

function timelineTitleParts(value: string): { lead: string; body: string } | null {
  const title = displayValue(value);
  const match = /^(\d{1,2}일차|Day[ \t]+\d{1,2}|\d{1,2}\/\d{1,2}(?:\([^)]+\))?)[ \t]*(?:·|—|-)[ \t]*(.+)$/i.exec(title);
  return match ? { lead: match[1], body: match[2] } : null;
}

function TimelineBlock({ block, locale }: { block: OneSurfaceTimelineBlock; locale: "ko" | "en" }) {
  return (
    <ol className={styles.timeline}>
      {block.items.map((item) => {
        const parts = item.at ? null : timelineTitleParts(item.title);
        return (
          <li key={item.itemId}>
            <time dateTime={item.at}>{item.at ? formatTimelineAt(item.at, locale) : parts?.lead ?? timelineStateLabel(item.status, locale)}</time>
            <span>{parts?.body ?? displayValue(item.title)}{item.detail ? ` · ${displayValue(item.detail)}` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ComparisonBlock({ block, locale }: { block: OneSurfaceComparisonBlock; locale: "ko" | "en" }) {
  return (
    <div className={styles.comparisonGrid}>
      {block.options.map((option) => {
        const recommended = option.optionRef === block.recommendedOptionRef;
        return <article className={styles.comparisonCard} data-recommended={recommended ? "true" : "false"} key={option.optionRef}>
          <div className={styles.comparisonHeading}>
            <div><strong>{displayValue(option.title)}</strong>{option.subtitle && <span>{displayValue(option.subtitle)}</span>}</div>
            {recommended && <b>{tFor(locale, "one.res.compare.recommended")}</b>}
          </div>
          <div className={styles.comparisonColumns}>
            <section><span>{tFor(locale, "one.res.compare.strengths")}</span><ul>{option.strengths.map((item, index) => <li key={index}>{displayValue(item)}</li>)}</ul></section>
            <section><span>{tFor(locale, "one.res.compare.limitations")}</span><ul>{option.limitations.map((item, index) => <li key={index}>{displayValue(item)}</li>)}</ul></section>
          </div>
        </article>;
      })}
    </div>
  );
}

function MapBlock({ block, locale }: { block: OneSurfaceMapBlock; locale: "ko" | "en" }) {
  return <OneLiveMap block={block} locale={locale} />;
}

type ArtifactPreviewState =
  | { status: "loading"; capability: null }
  | { status: "ready"; capability: OneArtifactPreviewCapabilityV1 }
  | { status: "unavailable"; capability: null };

function useArtifactPreview(
  context: OneArtifactBindingRequestV1 | null,
  artifactRef: string,
  label = artifactRef,
): { state: ArtifactPreviewState; retry: () => void; open: () => Promise<boolean> } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ArtifactPreviewState>({ status: context ? "loading" : "unavailable", capability: null });
  useEffect(() => {
    const api = ipc();
    if (!api?.oneArtifacts || !context) {
      setState({ status: "unavailable", capability: null });
      return;
    }
    let active = true;
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    const request = { ...context, artifactRef };
    setState({ status: "loading", capability: null });
    void api.oneArtifacts.issuePreview(request).then((value) => {
      const capability = isOneArtifactPreviewCapabilityV1(value) ? value : null;
      issued = capability;
      if (!active) {
        if (capability) void api.oneArtifacts.revokePreview({ ...request, capabilityUrl: capability.capabilityUrl });
        return;
      }
      setState(capability
        ? { status: "ready", capability }
        : { status: "unavailable", capability: null });
    }).catch(() => {
      if (active) setState({ status: "unavailable", capability: null });
    });
    return () => {
      active = false;
      if (issued) void api.oneArtifacts.revokePreview({ ...request, capabilityUrl: issued.capabilityUrl });
    };
  }, [
    artifactRef,
    attempt,
    context?.artifactRef,
    context?.chatId,
    context?.manifestId,
    context?.runId,
    context?.taskId,
    context?.taskVersion,
  ]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const open = useCallback(async () => {
    if (!context) return false;
    requestOneArtifactOpen({ binding: { ...context, artifactRef }, label });
    return true;
  }, [artifactRef, context, label]);
  return { state, retry, open };
}

function GalleryBlock({
  block,
  locale,
  artifactContext,
  inOutputRail = false,
}: {
  block: OneSurfaceGalleryBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  inOutputRail?: boolean;
}) {
  return (
    <div className={styles.galleryGrid} data-output-rail={inOutputRail ? "true" : "false"} role="list" aria-label={block.title}>
      {block.items.map((item) => (
        <GalleryItem
          key={item.artifactRef}
          item={item}
          locale={locale}
          artifactContext={artifactContext}
          inOutputRail={inOutputRail}
        />
      ))}
    </div>
  );
}

function GalleryItem({
  item,
  locale,
  artifactContext,
  inOutputRail = false,
}: {
  item: OneSurfaceGalleryBlock["items"][number];
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  inOutputRail?: boolean;
}) {
  const preview = useArtifactPreview(artifactContext, item.artifactRef, item.label);
  const { preferences } = useMediaDisplayPreferences();
  const [mediaFailed, setMediaFailed] = useState(false);
  const hidden = inOutputRail && !preferences.image;
  const unavailable = preview.state.status === "unavailable" || mediaFailed;
  return (
    <article className={styles.galleryItem} data-output-rail={inOutputRail ? "true" : "false"} role="listitem" aria-busy={preview.state.status === "loading"}>
      <div className={styles.galleryFrame}>
        {hidden
          ? <div className={styles.mediaHidden} role="status">{locale === "ko" ? "사진이 설정에서 숨겨져 있습니다." : "Photo hidden by your settings."}</div>
          : <>
            {preview.state.status === "loading" && <div className={styles.mediaSkeleton} role="status" aria-label={tFor(locale, "one.res.gallery.loading_image")}><LoadingEstimate locale={locale} operationKey="one-artifact-image-preview" expectedSeconds={[1, 15]} /></div>}
            {preview.state.status === "ready" && !mediaFailed && (
              // The source is a short-lived Main capability, never a file path or remote model URL.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.state.capability.capabilityUrl}
                alt={displayValue(item.altText)}
                loading="lazy"
                draggable={false}
                referrerPolicy="no-referrer"
                onError={() => setMediaFailed(true)}
              />
            )}
            {unavailable && (
              <div className={styles.mediaUnavailable} role="status">
                <span>{tFor(locale, "one.res.media.preview_unavailable")}</span>
                <button type="button" onClick={() => { setMediaFailed(false); preview.retry(); }}>{tFor(locale, "one.res.retry")}</button>
              </div>
            )}
          </>}
      </div>
      <div className={styles.mediaMeta}>
        <div><strong>{displayValue(item.label)}</strong><span>{provenanceLabel(item.provenance, locale)}</span></div>
        <button type="button" aria-label={`${tFor(locale, "one.res.open_file")}: ${displayValue(item.label)}`} onClick={() => void preview.open()}>{tFor(locale, "one.res.open_file")}</button>
      </div>
    </article>
  );
}

function MediaBlock({
  block,
  locale,
  artifactContext,
  inOutputRail = false,
}: {
  block: OneSurfaceMediaBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  inOutputRail?: boolean;
}) {
  const preview = useArtifactPreview(artifactContext, block.primaryArtifactRef, block.caption ?? block.title);
  const unavailable = preview.state.status === "unavailable";
  const capabilityUrl = preview.state.status === "ready" ? preview.state.capability.capabilityUrl : null;
  return (
    <div className={styles.mediaLayout}>
      <div className={styles.primaryMedia} aria-busy={preview.state.status === "loading"}>
        {preview.state.status === "loading" && <div className={styles.mediaSkeleton} role="status" aria-label={tFor(locale, "one.res.media.loading")}><LoadingEstimate locale={locale} operationKey="one-artifact-media-preview" expectedSeconds={[1, 20]} /></div>}
        {capabilityUrl && <LiveOutputViewer source={capabilityUrl} name={displayValue(block.caption ?? block.title)} kind={block.mediaType} mimeType={preview.state.status === "ready" ? preview.state.capability.mimeType : undefined} size={preview.state.status === "ready" ? preview.state.capability.sizeBytes : undefined} locale={locale} fill={inOutputRail} placement={inOutputRail ? "sidebar" : "chat"} imageActions={block.mediaType === "image"} />}
        {unavailable && (
          <div className={styles.mediaUnavailable} role="status">
            <span>{tFor(locale, "one.res.media.source_preserved")}</span>
            <div>
              <button type="button" onClick={preview.retry}>{tFor(locale, "one.res.retry")}</button>
            </div>
          </div>
        )}
      </div>
      {block.caption && <p className={styles.mediaCaption}>{displayValue(block.caption)}</p>}
      <div className={styles.mediaOutputs} role="list" aria-label={tFor(locale, "one.res.aria.output_files")}>
        {block.outputs.map((output) => (
          <MediaOutput
            key={output.artifactRef}
            output={output}
            locale={locale}
            artifactContext={artifactContext}
          />
        ))}
      </div>
    </div>
  );
}

function MediaOutput({
  output,
  locale,
  artifactContext,
}: {
  output: OneSurfaceMediaBlock["outputs"][number];
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
}) {
  const open = useCallback(async () => {
    if (!artifactContext) return;
    requestOneArtifactOpen({ binding: { ...artifactContext, artifactRef: output.artifactRef }, label: output.label });
  }, [artifactContext, output.artifactRef, output.label]);
  return (
    <article className={styles.mediaOutput} role="listitem">
      <div><strong>{displayValue(output.label)}</strong><span>{artifactTypeLabel(output.type, locale)} · {verificationLabel(output.verificationStatus, locale)}{output.sizeBytes != null ? ` · ${formatBytes(output.sizeBytes)}` : ""}</span></div>
      <button type="button" aria-label={`${tFor(locale, "one.res.open_file")}: ${displayValue(output.label)}`} onClick={() => void open()}>{tFor(locale, "one.res.open")}</button>
    </article>
  );
}

function DocumentBlock({
  block,
  locale,
  artifactContext,
  inOutputRail = false,
}: {
  block: OneSurfaceDocumentBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  inOutputRail?: boolean;
}) {
  const preview = useArtifactPreview(artifactContext, block.artifactRef);
  const capability = preview.state.status === "ready" ? preview.state.capability : null;
  const viewerKind = capability?.mimeType === "application/pdf"
    ? "pdf"
    : capability?.mimeType.includes("presentation") || capability?.mimeType.includes("powerpoint")
      ? "presentation"
      : capability?.kind === "spreadsheet"
        ? "spreadsheet"
        : "document";
  return <article className={styles.documentPreview} data-artifact-ref={block.artifactRef}>
    <div>
      <strong>{tFor(locale, "one.res.doc.preview")}</strong>
      <span>{block.pageCount != null ? tFor(locale, "one.res.doc.pages", { count: block.pageCount }) : tFor(locale, "one.res.doc.content_checked")}</span>
      <button type="button" onClick={() => void preview.open()}>{tFor(locale, "one.res.open_file")}</button>
    </div>
    {preview.state.status === "loading" && <div className={styles.mediaSkeleton} role="status"><LoadingEstimate locale={locale} operationKey="one-artifact-document-preview" expectedSeconds={[1, 20]} /></div>}
    {capability
      ? <LiveOutputViewer source={capability.capabilityUrl} name={displayValue(block.title)} kind={viewerKind} mimeType={capability.mimeType} size={capability.sizeBytes} locale={locale} fill={inOutputRail} placement={inOutputRail ? "sidebar" : "chat"} />
      : preview.state.status === "unavailable" && <div className={styles.documentFallback}><p>{displayValue(block.excerpt)}</p><button type="button" onClick={preview.retry}>{tFor(locale, "one.res.retry")}</button></div>}
  </article>;
}

function SourceListBlock({ block, locale }: { block: OneSurfaceSourceListBlock; locale: "ko" | "en" }) {
  return <details className={styles.sourceDisclosure}>
    <summary>{tFor(locale, "one.res.source.view_count", { n: block.sources.length })}</summary>
    <ol className={styles.sourceList}>{block.sources.map((source, index) => <li key={source.sourceRef}>
      <b>{index + 1}</b><div><strong>{displayValue(source.title)}</strong><span>{source.publisher ? `${displayValue(source.publisher)} · ` : ""}{verificationLabel(source.verificationStatus, locale)}{source.claimRefs?.length ? ` · ${tFor(locale, "one.res.source.checked_claims")} ${source.claimRefs.length}` : ""}</span></div>
    </li>)}</ol>
  </details>;
}

function DecisionBlock({ block, locale }: { block: OneSurfaceDecisionBlock; locale: "ko" | "en" }) {
  return <div className={styles.decisionPreview} data-risk={block.risk}>
    <div><span>{tFor(locale, "one.res.decision.required")} · {displayValue(block.risk)}</span>{block.deadline && <time>{displayValue(block.deadline)}</time>}</div>
    <strong>{displayValue(block.prompt)}</strong>
    <div className={styles.decisionOptions}>{block.options.map((option) => <article key={option.optionRef}><b>{displayValue(option.label)}</b><span>{displayValue(option.consequence)}</span></article>)}</div>
    <small>{tFor(locale, "one.res.decision.choose_hint")}</small>
  </div>;
}

function StatusBlock({ block, locale }: { block: OneSurfaceStatusBlock; locale: "ko" | "en" }) {
  return <div className={styles.statusBlock}>
    <p><span className={styles.statusPill} data-task-state={block.taskState}>{runStateLabel(block.taskState, locale)}</span>{tFor(locale, "one.res.status.verified_only")}</p>
    <ol>{block.steps.map((step) => <li key={step.stepRef} data-step-status={step.status}><i aria-hidden="true" /><div><strong>{displayValue(step.label)}</strong><span>{runStateLabel(step.status, locale)}</span></div></li>)}</ol>
  </div>;
}

function BudgetBlock({ block, locale }: { block: OneSurfaceBudgetBlock; locale: "ko" | "en" }) {
  const ratio = block.limit > 0 ? Math.min(1, Math.max(0, block.total / block.limit)) : 0;
  const meterMax = Math.max(block.limit, 1);
  const number = new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", { maximumFractionDigits: 2 });
  return <div className={styles.budgetBlock}>
    <div className={styles.budgetTotal}><div><span>{tFor(locale, "one.res.budget.total")}</span><strong>{number.format(block.total)} {displayValue(block.currency)}</strong></div><div><span>{tFor(locale, "one.res.budget.limit")}</span><strong>{number.format(block.limit)} {displayValue(block.currency)}</strong></div></div>
    <div className={styles.budgetTrack} role="meter" aria-valuemin={0} aria-valuemax={meterMax} aria-valuenow={Math.min(Math.max(block.total, 0), meterMax)}><span style={{ width: `${ratio * 100}%` }} /></div>
    <div className={styles.budgetLines}>{block.lines.map((line) => <div key={line.lineRef}><span>{displayValue(line.label)} · {verificationLabel(line.verificationStatus, locale)}</span><strong>{number.format(line.amount)} {displayValue(block.currency)}</strong></div>)}</div>
  </div>;
}

function ArtifactListBlock({
  block,
  locale,
  artifactContext,
}: {
  block: OneSurfaceArtifactListBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
}) {
  return (
    <div className={styles.cardGrid}>
      {block.items.map((item) => (
        <ArtifactFileCard key={item.artifactRef} item={item} locale={locale} artifactContext={artifactContext} />
      ))}
    </div>
  );
}

function ArtifactFileCard({
  item,
  locale,
  artifactContext,
}: {
  item: OneSurfaceArtifactListBlock["items"][number];
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
}) {
  const open = useCallback(async () => {
    if (!artifactContext) return;
    requestOneArtifactOpen({ binding: { ...artifactContext, artifactRef: item.artifactRef }, label: item.label });
  }, [artifactContext, item.artifactRef, item.label]);
  return (
    <article className={styles.artifactCard} data-artifact-ref={item.artifactRef} data-verification-status={item.verificationStatus}>
      <div>
        <strong>{displayValue(item.label)}</strong>
        <span>{artifactTypeLabel(item.type, locale)} · {verificationLabel(item.verificationStatus, locale)}{item.sizeBytes != null ? ` · ${formatBytes(item.sizeBytes)}` : ""}</span>
      </div>
      <button type="button" onClick={() => void open()}>{tFor(locale, "one.res.open")}</button>
    </article>
  );
}

function ChecklistBlock({ block, locale }: { block: OneSurfaceChecklistBlock; locale: "ko" | "en" }) {
  return (
    <div className={styles.cardGrid}>
      {block.items.map((item) => (
        <div className={styles.card} key={item.itemRef}>
          <strong>{displayValue(item.label)}</strong>
          <span>{checklistStateLabel(item.status, locale)}</span>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Automation / AgentBuild / McpSetup — One renders the product objects it
 * produced (registered automation, agent build session, MCP servers) as
 * operable cards. The run/toggle actions reuse the exact preload APIs the
 * dedicated screens already use (automation list page's runNow, OneShell's
 * mcpTools.setEnabled) — no parallel wiring, no new design language.
 * ──────────────────────────────────────────────────────────────────────── */

function automationStatusLabel(status: OneSurfaceAutomationBlock["status"], locale: "ko" | "en"): string {
  if (status === "running") return locale === "ko" ? "실행 중" : "Running";
  if (status === "failed") return locale === "ko" ? "실패" : "Failed";
  return locale === "ko" ? "등록됨" : "Registered";
}

function automationLastRunLabel(status: NonNullable<OneSurfaceAutomationBlock["lastRun"]>["status"], locale: "ko" | "en"): string {
  if (status === "completed") return locale === "ko" ? "성공" : "Succeeded";
  if (status === "failed") return locale === "ko" ? "실패" : "Failed";
  if (status === "cancelled") return locale === "ko" ? "취소됨" : "Cancelled";
  return locale === "ko" ? "실행 중" : "Running";
}

/**
 * One owns the conversational automation surface. The Work Graph engine still
 * executes the registered graph, but neither running nor editing it may eject
 * the person to Work. A parent One conversation can handle the semantic action
 * directly; registration receipts without a parent handler still run in place
 * and explain how to continue with `@graph` in the current chat.
 */
function useAutomationActions(
  locale: "ko" | "en",
  automationName: string,
  onSemanticAction?: (action: OneSurfaceSemanticAction) => void,
) {
  const [message, setMessage] = useState("");
  const runNow = useCallback((automationId: string) => {
    if (onSemanticAction) {
      setMessage(locale === "en"
        ? "Starting the run here. Progress stays in this conversation."
        : "이 대화에서 실행을 시작합니다. 진행 상황도 여기에서 이어집니다.");
      onSemanticAction({
        actionId: `one-run-${automationId}`,
        intent: "run_automation",
        label: locale === "en" ? "Run now" : "지금 실행",
        description: locale === "en" ? "Run in the background and keep One open." : "백그라운드에서 실행하고 One 대화를 유지합니다.",
        targetRef: `automation:${automationId}`,
        enabled: true,
      });
      return;
    }
    const api = ipc();
    if (!api) return;
    setMessage(locale === "en"
      ? "Starting the run here. Progress stays in One."
      : "여기에서 실행을 시작합니다. 진행 상황은 One에 남습니다.");
    api.automations.runNow(automationId).catch((error: unknown) => {
      // 거절에는 언제나 사유가 실려 온다 — 버리지 않는다(자동화 목록 화면과 같은 규칙).
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : "";
      setMessage(reason || (locale === "en" ? "Test run did not start." : "테스트 실행을 시작하지 못했습니다."));
    });
  }, [locale, onSemanticAction]);
  const editInChat = useCallback((automationId: string) => {
    if (!onSemanticAction) {
      setMessage(locale === "en"
        ? `Type @graph to edit ${automationName || "this automation"} in this conversation.`
        : `이 대화에서 @graph로 ${automationName || "이 자동화"}을 수정해 주세요.`);
      return;
    }
    onSemanticAction({
      actionId: `one-edit-${automationId}`,
      intent: "open_automation",
      label: locale === "en" ? "Edit with @graph" : "@graph로 수정",
      description: locale === "en" ? "Continue editing in this One conversation." : "이 One 대화에서 계속 수정합니다.",
      instruction: locale === "en"
        ? `Review and edit the ${automationName || "selected"} automation.`
        : `${automationName || "선택한"} 자동화를 검토하고 수정해줘.`,
      targetRef: `automation:${automationId}`,
      enabled: true,
    });
  }, [automationName, locale, onSemanticAction]);
  return { message, runNow, editInChat };
}

function AutomationCardFrame({
  locale,
  statusState,
  statusLabel,
  scheduleLine,
  nodes,
  lastRunLine,
  automationId,
  actionMessage,
  onRunNow,
  onEditInChat,
}: {
  locale: "ko" | "en";
  statusState: "completed" | "working" | "failed";
  statusLabel: string;
  scheduleLine: string;
  nodes: Array<{ nodeRef: string; label: string }>;
  lastRunLine: string;
  automationId: string | null;
  actionMessage: string;
  onRunNow: (automationId: string) => void;
  onEditInChat: (automationId: string) => void;
}) {
  const ko = locale === "ko";
  return (
    <div className={styles.statusBlock} data-one-automation-card="true">
      <p>
        <span className={styles.statusPill} data-task-state={statusState}>{statusLabel}</span>
        {scheduleLine && <span>{displayValue(scheduleLine)}</span>}
      </p>
      {nodes.length > 0 && (
        <ol>
          {nodes.map((node) => (
            <li key={node.nodeRef} data-step-status="completed">
              <i aria-hidden="true" />
              <div><strong>{displayValue(node.label)}</strong></div>
            </li>
          ))}
        </ol>
      )}
      {lastRunLine && <p>{displayValue(lastRunLine)}</p>}
      <div className={styles.actions} aria-label={ko ? "자동화 동작" : "Automation actions"}>
        <button
          type="button"
          className={styles.actionPrimary}
          disabled={!automationId}
          onClick={() => automationId && onRunNow(automationId)}
        >
          <span>{ko ? "지금 실행" : "Run now"}</span>
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!automationId}
          onClick={() => automationId && onEditInChat(automationId)}
        >
          <span>{ko ? "@graph로 수정" : "Edit with @graph"}</span>
        </button>
      </div>
      {actionMessage && <p role="status">{displayValue(actionMessage)}</p>}
    </div>
  );
}

function AutomationBlock({
  block,
  locale,
  onSemanticAction,
}: {
  block: OneSurfaceAutomationBlock;
  locale: "ko" | "en";
  onSemanticAction?: (action: OneSurfaceSemanticAction) => void;
}) {
  const ko = locale === "ko";
  const { message, runNow, editInChat } = useAutomationActions(locale, block.title, onSemanticAction);
  const lastRunLine = block.lastRun
    ? [
        ko ? "최근 실행" : "Last run",
        automationLastRunLabel(block.lastRun.status, locale),
        block.lastRun.at ? formatTimelineAt(block.lastRun.at, locale) : "",
        block.lastRun.summary ?? "",
      ].filter(Boolean).join(" · ")
    : "";
  return (
    <AutomationCardFrame
      locale={locale}
      statusState={block.status === "failed" ? "failed" : block.status === "running" ? "working" : "completed"}
      statusLabel={automationStatusLabel(block.status, locale)}
      scheduleLine={block.schedule ?? ""}
      nodes={block.nodes}
      lastRunLine={lastRunLine}
      automationId={block.automationId}
      actionMessage={message}
      onRunNow={runNow}
      onEditInChat={editInChat}
    />
  );
}

/**
 * Promotion of the host's automation registration receipt (`automation.create`
 * / `automation.update` tool events, renderer/lib/one-activity.ts extractor)
 * into a first-class Automation card in the One conversation. The receipt args
 * carry no automation id, so the card resolves the registered row by its
 * host-idempotent name through the same preload automations API the list
 * screen uses, and enriches status/schedule from the live record.
 */
export function OneAutomationRegistrationCard({
  name,
  action,
  schedule,
  locale,
}: {
  name: string;
  action: "created" | "updated";
  schedule?: string;
  locale: "ko" | "en";
}) {
  const ko = locale === "ko";
  const { message, runNow, editInChat } = useAutomationActions(locale, name);
  const [record, setRecord] = useState<Automation | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let active = true;
    void api.automations.list().then((rows) => {
      if (!active) return;
      const normalized = name.trim().toLowerCase();
      setRecord(rows.find((row) => row.name.trim().toLowerCase() === normalized) ?? null);
    }).catch(() => {
      if (active) setRecord(null);
    });
    return () => {
      active = false;
    };
  }, [name]);
  const scheduleLine = record?.scheduleHuman || schedule || "";
  const lastRunLine = record?.nextRunAt
    ? `${ko ? "다음 실행" : "Next run"} · ${formatTimelineAt(record.nextRunAt, locale)}`
    : "";
  return (
    <section className={styles.root} aria-label={ko ? "등록된 자동화" : "Registered automation"} data-one-automation-registration="true">
      <article className={styles.result}>
        <div className={styles.body}>
          <section className={styles.block} data-block-kind="Automation">
            <h4>{displayValue(name)}</h4>
            <p className={styles.summary}>
              {action === "created"
                ? (ko ? "자동화를 등록했어요." : "This automation is registered.")
                : (ko ? "자동화를 업데이트했어요." : "This automation is updated.")}
            </p>
            <AutomationCardFrame
              locale={locale}
              statusState={record && !record.enabled ? "working" : "completed"}
              statusLabel={record && !record.enabled
                ? (ko ? "꺼짐" : "Off")
                : automationStatusLabel("registered", locale)}
              scheduleLine={scheduleLine}
              nodes={[]}
              lastRunLine={lastRunLine}
              automationId={record?.id ?? null}
              actionMessage={message}
              onRunNow={runNow}
              onEditInChat={editInChat}
            />
          </section>
        </div>
      </article>
    </section>
  );
}

function agentBuildStageLabel(status: OneSurfaceAgentBuildBlock["stages"][number]["status"], locale: "ko" | "en"): string {
  if (status === "working") return locale === "ko" ? "진행 중" : "Working";
  if (status === "completed") return locale === "ko" ? "완료" : "Completed";
  if (status === "failed") return locale === "ko" ? "실패" : "Failed";
  return locale === "ko" ? "대기" : "Waiting";
}

function AgentBuildBlock({
  block,
  locale,
  onOpenDraft,
}: {
  block: OneSurfaceAgentBuildBlock;
  locale: "ko" | "en";
  onOpenDraft?: (seed: OneAgentDraftSeed) => void;
}) {
  const ko = locale === "ko";
  return (
    <div className={styles.statusBlock} data-one-agent-build-card="true">
      <p>
        <span
          className={styles.statusPill}
          data-task-state={block.stages.some((stage) => stage.status === "failed") ? "failed" : "completed"}
        >
          {displayValue(block.agentName)}
        </span>
        {block.agentSlug && <span>{displayValue(block.agentSlug)}</span>}
      </p>
      <ol>
        {block.stages.map((stage) => (
          <li key={stage.stageRef} data-step-status={stage.status}>
            <i aria-hidden="true" />
            <div>
              <strong>{displayValue(stage.label)}</strong>
              <span>{agentBuildStageLabel(stage.status, locale)}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.actions} aria-label={ko ? "빌드 동작" : "Build actions"}>
        <button
          type="button"
          className={styles.actionPrimary}
          disabled={!onOpenDraft}
          onClick={() => onOpenDraft?.({
            name: block.agentName,
            title: block.title !== block.agentName ? block.title : undefined,
            description: block.request,
          })}
        >
          <span>{ko ? "One Team에서 완성" : "Finish in One Team"}</span>
        </button>
      </div>
    </div>
  );
}

function mcpKeyStateLabel(keyState: OneSurfaceMcpSetupBlock["servers"][number]["keyState"], locale: "ko" | "en"): string {
  if (keyState === "missing") return locale === "ko" ? "키 필요" : "Key required";
  if (keyState === "configured") return locale === "ko" ? "키 설정됨" : "Key configured";
  return locale === "ko" ? "키 불필요" : "No key needed";
}

function McpSetupBlock({ block, locale }: { block: OneSurfaceMcpSetupBlock; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const router = useRouter();
  const [installed, setInstalled] = useState<InstalledMcpServer[] | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!api?.mcpTools) return;
    let active = true;
    void api.mcpTools.listInstalled().then((plugins) => {
      if (active) setInstalled(plugins);
    }).catch(() => {
      if (active) setInstalled(null);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className={styles.cardGrid} data-one-mcp-setup-card="true">
      {block.servers.map((server) => {
        const record = installed?.find((plugin) => plugin.catalogId === server.catalogId || plugin.id === server.catalogId) ?? null;
        const enabled = record ? record.enabled : server.enabled;
        const needsKey = server.keyState === "missing" || record?.configurationValid === false;
        return (
          <article className={styles.artifactCard} key={server.catalogId} data-mcp-catalog-id={server.catalogId} data-mcp-enabled={enabled ? "true" : "false"}>
            <div>
              <strong>{displayValue(server.name)}</strong>
              <span>
                {enabled ? (ko ? "켜짐" : "On") : (ko ? "꺼짐" : "Off")} · {mcpKeyStateLabel(server.keyState, locale)}
              </span>
            </div>
            {needsKey ? (
              // 설정이 덜 끝난 서버는 여기서 켜 봐야 동작하지 않는다 — 스위치를
              // 흉내 내는 대신 키를 넣을 수 있는 화면으로 보낸다(OneShell과 동일).
              <button type="button" onClick={() => router.push("/library/mcps")}>
                {ko ? "키 설정" : "Set key"}
              </button>
            ) : (
              <button
                type="button"
                disabled={!record}
                onClick={() => {
                  const api = ipc();
                  if (!api || !record) return;
                  const nextEnabled = !enabled;
                  // 낙관적 반영 — 왕복을 기다리면 스위치가 한 박자 늦게 움직인다.
                  setInstalled((current) => current?.map((plugin) => (
                    plugin.id === record.id ? { ...plugin, enabled: nextEnabled } : plugin
                  )) ?? current);
                  void api.mcpTools.setEnabled(record.id, nextEnabled)
                    .then(() => api.mcpTools.listInstalled())
                    .then((plugins) => setInstalled(plugins))
                    .catch(() => {
                      // 실패하면 되돌린다 — 꺼진 도구가 켜진 것처럼 남으면 안 된다.
                      setInstalled((current) => current?.map((plugin) => (
                        plugin.id === record.id ? { ...plugin, enabled: record.enabled } : plugin
                      )) ?? current);
                    });
                }}
              >
                {!record
                  ? (ko ? "설치 필요" : "Not installed")
                  : enabled
                    ? (ko ? "끄기" : "Turn off")
                    : (ko ? "켜기" : "Turn on")}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}

function inspectSurfaceForDesktop(surface: OneSurfaceManifestV1, expectedTaskId: string): { native: boolean; blocks: OneSurfaceBlock[]; reasons: string[] } {
  const reasons: string[] = [];
  const blocks: unknown[] = Array.isArray(surface.blocks) ? surface.blocks : [];
  const ids: string[] = [];
  const order = surface.recomposition?.desktop?.blockOrder ?? [];
  if (surface.taskId !== expectedTaskId) reasons.push("surface:task-mismatch");
  if (blocks.length === 0) reasons.push("surface:no-blocks");
  for (const block of blocks) {
    if (!isPlainRecord(block)) {
      reasons.push("surface:invalid-block");
      continue;
    }
    if (typeof block.blockId !== "string" || !SAFE_IDENTIFIER_RE.test(block.blockId)) {
      reasons.push("surface:invalid-block-id");
    } else {
      ids.push(block.blockId);
    }
    const type = block.type;
    if (typeof type !== "string" || !ONE_SURFACE_BLOCK_TYPES.includes(type as OneSurfaceBlockType)) {
      reasons.push("surface:unknown-block-kind");
    } else if (DESKTOP_FALLBACK_BLOCK_TYPES.has(type as OneSurfaceBlockType)) {
      reasons.push(`surface:work-fallback:${type}`);
    } else if (!isSafeNativeBlock(block, type as OneSurfaceBlockType)) {
      reasons.push(`surface:invalid-native-block:${type}`);
    }
  }
  if (new Set(ids).size !== ids.length) reasons.push("surface:duplicate-block-id");
  const orderSet = new Set(order);
  if (order.length !== ids.length || orderSet.size !== order.length || ids.some((id) => !orderSet.has(id))) {
    reasons.push("surface:desktop-recomposition-mismatch");
  }
  if (blocks.some((block) => isPlainRecord(block) && block.blockId === "block:fallback")) reasons.push("surface:shared-adapter-fallback");
  const byId = new Map(blocks.flatMap((block) => (
    isPlainRecord(block) && typeof block.blockId === "string"
      ? [[block.blockId, block as unknown as OneSurfaceBlock] as const]
      : []
  )));
  const orderedBlocks = order.map((id) => byId.get(id)).filter((block): block is OneSurfaceBlock => Boolean(block));
  const uniqueReasons = [...new Set(reasons)];
  return { native: uniqueReasons.length === 0, blocks: uniqueReasons.length === 0 ? orderedBlocks : [], reasons: uniqueReasons };
}

function isOneSurfaceManifestV1(value: unknown): value is OneSurfaceManifestV1 {
  if (!isPlainRecord(value)) return false;
  const item = value;
  const allowed = new Set([
    "contractVersion", "manifestId", "taskId", "title", "summary", "layoutProfile", "surfaceState",
    "blocks", "primaryAction", "secondaryActions", "evidence", "fallback", "recomposition",
  ]);
  return item.contractVersion === "1.0.0"
    && Object.keys(item).every((key) => allowed.has(key))
    && typeof item.manifestId === "string"
    && typeof item.taskId === "string"
    && typeof item.title === "string"
    && typeof item.summary === "string"
    && typeof item.layoutProfile === "string"
    && Array.isArray(item.blocks)
    && Array.isArray(item.secondaryActions)
    && item.secondaryActions.length <= 2
    && item.secondaryActions.every(isSafeSemanticAction)
    && Array.isArray(item.evidence)
    && item.evidence.every(isSafeEvidence)
    && isSafeSurfaceState(item.surfaceState)
    && isSafeSemanticAction(item.primaryAction)
    && isSafeFallbackShape(item.fallback)
    && isSafeRecomposition(item.recomposition);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeNativeBlock(block: Record<string, unknown>, type: OneSurfaceBlockType): boolean {
  if (typeof block.title !== "string") return false;
  if (type === "Narrative") return isStringArray(block.paragraphs);
  if (type === "Metric") {
    return Array.isArray(block.items) && block.items.length <= 24 && block.items.every((item) => isPlainRecord(item)
      && typeof item.metricId === "string" && SAFE_IDENTIFIER_RE.test(item.metricId)
      && typeof item.label === "string"
      && (typeof item.value === "string" || typeof item.value === "number")
      && (item.unit == null || typeof item.unit === "string")
      && ["verified", "estimated", "unverified"].includes(String(item.verificationStatus)));
  }
  if (type === "Table") {
    if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 32) return false;
    const columnIds = block.columns.flatMap((column) => isPlainRecord(column) && typeof column.columnId === "string" ? [column.columnId] : []);
    return columnIds.length === block.columns.length && new Set(columnIds).size === columnIds.length
      && block.columns.every((column) => isPlainRecord(column) && typeof column.columnId === "string" && SAFE_IDENTIFIER_RE.test(column.columnId) && typeof column.label === "string")
      && isStringArray(block.featuredColumnIds)
      && block.featuredColumnIds.every((columnId) => columnIds.includes(columnId))
      && Array.isArray(block.rows) && block.rows.length <= 500
      && block.rows.every((row) => isPlainRecord(row) && typeof row.rowId === "string" && SAFE_IDENTIFIER_RE.test(row.rowId) && Array.isArray(row.cells)
        && row.cells.length <= columnIds.length
        && row.cells.every((cell) => isPlainRecord(cell) && typeof cell.columnId === "string" && columnIds.includes(cell.columnId)
          && (cell.value == null || typeof cell.value === "string" || typeof cell.value === "number" || typeof cell.value === "boolean")));
  }
  if (type === "Comparison") {
    return typeof block.recommendedOptionRef === "string" && SAFE_IDENTIFIER_RE.test(block.recommendedOptionRef)
      && Array.isArray(block.options) && block.options.length <= 8
      && block.options.length > 0
      && block.options.every((option) => isPlainRecord(option)
        && typeof option.optionRef === "string" && SAFE_IDENTIFIER_RE.test(option.optionRef)
        && typeof option.title === "string"
        && (option.subtitle == null || typeof option.subtitle === "string")
        && (option.artifactRef == null || (typeof option.artifactRef === "string" && SAFE_IDENTIFIER_RE.test(option.artifactRef)))
        && isStringArray(option.strengths)
        && isStringArray(option.limitations))
      && block.options.some((option) => isPlainRecord(option) && option.optionRef === block.recommendedOptionRef);
  }
  if (type === "Timeline") {
    return Array.isArray(block.items) && block.items.length <= 200 && block.items.every((item) => isPlainRecord(item)
      && typeof item.itemId === "string" && SAFE_IDENTIFIER_RE.test(item.itemId)
      && typeof item.title === "string"
      && (item.at == null || typeof item.at === "string")
      && (item.detail == null || typeof item.detail === "string")
      && ["upcoming", "in_progress", "completed", "failed", "cancelled"].includes(String(item.status)));
  }
  if (type === "Map") {
    return Array.isArray(block.locations) && block.locations.length > 0 && block.locations.length <= 100 && block.locations.every((item) => isPlainRecord(item)
      && typeof item.locationRef === "string" && SAFE_IDENTIFIER_RE.test(item.locationRef)
      && typeof item.label === "string"
      && typeof item.latitude === "number" && Number.isFinite(item.latitude) && item.latitude >= -90 && item.latitude <= 90
      && typeof item.longitude === "number" && Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180
      && (item.sequence == null || (Number.isSafeInteger(item.sequence) && Number(item.sequence) > 0)));
  }
  if (type === "Gallery") {
    const allowedBlockKeys = new Set(["blockId", "type", "title", "items"]);
    return Object.keys(block).every((key) => allowedBlockKeys.has(key))
      && Array.isArray(block.items)
      && block.items.length > 0
      && block.items.length <= 24
      && block.items.every((item) => {
        if (!isPlainRecord(item)) return false;
        const allowedItemKeys = new Set(["artifactRef", "label", "altText", "provenance"]);
        return Object.keys(item).every((key) => allowedItemKeys.has(key))
          && typeof item.artifactRef === "string"
          && SAFE_IDENTIFIER_RE.test(item.artifactRef)
          && typeof item.label === "string"
          && typeof item.altText === "string"
          && ["user_original", "generated", "edited", "licensed_source", "unknown_source"].includes(String(item.provenance));
      });
  }
  if (type === "Media") {
    const allowedBlockKeys = new Set([
      "blockId", "type", "title", "primaryArtifactRef", "mediaType", "caption", "durationSeconds", "outputs",
    ]);
    if (!Object.keys(block).every((key) => allowedBlockKeys.has(key))
      || typeof block.primaryArtifactRef !== "string"
      || !SAFE_IDENTIFIER_RE.test(block.primaryArtifactRef)
      || !["image", "video", "audio"].includes(String(block.mediaType))
      || (block.caption != null && typeof block.caption !== "string")
      || (block.durationSeconds != null && (typeof block.durationSeconds !== "number" || !Number.isFinite(block.durationSeconds) || block.durationSeconds < 0))
      || !Array.isArray(block.outputs)
      || block.outputs.length < 1
      || block.outputs.length > 24
      || !block.outputs.every((item) => normalizeFallbackArtifact(item).length === 1)) return false;
    const primary = block.outputs.find((item) => isPlainRecord(item) && item.artifactRef === block.primaryArtifactRef);
    return isPlainRecord(primary) && primary.type === block.mediaType;
  }
  if (type === "Document") {
    return typeof block.artifactRef === "string" && SAFE_IDENTIFIER_RE.test(block.artifactRef)
      && typeof block.excerpt === "string"
      && (block.pageCount == null || (Number.isSafeInteger(block.pageCount) && (block.pageCount as number) > 0));
  }
  if (type === "ArtifactList") {
    return Array.isArray(block.items) && block.items.every((item) => normalizeFallbackArtifact(item).length === 1);
  }
  if (type === "SourceList") {
    return Array.isArray(block.sources) && block.sources.length <= 100 && block.sources.every((source) => isPlainRecord(source)
      && typeof source.sourceRef === "string" && SAFE_IDENTIFIER_RE.test(source.sourceRef)
      && typeof source.title === "string"
      && (source.publisher == null || typeof source.publisher === "string")
      && ["verified", "partially_verified", "unverified"].includes(String(source.verificationStatus))
      && (source.claimRefs == null || (isStringArray(source.claimRefs) && source.claimRefs.length <= 100 && source.claimRefs.every((ref) => SAFE_IDENTIFIER_RE.test(ref)))));
  }
  if (type === "Decision") {
    return typeof block.decisionId === "string" && SAFE_IDENTIFIER_RE.test(block.decisionId)
      && typeof block.prompt === "string"
      && ["low", "moderate", "high", "critical"].includes(String(block.risk))
      && (block.deadline == null || typeof block.deadline === "string")
      && Array.isArray(block.options)
      && block.options.length > 0 && block.options.length <= 8
      && block.options.every((option) => isPlainRecord(option)
        && typeof option.optionRef === "string" && SAFE_IDENTIFIER_RE.test(option.optionRef)
        && typeof option.label === "string"
        && typeof option.consequence === "string");
  }
  if (type === "Status") {
    const allowedStatuses = ["waiting", "working", "decision_required", "completed", "failed", "stopped"];
    return allowedStatuses.includes(String(block.taskState))
      && Array.isArray(block.steps) && block.steps.length <= 100
      && block.steps.every((step) => isPlainRecord(step)
        && typeof step.stepRef === "string" && SAFE_IDENTIFIER_RE.test(step.stepRef)
        && typeof step.label === "string"
        && allowedStatuses.includes(String(step.status))
        && (step.receiptRef == null || (typeof step.receiptRef === "string" && SAFE_IDENTIFIER_RE.test(step.receiptRef))));
  }
  if (type === "Budget") {
    return typeof block.currency === "string" && /^[A-Z]{3}$/.test(block.currency)
      && typeof block.total === "number" && Number.isFinite(block.total) && block.total >= 0
      && typeof block.limit === "number" && Number.isFinite(block.limit) && block.limit >= 0
      && Array.isArray(block.lines) && block.lines.length <= 100
      && block.lines.every((line) => isPlainRecord(line)
        && typeof line.lineRef === "string" && SAFE_IDENTIFIER_RE.test(line.lineRef)
        && typeof line.label === "string"
        && typeof line.amount === "number" && Number.isFinite(line.amount) && line.amount >= 0
        && ["verified", "estimated", "unverified"].includes(String(line.verificationStatus)));
  }
  if (type === "Checklist") {
    return Array.isArray(block.items) && block.items.length <= 100 && block.items.every((item) => isPlainRecord(item)
      && typeof item.itemRef === "string" && SAFE_IDENTIFIER_RE.test(item.itemRef)
      && typeof item.label === "string"
      && ["not_started", "in_progress", "completed", "failed", "not_applicable"].includes(String(item.status))
      && (item.evidenceRef == null || (typeof item.evidenceRef === "string" && SAFE_IDENTIFIER_RE.test(item.evidenceRef))));
  }
  if (type === "ValueClosure") {
    return typeof block.valueClosureRef === "string" && SAFE_IDENTIFIER_RE.test(block.valueClosureRef);
  }
  if (type === "ImprovementProof") {
    return typeof block.improvementProofRef === "string"
      && SAFE_IDENTIFIER_RE.test(block.improvementProofRef)
      && block.collapsedByDefault === true;
  }
  if (type === "Automation") {
    const allowedBlockKeys = new Set(["blockId", "type", "title", "automationId", "status", "schedule", "nodes", "lastRun"]);
    if (!Object.keys(block).every((key) => allowedBlockKeys.has(key))) return false;
    if (typeof block.automationId !== "string" || !SAFE_IDENTIFIER_RE.test(block.automationId)) return false;
    if (!["registered", "running", "failed"].includes(String(block.status))) return false;
    if (block.schedule != null && typeof block.schedule !== "string") return false;
    if (!Array.isArray(block.nodes) || block.nodes.length > 64) return false;
    if (!block.nodes.every((node) => isPlainRecord(node)
      && typeof node.nodeRef === "string" && SAFE_IDENTIFIER_RE.test(node.nodeRef)
      && typeof node.label === "string")) return false;
    if (block.lastRun == null) return true;
    return isPlainRecord(block.lastRun)
      && Object.keys(block.lastRun).every((key) => ["at", "status", "summary"].includes(key))
      && (block.lastRun.at == null || typeof block.lastRun.at === "string")
      && ["completed", "failed", "cancelled", "running"].includes(String(block.lastRun.status))
      && (block.lastRun.summary == null || typeof block.lastRun.summary === "string");
  }
  if (type === "AgentBuild") {
    const allowedBlockKeys = new Set(["blockId", "type", "title", "buildSessionId", "agentName", "agentSlug", "stages", "request"]);
    return Object.keys(block).every((key) => allowedBlockKeys.has(key))
      && typeof block.buildSessionId === "string" && SAFE_IDENTIFIER_RE.test(block.buildSessionId)
      && typeof block.agentName === "string"
      && (block.request == null || (typeof block.request === "string" && block.request.length <= 4000))
      && (block.agentSlug == null || (typeof block.agentSlug === "string" && SAFE_IDENTIFIER_RE.test(block.agentSlug)))
      && Array.isArray(block.stages) && block.stages.length > 0 && block.stages.length <= 64
      && block.stages.every((stage) => isPlainRecord(stage)
        && typeof stage.stageRef === "string" && SAFE_IDENTIFIER_RE.test(stage.stageRef)
        && typeof stage.label === "string"
        && ["waiting", "working", "completed", "failed"].includes(String(stage.status)));
  }
  if (type === "McpSetup") {
    const allowedBlockKeys = new Set(["blockId", "type", "title", "servers"]);
    return Object.keys(block).every((key) => allowedBlockKeys.has(key))
      && Array.isArray(block.servers) && block.servers.length > 0 && block.servers.length <= 64
      && block.servers.every((server) => isPlainRecord(server)
        && Object.keys(server).every((key) => ["catalogId", "name", "enabled", "keyState"].includes(key))
        && typeof server.catalogId === "string" && SAFE_IDENTIFIER_RE.test(server.catalogId)
        && typeof server.name === "string"
        && typeof server.enabled === "boolean"
        && ["not_required", "missing", "configured"].includes(String(server.keyState)));
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSafeEvidence(value: unknown): boolean {
  return isPlainRecord(value)
    && typeof value.evidenceRef === "string"
    && typeof value.kind === "string"
    && typeof value.verificationStatus === "string"
    && (value.label == null || typeof value.label === "string");
}

function isSafeSurfaceState(value: unknown): boolean {
  return isPlainRecord(value)
    && ["loading", "partial", "ready", "error", "stale", "offline"].includes(String(value.value))
    && typeof value.summary === "string"
    && typeof value.readOnly === "boolean";
}

function isSafeSemanticAction(value: unknown): boolean {
  return value === null || (isPlainRecord(value)
    && [
      "open_work", "try_result", "open_asset", "refine_result", "reuse_result", "prepare_share",
      "run_automation", "open_automation", "open_build", "toggle_mcp_server",
    ].includes(String(value.intent))
    && typeof value.actionId === "string"
    && typeof value.label === "string"
    && (value.description == null || (typeof value.description === "string" && value.description.length <= 220))
    && (value.instruction == null || (typeof value.instruction === "string" && value.instruction.length <= 800))
    && (value.targetRef == null || (typeof value.targetRef === "string" && SAFE_IDENTIFIER_RE.test(value.targetRef)))
    && typeof value.enabled === "boolean"
    && (value.blockedReason == null || typeof value.blockedReason === "string"));
}

function isSafeFallbackShape(value: unknown): boolean {
  return isPlainRecord(value)
    && safeFallbackText(value.markdown, 16_000) !== null
    && Array.isArray(value.artifacts)
    && value.artifacts.length <= 32
    && value.artifacts.every((artifact) => normalizeFallbackArtifact(artifact).length === 1);
}

function isSafeRecomposition(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.desktop) || !isPlainRecord(value.mobile)) return false;
  return isStringArray(value.desktop.blockOrder) && isStringArray(value.mobile.blockOrder);
}

const FALLBACK_ARTIFACT_TYPES = new Set<SafeFallbackArtifact["type"]>([
  "document", "spreadsheet", "image", "video", "audio", "archive", "data", "other",
]);
const FALLBACK_VERIFICATION_STATUSES = new Set<SafeFallbackArtifact["verificationStatus"]>([
  "verified", "partially_verified", "unverified",
]);
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const UNSAFE_FALLBACK_TEXT_RE = /(?:<|https?:\/\/|file:|javascript:|\/(?:Users|home|private)\/|\b[A-Za-z]:\\)/i;

function readSafeFallback(value: unknown, expectedTaskId: string): SafeFallback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { markdown: null, artifacts: [] };
  const manifest = value as Record<string, unknown>;
  if (manifest.taskId !== expectedTaskId || !manifest.fallback || typeof manifest.fallback !== "object" || Array.isArray(manifest.fallback)) {
    return { markdown: null, artifacts: [] };
  }
  const fallback = manifest.fallback as Record<string, unknown>;
  const markdown = safeFallbackText(fallback.markdown, 16_000);
  const artifacts = Array.isArray(fallback.artifacts)
    ? fallback.artifacts.slice(0, 32).flatMap((artifact) => normalizeFallbackArtifact(artifact))
    : [];
  return { markdown, artifacts };
}

function normalizeFallbackArtifact(value: unknown): SafeFallbackArtifact[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  const allowedKeys = new Set(["artifactRef", "type", "label", "verificationStatus", "sizeBytes"]);
  if (!Object.keys(item).every((key) => allowedKeys.has(key))) return [];
  if (typeof item.artifactRef !== "string" || !SAFE_IDENTIFIER_RE.test(item.artifactRef)) return [];
  if (typeof item.type !== "string" || !FALLBACK_ARTIFACT_TYPES.has(item.type as SafeFallbackArtifact["type"])) return [];
  if (typeof item.verificationStatus !== "string" || !FALLBACK_VERIFICATION_STATUSES.has(item.verificationStatus as SafeFallbackArtifact["verificationStatus"])) return [];
  const label = safeFallbackText(item.label, 160);
  if (!label) return [];
  if (item.sizeBytes != null && (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0)) return [];
  return [{
    artifactRef: item.artifactRef,
    type: item.type as SafeFallbackArtifact["type"],
    label,
    verificationStatus: item.verificationStatus as SafeFallbackArtifact["verificationStatus"],
    ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
  }];
}

function safeFallbackText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || UNSAFE_FALLBACK_TEXT_RE.test(text)) return null;
  return sanitizeText(text);
}

function RunClosure({ receipt, locale, onRetryUnfinished, autoRecovery }: {
  receipt: InvocationRunReceipt;
  locale: "ko" | "en";
  onRetryUnfinished?: () => void;
  autoRecovery?:
    | { phase: "recovering"; attempt: number; diagnosis: string }
    | { phase: "stopped"; reason: string; diagnosis: string }
    | null;
}) {
  // One is still working the problem. Reporting a failure now would be wrong,
  // and asking the user to press "continue" would be asking for what One is
  // already doing.
  if (autoRecovery?.phase === "recovering") {
    return (
      <section className={styles.recoveringClosure} role="status" aria-live="polite">
        <span className={styles.recoveringSpinner} aria-hidden="true" />
        <div className={styles.closureSummaryCopy}>
          <strong>{tFor(locale, "one.res.closure.recovering")}</strong>
          <small>{tFor(locale, "one.res.closure.recovering_detail", { attempt: autoRecovery.attempt + 1 })}</small>
        </div>
      </section>
    );
  }
  // A stop the person asked for is already written on the turn's work line
  // ("27s 동안 작업 · 중단됨", the way Codex marks an interrupted turn). A second
  // "stopped here" card under it said the same thing louder — dropped.
  const stopped = false;
  // A failed receipt is internal evidence. Only One's model-authored diagnosis
  // may cross this boundary; raw errors and code-authored semantic summaries do
  // not have a customer-visible representation.
  const outcome = autoRecovery?.phase === "stopped" ? autoRecovery.diagnosis.trim() : "";
  if (!outcome) return null;
  return (
    <section className={styles.failureClosure} data-status={stopped ? "cancelled" : "failed"} role="status">
      <span className={styles.closureCheck} data-tone={stopped ? "neutral" : "bad"} aria-hidden="true">!</span>
      <div className={styles.closureSummaryCopy}>
        <strong>{stopped ? tFor(locale, "one.res.closure.stopped_here") : outcome}</strong>
      </div>
      {!stopped && onRetryUnfinished && (
        <button type="button" className={styles.actionPrimary} onClick={onRetryUnfinished}>
          {tFor(locale, "one.res.closure.continue")}
        </button>
      )}
    </section>
  );
}

function isTerminal(status: InvocationRunReceipt["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function verificationLabel(value: string, locale: "ko" | "en"): string {
  const keys = {
    verified: "one.res.verify.verified",
    partially_verified: "one.res.verify.partially_verified",
    estimated: "one.res.verify.estimated",
    unverified: "one.res.verify.unverified",
  } as const;
  const key = keys[value as keyof typeof keys];
  return key ? tFor(locale, key) : displayValue(value);
}

function artifactTypeLabel(value: string, locale: "ko" | "en"): string {
  const keys = {
    document: "one.res.artifact.document",
    spreadsheet: "one.res.artifact.spreadsheet",
    image: "one.res.artifact.image",
    video: "one.res.artifact.video",
    audio: "one.res.artifact.audio",
    archive: "one.res.artifact.archive",
    data: "one.res.artifact.data",
    other: "one.res.artifact.other",
  } as const;
  const key = keys[value as keyof typeof keys];
  return key ? tFor(locale, key) : displayValue(value);
}

function runStateLabel(value: string, locale: "ko" | "en"): string {
  const keys = {
    waiting: "one.res.runstate.waiting",
    working: "one.res.runstate.working",
    decision_required: "one.res.runstate.decision_required",
    completed: "one.res.runstate.completed",
    failed: "one.res.runstate.failed",
    stopped: "one.res.runstate.stopped",
  } as const;
  const key = keys[value as keyof typeof keys];
  return key ? tFor(locale, key) : displayValue(value);
}

function checklistStateLabel(value: string, locale: "ko" | "en"): string {
  const keys = {
    not_started: "one.res.checklist.not_started",
    in_progress: "one.res.checklist.in_progress",
    completed: "one.res.checklist.completed",
    failed: "one.res.checklist.failed",
    not_applicable: "one.res.checklist.not_applicable",
  } as const;
  const key = keys[value as keyof typeof keys];
  return key ? tFor(locale, key) : displayValue(value);
}

function displayValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return sanitizeText(String(value));
  try {
    return sanitizeText(JSON.stringify(value));
  } catch {
    return "—";
  }
}

function sanitizeText(value: string): string {
  return stripAgentIdentityBadges(redactLocalPaths(redactSecrets(value))
    .replace(/\[([^\]]+)\]\(\s*\[?link omitted\]?\s*\)/gi, "$1")
    .replace(/\[link omitted\]/gi, "")
    .replace(/(\*\*|__)([^\r\n]+?)\1/g, "$2")
    .replace(/`([^`\r\n]+)`/g, "$1")
    .replace(/[✅❌⚠]\uFE0F?/gu, "")
    .replace(/[ \t]{2,}/g, " "))
    .trim();
}

function redactLocalPaths(value: string): string {
  const unixPath = /\/(?:Users|home|private|var|tmp|Volumes)\/[^\s"'<>]+/g;
  const windowsPath = /\b[A-Za-z]:\\(?:Users|Documents and Settings|Temp)\\[^\s"'<>]+/g;
  return value
    .replace(unixPath, (path) => localLocationLabel(path, "en"))
    .replace(windowsPath, (path) => localLocationLabel(path, "en"));
}

function localLocationLabel(path: string, locale: "ko" | "en"): string {
  const basename = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
  const prefix = tFor(locale, "one.res.local_path_prefix");
  return basename ? `${prefix} ${redactSecrets(basename)}` : prefix;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
