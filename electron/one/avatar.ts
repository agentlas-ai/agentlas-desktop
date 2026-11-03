import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "../store/db";
import { agentFolderPath } from "../agents/files";
import { userDataPath } from "../runtime-paths";
import { oneProfileAvatarSegment, captureOneAvatarOwner, commitOneAvatarPointer, readOneAvatarPointer } from "../store/one-profile";

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
  // 초상도 프로필처럼 계정마다다(계정 하나 = One 하나). 업데이트 전 프로필을 이어받은 One 은
  // 옛 자리를 그대로 쓰고, 다른 계정은 accounts/<불투명 키> 아래 자기 자리를 쓴다.
  const segment = oneProfileAvatarSegment();
  return segment ? userDataPath("one-profile", "accounts", segment) : userDataPath("one-profile");
}

/** Main only: write an immutable image before atomically publishing its pointer. */
export function setOneSelfAvatarImage(input: { dataUrl: string; expectedVersion: number; oneId?: string }) {
  const owner = captureOneAvatarOwner();
  if (owner.version !== input.expectedVersion || (input.oneId !== undefined && input.oneId !== owner.oneId)) throw Object.assign(new Error("One profile changed; reload and try again"), { code: "one_profile_version_conflict" });
  const decoded = decodeOneTeamAvatarDataUrl(input.dataUrl);
  const b = decoded.bytes;
  const valid = decoded.extension === "png" ? b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : decoded.extension === "jpg" ? b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
    : b.length >= 12 && b.toString("ascii",0,4) === "RIFF" && b.toString("ascii",8,12) === "WEBP";
  if (!valid) throw new Error("The character image has an invalid signature.");
  if (oneProfileAvatarSegment() !== owner.segment) throw Object.assign(new Error("One profile changed; reload and try again"), { code: "one_profile_version_conflict" });
  const dir = oneSelfAvatarDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `one-avatar-${randomUUID()}.${decoded.extension}`;
  const fd = fs.openSync(path.join(dir, filename), "wx", 0o600);
  try { fs.writeFileSync(fd, decoded.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // On POSIX make the directory entry durable before publishing its pointer.
  // Windows does not support opening directories this way; the file is still flushed.
  if (process.platform !== "win32") {
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { fs.closeSync(dirFd); }
  }
  return commitOneAvatarPointer(owner, filename);
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
  const pointer = readOneAvatarPointer();
  const candidates = pointer ? [pointer] : ["one-avatar.png", "one-avatar.jpg", "one-avatar.webp"];
  for (const name of candidates) {
    const candidate = path.join(dir, name);
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
    if (url.protocol !== "agentlas:" || url.hostname !== "one-avatar" || url.hash) return null;
    agentId = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (url.search && (agentId !== "self" || !/^\?v=[1-9][0-9]*$/.test(url.search) || !Number.isSafeInteger(Number(url.search.slice(3))))) return null;
  } catch {
    return null;
  }
  // One 자신의 초상은 좌석이 아니라 프로필에 속한다.
  if (agentId === "self") return resolveOneSelfAvatarPath();
  if (!AGENT_ID_RE.test(agentId)) return null;
  const row = getDb().prepare(`
    SELECT member.agent_slug AS slug, agent.slug AS installed_slug, member.icon
    FROM installed_agents agent
    JOIN one_org_members member ON member.installed_agent_id = agent.id
    WHERE agent.id = ? AND member.icon = ?
    ORDER BY member.archived_at IS NULL DESC, member.updated_at DESC
    LIMIT 1
  `).get(agentId, `one-avatar:${agentId}`) as { slug?: string; installed_slug?: string; icon?: string } | undefined;
  if (!row?.slug) return null;
  // Member edits write to the seat's original slug. A later package import can
  // change installed_agents.slug without moving that saved portrait.
  // The installed slug remains a fallback for portraits saved by older builds.
  for (const slug of new Set([row.slug, row.installed_slug])) {
    if (!slug || slug === "." || slug === ".." || /[\\/\u0000-\u001f\u007f]/.test(slug)) continue;
    const dir = agentFolderPath(slug);
    for (const extension of ["png", "jpg", "webp"] as const) {
      const candidate = path.join(dir, `one-avatar.${extension}`);
      try {
        if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) continue;
        const realDir = fs.realpathSync.native(dir);
        const realFile = fs.realpathSync.native(candidate);
        const relative = path.relative(realDir, realFile);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
      } catch {
        // Try the next supported extension or the legacy installed slug.
      }
    }
  }
  return null;
}
