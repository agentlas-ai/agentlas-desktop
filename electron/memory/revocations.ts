import { equivalentMemoryKinds, forgetStampRules, memoryClassificationRules } from "./classification";
import { personalReadable } from "../../shared/memory-classification";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import {
  activeBorrowedOwnerScopeKey,
  DEVICE_LOCAL_BORROWED_OWNER_SCOPE,
} from "../agents/borrowed-owner-scope";
import { getMemoryDb as getDb, getMemoryStoreInfo, memoryRoot as storeMemoryRoot, purgeLegacyMemoryCopies } from "./database";
import { nativeTextsFor } from "./native-text";
import { clearSelectedMemoryContextCache } from "./selected-context-cache";
import { purgeGeneratedMemoryViews } from "./projections";
import { isOneMemoryActor, memoryActorIds, ONE_MEMORY_ACTOR_IDS, sameMemoryActor } from "../../shared/memory-actor-family";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { FORGOTTEN_IMPORT_SOURCE, importSourceKey } from "./import-source-receipt";
import { layoutOf, listExistingStores, openStore, ROOT_RESIDUE_PENDING_KEY, type StoreRef } from "./stores";
import { completeForgetInStores, findRowInStores, matchRowsInStores, noteForgetCodes, ticketsOfRows } from "./forget-stores";

/**
 * Cleanup-target source id for the original-wording twin of a translated
 * memory. The target table is unique per (source, kind, ref), so the twin needs
 * its own source id (and source→revocation link); project-files.ts strips the
 * suffix before matching the projection's memory_id.
 */
export const NATIVE_TWIN_SOURCE_SUFFIX = "#native";

export type MemoryRevocationReason = "exact-content-revoked" | "stale-intake-epoch";

export class MemoryRevokedError extends Error {
  readonly code = "memory_revoked";

  constructor(readonly reason: MemoryRevocationReason) {
    super(reason);
    this.name = "MemoryRevokedError";
  }
}

export interface MemoryAuthorityInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId?: string | null;
  projectPath?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  intakeRunId?: string | null;
  intakeEpoch?: number | null;
  /**
   * the owner said these words again in a turn of their own, and the line's words rest on their own words (a quote found in what they typed). Only a
   * Personal line is let through a forget stamp, and only when the run started AFTER the stamp was made; the stamp is then lifted. A model writing the same words alone never sets it.
   */
  restatedByOwner?: boolean;
}

interface ForgettableMemoryRow {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  project_id: string | null;
  project_path: string | null;
  agent_id: string | null;
  chat_id: string | null;
  superseded_at: string | null;
  actor_id?: string | null;
  owner_namespace?: string | null;
}

interface LegacyDedupDecisionRow {
  ticketId: string;
  candidateIndex: number;
  contentHash: string;
  projectId: string | null;
  projectPathHash: string | null;
  agentId: string | null;
  chatId: string | null;
}

export interface ForgottenMemoryProjection {
  sourceMemoryIds: string[];
  kind: MemoryKind;
  content: string;
  contentHash: string;
  /**
   * Hashes of the original wording of translated rows (English migration).
   * Soul/log lines written before the translation carry this wording, so the
   * projection cleanup must match these too.
   */
  nativeContentHashes: string[];
  projectPaths: string[];
  forgottenAt: string;
  revokedEpoch: number;
  /** the other stores that held the words. Their rows are blanked by `completeForgetInStores` once the stamp above is committed (the open of a store is the catch-up). */
  storeRefs?: StoreRef[];
  /** Audit 54 G1 (principle P8): the older versions of the forgotten line (the lines it replaced, `supersedes`, only lines marked superseded), each blanked by its id in the same transaction and tied to the forgotten line's stamp (D1: no stamp of their own words). `sourceMemoryIds` above already lists their ids; a caller that reconciles files by wording reads each entry too. */
  also?: ForgottenMemoryProjection[];
  /** Audit 54 G1: the chain was longer than one forget follows; these older versions (same owner) are still there. `finishOlderVersions` goes on from them, a round at a time. */
  olderLeft?: { ids: string[]; ownerKey: string; /** Audit 55 D1: the stamp of the line that was forgotten; the older versions are tied to it by id, they get none of their own. */ stamp: { revocationId: string; epoch: number } };
  /** how the second half ended when it ran inside `revokeOneMemoryEntry` (outside a caller's transaction). `partial` carries codes, never sentences. Callers that finish it themselves read their own result. */
  storeForget?: { state: "forgotten" | "partial"; pending: string[]; left: string[] };
}

export function normalizeMemoryContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function memoryContentHash(value: string): string {
  return createHash("sha256").update(normalizeMemoryContent(value), "utf8").digest("hex");
}

