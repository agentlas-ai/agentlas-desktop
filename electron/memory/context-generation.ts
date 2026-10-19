// Host-only recall generation. A query or provider DTO never mints a task.
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { findCanonicalTaskForChat } from "../store/tasks";
import { agentContextKey } from "../store/agent-context";
import { resolveSessionScope } from "../runtime/session-scope";
import { currentModelCallScope } from "../runtime/model-call-ledger";
import { getMemoryStoreInfo } from "./database";
import { currentMemorySourceCustody, memorySourceSnapshot } from "./source-custody";
import { sessionCheckpointStore } from "./session-checkpoints";

export interface MemoryContextGeneration { readonly schema: "agentlas.memory-context-generation.v1" }
export interface MemoryGenerationState {
  key: string; ownerScope: string; serviceIdentity: string; ownerNamespace: string; revocationEpoch: number; actorId: string;
  chatId: string; visibilityDomain: string; projectId: string | null; projectPath: string | null;
  task: { id: string; revision: number; goal: string; constraints: string[] } | null;
  sourceContextKey: string; semanticThroughSeq: number; correctionId: string | null;
  assertCurrent(): void;
}
const states = new WeakMap<MemoryContextGeneration, MemoryGenerationState>();
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function memoryGenerationState(token: MemoryContextGeneration): MemoryGenerationState {
  const state = states.get(token); if (!state) throw new Error("memory_generation_host_binding_required");
  state.assertCurrent(); return state;
}
export function captureMemoryContextGeneration(input: {
  agentId?: string | null; chatId?: string | null; runId?: string | null;
  projectId?: string | null; projectPath?: string | null; visibilityDomain?: string;
}): { generation: MemoryContextGeneration | null; reason: string } {
  try {
    const host = currentModelCallScope(), source = memorySourceSnapshot(currentMemorySourceCustody());
    const chatId = input.chatId ?? host?.chatId;
    if (!host || !source || !chatId || !input.agentId || host.chatId !== chatId
      || (input.runId && host.runId !== input.runId)) return { generation: null, reason: "host-source-scope-unavailable" };
    const memory = getMemoryStoreInfo();
    if (memory.ownerNamespace !== source.ownerNamespace || memory.revocationEpoch !== source.intakeEpoch)
      return { generation: null, reason: "host-source-custody-changed" };
    const db = getDb();
    const chat = db.prepare("SELECT kind,parent_chat_id,archived_at,origin_surface,project_id FROM chats WHERE id=?").get(chatId) as
      { kind: string | null; parent_chat_id: string | null; archived_at: string | null; origin_surface: string | null; project_id: string | null } | undefined;
    if (!chat || chat.archived_at) return { generation: null, reason: "host-chat-boundary-unavailable" };
    // Same native journal owner derivation as actual invocation admission. It
    // is resolved locally, never copied from model/renderer JSON.
    const owner = (require("../runtime/agent-context-admission") as typeof import("../runtime/agent-context-admission")).agentContextOwnerBinding();
    // The same domain as invocation admission, from the same resolver (runtime/session-scope.ts): the recall pack is bound to
    // the journal identity, so a pack made for another domain than the session's would be refused at the wire. Read only.
    const domain = input.visibilityDomain ?? resolveSessionScope(db, { chatId, agentId: input.agentId, kind: chat.kind, parentChatId: chat.parent_chat_id, aliveController: false,
        ownerScope: owner.ownerScope, persist: false }).visibilityDomain;
    const identity = { ...owner, agentId: input.agentId, visibilityDomain: domain };
    const contextKey = agentContextKey(identity);
    const head = db.prepare("SELECT 1 FROM agent_context_heads WHERE context_key=?").get(contextKey);
    const goal = db.prepare(`SELECT goal_id,objective,acceptance_criteria_json,updated_at FROM chat_goal_contracts
      WHERE chat_id=? AND status='active' AND objective IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get(chatId) as
      { goal_id: string; objective: string; acceptance_criteria_json: string; updated_at: string } | undefined;
    const canonical = goal ? null : findCanonicalTaskForChat(chatId);
    const criteria: unknown = goal ? JSON.parse(goal.acceptance_criteria_json) : [];
    const task = goal ? { id: `goal:${goal.goal_id}`, revision: Date.parse(goal.updated_at) || 0, goal: goal.objective,
      constraints: Array.isArray(criteria) ? criteria.filter((v): v is string => typeof v === "string") : [] }
      : canonical ? { id: `task:${canonical.id}`, revision: canonical.version, goal: canonical.title, constraints: [] } : null;
    const cp = sessionCheckpointStore.read(identity);
    if (!task && !head && !cp) return { generation: null, reason: "task-or-journal-boundary-unavailable" };
    const sameTask = Boolean(cp && cp.sourceContextKey === contextKey && sha(cp.task) === sha(task));
    const semanticThroughSeq = sameTask && cp ? cp.semanticThroughSeq ?? cp.throughSeq : 0;
    const correction = db.prepare(`SELECT intent_id FROM invocation_current_turn_steers WHERE chat_id=?
      AND status IN ('queued','dispatching','applied','uncertain') ORDER BY created_at DESC,intent_id DESC LIMIT 1`).get(chatId) as { intent_id: string } | undefined;
    const signature = sha([chat, owner, task, sameTask ? cp?.sourceContextKey ?? contextKey : contextKey, semanticThroughSeq, correction?.intent_id ?? null]);
    const token: MemoryContextGeneration = Object.freeze({ schema: "agentlas.memory-context-generation.v1" });
    const key = sha([memory.ownerNamespace, memory.path, memory.revocationEpoch, input.agentId, chatId, domain,
      input.projectId ?? null, input.projectPath ?? null, signature]);
    states.set(token, { key, ownerScope: owner.ownerScope, serviceIdentity: owner.serviceIdentity, ownerNamespace: memory.ownerNamespace, revocationEpoch: memory.revocationEpoch,
      actorId: input.agentId, chatId, visibilityDomain: domain, projectId: input.projectId ?? null,
      projectPath: input.projectPath ?? null, task, sourceContextKey: contextKey,
      semanticThroughSeq, correctionId: correction?.intent_id ?? null,
      assertCurrent() {
        const now = getMemoryStoreInfo();
        if (now.ownerNamespace !== memory.ownerNamespace || now.path !== memory.path || now.revocationEpoch !== memory.revocationEpoch)
          throw new Error("memory_generation_custody_changed");
        const auth = (require("../runtime/agent-context-admission") as typeof import("../runtime/agent-context-admission")).agentContextOwnerBinding();
        if (sha(auth) !== sha(owner)) throw new Error("memory_generation_native_owner_changed");
        const fresh = captureMemoryContextGeneration(input).generation;
        if (!fresh || states.get(fresh)?.key !== key) throw new Error("memory_generation_boundary_changed");
      } });
    return { generation: token, reason: "host-checkpoint-generation" };
  } catch { return { generation: null, reason: "host-generation-read-unavailable" }; }
}
