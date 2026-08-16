/**
 * 지난 실행을 경험으로 되돌린다 — 소급 1회 보정.
 *
 * 하드 훅은 **앞으로의** 턴을 지킨다. 그런데 그 훅이 붙기 전에 이미 수천 번이 지나갔고,
 * 그 이력은 기억으로도 경험으로도 남지 않았다(실측: 한 에이전트가 913회 실행에 기억 0).
 * 사용자에게는 오래 쓴 에이전트일수록 아무것도 쌓이지 않은 것처럼 보인다.
 *
 * 그래서 이미 저장된 것만으로 복원한다:
 *   run_events(에이전트가 그 대화에서 실제로 돌았다는 증거)
 *   × chat_messages(그때 사람이 무엇을 요청했는지)
 *
 * 지어내지 않는 선은 하드 훅과 같다 — 모델의 답을 요약하지 않고, 요청 문구와 실행 id 만
 * 쓴다. 같은 요청이 반복된 대화는 하나로 접는다(같은 사실을 여러 번 쌓지 않는다).
 *
 * 한 번만 유효하다: 이미 그 기억이 있으면 건너뛰므로 몇 번 실행해도 결과가 같다.
 */
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { insertMemoryEntry } from "../memory/store";
import { autoIntakeCuratedMemory, currentExperienceBaseHash } from "./store";
import { hasDurableRunStartReceipt } from "../store/run-events";

const MIN_REQUEST_CHARS = 12;
const MAX_REQUEST_CHARS = 220;
/** 에이전트당 상한 — 한 번의 보정이 라이브러리를 통째로 갈아엎지 않게. */
const MAX_PER_AGENT = 40;

/** 설치본이 지금 쓰는 기준 해시. 못 구하면 그 에이전트는 건너뛴다(추측하지 않는다). */
function currentBaseHashFor(agentId: string): string | null {
  try { return currentExperienceBaseHash(agentId); } catch { return null; }
}

export interface ExperienceBackfillResult {
  agentsScanned: number;
  memoriesCreated: number;
  intakeAttempted: number;
  skippedExisting: number;
}

interface PastTurn {
  agentId: string;
  chatId: string;
  runId: string;
  request: string;
  at: string;
}

/**
 * 이 에이전트가 실제로 돈 대화에서, 그때의 사용자 요청을 끌어온다.
 *
 * ★실행 id 는 **시작 영수증이 있는 실행**의 것이어야 한다. 영수증이 없는 id 로 만든 후보는
 * 승급에서 거절돼, 사용자 눈에는 다시 "후보만 쌓이고 칩은 0"이 된다.
 *
 * 그런데 시작 영수증 행 자체는 이 에이전트 이름으로 남지 않는다 — 실행이 시작될 때는 누가
 * 맡을지 정해지지 않아 `agent_id` 가 NULL 이다(스웜·편성 실행). 그래서 시작 이벤트를
 * `agent_id = ?` 로 찾으면 항상 0건이다. 실행 id 는 이 에이전트가 남긴 이벤트에서 얻고,
 * 영수증 판정은 그 실행 전체에 묻는다.
 */
function pastTurnsFor(agentId: string, limit: number): PastTurn[] {
  const rows = getDb().prepare(
    `SELECT e.chat_id AS chatId, e.run_id AS runId, MIN(e.ts) AS at
       FROM run_events e
      WHERE e.agent_id = ? AND e.chat_id IS NOT NULL AND e.run_id IS NOT NULL
      GROUP BY e.chat_id, e.run_id
      ORDER BY at DESC
      LIMIT ?`,
  ).all(agentId, limit * 4) as Array<{ chatId: string; runId: string; at: string }>;

  const turns: PastTurn[] = [];
  const seenRequests = new Set<string>();
  const seenChats = new Set<string>();
  for (const row of rows) {
    if (turns.length >= limit) break;
    // 대화당 한 번, 그리고 영수증이 있는 실행만.
    if (seenChats.has(row.chatId)) continue;
    if (!hasDurableRunStartReceipt(row.runId)) continue;
    const message = getDb().prepare(
      `SELECT text FROM chat_messages
        WHERE chat_id = ? AND role = 'user' AND text IS NOT NULL AND TRIM(text) <> ''
        ORDER BY created_at ASC LIMIT 1`,
    ).get(row.chatId) as { text?: string } | undefined;
    const raw = String(message?.text ?? "").replace(/\s+/g, " ").trim();
    if (raw.length < MIN_REQUEST_CHARS) continue;
    const request = raw.length > MAX_REQUEST_CHARS ? `${raw.slice(0, MAX_REQUEST_CHARS)}…` : raw;
    // 같은 요청이 여러 대화에 반복되면 한 번만 — 같은 사실을 여러 번 쌓지 않는다.
    const key = createHash("sha256").update(request).digest("hex").slice(0, 24);
    if (seenRequests.has(key)) continue;
    seenRequests.add(key);
    seenChats.add(row.chatId);
    turns.push({ agentId, chatId: row.chatId, runId: row.runId, request, at: row.at });
  }
  return turns;
}

