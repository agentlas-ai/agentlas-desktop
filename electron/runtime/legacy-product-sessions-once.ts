// Runs the legacy product-session move once per install, in the background (legacy-product-sessions.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { claudeProductHomeDir } from "./claude-product-home";
import { cliProductHomePath } from "./cli-product-homes";
import { defaultLegacyCleanupPaths, moveLegacyProductSessions } from "./legacy-product-sessions";

const MARKER = "legacy-product-sessions.v1.json";

export function scheduleLegacyProductSessionMove(delayMs = 90_000): void {
  const timer = setTimeout(() => {
    try {
      const userDataDir = userDataPath();
      const marker = path.join(userDataDir, MARKER);
      if (fs.existsSync(marker)) return;
      const copilotHome = path.resolve(process.env.COPILOT_HOME || path.join(process.env.HOME || os.homedir(), ".copilot"));
      const report = moveLegacyProductSessions(defaultLegacyCleanupPaths(userDataDir, {
        codexStore: path.join(userDataPath("codex-product-home"), "store"),
        claudeMirror: claudeProductHomeDir(),
        copilotMirror: cliProductHomePath("github-copilot-cli", copilotHome),
      }));
      console.info("[legacy-product-sessions]", JSON.stringify(report));
      // A locked store leaves the marker unwritten, so the next launch finishes the move.
      if (!report.errors.length) fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), ...report }), { mode: 0o600 });
    } catch (error) {
      console.warn("[legacy-product-sessions] skipped:", error instanceof Error ? error.message : String(error));
    }
  }, delayMs);
  timer.unref?.();
}
