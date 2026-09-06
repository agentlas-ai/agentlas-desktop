// ProjectTask cockpit — 프로젝트 소유 작업의 대화, 실행, inspector.
"use client";
import { Suspense, useCallback, useEffect, useRef, useState, useMemo, type Dispatch, type SetStateAction } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import type {
  Chat,
  AgentlasSurfaceAction,
  AppFactoryAppRecord,
  AppFactoryScaffoldResult,
  ImageAttachment,
  HubAgentBookmark,
  InstalledAgent,
  InstalledFirm,
  InstalledMcpServer,
  ResolvedOrg,
  McpInvocationEvent,
  McpRunKeyRequest,
  Project,
  RuntimeStatus,
  ToolFactoryScaffoldResult,
  ToolFactoryToolRecord,
} from "@/lib/types";
import type {
  AgentMessageDirection,
  AgentProcessState,
  ChatGoalContext,
  InvocationRunReceipt,
  OrchestrationTarget,
  Recommendation,
  RecExecChoice,
  RecRouterAgent,
  RecStage,
  RunEventUi,
  RuntimeSelection,
} from "@shared/types";
import { ChatStream, type StreamMessage, type StreamStep, type PipelineStage } from "@/components/ChatStream";
import { ToolApprovalInline } from "@/components/ToolApprovalInline";
import { normalizeToolCall, shadowsToolRecordedPath } from "@shared/tool-call-detail";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import { ChatQuestionSheet, type QuestionSheetAnswer } from "@/components/ChatQuestionSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import { extractQuestions } from "@/lib/ask-question";
import { stripMultimodalSetup } from "@/lib/multimodal-setup";
import { dropChatViewSnapshot, readChatViewSnapshot, saveChatViewSnapshot } from "@/lib/chat-view-cache";
import { completePromptStartIntent } from "@/lib/prompt-actions";
import { ChatInput } from "@/components/ChatInput";
import type { SurfaceStatePatchHandler, WorkbenchSurface } from "@/components/WorkbenchPanel";
import type { LiveAgent, NetTimelineItem } from "@/components/AgentNetworkPanel";
import { ChatRightPanel, RIGHT_PANEL_MIN_HEIGHT, type ChatRightPanelTab } from "@/components/ChatRightPanel";
import { ProjectFolderBar } from "@/components/ProjectFolderBar";
import {
  firstMediaArtifactInText,
  linkedFileArtifactsInText,
  type CodeArtifact,
  type LinkedFileArtifact,
  type MediaArtifact,
  localServerUrlsInText,
} from "@/components/Markdown";
import type { WorkspaceFilePreview } from "@/components/WorkspacePanel";
import { IconBuilding, IconClose, IconFolder, IconNetwork, IconPanelRight, IconSparkles, IconTrash } from "@/components/Icon";
import { INSTALLED_APPS } from "@/lib/apps";
import { visibleAgents } from "@/lib/agent-visibility";
import { isUserFacingProjectPoolMember, projectPoolMemberKey } from "@/lib/project-agent-roster";
import { pickLocalized, useT } from "@/lib/i18n";
import { surfaceApprovalRequirement, type SurfaceApprovalRequirement } from "@/lib/surface-approval";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import { hubBookmarkIdentityKey, onHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { OneSuggestionReviewHandoffBanner } from "@/components/one/OneSuggestionReviewHandoff";
import {
  appendChatFileMarker,
  chatFileItem,
  chatFilesBridge,
  parseChatFileMessage,
  type ChatFileDraft,
  type ChatFileItem,
} from "@/lib/chat-files";

function uid(): string {
  return Math.random().toString(36).slice(2);
}

function isPlaceholderTaskTitle(value: string): boolean {
  return ["", "새 채팅", "New chat", "새 작업", "New task"].includes(value.trim());
}

function taskTitleFromFirstPrompt(value: string): string {
  const condensed = value.replace(/\s+/g, " ").trim();
  return condensed.length > 36 ? `${condensed.slice(0, 34)}…` : condensed;
}

function userFacingFolderName(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function isInternalLoopStatus(value: string): boolean {
  return /stormbreaker\s+loop|루프\s*stormbreaker|scope-lock|verifier-first|agentlas\s*오케스트레이터|(?:^|\s)codex:\s|skill descriptions were shortened|sessionend hook|agentlas plugins|career graph (?:색인 갱신|refreshed):?\s*nodes=|\b(?:bash|collab_tool_call|mcp_tool_call|write|read|edit|glob|grep|websearch|webfetch)\b|\b(?:codex|claude code|antigravity|kimi|grok)\s+cli\b/i.test(value);
}

function receiptRecoveryMessage(
  receipt: InvocationRunReceipt | null,
  locale: "ko" | "en",
): StreamMessage | null {
  if (!receipt || receipt.status === "completed" || receipt.status === "running" || receipt.status === "cancelling") {
    return null;
  }
  const isFailure = receipt.status === "failed" || receipt.status === "interrupted";
  const baseText = receipt.status === "cancelled"
    ? (locale === "ko"
      ? "이전 모델 실행이 최종 답변 전에 취소되었습니다. 마지막 지시와 대화 기록은 남아 있습니다."
      : "The previous model turn was cancelled before a final response. Your last instruction and conversation are preserved.")
    : (locale === "ko"
      ? "이전 모델 실행이 최종 답변 전에 중단되었습니다. 마지막 지시와 대화 기록은 남아 있습니다."
      : "The previous model turn stopped before a final response. Your last instruction and conversation are preserved.");
  const errorCode = receipt.errorCode?.trim();
  const errorMessage = receipt.errorMessage?.trim();
  const failure = isFailure && (errorCode || errorMessage)
    ? { code: errorCode || "runtime_error", message: errorMessage || baseText }
    : undefined;
  const failureDetail = isFailure && (errorMessage || errorCode)
    ? `\n${locale === "ko" ? "실패 사유" : "Failure reason"}: ${errorMessage || (locale === "ko" ? "실행 오류" : "Runtime error")}${errorCode ? ` [${errorCode}]` : ""}`
    : "";
  const text = `${isFailure ? "⚠️ " : ""}${baseText}${failureDetail}`;
  return {
    id: `run-recovery:${receipt.runId}:${receipt.status}`,
    role: "system",
    text,
    ...(failure ? { failure } : {}),
  };
}

function receiptRecoveryStatus(receipt: InvocationRunReceipt | null, locale: "ko" | "en"): string {
  if (!receipt) return locale === "ko" ? "종료됨" : "Ended";
  if (receipt.status === "completed") return locale === "ko" ? "완료" : "Completed";
  if (receipt.status === "cancelled") return locale === "ko" ? "취소됨" : "Cancelled";
  if (receipt.status === "interrupted") return locale === "ko" ? "중단됨" : "Interrupted";
  if (receipt.status === "failed") return locale === "ko" ? "중단됨" : "Stopped";
  return receipt.status === "cancelling"
    ? (locale === "ko" ? "종료 확인 중" : "Stopping")
    : (locale === "ko" ? "실행 중" : "Running");
}

// 렌더마다 [...messages].reverse()로 전체 배열을 복사하지 않도록 뒤에서부터 찾는다.
function lastMessageOfRole(
  messages: StreamMessage[],
  role: StreamMessage["role"],
): StreamMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return messages[i];
  }
  return undefined;
}

function workspacePreviewFromMedia(media: MediaArtifact): WorkspaceFilePreview {
  const openTargets = uniqueStrings([media.path, ...(media.paths ?? []), media.src]);
  return {
    path: media.path || media.paths?.[0] || media.src,
    name: media.name,
    size: 0,
    viewerKind: media.kind,
    fileUrl: media.src,
    openTargets,
    content: "",
    truncated: false,
    reason: "binary",
  };
}

function workspacePreviewFromImageUrl(url: string, index: number): WorkspaceFilePreview {
  return {
    path: url,
    name: `generated-image-${index + 1}.png`,
    size: 0,
    viewerKind: "image",
    fileUrl: url,
    openTargets: [url],
    content: "",
    truncated: false,
    reason: "binary",
  };
}

/**
 * 도구 호출이 실제로 건드린 파일 경로.
 *
 * 판별은 공용 `normalizeToolCall` 한 곳에서만 한다 — 여기서 도구 이름을 다시 보고
 * 추측하면 claude-code/codex/gemini/MCP 마다 결과가 갈라진다(옛 `toolView` 가 정확히
 * 그렇게 무너졌다). 읽은 파일도 포함한다: 사람이 "그 파일 좀 보자"고 할 대상은
 * 우리가 만든 것만이 아니다.
 */
/**
 * 실행 기록에서 "지금 돌고 있는 로컬 서버" 주소를 찾는다.
 *
 * 예전에는 답변 본문만 훑었다. 그래서 모델이 "서버를 띄웠습니다"라고만 하고 주소를 적지
 * 않으면 — 주소는 `Serving HTTP on 127.0.0.1 port 8932` 처럼 도구 결과에만 있었다 —
 * 우측 레일이 아예 열리지 않았고, 화면에는 떠 있는 컴퓨터-화면 카드의 "화면 연결 대기 중"만
 * 남았다(2026-09-03 실측: 레일 탭 null, 라이브뷰 호출 0회).
 * 파일 경로는 이미 도구 기록에서 모으고 있었다 — 주소도 같은 자리에서 모은다.
 */
function normalizeLocalServerUrl(url: string): string {
  // 같은 서버가 본문에는 `…:8932`, 도구 결과에는 `…:8932/` 로 적힌다. 그대로 두면 프리뷰
  // 정체가 바뀐 것으로 보여 네이티브 뷰가 닫혔다 다시 열린다(화면이 한 번 깜빡인다).
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function localServerUrlsFromSteps(steps: StreamStep[] | undefined): string[] {
  if (!steps || steps.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    for (const text of [step.result, step.args]) {
      if (!text) continue;
      for (const raw of localServerUrlsInText(text)) {
        const url = normalizeLocalServerUrl(raw);
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}

function toolFilePathsFromSteps(
  steps: StreamStep[] | undefined,
  options: { includeReads?: boolean } = {},
): string[] {
  if (!steps || steps.length === 0) return [];
  const includeReads = options.includeReads !== false;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "tool" || !step.tool) continue;
    let detail: ReturnType<typeof normalizeToolCall>;
    try {
      detail = normalizeToolCall({ name: step.tool, args: step.args, result: step.result });
    } catch {
      continue;
    }
    if (detail.type === "read" && !includeReads) continue;
    if (detail.type !== "read" && detail.type !== "write" && detail.type !== "edit") continue;
    const filePath = detail.filePath;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    out.push(filePath);
  }
  return out;
}

/** 도구가 준 경로 하나를 링크 파일 산출물로. 경로는 이미 구체적이라 추론이 필요 없다. */
function linkedFileArtifactFromPath(filePath: string): LinkedFileArtifact {
  return {
    id: `tool-file:${filePath}`,
    name: basename(filePath),
    href: filePath,
    path: filePath,
    paths: [filePath],
    fileUrl: fileUrlForToolPath(filePath),
  };
}

function fileUrlForToolPath(filePath: string): string {
  // 인앱 바이너리 뷰어는 webSecurity를 우회하지 않고 Main이 승인한 바이트만 받는다.
  if (/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|mp3|mpeg|m4a|wav|ogg|oga|opus|flac|aac|weba|mid|midi|pdf|docx?|docm|dotx?|rtf|odt|pages|hwp|hwpx|pptx?|pptm|potx?|ppsx|odp|key|xlsx?|xlsm|xlsb|xltx?|csv|tsv|ods|numbers|zip)$/i.test(filePath)) {
    return `agentlas://localfile/?p=${encodeURIComponent(filePath)}`;
  }
  const normalized = filePath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function versionedPreviewUrl(source: string, revision: number): string {
  if (!/^agentlas:\/\//i.test(source)) return source;
  try {
    const url = new URL(source);
    url.searchParams.set("v", String(revision));
    return url.toString();
  } catch {
    return source;
  }
}

/**
 * 지금 돌고 있는 로컬 서버를 볼 수 있는 산출물로.
 *
 * 파일이 아니라 실행 중인 것이므로 읽을 내용이 없다 — 뷰어는 주소를 직접 연다.
 * 로컬 호스트로 한정하는 이유는 `localServerUrlsInText` 에 적어 두었다.
 */
function workspacePreviewFromLocalServer(url: string): WorkspaceFilePreview {
  let label = url;
  try {
    const parsed = new URL(url);
    label = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    // 라벨은 표시용일 뿐이라 원문으로 둔다.
  }
  return {
    path: url,
    name: label,
    size: 0,
    viewerKind: "browser",
    fileUrl: url,
    browserUrl: url,
    openTargets: [url],
    content: "",
    truncated: false,
    reason: "binary",
  };
}

/** External links from a rendered surface stay in the same app rail too. */
function workspacePreviewFromBrowserUrl(url: string): WorkspaceFilePreview | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return {
      path: url,
      name: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
      size: 0,
      viewerKind: "browser",
      fileUrl: url,
      browserUrl: url,
      openTargets: [url],
      content: "",
      truncated: false,
      reason: "binary",
    };
  } catch {
    return null;
  }
}

function workspacePreviewFromLocalFile(path: string): WorkspaceFilePreview {
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "index.html";
  const fileUrl = fileUrlForToolPath(path);
  return {
    path,
    name,
    size: 0,
    viewerKind: "browser",
    fileUrl,
    browserUrl: fileUrl,
    openTargets: [path, fileUrl],
    content: "",
    truncated: false,
    reason: "binary",
  };
}

function workspacePreviewFromLinkedFile(file: LinkedFileArtifact): WorkspaceFilePreview {
  const path = file.path || file.paths?.[0] || file.href;
  const isRemoteUrl = /^https?:\/\//i.test(path);
  const viewerKind = isRemoteUrl ? "browser" : viewerKindFromName(file.name || path);
  return {
    path,
    name: file.name || basename(path),
    size: 0,
    viewerKind,
    fileUrl: isAbsoluteLocalPath(path) ? fileUrlForToolPath(path) : file.fileUrl,
    browserUrl: viewerKind === "browser" ? file.fileUrl : undefined,
    openTargets: uniqueStrings([file.path, ...(file.paths ?? []), file.href, file.fileUrl]),
    content: "",
    truncated: false,
    reason: "binary",
  };
}

function viewerKindFromName(name: string): WorkspaceFilePreview["viewerKind"] {
  const ext = extensionOf(name);
  if ([".md", ".mdx"].includes(ext)) return "markdown";
  if ([".json", ".jsonl"].includes(ext)) return "json";
  // A static HTML artifact is source code when it comes from the chat/file
  // list. Generated/live web surfaces use workspacePreviewFromLocalFile or a
  // local-server URL and remain explicit Browser viewers.
  if ([".html", ".htm"].includes(ext)) return "text";
  if ([".url", ".webloc"].includes(ext)) return "browser";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(ext)) return "video";
  if ([".mp3", ".mpeg", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac", ".weba", ".mid", ".midi"].includes(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if ([".ppt", ".pptx", ".pptm", ".pot", ".potx", ".ppsx", ".odp", ".key"].includes(ext)) return "presentation";
  if ([".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".csv", ".tsv", ".ods", ".numbers"].includes(ext)) return "spreadsheet";
  if (ext === ".zip") return "archive";
  if ([".doc", ".docx", ".docm", ".dot", ".dotx", ".rtf", ".odt", ".pages", ".hwp", ".hwpx"].includes(ext)) return "document";
  return "text";
}

function extensionOf(name: string): string {
  const base = basename(name).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return p;
  return p.slice(i + 1) || p;
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function parentFolder(absPath: string | null): string | null {
  if (!absPath) return null;
  const clean = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return clean.slice(0, idx);
}

function mediaBasePathCandidates(...paths: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const value = raw?.trim();
    if (!value) continue;
    for (const candidate of [value, parentFolder(value)]) {
      if (candidate && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

function scaffoldResultFromRecord(record: AppFactoryAppRecord): AppFactoryScaffoldResult {
  return { ...record.scaffold, record };
}

function toolResultFromRecord(record: ToolFactoryToolRecord): ToolFactoryScaffoldResult {
  return { ...record.scaffold, record };
}

function surfaceToolKey(surfaceId: string, action: AgentlasSurfaceAction): string {
  return `${surfaceId}:${typeof action.toolId === "string" ? action.toolId : action.id}`;
}

async function ensureSurfaceApproval(
  api: NonNullable<ReturnType<typeof ipc>>,
  surfaceId: string,
  action: AgentlasSurfaceAction,
  approval: SurfaceApprovalRequirement,
  locale: "ko" | "en",
): Promise<boolean> {
  if (approval.persist) {
    try {
      if (await api.surfaces.hasApproval({ surfaceId, scopeKey: approval.scopeKey })) return true;
    } catch {
      // Continue to explicit confirmation if the ledger is temporarily unavailable.
    }
  }
  /* ★오너 이사회 결정(2026-08-10): 사람이 기계적으로 누르기만 하는 확인은 없앤다.
     AI 가 끝까지 리드하고, 결정은 **원장에 기록**으로 남는다(묻지 않을 뿐 감사는 유지).
     단 하나 남긴 것: **실제 돈이 나가는 결제.** 그건 되돌릴 수 없고 법적 책임이 따르므로
     "기계적으로 누르는 관문"의 범주가 아니다. */
  if (approval.kind === "payment") {
    const ok = window.confirm(approval.message);
    if (!ok) return false;
  }
  try {
    await api.surfaces.approve({
      surfaceId,
      actionId: action.id,
      actionType: action.type,
      kind: approval.kind,
      scopeKey: approval.scopeKey,
      title: approval.title,
      summary: approval.summary,
      metadata: approval.metadata,
    });
  } catch {
    window.alert(locale === "ko" ? "승인을 적용하지 못했습니다." : "The approval was not applied.");
    return false;
  }
  return true;
}

// 우측 패널 열림/탭 선호값 — legacy 키는 읽은 뒤 단일 키로 이관한다.
const WORKSPACE_OPEN_KEY = "agentlas.workspace.open";
const NETWORK_OPEN_KEY = "agentlas.network.open";
const RIGHT_PANEL_STATE_KEY = "agentlas.chat.right_panel";
const RIGHT_PANEL_WIDTH_KEY = "agentlas.chat.right_panel_width";
// Agentlas rich output contract: ordinary inspector tabs may stay compact, but
// a rendered result opens as the wide right-hand workspace from the reference.
const RIGHT_PANEL_DEFAULT_WIDTH = 392;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 1280;
/**
 * 이 폭 이하에서는 결과 레일이 채팅 옆에 서지 않고 위를 덮는다.
 * 값은 globals.css 의 `.chat-right-panel` 오버레이 media query 와 같아야 한다 —
 * 어긋나면 CSS 는 덮는데 JS 는 자리를 비워두거나 그 반대가 된다.
 * scripts/qa-work-responsive-rail.cjs 가 두 값을 대조한다.
 *
 * 앱 창 자체의 최소 폭은 960px 이라(electron/main.ts) 이 경계는 임베드/작은 창 전용이다.
 */
const RIGHT_PANEL_OVERLAY_MAX_VIEWPORT = 760;
/**
 * 레일이 옆에 설 때 비워 둬야 하는 폭 = 셸 사이드바(.project-sidebar 274px 고정)
 * + 채팅이 읽히는 최소 폭.
 *
 * 예전에는 사이드바를 세지 않은 520 이었다. 그래서 최소 창(960px)에서 레일이 415px 까지
 * 자라 채팅이 271px 로 눌렸다(2026-09-03 실측: 작성창 215px, 한 문장이 3줄).
 */
const CHAT_COLUMN_RESERVED_WIDTH = 274 + RIGHT_PANEL_MIN_WIDTH;
const RIGHT_PANEL_RESULT_RATIO = 0.432;
/** 좌측 사이드바 실측 폭 — 대화 열을 계산할 때 먼저 빼 둔다. */
const CHAT_SIDEBAR_WIDTH = 274;
/** 한국어 본문이 한 줄에 충분히 들어가는 최소 대화 열 폭(실측 기준). */
const MIN_READABLE_CHAT_COLUMN = 520;
// 세로 높이는 폭과 달리 기본이 '전체'다 — null 이면 키를 지워 창 크기를 그대로 따라간다.
const RIGHT_PANEL_HEIGHT_KEY = "agentlas.chat.right_panel_height";

/** picker 모델 옵션 — runtime.listModels가 실시간 조회해 채워준다. */
type ModelOption = { id: string; label: string; tag?: string };
type PermissionLevel = "read" | "write" | "full";

const DEFAULT_PERMISSION: PermissionLevel = "full";

type RightPanelPreference = { open: boolean; tab: ChatRightPanelTab };

function isRightPanelTab(raw: unknown): raw is ChatRightPanelTab {
  return raw === "file" || raw === "agent" || raw === "panel" || raw === "memory";
}

function readRightPanelPreference(): RightPanelPreference | null {
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { open?: unknown; tab?: unknown };
      if (typeof parsed.open === "boolean" && isRightPanelTab(parsed.tab)) {
        return { open: parsed.open, tab: parsed.tab };
      }
    }
  } catch {
    // ignore malformed or unavailable storage
  }
  try {
    const workspace = window.localStorage.getItem(WORKSPACE_OPEN_KEY);
    const network = window.localStorage.getItem(NETWORK_OPEN_KEY);
    if (network === "1") return { open: true, tab: "agent" };
    if (workspace === "1") return { open: true, tab: "file" };
    if (workspace !== null || network !== null) return { open: false, tab: "agent" };
  } catch {
    // ignore
  }
  return null;
}

function writeRightPanelPreference(open: boolean, tab: ChatRightPanelTab) {
  try {
    window.localStorage.setItem(RIGHT_PANEL_STATE_KEY, JSON.stringify({ open, tab }));
    window.localStorage.removeItem(WORKSPACE_OPEN_KEY);
    window.localStorage.removeItem(NETWORK_OPEN_KEY);
  } catch {
    // sandbox/private mode — 영속화 생략
  }
}

function clampRightPanelWidth(width: number): number {
  const viewportMax = typeof window === "undefined"
    ? RIGHT_PANEL_MAX_WIDTH
    : window.innerWidth <= RIGHT_PANEL_OVERLAY_MAX_VIEWPORT
      ? Math.max(RIGHT_PANEL_MIN_WIDTH, window.innerWidth - 40)
      /*
       * ★남는 자리는 대화 몫부터 뗀다(2026-09-04 실측).
       *
       * 예전 식(innerWidth - 274 - 레일최소)은 **레일이 최소 320 을 받도록** 남겨 두고
       * 나머지를 대화에 줬다. 그래서 1024px 창에서 레일 430 · 작성창 288 이 됐다 —
       * 같은 폭에서 One 은 작성창 720 을 지킨다(레일이 224 로 줄어든다).
       * 이제 대화가 읽을 수 있는 폭을 먼저 떼고, 그러고도 레일이 자기 최소보다 작아지면
       * 레일 최소가 이긴다(둘 다는 못 지키는 폭에서의 마지막 방어선).
       */
      : Math.max(RIGHT_PANEL_MIN_WIDTH, window.innerWidth - CHAT_SIDEBAR_WIDTH - MIN_READABLE_CHAT_COLUMN);
  return Math.min(RIGHT_PANEL_MAX_WIDTH, viewportMax, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

function preferredRichResultWidth(): number {
  if (typeof window === "undefined") return 720;
  // 좁은 폭 분기는 clampRightPanelWidth 와 같은 경계를 써야 한다 — 예전에는 760 이 세 군데
  // 흩어져 있어 한 곳만 고치면 반쪽만 착지했다.
  const requested = window.innerWidth <= RIGHT_PANEL_OVERLAY_MAX_VIEWPORT
    ? Math.round(window.innerWidth * 0.86)
    /*
     * ★결과가 커도 대화가 읽을 수 있어야 한다(2026-09-04 실측).
     *
     * 비율(0.432)만 보고 넓히면 1240px 창에서 레일 536 · 작성창 398 이 됐다. 한국어 본문이
     * 한 줄에 서른 자쯤에서 꺾이는 폭이다(같은 창에서 One 은 720). 그래서 비율은 그대로 두되
     * **대화 열의 최소 폭을 먼저 떼어 놓고** 남는 만큼만 결과에 준다. 큰 화면에서는 예전처럼
     * 비율이 이기고, 좁은 화면에서만 이 상한이 걸린다.
     */
    : Math.min(
        Math.round(window.innerWidth * RIGHT_PANEL_RESULT_RATIO),
        window.innerWidth - CHAT_SIDEBAR_WIDTH - MIN_READABLE_CHAT_COLUMN,
      );
  return clampRightPanelWidth(requested);
}

function readRightPanelHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_HEIGHT_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= RIGHT_PANEL_MIN_HEIGHT ? value : null;
  } catch {
    return null;
  }
}

function writeRightPanelHeight(height: number | null) {
  try {
    if (height === null) window.localStorage.removeItem(RIGHT_PANEL_HEIGHT_KEY);
    else window.localStorage.setItem(RIGHT_PANEL_HEIGHT_KEY, String(height));
  } catch {
    // ignore
  }
}

function readRightPanelWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    // 360 was the pre-parity default. Existing installs persisted it even when
    // the user never resized, so migrate that sentinel to the measured width.
    if (raw === 360) return RIGHT_PANEL_DEFAULT_WIDTH;
    if (Number.isFinite(raw) && raw > 0) return clampRightPanelWidth(raw);
  } catch {
    // ignore
  }
  // 기본값도 창에 맞춘다. 예전에는 저장된 값만 clamp 해서, 한 번도 크기를 바꾸지 않은
  // 사용자는 좁은 창에서도 392px 레일을 그대로 받았다.
  return clampRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH);
}

function writeRightPanelWidth(width: number) {
  try {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(width));
  } catch {
    // ignore
  }
}

function parsePermission(raw: string | null): PermissionLevel | undefined {
  return raw === "read" || raw === "write" || raw === "full" ? raw : undefined;
}

function inferPermissionFromAnswer(answers: string[]): PermissionLevel | undefined {
  const joined = answers.join(" ").toLowerCase();
  if (/\bwrite\b|쓰기|편집/.test(joined)) return "write";
  if (/\bread\b|읽기만/.test(joined)) return "read";
  return undefined;
}

function confirmFullPermissionFromUrl(locale: string): boolean {
  return window.confirm(
    locale === "ko"
      ? "이 링크가 전체 권한 실행을 요청합니다.\n\n파일 변경, 셸 명령, 외부 도구 호출까지 허용될 수 있습니다. 계속할까요?"
      : "This link requests full-permission execution.\n\nIt may allow file changes, shell commands, and external tool calls. Continue?",
  );
}

function appendTimeline(
  setNetTimeline: Dispatch<SetStateAction<NetTimelineItem[]>>,
  item: NetTimelineItem,
) {
  setNetTimeline((tl) => [...tl, item].slice(-80));
}

const DURABLE_WORKFLOW_EVENT_RE =
  /^(?:task_force_model_call_(?:started|completed|failed)|workload_allocation|workforce_planner_(?:schema_attempt|blocked)|workflow_node_state|invoke_(?:result|completed|failed|cancelled|interrupted))$/;

function durableWorkflowLabel(event: RunEventUi, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  const processState = typeof event.payload.agentProcessState === "string"
    ? event.payload.agentProcessState
    : "";
  if (processState === "closed") return ko ? "CLI 프로세스 닫힘" : "CLI process closed";
  if (processState === "failed") return ko ? "CLI 프로세스 실패" : "CLI process failed";
  if (processState === "idle") return ko ? "CLI 프로세스 대기 중" : "CLI process idle";
  if (processState === "running") return ko ? "CLI 프로세스 실행 중" : "CLI process running";
  const status = typeof event.payload.status === "string" ? event.payload.status.trim() : "";
  const state = typeof event.payload.state === "string" ? event.payload.state.trim() : "";
  if (status) return status;
  if (state) return state;
  const labels: Record<string, [string, string]> = {
    task_force_model_call_started: ["모델 호출 시작", "Model call started"],
    task_force_model_call_completed: ["모델 호출 완료", "Model call completed"],
    task_force_model_call_failed: ["모델 호출 실패", "Model call failed"],
    workload_allocation: ["작업 배분 기록", "Workload allocation recorded"],
    workforce_planner_schema_attempt: ["워크포스 계획 검증", "Workforce plan validation"],
    workforce_planner_blocked: ["워크포스 계획 차단", "Workforce planning blocked"],
    workflow_node_state: ["워크플로 노드 상태 기록", "Workflow node state recorded"],
    invoke_result: ["실행 결과 기록", "Run result recorded"],
    invoke_completed: ["실행 완료", "Run completed"],
    invoke_failed: ["실행 실패", "Run failed"],
    invoke_cancelled: ["실행 취소", "Run cancelled"],
    invoke_interrupted: ["실행 중단", "Run interrupted"],
  };
  const label = labels[event.kind];
  return label ? label[ko ? 0 : 1] : event.kind;
}

function workflowSnapshotFromLedger(
  events: RunEventUi[],
  locale: "ko" | "en",
): { liveAgents: Record<string, LiveAgent>; timeline: NetTimelineItem[] } {
  const liveAgents: Record<string, LiveAgent> = {};
  const timeline: NetTimelineItem[] = [];
  for (const event of events) {
    const processState = typeof event.payload.agentProcessState === "string"
      ? event.payload.agentProcessState as AgentProcessState
      : undefined;
    const messageText = typeof event.payload.agentMessageText === "string"
      ? event.payload.agentMessageText.trim()
      : "";
    const isDurableMcpAgentEvent = event.kind.startsWith("mcp_") && Boolean(
      event.agentId || event.nodeId || processState || messageText,
    );
    if (!DURABLE_WORKFLOW_EVENT_RE.test(event.kind) && !isDurableMcpAgentEvent) continue;
    const agentId = event.nodeId || event.agentId || (typeof event.payload.agentMessageFrom === "string" ? event.payload.agentMessageFrom : "");
    if (!agentId) continue;
    const role =
      typeof event.payload.role === "string"
        ? event.payload.role
        : typeof event.payload.phase === "string"
        ? event.payload.phase
        : typeof event.payload.modelRole === "string"
          ? event.payload.modelRole
          : "";
    const model = typeof event.payload.model === "string" ? event.payload.model : undefined;
    const tokensValue = Number(event.payload.tokens);
    const tokens = Number.isFinite(tokensValue) && tokensValue > 0 ? tokensValue : undefined;
    const direction = event.payload.agentMessageDirection === "orchestrator-to-worker" || event.payload.agentMessageDirection === "worker-to-orchestrator"
      ? event.payload.agentMessageDirection as AgentMessageDirection
      : undefined;
    const text = messageText || durableWorkflowLabel(event, locale);
    liveAgents[agentId] = {
      ...(liveAgents[agentId] ?? {}),
      name: typeof event.payload.agentName === "string" ? event.payload.agentName : event.agentId || event.nodeId || agentId,
      role,
      active: processState === "running",
      status: text,
      model,
      ...(processState ? { processState } : {}),
      ...(typeof event.payload.agentProcessRuntime === "string" ? { processRuntime: event.payload.agentProcessRuntime } : {}),
    };
    timeline.push({
      key: `ledger:${event.id}`,
      agentId,
      name: typeof event.payload.agentName === "string" ? event.payload.agentName : event.agentId || event.nodeId || agentId,
      role,
      kind: messageText
        ? "message"
        : event.kind === "workload_allocation" ? "tool" : "status",
      text,
      tokens,
      ...(direction ? { messageDirection: direction } : {}),
      ...(typeof event.payload.agentMessageFrom === "string" ? { messageFrom: event.payload.agentMessageFrom } : {}),
      ...(typeof event.payload.agentMessageTo === "string" ? { messageTo: event.payload.agentMessageTo } : {}),
    });
  }
  return { liveAgents, timeline: timeline.slice(-80) };
}

type ToolEvent = NonNullable<McpInvocationEvent["tool"]>;

function computerUseModeForTool(toolName: string): "browser" | "computer" | null {
  const name = toolName.toLowerCase();
  if (name.includes("browser_")) return "browser";
  if (
    name.includes("computer-use") ||
    name.includes("cua-driver") ||
    /(?:^|__)(?:get_app_state|list_apps|click|drag|scroll|type_text|press_key|set_value|select_text)$/u.test(name)
  ) return "computer";
  return null;
}

function announceComputerUseActivity(mode: "browser" | "computer" | null, phase: "active" | "finished"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agentlas:computer-use-activity", {
    detail: mode ? { mode, phase } : { phase },
  }));
}

