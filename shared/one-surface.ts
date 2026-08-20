import { isPrimarilyKorean } from "./detect-language";
import { redactSecrets } from "./secret-patterns";
import type {
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
} from "./types";

export type OneSurfaceLayoutProfile =
  | "briefing"
  | "comparison"
  | "report"
  | "itinerary"
  | "media"
  | "operations";

export type OneSurfaceStateValue = "loading" | "partial" | "ready" | "error" | "stale" | "offline";

/** Authoritative v1 semantic vocabulary shared by Desktop and Mobile. */
export const ONE_SURFACE_BLOCK_TYPES = [
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
] as const;

export type OneSurfaceBlockType = (typeof ONE_SURFACE_BLOCK_TYPES)[number];

export type OneSurfaceSemanticActionIntent =
  | "open_work"
  | "approve_decision"
  | "reject_decision"
  | "modify_decision"
  | "snooze_decision"
  | "open_artifact"
  | "open_sources"
  | "open_receipt"
  | "retry_failed_step"
  | "cancel_task"
  | "resume_task"
  | "save_result"
  | "change_conditions"
  | "view_details"
  | "edit_asset"
  | "disable_asset"
  | "use_once"
  | "delete_asset"
  | "reopen_intro"
  | "connect_desktop"
  | "try_result"
  | "open_asset"
  | "refine_result"
  | "reuse_result"
  | "prepare_share"
  | "run_automation"
  | "open_automation"
  | "open_build"
  | "toggle_mcp_server";

export interface OneSurfaceSemanticAction {
  actionId: string;
  intent: OneSurfaceSemanticActionIntent;
  label: string;
  description?: string;
  instruction?: string;
  targetRef?: string;
  enabled: boolean;
  blockedReason?: string;
}

export interface OneSurfaceArtifactSummary {
  artifactRef: string;
  type: "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data" | "other";
  label: string;
  verificationStatus: "verified" | "partially_verified" | "unverified";
  sizeBytes?: number;
}

export interface OneSurfaceNarrativeBlock {
  blockId: string;
  type: "Narrative";
  title: string;
  paragraphs: string[];
}

export interface OneSurfaceMetricBlock {
  blockId: string;
  type: "Metric";
  title: string;
  items: Array<{
    metricId: string;
    label: string;
    value: string | number;
    unit?: string;
    verificationStatus: "verified" | "estimated" | "unverified";
    evidenceRefs?: string[];
  }>;
}

export interface OneSurfaceTableBlock {
  blockId: string;
  type: "Table";
  title: string;
  columns: Array<{ columnId: string; label: string }>;
  featuredColumnIds: string[];
  rows: Array<{
    rowId: string;
    cells: Array<{ columnId: string; value: string | number | boolean | null }>;
  }>;
}

export interface OneSurfaceComparisonBlock {
  blockId: string;
  type: "Comparison";
  title: string;
  recommendedOptionRef: string;
  options: Array<{
    optionRef: string;
    title: string;
    subtitle?: string;
    artifactRef?: string;
    strengths: string[];
    limitations: string[];
  }>;
}

export interface OneSurfaceTimelineBlock {
  blockId: string;
  type: "Timeline";
  title: string;
  items: Array<{
    itemId: string;
    at?: string;
    title: string;
    detail?: string;
    status: "upcoming" | "in_progress" | "completed" | "failed" | "cancelled";
  }>;
}

export interface OneSurfaceMapBlock {
  blockId: string;
  type: "Map";
  title: string;
  locations: Array<{
    locationRef: string;
    label: string;
    latitude: number;
    longitude: number;
    sequence?: number;
  }>;
}

export interface OneSurfaceGalleryBlock {
  blockId: string;
  type: "Gallery";
  title: string;
  items: Array<{
    artifactRef: string;
    label: string;
    altText: string;
    provenance: "user_original" | "generated" | "edited" | "licensed_source" | "unknown_source";
  }>;
}

export interface OneSurfaceMediaBlock {
  blockId: string;
  type: "Media";
  title: string;
  primaryArtifactRef: string;
  mediaType: "video" | "audio" | "image";
  caption?: string;
  durationSeconds?: number;
  outputs: Array<{
    artifactRef: string;
    type: "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data" | "other";
    label: string;
    verificationStatus: "verified" | "partially_verified" | "unverified";
    sizeBytes?: number;
  }>;
}

export interface OneSurfaceDocumentBlock {
  blockId: string;
  type: "Document";
  title: string;
  artifactRef: string;
  excerpt: string;
  pageCount?: number;
}

export interface OneSurfaceArtifactListBlock {
  blockId: string;
  type: "ArtifactList";
  title: string;
  items: Array<{
    artifactRef: string;
    type: "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data" | "other";
    label: string;
    verificationStatus: "verified" | "partially_verified" | "unverified";
    sizeBytes?: number;
  }>;
}

