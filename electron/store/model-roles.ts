import type {
  RuntimeBackend,
  RuntimeKind,
  RuntimeRole,
  RuntimeSelection,
} from "../../shared/types";
import { getDb } from "./db";

interface ModelRoleRow {
  role: RuntimeRole;
  // Existing databases may still contain the removed Google CLI kind. Read it
  // as a string and canonicalize it at the boundary below.
  kind: string;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
  effort: string | null;
  long_context: number;
  inherit: number;
  updated_at: string;
}

export interface ResolvedModelRole {
  role: RuntimeRole;
  selection: RuntimeSelection;
  inherited: boolean;
  updatedAt: string | null;
}

export interface ModelRoleMember {
  role: RuntimeRole;
  position: number;
  selection: RuntimeSelection;
  updatedAt: string;
}

export interface ModelRolePoolSkip {
  position: number;
  kind: RuntimeKind;
  model: string | null;
  reason: "runtime-unavailable" | "model-unavailable" | "quota-exceeded";
}

export interface ModelRolePoolPick {
  role: RuntimeRole;
  selection: RuntimeSelection;
  position: number | null;
  inherited: boolean;
  skipped: ModelRolePoolSkip[];
}

interface ModelRoleMemberRow {
  role: RuntimeRole;
  position: number;
  kind: string;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
  effort: string | null;
  long_context: number;
  updated_at: string;
}

const VALID_ROLES = new Set<RuntimeRole>(["orchestrator", "worker"]);
const VALID_KINDS = new Set<RuntimeKind>([
  "claude-code",
  "codex",
  "antigravity",
  "kimi",
  "grok",
  "cursor",
  "byok",
  "ollama",
  "lmstudio",
  "mlx",
]);

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalStoredKind(kind: string): RuntimeKind {
  const canonical = kind === "gemini" ? "antigravity" : kind;
  if (!VALID_KINDS.has(canonical as RuntimeKind)) {
    throw new Error(`Unknown stored runtime kind: ${kind}`);
  }
  return canonical as RuntimeKind;
}

function canonicalStoredSelection(row: {
  kind: string;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
}): Pick<RuntimeSelection, "kind" | "backend" | "source" | "model"> {
  const legacyGemini = row.kind === "gemini";
  return {
    kind: canonicalStoredKind(row.kind),
    backend: row.backend ?? undefined,
    // A legacy Google CLI source/model is not a valid Antigravity executable pin.
    source: legacyGemini ? undefined : row.source ?? undefined,
    model: legacyGemini ? undefined : row.model ?? undefined,
  };
}

function assertRole(role: RuntimeRole): void {
  if (!VALID_ROLES.has(role)) throw new Error(`Unknown runtime role: ${role}`);
}

function rowSelection(row: ModelRoleRow, role = row.role): RuntimeSelection {
  return {
    ...canonicalStoredSelection(row),
    effort: row.effort ?? undefined,
    longContext: Boolean(row.long_context),
    role,
    inherit: role === "worker" ? Boolean(row.inherit) : false,
  };
}

function getStoredRow(role: RuntimeRole): ModelRoleRow | null {
  assertRole(role);
  try {
    return (
      (getDb()
        .prepare("SELECT * FROM model_roles WHERE role = ?")
        .get(role) as ModelRoleRow | undefined) ?? null
    );
  } catch {
    return null;
  }
}

function getLegacyOrchestrator(): ResolvedModelRole | null {
  try {
    const row = getDb()
      .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
      .get() as
      | {
          kind: string;
          backend: RuntimeBackend | null;
          source: string | null;
          model: string | null;
          long_context: number;
        }
      | undefined;
    if (!row) return null;
    const effort = (() => {
      try {
        return (
          getDb()
            .prepare("SELECT value FROM meta WHERE key = 'claude_effort'")
            .get() as { value: string } | undefined
        )?.value;
      } catch {
        return undefined;
      }
    })();
    return {
      role: "orchestrator",
      selection: {
        ...canonicalStoredSelection(row),
        effort,
        longContext: Boolean(row.long_context),
        role: "orchestrator",
        inherit: false,
      },
      inherited: false,
      updatedAt: null,
    };
  } catch {
    return null;
  }
}

