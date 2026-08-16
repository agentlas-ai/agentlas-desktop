"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { Markdown, StreamingMarkdown } from "@/components/Markdown";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import {
  IconArrowUp,
  IconBolt,
  IconChevronDown,
  IconClose,
  IconFolder,
  IconMoreHorizontal,
  IconPanelRight,
  IconPlus,
  IconRoute,
  IconSidebar,
  IconShield,
  IconSparkles,
} from "@/components/Icon";
import { grantForDroppedFile, grantForPastedAttachment, grantForPastedImage, ipc, ipcEvents } from "@/lib/ipc";
import { tFor, useT } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
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
  InvocationRunReceipt,
  InstalledAgent,
  InstalledMcpServer,
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
import { ONE_MEMORY_MAP_CONTRACT_VERSION } from "@shared/one-memory-map";
import type {
  OneSurfaceManifestV1,
  OneSurfaceSemanticAction,
} from "@shared/one-surface";
import { toCustomerSafeText } from "@shared/one-customer-safe";
import { stripAgentControlBlocks, stripAgentIdentityBadges } from "@shared/agent-control-blocks";
import { classifyOneRequestIntent } from "@shared/one-request-intent";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { useJudgedOneDecision } from "@/lib/one-decision-judged";
import { visibleDecisionReceipt } from "@/lib/one-decision-receipt";
import type { OneRecurrenceSelectionV1 } from "@shared/one-recurrence";
import { shouldPresentOneWeeklyReflection } from "@shared/one-weekly-reflection";
import {
  ONE_ATTACHMENT_LIMITS,
  type OneAttachmentPrepareItem,
  type OneAttachmentSafeItem,
  type PreparedOneAttachments,
} from "@shared/one-attachments";
import type { FsPathGrant, OrchestrationTarget, RuntimeSelection, RuntimeStatus } from "@shared/types";
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
import { OneBottomSheet } from "./OneBottomSheet";
import { OneAutomationSheet } from "./OneAutomationSheet";
import { OneUseCaseChips, type OneUseCaseChipAction } from "./OneUseCaseChips";
import { OneAdaptiveResult } from "./OneAdaptiveResult";
import { OneActivation } from "./OneActivation";
import { OneFeatureIntro } from "./OneFeatureIntro";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneMemoryMap } from "./OneMemoryMap";
import { OneMemoryCandidateCard } from "./OneMemoryCandidateCard";
import { OneProfileSheet } from "./OneProfileSheet";
import { OneProjectSessionSheet } from "./OneProjectSessionSheet";
import { OneSuggestionCard } from "./OneSuggestionCard";
import { OneGrowthCard } from "./OneGrowthCard";
import { OneActivityArtifactRail } from "./OneActivityTimeline";
import { OneTurnWork, OneTurnWorkDividers } from "./OneTurnWork";
import { buildOneWorkPresentation } from "@/lib/one-turn-work";
import { planOneThreadWork, projectThreadRuns, type OneThreadRunBlock } from "@/lib/one-thread-work";
import { ToolApprovalInline } from "@/components/ToolApprovalInline";
import {
  OneComposerControls,
  type OneComposerMenuKey,
  type OneComposerModelOption,
  type OneComposerPluginOption,
  type OnePermissionMode,
} from "./OneComposerControls";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { OneWeeklyReflectionCard } from "./OneWeeklyReflectionCard";
import {
  beginOneActivityState,
  initialOneActivityState,
  projectOneActivityFromLedger,
  reduceOneActivity,
  type OneActivityState,
} from "@/lib/one-activity";
import styles from "./OneShell.module.css";

const ONE_PERMISSION_STORAGE_KEY = "agentlas.one.permission-mode.v1";
const ONE_RUNTIME_STORAGE_KEY = "agentlas.one.runtime-selection.v1";
const ONE_LEFT_RAIL_COLLAPSED_STORAGE_KEY = "agentlas.one.left-rail-collapsed.v1";
const ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY = "agentlas.one.context-rail-open.v1";
/** The right rail is resizable (owner request 2026-08-16); the width persists like its open state. */
const ONE_CONTEXT_RAIL_WIDTH_STORAGE_KEY = "agentlas.one.context-rail-width.v1";
const ONE_CONTEXT_RAIL_WIDTH_DEFAULT = 420;
const ONE_CONTEXT_RAIL_WIDTH_MIN = 300;
const ONE_CONTEXT_RAIL_WIDTH_MAX = 720;

function clampContextRailWidth(value: number): number {
  if (!Number.isFinite(value)) return ONE_CONTEXT_RAIL_WIDTH_DEFAULT;
  return Math.min(ONE_CONTEXT_RAIL_WIDTH_MAX, Math.max(ONE_CONTEXT_RAIL_WIDTH_MIN, Math.round(value)));
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
  /*
   * ★첨부는 대화의 일부다 — 보내고 나면 사라지던 것을 남긴다.
   *
   * 이 모델에는 첨부가 들어갈 자리 자체가 없었다. 그래서 사진을 붙여 보내면 작성 중
   * 미리보기만 잠깐 보이고, 보내는 순간 화면에서 사라졌다(Work 쪽 ChatStream 은
   * 예전부터 그렸다). 텍스트 없이 사진만 보낸 턴은 아예 렌더 조건에 걸려 통째로
   * 없어졌다.
   */
  images?: string[];
  files?: Array<{ name: string; kind: "image" | "file" }>;
  /** Durable rows only (ISO). Optimistic rows have none and sort after every durable row. */
  createdAt?: string;
};

