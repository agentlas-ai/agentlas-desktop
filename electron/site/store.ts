// Site design studio — project/screen persistence.
//
// Layout on disk (all under userData, same convention as trex-images /
// oberon-motion):
//   <userData>/site-projects/<projectId>/project.json
//   <userData>/site-projects/<projectId>/screens/<screenId>.html
// project.json is the source of truth for screen metadata; screen HTML lives
// as plain files so users can inspect/export them directly.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SiteConversationEntry, SiteProjectMeta, SiteScreenMeta } from "../../shared/site-studio";

function projectsRoot(): string {
  return path.join(app.getPath("userData"), "site-projects");
}

function projectDir(projectId: string): string {
  return path.join(projectsRoot(), projectId);
}

function screensDir(projectId: string): string {
  return path.join(projectDir(projectId), "screens");
}

function projectMetaPath(projectId: string): string {
  return path.join(projectDir(projectId), "project.json");
}

function conversationPath(projectId: string): string {
  return path.join(projectDir(safeId(projectId)), "conversation.json");
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error(`잘못된 id: ${id}`);
  }
  return id;
}

function screenFilePath(projectId: string, screenId: string): string {
  return path.join(screensDir(safeId(projectId)), `${safeId(screenId)}.html`);
}

function readProjectMeta(projectId: string): SiteProjectMeta | null {
  try {
    const raw = fs.readFileSync(projectMetaPath(projectId), "utf8");
    const parsed = JSON.parse(raw) as SiteProjectMeta;
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.screens)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeProjectMeta(meta: SiteProjectMeta): void {
  fs.mkdirSync(projectDir(meta.id), { recursive: true });
  fs.writeFileSync(projectMetaPath(meta.id), JSON.stringify(meta, null, 2), "utf8");
}

export function listSiteProjects(): SiteProjectMeta[] {
  const root = projectsRoot();
  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const projects: SiteProjectMeta[] = [];
  for (const id of ids) {
    const meta = readProjectMeta(id);
    if (meta) projects.push(meta);
  }
  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return projects;
}

export function createSiteProject(name: string): SiteProjectMeta {
  const now = new Date().toISOString();
  const meta: SiteProjectMeta = {
    id: randomUUID(),
    name: name.trim() || "새 사이트",
    createdAt: now,
    updatedAt: now,
    screens: [],
  };
  writeProjectMeta(meta);
  return meta;
}

export function getSiteProject(projectId: string): SiteProjectMeta {
  const meta = readProjectMeta(safeId(projectId));
  if (!meta) throw new Error("프로젝트를 찾을 수 없음");
  return meta;
}

export function deleteSiteProject(projectId: string): void {
  fs.rmSync(projectDir(safeId(projectId)), { recursive: true, force: true });
}

function readSiteConversation(projectId: string): SiteConversationEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(conversationPath(projectId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("사이트 대화 기록이 손상되어 원본을 보존했습니다.", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("사이트 대화 기록 형식이 올바르지 않아 원본을 보존했습니다.");
  const valid = parsed.every(
    (entry): entry is SiteConversationEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as SiteConversationEntry).id === "string" &&
      (entry as SiteConversationEntry).projectId === projectId &&
      ((entry as SiteConversationEntry).role === "user" || (entry as SiteConversationEntry).role === "assistant") &&
      typeof (entry as SiteConversationEntry).text === "string" &&
      typeof (entry as SiteConversationEntry).createdAt === "string",
  );
  if (!valid) throw new Error("사이트 대화 기록 항목이 손상되어 원본을 보존했습니다.");
  return parsed.slice(-200);
}

function writeSiteConversation(projectId: string, entries: SiteConversationEntry[]): void {
  const directory = projectDir(safeId(projectId));
  const target = conversationPath(projectId);
  const temp = path.join(directory, `.conversation.json.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(entries.slice(-200), null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some supported filesystems reject directory fsync; same-dir rename
      // still prevents readers from observing a partially written transcript.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Successful rename consumes the temp path; failed cleanup never touches
      // the previous durable conversation.json.
    }
  }
}

export function listSiteConversation(projectId: string): SiteConversationEntry[] {
  getSiteProject(projectId); // 프로젝트 존재와 id 형식을 함께 검증.
  return readSiteConversation(projectId);
}

export function appendSiteConversation(input: {
  projectId: string;
  role: SiteConversationEntry["role"];
  text: string;
  context?: string | null;
}): SiteConversationEntry {
  getSiteProject(input.projectId);
  const entry: SiteConversationEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    role: input.role,
    text: input.text.trim().slice(0, 4_000),
    createdAt: new Date().toISOString(),
    context: input.context?.trim().slice(0, 300) || null,
  };
  const entries = readSiteConversation(input.projectId);
  entries.push(entry);
  writeSiteConversation(input.projectId, entries);
  return entry;
}

export function readSiteScreenHtml(projectId: string, screenId: string): string {
  return fs.readFileSync(screenFilePath(projectId, screenId), "utf8");
}

export type SaveScreenInput = {
  projectId: string;
  name: string;
  html: string;
  variantGroup?: string | null;
  variantLabel?: string | null;
};

export function saveSiteScreen(input: SaveScreenInput): SiteScreenMeta {
  const meta = getSiteProject(input.projectId);
  const now = new Date().toISOString();
  const screen: SiteScreenMeta = {
    id: randomUUID(),
    projectId: meta.id,
    name: input.name.trim() || `화면 ${meta.screens.length + 1}`,
    fileName: "",
    createdAt: now,
    updatedAt: now,
    variantGroup: input.variantGroup ?? null,
    variantLabel: input.variantLabel ?? null,
  };
  screen.fileName = `${screen.id}.html`;
  fs.mkdirSync(screensDir(meta.id), { recursive: true });
  fs.writeFileSync(screenFilePath(meta.id, screen.id), input.html, "utf8");
  meta.screens.push(screen);
  meta.updatedAt = now;
  writeProjectMeta(meta);
  return screen;
}

export function updateSiteScreenHtml(projectId: string, screenId: string, html: string): SiteScreenMeta {
  const meta = getSiteProject(projectId);
  const screen = meta.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error("화면을 찾을 수 없음");
  fs.writeFileSync(screenFilePath(projectId, screenId), html, "utf8");
  const now = new Date().toISOString();
  screen.updatedAt = now;
  meta.updatedAt = now;
  writeProjectMeta(meta);
  return screen;
}

export function renameSiteScreen(projectId: string, screenId: string, name: string): SiteScreenMeta {
  const meta = getSiteProject(projectId);
  const screen = meta.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error("화면을 찾을 수 없음");
  screen.name = name.trim() || screen.name;
  screen.updatedAt = new Date().toISOString();
  meta.updatedAt = screen.updatedAt;
  writeProjectMeta(meta);
  return screen;
}

export function deleteSiteScreen(projectId: string, screenId: string): void {
  const meta = getSiteProject(projectId);
  const index = meta.screens.findIndex((s) => s.id === screenId);
  if (index < 0) return;
  meta.screens.splice(index, 1);
  meta.updatedAt = new Date().toISOString();
  try {
    fs.rmSync(screenFilePath(projectId, screenId), { force: true });
  } catch {
    /* 파일이 이미 없으면 무시 */
  }
  writeProjectMeta(meta);
}

export function listSiteScreenFiles(projectId: string): { name: string; data: Buffer }[] {
  const meta = getSiteProject(projectId);
  const files: { name: string; data: Buffer }[] = [];
  for (const screen of meta.screens) {
    try {
      const data = fs.readFileSync(screenFilePath(projectId, screen.id));
      const base = screen.name.replace(/[^\w가-힣 .-]+/g, "_").trim() || screen.id;
      files.push({ name: `${base}.html`, data });
    } catch {
      /* 깨진 화면은 건너뜀 */
    }
  }
  return files;
}
