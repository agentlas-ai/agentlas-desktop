// 에이전트 파일 — 설치된 각 에이전트의 폴더(userData/agents/<slug>/)에 사람이 읽고
// 편집할 수 있는 파일을 materialize 하고, 그 폴더 안에서만 안전하게 read/write 한다.
//
// 설계:
//   - 라이브러리 > 에이전트에서 에이전트를 누르면 우측 패널이 이 폴더를 보여준다.
//   - `system-prompt.md`는 그 에이전트의 동작 프롬프트 원문 — 편집하면 DB에도 반영돼 즉시 적용.
//   - `AGENT.md` / `manifest.md`는 개요·메타데이터 (읽기용, 편집해도 무방).
//   - 시크릿 값은 절대 쓰지 않는다. env는 키 이름만 나열.
//   - 경로는 항상 에이전트 폴더 내부로 제한 (escape 방지).
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { skillIsLeftOut, skillsLeftOut } from "./skill-candidates";
import path from "node:path";
import { app } from "electron";
import { getDb } from "../store/db";
import { getRoute } from "./routes";
import { MAX_PORTABLE_AGENT_ASSET_BYTES, readCanonicalPromptFromDirectory } from "./prompt-authority";
import {
  listDirectoryFromMainRoot,
  readTextFilePreviewFromMainRoot,
  type DirListing,
  type TextFilePreview,
} from "../fs/workspace";
import { FsAccessDeniedError } from "../fs/access";
import { agentHomeRootStatus, ensureAgentOwnerMarker, legacyAgentsRoot, resolveAgentHome } from "./home";
import { isAgentLocalStatePath } from "../../shared/agent-local-state";
import { SCIENCE_RESEARCH_DIRECTOR_SLUG } from "../architecture/manifest";
import { specialFolderAgentForSlug } from "../../shared/special-folder-agents";
import { assertAgentWorkspaceActivationReady } from "./workspace-guard";
import { isWorkspaceAsset } from "./workspace-snapshot";
import { capturePackageSourceOwner, assertOriginalPackageDeclaration, observeAdmittedPackageSources,
  isGeneratedMemoryDeclaration, type AdmittedPackageAsset } from "../memory/package-sources";
import type { MemorySourceRef } from "../memory/source-catalogue";
import { sameFileIdentity } from "../../shared/file-identity";

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
  trust_grade: string;
  tone: string;
  builtin?: number;
}

/** 이 에이전트의 파일이 실제로 사는 폴더. 로컬 임포트면 원본 폴더, 아니면 userData/agents/<slug>. */
export function resolveAgentPackageDir(agentId: string, slug: string): { dir: string; isLocal: boolean } {
  return resolveDir(agentId, slug);
}

function resolveDir(agentId: string, slug: string): { dir: string; isLocal: boolean } {
  // 위치를 푸는 곳은 agents/home.ts 한 곳이다. 라우트는 정의 위치의 정본이라 여기서 읽어 넘긴다(home.ts 는 Electron 을 가져오지 않는다).
  const { dir, isLocal } = resolveAgentHome({ id: agentId, slug }, getRoute(agentId));
  return { dir, isLocal };
}

/**
 * slug 만 아는 호출처용: 예전 설치 위치 `userData/agents/<slug>`(1.x 가 쓰던 자리 — 새 폴더는 `agentHomeRoot()` 에 태어난다). 행을 아는 곳은 resolveAgentPackageDir /
 * agentHomeDir 를, 지금 폴더가 어디에 있는지 *읽는* 곳은 `currentAgentFolderPath` 를 쓴다. 클라우드 설치 트랜잭션의 관리 경로는 `cloudManagedFolder` 가 정한다.
 */
export function agentFolderPath(slug: string): string {
  return path.join(legacyAgentsRoot(), slug);
}

/**
 * slug 만 아는 *읽는* 호출처용: 이 slug 의 폴더가 지금 있는 곳. 폴더 이동이 `userData/agents/<slug>` 를 에이전트 루트로 옮겼다면 그곳이다.
 * 행이 없거나 위치를 못 풀면 예전 위치. 던지지 않는다.
 */
export function currentAgentFolderPath(slug: string): string {
  const legacy = agentFolderPath(slug);
  try {
    const row = getDb().prepare("SELECT id FROM installed_agents WHERE slug = ? ORDER BY installed_at LIMIT 1").get(slug) as { id?: string } | undefined;
    if (!row?.id) return legacy;
    return resolveAgentHome({ id: row.id, slug }, getRoute(row.id)).dir;
  } catch {
    return legacy;
  }
}

function getRow(agentId: string): AgentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
  if (row && (row as unknown as {entity_kind?:string}).entity_kind === "company-reference") throw Error("company_work_original_owner_required");
  return row ?? null;
}

function parseArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function parseEnv(json: string): Array<{ key: string; label?: string; required?: boolean; hint?: string }> {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 누락된 파일만 생성 — 사용자 편집을 덮어쓰지 않는다. */
export function materializeAgentFiles(agentId: string): string | null {
  const row = getRow(agentId);
  if (!row) return null;
  // 로컬 임포트 에이전트는 원본 폴더를 그대로 쓰므로 별도 파일을 만들지 않는다.
  const route = getRoute(agentId);
  if (route) return route.path;
  return writeStubFiles(row);
}

/**
 * 3파일 스텁의 폴더를 (없으면) 만들고 *실제로 만든 곳*을 돌려준다 — 스텁을 가리키는 라우트를 적는 쪽은 이 반환값을 쓴다.
 * "폴더를 만드는 곳"과 "라우트에 적는 경로"가 따로 계산되면 라우트가 없는 폴더를 가리킨다(감사 29-1: 호출 전용 Hub 좌석이 "소스 없음"으로 태어났다).
 * 라우트가 이미 있고 그 폴더가 실제로 있으면 그곳이다. 라우트가 없는 폴더를 가리키면 그 경로를 믿지 않고 행에서 푼 자리에 만든다.
 */
export function ensureAgentStubFolder(agentId: string): string | null {
  const row = getRow(agentId);
  if (!row) return null;
  const route = getRoute(agentId);
  if (route) {
    try { if (fs.statSync(route.path).isDirectory()) return route.path; } catch { /* the route names a folder that is not there */ }
  }
  return writeStubFiles(row);
}

function writeStubFiles(row: AgentRow): string {
  const resolved = resolveAgentHome({ id: row.id, slug: row.slug }, null);
  const dir = resolved.dir;
  // 설정된 에이전트 루트가 지금 없다(드라이브 분리·이름 변경): 읽는 쪽이 내려앉은 기본 루트에 스텁을 만들지 않는다 — 돌아오면 에이전트 폴더가 두 곳으로 갈린다.
  // 턴은 DB 에 둔 정본 프롬프트로 그대로 돈다(`readAgentPromptSource` 가 폴더 없음을 `null` 로 본다).
  if (resolved.source === "home" && !agentHomeRootStatus().available) return dir;
  fs.mkdirSync(dir, { recursive: true });
  // 새 폴더를 에이전트 루트 안에 만들었으면 소유 표식을 함께 쓴다 — 표식이 없으면 다음 계산이 이 폴더를 "남의 것"으로 보고 `-id6` 이름으로 갈라진다.
  if (resolved.source === "home") ensureAgentOwnerMarker(dir, row.id);

  // A built-in's prompt is owned by the manifest (installed_agents.system_prompt is re-synced on every architecture bump), so its
  // folder copy follows the row. writeIfMissing kept a July copy of the Orchestrator ("Announce the route before doing the work:
  // 사용 에이전트: …") alive after the manifest dropped that line, and the run read the file before the row: every Finance answer
  // opened with "Using agent: Agentlas Orchestrator." Installed packages keep the owner's edits (writeIfMissing).
  // A built-in whose own package writes its prompt file byte-exact keeps that file: the Science package writes the research director's
  // prompt (research-director.ts writeExactBuiltinPrompt) and then requires buildEffectiveAgentSystemPrompt to return exactly those bytes,
  // before and after it updates the row. Following the row restored the September copy and added a "\n", and every Science research
  // turn failed with science-research-director-effective-prompt-mismatch (11-05, since 844f26ef3 in 1.3.125).
  if (row.builtin && !PACKAGE_WRITTEN_BUILTIN_PROMPTS.has(row.slug)) writeBuiltinPromptFile(path.join(dir, "system-prompt.md"), row.system_prompt || "");
  else writeIfMissing(path.join(dir, "system-prompt.md"), row.system_prompt || "");

  // A special agent (a built-in whose tools, skills and data stay with its plugin, shared/special-folder-agents.ts): a cover document that says so, and the
  // folder manifest. Nothing of the plugin is copied here, and `skills/` is not created: it holds only what the owner makes or promotes.
  const special = row.builtin ? specialFolderAgentForSlug(row.slug) : null;
  if (special) writeIfMissing(path.join(dir, "agentlas.json"), JSON.stringify(special.folderManifest, null, 2));
  writeIfMissing(
    path.join(dir, "AGENT.md"),
    special ? [
      `# ${row.name}`,
      "",
      row.tagline || "",
      "",
      `**Slug**: ${row.slug}`,
      `**Kind**: special (plugin \`${special.folderManifest.plugin}\`)`,
      "",
      "## How it works",
      "",
      `This agent has a folder and its own memory like any agent. Its tools, skills and data stay with the \`${special.folderManifest.plugin}\` plugin and are not copied here;`,
      "`skills/` holds only skills you create or promote. Turns run through the plugin, not from `system-prompt.md`.",
      "",
    ].join("\n") : [
      `# ${row.name}${row.name_en && row.name_en !== row.name ? ` (${row.name_en})` : ""}`,
      "",
      row.tagline || "",
      "",
      `**Trust grade**: ${row.trust_grade}`,
      `**Slug**: ${row.slug}`,
      "",
      "## How it works",
      "",
      "This agent runs on your own LLM (CLI subscription, BYOK key, or local Ollama).",
      "Its behavior is defined by `system-prompt.md` in this folder — edit that file to",
      "change how the agent responds. Edits apply immediately to new messages.",
      "",
      "## System prompt",
      "",
      "See `system-prompt.md`.",
      "",
    ].join("\n"),
  );

  const envReqs = parseEnv(row.env_requirements_json);
  writeIfMissing(
    path.join(dir, "manifest.md"),
    [
      `# Manifest — ${row.name}`,
      "",
      `**id**: ${row.id}`,
      `**slug**: ${row.slug}`,
      `**trust**: ${row.trust_grade}`,
      `**tone**: ${row.tone}`,
      "",
      "## MCP servers",
      "",
      ...(parseArr(row.mcp_servers_json).length
        ? parseArr(row.mcp_servers_json).map((s) => `- ${s}`)
        : ["(none)"]),
      "",
      "## Environment variables",
      "",
      ...(envReqs.length
        ? envReqs.map(
            (e) => `- \`${e.key}\`${e.required ? " (required)" : " (optional)"}${e.label ? ` — ${e.label}` : ""}`,
          )
        : ["(none)"]),
      "",
    ].join("\n"),
  );

  return dir;
}

/** Built-ins whose prompt file is written by their own package, not synced from the row (see materializeAgentFiles). */
const PACKAGE_WRITTEN_BUILTIN_PROMPTS: ReadonlySet<string> = new Set([SCIENCE_RESEARCH_DIRECTOR_SLUG]);

function writeBuiltinPromptFile(file: string, content: string): void {
  const next = content.endsWith("\n") ? content : content + "\n";
  try {
    if (fs.readFileSync(file, "utf8") === next) return;
  } catch { /* missing: written below */ }
  fs.writeFileSync(file, next, "utf8");
}

function writeIfMissing(file: string, content: string): void {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
}

/** 실재하는 가장 깊은 조상 경로의 realpath 를 반환(심볼릭 링크 해소). 없으면 base 까지 거슬러 올라간다. */
function realpathOfExistingPrefix(target: string): string {
  let cur = target;
  // 루트(또는 더 이상 못 올라감)까지: 존재하는 첫 조상의 realpath 를 잡는다.
  for (;;) {
    try {
      return fs.realpathSync.native(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur; // 루트까지 도달
      cur = parent;
    }
  }
}

/** 지정한 base 폴더 내부 경로인지 확인. 아니면 throw.
 *  - 상대경로는 base 기준으로 해석(계약: 호출자가 agent-dir 상대경로를 줄 수 있다).
 *  - 어휘적 검사 후, 심볼릭 링크를 해소한 realpath 가 여전히 base 내부인지 추가 검증(샌드박스 탈출 방지). */
function ensureInside(baseDir: string, requested: string): string {
  const root = path.resolve(baseDir);
  // 상대경로면 agent 폴더 기준으로 해석(process.cwd() 기준 X).
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes the agent folder");
  }
  // 심볼릭 링크 탈출 차단: base 와 (대상이 존재하면 대상, 아니면 존재하는 상위)의 realpath 비교.
  const realRoot = realpathOfExistingPrefix(root);
  const realTarget = realpathOfExistingPrefix(resolved);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
    throw new Error("Path escapes the agent folder");
  }
  return resolved;
}