export interface OneSurfaceSourceListBlock {
  blockId: string;
  type: "SourceList";
  title: string;
  sources: Array<{
    sourceRef: string;
    title: string;
    publisher?: string;
    verificationStatus: "verified" | "partially_verified" | "unverified";
    claimRefs?: string[];
  }>;
}

export interface OneSurfaceDecisionBlock {
  blockId: string;
  type: "Decision";
  title: string;
  decisionId: string;
  prompt: string;
  risk: "low" | "moderate" | "high" | "critical";
  options: Array<{ optionRef: string; label: string; consequence: string }>;
  deadline?: string;
}

export interface OneSurfaceStatusBlock {
  blockId: string;
  type: "Status";
  title: string;
  taskState: "waiting" | "working" | "decision_required" | "completed" | "failed" | "stopped";
  steps: Array<{
    stepRef: string;
    label: string;
    status: "waiting" | "working" | "decision_required" | "completed" | "failed" | "stopped";
    receiptRef?: string;
  }>;
}

export interface OneSurfaceBudgetBlock {
  blockId: string;
  type: "Budget";
  title: string;
  currency: string;
  total: number;
  limit: number;
  lines: Array<{
    lineRef: string;
    label: string;
    amount: number;
    verificationStatus: "verified" | "estimated" | "unverified";
  }>;
}

export interface OneSurfaceChecklistBlock {
  blockId: string;
  type: "Checklist";
  title: string;
  items: Array<{
    itemRef: string;
    label: string;
    status: "not_started" | "in_progress" | "completed" | "failed" | "not_applicable";
    evidenceRef?: string;
  }>;
}

export interface OneSurfaceValueClosureBlock {
  blockId: string;
  type: "ValueClosure";
  title: string;
  valueClosureRef: string;
}

export interface OneSurfaceImprovementProofBlock {
  blockId: string;
  type: "ImprovementProof";
  title: string;
  improvementProofRef: string;
  collapsedByDefault: true;
}

/**
 * A registered automation as a first-class One result. The host registers the
 * automation first; the block only mirrors that receipt (never a promise).
 */
export interface OneSurfaceAutomationBlock {
  blockId: string;
  type: "Automation";
  title: string;
  /** The registered automation's id — the run/open actions target exactly it. */
  automationId: string;
  status: "registered" | "running" | "failed";
  /** Human schedule text, e.g. "매일 9시" / "daily-09:00". */
  schedule?: string;
  /** Workflow node summary — what the automation does, step by step. */
  nodes: Array<{ nodeRef: string; label: string }>;
  /** The most recent execution, if one has happened. */
  lastRun?: {
    at?: string;
    status: "completed" | "failed" | "cancelled" | "running";
    summary?: string;
  };
}

/** An agent build session's produced/in-progress stages as a One result. */
export interface OneSurfaceAgentBuildBlock {
  blockId: string;
  type: "AgentBuild";
  title: string;
  buildSessionId: string;
  agentName: string;
  agentSlug?: string;
  /**
   * 사람이 읽는 빌드 사양. One 의 [빌드 열기] 가 이 문장을 Build 화면의 요청 칸에
   * 실어 보낸다 — 이게 없으면 카드를 눌러도 빈 화면이 열려 사용자가 방금 One 과
   * 합의한 사양을 손으로 다시 쓰게 된다.
   */
  request?: string;
  stages: Array<{
    stageRef: string;
    label: string;
    status: "waiting" | "working" | "completed" | "failed";
  }>;
}

/** MCP server setup state — which connectors are on and which need keys. */
export interface OneSurfaceMcpSetupBlock {
  blockId: string;
  type: "McpSetup";
  title: string;
  servers: Array<{
    catalogId: string;
    name: string;
    enabled: boolean;
    keyState: "not_required" | "missing" | "configured";
  }>;
}

export type OneSurfaceBlock =
  | OneSurfaceNarrativeBlock
  | OneSurfaceMetricBlock
  | OneSurfaceTableBlock
  | OneSurfaceComparisonBlock
  | OneSurfaceTimelineBlock
  | OneSurfaceMapBlock
  | OneSurfaceGalleryBlock
  | OneSurfaceMediaBlock
  | OneSurfaceDocumentBlock
  | OneSurfaceArtifactListBlock
  | OneSurfaceSourceListBlock
  | OneSurfaceDecisionBlock
  | OneSurfaceStatusBlock
  | OneSurfaceBudgetBlock
  | OneSurfaceChecklistBlock
  | OneSurfaceValueClosureBlock
  | OneSurfaceImprovementProofBlock
  | OneSurfaceAutomationBlock
  | OneSurfaceAgentBuildBlock
  | OneSurfaceMcpSetupBlock;

