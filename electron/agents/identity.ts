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
 * ★ 두 가지를 절대 하지 않는다.
 *
 * 1. **`installed_agents.id` 를 바꾸지 않는다.** 그 id 를 부모로 삼는 FK 가 16곳이고
 *    12곳이 ON DELETE CASCADE 다(경험칩 44 · 후보 746 · 승급영수증 360 ·
 *    자동수집영수증 2,045 — 이 기기 실측). 신원은 옆으로 얹고 양방향으로 답한다.
 *
 * 2. **사용자 패키지 폴더에 쓰지 않는다.** `updater/continuity.ts:981-983` 이 업데이트
 *    전후로 `userData/agents` 아래 **모든 파일의 해시**를 대조하고, 하나라도 다르면
 *    fail-closed 로 사용자를 데이터 복구 화면으로 보낸다(`controller.ts:1385`).
 *    한때 여기서 `agentlas.json` 에 agentId 를 써넣었는데, 그러면 이 기기 기준 233대가
 *    전부 위반이 된다. 게다가 클라우드 packageHash 는 `agentlas.json` 을 **포함**하므로
 *    (엔진 `upload.py:3010 hash_upload_files`·데스크탑 `cloud-agents/package.ts:3142`,
 *    양쪽 다 제외 목록이 없다) 릴리스 신원까지 갈라진다.
 *    엔진도 같은 결론에 도달해 있다 — `upload.py:1551` "without writing it to source".
 *    패키지에 신원을 실어야 할 때는 **업로드용 임시 사본에만** 주입한다.
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
export function reservedBuiltinAgentId(slug: string): string {
  return `agt_builtin_${slug.replace(/[^a-z0-9_.-]+/gi, "-").toLowerCase()}`;
}


/** 옛 로컬 id → 신원. 없으면 null(추측하지 않는다). */
export function identityForLocalId(localId: string): AgentIdentity | null {
  const row = getDb()
    .prepare(
      "SELECT local_id AS localId, immutable_agent_id AS agentId, agent_version AS agentVersion, mapping_source AS mappingSource FROM agent_identity_map WHERE local_id = ?",
    )
    .get(localId) as AgentIdentity | undefined;
  return row ?? null;
}

/** 신원 → 옛 로컬 id 들. 역방향이 없으면 쓰기를 새 id 로 돌린 시점부터 되돌릴 수 없다. */
export function localIdsForAgentId(agentId: string): string[] {
  return (
    getDb()
      .prepare("SELECT local_id AS localId FROM agent_identity_map WHERE immutable_agent_id = ? ORDER BY bound_at")
      .all(agentId) as Array<{ localId: string }>
  ).map((row) => row.localId);
}

/**
 * 한 에이전트에게 신원을 붙인다. 아키텍처 사다리는 (에이전트 × 단계) 원장이라
 * 등록된 모든 에이전트에게 정확히 한 번씩 도달한다 — 언제 설치됐든, 누구 소유든.
 *
 * 패키지는 **읽기만** 한다. 선언이 있으면 그것이 정본이고, 없으면 이 기기에서 발급해
 * 대응표에만 적는다. 사용자 폴더는 건드리지 않는다(위 ★2 참조).
 */
export function bindAgentIdentity(localId: string): {
  bound: boolean;
  agentId: string | null;
  source: IdentityMappingSource | null;
} {
  const db = getDb();
  const row = db
    .prepare("SELECT id, slug, builtin FROM installed_agents WHERE id = ?")
    .get(localId) as { id: string; slug: string; builtin: number } | undefined;
  if (!row) return { bound: false, agentId: null, source: null };

  const current = db
    .prepare("SELECT immutable_agent_id AS agentId, mapping_source AS source FROM agent_identity_map WHERE local_id = ?")
    .get(localId) as { agentId: string; source: IdentityMappingSource } | undefined;
  const declared = readPackageAgentId(row.id, row.slug);
  // 패키지 값이 정본이다. 이미 그 값으로 묶였거나 승격시킬 선언이 없으면 그대로 둔다.
  if (current && (current.source === "package" || !declared)) {
    return { bound: false, agentId: current.agentId, source: current.source };
  }

  let agentId: string;
  let source: IdentityMappingSource;
  if (declared) {
    agentId = declared;
    source = "package";
  } else if (row.builtin) {
    agentId = reservedBuiltinAgentId(row.slug);
    source = "builtin-reserved";
  } else {
    agentId = `agt_${randomUUID().replace(/-/g, "")}`;
    source = "minted-local";
  }
  db.prepare(
    `INSERT INTO agent_identity_map (local_id, immutable_agent_id, agent_version, mapping_source, bound_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(local_id) DO UPDATE SET
       immutable_agent_id = excluded.immutable_agent_id, mapping_source = excluded.mapping_source, bound_at = excluded.bound_at`,
  ).run(localId, agentId, source, new Date().toISOString());
  return { bound: true, agentId, source };
}
