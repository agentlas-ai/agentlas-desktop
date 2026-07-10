import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

let cachedRoot: string | null | undefined;

/** Pure runtime-root discovery without importing Desktop main/bootstrap code. */
export function hephaestusRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const candidates: string[] = [];
  if (process.env.HEPHAESTUS_RUNTIME_ROOT) candidates.push(process.env.HEPHAESTUS_RUNTIME_ROOT);
  candidates.push(path.join(os.homedir(), ".agentlas", "runtime", "current"));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "Hephaestus"));
  try {
    candidates.push(path.join(app.getAppPath(), "Hephaestus"));
  } catch {
    // Electron app path is unavailable in some isolated tests.
  }
  candidates.push(path.join(__dirname, "..", "..", "..", "Hephaestus"));
  candidates.push(path.join(__dirname, "..", "..", "Hephaestus"));
  try {
    candidates.push(path.join(process.cwd(), "Hephaestus"));
  } catch {
    // No cwd candidate.
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(path.join(candidate, "agentlas_cloud", "__main__.py"))) {
        cachedRoot = path.resolve(candidate);
        return cachedRoot;
      }
    } catch {
      // Try the next root.
    }
  }
  cachedRoot = null;
  return null;
}

export function resetHephaestusRootCache(): void {
  cachedRoot = undefined;
}