export interface OneSurfaceManifestV1 {
  contractVersion: "1.0.0";
  manifestId: string;
  taskId: string;
  title: string;
  summary: string;
  layoutProfile: OneSurfaceLayoutProfile;
  surfaceState: {
    value: OneSurfaceStateValue;
    summary: string;
    readOnly: boolean;
    lastSyncedAt?: string;
    incompleteBlockIds?: string[];
    failedStepRefs?: string[];
  };
  blocks: OneSurfaceBlock[];
  primaryAction: OneSurfaceSemanticAction | null;
  secondaryActions: [] | [OneSurfaceSemanticAction] | [OneSurfaceSemanticAction, OneSurfaceSemanticAction];
  evidence: Array<{
    evidenceRef: string;
    kind: "source" | "receipt" | "artifact_verification" | "outcome" | "baseline";
    verificationStatus: "verified" | "partially_verified" | "unverified" | "estimated";
    claimRefs?: string[];
    label?: string;
  }>;
  fallback: { markdown: string; artifacts: OneSurfaceArtifactSummary[] };
  recomposition: {
    desktop: {
      blockOrder: string[];
      tableStrategy: "full_table" | "compact_table";
      comparisonStrategy: "matrix" | "split_view";
      timelineStrategy: "adaptive" | "horizontal" | "vertical";
    };
    mobile: {
      blockOrder: string[];
      tableStrategy: "featured_cards_then_sheet" | "stacked_rows";
      comparisonStrategy: "recommended_then_alternatives";
      timelineStrategy: "vertical";
    };
  };
}

const EXECUTABLE_RE = /(?:<\s*(?:script|iframe|object|embed|style|svg)\b|javascript\s*:|data\s*:\s*text\/html|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const URL_RE = /\b(?:https?:\/\/|file:)[^\s]+/gi;
const POSIX_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/gm;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/g;
const SENSITIVE_ID_TRANSPORT_RE = /(?:\b(?:https?:\/\/|file:|data:)|^\/|^[A-Za-z]:\\|^\\\\)/i;

/**
 * Main-safe transitional adapter. It converts only the legacy declarative
 * datasets whose meaning can be preserved on both React and Flutter. Unknown,
 * executable, or oversized content becomes one non-executable fallback block.
 */
export function adaptLegacySurfaceToOneV1(input: {
  manifest: AgentlasSurfaceManifest;
  surfaceId: string;
  taskId: string;
  syncedAt: string;
}): OneSurfaceManifestV1 {
  const { manifest, taskId, syncedAt } = input;
  const manifestId = safeId(input.surfaceId, `surface:${safeId(taskId, "task")}`);
  const unsafe = EXECUTABLE_RE.test(safeSerialize(manifest));
  const hangulCount = safeSerialize(manifest).match(/[가-힣]/g)?.length ?? 0;
  const ko = hangulCount >= 12 || /[가-힣]/.test(manifest.title || "");
  const convertedBlocks = unsafe ? [] : legacyBlocks(manifest, ko);
  const sourceBlock = unsafe ? null : legacySourceListBlock(manifest, ko);
  const native = convertedBlocks.length > 0;
  const finalBlocks: OneSurfaceBlock[] = native
    ? (sourceBlock ? [...convertedBlocks, sourceBlock] : convertedBlocks)
    : [{
        blockId: "block:fallback",
        type: "Narrative",
        title: ko ? "자세한 결과" : "Detailed result",
        paragraphs: [ko
          ? "이 화면에서 다 보여줄 수 없는 결과예요. 연결된 컴퓨터에서 원본을 확인해주세요."
          : "This result needs a larger screen. Open the original on your connected computer."],
      }, ...(sourceBlock ? [sourceBlock] : [])];
  const blockOrder = finalBlocks.map((block) => block.blockId);
  const evidence = legacyEvidence(manifest, manifestId, ko);
  return {
    contractVersion: "1.0.0",
    manifestId,
    taskId: safeId(taskId, "task:unknown"),
    title: safeLabel(manifest.title || "Task result"),
    summary: native
      ? safeText(ko ? "필요한 내용만 모았어요." : "Here are the parts you need.")
      : safeText(ko ? "원본 결과는 연결된 컴퓨터에 있어요." : "The original result is available on your connected computer."),
    layoutProfile: layoutProfile(manifest.layout),
    surfaceState: {
      value: "ready",
      summary: native ? (ko ? "결과 준비 완료" : "Result ready") : (ko ? "안전한 대체 결과 준비 완료" : "Safe fallback ready"),
      readOnly: true,
      lastSyncedAt: syncedAt,
    },
    blocks: finalBlocks,
    // A legacy Surface is already the user-facing result. Never invent an
    // "original" destination: projectless One work has no honest Work target.
    // Controller-authored follow-ups may replace this null action later.
    primaryAction: null,
    secondaryActions: [],
    evidence,
    fallback: {
      markdown: safeMarkdown(ko ? "원본 결과와 출처는 연결된 컴퓨터에서 확인할 수 있어요." : "The original result and sources are available on your connected computer."),
      artifacts: legacyFallbackArtifacts(manifest),
    },
    recomposition: {
      desktop: {
        blockOrder,
        tableStrategy: "full_table",
        comparisonStrategy: "matrix",
        timelineStrategy: "adaptive",
      },
      mobile: {
        blockOrder,
        tableStrategy: "featured_cards_then_sheet",
        comparisonStrategy: "recommended_then_alternatives",
        timelineStrategy: "vertical",
      },
    },
  };
}

function localizedGenericBlockTitle(value: string, datasetType: string, ko: boolean): string {
  const title = safeLabel(value);
  const normalized = title
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[：:]$/, "")
    .trim();
  const genericByType: Record<string, Set<string>> = {
    markdown: new Set(["summary", "overview", "key summary", "핵심 요약", "요약"]),
    table: new Set(["comparison", "table", "results", "비교", "표", "결과"]),
    timeline: new Set(["schedule", "itinerary", "timeline", "travel schedule", "일정", "여행 일정"]),
    pricing: new Set(["cost", "costs", "budget", "pricing", "estimated costs", "예상 비용", "비용", "예산"]),
    "launch-checklist": new Set(["checklist", "pre trip checklist", "pre-trip checklist", "preparation checklist", "준비 체크리스트", "체크리스트"]),
    routes: new Set(["route", "routes", "map", "locations", "이동 경로", "경로", "지도"]),
    artifacts: new Set(["artifacts", "files", "documents", "결과 파일", "파일", "문서"]),
    media: new Set(["media", "gallery", "images", "video", "결과물", "갤러리", "이미지", "영상"]),
  };
  if (!genericByType[datasetType]?.has(normalized)) return title;
  const localized: Record<string, [string, string]> = {
    markdown: ["핵심 요약", "Summary"],
    table: ["비교", "Comparison"],
    timeline: ["일정", "Schedule"],
    pricing: ["예상 비용", "Costs"],
    "launch-checklist": ["준비 체크리스트", "Checklist"],
    routes: ["이동 경로", "Routes"],
    artifacts: ["결과 파일", "Files"],
    media: ["결과물", "Media"],
  };
  return localized[datasetType]?.[ko ? 0 : 1] ?? title;
}

