"use client";
import { ComposerDecisionSlot } from "../ComposerDecisionPortal";
import { mergeGoalResults, type GoalResultPresentation } from "../../../shared/goal-result";
import { GoalResultReport } from "../GoalResultReport";
import type { ChatHostNotice } from "../../../shared/types";
import { normalizeChatHostNotice } from "../../../shared/chat-host-notice";
import { HostContinuationNotice } from "../HostContinuationNotice";
import { OneGoalControls } from "./OneGoalControls";

import { useRouter, useSearchParams } from "next/navigation";
import { failureMessage, isChatBusyFailure } from "@/lib/invocation-failure";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { bindAgentScreenScope } from "@/lib/agent-screen-scope";
import { Markdown, StreamingMarkdown, type LinkedFileArtifact } from "@/components/Markdown";
import { AskCard, type AskCardOption } from "@/components/AskCard";
import { OneDocumentCard } from "@/components/one/OneDocumentCard";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import { readOneDocumentMark } from "@/lib/one-document-mark";
import { OneSplitPane } from "@/components/one/OneSplitPane";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import {
  IconArrowUp,
  IconAlertTriangle,
  IconBolt,
  IconChevronDown,
  IconCheck,
  IconClose,
  IconFileUp,
  IconFolder,
  IconMoreHorizontal,
  IconPanelRight,
  IconPlus,
  IconRoute,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconShield,
  IconSparkles,
  IconUsers,
} from "@/components/Icon";
import { grantForDroppedFile, grantForPastedAttachment, grantForPastedImage, ipc, ipcEvents } from "@/lib/ipc";
import { tFor, useT } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import { onHubBookmarkChange } from "@/lib/hub-bookmark-events";
import { pickLocalized } from "@/lib/i18n";
import { extractQuestions } from "@/lib/ask-question";
import {
  detectOneTextLocale,
  type OneConversationLocale,
} from "@/lib/one-conversation-locale";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import type {
  Chat,
  ChatHistoryEntry,
  CommittedQuestionAnswer,
  FailureEventUi,
  InvocationRunReceipt,
  InstalledAgent,
  InstalledMcpServer,
  McpServerStatus,
  McpToolCatalogEntry,
  McpInvocationEvent,
  McpRunKeyRequest,
  MobileBridgeRuntimeStatus,
  OneBriefingSnapshot,
  OneMemoryMapSnapshot,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneExperienceReuseState,
  OneImprovementProofReadState,
  OneImprovementReusedAssetV1,
  OneProfile,
  OneBriefingActionPacket,
  OneProactiveBriefing,
  OneSearchHitV1,
  OneSuggestionState,
  OneTeamMemberUnavailableReason,
  OneTeamPreflightProposal,
  OneTeamPreflightRef,
  OneValueClosureState,
  OneWeeklyReflectionSnapshotV1,
  PendingConfirmation,
  UpdaterState,
} from "@/lib/types";
import { isCallOnlyHubAgent } from "@shared/call-only-agent";
import type { OneOrgCollaborationStyle, OneOrgMember, OneOrgState } from "@shared/one-org";
import type { OneTaskforce } from "@shared/one-taskforces";
import type { ComputerHistoryState } from "@shared/computer-history";
import {
  type OneFeatureIntroBlockingStateCategory,
  type OneFeatureIntroResolution,
  type OneFeatureIntroState,
} from "@shared/one-feature-intro";
import type {
  OneActivationState,
} from "@shared/one-activation";
import { ONE_MEMORY_MAP_CONTRACT_VERSION } from "@shared/one-memory-map";
import type {
  OneSurfaceManifestV1,
  OneSurfaceSemanticAction,
} from "@shared/one-surface";
import { toCustomerSafeText } from "@shared/one-customer-safe";
import { stripAgentControlBlocks, stripAgentIdentityBadges } from "@shared/agent-control-blocks";
import { classifyOneRequestIntent } from "@shared/one-request-intent";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { toolFailureCopy } from "@shared/tool-failure";
import { useJudgedOneDecision } from "@/lib/one-decision-judged";
import { visibleDecisionReceipt } from "@/lib/one-decision-receipt";
import { mergeDurableChatCatchup } from "./durable-chat-catchup";
import { alwaysApprovedChatIds, grantAlwaysApproval, subscribeAlwaysApproved } from "@/lib/always-approved-chats";
import type { OneRecurrenceSelectionV1 } from "@shared/one-recurrence";
import { seatEventLine } from "@shared/one-seat-events";
import { shouldPresentOneWeeklyReflection } from "@shared/one-weekly-reflection";
import {
  isOneTeamPreflightExpired,
  isOneTeamPreflightPendingStatus,
  isOneTeamPreflightTerminalStatus,
} from "@shared/one-team-preflight";
import {
  ONE_ATTACHMENT_LIMITS,
  type OneAttachmentPrepareItem,
  type OneAttachmentSafeItem,
  type PreparedOneAttachments,
} from "@shared/one-attachments";
import type { FsPathGrant, HubAgentBookmark, MarketplaceListing, OneSeatView, OrchestrationTarget, RuntimeSelection, RuntimeStatus } from "@shared/types";
import { ONE_BRIEFING_CONTRACT_VERSION, isOneProactiveBriefing } from "@shared/one-briefing";
import {
  isPendingConfirmationSnoozed,
  normalizeOneDecision,
  type OneDecisionField,
  type OneDecisionViewV1,
} from "@shared/one-decision";
import {
  chooseOneBriefing,
  formatTimestamp,
  getOneTaskProjection,
  listOneTaskProjections,
  ONE_INTRO_ACK_KEY,
  type OneTaskProjection,
} from "@/lib/one-task-adapter";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneBottomSheet } from "./OneBottomSheet";
import { DescribeAutomation } from "@/components/automation/DescribeAutomation";
import { OneAdaptiveResult, type OneAgentDraftSeed } from "./OneAdaptiveResult";
import { OneFeatureIntro } from "./OneFeatureIntro";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneMemoryMap } from "./OneMemoryMap";
import { OneMemoryCandidateCard } from "./OneMemoryCandidateCard";
import { OneProfileSheet } from "./OneProfileSheet";
import { OneSuggestionCard } from "./OneSuggestionCard";
import { OneGrowthCard } from "./OneGrowthCard";
import { TaskSidePanel, taskBrowserUrl, type OneLiveAppPreview } from "../workspace/TaskSidePanel";
import { OneOrgChart, type OneOrgSearchItem } from "./OneOrgChart";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { llmLogoSrc } from "@/lib/llm-logo";
import { OneCreateAgentDialog, type OneCreateAgentSeed, type OneEditMemberTarget, type OneEditSelfTarget } from "./OneCreateAgentDialog";
import { OneTaskforceDialog, OneTaskforceRail } from "./OneTaskforces";
import { OneComputerHistory } from "./OneComputerHistory";
import { OneSettingsRail, OneSettingsSheet, type OneSettingsKey } from "./OneSettings";
import type { OneWorkerWorkGroup } from "@/lib/one-turn-work";
import type { OneWorkerPanelSelection, OneWorkerPanelRun } from "@/lib/one-worker-panel";
import { OneTurnWork, OneTurnWorkDividers } from "./OneTurnWork";
import { OneTaskforceConversation } from "./OneTaskforceConversation";
import { buildOneWorkPresentation } from "@/lib/one-turn-work";
import { isDocumentLikeText } from "@/lib/one-doc-like";
import { requestOneArtifactOpen } from "@/lib/one-artifact-open";
import {
  outputPresentationKindForManifest,
  outputPresentationKindForName,
  type OutputPresentationKind,
} from "@/lib/output-presentation";
import { planOneThreadWork, projectThreadRuns, type OneThreadRunBlock } from "@/lib/one-thread-work";
import { memberUnavailable, speakableCountIncludingOne } from "@/lib/one-team-availability";
import { ToolApprovalInline } from "@/components/ToolApprovalInline";

/*
 * One 작성창의 폭. **OneShell.module.css 의 `.composer { width: min(720px, 100%) }` 와
 * 같은 값이어야 한다** — 승인 칩이 이 값을 받아 작성창과 나란히 선다.
 *
 * ★왜 상수로 두고 게이트를 거는가: 예전에는 이 자리에 920 이 손으로 박혀 있었는데,
 * CSS 의 작성창 폭은 나중 규칙에서 720 으로 바뀌었고 숫자만 옛 값에 멈췄다. 화면에는
 * 칩이 작성창보다 넓게(그리고 다른 자리에서는 좁게) 떴다. 상수는 반드시 드리프트한다 —
 * 게이트 test:approval-chip-matches-composer 가 이 값과 CSS 를 대조한다.
 */
const ONE_COMPOSER_WIDTH_PX = 720;
/** One 의 작성창은 양옆 여백을 빼지 않는다(Work 는 32px 를 뺀다). */
const ONE_COMPOSER_INSET_PX = 0;
import { ChatFileCards } from "@/components/ChatFileExperience";
import {
  appendChatFileMarker,
  chatFileItem,
  chatFilesBridge,
  parseChatFileMessage,
  requestChatFileOpen,
  type ChatFileItem,
} from "@/lib/chat-files";
import {
  OneComposerControls,
  type OneComposerMenuKey,
  type OneComposerModelOption,
  type OneComposerPluginOption,
  type OnePermissionMode,
} from "./OneComposerControls";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { OneWeeklyReflectionCard } from "./OneWeeklyReflectionCard";
import { PluginPickerDialog } from "@/components/plugins/PluginPickerDialog";
import {
  beginOneActivityState,
  initialOneActivityState,
  projectOneActivityFromLedger,
  reduceOneActivity,
  type OneActivityState,
} from "@/lib/one-activity";
import styles from "./OneShell.module.css";

// IPC 결과는 호출마다 새 객체다. 내용이 같으면 이전 상태 참조를 돌려줘 React가
// 리렌더를 생략하게 한다(모든 IPC 페이로드는 구조상 JSON 직렬화 가능).
function keepPrevIfDeepEqual<T>(next: T): (prev: T | null | undefined) => T {
  return (prev) => {
    if ((prev as unknown) === next) return next;
    try {
      // JSON이 같으면 구조도 같으므로 이전 참조를 그대로 돌려줘도 안전하다.
      return JSON.stringify(prev) === JSON.stringify(next) ? (prev as T) : next;
    } catch {
      return next;
    }
  };
}

function oneTeamPreflightErrorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const ONE_PERMISSION_STORAGE_KEY = "agentlas.one.permission-mode.v1";
const ONE_RUNTIME_STORAGE_KEY = "agentlas.one.runtime-selection.v1";
const ONE_LEFT_RAIL_COLLAPSED_STORAGE_KEY = "agentlas.one.left-rail-collapsed.v1";
/*
 * v2 (2026-08-24): 예전 키에는 "열림" 이 저장돼 있어서, 보여줄 산출물이 하나도
 * 없는 대화에서도 오른쪽 패널이 탭만 띄운 채 화면 절반을 먹고 있었다.
 * 이제 닫힌 채로 시작하고, 그 대화가 실제로 무언가를 만들면 한 번 열린다.
 */
const ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY = "agentlas.one.context-rail-open.v2";
/** 홈 화면 기록 열의 펼침 상태. 기본 닫힘 — 오너 결정 2026-08-25 "다 접힌 상태". */
const ONE_HOME_HISTORY_OPEN_STORAGE_KEY = "agentlas.one.home-history-open.v1";
/** The right rail is resizable (owner request 2026-08-16); the width persists like its open state. */
/*
 * v2 로 올린 이유(오너 결정 2026-08-24 "디폴트 값 지금의 반으로 줄여라"):
 * 예전 키에는 화면 절반을 넘는 폭이 이미 저장돼 있어서, 기본값만 줄여도
 * 실제로 뜨는 폭은 그대로였다(실측 648px = 상한까지 벌어진 값).
 * 키를 올려 모두가 새 기본 폭에서 시작하고, 그 뒤 직접 끈 폭은 그대로 남는다.
 */
const ONE_CONTEXT_RAIL_WIDTH_STORAGE_KEY = "agentlas.one.context-rail-width.v2";
/* 처음 열릴 때 오른쪽 패널이 화면을 너무 많이 먹었다 — 기본을 절반으로 줄인다
   (오너 결정 2026-08-24). 사용자가 넓히면 그 값이 기억되므로 기본만 낮춘다. */
/* 실제로 뜨던 폭(실측 648px)의 절반 — 오너 결정 2026-08-24. */
const ONE_CONTEXT_RAIL_WIDTH_DEFAULT = 324;
/*
 * 하한은 기본값보다 커서는 안 된다. 340 이던 동안 기본값 210 은 clamp 에
 * 걸려 한 번도 화면에 나온 적이 없다 — 저장된 값이 사람의 선택이려면
 * 사람이 고를 수 있는 값이어야 한다.
 */
const ONE_CONTEXT_RAIL_WIDTH_MIN = 200;
const ONE_CONTEXT_RAIL_WIDTH_MAX = 1280;
/** A file viewer needs enough room for document chrome and readable body text. */
const ONE_CONTEXT_RAIL_FILE_READABLE_WIDTH = 560;
/* 오너 지시 2026-08-24: "켜져도 지금의 반만". 0.432 -> 0.216. */
const ONE_CONTEXT_RAIL_RESULT_RATIO = 0.216;

type OnePaneCommitWaiter = Readonly<{
  wait: (chatId: string) => Promise<void>;
  observe: (routeChatId: string | null, paneChatId: string | null) => void;
  reject: (chatId: string, cause: unknown) => void;
  dispose: () => void;
}>;

function createOnePaneCommitWaiter(timeoutMs = 5_000): OnePaneCommitWaiter {
  type Pending = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (cause: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  const reject = (chatId: string, cause: unknown) => {
    const request = pending.get(chatId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(chatId);
    request.reject(cause);
  };
  return {
    wait(chatId) {
      const existing = pending.get(chatId);
      if (existing) return existing.promise;
      let resolve!: () => void;
      let rejectPromise!: (cause: unknown) => void;
      const promise = new Promise<void>((resolveCommit, rejectCommit) => {
        resolve = resolveCommit;
        rejectPromise = rejectCommit;
      });
      const timer = setTimeout(() => reject(chatId, new Error(`One conversation pane did not commit: ${chatId}`)), timeoutMs);
      pending.set(chatId, { promise, resolve, reject: rejectPromise, timer });
      return promise;
    },
    observe(routeChatId, paneChatId) {
      if (!routeChatId || routeChatId !== paneChatId) return;
      const request = pending.get(routeChatId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(routeChatId);
      request.resolve();
    },
    reject,
    dispose() {
      for (const chatId of [...pending.keys()]) reject(chatId, new Error("One conversation pane waiter disposed"));
    },
  };
}

function oneOrgBrowserPreviewState(): OneOrgState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    generatedAt: now,
    members: [{
      id: "preview:chief-of-staff",
      agentSlug: "chief-of-staff",
      installedAgentId: "preview:chief-of-staff",
      displayName: "Chief of Staff",
      nameEn: "Chief of Staff",
      icon: "one-puppy",
      source: "local",
      sortOrder: 0,
      leaseExpiresAt: null,
      addedAt: now,
      updatedAt: now,
      archivedAt: null,
      statusKind: "quiet",
      statusLine: "제품 업데이트 정리 완료",
      statusLineEn: "Product update summary ready",
      lastActivityAt: now,
      pendingCount: 0,
      pendingKind: "review",
      unreadCount: 1,
      unreadGeneration: 1,
      creditState: "ok",
      completionSummary: { produced: [], pending: [] },
      autoSelectTools: true,
      collaborationStyle: "default",
      title: "Chief of Staff",
      description: "",
      identityEditable: false,
      runtimeSelection: null,
      revision: 1,
    }],
    slots: { used: 2, capacity: 4, available: 2, includesOne: true, recommended: 4, hardMax: 8, cores: 10, totalMemGB: 32, userSet: false },
  };
}

function contextRailViewportMax(): number {
  if (typeof window === "undefined") return ONE_CONTEXT_RAIL_WIDTH_MAX;
  return window.innerWidth <= 1080
    ? Math.max(ONE_CONTEXT_RAIL_WIDTH_MIN, window.innerWidth - 56)
    : Math.max(ONE_CONTEXT_RAIL_WIDTH_MIN, window.innerWidth - 252 - 440);
}

function clampContextRailWidth(value: number): number {
  if (!Number.isFinite(value)) return ONE_CONTEXT_RAIL_WIDTH_DEFAULT;
  return Math.min(ONE_CONTEXT_RAIL_WIDTH_MAX, contextRailViewportMax(), Math.max(ONE_CONTEXT_RAIL_WIDTH_MIN, Math.round(value)));
}

function preferredContextResultWidth(): number {
  if (typeof window === "undefined") return 720;
  const requested = window.innerWidth <= 1080
    ? Math.round(window.innerWidth * 0.43)
    : Math.round(window.innerWidth * ONE_CONTEXT_RAIL_RESULT_RATIO);
  return clampContextRailWidth(requested);
}

function readableContextFileWidth(): number {
  return clampContextRailWidth(ONE_CONTEXT_RAIL_FILE_READABLE_WIDTH);
}

function readStoredContextRailWidth(): number {
  if (typeof window === "undefined") return ONE_CONTEXT_RAIL_WIDTH_DEFAULT;
  const raw = Number(window.localStorage.getItem(ONE_CONTEXT_RAIL_WIDTH_STORAGE_KEY));
  return raw > 0 ? clampContextRailWidth(raw) : ONE_CONTEXT_RAIL_WIDTH_DEFAULT;
}
const oneActivitySessionCache = new Map<string, OneActivityState>();
const EMPTY_ONE_MEMORY_MAP: OneMemoryMapSnapshot = Object.freeze({
  contractVersion: ONE_MEMORY_MAP_CONTRACT_VERSION,
  generatedAt: "",
  sourceRevision: "renderer-empty",
  nodes: [],
  edges: [],
  clusterCount: 0,
});

function readStoredOnePermission(): OnePermissionMode {
  if (typeof window === "undefined") return "full";
  const value = window.localStorage.getItem(ONE_PERMISSION_STORAGE_KEY);
  return value === "auto" || value === "read" || value === "write" || value === "full" ? value : "full";
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return value === "true" ? true : value === "false" ? false : fallback;
}

function readStoredOneRuntimeSelection(): RuntimeSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(ONE_RUNTIME_STORAGE_KEY) ?? "null") as Partial<RuntimeSelection> | null;
    if (!value || typeof value.kind !== "string" || typeof value.backend !== "string") return null;
    return {
      kind: value.kind as RuntimeSelection["kind"],
      backend: value.backend,
      ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
      ...(typeof value.effort === "string" && value.effort ? { effort: value.effort } : {}),
      ...(typeof value.longContext === "boolean" ? { longContext: value.longContext } : {}),
      role: "orchestrator",
      inherit: false,
    };
  } catch {
    return null;
  }
}

function writeStoredOneRuntimeSelection(selection: RuntimeSelection): void {
  try {
    window.localStorage.setItem(ONE_RUNTIME_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // A storage failure must not make the model picker unusable for this turn.
  }
}

function oneEffortLabel(id: string): string {
  const known: Record<string, string> = {
    none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
    high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra",
  };
  return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Keep One's compact model picker on the same per-model effort contract as
 * the full Runtime settings surface. */
function withOneRuntimeSelection(
  runtime: RuntimeStatus,
  model: string | null,
  requestedEffort: string | null | undefined,
): RuntimeStatus {
  const profile = model ? runtime.allocationModelProfiles?.[model] : undefined;
  const supported = profile?.efforts;
  const effort = supported === undefined
    ? requestedEffort ?? runtime.effort ?? null
    : requestedEffort && supported.includes(requestedEffort)
      ? requestedEffort
      : profile?.defaultEffort ?? supported[0] ?? null;
  return {
    ...runtime,
    model,
    effort,
    efforts: supported === undefined
      ? runtime.efforts
      : supported.map((id) => ({ id, label: oneEffortLabel(id) })),
  };
}

function cacheOneActivity(chatId: string, state: OneActivityState): void {
  oneActivitySessionCache.delete(chatId);
  oneActivitySessionCache.set(chatId, state);
  while (oneActivitySessionCache.size > 24) {
    const oldest = oneActivitySessionCache.keys().next().value;
    if (!oldest) break;
    oneActivitySessionCache.delete(oldest);
  }
}

const DECISION_REJECT_FALLBACK = {
  ko: "거절과 나중에 결정은 승인이나 외부 실행을 시작하지 않습니다.",
  en: "Rejecting or deciding later does not approve or start an external action.",
} as const;

/**
 * 자동 승인이 보낼 답. 시트가 보여 주던 첫 승인 선택지를 그대로 쓴다 —
 * 사람이 눌렀을 때와 같은 문자열이어야 기록이 갈라지지 않는다.
 */
function firstApprovalLabel(confirmation: PendingConfirmation): string | null {
  const option = confirmation.options?.find((item) => Boolean(item?.label));
  return option?.label ?? null;
}

function decisionRejectCopy(locale: "ko" | "en"): string {
  const key = "one.shell.decision.reject_hint" as const;
  const value = tFor(locale, key);
  return value === key ? DECISION_REJECT_FALLBACK[locale] : value;
}

type UiMessage = {
  goalResult?: GoalResultPresentation;
  hostNotice?: ChatHostNotice;
  id: string;
  /** Exact Main-issued transcript identity for a settled assistant row. */
  durableMessageId?: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  /*
   * ★첨부는 대화의 일부다 — 보내고 나면 사라지던 것을 남긴다.
   *
   * 이 모델에는 첨부가 들어갈 자리 자체가 없었다. 그래서 사진을 붙여 보내면 작성 중
   * 미리보기만 잠깐 보이고, 보내는 순간 화면에서 사라졌다(Work 쪽 ChatStream 은
   * 예전부터 그렸다). 텍스트 없이 사진만 보낸 턴은 아예 렌더 조건에 걸려 통째로
   * 없어졌다.
   */
  images?: string[];
  files?: Array<{ name: string; kind: "image" | "file" | "directory" }>;
  chatFiles?: ChatFileItem[];
  chatFileGroupIds?: string[];
  /** Durable rows only (ISO). Optimistic rows have none and sort after every durable row. */
  createdAt?: string;
};

type DisplayBriefing = ReturnType<typeof chooseOneBriefing> & {
  proactive?: OneProactiveBriefing;
};

type ArmedOneMemoryUseOnce = {
  receipt: OneMemoryUseOnceReceipt;
  targetKey: string;
};

type PendingTeamPrompt = {
  proposalId: string;
  text: string;
  attachments: PreparedOneAttachments | null;
  recurrence: OneRecurrenceSelectionV1 | null;
  overrides: OneTurnOverrides;
  taskForceTargets: OrchestrationTarget[];
  runtimeSelection?: RuntimeSelection;
};

type OneTurnOverrides = {
  goalMode?: true;
  /** Renderer intent fence; never passed to Main as authority. */
  goalControlEpoch?: number;
  planMode?: true;
  sessionRouting?: true;
  fastMode?: true;
};

function currentOneGoalOverride(overrides: OneTurnOverrides, epoch: number): OneTurnOverrides {
  if (overrides.goalControlEpoch === epoch) return overrides;
  const { goalMode: _goal, goalControlEpoch: _epoch, ...remaining } = overrides;
  return remaining;
}

type OneAttachmentDraft = {
  id: string;
  grant: FsPathGrant;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file" | "directory";
  previewUrl: string | null;
};

const UPDATE_BLOCKING_STATES = new Set<UpdaterState["status"]>([
  "available",
  "downloading",
  "downloaded",
  "installing",
  "manual-required",
  "incompatible",
]);
const BRIEFING_DISMISS_KEY = "agentlas.one.briefingDismissals.v1";
const BRIEFING_DISMISS_MS = 24 * 60 * 60 * 1_000;
const ONE_SEARCH_CONTRACT_VERSION = "1.0.0" as const;
const ONE_COMPOSER_DRAFT_STORAGE_PREFIX = "agentlas.one-composer-draft.v1:";

type OneComposerDraftCache = {
  composer: string;
  stagedSteer: string | null;
};

const oneComposerDraftCache = new Map<string, OneComposerDraftCache>();

function readOneComposerDraft(key: string): OneComposerDraftCache {
  const cached = oneComposerDraftCache.get(key);
  if (cached) return cached;
  let composer = "";
  try {
    if (typeof window !== "undefined") {
      const raw = window.sessionStorage.getItem(`${ONE_COMPOSER_DRAFT_STORAGE_PREFIX}${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { composer?: unknown };
        if (typeof parsed.composer === "string") composer = parsed.composer;
      }
    }
  } catch {
    // In-memory continuity still works when Web Storage is unavailable.
  }
  const restored = { composer, stagedSteer: null };
  oneComposerDraftCache.set(key, restored);
  return restored;
}

function writeOneComposerDraft(key: string, patch: Partial<OneComposerDraftCache>) {
  const next = { ...readOneComposerDraft(key), ...patch };
  oneComposerDraftCache.set(key, next);
  try {
    if (typeof window === "undefined") return;
    const storageKey = `${ONE_COMPOSER_DRAFT_STORAGE_PREFIX}${key}`;
    if (next.composer) window.sessionStorage.setItem(storageKey, JSON.stringify({ composer: next.composer }));
    else window.sessionStorage.removeItem(storageKey);
  } catch {
    // Draft persistence is best-effort and must never block typing.
  }
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function oneGraphRequest(value: string): string | null {
  const match = /^@graph(?:\s+|$)([\s\S]*)/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

function attachmentKind(file: File): "image" | "file" {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name) ? "image" : "file";
}

function isOneAttachmentPreparationFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return /oneAttachments:prepare|OneAttachmentError|attachment staging/i.test(message);
}

// macOS/Electron's custom extension filter can leave valid document rows
// disabled. Let the user choose any local file; Main derives the real type
// from the exact-file capability and rejects unsupported types before staging.
const ONE_ATTACHMENT_PICKER_ACCEPT = "*/*";

/**
 * 클립보드에서 붙여넣은 이미지에는 신뢰할 파일 이름이 없다(빈 문자열이거나 브라우저가
 * 붙인 "image.png"). 빈 이름을 그대로 칩과 오류 문구에 쓰면 사람이 무엇을 붙였는지
 * 알 수 없으므로, 이름이 없을 때만 읽을 수 있는 라벨로 대신한다.
 */
function attachmentDisplayName(file: File, locale: "ko" | "en"): string {
  const name = file.name.trim();
  if (name) return name;
  return tFor(locale, attachmentKind(file) === "image"
    ? "one.shell.attach.pasted_image"
    : "one.shell.attach.pasted_file");
}

function attachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function attachmentTypeLabel(mediaType: string, name: string): string {
  if (mediaType.trim()) return mediaType;
  const extension = name.match(/\.([A-Za-z0-9]{1,12})$/)?.[1];
  return extension ? extension.toUpperCase() : "file";
}

function toUiMessages(history: ChatHistoryEntry[]): UiMessage[] {
  const visible: UiMessage[] = [];
  let suppressRecoveryReply = false;
  let userTurnAwaitingAnswer = false;
  for (const entry of history) {
    if (entry.role === "system" && /^Private operational evidence\./.test(entry.text.trim())) {
      // This prompt and the reply it elicits are an internal recovery attempt,
      // not a user-authored turn or a trustworthy final result.
      /*
       * ★ 단, 사람의 질문이 아직 답을 못 받은 상태라면 다음 assistant 줄은 이 복구의 답이
       * 아니라 **그 질문의 답**이다. 복구 실행(OneRecoveryPlane)은 사용자가 쓰고 있는 바로
       * 그 방에서 동시에 돌 수 있어서, 저장 순서가 질문 → 복구프롬프트 → 진짜 답 으로
       * 섞인다. 그때 "복구 프롬프트 다음 assistant 줄"이라는 자리만 보고 지우면, 사람이
       * 기다리던 답을 화면에서 영구히 지운다(저장은 돼 있는데 다시 열어도 안 보인다).
       * 지우는 쪽이 틀렸을 때의 대가가 훨씬 크므로, 애매하면 남긴다.
       */
      suppressRecoveryReply = !userTurnAwaitingAnswer;
      continue;
    }
    if (entry.role === "assistant" && suppressRecoveryReply) {
      suppressRecoveryReply = false;
      continue;
    }
    if (entry.role === "user") {
      suppressRecoveryReply = false;
      userTurnAwaitingAnswer = true;
    }
    if (entry.role === "assistant") userTurnAwaitingAnswer = false;
    const parsedFiles = parseChatFileMessage(entry.text);
    visible.push({
      hostNotice: normalizeChatHostNotice(entry.role, entry.hostNotice),
      id: entry.id,
      durableMessageId: entry.durableMessageId ?? entry.id,
      ...(entry.goalResult ? { goalResult: entry.goalResult } : {}),
      role: entry.role === "assistant" ? "assistant" : entry.role,
      text: normalizeChatHostNotice(entry.role, entry.hostNotice) ? entry.text : parsedFiles.visibleText,
      images: entry.imageDataUrls?.length ? entry.imageDataUrls : undefined,
      chatFileGroupIds: parsedFiles.groupIds,
      createdAt: entry.createdAt,
    });
  }
  return visible;
}

/**
 * Durable history rows only carry attachment group ids. Rejoin any files that
 * are already in the renderer cache before deciding whether Main needs to be
 * queried. This matters at run settlement: the optimistic row is replaced by
 * its durable twin while the cache is still warm.
 */
function hydrateCachedChatFiles(messages: UiMessage[], groups: ReadonlyMap<string, ChatFileItem[]>): UiMessage[] {
  let changed = false;
  const hydrated = messages.map((message) => {
    const chatFiles = (message.chatFileGroupIds ?? []).flatMap((groupId) => groups.get(groupId) ?? []);
    if (chatFiles.length === 0) return message;
    const currentIds = message.chatFiles?.map((file) => file.id) ?? [];
    if (currentIds.length === chatFiles.length && currentIds.every((id, index) => id === chatFiles[index]?.id)) {
      return message;
    }
    changed = true;
    return { ...message, chatFiles };
  });
  return changed ? hydrated : messages;
}

function chatFileGroupsIncludingMessages(
  groups: ReadonlyMap<string, ChatFileItem[]>,
  messages: UiMessage[],
): Map<string, ChatFileItem[]> {
  const merged = new Map(groups);
  for (const message of messages) {
    for (const file of message.chatFiles ?? []) {
      const current = merged.get(file.groupId) ?? [];
      if (!current.some((item) => item.id === file.id)) merged.set(file.groupId, [...current, file]);
    }
  }
  return merged;
}

function isResultContinuationMessage(message: UiMessage): boolean {
  return message.role === "system" && /^(?:완료한|검토 중인) 이전 일에서 이어갑니다|^Continuing from the (?:completed|result-ready) work/.test(message.text);
}

function stripGenericResultReadyCopy(value: string): string {
  return value.replace(
    /\s*(?:Your result and files are ready\. You can review them below\.|요청한 결과와 파일을 준비했어요\. 아래에서 바로 확인할 수 있어요\.)\s*$/,
    "",
  ).trim();
}

/**
 * Prompts One sends on the user's behalf. They are real turns the model must
 * see, so they stay durable — but replaying the conversation must never show
 * our wording as something the person typed. The prompt text and its readable
 * label share one i18n source, so rewording a prompt can never orphan its label.
 */
const ONE_SYSTEM_PROMPTS = ["retry_unfinished", "runtime_recovered", "auto_recover"] as const;

function oneSystemPromptLabel(message: UiMessage): string | null {
  if (message.role !== "system") return null;
  const text = message.text.trim();
  for (const locale of ["ko", "en"] as const) {
    for (const name of ONE_SYSTEM_PROMPTS) {
      if (text === tFor(locale, `one.shell.system_prompt.${name}`).trim()) {
        return tFor(locale, `one.shell.system_prompt.label.${name}`);
      }
    }
  }
  return null;
}

function readableJsonLabel(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : value;
}

function readableJsonScalar(value: unknown): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function readableJsonValue(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (item === null || typeof item !== "object") return [`- ${readableJsonScalar(item)}`];
      const object = item as Record<string, unknown>;
      const title = ["title", "name", "place", "label", "claim"]
        .map((key) => object[key])
        .find((candidate) => typeof candidate === "string" && candidate.trim());
      return [
        `### ${typeof title === "string" ? title : `Item ${index + 1}`}`,
        ...readableJsonValue(object, depth + 1),
      ];
    });
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const label = readableJsonLabel(key);
      if (item === null || typeof item !== "object") return [`- **${label}:** ${readableJsonScalar(item)}`];
      const nested = readableJsonValue(item, depth + 1);
      return nested.length > 0 ? [`## ${label}`, ...nested] : [];
    });
  }
  return [readableJsonScalar(value)];
}

/**
 * A model can return a useful result as a raw JSON envelope when Surface
 * projection is unavailable. One keeps the information but translates the
 * machine envelope into ordinary headings and bullets.
 */
function readableOneJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object") return null;
    const lines = readableJsonValue(value);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/**
 * One owns its decision/question UI. Model-authored ask fences are an internal
 * transport protocol and must never be rendered beside the resulting card.
 * During streaming, hide an unfinished fence from its opening marker onward;
 * once closed, reuse the canonical parser so malformed JSON is still removed.
 */
function visibleOneMessageText(message: UiMessage): string {
  if (normalizeChatHostNotice(message.role, message.hostNotice)) return message.text;
  if (isResultContinuationMessage(message)) {
    return "";
  }
  if (message.role === "assistant" && /^(?:Your result and files are ready\. You can review them below\.|요청한 결과와 파일을 준비했어요\. 아래에서 바로 확인할 수 있어요\.)$/.test(message.text.trim())) {
    return "";
  }
  const systemPromptLabel = oneSystemPromptLabel(message);
  if (systemPromptLabel) return systemPromptLabel;
  // 좌석 사건 줄(자리 담당이 바뀌었다·누가 맡았다)은 내부 프롬프트가 아니라 **대화에
  // 남는 사실**이다. 표식이 붙은 줄만 열어 준다 — 표식 없는 system 줄은 아래에서 그대로
  // 비공개다(좌석 기획 §4-5; 표식 계약은 shared/one-seat-events.ts).
  if (message.role === "system") {
    const seatLine = seatEventLine(message.text);
    if (seatLine) return seatLine;
  }
  // Recovery/preflight prompts are durable model context, not conversation
  // authored by the person. Only the explicitly translated labels above may
  // appear in One; every other system turn stays private.
  if (message.role === "system") return "";
  if (message.role !== "assistant") return message.text;
  const extracted = extractQuestions(message.text, message.id).text;
  const unfinishedFence = extracted.indexOf("<<agentlas-ask>>");
  const withoutFence = unfinishedFence >= 0 ? extracted.slice(0, unfinishedFence) : extracted;
  // Host/router worker banners are useful in operator logs, not in a personal
  // chief-of-staff conversation. Strip every standalone banner line because a
  // resumed provider turn can insert one after an introductory sentence.
  const banded = stripAgentIdentityBadges(stripAgentControlBlocks(withoutFence, { streaming: message.streaming }))
    .replace(/^\s*(?:\*\*)?(?:사용\s*(?:에이전트|스킬)|Agents used|Skills used)(?:\*\*)?\s*:\s*[^\n]*(?:\n[ \t]*)*/gim, "")
    .trim();
  const completion = /\b\d+\s*\/\s*\d+\s+is\s+complete\b/i.exec(banded);
  const customerAnswer = stripGenericResultReadyCopy(completion && /^I(?:’|'| a)m using (?:the )?.*\bskill\b/i.test(banded)
    ? banded.slice(completion.index)
    : banded);
  const readableJson = readableOneJson(customerAnswer);
  if (readableJson) {
    return toCustomerSafeText(readableJson, detectOneTextLocale(readableJson) === "ko" ? "ko" : "en");
  }
  if (message.streaming && /^[{[]/.test(customerAnswer)) return "";
  // Final customer-safe pass: a leaked result-schema line ("structured result",
  // "safe One Surface", a CLI/session token) must never reach the reader even
  // when it arrives through a model or legacy synthesis path.
  return toCustomerSafeText(customerAnswer, detectOneTextLocale(customerAnswer) === "ko" ? "ko" : "en");
}

function upsertLiveMessage(messages: UiMessage[], text: string, streaming: boolean): UiMessage[] {
  const index = messages.findIndex((item) => item.id === "one-live-response");
  const message: UiMessage = { id: "one-live-response", role: "assistant", text, streaming };
  if (index < 0) return [...messages, message];
  return messages.map((item, itemIndex) => itemIndex === index ? message : item);
}

function statusLabel(
  status: OneTaskProjection["status"]["value"],
  locale: "ko" | "en",
  canonicalStatus?: OneTaskProjection["canonicalStatus"],
): string {
  if (canonicalStatus === "partial") return tFor(locale, "one.shell.status.partial");
  const labelKeys = {
    waiting: "one.shell.status.waiting",
    working: "one.shell.status.working",
    decision_required: "one.shell.status.decision_required",
    completed: "one.shell.status.completed",
    failed: "one.shell.status.failed",
    stopped: "one.shell.status.stopped",
  } as const;
  return tFor(locale, labelKeys[status]);
}

function briefingSignature(briefing: DisplayBriefing): string {
  return [
    briefing.kind,
    briefing.taskId ?? "none",
    briefing.proactive?.candidateId ?? "no-proactive-candidate",
    briefing.evidence.join("|"),
  ].join(":");
}

function oneMemoryUseOnceTargetKey(target: OneMemoryUseOnceTarget): string {
  return [target.chatId, target.expectedTaskId ?? "conversation", target.expectedTaskVersion ?? "none"].join(":");
}

/** 카드 제목에 들어가는 이름 — 원시 시스템 봉투·마크다운·매달린 구두점을 숨기고 짧게 자른다. */
function briefingSourceName(raw: string, locale: "ko" | "en"): string {
  const trimmed = raw.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const candidate = [record.title, record.name, record.label, record.task, record.request]
          .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        if (candidate) return briefingSourceName(candidate, locale);
      }
      return locale === "ko" ? "현재 작업" : "Current work";
    } catch {
      return locale === "ko" ? "현재 작업" : "Current work";
    }
  }
  const cleaned = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|{}[\]]/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .replace(/(?:\s*[:;,\-–—|/\\])+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return locale === "ko" ? "현재 작업" : "Current work";
  return cleaned.length > 44 ? `${cleaned.slice(0, 43).trimEnd()}…` : cleaned;
}

function safeBriefingSnapshot(value: OneBriefingSnapshot | null): OneBriefingSnapshot | null {
  if (!value || value.contractVersion !== ONE_BRIEFING_CONTRACT_VERSION) return null;
  if (!Number.isFinite(Date.parse(value.evaluatedAt))) return null;
  if (value.candidate && !isOneProactiveBriefing(value.candidate)) return null;
  return value;
}

function readBriefingDismissal(signature: string): number | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BRIEFING_DISMISS_KEY) ?? "{}") as Record<string, unknown>;
    const expiresAt = parsed[signature];
    return typeof expiresAt === "number" && expiresAt > Date.now() ? expiresAt : null;
  } catch {
    return null;
  }
}

function writeBriefingDismissal(signature: string): number {
  const expiresAt = Date.now() + BRIEFING_DISMISS_MS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(BRIEFING_DISMISS_KEY) ?? "{}") as Record<string, unknown>;
    const active = Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "number" && value > Date.now()));
    window.localStorage.setItem(BRIEFING_DISMISS_KEY, JSON.stringify({ ...active, [signature]: expiresAt }));
  } catch {
    // The in-memory dismissal below still prevents immediate reappearance.
  }
  return expiresAt;
}

/**
 * 마지막으로 열어 본 One 대화. 앱을 껐다 켜거나 다른 화면에 다녀와도 그 대화로 돌아온다.
 * "새 대화"를 누르면 지워져 홈에서 시작한다 — 사용자가 명시적으로 바꾼 것이기 때문이다.
 *
 * ★ 왜 필요한가 (오너 신고 2026-08-24): One 은 열 때마다 항상 홈(빈 대화)에서 시작했고,
 *   돌아갈 대화를 고르는 길도 없어서 "켤 때마다 기존 대화가 날아간다" 로 보였다.
 */
const LAST_ONE_CONVERSATION_KEY = "agentlas.one.lastConversationId";

type OneRailMode = "organisation" | "sessions" | "settings";

/** 세션 목록의 한 줄. 대화가 주인이고, 작업은 그 줄에 붙는 상태다. */
interface OneSessionRow {
  kind: "chat" | "task";
  key: string;
  chat: Chat | null;
  task: OneTaskProjection | null;
  sortAt: string;
}

/** 마지막으로 본 레일 탭. 조직도와 세션 목록 사이를 오갈 때 매번 되돌아가지 않게 한다. */
const LAST_ONE_RAIL_MODE_KEY = "agentlas.one.railMode";

function readLastRailMode(): OneRailMode {
  try {
    const value = window.localStorage.getItem(LAST_ONE_RAIL_MODE_KEY);
    return value === "sessions" ? "sessions" : "organisation";
  } catch {
    return "organisation";
  }
}

function rememberRailMode(mode: OneRailMode): void {
  // 설정은 잠시 들르는 곳이지 머무는 탭이 아니다 — 기억하지 않는다.
  if (mode === "settings") return;
  try { window.localStorage.setItem(LAST_ONE_RAIL_MODE_KEY, mode); } catch { /* 저장소를 못 써도 화면은 돈다 */ }
}

/*
 * 대화 줄에 붙는 이름 — **누구와 한 대화인지**다 (오너 결정 2026-08-24).
 * 상태 문구("결과 확인")가 아니라 이름을 쓴다: 단톡방이면 방 이름, 한 명이면 그 자리에
 * 앉은 에이전트의 **표시 이름**(고유 식별자가 아니라 사용자가 바꿀 수 있는 이름),
 * 그 밖에는 One.
 *
 * 자리가 비었거나 에이전트가 나갔어도 이름을 만든다 — 이름을 못 만든다고 세션을 못 열게
 * 하면 안 된다. 보관된 자리도 이름은 남는다.
 */
/** 한 칸이 사라질 만큼 끌지는 못하게 한다. */
function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(80, Math.max(20, Math.round(value)));
}

function seatLabelForChat(
  chat: Chat,
  taskforces: OneTaskforce[],
  org: OneOrgState | null,
  locale: "ko" | "en",
): string {
  const taskforce = taskforces.find((item) => item.chatId === chat.id);
  if (taskforce) return taskforce.title.trim() || (locale === "ko" ? "단톡방" : "Group");
  const member = org?.members.find((item) => item.installedAgentId === chat.agentId);
  if (member) {
    const name = (locale === "ko" ? member.displayName : member.nameEn || member.displayName).trim();
    if (name) return name;
  }
  // 좌석 표시 스냅샷(I2) — 방이 해체되거나 팀원이 삭제돼 위 파생이 전부 실패해도,
  // 세션이 쓰는 시점에 적어 둔 라벨만으로 스스로를 설명한다(좌석 테이블 조인 없음, I8).
  const snapshot = chat.seatLabel?.trim();
  if (snapshot) {
    return chat.seatKind === "group" && locale === "ko" ? `${snapshot} (해체됨)` : chat.seatKind === "group" ? `${snapshot} (dissolved)` : snapshot;
  }
  return "One";
}

function directSessionAgentId(chat: Chat): string | null {
  const agentId = chat.agentId?.trim() || null;
  if (
    chat.seatKind !== "solo"
    || chat.seatId === "seat_one"
    || agentId === "one"
    || agentId === "builtin-agentlas-one"
  ) return null;
  return agentId;
}

function isOneOwnedSession(chat: Chat, taskforces: OneTaskforce[]): boolean {
  if (chat.seatKind === "group" || taskforces.some((taskforce) => taskforce.chatId === chat.id)) return false;
  const agentId = chat.agentId?.trim() || "";
  return chat.seatId === "seat_one" || agentId === "one" || agentId === "builtin-agentlas-one";
}

function directSessionUnavailable(chat: Chat, org: OneOrgState | null): boolean {
  const agentId = directSessionAgentId(chat);
  if (!agentId || !org) return false;
  const member = org.members.find((item) => item.installedAgentId === agentId);
  return !member || Boolean(member.archivedAt);
}

function sessionListTime(iso: string, locale: "ko" | "en"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.floor((start - day) / 86_400_000);
  if (difference <= 0) return date.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
  });
}

function rememberLastOneConversation(chatId: string | null): void {
  try {
    if (chatId) window.localStorage.setItem(LAST_ONE_CONVERSATION_KEY, chatId);
    else window.localStorage.removeItem(LAST_ONE_CONVERSATION_KEY);
  } catch {
    /* 저장소를 못 쓰는 환경에서는 기억하지 않을 뿐, 화면은 그대로 돈다. */
  }
}

function readLastOneConversation(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_ONE_CONVERSATION_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function OneShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const selectedConversationId = searchParams.get("chat");
  const { locale, setPref } = useT();
  const configuredOneLocale: OneConversationLocale = locale === "ko" ? "ko" : "en";
  const appLocale = configuredOneLocale;
  const composerDraftKey = selectedTaskId
    ? `task:${selectedTaskId}`
    : selectedConversationId
      ? `chat:${selectedConversationId}`
      : "new";
  const initialComposerDraftRef = useRef<OneComposerDraftCache | null>(null);
  if (initialComposerDraftRef.current === null) initialComposerDraftRef.current = readOneComposerDraft(composerDraftKey);
  const composerDraftKeyRef = useRef(composerDraftKey);
  const [loaded, setLoaded] = useState(false);
  const [projections, setProjections] = useState<OneTaskProjection[]>([]);
  const [conversations, setConversations] = useState<Chat[]>([]);
  const [selected, setSelected] = useState<OneTaskProjection | null>(null);
  const [conversation, setConversation] = useState<Chat | null>(null);
  const [activeThreadChat, setActiveThreadChat] = useState<Chat | null>(null);
  const [activeChatIds, setActiveChatIds] = useState<string[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [keyRequestSheet, setKeyRequestSheet] = useState<McpRunKeyRequest | null>(null);
  const [dismissedDecisionId, setDismissedDecisionId] = useState<string | null>(null);
  const [committedAnswers, setCommittedAnswers] = useState<CommittedQuestionAnswer[]>([]);
  /**
   * "항상 승인"을 받은 대화들. 저장소는 승인 채널 셋이 공유한다 — 결정 시트에서 준
   * 허락이 런타임 도구 승인 카드에도 그대로 적용돼야 "항상"이 말 그대로가 된다.
   */
  const [alwaysApprovedChats, setAlwaysApprovedChats] = useState<readonly string[]>(alwaysApprovedChatIds);
  const manualAlwaysApprovalRef = useRef(new Set<string>());
  useEffect(() => subscribeAlwaysApproved(setAlwaysApprovedChats), []);
  const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null);
  const [mobileStatus, setMobileStatus] = useState<MobileBridgeRuntimeStatus | null>(null);
  const [oneProfile, setOneProfile] = useState<OneProfile | null>(null);
  const [oneOrgState, setOneOrgState] = useState<OneOrgState | null>(null);
  const [taskforces, setTaskforces] = useState<OneTaskforce[]>([]);
  const [taskforceDialogOpen, setTaskforceDialogOpen] = useState(false);
  const [taskforceEditingId, setTaskforceEditingId] = useState<string | null>(null);
  const [taskforceBusy, setTaskforceBusy] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createAgentSeed, setCreateAgentSeed] = useState<OneCreateAgentSeed | null>(null);
  const [editMemberTarget, setEditMemberTarget] = useState<OneEditMemberTarget | null>(null);
  /*
   * 통합 편집 창이 조직도에 열어 달라고 요청하는 부속 화면(도구 설정·담당 교체).
   * 창을 하나로 합치면서 이 두 화면의 진입점이 사라졌기 때문에, 요청을 여기로 올려 보낸다.
   */
  const [orgSheetRequest, setOrgSheetRequest] = useState<{ token: number; kind: "tools" | "replace"; memberId: string } | null>(null);
  /** One 자신을 고치는 창. 팀원 편집과 같은 창을 쓴다(오너 지시 2026-08-23). */
  const [editOneTarget, setEditOneTarget] = useState<OneEditSelfTarget | null>(null);
  const createAgentSeedTokenRef = useRef(0);
  const [agentPickerRequest, setAgentPickerRequest] = useState<{
    token: number;
    source: "my" | "cloud" | "hub";
  }>();
  const [failureFocus, setFailureFocus] = useState<FailureEventUi | null>(null);
  const [computerHistory, setComputerHistory] = useState<ComputerHistoryState | null>(null);
  const [historyClearConfirmOpen, setHistoryClearConfirmOpen] = useState(false);
  const [historyClearBusy, setHistoryClearBusy] = useState(false);
  const [oneMemory, setOneMemory] = useState<OneMemoryState | null>(null);
  const [oneMemoryMap, setOneMemoryMap] = useState<OneMemoryMapSnapshot | null>(null);
  const [homeMemoryMapOpen, setHomeMemoryMapOpen] = useState(false);
  const [armedOneMemoryUseOnce, setArmedOneMemoryUseOnce] = useState<ArmedOneMemoryUseOnce | null>(null);
  const [oneSuggestions, setOneSuggestions] = useState<OneSuggestionState | null>(null);
  const [oneValueClosures, setOneValueClosures] = useState<OneValueClosureState | null>(null);
  const [oneWeeklyReflection, setOneWeeklyReflection] = useState<OneWeeklyReflectionSnapshotV1 | null>(null);
  const [oneExperienceReuse, setOneExperienceReuse] = useState<OneExperienceReuseState | null>(null);
  const [oneImprovementProofs, setOneImprovementProofs] = useState<OneImprovementProofReadState | null>(null);
  const [oneIntroState, setOneIntroState] = useState<OneFeatureIntroState | null>(null);
  const [oneActivationState, setOneActivationState] = useState<OneActivationState | null>(null);
  const [briefingSnapshot, setBriefingSnapshot] = useState<OneBriefingSnapshot | null>(null);
  const [briefingActionBusy, setBriefingActionBusy] = useState(false);
  const [teamPreflight, setTeamPreflight] = useState<OneTeamPreflightProposal | null>(null);
  // PRD §4.14 — 제안 만료는 시각으로 결정되므로, 화면도 시간이 지나는 것을 알아야 한다.
  // 제안이 떠 있는 동안에만 도는 가벼운 틱이다(없으면 만료된 카드가 계속 눌린다).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [teamPreflightBusy, setTeamPreflightBusy] = useState(false);
  const [pendingTeamPrompt, setPendingTeamPrompt] = useState<PendingTeamPrompt | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const oneChatFileGroupsRef = useRef(new Map<string, ChatFileItem[]>());
  const [surface, setSurface] = useState<OneSurfaceManifestV1 | null>(null);
  // One and Work share the same main-owned generated-app preview. One keeps
  // only the verified descriptor here; the native WebContentsView belongs to
  // the Outputs rail so chat remains the primary conversation surface.
  const [oneLiveAppPreview, setOneLiveAppPreview] = useState<OneLiveAppPreview | null>(null);
  const [receipt, setReceipt] = useState<InvocationRunReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<OneActivityState>(() => initialOneActivityState());
  const [liveRunPrompt, setLiveRunPrompt] = useState<{ runId: string; text: string } | null>(null);
  // Main must classify/prepare a turn before it can issue a runtime run id.
  // This is a real, observable phase, but it is not "Run in progress" and it
  // has no execution events yet. Keeping it separate prevents the previous
  // answer's Activity from being falsely re-labelled as the new run.
  const [preflightPrompt, setPreflightPrompt] = useState<{ id: string; text: string; startedAt: number } | null>(null);
  // Projection refreshes are intentionally allowed while a run is active. Keep
  // the dispatch prompt in a separate state lane so an older receipt refresh
  // cannot briefly replace a just-submitted turn with the prior run's Activity.
  const [dispatchRunPrompt, setDispatchRunPrompt] = useState<{ runId: string; text: string } | null>(null);
  // State, unlike a ref, participates in rendering. It lets the view reject
  // a late receipt from run N while run N+1 is live even if that receipt lands
  // between React state batches.
  const [activityStateRunId, setActivityStateRunId] = useState<string | null>(null);
  /**
   * Every settled run of this conversation, projected from the ledger — one
   * "Worked for Ns" block per turn. The live run is *not* here; it lives in
   * `activity` until it settles and the ledger is re-read.
   */
  const [threadRuns, setThreadRuns] = useState<OneThreadRunBlock[]>([]);
  const threadRunsChatIdRef = useRef<string | null>(null);
  // React can paint the busy shell before its dispatch state batch is visible.
  // These refs make that first paint belong to the new run, rather than briefly
  // borrowing the prior answer's Activity and elapsed clock.
  const dispatchRunPromptRef = useRef<{ runId: string; text: string } | null>(null);
  const activeRunStartedAtRef = useRef<number | null>(null);
  const activityChatIdRef = useRef<string | null>(null);
  // Durable receipts may arrive after a newer turn has already begun. Keep the
  // run which owns the visible Activity separate from the event subscription:
  // a completed receipt is useful after its run ends, but must never overwrite
  // the next turn's fresh Activity or elapsed timer.
  const activityRunIdRef = useRef<string | null>(null);
  // Every runtime invocation starts its event sequence at one. Preserve the
  // event owner's run ID so a late durable receipt cannot make fresh events
  // look like duplicates of the previous run.
  const activityEventRunIdRef = useRef<string | null>(null);
  const [queuedSteers, setQueuedSteers] = useState<Array<{ id: string; text: string }>>([]);
  // Instructions typed while the run is still being prepared (no runId yet).
  // They join the queue strip at once and reach Main as steers the moment the
  // run exists — Codex queues a message typed during the model's first
  // processing the same way; dropping it (measured 2026-08-16) is not parity.
  const pendingSteersRef = useRef<Array<{ id: string; text: string }>>([]);
  // A running One turn accepts the next instruction directly; never revive an
  // obsolete two-step steering draft from an earlier app version.
  const [stagedSteer, setStagedSteerState] = useState<string | null>(null);
  const [autoRecovery, setAutoRecovery] = useState<
    | { phase: "recovering"; attempt: number; diagnosis: string }
    | { phase: "stopped"; reason: string; diagnosis: string }
    | null
  >(null);
  // Per-conversation recovery budget. `judgedRunIds` makes the decision
  // idempotent so re-renders can never spend an attempt twice.
  const autoRecoveryRef = useRef<{
    chatId: string | null;
    goal: string;
    originalRunId: string | null;
    recoveryRunId: string | null;
    attemptsSpent: number;
    previousFingerprint: string | null;
    judgedRunIds: Set<string>;
  }>({
    chatId: null,
    goal: "",
    originalRunId: null,
    recoveryRunId: null,
    attemptsSpent: 0,
    previousFingerprint: null,
    judgedRunIds: new Set(),
  });
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [composer, setComposerState] = useState(initialComposerDraftRef.current.composer);
  function setComposer(next: string | ((current: string) => string)) {
    if (typeof next === "string") {
      writeOneComposerDraft(composerDraftKeyRef.current, { composer: next });
      setComposerState(next);
      return;
    }
    setComposerState((current) => {
      const resolved = next(current);
      writeOneComposerDraft(composerDraftKeyRef.current, { composer: resolved });
      return resolved;
    });
  }
  function setStagedSteer(next: string | null) {
    writeOneComposerDraft(composerDraftKeyRef.current, { stagedSteer: next });
    setStagedSteerState(next);
  }
  const [availableAgents, setAvailableAgents] = useState<InstalledAgent[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>(() => readViewData<MarketplaceListing[]>("dashboard.cloud-listings")?.value ?? []);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>(() => readViewData<HubAgentBookmark[]>("dashboard.hub-bookmarks")?.value ?? []);
  /* 미로그인과 "빈 계정"은 다른 상태다(D-10). Cloud/Hub 빈 목록을 로그인
     안내로 구분하기 위한 세션 신호 — 조회 실패는 사실로 승격하지 않고
     "모름(null)"으로 남겨 기존 빈 상태 문구를 유지한다. */
  const [accountSignedIn, setAccountSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!api?.auth) return;
    let cancelled = false;
    void api.auth.getSession()
      .then((session) => { if (!cancelled) setAccountSignedIn(session?.signedIn === true); })
      .catch(() => undefined);
    const unsubscribe = api.auth.onSessionChanged?.((session) => {
      if (!cancelled) setAccountSignedIn(session?.signedIn === true);
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, []);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [pluginStatuses, setPluginStatuses] = useState<McpServerStatus[]>([]);
  const [composerMenu, setComposerMenu] = useState<OneComposerMenuKey | null>(null);
  const agentPickerOpen = composerMenu === "agents";
  function setAgentPickerOpen(next: boolean | ((open: boolean) => boolean)) {
    setComposerMenu((current) => {
      const open = current === "agents";
      const shouldOpen = typeof next === "function" ? next(open) : next;
      return shouldOpen ? "agents" : open ? null : current;
    });
  }
  const [turnAgentIds, setTurnAgentIds] = useState<string[]>([]);
  const [turnOverrides, setTurnOverrides] = useState<OneTurnOverrides>({});
  const goalControlEpochRef = useRef(0);
  const [oneRuntime, setOneRuntime] = useState<RuntimeStatus | null>(null);
  const [oneRuntimePinned, setOneRuntimePinned] = useState(false);
  const [oneModelOptions, setOneModelOptions] = useState<OneComposerModelOption[]>([]);
  const [oneRuntimeInventory, setOneRuntimeInventory] = useState<RuntimeStatus[]>([]);
  // One is the owner's personal agent. Full access is the explicit product
  // default; the chip remains the per-turn authority control for narrowing it.
  const [onePermission, setOnePermissionState] = useState<OnePermissionMode>(readStoredOnePermission);
  const setOnePermission = useCallback((permission: OnePermissionMode) => {
    window.localStorage.setItem(ONE_PERMISSION_STORAGE_KEY, permission);
    setOnePermissionState(permission);
  }, []);
  const [workspaceGrant, setWorkspaceGrant] = useState<FsPathGrant | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<OneAttachmentDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<OneSearchHitV1[]>([]);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchIncludeArchived, setSearchIncludeArchived] = useState(true);
  const [archiveMutationTaskId, setArchiveMutationTaskId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsedState] = useState(() => readStoredBoolean(ONE_LEFT_RAIL_COLLAPSED_STORAGE_KEY, false));
  const [railMode, setRailModeState] = useState<OneRailMode>(() => readLastRailMode());
  const setRailMode = useCallback((mode: OneRailMode) => {
    rememberRailMode(mode);
    setRailModeState(mode);
  }, []);
  const [settingsSheet, setSettingsSheet] = useState<OneSettingsKey | null>(null);
  const [pluginPickerOpen, setPluginPickerOpen] = useState(false);
  const [contextRailOpen, setContextRailOpenState] = useState(() => readStoredBoolean(ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY, false));
  /*
   * 홈 화면 기록 열도 접힌 채로 시작한다 (오너 결정 2026-08-25: "다 접힌 상태").
   * 첫 화면에서 오른쪽을 차지하던 패널은 둘이었다 — 결과 패널(위 v2)과 이 기록 열.
   * 접되 **출구를 남긴다**: 접힘 폭은 0이 아니라 펴기 버튼 하나가 들어가는 띠이고,
   * 사용자가 편 상태는 기존 계약대로 기억한다.
   */
  const [homeHistoryOpen, setHomeHistoryOpenState] = useState(() => readStoredBoolean(ONE_HOME_HISTORY_OPEN_STORAGE_KEY, false));
  const setHomeHistoryOpen = useCallback((next: boolean) => {
    setHomeHistoryOpenState(next);
    try { window.localStorage.setItem(ONE_HOME_HISTORY_OPEN_STORAGE_KEY, String(next)); } catch { /* persistence is best effort */ }
  }, []);
  const [contextRailWidth, setContextRailWidthState] = useState<number>(readStoredContextRailWidth);
  const contextRailPreferredWidthRef = useRef(contextRailWidth);
  const setContextRailWidth = useCallback((next: number | ((current: number) => number)) => {
    setContextRailWidthState((current) => {
      const clamped = clampContextRailWidth(typeof next === "function" ? next(current) : next);
      contextRailPreferredWidthRef.current = clamped;
      try {
        window.localStorage.setItem(ONE_CONTEXT_RAIL_WIDTH_STORAGE_KEY, String(clamped));
      } catch {
        // The rail stays resizable even when persistence is unavailable.
      }
      return clamped;
    });
  }, []);
  const requestReadableContextRailWidth = useCallback((requested = readableContextFileWidth()) => {
    setContextRailWidthState((current) => Math.max(current, clampContextRailWidth(requested)));
  }, []);
  const restorePreferredContextRailWidth = useCallback(() => {
    setContextRailWidthState(clampContextRailWidth(contextRailPreferredWidthRef.current));
  }, []);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  // 에이전트 세션 시트는 OneBottomSheet 를 쓰지 않는 자체 다이얼로그라 Escape
  // 계약(설정·검색 시트와 동일)이 빠져 있었다(D-8). 닫기는 포커스 위치와
  // 무관하게 무조건 들어야 한다.
  useEffect(() => {
    if (!sessionSheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSessionSheetOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionSheetOpen]);
  /**
   * 세션 시트의 실행 모델 표기 (표시=실행, C-D-1): 각 세션의 마지막 실행
   * receipt에 원장이 남긴 실제 실행 모델을 시트가 열릴 때 한 번 읽어 단다.
   * 설정의 "현재 기본값"은 과거 실행의 증빙이 아니므로 쓰지 않는다.
   */
  const [sessionModels, setSessionModels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!sessionSheetOpen) return;
    const api = ipc();
    if (!api?.invoke?.latestReceipt) return;
    let cancelled = false;
    void (async () => {
      const ids = conversations.map((chat) => chat.id).slice(0, 60);
      const entries = await Promise.all(ids.map(async (id) => {
        const receipt = await api.invoke.latestReceipt(id).catch(() => null);
        return [id, receipt?.model ?? ""] as const;
      }));
      if (cancelled) return;
      setSessionModels(Object.fromEntries(entries.filter(([, model]) => model)));
    })();
    return () => { cancelled = true; };
    // conversations 목록 자체는 시트가 열린 동안 안정적이다 — 열림 시점 1회 조회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSheetOpen]);
  /** 이 대화에서 켠 생성 앱 미리보기 서버들. 대화를 떠날 때 끈다. */
  const livePreviewAppIdsRef = useRef<Set<string>>(new Set());
  /**
   * 분할 보기 — 지금 보고 있는 대화 옆에 붙는 칸들. 화면 전체로는 최대 4칸이므로
   * 옆칸은 3개까지다. 입력창은 언제나 왼쪽 첫 칸(지금 대화)에만 있다.
   */
  const [splitChatIds, setSplitChatIds] = useState<string[]>([]);
  const [splitRatio, setSplitRatio] = useState({ col: 50, row: 50 });
  const splitStageRef = useRef<HTMLDivElement | null>(null);
  const beginSplitResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const stage = splitStageRef.current;
    if (!stage) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    // 끄는 동안에는 모션을 끈다 — 이 표식이 One 의 모션 토큰을 0ms 로 눌러 분할선이
    // 손가락을 그대로 따라온다. 놓으면 지워지므로 키보드 이동(화살표)은 다시 흐른다.
    document.documentElement.setAttribute("data-one-resizing", "true");
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const box = stage.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      setSplitRatio({
        col: clampSplitRatio(((moveEvent.clientX - box.left) / box.width) * 100),
        row: clampSplitRatio(((moveEvent.clientY - box.top) / box.height) * 100),
      });
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      document.documentElement.removeAttribute("data-one-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    // 창 단위로 따라가야 손잡이(22px) 밖으로 포인터가 나가도 드래그가 산다.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);
  const setRailCollapsed = useCallback((collapsed: boolean) => {
    window.localStorage.setItem(ONE_LEFT_RAIL_COLLAPSED_STORAGE_KEY, String(collapsed));
    setRailCollapsedState(collapsed);
  }, []);
  const setContextRailOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setContextRailOpenState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      try {
        window.localStorage.setItem(ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY, String(value));
      } catch {
        // The output rail remains operable even when persistence is unavailable.
      }
      return value;
    });
  }, []);
  useEffect(() => {
    if (!contextRailOpen) restorePreferredContextRailWidth();
  }, [contextRailOpen, restorePreferredContextRailWidth]);
  useEffect(() => {
    if (!taskMenuOpen) return;
    const closeFromPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-one-task-menu]")) return;
      setTaskMenuOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTaskMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [taskMenuOpen]);
  const [dismissedBriefing, setDismissedBriefing] = useState<{ signature: string; expiresAt: number } | null>(null);
  const [introReplayToken, setIntroReplayToken] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  // The visible app language is the one language control a person can see and
  // change in this surface. A stale profile preference must not make an
  // English One screen submit Korean runtime/surface copy (or the reverse).
  // The profile preference remains device-sync metadata; it is not a hidden
  // per-turn override of the active One UI language.
  const normalizedLocale = appLocale;
  useEffect(() => {
    const api = ipc();
    if (!api) {
      setInventoryLoading(false);
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.team.list().catch(() => []),
      api.mcpTools.listInstalled().catch(() => []),
      api.mcpTools.listCatalog().catch(() => []),
      api.mcpTools.status().catch(() => []),
      loadViewData("dashboard.cloud-listings", () => api.marketplace.listMine(), { maxAgeMs: 60_000 }).catch(() => readViewData<MarketplaceListing[]>("dashboard.cloud-listings")?.value ?? []),
      loadViewData("dashboard.hub-bookmarks", () => api.marketplace.bookmarks(), { maxAgeMs: 15_000 }).catch(() => readViewData<HubAgentBookmark[]>("dashboard.hub-bookmarks")?.value ?? []),
    ]).then(([agents, plugins, catalog, statuses, cloud, bookmarks]) => {
      if (cancelled) return;
      setAvailableAgents(visibleAgents(agents, { includeTeams: true }));
      setInstalledPlugins(plugins);
      setPluginCatalog(catalog);
      setPluginStatuses(statuses);
      setCloudListings(cloud);
      setHubBookmarks(bookmarks);
    }).finally(() => {
      if (!cancelled) setInventoryLoading(false);
    });
    const reconcileBookmarks = () => {
      void loadViewData("dashboard.hub-bookmarks", () => api.marketplace.bookmarks(), { maxAgeMs: 0, force: true })
        .then((bookmarks) => { if (!cancelled) setHubBookmarks(bookmarks); })
        .catch(() => undefined);
    };
    const unsubscribeLocal = onHubBookmarkChange(reconcileBookmarks);
    const unsubscribeMain = api.marketplace.onBookmarksSnapshot((event) => {
      writeViewData("dashboard.hub-bookmarks", event.bookmarks);
      if (!cancelled) setHubBookmarks(event.bookmarks);
    });
    return () => { cancelled = true; unsubscribeLocal(); unsubscribeMain(); };
  }, []);
  const onePluginOptions = useMemo<OneComposerPluginOption[]>(() => {
    const catalogById = new Map(pluginCatalog.map((item) => [item.id, item]));
    return installedPlugins
      .map((plugin) => {
        const catalog = plugin.catalogId ? catalogById.get(plugin.catalogId) : undefined;
        const name = appLocale === "ko"
          ? plugin.name || plugin.nameEn
          : plugin.nameEn || plugin.name;
        const fallbackDescription = plugin.transport === "stdio"
          ? (appLocale === "ko" ? "로컬 MCP 도구" : "Local MCP tools")
          : (appLocale === "ko" ? "연결된 MCP 도구" : "Connected MCP tools");
        return {
          id: plugin.id,
          name,
          description: (appLocale === "ko" ? catalog?.description : catalog?.descriptionEn) || fallbackDescription,
          enabled: plugin.enabled,
          ready: plugin.configurationValid !== false,
          // 로고 조회 재료 — 저장된 이름(`<slug>:<서버>` 형태일 수 있음)이 필요하다.
          // `name`은 이미 지역화·정제된 표시용이라 slug 추출에 쓸 수 없다.
          catalogId: plugin.catalogId,
          serverName: plugin.name,
          brandColor: catalog?.brandColor,
          mark: catalog?.mark,
        };
      })
      .sort((left, right) => Number(right.enabled && right.ready) - Number(left.enabled && left.ready) || left.name.localeCompare(right.name));
  }, [appLocale, installedPlugins, pluginCatalog]);
  const activeRunPrompt = busy
    ? (dispatchRunPrompt ?? liveRunPrompt ?? dispatchRunPromptRef.current)
    : liveRunPrompt;
  const workBusy = busy || teamPreflightBusy;
  // A renderer reload can reattach to an already-running invocation before a
  // fresh prompt exists in this component. In that path `activeRunPrompt` is
  // intentionally null, but the first typed event has already established the
  // run id in `activityStateRunId`. Treat that attached run as the owner of the
  // visible Activity instead of blanking it back to an optimistic empty state.
  const activeActivityRunId = activeRunPrompt?.runId ?? activityStateRunId;
  const activeRunOwnsActivity = Boolean(
    busy
    && activeActivityRunId
    && activityStateRunId === activeActivityRunId,
  );
  const renderedActivity = busy && !activeRunOwnsActivity
    ? initialOneActivityState()
    : activity;
  const renderedActivityStartedAt = busy && !activeRunOwnsActivity
    ? activeRunStartedAtRef.current
    : runStartedAt;
  const [workerSelection, setWorkerSelection] = useState<OneWorkerPanelSelection | null>(null);
  const workerChatId = selected?.chatId ?? conversation?.id ?? null;
  const inspectWorkerPanel = useCallback((runId: string, group: OneWorkerWorkGroup) => {
    if (!workerChatId || !runId || !group.agentId) return;
    setWorkerSelection({ chatId: workerChatId, runId, agentId: group.agentId, name: group.name });
    setContextRailOpen(true);
  }, [workerChatId, setContextRailOpen]);
  const workerRun = useMemo<OneWorkerPanelRun | null>(() => {
    if (!contextRailOpen || !workerSelection || !workerChatId || workerSelection.chatId !== workerChatId) return null;
    if (activityChatIdRef.current === workerChatId && activityStateRunId === workerSelection.runId) return { chatId: workerChatId, runId: workerSelection.runId, state: activity };
    const exact = threadRunsChatIdRef.current === workerChatId
      ? threadRuns.find((run) => run.runId === workerSelection.runId) : undefined;
    return exact ? { chatId: workerChatId, runId: exact.runId, state: exact.state } : null;
  }, [activity, activityStateRunId, contextRailOpen, threadRuns, workerChatId, workerSelection]);
  useEffect(() => { setWorkerSelection(null); }, [workerChatId]);
  const visibleMessages = messages;
  const liveResponseMounted = messages.some((message) => message.id === "one-live-response");
  const livePromptMounted = Boolean(activeRunPrompt && messages.some((message) => (
    message.role === "user" && message.text === activeRunPrompt.text
  )));
  // The live run's work block: before the streaming reply once text arrives,
  // otherwise at the tail of the thread (after the prompt that started it).
  const liveWorkAnchorMessageId = workBusy && liveResponseMounted ? "one-live-response" : null;
  const liveWorkBlock = workBusy
    ? (
      <OneTurnWork
        key={`work:live:${activeActivityRunId ?? "pending"}`}
        onInspectWorker={activeActivityRunId ? (group) => inspectWorkerPanel(activeActivityRunId, group) : undefined}
        state={renderedActivity}
        artifactScope={(selected?.chatId ?? conversation?.id) && activeActivityRunId ? { chatId: (selected?.chatId ?? conversation?.id)!, runId: activeActivityRunId } : undefined}
        busy
        startedAt={renderedActivityStartedAt}
        locale={appLocale}
        workspacePath={workspacePath}
      />
    )
    : null;
  // Settled blocks for every past run of this conversation. Between a run's
  // terminal event and the ledger re-read, the just-settled run is still only
  // in live `activity`; it is drawn from there so the block never blinks out.
  const threadWorkPlan = useMemo(() => {
    const runs: OneThreadRunBlock[] = [...threadRuns];
    const settledLiveRunId = !workBusy ? (activityStateRunId ?? activityEventRunIdRef.current) : null;
    if (
      settledLiveRunId
      && activity.items.length > 0
      && !runs.some((run) => run.runId === settledLiveRunId)
    ) {
      runs.push({
        runId: settledLiveRunId,
        startedAt: runStartedAt != null ? new Date(runStartedAt).toISOString() : (activity.items[0]?.observedAt ?? new Date().toISOString()),
        status: activity.terminalStatus ?? "completed",
        state: activity,
      });
    }
    return planOneThreadWork({
      messages: visibleMessages.map((message) => ({ id: message.id, role: message.role, createdAt: message.createdAt })),
      runs,
      excludeRunId: workBusy ? activeActivityRunId : null,
    });
  }, [activeActivityRunId, activity, activityStateRunId, visibleMessages, runStartedAt, threadRuns, workBusy]);
  const durableThreadBrowserUrl = useMemo(() => {
    for (let index = threadRuns.length - 1; index >= 0; index -= 1) {
      const url = taskBrowserUrl(threadRuns[index].state.items);
      if (url) return url;
    }
    return undefined;
  }, [threadRuns]);
  /*
   * 브라우저를 쓴 적 있는 대화라는 이유로 오른쪽 패널을 저 혼자 열던 자리
   * (제거, 오너 지시 2026-08-24 "우측사이드바 디폴트로 접히고"). 열림 상태가
   * 저장까지 돼서, 한 번 열린 뒤로는 무엇을 지워도 다시 열린 채로 시작했다.
   */
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchSheetRef = useRef<HTMLElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const railRevealButtonRef = useRef<HTMLButtonElement>(null);
  const composerComposingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultTopRef = useRef<HTMLDivElement>(null);
  const attachmentDragDepthRef = useRef(0);
  const attachmentDraftsRef = useRef<OneAttachmentDraft[]>([]);
  // A submitted image keeps using its local blob URL until Main returns the
  // durable attachment URL. Revoking it with the composer draft made the image
  // disappear between optimistic send and history reload.
  const submittedAttachmentPreviewUrlsRef = useRef(new Set<string>());
  const attachmentThreadRef = useRef<string | null>(null);
  const autoResolvingProposalRef = useRef<string | null>(null);
  const automationRunPendingRef = useRef(new Set<string>());
  const pluginMutationPendingRef = useRef(new Set<string>());
  const runIdRef = useRef<string | null>(null);
  const runTaskIdRef = useRef<string | null>(null);
  const runChatIdRef = useRef<string | null>(null);
  // Only the stop notice for this exact run may be cleared by terminal
  // reconciliation; unrelated action notices must survive.
  const cancelNoticeRunIdRef = useRef<string | null>(null);
  const cancelNoticeTextRef = useRef<string | null>(null);
  /** One handoff has no separate cancel authority; interrupt uses the same
   * Main-owned invocation cancel path as the composer Stop action. */
  const cancelActiveRun = useCallback((reason: string) => {
    const api = ipc();
    const runId = runIdRef.current;
    if (!runId) return;
    if (!api) {
      requestOneOperationalRecovery(reason, new Error("Desktop bridge unavailable"));
      setActionNotice(appLocale === "ko"
        ? "Desktop에 연결되지 않아 작업을 멈추지 못했습니다. 실행은 계속되고 있습니다."
        : "The work could not be stopped because Desktop is unavailable. The run is still active.");
      return;
    }
    const stopNotice = appLocale === "ko" ? "중단 요청을 전달했습니다. 종료 결과를 기다리는 중입니다…" : "Stop requested. Waiting for the terminal result…";
    // Claim the notice before crossing IPC. Main may publish a terminal event
    // synchronously while cancel() is still waiting for its acknowledgement.
    cancelNoticeRunIdRef.current = runId;
    cancelNoticeTextRef.current = stopNotice;
    setActionNotice(stopNotice);
    void api.invoke.cancel(runId).then((receipt) => {
      if (
        receipt?.runId !== runId
        || (receipt.status !== "requested" && receipt.status !== "already-requested")
      ) {
        throw new Error("invoke_cancel_receipt_mismatch");
      }
      // Main accepted the terminal action. The run remains visibly busy until
      // its terminal event arrives, but directions Main just discarded must
      // disappear from the local queue now.
      if (runIdRef.current !== runId || cancelNoticeRunIdRef.current !== runId) return;
      pendingSteersRef.current = [];
      setQueuedSteers([]);
    }).catch(() => {
      // Rejection means nothing was cancelled; preserve the active run and its
      // queued directions instead of leaving a false stopped/pending screen.
      if (cancelNoticeRunIdRef.current !== runId) return;
      const notice = cancelNoticeTextRef.current;
      cancelNoticeRunIdRef.current = null;
      cancelNoticeTextRef.current = null;
      const rejection = appLocale === "ko"
        ? "작업 중단 요청이 거절되었습니다. 실행과 대기 중 지시는 그대로입니다. 다시 시도해 주세요."
        : "The stop request was rejected. The run and queued directions are unchanged; try again.";
      setActionNotice((current) => current === notice ? rejection : current);
    });
  }, [appLocale]);
  /*
   * ★화면에 지금 떠 있는 메시지가 **어느 대화의 것인가**.
   *
   * 스레드 로딩은 "이 대화에 실행이 붙어 있는가"(attachment)로 히스토리 로드를 건너뛰고
   * 있었다. 그런데 그 질문은 화면 내용과 무관하다. 진행 중인 B 를 보다가 A 로 갔다
   * 돌아오면 B 에는 여전히 실행이 붙어 있으므로 로드를 건너뛰고, 화면에는 조금 전
   * A 의 메시지가 그대로 남는다 — 사용자에게는 두 세션이 하나로 합쳐진 것처럼 보인다.
   * 건너뛰어도 되는 경우는 오직 "화면이 이미 이 대화를 그리고 있을 때"뿐이다.
   */
  const shownThreadChatIdRef = useRef<string | null>(null);
  /**
   * 화면에 보이는 대화가 몇 번 바뀌었는가 — 늦게 온 옛 읽기가 새 것을 덮지 못하게 하는 번호표.
   *
   * Work 는 이 규칙을 갖고 있고 One 은 없었다. 그래서 같은 대화에 대한 기록 읽기 두 개가
   * 순서가 뒤바뀌어 도착하면 **오래된 쪽이 이겨** 방금 친 말풍선이 사라졌다가 다시 나타났다.
   * 화면을 바꾸는 모든 자리에서 이 번호를 올리고, 비동기 읽기는 시작할 때 번호를 적어 두었다가
   * 값을 넣기 직전에 같은 번호인지 확인한다.
   */
  const oneTranscriptRevisionRef = useRef(0);
  const streamTextRef = useRef("");
  const unsubscribeRunRef = useRef<(() => void) | null>(null);
  const selectedTaskIdRef = useRef(selectedTaskId);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const onePaneCommitWaiterRef = useRef(createOnePaneCommitWaiter());
  const navigationEpochRef = useRef(0);
  const homeTransitionPendingRef = useRef(false);
  // A first send is rendered optimistically before Main has returned the new
  // chat row. The still-mounted home-thread effect must not interpret that
  // short interval as a real navigation back to an empty home and erase the
  // person's text/photo. Ownership transfers when the new chat becomes the
  // active thread below.
  const freshChatSubmissionPendingRef = useRef(false);
  const pendingNewChatDraftCarryRef = useRef<{ chatId: string; navigationEpoch: number } | null>(null);
  const introDeferralInFlightRef = useRef<string | null>(null);
  const searchRequestRef = useRef(0);
  attachmentDraftsRef.current = attachmentDrafts;

  // Keep route identity in refs only after the URL has actually committed.
  // Assigning these during render reintroduced the previous chat between the
  // "New conversation" click and Next's search-param update, so a fast submit
  // could append the turn to the old conversation even though the home screen
  // was already visible.
  useEffect(() => {
    if (homeTransitionPendingRef.current) {
      // Ignore a late search-param commit from the thread we just left. Once
      // the empty /one route lands, normal route synchronization resumes.
      if (selectedTaskId || selectedConversationId) return;
      homeTransitionPendingRef.current = false;
    }
    selectedTaskIdRef.current = selectedTaskId;
    selectedConversationIdRef.current = selectedConversationId;
    // 어떤 길로 들어왔든(목록 클릭·주소 복원·앱 재시작) 지금 보고 있는 대화를 기억한다.
    // 목록 클릭에만 걸어 두면 주소로 들어온 경우를 놓쳐 다음 실행에서 홈으로 떨어진다.
    if (selectedConversationId) rememberLastOneConversation(selectedConversationId);
  }, [selectedConversationId, selectedTaskId]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    const minimumHeight = 24;
    const maximumHeight = 210;
    input.style.height = "auto";
    const nextHeight = Math.max(minimumHeight, Math.min(input.scrollHeight, maximumHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maximumHeight ? "auto" : "hidden";
  }, [composer]);

  useEffect(() => () => {
    for (const item of attachmentDraftsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    for (const previewUrl of submittedAttachmentPreviewUrlsRef.current) {
      URL.revokeObjectURL(previewUrl);
    }
    submittedAttachmentPreviewUrlsRef.current.clear();
  }, []);

  const clearAttachmentDrafts = useCallback((options?: { preserveSubmittedPreviews?: boolean }) => {
    const current = attachmentDraftsRef.current;
    attachmentDraftsRef.current = [];
    for (const item of current) {
      if (!item.previewUrl) continue;
      if (options?.preserveSubmittedPreviews) {
        submittedAttachmentPreviewUrlsRef.current.add(item.previewUrl);
      } else {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
    setAttachmentDrafts([]);
    setAttachmentError(null);
    setAttachmentDragActive(false);
    attachmentDragDepthRef.current = 0;
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  }, []);

  useEffect(() => {
    const visibleImageUrls = new Set(messages.flatMap((message) => message.images ?? []));
    for (const previewUrl of submittedAttachmentPreviewUrlsRef.current) {
      if (visibleImageUrls.has(previewUrl)) continue;
      URL.revokeObjectURL(previewUrl);
      submittedAttachmentPreviewUrlsRef.current.delete(previewUrl);
    }
  }, [messages]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    });
  }, []);

  /**
   * 대화를 처음 그릴 때 맨 아래에 **붙여 둔다**.
   *
   * ★한 번만 내리면 안 된다 (실측 2026-09-08): 60개짜리 대화를 열면 1180px 창에서는
   *   내려갔는데 1440px 창에서는 그대로 맨 위였다. 첫 프레임 뒤에도 폰트·이미지·코드
   *   블록이 자리를 잡으며 전체 높이가 계속 늘기 때문이다. 몇 번 더 따라 내려간다.
   *   ★사람이 손을 대면 즉시 멈춘다 — 읽던 자리를 뺏는 건 안 내려가는 것보다 나쁘다.
   */
  const pinToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let stopped = false;
    const stop = () => { stopped = true; cleanup(); };
    const cleanup = () => {
      for (const id of timers) window.clearTimeout(id);
      scroller.removeEventListener("wheel", stop);
      scroller.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
    const go = () => {
      if (stopped) return;
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
    };
    const timers = [0, 80, 250, 600].map((delay) => window.setTimeout(go, delay));
    scroller.addEventListener("wheel", stop, { passive: true });
    scroller.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    window.setTimeout(cleanup, 900);
  }, []);

  /**
   * 흘러나오는 답을 따라 내려간다 — **맨 아래를 보고 있을 때만.**
   *
   * 사람이 위로 올려 읽는 중이면 아무것도 하지 않는다. 읽던 자리를 뺏으면
   * 안 따라가는 것보다 나쁘다.
   */
  const followStreamToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceFromBottom > 160) return;
    window.requestAnimationFrame(() => {
      const live = scrollRef.current;
      if (!live) return;
      live.scrollTo({ top: live.scrollHeight, behavior: "auto" });
    });
  }, []);

  const scrollResultToTop = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const result = resultTopRef.current;
      if (!scroller || !result) return;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const resultTop = result.getBoundingClientRect().top;
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + resultTop - scrollerTop - 24),
        behavior,
      });
    });
  }, []);

  useEffect(() => {
    if (busy || (!surface && !receipt)) return;
    // Put the useful result at the top as the terminal records settle, then
    // stop. Late retries used to fight a person's first scroll toward the
    // actions at the bottom of a result.
    const timers = [0, 120].map((delay) => window.setTimeout(() => scrollResultToTop("auto"), delay));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [busy, receipt?.runId, scrollResultToTop, surface?.manifestId]);

  const closeSearch = useCallback(() => setSearchOpen(false), []);
  useDismissibleLayer({
    open: searchOpen,
    roots: [searchSheetRef],
    onDismiss: closeSearch,
    restoreFocusRef: searchTriggerRef,
  });

  const trapSearchFocus = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const root = searchSheetRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]",
    )].filter((item) => item.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === root) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const requestOneSearch = useCallback(async (input: {
    query: string;
    includeArchived: boolean;
    cursor?: string | null;
    append?: boolean;
  }) => {
    const api = ipc();
    const value = input.query.replace(/\s+/g, " ").trim();
    if (!value) return;
    if (!api?.oneSearch) {
      requestOneOperationalRecovery("one-search", new Error("Desktop bridge unavailable"));
      return;
    }
    const requestId = ++searchRequestRef.current;
    if (input.append) setSearchLoadingMore(true);
    else setSearchLoading(true);
    setSearchFailed(false);
    try {
      const page = await api.oneSearch.search({
        contractVersion: ONE_SEARCH_CONTRACT_VERSION,
        query: value,
        limit: 20,
        cursor: input.cursor ?? null,
        includeArchived: input.includeArchived,
      });
      if (requestId !== searchRequestRef.current) return;
      setSearchHits((current) => input.append ? [...current, ...page.hits] : page.hits);
      setSearchNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId !== searchRequestRef.current) return;
      if (!input.append) {
        setSearchHits([]);
        setSearchNextCursor(null);
      }
      requestOneOperationalRecovery("one-search", cause);
      setSearchFailed(true);
    } finally {
      if (requestId === searchRequestRef.current) {
        setSearchLoading(false);
        setSearchLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!searchOpen) {
      searchRequestRef.current += 1;
      setSearchLoading(false);
      setSearchLoadingMore(false);
      return;
    }
    const value = query.replace(/\s+/g, " ").trim();
    if (!value) {
      searchRequestRef.current += 1;
      setSearchHits([]);
      setSearchNextCursor(null);
      setSearchFailed(false);
      setSearchLoading(false);
      setSearchLoadingMore(false);
      return;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void requestOneSearch({ query: value, includeArchived: searchIncludeArchived });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, requestOneSearch, searchIncludeArchived, searchOpen]);

  const refreshAll = useCallback(async (options: { includeOrg?: boolean } = {}) => {
    const includeOrg = options.includeOrg !== false;
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-refresh", new Error("Desktop bridge unavailable"));
      setLoaded(true);
      setProjections([]);
      setConversations([]);
      setTaskforces([]);
      setActiveChatIds([]);
      setConfirmations([]);
      setOneProfile(null);
      // Keep interactive browser-preview state stable while the Electron bridge is absent.
      // Initial null still renders the fixtures; user edits should not be erased by refresh polling.
      setFailureFocus(null);
      setOneMemory(null);
      setOneMemoryMap(null);
      setOneSuggestions(null);
      setOneValueClosures(null);
      setOneWeeklyReflection(null);
      setOneExperienceReuse(null);
      setOneImprovementProofs(null);
      setOneIntroState(null);
      setOneActivationState(null);
      setBriefingSnapshot(null);
      return;
    }
    try {
      const [active, pending, update, mobile, recentChats, profile, org, taskforceRows, history, memory, memoryMap, suggestions, valueClosures, weeklyReflection, experienceReuse, improvementProofs, proactiveBriefing, intro, activation] = await Promise.all([
        api.invoke.activeChats().catch(() => []),
        api.confirm.listPending().catch(() => []),
        api.updater.getState().catch(() => null),
        api.mobileBridge.status().catch(() => null),
        // ★ One 것만 데이터베이스에서 골라 받는다.
        // 예전에는 `listRecent(40)` 로 **전체** 최근 40개를 받아 아래에서 One 것만 걸렀다.
        // Work 를 많이 쓰면 그 40칸이 Work 대화로 차서, 멀쩡히 살아 있는 One 대화가
        // 화면에서 사라진다 — 지워진 것처럼 보이지만 행은 그대로다. 실측: One 대화 20개 중
        // 10개만 그 창에 들어왔다. 거르는 일을 DB 에 시키면 창이 One 것만으로 채워진다.
        api.chats.listRecentOne(40).catch(() => []),
        // PRD §4.27 — 홈 새로고침 19개 중 이것 하나만 안전망이 없었다. 프로필 조회가 한 번
        // 실패하면 Promise.all 전체가 거절돼 **모든 화면 갱신이 통째로 건너뛰어졌고**,
        // 바깥 catch 는 복구를 부르며 오류를 지워서 화면이 5초마다 빈 채로 남았다.
        // 프로필이 없으면 이전 값을 유지한다(없음을 성공으로 위장하지 않는다 — 아래에서 그대로 둔다).
        api.oneProfile.get().catch(() => null),
        includeOrg ? api.oneOrg.get().catch(() => null) : Promise.resolve(null),
        api.oneTaskforces.list().catch(() => []),
        api.computerHistory.get().catch(() => null),
        api.oneMemory.getState().catch(() => null),
        typeof api.oneMemory.getMap === "function" ? api.oneMemory.getMap().catch(() => null) : Promise.resolve(null),
        api.oneSuggestions.getState().catch(() => null),
        api.oneValueClosure.getState().catch(() => null),
        api.oneWeeklyReflection.get().catch(() => null),
        api.oneExperienceReuse.getState().catch(() => null),
        api.oneImprovementProof.getState().catch(() => null),
        api.oneBriefing.get().catch(() => null),
        api.oneFeatureIntro.getState().catch(() => null),
        api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null),
      ]);
      let resolvedIntro = intro;
      if (resolvedIntro && resolvedIntro.acknowledgedIntroVersion < resolvedIntro.currentIntroVersion) {
        let legacyVersion = 0;
        try {
          legacyVersion = Number(window.localStorage.getItem(ONE_INTRO_ACK_KEY) ?? "0");
        } catch {
          // Main state remains authoritative.
        }
        if (Number.isSafeInteger(legacyVersion) && legacyVersion >= resolvedIntro.currentIntroVersion) {
          resolvedIntro = await api.oneFeatureIntro.acknowledge({
            expectedStoreVersion: resolvedIntro.version,
            introVersion: resolvedIntro.currentIntroVersion,
            resolution: "legacy_migrated",
            confirmedByUser: true,
          }).catch(async () => api.oneFeatureIntro.getState().catch(() => resolvedIntro));
        }
      }
      if (resolvedIntro) {
        try {
          window.localStorage.removeItem(ONE_INTRO_ACK_KEY);
        } catch {
          // Renderer storage is legacy-only and never gates presentation.
        }
      }
      const items = await listOneTaskProjections(api, active, pending, profile, appLocale);
      // 5초 리프레시가 IPC마다 새 객체를 돌려주므로, 내용이 같으면 이전 참조를
      // 유지한다 — 그래야 무변경 틱에 이 셸 전체가 리렌더되지 않는다.
      setActiveChatIds(keepPrevIfDeepEqual(active));
      setConfirmations(keepPrevIfDeepEqual(pending));
      setUpdaterState(keepPrevIfDeepEqual(update));
      setMobileStatus(keepPrevIfDeepEqual(mobile));
      if (profile) setOneProfile(keepPrevIfDeepEqual(profile));
      if (org) setOneOrgState(keepPrevIfDeepEqual(org));
      setTaskforces(keepPrevIfDeepEqual(taskforceRows));
      setComputerHistory(keepPrevIfDeepEqual(history));
      setOneMemory(keepPrevIfDeepEqual(memory));
      if (memoryMap) {
        setOneMemoryMap((current) => current?.sourceRevision === memoryMap.sourceRevision ? current : memoryMap);
      }
      setOneSuggestions(keepPrevIfDeepEqual(suggestions));
      setOneValueClosures(keepPrevIfDeepEqual(valueClosures));
      setOneWeeklyReflection(keepPrevIfDeepEqual(weeklyReflection));
      setOneExperienceReuse(keepPrevIfDeepEqual(experienceReuse));
      setOneImprovementProofs(keepPrevIfDeepEqual(improvementProofs));
      setOneIntroState(keepPrevIfDeepEqual(resolvedIntro));
      setOneActivationState(keepPrevIfDeepEqual(activation));
      setBriefingSnapshot(keepPrevIfDeepEqual(safeBriefingSnapshot(proactiveBriefing)));
      setProjections(keepPrevIfDeepEqual(items));
      // 목록은 이미 One 것만 온다(위 listRecentOne). 여기서는 Task/태스크포스로 따로
      // 그려지는 것만 뺀다 — origin 검사는 남겨 둔다. 계약이 깨지면 조용히 넘어가는 대신
      // 여기서 걸러지는 편이 낫다.
      /*
       * ★ 2026-08-24 (오너 신고: "One 킬 때마다 기존 대화 날아감"): 팀 대화를 이 목록에서
       *   빼 두었는데, 팀 목록을 그리는 화면은 **끝내 만들어지지 않았다**(taskforces 상태를
       *   렌더하는 곳이 저장소에 하나도 없다). 그래서 팀과 나눈 대화는 어디에도 나타나지
       *   않아 돌아갈 길이 없었다 — 지워진 것이 아니라 닿을 수 없었던 것이다.
       *   목록에 함께 싣는다. 어느 것이 팀인지는 아래에서 표시한다.
       */
      const taskforceChatIds = new Set(taskforceRows.map((taskforce) => taskforce.chatId));
      /*
       * ★ `!chat.taskId` 를 뺐다 (오너 결정 2026-08-24: "두 개 합치라").
       *   작업이 붙은 대화는 이 목록에서 빠지고 아래 작업 목록으로만 떴다. 그래서 같은
       *   일이 두 군데로 갈렸고, 작업 줄에는 이름 대신 "결과 확인" 같은 상태 문구가 붙었다.
       *   목록은 하나이고 작업은 그 대화의 상태일 뿐이므로 전부 대화 줄로 세운다.
       *   (이 줄을 되돌리면 대화 20개 중 19개가 목록에서 사라진다 — 실측.)
       */
      setConversations(keepPrevIfDeepEqual(
        recentChats
          .filter((chat) => chat.originSurface === "one")
          .map((chat) => (taskforceChatIds.has(chat.id) ? { ...chat, isTaskforce: true } : chat)),
      ));
      const wanted = selectedTaskIdRef.current;
      if (wanted) {
        const detail = items.find((item) => item.taskId === wanted)
          ?? await getOneTaskProjection(api, wanted, active, pending, profile, appLocale);
        setSelected(detail);
        setConversation(null);
        setReceipt(detail?.latestReceipt ?? null);
      } else if (selectedConversationIdRef.current) {
        const chatId = selectedConversationIdRef.current;
        const [chat, promotedTask] = await Promise.all([
          api.chats.get(chatId).catch(() => null),
          api.tasks.findForChat(chatId).catch(() => null),
        ]);
        if (promotedTask) {
          selectedTaskIdRef.current = promotedTask.id;
          selectedConversationIdRef.current = null;
          const detail = items.find((item) => item.taskId === promotedTask.id)
            ?? await getOneTaskProjection(api, promotedTask.id, active, pending, profile, appLocale);
          setSelected(detail);
          setConversation(null);
          setReceipt(detail?.latestReceipt ?? null);
          router.replace(`/one?task=${encodeURIComponent(promotedTask.id)}`);
        } else if (chat && chat.originSurface !== "one") {
          // One never ejects the person into Work. Reject stale/non-One deep
          // links in place and return to One's own conversation home instead.
          selectedConversationIdRef.current = null;
          setSelected(null);
          setConversation(null);
          setReceipt(null);
          router.replace("/one");
        } else {
          setSelected(null);
          setConversation(chat);
          setReceipt(null);
        }
      } else {
        setSelected(null);
        setConversation(null);
      }
      setError(null);
    } catch (cause) {
      requestOneOperationalRecovery("one-load", cause);
      setError(null);
    } finally {
      setLoaded(true);
    }
  }, [appLocale, router]);

  const mutateOneOrg = useCallback(async (operation: () => Promise<OneOrgState>, propagateFailure = false) => {
    try {
      const next = await operation();
      setOneOrgState(next);
    } catch (cause) {
      requestOneOperationalRecovery("one-org", cause);
      if (propagateFailure) throw cause;
    }
  }, []);
  const addOneOrg = useCallback((installedAgentId: string, displayName?: string, leaseExpiresAt?: string | null, characterId?: string) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.add({
      installedAgentId,
      ...(displayName ? { displayName } : {}),
      ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
      // 고른 캐릭터가 없으면 패키지가 들고 온 얼굴을 그대로 쓴다.
      ...(characterId ? { avatar: { kind: "preset" as const, characterId } } : {}),
    });
  }, true), [mutateOneOrg]);
  const materializeOneOrgSource = useCallback(async (source: "cloud" | "hub", listing: MarketplaceListing) => {
    const api = ipc();
    if (!api) throw new Error("Desktop bridge unavailable");
    const installed = source === "cloud"
      ? await api.team.installMine(listing.slug)
      : await api.team.install(listing.slug);
    setAvailableAgents((current) => visibleAgents([
      ...current.filter((agent) => agent.id !== installed.id),
      installed,
    ], { includeTeams: true }));
    return installed;
  }, []);
  const renameOneOrg = useCallback((member: OneOrgMember, displayName: string) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.rename({ id: member.id, displayName, expectedRevision: member.revision });
  }), [mutateOneOrg]);
  const updateOneOrg = useCallback(async (member: OneOrgMember, displayName: string, collaborationStyle: OneOrgCollaborationStyle) => {
    const api = ipc();
    if (!api) {
      setOneOrgState((current) => {
        const base = current ?? oneOrgBrowserPreviewState();
        return {
          ...base,
          revision: base.revision + 1,
          members: base.members.map((item) => item.id === member.id
          ? { ...item, displayName, collaborationStyle, revision: item.revision + 1, updatedAt: new Date().toISOString() }
          : item),
        };
      });
      return;
    }
    await mutateOneOrg(() => api.oneOrg.update({ id: member.id, displayName, collaborationStyle, expectedRevision: member.revision }));
  }, [mutateOneOrg]);
  const replaceOneOrg = useCallback((member: OneOrgMember, installedAgentId: string, handoverNote?: string) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.replace({ id: member.id, installedAgentId, handoverNote: handoverNote ?? null, expectedRevision: member.revision });
  }, true), [mutateOneOrg]);
  const archiveOneOrg = useCallback((member: OneOrgMember) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.archive({ id: member.id, expectedRevision: member.revision });
  }), [mutateOneOrg]);
  const restoreOneOrg = useCallback((member: OneOrgMember) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.restore({ id: member.id, expectedRevision: member.revision });
  }), [mutateOneOrg]);
  const reorderOneOrg = useCallback((orderedIds: string[], expectedRevision: number) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.reorder({ orderedIds, expectedRevision });
  }), [mutateOneOrg]);
  const setOneOrgAutoSelect = useCallback((member: OneOrgMember, enabled: boolean) => mutateOneOrg(() => {
    const api = ipc();
    if (!api) return Promise.reject(new Error("Desktop bridge unavailable"));
    return api.oneOrg.setTools({ id: member.id, autoSelectTools: enabled, expectedRevision: member.revision });
  }), [mutateOneOrg]);
  const enableComputerHistory = useCallback(async (enabled: boolean) => {
    const api = ipc();
    if (!api) {
      setComputerHistory((current) => ({
        schemaVersion: 1,
        consent: enabled ? "on" : "off",
        generatedAt: new Date().toISOString(),
        entries: enabled ? (current?.entries ?? []) : [],
      }));
      return;
    }
    const next = await api.computerHistory.setConsent(enabled).catch(() => null);
    if (next) setComputerHistory(next);
  }, []);
  const toggleOnePlugin = useCallback(async (pluginId: string, nextEnabled: boolean) => {
    const target = installedPlugins.find((plugin) => plugin.id === pluginId);
    if (!target) return;
    if (target.configurationValid === false && nextEnabled) {
      setSettingsSheet(null);
      setPluginPickerOpen(true);
      return;
    }
    setInstalledPlugins((current) => current.map((plugin) => plugin.id === pluginId ? { ...plugin, enabled: nextEnabled } : plugin));
    const api = ipc();
    if (!api) return;
    try {
      await api.mcpTools.setEnabled(pluginId, nextEnabled);
      setInstalledPlugins(await api.mcpTools.listInstalled());
      setPluginStatuses(await api.mcpTools.status().catch(() => pluginStatuses));
    } catch {
      setInstalledPlugins((current) => current.map((plugin) => plugin.id === pluginId ? { ...plugin, enabled: target.enabled } : plugin));
    }
  }, [installedPlugins, pluginStatuses]);
  const clearComputerHistoryView = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setHistoryClearBusy(true);
    try {
      const next = await api.computerHistory.clear();
      setComputerHistory(next);
      setHistoryClearConfirmOpen(false);
    } catch (cause) {
      requestOneOperationalRecovery("one-computer-history-clear", cause);
    } finally {
      setHistoryClearBusy(false);
    }
  }, []);
  useEffect(() => {
    void refreshAll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    const timer = window.setInterval(() => {
      // One Team is event-driven. The general shell refresh remains for
      // conversations/receipts, but it must not poll the org ledger.
      if (document.visibilityState === "visible") void refreshAll({ includeOrg: false });
    }, 5_000);
    window.addEventListener("focus", onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAll]);

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onStoreChanged) return;
    return events.onStoreChanged((change) => {
      const api = ipc();
      if (!api) return;
      if (change.entity === "one-org") {
        void Promise.all([
          api.oneOrg.get(),
          api.team.list().catch(() => null),
        ]).then(([next, agents]) => {
          setOneOrgState(keepPrevIfDeepEqual(next));
          if (agents) setAvailableAgents(keepPrevIfDeepEqual(agents));
        }).catch(() => undefined);
      } else if (change.entity === "one-taskforce") {
        void refreshAll({ includeOrg: false });
      }
    });
  }, [refreshAll]);

  const reconcileConversationTask = useCallback(async (chatId: string) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-task-reconcile", new Error("Desktop bridge unavailable"));
      return null;
    }
    const task = await api.tasks.findForChat(chatId).catch(() => null);
    if (!task) return null;
    runTaskIdRef.current = task.id;
    selectedTaskIdRef.current = task.id;
    selectedConversationIdRef.current = null;
    router.replace(`/one?task=${encodeURIComponent(task.id)}`);
    await refreshAll();
    return task;
  }, [refreshAll, router]);

  const settleRun = useCallback(async (chatId: string, taskId: string | null, settledRunId: string | null) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-run-settle", new Error("Desktop bridge unavailable"));
      return;
    }
    // A terminal event can start asynchronous task reconciliation just as the
    // person sends the next turn. Never let that older completion refresh the
    // newer run's activity/timer back to the older receipt.
    const supersededByNewerRun = () => Boolean(
      settledRunId
      && ((runIdRef.current && runIdRef.current !== settledRunId)
        || (activityRunIdRef.current && activityRunIdRef.current !== settledRunId)),
    );
    if (supersededByNewerRun()) return;
    const promotedTask = taskId ? await api.tasks.get(taskId).catch(() => null) : await reconcileConversationTask(chatId);
    if (supersededByNewerRun()) return;
    const pending = await api.confirm.listPending().catch(() => []);
    if (supersededByNewerRun()) return;
    setConfirmations(pending);
    if (supersededByNewerRun()) return;
    await refreshAll();
    if (supersededByNewerRun()) return;
    /*
     * ★ 답 말풍선을 durable 기록에서 되살린다.
     *
     * 실행이 끝났다는 사실은 두 길로 온다: 라이브 이벤트(정상)와, 그것을 놓쳤을 때 도는
     * activeChats 폴링 안전망(아래 useEffect). 그런데 이 settleRun 은 threadRuns 와
     * Activity 만 복원하고 **대화 메시지는 다시 읽지 않았다.** 답은 messages 에 사는데
     * 그것을 안 채우니, 라이브 이벤트를 놓친 실행은 서버가 답을 냈고 기록에도 남았는데
     * 화면에는 내 말풍선만 남는다 — 새로고침해야 보인다.
     *
     * 웹 이식본에서 먼저 실측됐다(2026-08-24, 이벤트 스트림 미개설). 데스크탑은 IPC 라
     * 놓칠 일이 드물지만 안전망이 존재한다는 것 자체가 "놓칠 수 있다"는 뜻이고, 나머지를
     * 다 복원하면서 정작 답만 빼놓는 안전망은 반쪽이다. 새로고침이 하는 일을 그대로 한다.
     *
     * 지금 그 대화를 보고 있고 새 실행이 시작되지 않았을 때만. 서버 스냅샷이 비어 있으면
     * 화면의 낙관 행을 지우지 않는다 — 없는 것을 사실로 만들지 않기 위해서다.
     */
    if (shownThreadChatIdRef.current === chatId && runChatIdRef.current === chatId && !runIdRef.current) {
      const history = await api.invoke.history(chatId).catch(() => null);
      if (!supersededByNewerRun() && history && shownThreadChatIdRef.current === chatId) {
        const next = toUiMessages(history);
        setMessages((current) => {
          // A navigation or a newer run can begin after the history promise
          // resolves but before React applies this updater. Re-check the
          // current owners here so an older terminal receipt cannot overwrite
          // a different chat or its live response.
          if (
            shownThreadChatIdRef.current !== chatId
            || runChatIdRef.current !== chatId
            || runIdRef.current
          ) return current;
          if (next.length === 0 && current.length > 0) return current;
          return hydrateCachedChatFiles(
            mergeDurableChatCatchup(current, next),
            chatFileGroupsIncludingMessages(oneChatFileGroupsRef.current, current),
          );
        });
      }
    }
    if (supersededByNewerRun()) return;
    // A canonical Task projection can intentionally omit a receipt that has
    // not yet been bound into its immutable reference list. That must not
    // erase the Activity for the run that just settled: the chat-owned durable
    // receipt is authoritative for this exact One thread. Rehydrate only when
    // it is still the settled run, so a later turn cannot be replaced by an
    // older timeline during the async refresh.
    const latestReceipt = await api.invoke.latestReceipt(chatId).catch(() => null);
    if (supersededByNewerRun() || !latestReceipt || (settledRunId && latestReceipt.runId !== settledRunId)) return;
    const [ledgerEvents, chatTimeline] = await Promise.all([
      api.runLedger.events(latestReceipt.runId, 500).catch(() => []),
      api.runLedger.chatTimeline(chatId, { maxRuns: 40, eventsPerRun: 400 }).catch(() => []),
    ]);
    if (supersededByNewerRun()) return;
    if (threadRunsChatIdRef.current === chatId && chatTimeline.length > 0) {
      setThreadRuns(projectThreadRuns(chatTimeline));
    }
    if (ledgerEvents.length === 0) return;
    const restoredActivity = projectOneActivityFromLedger(ledgerEvents, latestReceipt);
    cacheOneActivity(chatId, restoredActivity);
    activityEventRunIdRef.current = latestReceipt.runId;
    setActivityStateRunId(latestReceipt.runId);
    setActivity(restoredActivity);
    setRunStartedAt(latestReceipt.startedAt ? Date.parse(latestReceipt.startedAt) : null);
  }, [reconcileConversationTask, refreshAll]);

  const consumeRunEvent = useCallback((event: McpInvocationEvent, sourceRunId?: string) => {
    const chatId = runChatIdRef.current;
    const taskId = runTaskIdRef.current;
    // IPC delivery can lag after unsubscribe. A terminal event from run N must
    // never clear the optimistic prompt, timer, or Activity for run N+1.
    // The subscription channel owns this ID; do not infer ownership from the
    // mutable current-run ref.
    if (sourceRunId && sourceRunId !== runIdRef.current) return;
    const eventRunId = sourceRunId ?? runIdRef.current;
    if (!chatId || !eventRunId) return;
    // React may apply these updaters after navigation or the next run starts.
    // Settlement clears runId synchronously; the activity owner retains this
    // exact run until a new invocation or a conversation switch takes over.
    const ownsQueuedUpdate = () => runChatIdRef.current === chatId
      && shownThreadChatIdRef.current === chatId
      && (runIdRef.current === eventRunId
        || (!runIdRef.current && activityRunIdRef.current === eventRunId));
    setActivityStateRunId((current) => ownsQueuedUpdate() ? eventRunId : current);
    setActivity((current) => {
      if (!ownsQueuedUpdate()) return current;
      const base = activityEventRunIdRef.current === eventRunId ? current : initialOneActivityState();
      const next = reduceOneActivity(base, event);
      activityEventRunIdRef.current = eventRunId;
      cacheOneActivity(chatId, next);
      return next;
    });
    if (event.kind === "notice" && event.notice?.code === "runtime-fallback" && event.runtimeSelection) {
      /*
       * ★폴백은 **이번 실행의 우회로**다. 사용자의 모델 선택을 바꾸는 신호가 아니다.
       *
       * 실사용 실측 2026-09-07. 여기서 셋을 했었다:
       *   writeStoredOneRuntimeSelection(selection)  ← One 의 **전역** 핀(localStorage)
       *   api.chats.setRuntimeSelection(chatId, ...) ← 대화 핀을 DB 에 영구 저장
       *   setOneRuntime(...)                          ← 작성창 칩을 폴백 모델로 교체
       * 제미나이가 한도(25분이면 풀린다)로 한 번 실패하면 그 순간 One 이 통째로 grok 으로
       * 굳었다. 대화 하나가 아니라 **전역 핀**이라 새 대화도 grok 으로 시작했다.
       * 사용자가 겪은 것이 정확히 그것이다 — "제미나이로 했는데", "One이 지혼자 막 모델이
       * 바뀜", "자꾸 걍 그록만 호출된다".
       *
       * 이제 Main 도 저장하지 않는다(mcp/client.ts emitControllerRuntimeFallback).
       * 양쪽 끝을 같이 바꿔야 한다 — 한쪽만 고치면 다른 쪽이 계속 덮어쓴다.
       * 알림 자체는 활동 리듀서가 이미 그렸고, 거기에 무엇으로 이어갔는지 적혀 있다.
       */
    }
    if (event.kind === "mcp-key-request") {
      if (event.keyRequest && event.keyRequest.expiresAt > Date.now()) {
        setKeyRequestSheet(event.keyRequest);
      }
      return;
    }
    if (event.agentId && event.phase !== "synthesize") {
      if (!taskId) void reconcileConversationTask(chatId);
      return;
    }
    if (event.kind === "thinking" || event.kind === "tool-use") {
      if (!taskId && event.kind === "tool-use") void reconcileConversationTask(chatId);
      return;
    }
    if (event.kind === "partial") {
      if (typeof event.delta === "string") streamTextRef.current += event.delta;
      else streamTextRef.current = event.text ?? streamTextRef.current;
      oneTranscriptRevisionRef.current += 1;
      const partialText = streamTextRef.current;
      setMessages((current) => ownsQueuedUpdate()
        ? upsertLiveMessage(current, partialText, true).map((message) => message.id === "one-live-response" && event.goalResult ? { ...message, goalResult: event.goalResult } : message)
        : current);
      /*
       * ★ 답이 흘러나오는 동안에도 화면이 따라 내려간다 (오너 지적 2026-08-24).
       *
       * 예전에는 **다 끝났을 때만** 내려갔다. 긴 답은 아래로 계속 자라는데 화면은 그대로라,
       * 답이 오고 있는데도 사용자는 빈 화면을 본다 — "답이 안 온다"로 읽힌다.
       *
       * 단, **사람이 위로 올려 읽고 있으면 끌어내리지 않는다.** 읽던 자리를 뺏는 것이
       * 안 따라가는 것보다 나쁘다. 맨 아래 근처에 있을 때만 따라간다.
       */
      followStreamToLatest();
      return;
    }
    if (event.kind === "surface") {
      if (event.oneSurface) setSurface(event.oneSurface);
      scrollToLatest();
      if (!taskId) void reconcileConversationTask(chatId);
      return;
    }
    if (event.kind === "final") {
      const settledRunId = eventRunId;
      if (cancelNoticeRunIdRef.current === settledRunId) {
        const notice = cancelNoticeTextRef.current;
        cancelNoticeRunIdRef.current = null;
        cancelNoticeTextRef.current = null;
        setActionNotice((current) => current === notice ? null : current);
      }
      setKeyRequestSheet(null);
      const text = event.text ?? streamTextRef.current;
      // Commit the streamed answer under its own id. Leaving it as the shared
      // "one-live-response" row meant the next turn's live row *replaced* it
      // (measured 2026-08-15: the previous answer vanished while a queued
      // instruction ran, until the history reload brought it back).
      oneTranscriptRevisionRef.current += 1;
      setMessages((current) => ownsQueuedUpdate() ? upsertLiveMessage(current, text, false).map((message) => (
        message.id === "one-live-response"
          ? { ...message, ...(event.goalResult ? { goalResult: event.goalResult } : {}), id: `one-answer:${settledRunId ?? uid()}`, createdAt: message.createdAt ?? new Date().toISOString(), ...(event.durableMessageId ? { durableMessageId: event.durableMessageId } : {}) }
          : message
      )) : current);
      setBusy(false);
      setLiveRunPrompt((current) => current?.runId === settledRunId ? null : current);
      setDispatchRunPrompt((current) => current?.runId === settledRunId ? null : current);
      if (dispatchRunPromptRef.current?.runId === settledRunId) dispatchRunPromptRef.current = null;
      activeRunStartedAtRef.current = null;
      runIdRef.current = null;
      streamTextRef.current = "";
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      scrollToLatest();
      void settleRun(chatId, taskId, settledRunId);
      return;
    }
    if (event.kind === "error") {
      const settledRunId = eventRunId;
      if (cancelNoticeRunIdRef.current === settledRunId) {
        const notice = cancelNoticeTextRef.current;
        cancelNoticeRunIdRef.current = null;
        cancelNoticeTextRef.current = null;
        setActionNotice((current) => current === notice ? null : current);
      }
      setKeyRequestSheet(null);
      // Failure evidence is persisted by Main and consumed by One's recovery
      // judgment. It never becomes transcript copy in the renderer.
      // Whatever streamed before the failure stays as this run's answer row
      // (Main persists the same partial); an empty live row is dropped so it
      // cannot be mistaken for "the place where it ended".
      setMessages((current) => ownsQueuedUpdate() ? current.flatMap((message) => {
        if (message.id !== "one-live-response") return [message];
        if (!message.text.trim()) return [];
        return [{ ...message, id: `one-answer:${settledRunId ?? uid()}`, streaming: false, createdAt: message.createdAt ?? new Date().toISOString(), ...(event.durableMessageId ? { durableMessageId: event.durableMessageId } : {}) }];
      }) : current);
      setBusy(false);
      setLiveRunPrompt((current) => current?.runId === settledRunId ? null : current);
      setDispatchRunPrompt((current) => current?.runId === settledRunId ? null : current);
      if (dispatchRunPromptRef.current?.runId === settledRunId) dispatchRunPromptRef.current = null;
      activeRunStartedAtRef.current = null;
      setError(null);
      runIdRef.current = null;
      streamTextRef.current = "";
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      void settleRun(chatId, taskId, settledRunId);
    }
  }, [reconcileConversationTask, scrollToLatest, settleRun, followStreamToLatest]);

  const consumeRunEventRef = useRef(consumeRunEvent);
  useEffect(() => {
    consumeRunEventRef.current = consumeRunEvent;
  }, [consumeRunEvent]);

  const subscribeRun = useCallback((runId: string) => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events) return;
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = events.on(api.invoke.eventChannel(runId), (event) => consumeRunEventRef.current(event, runId));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const activeThreadChatId = selected?.chatId ?? conversation?.id ?? null;
    // Conversation -> Task promotion briefly clears both projections while the
    // route already points at the new task. Preserve the just-finished run
    // through that handoff; resetting here made Activity disappear exactly at
    // completion. A genuinely empty One home still clears it.
    const promotionHandoff = activeThreadChatId == null
      && Boolean(selectedTaskId)
      && activityChatIdRef.current != null;
    const sameActivityThread = promotionHandoff || activityChatIdRef.current === activeThreadChatId;
    /*
     * ★ 아직 어느 대화인지 모르는 순간에는 구독을 끊지 않는다 (2026-08-24).
     *
     * 이 효과는 화면 상태가 바뀔 때마다 다시 돈다. 대화가 작업으로 승격되는 짧은 순간에는
     * 화면이 어느 대화를 보고 있는지 잠깐 비는데, 그때 아래에서 **도는 실행의 실시간
     * 구독을 통째로 끊어** 버렸다. 구독이 끊기면 답이 만들어지고 크레딧까지 나가도
     * 화면에는 아무것도 안 온다 — 프로덕션에서 그 증상이 반복해서 났다.
     *
     * "모른다"는 "다른 대화로 옮겼다"가 아니다. 정말로 다른 대화로 옮겼을 때만 끊는다.
     */
    const activeThreadUnknown = activeThreadChatId == null;
    const liveRunOwnsActiveThread = Boolean(
      runIdRef.current
      && runChatIdRef.current
      && (runChatIdRef.current === activeThreadChatId || promotionHandoff || activeThreadUnknown),
    );
    if (!promotionHandoff) activityChatIdRef.current = activeThreadChatId;

    // Task projections are refreshed throughout an active run. Those refreshes
    // update latestReceipt/status and re-enter this effect, but they must not
    // tear down the only live event subscription. Preserve the run and merely
    // advance its Task association through a Conversation -> Task promotion.
    if (liveRunOwnsActiveThread) {
      runTaskIdRef.current = selected?.taskId ?? runTaskIdRef.current;
      setReceipt(selected?.latestReceipt ?? null);
      return () => { cancelled = true; };
    }

    /*
     * 진단용 한 줄 — 동작은 바꾸지 않는다.
     *
     * 이 자리는 "사용자가 다른 대화로 옮겼다"고 보고 **도는 실행의 실시간 구독을 끊는**
     * 곳이다. 웹 이식본에서 전송 직후 이 teardown 이 돌아, 방금 건 구독이 열리기도 전에
     * 닫히는 것이 관측됐다(2026-08-24). 판정이 왜 "옮겼다"로 나왔는지는 두 값을 나란히
     * 봐야 알 수 있는데, 그 순간을 사람이 재현해 잡기 어렵다.
     *
     * `window.__ipcTrace` 가 정의돼 있을 때만 적는다 — 없으면 아무 일도 하지 않으므로
     * 제품 동작·성능에 영향이 없다. 원인이 확정되면 지운다.
     */
    try {
      const trace = (globalThis as { __ipcTrace?: unknown[] }).__ipcTrace;
      if (Array.isArray(trace)) {
        trace.push({
          at: "one-shell/teardown",
          activeThreadChatId,
          runChatId: runChatIdRef.current,
          runId: runIdRef.current,
          promotionHandoff,
          activeThreadUnknown,
        });
      }
    } catch {
      // 진단이 제품을 멈추게 하지 않는다.
    }
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = null;
    const detachedRunId = runIdRef.current;
    if (detachedRunId && cancelNoticeRunIdRef.current === detachedRunId) {
      const notice = cancelNoticeTextRef.current;
      cancelNoticeRunIdRef.current = null;
      cancelNoticeTextRef.current = null;
      setActionNotice((current) => current === notice ? null : current);
    }
    runIdRef.current = null;
    activityRunIdRef.current = null;
    activityEventRunIdRef.current = null;
    dispatchRunPromptRef.current = null;
    activeRunStartedAtRef.current = null;
    setActivityStateRunId(null);
    streamTextRef.current = "";
    setBusy(false);
    setKeyRequestSheet(null);
    if (!sameActivityThread && activeThreadChatId) {
      activityEventRunIdRef.current = null;
      setActivity(oneActivitySessionCache.get(activeThreadChatId) ?? initialOneActivityState());
      setRunStartedAt(null);
    }
    setSurface(null);
    setReceipt(selected?.latestReceipt ?? null);
    if (!activeThreadChatId) {
      if (freshChatSubmissionPendingRef.current) return;
      if (!selectedTaskId) {
        activityEventRunIdRef.current = null;
        setActivity(initialOneActivityState());
        setRunStartedAt(null);
      }
      oneTranscriptRevisionRef.current += 1;
      setMessages([]);
      shownThreadChatIdRef.current = null;
      setCommittedAnswers([]);
      setThreadRuns([]);
      threadRunsChatIdRef.current = null;
      return;
    }
    freshChatSubmissionPendingRef.current = false;
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-thread-load", new Error("Desktop bridge unavailable"));
      return;
    }
    const chatId = activeThreadChatId;
    // Another conversation's settled blocks must never sit under this one's
    // messages while the ledger loads.
    if (threadRunsChatIdRef.current !== chatId) {
      setThreadRuns([]);
      threadRunsChatIdRef.current = chatId;
    }
    const taskId = selected?.taskId ?? null;
    /*
     * ★"이 실행이 이 대화의 것인가"는 **바꾸기 전** 값으로 판정해야 한다.
     *
     * 아래에서 runChatIdRef 를 지금 여는 대화로 덮어쓴 다음, 그 값을 다시 읽어
     * 소유를 판정하고 있었다. 그러면 비교는 언제나 참이 되고, 다른 대화로 옮겨도
     * "지금 실행이 이 스레드를 쓰고 있다"고 잘못 판단해 히스토리를 불러오지 않는다.
     * 화면에는 방금 떠난 대화의 메시지가 그대로 남고 제목만 새 대화가 된다 —
     * 사용자에게는 여러 세션이 하나로 합쳐진 것처럼 보인다.
     */
    const runChatIdBeforeSwitch = runChatIdRef.current;
    const hydrationRevision = oneTranscriptRevisionRef.current;
    runChatIdRef.current = chatId;
    runTaskIdRef.current = taskId;
    void Promise.all([
      api.invoke.history(chatId),
      api.invoke.attach(chatId).catch(() => null),
      api.confirm.committedAnswers(chatId).catch(() => []),
      api.invoke.latestReceipt(chatId).catch(() => null),
      api.runLedger.chatTimeline(chatId, { maxRuns: 40, eventsPerRun: 400 }).catch(() => []),
    ]).then(async ([history, attachment, answers, latestReceipt, chatTimeline]) => {
      const taskReceipt = taskId ? selected?.latestReceipt ?? null : null;
      const durableReceipt = latestReceipt ?? taskReceipt;
      const ledgerEvents = !attachment && durableReceipt
        ? await api.runLedger.events(durableReceipt.runId, 500).catch(() => [])
        : [];
      const durableSurface = taskId && taskReceipt?.runId
        ? await api.invoke.latestOneSurface({
            runId: taskReceipt.runId,
            chatId,
            taskId,
          }).catch(() => null)
        : null;
      if (cancelled) return;
      // A newly created conversation can start its first run before this
      // initial history request resolves. Do not replace the optimistic user
      // turn and live response with the earlier empty snapshot.
      const screenAlreadyOnThisThread = shownThreadChatIdRef.current === chatId;
      const liveRunOwnsThread = screenAlreadyOnThisThread && Boolean(
        attachment || (runIdRef.current && runChatIdBeforeSwitch === chatId),
      );
      if (!liveRunOwnsThread) {
        const next = toUiMessages(history);
        setMessages((current) => {
          // This request can resolve after a navigation or a new live run.
          // The callback, not only the request-time snapshot, decides which
          // chat currently owns the renderer.
          const screenStillOnThisThread = shownThreadChatIdRef.current === chatId;
          const liveRunNowOwnsThread = Boolean(
            runIdRef.current && runChatIdBeforeSwitch === chatId,
          );
          if (!screenStillOnThisThread || liveRunNowOwnsThread) return current;
          // 이 읽기가 출발한 뒤 화면이 이미 움직였다면, 옛 스냅샷은 답이 아니다.
          if (oneTranscriptRevisionRef.current !== hydrationRevision) return current;
          const hydratedNext = hydrateCachedChatFiles(
            next,
            chatFileGroupsIncludingMessages(oneChatFileGroupsRef.current, current),
          );
          // 같은 대화인데 서버 스냅샷이 아직 비었다면(첫 실행이 방금 시작됐다면)
          // 사람이 막 친 말과 라이브 응답을 빈 스냅샷으로 지우지 않는다.
          if (hydratedNext.length === 0 && current.length > 0) return current;
          return mergeDurableChatCatchup(current, hydratedNext);
        });
      }
      shownThreadChatIdRef.current = chatId;
      // Every settled run of this conversation becomes its own turn block. The
      // live run (attachment) is drawn from live state and excluded at render.
      if (threadRunsChatIdRef.current === chatId) {
        setThreadRuns(projectThreadRuns(chatTimeline));
      }
      // This effect can finish after another turn has started. In that case its
      // receipt belongs to the prior run and may restore only transcript data,
      // never the current Activity/timer projection.
      const durableActivityStillOwnsScreen = !activityRunIdRef.current
        || activityRunIdRef.current === durableReceipt?.runId;
      if (!liveRunOwnsThread && !attachment && durableActivityStillOwnsScreen && ledgerEvents.length > 0) {
        const restoredActivity = projectOneActivityFromLedger(ledgerEvents, durableReceipt);
        activityEventRunIdRef.current = durableReceipt?.runId ?? null;
        setActivityStateRunId(durableReceipt?.runId ?? null);
        setActivity(restoredActivity);
        cacheOneActivity(chatId, restoredActivity);
        setRunStartedAt(durableReceipt?.startedAt ? Date.parse(durableReceipt.startedAt) : null);
      }
      setCommittedAnswers(answers);
      if (!liveRunOwnsThread) {
        setReceipt(taskReceipt);
        setSurface(durableSurface?.manifest ?? null);
      }
      void api.chats.markViewed(chatId).catch(() => undefined);
      if (attachment) {
        runIdRef.current = attachment.runId;
        activityRunIdRef.current = attachment.runId;
        activityEventRunIdRef.current = null;
        dispatchRunPromptRef.current = null;
        activeRunStartedAtRef.current = attachment.startedAt ? Date.parse(attachment.startedAt) : Date.now();
        setActivityStateRunId(null);
        setBusy(true);
        setRunStartedAt(attachment.startedAt ? Date.parse(attachment.startedAt) : Date.now());
        subscribeRun(attachment.runId);
        for (const event of attachment.events) consumeRunEventRef.current(event, attachment.runId);
      }
      /*
       * ★대화를 열면 **가장 최근 말**이 보여야 한다 (실측 2026-09-08).
       *   60개짜리 대화를 열어 재 보니 One 은 맨 위에 머물렀다(스크롤 0 / 전체 4,628px,
       *   마지막 메시지는 화면 아래 4,364px 지점). Work 는 같은 조건에서 아래로 내려간다.
       *   실행 중에 붙은 경우는 이미 다른 자리에서 따라 내려가므로 여기서는 첫 수화만.
       */
      if (!cancelled && shownThreadChatIdRef.current === chatId && !attachment) {
        pinToLatest();
      }
    }).catch((cause) => {
      if (!cancelled) {
        requestOneOperationalRecovery("one-refresh", cause);
        setError(null);
        /*
         * ★대화를 못 읽었는데 화면에는 "대화를 시작해 보세요" 빈 화면이 떴다
         *   (실측 2026-09-08). 자기 대화가 지워진 것처럼 보인다.
         *   복구는 뒤에서 돌더라도, 지금 보고 있는 사람에게는 사실을 말해야 한다.
         */
        setActionNotice(appLocale === "ko"
          ? "이 대화를 불러오지 못했습니다. 지워진 것이 아니라 읽지 못한 것입니다 — 다시 열어 보세요."
          : "This conversation could not be loaded. It was not deleted — the read failed. Try opening it again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    pinToLatest,
    conversation?.id,
    appLocale,
    selected?.chatId,
    selected?.latestReceipt?.runId,
    selected?.latestReceipt?.status,
    selected?.taskId,
    subscribeRun,
  ]);

  // Dependency changes above represent projection refreshes, not component
  // disposal. Release the subscription only when OneShell actually unmounts;
  // terminal events and real thread switches still close it explicitly.
  useEffect(() => () => {
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = null;
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelected(null);
      return;
    }
    const match = projections.find((item) => item.taskId === selectedTaskId);
    if (match) setSelected(match);
  }, [projections, selectedTaskId]);

  const activeThreadChatId = selected?.chatId ?? conversation?.id ?? null;
  // Route identity changes before the selected chat finishes loading. Keep a
  // Goal-only render fence; the existing selection refs also own handoffs.
  const goalControlViewKey = `${selectedTaskId ?? ""}:${selectedConversationId ?? ""}:${activeThreadChatId ?? ""}`;
  const goalControlViewKeyRef = useRef(goalControlViewKey);
  goalControlViewKeyRef.current = goalControlViewKey;
  useLayoutEffect(() => bindAgentScreenScope(activeThreadChatId), [activeThreadChatId]);
  useEffect(() => {
    oneChatFileGroupsRef.current.clear();
  }, [activeThreadChatId]);
  useEffect(() => {
    if (!activeThreadChatId) return;
    const bridge = chatFilesBridge();
    if (!bridge) return;
    // Settlement replaces the optimistic row with a marker-only durable row.
    // Reuse the already loaded group immediately instead of waiting for a
    // reload (or issuing another IPC request) to make its card visible again.
    setMessages((current) => hydrateCachedChatFiles(current, oneChatFileGroupsRef.current));
    const groupIds = [...new Set(messages.flatMap((message) => message.chatFileGroupIds ?? []))]
      .filter((groupId) => !oneChatFileGroupsRef.current.has(groupId));
    if (groupIds.length === 0) return;
    let cancelled = false;
    void Promise.all(groupIds.map(async (groupId) => {
      const stored = await bridge.listGroup({ chatId: activeThreadChatId, groupId });
      return [groupId, stored.map((file) => chatFileItem(file, "user-attachment"))] as const;
    })).then((groups) => {
      if (cancelled) return;
      for (const [groupId, files] of groups) oneChatFileGroupsRef.current.set(groupId, files);
      setMessages((current) => hydrateCachedChatFiles(current, oneChatFileGroupsRef.current));
    }).catch((cause) => {
      if (!cancelled) setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [activeThreadChatId, messages]);
  const activeThreadChatIdRef = useRef(activeThreadChatId);
  // Keep the guard synchronous with render. An effect leaves one commit where
  // a picker started in chat A can settle after navigation and paint A's path
  // into chat B.
  activeThreadChatIdRef.current = activeThreadChatId;
  useEffect(() => {
    const api = ipc();
    if (!api || !activeThreadChatId) return;
    let disposed = false;
    return (() => {
      const unsubscribe = ipcEvents()?.onStoreChanged?.((change) => {
        if (change.entity !== "chat" || change.id !== activeThreadChatId) return;
        void api.invoke.history(activeThreadChatId).then((history) => {
          if (disposed || activeThreadChatIdRef.current !== activeThreadChatId) return;
          const states = new Map(history.filter((entry) => entry.goalResult).map((entry) => [entry.durableMessageId ?? entry.id, entry.goalResult]));
          setMessages((current) => current.map((message) => {
            const result = states.get(message.durableMessageId ?? message.id);
            return result ? { ...message, goalResult: mergeGoalResults(message.goalResult, result) } : message;
          }));
        }).catch(() => undefined);
      });
      return () => { disposed = true; unsubscribe?.(); };
    })();
  }, [activeThreadChatId]);
  useEffect(() => {
    onePaneCommitWaiterRef.current.observe(selectedConversationId, activeThreadChatId);
  }, [activeThreadChatId, selectedConversationId]);
  useEffect(() => () => onePaneCommitWaiterRef.current.dispose(), []);
  /*
   * 세션 목록 — **하나의 목록**이다 (오너 결정 2026-08-24).
   *
   * 예전에는 시간으로 묶고 그 아래에 작업 목록을 따로 붙였다. 화면에서는 "지난 7일" 과
   * "최근" 이 갈려 보였고, 같은 날 대화가 서로 다른 덩어리에 흩어졌다. 사람이 찾는 것은
   * 날짜가 아니라 대화이므로, 최근 순으로 한 줄씩 세운다.
   *
   * 각 줄에 붙는 것은 상태 문구("결과 확인")가 아니라 **누구와 한 대화인지**다 — One,
   * 단톡방 이름, 또는 그 에이전트의 표시 이름. 상태는 점 하나로 족하다.
   *
   * 30일 넘게 손대지 않은 것만 접어 둔다 — 사용자가 직접 정리하게 만들지 않는다.
   */
  /**
   * 옆에 세워 둘 칸. 지금 보고 있는 대화는 왼쪽 첫 칸이므로 목록에서 뺀다 —
   * 빼지 않으면 같은 대화가 두 칸에 떠서 어느 쪽이 진짜인지 알 수 없다.
   * 사라진 대화 id 는 조용히 버린다(세션이 지워져도 화면이 깨지지 않아야 한다).
   */
  /**
   * 나간 팀원 표시.
   *
   * 자리를 뜬 팀원의 대화가 그냥 열리기만 하면, 사용자는 답이 왜 One 말투로
   * 바뀌었는지 알 길이 없다. 나간 사실을 대화 안에 회색 줄로 남긴다
   * (오너 결정 2026-08-24). 나간 시각 뒤의 첫 메시지 앞에 놓아, 언제부터
   * One 이 대신 받고 있는지가 시간 순서로 드러나게 한다.
   */
  const departureNotices = useMemo(() => {
    const chatId = activeThreadChatId;
    if (!chatId) return [] as Array<{ id: string; at: number; label: string }>;
    const memberByAgent = new Map((oneOrgState?.members ?? []).map((member) => [member.installedAgentId, member]));
    const taskforce = taskforces.find((item) => item.chatId === chatId);
    const agentIds = taskforce
      ? taskforce.memberAgentIds
      : (activeThreadChat?.agentId ? [activeThreadChat.agentId] : []);
    const notices: Array<{ id: string; at: number; label: string }> = [];
    for (const agentId of agentIds) {
      const member = memberByAgent.get(agentId);
      /*
       * 조직에 없는 id 를 "나갔다"로 읽으면 안 된다. 조직이 아직 안 실려 왔을
       * 때도, 애초에 팀원 자리가 아닌 대화일 때도 같은 모양이라서 One 대화에
       * "나간 팀원 나갔습니다" 가 떴다(실측 2026-08-24). 나간 시각이 실제로
       * 적혀 있고 이름을 아는 경우에만 줄을 남긴다.
       */
      if (!member || !member.archivedAt) continue;
      const name = (appLocale === "ko" ? member.displayName : member.nameEn || member.displayName).trim();
      if (!name) continue;
      const shown = name;
      const at = new Date(member.archivedAt).getTime();
      notices.push({
        id: `left:${agentId}`,
        at: Number.isNaN(at) ? 0 : at,
        label: appLocale === "ko" ? `${shown} 나갔습니다` : `${shown} left`,
      });
    }
    return notices.sort((left, right) => left.at - right.at);
  }, [activeThreadChatId, activeThreadChat, taskforces, oneOrgState, appLocale]);

  /** 나간 줄을 어느 메시지 앞에 놓을지. 남는 것은 대화 끝에 붙인다. */
  const departurePlan = useMemo(() => {
    const beforeMessage = new Map<string, Array<{ id: string; label: string }>>();
    const trailing: Array<{ id: string; label: string }> = [];
    const pending = [...departureNotices];
    for (const message of visibleMessages) {
      if (pending.length === 0) break;
      const at = message.createdAt ? new Date(message.createdAt).getTime() : Number.NaN;
      if (Number.isNaN(at)) continue;
      while (pending.length > 0 && pending[0].at > 0 && pending[0].at <= at) {
        const notice = pending.shift()!;
        const list = beforeMessage.get(message.id) ?? [];
        list.push({ id: notice.id, label: notice.label });
        beforeMessage.set(message.id, list);
      }
    }
    for (const notice of pending) trailing.push({ id: notice.id, label: notice.label });
    return { beforeMessage, trailing };
  }, [departureNotices, visibleMessages]);

  const splitPanes = useMemo(() => {
    const byId = new Map(conversations.map((chat) => [chat.id, chat]));
    const seen = new Set<string>();
    const panes: Chat[] = [];
    for (const id of splitChatIds) {
      if (id === selectedConversationId || seen.has(id)) continue;
      const chat = byId.get(id);
      if (!chat) continue;
      seen.add(id);
      panes.push(chat);
      if (panes.length >= 3) break;
    }
    return panes;
  }, [conversations, splitChatIds, selectedConversationId]);

  const sessionGroups = useMemo(() => {
    const taskByChat = new Map(projections.filter((item) => item.chatId).map((item) => [item.chatId as string, item]));
    const rows: OneSessionRow[] = conversations.map((chat) => ({
      kind: "chat" as const,
      key: chat.id,
      chat,
      task: taskByChat.get(chat.id) ?? null,
      sortAt: chat.updatedAt,
    }));
    /*
     * 작업은 **줄을 따로 세우지 않는다** (오너 결정 2026-08-24: "두 개 합치라").
     * 예전에는 대화 줄과 작업 줄이 각각 서서, 같은 일이 두 번 보이고 한쪽에는 이름 대신
     * "결과 확인" 같은 상태 문구가 붙었다. 작업은 그 대화의 상태일 뿐이므로 점으로만 쓴다.
     * 대화가 아직 없는 작업만(드물다) 한 줄을 얻는다.
     */
    for (const item of projections) {
      if (item.chatId) continue;
      rows.push({ kind: "task" as const, key: `task:${item.taskId}`, task: item, chat: null, sortAt: item.status.asOf });
    }
    rows.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
    // Messenger grammar: one uninterrupted latest-first list. Date buckets
    // make a room move between visual sections over time, so they stay out.
    return { rows };
  }, [conversations, projections]);
  const hasOtherSessionAttention = useMemo(() => {
    const pendingChatIds = new Set(
      confirmations
        .filter((item) => !isPendingConfirmationSnoozed(item))
        .map((item) => item.chatId),
    );
    const orgMembers = oneOrgState?.members ?? [];
    return sessionGroups.rows.some((row) => {
      if (row.chat?.id === activeThreadChatId || row.task?.taskId === selectedTaskId) return false;
      if (row.task && ["decision_required", "failed", "stopped"].includes(row.task.status.value)) return true;
      if (!row.chat) return false;
      if (pendingChatIds.has(row.chat.id) || directSessionUnavailable(row.chat, oneOrgState)) return true;
      if (orgMembers.some((member) => member.unreadCount > 0 && member.installedAgentId === row.chat?.agentId)) return true;
      const taskforce = taskforces.find((item) => item.chatId === row.chat?.id);
      return Boolean(taskforce?.memberAgentIds.some((agentId) => orgMembers.some((member) =>
        member.installedAgentId === agentId && (member.unreadCount > 0 || Boolean(member.archivedAt)))));
    });
  }, [activeThreadChatId, confirmations, oneOrgState, selectedTaskId, sessionGroups.rows, taskforces]);
  const activeThreadPromptFallback = selected?.display.title ?? conversation?.title ?? "";
  const activeTaskforce = useMemo(
    () => taskforces.find((taskforce) => taskforce.chatId === activeThreadChatId) ?? null,
    [activeThreadChatId, taskforces],
  );
  const taskforceEditing = useMemo(
    () => taskforceEditingId ? taskforces.find((taskforce) => taskforce.id === taskforceEditingId) ?? null : null,
    [taskforceEditingId, taskforces],
  );
  // 활성 세션의 좌석 1급 조회(SEAT-SESSION-PLAN-v2) — 해체(T7) 여부가 읽기 전용
  // 아카이브 배너·전송 대체 CTA 를 결정한다. 좌석이 없거나 조회가 실패하면 평소대로.
  const [activeSeat, setActiveSeat] = useState<OneSeatView | null>(null);
  useEffect(() => {
    const chatId = activeThreadChatId;
    const api = ipc();
    if (!chatId || !api?.seats?.forChat) { setActiveSeat(null); return; }
    let cancelled = false;
    void api.seats.forChat(chatId)
      .then((seat) => { if (!cancelled) setActiveSeat(seat); })
      .catch(() => { if (!cancelled) setActiveSeat(null); });
    return () => { cancelled = true; };
  }, [activeThreadChatId, taskforces]);
  const activeSeatDissolved = Boolean(activeSeat?.dissolvedAt);
  /*
   * 빈 자리(§4-2·T10). 담당 봇이 삭제되면 좌석은 남고 점유만 닫힌다 — 그때 화면이
   * 헤더를 "One"으로 그리면 **누구와 하는 대화인지 거짓말을 한다**(라이브 실측으로 잡음:
   * 삭제된 팀원의 방에 보낸 말에 One 이 조용히 답했다). 빈 자리는 빈 자리로 말하고,
   * 앉힐 사람을 그 자리에서 고르게 한다. 전송 자체는 막지 않는다(기획 §4-3).
   */
  const activeSeatEmpty = Boolean(activeSeat && !activeSeat.dissolvedAt && activeSeat.occupants.length === 0);
  const activeChatRecord = useMemo(
    () => conversations.find((chat) => chat.id === activeThreadChatId) ?? conversation ?? null,
    [activeThreadChatId, conversation, conversations],
  );
  const activeDirectSessionUnavailable = useMemo(() => {
    const chat = activeChatRecord;
    const sessionAgentId = chat ? directSessionAgentId(chat) : null;
    if (!chat || !sessionAgentId) return false;
    if (directSessionUnavailable(chat, oneOrgState)) return true;
    return Boolean(
      activeSeat
      && activeSeat.kind === "solo"
      && (
        activeSeat.occupants.length === 0
        || !activeSeat.occupants.some((occupant) => occupant.agentId === sessionAgentId)
      ),
    );
  }, [activeChatRecord, activeSeat, oneOrgState]);
  /** 이전 담당 이름 — 좌석 스냅샷(참여자)에서. 없으면 그 줄을 그리지 않는다(I9). */
  const previousOccupantName = useMemo(() => {
    if (!activeSeatEmpty) return null;
    const fromSnapshot = (activeChatRecord?.participants ?? [])
      .map((participant) => participant.displayName?.trim())
      .find((name) => Boolean(name));
    return fromSnapshot ?? activeChatRecord?.seatLabel?.trim() ?? null;
  }, [activeChatRecord, activeSeatEmpty]);
  const activeTaskforceAgentIds = useMemo(() => {
    if (!activeTaskforce) return [];
    const members = oneOrgState?.members ?? [];
    /*
     * ★좌석을 **설치본 id 하나로만** 찾으면 빌려온 좌석이 사라진다.
     *
     * 웹 One 에는 "이 기계에 설치된 것"이라는 개념이 없어 Hub 대여 좌석의
     * `installedAgentId` 가 방 명단의 값과 맞지 않는다. 그래서 그 좌석은 방에 멀쩡히
     * 앉아 있고 목록도 정상으로 돌아오는데 **"이번 턴" 지목 후보에서만 통째로
     * 빠졌다** — 돈 내고 빌린 자리에 부분 지목을 쓸 수 없었다(웹 실측 2026-08-26).
     *
     * 좌석의 정체는 하나가 아니다. 설치본 id · 좌석 id · 슬러그 중 무엇으로 불려도
     * 같은 좌석이다. 걸러 내려던 것(보관됨·잠김·실패)은 그대로 걸러진다.
     * 이 파일은 웹으로 그대로 복사되므로 수리는 여기(정본)에 둔다.
     */
    const byAnyId = new Map<string, typeof members[number]>();
    for (const member of members) {
      for (const key of [member.installedAgentId, member.id, member.agentSlug]) {
        if (typeof key === "string" && key && !byAnyId.has(key)) byAnyId.set(key, member);
      }
    }
    return activeTaskforce.memberAgentIds.filter((agentId) => {
      const member = byAnyId.get(agentId);
      return member && !member.archivedAt && member.statusKind !== "locked" && member.statusKind !== "failed";
    });
  }, [activeTaskforce, oneOrgState?.members]);
  const seededTaskforceChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededTaskforceChatRef.current !== activeThreadChatId) {
      seededTaskforceChatRef.current = activeThreadChatId;
      setTurnAgentIds(activeTaskforceAgentIds);
      return;
    }
    if (activeTaskforce) setTurnAgentIds(activeTaskforceAgentIds);
  }, [activeTaskforce, activeTaskforceAgentIds, activeThreadChatId, settleRun]);
  const activeOneMember = useMemo(() => {
    if (!activeThreadChat || activeThreadChat.originSurface !== "one") return null;
    return oneOrgState?.members.find((member) => member.installedAgentId === activeThreadChat.agentId) ?? null;
  }, [activeThreadChat, oneOrgState?.members]);
  const activeOneSelected = Boolean(
    activeThreadChat
      && activeThreadChat.originSurface === "one"
      && isOneOwnedSession(activeThreadChat, taskforces),
  );

  useEffect(() => {
    const api = ipc();
    if (!api || !activeThreadChatId) return;
    let cancelled = false;
    void api.workspace.get(activeThreadChatId).then((path) => {
      if (cancelled) return;
      setWorkspacePath(path);
      // A durable Main-owned path is sufficient for execution. A renderer grant
      // exists only for a newly picked folder and is never reconstructed from text.
      setWorkspaceGrant(null);
    }).catch(() => {
      if (!cancelled) setWorkspacePath(null);
    });
    return () => { cancelled = true; };
  }, [activeThreadChatId]);
  const runtimeArtifacts = activity.artifacts;
  // The open bit is persisted for convenience, but it is not conversation
  // state. Reset it at each thread boundary so an empty mobile conversation
  // cannot inherit an open, full-screen output rail from the previous thread.
  const outputRailScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (outputRailScopeRef.current === activeThreadChatId) return;
    outputRailScopeRef.current = activeThreadChatId;
    setContextRailOpen(false);
  }, [activeThreadChatId, setContextRailOpen]);

  const latestRuntimeArtifact = runtimeArtifacts.at(-1) ?? null;
  useEffect(() => {
    const bridge = typeof window === "undefined" ? null : window.agentlas;
    const chatId = activeThreadChatId;
    const surfaceId = surface?.manifestId;
    if (!bridge?.appFactory || !chatId || !surfaceId) {
      setOneLiveAppPreview(null);
      return;
    }

    let disposed = false;
    let refreshing = false;
    const startedPreviewAppIds = livePreviewAppIdsRef.current;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        // Read the raw Main bridge instead of ipc()'s 15-second cache. A newly
        // scaffolded app must appear in the One rail while the user is still
        // watching the same conversation.
        const apps = await bridge.appFactory.listApps(chatId);
        const app = apps.find((candidate) => (
          candidate.surfaceId === surfaceId && candidate.status !== "archived"
        ));
        if (!app) {
          if (!disposed) setOneLiveAppPreview(null);
          return;
        }
        const preview = await bridge.appFactory.startLivePreview({ appId: app.id });
        // 무엇을 켰는지 기억해 둔다 — 정리에서 그것만 끈다.
        startedPreviewAppIds.add(app.id);
        if (disposed) return;
        if (!preview.ok || !preview.url) {
          // Keep a currently reachable view during a transient registry or
          // filesystem read failure; clear only when the app identity changed.
          setOneLiveAppPreview((current) => current?.appId === app.id ? current : null);
          return;
        }
        const previewUrl = preview.url;
        setOneLiveAppPreview((current) => (
          current?.appId === app.id
            && current.url === previewUrl
            && current.title === app.appName
            && current.runtime === preview.runtime
            ? current
            : {
              appId: app.id,
              title: app.appName,
              url: previewUrl,
              runtime: preview.runtime,
            }
        ));
      } catch {
        // A polling tick is advisory. NativeLiveWebView owns the visible
        // failure state, so a temporary registry read must not blank the rail.
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, busy ? 1_200 : 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeThreadChatId, busy, surface?.manifestId]);
  /*
   * 미리보기 서버는 대화를 떠날 때 끈다.
   *
   * 처음에는 위 effect 의 정리에 붙였는데, 그 effect 가 busy 를 보고 있어서
   * 턴이 시작·종료할 때마다 서버가 닫히고 다음 실행이 새 포트로 새 서버를
   * 열었다 — 미리보기를 켜 둔 사람은 메시지마다 화면이 다시 떴다
   * (감사 2026-08-25). 서버가 필요 없어지는 때는 대화를 떠날 때이지 busy 가
   * 바뀔 때가 아니다.
   */
  useEffect(() => {
    const startedIds = livePreviewAppIdsRef.current;
    return () => {
      const bridge = typeof window === "undefined" ? null : window.agentlas;
      for (const appId of startedIds) {
        void bridge?.appFactory?.stopLivePreview?.({ appId }).catch(() => undefined);
      }
      startedIds.clear();
    };
  }, [activeThreadChatId]);

  const openOneLinkedFile = useCallback((file: LinkedFileArtifact) => {
    if (!activeThreadChatId) return;
    requestReadableContextRailWidth();
    const normalized = (file.path || file.paths?.[0] || file.href || file.name).replace(/\\/g, "/").toLowerCase();
    const matched = runtimeArtifacts.find((artifact) => {
      const label = artifact.label.replace(/\\/g, "/").toLowerCase();
      return label === file.name.toLowerCase()
        || normalized.endsWith(`/${label}`)
        || normalized === label;
    });
    if (matched) {
      requestOneArtifactOpen({ binding: matched.binding, label: matched.label });
      return;
    }
    // Keep an unbound link in the renderer. A future owner can adopt it into
    // the same Outputs rail; no OS-level open fallback is permitted.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("agentlas:in-app-linked-file", { detail: { ...file, chatId: activeThreadChatId } }));
    }
  }, [activeThreadChatId, requestReadableContextRailWidth, runtimeArtifacts]);
  const openOneChatFile = useCallback(async (file: ChatFileItem) => {
    setContextRailOpen(true);
    requestReadableContextRailWidth();
    const needsText = file.kind === "file"
      && ["markdown", "json", "text", "browser"].includes(file.viewer.viewerKind)
      && Boolean(file.fileUrl)
      && !file.viewer.content;
    if (!needsText) {
      requestChatFileOpen(file);
      return;
    }
    try {
      const response = await fetch(file.fileUrl!);
      if (!response.ok) throw new Error(`attachment read failed: ${response.status}`);
      requestChatFileOpen({
        ...file,
        viewer: { ...file.viewer, content: await response.text(), available: true, reason: undefined },
      });
    } catch {
      requestChatFileOpen({ ...file, viewer: { ...file.viewer, available: false } });
    }
  }, [requestReadableContextRailWidth, setContextRailOpen]);
  const oneOutputKind: OutputPresentationKind = useMemo(() => {
    if (oneLiveAppPreview) return "web";
    const surfaceKind = outputPresentationKindForManifest(surface);
    if (surfaceKind !== "standard") return surfaceKind;
    return outputPresentationKindForName(latestRuntimeArtifact?.label);
  }, [latestRuntimeArtifact?.label, oneLiveAppPreview, surface]);
  const terminalReceiptKey = receipt && receipt.status !== "running"
    ? `${receipt.runId}:${receipt.status}`
    : null;
  useEffect(() => {
    const api = ipc();
    if (!api) { setActiveThreadChat(conversation); return; }
    let cancelled = false;
    void Promise.all([
      api.runtime.detect(),
      activeThreadChatId ? api.chats.get(activeThreadChatId).catch(() => null) : Promise.resolve(null),
    ]).then(([runtimes, chat]) => {
      if (cancelled) return;
      setActiveThreadChat(chat);
      // A model chosen in One is a product preference, not disposable state on
      // the current route. Prefer a chat's durable override, then the last
      // explicit One choice, then the globally active runtime.
      const selection = chat?.runtimeSelection ?? readStoredOneRuntimeSelection();
      const matched = selection
        ? runtimes.find((runtime) => runtime.kind === selection.kind && (!selection.backend || runtime.backend === selection.backend))
        : runtimes.find((runtime) => runtime.active);
      setOneRuntime(matched ? withOneRuntimeSelection({
        ...matched,
        active: true,
        longContextEnabled: selection?.longContext ?? matched.longContextEnabled,
      }, selection?.model ?? matched.model ?? null, selection?.effort ?? (selection?.model ? undefined : matched.effort)) : null);
      setOneRuntimePinned(Boolean(selection));
      setOneRuntimeInventory(runtimes);
    }).catch(() => {
      if (!cancelled) {
        setActiveThreadChat(null);
        setOneRuntime(null);
        setOneRuntimePinned(false);
        setOneRuntimeInventory([]);
      }
    });
    return () => { cancelled = true; };
  }, [activeThreadChatId, conversation]);

  useEffect(() => {
    const api = ipc();
    if (!api || oneRuntimeInventory.length === 0) {
      setOneModelOptions([]);
      return;
    }
    let cancelled = false;
    void Promise.all(oneRuntimeInventory.map(async (runtime) => {
      const models = await api.runtime.listModels({
        kind: runtime.kind,
        backend: runtime.backend,
        availableModels: runtime.availableModels,
      });
      const provider = runtime.kind === "claude-code" ? "Claude"
        : runtime.kind === "codex" ? "Codex"
          : runtime.kind === "antigravity" ? "Antigravity"
            : runtime.kind === "grok" ? "Grok"
              : runtime.kind === "kimi" ? "Kimi"
                : runtime.label ?? (runtime.backend || runtime.kind);
      return models.map((model) => ({
        ...model,
        runtime,
        tag: model.tag ?? provider,
        // 벤더 로고. 모르는 벤더면 null 이고 화면이 기본 아이콘을 그린다.
        logo: llmLogoSrc({ model: model.id, backend: runtime.backend, kind: runtime.kind }),
      }));
    })).then((groups) => {
      if (!cancelled) setOneModelOptions(groups.flat());
    }).catch(() => {
      if (!cancelled) setOneModelOptions([]);
    });
    return () => { cancelled = true; };
  }, [oneRuntimeInventory]);

  useEffect(() => {
    if (!composerMenu) return;
    /*
     * ★닫으면 초점이 body 로 떨어졌다 (대화상자 실측 2026-09-08: 모델·추론 강도·권한 3개).
     *   작성창 바로 위의 메뉴라 닫은 뒤엔 원래 있던 자리로 돌아가야 한다 —
     *   안 그러면 키보드로는 문서 맨 위부터 다시 Tab 해야 한다.
     */
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-one-composer-popover], [data-one-composer-trigger]")) return;
      setComposerMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setComposerMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      if (opener && opener.isConnected && !opener.contains(document.activeElement)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [composerMenu]);
  useEffect(() => {
    // Switching threads drops the strip — unless this navigation is the fresh
    // submit landing on the chat it just created, whose steers are already
    // queued in Main behind the run that is starting.
    if (!activeThreadChatId || runChatIdRef.current !== activeThreadChatId) setQueuedSteers([]);
    if (homeTransitionPendingRef.current && composerDraftKeyRef.current === "new" && composerDraftKey !== "new") return;
    if (composerDraftKeyRef.current === composerDraftKey) return;
    const previousKey = composerDraftKeyRef.current;
    composerDraftKeyRef.current = composerDraftKey;
    const restored = readOneComposerDraft(composerDraftKey);
    // A fresh submit navigates from "new" to the chat it created while the
    // user may already be typing the next instruction into the same box.
    // Restoring that chat's (empty) draft erased what they typed (measured
    // 2026-08-16: text sent during "준비하는 중" vanished without a trace).
    // Carry in-progress text over instead of replacing it with nothing.
    const inProgress = composerInputRef.current?.value ?? "";
    const pendingCarry = pendingNewChatDraftCarryRef.current;
    const freshSubmitLanding = previousKey === "new"
      && Boolean(pendingCarry)
      && composerDraftKey === `chat:${pendingCarry?.chatId}`
      && pendingCarry?.navigationEpoch === navigationEpochRef.current;
    if (previousKey === "new") pendingNewChatDraftCarryRef.current = null;
    if (freshSubmitLanding && restored.composer.trim() === "" && inProgress.trim() !== "") {
      writeOneComposerDraft(composerDraftKey, { composer: inProgress });
      // The in-progress text now belongs to the exact chat that was just
      // created. Leaving the same text under `new` makes the next explicit New
      // action resurrect it as an unrelated draft.
      writeOneComposerDraft("new", { composer: "", stagedSteer: null });
      setComposerState(inProgress);
    } else {
      setComposerState(restored.composer);
    }
    setStagedSteerState(null);
  }, [activeThreadChatId, composerDraftKey]);
  // Main starts a queued steer only after the active model turn settles. Attach
  // to that replacement run immediately so the user never has to leave and
  // reopen One to see continued progress.
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    const chatId = activeThreadChatId;
    if (!api || !events || !chatId) return;
    let idleCheck: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = events.onActiveChats((chatIds) => {
      if (idleCheck) { clearTimeout(idleCheck); idleCheck = null; }
      if (!chatIds.includes(chatId)) {
        /*
         * ★ 실시간이 안 왔는데 서버는 끝났다고 한다 (2026-08-24 프로덕션 실측).
         *
         * 웹은 실행마다 새 실시간 연결을 연다. 그 연결이 안 열리면 답이 만들어지고
         * 크레딧까지 나갔는데도 **화면에는 아무것도 안 온다** — 새로고침해야만 보였다.
         * 데스크탑 앱은 항상 연결된 통로를 써서 이 일이 없다.
         *
         * 실시간을 고치는 것과 별개로, **답을 놓치는 길은 막아 둔다.** 서버가 그 대화에
         * 도는 실행이 없다고 하면, 우리가 기다리던 실행은 이미 끝난 것이다. 그때 평소
         * 완료 때와 같은 경로로 대화를 다시 받아 온다.
         *
         * 곧바로 하지 않고 잠깐 기다리는 이유: 진짜 완료 신호가 오는 중일 수 있다.
         * 그 사이에 도착하면 이 자리는 아무것도 하지 않는다.
         */
        if (runIdRef.current) {
          const missedRunId = runIdRef.current;
          const missedTaskId = runTaskIdRef.current;
          idleCheck = setTimeout(() => {
            idleCheck = null;
            if (runIdRef.current !== missedRunId || runChatIdRef.current !== chatId) return;
            if (cancelNoticeRunIdRef.current === missedRunId) {
              const notice = cancelNoticeTextRef.current;
              cancelNoticeRunIdRef.current = null;
              cancelNoticeTextRef.current = null;
              setActionNotice((current) => current === notice ? null : current);
            }
            runIdRef.current = null;
            setBusy(false);
            unsubscribeRunRef.current?.();
            unsubscribeRunRef.current = null;
            void settleRun(chatId, missedTaskId, missedRunId);
          }, 2_000);
          return;
        }

        // The chat went idle. Main starts a queued direction a microtask after
        // settlement, so a queue that is still shown once the chat has been
        // idle for a moment has no run behind it (stop cleared it, or the
        // start failed) — drop it rather than show a "next" that never comes.
        if (!runIdRef.current) {
          idleCheck = setTimeout(() => {
            idleCheck = null;
            if (runIdRef.current || runChatIdRef.current !== chatId) return;
            void api.invoke.activeChats().then((active) => {
              if (!active.includes(chatId) && !runIdRef.current) setQueuedSteers([]);
            }).catch(() => undefined);
          }, 1_500);
        }
        return;
      }
      if (runIdRef.current) return;
      void api.invoke.attach(chatId).then((attachment) => {
        if (!attachment || runIdRef.current || runChatIdRef.current !== chatId) return;
        runIdRef.current = attachment.runId;
        activityRunIdRef.current = attachment.runId;
        activityEventRunIdRef.current = null;
        setActivityStateRunId(null);
        runTaskIdRef.current = selected?.taskId ?? null;
        setBusy(true);
        setActivity(initialOneActivityState());
        setRunStartedAt(attachment.startedAt ? Date.parse(attachment.startedAt) : Date.now());
        // The queued instruction is now the model's turn: it leaves the queue
        // strip and enters the conversation as the prompt of this run.
        setQueuedSteers((current) => {
          const started = current[0];
          if (started) {
            setMessages((messages) => messages.some((message) => message.id === started.id)
              ? messages
              : [
                ...messages.filter((message) => message.id !== "one-live-response"),
                { id: started.id, role: "user" as const, text: started.text, createdAt: attachment.startedAt ?? new Date().toISOString() },
              ]);
          }
          return current.slice(1);
        });
        subscribeRun(attachment.runId);
        for (const event of attachment.events) consumeRunEventRef.current(event, attachment.runId);
      }).catch(() => undefined);
    });
    return () => {
      if (idleCheck) clearTimeout(idleCheck);
      unsubscribe();
    };
  }, [activeThreadChatId, appLocale, selected?.taskId, subscribeRun]);

  // The event channel is the fast path, but a renderer reload can miss both a
  // terminal event and the following active-chat broadcast. Main remains the
  // execution authority, so reconcile this projection while it says busy
  // rather than leaving an already-settled run looking alive forever.
  useEffect(() => {
    if (!busy) return;
    const api = ipc();
    const chatId = runChatIdRef.current;
    const expectedRunId = runIdRef.current;
    if (!api || !chatId || !expectedRunId) return;
    let cancelled = false;
    const reconcile = async () => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const activeChatIds = await api.invoke.activeChats();
        if (
          cancelled
          || runIdRef.current !== expectedRunId
          || activeChatIds.includes(chatId)
        ) return;
        // Main has already settled this chat. Clear only this run's renderer
        // projection, then reload the durable transcript/task receipt.
        runIdRef.current = null;
        streamTextRef.current = "";
        unsubscribeRunRef.current?.();
        unsubscribeRunRef.current = null;
        setBusy(false);
        setKeyRequestSheet(null);
        if (cancelNoticeRunIdRef.current === expectedRunId) {
          const notice = cancelNoticeTextRef.current;
          cancelNoticeRunIdRef.current = null;
          cancelNoticeTextRef.current = null;
          setActionNotice((current) => current === notice ? null : current);
        }
        void settleRun(chatId, runTaskIdRef.current, expectedRunId);
      } catch {
        // This is a recovery safety net. Preserve the visible run and retry on
        // the next tick when Main is temporarily unavailable.
      }
    };
    const first = window.setTimeout(reconcile, 700);
    const interval = window.setInterval(reconcile, 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [busy, settleRun]);

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api || !activeThreadChatId) {
      setTeamPreflight(null);
      setPendingTeamPrompt(null);
      return;
    }
    void api.oneTeamPreflight.getForChat(activeThreadChatId)
      .then(async (proposal) => {
        if (cancelled) return;
        const teamAttachments = proposal
          ? await api.oneAttachments.forTeam(proposal.proposalId).catch(() => null)
          : null;
        if (cancelled) return;
        setTeamPreflight(proposal);
        setPendingTeamPrompt((current) => (
          proposal && current?.proposalId === proposal.proposalId
            ? current
            : proposal
              ? {
                  proposalId: proposal.proposalId,
                  text: activeThreadPromptFallback || proposal.goalSummary,
                  attachments: teamAttachments,
                  recurrence: null,
                  overrides: {},
                  taskForceTargets: [],
                }
              : null
        ));
        if (proposal && isOneTeamPreflightPendingStatus(proposal.status)) {
          const visiblePrompt = activeThreadPromptFallback || proposal.goalSummary;
          setMessages((current) => current.length > 0
            ? current
            : [{ id: `team-request:${proposal.proposalId}`, role: "user", text: visiblePrompt }]);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setTeamPreflight(null);
          setPendingTeamPrompt(null);
          setError(null);
          requestOneOperationalRecovery("one-team-preflight-load", cause);
        }
      });
    return () => { cancelled = true; };
  }, [activeThreadChatId, activeThreadPromptFallback]);

  const oneMemoryUseOnceTarget = useMemo<OneMemoryUseOnceTarget | null>(() => {
    if (selected?.chatId) {
      return {
        chatId: selected.chatId,
        expectedTaskId: selected.taskId,
        expectedTaskVersion: selected.canonicalVersion,
      };
    }
    if (conversation) {
      return {
        chatId: conversation.id,
        expectedTaskId: null,
        expectedTaskVersion: null,
      };
    }
    return null;
  }, [conversation, selected]);
  const oneMemoryUseOnceTargetKeyValue = oneMemoryUseOnceTarget
    ? oneMemoryUseOnceTargetKey(oneMemoryUseOnceTarget)
    : null;

  useEffect(() => {
    setArmedOneMemoryUseOnce((current) => (
      current && current.targetKey !== oneMemoryUseOnceTargetKeyValue ? null : current
    ));
  }, [oneMemoryUseOnceTargetKeyValue]);

  useEffect(() => {
    if (!armedOneMemoryUseOnce) return;
    const remaining = Date.parse(armedOneMemoryUseOnce.receipt.expiresAt) - Date.now();
    if (remaining <= 0) {
      setArmedOneMemoryUseOnce(null);
      return;
    }
    const timer = window.setTimeout(() => setArmedOneMemoryUseOnce((current) => (
      current?.receipt.receiptId === armedOneMemoryUseOnce.receipt.receiptId ? null : current
    )), remaining);
    return () => window.clearTimeout(timer);
  }, [armedOneMemoryUseOnce]);

  const oneRuntimeSelection = useMemo<RuntimeSelection | undefined>(() => {
    if (!oneRuntime || !oneRuntimePinned) return undefined;
    return {
      kind: oneRuntime.kind,
      backend: oneRuntime.backend,
      model: oneRuntime.model ?? undefined,
      effort: oneRuntime.effort ?? undefined,
      longContext: oneRuntime.kind === "byok" ? oneRuntime.longContextEnabled ?? false : undefined,
      role: "orchestrator",
      inherit: false,
    };
  }, [oneRuntime, oneRuntimePinned]);

  const applyOneRuntimeSelection = useCallback(async (patch: { model?: string; effort?: string }, runtimeOverride?: RuntimeStatus) => {
    const baseRuntime = runtimeOverride ?? oneRuntime;
    if (!baseRuntime) return;
    const nextModel = patch.model !== undefined ? patch.model || null : baseRuntime.model ?? null;
    const requestedEffort = patch.effort !== undefined
      ? patch.effort || null
      : patch.model !== undefined
        ? undefined
        : baseRuntime.effort;
    const nextRuntime = withOneRuntimeSelection(baseRuntime, nextModel, requestedEffort);
    const selection: RuntimeSelection = {
      kind: nextRuntime.kind,
      backend: nextRuntime.backend,
      model: nextRuntime.model ?? undefined,
      effort: nextRuntime.effort ?? undefined,
      longContext: nextRuntime.kind === "byok" ? nextRuntime.longContextEnabled ?? false : undefined,
      role: "orchestrator",
      inherit: false,
    };
    const api = ipc();
    let acknowledgedSelection = selection;
    let acknowledgedRuntime = nextRuntime;
    if (activeThreadChatId) {
      if (!api) {
        setActionNotice(appLocale === "ko"
          ? "Desktop에 연결되지 않아 모델 선택을 저장하지 못했습니다. 기존 선택을 유지합니다."
          : "The model selection was not saved because Desktop is unavailable. The previous selection is unchanged.");
        return;
      }
      try {
        const updated = await api.chats.setRuntimeSelection(activeThreadChatId, selection);
        const receipt = updated?.runtimeSelection;
        if (
          !updated
          || updated.id !== activeThreadChatId
          || !runtimeSelectionReceiptMatches(selection, receipt)
        ) {
          throw new Error("Desktop did not acknowledge the exact chat runtime selection");
        }
        const receiptRuntime = oneRuntimeInventory.find((runtime) => (
          runtime.kind === receipt.kind
          && (!receipt.backend || runtime.backend === receipt.backend)
        ));
        if (!receiptRuntime) throw new Error("Desktop acknowledged an unavailable runtime selection");
        acknowledgedSelection = receipt;
        acknowledgedRuntime = withOneRuntimeSelection(
          { ...receiptRuntime, active: true },
          receipt.model ?? receiptRuntime.model ?? null,
          receipt.effort ?? (receipt.model ? undefined : receiptRuntime.effort),
        );
        setActiveThreadChat(updated);
      } catch {
        setActionNotice(appLocale === "ko"
          ? "이 대화의 모델 선택을 저장하지 못했습니다. 기존 선택을 유지한 채 다시 시도해 주세요."
          : "The model selection was not saved for this conversation. The previous selection is unchanged; try again.");
        return;
      }
    }
    setOneRuntime(acknowledgedRuntime);
    setOneRuntimePinned(true);
    writeStoredOneRuntimeSelection(acknowledgedSelection);
    setComposerMenu(null);
    setActionNotice(null);
  }, [activeThreadChatId, appLocale, oneRuntime, oneRuntimeInventory]);

  // 실행 타깃 결정: 좌석(설치행)이 call-only Hub 자산이면 로컬 프롬프트 실행이 아니라
  // Hub borrow 경로로 보낸다({source:"hub", slug}) — 로컬 프롬프트가 없으므로 local 타깃은
  // 빈 지시문 실행이 되어 항상 오답이다. 그 외에는 기존과 동일하게 local 타깃.
  const orchestrationTargetForAgentId = useCallback((agentId: string): OrchestrationTarget => {
    const agent = availableAgents.find((item) => item.id === agentId);
    if (agent && isCallOnlyHubAgent(agent)) {
      return { source: "hub", entityKind: agent.kind === "team" ? "team" : "agent", slug: agent.slug };
    }
    return { source: "local", entityKind: "agent", agentId };
  }, [availableAgents]);

  const startRun = useCallback(async (
    chatId: string,
    taskId: string | null,
    taskVersion: number | null,
    text: string,
    taskIntent: "task" | "conversation",
    options?: {
      runId?: string;
      teamRef?: OneTeamPreflightRef;
      attachments?: PreparedOneAttachments | null;
      recurrence?: OneRecurrenceSelectionV1 | null;
      overrides?: OneTurnOverrides;
      taskForceTargets?: OrchestrationTarget[];
      userAlreadyShown?: boolean;
      displayUserMessage?: boolean;
      /** Marks a prompt One authored on the user's behalf. Main records it as a
       *  system turn so the conversation never quotes our wording as theirs. */
      promptOrigin?: "system";
      /** A continuation inherits the last run's durable effective authority.
       * This prevents an Auto conversation from widening to write merely
       * because answering its question materializes a Task. */
      permissionMode?: OnePermissionMode;
      /** Exact chat pin receipt for a freshly-created conversation. */
      runtimeSelection?: RuntimeSelection;
    },
  ) => {
    const api = ipc();
    const events = ipcEvents();
    const runLocale = normalizedLocale;
    const effectiveRuntimeSelection = options?.runtimeSelection ?? oneRuntimeSelection;
    if (!api || !events) throw new Error(tFor(runLocale, "one.shell.run.desktop_unavailable"));
    // A Taskforce is the conversation's durable roster, not a one-turn
    // composer decoration. Decision answers, clarification turns, and recovery
    // continuations do not carry the composer's explicit target snapshot, so
    // rehydrate the current eligible roster from the exact Taskforce chat.
    // An explicitly supplied empty array still means "One only for this turn".
    const effectiveTaskForceTargets: OrchestrationTarget[] = options?.taskForceTargets !== undefined
      ? options.taskForceTargets
      : (() => {
          const taskforce = taskforces.find((item) => item.chatId === chatId);
          if (!taskforce) return [];
          const memberByAgentId = new Map((oneOrgState?.members ?? []).map((member) => [member.installedAgentId, member]));
          return taskforce.memberAgentIds
            .filter((agentId) => {
              const member = memberByAgentId.get(agentId);
              return member && !member.archivedAt && member.statusKind !== "locked" && member.statusKind !== "failed";
            })
            .map((agentId) => orchestrationTargetForAgentId(agentId));
        })();
    const runId = options?.runId ?? uid();
    runIdRef.current = runId;
    activityRunIdRef.current = runId;
    // Do not mark the optimistic row as an observed runtime event. Until this
    // run delivers its own lifecycle event, the view must keep rendering the
    // fresh dispatch rather than a late prior-run receipt.
    activityEventRunIdRef.current = null;
    runTaskIdRef.current = taskId;
    runChatIdRef.current = chatId;
    activityChatIdRef.current = chatId;
    dispatchRunPromptRef.current = { runId, text };
    streamTextRef.current = "";
    // A turn the person authored is a fresh goal: it restores the full recovery
    // budget. One's own continuation prompts keep spending the current one.
    if (!options?.promptOrigin) {
      const state = autoRecoveryRef.current;
      state.chatId = chatId;
      state.goal = text;
      state.originalRunId = runId;
      state.recoveryRunId = null;
      state.attemptsSpent = 0;
      state.previousFingerprint = null;
      setAutoRecovery(null);
    }
    let runPermissionMode = options?.permissionMode ?? onePermission;
    if (!options?.permissionMode && options?.promptOrigin === "system") {
      // Automatic retry, clarification, and recovery are continuations, not a
      // fresh user grant. Re-read Main's durable receipt and fail closed if it
      // is unavailable so Task promotion can never widen read to write.
      const sourceReceipt = await api.invoke.latestReceipt(chatId).catch(() => null);
      runPermissionMode = sourceReceipt?.executionPermission ?? "read";
    }
    const executionPermission = runPermissionMode === "auto"
      ? taskIntent === "task" ? "write" : "read"
      : runPermissionMode;
    const optimisticStartedAt = Date.now();
    activeRunStartedAtRef.current = optimisticStartedAt;
    // 새 실행이 시작되면 활동 표시는 그 실행 하나만 말한다. 지난 실행의 결과 영수증과
    // 런타임 피드백(생성 파일·이미지 레일 포함)을 남겨 두면, One의 활동 화면이 "지금
    // 무슨 일이 일어나는 중인지"가 아니라 지난 실행의 잔해를 함께 보여 준다. 스레드
    // 전환(위 useEffect)은 이미 같은 리셋을 하고 있었고, 실행 경계에만 빠져 있었다.
    const freshActivity = beginOneActivityState({
      observedAt: new Date(optimisticStartedAt).toISOString(),
      selectedPermissionMode: runPermissionMode,
      effectivePermission: executionPermission,
    });
    cacheOneActivity(chatId, freshActivity);
    // A run often starts after async preflight. Commit its user turn and blank
    // Activity before crossing IPC, so the previous answer can never linger
    // with a falsely running Activity while Main accepts the new request.
    flushSync(() => {
      setPreflightPrompt(null);
      setActivityStateRunId(null);
      setLiveRunPrompt({ runId, text });
      setDispatchRunPrompt({ runId, text });
      setBusy(true);
      setRunStartedAt(optimisticStartedAt);
      setSurface(null);
      setReceipt(null);
      setActivity(freshActivity);
      setError(null);
      setMessages((current) => {
        const withoutLive = current.filter((item) => item.id !== "one-live-response");
        const userAlreadyVisible = options?.userAlreadyShown
          && withoutLive.some((item) => item.role === "user" && item.text === text);
        return [
          ...withoutLive,
          ...(userAlreadyVisible || options?.displayUserMessage === false
            ? []
            : [{ id: uid(), role: "user" as const, text, createdAt: new Date().toISOString() }]),
          { id: "one-live-response", role: "assistant" as const, text: "", streaming: true },
        ];
      });
    });
    scrollToLatest();
    subscribeRun(runId);
    const targetKey = oneMemoryUseOnceTargetKey({
      chatId,
      expectedTaskId: taskId,
      expectedTaskVersion: taskVersion,
    });
    const attachedOneMemoryUseOnce = !options?.teamRef && armedOneMemoryUseOnce?.targetKey === targetKey
      ? armedOneMemoryUseOnce.receipt
      : null;
    try {
      await api.invoke.run({
        runId,
        chatId,
        userPrompt: text,
        ...(options?.promptOrigin ? { promptOrigin: options.promptOrigin } : {}),
        taskIntent,
        oneMode: true,
        ...(options?.teamRef ? { oneTeamPreflightRef: options.teamRef } : {}),
        ...(options?.attachments ? { oneAttachmentRef: options.attachments.ref } : {}),
        ...(options?.recurrence ? { oneRecurrenceSelection: options.recurrence } : {}),
        ...(effectiveTaskForceTargets.length ? { taskForceTargets: effectiveTaskForceTargets } : {}),
        ...(attachedOneMemoryUseOnce ? {
          oneMemoryUseOnceRef: {
            contractVersion: attachedOneMemoryUseOnce.contractVersion,
            receiptId: attachedOneMemoryUseOnce.receiptId,
          },
        } : {}),
        locale: runLocale,
        onePermissionMode: runPermissionMode,
        permissions: executionPermission,
        ...(effectiveRuntimeSelection ? { runtimeSelection: effectiveRuntimeSelection } : {}),
        ...(options?.overrides && currentOneGoalOverride(options.overrides, goalControlEpochRef.current).goalMode ? { goalMode: true } : {}),
        ...(options?.overrides?.planMode ? { planMode: true } : {}),
        ...(options?.overrides?.sessionRouting ? { sessionRouting: true } : { sessionRouting: false }),
        ...(options?.overrides?.fastMode ? { fastMode: true } : {}),
      });
      if (options?.teamRef) {
        setTeamPreflight(await api.oneTeamPreflight.getForChat(chatId).catch(() => null));
        setPendingTeamPrompt(null);
      }
      // Instructions typed during preparation become steers of this run now.
      const pendingSteers = pendingSteersRef.current;
      pendingSteersRef.current = [];
      for (const pending of pendingSteers) {
        try {
          await api.invoke.steer({
            chatId,
            userPrompt: pending.text,
            taskIntent,
            oneMode: true,
            locale: runLocale,
            onePermissionMode: runPermissionMode,
            permissions: executionPermission,
            ...(effectiveRuntimeSelection ? { runtimeSelection: effectiveRuntimeSelection } : {}),
            sessionRouting: false,
          });
        } catch (cause) {
          setQueuedSteers((current) => current.filter((item) => item.id !== pending.id));
          setComposer((current) => current ? `${current}\n${pending.text}` : pending.text);
          requestOneOperationalRecovery("one-steer", cause);
        }
      }
      await refreshAll();
    } catch (cause) {
      if (options?.teamRef) {
        const failed = await api.oneTeamPreflight.failStart(options.teamRef).catch(() => null);
        if (failed) setTeamPreflight(failed);
      }
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      if (cancelNoticeRunIdRef.current === runId) {
        const notice = cancelNoticeTextRef.current;
        cancelNoticeRunIdRef.current = null;
        cancelNoticeTextRef.current = null;
        setActionNotice((current) => current === notice ? null : current);
      }
      runIdRef.current = null;
      setLiveRunPrompt((current) => current?.runId === runId ? null : current);
      setDispatchRunPrompt((current) => current?.runId === runId ? null : current);
      if (dispatchRunPromptRef.current?.runId === runId) dispatchRunPromptRef.current = null;
      activeRunStartedAtRef.current = null;
      if (activityRunIdRef.current === runId) activityRunIdRef.current = null;
      setBusy(false);
      setActivity((current) => {
        const failed = reduceOneActivity(current, {
          kind: "error",
          observedAt: new Date().toISOString(),
          error: { code: "invoke_start_failed", message: "Run did not start." },
        });
        cacheOneActivity(chatId, failed);
        return failed;
      });
      // Main owns the failed receipt and recovery evidence. Keep the unfinished
      // run out of the transcript; refreshAll lets the automatic recovery loop
      // judge and resume it.
      setError(null);
      if (options?.attachments) {
        await api.oneAttachments.discard({ ref: options.attachments.ref }).catch(() => ({ discarded: false }));
      }
      /*
       * ★실행이 시작되지 않았는데 **쓴 글이 사라지고 아무 말도 없었다**
       *   (보내기 실패 실측 2026-09-08). 화면은 처음 화면으로 돌아가 있어서
       *   사용자는 자기 글이 어디로 갔는지 알 방법이 없었다.
       *   Work 는 같은 상황에서 글을 작성창에 되돌리고 이유를 말한다. 맞춘다.
       */
      setComposer((current) => (current.trim() ? current : text));
      /*
       * ★한 번만 되돌리면 지워진다: 실패 직후 화면이 방금 만든 대화(또는 홈)로
       *   옮겨가고, 그 순간 초안 복원 효과가 **빈 초안**을 덮어쓴다(실측 2026-09-08:
       *   되돌려 놓아도 입력창이 계속 비어 있었다). 자리 이동이 끝난 뒤 한 번 더 본다 —
       *   그 사이 사용자가 새로 쓰기 시작했으면 건드리지 않는다.
       */
      window.setTimeout(() => {
        setComposer((current) => (current.trim() ? current : text));
      }, 320);
      setActionNotice(normalizedLocale === "ko"
        ? "작업을 시작하지 못했습니다. 쓰신 글은 작성창에 되돌려 놓았습니다 — 다시 보내 주세요."
        : "The run did not start. Your text is back in the composer — send it again.");
      await refreshAll();
      requestOneOperationalRecovery("one-run-start", cause);
    } finally {
      if (attachedOneMemoryUseOnce) {
        // One Main consumes on accepted start. A rejected start is also a
        // single attempt from this UI; it is never attached automatically again.
        setArmedOneMemoryUseOnce((current) => (
          current?.receipt.receiptId === attachedOneMemoryUseOnce.receiptId ? null : current
        ));
      }
    }
  }, [armedOneMemoryUseOnce, normalizedLocale, oneOrgState?.members, onePermission, oneRuntimeSelection, orchestrationTargetForAgentId, refreshAll, scrollToLatest, subscribeRun, taskforces]);

  const autoStartTeamPreflight = useCallback(async (
    proposal: OneTeamPreflightProposal,
    prompt: PendingTeamPrompt,
    userAlreadyShown: boolean,
  ) => {
    const api = ipc();
    if (autoResolvingProposalRef.current === proposal.proposalId || runIdRef.current) return;
    if (!api) {
      requestOneOperationalRecovery("one-team-preflight-start", new Error("Desktop bridge unavailable"));
      return;
    }
    autoResolvingProposalRef.current = proposal.proposalId;
    setRunStartedAt(Date.now());
    setActivity(initialOneActivityState());
    setTeamPreflightBusy(true);
    setError(null);
    try {
      const result = await api.oneTeamPreflight.autoResolve({
        proposalId: proposal.proposalId,
        expectedProposalVersion: proposal.version,
        requestedRunId: uid(),
      });
      setTeamPreflight(result.proposal);
      if (result.kind !== "reserved") {
        throw new Error("One could not reserve the work safely");
      }
      selectedTaskIdRef.current = proposal.binding.taskId;
      selectedConversationIdRef.current = null;
      router.replace(`/one?task=${encodeURIComponent(proposal.binding.taskId)}`);
      await startRun(
        proposal.binding.chatId,
        proposal.binding.taskId,
        proposal.binding.taskVersion,
        prompt.text,
        "task",
        {
          runId: result.ref.reservedRunId,
          teamRef: result.ref,
          attachments: prompt.attachments,
          recurrence: prompt.recurrence,
          overrides: prompt.overrides,
          taskForceTargets: prompt.taskForceTargets,
          runtimeSelection: prompt.runtimeSelection,
          userAlreadyShown,
          displayUserMessage: userAlreadyShown,
        },
      );
      setTeamPreflight(await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => result.proposal));
    } catch (cause) {
      const current = await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => null);
      if (current) setTeamPreflight(current);
      setError(null);
      requestOneOperationalRecovery("one-team-preflight-start", cause);
    } finally {
      if (autoResolvingProposalRef.current === proposal.proposalId) autoResolvingProposalRef.current = null;
      setTeamPreflightBusy(false);
    }
  }, [router, startRun]);

  /*
   * Bringing in outside help can borrow paid Hub agents, so it is the one
   * decision One must not make for the user. Everything behind it already
   * exists — Main runs `confirmed_external_workforce` end to end — but nothing
   * ever asked, so the automatic path quietly continued alone instead and an
   * explicit request dead-ended as `one-team-preflight-required`.
   *
   * Hold the automatic start here and let the user answer in plain language.
   * Every other case keeps its existing behavior.
   */
  const answerWorkforceConsent = useCallback(async (accepted: boolean) => {
    const api = ipc();
    const proposal = teamPreflight;
    /*
     * 예전에는 세 조건 중 하나만 없어도 조용히 돌아갔다. 카드는 서버가 들고
     * 있는 제안 상태로 뜨는데 누를 근거(pendingTeamPrompt)는 이 화면의 메모리에만
     * 있어서, 새로고침하거나 다른 대화를 다녀오면 "아무리 눌러도 무반응" 이
     * 됐다(오너 지적 2026-08-24). 낼 수 있는 카드에는 누를 길이 있어야 한다.
     */
    if (!proposal) return;
    if (runIdRef.current) {
      setError(appLocale === "ko"
        ? "지금 실행 중이라 팀을 바꿀 수 없어요. 끝난 뒤에 다시 눌러 주세요."
        : "A run is in progress, so the team cannot change yet. Try again when it finishes.");
      return;
    }
    // 이 제안을 만든 말은 이 대화의 마지막 내 말이다. 화면 메모리가 비었어도
    // 거기서 되찾는다. 어긋나면 Main 이 promptDigest 로 거절하므로 조용히
    // 엉뚱한 말이 실행되지는 않는다.
    const recoveredText = pendingTeamPrompt?.text
      ?? [...visibleMessages].reverse().find((item) => item.role === "user" && (item.text ?? "").trim())?.text
      ?? null;
    if (!recoveredText) {
      setError(appLocale === "ko"
        ? "어떤 말에 대한 제안인지 찾지 못했어요. 하려던 말을 다시 보내 주세요."
        : "The message behind this proposal could not be found. Send it again.");
      return;
    }
    const prompt: PendingTeamPrompt = pendingTeamPrompt ?? {
      proposalId: proposal.proposalId,
      text: recoveredText,
      attachments: null,
      recurrence: null,
      overrides: {},
      taskForceTargets: [],
      runtimeSelection: oneRuntimeSelection,
    };
    if (!api) {
      requestOneOperationalRecovery("one-team-preflight-consent", new Error("Desktop bridge unavailable"));
      return;
    }
    setTeamPreflightBusy(true);
    setError(null);
    try {
      const runId = uid();
      const result = await api.oneTeamPreflight.resolve({
        proposalId: proposal.proposalId,
        expectedProposalVersion: proposal.version,
        resolution: accepted ? "confirm_workforce" : "continue_solo",
        requestedRunId: runId,
        confirmedByUser: true,
      });
      setTeamPreflight(result.proposal);
      if (result.kind !== "reserved") throw new Error("One could not reserve the work safely");
      selectedTaskIdRef.current = proposal.binding.taskId;
      selectedConversationIdRef.current = null;
      router.replace(`/one?task=${encodeURIComponent(proposal.binding.taskId)}`);
      await startRun(
        proposal.binding.chatId,
        proposal.binding.taskId,
        proposal.binding.taskVersion,
        prompt.text,
        "task",
        {
          runId: result.ref.reservedRunId,
          teamRef: result.ref,
          attachments: prompt.attachments,
          recurrence: prompt.recurrence,
          overrides: prompt.overrides,
          taskForceTargets: prompt.taskForceTargets,
          runtimeSelection: prompt.runtimeSelection,
          userAlreadyShown: true,
          displayUserMessage: true,
        },
      );
      setTeamPreflight(await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => result.proposal));
    } catch (cause) {
      const current = await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => null);
      if (current) setTeamPreflight(current);
      setError(null);
      requestOneOperationalRecovery("one-team-preflight-consent", cause);
    } finally {
      setTeamPreflightBusy(false);
    }
  }, [oneRuntimeSelection, pendingTeamPrompt, router, startRun, teamPreflight]);

  const awaitingWorkforceConsent = Boolean(
    teamPreflight
    && pendingTeamPrompt
    && pendingTeamPrompt.proposalId === teamPreflight.proposalId
    && teamPreflight.canConfirmWorkforce
    && ["proposed", "blocked", "deferred"].includes(teamPreflight.status),
  );
  useEffect(() => {
    if (
      !teamPreflight
      || !pendingTeamPrompt
      || pendingTeamPrompt.proposalId !== teamPreflight.proposalId
      || !["proposed", "blocked", "deferred", "team_reserved", "workforce_reserved", "solo_reserved"].includes(teamPreflight.status)
      || busy
      || awaitingWorkforceConsent
    ) return;
    void autoStartTeamPreflight(teamPreflight, pendingTeamPrompt, true);
  }, [autoStartTeamPreflight, awaitingWorkforceConsent, busy, pendingTeamPrompt, teamPreflight]);

  useEffect(() => {
    if (!teamPreflight) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [teamPreflight]);

  const resolveActivationConcern = useCallback(async (chatId: string) => {
    const api = ipc();
    let current = oneActivationState;
    if (
      !api?.oneActivation
      || !current
      || current.status !== "active"
      || current.concern.status !== "pending"
    ) return;
    try {
      current = await api.oneActivation.resolveConcern({
        expectedStoreVersion: current.version,
        originChatId: chatId,
        confirmedByUser: true,
      });
    } catch (cause) {
      requestOneOperationalRecovery("one-activation-concern", cause);
      const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null);
      if (!latest) return;
      current = latest;
      if (current.status === "active" && current.concern.status === "pending") {
        current = await api.oneActivation.resolveConcern({
          expectedStoreVersion: current.version,
          originChatId: chatId,
          confirmedByUser: true,
        }).catch((retryCause) => {
          requestOneOperationalRecovery("one-activation-concern", retryCause);
          return current;
        });
      }
    }
    setOneActivationState(current);
  }, [appLocale, oneActivationState]);

  const submit = useCallback(async (text: string) => {
    const attachmentSnapshot = attachmentDraftsRef.current.slice();
    // Repetition is configured in One's automation surface, not in the chat
    // composer. Keeping a third scheduling sheet here duplicated that product
    // boundary and made the composer feel like a form.
    const recurrenceSnapshot: OneRecurrenceSelectionV1 | null = null;
    const overrideSnapshot = { ...turnOverrides, goalControlEpoch: goalControlEpochRef.current };
    const taskForceTargetSnapshot: OrchestrationTarget[] = turnAgentIds.map((agentId) => orchestrationTargetForAgentId(agentId));
    const explicitValue = text.trim();
    if (!explicitValue && attachmentSnapshot.length === 0) return;
    const graphRequest = oneGraphRequest(explicitValue);
    if (graphRequest !== null && !graphRequest) {
      setComposer("@graph ");
      return;
    }
    if (graphRequest !== null && attachmentSnapshot.length > 0) {
      setAttachmentError(appLocale === "ko"
        ? "@graph 명령은 먼저 텍스트로 시작해 주세요. 파일은 다음 대화에서 붙일 수 있습니다."
        : "Start @graph with text first. You can attach files in the next message.");
      return;
    }
    // A Graph interview is a local chat surface backed by the Work Graph
    // engine. It must not become a steer for an unrelated running model turn.
    if (graphRequest !== null && (teamPreflightBusy || busy)) return;
    if (teamPreflightBusy) {
      // The previous submit is still preparing its run. Queue this one behind
      // it (flushed in startRun once the runId exists); attachments cannot be
      // steered in v1, so they stay in the composer.
      if (!explicitValue || attachmentSnapshot.length > 0) return;
      const optimisticId = `one-steer:${uid()}`;
      pendingSteersRef.current = [...pendingSteersRef.current, { id: optimisticId, text: explicitValue }];
      setQueuedSteers((current) => [...current, { id: optimisticId, text: explicitValue }]);
      setComposer("");
      scrollToLatest();
      return;
    }
    const submissionNavigationEpoch = navigationEpochRef.current;
    const setSubmissionBusy = (value: boolean) => {
      if (navigationEpochRef.current === submissionNavigationEpoch) {
        setTeamPreflightBusy(value);
      }
    };
    const value = explicitValue || tFor(appLocale, "one.shell.composer.attachment_prompt", { n: attachmentSnapshot.length, s: attachmentSnapshot.length === 1 ? "" : "s" });
    let submissionRuntimeSelection = oneRuntimeSelection;
    const api = ipc();
    if (!api) {
      setError(null);
      requestOneOperationalRecovery("one-submit-connection", "Desktop bridge unavailable");
      return;
    }
    if (graphRequest !== null) {
      try {
        let targetChat = selected?.chatId ? await api.chats.get(selected.chatId) : conversation;
        if (!targetChat) {
          targetChat = await api.chats.create({
            title: `Graph · ${graphRequest.split(/\r?\n/)[0].slice(0, 62)}`,
            taskMode: "conversation",
            originSurface: "one",
          });
          homeTransitionPendingRef.current = false;
          setConversation(targetChat);
          selectedTaskIdRef.current = null;
          selectedConversationIdRef.current = targetChat.id;
          shownThreadChatIdRef.current = targetChat.id;
          router.replace(`/one?chat=${encodeURIComponent(targetChat.id)}`);
        }
        const entry = await api.chats.appendOneUserMessage(targetChat.id, explicitValue);
        setComposer("");
        setTurnOverrides({});
        setComposerMenu(null);
        setMessages((current) => current.some((message) => message.id === entry.id)
          ? current
          : [...current, {
              id: entry.id,
              role: "user",
              text: entry.text,
              createdAt: entry.createdAt,
            }]);
        scrollToLatest();
      } catch (cause) {
        setComposer(explicitValue);
        requestOneOperationalRecovery("one-graph-chat", cause);
      }
      return;
    }
    if (busy) {
      const chatId = runChatIdRef.current;
      const activeRunId = runIdRef.current;
      if (!chatId || !activeRunId || attachmentSnapshot.length > 0) return;
      const optimisticId = `one-steer:${uid()}`;
      setComposer("");
      // Codex keeps a queued instruction in the queue strip above the composer
      // until the model actually receives it; it becomes a conversation turn
      // only when its run starts (see the active-chat attach below). Showing it
      // as a bubble *and* in the queue drew the same words twice.
      setQueuedSteers((current) => [...current, { id: optimisticId, text: value }]);
      scrollToLatest();
      try {
        await api.invoke.steer({
          chatId,
          userPrompt: value,
          steeringMode: "interrupt",
          taskIntent: selected ? "task" : "conversation",
          oneMode: true,
          locale: normalizedLocale,
          onePermissionMode: onePermission,
          permissions: onePermission === "auto" ? selected ? "write" : "read" : onePermission,
          ...(oneRuntimeSelection ? { runtimeSelection: oneRuntimeSelection } : {}),
          sessionRouting: false,
        });
      } catch (cause) {
        setQueuedSteers((current) => current.filter((item) => item.id !== optimisticId));
        setComposer(value);
        requestOneOperationalRecovery("one-steer", cause);
      }
      return;
    }
    const canContinueInPlace = Boolean(
      selected?.chatId && ["partial", "completed", "failed"].includes(selected.canonicalStatus ?? ""),
    );
    if (selected && (!selected.chatId || (!selected.truth.mayStartExecution && !canContinueInPlace))) {
      setError(null);
      requestOneOperationalRecovery("one-submit-continuation", "Current task cannot continue with its present verified state");
      return;
    }
    // PRD §4.14 — 제안 카드가 떠 있는 동안 사용자가 평상어로 답하면 **조용히 버려졌다.**
    // 버리지 않는다: 만료된 제안이면 그 사실을 말하고 이번 입력을 그대로 진행시키고,
    // 아직 살아 있는 제안이면 왜 지금 못 받는지 한 줄로 답한다.
    if (teamPreflight && isOneTeamPreflightPendingStatus(teamPreflight.status)) {
      const expired = isOneTeamPreflightExpired(teamPreflight);
      if (!expired) {
        setError(appLocale === "ko"
          ? "위 제안에 먼저 답해 주세요. 진행하거나 취소하면 이 메시지를 이어서 보낼 수 있어요."
          : "Answer the proposal above first. Once you continue or cancel it, this message will go through.");
        return;
      }
      // 만료된 카드는 더 이상 관문이 아니다. 화면에서 내리고 사용자의 문장을 살린다.
      setTeamPreflight(null);
      setError(appLocale === "ko"
        ? "이전 팀 제안은 시간이 지나 만료됐습니다. 방금 보낸 내용으로 계속합니다."
        : "The earlier team proposal expired. Continuing with what you just sent.");
    }
    const prepareOrRun = async (
      chatId: string,
      taskId: string | null,
      taskVersion: number | null,
      taskIntent: "task" | "conversation",
    ) => {
      setSubmissionBusy(true);
      setError(null);
      let preparedAttachments: PreparedOneAttachments | null = null;
      let runPrompt = value;
      // Resolve new-chat intent in Main before team preflight. A cold model can
      // miss the fast judgment budget, in which case the explicitly labeled
      // undecided result keeps the safe conversational default.
      const requestIntentPromise = taskIntent === "conversation" && attachmentSnapshot.length === 0
        ? api.oneRequestIntent.resolve(runPrompt).catch(() => null)
        : Promise.resolve(null);
      try {
        if (attachmentSnapshot.length > 0) {
          const fileBridge = chatFilesBridge();
          if (!fileBridge) throw new Error(appLocale === "ko" ? "Desktop 파일 연결을 사용할 수 없습니다." : "The Desktop file bridge is unavailable.");
          const snapshot = await fileBridge.snapshot({
            chatId,
            files: attachmentSnapshot.map((item) => ({
              grant: item.grant,
              name: item.name,
              mediaType: item.mediaType,
              size: item.size,
              kind: item.kind === "image" ? "file" : item.kind,
            })),
          });
          const chatFiles = snapshot.files.map((file) => chatFileItem(file, "user-attachment"));
          oneChatFileGroupsRef.current.set(snapshot.groupId, chatFiles);
          runPrompt = appendChatFileMarker(value, snapshot.groupId);
          setMessages((current) => current.map((message) => message.id === preflightId
            ? { ...message, files: undefined, chatFiles, chatFileGroupIds: [snapshot.groupId] }
            : message));
          const attachments: OneAttachmentPrepareItem[] = attachmentSnapshot.map((item) => ({
            grant: item.grant,
            displayName: item.name,
            claimedMediaType: item.mediaType,
            claimedSize: item.size,
          }));
          preparedAttachments = await api.oneAttachments.prepare({ chatId, userPrompt: runPrompt, attachments });
        }
        const mainIntent = await requestIntentPromise;
        const resolvedIntent = preparedAttachments
          || taskIntent === "task"
          || recurrenceSnapshot
          || mainIntent?.intent === "task"
          || classifyOneRequestIntent(runPrompt) === "task"
          ? "task"
          : "conversation";
        /*
         * 단톡방은 그 자체가 "여럿이 있는 자리"다. 그런데 편성 조건에 방의
         * 존재가 없어서, 칩을 일일이 붙이지 않으면 3명짜리 방에서도 One 혼자
         * 답했다(오너 지적 2026-08-24 "one만 일하냐?"). 방에 살아 있는 팀원이
         * 있으면 그 방의 말은 팀의 일이다.
         */
        const taskforceForChat = taskforces.find((item) => item.chatId === chatId) ?? null;
        const taskforceMemberIds = taskforceForChat
          ? taskforceForChat.memberAgentIds.filter((agentId) => {
            const member = oneOrgState?.members.find((item) => item.installedAgentId === agentId);
            return Boolean(member) && !member?.archivedAt
              && member?.statusKind !== "locked" && member?.statusKind !== "failed";
          })
          : [];
        const explicitTeamRequest = taskForceTargetSnapshot.length > 0
          || overrideSnapshot.sessionRouting
          || taskforceMemberIds.length > 0;
        // Ordinary conversation must never pass through adaptive-team
        // preparation. That subsystem materializes a canonical Task as soon as
        // it finds a team need; running it speculatively made greetings and
        // quick answers appear under Work even when the authoritative intent
        // verdict was `conversation`.
        if (resolvedIntent === "conversation" && !explicitTeamRequest) {
          await startRun(
            chatId,
            taskId,
            taskVersion,
            runPrompt,
            "conversation",
            {
              attachments: preparedAttachments,
              recurrence: recurrenceSnapshot,
              overrides: overrideSnapshot,
              taskForceTargets: taskForceTargetSnapshot,
              runtimeSelection: submissionRuntimeSelection,
              userAlreadyShown: true,
            },
          );
          return;
        }
        const prepared = await api.oneTeamPreflight.prepare({
          chatId,
          userPrompt: runPrompt,
          expectedTaskId: taskId,
          expectedTaskVersion: taskVersion,
          permission: onePermission === "read" ? "read" : "write",
          ...(submissionRuntimeSelection ? { runtimeSelection: submissionRuntimeSelection } : {}),
          ...((() => {
            // 이번 턴에 지정한 팀원이 우선이고, 없으면 방의 팀원이 기본이다.
            // ★수리 2026-08-25 — 예전에는 local 칩만 남기고 Hub 대여 좌석 칩을
            // 버렸다. 그래서 허브 좌석만 앉은 방은 "이번 턴 지정"이 통째로
            // 비고 One 혼자 실행됐다. 좌석의 설치행 id 로 되돌려 함께 보낸다.
            const chipIds = taskForceTargetSnapshot
              .map((target) => {
                if (target.source === "local" && target.entityKind === "agent") return target.agentId;
                if (target.source === "hub") {
                  return availableAgents.find((item) => item.slug === target.slug)?.id ?? "";
                }
                return "";
              })
              .filter(Boolean);
            const requestedAgentIds = chipIds.length > 0 ? chipIds : taskforceMemberIds;
            return requestedAgentIds.length > 0 ? { requestedAgentIds } : {};
          })()),
          ...(overrideSnapshot.sessionRouting ? { dynamicTeamRequested: true } : {}),
        });
        if (prepared.kind === "not_required") {
          await startRun(
            chatId,
            taskId,
            taskVersion,
            runPrompt,
            resolvedIntent,
            {
              attachments: preparedAttachments,
              recurrence: recurrenceSnapshot,
              overrides: overrideSnapshot,
              taskForceTargets: taskForceTargetSnapshot,
              runtimeSelection: submissionRuntimeSelection,
              userAlreadyShown: true,
            },
          );
          return;
        }
        if (preparedAttachments) {
          preparedAttachments = await api.oneAttachments.bindToTeam({
            ref: preparedAttachments.ref,
            proposalId: prepared.proposal.proposalId,
            chatId,
          });
        }
        setTeamPreflight(prepared.proposal);
        const pendingPrompt: PendingTeamPrompt = {
          proposalId: prepared.proposal.proposalId,
          text: runPrompt,
          attachments: preparedAttachments,
          recurrence: recurrenceSnapshot,
          overrides: overrideSnapshot,
          taskForceTargets: taskForceTargetSnapshot,
          runtimeSelection: submissionRuntimeSelection,
        };
        setPendingTeamPrompt(pendingPrompt);
        oneTranscriptRevisionRef.current += 1;
        setMessages((current) => [
          ...current.filter((item) => item.id !== "one-live-response"),
        ]);
        setPreflightPrompt(null);
        scrollToLatest();
        await autoStartTeamPreflight(prepared.proposal, pendingPrompt, true);
      } catch (cause) {
        if (preparedAttachments) {
          await api.oneAttachments.discard({ ref: preparedAttachments.ref }).catch(() => ({ discarded: false }));
        }
        throw cause;
      } finally {
        setSubmissionBusy(false);
        // Preparation ended without a run (refused, failed, or waiting on a
        // team decision): instructions queued behind it go back to the composer
        // instead of lingering as a "next" that has nothing to follow.
        if (!runIdRef.current && pendingSteersRef.current.length > 0) {
          const orphaned = pendingSteersRef.current;
          pendingSteersRef.current = [];
          const orphanIds = new Set(orphaned.map((item) => item.id));
          setQueuedSteers((current) => current.filter((item) => !orphanIds.has(item.id)));
          setComposer((current) => [current, ...orphaned.map((item) => item.text)].filter(Boolean).join("\n"));
        }
      }
    };
    setComposer("");
    setTurnOverrides({});
    setTurnAgentIds(activeTaskforceAgentIds);
    setAgentPickerOpen(false);
    setComposerMenu(null);
    clearAttachmentDrafts({ preserveSubmittedPreviews: true });
    freshChatSubmissionPendingRef.current = !(
      (selected?.chatId && !homeTransitionPendingRef.current && selectedTaskIdRef.current === selected.taskId)
      || (conversation && !homeTransitionPendingRef.current && selectedConversationIdRef.current === conversation.id)
    );
    // Commit the request before any attachment, intent, team, or runtime work
    // begins. The user now sees a truthful "Preparing execution" phase rather
    // than the prior answer's stale, falsely-live Activity.
    const preflightId = `one-preflight:${uid()}`;
    const preflightStartedAt = Date.now();
    flushSync(() => {
      setPreflightPrompt({ id: preflightId, text: value, startedAt: preflightStartedAt });
      setActivityStateRunId(null);
      setActivity(initialOneActivityState());
      setRunStartedAt(null);
      setSurface(null);
      setReceipt(null);
      oneTranscriptRevisionRef.current += 1;
      setMessages((current) => [
        ...current.filter((item) => item.id !== "one-live-response"),
        {
          id: preflightId,
          role: "user",
          text: value,
          // Optimistic rows carry the local send time so the run that follows
          // can be anchored after them before the durable row ever loads.
          createdAt: new Date().toISOString(),
          // 보낸 즉시 대화에 남는다 — 미리보기가 사라지고 텍스트만 남던 자리.
          images: attachmentSnapshot.filter((a) => a.kind === "image" && a.previewUrl).map((a) => a.previewUrl as string),
          files: attachmentSnapshot.map((a) => ({ name: a.name, kind: a.kind })),
        },
      ]);
      setSubmissionBusy(true);
    });
    scrollToLatest();
    let freshCreatedChatId: string | null = null;
    const recoverFreshCreatedChatDraft = (notice: string) => {
      if (!freshCreatedChatId || navigationEpochRef.current !== submissionNavigationEpoch) return;
      setSubmissionBusy(false);
      setPreflightPrompt(null);
      setMessages((current) => current.filter((item) => item.id !== preflightId));
      setComposer((current) => {
        if (!current.trim()) return value;
        if (current === value) return current;
        return `${value}\n${current}`;
      });
      setTurnOverrides(currentOneGoalOverride(overrideSnapshot, goalControlEpochRef.current));
      setTurnAgentIds(turnAgentIds);
      if (attachmentSnapshot.length > 0) {
        const restored = attachmentSnapshot.map((item) => ({ ...item, previewUrl: null }));
        attachmentDraftsRef.current = restored;
        setAttachmentDrafts(restored);
      }
      setActionNotice(notice);
    };
    try {
      if (selected?.chatId && !homeTransitionPendingRef.current && selectedTaskIdRef.current === selected.taskId) {
        // A result is one turn in this conversation, not a reason to fork a new
        // chat. Reusing the same chatId also reuses the provider CLI session.
        await prepareOrRun(selected.chatId, selected.taskId, selected.canonicalVersion, "task");
        return;
      }
      if (conversation && !homeTransitionPendingRef.current && selectedConversationIdRef.current === conversation.id) {
        await resolveActivationConcern(conversation.id);
        await prepareOrRun(conversation.id, null, null, "conversation");
        return;
      }
      let chat = await api.chats.create({
        title: value.split(/\r?\n/)[0].slice(0, 72),
        taskMode: "conversation",
        originSurface: "one",
      });
      if (!chat?.id || chat.originSurface !== "one") {
        throw new Error("fresh_chat_receipt_mismatch");
      }
      freshCreatedChatId = chat.id;
      // A later "New conversation" action owns navigation. An older async
      // submission may still finish preparing, but it must not pull the UI
      // back to its chat or restore that chat as the active composer target.
      if (navigationEpochRef.current === submissionNavigationEpoch) {
        homeTransitionPendingRef.current = false;
        pendingNewChatDraftCarryRef.current = { chatId: chat.id, navigationEpoch: submissionNavigationEpoch };
        setConversation(chat);
        selectedConversationIdRef.current = chat.id;
        // 화면에는 이미 이 대화의 첫 턴이 떠 있다(낙관적 렌더). 소유를 지금 넘겨 두지
        // 않으면 곧 도착할 빈 히스토리가 그 턴을 지운다.
        shownThreadChatIdRef.current = chat.id;
        // The exported Electron renderer cannot rely on App Router fetching an
        // RSC payload for a query-only transition. In that build
        // router.replace() falls back to a full document reload, destroying
        // the optimistic text/photo before Main has persisted the turn. This
        // is the same /one document, so update its query in-place and notify
        // Next's history listener without replacing the renderer process.
        const nextLocation = `/one?chat=${encodeURIComponent(chat.id)}`;
        window.history.replaceState(window.history.state, "", nextLocation);
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      }
      if (workspaceGrant) {
        await api.workspace.set(chat.id, workspaceGrant);
        const persistedPath = await api.workspace.get(chat.id);
        if (persistedPath !== workspaceGrant.path) {
          throw new Error("fresh_chat_workspace_receipt_mismatch");
        }
      }
      if (submissionRuntimeSelection) {
        try {
          const pinned = await api.chats.setRuntimeSelection(chat.id, submissionRuntimeSelection);
          const receipt = pinned?.runtimeSelection;
          if (
            !pinned
            || pinned.id !== chat.id
            || !runtimeSelectionReceiptMatches(submissionRuntimeSelection, receipt)
          ) {
            throw new Error("Desktop did not acknowledge the fresh chat runtime selection");
          }
          const receiptRuntime = oneRuntimeInventory.find((runtime) => (
            runtime.kind === receipt.kind
            && (!receipt.backend || runtime.backend === receipt.backend)
          ));
          if (!receiptRuntime) throw new Error("Desktop acknowledged an unavailable fresh chat runtime");
          submissionRuntimeSelection = receipt;
          chat = pinned;
          setConversation((current) => current?.id === pinned.id ? pinned : current);
          setActiveThreadChat(pinned);
          setOneRuntime(withOneRuntimeSelection(
            { ...receiptRuntime, active: true },
            receipt.model ?? receiptRuntime.model ?? null,
            receipt.effort ?? (receipt.model ? undefined : receiptRuntime.effort),
          ));
          setOneRuntimePinned(true);
          writeStoredOneRuntimeSelection(receipt);
        } catch {
          // The empty chat already exists and is now the visible recovery
          // target, but no invocation may start without the exact pin receipt.
          recoverFreshCreatedChatDraft(appLocale === "ko"
            ? "새 대화는 열렸지만 모델 선택을 저장하지 못해 실행하지 않았습니다. 이 대화에서 모델을 다시 고른 뒤 보내 주세요."
            : "The new conversation is open, but its model selection was not saved, so nothing ran. Choose the model again in this conversation and resend.");
          return;
        }
      }
      await resolveActivationConcern(chat.id);
      await prepareOrRun(chat.id, null, null, "conversation");
    } catch (cause) {
      freshChatSubmissionPendingRef.current = false;
      setSubmissionBusy(false);
      setPreflightPrompt(null);
      if (freshCreatedChatId && !runIdRef.current) {
        recoverFreshCreatedChatDraft(appLocale === "ko"
          ? "새 대화는 열렸지만 실행 준비를 저장하고 확인하지 못해 아무 작업도 시작하지 않았습니다. 입력과 첨부는 이 대화에 복원했습니다. 다시 시도해 주세요."
          : "The new conversation is open, but its setup could not be saved and verified, so nothing ran. Your draft and attachments were restored here; try again.");
        return;
      }
      // Preparing an attachment failed before an invocation exists. Recovering
      // an unrelated prior run here silently changes the prompt, model, and
      // permission the user sees. Keep the exact draft retryable instead.
      if (attachmentSnapshot.length > 0 && isOneAttachmentPreparationFailure(cause)) {
        const restored = attachmentSnapshot.map((item) => ({ ...item, previewUrl: null }));
        attachmentDraftsRef.current = restored;
        setAttachmentDrafts(restored);
        setAttachmentError(appLocale === "ko"
          ? "첨부를 준비하지 못했습니다. 파일은 전송되지 않았습니다. 다시 시도해 주세요."
          : "The attachment was not sent. Prepare it again and retry.");
        setComposer(value);
        return;
      }
      /*
       * ★여기까지 왔다는 것은 **실행이 시작되지 않았다**는 뜻이다. 그러면 사용자의
       * 글과 사진은 어디에도 없다 — Main 은 실행에 들어가야 그 턴을 저장하고(
       * mcp/client.ts persistUserMessage), 화면의 낙관적 줄은 메모리에만 있어서
       * 다음 기록 새로고침에 사라진다.
       *
       * 오너 실사용 2026-09-07: "내가 보낸 메세지가 자꾸 없어진다 사진도 없어지고".
       * 위 두 갈래(새 대화 실패·첨부 준비 실패)만 초안을 되돌려 주고, **그 외 전부**는
       * 아무것도 되돌리지 않았다. 실행 전에 던지는 길은 그 둘 말고도 많다 —
       * 팀 preflight, 워크스페이스 영수증, IPC, 그리고 Main 이 저장 전에 던지는 모든 것.
       *
       * 실패는 사용자가 쓴 것을 없앨 이유가 아니다. 되돌려 주고, 화면에서도 그 줄을
       * 지운다 — 기록에 없는 줄을 남겨 두면 "보냈다"고 읽히고 새로고침 때 또 사라진다.
       */
      if (!runIdRef.current) {
        setMessages((current) => current.filter((item) => item.id !== preflightId));
        setComposer((current) => {
          if (!current.trim()) return value;
          if (current === value) return current;
          return `${value}\n${current}`;
        });
        if (attachmentSnapshot.length > 0) {
          const restored = attachmentSnapshot.map((item) => ({ ...item, previewUrl: null }));
          attachmentDraftsRef.current = restored;
          setAttachmentDrafts(restored);
        }
        setTurnOverrides(currentOneGoalOverride(overrideSnapshot, goalControlEpochRef.current));
        setTurnAgentIds(turnAgentIds);
      }
      /*
       * ★되돌려 주는 것만으로는 부족하다 — **왜 안 갔는지**도 말해야 한다 (2026-09-08).
       *
       *   위 두 갈래(새 대화 실패·첨부 준비 실패)만 문구를 냈고, **그 밖의 전부**는
       *   글만 조용히 작성창으로 돌아왔다. 사용자 입장에서는 보낸 글이 되돌아온 것과
       *   아무 일도 안 일어난 것이 구별되지 않는다.
       *   오너 2026-09-07: "아무것도 안떠서 되는지 안 되는지 알 수 없잖아".
       *
       *   `setError` 는 이 화면에서 **한 번도 그려지지 않는 상태**였다(설정만 하고 읽는
       *   자리가 없다). 그래서 이미 화면에 그려지는 actionNotice 로 낸다.
       */
      const raw = failureMessage(cause);
      setActionNotice(
        isChatBusyFailure(cause)
          // 엔진이 이미 "무엇을 하면 되는지"까지 담아 보낸 문장이다. 덮어쓰지 않는다.
          ? raw
          : appLocale === "ko"
            ? `보내지 못했습니다${raw ? `: ${raw}` : " (이유가 오지 않았습니다)"}. 글과 첨부는 작성창에 그대로 있습니다 — 다시 보내 주세요.`
            : `The message was not sent${raw ? `: ${raw}` : " (no reason came back)"}. Your text and attachments are still in the composer; send it again.`,
      );
      requestOneOperationalRecovery("one-submit", cause);
      setError(null);
    }
  }, [activeTaskforceAgentIds, autoStartTeamPreflight, busy, clearAttachmentDrafts, conversation, appLocale, normalizedLocale, onePermission, oneRuntimeInventory, oneRuntimeSelection, orchestrationTargetForAgentId, resolveActivationConcern, router, scrollToLatest, selected, startRun, teamPreflight, teamPreflightBusy, turnAgentIds, turnOverrides, workspaceGrant]);

  const stopRun = useCallback(() => {
    // Stop is terminal for the visible work item: Main drops the directions
    // queued behind it (InvocationService.cancel), so the strip must not keep
    // showing them as "next". Handoff interruption intentionally shares this
    // exact authority rather than inventing a second cancellation path.
    cancelActiveRun("one-run-stop");
  }, [cancelActiveRun]);

  // Pull a queued direction back before its run starts. Main removes it by
  // position + exact text; if it already started (or the queue was already
  // cleared), the strip entry is dropped anyway — the truth is the run list.
  const removeQueuedSteer = useCallback(async (id: string, position: number, text: string) => {
    const api = ipc();
    const chatId = runChatIdRef.current;
    setQueuedSteers((current) => current.filter((item) => item.id !== id));
    if (!api || !chatId) return;
    try {
      await api.invoke.unsteer({ chatId, position, text });
    } catch (cause) {
      requestOneOperationalRecovery("one-steer-remove", cause);
    }
  }, []);

  // "이어서 진행" 한 번의 클릭 — 끝까지 확인되지 않은 실행을 같은 대화에서
  // 조용히 이어간다. 사용자에게 오류 문구를 다시 입력하라고 요구하지 않는다.
  const retryUnfinished = useCallback(() => {
    if (busy) return;
    const chatId = selected?.chatId ?? conversation?.id;
    if (!chatId) return;
    void startRun(
      chatId,
      selected?.taskId ?? null,
      selected?.canonicalVersion ?? null,
      tFor(appLocale, "one.shell.system_prompt.retry_unfinished"),
      selected ? "task" : "conversation",
      { displayUserMessage: false, promptOrigin: "system" },
    );
  }, [appLocale, busy, conversation?.id, selected, startRun]);

  /**
   * Automatic recovery. A run that stops short is One's problem to route around,
   * so the product retries on its own before it ever shows the person a failure.
   * Main judges whether that is allowed; this effect only carries out the answer.
   * Attempts are counted per conversation and reset whenever the person speaks
   * or a run completes, so a new request always starts from a full budget.
   */
  useEffect(() => {
    if (busy || !receipt) return;
    const chatId = selected?.chatId ?? conversation?.id;
    if (!chatId || receipt.chatId !== chatId) return;
    if (receipt.status === "completed") {
      const state = autoRecoveryRef.current;
      if (receipt.runId !== state.recoveryRunId || !state.originalRunId) {
        // An ordinary successful run needs no recovery proof.
        if (autoRecovery) setAutoRecovery(null);
        state.attemptsSpent = 0;
        state.previousFingerprint = null;
        state.originalRunId = null;
        state.recoveryRunId = null;
        return;
      }
      // A completed process is not proof of the requested outcome. Main binds
      // the original failure, recovery receipt, and actual assistant result,
      // asks One to assess them, and writes a durable assessment receipt.
      if (state.judgedRunIds.has(receipt.runId)) return;
      const api = ipc();
      if (!api?.oneAutoRecovery) return;
      state.judgedRunIds.add(receipt.runId);
      let cancelled = false;
      let verificationSettled = false;
      void api.oneAutoRecovery.verify({
        originalRunId: state.originalRunId,
        recoveryRunId: receipt.runId,
        chatId,
        goal: state.goal,
        attemptsSpent: state.attemptsSpent,
      }).then((verification) => {
        if (cancelled || !verification) return;
        verificationSettled = true;
        const safeDiagnosis = toCustomerSafeText(verification.diagnosis, appLocale);
        if (verification.verified) {
          setAutoRecovery(null);
          state.attemptsSpent = 0;
          state.previousFingerprint = null;
          state.originalRunId = null;
          state.recoveryRunId = null;
          return;
        }
        if (!verification.retry) {
          setAutoRecovery({
            phase: "stopped",
            reason: verification.reason ?? "undecided",
            diagnosis: safeDiagnosis,
          });
          return;
        }
        state.attemptsSpent = verification.attempt ?? state.attemptsSpent + 1;
        const nextRecoveryRunId = uid();
        state.recoveryRunId = nextRecoveryRunId;
        setAutoRecovery({ phase: "recovering", attempt: state.attemptsSpent, diagnosis: safeDiagnosis });
        void startRun(
          chatId,
          selected?.taskId ?? null,
          selected?.canonicalVersion ?? null,
          tFor(appLocale, "one.shell.system_prompt.auto_recover", {
            reason: safeDiagnosis || tFor(appLocale, "one.res.fail.generic"),
          }),
          selected ? "task" : "conversation",
          { runId: nextRecoveryRunId, displayUserMessage: false, promptOrigin: "system" },
        );
      }).catch(() => {
        if (!cancelled) {
          verificationSettled = true;
          setAutoRecovery({ phase: "stopped", reason: "undecided", diagnosis: "" });
        }
      });
      return () => {
        cancelled = true;
        if (!verificationSettled) state.judgedRunIds.delete(receipt.runId);
      };
    }
    if (receipt.status !== "failed" && receipt.status !== "interrupted") return;
    // One decision per run id, no matter how often this effect re-evaluates.
    if (autoRecoveryRef.current.judgedRunIds.has(receipt.runId)) return;

    const api = ipc();
    if (!api?.oneAutoRecovery) {
      requestOneOperationalRecovery("one-auto-recovery", new Error("Desktop recovery controller unavailable"));
      return;
    }
    autoRecoveryRef.current.judgedRunIds.add(receipt.runId);
    const state = autoRecoveryRef.current;
    if (state.chatId !== chatId) {
      state.chatId = chatId;
      state.goal = selected?.display.title ?? conversation?.title ?? "";
      state.originalRunId = receipt.runId;
      state.recoveryRunId = null;
      state.attemptsSpent = 0;
      state.previousFingerprint = null;
    }
    if (!state.originalRunId) state.originalRunId = receipt.runId;
    const goal = state.goal || selected?.display.title || conversation?.title || "";
    let cancelled = false;
    let judgementSettled = false;
    void api.oneAutoRecovery
      .judge({
        runId: receipt.runId,
        chatId,
        goal,
        attemptsSpent: state.attemptsSpent,
        previousFingerprint: state.previousFingerprint,
      })
      .then((judgement) => {
        if (cancelled || !judgement) return;
        judgementSettled = true;
        state.previousFingerprint = judgement.fingerprint;
        const safeDiagnosis = toCustomerSafeText(judgement.diagnosis, appLocale);
        if (!judgement.retry) {
          setAutoRecovery({
            phase: "stopped",
            reason: judgement.reason ?? "needs-person",
            diagnosis: safeDiagnosis,
          });
          return;
        }
        state.attemptsSpent = judgement.attempt ?? state.attemptsSpent + 1;
        const recoveryRunId = uid();
        state.recoveryRunId = recoveryRunId;
        setAutoRecovery({ phase: "recovering", attempt: state.attemptsSpent, diagnosis: safeDiagnosis });
        void startRun(
          chatId,
          selected?.taskId ?? null,
          selected?.canonicalVersion ?? null,
          tFor(appLocale, "one.shell.system_prompt.auto_recover", {
            reason: safeDiagnosis || tFor(appLocale, "one.res.fail.generic"),
          }),
          selected ? "task" : "conversation",
          { runId: recoveryRunId, displayUserMessage: false, promptOrigin: "system" },
        );
      })
      .catch(() => {
        // Judgment is advisory. Failing to reach it must never hide the run:
        // the closure card stays as the honest outcome.
        if (!cancelled) {
          judgementSettled = true;
          setAutoRecovery(null);
        }
      });
    return () => {
      cancelled = true;
      if (!judgementSettled) {
        // Navigation, locale changes, or unmounting can cancel only the
        // renderer's wait — Main may still finish the read-only judgment.
        // Let the run be judged again when this conversation becomes active;
        // otherwise switching away once permanently disables its recovery.
        autoRecoveryRef.current.judgedRunIds.delete(receipt.runId);
      }
    };
    // `autoRecovery` is written here, never read as an input — including it
    // would re-run this effect on its own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appLocale, busy, conversation?.id, conversation?.title, receipt, selected, startRun]);

  const answerConfirmation = useCallback(async (
    confirmation: PendingConfirmation,
    label: string,
    shouldStart = true,
  ) => {
    const api = ipc();
    const projectedTask = projections.find((item) => item.chatId === confirmation.chatId);
    const isActiveOneConversation = conversation?.id === confirmation.chatId
      && conversation.originSurface === "one";
    if (
      !api
      || busy
      || (!projectedTask && !isActiveOneConversation)
      || (shouldStart && projectedTask && !projectedTask.truth.mayStartExecution)
    ) return;
    try {
      const sourceReceipt = await api.invoke.latestReceipt(confirmation.chatId)
        .catch(() => projectedTask?.latestReceipt ?? null);
      // A missing receipt must fail closed. Falling back to the current Auto
      // chip would turn the newly materialized Task into write authority even
      // though the preceding conversation was read-only.
      const continuationPermission: OnePermissionMode = sourceReceipt?.executionPermission ?? "read";
      await api.confirm.commitAnswer({
        chatId: confirmation.chatId,
        sourceMessageId: confirmation.sourceMessageId,
        reply: label,
      });
      setCommittedAnswers(await api.confirm.committedAnswers(confirmation.chatId).catch(() => []));
      setConfirmations((items) => items.filter((item) => item.sourceMessageId !== confirmation.sourceMessageId));
      if (shouldStart) {
        if (projectedTask) {
          await startRun(
            confirmation.chatId,
            projectedTask.taskId,
            projectedTask.canonicalVersion,
            label,
            "task",
            { permissionMode: continuationPermission },
          );
        } else {
          const task = await api.tasks.findForChat(confirmation.chatId);
          await startRun(
            confirmation.chatId,
            task?.id ?? null,
            task?.version ?? null,
            label,
            task ? "task" : "conversation",
            { permissionMode: continuationPermission },
          );
        }
      }
    } catch (cause) {
      // The question can be replaced between render and click. Re-read Main's
      // exact pending identities before treating the rejection as an outage:
      // starting an operational-recovery turn in that case would append a new
      // system turn to this chat and hide the replacement question itself.
      const pending = await api.confirm.listPending().catch(() => null);
      if (pending) {
        setConfirmations(pending);
        const exactQuestionStillPending = pending.some((item) => (
          item.chatId === confirmation.chatId
          && item.sourceMessageId === confirmation.sourceMessageId
        ));
        if (!exactQuestionStillPending) {
          setError(null);
          return;
        }
      }
      requestOneOperationalRecovery("one-decision-answer", cause);
      setError(null);
    }
  }, [busy, conversation?.id, conversation?.originSurface, projections, startRun]);

  /*
   * "항상 승인"은 그 대화 안에서만 산다.
   *
   * 승인 시트가 물어보는 것은 "이 대화에서 지금 하려는 일을 해도 되느냐"이므로, 한 번
   * 준 허락도 그 대화를 넘지 않는다. 전역으로 두면 사용자가 다른 맥락에서 기억하지 못하는
   * 허락이 남는다(오너 결정 2026-08-15: 승인은 묻는 순간, 그 대화 안에서만).
   *
   * 저장이 화면 상태가 아니라 localStorage 인 이유: 앱을 껐다 켜면 잊는 허락은 사용자
   * 입장에서 "눌렀는데 또 묻는다"가 되고, 그러면 아무도 두 번째부터 신뢰하지 않는다.
   */
  const markChatAlwaysApproved = useCallback(async (confirmation: PendingConfirmation) => {
    manualAlwaysApprovalRef.current.add(confirmation.sourceMessageId);
    try {
      await grantAlwaysApproval(confirmation.chatId);
      await answerConfirmation(
        confirmation,
        firstApprovalLabel(confirmation) ?? "Approve. Proceed with the proposed action.",
      );
    } finally {
      manualAlwaysApprovalRef.current.delete(confirmation.sourceMessageId);
    }
  }, [answerConfirmation]);

  /*
   * 허락을 이미 준 대화에 새 결정 요청이 오면 사람을 다시 세우지 않는다.
   *
   * 이 자동 승인이 없으면 "항상 승인"은 버튼 이름만 그럴싸한 1회 승인이 된다 — 즉
   * 배선 없는 선언이다. 자동으로 처리한 요청도 committedAnswers 에 그대로 남으므로
   * 무엇이 언제 승인됐는지는 대화 기록에서 사라지지 않는다.
   */
  useEffect(() => {
    if (busy || alwaysApprovedChats.length === 0) return;
    const auto = confirmations.find((item) => alwaysApprovedChats.includes(item.chatId)
      && !manualAlwaysApprovalRef.current.has(item.sourceMessageId));
    if (!auto) return;
    const reply = firstApprovalLabel(auto) ?? "Approve. Proceed with the proposed action.";
    void answerConfirmation(auto, reply);
  }, [alwaysApprovedChats, answerConfirmation, busy, confirmations]);

  const snoozeConfirmation = useCallback(async (confirmation: PendingConfirmation) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-decision-snooze", new Error("Desktop bridge unavailable"));
      return;
    }
    try {
      const receipt = await api.confirm.snooze({
        chatId: confirmation.chatId,
        sourceMessageId: confirmation.sourceMessageId,
        resumeAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      });
      setConfirmations((items) => items.map((item) => item.sourceMessageId === receipt.sourceMessageId
        ? { ...item, snoozedUntil: receipt.snoozedUntil }
        : item));
      setError(null);
    } catch (cause) {
      requestOneOperationalRecovery("one-decision-snooze", cause);
      setError(null);
    }
  }, []);

  const clarifyConfirmation = useCallback(async (confirmation: PendingConfirmation) => {
    if (busy) return;
    const projectedTask = projections.find((item) => item.chatId === confirmation.chatId);
    const isActiveOneConversation = conversation?.id === confirmation.chatId
      && conversation.originSurface === "one";
    if (!projectedTask && !isActiveOneConversation) {
      requestOneOperationalRecovery("one-decision-clarify", new Error("Decision context unavailable"));
      return;
    }
    setConfirmations((items) => items.filter((item) => item.sourceMessageId !== confirmation.sourceMessageId));
    await startRun(
      confirmation.chatId,
      projectedTask?.taskId ?? null,
      projectedTask?.canonicalVersion ?? null,
      tFor(appLocale, "one.shell.system_prompt.clarify_decision", {
        question: confirmation.question,
        options: confirmation.options.map((option) => option.label).join(" · "),
      }),
      "conversation",
      { displayUserMessage: false, promptOrigin: "system" },
    );
  }, [appLocale, busy, conversation?.id, conversation?.originSurface, projections, startRun]);

  const startNewConversation = useCallback(() => {
    // Clear the renderer's active-thread identity synchronously, before the
    // router commits /one. The composer can now never borrow the previous
    // conversation during that navigation window.
    navigationEpochRef.current += 1;
    homeTransitionPendingRef.current = true;
    freshChatSubmissionPendingRef.current = false;
    pendingNewChatDraftCarryRef.current = null;
    writeOneComposerDraft("new", { composer: "", stagedSteer: null });
    composerDraftKeyRef.current = "new";
    setComposerState("");
    setStagedSteerState(null);
    selectedTaskIdRef.current = null;
    selectedConversationIdRef.current = null;
    rememberLastOneConversation(null);
    setSelected(null);
    setConversation(null);
    setFailureFocus(null);
    oneTranscriptRevisionRef.current += 1;
    setMessages([]);
    // 화면을 비웠으니 그 화면이 누구 것이었는지도 함께 지운다.
    shownThreadChatIdRef.current = null;
    setSurface(null);
    setReceipt(null);
    setCommittedAnswers([]);
    // Leaving an active thread detaches its renderer subscription; the Main
    // run keeps going and remains recoverable from history. Do not carry that
    // thread's stop/busy affordance onto the empty home composer.
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = null;
    const leavingRunId = runIdRef.current;
    if (leavingRunId && cancelNoticeRunIdRef.current === leavingRunId) {
      const notice = cancelNoticeTextRef.current;
      cancelNoticeRunIdRef.current = null;
      cancelNoticeTextRef.current = null;
      setActionNotice((current) => current === notice ? null : current);
    }
    runIdRef.current = null;
    runChatIdRef.current = null;
    runTaskIdRef.current = null;
    streamTextRef.current = "";
    setBusy(false);
    setTeamPreflightBusy(false);
    setKeyRequestSheet(null);
    setTurnAgentIds([]);
    setTurnOverrides({});
    setRailOpen(false);
    setSearchOpen(false);
    clearAttachmentDrafts();
    router.push("/one");
  }, [clearAttachmentDrafts, router]);

  const openOneFailure = useCallback(async (member: OneOrgMember) => {
    const api = ipc();
    const failure = await api?.runLedger.failures({ agentId: member.installedAgentId, limit: 1 }).then((items) => items[0] ?? null).catch(() => null);
    setFailureFocus(failure ?? null);
    if (failure?.chatId) {
      setRailOpen(false);
      setSearchOpen(false);
      router.replace(`/one?chat=${encodeURIComponent(failure.chatId)}`);
      return;
    }
    startNewConversation();
    setComposer(appLocale === "ko"
      ? `${member.displayName}의 실패를 원장과 함께 확인하고, 필요한 담당·도구를 바꿔 다시 완주해줘. 실패 표식: ${member.statusLine}`
      : `Review ${member.displayName}'s failure record, then change the owner or tool and retry to completion. Failure marker: ${member.statusLine}`);
  }, [appLocale, router, startNewConversation]);

  const openOneMember = useCallback((member: OneOrgMember) => {
    const api = ipc();
    if (!api?.chats?.openOneMember) {
      requestOneOperationalRecovery("one-member-channel", new Error("Desktop bridge unavailable"));
      return;
    }
    void (async () => {
      try {
        const chat = await api.chats.openOneMember({ agentId: member.installedAgentId, title: member.displayName });
        const paneCommit = onePaneCommitWaiterRef.current.wait(chat.id);
        onePaneCommitWaiterRef.current.observe(selectedConversationId, activeThreadChatId);
        setRailOpen(false);
        setSearchOpen(false);
        selectedTaskIdRef.current = null;
        selectedConversationIdRef.current = chat.id;
        setSelected(null);
        setConversation(chat);
        setReceipt(null);
        // Same-route push navigation in a static export can promote Next's
        // `one.txt` RSC sidecar to the main document. Replace follows the same
        // proven path used when a newly started run receives its chat binding.
        try {
          router.replace(`/one?chat=${encodeURIComponent(chat.id)}`);
        } catch (cause) {
          onePaneCommitWaiterRef.current.reject(chat.id, cause);
          await paneCommit;
          throw cause;
        }
        await paneCommit;
        // Entering the exact result conversation is the acknowledgement. The
        // blue dot is only cleared after that chat exists and navigation has
        // committed; a separate "View result" button is no longer required.
        if (member.unreadCount > 0) {
          const state = await api.oneOrg.markRead({
            id: member.id,
            expectedUnreadGeneration: member.unreadGeneration,
          });
          setOneOrgState(state);
        }
        await refreshAll({ includeOrg: member.unreadCount <= 0 });
      } catch (cause) {
        requestOneOperationalRecovery("one-member-channel", cause);
      }
    })();
  }, [activeThreadChatId, refreshAll, router, selectedConversationId]);

  const startReplacementSession = useCallback(() => {
    const occupantAgentId = activeSeat?.kind === "solo" ? activeSeat.occupants[0]?.agentId : null;
    const nextMember = occupantAgentId
      ? oneOrgState?.members.find((member) => member.installedAgentId === occupantAgentId && !member.archivedAt)
      : null;
    if (nextMember) {
      openOneMember(nextMember);
      return;
    }
    startNewConversation();
  }, [activeSeat, oneOrgState?.members, openOneMember, startNewConversation]);

  const retryFocusedFailure = useCallback(() => {
    const focus = failureFocus;
    if (!focus?.chatId || busy) return;
    const prompt = appLocale === "ko"
      ? "직전 실패를 같은 대화에서 다시 시도해줘. 이미 바깥에 반영됐을 가능성이 있으면 중복 실행하지 말고 실행 기록을 먼저 확인해줘."
      : "Retry the previous failure in this conversation. If the outside effect may already have happened, inspect the execution record before repeating it.";
    void startRun(focus.chatId, null, null, prompt, "conversation", { displayUserMessage: true }).catch((cause) => requestOneOperationalRecovery("one-failure-retry", cause));
  }, [appLocale, busy, failureFocus, startRun]);

  /**
   * ★ 답을 받지 못한 턴을 다시 묻는다 (UX-D-1).
   *
   * 앱이 실행 도중 멈추면 그 실행은 원장에 `interrupted`로 남고 답은 저장되지 않는다.
   * 부분 본문은 죽은 프로세스의 메모리에 있었으므로 되살릴 수 없다 — 되살릴 수 없는 것을
   * 되살린 척하지 않고, 같은 질문을 다시 보내는 길만 정직하게 연다.
   */
  /**
   * ★ 재시도는 원 실행의 모델로 간다 (UX-2, 2026-09-05).
   * 실패·미응답 턴의 "다시 시도"가 컴포저의 *지금* 선택으로 나가, 사용자가 그 턴에 고른
   * 모델이 재시도 한 번에 바뀌었다(실측: 원 실행 qwen3-32b → 재실행 qwen3-235b).
   * 원장 final 이 남긴 실행 모델이 현재 런타임의 선택지 안에 있을 때만 그 모델을 싣는다 —
   * 런타임이 바뀌어 그 모델을 고를 수 없으면 모르는 조합을 지어내지 않고 컴포저 선택을 쓴다.
   */
  const runtimeSelectionForRetry = useCallback((originalModel: string | null | undefined): RuntimeSelection | undefined => {
    const model = originalModel?.trim();
    if (!model || !oneRuntimeSelection || oneRuntimeSelection.model === model) return oneRuntimeSelection;
    const known = oneModelOptions.some((option) =>
      option.runtime.kind === oneRuntimeSelection.kind
      && option.runtime.backend === oneRuntimeSelection.backend
      && option.id === model);
    return known ? { ...oneRuntimeSelection, model } : oneRuntimeSelection;
  }, [oneModelOptions, oneRuntimeSelection]);

  const retryUnansweredTurn = useCallback((promptText: string, originalModel?: string | null) => {
    const chatId = selected?.chatId ?? conversation?.id;
    const prompt = promptText.trim();
    if (!chatId || !prompt || busy) return;
    void startRun(chatId, null, null, prompt, "conversation", {
      displayUserMessage: true,
      runtimeSelection: runtimeSelectionForRetry(originalModel),
    }).catch((cause) => requestOneOperationalRecovery("one-unanswered-retry", cause));
  }, [busy, conversation?.id, runtimeSelectionForRetry, selected?.chatId, startRun]);

  const sendFocusedFailureToOne = useCallback(() => {
    if (!failureFocus || busy) return;
    const chatId = failureFocus.chatId ?? conversation?.id;
    if (!chatId) {
      setComposer(appLocale === "ko" ? "이 실패 원인을 찾아 고치고 다시 시도해줘." : "Find the cause of this failure, fix it, and retry.");
      return;
    }
    const prompt = appLocale === "ko"
      ? `실패 원장을 읽고 원인을 해결한 뒤 재시도해줘. runId=${failureFocus.runId ?? "없음"}, 오류=${failureFocus.failureCode ?? failureFocus.errorCode ?? "실행 오류"}`
      : `Read the failure receipt, fix the cause, and retry. runId=${failureFocus.runId ?? "none"}, error=${failureFocus.failureCode ?? failureFocus.errorCode ?? "runtime failure"}`;
    void startRun(chatId, null, null, prompt, "conversation", {
      displayUserMessage: false,
      promptOrigin: "system",
    }).catch((cause) => requestOneOperationalRecovery("one-failure-review", cause));
  }, [appLocale, busy, conversation?.id, failureFocus, startRun]);

  const openTask = useCallback((taskId: string) => {
    void (async () => {
      const api = ipc();
      if (!api) {
        requestOneOperationalRecovery("one-search-open-task", new Error("Desktop bridge unavailable"));
        return;
      }
      try {
        // Search hits are snapshots. Resolve the exact Task and its chat again
        // before navigation so an archived/deleted/stale hit cannot lead to an
        // empty same-route render.
        const projection = await getOneTaskProjection(
          api,
          taskId,
          activeChatIds,
          confirmations,
          oneProfile,
          appLocale,
        );
        if (!projection?.chatId || !projection.chat) {
          throw new Error("The selected Task or its conversation no longer exists");
        }

        setRailOpen(false);
        setSearchOpen(false);
        selectedTaskIdRef.current = projection.taskId;
        selectedConversationIdRef.current = null;
        setSelected(projection);
        setConversation(null);
        oneTranscriptRevisionRef.current += 1;
        setMessages([]);
        setReceipt(null);
        rememberLastOneConversation(projection.chatId);
        router.replace(`/one?task=${encodeURIComponent(projection.taskId)}`);
        await refreshAll({ includeOrg: false });
      } catch (cause) {
        requestOneOperationalRecovery("one-search-open-task", cause);
      }
    })();
  }, [activeChatIds, appLocale, confirmations, oneProfile, refreshAll, router]);

  const openConversation = useCallback((chatId: string) => {
    setRailOpen(false);
    setSearchOpen(false);
    selectedTaskIdRef.current = null;
    selectedConversationIdRef.current = chatId;
    const nextConversation = conversations.find((chat) => chat.id === chatId) ?? null;
    if (nextConversation) {
      setSelected(null);
      setConversation(nextConversation);
      setActiveThreadChat(nextConversation);
      oneTranscriptRevisionRef.current += 1;
      setMessages([]);
      setReceipt(null);
    }
    rememberLastOneConversation(chatId);
    router.replace(`/one?chat=${encodeURIComponent(chatId)}`);
    void refreshAll({ includeOrg: false });
  }, [conversations, refreshAll, router]);

  const openLatestOneSession = useCallback(() => {
    const latest = conversations
      .filter((chat) => isOneOwnedSession(chat, taskforces))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (latest) {
      openConversation(latest.id);
      return;
    }
    startNewConversation();
  }, [conversations, openConversation, startNewConversation, taskforces]);


  /*
   * 마지막으로 보던 대화로 돌아간다 — 앱을 껐다 켜도, 다른 화면에 다녀와도.
   * 주소에 대화가 이미 지정돼 있거나, 방금 "새 대화"를 누른 참이면 건드리지 않는다.
   * 기억된 대화가 목록에 없으면(지워졌으면) 기억을 버리고 홈에 머문다.
   */
  const oneConversationRestoredRef = useRef(false);
  useEffect(() => {
    if (oneConversationRestoredRef.current) return;
    if (selectedConversationId || selectedTaskId) { oneConversationRestoredRef.current = true; return; }
    if (homeTransitionPendingRef.current) return;
    const remembered = readLastOneConversation();
    if (!remembered) { oneConversationRestoredRef.current = true; return; }
    oneConversationRestoredRef.current = true;
    // 목록이 채워지기를 기다리지 않는다 — 목록은 늦게 오거나 비어 있을 수 있고, 그러면
    // 사용자는 홈에 떨어진 채 남는다("켤 때마다 대화가 날아간다"). 기억한 대화를 바로 열고,
    // 그 대화가 이미 사라졌다면 아래에서 기억을 버린다.
    void (async () => {
      try {
        const api = ipc();
        const chat = api ? await api.chats.get(remembered).catch(() => null) : null;
        if (!chat || chat.archivedAt) { rememberLastOneConversation(null); return; }
        openConversation(remembered);
      } catch {
        rememberLastOneConversation(null);
      }
    })();
  }, [selectedConversationId, selectedTaskId, openConversation]);
  const openTaskforce = useCallback((taskforce: OneTaskforce) => {
    openConversation(taskforce.chatId);
  }, [openConversation]);

  const createTaskforce = useCallback(async (input: { title: string; description: string; memberAgentIds: string[] }) => {
    const api = ipc();
    if (!api?.oneTaskforces) throw new Error("Desktop bridge unavailable");
    setTaskforceBusy(true);
    try {
      const created = await api.oneTaskforces.create(input);
      setTaskforceDialogOpen(false);
      setTaskforceEditingId(null);
      selectedTaskIdRef.current = null;
      selectedConversationIdRef.current = created.chatId;
      router.replace(`/one?chat=${encodeURIComponent(created.chatId)}`);
      await refreshAll({ includeOrg: false });
    } finally {
      setTaskforceBusy(false);
    }
  }, [refreshAll, router]);

  // "같은 멤버로 새 단톡 만들기" — 해체(T7) 세션의 참여자 스냅샷(I2)에서 재구성하되,
  // 지금 조직에 살아 있는 멤버만 앉힌다(만들기 계약이 활성 스태프만 허용).
  const continueDissolvedSeat = useCallback(async () => {
    const sourceChat = conversations.find((chat) => chat.id === activeThreadChatId) ?? null;
    const activeMembers = new Set(
      (oneOrgState?.members ?? [])
        .filter((member) => !member.archivedAt && member.statusKind !== "locked" && member.statusKind !== "failed")
        .map((member) => member.installedAgentId),
    );
    const memberAgentIds = (sourceChat?.participants ?? [])
      .map((participant) => participant.agentId)
      .filter((agentId): agentId is string => Boolean(agentId && activeMembers.has(agentId)));
    const baseTitle = (activeSeat?.title || sourceChat?.seatLabel || sourceChat?.title || "").trim()
      || (appLocale === "ko" ? "단톡방" : "Group");
    await createTaskforce({
      title: appLocale === "ko" ? `${baseTitle} (이어가기)` : `${baseTitle} (continued)`,
      description: "",
      memberAgentIds,
    });
  }, [activeSeat, activeThreadChatId, appLocale, conversations, createTaskforce, oneOrgState?.members]);

  const updateTaskforce = useCallback(async (input: { id: string; title: string; description: string; memberAgentIds: string[]; expectedRevision: number }) => {
    const api = ipc();
    if (!api?.oneTaskforces) throw new Error("Desktop bridge unavailable");
    setTaskforceBusy(true);
    try {
      await api.oneTaskforces.update(input);
      await refreshAll({ includeOrg: false });
      setTaskforceDialogOpen(false);
      setTaskforceEditingId(null);
    } finally {
      setTaskforceBusy(false);
    }
  }, [refreshAll]);

  const removeTaskforce = useCallback(async (input: { id: string; expectedRevision: number }) => {
    const api = ipc();
    if (!api?.oneTaskforces) throw new Error("Desktop bridge unavailable");
    const target = taskforces.find((taskforce) => taskforce.id === input.id);
    setTaskforceBusy(true);
    try {
      await api.oneTaskforces.remove(input);
      setTaskforceDialogOpen(false);
      setTaskforceEditingId(null);
      if (target?.chatId === activeThreadChatId) {
        selectedConversationIdRef.current = null;
        setConversation(null);
        oneTranscriptRevisionRef.current += 1;
        setMessages([]);
        setSurface(null);
        setReceipt(null);
        router.replace("/one");
      }
      await refreshAll({ includeOrg: false });
    } finally {
      setTaskforceBusy(false);
    }
  }, [activeThreadChatId, refreshAll, router, taskforces]);

  const removeConversation = useCallback(async (chatId: string) => {
    const api = ipc();
    if (!api?.chats?.remove) {
      requestOneOperationalRecovery("one-chat-remove", new Error("Desktop bridge unavailable"));
      return;
    }
    if (activeChatIds.includes(chatId)) {
      window.alert(appLocale === "ko" ? "실행 중인 대화는 먼저 중지한 뒤 삭제할 수 있어요." : "Stop the active run before deleting this conversation.");
      return;
    }
    const target = conversations.find((item) => item.id === chatId);
    const title = target ? briefingSourceName(target.title, appLocale) : (appLocale === "ko" ? "이 대화" : "this conversation");
    if (!window.confirm(appLocale === "ko" ? `\"${title}\" 대화를 삭제할까요?` : `Delete \"${title}\"?`)) return;
    try {
      await api.chats.remove(chatId);
      if (selectedConversationIdRef.current === chatId) {
        selectedConversationIdRef.current = null;
        setConversation(null);
        oneTranscriptRevisionRef.current += 1;
        setMessages([]);
        setSurface(null);
        setReceipt(null);
        router.replace("/one");
      }
      await refreshAll();
    } catch (cause) {
      requestOneOperationalRecovery("one-chat-remove", cause);
    }
  }, [activeChatIds, appLocale, conversations, refreshAll, router]);

  const mutateTaskArchive = useCallback(async (taskId: string, operation: "archive" | "restore") => {
    const api = ipc();
    if (archiveMutationTaskId) return;
    if (!api?.oneSearch) {
      requestOneOperationalRecovery("one-task-archive", new Error("Desktop bridge unavailable"));
      return;
    }
    setArchiveMutationTaskId(taskId);
    setSearchFailed(false);
    try {
      const initialTask = await api.tasks.get(taskId);
      if (!initialTask?.originChatId) throw new Error(tFor(appLocale, "one.shell.archive.original_conversation_unavailable"));
      const chat = await api.chats.get(initialTask.originChatId);
      const task = await api.tasks.get(taskId);
      if (!chat || !task || task.originChatId !== chat.id) {
        throw new Error(tFor(appLocale, "one.shell.archive.binding_changed"));
      }
      await api.oneSearch.mutateArchive({
        contractVersion: ONE_SEARCH_CONTRACT_VERSION,
        taskId: task.id,
        expectedTaskVersion: task.version,
        expectedOriginChatUpdatedAt: chat.updatedAt,
        operation,
        confirmedByUser: true,
      });
      if (operation === "archive" && selectedTaskIdRef.current === taskId) {
        setSelected(null);
        oneTranscriptRevisionRef.current += 1;
        setMessages([]);
        setSurface(null);
        setReceipt(null);
        router.push("/one");
      }
      await refreshAll();
      const value = query.replace(/\s+/g, " ").trim();
      if (searchOpen && value) {
        await requestOneSearch({ query: value, includeArchived: searchIncludeArchived });
      }
    } catch (cause) {
      requestOneOperationalRecovery("one-archive", cause);
      setSearchFailed(false);
      setError(null);
    } finally {
      setArchiveMutationTaskId(null);
    }
  }, [archiveMutationTaskId, appLocale, query, refreshAll, requestOneSearch, router, searchIncludeArchived, searchOpen]);

  const loadMoreSearchResults = useCallback(() => {
    const value = query.replace(/\s+/g, " ").trim();
    if (!value || !searchNextCursor || searchLoading || searchLoadingMore) return;
    void requestOneSearch({
      query: value,
      includeArchived: searchIncludeArchived,
      cursor: searchNextCursor,
      append: true,
    });
  }, [query, requestOneSearch, searchIncludeArchived, searchLoading, searchLoadingMore, searchNextCursor]);

  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    if (!value) return projections;
    return projections.filter((item) => `${item.display.title} ${item.display.summary} ${item.taskId}`.toLocaleLowerCase().includes(value));
  }, [projections, query]);
  const filteredConversations = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    if (!value) return conversations;
    return conversations.filter((item) => `${item.title} ${item.id}`.toLocaleLowerCase().includes(value));
  }, [conversations, query]);
  const oneOrgConversationResults = useMemo<OneOrgSearchItem[]>(() => conversations.slice(0, 24).map((item) => ({
    id: item.id,
    title: item.title || (appLocale === "ko" ? "제목 없는 대화" : "Untitled conversation"),
    detail: new Date(item.updatedAt).toLocaleString(appLocale === "ko" ? "ko-KR" : "en-US"),
  })), [appLocale, conversations]);
  const oneOrgHistoryResults = useMemo<OneOrgSearchItem[]>(() => (computerHistory?.entries || []).slice(0, 24).map((item) => ({
    id: item.id,
    title: item.title,
    detail: item.body,
  })), [computerHistory?.entries]);
  const actionableConfirmations = useMemo(
    () => confirmations.filter((item) => !isPendingConfirmationSnoozed(item)),
    [confirmations],
  );
  const reactiveBriefing = useMemo(() => chooseOneBriefing(projections, actionableConfirmations, appLocale), [actionableConfirmations, appLocale, projections]);
  // The empty composer does not recruit the user into a detector-generated
  // review. Keep actual outcomes, failures, and pending runtime decisions;
  // active work already has its own conversation and organisation row.
  const rawBriefing: DisplayBriefing = useMemo(() => (
    reactiveBriefing.kind === "working"
      ? chooseOneBriefing([], [], appLocale)
      : reactiveBriefing
  ), [appLocale, reactiveBriefing]);
  const rawBriefingSignature = useMemo(() => briefingSignature(rawBriefing), [rawBriefing]);
  useEffect(() => {
    const expiresAt = readBriefingDismissal(rawBriefingSignature);
    setDismissedBriefing(expiresAt ? { signature: rawBriefingSignature, expiresAt } : null);
    if (!expiresAt) return;
    const delay = Math.min(expiresAt - Date.now(), 2_147_000_000);
    const timer = window.setTimeout(() => setDismissedBriefing((current) => current?.signature === rawBriefingSignature ? null : current), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [rawBriefingSignature]);
  const briefing: DisplayBriefing = dismissedBriefing?.signature === rawBriefingSignature && dismissedBriefing.expiresAt > Date.now()
    ? chooseOneBriefing([], [], appLocale)
    : rawBriefing;
  const selectedPendingConfirmation = activeThreadChatId
    ? confirmations.find((item) => item.chatId === activeThreadChatId) ?? null
    : null;
  const selectedConfirmation = activeThreadChatId
    ? actionableConfirmations.find((item) => item.chatId === activeThreadChatId) ?? null
    : null;
  const visibleSelectedConfirmation = selectedConfirmation?.sourceMessageId === dismissedDecisionId
    ? null
    : selectedConfirmation;
  const selectedSuggestion = useMemo(() => {
    if (!selected || !oneSuggestions || selected.canonicalStatus !== "completed") return null;
    return oneSuggestions.suggestions.find((suggestion) =>
      suggestion.originTaskId === selected.taskId && (
        suggestion.status === "accepted_for_review" ||
        (suggestion.status === "open" && actionableConfirmations.length === 0 && !briefingSnapshot?.candidate)
      )) ?? null;
  }, [actionableConfirmations.length, briefingSnapshot?.candidate, oneSuggestions, selected]);
  const selectedMemoryCandidate = useMemo(() => {
    if (!selected || !oneMemory || selected.canonicalStatus !== "completed") return null;
    return oneMemory.candidates.find((candidate) =>
      candidate.status === "pending"
      && candidate.source.provenanceStatus === "verified"
      && candidate.source.sourceTaskId === selected.taskId
    ) ?? null;
  }, [oneMemory, selected]);
  const selectedValueClosure = useMemo(() => {
    if (!selected || !oneValueClosures) return null;
    const declaredRef = surface?.taskId === selected.taskId
      ? surface.blocks.find((block) => block.type === "ValueClosure")?.valueClosureRef ?? null
      : null;
    const taskClosures = oneValueClosures.closures
      .filter((record) => record.closure.taskId === selected.taskId);
    if (declaredRef) {
      return taskClosures.find((record) => record.closure.valueClosureId === declaredRef) ?? null;
    }
    return taskClosures
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }, [oneValueClosures, selected, surface]);
  const selectedImprovementProof = useMemo(() => {
    if (!selected || !oneImprovementProofs) return null;
    const declaredRef = surface?.taskId === selected.taskId
      ? surface.blocks.find((block) => block.type === "ImprovementProof")?.improvementProofRef ?? null
      : null;
    const taskProofs = oneImprovementProofs.proofs.filter((record) =>
      record.proof.taskId === selected.taskId
      && record.currentTaskVersion === selected.canonicalVersion);
    if (declaredRef) {
      return taskProofs.find((record) => record.proof.improvementProofId === declaredRef) ?? null;
    }
    return taskProofs
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }, [oneImprovementProofs, selected, surface]);
  const selectedExperienceReuse = useMemo(() => {
    if (!selected || !selectedValueClosure || !oneExperienceReuse) return null;
    return oneExperienceReuse.receipts
      .filter((record) =>
        record.receipt.taskId === selected.taskId
        && record.receipt.taskVersion === selected.canonicalVersion
        && record.receipt.valueClosureId === selectedValueClosure.closure.valueClosureId
        && record.receipt.valueClosureVersion === selectedValueClosure.version)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }, [oneExperienceReuse, selected, selectedValueClosure]);
  // 표시 규칙은 one-decision-receipt.ts가 단독으로 갖는다 — 지나간 선택이 대화 맨
  // 아래에 눌어붙던 회귀(제보 2026-08-13)를 그 규칙의 케이스 게이트가 지킨다.
  const latestCommittedAnswer = useMemo(() => (
    selected?.chatId
      ? visibleDecisionReceipt(committedAnswers, messages, {
          hasPendingConfirmation: Boolean(selectedPendingConfirmation),
        })
      : null
  ), [committedAnswers, messages, selected?.chatId, selectedPendingConfirmation]);
  const executionAvailable = Boolean(ipc());
  const connectedMobileDeviceIds = mobileStatus?.connectedDeviceIds ?? [];
  const connectedMobile = Boolean(
    mobileStatus?.running
    && mobileStatus.devices.some((device) =>
      !device.revokedAt && connectedMobileDeviceIds.includes(device.deviceId)),
  );
  const connectionLabel = !executionAvailable
    ? tFor(appLocale, "one.shell.conn.disconnected")
    : connectedMobile
      ? tFor(appLocale, "one.shell.conn.mobile_connected")
      : tFor(appLocale, "one.shell.conn.desktop_ready");
  // One opens as a conversation, not an onboarding/upgrade card. Activation
  // state remains durable in Main for continuity, but it never owns the home
  // surface or suppresses One's greeting.
  const activationForeground = false;
  const activationBlocksIntro = false;
  const showWeeklyReflection = shouldPresentOneWeeklyReflection({
    onHome: !selected && !conversation,
    hasOpenReflection: oneWeeklyReflection?.reflection?.status === "open",
    activationForeground,
    busy,
    briefingKind: briefing.kind,
    hasProactiveBriefing: Boolean(briefing.proactive),
  });
  const oneIntroPending = Boolean(
    oneIntroState
    && oneIntroState.acknowledgedIntroVersion < oneIntroState.currentIntroVersion,
  );
  const introBlockingCategory: OneFeatureIntroBlockingStateCategory | null = !oneIntroPending
    ? null
    : !loaded
      ? "authority_unknown"
      : actionableConfirmations.length > 0
        ? "pending_approval"
        : activeChatIds.length > 0
          ? "active_task"
          : error
            ? "blocking_error"
            : UPDATE_BLOCKING_STATES.has(updaterState?.status ?? "idle")
              ? "app_update"
              : selected?.status.value === "failed"
                ? "failed_task"
                : activationBlocksIntro
                  ? "route_ineligible"
                : null;
  // Memory Map is the first and stable One surface. Product education remains
  // available explicitly from "About One" via replayToken, but it must never
  // interrupt a fresh launch or cover the map automatically.
  const introEligible = false;
  const presentRichOutputRail = useCallback(() => {
    setContextRailOpen(true);
    requestReadableContextRailWidth(preferredContextResultWidth());
  }, [requestReadableContextRailWidth, setContextRailOpen]);
  const focusOneOutput = useCallback(() => {
    presentRichOutputRail();
    window.requestAnimationFrame(() => {
      resultTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [presentRichOutputRail]);
  // Browser execution must be visible in the current task. TaskSidePanel owns
  // the scoped event and tab selection; the shell only reveals its container.
  const presentBrowserOutput = useCallback((url: string) => {
    void url;
    presentRichOutputRail();
  }, [presentRichOutputRail]);
  /*
   * 산출물이나 터미널 기록이 하나라도 있으면 오른쪽 패널을 저 혼자 열던 자리
   * (제거, 오너 지시 2026-08-24 "우측사이드바 디폴트로 접히고"). 열림 상태가
   * 저장까지 돼서, 한 번 무언가를 만든 뒤로는 모든 대화가 패널을 편 채로
   * 시작했다(실측: 지운 직후에도 다시 true 로 저장됨). 결과는 이제 대화 안의
   * 결과 카드로 알리고, 패널은 사람이 열 때 열린다.
   */
  const openCreateAgentDialog = useCallback((seed?: OneAgentDraftSeed) => {
    if (seed) {
      createAgentSeedTokenRef.current += 1;
      setCreateAgentSeed({
        token: createAgentSeedTokenRef.current,
        name: seed.name,
        title: seed.title,
        description: seed.description,
      });
    } else {
      setCreateAgentSeed(null);
    }
    setCreateAgentOpen(true);
  }, []);
  const handleOneSemanticAction = useCallback((action: OneSurfaceSemanticAction) => {
    if (!action.enabled || busy) return;
    if (action.intent === "open_work") {
      focusOneOutput();
      return;
    }
    if (action.intent === "open_asset") {
      const kind = action.targetRef?.split(":", 1)[0];
      if (kind === "agent") router.push("/library/agents");
      else if (kind === "team") router.push("/library/agents");
      else if (kind === "automation") {
        const request = action.instruction || action.description || action.label;
        setComposer(`@graph ${request}`);
        window.requestAnimationFrame(() => composerInputRef.current?.focus());
      } else focusOneOutput();
      return;
    }
    if (action.intent === "run_automation" || action.intent === "open_automation") {
      // targetRef carries the registered automation id (optionally namespaced
      // "automation:<id>"). Work Graph stays the background engine; One keeps
      // the person in the conversation and renders the state here.
      const rawRef = action.targetRef ?? "";
      const automationId = rawRef.startsWith("automation:") ? rawRef.slice("automation:".length) : rawRef;
      if (action.intent === "run_automation" && automationId) {
        const api = ipc();
        if (!api) {
          setActionNotice(appLocale === "ko"
            ? "Desktop에 연결되지 않아 자동화를 실행하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
            : "The automation did not run because Desktop is unavailable. Check the connection and try again.");
          return;
        }
        if (automationRunPendingRef.current.has(automationId)) {
          setActionNotice(appLocale === "ko"
            ? "이 자동화의 실행 결과를 확인하는 중입니다."
            : "Waiting for this automation's run result.");
          return;
        }
        automationRunPendingRef.current.add(automationId);
        setActionNotice(appLocale === "ko" ? "자동화를 실행하고 최종 상태를 확인하는 중입니다…" : "Running the automation and checking its final status…");
        void api.automations.runNow(automationId).then((result) => {
          if (!result?.accepted || result.automationId !== automationId || !result.status) {
            throw new Error(result?.error || "automation_run_receipt_incomplete");
          }
          const safeOutput = toCustomerSafeText(result.output, appLocale).slice(0, 1_200);
          const safeError = toCustomerSafeText(result.error, appLocale).slice(0, 600);
          const actualResult = [safeOutput, safeError && safeError !== safeOutput ? safeError : ""]
            .filter(Boolean)
            .join(" · ");
          if (actualResult) {
            setActionNotice(appLocale === "ko"
              ? `자동화 실행 결과(${result.status}): ${actualResult}`
              : `Automation result (${result.status}): ${actualResult}`);
            return;
          }
          // A terminal receipt without a safe textual result still has a
          // durable graph/run history. Open that exact automation instead of
          // reducing a real action to a generic "completed" toast.
          router.push(`/automation/flow?id=${encodeURIComponent(automationId)}`);
        }).catch((cause: unknown) => {
          const raw = cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
            : "";
          if (/reconciliation_pending|ambiguous_side_effect|reconciliation required/i.test(raw)) {
            setActionNotice(appLocale === "ko"
              ? "이전 실행의 실제 결과를 먼저 확정해 주세요. 중복 동작을 막기 위해 새 실행은 시작하지 않았습니다."
              : "Confirm the previous run's actual result first. A new run was not started to prevent duplicate actions.");
          } else {
            const detail = toCustomerSafeText(raw, appLocale);
            setActionNotice(detail || (appLocale === "ko"
              ? "자동화를 실행하지 못했습니다. 실행 기록과 연결 상태를 확인한 뒤 다시 시도해 주세요."
              : "The automation did not run. Check its run history and connections, then try again."));
          }
        }).finally(() => {
          automationRunPendingRef.current.delete(automationId);
        });
      } else {
        const request = action.instruction || action.description || action.label;
        setComposer(`@graph ${request}`);
        window.requestAnimationFrame(() => composerInputRef.current?.focus());
      }
      return;
    }
    if (action.intent === "open_build") {
      openCreateAgentDialog({
        name: action.label || (appLocale === "ko" ? "새 에이전트" : "New agent"),
        title: action.description,
        description: action.instruction,
      });
      return;
    }
    if (action.intent === "toggle_mcp_server") {
      // The MCP card carries its own per-server toggle; the semantic action is
      // the fallback route to the library screen where keys/toggles live.
      router.push("/library/mcps");
      return;
    }
    if (!["try_result", "refine_result", "reuse_result", "prepare_share"].includes(action.intent)) {
      if (action.instruction) {
        setComposer(action.instruction);
        window.requestAnimationFrame(() => composerInputRef.current?.focus());
      } else focusOneOutput();
      return;
    }
    const chatId = selected?.chatId ?? conversation?.id;
    if (!chatId || !action.instruction) return;
    void startRun(
      chatId,
      selected?.taskId ?? null,
      selected?.canonicalVersion ?? null,
      action.instruction,
      selected ? "task" : "conversation",
      { displayUserMessage: false },
    );
  }, [appLocale, busy, conversation?.id, focusOneOutput, openCreateAgentDialog, router, selected, startRun]);
  const acceptSelectedResult = useCallback(async () => {
    const api = ipc();
    if (
      !api
      || !selected
      || selected.canonicalStatus !== "partial"
      || !selected.chatId
      || !receipt
      || receipt.status !== "completed"
      || receipt.chatId !== selected.chatId
    ) throw new Error("Result acceptance is no longer available");
    await api.tasks.acceptResult({
      taskId: selected.taskId,
      expectedRunId: receipt.runId,
      expectedVersion: selected.canonicalVersion,
    });
    window.dispatchEvent(new CustomEvent("agentlas:tasks-changed"));
    await refreshAll();
  }, [receipt, refreshAll, selected]);
  const selectedCanContinueInPlace = Boolean(
    selected?.chatId && ["partial", "completed", "failed"].includes(selected.canonicalStatus ?? ""),
  );
  const selectedCanSteerActiveRun = Boolean(busy && selected?.chatId);
  const selectedReadOnly = Boolean(
    selected
    && !selectedCanSteerActiveRun
    && (!selected.chatId || (!selected.truth.mayStartExecution && !selectedCanContinueInPlace)),
  );
  // PRD §4.14 — 만료 판정이 **읽을 때만** 일어나서, 화면의 카드는 만료 뒤에도 눌렸다.
  // 화면도 시각으로 판단한다(제안 수명은 30분이다).
  const teamPreflightExpired = Boolean(teamPreflight && isOneTeamPreflightExpired(teamPreflight, nowTick));
  const teamDecisionPending = Boolean(
    teamPreflight
    && !teamPreflightExpired
    && isOneTeamPreflightPendingStatus(teamPreflight.status),
  );
  // A just-created home run briefly enters preflight before its chat binding
  // arrives. Keep next-turn settings interactive throughout that phase and an
  // attached live run. Only message submission waits for an unresolved staffing
  // decision; settled read-only history locks both surfaces.
  const composerSettingsBlocked = !busy && !teamPreflightBusy && (selectedReadOnly || activeDirectSessionUnavailable);
  const composerInteractionBlocked = composerSettingsBlocked || teamDecisionPending || activeDirectSessionUnavailable;
  // Attachments cannot be steered into an existing or still-preparing run in
  // v1. Keep that single boundary explicit instead of dimming every control.
  const composerAttachmentBlocked = busy || teamPreflightBusy || selectedReadOnly || teamDecisionPending || activeDirectSessionUnavailable;
  const oneDisplayName = oneProfile?.displayName.trim() || "One";
  /*
   * One 의 얼굴. 프로필에서 고른 캐릭터가 있으면 그것이고, 없으면 지금까지의 기본이다.
   * 고를 수 있게 만들어 놓고 화면이 옛 얼굴을 계속 그리면 그 기능은 없는 것과 같다.
   */
  const oneAvatarTone = oneProfile?.avatarIcon?.trim() || "character:orange-dino";
  // A direct room belongs to its seated agent; the general room and a taskforce
  // synthesis belong to One. Never borrow either identity for user messages.
  const assistantSpeaker = activeTaskforce
    ? { label: "One", tone: oneAvatarTone, status: "quiet" as const }
    : activeOneMember
      ? { label: activeOneMember.displayName, tone: activeOneMember.icon, status: activeOneMember.statusKind }
      : { label: "One", tone: oneAvatarTone, status: "quiet" as const };
  const removeAttachmentDraft = useCallback((id: string) => {
    const current = attachmentDraftsRef.current;
    const removed = current.find((item) => item.id === id);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    const next = current.filter((item) => item.id !== id);
    attachmentDraftsRef.current = next;
    setAttachmentDrafts(next);
    setAttachmentError(null);
  }, []);
  const addAttachmentFiles = useCallback(async (files: FileList | File[]) => {
    if (busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy) {
      setAttachmentError(tFor(appLocale, "one.shell.attach.busy_error"));
      return;
    }
    const incoming = Array.from(files);
    const current = attachmentDraftsRef.current;
    if (current.length + incoming.length > ONE_ATTACHMENT_LIMITS.maxCount) {
      setAttachmentError(tFor(appLocale, "one.shell.attach.max_count", { max: ONE_ATTACHMENT_LIMITS.maxCount }));
      return;
    }
    const next: OneAttachmentDraft[] = [];
    let totalBytes = current.reduce((sum, item) => sum + item.size, 0);
    const errors: string[] = [];
    for (const file of incoming) {
      let kind: OneAttachmentDraft["kind"] = attachmentKind(file);
      const perFileLimit = kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes;
      if (file.size > perFileLimit) {
        errors.push(tFor(appLocale, "one.shell.attach.file_limit", { name: file.name, limit: kind === "image" ? tFor(appLocale, "one.shell.attach.limit_image") : tFor(appLocale, "one.shell.attach.limit_file") }));
        continue;
      }
      if (totalBytes + file.size > ONE_ATTACHMENT_LIMITS.maxTotalBytes) {
        errors.push(tFor(appLocale, "one.shell.attach.total_limit", { name: file.name }));
        continue;
      }
      // Finder에서 복사한 파일은 preload가 실제 경로 capability를 받는다. 스크린샷,
      // 오디오·비디오와 브라우저가 만든 파일은 경로가 없으므로 Main이 허용 형식의
      // 바이트만 private staging으로 고정해 동일한 exact-file capability를 발급한다.
      const grant = await grantForDroppedFile(file)
        ?? await grantForPastedAttachment(file)
        // 이전 preload와의 일시적 호환: 새 bridge가 아직 없더라도 이미지 붙여넣기는 유지.
        ?? (kind === "image" ? await grantForPastedImage(file) : null);
      if (!grant || grant.kind !== "file") {
        if (!grant || grant.kind !== "directory") {
          errors.push(tFor(appLocale, "one.shell.attach.not_regular_file", { name: attachmentDisplayName(file, appLocale) }));
          continue;
        }
        kind = "directory";
      }
      const previewUrl = kind === "image" ? URL.createObjectURL(file) : null;
      next.push({
        id: uid(),
        grant,
        name: attachmentDisplayName(file, appLocale),
        mediaType: kind === "directory" ? "application/vnd.agentlas.directory+json" : file.type,
        size: file.size,
        kind,
        previewUrl,
      });
      totalBytes += file.size;
    }
    if (next.length > 0) {
      const merged = [...attachmentDraftsRef.current, ...next];
      attachmentDraftsRef.current = merged;
      setAttachmentDrafts(merged);
    }
    setAttachmentError(errors.length ? errors.join(" ") : null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  }, [busy, appLocale, selectedReadOnly, teamDecisionPending, teamPreflightBusy]);

  useEffect(() => {
    const nextThread = activeThreadChatId ?? "new";
    if (attachmentThreadRef.current && attachmentThreadRef.current !== nextThread) clearAttachmentDrafts();
    attachmentThreadRef.current = nextThread;
  }, [activeThreadChatId, clearAttachmentDrafts]);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const closeMemory = useCallback(() => setMemoryOpen(false), []);
  const handleProfileChange = useCallback((profile: OneProfile) => setOneProfile(profile), []);
  const handleMemoryChange = useCallback((memory: OneMemoryState) => setOneMemory(memory), []);
  const handleMemoryUseOnceReady = useCallback((
    receipt: OneMemoryUseOnceReceipt,
    target: OneMemoryUseOnceTarget,
  ) => {
    setArmedOneMemoryUseOnce({ receipt, targetKey: oneMemoryUseOnceTargetKey(target) });
  }, []);
  const handleSuggestionsChange = useCallback((suggestions: OneSuggestionState) => setOneSuggestions(suggestions), []);
  const handleValueClosuresChange = useCallback((valueClosures: OneValueClosureState) => {
    setOneValueClosures(valueClosures);
    void ipc()?.oneWeeklyReflection.get().then(setOneWeeklyReflection).catch(() => undefined);
  }, []);
  const acknowledgeOneIntro = useCallback(async (resolution: OneFeatureIntroResolution) => {
    const api = ipc();
    if (!api?.oneFeatureIntro || !oneIntroState) return;
    let current = oneIntroState;
    if (current.acknowledgedIntroVersion >= current.currentIntroVersion) return;
    try {
      const next = await api.oneFeatureIntro.acknowledge({
        expectedStoreVersion: current.version,
        introVersion: current.currentIntroVersion,
        resolution,
        confirmedByUser: true,
      });
      setOneIntroState(next);
    } catch (cause) {
      requestOneOperationalRecovery("one-feature-intro", cause);
      try {
        current = await api.oneFeatureIntro.getState();
        if (current.acknowledgedIntroVersion >= current.currentIntroVersion) {
          setOneIntroState(current);
          return;
        }
        const next = await api.oneFeatureIntro.acknowledge({
          expectedStoreVersion: current.version,
          introVersion: current.currentIntroVersion,
          resolution,
          confirmedByUser: true,
        });
        setOneIntroState(next);
      } catch (retryCause) {
        requestOneOperationalRecovery("one-feature-intro", retryCause);
      }
    }
  }, [oneIntroState]);
  const manageImprovementAsset = useCallback((asset: OneImprovementReusedAssetV1) => {
    if (asset.assetType === "memory") {
      setProfileOpen(false);
      setMemoryOpen(true);
      return;
    }
    if (asset.assetType === "automation") {
      setComposer(`@graph ${appLocale === "ko" ? "이 자동화를 검토하고 필요한 변경을 제안해줘" : "Review this automation and propose any needed changes"}: ${asset.assetRef}`);
      window.requestAnimationFrame(() => composerInputRef.current?.focus());
      return;
    }
    if (asset.assetType === "team") {
      router.push(`/library/agents?agentId=${encodeURIComponent(asset.assetRef)}`);
      return;
    }
    if (asset.assetType === "agent") {
      router.push("/library/agents");
      return;
    }
    focusOneOutput();
  }, [appLocale, focusOneOutput, router]);
  /*
   * 브리핑이 찾아낸 것을 One 이 **실제로 살펴보게** 한다.
   *
   * main 쪽에는 준비·예약·클레임·실패 라이프사이클이 완성돼 있었는데
   * (`electron/one/briefing-actions.ts`), 그 파이프라인의 유일한 열쇠인
   * `oneBriefingActionRef` 를 만드는 `oneBriefing:startAction` 을 렌더러가 **한 번도
   * 부르지 않았다**(2026-07-28 실측: `startAction` 문자열이 렌더러에 0건). 그래서
   * 브리핑 버튼은 항상 화면 이동만 했고, 800줄짜리 실행 경로는 어떤 조작으로도
   * 도달할 수 없었다.
   *
   * 계약이 `confirmedByUser: true` 를 리터럴로 요구한다 — 준비된 것을 보여주고 사용자가
   * 승낙해야 시작한다는 뜻이다. 그래서 준비(prepare) 와 시작(start) 을 두 단계로 둔다.
   * 실행은 `permission: "read"` 로 고정돼 있어 살펴보기만 하고 아무것도 바꾸지 않는다.
   */
  const [pendingBriefingAction, setPendingBriefingAction] = useState<OneBriefingActionPacket | null>(null);
  const pendingBriefingActionVisible = Boolean(
    pendingBriefingAction
    && briefing.proactive
    && pendingBriefingAction.candidateId === briefing.proactive.candidateId,
  );
  useEffect(() => {
    if (pendingBriefingAction && pendingBriefingAction.candidateId !== briefing.proactive?.candidateId) {
      // A prepared packet belongs to one exact detector receipt. Never leave
      // its confirmation attached to a newer or different home briefing.
      setPendingBriefingAction(null);
    }
  }, [briefing.proactive?.candidateId, pendingBriefingAction]);
  const reviewPreparedFinding = useCallback(async (candidate: OneProactiveBriefing) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-prepared-finding", new Error("Desktop bridge unavailable"));
      return;
    }
    setBriefingActionBusy(true);
    setError(null);
    try {
      const packet = await api.oneBriefing.prepareAction({
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
      });
      setPendingBriefingAction(packet);
    } catch (cause) {
      requestOneOperationalRecovery("one-prepared-finding", cause);
      setError(null);
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [refreshAll]);

  const confirmBriefingAction = useCallback(async () => {
    const api = ipc();
    const packet = pendingBriefingAction;
    if (!packet) return;
    if (!api) {
      requestOneOperationalRecovery("one-prepared-finding", new Error("Desktop bridge unavailable"));
      return;
    }
    setBriefingActionBusy(true);
    setError(null);
    try {
      const result = await api.oneBriefing.startAction({
        packetId: packet.packetId,
        expectedPacketVersion: packet.version,
        candidateId: packet.candidateId,
        expectedDetectedAt: packet.expectedDetectedAt,
        confirmedByUser: true,
      });
      setPendingBriefingAction(null);
      if (!result.ok) {
        setError(null);
        requestOneOperationalRecovery("one-prepared-finding-start", result);
      }
      await refreshAll();
    } catch (cause) {
      requestOneOperationalRecovery("one-prepared-finding", cause);
      setError(null);
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [pendingBriefingAction, refreshAll, appLocale]);

  const openPreparedFinding = useCallback((candidate: OneProactiveBriefing) => {
    if (candidate.preparedAction.kind === "open_task") return;
    const target = candidate.preparedAction.targetId;
    setComposer(candidate.preparedAction.kind === "open_project"
      ? (appLocale === "ko" ? `이 프로젝트를 One 안에서 검토해줘: ${target}` : `Review this project here in One: ${target}`)
      : `@graph ${appLocale === "ko" ? "이 자동화를 One 안에서 검토해줘" : "Review this automation here in One"}: ${target}`);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [appLocale]);
  const openProactiveTask = useCallback(async (candidate: OneProactiveBriefing) => {
    const api = ipc();
    if (candidate.source.kind !== "canonical_task" || candidate.preparedAction.kind !== "open_task") return;
    if (!api) {
      requestOneOperationalRecovery("one-prepared-finding", new Error("Desktop bridge unavailable"));
      return;
    }
    setBriefingActionBusy(true);
    setError(null);
    try {
      const exact = await api.oneBriefing.openTask({
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
        expectedTaskId: candidate.source.refId,
        expectedTaskVersion: candidate.source.taskVersion,
      });
      openTask(exact.taskId);
    } catch (cause) {
      requestOneOperationalRecovery("one-prepared-finding", cause);
      setError(null);
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [openTask, refreshAll]);
  const applyProactiveFeedback = useCallback(async (candidate: OneProactiveBriefing, feedback: "later" | "not_important" | "wrong") => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-prepared-finding", new Error("Desktop bridge unavailable"));
      return;
    }
    setError(null);
    try {
      const next = await api.oneBriefing.feedback({
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
        feedback,
      });
      setBriefingSnapshot(safeBriefingSnapshot(next));
    } catch (cause) {
      requestOneOperationalRecovery("one-prepared-finding", cause);
      setError(null);
      await refreshAll();
    }
  }, [refreshAll]);

  useEffect(() => {
    const api = ipc();
    const state = oneIntroState;
    const category = introBlockingCategory;
    if (!api?.oneFeatureIntro || !state || !category || !oneIntroPending) return;
    if (state.deferrals.some((item) =>
      item.introVersion === state.currentIntroVersion
      && item.blockingStateCategory === category)) return;
    const requestKey = `${state.currentIntroVersion}:${category}`;
    if (introDeferralInFlightRef.current === requestKey) return;
    introDeferralInFlightRef.current = requestKey;
    void api.oneFeatureIntro.defer({
      expectedStoreVersion: state.version,
      introVersion: state.currentIntroVersion,
      blockingStateCategory: category,
    }).then(setOneIntroState).catch(async () => {
      const latest = await api.oneFeatureIntro.getState().catch(() => null);
      if (latest) setOneIntroState(latest);
    }).finally(() => {
      if (introDeferralInFlightRef.current === requestKey) {
        introDeferralInFlightRef.current = null;
      }
    });
  }, [introBlockingCategory, oneIntroPending, oneIntroState]);

  if (!loaded) {
    return <div className={styles.shell}><div className={styles.loadingShell} role="status" aria-live="polite">
      <aside className={styles.loadingRail}><span className={styles.loadingBrand} /><span /><span /><span /><span /></aside>
      <main className={styles.loadingWorkspace}><span className={styles.loadingSpinner} aria-hidden="true" /><strong>{tFor(appLocale, "one.shell.loading")}</strong><small>{appLocale === "ko" ? "조직, 대화, 태스크포스와 기록을 안전하게 불러오고 있습니다." : "Loading your organisation, chats, Taskforces, and history."}</small><LoadingEstimate locale={appLocale} operationKey="one-shell-startup" expectedSeconds={[2, 30]} /><div><i /><i /><i /></div></main>
      <aside className={styles.loadingContext}><span /><span /><span /><span /></aside>
    </div></div>;
  }

  return (
    <div className={styles.shell}>
      <div
        className={styles.body}
        data-rail-collapsed={railCollapsed ? "true" : "false"}
        data-rail-open={railOpen ? "true" : "false"}
        data-context-rail={(selected || conversation) && contextRailOpen ? "true" : "false"}
        data-context-rail-kind={oneOutputKind}
        data-task-active={selected || conversation ? "true" : "false"}
        data-home={!selected && !conversation ? "true" : "false"}
        data-home-history={!selected && !conversation ? (homeHistoryOpen ? "open" : "closed") : undefined}
        data-rail-mode={railMode}
        style={{ "--one-rail-width": `${contextRailWidth}px` } as CSSProperties}
      >
        {railOpen && <button type="button" className={styles.railScrim} aria-label={tFor(appLocale, "one.shell.rail.close_history_aria")} onClick={() => setRailOpen(false)} />}
        <aside
          className={styles.rail}
          data-open={railOpen ? "true" : "false"}
          aria-label={tFor(appLocale, "one.shell.rail.aria")}
          aria-hidden={railCollapsed && !railOpen ? "true" : undefined}
          inert={railCollapsed && !railOpen ? true : undefined}
        >
          {/* macOS 신호등 옆 48px는 창을 잡는 손잡이다. 이 스트립이 없으면 One
              화면에서는 창을 옮길 곳이 한 군데도 없다(다른 화면은 SideNav가 같은
              역할을 한다). */}
          <div className={`${styles.railDrag} titlebar-drag`} aria-hidden="true" />
          <div className={`${styles.railProduct} titlebar-nodrag`}>
            <ProductModeMenu current="one" darkText locale={appLocale} />
            <button
              type="button"
              className={styles.railCollapseButton}
              aria-label={tFor(appLocale, "one.shell.rail.collapse_aria")}
              onClick={() => {
                setRailCollapsed(true);
                setRailOpen(false);
                window.requestAnimationFrame(() => railRevealButtonRef.current?.focus());
              }}
            ><IconSidebar size={16} /></button>
          </div>
          {railMode !== "settings" ? <>
            {/* 대화 목록은 하루에 수십 번 오가는 곳이라 화면 뒤로 숨기지 않는다. 레일이
                조직도로 차 있으므로 탭으로 나누되, 나가지 않고 한 화면 안에 남긴다. */}
            <div className={styles.railTabs} role="tablist" aria-label={appLocale === "ko" ? "레일 보기" : "Rail view"}>
              <button type="button" role="tab" aria-selected={railMode === "organisation"} data-active={railMode === "organisation" ? "true" : "false"} onClick={() => setRailMode("organisation")}>{appLocale === "ko" ? "조직" : "Team"}</button>
              <button
                type="button"
                role="tab"
                aria-selected={railMode === "sessions"}
                aria-label={hasOtherSessionAttention ? (appLocale === "ko" ? "세션 · 다른 세션에 알림 있음" : "Sessions · another session needs attention") : undefined}
                data-active={railMode === "sessions" ? "true" : "false"}
                onClick={() => setRailMode("sessions")}
              ><span className={styles.railTabLabel}>{appLocale === "ko" ? "세션" : "Sessions"}{hasOtherSessionAttention && <span className={styles.railTabAlertDot} aria-hidden="true" />}</span></button>
            </div>
            {railMode === "organisation" ? <>
            <OneTaskforceRail
              oneAvatarIcon={oneAvatarTone}
              taskforces={taskforces}
              org={oneOrgState}
              activeChatId={activeThreadChatId}
              locale={appLocale}
              onOpen={openTaskforce}
              onCreate={() => {
                setTaskforceEditingId(null);
                setTaskforceDialogOpen(true);
              }}
            />
            <OneOrgChart
              oneAvatarIcon={oneAvatarTone}
              state={oneOrgState ?? (!ipc() ? oneOrgBrowserPreviewState() : null)}
              installedAgents={availableAgents}
              cloudListings={cloudListings}
              hubBookmarks={hubBookmarks}
              inventoryLoading={inventoryLoading}
              accountSignedIn={accountSignedIn}
              locale={appLocale}
              addRequest={agentPickerRequest}
              onAdd={addOneOrg}
              onAddExistingComplete={() => {
                setCreateAgentOpen(false);
                setCreateAgentSeed(null);
              }}
              onCreateAgent={() => openCreateAgentDialog()}
              onMaterializeSource={materializeOneOrgSource}
              onRename={renameOneOrg}
              onUpdate={updateOneOrg}
              onReplace={replaceOneOrg}
              onArchive={archiveOneOrg}
              onRestore={restoreOneOrg}
              onReorder={reorderOneOrg}
              onFailure={openOneFailure}
              onOpenMember={openOneMember}
              onOpenOne={openLatestOneSession}
              onEditOne={() => {
                // One 도 팀원과 같은 창에서 고친다. "지킬 것" 목록만 기존 프로필 창에 남는다.
                setMemoryOpen(false);
                setEditOneTarget({
                  displayName: oneProfile?.displayName ?? "One",
                  role: oneProfile?.role ?? "Agentlas One",
                  profileContext: oneProfile?.profileContext ?? "",
                  avatarIcon: oneProfile?.avatarIcon ?? "",
                  expectedVersion: oneProfile?.version ?? 0,
                });
                setCreateAgentOpen(true);
              }}
              onEditIdentity={(member) => {
                // 이름·캐릭터는 '에이전트 만들기'와 같은 창에서 고친다(오너 지적 2026-08-23).
                setEditMemberTarget({
                  memberId: member.id,
                  displayName: member.displayName,
                  icon: member.icon,
                  collaborationStyle: member.collaborationStyle ?? "default",
                  title: member.title ?? "",
                  description: member.description ?? "",
                  identityEditable: Boolean(member.identityEditable),
                  runtimeSelection: member.runtimeSelection ?? null,
                  revision: member.revision,
                });
                setCreateAgentOpen(true);
              }}
              sheetRequest={orgSheetRequest ?? undefined}
              activeOne={activeOneSelected}
              activeMemberId={activeOneMember?.installedAgentId ?? null}
              activeTaskForceIds={turnAgentIds}
              installedPlugins={installedPlugins}
              pluginCatalog={pluginCatalog}
              pluginStatuses={pluginStatuses}
              onSetAutoSelect={setOneOrgAutoSelect}
              onConnectTool={() => { setSettingsSheet("mcp"); }}
              onBrowseTools={() => { setSettingsSheet("plugins"); }}
              onBrowseSource={(source) => router.push(source === "cloud" ? "/library/agents?tab=cloud" : "/marketplace")}
              onBrowseCredits={() => router.push("/cloud")}
              onOpenConcurrency={() => setSettingsSheet("concurrency")}
              conversationResults={oneOrgConversationResults}
              historyResults={oneOrgHistoryResults}
              onOpenConversation={openConversation}
              onOpenHistory={(item) => {
                startNewConversation();
                setComposer(appLocale === "ko"
                  ? `이 컴퓨터 기록을 근거로 반복 작업을 분석해줘: ${item.title}`
                  : `Analyze this computer-history item for repeated work: ${item.title}`);
              }}
            />
            </> : <>
            <div className={styles.railPrimaryActions}>
              <button type="button" className={styles.railPrimaryButton} onClick={startNewConversation}><span aria-hidden="true"><IconPlus size={13} /></span>{tFor(appLocale, "one.shell.rail.new_conversation")}</button>
              <button ref={searchTriggerRef} type="button" className={styles.railPrimaryButton} onClick={() => setSearchOpen(true)}><span aria-hidden="true"><IconSearch size={13} /></span>{tFor(appLocale, "one.shell.rail.search_all")}</button>
            </div>
            {sessionGroups.rows.length === 0 && (
              <div className={styles.railEmpty}>{appLocale === "ko" ? "아직 대화가 없어요. 위에서 새 대화를 시작하세요." : "No conversations yet. Start one above."}</div>
            )}
            <div className={styles.railList} data-one-session-list="latest-first">
              {sessionGroups.rows.map((row) => (row.chat ? (
                <ConversationListButton
                  key={row.key}
                  item={row.chat}
                  active={row.chat.id === selectedConversationId || (row.task ? row.task.taskId === selectedTaskId : false)}
                  locale={appLocale}
                  onOpen={openConversation}
                  onRemove={removeConversation}
                  seatLabel={seatLabelForChat(row.chat, taskforces, oneOrgState, appLocale)}
                  running={activeChatIds.includes(row.chat.id)}
                  unavailable={directSessionUnavailable(row.chat, oneOrgState)}
                  member={oneOrgState?.members.find((member) => member.installedAgentId === row.chat!.agentId) ?? null}
                  groupMembers={(taskforces.find((taskforce) => taskforce.chatId === row.chat!.id)?.memberAgentIds ?? [])
                    .map((agentId) => oneOrgState?.members.find((member) => member.installedAgentId === agentId))
                    .filter((member): member is OneOrgMember => Boolean(member))}
                  oneAvatarTone={oneAvatarTone}
                />
              ) : row.task ? (
                <TaskListButton key={row.key} item={row.task} active={row.task.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />
              ) : null))}
            </div>
            </>}
            {selected && <nav className={`${styles.railUtilities} ${styles.railTaskActions}`} aria-label={tFor(appLocale, "one.shell.rail.manage_task_aria")}>
              <button type="button" disabled={archiveMutationTaskId === selected.taskId || Boolean(selected.chatId && activeChatIds.includes(selected.chatId))} onClick={() => void mutateTaskArchive(selected.taskId, selected.canonicalStatus === "archived" ? "restore" : "archive")}>{selected.canonicalStatus === "archived" ? tFor(appLocale, "one.shell.rail.restore_from_archive") : tFor(appLocale, "one.shell.rail.archive_this_work")}</button>
            </nav>}
            <div className={styles.railBottomMenu}>
              <button type="button" onClick={() => setRailMode("settings")}><span><IconSettings size={15} />{appLocale === "ko" ? "설정" : "Settings"}</span><IconChevronDown size={12} /></button>
              <button type="button" onClick={() => { setMemoryOpen(false); setProfileOpen(true); }}><span className={styles.railAccountMark}>{oneDisplayName.slice(0, 1).toLocaleUpperCase()}</span><span>{oneDisplayName}</span></button>
              <span className={styles.connection} data-offline={!executionAvailable ? "true" : "false"} role="status"><span className={styles.connectionDot} aria-hidden="true" /><span>{connectionLabel}</span></span>
            </div>
          </> : <OneSettingsRail
            locale={appLocale}
            profileName={oneDisplayName}
            pendingMemoryCount={oneMemory?.candidates.filter((candidate) => candidate.status === "pending").length ?? 0}
            onBack={() => setRailMode("organisation")}
            onOpen={(setting) => {
              // Permission is a composer decision. Keep it anchored to the
              // input so the control stays beside the action it governs.
              if (setting === "permission") {
                setSettingsSheet(null);
                setComposerMenu("permission");
                return;
              }
              setSettingsSheet(setting);
            }}
            onOpenProfile={() => { setMemoryOpen(false); setProfileOpen(true); }}
            onOpenMemory={() => { setProfileOpen(false); setMemoryOpen(true); }}
            onToggleLocale={() => setPref(appLocale === "ko" ? "en" : "ko")}
          />}
        </aside>

        <main
          className={styles.workspace}
          data-runtime-artifacts={runtimeArtifacts.length > 0 ? "true" : "false"}
          data-context-rail={(selected || conversation) && contextRailOpen ? "true" : "false"}
          data-context-rail-kind={oneOutputKind}
          data-split-active={splitPanes.length > 0 ? "true" : "false"}
          // 분할 폭 변수를 워크스페이스에도 실어야 툴바·컴포저 도크(무대 밖 형제)가
          // 메인 칸 폭을 알 수 있다 — 전체 폭 오버레이가 보조 칸을 덮으면 오른쪽
          // 칸이 조작 불능이 된다(D-5/D-6).
          style={splitPanes.length > 0 ? { ["--split-col" as string]: `${splitRatio.col}%` } : undefined}
        >
          <div className={`${styles.windowBar} titlebar-drag`}>
            {selected || conversation ? (
              <div className={`${styles.taskToolbar} titlebar-nodrag`}>
                <button
                  ref={railRevealButtonRef}
                  type="button"
                  className={styles.taskSidebarRevealButton}
                  aria-label={railOpen
                    ? (appLocale === "ko" ? "사이드바 닫기" : "Close sidebar")
                    : tFor(appLocale, "one.shell.workspace.open_sidebar_aria")}
                  aria-expanded={railOpen}
                  onClick={() => {
                    if (railOpen) {
                      setRailOpen(false);
                      return;
                    }
                    if (window.matchMedia("(max-width: 760px)").matches) {
                      setRailOpen(true);
                      return;
                    }
                    setRailCollapsed(false);
                    setRailOpen(false);
                  }}
                ><IconSidebar size={16} /></button>
                <span className={styles.taskToolbarDivider} aria-hidden="true" />
                <div className={styles.taskToolbarIdentity}>
                  {activeTaskforce ? <span className={styles.taskforceToolbarPortraits} aria-hidden="true">
                    <OneAgentPortrait status={busy ? "working" : "quiet"} label="One" tone={oneAvatarTone} size="small" />
                    {activeTaskforce.memberAgentIds.slice(0, 2).map((agentId) => {
                      const member = oneOrgState?.members.find((item) => item.installedAgentId === agentId);
                      const unavailable = memberUnavailable(member);
                      return <OneAgentPortrait key={agentId} status={unavailable || !member ? "locked" : member.statusKind} label={member?.displayName ?? "Unavailable"} tone={member?.icon ?? "blue"} size="small" />;
                    })}
                  </span> : activeSeatEmpty ? (
                    // 빈 자리는 점선 자리로 그린다 — 담당이 없는 것을 One 의 얼굴로 덮지 않는다(§4-2).
                    <span
                      className={styles.emptySeatPortrait}
                      data-one-empty-seat-portrait="true"
                      role="img"
                      aria-label={appLocale === "ko" ? "빈 자리" : "Empty seat"}
                      title={previousOccupantName
                        ? (appLocale === "ko" ? `빈 자리 · 이전 담당 ${previousOccupantName}` : `Empty seat · previously ${previousOccupantName}`)
                        : (appLocale === "ko" ? "빈 자리" : "Empty seat")}
                    />
                  ) : <OneAgentPortrait
                    status={busy ? "working" : visibleSelectedConfirmation ? "waiting" : activeOneMember?.statusKind ?? "quiet"}
                    label={activeOneMember?.displayName ?? "One"}
                    tone={activeOneMember?.icon ?? "character:orange-dino"}
                    size="medium"
                  />}
                  <span>
                    {/* 이름만 쓴다. "상주 동료 · 전용 터미널" 같은 설명 부제는 아무것도
                        알려주지 않으면서 이름 아래 자리를 차지했다(오너 결정 2026-08-24).
                        단톡방만 사람 수를 쓴다 — 그건 실제로 바뀌는 정보다. */}
                    <strong>{activeTaskforce?.title
                      ?? ((activeSeatDissolved || activeSeatEmpty) && activeSeat?.title?.trim() ? activeSeat.title.trim() : null)
                      ?? activeOneMember?.displayName
                      ?? (activeSeatEmpty ? previousOccupantName : null)
                      ?? "One"}</strong>
                    {activeDirectSessionUnavailable && <small data-one-session-unavailable="true">{appLocale === "ko" ? "에이전트 없음 · 기록만 열람 가능" : "Agent unavailable · history only"}</small>}
                    {!activeDirectSessionUnavailable && activeSeatDissolved && <small data-one-dissolved-badge="true">{appLocale === "ko" ? "해체됨 · 기록 보존" : "Dissolved · records kept"}</small>}
                    {!activeDirectSessionUnavailable && !activeSeatDissolved && activeSeatEmpty && <small data-one-empty-seat-badge="true">{appLocale === "ko"
                      ? (previousOccupantName ? `빈 자리 · 이전 담당 ${previousOccupantName}` : "빈 자리")
                      : (previousOccupantName ? `Empty seat · previously ${previousOccupantName}` : "Empty seat")}</small>}
                    {/* 명단 길이가 아니라 지금 말할 수 있는 사람을 센다 — 나간 팀원은 아바타만
                        회색이 되고 머릿수는 그대로였다(UX-D-7). 아바타를 회색으로 칠하는
                        바로 그 판정으로 센다. */}
                    {activeTaskforce && <small data-one-taskforce-count="true">{appLocale === "ko"
                      ? `One 포함 ${speakableCountIncludingOne(activeTaskforce.memberAgentIds, oneOrgState)}명`
                      : `${speakableCountIncludingOne(activeTaskforce.memberAgentIds, oneOrgState)} members incl. One`}</small>}
                  </span>
                </div>
                {activeTaskforce && <button
                  type="button"
                  className={styles.taskforceMembersButton}
                  onClick={() => {
                    setTaskforceEditingId(activeTaskforce.id);
                    setTaskforceDialogOpen(true);
                  }}
                  aria-label={appLocale === "ko" ? "태스크포스 멤버 관리" : "Manage Taskforce members"}
                ><IconUsers size={15} /><span data-one-taskforce-badge="true">{speakableCountIncludingOne(activeTaskforce.memberAgentIds, oneOrgState)}</span></button>}
                <button
                  type="button"
                  className={styles.taskToolbarOutputToggle}
                  data-one-output-toggle="true"
                  data-active={contextRailOpen ? "true" : "false"}
                  aria-label={contextRailOpen
                    ? (appLocale === "ko" ? "결과 패널 닫기" : "Close result panel")
                    : (appLocale === "ko" ? "결과 패널 열기" : "Open result panel")}
                  aria-expanded={contextRailOpen}
                  onClick={() => {
                    if (contextRailOpen) {
                      setContextRailOpen(false);
                      return;
                    }
                    presentRichOutputRail();
                  }}
                ><IconPanelRight size={16} /></button>
                <div className={styles.taskToolbarMenu} data-one-task-menu="true">
                  <button
                    type="button"
                    aria-label={appLocale === "ko" ? "작업 메뉴" : "Task menu"}
                    aria-haspopup="menu"
                    aria-expanded={taskMenuOpen}
                    onClick={() => setTaskMenuOpen((value) => !value)}
                  >{appLocale === "ko" ? "메뉴" : "MENU"}</button>
                  {taskMenuOpen && (
                    <div className={styles.taskToolbarMenuPopover} role="menu">
                      {selected && (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={archiveMutationTaskId === selected.taskId || Boolean(selected.chatId && activeChatIds.includes(selected.chatId))}
                          onClick={() => {
                            setTaskMenuOpen(false);
                            void mutateTaskArchive(selected.taskId, selected.canonicalStatus === "archived" ? "restore" : "archive");
                          }}
                        >
                          {selected.canonicalStatus === "archived"
                            ? tFor(appLocale, "one.shell.rail.restore_from_archive")
                            : tFor(appLocale, "one.shell.rail.archive_this_work")}
                        </button>
                      )}
                      <button type="button" role="menuitem" onClick={() => { setTaskMenuOpen(false); startNewConversation(); }}>
                        {tFor(appLocale, "one.shell.rail.new_conversation")}
                      </button>
                      <button type="button" role="menuitem" onClick={() => { setTaskMenuOpen(false); setSessionSheetOpen(true); }}>
                        {appLocale === "ko" ? "에이전트 세션" : "Agent sessions"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <button
                ref={railRevealButtonRef}
                type="button"
                className={`${styles.sidebarRevealButton} titlebar-nodrag`}
                aria-label={railOpen
                  ? (appLocale === "ko" ? "사이드바 닫기" : "Close sidebar")
                  : tFor(appLocale, "one.shell.workspace.open_sidebar_aria")}
                aria-expanded={railOpen}
                onClick={() => {
                  if (railOpen) {
                    setRailCollapsed(true);
                    setRailOpen(false);
                    return;
                  }
                  setRailCollapsed(false);
                  setRailOpen(true);
                }}
              ><IconSidebar size={16} /></button>
            )}
          </div>
          <div
            ref={splitStageRef}
            className={styles.splitStage}
            data-split={splitPanes.length > 0 ? "true" : "false"}
            data-panes={splitPanes.length > 0 ? String(splitPanes.length + 1) : undefined}
            style={splitPanes.length > 0 ? { ["--split-col" as string]: `${splitRatio.col}%`, ["--split-row" as string]: `${splitRatio.row}%` } : undefined}
          >
          <div ref={scrollRef} className={styles.scroll}>
            {!selected && !conversation ? (
              <div className={styles.homeContent}>
                <header className={styles.homeChatHeader}>
                  <div>
                    <span className={styles.homePresence} aria-hidden="true" />
                    <strong>One</strong>
                    <small>{appLocale === "ko" ? "CEO 오케스트레이터" : "CEO orchestrator"}</small>
                  </div>
                  <button type="button" data-active={homeMemoryMapOpen ? "true" : "false"} aria-pressed={homeMemoryMapOpen} onClick={() => setHomeMemoryMapOpen((value) => !value)}>
                    <IconSparkles size={14} />
                    <span>{appLocale === "ko" ? "기억 지도" : "Memory map"}</span>
                  </button>
                </header>
                <div className={styles.homeConversation}>
                  <time className={styles.homeDate}>{new Date().toLocaleDateString(appLocale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" })}</time>
                  {/* A new conversation has no task owner. Prior-task decisions
                      remain in their own threads and the existing notification UI. */}
                  <section className={styles.homeAssistantMessage} aria-labelledby="one-home-message-title">
                    <span className={styles.homeMessageAuthor}>One</span>
                    <strong id="one-home-message-title">{appLocale === "ko" ? "무엇을 맡길까요?" : "What should I take care of?"}</strong>
                  </section>
                  {homeMemoryMapOpen && (
                    <section className={styles.homeMemoryMapPanel} aria-label={appLocale === "ko" ? "One 기억 지도" : "One memory map"}>
                      <OneMemoryMap snapshot={oneMemoryMap ?? EMPTY_ONE_MEMORY_MAP} locale={appLocale} />
                    </section>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.threadContent}>
                <section className={styles.messages} aria-label={selected ? tFor(appLocale, "one.shell.thread.work_conversation_aria") : tFor(appLocale, "one.shell.thread.general_conversation_aria")} aria-live="polite">
                  {failureFocus && (!failureFocus.chatId || failureFocus.chatId === (selected?.chatId ?? conversation?.id)) && (
                    <section className={styles.failureCard} role="alert" aria-label={appLocale === "ko" ? "실패 복구" : "Failure recovery"}>
                      <button type="button" className={styles.failureCardClose} aria-label={appLocale === "ko" ? "닫기" : "Close"} onClick={() => setFailureFocus(null)}><IconClose size={14} /></button>
                      <div className={styles.failureCardHeader}><strong>{appLocale === "ko" ? "실패" : "Failed"}</strong><span>{(failureFocus.failureCode ?? failureFocus.errorCode) || (appLocale === "ko" ? "실행 오류" : "Runtime error")}</span></div>
                      <p>{toolFailureCopy(failureFocus.failureCode ?? failureFocus.errorCode, appLocale) ?? failureFocus.errorMessage}</p>
                      <div className={styles.failureCardActions}>
                        <button type="button" disabled={!failureFocus.chatId || busy} onClick={retryFocusedFailure}>{appLocale === "ko" ? "다시 시도" : "Retry"}</button>
                        <button type="button" className={styles.primaryButton} disabled={busy} onClick={sendFocusedFailureToOne}>{appLocale === "ko" ? "One에게 맡기기" : "Ask One"}</button>
                      </div>
                    </section>
                  )}
                  {threadWorkPlan.leading.map((block) => (
                    <Fragment key={`work:${block.runId}`}>
                      {/* 단톡에도 1:1과 같은 도구 호출 로그 표면을 남긴다 (G-4).
                          워커 도구 이벤트는 agentName이 붙어 오므로 행에 발화자가 보인다. */}
                      <OneTurnWork
                        state={block.state}
                        artifactScope={activeThreadChatId ? { chatId: activeThreadChatId, runId: block.runId } : undefined}
                        onInspectWorker={(group) => inspectWorkerPanel(block.runId, group)}
                        busy={false}
                        runStatus={block.status}
                        startedAt={Date.parse(block.startedAt)}
                        locale={appLocale}
                        workspacePath={workspacePath}
                      />
                      {activeTaskforce && <OneTaskforceConversation state={block.state} org={oneOrgState} locale={appLocale} />}
                    </Fragment>
                  ))}
                  {visibleMessages.map((message, messageIndex) => {
                    // Narrative output remains the primary final response.
                    // Only a genuinely visual/interactive surface replaces its
                    // duplicate Markdown payload.
                    // Codex parity (owner decision 2026-08-15): the model's
                    // answer is the answer, drawn as Markdown in the thread.
                    // A structured result card below never replaces it, and a
                    // Surface's flattened narrative never stands in for it
                    // (measured: it dropped links/fences and rendered raw
                    // "[hello.txt]([local path]" and a stray ``` ).
                    const visibleText = visibleOneMessageText(message);
                    // Codex draws the turn's work above the answer it produced:
                    // the live block sits right before the streaming reply,
                    // settled blocks right after the prompt that started them.
                    const liveBefore = liveWorkAnchorMessageId === message.id;
                    const blocksAfter = threadWorkPlan.afterMessage.get(message.id) ?? [];
                    // 첨부만 있는 턴도 대화다 — 텍스트가 없다고 버리면 사진을 보낸 사실 자체가 사라진다.
                    const hasAttachments = (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0;
                    if (!visibleText && !hasAttachments && !liveBefore && blocksAfter.length === 0) return null;
                    const systemLabel = message.role === "system" ? oneSystemPromptLabel(message) : null;
                    const graphRequest = message.role === "user" ? oneGraphRequest(message.text) : null;
                    const assistantGroupStart = message.role === "assistant"
                      && visibleMessages[messageIndex - 1]?.role !== "assistant";
                    return (
                      <Fragment key={message.id}>
                        {(departurePlan.beforeMessage.get(message.id) ?? []).map((notice) => (
                          <p key={notice.id} className={styles.departureNotice} data-one-departure="true">
                            <span aria-hidden="true">---------</span>
                            <span>{notice.label}</span>
                            <span aria-hidden="true">---------</span>
                          </p>
                        ))}
                        {liveBefore && !preflightPrompt && <>
                          {activeTaskforce && <OneTaskforceConversation state={renderedActivity} org={oneOrgState} locale={appLocale} />}
                          {liveWorkBlock}
                        </>}
                        {(visibleText || hasAttachments) && (normalizeChatHostNotice(message.role, message.hostNotice)
                          ? <HostContinuationNotice text={message.text} locale={appLocale === "ko" ? "ko" : "en"} />
                          : systemLabel
                          ? (
                            // A prompt One sent on the person's behalf ("One
                            // continued the remaining steps") is a quiet system
                            // line, not an alert and not a bubble.
                            <p className={styles.systemTurn} data-role="system" data-one-system-turn="true">{systemLabel}</p>
                          )
                          : (
                          <article
                            className={styles.message}
                            data-role={message.role}
                            data-kind={isResultContinuationMessage(message) ? "continuity" : undefined}
                            data-taskforce={activeTaskforce ? "true" : undefined}
                            data-one-message-speaker={message.role === "assistant" ? assistantSpeaker.label : undefined}
                            data-one-avatar-group-start={assistantGroupStart ? "true" : undefined}
                          >
                            {message.role === "assistant" && (
                              <span
                                className={styles.messageAvatarSlot}
                                data-one-message-avatar={assistantGroupStart ? "true" : "spacer"}
                                aria-hidden={!assistantGroupStart || undefined}
                              >
                                {assistantGroupStart && <OneAgentPortrait
                                  status={busy && message.streaming ? "working" : assistantSpeaker.status}
                                  label={assistantSpeaker.label}
                                  tone={assistantSpeaker.tone}
                                  size="small"
                                />}
                              </span>
                            )}
                            <div className={styles.messageContent}>
                            {activeTaskforce && message.role !== "system" && (
                              <div className={styles.taskforceMessageMeta}>
                                <span>
                                  <strong>{message.role === "user" ? (appLocale === "ko" ? "나" : "You") : assistantSpeaker.label}</strong>
                                  {message.createdAt && <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(appLocale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time>}
                                </span>
                              </div>
                            )}
                            {message.images && message.images.length > 0 && (
                              <div className={styles.messageImages} data-one-message-media="true">
                                {message.images.map((src, i) => (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img key={`${message.id}-img-${i}`} src={src} alt="" className={styles.messageImage} />
                                ))}
                              </div>
                            )}
                            {message.chatFiles && message.chatFiles.length > 0 && (
                              <ChatFileCards files={message.chatFiles} locale={appLocale} onOpen={openOneChatFile} />
                            )}
                            {(visibleText || (message.files?.some((file) => file.kind !== "image") ?? false)) && (
                            <div className={styles.messageBody} data-doc={message.role === "assistant" && !message.streaming && isDocumentLikeText(message.text) ? "true" : undefined}>
                              {message.files && message.files.filter((f) => f.kind !== "image").length > 0 && (
                                <div className={styles.messageFiles}>
                                  {message.files.filter((f) => f.kind !== "image").map((f, i) => (
                                    <span key={`${message.id}-file-${i}`} className={styles.messageFileChip}>{f.name}</span>
                                  ))}
                                </div>
                              )}
                              {/*
                                * 에이전트가 앞머리에 보고서 표식을 남긴 글은 대화 거품이
                                * 아니라 읽는 문서로 그린다(오너 지시 2026-08-24). 글의
                                * 모양으로 추측하지 않는다 — 표식이 있을 때만이다.
                                * 답이 자라는 중에는 평소대로 그린다: 표식만 있고 본문이
                                * 아직 한 줄인 글을 문서 카드로 세우면 빈 액자가 된다.
                                */}
                              <GoalResultReport result={message.goalResult} locale={appLocale}>
                              {visibleText && (message.streaming
                                ? <StreamingMarkdown text={visibleText} messageId={message.id} onOpenLinkedFile={openOneLinkedFile} />
                                : (() => {
                                  const documentMark = readOneDocumentMark(visibleText);
                                  return documentMark
                                    ? <OneDocumentCard doc={documentMark} locale={appLocale} messageId={message.id} />
                                    : <Markdown text={visibleText} messageId={message.id} onOpenLinkedFile={openOneLinkedFile} />;
                                })())}
                              </GoalResultReport>
                            </div>
                            )}
                            </div>
                          </article>
                          ))}
                        {graphRequest && activeThreadChatId && (
                          <DescribeAutomation
                            key={`graph:${message.id}`}
                            locale={appLocale}
                            initialRequest={graphRequest}
                            autoStart
                            presentation="chat"
                            persistenceKey={`agentlas.one.graph-interview.v1:${activeThreadChatId}:${message.id}`}
                            openAfterCreate={false}
                            onCreated={() => undefined}
                          />
                        )}
                        {blocksAfter.map((block) => (
                          <Fragment key={`work:${block.runId}`}>
                            {/* 단톡에도 1:1과 같은 도구 호출 로그 표면 (G-4). */}
                            <OneTurnWork
                              state={block.state}
                        artifactScope={activeThreadChatId ? { chatId: activeThreadChatId, runId: block.runId } : undefined}
                              onInspectWorker={(group) => inspectWorkerPanel(block.runId, group)}
                              busy={false}
                              startedAt={Date.parse(block.startedAt)}
                              locale={appLocale}
                              workspacePath={workspacePath}
                              runStatus={block.status}
                              {...(message.role === "user" && message.text.trim()
                                ? { onRetry: () => retryUnansweredTurn(message.text, block.state.model), retryDisabled: busy }
                                : {})}
                            />
                            {activeTaskforce && <OneTaskforceConversation state={block.state} org={oneOrgState} locale={appLocale} />}
                          </Fragment>
                        ))}
                      </Fragment>
                    );
                  })}
                  {departurePlan.trailing.map((notice) => (
                    <p key={notice.id} className={styles.departureNotice} data-one-departure="true">
                      <span aria-hidden="true">---------</span>
                      <span>{notice.label}</span>
                      <span aria-hidden="true">---------</span>
                    </p>
                  ))}
                  {preflightPrompt && (
                    <OneTurnWork
                      state={initialOneActivityState()}
                      busy={false}
                      preparing
                      startedAt={preflightPrompt.startedAt}
                      locale={appLocale}
                      workspacePath={workspacePath}
                    />
                  )}
                  {messages.length === 0 && !busy && !teamPreflightBusy && !teamPreflight && !preflightPrompt && <div className={styles.emptyThread}>{selected ? tFor(appLocale, "one.shell.thread.empty_work") : tFor(appLocale, "one.shell.thread.empty_conversation")}</div>}
                  {workBusy && !preflightPrompt && !liveWorkAnchorMessageId && (
                    <>
                      {busy && activeRunPrompt && !livePromptMounted && (
                        <article className={styles.message} data-role="user">
                          <div className={styles.messageBody}><Markdown text={activeRunPrompt.text} messageId={`one-live-prompt:${activeRunPrompt.runId}`} onOpenLinkedFile={openOneLinkedFile} /></div>
                        </article>
                      )}
                      {activeTaskforce && <OneTaskforceConversation state={renderedActivity} org={oneOrgState} locale={appLocale} />}
                      {liveWorkBlock}
                    </>
                  )}
                </section>
                {awaitingWorkforceConsent && !teamPreflightBusy && !busy && (
                  <section className={styles.teamPreflightConsent} role="group" aria-live="polite">
                    <strong>{tFor(appLocale, "one.shell.team.outside_title")}</strong>
                    <p>{tFor(appLocale, "one.shell.team.outside_body")}</p>
                    <div className={styles.teamPreflightConsentActions}>
                      <button type="button" onClick={() => { void answerWorkforceConsent(true); }}>
                        {tFor(appLocale, "one.shell.team.outside_accept")}
                      </button>
                      <button type="button" onClick={() => { void answerWorkforceConsent(false); }}>
                        {tFor(appLocale, "one.shell.team.outside_decline")}
                      </button>
                    </div>
                  </section>
                )}
                {/*
                  ★"이 요청은 안전하게 이어갈 수 없어서 멈췄어요" 를 아무 때나 띄우지 않는다.
                  (오너 2026-09-07: "이딴거 나오면 뒤진다", "이거 왜나옴?")

                  이 줄은 팀을 꾸린 뒤 실행이 완료에 도달하지 못하면 떴다 — **이유와 무관하게.**
                  오늘처럼 런타임 한도로 실패한 날에는 계속 뜨는데, 정작 원장에는 진짜 사유가
                  적혀 있었다("Individual quota reached … Resets in 3m32s"). 사용자에게는
                  아무 정보도 없는 문장과 "다시 보내세요"만 갔고, 다시 보내면 같은 이유로
                  또 실패한다. 알 수 없는 말로 막다른 길을 만드는 자리였다.

                  이제 순서가 반대다: 런타임이 말한 사유가 있으면 **그것을 보여 준다.**
                  사유가 정말 없을 때만 일반 문구로 떨어진다.
                */}
                {teamPreflight && ["workforce_reserved", "recovery_required"].includes(teamPreflight.status) && receipt?.status !== "completed" && !teamPreflightBusy && !busy && !awaitingWorkforceConsent && (
                  <p className={styles.teamPreflightRecovery} role="status">
                    {receipt?.errorMessage?.trim()
                      ? receipt.errorMessage.trim().slice(0, 300)
                      : receipt?.status === "cancelled" || receipt?.status === "interrupted"
                        ? (appLocale === "ko"
                            ? "이 실행은 끝나기 전에 멈췄습니다. 같은 내용을 다시 보내면 이어서 진행합니다."
                            : "This run stopped before it finished. Send the same request again to continue.")
                        : tFor(appLocale, "one.shell.thread.recovery")}
                  </p>
                )}
                {/*
                  ★수리 2026-08-25 — 부를 수 없던 팀원을 화면이 말한다.
                  원장에는 사유가 적혀 있었는데(좌석 2명 `call_only`) 화면은
                  한 글자도 말하지 않아, 사람에게는 "왜 One 만 답하지"로만
                  보였다(오너 지적). 사유는 닫힌 목록이므로 화면이 번역한다.
                */}
                {teamPreflight
                  && (teamPreflight.unavailableMembers?.length ?? 0) > 0
                  && !busy
                  && !teamPreflightBusy && (
                  <section className={styles.teamPreflightConsent} role="status" aria-live="polite">
                    <strong>
                      {appLocale === "ko"
                        ? "이번에 부르지 못한 팀원이 있습니다"
                        : "Some teammates could not join this run"}
                    </strong>
                    <ul>
                      {teamPreflight.unavailableMembers?.map((member) => (
                        <li key={member.agentId}>
                          {member.displayName}
                          {" — "}
                          {oneTeamMemberUnavailableText(member.reason, appLocale)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {/*
                  PRD §4.14 — 만료·취소에는 카드도 버튼도 없어서 대화가 그냥 멈췄다.
                  모든 종결 상태에 문구와 다음 행동을 준다. 만료는 실패가 아니므로
                  "다시 보내면 이어집니다"가 실제로 할 수 있는 행동이다.
                */}
                {teamPreflight && (teamPreflightExpired || ["expired", "cancelled"].includes(teamPreflight.status)) && !busy && !teamPreflightBusy && (
                  <section className={styles.teamPreflightConsent} role="status" aria-live="polite">
                    <strong>
                      {teamPreflight.status === "cancelled"
                        ? (appLocale === "ko" ? "팀 제안을 취소했습니다" : "The team proposal was cancelled")
                        : (appLocale === "ko" ? "팀 제안이 만료됐습니다" : "The team proposal expired")}
                    </strong>
                    <p>
                      {appLocale === "ko"
                        ? "하려던 일을 다시 보내 주세요. 같은 요청으로 바로 이어서 진행합니다."
                        : "Send what you wanted again and One will continue from there."}
                    </p>
                    <div className={styles.teamPreflightConsentActions}>
                      <button type="button" onClick={() => {
                        const api = ipc();
                        const proposal = teamPreflight;
                        if (!api || !proposal) return;
                        setTeamPreflightBusy(true);
                        void (async () => {
                          try {
                            // The card can outlive a reservation/start transition. Re-read
                            // Main's state before acknowledging so a stale card cannot call
                            // acknowledge against a non-terminal proposal.
                            const latest = await api.oneTeamPreflight.getForChat(proposal.binding.chatId);
                            if (
                              !latest
                              || latest.proposalId !== proposal.proposalId
                              || latest.version !== proposal.version
                              || !isOneTeamPreflightTerminalStatus(latest.status)
                            ) {
                              setTeamPreflight(latest);
                              setPendingTeamPrompt((current) => (
                                latest
                                  && isOneTeamPreflightPendingStatus(latest.status)
                                  && current?.proposalId === latest.proposalId
                                  ? current
                                  : null
                              ));
                              return;
                            }
                            await api.oneTeamPreflight.acknowledge({
                              proposalId: latest.proposalId,
                              expectedProposalVersion: latest.version,
                              confirmedByUser: true,
                            });
                            setTeamPreflight(null);
                            setPendingTeamPrompt(null);
                          } catch (cause) {
                            const code = oneTeamPreflightErrorCode(cause);
                            if (code === "already_resolved" || code === "stale_binding") {
                              const latest = await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => null);
                              setTeamPreflight(latest);
                              setPendingTeamPrompt((current) => (
                                latest
                                  && isOneTeamPreflightPendingStatus(latest.status)
                                  && current?.proposalId === latest.proposalId
                                  ? current
                                  : null
                              ));
                              return;
                            }
                            requestOneOperationalRecovery("one-team-preflight-acknowledge", cause);
                          } finally {
                            setTeamPreflightBusy(false);
                          }
                        })();
                      }}>
                        {appLocale === "ko" ? "확인" : "Got it"}
                      </button>
                    </div>
                  </section>
                )}
                {selected && latestCommittedAnswer && (
                  <ResolvedDecisionReceipt receipt={latestCommittedAnswer} locale={appLocale} />
                )}
                {selected && (surface || (receipt && ["completed", "failed", "cancelled", "interrupted"].includes(receipt.status))) && (
                  <div ref={resultTopRef} className={styles.resultAnchor}>
                    <OneAdaptiveResult
                      manifest={surface}
                      projection={selected}
                      receipt={receipt}
                      locale={appLocale}
                      omitNarrative
                      onSemanticAction={handleOneSemanticAction}
                      onOpenAgentDraft={openCreateAgentDialog}
                      onRetryUnfinished={retryUnfinished}
                      onAcceptResult={acceptSelectedResult}
                      autoRecovery={autoRecovery}
                      valueClosure={selectedValueClosure}
                      experienceReuse={selectedExperienceReuse}
                      onManageExperience={() => { setProfileOpen(false); setMemoryOpen(true); }}
                      valueClosureState={oneValueClosures}
                      onValueClosureStateChange={handleValueClosuresChange}
                      improvementProof={selectedImprovementProof}
                      onManageImprovementAsset={manageImprovementAsset}
                    />
                  </div>
                )}
                {selectedMemoryCandidate && oneMemory && (
                  <OneMemoryCandidateCard
                    candidate={selectedMemoryCandidate}
                    state={oneMemory}
                    locale={appLocale}
                    onStateChange={handleMemoryChange}
                    onReview={() => { setProfileOpen(false); setMemoryOpen(true); }}
                  />
                )}
                {!selectedMemoryCandidate && selectedSuggestion && oneSuggestions && (
                  <OneSuggestionCard
                    suggestion={selectedSuggestion}
                    state={oneSuggestions}
                    locale={appLocale}
                    onStateChange={handleSuggestionsChange}
                  />
                )}
              </div>
            )}
          </div>
          {splitPanes.map((pane) => (
            <OneSplitPane
              key={pane.id}
              chatId={pane.id}
              title={pane.title || (appLocale === "ko" ? "새 대화" : "New conversation")}
              seatLabel={seatLabelForChat(pane, taskforces, oneOrgState, appLocale)}
              locale={appLocale}
              running={activeChatIds.includes(pane.id)}
              onActivate={() => {
                // 옆칸을 누르면 그 칸이 입력창을 가져간다. 지금 보던 대화는
                // 사라지지 않고 옆칸으로 자리를 바꾼다.
                const previous = selectedConversationId;
                setSplitChatIds((ids) => {
                  const without = ids.filter((id) => id !== pane.id);
                  if (previous && previous !== pane.id && !without.includes(previous)) without.unshift(previous);
                  return without.slice(0, 3);
                });
                openConversation(pane.id);
              }}
              onClose={() => setSplitChatIds((ids) => ids.filter((id) => id !== pane.id))}
              permissionMode={onePermission}
              runtimeSelection={oneRuntimeSelection}
              appLocale={appLocale}
            />
          ))}
          {splitPanes.length > 0 && (
            <button
              type="button"
              className={styles.splitCorner}
              // 둘로 갈랐을 때는 위아래 경계가 없다 — 가로만 움직인다.
              data-axis={splitPanes.length === 1 ? "x" : "xy"}
              style={{ left: `${splitRatio.col}%`, top: splitPanes.length === 1 ? "50%" : `${splitRatio.row}%` }}
              aria-label={appLocale === "ko" ? "칸 크기 조절" : "Resize panes"}
              onPointerDown={beginSplitResize}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 1 : 4;
                if (event.key === "ArrowLeft") { event.preventDefault(); setSplitRatio((r) => ({ ...r, col: clampSplitRatio(r.col - step) })); }
                if (event.key === "ArrowRight") { event.preventDefault(); setSplitRatio((r) => ({ ...r, col: clampSplitRatio(r.col + step) })); }
                if (event.key === "ArrowUp") { event.preventDefault(); setSplitRatio((r) => ({ ...r, row: clampSplitRatio(r.row - step) })); }
                if (event.key === "ArrowDown") { event.preventDefault(); setSplitRatio((r) => ({ ...r, row: clampSplitRatio(r.row + step) })); }
              }}
            />
          )}
          </div>

          <div
            className={styles.composerDock}
            data-drag-active={attachmentDragActive ? "true" : "false"}
            onDragEnter={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files")) return;
              event.preventDefault();
              attachmentDragDepthRef.current += 1;
              setAttachmentDragActive(true);
            }}
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setAttachmentDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
              if (attachmentDragDepthRef.current === 0) setAttachmentDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              attachmentDragDepthRef.current = 0;
              setAttachmentDragActive(false);
              if (event.dataTransfer.files.length > 0) void addAttachmentFiles(event.dataTransfer.files);
            }}
          >
            {attachmentDragActive && (
              <div className={styles.attachmentDropOverlay} role="status" aria-live="polite">
                {tFor(appLocale, "one.shell.composer.drop_files")}
              </div>
            )}
            {/* Keep live permissions close to the action they unblock. The
                durable request stays in the approval queue/diagnostics; One
                shows only compact choices immediately above the composer. */}
            {activeThreadChatId && visibleSelectedConfirmation && (
              <DecisionInline
                confirmation={visibleSelectedConfirmation}
                taskId={selected?.taskId ?? null}
                locale={appLocale}
                disabled={busy || selectedReadOnly}
                onAnswer={answerConfirmation}
                onAlwaysApprove={(confirmation) => { void markChatAlwaysApproved(confirmation); }}
                onClarify={clarifyConfirmation}
                onSnooze={snoozeConfirmation}
                onDismiss={() => setDismissedDecisionId(visibleSelectedConfirmation.sourceMessageId)}
              />
            )}
            <ComposerDecisionSlot className={styles.composerDecisions} surface="one" />
            <ToolApprovalInline chatId={activeThreadChatId} compact chip composerWidth={ONE_COMPOSER_WIDTH_PX} composerInset={ONE_COMPOSER_INSET_PX} />
            {activeThreadChatId && (selectedTaskId
              ? selected?.taskId === selectedTaskId
              : selectedConversationId === activeThreadChatId) && <OneGoalControls
              key={`${selectedTaskId ?? selectedConversationId}:${activeThreadChatId}`}
              chatId={activeThreadChatId}
              locale={appLocale === "ko" ? "ko" : "en"}
              isCurrent={() => !homeTransitionPendingRef.current
                && goalControlViewKeyRef.current === goalControlViewKey
                && activeThreadChatIdRef.current === activeThreadChatId
                && selectedTaskIdRef.current === selectedTaskId
                && selectedConversationIdRef.current === selectedConversationId}
              onDeleted={() => {
                goalControlEpochRef.current += 1;
                setTurnOverrides((current) => currentOneGoalOverride(current, goalControlEpochRef.current));
              }}
            />}
            {armedOneMemoryUseOnce && (
              <div className={styles.oneMemoryUseOnceChip} role="status">
                <span>{tFor(appLocale, "one.shell.composer.memory_once")}</span>
                <small>{tFor(appLocale, "one.shell.composer.memory_expires", { time: formatTimestamp(armedOneMemoryUseOnce.receipt.expiresAt, appLocale) })}</small>
                <button
                  type="button"
                  onClick={() => setArmedOneMemoryUseOnce(null)}
                  aria-label={tFor(appLocale, "one.shell.composer.memory_exclude_aria")}
                ><IconClose size={12} /></button>
              </div>
            )}
            {attachmentDrafts.length > 0 && (
              <div className={styles.attachmentTray} aria-label={tFor(appLocale, "one.shell.composer.selected_attachments_aria")}>
                {attachmentDrafts.map((item) => (
                  <div key={item.id} className={styles.attachmentChip} data-kind={item.kind}>
                    {item.previewUrl
                      ? <img src={item.previewUrl} alt="" aria-hidden="true" />
                      : <span className={styles.attachmentFileIcon} aria-hidden="true">{item.kind === "directory" ? <IconFolder size={15} /> : <IconFileUp size={15} />}</span>}
                    <span className={styles.attachmentCopy}>
                      <strong>{item.name}</strong>
                      <small>{attachmentTypeLabel(item.mediaType, item.name)} · {attachmentSize(item.size)}</small>
                    </span>
                    <button type="button" onClick={() => removeAttachmentDraft(item.id)} aria-label={tFor(appLocale, "one.shell.composer.remove_attachment", { name: item.name })}><IconClose size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError && <p className={styles.attachmentError} role="alert">{attachmentError}</p>}
            {actionNotice && <p className={styles.attachmentError} role="status" aria-live="polite" data-one-action-notice="true">{actionNotice}</p>}
            {turnAgentIds.length > 0 && (
              <div className={styles.oneTurnAgentChips} aria-label={appLocale === "ko" ? "이번 턴 에이전트" : "Agents for this turn"}>
                <span>{appLocale === "ko" ? "이번 턴" : "This turn"}</span>
                {turnAgentIds.map((agentId) => {
                  const candidate = availableAgents.find((item) => item.id === agentId);
                  if (!candidate) return null;
                  const localized = pickLocalized(candidate, appLocale);
                  return <button
                    key={agentId}
                    type="button"
                    onClick={() => setTurnAgentIds((current) => current.filter((id) => id !== agentId))}
                    aria-label={appLocale === "ko" ? `${localized.name} 호출 취소` : `Remove ${localized.name}`}
                  >@{localized.name}<span aria-hidden><IconClose size={10} /></span></button>;
                })}
              </div>
            )}
            {composerMenu && (
              <OneComposerControls
                activeMenu={composerMenu}
                locale={appLocale}
                runtime={oneRuntime}
                models={oneModelOptions}
                agents={availableAgents.map((candidate) => {
                  const localized = pickLocalized(candidate, appLocale);
                  return {
                    id: candidate.id,
                    name: localized.name,
                    tagline: localized.tagline,
                    selected: turnAgentIds.includes(candidate.id),
                  };
                })}
                plugins={onePluginOptions}
                permission={onePermission}
                turnOptions={turnOverrides}
                localFilesConnected={Boolean(workspacePath)}
                onMenuChange={setComposerMenu}
                onAttach={() => {
                  setComposerMenu(null);
                  attachmentInputRef.current?.click();
                }}
                onAddFolder={() => {
                  const api = ipc();
                  setComposerMenu(null);
                  if (!api) {
                    setActionNotice(appLocale === "ko"
                      ? "Desktop에 연결되지 않아 폴더를 연결하지 못했습니다."
                      : "The folder was not connected because Desktop is unavailable.");
                    return;
                  }
                  void (async () => {
                    try {
                      const grant = await api.fs.pickDirectory();
                      if (!grant?.path) return;
                      const targetChatId = activeThreadChatId;
                      if (targetChatId) {
                        await api.workspace.set(targetChatId, grant);
                        const persistedPath = await api.workspace.get(targetChatId);
                        if (persistedPath !== grant.path) {
                          throw new Error("workspace_path_receipt_mismatch");
                        }
                        // A slow picker/save must never overwrite the workspace shown
                        // for a conversation the user opened in the meantime.
                        if (activeThreadChatIdRef.current !== targetChatId) return;
                      }
                      setWorkspaceGrant(grant);
                      setWorkspacePath(grant.path);
                      setActionNotice(null);
                      window.setTimeout(() => composerInputRef.current?.focus(), 0);
                    } catch {
                      setActionNotice(appLocale === "ko"
                        ? "폴더 연결 요청의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 반복 적용하지 말고 이 대화를 다시 열어 확인해 주세요."
                        : "The final folder state could not be verified. This screen was not changed. Do not repeat the action; reopen this conversation to check it.");
                    }
                  })();
                }}
                onClearFolder={() => {
                  const api = ipc();
                  setComposerMenu(null);
                  const targetChatId = activeThreadChatId;
                  if (!targetChatId) {
                    setWorkspaceGrant(null);
                    setWorkspacePath(null);
                    setActionNotice(null);
                    return;
                  }
                  if (!api) {
                    setActionNotice(appLocale === "ko"
                      ? "Desktop에 연결되지 않아 폴더 연결을 해제하지 못했습니다. 기존 폴더를 유지합니다."
                      : "The folder was not disconnected because Desktop is unavailable. The current folder remains connected.");
                    return;
                  }
                  void (async () => {
                    try {
                      await api.workspace.set(targetChatId, null);
                      const persistedPath = await api.workspace.get(targetChatId);
                      if (persistedPath !== null) throw new Error("workspace_clear_receipt_mismatch");
                      if (activeThreadChatIdRef.current !== targetChatId) return;
                      setWorkspaceGrant(null);
                      setWorkspacePath(null);
                      setActionNotice(null);
                    } catch {
                      setActionNotice(appLocale === "ko"
                        ? "폴더 연결 해제 요청의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 반복 적용하지 말고 이 대화를 다시 열어 확인해 주세요."
                        : "The final folder state after disconnecting could not be verified. This screen was not changed. Do not repeat the action; reopen this conversation to check it.");
                    }
                  })();
                }}
                onOpenPlugins={() => {
                  setComposerMenu(null);
                  setSettingsSheet("plugins");
                }}
                onTogglePlugin={(pluginId) => {
                  const target = installedPlugins.find((plugin) => plugin.id === pluginId);
                  if (!target) return;
                  // 설정이 덜 끝난 플러그인은 여기서 켜 봐야 동작하지 않는다 —
                  // 스위치를 흉내 내는 대신 키를 넣을 수 있는 화면으로 보낸다.
                  if (target.configurationValid === false) {
                    setComposerMenu(null);
                    setPluginPickerOpen(true);
                    return;
                  }
                  const api = ipc();
                  if (!api) {
                    setActionNotice(appLocale === "ko"
                      ? "Desktop에 연결되지 않아 플러그인 상태를 바꾸지 못했습니다."
                      : "The plugin setting did not change because Desktop is unavailable.");
                    return;
                  }
                  if (pluginMutationPendingRef.current.has(pluginId)) {
                    setActionNotice(appLocale === "ko"
                      ? "이 플러그인의 이전 변경을 확인하는 중입니다. 완료된 뒤 다시 눌러 주세요."
                      : "The previous change for this plugin is still being verified. Try again after it finishes.");
                    return;
                  }
                  const nextEnabled = !target.enabled;
                  pluginMutationPendingRef.current.add(pluginId);
                  // 낙관적 반영 — 왕복을 기다리면 스위치가 한 박자 늦게 움직인다.
                  setInstalledPlugins((current) => current.map((plugin) => (
                    plugin.id === pluginId ? { ...plugin, enabled: nextEnabled } : plugin
                  )));
                  void api.mcpTools.setEnabled(pluginId, nextEnabled)
                    .then((updated) => {
                      if (!updated || updated.id !== pluginId || updated.enabled !== nextEnabled) {
                        throw new Error("plugin_toggle_receipt_mismatch");
                      }
                      setInstalledPlugins((current) => current.map((plugin) => (
                        plugin.id === pluginId ? updated : plugin
                      )));
                      setActionNotice(null);
                    })
                    .catch((cause: unknown) => {
                      // 실패하면 되돌리고, 원인/다음 행동을 같은 화면에서 보인다.
                      setInstalledPlugins((current) => current.map((plugin) => (
                        plugin.id === pluginId ? { ...plugin, enabled: target.enabled } : plugin
                      )));
                      const raw = cause instanceof Error
                        ? cause.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
                        : "";
                      const detail = toCustomerSafeText(raw, appLocale);
                      setActionNotice(detail || (appLocale === "ko"
                        ? "플러그인 상태를 바꾸지 못했습니다. 연결 설정을 확인한 뒤 다시 시도해 주세요."
                        : "The plugin setting did not change. Check its connection settings and try again."));
                    })
                    .finally(() => {
                      pluginMutationPendingRef.current.delete(pluginId);
                    });
                }}
                onToggleAgent={(agentId) => {
                  setTurnAgentIds((current) => current.includes(agentId)
                    ? current.filter((id) => id !== agentId)
                    : [...current, agentId]);
                  setComposer((current) => {
                    const match = current.match(/(^|\s)@[^\s]*$/u);
                    return match ? `${current.slice(0, match.index)}${match[1]}` : current;
                  });
                }}
                onSelectModel={(runtime, model) => { void applyOneRuntimeSelection({ model }, runtime); }}
                onSelectEffort={(effort) => { void applyOneRuntimeSelection({ effort }); }}
                onSelectPermission={(permission) => {
                  setOnePermission(permission);
                  setComposerMenu(null);
                }}
                onToggleTurnOption={(key) => setTurnOverrides((current) => {
                  const next = { ...current };
                  if (next[key]) delete next[key]; else next[key] = true;
                  return next;
                })}
              />
            )}
            {stagedSteer && (
              <div className={styles.steeringDraft} role="group" aria-label={appLocale === "ko" ? "보낼 작업 조정" : "Staged work adjustment"} data-one-steering-draft="true">
                <span className={styles.steeringDraftCopy} title={stagedSteer}>{stagedSteer}</span>
                <button
                  type="button"
                  className={styles.steeringDraftSend}
                  data-one-steering-send="true"
                  onClick={() => {
                    const value = stagedSteer;
                    setStagedSteer(null);
                    void submit(value);
                  }}
                  title={busy
                    ? (appLocale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
                    : undefined}
                >
                  {busy ? (appLocale === "ko" ? "현재 작업 조정" : "Adjust current work") : (appLocale === "ko" ? "보내기" : "Send")}
                </button>
                <button
                  type="button"
                  className={styles.steeringDraftDiscard}
                  onClick={() => setStagedSteer(null)}
                  aria-label={appLocale === "ko" ? "작업 조정 지우기" : "Discard work adjustment"}
                >
                  <IconClose size={12} />
                </button>
              </div>
            )}
            {queuedSteers.map((queued, index) => (
              // Codex keeps each queued message visible above the composer and
              // lets the user pull it back before the model receives it. Stop
              // clears the queue in Main, so the strip clears with it (see
              // stopRun) — a strip that outlives its queue was the recording's
              // "steering cannot be cancelled" (2026-08-15 21:25, frames 46–72).
              <div key={queued.id} className={styles.steeringQueue} role="status" aria-live="polite" data-one-steering-queue="true">
                <span>{appLocale === "ko" ? "다음 지시" : "Next instruction"}</span>
                <strong>{queued.text}</strong>
                <small>{appLocale === "ko" ? "현재 모델을 중단하지 않고 이어서 반영합니다" : "Will be applied without stopping the current model"}</small>
                <button
                  type="button"
                  className={styles.steeringQueueRemove}
                  data-one-steering-remove="true"
                  aria-label={appLocale === "ko" ? "다음 지시 취소" : "Remove queued instruction"}
                  title={appLocale === "ko" ? "다음 지시 취소" : "Remove queued instruction"}
                  onClick={() => void removeQueuedSteer(queued.id, index + 1, queued.text)}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            {activeDirectSessionUnavailable && <div className={styles.sessionUnavailableBanner} role="status" data-one-session-unavailable-banner="true">
              <IconAlertTriangle size={17} strokeWidth={2} />
              <strong>{appLocale === "ko"
                ? "이 세션의 에이전트가 사라졌습니다. 세션을 새로 시작해주세요."
                : "This session's agent is no longer available. Start a new session to continue."}</strong>
              <button type="button" onClick={startReplacementSession}>{appLocale === "ko" ? "새 세션 시작" : "Start new session"}</button>
            </div>}
            {/* T7 읽기 전용 아카이브 — 해체된 단톡의 입력창은 "비활성"이 아니라 다음
                행동(같은 멤버로 새 단톡)으로 대체된다(막다른 길 금지, 기획 §4-6). */}
            {activeSeatDissolved && <div className={styles.steeringQueue} role="status" data-one-dissolved-banner="true">
              <span>{appLocale === "ko" ? "이 단톡은 해체되었습니다" : "This group chat was dissolved"}</span>
              <strong>{appLocale === "ko" ? "기록은 그대로 보존됩니다 — 열람은 계속할 수 있습니다." : "Its records are preserved — you can keep reading."}</strong>
              <button
                type="button"
                data-one-dissolved-continue="true"
                onClick={() => void continueDissolvedSeat()}
                disabled={taskforceBusy}
              >{appLocale === "ko" ? "같은 멤버로 새 단톡 만들기" : "Start a new group chat with the same members"}</button>
            </div>}
            <form className={styles.composer} data-one-composer="true" data-unavailable={activeDirectSessionUnavailable ? "true" : undefined} style={activeSeatDissolved ? { display: "none" } : undefined} onSubmit={(event) => {
              event.preventDefault();
              if (activeSeatDissolved || activeDirectSessionUnavailable) return;
              const submittedValue = composerInputRef.current?.value ?? composer;
              if (busy && !submittedValue.trim()) stopRun();
              else void submit(submittedValue);
            }}>
              <input
                ref={attachmentInputRef}
                className={styles.attachmentInput}
                type="file"
                multiple
                accept={ONE_ATTACHMENT_PICKER_ACCEPT}
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => { if (event.target.files?.length) void addAttachmentFiles(event.target.files); }}
              />
              <textarea
                ref={composerInputRef}
                /* 초점 링은 감싼 작성창(.composer:focus-within)이 그린다. */
                data-focus-ring="wrapper"
                rows={1}
                value={composer}
                onChange={(event) => {
                  const value = event.target.value;
                  setComposer(value);
                  setAgentPickerOpen(/(^|\s)@[^\s]*$/u.test(value));
                }}
                onCompositionStart={() => { composerComposingRef.current = true; }}
                onCompositionEnd={() => {
                  window.setTimeout(() => { composerComposingRef.current = false; }, 0);
                }}
                onBlur={() => { composerComposingRef.current = false; }}
                onKeyDown={(event) => {
                  // Snapshot the native textarea value for this key event.
                  // React state can trail rapid accessibility input by one
                  // render and must not let the following prompt overwrite it.
                  const submittedValue = event.currentTarget.value;
                  handleComposerKey(
                    event,
                    busy && !submittedValue.trim() ? stopRun : () => void submit(submittedValue),
                    composerComposingRef.current,
                  );
                }}
                onPaste={(event) => {
                  // 클립보드에는 스크린샷뿐 아니라 Finder 파일, 오디오·비디오, 생성된
                  // 문서도 File로 온다. 모든 File을 같은 안전 첨부 파이프로 보내고,
                  // 텍스트만 붙여넣을 때는 브라우저 기본 입력을 그대로 둔다.
                  const clipboard = event.clipboardData;
                  if (!clipboard) return;
                  const files: File[] = [];
                  /*
                   * ★같은 파일을 두 목록에서 받는다 — 중복은 신원이 아니라 내용으로 판단한다.
                   *
                   * clipboard.files 와 clipboard.items[].getAsFile() 은 같은 스크린샷을
                   * 가리키지만, getAsFile() 은 호출할 때마다 **새 File 객체**를 만든다.
                   * 그래서 객체 신원으로 거르면 한 번도 걸리지 않고, 붙여넣은 사진이 늘
                   * 두 장이 된다.
                   */
                  const seen = new Set<string>();
                  const identityOf = (file: File) => `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
                  const add = (file: File | null) => {
                    if (!file) return;
                    const id = identityOf(file);
                    if (seen.has(id)) return;
                    seen.add(id);
                    files.push(file);
                  };
                  for (const file of Array.from(clipboard.files)) add(file);
                  for (const item of Array.from(clipboard.items)) {
                    if (item.kind === "file") add(item.getAsFile());
                  }
                  if (files.length === 0) return;
                  // 파일을 첨부로 가져간 경우에만 기본 붙여넣기를 막는다.
                  event.preventDefault();
                  void addAttachmentFiles(files);
                }}
                placeholder={activeDirectSessionUnavailable
                  ? (appLocale === "ko" ? "메시지를 입력할 수 없습니다." : "Messaging is unavailable.")
                  : activeTaskforce
                  ? (appLocale === "ko" ? `${activeTaskforce.title}에 메시지` : `Message ${activeTaskforce.title}`)
                  : activeOneMember
                    ? (appLocale === "ko" ? `${activeOneMember.displayName}에게 메시지` : `Message ${activeOneMember.displayName}`)
                    : oneActivationState?.status === "active" && oneActivationState.concern.status === "pending"
                  ? tFor(appLocale, "one.shell.composer.placeholder_activation")
                  : selected
                  ? tFor(appLocale, "one.shell.composer.placeholder_selected")
                  : conversation
                    ? tFor(appLocale, "one.shell.composer.placeholder_conversation")
                    : tFor(appLocale, "one.shell.composer.placeholder_default")}
                aria-label={activeTaskforce
                  ? (appLocale === "ko" ? `${activeTaskforce.title}에 요청` : `Request for ${activeTaskforce.title}`)
                  : activeOneMember
                    ? (appLocale === "ko" ? `${activeOneMember.displayName}에게 요청` : `Request for ${activeOneMember.displayName}`)
                    : tFor(appLocale, "one.shell.composer.request_aria")}
                disabled={composerInteractionBlocked}
              />
              <div className={styles.composerBar}>
                <div className={styles.composerTools}>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    data-one-composer-trigger="plus"
                    disabled={composerAttachmentBlocked}
                    onClick={() => setComposerMenu((current) => current === "plus" ? null : "plus")}
                    aria-expanded={composerMenu === "plus"}
                    aria-haspopup="dialog"
                    aria-controls={composerMenu === "plus" ? "one-composer-popover" : undefined}
                    aria-label={appLocale === "ko" ? "첨부 및 작업 옵션" : "Attachments and work options"}
                  >
                    <IconPlus size={20} aria-hidden="true" />
                  </button>
                  {(oneRuntimeInventory.length > 0 || oneRuntime?.model) && (
                    <button
                      type="button"
                      className={styles.composerChip}
                      data-one-composer-trigger="model"
                      disabled={composerSettingsBlocked}
                      aria-expanded={composerMenu === "model"}
                      aria-haspopup="dialog"
                      aria-controls={composerMenu === "model" ? "one-composer-popover" : undefined}
                      aria-label={appLocale === "ko"
                        ? `모델: ${oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? runtimeModelFallbackLabel(oneRuntime?.kind ?? "agentlas", "ko")}`
                        : `Model: ${oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? runtimeModelFallbackLabel(oneRuntime?.kind ?? "agentlas", "en")}`}
                      onClick={() => setComposerMenu((current) => current === "model" ? null : "model")}
                    >
                      <IconSparkles size={15} />
                      <span>{oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? runtimeModelFallbackLabel(oneRuntime?.kind ?? "agentlas", appLocale)}</span>
                      <IconChevronDown size={12} />
                    </button>
                  )}
                  {oneRuntime && (oneRuntime.efforts?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className={styles.composerChip}
                      data-one-composer-trigger="effort"
                      disabled={composerSettingsBlocked}
                      aria-expanded={composerMenu === "effort"}
                      aria-haspopup="dialog"
                      aria-controls={composerMenu === "effort" ? "one-composer-popover" : undefined}
                      aria-label={appLocale === "ko"
                        ? `추론 강도: ${oneRuntime.efforts?.find((effort) => effort.id === oneRuntime.effort)?.label ?? "기본"}`
                        : `Reasoning effort: ${oneRuntime.efforts?.find((effort) => effort.id === oneRuntime.effort)?.label ?? "Default"}`}
                      onClick={() => setComposerMenu((current) => current === "effort" ? null : "effort")}
                    >
                      <IconRoute size={15} />
                      <span>{oneRuntime.efforts?.find((effort) => effort.id === oneRuntime.effort)?.label ?? (appLocale === "ko" ? "기본" : "Default")}</span>
                      <IconChevronDown size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.composerChip}
                    data-one-composer-trigger="permission"
                    data-one-permission={onePermission}
                    disabled={composerSettingsBlocked}
                    aria-expanded={composerMenu === "permission"}
                    aria-haspopup="dialog"
                    aria-controls={composerMenu === "permission" ? "one-composer-popover" : undefined}
                    aria-label={appLocale === "ko"
                      ? `권한: ${onePermission === "auto" ? "자동 모드" : onePermission === "read" ? "읽기 전용" : onePermission === "write" ? "파일 편집" : "전체 액세스"}`
                      : `Permission: ${onePermission === "auto" ? "Auto mode" : onePermission === "read" ? "Read only" : onePermission === "write" ? "Accept file edits" : "Full access"}`}
                    onClick={() => setComposerMenu((current) => current === "permission" ? null : "permission")}
                  >
                    <IconShield size={15} />
                    <span>{onePermission === "auto" ? (appLocale === "ko" ? "자동 모드" : "Auto mode") : onePermission === "read" ? (appLocale === "ko" ? "읽기 전용" : "Read only") : onePermission === "write" ? (appLocale === "ko" ? "파일 편집" : "Accept file edits") : (appLocale === "ko" ? "전체 액세스" : "Full access")}</span>
                    <IconChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.composerQuickMode}
                    data-active={turnOverrides.fastMode ? "true" : "false"}
                    disabled={composerSettingsBlocked}
                    onClick={() => setTurnOverrides((current) => {
                      const next = { ...current };
                      if (next.fastMode) delete next.fastMode;
                      else next.fastMode = true;
                      return next;
                    })}
                    aria-label={appLocale === "ko" ? "빠른 실행" : "Fast execution"}
                    title={appLocale === "ko" ? "Fast: 단일 패스와 최소 추론으로 빠르게 실행" : "Fast: run one direct pass with the lowest verified reasoning effort"}
                    aria-pressed={Boolean(turnOverrides.fastMode)}
                  ><IconBolt size={16} /></button>
                </div>
                <div className={styles.composerActions}>
                  <OneVoiceInputHelp
                    locale={appLocale}
                    composerRef={composerInputRef}
                    disabled={composerSettingsBlocked}
                  />
                  {(busy || composer.trim() || attachmentDrafts.length > 0) && (
                    <button
                      type="submit"
                      className={styles.sendButton}
                      data-one-steering-send={busy && composer.trim() ? "true" : undefined}
                      disabled={!busy && ((!composer.trim() && attachmentDrafts.length === 0) || composerInteractionBlocked)}
                      aria-label={busy
                        ? composer.trim()
                          ? (appLocale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
                          : tFor(appLocale, "one.shell.composer.stop_run_aria")
                        : tFor(appLocale, "one.shell.composer.send_aria")}
                      title={busy && composer.trim()
                        ? (appLocale === "ko" ? "현재 작업을 중단하지 않고 다음 지시를 보냅니다" : "Sends the next instruction without stopping the model")
                        : undefined}
                    >
                      {busy && !composer.trim() ? <span className={styles.stopGlyph} aria-hidden="true" /> : <IconArrowUp size={20} strokeWidth={2} aria-hidden="true" />}
                    </button>
                  )}
                </div>
              </div>
            </form>
            {selectedReadOnly && !busy && (
              <p className={styles.composerNote}>{tFor(appLocale, "one.shell.composer.view_only")}</p>
            )}
          </div>

          {sessionSheetOpen && (
            <section className={styles.sessionSheet} role="dialog" aria-modal="true" aria-label={appLocale === "ko" ? "에이전트 세션" : "Agent sessions"}>
              <header className={styles.sessionSheetHeader}>
                <strong>{appLocale === "ko" ? "에이전트 세션" : "Agent sessions"}</strong>
                <span className={styles.sessionSheetHint}>
                  {appLocale === "ko"
                    ? `세션 분할 ${splitPanes.length + 1}/4`
                    : `Split ${splitPanes.length + 1}/4`}
                </span>
                <button type="button" className={styles.iconButton} aria-label={appLocale === "ko" ? "닫기" : "Close"} onClick={() => setSessionSheetOpen(false)}><IconClose size={14} /></button>
              </header>
              <div className={styles.sessionSheetList}>
                {sessionGroups.rows.length === 0 && (
                  <p className={styles.sessionSheetEmpty}>{appLocale === "ko" ? "아직 세션이 없습니다." : "No sessions yet."}</p>
                )}
                {sessionGroups.rows.map((row) => {
                  const chat = row.chat;
                  if (!chat) return null;
                  const isOpen = chat.id === selectedConversationId;
                  const inSplit = splitPanes.some((pane) => pane.id === chat.id);
                  const splitFull = splitPanes.length >= 3;
                  return (
                    <div key={row.key} className={styles.sessionSheetRow} data-active={isOpen ? "true" : "false"}>
                      <button
                        type="button"
                        className={styles.sessionSheetOpen}
                        onClick={() => { setSessionSheetOpen(false); openConversation(chat.id); }}
                      >
                        <span className={styles.sessionSheetSeat}>{seatLabelForChat(chat, taskforces, oneOrgState, appLocale)}</span>
                        <span className={styles.sessionSheetName}>{chat.title || (appLocale === "ko" ? "새 대화" : "New conversation")}</span>
                        {/* 표시=실행 (C-D-1): 이 세션의 마지막 실행이 실제로 돈 모델. */}
                        {sessionModels[chat.id] && <span className={styles.sessionSheetHint} data-session-model="true">{sessionModels[chat.id]}</span>}
                        {activeChatIds.includes(chat.id) && <span className={styles.sessionRunningDot} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className={styles.sessionSheetSplit}
                        data-on={inSplit ? "true" : "false"}
                        disabled={isOpen || (!inSplit && splitFull)}
                        title={isOpen
                          ? (appLocale === "ko" ? "지금 보고 있는 대화입니다" : "This one is already open")
                          : (!inSplit && splitFull ? (appLocale === "ko" ? "세션 분할은 4개까지입니다" : "Four at most") : undefined)}
                        onClick={() => setSplitChatIds((ids) => (
                          ids.includes(chat.id) ? ids.filter((id) => id !== chat.id) : [...ids, chat.id].slice(-3)
                        ))}
                      >
                        {inSplit
                          ? (appLocale === "ko" ? "분할 해제" : "Unsplit")
                          : (appLocale === "ko" ? "세션 분할" : "Split")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {searchOpen && (
            <section ref={searchSheetRef} className={styles.searchSheet} role="dialog" aria-modal="true" aria-label={tFor(appLocale, "one.shell.search.dialog_aria")} onKeyDown={trapSearchFocus}>
              <div className={styles.searchHeader}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tFor(appLocale, "one.shell.search.placeholder")} /><button type="button" className={styles.iconButton} aria-label={tFor(appLocale, "one.shell.search.close_aria")} onClick={() => setSearchOpen(false)}><IconClose size={14} /></button></div>
              <div className={styles.searchScope}>
                <span>{tFor(appLocale, "one.shell.search.scope")}</span>
                <label><input type="checkbox" checked={searchIncludeArchived} onChange={(event) => setSearchIncludeArchived(event.target.checked)} />{tFor(appLocale, "one.shell.search.include_archived")}</label>
              </div>
              <div className={styles.searchResults} aria-live="polite" aria-busy={searchLoading || searchLoadingMore}>
                {!query.trim() && (
                  <>
                    {filteredConversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} onRemove={removeConversation} />)}
                    {filtered.map((item) => <TaskListButton key={item.taskId} item={item} active={item.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />)}
                    {filtered.length === 0 && filteredConversations.length === 0 && <div className={styles.railEmpty}>{tFor(appLocale, "one.shell.search.no_history")}</div>}
                  </>
                )}
                {query.trim() && searchHits.map((hit) => (
                  <SearchHitRow
                    key={hit.hitId}
                    hit={hit}
                    active={hit.taskId ? hit.taskId === selectedTaskId : hit.chatId === selectedConversationId}
                    locale={appLocale}
                    mutationBusy={archiveMutationTaskId === hit.taskId}
                    onOpenTask={openTask}
                    onOpenConversation={openConversation}
                    onMutateArchive={mutateTaskArchive}
                  />
                ))}
                {query.trim() && searchLoading && searchHits.length === 0 && <div className={styles.searchState} role="status" style={{ display: "grid", gap: 4 }}><span>{tFor(appLocale, "one.shell.search.searching")}</span><LoadingEstimate locale={appLocale} operationKey="one-search" expectedSeconds={[1, 15]} /></div>}
                {query.trim() && !searchLoading && !searchFailed && searchHits.length === 0 && <div className={styles.searchState}>{tFor(appLocale, "one.shell.search.no_match")}</div>}
                {query.trim() && searchNextCursor && !searchFailed && (
                  <button type="button" className={styles.searchMore} disabled={searchLoadingMore} onClick={loadMoreSearchResults}>
                    {searchLoadingMore ? <span style={{ display: "inline-grid", gap: 2 }}>{tFor(appLocale, "one.shell.search.finding_more")}<LoadingEstimate locale={appLocale} operationKey="one-search-more" expectedSeconds={[1, 15]} compact /></span> : tFor(appLocale, "one.shell.search.show_older")}
                  </button>
                )}
              </div>
            </section>
          )}
          {selectedConfirmation && !visibleSelectedConfirmation && (
            <button
              type="button"
              className={styles.decisionResumeButton}
              onClick={() => setDismissedDecisionId(null)}
            >
              {tFor(appLocale, "one.shell.decision.reopen")}
            </button>
          )}
        </main>
        {/*
          * 접힘이 기본이지만 **출구가 반드시 보인다** — 접힌 자리에 펴기 버튼 한 칸을 남긴다.
          * 폭 0으로 숨기면 다시 열 길이 없어진다(오너 규칙: 내는 상태에는 푸는 길이 있어야 한다).
          */}
        {!selected && !conversation && !homeHistoryOpen && (
          <aside
            className={styles.homeHistoryRailCollapsed}
            aria-label={appLocale === "ko" ? "기록과 추천" : "History and recommendations"}
          >
            <button
              type="button"
              className={styles.homeHistoryExpand}
              data-one-home-history-toggle="true"
              aria-expanded={false}
              aria-label={appLocale === "ko" ? "기록과 추천 펼치기" : "Expand history and recommendations"}
              onClick={() => setHomeHistoryOpen(true)}
            >
              <IconPanelRight size={15} />
              <span>{appLocale === "ko" ? "기록" : "History"}</span>
            </button>
          </aside>
        )}
        {!selected && !conversation && homeHistoryOpen && (
          <aside className={styles.homeHistoryRail} aria-label={appLocale === "ko" ? "기록과 추천" : "History and recommendations"}>
            <button
              type="button"
              className={styles.homeHistoryCollapse}
              data-one-home-history-toggle="true"
              aria-expanded
              aria-label={appLocale === "ko" ? "기록과 추천 접기" : "Collapse history and recommendations"}
              onClick={() => setHomeHistoryOpen(false)}
            >
              <IconClose size={14} />
            </button>
            <OneComputerHistory
              state={computerHistory}
              locale={appLocale}
              previewWhenUnavailable={!ipc()}
              onConsent={enableComputerHistory}
              onClear={() => setHistoryClearConfirmOpen(true)}
              onAsk={() => {
                startNewConversation();
                setComposer(appLocale === "ko"
                  ? "최근 컴퓨터 기록을 바탕으로 반복 작업과 에이전트 빌드 후보를 설명해줘."
                  : "Use my recent computer history to explain repeated work and agent-build candidates.");
              }}
              onReviewRecommendation={(entry) => {
                startNewConversation();
                const api = ipc();
                const recommendationId = entry.recommendation?.id;
                if (!api || !recommendationId) {
                  requestOneOperationalRecovery("computer-history-draft", new Error("Computer History evidence unavailable"));
                  return;
                }
                void api.computerHistory.prepareDraft(recommendationId, appLocale)
                  .then((draft) => setComposer(draft.prompt))
                  .catch((cause) => requestOneOperationalRecovery("computer-history-draft", cause));
              }}
            />
          </aside>
        )}
        <TaskSidePanel
          items={runtimeArtifacts}
          onRequestOpen={presentRichOutputRail}
          activity={activity}
          locale={appLocale}
          visible={Boolean((selected || conversation) && contextRailOpen)}
          workerSelection={workerSelection}
          workerRun={workerRun}
          onCloseWorker={() => setWorkerSelection(null)}
          onAdd={() => attachmentInputRef.current?.click()}
          onClose={() => setContextRailOpen(false)}
          width={contextRailWidth}
          onResize={setContextRailWidth}
          onRequestReadableWidth={requestReadableContextRailWidth}
          onRestorePreferredWidth={restorePreferredContextRailWidth}
          minWidth={ONE_CONTEXT_RAIL_WIDTH_MIN}
          maxWidth={contextRailViewportMax()}
          defaultWidth={ONE_CONTEXT_RAIL_WIDTH_DEFAULT}
          result={selected && (surface || (receipt && ["completed", "failed", "cancelled", "interrupted"].includes(receipt.status))) ? (
            <OneAdaptiveResult
              manifest={surface}
              projection={selected}
              receipt={receipt}
              locale={appLocale}
              inOutputRail
              onSemanticAction={handleOneSemanticAction}
              onOpenAgentDraft={openCreateAgentDialog}
              onRetryUnfinished={retryUnfinished}
              onAcceptResult={acceptSelectedResult}
              autoRecovery={autoRecovery}
              valueClosure={selectedValueClosure}
              experienceReuse={selectedExperienceReuse}
              onManageExperience={() => { setProfileOpen(false); setMemoryOpen(true); }}
              valueClosureState={oneValueClosures}
              onValueClosureStateChange={handleValueClosuresChange}
              improvementProof={selectedImprovementProof}
              onManageImprovementAsset={manageImprovementAsset}
            />
          ) : null}
          resultKey={surface
            ? `surface:${surface.manifestId}`
            : receipt && selected
              ? `receipt:${selected.taskId}:${receipt.runId}:${receipt.status}`
              : null}
          resultKind={oneOutputKind}
          appPreview={oneLiveAppPreview}
          computerHistory={computerHistory}
          onHistoryConsent={enableComputerHistory}
          onHistoryClear={() => setHistoryClearConfirmOpen(true)}
          onHistoryAsk={() => {
            startNewConversation();
            setComposer(appLocale === "ko"
              ? "최근 컴퓨터 기록을 바탕으로 반복 작업과 에이전트 빌드 후보를 설명해줘."
              : "Use my recent computer history to explain repeated work and agent-build candidates.");
          }}
          onHistoryReviewRecommendation={(entry) => {
            startNewConversation();
            const api = ipc();
            const recommendationId = entry.recommendation?.id;
            if (!api || !recommendationId) {
              requestOneOperationalRecovery("computer-history-draft", new Error("Computer History evidence unavailable"));
              return;
            }
            void api.computerHistory.prepareDraft(recommendationId, appLocale)
              .then((draft) => setComposer(draft.prompt))
              .catch((cause) => requestOneOperationalRecovery("computer-history-draft", cause));
              }}
          screenChatId={activeThreadChatId}
          browserScopeKey={activeThreadChatId ?? selected?.taskId ?? conversation?.id}
          browserHistoryUrl={durableThreadBrowserUrl}
          onBrowserObserved={presentBrowserOutput}
        />
      </div>

      {/* /one lives in the no-shell route group, so AppShell's global browser
          approval listener is not mounted here. Keep the native approval
          checkpoint in this route explicitly; otherwise browser actions can
          wait behind an invisible sheet. */}
      <BrowserActionApprovalSheet />

      <OneSettingsSheet
        open={settingsSheet}
        locale={appLocale}
        installedPlugins={installedPlugins}
        pluginCatalog={pluginCatalog}
        pluginStatuses={pluginStatuses}
        permission={onePermission}
        runtime={oneRuntime}
        models={oneModelOptions}
        history={computerHistory}
        onClose={() => setSettingsSheet(null)}
        onTogglePlugin={toggleOnePlugin}
        onSelectPermission={setOnePermission}
        onSelectModel={(runtime, model) => applyOneRuntimeSelection({ model }, runtime)}
        onHistoryConsent={enableComputerHistory}
        onOpenMcpLibrary={() => { setSettingsSheet(null); setPluginPickerOpen(true); }}
        onToolTabChange={setSettingsSheet}
      />

      {pluginPickerOpen && <PluginPickerDialog
        ko={appLocale === "ko"}
        onClose={() => setPluginPickerOpen(false)}
        onCompleted={() => {
          const api = ipc();
          if (!api) return;
          void Promise.all([
            api.mcpTools.listInstalled(),
            api.mcpTools.listCatalog(),
            api.mcpTools.status().catch(() => []),
          ]).then(([plugins, catalog, statuses]) => {
            setInstalledPlugins(plugins);
            setPluginCatalog(catalog);
            setPluginStatuses(statuses);
          });
        }}
      />}

      <OneBottomSheet
        open={historyClearConfirmOpen}
        onClose={() => { if (!historyClearBusy) setHistoryClearConfirmOpen(false); }}
        closeLabel={appLocale === "ko" ? "기록 지우기 확인 닫기" : "Close clear-history confirmation"}
        closeDisabled={historyClearBusy}
        closeOnBackdrop={!historyClearBusy}
        closeOnEscape={!historyClearBusy}
        dialogRole="alertdialog"
        size="wide"
        eyebrow={appLocale === "ko" ? "컴퓨터 사용 기록" : "Computer History"}
        title={appLocale === "ko" ? "컴퓨터 사용 기록을 지울까요?" : "Clear Computer History?"}
        titleId="one-computer-history-clear-title"
        ariaLabelledBy="one-computer-history-clear-title"
        description={appLocale === "ko" ? "One에 현재 표시된 기록을 모두 숨깁니다. 원본 앱의 기록이나 파일은 삭제하지 않습니다." : "This hides every history item currently shown in One. It does not delete files or history kept by the source apps."}
      >
        <div className={styles.historyClearConfirmation}>
          <div className={styles.historyClearNote}><IconShield size={18} /><span>{appLocale === "ko" ? "이 작업은 One의 현재 기록 보기에서 되돌릴 수 없습니다." : "This cannot be undone in One's current history view."}</span></div>
          <div className={styles.historyClearActions}>
            <button type="button" disabled={historyClearBusy} onClick={() => setHistoryClearConfirmOpen(false)}>{appLocale === "ko" ? "취소" : "Cancel"}</button>
            <button type="button" className={styles.historyClearDanger} disabled={historyClearBusy} onClick={() => void clearComputerHistoryView()}>{historyClearBusy ? (appLocale === "ko" ? "지우는 중…" : "Clearing…") : (appLocale === "ko" ? "기록 지우기" : "Clear history")}</button>
          </div>
        </div>
      </OneBottomSheet>

      {keyRequestSheet && (
        <McpKeyRequestSheet
          request={keyRequestSheet}
          presentation="one"
          localeOverride={appLocale}
          onResolved={() => setKeyRequestSheet(null)}
        />
      )}

      <OneProfileSheet
        open={profileOpen}
        profile={oneProfile}
        locale={appLocale}
        onClose={closeProfile}
        onProfileChange={handleProfileChange}
      />
      <OneMemorySheet
        open={memoryOpen}
        state={oneMemory}
        locale={appLocale}
        useOnceTarget={oneMemoryUseOnceTarget}
        onClose={closeMemory}
        onStateChange={handleMemoryChange}
        onUseOnceReady={handleMemoryUseOnceReady}
        valueClosure={selectedValueClosure}
        experienceReuse={selectedExperienceReuse}
        improvementProof={selectedImprovementProof}
        valueClosureState={oneValueClosures}
        onValueClosureStateChange={handleValueClosuresChange}
        onManageImprovementAsset={manageImprovementAsset}
      />
      <OneTaskforceDialog
        oneAvatarIcon={oneAvatarTone}
        open={taskforceDialogOpen}
        taskforce={taskforceEditing}
        org={oneOrgState}
        locale={appLocale}
        busy={taskforceBusy}
        onClose={() => {
          setTaskforceDialogOpen(false);
          setTaskforceEditingId(null);
        }}
        onCreate={createTaskforce}
        onUpdate={updateTaskforce}
        onRemove={removeTaskforce}
      />
      <OneCreateAgentDialog
        open={createAgentOpen}
        locale={appLocale}
        seed={createAgentSeed}
        edit={editMemberTarget}
        editOne={editOneTarget}
        onClose={() => {
          setCreateAgentOpen(false);
          setCreateAgentSeed(null);
          setEditMemberTarget(null);
          setEditOneTarget(null);
        }}
        onOpenPrinciples={() => { setEditOneTarget(null); setProfileOpen(true); }}
        onSavedOne={async () => {
          setEditOneTarget(null);
          await refreshAll();
        }}
        onUpdated={async () => {
          setEditMemberTarget(null);
          await refreshAll();
        }}
        onOpenTools={(memberId) => {
          setOrgSheetRequest((current) => ({ token: (current?.token ?? 0) + 1, kind: "tools", memberId }));
        }}
        onReplaceMember={(memberId) => {
          setOrgSheetRequest((current) => ({ token: (current?.token ?? 0) + 1, kind: "replace", memberId }));
        }}
        onArchiveMember={async (memberId) => {
          const member = oneOrgState?.members.find((row) => row.id === memberId);
          if (member) await archiveOneOrg(member);
          await refreshAll();
        }}
        onCreated={async (result) => {
          setCreateAgentOpen(false);
          setCreateAgentSeed(null);
          setOneOrgState(result.state);
          const api = ipc();
          if (api) {
            setAvailableAgents(await api.team.list().catch(() => availableAgents));
          }
          selectedTaskIdRef.current = null;
          selectedConversationIdRef.current = result.chatId;
          setRailOpen(false);
          setSearchOpen(false);
          router.replace(`/one?chat=${encodeURIComponent(result.chatId)}`);
          await refreshAll();
        }}
        onAddExisting={() => {
          // Keep New Agent mounted behind the picker. It owns the draft and
          // becomes inert while OneOrgChart's child sheet owns focus. Only a
          // successful explicit "Add this agent" confirmation closes it.
          setAgentPickerRequest((current) => ({
            token: (current?.token ?? 0) + 1,
            source: "my",
          }));
        }}
      />
      <OneFeatureIntro
        eligible={introEligible}
        needsAcknowledgement={oneIntroPending}
        locale={appLocale}
        replayToken={activationForeground ? 0 : introReplayToken}
        onResolve={acknowledgeOneIntro}
        onOpenOne={startNewConversation}
        onKeepWork={() => undefined}
        briefingAvailable={Boolean(briefingSnapshot?.candidate)}
        onConnectMobile={() => router.push("/settings")}
      />
    </div>
  );
}

function TaskListButton({ item, active, locale, onOpen }: { item: OneTaskProjection; active: boolean; locale: "ko" | "en"; onOpen: (taskId: string) => void }) {
  return (
    <button type="button" className={styles.taskButton} data-active={active ? "true" : "false"} onClick={() => onOpen(item.taskId)} aria-current={active ? "page" : undefined}>
      <strong>{briefingSourceName(item.display.title, locale)}</strong>
      <small>{statusLabel(item.status.value, locale, item.canonicalStatus)} · {formatTimestamp(item.status.asOf, locale)}</small>
      <span className={styles.statusDot} data-status={item.status.value} aria-hidden="true" />
    </button>
  );
}

function ConversationListButton({ item, active, locale, onOpen, onRemove, seatLabel, running, unavailable, member = null, groupMembers = [], oneAvatarTone = "character:orange-dino" }: {
  item: Chat;
  active: boolean;
  locale: "ko" | "en";
  onOpen: (chatId: string) => void;
  onRemove: (chatId: string) => Promise<void>;
  seatLabel?: string;
  running?: boolean;
  unavailable?: boolean;
  member?: OneOrgMember | null;
  groupMembers?: OneOrgMember[];
  oneAvatarTone?: string;
}) {
  const isGroup = item.seatKind === "group" || groupMembers.length > 0;
  const roomTitle = seatLabel?.trim() || briefingSourceName(item.title, locale);
  const unavailableCopy = locale === "ko"
    ? "에이전트가 사라져 세션을 계속할 수 없습니다."
    : "The agent is gone, so this session cannot continue.";
  const preview = unavailable ? unavailableCopy : (item.lastMessagePreview?.trim() || briefingSourceName(item.title, locale));
  return (
    <div className={styles.conversationRow} data-unavailable={unavailable ? "true" : "false"}>
      <button type="button" className={`${styles.taskButton} ${styles.sessionButton}`} data-active={active ? "true" : "false"} onClick={() => onOpen(item.id)} aria-current={active ? "page" : undefined}>
        {isGroup ? <span className={styles.sessionGroupAvatar} aria-label={roomTitle}>
          <OneAgentPortrait status="quiet" label="One" tone={oneAvatarTone} size="small" />
          {groupMembers.slice(0, 2).map((groupMember) => (
            <OneAgentPortrait key={groupMember.installedAgentId} status={groupMember.archivedAt ? "locked" : groupMember.statusKind} label={groupMember.displayName} tone={groupMember.icon} size="small" />
          ))}
        </span> : <OneAgentPortrait
          status={unavailable ? "locked" : member?.statusKind ?? "quiet"}
          label={roomTitle}
          tone={member?.icon ?? oneAvatarTone}
          size="small"
        />}
        <span className={styles.sessionCopy}>
          <span className={styles.sessionTitleLine}>
            <strong>{roomTitle}</strong>
            {unavailable && <span className={styles.sessionWarning} aria-label={locale === "ko" ? "에이전트 없음" : "Agent unavailable"}><IconAlertTriangle size={14} strokeWidth={2} /></span>}
            <time dateTime={item.updatedAt}>{sessionListTime(item.updatedAt, locale)}</time>
          </span>
          <small>{running && <span className={styles.sessionRunningDot} aria-hidden="true" />}{preview}</small>
        </span>
      </button>
      <button type="button" className={styles.conversationDelete} onClick={(event) => { event.stopPropagation(); void onRemove(item.id); }} aria-label={locale === "ko" ? "대화 삭제" : "Delete conversation"}><IconClose size={12} /></button>
    </div>
  );
}

function SearchHitRow({ hit, active, locale, mutationBusy, onOpenTask, onOpenConversation, onMutateArchive }: {
  hit: OneSearchHitV1;
  active: boolean;
  locale: "ko" | "en";
  mutationBusy: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenConversation: (chatId: string) => void;
  onMutateArchive: (taskId: string, operation: "archive" | "restore") => Promise<void>;
}) {
  const kindKeys = {
    task: "one.shell.searchhit.kind.task",
    result: "one.shell.searchhit.kind.result",
    artifact: "one.shell.searchhit.kind.artifact",
    conversation: "one.shell.searchhit.kind.conversation",
    team: "one.shell.searchhit.kind.team",
  } as const;
  const matchKeys = {
    task_title: "one.shell.searchhit.match.task_title",
    conversation_title: "one.shell.searchhit.match.conversation_title",
    conversation_text: "one.shell.searchhit.match.conversation_text",
    result_content: "one.shell.searchhit.match.result_content",
    artifact_label: "one.shell.searchhit.match.artifact_label",
    team_participant: "one.shell.searchhit.match.team_participant",
  } as const;
  const statusKeys = {
    open: "one.shell.searchhit.status.open",
    running: "one.shell.searchhit.status.running",
    "waiting-decision": "one.shell.searchhit.status.waiting-decision",
    partial: "one.shell.searchhit.status.partial",
    completed: "one.shell.searchhit.status.completed",
    failed: "one.shell.searchhit.status.failed",
    cancelled: "one.shell.searchhit.status.cancelled",
    archived: "one.shell.searchhit.status.archived",
    conversation: "one.shell.searchhit.status.conversation",
  } as const;
  const open = () => hit.taskId ? onOpenTask(hit.taskId) : onOpenConversation(hit.chatId);
  return (
    <article className={styles.searchHit} data-active={active ? "true" : "false"} data-archived={hit.archived ? "true" : "false"}>
      <button type="button" className={styles.searchHitOpen} onClick={open}>
        <span className={styles.searchHitHeading}><span className={styles.searchKind}>{tFor(locale, kindKeys[hit.kind])}</span><strong>{hit.title}</strong></span>
        {hit.detail && <span className={styles.searchHitDetail}>{hit.detail}</span>}
        <small>{hit.archived ? tFor(locale, "one.shell.searchhit.status.archived") : tFor(locale, statusKeys[hit.status])} · {formatTimestamp(hit.updatedAt, locale)} · {hit.matchedBy.map((kind) => tFor(locale, matchKeys[kind])).join(" · ")}</small>
      </button>
      {hit.taskId && (
        <button
          type="button"
          className={styles.searchArchiveButton}
          disabled={mutationBusy}
          onClick={() => void onMutateArchive(hit.taskId!, hit.archived ? "restore" : "archive")}
        >
          {mutationBusy
            ? tFor(locale, "one.shell.common.checking")
            : hit.archived
              ? tFor(locale, "one.shell.searchhit.restore")
              : tFor(locale, "one.shell.searchhit.archive")}
        </button>
      )}
    </article>
  );
}

/**
 * 부를 수 없던 팀원의 사유를 사람 말로. 사유는 닫힌 목록이므로 화면이 번역한다
 * — Main 이 문장을 보내면 번역도 못 하고 문구도 못 고친다.
 */
function oneTeamMemberUnavailableText(
  reason: OneTeamMemberUnavailableReason,
  locale: "ko" | "en",
): string {
  if (locale === "ko") {
    switch (reason) {
      case "not_installed": return "이 기기에 설치되어 있지 않습니다.";
      case "source_missing": return "원본 폴더가 사라져 실행할 파일이 없습니다.";
      case "call_only": return "허브에서 빌려 쓰는 좌석이라 이번 실행에 실리지 않았습니다.";
      case "hidden": return "숨김 상태라 부를 수 없습니다.";
      default: return "이번 턴에는 부를 수 없었습니다.";
    }
  }
  switch (reason) {
    case "not_installed": return "It is not installed on this machine.";
    case "source_missing": return "Its source folder is gone, so there is nothing to run.";
    case "call_only": return "It is a borrowed Hub seat and was not carried into this run.";
    case "hidden": return "It is hidden, so it cannot be called.";
    default: return "It could not be called on this turn.";
  }
}

function decisionFieldValue(field: OneDecisionField, locale: "ko" | "en"): string {
  if (field.value === "irreversible") return tFor(locale, "one.shell.decision.irreversible");
  if (field.value === "reversible") return tFor(locale, "one.shell.decision.reversible");
  if (field.value) return field.status === "context_only"
    ? `${field.value} · ${tFor(locale, "one.shell.decision.context_only")}`
    : field.value;
  return field.status === "not_applicable"
    ? tFor(locale, "one.shell.decision.not_applicable")
    : tFor(locale, "one.shell.decision.not_stated");
}

function DecisionInline({ confirmation, taskId, locale, disabled, onAnswer, onAlwaysApprove, onClarify, onSnooze, onDismiss }: {
  confirmation: PendingConfirmation;
  taskId: string | null;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (confirmation: PendingConfirmation, label: string, shouldStart?: boolean) => void;
  onAlwaysApprove: (confirmation: PendingConfirmation) => void;
  onClarify: (confirmation: PendingConfirmation) => void;
  onSnooze: (confirmation: PendingConfirmation) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className={styles.decisionInline}
      role="group"
      aria-label={locale === "ko" ? "One 승인 요청" : "One approval request"}
      data-testid="one-decision-inline"
    >
      <DecisionCard
        confirmation={confirmation}
        taskId={taskId}
        locale={locale}
        disabled={disabled}
        compact
        onAnswer={onAnswer}
        onAlwaysApprove={onAlwaysApprove}
        onClarify={onClarify}
        onSnooze={onSnooze}
      />
      <button
        type="button"
        className={styles.decisionInlineClose}
        onClick={onDismiss}
        aria-label={tFor(locale, "one.shell.decision.close")}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

function DecisionCard({ confirmation, taskId, locale, disabled, compact = false, onAnswer, onAlwaysApprove, onClarify, onSnooze }: {
  confirmation: PendingConfirmation;
  taskId: string | null;
  locale: "ko" | "en";
  disabled: boolean;
  compact?: boolean;
  onAnswer: (confirmation: PendingConfirmation, label: string, shouldStart?: boolean) => void;
  onAlwaysApprove: (confirmation: PendingConfirmation) => void;
  onClarify: (confirmation: PendingConfirmation) => void;
  onSnooze: (confirmation: PendingConfirmation) => void;
}) {
  // The render pass has no synchronous model: warm the judge via the bridge and
  // pass its verdicts. Until/unless a model verdict lands, normalizeOneDecision
  // FAILS CLOSED (highest risk, approval required) — it never keyword-decides.
  const { readers: judgedReaders, modelUnavailable } = useJudgedOneDecision(confirmation);
  const decision: OneDecisionViewV1 = normalizeOneDecision(confirmation, taskId, judgedReaders);
  const riskRank = Number(decision.risk.level.slice(1));
  const directOptions = decision.options.filter((option) => option.enabled && option.disposition !== "reject" && option.disposition !== "modify");
  /*
   * 경고를 띄울 상황인가 — 승인을 막을 상황인가가 아니다.
   *
   * 계약이 더 이상 옵션을 잠그지 않으므로(shared/one-decision.ts) 여기서는 위험 자체를
   * 읽어 배너를 결정한다. 배너는 사용자가 무엇을 승인하는지 알려 주고, 승인 버튼은
   * 그대로 남는다.
   */
  const approvalBlocked = Number(decision.risk.level.slice(1)) >= 2
    && (decision.risk.certainty === "ambiguous" || modelUnavailable);
  const highRiskNotice = approvalBlocked;
  const [multiSelection, setMultiSelection] = useState<number[]>([]);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  useEffect(() => { setMultiSelection([]); setChosenIndex(null); }, [confirmation.sourceMessageId]);
  const selectedMultiLabels = directOptions
    .filter((option) => multiSelection.includes(option.index))
    .map((option) => option.label);

  /*
   * 승인 버튼이 실제로 무엇을 승인하는가.
   *
   * 계약이 옵션을 잠그지 않으므로 여기서는 성격만 보고 고른다(거절·수정 제외).
   */
  const selectableOptions = decision.options.filter((option) =>
    option.disposition !== "reject" && option.disposition !== "modify");
  const approvalReply = confirmation.multiSelect
    ? (selectedMultiLabels.length > 0 ? selectedMultiLabels.join(" · ") : null)
    : selectableOptions.length > 1
      ? (chosenIndex !== null
          ? selectableOptions.find((option) => option.index === chosenIndex)?.label ?? null
          : null)
      : selectableOptions[0]?.label
        ?? decision.action.value
        ?? tFor(locale, "one.shell.decision.approve");
  const approvalSummary = approvalReply ?? tFor(locale, "one.shell.decision.approve");
  const approvalDescription = selectableOptions[0]?.description ?? null;
  const rejectLabel = decision.controls.reject.source === "explicit_option"
    ? decision.controls.reject.reply
    : tFor(locale, "one.shell.decision.reject_default");
  const rejectReply = decision.controls.reject.source === "explicit_option"
    ? decision.controls.reject.reply
    : rejectLabel;
  const rejectOption = decision.options.find((option) => option.disposition === "reject");
  const hasModifyOption = decision.options.some((option) => option.disposition === "modify");
  const candidateSupportingFields: Array<[string, OneDecisionField]> = [
    [tFor(locale, "one.shell.decision.field.cost"), decision.cost],
    [tFor(locale, "one.shell.decision.field.reversibility"), decision.reversibility],
    [tFor(locale, "one.shell.decision.field.deadline"), decision.deadline],
  ];
  if (decision.target.source !== "header" && decision.target.status === "stated") {
    candidateSupportingFields.unshift([tFor(locale, "one.shell.decision.field.target"), decision.target]);
  }
  const supportingFields = candidateSupportingFields.filter(([, field]) => (
    field.status === "stated" && Boolean(field.value)
  ));
  const lightweightChoice = riskRank === 0 && !highRiskNotice && !confirmation.multiSelect;

  if (compact) {
    const compactTitle = confirmation.header?.trim()
      || (riskRank === 0
        ? (locale === "ko" ? "One이 선택을 기다리고 있어요" : "One is waiting for your choice")
        : (locale === "ko" ? "계속 진행할까요?" : "Continue with this action?"));
    const compactSummary = decision.action.value
      || decision.target.value
      || confirmation.question;
    /*
     * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
     * 예전에는 제목·요약·선택지·승인·항상승인·거절이 한 줄에 가로로 늘어서서
     * 무엇을 고르는지 읽을 수 없었다("승인 칩도 누가 저딴식으로 만드냐").
     * 규격은 docs/DESIGN-ASK-CARD.md, 모양은 AskCard 하나가 정한다.
     */
    /*
     * 고르는 질문과 승인은 같은 주제가 아니다(오너 지적 2026-08-24
     * "넌 동작방식이랑 승인이 같은 주제냐?"). 한 카드에 "패널을 어떻게
     * 나눌까" 세 갈래와 "항상 승인 / 거절" 을 함께 담으면, 무엇을 답하는
     * 자리인지 알 수 없다. 고를 것이 있으면 고르는 것만 묻고, 승인·거절은
     * 고를 것이 없을 때의 답이다.
     */
    const pickOptions: AskCardOption[] = lightweightChoice && directOptions.length > 1
      ? directOptions.map((option) => ({
        id: `direct:${option.index}`,
        title: option.label,
        note: option.description ?? undefined,
        disabled,
      }))
      : selectableOptions.length > 1
        ? selectableOptions.map((option) => ({
          id: `pick:${option.index}`,
          title: option.label,
          note: option.description ?? undefined,
          disabled,
          active: confirmation.multiSelect
            ? multiSelection.includes(option.index)
            : chosenIndex === option.index,
        }))
        : [];

    const askOptions: AskCardOption[] = pickOptions.length > 0
      ? pickOptions
      : [
        {
          id: "approve",
          title: riskRank >= 2 ? tFor(locale, "one.shell.decision.approve") : (locale === "ko" ? "승인" : "Approve"),
          note: approvalDescription ?? compactSummary,
          disabled: disabled || approvalReply === null,
          active: true,
        },
        {
          id: "always",
          title: tFor(locale, "one.shell.decision.always_approve"),
          note: tFor(locale, "one.shell.decision.always_approve_hint"),
          disabled: disabled || approvalReply === null,
        },
        { id: "reject", title: rejectLabel, disabled },
      ];

    const chooseAsk = (id: string) => {
      if (id === "reject") { onAnswer(confirmation, rejectReply, false); return; }
      if (id === "always") {
        if (approvalReply === null) return;
        onAlwaysApprove(confirmation);
        onAnswer(confirmation, approvalReply);
        return;
      }
      if (id === "approve") {
        if (approvalReply !== null) onAnswer(confirmation, approvalReply);
        return;
      }
      if (id.startsWith("direct:")) {
        const index = Number(id.slice("direct:".length));
        const option = directOptions.find((item) => item.index === index);
        if (option) onAnswer(confirmation, option.label);
        return;
      }
      if (id.startsWith("pick:")) {
        const index = Number(id.slice("pick:".length));
        if (confirmation.multiSelect) {
          setMultiSelection((current) => current.includes(index)
            ? current.filter((value) => value !== index)
            : [...current, index]);
          return;
        }
        // 하나만 고르는 질문은 고르는 순간이 답이다 — 그 다음에 다시
        // "승인" 을 누르게 하면 같은 답을 두 번 시키는 것이다.
        const option = selectableOptions.find((item) => item.index === index);
        if (option) onAnswer(confirmation, option.label);
      }
    };

    return (
      <AskCard
        title={compactTitle || compactSummary}
        locale={locale}
        options={askOptions}
        onChoose={chooseAsk}
        data-testid="one-decision-ask-card"
      />
    );
  }

  if (lightweightChoice) {
    return (
      <section
        className={styles.decisionCard}
        aria-labelledby={`${confirmation.sourceMessageId}-decision-title`}
        data-risk={decision.risk.level}
        data-variant="choice"
      >
        <div className={styles.decisionHeading}>
          <div>
            <p className={styles.decisionKicker}>{tFor(locale, "one.shell.decision.kicker_choice")}</p>
            <p id={`${confirmation.sourceMessageId}-decision-title`} className={styles.decisionTitle}>
              {decision.action.value || decision.target.value || tFor(locale, "one.shell.decision.direction_q")}
            </p>
          </div>
        </div>
        <div className={styles.decisionOptions}>
          {directOptions.map((option) => (
            <button
              key={`${option.index}:${option.label}`}
              type="button"
              className={styles.decisionPrimaryButton}
              disabled={disabled}
              title={option.description ?? undefined}
              onClick={() => onAnswer(confirmation, option.label)}
            >
              {option.label}
            </button>
          ))}
          {/*
            * ★단추만 없는 완성된 기능이었다 (실측 2026-09-08).
            *   `clarifyConfirmation` 은 One 에게 "무엇이 빠졌는지 물어보고 선택지를 다시
            *   정리해 달라"고 실제로 실행을 거는 완성된 경로이고, 라벨
            *   `one.shell.decision.change_scope` 도 두 언어로 이미 있었다. 부모는 그 핸들러를
            *   `onClarify` 로 내려보내고 있었다. **그런데 이 카드가 그 prop 을 한 번도 안
            *   썼다** — 부르는 단추가 없어서 사람은 "왜 이걸 묻는지" 되물을 길이 없었다.
            *   핸들러·라벨·배선이 다 살아 있는데 마지막 칸만 비어 있던 자리다.
            */}
          <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onClarify(confirmation)}>
            {tFor(locale, "one.shell.decision.change_scope")}
          </button>
          <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>
            {tFor(locale, "one.shell.decision.remind_24h")}
          </button>
        </div>
        <p className={styles.decisionHint}>{tFor(locale, "one.shell.decision.choice_hint")}</p>
      </section>
    );
  }
  return (
    <section className={styles.decisionCard} aria-labelledby={`${confirmation.sourceMessageId}-decision-title`} data-risk={decision.risk.level}>
      <div className={styles.decisionHeading}>
        <div>
          <p className={styles.decisionKicker}>{tFor(locale, "one.shell.decision.kicker_decision")}</p>
          <p id={`${confirmation.sourceMessageId}-decision-title`} className={styles.decisionTitle}>{decision.target.source === "header" && decision.target.value ? decision.target.value : tFor(locale, "one.shell.decision.review_next_action")}</p>
        </div>
      </div>

      {decision.action.value && (
        <section className={styles.decisionContext} aria-labelledby={`${confirmation.sourceMessageId}-decision-context`}>
          <p id={`${confirmation.sourceMessageId}-decision-context`} className={styles.decisionSectionLabel}>
            {tFor(locale, "one.shell.decision.current_situation")}
          </p>
          <p>{decision.action.value}</p>
        </section>
      )}

      {supportingFields.length > 0 && (
        <dl className={styles.decisionMetadata}>
          {supportingFields.map(([label, field]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{decisionFieldValue(field, locale)}</dd>
            </div>
          ))}
        </dl>
      )}

      {highRiskNotice && (
        <div className={styles.decisionGuard} role="status">
          <strong>{tFor(locale, modelUnavailable
            ? "one.shell.decision.model_review_pending"
            : "one.shell.decision.approval_unavailable")}</strong>
          <span>{tFor(locale, modelUnavailable
            ? "one.shell.decision.model_review_pending_body"
            : "one.shell.decision.approval_unavailable_body")}</span>
          {selectableOptions.length > 0 && <small>{tFor(locale, "one.shell.decision.choices_requiring_review")}: {selectableOptions.map((option) => option.label).join(" · ")}</small>}
        </div>
      )}

      {/*
        고를 것이 실제로 여럿일 때만 선택 칩을 둔다.
        아래 액션은 언제나 승인·항상 승인·거절 셋뿐이고, 칩은 "무엇을" 승인할지만 고른다.
      */}
      {selectableOptions.length > 1 && (
        <div className={styles.decisionMultiOptions} role="group" aria-label={tFor(locale, "one.shell.decision.multi_select")}>
          {selectableOptions.map((option) => {
            const selected = confirmation.multiSelect
              ? multiSelection.includes(option.index)
              : chosenIndex === option.index;
            return (
              <button
                key={`${option.index}:${option.label}`}
                type="button"
                className={styles.decisionMultiOption}
                aria-pressed={selected}
                disabled={disabled}
                title={option.description ?? undefined}
                onClick={() => {
                  if (confirmation.multiSelect) {
                    setMultiSelection((current) => selected
                      ? current.filter((index) => index !== option.index)
                      : [...current, option.index]);
                  } else {
                    setChosenIndex(option.index);
                  }
                }}
              >
                <span aria-hidden="true">{selected ? <IconCheck size={12} /> : null}</span>{option.label}
              </button>
            );
          })}
        </div>
      )}
      {confirmation.multiSelect && (
        <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>
          {tFor(locale, "one.shell.decision.remind_24h")}
        </button>
      )}

      <div className={styles.decisionActionGroup}>
        <p className={styles.decisionSectionLabel}>{tFor(locale, "one.shell.decision.choose_action")}</p>
        {/*
          ★버튼은 셋뿐이다 — 승인 · 항상 승인 · 거절 (오너 지시 2026-08-19).

          이전에는 위험도가 높고 판정이 모호하면 승인 버튼이 통째로 사라지고 거절·되묻기·
          미루기만 남았다. 즉 사용자가 하려던 일을 **승인할 방법이 화면에 없었다**(실측:
          X 게시 승인 요청에서 Reject / Ask what is missing / Remind me in 24 hours 세 개만
          렌더됨). 위험을 알리는 방법은 승인 경로를 지우는 것이 아니라 무엇을 승인하는지
          똑똑히 보여주는 것이다 — 경고는 위 가드 배너가 계속 말한다.
        */}
        <div className={styles.decisionOptions}>
          <button
            type="button"
            className={styles.decisionPrimaryButton}
            disabled={disabled || approvalReply === null}
            onClick={() => approvalReply !== null && onAnswer(confirmation, approvalReply)}
          >
            <span>{confirmation.multiSelect
              ? tFor(locale, "one.shell.decision.confirm_selection_and_run")
              : riskRank >= 2
                ? tFor(locale, "one.shell.decision.approve_and_run", { action: approvalSummary })
                : tFor(locale, "one.shell.decision.approve")}</span>
            {selectableOptions.length <= 1 && approvalDescription && <small>{approvalDescription}</small>}
          </button>
        </div>
        <div className={styles.decisionSecondaryActions}>
          {!confirmation.multiSelect && (
            <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>
              {tFor(locale, "one.shell.decision.remind_24h")}
            </button>
          )}
          <button
            type="button"
            className={styles.decisionButton}
            disabled={disabled || approvalReply === null}
            title={tFor(locale, "one.shell.decision.always_approve_hint")}
            onClick={() => {
              if (approvalReply === null) return;
              onAlwaysApprove(confirmation);
              onAnswer(confirmation, approvalReply);
            }}
          >
            <span>{tFor(locale, "one.shell.decision.always_approve")}</span>
            <small>{tFor(locale, "one.shell.decision.always_approve_hint")}</small>
          </button>
          <button type="button" className={styles.decisionRejectButton} disabled={disabled} onClick={() => onAnswer(confirmation, rejectReply, false)}>
            <span>{rejectLabel}</span>
            {rejectOption?.description && <small>{rejectOption.description}</small>}
          </button>
        </div>
      </div>

      <details className={styles.decisionEvidence}>
        <summary>{tFor(locale, "one.shell.decision.evidence_summary")}</summary>
        <p>{tFor(locale, "one.shell.decision.evidence", { time: formatTimestamp(decision.createdAt, locale) })}</p>
      </details>
      <p className={styles.decisionHint}>{decisionRejectCopy(locale)}</p>
    </section>
  );
}

function ResolvedDecisionReceipt({ receipt, locale }: { receipt: CommittedQuestionAnswer; locale: "ko" | "en" }) {
  return (
    <details className={styles.resolvedDecision}>
      <summary>
        <span className={styles.resolvedDecisionSummary}>
          <span className={styles.resolvedDecisionCheck} aria-hidden="true"><IconCheck size={12} /></span>
          <span>
            <strong>{receipt.reply}</strong>
            <small>{tFor(locale, "one.shell.receipt.selected")}</small>
          </span>
        </span>
        <time dateTime={receipt.ts}>{formatTimestamp(receipt.ts, locale)}</time>
      </summary>
      <div>
        <p>{tFor(locale, "one.shell.receipt.change_mind")}</p>
        <small>{tFor(locale, "one.shell.receipt.selected_at", { time: formatTimestamp(receipt.ts, locale) })}</small>
      </div>
    </details>
  );
}

/**
 * 작성창의 Enter 처리 — **한글 조합 확정과 전송을 가르는 자리.**
 *
 * ★실사용 실측 2026-09-07 (오너): One 에서 한글을 치고 Enter 를 누르면 전송이 아니라
 *   **줄바꿈이 들어갔다.** "다시" 를 치면 "다\n시" 가 된다. 사용자는 문장을 못 쓴다.
 *
 * 원인은 브라우저마다 다른 이벤트 순서다. 크로미움은 조합 확정 Enter 에서
 * `compositionend` 를 **keydown 보다 먼저** 쏜다 — 그래서 그 keydown 은
 * `isComposing === false` 로 온다. 그걸 잡으려고 `onCompositionEnd` 에서
 * `setTimeout(…, 0)` 으로 ref 를 잠깐 더 켜 두는데(위 composerComposingRef),
 * 옛 코드는 그 ref 가 켜져 있으면 **아무것도 안 하고 return** 했다.
 * 전송은 막혔지만 `preventDefault()` 를 안 했으니 textarea 의 기본 동작
 * (줄바꿈 삽입)이 그대로 일어난다. 막은 것이 아니라 다른 일이 일어나게 둔 것이다.
 *
 * 규칙:
 *  - IME 가 아직 그 키를 쥐고 있으면(`isComposing`/229) 손대지 않는다. 그 Enter 는
 *    조합을 확정하는 데 쓰이고 브라우저가 줄바꿈을 넣지 않는다.
 *  - 조합이 방금 끝난 Enter(우리 ref 만 켜져 있는 상태)는 **전송도 줄바꿈도 아니다.**
 *    삼키되 반드시 기본 동작을 막는다 — 이 한 줄이 빠져 있었다.
 *  - 그 외 Enter 는 전송, Shift+Enter 는 평소대로 줄바꿈.
 */
function handleComposerKey(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  action: () => void,
  composing = false,
) {
  // IME 가 아직 쥐고 있는 키는 건드리지 않는다(사파리/윈도우 경로).
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key !== "Enter" || event.shiftKey) return;
  if (composing) {
    // 크로미움 경로: 조합은 이미 끝났고 이 Enter 는 확정용이다.
    // 막지 않으면 줄바꿈이 들어간다.
    event.preventDefault();
    return;
  }
  event.preventDefault();
  action();
}