function resolveAgentFileTarget(agentId: string, requested: string): { dir: string; safe: string } {
  const row = getRow(agentId);
  if (!row) throw new Error("Agent not found");
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  return { dir, safe: ensureInside(dir, requested) };
}

function isCanonicalSystemPrompt(dir: string, safe: string): boolean {
  return path.resolve(safe) === path.resolve(dir, "system-prompt.md");
}

function assertNotSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Symbolic-link agent files cannot be modified");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * Same-directory temp + rename replacement. A reader observes either the complete
 * old file or the complete new file; a failed write never leaves a truncated asset.
 */
function atomicWriteTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNotSymlink(filePath);
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tempPath, 0o644);
    fs.renameSync(tempPath, filePath);
    try {
      const dirFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Some filesystems do not permit directory fsync. The atomic rename still holds.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The successful rename consumes the temp path; failed cleanup is best effort.
    }
  }
}

export interface AgentFileTextSnapshot {
  sourceRef?: MemorySourceRef;
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  hash: string;
}

const declarationIdentities = new WeakMap<object, { path: string; stat: fs.Stats }>();
function unchangedDeclarationFile(file: string, expected: fs.Stats): void {
  const live = fs.lstatSync(file);
  if (live.isSymbolicLink() || !live.isFile() || !sameFileIdentity(live, expected)
    || live.size !== expected.size || live.mtimeMs !== expected.mtimeMs || live.ctimeMs !== expected.ctimeMs
    || live.mode !== expected.mode || live.nlink !== expected.nlink) throw new Error("agent_package_source_changed");
}
/** Authoritative optional snapshot used by create/delete asset evolution. */
export function inspectAgentFileText(agentId: string, requested: string): AgentFileTextSnapshot {
  const { dir, safe } = resolveAgentFileTarget(agentId, requested);
  assertNotSymlink(safe);
  let fd: number;
  try {
    fd = fs.openSync(safe, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: safe,
        relativePath: path.relative(dir, safe).split(path.sep).join("/"),
        exists: false,
        content: "",
        hash: "",
      };
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Agent asset is not a regular file");
    if (before.size > MAX_PORTABLE_AGENT_ASSET_BYTES) {
      throw new Error("Agent asset exceeds the portable 512 KiB evolution limit");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.byteLength > MAX_PORTABLE_AGENT_ASSET_BYTES) {
      throw new Error("Agent asset exceeds the portable 512 KiB evolution limit");
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error("Agent asset changed while it was being read for review");
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Agent asset is not valid UTF-8");
    unchangedDeclarationFile(safe, after);
    const snapshot = {
      path: safe,
      relativePath: path.relative(dir, safe).split(path.sep).join("/"),
      exists: true,
      content,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
    declarationIdentities.set(snapshot, { path: safe, stat: after });
    return snapshot;
  } finally {
    fs.closeSync(fd);
  }
}

/** Authoritative synchronous read used when the target must already exist. */
export function readAgentFileText(agentId: string, requested: string): Omit<AgentFileTextSnapshot, "exists"> & { exists: true } {
  const snapshot = inspectAgentFileText(agentId, requested);
  if (!snapshot.exists) throw new Error("Agent asset does not exist");
  return snapshot as Omit<AgentFileTextSnapshot, "exists"> & { exists: true };
}

/** Main-owned canonical prompt source shared by import, restore, UI, and evolution. */
export function readAgentPromptSource(agentId: string): AgentFileTextSnapshot | null {
  const row = getRow(agentId);
  if (!row) return null;
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  assertAgentWorkspaceActivationReady(agentId);
  // 정의 폴더가 사라졌다(루트가 빠졌거나 라우트가 가리키는 폴더가 없다): 턴이 죽지 않는다 — 호출하는 쪽이 DB 의 정본 프롬프트(`system_prompt`)를 쓴다. 기억·대화는 그대로다.
  if (!fs.existsSync(dir)) return null;
  const observation = capturePackageSourceOwner();
  const route = JSON.stringify(getRoute(agentId) ?? null);
  const prompt = readCanonicalPromptFromDirectory(dir);
  if (!prompt) return null;
  if (!isWorkspaceAsset(prompt.relativePath)) throw new Error("private_file_not_package_declaration");
  const result = inspectAgentFileText(agentId, prompt.relativePath);
  assertOriginalPackageDeclaration(dir, result.content);
  const refs = observeAdmittedPackageSources(observation, { agentId, root: dir,
    assets: [{ path: result.relativePath, role: "instruction", digest: result.hash, byteLength: Buffer.byteLength(result.content) }],
    assertCurrent: () => {
      assertAgentWorkspaceActivationReady(agentId);
      const latest = getRow(agentId);
      if (!latest || resolveDir(agentId, latest.slug).dir !== dir || JSON.stringify(getRoute(agentId) ?? null) !== route) throw new Error("agent_package_source_changed");
      const identity = declarationIdentities.get(result);
      if (!identity) throw new Error("agent_package_source_changed");
      unchangedDeclarationFile(identity.path, identity.stat);
    } });
  return { ...result, ...(refs.get(result.relativePath) ? { sourceRef: refs.get(result.relativePath) } : {}) };
}

/** Safe removal used only by receipted rollback of an asset that was originally absent. */
export function removeAgentFile(agentId: string, requested: string): { ok: boolean; removed: boolean } {
  const { dir, safe } = resolveAgentFileTarget(agentId, requested);
  assertNotSymlink(safe);
  try {
    fs.unlinkSync(safe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, removed: false };
    throw error;
  }
  if (isCanonicalSystemPrompt(dir, safe)) {
    getDb().prepare("UPDATE installed_agents SET system_prompt = '' WHERE id = ?").run(agentId);
  }
  try {
    const dirFd = fs.openSync(path.dirname(safe), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Best-effort directory durability; unlink semantics still hold.
  }
  return { ok: true, removed: true };
}

/**
 * Atomic create-only write for a skill asset that was absent at review time.
 * The hard-link commit is an OS-level no-replace operation: if another owner
 * creates the target first, EEXIST is returned and their bytes are untouched.
 */
export function createAgentFile(agentId: string, requested: string, content: string): { ok: boolean } {
  const { dir, safe } = resolveAgentFileTarget(agentId, requested);
  fs.mkdirSync(path.dirname(safe), { recursive: true });
  assertNotSymlink(safe);
  const tempPath = path.join(path.dirname(safe), `.${path.basename(safe)}.${randomUUID()}.create`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tempPath, 0o644);
    fs.linkSync(tempPath, safe);
    try {
      const dirFd = fs.openSync(path.dirname(safe), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Best-effort directory durability; link() still provided no-replace CAS.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort after link commit or failed creation.
    }
  }
  if (isCanonicalSystemPrompt(dir, safe)) {
    getDb().prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(content, agentId);
  }
  return { ok: true };
}

const GOVERNED_ROOT_FILES = /^(?:agent|agents|team|system-prompt|memory|soul|persona|manifest|playbook|workflow|claude|gemini|readme)(?:\.[^.]+)?$/i;
const GOVERNED_DIRS = new Set(["agents", "skills", "playbooks", "workflows"]);
const HASH_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", ".next", "output", "evolution-backups", "ledgers"]);

function isGovernedAsset(relativePath: string, explicitTarget: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === explicitTarget) return true;
  const parts = normalized.split("/");
  if (parts.length === 1) return GOVERNED_ROOT_FILES.test(parts[0]);
  if (GOVERNED_DIRS.has(parts[0])) return true;
  return parts[0] === ".agentlas" && parts[1] === "skills";
}

/**
 * Deterministic fingerprint of the portable agent assets, excluding caches,
 * generated output, receipts, and backups. The explicitly evolved target is
 * always included even when it uses a custom playbook filename.
 */
export function computeAgentPackageHash(agentId: string, requestedTarget: string): string {
  const { dir, safe } = resolveAgentFileTarget(agentId, requestedTarget);
  const explicitTarget = path.relative(dir, safe).split(path.sep).join("/");
  const files: Array<{ relative: string; absolute: string }> = [];
  const byteLimit = 50 * 1024 * 1024;

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute).split(path.sep).join("/");
      // 이 컴퓨터에만 있는 상태(팀 멤버의 `.agentlas-local` 등)는 지문에 들지 않는다 — 링크든 큰 파일이든 열지도 세지도 않는다.
      if (isAgentLocalStatePath(relative)) continue;
      if (entry.isSymbolicLink()) {
        if (isGovernedAsset(relative, explicitTarget)) {
          throw new Error("Symbolic-link agent assets cannot be package fingerprinted");
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (HASH_EXCLUDED_DIRS.has(entry.name)) continue;
        const rootSegment = relative.split("/")[0];
        const containsExplicitTarget = explicitTarget.startsWith(`${relative}/`);
        const containsGovernedAssets =
          GOVERNED_DIRS.has(rootSegment) ||
          relative === ".agentlas" ||
          relative.startsWith(".agentlas/skills");
        if (!containsExplicitTarget && !containsGovernedAssets) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isGovernedAsset(relative, explicitTarget)) continue;
      if (files.length >= 2_000) {
        throw new Error("Governed agent assets exceed the package fingerprint limit");
      }
      files.push({ relative, absolute });
    }
  };
  walk(dir);
  files.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    let fd: number;
    try {
      fd = fs.openSync(file.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new Error("Symbolic-link agent assets cannot be package fingerprinted");
      throw error;
    }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("Only regular agent asset files can be package fingerprinted");
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        fileBytes += bytesRead;
        totalBytes += bytesRead;
        if (totalBytes > byteLimit) {
          throw new Error("Governed agent assets exceed the package fingerprint limit");
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = fs.fstatSync(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        fileBytes !== after.size
      ) {
        throw new Error("Agent asset changed while its package fingerprint was being computed");
      }
      hash.update(`${Buffer.byteLength(file.relative, "utf8")}:`, "utf8");
      hash.update(file.relative, "utf8");
      hash.update(`${fileBytes}:`, "utf8");
      for (const chunk of chunks) hash.update(chunk);
    } finally {
      fs.closeSync(fd);
    }
  }
  return hash.digest("hex");
}