export function getResolvedModelRole(role: RuntimeRole): ResolvedModelRole | null {
  assertRole(role);
  const row = getStoredRow(role);
  if (role === "orchestrator") {
    if (!row) return getLegacyOrchestrator();
    return {
      role,
      selection: rowSelection(row),
      inherited: false,
      updatedAt: row.updated_at,
    };
  }
  if (row && !row.inherit) {
    return {
      role,
      selection: rowSelection(row),
      inherited: false,
      updatedAt: row.updated_at,
    };
  }
  const orchestratorRow = getStoredRow("orchestrator");
  const orchestrator = orchestratorRow
    ? {
        role: "orchestrator" as const,
        selection: rowSelection(orchestratorRow),
        inherited: false,
        updatedAt: orchestratorRow.updated_at,
      }
    : getLegacyOrchestrator();
  if (!orchestrator) return null;
  return {
    role,
    selection: {
      ...orchestrator.selection,
      role: "worker",
      inherit: true,
    },
    inherited: true,
    updatedAt: row?.updated_at ?? orchestrator.updatedAt,
  };
}

export function listResolvedModelRoles(): Partial<Record<RuntimeRole, ResolvedModelRole>> {
  const orchestrator = getResolvedModelRole("orchestrator");
  const worker = getResolvedModelRole("worker");
  return {
    ...(orchestrator ? { orchestrator } : {}),
    ...(worker ? { worker } : {}),
  };
}

function memberRowToMember(row: ModelRoleMemberRow): ModelRoleMember {
  return {
    role: row.role,
    position: row.position,
    selection: {
      ...canonicalStoredSelection(row),
      effort: row.effort ?? undefined,
      longContext: Boolean(row.long_context),
      role: row.role,
      inherit: false,
    },
    updatedAt: row.updated_at,
  };
}

/** 역할 풀의 순서 있는 후보 목록. 테이블이 없거나 비면 []. */
export function listModelRoleMembers(role: RuntimeRole): ModelRoleMember[] {
  assertRole(role);
  try {
    const rows = getDb()
      .prepare("SELECT * FROM model_role_members WHERE role = ? ORDER BY position ASC")
      .all(role) as ModelRoleMemberRow[];
    return rows.map(memberRowToMember);
  } catch {
    return [];
  }
}

/**
 * 역할 풀 전체 교체(순서가 곧 우선순위). 빈 worker 풀 = 오케스트레이터 풀 상속.
 * 쓰기 후 v79 단일 행(model_roles)을 풀 헤드로 미러해 구버전 리더를 지킨다.
 */
