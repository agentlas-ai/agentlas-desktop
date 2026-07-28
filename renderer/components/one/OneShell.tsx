"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Markdown, StreamingMarkdown } from "@/components/Markdown";
import { IconArrowUp, IconPlus, IconRefresh } from "@/components/Icon";
import { grantForDroppedFile, ipc, ipcEvents } from "@/lib/ipc";
import { tFor, useT } from "@/lib/i18n";
import { extractQuestions } from "@/lib/ask-question";
import {
  detectOneTextLocale,
  type OneConversationLocale,
} from "@/lib/one-conversation-locale";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import {
  initialOneRunProgress,
  ONE_RUN_STAGE_ORDER,
  oneRunStageLabel,
  reduceOneRunProgress,
  type OneRunProgressState,
} from "@/lib/one-run-progress";
import type {
  Chat,
  ChatHistoryEntry,
  CommittedQuestionAnswer,
  InvocationRunReceipt,
  McpInvocationEvent,
  MobileBridgeRuntimeStatus,
  OneBriefingSnapshot,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneExperienceReuseState,
  OneImprovementProofReadState,
  OneImprovementReusedAssetV1,
  OneHomeSignalsV1,
  OneProfile,
  OneProactiveBriefing,
  OneSearchHitV1,
  OneSuggestionState,
  OneTeamPreflightProposal,
  OneTeamPreflightRef,
  OneValueClosureState,
  OneWeeklyReflectionSnapshotV1,
  PendingConfirmation,
  UpdaterState,
} from "@/lib/types";
import {
  type OneFeatureIntroBlockingStateCategory,
  type OneFeatureIntroResolution,
  type OneFeatureIntroState,
} from "@shared/one-feature-intro";
import type {
  OneActivationMobileResolution,
  OneActivationState,
} from "@shared/one-activation";
import type { OneSurfaceManifestV1 } from "@shared/one-surface";
import { customerSafeProgressDetail, toCustomerSafeText } from "@shared/one-customer-safe";
import { classifyOneRequestIntent } from "@shared/one-request-intent";
import { judgmentUnavailableMessage } from "@shared/judgment-fallback";
import { useJudgedOneDecision } from "@/lib/one-decision-judged";
import type { OneRecurrenceSelectionV1 } from "@shared/one-recurrence";
import { shouldPresentOneWeeklyReflection } from "@shared/one-weekly-reflection";
import {
  ONE_ATTACHMENT_LIMITS,
  type OneAttachmentPrepareItem,
  type OneAttachmentSafeItem,
  type PreparedOneAttachments,
} from "@shared/one-attachments";
import type { FsPathGrant } from "@shared/types";
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
  resolveOneTaskWorkTarget,
  type OneTaskProjection,
} from "@/lib/one-task-adapter";
import {
  subscribe as buildSessionSubscribe,
  getSnapshot as getBuildSessionSnapshot,
} from "@/lib/build-session";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneAutomationSheet } from "./OneAutomationSheet";
import { OneUseCaseChips, type OneUseCaseChipAction } from "./OneUseCaseChips";
import { OneBrandLockup, OneBrandMark } from "./OneBrand";
import { OneAdaptiveResult } from "./OneAdaptiveResult";
import { OneActivation } from "./OneActivation";
import { OneFeatureIntro } from "./OneFeatureIntro";
import { OneOnboarding } from "./OneOnboarding";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneMemoryCandidateCard } from "./OneMemoryCandidateCard";
import { OneProfileSheet } from "./OneProfileSheet";
import { OneRecurrenceControl } from "./OneRecurrenceControl";
import { OneSuggestionCard } from "./OneSuggestionCard";
import { OneGrowthCard } from "./OneGrowthCard";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { OneWeeklyReflectionCard } from "./OneWeeklyReflectionCard";
import styles from "./OneShell.module.css";

const DECISION_REJECT_FALLBACK = {
  ko: "거절과 나중에 결정은 승인이나 외부 실행을 시작하지 않습니다.",
  en: "Rejecting or deciding later does not approve or start an external action.",
} as const;

function decisionRejectCopy(locale: "ko" | "en"): string {
  const key = "one.shell.decision.reject_hint" as const;
  const value = tFor(locale, key);
  return value === key ? DECISION_REJECT_FALLBACK[locale] : value;
}

function OneFirstRunTitle({ locale }: { locale: "ko" | "en" }) {
  const title = tFor(locale, "one.shell.firstrun.title");
  if (locale !== "ko") return <>{title}</>;

  const clauseBreak = title.indexOf(",");
  if (clauseBreak < 0) return <>{title}</>;

  return (
    <>
      <span className={styles.newUserTitleLine}>{title.slice(0, clauseBreak + 1)}</span>
      <span className={styles.newUserTitleLine}>{title.slice(clauseBreak + 1).trim()}</span>
    </>
  );
}

type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
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
};

type OneAttachmentDraft = {
  id: string;
  grant: FsPathGrant;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
  previewUrl: string | null;
};

const UPDATE_BLOCKING_STATES = new Set<UpdaterState["status"]>([
  "available",
  "downloading",
  "downloaded",
  "installing",
  "manual-required",
  "incompatible",
  "recovery-required",
]);
const BRIEFING_DISMISS_KEY = "agentlas.one.briefingDismissals.v1";
const BRIEFING_DISMISS_MS = 24 * 60 * 60 * 1_000;
const ONE_SEARCH_CONTRACT_VERSION = "1.0.0" as const;

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function attachmentKind(file: File): "image" | "file" {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name) ? "image" : "file";
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
  return history.map((entry) => ({
    id: entry.id,
    role: entry.role === "assistant" ? "assistant" : entry.role,
    text: entry.text,
  }));
}

function isResultContinuationMessage(message: UiMessage): boolean {
  return message.role === "system" && /^(?:완료한|검토 중인) 이전 일에서 이어갑니다|^Continuing from the (?:completed|result-ready) work/.test(message.text);
}

/**
 * One owns its decision/question UI. Model-authored ask fences are an internal
 * transport protocol and must never be rendered beside the resulting card.
 * During streaming, hide an unfinished fence from its opening marker onward;
 * once closed, reuse the canonical parser so malformed JSON is still removed.
 */
