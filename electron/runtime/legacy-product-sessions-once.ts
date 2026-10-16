// Runs the legacy product-session move once per install, in the background (legacy-product-sessions.ts).
//
// The marker is v2: the first pass (legacy-product-sessions.v1.json) decided Codex sessions by index rows and left the
// files behind mirror paths in the person's ~/.codex (2026-10-17), so every install runs the file-evidence pass once more.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { claudeProductHomeDir } from "./claude-product-home";
import { cliProductHomePath } from "./cli-product-homes";
import { defaultLegacyCleanupPaths, moveLegacyProductSessions } from "./legacy-product-sessions";

export const LEGACY_PRODUCT_SESSIONS_MARKER = "legacy-product-sessions.v2.json";

export function scheduleLegacyProductSessionMove(delayMs = 90_000): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const userDataDir = userDataPath();
        const marker = path.join(userDataDir, LEGACY_PRODUCT_SESSIONS_MARKER);
        if (fs.existsSync(marker)) return;
        const copilotHome = path.resolve(process.env.COPILOT_HOME || path.join(process.env.HOME || os.homedir(), ".copilot"));
        const { report, errorCodes } = await moveLegacyProductSessions(defaultLegacyCleanupPaths(userDataDir, {
          codexStore: path.join(userDataPath("codex-product-home"), "store"),
          claudeMirror: claudeProductHomeDir(),
          copilotMirror: cliProductHomePath("github-copilot-cli", copilotHome),
        }));
        // Counts and stable codes only: never a path, id, title or text.
        console.info("[legacy-product-sessions]", JSON.stringify({ ...report, ...(errorCodes.length ? { errorCodes } : {}) }));
        // A locked store leaves the marker unwritten, so the next launch finishes the move.
        if (report.errors === 0) fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), ...report }), { mode: 0o600 });
      } catch (error) {
        console.warn("[legacy-product-sessions] skipped:", (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "unknown"));
      }
    })();
  }, delayMs);
  timer.unref?.();
}
