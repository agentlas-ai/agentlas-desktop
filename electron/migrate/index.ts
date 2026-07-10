// 마이그레이션 오케스트레이션 — scan(preview) / import(apply).
// OpenClaw·Hermes에서 페르소나→installed_agents, .env→keychain/env vault,
// cron→automations, memory/workspace→project context로 옮긴다.
//
// 보안: 시크릿 값은 main에서만 다룬다. scan이 renderer로 주는 preview에는
// 키 "이름"만 담긴다. import도 결과로 값은 절대 반환하지 않는다.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { saveApiKey, setEnvVar } from "../secrets/vault";
import { createProject } from "../store/projects";
import { createAutomation } from "../store/automations";
import { currentUiLocale } from "../ui-locale";
import {
  backendForEnvKey,
  looksLikeSecretKey,
  parseAllSources,
  parseSource,
  type ParsedSource,
} from "./sources";
import type {
  AgentEnvRequirement,
  MigrationApiKeyPreview,
  MigrationOptions,
  MigrationResult,
  MigrationSourceKind,
  MigrationSourcePreview,
  RuntimeBackend,
} from "../../shared/types";

const TONE_BY_SOURCE: Record<MigrationSourceKind, "blue" | "purple"> = {
  openclaw: "purple",
  hermes: "blue",
};

function slugFor(kind: MigrationSourceKind): string {
  return `imported-${kind}`;
}

function apiKeyPreviews(src: ParsedSource): MigrationApiKeyPreview[] {
  return Object.keys(src.envVars)
    .filter(looksLikeSecretKey)
    .map((envKey) => ({ envKey, backend: backendForEnvKey(envKey) }));
}

function toPreview(src: ParsedSource): MigrationSourcePreview {
  return {
    kind: src.kind,
    label: src.label,
    available: src.available,
    rootPath: src.rootPath,
    agent: src.available
      ? { name: src.personaName, personaBytes: Buffer.byteLength(src.persona, "utf8") }
      : null,
    apiKeys: src.available ? apiKeyPreviews(src) : [],
    automations: src.cronJobs.length,
    memories: src.memoryFiles.length,
  };
}

/** 디스크를 읽어 가져올 수 있는 소스들의 preview를 반환 (값 없음). */
export function scanMigrationSources(): MigrationSourcePreview[] {
  return parseAllSources().map(toPreview);
}

/** 비-백엔드 시크릿 키들을 에이전트 envRequirements 메타로 (값은 따로 vault에). */
function envRequirementsFrom(src: ParsedSource): AgentEnvRequirement[] {
  return Object.keys(src.envVars)
    .filter((k) => looksLikeSecretKey(k) && backendForEnvKey(k) === null)
    .map((key) => ({
      key,
      label: key,
      labelEn: key,
      required: false,
      hint: `${src.label}에서 가져온 키`,
      hintEn: `Imported from ${src.label}`,
    }));
}

interface AgentRowLite {
  id: string;
  slug: string;
}

/** installed_agents에 직접 insert/update. 마켓 경유가 아니므로 trust_grade=B. */
function upsertAgent(
  src: ParsedSource,
  overwrite: boolean,
): { id: string; slug: string; created: boolean; skipped: boolean } {
  const db = getDb();
  const slug = slugFor(src.kind);
  const existing = db
    .prepare("SELECT id, slug FROM installed_agents WHERE slug = ?")
    .get(slug) as AgentRowLite | undefined;

  const envReqsJson = JSON.stringify(envRequirementsFrom(src));
  const preferredBackend = pickPreferredBackend(src);

  if (existing) {
    if (!overwrite) {
      return { id: existing.id, slug, created: false, skipped: true };
    }
    db.prepare(
      `UPDATE installed_agents
         SET name = ?, name_en = ?, tagline = ?, tagline_en = ?,
             system_prompt = ?, env_requirements_json = ?, preferred_backend = ?
       WHERE slug = ?`,
    ).run(
      src.personaName,
      src.personaName,
      src.tagline,
      src.tagline,
      src.persona,
      envReqsJson,
      preferredBackend,
      slug,
    );
    return { id: existing.id, slug, created: false, skipped: false };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    src.personaName,
    src.personaName,
    src.tagline,
    src.tagline,
    src.persona,
    "[]",
    envReqsJson,
    preferredBackend,
    "B",
    now,
    TONE_BY_SOURCE[src.kind],
  );
  return { id, slug, created: true, skipped: false };
}

