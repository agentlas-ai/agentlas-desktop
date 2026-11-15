// One 파일 서랍 → Desktop memory_entries 반입.
//
// 왜 이 방향인가 (권위 이중화 해소):
//   기획 2.2 저장 위치 표(342행)는 메모리 인프라를 전역 `~/.agentlas/` 와 프로젝트
//   `<project>/.agentlas/` 두 곳에만 둔다 — Desktop `agentlas.sqlite` 는 그 표에 없다.
//   그리고 기획 199행이 "One 은 모든 런타임에서 동작해야 함"을 요구한다. Desktop sqlite 는
//   Desktop 이 깔린 기계에만 있으므로, 모든 런타임에서 공통으로 존재하는 파일 계층이
//   One 기억의 권위여야 한다.
//
//   반대로 빌려온 Hub 에이전트는 Desktop 안에서만 돌아서 curator.ts:653-662 가
//   memory_entries → experience.sqlite 방향으로 미러링한다. One 은 그 반대다.
//   이 파일이 그 비대칭을 한 곳에 적어 둔 지점이다.
//
// 안전 규칙:
//   * 이미 반입한 항목은 다시 넣지 않는다 — 소울 파일의 `<!-- h:<16hex> -->` 를 멱등 키로 쓴다.
//   * 반입 실패가 앱 부팅을 막지 않는다. 실패는 건수로 돌려주고 삼키지 않는다.
//   * One 파일은 읽기만 한다. 여기서 파일을 고치지 않는다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentlasHomeDir } from "../agents/home";

import { getMemoryDb as getDb, getMemoryStoreInfo } from "./database";
import { applyTranslation } from "./english-migration";
import { MemoryRevokedError } from "./revocations";
import { isNonEnglishText, translationSourceHash } from "./native-text";
import { insertMemoryEntryOnce, listMemoryEvidenceTokensForAgent } from "./store";
import { FORGOTTEN_IMPORT_SOURCE, importSourceDigest, importSourceKey, importSourcePrefix } from "./import-source-receipt";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";

/** Desktop `BUILTIN_AGENTS` 의 `agentlas-one` 과 같은 값이어야 한다. */
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
export const ONE_AGENT_ID = BUILTIN_ONE_AGENT_ID;

const ONE_SOUL_RELATIVE = path.join(".agentlas", "project-soul-memory.md");
/** Engine `english-memory-backfill.v1` writes old h → English successor h here. */
const ONE_TRANSLATION_MAP_RELATIVE = path.join(".agentlas", "translation-map.json");

/** `- **[kind]** 내용` + `- 근거|Evidence: …` (+ 선택적 `- Project:` 줄) + `<!-- h:hash -->` 블록.
 *  근거 라벨은 한/영 두 세대가 실존한다 — 한글만 받던 시절 영문 블록은 한 번도 반입되지 못했다(실측 2026-08-11). */
const DURABLE_BLOCK_RE =
  /^- \*\*\[([a-z_]+)\]\*\*\s+(.+?)\n\s+- (?:근거|Evidence):\s*(.*?)\n[\s\S]*?<!--\s*h:([0-9a-f]{16})\s*-->/gm;

export interface OneDurableBlock {
  kind: string;
  content: string;
  evidence: string;
  hash: string;
  /** Original wording when the engine wrote the block in English (`  - Native:` / `  - 원문:`). */
  native?: string;
}

/**
 * Engine format (Agentlas-OS one_workspace._durable_block_text): the original
 * wording sits on the line right AFTER the ticket line that ends with
 * `<!-- h:… -->`, so it follows the matched block rather than being inside it.
 */
const NATIVE_LINE_AFTER_BLOCK_RE = /^[^\n]*\n[ \t]+- (?:Native|원문):[ \t]*([^\n]*)/;

/**
 * 소울 파일에서 durable 블록을 뽑는 순수 함수.
 * DB 없이 검증할 수 있도록 분리했다 — insertMemoryEntry 는 Electron 부팅 뒤에만 살아 있다.
 */
