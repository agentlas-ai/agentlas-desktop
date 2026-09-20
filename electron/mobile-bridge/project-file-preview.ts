import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type {
  MobileBridgeProjectFilePreviewDto,
  MobileBridgeProjectDto,
} from "../../shared/mobile-bridge";

const FILE_REF_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_FILE_REFS = 1_024;
const MAX_TEXT_PREVIEW_BYTES = 512 * 1_024;
const FILE_REF_RE = /^file_[a-f0-9]{32}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const TEXT_EXTENSIONS = new Set([
  ".bash", ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv",
  ".dart", ".dockerfile", ".env.example", ".go", ".gradle", ".h",
  ".hpp", ".htm", ".html", ".ini", ".java", ".js", ".json", ".jsx",
  ".kt", ".kts", ".less", ".log", ".md", ".mdx", ".mjs", ".mm",
  ".php", ".plist", ".properties", ".py", ".rb", ".rs", ".sass",
  ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsv", ".tsx",
  ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
]);

const TEXT_BASENAMES = new Set([
  ".editorconfig", ".eslintrc", ".gitignore", ".npmrc", ".prettierrc",
  "dockerfile", "license", "makefile", "readme",
]);

type ProjectFileDto = MobileBridgeProjectDto["files"][number];

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ProjectFilePreviewGrant {
  projectId: string;
  relativePath: string;
  rootIdentity: Pick<FileIdentity, "dev" | "ino">;
  fileIdentity: FileIdentity;
  expiresAtMs: number;
}

interface OpenProjectFile {
  handle: Awaited<ReturnType<typeof fs.open>>;
  identity: FileIdentity;
}

function identityOf(stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>): FileIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function normalizeRelativePath(value: string): string {
  if (
    !value
    || value.length > 1_024
    || CONTROL_CHARACTERS.test(value)
    || value.includes("\\")
    || path.posix.isAbsolute(value)
  ) {
    throw new Error("This project file cannot be previewed safely.");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized === ".agentlas"
    || normalized.startsWith(".agentlas/")
  ) {
    throw new Error("This project file cannot be previewed safely.");
  }
  return normalized;
}

function isTextLike(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (TEXT_BASENAMES.has(basename)) return true;
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".env.example")) return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(lower));
}

function mimeTypeFor(relativePath: string): string {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case ".csv": return "text/csv; charset=utf-8";
    case ".html":
    case ".htm": return "text/html; charset=utf-8";
    case ".js":
    case ".jsx":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".md":
    case ".mdx": return "text/markdown; charset=utf-8";
    case ".xml": return "application/xml; charset=utf-8";
    default: return "text/plain; charset=utf-8";
  }
}

function safeProjectFiles(files: readonly ProjectFileDto[]): Set<string> {
  return new Set(
    files
      .filter((file) => file.kind === "file")
      .map((file) => normalizeRelativePath(file.path)),
  );
}

/**
 * Short-lived Desktop-owned project-file capabilities.
 *
 * DESKTOP_MOBILE_BRIDGE: Mobile can return only an opaque fileRef. Desktop
 * rechecks the current project projection and every filesystem identity before
 * reading, so a phone never supplies an arbitrary local path.
 */
export class MobileProjectFilePreviewRegistry {
  private readonly grants = new Map<string, ProjectFilePreviewGrant>();

  async issue(
    projectId: string,
    folderPath: string | null | undefined,
    files: readonly ProjectFileDto[],
  ): Promise<ProjectFileDto[]> {
    this.prune();
    for (const [fileRef, grant] of this.grants) {
      if (grant.projectId === projectId) this.grants.delete(fileRef);
    }
    if (!folderPath) return files.map((file) => this.closed(file));

    let rootReal: string;
    let rootStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      rootReal = await fs.realpath(folderPath);
      rootStat = await fs.stat(rootReal);
    } catch {
      return files.map((file) => this.closed(file));
    }
    if (!rootStat.isDirectory()) return files.map((file) => this.closed(file));
    const rootIdentity = { dev: Number(rootStat.dev), ino: Number(rootStat.ino) };

