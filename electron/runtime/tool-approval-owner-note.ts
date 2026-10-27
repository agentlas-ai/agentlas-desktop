import { createHash } from "node:crypto";
import type {
  McpInvocationRequest,
  ToolApprovalDecision,
  ToolApprovalOwnerNoteReceipt,
  ToolApprovalResolutionReceipt,
} from "../../shared/types";
import { carriedFollowupRequest } from "../invocation/carried-owner-followups";

/*
 * "아니오, 그리고 대신 이렇게 하세요" — 거절하면서 오너가 한 줄을 같이 보낸다 (오너 2026-10-27, Claude Code·Codex 의 승인 프롬프트와 같은 선택지).
 *
 * 이 줄이 에이전트에게 닿는 길은 **하나**다: 그 승인이 붙어 있던 방의 오너 메시지. 실행기마다 거절을 돌려주는 자리가 달라서
 * (claude-code·antigravity·grok 은 헤드리스라 이미 거부하고 지나간 뒤, codex·ACP 의 거절 응답과 우리 도구 루프의 거부
 * 결과는 이유 글자를 실을 자리가 없거나 실행기마다 모양이 다르다) 거절 영수증에 사유를 싣는 길은 7종×API×로컬 모델에서 같지 않다.
 * 방의 오너 메시지는 이미 모든 실행기·모든 호스트가 같게 받는다: 진행 중인 실행에는 방향 지시(steer), 아닌 방에는 다음 메시지로
 * 큐가 받고, 데몬이 쥔 방은 데몬 경로로 간다. 그 길을 새로 만들지 않고 ipc.ts 의 invoke:steer 몸통을 그대로 쓴다(`install`).
 *
 * 정확히 한 번: 줄은 "거절이 이 호출로 확정됐을 때(status resolved + deny)"만 나간다. 같은 결정의 재전송(replayed)·충돌·만료는
 * 보내지 않는다. 그 위에 의도 id 가 요청 id 에서 결정적으로 나와 steer 쪽 내구 행(`owner:<intentId>`)이 한 번 더 막아 준다.
 * 모델에 들어가는 새 글은 만들지 않는다 — 오너가 쓴 글이 그대로 오너 메시지가 된다.
 */

/** 오너가 한 줄에 쓸 수 있는 글자 수(코드 포인트). 화면 입력칸의 maxLength 와 폰이 같은 값을 쓴다. */
export const APPROVAL_OWNER_NOTE_MAX_CHARS = 500;

/**
 * 오너가 쓴 글이라 비밀 패턴을 가리지 않는다(오너 메시지는 원래 그대로 모델에 간다). 제어문자는 지우고, 줄바꿈·탭은 공백 하나로 접어
 * "한 줄"을 지킨다. 비면 null — 빈 줄은 note 없는 거절과 같다.
 */
export function sanitizeApprovalOwnerNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flattened = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    // 방향·보이지 않는 서식 문자는 화면과 모델이 서로 다른 글을 읽게 만든다.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return null;
  const points = Array.from(flattened);
  return (points.length > APPROVAL_OWNER_NOTE_MAX_CHARS ? points.slice(0, APPROVAL_OWNER_NOTE_MAX_CHARS).join("") : flattened).trim() || null;
}

