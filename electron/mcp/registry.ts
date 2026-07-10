// 설치된 에이전트 레지스트리 — SQLite-backed. 다국어 + envRequirements 지원.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getSource as getMarketSource, getCargoSource } from "../marketplace";
import { agentFolderPath, materializeAgentFiles } from "../agents/files";
import { getRoute, removeRoute, setRoute, type RuntimeLabel } from "../agents/routes";
import { isPrivateWebOnlyAgent, publicAgentVisibility } from "../agents/policy";
import { deriveListingEntityKind, entityKindAfterRefresh } from "../agents/entity-kind";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { installFromCatalog } from "../mcp-tools/registry";
import type { SeedListingFull } from "../marketplace/source";
import type {
  AgentEnvRequirement,
  AgentVisibility,
  InstalledAgent,
  MarketplaceListing,
  RuntimeBackend,
} from "../../shared/types";

type FullListing = SeedListingFull & MarketplaceListing;

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  system_prompt: string;
  mcp_servers_json: string;
  env_requirements_json: string;
  preferred_backend: RuntimeBackend | null;
  trust_grade: "A" | "B" | "C" | "unknown";
  installed_at: string;
  tone: string;
  builtin: number;
  role: string | null;
  visibility: AgentVisibility;
  entity_kind: "agent" | "team" | null;
}

function toAgent(row: AgentRow): InstalledAgent {
  let envReqs: AgentEnvRequirement[] = [];
  try {
    envReqs = JSON.parse(row.env_requirements_json) as AgentEnvRequirement[];
  } catch {
    envReqs = [];
  }
  // 로컬 임포트 라우팅이 있으면 런타임 라벨/원본 경로/종류를 병합.
  const route = getRoute(row.id);
  // single/team 종류는 로컬 route가 1차, 없으면 DB에 저장된 entity_kind가 권위 신호다.
  // (Hub/클라우드 설치 팀은 route가 없어 이 컬럼이 유일한 신호 — 없으면 single 오분류됨.)
  const persistedKind =
    row.entity_kind === "team" ? "team" : row.entity_kind === "agent" ? "agent" : undefined;
  const kind = route?.kind ?? persistedKind;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || row.name,
    tagline: row.tagline,
    taglineEn: row.tagline_en || row.tagline,
    systemPrompt: row.system_prompt,
    mcpServers: JSON.parse(row.mcp_servers_json) as string[],
    envRequirements: envReqs,
    preferredBackend: row.preferred_backend,
    trustGrade: row.trust_grade,
    installedAt: row.installed_at,
    tone: row.tone as InstalledAgent["tone"],
    visibility: publicAgentVisibility(row),
    ...(route ? { runtimeLabel: route.runtime, localPath: route.path } : {}),
    ...(kind ? { kind } : {}),
  };
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
  const rows = getDb()
    .prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC")
    .all() as AgentRow[];
  return rows.filter((row) => !isPrivateWebOnlyAgent(row)).map(toAgent);
}

export function getAgentById(id: string): InstalledAgent | null {
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(id) as AgentRow | undefined;
  if (!row || isPrivateWebOnlyAgent(row)) return null;
  return toAgent(row);
}

export async function installAgent(slug: string): Promise<InstalledAgent> {
  if (isPrivateWebOnlyAgent({ slug })) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }
  const listing = await getMarketSource().getListingBySlug(slug);
  if (!listing) throw new Error(`Unknown marketplace slug: ${slug}`);
  if (isPrivateWebOnlyAgent(listing)) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }

  if (listing.trustGrade !== "A" && listing.trustGrade !== "B") {
    throw new Error(
      `Trust grade ${listing.trustGrade} blocked. Sideloading requires explicit approval (V1+).`,
    );
  }

  return persistListing(slug, listing);
}

/**
 * 내 에이전트(cargo) 설치 — 로그인 사용자가 agentlas.cloud에서 만든 draft.
 * 본인 소유라 trust 게이트는 건너뛴다(서버가 세션으로 소유권 확인).
 */