/** Exact source ids whose downstream projections must never be recalled. */
export function revokedMemorySourceIds(sourceIds: Iterable<string>): Set<string> {
  const ids = [...new Set([...sourceIds].map((id) => id.trim()).filter(Boolean))];
  const revoked = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT source_memory_id AS sourceMemoryId
         FROM memory_revocation_sources
        WHERE source_memory_id IN (${placeholders})`,
    ).all(...batch) as Array<{ sourceMemoryId: string }>;
    for (const row of rows) revoked.add(row.sourceMemoryId);
  }
  return revoked;
}

/** Trusted in-process snapshot for background producers without a Main run id. */
export function currentMemoryForgetEpoch(): number {
  return Number((getDb().prepare(
    "SELECT epoch FROM memory_forget_clock WHERE id = 1",
  ).get() as { epoch: number }).epoch);
}

/** Content-free ticket fence for a run that began before any later forget. */
export function memoryRunPredatesAnyForget(runIdValue: string | null | undefined): boolean {
  const runId = String(runIdValue ?? "").trim();
  if (!runId) return false;
  const currentEpoch = currentMemoryForgetEpoch();
  if (currentEpoch === 0) return false;
  const snapshot = getDb().prepare(
    "SELECT intake_epoch AS intakeEpoch FROM memory_run_epochs WHERE run_id = ? LIMIT 1",
  ).get(runId) as { intakeEpoch: number } | undefined;
  if (snapshot) return snapshot.intakeEpoch < currentEpoch;
  const legacy = getDb().prepare(
    "SELECT MIN(ts) AS startedAt FROM run_events WHERE run_id = ?",
  ).get(runId) as { startedAt: string | null } | undefined;
  if (!legacy?.startedAt) return false;
  return Boolean(getDb().prepare(
    "SELECT 1 FROM memory_revocations WHERE revoked_at >= ? LIMIT 1",
  ).get(legacy.startedAt));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type MemoryProjectionTargetKind = "project-files" | "agent-nest-scan";

export interface MemoryProjectionWriterLease {
  targetId: string;
  token: string;
  sourceMemoryId: string;
}

export interface MemoryProjectionWriteItem<T> {
  lease: MemoryProjectionWriterLease;
  value: T;
}

export interface MemoryProjectionCommitReceipt {
  committedTargetIds: string[];
  rejectedTargetIds: string[];
}

function projectionTargetIdentity(
  sourceMemoryId: string,
  targetKind: MemoryProjectionTargetKind,
  targetRef: string,
): { targetId: string; targetRefHash: string } {
  const targetRefHash = stableHash(`memory-projection-target-v1\0${targetKind}\0${targetRef}`);
  return {
    targetId: `mct_${stableHash(`${sourceMemoryId}\0${targetKind}\0${targetRefHash}`).slice(0, 32)}`,
    targetRefHash,
  };
}

/**
 * Register an external projection before writing it. A concurrent forget turns
 * this exact row pending and cleanup waits for the short writer lease; a writer
 * arriving after a tombstone is refused before raw content reaches a file.
 */
export function beginMemoryProjectionWrite(input: {
  sourceMemoryId: string;
  targetKind: MemoryProjectionTargetKind;
  targetRef: string;
}): MemoryProjectionWriterLease | null {
  const sourceMemoryId = input.sourceMemoryId.trim();
  const targetRef = input.targetKind === "project-files"
    ? canonicalProjectPath(input.targetRef)
    : input.targetRef.trim();
  if (!sourceMemoryId || !targetRef) return null;
  if (
    input.targetKind === "agent-nest-scan"
    && targetRef !== DEVICE_LOCAL_BORROWED_OWNER_SCOPE
    && !/^borrowed-owner:account:[0-9a-f]{64}$/.test(targetRef)
  ) return null;
  const { targetId, targetRefHash } = projectionTargetIdentity(sourceMemoryId, input.targetKind, targetRef);
  const token = `mpw_${randomUUID()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30_000).toISOString();
  return getDb().transaction(() => {
    const revoked = getDb().prepare(
      "SELECT revocation_id AS revocationId FROM memory_revocation_sources WHERE source_memory_id = ?",
    ).get(sourceMemoryId) as { revocationId: string } | undefined;
    getDb().prepare(
      `INSERT OR IGNORE INTO memory_revocation_cleanup_targets (
         target_id, source_memory_id, revocation_id, target_kind, target_ref,
         target_ref_hash, state, lease_kind, lease_token, lease_expires_at,
         attempt_count, progress_cursor, next_attempt_at, last_error_code, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(
      targetId,
      sourceMemoryId,
      revoked?.revocationId ?? null,
      input.targetKind,
      targetRef,
      targetRefHash,
      revoked ? "pending" : "registered",
      nowIso,
      nowIso,
    );
    const row = getDb().prepare(
      "SELECT revocation_id AS revocationId FROM memory_revocation_cleanup_targets WHERE target_id = ?",
    ).get(targetId) as { revocationId: string | null } | undefined;
    if (!row || row.revocationId) return null;
    const claimed = getDb().prepare(
      `UPDATE memory_revocation_cleanup_targets
          SET state = 'writing', lease_kind = 'writer', lease_token = ?,
              lease_expires_at = ?, updated_at = ?, completed_at = NULL
        WHERE target_id = ? AND revocation_id IS NULL
          AND (lease_token IS NULL OR lease_expires_at <= ?)`,
    ).run(token, expiresAt, nowIso, targetId, nowIso);
    return claimed.changes === 1 ? { targetId, token, sourceMemoryId } : null;
  }).immediate();
}

/**
 * Perform the final external projection write while the canonical store still
 * owns the exact writer lease. The callback is deliberately synchronous: its
 * file or nested-SQLite write completes before this IMMEDIATE transaction can
 * release the target to forget cleanup.
 */
export function commitMemoryProjectionWrites<T>(
  items: MemoryProjectionWriteItem<T>[],
  write: (values: T[]) => void,
): MemoryProjectionCommitReceipt {
  const releaseInputLeases = (): void => {
    for (const item of items) finishMemoryProjectionWrite(item.lease);
  };
  if (write.constructor.name === "AsyncFunction") {
    releaseInputLeases();
    throw new TypeError("memory projection callback must be synchronous");
  }
  const uniqueItems = new Map<string, MemoryProjectionWriteItem<T>>();
  for (const item of items) {
    const targetId = item.lease.targetId.trim();
    const token = item.lease.token.trim();
    const sourceMemoryId = item.lease.sourceMemoryId.trim();
    if (!targetId || !token || !sourceMemoryId) continue;
    const previous = uniqueItems.get(targetId);
    if (
      previous
      && (
        previous.lease.token !== token
        || previous.lease.sourceMemoryId !== sourceMemoryId
      )
    ) {
      releaseInputLeases();
      throw new TypeError("conflicting memory projection leases");
    }
    uniqueItems.set(targetId, item);
  }
  const normalizedItems = [...uniqueItems.values()];
  if (normalizedItems.length === 0) {
    return { committedTargetIds: [], rejectedTargetIds: [] };
  }

  try {
    return getDb().transaction(() => {
      const selectTarget = getDb().prepare(
        `SELECT source_memory_id AS sourceMemoryId, revocation_id AS revocationId,
                state, lease_kind AS leaseKind, lease_token AS leaseToken,
                EXISTS(
                  SELECT 1 FROM memory_revocation_sources source
                   WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id
                ) AS sourceRevoked
           FROM memory_revocation_cleanup_targets
          WHERE target_id = ?`,
      );
      const releaseRevokedWriter = getDb().prepare(
        `UPDATE memory_revocation_cleanup_targets
            SET revocation_id = COALESCE(
                  revocation_id,
                  (SELECT source.revocation_id FROM memory_revocation_sources source
                    WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id)
                ),
                state = 'pending', lease_kind = NULL, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
          WHERE target_id = ? AND source_memory_id = ?
            AND lease_kind = 'writer' AND lease_token = ?`,
      );
      const completeWriter = getDb().prepare(
        `UPDATE memory_revocation_cleanup_targets
            SET state = 'registered', lease_kind = NULL, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = NULL,
                updated_at = ?, completed_at = NULL
          WHERE target_id = ? AND source_memory_id = ?
            AND state = 'writing' AND lease_kind = 'writer' AND lease_token = ?
            AND revocation_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_revocation_sources source
               WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id
            )`,
      );
      const valid: MemoryProjectionWriteItem<T>[] = [];
      const rejectedTargetIds: string[] = [];
      const now = new Date().toISOString();
      for (const item of normalizedItems) {
        const row = selectTarget.get(item.lease.targetId) as {
          sourceMemoryId: string;
          revocationId: string | null;
          state: string;
          leaseKind: string | null;
          leaseToken: string | null;
          sourceRevoked: number;
        } | undefined;
        const exactLease = Boolean(
          row
          && row.sourceMemoryId === item.lease.sourceMemoryId
          && row.leaseKind === "writer"
          && row.leaseToken === item.lease.token
        );
        const exactWriter = exactLease && row?.state === "writing";
        if (exactWriter && row && !row.revocationId && row.sourceRevoked === 0) {
          valid.push(item);
          continue;
        }
        rejectedTargetIds.push(item.lease.targetId);
        if (exactLease && row && (row.revocationId || row.sourceRevoked !== 0)) {
          releaseRevokedWriter.run(
            now,
            now,
            item.lease.targetId,
            item.lease.sourceMemoryId,
            item.lease.token,
          );
        }
      }

      if (valid.length > 0) {
        const result = write(valid.map((item) => item.value));
        if (
          result !== null
          && (typeof result === "object" || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function"
        ) {
          throw new TypeError("memory projection callback must be synchronous");
        }
      }

      const committedTargetIds: string[] = [];
      for (const item of valid) {
        const completed = completeWriter.run(
          now,
          item.lease.targetId,
          item.lease.sourceMemoryId,
          item.lease.token,
        );
        if (completed.changes !== 1) {
          throw new Error("memory projection authority changed during commit");
        }
        committedTargetIds.push(item.lease.targetId);
      }
      return { committedTargetIds, rejectedTargetIds };
    }).immediate();
  } catch (error) {
    for (const item of normalizedItems) finishMemoryProjectionWrite(item.lease);
    throw error;
  }
}

export function finishMemoryProjectionWrite(lease: MemoryProjectionWriterLease): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE memory_revocation_cleanup_targets
        SET state = CASE WHEN revocation_id IS NULL THEN 'registered' ELSE 'pending' END,
            lease_kind = NULL, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = CASE WHEN revocation_id IS NULL THEN NULL ELSE ? END,
            updated_at = ?
      WHERE target_id = ? AND lease_kind = 'writer' AND lease_token = ?`,
  ).run(now, now, lease.targetId, lease.token);
}

function canonicalProjectPath(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * A one-way identity for the exact durable-memory authority. Project paths and
 * account-local ids never enter the revocation table in plaintext.
 */
export function memoryOwnerKey(input: Pick<MemoryAuthorityInput,
  "scope" | "projectId" | "projectPath" | "agentId" | "chatId"
>): string {
  const projectId = String(input.projectId ?? "").trim();
  const projectPath = canonicalProjectPath(input.projectPath);
  const agentId = String(input.agentId ?? "").trim();
  const chatId = String(input.chatId ?? "").trim();
  let authority: string;
  if (input.scope === "project") {
    authority = projectPath
      ? `project-path:${stableHash(projectPath)}`
      : projectId
        ? `project-id:${projectId}`
        : "project-unbound";
  } else if (input.scope === "agent_repo") {
    authority = `agent:${agentId || "unbound"}`;
  } else if (input.scope === "session") {
    authority = `chat:${chatId || "unbound"}`;
  } else {
    authority = "shared";
  }
  return stableHash(`agentlas-memory-owner-v1\0${input.scope}\0${authority}`);
}

/** Preserve raw v1 authority keys while recognizing only the two declared One actors. */
export function memoryAuthorityOwnerKeys(input: Pick<MemoryAuthorityInput,
  "scope" | "projectId" | "projectPath" | "agentId" | "chatId"
>): string[] {
  const keys = [...new Set((input.scope === "agent_repo" ? memoryActorIds(input.agentId ?? null) : [input.agentId ?? null])
    .map(agentId => memoryOwnerKey({...input,agentId})))];
  // K7'' (audit D10): a project that has a folder AND an id is known by both. A line written before the folder was attached (id key only), or one written for the same id after the folder moved, is the same project:
  // the id key is added next to the folder key (a project with only an id or only a folder keeps its single key, as before). Engine twin: `memory_stores.row_owner_keys`.
  const projectId = String(input.projectId ?? "").trim();
  if (input.scope === "project" && projectId && canonicalProjectPath(input.projectPath)) keys.push(memoryOwnerKey({ scope: "project", projectId, projectPath: null, agentId: null, chatId: null }));
  return keys;
}
/**
 * K7'': the keys a forget of one line reaches. The personal agent reads two places as ONE subject (decision: "the personal agent feels like one"): its Personal lines (scope `user_identity`) and its own work knowledge
 * (`agent_repo` of the One actor family). They are one family for a forget and for the stamp: forgetting a line in either also forgets the same words in the other, and the stamp holds for both. Every other
 * subject (another agent's `agent_repo`, a project, a chat) is its own and has no family: the keys are its own. The engine twin: `memory_stores.family_owner_keys`. One function, used by the stamp, the matching and the stores' catch-up (through the stamp's keys).
 */
export function memoryFamilyOwnerKeys(input: Pick<MemoryAuthorityInput, "scope" | "projectId" | "projectPath" | "agentId" | "chatId">): string[] {
  const own = memoryAuthorityOwnerKeys(input);
  if (input.scope === "user_identity") {
    return [...new Set([...own, ...ONE_MEMORY_ACTOR_IDS.map(agentId => memoryOwnerKey({ scope: "agent_repo", projectId: null, projectPath: null, agentId, chatId: null }))])];
  }
  if (input.scope === "agent_repo" && isOneMemoryActor(input.agentId ?? null)) {
    return [...new Set([...own, memoryOwnerKey({ scope: "user_identity", projectId: null, projectPath: null, agentId: null, chatId: null })])];
  }
  return own;
}
function latestOwnerRevocation(ownerKeys: string[]): { epoch: number; revokedAt: string } | null {
  return getDb().prepare(
    `SELECT revoked_epoch AS epoch, revoked_at AS revokedAt
       FROM memory_revocations
      WHERE owner_key IN (${ownerKeys.map(()=>"?").join(",")}) AND revocation_id NOT LIKE 'mrv\\_remote\\_%' ESCAPE '\\'
      ORDER BY revoked_epoch DESC LIMIT 1`,
  ).get(...ownerKeys) as { epoch: number; revokedAt: string } | undefined ?? null;
}

/**
 * Every spelling of a text the forget stamp counts as the same words (`stores.forget`): the text itself, and the text with ONE trailing mark of `trailingChars` taken off or swapped for another
 * one of them. A stamp stores the hash of the exact words the owner forgot, so the variants are looked up, never rewritten (#4: a forgotten line came back with its full stop removed).
 * Case, runs of spaces and Unicode forms are already folded by `normalizeMemoryContent`. Without a `stores.forget` block only the text itself.
 */
export function forgetStampHashes(content: string): string[] {
  const { trailingChars } = forgetStampRules();
  const normalized = normalizeMemoryContent(content);
  const spellings = new Set<string>([normalized]);
  if (trailingChars) {
    const last = Array.from(normalized).pop();
    const base = last !== undefined && trailingChars.includes(last) ? normalized.slice(0, normalized.length - last.length) : normalized;
    // K7'' (found while testing "the stamp refuses exactly the words the forget blanks"): the bare key is a spelling only when it does not itself end in a trailing mark - the engine's rule (`memory_classify.forget_forms`:
    // "a stamp compares equal to the offered text exactly when `forget_key` is equal", ONE trailing mark). This side added the bare key always, so a stamp of "x." also refused "x.." here and not in the engine.
    const baseLast = Array.from(base).pop();
    if (base) { if (baseLast === undefined || !trailingChars.includes(baseLast) || base === normalized) spellings.add(base); for (const mark of Array.from(trailingChars)) spellings.add(base + mark); }
  }
  return [...spellings].map(text => createHash("sha256").update(text, "utf8").digest("hex"));
}

function matchingStamps(ownerKeys: string[], kind: MemoryKind, content: string, scope?: string): Array<{ revocationId: string; revokedAt: string }> {
  // / #4: with the kind-blind stamp (`stores.forget.kindBlind`) a text the owner forgot (as a decision, a fact, a procedure) does not come back as the preference, the fact or
  // the decision the same words are stored as after the kind correction, nor from a team run that files it under another kind. It looks at the OWNER (scope and subject: the owner key) and at the
  // words (their usual spellings). A ruleset without the block (or a write with no scope) keeps the exact kind, the way an older build did: the stamp then matches every kind that remaps to this one.
  const hashes = forgetStampHashes(content), hashSql = hashes.map(() => "?").join(",");
  const kinds = scope && forgetStampRules().kindBlind ? null : scope ? equivalentMemoryKinds(scope, kind) : [kind];
  const kindClause = kinds ? `memory_kind IN (${kinds.map(() => "?").join(",")}) AND ` : "";
  const kindArgs = kinds ?? [];
  // a stamp that came from another place's forget (`mrv_remote_`) holds the words for the person's facts, never for a `preference` - how THIS agent answers is not changed by what another place forgot.
  const remoteBlind = scope === "user_identity" && kind === "preference" ? " AND revocation_id NOT LIKE 'mrv\\_remote\\_%' ESCAPE '\\'" : "";
  // K7': a stamp holds for the OWNER it was made for (the agent, the project, Personal; `memoryOwnerKey`) in every layout. It used to hold for the whole account once memory lived in several stores
  // (engine N-B09): the same words offered by another agent, another project or Personal were refused because someone else had forgotten them - a person's statement refused for another subject's forget.
  // The owner's own words come back to that owner never (`exact-content-revoked`); the other subjects' lines and writes are theirs.
  return getDb().prepare(
    `SELECT revocation_id AS revocationId, revoked_at AS revokedAt FROM memory_revocations
      WHERE owner_key IN (${ownerKeys.map(()=>"?").join(",")}) AND ${kindClause}content_hash IN (${hashSql})${remoteBlind}
    `,
  ).all(...ownerKeys, ...kindArgs, ...hashes) as Array<{ revocationId: string; revokedAt: string }>;
}
function exactContentRevoked(ownerKeys: string[], kind: MemoryKind, content: string, scope?: string): boolean { return matchingStamps(ownerKeys, kind, content, scope).length > 0; }



/** The run started after every stamp that matched (its first run event, or now when no run is named: a write the owner's own typing makes at once). */
function runStartedAfter(runId: string | null | undefined, stamps: Array<{ revokedAt: string }>): boolean {
  const id = String(runId ?? "").trim();
  let startedAt: string | null = null;
  if (id) {
    try { startedAt = (getDb().prepare("SELECT MIN(ts) AS startedAt FROM run_events WHERE run_id = ?").get(id) as { startedAt: string | null } | undefined)?.startedAt ?? null; } catch { startedAt = null; }
  }
  const started = startedAt ?? new Date().toISOString();
  return stamps.every((stamp) => started > stamp.revokedAt);
}
/** A stamp is lifted by the owner saying the words again (nothing else lifts one). Its source link goes with it (the table cascades). */
function liftStamp(revocationId: string): void {
  getDb().prepare("DELETE FROM memory_revocations WHERE revocation_id = ?").run(revocationId);
}

/**
 * Read-only twin of the exact-content refusal in assertMemoryWriteAllowed: true when the owner already forgot this exact
 * text for this authority. Lets a bulk writer (memory import) skip that one item up front instead of learning it from a throw.
 */
export function isMemoryContentRevoked(input: Pick<MemoryAuthorityInput, "scope" | "kind" | "content" | "projectId" | "projectPath" | "agentId" | "chatId">): boolean {
  return exactContentRevoked(memoryAuthorityOwnerKeys(input), input.kind, input.content, input.scope);
}

/** Must run inside the caller's IMMEDIATE insert transaction. */
export function assertMemoryWriteAllowed(input: MemoryAuthorityInput): void {
  const ownerKeys = memoryAuthorityOwnerKeys(input);
  const stamps = matchingStamps(ownerKeys, input.kind, input.content, input.scope);
  if (stamps.length > 0) {
    // "forget wins" - a stamped text is written again only when the owner said it again after the stamp (a quote of their own words, a run that started after the stamp). The stamp is lifted with it.
    if (!(input.scope === "user_identity" && input.restatedByOwner === true && runStartedAfter(input.intakeRunId, stamps))) throw new MemoryRevokedError("exact-content-revoked");
    for (const stamp of stamps) liftStamp(stamp.revocationId);
  }

  const latest = latestOwnerRevocation(ownerKeys);
  if (!latest) return;
  if (Number.isInteger(input.intakeEpoch) && Number(input.intakeEpoch) < latest.epoch) {
    throw new MemoryRevokedError("stale-intake-epoch");
  }
  const runId = String(input.intakeRunId ?? "").trim();
  if (!runId) return;
  const snapshot = getDb().prepare(
    "SELECT intake_epoch AS intakeEpoch FROM memory_run_epochs WHERE run_id = ? LIMIT 1",
  ).get(runId) as { intakeEpoch: number } | undefined;
  if (snapshot) {
    if (snapshot.intakeEpoch < latest.epoch) throw new MemoryRevokedError("stale-intake-epoch");
    return;
  }

  // Pre-v118 runs have no trigger snapshot. Their immutable first run-event
  // timestamp is the compatibility fence for an invocation already active
  // while the user forgot a memory during upgrade.
  const legacy = getDb().prepare(
    "SELECT MIN(ts) AS startedAt FROM run_events WHERE run_id = ?",
  ).get(runId) as { startedAt: string | null } | undefined;
  if (legacy?.startedAt && legacy.startedAt <= latest.revokedAt) {
    throw new MemoryRevokedError("stale-intake-epoch");
  }
}

/** Read-boundary fallback when a project-file rewrite was interrupted. */
export function filterRevokedProjectSoul(
  soul: string,
  projectId: string | null | undefined,
  projectPath: string | null | undefined,
): string {
  const ownerKey = memoryOwnerKey({
    scope: "project",
    projectId,
    projectPath,
    agentId: null,
    chatId: null,
  });
  const revoked = getDb().prepare(
    "SELECT memory_kind AS kind, content_hash AS contentHash FROM memory_revocations WHERE owner_key = ?",
  ).all(ownerKey) as Array<{ kind: string; contentHash: string }>;
  if (revoked.length === 0) return soul;
  const denied = new Set(revoked.map((row) => `${row.kind}\0${row.contentHash}`));
  return soul.split(/\r?\n/).filter((line) => {
    const match = /^- \(([^)]+)\) (.*)$/.exec(line);
    return !match || !denied.has(`${match[1]}\0${memoryContentHash(match[2])}`);
  }).join("\n");
}

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

/** A checkpoint can contain any recalled source and model receipts can still
 * contain its wording. Purge the current physical owner partition atomically
 * with the epoch; retain only content-free job tombstones for idempotency. */
/**
 * K7''' (P1): who may read a stored line, asked line by line: `reader` is a memory actor id. The "who could have read it" of the forget's reach below is NOT a second hand-written condition: the Personal part is `personalReadable`
 * itself (shared/memory-classification.ts, the function every prompt-bound reader asks), the agent part is the actor sameness the recall policy applies (`sameMemoryActor`), so a change of the reading rule there changes the reach here.
 * Any other line is read by every reader here (a project's readers are the agents bound to it, which a continuation point does not record).
 * `rulesOn: false` on purpose: a continuation point or a waiting job may have been made while the workspace-rules switch was OFF (when every subject read a Personal line that is not a fact), and the switch being ON now does not
 * un-read it. The switch-off answer is the widest the Personal rule ever gives, so asking it covers every era (a switch-on answer is a subset of it).
 * A worker store read by `host:*` or the system agents (store-write.ts `ownerScopeOf(split2)`, no caller yet) enters here, in the agent part, when it starts being read: the reach follows it (gate `reach`, a fake reader).
 */
export type LineReadRule = (line: { scope: string; kind: string | null; agentId: string | null }, reader: string | null) => boolean;
export const recallLineReadRule: LineReadRule = (line, reader) => {
  if (line.scope === "user_identity") return personalReadable(memoryClassificationRules(), line.scope, line.kind, reader, { rulesOn: false, personalRead: true });
  if (line.scope === "agent_repo") return line.agentId !== null && reader !== null && sameMemoryActor(line.agentId, reader);
  return true;
};
/** Readers that cannot be named by an actor id in a list: any other agent, a host executor (`host:*`), a built-in system agent. If the rule lets one of these read the line, the reach is every conversation. */
const OTHER_READER_PROBES: readonly string[] = ["agent-reach-probe", "host:reach-probe", "builtin-agentlas-reach-probe", "product:reach-probe"];

/**
 * K7'' (audit D6), K7''' (P1): who could have read the forgotten line, as the memory actors of the conversations whose continuation points and waiting work may quote it, derived from the reading rule (`recallLineReadRule`).
 * A Personal FACT and a line of the personal agent's own work knowledge are read by the personal agent only (the One actor family, the owner's "one subject",); an agent's line by that agent only. A line that some reader we
 * cannot name by an actor id may read (a Personal line that is not a fact, which every subject reads while the switch is off; a project's line) reaches every conversation: `null`. Engine twin: none (the engine's own `forget`
 * empties continuation points by the tickets that quoted the words).
 * basis: the actors are the memory actors the recall reads by (`lineBelongsToSubject`, `storesForContext`); `null` is the safe side (what is lost is a continuation point, which the next turn makes again).
 */
export function continuationReach(row: { scope: string; kind?: string | null; agent_id: string | null; actor_id?: string | null }, readable: LineReadRule = recallLineReadRule): readonly string[] | null {
  if (row.scope !== "user_identity" && row.scope !== "agent_repo") return null;
  const agentId = row.agent_id ?? row.actor_id ?? null;
  if (row.scope === "agent_repo" && !agentId) return null;
  const line = { scope: row.scope, kind: row.kind ?? null, agentId };
  if (OTHER_READER_PROBES.some(probe => readable(line, probe))) return null;
  const readers = (row.scope === "user_identity" ? [...ONE_MEMORY_ACTOR_IDS] : memoryActorIds(agentId).filter((actor): actor is string => actor !== null)).filter(actor => readable(line, actor));
  if (!readers.length) return null;
  return readers.some(actor => isOneMemoryActor(actor)) ? [...new Set([...readers, ...ONE_MEMORY_ACTOR_IDS, "product:One"])] : readers;
}

function purgePreForgetContinuation(epoch: number, now: string, reach: readonly string[] | null = null, restamp = true): void {
  purgeGeneratedMemoryViews();
  const actorMarks = reach ? reach.map(() => "?").join(",") : "";
  if (!reach) {
    if (tableExists("memory_session_checkpoint_heads")) getDb().prepare("DELETE FROM memory_session_checkpoint_heads").run();
    if (tableExists("memory_session_checkpoints")) getDb().prepare("DELETE FROM memory_session_checkpoints").run();
  } else if (tableExists("memory_session_checkpoints")) {
    // Only the conversations that could have read the line lose their continuation points. The others keep theirs: their checkpoints are stamped with the new forget number (the read fence compares the number),
    // and only those that were valid just before this forget (a checkpoint already stale from an earlier owner edit stays stale).
    const namespaces = (getDb().prepare(`SELECT DISTINCT namespace FROM memory_session_checkpoints WHERE json_extract(payload_json,'$.actorId') IN (${actorMarks})`).all(...reach) as Array<{ namespace: string }>).map(row => row.namespace);
    for (const namespace of namespaces) {
      if (tableExists("memory_session_checkpoint_heads")) getDb().prepare("DELETE FROM memory_session_checkpoint_heads WHERE namespace=?").run(namespace);
      getDb().prepare("DELETE FROM memory_session_checkpoints WHERE namespace=?").run(namespace);
    }
    if (restamp) getDb().prepare("UPDATE memory_session_checkpoints SET payload_json=json_set(payload_json,'$.forgetEpoch',?) WHERE json_valid(payload_json) AND json_extract(payload_json,'$.forgetEpoch')=?").run(epoch, epoch - 1);
  }
  // The session store holds the same rows in its own file: forgetting empties it physically too. A file that cannot be opened right now
  // stays hidden by the forget epoch (read() refuses a line from an older epoch) and the retention pass removes it.
  try {
    const sessions = require("./session-store") as typeof import("./session-store");
    if (reach) sessions.forgetSessionActors(reach, epoch); else sessions.purgeSessionFile();
  } catch { /* hidden by the epoch fence until the retention pass */ }
  if (tableExists("memory_curation_jobs")) {
    const columns = new Set((getDb().pragma("table_info(memory_curation_jobs)") as Array<{ name: string }>).map(row => row.name));
    const leases = ["lease_token", "lease_expires_at"].filter(column => columns.has(column)).map(column => `${column}=NULL,`).join("");
    getDb().prepare(`UPDATE memory_curation_jobs
      SET payload_json='{}',result_json=NULL,runtime_digest='revoked',expected_revision=NULL,
          state='revoked',next_attempt_at=NULL,${leases}updated_at=? WHERE intake_epoch<?`).run(now, epoch);
  }
  if (tableExists("memory_curation_batches")) getDb().prepare("DELETE FROM memory_curation_batches WHERE intake_epoch<?").run(epoch);
  // K7': a resting-time pass keeps the model's answer (the lines it proposed, in the owner's words) as its batch row until it is applied or the next pass drops it. A row of an earlier epoch is never used again
  // (its key carries the epoch, and both passes drop a row whose epoch moved), so it goes now and the words do not wait for the next pass.
  if (tableExists("memory_dreaming_sources")) getDb().prepare("DELETE FROM memory_dreaming_sources WHERE intake_epoch<?").run(epoch);
  if (tableExists("memory_operations")) {
    // Core's detached worker shares this physical owner partition. Its
    // processing receipt is also its lease, so replace it with a tombstone.
    const owner = getMemoryStoreInfo().ownerNamespace;
    const actorClause = reach ? ` AND actor_id IN (${actorMarks})` : "";   // K7'' (D6): the waiting work of the conversations that could have read the line; another actor's waiting turn is its own
    const actorArgs = reach ? [...reach] : [];
    const pending = `SELECT operation_id FROM memory_operations WHERE owner_namespace=?
      AND revocation_epoch<? AND state IN ('queued','deferred','processing')${actorClause}`;
    getDb().prepare(`UPDATE memory_episodes SET summary=NULL,summary_hash=NULL
      WHERE ticket_id IN (${pending})`).run(owner, epoch, ...actorArgs);
    getDb().prepare(`UPDATE memory_tickets SET state='failed',failure_code='source_revoked',
      curation_outcome='curator_failed',updated_at=? WHERE ticket_id IN (${pending})`).run(now, owner, epoch, ...actorArgs);
    getDb().prepare(`UPDATE memory_operations SET payload_json='{}',
      receipt_json=CASE WHEN state IN ('queued','deferred','processing') THEN
        json_object('schema_version','agentlas.core-memory-runtime.v1','operation_id',operation_id,
          'action','defer','reason','source_revoked','written',0) ELSE receipt_json END,
      state=CASE WHEN state IN ('queued','deferred','processing') THEN 'revoked' ELSE state END,
      updated_at=? WHERE owner_namespace=? AND revocation_epoch<?${actorClause}`).run(now, owner, epoch, ...actorArgs);
  }
}

function legacyTicketMatchesOwner(row: LegacyDedupDecisionRow, memory: ForgettableMemoryRow): boolean {
  if (memory.scope === "project") {
    const projectPath = canonicalProjectPath(memory.project_path);
    return projectPath
      ? row.projectPathHash === stableHash(projectPath)
      : Boolean(memory.project_id) && row.projectId === memory.project_id;
  }
  if (memory.scope === "agent_repo") return sameMemoryActor(row.agentId,memory.agent_id ?? memory.actor_id);
  if (memory.scope === "session") return row.chatId === memory.chat_id;
  return true;
}

/**
 * Pre-v118 dedup decisions did not persist their target id. Recover only exact
 * raw-content hashes under the same ticket owner. Preserve an exact live source
 * for unrelated content; quarantine every remaining unprovable episode from
 * recall without inventing a target id or deleting the original observation.
 */
function reconcileLegacyDedupEpisodes(
  matched: ForgettableMemoryRow[],
  selected: ForgettableMemoryRow,
  revocationId: string,
  revokedAt: string,
): void {
  const targetByRawHash = new Map(matched.map((row) => [stableHash(row.content), row.id]));
  if (targetByRawHash.size === 0) return;
  const ownerKeys = memoryAuthorityOwnerKeys({
    scope: selected.scope,
    projectId: selected.project_id,
    projectPath: selected.project_path,
    agentId: selected.agent_id ?? selected.actor_id,
    chatId: selected.chat_id,
  });
  const liveTargetByRawHash = new Map(
    (getDb().prepare(
      `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id
         FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
        WHERE m.scope = ? AND m.kind = ? AND m.superseded_at IS NULL`,
    ).all(selected.scope, selected.kind) as ForgettableMemoryRow[])
      .filter((row) => ownerKeys.includes(memoryOwnerKey({
        scope: row.scope,
        projectId: row.project_id,
        projectPath: row.project_path,
        agentId: row.agent_id ?? row.actor_id,
        chatId: row.chat_id,
      })) && !targetByRawHash.has(stableHash(row.content)))
      .map((row) => [stableHash(row.content), row.id]),
  );
  const redactEpisode = getDb().prepare(
    `UPDATE memory_episodes
        SET summary = NULL, summary_hash = NULL,
            embedding_model = NULL, embedding_adapter = NULL,
            embedding_model_sha256 = NULL, embedding_content_hash = NULL,
            embedding_dimensions = NULL, embedding_json = NULL
      WHERE ticket_id = ?`,
  );
  const linkTarget = getDb().prepare(
    `UPDATE memory_decisions SET target_memory_id = ?
      WHERE ticket_id = ? AND candidate_index = ? AND target_memory_id IS NULL`,
  );
  const quarantineEpisode = getDb().prepare(
    `INSERT INTO memory_episode_quarantines (ticket_id, revocation_id, reason, created_at)
     VALUES (?, ?, 'legacy-unlinked-dedup', ?)
     ON CONFLICT(ticket_id) DO NOTHING`,
  );
  const rows = getDb().prepare(
    `SELECT decision.ticket_id AS ticketId, decision.candidate_index AS candidateIndex,
            decision.content_hash AS contentHash, ticket.project_id AS projectId,
            ticket.project_path_hash AS projectPathHash, ticket.agent_id AS agentId,
            ticket.chat_id AS chatId
       FROM memory_decisions decision
       JOIN memory_tickets ticket ON ticket.ticket_id = decision.ticket_id
      WHERE decision.target_memory_id IS NULL
        AND decision.action = 'deduped'
        AND decision.memory_kind = ? AND decision.resolved_scope = ?`,
  ).all(selected.kind, selected.scope) as LegacyDedupDecisionRow[];
  for (const row of rows) {
    if (!legacyTicketMatchesOwner(row, selected)) continue;
    const targetMemoryId = targetByRawHash.get(row.contentHash);
    if (targetMemoryId) {
      redactEpisode.run(row.ticketId);
      linkTarget.run(targetMemoryId, row.ticketId, row.candidateIndex);
      continue;
    }
    if (liveTargetByRawHash.has(row.contentHash)) continue;
    quarantineEpisode.run(row.ticketId, revocationId, revokedAt);
  }
}

let cleanupQueued: (() => void) | null = null;
/** The cleanup worker registers here, so a newly queued target wakes it instead of the worker polling the table. */
export function onMemoryRevocationCleanupQueued(listener: (() => void) | null): void { cleanupQueued = listener; }
function notifyCleanupQueued(): void {
  // Forgetting must not fail because the cleanup worker could not be woken; its start-up pass still finds the target.
  try { cleanupQueued?.(); } catch { /* the worker is woken by its next signal */ }
}

function enqueueRevocationCleanupTarget(input: {
  sourceMemoryId: string;
  revocationId: string;
  targetKind: MemoryProjectionTargetKind;
  targetRef: string;
  now: string;
}): void {
  const { targetId, targetRefHash } = projectionTargetIdentity(
    input.sourceMemoryId,
    input.targetKind,
    input.targetRef,
  );
  getDb().prepare(
    `INSERT INTO memory_revocation_cleanup_targets (
       target_id, source_memory_id, revocation_id, target_kind, target_ref,
       target_ref_hash, state, lease_kind, lease_token, lease_expires_at,
       attempt_count, progress_cursor, next_attempt_at, last_error_code, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL, ?, NULL, ?, ?, NULL)
     ON CONFLICT(source_memory_id, target_kind, target_ref_hash) DO UPDATE SET
       revocation_id = excluded.revocation_id,
       state = 'pending',
       progress_cursor = NULL,
       next_attempt_at = excluded.next_attempt_at,
       last_error_code = NULL,
       updated_at = excluded.updated_at,
       completed_at = NULL`,
  ).run(
    targetId,
    input.sourceMemoryId,
    input.revocationId,
    input.targetKind,
    input.targetRef,
    targetRefHash,
    input.now,
    input.now,
    input.now,
  );
  notifyCleanupQueued();
}

/** How many generations of older versions one forget follows (the engine's `FORGET_CHAIN_MAX_DEPTH`); a longer chain is finished by forgetting the next older line. */
export const FORGET_CHAIN_MAX_DEPTH = 16;

type AnyDb = ReturnType<typeof getDb>;
function dbHasTable(db: AnyDb, name: string): boolean {
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; } catch { return false; }
}

