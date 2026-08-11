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
import { ElapsedClock } from "@/components/ElapsedClock";
import { IconArrowUp, IconPlus, IconRefresh } from "@/components/Icon";
import { grantForDroppedFile, ipc, ipcEvents } from "@/lib/ipc";
import { tFor, useT } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized } from "@/lib/i18n";
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
  InstalledAgent,
  McpInvocationEvent,
  MobileBridgeRuntimeStatus,
  OneBriefingSnapshot,
  OneMemoryState,
  OneMemoryMapSnapshot,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneExperienceReuseState,
  OneImprovementProofReadState,
  OneImprovementReusedAssetV1,
  OneHomeSignalsV1,
  OneProfile,
  OneBriefingActionPacket,
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
import type {
  OneSurfaceManifestV1,
  OneSurfaceSemanticAction,
} from "@shared/one-surface";
import { customerSafeProgressDetail, toCustomerSafeText } from "@shared/one-customer-safe";
import { classifyOneRequestIntent } from "@shared/one-request-intent";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { useJudgedOneDecision } from "@/lib/one-decision-judged";
import type { OneRecurrenceSelectionV1 } from "@shared/one-recurrence";
import { shouldPresentOneWeeklyReflection } from "@shared/one-weekly-reflection";
import {
  ONE_ATTACHMENT_LIMITS,
  type OneAttachmentPrepareItem,
  type OneAttachmentSafeItem,
  type PreparedOneAttachments,
} from "@shared/one-attachments";
import type { FsPathGrant, OrchestrationTarget } from "@shared/types";
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
  startFreshBuild,
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
import { OneMemoryMap } from "./OneMemoryMap";
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
  overrides: OneTurnOverrides;
  taskForceTargets: OrchestrationTarget[];
};

