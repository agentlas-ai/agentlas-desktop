import fs from "node:fs";
import path from "node:path";
import { resolveOneTeamAvatarProtocolPath } from "../one/avatar";
import { getOneProfile } from "../store/one-profile";
import { userDataPath } from "../runtime-paths";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ICON_RE = /^one-avatar:(?:self|[a-f0-9-]{16,80})$/i;

/** Only the Main-authorized One identity can select a local portrait. */
export function readMobileOneAvatar(icon: string): {
  icon: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
} | null {
  if (!ICON_RE.test(icon)) return null;
  if (icon === "one-avatar:self" && getOneProfile().avatarIcon !== icon) return null;
  const file = resolveOneTeamAvatarProtocolPath(`agentlas://one-avatar/${icon.slice("one-avatar:".length)}`);
  if (!file) return null;
  const root = fs.realpathSync.native(userDataPath());
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const extension = path.extname(file).toLowerCase();
  const mimeType = extension === ".png" ? "image/png"
    : extension === ".jpg" ? "image/jpeg"
    : extension === ".webp" ? "image/webp" : null;
  if (!mimeType) return null;
  let fd: number | null = null;
  try {
    // A swapped symlink must not turn an authorized portrait into an arbitrary read.
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_AVATAR_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return null;
    const signatureValid = mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!signatureValid) return null;
    return { icon, mimeType, dataBase64: bytes.toString("base64") };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
