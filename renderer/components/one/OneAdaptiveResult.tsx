"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  type OneSurfaceArtifactSummary,
  type OneSurfaceArtifactListBlock,
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
  type OneSurfaceMetricBlock,
  type OneSurfaceNarrativeBlock,
  type OneSurfaceSourceListBlock,
  type OneSurfaceStatusBlock,
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
import { ipc } from "@/lib/ipc";
import { tFor } from "@/lib/i18n";
import styles from "./OneAdaptiveResult.module.css";

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
]);
const DESKTOP_FALLBACK_BLOCK_TYPES = new Set<OneSurfaceBlockType>(
  ONE_SURFACE_BLOCK_TYPES.filter((type) => !DESKTOP_NATIVE_BLOCK_TYPES.has(type)),
);

export function OneAdaptiveResult({
  manifest,
  projection,
  receipt,
  locale,
  onOpenWork,
  onAcceptResult,
  acceptingResult = false,
  onRetryUnfinished,
}: {
  manifest: OneSurfaceManifestV1 | null;
  projection: OneTaskProjection;
  receipt: InvocationRunReceipt | null;
  locale: "ko" | "en";
  onOpenWork: () => void;
  onAcceptResult?: () => void;
  acceptingResult?: boolean;
  valueClosure?: OneValueClosureRecord | null;
  experienceReuse?: OneExperienceReuseRecord | null;
  onManageExperience?: () => void;
  valueClosureState?: OneValueClosureState | null;
  onValueClosureStateChange?: (state: OneValueClosureState) => void;
  improvementProof?: OneImprovementProofRecord | null;
  onManageImprovementAsset?: (asset: OneImprovementReusedAssetV1) => void;
  /** 끝까지 완료되지 않은 실행을 한 번의 클릭으로 이어서 진행한다. */
  onRetryUnfinished?: () => void;
}) {
  const surface = useMemo(() => manifest && isOneSurfaceManifestV1(manifest) ? manifest : null, [manifest]);
  const renderDecision = useMemo(() => surface ? inspectSurfaceForDesktop(surface, projection.taskId) : null, [projection.taskId, surface]);
  const fallback = useMemo(() => readSafeFallback(manifest, projection.taskId), [manifest, projection.taskId]);
  const hasManifest = Boolean(manifest && typeof manifest === "object");
  const showNative = Boolean(surface && renderDecision?.native);
  const hasSourceListBlock = Boolean(surface?.blocks.some((block) => block.type === "SourceList"));
  const canAcceptResult = projection.canonicalStatus === "partial"
    && receipt?.status === "completed"
    && projection.sync.mutationMode === "direct"
    && Boolean(onAcceptResult);
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
    <section className={styles.root} aria-label={tFor(locale, "one.res.aria.work_result")}>
      {hasManifest && (
        <article className={styles.result} data-surface-contract={surface?.contractVersion ?? "invalid"}>
          <header className={styles.header}>
            <div className={styles.headerCopy}>
              <h3>{showNative && surface ? displayValue(surface.title) : tFor(locale, "one.res.title.too_large")}</h3>
              <p className={styles.summary}>{showNative && surface
                ? friendlySurfaceSummary(surface.summary, locale)
                : tFor(locale, "one.res.summary.open_work")}</p>
            </div>
          </header>
          <div className={styles.body}>
            {showNative && renderDecision ? renderDecision.blocks
              .filter((block) => block.type !== "ValueClosure" && block.type !== "ImprovementProof")
              .map((block) => (
              <NativeBlock
                key={block.blockId}
                block={block}
                locale={locale}
                artifactContext={artifactContext}
                onOpenWork={onOpenWork}
              />
            )) : (
              <FallbackResult
                fallback={fallback}
                reasons={renderDecision?.reasons ?? ["surface:invalid-manifest"]}
                locale={locale}
              />
            )}
          </div>
          <div className={styles.actions}>
            {canAcceptResult && (
              <button type="button" className={styles.actionPrimary} onClick={onAcceptResult} disabled={acceptingResult}>
                {acceptingResult ? tFor(locale, "one.res.finishing") : tFor(locale, "one.res.finish_here")}
              </button>
            )}
            <button type="button" className={canAcceptResult ? styles.action : styles.actionPrimary} onClick={onOpenWork}>
              {showNative && surface?.primaryAction?.label ? displayValue(surface.primaryAction.label) : tFor(locale, "one.res.see_details")}
            </button>
          </div>
          {canAcceptResult && (
            <AcceptanceBoundaryCopy locale={locale} className={styles.acceptanceNote} />
          )}
          {showNative && surface && surface.evidence.length > 0 && !hasSourceListBlock && (
            <details className={styles.evidence}>
              <summary>{tFor(locale, "one.res.evidence_count", { n: surface.evidence.length })}</summary>
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
        <RunClosure receipt={receipt} locale={locale} onRetryUnfinished={onRetryUnfinished} />
      )}
      {canAcceptResult && !hasManifest && (
        <section className={styles.standaloneAcceptance} aria-label={tFor(locale, "one.res.aria.confirm_result")}>
          <AcceptanceBoundaryCopy locale={locale} className={styles.standaloneAcceptanceCopy} />
          <button type="button" className={styles.actionPrimary} onClick={onAcceptResult} disabled={acceptingResult}>
            {acceptingResult ? tFor(locale, "one.res.finishing") : tFor(locale, "one.res.finish_here")}
          </button>
        </section>
      )}
      {/* Value/experience/proof records keep compounding internally. They are
          deliberately absent from the ordinary One conversation surface. */}
    </section>
  );
}

function AcceptanceBoundaryCopy({ locale, className }: { locale: "ko" | "en"; className: string }) {
  return (
    <p className={className}>
      {tFor(locale, "one.res.acceptance_boundary")}
    </p>
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
  onOpenWork,
}: {
  block: OneSurfaceBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  onOpenWork: () => void;
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
        <GalleryBlock block={block} locale={locale} artifactContext={artifactContext} onOpenWork={onOpenWork} />
      )}
      {block.type === "Media" && (
        <MediaBlock block={block} locale={locale} artifactContext={artifactContext} onOpenWork={onOpenWork} />
      )}
      {block.type === "Document" && <DocumentBlock block={block} locale={locale} artifactContext={artifactContext} />}
      {block.type === "ArtifactList" && <ArtifactListBlock block={block} locale={locale} artifactContext={artifactContext} />}
      {block.type === "SourceList" && <SourceListBlock block={block} locale={locale} />}
      {block.type === "Decision" && <DecisionBlock block={block} locale={locale} />}
      {block.type === "Status" && <StatusBlock block={block} locale={locale} />}
      {block.type === "Budget" && <BudgetBlock block={block} locale={locale} />}
      {block.type === "Checklist" && <ChecklistBlock block={block} locale={locale} />}
    </section>
  );
}