export function setModelRoleMembers(
  role: RuntimeRole,
  selections: RuntimeSelection[],
): ModelRoleMember[] {
  assertRole(role);
  if (role === "orchestrator" && selections.length === 0) {
    throw new Error("Orchestrator pool cannot be empty.");
  }
  for (const selection of selections) {
    if (!VALID_KINDS.has(selection.kind)) {
      throw new Error(`Unknown runtime kind: ${selection.kind}`);
    }
  }
  const db = getDb();
  const updatedAt = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM model_role_members WHERE role = ?").run(role);
    const insert = db.prepare(
      `INSERT INTO model_role_members
       (role, position, kind, backend, source, model, effort, long_context, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    selections.forEach((selection, index) => {
      insert.run(
        role,
        index + 1,
        selection.kind,
        selection.backend ?? null,
        cleanText(selection.source),
        cleanText(selection.model),
        cleanText(selection.effort),
        selection.longContext ? 1 : 0,
        updatedAt,
      );
    });
  });
  replace();
  if (selections.length > 0) {
    setModelRole({ ...selections[0], role, inherit: false });
  } else {
    // 빈 worker 풀 → v79 상속 행으로 미러(의미 동일: 오케스트레이터를 따른다).
    const orchestratorHead = listModelRoleMembers("orchestrator")[0];
    if (orchestratorHead) {
      setModelRole({ ...orchestratorHead.selection, role: "worker", inherit: true });
    }
  }
  return listModelRoleMembers(role);
}

/**
 * 풀에서 첫 가용 멤버를 고른다(순서 = 우선순위). 스킵 사유는 영수증용으로
 * 전부 남긴다. 모든 멤버가 스킵되면 폴백 순서: 첫 멤버(가용성 무시) →
 * 단일 행 해석. worker 풀이 비면 오케스트레이터 풀을 상속한다.
 */
export function pickModelRoleFromPool(
  role: RuntimeRole,
  options: {
    isRuntimeAvailable?: (selection: RuntimeSelection) => boolean;
    isModelUnavailable?: (selection: RuntimeSelection) => boolean;
    isQuotaExceeded?: (selection: RuntimeSelection) => boolean;
  } = {},
): ModelRolePoolPick | null {
  assertRole(role);
  const skipped: ModelRolePoolSkip[] = [];
  const ownMembers = listModelRoleMembers(role);
  const inherited = role === "worker" && ownMembers.length === 0;
  const members = inherited ? listModelRoleMembers("orchestrator") : ownMembers;
  for (const member of members) {
    const selection: RuntimeSelection = { ...member.selection, role, inherit: inherited };
    if (options.isRuntimeAvailable && !options.isRuntimeAvailable(selection)) {
      skipped.push({
        position: member.position,
        kind: member.selection.kind,
        model: member.selection.model ?? null,
        reason: "runtime-unavailable",
      });
      continue;
    }
    // 런타임은 있는데 그 모델이 카탈로그에 없는 경우 — 그대로 넘기면 CLI가
    // 호출 시점에 죽는다. "미설치"와 구분해 사유를 남긴다.
    if (options.isModelUnavailable?.(selection)) {
      skipped.push({
        position: member.position,
        kind: member.selection.kind,
        model: member.selection.model ?? null,
        reason: "model-unavailable",
      });
      continue;
    }
    if (options.isQuotaExceeded?.(selection)) {
      skipped.push({
        position: member.position,
        kind: member.selection.kind,
        model: member.selection.model ?? null,
        reason: "quota-exceeded",
      });
      continue;
    }
    return { role, selection, position: member.position, inherited, skipped };
  }
  if (members.length > 0) {
    // 전원 스킵 — 조용한 대체 없이 1순위를 그대로 쓰고 스킵 내역을 남긴다.
    // (worker 미지정→orchestrator 승격 외의 하향 대체는 계약 위반이다.)
    const head = members[0];
    return {
      role,
      selection: { ...head.selection, role, inherit: inherited },
      position: head.position,
      inherited,
      skipped,
    };
  }
  const single = getResolvedModelRole(role);
  if (!single) return null;
  return {
    role,
    selection: single.selection,
    position: null,
    inherited: single.inherited,
    skipped,
  };
}

export function setModelRole(selection: RuntimeSelection): ResolvedModelRole {
  const role = selection.role ?? "orchestrator";
  assertRole(role);
  if (!VALID_KINDS.has(selection.kind)) {
    throw new Error(`Unknown runtime kind: ${selection.kind}`);
  }
  const inherit = role === "worker" && selection.inherit === true;
  if (role === "orchestrator" && selection.inherit) {
    throw new Error("Orchestrator cannot inherit the worker model.");
  }
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO model_roles
       (role, kind, backend, source, model, effort, long_context, inherit, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET
         kind = excluded.kind,
         backend = excluded.backend,
         source = excluded.source,
         model = excluded.model,
         effort = excluded.effort,
         long_context = excluded.long_context,
         inherit = excluded.inherit,
         updated_at = excluded.updated_at`,
    )
    .run(
      role,
      selection.kind,
      selection.backend ?? null,
      cleanText(selection.source),
      cleanText(selection.model),
      cleanText(selection.effort),
      selection.longContext ? 1 : 0,
      inherit ? 1 : 0,
      updatedAt,
    );
  // 단일 설정(구 UI·모바일·채팅 경로)은 "풀 헤드 교체"다 — 풀이 있는데 헤드를
  // 안 바꾸면 v79 미러와 풀 1순위가 서로 다른 모델을 가리키게 된다.
  try {
    const hasMembers = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM model_role_members WHERE role = ?")
        .get(role) as { n: number }
    ).n > 0;
    if (hasMembers && !inherit) {
      getDb()
        .prepare(
          `UPDATE model_role_members
           SET kind = ?, backend = ?, source = ?, model = ?, effort = ?, long_context = ?, updated_at = ?
           WHERE role = ? AND position = 1`,
        )
        .run(
          selection.kind,
          selection.backend ?? null,
          cleanText(selection.source),
          cleanText(selection.model),
          cleanText(selection.effort),
          selection.longContext ? 1 : 0,
          updatedAt,
          role,
        );
    } else if (hasMembers && inherit) {
      // 상속 선언 = worker 풀 비우기(빈 풀이 곧 상속).
      getDb().prepare("DELETE FROM model_role_members WHERE role = ?").run(role);
    }
  } catch {
    /* members 테이블이 없는 구버전 DB — 단일 행만으로 동작 */
  }
  return getResolvedModelRole(role) as ResolvedModelRole;
}