function legacyBlocks(manifest: AgentlasSurfaceManifest, ko: boolean): OneSurfaceBlock[] {
  const keys = orderedKeys(manifest).slice(0, 12);
  const blocks: OneSurfaceBlock[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const dataset = manifest.data[key];
    const blockId = `block:${safeId(key, `item-${index + 1}`)}`;
    const title = localizedGenericBlockTitle(
      manifest.widgets.find((widget) => widget.data === key)?.title || humanize(key),
      dataset.type,
      ko,
    );
    const block = datasetBlock(dataset, blockId, title, ko);
    if (block) blocks.push(block);
  }
  return blocks.length ? blocks : [];
}

function legacySourceListBlock(manifest: AgentlasSurfaceManifest, ko: boolean): OneSurfaceSourceListBlock | null {
  const sources = (manifest.evidence ?? []).slice(0, 100).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const title = item.label || item.source;
    if (!title) return [];
    return [{
      sourceRef: safeId(item.id, `source:${index + 1}`),
      title: safeLabel(title),
      ...(item.source && item.source !== title ? { publisher: safeLabel(item.source) } : {}),
      verificationStatus: item.kind === "verified"
        ? "verified" as const
        : item.kind === "claimed"
          ? "partially_verified" as const
          : "unverified" as const,
    }];
  });
  return sources.length > 0
    ? { blockId: "block:sources", type: "SourceList", title: ko ? "확인한 출처" : "Sources", sources }
    : null;
}