export function parseOneDurableBlocks(text: string): OneDurableBlock[] {
  const blocks: OneDurableBlock[] = [];
  for (const match of text.matchAll(DURABLE_BLOCK_RE)) {
    const [whole, kind, content, evidence, hash] = match;
    const tail = text.slice((match.index ?? 0) + whole.length, (match.index ?? 0) + whole.length + 8_000);
    const native = NATIVE_LINE_AFTER_BLOCK_RE.exec(tail)?.[1]?.trim();
    blocks.push({
      kind,
      content: content.trim(),
      evidence: evidence.trim(),
      hash,
      ...(native && native !== content.trim() ? { native } : {}),
    });
  }
  return blocks;
}

/** 아직 반입되지 않은 블록만. 멱등 판정을 DB 없이 검증할 수 있게 분리한다. */
export function selectUnimported(
  blocks: readonly OneDurableBlock[],
  already: ReadonlySet<string>,
): OneDurableBlock[] {
  const seen = new Set(already);
  const pending: OneDurableBlock[] = [];
  for (const block of blocks) {
    if (seen.has(block.hash)) continue;
    seen.add(block.hash);          // 같은 파일 안의 중복도 한 번만
    pending.push(block);
  }
  return pending;
}

/**
 * The engine's English migration appends a NEW block (new h:) for every
 * translated one and supersedes the old h:. Imported as-is, each would become a
 * second desktop memory beside the row this app already holds for the old h:
 * (~1,700 duplicates on the owner's drawer). Returns successor → predecessor.
 */
export function readEngineTranslationSuccessors(root: string): Map<string, string | null> {
  const successors = new Map<string, string | null>();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, ONE_TRANSLATION_MAP_RELATIVE), "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("memory_import_translation_map_invalid");
    for (const [oldHash, newHash] of Object.entries(data as Record<string, unknown>)) {
      if (/^[0-9a-f]{16}$/.test(oldHash) && typeof newHash === "string" && /^[0-9a-f]{16}$/.test(newHash)) {
        const previous = successors.get(newHash);
        successors.set(newHash, previous === undefined || previous === oldHash ? oldHash : null);
      } else throw new Error("memory_import_translation_map_invalid");
    }
  } catch (error) {
    // The map is optional; a corrupt or unreadable map is not an empty one.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return successors;
}

/**
 * Link the engine's English successor to the row already imported for its
 * predecessor instead of inserting a duplicate. If that row is still in the
 * original language, adopt the engine's English in place (same guarded write
 * the desktop translator uses: hash-checked, forget-aware, original kept in the
 * side table), so the same memory is not translated twice.
 */
function adoptEngineTranslation(predecessor: string, block: OneDurableBlock, owner: string): "linked" | "gone" {
  const db = getDb();
  return db.transaction(() => {
  if (getMemoryStoreInfo().ownerNamespace !== owner) throw new Error("memory_import_owner_changed");
  const key = importSourceKey(owner, ONE_AGENT_ID, block.hash), digest = importSourceDigest(block.kind, block.content, block.native);
  const receipt = db.prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (receipt) {
    if (receipt.value !== FORGOTTEN_IMPORT_SOURCE && receipt.value !== digest) throw new Error("memory_import_source_conflict");
    return "linked";
  }
  const priorSource = db.prepare("SELECT value FROM memory_store_meta WHERE key = ?")
    .get(importSourceKey(owner, ONE_AGENT_ID, predecessor)) as { value: string } | undefined;
  // A durable forget wins even if conflicting legacy duplicates remain.
  if (priorSource?.value === FORGOTTEN_IMPORT_SOURCE) {
    db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(key, FORGOTTEN_IMPORT_SOURCE);
    return "gone";
  }
  const rows = db.prepare(
    `SELECT id, content, sensitivity, evidence_json FROM memory_entries
      WHERE scope = 'agent_repo' AND agent_id = ? AND superseded_at IS NULL AND evidence_json LIKE ?
      LIMIT 2`,
  ).all(ONE_AGENT_ID, `%"one-soul:${predecessor}"%`) as
    Array<{ id: string; content: string; sensitivity: string | null; evidence_json: string }>;
  // Never choose an arbitrary legacy duplicate as a translation owner.
  if (rows.length > 1) throw new Error("memory_import_source_conflict");
  const row = rows[0];
  if (!row) {
    if (priorSource) throw new Error("memory_import_source_unconfirmed");
    return "gone";
  }
  if (isNonEnglishText(row.content) && !isNonEnglishText(block.content)) {
    const outcome = applyTranslation(db, {
      kind: "memory_entry",
      id: row.id,
      sourceHash: translationSourceHash(row.content),
      attempts: 0,
      text: row.content,
      sensitivity: row.sensitivity,
    }, block.content, { translator: "engine:english-memory-backfill.v1", backCheck: null, intakeEpoch: null });
    if (outcome === "forgotten") {
      db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(key, FORGOTTEN_IMPORT_SOURCE);
      return "gone";
    }
    if (outcome === "stale") throw new Error("memory_import_source_unconfirmed");
  }
  let evidence: unknown = [];
  try { evidence = JSON.parse(row.evidence_json); } catch { evidence = []; }
  const list = Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === "string") : [];
  const token = `one-soul:${block.hash}`;
  if (!list.includes(token)) {
    db.prepare("UPDATE memory_entries SET evidence_json = ? WHERE id = ?")
      .run(JSON.stringify([...list, token]), row.id);
  }
  db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(key, digest);
  return "linked";
  }).immediate();
}

