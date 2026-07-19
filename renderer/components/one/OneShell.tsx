"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Markdown, StreamingMarkdown } from "@/components/Markdown";
import { IconArrowUp, IconPlus, IconRefresh } from "@/components/Icon";
import { grantForDroppedFile, ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { extractQuestions } from "@/lib/ask-question";
import {
  detectOneTextLocale,
  inferOneConversationLocale,
  inferOneRecentContextLocale,
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
  OneBriefingCadence,
  OneBriefingActionPacket,
  OneBriefingSnapshot,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneExperienceReuseState,
  OneImprovementProofReadState,
  OneImprovementReusedAssetV1,
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
import { classifyOneRequestIntent } from "@shared/one-request-intent";
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
  openOneTaskInWork,
  type OneTaskProjection,
} from "@/lib/one-task-adapter";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneBrandLockup, OneBrandMark } from "./OneBrand";
import { OneAdaptiveResult } from "./OneAdaptiveResult";
import { OneActivation } from "./OneActivation";
import { OneFeatureIntro } from "./OneFeatureIntro";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneMemoryCandidateCard } from "./OneMemoryCandidateCard";
import { OneProfileSheet } from "./OneProfileSheet";
import { OneRecurrenceControl } from "./OneRecurrenceControl";
import { OneSuggestionCard } from "./OneSuggestionCard";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { OneWeeklyReflectionCard } from "./OneWeeklyReflectionCard";
import styles from "./OneShell.module.css";

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
    return detectOneTextLocale(message.text) === "ko"
      ? "이전 결과를 참고해 새 일로 시작했어요."
      : "One started this as new work using the previous result for context.";
  }
  if (message.role !== "assistant") return message.text;
  const extracted = extractQuestions(message.text, message.id).text;
  const unfinishedFence = extracted.indexOf("<<agentlas-ask>>");
  const withoutFence = unfinishedFence >= 0 ? extracted.slice(0, unfinishedFence) : extracted;
  // Host/router worker banners are useful in operator logs, not in a personal
  // chief-of-staff conversation. Strip every standalone banner line because a
  // resumed provider turn can insert one after an introductory sentence.
  return withoutFence
    .replace(/^\s*(?:\*\*)?(?:사용\s*(?:에이전트|스킬)|Agents used|Skills used)(?:\*\*)?\s*:\s*[^\n]*(?:\n[ \t]*)*/gim, "")
    .trim();
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
  const ko = locale === "ko";
  if (canonicalStatus === "partial") return ko ? "결과 확인" : "Review result";
  const labels: Record<OneTaskProjection["status"]["value"], [string, string]> = {
    waiting: ["대기", "Waiting"],
    working: ["작업 중", "Working"],
    decision_required: ["결정 필요", "Decision needed"],
    completed: ["완료", "Completed"],
    failed: ["실패", "Failed"],
    stopped: ["중단", "Stopped"],
  };
  return labels[status][ko ? 0 : 1];
}

function briefingSignature(briefing: ReturnType<typeof chooseOneBriefing>): string {
  return [briefing.kind, briefing.taskId ?? "none", briefing.evidence.join("|")].join(":");
}

function oneMemoryUseOnceTargetKey(target: OneMemoryUseOnceTarget): string {
  return [target.chatId, target.expectedTaskId ?? "conversation", target.expectedTaskVersion ?? "none"].join(":");
}