type OneTurnOverrides = {
  goalMode?: true;
  planMode?: true;
  sessionRouting?: true;
  stormbreakerMode?: true;
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
  if (isResultContinuationMessage(message)) {
    return tFor(detectOneTextLocale(message.text) === "ko" ? "ko" : "en", "one.shell.continuation.body");
  }
  const systemPromptLabel = oneSystemPromptLabel(message);
  if (systemPromptLabel) return systemPromptLabel;
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
  const readableJson = readableOneJson(banded);
  if (readableJson) {
    return toCustomerSafeText(readableJson, detectOneTextLocale(readableJson) === "ko" ? "ko" : "en");
  }
  if (message.streaming && /^[{[]/.test(banded)) return "";
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
  const [dismissedDecisionId, setDismissedDecisionId] = useState<string | null>(null);
  const [committedAnswers, setCommittedAnswers] = useState<CommittedQuestionAnswer[]>([]);
  const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null);
  const [mobileStatus, setMobileStatus] = useState<MobileBridgeRuntimeStatus | null>(null);
  const [oneProfile, setOneProfile] = useState<OneProfile | null>(null);
  const [oneMemory, setOneMemory] = useState<OneMemoryState | null>(null);
  const [oneMemoryMap, setOneMemoryMap] = useState<OneMemoryMapSnapshot | null>(null);
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
  const [runStatus, setRunStatus] = useState("");
  const [queuedSteers, setQueuedSteers] = useState<Array<{ id: string; text: string }>>([]);
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
  const [runProgress, setRunProgress] = useState<OneRunProgressState>(() => initialOneRunProgress());
  // Host-owned liveness for a running turn. The stage label and status detail
  // only move when the runtime emits an event, and a long research turn can emit
  // nothing for minutes — leaving an identical card on screen that is
  // indistinguishable from a hang. This clock never depends on the runtime.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [composer, setComposer] = useState("");
  const [availableAgents, setAvailableAgents] = useState<InstalledAgent[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [turnAgentIds, setTurnAgentIds] = useState<string[]>([]);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [turnOverrides, setTurnOverrides] = useState<OneTurnOverrides>({});
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
  const [searchFailed, setSearchFailed] = useState(false);
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
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void api.team.list()
      .then((items) => { if (!cancelled) setAvailableAgents(visibleAgents(items)); })
      .catch(() => { if (!cancelled) setAvailableAgents([]); });
    return () => { cancelled = true; };
  }, []);
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
  const railRevealButtonRef = useRef<HTMLButtonElement>(null);
  const composerComposingRef = useRef(false);
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
  // 경과 시계는 ElapsedClock 리프가 스스로 돈다 — 3,801줄 셸을 초당 리렌더시키지 않는다.

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

  const refreshAll = useCallback(async () => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-refresh", new Error("Desktop bridge unavailable"));
      setLoaded(true);
      setProjections([]);
      setConversations([]);
      setActiveChatIds([]);
      setConfirmations([]);
      setOneProfile(null);
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
      setOneHomeSignals(null);
      return;
    }
    try {
      const [active, pending, update, mobile, recentChats, profile, memory, memoryMap, suggestions, valueClosures, weeklyReflection, experienceReuse, improvementProofs, proactiveBriefing, intro, activation, homeSignals] = await Promise.all([
        api.invoke.activeChats().catch(() => []),
        api.confirm.listPending().catch(() => []),
        api.updater.getState().catch(() => null),
        api.mobileBridge.status().catch(() => null),
        api.chats.listRecent(40).catch(() => []),
        api.oneProfile.get(),
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
      const items = await listOneTaskProjections(api, active, pending, profile, appLocale);
      setActiveChatIds(active);
      setConfirmations(pending);
      setUpdaterState(update);
      setMobileStatus(mobile);
      setOneProfile(profile);
      setOneMemory(memory);
      if (memoryMap) {
        setOneMemoryMap((current) => current?.sourceRevision === memoryMap.sourceRevision ? current : memoryMap);
      }
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
          router.replace(`/workspace/task?id=${encodeURIComponent(chat.id)}`);
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

  const settleRun = useCallback(async (chatId: string, taskId: string | null) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-run-settle", new Error("Desktop bridge unavailable"));
      return;
    }
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
      // Keep raw runtime/session status out of the customer surface, but retain
      // the verified display name and role in runProgress. Users need to know
      // who One actually brought into the work, not only an anonymous count.
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
      // Failure evidence is persisted by Main and consumed by One's recovery
      // judgment. It never becomes transcript copy in the renderer.
      setBusy(false);
      setRunStatus("");
      setError(null);
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
    if (!api) {
      requestOneOperationalRecovery("one-thread-load", new Error("Desktop bridge unavailable"));
      return;
    }
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
      if (!cancelled) {
        requestOneOperationalRecovery("one-refresh", cause);
        setError(null);
      }
    });
    return () => {
      cancelled = true;
      unsubscribeRunRef.current?.();
      unsubscribeRunRef.current = null;
    };
  }, [
    conversation?.id,
    appLocale,
    selected?.chatId,
    selected?.latestReceipt?.runId,
    selected?.latestReceipt?.status,
    selected?.taskId,
    subscribeRun,
  ]);

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
    setQueuedSteers([]);
  }, [activeThreadChatId]);
  // Main starts a queued steer only after the active model turn settles. Attach
  // to that replacement run immediately so the user never has to leave and
  // reopen One to see continued progress.
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    const chatId = activeThreadChatId;
    if (!api || !events || !chatId) return;
    return events.onActiveChats((chatIds) => {
      if (!chatIds.includes(chatId) || runIdRef.current) return;
      void api.invoke.attach(chatId).then((attachment) => {
        if (!attachment || runIdRef.current || runChatIdRef.current !== chatId) return;
        runIdRef.current = attachment.runId;
        runTaskIdRef.current = selected?.taskId ?? null;
        setBusy(true);
        setRunStatus(tFor(appLocale, "one.shell.run.reconnected"));
        setRunProgress(initialOneRunProgress());
        setQueuedSteers((current) => current.slice(1));
        subscribeRun(attachment.runId);
        for (const event of attachment.events) consumeRunEventRef.current(event);
      }).catch(() => undefined);
    });
  }, [activeThreadChatId, appLocale, selected?.taskId, subscribeRun]);
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
        if (proposal && ["proposed", "blocked", "deferred", "team_reserved", "solo_reserved"].includes(proposal.status)) {
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
        ...(options?.promptOrigin ? { promptOrigin: options.promptOrigin } : {}),
        taskIntent,
        oneMode: true,
        ...(options?.teamRef ? { oneTeamPreflightRef: options.teamRef } : {}),
        ...(options?.attachments ? { oneAttachmentRef: options.attachments.ref } : {}),
        ...(options?.recurrence ? { oneRecurrenceSelection: options.recurrence } : {}),
        ...(options?.taskForceTargets?.length ? { taskForceTargets: options.taskForceTargets } : {}),
        ...(attachedOneMemoryUseOnce ? {
          oneMemoryUseOnceRef: {
            contractVersion: attachedOneMemoryUseOnce.contractVersion,
            receiptId: attachedOneMemoryUseOnce.receiptId,
          },
        } : {}),
        locale: runLocale,
        permissions: executionPermission,
        ...(options?.overrides?.goalMode ? { goalMode: true } : {}),
        ...(options?.overrides?.planMode ? { planMode: true } : {}),
        ...(options?.overrides?.sessionRouting ? { sessionRouting: true } : { sessionRouting: false }),
        ...(options?.overrides?.stormbreakerMode ? { stormbreakerMode: true } : {}),
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
      // Main owns the failed receipt and recovery evidence. Keep the unfinished
      // run out of the transcript; refreshAll lets the automatic recovery loop
      // judge and resume it.
      setError(null);
      if (options?.attachments) {
        await api.oneAttachments.discard({ ref: options.attachments.ref }).catch(() => ({ discarded: false }));
      }
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
  }, [armedOneMemoryUseOnce, normalizedLocale, refreshAll, scrollToLatest, subscribeRun]);

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
    const prompt = pendingTeamPrompt;
    if (!proposal || !prompt || runIdRef.current) return;
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
  }, [pendingTeamPrompt, router, startRun, teamPreflight]);

  const awaitingWorkforceConsent = Boolean(
    teamPreflight
    && pendingTeamPrompt
    && pendingTeamPrompt.proposalId === teamPreflight.proposalId
    && teamPreflight.canConfirmWorkforce
    && ["proposed", "blocked", "deferred"].includes(teamPreflight.status),
  );
  const preparedLocalTeam = teamPreflight
    && teamPreflight.canConfirmTeam
    && ["proposed", "team_reserved", "team_started"].includes(teamPreflight.status)
    ? teamPreflight.roles
    : [];

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
    const recurrenceSnapshot = recurrenceSelection ? { ...recurrenceSelection } : null;
    const overrideSnapshot = { ...turnOverrides };
    const taskForceTargetSnapshot: OrchestrationTarget[] = turnAgentIds.map((agentId) => ({
      source: "local",
      entityKind: "agent",
      agentId,
    }));
    const explicitValue = text.trim();
    if ((!explicitValue && attachmentSnapshot.length === 0) || teamPreflightBusy) return;
    const value = explicitValue || tFor(appLocale, "one.shell.composer.attachment_prompt", { n: attachmentSnapshot.length, s: attachmentSnapshot.length === 1 ? "" : "s" });
    const api = ipc();
    if (!api) {
      setError(null);
      requestOneOperationalRecovery("one-submit-connection", "Desktop bridge unavailable");
      return;
    }
    if (busy) {
      const chatId = runChatIdRef.current;
      const activeRunId = runIdRef.current;
      if (!chatId || !activeRunId || attachmentSnapshot.length > 0) return;
      const optimisticId = `one-steer:${uid()}`;
      setComposer("");
      setMessages((current) => [...current, { id: optimisticId, role: "user", text: value }]);
      setQueuedSteers((current) => [...current, { id: optimisticId, text: value }]);
      scrollToLatest();
      try {
        await api.invoke.steer({
          chatId,
          userPrompt: value,
          taskIntent: selected ? "task" : "conversation",
          oneMode: true,
          locale: detectOneTextLocale(value) ?? normalizedLocale,
          permissions: selected ? "full" : "read",
          sessionRouting: false,
        });
      } catch (cause) {
        setQueuedSteers((current) => current.filter((item) => item.id !== optimisticId));
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
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
      // Resolve new-chat intent in Main while team preflight runs. A cold model
      // can miss the fast judgment budget, in which case Main returns its
      // explicitly labeled conservative fallback instead of silently forcing a
      // work request into read-only conversation mode.
      const requestIntentPromise = taskIntent === "conversation" && attachmentSnapshot.length === 0
        ? api.oneRequestIntent.resolve(value).catch(() => null)
        : Promise.resolve(null);
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
          ...(taskForceTargetSnapshot.length > 0 ? { requestedAgentIds: taskForceTargetSnapshot.map((target) => target.source === "local" && target.entityKind === "agent" ? target.agentId : "").filter(Boolean) } : {}),
          ...(overrideSnapshot.sessionRouting ? { dynamicTeamRequested: true } : {}),
        });
        if (prepared.kind === "not_required") {
          const mainIntent = await requestIntentPromise;
          const resolvedIntent = preparedAttachments
            ? "task"
            : taskIntent === "task"
              || mainIntent?.intent === "task"
              // The renderer-only classifier is intentionally three-valued:
              // without a judged reader this can only remain "undecided". Keep
              // the shared safety boundary explicit while Main owns the actual
              // semantic decision above.
              || classifyOneRequestIntent(value) === "task"
              ? "task"
              : "conversation";
          await startRun(
            chatId,
            taskId,
            taskVersion,
            value,
            resolvedIntent,
            {
              attachments: preparedAttachments,
              recurrence: recurrenceSnapshot,
              overrides: overrideSnapshot,
              taskForceTargets: taskForceTargetSnapshot,
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
          text: value,
          attachments: preparedAttachments,
          recurrence: recurrenceSnapshot,
          overrides: overrideSnapshot,
          taskForceTargets: taskForceTargetSnapshot,
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
    setTurnOverrides({});
    setTurnAgentIds([]);
    setAgentPickerOpen(false);
    setModeMenuOpen(false);
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
      const chat = await api.chats.create({
        title: value.split(/\r?\n/)[0].slice(0, 72),
        taskMode: "conversation",
        originSurface: "one",
      });
      setConversation(chat);
      selectedConversationIdRef.current = chat.id;
      router.replace(`/one?chat=${encodeURIComponent(chat.id)}`);
      await resolveActivationConcern(chat.id);
      await prepareOrRun(chat.id, null, null, "conversation");
    } catch (cause) {
      setTeamPreflightBusy(false);
      requestOneOperationalRecovery("one-submit", cause);
      setError(null);
    }
  }, [autoStartTeamPreflight, busy, clearAttachmentDrafts, conversation, appLocale, normalizedLocale, recurrenceSelection, resolveActivationConcern, router, scrollToLatest, selected, startRun, teamPreflight, teamPreflightBusy, turnAgentIds, turnOverrides]);

  const stopRun = useCallback(() => {
    const api = ipc();
    const runId = runIdRef.current;
    if (!runId) return;
    if (!api) {
      requestOneOperationalRecovery("one-run-stop", new Error("Desktop bridge unavailable"));
      return;
    }
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
      await api.confirm.commitAnswer({ chatId: confirmation.chatId, reply: label });
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
          );
        } else {
          const task = await api.tasks.findForChat(confirmation.chatId);
          if (!task) throw new Error("One could not bind the decision to its task");
          await startRun(confirmation.chatId, task.id, task.version, label, "task");
        }
      }
    } catch (cause) {
      requestOneOperationalRecovery("one-decision-answer", cause);
      setError(null);
    }
  }, [busy, conversation?.id, conversation?.originSurface, projections, startRun]);

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
  const actionableConfirmations = useMemo(
    () => confirmations.filter((item) => !isPendingConfirmationSnoozed(item)),
    [confirmations],
  );
  const reactiveBriefing = useMemo(() => chooseOneBriefing(projections, actionableConfirmations, appLocale), [actionableConfirmations, appLocale, projections]);
  // Deterministic observations remain private evidence. One may surface them
  // only after its model has authored the customer-facing diagnosis and action.
  const rawBriefing: DisplayBriefing = reactiveBriefing;
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
  const showMemoryMap = Boolean(
    briefing.kind === "quiet"
    && !briefing.proactive
    && !activationForeground
    && oneMemoryMap
    && oneMemoryMap.nodes.length > 0,
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
  const canOpenSelectedInWork = Boolean(selected?.chat?.projectId);
  const openWork = useCallback(async () => {
    const api = ipc();
    // Ask Main which conversation this Task really lives in. The href below is
    // assembled from a projection that can lag behind the store, so the verified
    // target wins whenever Main can produce one.
    if (api && selected) {
      if (!canOpenSelectedInWork) return;
      const target = await resolveOneTaskWorkTarget(api, selected.taskId);
      if (target) {
        router.push(`/workspace/task?id=${encodeURIComponent(target.chatId)}&task=${encodeURIComponent(target.taskId)}`);
        return;
      }
      return;
    }
    router.push("/dashboard");
  }, [canOpenSelectedInWork, router, selected]);
  const handleOneSemanticAction = useCallback((action: OneSurfaceSemanticAction) => {
    if (!action.enabled || busy) return;
    if (action.intent === "open_work") {
      void openWork();
      return;
    }
    if (action.intent === "open_asset") {
      const kind = action.targetRef?.split(":", 1)[0];
      if (kind === "agent") router.push("/library/agents");
      else if (kind === "team") router.push("/library/agents");
      else if (kind === "automation") router.push("/automation");
      else if (kind === "project") void openWork();
      else if (kind === "site") router.push("/site");
      else void openWork();
      return;
    }
    if (!["try_result", "refine_result", "reuse_result", "prepare_share"].includes(action.intent)) {
      void openWork();
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
  }, [busy, conversation?.id, openWork, router, selected, startRun]);
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
  const openActivationWork = useCallback(async () => {
    const api = ipc();
    let current = oneActivationState;
    if (api?.oneActivation && current?.status === "active") {
      try {
        current = await api.oneActivation.resolveWork({
          expectedStoreVersion: current.version,
          confirmedByUser: true,
        });
      } catch (cause) {
        requestOneOperationalRecovery("one-activation-work", cause);
        const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale }).catch(() => null);
        if (latest?.status === "active" && latest.workNavigation.status === "pending") {
          current = await api.oneActivation.resolveWork({
            expectedStoreVersion: latest.version,
            confirmedByUser: true,
          }).catch((retryCause) => {
            requestOneOperationalRecovery("one-activation-work", retryCause);
            return latest;
          });
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
    if (!current || current.status !== "active") return;
    if (!api?.oneActivation) {
      requestOneOperationalRecovery("one-activation-skip", new Error("Desktop bridge unavailable"));
      return;
    }
    try {
      current = await api.oneActivation.skip({
        expectedStoreVersion: current.version,
        confirmedByUser: true,
      });
    } catch (cause) {
      requestOneOperationalRecovery("one-activation-skip", cause);
      try {
        const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale });
        current = latest.status === "active"
          ? await api.oneActivation.skip({ expectedStoreVersion: latest.version, confirmedByUser: true })
          : latest;
      } catch (retryCause) {
        requestOneOperationalRecovery("one-activation-skip", retryCause);
        return;
      }
    }
    setOneActivationState(current);
  }, [appLocale, oneActivationState]);
  const resolveActivationMobile = useCallback(async (resolution: OneActivationMobileResolution) => {
    const api = ipc();
    let current = oneActivationState;
    if (!current || current.mobileConnection.status !== "offered") return;
    if (!api?.oneActivation) {
      requestOneOperationalRecovery("one-activation-mobile", new Error("Desktop bridge unavailable"));
      return;
    }
    try {
      current = await api.oneActivation.resolveMobile({
        expectedStoreVersion: current.version,
        resolution,
        confirmedByUser: true,
      });
    } catch (cause) {
      requestOneOperationalRecovery("one-activation-mobile", cause);
      try {
        const latest = await api.oneActivation.getState({ platform: "desktop", locale: appLocale });
        current = latest.mobileConnection.status === "offered"
          ? await api.oneActivation.resolveMobile({ expectedStoreVersion: latest.version, resolution, confirmedByUser: true })
          : latest;
      } catch (retryCause) {
        requestOneOperationalRecovery("one-activation-mobile", retryCause);
        return;
      }
    }
    setOneActivationState(current);
    if (resolution === "opened_settings") router.push("/settings");
  }, [appLocale, oneActivationState, router]);
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
      router.push("/automation");
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
    if (action.id === "approve_graph" && action.targetId) {
      // 승인 카드는 캔버스에 있다 — 상세 화면으로 보내면 누를 것을 못 찾는다.
      router.push(`/automation/flow?id=${encodeURIComponent(action.targetId)}`);
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
    // 이어하기만 현재 세션을 보존한다. "에이전트 만들기"와 "다시 사용해보기"는
    // 이전 요청·첨부·출력 폴더를 새 에이전트에 섞지 않는 진짜 새 빌드다.
    if (action.id !== "resume_build") startFreshBuild();
    router.push("/build");
  }, [router]);
  const closeAutomationSheet = useCallback(() => setAutomationSheetOpen(false), []);
  const openCreatedAutomation = useCallback((automationId: string) => {
    setAutomationSheetOpen(false);
    router.push(`/automation/detail?id=${encodeURIComponent(automationId)}`);
  }, [router]);
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
    if (candidate.preparedAction.kind === "open_project") {
      router.push(`/project/detail?id=${encodeURIComponent(candidate.preparedAction.targetId)}`);
      return;
    }
    if (candidate.preparedAction.kind === "open_task") return;
    router.push(`/automation/detail?id=${encodeURIComponent(candidate.preparedAction.targetId)}`);
  }, [router]);
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
    return <div className={styles.shell}><div className={styles.loading} role="status">{tFor(appLocale, "one.shell.loading")}</div></div>;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.body} data-rail-collapsed={railCollapsed ? "true" : "false"}>
        {railOpen && <button type="button" className={styles.railScrim} aria-label={tFor(appLocale, "one.shell.rail.close_history_aria")} onClick={() => setRailOpen(false)} />}
        <aside
          className={styles.rail}
          data-open={railOpen ? "true" : "false"}
          aria-label={tFor(appLocale, "one.shell.rail.aria")}
          aria-hidden={railCollapsed && !railOpen ? "true" : undefined}
          inert={railCollapsed && !railOpen ? true : undefined}
        >
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
            {conversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} onRemove={removeConversation} />)}
            {projections.length > 0 && <p className={styles.railSectionLabel}>{tFor(appLocale, "one.shell.rail.section_work")}</p>}
            {projections.map((item) => <TaskListButton key={item.taskId} item={item} active={item.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />)}
            {projections.length === 0 && conversations.length === 0 && <div className={styles.railEmpty}>{tFor(appLocale, "one.shell.rail.empty")}</div>}
          </div>
          <div className={styles.railFooter}>
            {selected && <nav className={`${styles.railUtilities} ${styles.railTaskActions}`} aria-label={tFor(appLocale, "one.shell.rail.manage_task_aria")}>
              {canOpenSelectedInWork && (
              <button type="button" onClick={() => void openWork()}>{tFor(appLocale, "one.shell.rail.open_in_work")}<span aria-hidden="true">↗</span></button>
              )}
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
              <button type="button" onClick={() => router.push("/one")}>
                {appLocale === "ko" ? "One 홈" : "One home"}
              </button>
              <button type="button" onClick={() => { setMemoryOpen(false); setProfileOpen(true); }}>
                {appLocale === "ko" ? `프로필 · ${oneDisplayName}` : `Profile · ${oneDisplayName}`}
              </button>
              <button type="button" onClick={() => { setProfileOpen(false); setMemoryOpen(true); }}>
                {tFor(appLocale, "one.shell.rail.memory")}
                {oneMemory && oneMemory.candidates.some((candidate) => candidate.status === "pending") && <span className={styles.railCount}>{oneMemory.candidates.filter((candidate) => candidate.status === "pending").length}</span>}
              </button>
              <button type="button" onClick={() => setPref(appLocale === "ko" ? "en" : "ko")}>
                <span>{tFor(appLocale, "one.shell.rail.language")}</span>
                <span>{tFor(appLocale, "one.shell.rail.language_switch")}</span>
              </button>
              <button type="button" disabled={activationForeground} onClick={() => setIntroReplayToken((value) => value + 1)}>{tFor(appLocale, "one.shell.rail.about_one")}</button>
              <button type="button" className={styles.railOpenWork} onClick={() => void openWork()}>{tFor(appLocale, "one.shell.rail.open_work")}<span aria-hidden="true">↗</span></button>
            </nav>
            <span className={styles.connection} data-offline={!executionAvailable ? "true" : "false"} role="status">
              <span className={styles.connectionDot} aria-hidden="true" /><span>{connectionLabel}</span>
            </span>
          </div>
        </aside>

        <main className={styles.workspace}>
          <div className={`${styles.windowBar} titlebar-drag`}>
            <button
              ref={railRevealButtonRef}
              type="button"
              className={`${styles.sidebarRevealButton} titlebar-nodrag`}
              aria-label={tFor(appLocale, "one.shell.workspace.open_sidebar_aria")}
              onClick={() => { setRailCollapsed(false); setRailOpen(true); }}
            >☰</button>
          </div>
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
              <div className={`${styles.homeContent} ${showMemoryMap ? styles.memoryHomeContent : ""}`}>
                {briefing.kind === "quiet" && !briefing.proactive ? (
                  activationForeground
                    ? null
                    : showMemoryMap && oneMemoryMap
                      ? <OneMemoryMap snapshot={oneMemoryMap} locale={appLocale} />
                      : <section className={styles.newUser} aria-labelledby="one-first-run-title">
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
                          : <>
                              <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void reviewPreparedFinding(briefing.proactive!)}>{briefingActionBusy ? tFor(appLocale, "one.shell.common.checking") : tFor(appLocale, "one.shell.briefing.review")}</button>
                              <button type="button" className={styles.ghostButton} onClick={() => openPreparedFinding(briefing.proactive!)}>{briefing.primaryLabel}</button>
                            </>
                        : briefing.taskId && <button type="button" className={styles.primaryButton} onClick={() => openTask(briefing.taskId!)}>{briefing.primaryLabel}</button>}
                      {briefing.kind !== "quiet" && (briefing.proactive
                        ? <button type="button" className={styles.ghostButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "later")}>{tFor(appLocale, "one.shell.common.later")}</button>
                        : <button type="button" className={styles.ghostButton} onClick={() => { const signature = briefingSignature(briefing); setDismissedBriefing({ signature, expiresAt: writeBriefingDismissal(signature) }); }}>{tFor(appLocale, "one.shell.common.later")}</button>)}
                    </div>
                    {pendingBriefingAction && (
                      <div className={styles.briefingConfirm} role="group" aria-label={tFor(appLocale, "one.shell.briefing.confirm_title")}>
                        <p className={styles.briefingConfirmTitle}>{tFor(appLocale, "one.shell.briefing.confirm_title")}</p>
                        <p className={styles.briefingConfirmBody}>{tFor(appLocale, "one.shell.briefing.confirm_body")}</p>
                        <div className={styles.briefingActions}>
                          <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void confirmBriefingAction()}>
                            {briefingActionBusy ? tFor(appLocale, "one.shell.common.checking") : tFor(appLocale, "one.shell.briefing.confirm_accept")}
                          </button>
                          <button type="button" className={styles.ghostButton} disabled={briefingActionBusy} onClick={() => setPendingBriefingAction(null)}>
                            {tFor(appLocale, "one.shell.briefing.confirm_decline")}
                          </button>
                        </div>
                      </div>
                    )}
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
                      {preparedLocalTeam.length > 1 && (
                        <div
                          className={styles.preparedTeam}
                          aria-label={tFor(appLocale, "one.shell.thread.prepared_team_aria")}
                        >
                          <small>
                            {tFor(appLocale, "one.shell.thread.team_found", {
                              count: String(preparedLocalTeam.length - 1),
                            })}
                          </small>
                          <div>
                            {preparedLocalTeam.map((role) => (
                              <span key={role.roleId}>
                                <strong>{role.candidate.displayName}</strong>
                                {role.label.trim().toLocaleLowerCase() !== role.candidate.displayName.trim().toLocaleLowerCase()
                                  && <small>{role.label}</small>}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
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
                      {runProgress.participants.length > 0
                        ? `${tFor(appLocale, "one.shell.thread.agents_called", { count: String(runProgress.participants.length) })} · ${runProgress.participants.map((participant) => participant.name).join(" · ")}`
                        : preparedLocalTeam.length > 1
                          ? tFor(appLocale, "one.shell.thread.team_ready", { count: String(preparedLocalTeam.length - 1) })
                        : tFor(appLocale, "one.shell.thread.working_directly")}
                    </small>
                    {(runProgress.participants.length > 0 || preparedLocalTeam.length > 1) && (
                      <div
                        className={styles.runParticipants}
                        data-state={runProgress.participants.length > 0 ? "active" : "prepared"}
                        aria-label={tFor(
                          appLocale,
                          runProgress.participants.length > 0
                            ? "one.shell.thread.agents_called_aria"
                            : "one.shell.thread.prepared_team_aria",
                        )}
                      >
                        {runProgress.participants.length > 0
                          ? runProgress.participants.map((participant) => (
                              <span key={participant.id}>
                                <strong>{participant.name}</strong>
                                {participant.role && <small>{participant.role}</small>}
                              </span>
                            ))
                          : preparedLocalTeam.map((role) => (
                              <span key={role.roleId}>
                                <strong>{role.candidate.displayName}</strong>
                                {role.label.trim().toLocaleLowerCase() !== role.candidate.displayName.trim().toLocaleLowerCase()
                                  && <small>{role.label}</small>}
                              </span>
                            ))}
                      </div>
                    )}
                    {runStatus && <span className={styles.runStatusDetail}>{runStatus}</span>}
                    <ElapsedClock startedAt={runStartedAt} format={formatRunElapsed} className={styles.runElapsed} />
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
                      onOpenWork={() => void openWork()}
                      canOpenWork={canOpenSelectedInWork}
                      onSemanticAction={handleOneSemanticAction}
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
                  >@{localized.name}<span aria-hidden>×</span></button>;
                })}
              </div>
            )}
            {agentPickerOpen && (
              <section className={styles.oneTurnMenu} aria-label={appLocale === "ko" ? "이번 턴 에이전트 선택" : "Choose agents for this turn"}>
                <header>{appLocale === "ko" ? "이번 턴에 부를 서브 에이전트" : "Sub-agents for this turn"}</header>
                <div>
                  {availableAgents.map((candidate) => {
                    const localized = pickLocalized(candidate, appLocale);
                    const selectedForTurn = turnAgentIds.includes(candidate.id);
                    return <button key={candidate.id} type="button" data-active={selectedForTurn ? "true" : "false"} onClick={() => {
                      setTurnAgentIds((current) => current.includes(candidate.id)
                        ? current.filter((id) => id !== candidate.id)
                        : [...current, candidate.id]);
                      setComposer((current) => {
                        const match = current.match(/(^|\s)@[^\s]*$/u);
                        return match ? `${current.slice(0, match.index)}${match[1]}` : current;
                      });
                      window.setTimeout(() => composerInputRef.current?.focus(), 0);
                    }}><strong>{selectedForTurn ? "✓ " : ""}{localized.name}</strong><span>{localized.tagline}</span></button>;
                  })}
                </div>
                <small>{appLocale === "ko" ? "호출된 에이전트는 이 턴에만 참여하며 One이 세션을 계속 관리합니다." : "Called agents participate in this turn only. One continues to manage the session."}</small>
              </section>
            )}
            {modeMenuOpen && (
              <section className={styles.oneTurnMenu} aria-label={appLocale === "ko" ? "이번 턴 옵션" : "Options for this turn"}>
                <header>{appLocale === "ko" ? "명시적 옵션 · 선택하지 않으면 One이 판단" : "Explicit options · otherwise One decides"}</header>
                <div className={styles.oneTurnToggles}>
                  {([
                    ["goalMode", appLocale === "ko" ? "Goal" : "Goal"],
                    ["planMode", appLocale === "ko" ? "Plan" : "Plan"],
                    ["sessionRouting", appLocale === "ko" ? "동적 팀" : "Dynamic team"],
                    ["stormbreakerMode", "Stormbreaker"],
                  ] as Array<[keyof OneTurnOverrides, string]>).map(([key, label]) => <button
                    key={key}
                    type="button"
                    data-active={turnOverrides[key] ? "true" : "false"}
                    onClick={() => setTurnOverrides((current) => {
                      const next = { ...current };
                      if (next[key]) delete next[key]; else next[key] = true;
                      return next;
                    })}
                  >{label}</button>)}
                </div>
              </section>
            )}
            {queuedSteers.length > 0 && (
              <div className={styles.steeringQueue} role="status" aria-live="polite" data-one-steering-queue="true">
                <span>{appLocale === "ko" ? "다음 지시" : "Next instruction"}</span>
                <strong>{queuedSteers[queuedSteers.length - 1]?.text}</strong>
                <small>{appLocale === "ko" ? "현재 모델을 중단하지 않고 이어서 반영합니다" : "Will be applied without stopping the current model"}</small>
              </div>
            )}
            <form className={styles.composer} onSubmit={(event) => {
              event.preventDefault();
              if (busy && !composer.trim()) stopRun();
              else void submit(composer);
            }}>
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
                onKeyDown={(event) => handleComposerKey(
                  event,
                  busy && !composer.trim() ? stopRun : () => void submit(composer),
                  composerComposingRef.current,
                )}
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
                    aria-expanded={agentPickerOpen}
                    aria-label={appLocale === "ko" ? "이번 턴에 에이전트 호출" : "Call agents for this turn"}
                    onClick={() => { setModeMenuOpen(false); setAgentPickerOpen((open) => !open); }}
                  >@</button>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                    aria-expanded={modeMenuOpen}
                    aria-label={appLocale === "ko" ? "이번 턴 옵션" : "Options for this turn"}
                    onClick={() => { setAgentPickerOpen(false); setModeMenuOpen((open) => !open); }}
                  >◇</button>
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
                  <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={!busy && ((!composer.trim() && attachmentDrafts.length === 0) || selectedReadOnly || teamDecisionPending || teamPreflightBusy)}
                    aria-label={busy
                      ? composer.trim()
                        ? (appLocale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
                        : tFor(appLocale, "one.shell.composer.stop_run_aria")
                      : tFor(appLocale, "one.shell.composer.send_aria")}
                    title={busy && composer.trim()
                      ? (appLocale === "ko" ? "모델 중단 없이 제출" : "Submit without stopping the model")
                      : undefined}
                  >
                    {busy && !composer.trim() ? <span className={styles.stopGlyph} aria-hidden="true" /> : <IconArrowUp size={20} strokeWidth={2} aria-hidden="true" />}
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
                {query.trim() && searchLoading && searchHits.length === 0 && <div className={styles.searchState} role="status">{tFor(appLocale, "one.shell.search.searching")}</div>}
                {query.trim() && !searchLoading && !searchFailed && searchHits.length === 0 && <div className={styles.searchState}>{tFor(appLocale, "one.shell.search.no_match")}</div>}
                {query.trim() && searchNextCursor && !searchFailed && (
                  <button type="button" className={styles.searchMore} disabled={searchLoadingMore} onClick={loadMoreSearchResults}>
                    {searchLoadingMore ? tFor(appLocale, "one.shell.search.finding_more") : tFor(appLocale, "one.shell.search.show_older")}
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
        {activeThreadChatId && visibleSelectedConfirmation && (
          <DecisionBottomSheet
            confirmation={visibleSelectedConfirmation}
            taskId={selected?.taskId ?? null}
            locale={appLocale}
            disabled={busy || selectedReadOnly}
            onAnswer={answerConfirmation}
            onClarify={clarifyConfirmation}
            onSnooze={snoozeConfirmation}
            onDismiss={() => setDismissedDecisionId(visibleSelectedConfirmation.sourceMessageId)}
          />
        )}
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
      <strong>{briefingSourceName(item.display.title, locale)}</strong>
      <small>{statusLabel(item.status.value, locale, item.canonicalStatus)} · {formatTimestamp(item.status.asOf, locale)}</small>
      <span className={styles.statusDot} data-status={item.status.value} aria-hidden="true" />
    </button>
  );
}

function ConversationListButton({ item, active, locale, onOpen, onRemove }: { item: Chat; active: boolean; locale: "ko" | "en"; onOpen: (chatId: string) => void; onRemove: (chatId: string) => Promise<void> }) {
  return (
    <div className={styles.conversationRow}>
      <button type="button" className={styles.taskButton} data-active={active ? "true" : "false"} onClick={() => onOpen(item.id)} aria-current={active ? "page" : undefined}>
        <strong>{briefingSourceName(item.title, locale)}</strong>
        <small>{tFor(locale, "one.shell.convlist.conversation")} · {formatTimestamp(item.updatedAt, locale)}</small>
      </button>
      <button type="button" className={styles.conversationDelete} onClick={(event) => { event.stopPropagation(); void onRemove(item.id); }} aria-label={locale === "ko" ? "대화 삭제" : "Delete conversation"}>×</button>
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

function DecisionBottomSheet({ confirmation, taskId, locale, disabled, onAnswer, onClarify, onSnooze, onDismiss }: {
  confirmation: PendingConfirmation;
  taskId: string | null;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (confirmation: PendingConfirmation, label: string, shouldStart?: boolean) => void;
  onClarify: (confirmation: PendingConfirmation) => void;
  onSnooze: (confirmation: PendingConfirmation) => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const outside: Array<{
      element: HTMLElement;
      inert: string | null;
      ariaHidden: string | null;
    }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        outside.push({
          element: sibling,
          inert: sibling.getAttribute("inert"),
          ariaHidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
      if (parent === document.body) break;
      branch = parent;
    }
    dialog?.focus();
    return () => {
      for (const item of outside.reverse()) {
        if (item.inert === null) item.element.removeAttribute("inert");
        else item.element.setAttribute("inert", item.inert);
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      previouslyFocused?.focus();
    };
  }, [confirmation.sourceMessageId]);

  const trapFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]",
    )].filter((item) => item.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
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
  }, [onDismiss]);

  return (
    <div className={styles.decisionSheetLayer} role="presentation">
      <button
        type="button"
        className={styles.decisionSheetBackdrop}
        aria-label={tFor(locale, "one.shell.decision.close")}
        onClick={onDismiss}
      />
      <div
        ref={dialogRef}
        className={styles.decisionSheet}
        role="dialog"
        aria-modal="true"
        aria-label={locale === "ko" ? "One의 사용자 결정 요청" : "Decision requested by One"}
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <div className={styles.decisionSheetHandle} aria-hidden="true" />
        <button type="button" className={styles.decisionDismissButton} onClick={onDismiss}>
          {tFor(locale, "one.shell.decision.close")}
        </button>
        <DecisionCard
          confirmation={confirmation}
          taskId={taskId}
          locale={locale}
          disabled={disabled}
          onAnswer={onAnswer}
          onClarify={onClarify}
          onSnooze={onSnooze}
        />
      </div>
    </div>
  );
}