function NarrativeBlock({ block }: { block: OneSurfaceNarrativeBlock }) {
  return <div>{block.paragraphs.map((paragraph, index) => <p className={styles.summary} key={index}>{displayValue(paragraph)}</p>)}</div>;
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
  const ordered = [...block.locations].sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER));
  const minLat = Math.min(...ordered.map((item) => item.latitude));
  const maxLat = Math.max(...ordered.map((item) => item.latitude));
  const minLng = Math.min(...ordered.map((item) => item.longitude));
  const maxLng = Math.max(...ordered.map((item) => item.longitude));
  const points = ordered.map((item) => {
    const x = 8 + ((item.longitude - minLng) / Math.max(maxLng - minLng, 0.000001)) * 84;
    const y = 92 - ((item.latitude - minLat) / Math.max(maxLat - minLat, 0.000001)) * 84;
    return { ...item, x, y };
  });
  return (
    <div className={styles.mapLayout}>
      <svg className={styles.mapPlot} role="img" aria-label={tFor(locale, "one.res.map.aria", { title: block.title })} viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={points.map((item) => `${item.x},${item.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {points.map((item, index) => <g key={item.locationRef}><circle cx={item.x} cy={item.y} r="3.2" /><text x={item.x} y={item.y + 1.2} textAnchor="middle">{item.sequence ?? index + 1}</text></g>)}
      </svg>
      <ol className={styles.locationList}>{ordered.map((item, index) => <li key={item.locationRef}>
        <b>{item.sequence ?? index + 1}</b><span>{displayValue(item.label)}</span><small>{item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}</small>
      </li>)}</ol>
    </div>
  );
}

type ArtifactPreviewState =
  | { status: "loading"; capability: null }
  | { status: "ready"; capability: OneArtifactPreviewCapabilityV1 }
  | { status: "unavailable"; capability: null };

function useArtifactPreview(
  context: OneArtifactBindingRequestV1 | null,
  artifactRef: string,
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
    const api = ipc();
    if (!api?.oneArtifacts || !context) return false;
    const result = await api.oneArtifacts.open({ ...context, artifactRef }).catch(() => ({ opened: false }));
    return result.opened;
  }, [artifactRef, context]);
  return { state, retry, open };
}

function GalleryBlock({
  block,
  locale,
  artifactContext,
  onOpenWork,
}: {
  block: OneSurfaceGalleryBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  onOpenWork: () => void;
}) {
  return (
    <div className={styles.galleryGrid} role="list" aria-label={block.title}>
      {block.items.map((item) => (
        <GalleryItem
          key={item.artifactRef}
          item={item}
          locale={locale}
          artifactContext={artifactContext}
          onOpenWork={onOpenWork}
        />
      ))}
    </div>
  );
}

function GalleryItem({
  item,
  locale,
  artifactContext,
  onOpenWork,
}: {
  item: OneSurfaceGalleryBlock["items"][number];
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  onOpenWork: () => void;
}) {
  const preview = useArtifactPreview(artifactContext, item.artifactRef);
  const [mediaFailed, setMediaFailed] = useState(false);
  const unavailable = preview.state.status === "unavailable" || mediaFailed;
  return (
    <article className={styles.galleryItem} role="listitem" aria-busy={preview.state.status === "loading"}>
      <div className={styles.galleryFrame}>
        {preview.state.status === "loading" && <div className={styles.mediaSkeleton} role="status" aria-label={tFor(locale, "one.res.gallery.loading_image")} />}
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
      </div>
      <div className={styles.mediaMeta}>
        <div><strong>{displayValue(item.label)}</strong><span>{provenanceLabel(item.provenance, locale)}</span></div>
        <button type="button" aria-label={`${tFor(locale, "one.res.open_file")}: ${displayValue(item.label)}`} onClick={() => void preview.open()}>{tFor(locale, "one.res.open_file")}</button>
      </div>
      {unavailable && <button type="button" className={styles.workFallbackButton} onClick={onOpenWork}>{tFor(locale, "one.res.view_in_work")}</button>}
    </article>
  );
}

function MediaBlock({
  block,
  locale,
  artifactContext,
  onOpenWork,
}: {
  block: OneSurfaceMediaBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
  onOpenWork: () => void;
}) {
  const preview = useArtifactPreview(artifactContext, block.primaryArtifactRef);
  const [mediaFailed, setMediaFailed] = useState(false);
  const unavailable = preview.state.status === "unavailable" || mediaFailed;
  const capabilityUrl = preview.state.status === "ready" ? preview.state.capability.capabilityUrl : null;
  return (
    <div className={styles.mediaLayout}>
      <div className={styles.primaryMedia} aria-busy={preview.state.status === "loading"}>
        {preview.state.status === "loading" && <div className={styles.mediaSkeleton} role="status" aria-label={tFor(locale, "one.res.media.loading")} />}
        {capabilityUrl && !mediaFailed && block.mediaType === "video" && (
          <video aria-label={displayValue(block.caption ?? block.title)} controls playsInline preload="metadata" src={capabilityUrl} onError={() => setMediaFailed(true)}>
            {tFor(locale, "one.res.media.video_unplayable")}
          </video>
        )}
        {capabilityUrl && !mediaFailed && block.mediaType === "audio" && (
          <div className={styles.audioFrame}>
            <span>{tFor(locale, "one.res.media.audio_result")}</span>
            <audio aria-label={displayValue(block.caption ?? block.title)} controls preload="metadata" src={capabilityUrl} onError={() => setMediaFailed(true)}>
              {tFor(locale, "one.res.media.audio_unplayable")}
            </audio>
          </div>
        )}
        {capabilityUrl && !mediaFailed && block.mediaType === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={capabilityUrl} alt={displayValue(block.caption ?? block.title)} referrerPolicy="no-referrer" onError={() => setMediaFailed(true)} />
        )}
        {unavailable && (
          <div className={styles.mediaUnavailable} role="status">
            <span>{tFor(locale, "one.res.media.source_preserved")}</span>
            <div>
              <button type="button" onClick={() => { setMediaFailed(false); preview.retry(); }}>{tFor(locale, "one.res.retry")}</button>
              <button type="button" onClick={onOpenWork}>{tFor(locale, "one.res.view_in_work")}</button>
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
    const api = ipc();
    if (!api?.oneArtifacts || !artifactContext) return;
    await api.oneArtifacts.open({ ...artifactContext, artifactRef: output.artifactRef }).catch(() => ({ opened: false }));
  }, [artifactContext, output.artifactRef]);
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
}: {
  block: OneSurfaceDocumentBlock;
  locale: "ko" | "en";
  artifactContext: OneArtifactBindingRequestV1 | null;
}) {
  const [openFailed, setOpenFailed] = useState(false);
  const open = useCallback(async () => {
    const api = ipc();
    if (!api?.oneArtifacts || !artifactContext) {
      setOpenFailed(true);
      return;
    }
    const result = await api.oneArtifacts.open({ ...artifactContext, artifactRef: block.artifactRef }).catch(() => ({ opened: false }));
    setOpenFailed(!result.opened);
  }, [artifactContext, block.artifactRef]);
  return <article className={styles.documentPreview} data-artifact-ref={block.artifactRef}>
    <div>
      <strong>{tFor(locale, "one.res.doc.preview")}</strong>
      <span>{block.pageCount != null ? tFor(locale, "one.res.doc.pages", { count: block.pageCount }) : tFor(locale, "one.res.doc.content_checked")}</span>
      <button type="button" onClick={() => void open()}>{tFor(locale, "one.res.open_file")}</button>
      {openFailed && <small role="status">{tFor(locale, "one.res.file_not_on_device")}</small>}
    </div>
    <p>{displayValue(block.excerpt)}</p>
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
  const [openFailed, setOpenFailed] = useState(false);
  const open = useCallback(async () => {
    const api = ipc();
    if (!api?.oneArtifacts || !artifactContext) {
      setOpenFailed(true);
      return;
    }
    const result = await api.oneArtifacts.open({ ...artifactContext, artifactRef: item.artifactRef }).catch(() => ({ opened: false }));
    setOpenFailed(!result.opened);
  }, [artifactContext, item.artifactRef]);
  return (
    <article className={styles.artifactCard} data-artifact-ref={item.artifactRef} data-verification-status={item.verificationStatus}>
      <div>
        <strong>{displayValue(item.label)}</strong>
        <span>{artifactTypeLabel(item.type, locale)} · {verificationLabel(item.verificationStatus, locale)}{item.sizeBytes != null ? ` · ${formatBytes(item.sizeBytes)}` : ""}</span>
        {openFailed && <small role="status">{tFor(locale, "one.res.file_not_on_device")}</small>}
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
    && item.secondaryActions.length === 0
    && Array.isArray(item.evidence)
    && item.evidence.every(isSafeEvidence)
    && isSafeSurfaceState(item.surfaceState)
    && isSafePrimaryAction(item.primaryAction)
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

function isSafePrimaryAction(value: unknown): boolean {
  return value === null || (isPlainRecord(value)
    && value.intent === "open_work"
    && typeof value.actionId === "string"
    && typeof value.label === "string"
    && typeof value.targetRef === "string"
    && value.enabled === true);
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

function RunClosure({ receipt, locale, onRetryUnfinished }: {
  receipt: InvocationRunReceipt;
  locale: "ko" | "en";
  onRetryUnfinished?: () => void;
}) {
  const stopped = receipt.status === "cancelled";
  const statusLabel = stopped
    ? tFor(locale, "one.res.closure.stopped_here")
    : tFor(locale, "one.res.closure.not_finished");
  const outcome = friendlyFailureMessage(receipt.errorMessage, locale, stopped);
  return (
    <section className={styles.failureClosure} role="status">
      <span className={styles.closureCheck} data-tone="bad" aria-hidden="true">!</span>
      <div className={styles.closureSummaryCopy}>
        <strong>{statusLabel}</strong>
        <small>{outcome}</small>
      </div>
      {!stopped && onRetryUnfinished && (
        <button type="button" className={styles.actionPrimary} onClick={onRetryUnfinished}>
          {tFor(locale, "one.res.closure.continue")}
        </button>
      )}
    </section>
  );
}

function friendlyFailureMessage(errorMessage: string | null | undefined, locale: "ko" | "en", stopped: boolean): string {
  if (stopped) {
    return tFor(locale, "one.res.fail.stopped");
  }

  const message = errorMessage?.toLowerCase() ?? "";
  if (/webfetch|web fetch|website|page|url|http|network|fetch/.test(message)) {
    return tFor(locale, "one.res.fail.webpage");
  }
  if (/permission|denied|unauthori[sz]ed|forbidden|access/.test(message)) {
    return tFor(locale, "one.res.fail.access");
  }
  if (/timeout|timed out|deadline/.test(message)) {
    return tFor(locale, "one.res.fail.timeout");
  }
  return tFor(locale, "one.res.fail.generic");
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
  return redactLocalPaths(redactSecrets(value))
    .replace(/\[([^\]]+)\]\(\s*\[?link omitted\]?\s*\)/gi, "$1")
    .replace(/\[link omitted\]/gi, "")
    .replace(/(\*\*|__)([^\r\n]+?)\1/g, "$2")
    .replace(/`([^`\r\n]+)`/g, "$1")
    .replace(/[✅❌⚠]\uFE0F?/gu, "")
    .replace(/[ \t]{2,}/g, " ")
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