/** The ids of the lines `id` replaced, from the three places a replacement is written: the `supersedes:<id>` evidence token (owner edit, dreaming), an origin link of relation `supersedes` and a `supersedes` edge from the newer line to the older one. */
function olderVersionIds(dbs: readonly AnyDb[], id: string): Set<string> {
  const older = new Set<string>();
  for (const db of dbs) {
    try {
      const row = db.prepare("SELECT evidence_json FROM memory_entries WHERE id=?").get(id) as { evidence_json?: string } | undefined;
      if (row?.evidence_json) {
        try {
          const parsed: unknown = JSON.parse(row.evidence_json);
          if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string" && item.startsWith("supersedes:") && item.length > 11 && item.length <= 267) older.add(item.slice(11));
        } catch { /* an evidence cell that is not JSON names nobody */ }
      }
      if (dbHasTable(db, "memory_origin_links")) {
        for (const link of db.prepare("SELECT source_id FROM memory_origin_links WHERE memory_id=? AND source_kind='memory' AND relation='supersedes'").all(id) as Array<{ source_id: string }>) if (link.source_id) older.add(link.source_id);
      }
      if (dbHasTable(db, "memory_relation_edges")) {
        for (const edge of db.prepare("SELECT to_memory_id FROM memory_relation_edges WHERE from_memory_id=? AND relation_type='supersedes'").all(id) as Array<{ to_memory_id: string }>) if (edge.to_memory_id) older.add(edge.to_memory_id);
      }
    } catch { /* a store that cannot be read names nobody now; its own catch-up blanks what the stamp names */ }
  }
  older.delete(id);
  return older;
}

