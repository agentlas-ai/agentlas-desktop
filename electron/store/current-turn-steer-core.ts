import { createHash } from "node:crypto";
import type { InvocationCurrentTurnSteerReceipt, InvocationCurrentTurnSteerRequest } from "../../shared/types";

/** The caller owns opening the SQLite database and its schema migrations. */
export interface CurrentTurnSteerSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

export interface CurrentTurnSteerSqliteDb {
  prepare(sql: string): CurrentTurnSteerSqliteStatement;
  transaction<T>(action: () => T): { (): T; immediate(): T };
}

export interface CurrentTurnSteerStorePorts {
  getDb(): CurrentTurnSteerSqliteDb;
  /** Append through this same database; never independently commit the message. */
  appendUserMessage(chatId: string, text: string): { id: string };
  onChange?(chatId: string): void;
  now?(): string;
}

/** Process-neutral durable control storage shared by execution owners. */
export function createCurrentTurnSteerStore(ports: CurrentTurnSteerStorePorts) {
  const { getDb, appendUserMessage, onChange } = ports;
  const now = ports.now ?? (() => new Date().toISOString());

  type Row = {
    intent_id: string; chat_id: string; run_id: string; prompt_text: string;
    prompt_hash: string; message_id: string; binding_json: string;
    status: InvocationCurrentTurnSteerReceipt["status"]; code: string | null;
  };

  function validateCurrentTurnSteer(input: InvocationCurrentTurnSteerRequest): void {
    if (!input || typeof input !== "object" || typeof input.chatId !== "string" || !input.chatId
      || typeof input.expectedRunId !== "string" || !input.expectedRunId
      || typeof input.intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.intentId)
      || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 200_000) {
      throw new Error("invocation_current_turn_steer_invalid");
    }
  }

  function receipt(row: Row): InvocationCurrentTurnSteerReceipt {
    return { intentId: row.intent_id, chatId: row.chat_id, runId: row.run_id,
      promptHash: row.prompt_hash, messageId: row.message_id, status: row.status,
      ...(row.code ? { code: row.code } : {}) };
  }

  function getCurrentTurnSteer(chatId: string, intentId: string): InvocationCurrentTurnSteerReceipt | null {
    const row = getDb().prepare("SELECT * FROM invocation_current_turn_steers WHERE intent_id = ?").get(intentId) as Row | undefined;
    if (!row) return null;
    if (row.chat_id !== chatId) throw new Error("invocation_current_turn_steer_identity_conflict");
    return receipt(row);
  }

  /** Exact identity check happens before looking for a currently running turn. */
  function existingCurrentTurnSteer(input: InvocationCurrentTurnSteerRequest): InvocationCurrentTurnSteerReceipt | null {
    validateCurrentTurnSteer(input);
    const row = getDb().prepare("SELECT * FROM invocation_current_turn_steers WHERE intent_id = ?").get(input.intentId) as Row | undefined;
    if (!row) return null;
    if (row.chat_id !== input.chatId || row.run_id !== input.expectedRunId || row.prompt_text !== input.text) {
      throw new Error("invocation_current_turn_steer_identity_conflict");
    }
    return receipt(row);
  }

  /** The user row and once-only dispatch claim commit together, before any native effect. */
  function claimCurrentTurnSteer(input: InvocationCurrentTurnSteerRequest,
    binding: Readonly<Record<string, unknown>>): InvocationCurrentTurnSteerReceipt {
    validateCurrentTurnSteer(input);
    return getDb().transaction(() => {
      if (existingCurrentTurnSteer(input)) throw new Error("invocation_current_turn_steer_claim_lost");
      const message = appendUserMessage(input.chatId, input.text);
      const timestamp = now();
      getDb().prepare(`INSERT INTO invocation_current_turn_steers
        (intent_id, chat_id, run_id, prompt_text, prompt_hash, message_id, binding_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(input.intentId, input.chatId, input.expectedRunId,
        input.text, createHash("sha256").update(input.text, "utf8").digest("hex"), message.id,
        JSON.stringify(binding), timestamp, timestamp);
      return getCurrentTurnSteer(input.chatId, input.intentId)!;
    }).immediate();
  }

  function settleCurrentTurnSteer(chatId: string, intentId: string,
    status: "applied" | "rejected" | "uncertain", code?: string): InvocationCurrentTurnSteerReceipt {
    const current = getCurrentTurnSteer(chatId, intentId);
    if (!current) throw new Error("invocation_current_turn_steer_missing");
    if (current.status === "dispatching" || current.status === "queued") {
      getDb().prepare(`UPDATE invocation_current_turn_steers SET status = ?, code = ?, updated_at = ?
        WHERE intent_id = ? AND chat_id = ? AND status IN ('queued','dispatching')`)
        .run(status, code ?? null, now(), intentId, chatId);
      onChange?.(chatId);
    }
    return getCurrentTurnSteer(chatId, intentId)!;
  }

  /** Eligibility precedes the atomic claim. Current-turn directions retain
   * their own FIFO lane without claiming queued next-episode input. */
  function takeCurrentTurnSteers(chatId: string, runId: string,
    phase: "current-boundary" | "episode-terminal" = "current-boundary"): Array<{ intentId: string; text: string }> {
    if (phase !== "current-boundary" && phase !== "episode-terminal") {
      throw new Error("invocation_current_turn_steer_delivery_phase_invalid");
    }
    let rejectedAny = false;
    const directions = getDb().transaction(() => {
      if (phase === "episode-terminal" && getDb().prepare(`SELECT 1 FROM invocation_current_turn_steers
        WHERE chat_id = ? AND run_id = ? AND status = 'uncertain' LIMIT 1`).get(chatId, runId)) return [];
      const rows = getDb().prepare(`SELECT * FROM invocation_current_turn_steers
        WHERE chat_id = ? AND run_id = ? AND status IN ('queued','dispatching') ORDER BY created_at, rowid`).all(chatId, runId) as Row[];
      const claim = getDb().prepare(`UPDATE invocation_current_turn_steers SET status = 'dispatching', updated_at = ?
        WHERE intent_id = ? AND status = 'queued'`);
      const result: Array<{ intentId: string; text: string }> = [];
      for (const row of rows) {
        let binding: unknown;
        try { binding = JSON.parse(row.binding_json); } catch { break; }
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) break;
        const kind = (binding as Record<string, unknown>).deliveryKind;
        if (kind !== undefined && kind !== "current" && kind !== "queue") break;
        if (kind === "queue" && phase === "current-boundary") continue;
        // Explicit current-only never becomes a next-episode send. Existing
        // dispatching rows remain the same FIFO/CAS barrier; uncertain stays held.
        if (kind === "current" && phase === "episode-terminal") {
          if (row.status !== "queued") break;
          const rejected = getDb().prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = 'native_control_current_boundary_expired', updated_at = ? WHERE intent_id = ? AND status = 'queued'`);
          if (rejected.run(now(), row.intent_id).changes !== 1) break;
          rejectedAny = true;
          continue;
        }
        if (row.status !== "queued") {
          if (phase === "current-boundary") continue;
          break;
        }
        if (claim.run(now(), row.intent_id).changes !== 1) break;
        result.push({ intentId: row.intent_id, text: row.prompt_text });
      }
      return result;
    }).immediate();
    if (rejectedAny) onChange?.(chatId);
    return directions;
  }

  function countPendingCurrentTurnSteers(chatId: string, runId: string): number {
    return (getDb().prepare(`SELECT COUNT(*) AS count FROM invocation_current_turn_steers
      WHERE chat_id = ? AND run_id = ? AND status IN ('queued','dispatching')`).get(chatId, runId) as { count: number }).count;
  }

  return { validateCurrentTurnSteer, existingCurrentTurnSteer, getCurrentTurnSteer,
    claimCurrentTurnSteer, settleCurrentTurnSteer, takeCurrentTurnSteers, countPendingCurrentTurnSteers };
}
