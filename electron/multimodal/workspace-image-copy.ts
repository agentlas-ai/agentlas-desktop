// Every runtime-generated image lands in the run's working folder.
//
// ★Why (2026-09-23 audit): a Codex/Antigravity/host image lived only in the
// runtime's own store (~/.codex/generated_images, userData/multimodal-images,
// ~/.gemini/.../brain). The Agentlas browser can upload only from its output
// folder and the run folder, so "generate a banner and post it" failed at
// browser_file_upload with "outside allowed roots", and the host tool returned
// only base64 so the model never learned a path at all.
//
// The fix is to copy into `<cwd>/assets/`, not to widen the browser's roots:
// the run folder is already an allowed upload root and an artifact root, and a
// copy keeps the runtime's private store private. Read-only runs never write.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function imageExtension(head: Buffer): "png" | "jpg" | "webp" | "gif" | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (head.length >= 6 && head.toString("ascii", 0, 3) === "GIF") return "gif";
  return null;
}

function stamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeLabel(label: string | undefined): string {
  const clean = (label ?? "generated").toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);
  return clean || "generated";
}

/**
 * Copy one generated image (from a file or base64 bytes) into `<cwd>/assets/`.
 * Returns the new absolute path, or null when the run may not write, the
 * folder is unusable, or the bytes are not an image. Never overwrites.
 */
export function copyGeneratedImageIntoWorkspace(input: {
  cwd: string | null | undefined;
  permission?: "read" | "write" | "full" | string | null;
  sourcePath?: string | null;
  base64?: string | null;
  label?: string;
}): string | null {
  try {
    if (input.permission !== "write" && input.permission !== "full") return null;
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!cwd || !path.isAbsolute(cwd)) return null;
    const cwdStat = fs.statSync(cwd);
    if (!cwdStat.isDirectory()) return null;
    let bytes: Buffer | null = null;
    if (input.sourcePath && path.isAbsolute(input.sourcePath)) {
      const stat = fs.lstatSync(input.sourcePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
      bytes = fs.readFileSync(input.sourcePath);
    } else if (typeof input.base64 === "string" && input.base64.length > 16) {
      const raw = input.base64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, "");
      if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/=\s]+$/u.test(raw.slice(0, 4096))) return null;
      bytes = Buffer.from(raw, "base64");
    }
    if (!bytes || bytes.length === 0) return null;
    const extension = imageExtension(bytes.subarray(0, 16));
    if (!extension) return null;
    const assets = path.join(cwd, "assets");
    fs.mkdirSync(assets, { recursive: true });
    const assetsStat = fs.lstatSync(assets);
    if (assetsStat.isSymbolicLink() || !assetsStat.isDirectory()) return null;
    const target = path.join(assets, `${safeLabel(input.label)}-${stamp()}-${randomBytes(3).toString("hex")}.${extension}`);
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    return target;
  } catch {
    return null;
  }
}
