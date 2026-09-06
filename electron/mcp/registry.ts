// 설치된 에이전트 레지스트리 — SQLite-backed. 다국어 + envRequirements 지원.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getSource as getMarketSource, getCargoSource } from "../marketplace";
import { agentFolderPath, materializeAgentFiles } from "../agents/files";
import { getRoute, removeRoute, setRoute, type AgentRoute, type RuntimeLabel } from "../agents/routes";
import { isPrivateWebOnlyAgent, publicAgentVisibility } from "../agents/policy";
import { deriveListingEntityKind, entityKindAfterRefresh } from "../agents/entity-kind";
import { readCloudAgentRestoreMarker } from "../cloud-agents/restore";
import {
  commitCloudRegistryPackage,
  recoverCloudRegistryTransactions,
  type CloudRegistryAgentRow,
} from "../cloud-agents/registry-transaction";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { installFromCatalog } from "../mcp-tools/registry";
import { getInstalledAgentHubBinding, replaceInstalledAgentHubBinding } from "../ontology/hub-bindings";
import { detachProjectPoolReferences } from "../store/projects";
import { closeAgentOccupancies } from "../store/seats";
import { dedupeLocalInstalledAgents } from "../store/agent-dedupe";
import type { SeedListingFull } from "../marketplace/source";
import type {
  AgentEnvRequirement,
  InstalledAgent,
  MarketplaceListing,
} from "../../shared/types";

type FullListing = SeedListingFull & MarketplaceListing;

type AgentRow = CloudRegistryAgentRow;
let localDuplicateRepairChecked = false;

function toAgent(row: AgentRow): InstalledAgent {
  let envReqs: AgentEnvRequirement[] = [];
  try {
    envReqs = JSON.parse(row.env_requirements_json) as AgentEnvRequirement[];
  } catch {
    envReqs = [];
  }
  // 로컬 임포트 라우팅이 있으면 런타임 라벨/원본 경로/종류를 병합.
  const route = getRoute(row.id);
  const asset = routeAssetState(route);
  // single/team 종류는 로컬 route가 1차, 없으면 DB에 저장된 entity_kind가 권위 신호다.
  // (Hub/클라우드 설치 팀은 route가 없어 이 컬럼이 유일한 신호 — 없으면 single 오분류됨.)
  const persistedKind =
    row.entity_kind === "team" ? "team" : row.entity_kind === "agent" ? "agent" : undefined;
  const kind = route?.kind ?? persistedKind;
  // Legacy automatic imports from deleted pytest workspaces are diagnostic
  // registrations, not selectable workers. Keep their identities and history;
  // suppress only the inventory projection proven by source + missing path.
  const missingTestImport = asset.source === "local-import" && Boolean(route?.missingSince)
    && /[/\\](?:pytest-of-[^/\\]+|pytest-\d+)[/\\]/i.test(route?.path ?? "");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || row.name,
    ...(row.local_display_name ? { localDisplayName: row.local_display_name } : {}),
    tagline: row.tagline,
    taglineEn: row.tagline_en || row.tagline,
    systemPrompt: row.system_prompt,
    mcpServers: JSON.parse(row.mcp_servers_json) as string[],
    envRequirements: envReqs,
    preferredBackend: row.preferred_backend,
    trustGrade: row.trust_grade,
    installedAt: row.installed_at,
    tone: row.tone as InstalledAgent["tone"],
    bookmarkedAt: (row as { bookmarked_at?: string | null }).bookmarked_at ?? null,
    parentTeamId: (row as { parent_team_id?: string | null }).parent_team_id ?? null,
    visibility: missingTestImport ? "background" : publicAgentVisibility(row),
    ...(route
      ? {
          runtimeLabel: route.runtime,
          localPath: route.path,
          assetSource: asset.source,
          ...(route.missingSince ? { sourceMissingSince: route.missingSince } : {}),
          ...(asset.packageHash ? { packageHash: asset.packageHash } : {}),
        }
      : {}),
    ...(kind ? { kind } : {}),
  };
}