const ONE_SEQUENCE_STEP_RE = /(?:^|\s)(?:ONE-SESSION-QA-[\w-]+\s*\/\s*)?0*(\d{1,3})\s*\/\s*(\d{1,3})(?:\s*(?:작업|task))?(?=\s*(?:[.:—-]|$))/i;
const ONE_QA_SEQUENCE_STEP_RE = /(?:^|\s)ONE-SESSION-QA-[\w-]+\s*\/\s*0*(\d{1,3})(?=\s*(?:[.:—-]|$))/i;

/**
 * A Task title is deliberately stable in the canonical store, but a long
 * One session can advance through many numbered turns. The toolbar is live
 * progress chrome, so it must never keep advertising the first turn after a
 * later user turn is already visible.
 */
function oneToolbarTitle(messages: UiMessage[], fallback: string, locale: "ko" | "en"): string {
  let sequenceTotal: string | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const candidate = ONE_SEQUENCE_STEP_RE.exec(message.text);
    if (candidate) {
      sequenceTotal = candidate[2];
      break;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const match = ONE_SEQUENCE_STEP_RE.exec(message.text);
    const qaMatch = match ? null : ONE_QA_SEQUENCE_STEP_RE.exec(message.text);
    if (!match && !qaMatch) continue;
    const sequenceMatch = match ?? qaMatch;
    if (!sequenceMatch) continue;
    const current = Number(sequenceMatch[1]);
    const total = Number(match?.[2] ?? sequenceTotal);
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || total < current) continue;
    const prompt = message.text.slice((sequenceMatch.index ?? 0) + sequenceMatch[0].length)
      .replace(/^\s*(?:[.:—-])\s*/, "")
      .trim();
    const summary = briefingSourceName(prompt || fallback, locale);
    return `${current}/${total} · ${summary}`;
  }
  return fallback;
}

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
  fastMode?: true;
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
  for (const entry of history) {
    if (entry.role === "system" && /^Private operational evidence\./.test(entry.text.trim())) {
      // This prompt and the reply it elicits are an internal recovery attempt,
      // not a user-authored turn or a trustworthy final result.
      suppressRecoveryReply = true;
      continue;
    }
    if (entry.role === "assistant" && suppressRecoveryReply) {
      suppressRecoveryReply = false;
      continue;
    }
    if (entry.role === "user") suppressRecoveryReply = false;
    visible.push({
      id: entry.id,
      role: entry.role === "assistant" ? "assistant" : entry.role,
      text: entry.text,
      images: entry.imageDataUrls?.length ? entry.imageDataUrls : undefined,
      createdAt: entry.createdAt,
    });
  }
  return visible;
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
  if (isResultContinuationMessage(message)) {
    return "";
  }
  if (message.role === "assistant" && /^(?:Your result and files are ready\. You can review them below\.|요청한 결과와 파일을 준비했어요\. 아래에서 바로 확인할 수 있어요\.)$/.test(message.text.trim())) {
    return "";
  }
  const systemPromptLabel = oneSystemPromptLabel(message);
  if (systemPromptLabel) return systemPromptLabel;
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
  const [activeChatIds, setActiveChatIds] = useState<string[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [keyRequestSheet, setKeyRequestSheet] = useState<McpRunKeyRequest | null>(null);
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
  const [projectSessionSheetOpen, setProjectSessionSheetOpen] = useState(false);
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
  const [installedPlugins, setInstalledPlugins] = useState<InstalledMcpServer[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<McpToolCatalogEntry[]>([]);
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
  const [contextRailOpen, setContextRailOpenState] = useState(() => readStoredBoolean(ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY, true));
  const [contextRailWidth, setContextRailWidthState] = useState<number>(readStoredContextRailWidth);
  const setContextRailWidth = useCallback((next: number) => {
    const clamped = clampContextRailWidth(next);
    setContextRailWidthState(clamped);
    try {
      window.localStorage.setItem(ONE_CONTEXT_RAIL_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // The rail stays resizable even when persistence is unavailable.
    }
  }, []);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const setRailCollapsed = useCallback((collapsed: boolean) => {
    window.localStorage.setItem(ONE_LEFT_RAIL_COLLAPSED_STORAGE_KEY, String(collapsed));
    setRailCollapsedState(collapsed);
  }, []);
  const setContextRailOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setContextRailOpenState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      window.localStorage.setItem(ONE_CONTEXT_RAIL_OPEN_STORAGE_KEY, String(value));
      return value;
    });
  }, []);
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
    if (!api) return;
    let cancelled = false;
    void Promise.all([
      api.team.list().catch(() => []),
      api.mcpTools.listInstalled().catch(() => []),
      api.mcpTools.listCatalog().catch(() => []),
    ]).then(([agents, plugins, catalog]) => {
      if (cancelled) return;
      setAvailableAgents(visibleAgents(agents, { includeTeams: true }));
      setInstalledPlugins(plugins);
      setPluginCatalog(catalog);
    });
    return () => { cancelled = true; };
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
  // An optimistic "next instruction" row and its durable twin (persisted by Main
  // when the queued run starts) must never both render — that was the doubled
  // user bubble in the 2026-08-15 recording. The durable row wins.
  const visibleMessages = useMemo(() => {
    if (!messages.some((message) => message.id.startsWith("one-steer:"))) return messages;
    return messages.filter((message, index) => {
      if (!message.id.startsWith("one-steer:")) return true;
      return !messages.some((other, otherIndex) => (
        otherIndex !== index
        && !other.id.startsWith("one-steer:")
        && other.role === "user"
        && other.text === message.text
      ));
    });
  }, [messages]);
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
        state={renderedActivity}
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
  const streamTextRef = useRef("");
  const unsubscribeRunRef = useRef<(() => void) | null>(null);
  const selectedTaskIdRef = useRef(selectedTaskId);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const navigationEpochRef = useRef(0);
  const homeTransitionPendingRef = useRef(false);
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
    const restoredActivity = projectOneActivityFromLedger(ledgerEvents);
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
    setActivityStateRunId(eventRunId);
    setActivity((current) => {
      const base = activityEventRunIdRef.current === eventRunId ? current : initialOneActivityState();
      const next = reduceOneActivity(base, event);
      activityEventRunIdRef.current = eventRunId;
      cacheOneActivity(chatId, next);
      return next;
    });
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
      const settledRunId = eventRunId;
      setKeyRequestSheet(null);
      const text = event.text ?? streamTextRef.current;
      // Commit the streamed answer under its own id. Leaving it as the shared
      // "one-live-response" row meant the next turn's live row *replaced* it
      // (measured 2026-08-15: the previous answer vanished while a queued
      // instruction ran, until the history reload brought it back).
      setMessages((current) => upsertLiveMessage(current, text, false).map((message) => (
        message.id === "one-live-response"
          ? { ...message, id: `one-answer:${settledRunId ?? uid()}`, createdAt: message.createdAt ?? new Date().toISOString() }
          : message
      )));
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
      setKeyRequestSheet(null);
      // Failure evidence is persisted by Main and consumed by One's recovery
      // judgment. It never becomes transcript copy in the renderer.
      // Whatever streamed before the failure stays as this run's answer row
      // (Main persists the same partial); an empty live row is dropped so it
      // cannot be mistaken for "the place where it ended".
      setMessages((current) => current.flatMap((message) => {
        if (message.id !== "one-live-response") return [message];
        if (!message.text.trim()) return [];
        return [{ ...message, id: `one-answer:${settledRunId ?? uid()}`, streaming: false, createdAt: message.createdAt ?? new Date().toISOString() }];
      }));
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
  }, [reconcileConversationTask, scrollToLatest, settleRun]);

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
    const liveRunOwnsActiveThread = Boolean(
      runIdRef.current
      && runChatIdRef.current
      && (runChatIdRef.current === activeThreadChatId || promotionHandoff),
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

    unsubscribeRunRef.current?.();
    unsubscribeRunRef.current = null;
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
      if (!selectedTaskId) {
        activityEventRunIdRef.current = null;
        setActivity(initialOneActivityState());
        setRunStartedAt(null);
      }
      setMessages([]);
      shownThreadChatIdRef.current = null;
      setCommittedAnswers([]);
      setThreadRuns([]);
      threadRunsChatIdRef.current = null;
      return;
    }
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
          // 다른 대화에서 왔으면 비어 있더라도 교체한다 — 남의 화면을 남겨 두는 것이
          // 바로 "합쳐져 보이는" 증상이다.
          if (!screenAlreadyOnThisThread) return next;
          // 같은 대화인데 서버 스냅샷이 아직 비었다면(첫 실행이 방금 시작됐다면)
          // 사람이 막 친 말과 라이브 응답을 빈 스냅샷으로 지우지 않는다.
          if (next.length === 0 && current.length > 0) return current;
          // 큐에 넣은 다음 지시(one-steer:)는 Main이 그 실행을 시작할 때 비로소 원장에
          // 남는다. 그 사이의 히스토리 재적재가 낙관 행을 지우면 사람이 친 말이 화면에서
          // 사라졌다가 실행 끝에 다시 나타난다 — 원장에 같은 말이 오기 전까지 유지한다.
          const pendingSteers = current.filter((message) => (
            message.id.startsWith("one-steer:")
            && !next.some((durable) => durable.role === "user" && durable.text === message.text)
          ));
          return pendingSteers.length > 0 ? [...next, ...pendingSteers] : next;
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
        const restoredActivity = projectOneActivityFromLedger(ledgerEvents);
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
    }).catch((cause) => {
      if (!cancelled) {
        requestOneOperationalRecovery("one-refresh", cause);
        setError(null);
      }
    });
    return () => {
      cancelled = true;
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
  const activeThreadPromptFallback = selected?.display.title ?? conversation?.title ?? "";
  const taskToolbarTitle = useMemo(
    () => oneToolbarTitle(messages, activeThreadPromptFallback || "Agentlas One", appLocale),
    [activeThreadPromptFallback, appLocale, messages],
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
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void Promise.all([
      api.runtime.detect(),
      activeThreadChatId ? api.chats.get(activeThreadChatId).catch(() => null) : Promise.resolve(null),
    ]).then(([runtimes, chat]) => {
      if (cancelled) return;
      // A model chosen in One is a product preference, not disposable state on
      // the current route. Prefer a chat's durable override, then the last
      // explicit One choice, then the globally active runtime.
      const selection = chat?.runtimeSelection ?? readStoredOneRuntimeSelection();
      const matched = selection
        ? runtimes.find((runtime) => runtime.kind === selection.kind && (!selection.backend || runtime.backend === selection.backend))
        : runtimes.find((runtime) => runtime.active);
      setOneRuntime(matched ? {
        ...matched,
        active: true,
        model: selection?.model ?? matched.model,
        effort: selection?.effort ?? matched.effort,
        longContextEnabled: selection?.longContext ?? matched.longContextEnabled,
      } : null);
      setOneRuntimePinned(Boolean(selection));
      setOneRuntimeInventory(runtimes);
    }).catch(() => {
      if (!cancelled) {
        setOneRuntime(null);
        setOneRuntimePinned(false);
        setOneRuntimeInventory([]);
      }
    });
    return () => { cancelled = true; };
  }, [activeThreadChatId]);

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
      return models.map((model) => ({ ...model, runtime, tag: model.tag ?? provider }));
    })).then((groups) => {
      if (!cancelled) setOneModelOptions(groups.flat());
    }).catch(() => {
      if (!cancelled) setOneModelOptions([]);
    });
    return () => { cancelled = true; };
  }, [oneRuntimeInventory]);

  useEffect(() => {
    if (!composerMenu) return;
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
    };
  }, [composerMenu]);
  useEffect(() => {
    // Switching threads drops the strip — unless this navigation is the fresh
    // submit landing on the chat it just created, whose steers are already
    // queued in Main behind the run that is starting.
    if (!activeThreadChatId || runChatIdRef.current !== activeThreadChatId) setQueuedSteers([]);
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
    if (previousKey === "new" && restored.composer.trim() === "" && inProgress.trim() !== "") {
      writeOneComposerDraft(composerDraftKey, { composer: inProgress });
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
    const nextRuntime: RuntimeStatus = {
      ...baseRuntime,
      model: patch.model !== undefined ? patch.model || null : baseRuntime.model,
      effort: patch.effort !== undefined ? patch.effort || null : baseRuntime.effort,
    };
    const selection: RuntimeSelection = {
      kind: nextRuntime.kind,
      backend: nextRuntime.backend,
      model: nextRuntime.model ?? undefined,
      effort: nextRuntime.effort ?? undefined,
      longContext: nextRuntime.kind === "byok" ? nextRuntime.longContextEnabled ?? false : undefined,
      role: "orchestrator",
      inherit: false,
    };
    setOneRuntime(nextRuntime);
    setOneRuntimePinned(true);
    writeStoredOneRuntimeSelection(selection);
    setComposerMenu(null);
    const api = ipc();
    if (api && activeThreadChatId) {
      await api.chats.setRuntimeSelection(activeThreadChatId, selection).catch(() => null);
    }
  }, [activeThreadChatId, oneRuntime]);

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
    const runLocale = normalizedLocale;
    if (!api || !events) throw new Error(tFor(runLocale, "one.shell.run.desktop_unavailable"));
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
    const executionPermission = onePermission === "auto"
      ? taskIntent === "task" ? "write" : "read"
      : onePermission;
    const optimisticStartedAt = Date.now();
    activeRunStartedAtRef.current = optimisticStartedAt;
    // 새 실행이 시작되면 활동 표시는 그 실행 하나만 말한다. 지난 실행의 결과 영수증과
    // 런타임 피드백(생성 파일·이미지 레일 포함)을 남겨 두면, One의 활동 화면이 "지금
    // 무슨 일이 일어나는 중인지"가 아니라 지난 실행의 잔해를 함께 보여 준다. 스레드
    // 전환(위 useEffect)은 이미 같은 리셋을 하고 있었고, 실행 경계에만 빠져 있었다.
    const freshActivity = beginOneActivityState({
      observedAt: new Date(optimisticStartedAt).toISOString(),
      selectedPermissionMode: onePermission,
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
        ...(options?.taskForceTargets?.length ? { taskForceTargets: options.taskForceTargets } : {}),
        ...(attachedOneMemoryUseOnce ? {
          oneMemoryUseOnceRef: {
            contractVersion: attachedOneMemoryUseOnce.contractVersion,
            receiptId: attachedOneMemoryUseOnce.receiptId,
          },
        } : {}),
        locale: runLocale,
        onePermissionMode: onePermission,
        permissions: executionPermission,
        ...(oneRuntimeSelection ? { runtimeSelection: oneRuntimeSelection } : {}),
        ...(options?.overrides?.goalMode ? { goalMode: true } : {}),
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
            onePermissionMode: onePermission,
            permissions: executionPermission,
            ...(oneRuntimeSelection ? { runtimeSelection: oneRuntimeSelection } : {}),
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
  }, [armedOneMemoryUseOnce, normalizedLocale, onePermission, oneRuntimeSelection, refreshAll, scrollToLatest, subscribeRun]);

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
    // Repetition is configured in One's automation surface, not in the chat
    // composer. Keeping a third scheduling sheet here duplicated that product
    // boundary and made the composer feel like a form.
    const recurrenceSnapshot: OneRecurrenceSelectionV1 | null = null;
    const overrideSnapshot = { ...turnOverrides };
    const taskForceTargetSnapshot: OrchestrationTarget[] = turnAgentIds.map((agentId) => ({
      source: "local",
      entityKind: "agent",
      agentId,
    }));
    const explicitValue = text.trim();
    if (!explicitValue && attachmentSnapshot.length === 0) return;
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
    if (teamPreflight && ["proposed", "blocked", "team_reserved", "workforce_reserved", "solo_reserved", "deferred"].includes(teamPreflight.status)) return;
    const prepareOrRun = async (
      chatId: string,
      taskId: string | null,
      taskVersion: number | null,
      taskIntent: "task" | "conversation",
    ) => {
      setSubmissionBusy(true);
      setError(null);
      let preparedAttachments: PreparedOneAttachments | null = null;
      // Resolve new-chat intent in Main before team preflight. A cold model can
      // miss the fast judgment budget, in which case the explicitly labeled
      // undecided result keeps the safe conversational default.
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
        const mainIntent = await requestIntentPromise;
        const resolvedIntent = preparedAttachments
          || taskIntent === "task"
          || recurrenceSnapshot
          || mainIntent?.intent === "task"
          || classifyOneRequestIntent(value) === "task"
          ? "task"
          : "conversation";
        const explicitTeamRequest = taskForceTargetSnapshot.length > 0 || overrideSnapshot.sessionRouting;
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
            value,
            "conversation",
            {
              attachments: preparedAttachments,
              recurrence: recurrenceSnapshot,
              overrides: overrideSnapshot,
              taskForceTargets: taskForceTargetSnapshot,
              userAlreadyShown: true,
            },
          );
          return;
        }
        const prepared = await api.oneTeamPreflight.prepare({
          chatId,
          userPrompt: value,
          expectedTaskId: taskId,
          expectedTaskVersion: taskVersion,
          permission: onePermission === "read" ? "read" : "write",
          ...(oneRuntimeSelection ? { runtimeSelection: oneRuntimeSelection } : {}),
          ...(taskForceTargetSnapshot.length > 0 ? { requestedAgentIds: taskForceTargetSnapshot.map((target) => target.source === "local" && target.entityKind === "agent" ? target.agentId : "").filter(Boolean) } : {}),
          ...(overrideSnapshot.sessionRouting ? { dynamicTeamRequested: true } : {}),
        });
        if (prepared.kind === "not_required") {
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
          text: value,
          attachments: preparedAttachments,
          recurrence: recurrenceSnapshot,
          overrides: overrideSnapshot,
          taskForceTargets: taskForceTargetSnapshot,
        };
        setPendingTeamPrompt(pendingPrompt);
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
    setTurnAgentIds([]);
    setAgentPickerOpen(false);
    setComposerMenu(null);
    clearAttachmentDrafts();
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
      const chat = await api.chats.create({
        title: value.split(/\r?\n/)[0].slice(0, 72),
        taskMode: "conversation",
        originSurface: "one",
      });
      if (workspaceGrant) {
        await api.workspace.set(chat.id, workspaceGrant);
      }
      if (oneRuntimeSelection) {
        await api.chats.setRuntimeSelection(chat.id, oneRuntimeSelection).catch(() => chat);
      }
      // A later "New conversation" action owns navigation. An older async
      // submission may still finish preparing, but it must not pull the UI
      // back to its chat or restore that chat as the active composer target.
      if (navigationEpochRef.current === submissionNavigationEpoch) {
        homeTransitionPendingRef.current = false;
        setConversation(chat);
        selectedConversationIdRef.current = chat.id;
        // 화면에는 이미 이 대화의 첫 턴이 떠 있다(낙관적 렌더). 소유를 지금 넘겨 두지
        // 않으면 곧 도착할 빈 히스토리가 그 턴을 지운다.
        shownThreadChatIdRef.current = chat.id;
        router.replace(`/one?chat=${encodeURIComponent(chat.id)}`);
      }
      await resolveActivationConcern(chat.id);
      await prepareOrRun(chat.id, null, null, "conversation");
    } catch (cause) {
      setSubmissionBusy(false);
      setPreflightPrompt(null);
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
      requestOneOperationalRecovery("one-submit", cause);
      setError(null);
    }
  }, [autoStartTeamPreflight, busy, clearAttachmentDrafts, conversation, appLocale, normalizedLocale, onePermission, oneRuntimeSelection, resolveActivationConcern, router, scrollToLatest, selected, startRun, teamPreflight, teamPreflightBusy, turnAgentIds, turnOverrides, workspaceGrant]);

  const stopRun = useCallback(() => {
    const api = ipc();
    const runId = runIdRef.current;
    if (!runId) return;
    if (!api) {
      requestOneOperationalRecovery("one-run-stop", new Error("Desktop bridge unavailable"));
      return;
    }
    // Stop is terminal for the visible work item: Main drops the directions
    // queued behind it (InvocationService.cancel), so the strip must not keep
    // showing them as "next".
    setQueuedSteers([]);
    void api.invoke.cancel(runId);
  }, []);

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

  const startNewConversation = useCallback(() => {
    // Clear the renderer's active-thread identity synchronously, before the
    // router commits /one. The composer can now never borrow the previous
    // conversation during that navigation window.
    navigationEpochRef.current += 1;
    homeTransitionPendingRef.current = true;
    selectedTaskIdRef.current = null;
    selectedConversationIdRef.current = null;
    setSelected(null);
    setConversation(null);
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
    runIdRef.current = null;
    runChatIdRef.current = null;
    runTaskIdRef.current = null;
    streamTextRef.current = "";
    setBusy(false);
    setTeamPreflightBusy(false);
    setKeyRequestSheet(null);
    setComposer("");
    setRailOpen(false);
    setSearchOpen(false);
    clearAttachmentDrafts();
    router.push("/one");
  }, [clearAttachmentDrafts, router]);

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
  const activationForeground = Boolean(
    oneActivationState
    && oneActivationState.eligibility === "eligible_first_use"
    && (oneActivationState.status === "active"
      || (oneActivationState.status === "completed" && oneActivationState.mobileConnection.status === "offered")),
  );
  // The memory map is One's stable home. A pending decision or proactive
  // briefing may ask for attention, but it must not replace the person's
  // orientation surface with a completely different hero screen. An empty
  // graph is still the memory-map home. Bridge/API delay or failure must not
  // reintroduce the legacy hero while the map snapshot is unavailable.
  const showMemoryMap = !activationForeground;
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
  // Memory Map is the first and stable One surface. Product education remains
  // available explicitly from "About One" via replayToken, but it must never
  // interrupt a fresh launch or cover the map automatically.
  const introEligible = false;
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
  const selectedCanSteerActiveRun = Boolean(busy && selected?.chatId);
  const selectedReadOnly = Boolean(
    selected
    && !selectedCanSteerActiveRun
    && (!selected.chatId || (!selected.truth.mayStartExecution && !selectedCanContinueInPlace)),
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
      // Finder에서 복사한 파일은 preload가 실제 경로 capability를 받는다. 스크린샷,
      // 오디오·비디오와 브라우저가 만든 파일은 경로가 없으므로 Main이 허용 형식의
      // 바이트만 private staging으로 고정해 동일한 exact-file capability를 발급한다.
      const grant = await grantForDroppedFile(file)
        ?? await grantForPastedAttachment(file)
        // 이전 preload와의 일시적 호환: 새 bridge가 아직 없더라도 이미지 붙여넣기는 유지.
        ?? (kind === "image" ? await grantForPastedImage(file) : null);
      if (!grant || grant.kind !== "file") {
        errors.push(tFor(appLocale, "one.shell.attach.not_regular_file", { name: attachmentDisplayName(file, appLocale) }));
        continue;
      }
      const previewUrl = kind === "image" ? URL.createObjectURL(file) : null;
      next.push({
        id: uid(),
        grant,
        name: attachmentDisplayName(file, appLocale),
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
      <div
        className={styles.body}
        data-rail-collapsed={railCollapsed ? "true" : "false"}
        data-rail-open={railOpen ? "true" : "false"}
        data-task-active={selected || conversation ? "true" : "false"}
      >
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
            <button type="button" className={styles.railPrimaryButton} onClick={startNewConversation}><span aria-hidden="true">＋</span>{tFor(appLocale, "one.shell.rail.new_conversation")}</button>
            <button ref={searchTriggerRef} type="button" className={styles.railPrimaryButton} onClick={() => setSearchOpen(true)}><span aria-hidden="true">⌕</span>{tFor(appLocale, "one.shell.rail.search_all")}</button>
            <button type="button" className={styles.railPrimaryButton} onClick={startNewConversation}>
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
              <button type="button" onClick={startNewConversation}>
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

        <main
          className={styles.workspace}
          data-runtime-artifacts={runtimeArtifacts.length > 0 ? "true" : "false"}
          data-context-rail={selected && contextRailOpen ? "true" : "false"}
          style={{ "--one-rail-width": `${contextRailWidth}px` } as CSSProperties}
        >
          <div className={`${styles.windowBar} titlebar-drag`}>
            {selected || conversation ? (
              <div className={`${styles.taskToolbar} titlebar-nodrag`}>
                <button
                  ref={railRevealButtonRef}
                  type="button"
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
                <span className={styles.taskToolbarDivider} aria-hidden="true" />
                <IconFolder size={15} />
                <strong>{taskToolbarTitle}</strong>
                <div className={styles.taskToolbarMenu} data-one-task-menu="true">
                  <button
                    type="button"
                    aria-label={appLocale === "ko" ? "작업 메뉴" : "Task menu"}
                    aria-haspopup="menu"
                    aria-expanded={taskMenuOpen}
                    onClick={() => setTaskMenuOpen((value) => !value)}
                  ><IconMoreHorizontal size={16} /></button>
                  {taskMenuOpen && (
                    <div className={styles.taskToolbarMenuPopover} role="menu">
                      {selected && canOpenSelectedInWork && (
                        <button type="button" role="menuitem" onClick={() => { setTaskMenuOpen(false); void openWork(); }}>
                          {tFor(appLocale, "one.shell.rail.open_in_work")}
                        </button>
                      )}
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
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={styles.taskToolbarPanelToggle}
                  data-active={contextRailOpen ? "true" : "false"}
                  aria-label={contextRailOpen
                    ? (appLocale === "ko" ? "출력 패널 접기" : "Collapse output panel")
                    : (appLocale === "ko" ? "출력 패널 열기" : "Open output panel")}
                  title={contextRailOpen
                    ? (appLocale === "ko" ? "출력 패널 접기" : "Collapse output panel")
                    : (appLocale === "ko" ? "출력 패널 열기" : "Open output panel")}
                  aria-pressed={contextRailOpen}
                  onClick={() => setContextRailOpen((value) => !value)}
                ><IconPanelRight size={16} /></button>
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
                {showMemoryMap ? (
                  <div className={styles.memoryHomeStage}>
                    <OneMemoryMap snapshot={oneMemoryMap ?? EMPTY_ONE_MEMORY_MAP} locale={appLocale} />
                    {briefing.kind !== "quiet" && (
                      <section className={styles.memoryHomeAlert} aria-labelledby="one-home-alert-title">
                        <p>{briefing.eyebrow}</p>
                        <strong id="one-home-alert-title">{briefing.title}</strong>
                        <span>{briefing.body}</span>
                        <div>
                          {briefing.proactive
                            ? briefing.proactive.preparedAction.kind === "open_task"
                              ? <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void openProactiveTask(briefing.proactive!)}>{briefingActionBusy ? tFor(appLocale, "one.shell.common.checking") : briefing.primaryLabel}</button>
                              : <button type="button" className={styles.primaryButton} disabled={briefingActionBusy} onClick={() => void reviewPreparedFinding(briefing.proactive!)}>{briefingActionBusy ? tFor(appLocale, "one.shell.common.checking") : tFor(appLocale, "one.shell.briefing.review")}</button>
                            : briefing.taskId && <button type="button" className={styles.primaryButton} onClick={() => openTask(briefing.taskId!)}>{briefing.primaryLabel}</button>}
                          {briefing.proactive
                            ? <button type="button" className={styles.ghostButton} onClick={() => void applyProactiveFeedback(briefing.proactive!, "later")}>{tFor(appLocale, "one.shell.common.later")}</button>
                            : <button type="button" className={styles.ghostButton} onClick={() => { const signature = briefingSignature(briefing); setDismissedBriefing({ signature, expiresAt: writeBriefingDismissal(signature) }); }}>{tFor(appLocale, "one.shell.common.later")}</button>}
                        </div>
                      </section>
                    )}
                  </div>
                ) : briefing.kind === "quiet" && !briefing.proactive ? (
                  activationForeground
                    ? null
                    : <section className={styles.newUser} aria-labelledby="one-first-run-title">
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
                  {threadWorkPlan.leading.map((block) => (
                    <OneTurnWork
                      key={`work:${block.runId}`}
                      state={block.state}
                      busy={false}
                      startedAt={Date.parse(block.startedAt)}
                      locale={appLocale}
                      workspacePath={workspacePath}
                    />
                  ))}
                  {visibleMessages.map((message) => {
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
                    return (
                      <Fragment key={message.id}>
                        {liveBefore && !preflightPrompt && liveWorkBlock}
                        {(visibleText || hasAttachments) && (systemLabel
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
                          >
                            <div className={styles.messageBody}>
                              {message.images && message.images.length > 0 && (
                                <div className={styles.messageImages}>
                                  {message.images.map((src, i) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img key={`${message.id}-img-${i}`} src={src} alt="" className={styles.messageImage} />
                                  ))}
                                </div>
                              )}
                              {message.files && message.files.filter((f) => f.kind !== "image").length > 0 && (
                                <div className={styles.messageFiles}>
                                  {message.files.filter((f) => f.kind !== "image").map((f, i) => (
                                    <span key={`${message.id}-file-${i}`} className={styles.messageFileChip}>{f.name}</span>
                                  ))}
                                </div>
                              )}
                              {visibleText && (message.streaming ? <StreamingMarkdown text={visibleText} messageId={message.id} /> : <Markdown text={visibleText} messageId={message.id} />)}
                            </div>
                          </article>
                          ))}
                        {blocksAfter.map((block) => (
                          <OneTurnWork
                            key={`work:${block.runId}`}
                            state={block.state}
                            busy={false}
                            startedAt={Date.parse(block.startedAt)}
                            locale={appLocale}
                            workspacePath={workspacePath}
                          />
                        ))}
                      </Fragment>
                    );
                  })}
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
                          <div className={styles.messageBody}><Markdown text={activeRunPrompt.text} messageId={`one-live-prompt:${activeRunPrompt.runId}`} /></div>
                        </article>
                      )}
                      {liveWorkBlock}
                    </>
                  )}
                  {/* 도구 승인은 이 대화 안에서, 묻는 순간에(오너 결정 2026-08-15) */}
                  <ToolApprovalInline chatId={activeThreadChatId} />
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
                {teamPreflight && ["workforce_reserved", "recovery_required"].includes(teamPreflight.status) && receipt?.status !== "completed" && !teamPreflightBusy && !busy && !awaitingWorkforceConsent && (
                  <p className={styles.teamPreflightRecovery} role="status">
                    {tFor(appLocale, "one.shell.thread.recovery")}
                  </p>
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

          <OneActivityArtifactRail
            items={runtimeArtifacts}
            activity={activity}
            locale={appLocale}
            visible={Boolean(selected && contextRailOpen)}
            onAdd={() => attachmentInputRef.current?.click()}
            onClose={() => setContextRailOpen(false)}
            width={contextRailWidth}
            onResize={setContextRailWidth}
            minWidth={ONE_CONTEXT_RAIL_WIDTH_MIN}
            maxWidth={ONE_CONTEXT_RAIL_WIDTH_MAX}
            defaultWidth={ONE_CONTEXT_RAIL_WIDTH_DEFAULT}
          />

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
            {workspacePath && (
              <div className={styles.oneWorkspaceChip} role="status" data-one-workspace="connected">
                <IconFolder size={14} aria-hidden="true" />
                <span title={workspacePath}>{workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || workspacePath}</span>
                <small>{appLocale === "ko" ? "작업 폴더" : "Working folder"}</small>
                <button
                  type="button"
                  onClick={() => {
                    const api = ipc();
                    setWorkspaceGrant(null);
                    setWorkspacePath(null);
                    if (api && activeThreadChatId) void api.workspace.set(activeThreadChatId, null);
                  }}
                  aria-label={appLocale === "ko" ? "작업 폴더 연결 해제" : "Disconnect working folder"}
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
                onMenuChange={setComposerMenu}
                onAttach={() => {
                  setComposerMenu(null);
                  attachmentInputRef.current?.click();
                }}
                onAddFolder={() => {
                  const api = ipc();
                  setComposerMenu(null);
                  if (!api) return;
                  void api.fs.pickDirectory().then((grant) => {
                    if (!grant?.path) return;
                    setWorkspaceGrant(grant);
                    setWorkspacePath(grant.path);
                    if (activeThreadChatId) void api.workspace.set(activeThreadChatId, grant);
                    window.setTimeout(() => composerInputRef.current?.focus(), 0);
                  }).catch(() => undefined);
                }}
                onOpenProjectSessions={() => {
                  setComposerMenu(null);
                  setProjectSessionSheetOpen(true);
                }}
                onOpenPlugins={() => {
                  setComposerMenu(null);
                  router.push("/library/mcps");
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
            <form className={styles.composer} data-one-composer="true" onSubmit={(event) => {
              event.preventDefault();
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
                    data-one-composer-trigger="plus"
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
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
                      disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                      aria-expanded={composerMenu === "model"}
                      aria-haspopup="dialog"
                      aria-controls={composerMenu === "model" ? "one-composer-popover" : undefined}
                      aria-label={appLocale === "ko"
                        ? `모델: ${oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? "기본 모델"}`
                        : `Model: ${oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? "Default model"}`}
                      onClick={() => setComposerMenu((current) => current === "model" ? null : "model")}
                    >
                      <IconSparkles size={15} />
                      <span>{oneModelOptions.find((model) => model.runtime.kind === oneRuntime?.kind && model.runtime.backend === oneRuntime?.backend && model.id === oneRuntime?.model)?.label ?? oneRuntime?.model ?? (appLocale === "ko" ? "기본 모델" : "Default model")}</span>
                      <IconChevronDown size={12} />
                    </button>
                  )}
                  {oneRuntime && (oneRuntime.efforts?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className={styles.composerChip}
                      data-one-composer-trigger="effort"
                      disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
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
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
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
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
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
                    disabled={busy || selectedReadOnly || teamDecisionPending || teamPreflightBusy}
                  />
                  {(busy || composer.trim() || attachmentDrafts.length > 0) && (
                    <button
                      type="submit"
                      className={styles.sendButton}
                      data-one-steering-send={busy && composer.trim() ? "true" : undefined}
                      disabled={!busy && ((!composer.trim() && attachmentDrafts.length === 0) || selectedReadOnly || teamDecisionPending || teamPreflightBusy)}
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

      {/* /one lives in the no-shell route group, so AppShell's global browser
          approval listener is not mounted here. Keep the native approval
          checkpoint in this route explicitly; otherwise browser actions can
          wait behind an invisible sheet. */}
      <BrowserActionApprovalSheet />

      {keyRequestSheet && (
        <McpKeyRequestSheet
          request={keyRequestSheet}
          presentation="one"
          localeOverride={appLocale}
          onResolved={() => setKeyRequestSheet(null)}
        />
      )}

      <OneProjectSessionSheet
        open={projectSessionSheetOpen}
        locale={appLocale}
        chatId={activeThreadChatId}
        workspaceGrant={workspaceGrant}
        workspacePath={workspacePath}
        onClose={() => setProjectSessionSheetOpen(false)}
        onWorkspaceSelected={async (grant) => {
          setWorkspaceGrant(grant);
          setWorkspacePath(grant.path);
          const api = ipc();
          if (api && activeThreadChatId) await api.workspace.set(activeThreadChatId, grant);
        }}
        onImported={async (target) => {
          await refreshAll();
          openTask(target.taskId);
        }}
      />

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
  return (
    <OneBottomSheet
      open
      onClose={onDismiss}
      closeLabel={tFor(locale, "one.shell.decision.close")}
      ariaLabelledBy="one-decision-sheet-title"
      size="wide"
      title={locale === "ko" ? "결정이 필요해요" : "A decision is needed"}
      titleId="one-decision-sheet-title"
      description={locale === "ko" ? "One이 계속 진행하기 전에 선택을 기다리고 있습니다." : "One is waiting for your choice before it continues."}
    >
      <div className={styles.decisionSheet}>
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
    </OneBottomSheet>
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
