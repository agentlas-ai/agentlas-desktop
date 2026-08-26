/**
 * 에이전트 신원(agentId) 대응층 — 얹기만 하고 아무것도 옮기지 않는다.
 *
 * `agentId`(`agt_<32hex>`)는 빌드가 첫 빌드에 한 번 발급해 패키지 `agentlas.json` 에
 * 박아 두는 불변 신원이다(오너 결정 2026-08-08 R5, Agentlas-OS `runtime.py:699-713`).
 * 패키지 해시에서 제외돼 있어 값이 생겨도 릴리스가 흔들리지 않는다.
 *
 * 문제는 이 앱이 그 값을 **한 곳에서도 읽지 않았다**는 것이다(전 저장소 실측). 그래서
 * 로컬은 네 갈래 id 로 일해 왔다 — uuid / id==slug / team-member:<sha> / builtin-*.
 * 같은 에이전트가 표면마다 다른 이름을 갖는 원인이다.
 *
 * ★ 이 모듈은 `installed_agents.id` 를 절대 바꾸지 않는다. 그 id 를 부모로 삼는 FK 가
 *   16곳이고 12곳이 ON DELETE CASCADE 다(경험칩 44 · 후보 746 · 승급영수증 360 ·
 *   자동수집영수증 2,045 — 이 기기 실측). 신원은 `agent_identity_map` 에 옆으로 얹고,
 *   양방향으로 답한다.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { resolveAgentPackageDir } from "./files";

export type IdentityMappingSource = "package" | "builtin-reserved" | "minted-local";

export interface AgentIdentity {
  localId: string;
  agentId: string;
  agentVersion: number;
  mappingSource: IdentityMappingSource;
}

const AGENT_ID_RE = /^agt_[0-9a-z_.-]{4,120}$/i;

/** 패키지가 스스로 선언한 agentId. 없거나 형식이 틀리면 null — 지어내지 않는다. */
export function readPackageAgentId(localId: string, slug: string): string | null {
  let dir: string;
  try {
    dir = resolveAgentPackageDir(localId, slug).dir;
  } catch {
    return null;
  }
  try {
    const raw = fs.readFileSync(path.join(dir, "agentlas.json"), "utf8");
    const value = (JSON.parse(raw) as { agentId?: unknown }).agentId;
    if (typeof value === "string" && AGENT_ID_RE.test(value.trim())) return value.trim();
  } catch {
    /* 패키지가 없거나 매니페스트가 깨졌다 — 없는 것으로 다룬다 */
  }
  return null;
}

/**
 * 빌트인은 패키지가 없어서 읽을 agentId 가 없다. 그런데 이 기기 실측으로 빌트인 8행이
 * 경험칩의 41%, 후보의 89% 를 갖고 있다 — 조용히 빼면 그 데이터가 신원 없는 상태가 된다.
 * 그래서 예약 네임스페이스로 **명시 등재**한다.
 */
export function builtinAgentId(slug: string): string {
  return `agt_builtin_${slug.replace(/[^a-z0-9_.-]+/gi, "-").toLowerCase()}`;
}


/**
 * 새로 발급한 신원을 패키지 매니페스트에 되쓴다 — **없을 때만, 한 번만.**
 *
 * 엔진(`runtime.py:699-713`)은 빌드 때 이 값을 박아 두지만, 데스크탑이 만든 패키지에는
 * 그 경로가 없어 실측 결과 이 기기의 로컬 패키지 중 agentId 를 가진 것이 0개였다.
 * 그러면 "패키지가 정본"이라는 규칙이 영원히 발동하지 않고, 기기마다 다른 로컬 id 가
 * 남는다. 값이 매니페스트에 들어가야 에이전트를 옮겨도 신원이 따라간다.
 *
 * `agentlas.json` 은 모든 표면에서 패키지 해시 계산에서 제외되므로(엔진 `upload.py:347`)
 * 값을 적어도 릴리스 무결성이 흔들리지 않는다. 이미 값이 있으면 **절대 덮어쓰지 않는다.**
 */
function persistAgentIdToPackage(localId: string, slug: string, agentId: string): boolean {
  let dir: string;
  try {
    dir = resolveAgentPackageDir(localId, slug).dir;
  } catch {
    return false;
  }
  const manifestPath = path.join(dir, "agentlas.json");
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (typeof manifest.agentId === "string" && manifest.agentId.trim()) return false;
    manifest.agentId = agentId;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return true;
  } catch {
    // 패키지가 없거나 쓸 수 없다 — 대응표에는 남고, 다음에 진짜 값이 오면 승격된다.
    return false;
  }
}

/** 옛 로컬 id → 신원. 없으면 null(추측하지 않는다). */
export function identityForLocalId(localId: string): AgentIdentity | null {
  const row = getDb()
    .prepare(
      "SELECT local_id AS localId, agent_id AS agentId, agent_version AS agentVersion, mapping_source AS mappingSource FROM agent_identity_map WHERE local_id = ?",
    )
    .get(localId) as AgentIdentity | undefined;
  return row ?? null;
}

