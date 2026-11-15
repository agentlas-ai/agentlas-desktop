// Experience chips the owner promoted -> agent memory.
//
// A chip candidate was never an independent memory: it is a summary copy of a
// `memory_entries` row (`source_memory_id`), and nothing creates one any more
// (`experience/store.ts autoIntakeCuratedMemory` returns at once). What a person
// did own is the decision to promote one. This folds exactly that into agent
// memory, once:
//   * the source row still exists  -> the promotion receipt id is added to its
//     evidence as `chip-promoted:<id>` (and a verified receipt makes it `high`);
//   * the source row is gone       -> an `agent_repo` row is made from the
//     candidate summary (only in the device-local store the chips came from).
// Candidates that were never promoted, packs, export intents, cloud receipts and
// auto-intake receipts are not moved; the tables stay readable and are retired by
// the dead-store cleanup. No new table or column: the completion marker
// and the per-row receipts live in `memory_store_meta`.
//
// It must finish before an agent is deleted (the candidate rows vanish with the
// agent through ON DELETE CASCADE), so it runs before the startup steps that can
// delete one. It is safe to run twice, to crash, and to run in Main and the daemon
// at once: the evidence token is added only when absent, and a created row has a
// receipt written in the same transaction as the row.
//
// Rows are written in groups, one transaction per group (many cheap marks, or up to
// one made row), and the event loop is handed back between groups. A crash rolls back the group in flight and nothing
// else; the marker is written only when every group finished.
//
// A summary is a model-written sentence that may quote what a run saw, so a row made
// from one passes the same secret check every other memory write does: the secret
// part is masked before the text is stored or embedded, and a summary that still
// looks secret after masking makes no row.
import { getMemoryDb as getDb, getMemoryStoreInfo } from "./database";
import { createHash } from "node:crypto";
import { importSourceDigest, importSourceKey } from "./import-source-receipt";
import { insertMemoryEntryOnce } from "./store";
import { MemoryRevokedError } from "./revocations";
import { looksSecret, redactSecrets } from "../../shared/secret-patterns";

const MARKER_KEY = "chip-absorb:v1";
// Cheap rows (a promotion mark) per transaction. The write lock and the main thread are held for one group, so it stays small.
const GROUP_SIZE = 100;
const MASK = "[redacted-secret]";

export interface ChipAbsorbResult {
  promoted: number;
  marked: number;
  created: number;
  skipped: number;
  failed: number;
  alreadyDone: boolean;
}

interface PromotedRow {
  id: string;
  agent_id: string;
  source_memory_id: string;
  summary: string;
  sensitivity: string;
  confidence: string;
  receipt_id: string | null;
  verification_status: string | null;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function absorbPromotedExperienceChips(): Promise<ChipAbsorbResult> {
  const result: ChipAbsorbResult = { promoted: 0, marked: 0, created: 0, skipped: 0, failed: 0, alreadyDone: false };
  const db = getDb();
  if (db.prepare("SELECT 1 FROM memory_store_meta WHERE key = ?").get(MARKER_KEY)) return { ...result, alreadyDone: true };
  // A fresh install has no chip tables worth reading; the marker still records that nothing was left to fold.
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_candidates'").get();
  const rows = hasTable
    ? db.prepare(
      `SELECT c.id, c.agent_id, c.source_memory_id, c.summary, c.sensitivity, c.confidence,
              r.id AS receipt_id, r.verification_status
         FROM experience_candidates c
         LEFT JOIN experience_promotion_receipts r ON r.candidate_id = c.id AND r.action = 'promote'
        WHERE c.status = 'promoted'
        ORDER BY c.id`,
    ).all() as PromotedRow[]
    : [];
  result.promoted = rows.length;
  const owner = getMemoryStoreInfo().ownerNamespace;
  // The chips were made on this device before any account existed here; copying their text into another owner's store would relabel it.
  const mayCreate = owner.startsWith("device-local:");
  const readSource = db.prepare("SELECT id, evidence_json, confidence, superseded_at FROM memory_entries WHERE id = ?");

  const absorbOne = (row: PromotedRow): void => {
    const token = `chip-promoted:${row.receipt_id ?? row.id}`;
    const high = row.verification_status === "verified";
    const source = readSource.get(row.source_memory_id) as
      { id: string; evidence_json: string; confidence: string; superseded_at: string | null } | undefined;
    if (source) {
      if (source.superseded_at) { result.skipped += 1; return; }
      let evidence: unknown;
      try { evidence = JSON.parse(source.evidence_json); } catch { evidence = []; }
      const list = Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === "string") : [];
      if (list.includes(token) && (!high || source.confidence === "high")) { result.skipped += 1; return; }
      const next = list.includes(token) ? list : [...list, token];
      db.prepare("UPDATE memory_entries SET evidence_json = ?, confidence = ? WHERE id = ?")
        .run(JSON.stringify(next), high ? "high" : source.confidence, source.id);
      result.marked += 1;
      return;
    }
    if (!mayCreate) { result.skipped += 1; return; }
    // The same masking every memory write gets; what still looks secret afterwards is not stored at all.
    const content = redactSecrets(row.summary.trim(), MASK);
    // Nothing left but the mask (a summary that was only a key) is not a memory.
    if (!content.split(MASK).join("").replace(/[\s\p{P}\p{S}]/gu, "") || looksSecret(content)) { result.skipped += 1; return; }
    const hash = createHash("sha256").update(row.id, "utf8").digest("hex").slice(0, 16);
    const entry = insertMemoryEntryOnce({
      scope: "agent_repo",
      kind: "procedure",
      content,
      agentId: row.agent_id,
      confidence: high ? "high" : (["high", "medium", "low"].includes(row.confidence) ? row.confidence as "high" | "medium" | "low" : "medium"),
      sensitivity: row.sensitivity === "private" || row.sensitivity === "public" ? row.sensitivity : "internal",
      evidence: [token, `chip-candidate:${hash}`],
    }, {
      key: importSourceKey(owner, `experience-chip:${row.agent_id}`, hash),
      digest: importSourceDigest("procedure", content),
      ownerNamespace: owner,
    });
    if (entry) result.created += 1; else result.skipped += 1;
  };

  // A hub-called agent leaves no memory and has no chip: a candidate's agent_id is a foreign key to installed_agents, and a hub agent is never installed.
  // A group is one transaction. Marking a row is cheap, so up to GROUP_SIZE of them share one; making a row is not (its embedding and its
  // similarity edges read up to 160 neighbours), so the row that makes one closes its group and the event loop runs before the next.
  let next = 0;
  while (next < rows.length) {
    const from = next;
    const tally = { ...result };
    try {
      db.transaction(() => {
        while (next < rows.length && next - from < GROUP_SIZE) {
          const row = rows[next];
          next += 1;
          const createdBefore = result.created;
          try {
            // One row failing inside its own savepoint costs that row only; a throw that escapes ends the whole group and none of it is kept.
            db.transaction(() => absorbOne(row))();
          } catch (error) {
            if (error instanceof MemoryRevokedError) result.skipped += 1; // forgotten text stays forgotten
            else result.failed += 1;
          }
          if (result.created > createdBefore) break;
        }
      }).immediate();
    } catch {
      Object.assign(result, tally, { failed: tally.failed + (next - from) });
    }
    await yieldToEventLoop();
  }

  if (result.failed === 0) {
    db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING")
      .run(MARKER_KEY, JSON.stringify({ at: new Date().toISOString(), marked: result.marked, created: result.created }));
  }
  return result;
}
