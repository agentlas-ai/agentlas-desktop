// 동기 질문 채널 — 에이전트가 **답을 기다릴 수 있는** 질문.
//
// ★왜 필요한가. 기존 질문(`<<agentlas-ask>>` 펜스)은 비동기다: 답을 던지고 실행이
// 끝나고, 사용자의 다음 채팅 메시지가 답이 된다. 대화에서는 자연스럽지만 **도구로는
// 쓸 수 없다** — 도구는 결과를 받아 다음 단계로 가야 하는데 기다릴 방법이 없다.
// 그래서 인터뷰가 필요한 빌드는 "물어보고 자기 마음대로 진행"하거나 멈춰야 했다.
//
// 구조는 browser/connect.ts 의 승인 왕복과 같다(pending 맵 + 렌더러 채널 + 만료).
// 새 구조를 만들지 않는 이유: 그 왕복은 이미 취소·만료·창 없음까지 겪어 본 형태다.
//
// 채널 규칙(UNIVERSAL-RUNTIME-FEATURES-PLAN §2.3):
//  - 데스크탑 창이 있으면 진짜 시트로 묻는다.
//  - 창이 없거나(플러그인·헤드리스) 무인 실행이면 **묻지 않고 즉시 강등**한다.
//    기다릴 사람이 없는데 기다리는 것은 멈춤이지 질문이 아니다.
import { randomUUID } from "node:crypto";
import type { AskUserRequestEvent } from "../../shared/types";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserRequest {
  question: string;
  options?: AskUserOption[];
  /** 자유 입력도 받을지. 선택지만 있는 질문이면 false. */
  allowFreeText?: boolean;
  /** 누가 묻는지 — 시트에 보인다. */
  askedBy?: string;
  chatId?: string;
}

export type AskUserOutcome =
  | { status: "answered"; answer: string }
  | { status: "declined" }
  /** 물을 표면이 없다 — 호출자는 강등해야 한다(추측해서 진행하면 안 된다). */
  | { status: "no-surface" }
  | { status: "timeout" }
  | { status: "cancelled" };

interface PendingAsk {
  resolve: (outcome: AskUserOutcome) => void;
  timer: NodeJS.Timeout;
  payload: AskUserRequestEvent;
}

const ASK_CHANNEL = "agentlas:ask-user";
const pending = new Map<string, PendingAsk>();
const lifecycleListeners = new Set<(event: AskUserRequestEvent) => boolean>();

/** 사람이 카드를 보고 답할 시간. 넘으면 timeout — 추측한 답을 만들지 않는다. */
const ASK_TIMEOUT_MS = 10 * 60_000;

function emitToRenderer(payload: unknown): boolean {
  // The packaged daemon imports this module through the approval runtime but
  // has no Electron module or renderer. Resolve Electron only when a visible
  // question is actually attempted; headless hosts degrade to no-surface.
  let windows: Array<{
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, payload: unknown) => void };
  }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as {
      BrowserWindow?: {
        getAllWindows?: () => typeof windows;
      };
    };
    windows = electron.BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    return false;
  }
  windows = windows.filter((window) => !window.isDestroyed());
  if (windows.length === 0) return false;
  for (const window of windows) {
    try {
      window.webContents.send(ASK_CHANNEL, payload);
    } catch {
      /* 창이 방금 닫혔다 — 남은 창들로 계속 */
    }
  }
  return true;
}

function emitToMobileSurface(payload: AskUserRequestEvent): boolean {
  let emitted = false;
  for (const listener of lifecycleListeners) {
    try {
      if (listener(payload)) emitted = true;
    } catch {
      /* A disconnected Mobile listener must not interrupt another surface. */
    }
  }
  return emitted;
}

function emitToQuestionSurfaces(payload: AskUserRequestEvent): boolean {
  // Call both paths independently: renderer success must not short-circuit a
  // paired phone, and a Mobile listener must keep headless One/Work answerable.
  const rendererEmitted = emitToRenderer(payload);
  const mobileEmitted = emitToMobileSurface(payload);
  return rendererEmitted || mobileEmitted;
}

/**
 * 사용자에게 묻고 **답을 기다린다.**
 *
 * 창이 없거나 무인 실행이면 기다리지 않고 `no-surface` 를 돌려준다. 호출자는 그때
 * 추측하지 말고 강등해야 한다 — 답이 없는데 있는 척하는 것이 이 채널이 막으려는 것이다.
 */
export function askUser(
  req: AskUserRequest,
  opts: { unattended?: boolean; signal?: AbortSignal } = {},
): Promise<AskUserOutcome> {
  const question = req.question?.trim();
  if (!question) return Promise.resolve({ status: "declined" });
  if (opts.unattended) return Promise.resolve({ status: "no-surface" });
  if (opts.signal?.aborted) return Promise.resolve({ status: "cancelled" });

  const requestId = randomUUID();
  const createdAt = Date.now();
  const payload: AskUserRequestEvent = {
    requestId,
    question,
    options: (req.options ?? []).slice(0, 8).map((o) => ({
      label: String(o.label ?? "").slice(0, 200),
      ...(o.description ? { description: String(o.description).slice(0, 400) } : {}),
    })),
    allowFreeText: req.allowFreeText !== false,
    askedBy: req.askedBy ?? null,
    chatId: req.chatId ?? null,
    createdAt,
    expiresAt: createdAt + ASK_TIMEOUT_MS,
  };

  return new Promise<AskUserOutcome>((resolve) => {
    let abortListener: (() => void) | null = null;
    const settle = (outcome: AskUserOutcome): void => {
      const entry = pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(requestId);
      if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
      emitToQuestionSurfaces({ ...entry.payload, expiresAt: 0 });
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      // 만료는 이번 질문만 끝낸다. 답을 지어내지 않는다.
      settle({ status: "timeout" });
    }, ASK_TIMEOUT_MS);
    pending.set(requestId, { resolve: settle, timer, payload });

    if (!emitToQuestionSurfaces(payload)) {
      // 그릴 창이 없다 — 플러그인·헤드리스 표면이다. 기다리면 그냥 멈춘 실행이 된다.
      settle({ status: "no-surface" });
      return;
    }
    if (opts.signal) {
      abortListener = () => {
        settle({ status: "cancelled" });
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

/** 렌더러가 답을 보냈다. 알 수 없는 id 는 조용히 버린다(이미 만료·취소된 질문). */
export function submitAskUserAnswer(requestId: string, answer: string | null): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  entry.resolve(
    typeof answer === "string" && answer.trim()
      ? { status: "answered", answer: answer.trim() }
      : { status: "declined" },
  );
  return true;
}

/** 대기 중인 질문 수 — 테스트와 진단용. */
export function pendingAskUserCount(): number {
  return pending.size;
}

/** Safe pending rows for authenticated projections. Callers still own scope filtering. */
export function listPendingAskUserRequests(): AskUserRequestEvent[] {
  return [...pending.values()].map(({ payload }) => ({
    ...payload,
    options: payload.options.map((option) => ({ ...option })),
  }));
}

/**
 * A listener is an answer-capable surface. The Mobile authority attaches this
 * only while at least one authenticated bridge client is subscribed.
 */
export function onAskUserLifecycle(
  listener: (event: AskUserRequestEvent) => boolean,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

export const ASK_USER_CHANNEL = ASK_CHANNEL;