/**
 * Principle P8, design 2.3 item 9: the older versions of the line being forgotten - every line it replaced and the ones those replaced, up to FORGET_CHAIN_MAX_DEPTH generations, in the root
 * and (layout not central) in every store. Only lines of the SAME owner (the forgotten line's owner key and namespace); the walk does not go through a line of another owner. Iterative, a seen id is never
 * visited twice (a cycle ends), so a 10,000-line chain costs 16 steps. The newer versions are never touched: a later memory is a different memory. Read BEFORE anything is blanked (blanking empties the evidence).
 * Returns the lines that still hold words, and the older versions left unvisited because the depth ran out.
 */
function ownerKeyOfRow(row: ForgettableMemoryRow): string {
  return memoryOwnerKey({ scope: row.scope, projectId: row.project_id, projectPath: row.project_path, agentId: row.agent_id ?? row.actor_id, chatId: row.chat_id });
}
function readableDbs(accountWide: boolean, owner: string, rootDb: AnyDb, root: string): AnyDb[] {
  const dbs: AnyDb[] = [rootDb];
  if (accountWide) {
    for (const candidate of listExistingStores(root, owner)) {
      try { const { store } = openStore(candidate.ref, owner, rootDb, root); if (store) dbs.push(store.db as AnyDb); } catch { /* the store is read by its own catch-up */ }
    }
  }
  return dbs;
}
const OLDER_ROW_SQL = `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id,b.owner_namespace
    FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id=? ORDER BY (m.content<>'') DESC LIMIT 1`;