export async function installMyAgent(id: string): Promise<InstalledAgent> {
  const source = getCargoSource();
  if (!source) throw new Error("Agentlas marketplace is not connected (memory mode).");
  const listing = await source.getMyAgentManifest(id);
  if (!listing) throw new Error(`Your agent was not found: ${id}`);
  if (isPrivateWebOnlyAgent(listing)) {
    throw new Error("This web-only agent is not available in Agentlas Desktop.");
  }
  return persistListing(listing.slug, listing);
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

function persistListing(slug: string, listing: FullListing): InstalledAgent {
  const envReqsJson = JSON.stringify(listing.envRequirements ?? []);
  const visibility = publicAgentVisibility(listing);
  const listingEntityKind = deriveListingEntityKind(listing);

  // 이 에이전트가 호출하는 외부 MCP/API를 external tools에 자동 등록.
  autoRegisterAgentTools(listing);

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM installed_agents WHERE slug = ?")
    .get(slug) as AgentRow | undefined;
  if (existing) {
    const entityKind = entityKindAfterRefresh(existing.entity_kind, listing);
    db.prepare(
      `UPDATE installed_agents
       SET system_prompt = ?, name = ?, name_en = ?, tagline = ?, tagline_en = ?,
           env_requirements_json = ?, visibility = ?, entity_kind = ?
       WHERE slug = ?`,
    ).run(
      listing.systemPrompt,
      listing.name,
      listing.nameEn,
      listing.tagline,
      listing.taglineEn,
      envReqsJson,
      visibility,
      entityKind,
      slug,
    );
    if (!materializeCloudPackageFiles(existing.id, slug, listing)) {
      materializeAgentFiles(existing.id);
    }
    return toAgent({
      ...existing,
      system_prompt: listing.systemPrompt,
      name: listing.name,
      name_en: listing.nameEn,
      tagline: listing.tagline,
      tagline_en: listing.taglineEn,
      env_requirements_json: envReqsJson,
      builtin: existing.builtin ?? 0,
      role: existing.role ?? null,
      visibility,
      entity_kind: entityKind,
    });
  }

  const id = randomUUID();
  const entityKind = listingEntityKind;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility, entity_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    listing.name,
    listing.nameEn,
    listing.tagline,
    listing.taglineEn,
    listing.systemPrompt,
    JSON.stringify(listing.mcpServers),
    envReqsJson,
    null,
    listing.trustGrade,
    now,
    listing.tone,
    visibility,
    entityKind,
  );

  const cloudRoute = materializeCloudPackageFiles(id, slug, listing);
  if (!cloudRoute) materializeAgentFiles(id);

  return {
    id,
    slug,
    name: listing.name,
    nameEn: listing.nameEn,
    tagline: listing.tagline,
    taglineEn: listing.taglineEn,
    systemPrompt: listing.systemPrompt,
    mcpServers: listing.mcpServers,
    envRequirements: listing.envRequirements ?? [],
    preferredBackend: null,
    trustGrade: listing.trustGrade,
    installedAt: now,
    tone: listing.tone,
    visibility,
    kind: cloudRoute?.kind ?? entityKind,
    ...(cloudRoute
      ? {
          runtimeLabel: cloudRoute.labels[0],
          localPath: cloudRoute.path,
        }
      : {}),
  };
}

function materializeCloudPackageFiles(
  agentId: string,
  slug: string,
  listing: FullListing,
): { path: string; labels: RuntimeLabel[]; kind: "agent" | "team" } | null {
  const pkg = listing.cloudPackage;
  if (!pkg?.files?.length) return null;
  const dir = agentFolderPath(slug);
  fs.mkdirSync(dir, { recursive: true });

  const markerPath = path.join(dir, ".agentlas-cloud-package.json");
  const currentHash = readPackageMarkerHash(markerPath);
  const overwrite = currentHash !== pkg.packageHash;
  for (const file of pkg.files) {
    const target = resolvePackageFile(dir, file.path);
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256.toLowerCase()) {
      throw new Error(`Cloud package file failed integrity check: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (overwrite || !fs.existsSync(target)) {
      fs.writeFileSync(target, bytes);
    }
  }
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        packageHash: pkg.packageHash,
        installedAt: new Date().toISOString(),
        source: "agentlas-cloud",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const labels = detectCloudRuntimeLabels(pkg.files.map((file) => file.path));
  const kind = pkg.agentKind === "team" ? "team" : "agent";
  setRoute({
    agentId,
    path: dir,
    runtime: labels[0],
    labels,
    kind,
    importedAt: new Date().toISOString(),
  });
  return { path: dir, labels, kind };
}

function readPackageMarkerHash(markerPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { packageHash?: string };
    return typeof parsed.packageHash === "string" ? parsed.packageHash : null;
  } catch {
    return null;
  }
}

function resolvePackageFile(root: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe cloud package path: ${relPath}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error(`Unsafe cloud package path: ${relPath}`);
  }
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Cloud package path escapes agent folder: ${relPath}`);
  }
  return target;
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

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
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

  const deleted = db.prepare("DELETE FROM installed_agents WHERE id = ?").run(id).changes > 0;
  // 로컬 임포트 라우팅도 정리 (원본 폴더는 건드리지 않음).
  if (deleted) removeRoute(id);
}

/** 팀/싱글 종류 자가교정 — 리졸버(LLM)가 재판정한 kind를 영속화. */
export function setAgentEntityKind(id: string, kind: "agent" | "team"): void {
  getDb().prepare("UPDATE installed_agents SET entity_kind = ? WHERE id = ?").run(kind, id);
}

// chat history는 electron/store/chats.ts로 이동했음 (chat_id FK 기반)
// 기존 import 경로 보호를 위해 deprecated re-export 남김 — V1에서 제거
export {
  appendChatMessage,
  listChatMessages as listChatHistory,
  clearChatMessages as clearChatHistory,
} from "../store/chats";
