// 유휴 드리밍 큐레이션 — Claude Code/Codex의 "드리밍"처럼, 사용자가 자리를 비운 유휴 시간에
// 큐레이터가 쌓아둔 durable 메모리를 정리한다. 1단계는 결정론 dedup(무LLM), 2단계는 메모리가
// 많이 쌓인 에이전트에 한해 LLM 1회 호출로 규칙 통합.
//
// 과부하 금지 가드(전부 만족해야 발화):
//   · 옵트인 — 설정 기본 OFF (meta "memory_dreaming_enabled")
//   · 시스템 유휴 ≥ 10분(powerMonitor) · 실행 슬롯 완전 유휴(inUse=0, queued=0)
//   · 쿨다운 6시간 · 동시 1패스 · 사용자가 돌아오면(유휴 리셋) 즉시 abort
//   · LLM 호출은 selection의 슬롯 래핑 러너 경유 → 전역 동시성 예산 + nice 5 상속
import { powerMonitor } from "electron";
import { getMeta, setMeta } from "../store/meta";
import { runSlotStats } from "../runtime/run-slots";
import { detectRuntimes } from "../runtime/detect";
import { pickActive, pickRunner } from "../runtime/selection";
import {
  dedupExactDuplicateMemories,
  insertMemoryEntry,
  listAgentIdsWithLiveMemory,
  listGlobalMemoryForAgent,
  supersedeMemoryEntries,
  type MemoryEntry,
} from "./store";
import {
  agentNestExperienceOwnership,
  reconcileAgentNestExperienceConsolidation,
} from "./project-files";
import { getAgentById } from "../mcp/registry";

const ENABLED_KEY = "memory_dreaming_enabled";
const LAST_AT_KEY = "memory_dreaming_last_at";
const IDLE_REQUIRED_SEC = 600; // 10분
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6시간
const TICK_MS = 5 * 60 * 1000; // 5분마다 조건 확인(조건 체크 자체는 ~0 비용)
const MAX_AGENTS_PER_PASS = 2; // 한 번의 드리밍에서 LLM 통합할 에이전트 수 상한
const LLM_TIMEOUT_MS = 180_000;

export function getDreamingEnabled(): boolean {
  return getMeta(ENABLED_KEY) === "1";
}

export function setDreamingEnabled(enabled: boolean): void {
  setMeta(ENABLED_KEY, enabled ? "1" : "0");
}

export interface DreamingStatus {
  enabled: boolean;
  lastRunAt: string | null;
  running: boolean;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export function strictestMemorySensitivity(
  entries: Array<Pick<MemoryEntry, "sensitivity">>,
): MemoryEntry["sensitivity"] {
  const rank: Record<MemoryEntry["sensitivity"], number> = {
    public: 0,
    internal: 1,
    private: 2,
    confidential: 3,
    secret: 4,
  };
  return entries.reduce<MemoryEntry["sensitivity"]>(
    (strictest, entry) => rank[entry.sensitivity] > rank[strictest]
      ? entry.sensitivity
      : strictest,
    "public",
  );
}

export function getDreamingStatus(): DreamingStatus {
  return { enabled: getDreamingEnabled(), lastRunAt: getMeta(LAST_AT_KEY) || null, running };
}

export function startDreamingScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
}

export function stopDreamingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function idleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0; // powerMonitor 불가 환경 — 유휴 아님으로 취급(발화 안 함)
  }
}

async function tick(): Promise<void> {
  if (running) return;
  if (!getDreamingEnabled()) return;
  const lastAt = getMeta(LAST_AT_KEY);
  if (lastAt && Date.now() - Date.parse(lastAt) < COOLDOWN_MS) return;
  if (idleSeconds() < IDLE_REQUIRED_SEC) return;
  const slots = runSlotStats();
  if (slots.inUse > 0 || slots.queued > 0) return;

  running = true;
  try {
    await dreamOnce();
    setMeta(LAST_AT_KEY, new Date().toISOString());
  } catch (err) {
    console.error("[dreaming] pass failed:", err);
  } finally {
    running = false;
  }
}