function olderRowById(dbs: readonly AnyDb[], id: string): ForgettableMemoryRow | undefined {
  for (const db of dbs) {
    try { const row = db.prepare(OLDER_ROW_SQL).get(id) as ForgettableMemoryRow | undefined; if (row) return row; } catch { /* next */ }
  }
  return undefined;
}

function supersedeAncestorsOf(selected: ForgettableMemoryRow, accountWide: boolean, owner: string, rootDb: AnyDb, root: string): { rows: ForgettableMemoryRow[]; left: string[] } {
  const keyOf = ownerKeyOfRow;
  const mine = keyOf(selected);
  const dbs = readableDbs(accountWide, owner, rootDb, root);
  const seen = new Set<string>([selected.id]);
  let frontier = [selected.id];
  const found: ForgettableMemoryRow[] = [];
  for (let depth = 0; depth < FORGET_CHAIN_MAX_DEPTH; depth += 1) {
    const step: string[] = [];
    for (const id of frontier) {
      for (const older of [...olderVersionIds(dbs, id)].sort()) {
        if (seen.has(older)) continue;
        seen.add(older);
        const row = olderRowById(dbs, older);
        if (!row) { step.push(older); continue; }   // not held here: it may still link on to older versions that are
        if (row.owner_namespace && row.owner_namespace !== owner) continue;
        if (keyOf(row) !== mine) continue;
        if (!row.superseded_at) continue;   // D2: a line that was only pointed at (a replacement that failed halfway, a citation) and is still live is not an older version
        if (row.content) found.push(row);
        step.push(older);
      }
    }
    frontier = step;
    if (!frontier.length) return { rows: found, left: [] };
  }
  const left = new Set<string>();
  for (const id of frontier) for (const older of olderVersionIds(dbs, id)) if (!seen.has(older)) left.add(older);
  return { rows: found, left: [...left].sort() };
}