export interface OneImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  reason?: string;
}

export function oneWorkspaceRoot(): string {
  return process.env.AGENTLAS_ONE_DIR || path.join(agentlasHomeDir(), "one");
}

/** One 이 켜져 있을 때만 반입한다. 꺼진 One 의 서랍을 앱이 임의로 흡수하지 않는다. */
function oneIsOn(root: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(root, "state.json"), "utf8");
    return Boolean((JSON.parse(raw) as { on?: unknown }).on);
  } catch {
    return false;
  }
}

function normalizeKind(value: string): MemoryKind {
  const allowed: readonly string[] = [
    "fact", "decision", "preference", "risk", "procedure",
    "hypothesis", "evidence", "deprecation", "conflict",
  ];
  // 모르는 종류는 가장 강한 쪽으로 승격하지 않는다 — hypothesis 로 강등한다.
  return (allowed.includes(value) ? value : "hypothesis") as MemoryKind;
}

/** 이미 반입한 해시 집합. 최근 N개가 아니라 전체 provenance를 읽어 오래된 중복도 막는다. */
function importedHashes(prefix: string, receipts: Array<{ key: string }>): Set<string> {
  const seen = new Set<string>();
  for (const row of receipts) {
    const hash = row.key.slice(prefix.length);
    if (/^[0-9a-f]{16}$/.test(hash)) seen.add(hash);
  }
  for (const item of listMemoryEvidenceTokensForAgent(ONE_AGENT_ID, "one-soul:")) {
    const match = /^one-soul:([0-9a-f]{16})$/.exec(item);
    if (match) seen.add(match[1]);
  }
  return seen;
}

let importTimer: NodeJS.Timeout | null = null;
let lastImportedFiles: string | null = null;
let lastConflictClock: string | null = null;
// Private scheduling metadata: the public failed count remains truthful.
const retryableFailures = new WeakMap<OneImportResult, number>();
const receiptConflicts = new WeakSet<OneImportResult>();
const importStartClocks = new WeakMap<OneImportResult, string>();
/** True when a failure of this pass can be fixed by trying again (a deterministic conflict cannot). The 2.0 first-run migration retires the import only when this is false. */
export function oneImportHasRetryableFailures(result: OneImportResult): boolean {
  return result.failed > 0 && retryableFailures.get(result) !== 0;
}
/** One import at a time: the boot import and the rescan tick share it, so a
 *  block can never be inserted twice by two overlapping chunked passes. */
let inflightImport: Promise<OneImportResult> | null = null;
let importStopped = false;

/**
 * P3 — keep the import current while the app stays open. Boot-only import
 * measured a 73-block backlog; a cheap mtime check every few minutes closes
 * it without watching file descriptors or blocking anything.
 */
