// One 홈 use-case 칩의 로테이션 슬롯 신호 — 전부 로컬 SQLite 읽기 전용.
// 결정적 계산만 한다: 실패한 자동화(최신 실행이 실패 계열) > 최근 7일 미사용 기능.
// 이 모듈은 어떤 것도 생성/수정/실행하지 않는다. 실패하면 렌더러가 로테이션 칩을
// 그리지 않는 것으로 fail-closed 된다(칩 4개 고정분은 신호 없이도 뜬다).
import { getDb } from "../store/db";
import type { OneHomeSignalsV1 } from "../../shared/types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 실패 계열 실행 상태 — 사람이 "고치기"로 개입할 가치가 있는 종결. */
const FAILED_RUN_STATUSES = new Set(["error", "blocked", "needs_input"]);

function latestFailedAutomation(): OneHomeSignalsV1["fixTarget"] {
  const rows = getDb().prepare(
    `SELECT a.id AS id, a.name AS name, r.status AS status, r.ran_at AS ran_at
       FROM automations a
       JOIN run_history r ON r.automation_id = a.id
      WHERE r.ran_at = (
        SELECT MAX(ran_at) FROM run_history WHERE automation_id = a.id
      )
      ORDER BY r.ran_at DESC`,
  ).all() as Array<{ id: string; name: string; status: string | null; ran_at: string | null }>;
  for (const row of rows) {
    if (row.status && FAILED_RUN_STATUSES.has(row.status)) {
      return { kind: "failed_automation", automationId: row.id, name: row.name };
    }
  }
  return null;
}

function usedWithin(nowMs: number, isoValue: string | null | undefined): boolean {
  if (!isoValue) return false;
  const parsed = Date.parse(isoValue);
  return Number.isFinite(parsed) && nowMs - parsed <= SEVEN_DAYS_MS;
}

function capabilityUsedWithin7Days(
  capability: NonNullable<OneHomeSignalsV1["staleCapability"]>,
  nowMs: number,
): boolean {
  const db = getDb();
  if (capability === "automation") {
    const row = db.prepare(
      "SELECT MAX(COALESCE(last_run_at, created_at)) AS latest FROM automations",
    ).get() as { latest: string | null } | undefined;
    return usedWithin(nowMs, row?.latest);
  }
  if (capability === "experience") {
    const row = db.prepare(
      "SELECT MAX(created_at) AS latest FROM experience_promotion_receipts",
    ).get() as { latest: string | null } | undefined;
    return usedWithin(nowMs, row?.latest);
  }
  if (capability === "build") {
    const row = db.prepare(
      "SELECT MAX(installed_at) AS latest FROM installed_agents",
    ).get() as { latest: string | null } | undefined;
    return usedWithin(nowMs, row?.latest);
  }
  const row = db.prepare(
    "SELECT MAX(last_used_at) AS latest FROM agent_usage",
  ).get() as { latest: string | null } | undefined;
  return usedWithin(nowMs, row?.latest);
}

/** 로테이션 소개 우선순위 — 고정 순서라 같은 상태면 항상 같은 칩이 나온다. */
const STALE_CAPABILITY_ORDER: Array<NonNullable<OneHomeSignalsV1["staleCapability"]>> = [
  "automation",
  "experience",
  "build",
  "library",
];

export function getOneHomeSignals(nowMs = Date.now()): OneHomeSignalsV1 {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  const usageCount = getDb().prepare("SELECT COUNT(*) AS n FROM agent_usage").get() as { n: number };
  const fixTarget = latestFailedAutomation();
  let staleCapability: OneHomeSignalsV1["staleCapability"] = null;
  for (const capability of STALE_CAPABILITY_ORDER) {
    if (!capabilityUsedWithin7Days(capability, nowMs)) {
      staleCapability = capability;
      break;
    }
  }
  return {
    contractVersion: 1,
    firstRun: usageCount.n === 0,
    fixTarget,
    staleCapability,
  };
}
