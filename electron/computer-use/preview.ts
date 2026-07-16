import { desktopCapturer, screen, systemPreferences } from "electron";
import { checkComputerUsePermissions } from "../mac-permissions";
import type { ComputerUsePreview } from "../../shared/types";
import { nativeInputDriverAvailable } from "./native-driver";

function screenPermission(): ComputerUsePreview["screenPermission"] {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

export async function captureComputerUsePreview(sourceId?: string): Promise<ComputerUsePreview> {
  const permissions = checkComputerUsePermissions();
  const driverAvailable = nativeInputDriverAvailable();
  const base: Omit<ComputerUsePreview, "sources" | "selectedSourceId" | "dataUrl" | "capturedAt" | "error"> = {
    platform: process.platform,
    screenPermission: screenPermission(),
    accessibility: permissions.accessibility,
    observationAvailable: false,
    interactionAvailable: driverAvailable && permissions.accessibility,
    interactionDriver: driverAvailable ? "agentlas-native" : "agentlas-native-required",
  };
  try {
    const sources = await new Promise<Awaited<ReturnType<typeof desktopCapturer.getSources>>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("desktop-capture-timeout")), 4_000);
      void desktopCapturer.getSources({
        types: ["screen"],
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
        name: source.name.slice(0, 160),
        displayId: source.display_id || null,
        width: size.width,
        height: size.height,
        bounds: display ? { ...display.bounds } : null,
        scaleFactor: display?.scaleFactor ?? null,
      };
    });
    const selected = sources.find((source) => source.id === sourceId) ?? sources[0] ?? null;
    const dataUrl = selected && !selected.thumbnail.isEmpty() ? selected.thumbnail.toDataURL() : null;
    return {
      ...base,
      observationAvailable: Boolean(dataUrl),
      sources: summaries,
      selectedSourceId: selected?.id ?? null,
      dataUrl,
      capturedAt: new Date().toISOString(),
      error: dataUrl ? null : "screen-unavailable",
    };
  } catch {
    return {
      ...base,
      sources: [],
      selectedSourceId: null,
      dataUrl: null,
      capturedAt: new Date().toISOString(),
      error: "capture-failed",
    };
  }
}
