import { withDoneWhen } from "../../shared/one-supervisor";
import type { OneSupervisorStore, SupervisorRequestRow } from "./supervisor-store";

/** The conversation a durable command runs in and the exact prompt its dispatch sends, for the four command families.
 * A Work's prompt is its brief plus the finished-when list (withDoneWhen, the same function the Work executor sends). */
export function supervisorCommandBinding(store: Pick<OneSupervisorStore, "db">, oneId: string, row: SupervisorRequestRow): { target: string | undefined; prompt: unknown } {
  const payload = JSON.parse(row.payload_json);
  let target: string | undefined;
  if (row.kind === "reply") target = row.origin_chat_id;
  else if (row.kind === "work") target = payload.workerChatId;
  else if (row.kind === "chat-send") target = payload.chatId;
  else if (row.kind === "follow-up") {
    const delegated = store.db.prepare("SELECT payload_json FROM one_supervisor_requests WHERE one_id=? AND task_id=? AND kind='work' ORDER BY rowid LIMIT 1")
      .get(oneId, row.task_id) as { payload_json: string } | undefined;
    if (delegated) target = JSON.parse(delegated.payload_json).workerChatId;
  }
  return { target, prompt: row.kind === "work" && typeof payload.text === "string" ? withDoneWhen(payload.text, payload.doneWhen) : payload.text };
}

/** What decides a background service's way with a One turn (one/supervisor.ts observeOrdinaryOneNativeSource). */
export interface ServiceSupervisorState { supervisorPresent: boolean; hostConfigured: boolean; processKind: string }

/**
 * In a background service that has not adopted the personal domain: this run is a supervisor command Desktop Main is dispatching (its
 * request row, not an ordinary composer turn) while Desktop Main actively holds the domain, and the row's own conversation and words
 * are this request's, the same binding check the observer makes for a supervisor command. Such a turn is Desktop's to observe through
 * its native runtime; this process has no supervisor to ask (asking threw supervisor_daemon_domain_not_adopted and refused
 * every One turn Desktop sent while the hand-over was pending). A row changed after the dispatch is never run on its say-so.
 */
export function dispatchedByDesktopSupervisor(db: OneSupervisorStore["db"], state: ServiceSupervisorState,
  request: { runId?: string; chatId: string; userPrompt: string }): boolean {
  const runId = request.runId;
  if (!runId || state.supervisorPresent || state.hostConfigured || state.processKind !== "daemon") return false;
  try {
    const owner = db.prepare("SELECT one_id AS oneId, owner_kind AS kind, phase FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as { oneId: string; kind: string; phase: string } | undefined;
    if (owner?.kind !== "desktop-main" || owner.phase !== "active") return false;
    const row = db.prepare("SELECT * FROM one_supervisor_requests WHERE run_id=? AND state='dispatching'").get(runId) as SupervisorRequestRow | undefined;
    if (!row || row.one_id !== owner.oneId || Object.prototype.hasOwnProperty.call(JSON.parse(row.payload_json), "ordinaryNative")) return false;
    const binding = supervisorCommandBinding({ db }, owner.oneId, row);
    return binding.target === request.chatId && binding.prompt === request.userPrompt;
  } catch { return false; }
}
