import path from "node:path";

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
const POSIX_FORBIDDEN_CHARACTERS = /[\/\u0000-\u001f\u007f]/gu;

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Make DownloadItem's suggested name safe for the target filesystem.
 * Chromium normally supplies a basename, but this boundary remains explicit
 * because the durable registry later passes the resulting path to the OS.
 */
export function normalizeBrowserDownloadFileName(
  suggestedName: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApi(platform);
  const input = String(suggestedName ?? "");
  let name = api.basename(input)
    .replace(platform === "win32" ? WINDOWS_FORBIDDEN_CHARACTERS : POSIX_FORBIDDEN_CHARACTERS, "_")
    .trim();
  if (platform === "win32") {
    name = name.replace(/[. ]+$/gu, "");
    if (WINDOWS_RESERVED_BASENAME.test(name)) name = `_${name}`;
  }
  if (!name || name === "." || name === "..") name = "download";
  // Leave room for the app-owned directory and Windows' native shell APIs.
  return name.slice(0, platform === "win32" ? 240 : 255) || "download";
}

/** Accept only files contained by this operation's app-owned directory. */
export function browserDownloadPathIsOwned(
  downloadsRoot: string,
  operationId: string,
  candidate: unknown,
  platform: NodeJS.Platform = process.platform,
): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const api = pathApi(platform);
  if (!api.isAbsolute(candidate)) return false;
  const operationRoot = api.resolve(downloadsRoot, operationId);
  const resolved = api.resolve(candidate);
  const relative = api.relative(operationRoot, resolved);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}
