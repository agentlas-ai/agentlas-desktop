import fs from "node:fs";
import path from "node:path";
import { getDb } from "../store/db";
import { agentFolderPath } from "../agents/files";
import { userDataPath } from "../runtime-paths";

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AGENT_ID_RE = /^[a-f0-9-]{16,80}$/i;

export function decodeOneTeamAvatarDataUrl(value: string): { bytes: Buffer; extension: "png" | "jpg" | "webp" } {
  const match = IMAGE_DATA_URL_RE.exec(value);
  if (!match) throw new Error("The character image must be a PNG, JPEG, or WebP data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || bytes.toString("base64") !== match[2]) {
    throw new Error("The character image is invalid or larger than 2 MiB.");
  }
  const extension = match[1] === "jpeg" ? "jpg" : match[1] as "png" | "webp";
  return { bytes, extension };
}

export function writeOneTeamAvatar(input: { agentId: string; slug: string; bytes: Buffer; extension: "png" | "jpg" | "webp" }): string {
  const dir = agentFolderPath(input.slug);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `one-avatar.${input.extension}`);
  const tempPath = path.join(dir, `.one-avatar.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, input.bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* successful rename consumes it */ }
  }
  return finalPath;
}

export function removeOneTeamAvatarDirectory(slug: string): void {
  const dir = agentFolderPath(slug);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* failed creation cleanup is best effort */ }
}

/*
 * One 자신의 초상.
 *
 * 팀원의 초상은 그 에이전트 폴더에 산다. One 은 설치된 에이전트가 아니라 그런 폴더가 없어서,
 * 처음에는 One 만 프리셋 캐릭터로 제한했다 — 같은 창을 쓰는데 One 에서만 두 탭이 사라지는
 * 것은 통일이 아니라 구멍이다(오너 지적 2026-08-23). 그래서 One 전용 자리를 만든다.
 *
 * 자리가 하나뿐이라 id 가 필요 없다. 아이콘 값은 `one-avatar:self` 하나로 고정한다.
 */
export const ONE_SELF_AVATAR_ICON = "one-avatar:self";

function oneSelfAvatarDir(): string {
  return userDataPath("one-profile");
}

export function writeOneSelfAvatar(input: { bytes: Buffer; extension: "png" | "jpg" | "webp" }): string {
  const dir = oneSelfAvatarDir();
  fs.mkdirSync(dir, { recursive: true });
  // 확장자가 바뀌면 옛 파일이 남아 해석 순서에 따라 옛 얼굴이 계속 나온다.
  for (const extension of ["png", "jpg", "webp"] as const) {
    if (extension === input.extension) continue;
    try { fs.unlinkSync(path.join(dir, `one-avatar.${extension}`)); } catch { /* 없으면 그만 */ }
  }
  const finalPath = path.join(dir, `one-avatar.${input.extension}`);
  const tempPath = path.join(dir, `.one-avatar.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, input.bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* successful rename consumes it */ }
  }
  return finalPath;
}

function resolveOneSelfAvatarPath(): string | null {
  const dir = oneSelfAvatarDir();
  for (const extension of ["png", "jpg", "webp"] as const) {
    const candidate = path.join(dir, `one-avatar.${extension}`);
    try {
      if (!fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) continue;
      const realDir = fs.realpathSync.native(dir);
      const realFile = fs.realpathSync.native(candidate);
      const relative = path.relative(realDir, realFile);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
    } catch {
      // Try the next supported extension.
    }
  }
  return null;
}

/** Resolve only a portrait owned by a real local One Team seat. */
export function resolveOneTeamAvatarProtocolPath(rawUrl: string): string | null {
  let agentId = "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "agentlas:" || url.hostname !== "one-avatar" || url.search || url.hash) return null;
    agentId = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  // One 자신의 초상은 좌석이 아니라 프로필에 속한다.
  if (agentId === "self") return resolveOneSelfAvatarPath();
  if (!AGENT_ID_RE.test(agentId)) return null;
  const row = getDb().prepare(`
    SELECT agent.slug, member.icon
    FROM installed_agents agent
    JOIN one_org_members member ON member.installed_agent_id = agent.id
    WHERE agent.id = ? AND member.icon = ?
    LIMIT 1
  `).get(agentId, `one-avatar:${agentId}`) as { slug?: string; icon?: string } | undefined;
  if (!row?.slug) return null;
  const dir = agentFolderPath(row.slug);
  for (const extension of ["png", "jpg", "webp"] as const) {
    const candidate = path.join(dir, `one-avatar.${extension}`);
    try {
      if (!fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) continue;
      const realDir = fs.realpathSync.native(dir);
      const realFile = fs.realpathSync.native(candidate);
      const relative = path.relative(realDir, realFile);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
    } catch {
      // Try the next supported extension.
    }
  }
  return null;
}
