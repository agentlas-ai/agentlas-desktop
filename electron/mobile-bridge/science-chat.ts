import { performance } from "node:perf_hooks";
import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { DaemonScienceCommand } from "../daemon/science-service";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import {
  validateMobileScienceChatParams,
  type MobileScienceChatMethod,
  type MobileScienceChatResultDto,
  type MobileScienceChatRefusalDto,
  type MobileScienceConversationDto,
  type MobileScienceMessageDto,
  type MobileScienceTurnDto,
} from "../../shared/mobile-bridge";
import { sanitizeMobileBridgeText, stripMobileBridgeControlFences } from "./sanitize";

type Row = Record<string, unknown>;
type Client = Pick<ScienceDaemonClient, "commandObserved">;
type Scope = { projectId: string; conversationId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^(?:science[-_][a-z0-9_-]{1,159}|sign_in_required|account_mismatch)$/;
const TURN_STATES = new Set(["queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const TEXT_BYTES = 65_536;
const HISTORY_BYTES = 3 * 1024 * 1024;
let configuredClient: Client | null = null;

/** Main supplies its already-bound owner client; Mobile never constructs or boots an executor. */
export function configureMobileScienceChatClient(client: Client | null): void { configuredClient = client; }

export interface MobileScienceChatServices {
  client(): Client | null;
  assertPermission(permission: ProductExtensionPermission): void;
}

function desktopServices(): MobileScienceChatServices {
  return {
    client: () => configuredClient,
    assertPermission(permission) {
      const { scienceExtensionStatus } = require("../extensions/science") as typeof import("../extensions/science");
      const { assertScienceExtensionReleasePermission } = require("../extensions/view-host") as typeof import("../extensions/view-host");
      const status = scienceExtensionStatus();
      if (status.phase !== "installed" || !status.enabled) throw new Error("science-extension-not-active");
      assertScienceExtensionReleasePermission(permission);
    },
  };
}

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science_chat_receipt_invalid");
  return value as Row;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("science_chat_receipt_invalid");
  return value.map(row);
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("science_chat_receipt_invalid");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error("science_chat_receipt_invalid");
  return value;
}
function text(value: unknown, bytes: number, controls = false): string {
  if (typeof value !== "string") throw new Error("science_chat_receipt_invalid");
  // Whole accumulated copy only. Preserve a completed UI line's newline while streaming.
  return sanitizeMobileBridgeText(controls ? stripMobileBridgeControlFences(value) : value, bytes);
}
function nullableCode(value: unknown): string | null {
  return value == null ? null : typeof value === "string" && CODE.test(value) ? value : "science_chat_turn_failed";
}
function assertScope(value: Row, scope: Scope): void {
  if (value.projectId !== scope.projectId || value.conversationId !== scope.conversationId) throw new Error("science_chat_scope_mismatch");
}
function conversation(value: Row, projectId: string): MobileScienceConversationDto {
  if (value.projectId !== projectId) throw new Error("science_chat_scope_mismatch");
  return { conversationId: identifier(value.id), projectId, title: text(value.title, 512),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt) };
}
function message(value: Row, scope: Scope): MobileScienceMessageDto {
  assertScope(value, scope);
  if (value.visibility !== "visible" || (value.role !== "user" && value.role !== "assistant")) throw new Error("science_chat_message_not_visible");
  return { messageId: identifier(value.id), ...scope, role: value.role, content: text(value.content, TEXT_BYTES, true), createdAt: timestamp(value.createdAt) };
}
function turn(value: Row, scope: Scope): MobileScienceTurnDto {
  assertScope(value, scope);
  if (typeof value.status !== "string" || !TURN_STATES.has(value.status)
    || !Number.isSafeInteger(value.lastSequence) || Number(value.lastSequence) < 0) throw new Error("science_chat_receipt_invalid");
  return { turnId: identifier(value.id), requestId: identifier(value.requestId), ...scope,
    userMessageId: identifier(value.userMessageId), assistantMessageId: value.assistantMessageId == null ? null : identifier(value.assistantMessageId),
    status: value.status as MobileScienceTurnDto["status"], lastSequence: Number(value.lastSequence),
    partialText: text(value.partialText, TEXT_BYTES), errorCode: nullableCode(value.errorCode),
    errorMessage: value.errorMessage == null ? null : text(value.errorMessage, 1_000),
    startedAt: value.startedAt == null ? null : timestamp(value.startedAt), finishedAt: value.finishedAt == null ? null : timestamp(value.finishedAt),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt) };
}

/** Bounded presentation adapter over the native Science conversation service. No raw event/tool/provider payloads cross. */
export class MobileScienceChat {
  constructor(private readonly hostId: string, private readonly services: MobileScienceChatServices = desktopServices()) {}

