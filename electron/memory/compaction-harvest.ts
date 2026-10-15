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
// 재적재 방지: canonical DB의 owner/actor/source byte cursor와 원자적 admission receipt를 사용한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insertMemoryEntry } from "./store";
import type { CurationContext } from "./curator";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { getMemoryDb, getMemoryStoreInfo, memoryRoot } from "./database";
import { assertMemorySourceCustody, currentMemorySourceCustody } from "./source-custody";

const INTAKE_MARKER = "[compaction-intake]";

/** cwd → Claude Code 프로젝트 슬러그. CLI가 경로의 `/`·`.`·`_`를 `-`로 치환해 디렉토리명을 만든다. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-").replace(/_/g, "-");
}

function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", projectSlug(cwd), `${sessionId}.jsonl`);
}

// Cursors contain source identities/ranges only, never transcript text. They
// share the admission transaction and account-fenced canonical DB facade.
const MAX_READ_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Cursor { generation: number; source_identity: string; byte_offset: number; anchor_digest: string;
  anchor_bytes: number; tail_digest: string; intake_epoch: number }
function cursorSchema(): ReturnType<typeof getMemoryDb> {
  const db = getMemoryDb();
  db.exec(`CREATE TABLE IF NOT EXISTS memory_compaction_cursors (
    partition_key TEXT PRIMARY KEY, owner_namespace TEXT NOT NULL, actor_id TEXT NOT NULL,
    source_ref TEXT NOT NULL, source_identity TEXT NOT NULL, generation INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL, anchor_digest TEXT NOT NULL, anchor_bytes INTEGER NOT NULL,
    tail_digest TEXT NOT NULL, intake_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_compaction_admissions (
    operation_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL, source_revision TEXT NOT NULL,
    start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, memory_id TEXT,
    disposition TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return db;
}
function bytes(fd: number, offset: number, length: number): Buffer {
  const value = Buffer.alloc(Math.max(0, length));
  let read = 0;
  while (read < value.length) { const n = fs.readSync(fd, value, read, value.length - read, offset + read); if (!n) break; read += n; }
  return value.subarray(0, read);
}
function generatedView(text: string): boolean {
  try { const data = JSON.parse(text); return data?.generated === true && data?.schemaVersion === "agentlas.memory-view.v1"; }
  catch { return false; }
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

/** Bounded append harvest. Intake admission and cursor commit together; this
 * does not claim that a later semantic curator has promoted the hypothesis. */
