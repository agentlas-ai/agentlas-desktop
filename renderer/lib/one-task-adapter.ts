import type {
  AgentlasIpc,
  CanonicalTask,
  CanonicalTaskWorkTarget,
  Chat,
  InvocationRunReceipt,
  OneProfile,
  PendingConfirmation,
} from "@/lib/types";
import { isPendingConfirmationSnoozed } from "@shared/one-decision";
import { isAgentlasOneTaskProjectionV1 } from "@shared/one-task-projection";
import { detectOneTextLocale } from "@/lib/one-conversation-locale";

export const ONE_INTRO_VERSION = 1;
export const ONE_INTRO_ACK_KEY = "agentlas.one.acknowledgedIntroVersion";

export type OneProjectionStatus =
  | "waiting"
  | "working"
  | "decision_required"
  | "completed"
  | "failed"
  | "stopped";

export type OneProjectionSource = "authoritative_event" | "cached_projection";

export type OneSemanticActionIntent =
  | "open_work"
  | "approve_decision"
  | "reject_decision"
  | "modify_decision"
  | "snooze_decision"
  | "open_artifact"
  | "open_sources"
  | "open_receipt"
  | "retry_failed_step"
  | "cancel_task"
  | "resume_task"
  | "save_result"
  | "change_conditions"
  | "view_details"
  | "edit_asset"
  | "disable_asset"
  | "use_once"
  | "delete_asset"
  | "reopen_intro"
  | "connect_desktop";

export interface OneSemanticAction {
  actionId: string;
  intent: OneSemanticActionIntent;
  label: string;
  targetRef?: string;
  enabled: boolean;
  blockedReason?: string;
}

export interface OneTaskProjection {
  contractVersion: string;
  taskId: string;
  canonicalVersion: number;
  oneId: string;
  projectionSurface: "one";
  projectionMode: "summary" | "detailed" | "approval_focused";
  display: { title: string; summary: string };
  status: { value: OneProjectionStatus; source: OneProjectionSource; asOf: string };
  sync: {
    connection: "online" | "degraded" | "offline";
    lastSyncedAt: string | null;
    authoritativeHostRef: string | null;
    executionAuthorityAvailable: boolean;
    mutationMode: "direct" | "queue_only" | "read_only";
    queuedOperationCount: number;
  };
  truth: { mayStartExecution: boolean; mayClaimNewCompletion: boolean };
  references: {
    teamRunId?: string;
    manifestId?: string;
    decisionIds: string[];
    artifactIds: string[];
    receiptIds: string[];
  };
  availableActions: OneSemanticAction[];
  pendingOperations: unknown[];
  /** Transitional local binding. It is not part of the public projection contract. */
  canonicalStatus: CanonicalTask["status"] | null;
  chatId: string | null;
  chat: Chat | null;
  latestReceipt: InvocationRunReceipt | null;
}

export interface OneBriefing {
  kind: "decision" | "working" | "failed" | "result_ready" | "quiet";
  eyebrow: string;
  title: string;
  body: string;
  prepared: string;
  evidence: string[];
  taskId?: string;
  primaryLabel?: string;
}

function localizedBriefingBody(
  value: string | null | undefined,
  locale: "ko" | "en",
  fallback: [string, string],
): string {
  const text = value?.trim() ?? "";
  if (!text) return fallback[locale === "ko" ? 0 : 1];
  const detected = detectOneTextLocale(text);
  if (detected && detected !== locale) {
    return fallback[locale === "ko" ? 0 : 1];
  }
  return text;
}

