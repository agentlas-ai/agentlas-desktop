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

import { insertMemoryEntry, listGlobalMemoryForAgent } from "./store";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";

/** Desktop `BUILTIN_AGENTS` 의 `agentlas-one` 과 같은 값이어야 한다. */
export const ONE_AGENT_ID = "builtin-agentlas-one";

const ONE_SOUL_RELATIVE = path.join(".agentlas", "project-soul-memory.md");

/** `- **[kind]** 내용` + `- 근거: …` + `<!-- h:hash -->` 3줄 블록. */
const DURABLE_BLOCK_RE =
  /^- \*\*\[([a-z_]+)\]\*\*\s+(.+?)\n\s+- 근거:\s*(.*?)\n[\s\S]*?<!--\s*h:([0-9a-f]{16})\s*-->/gm;

export interface OneDurableBlock {
  kind: string;
  content: string;
  evidence: string;
  hash: string;
}

/**
 * 소울 파일에서 durable 블록을 뽑는 순수 함수.
 * DB 없이 검증할 수 있도록 분리했다 — insertMemoryEntry 는 Electron 부팅 뒤에만 살아 있다.
 */
export function parseOneDurableBlocks(text: string): OneDurableBlock[] {
  const blocks: OneDurableBlock[] = [];
  for (const match of text.matchAll(DURABLE_BLOCK_RE)) {
    const [, kind, content, evidence, hash] = match;
    blocks.push({
      kind,
      content: content.trim(),
      evidence: evidence.trim(),
      hash,
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

/** 이미 반입한 해시 집합. 내용이 아니라 해시 표식으로 비교해 중복 반입을 막는다. */
function importedHashes(limit: number): Set<string> {
  const seen = new Set<string>();
  for (const entry of listGlobalMemoryForAgent(ONE_AGENT_ID, limit)) {
    for (const item of entry.evidence) {
      const match = /^one-soul:([0-9a-f]{16})$/.exec(item);
      if (match) seen.add(match[1]);
    }
  }
  return seen;
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
  const pending = selectUnimported(blocks, importedHashes(500));
  result.skipped = blocks.length - pending.length;

  for (const block of pending) {
    try {
      insertMemoryEntry({
        scope: "agent_repo" as MemoryScope,
        kind: normalizeKind(block.kind),
        content: block.content,
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