/**
 * Exact package-root skills appended by the main process to the next invocation.
 * The renderer never supplies these bytes. Only regular `<root>/<slug>/SKILL.md`
 * files owned by the selected agent package are loaded, with a bounded aggregate
 * size and no symbolic-link traversal.
 *
 * A skill's name IS its folder name. This read only `skills/<slug>/SKILL.md`,
 * which is the layout the desktop's own builder writes — but a package built by
 * Agentlas-OS or shipped from the Hub puts the same files under the host roots
 * (`.claude/skills/…`, `.codex/skills/…`, …) and has no top-level `skills/` at
 * all. Measured 2026-08-26: such a package returned "" here, so a borrowed
 * agent ran with none of its skills in the prompt. Scan every root the engine's
 * `discover_skill_manifests()` scans, first root wins for a duplicate slug
 * (the build mirrors the same bytes into all of them).
 */
export const AGENT_SKILL_ROOTS = ["skills", ".claude/skills", ".codex/skills", ".gemini/skills", ".agents/skills"];

/**
 * The package's skills, one entry per skill name, first root wins.
 * Exported so a gate can exercise the root set without a database row.
 */
export function listAgentSkillEntries(dir: string): Array<{ root: string; name: string }> {
  const entries: Array<{ root: string; name: string }> = [];
  const seen = new Set<string>();
  // Unreviewed legacy candidates in the native root are left out of the list, not a reason to refuse the run (skill-candidates.ts).
  const leftOut = skillsLeftOut(dir);
  for (const root of AGENT_SKILL_ROOTS) {
    // An optional root we cannot safely read is simply not a source of skills.
    // Skipping it beats throwing: a package that symlinks `.claude/skills` at
    // its own `skills/` would otherwise lose every skill, and the real
    // protection is per-file (ensureInside + O_NOFOLLOW + lstat) below.
    let skillsDir: string;
    try {
      skillsDir = ensureInside(dir, root);
      const rootStat = fs.lstatSync(skillsDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "en"));
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      // A left-out slug stays left out: the same name under a later root is not a way back in for the candidate the owner never reviewed
      // (regression review C10, `.codex/skills/<slug>` was listed as a reviewed skill once `.claude/skills/<slug>` was dropped).
      seen.add(key);
      if (skillIsLeftOut(leftOut, root, name)) continue;
      entries.push({ root, name });
    }
  }
  return entries;
}