function routeAssetState(route: AgentRoute | null): {
  source: NonNullable<InstalledAgent["assetSource"]>;
  packageHash?: string;
} {
  if (!route) return { source: "local-import" };
  const marker = readCloudAgentRestoreMarker(route.path);
  if (route.source === "agent-cloud" || route.source === "hub" || marker) {
    return {
      source: route.source === "hub" ? "hub" : "agent-cloud",
      // The marker is written with the exact swapped package and is therefore
      // the disk-version authority. A stale route must never mask newer bytes.
      ...(marker?.packageHash || route.packageHash
        ? { packageHash: marker?.packageHash || route.packageHash }
        : {}),
    };
  }
  if (route.source === "local-import") {
    const localHash = route.definitionHash || route.packageHash;
    return { source: "local-import", ...(localHash ? { packageHash: localHash } : {}) };
  }
  // Old route records predate source. A valid cloud marker is checked above;
  // everything else was created by the local-folder import flow.
  const legacyLocalHash = route.definitionHash || route.packageHash;
  return { source: "local-import", ...(legacyLocalHash ? { packageHash: legacyLocalHash } : {}) };
}

/** 마켓 리스팅의 entityKind/agentCount로 single/team을 결정. */
/** 이름/슬러그에 팀 표식이 있는지(레거시 backfill 전용 폴백). */
function looksLikeTeamName(...parts: Array<string | null | undefined>): boolean {
  return /(\bteam\b|팀|\bhq\b|\bswarm\b|스웜)/i.test(parts.filter(Boolean).join(" "));
}

/**
 * entity_kind가 비어 있는 기존 설치 행을 한 번 채운다(멱등: NULL만 갱신).
 *   1) 로컬 임포트 route.kind
 *   2) 이름/슬러그 팀 표식 휴리스틱(레거시 Hub 설치 폴백)
 *   3) 그 외 single
 * 부팅 시 seedBuiltinAgents 직후 호출.
 */
export function backfillEntityKinds(): void {
  recoverCloudRegistryTransactions();
  const db = getDb();
  const rows = db
    .prepare("SELECT id, slug, name, name_en FROM installed_agents WHERE entity_kind IS NULL")
    .all() as Array<{ id: string; slug: string; name: string; name_en: string | null }>;
  if (rows.length === 0) return;
  const upd = db.prepare("UPDATE installed_agents SET entity_kind = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const route = getRoute(r.id);
      const kind: "agent" | "team" =
        route?.kind === "team" || looksLikeTeamName(r.slug, r.name, r.name_en) ? "team" : "agent";
      upd.run(kind, r.id);
    }
  });
  tx();
}

export function listInstalledAgents(): InstalledAgent[] {
  recoverCloudRegistryTransactions();
  if (!localDuplicateRepairChecked) {
    localDuplicateRepairChecked = true;
    try {
      dedupeLocalInstalledAgents();
    } catch (error) {
      console.error("[agents] local duplicate repair failed", error);
    }
  }
  return listInstalledAgentsReadOnly();
}

/**
 * Canonical installed-agent projection without recovery, reconciliation, or
 * any other write side effect. Read-only review/preview IPC must use this path
 * so merely opening a proposal can never mutate product state.
 */
export function listInstalledAgentsReadOnly(): InstalledAgent[] {
  const rows = getDb()
    .prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC")
    .all() as AgentRow[];
  return rows.filter((row) => !isPrivateWebOnlyAgent(row)).map(toAgent);
}

export function getAgentById(id: string): InstalledAgent | null {
  recoverCloudRegistryTransactions();
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(id) as AgentRow | undefined;
  if (!row || isPrivateWebOnlyAgent(row)) return null;
  return toAgent(row);
}

export function setAgentLocalDisplayName(idValue: string, value: string): InstalledAgent {
  const id = String(idValue ?? "").trim();
  if (!id || id.length > 256) throw new Error("Agent id is invalid.");
  if (typeof value !== "string") throw new Error("Local display name must be text.");
  const normalized = value.normalize("NFC").trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("Local display name cannot contain control or hidden-direction characters.");
  }
  const length = Array.from(normalized).length;
  if (length > 80) throw new Error("Local display name must be 80 characters or fewer.");
  const current = getAgentById(id);
  if (!current) throw new Error("Installed agent not found.");
  getDb().prepare("UPDATE installed_agents SET local_display_name = ? WHERE id = ?")
    .run(length === 0 ? null : normalized, id);
  emitDesktopStoreChange({ entity: "agent", id });
  return getAgentById(id)!;
}

