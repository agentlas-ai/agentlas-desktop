import fs from "node:fs";
import path from "node:path";

export interface ResolvedHephaestusBuildAttachment {
  path: string;
  name?: string;
}

const ATTACH_DIR = "_attachments";
const ATTACH_SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".DS_Store", ".venv"]);
const ATTACH_MAX_TOTAL = 200 * 1024 * 1024;

function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function uniqueDest(dir: string, name: string): string {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; i < 100; i += 1) {
    dest = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  return dest;
}

function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** Copy only main-resolved attachments into the approved workspace. */
export function stageAttachments(
  workspace: string,
  attachments: ResolvedHephaestusBuildAttachment[],
): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const canonicalWorkspace = fs.realpathSync.native(path.resolve(workspace));
  const destRoot = path.join(canonicalWorkspace, ATTACH_DIR);
  const resolvedDestRoot = path.resolve(destRoot);
  let copied = 0;
  for (const att of attachments) {
    try {
      const src = fs.realpathSync.native(path.resolve(att.path || ""));
      if (isInsidePath(resolvedDestRoot, src) || isInsidePath(src, resolvedDestRoot)) {
        errors.push(`${att.name || src}: attachment overlaps the output workspace`);
        continue;
      }
      const st = fs.lstatSync(src);
      if (st.isSymbolicLink()) {
        errors.push(`${att.name || src}: symbolic links are not staged`);
        continue;
      }
      fs.mkdirSync(destRoot, { recursive: true });
      const name = (att.name || path.basename(src)).replace(/[/\\]/g, "_");
      const dest = uniqueDest(destRoot, name);
      if (st.isDirectory()) {
        fs.cpSync(src, dest, {
          recursive: true,
          filter: (candidate) => {
            if (ATTACH_SKIP.has(path.basename(candidate))) return false;
            try {
              const candidateStat = fs.lstatSync(candidate);
              if (candidateStat.isSymbolicLink()) {
                errors.push(`${path.relative(src, candidate) || path.basename(candidate)}: symbolic links are not staged`);
                return false;
              }
              if (candidateStat.isFile()) {
                if (copied + candidateStat.size > ATTACH_MAX_TOTAL) {
                  errors.push(`${path.relative(src, candidate) || path.basename(candidate)}: size cap exceeded`);
                  return false;
                }
                copied += candidateStat.size;
              }
            } catch {
              return false;
            }
            return true;
          },
        });
        lines.push(`- ${ATTACH_DIR}/${path.basename(dest)}/ (folder — likely an existing agent/skill package; explore its files)`);
      } else {
        if (copied + st.size > ATTACH_MAX_TOTAL) {
          errors.push(`${name}: size cap exceeded`);
          continue;
        }
        copied += st.size;
        fs.copyFileSync(src, dest);
        const ext = path.extname(name).toLowerCase();
        const kind = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)
          ? "image — open it with your file-read tool"
          : "file";
        lines.push(`- ${ATTACH_DIR}/${path.basename(dest)} (${kind}, ${describeSize(st.size)})`);
      }
    } catch (error) {
      errors.push(`${att.name || att.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { lines, errors };
}