export function buildAgentSkillsRuntimeContext(agentId: string): string {
  assertAgentWorkspaceActivationReady(agentId);
  const row = getRow(agentId);
  if (!row) return "";
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  const observation = capturePackageSourceOwner(), route = JSON.stringify(getRoute(agentId) ?? null);
  const assets: AdmittedPackageAsset[] = [], identities: Array<{ path: string; stat: fs.Stats }> = [];
  const skipped: SkippedSkill[] = [];
  const result = agentSkillCatalogLine(dir, assets, identities, skipped);
  rememberSkippedSkills(agentId, skipped);
  observeAdmittedPackageSources(observation, { agentId, root: dir, assets,
    assertCurrent: () => { assertAgentWorkspaceActivationReady(agentId); const latest = getRow(agentId);
      if (!latest || resolveDir(agentId, latest.slug).dir !== dir || JSON.stringify(getRoute(agentId) ?? null) !== route) throw new Error("agent_package_source_changed");
      for (const identity of identities) unchangedDeclarationFile(identity.path, identity.stat);
    } });
  return result;
}

/**
 * The `skills:` line for one agent package folder: names and where their SKILL.md lives, plus a revision digest of the
 * bodies. Owner 2026-10-13: installed skills are a list, not inlined bodies (that was up to 3 MiB per run).
 * Exported so a gate can exercise it without a database row.
 */