function explicitAudienceKey(memoryId: string): string {
  const row=getDb().prepare("SELECT applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(memoryId) as {applicability_json:string}|undefined;
  const stable=(value: unknown): unknown => Array.isArray(value)?value.map(stable):value && typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
  try {return JSON.stringify(stable(JSON.parse(row?.applicability_json ?? "{}").audience ?? null));} catch {return `invalid:${memoryId}`;}
}

/**
 * K7': empty the turn records (a ticket's episode and the observed turn it kept) of the given tickets, inside the caller's transaction: the episode's summary and embedding, the host facts (`detail_json`, which holds the owner's
 * own message), the original-wording twin and its translation job, and the operation's payload. The ticket row itself (ids, counts, times - no words) stays: it is the receipt that a turn happened.
 */
function redactTurnRecords(ticketIds: readonly string[]): void {
  if (!ticketIds.length) return;
  const hasDetail = (getDb().pragma("table_info(memory_episodes)") as Array<{ name: string }>).some((column) => column.name === "detail_json");
  for (let start = 0; start < ticketIds.length; start += 400) {
    const part = ticketIds.slice(start, start + 400), marks = part.map(() => "?").join(",");
    const episodes = (getDb().prepare(`SELECT episode_id FROM memory_episodes WHERE ticket_id IN (${marks})`).all(...part) as Array<{ episode_id: string }>).map((row) => row.episode_id);
    getDb().prepare(`UPDATE memory_episodes SET summary = NULL, summary_hash = NULL, embedding_model = NULL, embedding_adapter = NULL, embedding_model_sha256 = NULL,
      embedding_content_hash = NULL, embedding_dimensions = NULL, embedding_json = NULL${hasDetail ? ", detail_json = NULL" : ""} WHERE ticket_id IN (${marks})`).run(...part);
    for (let at = 0; at < episodes.length; at += 400) {
      const ids = episodes.slice(at, at + 400), idMarks = ids.map(() => "?").join(",");
      if (tableExists("memory_episode_native")) getDb().prepare(`DELETE FROM memory_episode_native WHERE episode_id IN (${idMarks})`).run(...ids);
      if (tableExists("memory_translation_jobs")) getDb().prepare(`DELETE FROM memory_translation_jobs WHERE target_kind='memory_episode' AND target_id IN (${idMarks})`).run(...ids);
    }
    if (tableExists("memory_operations")) getDb().prepare(`UPDATE memory_operations SET payload_json='{}' WHERE payload_json<>'{}' AND operation_id IN (${marks})`).run(...part);
  }
}

/**
 * Commit the durable tombstone and remove every directly retrievable raw DB
 * projection in one IMMEDIATE transaction. Filesystem/nest projections are
 * reconciled by the caller from the bounded return value.
 */
export function revokeOneMemoryEntry(memoryId: string, expectedAgentId: string, options?: {
  /** Owner inspector validates owner/actor/revision/epoch in its enclosing transaction. */
  bindingActor?: boolean;
  /** Internal: the older version of the line being forgotten. Audit 55 D1: it is blanked by its id alone, tied to `ancestorStamp` as a source; its words get no stamp and no other line is matched by them. Never set by a caller. */
  ancestor?: ForgettableMemoryRow;
  /** Internal: the stamp (revocation id and epoch) of the line that was forgotten; required with `ancestor`. */
  ancestorStamp?: { revocationId: string; epoch: number };
  /** Internal: the older version was named by the parent's own walk, which already read its chain. */
  nested?: boolean;
  /** Internal: `finishOlderVersions` is the caller and goes on with what the call leaves (`olderLeft`) itself. */
  deferOlder?: boolean;
  /**
   * K7''' (junction): the asker is a turn of the personal agent that is NOT its own conversation (a project room, a work session): it cannot read Personal, so its forget of a work-knowledge line does not reach the same words in
   * Personal - the stamp and the matching stay inside the line's own owner (the One actor's `agent_repo`). The owner's own doors (the memory screen, the phone, the memory map) and the personal agent's own conversation do not set it: the family is one subject for them.
   */
  ownerOnly?: boolean;
  /** the forget was made by the person at another place and is applied here by the shared-memory sync: the forget clock is not stepped. */
  remote?: boolean;
}): ForgottenMemoryProjection | null {
  const activeNestOwnerScopeKey = activeBorrowedOwnerScopeKey();
  const accountWide = layoutOf(getDb()) !== "central";
  const storeContext = () => ({ memoryRoot: storeMemoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: getDb() });
  let selectedStore: { ref: StoreRef } | null = null;
  let touchedStores: StoreRef[] = [];
  const revoke = getDb().transaction((): ForgottenMemoryProjection | null => {
    const actorIds = memoryActorIds(expectedAgentId);
    const selectedInRoot = options?.ancestor ? undefined : getDb().prepare(options?.bindingActor
      ? `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id,b.owner_namespace
         FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
         WHERE m.id=? AND COALESCE(NULLIF(b.actor_id,''),m.agent_id) IN (${actorIds.map(()=>"?").join(",")}) AND m.superseded_at IS NULL LIMIT 1`
      : `SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, superseded_at
         FROM memory_entries WHERE id = ? AND agent_id IN (${actorIds.map(()=>"?").join(",")}) AND superseded_at IS NULL LIMIT 1`
    ).get(memoryId, ...actorIds) as ForgettableMemoryRow | undefined;
    // with the layout switch not OFF the row may sit in another store. The root stamp below is then written for it exactly as for a root row.
    let selected = options?.ancestor ?? selectedInRoot;
    if (!selected && accountWide) {
      const found = findRowInStores(storeContext(), memoryId, actorIds, Boolean(options?.bindingActor));
      if (found) { selected = found.row as ForgettableMemoryRow; selectedStore = found; }
    }
    if (!selected) return null;
    if (options?.ancestor && !options.ancestorStamp) return null;   // an older version is only ever blanked under the stamp of the line it belongs to
    // Audit 54 G1: the older versions this line replaced are read now, before the stamp and the blanking below empty the evidence that names them.
    const chain = options?.nested ? null : supersedeAncestorsOf(selected, accountWide, getMemoryStoreInfo().ownerNamespace, getDb(), storeMemoryRoot());

    // the same words in the other stores (the selected row itself when it came from one), found BEFORE the stamp below is written: opening a store applies the
    // forget catch-up, and once the stamp exists that would blank the rows before they are named. The root rows are matched as before further down; these rows are stamped and
    // linked to the revocation here, and blanked by their own store's catch-up once the stamp is committed (`finishForgetInStores`).
    // K7': the OWNER of the forgotten line (its scope and its agent, project or Personal). The words are matched inside this owner only, in the root and in every store: the same words alive under
    // another agent, another project or Personal are those subjects' lines and are not forgotten with this one.
    const ownerOf = {
      scope: selected.scope,
      projectId: selected.project_id,
      projectPath: selected.project_path,
      agentId: selected.agent_id ?? selected.actor_id,
      chatId: selected.chat_id,
    };
    const ownerKeys = options?.ownerOnly === true ? memoryAuthorityOwnerKeys(ownerOf) : memoryFamilyOwnerKeys(ownerOf);
    const ownerKeySet = new Set(ownerKeys);
    const rowOwnerKeys = new Map<string, boolean>();   // the keys follow the folder on disk (realpath): once per distinct owner tuple, not once per candidate row
    const sameOwner = (row: ForgettableMemoryRow): boolean => {
      const tuple = `${row.scope}\0${row.project_id ?? ""}\0${row.project_path ?? ""}\0${row.agent_id ?? row.actor_id ?? ""}\0${row.chat_id ?? ""}`;
      let value = rowOwnerKeys.get(tuple);
      if (value === undefined) {
        value = memoryAuthorityOwnerKeys({ scope: row.scope, projectId: row.project_id, projectPath: row.project_path, agentId: row.agent_id ?? row.actor_id, chatId: row.chat_id }).some(key => ownerKeySet.has(key));
        rowOwnerKeys.set(tuple, value);
      }
      return value;
    };
    const stampRule = forgetStampRules();
    const wordsOf = (text: string, stampHash: string): boolean => forgetStampHashes(text).includes(stampHash);
    let storeMatches: Array<{ row: ForgettableMemoryRow; ref: StoreRef }> = [];
    const storeNatives = new Map<string, string>();
    if (accountWide) {
      const here = memoryContentHash(selected.content);
      const rule = { variants: forgetStampHashes, kindBlind: stampRule.kindBlind };   // K7'': the stamp's own rule (same trailing-mark spellings, kind ignored when the stamp is kind-blind)
      let found = matchRowsInStores(storeContext(), selected.kind, new Set([here]), rule);
      const nativeText = found.natives.get(selected.id);
      if (nativeText && memoryContentHash(nativeText) !== here) found = matchRowsInStores(storeContext(), selected.kind, new Set([here, memoryContentHash(nativeText)]), rule);
      storeMatches = found.matches.map((item) => ({ row: item.row as ForgettableMemoryRow, ref: item.ref })).filter((item) => options?.ancestor ? item.row.id === selected.id : (item.row.id === selected.id || sameOwner(item.row)));
      for (const item of storeMatches) { const text = found.natives.get(item.row.id); if (text) storeNatives.set(item.row.id, text); }
      touchedStores = [...new Map(storeMatches.map((item) => [item.ref.path, item.ref])).values()];
    }

    const ownerKey = memoryOwnerKey({scope:selected.scope,projectId:selected.project_id,projectPath:selected.project_path,agentId:selected.agent_id ?? selected.actor_id,chatId:selected.chat_id});
    const contentHash = memoryContentHash(selected.content);
    const now = new Date().toISOString();
    // Audit 55 D1: an older version rides on the stamp of the line that was forgotten (same epoch, no clock step, no stamp of its own words).
    let epoch: number;
    let canonicalRevocation: { revocationId: string };
    if (options?.ancestor) {
      epoch = options.ancestorStamp!.epoch;
      canonicalRevocation = { revocationId: options.ancestorStamp!.revocationId };
    } else {
      // a forget that came from ANOTHER place does not step the clock and is not a fence. Its stamp keeps the words out (the exact-content refusal does not read the clock) and the continuation
      // points of the lines it could have been read into are emptied, but a turn already running here is not refused every other write for it: the stamp's id carries `mrv_remote_` and `latestOwnerRevocation` does not count it.
      // (A stamp's epoch must be above 0: a clock still at 0 gives it 1 without stepping the clock.)
      if (options?.remote !== true) getDb().prepare("UPDATE memory_forget_clock SET epoch = epoch + 1 WHERE id = 1").run();
      epoch = Math.max(options?.remote === true ? 1 : 0, Number((getDb().prepare(
        "SELECT epoch FROM memory_forget_clock WHERE id = 1",
      ).get() as { epoch: number }).epoch));
      purgePreForgetContinuation(epoch, now, continuationReach(selected), options?.remote !== true);
      const revocationId = `${options?.remote === true ? "mrv_remote_" : "mrv_"}${randomUUID()}`;
      for (const authorityKey of ownerKeys) getDb().prepare(
        `INSERT INTO memory_revocations (
           revocation_id, owner_key, memory_kind, content_hash, source_memory_id,
           revoked_epoch, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_key, memory_kind, content_hash) DO UPDATE SET
           source_memory_id = excluded.source_memory_id,
           revoked_epoch = excluded.revoked_epoch,
           revoked_at = excluded.revoked_at`,
      ).run(authorityKey===ownerKey?revocationId:`mrv_${randomUUID()}`, authorityKey, selected.kind, contentHash, selected.id, epoch, now);
      canonicalRevocation = getDb().prepare(
        `SELECT revocation_id AS revocationId FROM memory_revocations
          WHERE owner_key = ? AND memory_kind = ? AND content_hash = ?`,
      ).get(ownerKey, selected.kind, contentHash) as { revocationId: string };
    }

    // The layout switch OFF reads the same scope only (the line below, byte for byte); not OFF matches the kind account-wide, like the engine's `forget`.
    // K7'': the kind is not part of "the same words" when the stamp is kind-blind (the stamp refuses the words under any kind), and the family of the personal agent spans two scopes (Personal and its own work knowledge).
    // The lines are narrowed to the forgotten line's owner family BEFORE their original wordings are read, so a long memory costs one owner check per distinct owner, not one per line.
    const kindFilter = stampRule.kindBlind ? "" : " AND m.kind = ?";
    const kindArgs = stampRule.kindBlind ? [] : [selected.kind];
    const candidates = ((accountWide || selected.scope === "user_identity" || selected.scope === "agent_repo"
      ? getDb().prepare(
        `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id,b.owner_namespace
           FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
          WHERE 1=1${kindFilter}`).all(...kindArgs)
      : getDb().prepare(
      `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id,b.owner_namespace
         FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
        WHERE m.scope = ?${kindFilter}`,
    ).all(selected.scope, ...kindArgs)) as ForgettableMemoryRow[]).filter((row) => options?.ancestor ? row.id === selected.id : (row.id === selected.id || sameOwner(row)))
      // a forget from another place takes the person's facts of those words, never this agent's own `preference` of the same words (the sync names every shared-kind line itself, one by one).
      .filter((row) => !(options?.remote === true && row.scope === "user_identity" && row.kind === "preference" && row.id !== selected.id));
    // English migration: a translated row's original wording lives in the side
    // table. The same original under the same owner is the same memory, and it
    // must be forgotten everywhere it was projected in that wording.
    const candidateNatives = nativeTextsFor("memory_entry", candidates.map((row) => row.id));
    const selectedNative = candidateNatives.get(selected.id);
    const selectedNativeHash = selectedNative ? memoryContentHash(selectedNative) : null;
    const audienceKey = options?.bindingActor
      ? (require("./store") as typeof import("./store")).memoryAudienceKey : null;
    const selectedAudience = audienceKey?.(selected.id);
    const declaredAudience=explicitAudienceKey(selected.id);
    const matchedRoot = candidates.filter((row) => {
      if (options?.ancestor) return row.id === selected.id;   // D1: an older version is found by its id, never by its words
      if (options?.bindingActor && (row.owner_namespace ? row.owner_namespace !== getMemoryStoreInfo().ownerNamespace : !getMemoryStoreInfo().ownerNamespace.startsWith("device-local:"))) return false;
      if (row.id !== selected.id && audienceKey && (audienceKey(row.id) !== selectedAudience || explicitAudienceKey(row.id)!==declaredAudience)) return false;
      if (row.id !== selected.id && !sameOwner(row)) return false;   // K7': another owner's line with the same words stays (it was account-wide once the layout switch was on)
      if (row.id === selected.id || wordsOf(row.content, contentHash)) return true;
      const native = candidateNatives.get(row.id);
      return Boolean(selectedNativeHash && native && wordsOf(native, selectedNativeHash));
    });
    for (const [rowId, text] of storeNatives) candidateNatives.set(rowId, text);
    const matched = [...matchedRoot, ...storeMatches.map((item) => item.row)];
    const sourceMemoryIds = matched.map((row) => row.id);
    // Keep only source identities, never forgotten text. Legacy rows predate
    // source receipts, so capture their evidence before the same transaction
    // redacts it. Existing receipts already carry their original digest.
    if (matched.some((row) => row.scope === "agent_repo" && row.agent_id === BUILTIN_ONE_AGENT_ID)) {
      const owner = getMemoryStoreInfo().ownerNamespace;
      const readEvidence = getDb().prepare("SELECT evidence_json FROM memory_entries WHERE id = ?");
      const keep = getDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      for (const row of matched) {
        if (row.scope !== "agent_repo" || row.agent_id !== BUILTIN_ONE_AGENT_ID) continue;
        const stored = readEvidence.get(row.id) as { evidence_json: string } | undefined;
        let evidence: unknown; try { evidence = JSON.parse(stored?.evidence_json ?? "[]"); } catch { continue; }
        if (!Array.isArray(evidence)) continue;
        for (const token of evidence) {
          const match = typeof token === "string" ? /^one-soul:([0-9a-f]{16})$/.exec(token) : null;
          if (match) keep.run(importSourceKey(owner, BUILTIN_ONE_AGENT_ID, match[1]), FORGOTTEN_IMPORT_SOURCE);
        }
      }
    }
    const projectPaths = [...new Set(matched.map((row) => row.project_path).filter((value): value is string => Boolean(value)))];
    if (sourceMemoryIds.length === 0) return null;

    reconcileLegacyDedupEpisodes(matchedRoot, selected, canonicalRevocation.revocationId, now);

    const linkSource = getDb().prepare(
      `INSERT INTO memory_revocation_sources (source_memory_id, revocation_id)
       VALUES (?, ?)
       ON CONFLICT(source_memory_id) DO UPDATE SET revocation_id = excluded.revocation_id`,
    );
    for (const id of sourceMemoryIds) linkSource.run(id, canonicalRevocation.revocationId);

    const placeholders = sourceMemoryIds.map(() => "?").join(",");
    const ticketIds = (getDb().prepare(`SELECT DISTINCT ticket_id FROM memory_decisions
      WHERE target_memory_id IN (${placeholders}) UNION SELECT ticket_id FROM memory_episode_quarantines
      WHERE revocation_id=?`).all(...sourceMemoryIds, canonicalRevocation.revocationId) as Array<{ ticket_id: string }>).map(row => row.ticket_id);
    // K7': the turn records the line came from. A line the model wrote with the memory_ticket tool, a line the resting-time pass made from several turns and a row written straight into a store have no root decision
    // pointing at them: the turns are found by the lines' own origin links (the root's here, a store's through its own file). Their episode summaries and the host facts kept beside them (`detail_json`: the owner's own
    // message) quote the words, and so does the observed turn a ticket kept (`memory_operations.payload_json`): all are emptied in this same transaction (engine `forget`, step 3).
    const turnTickets = new Set<string>(ticketIds);
    if (tableExists("memory_origin_links")) {
      const rootIds = matchedRoot.map((row) => row.id);
      for (let start = 0; start < rootIds.length; start += 400) {
        const part = rootIds.slice(start, start + 400);
        for (const row of getDb().prepare(`SELECT DISTINCT source_id FROM memory_origin_links WHERE source_kind IN ('ticket','memory-ticket') AND memory_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ source_id: string }>) turnTickets.add(row.source_id);
      }
    }
    if (storeMatches.length) for (const id of ticketsOfRows(storeMatches.map((item) => ({ row: { ...item.row, actor_id: item.row.actor_id ?? null, owner_namespace: item.row.owner_namespace ?? null }, ref: item.ref })))) turnTickets.add(id);
    redactTurnRecords([...turnTickets]);
    purgeLegacyMemoryCopies(sourceMemoryIds, [...turnTickets]);
    (require("./one-legacy") as typeof import("./one-legacy")).purgeLegacyOneArchivedBodies(sourceMemoryIds);
    getDb().prepare(
      `UPDATE memory_revocation_cleanup_targets
          SET revocation_id = ?, state = 'pending', next_attempt_at = ?,
              progress_cursor = NULL,
              last_error_code = NULL, updated_at = ?, completed_at = NULL
        WHERE source_memory_id IN (${placeholders})`,
    ).run(canonicalRevocation.revocationId, now, now, ...sourceMemoryIds);
    notifyCleanupQueued();
    for (const row of matched) {
      const projectPath = canonicalProjectPath(row.project_path);
      if (projectPath) {
        enqueueRevocationCleanupTarget({
          sourceMemoryId: row.id,
          revocationId: canonicalRevocation.revocationId,
          targetKind: "project-files",
          targetRef: projectPath,
          now,
        });
      }
      if (row.scope === "agent_repo") {
        enqueueRevocationCleanupTarget({
          sourceMemoryId: row.id,
          revocationId: canonicalRevocation.revocationId,
          targetKind: "agent-nest-scan",
          targetRef: activeNestOwnerScopeKey,
          now,
        });
      }
    }

    // Tombstone the original wording too: soul/log lines written before the
    // translation carry it, and the same original must not be admitted again.
    const nativeHashes = new Map<string, string[]>();
    for (const row of options?.ancestor ? [] : matched) {   // an older version's original wording gets no stamp either
      const native = candidateNatives.get(row.id);
      if (!native) continue;
      const hash = memoryContentHash(native);
      if (hash === contentHash) continue;
      const rows = nativeHashes.get(hash) ?? [];
      rows.push(row.id);
      nativeHashes.set(hash, rows);
    }
    for (const [nativeHash, rowIds] of nativeHashes) {
      for (const authorityKey of ownerKeys) getDb().prepare(
        `INSERT INTO memory_revocations (
           revocation_id, owner_key, memory_kind, content_hash, source_memory_id,
           revoked_epoch, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_key, memory_kind, content_hash) DO UPDATE SET
           source_memory_id = excluded.source_memory_id,
           revoked_epoch = excluded.revoked_epoch,
           revoked_at = excluded.revoked_at`,
      ).run(`mrv_${randomUUID()}`, authorityKey, selected.kind, nativeHash, selected.id, epoch, now);
      const nativeRevocation = getDb().prepare(
        `SELECT revocation_id AS revocationId FROM memory_revocations
          WHERE owner_key = ? AND memory_kind = ? AND content_hash = ?`,
      ).get(ownerKey, selected.kind, nativeHash) as { revocationId: string };
      for (const row of matched) {
        if (!rowIds.includes(row.id)) continue;
        const projectPath = canonicalProjectPath(row.project_path);
        if (!projectPath) continue;
        // The cleanup lease requires a source→revocation link for its own source id.
        getDb().prepare(
          `INSERT INTO memory_revocation_sources (source_memory_id, revocation_id)
           VALUES (?, ?)
           ON CONFLICT(source_memory_id) DO UPDATE SET revocation_id = excluded.revocation_id`,
        ).run(`${row.id}${NATIVE_TWIN_SOURCE_SUFFIX}`, nativeRevocation.revocationId);
        enqueueRevocationCleanupTarget({
          sourceMemoryId: `${row.id}${NATIVE_TWIN_SOURCE_SUFFIX}`,
          revocationId: nativeRevocation.revocationId,
          targetKind: "project-files",
          targetRef: projectPath,
          now,
        });
      }
    }

    const redactMemory = getDb().prepare(
      `UPDATE memory_entries
          SET content = '', evidence_json = '[]', context_json = '{}', chat_id = NULL,
              embedding_model = NULL, embedding_adapter = NULL,
              embedding_model_sha256 = NULL, embedding_content_hash = NULL,
              embedding_dimensions = NULL, embedding_json = NULL, superseded_at = ?
        WHERE id = ?`,
    );
    const deleteRelations = getDb().prepare(
      "DELETE FROM memory_relation_edges WHERE from_memory_id = ? OR to_memory_id = ?",
    );
    const redactEpisodes = getDb().prepare(
      `UPDATE memory_episodes
          SET summary = NULL, summary_hash = NULL,
              embedding_model = NULL, embedding_adapter = NULL,
              embedding_model_sha256 = NULL, embedding_content_hash = NULL,
              embedding_dimensions = NULL, embedding_json = NULL
        WHERE ticket_id IN (
          SELECT ticket_id FROM memory_decisions WHERE target_memory_id = ?
        )`,
    );
    for (const id of sourceMemoryIds) {
      redactEpisodes.run(id);
      deleteRelations.run(id, id);
      if (tableExists("experience_candidates")) {
        getDb().prepare(
          `UPDATE experience_candidates
              SET summary = '', task_terms_json = '[]', status = 'rejected',
                  public_safe = 0, embedding_model = NULL, embedding_adapter = NULL,
                  embedding_model_sha256 = NULL, embedding_content_hash = NULL,
                  embedding_dimensions = NULL, embedding_json = NULL, updated_at = ?
            WHERE source_memory_id = ?`,
        ).run(now, id);
      }
      if (tableExists("taste_draft_candidates")) {
        getDb().prepare(
          `UPDATE taste_draft_candidates
              SET axis_candidates_json = '[]', task_signatures_json = '[]',
                  status = 'rejected', updated_at = ?
            WHERE source_memory_id = ?`,
        ).run(now, id);
      }
      redactMemory.run(now, id);
      // The original-language side table (store.ts memory_entry_native) must be
      // forgotten with the content. Inline, not imported: store.ts imports this file.
      try { getDb().prepare("DELETE FROM memory_entry_native WHERE entry_id = ?").run(id); } catch { /* no table */ }
    }

    // K7'' (audit D2): the root file's pages. A page of the root a writer without `secure_delete` split or rebalanced keeps old cell bytes where no row points; the blanking above cannot reach them, and nothing rewrote the root.
    // When this forget blanked something in the root (a line or the turn records), the root is owed one rewrite at a resting moment (`storage/db-retention.ts`, the memory VACUUM): the marker is written here, in the same transaction,
    // read by that pass and deleted when the rewrite has finished (`ROOT_RESIDUE_PENDING_KEY`, stores.ts). No new table or column.
    if (matchedRoot.length > 0 || turnTickets.size > 0) getDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ROOT_RESIDUE_PENDING_KEY, String(epoch));
    const projection: ForgottenMemoryProjection = {
      sourceMemoryIds,
      kind: selected.kind,
      content: selected.content,
      contentHash,
      nativeContentHashes: [...nativeHashes.keys()],
      projectPaths,
      forgottenAt: now,
      revokedEpoch: epoch,
      ...(touchedStores.length ? { storeRefs: touchedStores } : {}),
    };
    if (chain?.rows.length) {
      // Each older version is blanked by its id (D1: no stamp of its own words, no other line matched by them), tied to this line's stamp, inside this same transaction: a chain is wholly forgotten or not at all.
      const also: ForgottenMemoryProjection[] = [];
      for (const row of chain.rows) {
        const sub = revokeOneMemoryEntry(row.id, expectedAgentId, { ...options, ancestor: row, nested: true, ancestorStamp: { revocationId: canonicalRevocation.revocationId, epoch } });
        if (sub) also.push(sub);
      }
      if (also.length) {
        projection.also = also;
        projection.sourceMemoryIds = [...new Set([...projection.sourceMemoryIds, ...also.flatMap((item) => item.sourceMemoryIds)])];
        const refs = new Map((projection.storeRefs ?? []).map((ref) => [ref.path, ref] as const));
        for (const item of also) for (const ref of item.storeRefs ?? []) refs.set(ref.path, ref);
        if (refs.size) projection.storeRefs = [...refs.values()];
      }
    }
    if (chain?.left.length) projection.olderLeft = { ids: chain.left, ownerKey: ownerKeyOfRow(selected), stamp: options?.ancestorStamp ?? { revocationId: canonicalRevocation.revocationId, epoch } };   // a chain longer than one forget follows: `finishOlderVersions` goes on from here
    return projection;
  });
  const result = revoke.immediate();
  if (result) {
    clearSelectedMemoryContextCache();
    // The stamp is committed (the outermost transaction ended); now the other stores' rows are blanked. Inside a caller's open transaction this waits for that caller
    // (`finishForgetInStores`) or, failing that, for the next open of those stores — every open applies the same catch-up.
    // with the switch on, a root-only forget also drops the root folder's search index (the engine's `forget` does), so it runs even when no other store held the words.
    // K7': also with the layout switch OFF. The engine's search index (`recall-index.sqlite`) sits beside the root store in every layout and quotes the words; the engine's own forget drops it every time.
    if (!getDb().inTransaction) result.storeForget = finishForgetInStores(result);
    // A chain longer than one forget follows is gone on from here, outside a caller's transaction; inside one, the caller calls `finishOlderVersions` after its commit.
    if (result.olderLeft && !options?.nested && !options?.deferOlder && !getDb().inTransaction) finishOlderVersions(result, expectedAgentId, options);
  }
  return result;
}

/** How many more rounds of FORGET_CHAIN_MAX_DEPTH generations `finishOlderVersions` goes (a chain of 16 + 8 x 16 = 144 generations ends clean; more ends with the code `supersede_depth`). */
const FORGET_CHAIN_MAX_ROUNDS = 8;

/**
 * Audit 54 G1, the rest of a long chain: each round blanks the older versions that were left by their ids (a transaction each, under the stamp of the line that was forgotten) until none is left or the rounds are used up; the
 * receipt gains them (`also`, `sourceMemoryIds`, `storeRefs`) and the other stores are caught up. Never throws. What is still left at the end is the code `supersede_depth` (the skipped-stores line of the memory screen).
 */
export function finishOlderVersions(receipt: ForgottenMemoryProjection, expectedAgentId: string, options?: { bindingActor?: boolean }): void {
  try {
    const left = receipt.olderLeft;
    let pending = left?.ids ?? [];
    for (let round = 0; pending.length && round < FORGET_CHAIN_MAX_ROUNDS; round += 1) {
      const info = getMemoryStoreInfo();
      const dbs = readableDbs(layoutOf(getDb()) !== "central", info.ownerNamespace, getDb(), storeMemoryRoot());
      const following: string[] = [];
      for (const id of pending) {
        const row = olderRowById(dbs, id);
        if (!row || !row.content || ownerKeyOfRow(row) !== left!.ownerKey || (row.owner_namespace && row.owner_namespace !== info.ownerNamespace)) continue;   // gone already, or not this owner's: nothing to forget there
        const sub = revokeOneMemoryEntry(row.id, expectedAgentId, { ...options, ancestor: row, deferOlder: true, ancestorStamp: left!.stamp });
        if (!sub) continue;
        receipt.also = [...(receipt.also ?? []), sub];
        receipt.sourceMemoryIds = [...new Set([...receipt.sourceMemoryIds, ...sub.sourceMemoryIds])];
        const refs = new Map((receipt.storeRefs ?? []).map((ref) => [ref.path, ref] as const));
        for (const item of [sub, ...(sub.also ?? [])]) for (const ref of item.storeRefs ?? []) refs.set(ref.path, ref);
        if (refs.size) receipt.storeRefs = [...refs.values()];
        if (sub.olderLeft) following.push(...sub.olderLeft.ids);
      }
      pending = following;
    }
    // K7'' (audit D1, the chain limit): what is still left past the rounds was only an in-process code before (gone at the next start, the older versions kept their words). Now the rest is a debt in the root file
    // (`forget_chain_left`: the ids, the owner key and the stamp they ride on); the next start of the app goes on from there (`resumeOlderVersions`), a round at a time, until none is left; the key is deleted then.
    if (pending.length) { noteForgetCodes(["supersede_depth"]); if (left) writeChainLeft({ ids: pending.slice(0, CHAIN_LEFT_MAX_IDS), ownerKey: left.ownerKey, stamp: left.stamp }); }
    else if (left) clearChainLeft(left.stamp.revocationId);   // K7''' (P2): this forget's own debt only; another forget's chain is its own key
    delete receipt.olderLeft;
    if (receipt.storeRefs?.length) finishForgetInStores(receipt);
  } catch { noteForgetCodes(["supersede_depth"]); }
}

/**
 * K7'': root `memory_store_meta` key holding the rest of a replacement chain a forget could not follow in one go (`finishOlderVersions`): JSON `{ids, ownerKey, stamp}`. Written when the rounds run out, deleted when none is left;
 * read once at every start of the app (`resumeOlderVersions`, called by `forget-stores.ts runStartupForgetCatchUp`). basis: the ids are the open frontier of the chain (one id per branch of replacements, a handful); more than `CHAIN_LEFT_MAX_IDS`
 * is not a chain a person makes, and the extra ids stay named by the code `supersede_depth`.
 * K7''' (P2): one key PER FORGET, `forget_chain_left:<revocationId>` (the stamp the chain rides on). With one shared key a second forget that ended clean deleted the first one's debt, and the first chain's older versions kept their words for good.
 * The bare key `forget_chain_left` is the form K7'' wrote (a development device may hold one): it is read like the others, and deleted - only while it still holds the value that was read - once its chain is taken up under its own key.
 * Retention: a row of this family is the debt of one forget that did not finish (a chain past 144 generations); it is read at every start and deleted when its chain is done, so the family holds a few rows at most.
 */
export const FORGET_CHAIN_LEFT_KEY = "forget_chain_left";
const CHAIN_LEFT_PREFIX = `${FORGET_CHAIN_LEFT_KEY}:`;
const chainLeftKey = (revocationId: string): string => `${CHAIN_LEFT_PREFIX}${revocationId}`;
const CHAIN_LEFT_MAX_IDS = 64;
interface ChainLeft { ids: string[]; ownerKey: string; stamp: { revocationId: string; epoch: number } }
function writeChainLeft(value: ChainLeft): void {
  try { getDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(chainLeftKey(value.stamp.revocationId), JSON.stringify(value)); } catch { /* the code stays for this run; the next forget of the line follows the chain again */ }
}
function clearChainLeft(revocationId: string): void { try { getDb().prepare("DELETE FROM memory_store_meta WHERE key=?").run(chainLeftKey(revocationId)); } catch { /* harmless: the next start finds nothing left */ } }
/** Goes on with every chain a forget left (the start of the app). True when there was a debt. Never throws. */
export function resumeOlderVersions(): boolean {
  try {
    const rows = getDb().prepare("SELECT key,value FROM memory_store_meta WHERE key=? OR substr(key,1,?)=?").all(FORGET_CHAIN_LEFT_KEY, CHAIN_LEFT_PREFIX.length, CHAIN_LEFT_PREFIX) as Array<{ key: string; value: string }>;
    let any = false;
    for (const row of rows) {
      const drop = (): void => { try { getDb().prepare("DELETE FROM memory_store_meta WHERE key=? AND value=?").run(row.key, row.value); } catch { /* the next start looks again */ } };
      let left: ChainLeft;
      try { left = JSON.parse(row.value) as ChainLeft; } catch { drop(); continue; }
      if (!left || !Array.isArray(left.ids) || !left.ids.length || typeof left.ownerKey !== "string" || !left.stamp?.revocationId) { drop(); continue; }
      any = true;
      const receipt = { sourceMemoryIds: [], kind: "fact", content: "", contentHash: "", nativeContentHashes: [], projectPaths: [], forgottenAt: new Date().toISOString(), revokedEpoch: left.stamp.epoch, olderLeft: left } as unknown as ForgottenMemoryProjection;
      finishOlderVersions(receipt, "", { bindingActor: true });   // writes its rest under its own key, or clears that key
      if (row.key === FORGET_CHAIN_LEFT_KEY) drop();               // the old bare key: its chain is now under its own key (or done)
    }
    return any;
  } catch { return false; }
}

/** The second half of a forget that touched other stores: blank their rows (by opening them), drop the search indexes beside them. Never throws; returns what is still pending as codes. */
export function finishForgetInStores(receipt: Pick<ForgottenMemoryProjection, "storeRefs" | "revokedEpoch">): { state: "forgotten" | "partial"; pending: string[]; left: string[] } {
  try {
    const info = getMemoryStoreInfo();
    return completeForgetInStores({ memoryRoot: storeMemoryRoot(), owner: info.ownerNamespace, rootDb: getDb() }, receipt.storeRefs ?? [], path.dirname(info.path), receipt.revokedEpoch);
  } catch { return { state: "partial", pending: ["store_unreadable"], left: [] }; }
}

/** Owner corrections invalidate derived continuation/queued old-source results,
 * without erasing the superseded original audit row or minting a new authority. */
export function invalidateMemoryContinuationAfterOwnerEdit(): number {
  return getDb().transaction(() => {
    getDb().prepare("UPDATE memory_forget_clock SET epoch=epoch+1 WHERE id=1").run();
    const epoch = currentMemoryForgetEpoch();
    purgePreForgetContinuation(epoch,new Date().toISOString());
    clearSelectedMemoryContextCache();
    return epoch;
  }).immediate();
}
