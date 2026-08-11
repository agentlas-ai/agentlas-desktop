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
import type { InvocationRunReceipt, OrchestrationTarget, Recommendation, RecExecChoice, RecRouterAgent, RecStage, RunEventUi, RuntimeSelection } from "@shared/types";
import { ChatStream, type StreamMessage, type StreamStep, type PipelineStage } from "@/components/ChatStream";
import { normalizeToolCall } from "@shared/tool-call-detail";
import { ChatQuestionSheet, type QuestionSheetAnswer } from "@/components/ChatQuestionSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import { extractQuestions } from "@/lib/ask-question";
import { stripMultimodalSetup } from "@/lib/multimodal-setup";
import { dropChatViewSnapshot, readChatViewSnapshot, saveChatViewSnapshot } from "@/lib/chat-view-cache";
import { ChatInput } from "@/components/ChatInput";
import type { SurfaceStatePatchHandler, WorkbenchSurface } from "@/components/WorkbenchPanel";
import type { LiveAgent, NetTimelineItem } from "@/components/AgentNetworkPanel";
import { ChatRightPanel, type ChatRightPanelTab } from "@/components/ChatRightPanel";
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
import { IconArrowLeft, IconBuilding, IconClose, IconFolder, IconNetwork, IconPanelRight, IconSparkles, IconTrash } from "@/components/Icon";
import { INSTALLED_APPS } from "@/lib/apps";
import { visibleAgents } from "@/lib/agent-visibility";
import { isUserFacingProjectPoolMember, projectPoolMemberKey } from "@/lib/project-agent-roster";
import { pickLocalized, useT } from "@/lib/i18n";
import { surfaceApprovalRequirement, type SurfaceApprovalRequirement } from "@/lib/surface-approval";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import { hubBookmarkIdentityKey, onHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { OneSuggestionReviewHandoffBanner } from "@/components/one/OneSuggestionReviewHandoff";

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
  return /stormbreaker\s+loop|루프\s*stormbreaker|scope-lock|verifier-first|agentlas\s*오케스트레이터|(?:^|\s)codex:\s|skill descriptions were shortened|sessionend hook|agentlas plugins|career graph (?:색인 갱신|refreshed):?\s*nodes=|\b(?:bash|collab_tool_call|mcp_tool_call|write|read|edit|glob|grep|websearch|webfetch)\b|\b(?:codex|claude code|gemini|kimi|grok)\s+cli\b/i.test(value);
}