export function agentSkillCatalogLine(dir: string, observedAssets?: AdmittedPackageAsset[], identities?: Array<{ path: string; stat: fs.Stats }>, skipped?: SkippedSkill[]): string {
  const maxSkills = 128;
  const maxSkillBytes = 512 * 1024;
  const loaded: Array<{ root: string; slug: string }> = [];
  const revision = createHash("sha256");

  let entries = listAgentSkillEntries(dir);
  if (entries.length === 0) return "";
  // A skill that cannot be listed is left out of this agent's prompt with a machine code; the agent runs with the rest.
  // Whatever is wrong with the package folder itself (assertOriginalPackageDeclaration on the folder, below) still stops the turn: it is not one skill's fault.
  if (entries.length > maxSkills) {
    for (const entry of entries.slice(maxSkills)) skipped?.push({ path: `${entry.root}/${entry.name}`, code: "skill_count_limit" });
    entries = entries.slice(0, maxSkills);
  }

  for (const entry of entries) {
    const skillRelative = `${entry.root}/${entry.name}/SKILL.md`;
    const leaveOut = (code: string): void => { skipped?.push({ path: skillRelative, code }); };
    try {
      const skillDirectory = ensureInside(dir, path.join(entry.root, entry.name));
      const directoryStat = fs.lstatSync(skillDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) { leaveOut("skill_directory_link"); continue; }
    } catch { leaveOut("skill_directory_unreadable"); continue; }
    let skillPath: string;
    try { skillPath = ensureInside(dir, path.join(entry.root, entry.name, "SKILL.md")); } catch { leaveOut("skill_file_unreadable"); continue; }
    let fd: number;
    try {
      fd = fs.openSync(skillPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      leaveOut((error as NodeJS.ErrnoException).code === "ELOOP" ? "skill_file_link" : "skill_file_unreadable");
      continue;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { leaveOut("skill_file_not_regular"); continue; }
      if (stat.size > maxSkillBytes) { leaveOut("skill_too_large"); continue; }
      // The body is not inlined any more; its bytes still pin the listed revision (participant freeze compares prompts).
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), live = fs.lstatSync(skillPath);
      if (bytes.byteLength !== stat.size || bytes.byteLength > maxSkillBytes || live.isSymbolicLink()
        || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.mode !== after.mode || stat.nlink !== after.nlink
        || !sameFileIdentity(after, live) || after.size !== live.size || after.mtimeMs !== live.mtimeMs || after.ctimeMs !== live.ctimeMs || after.mode !== live.mode || after.nlink !== live.nlink)
        throw new Error("agent_package_source_changed");
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) { leaveOut("skill_not_utf8"); continue; }
      assertOriginalPackageDeclaration(dir, "");
      if (isGeneratedMemoryDeclaration(text)) { leaveOut("skill_generated_declaration"); continue; }
      revision.update(`${entry.root}/${entry.name}\0`).update(bytes).update("\0");
      identities?.push({ path: skillPath, stat: after });
      observedAssets?.push({ path: `${entry.root}/${entry.name}/SKILL.md`, role: "skill", digest: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, generated: isGeneratedMemoryDeclaration(text) });
      loaded.push({ root: entry.root, slug: entry.name });
    } finally {
      fs.closeSync(fd);
    }
  }
  if (loaded.length === 0) return "";
  // Owner 2026-10-13: installed skills are a list; the agent opens the SKILL.md the work needs with its own file tools.
  const rev = revision.digest("hex").slice(0, 12);
  const roots = new Set(loaded.map((skill) => skill.root));
  if (roots.size === 1) {
    const root = loaded[0].root;
    return `skills: ${loaded.map((skill) => skill.slug).join(", ")} (${path.join(dir, root)}/<name>/SKILL.md; rev ${rev})`;
  }
  return `skills: ${loaded.map((skill) => `${skill.slug}=${skill.root}/${skill.slug}/SKILL.md`).join(", ")} (in ${dir}; rev ${rev})`;
}

