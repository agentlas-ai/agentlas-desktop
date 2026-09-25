import fs from "node:fs";
import path from "node:path";

/**
 * The Build screen publishes through the Core uploader. Its source permission
 * must be written only to the cleaned temporary copy after author consent;
 * never to the original Build folder or an owner-private Cloud package.
 */
export function authorizeSourceSharingInCleanCopy(cleanRoot: string, originalRoot: string): void {
  const clean = fs.realpathSync.native(cleanRoot);
  const original = fs.realpathSync.native(originalRoot);
  if (clean === original || clean.startsWith(`${original}${path.sep}`)) {
    throw new Error("public_source_copy_required");
  }
  const manifestPath = path.join(clean, "agentlas.json");
  let parsed: Record<string, unknown>;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    const candidate: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("not a JSON object");
    parsed = candidate as Record<string, unknown>;
  } catch {
    throw new Error("public_source_manifest_invalid");
  }
  if (parsed.license === "source-download-allowed") return;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...parsed, license: "source-download-allowed" }, null, 2)}\n`, "utf8");
}
