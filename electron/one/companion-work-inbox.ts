import type Database from "better-sqlite3";
import { COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { takeCompanionWorkAdmission } from "./companion-work-admission";
import type { CompanionWorkContext } from "./companion-work-context";

/** Storage primitive for Supervisor admission. The callback may write the Work
 * request and queue only; it must not dispatch. This method returns only after
 * the request and its context have committed together. */
export function createCompanionWorkInbox(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS one_companion_handoffs (
    command_id TEXT PRIMARY KEY REFERENCES one_supervisor_requests(command_id) ON DELETE CASCADE,
    binding_json TEXT NOT NULL, context_json TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS one_companion_handoff_delete AFTER DELETE ON one_supervisor_requests BEGIN
    DELETE FROM one_companion_handoffs WHERE command_id=OLD.command_id;
  END;`);
  function admit(capability: unknown, createRequest: (input: { commandId: string; oneId: string; text: string; doneWhen: string[]; permissions: "read" | "write" | "full" }, context: CompanionWorkContext) => void): { status: "stored" | "existing"; commandId: string } {
    if (db.inTransaction || typeof createRequest !== "function") throw new Error("companion_work_transaction_required");
    const verified = takeCompanionWorkAdmission(capability);
    if (!verified) throw new Error("companion_work_admission_invalid");
    const { binding, context, work } = verified;
    return db.transaction(() => {
    const bindingJson = JSON.stringify(Object.fromEntries(COMPANION_HANDOFF_PROOF_FIELDS.map((field) => [field, binding[field]])));
    const contextJson = JSON.stringify(context);
    const prior = db.prepare("SELECT binding_json,context_json FROM one_companion_handoffs WHERE command_id=?").get(binding.commandId) as
      { binding_json: string; context_json: string } | undefined;
    const existingRequest = db.prepare("SELECT 1 FROM one_supervisor_requests WHERE command_id=?").get(binding.commandId);
    if (prior && (prior.binding_json !== bindingJson || prior.context_json !== contextJson)) throw new Error("companion_work_binding_conflict");
    if (existingRequest && !prior || prior && !existingRequest) throw new Error("companion_work_binding_conflict");
    if (!existingRequest) {
      const created: unknown = createRequest({ commandId: binding.commandId, oneId: binding.oneId, text: work.brief, doneWhen: [work.doneWhen], permissions: work.permissions }, context);
      if (created && typeof (created as { then?: unknown }).then === "function") throw new Error("companion_work_async_admission");
    }
    const row = db.prepare("SELECT one_id,kind,payload_json FROM one_supervisor_requests WHERE command_id=?").get(binding.commandId) as
      { one_id: string; kind: string; payload_json: string } | undefined;
    if (!row || row.kind !== "work" || row.one_id !== binding.oneId) throw new Error("companion_work_request_missing");
    const actual = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (actual.commandId !== binding.commandId || actual.text !== work.brief || actual.permissions !== work.permissions ||
        !Array.isArray(actual.doneWhen) || actual.doneWhen.length !== 1 || actual.doneWhen[0] !== work.doneWhen) throw new Error("companion_work_request_mismatch");
    // The account can change while a caller creates the Work rows. Refuse
    // and roll back all of them if the admitted identity or grant changed.
    verified.assertCurrent();
    if (prior) return { status: "existing" as const, commandId: binding.commandId };
    db.prepare("INSERT INTO one_companion_handoffs(command_id,binding_json,context_json) VALUES(?,?,?)").run(binding.commandId, bindingJson, contextJson);
    return { status: "stored" as const, commandId: binding.commandId };
    }).immediate();
  }
  return Object.freeze({ admit });
}
