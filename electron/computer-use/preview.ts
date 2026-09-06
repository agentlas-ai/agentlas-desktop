import { desktopCapturer, screen, systemPreferences } from "electron";
import { checkComputerUsePermissions } from "../mac-permissions";
import type { ComputerUseCaptureOptions, ComputerUsePreview } from "../../shared/types";
import { nativeInputDriverAvailable } from "./native-driver";

function screenPermission(): ComputerUsePreview["screenPermission"] {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

export async function captureComputerUsePreview(
  sourceId?: string,
  options?: ComputerUseCaptureOptions,
): Promise<ComputerUsePreview> {
  const captureMode: ComputerUsePreview["captureMode"] = options?.mode === "window" ? "window" : "screen";
  const permissions = checkComputerUsePermissions();
  const driverAvailable = nativeInputDriverAvailable();
  const base: Omit<ComputerUsePreview, "sources" | "selectedSourceId" | "dataUrl" | "capturedAt" | "error"> = {
    platform: process.platform,
    captureMode,
    screenPermission: screenPermission(),
    accessibility: permissions.accessibility,
    observationAvailable: false,
    interactionAvailable: driverAvailable && permissions.accessibility,
    interactionDriver: driverAvailable ? "agentlas-native" : "agentlas-native-required",
    selectionRequired: false,
  };
  try {
    const sources = await new Promise<Awaited<ReturnType<typeof desktopCapturer.getSources>>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("desktop-capture-timeout")), 4_000);
      void desktopCapturer.getSources({
        types: [captureMode],
        thumbnailSize: { width: 1120, height: 700 },
        fetchWindowIcons: false,
      }).then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    const displays = screen.getAllDisplays();
    const summaries = sources.map((source) => {
      const size = source.thumbnail.getSize();
      const display = displays.find((candidate) => String(candidate.id) === source.display_id) ?? null;
      return {
        id: source.id,
        kind: captureMode,
        name: source.name.slice(0, 160),
        displayId: source.display_id || null,
        width: size.width,
        height: size.height,
        bounds: display ? { ...display.bounds } : null,
        scaleFactor: display?.scaleFactor ?? null,
      };
    });
    let selected: (typeof sources)[number] | null = null;
    let selectionRequired = false;
    let error: ComputerUsePreview["error"] = null;
    if (sourceId) {
      // A caller-selected source is a capability scoped to one fresh source
      // listing. Never silently replace a stale window/display with the first
      // arbitrary desktop source.
      selected = sources.find((source) => source.id === sourceId) ?? null;
      if (!selected) {
        return {
          ...base,
          sources: summaries,
          selectedSourceId: null,
          selectionRequired: captureMode === "window" && summaries.length > 0,
          dataUrl: null,
          capturedAt: new Date().toISOString(),
          error: "source-stale",
        };
      }
    } else if (captureMode === "window") {
      if (sources.length === 0) {
        error = "window-not-found";
      } else {
        // Window titles are not executable ownership evidence. Always ask the
        // user to choose the exact current window; returning candidates without
        // a thumbnail prevents external output capture from choosing an
        // unrelated app, even when a title resembles the bundle name.
        selectionRequired = true;
        error = "window-selection-required";
      }
    } else {
      selected = sources[0] ?? null;
    }
    const dataUrl = selected && !selected.thumbnail.isEmpty() ? selected.thumbnail.toDataURL() : null;
    if (selected && !dataUrl) error = "screen-unavailable";
    return {
      ...base,
      observationAvailable: Boolean(dataUrl),
      sources: summaries,
      selectedSourceId: selected?.id ?? null,
      selectionRequired,
      dataUrl,
      capturedAt: new Date().toISOString(),
      error: dataUrl ? null : error ?? "screen-unavailable",
    };
  } catch {
    return {
      ...base,
      sources: [],
      selectedSourceId: null,
      selectionRequired: false,
      dataUrl: null,
      capturedAt: new Date().toISOString(),
      error: "capture-failed",
    };
  }
}
