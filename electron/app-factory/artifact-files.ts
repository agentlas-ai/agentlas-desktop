import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactFileDigest } from "../../shared/artifact-build";

const MAX_FILES = 2_000;
const MAX_BYTES = 128 * 1024 * 1024;
const OMIT_DIRECTORIES = new Set(["node_modules", ".git", "dist", "tests", "server", "api"]);
const EXTENSIONS = new Set([
  ".html", ".htm", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".css", ".json",
  ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".wasm", ".csv", ".tsv", ".txt", ".md",
]);

export function artifactBytesDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactTreeDigest(files: ArtifactFileDigest[]): string {
  return artifactBytesDigest([...files].sort((a, b) => a.path.localeCompare(b.path, "en"))
    .map((file) => `${file.path}\0${file.sha256}\0${file.byteLength}\n`).join(""));
}

export function pathInsideArtifact(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export type ArtifactSourceSnapshot = {
  root: string;
  identity: { dev: number; ino: number };
  files: Array<ArtifactFileDigest & { bytes: Buffer }>;
  digest: string;
};

/** Read bytes once from regular files. Config, secrets and executable server code are not build inputs. */
export async function snapshotArtifactSource(declaredRoot: string, signal?: AbortSignal): Promise<ArtifactSourceSnapshot> {
  const rootStat = await fs.lstat(declaredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("artifact_source_root_invalid");
  const root = await fs.realpath(declaredRoot);
  const files: ArtifactSourceSnapshot["files"] = [];
  let totalBytes = 0;
  let directories = 0;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    signal?.throwIfAborted();
    if (++directories > MAX_FILES || depth > 32) throw new Error("artifact_source_directory_limit");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.startsWith(".") || OMIT_DIRECTORIES.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("artifact_source_symlink_refused");
      if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (/^(?:package(?:-lock)?\.json|(?:vite|postcss|babel)\.config\.|tsconfig)/.test(relative)) continue;
      if (files.length >= MAX_FILES) throw new Error("artifact_source_file_limit");
      const canonical = await fs.realpath(filename);
      if (!pathInsideArtifact(root, canonical) || canonical !== filename) throw new Error("artifact_source_path_changed");
      const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_BYTES - totalBytes) throw new Error("artifact_source_byte_limit");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const current = await fs.lstat(filename);
        if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size
          || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || current.isSymbolicLink()
          || await fs.realpath(filename) !== canonical) {
          throw new Error("artifact_source_changed_during_read");
        }
        totalBytes += bytes.length;
        files.push({ path: relative, byteLength: bytes.length, sha256: artifactBytesDigest(bytes), bytes });
      } finally { await handle.close(); }
    }
  };
  await visit(root);
  const currentRoot = await fs.lstat(declaredRoot);
  if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino || currentRoot.isSymbolicLink()
    || await fs.realpath(declaredRoot) !== root) throw new Error("artifact_source_root_changed");
  if (!files.some((file) => file.path === "index.html")) throw new Error("artifact_entry_missing");
  return { root, identity: { dev: rootStat.dev, ino: rootStat.ino }, files, digest: artifactTreeDigest(files) };
}

export async function writeArtifactSourceSnapshot(snapshot: ArtifactSourceSnapshot, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of snapshot.files) {
    const filename = path.resolve(destination, file.path);
    if (!pathInsideArtifact(destination, filename)) throw new Error("artifact_snapshot_path_invalid");
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, file.bytes, { flag: "wx", mode: 0o600 });
  }
}