/** 신원 → 옛 로컬 id 들. 역방향이 없으면 쓰기를 새 id 로 돌린 시점부터 되돌릴 수 없다. */
export function localIdsForAgentId(agentId: string): string[] {
  return (
    getDb()
      .prepare("SELECT local_id AS localId FROM agent_identity_map WHERE agent_id = ? ORDER BY bound_at")
      .all(agentId) as Array<{ localId: string }>
  ).map((row) => row.localId);
}

export interface IdentitySweepResult {
  bound: number;
  fromPackage: number;
  builtinReserved: number;
  mintedLocal: number;
  skippedAlreadyBound: number;
}

/**
 * 등록된 모든 에이전트에 신원을 붙인다. 멱등이고, **이미 붙은 행은 건드리지 않는다** —
 * 패키지 값이 정본이므로, 로컬에서 발급한 뒤 나중에 패키지를 받아 오면 그때 `package` 로
 * 승격시킨다(그 승격만 예외적으로 덮어쓴다).
 */
/**
 * 한 에이전트에게 신원을 붙인다. 아키텍처 사다리는 (에이전트 × 단계) 원장이라
 * 등록된 모든 에이전트에게 정확히 한 번씩 도달한다 — 언제 설치됐든, 누구 소유든.
 */
export function bindAgentIdentity(localId: string): { bound: boolean; agentId: string | null; source: IdentityMappingSource | null } {
  const db = getDb();
  const row = db
    .prepare("SELECT id, slug, builtin FROM installed_agents WHERE id = ?")
    .get(localId) as { id: string; slug: string; builtin: number } | undefined;
  if (!row) return { bound: false, agentId: null, source: null };

  const current = db
    .prepare("SELECT agent_id AS agentId, mapping_source AS source FROM agent_identity_map WHERE local_id = ?")
    .get(localId) as { agentId: string; source: IdentityMappingSource } | undefined;
  const declared = readPackageAgentId(row.id, row.slug);
  // 패키지 값이 정본이다. 이미 그 값으로 묶였거나, 승격시킬 패키지 값이 없으면 그대로 둔다.
  if (current && (current.source === "package" || !declared)) {
    return { bound: false, agentId: current.agentId, source: current.source };
  }

  let agentId: string;
  let source: IdentityMappingSource;
  if (declared) {
    agentId = declared; source = "package";
  } else if (row.builtin) {
    agentId = builtinAgentId(row.slug); source = "builtin-reserved";
  } else {
    agentId = `agt_${randomUUID().replace(/-/g, "")}`; source = "minted-local";
    // 패키지에 적히면 그 순간부터 패키지가 정본이다 — 에이전트를 옮겨도 신원이 따라간다.
    if (persistAgentIdToPackage(row.id, row.slug, agentId)) source = "package";
  }
  db.prepare(
    `INSERT INTO agent_identity_map (local_id, agent_id, agent_version, mapping_source, bound_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(local_id) DO UPDATE SET
       agent_id = excluded.agent_id, mapping_source = excluded.mapping_source, bound_at = excluded.bound_at`,
  ).run(localId, agentId, source, new Date().toISOString());
  return { bound: true, agentId, source };
}

export function sweepAgentIdentities(): IdentitySweepResult {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, slug, builtin FROM installed_agents")
    .all() as Array<{ id: string; slug: string; builtin: number }>;
  const existing = new Map(
    (
      db.prepare("SELECT local_id AS localId, mapping_source AS source FROM agent_identity_map").all() as Array<{
        localId: string;
        source: IdentityMappingSource;
      }>
    ).map((row) => [row.localId, row.source]),
  );

  const upsert = db.prepare(
    `INSERT INTO agent_identity_map (local_id, agent_id, agent_version, mapping_source, bound_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(local_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       mapping_source = excluded.mapping_source,
       bound_at = excluded.bound_at`,
  );

  const result: IdentitySweepResult = {
    bound: 0, fromPackage: 0, builtinReserved: 0, mintedLocal: 0, skippedAlreadyBound: 0,
  };
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    for (const row of rows) {
      const bound = existing.get(row.id);
      const declared = readPackageAgentId(row.id, row.slug);
      // 이미 패키지 값으로 묶였으면 끝. 로컬 발급본은 패키지 값이 나타나면 승격시킨다.
      if (bound === "package" || (bound && !declared)) {
        result.skippedAlreadyBound += 1;
        continue;
      }
      let agentId: string;
      let source: IdentityMappingSource;
      if (declared) {
        agentId = declared; source = "package"; result.fromPackage += 1;
      } else if (row.builtin) {
        agentId = builtinAgentId(row.slug); source = "builtin-reserved"; result.builtinReserved += 1;
      } else {
        agentId = `agt_${randomUUID().replace(/-/g, "")}`;
        if (persistAgentIdToPackage(row.id, row.slug, agentId)) {
          source = "package"; result.fromPackage += 1;
        } else {
          source = "minted-local"; result.mintedLocal += 1;
        }
      }
      upsert.run(row.id, agentId, source, now);
      result.bound += 1;
    }
  });
  run();
  return result;
}