function localizedFailureBriefingBody(errorMessage: string | null | undefined, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  const message = errorMessage?.toLowerCase() ?? "";
  if (/webfetch|web fetch|website|page|url|http|network|fetch/.test(message)) {
    return ko
      ? "웹페이지 하나를 확인하지 못했어요. 잠시 뒤 다시 부탁하면 이어서 확인할게요."
      : "One could not check one of the webpages. Try again in a moment.";
  }
  if (/permission|denied|unauthori[sz]ed|forbidden|access/.test(message)) {
    return ko
      ? "필요한 파일이나 서비스에 접근하지 못했어요. 연결 상태를 확인한 뒤 다시 부탁해 주세요."
      : "One could not access a required file or service. Check the connection, then try again.";
  }
  if (/timeout|timed out|deadline/.test(message)) {
    return ko
      ? "확인 시간이 너무 길어져 멈췄어요. 다시 부탁하면 한 번 더 시도할게요."
      : "The check took too long and stopped. Ask again and One will try once more.";
  }
  return ko
    ? "확인 과정 일부가 멈췄어요. 작업을 열어 남은 내용을 확인할 수 있어요."
    : "Part of the check stopped. Open the task to review what remains.";
}

type ProjectionTasksBridge = {
  listProjections?: (input?: unknown) => Promise<unknown>;
  getProjection?: (taskId: string, input?: unknown) => Promise<unknown>;
  openInWork?: (taskId: string) => Promise<CanonicalTaskWorkTarget | null>;
};

function optionalTasksBridge(api: AgentlasIpc): ProjectionTasksBridge | null {
  const candidate = (api as unknown as { tasks?: ProjectionTasksBridge }).tasks;
  return candidate && typeof candidate === "object" ? candidate : null;
}