function proactiveBriefingView(candidate: OneProactiveBriefing, locale: "ko" | "en"): DisplayBriefing {
  const ko = locale === "ko";
  const source = candidate.source.label;
  const copy: Record<OneProactiveBriefing["reasonCode"], {
    eyebrow: [string, string];
    title: [string, string];
    body: [string, string];
    prepared: [string, string];
  }> = {
    project_folder_missing: {
      eyebrow: ["연결 확인", "Connection check"],
      title: [`${source}의 연결 폴더를 찾을 수 없어요.`, `${source}'s connected folder is unavailable.`],
      body: ["현재 파일을 확인할 수 없어 다음 결과가 오래된 맥락을 사용할 수 있습니다.", "The team cannot verify current files, so the next result could use stale context."],
      prepared: ["프로젝트 연결 화면을 준비했습니다. 파일과 폴더는 변경하지 않았어요.", "The project connection screen is ready. No file or folder was changed."],
    },
    project_folder_unreadable: {
      eyebrow: ["연결 확인", "Connection check"],
      title: [`${source}의 연결 폴더를 확인할 수 없어요.`, `${source}'s connected folder could not be verified.`],
      body: ["One이 이 폴더를 열 수 없어서 파일이 최신인지 확인하지 못했어요.", "One cannot open this folder, so it could not check whether the files are current."],
      prepared: ["프로젝트 연결 화면을 준비했고 원본은 건드리지 않았어요.", "The project connection screen is ready and the source was not changed."],
    },
    project_folder_not_directory: {
      eyebrow: ["연결 확인", "Connection check"],
      title: [`${source}에 연결된 위치가 더 이상 폴더가 아니에요.`, `${source}'s connected location is no longer a folder.`],
      body: ["올바른 폴더를 다시 고르면 One이 파일을 확인할 수 있어요.", "Choose the correct folder again so One can check the files."],
      prepared: ["연결을 다시 선택할 수 있는 프로젝트 화면을 준비했습니다.", "The project screen is ready for you to select the connection again."],
    },
    project_deadline_conflict: {
      eyebrow: ["마감 위험", "Deadline risk"],
      title: [`${source}의 마감이 가까운데 필요한 파일이 보이지 않아요.`, `${source}'s deadline is close, but a needed file is missing.`],
      body: ["내가 정한 마감이 가까워졌지만 One이 완성 파일을 찾지 못했어요.", "The deadline you set is close, but One could not find the finished file."],
      prepared: ["변경 없이 프로젝트 화면을 열 준비만 했어요. 파일이나 일정은 바꾸지 않았습니다.", "One only prepared the project screen. No file or schedule was changed."],
    },
    automation_error: {
      eyebrow: ["반복 작업 확인", "Repeated work check"],
      title: [`${source}가 끝까지 완료되지 않았어요.`, `${source} did not finish.`],
      body: ["같은 상태로 다시 시작하면 같은 문제가 생길 수 있어요.", "Starting again in the same state may cause the same problem."],
      prepared: ["무엇이 잘못됐는지 확인할 수 있도록 당시 기록을 그대로 남겨뒀어요.", "One kept the earlier record unchanged so you can see what went wrong."],
    },
    automation_blocked: {
      eyebrow: ["반복 작업 확인", "Repeated work check"],
      title: [`${source}가 끝나기 전에 멈췄어요.`, `${source} stopped before it finished.`],
      body: ["필요한 허용이나 정보가 무엇인지 먼저 확인해야 해요.", "First check which permission or information is missing."],
      prepared: ["멈춘 시점과 다음 예정 시간을 함께 볼 수 있게 준비했어요.", "The stopped point and next planned time are ready to review together."],
    },
    automation_needs_input: {
      eyebrow: ["결정 필요", "Decision needed"],
      title: [`${source}가 내 답을 기다리고 있어요.`, `${source} is waiting for your answer.`],
      body: ["내가 확인하기 전에는 다음 단계로 넘어가지 않아요.", "It will not continue until you review it."],
      prepared: ["지금까지 한 일과 반복 설정을 함께 볼 수 있게 준비했어요.", "The work so far and its repeat settings are ready to review together."],
    },
    automation_partial: {
      eyebrow: ["부분 완료", "Partial result"],
      title: [`${source}가 일부만 마쳤어요.`, `${source} finished only part of the work.`],
      body: ["남은 일을 확인하기 전에는 모두 끝났다고 표시하지 않아요.", "One will not say everything is done until the remaining work is checked."],
      prepared: ["지금까지 나온 결과와 진행 기록을 그대로 남겨뒀어요.", "One kept the result so far and its progress record unchanged."],
    },
    task_waiting_decision_stale: {
      eyebrow: ["결정 대기", "Decision waiting"],
      title: [`${source}가 하루 넘게 결정을 기다리고 있어요.`, `${source} has been waiting for a decision for over a day.`],
      body: ["답하지 않은 결정을 확인하기 전에는 이 일을 안전하게 진행할 수 없습니다.", "This work cannot safely advance until the unanswered decision is reviewed."],
      prepared: ["바뀌지 않은 현재 상태를 열 준비만 했습니다.", "One prepared the exact current state for review only."],
    },
    task_running_without_active_run: {
      eyebrow: ["진행 확인", "Progress check"],
      title: [`${source}가 일하는 중으로 보이지만 실제로는 멈춰 있어요.`, `${source} looks busy, but it is no longer running.`],
      body: ["다시 시작하기 전에 어디에서 멈췄는지 확인하는 것이 좋아요.", "Check where it stopped before starting again."],
      prepared: ["다시 시작하지 않고 현재 상태와 기록만 볼 수 있게 준비했어요.", "The current state and record are ready to review without starting anything."],
    },
    task_failed_repeated: {
      eyebrow: ["반복 실패", "Repeated failure"],
      title: [`${source}에서 같은 문제가 여러 번 생겼어요.`, `${source} ran into the same problem more than once.`],
      body: ["지금 그대로 다시 하면 같은 문제가 생길 가능성이 높아요.", "Trying again without changes may cause the same problem."],
      prepared: ["복잡한 오류 문구 대신 문제가 난 일을 바로 확인할 수 있게 준비했어요.", "One prepared the affected work without showing a technical error message."],
    },
    task_failed_abandoned: {
      eyebrow: ["미해결 실패", "Unresolved failure"],
      title: [`${source} 실패가 3일 넘게 그대로예요.`, `${source} has remained failed for over three days.`],
      body: ["실패 결과가 완료된 작업으로 오해되지 않도록 확인이 필요합니다.", "Review it so the failed outcome is not mistaken for completed work."],
      prepared: ["문제가 난 시점의 상태를 변경 없이 볼 수 있게 준비했어요.", "The state from when the problem happened is ready to review without changes."],
    },
    task_partial_abandoned: {
      eyebrow: ["부분 완료", "Partial result"],
      title: [`${source}의 부분 완료 상태가 3일 넘게 그대로예요.`, `${source} has remained partially complete for over three days.`],
      body: ["남은 일은 아직 끝났는지 확인되지 않았어요.", "The remaining work has not been confirmed as complete."],
      prepared: ["현재 상태와 마지막 진행 기록을 변경 없이 확인할 수 있어요.", "The current state and latest progress record can be reviewed unchanged."],
    },
  };
  const selected = copy[candidate.reasonCode];
  const evidence = [
    `${ko ? "출처" : "Source"}: ${source}`,
    `${ko ? "확인 시각" : "Observed"}: ${formatTimestamp(candidate.detectedAt, locale)}`,
    `${ko ? "확신도" : "Confidence"}: ${candidate.confidence.level === "high" ? (ko ? "높음" : "High") : candidate.confidence.level === "medium" ? (ko ? "중간" : "Medium") : (ko ? "낮음" : "Low")}`,
    `${ko ? "확인 범위" : "Scope"}: ${candidate.reasonCode === "project_deadline_conflict" ? (ko ? "사용자가 직접 설정한 마감과 예상 파일의 존재 정보만 확인, 경로·파일 내용 미노출" : "Only the user-provided deadline and expected relative file presence metadata; path and file contents excluded") : candidate.source.kind === "project_folder" ? (ko ? "사용자가 연결한 폴더의 존재·접근 상태만 확인, 파일 내용 미열람" : "Only the user-connected folder's existence and access state; file contents were not read") : candidate.source.kind === "automation_run" ? (ko ? "확인된 자동 작업 기록만 사용, 자세한 오류 내용 제외" : "Only confirmed scheduled-work history; detailed error text excluded") : (ko ? "확인된 일의 상태, 현재 진행 여부, 완료·중단 기록" : "Confirmed work state, current activity, and completion or stop history")}`,
  ];
  return {
    kind: candidate.reasonCode === "automation_needs_input" ? "decision" : "failed",
    eyebrow: selected.eyebrow[ko ? 0 : 1],
    title: selected.title[ko ? 0 : 1],
    body: selected.body[ko ? 0 : 1],
    prepared: selected.prepared[ko ? 0 : 1],
    evidence,
    primaryLabel: candidate.decision.acceptLabel && ko
      ? candidate.preparedAction.kind === "open_project" ? "프로젝트 열기" : candidate.preparedAction.kind === "open_automation" ? "자동화 검토" : "일 열기"
      : candidate.decision.acceptLabel,
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
  const [oneActivationState, setOneActivationState] = useState<OneActivationState | null>(null);
  const [briefingSnapshot, setBriefingSnapshot] = useState<OneBriefingSnapshot | null>(null);
  const [briefingActionPacket, setBriefingActionPacket] = useState<OneBriefingActionPacket | null>(null);
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
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dismissedBriefing, setDismissedBriefing] = useState<{ signature: string; expiresAt: number } | null>(null);
  const [introReplayToken, setIntroReplayToken] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const configuredOneLocale = oneProfile?.preferredLocale === "ko" || oneProfile?.preferredLocale === "en"
    ? oneProfile.preferredLocale
    : appLocale;
  const recentLocaleFallback = useMemo(() => inferOneRecentContextLocale([
    ...conversations.map((item) => ({ text: item.title, updatedAt: item.updatedAt })),
    ...projections.map((item) => ({ text: item.display.title, updatedAt: item.status.asOf })),
  ], configuredOneLocale), [configuredOneLocale, conversations, projections]);
  const activeContextLocale = detectOneTextLocale(selected?.display.title ?? conversation?.title ?? "")
    ?? recentLocaleFallback;
  const normalizedLocale = useMemo(
    () => detectOneTextLocale(pendingTeamPrompt?.text ?? "") ?? inferOneConversationLocale(messages, activeContextLocale),
    [activeContextLocale, messages, pendingTeamPrompt?.text],
  );
  // Controls follow the explicit app language. Conversation content still
  // detects the language of the active request through normalizedLocale.
  const ko = appLocale === "ko";
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
      setBriefingActionPacket(null);
      return;
    }
    try {
      const [active, pending, update, mobile, recentChats, profile, memory, suggestions, valueClosures, weeklyReflection, experienceReuse, improvementProofs, proactiveBriefing, intro, activation] = await Promise.all([
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
      const safeProactiveBriefing = safeBriefingSnapshot(proactiveBriefing);
      setBriefingSnapshot(safeProactiveBriefing);
      const currentBriefingAction = safeProactiveBriefing?.candidate
        ? await api.oneBriefing.getAction({
            candidateId: safeProactiveBriefing.candidate.candidateId,
            expectedDetectedAt: safeProactiveBriefing.candidate.detectedAt,
          }).catch(() => null)
        : null;
      setBriefingActionPacket(currentBriefingAction);
      setProjections(items);
      setConversations(recentChats.filter((chat) => !chat.taskId));
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
      if (event.status) setRunStatus(event.agentName ? `${event.agentName} · ${event.status}` : event.status);
      return;
    }
    if (event.kind === "thinking" || event.kind === "tool-use") {
      if (!taskId && event.kind === "tool-use") void reconcileConversationTask(chatId);
      if (event.status && !/scope-lock|stormbreaker loop|agentlas 오케스트레이터/i.test(event.status)) {
        setRunStatus(event.status);
      }
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
      const message = event.error?.message || (ko ? "실행이 완료 전에 멈췄습니다." : "The run stopped before completion.");
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
  }, [ko, reconcileConversationTask, scrollToLatest, settleRun]);

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
        setRunStatus(ko ? "실행 상태를 다시 연결했습니다." : "Reconnected to the active run.");
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
  }, [conversation?.id, ko, selected?.chatId, selected?.latestReceipt, selected?.taskId, subscribeRun]);

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
    const runKo = runLocale === "ko";
    if (!api || !events) throw new Error(runKo ? "Desktop 실행 연결을 찾을 수 없습니다." : "Desktop execution is unavailable.");
    const runId = options?.runId ?? uid();
    runIdRef.current = runId;
    runTaskIdRef.current = taskId;
    runChatIdRef.current = chatId;
    streamTextRef.current = "";
    setBusy(true);
    setSurface(null);
    setError(null);
    setRunStatus(taskIntent === "conversation"
      ? (runKo ? "답변을 준비하고 있어요." : "Preparing a response.")
      : (runKo ? "요청을 이해하고 팀을 준비하고 있어요." : "Understanding the request and preparing the team."));
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
        permissions: taskIntent === "conversation" ? "read" : "write",
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
      setError(detectOneTextLocale(prompt.text) === "ko"
        ? "일을 시작하는 중 문제가 생겼어요. 같은 요청을 다시 한번 보내주세요."
        : "Something went wrong while starting the work. Please send the same request once more.");
    } finally {
      if (autoResolvingProposalRef.current === proposal.proposalId) autoResolvingProposalRef.current = null;
      setTeamPreflightBusy(false);
    }
  }, [router, startRun]);

  useEffect(() => {
    if (
      !teamPreflight
      || !pendingTeamPrompt
      || pendingTeamPrompt.proposalId !== teamPreflight.proposalId
      || !["proposed", "blocked", "deferred", "team_reserved", "solo_reserved"].includes(teamPreflight.status)
      || busy
    ) return;
    void autoStartTeamPreflight(teamPreflight, pendingTeamPrompt, true);
  }, [autoStartTeamPreflight, busy, pendingTeamPrompt, teamPreflight]);

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
    const value = explicitValue || (ko
      ? `첨부 파일 ${attachmentSnapshot.length}개를 검토하고 핵심 결과를 만들어주세요.`
      : `Review the ${attachmentSnapshot.length} attached file${attachmentSnapshot.length === 1 ? "" : "s"} and produce the key result.`);
    const api = ipc();
    if (!api) {
      setError(ko ? "Agentlas Desktop에 연결되지 않았습니다." : "Agentlas Desktop is not connected.");
      return;
    }
    const canContinueFromResult = Boolean(
      selected?.chatId && (selected.canonicalStatus === "partial" || selected.canonicalStatus === "completed"),
    );
    if (selected && (!selected.chatId || (!selected.truth.mayStartExecution && !canContinueFromResult))) {
      setError(ko
        ? "이 일은 지금 One에서 이어갈 수 없습니다. Work에서 현재 상태와 권한을 확인해주세요."
        : "This work cannot continue in One right now. Open Work to review its current state and permissions.");
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
        if (canContinueFromResult) {
          const chat = await api.tasks.continueFromResult({
            taskId: selected.taskId,
            expectedVersion: selected.canonicalVersion,
            userPrompt: value,
          });
          const history = await api.invoke.history(chat.id).catch(() => []);
          selectedTaskIdRef.current = null;
          selectedConversationIdRef.current = chat.id;
          setSelected(null);
          setConversation(chat);
          setMessages(toUiMessages(history));
          setSurface(null);
          setReceipt(null);
          setCommittedAnswers([]);
          setTeamPreflight(null);
          setPendingTeamPrompt(null);
          router.replace(`/one?chat=${encodeURIComponent(chat.id)}`);
          await resolveActivationConcern(chat.id);
          await prepareOrRun(chat.id, null, null, "conversation");
          return;
        }
        await prepareOrRun(selected.chatId, selected.taskId, selected.canonicalVersion, "task");
        return;
      }
      if (conversation) {
        await resolveActivationConcern(conversation.id);
        await prepareOrRun(conversation.id, null, null, "conversation");
        return;
      }
      const chat = await api.chats.create({ title: value.split(/\r?\n/)[0].slice(0, 72), taskMode: "conversation" });
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
  }, [autoStartTeamPreflight, busy, clearAttachmentDrafts, conversation, ko, recurrenceSelection, resolveActivationConcern, router, scrollToLatest, selected, startRun, teamPreflight, teamPreflightBusy]);

  const stopRun = useCallback(() => {
    const api = ipc();
    const runId = runIdRef.current;
    if (!api || !runId) return;
    setRunStatus(ko ? "안전하게 중단하고 있어요." : "Stopping safely.");
    void api.invoke.cancel(runId);
  }, [ko]);

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
    setEvidenceOpen(false);
    router.push(`/one?task=${encodeURIComponent(taskId)}`);
  }, [router]);

  const openConversation = useCallback((chatId: string) => {
    setRailOpen(false);
    setSearchOpen(false);
    setEvidenceOpen(false);
    router.push(`/one?chat=${encodeURIComponent(chatId)}`);
  }, [router]);

  const mutateTaskArchive = useCallback(async (taskId: string, operation: "archive" | "restore") => {
    const api = ipc();
    if (!api?.oneSearch || archiveMutationTaskId) return;
    setArchiveMutationTaskId(taskId);
    setSearchError(null);
    try {
      const initialTask = await api.tasks.get(taskId);
      if (!initialTask?.originChatId) throw new Error(ko ? "이 일의 원래 대화를 찾을 수 없습니다." : "The original conversation for this work is unavailable.");
      const chat = await api.chats.get(initialTask.originChatId);
      const task = await api.tasks.get(taskId);
      if (!chat || !task || task.originChatId !== chat.id) {
        throw new Error(ko ? "일과 대화의 연결이 바뀌었습니다. 현재 상태를 다시 확인해주세요." : "The work and conversation binding changed. Review the current state.");
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
  }, [archiveMutationTaskId, ko, query, refreshAll, requestOneSearch, router, searchIncludeArchived, searchOpen]);

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
    ? (ko ? "연결 끊김" : "Disconnected")
    : connectedMobile
      ? (ko ? "Mobile 연결됨" : "Mobile connected")
      : (ko ? "Desktop 준비됨" : "Desktop ready");
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
  const introEligible = loaded && oneIntroPending && introBlockingCategory === null;
  const workHref = selected?.chatId
    ? `/chat?id=${encodeURIComponent(selected.chatId)}&task=${encodeURIComponent(selected.taskId)}`
    : "/dashboard";
  const openWork = useCallback(async () => {
    const api = ipc();
    if (api && selected && await openOneTaskInWork(api, selected.taskId)) return;
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
  const selectedCanContinueFromResult = Boolean(
    selected?.chatId && (selected.canonicalStatus === "partial" || selected.canonicalStatus === "completed"),
  );
  const selectedReadOnly = Boolean(
    selected && (!selected.chatId || (!selected.truth.mayStartExecution && !selectedCanContinueFromResult)),
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
      setAttachmentError(ko
        ? "실행 또는 팀 검토가 끝난 뒤 새 요청에 파일을 첨부해주세요. 실행 중 지시에는 v1 첨부를 넣지 않습니다."
        : "Attach files to a new request after the run or team review. v1 never adds attachments to in-flight steering.");
      return;
    }
    const incoming = Array.from(files);
    const current = attachmentDraftsRef.current;
    if (current.length + incoming.length > ONE_ATTACHMENT_LIMITS.maxCount) {
      setAttachmentError(ko
        ? `한 요청에는 최대 ${ONE_ATTACHMENT_LIMITS.maxCount}개까지 첨부할 수 있습니다.`
        : `A request can include at most ${ONE_ATTACHMENT_LIMITS.maxCount} attachments.`);
      return;
    }
    const next: OneAttachmentDraft[] = [];
    let totalBytes = current.reduce((sum, item) => sum + item.size, 0);
    const errors: string[] = [];
    for (const file of incoming) {
      const kind = attachmentKind(file);
      const perFileLimit = kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes;
      if (file.size > perFileLimit) {
        errors.push(ko
          ? `${file.name}: ${kind === "image" ? "이미지 5 MB" : "파일 64 MB"} 한도를 넘습니다.`
          : `${file.name}: exceeds the ${kind === "image" ? "5 MB image" : "64 MB file"} limit.`);
        continue;
      }
      if (totalBytes + file.size > ONE_ATTACHMENT_LIMITS.maxTotalBytes) {
        errors.push(ko ? `${file.name}: 전체 96 MB 한도를 넘습니다.` : `${file.name}: exceeds the 96 MB total limit.`);
        continue;
      }
      const grant = await grantForDroppedFile(file);
      if (!grant || grant.kind !== "file") {
        errors.push(ko ? `${file.name}: 일반 파일로 확인할 수 없습니다.` : `${file.name}: could not be verified as a regular file.`);
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
  }, [busy, ko, selectedReadOnly, teamDecisionPending, teamPreflightBusy]);

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
  const openPreparedFinding = useCallback((candidate: OneProactiveBriefing) => {
    setEvidenceOpen(false);
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
  const prepareBriefingReview = useCallback(async (candidate: OneProactiveBriefing) => {
    const api = ipc();
    if (!api || briefingActionBusy) return;
    if (briefingActionPacket?.status === "started" && briefingActionPacket.task) {
      router.push(`/one?task=${encodeURIComponent(briefingActionPacket.task.taskId)}`);
      return;
    }
    setBriefingActionBusy(true);
    setError(null);
    try {
      const packet = await api.oneBriefing.prepareAction({
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
      });
      setBriefingActionPacket(packet);
      setEvidenceOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [briefingActionBusy, briefingActionPacket, refreshAll, router]);
  const startBriefingReview = useCallback(async (candidate: OneProactiveBriefing) => {
    const api = ipc();
    const packet = briefingActionPacket;
    if (!api || !packet || briefingActionBusy) return;
    if (packet.status === "started" && packet.task) {
      router.push(`/one?task=${encodeURIComponent(packet.task.taskId)}`);
      return;
    }
    setBriefingActionBusy(true);
    setError(null);
    try {
      const result = await api.oneBriefing.startAction({
        packetId: packet.packetId,
        expectedPacketVersion: packet.version,
        candidateId: candidate.candidateId,
        expectedDetectedAt: candidate.detectedAt,
        confirmedByUser: true,
      });
      setBriefingActionPacket(result.packet);
      if (result.ok && result.packet.task) {
        router.push(`/one?task=${encodeURIComponent(result.packet.task.taskId)}`);
        await refreshAll();
        return;
      }
      const copy: Record<string, string> = {
        candidate_changed: ko ? "알림 내용이 바뀌었어요. 최신 내용을 다시 확인해주세요." : "This notice changed. Review the latest information before starting.",
        source_mismatch: ko ? "확인할 정보가 바뀌어 시작하지 않았어요. 최신 내용을 다시 열어주세요." : "The information changed, so One did not start. Open the latest notice and try again.",
        suppressed_or_resolved: ko ? "이미 해결됐거나 더 이상 필요하지 않아 시작하지 않았어요." : "This was already resolved or is no longer needed, so One did not start.",
        expired: ko ? "준비 시간이 지났어요. 최신 알림을 다시 열어주세요." : "This preparation expired. Open the latest notice and try again.",
        task_creation_failed: ko ? "일을 준비하는 중 문제가 생겼어요. 기존 진행 상황을 확인해주세요." : "One could not prepare the work. Check the existing progress before trying again.",
        start_rejected: ko ? "살펴보기를 시작하지 못했어요. 같은 일에서 다시 시도할 수 있습니다." : "One could not start the review. You can try again on the same work.",
        recovery_required: ko ? "중복 실행을 막기 위해 자동 재시도하지 않았습니다. Work에서 상태를 확인해주세요." : "One did not auto-retry, to prevent duplicate work. Review the state in Work.",
      };
      const message = copy[result.errorCategory ?? "start_rejected"];
      await refreshAll();
      setError(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshAll();
    } finally {
      setBriefingActionBusy(false);
    }
  }, [briefingActionBusy, briefingActionPacket, ko, refreshAll, router]);
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
      setEvidenceOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshAll();
    }
  }, [refreshAll]);
  const updateBriefingCadence = useCallback(async (cadence: OneBriefingCadence) => {
    const api = ipc();
    if (!api) return;
    setError(null);
    try {
      const preferences = await api.oneBriefing.setPreferences({ cadence });
      setBriefingSnapshot((current) => current ? { ...current, preferences } : current);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refreshAll]);
  const updateBriefingChannels = useCallback(async (desktopEnabled: boolean) => {
    const api = ipc();
    if (!api) return;
    setError(null);
    try {
      const preferences = await api.oneBriefing.setPreferences({
        channels: desktopEnabled ? ["in_app", "desktop_notification"] : ["in_app"],
      });
      setBriefingSnapshot((current) => current ? { ...current, preferences } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  const updateBriefingQuietHours = useCallback(async (quietHours: OneBriefingSnapshot["preferences"]["quietHours"]) => {
    const api = ipc();
    if (!api) return;
    setError(null);
    try {
      const preferences = await api.oneBriefing.setPreferences({ quietHours });
      setBriefingSnapshot((current) => current ? { ...current, preferences } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

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
    return <div className={styles.shell}><div className={styles.loading} role="status">{ko ? "One을 준비하고 있어요…" : "Preparing One…"}</div></div>;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.body} data-rail-collapsed={railCollapsed ? "true" : "false"}>
        {railOpen && <button type="button" className={styles.railScrim} aria-label={ko ? "최근 기록 닫기" : "Close recent history"} onClick={() => setRailOpen(false)} />}
        <aside className={styles.rail} data-open={railOpen ? "true" : "false"} aria-label={ko ? "최근 대화와 맡긴 일" : "Recent conversations and work"}>
          <div className={`${styles.railProduct} titlebar-nodrag`}>
            <ProductModeMenu current="one" darkText locale={appLocale} />
            <button
              type="button"
              className={styles.railCollapseButton}
              aria-label={ko ? "사이드바 접기" : "Collapse sidebar"}
              onClick={() => { setRailCollapsed(true); setRailOpen(false); }}
            >‹</button>
          </div>
          <div className={styles.railPrimaryActions}>
            <button type="button" className={styles.railPrimaryButton} onClick={() => router.push("/one")}><span aria-hidden="true">＋</span>{ko ? "새 대화" : "New conversation"}</button>
            <button ref={searchTriggerRef} type="button" className={styles.railPrimaryButton} onClick={() => setSearchOpen(true)}><span aria-hidden="true">⌕</span>{ko ? "전체 기록 찾기" : "Search all history"}</button>
            <button type="button" className={styles.railPrimaryButton} onClick={() => router.push("/one")}>
              <span aria-hidden="true">◉</span>{ko ? "지금" : "Now"}
              {actionableConfirmations.length > 0 && <span className={styles.railCount}>{actionableConfirmations.length}</span>}
            </button>
          </div>
          <div className={styles.railTop}><strong>{ko ? "최근" : "Recent"}</strong></div>
          <div className={styles.railList}>
            {conversations.length > 0 && <p className={styles.railSectionLabel}>{ko ? "일반 대화" : "Conversations"}</p>}
            {conversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} />)}
            {projections.length > 0 && <p className={styles.railSectionLabel}>{ko ? "맡긴 일" : "Work"}</p>}
            {projections.map((item) => <TaskListButton key={item.taskId} item={item} active={item.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />)}
            {projections.length === 0 && conversations.length === 0 && <div className={styles.railEmpty}>{ko ? "아직 대화나 맡긴 일이 없습니다." : "No conversations or delegated work yet."}</div>}
          </div>
          <div className={styles.railFooter}>
            {selected && <nav className={`${styles.railUtilities} ${styles.railTaskActions}`} aria-label={ko ? "현재 일 관리" : "Manage current task"}>
              <button type="button" onClick={() => void openWork()}>{ko ? "이 일을 Work에서 보기" : "Open this work in Work"}<span aria-hidden="true">↗</span></button>
              <button
                type="button"
                disabled={archiveMutationTaskId === selected.taskId || Boolean(selected.chatId && activeChatIds.includes(selected.chatId))}
                onClick={() => void mutateTaskArchive(selected.taskId, selected.canonicalStatus === "archived" ? "restore" : "archive")}
              >
                {archiveMutationTaskId === selected.taskId
                  ? (ko ? "상태 확인 중…" : "Checking…")
                  : selected.canonicalStatus === "archived"
                    ? (ko ? "보관함에서 꺼내기" : "Restore from archive")
                    : (ko ? "이 일 보관하기" : "Archive this work")}
              </button>
            </nav>}
            <nav className={styles.railUtilities} aria-label={ko ? "One 설정과 제품" : "One settings and products"}>
              <button type="button" onClick={() => { setMemoryOpen(false); setProfileOpen(true); }}>{oneDisplayName}</button>
              <button type="button" onClick={() => { setProfileOpen(false); setMemoryOpen(true); }}>
                {ko ? "기억" : "Memory"}
                {oneMemory && oneMemory.candidates.some((candidate) => candidate.status === "pending") && <span className={styles.railCount}>{oneMemory.candidates.filter((candidate) => candidate.status === "pending").length}</span>}
              </button>
              <button type="button" onClick={() => setPref(appLocale === "ko" ? "en" : "ko")}>
                <span>{ko ? "언어" : "Language"}</span>
                <span>{ko ? "English로 보기" : "한국어로 보기"}</span>
              </button>
              <button type="button" disabled={activationForeground} onClick={() => setIntroReplayToken((value) => value + 1)}>{ko ? "One 소개" : "About One"}</button>
              <button type="button" onClick={() => void openWork()}>{ko ? "Work 열기" : "Open Work"}<span aria-hidden="true">↗</span></button>
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
              aria-label={ko ? "사이드바 열기" : "Open sidebar"}
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
                    <h1 id="one-first-run-title">{ko ? "신경 쓰이는데 미루고 있는 일 하나를 말해주세요." : "Tell One about one thing you keep putting off."}</h1>
                    <p>{ko ? "생각나는 대로 말하세요. One이 필요한 기준을 정리하고, 일이 커지면 맞는 팀을 알아서 준비합니다." : "Say it however it comes to mind. One organizes the criteria and prepares the right team when the work grows."}</p>
                  </section>
                ) : (
                  <section className={styles.briefing} aria-labelledby="one-briefing-title">
                    <div className={styles.briefingOne}><OneBrandMark size="small" /><span>{oneDisplayName}</span></div>
                    <p className={styles.briefingEyebrow}>{briefing.eyebrow}</p>
                    <h1 id="one-briefing-title">{briefing.title}</h1>
                    <p className={styles.briefingBody}>{briefing.body}</p>
                    {briefing.prepared && <p className={styles.prepared}>{briefing.prepared}</p>}
                    <div className={styles.briefingActions}>
                      {briefing.proactive
                        ? briefing.proactive.preparedAction.kind === "open_task"
                          ? <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void openProactiveTask(briefing.proactive!)}>{briefingActionBusy ? (ko ? "확인 중…" : "Checking…") : briefing.primaryLabel}</button>
                          : briefingActionPacket && ["prepared", "task_ready", "start_failed"].includes(briefingActionPacket.status)
                          ? <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void startBriefingReview(briefing.proactive!)}>{briefingActionBusy ? (ko ? "확인 중…" : "Checking…") : (ko ? "변경 없이 살펴보기" : "Review without changes")}</button>
                          : briefingActionPacket?.status === "started" && briefingActionPacket.task
                            ? <button type="button" className={styles.primaryButton} onClick={() => openTask(briefingActionPacket.task!.taskId)}>{ko ? "검토한 내용 열기" : "Open the review"}</button>
                            : briefingActionPacket && ["task_reserved", "start_reserved"].includes(briefingActionPacket.status)
                              ? <button type="button" className={styles.primaryButton} disabled>{briefingActionPacket.status === "task_reserved" ? (ko ? "현재 상태 확인 중…" : "Checking current state…") : (ko ? "검토 시작 중…" : "Starting review…")}</button>
                            : briefingActionPacket?.status === "recovery_required"
                              ? <button type="button" className={styles.primaryButton} disabled>{ko ? "이어가기 확인 필요" : "Check before continuing"}</button>
                              : <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void prepareBriefingReview(briefing.proactive!)}>{briefingActionBusy ? (ko ? "준비 중…" : "Preparing…") : (ko ? "안전하게 살펴보기" : "Review safely")}</button>
                        : briefing.taskId && <button type="button" className={styles.primaryButton} onClick={() => openTask(briefing.taskId!)}>{briefing.primaryLabel}</button>}
                      {briefing.proactive && briefing.proactive.preparedAction.kind !== "open_task" && <button type="button" className={styles.ghostButton} onClick={() => openPreparedFinding(briefing.proactive!)}>{briefing.primaryLabel}</button>}
                      {briefing.evidence.length > 0 && <button type="button" className={styles.ghostButton} aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen((value) => !value)}>{ko ? "확인한 이유" : "Why One noticed this"}</button>}
                      {briefing.kind !== "quiet" && (briefing.proactive
                        ? <button type="button" className={styles.ghostButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "later")}>{ko ? "나중에" : "Later"}</button>
                        : <button type="button" className={styles.ghostButton} onClick={() => { const signature = briefingSignature(briefing); setDismissedBriefing({ signature, expiresAt: writeBriefingDismissal(signature) }); setEvidenceOpen(false); }}>{ko ? "이번에는 넘기기" : "Dismiss for now"}</button>)}
                    </div>
                    {briefing.proactive && briefingActionPacket && <div className={styles.briefingReviewPacket} data-status={briefingActionPacket.status}>
                      <div>
                        <strong>{briefingActionPacket.status === "started" ? (ko ? "One이 살펴보고 있어요" : "One is reviewing this") : (ko ? "변경 없이 확인할 준비가 됐어요" : "Ready to review without changes")}</strong>
                        <span>{ko ? "파일이나 설정은 바꾸지 않아요" : "Files and settings stay unchanged"}</span>
                      </div>
                      <p>{briefing.proactive?.source.kind === "canonical_task"
                        ? (ko ? "현재 진행 상황을 보기만 합니다. 새로운 실행이나 수정은 시작하지 않아요." : "One only reviews the current progress. It does not start new work or make changes.")
                        : briefingActionPacket.status === "prepared"
                        ? (ko ? "아직 일을 시작하지 않았어요. 확인을 누르면 최신 정보인지 한 번 더 살펴봅니다." : "No work has started. After you confirm, One checks that the information is still current.")
                        : briefingActionPacket.status === "recovery_required"
                          ? (ko ? "중단 지점 이후 같은 일을 중복으로 만들지 않았습니다. Work에서 기존 상태를 확인해야 합니다." : "One did not duplicate the work after an interruption. Review the existing state in Work.")
                          : (ko ? "원본 파일과 자동화 설정을 바꾸지 않고 검토합니다." : "This review does not change source files or automation settings.")}</p>
                      <details className={styles.briefingPacketDetails}>
                        <summary>{ko ? "무엇을 확인했나요?" : "What did One check?"}</summary>
                        <div className={styles.briefingPacketMeta}>
                          <span>{briefing.proactive?.source.kind === "canonical_task"
                            ? (ko ? "현재 진행 상황" : "Current progress")
                            : briefingActionPacket.source.kind === "project_folder"
                              ? (ko ? "연결된 폴더 상태" : "Connected folder status")
                              : (ko ? "최근 자동 실행 기록" : "Recent automatic-run record")}</span>
                          <span>{briefingActionPacket.executionStarted ? (ko ? "살펴보기 시작됨" : "Review started") : (ko ? "아직 시작 안 함" : "Not started")}</span>
                        </div>
                      </details>
                    </div>}
                    {evidenceOpen && <div className={styles.evidenceList}>
                      {briefing.evidence.map((item) => <span key={item}>{item}</span>)}
                      {briefing.proactive && <div className={styles.briefingCorrections}>
                        <label>
                          <span>{ko ? "알림 빈도" : "Notice frequency"}</span>
                          <select
                            value={briefingSnapshot?.preferences.cadence ?? "important_only"}
                            onChange={(event) => void updateBriefingCadence(event.target.value as OneBriefingCadence)}
                            aria-label={ko ? "알림 빈도 선택" : "Select notice frequency"}
                          >
                            <option value="important_only">{ko ? "중요할 때만" : "Important only"}</option>
                            <option value="daily">{ko ? "매일" : "Daily"}</option>
                            <option value="weekdays">{ko ? "평일" : "Weekdays"}</option>
                            <option value="weekly">{ko ? "주간" : "Weekly"}</option>
                          </select>
                        </label>
                        <label>
                          <span>{ko ? "앱에서 알려주기" : "Show notices in the app"}</span>
                          <input type="checkbox" checked disabled aria-label={ko ? "앱에서 알려주기 켜짐" : "In-app notices enabled"} />
                        </label>
                        <label>
                          <span>{ko ? "데스크탑 알림" : "Desktop notification"}</span>
                          <input
                            type="checkbox"
                            checked={briefingSnapshot?.preferences.channels.includes("desktop_notification") ?? false}
                            onChange={(event) => void updateBriefingChannels(event.target.checked)}
                            aria-label={ko ? "데스크탑 알림 사용" : "Enable desktop notifications"}
                          />
                        </label>
                        <label>
                          <span>{ko ? "조용한 시간" : "Quiet hours"}</span>
                          <input
                            type="checkbox"
                            checked={briefingSnapshot?.preferences.quietHours.enabled ?? false}
                            onChange={(event) => {
                              const quiet = briefingSnapshot?.preferences.quietHours ?? { enabled: false, startHour: 22, endHour: 8 };
                              void updateBriefingQuietHours({ ...quiet, enabled: event.target.checked });
                            }}
                            aria-label={ko ? "조용한 시간 사용" : "Enable quiet hours"}
                          />
                        </label>
                        <label>
                          <span>{ko ? "시작" : "Start"}</span>
                          <select
                            value={briefingSnapshot?.preferences.quietHours.startHour ?? 22}
                            onChange={(event) => {
                              const quiet = briefingSnapshot?.preferences.quietHours ?? { enabled: false, startHour: 22, endHour: 8 };
                              void updateBriefingQuietHours({ ...quiet, startHour: Number(event.target.value) });
                            }}
                            aria-label={ko ? "조용한 시간 시작" : "Quiet hours start"}
                          >{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select>
                        </label>
                        <label>
                          <span>{ko ? "종료" : "End"}</span>
                          <select
                            value={briefingSnapshot?.preferences.quietHours.endHour ?? 8}
                            onChange={(event) => {
                              const quiet = briefingSnapshot?.preferences.quietHours ?? { enabled: false, startHour: 22, endHour: 8 };
                              void updateBriefingQuietHours({ ...quiet, endHour: Number(event.target.value) });
                            }}
                            aria-label={ko ? "조용한 시간 종료" : "Quiet hours end"}
                          >{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select>
                        </label>
                        <label title={ko ? "휴대폰 알림은 아직 준비 중입니다." : "Phone notifications are still being prepared."}>
                          <span>{ko ? "휴대폰 알림 · 준비 중" : "Phone notifications · Coming later"}</span>
                          <input type="checkbox" checked={false} disabled aria-label={ko ? "휴대폰 알림 준비 중" : "Phone notifications coming later"} />
                        </label>
                        <button type="button" className={styles.textButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "not_important")}>{ko ? "이 유형은 덜 알려주세요" : "Show less like this"}</button>
                        <button type="button" className={styles.textButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "wrong")}>{ko ? "이 판단은 틀렸어요" : "This judgment is wrong"}</button>
                      </div>}
                    </div>}
                  </section>
                )}
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
                  <aside className={styles.prepared} aria-label={ko ? "이번 일에 참여한 전문가" : "Experts on this work"}>
                    <span>{ko ? "이번 일의 팀" : "Team for this work"}</span>
                    {selected.chat.hiredAgents.map((item) => <strong key={item.slug}>{item.name || item.slug}</strong>)}
                  </aside>
                ) : null}
                <section className={styles.messages} aria-label={selected ? (ko ? "맡긴 일의 대화" : "Work conversation") : (ko ? "일반 대화" : "General conversation")} aria-live="polite">
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
                      <strong>{ko ? "이 일을 어떻게 맡을지 살펴보고 있어요." : "One is deciding how to handle this."}</strong>
                      <span>{ko ? "필요한 준비는 One이 알아서 끝내고 바로 시작할게요." : "One will handle the preparation and start right away."}</span>
                    </div>
                  )}
                  {messages.length === 0 && !teamPreflightBusy && !teamPreflight && <div className={styles.emptyThread}>{selected ? (ko ? "이 일에는 아직 대화가 없습니다." : "This work has no conversation yet.") : (ko ? "대화를 시작해주세요." : "Start the conversation.")}</div>}
                </section>
                {teamPreflight && ["workforce_reserved", "recovery_required"].includes(teamPreflight.status) && !teamPreflightBusy && !busy && (
                  <p className={styles.teamPreflightRecovery} role="status">
                    {ko ? "이 요청은 안전하게 이어갈 수 없어서 멈췄어요. 같은 내용을 다시 보내주세요." : "This request could not continue safely. Please send the same request again."}
                  </p>
                )}
                {busy && (
                  <section className={styles.runProgress} role="status" aria-live="polite" aria-label={ko ? "One 작업 진행" : "One work progress"}>
                    <OneBrandMark size="thinking" thinking />
                    <strong>{oneRunStageLabel(runProgress.current, appLocale)}</strong>
                    <small>
                      {runProgress.participantNames.length > 0
                        ? (ko ? `${runProgress.participantNames.join(" · ")}가 실제로 참여 중` : `${runProgress.participantNames.join(" · ")} actively participating`)
                        : (ko ? "One이 직접 진행 중" : "One is working directly")}
                    </small>
                    {runStatus && <span className={styles.runStatusDetail}>{runStatus}</span>}
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
                {ko ? "여기에 파일 놓기" : "Drop files here"}
              </div>
            )}
            {armedOneMemoryUseOnce && (
              <div className={styles.oneMemoryUseOnceChip} role="status">
                <span>{ko ? "Memory · 다음 요청에 1회 적용" : "Memory · applies once to the next request"}</span>
                <small>{ko ? `만료 ${formatTimestamp(armedOneMemoryUseOnce.receipt.expiresAt, appLocale)}` : `Expires ${formatTimestamp(armedOneMemoryUseOnce.receipt.expiresAt, appLocale)}`}</small>
                <button
                  type="button"
                  onClick={() => setArmedOneMemoryUseOnce(null)}
                  aria-label={ko ? "다음 요청에서 한 번만 Memory 제외" : "Exclude one-time Memory from the next request"}
                >×</button>
              </div>
            )}
            {attachmentDrafts.length > 0 && (
              <div className={styles.attachmentTray} aria-label={ko ? "선택한 첨부" : "Selected attachments"}>
                {attachmentDrafts.map((item) => (
                  <div key={item.id} className={styles.attachmentChip} data-kind={item.kind}>
                    {item.previewUrl
                      ? <img src={item.previewUrl} alt="" aria-hidden="true" />
                      : <span className={styles.attachmentFileIcon} aria-hidden="true">▤</span>}
                    <span className={styles.attachmentCopy}>
                      <strong>{item.name}</strong>
                      <small>{attachmentTypeLabel(item.mediaType, item.name)} · {attachmentSize(item.size)}</small>
                    </span>
                    <button type="button" onClick={() => removeAttachmentDraft(item.id)} aria-label={ko ? `${item.name} 첨부 제거` : `Remove ${item.name}`}>×</button>
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
              <span className={styles.composerLabel}>{ko ? "One에게 말하기" : "Message One"}</span>
              <textarea
                ref={composerInputRef}
                rows={1}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => handleComposerKey(event, busy ? stopRun : () => void submit(composer))}
                placeholder={oneActivationState?.status === "active" && oneActivationState.concern.status === "pending"
                  ? (ko ? "지금 신경 쓰이는 일 한 가지" : "One thing that is on your mind")
                  : selected
                  ? (ko ? "수정할 조건이나 다음 일을 말해주세요" : "Add a condition or the next step")
                  : conversation
                    ? (ko ? "편하게 이어가세요. 실행이 필요하면 One이 알아서 일로 전환합니다" : "Keep talking naturally. One turns it into work when execution is needed")
                    : (ko ? "무엇이 궁금하거나, 무엇을 맡기고 싶나요?" : "What are you wondering about, or what would you like to delegate?")}
                aria-label={ko ? "One에게 요청" : "Request for One"}
                disabled={selectedReadOnly || teamDecisionPending || teamPreflightBusy}
              />
              <div className={styles.composerBar}>
                <div className={styles.composerTools}>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                    onClick={() => attachmentInputRef.current?.click()}
                    aria-label={ko ? "파일 첨부" : "Attach files"}
                    title={ko ? "사진이나 파일 추가" : "Add photos or files"}
                  >
                    <IconPlus size={20} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.attachmentButton}
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                    aria-expanded={recurrencePanelOpen || recurrenceSelection !== null}
                    aria-label={ko ? "반복 작업 설정" : "Set repeat work"}
                    title={ko ? "반복해서 맡기기" : "Repeat this work"}
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
                  <button type="submit" className={styles.sendButton} disabled={!busy && ((!composer.trim() && attachmentDrafts.length === 0) || selectedReadOnly || teamDecisionPending || teamPreflightBusy)} aria-label={busy ? (ko ? "실행 중단" : "Stop run") : (ko ? "보내기" : "Send")}>
                    {busy ? <span className={styles.stopGlyph} aria-hidden="true" /> : <IconArrowUp size={20} strokeWidth={2} aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </form>
            {(selectedReadOnly || selectedCanContinueFromResult) && (
              <p className={styles.composerNote}>{selectedReadOnly
                ? (ko ? "이 일은 지금 보기만 할 수 있어요." : "This work is view-only right now.")
                : (ko ? "다음 메시지는 새 일로 시작해요." : "Your next message starts new work.")}</p>
            )}
          </div>

          {searchOpen && (
            <section ref={searchSheetRef} className={styles.searchSheet} role="dialog" aria-modal="true" aria-label={ko ? "대화와 결과 찾기" : "Find conversations and results"} onKeyDown={trapSearchFocus}>
              <div className={styles.searchHeader}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ko ? "지난번 제주 여행, 경쟁사 표…" : "Last Jeju trip, competitor table…"} /><button type="button" className={styles.iconButton} aria-label={ko ? "찾기 닫기" : "Close search"} onClick={() => setSearchOpen(false)}>×</button></div>
              <div className={styles.searchScope}>
                <span>{ko ? "맡긴 일 · 결과 · 파일 · 대화 · 참여 팀" : "Work · results · files · conversations · teams"}</span>
                <label><input type="checkbox" checked={searchIncludeArchived} onChange={(event) => setSearchIncludeArchived(event.target.checked)} />{ko ? "보관함 포함" : "Include archived"}</label>
              </div>
              <div className={styles.searchResults} aria-live="polite" aria-busy={searchLoading || searchLoadingMore}>
                {!query.trim() && (
                  <>
                    {filteredConversations.map((item) => <ConversationListButton key={item.id} item={item} active={item.id === selectedConversationId} locale={appLocale} onOpen={openConversation} />)}
                    {filtered.map((item) => <TaskListButton key={item.taskId} item={item} active={item.taskId === selectedTaskId} locale={appLocale} onOpen={openTask} />)}
                    {filtered.length === 0 && filteredConversations.length === 0 && <div className={styles.railEmpty}>{ko ? "아직 검색할 기록이 없습니다." : "There is no history to search yet."}</div>}
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
                {query.trim() && searchLoading && searchHits.length === 0 && <div className={styles.searchState} role="status">{ko ? "전체 기록에서 찾고 있어요…" : "Searching all history…"}</div>}
                {query.trim() && !searchLoading && !searchError && searchHits.length === 0 && <div className={styles.searchState}>{ko ? "전체 기록과 보관함에서 일치하는 항목을 찾지 못했습니다." : "No matching item was found in history or the archive."}</div>}
                {searchError && <div className={styles.searchError} role="alert">{searchError}</div>}
                {query.trim() && searchNextCursor && !searchError && (
                  <button type="button" className={styles.searchMore} disabled={searchLoadingMore} onClick={loadMoreSearchResults}>
                    {searchLoadingMore ? (ko ? "더 찾는 중…" : "Finding more…") : (ko ? "이전 기록 더 보기" : "Show older matches")}
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
      />
      <OneFeatureIntro
        eligible={introEligible}
        needsAcknowledgement={oneIntroPending}
        locale={appLocale}
        replayToken={activationForeground ? 0 : introReplayToken}
        onResolve={acknowledgeOneIntro}
        onOpenOne={() => router.push("/one")}
        onKeepWork={() => undefined}
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
  const ko = locale === "ko";
  return (
    <button type="button" className={styles.taskButton} data-active={active ? "true" : "false"} onClick={() => onOpen(item.id)} aria-current={active ? "page" : undefined}>
      <strong>{item.title}</strong>
      <small>{ko ? "일반 대화" : "Conversation"} · {formatTimestamp(item.updatedAt, locale)}</small>
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
  const ko = locale === "ko";
  const kindLabels: Record<OneSearchHitV1["kind"], [string, string]> = {
    task: ["맡긴 일", "Work"],
    result: ["결과", "Result"],
    artifact: ["파일", "File"],
    conversation: ["대화", "Conversation"],
    team: ["참여 팀", "Team"],
  };
  const matchLabels: Record<OneSearchHitV1["matchedBy"][number], [string, string]> = {
    task_title: ["일 제목", "Work title"],
    conversation_title: ["대화 제목", "Conversation title"],
    conversation_text: ["대화", "Conversation"],
    result_content: ["결과", "Result"],
    artifact_label: ["파일", "File"],
    team_participant: ["참여 팀", "Team"],
  };
  const statusLabels: Record<OneSearchHitV1["status"], [string, string]> = {
    open: ["준비됨", "Ready"],
    running: ["진행 중", "In progress"],
    "waiting-decision": ["확인 필요", "Needs a decision"],
    partial: ["결과 확인", "Review result"],
    completed: ["완료", "Completed"],
    failed: ["멈춤", "Stopped"],
    archived: ["보관됨", "Archived"],
    conversation: ["대화", "Conversation"],
  };
  const open = () => hit.taskId ? onOpenTask(hit.taskId) : onOpenConversation(hit.chatId);
  return (
    <article className={styles.searchHit} data-active={active ? "true" : "false"} data-archived={hit.archived ? "true" : "false"}>
      <button type="button" className={styles.searchHitOpen} onClick={open}>
        <span className={styles.searchHitHeading}><span className={styles.searchKind}>{kindLabels[hit.kind][ko ? 0 : 1]}</span><strong>{hit.title}</strong></span>
        {hit.detail && <span className={styles.searchHitDetail}>{hit.detail}</span>}
        <small>{hit.archived ? (ko ? "보관됨" : "Archived") : statusLabels[hit.status][ko ? 0 : 1]} · {formatTimestamp(hit.updatedAt, locale)} · {hit.matchedBy.map((kind) => matchLabels[kind][ko ? 0 : 1]).join(" · ")}</small>
      </button>
      {hit.taskId && (
        <button
          type="button"
          className={styles.searchArchiveButton}
          disabled={mutationBusy}
          onClick={() => void onMutateArchive(hit.taskId!, hit.archived ? "restore" : "archive")}
        >
          {mutationBusy
            ? (ko ? "확인 중…" : "Checking…")
            : hit.archived
              ? (ko ? "복원" : "Restore")
              : (ko ? "보관" : "Archive")}
        </button>
      )}
    </article>
  );
}

function decisionFieldValue(field: OneDecisionField, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  if (field.value === "irreversible") return ko ? "되돌릴 수 없음" : "Not reversible";
  if (field.value === "reversible") return ko ? "되돌릴 수 있음" : "Reversible";
  if (field.value) return field.status === "context_only"
    ? `${field.value} · ${ko ? "맥락만 확인됨" : "context only"}`
    : field.value;
  return field.status === "not_applicable"
    ? (ko ? "해당 없음" : "Not applicable")
    : (ko ? "명시되지 않음" : "Not stated");
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
  const ko = locale === "ko";
  const decision: OneDecisionViewV1 = normalizeOneDecision(confirmation, taskId);
  const riskRank = Number(decision.risk.level.slice(1));
  const approvalBlocked = riskRank >= 2 && decision.risk.certainty === "ambiguous";
  const directOptions = decision.options.filter((option) => option.enabled && option.disposition !== "reject" && option.disposition !== "modify");
  const blockedOptions = decision.options.filter((option) => option.blockedReason !== null);
  const rejectLabel = decision.controls.reject.source === "explicit_option"
    ? decision.controls.reject.reply
    : (ko ? "거절 · 제안된 행동 실행 안 함" : "Reject · do not take the proposed action");
  const fields: Array<[string, OneDecisionField]> = [
    [ko ? "대상" : "Target", decision.target],
    [ko ? "행동" : "Action", decision.action],
    [ko ? "영향" : "Impact", decision.impact],
    [ko ? "비용" : "Cost", decision.cost],
    [ko ? "되돌리기" : "Reversibility", decision.reversibility],
    [ko ? "마감" : "Deadline", decision.deadline],
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
            <p className={styles.decisionKicker}>{ko ? "One이 확인할 것" : "One needs one detail"}</p>
            <p id={`${confirmation.sourceMessageId}-decision-title`} className={styles.decisionTitle}>
              {decision.action.value || decision.target.value || (ko ? "어느 쪽으로 이어갈까요?" : "Which direction should One take?")}
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
            {ko ? "나중에" : "Later"}
          </button>
        </div>
        <p className={styles.decisionHint}>{ko ? "선택하면 이 대화에서 바로 이어갑니다." : "Choose one and One will continue in this conversation."}</p>
      </section>
    );
  }
  return (
    <section className={styles.decisionCard} aria-labelledby={`${confirmation.sourceMessageId}-decision-title`} data-risk={decision.risk.level}>
      <div className={styles.decisionHeading}>
        <div>
          <p className={styles.decisionKicker}>{ko ? "결정 필요" : "Decision needed"}</p>
          <p id={`${confirmation.sourceMessageId}-decision-title`} className={styles.decisionTitle}>{decision.target.source === "header" && decision.target.value ? decision.target.value : (ko ? "진행 조건 확인" : "Review the next action")}</p>
        </div>
        <span className={styles.riskBadge}>{ko ? "확인 후 진행" : "Review before continuing"}</span>
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
        {ko
          ? `방금 부탁한 내용과 현재 작업 상태를 기준으로 정리했어요. · ${formatTimestamp(decision.createdAt, locale)}`
          : `Based on what you just asked and the current work status. · ${formatTimestamp(decision.createdAt, locale)}`}
      </p>

      {approvalBlocked && (
        <div className={styles.decisionGuard} role="status">
          <strong>{ko ? "One에서 바로 승인할 수 없음" : "Approval is unavailable in One"}</strong>
          <span>{ko
            ? "바로 실행하기에는 대상, 비용, 또는 되돌리는 방법 중 아직 확인되지 않은 내용이 있어요. Work에서 한 번 확인하면 안전하게 이어갈 수 있어요."
            : "One still needs to confirm the target, cost, or how to undo this. Review it once in Work to continue safely."}</span>
          {blockedOptions.length > 0 && <small>{ko ? "검토가 필요한 선택" : "Choices requiring review"}: {blockedOptions.map((option) => option.label).join(" · ")}</small>}
        </div>
      )}

      {confirmation.multiSelect && !approvalBlocked && (
        <p className={styles.decisionGuard}>{ko ? "여러 선택을 하나의 답으로 확정해야 하므로 Work에서 전체 범위를 검토해주세요." : "This decision requires multiple selections; review the full scope in Work before submitting."}</p>
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
        <button type="button" className={styles.decisionButton} onClick={onOpenWork}>{ko ? "Work에서 범위 수정" : "Change scope in Work"}</button>
        <button type="button" className={styles.decisionButton} disabled={disabled} onClick={() => onSnooze(confirmation)}>{ko ? "24시간 뒤 다시 알림" : "Remind me in 24 hours"}</button>
      </div>
      <p className={styles.decisionHint}>{ko ? "거절과 나중에 결정은 승인이나 외부 실행을 시작하지 않습니다." : "Rejecting or deciding later does not approve or start an external action."}</p>
    </section>
  );
}

function ResolvedDecisionReceipt({ receipt, locale }: { receipt: CommittedQuestionAnswer; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  return (
    <details className={styles.resolvedDecision}>
      <summary>
        <span className={styles.resolvedDecisionSummary}>
          <span className={styles.resolvedDecisionCheck} aria-hidden="true">✓</span>
          <span>
            <strong>{receipt.reply}</strong>
            <small>{ko ? "선택했어요" : "Selected"}</small>
          </span>
        </span>
        <time dateTime={receipt.ts}>{formatTimestamp(receipt.ts, locale)}</time>
      </summary>
      <div>
        <p>{ko ? "나중에 바꾸고 싶으면 One에게 그대로 말하면 돼요." : "If you change your mind, just tell One."}</p>
        <small>{ko ? `선택한 시각 ${formatTimestamp(receipt.ts, locale)}` : `Selected ${formatTimestamp(receipt.ts, locale)}`}</small>
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
