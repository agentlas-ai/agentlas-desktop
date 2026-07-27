import type {
  RuntimeBackend,
  RuntimeKind,
  RuntimeRole,
  RuntimeSelection,
} from "../../shared/types";
import { getDb } from "./db";

interface ModelRoleRow {
  role: RuntimeRole;
  kind: RuntimeKind;
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

const VALID_ROLES = new Set<RuntimeRole>(["orchestrator", "worker"]);
const VALID_KINDS = new Set<RuntimeKind>([
  "claude-code",
  "codex",
  "gemini",
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

function assertRole(role: RuntimeRole): void {
  if (!VALID_ROLES.has(role)) throw new Error(`Unknown runtime role: ${role}`);
}

function rowSelection(row: ModelRoleRow, role = row.role): RuntimeSelection {
  return {
    kind: row.kind,
    backend: row.backend ?? undefined,
    source: row.source ?? undefined,
    model: row.model ?? undefined,
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
          kind: RuntimeKind;
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
        kind: row.kind,
        backend: row.backend ?? undefined,
        source: row.source ?? undefined,
        model: row.model ?? undefined,
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
  return getResolvedModelRole(role) as ResolvedModelRole;
}