export async function installAgent(slug: string): Promise<InstalledAgent> {
  if (isPrivateWebOnlyAgent({ slug })) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }
  let listing = await getMarketSource().getListingBySlug(slug);
  if (!listing) throw new Error(`Unknown marketplace slug: ${slug}`);
  if (isPrivateWebOnlyAgent(listing)) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }

  // Public call-only Hub cards deliberately omit source instructions. They must
  // never fall through to local-prompt execution, but refusing them outright made
  // it impossible to seat any public Hub agent in One Team (measured 2026-08-23:
  // top live listings 6/6 refused). Instead we register a borrow seat: an empty
  // prompt plus a hub route marker. Execution always goes through the Hub borrow
  // path (OrchestrationTarget {source:"hub", slug} → borrowed task force) —
  // discriminated by shared/call-only-agent.ts isCallOnlyHubAgent (hub asset with
  // no local instructions). Owner package restore remains installMyAgent().
  if (typeof listing.systemPrompt !== "string" || !listing.systemPrompt.trim()) {
    // The live manifest endpoint (marketplace.get_manifest) drops kind/callable
    // (measured 2026-08-23: search row {kind:"cloud-callable", callable:true}
    // vs manifest {} for the same slug), so the callable discrimination must
    // fall back to the search row before concluding "corrupt package".
    let callableCard = listing.callable === true || listing.kind === "cloud-callable";
    if (!callableCard) {
      const rows = await getMarketSource().searchAgents(slug).catch(() => []);
      const row = rows.find((item) => item.slug === slug);
      callableCard = Boolean(row && (row.callable === true || row.kind === "cloud-callable"));
      if (row?.packageHash && !listing.packageHash) listing = { ...listing, packageHash: row.packageHash };
    }
    if (callableCard) {
      if (listing.trustGrade !== "A" && listing.trustGrade !== "B") {
        throw new Error(
          `Trust grade ${listing.trustGrade} blocked. Sideloading requires explicit approval (V1+).`,
        );
      }
      const seated = persistListing(slug, { ...listing, systemPrompt: "" }, "hub");
      setRoute({
        agentId: seated.id,
        path: agentFolderPath(slug),
        runtime: "generic",
        labels: ["generic"],
        kind: seated.kind === "team" ? "team" : "agent",
        importedAt: new Date().toISOString(),
        source: "hub",
        ...(listing.packageHash ? { packageHash: listing.packageHash } : {}),
      });
      emitDesktopStoreChange({ entity: "agent", id: seated.id });
      return getAgentById(seated.id)!;
    }
    throw new Error("This Hub package is missing the instructions required for a safe local install.");
  }

  if (listing.trustGrade !== "A" && listing.trustGrade !== "B") {
    throw new Error(
      `Trust grade ${listing.trustGrade} blocked. Sideloading requires explicit approval (V1+).`,
    );
  }

  return persistListing(slug, listing, "hub");
}

/**
 * 내 에이전트(cargo) 설치 — owner-only cargo.restore_package로 실제 Agent Cloud
 * 파일과 packageHash를 받은 뒤 원자 복원한다. draft manifest는 안전한 표시 메타데이터
 * fallback일 뿐 파일/버전 권위가 아니다. 본인 소유라 trust 게이트는 건너뛴다.
 */
export async function installMyAgent(id: string): Promise<InstalledAgent> {
  const source = getCargoSource();
  if (!source) throw new Error("Agentlas marketplace is not connected (memory mode).");
  const listing = await source.restoreMyAgentPackage(id);
  if (isPrivateWebOnlyAgent(listing)) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }
  return persistListing(listing.slug, listing, "agent-cloud");
}

/**
 * 에이전트가 호출하는 외부 MCP/API를 external tools에 자동 등록한다.
 * 매칭 규칙:
 *   - 에이전트의 mcpServers(문자열 id)에 카탈로그 id가 포함되거나
 *   - 에이전트의 envRequirements 키 중 하나라도 카탈로그 도구가 요구하는 키와 일치하면
 * 그 카탈로그 도구를 설치(installFromCatalog는 멱등). 사용자는 키만 넣으면 바로 사용.
 */
function autoRegisterAgentTools(listing: FullListing): void {
  try {
    const serverIds = new Set(listing.mcpServers ?? []);
    const envKeys = new Set((listing.envRequirements ?? []).map((e) => e.key));
    for (const entry of MCP_TOOL_CATALOG) {
      const byId = serverIds.has(entry.id);
      const byEnv = entry.envRequirements.some((r) => envKeys.has(r.key));
      if (byId || byEnv) {
        try {
          installFromCatalog(entry.id);
        } catch {
          // 개별 도구 등록 실패는 무시
        }
      }
    }
  } catch {
    // 자동 등록은 베스트에포트 — 실패해도 설치는 진행
  }
}