function DecisionCard({ confirmation, taskId, locale, disabled, onAnswer, onClarify, onSnooze }: {
  confirmation: PendingConfirmation;
  taskId: string | null;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (confirmation: PendingConfirmation, label: string, shouldStart?: boolean) => void;
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
  const blockedOptions = decision.options.filter((option) => option.blockedReason !== null);
  const approvalBlocked = blockedOptions.some((option) => option.blockedReason === "unstructured_high_risk");
  const [multiSelection, setMultiSelection] = useState<number[]>([]);
  useEffect(() => setMultiSelection([]), [confirmation.sourceMessageId]);
  const selectedMultiLabels = directOptions
    .filter((option) => multiSelection.includes(option.index))
    .map((option) => option.label);
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
  const lightweightChoice = riskRank === 0 && !approvalBlocked && !confirmation.multiSelect;

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

      {approvalBlocked && (
        <div className={styles.decisionGuard} role="status">
          <strong>{tFor(locale, modelUnavailable
            ? "one.shell.decision.model_review_pending"
            : "one.shell.decision.approval_unavailable")}</strong>
          <span>{tFor(locale, modelUnavailable
            ? "one.shell.decision.model_review_pending_body"
            : "one.shell.decision.approval_unavailable_body")}</span>
          {blockedOptions.length > 0 && <small>{tFor(locale, "one.shell.decision.choices_requiring_review")}: {blockedOptions.map((option) => option.label).join(" · ")}</small>}
        </div>
      )}

      <div className={styles.decisionActionGroup}>
        <p className={styles.decisionSectionLabel}>{tFor(locale, "one.shell.decision.choose_action")}</p>
        <div className={styles.decisionOptions}>
          {confirmation.multiSelect && !approvalBlocked ? (
            <>
              <div className={styles.decisionMultiOptions} role="group" aria-label={tFor(locale, "one.shell.decision.multi_select")}>
                {directOptions.map((option) => {
                  const selected = multiSelection.includes(option.index);
                  return (
                    <button
                      key={`${option.index}:${option.label}`}
                      type="button"
                      className={styles.decisionMultiOption}
                      aria-pressed={selected}
                      disabled={disabled}
                      title={option.description ?? undefined}
                      onClick={() => setMultiSelection((current) => selected
                        ? current.filter((index) => index !== option.index)
                        : [...current, option.index])}
                    >
                      <span aria-hidden="true">{selected ? "✓" : ""}</span>{option.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className={styles.decisionPrimaryButton}
                disabled={disabled || selectedMultiLabels.length === 0}
                onClick={() => onAnswer(confirmation, selectedMultiLabels.join(" · "))}
              >
                {tFor(locale, "one.shell.decision.confirm_selection_and_run")}
              </button>
            </>
          ) : directOptions.map((option) => (
            <button
              key={`${option.index}:${option.label}`}
              type="button"
              className={styles.decisionPrimaryButton}
              disabled={disabled}
              onClick={() => onAnswer(confirmation, option.label)}
            >
              <span>{riskRank >= 2
                ? tFor(locale, "one.shell.decision.approve_and_run", { action: option.label })
                : option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
        <div className={styles.decisionSecondaryActions}>
          <button type="button" className={styles.decisionRejectButton} disabled={disabled} onClick={() => onAnswer(confirmation, rejectReply, false)}>
            <span>{rejectLabel}</span>
            {rejectOption?.description && <small>{rejectOption.description}</small>}
          </button>
          {(approvalBlocked || hasModifyOption) && (
            <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onClarify(confirmation)}>
              {tFor(locale, approvalBlocked ? "one.shell.decision.change_scope" : "one.shell.decision.adjust_conditions")}
            </button>
          )}
          <button
            type="button"
            className={styles.decisionButton}
            disabled={disabled}
            title={tFor(locale, "one.shell.decision.remind_24h")}
            onClick={() => onSnooze(confirmation)}
          >
            {tFor(locale, "one.shell.decision.remind_24h")}
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

function handleComposerKey(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  action: () => void,
  composing = false,
) {
  if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    action();
  }
}