function localizedGenericColumnLabel(value: string, ko: boolean): string {
  const label = safeLabel(humanize(value));
  const normalized = label.toLocaleLowerCase().replace(/[\s_-]+/g, " ").trim();
  const labels: Array<[Set<string>, string, string]> = [
    [new Set(["choice", "selection", "선택"]), "선택", "Choice"],
    [new Set(["product", "item", "model", "제품", "상품", "모델"]), "제품", "Product"],
    [new Set(["price", "cost", "lowest price", "current price", "가격", "최저가", "현재 가격"]), "가격", "Price"],
    [new Set(["area", "coverage", "coverage area", "standard coverage", "사용면적", "표준사용면적", "면적"]), "사용면적", "Coverage"],
    [new Set(["reason", "why", "이유"]), "이유", "Why"],
    [new Set(["strength", "strengths", "pros", "장점"]), "장점", "Strengths"],
    [new Set(["limitation", "limitations", "cons", "한계", "단점", "아쉬운 점"]), "아쉬운 점", "Limitations"],
    [new Set(["date", "날짜"]), "날짜", "Date"],
    [new Set(["category", "분류"]), "분류", "Category"],
    [new Set(["merchant", "store", "vendor", "사용처", "판매처"]), "사용처", "Merchant"],
    [new Set(["amount", "금액"]), "금액", "Amount"],
    [new Set(["memo", "note", "notes", "메모", "비고"]), "메모", "Notes"],
    [new Set(["status", "state", "상태"]), "상태", "Status"],
  ];
  const match = labels.find(([aliases]) => aliases.has(normalized));
  return match ? match[ko ? 1 : 2] : label;
}

