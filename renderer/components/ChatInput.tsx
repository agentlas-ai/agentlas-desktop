// 입력창 — Claude Desktop / Codex 스타일 풀 기능:
//   - 텍스트 + 이미지/파일 첨부
//   - + 메뉴 (파일 / 플러그인 / Plan 모드 / Goal 모드)
//   - / 슬래시 커맨드 (자동완성)
//   - @ 멘션 (에이전트 · 프로젝트 · 회사 · 환경변수)
//   - 하단 툴바: 에이전트 칩 · 권한 칩 · 모드 토글 · 보내기
//
// 모드 토글은 V0 UI만 (실제 동작은 V1): plan/goal/permission이 invocation payload로 전달.
"use client";
import { ComposerDecisionSlot } from "./ComposerDecisionPortal";
import { OneVoiceInputHelp } from "./one/OneVoiceInputHelp";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  ImageAttachment,
  HubAgentBookmark,
  AppFactoryAppRecord,
  InstalledAgent,
  InstalledFirm,
  Project,
  RuntimeStatus,
} from "@/lib/types";
import { useRouter } from "next/navigation";
import { CONTEXT_MANAGED_BY, runtimeUsesEngineModelSetting } from "@shared/models";
import type { OrchestrationTarget, Recommendation, RecExecChoice, RecRouterAgent } from "@shared/types";
import { buildAppRoutePrompt, parseAppSlashRoute, type AgentlasAppDefinition } from "@/lib/apps";
import { callableHubBookmarks } from "@/lib/hub-bookmark-events";
import { installedAgentMentionTarget } from "@/lib/mention-orchestration-target";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { ipc, grantForDroppedFile } from "@/lib/ipc";
import type { ChatFileDraft } from "@/lib/chat-files";
import { openPricing } from "@/components/UpgradeCta";

type ModelOption = { id: string; label: string; tag?: string };

function isOrchestrationTarget(value: unknown): value is OrchestrationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  const source = target.source;
  const entityKind = target.entityKind;
  if (source === "local") {
    if (entityKind === "agent") return typeof target.agentId === "string" && target.agentId.trim().length > 0;
    if (entityKind === "team") return typeof target.firmId === "string" && target.firmId.trim().length > 0;
    return false;
  }
  return (
    (source === "cloud" || source === "hub") &&
    (entityKind === "agent" || entityKind === "team") &&
    typeof target.slug === "string" &&
    target.slug.trim().length > 0
  );
}

const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  agentlas: "Agentlas",
};

/** 로컬 OpenAI 호환 런타임 표시명(서버가 모델을 노출). */
const LOCAL_RUNTIME_LABEL: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
};

/** 모델 칩에 보일 라벨 — 현재 모델 라벨(opts에서) 또는 런타임 기본명. */
function modelChipLabel(s: RuntimeStatus, opts: ModelOption[]): string {
  const label = opts.find((o) => o.id === s.model)?.label ?? (s.model || null);
  const localName = LOCAL_RUNTIME_LABEL[s.kind];
  if (localName) return label ? `${localName} · ${label}` : localName;
  if (s.kind === "byok") return label ?? "API";
  const base = CLI_LABEL[s.kind] ?? s.kind;
  return label ? `${base} · ${label}` : base;
}

function effortOptionsForModel(runtime: RuntimeStatus): Array<{ id: string; label: string }> {
  const perModel = runtime.model
    ? runtime.allocationModelProfiles?.[runtime.model]?.efforts
    : undefined;
  if (perModel && perModel.length > 0) {
    const labels: Record<string, string> = {
      none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
      high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra",
    };
    return perModel.map((id) => ({
      id,
      label: labels[id] ?? id.charAt(0).toUpperCase() + id.slice(1),
    }));
  }
  return runtime.efforts ?? [];
}
import {
  IconApps,
  IconArrowUp,
  IconAtSign,
  IconBuilding,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconTrash,
  IconFileUp,
  IconFolder,
  IconKey,
  IconLayers,
  IconMoreHorizontal,
  IconNetwork,
  IconPaperclip,
  IconPlus,
  IconRoute,
  IconShield,
  IconSparkles,
  IconTarget,
  IconUsers,
} from "@/components/Icon";

type TFunction = ReturnType<typeof useT>["t"];

interface PreviewedImage extends ImageAttachment {
  dataUrl: string;
  name: string;
}

interface MentionContext {
  agents: InstalledAgent[];
  /** Saved public Hub routing references. They are borrowed, never presented as installed/owned. */
  hubBookmarks?: HubAgentBookmark[];
  projects: Project[];
  firms: InstalledFirm[];
  apps: AgentlasAppDefinition[];
  generatedApps?: AppFactoryAppRecord[];
  envKeys: string[]; // 등록된 env 키 (Library > Environment에서 add한)
}

interface SendOptions {
  images?: ImageAttachment[];
  files?: ChatFileDraft[];
  /** 사용자가 활성화한 모드 — 백엔드 invocation에 전달 (V1) */
  planMode?: boolean;
  goalMode?: boolean;
  permissions?: PermissionLevel;
  appsGenerateMode?: boolean;
  taskForceTargets?: OrchestrationTarget[];
  /** Keep the current chat roster first; recruit from Agent Hub/Cloud only on a real capability gap. */
  sessionRouting?: boolean;
  /** Explicit per-turn preference. Undefined leaves the decision to One/the task controller. */
  stormbreakerMode?: boolean;
}

interface StagedSteeringDraft {
  text: string;
  opts: SendOptions;
  previewDataUrl?: string;
  attachmentCount: number;
}

interface ChatComposerDraftCache {
  input: string;
  stagedSteering: StagedSteeringDraft | null;
}

// Route changes unmount TaskCockpit/ChatInput. Keep the full staged steering
// payload in renderer memory for same-window navigation, and mirror plain text
// to sessionStorage so a renderer refresh cannot silently eat an unfinished
// sentence. Attachments stay memory-only: serialising multi-megabyte images to
// Web Storage would block the renderer and recreate the typing jank this cache
// is meant to remove.
const CHAT_COMPOSER_DRAFT_STORAGE_PREFIX = "agentlas.chat-composer-draft.v1:";
const chatComposerDraftCache = new Map<string, ChatComposerDraftCache>();

