// The notification-area (Windows, Linux) / menu-bar (macOS) icon for both trays: the background hold
// (background-tray.ts) and the One shell (one-window-manager.ts).
//
// Windows audit 2026-10-24 (ui.md #1): both trays loaded ../../build-resources/icon-1024.png from
// dist/electron, but no packaging config shipped build-resources/ inside app.asar (1.3.89 listing: 0
// entries). nativeImage.createFromPath returned an empty image and `new Tray(empty)` still succeeded,
// so Windows showed a blank slot (hidden under the ^ overflow by default) — the "visible handle" on a
// process with no window did not exist. Closing the main window after a One window had opened left a
// ghost process with nothing on screen.
//
// The rule kept here: the build copies a 64 px tray icon to dist/electron/tray-icon.png (package.json
// build:electron), so every packaging config ships it through its existing `dist/electron/**/*` rule
// (checked with electron-builder's own file matcher by the private Windows shell gate). An unbuilt dev
// run reads build-resources/icon-1024.png; the packaged renderer icon is the last fallback, and an empty
// icon is logged instead of silently creating an invisible tray.
import path from "node:path";
import { nativeImage } from "electron";

/** Candidate files, best first. `dir` is dist/electron at run time. */
export function trayIconCandidates(dir: string = __dirname): string[] {
  return [
    path.join(dir, "tray-icon.png"),
    path.join(dir, "..", "..", "build-resources", "icon-1024.png"),
    path.join(dir, "..", "renderer", "icon.png"),
  ];
}

/** Logical tray size in DIP: Windows uses 16, macOS/Linux 18. */
export function trayIconSize(platform: NodeJS.Platform): number {
  return platform === "win32" ? 16 : 18;
}

/** Scale factors to provide so 125 %, 150 % and 200 % displays get a crisp icon. */
export const TRAY_ICON_SCALES = [1, 1.25, 1.5, 2] as const;

export function trayIcon(platform: NodeJS.Platform = process.platform, dir: string = __dirname): Electron.NativeImage {
  const size = trayIconSize(platform);
  for (const file of trayIconCandidates(dir)) {
    const source = nativeImage.createFromPath(file);
    if (source.isEmpty()) continue;
    const out = nativeImage.createEmpty();
    for (const scale of TRAY_ICON_SCALES) {
      const px = Math.round(size * scale);
      out.addRepresentation({ scaleFactor: scale, buffer: source.resize({ width: px, height: px, quality: "best" }).toPNG() });
    }
    return out;
  }
  console.warn("[tray] icon file missing; the tray would be invisible");
  return nativeImage.createEmpty();
}