async function persistedOneId(api: AgentlasIpc, profile?: OneProfile | null): Promise<string> {
  if (profile?.oneId) return profile.oneId;
  try {
    return (await api.oneProfile.get()).oneId;
  } catch {
    // A projection without Main's durable identity is explicitly unavailable;
    // it must never silently fall back to a second local One identity.
    return "one:unavailable";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjection(value: unknown, authoritativeOneId?: string): OneTaskProjection | null {
  if (!isAgentlasOneTaskProjectionV1(value) || value.projectionSurface !== "one") return null;
  if (authoritativeOneId && value.oneId !== authoritativeOneId) return null;
  return {
    contractVersion: value.contractVersion,
    taskId: value.taskId,
    canonicalVersion: value.canonicalVersion,
    oneId: value.oneId,
    projectionSurface: "one",
    projectionMode: value.projectionMode,
    display: { ...value.display },
    status: { ...value.status },
    sync: { ...value.sync },
    truth: { ...value.truth },
    references: {
      ...(value.references.teamRunId ? { teamRunId: value.references.teamRunId } : {}),
      ...(value.references.manifestId ? { manifestId: value.references.manifestId } : {}),
      decisionIds: [...value.references.decisionIds],
      artifactIds: [...value.references.artifactIds],
      receiptIds: [...value.references.receiptIds],
    },
    availableActions: value.availableActions.map((action) => ({ ...action })),
    pendingOperations: value.pendingOperations.map((operation) => ({ ...operation })),
    canonicalStatus: null,
    chatId: null,
    chat: null,
    latestReceipt: null,
  };
}

function statusForCanonicalTask(task: CanonicalTask): OneProjectionStatus {
  if (task.status === "running") return "working";
  if (task.status === "waiting-decision") return "decision_required";
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "stopped";
  if (task.status === "archived") return "stopped";
  return "waiting";
}

function canonicalProjection(
  task: CanonicalTask,
  chat: Chat | null,
  confirmations: Map<string, PendingConfirmation>,
  _receipt: InvocationRunReceipt | null,
  oneId: string,
): OneTaskProjection {
  const chatId = task.originChatId;
  const decision = chatId ? confirmations.get(chatId) : undefined;
  const value: OneProjectionStatus =
    task.status === "running"
      ? "working"
      : task.status === "waiting-decision"
        ? "decision_required"
        : task.status === "completed"
          ? "completed"
          : task.status === "failed"
            ? "failed"
            : task.status === "cancelled"
              ? "stopped"
            : task.status === "archived"
              ? "stopped"
              : "waiting";
  // A completed invocation receipt proves only that one run ended. Task
  // completion comes exclusively from the canonical Task lifecycle in Main.
  const status: OneTaskProjection["status"] = {
    value,
    source: "authoritative_event",
    asOf: task.updatedAt,
  };
  return {
    contractVersion: "1.0.0",
    taskId: task.id,
    canonicalVersion: task.version,
    oneId,
    projectionSurface: "one",
    projectionMode: decision ? "approval_focused" : "summary",
    display: {
      title: task.title.trim() || chat?.title.trim() || "새로운 일",
      summary: decision?.question ?? "One과 Work가 같은 정본 Task를 보고 있습니다.",
    },
    status,
    sync: {
      connection: "online",
      lastSyncedAt: status.asOf,
      authoritativeHostRef: "desktop:local",
      executionAuthorityAvailable: Boolean(chatId),
      mutationMode: chatId ? "direct" : "read_only",
      queuedOperationCount: 0,
    },
    truth: {
      mayStartExecution: Boolean(chatId) && status.value !== "working",
      mayClaimNewCompletion: task.status === "completed",
    },
    references: {
      decisionIds: decision ? [decision.sourceMessageId] : [],
      artifactIds: [],
      // The renderer fallback cannot prove that a chat receipt belongs to this
      // Task. Only Main's canonical projection may bind Task receipt refs.
      receiptIds: [],
    },
    availableActions: [
      {
        actionId: "action:open-work",
        intent: "open_work",
        label: "Open in Work",
        targetRef: task.id,
        enabled: true,
      },
      ...(decision ? [{
        actionId: "action:approve-decision",
        intent: "approve_decision" as const,
        label: "Approve decision",
        targetRef: decision.sourceMessageId,
        enabled: Boolean(chatId),
        ...(!chatId ? { blockedReason: "Execution authority is unavailable." } : {}),
      }] : []),
    ],
    pendingOperations: [],
    canonicalStatus: task.status,
    chatId,
    chat,
    latestReceipt: null,
  };
}

/**
 * Prefer the canonical projection bridge when it exists. The legacy chat path
 * remains a conservative local projection only. A run receipt may describe a
 * run closure, but completion is never inferred for a canonical Task; only the
 * Main-owned Task lifecycle can grant that state.
 */
export async function listOneTaskProjections(
  api: AgentlasIpc,
  _activeChatIds: string[],
  pendingConfirmations: PendingConfirmation[],
  profile?: OneProfile | null,
): Promise<OneTaskProjection[]> {
  const oneId = await persistedOneId(api, profile);
  const bridge = optionalTasksBridge(api);
  if (bridge?.listProjections) {
    try {
      const payload = await bridge.listProjections({ surface: "one", mode: "summary" });
      const items = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.items)
          ? payload.items
          : [];
      const projections = items
        .map((item) => normalizeProjection(item, oneId))
        .filter((item): item is OneTaskProjection => Boolean(item));
      if (projections.length > 0) {
        const canonicalTasks = await api.tasks.list({ limit: 40, includeArchived: true }).catch(() => []);
        const canonicalById = new Map(canonicalTasks.map((task) => [task.id, task]));
        const hydrated = await Promise.all(projections.map(async (projection) => {
          const task = canonicalById.get(projection.taskId);
          if (
            !task
            || task.version !== projection.canonicalVersion
            || statusForCanonicalTask(task) !== projection.status.value
          ) return null;
          const [chat, latestReceipt] = task.originChatId
            ? await Promise.all([
                api.chats.get(task.originChatId).catch(() => null),
                api.invoke.latestReceipt(task.originChatId).catch(() => null),
              ])
            : [null, null] as const;
          return {
            ...projection,
            canonicalStatus: task.status,
            chatId: task.originChatId,
            chat,
            latestReceipt: latestReceipt && projection.references.receiptIds.includes(latestReceipt.runId)
              ? latestReceipt
              : null,
          };
        }));
        return hydrated.filter((item): item is NonNullable<(typeof hydrated)[number]> => item !== null);
      }
    } catch {
      // Transitional fallback keeps existing users able to reach their work.
    }
  }

  // Transitional fallbacks must respect the same membership rule as Main:
  // One shows only work that One itself started, never the global Work list.
  const canonicalTasks = await api.tasks.list({ limit: 40 }).catch(() => []);
  if (canonicalTasks.length > 0) {
    const confirmations = new Map(pendingConfirmations.map((item) => [item.chatId, item]));
    const details = await Promise.all(
      canonicalTasks.map(async (task) => {
        const chat = task.originChatId ? await api.chats.get(task.originChatId).catch(() => null) : null;
        if (chat?.originSurface !== "one") return null;
        return canonicalProjection(task, chat, confirmations, null, oneId);
      }),
    );
    return details.filter((item): item is OneTaskProjection => Boolean(item));
  }

  const chats = (await api.chats.listRecent(40)).filter((chat) => chat.originSurface === "one");
  const linkedTasks = await Promise.all(chats.map((chat) => api.tasks.findForChat(chat.id).catch(() => null)));
  const taskPairs = chats.flatMap((chat, index) => {
    const task = linkedTasks[index];
    return task ? [{ chat, task }] : [];
  });
  const confirmations = new Map(pendingConfirmations.map((item) => [item.chatId, item]));
  return taskPairs.map(({ chat, task }) =>
    canonicalProjection(task, chat, confirmations, null, oneId));
}

export async function getOneTaskProjection(
  api: AgentlasIpc,
  taskId: string,
  _activeChatIds: string[],
  pendingConfirmations: PendingConfirmation[],
  profile?: OneProfile | null,
): Promise<OneTaskProjection | null> {
  const oneId = await persistedOneId(api, profile);
  const bridge = optionalTasksBridge(api);
  if (bridge?.getProjection) {
    try {
      const normalized = normalizeProjection(
        await bridge.getProjection(taskId, { surface: "one", mode: "detailed" }),
        oneId,
      );
      if (normalized) {
        const task = await api.tasks.get(taskId).catch(() => null);
        if (
          !task
          || task.version !== normalized.canonicalVersion
          || statusForCanonicalTask(task) !== normalized.status.value
        ) return null;
        const [chat, latestReceipt] = task.originChatId
          ? await Promise.all([
              api.chats.get(task.originChatId).catch(() => null),
              api.invoke.latestReceipt(task.originChatId).catch(() => null),
            ])
          : [null, null] as const;
        return {
          ...normalized,
          canonicalStatus: task.status,
          chatId: task.originChatId,
          chat,
          latestReceipt: latestReceipt && normalized.references.receiptIds.includes(latestReceipt.runId)
            ? latestReceipt
            : null,
        };
      }
    } catch {
      // Continue to the exact local origin chat when the optional bridge is unavailable.
    }
  }
  const canonical = await api.tasks.get(taskId).catch(() => null);
  if (canonical) {
    const chat = canonical.originChatId ? await api.chats.get(canonical.originChatId).catch(() => null) : null;
    // Same membership rule as Main: a global Work task never renders inside One.
    if (chat?.originSurface !== "one") return null;
    return canonicalProjection(
      canonical,
      chat,
      new Map(pendingConfirmations.map((item) => [item.chatId, item])),
      null,
      oneId,
    );
  }
  return null;
}

/**
 * Ask Main where this Task actually lives in Work.
 *
 * Returns the verified destination, or null when Main cannot confirm one — the
 * caller must then keep the user where they are rather than navigating to a
 * conversation that may no longer exist.
 */
export async function resolveOneTaskWorkTarget(
  api: AgentlasIpc,
  taskId: string,
): Promise<CanonicalTaskWorkTarget | null> {
  const bridge = optionalTasksBridge(api);
  if (!bridge?.openInWork) return null;
  try {
    const target = await bridge.openInWork(taskId);
    if (!target || typeof target.chatId !== "string" || !target.chatId) return null;
    return target;
  } catch {
    return null;
  }
}

export function chooseOneBriefing(
  projections: OneTaskProjection[],
  confirmations: PendingConfirmation[],
  locale: "ko" | "en",
): OneBriefing {
  const ko = locale === "ko";
  const confirmation = confirmations
    .filter((item) => !isPendingConfirmationSnoozed(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (confirmation) {
    const task = projections.find((item) => item.chatId === confirmation.chatId);
    return {
      kind: "decision",
      eyebrow: ko ? "결정 필요" : "Decision needed",
      title: ko ? "진행하려면 한 가지 결정이 필요해요." : "One decision is needed to continue.",
      body: localizedBriefingBody(
        confirmation.question,
        locale,
        ["확인할 결정을 준비했어요.", "One prepared a decision for you to review."],
      ),
      prepared: ko
        ? `${confirmation.optionCount}개 선택지를 준비했습니다.`
        : `${confirmation.optionCount} option${confirmation.optionCount === 1 ? "" : "s"} prepared.`,
      evidence: [
        `${ko ? "일" : "Work"}: ${confirmation.chatTitle || task?.display.title || confirmation.chatId}`,
        `${ko ? "요청 시각" : "Requested"}: ${formatTimestamp(confirmation.createdAt, locale)}`,
      ],
      taskId: task?.taskId,
      primaryLabel: ko ? "결정 보기" : "Review decision",
    };
  }
  const failed = projections.find((item) => item.status.value === "failed");
  if (failed) {
    return {
      kind: "failed",
      eyebrow: ko ? "확인 필요" : "Needs attention",
      title: ko ? "멈춘 작업이 하나 있어요." : "One task stopped before completion.",
      body: localizedFailureBriefingBody(failed.latestReceipt?.errorMessage, locale),
      prepared: ko
        ? "멈추기 전까지 나온 내용과 다시 시작할 위치를 자세히 볼 수 있어요."
        : "You can review what was completed and where to continue.",
      evidence: [`${ko ? "마지막 실행" : "Last run"}: ${formatTimestamp(failed.status.asOf, locale)}`],
      taskId: failed.taskId,
      primaryLabel: ko ? "확인하기" : "Inspect task",
    };
  }
  const working = projections.find((item) => item.status.value === "working");
  if (working) {
    return {
      kind: "working",
      eyebrow: ko ? "진행 중" : "In progress",
      title: ko ? "팀이 한 가지 일을 진행하고 있어요." : "Your team is working on one task.",
      body: localizedBriefingBody(
        working.display.title,
        locale,
        ["현재 진행 중인 일을 열어볼 수 있어요.", "Open the task to see the work in progress."],
      ),
      prepared: ko
        ? "완료됐다고 추측하지 않고 실제 진행 상황만 보여드려요."
        : "One shows only the actual progress and never guesses that the work is done.",
      evidence: [`${ko ? "마지막 상태" : "Last status"}: ${formatTimestamp(working.status.asOf, locale)}`],
      taskId: working.taskId,
      primaryLabel: ko ? "진행 보기" : "View progress",
    };
  }
  const resultReady = projections
    .filter((item) => item.canonicalStatus === "partial")
    .sort((left, right) => right.status.asOf.localeCompare(left.status.asOf))[0];
  if (resultReady) {
    return {
      kind: "result_ready",
      eyebrow: ko ? "결과 도착" : "Result ready",
      title: ko ? "확인할 결과가 하나 준비됐어요." : "One result is ready for you.",
      body: localizedBriefingBody(
        resultReady.display.title,
        locale,
        ["One이 준비한 결과를 열어 확인해보세요.", "Open the result to review what One prepared."],
      ),
      prepared: ko
        ? "괜찮으면 바로 마무리하고, 바꿀 점은 그대로 말하면 됩니다."
        : "Finish it as-is, or tell One what you want changed.",
      evidence: [`${ko ? "준비된 시각" : "Ready"}: ${formatTimestamp(resultReady.status.asOf, locale)}`],
      taskId: resultReady.taskId,
      primaryLabel: ko ? "결과 확인하기" : "Review result",
    };
  }
  return {
    kind: "quiet",
    eyebrow: ko ? "오늘" : "Today",
    title: ko ? "오늘 새로 챙겨야 할 일은 없어요." : "Nothing new needs you today.",
    body: ko
      ? "하고 싶은 일을 말하면 One이 필요한 사람과 도구를 알아서 준비할게요."
      : "Tell One what you want done. It will bring the right people and tools when needed.",
    prepared: "",
    evidence: [],
  };
}

export function formatTimestamp(value: string | null | undefined, locale: "ko" | "en"): string {
  if (!value) return locale === "ko" ? "확인되지 않음" : "Not verified";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