export function startOneImportScheduler(intervalMs = 5 * 60 * 1000): void {
  if (importTimer) return;
  importStopped = false;
  importTimer = setInterval(() => {
    let signature: string;
    try {
      signature = importFilesSignature(oneWorkspaceRoot());
    } catch {
      return;
    }
    if (inflightImport) return;
    if (signature === lastImportedFiles) {
      if (lastConflictClock === null) return;
      if (!oneIsOn(oneWorkspaceRoot())) return;
      try { if (importForgetClock() === lastConflictClock) return; } catch { return; }
    }
    void runOneImportInBackground().then((outcome) => {
      // Deterministic conflicts remain failures, but repeating an unchanged
      // file cannot resolve them. Transient failures remain eligible for retry.
      if (!outcome.reason && (outcome.failed === 0 || retryableFailures.get(outcome) === 0)) {
        try {
          if (importFilesSignature(oneWorkspaceRoot()) === signature) {
            const conflictClock = receiptConflicts.has(outcome) ? importForgetClock() : null;
            const startClock = importStartClocks.get(outcome);
            // A forget during the pass must not be hidden by the cached signature.
            if (!receiptConflicts.has(outcome) || (startClock !== undefined && startClock === conflictClock)) {
              lastImportedFiles = signature;
              lastConflictClock = conflictClock;
            }
          }
        } catch { /* retry */ }
      }
      if (outcome.imported > 0 || outcome.failed > 0) {
        console.log(
          `[one-import] rescan imported=${outcome.imported} skipped=${outcome.skipped} failed=${outcome.failed}`,
        );
      }
    }, () => { /* reported by the caller path; the next tick retries */ });
  }, intervalMs);
  importTimer.unref?.();
}

function importForgetClock(): string {
  return forgetClockKey(getMemoryStoreInfo());
}

function forgetClockKey(info: ReturnType<typeof getMemoryStoreInfo>): string {
  return JSON.stringify([info.ownerNamespace, info.path, info.revocationEpoch]);
}