  async request(method: MobileScienceChatMethod, params: Row, input: {
    idempotencyKey?: string;
    /** Rechecked at every await boundary, including immediately before native write dispatch. */
    assertAccount(): void;
  }): Promise<MobileScienceChatResultDto> {
    const identity = { schemaVersion: 1 as const, hostId: this.hostId };
    const scopeFields = Object.fromEntries(["projectId", "conversationId", "requestId", "turnId"]
      .filter(key => typeof params[key] === "string" && UUID.test(params[key] as string)).map(key => [key, params[key]]));
    let writeDispatched = false;
    const deadline = performance.now() + 12_000;
    try {
      const invalid = validateMobileScienceChatParams(method, params);
      if (invalid) throw new Error(invalid);
      if (method === "science.chat.send" && input.idempotencyKey !== params.requestId) throw new Error("science_chat_idempotency_invalid");
      const permission = method === "science.chat.send" || method === "science.chat.cancel" ? "science:agent-runtime" : "science:projects";
      const admit = () => {
        input.assertAccount();
        this.services.assertPermission("science:projects");
        if (permission === "science:agent-runtime") this.services.assertPermission(permission);
      };
      admit();
      const client = this.services.client();
      if (!client) throw new Error("science_chat_unavailable");
      const command = async (command: DaemonScienceCommand, mutation = false): Promise<unknown> => {
        admit();
        if (mutation) writeDispatched = true;
        let result: unknown;
        // This deadline opts out of the daemon client's ordinary preflight recovery even for an explicit Mobile write.
        try { result = await client.commandObserved(command, { timeoutMs: mutation ? 10_000 : 5_000, observationDeadlineMs: deadline }); }
        catch (error) {
          // A later receipt read cannot undo an earlier successful cancel. Apply no-dispatch evidence only to this mutation.
          const evidence = error && typeof error === "object" && "failure" in error ? (error as { failure: unknown }).failure : null;
          if (mutation && evidence && typeof evidence === "object" && "outcome" in evidence && evidence.outcome === "not-dispatched") writeDispatched = false;
          throw error;
        }
        admit();
        return result;
      };
      const projectId = params.projectId as string;
      const projects = rows(await command({ op: "projects.list" }));
      const project = projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error("science_chat_project_not_found");
      if (method === "science.chat.send" && project.status === "archived") throw new Error("science_chat_project_archived");
      // The SDK's default list excludes worker/referee conversations. Recheck this exact author scope for every operation.
      const conversations = rows(await command({ op: "conversations.list", input: { projectId } }));
      if (method === "science.chat.list") {
        const limit = Number(params.limit ?? 50);
        return { ...identity, projectId, ok: true, conversations: conversations.slice(0, limit).map(value => conversation(value, projectId)), hasMore: conversations.length > limit };
      }
      const conversationId = params.conversationId as string;
      if (!conversations.some(candidate => candidate.id === conversationId && candidate.projectId === projectId)) throw new Error("science_chat_conversation_not_found");
      const scope = { projectId, conversationId };
      if (method === "science.chat.read") {
        let all = rows(await command({ op: "messages.list", input: scope }));
        const attached = await command({ op: "composer.attach", input: scope });
        const active = attached == null ? null : turn(row(row(attached).turn), scope);
        // Settlement may commit the final message between these reads. One bounded refresh joins the authoritative message IDs.
        if (active && (!all.some(value => value.id === active.userMessageId)
          || (active.assistantMessageId && !all.some(value => value.id === active.assistantMessageId)))) {
          all = rows(await command({ op: "messages.list", input: scope }));
        }
        // Scope violations fail the response; internal/system rows remain in Science's store only.
        for (const value of all) assertScope(value, scope);
        const visible = all.filter(value => value.visibility === "visible" && (value.role === "user" || value.role === "assistant"));
        const limit = Number(params.limit ?? 100);
        const messages: MobileScienceMessageDto[] = [];
        let bytes = 0;
        for (let index = visible.length - 1; index >= Math.max(0, visible.length - limit); index--) {
          const projected = message(visible[index], scope);
          const size = Buffer.byteLength(JSON.stringify(projected), "utf8");
          if (bytes + size > HISTORY_BYTES) break;
          messages.push(projected); bytes += size;
        }
        messages.reverse();
        return { ...identity, ...scope, ok: true, messages, turn: active, hasMore: visible.length > messages.length };
      }
      if (method === "science.chat.send") {
        const requestId = params.requestId as string;
        const result = row(await command({ op: "composer.start", input: { ...scope, requestId, mode: "append-user-message", content: params.text as string,
          ...(params.locale === "ko" || params.locale === "en" ? { locale: params.locale } : {}) } }, true));
        const current = turn(row(result.turn), scope), userMessage = message(row(result.userMessage), scope);
        if (result.accepted !== true || typeof result.replayed !== "boolean" || current.requestId !== requestId
          || current.userMessageId !== userMessage.messageId || userMessage.role !== "user") throw new Error("science_chat_receipt_invalid");
        return { ...identity, ...scope, ok: true, requestId, accepted: true, replayed: result.replayed, turn: current, userMessage };
      }
      const turnId = params.turnId as string;
      const disposition = await command({ op: "composer.cancel", input: { ...scope, turnId } }, true);
      if (disposition !== "requested" && disposition !== "already-requested" && disposition !== "terminal") throw new Error("science_chat_receipt_invalid");
      const current = turn(row(await command({ op: "composer.receipt", input: { ...scope, turnId } })), scope);
      if (current.turnId !== turnId) throw new Error("science_chat_scope_mismatch");
      return { ...identity, ...scope, ok: true, disposition, turn: current };
    } catch (error) {
      const rawFailure = error && typeof error === "object" && "failure" in error ? (error as { failure: unknown }).failure : null;
      const failure = rawFailure && typeof rawFailure === "object" && !Array.isArray(rawFailure) ? rawFailure as Row : null;
      const rawCode = failure?.remoteSourceCode ?? (error instanceof Error ? error.message : null);
      const code = typeof rawCode === "string" && CODE.test(rawCode) ? rawCode
        : typeof failure?.code === "string" && CODE.test(failure.code) ? failure.code : "science_chat_operation_failed";
      // A lost or rejected post-dispatch reply can still have durable effects. Only the client's admission receipt proves no dispatch.
      const outcome = writeDispatched ? "unknown" : "not-dispatched";
      return { ...identity, ...scopeFields, ok: false, code,
        message: outcome === "unknown" ? "The Science command outcome is unknown. Read the conversation before trying again."
          : "The existing Science conversation is unavailable or the request was refused.",
        outcome, retryable: outcome === "not-dispatched" && /(?:unavailable|not_ready|connection|timeout|closed)/.test(code),
      } as MobileScienceChatRefusalDto;
    }
  }
}
