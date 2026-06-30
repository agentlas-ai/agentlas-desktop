// 단일 채팅 페이지 — chatId 기반.
// 헤더: 채팅 제목(인라인 편집), 에이전트 정보, 삭제 버튼.
// 본문: ChatStream + 입력창.
"use client";
import { Suspense, useCallback, useEffect, useRef, useState, useMemo, type Dispatch, type SetStateAction } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import type {
  Chat,
  AgentGroupResolved,
  AgentlasSurfaceAction,
  AppFactoryAppRecord,
  AppFactoryScaffoldResult,
  ImageAttachment,
  InstalledAgent,
  InstalledFirm,
  InstalledMcpServer,
  ResolvedOrg,
  McpInvocationEvent,
  Project,
  RuntimeCommand,
  RuntimeStatus,
  ToolFactoryScaffoldResult,
  ToolFactoryToolRecord,
} from "@/lib/types";
import type { Recommendation, RecExecChoice, RecRouterAgent, RecStage } from "@shared/types";
import { ChatStream, type StreamMessage, type StreamStep, type PipelineStage } from "@/components/ChatStream";
import { extractQuestions } from "@/lib/ask-question";
import { ChatInput } from "@/components/ChatInput";
import type { SurfaceStatePatchHandler, WorkbenchSurface } from "@/components/WorkbenchPanel";
import type { LiveAgent, NetTimelineItem } from "@/components/AgentNetworkPanel";
import { ChatRightPanel, type ChatRightPanelTab } from "@/components/ChatRightPanel";
import { ProjectFolderBar } from "@/components/ProjectFolderBar";
import { AgentPicker } from "@/components/AgentPicker";
import type { CodeArtifact, MediaArtifact } from "@/components/Markdown";
import type { WorkspaceFilePreview } from "@/components/WorkspacePanel";
import { IconBuilding, IconClose, IconFolder, IconLayers, IconNetwork, IconPanelRight, IconSparkles, IconTrash } from "@/components/Icon";
import { buildAppRoutePrompt, INSTALLED_APPS, parseAppSlashRoute } from "@/lib/apps";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { surfaceApprovalRequirement, type SurfaceApprovalRequirement } from "@/lib/surface-approval";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";

function uid(): string {
  return Math.random().toString(36).slice(2);
}

function workspacePreviewFromMedia(media: MediaArtifact): WorkspaceFilePreview {
  return {
    path: media.path || media.src,
    name: media.name,
    size: 0,
    viewerKind: media.kind,
    fileUrl: media.src,
    content: "",
    truncated: false,
    reason: "binary",
  };
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
): Promise<boolean> {
  if (approval.persist) {
    try {
      if (await api.surfaces.hasApproval({ surfaceId, scopeKey: approval.scopeKey })) return true;
    } catch {
      // Continue to explicit confirmation if the ledger is temporarily unavailable.
    }
  }
  const ok = window.confirm(approval.message);
  if (!ok) return false;
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
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
    return false;
  }
  return true;
}

// 우측 패널 열림/탭 선호값 — legacy 키는 읽은 뒤 단일 키로 이관한다.
const WORKSPACE_OPEN_KEY = "agentlas.workspace.open";
const NETWORK_OPEN_KEY = "agentlas.network.open";
const RIGHT_PANEL_STATE_KEY = "agentlas.chat.right_panel";

/** picker 모델 옵션 — runtime.listModels가 실시간 조회해 채워준다. */
type ModelOption = { id: string; label: string; tag?: string };
type PermissionLevel = "read" | "write" | "full";

const DEFAULT_PERMISSION: PermissionLevel = "write";

type RightPanelPreference = { open: boolean; tab: ChatRightPanelTab };