/** 요청 하나당 줄 하나의 결정적 의도 id — steer 의 내구 행과 보내기 큐가 같은 줄의 두 번째 도착을 알아본다. */
export function approvalOwnerNoteIntentId(requestId: string): string {
  return `approval-note:${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

export interface ApprovalOwnerNoteRoom {
  /** One 대화는 One 계약으로, 그 밖은 Work 계약으로 이어진다(invocation/service.ts: oneMode ⇔ originSurface "one"). */
  oneMode: boolean;
  permissions: "read" | "write" | "full";
  locale: "ko" | "en";
}

export interface ApprovalOwnerNotePorts {
  /** 오너의 줄을 방에 넣는다. 방(또는 방의 보내기 큐)이 받았을 때 끝나고, 받을 수 없으면 던진다. */
  send(request: McpInvocationRequest, intentId: string, event?: unknown): Promise<unknown>;
  /** 방이 줄을 받을 수 있는 대화인가, 받는다면 어떤 계약인가. */
  room(chatId: string): ApprovalOwnerNoteRoom | null;
}

let installedSend: ApprovalOwnerNotePorts["send"] | null = null;
/** ipc.ts 가 invoke:steer 와 같은 몸통을 꽂는다. 꽂지 않은 호스트(데몬 단독 등)는 줄을 못 보낸다 — failed("owner_note_sender_missing"). */
export function installApprovalOwnerNoteSender(send: ApprovalOwnerNotePorts["send"] | null): void {
  installedSend = send;
}

function defaultRoom(chatId: string): ApprovalOwnerNoteRoom | null {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(chatId);
  if (!chat || chat.archivedAt) return null;
  let permissions: ApprovalOwnerNoteRoom["permissions"] = "read"; // 알 수 없으면 읽기 전용이 안전한 기본이다
  try {
    permissions = (require("../invocation/service") as typeof import("../invocation/service")).invocationService
      .latestOwnerReceipt(chatId)?.executionPermission ?? "read";
  } catch { /* read-only */ }
  let locale: "ko" | "en" = "en";
  try { locale = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en"; } catch { /* en */ }
  return { oneMode: chat.originSurface === "one", permissions, locale };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function defaultPorts(): ApprovalOwnerNotePorts {
  return {
    send: (request, intentId, event) => {
      if (!installedSend) return Promise.reject(Object.assign(new Error("owner_note_sender_missing"), { code: "owner_note_sender_missing" }));
      return installedSend(request, intentId, event);
    },
    room: defaultRoom,
  };
}

const delivered = new Map<string, ToolApprovalOwnerNoteReceipt>();
const DELIVERED_LIMIT = 500;

function failureCode(error: unknown): string {
  for (const raw of [(error as { code?: unknown } | null)?.code, (error as { message?: unknown } | null)?.message]) {
    if (typeof raw === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{2,95}$/.test(raw)) return raw.toLowerCase();
  }
  return "owner_note_send_failed";
}

/** 오너의 줄을 승인이 붙어 있던 방에 오너 메시지로 넣는다. 요청 하나에 한 번. */
export async function deliverApprovalOwnerNote(
  input: { requestId: string; chatId: string; note: string; event?: unknown },
  ports: ApprovalOwnerNotePorts = defaultPorts(),
): Promise<ToolApprovalOwnerNoteReceipt> {
  const earlier = delivered.get(input.requestId);
  if (earlier) return earlier;
  let receipt: ToolApprovalOwnerNoteReceipt;
  try {
    const room = ports.room(input.chatId);
    if (!room) receipt = { status: "failed", code: "room_unavailable" };
    else {
      const base = carriedFollowupRequest({
        chatId: input.chatId,
        userPrompt: input.note,
        permissions: room.permissions,
        locale: room.locale,
        ...(room.oneMode ? { oneMode: true as const, onePermissionMode: "auto" as const } : {}),
      } as McpInvocationRequest, input.note);
      // 진행 중인 턴을 끊지 않는다 — 큐에 서고 턴이 끝나는 대로 다음 메시지가 된다(Work 작성창 steeringMode 기본값과 같다).
      await ports.send({ ...base, steeringMode: "queue" }, approvalOwnerNoteIntentId(input.requestId), input.event);
      receipt = { status: "sent" };
    }
  } catch (error) {
    receipt = { status: "failed", code: failureCode(error) };
  }
  delivered.set(input.requestId, receipt);
  while (delivered.size > DELIVERED_LIMIT) {
    const oldest = delivered.keys().next();
    if (oldest.done) break;
    delivered.delete(oldest.value);
  }
  return receipt;
}

/** 시험 전용: 이 프로세스가 기억하는 전달 기록을 비운다. */
export function resetApprovalOwnerNoteDeliveries(): void { delivered.clear(); }

/**
 * 도구 승인 결정 + (거절일 때) 오너의 줄. `resolve` 는 호출한 쪽 호스트의 원래 결정 길(Main 의 resolveToolApproval, 데몬이 쥔 승인,
 * 폰의 native 선택)이고 영수증을 그대로 돌려준다 — 이 함수는 영수증을 바꾸지 않고 `ownerNote` 만 더한다.
 */
export async function resolveToolApprovalWithOwnerNote(
  input: {
    decision: ToolApprovalDecision;
    note: unknown;
    /** 결정 전에 읽어 둔 요청의 방. 없으면(방 없는 실행) 줄을 보낼 곳이 없다. */
    chatId: string | undefined | null;
    requestId: string;
    event?: unknown;
    resolve: () => ToolApprovalResolutionReceipt | Promise<ToolApprovalResolutionReceipt>;
  },
  ports?: ApprovalOwnerNotePorts,
): Promise<ToolApprovalResolutionReceipt> {
  const receipt = await input.resolve();
  const note = sanitizeApprovalOwnerNote(input.note);
  if (note === null) return receipt;
  if (input.decision !== "deny") return { ...receipt, ownerNote: { status: "skipped", code: "not_denied" } };
  if (receipt.status === "replayed") return { ...receipt, ownerNote: { status: "skipped", code: "replayed" } };
  if (!(receipt.ok && receipt.status === "resolved" && receipt.resolvedDecision === "deny")) {
    return { ...receipt, ownerNote: { status: "skipped", code: receipt.status } };
  }
  if (!input.chatId) return { ...receipt, ownerNote: { status: "skipped", code: "no_room" } };
  const ownerNote = await deliverApprovalOwnerNote({ requestId: input.requestId, chatId: input.chatId, note, event: input.event }, ports);
  return { ...receipt, ownerNote };
}

/** 브라우저 승인: 같은 규칙. 결정이 이 호출로 확정(ok)된 거절만 줄을 보낸다(이미 사라진 요청은 ok:false). */
export async function resolveBrowserApprovalWithOwnerNote(
  input: {
    decision: string;
    note: unknown;
    chatId: string | undefined | null;
    requestId: string;
    event?: unknown;
    resolve: () => { ok: boolean };
  },
  ports?: ApprovalOwnerNotePorts,
): Promise<{ ok: boolean; ownerNote?: ToolApprovalOwnerNoteReceipt }> {
  const result = input.resolve();
  const note = sanitizeApprovalOwnerNote(input.note);
  if (note === null) return result;
  if (input.decision !== "deny") return { ...result, ownerNote: { status: "skipped", code: "not_denied" } };
  if (!result.ok) return { ...result, ownerNote: { status: "skipped", code: "not_pending" } };
  if (!input.chatId) return { ...result, ownerNote: { status: "skipped", code: "no_room" } };
  return { ...result, ownerNote: await deliverApprovalOwnerNote({ requestId: input.requestId, chatId: input.chatId, note, event: input.event }, ports) };
}