/** A skill left out of a prompt and the machine code why. Codes: skill_count_limit, skill_directory_link, skill_directory_unreadable, skill_file_link, skill_file_unreadable, skill_file_not_regular, skill_too_large, skill_not_utf8, skill_generated_declaration. */
export interface SkippedSkill { path: string; code: string }
/** What each agent's last prompt build left out (this process only; at most 64 agents). Read by the agent workspace snapshot for the owner's "left out" line. */
const skippedByAgent = new Map<string, SkippedSkill[]>();
export function skippedSkillsFor(agentId: string): SkippedSkill[] { return skippedByAgent.get(agentId) ?? []; }
function rememberSkippedSkills(agentId: string, skipped: SkippedSkill[]): void {
  skippedByAgent.delete(agentId);
  if (!skipped.length) return;
  skippedByAgent.set(agentId, skipped.slice(0, 32));
  if (skippedByAgent.size > 64) skippedByAgent.delete(skippedByAgent.keys().next().value as string);
  console.warn(`[agent-skills] left out ${skipped.length}: ${skipped.slice(0, 8).map(item => `${item.path}=${item.code}`).join(" ")}`);
}

export function appendAgentSkillsToSystemPrompt(agentId: string, systemPrompt: string): string {
  const skillContext = buildAgentSkillsRuntimeContext(agentId);
  return skillContext ? `${systemPrompt}\n\n${skillContext}` : systemPrompt;
}

/** Canonical package prompt plus active package skills for every owned-agent execution path. */
export function buildEffectiveAgentSystemPrompt(agentId: string, fallback: string): string {
  assertAgentWorkspaceActivationReady(agentId);
  const source = readAgentPromptSource(agentId);
  return appendAgentSkillsToSystemPrompt(agentId, source?.content ?? fallback);
}

/**
 * 이 에이전트의 정의 폴더를 지금 읽을 수 없는가: 라우트가 가리키는 폴더가 없거나(옮기거나 지웠다), 라우트가 없고 설정된 에이전트 루트가 지금 없다(드라이브 분리·이름 변경).
 * 턴이 시작할 때 이것이 참이면 파일을 고정(임대)하지 않고 DB 에 둔 정본 프롬프트(`system_prompt`)로 돈다 — 폴더가 마지막으로 저장될 때의 같은 글이다. 읽기만 한다. 던지지 않는다.
 * 라우트가 없고 루트가 읽히는데 폴더만 아직 없는 새 에이전트는 거짓이다(폴더는 처음 쓰일 때 만들어진다).
 */