function isRightPanelTab(raw: unknown): raw is ChatRightPanelTab {
  return raw === "file" || raw === "agent" || raw === "panel";
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

type ToolEvent = NonNullable<McpInvocationEvent["tool"]>;

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

function parseGoalSlash(input: string): string | null {
  const match = input.trim().match(/^\/goal\s+([\s\S]+)$/i);
  const goal = match?.[1]?.trim();
  return goal || null;
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
  return {
    id: entry.id,
    role,
    text: parsed.text,
    questions: parsed.questions.length > 0 ? parsed.questions : undefined,
  };
}

type GeneratedAppChatRoute = {
  action: "edit" | "archive";
  app: AppFactoryAppRecord;
  request: string;
};

const GENERATED_APP_EDIT_TERMS = [
  "edit",
  "modify",
  "change",
  "update",
  "improve",
  "fix",
  "수정",
  "고쳐",
  "바꿔",
  "변경",
  "개선",
  "업데이트",
  "고도화",
];

const GENERATED_APP_ARCHIVE_TERMS = [
  "delete",
  "remove",
  "archive",
  "uninstall",
  "삭제",
  "지워",
  "없애",
  "보관",
  "아카이브",
  "제거",
];

function normalizeGeneratedAppText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9가-힣@\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generatedAppDisplayName(app: AppFactoryAppRecord): string {
  return app.appName || app.manifest.app?.name || app.manifest.title || "Generated App";
}

function generatedAppAliases(app: AppFactoryAppRecord): string[] {
  const values = [
    generatedAppDisplayName(app),
    app.manifest.app?.name,
    app.manifest.title,
    app.manifest.app?.appType,
    app.rootPath.split(/[\\/]/).pop(),
  ];
  return [...new Set(values.map((value) => normalizeGeneratedAppText(value ?? "")).filter((value) => value.length >= 3))];
}

function detectGeneratedAppAction(input: string): GeneratedAppChatRoute["action"] | null {
  const normalized = normalizeGeneratedAppText(input);
  if (GENERATED_APP_ARCHIVE_TERMS.some((term) => normalized.includes(normalizeGeneratedAppText(term)))) {
    return "archive";
  }
  if (GENERATED_APP_EDIT_TERMS.some((term) => normalized.includes(normalizeGeneratedAppText(term)))) {
    return "edit";
  }
  return null;
}

function parseGeneratedAppChatRoute(input: string, apps: AppFactoryAppRecord[]): GeneratedAppChatRoute | null {
  const action = detectGeneratedAppAction(input);
  if (!action) return null;
  const activeApps = apps.filter((app) => app.status !== "archived");
  if (activeApps.length === 0) return null;
  const normalized = normalizeGeneratedAppText(input);
  const matches = activeApps
    .map((app) => {
      const aliases = generatedAppAliases(app);
      const bestAlias = aliases
        .filter((alias) => normalized.includes(alias) || normalized.includes(`@${alias}`))
        .sort((a, b) => b.length - a.length)[0];
      return bestAlias ? { app, score: bestAlias.length } : null;
    })
    .filter((item): item is { app: AppFactoryAppRecord; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);

  const fallbackSingleApp =
    matches.length === 0 && activeApps.length === 1 && /\bapp\b|앱/.test(normalized)
      ? activeApps[0]
      : null;
  const app = matches[0]?.app ?? fallbackSingleApp;
  if (!app) return null;
  return {
    action,
    app,
    request: input.trim(),
  };
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
  const chatId = searchParams.get("id") ?? "";
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
  const [allFirms, setAllFirms] = useState<InstalledFirm[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [allEnvKeys, setAllEnvKeys] = useState<string[]>([]);
  const [allGeneratedApps, setAllGeneratedApps] = useState<AppFactoryAppRecord[]>([]);
  const [cliCommands, setCliCommands] = useState<RuntimeCommand[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [agentGroup, setAgentGroup] = useState<AgentGroupResolved | null>(null);
  const [resolvedOrg, setResolvedOrg] = useState<ResolvedOrg | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);

  // Context volume indicator only. Actual compaction happens in the runtime
  // layer: CLI tools manage their own sessions, while BYOK/Ollama use
  // electron/runtime/compact.ts before requests are sent.
  const maxTokens = 100000;
  const currentTokens = useMemo(() => {
    return messages.reduce((acc, msg) => acc + (msg.tokens ?? Math.floor((msg.text?.length || 0) / 4)), 0);
  }, [messages]);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  // 멀티 에이전트 실시간 텔레메트리 — 속성(agentId) 이벤트로 채워지는 네트워크 패널 상태.
  const [liveAgents, setLiveAgents] = useState<Record<string, LiveAgent>>({});
  const [netTimeline, setNetTimeline] = useState<NetTimelineItem[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const subRef = useRef<(() => void) | null>(null);
  const seededRef = useRef<string>("");
  // 활성 런타임/모델 — 헤더 칩 표시 + BYOK 인라인 모델 변경. 진행 중 실행의 runId(취소용).
  const [activeRuntime, setActiveRuntime] = useState<RuntimeStatus | null>(null);
  // 활성 런타임의 모델 목록 — 실시간 조회(BYOK는 provider API, ollama 동적, CLI 카탈로그).
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const runIdRef = useRef<string | null>(null);
  const lastRunIdRef = useRef<string | null>(null);
  // runId가 도착하기 전(invoke:run 왕복 중)에 Stop을 누른 경우를 기억 — 도착 즉시 취소한다.
  const cancelRequestedRef = useRef(false);
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null);
  const [surface, setSurface] = useState<WorkbenchSurface | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceFilePreview | null>(null);
  const [scaffoldedApps, setScaffoldedApps] = useState<Record<string, AppFactoryScaffoldResult>>({});
  const [scaffoldedTools, setScaffoldedTools] = useState<Record<string, ToolFactoryScaffoldResult>>({});
  // 우측 패널 — file / agent / panel 탭을 하나의 rail 안에서 전환한다.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<ChatRightPanelTab>("agent");
  const workspaceOpen = rightPanelOpen && rightPanelTab === "file";
  const networkOpen = rightPanelOpen && rightPanelTab === "agent";
  // 슬래시 명령(/folder·/global)으로 워킹 폴더를 바꾸면 하단 폴더 바를 다시 읽게 하는 토큰
  const [folderReload, setFolderReload] = useState(0);
  // ContinuityReceipt(복원 배너)용 — 채팅 진입 시 ipc().workspace.get으로 복원된 마지막 작업 폴더.
  // 기기 간 클라우드 복원 여부는 백엔드 미확인이므로, 실제로 알 수 있는 사실(로컬 복원 경로)만 보여준다.
  const [restoredFolder, setRestoredFolder] = useState<string | null>(null);

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

  // 한 실행의 이벤트(라이브 스트림 OR 재접속 리플레이)를 메인 버블 + 네트워크 패널에 반영.
  // send()의 인라인 핸들러를 추출해 재접속 경로와 공유 — lastStatusRef는 중복 status 억제용(공유).
  const consumeEvent = useCallback(
    (ev: McpInvocationEvent, placeholderId: string, lastStatusRef: { text: string }) => {
      const fallbackAgentId = agent?.id ?? "active-agent";
      const fallbackAgentName =
        agentGroup?.orchestratorName ||
        (agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback"));
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
      if (ev.kind === "tool-use" && ev.tool) {
        pushWorkflow("tool", ev.status?.trim() || toolWorkflowText(ev.tool, locale), {
          toolName: ev.tool.name,
          tokens: ev.tokens,
        });
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  ...msg,
                  steps: mergeToolStep(msg.steps ?? [], ev.tool!, {
                    ...fallbackStepMeta,
                    activity: "tool",
                  }),
                }
              : msg,
          ),
        );
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
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== placeholderId) return msg;
            const raw = ev.text ?? "";
            const { text, questions } = extractQuestions(raw, msg.id);
            return {
              ...msg,
              text,
              streaming: true,
              questions: questions.length > 0 ? questions : msg.questions,
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
            return {
              ...msg,
              text,
              busy: false,
              streaming: false,
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
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
        lastRunIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
        // 첫 메시지였으면 main이 자동 제목 생성 → 갱신해서 사이드바도 반영
        const api = ipc();
        void api?.chats.get(chatId).then((c) => {
          if (c) setChat(c);
          window.dispatchEvent(new CustomEvent("agentlas:chat-changed", { detail: { id: chatId } }));
        });
      } else if (ev.kind === "error") {
        pushWorkflow("status", ev.error?.message ?? t("chat.err.unknown"));
        setMessages((m) => [
          ...m.filter((msg) => msg.id !== placeholderId),
          { id: uid(), role: "system", text: `⚠️ ${ev.error?.message ?? t("chat.err.unknown")}` },
        ]);
        setBusy(false);
        setCancelPending(false);
        cancelRequestedRef.current = false;
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
        lastRunIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
      }
    },
    [agent, agentGroup, chatId, locale, openPanelTab, t],
  );

  // runId 채널 구독 — send()와 재접속 경로 공용. lastStatusRef를 받으면(리플레이 후) 이어서 쓴다.
  const subscribeRun = useCallback(
    (runId: string, placeholderId: string, lastStatusRef: { text: string } = { text: "" }) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events) return;
      const channel = api.invoke.eventChannel(runId);
      subRef.current?.();
      subRef.current = events.on(channel, (ev: McpInvocationEvent) =>
        consumeEvent(ev, placeholderId, lastStatusRef),
      );
    },
    [consumeEvent],
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

  // 채팅 전환 시 이전 채팅의 진행 상태(busy/정지버튼/스트림)가 새 뷰로 새지 않게 리셋.
  // 메타데이터 effect는 번역/콜백 변화에도 다시 돌 수 있으므로, 전환 초기화는 chatId에만 묶는다.
  useEffect(() => {
    if (!chatId) return;
    setBusy(false);
    setCancelPending(false);
    runIdRef.current = null;
    lastRunIdRef.current = null;
    cancelRequestedRef.current = false;
    setArtifact(null);
    setSurface(null);
    setMediaPreview(null);
    setRightPanelOpen(false);
    setRightPanelTab("agent");
    setLiveAgents({});
    setNetTimeline([]);
    setScaffoldedApps({});
    setScaffoldedTools({});
    setInstalledPlugins([]);
    setAllGeneratedApps([]);
    setRestoredFolder(null);
    return () => {
      subRef.current?.();
      subRef.current = null;
    };
  }, [chatId]);

  // 메타데이터 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    void (async () => {
      const c = await api.chats.get(chatId);
      if (cancelled || !c) {
        if (!c) router.replace("/");
        return;
      }
      setChat(c);
      setTitleDraft(c.title);
      const [agents, history, projectsAll, firmsAll, envVars, plugins, generatedApps] = await Promise.all([
        api.team.list(),
        api.invoke.history(chatId),
        api.projects.list(),
        api.firms.list(),
        api.env.list(),
        api.mcpTools.listInstalled(),
        api.appFactory.listApps(),
      ]);
      if (cancelled) return;
      setAllAgents(agents);
      setAllProjects(projectsAll);
      setAllFirms(firmsAll);
      setInstalledPlugins(plugins);
      setAllGeneratedApps(generatedApps.filter((app) => app.status !== "archived"));
      // @ 멘션 popover에는 실제로 값이 저장된 키만 노출 — 비어있는 키를 멘션하면 invocation에서 빈 값이 주입돼 혼란.
      setAllEnvKeys(envVars.filter((e) => e.hasValue).map((e) => e.key));
      // CLI 슬래시 명령 스캔 (매 진입 시 최신) — 느려도 채팅 표시를 막지 않게 후속 로드.
      void api.runtime.listCommands().then((cmds) => {
        if (!cancelled) setCliCommands(cmds);
      });
      // 활성 런타임/모델 — 헤더 칩 표시용.
      void api.runtime.detect().then((list) => {
        if (!cancelled) setActiveRuntime(list.find((r) => r.active) ?? null);
      });
      setAgent(agents.find((a) => a.id === c.agentId) ?? null);
      if (c.agentGroupId) {
        void api.agentGroups.getResolved(c.agentGroupId).then((group) => {
          if (!cancelled) setAgentGroup(group);
        });
      } else {
        setAgentGroup(null);
      }
      // 패널 노출 결정: 사용자가 명시적으로 접고/편 선호값이 있으면 그것을 우선,
      // 없으면 working_folder가 저장돼 있을 때만 자동 노출.
      const savedFolder = await api.workspace.get(chatId);
      const rightPanelPreference = readRightPanelPreference();
      if (!cancelled) {
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
      }
      if (c.projectId) {
        const p = await api.projects.get(c.projectId);
        if (!cancelled) setProject(p);
      }
      if (c.firmId) {
        const f = await api.firms.get(c.firmId);
        if (!cancelled) setFirm(f);
        // 네트워크 패널 명단용 — 정규화된 3-tier 조직 (리졸버 결과 또는 orgChart 파생)
        void api.firms.getResolvedOrg(c.firmId).then((o) => {
          if (!cancelled) setResolvedOrg(o);
        });
      } else {
        setFirm(null);
        setResolvedOrg(null);
      }
      const historyMessages: StreamMessage[] = history.map(historyEntryToStreamMessage);
      setMessages((current) => {
        const hasLiveDraft = current.some((msg) => msg.busy || msg.streaming);
        return hasLiveDraft ? current : historyMessages;
      });
      // 진행 중 실행 재접속 — 이 채팅이 백그라운드로 돌고 있으면(다른 채팅 갔다 옴) 스트림·정지버튼 복구.
      // 버퍼된 이벤트를 리플레이해 진행 중 버블을 재구성하고, runId 채널을 구독해 이후 스트림을 받는다.
      const attached = await api.invoke.attach(chatId);
      if (!cancelled && attached) {
        const placeholderId = uid();
        const startedAt = Date.now();
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
        for (const ev of attached.events) consumeEvent(ev, placeholderId, lastStatusRef);
        subscribeRun(attached.runId, placeholderId, lastStatusRef);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, router, consumeEvent, subscribeRun, t]);

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
      if (!runIdRef.current || ids.includes(chatId)) return;
      runIdRef.current = null;
      subRef.current?.();
      subRef.current = null;
      setBusy(false);
      setCancelPending(false);
      setLiveAgents((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
      );
      void api.invoke.history(chatId).then((h) => {
        setMessages(h.map(historyEntryToStreamMessage));
      });
    });
  }, [chatId]);

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
      try {
        const ids = await api.invoke.activeChats();
        if (stopped || !runIdRef.current || ids.includes(chatId)) return;
        // main은 이 실행을 끝냈는데 UI는 여전히 진행중 → final/activeChats를 놓친 것. 화해.
        runIdRef.current = null;
        lastRunIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
        setBusy(false);
        setCancelPending(false);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        const h = await api.invoke.history(chatId);
        if (!stopped) setMessages(h.map(historyEntryToStreamMessage));
      } catch {
        /* 무시 — 다음 틱에 재시도 */
      }
    };
    const first = setTimeout(reconcile, 700);
    const iv = setInterval(reconcile, 2500);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [busy, chatId]);

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
        /** Router Agent 에스컬레이션 — main 런타임이 시스템 프롬프트 앞에 주입한다. */
        routerAgent?: RecRouterAgent;
      },
    ) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events || !chat || busy) return false;
      setCancelPending(false);
      const goalPrompt = parseGoalSlash(userPrompt);
      const routeInput = goalPrompt ?? userPrompt;
      const appRoute = parseAppSlashRoute(routeInput);
      if (appRoute && !appRoute.request && appRoute.app.route !== "/chat") {
        router.push(appRoute.app.route);
        return true;
      }
      const generatedAppRoute = appRoute ? null : parseGeneratedAppChatRoute(routeInput, allGeneratedApps);
      if (generatedAppRoute?.action === "archive") {
        const appName = generatedAppDisplayName(generatedAppRoute.app);
        const placeholderId = uid();
        setMessages((m) => [
          ...m,
          { id: uid(), role: "user", text: userPrompt },
          {
            id: placeholderId,
            role: "agent",
            text: locale === "ko" ? `${appName}을 Apps 목록에서 숨기는 중...` : `Hiding ${appName} from Apps...`,
            busy: true,
            startedAt: Date.now(),
          },
        ]);
        setBusy(true);
        setCancelPending(false);
        try {
          await api.appFactory.archive({ rootPath: generatedAppRoute.app.rootPath });
          setAllGeneratedApps((apps) => apps.filter((app) => app.id !== generatedAppRoute.app.id));
          setMessages((m) =>
            m.map((msg) =>
              msg.id === placeholderId
                ? {
                    ...msg,
                    busy: false,
                    text:
                      locale === "ko"
                        ? `${appName}을 Apps 목록에서 숨겼습니다. 파일은 복원 가능한 보관함에 남아 있습니다.`
                        : `${appName} was hidden from Apps and kept in a reversible archive.`,
                  }
                : msg,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((m) =>
            m.map((msg) =>
              msg.id === placeholderId
                ? { ...msg, role: "system", busy: false, text: `⚠️ ${message || t("chat.err.unknown")}` }
                : msg,
            ),
          );
        } finally {
          setBusy(false);
          setCancelPending(false);
        }
        return true;
      }
      const invocationPrompt = appRoute ? buildAppRoutePrompt(appRoute, locale) : routeInput;
      const visiblePrompt = appRoute ? `${appRoute.command} ${appRoute.request}`.trim() : userPrompt;
      const images = opts?.images;
      const placeholderId = uid();
      const imageDataUrls = images?.map(
        (img) => `data:${img.mediaType};base64,${img.data}`,
      );
      const startedAt = Date.now();
      const initialStatus = t("chat.status.sending");
      const activeAgentId = agent?.id ?? chat.agentId ?? "active-agent";
      const activeAgentName = agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback");
      setMessages((m) => [
        ...m,
        { id: uid(), role: "user", text: visiblePrompt, imageDataUrls },
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
      setNetworkOpenPersisted(true);
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

      try {
        // locale을 동봉 — main이 emit하는 상태/오류 메시지가 사용자 언어로 나오도록.
        const invokeResult = await api.invoke.run({
          chatId: chat.id,
          userPrompt: invocationPrompt,
          images,
          locale,
          permissions: opts?.permissions ?? DEFAULT_PERMISSION,
          planMode: opts?.planMode,
          goalMode: opts?.goalMode || Boolean(goalPrompt),
          appsGenerateMode: opts?.appsGenerateMode || Boolean(appRoute),
          targetAppId: generatedAppRoute?.action === "edit" ? generatedAppRoute.app.id : undefined,
          targetAppAction: generatedAppRoute?.action === "edit" ? "edit" : undefined,
          borrowAgents: opts?.borrowAgents,
          pipelineStages: opts?.pipelineStages,
          routerAgent: opts?.routerAgent,
        });
        const { runId } = invokeResult;
        window.dispatchEvent(new CustomEvent("agentlas:chat-changed", { detail: { id: chat.id } }));
        runIdRef.current = runId;
        lastRunIdRef.current = runId;
        // 이벤트 처리는 consumeEvent로 추출됨 — 재접속(attach) 경로와 동일 로직 공유.
        subscribeRun(runId, placeholderId);
        // runId 도착 전에 Stop을 눌렀다면(레이스) 구독을 건 직후 즉시 취소 — abort 종료 이벤트를 수신해 busy 해제.
        if (cancelRequestedRef.current) {
          void api.invoke.cancel(runId);
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === placeholderId
              ? {
                  id: msg.id,
                  role: "system",
                  text: `⚠️ ${message || t("chat.err.unknown")}`,
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
    [agent, allGeneratedApps, chat, busy, locale, router, setNetworkOpenPersisted, t, subscribeRun],
  );

  // 진행 중 실행 취소 — 입력창의 정지 버튼(전송 버튼이 busy일 때 변신) / Cmd/Ctrl+Esc.
  const stop = useCallback(() => {
    const api = ipc();
    if (!api) return;
    if (cancelRequestedRef.current) return;
    setCancelPending(true);
    cancelRequestedRef.current = true;
    // runId가 아직 안 왔으면(invoke:run 왕복 중) 취소 의사만 기록 → 도착 즉시 취소된다.
    const runId = runIdRef.current ?? lastRunIdRef.current;
    if (!runId) return;
    void api.invoke.cancel(runId);
  }, []);

  // 활성 모델/작업량을 입력창 picker에서 바로 변경 — BYOK 및 CLI 공통.
  // model === "" 이면 모델 미지정(구독 기본). effort는 명시할 때만 갱신.
  async function applySelection(patch: { model?: string; effort?: string }) {
    const api = ipc();
    if (!api || !activeRuntime) return;
    await api.runtime.setActive({
      kind: activeRuntime.kind,
      backend: activeRuntime.backend,
      source: activeRuntime.source,
      model: patch.model !== undefined ? patch.model || undefined : activeRuntime.model ?? undefined,
      longContext:
        activeRuntime.kind === "byok" ? (activeRuntime.longContextEnabled ?? false) : undefined,
      effort: patch.effort,
    });
    const list = await api.runtime.detect();
    setActiveRuntime(list.find((r) => r.active) ?? null);
  }
  const switchModel = (model: string) => void applySelection({ model });
  const switchEffort = (effort: string) => void applySelection({ effort });

  /**
   * 에이전트가 emit한 질문(<<agentlas-ask>>)에 사용자가 답함.
   * — 해당 메시지의 questions 배열에서 그 질문을 'answered'로 표시(잠금)
   * — 답변 라벨을 user 메시지로 즉시 전송하여 에이전트에 컨텍스트 전달
   */
  const answerQuestion = useCallback(
    (messageId: string, questionId: string, answers: string[]) => {
      if (busy) return;
      setMessages((m) =>
        m.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                questions: msg.questions?.map((q) =>
                  q.id === questionId ? { ...q, answer: answers } : q,
                ),
              }
            : msg,
        ),
      );
      // 사용자의 선택을 자연어로 묶어 user 메시지로 보냄
      const reply = answers.length === 1 ? answers[0] : answers.map((a) => `• ${a}`).join("\n");
      void send(reply, {
        permissions: inferPermissionFromAnswer(answers) ?? DEFAULT_PERMISSION,
      });
    },
    // send는 동일 useCallback에 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, send],
  );

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
        if (approval && !(await ensureSurfaceApproval(api, activeSurface.id, action, approval))) return;
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
            return restored;
          }
          const result = await api.appFactory.scaffold({
            chatId,
            surfaceId: activeSurface.id,
            actionId: action.id,
            manifest,
          });
          setScaffoldedApps((prev) => ({ ...prev, [activeSurface.id]: result }));
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
          const appRegistryPath = scaffold.record?.id ? `/apps/generated?id=${scaffold.record.id}` : "/apps";
          const launchUrl = scaffold.launchUrl || scaffold.previewPath;
          const devCommand = scaffold.devCommand || "node scripts/serve.mjs";
          if (action.type === "scaffold-app") {
            update(
              [
                `App scaffold ready: ${scaffold.appName}`,
                "",
                `Apps registry: ${appRegistryPath}`,
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
                `Apps registry: ${appRegistryPath}`,
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
          const message = err instanceof Error ? err.message : String(err);
          update(`${action.label} failed: ${message}`);
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
      if (api && approval && !(await ensureSurfaceApproval(api, activeSurface.id, action, approval))) return;

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
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((m) => [
          ...m,
          {
            id: uid(),
            role: "system",
            text: `Surface state was not saved: ${message}`,
          },
        ]);
      });
  }, []);

  // 슬래시 커맨드 실행 — /new(새 채팅) /clear(기록 지우기) /help(단축키)
  const handleCommand = useCallback(
    (cmd: string) => {
      if (cmd === "/apps") {
        router.push("/apps");
        return;
      }
      if (cmd === "/docstudio" || cmd === "/document-studio" || cmd === "/문서스튜디오") {
        router.push("/apps/document-studio");
        return;
      }
      const api = ipc();
      if (!api || !chat) return;
      if (cmd === "/clear") {
        void api.invoke.clearHistory(chat.id).then(() => {
          setMessages([]);
          window.dispatchEvent(new CustomEvent("agentlas:chat-changed", { detail: { id: chat.id } }));
        });
      } else if (cmd === "/new") {
        void api.chats
          .create({ agentId: chat.agentId, projectId: chat.projectId, firmId: chat.firmId, agentGroupId: chat.agentGroupId })
          .then((c) => router.push(`/chat?id=${c.id}`));
      } else if (cmd === "/folder") {
        void api.fs.pickDirectory().then((p) => {
          if (!p) return;
          void api.workspace.set(chat.id, p).then(() => {
            setWorkspaceOpenPersisted(true);
            setFolderReload((n) => n + 1);
          });
        });
      } else if (cmd === "/global") {
        void api.workspace.set(chat.id, null).then(() => setFolderReload((n) => n + 1));
      } else if (cmd === "/rename") {
        setEditingTitle(true);
      } else if (cmd === "/help") {
        setMessages((m) => [...m, { id: uid(), role: "system", text: t("chatinput.cmd.help_text") }]);
      } else {
        // Fallback for app slash commands like /hep-network startup
        void send(cmd, { permissions: DEFAULT_PERMISSION });
      }
    },
    [chat, router, t, setWorkspaceOpenPersisted, send],
  );

  // 홈 composer에서 ?prompt=... 또는 앱의 ?cmd=...로 넘어왔을 때
  useEffect(() => {
    const seedPrompt = searchParams.get("prompt") ?? "";
    const seedCmd = searchParams.get("cmd") ?? "";
    const seedPermission = parsePermission(
      searchParams.get("permission") ?? searchParams.get("permissions"),
    );

    if ((!seedPrompt && !seedCmd) || !chat || !agent) return;
    if (seededRef.current === chatId) return;
    if (messages.length > 0) return; // 이미 히스토리 있으면 무시
    seededRef.current = chatId;
    
    if (seedCmd) {
      handleCommand(seedCmd);
      router.replace(`/chat?id=${chatId}`);
    } else if (seedPrompt) {
      if (seedPermission === "full" && !confirmFullPermissionFromUrl(locale)) {
        router.replace(`/chat?id=${chatId}`);
        return;
      }
      void send(seedPrompt, { permissions: seedPermission ?? DEFAULT_PERMISSION });
      router.replace(`/chat?id=${chatId}`);
    }
  }, [chat, agent, chatId, locale, messages.length, send, handleCommand, router, searchParams]);

  async function switchAgent(agentId: string) {
    const api = ipc();
    if (!api || !chat || agentId === chat.agentId) return;
    const updated = await api.chats.switchAgent(chat.id, agentId);
    setChat(updated);
    setAgent(allAgents.find((a) => a.id === agentId) ?? null);
    setFirm(null); // switchAgent는 firm을 해제
    setAgentGroup(null);
  }

  // 추천 토글 ON → 보내기 전 라우터 미리보기. routeOnly(실행 없음)를 정규화해 추천 시트에 넘긴다.
  // 실패/비가용 시에도 throw 하지 않고 null → 시트가 "그냥 보내기" 폴백을 보여준다.
  async function handleRecommendPreview(text: string): Promise<Recommendation | null> {
    const api = ipc();
    if (!api || !chat) return null;
    const folder = await api.workspace.get(chat.id).catch(() => null);
    try {
      return await api.hephaestus.routePreview({
        query: text,
        project: folder ?? undefined,
        allowLocal: true, // 로컬 카드 + 허브 혼합 추천
      });
    } catch {
      return null;
    }
  }

  // 추천 시트에서 고른 경로를 실제 실행으로 디스패치. 기존 send/switchAgent 경로를 그대로 재사용한다.
  function handleRecommendExecute(
    choice: RecExecChoice,
    text: string,
    opts: { images?: ImageAttachment[]; permissions?: PermissionLevel; planMode?: boolean; goalMode?: boolean; appsGenerateMode?: boolean },
  ) {
    const sendOpts = {
      images: opts?.images,
      permissions: opts?.permissions,
      planMode: opts?.planMode,
      goalMode: opts?.goalMode,
      appsGenerateMode: opts?.appsGenerateMode,
      routerAgent: choice.kind === "plain" ? undefined : choice.routerAgent,
    };
    switch (choice.kind) {
      case "agent":
        // 팀/회사 추천은 파괴적 rebind(switchAgent=firm_id NULL)를 피해 네트워크 경로로 실행한다.
        if (choice.isFirm) {
          void send(`hep-network ${text}`, sendOpts);
        } else {
          void switchAgent(choice.agentId).then(() => send(text, sendOpts));
        }
        break;
      case "network":
        // 고른 Hub 에이전트를 borrow 해서 실행(BYOM). 선택이 없으면(혹시) 네트워크 라우팅 폴백.
        if (choice.agents && choice.agents.length > 0) {
          void send(text, { ...sendOpts, borrowAgents: choice.agents });
        } else {
          void send(`hep-network ${text}`, sendOpts);
        }
        break;
      case "pipeline": {
        // 단계 계획을 플레이스홀더 메시지 상단 스테퍼로 보여준다(PRD→배포 가시화).
        void send(`stormbreaker ${text}`, {
          ...sendOpts,
          pipelineStages: choice.stages?.length ? choice.stages : undefined,
        });
        break;
      }
      case "plain":
      default:
        void send(text, sendOpts);
        break;
    }
  }

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
    if (!confirm(t("chat.confirm_delete"))) return;
    const removedId = chat.id;
    setChat(null);
    setMessages([]);
    window.dispatchEvent(new CustomEvent("agentlas:chat-removed", { detail: { id: removedId } }));
    await api.chats.remove(chat.id);
    router.replace("/");
  }

  if (!chat) {
    if (chatId) return null; // 특정 채팅 로딩 중
    return (
      <div style={{ display: "flex", flex: 1, height: "100%", width: "100%", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 440 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginBottom: 8 }}>{t("chat.empty.title")}</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-soft)" }}>{t("chat.empty.hint")}</div>
        </div>
      </div>
    );
  }
  const displayAgents = visibleAgents(allAgents);
  const displayAgent = agent?.visibility === "background" ? null : agent;
  const latestUserPrompt = [...messages].reverse().find((message) => message.role === "user")?.text ?? "";

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
        {agentGroup ? (
          <div
            className="titlebar-nodrag"
            title={agentGroup.description || agentGroup.name}
            style={{
              maxWidth: 420,
              minWidth: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 9px",
              borderRadius: 9,
              border: "1px solid var(--accent-soft)",
              background: "var(--fill-1)",
              color: "var(--ink)",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "var(--accent)",
                color: "white",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <IconLayers size={14} />
            </span>
            <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
              <strong
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {agentGroup.name}
              </strong>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--muted-deep)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {agentGroup.orchestratorName}
                {agentGroup.warningCount > 0
                  ? ` · ${agentGroup.warningCount}${locale === "ko" ? "개 경고" : " warning"}`
                  : ""}
              </span>
            </span>
          </div>
        ) : displayAgent && displayAgents.length > 0 && (
          <AgentPicker
            agents={displayAgents}
            activeId={displayAgent.id}
            onChange={(id) => void switchAgent(id)}
            ariaLabel={t("chat.switch_agent")}
            maxButtonWidth={firm ? 420 : 232}
            activePrefix={
              firm ? (
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: "var(--paper-edge)",
                    color: "var(--ink-soft)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <IconBuilding size={14} />
                </span>
              ) : undefined
            }
            activeBadge={
              firm ? (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 999,
                    background: "var(--paper)",
                    color: "var(--ink-soft)",
                    border: "1px solid var(--paper-edge)",
                    fontWeight: 700,
                    maxWidth: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  CEO · {pickLocalized(firm, locale).name}
                </span>
              ) : undefined
            }
            buttonStyle={
              firm
                ? { background: "var(--fill-1)", border: "1px solid var(--accent-soft)" }
                : undefined
            }
          />
        )}
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
              {chat.title.trim() || t("chat.untitled")}
            </div>
          )}
        </div>
        {/* BYOC 키/구독 상태 pill — 키 사망이 가장 흔한 실패이므로 헤더에 상시 노출 */}
        <span className="titlebar-nodrag" style={{ flexShrink: 0, display: "inline-flex" }}>
          <KeyStatusBanner mode="pill" />
        </span>
        <button
          onClick={() => (networkOpen ? closeRightPanel() : setNetworkOpenPersisted(true))}
          className="titlebar-nodrag"
          data-tour-id="workspace.workflow-toggle"
          aria-label={t("chat.network_panel")}
          title={t("chat.network_panel")}
          style={{
            color: networkOpen ? "var(--accent)" : "var(--muted-deep)",
            background: networkOpen ? "var(--fill-1)" : "transparent",
            padding: 6,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <IconNetwork size={16} />
        </button>
        <button
          onClick={() => (workspaceOpen ? closeRightPanel() : setWorkspaceOpenPersisted(true))}
          className="titlebar-nodrag"
          aria-label={t("chat.workspace_panel")}
          title={t("chat.workspace_panel")}
          style={{
            color: workspaceOpen ? "var(--accent)" : "var(--muted-deep)",
            background: workspaceOpen ? "var(--fill-1)" : "transparent",
            padding: 6,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <IconFolder size={16} />
        </button>
        <button
          onClick={() => (rightPanelOpen && rightPanelTab === "panel" ? closeRightPanel() : openPanelTab("panel"))}
          className="titlebar-nodrag"
          aria-label={locale === "ko" ? "뷰어 패널" : "Viewer panel"}
          title={locale === "ko" ? "뷰어 패널" : "Viewer panel"}
          style={{
            color: rightPanelOpen && rightPanelTab === "panel" ? "var(--accent)" : artifact || surface ? "var(--ink-soft)" : "var(--muted-deep)",
            background: rightPanelOpen && rightPanelTab === "panel" ? "var(--fill-1)" : "transparent",
            padding: 6,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <IconPanelRight size={16} />
        </button>
        <button
          onClick={() => void removeChat()}
          className="titlebar-nodrag"
          aria-label={t("chat.delete")}
          title={t("chat.delete")}
          style={{
            color: "var(--muted-deep)",
            padding: 6,
            borderRadius: 6,
          }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      {/* ContinuityReceipt(복원 배너) — 실제로 알 수 있는 사실만: 마지막 작업 폴더가 로컬에서
          복원됐다는 점. 기기 간 클라우드 동기화는 백엔드 미확인이라 단정하지 않는다.
          복원할 폴더가 없으면 렌더하지 않는다. */}
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
            title={restoredFolder}
          >
            {restoredFolder}
          </code>
          <button
            onClick={() => setRestoredFolder(null)}
            aria-label={t("chat.untitled") /* 일반 닫기 — 전용 키 없음 */}
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

      <div data-tour-id="workspace.chat" style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <ChatStream
          messages={messages}
          agentName={agentGroup?.orchestratorName || (displayAgent ? pickLocalized(displayAgent, locale).name : t("chat.assistant_fallback"))}
          agentTone={agentGroup ? "green" : displayAgent?.tone ?? "blue"}
          emptyDirectory={{
            apps: INSTALLED_APPS,
            agents: displayAgents,
            firms: allFirms,
            projects: allProjects,
            envKeys: allEnvKeys,
            commands: cliCommands,
            plugins: installedPlugins,
          }}
          onOpenArtifact={(a) => {
            setSurface(null);
            setMediaPreview(null);
            setArtifact(a);
            openPanelTab("panel");
          }}
          onOpenMedia={(media) => {
            setSurface(null);
            setArtifact(null);
            setMediaPreview(workspacePreviewFromMedia(media));
            openPanelTab("panel");
          }}
          onOpenWorkflow={() => setNetworkOpenPersisted(true)}
          onStop={stop}
          onAnswerQuestion={answerQuestion}
          interactionBusy={busy}
          stopRequested={cancelPending}
        />
      </div>
      {/* Codex식: 이 대화가 폴더(프로젝트)에서 작업하는지 / 전역 대화인지 선택 */}
      <div style={{ padding: "6px 16px 0", display: "flex" }}>
        <ProjectFolderBar
          chatId={chatId || null}
          reloadToken={folderReload}
          onOpenPanel={() => setWorkspaceOpenPersisted(true)}
          onChanged={(f) => {
            if (f) setWorkspaceOpenPersisted(true);
          }}
        />
      </div>
      <div data-tour-id="workspace.input" style={{ flexShrink: 0, minWidth: 0 }}>
        <ChatInput
          onSend={(text, opts) => {
            void send(text, {
              images: opts?.images,
              permissions: opts?.permissions,
              planMode: opts?.planMode,
              goalMode: opts?.goalMode,
              appsGenerateMode: opts?.appsGenerateMode,
            });
          }}
          onCommand={handleCommand}
          onCallAgent={(agentId) => void switchAgent(agentId)}
          onRecommendPreview={handleRecommendPreview}
          onRecommendExecute={handleRecommendExecute}
          onStop={stop}
          stopRequested={cancelPending}
          activeAgentId={agent?.id ?? chat.agentId ?? null}
          busy={busy}
          disabled={!agent}
          context={{
            agents: displayAgents,
            projects: allProjects,
            firms: allFirms,
            apps: INSTALLED_APPS,
            generatedApps: allGeneratedApps,
            envKeys: allEnvKeys,
            commands: cliCommands,
          }}
          runtime={activeRuntime}
          modelOptions={modelOptions}
          onSelectModel={switchModel}
          onSelectEffort={switchEffort}
          tokensUsage={{ current: currentTokens, limit: maxTokens }}
        />
      </div>
      </div>
      {rightPanelOpen && (
        <ChatRightPanel
          key={chatId || "new-chat"}
          activeTab={rightPanelTab}
          onTabChange={openPanelTab}
          onClose={closeRightPanel}
          chatId={chatId || null}
          artifact={artifact}
          surface={surface}
          filePreview={mediaPreview}
          generatedApps={allGeneratedApps}
          onSurfaceAction={handleSurfaceAction}
          onSurfaceStatePatch={handleSurfaceStatePatch}
          firm={firm}
          org={resolvedOrg}
          agent={displayAgent}
          agents={displayAgents}
          busy={busy}
          liveAgents={liveAgents}
          timeline={netTimeline}
          chatTitle={chat.title}
          latestUserPrompt={latestUserPrompt}
        />
      )}
    </div>
  );
}
