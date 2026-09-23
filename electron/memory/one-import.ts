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

import { getDb } from "../store/db";
import { applyTranslation } from "./english-migration";
import { isNonEnglishText, translationSourceHash } from "./native-text";
import { insertMemoryEntry, listMemoryEvidenceTokensForAgent } from "./store";
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
export function readEngineTranslationSuccessors(root: string): Map<string, string> {
  const successors = new Map<string, string>();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, ONE_TRANSLATION_MAP_RELATIVE), "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return successors;
    for (const [oldHash, newHash] of Object.entries(data as Record<string, unknown>)) {
      if (/^[0-9a-f]{16}$/.test(oldHash) && typeof newHash === "string" && /^[0-9a-f]{16}$/.test(newHash)) {
        successors.set(newHash, oldHash);
      }
    }
  } catch {
    // no migration yet → nothing to link
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
function adoptEngineTranslation(predecessor: string, block: OneDurableBlock): "linked" | "gone" {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, content, sensitivity, evidence_json FROM memory_entries
      WHERE scope = 'agent_repo' AND agent_id = ? AND superseded_at IS NULL AND evidence_json LIKE ?
      LIMIT 1`,
  ).get(ONE_AGENT_ID, `%"one-soul:${predecessor}"%`) as
    { id: string; content: string; sensitivity: string | null; evidence_json: string } | undefined;
  // Predecessor forgotten or superseded on this desktop: its translation must not return as new memory.
  if (!row) return "gone";
  if (isNonEnglishText(row.content) && !isNonEnglishText(block.content)) {
    const outcome = applyTranslation(db, {
      kind: "memory_entry",
      id: row.id,
      sourceHash: translationSourceHash(row.content),
      attempts: 0,
      text: row.content,
      sensitivity: row.sensitivity,
    }, block.content, { translator: "engine:english-memory-backfill.v1", backCheck: null, intakeEpoch: null });
    if (outcome === "forgotten") return "gone";
  }
  let evidence: unknown = [];
  try { evidence = JSON.parse(row.evidence_json); } catch { evidence = []; }
  const list = Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === "string") : [];
  const token = `one-soul:${block.hash}`;
  if (!list.includes(token)) {
    db.prepare("UPDATE memory_entries SET evidence_json = ? WHERE id = ?")
      .run(JSON.stringify([...list, token]), row.id);
  }
  return "linked";
}

export interface OneImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  reason?: string;
}

export function oneWorkspaceRoot(): string {
  return process.env.AGENTLAS_ONE_DIR || path.join(os.homedir(), ".agentlas", "one");
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
function importedHashes(): Set<string> {
  const seen = new Set<string>();
  for (const item of listMemoryEvidenceTokensForAgent(ONE_AGENT_ID, "one-soul:")) {
    const match = /^one-soul:([0-9a-f]{16})$/.exec(item);
    if (match) seen.add(match[1]);
  }
  return seen;
}

let importTimer: NodeJS.Timeout | null = null;
let lastImportedSoulMtimeMs = 0;

/**
 * P3 — keep the import current while the app stays open. Boot-only import
 * measured a 73-block backlog; a cheap mtime check every few minutes closes
 * it without watching file descriptors or blocking anything.
 */
export function startOneImportScheduler(intervalMs = 5 * 60 * 1000): void {
  if (importTimer) return;
  importTimer = setInterval(() => {
    try {
      const soulPath = path.join(oneWorkspaceRoot(), ONE_SOUL_RELATIVE);
      const mtimeMs = fs.statSync(soulPath).mtimeMs;
      if (mtimeMs <= lastImportedSoulMtimeMs) return;
      const outcome = importOneDurableMemory();
      // 일부 insert가 실패했으면 같은 파일을 다음 tick에 다시 읽는다. 성공하지 않은
      // 블록은 DB provenance가 없으므로 재시도되고, 성공한 블록은 전체 해시 조회로 skip된다.
      if (outcome.failed === 0) lastImportedSoulMtimeMs = mtimeMs;
      if (outcome.imported > 0 || outcome.failed > 0) {
        console.log(
          `[one-import] rescan imported=${outcome.imported} skipped=${outcome.skipped} failed=${outcome.failed}`,
        );
      }
    } catch {
      // soul missing or unreadable — nothing to import this tick
    }
  }, intervalMs);
  importTimer.unref?.();
}

export function stopOneImportScheduler(): void {
  if (importTimer) clearInterval(importTimer);
  importTimer = null;
}

/**
 * One 소울 파일의 durable 블록을 `memory_entries` 로 반입한다.
 * 몇 번 호출해도 같은 결과이며, 실패는 건수로 보고한다.
 */
export function importOneDurableMemory(rootOverride?: string): OneImportResult {
  const root = rootOverride ?? oneWorkspaceRoot();
  const result: OneImportResult = { scanned: 0, imported: 0, skipped: 0, failed: 0 };

  if (!oneIsOn(root)) return { ...result, reason: "one_off" };

  const soulPath = path.join(root, ONE_SOUL_RELATIVE);
  let text: string;
  try {
    text = fs.readFileSync(soulPath, "utf8");
  } catch {
    return { ...result, reason: "soul_missing" };
  }

  const blocks = parseOneDurableBlocks(text);
  result.scanned = blocks.length;
  const already = importedHashes();
  const pending = selectUnimported(blocks, already);
  result.skipped = blocks.length - pending.length;
  const successors = readEngineTranslationSuccessors(root);

  for (const block of pending) {
    const predecessor = successors.get(block.hash);
    if (predecessor && already.has(predecessor)) {
      try {
        adoptEngineTranslation(predecessor, block);
        result.skipped += 1;
      } catch {
        result.failed += 1;
      }
      continue;
    }
    try {
      insertMemoryEntry({
        scope: "agent_repo" as MemoryScope,
        kind: normalizeKind(block.kind),
        content: block.content,
        // English block with its original wording → side table (plan §9-8).
        ...(block.native ? { contentNative: block.native } : {}),
        agentId: ONE_AGENT_ID,
        sensitivity: "internal",
        // 첫 항목이 멱등 키다. 두 번째는 One 이 기록한 원 근거.
        evidence: [`one-soul:${block.hash}`, block.evidence].filter(Boolean),
      });
      result.imported += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
