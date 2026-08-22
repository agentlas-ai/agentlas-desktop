import fs from "node:fs";
import path from "node:path";
import { getDb } from "../store/db";
import { agentFolderPath } from "../agents/files";

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