function importFilesSignature(root: string): string {
  const signature = (file: string, optional: boolean): string => {
    try {
      const s = fs.statSync(file);
      return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };
  return JSON.stringify([root, signature(path.join(root, ONE_SOUL_RELATIVE), false), signature(path.join(root, ONE_TRANSLATION_MAP_RELATIVE), true)]);
}

/** Stops the rescan tick and makes an in-flight chunked import return at its next block. */
export function stopOneImportScheduler(): void {
  importStopped = true;
  if (importTimer) clearInterval(importTimer);
  importTimer = null;
}

interface PreparedImport {
  result: OneImportResult;
  pending: OneDurableBlock[];
  already: Set<string>;
  successors: Map<string, string | null>;
  owner: string;
  ambiguous: Set<string>;
  failedSources: Set<string>;
  retryableSources: Set<string>;
}

function prepareImport(root: string, text: string | null): PreparedImport | OneImportResult {
  const result: OneImportResult = { scanned: 0, imported: 0, skipped: 0, failed: 0 };
  // An unbound legacy machine drawer cannot be attributed to a freshly signed
  // in account. It remains available only in its explicit device-local store.
  const info = getMemoryStoreInfo();
  const owner = info.ownerNamespace;
  if (!owner.startsWith("device-local:")) return { ...result, reason: "legacy_owner_unbound" };
  if (text === null) return { ...result, reason: "soul_missing" };
  importStartClocks.set(result, forgetClockKey(info));
  const blocks = parseOneDurableBlocks(text);
  result.scanned = blocks.length;
  const prefix = importSourcePrefix(owner, ONE_AGENT_ID);
  const receipts = getDb().prepare("SELECT key,value FROM memory_store_meta WHERE key >= ? AND key < ?").all(prefix, `${prefix}\uffff`) as Array<{ key: string; value: string }>;
  const already = importedHashes(prefix, receipts);
  const receiptByHash = new Map(receipts.map((row) => [row.key.slice(prefix.length), row.value]));
  const changed = new Set<string>();
  let hasReceiptConflict = false;
  const observedDigests = new Map<string, string>();
  for (const block of blocks) {
    const digest = importSourceDigest(block.kind, block.content, block.native);
    const receipt = receiptByHash.get(block.hash), prior = observedDigests.get(block.hash);
    const receiptChanged = receipt !== undefined && receipt !== FORGOTTEN_IMPORT_SOURCE && receipt !== digest;
    if (receiptChanged) hasReceiptConflict = true;
    if (receiptChanged || (prior !== undefined && prior !== digest)) changed.add(block.hash);
    observedDigests.set(block.hash, digest);
  }
  const rawPending = selectUnimported(blocks, already).filter((block) => !changed.has(block.hash));
  result.failed = changed.size;
  result.skipped = blocks.length - rawPending.length - changed.size;
  const successors = readEngineTranslationSuccessors(root);
  const byHash = new Map(rawPending.map((block) => [block.hash, block]));
  const state = new Map<string, number>(), pending: OneDurableBlock[] = [], ambiguous = new Set<string>();
  for (const block of rawPending) {
    const stack: Array<{ block: OneDurableBlock; expanded: boolean }> = [{ block, expanded: false }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const predecessor = successors.get(frame.block.hash);
      if (!frame.expanded) {
        if (state.get(frame.block.hash) === 2) { stack.pop(); continue; }
        state.set(frame.block.hash, 1);
        frame.expanded = true;
        if (predecessor === null) ambiguous.add(frame.block.hash);
        else if (predecessor && byHash.has(predecessor)) {
          if (state.get(predecessor) === 1) ambiguous.add(predecessor);
          else if (state.get(predecessor) !== 2) stack.push({ block: byHash.get(predecessor)!, expanded: false });
        }
      } else {
        if (predecessor && ambiguous.has(predecessor)) ambiguous.add(frame.block.hash);
        state.set(frame.block.hash, 2);
        pending.push(frame.block);
        stack.pop();
      }
    }
  }
  retryableFailures.set(result, 0);
  if (hasReceiptConflict) receiptConflicts.add(result);
  return { result, pending, already, successors, owner, ambiguous, failedSources: new Set(changed), retryableSources: new Set() };
}

/**
 * One block = one committed row whose first evidence token is `one-soul:<h>`.
 * That token is the resume point: a quit between two blocks leaves every
 * committed block visible to `importedHashes()` on the next launch, and an
 * uncommitted one simply is not there, so a restarted import neither loses
 * nor duplicates anything.
 */
function importBlock(block: OneDurableBlock, prepared: PreparedImport): void {
  const { result, already, successors, owner, ambiguous, failedSources, retryableSources } = prepared;
  const predecessor = successors.get(block.hash);
  if (!block.content || ambiguous.has(block.hash) || (predecessor && failedSources.has(predecessor))) {
    if (predecessor && retryableSources.has(predecessor)) {
      retryableSources.add(block.hash);
      retryableFailures.set(result, (retryableFailures.get(result) ?? 0) + 1);
    }
    failedSources.add(block.hash); result.failed += 1; return;
  }
  if (predecessor && already.has(predecessor)) {
    try {
      adoptEngineTranslation(predecessor, block, owner);
      already.add(block.hash);
      result.skipped += 1;
    } catch {
      failedSources.add(block.hash);
      retryableSources.add(block.hash);
      retryableFailures.set(result, (retryableFailures.get(result) ?? 0) + 1);
      result.failed += 1;
    }
    return;
  }
  try {
    const entry = insertMemoryEntryOnce({
      scope: "agent_repo" as MemoryScope,
      kind: normalizeKind(block.kind),
      content: block.content,
      // English block with its original wording → side table (plan §9-8).
      ...(block.native ? { contentNative: block.native } : {}),
      agentId: ONE_AGENT_ID,
      sensitivity: "internal",
      // 첫 항목이 멱등 키다. 두 번째는 One 이 기록한 원 근거.
      evidence: [`one-soul:${block.hash}`, block.evidence].filter(Boolean),
    }, { key: importSourceKey(owner, ONE_AGENT_ID, block.hash), digest: importSourceDigest(block.kind, block.content, block.native), ownerNamespace: owner });
    already.add(block.hash);
    if (entry) result.imported += 1; else result.skipped += 1;
  } catch (error) {
    failedSources.add(block.hash);
    if (!(error instanceof MemoryRevokedError && error.reason === "exact-content-revoked")) {
      retryableSources.add(block.hash);
      retryableFailures.set(result, (retryableFailures.get(result) ?? 0) + 1);
    }
    result.failed += 1;
  }
}

/**
 * One 소울 파일의 durable 블록을 `memory_entries` 로 반입한다.
 * 몇 번 호출해도 같은 결과이며, 실패는 건수로 보고한다.
 *
 * Synchronous: it holds the calling thread for the whole backlog. Main must use
 * `runOneImportInBackground` instead (see there for the measured cost).
 */
export function importOneDurableMemory(rootOverride?: string): OneImportResult {
  const root = rootOverride ?? oneWorkspaceRoot();
  if (!oneIsOn(root)) return { scanned: 0, imported: 0, skipped: 0, failed: 0, reason: "one_off" };
  let text: string | null = null;
  try { text = fs.readFileSync(path.join(root, ONE_SOUL_RELATIVE), "utf8"); } catch { text = null; }
  const prepared = prepareImport(root, text);
  if (!("pending" in prepared)) return prepared;
  for (const block of prepared.pending) importBlock(block, prepared);
  return prepared.result;
}

export interface OneImportProgress {
  done: number;
  total: number;
}

export interface OneImportOptions {
  rootOverride?: string;
  /** Longest stretch of Main work between two yields. */
  sliceMs?: number;
  onProgress?: (progress: OneImportProgress) => void;
  /** Checked before every block; true ends the pass with reason "stopped". */
  shouldStop?: () => boolean;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The same import in bounded slices. Measured 2026-09-27 (1.2.44/1.2.45 smoke,
 * fresh store, ~2,300 blocks): the synchronous pass held Main for 32–36s, so
 * the first screen took 38–42s and the daemon ensure's control-socket ping
 * timed out (`daemon_control_owner_unconfirmed`). Each block is its own
 * committed row, so yielding between blocks changes no data outcome.
 */
export async function importOneDurableMemoryInSlices(options: OneImportOptions = {}): Promise<OneImportResult> {
  const root = options.rootOverride ?? oneWorkspaceRoot();
  const sliceMs = Math.max(1, options.sliceMs ?? 12);
  if (!oneIsOn(root)) return { scanned: 0, imported: 0, skipped: 0, failed: 0, reason: "one_off" };
  let text: string | null = null;
  try { text = await fs.promises.readFile(path.join(root, ONE_SOUL_RELATIVE), "utf8"); } catch { text = null; }
  if (options.shouldStop?.()) return { scanned: 0, imported: 0, skipped: 0, failed: 0, reason: "stopped" };
  const prepared = prepareImport(root, text);
  if (!("pending" in prepared)) return prepared;
  const total = prepared.pending.length;
  let sliceStartedAt = Date.now();
  let reported = 0;
  for (let index = 0; index < total; index += 1) {
    if (options.shouldStop?.()) return { ...prepared.result, reason: "stopped" };
    importBlock(prepared.pending[index], prepared);
    if (Date.now() - sliceStartedAt >= sliceMs) {
      reported = index + 1;
      options.onProgress?.({ done: reported, total });
      await yieldToEventLoop();
      sliceStartedAt = Date.now();
    }
  }
  if (total > 0 && reported < total) options.onProgress?.({ done: total, total });
  return prepared.result;
}

/** Single-flight entry for Main: boot and rescan share one chunked pass. */
export function runOneImportInBackground(
  options: Omit<OneImportOptions, "shouldStop"> = {},
): Promise<OneImportResult> {
  if (inflightImport) return inflightImport;
  const pass = importOneDurableMemoryInSlices({ ...options, shouldStop: () => importStopped })
    .finally(() => { if (inflightImport === pass) inflightImport = null; });
  inflightImport = pass;
  return pass;
}