function readChatComposerDraft(chatId: string | null): ChatComposerDraftCache {
  if (!chatId) return { input: "", stagedSteering: null };
  const cached = chatComposerDraftCache.get(chatId);
  if (cached) return cached;

  let input = "";
  try {
    if (typeof window !== "undefined") {
      const raw = window.sessionStorage.getItem(`${CHAT_COMPOSER_DRAFT_STORAGE_PREFIX}${chatId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { input?: unknown };
        if (typeof parsed.input === "string") input = parsed.input;
      }
    }
  } catch {
    // Storage is an optimisation. The in-memory cache remains authoritative.
  }
  const restored = { input, stagedSteering: null };
  chatComposerDraftCache.set(chatId, restored);
  return restored;
}

function writeChatComposerDraft(chatId: string | null, patch: Partial<ChatComposerDraftCache>) {
  if (!chatId) return;
  const current = readChatComposerDraft(chatId);
  const next = { ...current, ...patch };
  chatComposerDraftCache.set(chatId, next);
  try {
    if (typeof window === "undefined") return;
    const key = `${CHAT_COMPOSER_DRAFT_STORAGE_PREFIX}${chatId}`;
    if (next.input) window.sessionStorage.setItem(key, JSON.stringify({ input: next.input }));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Quota/security failures must never make the composer unusable.
  }
}

/** popover에 그릴 한 행 + 평탄화 인덱스용 메타. group은 같은 헤더 아래로 그룹핑되지만 인덱스는 flat. */
interface AutocompleteOption {
  /** 안정적 key */
  key: string;
  /** 노출 그룹 헤더 — 같은 group끼리 헤더 한 번만 노출 */
  group?: string;
  title: string;
  subtitle?: string;
  /** 아이콘은 popover에서 일괄 매핑 (group으로 결정) */
  kind: "app" | "agent" | "hub" | "firm" | "project" | "env";
  /** 선택 시 입력창에 치환할 토큰 */
  replacement: string;
  /** Explicit turn-only sub-agent target. It never changes the One/Task controller. */
  target?: OrchestrationTarget;
}

type PermissionLevel = "read" | "write" | "full";
type AppGenerateChoice = "dedicated" | "chat";
// Optional per-turn preferences. An untouched toggle is deliberately omitted:
// One/the task controller keeps its own judgment instead of receiving OFF.
type HepToggleId = "stormbreaker" | "recommend";
type ChatInputLayer = "plus" | "permission" | "model" | "context" | "agent-picker" | "apps-question";

const HEP_TOGGLES: Array<{
  id: HepToggleId;
  labelKo: string;
  labelEn: string;
  titleKo: string;
  titleEn: string;
}> = [
  {
    id: "recommend",
    labelKo: "세션 팀 자동 보강",
    labelEn: "Dynamic session team",
    titleKo: "현재 세션 팀을 먼저 쓰고, 역량이 부족할 때만 Agent Hub·Cloud에서 보강",
    titleEn: "Use the current session team first, then recruit from Agent Hub or Cloud only for a capability gap",
  },
  {
    id: "stormbreaker",
    labelKo: "Stormbreaker",
    labelEn: "Stormbreaker",
    titleKo: "Stormbreaker 견고-실행: 검증·복구 루프로 끝까지 (계속 켜둘 수 있음)",
    titleEn: "Stormbreaker robust run: verify/repair loop to completion (stays on)",
  },
];

// Stormbreaker 워닝 버블 — 토글을 OFF→ON 할 때 1회만. per-device 선호라 localStorage(설정 스토어 아님).
const STORM_WARNING_DISMISSED_KEY = "agentlas.stormbreaker.warning.dismissed";
function isStormWarningDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(STORM_WARNING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function dismissStormWarning() {
  try {
    window.localStorage.setItem(STORM_WARNING_DISMISSED_KEY, "1");
  } catch {
    // ignore
  }
}

interface BottomQuestionOption {
  id: AppGenerateChoice;
  title: string;
  description: string;
  shortcut: string;
}

/** 자동 라우팅이 유일하게 멈춰 서는 두 게이트 — 크레딧 부족(paywall) / 적합 에이전트 없음(build). */
interface AutoRouteGate {
  kind: "paywall" | "build";
  text: string;
  opts: SendOptions;
  routerAgent?: RecRouterAgent;
  /** paywall: 필요/보유 크레딧. partialCost=true 면 needed 는 확정액이 아니라 하한이다. */
  needed?: number;
  have?: number | null;
  partialCost?: boolean;
  /** build: 엔진이 준 사유. */
  reason?: string;
}

function ChatInputComponent({
  onSend,
  onSessionAction,
  onRecommendPreview,
  onRecommendExecute,
  onStop,
  busy,
  disabled,
  context,
  runtime,
  modelOptions,
  onSelectModel,
  onSelectEffort,
  tokensUsage,
  activeAgentId,
  stopRequested = false,
  showModeToggles = false,
  continuousMode = false,
  swarmMode = false,
  goalActive,
  onToggleGoal,
  progressLabel,
  goalCriteria,
  goalRunStatus,
  goalPauseReason,
  goalBlockedReason,
  onResumeGoal,
  onPauseGoal,
  onToggleContinuous,
  onToggleSwarm,
  queuedCount = 0,
  prefillText = null,
  activeChatId = null,
  placeholder,
  projectOrchestration = false,
  activeProjectId = null,
}: {
  onSend: (text: string, opts?: SendOptions) => void;
  /** Button-only session actions. They are never represented as chat commands. */
  onSessionAction?: (action: "new" | "clear") => void;
  /** 추천 토글 ON 시 보내기 전에 라우터 미리보기를 요청 — 정규화된 추천을 반환(없으면 null). */
  onRecommendPreview?: (text: string) => Promise<Recommendation | null>;
  /** 추천 시트에서 고른 실행 경로를 디스패치(에이전트 전환/네트워크/파이프라인/그냥보내기). */
  onRecommendExecute?: (choice: RecExecChoice, text: string, opts: SendOptions) => void;
  /** 진행 중 실행 취소 — 제공되면 busy일 때 전송 버튼이 정지 버튼으로 변신(Esc도 정지). */
  onStop?: () => void;
  /** 상단/멘션에서 명시적으로 선택된 현재 에이전트. 바뀌면 자동추천 라우팅을 끈다. */
  activeAgentId?: string | null;
  /** 정지 요청이 이미 눌린 상태 — 중복 클릭과 불확실한 UI를 막는다. */
  stopRequested?: boolean;
  busy: boolean;
  disabled?: boolean;
  context?: MentionContext;
  /** 활성 런타임 — 모델/작업량 picker용. */
  runtime?: RuntimeStatus | null;
  /** 실시간 조회된 모델 목록 (runtime.listModels). */
  modelOptions?: ModelOption[];
  /** 모델 선택 — "" 이면 런타임 자체 설정 사용(--model 미전달). */
  onSelectModel?: (id: string) => void;
  /** 작업량 선택 — "" 이면 기본. claude-code 전용. */
  onSelectEffort?: (id: string) => void;
  /** 화면에 복원된 대화 기록의 논리 토큰 추정치. 물리 모델 창 점유율이 아니다. */
  tokensUsage?: { current: number };
  /** 실행 모드 토글 노출 여부(division 챗은 숨김). + 메뉴에 "계속 라이브로"·"스웜"을 넣는다. */
  showModeToggles?: boolean;
  /** 계속 라이브로(continuousMode) 현재 상태 + 토글. */
  continuousMode?: boolean;
  onToggleContinuous?: () => void;
  /** persistent goal(chats.goal_id) 현재 상태 + 토글 — 제공되면 goal 칩은 DB 영속
   *  상태를 따르는 controlled 모드가 되고(새로고침에도 유지), 칩 ×는 명시적 목표
   *  종료(onToggleGoal)를 부른다. 미제공 표면은 기존 per-turn 로컬 상태 그대로. */
  goalActive?: boolean;
  onToggleGoal?: () => void;
  /** Current work label/start time for the Codex-style feedback strip above the composer. */
  progressLabel?: string;
  /** Host-owned success contract. Steering never changes this list. */
  goalCriteria?: string[];
  /** Durable Desktop long-run state. Paused runs require an explicit resume. */
  goalRunStatus?: string;
  goalPauseReason?: string | null;
  goalBlockedReason?: string | null;
  onResumeGoal?: () => void;
  onPauseGoal?: () => void;
  /** 스웜(swarmMode) 현재 상태 + 토글. */
  swarmMode?: boolean;
  onToggleSwarm?: () => void;
  /** 실행 중 steering 큐에 대기 중인 메시지 수 — 0보다 크면 "대기 중" 표시. */
  queuedCount?: number;
  /** 외부 프리필(프롬프트 저장소 seedOnly) — 입력창이 비었을 때 1회 주입, 전송은 사용자가. */
  prefillText?: string | null;
  /** 현재 채팅 id — 바뀌면 세션 전용 실행 상태(추천 시트·모드 토글)를 리셋해 세션 간 누수 방지. */
  activeChatId?: string | null;
  /** Product-surface specific result prompt. */
  placeholder?: string;
  /** Project Work owns staffing automatically; legacy execution modes are not composer choices here. */
  projectOrchestration?: boolean;
  /** Owning project — gates the per-project 렌트허용 policy for hub auto-hire. */
  activeProjectId?: string | null;
}) {
  const { t, locale } = useT();
  const router = useRouter();
  const initialDraftRef = useRef<ChatComposerDraftCache | null>(null);
  if (initialDraftRef.current === null) initialDraftRef.current = readChatComposerDraft(activeChatId);
  const [input, setInputState] = useState(initialDraftRef.current.input);
  // Legacy staged adjustments are deliberately discarded: a busy composer now
  // sends its steering instruction directly, like Codex.
  const [stagedSteering, setStagedSteeringState] = useState<StagedSteeringDraft | null>(null);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  function setInput(next: string | ((current: string) => string)) {
    if (typeof next === "string") {
      writeChatComposerDraft(activeChatIdRef.current, { input: next });
      setInputState(next);
      return;
    }
    setInputState((current) => {
      const resolved = next(current);
      writeChatComposerDraft(activeChatIdRef.current, { input: resolved });
      return resolved;
    });
  }
  function setStagedSteering(next: StagedSteeringDraft | null) {
    writeChatComposerDraft(activeChatIdRef.current, { stagedSteering: next });
    setStagedSteeringState(next);
  }
  const [images, setImages] = useState<PreviewedImage[]>([]);
  // 비이미지 첨부 — 내용 업로드가 아니라 경로 참조(capability). 파일·폴더·영상 공통.
  const [fileGrants, setFileGrants] = useState<ChatFileDraft[]>([]);
  // 붙여넣은 긴 텍스트 — 입력창을 채우지 않고 에셋 칩으로 접어 동봉.
  const [pastedTexts, setPastedTexts] = useState<Array<{ name: string; text: string }>>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // 메뉴는 한 번에 하나만 열린다. 서로 독립된 boolean을 두면 권한/모델/컨텍스트가
  // 동시에 겹치고, 바깥 클릭 처리도 "어느 메뉴 안인가"를 구분하지 못한다.
  const [activeLayer, setActiveLayer] = useState<ChatInputLayer | null>(null);
  function setLayerOpen(layer: ChatInputLayer, next: boolean | ((open: boolean) => boolean)) {
    setActiveLayer((current) => {
      const open = current === layer;
      const shouldOpen = typeof next === "function" ? next(open) : next;
      if (shouldOpen) return layer;
      return open ? null : current;
    });
  }
  const plusOpen = activeLayer === "plus";
  const agentPickerOpen = activeLayer === "agent-picker";
  const permOpen = activeLayer === "permission";
  const modelOpen = activeLayer === "model";
  const contextMenuOpen = activeLayer === "context";
  const appsGenerateQuestionOpen = activeLayer === "apps-question";
  const setPlusOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("plus", next);
  const setAgentPickerOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("agent-picker", next);
  const setPermOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("permission", next);
  const setModelOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("model", next);
  const setContextMenuOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("context", next);
  const setAppsGenerateQuestionOpen = (next: boolean | ((open: boolean) => boolean)) => setLayerOpen("apps-question", next);

  // 외부 프리필 — 입력창이 비어있을 때만 채운다(입력 중 내용 덮어쓰기 금지).
  useEffect(() => {
    if (prefillText && prefillText.trim() && !input.trim()) {
      setInput(prefillText);
    }
    // input을 deps에 넣지 않는다 — 프리필 값이 바뀔 때만 1회 시도.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);
  const [plusSubmenu, setPlusSubmenu] = useState<"plugins" | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  // goal 칩의 유효 상태 — 부모가 DB 영속 상태(goalActive/onToggleGoal)를 주면 그것이
  // 진실이고(useState는 새로고침에 사라진다), 아니면 기존 per-turn 로컬 상태.
  const goalControlled = typeof onToggleGoal === "function";
  const effectiveGoalMode = goalControlled ? goalActive === true : goalMode;
  const toggleGoalMode = (next: boolean) => {
    if (goalControlled) onToggleGoal?.();
    else setGoalMode(next);
  };
  // 다중선택·지속 모드 토글(에이전트 찾기/Stormbreaker). 전송해도 유지된다.
  const [hepToggles, setHepToggles] = useState<Set<HepToggleId>>(() => new Set());
  // Stormbreaker를 처음 켤 때 뜨는 비용/시간 경고 버블. dismiss하면 다시 안 뜸.
  const [showStormWarning, setShowStormWarning] = useState(false);
  // 자동 라우팅(알아서 에이전트 부르기) — 묻지 않고 바로 라우팅한다(codex hep-network 동작과 동일).
  const [autoRouting, setAutoRouting] = useState(false);
  // 호출 전 비용 고지 — 허브 에이전트 유료 자동 고용 직전에만 잠깐 뜬다.
  // 크레딧 = 대여(리스) 비용이지 최종 성공 보장이 아니라는 걸 숨기지 않는다.
  // partial=true 면 credits 는 알려진 단가만 더한 하한 — 총액인 척 표기하면 안 된다.
  const [costNotice, setCostNotice] = useState<{ credits: number; partial: boolean } | null>(null);
  const costNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashCostNotice(credits: number, partial = false) {
    if (costNoticeTimerRef.current) clearTimeout(costNoticeTimerRef.current);
    setCostNotice({ credits, partial });
    costNoticeTimerRef.current = setTimeout(() => setCostNotice(null), 8_000);
  }
  useEffect(() => () => {
    if (costNoticeTimerRef.current) clearTimeout(costNoticeTimerRef.current);
  }, []);
  // 게이트 바텀시트 — 유일하게 묻는 두 경우: 크레딧 부족(paywall) / 적합 에이전트 없음(build 제안).
  const [gateSheet, setGateSheet] = useState<AutoRouteGate | null>(null);
  const [appsGenerateMode, setAppsGenerateMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [turnCalls, setTurnCalls] = useState<Array<{ key: string; label: string; target: OrchestrationTarget }>>([]);
  const [appsGenerateChoice, setAppsGenerateChoice] = useState<AppGenerateChoice>("dedicated");
  // 기본값을 write로 — 바이브코딩 앱에서 read-only 기본은 첫 "만들어줘"가 파일을 못 써 조용히 실패한다.
  // write는 cwd 파일 편집만 허용(셸·외부 자동호출은 차단)이라 안전한 기본값.
  const [permissions, setPermissions] = useState<PermissionLevel>("write");
  // 컨텍스트는 진단 지표가 아니라 다음 행동(새 세션/비우기)으로 바로 이어져야 한다.
  // / 슬래시 + @ 멘션 인라인 자동완성
  const [trigger, setTrigger] = useState<null | {
    kind: "mention";
    query: string;
    /** textarea 내부 trigger 문자 위치 (caret index) */
    startIndex: number;
  }>(null);
  /** 키보드 ↑↓로 선택 가능한 평탄화 인덱스 — Enter 시 이걸로 onPick */
  const [activeIndex, setActiveIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepthRef = useRef(0);
  const lastActiveAgentIdRef = useRef<string | null | undefined>(undefined);
  const expectedAgentChangesRef = useRef<Map<string, number>>(new Map());
  const expectedAgentChangeTokenRef = useRef(0);
  const autocompleteSignatureRef = useRef<string>("");
  function expectAgentChangeWithoutReset(agentId: string) {
    const token = ++expectedAgentChangeTokenRef.current;
    expectedAgentChangesRef.current.set(agentId, token);
    window.setTimeout(() => {
      if (expectedAgentChangesRef.current.get(agentId) === token) {
        expectedAgentChangesRef.current.delete(agentId);
      }
    }, 10_000);
  }

  useEffect(() => {
    if (activeChatIdRef.current === activeChatId) return;
    activeChatIdRef.current = activeChatId;
    const restored = readChatComposerDraft(activeChatId);
    setInputState(restored.input);
    setStagedSteeringState(null);
  }, [activeChatId]);

  // 세션 격리 — 채팅을 바꾸면 이전 세션의 실행 의도 상태(추천 시트·모드 토글·선택)를 버린다.
  // ChatInput은 채팅별로 remount되지 않아서, 이게 없으면 A에서 연 추천 바텀시트가 B로 넘어가
  // "쓰기"를 누르면 B(지금 세션)로 엉뚱하게 에이전트가 콜된다. (드래프트 텍스트는 유지.)
  const lastChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastChatIdRef.current === null) {
      lastChatIdRef.current = activeChatId;
      return;
    }
    if (lastChatIdRef.current === activeChatId) return;
    lastChatIdRef.current = activeChatId;
    setAutoRouting(false);
    setGateSheet(null);
    setHepToggles(new Set());
    setPlanMode(false);
    setGoalMode(false);
    setAppsGenerateMode(false);
    setAppsGenerateQuestionOpen(false);
    setAgentPickerOpen(false);
    setSelectedAgentIds(new Set());
    setTrigger(null);
    setAttachmentError(null);
    setContextMenuOpen(false);
    expectedAgentChangesRef.current.clear();
    dragDepthRef.current = 0;
    setDragActive(false);
  }, [activeChatId]);

  // 입력 내용에 따라 textarea 높이를 늘린다(auto-grow) — 최대치까지 자라고 그 뒤엔 내부 스크롤.
  // 전송 후 비우기·자동완성 삽입 같은 프로그램적 변경도 input 값 변화로 함께 반영된다.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [input]);

  // busy는 제외 — 실행 중에도 Enter/전송 버튼으로 steering 메시지를 보낼 수 있다. 부모가
  // 큐에 쌓아 현재 턴 뒤에 전달한다. 중지 요청 뒤에만 새 지시를 잠시 막아 의도를 충돌시키지 않는다.
  const nothingToSend =
    !input.trim() && images.length === 0 && fileGrants.length === 0 && pastedTexts.length === 0;
  const submitDisabled = nothingToSend || disabled || (busy && (stopRequested || stagedSteering !== null));
  /*
   * ★보내기가 회색인데 **왜인지 알 길이 없었다** (마우스 실측 2026-09-08).
   *   "아무것도 안 썼다" 는 보면 알지만, 나머지 세 사유는 화면에 아무 말도 없다:
   *   작성창이 잠긴 상태, 중지 요청 중, 이미 보낼 지시가 대기 중.
   *   회색 단추는 그 자체로 막다른 길이라 사유를 붙인다.
   */
  const submitDisabledReason = !submitDisabled || nothingToSend
    ? null
    : disabled
      ? (locale === "ko" ? "지금은 이 대화에 보낼 수 없습니다." : "This conversation cannot accept messages right now.")
      : stopRequested
        ? (locale === "ko" ? "중지를 요청했습니다. 멈춘 뒤에 보낼 수 있습니다." : "Stop was requested. You can send once it has stopped.")
        : (locale === "ko" ? "보낼 지시가 이미 대기 중입니다. 그 지시가 전달된 뒤에 보낼 수 있습니다." : "An instruction is already queued. You can send again once it is delivered.");
  const hepHint = [...hepToggles]
    .map((id) => {
      const toggle = HEP_TOGGLES.find((t) => t.id === id);
      return toggle ? (locale === "ko" ? toggle.labelKo : toggle.labelEn) : null;
    })
    .filter(Boolean)
    .join(" + ");
  const contextTokenLabel = tokensUsage
    ? tokensUsage.current >= 1_000_000
      ? `~${(tokensUsage.current / 1_000_000).toFixed(1)}M`
      : `~${Math.max(1, Math.round(tokensUsage.current / 1_000))}k`
    : "";

  // ── 파일 첨부 ──────────────────────────────────────────
  async function addFiles(files: FileList | File[]) {
    const accepted: PreviewedImage[] = [];
    const grantedFiles: ChatFileDraft[] = [];
    const rejected: string[] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      const grant = await grantForDroppedFile(file);
      if (grant?.path) {
        grantedFiles.push({
          grant,
          name: file.name || grant.path.split("/").filter(Boolean).at(-1) || (grant.kind === "directory" ? "folder" : "file"),
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          kind: grant.kind,
        });
      } else if (!file.type.startsWith("image/")) {
        rejected.push(file.name);
        continue;
      }
      // Images keep the existing multimodal payload while also receiving the
      // same durable file-card binding as every other attachment.
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 5 * 1024 * 1024) {
        errors.push(t("chatinput.image_too_large", { name: file.name }));
        continue;
      }
      try {
        const data = await fileToBase64(file);
        accepted.push({
          mediaType: file.type,
          data,
          dataUrl: `data:${file.type};base64,${data}`,
          name: file.name,
        });
      } catch {
        errors.push(t("chatinput.image_read_failed", { name: file.name }));
      }
    }
    if (accepted.length > 0) setImages((arr) => [...arr, ...accepted]);
    if (grantedFiles.length > 0) setFileGrants((arr) => [...arr, ...grantedFiles]);
    if (rejected.length > 0) {
      errors.push(`${rejected.join(", ")} — ${locale === "ko" ? "첨부하지 못했습니다" : "could not attach"}`);
    }
    setAttachmentError(errors.length > 0 ? errors.join(" ") : null);
  }

  function removeImage(i: number) {
    setImages((arr) => arr.filter((_, j) => j !== i));
  }

  // ── 입력 변경: turn-only @ sub-agent trigger ────────────
  function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setInput(next);
    const caret = e.target.selectionStart ?? next.length;
    // 직전 단어 시작 위치 찾기 — 공백/개행으로 끊김
    const before = next.slice(0, caret);
    const lastSpace = Math.max(
      before.lastIndexOf(" "),
      before.lastIndexOf("\n"),
      before.lastIndexOf("\t"),
    );
    const tokenStart = lastSpace + 1;
    const token = before.slice(tokenStart);
    if (token.startsWith("@")) {
      setTrigger({ kind: "mention", query: token.slice(1), startIndex: tokenStart });
    } else {
      setTrigger(null);
    }
  }

  // ── 자동완성 옵션 평탄화 — 키보드 네비용 ────────────────
  const autocompleteOptions = useMemo<AutocompleteOption[]>(() => {
    if (!trigger || !context) return [];
    return buildAutocompleteOptions(trigger, context, locale, t);
  }, [trigger, context, locale, t]);

  const autocompleteOptionKey = useMemo(
    () => autocompleteOptions.map((opt) => opt.key).join("\u001f"),
    [autocompleteOptions],
  );
  const autocompleteSignature = `${trigger?.kind ?? "none"}\u001f${trigger?.startIndex ?? -1}\u001f${trigger?.query ?? ""}\u001f${autocompleteOptionKey}`;

  // trigger/query/결과 목록이 실제로 바뀔 때만 activeIndex를 보정한다.
  // context 객체는 부모 렌더마다 새로 만들어질 수 있으므로 배열 identity에 의존하면
  // 키보드/마우스 선택이 매 렌더 0번으로 튀어 오른다.
  useEffect(() => {
    const changed = autocompleteSignatureRef.current !== autocompleteSignature;
    autocompleteSignatureRef.current = autocompleteSignature;
    setActiveIndex((current) => {
      if (autocompleteOptions.length === 0) return -1;
      if (changed) return 0;
      if (current < 0 || current >= autocompleteOptions.length) return 0;
      return current;
    });
  }, [autocompleteSignature, autocompleteOptions.length]);

  useEffect(() => {
    const previous = lastActiveAgentIdRef.current;
    lastActiveAgentIdRef.current = activeAgentId;
    if (!previous || !activeAgentId || previous === activeAgentId) return;
    if (expectedAgentChangesRef.current.has(activeAgentId)) {
      expectedAgentChangesRef.current.delete(activeAgentId);
      return;
    }
    expectedAgentChangesRef.current.clear();
    setGateSheet(null);
    setHepToggles((prev) => {
      if (!prev.has("recommend")) return prev;
      const next = new Set(prev);
      next.delete("recommend");
      return next;
    });
  }, [activeAgentId]);

  // fillOnly=true(Tab): 실행/전환 없이 텍스트만 자동완성해 넣는다(절대 전송 안 함).
  // fillOnly=false(Enter): @agent/@firm은 이번 턴 호출로 추가하고, 그 외는 텍스트 삽입.
  function applyAutocomplete(opt: AutocompleteOption, fillOnly = false) {
    if (!trigger) return;
    const before = input.slice(0, trigger.startIndex);
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const after = input.slice(caret);

    if (!fillOnly) {
      if (opt.target) {
        setInput(`${before}${after}`.trimStart());
        setTrigger(null);
        setGateSheet(null);
        setHepToggles((prev) => {
          const next = new Set(prev);
          next.delete("recommend");
          return next;
        });
        setTurnCalls((current) => current.some((call) => call.key === opt.key)
          ? current
          : [...current, { key: opt.key, label: opt.title, target: opt.target as OrchestrationTarget }]);
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
    }
    // fillOnly는 트레일링 공백 없이 채워 계속 편집 가능.
    const tail = fillOnly ? "" : " ";
    const next = `${before}${opt.replacement}${tail}${after}`;
    setInput(next);
    setTrigger(null);
    setTimeout(() => {
      const pos = `${before}${opt.replacement}${tail}`.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }

  function selectedAutocompleteOption(): AutocompleteOption | undefined {
    return autocompleteOptions[activeIndex] ?? autocompleteOptions[0];
  }

  /** 현재 첨부/모드 상태로 SendOptions 를 합성. */
  function currentSendOptions(): SendOptions {
    const attachments =
      images.length > 0 ? images.map(({ mediaType, data, name }) => ({ mediaType, data, name })) : undefined;
    return {
      images: attachments,
      files: fileGrants.length > 0 ? fileGrants.map((item) => ({ ...item, grant: { ...item.grant } })) : undefined,
      planMode: planMode || undefined,
      goalMode: effectiveGoalMode || undefined,
      permissions,
      appsGenerateMode: appsGenerateMode || undefined,
      taskForceTargets: turnCalls.length ? turnCalls.map((call) => call.target) : undefined,
      sessionRouting: projectOrchestration || undefined,
      stormbreakerMode: hepToggles.has("stormbreaker") || undefined,
    };
  }

  /** 첨부(파일·폴더 경로 + 붙여넣은 텍스트)를 메시지 본문에 동봉 — 로컬 에이전트가 경로로 읽는다. */
  function withAttachmentContext(base: string): string {
    const parts: string[] = [];
    for (const g of fileGrants) parts.push(`- ${g.kind === "directory" ? "폴더" : "파일"}: ${g.grant.path}`);
    for (const p of pastedTexts) parts.push(`- ${locale === "ko" ? "붙여넣은 텍스트" : "pasted text"} "${p.name}":\n${p.text}`);
    if (parts.length === 0) return base;
    return `${base}${base ? "\n\n" : ""}[${locale === "ko" ? "첨부" : "attachments"}]\n${parts.join("\n")}`;
  }

  function submit() {
    if (submitDisabled) return;
    const text = withAttachmentContext(input.trim());
    /*
     * 앱 슬래시 명령(/site, /document-studio, /startup …).
     *
     * 명령 목록과 파서는 처음부터 다 있었는데 부르는 곳이 없어서, 치면 그냥
     * 평범한 문장으로 모델에 갔다(감사 2026-08-25: parseAppSlashRoute 호출부
     * 0건, ChatInput 이 넘겨받은 apps 를 한 번도 읽지 않음). 명령을 치면 그 앱을
     * 여는 요청으로 바꿔 보낸다.
     */
    const appRoute = parseAppSlashRoute(text);
    if (appRoute) {
      finishComposerAfterSend();
      if (appRoute.request) {
        // 할 말이 붙어 있으면 그 앱에 시키는 요청이다.
        onSend(buildAppRoutePrompt(appRoute, locale === "en" ? "en" : "ko"), currentSendOptions());
      } else {
        // 명령만 쳤으면 그 앱을 연다. 이 길이 없어서 창업 스튜디오 화면(511줄)은
        // 도달하는 문이 아예 없었다(감사 2026-08-25).
        router.push(appRoute.app.route);
      }
      return;
    }
    const pluginMention = /(^|\s)@plugin-make\b/i.exec(text);
    if (pluginMention) {
      const request = text.replace(pluginMention[0], " ").trim();
      const params = new URLSearchParams();
      if (activeChatId) params.set("chat", activeChatId);
      if (request) params.set("request", request);
      finishComposerAfterSend();
      router.push(`/build/plugin${params.toString() ? `?${params.toString()}` : ""}`);
      return;
    }
    if (busy) {
      // Codex-shaped steering: the round send control immediately queues the
      // next instruction. Main preserves the active model turn.
      onSend(text, currentSendOptions());
      finishComposerAfterSend();
      return;
    }
    // 세션 팀 자동 보강은 매 턴 전역 검색을 하지 않는다. 현재 채팅에 붙은
    // 에이전트/팀을 먼저 실행하고, 런타임 LLM이 실제 역량 공백을 판단한 경우에만
    // Agent Hub·Cloud 보강 도구를 사용한다.
    if (!projectOrchestration && hepToggles.has("recommend") && text) {
      void autoRouteAndSend(text);
      return;
    }
    onSend(text, currentSendOptions());
    setInput("");
    setImages([]);
    setFileGrants([]);
    setPastedTexts([]);
    setTurnCalls([]);
    // 모드 토글(에이전트 찾기/Stormbreaker)은 리셋하지 않는다 — 계속 켜둘 수 있음.
    setTrigger(null);
  }

  function sendStagedSteering() {
    if (!stagedSteering) return;
    const staged = stagedSteering;
    setStagedSteering(null);
    onSend(staged.text, staged.opts);
  }

  // ── 자동 라우팅 흐름 ─────────────────────────────────
  /** 전송 후 컴포저 정리 — 추천 토글은 유지한다(다음 메시지도 계속 알아서 라우팅). */
  function finishComposerAfterSend() {
    setInput("");
    setImages([]);
    setFileGrants([]);
    setPastedTexts([]);
    setTurnCalls([]);
    setTrigger(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  /** 추천을 실행 경로로 자동 디스패치. 라우터 에스컬레이션(routerAgent)은 항상 실어 보낸다.
   *  해당 자동 개입 대시보드 토글이 꺼져 있으면 Hub 자동 고용/스톰 파이프라인 대신
   *  로컬 에이전트·plain 전송으로 강등한다 — 컴포저 칩/@멘션 같은 명시 실행은 이 함수와 무관. */
  function execAutoChoice(
    preview: Recommendation,
    text: string,
    opts: SendOptions,
    engine?: { stormbreakerAuto: boolean; networkAuto: boolean } | null,
  ) {
    const routerAgent = preview.routerAgent;
    if (preview.mode === "pipeline") {
      if (engine?.stormbreakerAuto === true) {
        onRecommendExecute?.({ kind: "pipeline", stages: preview.stages, routerAgent }, text, opts);
      } else {
        // Stormbreaker 자동 OFF → 루프 개입 없이 일반 전송(에스컬레이션만 동봉).
        onRecommendExecute?.({ kind: "plain", routerAgent }, text, opts);
      }
      finishComposerAfterSend();
      return;
    }
    const top = preview.agents[0];
    if (!top) {
      onRecommendExecute?.({ kind: "plain", routerAgent }, text, opts);
      finishComposerAfterSend();
      return;
    }
    const remoteTargets = engine?.networkAuto === true
      ? preview.agents.filter((agent) => agent.source !== "local").map((agent) => agent.target).filter(isOrchestrationTarget)
      : [];
    const localTargets = preview.agents
      .filter((agent) => agent.source === "local")
      .map((agent) => agent.target)
      .filter(isOrchestrationTarget);
    const targets = [...localTargets, ...remoteTargets];
    if (targets.length > 1 || targets.some((target) => target.entityKind !== "agent" || target.source !== "local")) {
      onRecommendExecute?.({ kind: "network", targets, routerAgent }, text, opts);
    } else if (targets.length === 1) {
      onRecommendExecute?.({ kind: "agent", target: targets[0], routerAgent }, text, opts);
    } else {
      // Hub 후보뿐인데 자동 빌림 OFF → 고용 없이 원문 전송(에스컬레이션만 동봉).
      onRecommendExecute?.({ kind: "plain", routerAgent }, text, opts);
    }
    finishComposerAfterSend();
  }

  /**
   * 자동 라우팅 — routeOnly 미리보기를 받아 묻지 않고 바로 실행한다(codex hep-network 동작).
   *  - 엔진이 저신뢰 에스컬레이션(routerAgent)을 붙인 허브 후보는 키워드 랭킹 노이즈일 수 있어
   *    선고용하지 않는다: routerAgent만 실어 보내 메인 LLM이 의도 기반으로 재랭킹·차용하게 한다.
   *  - 크레딧 부족일 때만 paywall, 적합 에이전트가 정말 없을 때만 build 제안 시트를 띄운다.
   */
  async function autoRouteAndSend(text: string) {
    if (!onRecommendPreview) return;
    const opts = currentSendOptions();
    const chatIdAtStart = activeChatIdRef.current;
    setAutoRouting(true);
    // 엔진 자동 개입 토글 — Hub 자동 고용/스톰 파이프라인 디스패치를 게이트한다.
    const [preview, engineToggles] = await Promise.all([
      onRecommendPreview(text).catch(() => null),
      ipc()?.hephaestus.getEngineToggles().catch(() => null) ?? Promise.resolve(null),
    ]);
    setAutoRouting(false);
    // 그새 채팅이 바뀌었으면 이 세션에 콜하지 않는다(세션 격리).
    if (activeChatIdRef.current !== chatIdAtStart) return;

    // 1) 세션 우선 호스트의 정상 경로. routePreview는 전역검색 없이 none을
    // 반환하고, 현재 세션 roster와 LLM의 동적 gap 판단을 main에 명시한다.
    if (!preview || preview.mode === "none") {
      onSend(text, { ...opts, sessionRouting: true });
      finishComposerAfterSend();
      return;
    }
    // 2) 적합 에이전트 없음 → 빌드 제안 시트(여기서만 묻는다).
    if (preview.mode === "build") {
      setGateSheet({ kind: "build", text, opts, reason: preview.buildReason, routerAgent: preview.routerAgent });
      return;
    }
    // 3) 프로젝트 렌트 정책(오너 결정 2026-08-18, 작업당 과금) — 렌트허용이 꺼진 Hub
    //    에이전트는 이 프로젝트의 자동 고용 후보에서 제외한다. 활성 장기대여(선불,
    //    호출 0크레딧)는 항상 후보로 남는다. 프로젝트가 없는 채팅은 기존 동작 유지.
    let effectivePreview = preview;
    // 남은 Hub 고용 전원이 명시 허용(토글 ON) 또는 활성 대여일 때만 매 전송 고지를
    // 생략한다 — 크레딧 부족 페이월이 유일한 개입으로 남는다.
    let suppressCostNotice = false;
    if (activeProjectId && preview.agents.some((a) => a.source === "hub")) {
      const allowedSlugs = new Set(
        ((await ipc()?.projects.listRentAllowed(activeProjectId).catch(() => [])) ?? [])
          .map((slug) => slug.toLowerCase()),
      );
      if (activeChatIdRef.current !== chatIdAtStart) return;
      const agents = preview.agents.filter((agent) =>
        agent.source !== "hub" || agent.leased === true || allowedSlugs.has(agent.id.toLowerCase()));
      const keptHub = agents.filter((agent) => agent.source === "hub");
      const known = keptHub.filter((agent) => agent.estCredits != null);
      effectivePreview = {
        ...preview,
        agents,
        totalEstCredits: known.length ? known.reduce((sum, agent) => sum + (agent.estCredits ?? 0), 0) : null,
        ...(known.length < keptHub.length ? { totalEstCreditsPartial: true } : { totalEstCreditsPartial: undefined }),
      };
      suppressCostNotice = keptHub.length > 0
        && keptHub.every((agent) => agent.leased === true || allowedSlugs.has(agent.id.toLowerCase()));
    }
    // 4) 저신뢰 에스컬레이션 + 허브 후보/clarify → 선고용 금지, LLM 재랭킹 경로로 즉시 전송.
    const hubAgents = effectivePreview.agents.filter((a) => a.source !== "local");
    if (effectivePreview.routerAgent && (effectivePreview.mode === "clarify" || hubAgents.length > 0)) {
      onRecommendExecute?.({ kind: "plain", routerAgent: effectivePreview.routerAgent }, text, opts);
      finishComposerAfterSend();
      return;
    }
    // 5) 크레딧 게이트 — 허브 고용 비용이 잔액을 넘을 때만 페이월. 잔액 조회 실패 시 서버 과금이 최종 심판.
    //    hep-network 자동 개입 OFF면 자동 고용 자체가 없으므로 페이월도 건너뛴다.
    //    totalEstCreditsPartial=true 면 totalEstCredits 는 총액이 아니라 하한이다(단가 미상 Hub 행).
    //    그때 하한을 "필요 Ncr" 로 확정 표기하면 고지액보다 서버가 더 청구한다 —
    //    숫자는 하한임을 붙여 고지하고, 미상(null)도 0(무료)으로 삼키지 않는다.
    //    활성 장기대여 행은 main 이 이미 0으로 확정했다(leased) — 여기 합산에 그대로 반영된다.
    const costFloor = effectivePreview.totalEstCredits ?? 0;
    const costPartial = effectivePreview.totalEstCreditsPartial === true;
    if (engineToggles?.networkAuto === true && hubAgents.length > 0 && (costFloor > 0 || costPartial)) {
      const balance = await ipc()?.billing.getCredits().catch(() => null);
      if (activeChatIdRef.current !== chatIdAtStart) return;
      const have = balance?.remainingCredits;
      if (typeof have === "number" && have < costFloor) {
        setGateSheet({ kind: "paywall", text, opts, needed: costFloor, have, partialCost: costPartial, routerAgent: effectivePreview.routerAgent });
        return;
      }
      // 유료 자동 고용이 실제로 나가는 경로 — 명시적 렌트허용이 없는 고용에만
      // 작업당 예상 비용을 고지한다(렌트허용 ON은 고지 없이 호출·과금).
      if (!suppressCostNotice) flashCostNotice(costFloor, costPartial);
    }
    execAutoChoice(effectivePreview, text, opts, engineToggles);
  }

  /** 게이트 시트에서 "그냥/에이전트 없이 보내기" — 고용 없이 원문 전송. */
  function gateSendPlain() {
    const gate = gateSheet;
    if (!gate) return;
    setGateSheet(null);
    onRecommendExecute?.({ kind: "plain", routerAgent: gate.routerAgent }, gate.text, gate.opts);
    finishComposerAfterSend();
  }

  function requestAppsGenerateMode(next: boolean) {
    if (!next) {
      setAppsGenerateQuestionOpen(false);
      setAppsGenerateMode(false);
      return;
    }
    setPlusOpen(false);
    setPlusSubmenu(null);
    setPermOpen(false);
    setModelOpen(false);
    setAppsGenerateChoice("dedicated");
    setAppsGenerateQuestionOpen(true);
  }

  function applyAppsGenerateQuestion() {
    setAppsGenerateMode(appsGenerateChoice === "dedicated");
    setAppsGenerateQuestionOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  // 모든 ChatInput 메뉴의 단일 dismiss 계약: 자기 trigger/panel 안은 유지,
  // 나머지 화면은 pointerdown에 닫고, Escape는 닫은 뒤 trigger로 포커스를 돌린다.
  useEffect(() => {
    if (!activeLayer) return;
    function dismiss() {
      setActiveLayer(null);
      setPlusSubmenu(null);
      if (activeLayer === "agent-picker") setSelectedAgentIds(new Set());
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(`[data-popover-trigger="${activeLayer}"]`) ||
        target.closest(`[data-popover-kind="${activeLayer}"]`)
      ) return;
      dismiss();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const trigger = document.querySelector<HTMLElement>(`[data-popover-trigger="${activeLayer}"]`);
      dismiss();
      window.requestAnimationFrame(() => trigger?.focus());
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeLayer]);

  // 자동완성은 footer 전체가 아니라 목록 자체만 "내부"로 본다. 그래서 입력창이나
  // 채팅 본문을 누르면 닫히고, 목록 행을 누르는 동작은 그대로 onPick까지 전달된다.
  // pointerdown을 쓰면 마우스뿐 아니라 터치 입력에서도 같은 규칙으로 동작한다.
  useEffect(() => {
    if (!trigger) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-popover-kind="autocomplete"]')) return;
      setTrigger(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [trigger]);

  // ── 플러그인 목록 (설치된 에이전트의 MCP 서버 dedupe) ─────
  const plugins = useMemo(() => {
    const set = new Set<string>();
    for (const a of context?.agents ?? []) for (const m of a.mcpServers) set.add(m);
    return [...set];
  }, [context?.agents]);

  return (
    <footer
      className="titlebar-nodrag chat-input-footer"
      style={{
        borderTop: "none",
        padding: "8px 16px 10px",
        background: "transparent",
        position: "relative",
      }}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (Array.from(e.dataTransfer.types).includes("Files")) setDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
      }}
      onDragEnd={() => {
        dragDepthRef.current = 0;
        setDragActive(false);
      }}
    >
      {dragActive && (
        <div
          data-chat-drop-overlay="true"
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            inset: "4px 12px",
            zIndex: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            border: "2px dashed var(--accent)",
            borderRadius: 18,
            background: "color-mix(in srgb, var(--paper) 94%, transparent)",
            color: "var(--ink)",
            fontSize: 13,
            fontWeight: 700,
            pointerEvents: "none",
          }}
        >
          <IconFileUp size={17} style={{ color: "var(--accent)" }} />
          <span>{locale === "ko" ? "파일 또는 폴더를 놓아 첨부" : "Drop files or folders to attach"}</span>
        </div>
      )}

      {/* 슬래시/멘션 자동완성 popover */}
      {trigger && context && (
        <AutocompletePopover
          trigger={trigger}
          options={autocompleteOptions}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          t={t}
          onPick={applyAutocomplete}
        />
      )}

      {/* + 메뉴 popover */}
      {plusOpen && (
        <PlusMenu
          submenu={plusSubmenu}
          setSubmenu={setPlusSubmenu}
          plugins={plugins}
          onAddFile={() => {
            setPlusOpen(false);
            setPlusSubmenu(null);
            fileInputRef.current?.click();
          }}
          onAddFolder={async () => {
            setPlusOpen(false);
            setPlusSubmenu(null);
            const api = ipc();
            if (!api) return;
            try {
              const grant = await api.fs.pickDirectory();
              if (grant?.path) setFileGrants((a) => [...a, {
                grant,
                name: grant.path.split("/").filter(Boolean).at(-1) || "folder",
                mediaType: "application/vnd.agentlas.directory+json",
                size: 0,
                kind: grant.kind,
              }]);
            } catch {
              /* cancelled or denied */
            }
          }}
          planMode={planMode}
          setPlanMode={setPlanMode}
          goalMode={effectiveGoalMode}
          setGoalMode={toggleGoalMode}
          appsGenerateMode={appsGenerateMode}
          onToggleAppsGenerate={requestAppsGenerateMode}
          onInsertMention={() => {
            // This is a programmatic insertion, so React will not call
            // onInputChange for us. Keep the mention trigger in sync or the
            // user sees an @ but never gets the real agent/team autocomplete.
            const next = `${input}${input.endsWith(" ") || input === "" ? "" : " "}@`;
            setInput(next);
            setTrigger({ kind: "mention", query: "", startIndex: next.length - 1 });
            setPlusOpen(false);
            setPlusSubmenu(null);
            setTimeout(() => {
              textareaRef.current?.focus();
              textareaRef.current?.setSelectionRange(next.length, next.length);
            }, 0);
          }}
          hepToggles={hepToggles}
          onToggleHep={(id) => {
            // Stormbreaker OFF→ON 전환 감지 — 첫 활성화 시 비용/시간 경고 버블.
            const turningStormOn = id === "stormbreaker" && !hepToggles.has("stormbreaker");
            setHepToggles((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            if (id === "stormbreaker") {
              setShowStormWarning(turningStormOn && !isStormWarningDismissed());
            }
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          locale={locale}
          projectOrchestration={projectOrchestration}
          showModeToggles={showModeToggles}
          continuousMode={continuousMode}
          swarmMode={swarmMode}
          onToggleContinuous={() => {
            onToggleContinuous?.();
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          onToggleSwarm={() => {
            onToggleSwarm?.();
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          t={t}
        />
      )}

      {/* 에이전트 선택 팝업 */}
      {agentPickerOpen && context && (
        <AgentPickerPopup
          agents={context.agents}
          firms={context.firms}
          hubBookmarks={context.hubBookmarks ?? []}
          selected={selectedAgentIds}
          onToggle={(id) => {
            setSelectedAgentIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onConfirm={() => {
            setHepToggles((prev) => {
              const next = new Set(prev);
              next.delete("recommend");
              return next;
            });
            const nextCalls = [...selectedAgentIds].map((id) => {
              if (id.startsWith("hub:")) {
                const slug = id.slice("hub:".length);
                const bookmark = (context.hubBookmarks ?? []).find((item) => item.slug === slug);
                // 북마크가 팀이면 팀으로 부른다. 예전에는 여기서 "agent" 로 못박아
                // 팀과 에이전트가 같은 이름일 때 구분이 안 됐고, 그래서 호출 목록이
                // 아예 **양쪽 다 숨겼다**(callableHubBookmarks). 종류는 이미 알고 있다.
                const bookmarkKind = String(bookmark?.listing?.entityKind || "agent").toLowerCase() === "team" ? "team" : "agent";
                return { key: id, label: bookmark ? pickLocalized(bookmark.listing, locale).name : slug, target: { source: "hub", entityKind: bookmarkKind, slug } as OrchestrationTarget };
              }
              const selectedAgent = context.agents.find((item) => item.id === id);
              return { key: `a-${id}`, label: selectedAgent ? pickLocalized(selectedAgent, locale).name : id, target: { source: "local", entityKind: "agent", agentId: id } as OrchestrationTarget };
            });
            setTurnCalls((current) => [...current, ...nextCalls.filter((call) => !current.some((item) => item.key === call.key))]);
            setAgentPickerOpen(false);
            setSelectedAgentIds(new Set());
          }}
          onClose={() => {
            setAgentPickerOpen(false);
            setSelectedAgentIds(new Set());
          }}
          t={t}
          locale={locale}
        />
      )}

      {/* 권한 popover */}
      {permOpen && (
        <PermissionMenu
          value={permissions}
          setValue={(value) => {
            setPermissions(value);
            setPermOpen(false);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          t={t}
        />
      )}

      {/* 모델·작업량 popover */}
      {modelOpen && runtime && (
        <ModelMenu
          runtime={runtime}
          options={modelOptions ?? []}
          onSelectModel={(id) => {
            onSelectModel?.(id);
            setModelOpen(false);
          }}
          onSelectEffort={(id) => {
            onSelectEffort?.(id);
            setModelOpen(false);
          }}
          t={t}
        />
      )}

      {/* Stormbreaker 비용/시간 경고 버블 — 첫 활성화 시 1회 */}
      {showStormWarning && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            left: 16,
            bottom: "calc(100% + 8px)",
            zIndex: 45,
            maxWidth: 360,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            padding: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flexShrink: 0, color: "var(--amber-deep)", display: "inline-flex" }} aria-hidden>
              <IconSparkles size={14} />
            </span>
            <strong style={{ fontSize: 12.5, fontWeight: 700 }}>{t("chatinput.storm_warning.title")}</strong>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--ink-soft)" }}>
            {t("chatinput.storm_warning.body")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              data-popover-root
              onClick={() => {
                dismissStormWarning();
                setShowStormWarning(false);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 12px",
                border: "1px solid var(--paper-edge)",
                background: "var(--fill-1)",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              {t("chatinput.storm_warning.ok")}
            </button>
          </div>
        </div>
      )}

      {/* 자동 라우팅 진행 배지 — 시트 대신 컴팩트 상태만 보여준다(묻지 않음) */}
      {autoRouting && (
        <div
          data-autoroute-busy="true"
          style={{
            position: "absolute",
            left: 16,
            bottom: "calc(100% + 8px)",
            zIndex: 40,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          {t("chatinput.autoroute.routing")}
        </div>
      )}
      {/* 호출 전 비용 고지 — 유료 허브 고용이 나갈 때만 잠깐. 대여 비용≠성공 보장을 명시 */}
      {!autoRouting && costNotice && (
        <div
          data-autoroute-cost-notice="true"
          style={{
            position: "absolute",
            left: 16,
            bottom: "calc(100% + 8px)",
            zIndex: 40,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          <span aria-hidden style={{ flexShrink: 0 }}>🤝</span>
          {costNotice.partial
            ? `${t("chatinput.autoroute.cost_notice", { credits: costNotice.credits })} · ${t("chatinput.autoroute.cost_partial")}`
            : t("chatinput.autoroute.cost_notice", { credits: costNotice.credits })}
        </div>
      )}
      {/* 게이트 시트 — 크레딧 부족(paywall)·적합 에이전트 없음(build 제안)일 때만 */}
      {gateSheet && (
        <AutoRouteGateSheet
          gate={gateSheet}
          onPlain={gateSendPlain}
          onBuild={() => {
            setGateSheet(null);
            router.push("/build");
          }}
          onClose={() => setGateSheet(null)}
          t={t}
        />
      )}

      {appsGenerateQuestionOpen && (
        <BottomQuestionSheet
          progress={t("chatinput.apps_generate_sheet_progress")}
          title={t("chatinput.apps_generate_confirm")}
          options={[
            {
              id: "dedicated",
              title: t("chatinput.apps_generate_sheet_dedicated_title"),
              description: t("chatinput.apps_generate_sheet_dedicated_desc"),
              shortcut: "1",
            },
            {
              id: "chat",
              title: t("chatinput.apps_generate_sheet_chat_title"),
              description: t("chatinput.apps_generate_sheet_chat_desc"),
              shortcut: "2",
            },
          ]}
          value={appsGenerateChoice}
          onChange={setAppsGenerateChoice}
          onClose={() => setAppsGenerateQuestionOpen(false)}
          onSkip={() => {
            setAppsGenerateQuestionOpen(false);
            setAppsGenerateMode(false);
          }}
          onNext={applyAppsGenerateQuestion}
          t={t}
        />
      )}

      {stagedSteering && (
        <SteeringDraftBar
          draft={stagedSteering}
          busy={busy}
          locale={locale}
          onSend={sendStagedSteering}
          onDiscard={() => setStagedSteering(null)}
        />
      )}
      {!stagedSteering && queuedCount > 0 && (
        <SteeringQueueBar queuedCount={queuedCount} locale={locale} />
      )}
      {effectiveGoalMode && (
        <ComposerGoalBar
          label={progressLabel}
          criteria={goalCriteria}
          runStatus={goalRunStatus}
          pauseReason={goalPauseReason}
          blockedReason={goalBlockedReason}
          onResume={onResumeGoal}
          onPause={onPauseGoal}
          onEndGoal={() => toggleGoalMode(false)}
        />
      )}

      <ComposerDecisionSlot className="composer-decision-stack" surface="work" />
      <div
        className="chat-input-shell"
        data-has-progress={queuedCount > 0 || effectiveGoalMode ? "true" : "false"}
        style={{
          width: "min(100%, 740px)",
          margin: "0 auto",
          borderRadius: 20,
          padding: "9px 11px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "var(--paper)",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
        }}
      >
        {attachmentError && (
          <div
            role="alert"
            data-chat-attachment-error="true"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "8px 10px",
              border: "1px solid color-mix(in srgb, var(--red-deep) 26%, var(--paper-edge))",
              borderRadius: 10,
              background: "color-mix(in srgb, var(--red-deep) 7%, var(--paper))",
              color: "var(--red-deep)",
              fontSize: 11.5,
              lineHeight: 1.45,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{attachmentError}</span>
            <button
              type="button"
              onClick={() => setAttachmentError(null)}
              aria-label={t("common.close")}
              title={t("common.close")}
              style={{
                flexShrink: 0,
                width: 20,
                height: 20,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: 0,
                borderRadius: 6,
                background: "transparent",
                color: "currentColor",
                cursor: "pointer",
              }}
            >
              <IconClose size={12} />
            </button>
          </div>
        )}

        {/* 이미지 미리보기 */}
        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {images.map((img, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  width: 56,
                  height: 56,
                  borderRadius: 10,
                  overflow: "hidden",
                  border: "1px solid var(--paper-edge)",
                }}
                title={img.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  aria-label={t("chatinput.remove_image")}
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "rgba(0,0,0,0.7)",
                    color: "white",
                    border: "none",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {(fileGrants.length > 0 || pastedTexts.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 4px 6px" }}>
            {fileGrants.map((g, i) => (
              <span key={`${g.grant.scope.token}:${i}`} title={g.grant.path} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, padding: "4px 9px", borderRadius: 999, border: "1px solid var(--paper-edge, var(--paper-edge-strong))", background: "var(--paper-2, var(--paper-2))", fontSize: 12 }}>
                <span aria-hidden="true">{g.kind === "directory" ? "📁" : "📎"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                <button type="button" aria-label={locale === "ko" ? "첨부 제거" : "Remove attachment"} onClick={() => setFileGrants((a) => a.filter((_, j) => j !== i))} style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0.6 }}>×</button>
              </span>
            ))}
            {pastedTexts.map((p, i) => (
              <span key={`t${i}`} title={p.text.slice(0, 300)} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, padding: "4px 9px", borderRadius: 999, border: "1px solid var(--paper-edge, var(--paper-edge-strong))", background: "var(--paper-2, var(--paper-2))", fontSize: 12 }}>
                <span aria-hidden="true">📝</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <button type="button" aria-label={locale === "ko" ? "텍스트 제거" : "Remove text"} onClick={() => setPastedTexts((a) => a.filter((_, j) => j !== i))} style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0.6 }}>×</button>
              </span>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {turnCalls.length > 0 ? <div className="chat-turn-calls" aria-label={locale === "ko" ? "이번 턴에 호출할 에이전트" : "Agents for this turn"}>
          {turnCalls.map((call) => <button type="button" key={call.key} onClick={() => setTurnCalls((current) => current.filter((item) => item.key !== call.key))}>@{call.label}<span>×</span></button>)}
        </div> : null}

        {/* 텍스트 영역 */}
        <textarea
          ref={textareaRef}
          data-chat-input="true"
          aria-label={locale === "ko" ? "채팅 입력" : "Chat message"}
          value={input}
          onChange={onInputChange}
          onKeyDown={(e) => {
            // 한글 등 IME 조합 중에는 어떤 단축키도 가로채지 않는다 — 조합 중 Enter는 글자 확정,
            // Esc는 조합 취소다. 가로채면 한글 입력 중 조기 전송 / 실행 정지가 오발동한다.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            // 자동완성 popover가 떠 있을 때 ↑↓/Enter/Tab/Esc 가로챔
            if (trigger && autocompleteOptions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i < 0 ? 0 : (i + 1) % autocompleteOptions.length,
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i <= 0 ? autocompleteOptions.length - 1 : i - 1,
                );
                return;
              }
              // Tab = 텍스트만 자동완성(실행/전송 안 함). Enter = 선택(앱 명령 실행 / 에이전트 콜 / 텍스트 삽입).
              if (e.key === "Tab") {
                e.preventDefault();
                const opt = selectedAutocompleteOption();
                if (opt) applyAutocomplete(opt, true);
                return;
              }
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                // 여기까지 왔다는 것은 목록에 후보가 있다는 뜻이고(위 가드),
                // selectedAutocompleteOption() 은 아무것도 안 골랐어도 첫 후보로 떨어진다.
                // 그래서 Enter 는 늘 무언가를 고른다 — 삼켜지는 경우는 없다.
                e.preventDefault();
                const opt = selectedAutocompleteOption();
                if (opt) applyAutocomplete(opt);
                return;
              }
            }
            // 매칭 후보가 없으면 Enter는 사용자가 쓴 텍스트 그대로 전송한다. Tab만 포커스 이탈 방지.
            if (trigger && e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              return;
            }
            if (trigger && e.key === "Escape") {
              setTrigger(null);
              e.preventDefault();
              return;
            }
            // 실행 중 Cmd/Ctrl+Esc = 정지. 일반 Esc는 입력/IME 취소와 겹쳐 오발동하기 쉽다.
            if (busy && onStop && e.key === "Escape" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onStop();
              return;
            }
            // Enter = 즉시 전송, Shift+Enter = 줄바꿈. (자동완성 열림 시는 위에서 선택 처리)
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const files: File[] = [];
            for (const it of Array.from(items)) {
              if (it.type.startsWith("image/")) {
                const f = it.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
              return;
            }
            // 긴 텍스트 붙여넣기 → 입력창을 채우지 않고 에셋 칩으로 접는다(ChatGPT/Claude 패턴).
            const pasted = e.clipboardData?.getData("text/plain") ?? "";
            if (pasted.length > 1200) {
              e.preventDefault();
              const firstLine = pasted.split("\n").find((l) => l.trim())?.trim().slice(0, 40) || "text";
              setPastedTexts((a) => [...a, { name: `${firstLine}… (${pasted.length}${locale === "ko" ? "자" : " chars"})`, text: pasted }]);
            }
          }}
          placeholder={
            disabled
              ? t("chatinput.placeholder_disabled")
              : busy
                ? t("chatinput.placeholder_steering")
              : hepHint
                ? `${hepHint} · ${locale === "ko" ? "요청을 입력하세요" : "describe the request"}`
              : placeholder ?? t("chatinput.placeholder_rich")
          }
          rows={1}
          disabled={disabled}
          /* 초점 링은 감싼 작성창(.chat-input-shell:focus-within)이 그린다. */
          data-focus-ring="wrapper"
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            fontSize: 14,
            lineHeight: 1.5,
            background: "transparent",
            color: "var(--ink)",
            resize: "none",
            padding: "4px 6px",
            fontFamily: "var(--font-body)",
            minHeight: 42,
            maxHeight: 150,
            overflowY: "auto",
            boxSizing: "border-box",
          }}
        />

        {/* 하단 툴바 */}
        <div className="chat-input-toolbar">
          <div className="chat-input-tools-left">
            {/* + 메뉴 */}
            <button
              type="button"
              data-popover-trigger="plus"
              onClick={() => {
                setPlusOpen((v) => !v);
                setPlusSubmenu(null);
              }}
              data-chat-plus-button="true"
              aria-label={t("chatinput.plus")}
              aria-expanded={plusOpen}
              aria-haspopup="menu"
              title={t("chatinput.plus")}
              disabled={disabled}
              style={toolBtnStyle(plusOpen)}
            >
              <IconPlus size={15} />
            </button>

            {/* 활성 실행 모드는 하나의 상태 그룹으로 묶는다. 설정은 + 메뉴에서 찾고,
                이곳에서는 현재 켜진 모드를 확인하거나 바로 끌 수 있다. */}
            {(HEP_TOGGLES.some((tg) => hepToggles.has(tg.id) && (!projectOrchestration || tg.id !== "recommend")) ||
              (showModeToggles && !projectOrchestration && (continuousMode || swarmMode))) && (
              <div className="chat-input-hep-toggle-group" role="group" aria-label={locale === "ko" ? "활성 실행 모드" : "Active run modes"}>
                {HEP_TOGGLES.filter((tg) => hepToggles.has(tg.id) && (!projectOrchestration || tg.id !== "recommend")).map((tg) => (
                  <button
                    key={tg.id}
                    type="button"
                    className="chat-input-hep-chip active"
                    data-hep-toggle-id={tg.id}
                    onClick={() => {
                      setHepToggles((prev) => {
                        const next = new Set(prev);
                        next.delete(tg.id);
                        return next;
                      });
                      setTimeout(() => textareaRef.current?.focus(), 0);
                    }}
                    disabled={disabled}
                    title={`${locale === "ko" ? tg.labelKo : tg.labelEn} — ${locale === "ko" ? "끄기" : "turn off"}`}
                    aria-pressed={true}
                  >
                    <span className="chat-input-hep-dot" aria-hidden />
                    <span className="chat-input-hep-label">{locale === "ko" ? tg.labelKo : tg.labelEn}</span>
                  </button>
                ))}
                {showModeToggles && !projectOrchestration && continuousMode && <button
                  type="button"
                  className="chat-input-hep-chip active"
                  onClick={() => onToggleContinuous?.()}
                  disabled={disabled}
                  title={`${locale === "ko" ? "계속 라이브로" : "Keep going live"} — ${locale === "ko" ? "끄기" : "turn off"}`}
                  aria-pressed={true}
                >
                  <span className="chat-input-hep-dot" aria-hidden />
                  <span className="chat-input-hep-label">{locale === "ko" ? "계속 라이브로" : "Keep going live"}</span>
                </button>}
                {showModeToggles && !projectOrchestration && swarmMode && <button
                  type="button"
                  className="chat-input-hep-chip active"
                  onClick={() => onToggleSwarm?.()}
                  disabled={disabled}
                  title={`${locale === "ko" ? "스웜" : "Swarm"} — ${locale === "ko" ? "끄기" : "turn off"}`}
                  aria-pressed={true}
                >
                  <IconNetwork size={12} aria-hidden />
                  <span className="chat-input-hep-label">{locale === "ko" ? "스웜" : "Swarm"}</span>
                </button>}
              </div>
            )}

            {/* 권한 칩 */}
            <button
              className="chat-input-chip"
              data-popover-trigger="permission"
              onClick={() => setPermOpen((v) => !v)}
              disabled={disabled}
              style={{
                ...toolBtnStyle(permOpen),
                width: "auto",
                padding: "0 10px",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color:
                  permissions === "full"
                    ? "var(--red-deep)"
                    : permissions === "write"
                      ? "var(--amber-deep)"
                      : "var(--green-deep)",
              }}
            >
              <IconShield size={13} />
              <span className="chat-input-chip-label">
                {t(`chatinput.perm.${permissions}` as `chatinput.perm.${PermissionLevel}`)}
              </span>
              <IconChevronDown size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
            </button>

            {/* 모델·작업량은 권한 바로 뒤에 둔다. 둘 다 이 작업의 실행 범위를 정하는 설정이다. */}
            {runtime &&
              ((modelOptions?.length ?? 0) > 0 || effortOptionsForModel(runtime).length > 0) && (
                <button
                  className="chat-input-chip chat-input-model-chip"
                  data-popover-trigger="model"
                  onClick={() => setModelOpen((v) => !v)}
                  disabled={disabled}
                  title={t("chatinput.model")}
                  style={{
                    ...toolBtnStyle(modelOpen),
                    width: "auto",
                    padding: "0 10px",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink-soft)",
                  }}
                >
                  <IconSparkles size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                  <span className="chat-input-chip-label">
                    {modelChipLabel(runtime, modelOptions ?? [])}
                  </span>
                  <IconChevronDown size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
                </button>
              )}

          </div>

          <div className="chat-input-tools-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* 컨텍스트 지표는 "Runtime" 상태표가 아니라 세션 전환/정리 진입점이다. */}
            {tokensUsage && (
              <div style={{ position: "relative", flexShrink: 0 }}>
                <button
                  type="button"
                  data-popover-trigger="context"
                  className="chat-input-context-pill"
                  title={`${t("chatinput.context.menu_title")} · ${contextTokenLabel}`}
                  aria-label={t("chatinput.context.menu_title")}
                  aria-expanded={contextMenuOpen}
                  onClick={() => setContextMenuOpen((open) => !open)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "0 8px", height: 26, borderRadius: 13,
                    background: "var(--fill-1)", border: "1px solid var(--paper-edge)",
                    fontSize: 10, fontWeight: 650, color: "var(--muted-deep)",
                    minWidth: 0, cursor: "pointer",
                  }}
                >
                  <span>{t("chatinput.context.label")}</span>
                  <span className="chat-input-context-percent" style={{ color: "var(--accent)" }}>{contextTokenLabel}</span>
                  <IconChevronDown size={10} style={{ opacity: 0.65 }} />
                </button>
                {contextMenuOpen && (
                  <section
                    role="dialog"
                    aria-label={t("chatinput.context.menu_title")}
                    data-chat-context-menu="true"
                    data-popover-kind="context"
                    style={{
                      position: "absolute", right: 0, bottom: "calc(100% + 8px)", zIndex: 50,
                      width: 286, padding: 10, display: "grid", gap: 8,
                      border: "1px solid var(--paper-edge)", borderRadius: 10,
                      background: "var(--paper)", boxShadow: "0 12px 28px rgba(15, 23, 42, 0.14)",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--ink)", fontSize: 12, fontWeight: 800 }}>
                        <span>{t("chatinput.context.menu_title")}</span>
                        <span style={{ color: "var(--accent)" }}>{contextTokenLabel}</span>
                      </div>
                      <p style={{ margin: "4px 0 0", color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.45 }}>
                        {t("chatinput.context.menu_desc")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setContextMenuOpen(false); onSessionAction?.("new"); }}
                      disabled={!onSessionAction}
                      style={contextMenuActionStyle}
                    >
                      <span style={{ color: "var(--ink)", fontSize: 11.5, fontWeight: 780 }}>{t("chatinput.context.new")}</span>
                      <span style={contextMenuActionDescStyle}>{t("chatinput.context.new_desc")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setContextMenuOpen(false); onSessionAction?.("clear"); }}
                      disabled={!onSessionAction || busy}
                      title={busy ? t("chatinput.context.clear_busy") : undefined}
                      style={{ ...contextMenuActionStyle, opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
                    >
                      <span style={{ color: "var(--ink)", fontSize: 11.5, fontWeight: 780 }}>{t("chatinput.context.clear")}</span>
                      <span style={contextMenuActionDescStyle}>{t("chatinput.context.clear_desc")}</span>
                    </button>
                    {busy && <p style={{ margin: 0, color: "var(--amber-deep)", fontSize: 10.5, lineHeight: 1.4 }}>{t("chatinput.context.clear_busy")}</p>}
                  </section>
                )}
              </div>
            )}
            
            {/* Plan/Goal 모드 토글은 툴바에서 숨김 — + 메뉴(PlusMenu)의 ToggleRow로만 노출.
                켜져 있으면 아래 활성 칩(chat-input-active-modes)이 상태를 보여준다. */}
            {(planMode || effectiveGoalMode) && (
              <div style={{ display: "flex", gap: 4 }}>
                {planMode && (
                  <button
                    className="chat-input-chip"
                    onClick={() => setPlanMode(false)}
                    title={t("chatinput.plan_mode")}
                    style={{ ...toolBtnStyle(true), width: "auto", padding: "0 8px", gap: 4, fontSize: 10.5, fontWeight: 600, color: "var(--accent)" }}
                  >
                    <IconRoute size={12} />
                    <span className="chat-input-chip-label">{t("chatinput.plan_mode")}</span> ✕
                  </button>
                )}
                {effectiveGoalMode && (
                  <button
                    className="chat-input-chip"
                    // controlled(영속 goal)일 때 이 ×는 단순 off가 아니라 명시적 목표 종료다.
                    onClick={() => toggleGoalMode(false)}
                    title={t("chatinput.goal_mode")}
                    style={{ ...toolBtnStyle(true), width: "auto", padding: "0 8px", gap: 4, fontSize: 10.5, fontWeight: 600, color: "var(--accent)" }}
                  >
                    <IconTarget size={12} />
                    <span className="chat-input-chip-label">{t("chatinput.goal_mode")}</span> ✕
                  </button>
                )}
              </div>
            )}

            {/* 실행 중에는 Stop을 하나만 유지하고, 원형 버튼은 추가 지시(steering) 전송에 쓴다. */}
            {(() => {
              const showStop = busy && !!onStop;
              const stopLabel = stopRequested
                ? locale === "ko"
                  ? "중지 요청됨"
                  : "Stopping"
                : t("chat.stop");
              return (
                <>
                  {showStop && (
                    <button
                      type="button"
                      className="chat-input-stop-button"
                      data-chat-stop-button="true"
                      onClick={() => {
                        if (!stopRequested) onStop?.();
                      }}
                      disabled={stopRequested}
                      aria-label={stopLabel}
                      title={stopLabel}
                      style={{
                        width: 38,
                        height: 38,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 11,
                        border: "1px solid var(--paper-edge)",
                        background: "var(--paper)",
                        color: stopRequested ? "var(--muted-deep)" : "var(--ink)",
                        opacity: stopRequested ? 0.72 : 1,
                        cursor: stopRequested ? "default" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          border: "1.8px solid currentColor",
                          borderRadius: 2.5,
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                        aria-hidden
                      />
                    </button>
                  )}
                  <OneVoiceInputHelp locale={locale === "ko" ? "ko" : "en"} composerRef={textareaRef} disabled={disabled} surface="work" />
                  <button
                    type="button"
                    className="chat-input-send-button"
                    data-chat-steering-send={busy ? "true" : undefined}
                    onClick={submit}
                    disabled={submitDisabled}
                    /* 아무것도 안 썼을 때 회색인 것은 사유를 적을 필요가 없다(보면 안다). */
                    data-disabled-reason={submitDisabled && nothingToSend ? "empty-input" : undefined}
                    aria-label={busy
                      ? (locale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
                      : t("chatinput.send")}
                    title={submitDisabledReason ?? (busy
                      ? (locale === "ko" ? "현재 작업을 중단하지 않고 다음 지시를 보냅니다" : "Sends the next instruction without stopping the model")
                      : undefined)}
                    style={{
                      width: 38,
                      height: 38,
                      flexShrink: 0,
                      borderRadius: "50%",
                      background: !submitDisabled ? "var(--ink)" : "var(--paper-2)",
                      color: submitDisabled ? "var(--muted-deep)" : "var(--paper)",
                      border: `1px solid ${!submitDisabled ? "var(--ink)" : "var(--paper-edge)"}`,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: !submitDisabled ? "0 4px 12px rgba(15, 18, 20, 0.16)" : "none",
                      cursor: submitDisabled ? "default" : "pointer",
                    }}
                  >
                    <IconArrowUp size={15} />
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </footer>
  );
}

function ComposerGoalBar({
  label,
  criteria,
  runStatus,
  pauseReason,
  blockedReason,
  onResume,
  onPause,
  onEndGoal,
}: {
  label?: string;
  criteria?: string[];
  runStatus?: string;
  pauseReason?: string | null;
  /** 막힌 이유 — 저장소에는 있는데 화면까지 오지 않던 값이다. */
  blockedReason?: string | null;
  onResume?: () => void;
  onPause?: () => void;
  onEndGoal: () => void;
}) {
  const { locale } = useT();
  /*
   * ★멈춘 목표에 "이제 시작합니다" 라고 말하고 있었다 (오너 실데이터 실측 2026-09-08).
   *
   *   오너의 최신 목표는 `blocked` 상태로 서 있었다(막힌 이유: verification_inconclusive).
   *   그런데 이 막대는 `paused` 만 알고 `blocked` 는 몰라서, 아래 기본 문구로 떨어졌다:
   *   **"다음 요청으로 목표와 성공 기준을 확정합니다"** — 이미 굴러가다 막힌 목표에게
   *   아직 시작도 안 한 것처럼 말한 것이다. "안 닫힌다, 진행도 안 된다" 가 이 모습이다.
   *
   *   그리고 일시정지 사유도 둘(app_closed·crash_recovery)만 알아서, 실제로 걸려 있던
   *   `budget`(예산 소진)은 그냥 "일시정지됨" 으로만 나왔다 — 무엇을 하면 되는지가 없다.
   *
   *   멈춘 이유는 지어내지 않는다. 아는 사유는 사람 말로, 모르는 사유는 **원문 그대로**
   *   보여 준다(그래야 물어볼 수 있다). 이유 자체가 없으면 없다고 말한다.
   */
  const paused = runStatus === "paused";
  const pausing = runStatus === "pausing";
  const blocked = runStatus === "blocked" || runStatus === "failed";
  const knownReason = (reason: string | null | undefined): string | null => {
    if (!reason) return null;
    if (reason === "app_closed") return locale === "ko" ? "앱이 종료되어 멈춤" : "Stopped when the app closed";
    if (reason === "crash_recovery") return locale === "ko" ? "이전 실행 중단을 감지해 멈춤" : "Stopped after recovering an interrupted run";
    if (reason === "budget") return locale === "ko" ? "정해 둔 예산·횟수를 다 써서 멈춤" : "Stopped after using the set budget";
    if (reason === "runtime_unavailable") return locale === "ko" ? "실행할 엔진이 없어 멈춤" : "Stopped because no runtime was available";
    if (reason === "approval_required") return locale === "ko" ? "승인이 필요해 멈춤" : "Stopped waiting for approval";
    if (reason === "user") return locale === "ko" ? "직접 멈춤" : "Stopped by you";
    if (reason === "verification_inconclusive") {
      return locale === "ko"
        ? "결과를 확인하지 못해 멈춤 — 완료로 볼 근거가 부족합니다"
        : "Stopped because the result could not be verified";
    }
    if (reason === "verification_failed") {
      return locale === "ko"
        ? "성공 기준을 충족하지 못해 멈춤 — 검증 결과를 확인해 주세요"
        : "Stopped because acceptance criteria were not met — review the verification result";
    }
    const verificationReasons: Record<string, [string, string]> = {
      "verification_repair_stalled": ["수정 후에도 같은 기준을 통과하지 못해 멈춤", "Stopped after repeated repairs did not satisfy the same criteria"],
      "verification_prerequisite:authentication_required": ["연결된 계정의 인증이 필요해 멈춤", "Stopped because account authentication is required"],
      "verification_prerequisite:permission_required": ["추가 권한이 필요해 멈춤", "Stopped because additional permission is required"],
      "verification_prerequisite:approval_required": ["도구 승인 경로 확인이 필요해 멈춤", "Stopped because the required tool approval path needs attention"],
      "verification_prerequisite:entitlement_required": ["계정의 이용 권한이나 크레딧 확인이 필요해 멈춤", "Stopped because account access or credits need attention"],
      "verification_prerequisite:environment_unavailable": ["필요한 실행 환경을 사용할 수 없어 멈춤", "Stopped because a required environment is unavailable"],
      "verification_prerequisite:user_stopped": ["사용자 요청으로 멈춤", "Stopped at your request"],
      "verification_prerequisite:uncertain_side_effect": ["이전 작업의 실행 결과를 확인해야 해 멈춤", "Stopped because an earlier action's outcome needs confirmation"],
    };
    const verificationReason = verificationReasons[reason];
    if (verificationReason) return verificationReason[locale === "ko" ? 0 : 1];
    // 모르는 사유는 지어내지 않고 그대로 보여 준다.
    return locale === "ko" ? `멈춤 — 사유: ${reason}` : `Stopped — reason: ${reason}`;
  };
  const stoppedCopy = knownReason(blocked ? (blockedReason ?? pauseReason) : pauseReason)
    ?? (blocked
      ? (locale === "ko"
        ? "멈췄는데 이유가 기록되지 않았습니다. 같은 내용을 다시 보내면 이어서 진행합니다."
        : "It stopped and no reason was recorded. Send the same request again to continue.")
      : (locale === "ko" ? "일시정지됨" : "Paused"));
  const title = pausing ? (locale === "ko" ? "실행을 멈추는 중 · 목표는 보존됩니다" : "Stopping execution · goal preserved") : (paused || blocked)
    ? stoppedCopy
    : runStatus === "verifying"
      ? (locale === "ko" ? "결과를 성공 기준과 대조하는 중" : "Checking the result against acceptance criteria")
    : label?.replace(/\s+/g, " ").trim() || (locale === "ko"
      ? "다음 요청으로 목표와 성공 기준을 확정합니다"
      : "Your next request will define the goal and its acceptance criteria");
  const criteriaTitle = (criteria ?? []).join("\n");
  return (
    <div className="chat-composer-progress chat-composer-goal" role="status" aria-live="polite" data-chat-goal-bar="true">
      <span className="chat-composer-progress-icon" aria-hidden><IconTarget size={13} /></span>
      <strong>{locale === "ko" ? "목표" : "Goal"}</strong>
      <span className="chat-composer-progress-label" title={title}>{title}</span>
      {(criteria?.length ?? 0) > 0 && (
        <span className="chat-composer-goal-criteria" title={criteriaTitle}>
          {locale === "ko" ? `성공 기준 ${criteria?.length}개` : `${criteria?.length} criteria`}
        </span>
      )}
      {onPause && runStatus && !["paused", "pausing", "blocked", "failed", "completed", "cancelled", "cancelling"].includes(runStatus) && (
        <button type="button" onClick={onPause} data-chat-goal-pause="true"
          aria-label={locale === "ko" ? "목표 일시정지" : "Pause goal"}
          title={locale === "ko" ? "실행과 자동 이어가기를 멈추고 목표를 보존합니다" : "Stop execution and automatic continuation; keep the goal"}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" /></svg>
        </button>
      )}
      {paused && onResume && (
        <button
          type="button"
          onClick={onResume}
          data-chat-goal-resume="true"
          aria-label={locale === "ko" ? "목표 수동 재개" : "Resume goal manually"}
          title={locale === "ko" ? "이 앱에서 목표를 다시 실행합니다" : "Resume this goal in the app"}
        >
          {locale === "ko" ? "재개" : "Resume"}
        </button>
      )}
      <button
        type="button"
        onClick={onEndGoal}
        aria-label={locale === "ko" ? "목표 삭제" : "Delete goal"}
        title={locale === "ko" ? "목표를 삭제합니다. 대화와 작업 파일은 유지됩니다" : "Delete the goal; keep the conversation and files"}
      >
        <IconTrash size={12} />
      </button>
    </div>
  );
}

function SteeringQueueBar({ queuedCount, locale }: { queuedCount: number; locale: Locale }) {
  return (
    <div className="chat-composer-progress chat-composer-steering-queue" role="status" aria-live="polite" data-chat-steering-queued="true">
      <span className="chat-input-steering-pulse" aria-hidden />
      <strong>{locale === "ko" ? `다음 지시 ${queuedCount}개` : `${queuedCount} queued`}</strong>
      <span className="chat-composer-progress-label">
        {locale === "ko" ? "현재 모델을 멈추지 않고 이어서 반영합니다" : "Will be applied without stopping the current model"}
      </span>
    </div>
  );
}

function SteeringDraftBar({
  draft,
  busy,
  locale,
  onSend,
  onDiscard,
}: {
  draft: StagedSteeringDraft;
  busy: boolean;
  locale: Locale;
  onSend: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="chat-steering-draft" role="group" aria-label={locale === "ko" ? "보낼 작업 조정" : "Staged work adjustment"} data-chat-steering-draft="true">
      {draft.previewDataUrl ? (
        <img src={draft.previewDataUrl} alt="" className="chat-steering-draft-preview" />
      ) : draft.attachmentCount > 0 ? (
        <span className="chat-steering-draft-attachment" aria-hidden><IconPaperclip size={13} /></span>
      ) : (
        <span className="chat-steering-draft-grip" aria-hidden><IconMoreHorizontal size={13} /></span>
      )}
      <span className="chat-steering-draft-copy" title={draft.text}>{draft.text}</span>
      <button
        type="button"
        className="chat-steering-draft-send"
        onClick={onSend}
        title={busy
          ? (locale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
          : (locale === "ko" ? "새 작업으로 보내기" : "Send as a new turn")}
        data-chat-steering-send="true"
      >
        {busy ? (locale === "ko" ? "현재 작업 조정" : "Adjust current work") : (locale === "ko" ? "보내기" : "Send")}
      </button>
      <button
        type="button"
        className="chat-steering-draft-discard"
        onClick={onDiscard}
        aria-label={locale === "ko" ? "작업 조정 지우기" : "Discard work adjustment"}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

// Streaming output lives in TaskCockpit, but the composer owns substantial
// local input/menu state. With stable props this boundary prevents every model
// partial from re-rendering the textarea while the user is typing.
export const ChatInput = memo(ChatInputComponent);
ChatInput.displayName = "ChatInput";

const contextMenuActionStyle = {
  display: "grid",
  gap: 2,
  width: "100%",
  minWidth: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper-2)",
  padding: "8px 9px",
  textAlign: "left" as const,
  cursor: "pointer",
};

const contextMenuActionDescStyle = {
  color: "var(--muted-deep)",
  fontSize: 10.5,
  lineHeight: 1.35,
  overflowWrap: "anywhere" as const,
};

function BottomQuestionSheet({
  progress,
  title,
  options,
  value,
  onChange,
  onClose,
  onSkip,
  onNext,
  t,
}: {
  progress: string;
  title: string;
  options: BottomQuestionOption[];
  value: AppGenerateChoice;
  onChange: (value: AppGenerateChoice) => void;
  onClose: () => void;
  onSkip: () => void;
  onNext: () => void;
  t: TFunction;
}) {
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-popover-root
      data-popover-kind="apps-question"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 980,
        margin: "0 auto",
        zIndex: 40,
        borderRadius: 0,
        border: "1px solid var(--paper-edge)",
        background: "var(--paper)",
        boxShadow: "none",
        padding: 12,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          onNext();
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          style={{
            flexShrink: 0,
            borderRadius: 999,
            background: "var(--fill-1)",
            color: "var(--amber-deep)",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 7px",
          }}
        >
          {progress}
        </span>
        <h2
          style={{
            margin: 0,
            minWidth: 0,
            flex: 1,
            fontSize: 14,
            lineHeight: 1.35,
            color: "var(--ink)",
            fontWeight: 750,
          }}
        >
          {title}
        </h2>
        <button
          onClick={onClose}
          aria-label={t("workspace.close_panel")}
          title={t("workspace.close_panel")}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
            flexShrink: 0,
          }}
        >
          <IconClose size={13} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((option) => {
          const picked = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              style={{
                width: "100%",
                minHeight: 50,
                display: "flex",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                padding: "9px 10px",
                borderRadius: 8,
                background: picked ? "var(--fill-1)" : "var(--paper-2)",
                border: picked ? "1px solid color-mix(in srgb, var(--accent) 34%, var(--paper-edge))" : "1px solid transparent",
                color: "var(--ink)",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong
                  style={{
                    display: "block",
                    fontSize: 12.5,
                    lineHeight: 1.25,
                    fontWeight: 750,
                    color: "var(--ink)",
                  }}
                >
                  {option.title}
                </strong>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: 11.5,
                    lineHeight: 1.35,
                    color: "var(--muted-deep)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {option.description}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  minWidth: 22,
                  height: 22,
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  color: picked ? "var(--accent)" : "var(--muted-deep)",
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                }}
              >
                {option.shortcut}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button
          onClick={onSkip}
          style={{
            borderRadius: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          {t("chatinput.question_skip")}
        </button>
        <button
          onClick={onNext}
          style={{
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--paper-edge))",
            background: "var(--fill-1)",
            color: "var(--accent)",
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 750,
          }}
        >
          {t("chatinput.question_next")}
        </button>
      </div>
    </section>
  );
}

// ── 자동 라우팅 게이트 시트 ─────────────────────────────
// 자동 라우팅은 원칙적으로 묻지 않는다. 유일한 예외 둘:
//   paywall — 허브 고용 비용이 잔액을 넘을 때(크레딧 없을 때만 페이월).
//   build   — 라우팅할 적합 에이전트가 정말 없을 때(에이전트 빌드 제안).
function AutoRouteGateSheet({
  gate,
  onPlain,
  onBuild,
  onClose,
  t,
}: {
  gate: AutoRouteGate;
  onPlain: () => void;
  onBuild: () => void;
  onClose: () => void;
  t: TFunction;
}) {
  const isPaywall = gate.kind === "paywall";
  const title = isPaywall ? t("chatinput.autoroute.paywall_title") : t("chatinput.autoroute.build_title");
  // 단가 미상 Hub 행이 섞이면 needed 는 확정 필요액이 아니라 하한 — "필요 Ncr" 로 못 박지 않고
  // "최소 필요" 로 표기하고 실청구가 더 클 수 있음을 같이 알린다(고지액 < 실청구액 방지).
  const desc = isPaywall
    ? `${t("chatinput.autoroute.paywall_desc")} — ${t(gate.partialCost ? "chatinput.autoroute.paywall_needed_min" : "chatinput.autoroute.paywall_needed")} ${gate.needed ?? 0}cr · ${t("chatinput.autoroute.paywall_have")} ${gate.have ?? 0}cr${gate.partialCost ? ` · ${t("chatinput.autoroute.cost_partial")}` : ""}`
    : gate.reason || t("chatinput.autoroute.build_desc");
  const buttonBase: React.CSSProperties = {
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-autoroute-gate={gate.kind}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 980,
        margin: "0 auto",
        zIndex: 40,
        border: "1px solid var(--paper-edge)",
        background: "var(--paper)",
        padding: 12,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: "var(--muted-deep)" }}>{desc}</div>
      <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onPlain}
          style={{
            ...buttonBase,
            border: "1px solid var(--paper-edge)",
            background: "transparent",
            color: "var(--muted-deep)",
          }}
        >
          {isPaywall ? t("chatinput.autoroute.paywall_skip") : t("chatinput.autoroute.build_skip")}
        </button>
        <button
          type="button"
          onClick={isPaywall ? openPricing : onBuild}
          style={{
            ...buttonBase,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--paper)",
            fontWeight: 700,
          }}
        >
          {isPaywall ? t("chatinput.autoroute.paywall_cta") : t("chatinput.autoroute.build_cta")}
        </button>
      </div>
    </section>
  );
}

// ── 평탄화된 자동완성 옵션 빌더 ──────────────────────────
// 키보드 ↑↓ 인덱스가 그룹 헤더를 건너뛰도록 옵션만 flat list로 모으고,
// 표시 시 group이 바뀔 때만 그룹 헤더를 그린다.
function buildAutocompleteOptions(
  trigger: { kind: "mention"; query: string; startIndex: number },
  context: MentionContext,
  locale: "ko" | "en",
  t: TFunction,
): AutocompleteOption[] {
  const q = trigger.query.toLowerCase();
  const out: AutocompleteOption[] = [];

  // mention — 그룹: generated apps → agents → firms → projects → env, 각 최대 5개
  const generatedApps = (context.generatedApps ?? [])
    .filter((app) => {
      const name = generatedAppMentionName(app).toLowerCase();
      return app.status !== "archived" && (!q || name.includes(q) || app.id.toLowerCase().includes(q));
    })
    .slice(0, 5);
  // @멘션 검색은 두 언어 표시명(및 로컬 별칭)을 모두 본다 (U-D-4): 등록
  // 표시명이 영문으로 굳은 'Researcher'를 한글 UI에서 '리서처'로 못 찾으면
  // 사용자는 방금 만든 팀원이 사라졌다고 본다. 표시는 로케일 규칙 그대로다.
  const nameMatches = (
    item: { name: string; nameEn?: string; localDisplayName?: string },
    slug: string,
  ) => !q
    || item.name.toLowerCase().includes(q)
    || (item.nameEn ?? "").toLowerCase().includes(q)
    || (item.localDisplayName ?? "").toLowerCase().includes(q)
    || slug.toLowerCase().includes(q);
  const agents = context.agents
    .filter((a) => nameMatches(a, a.slug))
    .slice(0, 5);
  const hubBookmarks = callableHubBookmarks(context.hubBookmarks ?? [], context.agents)
    .filter((bookmark) => nameMatches(bookmark.listing, bookmark.listing.slug))
    .slice(0, 5);
  const firms = context.firms
    .filter((f) => nameMatches(f, f.slug))
    .slice(0, 5);
  const projects = context.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .slice(0, 5);
  const envs = context.envKeys
    .filter((k) => !q || k.toLowerCase().includes(q))
    .slice(0, 5);

  for (const app of generatedApps) {
    const name = generatedAppMentionName(app);
    out.push({
      key: `ga-${app.id}`,
      group: locale === "en" ? "Generated Apps" : "생성된 Apps",
      kind: "app",
      title: name,
      subtitle: locale === "en" ? "Edit or delete with a chat request" : "수정/삭제 요청으로 연결",
      replacement: `@${name}`,
    });
  }
  for (const a of agents) {
    const loc = pickLocalized(a, locale);
    out.push({
      key: `a-${a.id}`,
      group: t("sidebar.agents"),
      kind: "agent",
      title: loc.name,
      subtitle: loc.tagline,
      replacement: `@${loc.name}`,
      // An installed team package must staff its team, not itself as a single
      // agent — Main rejects that shape and the whole run dies before any worker.
      target: installedAgentMentionTarget(a, context.firms) ?? undefined,
    });
  }
  for (const bookmark of hubBookmarks) {
    const loc = pickLocalized(bookmark.listing, locale);
    out.push({
      key: `hub-${bookmark.slug}`,
      group: locale === "en" ? "Hub bookmarks" : "Hub 북마크",
      kind: "hub",
      title: loc.name,
      subtitle: loc.tagline,
      replacement: `@${loc.name}`,
      target: {
        source: "hub",
        entityKind: String(bookmark.listing?.entityKind || "agent").toLowerCase() === "team" ? "team" : "agent",
        slug: bookmark.slug,
      },
    });
  }
  for (const f of firms) {
    const loc = pickLocalized(f, locale);
    out.push({
      key: `f-${f.id}`,
      group: t("sidebar.firms"),
      kind: "firm",
      title: loc.name,
      subtitle: loc.tagline,
      replacement: `@${loc.name}`,
      target: { source: "local", entityKind: "team", firmId: f.id },
    });
  }
  for (const p of projects) {
    out.push({
      key: `p-${p.id}`,
      group: t("sidebar.projects"),
      kind: "project",
      title: p.name,
      replacement: `@${p.name}`,
    });
  }
  for (const k of envs) {
    out.push({
      key: `e-${k}`,
      group: t("env.title"),
      kind: "env",
      title: k,
      replacement: `@${k}`,
    });
  }
  return out;
}

function generatedAppMentionName(app: AppFactoryAppRecord): string {
  return app.appName || app.manifest.app?.name || app.manifest.title || "Generated App";
}

// ── 자동완성 popover (/ 또는 @) ──────────────────────────
function AutocompletePopover({
  trigger,
  options,
  activeIndex,
  onHover,
  t,
  onPick,
}: {
  trigger: { kind: "mention"; query: string; startIndex: number };
  options: AutocompleteOption[];
  activeIndex: number;
  onHover: (i: number) => void;
  t: TFunction;
  onPick: (opt: AutocompleteOption) => void;
}) {
  const optionsRef = useRef<HTMLDivElement>(null);
  const title = t("chatinput.mention_title");

  // 키보드로 목록 끝까지 이동해도 현재 행이 popover의 보이는 영역 안에 남게 한다.
  // block/inline 모두 nearest라서 바깥 채팅 화면을 불필요하게 움직이지 않는다.
  useEffect(() => {
    const activeOption = optionsRef.current?.querySelector<HTMLElement>(
      `[data-autocomplete-index="${activeIndex}"]`,
    );
    activeOption?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, options.length]);

  if (options.length === 0) {
    return (
      <Popover title={title} dataKind="autocomplete" role="listbox">
        <EmptyHint>{t("chatinput.no_match")}</EmptyHint>
      </Popover>
    );
  }
  // 그룹 헤더는 같은 group이 처음 등장할 때만 그린다.
  const seenGroups = new Set<string>();
  return (
    <Popover title={title} dataKind="autocomplete" role="listbox">
      <div ref={optionsRef}>
        {options.map((opt, i) => {
          const showHeader = opt.group && !seenGroups.has(opt.group);
          if (opt.group) seenGroups.add(opt.group);
          return (
            <div key={opt.key} data-autocomplete-index={i}>
              {showHeader && <GroupLabel>{opt.group}</GroupLabel>}
              <Row
                onClick={() => onPick(opt)}
                onHover={() => onHover(i)}
                active={i === activeIndex}
                icon={kindIcon(opt.kind)}
                title={opt.title}
                subtitle={opt.subtitle}
                autocompleteOption
              />
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

function kindIcon(kind: AutocompleteOption["kind"]) {
  switch (kind) {
    case "app":
      return <IconApps size={13} style={{ color: "var(--accent)" }} />;
    case "agent":
      return <IconSparkles size={13} style={{ color: "var(--accent)" }} />;
    case "hub":
      return <IconRoute size={13} style={{ color: "var(--accent)" }} />;
    case "firm":
      return <IconBuilding size={13} style={{ color: "var(--accent)" }} />;
    case "project":
      return <IconFolder size={13} style={{ color: "var(--muted-deep)" }} />;
    case "env":
      return <IconKey size={13} style={{ color: "var(--peach-ink)" }} />;
  }
}

// ── + 메뉴 ───────────────────────────────────────────────
function PlusMenu({
  submenu,
  setSubmenu,
  plugins,
  onAddFile,
  onAddFolder,
  planMode,
  setPlanMode,
  goalMode,
  setGoalMode,
  appsGenerateMode,
  onToggleAppsGenerate,
  onInsertMention,
  hepToggles,
  onToggleHep,
  locale,
  projectOrchestration,
  showModeToggles,
  continuousMode,
  swarmMode,
  onToggleContinuous,
  onToggleSwarm,
  t,
}: {
  submenu: "plugins" | null;
  setSubmenu: (s: "plugins" | null) => void;
  plugins: string[];
  onAddFile: () => void;
  onAddFolder: () => void;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  goalMode: boolean;
  setGoalMode: (v: boolean) => void;
  appsGenerateMode: boolean;
  onToggleAppsGenerate: (v: boolean) => void;
  /** "@" 에이전트 부르기 삽입. */
  onInsertMention: () => void;
  /** 현재 켜진 Hephaestus 모드들(다중선택). */
  hepToggles: Set<HepToggleId>;
  /** Hephaestus 모드 토글(스톰브레이커 경고·포커스 등은 부모가 처리). */
  onToggleHep: (id: HepToggleId) => void;
  locale: string;
  projectOrchestration: boolean;
  /** 실행 모드 토글(계속 라이브로·스웜) 노출 여부. */
  showModeToggles: boolean;
  continuousMode: boolean;
  swarmMode: boolean;
  onToggleContinuous: () => void;
  onToggleSwarm: () => void;
  t: TFunction;
}) {
  if (submenu === "plugins") {
    return (
      <Popover dataKind="plus">
        <button
          onClick={() => setSubmenu(null)}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
          }}
        >
          <IconChevronRight size={11} style={{ transform: "rotate(180deg)" }} />
          {t("chatinput.plus.plugins")}
        </button>
        {plugins.length === 0 ? (
          <EmptyHint>{t("chatinput.no_plugins")}</EmptyHint>
        ) : (
          plugins.map((p) => (
            <Row
              key={p}
              icon={<IconLayers size={13} style={{ color: "var(--accent)" }} />}
              title={p}
            />
          ))
        )}
      </Popover>
    );
  }
  return (
    <Popover dataKind="plus" role="menu">
      <Row
        onClick={onAddFile}
        icon={<IconFileUp size={14} />}
        title={t("chatinput.plus.attach")}
      />
      <Row
        onClick={onAddFolder}
        icon={<IconFolder size={14} />}
        title={t("chatinput.plus.attach_folder")}
      />
      <Row
        onClick={() => setSubmenu("plugins")}
        icon={<IconLayers size={14} style={{ color: "var(--accent)" }} />}
        title={t("chatinput.plus.plugins")}
        right={<IconChevronRight size={11} style={{ color: "var(--muted)" }} />}
      />
      <Divider />
      <ToggleRow
        icon={<IconRoute size={14} />}
        title={t("chatinput.plan_mode")}
        on={planMode}
        onChange={setPlanMode}
      />
      <ToggleRow
        icon={<IconTarget size={14} />}
        title={t("chatinput.goal_mode")}
        on={goalMode}
        onChange={setGoalMode}
      />
      {!projectOrchestration && <ToggleRow
          icon={<IconApps size={14} />}
          title={t("chatinput.apps_generate_mode")}
          on={appsGenerateMode}
          onChange={onToggleAppsGenerate}
        />}
      {!projectOrchestration && showModeToggles && (
        <>
          <Divider />
          <ToggleRow
            icon={
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: continuousMode ? "var(--accent)" : "var(--muted)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
            }
            title={locale === "ko" ? "계속 라이브로" : "Keep going live"}
            subtitle={
              locale === "ko"
                ? "멈추지 않고 라이브로 계속 작업 (끝나거나 멈출 때까지)"
                : "Keep working live without stopping until done or stopped"
            }
            on={continuousMode}
            onChange={onToggleContinuous}
          />
          <ToggleRow
            icon={<IconNetwork size={14} aria-hidden />}
            title={locale === "ko" ? "스웜" : "Swarm"}
            subtitle={
              locale === "ko"
                ? "목표를 쪼개 여러 에이전트가 동시에 협업"
                : "Split the goal across parallel agents"
            }
            on={swarmMode}
            onChange={onToggleSwarm}
          />
        </>
      )}
      {!projectOrchestration && <Divider />}
      {!projectOrchestration && HEP_TOGGLES.map((tg) => (
        <ToggleRow
          key={tg.id}
          hepToggleId={tg.id}
          icon={
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: hepToggles.has(tg.id) ? "var(--accent)" : "var(--muted)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          }
          title={locale === "ko" ? tg.labelKo : tg.labelEn}
          subtitle={locale === "ko" ? tg.titleKo : tg.titleEn}
          on={hepToggles.has(tg.id)}
          onChange={() => onToggleHep(tg.id)}
        />
      ))}
      <Divider />
      <Row
        onClick={onInsertMention}
        icon={<IconAtSign size={14} />}
        title={locale === "ko" ? "특정 에이전트 지정 (선택)" : "Specify an agent (optional)"}
        subtitle={locale === "ko" ? "이 턴에만 수동으로 추가" : "One-turn manual override"}
      />
    </Popover>
  );
}

// ── 권한 메뉴 ─────────────────────────────────────────────
function PermissionMenu({
  value,
  setValue,
  t,
}: {
  value: PermissionLevel;
  setValue: (v: PermissionLevel) => void;
  t: TFunction;
}) {
  const opts: Array<{ id: PermissionLevel; color: string }> = [
    { id: "read", color: "var(--green-deep)" },
    { id: "write", color: "var(--amber-deep)" },
    { id: "full", color: "var(--red-deep)" },
  ];
  return (
    <Popover title={t("chatinput.perm.title")} dataKind="permission">
      {opts.map((o) => (
        <Row
          key={o.id}
          onClick={() => setValue(o.id)}
          icon={<IconShield size={13} style={{ color: o.color }} />}
          title={t(`chatinput.perm.${o.id}` as `chatinput.perm.${PermissionLevel}`)}
          subtitle={t(`chatinput.perm.${o.id}.desc` as `chatinput.perm.${PermissionLevel}.desc`)}
          right={value === o.id ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>•</span> : undefined}
        />
      ))}
    </Popover>
  );
}

// ── 모델·작업량 메뉴 ──────────────────────────────────────
// Image #2의 Claude Code 모델 메뉴를 입력창 안에 재현: 모델 목록 + 작업량.
// 목록은 실시간(runtime.listModels / 모델별 effort 프로필)이라 CLI가 업데이트되면 자동 반영.
function ModelMenu({
  runtime,
  options,
  onSelectModel,
  onSelectEffort,
  t,
}: {
  runtime: RuntimeStatus;
  options: ModelOption[];
  onSelectModel: (id: string) => void;
  onSelectEffort: (id: string) => void;
  t: TFunction;
}) {
  const efforts = effortOptionsForModel(runtime);
  const currentEffort = efforts.some((effort) => effort.id === runtime.effort)
    ? runtime.effort
    : null;
  // CLI/ACP에서 모델을 생략하면 엔진 설정을 사용한다. BYOK·로컬·Agentlas는 실제 모델이 필수다.
  const allowDefaultModel = runtimeUsesEngineModelSetting(runtime.kind);
  const managedByRuntime = CONTEXT_MANAGED_BY[runtime.kind] === "runtime";
  const check = <span style={{ color: "var(--accent)", fontWeight: 700 }}>•</span>;
  const modelIcon = <IconSparkles size={13} style={{ color: "var(--accent)" }} />;
  const effortIcon = <IconRoute size={13} style={{ color: "var(--muted-deep)" }} />;

  return (
    <Popover title={t("chatinput.model")} dataKind="model">
      {allowDefaultModel && (
        <Row
          onClick={() => onSelectModel("")}
          icon={modelIcon}
          title={t("chat.model.engine_setting")}
          right={!runtime.model ? check : undefined}
        />
      )}
      {options.map((o) => (
        <Row
          key={o.id}
          onClick={() => onSelectModel(o.id)}
          icon={modelIcon}
          title={o.label}
          subtitle={o.tag}
          right={runtime.model === o.id ? check : undefined}
        />
      ))}
      {efforts.length > 0 && (
        <>
          <Divider />
          <GroupLabel>{t("chatinput.effort")}</GroupLabel>
          <Row
          onClick={() => onSelectEffort("")}
          icon={effortIcon}
          title={t("chat.effort.default")}
          right={!currentEffort ? check : undefined}
        />
          {efforts.map((e) => (
            <Row
              key={e.id}
              onClick={() => onSelectEffort(e.id)}
              icon={effortIcon}
              title={e.label}
              right={currentEffort === e.id ? check : undefined}
            />
          ))}
        </>
      )}
      <Divider />
      <div style={{ padding: "6px 10px", fontSize: 10.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
        {managedByRuntime
          ? t("settings.runtime.managed_runtime")
          : t("settings.runtime.managed_agentlas")}
      </div>
    </Popover>
  );
}

// ── popover primitives ──────────────────────────────────
function Popover({
  title,
  children,
  dataKind,
  role,
  align = "left",
}: {
  title?: string;
  children: React.ReactNode;
  dataKind?: string;
  role?: React.AriaRole;
  /** 트리거가 우측 그룹에 있으면 "right" — 메뉴가 트리거 반대편에 열리지 않게 한다. */
  align?: "left" | "right";
}) {
  return (
    <div
      data-popover-root
      data-popover-kind={dataKind}
      role={role}
      className="glass-lift"
      style={{
        position: "absolute",
        bottom: "calc(100% - 4px)",
        ...(align === "right" ? { right: 16 } : { left: 16 }),
        minWidth: 240,
        maxWidth: 320,
        maxHeight: 360,
        overflowY: "auto",
        borderRadius: 14,
        padding: 6,
        zIndex: 100,
      }}
    >
      {title && (
        <div
          style={{
            padding: "6px 10px 4px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: "var(--muted-deep)",
          }}
        >
          {title}
        </div>
      )}
      {dataKind === "plus" ? (
        // Keep the established QA/accessibility boundary as a nested alias.
        // The outer `plus` layer owns dismissal; the alias lets older hosts
        // locate the same real menu without changing click behavior.
        <div data-popover-kind="plus-menu">{children}</div>
      ) : children}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px 2px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: "var(--muted-deep)",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--paper-edge)",
        margin: "4px 6px",
      }}
    />
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--muted-deep)" }}>
      {children}
    </div>
  );
}

function Row({
  onClick,
  onHover,
  active,
  icon,
  title,
  subtitle,
  right,
  autocompleteOption = false,
}: {
  onClick?: () => void;
  /** 마우스가 위로 올라오면 호출 — 키보드 activeIndex와 마우스 활성을 동기화 */
  onHover?: () => void;
  /** 키보드 ↑↓로 선택된 행이면 true */
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  autocompleteOption?: boolean;
}) {
  // active일 때는 hover 색을 항상 표시 — inline 토글이라 ref로 보존하지 않음
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      data-autocomplete-option={autocompleteOption ? "true" : undefined}
      role={autocompleteOption ? "option" : undefined}
      aria-selected={autocompleteOption ? (active ? "true" : "false") : undefined}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        minHeight: 46,
        padding: "8px 10px",
        borderRadius: 8,
        background: active ? "var(--fill-1)" : "transparent",
        border: "none",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.background = "var(--fill-1)";
        onHover?.();
      }}
      onMouseLeave={(e) => {
        // active면 hover 색을 유지
        e.currentTarget.style.background = active ? "var(--fill-1)" : "transparent";
      }}
    >
      <span style={{ flexShrink: 0, color: "var(--ink-soft)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        {subtitle && (
          <span
            style={{
              display: "block",
              fontSize: 10.5,
              color: "var(--muted-deep)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {right}
    </button>
  );
}

function ToggleRow({
  icon,
  title,
  subtitle,
  on,
  onChange,
  hepToggleId,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  /** Locale-independent hook for Hephaestus mode controls and release QA. */
  hepToggleId?: HepToggleId;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      data-hep-toggle-id={hepToggleId}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
        background: "transparent",
        border: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--fill-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ flexShrink: 0, color: on ? "var(--accent)" : "var(--ink-soft)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
          {title}
        </span>
        {subtitle && (
          <span style={{ display: "block", marginTop: 2, fontSize: 11, lineHeight: 1.35, color: "var(--muted-deep)" }}>
            {subtitle}
          </span>
        )}
      </span>
      <span
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          background: on ? "var(--accent)" : "var(--paper-edge)",
          position: "relative",
          transition: "background 0.12s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "white",
            transition: "left 0.12s",
            boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
          }}
        />
      </span>
    </button>
  );
}

// 도구 버튼 공통 스타일
function toolBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    flexShrink: 0,
    borderRadius: 8,
    background: active ? "var(--fill-1)" : "transparent",
    color: active ? "var(--accent)" : "var(--ink-soft)",
    border: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.12s",
    cursor: "pointer",
  };
}

// ── 에이전트 선택 팝업 ─────────────────────────────────────
function AgentPickerPopup({
  agents,
  firms,
  hubBookmarks,
  selected,
  onToggle,
  onConfirm,
  onClose,
  t,
  locale,
}: {
  agents: InstalledAgent[];
  firms: InstalledFirm[];
  hubBookmarks: HubAgentBookmark[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  t: TFunction;
  locale: "ko" | "en";
}) {
  const [search, setSearch] = useState("");
  const q = search.toLowerCase();

  // 검색은 두 언어 표시명을 모두 본다 (U-D-4): 등록 표시명이 영문으로 굳은
  // 에이전트('Researcher')를 한글('리서처') UI에서 못 찾거나, 그 반대가 되면
  // 사용자는 "만들었는데 없다"를 본다. 로컬 별칭(localDisplayName)도 포함.
  const matchesAllNames = (
    item: { name: string; nameEn?: string; localDisplayName?: string },
    slug: string,
  ) => !q
    || item.name.toLowerCase().includes(q)
    || (item.nameEn ?? "").toLowerCase().includes(q)
    || (item.localDisplayName ?? "").toLowerCase().includes(q)
    || slug.toLowerCase().includes(q);
  const filteredFirms = firms.filter((f) => matchesAllNames(f, f.slug));
  const filteredAgents = agents.filter((a) => matchesAllNames(a, a.slug));
  const filteredHubBookmarks = callableHubBookmarks(hubBookmarks, agents).filter(
    (bookmark) => matchesAllNames(bookmark.listing, bookmark.slug),
  );

  const selectedCount = selected.size;

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={t("chatinput.agent_picker.title")}
      data-popover-root
      data-popover-kind="agent-picker"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 480,
        margin: "0 auto",
        zIndex: 50,
        borderRadius: 16,
        border: "1px solid var(--paper-edge)",
        background: "var(--paper)",
        backdropFilter: "blur(24px)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.08) inset",
        padding: 0,
        overflow: "hidden",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter" && selectedCount > 0) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px 10px",
          borderBottom: "1px solid var(--paper-edge)",
        }}
      >
        <IconUsers size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <h2
          style={{
            margin: 0,
            flex: 1,
            fontSize: 14,
            fontWeight: 750,
            color: "var(--ink)",
          }}
        >
          {t("chatinput.agent_picker.title")}
        </h2>
        {selectedCount > 0 && (
          <span
            style={{
              borderRadius: 999,
              background: "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: "var(--accent)",
              fontSize: 11,
              fontWeight: 700,
              padding: "2px 8px",
            }}
          >
            {t("chatinput.agent_picker.selected", { count: selectedCount })}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={t("chatinput.agent_picker.cancel")}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          <IconClose size={13} />
        </button>
      </div>

      {/* 검색 */}
      <div style={{ padding: "10px 16px 6px" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chatinput.agent_picker.search")}
          autoFocus
          style={{
            width: "100%",
            border: "1px solid var(--paper-edge)",
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 12.5,
            color: "var(--ink)",
            background: "var(--fill-1)",
            outline: "none",
            fontFamily: "var(--font-body)",
          }}
        />
      </div>

      {/* 리스트 */}
      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          padding: "4px 8px",
        }}
      >
        {filteredFirms.length === 0 && filteredAgents.length === 0 && filteredHubBookmarks.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--muted-deep)",
            }}
          >
            {t("chatinput.agent_picker.empty")}
          </div>
        ) : (
          <>
            {/* 팀(Firm) 섹션 */}
            {filteredFirms.length > 0 && (
              <>
                <div
                  style={{
                    padding: "8px 10px 4px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--muted-deep)",
                  }}
                >
                  {t("chatinput.agent_picker.teams")}
                </div>
                {filteredFirms.map((f) => {
                  const loc = pickLocalized(f, locale);
                  const checked = selected.has(f.ceoAgentId);
                  return (
                    <AgentPickerRow
                      key={f.id}
                      checked={checked}
                      onToggle={() => onToggle(f.ceoAgentId)}
                      icon={<IconBuilding size={14} style={{ color: "var(--accent)" }} />}
                      name={loc.name}
                      tagline={loc.tagline}
                      badge={locale === "en" ? "Team" : "팀"}
                    />
                  );
                })}
              </>
            )}
            {/* 싱글 에이전트 섹션 */}
            {filteredAgents.length > 0 && (
              <>
                <div
                  style={{
                    padding: "8px 10px 4px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--muted-deep)",
                  }}
                >
                  {t("chatinput.agent_picker.singles")}
                </div>
                {filteredAgents.map((a) => {
                  const loc = pickLocalized(a, locale);
                  const checked = selected.has(a.id);
                  return (
                    <AgentPickerRow
                      key={a.id}
                      checked={checked}
                      onToggle={() => onToggle(a.id)}
                      icon={<IconSparkles size={14} style={{ color: "var(--accent)" }} />}
                      name={loc.name}
                      tagline={loc.tagline}
                    />
                  );
                })}
              </>
            )}
            {/* Hub 북마크 — 설치/소유 에이전트가 아니라 이 채팅에서 빌려 부를 라우팅 참조. */}
            {filteredHubBookmarks.length > 0 && (
              <>
                <div
                  style={{
                    padding: "8px 10px 4px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--muted-deep)",
                  }}
                >
                  {locale === "en" ? "Hub bookmarks" : "Hub 북마크"}
                </div>
                {filteredHubBookmarks.map((bookmark) => {
                  const loc = pickLocalized(bookmark.listing, locale);
                  const key = `hub:${bookmark.slug}`;
                  return (
                    <AgentPickerRow
                      key={key}
                      checked={selected.has(key)}
                      onToggle={() => onToggle(key)}
                      icon={<IconRoute size={14} style={{ color: "var(--accent)" }} />}
                      name={loc.name}
                      tagline={loc.tagline}
                      badge="Hub"
                    />
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {/* 하단 버튼 */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "10px 16px 14px",
          borderTop: "1px solid var(--paper-edge)",
        }}
      >
        <button
          onClick={onClose}
          style={{
            borderRadius: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 650,
            cursor: "pointer",
          }}
        >
          {t("chatinput.agent_picker.cancel")}
        </button>
        <button
          onClick={onConfirm}
          disabled={selectedCount === 0}
          style={{
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--paper-edge))",
            background: selectedCount > 0
              ? "color-mix(in srgb, var(--accent) 12%, var(--paper))"
              : "var(--fill-1)",
            color: selectedCount > 0 ? "var(--accent)" : "var(--muted-deep)",
            padding: "7px 16px",
            fontSize: 12,
            fontWeight: 750,
            cursor: selectedCount > 0 ? "pointer" : "not-allowed",
            transition: "all 0.15s",
          }}
        >
          {t("chatinput.agent_picker.confirm")}
          {selectedCount > 0 && ` (${selectedCount})`}
        </button>
      </div>
    </section>
  );
}

function AgentPickerRow({
  checked,
  onToggle,
  icon,
  name,
  tagline,
  badge,
}: {
  checked: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  name: string;
  tagline?: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 10,
        background: checked
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent",
        border: checked
          ? "1px solid color-mix(in srgb, var(--accent) 20%, var(--paper-edge))"
          : "1px solid transparent",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!checked)
          e.currentTarget.style.background = "var(--fill-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = checked
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent";
      }}
    >
      {/* 체크박스 */}
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          border: checked
            ? "2px solid var(--accent)"
            : "2px solid var(--paper-edge)",
          background: checked ? "var(--accent)" : "var(--paper)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "all 0.12s",
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 5L4.2 7.5L8 2.5"
              stroke="white"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {/* 아이콘 */}
      <span style={{ flexShrink: 0, color: "var(--ink-soft)" }}>{icon}</span>
      {/* 텍스트 */}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 650,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
          {badge && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: "var(--accent)",
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                padding: "1px 5px",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              {badge}
            </span>
          )}
        </span>
        {tagline && (
          <span
            style={{
              display: "block",
              fontSize: 10.5,
              color: "var(--muted-deep)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tagline}
          </span>
        )}
      </span>
    </button>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