function receiptRecoveryMessage(
  receipt: InvocationRunReceipt | null,
  locale: "ko" | "en",
): StreamMessage | null {
  if (!receipt || receipt.status === "completed" || receipt.status === "running" || receipt.status === "cancelling") {
    return null;
  }
  const text = receipt.status === "cancelled"
    ? (locale === "ko"
      ? "이전 모델 실행이 최종 답변 전에 취소되었습니다. 마지막 지시와 대화 기록은 남아 있습니다."
      : "The previous model turn was cancelled before a final response. Your last instruction and conversation are preserved.")
    : (locale === "ko"
      ? "이전 모델 실행이 최종 답변 전에 중단되었습니다. 마지막 지시와 대화 기록은 남아 있습니다."
      : "The previous model turn stopped before a final response. Your last instruction and conversation are preserved.");
  return {
    id: `run-recovery:${receipt.runId}:${receipt.status}`,
    role: "system",
    text,
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

/**
 * 도구 호출이 실제로 건드린 파일 경로.
 *
 * 판별은 공용 `normalizeToolCall` 한 곳에서만 한다 — 여기서 도구 이름을 다시 보고
 * 추측하면 claude-code/codex/gemini/MCP 마다 결과가 갈라진다(옛 `toolView` 가 정확히
 * 그렇게 무너졌다). 읽은 파일도 포함한다: 사람이 "그 파일 좀 보자"고 할 대상은
 * 우리가 만든 것만이 아니다.
 */
function toolFilePathsFromSteps(steps: StreamStep[] | undefined): string[] {
  if (!steps || steps.length === 0) return [];
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
  // 이미지·영상·PDF 는 앱 안에서 직접 그린다 — `file://` 은 webSecurity 에 막힌다.
  if (/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|pdf)$/i.test(filePath)) {
    return `agentlas://localfile/?p=${encodeURIComponent(filePath)}`;
  }
  const normalized = filePath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
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

function workspacePreviewFromLinkedFile(file: LinkedFileArtifact): WorkspaceFilePreview {
  const path = file.path || file.paths?.[0] || file.href;
  const viewerKind = viewerKindFromName(file.name || path);
  return {
    path,
    name: file.name || basename(path),
    size: 0,
    viewerKind,
    fileUrl: file.fileUrl,
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
  if ([".html", ".htm", ".url", ".webloc"].includes(ext)) return "browser";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  if ([".doc", ".docx", ".rtf", ".pages", ".ppt", ".pptx", ".xls", ".xlsx"].includes(ext)) return "document";
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
const RIGHT_PANEL_DEFAULT_WIDTH = 360;
const RIGHT_PANEL_MIN_WIDTH = 300;
const RIGHT_PANEL_MAX_WIDTH = 760;

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
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

function readRightPanelWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampRightPanelWidth(raw);
  } catch {
    // ignore
  }
  return RIGHT_PANEL_DEFAULT_WIDTH;
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
    if (!DURABLE_WORKFLOW_EVENT_RE.test(event.kind)) continue;
    const agentId = event.nodeId || event.agentId;
    if (!agentId) continue;
    const role =
      typeof event.payload.phase === "string"
        ? event.payload.phase
        : typeof event.payload.modelRole === "string"
          ? event.payload.modelRole
          : "";
    const model = typeof event.payload.model === "string" ? event.payload.model : undefined;
    const tokensValue = Number(event.payload.tokens);
    const tokens = Number.isFinite(tokensValue) && tokensValue > 0 ? tokensValue : undefined;
    const text = durableWorkflowLabel(event, locale);
    liveAgents[agentId] = {
      name: event.agentId || event.nodeId || agentId,
      role,
      active: false,
      status: text,
      model,
    };
    timeline.push({
      key: `ledger:${event.id}`,
      agentId,
      name: event.agentId || event.nodeId || agentId,
      role,
      kind: event.kind === "workload_allocation" ? "tool" : "status",
      text,
      tokens,
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

function historyEntryToStreamMessage(entry: { id: string; role: string; text: string }): StreamMessage {
  const role: StreamMessage["role"] =
    entry.role === "assistant" ? "agent" : entry.role === "user" ? "user" : "system";
  if (role !== "agent") {
    return { id: entry.id, role, text: entry.text };
  }
  const parsed = extractQuestions(entry.text, entry.id);
  const setup = stripMultimodalSetup(parsed.text);
  return {
    id: entry.id,
    role,
    text: setup.text,
    questions: parsed.questions.length > 0 ? parsed.questions : undefined,
    needsMultimodalSetup: setup.needsSetup || undefined,
  };
}

// 재진입(히스토리 재로드) 시 이미 답한 질문이 다시 '미답변'으로 보여 사용자가 재선택→중복 전송하는
// 버그를 막는다. answer 상태는 DB에 저장되지 않으므로(본문만 저장), 대화 순서로 복원한다:
// 질문을 가진 에이전트 메시지 '뒤에' 다른 메시지가 있으면 = 이미 답하고 대화가 진행된 것 → answered 처리.
// 답 라벨은 바로 뒤의 user 메시지에서 복원(멀티select 불릿 분해). 마지막 메시지의 질문만 미답으로 남긴다.
/** 답변 확정 영수증 로드 — 실패는 빈 맵(영수증은 보강 정보, 히스토리 표시를 막지 않는다). */
async function fetchCommittedReplies(
  api: ReturnType<typeof ipc>,
  chatId: string,
): Promise<Map<string, string>> {
  try {
    const rows = await api?.confirm?.committedAnswers?.(chatId);
    return new Map((rows ?? []).map((row) => [row.sourceMessageId, row.reply]));
  } catch {
    return new Map();
  }
}

function restoreAnsweredQuestions(
  messages: StreamMessage[],
  committedReplies?: Map<string, string>,
): StreamMessage[] {
  return messages.map((msg, i) => {
    if (!msg.questions || msg.questions.length === 0) return msg;
    // 마지막 메시지 = 아직 답할 차례 — 단, 답변 확정 영수증이 있으면 이미 답한 질문이다.
    // (후속 user 메시지 persist가 실행 분기에서 유실돼도 시트를 다시 열지 않는다.)
    const committedReply = committedReplies?.get(msg.id)?.trim() ?? "";
    if (i >= messages.length - 1 && !committedReply) return msg;
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
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

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
  const [queuedSteers, setQueuedSteers] = useState<string[]>([]);
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null);
  const [surface, setSurface] = useState<WorkbenchSurface | null>(null);
  // 실행 전 API 키 요청 시트 — mcp-key-request 이벤트가 채우고, 응답/만료/런 종료가 비운다.
  const [keyRequestSheet, setKeyRequestSheet] = useState<McpRunKeyRequest | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceFilePreview | null>(null);
  const [scaffoldedApps, setScaffoldedApps] = useState<Record<string, AppFactoryScaffoldResult>>({});
  const [scaffoldedTools, setScaffoldedTools] = useState<Record<string, ToolFactoryScaffoldResult>>({});
  // 우측 패널 — file / agent / panel 탭을 하나의 rail 안에서 전환한다.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<ChatRightPanelTab>("agent");
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readRightPanelWidth());
  const workspaceOpen = rightPanelOpen && rightPanelTab === "file";
  const networkOpen = rightPanelOpen && rightPanelTab === "agent";
  // 슬래시 명령(/folder·/global)으로 워킹 폴더를 바꾸면 하단 폴더 바를 다시 읽게 하는 토큰
  const [folderReload, setFolderReload] = useState(0);
  // ContinuityReceipt(복원 배너)용 — 채팅 진입 시 ipc().workspace.get으로 복원된 마지막 작업 폴더.
  // 기기 간 클라우드 복원 여부는 백엔드 미확인이므로, 실제로 알 수 있는 사실(로컬 복원 경로)만 보여준다.
  const [restoredFolder, setRestoredFolder] = useState<string | null>(null);
  // /clear 뒤에 메시지를 다시 적재하지 않고도 실제 컨텍스트 리셋이 끝났음을 알려준다.
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
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
    }>(),
  );
  const linkedFiles = useMemo(() => {
    const baseKey = mediaBasePaths.join("\u0000");
    const cache = linkedFileScanCacheRef.current;
    const out: WorkspaceFilePreview[] = [];
    const seen = new Set<string>();
    const liveIds = new Set<string>();
    for (const message of messages) {
      if (message.role !== "agent") continue;
      const text = message.text ?? "";
      /* ★산출물은 **모델이 언급한 것**이 아니라 **실제로 만들어진 것**이다.
         본문 스캔만 하면, 파일을 쓰고 그 이름을 산문에 적지 않은 답변은 산출물이
         하나도 없는 것처럼 보인다. 도구 호출 인자에 경로가 이미 실려 오므로
         (읽기/쓰기/편집), 공용 판별기로 그것도 함께 거둔다 — 도구 이름을 여기서
         다시 추측하면 러너마다 갈라진다. */
      const toolPaths = toolFilePathsFromSteps(message.steps);
      // 에이전트가 앱을 세웠으면, 사람이 다음에 할 일은 그걸 보는 것이다.
      const serverUrls = localServerUrlsInText(text);
      const stepsKey = [...toolPaths, ...serverUrls].join("\u0000");
      liveIds.add(message.id);
      let entry = cache.get(message.id);
      if (
        !entry
        || entry.textLength !== text.length
        || entry.baseKey !== baseKey
        || entry.stepsKey !== stepsKey
      ) {
        entry = {
          textLength: text.length,
          baseKey,
          stepsKey,
          previews: [
            ...[
              ...linkedFileArtifactsInText(text, mediaBasePaths),
              ...toolPaths.map((p) => linkedFileArtifactFromPath(p)),
            ].map((file) => workspacePreviewFromLinkedFile(file)),
            ...serverUrls.map((url) => workspacePreviewFromLocalServer(url)),
          ],
        };
        cache.set(message.id, entry);
      }
      for (const preview of entry.previews) {
        const key = preview.path || preview.fileUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(preview);
      }
    }
    // 채팅 전환·/clear로 사라진 메시지의 캐시는 함께 버린다.
    if (cache.size > liveIds.size) {
      for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
    }
    return out;
  }, [messages, mediaBasePaths]);

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
  }, []);
  const closeRightPanel = useCallback(() => {
    setRightPanelOpen(false);
    writeRightPanelPreference(false, rightPanelTab);
  }, [rightPanelTab]);
  const openWorkspaceFilePreview = useCallback(async (preview: WorkspaceFilePreview) => {
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
    const shouldReadText =
      api &&
      Boolean(chatId) &&
      Boolean(readablePath) &&
      ["markdown", "json", "text", "browser"].includes(preview.viewerKind);
    if (shouldReadText && readablePath) {
      const text = await api.fs.readTextFile(readablePath, { kind: "chat-assets", chatId }).catch(() => null);
      if (text) {
        next = {
          ...preview,
          path: readablePath,
          size: text.size || preview.size,
          content: text.content,
          truncated: text.truncated,
          reason: text.reason,
        };
      }
    }
    setSurface(null);
    setArtifact(null);
    setMediaPreview(next);
    openPanelTab("panel");
  }, [chatId, openPanelTab]);
  const openLinkedFile = useCallback((file: LinkedFileArtifact) => {
    void openWorkspaceFilePreview(workspacePreviewFromLinkedFile(file));
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
    setRightPanelWidth(next);
    writeRightPanelWidth(next);
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
      if (ev.agentId) {
        const aid = ev.agentId;
        // per-node 완료 신호 — 그 노드만 비활성(▶→✓)으로 정리하고 종료. (전체 active 리셋과 별개)
        if (ev.done) {
          setLiveAgents((prev) =>
            prev[aid] ? { ...prev, [aid]: { ...prev[aid], active: false } } : prev,
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
            active: true,
            status: ev.status ?? prev[aid]?.status,
            delegateTo: ev.delegateTo ?? prev[aid]?.delegateTo,
            model: ev.model ?? prev[aid]?.model,
          },
        }));
        if (ev.kind === "tool-use") {
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
        } else if (ev.kind === "thinking" && ev.status?.trim()) {
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
            const dur = durationMs ?? (th.startedAt != null ? Date.now() - th.startedAt : 0);
            return {
              ...msg,
              thinking: { active: false, cumMs: th.cumMs + dur, lastMs: dur },
            };
          }),
        );
        return;
      }
      if (ev.kind === "tool-use" && ev.tool) {
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
            const { text, questions } = extractQuestions(raw, msg.id);
            const setup = stripMultimodalSetup(text);
            return {
              ...msg,
              text: setup.text,
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
              questions: questions.length > 0 ? questions : msg.questions,
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
        const pref = readRightPanelPreference();
        if (!pref || pref.open) {
          const autoMedia = firstMediaArtifactInText(ev.text ?? "", mediaBasePaths);
          if (autoMedia) {
            setSurface(null);
            setArtifact(null);
            setMediaPreview(workspacePreviewFromMedia(autoMedia));
            openPanelTab("panel");
          } else {
            const produced = linkedFileArtifactsInText(ev.text ?? "", mediaBasePaths)[0];
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
        // Steering is not an error path: Main queues it without cancelling this run.
        const wasUserCancel = cancelRequestedRef.current;
        const terminalStatus = wasUserCancel
          ? (locale === "ko" ? "취소됨" : "Cancelled")
          : (locale === "ko" ? "중단됨" : "Stopped");
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
            }];
          });
        setMessages(keepPlaceholder);
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
    [agent, chat?.title, chatId, locale, mediaBasePaths, openPanelTab, project?.name, t],
  );

  // consumeEvent를 ref로 미러 — subscribeRun/메타데이터 effect가 consumeEvent identity 변화(agent·
  // agentGroup 세팅 등)에 재구독/재실행되던 churn을 없앤다. 리스너는 항상 최신 consumeEvent를 호출한다.
  const consumeEventRef = useRef(consumeEvent);
  useEffect(() => {
    consumeEventRef.current = consumeEvent;
  }, [consumeEvent]);

  // runId 채널 구독 — send()와 재접속 경로 공용. lastStatusRef를 받으면(리플레이 후) 이어서 쓴다.
  // deps [] 로 안정화(consumeEvent는 ref로 접근) — 한 번 건 구독이 렌더 도중 교체돼 이벤트를 흘리지 않게.
  const subscribeRun = useCallback(
    (runId: string, placeholderId: string, lastStatusRef: { text: string } = { text: "" }) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events) return;
      const channel = api.invoke.eventChannel(runId);
      subRef.current?.();
      subRef.current = events.on(channel, (ev: McpInvocationEvent) =>
        consumeEventRef.current(ev, placeholderId, lastStatusRef),
      );
    },
    [],
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
    setCancelPending(false);
    runIdRef.current = null;
    lastRunIdRef.current = null;
    partialTextRef.current = "";
    processedTextLenRef.current = 0;
    setComposerPrefill(null);
    cancelRequestedRef.current = false;
    steerQueueRef.current = [];
    setQueuedSteers([]);
    setArtifact(null);
    setSurface(null);
    setMediaPreview(null);
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
  }, [chatId]);

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
      void Promise.all([
        api.invoke.history(chatId),
        fetchCommittedReplies(api, chatId),
        api.invoke.latestReceipt(chatId).catch(() => null),
      ])
        .then(([history, committedReplies, receipt]) => {
          if (cancelled) return;
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
          const recovery = receiptRecoveryMessage(receipt, locale);
          const restoredMessages = recovery ? [...historyMessages, recovery] : historyMessages;
          setMessages((current) => {
            const hasLiveDraft = current.some((msg) => msg.busy || msg.streaming);
            return hasLiveDraft ? current : restoredMessages;
          });
        }).catch(() => {
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
          void api.chats.setRuntimeSelection(chatId, null).catch(() => undefined);
          setChat((prev) => (prev && prev.id === chatId ? { ...prev, runtimeSelection: null } : prev));
          setActiveRuntime(fallback ? { ...fallback, active: true } : null);
          setSessionNotice(
            locale === "ko"
              ? `이 채팅에 고정돼 있던 실행 엔진(${selection.kind}${selection.model ? ` · ${selection.model}` : ""})을 더 이상 찾을 수 없어 고정을 해제했습니다. 현재 활성 엔진으로 계속 대화할 수 있습니다.`
              : `The engine pinned to this chat (${selection.kind}${selection.model ? ` · ${selection.model}` : ""}) is no longer available, so the pin was released. This chat now uses the active engine.`,
          );
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
        if (rightPanelPreference?.open) {
          setRightPanelTab(rightPanelPreference.tab);
          setRightPanelOpen(true);
        } else if (!rightPanelPreference && savedFolder) {
          setRightPanelTab("file");
          setRightPanelOpen(true);
        } else {
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
      void Promise.all([
        api.invoke.history(chatId),
        receiptPromise,
        fetchCommittedReplies(api, chatId),
      ]).then(([h, receipt, committedReplies]) => {
        const next = restoreAnsweredQuestions(h.map(historyEntryToStreamMessage), committedReplies);
        const recovery = receiptRecoveryMessage(receipt, locale);
        const status = receiptRecoveryStatus(receipt, locale);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false, status }])),
        );
        setMessages((current) => {
          if (current.some((message) => message.busy || message.streaming)) return current;
          const optimisticIds = new Set(steerQueueRef.current.map((item) => item.optimisticMessageId));
          const pendingDirections = current.filter((message) => optimisticIds.has(message.id));
          return [...next, ...pendingDirections, ...(recovery ? [recovery] : [])];
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
        const [h, receipt, committedReplies] = await Promise.all([
          api.invoke.history(chatId),
          endedRunId && typeof api.invoke.receipt === "function"
            ? api.invoke.receipt(endedRunId).catch(() => null)
            : Promise.resolve(null),
          fetchCommittedReplies(api, chatId),
        ]);
        if (!stopped) {
          const next = restoreAnsweredQuestions(h.map(historyEntryToStreamMessage), committedReplies);
          const recovery = receiptRecoveryMessage(receipt, locale);
          const status = receiptRecoveryStatus(receipt, locale);
          setLiveAgents((prev) =>
            Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false, status }])),
          );
          setMessages(recovery ? [...next, recovery] : next);
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

  const send = useCallback(
    async (
      userPrompt: string,
      opts?: {
        images?: ImageAttachment[];
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
      },
    ) => {
      const api = ipc();
      const events = ipcEvents();
      if (
        !api ||
        !events ||
        !chat ||
        busy ||
        (requestedTaskId && validatedTaskChatId !== chat.id)
      ) return false;
      setCancelPending(false);
      const routeInput = userPrompt;
      const invocationPrompt = routeInput;
      const visiblePrompt = userPrompt;
      if (isPlaceholderTaskTitle(chat.title)) {
        const nextTitle = taskTitleFromFirstPrompt(visiblePrompt);
        if (nextTitle) {
          try {
            const renamed = await api.chats.rename(chat.id, nextTitle);
            setChat(renamed);
            setTitleDraft(renamed.title);
            window.dispatchEvent(new Event("agentlas:tasks-changed"));
          } catch {
            // Work can still start; main retries the same deterministic title
            // from the durable first user message.
          }
        }
      }
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
      setMessages((m) => [
        ...m,
        { id: uid(), role: "user" as const, text: visiblePrompt, imageDataUrls },
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
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      lastRunIdRef.current = runId;
      partialTextRef.current = "";
      processedTextLenRef.current = 0;
      // 이벤트 처리는 consumeEvent로 추출됨 — 재접속(attach) 경로와 동일 로직 공유.
      subscribeRun(runId, placeholderId);
      try {
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
        // runId 도착 전에 Stop을 눌렀다면(레이스) 구독을 건 직후 즉시 취소 — abort 종료 이벤트를 수신해 busy 해제.
        if (cancelRequestedRef.current) {
          void api.invoke.cancel(runId);
        }
        return true;
      } catch {
        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.
        subRef.current?.();
        subRef.current = null;
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
      busy,
      locale,
      project,
      requestedTaskId,
      router,
      setNetworkOpenPersisted,
      subscribeRun,
      t,
      validatedTaskChatId,
    ],
  );
  // 진행 중 실행 취소 — 입력창의 정지 버튼(전송 버튼이 busy일 때 변신) / Cmd/Ctrl+Esc.
  const stop = useCallback(() => {
    const api = ipc();
    if (!api) return;
    if (cancelRequestedRef.current) return;
    setCancelPending(true);
    cancelRequestedRef.current = true;
    // 정지 = 인플라이트 전부 취소. 대기 중이던 steering 메시지도 비워 busy→false 시 자동
    // 발사되지 않게 한다(정지했는데 큐가 알아서 날아가던 버그).
    steerQueueRef.current = [];
    setQueuedSteers([]);
    // runId가 아직 안 왔으면(invoke:run 왕복 중) 취소 의사만 기록 → 도착 즉시 취소된다.
    const runId = runIdRef.current ?? lastRunIdRef.current;
    if (!runId) return;
    void api.invoke.cancel(runId);
  }, []);

  // 실행 중 steering — 사용자의 새 지시는 즉시 대화에 보이지만 현재 모델 턴을
  // 취소하지 않는다. Main이 현재 턴의 terminal settlement를 확인한 뒤 같은 세션의
  // 다음 run으로 순서대로 시작한다.
  const submitOrQueue = useCallback(
    (text: string, opts?: (typeof steerQueueRef)["current"][number]["opts"]) => {
      if (busy) {
        const api = ipc();
        if (!api || !chat) return;
        const optimisticMessageId = `steer:${uid()}`;
        steerQueueRef.current.push({ text, opts, optimisticMessageId });
        setQueuedSteers(steerQueueRef.current.map((q) => q.text));
        setMessages((current) => [...current, {
          id: optimisticMessageId,
          role: "user",
          text,
          imageDataUrls: opts?.images?.map((image) => `data:${image.mediaType};base64,${image.data}`),
        }]);
        void api.invoke.steer({
          chatId: chat.id,
          userPrompt: text,
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
        }).catch(() => {
          steerQueueRef.current = steerQueueRef.current.filter((item) => item.optimisticMessageId !== optimisticMessageId);
          setQueuedSteers(steerQueueRef.current.map((item) => item.text));
          setMessages((current) => current.map((message) => message.id === optimisticMessageId
            ? { id: message.id, role: "system", text: locale === "ko" ? "방향 전환을 전달하지 못했습니다. 다시 보내 주세요." : "The new direction was not delivered. Please send it again." }
            : message));
        });
        return;
      }
      void send(text, opts);
    },
    [busy, chat, locale, project, send],
  );

  // 이 채팅의 모델/작업량만 변경한다. 역할 기본값과 다른 채팅은 건드리지 않는다.
  // model === "" 이면 모델 미지정(구독 기본).
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
    const updated = await api.chats.setRuntimeSelection(chat.id, selection);
    setChat(updated);
    setActiveRuntime({
      ...activeRuntime,
      model: selection.model ?? null,
      effort: selection.effort ?? null,
      longContextEnabled: selection.longContext,
    });
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
    (messageId: string, reply: string, perQuestion: QuestionSheetAnswer[]) => {
      if (busy) return;
      setMessages((m) =>
        m.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                questions: msg.questions?.map((q) => {
                  const hit = perQuestion.find((p) => p.questionId === q.id);
                  if (hit && hit.answers.length) return { ...q, answer: hit.answers };
                  return q.answer && q.answer.length ? q : { ...q, answer: ["—"] };
                }),
              }
            : msg,
        ),
      );
      const perms = perQuestion.map((p) => inferPermissionFromAnswer(p.answers)).find(Boolean);
      // 답변 제출을 durable 영수증으로 즉시 확정 — 후속 실행이 어떤 분기로 빠지든 배지·
      // "답변 필요" 목록·시트가 이 질문을 다시 띄우지 않는다. 확정 직후 배지도 즉시 갱신.
      void ipc()?.confirm?.commitAnswer?.({ chatId, reply })
        .then(() => window.dispatchEvent(new Event("agentlas:attention-refresh")))
        .catch(() => undefined);
      void send(reply, { permissions: perms ?? DEFAULT_PERMISSION });
    },
    // send는 동일 useCallback에 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, chatId, send],
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
        return unanswered.length > 0 ? { messageId: m.id, questions: unanswered } : null;
      }
    }
    return null;
  }, [messages]);

  const handleSurfaceAction = useCallback(
    async (activeSurface: WorkbenchSurface, action: AgentlasSurfaceAction) => {
      const api = ipc();
      const manifest = activeSurface.manifest;
      if (action.type === "external-link" && action.url) {
        window.open(action.url, "_blank", "noopener,noreferrer");
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
            window.open(result.fileUrl, "_blank", "noopener,noreferrer");
            setWorkspaceOpenPersisted(true);
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
      if (!api || !chat) return;
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
          .then((c) => router.push(`/workspace/task?id=${c.id}`));
      }
    },
    [busy, chat, locale, router],
  );

  // A linked prompt may prefill or start a task, but product actions never ride in chat text.
  useEffect(() => {
    const seedPrompt = searchParams.get("prompt") ?? "";
    const seedPermission = parsePermission(
      searchParams.get("permission") ?? searchParams.get("permissions"),
    );

    if (!seedPrompt || !chat || !agent) return;
    if (seededRef.current === chatId) return;
    if (messages.length > 0) return; // 이미 히스토리 있으면 무시
    seededRef.current = chatId;
    
    if (seedPrompt) {
      // seedOnly=1 — 자동 전송하지 않고 입력창에만 채운다(프롬프트 저장소의 입력물 필요
      // 프롬프트: 사용자가 사진/문서를 첨부한 뒤 직접 전송해야 결과가 정상).
      if (searchParams.get("seedOnly") === "1") {
        setComposerPrefill(seedPrompt);
        router.replace(`/workspace/task?id=${chatId}`);
        return;
      }
      if (seedPermission === "full" && !confirmFullPermissionFromUrl(locale)) {
        router.replace(`/workspace/task?id=${chatId}`);
        return;
      }
      void send(seedPrompt, { permissions: seedPermission ?? DEFAULT_PERMISSION });
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
    if (!confirm(locale === "ko" ? "이 작업을 삭제할까요?" : "Delete this task?")) return;
    const removedId = chat.id;
    setChat(null);
    setMessages([]);
    dropChatViewSnapshot(removedId);
    await api.chats.remove(chat.id);
    router.replace("/");
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
    setChat({ ...chat, goalId: next ? "pending" : null, continuousMode: next ? true : chat.continuousMode });
    void ipc()?.chats
      .setGoalMode(chat.id, next)
      .then((updated: Chat | null) => { if (updated) setChat(updated); })
      .catch(() => setChat(previous));
  }, [chat]);
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
  // 현재(가장 최근) 에이전트 실행이 다단계 파이프라인(2+ stage)이면, 단일 에이전트라도 카드/네트워크 뷰를 켠다.
  const hasPipeline = (lastMessageOfRole(messages, "agent")?.pipeline?.length ?? 0) > 1;

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", minWidth: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <header
        className="titlebar-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 20px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
        }}
      >
        <button
          type="button"
          className="project-detail-back titlebar-nodrag"
          data-work-dashboard-return="task-header"
          onClick={() => router.push("/dashboard")}
          aria-label={locale === "ko" ? "대시보드로 돌아가기" : "Back to Dashboard"}
        >
          <IconArrowLeft size={16} />
          <span>{locale === "ko" ? "대시보드" : "Dashboard"}</span>
        </button>
        <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
          {project && (
            <div
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
                fontSize: 15,
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
                fontSize: 15,
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
          aria-label={t("chat.workspace_panel")}
          title={t("chat.workspace_panel")}
          data-active={workspaceOpen ? "true" : "false"}
        >
          <IconFolder size={16} />
        </button>
        <button
          onClick={() => (rightPanelOpen && rightPanelTab === "panel" ? closeRightPanel() : openPanelTab("panel"))}
          className="task-cockpit-header-action"
          aria-label={locale === "ko" ? "뷰어 패널" : "Viewer panel"}
          title={locale === "ko" ? "뷰어 패널" : "Viewer panel"}
          data-active={rightPanelOpen && rightPanelTab === "panel" ? "true" : "false"}
          data-has-content={artifact || surface ? "true" : "false"}
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

      <KeyStatusBanner mode="banner" />

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
          onOpenWorkflow={handleOpenWorkflow}
          onOpenMultimodalSetup={handleOpenMultimodalSetup}
          interactionBusy={busy}
          stopRequested={cancelPending}
          mediaBasePaths={mediaBasePaths}
          workspaceRoot={restoredFolder ?? defaultRunFolder ?? undefined}
          focusMessageId={requestedFocusMessageId}
        />
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
          busy={busy}
          onConfirm={(reply, perQuestion) =>
            answerQuestionBatch(pendingQuestionSheet.messageId, reply, perQuestion)
          }
          onDismiss={() => dismissQuestionBatch(pendingQuestionSheet.messageId)}
        />
      )}
      {/* Codex식: 이 대화가 폴더(프로젝트)에서 작업하는지 / 전역 대화인지 선택 */}
      {!project && <div style={{ padding: "6px 16px 0", display: "flex", alignItems: "center", gap: 8 }}>
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
            margin: "7px 16px 0", padding: "7px 10px", borderRadius: 8,
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
          tokensUsage={chatInputTokensUsage}
          showModeToggles={chat.kind !== "division"}
          continuousMode={chat.continuousMode === true}
          swarmMode={chat.swarmMode === true}
          goalActive={Boolean(chat.goalId)}
          onToggleGoal={handleToggleGoal}
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
          surface={surface}
          filePreview={mediaPreview}
          onHydrateFilePreview={openWorkspaceFilePreview}
          linkedFiles={linkedFiles}
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
        />
      )}
    </div>
  );
}