/**
 * 실행 이력은 있는데 **경험 후보가 하나도 없는** 설치 에이전트를 고른다.
 *
 * ★기준은 기억이 아니라 경험이다. 첫 판은 "기억 0"으로 골랐는데, 기억이 한 건이라도
 * 있으면(다른 경로로 한 줄 들어왔거나, 경험이 될 수 없는 종류였거나) 제외돼 버렸다 —
 * 실측: 913회 실행한 에이전트가 fact 한 건 때문에 보정 대상에서 빠졌다. 사용자가 보는
 * 것은 칩이므로, 비어 있는지도 칩 기준으로 판단해야 한다.
 */
function agentsMissingExperience(): string[] {
  const rows = getDb().prepare(
    `SELECT a.id
       FROM installed_agents a
      WHERE EXISTS (SELECT 1 FROM run_events e WHERE e.agent_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM experience_candidates c WHERE c.agent_id = a.id)`,
  ).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function backfillExperienceFromRunHistory(options: { agentId?: string } = {}): ExperienceBackfillResult {
  const result: ExperienceBackfillResult = {
    agentsScanned: 0, memoriesCreated: 0, intakeAttempted: 0, skippedExisting: 0,
  };
  const agentIds = options.agentId ? [options.agentId] : agentsMissingExperience();

  for (const agentId of agentIds) {
    result.agentsScanned += 1;
    for (const turn of pastTurnsFor(agentId, MAX_PER_AGENT)) {
      const content = `이 에이전트는 다음과 같은 요청을 수행한다: ${turn.request}`;
      const existing = getDb().prepare(
        "SELECT 1 FROM memory_entries WHERE agent_id = ? AND content = ? LIMIT 1",
      ).get(agentId, content);
      if (existing) { result.skippedExisting += 1; continue; }

      let entry;
      try {
        entry = insertMemoryEntry({
          agentId,
          scope: "agent_repo",
          kind: "procedure",
          content,
          confidence: "medium",
          sensitivity: "internal",
          evidenceRefs: [turn.runId],
          source: "host-observed-backfill",
        } as never);
      } catch {
        continue; // 한 건의 실패가 나머지 보정을 막지 않는다.
      }
      result.memoriesCreated += 1;

      try {
        autoIntakeCuratedMemory({
          memory: entry,
          agentId,
          projectId: null,
          projectPath: null,
          /*
           * ★런타임 종류를 "unknown" 으로 넘기면 안 된다. 택소노미는 `/unknown` 으로 끝나는
           * 제약을 가진 환경을 적격으로 보지 않아(taxonomy.ts:313) 수집이 통째로
           * `environment-taxonomy-unavailable` 로 건너뛰어진다 — 후보도 칩도 0이 된다.
           * 이 이력을 관측한 표면은 데스크탑이므로 다른 수집 경로와 같은 값을 쓴다.
           */
          environment: { platform: process.platform, arch: process.arch, runtimeKind: "agentlas-desktop" },
          // null 을 넘기면 "빌트인 레인"으로 해석된다. 설치본의 실제 기준을 그대로 쓴다.
          basePackageHash: currentBaseHashFor(agentId),
          taskHint: turn.request,
          runId: turn.runId,
        } as never);
        result.intakeAttempted += 1;
      } catch {
        // 경험 수집 실패(기준 패키지 부재 등)는 기억까지 되돌릴 이유가 아니다.
      }
    }
  }
  return result;
}