function pickPreferredBackend(src: ParsedSource): RuntimeBackend | null {
  for (const key of Object.keys(src.envVars)) {
    const b = backendForEnvKey(key);
    if (b) return b;
  }
  return null;
}

async function importKeysFrom(src: ParsedSource): Promise<string[]> {
  const written: string[] = [];
  for (const [key, value] of Object.entries(src.envVars)) {
    if (!value || !looksLikeSecretKey(key)) continue;
    const backend = backendForEnvKey(key);
    try {
      if (backend) {
        await saveApiKey(backend, value);
      } else {
        await setEnvVar(key, value);
      }
      written.push(key);
    } catch {
      // 키체인 쓰기 실패는 비치명적 — 경고로 처리
    }
  }
  return written;
}

/** preview를 실제 적용. dryRun이면 무엇이 적용될지 형태만 계산. */
export async function runMigration(opts: MigrationOptions): Promise<MigrationResult> {
  const ko = (opts.locale ?? currentUiLocale()) === "ko";
  const src = parseSource(opts.source);
  const dryRun = opts.dryRun ?? false;
  const overwrite = opts.overwrite ?? false;
  const importKeys = opts.importKeys ?? true;
  const warnings: string[] = [];

  const base: MigrationResult = {
    source: opts.source,
    dryRun,
    agentImported: false,
    agentId: null,
    agentSlug: null,
    keysImported: [],
    automationsImported: 0,
    projectId: null,
    warnings,
  };

  if (!src.available) {
    warnings.push(
      ko
        ? `${src.label} 설정을 ${src.rootPath} 에서 찾지 못했습니다.`
        : `Could not find ${src.label} settings at ${src.rootPath}.`,
    );
    return base;
  }

  if (!src.persona) {
    warnings.push(
      ko
        ? "SOUL/페르소나 파일을 찾지 못해 빈 에이전트로 가져옵니다."
        : "Couldn't find a SOUL/persona file — importing as a blank agent.",
    );
  }

  // ── dry-run: 아무것도 쓰지 않고 예상 결과만 ──────────────
  if (dryRun) {
    const keyNames = importKeys
      ? Object.keys(src.envVars).filter(
          (k) => looksLikeSecretKey(k) && src.envVars[k],
        )
      : [];
    return {
      ...base,
      agentImported: true,
      agentId: null,
      agentSlug: slugFor(src.kind),
      keysImported: keyNames,
      automationsImported: src.cronJobs.length,
      projectId: null,
    };
  }

  // ── 1) 에이전트(페르소나) ────────────────────────────────
  const agent = upsertAgent(src, overwrite);
  if (agent.skipped) {
    warnings.push(
      ko
        ? `이미 ${src.label}에서 가져온 에이전트가 있습니다. 다시 가져오려면 덮어쓰기를 켜세요.`
        : `An agent imported from ${src.label} already exists. Turn on overwrite to import again.`,
    );
  }

  // ── 2) API 키 → 키체인/env vault ─────────────────────────
  const keysImported = importKeys ? await importKeysFrom(src) : [];

  // ── 3) cron → automations (영구 SQLite + 백그라운드 스케줄러로 실행) ─
  let automationsImported = 0;
  for (const job of src.cronJobs) {
    if (!job.promptTemplate) continue;
    createAutomation({
      name: job.name,
      scheduleHuman: job.scheduleHuman || "가져온 예약",
      targetType: "agent",
      targetId: agent.id,
      promptTemplate: job.promptTemplate,
    });
    automationsImported += 1;
  }

  // ── 4) 메모리/워크스페이스 → 프로젝트 컨텍스트 ───────────
  let projectId: string | null = null;
  if (!agent.skipped) {
    const memoryNote =
      src.memoryFiles.length > 0
        ? `\n\n${src.label} 메모리 ${src.memoryFiles.length}개를 ${src.rootPath} 에서 발견. ` +
          `워킹 폴더로 연결하면 에이전트가 참조할 수 있습니다.`
        : "";
    const project = createProject({
      name: `${src.label} 마이그레이션`,
      defaultAgentId: agent.id,
      contextNote:
        `${src.label}에서 가져온 어시스턴트입니다. 원본 설정: ${src.rootPath}` + memoryNote,
    });
    projectId = project.id;
  }

  return {
    source: opts.source,
    dryRun,
    agentImported: !agent.skipped,
    agentId: agent.id,
    agentSlug: agent.slug,
    keysImported,
    automationsImported,
    projectId,
    warnings,
  };
}
