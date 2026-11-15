import { createHash } from "node:crypto";

// Receipt keys carry no source text. The canonical memory database is already
// owner-scoped; include the owner and actor here too so the key cannot be reused
// under another custody or actor if a database is ever migrated.
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function importSourcePrefix(owner: string, actor: string): string {
  return `one-soul-receipt:v1:${sha([owner, actor])}:`;
}
export function importSourceKey(owner: string, actor: string, hash: string): string {
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error("memory_import_source_invalid");
  return `${importSourcePrefix(owner, actor)}${hash}`;
}
export function importSourceDigest(kind: string, content: string, native?: string): string {
  return sha([kind, content, native ?? null]);
}
export const FORGOTTEN_IMPORT_SOURCE = "forgotten:v1";
