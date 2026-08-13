// 컴팩션 요약 수집(harvest) — Claude Code가 컨텍스트 한도에서 대화를 자동 압축할 때
// 세션 트랜스크립트(~/.claude/projects/<slug>/<sessionId>.jsonl)에 남기는
// `isCompactSummary: true` 라인을 주워, 큐레이터 인테이크(intake) 티어로만 적재한다.
//
// 설계 원칙(연구 반영): "요약은 원료, 기억은 심사 후."
//  - Claude Code가 어차피 자기 resume용으로 만드는 요약이라 **추가 LLM 비용 0**.
//  - 그러나 이 요약은 **심사되지 않은 기계 자동 요약**이다 — 그대로 durable로 넣으면
//    요약 오류가 영구 기억으로 굳는다(= jarvis-code류의 알려진 함정).
//  - 따라서 무조건 scope=session · kind=hypothesis · confidence=low 로만 적재한다.
//    Memory Curator *에이전트*(LLM)가 나중에 admission 규칙으로 심사해 durable 승격/폐기한다.
//    이 결정론적 substrate는 "원료를 흘려보내는" 역할까지만 한다.
//
// 재적재 방지: 세션별로 이미 취합한 요약 uuid를 userData의 오프셋 파일에 기록한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insertMemoryEntry } from "./store";
import type { CurationContext } from "./curator";

const INTAKE_MARKER = "[compaction-intake]";

/** cwd → Claude Code 프로젝트 슬러그. CLI가 경로의 `/`·`.`·`_`를 `-`로 치환해 디렉토리명을 만든다. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-").replace(/_/g, "-");
}

function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", projectSlug(cwd), `${sessionId}.jsonl`);
}

// 이미 취합한 요약 uuid 집합(세션 무관 전역) — 중복 인테이크 방지. 작으니 통째 로드.
function harvestedFile(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    return path.join(app.getPath("userData"), "compaction-harvested.json");
  } catch {
    return null; // electron 밖(테스트) — 영속화 생략
  }
}

function loadHarvested(): Set<string> {
  const file = harvestedFile();
  if (!file) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveHarvested(seen: Set<string>): void {
  const file = harvestedFile();
  if (!file) return;
  try {
    // 무한 성장 방지 — 최근 2000개만 유지(요약은 세션당 0~수개라 넉넉).
    const arr = Array.from(seen).slice(-2000);
    fs.writeFileSync(file, JSON.stringify(arr), "utf8");
  } catch {
    // best-effort
  }
}

interface CompactionSummary {
  uuid: string;
  text: string;
}

/** 트랜스크립트에서 isCompactSummary 라인만 뽑아 { uuid, text } 로 정규화(순수 함수, 테스트 가능). */
export function extractCompactionSummaries(jsonl: string): CompactionSummary[] {
  const out: CompactionSummary[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes("isCompactSummary")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isCompactSummary !== true) continue;
    const msg = obj.message as { content?: unknown } | undefined;
    const raw = msg?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw)
      ? raw.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";
    const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
    if (uuid && text.trim()) out.push({ uuid, text: text.trim() });
  }
  return out;
}

/** run 완료 후 호출 — 새 컴팩션 요약이 있으면 인테이크 티어로 적재한다. 실패-무해(never throw). */
export function harvestCompactionSummaries(opts: {
  sessionId?: string | null;
  cwd?: string | null;
  ctx: CurationContext;
}): { intake: number } {
  const { sessionId, cwd, ctx } = opts;
  if (!sessionId || !cwd) return { intake: 0 };
  let jsonl: string;
  try {
    jsonl = fs.readFileSync(transcriptPath(cwd, sessionId), "utf8");
  } catch {
    return { intake: 0 }; // 트랜스크립트 없음(다른 런타임·경로) — 조용히 스킵
  }
  const summaries = extractCompactionSummaries(jsonl);
  if (!summaries.length) return { intake: 0 };

  const seen = loadHarvested();
  let intake = 0;
  for (const s of summaries) {
    if (seen.has(s.uuid)) continue;
    try {
      insertMemoryEntry({
        scope: "session",
        kind: "hypothesis",
        content: `${INTAKE_MARKER} ${s.text}`,
        confidence: "low",
        sensitivity: "internal",
        evidence: [`compaction:${sessionId}:${s.uuid}`],
        projectId: ctx.projectId,
        projectPath: ctx.projectPath,
        agentId: ctx.agentId,
        chatId: ctx.chatId,
      });
      // DB insert가 실제 성공한 항목만 처리 완료로 남긴다. 실패한 UUID는 다음 harvest에서
      // 다시 시도되어야 하며, 다른 항목 하나의 성공 때문에 함께 소거되면 안 된다.
      seen.add(s.uuid);
      intake++;
    } catch {
      // 한 건 실패해도 나머지 계속
    }
  }
  if (intake > 0) saveHarvested(seen);
  return { intake };
}