function visibleOneMessageText(message: UiMessage): string {
  if (isResultContinuationMessage(message)) {
    return tFor(detectOneTextLocale(message.text) === "ko" ? "ko" : "en", "one.shell.continuation.body");
  }
  if (message.role !== "assistant") return message.text;
  const extracted = extractQuestions(message.text, message.id).text;
  const unfinishedFence = extracted.indexOf("<<agentlas-ask>>");
  const withoutFence = unfinishedFence >= 0 ? extracted.slice(0, unfinishedFence) : extracted;
  // Host/router worker banners are useful in operator logs, not in a personal
  // chief-of-staff conversation. Strip every standalone banner line because a
  // resumed provider turn can insert one after an introductory sentence.
  const banded = withoutFence
    .replace(/^\s*(?:\*\*)?(?:사용\s*(?:에이전트|스킬)|Agents used|Skills used)(?:\*\*)?\s*:\s*[^\n]*(?:\n[ \t]*)*/gim, "")
    .trim();
  // Final customer-safe pass: a leaked result-schema line ("structured result",
  // "safe One Surface", a CLI/session token) must never reach the reader even
  // when it arrives through a model or legacy synthesis path.
  return toCustomerSafeText(banded, detectOneTextLocale(banded) === "ko" ? "ko" : "en");
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

function briefingSignature(briefing: ReturnType<typeof chooseOneBriefing>): string {
  return [briefing.kind, briefing.taskId ?? "none", briefing.evidence.join("|")].join(":");
}

function oneMemoryUseOnceTargetKey(target: OneMemoryUseOnceTarget): string {
  return [target.chatId, target.expectedTaskId ?? "conversation", target.expectedTaskVersion ?? "none"].join(":");
}

/** 카드 제목에 들어가는 이름 — 원문 프롬프트가 통째로 박히지 않게 마크다운을 걷어내고 짧게 자른다. */
function briefingSourceName(raw: string): string {
  const cleaned = raw.replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return raw.slice(0, 40);
  return cleaned.length > 44 ? `${cleaned.slice(0, 43).trimEnd()}…` : cleaned;
}

function proactiveBriefingView(candidate: OneProactiveBriefing, locale: "ko" | "en"): DisplayBriefing {
  const ko = locale === "ko";
  const source = briefingSourceName(candidate.source.label);
  const copyKeys = {
    project_folder_missing: {
      eyebrow: "one.shell.proactive.project_folder_missing.eyebrow",
      title: "one.shell.proactive.project_folder_missing.title",
      body: "one.shell.proactive.project_folder_missing.body",
      prepared: "one.shell.proactive.project_folder_missing.prepared",
    },
    project_folder_unreadable: {
      eyebrow: "one.shell.proactive.project_folder_unreadable.eyebrow",
      title: "one.shell.proactive.project_folder_unreadable.title",
      body: "one.shell.proactive.project_folder_unreadable.body",
      prepared: "one.shell.proactive.project_folder_unreadable.prepared",
    },
    project_folder_not_directory: {
      eyebrow: "one.shell.proactive.project_folder_not_directory.eyebrow",
      title: "one.shell.proactive.project_folder_not_directory.title",
      body: "one.shell.proactive.project_folder_not_directory.body",
      prepared: "one.shell.proactive.project_folder_not_directory.prepared",
    },
    project_deadline_conflict: {
      eyebrow: "one.shell.proactive.project_deadline_conflict.eyebrow",
      title: "one.shell.proactive.project_deadline_conflict.title",
      body: "one.shell.proactive.project_deadline_conflict.body",
      prepared: "one.shell.proactive.project_deadline_conflict.prepared",
    },
    automation_error: {
      eyebrow: "one.shell.proactive.automation_error.eyebrow",
      title: "one.shell.proactive.automation_error.title",
      body: "one.shell.proactive.automation_error.body",
      prepared: "one.shell.proactive.automation_error.prepared",
    },
    automation_blocked: {
      eyebrow: "one.shell.proactive.automation_blocked.eyebrow",
      title: "one.shell.proactive.automation_blocked.title",
      body: "one.shell.proactive.automation_blocked.body",
      prepared: "one.shell.proactive.automation_blocked.prepared",
    },
    automation_needs_input: {
      eyebrow: "one.shell.proactive.automation_needs_input.eyebrow",
      title: "one.shell.proactive.automation_needs_input.title",
      body: "one.shell.proactive.automation_needs_input.body",
      prepared: "one.shell.proactive.automation_needs_input.prepared",
    },
    automation_partial: {
      eyebrow: "one.shell.proactive.automation_partial.eyebrow",
      title: "one.shell.proactive.automation_partial.title",
      body: "one.shell.proactive.automation_partial.body",
      prepared: "one.shell.proactive.automation_partial.prepared",
    },
    task_waiting_decision_stale: {
      eyebrow: "one.shell.proactive.task_waiting_decision_stale.eyebrow",
      title: "one.shell.proactive.task_waiting_decision_stale.title",
      body: "one.shell.proactive.task_waiting_decision_stale.body",
      prepared: "one.shell.proactive.task_waiting_decision_stale.prepared",
    },
    task_running_without_active_run: {
      eyebrow: "one.shell.proactive.task_running_without_active_run.eyebrow",
      title: "one.shell.proactive.task_running_without_active_run.title",
      body: "one.shell.proactive.task_running_without_active_run.body",
      prepared: "one.shell.proactive.task_running_without_active_run.prepared",
    },
    task_failed_repeated: {
      eyebrow: "one.shell.proactive.task_failed_repeated.eyebrow",
      title: "one.shell.proactive.task_failed_repeated.title",
      body: "one.shell.proactive.task_failed_repeated.body",
      prepared: "one.shell.proactive.task_failed_repeated.prepared",
    },
    task_failed_abandoned: {
      eyebrow: "one.shell.proactive.task_failed_abandoned.eyebrow",
      title: "one.shell.proactive.task_failed_abandoned.title",
      body: "one.shell.proactive.task_failed_abandoned.body",
      prepared: "one.shell.proactive.task_failed_abandoned.prepared",
    },
    task_partial_abandoned: {
      eyebrow: "one.shell.proactive.task_partial_abandoned.eyebrow",
      title: "one.shell.proactive.task_partial_abandoned.title",
      body: "one.shell.proactive.task_partial_abandoned.body",
      prepared: "one.shell.proactive.task_partial_abandoned.prepared",
    },
  } as const;
  const selected = copyKeys[candidate.reasonCode];
  const evidence = [
    `${tFor(locale, "one.shell.proactive.evidence.source")}: ${source}`,
    `${tFor(locale, "one.shell.proactive.evidence.observed")}: ${formatTimestamp(candidate.detectedAt, locale)}`,
    `${tFor(locale, "one.shell.proactive.evidence.confidence")}: ${candidate.confidence.level === "high" ? tFor(locale, "one.shell.proactive.confidence.high") : candidate.confidence.level === "medium" ? tFor(locale, "one.shell.proactive.confidence.medium") : tFor(locale, "one.shell.proactive.confidence.low")}`,
    `${tFor(locale, "one.shell.proactive.evidence.scope")}: ${candidate.reasonCode === "project_deadline_conflict" ? tFor(locale, "one.shell.proactive.scope.deadline") : candidate.source.kind === "project_folder" ? tFor(locale, "one.shell.proactive.scope.project_folder") : candidate.source.kind === "automation_run" ? tFor(locale, "one.shell.proactive.scope.automation_run") : tFor(locale, "one.shell.proactive.scope.default")}`,
  ];
  return {
    kind: candidate.reasonCode === "automation_needs_input" ? "decision" : "failed",
    eyebrow: tFor(locale, selected.eyebrow),
    title: tFor(locale, selected.title, { name: source }),
    body: tFor(locale, selected.body),
    prepared: tFor(locale, selected.prepared),
    evidence,
    primaryLabel: candidate.preparedAction.kind === "open_project"
      ? tFor(locale, "one.shell.proactive.action.open_project")
      : candidate.preparedAction.kind === "open_automation"
        ? tFor(locale, "one.shell.proactive.action.open_automation")
        : tFor(locale, "one.shell.proactive.action.open_task"),
    proactive: candidate,
  };
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

export function OneShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams.get("task");
  const selectedConversationId = searchParams.get("chat");
  const { locale, setPref } = useT();
  const appLocale: OneConversationLocale = locale === "ko" ? "ko" : "en";
  const [loaded, setLoaded] = useState(false);
  const [projections, setProjections] = useState<OneTaskProjection[]>([]);
  const [conversations, setConversations] = useState<Chat[]>([]);
  const [selected, setSelected] = useState<OneTaskProjection | null>(null);
  const [conversation, setConversation] = useState<Chat | null>(null);
  const [activeChatIds, setActiveChatIds] = useState<string[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [committedAnswers, setCommittedAnswers] = useState<CommittedQuestionAnswer[]>([]);
  const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null);
  const [mobileStatus, setMobileStatus] = useState<MobileBridgeRuntimeStatus | null>(null);
  const [oneProfile, setOneProfile] = useState<OneProfile | null>(null);
  const [oneMemory, setOneMemory] = useState<OneMemoryState | null>(null);
  const [armedOneMemoryUseOnce, setArmedOneMemoryUseOnce] = useState<ArmedOneMemoryUseOnce | null>(null);
  const [oneSuggestions, setOneSuggestions] = useState<OneSuggestionState | null>(null);
  const [oneValueClosures, setOneValueClosures] = useState<OneValueClosureState | null>(null);
  const [oneWeeklyReflection, setOneWeeklyReflection] = useState<OneWeeklyReflectionSnapshotV1 | null>(null);
  const [oneExperienceReuse, setOneExperienceReuse] = useState<OneExperienceReuseState | null>(null);
  const [oneImprovementProofs, setOneImprovementProofs] = useState<OneImprovementProofReadState | null>(null);
  const [oneIntroState, setOneIntroState] = useState<OneFeatureIntroState | null>(null);
  const [oneHomeSignals, setOneHomeSignals] = useState<OneHomeSignalsV1 | null>(null);
  const [automationSheetOpen, setAutomationSheetOpen] = useState(false);
  const [oneOnboardingVisible, setOneOnboardingVisible] = useState(true);
  const [oneActivationState, setOneActivationState] = useState<OneActivationState | null>(null);
  const [briefingSnapshot, setBriefingSnapshot] = useState<OneBriefingSnapshot | null>(null);
  const [briefingActionBusy, setBriefingActionBusy] = useState(false);
  const [teamPreflight, setTeamPreflight] = useState<OneTeamPreflightProposal | null>(null);
  const [teamPreflightBusy, setTeamPreflightBusy] = useState(false);
  const [pendingTeamPrompt, setPendingTeamPrompt] = useState<PendingTeamPrompt | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [surface, setSurface] = useState<OneSurfaceManifestV1 | null>(null);
  const [receipt, setReceipt] = useState<InvocationRunReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptingResult, setAcceptingResult] = useState(false);
  const [runStatus, setRunStatus] = useState("");
  const [runProgress, setRunProgress] = useState<OneRunProgressState>(() => initialOneRunProgress());
  // Host-owned liveness for a running turn. The stage label and status detail
  // only move when the runtime emits an event, and a long research turn can emit
  // nothing for minutes — leaving an identical card on screen that is
  // indistinguishable from a hang. This clock never depends on the runtime.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsedTick, setRunElapsedTick] = useState(0);
  const [composer, setComposer] = useState("");
  const [recurrenceSelection, setRecurrenceSelection] = useState<OneRecurrenceSelectionV1 | null>(null);
  const [recurrencePanelOpen, setRecurrencePanelOpen] = useState(false);
  const [attachmentDrafts, setAttachmentDrafts] = useState<OneAttachmentDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<OneSearchHitV1[]>([]);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchIncludeArchived, setSearchIncludeArchived] = useState(true);
  const [archiveMutationTaskId, setArchiveMutationTaskId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [dismissedBriefing, setDismissedBriefing] = useState<{ signature: string; expiresAt: number } | null>(null);
  const [introReplayToken, setIntroReplayToken] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const configuredOneLocale = oneProfile?.preferredLocale === "ko" || oneProfile?.preferredLocale === "en"
    ? oneProfile.preferredLocale
    : appLocale;
  // Every piece of One chrome follows the explicit app language (or the
  // explicit One profile override). Titles of old conversations or tasks must
  // never flip the UI language; only the model's reply mirrors the language
  // the user actually typed, which the runner detects from the prompt itself.
  const normalizedLocale = configuredOneLocale;
  const structuredResultMessageId = useMemo(() => {
    if (!surface) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && !message.streaming) return message.id;
    }
    return null;
  }, [messages, surface]);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchSheetRef = useRef<HTMLElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultTopRef = useRef<HTMLDivElement>(null);
  const attachmentDragDepthRef = useRef(0);
  const attachmentDraftsRef = useRef<OneAttachmentDraft[]>([]);
  const attachmentThreadRef = useRef<string | null>(null);
  const autoResolvingProposalRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const runTaskIdRef = useRef<string | null>(null);
  const runChatIdRef = useRef<string | null>(null);
  const streamTextRef = useRef("");
  const unsubscribeRunRef = useRef<(() => void) | null>(null);
  const selectedTaskIdRef = useRef(selectedTaskId);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const introDeferralInFlightRef = useRef<string | null>(null);
  const searchRequestRef = useRef(0);
  selectedTaskIdRef.current = selectedTaskId;
  selectedConversationIdRef.current = selectedConversationId;
  attachmentDraftsRef.current = attachmentDrafts;

  // The run clock starts when the turn starts and is cleared when it ends, so a
  // stale duration can never be shown next to a run that is no longer going.
  useEffect(() => {
    setRunStartedAt(busy ? Date.now() : null);
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setRunElapsedTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  // runElapsedTick exists purely to re-render the clock each second.
  void runElapsedTick;

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
  }, []);

  const clearAttachmentDrafts = useCallback(() => {
    const current = attachmentDraftsRef.current;
    attachmentDraftsRef.current = [];
    for (const item of current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setAttachmentDrafts([]);
    setAttachmentError(null);
    setAttachmentDragActive(false);
    attachmentDragDepthRef.current = 0;
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
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
    if (event.shiftKey && document.activeElement === first) {
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
    if (!api?.oneSearch || !value) return;
    const requestId = ++searchRequestRef.current;
    if (input.append) setSearchLoadingMore(true);
    else setSearchLoading(true);
    setSearchError(null);
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
      setSearchError(cause instanceof Error ? cause.message : String(cause));
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
      setSearchError(null);
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

  const refreshAll = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoaded(true);
      setProjections([]);
      setConversations([]);
      setActiveChatIds([]);
      setConfirmations([]);
      setOneProfile(null);
      setOneMemory(null);
      setOneSuggestions(null);
      setOneValueClosures(null);
      setOneWeeklyReflection(null);
      setOneExperienceReuse(null);
      setOneImprovementProofs(null);
      setOneIntroState(null);
      setOneActivationState(null);
      setBriefingSnapshot(null);
      setOneHomeSignals(null);
      return;
    }
    try {
      const [active, pending, update, mobile, recentChats, profile, memory, suggestions, valueClosures, weeklyReflection, experienceReuse, improvementProofs, proactiveBriefing, intro, activation, homeSignals] = await Promise.all([
        api.invoke.activeChats().catch(() => []),
        api.confirm.listPending().catch(() => []),
        api.updater.getState().catch(() => null),
        api.mobileBridge.status().catch(() => null),
        api.chats.listRecent(40).catch(() => []),
        api.oneProfile.get(),
        api.oneMemory.getState().catch(() => null),
        api.oneSuggestions.getState().catch(() => null),
        api.oneValueClosure.getState().catch(() => null),
        api.oneWeeklyReflection.get().catch(() => null),
        api.oneExperienceReuse.getState().catch(() => null),
        api.oneImprovementProof.getState().catch(() => null),
        api.oneBriefing.get().catch(() => null),
        api.oneFeatureIntro.getState().catch(() => null),
        api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null),
        api.oneHomeSignals.get().catch(() => null),
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
      const items = await listOneTaskProjections(api, active, pending, profile);
      setActiveChatIds(active);
      setConfirmations(pending);
      setUpdaterState(update);
      setMobileStatus(mobile);
      setOneProfile(profile);
      setOneMemory(memory);
      setOneSuggestions(suggestions);
      setOneValueClosures(valueClosures);
      setOneWeeklyReflection(weeklyReflection);
      setOneExperienceReuse(experienceReuse);
      setOneImprovementProofs(improvementProofs);
      setOneIntroState(resolvedIntro);
      setOneActivationState(activation);
      setOneHomeSignals(homeSignals);
      setBriefingSnapshot(safeBriefingSnapshot(proactiveBriefing));
      setProjections(items);
      // One 홈은 One이 시작한 대화만 보여준다 — 전역 Work 대화는 Work에 남는다.
      setConversations(recentChats.filter((chat) => !chat.taskId && chat.originSurface === "one"));
      const wanted = selectedTaskIdRef.current;
      if (wanted) {
        const detail = items.find((item) => item.taskId === wanted)
          ?? await getOneTaskProjection(api, wanted, active, pending, profile);
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
            ?? await getOneTaskProjection(api, promotedTask.id, active, pending, profile);
          setSelected(detail);
          setConversation(null);
          setReceipt(detail?.latestReceipt ?? null);
          router.replace(`/one?task=${encodeURIComponent(promotedTask.id)}`);
        } else if (chat && chat.originSurface !== "one") {
          // One's home only ever renders One-surface conversations. A deep link
          // to a Work chat — e.g. an automation run session, which is always
          // stored with origin_surface 'work' — must open in the Work chat
          // surface instead of leaking Work history into One. The recent-chat
          // list above already filters by originSurface; this closes the
          // asymmetric single-chat deep-link path that let "보기" surface a Work
          // automation transcript inside One.
          selectedConversationIdRef.current = null;
          setSelected(null);
          setConversation(null);
          setReceipt(null);
          router.replace(`/chat?id=${encodeURIComponent(chat.id)}`);
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [appLocale, router]);

  useEffect(() => {
    void refreshAll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll();
    }, 5_000);
    window.addEventListener("focus", onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAll]);

  const reconcileConversationTask = useCallback(async (chatId: string) => {
    const api = ipc();
    if (!api) return null;
    const task = await api.tasks.findForChat(chatId).catch(() => null);
    if (!task) return null;
    runTaskIdRef.current = task.id;
    selectedTaskIdRef.current = task.id;
    selectedConversationIdRef.current = null;
    router.replace(`/one?task=${encodeURIComponent(task.id)}`);
    await refreshAll();
    return task;
  }, [refreshAll, router]);

  const settleRun = useCallback(async (chatId: string, taskId: string | null) => {
    const api = ipc();
    if (!api) return;
    const promotedTask = taskId ? await api.tasks.get(taskId).catch(() => null) : await reconcileConversationTask(chatId);
    const pending = await api.confirm.listPending().catch(() => []);
    setConfirmations(pending);
    await refreshAll();
  }, [reconcileConversationTask, refreshAll]);

  const consumeRunEvent = useCallback((event: McpInvocationEvent) => {
    const chatId = runChatIdRef.current;
    const taskId = runTaskIdRef.current;
    if (!chatId) return;
    setRunProgress((current) => reduceOneRunProgress(current, event));
    if (event.agentId && event.phase !== "synthesize") {
      if (!taskId) void reconcileConversationTask(chatId);
      // One presents as a single chief-of-staff. Never leak the borrowed agent
      // name or its raw runtime status (CLI/session) onto the customer surface.
      if (event.status) setRunStatus(customerSafeProgressDetail(event.status));
      return;
    }
    if (event.kind === "thinking" || event.kind === "tool-use") {
      if (!taskId && event.kind === "tool-use") void reconcileConversationTask(chatId);
      if (event.status) setRunStatus(customerSafeProgressDetail(event.status));
      return;
    }
    if (event.kind === "partial") {
      if (typeof event.delta === "string") streamTextRef.current += event.delta;
      else streamTextRef.current = event.text ?? streamTextRef.current;
      setMessages((current) => upsertLiveMessage(current, streamTextRef.current, true));
      return;
    }
    if (event.kind === "surface") {
      if (event.oneSurface) setSurface(event.oneSurface);
      scrollToLatest();
      if (!taskId) void reconcileConversationTask(chatId);
      return;
    }
    if (event.kind === "final") {
      const text = event.text ?? streamTextRef.current;
      setMessages((current) => upsertLiveMessage(current, text, false));
      setBusy(false);
      setRunStatus("");
      runIdRef.current = null;
      streamTextRef.current = "";
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      scrollToLatest();
      void settleRun(chatId, taskId);
      return;
    }
    if (event.kind === "error") {
      const message = toCustomerSafeText(event.error?.message ?? "", appLocale)
        || tFor(appLocale, "one.shell.run.stopped_before_completion");
      setMessages((current) => [...current.filter((item) => item.id !== "one-live-response"), { id: uid(), role: "system", text: message }]);
      setBusy(false);
      setRunStatus("");
      setError(message);
      runIdRef.current = null;
      streamTextRef.current = "";
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      void settleRun(chatId, taskId);
    }
  }, [appLocale, reconcileConversationTask, scrollToLatest, settleRun]);

  const consumeRunEventRef = useRef(consumeRunEvent);
  useEffect(() => {
    consumeRunEventRef.current = consumeRunEvent;
  }, [consumeRunEvent]);

  const subscribeRun = useCallback((runId: string) => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events) return;
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = events.on(api.invoke.eventChannel(runId), (event) => consumeRunEventRef.current(event));
  }, []);

  useEffect(() => {
    let cancelled = false;
    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = null;
    runIdRef.current = null;
    streamTextRef.current = "";
    setBusy(false);
    setRunStatus("");
    setRunProgress(initialOneRunProgress());
    setSurface(null);
    setReceipt(selected?.latestReceipt ?? null);
    const activeThreadChatId = selected?.chatId ?? conversation?.id ?? null;
    if (!activeThreadChatId) {
      setMessages([]);
      setCommittedAnswers([]);
      return;
    }
    const api = ipc();
    if (!api) return;
    const chatId = activeThreadChatId;
    const taskId = selected?.taskId ?? null;
    runChatIdRef.current = chatId;
    runTaskIdRef.current = taskId;
    void Promise.all([
      api.invoke.history(chatId),
      api.invoke.attach(chatId).catch(() => null),
      api.confirm.committedAnswers(chatId).catch(() => []),
    ]).then(async ([history, attachment, answers]) => {
      const taskReceipt = taskId ? selected?.latestReceipt ?? null : null;
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
      const liveRunOwnsThread = Boolean(
        runIdRef.current && runChatIdRef.current === chatId,
      );
      if (!liveRunOwnsThread) setMessages(toUiMessages(history));
      setCommittedAnswers(answers);
      setReceipt(taskReceipt);
      setSurface(durableSurface?.manifest ?? null);
      void api.chats.markViewed(chatId).catch(() => undefined);
      if (attachment) {
        runIdRef.current = attachment.runId;
        setBusy(true);
        setRunStatus(tFor(appLocale, "one.shell.run.reconnected"));
        subscribeRun(attachment.runId);
        for (const event of attachment.events) consumeRunEventRef.current(event);
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
    };
  }, [conversation?.id, appLocale, selected?.chatId, selected?.latestReceipt, selected?.taskId, subscribeRun]);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelected(null);
      return;
    }
    const match = projections.find((item) => item.taskId === selectedTaskId);
    if (match) setSelected(match);
  }, [projections, selectedTaskId]);

  const activeThreadChatId = selected?.chatId ?? conversation?.id ?? null;
  const activeThreadPromptFallback = selected?.display.title ?? conversation?.title ?? "";
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
                }
              : null
        ));
        if (proposal && ["proposed", "blocked", "deferred", "team_reserved", "solo_reserved"].includes(proposal.status)) {
          const visiblePrompt = activeThreadPromptFallback || proposal.goalSummary;
          setMessages((current) => current.length > 0
            ? current
            : [{ id: `team-request:${proposal.proposalId}`, role: "user", text: visiblePrompt }]);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
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
      userAlreadyShown?: boolean;
      displayUserMessage?: boolean;
    },
  ) => {
    const api = ipc();
    const events = ipcEvents();
    const runLocale = detectOneTextLocale(text) ?? normalizedLocale;
    if (!api || !events) throw new Error(tFor(runLocale, "one.shell.run.desktop_unavailable"));
    const runId = options?.runId ?? uid();
    runIdRef.current = runId;
    runTaskIdRef.current = taskId;
    runChatIdRef.current = chatId;
    streamTextRef.current = "";
    setBusy(true);
    setSurface(null);
    setError(null);
    setRunStatus(taskIntent === "conversation"
      ? tFor(runLocale, "one.shell.run.preparing_response")
      : tFor(runLocale, "one.shell.run.preparing_team"));
    setRunProgress(initialOneRunProgress());
    setMessages((current) => {
      const withoutLive = current.filter((item) => item.id !== "one-live-response");
      const userAlreadyVisible = options?.userAlreadyShown
        && withoutLive.some((item) => item.role === "user" && item.text === text);
      return [
        ...withoutLive,
        ...(userAlreadyVisible || options?.displayUserMessage === false
          ? []
          : [{ id: uid(), role: "user" as const, text }]),
        { id: "one-live-response", role: "assistant" as const, text: "", streaming: true },
      ];
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
    const intentPermission = taskIntent === "conversation" ? "read" : "write";
    const executionPermission = intentPermission === "write" ? "full" : intentPermission;
    try {
      await api.invoke.run({
        runId,
        chatId,
        userPrompt: text,
        taskIntent,
        oneMode: true,
        ...(options?.teamRef ? { oneTeamPreflightRef: options.teamRef } : {}),
        ...(options?.attachments ? { oneAttachmentRef: options.attachments.ref } : {}),
        ...(options?.recurrence ? { oneRecurrenceSelection: options.recurrence } : {}),
        ...(attachedOneMemoryUseOnce ? {
          oneMemoryUseOnceRef: {
            contractVersion: attachedOneMemoryUseOnce.contractVersion,
            receiptId: attachedOneMemoryUseOnce.receiptId,
          },
        } : {}),
        locale: runLocale,
        permissions: executionPermission,
        sessionRouting: false,
      });
      if (options?.teamRef) {
        setTeamPreflight(await api.oneTeamPreflight.getForChat(chatId).catch(() => null));
        setPendingTeamPrompt(null);
      }
      await refreshAll();
    } catch (cause) {
      if (options?.teamRef) {
        const failed = await api.oneTeamPreflight.failStart(options.teamRef).catch(() => null);
        if (failed) setTeamPreflight(failed);
      }
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
      runIdRef.current = null;
      setBusy(false);
      setRunStatus("");
      const message = cause instanceof Error ? cause.message : String(cause);
      setMessages((current) => [...current.filter((item) => item.id !== "one-live-response"), { id: uid(), role: "system", text: message }]);
      setError(message);
      if (options?.attachments) {
        await api.oneAttachments.discard({ ref: options.attachments.ref }).catch(() => ({ discarded: false }));
      }
      await refreshAll();
    } finally {
      if (attachedOneMemoryUseOnce) {
        // One Main consumes on accepted start. A rejected start is also a
        // single attempt from this UI; it is never attached automatically again.
        setArmedOneMemoryUseOnce((current) => (
          current?.receipt.receiptId === attachedOneMemoryUseOnce.receiptId ? null : current
        ));
      }
    }
  }, [armedOneMemoryUseOnce, normalizedLocale, refreshAll, scrollToLatest, subscribeRun]);

  const autoStartTeamPreflight = useCallback(async (
    proposal: OneTeamPreflightProposal,
    prompt: PendingTeamPrompt,
    userAlreadyShown: boolean,
  ) => {
    const api = ipc();
    if (!api || autoResolvingProposalRef.current === proposal.proposalId || runIdRef.current) return;
    autoResolvingProposalRef.current = proposal.proposalId;
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
          userAlreadyShown,
          displayUserMessage: userAlreadyShown,
        },
      );
      setTeamPreflight(await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => result.proposal));
    } catch {
      const current = await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => null);
      if (current) setTeamPreflight(current);
      setError(tFor(detectOneTextLocale(prompt.text) === "ko" ? "ko" : "en", "one.shell.team.start_failed"));
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
    const prompt = pendingTeamPrompt;
    if (!api || !proposal || !prompt || runIdRef.current) return;
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
        // Main requires the explicit marker on a confirmed external run; without
        // it the confirmed binding is rejected as invalid.
        accepted && !/^\s*\/?workforce\b/i.test(prompt.text) ? `/workforce ${prompt.text}` : prompt.text,
        "task",
        {
          runId: result.ref.reservedRunId,
          teamRef: result.ref,
          attachments: prompt.attachments,
          recurrence: prompt.recurrence,
          userAlreadyShown: true,
          displayUserMessage: true,
        },
      );
      setTeamPreflight(await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => result.proposal));
    } catch {
      const current = await api.oneTeamPreflight.getForChat(proposal.binding.chatId).catch(() => null);
      if (current) setTeamPreflight(current);
      setError(tFor(detectOneTextLocale(prompt.text) === "ko" ? "ko" : "en", "one.shell.team.start_failed"));
    } finally {
      setTeamPreflightBusy(false);
    }
  }, [pendingTeamPrompt, router, startRun, teamPreflight]);

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
    } catch {
      const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null);
      if (!latest) return;
      current = latest;
      if (current.status === "active" && current.concern.status === "pending") {
        current = await api.oneActivation.resolveConcern({
          expectedStoreVersion: current.version,
          originChatId: chatId,
          confirmedByUser: true,
        }).catch(() => current);
      }
    }
    setOneActivationState(current);
  }, [appLocale, oneActivationState]);

  const submit = useCallback(async (text: string) => {
    const attachmentSnapshot = attachmentDraftsRef.current.slice();
    const recurrenceSnapshot = recurrenceSelection ? { ...recurrenceSelection } : null;
    const explicitValue = text.trim();
    if ((!explicitValue && attachmentSnapshot.length === 0) || busy || teamPreflightBusy) return;
    const value = explicitValue || tFor(appLocale, "one.shell.composer.attachment_prompt", { n: attachmentSnapshot.length, s: attachmentSnapshot.length === 1 ? "" : "s" });
    const api = ipc();
    if (!api) {
      setError(tFor(appLocale, "one.shell.composer.not_connected"));
      return;
    }
    const onboardingState = await api.oneOnboarding.getState().catch(() => null);
    const onboardingAuthorization = onboardingState?.status === "completed"
      ? await api.oneOnboarding.getExecutionAuthorization().catch(() => null)
      : null;
    if (onboardingState?.status === "completed" && !onboardingAuthorization?.allowed) {
      const teamChanged = onboardingAuthorization?.reason === "starter_team_changed";
      setError(teamChanged
        ? tFor(appLocale, "one.shell.submit.starter_team_changed")
        : tFor(appLocale, "one.shell.submit.ai_connection_unverified"));
      return;
    }
    const canContinueInPlace = Boolean(
      selected?.chatId && ["partial", "completed", "failed"].includes(selected.canonicalStatus ?? ""),
    );
    if (selected && (!selected.chatId || (!selected.truth.mayStartExecution && !canContinueInPlace))) {
      setError(tFor(appLocale, "one.shell.submit.cannot_continue"));
      return;
    }
    if (teamPreflight && ["proposed", "blocked", "team_reserved", "workforce_reserved", "solo_reserved", "deferred"].includes(teamPreflight.status)) return;
    const prepareOrRun = async (
      chatId: string,
      taskId: string | null,
      taskVersion: number | null,
      taskIntent: "task" | "conversation",
    ) => {
      setTeamPreflightBusy(true);
      setError(null);
      let preparedAttachments: PreparedOneAttachments | null = null;
      try {
        if (attachmentSnapshot.length > 0) {
          const attachments: OneAttachmentPrepareItem[] = attachmentSnapshot.map((item) => ({
            grant: item.grant,
            displayName: item.name,
            claimedMediaType: item.mediaType,
            claimedSize: item.size,
          }));
          preparedAttachments = await api.oneAttachments.prepare({ chatId, userPrompt: value, attachments });
        }
        const prepared = await api.oneTeamPreflight.prepare({
          chatId,
          userPrompt: value,
          expectedTaskId: taskId,
          expectedTaskVersion: taskVersion,
        });
        if (prepared.kind === "not_required") {
          const resolvedIntent = preparedAttachments
            ? "task"
            : taskIntent === "task" || classifyOneRequestIntent(value) === "task"
              ? "task"
              : "conversation";
          await startRun(
            chatId,
            taskId,
            taskVersion,
            value,
            resolvedIntent,
            { attachments: preparedAttachments, recurrence: recurrenceSnapshot },
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
          text: value,
          attachments: preparedAttachments,
          recurrence: recurrenceSnapshot,
        };
        setPendingTeamPrompt(pendingPrompt);
        setMessages((current) => [
          ...current.filter((item) => item.id !== "one-live-response"),
          { id: `team-request:${prepared.proposal.proposalId}`, role: "user", text: value },
        ]);
        scrollToLatest();
        await autoStartTeamPreflight(prepared.proposal, pendingPrompt, true);
      } catch (cause) {
        if (preparedAttachments) {
          await api.oneAttachments.discard({ ref: preparedAttachments.ref }).catch(() => ({ discarded: false }));
        }
        throw cause;
      } finally {
        setTeamPreflightBusy(false);
      }
    };
    setComposer("");
    clearAttachmentDrafts();
    // Keep the user's request visibly in motion while a brand-new chat is
    // promoted to its canonical Task and One decides whether help is needed.
    setTeamPreflightBusy(true);
    try {
      if (selected?.chatId) {
        // A result is one turn in this conversation, not a reason to fork a new
        // chat. Reusing the same chatId also reuses the provider CLI session.
        await prepareOrRun(selected.chatId, selected.taskId, selected.canonicalVersion, "task");
        return;
      }
      if (conversation) {
        await resolveActivationConcern(conversation.id);
        await prepareOrRun(conversation.id, null, null, "conversation");
        return;
      }
      const starterGroupId = onboardingAuthorization?.allowed ? onboardingAuthorization.groupId : null;
      const chat = await api.chats.create({
        title: value.split(/\r?\n/)[0].slice(0, 72),
        taskMode: "conversation",
        originSurface: "one",
        ...(starterGroupId ? { agentGroupId: starterGroupId } : {}),
      });
      setConversation(chat);
      selectedConversationIdRef.current = chat.id;
      router.replace(`/one?chat=${encodeURIComponent(chat.id)}`);
      await resolveActivationConcern(chat.id);
      await prepareOrRun(chat.id, null, null, "conversation");
    } catch (cause) {
      setTeamPreflightBusy(false);
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    }
  }, [autoStartTeamPreflight, busy, clearAttachmentDrafts, conversation, appLocale, recurrenceSelection, resolveActivationConcern, router, scrollToLatest, selected, startRun, teamPreflight, teamPreflightBusy]);

  const stopRun = useCallback(() => {
    const api = ipc();
    const runId = runIdRef.current;
    if (!api || !runId) return;
    setRunStatus(tFor(appLocale, "one.shell.run.stopping_safely"));
    void api.invoke.cancel(runId);
  }, [appLocale]);

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
      appLocale === "ko"
        ? "직전 실행에서 끝까지 확인되지 않은 단계를 이어서 완료하고, 완성된 결과만 보여줘."
        : "Continue the previous run: finish the step that was not completed, and show only the finished result.",
      selected ? "task" : "conversation",
      { displayUserMessage: false },
    );
  }, [appLocale, busy, conversation?.id, selected, startRun]);

  const answerConfirmation = useCallback(async (confirmation: PendingConfirmation, label: string) => {
    const api = ipc();
    const task = projections.find((item) => item.chatId === confirmation.chatId);
    if (!api || !task || busy || !task.truth.mayStartExecution) return;
    try {
      await api.confirm.commitAnswer({ chatId: confirmation.chatId, reply: label });
      setCommittedAnswers(await api.confirm.committedAnswers(confirmation.chatId).catch(() => []));
      setConfirmations((items) => items.filter((item) => item.sourceMessageId !== confirmation.sourceMessageId));
      await startRun(confirmation.chatId, task.taskId, task.canonicalVersion, label, "task");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [busy, projections, startRun]);

  const snoozeConfirmation = useCallback(async (confirmation: PendingConfirmation) => {
    const api = ipc();
    if (!api) return;
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
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const openTask = useCallback((taskId: string) => {
    setRailOpen(false);
    setSearchOpen(false);
    router.push(`/one?task=${encodeURIComponent(taskId)}`);
  }, [router]);

  const openConversation = useCallback((chatId: string) => {
    setRailOpen(false);
    setSearchOpen(false);
    router.push(`/one?chat=${encodeURIComponent(chatId)}`);
  }, [router]);

  const mutateTaskArchive = useCallback(async (taskId: string, operation: "archive" | "restore") => {
    const api = ipc();
    if (!api?.oneSearch || archiveMutationTaskId) return;
    setArchiveMutationTaskId(taskId);
    setSearchError(null);
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
      const message = cause instanceof Error ? cause.message : String(cause);
      if (searchOpen) setSearchError(message);
      else setError(message);
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
  const actionableConfirmations = useMemo(
    () => confirmations.filter((item) => !isPendingConfirmationSnoozed(item)),
    [confirmations],
  );
  const reactiveBriefing = useMemo(() => chooseOneBriefing(projections, actionableConfirmations, appLocale), [actionableConfirmations, appLocale, projections]);
  const rawBriefing: DisplayBriefing = useMemo(() => {
    // A live decision awaiting the user keeps priority. Otherwise a grounded
    // proactive finding is the first thing One says, even before any Task exists.
    if (reactiveBriefing.kind === "decision") return reactiveBriefing;
    return briefingSnapshot?.candidate
      ? proactiveBriefingView(briefingSnapshot.candidate, appLocale)
      : reactiveBriefing;
  }, [appLocale, briefingSnapshot?.candidate, reactiveBriefing]);
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
  const selectedPendingConfirmation = selected?.chatId ? confirmations.find((item) => item.chatId === selected.chatId) ?? null : null;
  const selectedConfirmation = selected?.chatId ? actionableConfirmations.find((item) => item.chatId === selected.chatId) ?? null : null;
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
  const latestCommittedAnswer = selected?.chatId && !selectedPendingConfirmation
    ? committedAnswers.at(-1) ?? null
    : null;
  const executionAvailable = Boolean(ipc());
  const connectedMobile = mobileStatus?.running && mobileStatus.devices.some((device) => !device.revokedAt);
  const connectionLabel = !executionAvailable
    ? tFor(appLocale, "one.shell.conn.disconnected")
    : connectedMobile
      ? tFor(appLocale, "one.shell.conn.mobile_connected")
      : tFor(appLocale, "one.shell.conn.desktop_ready");
  const activationForeground = Boolean(
    oneActivationState
    && oneActivationState.eligibility === "eligible_first_use"
    && (oneActivationState.status === "active"
      || (oneActivationState.status === "completed" && oneActivationState.mobileConnection.status === "offered")),
  );
  const activationBlocksIntro = activationForeground || Boolean(
    oneActivationState?.eligibility === "eligible_first_use"
    && oneIntroState?.currentIntroVersion === 1,
  );
  const showWeeklyReflection = shouldPresentOneWeeklyReflection({
    onHome: !selected && !conversation,
    hasOpenReflection: oneWeeklyReflection?.reflection?.status === "open",
    activationForeground,
    busy,
    briefingKind: briefing.kind,
    hasProactiveBriefing: Boolean(briefing.proactive),
  });
  const activationBlocked = Boolean(
    busy
    || error
    || actionableConfirmations.length > 0
    || activeChatIds.length > 0
    || selected?.status.value === "decision_required"
    || selected?.status.value === "failed"
    || selected?.status.value === "working",
  );
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
  const introEligible = loaded && oneIntroPending && introBlockingCategory === null && !oneOnboardingVisible;
  const workHref = selected?.chatId
    ? `/chat?id=${encodeURIComponent(selected.chatId)}&task=${encodeURIComponent(selected.taskId)}`
    : "/dashboard";
  const openWork = useCallback(async () => {
    const api = ipc();
    // Ask Main which conversation this Task really lives in. The href below is
    // assembled from a projection that can lag behind the store, so the verified
    // target wins whenever Main can produce one.
    if (api && selected) {
      const target = await resolveOneTaskWorkTarget(api, selected.taskId);
      if (target) {
        router.push(`/chat?id=${encodeURIComponent(target.chatId)}&task=${encodeURIComponent(target.taskId)}`);
        return;
      }
    }
    router.push(workHref);
  }, [router, selected, workHref]);
  const openActivationWork = useCallback(async () => {
    const api = ipc();
    let current = oneActivationState;
    if (api?.oneActivation && current?.status === "active") {
      try {
        current = await api.oneActivation.resolveWork({
          expectedStoreVersion: current.version,
          confirmedByUser: true,
        });
      } catch {
        const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null);
        if (latest?.status === "active" && latest.workNavigation.status === "pending") {
          current = await api.oneActivation.resolveWork({
            expectedStoreVersion: latest.version,
            confirmedByUser: true,
          }).catch(() => latest);
        } else if (latest) {
          current = latest;
        }
      }
      if (current) setOneActivationState(current);
    }
    await openWork();
  }, [appLocale, oneActivationState, openWork]);
  const skipActivation = useCallback(async () => {
    const api = ipc();
    let current = oneActivationState;
    if (!api?.oneActivation || !current || current.status !== "active") return;
    try {
      current = await api.oneActivation.skip({
        expectedStoreVersion: current.version,
        confirmedByUser: true,
      });
    } catch {
      const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale });
      current = latest.status === "active"
        ? await api.oneActivation.skip({ expectedStoreVersion: latest.version, confirmedByUser: true })
        : latest;
    }
    setOneActivationState(current);
  }, [appLocale, oneActivationState]);
  const resolveActivationMobile = useCallback(async (resolution: OneActivationMobileResolution) => {
    const api = ipc();
    let current = oneActivationState;
    if (!api?.oneActivation || !current || current.mobileConnection.status !== "offered") return;
    try {
      current = await api.oneActivation.resolveMobile({
        expectedStoreVersion: current.version,
        resolution,
        confirmedByUser: true,
      });
    } catch {
      const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale });
      current = latest.mobileConnection.status === "offered"
        ? await api.oneActivation.resolveMobile({ expectedStoreVersion: latest.version, resolution, confirmedByUser: true })
        : latest;
    }
    setOneActivationState(current);
    if (resolution === "opened_settings") router.push("/settings");
  }, [appLocale, oneActivationState, router]);
  const acceptResult = useCallback(async () => {
    const api = ipc();
    if (!api || !selected || !receipt || receipt.status !== "completed" || selected.canonicalStatus !== "partial" || acceptingResult) return;
    setAcceptingResult(true);
    setError(null);
    try {
      await api.tasks.acceptResult({
        taskId: selected.taskId,
        expectedVersion: selected.canonicalVersion,
        expectedRunId: receipt.runId,
      });
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAcceptingResult(false);
    }
  }, [acceptingResult, receipt, refreshAll, selected]);
  const selectedCanContinueInPlace = Boolean(
    selected?.chatId && ["partial", "completed", "failed"].includes(selected.canonicalStatus ?? ""),
  );
  const selectedReadOnly = Boolean(
    selected && (!selected.chatId || (!selected.truth.mayStartExecution && !selectedCanContinueInPlace)),
  );
  const teamDecisionPending = Boolean(
    teamPreflight
    && ["proposed", "blocked", "team_reserved", "workforce_reserved", "solo_reserved", "deferred"].includes(teamPreflight.status),
  );
  const oneDisplayName = oneProfile?.displayName.trim() || "One";
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
      const kind = attachmentKind(file);
      const perFileLimit = kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes;
      if (file.size > perFileLimit) {
        errors.push(tFor(appLocale, "one.shell.attach.file_limit", { name: file.name, limit: kind === "image" ? tFor(appLocale, "one.shell.attach.limit_image") : tFor(appLocale, "one.shell.attach.limit_file") }));
        continue;
      }
      if (totalBytes + file.size > ONE_ATTACHMENT_LIMITS.maxTotalBytes) {
        errors.push(tFor(appLocale, "one.shell.attach.total_limit", { name: file.name }));
        continue;
      }
      const grant = await grantForDroppedFile(file);
      if (!grant || grant.kind !== "file") {
        errors.push(tFor(appLocale, "one.shell.attach.not_regular_file", { name: file.name }));
        continue;
      }
      const previewUrl = kind === "image" ? URL.createObjectURL(file) : null;
      next.push({
        id: uid(),
        grant,
        name: file.name,
        mediaType: file.type,
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
    } catch {
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
    }
  }, [oneIntroState]);
  const manageImprovementAsset = useCallback((asset: OneImprovementReusedAssetV1) => {
    if (asset.assetType === "memory") {
      setProfileOpen(false);
      setMemoryOpen(true);
      return;
    }
    if (asset.assetType === "automation") {
      router.push("/automation");
      return;
    }
    if (asset.assetType === "team") {
      router.push(`/library/agent-groups?edit=${encodeURIComponent(asset.assetRef)}`);
      return;
    }
    if (asset.assetType === "agent") {
      router.push("/library/agents");
      return;
    }
    void openWork();
  }, [openWork, router]);
  // ── E1 use-case 칩 ────────────────────────────────────────────────
  // 같은 렌더러 창에서 진행 중이던 빌드(인터뷰 대기·승인 대기·실행 중·오류)는
  // "이어하기" 로테이션 칩의 로컬 신호가 된다. Main 신호(oneHomeSignals)와 함께
  // OneUseCaseChips가 결정적으로 슬롯을 고른다.
  const buildSessionSnapshot = useSyncExternalStore(
    buildSessionSubscribe,
    getBuildSessionSnapshot,
    getBuildSessionSnapshot,
  );
  const hasUnfinishedBuild = ["running", "interview", "mcp-review", "runtime-approval", "error"]
    .includes(buildSessionSnapshot.phase);
  // 칩은 새 대화가 시작되기 전(홈)에서만 살고, 첫 입력과 동시에 사라진다.
  const useCaseChipsVisible = composer.trim().length === 0 && !busy && !teamPreflightBusy;
  const activateUseCaseChip = useCallback((action: OneUseCaseChipAction) => {
    if (action.id === "automation" || action.id === "try_automation") {
      // E3: 딥링크 폴백이 아니라 One 안에서 직접 생성한다.
      setAutomationSheetOpen(true);
      return;
    }
    if (action.id === "fix_automation" && action.targetId) {
      router.push(`/automation/detail?id=${encodeURIComponent(action.targetId)}`);
      return;
    }
    if (action.id === "library" || action.id === "try_library") {
      router.push("/library/agents");
      return;
    }
    if (action.id === "experience" || action.id === "try_experience") {
      router.push("/library/agents?tab=ontology");
      return;
    }
    // build · resume_build · try_build — 빌드 표면으로 직행(세션이 있으면 그대로 이어짐).
    router.push("/build");
  }, [router]);
  const closeAutomationSheet = useCallback(() => setAutomationSheetOpen(false), []);
  const openCreatedAutomation = useCallback((automationId: string) => {
    setAutomationSheetOpen(false);
    router.push(`/automation/detail?id=${encodeURIComponent(automationId)}`);
  }, [router]);
  const openPreparedFinding = useCallback((candidate: OneProactiveBriefing) => {
    if (candidate.preparedAction.kind === "open_project") {
      router.push(`/project/detail?id=${encodeURIComponent(candidate.preparedAction.targetId)}`);
      return;
    }
    if (candidate.preparedAction.kind === "open_task") return;
    router.push(`/automation/detail?id=${encodeURIComponent(candidate.preparedAction.targetId)}`);
  }, [router]);
  const openProactiveTask = useCallback(async (candidate: OneProactiveBriefing) => {
    const api = ipc();
    if (!api || candidate.source.kind !== "canonical_task" || candidate.preparedAction.kind !== "open_task") return;
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
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [openTask, refreshAll]);
  const applyProactiveFeedback = useCallback(async (candidate: OneProactiveBriefing, feedback: "later" | "not_important" | "wrong") => {
    const api = ipc();
    if (!api) return;
    setError(null);
    try {
      const next = await api.oneBriefing.feedback({
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
        feedback,
      });
      setBriefingSnapshot(safeBriefingSnapshot(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    return <div className={styles.shell}><div className={styles.loading} role="status">{tFor(appLocale, "one.shell.loading")}</div></div>;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.body} data-rail-collapsed={railCollapsed ? "true" : "false"}>
        {railOpen && <button type="button" className={styles.railScrim} aria-label={tFor(appLocale, "one.shell.rail.close_history_aria")} onClick={() => setRailOpen(false)} />}
        <aside className={styles.rail} data-open={railOpen ? "true" : "false"} aria-label={tFor(appLocale, "one.shell.rail.aria")}>
          <div className={`${styles.railProduct} titlebar-nodrag`}>
            <ProductModeMenu current="one" darkText locale={appLocale} />
            <button
              type="button"
              className={styles.railCollapseButton}
              aria-label={tFor(appLocale, "one.shell.rail.collapse_aria")}
              onClick={() => { setRailCollapsed(true); setRailOpen(false); }}
            >‹</button>
          </div>
          <div className={styles.railPrimaryActions}>
            <button type="button" className={styles.railPrimaryButton} onClick={() => router.push("/one")}><span aria-hidden="true">＋</span>{tFor(appLocale, "one.shell.rail.new_conversation")}</button>
            <button ref={searchTriggerRef} type="button" className={styles.railPrimaryButton} onClick={() => setSearchOpen(true)}><span aria-hidden="true">⌕</span>{tFor(appLocale, "one.shell.rail.search_all")}</button>
            <button type="button" className={styles.railPrimaryButton} onClick={() => router.push("/one")}>
              <span aria-hidden="true">◉</span>{tFor(appLocale, "one.shell.rail.now")}
              {actionableConfirmations.length > 0 && <span className={styles.railCount}>{actionableConfirmations.length}</span>}
            </button>
          </div>
          <div className={styles.railTop}><strong>{tFor(appLocale, "one.shell.rail.recent")}</strong></div>
          <div className={styles.railList}>
            {conversations.length > 0 && <p className={styles.railSectionLabel}>{tFor(appLocale, "one.shell.rail.section_conversations")}</p>}
            {conversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} />)}
            {projections.length > 0 && <p className={styles.railSectionLabel}>{tFor(appLocale, "one.shell.rail.section_work")}</p>}
            {projections.map((item) => <TaskListButton key={item.taskId} item={item} active={item.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />)}
            {projections.length === 0 && conversations.length === 0 && <div className={styles.railEmpty}>{tFor(appLocale, "one.shell.rail.empty")}</div>}
          </div>
          <div className={styles.railFooter}>
            {selected && <nav className={`${styles.railUtilities} ${styles.railTaskActions}`} aria-label={tFor(appLocale, "one.shell.rail.manage_task_aria")}>
              <button type="button" onClick={() => void openWork()}>{tFor(appLocale, "one.shell.rail.open_in_work")}<span aria-hidden="true">↗</span></button>
              <button
                type="button"
                disabled={archiveMutationTaskId === selected.taskId || Boolean(selected.chatId && activeChatIds.includes(selected.chatId))}
                onClick={() => void mutateTaskArchive(selected.taskId, selected.canonicalStatus === "archived" ? "restore" : "archive")}
              >
                {archiveMutationTaskId === selected.taskId
                  ? tFor(appLocale, "one.shell.rail.archive_checking")
                  : selected.canonicalStatus === "archived"
                    ? tFor(appLocale, "one.shell.rail.restore_from_archive")
                    : tFor(appLocale, "one.shell.rail.archive_this_work")}
              </button>
            </nav>}
            <nav className={styles.railUtilities} aria-label={tFor(appLocale, "one.shell.rail.settings_aria")}>
              <button type="button" onClick={() => { setMemoryOpen(false); setProfileOpen(true); }}>{oneDisplayName}</button>
              <button type="button" onClick={() => { setProfileOpen(false); setMemoryOpen(true); }}>
                {tFor(appLocale, "one.shell.rail.memory")}
                {oneMemory && oneMemory.candidates.some((candidate) => candidate.status === "pending") && <span className={styles.railCount}>{oneMemory.candidates.filter((candidate) => candidate.status === "pending").length}</span>}
              </button>
              <button type="button" onClick={() => setPref(appLocale === "ko" ? "en" : "ko")}>
                <span>{tFor(appLocale, "one.shell.rail.language")}</span>
                <span>{tFor(appLocale, "one.shell.rail.language_switch")}</span>
              </button>
              <button type="button" disabled={activationForeground} onClick={() => setIntroReplayToken((value) => value + 1)}>{tFor(appLocale, "one.shell.rail.about_one")}</button>
              <button type="button" onClick={() => void openWork()}>{tFor(appLocale, "one.shell.rail.open_work")}<span aria-hidden="true">↗</span></button>
            </nav>
            <span className={styles.connection} data-offline={!executionAvailable ? "true" : "false"} role="status">
              <span className={styles.connectionDot} aria-hidden="true" /><span>{connectionLabel}</span>
            </span>
          </div>
        </aside>

        <main className={styles.workspace}>
          <div className={`${styles.windowBar} titlebar-drag`}>
            <button
              type="button"
              className={`${styles.sidebarRevealButton} titlebar-nodrag`}
              aria-label={tFor(appLocale, "one.shell.workspace.open_sidebar_aria")}
              onClick={() => { setRailCollapsed(false); setRailOpen(true); }}
            >☰</button>
          </div>
          {error && <div className={styles.errorBanner} role="alert">{error}</div>}
          <div ref={scrollRef} className={styles.scroll}>
            <OneActivation
              state={oneActivationState}
              locale={appLocale}
              blocked={activationBlocked}
              onSkip={skipActivation}
              onOpenWork={openActivationWork}
              onResolveMobile={resolveActivationMobile}
            />
            {!selected && !conversation ? (
              <div className={styles.homeContent}>
                {projections.length === 0 && !briefing.proactive ? (
                  activationForeground ? null : <section className={styles.newUser} aria-labelledby="one-first-run-title">
                    <OneBrandLockup className={styles.newUserMark} />
                    <h1 id="one-first-run-title"><OneFirstRunTitle locale={appLocale} /></h1>
                    {useCaseChipsVisible && (
                      <OneUseCaseChips
                        locale={appLocale}
                        hasUnfinishedBuild={hasUnfinishedBuild}
                        signals={oneHomeSignals}
                        onActivate={activateUseCaseChip}
                      />
                    )}
                  </section>
                ) : (
                  <section className={styles.briefing} aria-labelledby="one-briefing-title">
                    <div className={styles.briefingOne}><OneBrandMark size="small" /><span>{oneDisplayName}</span></div>
                    <p className={styles.briefingEyebrow}>{briefing.eyebrow}</p>
                    <h1 id="one-briefing-title">{briefing.title}</h1>
                    <p className={styles.briefingBody}>{briefing.body}</p>
                    <div className={styles.briefingActions}>
                      {briefing.proactive
                        ? briefing.proactive.preparedAction.kind === "open_task"
                          ? <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void openProactiveTask(briefing.proactive!)}>{briefingActionBusy ? tFor(appLocale, "one.shell.common.checking") : briefing.primaryLabel}</button>
                          : <button type="button" className={styles.primaryButton} onClick={() => openPreparedFinding(briefing.proactive!)}>{briefing.primaryLabel}</button>
                        : briefing.taskId && <button type="button" className={styles.primaryButton} onClick={() => openTask(briefing.taskId!)}>{briefing.primaryLabel}</button>}
                      {briefing.kind !== "quiet" && (briefing.proactive
                        ? <button type="button" className={styles.ghostButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "later")}>{tFor(appLocale, "one.shell.common.later")}</button>
                        : <button type="button" className={styles.ghostButton} onClick={() => { const signature = briefingSignature(briefing); setDismissedBriefing({ signature, expiresAt: writeBriefingDismissal(signature) }); }}>{tFor(appLocale, "one.shell.common.later")}</button>)}
                    </div>
                    {useCaseChipsVisible && (
                      <OneUseCaseChips
                        locale={appLocale}
                        hasUnfinishedBuild={hasUnfinishedBuild}
                        signals={oneHomeSignals}
                        compact
                        onActivate={activateUseCaseChip}
                      />
                    )}
                  </section>
                )}
                {/* 에이전트 성장 제안 — "배운 걸 반영할까요?" 홈 슬롯(고위험 1건). */}
                <OneGrowthCard locale={appLocale} />
                {showWeeklyReflection && oneWeeklyReflection && (
                  <OneWeeklyReflectionCard
                    snapshot={oneWeeklyReflection}
                    locale={appLocale}
                    onChange={setOneWeeklyReflection}
                  />
                )}
              </div>
            ) : (
              <div className={styles.threadContent}>
                {selected?.chat?.hiredAgents?.length ? (
                  <aside className={styles.prepared} aria-label={tFor(appLocale, "one.shell.thread.experts_aria")}>
                    <span>{tFor(appLocale, "one.shell.thread.team_for_work")}</span>
                    {selected.chat.hiredAgents.map((item) => <strong key={item.slug}>{item.name || item.slug}</strong>)}
                  </aside>
                ) : null}
                <section className={styles.messages} aria-label={selected ? tFor(appLocale, "one.shell.thread.work_conversation_aria") : tFor(appLocale, "one.shell.thread.general_conversation_aria")} aria-live="polite">
                  {messages.map((message) => {
                    // Once a structured result exists, it replaces the final
                    // long Markdown answer instead of repeating the same work
                    // twice. Earlier conversation turns remain visible.
                    if (message.id === structuredResultMessageId) return null;
                    const visibleText = visibleOneMessageText(message);
                    if (!visibleText) return null;
                    return (
                      <article
                        key={message.id}
                        className={styles.message}
                        data-role={message.role}
                        data-kind={isResultContinuationMessage(message) ? "continuity" : undefined}
                      >
                        {message.role === "assistant" && <div className={styles.assistantIdentity}><OneBrandMark size="small" /><span>One</span></div>}
                        <div className={styles.messageBody}>
                          {message.streaming ? <StreamingMarkdown text={visibleText} messageId={message.id} /> : <Markdown text={visibleText} messageId={message.id} />}
                        </div>
                      </article>
                    );
                  })}
                  {teamPreflightBusy && !busy && (
                    <div className={styles.preparingRequest} role="status">
                      <OneBrandMark size="thinking" thinking />
                      <strong>{tFor(appLocale, "one.shell.thread.deciding")}</strong>
                      <span>{tFor(appLocale, "one.shell.thread.deciding_body")}</span>
                    </div>
                  )}
                  {messages.length === 0 && !teamPreflightBusy && !teamPreflight && <div className={styles.emptyThread}>{selected ? tFor(appLocale, "one.shell.thread.empty_work") : tFor(appLocale, "one.shell.thread.empty_conversation")}</div>}
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
                {teamPreflight && ["workforce_reserved", "recovery_required"].includes(teamPreflight.status) && !teamPreflightBusy && !busy && !awaitingWorkforceConsent && (
                  <p className={styles.teamPreflightRecovery} role="status">
                    {tFor(appLocale, "one.shell.thread.recovery")}
                  </p>
                )}
                {busy && (
                  <section className={styles.runProgress} role="status" aria-live="polite" aria-label={tFor(appLocale, "one.shell.thread.progress_aria")}>
                    <OneBrandMark size="thinking" thinking />
                    <strong>{oneRunStageLabel(runProgress.current, appLocale)}</strong>
                    <small>
                      {runProgress.participantNames.length > 0
                        ? tFor(appLocale, "one.shell.thread.coordinating", { count: String(runProgress.participantNames.length) })
                        : tFor(appLocale, "one.shell.thread.working_directly")}
                    </small>
                    {runStatus && <span className={styles.runStatusDetail}>{runStatus}</span>}
                    {runStartedAt !== null && (
                      <span className={styles.runElapsed}>{formatRunElapsed(Date.now() - runStartedAt)}</span>
                    )}
                  </section>
                )}
                {selected && selectedConfirmation && (
                  <DecisionCard
                    confirmation={selectedConfirmation}
                    taskId={selected.taskId}
                    locale={appLocale}
                    disabled={busy || selectedReadOnly}
                    onAnswer={answerConfirmation}
                    onOpenWork={() => void openWork()}
                    onSnooze={snoozeConfirmation}
                  />
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
                      onOpenWork={() => void openWork()}
                      onRetryUnfinished={retryUnfinished}
                      onAcceptResult={() => void acceptResult()}
                      acceptingResult={acceptingResult}
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
            {armedOneMemoryUseOnce && (
              <div className={styles.oneMemoryUseOnceChip} role="status">
                <span>{tFor(appLocale, "one.shell.composer.memory_once")}</span>
                <small>{tFor(appLocale, "one.shell.composer.memory_expires", { time: formatTimestamp(armedOneMemoryUseOnce.receipt.expiresAt, appLocale) })}</small>
                <button
                  type="button"
                  onClick={() => setArmedOneMemoryUseOnce(null)}
                  aria-label={tFor(appLocale, "one.shell.composer.memory_exclude_aria")}
                >×</button>
              </div>
            )}
            {attachmentDrafts.length > 0 && (
              <div className={styles.attachmentTray} aria-label={tFor(appLocale, "one.shell.composer.selected_attachments_aria")}>
                {attachmentDrafts.map((item) => (
                  <div key={item.id} className={styles.attachmentChip} data-kind={item.kind}>
                    {item.previewUrl
                      ? <img src={item.previewUrl} alt="" aria-hidden="true" />
                      : <span className={styles.attachmentFileIcon} aria-hidden="true">▤</span>}
                    <span className={styles.attachmentCopy}>
                      <strong>{item.name}</strong>
                      <small>{attachmentTypeLabel(item.mediaType, item.name)} · {attachmentSize(item.size)}</small>
                    </span>
                    <button type="button" onClick={() => removeAttachmentDraft(item.id)} aria-label={tFor(appLocale, "one.shell.composer.remove_attachment", { name: item.name })}>×</button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError && <p className={styles.attachmentError} role="alert">{attachmentError}</p>}
            {(recurrencePanelOpen || recurrenceSelection) && <OneRecurrenceControl
              locale={appLocale}
              disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
              value={recurrenceSelection}
              onChange={(value) => {
                setRecurrenceSelection(value);
                if (value === null) setRecurrencePanelOpen(false);
              }}
            />}
            <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (busy) stopRun(); else void submit(composer); }}>
              <input
                ref={attachmentInputRef}
                className={styles.attachmentInput}
                type="file"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => { if (event.target.files?.length) void addAttachmentFiles(event.target.files); }}
              />
              <textarea
                ref={composerInputRef}
                rows={1}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => handleComposerKey(event, busy ? stopRun : () => void submit(composer))}
                placeholder={oneActivationState?.status === "active" && oneActivationState.concern.status === "pending"
                  ? tFor(appLocale, "one.shell.composer.placeholder_activation")
                  : selected
                  ? tFor(appLocale, "one.shell.composer.placeholder_selected")
                  : conversation
                    ? tFor(appLocale, "one.shell.composer.placeholder_conversation")
                    : tFor(appLocale, "one.shell.composer.placeholder_default")}
                aria-label={tFor(appLocale, "one.shell.composer.request_aria")}
                disabled={selectedReadOnly || teamDecisionPending || teamPreflightBusy}
              />
              <div className={styles.composerBar}>
                <div className={styles.composerTools}>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                    onClick={() => attachmentInputRef.current?.click()}
                    aria-label={tFor(appLocale, "one.shell.composer.attach_aria")}
                    title={tFor(appLocale, "one.shell.composer.attach_title")}
                  >
                    <IconPlus size={20} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                    aria-expanded={recurrencePanelOpen || recurrenceSelection !== null}
                    aria-label={tFor(appLocale, "one.shell.composer.repeat_aria")}
                    title={tFor(appLocale, "one.shell.composer.repeat_title")}
                    onClick={() => setRecurrencePanelOpen((open) => !open)}
                  >
                    <IconRefresh size={17} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.composerActions}>
                  <OneVoiceInputHelp
                    locale={appLocale}
                    composerRef={composerInputRef}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                  />
                  <button type="submit" className={styles.sendButton} disabled={!busy && ((!composer.trim() && attachmentDrafts.length === 0) || selectedReadOnly || teamDecisionPending || teamPreflightBusy)} aria-label={busy ? tFor(appLocale, "one.shell.composer.stop_run_aria") : tFor(appLocale, "one.shell.composer.send_aria")}>
                    {busy ? <span className={styles.stopGlyph} aria-hidden="true" /> : <IconArrowUp size={20} strokeWidth={2} aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </form>
            {selectedReadOnly && (
              <p className={styles.composerNote}>{tFor(appLocale, "one.shell.composer.view_only")}</p>
            )}
          </div>

          {searchOpen && (
            <section ref={searchSheetRef} className={styles.searchSheet} role="dialog" aria-modal="true" aria-label={tFor(appLocale, "one.shell.search.dialog_aria")} onKeyDown={trapSearchFocus}>
              <div className={styles.searchHeader}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tFor(appLocale, "one.shell.search.placeholder")} /><button type="button" className={styles.iconButton} aria-label={tFor(appLocale, "one.shell.search.close_aria")} onClick={() => setSearchOpen(false)}>×</button></div>
              <div className={styles.searchScope}>
                <span>{tFor(appLocale, "one.shell.search.scope")}</span>
                <label><input type="checkbox" checked={searchIncludeArchived} onChange={(event) => setSearchIncludeArchived(event.target.checked)} />{tFor(appLocale, "one.shell.search.include_archived")}</label>
              </div>
              <div className={styles.searchResults} aria-live="polite" aria-busy={searchLoading || searchLoadingMore}>
                {!query.trim() && (
                  <>
                    {filteredConversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} />)}
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
                {query.trim() && searchLoading && searchHits.length === 0 && <div className={styles.searchState} role="status">{tFor(appLocale, "one.shell.search.searching")}</div>}
                {query.trim() && !searchLoading && !searchError && searchHits.length === 0 && <div className={styles.searchState}>{tFor(appLocale, "one.shell.search.no_match")}</div>}
                {searchError && <div className={styles.searchError} role="alert">{searchError}</div>}
                {query.trim() && searchNextCursor && !searchError && (
                  <button type="button" className={styles.searchMore} disabled={searchLoadingMore} onClick={loadMoreSearchResults}>
                    {searchLoadingMore ? tFor(appLocale, "one.shell.search.finding_more") : tFor(appLocale, "one.shell.search.show_older")}
                  </button>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

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
      <OneAutomationSheet
        open={automationSheetOpen}
        locale={appLocale}
        onClose={closeAutomationSheet}
        onOpenAutomation={openCreatedAutomation}
      />
      <OneOnboarding
        locale={appLocale}
        onVisibilityChange={setOneOnboardingVisible}
        onComplete={(projectSeed) => {
          setComposer(projectSeed);
          window.setTimeout(() => composerInputRef.current?.focus(), 0);
        }}
      />
      <OneFeatureIntro
        eligible={introEligible}
        needsAcknowledgement={oneIntroPending}
        locale={appLocale}
        replayToken={activationForeground ? 0 : introReplayToken}
        onResolve={acknowledgeOneIntro}
        onOpenOne={() => router.push("/one")}
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
      <strong>{item.display.title}</strong>
      <small>{statusLabel(item.status.value, locale, item.canonicalStatus)} · {formatTimestamp(item.status.asOf, locale)}</small>
      <span className={styles.statusDot} data-status={item.status.value} aria-hidden="true" />
    </button>
  );
}

function ConversationListButton({ item, active, locale, onOpen }: { item: Chat; active: boolean; locale: "ko" | "en"; onOpen: (chatId: string) => void }) {
  return (
    <button type="button" className={styles.taskButton} data-active={active ? "true" : "false"} onClick={() => onOpen(item.id)} aria-current={active ? "page" : undefined}>
      <strong>{item.title}</strong>
      <small>{tFor(locale, "one.shell.convlist.conversation")} · {formatTimestamp(item.updatedAt, locale)}</small>
      <span className={styles.conversationDot} aria-hidden="true" />
    </button>
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

/** Wall-clock duration of the current run, in the same shape Work/Build use. */
function formatRunElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `0:${String(seconds).padStart(2, "0")}`;
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

function DecisionCard({ confirmation, taskId, locale, disabled, onAnswer, onOpenWork, onSnooze }: {
  confirmation: PendingConfirmation;
  taskId: string;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (confirmation: PendingConfirmation, label: string) => void;
  onOpenWork: () => void;
  onSnooze: (confirmation: PendingConfirmation) => void;
}) {
  // The render pass has no synchronous model: warm the judge via the bridge and
  // pass its verdicts. Until/unless a model verdict lands, normalizeOneDecision
  // FAILS CLOSED (highest risk, approval required) — it never keyword-decides.
  const { readers: judgedReaders, modelUnavailable } = useJudgedOneDecision(confirmation);
  const decision: OneDecisionViewV1 = normalizeOneDecision(confirmation, taskId, judgedReaders);
  const riskRank = Number(decision.risk.level.slice(1));
  const approvalBlocked = riskRank >= 2 && decision.risk.certainty === "ambiguous";
  const directOptions = decision.options.filter((option) => option.enabled && option.disposition !== "reject" && option.disposition !== "modify");
  const blockedOptions = decision.options.filter((option) => option.blockedReason !== null);
  const rejectLabel = decision.controls.reject.source === "explicit_option"
    ? decision.controls.reject.reply
    : tFor(locale, "one.shell.decision.reject_default");
  const fields: Array<[string, OneDecisionField]> = [
    [tFor(locale, "one.shell.decision.field.target"), decision.target],
    [tFor(locale, "one.shell.decision.field.action"), decision.action],
    [tFor(locale, "one.shell.decision.field.impact"), decision.impact],
    [tFor(locale, "one.shell.decision.field.cost"), decision.cost],
    [tFor(locale, "one.shell.decision.field.reversibility"), decision.reversibility],
    [tFor(locale, "one.shell.decision.field.deadline"), decision.deadline],
  ];
  const lightweightChoice = riskRank === 0 && !approvalBlocked;

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
          <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>
            {tFor(locale, "one.shell.common.later")}
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
        <span className={styles.riskBadge}>{tFor(locale, "one.shell.decision.review_before_continuing")}</span>
      </div>

      <dl className={styles.decisionFacts}>
        {fields.map(([label, field]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{decisionFieldValue(field, locale)}</dd>
          </div>
        ))}
      </dl>

      <p className={styles.decisionEvidence}>
        {tFor(locale, "one.shell.decision.evidence", { time: formatTimestamp(decision.createdAt, locale) })}
      </p>

      {modelUnavailable && (
        <div className={styles.decisionGuard} role="status">
          <span>{judgmentUnavailableMessage(locale)}</span>
        </div>
      )}

      {approvalBlocked && (
        <div className={styles.decisionGuard} role="status">
          <strong>{tFor(locale, "one.shell.decision.approval_unavailable")}</strong>
          <span>{tFor(locale, "one.shell.decision.approval_unavailable_body")}</span>
          {blockedOptions.length > 0 && <small>{tFor(locale, "one.shell.decision.choices_requiring_review")}: {blockedOptions.map((option) => option.label).join(" · ")}</small>}
        </div>
      )}

      {confirmation.multiSelect && !approvalBlocked && (
        <p className={styles.decisionGuard}>{tFor(locale, "one.shell.decision.multi_select")}</p>
      )}

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
        <button type="button" className={styles.decisionRejectButton} disabled={disabled} onClick={() => onAnswer(confirmation, decision.controls.reject.reply)}>{rejectLabel}</button>
        <button type="button" className={styles.decisionButton} onClick={onOpenWork}>{tFor(locale, "one.shell.decision.change_scope")}</button>
        <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>{tFor(locale, "one.shell.decision.remind_24h")}</button>
      </div>
      <p className={styles.decisionHint}>{decisionRejectCopy(locale)}</p>
    </section>
  );
}

function ResolvedDecisionReceipt({ receipt, locale }: { receipt: CommittedQuestionAnswer; locale: "ko" | "en" }) {
  return (
    <details className={styles.resolvedDecision}>
      <summary>
        <span className={styles.resolvedDecisionSummary}>
          <span className={styles.resolvedDecisionCheck} aria-hidden="true">✓</span>
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

function handleComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>, action: () => void) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    action();
  }
}