function datasetBlock(dataset: AgentlasSurfaceDataSet, blockId: string, title: string, ko: boolean): OneSurfaceBlock | null {
  const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
  const items = Array.isArray(dataset.items) ? dataset.items : [];
  if (dataset.type === "markdown" && typeof dataset.value === "string") {
    const paragraphs = safeText(dataset.value, 16_000).split(/\n\s*\n/).filter(Boolean).slice(0, 12);
    return paragraphs.length ? { blockId, type: "Narrative", title, paragraphs } : null;
  }
  if (dataset.type === "metrics") {
    const source = (items.length ? items : rows).slice(0, 8);
    if (!source.length) return null;
    return {
      blockId,
      type: "Metric",
      title,
      items: source.map((item, index) => {
        const entries = Object.entries(item);
        const rawValue = findValue(item, ["value", "amount", "count", "total", "score"]) ?? entries[0]?.[1] ?? "—";
        const rawLabel = findValue(item, ["label", "name", "title", "metric"]) ?? entries[1]?.[1] ?? `Metric ${index + 1}`;
        return {
          metricId: `${blockId}:metric-${index + 1}`,
          label: safeLabel(display(rawLabel)),
          value: typeof rawValue === "number" ? rawValue : safeLabel(display(rawValue)),
          verificationStatus: "unverified" as const,
        };
      }),
    };
  }
  if (dataset.type === "table") {
    const columns = (dataset.columns?.length ? dataset.columns : collectColumns(rows))
      .filter((column) => !internalDatasetColumn(column))
      .slice(0, 12);
    if (!columns.length || !rows.length) return null;
    const normalizedColumns = columns.map((column, index) => ({
      columnId: `${blockId}:column-${index + 1}`,
      label: localizedGenericColumnLabel(column, ko),
      source: column,
    }));
    const tableRows = rows.slice(0, 200).map((row, rowIndex) => ({
      rowId: `${blockId}:row-${rowIndex + 1}`,
      cells: normalizedColumns.map((column) => ({
        columnId: column.columnId,
        value: safeCell(row[column.source]),
      })),
    }));
    const requiredMeaningfulCells = Math.min(2, normalizedColumns.length);
    const informativeRows = tableRows.filter((row) => (
      row.cells.filter((cell) => meaningfulTableCell(cell.value)).length >= requiredMeaningfulCells
    ));
    if (!informativeRows.length) return null;
    return {
      blockId,
      type: "Table",
      title,
      columns: normalizedColumns.map(({ columnId, label }) => ({ columnId, label })),
      featuredColumnIds: normalizedColumns.slice(0, Math.min(4, normalizedColumns.length)).map((column) => column.columnId),
      rows: informativeRows,
    };
  }
  if (dataset.type === "timeline") {
    const source = (items.length ? items : rows).slice(0, 100);
    if (!source.length) return null;
    return {
      blockId,
      type: "Timeline",
      title,
      items: source.map((item, index) => ({
        itemId: `${blockId}:item-${index + 1}`,
        title: safeLabel(display(findValue(item, ["title", "label", "name", "event"]) ?? `Step ${index + 1}`)),
        ...(validIso(findValue(item, ["at", "date", "time", "start"])) ? { at: String(findValue(item, ["at", "date", "time", "start"])) } : {}),
        ...(findValue(item, ["detail", "description", "summary"]) != null
          ? { detail: safeText(display(findValue(item, ["detail", "description", "summary"]))) }
          : {}),
        status: timelineStatus(findValue(item, ["status", "state"])),
      })),
    };
  }
  if (dataset.type === "routes") {
    const source = (items.length ? items : rows).slice(0, 50);
    const locations = source.flatMap((item, index) => {
      const latitude = finiteCoordinate(findValue(item, ["latitude", "lat"]), -90, 90);
      const longitude = finiteCoordinate(findValue(item, ["longitude", "lng", "lon"]), -180, 180);
      if (latitude == null || longitude == null) return [];
      return [{
        locationRef: `${blockId}:location-${index + 1}`,
        label: safeLabel(display(findValue(item, ["label", "title", "name", "place", "stop"]) ?? `Stop ${index + 1}`)),
        latitude,
        longitude,
        sequence: index + 1,
      }];
    });
    return locations.length > 0 ? { blockId, type: "Map", title, locations } : null;
  }
  if (dataset.type === "pricing") {
    const source = (items.length ? items : rows).slice(0, 100);
    const lines = source.flatMap((item, index) => {
      const amount = finiteNonNegative(findValue(item, ["amount", "price", "cost", "total"]));
      if (amount == null) return [];
      return [{
        lineRef: `${blockId}:line-${index + 1}`,
        label: safeLabel(display(findValue(item, ["label", "title", "name", "category", "item"]) ?? `Item ${index + 1}`)),
        amount,
        verificationStatus: priceVerificationStatus(findValue(item, ["verificationStatus", "verification", "status", "trust"])),
      }];
    });
    if (!lines.length) return null;
    const value = jsonObject(dataset.value);
    const total = lines.reduce((sum, line) => sum + line.amount, 0);
    const limit = finiteNonNegative(dataset.limit)
      ?? finiteNonNegative(value?.limit)
      ?? finiteNonNegative(dataset.budget)
      ?? total;
    const currencyValue = String(dataset.currency ?? value?.currency ?? "").toUpperCase();
    const currency = /^[A-Z]{3}$/.test(currencyValue)
      ? currencyValue
      : isPrimarilyKorean(safeSerialize(dataset)) ? "KRW" : "USD";
    return { blockId, type: "Budget", title, currency, total, limit, lines };
  }
  if (dataset.type === "media") {
    const source = (items.length ? items : rows).slice(0, 24);
    if (!source.length) return null;
    const outputs = source.map((item, index) => {
      const type = mediaArtifactType(item);
      const size = findValue(item, ["sizeBytes", "size"]);
      return {
        artifactRef: `${blockId}:artifact-${index + 1}`,
        type,
        label: safeLabel(display(findValue(item, ["label", "title", "name", "scene", "file"]) ?? `Media ${index + 1}`)),
        verificationStatus: "unverified" as const,
        ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
      };
    });
    if (outputs.every((item) => item.type === "image")) {
      return {
        blockId,
        type: "Gallery",
        title,
        items: outputs.map((output, index) => ({
          artifactRef: output.artifactRef,
          label: output.label,
          altText: safeLabel(display(findValue(source[index], ["altText", "alt", "description", "caption"]) ?? output.label)),
          provenance: mediaProvenance(source[index]),
        })),
      };
    }
    const candidateIndex = outputs.findIndex((item) => item.type === "video" || item.type === "audio" || item.type === "image");
    const primaryIndex = candidateIndex >= 0 ? candidateIndex : 0;
    const primary = outputs[primaryIndex];
    const primaryType = primary.type === "video" || primary.type === "audio" || primary.type === "image"
      ? primary.type
      : "image";
    const duration = finiteNonNegative(findValue(source[primaryIndex], ["durationSeconds", "duration_seconds"]));
    return {
      blockId,
      type: "Media",
      title,
      primaryArtifactRef: primary.artifactRef,
      mediaType: primaryType,
      ...(findValue(source[primaryIndex], ["caption", "description", "summary"]) != null
        ? { caption: safeText(display(findValue(source[primaryIndex], ["caption", "description", "summary"]))) }
        : {}),
      ...(duration != null ? { durationSeconds: duration } : {}),
      outputs,
    };
  }
  if (dataset.type === "artifacts") {
    const source = (items.length ? items : rows).slice(0, 100);
    if (!source.length) return null;
    return {
      blockId,
      type: "ArtifactList",
      title,
      items: source.map((item, index) => ({
        artifactRef: `${blockId}:artifact-${index + 1}`,
        type: artifactType(
          findValue(item, ["type", "kind", "format", "mime", "mimeType"])
          ?? findValue(item, ["path", "filePath", "localPath", "file", "label", "title", "name"]),
        ),
        label: safeLabel(display(findValue(item, ["label", "title", "name", "file"]) ?? `Artifact ${index + 1}`)),
        verificationStatus: "unverified" as const,
        ...(typeof findValue(item, ["sizeBytes", "size"]) === "number" && Number(findValue(item, ["sizeBytes", "size"])) >= 0
          ? { sizeBytes: Math.floor(Number(findValue(item, ["sizeBytes", "size"]))) }
          : {}),
      })),
    };
  }
  if (dataset.type === "launch-checklist") {
    const source = (items.length ? items : rows).slice(0, 100);
    if (!source.length) return null;
    return {
      blockId,
      type: "Checklist",
      title,
      items: source.map((item, index) => ({
        itemRef: `${blockId}:item-${index + 1}`,
        label: safeLabel(display(findValue(item, ["label", "title", "name", "task"]) ?? `Item ${index + 1}`)),
        status: checklistStatus(findValue(item, ["status", "state"])),
      })),
    };
  }
  return null;
}

