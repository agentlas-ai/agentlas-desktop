import { DesktopWorkRecoveryJournal } from "../invocation/work-recovery-store";
import { MAX_USER_REQUESTS, USER_REQUEST_SPACING_MS } from "../../shared/work-recovery";

export interface ScienceQuestionReference { projectId: string; conversationId: string; questionId: string }
interface ReminderPorts {
  references(): ScienceQuestionReference[];
  read(ref: ScienceQuestionReference): { question: unknown; scopeDigest: string } | null;
  available(): boolean;
  assertOwner?(): void;
  present(question: unknown): void;
}

function reference(question: unknown): ScienceQuestionReference {
  if (!question || typeof question !== "object") throw new Error("work_question_invalid");
  const receipt = (question as { receipt?: { schema?: unknown; id?: unknown; projectId?: unknown; conversationId?: unknown } }).receipt;
  if (receipt?.schema !== "agentlas.science.researcher-question.v1"
    || [receipt.id, receipt.projectId, receipt.conversationId].some(id => typeof id !== "string" || !id || id.length > 80)) {
    throw new Error("work_question_identity_invalid");
  }
  return { projectId: String(receipt.projectId), conversationId: String(receipt.conversationId), questionId: String(receipt.id) };
}

/** Schedules delivery requests for the existing sealed need. Every tick re-reads
 * its answer, project, Stop epoch and newer user direction through Science. */
export class ScienceQuestionRecoveryPresenter {
  private readonly timers = new Map<string, () => void>();
  private closed = false;
  constructor(private readonly ports: ReminderPorts,
    private readonly journal: () => DesktopWorkRecoveryJournal = () => new DesktopWorkRecoveryJournal(),
    private readonly clock: () => number = Date.now,
    private readonly schedule: (tick: () => void, delay: number) => () => void = (tick, delay) => {
      const timer = setTimeout(tick, delay); timer.unref(); return () => clearTimeout(timer);
    }) {}

  present(question: unknown): void { this.attempt(reference(question)); }
  restore(): void {
    if (this.closed) return;
    try { this.ports.assertOwner?.(); } catch { this.stop(); return; }
    let refs: ScienceQuestionReference[];
    try { refs = this.ports.references(); } catch { return; }
    for (const ref of refs) this.attempt(ref);
  }
  stop(): void { this.closed = true; for (const cancel of this.timers.values()) cancel(); this.timers.clear(); }
  private attempt(ref: ScienceQuestionReference): void {
    const key = JSON.stringify(ref);
    this.timers.get(key)?.(); this.timers.delete(key);
    if (this.closed) return;
    try { this.ports.assertOwner?.(); } catch { this.stop(); return; }
    try {
      if (!this.ports.available()) return; // UI registration calls restore when the destination becomes available.
      const current = this.ports.read(ref);
      if (!current || JSON.stringify(reference(current.question)) !== key) return;
      const runId = `science-question:${ref.projectId}:${ref.conversationId}`;
      const journal = this.journal();
      let facts = journal.questionFacts(runId, ref.questionId);
      if (facts.count >= MAX_USER_REQUESTS || (facts.count > 0 && journal.questionScope(runId, ref.questionId) !== current.scopeDigest)) return;
      const now = this.clock();
      if (!Number.isFinite(now) || (facts.lastAskedAt !== null && !Number.isFinite(facts.lastAskedAt))) return;
      const due = facts.lastAskedAt === null || now - facts.lastAskedAt >= USER_REQUEST_SPACING_MS;
      if (due && journal.reserveQuestion(runId, ref.questionId, now, current.scopeDigest)) {
        // A reservation is a request, not proof of delivery. Recheck Stop/answer
        // after reserving; a failed read never becomes permission to present.
        const fresh = this.ports.read(ref);
        if (!fresh || fresh.scopeDigest !== current.scopeDigest || JSON.stringify(reference(fresh.question)) !== key) return;
        this.ports.assertOwner?.();
        if (!this.ports.available()) return;
        try { this.ports.present(fresh.question); } catch { /* The request remains counted if delivery failed. */ }
      }
      facts = journal.questionFacts(runId, ref.questionId);
      if (facts.count >= MAX_USER_REQUESTS) return;
      const delay = Math.min(USER_REQUEST_SPACING_MS, Math.max(0, (facts.lastAskedAt ?? now) + USER_REQUEST_SPACING_MS - this.clock()));
      this.timers.set(key, this.schedule(() => this.attempt(ref), delay));
    } catch { /* Missing/read-failed facts preserve the need; independent reminders still run. */ }
  }
}

/** Limit reminders for one real, durable question; the existing persisted list/answer UI stays authoritative. */
export function presentScienceRecoveryQuestion(question: unknown, present: (question: unknown) => void,
  journal = new DesktopWorkRecoveryJournal()): void {
  if (!question || typeof question !== "object") throw new Error("work_question_invalid");
  const q = question as { status?: unknown; receipt?: { schema?: unknown; id?: unknown; projectId?: unknown; conversationId?: unknown } };
  const receipt = q.receipt;
  if (receipt?.schema !== "agentlas.science.researcher-question.v1"
    || [receipt.id, receipt.projectId, receipt.conversationId].some(id => typeof id !== "string" || !id || id.length > 80)) {
    throw new Error("work_question_identity_invalid");
  }
  if (q.status !== "open") return;
  const runId = `science-question:${receipt.projectId}:${receipt.conversationId}`;
  if (journal.reserveQuestion(runId, String(receipt.id))) present(question);
}