function persistListing(
  slug: string,
  listing: FullListing,
  packageSource: "agent-cloud" | "hub",
): InstalledAgent {
  recoverCloudRegistryTransactions();
  const envReqsJson = JSON.stringify(listing.envRequirements ?? []);
  const visibility = publicAgentVisibility(listing);
  const listingEntityKind = deriveListingEntityKind(listing);
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM installed_agents WHERE slug = ?")
    .get(slug) as AgentRow | undefined;
  const id = existing?.id ?? randomUUID();
  const entityKind = existing
    ? entityKindAfterRefresh(existing.entity_kind, listing)
    : listingEntityKind;
  const now = new Date().toISOString();
  const expectedRow: AgentRow = existing
    ? {
      ...existing,
      system_prompt: listing.systemPrompt,
      name: listing.name,
      name_en: listing.nameEn,
      tagline: listing.tagline,
      tagline_en: listing.taglineEn,
      mcp_servers_json: JSON.stringify(listing.mcpServers ?? []),
      env_requirements_json: envReqsJson,
      trust_grade: listing.trustGrade,
      tone: listing.tone,
      builtin: existing.builtin ?? 0,
      role: existing.role ?? null,
      visibility,
      entity_kind: entityKind,
      local_display_name: existing.local_display_name ?? null,
    }
    : {
        id,
        slug,
        name: listing.name,
        name_en: listing.nameEn,
        tagline: listing.tagline,
        tagline_en: listing.taglineEn,
        system_prompt: listing.systemPrompt,
        mcp_servers_json: JSON.stringify(listing.mcpServers ?? []),
        env_requirements_json: envReqsJson,
        preferred_backend: null,
        trust_grade: listing.trustGrade,
        installed_at: now,
        tone: listing.tone,
        builtin: 0,
        role: null,
        visibility,
        entity_kind: entityKind,
        local_display_name: null,
      };

  // Clear before any package/registry transition. If the process dies between
  // installing a new immutable package and receiving/persisting its new exact
  // binding, Ontology projection disappears instead of reusing the old release.
  // A retry may restore the binding; local execution remains usable meanwhile.
  replaceInstalledAgentHubBinding({
    installedAgentId: id,
    source: packageSource === "hub" ? "hub-install" : "agent-cloud-restore",
  });

  const mutateDb = () => {
    if (existing) {
      db.prepare(
        `UPDATE installed_agents
         SET system_prompt = ?, name = ?, name_en = ?, tagline = ?, tagline_en = ?,
             mcp_servers_json = ?, env_requirements_json = ?, trust_grade = ?, tone = ?,
             visibility = ?, entity_kind = ?
         WHERE slug = ?`,
      ).run(
        expectedRow.system_prompt,
        expectedRow.name,
        expectedRow.name_en,
        expectedRow.tagline,
        expectedRow.tagline_en,
        expectedRow.mcp_servers_json,
        expectedRow.env_requirements_json,
        expectedRow.trust_grade,
        expectedRow.tone,
        expectedRow.visibility,
        expectedRow.entity_kind,
        slug,
      );
      return;
    }
    db.prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
        visibility, entity_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expectedRow.id,
      expectedRow.slug,
      expectedRow.name,
      expectedRow.name_en,
      expectedRow.tagline,
      expectedRow.tagline_en,
      expectedRow.system_prompt,
      expectedRow.mcp_servers_json,
      expectedRow.env_requirements_json,
      expectedRow.preferred_backend,
      expectedRow.trust_grade,
      expectedRow.installed_at,
      expectedRow.tone,
      expectedRow.builtin,
      expectedRow.role,
      expectedRow.visibility,
      expectedRow.entity_kind,
    );
  };

  const pkg = listing.cloudPackage;
  if (pkg) {
    const labels = detectCloudRuntimeLabels(pkg.files.map((file) => file.path));
    const expectedRoute: AgentRoute = {
      agentId: id,
      path: agentFolderPath(slug),
      runtime: labels[0],
      labels,
      kind: pkg.agentKind === "team" ? "team" : "agent",
      importedAt: now,
      source: packageSource,
      packageHash: pkg.packageHash,
    };
    commitCloudRegistryPackage({
      slug,
      package: pkg,
      previousRow: existing ?? null,
      expectedRow,
      expectedRoute,
      registration: listing.cloudRegistration,
      mutateDb,
    });
  } else {
    db.transaction(mutateDb)();
    materializeAgentFiles(id);
  }

  // External-tool discovery is intentionally post-commit and best-effort. A
  // catalog registration can neither split nor veto the package transaction.
  autoRegisterAgentTools(listing);
  replaceInstalledAgentHubBinding({
    installedAgentId: id,
    agentDefinitionId: listing.agentDefinitionId,
    agentReleaseId: listing.agentReleaseId,
    source: packageSource === "hub" ? "hub-install" : "agent-cloud-restore",
    boundAt: now,
  });
  const agent = toAgent(expectedRow);
  emitDesktopStoreChange({ entity: "agent", id });
  return agent;
}