export function agentFolderUnavailable(agentId: string): boolean {
  try {
    const row = getDb().prepare("SELECT id, slug FROM installed_agents WHERE id = ?").get(agentId) as { id: string; slug: string } | undefined;
    if (!row) return false;
    const route = getRoute(agentId);
    if (route?.path) return !fs.existsSync(route.path);
    const resolved = resolveAgentHome({ id: row.id, slug: row.slug }, null);
    return resolved.source === "home" && !agentHomeRootStatus().available && !fs.existsSync(resolved.dir);
  } catch {
    return false;
  }
}

/**
 * The folder an agent's live entry file (AGENTS.md) is read from, when there is one. That file points at its own docs by
 * relative path ("read docs/route-selection.md") while the run's working directory is the owner's project, so the host
 * names the folder in the turn context. Kept out of the effective prompt, whose exact bytes are pinned and hashed.
 * Measured 2026-10-13 (Yotube Motiondirector, Codex rollout 01a1318b): five "No such file" reads of its own docs.
 */
export function agentPromptFolder(agentId: string): string | null {
  const row = getRow(agentId);
  if (!row) return null;
  // System agents carry their own complete prompt; only installed packages read an entry file from a folder.
  const builtin = getDb().prepare("SELECT builtin FROM installed_agents WHERE id = ?").get(agentId) as { builtin: number } | undefined;
  if (builtin?.builtin) return null;
  try {
    return readAgentPromptSource(agentId) ? resolveDir(agentId, row.slug).dir : null;
  } catch {
    return null;
  }
}

/** Append-only, agent-owned audit ledger; caller-supplied project paths are never trusted. */
export function appendAgentEvolutionLedger(agentId: string, record: Record<string, unknown>): void {
  const row = getRow(agentId);
  if (!row) throw new Error("Agent not found");
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  const ledgerPath = ensureInside(dir, ".agentlas/ledgers/agent-evolution-proposals.jsonl");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  assertNotSymlink(ledgerPath);
  const fd = fs.openSync(
    ledgerPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function listAgentFiles(agentId: string): Promise<DirListing> {
  const row = getRow(agentId);
  if (!row) return { path: "", exists: false, entries: [] };
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (isLocal && !fs.existsSync(dir)) {
    return { path: dir, exists: false, entries: [], reason: "source-missing" };
  }
  if (!isLocal) materializeAgentFiles(agentId);
  try {
    return await listDirectoryFromMainRoot(dir, dir, false);
  } catch (error) {
    // A local import can be moved between the existence check and the guarded
    // realpath lookup. Keep that race visible as a recoverable missing source.
    if (isLocal && error instanceof FsAccessDeniedError && !fs.existsSync(dir)) {
      return { path: dir, exists: false, entries: [], reason: "source-missing" };
    }
    throw error;
  }
}

export async function readAgentFile(agentId: string, absPath: string): Promise<TextFilePreview> {
  const row = getRow(agentId);
  if (!row) return { path: absPath, content: "", truncated: false, size: 0, reason: "binary" };
  const { dir } = resolveDir(agentId, row.slug);
  // 에이전트 전환 시 이전 에이전트의 경로가 잠깐 넘어올 수 있다 — throw 대신 빈 미리보기로 안전 처리.
  let safe: string;
  try {
    safe = ensureInside(dir, absPath);
  } catch {
    return { path: absPath, content: "", truncated: false, size: 0, reason: "binary" };
  }
  return readTextFilePreviewFromMainRoot(safe, dir);
}

export function writeAgentFile(agentId: string, absPath: string, content: string): { ok: boolean } {
  const { dir, safe } = resolveAgentFileTarget(agentId, absPath);
  if (path.basename(safe).toLowerCase() !== "memory.md") throw new Error("reviewed_file_diff_required: Review the file change in Manage Agent before applying it (agentWorkspace.prepareFileChange, then agentWorkspace.getDiff and agentWorkspace.approveAndApply).");
  atomicWriteTextFile(safe, content);
  // system-prompt.md 편집은 DB에도 반영해 새 메시지에 즉시 적용.
  if (isCanonicalSystemPrompt(dir, safe)) {
    getDb().prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(content, agentId);
  }
  return { ok: true };
}

/** 설치된 모든 에이전트의 파일을 보장(앱 부팅 시). 로컬 임포트(라우팅 보유)는 건너뛴다. */
export function materializeAllAgents(): void {
  const rows = getDb().prepare("SELECT id FROM installed_agents").all() as Array<{ id: string }>;
  for (const r of rows) {
    try {
      if (getRoute(r.id)) continue;
      materializeAgentFiles(r.id);
    } catch {
      // ignore — 개별 실패는 무시
    }
  }
}
