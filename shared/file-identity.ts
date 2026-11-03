// File identity across stat kinds. On Windows (windows-2025 runner, Node 22.12, NTFS C: and D:), a PATH-based
// fs.lstatSync(p) / fs.statSync(p) reports dev = 0 while a HANDLE-based fs.fstatSync(fd) / FileHandle.stat() of the very
// same file reports the volume serial (for example 1422631540). ino is identical in both, also with { bigint: true }
// (dev 0n vs nonzero). A check that compares dev between an fd stat and a path stat therefore always fails there.
// The file index (ino) is the identity; a path-side dev of 0 is accepted on win32 only. macOS and Linux keep the
// strict dev + ino comparison. Same rule as sameOpenedFile in build-resources/python-public-trust.cjs.
export type FileIdValue = number | bigint | string;
export interface FileIdentityLike { readonly dev: FileIdValue; readonly ino: FileIdValue }

const isZero = (value: FileIdValue): boolean =>
  typeof value === "bigint" ? value === 0n : typeof value === "number" ? value === 0 : /^0+$/.test(value);

/** dev equality; on win32 a dev of 0 on either side (path stat) is "unknown" and matches. `platform` is a test seam. */
export function sameDevice(a: Pick<FileIdentityLike, "dev">, b: Pick<FileIdentityLike, "dev">, platform: string = process.platform): boolean {
  return String(a.dev) === String(b.dev) || (platform === "win32" && (isZero(a.dev) || isZero(b.dev)));
}

/** True when both stats name one file: equal ino AND (equal dev OR win32 with a zero dev on either side). */
export function sameFileIdentity(a: FileIdentityLike, b: FileIdentityLike, platform: string = process.platform): boolean {
  return String(a.ino) === String(b.ino) && sameDevice(a, b, platform);
}