function toolStepFromEvent(tool: ToolEvent, meta?: Partial<StreamStep>): StreamStep {
  return {
    id: uid(),
    kind: "tool",
    text: tool.name,
    tool: tool.name,
    args: tool.args,
    toolUseId: tool.id,
    result: tool.result,
    resultIsError: tool.isError,
    activity: "tool",
    createdAt: Date.now(),
    ...meta,
  };
}

function mergeToolStep(steps: StreamStep[], tool: ToolEvent, meta?: Partial<StreamStep>): StreamStep[] {
  const result = tool.result;
  const hasResult = result != null;
  if (!hasResult) return [...steps, toolStepFromEvent(tool, meta)];

  let match = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (!s.tool) continue;
    if (tool.id && s.toolUseId === tool.id) {
      match = i;
      break;
    }
    if (!tool.id && s.tool === tool.name && s.result == null) {
      match = i;
      break;
    }
  }
  if (match < 0) return [...steps, toolStepFromEvent(tool, meta)];

  return steps.map((s, i) =>
    i === match
      ? {
          ...s,
          ...meta,
          args: s.args ?? tool.args,
          toolUseId: s.toolUseId ?? tool.id,
          result,
          resultIsError: tool.isError,
          activity: meta?.activity ?? s.activity ?? "tool",
          // 인터리브 분할 앵커는 호출 시점 값이 진실 — 결과 병합이 뒤늦은 앵커로 덮지 않는다.
          anchorTextLen: s.anchorTextLen ?? meta?.anchorTextLen,
          createdAt: Date.now(),
        }
      : s,
  );
}

function toolWorkflowText(tool: ToolEvent, locale: "ko" | "en"): string {
  if (tool.result != null) {
    if (tool.isError) return locale === "ko" ? `오류 · ${tool.name}` : `Error · ${tool.name}`;
    return locale === "ko" ? `결과 · ${tool.name}` : `Result · ${tool.name}`;
  }
  return tool.name;
}

function activityForEvent(ev: McpInvocationEvent): StreamStep["activity"] {
  if (ev.delegateTo && ev.delegateTo.length > 0) return "handoff";
  if (ev.phase === "delegate") return "start";
  if (ev.phase === "synthesize") return "complete";
  if (ev.kind === "tool-use") return "tool";
  return "status";
}

// 라이브 이벤트의 에이전트를 파이프라인 단계에 best-effort 로 매칭해 단계 상태를 monotonic 하게 전진.
// 매칭 안 되면 그대로 둔다(가짜 진행 금지) — 매칭될 때만 단계가 켜진다.
function advancePipeline(stages: PipelineStage[] | undefined, ev: McpInvocationEvent): PipelineStage[] | undefined {
  if (!stages || !stages.length) return stages;
  const key = (ev.agentName ?? ev.agentId ?? "").toLowerCase().trim();
  if (!key) return stages;
  const idx = stages.findIndex((s) => {
    const a = (s.agentName ?? "").toLowerCase();
    const b = (s.agentId ?? "").toLowerCase();
    return (a && (key.includes(a) || a.includes(key))) || (b && (key.includes(b) || b.includes(key)));
  });
  if (idx < 0) return stages;
  // 이미 진행된 최대 단계 — 역행 금지(단계는 순서대로 실행).
  const progressed = stages.reduce(
    (mx, s, i) => (s.status === "running" || s.status === "done" ? Math.max(mx, i) : mx),
    -1,
  );
  const target = Math.max(idx, progressed);
  return stages.map((s, i) => (i < target ? { ...s, status: "done" } : i === target ? { ...s, status: "running" } : s));
}

function completePipeline(stages: PipelineStage[] | undefined): PipelineStage[] | undefined {
  if (!stages || !stages.length) return stages;
  return stages.map((s) => ({ ...s, status: "done" as const }));
}

function historyEntryToStreamMessage(entry: { id: string; role: string; text: string; imageDataUrls?: string[] }): StreamMessage {
  const parsedFiles = parseChatFileMessage(entry.text);
  const role: StreamMessage["role"] =
    entry.role === "assistant" ? "agent" : entry.role === "user" ? "user" : "system";
  if (role !== "agent") {
    return { id: entry.id, role, text: parsedFiles.visibleText, imageDataUrls: entry.imageDataUrls, chatFileGroupIds: parsedFiles.groupIds };
  }
  const parsed = extractQuestions(parsedFiles.visibleText, entry.id);
  const setup = stripMultimodalSetup(parsed.text);
  return {
    id: entry.id,
    role,
    text: setup.text,
    imageDataUrls: entry.imageDataUrls,
    chatFileGroupIds: parsedFiles.groupIds,
    questions: parsed.questions.length > 0 ? parsed.questions : undefined,
    questionSourceMessageId: parsed.questions.length > 0 ? entry.id : undefined,
    needsMultimodalSetup: setup.needsSetup || undefined,
  };
}

/**
 * A live final can be painted a few milliseconds before a follow-up history
 * read observes the same durable row. Replacing the whole transcript with that
 * older snapshot made the answer visibly appear and then disappear. Preserve
 * only freshly settled live messages that the durable snapshot does not yet
 * contain; the next reconciliation naturally deduplicates them by role+text.
 */
function reconcileTranscriptSnapshot(
  current: StreamMessage[],
  durable: StreamMessage[],
  recovery?: StreamMessage | null,
  optimisticIds: ReadonlySet<string> = new Set<string>(),
): StreamMessage[] {
  if (current.some((message) => message.busy || message.streaming)) return current;
  const signature = (message: StreamMessage) => `${message.role}\u0000${message.text.trim()}`;
  // History rows intentionally store only the assistant text. Preserve the
  // rich tool steps and host notices that arrived live when a terminal
  // reconciliation races the history read; otherwise the MCP card or a
  // runtime-fallback disclosure flashes and disappears as soon as the run
  // finishes.
  const richBySignature = new Map<string, StreamMessage>();
  for (const message of current) {
    const hasRichSteps = message.steps?.some((step) => step.tool && step.result) === true;
    const hasNotices = (message.notices?.length ?? 0) > 0;
    if (message.role !== "agent" || (!hasRichSteps && !hasNotices)) continue;
    richBySignature.set(signature(message), message);
  }
  const durableWithRichSteps = durable.map((message) => {
    const live = richBySignature.get(signature(message));
    return live
      ? {
          ...message,
          ...(live.steps?.length ? { steps: live.steps } : {}),
          ...(live.notices?.length ? { notices: live.notices } : {}),
          ...(live.finishedAt != null ? { finishedAt: live.finishedAt } : {}),
          ...(live.tokens != null ? { tokens: live.tokens } : {}),
        }
      : message;
  });
  const durableIndexById = new Map(durableWithRichSteps.map((message, index) => [message.id, index]));
  // Anchor at the newest row both snapshots genuinely share. Comparing every
  // historical signature would suppress a new answer when it happens to have
  // the same text as an older answer in the session.
  let currentAnchor = -1;
  let durableAnchor = -1;
  current.forEach((message, index) => {
    const durableIndex = durableIndexById.get(message.id);
    if (durableIndex == null || durableIndex < durableAnchor) return;
    currentAnchor = index;
    durableAnchor = durableIndex;
  });
  const durableTailSignatures = new Set(durableWithRichSteps.slice(durableAnchor + 1).map(signature));
  const currentTail = current.slice(currentAnchor + 1);
  const pendingDirections = currentTail.filter((message) => optimisticIds.has(message.id));
  const freshlySettled = currentTail.filter((message) => (
    message.finishedAt != null
    && !message.busy
    && !message.streaming
    && message.text.trim().length > 0
    && !durableTailSignatures.has(signature(message))
  ));
  const tail = [...freshlySettled, ...pendingDirections].filter((message, index, rows) => (
    rows.findIndex((candidate) => candidate.id === message.id) === index
  ));
  const next = [...durableWithRichSteps, ...tail];
  if (recovery && !new Set(next.map(signature)).has(signature(recovery))) next.push(recovery);
  return next;
}

/**
 * 초기 이력 재수화처럼 "durable snapshot"으로 통째로 교체해야 하는 경로에서도
 * 라이브 스트림이 이미 받은 도구 산출물은 보존한다. Main의 답변 본문은 DB에 먼저
 * 저장되지만 tool step은 별도 원장에 있어 두 읽기가 잠깐 어긋날 수 있다. 이때
 * 본문만 같은 완료 답변으로 바꾸면 파일/차트 링크가 사라져 사용자는 산출물을 잃은
 * 것처럼 보게 된다. ID는 재수화 때 달라질 수 있으므로 role+trimmed text 서명을 쓴다.
 */
function preserveRichStepsBySignature(
  current: StreamMessage[],
  durable: StreamMessage[],
): StreamMessage[] {
  if (!Array.isArray(current) || !Array.isArray(durable)) return durable;
  const signature = (message: StreamMessage) => `${message.role}\u0000${typeof message.text === "string" ? message.text.trim() : ""}`;
  const richBySignature = new Map<string, StreamMessage>();
  for (const message of current) {
    const steps = Array.isArray(message.steps) ? message.steps : [];
    const hasRichSteps = steps.some((step) => (step.tool && step.result) || step.reasoning === true);
    const hasNotices = (message.notices?.length ?? 0) > 0;
    if (message.role !== "agent" || (!hasRichSteps && !hasNotices)) continue;
    richBySignature.set(signature(message), message);
  }
  return durable.map((message) => {
    const live = richBySignature.get(signature(message));
    return live
      ? {
          ...message,
          ...(live.steps?.length ? { steps: live.steps } : {}),
          ...(live.notices?.length ? { notices: live.notices } : {}),
          ...(live.finishedAt != null ? { finishedAt: live.finishedAt } : {}),
          ...(live.tokens != null ? { tokens: live.tokens } : {}),
        }
      : message;
  });
}

/** Convert redacted durable tool-use rows back into chat steps after reload. */
/**
 * 상태줄에 붙일 단계는 최근 것만 있으면 되지만, 재진입 복원은 다르다 — 여기서 자른 만큼
 * 결과 탭의 산출물이 사라진다. 도구를 33번 넘게 쓴 실행을 다시 열면 앞쪽 산출물이
 * 통째로 없어졌다(2026-09-03 실측: 40개 중 32개만 남고 step-01~08 소실).
 */
function mcpStepsFromLedger(events: RunEventUi[], limit = 32): StreamStep[] {
  const steps: StreamStep[] = [];
  const byToolId = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "mcp_reasoning" && event.payload?.reasoningPhase === "end") {
      const text = reasoningSummary(
        typeof event.payload.reasoningText === "string" ? event.payload.reasoningText : undefined,
      );
      if (text) {
        const createdAt = Date.parse(event.ts);
        steps.push({
          id: `ledger-reasoning:${event.id}`,
          kind: "thinking",
          text,
          reasoning: true,
          activity: "status",
          ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        });
      }
      continue;
    }
    if (event.kind !== "mcp_tool-use") continue;
    const payload = event.payload ?? {};
    const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
    if (!toolName) continue;
    const toolId = typeof payload.toolId === "string" ? payload.toolId : undefined;
    const result = typeof payload.toolResultPreview === "string" ? payload.toolResultPreview : undefined;
    const args = typeof payload.toolArgs === "string" ? payload.toolArgs : undefined;
    const existingIndex = toolId ? byToolId.get(toolId) : undefined;
    const createdAt = Date.parse(event.ts);
    const base: StreamStep = {
      id: `ledger-tool:${event.id}`,
      kind: "tool",
      text: toolName,
      tool: toolName,
      ...(args ? { args } : {}),
      ...(toolId ? { toolUseId: toolId } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(payload.toolIsError === true ? { resultIsError: true } : {}),
      ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
      ...(typeof payload.role === "string" ? { role: payload.role } : {}),
      activity: "tool",
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    };
    if (existingIndex == null) {
      if (toolId) byToolId.set(toolId, steps.length);
      steps.push(base);
    } else {
      steps[existingIndex] = {
        ...steps[existingIndex],
        ...(args ? { args } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(payload.toolIsError === true ? { resultIsError: true } : {}),
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      };
    }
  }
  return limit > 0 ? steps.slice(-limit) : steps;
}

/**
 * 재진입 복원 — 지난 실행의 도구 기록을 각자 제자리로 돌려놓는다.
 *
 * 대화 메시지에는 본문만 저장된다(도구 기록 칸이 없다). 그래서 다시 열 때 실행 원장에서
 * 되살리지 않으면, 파일 이름을 답변 글에 적지 않은 산출물은 결과 탭에서 통째로 사라진다.
 * 예전에는 "마지막 실행 하나"만 되살려 마지막 답변에 붙였다 — 두 번 실행한 대화를 다시
 * 열면 첫 실행에서 만든 파일이 없어졌다(2026-09-03 실측: 산출물 2개 중 1개만 남음).
 * One 은 이미 같은 원장(runLedger.chatTimeline)으로 지난 턴을 되살린다.
 */
/**
 * 추론 텍스트에서 상태줄에 실을 한 줄을 고른다.
 *
 * 모델의 사고는 문단으로 흐르므로 **마지막 완성 문장**이 지금 하는 일에 가장 가깝다.
 * 마크다운 장식과 제어 표식은 걷어내고, 너무 길면 자른다. 뽑을 것이 없으면 null 이라
 * 호출부가 예전 문구로 되돌아간다.
 */
function reasoningHeadline(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim())
    .filter((line) => line.length >= 4 && !line.startsWith("{") && !line.startsWith("["));
  const last = lines[lines.length - 1];
  if (!last) return null;
  return last.length > 90 ? `${last.slice(0, 89)}…` : last;
}

/** Work 활동 타임라인에 남길 공개 reasoning summary. */
function reasoningSummary(text: string | undefined): string | null {
  const clean = text
    ?.replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!clean) return null;
  return clean.length > 2_000 ? `${clean.slice(0, 1_999)}…` : clean;
}

function stepsByMessageFromTimeline(
  history: readonly { id: string; role: string; createdAt?: string }[],
  timeline: readonly { receipt: InvocationRunReceipt; events: RunEventUi[] }[],
): Map<string, StreamStep[]> {
  const byMessage = new Map<string, StreamStep[]>();
  const answers = history.filter((entry) => entry.role === "assistant");
  if (answers.length === 0) return byMessage;
  const runs = [...timeline]
    .filter((entry) => entry.receipt?.runId && entry.receipt.startedAt)
    .sort((a, b) => a.receipt.startedAt.localeCompare(b.receipt.startedAt));
  for (const run of runs) {
    // 복원은 자르지 않는다. 창은 원장 조회(eventsPerRun)가 이미 정한다 —
    // 여기서 한 번 더 자르면 그만큼이 산출물에서 사라진다.
    const steps = mcpStepsFromLedger(run.events, 0);
    if (steps.length === 0) continue;
    // 그 실행이 시작된 뒤 처음 나온 답변이 그 실행의 답이다. 못 찾으면 마지막 답변에 붙인다
    // (예전 동작과 같은 자리) — 붙일 곳이 없다고 기록을 버리지는 않는다.
    const target = answers.find((entry) => (entry.createdAt ?? "") >= run.receipt.startedAt)
      ?? answers[answers.length - 1];
    byMessage.set(target.id, [...(byMessage.get(target.id) ?? []), ...steps]);
  }
  return byMessage;
}

function attachMcpStepsToLatestAgent(messages: StreamMessage[], steps: StreamStep[]): StreamMessage[] {
  if (steps.length === 0) return messages;
  let agentIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "agent") {
      agentIndex = i;
      break;
    }
  }
  if (agentIndex < 0) return messages;
  return messages.map((message, index) => index === agentIndex ? { ...message, steps } : message);
}

// 재진입(히스토리 재로드) 시 이미 답한 질문이 다시 '미답변'으로 보여 사용자가 재선택→중복 전송하는
// 버그를 막는다. answer 상태는 DB에 저장되지 않으므로(본문만 저장), 대화 순서로 복원한다:
// 질문을 가진 에이전트 메시지 '뒤에' 다른 메시지가 있으면 = 이미 답하고 대화가 진행된 것 → answered 처리.
// 답 라벨은 바로 뒤의 user 메시지에서 복원(멀티select 불릿 분해). 마지막 메시지의 질문만 미답으로 남긴다.
/** 답변 확정 영수증 로드 — 실패는 빈 맵(영수증은 보강 정보, 히스토리 표시를 막지 않는다). */
async function fetchCommittedReplies(
  api: ReturnType<typeof ipc>,
  chatId: string,
): Promise<Map<string, { reply: string; continuationRunId?: string }>> {
  try {
    const rows = await api?.confirm?.committedAnswers?.(chatId);
    return new Map((rows ?? []).map((row) => [row.sourceMessageId, {
      reply: row.reply,
      continuationRunId: row.continuationRunId,
    }]));
  } catch {
    return new Map();
  }
}

function restoreAnsweredQuestions(
  messages: StreamMessage[],
  committedReplies?: Map<string, { reply: string; continuationRunId?: string }>,
): StreamMessage[] {
  return messages.map((msg, i) => {
    if (!msg.questions || msg.questions.length === 0) return msg;
    // Last assistant question + committed receipt means Main accepted the
    // choice but no continuation user turn became durable. Reopen with the
    // exact saved reply instead of losing it or inventing a second answer.
    const committed = committedReplies?.get(msg.id);
    const committedReply = committed?.reply.trim() ?? "";
    if (i >= messages.length - 1) {
      return committedReply ? {
        ...msg,
        pendingCommittedReply: committedReply,
        pendingContinuationRunId: committed?.continuationRunId,
        pendingContinuationAutoResume: Boolean(committed?.continuationRunId),
      } : msg;
    }
    if (committedReply) {
      // An accepted receipt proves the batch was answered, not how arbitrary
      // free text should be split back into questions. Preserve that boundary.
      return {
        ...msg,
        questions: msg.questions.map((q) => q.answer?.length ? q : { ...q, answer: ["✓"] }),
      };
    }
    const nextUser = i >= messages.length - 1
      ? undefined
      : messages.slice(i + 1).find((m) => m.role === "user");
    const answerText = (nextUser?.text?.trim() ?? "") || committedReply;
    // 질문 시트 배치 스캐폴드("질문: …\n선택: …\n답변: …" 청크의 \n\n join —
    // ChatQuestionSheet.composeQuestionReply와 짝)는 질문별로 파싱해 각 질문에 제 답만 넣는다.
    // (예전처럼 전체 줄을 모든 질문에 주입하면 재로드 후 인용 카드가 오염된다)
    const scaffold = parseQuestionBatchReply(answerText);
    if (scaffold) {
      return {
        ...msg,
        questions: msg.questions.map((q) => {
          if (q.answer && q.answer.length) return q;
          const match = scaffold.find((chunk) => chunk.question === q.question.trim());
          return { ...q, answer: match && match.answers.length ? match.answers : ["—"] };
        }),
      };
    }
    const answers = answerText
      ? answerText.split("\n").map((s) => s.replace(/^•\s*/, "").trim()).filter(Boolean)
      : ["✓"];
    return {
      ...msg,
      questions: msg.questions.map((q) => (q.answer && q.answer.length ? q : { ...q, answer: answers })),
    };
  });
}

/** 배치 답장 스캐폴드 파서 — "질문:" 시작 청크마다 {question, answers(선택+답변)}로 분해.
 *  스캐폴드 형식이 아니면 null → 기존 줄 분해 폴백. */
function parseQuestionBatchReply(text: string): Array<{ question: string; answers: string[] }> | null {
  const trimmed = text.trim();
  if (!/^(질문|Question): /.test(trimmed)) return null;
  const chunks = trimmed.split(/\n\n+/);
  const parsed: Array<{ question: string; answers: string[] }> = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const qLine = lines.find((l) => /^(질문|Question): /.test(l));
    if (!qLine) continue;
    const question = qLine.replace(/^(질문|Question): /, "").trim();
    const answers: string[] = [];
    for (const line of lines) {
      const m = line.match(/^(선택|답변|Selected|Answer): (.*)$/);
      if (!m) continue;
      if (m[1] === "선택" || m[1] === "Selected") {
        answers.push(...m[2].split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        const note = m[2].trim();
        if (note) answers.push(note);
      }
    }
    parsed.push({ question, answers });
  }
  return parsed.length > 0 ? parsed : null;
}


/**
 * ★IPC 목록은 배열로 못박고 들어온다.
 *
 * 실측(2026-08-08, 실렌더 검증): `pendingHubApprovals()` 가 null 을 돌려주자
 * 렌더에서 `.filter` 가 던져 **ErrorBoundary 가 작업 화면을 통째로 대체**했다
 * (전역 오류 폴백). `.catch()` 는 거절만 막고 null **반환**은 못 막는다.
 * 목록 하나가 비었다고 채팅 전체가 사라지면 안 된다 — 그 부분만 비운다.
 */