function internalDatasetColumn(value: string): boolean {
  const normalized = value.replace(/[\s_-]+/g, "").toLowerCase();
  return /^(?:evidence|source|provenance)(?:id|ids|ref|refs)$/.test(normalized);
}

function legacyFallbackArtifacts(manifest: AgentlasSurfaceManifest): OneSurfaceArtifactSummary[] {
  const artifacts: OneSurfaceArtifactSummary[] = [];
  const keys = orderedKeys(manifest).slice(0, 12);
  keys.forEach((key, keyIndex) => {
    const dataset = manifest.data[key];
    if (!dataset || (dataset.type !== "media" && dataset.type !== "artifacts")) return;
    const source = (Array.isArray(dataset.items) && dataset.items.length ? dataset.items : dataset.rows ?? [])
      .slice(0, dataset.type === "media" ? 24 : 100);
    const blockId = `block:${safeId(key, `item-${keyIndex + 1}`)}`;
    source.forEach((item, itemIndex) => {
      const size = findValue(item, ["sizeBytes", "size"]);
      artifacts.push({
        artifactRef: `${blockId}:artifact-${itemIndex + 1}`,
        type: dataset.type === "media"
          ? mediaArtifactType(item)
          : artifactType(
            findValue(item, ["type", "kind", "format", "mime", "mimeType"])
            ?? findValue(item, ["path", "filePath", "localPath", "file", "label", "title", "name"]),
          ),
        label: safeLabel(display(findValue(item, ["label", "title", "name", "scene", "file"]) ?? `Artifact ${itemIndex + 1}`)),
        verificationStatus: "unverified",
        ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
      });
    });
  });
  return artifacts.slice(0, 512);
}

function mediaArtifactType(item: JsonObject): OneSurfaceArtifactSummary["type"] {
  const declared = String(findValue(item, ["mediaType", "mimeType", "mime", "type", "kind"]) ?? "").toLowerCase();
  if (declared === "image" || declared.startsWith("image/")) return "image";
  if (declared === "video" || declared.startsWith("video/")) return "video";
  if (declared === "audio" || declared.startsWith("audio/")) return "audio";
  const source = String(findValue(item, [
    "path", "filePath", "localPath", "fileUrl", "src", "url", "previewUrl", "thumbnail", "imageUrl", "videoUrl", "audioUrl",
  ]) ?? "").split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(?:png|jpe?g|webp|gif|avif|bmp)$/.test(source)) return "image";
  if (/\.(?:mp4|webm|mov|m4v|ogv)$/.test(source)) return "video";
  if (/\.(?:mp3|m4a|wav|ogg|flac|aac)$/.test(source)) return "audio";
  return "other";
}

function mediaProvenance(item: JsonObject): OneSurfaceGalleryBlock["items"][number]["provenance"] {
  const value = String(findValue(item, ["provenance", "status", "origin", "sourceKind"]) ?? "").toLowerCase();
  if (value.includes("edit")) return "edited";
  if (value.includes("licens")) return "licensed_source";
  if (value.includes("generat") || value.includes("render")) return "generated";
  if (value.includes("user") || value.includes("original") || value.includes("upload")) return "user_original";
  return "unknown_source";
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function priceVerificationStatus(value: unknown): OneSurfaceBudgetBlock["lines"][number]["verificationStatus"] {
  const status = String(value ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (status === "verified" || status === "confirmed" || status === "checked") return "verified";
  if (status === "unverified" || status === "unknown") return "unverified";
  return "estimated";
}

function legacyEvidence(manifest: AgentlasSurfaceManifest, manifestId: string, ko: boolean): OneSurfaceManifestV1["evidence"] {
  const items = (manifest.evidence ?? []).slice(0, 63).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const status = item.kind === "verified"
      ? "verified"
      : item.kind === "estimated"
        ? "estimated"
        : "unverified";
    return [{
      evidenceRef: safeId(item.id, `evidence:${index + 1}`),
      kind: "source" as const,
      verificationStatus: status as "verified" | "estimated" | "unverified",
      ...(item.label || item.source ? { label: safeLabel(item.label || item.source || "Source") } : {}),
    }];
  });
  return items.length ? items : [{
    evidenceRef: manifestId,
    kind: "receipt",
    verificationStatus: "unverified",
    label: ko ? "앱에서 확인한 작업 기록" : "App work record",
  }];
}

