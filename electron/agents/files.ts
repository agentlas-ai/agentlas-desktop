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
}

function agentsRoot(): string {
  return path.join(app.getPath("userData"), "agents");
}

/** 이 에이전트의 파일이 실제로 사는 폴더. 로컬 임포트면 원본 폴더, 아니면 userData/agents/<slug>. */
function resolveDir(agentId: string, slug: string): { dir: string; isLocal: boolean } {
  const route = getRoute(agentId);
  if (route) return { dir: route.path, isLocal: true };
  return { dir: agentFolderPath(slug), isLocal: false };
}

export function agentFolderPath(slug: string): string {
  return path.join(agentsRoot(), slug);
}

function getRow(agentId: string): AgentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
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
  const dir = agentFolderPath(row.slug);
  fs.mkdirSync(dir, { recursive: true });

  writeIfMissing(path.join(dir, "system-prompt.md"), row.system_prompt || "");

  writeIfMissing(
    path.join(dir, "AGENT.md"),
    [
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
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  hash: string;
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
    return {
      path: safe,
      relativePath: path.relative(dir, safe).split(path.sep).join("/"),
      exists: true,
      content,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
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
  const prompt = readCanonicalPromptFromDirectory(dir);
  return prompt ? inspectAgentFileText(agentId, prompt.relativePath) : null;
}

/** Safe removal used only by receipted rollback of an asset that was originally absent. */
export function removeAgentFile(agentId: string, requested: string): { ok: boolean; removed: boolean } {
  const { safe } = resolveAgentFileTarget(agentId, requested);
  assertNotSymlink(safe);
  try {
    fs.unlinkSync(safe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, removed: false };
    throw error;
  }
  if (path.basename(safe) === "system-prompt.md") {
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
  const { safe } = resolveAgentFileTarget(agentId, requested);
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
  if (path.basename(safe) === "system-prompt.md") {
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
 * The renderer never supplies these bytes. Only regular `skills/<slug>/SKILL.md`
 * files owned by the selected agent package are loaded, with a bounded aggregate
 * size and no symbolic-link traversal.
 */
export function buildAgentSkillsRuntimeContext(agentId: string): string {
  const row = getRow(agentId);
  if (!row) return "";
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  const skillsDir = ensureInside(dir, "skills");
  try {
    const rootStat = fs.lstatSync(skillsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return "";
  } catch {
    return "";
  }

  const maxSkills = 128;
  const maxBytes = 3 * 1024 * 1024;
  const maxSkillBytes = 512 * 1024;
  const loaded: Array<{ slug: string; content: string }> = [];
  let totalBytes = 0;
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (entries.length > maxSkills) throw new Error("Agent skill package exceeds the runtime skill-count limit");

  for (const entry of entries) {
    const skillDirectory = ensureInside(dir, path.join("skills", entry.name));
    const directoryStat = fs.lstatSync(skillDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Agent runtime skill directory must not be a symbolic link");
    }
    const skillPath = ensureInside(dir, path.join("skills", entry.name, "SKILL.md"));
    let fd: number;
    try {
      fd = fs.openSync(skillPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("Agent runtime skill must be a regular file");
      if (before.size > maxSkillBytes || before.size > maxBytes - totalBytes) {
        throw new Error("Agent skills exceed the portable runtime prompt limit");
      }
      const bytes = fs.readFileSync(fd);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) throw new Error("Agent skills exceed the runtime prompt limit");
      const after = fs.fstatSync(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes.byteLength !== after.size
      ) {
        throw new Error("Agent runtime skill changed while it was being read");
      }
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new Error("Agent runtime skill is not valid UTF-8");
      }
      loaded.push({ slug: entry.name, content });
    } finally {
      fs.closeSync(fd);
    }
  }
  if (loaded.length === 0) return "";
  return [
    "## Installed agent skills (package-owned)",
    "These exact SKILL.md instructions belong to the selected agent package and are active for this invocation.",
    ...loaded.flatMap((skill) => [
      "",
      `<agentlas-skill slug=${JSON.stringify(skill.slug)}>`,
      skill.content,
      "</agentlas-skill>",
    ]),
  ].join("\n");
}

export function appendAgentSkillsToSystemPrompt(agentId: string, systemPrompt: string): string {
  const skillContext = buildAgentSkillsRuntimeContext(agentId);
  return skillContext ? `${systemPrompt}\n\n${skillContext}` : systemPrompt;
}

/** Canonical package prompt plus active package skills for every owned-agent execution path. */
export function buildEffectiveAgentSystemPrompt(agentId: string, fallback: string): string {
  const source = readAgentPromptSource(agentId);
  return appendAgentSkillsToSystemPrompt(agentId, source?.content ?? fallback);
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
  if (!isLocal) materializeAgentFiles(agentId);
  return listDirectoryFromMainRoot(dir, dir, false);
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
  const { safe } = resolveAgentFileTarget(agentId, absPath);
  atomicWriteTextFile(safe, content);
  // system-prompt.md 편집은 DB에도 반영해 새 메시지에 즉시 적용.
  if (path.basename(safe) === "system-prompt.md") {
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