function detectCloudRuntimeLabels(paths: string[]): RuntimeLabel[] {
  const labels: RuntimeLabel[] = [];
  const normalized = paths.map((file) => file.replace(/\\/g, "/"));
  if (normalized.some((file) => file === "CLAUDE.md" || file.startsWith(".claude/"))) labels.push("claude-code");
  if (normalized.some((file) => file === "AGENTS.md")) labels.push("codex");
  if (normalized.some((file) => file === "GEMINI.md")) labels.push("gemini");
  if (normalized.some((file) => file.startsWith(".cursor/") || file === ".cursorrules")) labels.push("cursor");
  if (labels.length === 0) labels.push("generic");
  return labels;
}

export function uninstallAgent(id: string): void {
  const db = getDb();
  const firmRows = db
    .prepare("SELECT id, name, ceo_agent_id, org_chart_json FROM firms")
    .all() as Array<{ id: string; name: string; ceo_agent_id: string; org_chart_json: string }>;
  const membership = firmRows.find((firm) => {
    if (firm.ceo_agent_id === id) return true;
    try {
      return (JSON.parse(firm.org_chart_json) as Array<{ agentId?: string }>).some(
        (node) => node.agentId === id,
      );
    } catch {
      return false;
    }
  });
  if (membership) {
    throw new Error(
      `Agent belongs to installed firm "${membership.name}". Remove the firm relationship first; the agent and its chats will stay installed.`,
    );
  }

  // Read the identities this agent can be referenced by BEFORE the row and its
  // cascading binding disappear: the installed id, the slug a Cloud/Hub catalog
  // row carries, and the exact Hub definition id a synced bookmark row uses.
  const identity = db
    .prepare("SELECT slug FROM installed_agents WHERE id = ?")
    .get(id) as { slug?: string } | undefined;
  const binding = getInstalledAgentHubBinding(id);

  // T1 봇 삭제 = 자리 비우기(SEAT-SESSION-PLAN-v2 I4). 삭제 전에 이 봇의 열린 점유
  // 행을 닫아 좌석을 빈 자리로 남긴다 — 좌석·세션·점유 이력은 전부 보존되고,
  // chats.agent_id 는 v102 FK(ON DELETE SET NULL)가 대화를 지키게 한다.
  try { closeAgentOccupancies(id); } catch { /* 좌석 원장이 없는 구세대 DB — 삭제 자체는 진행 */ }
  const deleted = db.prepare("DELETE FROM installed_agents WHERE id = ?").run(id).changes > 0;
  // 로컬 임포트 라우팅도 정리 (원본 폴더는 건드리지 않음).
  if (deleted) {
    removeRoute(id);
    // A removed agent must not keep staffing projects. This is the consequence
    // of removal itself, so every surface that can remove an agent gets it.
    detachProjectPoolReferences({
      agentIds: [id],
      remoteTargetIds: [identity?.slug, binding?.agentDefinitionId].filter(
        (value): value is string => Boolean(value),
      ),
    });
    emitDesktopStoreChange({ entity: "agent", id });
  }
}

/** 팀/싱글 종류 자가교정 — 리졸버(LLM)가 재판정한 kind를 영속화. */
export function setAgentEntityKind(id: string, kind: "agent" | "team"): void {
  const result = getDb().prepare("UPDATE installed_agents SET entity_kind = ? WHERE id = ?").run(kind, id);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "agent", id });
}

// chat history는 electron/store/chats.ts로 이동했음 (chat_id FK 기반)
// 기존 import 경로 보호를 위해 deprecated re-export 남김 — V1에서 제거
export {
  appendChatMessage,
  listChatMessages as listChatHistory,
  clearChatMessages as clearChatHistory,
} from "../store/chats";