function orderedKeys(manifest: AgentlasSurfaceManifest): string[] {
  const keys = Object.keys(manifest.data ?? {});
  const ordered: string[] = [];
  for (const widget of manifest.widgets ?? []) {
    if (widget.data && keys.includes(widget.data) && !ordered.includes(widget.data)) ordered.push(widget.data);
  }
  for (const key of keys) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function collectColumns(rows: JsonObject[]): string[] {
  const keys: string[] = [];
  for (const row of rows.slice(0, 32)) {
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function findValue(object: JsonObject, keys: string[]): JsonValue | undefined {
  for (const key of keys) if (object[key] != null) return object[key];
  return undefined;
}

function safeCell(value: JsonValue | undefined): string | number | boolean | null {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value ?? null;
  return safeText(display(value));
}

function meaningfulTableCell(value: string | number | boolean | null): boolean {
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0
    && !/^(?:—+|-+|n\/?a|not provided|unknown|확인(?:되지|하지) 않음|미확인)$/.test(normalized);
}

function display(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return safeSerialize(value).slice(0, 3_900) || "—";
}

function safeId(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const rawIsSensitive = redactSecrets(raw) !== raw || SENSITIVE_ID_TRANSPORT_RE.test(raw);
  const candidate = rawIsSensitive ? "" : raw;
  const cleaned = candidate.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(cleaned)) return cleaned;
  const safeFallback = redactSecrets(fallback) === fallback && !SENSITIVE_ID_TRANSPORT_RE.test(fallback)
    ? fallback
    : "one:unknown";
  const backup = safeFallback.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 128);
  return backup.length >= 3 ? backup : "one:unknown";
}

function clean(value: string, max: number): string {
  const output = redactSecrets(value)
    .replace(/\[([^\]\r\n]{1,240})\]\((?:https?:\/\/|file:)[^)\s]+\)/gi, "$1")
    .replace(URL_RE, "[link omitted]")
    .replace(/\[([^\]\r\n]{1,240})\]\(\s*\[?link omitted\]?\s*\)?/gi, "$1")
    .replace(/\(\s*\[?link omitted\]?\s*\)?/gi, "")
    .replace(/\[link omitted\]/gi, "")
    .replace(POSIX_PATH_RE, (_match, prefix: string) => `${prefix}[local path]`)
    .replace(WINDOWS_PATH_RE, "[local path]")
    .replace(UNC_PATH_RE, "[local path]")
    .replace(/data:[^,\s]{1,128},[^\s]+/gi, "[embedded data omitted]")
    .replace(/</g, "‹")
    .trim()
    .slice(0, max);
  return output || "Not provided";
}

function safeLabel(value: string): string {
  return clean(value, 160);
}

function safeText(value: string, max = 4_000): string {
  return clean(value, max);
}

function safeMarkdown(value: string): string {
  return clean(value, 16_000);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function layoutProfile(layout: string): OneSurfaceLayoutProfile {
  if (layout === "table" || layout === "dashboard") return "comparison";
  if (layout === "timeline" || layout === "map-list") return "itinerary";
  if (layout === "creative-studio") return "media";
  if (layout === "workflow" || layout === "service-app" || layout === "form") return "operations";
  return "report";
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timelineStatus(value: unknown): OneSurfaceTimelineBlock["items"][number]["status"] {
  const status = String(value ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (status === "in_progress" || status === "working" || status === "running") return "in_progress";
  if (status === "completed" || status === "done" || status === "succeeded") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled" || status === "stopped") return "cancelled";
  return "upcoming";
}

function checklistStatus(value: unknown): OneSurfaceChecklistBlock["items"][number]["status"] {
  const status = String(value ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (status === "in_progress" || status === "working" || status === "running") return "in_progress";
  if (status === "completed" || status === "done" || status === "succeeded" || status === "true") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "not_applicable" || status === "skipped") return "not_applicable";
  return "not_started";
}

function artifactType(value: unknown): OneSurfaceArtifactListBlock["items"][number]["type"] {
  const raw = String(value ?? "").toLowerCase();
  if (/spreadsheet|excel|xlsx?|csv|sheet/.test(raw)) return "spreadsheet";
  if (/document|docx|pdf|text|\.(?:md|mdx|txt)$/.test(raw)) return "document";
  if (/image|png|jpe?g|webp/.test(raw)) return "image";
  if (/video|mp4|mov/.test(raw)) return "video";
  if (/audio|mp3|wav/.test(raw)) return "audio";
  if (/archive|zip|tar/.test(raw)) return "archive";
  if (/json|data|\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|sh|bash|zsh|html|css|scss)$/.test(raw)) return "data";
  return "other";
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
