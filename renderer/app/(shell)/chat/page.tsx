// 단일 채팅 페이지 — chatId 기반.
// 헤더: 채팅 제목(인라인 편집), 에이전트 정보, 삭제 버튼.
// 본문: ChatStream + 입력창.
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
import { ChatStream, type StreamMessage, type StreamStep } from "@/components/ChatStream";
import { extractQuestions } from "@/lib/ask-question";
import { ChatInput } from "@/components/ChatInput";
import { WorkbenchPanel, type SurfaceStatePatchHandler, type WorkbenchSurface } from "@/components/WorkbenchPanel";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { AgentNetworkPanel, type LiveAgent, type NetTimelineItem } from "@/components/AgentNetworkPanel";
import { ProjectFolderBar } from "@/components/ProjectFolderBar";
import { AgentPicker } from "@/components/AgentPicker";
import type { CodeArtifact } from "@/components/Markdown";
import { IconBuilding, IconFolder, IconNetwork, IconSparkles, IconTrash } from "@/components/Icon";
import { buildAppRoutePrompt, INSTALLED_APPS, parseAppSlashRoute } from "@/lib/apps";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { surfaceApprovalRequirement, type SurfaceApprovalRequirement } from "@/lib/surface-approval";

function uid(): string {
  return Math.random().toString(36).slice(2);
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

// 우측 워크스페이스 패널 열림/접힘 선호값 — 채팅 간 이동에도 유지.
const WORKSPACE_OPEN_KEY = "agentlas.workspace.open";
const NETWORK_OPEN_KEY = "agentlas.network.open";

/** picker 모델 옵션 — runtime.listModels가 실시간 조회해 채워준다. */
type ModelOption = { id: string; label: string; tag?: string };
type PermissionLevel = "read" | "write" | "full";

const DEFAULT_PERMISSION: PermissionLevel = "write";

function parsePermission(raw: string | null): PermissionLevel | undefined {
  return raw === "read" || raw === "write" || raw === "full" ? raw : undefined;
}

function inferPermissionFromAnswer(answers: string[]): PermissionLevel | undefined {
  const joined = answers.join(" ").toLowerCase();
  if (/\bfull\b|전체 권한/.test(joined)) return "full";
  if (/\bwrite\b|쓰기|편집/.test(joined)) return "write";
  if (/\bread\b|읽기만/.test(joined)) return "read";
  return undefined;
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
  const [resolvedOrg, setResolvedOrg] = useState<ResolvedOrg | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);

  // Context Volume Management
  const maxTokens = 100000;
  const currentTokens = useMemo(() => {
    return messages.reduce((acc, msg) => acc + (msg.tokens ?? Math.floor((msg.text?.length || 0) / 4)), 0);
  }, [messages]);

  // Codex-style Auto Compression
  useEffect(() => {
    if (currentTokens > maxTokens && messages.length > 2) {
      setMessages((prev) => {
        const toCompress = prev.slice(0, prev.length - 2);
        const tail = prev.slice(prev.length - 2);
        
        if (toCompress.length === 1 && toCompress[0].id === "system-compressed") return prev;

        const compressedMsg: StreamMessage = {
          id: "system-compressed",
          role: "system",
          text: "이전 대화가 자동으로 압축되었습니다 (Context auto-compressed to save tokens).",
          tokens: 50,
        };
        return [compressedMsg, ...tail];
      });
    }
  }, [currentTokens, maxTokens, messages.length]);
  const [busy, setBusy] = useState(false);
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
  // runId가 도착하기 전(invoke:run 왕복 중)에 Stop을 누른 경우를 기억 — 도착 즉시 취소한다.
  const cancelRequestedRef = useRef(false);
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null);
  const [surface, setSurface] = useState<WorkbenchSurface | null>(null);
  const [scaffoldedApps, setScaffoldedApps] = useState<Record<string, AppFactoryScaffoldResult>>({});
  const [scaffoldedTools, setScaffoldedTools] = useState<Record<string, ToolFactoryScaffoldResult>>({});
  // 우측 워크스페이스 패널 — 채팅 진입 시 working_folder가 저장돼 있으면 자동 노출
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // 우측 팀 네트워크 패널 — 에이전트 명령/응답 흐름 비주얼
  const [networkOpen, setNetworkOpen] = useState(false);
  // 슬래시 명령(/folder·/global)으로 워킹 폴더를 바꾸면 하단 폴더 바를 다시 읽게 하는 토큰
  const [folderReload, setFolderReload] = useState(0);

  // 사용자가 직접 패널을 접고/펴면 선호값을 영속화 (자동 노출과 구분).
  const setWorkspaceOpenPersisted = useCallback((open: boolean) => {
    setWorkspaceOpen(open);
    try {
      window.localStorage.setItem(WORKSPACE_OPEN_KEY, open ? "1" : "0");
    } catch {
      // sandbox/private mode — 영속화 생략
    }
  }, []);
  const setNetworkOpenPersisted = useCallback((open: boolean) => {
    setNetworkOpen(open);
    try {
      window.localStorage.setItem(NETWORK_OPEN_KEY, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  // 한 실행의 이벤트(라이브 스트림 OR 재접속 리플레이)를 메인 버블 + 네트워크 패널에 반영.
  // send()의 인라인 핸들러를 추출해 재접속 경로와 공유 — lastStatusRef는 중복 status 억제용(공유).
  const consumeEvent = useCallback(
    (ev: McpInvocationEvent, placeholderId: string, lastStatusRef: { text: string }) => {
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
      const pushWorkflow = (kind: NetTimelineItem["kind"], text: string) => {
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
        });
      };

      // ── 속성(agentId) 이벤트 → 네트워크 패널 (메인 버블 안 건드림) ──
      if (ev.agentId) {
        const aid = ev.agentId;
        setLiveAgents((prev) => ({
          ...prev,
          [aid]: {
            name: ev.agentName ?? prev[aid]?.name ?? aid,
            role: ev.role ?? prev[aid]?.role ?? "",
            tier: ev.tier ?? prev[aid]?.tier,
            active: true,
            status: ev.status ?? prev[aid]?.status,
            delegateTo: ev.delegateTo ?? prev[aid]?.delegateTo,
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
                    ...meta,
                  },
                ],
              };
            }
            return msg;
          }),
        );
        return;
      }
      if (ev.kind === "tool-use" && ev.tool) {
        pushWorkflow("tool", ev.status?.trim() || toolWorkflowText(ev.tool, locale));
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
        setSurface({ id: surfaceId, manifest: ev.surface });
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
        pushWorkflow("status", locale === "ko" ? "완료" : "Done");
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
              steps: [
                ...(msg.steps ?? []),
                {
                  id: uid(),
                  kind: "thinking",
                  text: locale === "ko" ? "에이전트 작업 완료" : "Agent work completed",
                  agentName: fallbackAgentName,
                  activity: "complete",
                },
              ],
              questions: questions.length > 0 ? questions : msg.questions,
            };
          }),
        );
        setBusy(false);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
        // 첫 메시지였으면 main이 자동 제목 생성 → 갱신해서 사이드바도 반영
        const api = ipc();
        void api?.chats.get(chatId).then((c) => c && setChat(c));
      } else if (ev.kind === "error") {
        pushWorkflow("status", ev.error?.message ?? t("chat.err.unknown"));
        setMessages((m) => [
          ...m.filter((msg) => msg.id !== placeholderId),
          { id: uid(), role: "system", text: `⚠️ ${ev.error?.message ?? t("chat.err.unknown")}` },
        ]);
        setBusy(false);
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
        subRef.current?.();
        subRef.current = null;
      }
    },
    [agent, chatId, locale, t],
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

  // Esc로 artifact 패널 닫기
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 입력창의 Esc 핸들러(자동완성/메뉴 닫기, Cmd/Ctrl+Esc 실행 정지)가 이미 처리했으면 중복 동작 안 함.
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && artifact) setArtifact(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact]);

  // 메타데이터 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    // 채팅 전환 시 이전 채팅의 진행 상태(busy/정지버튼/스트림)가 새 뷰로 새지 않게 리셋.
    // (Next 클라 네비게이션은 같은 컴포넌트를 재사용 → state가 남는다)
    setBusy(false);
    runIdRef.current = null;
    cancelRequestedRef.current = false;
    setLiveAgents({});
    setNetTimeline([]);
      setScaffoldedApps({});
      setScaffoldedTools({});
      setInstalledPlugins([]);
      setAllGeneratedApps([]);
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
      // 패널 노출 결정: 사용자가 명시적으로 접고/편 선호값이 있으면 그것을 우선,
      // 없으면 working_folder가 저장돼 있을 때만 자동 노출.
      const savedFolder = await api.workspace.get(chatId);
      let storedOpen: string | null = null;
      try {
        storedOpen = window.localStorage.getItem(WORKSPACE_OPEN_KEY);
      } catch {
        // ignore
      }
      if (!cancelled) {
        if (storedOpen === "1") setWorkspaceOpen(true);
        else if (storedOpen === "0") setWorkspaceOpen(false);
        else if (savedFolder) setWorkspaceOpen(true);
      }
      // 팀 네트워크 패널 — 저장된 선호값 복원 (기본 닫힘)
      let storedNet: string | null = null;
      try {
        storedNet = window.localStorage.getItem(NETWORK_OPEN_KEY);
      } catch {
        // ignore
      }
      if (!cancelled) setNetworkOpen(storedNet === "1");
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
      const historyMessages: StreamMessage[] = history.map((e) => ({
          id: e.id,
          role: e.role === "assistant" ? "agent" : e.role === "user" ? "user" : "system",
          text: e.text,
        }));
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
              },
            ],
          },
        ]);
        setBusy(true);
        runIdRef.current = attached.runId;
        const lastStatusRef = { text: "" };
        for (const ev of attached.events) consumeEvent(ev, placeholderId, lastStatusRef);
        subscribeRun(attached.runId, placeholderId, lastStatusRef);
      }
    })();
    return () => {
      cancelled = true;
      subRef.current?.();
      subRef.current = null;
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
      setSurface({ id: record.id, manifest: record.manifest, state: record.state, jobSummary: record.jobSummary });
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, surfaceParam]);

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
      setLiveAgents((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
      );
      void api.invoke.history(chatId).then((h) => {
        setMessages(
          h.map((e) => ({
            id: e.id,
            role: e.role === "assistant" ? "agent" : e.role === "user" ? "user" : "system",
            text: e.text,
          })),
        );
      });
    });
  }, [chatId]);

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
        goalMode?: boolean;
        appsGenerateMode?: boolean;
      },
    ) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events || !chat || busy) return;
      const goalPrompt = parseGoalSlash(userPrompt);
      const routeInput = goalPrompt ?? userPrompt;
      const appRoute = parseAppSlashRoute(routeInput);
      if (appRoute && !appRoute.request && appRoute.app.route !== "/chat") {
        router.push(appRoute.app.route);
        return;
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
            text: locale === "ko" ? `${appName} 삭제 중...` : `Deleting ${appName}...`,
            busy: true,
            startedAt: Date.now(),
          },
        ]);
        setBusy(true);
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
                        ? `${appName}을 삭제했습니다. 복원이 가능한 archive 상태로 보관했고 Apps 목록에서는 바로 숨겼습니다.`
                        : `${appName} was deleted from Apps and kept as a reversible archive.`,
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
        }
        return;
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
          steps: [
            {
              id: uid(),
              kind: "thinking",
              text: initialStatus,
              agentName: activeAgentName,
              activity: "start",
            },
          ],
        },
      ]);
      setBusy(true);
      setNetworkOpen(true);
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
        const { runId } = await api.invoke.run({
          chatId: chat.id,
          userPrompt: invocationPrompt,
          images,
          locale,
          permissions: opts?.permissions ?? DEFAULT_PERMISSION,
          goalMode: opts?.goalMode || Boolean(goalPrompt),
          appsGenerateMode: opts?.appsGenerateMode || Boolean(appRoute),
          targetAppId: generatedAppRoute?.action === "edit" ? generatedAppRoute.app.id : undefined,
          targetAppAction: generatedAppRoute?.action === "edit" ? "edit" : undefined,
        });
        runIdRef.current = runId;
        // 이벤트 처리는 consumeEvent로 추출됨 — 재접속(attach) 경로와 동일 로직 공유.
        subscribeRun(runId, placeholderId);
        // runId 도착 전에 Stop을 눌렀다면(레이스) 구독을 건 직후 즉시 취소 — abort 종료 이벤트를 수신해 busy 해제.
        if (cancelRequestedRef.current) {
          cancelRequestedRef.current = false;
          void api.invoke.cancel(runId);
        }
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
        setLiveAgents((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }])),
        );
        runIdRef.current = null;
      }
    },
    [agent, allGeneratedApps, chat, busy, locale, router, t, subscribeRun],
  );

  // 진행 중 실행 취소 — 입력창의 정지 버튼(전송 버튼이 busy일 때 변신) / Cmd/Ctrl+Esc.
  const stop = useCallback(() => {
    const api = ipc();
    if (!api) return;
    // runId가 아직 안 왔으면(invoke:run 왕복 중) 취소 의사만 기록 → 도착 즉시 취소된다.
    if (!runIdRef.current) {
      cancelRequestedRef.current = true;
      return;
    }
    void api.invoke.cancel(runIdRef.current);
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
    [send],
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
        void (async () => {
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
                    `Smoke: ${tool.smokePath}`,
                    "",
                    tool.summary,
                  ].join("\n"),
                );
              } else if (action.type === "run-tool-smoke") {
                const result = await api.toolFactory.runSmoke({ rootPath: tool.rootPath });
                update(
                  [
                    result.ok ? `Tool smoke passed: ${tool.toolName}` : `Tool smoke failed: ${tool.toolName}`,
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
                  `Smoke: ${scaffold.smokePath}`,
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
                  result.ok ? `Smoke passed: ${scaffold.appName}` : `Smoke failed: ${scaffold.appName}`,
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
          }
        })();
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

      void send(launchPrompt, {
        permissions: action.permission === "full" ? "full" : action.permission === "read" ? "read" : "write",
      });
    },
    [chatId, scaffoldedApps, scaffoldedTools, send, setWorkspaceOpenPersisted],
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
        void api.invoke.clearHistory(chat.id).then(() => setMessages([]));
      } else if (cmd === "/new") {
        void api.chats
          .create({ agentId: chat.agentId, projectId: chat.projectId, firmId: chat.firmId })
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
      void send(seedPrompt, { permissions: seedPermission ?? DEFAULT_PERMISSION });
      router.replace(`/chat?id=${chatId}`);
    }
  }, [chat, agent, chatId, messages.length, send, handleCommand, router, searchParams]);

  async function switchAgent(agentId: string) {
    const api = ipc();
    if (!api || !chat || agentId === chat.agentId) return;
    const updated = await api.chats.switchAgent(chat.id, agentId);
    setChat(updated);
    setAgent(allAgents.find((a) => a.id === agentId) ?? null);
    setFirm(null); // switchAgent는 firm을 해제
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

  if (!chat) return null;
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
        {displayAgent && displayAgents.length > 0 && (
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
        <button
          onClick={() => setNetworkOpenPersisted(!networkOpen)}
          className="titlebar-nodrag"
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
          onClick={() => setWorkspaceOpenPersisted(!workspaceOpen)}
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

      <ChatStream
        messages={messages}
        agentName={displayAgent ? pickLocalized(displayAgent, locale).name : t("chat.assistant_fallback")}
        agentTone={displayAgent?.tone ?? "blue"}
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
          setArtifact(a);
        }}
        onAnswerQuestion={answerQuestion}
      />
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
      <ChatInput
        onSend={(text, opts) => {
          void send(text, {
            images: opts?.images,
            permissions: opts?.permissions,
            goalMode: opts?.goalMode,
            appsGenerateMode: opts?.appsGenerateMode,
          });
        }}
        onCommand={handleCommand}
        onCallAgent={(agentId) => void switchAgent(agentId)}
        onStop={stop}
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
      <WorkbenchPanel
        artifact={artifact}
        surface={surface}
        onSurfaceAction={handleSurfaceAction}
        onSurfaceStatePatch={handleSurfaceStatePatch}
        onClose={() => {
          setArtifact(null);
          setSurface(null);
        }}
      />
      {workspaceOpen && (
        <WorkspacePanel chatId={chatId || null} onClose={() => setWorkspaceOpenPersisted(false)} />
      )}
      {networkOpen && (
        <AgentNetworkPanel
          firm={firm}
          org={resolvedOrg}
          agent={displayAgent}
          agents={displayAgents}
          busy={busy}
          liveAgents={liveAgents}
          timeline={netTimeline}
          chatTitle={chat.title}
          latestUserPrompt={latestUserPrompt}
          onClose={() => setNetworkOpenPersisted(false)}
        />
      )}
    </div>
  );
}