export function harvestCompactionSummaries(opts: {
  sessionId?: string | null;
  cwd?: string | null;
  ctx: CurationContext;
}): { intake: number } {
  const { sessionId, cwd, ctx } = opts;
  if (!sessionId || !cwd || !ctx.agentId || ctx.experienceIntake?.runtimeKind !== "claude-code"
    || !/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId)) return { intake: 0 };
  const custody = currentMemorySourceCustody();
  let fd: number | undefined, intake = 0;
  try {
    assertMemorySourceCustody(custody, ctx);
    const info = getMemoryStoreInfo(), file = transcriptPath(cwd, sessionId);
    // Only the actual native transcript is a source. Generated memory views
    // and symlinked replacement files cannot become a new import authority.
    const real = fs.realpathSync(file), expected = path.resolve(file);
    if (real !== expected || !fs.lstatSync(file).isFile()) return { intake: 0 };
    const relative = path.relative(memoryRoot(), real);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return { intake: 0 };
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { intake: 0 };
    const identity = hash([stat.dev, stat.ino, stat.birthtimeMs]);
    const source = hash([real, sessionId]);
    const partition = hash([info.ownerNamespace, ctx.agentId, ctx.projectId, ctx.projectPath, ctx.chatId, source]);
    const db = cursorSchema();
    let cursor = db.prepare("SELECT * FROM memory_compaction_cursors WHERE partition_key=?").get(partition) as Cursor | undefined;
    const matches = cursor && cursor.source_identity === identity && stat.size >= cursor.byte_offset
      && hash(bytes(fd, 0, cursor.anchor_bytes)) === cursor.anchor_digest
      && hash(bytes(fd, Math.max(0, cursor.byte_offset - 256), Math.min(256, cursor.byte_offset))) === cursor.tail_digest;
    let offset = matches ? cursor!.byte_offset : 0;
    const generation = cursor ? cursor.generation + (matches ? 0 : 1) : 1;
    const block = bytes(fd, offset, Math.min(MAX_READ_BYTES, stat.size - offset));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;
    while (start < block.length) {
      const lf = block.indexOf(10, start);
      if (lf < 0) break; // Partial UTF-8/JSON line is re-read at the next append.
      const begin = offset + start, end = offset + lf + 1;
      const line = block.subarray(start, lf);
      if (line.length > MAX_LINE_BYTES) break; // No silent cursor jump over an oversized source.
      const text = decoder.decode(line);
      const extracted = extractCompactionSummaries(text);
      if (text.includes("isCompactSummary")) {
        const parsed = JSON.parse(text) as { isCompactSummary?: boolean };
        if (parsed.isCompactSummary === true && !extracted.length) break;
      }
      const summaries = extracted.filter(summary => !generatedView(summary.text));
      const anchorBytes = Math.min(256, end), anchorDigest = hash(bytes(fd, 0, anchorBytes));
      const tailDigest = hash(bytes(fd, Math.max(0, end - 256), Math.min(256, end)));
      const revision = hash([identity, generation, begin, end, hash(line)]);
      const current = fs.fstatSync(fd);
      if (current.size < end || hash(bytes(fd, begin, end - begin)) !== hash(block.subarray(start, lf + 1))) break;
      let admitted = 0;
      db.transaction(() => {
        assertMemorySourceCustody(custody, ctx);
        const head = db.prepare("SELECT * FROM memory_compaction_cursors WHERE partition_key=?").get(partition) as Cursor | undefined;
        if (hash(head ?? null) !== hash(cursor ?? null)) throw new Error("compaction_cursor_changed");
        // Rotation may contain the same UUID. The native source + exact compact
        // UUID/content remains one admission even when its physical file changes.
        for (const summary of summaries) {
          const operation = hash([partition, summary.uuid, summary.text]);
          if (db.prepare("SELECT 1 FROM memory_compaction_admissions WHERE operation_id=?").get(operation)) continue;
          // Upgrade replays use canonical admission provenance, never the old
          // global UUID array. Retired intake is still an admission receipt.
          const prior = db.prepare(`SELECT id FROM memory_entries WHERE scope='session' AND kind='hypothesis'
            AND agent_id IS ? AND chat_id IS ? AND project_id IS ? AND project_path IS ? AND content=?
            AND EXISTS(SELECT 1 FROM json_each(evidence_json) WHERE value=?) LIMIT 1`)
            .get(ctx.agentId,ctx.chatId ?? null,ctx.projectId ?? null,ctx.projectPath ?? null,
              `${INTAKE_MARKER} ${summary.text}`,`compaction:${sessionId}:${summary.uuid}`) as { id: string } | undefined;
          const entry = prior ?? insertMemoryEntry({ scope: "session", kind: "hypothesis",
            content: `${INTAKE_MARKER} ${summary.text}`, confidence: "low", sensitivity: "internal",
            evidence: [`compaction:${sessionId}:${summary.uuid}`], originRefs: [{ kind: "source", id: `claude-compact:${source}`, revision }],
            projectId: ctx.projectId, projectPath: ctx.projectPath, agentId: ctx.agentId, chatId: ctx.chatId,
            intakeRunId: ctx.runId, intakeEpoch: info.revocationEpoch });
          db.prepare("INSERT INTO memory_compaction_admissions VALUES(?,?,?,?,?,?,?,?)").run(operation, partition, revision, begin, end, entry.id, prior ? "intake_replayed" : "intake_admitted", new Date().toISOString());
          if (!prior) admitted++;
        }
        db.prepare(`INSERT INTO memory_compaction_cursors VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(partition_key) DO UPDATE SET source_identity=excluded.source_identity,generation=excluded.generation,
          byte_offset=excluded.byte_offset,anchor_digest=excluded.anchor_digest,anchor_bytes=excluded.anchor_bytes,
          tail_digest=excluded.tail_digest,intake_epoch=excluded.intake_epoch`).run(partition, info.ownerNamespace, ctx.agentId,
          source, identity, generation, end, anchorDigest, anchorBytes, tailDigest, info.revocationEpoch);
      }).immediate();
      intake += admitted;
      cursor = db.prepare("SELECT * FROM memory_compaction_cursors WHERE partition_key=?").get(partition) as Cursor;
      start = lf + 1;
    }
    return { intake };
  } catch { return { intake }; } // The uncommitted line stays pending for retry.
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