function asList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export default function ChatPageWrapper() {
  // useSearchParams는 Suspense boundary를 요구함 (Next 15)
  return (
    <Suspense fallback={null}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const searchParams = useSearchParams();
  const queryChatId = searchParams.get("id") ?? "";
  const requestedFocusMessageId = searchParams.get("focus")?.trim() || null;
  const requestedTaskId = searchParams.get("task") ?? "";
  const [validatedTaskTarget, setValidatedTaskTarget] = useState<{
    taskId: string;
    chatId: string;
  } | null>(null);
  // Bind the resolution to the exact requested Task. Navigating A→B must fail
  // closed immediately instead of rendering A for one frame while B resolves.
  const validatedTaskChatId = requestedTaskId
    ? validatedTaskTarget?.taskId === requestedTaskId
      ? validatedTaskTarget.chatId
      : null
    : "";
  const chatId = requestedTaskId ? (validatedTaskChatId ?? "") : queryChatId;
  const surfaceParam = searchParams.get("surface") ?? "";
  // 홈 composer가 ?prompt=...로 첫 메시지를 실어서 보내면 자동 전송 (한 번만)
  const seedPrompt = searchParams.get("prompt") ?? "";
  const seedPermission = parsePermission(
    searchParams.get("permission") ?? searchParams.get("permissions"),
  );
  const router = useRouter();
  const { t, locale } = useT();
  const [chat, setChat] = useState<Chat | null>(null);
  const [goalContext, setGoalContext] = useState<ChatGoalContext | null>(null);
  const [agent, setAgent] = useState<InstalledAgent | null>(null);
  const [allAgents, setAllAgents] = useState<InstalledAgent[]>([]);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>([]);
  const [allFirms, setAllFirms] = useState<InstalledFirm[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [allEnvKeys, setAllEnvKeys] = useState<string[]>([]);
  const [allGeneratedApps, setAllGeneratedApps] = useState<AppFactoryAppRecord[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [pendingHubApprovals, setPendingHubApprovals] = useState<Array<{
    serverId: string;
    slug: string;
    serverName: string;
    command: string | null;
    args: string[];
    envKeys: string[];
  }>>([]);
  /** 이번 화면에서 "나중에"를 누른 항목 — 같은 카드가 계속 뜨면 내용을 안 읽고 닫는다. */
  const [dismissedHubApprovals, setDismissedHubApprovals] = useState<Set<string>>(new Set());
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [resolvedOrg, setResolvedOrg] = useState<ResolvedOrg | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const hydratedChatFileGroupsRef = useRef(new Map<string, ChatFileItem[]>());
  useEffect(() => {
    hydratedChatFileGroupsRef.current.clear();
  }, [chatId]);
  useEffect(() => {
    if (!chatId) return;
    const bridge = chatFilesBridge();
    if (!bridge) return;
    const groupIds = [...new Set(messages.flatMap((message) => message.chatFileGroupIds ?? []))]
      .filter((groupId) => !hydratedChatFileGroupsRef.current.has(groupId));
    if (groupIds.length === 0) return;
    let cancelled = false;
    void Promise.all(groupIds.map(async (groupId) => {
      const stored = await bridge.listGroup({ chatId, groupId });
      return [groupId, stored.map((file) => chatFileItem(file, "user-attachment"))] as const;
    })).then((groups) => {
      if (cancelled) return;
      for (const [groupId, files] of groups) hydratedChatFileGroupsRef.current.set(groupId, files);
      setMessages((current) => current.map((message) => {
        const files = (message.chatFileGroupIds ?? []).flatMap((groupId) => hydratedChatFileGroupsRef.current.get(groupId) ?? []);
        return files.length > 0 ? { ...message, chatFiles: files } : message;
      }));
    }).catch(() => {
      if (!cancelled) setSessionNotice(locale === "ko" ? "첨부 파일 기록을 불러오지 못했습니다." : "Attachment records could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [chatId, locale, messages]);
  // A chat transition renders once with the previous transcript while the new
  // history is loading. Rich-output auto-restore must wait for the current
  // chat's snapshot, or the previous chat's latest artifact can briefly appear
  // in the new chat.
  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  const currentChatIdRef = useRef(chatId);
  const chatGenerationRef = useRef(0);
  if (currentChatIdRef.current !== chatId) {
    currentChatIdRef.current = chatId;
    chatGenerationRef.current += 1;
  }
  const chatGeneration = chatGenerationRef.current;
  const chatMountedRef = useRef(true);
  useEffect(() => {
    chatMountedRef.current = true;
    return () => { chatMountedRef.current = false; };
  }, []);
  // A -> B -> A is a new view even though the chat id matches again. Pending
  // IPC may settle durably for the old view, but must not mutate the new one.
  const isCurrentChat = useCallback(() => chatMountedRef.current
    && currentChatIdRef.current === chatId
    && chatGenerationRef.current === chatGeneration, [chatId, chatGeneration]);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  // Every renderer-owned transcript mutation advances this clock. Async
  // history reads capture it before requesting a snapshot and may replace the
  // screen only while it is unchanged. Without this monotonic guard, a stale
  // history Promise that started before `final` could resolve after `final`
  // and erase the answer the user had already seen.
  const transcriptRevisionRef = useRef(0);

  useEffect(() => {
    const api = ipc();
    const chatId = chat?.id;
    const goalId = chat?.goalId;
    setGoalContext(null);
    if (!api || !chatId || !goalId || goalId === "pending") return;
    let cancelled = false;
    void api.chats.getGoalContext(chatId)
      .then((context) => { if (!cancelled) setGoalContext(context); })
      .catch(() => { if (!cancelled) setGoalContext(null); });
    return () => { cancelled = true; };
  }, [chat?.goalId, chat?.id]);

  // A Task deep link is authoritative. Resolve it through Main before loading
  // Work so a stale or mismatched chat query can never open another Task.
  useEffect(() => {
    if (!requestedTaskId) {
      setValidatedTaskTarget(null);
      return;
    }
    let cancelled = false;
    const api = ipc();
    if (!api) return;
    void api.tasks.get(requestedTaskId).then((task) => {
      if (cancelled) return;
      if (!task?.projectId) {
        setValidatedTaskTarget({ taskId: requestedTaskId, chatId: "" });
        router.replace(`/one?task=${encodeURIComponent(requestedTaskId)}`);
        return;
      }
      const originChatId = task?.originChatId ?? "";
      setValidatedTaskTarget({ taskId: requestedTaskId, chatId: originChatId });
      if (originChatId && originChatId !== queryChatId) {
        router.replace(`/workspace/task?id=${encodeURIComponent(originChatId)}&task=${encodeURIComponent(requestedTaskId)}`);
      } else if (!originChatId) {
        router.replace("/one");
      }
    }).catch(() => {
      if (!cancelled) {
        setValidatedTaskTarget({ taskId: requestedTaskId, chatId: "" });
        router.replace("/one");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [queryChatId, requestedTaskId, router]);

  // 화면에 복원된 대화 기록의 논리적 분량만 표시한다. 실제 모델 물리창 점유율은
  // CLI/BYOK별 시스템 프롬프트·툴·출력 예약과 compaction 뒤에야 정해지므로 가짜
  // 100k 분모나 퍼센트를 만들지 않는다.
  const currentTokens = useMemo(() => {
    return messages.reduce((acc, msg) => acc + (msg.tokens ?? Math.floor((msg.text?.length || 0) / 4)), 0);
  }, [messages]);
  // 멀티 에이전트 실시간 텔레메트리 — 속성(agentId) 이벤트로 채워지는 네트워크 패널 상태.
  const [liveAgents, setLiveAgents] = useState<Record<string, LiveAgent>>({});
  const [netTimeline, setNetTimeline] = useState<NetTimelineItem[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const subRef = useRef<(() => void) | null>(null);
  const seededRef = useRef<string>("");
  // A bookmark event can land while the initial chat metadata snapshot is still in flight.
  // Only the newest bookmark read may replace optimistic state, and a transient read failure
  // must not masquerade as an empty bookmark list.
  const hubBookmarkGenerationRef = useRef(0);
  const agentRosterGenerationRef = useRef(0);
  const refreshHubBookmarks = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const generation = ++hubBookmarkGenerationRef.current;
    try {
      const bookmarks = await api.marketplace.bookmarks();
      if (hubBookmarkGenerationRef.current === generation) setHubBookmarks(asList(bookmarks));
    } catch {
      // Preserve the last known/optimistic state until a later durable read succeeds.
    }
  }, []);
  // 활성 런타임/모델 — 헤더 칩 표시 + BYOK 인라인 모델 변경. 진행 중 실행의 runId(취소용).
  const [activeRuntime, setActiveRuntime] = useState<RuntimeStatus | null>(null);
  // 활성 런타임의 모델 목록 — 실시간 조회(BYOK는 provider API, ollama 동적, CLI 카탈로그).
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const runIdRef = useRef<string | null>(null);
  // Whether this chat was in the last activeChats broadcast. Lets the view see
  // an active -> inactive transition for runs it did not start itself.
  const activeChatSeenRef = useRef(false);
  const lastRunIdRef = useRef<string | null>(null);
  // 프롬프트 저장소 seedOnly 프리필 — 자동 전송 없이 입력창에만 채울 텍스트.
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null);
  // 델타 partial 누적 버퍼 — main이 증분만 보내므로 여기서 전문을 재조립한다.
  // 리셋 지점: 채팅 전환 / 새 실행 시작 / final·error / 전문(text) 이벤트 수신.
  const partialTextRef = useRef("");
  // 표시 좌표계 본문 길이 — partial마다 extractQuestions+stripMultimodalSetup 적용 후 길이를
  // 기록해 도구 인터리브 앵커(anchorTextLen)가 렌더 텍스트와 같은 좌표계를 쓰게 한다.
  // (raw 버퍼 길이를 쓰면 ask fence/멀티모달 마커 제거만큼 앵커가 뒤로 밀린다)
  const processedTextLenRef = useRef(0);
  // Only a run that actually used Browser / Computer Use may auto-minimize the
  // floating screen. Ordinary chat completions must not close a view the user
  // opened manually.
  const computerUseActiveRef = useRef(false);
  // runId가 도착하기 전(invoke:run 왕복 중)에 Stop을 누른 경우를 기억 — 도착 즉시 취소한다.
  const cancelRequestedRef = useRef(false);
  const recapGenerationRef = useRef(0);
  // 실행 중 steering — busy일 때 엔터로 들어온 메시지를 큐에 쌓고, 현재 턴이 끝나면 순서대로 전송한다.
  const steerQueueRef = useRef<
    Array<{
      text: string;
      optimisticMessageId: string;
      opts?: {
        images?: ImageAttachment[];
        files?: ChatFileDraft[];
        permissions?: PermissionLevel;
        planMode?: boolean;
        goalMode?: boolean;
        appsGenerateMode?: boolean;
        /** Explicit @ calls apply only to this queued turn and never rebind the task. */
        taskForceTargets?: OrchestrationTarget[];
        sessionRouting?: boolean;
        stormbreakerMode?: boolean;
      };
    }>
  >([]);
  const cancelRollbackSteersRef = useRef<(typeof steerQueueRef)["current"] | null>(null);
  const [queuedSteers, setQueuedSteers] = useState<string[]>([]);
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null);
  const [surface, setSurface] = useState<WorkbenchSurface | null>(null);
  // 실행 전 API 키 요청 시트 — mcp-key-request 이벤트가 채우고, 응답/만료/런 종료가 비운다.
  const [keyRequestSheet, setKeyRequestSheet] = useState<McpRunKeyRequest | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceFilePreview | null>(null);
  const watchedPreviewPath = useMemo(() => {
    if (!mediaPreview) return null;
    return [mediaPreview.path, ...(mediaPreview.openTargets ?? [])]
      .find((candidate) => typeof candidate === "string" && isAbsoluteLocalPath(candidate)) ?? null;
  }, [mediaPreview?.openTargets, mediaPreview?.path]);
  useEffect(() => {
    const bridge = ipc();
    // Optional file-watch APIs are unavailable in the static web shell and
    // may be older in an already-running Desktop preload. Check callable
    // shapes (not mere truthiness) so a compatibility stub returning a
    // Promise cannot later be invoked as an unsubscribe function.
    if (
      typeof bridge?.fs?.watchFile !== "function"
      || typeof bridge.fs.onFileChanged !== "function"
      || typeof bridge.fs.unwatchFile !== "function"
      || !watchedPreviewPath
      || !chatId
    ) return;
    let disposed = false;
    let watchId: string | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (snapshot: import("@shared/types").FsFileWatchSnapshot) => {
      if (disposed || snapshot.watchId !== watchId) return;
      if (!snapshot.exists) {
        setMediaPreview((current) => current && current.path === watchedPreviewPath
          ? { ...current, live: true, available: false, revision: snapshot.revision }
          : current);
        return;
      }
      const current = mediaPreview;
      let textPreview: Awaited<ReturnType<NonNullable<typeof bridge.fs.readTextFile>>> | null = null;
      if (current && ["markdown", "json", "text", "browser"].includes(current.viewerKind)) {
        textPreview = await bridge.fs.readTextFile(watchedPreviewPath, { kind: "chat-assets", chatId }).catch(() => null);
      }
      setMediaPreview((value) => {
        if (!value || value.path !== watchedPreviewPath) return value;
        return {
          ...value,
          size: snapshot.size ?? value.size,
          fileUrl: versionedPreviewUrl(value.fileUrl, snapshot.revision),
          live: true,
          available: true,
          revision: snapshot.revision,
          ...(textPreview ? {
            content: textPreview.content,
            truncated: textPreview.truncated,
            reason: textPreview.reason,
          } : {}),
        };
      });
    };
    const unsubscribe = bridge.fs.onFileChanged((snapshot) => {
      if (snapshot.watchId !== watchId) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refresh(snapshot); }, 80);
    });
    void bridge.fs.watchFile(watchedPreviewPath, { kind: "chat-assets", chatId }).then((initial) => {
      if (disposed) {
        void bridge.fs.unwatchFile(initial.watchId);
        return;
      }
      watchId = initial.watchId;
      setMediaPreview((current) => current && current.path === watchedPreviewPath
        ? { ...current, live: true, available: initial.exists, revision: initial.revision, size: initial.size ?? current.size }
        : current);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (typeof unsubscribe === "function") unsubscribe();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (watchId) void bridge.fs.unwatchFile(watchId);
    };
  // The watcher owns content/revision updates; remount only when the exact file or chat changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, watchedPreviewPath]);
  const [scaffoldedApps, setScaffoldedApps] = useState<Record<string, AppFactoryScaffoldResult>>({});
  const [scaffoldedTools, setScaffoldedTools] = useState<Record<string, ToolFactoryScaffoldResult>>({});
  const liveWorkbenchSurface = useMemo<WorkbenchSurface | null>(() => {
    if (!surface) return null;
    const appRecord = scaffoldedApps[surface.id]?.record
      ?? allGeneratedApps.find((app) => app.surfaceId === surface.id && app.status !== "archived");
    return appRecord ? { ...surface, liveAppId: appRecord.id } : surface;
  }, [allGeneratedApps, scaffoldedApps, surface]);
  // 우측 패널 — file / agent / panel 탭을 하나의 rail 안에서 전환한다.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<ChatRightPanelTab>("agent");
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readRightPanelWidth());
  const rightPanelPreferredWidthRef = useRef(rightPanelWidth);
  const requestReadableRightPanelWidth = useCallback((requested = preferredRichResultWidth()) => {
    setRightPanelWidth((current) => Math.max(current, clampRightPanelWidth(requested)));
  }, []);
  const restorePreferredRightPanelWidth = useCallback(() => {
    setRightPanelWidth(clampRightPanelWidth(rightPanelPreferredWidthRef.current));
  }, []);
  const clearRightPanelFilePreview = useCallback(() => {
    setMediaPreview(null);
    restorePreferredRightPanelWidth();
  }, [restorePreferredRightPanelWidth]);
  const readableRightPanelActive = rightPanelOpen && rightPanelTab === "panel" && Boolean(mediaPreview);
  /*
   * ★창이 좁아지면 레일도 같이 줄어든다(2026-09-04 실측).
   *
   * 폭은 열 때 한 번만 계산했고 창 크기 변화에는 반응하지 않았다. 그래서 1240px 에서
   * 결과를 연 뒤 1024px 로 줄이면 레일은 446 을 그대로 붙들고 작성창이 **272px** 로
   * 눌렸다 — 고치기 전(398)보다 나빴다. 저장은 하지 않는다: 창 크기에 맞춰 줄어든 값은
   * 사용자가 고른 폭이 아니라 지금 화면이 허용하는 폭이다.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setRightPanelWidth((current) => {
      const clamped = clampRightPanelWidth(current);
      // A file/result rail may contract while the window is narrow, but that
      // contraction is not a new user preference. When room returns, restore
      // the same temporary readable width that opening the file requested.
      const next = readableRightPanelActive
        ? Math.max(clamped, preferredRichResultWidth())
        : clamped;
      return next === current ? current : next;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [readableRightPanelActive]);
  const [rightPanelHeight, setRightPanelHeight] = useState<number | null>(() => readRightPanelHeight());
  const workspaceOpen = rightPanelOpen && rightPanelTab === "file";
  const networkOpen = rightPanelOpen && rightPanelTab === "agent";
  // 슬래시 명령(/folder·/global)으로 워킹 폴더를 바꾸면 하단 폴더 바를 다시 읽게 하는 토큰
  const [folderReload, setFolderReload] = useState(0);
  // ContinuityReceipt(복원 배너)용 — 채팅 진입 시 ipc().workspace.get으로 복원된 마지막 작업 폴더.
  // 기기 간 클라우드 복원 여부는 백엔드 미확인이므로, 실제로 알 수 있는 사실(로컬 복원 경로)만 보여준다.
  const [restoredFolder, setRestoredFolder] = useState<string | null>(null);
  // /clear 뒤에 메시지를 다시 적재하지 않고도 실제 컨텍스트 리셋이 끝났음을 알려준다.
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  // 이번 실행의 도구 기록에서 본 로컬 서버 주소. 모델이 답변 본문에 주소를 안 적어도
  // 우측 레일이 열려야 한다(2026-09-03 실측: 주소가 도구 결과에만 있으면 레일이 안 열렸다).
  const runServerUrlsRef = useRef<string[]>([]);
  /**
   * 에이전트가 보고 있는 화면(브라우저·컴퓨터). 도구가 도는 동안 우측 레일 안에 그린다 —
   * One 과 같은 자리다. 예전에는 떠 있는 카드만 이 사실을 들었고 레일은 열리지도 않았다
   * (2026-09-03 실측: 브라우저 도구 실행 중 레일 없음, 카드만 창 한가운데).
   */
  const [agentScreen, setAgentScreen] = useState<{ mode: "browser" | "computer" } | null>(null);
  const [questionCommitPending, setQuestionCommitPending] = useState(false);
  const questionCommitPendingRef = useRef<string | null>(null);
  const continuationResumeAttemptsRef = useRef(new Set<string>());
  const continuationTransportRetryableRef = useRef(new Set<string>());
  const [continuationReconnectEpoch, setContinuationReconnectEpoch] = useState(0);
  useEffect(() => { continuationResumeAttemptsRef.current.clear(); }, [chatId]);
  useEffect(() => {
    const onOnline = () => {
      if (continuationTransportRetryableRef.current.size === 0) return;
      continuationResumeAttemptsRef.current.clear();
      setContinuationReconnectEpoch((value) => value + 1);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);
  // 세션 recap — 자리를 비운 사이 도착한 에이전트 응답 한 줄 요약(있을 때만 배너).
  const [recap, setRecap] = useState<{ summary: string; count: number } | null>(null);
  const [defaultRunFolder, setDefaultRunFolder] = useState<string | null>(null);
  const mediaBasePaths = useMemo(
    () => mediaBasePathCandidates(restoredFolder, defaultRunFolder),
    [restoredFolder, defaultRunFolder],
  );
  // 파셜마다 대화 전체를 정규식으로 재스캔하면 비용이 대화 길이에 비례해 자란다
  // ("오래 쓰면 느려짐"의 렌더러 쪽 원인). 스트리밍 중 본문이 자라는 메시지는
  // 마지막 하나뿐이므로 메시지별로 스캔 결과를 캐시한다. 본문은 append-only라
  // 길이 변화가 곧 내용 변화다.
  const linkedFileScanCacheRef = useRef(
    new Map<string, {
      textLength: number;
      baseKey: string;
      stepsKey: string;
      previews: WorkspaceFilePreview[];
      outputPreviews: WorkspaceFilePreview[];
    }>(),
  );
  const { files: linkedFiles, outputs: linkedOutputFiles } = useMemo(() => {
    const baseKey = mediaBasePaths.join("\u0000");
    const cache = linkedFileScanCacheRef.current;
    const out: WorkspaceFilePreview[] = [];
    const outputOut: WorkspaceFilePreview[] = [];
    const seen = new Set<string>();
    const outputSeen = new Set<string>();
    const liveIds = new Set<string>();
    for (const message of messages) {
      if (message.role !== "agent") continue;
      const text = message.text ?? "";
      /* ★파일 링크와 실제 산출물은 별도 집합이다.
         본문 스캔만 하면, 파일을 쓰고 그 이름을 산문에 적지 않은 답변은 산출물이
         하나도 없는 것처럼 보인다. 반대로 Read까지 산출물로 세면, 채팅을 다시 열 때
         마지막 입력 파일이 결과 탭으로 자동 복원된다. 공용 판별기로 읽기·쓰기·편집을
         모두 수집하되, 출력 집합에는 읽기만 제외한다. */
      const toolPaths = toolFilePathsFromSteps(message.steps);
      const outputToolPaths = toolFilePathsFromSteps(message.steps, { includeReads: false });
      const imageDataUrls = message.imageDataUrls ?? [];
      // 에이전트가 앱을 세웠으면, 사람이 다음에 할 일은 그걸 보는 것이다.
      // 본문에 적힌 주소 + 도구 기록에 남은 주소. 둘 다 "지금 돌고 있는 것"의 증거다.
      const serverUrls = [...new Set([
        ...localServerUrlsInText(text).map(normalizeLocalServerUrl),
        ...localServerUrlsFromSteps(message.steps),
      ])];
      const stepsKey = [...toolPaths, ...outputToolPaths, ...serverUrls, ...imageDataUrls].join("\u0000");
      liveIds.add(message.id);
      let entry = cache.get(message.id);
      if (
        !entry
        || entry.textLength !== text.length
        || entry.baseKey !== baseKey
        || entry.stepsKey !== stepsKey
      ) {
        /* 도구 기록이 같은 이름을 절대경로로 갖고 있으면 그 기록이 정본이다. 산문에서
           찍어 만든 경로는 실행 폴더를 잘못 고른 "만든 적 없는 파일"일 수 있다. */
        const recordedPaths = [...toolPaths, ...outputToolPaths];
        const textPreviews = linkedFileArtifactsInText(text, mediaBasePaths)
          .filter((file) => !shadowsToolRecordedPath(file.path, recordedPaths, file.href))
          .map((file) => workspacePreviewFromLinkedFile(file));
        const toolPreviews = toolPaths
          .map((filePath) => workspacePreviewFromLinkedFile(linkedFileArtifactFromPath(filePath)));
        const outputToolPreviews = outputToolPaths
          .map((filePath) => workspacePreviewFromLinkedFile(linkedFileArtifactFromPath(filePath)));
        const serverPreviews = serverUrls.map((url) => workspacePreviewFromLocalServer(url));
        const imagePreviews = imageDataUrls.map((url, index) => workspacePreviewFromImageUrl(url, index));
        entry = {
          textLength: text.length,
          baseKey,
          stepsKey,
          previews: [...textPreviews, ...toolPreviews, ...serverPreviews, ...imagePreviews],
          // A read is useful for inspection but is not evidence that the agent
          // produced that file. Keep that distinction through the whole rail:
          // it prevents a reopened chat from presenting the latest Read target
          // as if it were the latest deliverable.
          outputPreviews: [...textPreviews, ...outputToolPreviews, ...serverPreviews, ...imagePreviews],
        };
        cache.set(message.id, entry);
      }
      for (const preview of entry.previews) {
        const key = preview.path || preview.fileUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(preview);
      }
      for (const preview of entry.outputPreviews) {
        const key = preview.path || preview.fileUrl;
        if (outputSeen.has(key)) continue;
        outputSeen.add(key);
        outputOut.push(preview);
      }
    }
    // 채팅 전환·/clear로 사라진 메시지의 캐시는 함께 버린다.
    if (cache.size > liveIds.size) {
      for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
    }
    return { files: out, outputs: outputOut };
  }, [messages, mediaBasePaths]);
  const hasViewablePanelContent = Boolean(
    artifact
    || surface
    || mediaPreview
    || agentScreen
    || linkedOutputFiles.length > 0
  );

  // 사용자가 직접 패널을 접고/펴면 선호값을 영속화 (자동 노출과 구분).
  const setWorkspaceOpenPersisted = useCallback((open: boolean) => {
    if (open) {
      setRightPanelTab("file");
      setRightPanelOpen(true);
      writeRightPanelPreference(true, "file");
    } else if (rightPanelTab === "file") {
      setRightPanelOpen(false);
      writeRightPanelPreference(false, "file");
    }
  }, [rightPanelTab]);
  const setNetworkOpenPersisted = useCallback((open: boolean) => {
    if (open) {
      setRightPanelTab("agent");
      setRightPanelOpen(true);
      writeRightPanelPreference(true, "agent");
    } else if (rightPanelTab === "agent") {
      setRightPanelOpen(false);
      writeRightPanelPreference(false, "agent");
    }
  }, [rightPanelTab]);
  const openPanelTab = useCallback((tab: ChatRightPanelTab) => {
    setRightPanelTab(tab);
    setRightPanelOpen(true);
    writeRightPanelPreference(true, tab);
    if (tab === "panel") {
      /*
       * ★자동으로 넓힌 폭은 사용자의 선택이 아니므로 저장하지 않는다(2026-09-03 실측).
       *
       * 예전에는 여기서 넓힌 값을 그대로 기록했고, 넓히기는 Math.max 라 줄어들지 않았다.
       * 그래서 결과를 한 번 연 것만으로 레일이 1240px 창에서 536px 을 영구 점유했고,
       * 이후 **모든 대화**가 작성창 398px 로 눌렸다(같은 창에서 One 은 레일 252 · 작성창 720).
       * 빈 레일이 대화보다 넓은 화면은 그렇게 만들어졌다. 수리 뒤 새 대화는 레일 392 ·
       * 작성창 542 로 돌아온다(실측). 손으로 끌어 정한 폭은 그대로 저장된다 — 그건 선택이다.
       */
      requestReadableRightPanelWidth();
    }
  }, [requestReadableRightPanelWidth]);
  const closeRightPanel = useCallback(() => {
    setRightPanelOpen(false);
    restorePreferredRightPanelWidth();
    writeRightPanelPreference(false, rightPanelTab);
  }, [restorePreferredRightPanelWidth, rightPanelTab]);
  const openWorkspaceFilePreview = useCallback(async (preview: WorkspaceFilePreview) => {
    const requestChatId = chatId;
    let next = preview;
    const api = ipc();
    /* ★읽을 경로는 `path` 하나가 아니라 후보 전체에서 고른다.
       채팅 본문에서 뽑아낸 파일 참조는 `1.docx` 같은 맨 이름일 때가 있고, 그때
       `path` 는 절대경로가 아니라 그 이름 그대로다. 예전엔 그 경우 읽기를 통째로
       건너뛰어 본문이 빈 뷰어가 떴다 — 작업 폴더 배너를 닫아 base path 가 하나
       줄면 멀쩡하던 파일도 그렇게 됐다. `openTargets` 에 절대경로가 하나라도
       있으면 그걸로 읽는다. */
    const readablePath = [preview.path, ...(preview.openTargets ?? [])]
      .find((candidate) => typeof candidate === "string" && isAbsoluteLocalPath(candidate));
    if (readablePath) {
      next = {
        ...next,
        path: readablePath,
        fileUrl: fileUrlForToolPath(readablePath),
      };
    }
    /*
     * ★자리를 **먼저** 연다. 내용은 읽히는 대로 채운다.
     *
     * 예전에는 파일을 다 읽은 뒤에야 패널을 열었다. 그래서 실행이 끝나는 순간 결과 레일이
     * 사라졌다가 읽기가 끝나야 돌아왔다 — 사람이 결과를 보려는 바로 그 순간 결과창이
     * 없어진다(2026-09-03 실측: 완료 직후 2.5초간 레일 소멸, 그 길이는 읽기 시간과 일치).
     * 먼저 열면 빈 프레임이 잠깐 보이지만, 사라졌다 돌아오는 것보다 낫다.
     */
    setSurface(null);
    setArtifact(null);
    setMediaPreview(next);
    openPanelTab("panel");
    const shouldReadText =
      api &&
      Boolean(requestChatId) &&
      Boolean(readablePath) &&
      ["markdown", "json", "text", "browser"].includes(preview.viewerKind);
    if (shouldReadText && readablePath) {
      const text = await api.fs.readTextFile(readablePath, { kind: "chat-assets", chatId: requestChatId }).catch(() => null);
      // The user may have moved to another chat while Main was reading. Do
      // not let that late response put the old file back into the new rail.
      if (currentChatIdRef.current !== requestChatId) return;
      if (text) {
        next = {
          ...next,
          path: readablePath,
          size: text.size || next.size,
          content: text.content,
          truncated: text.truncated,
          reason: text.reason,
        };
      } else {
        // A persisted transcript link can outlive the file it referenced.
        // Keep the tab and show an explicit unavailable state instead of an
        // empty viewer that looks like a successfully opened blank document.
        next = { ...next, content: "", available: false };
      }
    }
    // 읽은 내용으로 채운다. 자리는 위에서 이미 열었으므로 여기서 다시 열지 않는다.
    if (currentChatIdRef.current !== requestChatId) return;
    setMediaPreview(next);
  }, [chatId, openPanelTab]);

  // Restore the latest rich result when a conversation is reopened. The
  // transcript is durable, so this also covers route changes and app restarts
  // where the live completion event is no longer available. A user close is
  // respected until a different output key arrives.
  const autoPresentedWorkspaceOutputRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatId || hydratedChatId !== chatId || busy || linkedOutputFiles.length === 0) return;
    const candidate = [...linkedOutputFiles].reverse().find((file) => (
      ["markdown", "json", "text", "browser", "image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive"]
        .includes(file.viewerKind)
    ));
    if (!candidate) return;
    const key = `${chatId}\u0000${candidate.viewerKind}\u0000${candidate.path || candidate.fileUrl}`;
    if (autoPresentedWorkspaceOutputRef.current === key) return;
    autoPresentedWorkspaceOutputRef.current = key;
    void openWorkspaceFilePreview(candidate);
  }, [busy, chatId, hydratedChatId, linkedOutputFiles, openWorkspaceFilePreview]);
  const openLinkedFile = useCallback((file: LinkedFileArtifact) => {
    void openWorkspaceFilePreview(workspacePreviewFromLinkedFile(file));
  }, [openWorkspaceFilePreview]);
  const openChatFile = useCallback((file: ChatFileItem) => {
    void (async () => {
      let preview = file.viewer;
      if (file.kind === "file" && file.fileUrl && ["markdown", "json", "text", "browser"].includes(preview.viewerKind)) {
        try {
          const response = await fetch(file.fileUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          preview = { ...preview, content: await response.text(), available: true };
        } catch {
          preview = { ...preview, available: false, content: "" };
        }
      }
      await openWorkspaceFilePreview(preview);
    })();
  }, [openWorkspaceFilePreview]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void api.workspace.defaultRunFolder().then((folder) => {
      if (!cancelled) setDefaultRunFolder(folder);
    }).catch(() => {
      if (!cancelled) setDefaultRunFolder(null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const resizeRightPanel = useCallback((width: number) => {
    const next = clampRightPanelWidth(width);
    rightPanelPreferredWidthRef.current = next;
    setRightPanelWidth(next);
    writeRightPanelWidth(next);
  }, []);
  // 가용 높이는 패널만 알 수 있어 clamp 는 패널이 한다. 여기는 소유와 저장만 맡는다.
  const resizeRightPanelHeight = useCallback((next: number | null) => {
    setRightPanelHeight(next);
    writeRightPanelHeight(next);
  }, []);

  // 한 실행의 이벤트(라이브 스트림 OR 재접속 리플레이)를 메인 버블 + 네트워크 패널에 반영.
  // send()의 인라인 핸들러를 추출해 재접속 경로와 공유 — lastStatusRef는 중복 status 억제용(공유).
  const consumeEvent = useCallback(
    (ev: McpInvocationEvent, placeholderId: string, lastStatusRef: { text: string }) => {
      // 실행 전 API 키 요청 — 만료 전 요청만 시트로 올린다(재접속 리플레이의 낡은
      // 요청은 무시). 값 입력/저장은 McpKeyRequestSheet가 env.set으로만 처리한다.
      if (ev.kind === "mcp-key-request") {
        if (ev.keyRequest && ev.keyRequest.expiresAt > Date.now()) {
          setKeyRequestSheet(ev.keyRequest);
        }
        return;
      }
      // Main persists terminal answers before publishing `final`, but a
      // history request may already hold an older snapshot. Mark every live
      // run event before changing the visible transcript so that snapshot can
      // never rewind the UI after this point.
      transcriptRevisionRef.current += 1;
      if (ev.kind === "final" || ev.kind === "error") setKeyRequestSheet(null);
      const computerUseMode = ev.tool ? computerUseModeForTool(ev.tool.name) : null;
      if (computerUseMode) {
        computerUseActiveRef.current = true;
        announceComputerUseActivity(computerUseMode, "active");
      }
      if ((ev.kind === "final" || ev.kind === "error") && computerUseActiveRef.current) {
        computerUseActiveRef.current = false;
        announceComputerUseActivity(null, "finished");
      }
      const fallbackAgentId = agent?.id ?? "active-agent";
      const fallbackAgentName = agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback");
      const fallbackStepMeta: Partial<StreamStep> = {
        agentName: fallbackAgentName,
        activity: "status",
      };
      const markWorkflowActive = (status?: string) => {
        setLiveAgents((prev) => ({
          ...prev,
          [fallbackAgentId]: {
            name: fallbackAgentName,
            role: "",
            tier: 1,
            active: true,
            status: status ?? prev[fallbackAgentId]?.status,
          },
        }));
      };
      const pushWorkflow = (
        kind: NetTimelineItem["kind"],
        text: string,
        // 영수증 실측 — 도구명/토큰. 단일 에이전트(fallback) 경로에서도 영수증을 채운다.
        receipt?: { toolName?: string; tokens?: number },
      ) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        markWorkflowActive(trimmed);
        appendTimeline(setNetTimeline, {
          key: uid(),
          agentId: fallbackAgentId,
          name: fallbackAgentName,
          role: "",
          tier: 1,
          kind,
          text: trimmed,
          toolName: receipt?.toolName,
          tokens: receipt?.tokens,
        });
      };

      // ── 속성(agentId) 이벤트 → 네트워크 패널 (메인 버블 안 건드림) ──
      if (ev.agentId || ev.agentMessage?.fromAgentId) {
        const aid = ev.agentId ?? ev.agentMessage!.fromAgentId;
        if (ev.agentMessage) {
          appendTimeline(setNetTimeline, {
            key: uid(),
            agentId: aid,
            name: ev.agentName ?? aid,
            role: ev.role ?? "",
            tier: ev.tier,
            kind: "message",
            text: ev.agentMessage.text,
            messageDirection: ev.agentMessage.direction,
            messageFrom: ev.agentMessage.fromAgentId,
            messageTo: ev.agentMessage.toAgentId,
            delegateTo: ev.delegateTo,
          });
        }
        if (ev.agentLifecycle) {
          const lifecycleText = ev.status?.trim() || (
            ev.agentLifecycle.state === "closed"
              ? locale === "ko" ? "CLI 프로세스 닫힘" : "CLI process closed"
              : ev.agentLifecycle.state === "idle"
                ? locale === "ko" ? "CLI 프로세스 대기 중" : "CLI process idle"
                : ev.agentLifecycle.state === "failed"
                  ? locale === "ko" ? "CLI 프로세스 실패" : "CLI process failed"
                  : locale === "ko" ? "CLI 프로세스 실행 중" : "CLI process running"
          );
          appendTimeline(setNetTimeline, {
            key: uid(),
            agentId: aid,
            name: ev.agentName ?? aid,
            role: ev.role ?? "",
            tier: ev.tier,
            kind: "status",
            text: lifecycleText,
            tokens: ev.tokens,
          });
        }
        // per-node 완료 신호 — 그 노드만 비활성(▶→✓)으로 정리하고 종료. (전체 active 리셋과 별개)
        if (ev.done) {
          setLiveAgents((prev) =>
            prev[aid]
              ? {
                  ...prev,
                  [aid]: {
                    ...prev[aid],
                    active: false,
                    ...(ev.agentLifecycle ? { processState: ev.agentLifecycle.state, processRuntime: ev.agentLifecycle.runtime } : {}),
                  },
                }
              : prev,
          );
          appendTimeline(setNetTimeline, {
            key: uid(),
            agentId: aid,
            name: ev.agentName ?? aid,
            role: ev.role ?? "",
            tier: ev.tier,
            kind: "status",
            // 실패 경로 done은 status("… 실패/failed")를 동봉 → 완료로 위장하지 않고 실패를 표시.
            text: ev.status?.trim() || (locale === "ko" ? "완료" : "completed"),
            tokens: ev.tokens,
          });
          return;
        }
        setLiveAgents((prev) => ({
          ...prev,
          [aid]: {
            name: ev.agentName ?? prev[aid]?.name ?? aid,
            role: ev.role ?? prev[aid]?.role ?? "",
            tier: ev.tier ?? prev[aid]?.tier,
            active: ev.agentLifecycle
              ? ev.agentLifecycle.state === "running"
              : ev.agentMessage
                ? Boolean(prev[aid]?.active)
                : true,
            status: ev.status ?? prev[aid]?.status,
            delegateTo: ev.delegateTo ?? prev[aid]?.delegateTo,
            model: ev.model ?? prev[aid]?.model,
            ...(ev.agentLifecycle
              ? { processState: ev.agentLifecycle.state, processRuntime: ev.agentLifecycle.runtime }
              : prev[aid]?.processState
                ? { processState: prev[aid].processState, processRuntime: prev[aid].processRuntime }
                : {}),
          },
        }));
        if (!ev.agentMessage && !ev.agentLifecycle && ev.kind === "tool-use") {
          const label = ev.tool ? toolWorkflowText(ev.tool, locale) : ev.status?.trim() ?? "";
          if (label) {
            appendTimeline(setNetTimeline, {
                key: uid(),
                agentId: aid,
                name: ev.agentName ?? aid,
                role: ev.role ?? "",
                tier: ev.tier,
                kind: ev.delegateTo ? "handoff" : ev.tool ? "tool" : "status",
                text: ev.status?.trim() || label,
                // 영수증 실측 — 이벤트가 줄 때만(없으면 undefined → 카드에서 생략)
                toolName: ev.tool?.name,
                tokens: ev.tokens,
                delegateTo: ev.delegateTo,
            });
          }
        } else if (!ev.agentMessage && !ev.agentLifecycle && ev.kind === "thinking" && ev.status?.trim()) {
          appendTimeline(setNetTimeline, {
              key: uid(),
              agentId: aid,
              name: ev.agentName ?? aid,
              role: ev.role ?? "",
              tier: ev.tier,
              kind: ev.delegateTo ? "handoff" : "status",
              text: ev.status!.trim(),
              tokens: ev.tokens,
              delegateTo: ev.delegateTo,
          });
        }
        // 메인 버블에도 활동 반영 — 접기요약(WorkingPanel)이 "돌아가는 중 + 도구 N개"를
        // 보여줘 긴 멀티에이전트 실행 중 불안을 줄인다 (per-agent 상세는 네트워크 패널).
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== placeholderId) return msg;
            const steps = msg.steps ?? [];
            const meta: Partial<StreamStep> = {
              agentName: ev.agentName,
              role: ev.role,
              phase: ev.phase,
              delegateTo: ev.delegateTo,
              activity: activityForEvent(ev),
            };
            if (ev.agentMessage) {
              const directionLabel = ev.agentMessage.direction === "orchestrator-to-worker"
                ? (locale === "ko" ? "메시지 전송됨" : "Message sent")
                : (locale === "ko" ? "결과 전달됨" : "Result sent");
              return {
                ...msg,
                steps: [
                  ...steps,
                  {
                    id: uid(),
                    kind: "thinking",
                    text: `${directionLabel} · ${ev.agentMessage.text}`,
                    createdAt: Date.now(),
                    ...meta,
                    activity: "handoff",
                  },
                ],
              };
            }
            if (ev.kind === "tool-use" && ev.tool) {
              return {
                ...msg,
                steps: mergeToolStep(steps, ev.tool, meta),
              };
            }
            const st = ev.status?.trim();
            if (st && ev.kind !== "partial") {
              return {
                ...msg,
                steps: [
                  ...steps,
                  {
                    id: uid(),
                    kind: "thinking",
                    text: st,
                    createdAt: Date.now(),
                    ...meta,
                  },
                ],
              };
            }
            return msg;
          }),
        );
        // 파이프라인 단계 진행 — 이 에이전트가 어떤 단계인지 매칭되면 켠다(best-effort, 비차단).
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId && msg.pipeline ? { ...msg, pipeline: advancePipeline(msg.pipeline, ev) } : msg,
          ),
        );
        return;
      }
      if (ev.kind === "usage") {
        // 라이브 누적 토큰 — 상태줄 "{N}s · {tokens} tokens" 실시간 갱신(단조 증가만 허용).
        if (ev.tokens != null && ev.tokens > 0) {
          const nextTokens = ev.tokens;
          setMessages((m) =>
            m.map((msg) =>
              msg.id === placeholderId && (msg.liveTokens ?? 0) < nextTokens
                ? { ...msg, liveTokens: nextTokens }
                : msg,
            ),
          );
        }
        return;
      }
      if (ev.kind === "reasoning" && ev.reasoning) {
        // thinking 구간 신호 — 상태줄 문구 회전("생각 중…")과 "N초 동안 생각함"의 근거.
        const phase = ev.reasoning.phase;
        const durationMs = ev.reasoning.durationMs;
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== placeholderId) return msg;
            const th = msg.thinking ?? { active: false, cumMs: 0 };
            if (phase === "start") {
              return { ...msg, thinking: { active: true, startedAt: Date.now(), cumMs: th.cumMs } };
            }
            if (phase === "delta") {
              // ★모델이 쓴 추론의 첫 줄을 상태줄에 싣는다 — 예전에는 이 텍스트를 버리고
              //   시간만 기록해서 화면에 "생각 중…" 만 돌았다(One 은 이 줄을 보여준다).
              const line = reasoningHeadline(ev.reasoning?.text);
              return line ? { ...msg, thinking: { ...th, active: true, headline: line } } : msg;
            }
            const dur = durationMs ?? (th.startedAt != null ? Date.now() - th.startedAt : 0);
            const summary = reasoningSummary(ev.reasoning?.text);
            const steps = msg.steps ?? [];
            const nextSteps = summary && !steps.some((step) => step.reasoning === true && step.text === summary)
              ? [
                  ...steps,
                  {
                    id: uid(),
                    kind: "thinking" as const,
                    text: summary,
                    reasoning: true,
                    createdAt: Date.now(),
                    activity: "status" as const,
                  },
                ]
              : steps;
            return {
              ...msg,
              thinking: { active: false, cumMs: th.cumMs + dur, lastMs: dur },
              steps: nextSteps,
            };
          }),
        );
        return;
      }
      if (ev.kind === "tool-use" && ev.tool) {
        const screenMode = computerUseModeForTool(ev.tool.name);
        if (screenMode) {
          setAgentScreen({ mode: screenMode });
          openPanelTab("panel");
        }
        for (const text of [ev.tool.result, ev.tool.args]) {
          if (!text) continue;
          for (const raw of localServerUrlsInText(text)) {
            const url = normalizeLocalServerUrl(raw);
            if (!runServerUrlsRef.current.includes(url)) runServerUrlsRef.current.push(url);
          }
        }
        pushWorkflow("tool", ev.status?.trim() || toolWorkflowText(ev.tool, locale), {
          toolName: ev.tool.name,
          tokens: ev.tokens,
        });
        // anchorTextLen: 이 도구 이벤트 도착 시점의 '표시 좌표계' 본문 길이 — ChatStream이
        // 텍스트 사이에 도구 그룹을 영상처럼 끼워 넣는 분할 앵커로 쓴다.
        const anchorTextLen = processedTextLenRef.current;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  ...msg,
                  // 도구 활동 시작 — 직전 "N초 동안 생각함" 잔류 표시는 걷는다.
                  thinking:
                    msg.thinking && !msg.thinking.active && msg.thinking.lastMs != null
                      ? { ...msg.thinking, lastMs: undefined }
                      : msg.thinking,
                  steps: mergeToolStep(msg.steps ?? [], ev.tool!, {
                    ...fallbackStepMeta,
                    activity: "tool",
                    anchorTextLen,
                  }),
                }
              : msg,
          ),
        );
      } else if (ev.kind === "notice" && ev.notice) {
        // ★호스트 고지는 답변 본문에 섞지 않는다. 자기 행으로 붙는다.
        const notice = ev.notice;
        if (notice.code === "runtime-fallback" && ev.runtimeSelection) {
          const selection = ev.runtimeSelection;
          setChat((prev) => prev ? { ...prev, runtimeSelection: selection } : prev);
          const api = ipc();
          if (api) {
            void api.runtime.detect().then((list) => {
              const matched = list.find((runtime) => (
                runtime.kind === selection.kind
                && (!selection.backend || runtime.backend === selection.backend)
                && (!selection.source || runtime.source === selection.source)
              )) ?? list.find((runtime) => (
                runtime.kind === selection.kind
                && (!selection.backend || runtime.backend === selection.backend)
              ));
              if (matched) {
                setActiveRuntime({
                  ...matched,
                  active: true,
                  model: selection.model ?? matched.model,
                  effort: selection.effort ?? matched.effort,
                  longContextEnabled: selection.longContext ?? matched.longContextEnabled,
                });
              }
            }).catch(() => undefined);
          }
        }
        setMessages((prev) => {
          const lastAgent = [...prev].reverse().find((m) => m.role === "agent");
          if (!lastAgent) {
            return [
              ...prev,
              { id: uid(), role: "agent" as const, text: "", notices: [{ id: uid(), ...notice }] },
            ];
          }
          return prev.map((m) =>
            m.id === lastAgent.id
              ? { ...m, notices: [...(m.notices ?? []), { id: uid(), ...notice }] }
              : m,
          );
        });
      } else if (ev.kind === "surface" && ev.surface) {
        pushWorkflow("tool", `Surface ready · ${ev.surface.title}`);
        const surfaceId = ev.surfaceId ?? uid();
        setArtifact(null);
        setMediaPreview(null);
        setSurface({ id: surfaceId, manifest: ev.surface });
        openPanelTab("panel");
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  ...msg,
                  steps: [
                    ...(msg.steps ?? []),
                    {
                      id: uid(),
                      kind: "tool",
                      text: `Surface ready · ${ev.surface!.title}`,
                      tool: "agentlas_surface",
                      agentName: fallbackAgentName,
                      activity: "tool",
                      createdAt: Date.now(),
                      args: JSON.stringify({
                        id: surfaceId,
                        domain: ev.surface!.domain,
                        layout: ev.surface!.layout,
                      }),
                    },
                  ],
                }
              : msg,
          ),
        );
      } else if (ev.kind === "thinking" || ev.kind === "tool-use") {
        const status = ev.status?.trim();
        if (!status || status === lastStatusRef.text) return;
        lastStatusRef.text = status;
        // Stormbreaker supervisor receipts belong in the engine journal, not
        // in an ordinary user's chat transcript. Keep the run visibly active
        // without exposing scope-lock/route plumbing as assistant content.
        if (isInternalLoopStatus(status)) {
          const publicStatus = /session alive, waiting for output/i.test(status)
            ? (locale === "ko" ? "모델이 계속 작업 중" : "The model is still working")
            : (locale === "ko" ? "작업 경로를 준비하는 중" : "Preparing the work path");
          markWorkflowActive(publicStatus);
          // Heartbeats refresh one compact live line. They never append another
          // step/card, which is what previously turned a single long run into
          // dozens of duplicate-looking rows.
          setMessages((current) => current.map((message) =>
            message.id === placeholderId ? { ...message, status: publicStatus } : message
          ));
          return;
        }
        pushWorkflow("status", status);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  ...msg,
                  steps: [
                    ...(msg.steps ?? []),
                    {
                      id: uid(),
                      kind: ev.kind === "thinking" ? "thinking" : "tool",
                      text: status,
                      createdAt: Date.now(),
                      ...fallbackStepMeta,
                    },
                  ],
                }
              : msg,
          ),
        );
      } else if (ev.kind === "partial") {
        // 델타 스트림 재조립 — main은 증분(delta)+검증 길이(textLen)만 보낸다.
        // 전문(text) 이벤트는 리플레이/폴백 경로로, 누적 버퍼를 그대로 덮어쓴다.
        let raw: string;
        if (typeof ev.delta === "string") {
          const next = partialTextRef.current + ev.delta;
          if (ev.textLen != null && next.length !== ev.textLen) {
            // 어긋남(리플레이 경계 등 드묾) — 버퍼 스냅샷을 다시 받아 재동기화.
            const api = ipc();
            void api?.invoke.attach(chatId).then((att) => {
              const snap = [...(att?.events ?? [])]
                .reverse()
                .find((e) => e.kind === "partial" && !e.agentId && typeof e.text === "string");
              const snapText = snap?.text;
              if (typeof snapText !== "string") return;
              partialTextRef.current = snapText;
              const resync = extractQuestions(snapText, placeholderId);
              const resyncSetup = stripMultimodalSetup(resync.text);
              processedTextLenRef.current = resyncSetup.text.length;
              setMessages((m) =>
                m.map((msg) => {
                  if (msg.id !== placeholderId) return msg;
                  return {
                    ...msg,
                    text: resyncSetup.text,
                    streaming: true,
                    questions: resync.questions.length > 0 ? resync.questions : msg.questions,
                    needsMultimodalSetup: resyncSetup.needsSetup || msg.needsMultimodalSetup,
                  };
                }),
              );
            });
            return;
          }
          partialTextRef.current = next;
          raw = next;
        } else {
          raw = ev.text ?? "";
          partialTextRef.current = raw;
        }
        // 변환을 한 번만 수행 — 렌더 본문과 도구 앵커가 같은 좌표계를 공유한다.
        const { text: extractedText, questions } = extractQuestions(raw, placeholderId);
        const setup = stripMultimodalSetup(extractedText);
        processedTextLenRef.current = setup.text.length;
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== placeholderId) return msg;
            return {
              ...msg,
              text: setup.text,
              streaming: true,
              // 새 텍스트 활동 — 직전 "N초 동안 생각함" 잔류 표시는 걷는다.
              thinking:
                msg.thinking && !msg.thinking.active && msg.thinking.lastMs != null
                  ? { ...msg.thinking, lastMs: undefined }
                  : msg.thinking,
              questions: questions.length > 0 ? questions : msg.questions,
              needsMultimodalSetup: setup.needsSetup || msg.needsMultimodalSetup,
            };
          }),
        );
      } else if (ev.kind === "final") {
        pushWorkflow("status", locale === "ko" ? "완료" : "Done", { tokens: ev.tokens });
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== placeholderId) return msg;
            const raw = ev.text ?? "";
            const parsed = extractQuestions(raw, msg.id);
            const projectedQuestions = ev.userDecisionRequest?.schemaVersion === "agentlas.user-decision-request.v1"
              ? ev.userDecisionRequest.questions.map((question, index) => ({
                  id: `${msg.id}-q${index}`,
                  ...question,
                }))
              : [];
            const questions = projectedQuestions.length > 0 ? projectedQuestions : parsed.questions;
            const setup = stripMultimodalSetup(parsed.text);
            return {
              ...msg,
              text: setup.text,
              imageDataUrls: ev.imageDataUrls ?? msg.imageDataUrls,
              busy: false,
              streaming: false,
              finishedAt: Date.now(),
              thinking: msg.thinking ? { ...msg.thinking, active: false } : msg.thinking,
              needsMultimodalSetup: setup.needsSetup || msg.needsMultimodalSetup,
              tokens: ev.tokens ?? msg.tokens,
              pipeline: completePipeline(msg.pipeline),
              steps: [
                ...(msg.steps ?? []),
                {
                  id: uid(),
                  kind: "thinking",
                  text: locale === "ko" ? "에이전트 작업 완료" : "Agent work completed",
                  agentName: fallbackAgentName,
                  activity: "complete",
                  createdAt: Date.now(),
                },
              ],
              // The terminal event is authoritative. A completed partial fence
              // must not survive a divergent/malformed final or cancellation.
              questions: questions.length > 0 ? questions : undefined,
              questionSourceMessageId: questions.length > 0
                ? ev.userDecisionRequest?.sourceMessageId ?? msg.questionSourceMessageId
                : undefined,
              pendingCommittedReply: undefined,
              pendingContinuationRunId: undefined,
              pendingContinuationAutoResume: undefined,
            };
          }),
        );
        setBusy(false);
        setCancelPending(false);
        cancelRequestedRef.current = false;
        setLiveAgents((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([k, v]) => [
              k,
              { ...v, active: false, status: locale === "ko" ? "완료" : "Completed" },
            ]),
          ),
        );
        runIdRef.current = null;
        lastRunIdRef.current = null;
        partialTextRef.current = "";
        processedTextLenRef.current = 0;
        subRef.current?.();
        subRef.current = null;
        /* 산출물 자동 패널 오픈 — 답이 만들어 낸 것을 사람이 **클릭하기 전에** 띄운다.
           ★예전엔 이미지만 띄웠다. 그래서 문서·표·코드처럼 실제 작업 산출물 대부분은
           우측 패널이 끝내 비어 있었고("열린 산출물이 아직 없습니다"), 사람은 뭐가
           만들어졌는지 알 수 없었다. 이미지를 우선하되, 없으면 이 답이 언급한 첫 파일을
           **내용까지 읽어서** 올린다. */
        // 실행이 끝나면 화면 자리를 놓아준다 — 그 자리는 이제 산출물이 쓴다.
        setAgentScreen(null);
        const resultText = ev.text ?? "";
        const autoImage = ev.imageDataUrls?.[0]
          ? workspacePreviewFromImageUrl(ev.imageDataUrls[0], 0)
          : null;
        const autoMedia = firstMediaArtifactInText(resultText, mediaBasePaths);
        if (autoImage) {
          setSurface(null);
          setArtifact(null);
          setMediaPreview(autoImage);
          openPanelTab("panel");
        } else if (autoMedia) {
          setSurface(null);
          setArtifact(null);
          setMediaPreview(workspacePreviewFromMedia(autoMedia));
          openPanelTab("panel");
        } else {
          // A runnable local web result is the thing the user wants to inspect,
          // not merely its source file. Keep it in this BrowserWindow's right
          // rail through the native live-view host.
          // 본문에 주소가 없어도 이 실행이 서버를 띄웠다면 그것이 사람이 볼 것이다.
          const liveUrl = localServerUrlsInText(resultText).map(normalizeLocalServerUrl)[0]
            ?? runServerUrlsRef.current[0];
          if (liveUrl) {
            void openWorkspaceFilePreview(workspacePreviewFromLocalServer(liveUrl));
          } else {
            const produced = linkedFileArtifactsInText(resultText, mediaBasePaths)[0];
            if (produced) void openWorkspaceFilePreview(workspacePreviewFromLinkedFile(produced));
          }
        }
        // 첫 메시지였으면 main이 자동 제목 생성 → 갱신해서 사이드바도 반영
        const api = ipc();
        void api?.chats.get(chatId).then((c) => {
          if (c) setChat(c);
        });
      } else if (ev.kind === "error") {
        // 어느 경로든 이미 스트리밍된 텍스트는 지우지 않고 완료된 버블로 남긴다.
        // Interrupt steering intentionally cancels only the superseded provider turn.
        // The queued user instruction remains authoritative and Main immediately owns
        // the replacement run, so this internal cancellation must not become a red
        // user-facing failure card.
        const wasUserCancel = cancelRequestedRef.current;
        const terminalStatus = wasUserCancel
          ? (locale === "ko" ? "취소됨" : "Cancelled")
          : (locale === "ko" ? "중단됨" : "Stopped");
        const failureCode = ev.error?.code?.trim() || "runtime_error";
        const wasSteeringCancel = !wasUserCancel
          && failureCode.toLowerCase() === "cancelled"
          && steerQueueRef.current.length > 0;
        const failureMessage = ev.error?.message?.trim()
          || (locale === "ko" ? "실행이 완료되지 않았습니다." : "The run did not complete.");
        const failureId = `run-error:${placeholderId}`;
        const failureText = locale === "ko"
          ? `⚠️ 작업이 완료되지 않았습니다.\n사유: ${failureMessage} [${failureCode}]`
          : `⚠️ The work did not complete.\nReason: ${failureMessage} [${failureCode}]`;
        const keepPlaceholder = (m: StreamMessage[]) =>
          m.flatMap((msg) => {
            if (msg.id !== placeholderId) return [msg];
            if (!msg.text || !msg.text.trim()) return [];
            return [{
              ...msg,
              busy: false,
              streaming: false,
              finishedAt: Date.now(),
              thinking: msg.thinking ? { ...msg.thinking, active: false } : msg.thinking,
              pipeline: completePipeline(msg.pipeline),
              // A failed/cancelled run cannot leave a question extracted from
              // an earlier partial chunk eligible for confirmation or reload.
              questions: undefined,
              questionSourceMessageId: undefined,
              pendingCommittedReply: undefined,
              pendingContinuationRunId: undefined,
              pendingContinuationAutoResume: undefined,
            }];
          });
        setMessages((current) => {
          const settled = keepPlaceholder(current);
          if (wasUserCancel || wasSteeringCancel || settled.some((message) => message.id === failureId)) return settled;
          return [
            ...settled,
            {
              id: failureId,
              role: "system",
              text: failureText,
              failure: { code: failureCode, message: failureMessage },
            },
          ];
        });
        setBusy(false);
        setCancelPending(false);
        cancelRequestedRef.current = false;
        setLiveAgents((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([k, v]) => [
              k,
              {
                ...v,
                active: false,
                status: terminalStatus,
              },
            ]),
          ),
        );
        runIdRef.current = null;
        lastRunIdRef.current = null;
        partialTextRef.current = "";
        processedTextLenRef.current = 0;
        subRef.current?.();
        subRef.current = null;
      }
    },
    [agent, chat?.title, chatId, locale, mediaBasePaths, openPanelTab, openWorkspaceFilePreview, project?.name, t],
  );

  // consumeEvent를 ref로 미러 — subscribeRun/메타데이터 effect가 consumeEvent identity 변화(agent·
  // agentGroup 세팅 등)에 재구독/재실행되던 churn을 없앤다. 리스너는 항상 최신 consumeEvent를 호출한다.
  const consumeEventRef = useRef(consumeEvent);
  useEffect(() => {
    consumeEventRef.current = consumeEvent;
  }, [consumeEvent]);

  // runId 채널 구독 — send()와 재접속 경로 공용. lastStatusRef를 받으면(리플레이 후) 이어서 쓴다.
  // Stable within a chat generation; a queued event from an older view cannot
  // reach the new view's consumeEvent ref, even after A -> B -> A.
  const subscribeRun = useCallback(
    (runId: string, placeholderId: string, lastStatusRef: { text: string } = { text: "" }) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events || !isCurrentChat()) return;
      const channel = api.invoke.eventChannel(runId);
      subRef.current?.();
      subRef.current = events.on(channel, (ev: McpInvocationEvent) => {
        if (isCurrentChat()) consumeEventRef.current(ev, placeholderId, lastStatusRef);
      });
    },
    [isCurrentChat],
  );

  // Esc는 현재 보이는 우측 레일만 닫는다. 산출물 자체를 지우면 사용자가 작업을 잃은 것처럼 보인다.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 입력창의 Esc 핸들러(자동완성/메뉴 닫기, Cmd/Ctrl+Esc 실행 정지)가 이미 처리했으면 중복 동작 안 함.
      if (e.defaultPrevented) return;
      if (e.key !== "Escape" || !rightPanelOpen) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      e.preventDefault();
      closeRightPanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeRightPanel, rightPanelOpen]);

  // 뷰 상태 미러 — 채팅 전환 effect가 이전 채팅의 마지막 렌더 상태를 스냅샷할 수 있게
  // 매 렌더마다 갱신한다(전환 시점에 messages state는 아직 이전 채팅 것이다).
  // 반드시 아래 전환-리셋 effect보다 먼저 선언되어야 한다(같은 커밋에서 먼저 실행).
  const viewSnapshotRef = useRef<{ messages: StreamMessage[]; liveAgents: Record<string, LiveAgent>; netTimeline: NetTimelineItem[] }>({
    messages: [],
    liveAgents: {},
    netTimeline: [],
  });
  useEffect(() => {
    viewSnapshotRef.current = { messages, liveAgents, netTimeline };
  });
  const prevChatIdRef = useRef<string | null>(null);

  // 채팅 전환 시 이전 채팅의 진행 상태(busy/정지버튼/스트림)가 새 뷰로 새지 않게 리셋.
  // 메타데이터 effect는 번역/콜백 변화에도 다시 돌 수 있으므로, 전환 초기화는 chatId에만 묶는다.
  useEffect(() => {
    if (!chatId) return;
    setHydratedChatId(null);
    transcriptRevisionRef.current += 1;
    // 이전 채팅 뷰를 캐시에 저장 — 되돌아올 때 히스토리 로드를 기다리지 않고 즉시 복원.
    const prevChatId = prevChatIdRef.current;
    prevChatIdRef.current = chatId;
    if (prevChatId && prevChatId !== chatId) {
      saveChatViewSnapshot(prevChatId, viewSnapshotRef.current);
    }
    // 이전 채팅의 메시지/스트림 드래프트를 즉시 비운다 — 안 그러면 이전 채팅이 실행 중일 때
    // (busy 드래프트가 남아) 메타데이터 로드의 hasLiveDraft 가드가 새 채팅에도 옛 세션을 계속
    // 보여준다(다른 챗 눌러도 지금 세션이 뜨는 버그). 캐시 히트면 스냅샷을 즉시 그려 빈 화면
    // 플래시를 없애고, 히스토리 로드가 곧바로 이어서 최신본으로 교체한다(라이브 드래프트 없음).
    const restored = readChatViewSnapshot(chatId);
    setMessages(restored?.messages ?? []);
    setBusy(false);
    questionCommitPendingRef.current = null;
    setQuestionCommitPending(false);
    continuationTransportRetryableRef.current.clear();
    setCancelPending(false);
    runIdRef.current = null;
    lastRunIdRef.current = null;
    partialTextRef.current = "";
    processedTextLenRef.current = 0;
    runServerUrlsRef.current = [];
    setAgentScreen(null);
    setComposerPrefill(null);
    cancelRequestedRef.current = false;
    steerQueueRef.current = [];
    setQueuedSteers([]);
    setArtifact(null);
    setSurface(null);
    setMediaPreview(null);
    restorePreferredRightPanelWidth();
    setRightPanelOpen(false);
    setRightPanelTab("agent");
    setLiveAgents(restored?.liveAgents ?? {});
    setNetTimeline(restored?.netTimeline ?? []);
    setScaffoldedApps({});
    setScaffoldedTools({});
    setInstalledPlugins([]);
    setAllGeneratedApps([]);
    setRestoredFolder(null);
    setSessionNotice(null);
    return () => {
      subRef.current?.();
      subRef.current = null;
      // 라우트 이탈(언마운트)에도 저장한다. 기존에는 같은 마운트 안에서 채팅을
      // 전환할 때만 저장해서, 워크스페이스를 떠났다 돌아오면 캐시가 100% 미스라
      // 매번 빈 화면 + 전체 재로드였다. 채팅 전환 시에는 위 본문 저장과 같은
      // 내용을 한 번 더 쓰는 것뿐이라 무해(멱등)하다.
      saveChatViewSnapshot(chatId, viewSnapshotRef.current);
    };
  }, [chatId, restorePreferredRightPanelWidth]);

  // CLI auto-update가 현재 열려 있는 Work 대화에도 즉시 반영되게 한다. 대시보드는
  // runtime store 방송을 듣지만, 이 화면이 초기 detect 결과만 붙들면 모델/바이너리가
  // 바뀐 뒤 사용자가 모델을 한 번 더 눌러야 새 런타임이 보이는 것처럼 남는다.
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events?.onStoreChanged || !chatId) return;
    let generation = 0;
    const refresh = () => {
      const requestGeneration = ++generation;
      void api.runtime.detect().then((list) => {
        if (requestGeneration !== generation) return;
        const selection = chat?.runtimeSelection ?? null;
        const matched = selection
          ? list.find(
              (runtime) =>
                runtime.kind === selection.kind &&
                (!selection.backend || runtime.backend === selection.backend) &&
                (!selection.source || runtime.source === selection.source),
            )
          : list.find((runtime) => runtime.active);
        // A dead pin is handled by the metadata hydration path on re-entry. Do not
        // blank an already usable header when a transient probe returns no match.
        if (selection && !matched) return;
        setActiveRuntime(
          matched
            ? {
                ...matched,
                active: true,
                model: selection?.model ?? matched.model,
                effort: selection?.effort ?? matched.effort,
                longContextEnabled:
                  selection?.longContext ?? matched.longContextEnabled,
              }
            : null,
        );
      }).catch(() => undefined);
    };
    return events.onStoreChanged((change) => {
      if (change.entity === "runtime") refresh();
    });
  }, [chat?.runtimeSelection, chatId]);

  // The transcript is durable, so the Agent work panel must be durable too.
  // Rebuild terminal run activity from Main's redacted run ledger after a
  // reload instead of showing "Idle / 0 steps" beside a completed team reply.
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    void api.invoke.latestReceipt(chatId)
      .then(async (receipt) => {
        if (
          !receipt ||
          receipt.status === "running" ||
          receipt.status === "cancelling"
        ) return null;
        const events = await api.runLedger.events(receipt.runId, 500);
        return workflowSnapshotFromLedger(events, locale);
      })
      .then((snapshot) => {
        if (cancelled || !snapshot || snapshot.timeline.length === 0) return;
        setLiveAgents((current) =>
          Object.keys(current).length > 0 ? current : snapshot.liveAgents,
        );
        setNetTimeline((current) => current.length > 0 ? current : snapshot.timeline);
      })
      .catch(() => {
        // A missing historical ledger must not block the transcript itself.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, locale]);

  // 메타데이터 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    void (async () => {
      const bookmarkGeneration = ++hubBookmarkGenerationRef.current;
      const rosterGeneration = ++agentRosterGenerationRef.current;
      const c = await api.chats.get(chatId);
      if (cancelled || !c) {
        if (!c) router.replace("/");
        return;
      }
      if (c.originSurface === "one" && !c.projectId) {
        const oneTask = await api.tasks.findForChat(c.id).catch(() => null);
        router.replace(oneTask
          ? `/one?task=${encodeURIComponent(oneTask.id)}`
          : `/one?chat=${encodeURIComponent(c.id)}`);
        return;
      }
      setChat(c);
      setTitleDraft(c.title);
      // The local agent roster is the only metadata that gates composing a
      // message. Hub, MCP, project, and generated-App reads are independent:
      // one slow optional domain must never leave a valid local chat disabled.
      const agents = await api.team.list();
      if (cancelled) return;
      if (agentRosterGenerationRef.current === rosterGeneration) {
        setAllAgents(agents);
      }
      setAgent(agents.find((a) => a.id === c.agentId) ?? null);

      void api.firms.list().then((firms) => {
        if (!cancelled && agentRosterGenerationRef.current === rosterGeneration) setAllFirms(asList(firms));
      }).catch(() => undefined);
      void api.projects.list().then((projects) => {
        if (!cancelled) setAllProjects(asList(projects));
      }).catch(() => undefined);
      void api.env.list().then((envVars) => {
        if (!cancelled) {
          // @ 멘션에는 실제 값이 있는 키만 노출한다.
          setAllEnvKeys(envVars.filter((entry) => entry.hasValue).map((entry) => entry.key));
        }
      }).catch(() => undefined);
      void api.mcpTools.listInstalled().then((plugins) => {
        if (!cancelled) setInstalledPlugins(asList(plugins));
      }).catch(() => undefined);
      // 자동 브리지가 붙여 두고 승인을 기다리는 도구. 실행 중에는 영수증 한 줄로만
      // 지나가서, 그 순간을 놓치면 어디서 무엇을 켜는지 알 수 없었다.
      void api.mcpTools.pendingHubApprovals().then((rows) => {
        if (!cancelled) setPendingHubApprovals(asList(rows));
      }).catch(() => undefined);
      void api.appFactory.listApps(chatId).then((generatedApps) => {
        if (!cancelled) setAllGeneratedApps(asList(generatedApps));
      }).catch(() => undefined);
      void api.marketplace.bookmarks().then((bookmarks) => {
        if (!cancelled && hubBookmarkGenerationRef.current === bookmarkGeneration) setHubBookmarks(bookmarks);
      }).catch(() => undefined);
      const hydrationRevision = transcriptRevisionRef.current;
      void Promise.all([
        api.invoke.history(chatId),
        fetchCommittedReplies(api, chatId),
        api.invoke.latestReceipt(chatId).catch(() => null),
        typeof api.runLedger?.chatTimeline === "function"
          ? api.runLedger.chatTimeline(chatId, { maxRuns: 40, eventsPerRun: 400 }).catch(() => [])
          : Promise.resolve([]),
      ])
        .then(async ([history, committedReplies, receipt, chatTimeline]) => {
          if (cancelled) return;
          const ledgerEvents = receipt && receipt.status !== "running" && receipt.status !== "cancelling"
            ? await api.runLedger.events(receipt.runId, 500).catch(() => [])
            : [];
          const mcpSteps = mcpStepsFromLedger(ledgerEvents);
          const stepsByMessage = stepsByMessageFromTimeline(history, chatTimeline);
          if (
            requestedFocusMessageId
            && !history.some((entry) => entry.id === requestedFocusMessageId)
          ) {
            setSessionNotice(
              locale === "ko"
                ? "이 작업 기록의 원문 메시지는 삭제되었습니다. 세션의 현재 위치를 열었습니다."
                : "The original message for this work record was deleted. The current session is open.",
            );
          }
          const historyMessages: StreamMessage[] = restoreAnsweredQuestions(
            history.map(historyEntryToStreamMessage),
            committedReplies,
          );
          // 원장에 지난 실행이 남아 있으면 실행마다 제 답변에 붙인다. 없으면 예전처럼
          // 마지막 실행 하나만 마지막 답변에 붙인다(원장을 못 읽어도 화면은 나빠지지 않게).
          const historyWithMcp = stepsByMessage.size > 0
            ? historyMessages.map((message) => {
                const steps = stepsByMessage.get(message.id);
                return steps && steps.length > 0 ? { ...message, steps } : message;
              })
            : attachMcpStepsToLatestAgent(historyMessages, mcpSteps);
          const recovery = receiptRecoveryMessage(receipt, locale);
          const restoredMessages = recovery ? [...historyWithMcp, recovery] : historyWithMcp;
          setHydratedChatId(chatId);
          setMessages((current) => {
            if (transcriptRevisionRef.current !== hydrationRevision) return current;
            const hasLiveDraft = current.some((msg) => msg.busy || msg.streaming);
            // History and the redacted run ledger are separate reads. If the
            // history read wins a race with a just-finished live stream, keep
            // that stream's tool-backed outputs while adopting the durable
            // message IDs/text. Otherwise a late hydration silently removes
            // files, charts, or previews from the right rail.
            return hasLiveDraft ? current : preserveRichStepsBySignature(current, restoredMessages);
          });
        }).catch(() => {
          if (!cancelled) setHydratedChatId(chatId);
          if (!cancelled && requestedFocusMessageId) {
            setSessionNotice(
              locale === "ko"
                ? "이 작업 기록의 원문 위치를 확인하지 못했습니다. 세션의 현재 위치를 열었습니다."
                : "The original position could not be verified. The current session is open.",
            );
          }
        });
      // 역할 기본값 또는 이 채팅의 exact pin — 헤더 칩 표시용.
      void api.runtime.detect().then((list) => {
        if (cancelled) return;
        const selection = c.runtimeSelection;
        const matched = selection
          ? list.find(
              (runtime) =>
                runtime.kind === selection.kind &&
                (!selection.backend || runtime.backend === selection.backend) &&
                (!selection.source || runtime.source === selection.source),
            )
          : list.find((runtime) => runtime.active);
        // 고정된 런타임이 사라졌을 때(CLI 삭제/경로 변경, BYOK 키 제거) 예전에는 칩이 통째로
        // 사라지고 applySelection이 activeRuntime null로 즉시 return → 핀을 지울 방법이 전혀
        // 없어 채팅이 영구히 벽돌이 됐다(매 전송 pinned-runtime-unavailable). 죽은 핀은 여기서
        // 스스로 풀고 현재 활성 런타임으로 되돌린다 — 모델 선택은 채팅을 못 쓰게 만드는
        // 되돌릴 수 없는 결박이어서는 안 된다.
        // 단, list가 비면 "설치된 게 없음"과 "탐지 실패"를 구분할 수 없으므로 핀을 건드리지 않는다.
        if (selection && !matched && list.length > 0) {
          const fallback = list.find((runtime) => runtime.active) ?? null;
          void api.chats.setRuntimeSelection(chatId, null).then((updated) => {
            if (cancelled) return;
            if (!updated || updated.id !== chatId || updated.runtimeSelection !== null) {
              throw new Error("Desktop did not acknowledge the cleared runtime pin");
            }
            setChat(updated);
            setActiveRuntime(fallback ? { ...fallback, active: true } : null);
            setSessionNotice(
              locale === "ko"
                ? `이 채팅에 고정돼 있던 실행 엔진(${selection.kind}${selection.model ? ` · ${selection.model}` : ""})을 더 이상 찾을 수 없어 고정을 해제했습니다. 현재 활성 엔진으로 계속 대화할 수 있습니다.`
                : `The engine pinned to this chat (${selection.kind}${selection.model ? ` · ${selection.model}` : ""}) is no longer available, so the pin was released. This chat now uses the active engine.`,
            );
          }).catch(() => {
            if (cancelled) return;
            setSessionNotice(
              locale === "ko"
                ? `이 채팅의 사용할 수 없는 실행 엔진 고정을 해제하지 못했습니다. 기존 고정은 유지됩니다. Desktop 연결을 확인한 뒤 이 작업을 다시 여세요.`
                : "The unavailable engine pin could not be released, so the existing pin remains. Check the Desktop connection and reopen this task to retry.",
            );
          });
          return;
        }
        setActiveRuntime(
          matched
            ? {
                ...matched,
                active: true,
                model: selection?.model ?? matched.model,
                effort: selection?.effort ?? matched.effort,
                longContextEnabled:
                  selection?.longContext ?? matched.longContextEnabled,
              }
            : null,
        );
      });
      // 패널 노출 결정: 사용자가 명시적으로 접고/편 선호값이 있으면 그것을 우선,
      // 없으면 working_folder가 저장돼 있을 때만 자동 노출.
      void api.workspace.get(chatId).then((savedFolder) => {
        if (cancelled) return;
        const rightPanelPreference = readRightPanelPreference();
        if (rightPanelPreference?.open && rightPanelPreference.tab !== "panel") {
          setRightPanelTab(rightPanelPreference.tab);
          setRightPanelOpen(true);
        } else if (!rightPanelPreference && savedFolder) {
          setRightPanelTab("file");
          setRightPanelOpen(true);
        } else if (rightPanelPreference?.tab !== "panel") {
          setRightPanelOpen(false);
        }
        // ContinuityReceipt — 복원된 작업 폴더가 있을 때만 배너를 띄운다(없으면 null → 렌더 안 함).
        setRestoredFolder(savedFolder ?? null);
      }).catch(() => undefined);
      if (c.projectId) {
        void api.projects.get(c.projectId).then((projectRecord) => {
          if (!cancelled) setProject(projectRecord);
        }).catch(() => undefined);
      }
      if (c.firmId) {
        void api.firms.get(c.firmId).then((firmRecord) => {
          if (!cancelled) setFirm(firmRecord);
        }).catch(() => undefined);
        // 네트워크 패널 명단용 — 정규화된 3-tier 조직 (리졸버 결과 또는 orgChart 파생)
        void api.firms.getResolvedOrg(c.firmId).then((o) => {
          if (!cancelled) setResolvedOrg(o);
        });
      } else {
        setFirm(null);
        setResolvedOrg(null);
      }
      // 진행 중 실행 재접속 — 이 채팅이 백그라운드로 돌고 있으면(다른 채팅 갔다 옴) 스트림·정지버튼 복구.
      // 버퍼된 이벤트를 리플레이해 진행 중 버블을 재구성하고, runId 채널을 구독해 이후 스트림을 받는다.
      const attached = await api.invoke.attach(chatId);
      if (!cancelled && attached) {
        const placeholderId = uid();
        // 원 실행 시작 시각을 우선 — 재진입 시 상태줄 경과가 0s부터 다시 세지 않게.
        const attachedStartedAt = attached.startedAt ? Date.parse(attached.startedAt) : NaN;
        const startedAt = Number.isFinite(attachedStartedAt) ? attachedStartedAt : Date.now();
        const reconnectAgent = agents.find((a) => a.id === c.agentId);
        const reconnectAgentName = reconnectAgent ? pickLocalized(reconnectAgent, locale).name : t("chat.assistant_fallback");
        transcriptRevisionRef.current += 1;
        setMessages((m) => [
          ...m,
          {
            id: placeholderId,
            role: "agent",
            text: "",
            busy: true,
            startedAt,
            steps: [
              {
                id: uid(),
                kind: "thinking",
                text: t("chat.status.sending"),
                agentName: reconnectAgentName,
                activity: "start",
                createdAt: startedAt,
              },
            ],
          },
        ]);
        setBusy(true);
        setCancelPending(false);
        runIdRef.current = attached.runId;
        lastRunIdRef.current = attached.runId;
        const lastStatusRef = { text: "" };
        for (const ev of attached.events) consumeEventRef.current(ev, placeholderId, lastStatusRef);
        subscribeRun(attached.runId, placeholderId, lastStatusRef);
      }
    })().catch((error) => {
      if (cancelled) return;
      console.error("[chat] critical metadata load failed", error);
      setSessionNotice(
        locale === "ko"
          ? "로컬 에이전트 목록을 불러오지 못했습니다. 새로고침 후 다시 시도하세요."
          : "The local agent roster could not be loaded. Refresh and try again.",
      );
    });
    return () => {
      cancelled = true;
    };
    // consumeEvent를 deps에서 제외(ref로 접근) — agent/agentGroup 세팅이 이 effect를 재실행시켜
    // attach가 중복 placeholder를 만들고 구독을 갈아치우던 churn을 없앤다. subscribeRun은 이제 안정적.
  }, [chatId, locale, requestedFocusMessageId, router, subscribeRun, t]);

  useEffect(
    () =>
      onAgentRosterChange((change) => {
        const generation = ++agentRosterGenerationRef.current;
        setAllAgents((previous) => [
          change.agent,
          ...previous.filter((agent) => agent.id !== change.agent.id),
        ]);
        const api = ipc();
        if (!api) return;
        void Promise.all([api.team.list(), api.firms.list()])
          .then(([agents, firms]) => {
            if (agentRosterGenerationRef.current !== generation) return;
            setAllAgents(agents);
            setAllFirms(firms);
          })
          .catch(() => {
            // The imported agent remains available from the durable success
            // event even if a follow-up roster read is temporarily unavailable.
          });
      }),
    [],
  );

  // ── 세션 recap ──────────────────────────────────────────
  // 기준점(last_viewed_at)은 이 채팅을 "떠날 때"(hidden/언마운트) 갱신하고, "돌아왔을 때"(visible)
  // 그 이후 도착한 에이전트 응답을 평가한다. 이러면 내가 지켜본 메시지는 recap되지 않고,
  // 자리를 비운 사이 백그라운드로 쌓인 응답만 한 줄 요약으로 뜬다.
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    recapGenerationRef.current += 1;
    setRecap(null); // 채팅 전환 시 이전 recap 제거
    const evalRecap = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const requestGeneration = ++recapGenerationRef.current;
      const r = await api.chats.recap(chatId).catch(() => null);
      if (!cancelled && requestGeneration === recapGenerationRef.current && r?.summary) {
        setRecap({ summary: r.summary, count: r.count });
      }
    };
    const markViewed = () => {
      void api.chats.markViewed(chatId).catch(() => undefined);
    };
    void evalRecap();
    const onVis = () => {
      if (document.hidden) markViewed();
      else void evalRecap();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      markViewed(); // 이 채팅을 떠날 때 기준점을 지금으로 옮긴다
    };
  }, [chatId]);

  // Library > Generated surfaces can deep-link back to the originating chat and
  // reopen the durable Workbench surface without requiring a live invocation.
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId || !surfaceParam) return;
    let cancelled = false;
    void api.surfaces.getSurface(surfaceParam).then((record) => {
      if (cancelled || !record || record.chatId !== chatId) return;
      setArtifact(null);
      setMediaPreview(null);
      setSurface({ id: record.id, manifest: record.manifest, state: record.state, jobSummary: record.jobSummary });
      openPanelTab("panel");
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, openPanelTab, surfaceParam]);

  // 재접속 안전망 — 진행 중이라 여겼는데(runIdRef) main의 실행 목록에서 이 채팅이 빠졌으면
  // (attach 스냅샷↔구독 틈에 final 이벤트를 놓친 경우) 히스토리를 다시 읽어 최종 답변으로 화해.
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events || !chatId) return;
    return events.onActiveChats((ids) => {
      const isActive = ids.includes(chatId);
      const wasActive = activeChatSeenRef.current;
      activeChatSeenRef.current = isActive;
      if (isActive) {
        // Main owns the steering queue and starts the next run with a new runId.
        // Attach as soon as that run becomes active; otherwise this renderer
        // stays subscribed to the cancelled run until the user leaves and
        // re-enters the chat.
        if (runIdRef.current) return;
        void api.invoke.attach(chatId).then((attached) => {
          if (!attached || runIdRef.current) return;
          const placeholderId = uid();
          const attachedStartedAt = attached.startedAt ? Date.parse(attached.startedAt) : NaN;
          const startedAt = Number.isFinite(attachedStartedAt) ? attachedStartedAt : Date.now();
          const reconnectAgentName = agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback");
          transcriptRevisionRef.current += 1;
          setMessages((current) => [
            ...current,
            {
              id: placeholderId,
              role: "agent",
              text: "",
              busy: true,
              startedAt,
              steps: [{
                id: uid(),
                kind: "thinking",
                text: locale === "ko" ? "새 방향을 반영하는 중" : "Applying the new direction",
                agentName: reconnectAgentName,
                activity: "start",
                createdAt: startedAt,
              }],
            },
          ]);
          steerQueueRef.current.shift();
          setQueuedSteers(steerQueueRef.current.map((item) => item.text));
          setBusy(true);
          setCancelPending(false);
          runIdRef.current = attached.runId;
          lastRunIdRef.current = attached.runId;
          partialTextRef.current = "";
          processedTextLenRef.current = 0;
          const lastStatusRef = { text: "" };
          for (const event of attached.events) consumeEventRef.current(event, placeholderId, lastStatusRef);
          subscribeRun(attached.runId, placeholderId, lastStatusRef);
        }).catch(() => undefined);
        return;
      }
      // Reconcile whenever THIS chat stops being active — not only when this
      // view owns the run. runIdRef is set only for runs this renderer itself
      // started, so a run begun by an automation, a schedule, the phone bridge,
      // another window, or one already in flight when the view opened left this
      // handler returning immediately: the answer sat in the database and the
      // screen kept showing the old state until the user navigated away and
      // back. Owner-reported 2026-08-03, across every session.
      if (!runIdRef.current && !wasActive) return;
      const endedRunId = runIdRef.current;
      runIdRef.current = null;
      subRef.current?.();
      subRef.current = null;
      setBusy(false);
      setCancelPending(false);
      setLiveAgents((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
      );
      // A run this view did not start has no runId here, so there is no receipt
      // to fetch — the history refetch below is what actually surfaces its
      // answer, and that is the whole point of reconciling those runs too.
      const receiptPromise =
        endedRunId && typeof api.invoke.receipt === "function"
          ? api.invoke.receipt(endedRunId).catch(() => null)
          : Promise.resolve(null);
      const historyRevision = transcriptRevisionRef.current;
      void Promise.all([
        api.invoke.history(chatId),
        receiptPromise,
        fetchCommittedReplies(api, chatId),
      ]).then(async ([h, receipt, committedReplies]) => {
        const ledgerEvents = receipt && receipt.status !== "running" && receipt.status !== "cancelling"
          ? await api.runLedger.events(receipt.runId, 500).catch(() => [])
          : [];
        const next = attachMcpStepsToLatestAgent(
          restoreAnsweredQuestions(h.map(historyEntryToStreamMessage), committedReplies),
          mcpStepsFromLedger(ledgerEvents),
        );
        const recovery = receiptRecoveryMessage(receipt, locale);
        const status = receiptRecoveryStatus(receipt, locale);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false, status }])),
        );
        setMessages((current) => {
          if (transcriptRevisionRef.current !== historyRevision) return current;
          const optimisticIds = new Set(steerQueueRef.current.map((item) => item.optimisticMessageId));
          return reconcileTranscriptSnapshot(current, next, recovery, optimisticIds);
        });
      });
    });
  }, [agent, chatId, locale, subscribeRun, t]);

  // 안전망 보강 (무한 '진행중' 방지) — onActiveChats 브로드캐스트를 놓치는 레이스(빠른/조기 종료 실행이
  // runId 설정·구독 전에 끝나 final/activeChats를 모두 놓친 경우)에 대비한다. busy 동안 main의 활성 실행
  // 목록을 주기적으로 확인해, 이 채팅의 실행이 이미 끝났으면(=답변은 DB에 영속화됨) 히스토리로 화해한다.
  useEffect(() => {
    if (!busy || !chatId) return;
    const api = ipc();
    if (!api) return;
    let stopped = false;
    const reconcile = async () => {
      if (stopped) return;
      // 탭 숨김 시 이 tick만 skip(타이머·escalation 유지) — 백그라운드 폴링 폭주 방지.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const ids = await api.invoke.activeChats();
        if (stopped || !runIdRef.current || ids.includes(chatId)) return;
        // main은 이 실행을 끝냈는데 UI는 여전히 진행중 → final/activeChats를 놓친 것. 화해.
        const endedRunId = runIdRef.current;
        runIdRef.current = null;
        lastRunIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
        setBusy(false);
        setCancelPending(false);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        const historyRevision = transcriptRevisionRef.current;
        const [h, receipt, committedReplies] = await Promise.all([
          api.invoke.history(chatId),
          endedRunId && typeof api.invoke.receipt === "function"
            ? api.invoke.receipt(endedRunId).catch(() => null)
            : Promise.resolve(null),
          fetchCommittedReplies(api, chatId),
        ]);
        const ledgerEvents = receipt && receipt.status !== "running" && receipt.status !== "cancelling"
          ? await api.runLedger.events(receipt.runId, 500).catch(() => [])
          : [];
        if (!stopped) {
          const next = attachMcpStepsToLatestAgent(
            restoreAnsweredQuestions(h.map(historyEntryToStreamMessage), committedReplies),
            mcpStepsFromLedger(ledgerEvents),
          );
          const recovery = receiptRecoveryMessage(receipt, locale);
          const status = receiptRecoveryStatus(receipt, locale);
          setLiveAgents((prev) =>
            Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false, status }])),
          );
          setMessages((current) => (
            transcriptRevisionRef.current === historyRevision
              ? reconcileTranscriptSnapshot(
                  current,
                  next,
                  recovery,
                  new Set(steerQueueRef.current.map((item) => item.optimisticMessageId)),
                )
              : current
          ));
        }
      } catch {
        /* 무시 — 다음 틱에 재시도 */
      }
    };
    const first = setTimeout(reconcile, 700);
    // 정상 주기를 2500→5000으로 상향(escalation 구조는 유지) — busy 중 폴링 부하 절감.
    const iv = setInterval(reconcile, 5000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [busy, chatId, locale]);

  // 활성 런타임이 바뀌면 모델 목록을 실시간 조회 (BYOK provider API / ollama / CLI 카탈로그).
  useEffect(() => {
    const api = ipc();
    if (!api || !activeRuntime) {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    void api.runtime
      .listModels({
        kind: activeRuntime.kind,
        backend: activeRuntime.backend,
        availableModels: activeRuntime.availableModels,
      })
      .then((opts) => {
        if (!cancelled) setModelOptions(opts);
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRuntime]);

  const requestRunCancellation = useCallback((runId: string) => {
    const api = ipc();
    const restoreRejectedCancellation = () => {
      const rollback = cancelRollbackSteersRef.current ?? [];
      const knownIds = new Set(rollback.map((item) => item.optimisticMessageId));
      const restored = [
        ...rollback,
        ...steerQueueRef.current.filter((item) => !knownIds.has(item.optimisticMessageId)),
      ];
      steerQueueRef.current = restored;
      setQueuedSteers(restored.map((item) => item.text));
      cancelRollbackSteersRef.current = null;
      cancelRequestedRef.current = false;
      setCancelPending(false);
      setSessionNotice(locale === "ko"
        ? "작업 중단 요청이 거절되었습니다. 실행과 대기 중 지시는 그대로입니다. 다시 시도해 주세요."
        : "The stop request was rejected. The run and queued directions are unchanged; try again.");
    };
    if (!api) {
      restoreRejectedCancellation();
      return;
    }
    void api.invoke.cancel(runId).then((receipt) => {
      if (
        receipt?.runId !== runId
        || (receipt.status !== "requested" && receipt.status !== "already-requested")
      ) {
        throw new Error("invoke_cancel_receipt_mismatch");
      }
      // Accepted cancellation settles only on the terminal event; keep the
      // stop-pending UI until that event arrives.
      cancelRollbackSteersRef.current = null;
    }).catch(restoreRejectedCancellation);
  }, [locale]);

  const send = useCallback(
    async (
      userPrompt: string,
      opts?: {
        images?: ImageAttachment[];
        files?: ChatFileDraft[];
        permissions?: PermissionLevel;
        planMode?: boolean;
        goalMode?: boolean;
        appsGenerateMode?: boolean;
        /** 추천 시트의 pipeline 픽이면 main에도 전달하고 에이전트 플레이스홀더 상단에 보여줄 단계 계획. */
        pipelineStages?: RecStage[];
        /** 추천 시트의 네트워크 픽이면 빌려올 Hub 에이전트 슬러그 — 백엔드가 hep-call 로 borrow. */
        borrowAgents?: string[];
        /** Exact temporary TF roster. It never rebinds the project or session controller. */
        taskForceTargets?: OrchestrationTarget[];
        /** Router Agent 에스컬레이션 — main 런타임이 시스템 프롬프트 앞에 주입한다. */
        routerAgent?: RecRouterAgent;
        /** Current session roster first; Agent Hub/Cloud only when the model identifies a capability gap. */
        sessionRouting?: boolean;
        stormbreakerMode?: boolean;
        /** Main-owned exact Decision continuation; never used by ordinary sends. */
        decisionContinuation?: { sourceMessageId: string; runId: string };
      },
    ) => {
      const api = ipc();
      const events = ipcEvents();
      if (
        !isCurrentChat() ||
        !api ||
        !events ||
        !chat ||
        chat.id !== chatId ||
        busy ||
        (requestedTaskId && validatedTaskChatId !== chat.id)
      ) return false;
      setCancelPending(false);
      if (opts?.goalMode && chat.goalId && !goalContext?.objective) {
        // Define exactly once, before the run. `defineGoal` returns the
        // existing active contract instead of overwriting it, so a later
        // steering turn can never become the goal by accident.
        const defined = await api.chats.defineGoal(chat.id, userPrompt, locale).catch(() => null);
        if (!isCurrentChat()) return false;
        if (defined) setGoalContext(defined);
      }
      let attachedChatFiles: ChatFileItem[] | undefined;
      let boundUserPrompt = userPrompt;
      if (opts?.files?.length) {
        const bridge = chatFilesBridge();
        if (!bridge) {
          setSessionNotice(locale === "ko" ? "Desktop 파일 연결을 사용할 수 없어 첨부를 보내지 않았습니다." : "The attachment was not sent because the Desktop file bridge is unavailable.");
          return false;
        }
        try {
          const snapshot = await bridge.snapshot({ chatId: chat.id, files: opts.files });
          if (!isCurrentChat()) return false;
          attachedChatFiles = snapshot.files.map((file) => chatFileItem(file, "user-attachment"));
          hydratedChatFileGroupsRef.current.set(snapshot.groupId, attachedChatFiles);
          boundUserPrompt = appendChatFileMarker(userPrompt, snapshot.groupId);
        } catch (cause) {
          if (!isCurrentChat()) return false;
          const detail = cause instanceof Error ? cause.message : String(cause);
          setSessionNotice(locale === "ko" ? `첨부를 보내지 않았습니다: ${detail}` : `The attachment was not sent: ${detail}`);
          return false;
        }
      }
      const routeInput = boundUserPrompt;
      const invocationPrompt = routeInput;
      const visiblePrompt = userPrompt;
      if (isPlaceholderTaskTitle(chat.title)) {
        const nextTitle = taskTitleFromFirstPrompt(visiblePrompt);
        if (nextTitle) {
          try {
            const renamed = await api.chats.rename(chat.id, nextTitle);
            if (!isCurrentChat()) return false;
            setChat(renamed);
            setTitleDraft(renamed.title);
            window.dispatchEvent(new Event("agentlas:tasks-changed"));
          } catch {
            // Work can still start; main retries the same deterministic title
            // from the durable first user message.
          }
        }
      }
      if (!isCurrentChat()) return false;
      const images = opts?.images;
      const placeholderId = uid();
      const imageDataUrls = images?.map(
        (img) => `data:${img.mediaType};base64,${img.data}`,
      );
      const startedAt = Date.now();
      const initialStatus = t("chat.status.sending");
      const activeAgentId = agent?.id ?? chat.agentId ?? "active-agent";
      const activeAgentName = agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback");
      // Saved project members are tools available to the orchestrator, not a forced
      // task force on every turn. Only an explicit one-turn @ override enters
      // taskForceTargets; the controller chooses actual WorkOrder slots.
      const effectiveTaskForceTargets: OrchestrationTarget[] = [];
      for (const target of opts?.taskForceTargets ?? []) {
        const duplicate = effectiveTaskForceTargets.some((candidate) => (
          candidate.source === target.source
          && candidate.entityKind === target.entityKind
          && (candidate.source === "local" && target.source === "local"
            ? candidate.entityKind === "agent" && target.entityKind === "agent"
              ? candidate.agentId === target.agentId
              : candidate.entityKind === "team" && target.entityKind === "team"
                ? candidate.firmId === target.firmId
                : false
            : candidate.source !== "local" && target.source !== "local"
              ? candidate.slug === target.slug
              : false)
        ));
        if (!duplicate) effectiveTaskForceTargets.push(target);
      }
      transcriptRevisionRef.current += 1;
      const userMessageId = uid();
      setMessages((m) => [
        ...m,
        { id: userMessageId, role: "user" as const, text: visiblePrompt, imageDataUrls, chatFiles: attachedChatFiles },
        {
          id: placeholderId,
          role: "agent",
          text: "",
          busy: true,
          startedAt,
          pipeline: opts?.pipelineStages?.map((stage) => ({
            order: stage.order,
            kind: stage.kind,
            agentId: stage.agentId,
            agentName: stage.agentName ?? stage.agentId,
            produces: stage.produces,
            consumes: stage.consumes,
            status: "pending" as const,
          })),
          steps: [
            {
              id: uid(),
              kind: "thinking",
              text: initialStatus,
              agentName: activeAgentName,
              activity: "start",
              createdAt: startedAt,
            },
          ],
        },
      ]);
      setBusy(true);
      setCancelPending(false);
      const effectiveBorrowAgents =
        effectiveTaskForceTargets.length > 0
          ? undefined
          : (opts?.borrowAgents?.length ?? 0) > 0
          ? opts?.borrowAgents
          : undefined;
      if ((effectiveBorrowAgents?.length ?? 0) > 0 || effectiveTaskForceTargets.length > 0 || (opts?.pipelineStages?.length ?? 0) > 1) {
        setNetworkOpenPersisted(true);
      }
      cancelRequestedRef.current = false;
      setLiveAgents({
        [activeAgentId]: {
          name: activeAgentName,
          role: "",
          tier: 1,
          active: true,
          status: initialStatus,
        },
      });
      setNetTimeline([
        {
          key: uid(),
          agentId: activeAgentId,
          name: activeAgentName,
          role: "",
          tier: 1,
          kind: "status",
          text: initialStatus,
        },
      ]);

      // runId를 렌더러가 먼저 생성하고 invoke 왕복 전에 구독한다(subscribe-before-trigger) —
      // 런타임이 즉시 emit하는 초기 이벤트도 절대 놓치지 않아 스트리밍/최종 답변이 라이브로 뜬다.
      const runId = opts?.decisionContinuation?.runId ?? crypto.randomUUID();
      runIdRef.current = runId;
      lastRunIdRef.current = runId;
      partialTextRef.current = "";
      processedTextLenRef.current = 0;
      // 지난 실행이 띄운 서버 주소가 이번 답에 딸려 열리지 않게 비운다.
      runServerUrlsRef.current = [];
      // 이벤트 처리는 consumeEvent로 추출됨 — 재접속(attach) 경로와 동일 로직 공유.
      subscribeRun(runId, placeholderId);
      try {
        if (opts?.decisionContinuation) {
          const continuationInput = {
            chatId: chat.id,
            sourceMessageId: opts.decisionContinuation.sourceMessageId,
            reply: invocationPrompt,
          };
          let continued;
          try {
            continued = await api.confirm.continueAnswer(continuationInput);
          } catch {
            if (!isCurrentChat()) return false;
            // One response-loss reconciliation only. Main owns the stable run
            // id/hash, so this cannot mint a second execution.
            continued = await api.confirm.continueAnswer(continuationInput).catch(() => null);
            if (!isCurrentChat()) return false;
            if (!continued) {
              continuationTransportRetryableRef.current.add(runId);
              throw new Error("decision_continuation_transport_unavailable");
            }
          }
          if (!isCurrentChat()) return false;
          if (!continued || continued.runId !== runId || continued.status === "rejected") {
            continuationTransportRetryableRef.current.delete(runId);
            throw new Error(continued?.reasonCode ?? "decision_continuation_rejected");
          }
          continuationTransportRetryableRef.current.delete(runId);
          if (continued.status === "already-terminal") {
            subRef.current?.();
            subRef.current = null;
            setMessages((messages) => messages.filter((message) => (
              message.id !== userMessageId && message.id !== placeholderId
            )));
            setBusy(false);
            setCancelPending(false);
            runIdRef.current = null;
            lastRunIdRef.current = runId;
            setSessionNotice(locale === "ko"
              ? `답변은 이미 전달됐으며 후속 실행은 ${continued.runStatus ?? "종료"} 상태입니다. 자동으로 다시 실행하지 않았습니다.`
              : `The answer was already delivered and its follow-up is ${continued.runStatus ?? "settled"}. It was not run again automatically.`);
            return true;
          }
        } else {
          // locale을 동봉 — main이 emit하는 상태/오류 메시지가 사용자 언어로 나오도록.
          await api.invoke.run({
            runId,
            chatId: chat.id,
            userPrompt: invocationPrompt,
            images,
            locale,
            permissions: opts?.permissions ?? DEFAULT_PERMISSION,
            planMode: opts?.planMode,
            goalMode: opts?.goalMode,
            appsGenerateMode: opts?.appsGenerateMode,
            borrowAgents: effectiveBorrowAgents,
            taskForceTargets: effectiveTaskForceTargets.length > 0 ? effectiveTaskForceTargets : undefined,
            pipelineStages: opts?.pipelineStages,
            routerAgent: opts?.routerAgent,
            // Project Work is orchestrated by default: attached tools first,
            // Network recruitment only for a real capability/tool gap.
            sessionRouting: project ? true : opts?.sessionRouting,
            stormbreakerMode: opts?.stormbreakerMode,
            runtimeSelection: chat.runtimeSelection ?? undefined,
          });
        }
        if (!isCurrentChat()) return false;
        // runId 도착 전에 Stop을 눌렀다면(레이스) 구독을 건 직후 즉시 취소 — abort 종료 이벤트를 수신해 busy 해제.
        if (cancelRequestedRef.current) requestRunCancellation(runId);
        return true;
      } catch {
        if (!isCurrentChat()) return false;
        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.
        subRef.current?.();
        subRef.current = null;
        if (opts?.decisionContinuation) {
          // Main rejected the continuation or its transport was unavailable.
          // Keep the durable Decision card as the only retry surface; an
          // optimistic user row here would look like a second accepted answer.
          setMessages((messages) => messages.filter((message) => (
            message.id !== userMessageId && message.id !== placeholderId
          )));
          setBusy(false);
          setCancelPending(false);
          runIdRef.current = null;
          lastRunIdRef.current = runId;
          return false;
        }
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  id: msg.id,
                  role: "system",
                  text: locale === "ko"
                    ? "작업을 시작하지 못했습니다. 입력 내용은 보존되었습니다. 실행 환경을 확인한 뒤 다시 시도해 주세요."
                    : "The task did not start. Your input was preserved. Check the runtime and try again.",
                }
              : msg,
          ),
        );
        setBusy(false);
        setCancelPending(false);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
        lastRunIdRef.current = null;
        cancelRequestedRef.current = false;
        return false;
      }
    },
    [
      agent,
      allAgents,
      allGeneratedApps,
      chat,
      chatId,
      isCurrentChat,
      busy,
      goalContext?.objective,
      locale,
      project,
      requestedTaskId,
      router,
      setNetworkOpenPersisted,
      subscribeRun,
      t,
      validatedTaskChatId,
      requestRunCancellation,
    ],
  );

  // 진행 중 실행 취소 — 입력창의 정지 버튼(전송 버튼이 busy일 때 변신) / Cmd/Ctrl+Esc.
  const stop = useCallback(() => {
    const api = ipc();
    if (cancelRequestedRef.current) return;
    if (!api) {
      setSessionNotice(locale === "ko"
        ? "Desktop에 연결되지 않아 작업을 멈추지 못했습니다. 실행은 계속되고 있습니다."
        : "The work could not be stopped because Desktop is unavailable. The run is still active.");
      return;
    }
    setCancelPending(true);
    cancelRequestedRef.current = true;
    // 정지 = 인플라이트 전부 취소. 대기 중이던 steering 메시지도 비워 busy→false 시 자동
    // 발사되지 않게 한다(정지했는데 큐가 알아서 날아가던 버그).
    cancelRollbackSteersRef.current = steerQueueRef.current.slice();
    steerQueueRef.current = [];
    setQueuedSteers([]);
    // runId가 아직 안 왔으면(invoke:run 왕복 중) 취소 의사만 기록 → 도착 즉시 취소된다.
    const runId = runIdRef.current ?? lastRunIdRef.current;
    if (!runId) return;
    requestRunCancellation(runId);
  }, [locale, requestRunCancellation]);

  // 실행 중 steering — 사용자의 새 지시는 즉시 대화에 보이지만 현재 모델 턴을
  // 취소하지 않는다. Main이 현재 턴의 terminal settlement를 확인한 뒤 같은 세션의
  // 다음 run으로 순서대로 시작한다.
  const submitOrQueue = useCallback(
    (text: string, opts?: (typeof steerQueueRef)["current"][number]["opts"]) => {
      if (busy) {
        const api = ipc();
        if (!api || !chat) return;
        const optimisticMessageId = `steer:${uid()}`;
        void (async () => {
          let boundText = text;
          let attachedChatFiles: ChatFileItem[] | undefined;
          if (opts?.files?.length) {
            const bridge = chatFilesBridge();
            if (!bridge) throw new Error(locale === "ko" ? "Desktop 파일 연결을 사용할 수 없습니다." : "The Desktop file bridge is unavailable.");
            const snapshot = await bridge.snapshot({ chatId: chat.id, files: opts.files });
            attachedChatFiles = snapshot.files.map((file) => chatFileItem(file, "user-attachment"));
            hydratedChatFileGroupsRef.current.set(snapshot.groupId, attachedChatFiles);
            boundText = appendChatFileMarker(text, snapshot.groupId);
          }
          steerQueueRef.current.push({ text: boundText, opts, optimisticMessageId });
          setQueuedSteers(steerQueueRef.current.map((q) => parseChatFileMessage(q.text).visibleText));
          transcriptRevisionRef.current += 1;
          setMessages((current) => [...current, {
            id: optimisticMessageId,
            role: "user",
            text,
            imageDataUrls: opts?.images?.map((image) => `data:${image.mediaType};base64,${image.data}`),
            chatFiles: attachedChatFiles,
          }]);
          await api.invoke.steer({
            chatId: chat.id,
            userPrompt: boundText,
            steeringMode: "interrupt",
            images: opts?.images,
            locale,
            permissions: opts?.permissions ?? DEFAULT_PERMISSION,
            planMode: opts?.planMode,
            goalMode: opts?.goalMode,
            appsGenerateMode: opts?.appsGenerateMode,
            taskForceTargets: opts?.taskForceTargets,
            sessionRouting: project ? true : opts?.sessionRouting,
            stormbreakerMode: opts?.stormbreakerMode,
            runtimeSelection: chat.runtimeSelection ?? undefined,
          });
        })().catch((cause) => {
          steerQueueRef.current = steerQueueRef.current.filter((item) => item.optimisticMessageId !== optimisticMessageId);
          setQueuedSteers(steerQueueRef.current.map((item) => item.text));
          setMessages((current) => current.map((message) => message.id === optimisticMessageId
            ? { id: message.id, role: "system", text: locale === "ko" ? "방향 전환을 전달하지 못했습니다. 다시 보내 주세요." : "The new direction was not delivered. Please send it again." }
            : message));
          setSessionNotice(cause instanceof Error ? cause.message : String(cause));
        });
        return;
      }
      void send(text, opts);
    },
    [busy, chat, locale, project, send],
  );

  // 이 채팅의 모델/작업량만 변경한다. 역할 기본값과 다른 채팅은 건드리지 않는다.
  // model === "" 은 해당 런타임이 모델 결정을 소유할 때만 엔진 설정을 사용한다.
  async function applySelection(patch: { model?: string; effort?: string }) {
    const api = ipc();
    if (!api || !activeRuntime || !chat) return;
    const selection: RuntimeSelection = {
      kind: activeRuntime.kind,
      backend: activeRuntime.backend,
      // source(=CLI 실행 파일의 절대경로)는 일부러 저장하지 않는다. detect()는 (kind, backend)
      // 조합마다 런타임을 최대 1개만 만들므로 source는 식별에 아무 것도 더해주지 않는 반면,
      // CLI를 업그레이드/재설치하면 경로가 바뀌어 exact pin이 영구히 안 맞게 된다
      // (→ 매 전송 "Pinned automation runtime is unavailable", 칩도 사라져 되돌릴 수 없음).
      // 이 제스처의 의도는 "이 채팅에서 이 모델을 쓴다"이지 "이 바이너리 경로에 영구 결박"이 아니다.
      model: patch.model !== undefined ? patch.model || undefined : activeRuntime.model ?? undefined,
      longContext:
        activeRuntime.kind === "byok" ? (activeRuntime.longContextEnabled ?? false) : undefined,
      effort:
        patch.effort !== undefined
          ? patch.effort || undefined
          : activeRuntime.effort ?? undefined,
      role: "orchestrator",
      inherit: false,
    };
    try {
      const updated = await api.chats.setRuntimeSelection(chat.id, selection);
      if (
        !updated
        || updated.id !== chat.id
        || !runtimeSelectionReceiptMatches(selection, updated.runtimeSelection)
      ) {
        throw new Error("Desktop did not acknowledge the exact task runtime selection");
      }
      setChat(updated);
      setActiveRuntime({
        ...activeRuntime,
        model: selection.model ?? null,
        effort: selection.effort ?? null,
        longContextEnabled: selection.longContext,
      });
      setSessionNotice(null);
    } catch {
      setSessionNotice(
        locale === "ko"
          ? "이 작업의 모델 선택을 저장하지 못했습니다. 기존 선택은 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요."
          : "The model selection was not saved for this task, so the previous selection remains. Check the connection and try again.",
      );
    }
  }
  const switchModel = (model: string) => void applySelection({ model });
  const switchEffort = (effort: string) => void applySelection({ effort });

  /**
   * 에이전트가 emit한 질문(<<agentlas-ask>>) 묶음에 사용자가 답함 — 바텀 시트에서 전부 답하고
   * 한 번에 전송한다. (예전: 질문 하나 답할 때마다 그 라벨이 즉시 user 프롬프트로 전송돼
   * 질문이 꼬리를 물었다 — 그 per-question 자동 전송은 폐기.)
   * 시트에서 안 고른 질문도 잠금("—")해 시트가 다시 뜨지 않게 한다.
   */
  const answerQuestionBatch = useCallback(
    async (messageId: string, sourceMessageId: string, reply: string, perQuestion: QuestionSheetAnswer[]) => {
      if (!isCurrentChat() || busy || questionCommitPendingRef.current) return;
      const api = ipc();
      if (!api?.confirm?.commitAnswer) {
        setSessionNotice(locale === "ko"
          ? "Desktop에 연결되지 않아 답변을 저장하지 못했습니다. 입력은 그대로 유지됩니다."
          : "The answer was not saved because Desktop is unavailable. Your input is unchanged.");
        return;
      }
      questionCommitPendingRef.current = messageId;
      setQuestionCommitPending(true);
      setSessionNotice(null);
      const perms = perQuestion.map((p) => inferPermissionFromAnswer(p.answers)).find(Boolean);
      try {
        let receipt: { chatId: string; sourceMessageId: string; continuationRunId: string } | null = null;
        try {
          // The exact current question must be durably accepted before either the
          // answered UI or the follow-up run changes. A stale/mismatched receipt
          // leaves the sheet and every typed answer intact.
          receipt = await api.confirm.commitAnswer({
            chatId,
            reply,
            sourceMessageId,
            continuation: {
              locale,
              permissions: perms ?? DEFAULT_PERMISSION,
              sessionRouting: project ? true : undefined,
              runtimeSelection: chat?.runtimeSelection ?? undefined,
            },
          });
          if (!receipt || receipt.chatId !== chatId || receipt.sourceMessageId !== sourceMessageId
            || typeof receipt.continuationRunId !== "string" || !receipt.continuationRunId.trim()) {
            throw new Error("question_commit_receipt_mismatch");
          }
        } catch {
          if (!isCurrentChat()) return;
          // IPC can lose its response after Main commits. Recover only the
          // exact same source+reply+Main run binding; never infer acceptance.
          let rows: Awaited<ReturnType<typeof api.confirm.committedAnswers>> = [];
          try {
            rows = await api.confirm.committedAnswers?.(chatId) ?? [];
          } catch { /* Missing or unavailable recovery keeps the editable draft. */ }
          if (!isCurrentChat()) return;
          const recovered = (Array.isArray(rows) ? rows : [])
            .find((item) => item && item.sourceMessageId === sourceMessageId
              // Main already scopes these rows by chat; its real shape has no
              // chatId. Reject only an explicitly contradictory bridge field.
              && (!("chatId" in item) || item.chatId === chatId)
              && item.reply === reply.trim()
              && typeof item.continuationRunId === "string" && Boolean(item.continuationRunId.trim()));
          if (recovered?.continuationRunId) {
            receipt = { chatId, sourceMessageId, continuationRunId: recovered.continuationRunId };
          } else {
            setSessionNotice(locale === "ko"
              ? "이 질문의 답변을 저장하지 못했습니다. 질문과 입력은 그대로이므로 다시 시도해 주세요."
              : "The answer was not saved for this exact question. The question and your input are unchanged; try again.");
            return;
          }
        }
        window.dispatchEvent(new Event("agentlas:attention-refresh"));
        if (!isCurrentChat()) return;
        const sent = await send(reply, {
          permissions: perms ?? DEFAULT_PERMISSION,
          decisionContinuation: {
            sourceMessageId,
            runId: receipt.continuationRunId,
          },
        }).catch(() => false);
        if (!isCurrentChat()) return;
        if (!sent) {
          const retryable = receipt?.continuationRunId
            ? continuationTransportRetryableRef.current.has(receipt.continuationRunId)
            : false;
          setMessages((messages) => messages.map((message) => message.id === messageId
            ? {
                ...message,
                pendingCommittedReply: reply,
                pendingContinuationRunId: receipt?.continuationRunId,
                pendingContinuationAutoResume: retryable,
              }
            : message));
          setSessionNotice(retryable
            ? (locale === "ko"
              ? "답변은 안전하게 저장됐습니다. 연결이 복구되면 같은 실행으로 자동 재개합니다."
              : "Your answer is safely saved. It will resume with the same run when the connection recovers.")
            : (locale === "ko"
              ? "답변은 안전하게 저장됐지만 후속 실행은 시작되지 않았습니다. 자동으로 다시 실행하지 않았습니다."
              : "Your answer is safely saved, but the follow-up did not start. It was not run again automatically."));
          return;
        }
        setMessages((m) =>
          m.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  pendingCommittedReply: undefined,
                  pendingContinuationRunId: undefined,
                  pendingContinuationAutoResume: undefined,
                  questions: msg.questions?.map((q) => {
                    const hit = perQuestion.find((p) => p.questionId === q.id);
                    if (hit && hit.answers.length) return { ...q, answer: hit.answers };
                    return q.answer && q.answer.length ? q : { ...q, answer: ["—"] };
                  }),
                }
              : msg,
          ),
        );
      } finally {
        if (isCurrentChat() && questionCommitPendingRef.current === messageId) {
          questionCommitPendingRef.current = null;
          setQuestionCommitPending(false);
        }
      }
    },
    // send는 동일 useCallback에 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, chat, chatId, isCurrentChat, locale, project, send],
  );

  /** 질문 시트 × 닫기 — 이 배치의 미답 질문을 잠가("—") 시트를 접는다. 전송 없음. */
  const dismissQuestionBatch = useCallback((messageId: string) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              questions: msg.questions?.map((q) =>
                q.answer && q.answer.length ? q : { ...q, answer: ["—"] },
              ),
            }
          : msg,
      ),
    );
  }, []);

  // 바텀 시트에 올릴 질문 묶음 — 가장 최근에 질문을 낸 어시스턴트 메시지 하나만 본다.
  // (더 오래된 미답 질문은 stale — 대화가 이미 지나갔으므로 다시 묻지 않는다.)
  const pendingQuestionSheet = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "agent" && m.questions && m.questions.length > 0) {
        const unanswered = m.questions.filter((q) => !q.answer || q.answer.length === 0);
        return unanswered.length > 0
          ? {
              messageId: m.id,
              sourceMessageId: m.questionSourceMessageId ?? m.id,
              questions: unanswered,
              initialReply: m.pendingCommittedReply,
              continuationRunId: m.pendingContinuationRunId,
              autoResume: m.pendingContinuationAutoResume,
            }
          : null;
      }
    }
    return null;
  }, [messages]);

  // Both automatic reconciliation and explicit Retry use the accepted bytes
  // and Main-owned run. Neither path commits or parses a new answer.
  const resumeCommittedQuestion = useCallback(async () => {
    const sheet = pendingQuestionSheet;
    const reply = sheet?.initialReply;
    const continuationRunId = sheet?.continuationRunId;
    if (!isCurrentChat() || !sheet || !reply?.trim() || !continuationRunId?.trim() || busy || questionCommitPendingRef.current) return;
    questionCommitPendingRef.current = sheet.messageId;
    setQuestionCommitPending(true);
    const key = `${chatId}\0${sheet.sourceMessageId}\0${continuationRunId}`;
    continuationResumeAttemptsRef.current.add(key);
    try {
      const resumed = await send(reply, {
        decisionContinuation: {
          sourceMessageId: sheet.sourceMessageId,
          runId: continuationRunId,
        },
      }).catch(() => false);
      if (!isCurrentChat()) return;
      if (!resumed) {
        const retryable = continuationTransportRetryableRef.current.has(continuationRunId);
        setMessages((messages) => messages.map((message) => message.id === sheet.messageId
          ? { ...message, pendingContinuationAutoResume: retryable }
          : message));
        setSessionNotice(retryable
          ? (locale === "ko"
            ? "저장된 답변의 연결이 아직 복구되지 않았습니다. 연결 복구 시 같은 실행으로 한 번 더 확인합니다."
            : "The saved answer is still offline. It will reconcile once more with the same run after reconnection.")
          : (locale === "ko"
            ? "저장된 답변의 후속 실행은 시작되지 않았습니다. 자동으로 다시 실행하지 않았습니다."
            : "The saved answer's follow-up did not start. It was not run again automatically."));
        return;
      }
      setMessages((messages) => messages.map((message) => {
        if (message.id !== sheet.messageId) return message;
        return {
          ...message,
          pendingCommittedReply: undefined,
          pendingContinuationRunId: undefined,
          pendingContinuationAutoResume: undefined,
          questions: message.questions?.map((question) => question.answer?.length
            ? question : { ...question, answer: ["✓"] }),
        };
      }));
    } finally {
      if (isCurrentChat() && questionCommitPendingRef.current === sheet.messageId) {
        questionCommitPendingRef.current = null;
        setQuestionCommitPending(false);
      }
    }
  }, [busy, chatId, isCurrentChat, locale, pendingQuestionSheet, send]);

  useEffect(() => {
    const sheet = pendingQuestionSheet;
    if (!sheet?.initialReply?.trim() || !sheet.continuationRunId || sheet.autoResume === false || busy || questionCommitPending) return;
    const key = `${chatId}\0${sheet.sourceMessageId}\0${sheet.continuationRunId}`;
    if (continuationResumeAttemptsRef.current.has(key)) return;
    void resumeCommittedQuestion();
  }, [busy, chatId, continuationReconnectEpoch, pendingQuestionSheet, questionCommitPending, resumeCommittedQuestion]);

  const handleSurfaceAction = useCallback(
    async (activeSurface: WorkbenchSurface, action: AgentlasSurfaceAction) => {
      const api = ipc();
      const manifest = activeSurface.manifest;
      if (action.type === "external-link" && action.url) {
        const preview = workspacePreviewFromBrowserUrl(action.url);
        if (preview) void openWorkspaceFilePreview(preview);
        return;
      }
      if (action.type === "copy") {
        void navigator.clipboard.writeText(action.prompt || JSON.stringify(manifest, null, 2));
        return;
      }
      if (
        action.type === "scaffold-agent-team" ||
        action.type === "scaffold-app" ||
        action.type === "operate-app" ||
        action.type === "install-mcp" ||
        action.type === "run-smoke-test" ||
        action.type === "deploy-preview" ||
        action.type === "scaffold-tool" ||
        action.type === "run-tool-smoke" ||
        action.type === "install-tool-mcp" ||
        action.type === "materialize-asset-pack"
      ) {
        if (!api) return;
        const approval = surfaceApprovalRequirement(activeSurface, action);
        if (approval && !(await ensureSurfaceApproval(api, activeSurface.id, action, approval, locale))) return;
        const pendingId = uid();
        const label = manifest.app?.name || manifest.title;
        setMessages((m) => [
          ...m,
          {
            id: pendingId,
            role: "system",
            text: `${action.label} started for ${label}...`,
          },
        ]);
        const update = (text: string) => {
          setMessages((m) =>
            m.map((msg) => (msg.id === pendingId ? { ...msg, text } : msg)),
          );
        };
        const ensureTool = async () => {
          const key = surfaceToolKey(activeSurface.id, action);
          const existing = scaffoldedTools[key];
          if (existing) return existing;
          if (!chatId) throw new Error("Chat id is required to scaffold an Agentlas tool.");
          const requestedToolId = typeof action.toolId === "string" ? action.toolId : undefined;
          const persisted = await api.toolFactory.getToolBySurface(
            chatId,
            activeSurface.id,
            requestedToolId,
          );
          if (persisted) {
            const restored = toolResultFromRecord(persisted);
            setScaffoldedTools((prev) => ({ ...prev, [key]: restored }));
            return restored;
          }
          const result = await api.toolFactory.scaffold({
            chatId,
            surfaceId: activeSurface.id,
            actionId: action.id,
            toolId: requestedToolId,
            manifest,
          });
          setScaffoldedTools((prev) => ({ ...prev, [key]: result }));
          return result;
        };
        const ensureScaffold = async () => {
          const existing = scaffoldedApps[activeSurface.id];
          if (existing) return existing;
          if (!chatId) throw new Error("Chat id is required to register an Agentlas app.");
          const persisted = await api.appFactory.getAppBySurface(chatId, activeSurface.id);
          if (persisted) {
            const restored = scaffoldResultFromRecord(persisted);
            setScaffoldedApps((prev) => ({ ...prev, [activeSurface.id]: restored }));
            setAllGeneratedApps((apps) => [persisted, ...apps.filter((app) => app.id !== persisted.id)]);
            return restored;
          }
          const result = await api.appFactory.scaffold({
            chatId,
            surfaceId: activeSurface.id,
            actionId: action.id,
            manifest,
          });
          setScaffoldedApps((prev) => ({ ...prev, [activeSurface.id]: result }));
          const record = result.record;
          if (record) {
            setAllGeneratedApps((apps) => [record, ...apps.filter((app) => app.id !== record.id)]);
          }
          return result;
        };
        try {
          if (action.type === "scaffold-agent-team") {
            if (!chatId) throw new Error("Chat id is required to create an Agentlas agent team.");
            const result = await api.metaAgent.createCommerceTeam({
              chatId,
              surfaceId: activeSurface.id,
              manifest,
            });
            update(
              [
                `Agent team ready: ${result.firm.name}`,
                "",
                `Root: ${result.rootPath}`,
                `Agent: ${result.agent.slug}`,
                `Firm: ${result.firm.slug}`,
                `Divisions: ${result.org.divisions.length}`,
                `Files: ${result.files.length}`,
              ].join("\n"),
            );
            setWorkspaceOpenPersisted(true);
            setFolderReload((n) => n + 1);
            return;
          }
          if (action.type === "materialize-asset-pack") {
            if (!chatId) throw new Error("Chat id is required to materialize an Agentlas asset pack.");
            const result = await api.surfaceAssets.materialize({
              chatId,
              surfaceId: activeSurface.id,
              actionId: action.id,
              manifest,
            });
            update(
              [
                `Asset pack ready: ${result.packName}`,
                "",
                `Root: ${result.rootPath}`,
                `Index: ${result.indexPath}`,
                `Manifest: ${result.manifestPath}`,
                `Assets: ${result.assetsPath}`,
                `Open: ${result.fileUrl}`,
                "",
                result.summary,
              ].join("\n"),
            );
            // The generated index is a real HTML output. Keep it in the same
            // BrowserWindow and hydrate it through the existing browser viewer
            // instead of handing it to Finder/Chrome.
            void openWorkspaceFilePreview(workspacePreviewFromLocalFile(result.indexPath));
            setFolderReload((n) => n + 1);
            return;
          }
          if (
            action.type === "scaffold-tool" ||
            action.type === "run-tool-smoke" ||
            action.type === "install-tool-mcp"
          ) {
            const tool = await ensureTool();
            if (action.type === "scaffold-tool") {
              update(
                [
                  `Tool scaffold ready: ${tool.toolName}`,
                  "",
                  `Root: ${tool.rootPath}`,
                  `Runtime: ${tool.toolPath}`,
                  `MCP: ${tool.mcpPath}`,
                  `Check script: ${tool.smokePath}`,
                  "",
                  tool.summary,
                ].join("\n"),
              );
            } else if (action.type === "run-tool-smoke") {
              const result = await api.toolFactory.runSmoke({ rootPath: tool.rootPath });
              update(
                [
                  result.ok ? `Tool check passed: ${tool.toolName}` : `Tool check failed without changing files: ${tool.toolName}`,
                  "",
                  `Command: ${result.command}`,
                  `Exit: ${result.exitCode ?? "unknown"}`,
                  result.stdout.trim() ? `Stdout:\n${result.stdout.trim()}` : "",
                  result.stderr.trim() ? `Stderr:\n${result.stderr.trim()}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              );
            } else {
              const result = await api.toolFactory.installMcp({ rootPath: tool.rootPath });
              update(
                [
                  `Tool MCP installed: ${tool.toolName}`,
                  "",
                  `Server: ${result.server.name}`,
                  `Command: ${result.command}`,
                  `Args: ${result.args.join(" ")}`,
                  `MCP: ${result.mcpPath}`,
                ].join("\n"),
              );
            }
            setWorkspaceOpenPersisted(true);
            setFolderReload((n) => n + 1);
            return;
          }
          const scaffold = await ensureScaffold();
          const launchUrl = scaffold.launchUrl || scaffold.previewPath;
          const devCommand = scaffold.devCommand || "node scripts/serve.mjs";
          if (action.type === "scaffold-app") {
            update(
              [
                `App scaffold ready: ${scaffold.appName}`,
                "",
                `Run: ${devCommand}`,
                `Open local app: ${launchUrl}`,
                `Setup: ${scaffold.setupPath}`,
                `Check script: ${scaffold.smokePath}`,
                "",
                scaffold.summary,
              ].join("\n"),
            );
          } else if (action.type === "operate-app") {
            const result = await api.appFactory.runAutopilot({
              rootPath: scaffold.rootPath,
              budgetApproved: true,
              approvedBy: "agentlas-chat-user",
              approvalReason: `Approved surface action: ${action.label}`,
              credentialSource: "agentlas-env-vault",
              captureProviderSessions: false,
              browserMode: "plan-only",
            });
            update(
              [
                `Agentlas OS operated: ${scaffold.appName}`,
                "",
                result.summary,
                `Status: ${result.status}`,
                `Steps: ${result.steps.filter((step) => step.status === "completed").length}/${result.steps.length}`,
                result.waitingOn.length ? `Waiting: ${result.waitingOn.join(", ")}` : "Waiting: none",
                `Open local app: ${launchUrl}`,
                result.appTool ? `Tool: ${result.appTool.toolName}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          } else if (action.type === "install-mcp") {
            const result = await api.appFactory.installMcpPlan({ rootPath: scaffold.rootPath });
            update(
              [
                `MCP adapter plan ready: ${scaffold.appName}`,
                "",
                `Config: ${result.configPath}`,
                `Env: ${result.envPath}`,
                `Adapters: ${result.adapters.length}`,
                result.missingCredentials.length
                  ? `Missing credentials: ${result.missingCredentials.join(", ")}`
                  : "Missing credentials: none",
              ].join("\n"),
            );
          } else if (action.type === "run-smoke-test") {
            const result = await api.appFactory.runSmoke({ rootPath: scaffold.rootPath });
            update(
              [
                result.ok ? `App check passed: ${scaffold.appName}` : `App check failed without changing files: ${scaffold.appName}`,
                "",
                `Command: ${result.command}`,
                `Exit: ${result.exitCode ?? "unknown"}`,
                result.stdout.trim() ? `Stdout:\n${result.stdout.trim()}` : "",
                result.stderr.trim() ? `Stderr:\n${result.stderr.trim()}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          } else if (action.type === "deploy-preview") {
            const result = await api.appFactory.preparePreview({ rootPath: scaffold.rootPath });
            update(
              [
                `Preview deploy package ready: ${scaffold.appName}`,
                "",
                `Dist: ${result.deployPath}`,
                `Preview: ${result.previewPath}`,
                `Manifest: ${result.manifestPath}`,
                `Open: ${result.fileUrl}`,
                `Serve: ${result.serveCommand}`,
              ].join("\n"),
            );
          }
          setWorkspaceOpenPersisted(true);
          setFolderReload((n) => n + 1);
        } catch (err: unknown) {
          update(locale === "ko" ? "이 작업을 완료하지 못했습니다." : "This action was not completed.");
          throw err;
        }
        return;
      }

      const launchPrompt =
        action.prompt ||
        [
          `Continue building the Agentlas app surface "${manifest.title}".`,
          `Action: ${action.label} (${action.type}).`,
          "Turn this into the next concrete product artifact: screens, connectors, files, tests, and launch proof.",
        ].join("\n");

      const approval = api ? surfaceApprovalRequirement(activeSurface, action) : null;
      if (api && approval && !(await ensureSurfaceApproval(api, activeSurface.id, action, approval, locale))) return;

      const launched = await send(launchPrompt, {
        permissions: action.permission === "full" ? "full" : action.permission === "read" ? "read" : "write",
      });
      if (!launched) {
        setMessages((m) => [
          ...m,
          {
            id: uid(),
            role: "system",
            text:
              locale === "ko"
                ? `⚠️ ${action.label} 실행을 시작하지 못했습니다. 현재 다른 실행이 끝난 뒤 다시 눌러주세요.`
                : `⚠️ ${action.label} could not start. Try again after the current run finishes.`,
          },
        ]);
      }
    },
    [chatId, locale, scaffoldedApps, scaffoldedTools, send, setWorkspaceOpenPersisted],
  );

  const handleSurfaceStatePatch = useCallback<SurfaceStatePatchHandler>((activeSurface, patch) => {
    const api = ipc();
    if (!api) return;
    void api.surfaces
      .updateState({
        surfaceId: activeSurface.id,
        ...patch,
        actor: patch.actor || "user",
      })
      .then((record) => {
        setSurface((cur) =>
          cur?.id === record.id
            ? {
                id: record.id,
                manifest: record.manifest,
                state: record.state,
                jobSummary: record.jobSummary,
              }
            : cur,
        );
      })
      .catch(() => {
        setMessages((m) => [
          ...m,
          {
            id: uid(),
            role: "system",
            text: locale === "ko" ? "화면 상태를 저장하지 못했습니다." : "The surface state was not saved.",
          },
        ]);
      });
  }, []);

  const handleSessionAction = useCallback(
    (action: "new" | "clear") => {
      const api = ipc();
      if (!chat) return;
      if (!api) {
        setSessionNotice(locale === "ko"
          ? "Desktop에 연결되지 않아 세션 작업을 수행하지 못했습니다. 현재 대화는 그대로 유지됩니다."
          : "The session action could not run because Desktop is unavailable. This conversation is unchanged.");
        return;
      }
      if (action === "clear") {
        if (busy) {
          setSessionNotice(locale === "ko" ? "실행 중인 대화는 비울 수 없습니다. 먼저 실행을 멈춰 주세요." : "You cannot clear while this run is active. Stop it first.");
          return;
        }
        // clear 요청이 main에서 판정되는 동안에도 stale steering/recap이 다시
        // 발사되지 않게 renderer projection을 먼저 무효화한다.
        steerQueueRef.current = [];
        setQueuedSteers([]);
        cancelRequestedRef.current = false;
        setCancelPending(false);
        recapGenerationRef.current += 1;
        setRecap(null);
        void api.invoke.clearHistory(chat.id).then(() => {
          setMessages([]);
          setLiveAgents({});
          setNetTimeline([]);
          setArtifact(null);
          setSurface(null);
          setMediaPreview(null);
          dropChatViewSnapshot(chat.id);
          setSessionNotice(locale === "ko" ? "대화 기록과 연결된 런타임 세션을 비웠습니다." : "Conversation history and its linked runtime session were cleared.");
        }).catch(() => {
          setSessionNotice(locale === "ko" ? "세션 기록을 비우지 못했습니다." : "The session history was not cleared.");
        });
      } else {
        void api.chats
          .create({ agentId: chat.agentId, projectId: chat.projectId, firmId: chat.firmId, continueFromChatId: chat.id })
          .then((created) => {
            if (
              !created?.id
              || created.id === chat.id
              || created.agentId !== chat.agentId
              || (created.projectId ?? null) !== (chat.projectId ?? null)
              || (created.firmId ?? null) !== (chat.firmId ?? null)
            ) {
              throw new Error("chat_create_receipt_mismatch");
            }
            setSessionNotice(null);
            router.push(`/workspace/task?id=${created.id}`);
          })
          .catch(() => {
            setSessionNotice(locale === "ko"
              ? "새 대화를 만들지 못했습니다. 현재 대화는 그대로 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요."
              : "A new conversation was not created. This conversation is unchanged. Check the connection and try again.");
          });
      }
    },
    [busy, chat, locale, router],
  );

  // A linked prompt may prefill or start a task, but product actions never ride in chat text.
  useEffect(() => {
    const seedPrompt = searchParams.get("prompt") ?? "";
    const promptStartIntent = searchParams.get("promptStartIntent")?.trim() ?? "";
    const seedPermission = parsePermission(
      searchParams.get("permission") ?? searchParams.get("permissions"),
    );

    if (!seedPrompt || !chat || !agent) return;
    if (seededRef.current === chatId) return;
    if (messages.length > 0) {
      // A reload after the exact user message was persisted is terminal proof
      // that this prompt-start intent reached its destination chat.
      if (promptStartIntent) completePromptStartIntent(promptStartIntent);
      router.replace(`/workspace/task?id=${chatId}`);
      return;
    }
    seededRef.current = chatId;
    
    if (seedPrompt) {
      // seedOnly=1 — 자동 전송하지 않고 입력창에만 채운다(프롬프트 저장소의 입력물 필요
      // 프롬프트: 사용자가 사진/문서를 첨부한 뒤 직접 전송해야 결과가 정상).
      if (searchParams.get("seedOnly") === "1") {
        setComposerPrefill(seedPrompt);
        if (promptStartIntent) completePromptStartIntent(promptStartIntent);
        router.replace(`/workspace/task?id=${chatId}`);
        return;
      }
      if (seedPermission === "full" && !confirmFullPermissionFromUrl(locale)) {
        router.replace(`/workspace/task?id=${chatId}`);
        return;
      }
      void send(seedPrompt, { permissions: seedPermission ?? DEFAULT_PERMISSION }).then((accepted) => {
        if (accepted && promptStartIntent) completePromptStartIntent(promptStartIntent);
      });
      router.replace(`/workspace/task?id=${chatId}`);
    }
  }, [chat, agent, chatId, locale, messages.length, send, router, searchParams]);

  useEffect(
    () =>
      onHubBookmarkChange((change) => {
        // Invalidate any snapshot captured before this renderer-local mutation.
        hubBookmarkGenerationRef.current += 1;
        if (change.action === "synced") {
          setHubBookmarks(change.bookmarks);
          return;
        } else if (change.action === "added") {
          setHubBookmarks((previous) => [
            change.bookmark,
            ...previous.filter((bookmark) => hubBookmarkIdentityKey(bookmark) !== hubBookmarkIdentityKey(change.bookmark)),
          ]);
        } else {
          setHubBookmarks((previous) => previous.filter((bookmark) =>
            bookmark.slug !== change.slug ||
            (change.entityKind && bookmark.listing.entityKind !== change.entityKind)
          ));
        }
        void refreshHubBookmarks();
      }),
    [refreshHubBookmarks],
  );

  // Routing reads the latest transcript through a ref so ChatInput receives a
  // stable callback while partial output keeps changing the parent message list.
  const routingContextRef = useRef({ chat, messages, agent });
  routingContextRef.current = { chat, messages, agent };
  const buildRoutingQueryWithContext = useCallback((text: string): string => {
    const current = routingContextRef.current;
    const recent = current.messages
      .filter((message) => (message.role === "user" || message.role === "agent") && (message.text ?? "").trim())
      .slice(-6)
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${(message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240)}`);
    if (recent.length === 0) return text;
    const agentLine = current.agent?.name ? `Current agent in this chat: ${current.agent.name}\n` : "";
    return [
      `${agentLine}Recent conversation (for routing continuity):`,
      recent.join("\n"),
      "",
      `New request to route: ${text}`,
      "If this is a follow-up to the conversation above, prefer keeping the current agent/context over switching to an unrelated agent.",
    ].join("\n");
  }, []);

  // 세션 팀 자동 보강은 기존 routePreview 호스트 계약을 유지하되 sessionRosterFirst를
  // 명시한다. 현재 main은 이 요청에서 전역검색을 하지 않고 none을 반환하므로, 실제
  // gap 판단과 필요 시 Hub/Cloud 보강은 현재 세션 LLM이 맡는다.
  const handleRecommendPreview = useCallback(async (text: string): Promise<Recommendation | null> => {
    const api = ipc();
    const currentChat = routingContextRef.current.chat;
    if (!api || !currentChat) return null;
    const folder = await api.workspace.get(currentChat.id).catch(() => null);
    try {
      return await api.hephaestus.routePreview({
        // 라우터가 후속 메시지를 맥락 없이 단독 해석하지 않도록 최근 대화를 함께 싣는다.
        // (예: 사진 편집 진행 중 "여기다 이미지 보여줘야지"가 맥락을 잃고 엉뚱한 허브
        //  에이전트로 라우팅되던 문제 방지.)
        query: buildRoutingQueryWithContext(text),
        project: folder ?? undefined,
        allowLocal: true, // 로컬 카드 + 허브 혼합 추천
        sessionRosterFirst: true,
      });
    } catch {
      return null;
    }
  }, [buildRoutingQueryWithContext]);

  // 추천 시트 선택은 해당 턴의 구조화된 실행 의도로만 전달한다.
  const handleRecommendExecute = useCallback((
    choice: RecExecChoice,
    text: string,
    opts: { images?: ImageAttachment[]; permissions?: PermissionLevel; planMode?: boolean; goalMode?: boolean; appsGenerateMode?: boolean },
  ) => {
    const sendOpts = {
      images: opts?.images,
      permissions: opts?.permissions,
      planMode: opts?.planMode,
      goalMode: opts?.goalMode,
      appsGenerateMode: opts?.appsGenerateMode,
      // The recommendation carries structured execution intent. Prompt text
      // remains exactly what the user wrote.
      routerAgent: choice.routerAgent,
    };
    switch (choice.kind) {
      case "agent":
        // Auto-routing creates a temporary TF target and never mutates the
        // chat's persistent agent/firm/group binding.
        void send(text, { ...sendOpts, taskForceTargets: [choice.target] });
        break;
      case "network":
        if (choice.targets && choice.targets.length > 0) {
          void send(text, { ...sendOpts, taskForceTargets: choice.targets });
        } else {
          void send(text, { ...sendOpts, sessionRouting: true });
        }
        break;
      case "pipeline": {
        // 단계 계획을 플레이스홀더 메시지 상단 스테퍼로 보여준다(PRD→배포 가시화).
        void send(text, {
          ...sendOpts,
          pipelineStages: choice.stages?.length ? choice.stages : undefined,
          stormbreakerMode: true,
        });
        break;
      }
      case "plain":
      default:
        void send(text, sendOpts);
        break;
    }
  }, [send]);

  async function saveTitle() {
    const api = ipc();
    if (!api || !chat) return;
    const next = await api.chats.rename(chat.id, titleDraft);
    setChat(next);
    setEditingTitle(false);
  }

  async function removeChat() {
    const api = ipc();
    if (!api || !chat) return;
    if (busy) {
      setSessionNotice(locale === "ko"
        ? "실행 중인 작업은 삭제할 수 없습니다. 먼저 실행을 멈추고 종료될 때까지 기다려 주세요."
        : "You cannot delete a running task. Stop it and wait for the run to finish first.");
      return;
    }
    if (!confirm(locale === "ko" ? "이 작업을 삭제할까요?" : "Delete this task?")) return;
    const removedId = chat.id;
    try {
      // Main이 active-run registry를 다시 확인한다. 삭제가 실제로 끝난 뒤에만 화면의
      // 로컬 사본을 비워서 거절된 삭제가 빈 화면으로 보이지 않게 한다.
      await api.chats.remove(removedId);
      setChat(null);
      setMessages([]);
      dropChatViewSnapshot(removedId);
      router.replace("/");
    } catch {
      setSessionNotice(locale === "ko"
        ? "작업이 아직 실행 중이거나 삭제할 수 없는 상태입니다. 실행을 멈춘 뒤 다시 시도해 주세요."
        : "This task is still running or cannot be deleted. Stop the run and try again.");
    }
  }

  // ── 스트리밍 파셜마다 ChatStream 이하 전체가 리렌더되던 원인 수리 ──
  // 아래 값들이 렌더마다 새 참조(인라인 화살표·객체 리터럴)로 내려가면 memo(Bubble)가
  // 무력화돼 파셜(초당 최대 ~16회)마다 모든 말풍선·ChatInput·우측 패널이 다시 그려진다.
  // 조건부 return보다 앞(훅 구역)에서 참조를 고정한다.
  const pickerAgents = useMemo(() => visibleAgents(allAgents, { includeTeams: true }), [allAgents]);
  const boundTeamMember = useMemo(
    () => (agent && agent.visibility === "background" && agent.parentTeamId ? agent : null),
    [agent],
  );
  const displayAgents = useMemo(
    () => (boundTeamMember
      ? [boundTeamMember, ...pickerAgents.filter((row) => row.id !== boundTeamMember.id)]
      : pickerAgents),
    [boundTeamMember, pickerAgents],
  );
  const userFacingProjectPool = useMemo(
    () => (project?.agentPool ?? []).filter((member) => isUserFacingProjectPoolMember(member, allAgents)),
    [project, allAgents],
  );
  const projectForDisplay = useMemo(
    () => (project ? { ...project, agentPool: userFacingProjectPool } : null),
    [project, userFacingProjectPool],
  );
  const chatEmptyDirectory = useMemo(() => ({
    agents: displayAgents,
    hubBookmarks,
    firms: allFirms,
    projects: allProjects,
    envKeys: allEnvKeys,
    plugins: installedPlugins,
    projectTeam: projectForDisplay?.agentPool.map((member) => {
      const installed = member.entityKind === "agent" && member.agentId
        ? allAgents.find((candidate) => candidate.id === member.agentId)
        : null;
      const firm = member.entityKind === "team" && member.firmId
        ? allFirms.find((candidate) => candidate.id === member.firmId)
        : null;
      const name = installed
        ? pickLocalized(installed, locale).name
        : firm
          ? pickLocalized(firm, locale).name
          : member.nameSnapshot || (member.entityKind === "team"
            ? (locale === "ko" ? "팀" : "Team")
            : (locale === "ko" ? "에이전트" : "Agent"));
      return {
        id: projectPoolMemberKey(member),
        token: name,
        label: member.entityKind === "team"
          ? (locale === "ko" ? "에이전트 팀 · 필요할 때 참여" : "Agent team · joins when needed")
          : (locale === "ko" ? "전문 에이전트 · 필요할 때 참여" : "Specialist agent · joins when needed"),
      };
    }),
  }), [displayAgents, hubBookmarks, allFirms, allProjects, allEnvKeys, installedPlugins, projectForDisplay, allAgents, locale]);
  const handleOpenArtifact = useCallback((a: CodeArtifact) => {
    setSurface(null);
    setMediaPreview(null);
    setArtifact(a);
    openPanelTab("panel");
  }, [openPanelTab]);
  const handleOpenMedia = useCallback((media: MediaArtifact) => {
    setSurface(null);
    setArtifact(null);
    setMediaPreview(workspacePreviewFromMedia(media));
    openPanelTab("panel");
  }, [openPanelTab]);
  const handleOpenWorkflow = useCallback(() => setNetworkOpenPersisted(true), [setNetworkOpenPersisted]);
  const handleOpenMultimodalSetup = useCallback(() => router.push("/settings#multimodal"), [router]);
  const chatInputContext = useMemo(() => ({
    agents: displayAgents,
    hubBookmarks,
    projects: allProjects,
    firms: allFirms,
    apps: INSTALLED_APPS,
    generatedApps: allGeneratedApps,
    envKeys: allEnvKeys,
  }), [allEnvKeys, allFirms, allGeneratedApps, allProjects, displayAgents, hubBookmarks]);
  const composerTokenBaselineRef = useRef(currentTokens);
  if (!busy) composerTokenBaselineRef.current = currentTokens;
  const composerTokenCount = busy ? composerTokenBaselineRef.current : currentTokens;
  const chatInputTokensUsage = useMemo(() => ({ current: composerTokenCount }), [composerTokenCount]);
  const handleChatInputSend = useCallback((
    text: string,
    opts?: {
      images?: ImageAttachment[];
      files?: ChatFileDraft[];
      permissions?: PermissionLevel;
      planMode?: boolean;
      goalMode?: boolean;
      appsGenerateMode?: boolean;
      taskForceTargets?: OrchestrationTarget[];
      sessionRouting?: boolean;
      stormbreakerMode?: boolean;
    },
  ) => {
    submitOrQueue(text, {
      images: opts?.images,
      files: opts?.files,
      permissions: opts?.permissions,
      planMode: opts?.planMode,
      goalMode: opts?.goalMode,
      appsGenerateMode: opts?.appsGenerateMode,
      taskForceTargets: opts?.taskForceTargets,
      sessionRouting: opts?.sessionRouting,
      stormbreakerMode: opts?.stormbreakerMode,
    });
  }, [submitOrQueue]);
  const handleToggleGoal = useCallback(() => {
    if (!chat) return;
    const next = !chat.goalId;
    const previous = chat;
    setGoalContext(null);
    setChat({ ...chat, goalId: next ? "pending" : null, continuousMode: next ? true : chat.continuousMode });
    void ipc()?.chats
      .setGoalMode(chat.id, next)
      .then((updated: Chat | null) => {
        if (updated) setChat(updated);
        if (!updated?.goalId) setGoalContext(null);
      })
      .catch(() => setChat(previous));
  }, [chat]);
  const handleResumeGoal = useCallback(() => {
    if (!chat || !goalContext?.version) return;
    const expectedVersion = goalContext.version;
    void ipc()?.chats.resumeGoal(chat.id, expectedVersion)
      .then((context) => {
        if (context) setGoalContext(context);
      })
      .catch(() => {
        // A stale version means another surface changed the run. Re-read the
        // main-owned snapshot instead of guessing whether resume succeeded.
        void ipc()?.chats.getGoalContext(chat.id).then((context) => setGoalContext(context));
      });
  }, [chat, goalContext?.version]);
  const handleToggleContinuous = useCallback(() => {
    if (!chat) return;
    const next = !chat.continuousMode;
    const previous = chat;
    setChat({ ...chat, continuousMode: next, swarmMode: next ? false : chat.swarmMode });
    const api = ipc();
    if (next && chat.swarmMode) void api?.chats.setSwarmMode(chat.id, false);
    void api?.chats
      .setContinuousMode(chat.id, next)
      .then((updated: Chat | null) => {
        if (updated) setChat({ ...updated, swarmMode: next ? false : updated.swarmMode });
      })
      .catch(() => setChat(previous));
  }, [chat]);
  const handleToggleSwarm = useCallback(() => {
    if (!chat) return;
    const next = !chat.swarmMode;
    const previous = chat;
    setChat({ ...chat, swarmMode: next, continuousMode: next ? false : chat.continuousMode });
    const api = ipc();
    if (next && chat.continuousMode) void api?.chats.setContinuousMode(chat.id, false);
    void api?.chats
      .setSwarmMode(chat.id, next)
      .then((updated: Chat | null) => {
        if (updated) setChat({ ...updated, continuousMode: next ? false : updated.continuousMode });
      })
      .catch(() => setChat(previous));
  }, [chat]);

  if (
    requestedTaskId &&
    (validatedTaskChatId === null || !validatedTaskChatId || chat?.id !== validatedTaskChatId)
  ) {
    return null;
  }
  if (!chat) {
    if (chatId) return null; // 특정 Task/채팅 로딩 중
    return (
      <div style={{ display: "flex", flex: 1, height: "100%", width: "100%", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 440 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginBottom: 8 }}>{t("chat.empty.title")}</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-soft)" }}>{t("chat.empty.hint")}</div>
        </div>
      </div>
    );
  }
  // @ is an optional one-turn override. It uses the same user-facing roster as
  // every other picker and never exposes a team's private system-role cells.
  // (pickerAgents/displayAgents/projectForDisplay는 훅 구역에서 참조 고정.)
  const displayAgent =
    agent?.visibility === "background" && !boundTeamMember ? null : agent;
  const latestUserPrompt = lastMessageOfRole(messages, "user")?.text ?? "";
  const activeRunContext = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "agent" || !message.busy) continue;
      for (let promptIndex = index - 1; promptIndex >= 0; promptIndex -= 1) {
        const prompt = messages[promptIndex];
        if (prompt.role === "user") return { startedAt: message.startedAt, prompt: prompt.text };
      }
      return { startedAt: message.startedAt, prompt: "" };
    }
    return null;
  })();
  // 현재(가장 최근) 에이전트 실행이 다단계 파이프라인(2+ stage)이면, 단일 에이전트라도 카드/네트워크 뷰를 켠다.
  const hasPipeline = (lastMessageOfRole(messages, "agent")?.pipeline?.length ?? 0) > 1;

  return (
    <div className="task-cockpit-shell" style={{ display: "flex", height: "100%", width: "100%", minWidth: 0, overflow: "hidden" }}>
      {/* ★대화 영역은 One 과 같이 흰 면 위에 놓는다(2026-09-04 실측).
          예전에는 이 열이 투명이라 페이지 배경(--paper-2)이 그대로 비쳤고, 작성창만 흰
          카드로 떠 보였다. One 은 workspace 전체가 흰 면이라 대화가 한 장의 면 위에 앉는다.
          같은 뜻의 토큰(--paper)을 쓴다 — 다크 테마에서도 함께 따라간다. */}
      <div
        className="task-cockpit-main"
        style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--paper)" }}
      >
      <header
        className="task-cockpit-header titlebar-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 12px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 47,
          height: 47,
        }}
      >
        <button
          type="button"
          className="project-detail-back titlebar-nodrag"
          data-work-dashboard-return="task-header"
          onClick={() => router.push(project ? `/project/detail?id=${project.id}` : "/dashboard")}
          aria-label={project ? (locale === "ko" ? "프로젝트 열기" : "Open project") : (locale === "ko" ? "대시보드로 돌아가기" : "Back to Dashboard")}
        >
          <IconFolder size={16} />
          <span>{project?.name || (locale === "ko" ? "대시보드" : "Dashboard")}</span>
        </button>
        <div className="task-cockpit-title" style={{ flex: 1, minWidth: 0 }}>
          {project && (
            <div
              className="task-cockpit-project-eyebrow"
              style={{
                fontSize: 10,
                color: "var(--muted-deep)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              <span
                onClick={() => router.push(`/project/detail?id=${project.id}`)}
                style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}
                className="titlebar-nodrag"
              >
                {project.name}
              </span>
            </div>
          )}
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") void saveTitle();
                if (e.key === "Escape") {
                  setTitleDraft(chat.title);
                  setEditingTitle(false);
                }
              }}
              className="titlebar-nodrag"
              style={{
                width: "100%",
                fontSize: 13.5,
                fontWeight: 600,
                fontFamily: "var(--font-head)",
                border: "1px solid var(--paper-edge)",
                borderRadius: 6,
                padding: "2px 6px",
                background: "var(--paper-2)",
              }}
            />
          ) : (
            <div
              onDoubleClick={() => setEditingTitle(true)}
              className="titlebar-nodrag"
              style={{
                fontFamily: "var(--font-head)",
                fontSize: 13.5,
                fontWeight: 600,
                color: "var(--ink)",
                cursor: "text",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={t("chat.rename_hint")}
            >
              {chat.title.trim() || (locale === "ko" ? "새 작업" : "New task")}
            </div>
          )}
        </div>
        <div className="task-cockpit-header-actions titlebar-nodrag" role="group" aria-label={locale === "ko" ? "작업 보기" : "Task views"}>
        <button
          onClick={() => (networkOpen ? closeRightPanel() : setNetworkOpenPersisted(true))}
          className="task-cockpit-header-action"
          data-tour-id="workspace.workflow-toggle"
          aria-label={t("chat.network_panel")}
          title={t("chat.network_panel")}
          data-active={networkOpen ? "true" : "false"}
        >
          <IconNetwork size={16} />
        </button>
        <button
          onClick={() => (workspaceOpen ? closeRightPanel() : setWorkspaceOpenPersisted(true))}
          className="task-cockpit-header-action"
          data-right-panel-trigger="file"
          aria-label={t("chat.workspace_panel")}
          title={t("chat.workspace_panel")}
          data-active={workspaceOpen ? "true" : "false"}
        >
          <IconFolder size={16} />
        </button>
        <button
          onClick={() => (rightPanelOpen && rightPanelTab === "panel" ? closeRightPanel() : openPanelTab("panel"))}
          className="task-cockpit-header-action"
          data-right-panel-trigger="panel"
          aria-label={hasViewablePanelContent
            ? (locale === "ko" ? "뷰어 패널" : "Viewer panel")
            : (locale === "ko" ? "아직 열 결과가 없습니다" : "No result to view yet")}
          title={hasViewablePanelContent
            ? (locale === "ko" ? "뷰어 패널" : "Viewer panel")
            : (locale === "ko" ? "아직 열 결과가 없습니다" : "No result to view yet")}
          data-active={rightPanelOpen && rightPanelTab === "panel" ? "true" : "false"}
          data-has-content={hasViewablePanelContent ? "true" : "false"}
          disabled={!hasViewablePanelContent}
        >
          <IconPanelRight size={16} />
        </button>
        <button
          onClick={() => void removeChat()}
          className="task-cockpit-header-action task-cockpit-header-danger"
          aria-label={locale === "ko" ? "작업 삭제" : "Delete task"}
          title={locale === "ko" ? "작업 삭제" : "Delete task"}
        >
          <IconTrash size={16} />
        </button>
        </div>
      </header>

      {/* ★상단 알림도 아래 배너와 같은 여백을 쓴다(2026-09-04 오너 제보).
          이 배너만 감싸는 것이 없어 창 양끝에 그대로 붙었고, 바로 아래 배너는
          margin 0 16px 라 두 줄이 서로 어긋나 보였다. */}
      <div style={{ margin: "0 16px" }}>
        <KeyStatusBanner mode="banner" compact />
      </div>

      <div style={{ margin: "0 16px" }}>
        <OneSuggestionReviewHandoffBanner surface="work" locale={locale} />
      </div>

      {/* ContinuityReceipt(복원 배너) — 실제로 알 수 있는 사실만: 마지막 작업 폴더가 로컬에서
          복원됐다는 점. 기기 간 클라우드 동기화는 백엔드 미확인이라 단정하지 않는다.
          복원할 폴더가 없으면 렌더하지 않는다. */}
      {recap && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "8px 16px 0",
            padding: "7px 11px",
            borderRadius: 8,
            border: "1px solid var(--accent-soft)",
            background: "var(--fill-1)",
            color: "var(--muted-deep)",
            fontSize: 11.5,
            lineHeight: 1.4,
            minWidth: 0,
          }}
        >
          <IconSparkles size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ flexShrink: 0, color: "var(--ink-soft)", fontWeight: 700 }}>
            {t("chat.recap.label")}
          </span>
          <span
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-soft)" }}
            title={recap.summary}
          >
            {recap.summary}
          </span>
          <button
            onClick={() => setRecap(null)}
            title={locale === "ko" ? "배너 닫기" : "Dismiss"}
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              width: 20,
              height: 20,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: "var(--muted-deep)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}

      {restoredFolder && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "8px 16px 0",
            padding: "7px 11px",
            borderRadius: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper-2)",
            color: "var(--muted-deep)",
            fontSize: 11.5,
            lineHeight: 1.4,
            minWidth: 0,
          }}
        >
          <IconFolder size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ flexShrink: 0, color: "var(--ink-soft)", fontWeight: 700 }}>
            {locale === "ko" ? "이전 작업 폴더에서 이어집니다" : "Continuing from your last working folder"}
          </span>
          <code
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: "var(--muted-deep)",
            }}
            title={userFacingFolderName(restoredFolder)}
          >
            {userFacingFolderName(restoredFolder)}
          </code>
          <button
            onClick={() => setRestoredFolder(null)}
            aria-label={locale === "ko" ? "폴더 안내 닫기" : "Dismiss folder notice"}
            title={locale === "ko" ? "배너 닫기" : "Dismiss"}
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              width: 20,
              height: 20,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: "var(--muted-deep)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}

      {/* Hub-approval cards render above the shell content, outside the .rd theme
          scope where --rd-* vars and .btn styling live — without this wrapper the
          켜기/나중에 buttons fall back to unstyled plain text. */}
      <div className="rd">
      {pendingHubApprovals.filter((row) => !dismissedHubApprovals.has(row.serverId)).map((row) => (
        <div key={row.serverId} className="hub-approval-card">
          <div className="hub-approval-card-title">
            {`"${row.slug}" 도구가 붙어 있지만 아직 켜지지 않았습니다`}
          </div>
          <div className="hub-approval-card-body">
            이 명령이 이 Mac에서 실행됩니다 — 켜면 다음 대화부터 사용됩니다.
          </div>
          <code className="hub-approval-card-command">
            {[row.command, ...row.args].filter(Boolean).join(" ")}
          </code>
          {row.envKeys.length > 0 ? (
            <div className="hub-approval-card-body">
              {`켠 뒤 키 입력이 필요합니다: ${row.envKeys.join(", ")}`}
            </div>
          ) : null}
          <div className="hub-approval-card-actions">
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                const approvalApi = ipc();
                if (!approvalApi) return;
                void approvalApi.mcpTools
                  .setEnabled(row.serverId, true)
                  .then(() => {
                    setPendingHubApprovals((rows) => rows.filter((r) => r.serverId !== row.serverId));
                    void approvalApi.mcpTools.listInstalled().then(setInstalledPlugins).catch(() => undefined);
                  })
                  .catch(() => undefined);
              }}
            >
              켜기
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => setDismissedHubApprovals((prev) => new Set(prev).add(row.serverId))}
            >
              나중에
            </button>
          </div>
        </div>
      ))}
      </div>

      <div data-tour-id="workspace.chat" style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <ChatStream
          messages={messages}
          agentName="Agentlas"
          agentTone={displayAgent?.tone ?? "blue"}
          emptyDirectory={chatEmptyDirectory}
          onOpenArtifact={handleOpenArtifact}
          onOpenMedia={handleOpenMedia}
          onOpenLinkedFile={openLinkedFile}
          onOpenChatFile={openChatFile}
          onOpenWorkflow={handleOpenWorkflow}
          onOpenMultimodalSetup={handleOpenMultimodalSetup}
          interactionBusy={busy}
          stopRequested={cancelPending}
          mediaBasePaths={mediaBasePaths}
          workspaceRoot={restoredFolder ?? defaultRunFolder ?? undefined}
          focusMessageId={requestedFocusMessageId}
        />
        {/* 도구 승인은 이 대화 안에서, 묻는 순간에(오너 결정 2026-08-15) */}
        <ToolApprovalInline chatId={chat?.id ?? null} compact chip />
      </div>
      {/* 실행 전 API 키 요청 바텀 시트 — 값은 vault(env.set)로만, IPC는 완료 신호만 */}
      {keyRequestSheet && (
        <McpKeyRequestSheet
          request={keyRequestSheet}
          onResolved={() => setKeyRequestSheet(null)}
        />
      )}
      {/* 에이전트 질문 바텀 시트 — 인라인 카드 대신 여기 모아 전부 답하고 1회 전송 */}
      {pendingQuestionSheet && (
        <ChatQuestionSheet
          questions={pendingQuestionSheet.questions}
          initialReply={pendingQuestionSheet.initialReply}
          onRetryCommitted={pendingQuestionSheet.continuationRunId ? () => { void resumeCommittedQuestion(); } : undefined}
          busy={busy || questionCommitPending}
          onConfirm={(reply, perQuestion) =>
            answerQuestionBatch(
              pendingQuestionSheet.messageId,
              pendingQuestionSheet.sourceMessageId,
              reply,
              perQuestion,
            )
          }
          onDismiss={() => dismissQuestionBatch(pendingQuestionSheet.messageId)}
        />
      )}
      {/* Codex식: 이 대화가 폴더(프로젝트)에서 작업하는지 / 전역 대화인지 선택 */}
      {!project && <div
        data-chat-folder-row="true"
        style={{
          width: "min(calc(100% - 32px), 740px)",
          margin: "0 auto",
          // Align the visible folder control with the textarea's text inset,
          // not merely with the composer's outer border.
          padding: "6px 0 0 18px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxSizing: "border-box",
        }}
      >
        <ProjectFolderBar
          chatId={chatId || null}
          reloadToken={folderReload}
          onOpenPanel={() => setWorkspaceOpenPersisted(true)}
          onChanged={(f) => {
            if (f) setWorkspaceOpenPersisted(true);
          }}
        />
      </div>}
      {sessionNotice && (
        <div
          role="status"
          data-chat-session-notice="true"
          style={{
            width: "min(calc(100% - 32px), 740px)", margin: "7px auto 0", padding: "7px 10px", borderRadius: 8,
            boxSizing: "border-box",
            border: "1px solid color-mix(in srgb, var(--green-deep) 24%, var(--paper-edge))",
            background: "color-mix(in srgb, var(--green-deep) 7%, var(--paper))",
            color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.4,
          }}
        >
          {sessionNotice}
        </div>
      )}
      <div data-tour-id="workspace.input" style={{ flexShrink: 0, minWidth: 0 }}>
        <ChatInput
          onSend={handleChatInputSend}
          queuedCount={queuedSteers.length}
          prefillText={composerPrefill}
          activeChatId={chat.id}
          onSessionAction={handleSessionAction}
          onRecommendPreview={handleRecommendPreview}
          onRecommendExecute={handleRecommendExecute}
          onStop={stop}
          stopRequested={cancelPending}
          activeAgentId={agent?.id ?? chat.agentId ?? null}
          busy={busy}
          disabled={!agent}
          context={chatInputContext}
          placeholder={locale === "ko" ? "원하는 결과를 설명하세요" : "Describe the result you want"}
          projectOrchestration={Boolean(project)}
          activeProjectId={project?.id ?? chat.projectId ?? null}
          tokensUsage={chatInputTokensUsage}
          showModeToggles={chat.kind !== "division"}
          continuousMode={chat.continuousMode === true}
          swarmMode={chat.swarmMode === true}
          goalActive={Boolean(chat.goalId)}
          onToggleGoal={handleToggleGoal}
          progressLabel={goalContext?.objective}
          goalCriteria={goalContext?.acceptanceCriteria}
          goalRunStatus={goalContext?.runStatus}
          goalPauseReason={goalContext?.pauseReason}
          onResumeGoal={handleResumeGoal}
          onToggleContinuous={handleToggleContinuous}
          onToggleSwarm={handleToggleSwarm}
        />
      </div>
      </div>
      {rightPanelOpen && (
        <ChatRightPanel
          key={chatId || "new-task"}
          activeTab={rightPanelTab}
          onTabChange={openPanelTab}
          onClose={closeRightPanel}
          chatId={chatId || null}
          artifact={artifact}
          surface={liveWorkbenchSurface}
          filePreview={mediaPreview}
          onHydrateFilePreview={openWorkspaceFilePreview}
          agentScreen={agentScreen}
          onAgentScreenMode={(mode) => setAgentScreen({ mode })}
          linkedFiles={linkedFiles}
          linkedOutputs={linkedOutputFiles}
          onSurfaceAction={handleSurfaceAction}
          onSurfaceStatePatch={handleSurfaceStatePatch}
          firm={firm}
          org={resolvedOrg}
          agent={displayAgent}
          agents={displayAgents}
          project={projectForDisplay}
          busy={busy}
          liveAgents={liveAgents}
          timeline={netTimeline}
          chatTitle={chat.title}
          latestUserPrompt={latestUserPrompt}
          hasPipeline={hasPipeline}
          width={rightPanelWidth}
          onResizeWidth={resizeRightPanel}
          onRequestReadableWidth={requestReadableRightPanelWidth}
          onFileTabsEmpty={clearRightPanelFilePreview}
          height={rightPanelHeight}
          onResizeHeight={resizeRightPanelHeight}
        />
      )}
    </div>
  );
}