    const projected: ProjectFileDto[] = [];
    for (const file of files) {
      if (file.kind !== "file" || !isTextLike(file.path)) {
        projected.push(this.closed(file));
        continue;
      }
      try {
        const opened = await this.openCandidate(rootReal, file.path);
        try {
          if (opened.identity.size > MAX_TEXT_PREVIEW_BYTES) {
            projected.push(this.closed(file, opened.identity.size));
            continue;
          }
          const fileRef = `file_${randomUUID().replaceAll("-", "")}`;
          this.grants.set(fileRef, {
            projectId,
            relativePath: normalizeRelativePath(file.path),
            rootIdentity,
            fileIdentity: opened.identity,
            expiresAtMs: Date.now() + FILE_REF_TTL_MS,
          });
          projected.push({
            ...file,
            fileRef,
            openable: true,
            previewKind: "text",
            sizeBytes: opened.identity.size,
          });
        } finally {
          await opened.handle.close();
        }
      } catch {
        projected.push(this.closed(file));
      }
    }
    this.prune();
    return projected;
  }

  async read(input: {
    projectId: string;
    folderPath: string | null | undefined;
    fileRef: string;
    currentFiles: readonly ProjectFileDto[];
  }): Promise<MobileBridgeProjectFilePreviewDto> {
    this.prune();
    if (!FILE_REF_RE.test(input.fileRef)) {
      throw new Error("The project file preview reference is invalid.");
    }
    const grant = this.grants.get(input.fileRef);
    if (!grant || grant.projectId !== input.projectId || grant.expiresAtMs <= Date.now()) {
      this.grants.delete(input.fileRef);
      throw new Error("The project file preview expired. Refresh the project and try again.");
    }
    if (!input.folderPath || !safeProjectFiles(input.currentFiles).has(grant.relativePath)) {
      this.grants.delete(input.fileRef);
      throw new Error("The selected project file is no longer available.");
    }

    let rootReal: string;
    let rootStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      rootReal = await fs.realpath(input.folderPath);
      rootStat = await fs.stat(rootReal);
    } catch {
      this.grants.delete(input.fileRef);
      throw new Error("The selected project folder is no longer available.");
    }
    if (
      !rootStat.isDirectory()
      || Number(rootStat.dev) !== grant.rootIdentity.dev
      || Number(rootStat.ino) !== grant.rootIdentity.ino
    ) {
      this.grants.delete(input.fileRef);
      throw new Error("The selected project folder changed. Refresh the project and try again.");
    }

    const opened = await this.openCandidate(rootReal, grant.relativePath);
    try {
      if (!sameIdentity(opened.identity, grant.fileIdentity)) {
        this.grants.delete(input.fileRef);
        throw new Error("The selected project file changed. Refresh the project and try again.");
      }
      const bytes = Buffer.alloc(opened.identity.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      if (offset !== bytes.length) {
        throw new Error("The selected project file changed while it was being read.");
      }
      const after = identityOf(await opened.handle.stat());
      if (!sameIdentity(opened.identity, after)) {
        this.grants.delete(input.fileRef);
        throw new Error("The selected project file changed while it was being read.");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("This project file is not valid UTF-8 text.");
      }
      if (text.includes("\u0000")) {
        throw new Error("This project file is not text.");
      }
      return {
        fileRef: input.fileRef,
        mimeType: mimeTypeFor(grant.relativePath),
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text,
        truncated: false,
      };
    } finally {
      await opened.handle.close();
    }
  }

  clear(): void {
    this.grants.clear();
  }

  private closed(file: ProjectFileDto, sizeBytes: number | null = null): ProjectFileDto {
    return {
      ...file,
      fileRef: null,
      openable: false,
      previewKind: null,
      sizeBytes,
    };
  }

  private async openCandidate(rootReal: string, value: string): Promise<OpenProjectFile> {
    const relativePath = normalizeRelativePath(value);
    const segments = relativePath.split("/");
    let parent = rootReal;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("This project file cannot be previewed safely.");
      }
    }
    const candidate = path.join(rootReal, ...segments);
    const resolved = path.resolve(candidate);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error("This project file cannot be previewed safely.");
    }
    const leaf = await fs.lstat(candidate);
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1) {
      throw new Error("This project file cannot be previewed safely.");
    }
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    const handle = await fs.open(candidate, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > MAX_TEXT_PREVIEW_BYTES) {
        throw new Error("This project file cannot be previewed safely.");
      }
      const real = await fs.realpath(candidate);
      if (real !== resolved) {
        throw new Error("This project file cannot be previewed safely.");
      }
      return { handle, identity: identityOf(stat) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [fileRef, grant] of this.grants) {
      if (grant.expiresAtMs <= now) this.grants.delete(fileRef);
    }
    while (this.grants.size > MAX_ACTIVE_FILE_REFS) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.grants.delete(oldest);
    }
  }
}