async function dreamOnce(): Promise<void> {
  // 1단계 — 결정론 dedup(무LLM, 수 ms).
  const deduped = dedupExactDuplicateMemories();
  if (deduped > 0) console.log(`[dreaming] dedup: superseded ${deduped} duplicate entries`);

  // 2단계 — 메모리가 많이 쌓인 에이전트만 LLM 통합(패스당 상한).
  const targets = listAgentIdsWithLiveMemory(8).slice(0, MAX_AGENTS_PER_PASS);
  if (targets.length === 0) return;

  const runtimes = await detectRuntimes();
  const active = pickActive(runtimes);
  const picked = active ? pickRunner(active) : null;
  if (!picked) return; // 사용 가능한 런타임 없음 — 다음 기회에

  for (const target of targets) {
    // 사용자가 돌아왔으면 즉시 중단 — 드리밍은 항상 양보한다.
    if (idleSeconds() < 30) return;
    const agent = getAgentById(target.agentId);
    if (!agent) continue;
    const allEntries = listGlobalMemoryForAgent(target.agentId, 60).filter(
      (e) => e.scope === "agent_repo" && e.agentId === target.agentId,
    );
    if (allEntries.length < 8) continue;
    // A primary installed agent may have invoked several borrowed Hub agents.
    // Consolidate only one group whose rows have the identical projection-owner
    // set; otherwise a rule derived from agent B could leak into agent A's nest.
    const ownership = agentNestExperienceOwnership(allEntries.map((entry) => entry.id));
    const ownerGroups = new Map<string, MemoryEntry[]>();
    for (const entry of allEntries) {
      const key = JSON.stringify(ownership[entry.id] ?? []);
      const group = ownerGroups.get(key) ?? [];
      group.push(entry);
      ownerGroups.set(key, group);
    }
    const entries = [...ownerGroups.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([, group]) => group)
      .find((group) => group.length >= 8);
    if (!entries) continue;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    // 유휴 이탈 감시 — 30초마다 확인, 사용자가 활동하면 즉시 abort.
    const watchdog = setInterval(() => {
      if (idleSeconds() < 30) controller.abort();
    }, 30_000);
    watchdog.unref?.();

    try {
      const numbered = entries
        .map((e, i) => `${i + 1}. [${e.kind}/${e.confidence}] ${e.content.replace(/\s+/g, " ").slice(0, 400)}`)
        .join("\n");
      const result = await picked.runner(
        {
          systemPrompt: [
            "You are a memory consolidation pass for an AI agent. Merge redundant or fragmentary memory entries into a few durable rules.",
            'Return ONLY valid JSON: {"rules": ["..."], "absorbed": [1,2,...]} — no markdown fences, no prose.',
            "rules: max 5 distilled, actionable rules in the same language as the entries. Each must preserve concrete specifics (paths, flags, names).",
            "absorbed: the entry numbers fully covered by your rules. NEVER absorb an entry whose specifics are not preserved in a rule.",
            "If the entries are already clean and distinct, return {\"rules\": [], \"absorbed\": []}.",
          ].join("\n"),
          history: [],
          userPrompt: `Agent: ${agent.name}\nMemory entries:\n${numbered}`,
          backendLabel: picked.label,
          permission: "read",
          signal: controller.signal,
          locale: "en",
        },
        { onPartial: () => {}, onStatus: () => {} },
      );
      const parsed = extractJson(result.text);
      if (!parsed) continue;
      const rules = (Array.isArray(parsed.rules) ? parsed.rules : []).filter(
        (r): r is string => typeof r === "string" && r.trim().length > 0,
      );
      const absorbed = (Array.isArray(parsed.absorbed) ? parsed.absorbed : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= entries.length);
      if (rules.length === 0 || absorbed.length === 0) continue;
      const absorbedEntries = absorbed.map((n) => entries[n - 1]);
      const strictestSensitivity = strictestMemorySensitivity(absorbedEntries);
      const consolidated = rules.slice(0, 5).map((rule) =>
        insertMemoryEntry({
          scope: "agent_repo",
          kind: "procedure",
          content: rule.trim(),
          agentId: target.agentId,
          confidence: "medium",
          sensitivity: strictestSensitivity,
          evidence: [`dreaming: consolidated ${absorbed.length}/${entries.length} entries`],
        }));
      const absorbedIds = absorbedEntries.map((entry) => entry.id);
      supersedeMemoryEntries(absorbedIds);
      // Keep the cross-project projection aligned with Desktop ownership. The
      // single-rule case has an unambiguous structural successor; multi-rule
      // consolidation retires stale sources without manufacturing pairwise
      // supersedes edges the LLM did not provide.
      reconcileAgentNestExperienceConsolidation(absorbedIds, consolidated.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        sensitivity: entry.sensitivity,
        tags: entry.requestContext?.triggerTerms,
        updatedAt: entry.createdAt,
      })));
      console.log(`[dreaming] agent ${agent.slug}: ${rules.length} rules from ${absorbed.length} entries`);
    } catch (err) {
      // abort(사용자 복귀/타임아웃) 포함 — 조용히 다음 기회로.
      if (!controller.signal.aborted) console.error("[dreaming] consolidation failed:", err);
      return;
    } finally {
      clearTimeout(timeout);
      clearInterval(watchdog);
    }
  }
}

function extractJson(text: string): { rules?: unknown; absorbed?: unknown } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { rules?: unknown; absorbed?: unknown };
  } catch {
    return null;
  }
}
