import { createHash } from "node:crypto";
import { ALIVE_CONTROLLER_SLUG, builtinAgentId } from "./architecture/manifest";
import { invocationService } from "./invocation/service";
import { captureLongRunRuntimeSelection } from "./long-run/exact-runtime-binding";
import { createChat, getChat, normalizeChatRuntimeSelection } from "./store/chats";
import { getDb } from "./store/db";
import { currentUiLocale } from "./ui-locale";
import type { InvocationRunReceipt, RuntimeSelection } from "../shared/types";

/** Structural mirror of the optional Science host port; the pinned package predates it. */
interface AliveRuntimeStart {
  agentId: string;
  wakeId: string;
  controlEpoch: number;
  runtimeBinding: unknown;
  purpose: string;
  reasonCode: string;
  context: {
    attachments: Array<{ attachmentId: string; domain: string; scope: Record<string, unknown>; observation: Record<string, unknown> }>;
    state: Record<string, unknown>;
    budget: { tokenLimit: number | null; tokensUsed: number; deadlineMs: number | null };
    capabilities: string[];
  };
}

interface AliveRuntimeReceipt {
  runId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  tokensUsed?: number;
  finalText?: string;
  errorCode?: string;
  decision?: { kind: "wait" | "review"; reason: string; nextWakeAtMs: number | null }
    | { kind: "act"; reason: string; nextWakeAtMs: number | null; action: {
      kind: "science.continue_research"; attachmentId: string; expected: {
        loopSessionId: string; loopVersion: number; loopStateSha256: string;
        conversationStopEpoch: number; approvalPolicySha256: string;
      };
    } };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const AGENT_ID = builtinAgentId(ALIVE_CONTROLLER_SLUG);

function runtimeChatId(agentId: string): string {
  const hex = createHash("sha256").update(`agentlas:alive-runtime-chat:v1:${agentId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isAliveChat(chatId: string): boolean {
  const chat = getChat(chatId);
  if (!chat || chat.kind !== "division" || chat.originSurface !== "work" || chat.agentId !== AGENT_ID) return false;
  const match = /^⟦alive⟧([a-f0-9-]+)$/i.exec(chat.title);
  return Boolean(match && UUID.test(match[1]!) && runtimeChatId(match[1]!) === chatId);
}

function ensureRuntimeChat(agentId: string): string {
  if (!UUID.test(agentId)) throw new Error("alive-agent-id-invalid");
  const installed = getDb().prepare("SELECT id FROM installed_agents WHERE id=? AND slug=? AND builtin=1")
    .get(AGENT_ID, ALIVE_CONTROLLER_SLUG) as { id: string } | undefined;
  if (!installed) throw new Error("alive-controller-not-installed");
  const id = runtimeChatId(agentId);
  const marker = `⟦alive⟧${agentId}`;
  const existing = getChat(id);
  if (existing) {
    if (!isAliveChat(id) || existing.title !== marker) throw new Error("alive-runtime-chat-conflict");
    return id;
  }
  const created = createChat({ internalId: id, agentId: AGENT_ID, projectId: null,
    title: marker, kind: "division", taskMode: "conversation", originSurface: "work" });
  if (created.id !== id || !isAliveChat(id)) throw new Error("alive-runtime-chat-create-mismatch");
  return id;
}

function exactSelection(raw: unknown): RuntimeSelection {
  const selection = normalizeChatRuntimeSelection(raw);
  if (!selection?.model || !selection.source) throw new Error("alive-runtime-selection-unverified");
  captureLongRunRuntimeSelection(selection, { requireExact: true });
  return selection;
}

/** A controller decision is an exact JSON object, not an inference from answer prose. */
export function parseAliveDecision(text: string): AliveRuntimeReceipt["decision"] {
  if (!text || Buffer.byteLength(text, "utf8") > 4_096) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500
    || (row.nextWakeAtMs !== null && (!Number.isSafeInteger(row.nextWakeAtMs) || Number(row.nextWakeAtMs) < 0))) return undefined;
  const reason = row.reason.trim();
  const nextWakeAtMs = row.nextWakeAtMs as number | null;
  const keys = Object.keys(row).sort().join("|");
  if (((keys === "kind|nextWakeAtMs|reason|schema"
      && (row.schema === "agentlas.alive-decision.v1" || row.schema === "agentlas.alive-decision.v2"))
    || (keys === "action|kind|nextWakeAtMs|reason|schema"
      && row.schema === "agentlas.alive-decision.v2" && row.action === null))
    && (row.kind === "wait" || row.kind === "review")) return { kind: row.kind, reason, nextWakeAtMs };
  if (keys !== "action|kind|nextWakeAtMs|reason|schema"
    || row.schema !== "agentlas.alive-decision.v2" || row.kind !== "act") return undefined;
  const action = row.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const a = action as Record<string, unknown>;
  if (Object.keys(a).sort().join("|") !== "attachmentId|expected|kind"
    || a.kind !== "science.continue_research" || typeof a.attachmentId !== "string"
    || !a.attachmentId || a.attachmentId.length > 200
    || !a.expected || typeof a.expected !== "object" || Array.isArray(a.expected)) return undefined;
  const e = a.expected as Record<string, unknown>;
  if (Object.keys(e).sort().join("|") !== "approvalPolicySha256|conversationStopEpoch|loopSessionId|loopStateSha256|loopVersion"
    || typeof e.loopSessionId !== "string" || !UUID.test(e.loopSessionId)
    || !Number.isSafeInteger(e.loopVersion) || Number(e.loopVersion) < 0
    || !Number.isSafeInteger(e.conversationStopEpoch) || Number(e.conversationStopEpoch) < 0
    || typeof e.loopStateSha256 !== "string" || !SHA256.test(e.loopStateSha256)
    || typeof e.approvalPolicySha256 !== "string" || !SHA256.test(e.approvalPolicySha256)) return undefined;
  return { kind: "act", reason, nextWakeAtMs, action: {
    kind: "science.continue_research", attachmentId: a.attachmentId, expected: {
      loopSessionId: e.loopSessionId, loopVersion: Number(e.loopVersion), loopStateSha256: e.loopStateSha256,
      conversationStopEpoch: Number(e.conversationStopEpoch), approvalPolicySha256: e.approvalPolicySha256,
    },
  } };
}

function finalResult(runId: string, chatId: string): { text: string; tokensUsed?: number } | null {
  const rows = getDb().prepare(`SELECT e.payload_json AS payloadJson, m.text AS text
    FROM run_events e JOIN chat_messages m
      ON m.id=json_extract(e.payload_json,'$.durableMessageId') AND m.chat_id=e.chat_id AND m.role='assistant'
    WHERE e.run_id=? AND e.chat_id=? AND e.kind='mcp_final' AND json_valid(e.payload_json)
    ORDER BY e.seq`).all(runId, chatId) as Array<{ payloadJson: string; text: string }>;
  if (rows.length !== 1) return null;
  const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
  const input = payload.observedInputTokens;
  const output = payload.observedOutputTokens;
  const tokensUsed = Number.isSafeInteger(input) && Number.isSafeInteger(output)
    && Number(input) >= 0 && Number(output) >= 0 && Number(input) + Number(output) <= Number.MAX_SAFE_INTEGER
    ? Number(input) + Number(output) : undefined;
  return { text: rows[0]!.text, ...(tokensUsed === undefined ? {} : { tokensUsed }) };
}

function aliveReceipt(receipt: InvocationRunReceipt | null): AliveRuntimeReceipt | null {
  if (!receipt || !isAliveChat(receipt.chatId)
    || (receipt.status !== "completed" && receipt.status !== "failed"
      && receipt.status !== "cancelled" && receipt.status !== "interrupted")) return null;
  const final = receipt.status === "completed" ? finalResult(receipt.runId, receipt.chatId) : null;
  const decision = final ? parseAliveDecision(final.text) : undefined;
  return { runId: receipt.runId, status: receipt.status,
    ...(final?.tokensUsed === undefined ? {} : { tokensUsed: final.tokensUsed }),
    ...(final?.text ? { finalText: final.text.slice(0, 4_096) } : {}),
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    ...(decision ? { decision } : {}) };
}

export const desktopAliveRuntime = {
  start(input: AliveRuntimeStart): { accepted: boolean; runId?: string; reasonCode?: string } {
    if (!input || !UUID.test(input.agentId) || !UUID.test(input.wakeId) || !Number.isSafeInteger(input.controlEpoch)
      || input.controlEpoch < 0 || typeof input.purpose !== "string" || !input.purpose.trim()
      || input.purpose.length > 20_000 || typeof input.reasonCode !== "string"
      || !/^[a-z][a-z0-9._-]{2,119}$/.test(input.reasonCode)
      || !input.context || !Array.isArray(input.context.capabilities)
      || input.context.capabilities[0] !== "alive.record_decision"
      || (input.context.capabilities.length !== 1
        && !(input.context.capabilities.length === 2 && input.context.capabilities[1] === "science.continue_research"))) {
      return { accepted: false, reasonCode: "alive-runtime-input-invalid" };
    }
    let chatId: string;
    let selection: RuntimeSelection;
    try { chatId = ensureRuntimeChat(input.agentId); selection = exactSelection(input.runtimeBinding); }
    catch { return { accepted: false, reasonCode: "alive-runtime-binding-unavailable" }; }
    let context: string;
    try {
      context = JSON.stringify({ schema: "agentlas.alive-wake-context.v1", agentId: input.agentId,
        wakeId: input.wakeId, controlEpoch: input.controlEpoch, purpose: input.purpose,
        reasonCode: input.reasonCode, attachments: input.context.attachments,
        state: input.context.state, budget: input.context.budget,
        capabilities: input.context.capabilities });
    } catch { return { accepted: false, reasonCode: "alive-runtime-context-invalid" }; }
    if (Buffer.byteLength(context, "utf8") > 64 * 1024) return { accepted: false, reasonCode: "alive-runtime-context-too-large" };
    const scienceAttachments = input.context.attachments.filter((attachment) => attachment.domain === "science");
    if (scienceAttachments.length > 1) return { accepted: false, reasonCode: "alive-science-attachment-ambiguous" };
    const scienceAttachment = scienceAttachments[0];
    try {
      const started = invocationService.start({ runId: input.wakeId, chatId,
        userPrompt: `You are the independent Alive controller. Review this host-observed state, use any separately granted tools that advance your purpose, and return one bare JSON decision. For rest or reflection, use {"schema":"agentlas.alive-decision.v2","kind":"wait","reason":"brief reason","nextWakeAtMs":null,"action":null}; "review" is also valid, and nextWakeAtMs may be a nonnegative integer. Only if capabilities includes science.continue_research AND an attached Science observation shows a paused loop, you may instead propose {"schema":"agentlas.alive-decision.v2","kind":"act","reason":"brief reason","nextWakeAtMs":null,"action":{"kind":"science.continue_research","attachmentId":"observed attachment ID","expected":{"loopSessionId":"observed loop ID","loopVersion":1,"loopStateSha256":"observed hash","conversationStopEpoch":0,"approvalPolicySha256":"observed hash"}}}. Copy observed IDs, revision numbers, and hashes exactly; do not invent them. The host independently checks current stop, grant, budget, binding, and revision before any action. You may revise your plan; do not claim an action, study, manuscript, or external effect happened until its separate host result exists.\n${context}`,
        promptOrigin: "system", taskIntent: "conversation", permissions: "full", sessionRouting: false,
        runtimeSelection: selection, locale: currentUiLocale() }, undefined, { source: "alive",
        ...(scienceAttachment ? { aliveScience: { agentId: input.agentId, wakeId: input.wakeId,
          controlEpoch: input.controlEpoch, attachmentId: scienceAttachment.attachmentId } } : {}) });
      if (started.runId !== input.wakeId) {
        invocationService.cancel(started.runId);
        return { accepted: false, reasonCode: "alive-runtime-run-id-mismatch" };
      }
      return { accepted: true, runId: started.runId };
    } catch { return { accepted: false, reasonCode: "alive-runtime-start-failed" }; }
  },
  cancel(runId: string): void {
    if (!UUID.test(runId)) return;
    const receipt = invocationService.receipt(runId);
    if (receipt && isAliveChat(receipt.chatId)) invocationService.cancel(runId);
  },
  receipt(runId: string): AliveRuntimeReceipt | null { return UUID.test(runId) ? aliveReceipt(invocationService.receipt(runId)) : null; },
  onSettled(listener: (receipt: AliveRuntimeReceipt) => void): () => void {
    return invocationService.onSettled((event) => {
      const receipt = aliveReceipt(event.receipt);
      if (receipt) listener(receipt);
    });
  },
};
