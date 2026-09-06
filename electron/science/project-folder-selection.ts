import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 60 * 1000;

export function validateScienceProjectFolderPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("science-project-folder-path-invalid");
  }
  try {
    const stat = fs.lstatSync(value);
    if (stat.isSymbolicLink()) throw new Error("science-project-folder-symlink-forbidden");
    if (!stat.isDirectory()) throw new Error("science-project-folder-not-directory");
    const canonical = fs.realpathSync(value);
    if (canonical === path.parse(canonical).root) throw new Error("science-project-folder-root-forbidden");
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-project-folder-")) throw error;
    throw new Error("science-project-folder-unavailable");
  }
}

interface FolderSelection {
  senderId: number;
  documentId: string;
  selectedPath: string;
  path: string;
  device: number;
  inode: number;
  expiresAt: number;
  requestId: string | null;
}

/** Main-only capabilities. Persisting a path does not grant file read/write access. */
export class ScienceProjectFolderSelections {
  private readonly selections = new Map<string, FolderSelection>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    for (const [id, selection] of this.selections) if (selection.expiresAt <= this.now()) this.selections.delete(id);
  }

  select(senderId: number, documentId: string, selectedPath: string): { selectionId: string; path: string } {
    this.prune();
    const canonical = validateScienceProjectFolderPath(selectedPath);
    const stat = fs.statSync(canonical);
    const owned = [...this.selections].filter(([, selection]) => selection.senderId === senderId);
    if (owned.length >= 32) this.selections.delete(owned[0][0]);
    const selectionId = randomUUID();
    this.selections.set(selectionId, { senderId, documentId, selectedPath, path: canonical,
      device: stat.dev, inode: stat.ino, expiresAt: this.now() + MAX_AGE_MS, requestId: null });
    return { selectionId, path: canonical };
  }

  resolve(selectionId: unknown, senderId: number, documentId: string, requestId: unknown): string | undefined {
    if (typeof selectionId !== "string" || !UUID_RE.test(selectionId)
      || typeof requestId !== "string" || !UUID_RE.test(requestId)) throw new Error("science-project-folder-selection-invalid");
    this.prune();
    const selection = this.selections.get(selectionId);
    // Only the store's exact persisted request replay may succeed without a live grant.
    if (!selection) return undefined;
    if (selection.senderId !== senderId || selection.documentId !== documentId) throw new Error("science-project-folder-selection-owner-mismatch");
    if (selection.requestId && selection.requestId !== requestId) throw new Error("science-project-folder-selection-already-used");
    if (selection.requestId === requestId) return undefined;
    const canonical = validateScienceProjectFolderPath(selection.selectedPath);
    const stat = fs.statSync(canonical);
    if (canonical !== selection.path || stat.dev !== selection.device || stat.ino !== selection.inode) {
      throw new Error("science-project-folder-selection-changed");
    }
    return canonical;
  }

  commit(selectionId: string, requestId: string): void {
    const selection = this.selections.get(selectionId);
    if (selection) selection.requestId = requestId;
  }

  clear(senderId: number): void {
    for (const [id, selection] of this.selections) if (selection.senderId === senderId) this.selections.delete(id);
  }
}
