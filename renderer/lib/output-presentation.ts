import type { OneSurfaceManifestV1 } from "@shared/one-surface";

/**
 * The output rail is one in-app surface.  These are presentation hints only:
 * they never decide what is safe to execute, they only decide whether the
 * existing rail should open at a comfortable width for the rendered result.
 */
export type OutputPresentationKind =
  | "standard"
  | "code"
  | "image"
  | "video"
  | "audio"
  | "web"
  | "map"
  | "document"
  | "gallery";

const EXTENSION_KIND: Array<[RegExp, OutputPresentationKind]> = [
  [/\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu, "video"],
  [/\.(?:mp3|m4a|wav|ogg|flac|aac)(?:$|[?#])/iu, "audio"],
  [/\.(?:png|jpe?g|gif|webp|avif|bmp|ico)(?:$|[?#])/iu, "image"],
  [/\.(?:pdf|docx?|odt|rtf|hwpx?|pages|xlsx?|csv|ods|pptx?|keynote)(?:$|[?#])/iu, "document"],
  [/\.(?:html?|xhtml)(?:$|[?#])/iu, "web"],
  [/\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|less|json|ya?ml|toml|xml|graphql?|sql|md|mdx|txt)(?:$|[?#])/iu, "code"],
];

export function outputPresentationKindForName(name: string | null | undefined): OutputPresentationKind {
  const value = String(name ?? "").trim().toLowerCase();
  for (const [pattern, kind] of EXTENSION_KIND) {
    if (pattern.test(value)) return kind;
  }
  return "standard";
}

export function outputPresentationKindForViewerKind(kind: string | null | undefined): OutputPresentationKind {
  switch (String(kind ?? "").toLowerCase()) {
    case "browser": return "web";
    case "image": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "pdf":
    case "document":
    case "spreadsheet":
    case "presentation":
    case "archive": return "document";
    case "markdown":
    case "json":
    case "text": return "code";
    default: return "standard";
  }
}

export function outputPresentationKindForManifest(manifest: OneSurfaceManifestV1 | null | undefined): OutputPresentationKind {
  if (!manifest) return "standard";
  const blockKinds = new Set(manifest.blocks.map((block) => block.type));
  if (blockKinds.has("Map")) return "map";
  if (blockKinds.has("Media")) {
    const media = manifest.blocks.find((block) => block.type === "Media");
    if (media?.type === "Media") {
      if (media.mediaType === "video") return "video";
      if (media.mediaType === "audio") return "audio";
      if (media.mediaType === "image") return "image";
    }
    return "video";
  }
  if (blockKinds.has("Gallery")) return "gallery";
  if (blockKinds.has("Document")) return "document";
  const artifact = manifest.blocks.find((block) => block.type === "ArtifactList");
  if (artifact?.type === "ArtifactList") {
    for (const item of artifact.items) {
      const kind = outputPresentationKindForName(item.label);
      if (kind !== "standard") return kind;
      if (item.type === "video" || item.type === "audio" || item.type === "image") return item.type;
      if (["document", "spreadsheet", "archive"].includes(item.type)) return "document";
    }
  }
  if (manifest.layoutProfile === "itinerary") return "map";
  return "standard";
}

export function outputPresentationKindForWorkbenchManifest(manifest: Record<string, unknown> | null | undefined): OutputPresentationKind {
  if (!manifest) return "standard";
  const layout = String(manifest.layout ?? "").toLowerCase();
  const widgets = Array.isArray(manifest.widgets) ? manifest.widgets : [];
  const data = manifest.data && typeof manifest.data === "object" ? Object.values(manifest.data as Record<string, unknown>) : [];
  if (layout.includes("map") || widgets.some((item) => String((item as Record<string, unknown>)?.type ?? "").toLowerCase() === "map") || data.some((item) => String((item as Record<string, unknown>)?.type ?? "").toLowerCase() === "routes")) return "map";
  if (layout.includes("service") || layout.includes("app") || widgets.some((item) => String((item as Record<string, unknown>)?.type ?? "").toLowerCase() === "app-shell") || Boolean((manifest.app as Record<string, unknown> | undefined)?.deployment)) return "web";
  if (data.some((item) => ["media", "storyboard", "asset-board"].includes(String((item as Record<string, unknown>)?.type ?? "").toLowerCase()))) return "video";
  if (data.some((item) => String((item as Record<string, unknown>)?.type ?? "").toLowerCase() === "artifacts")) return "document";
  return "standard";
}

export function isWideOutputKind(kind: OutputPresentationKind): boolean {
  return kind !== "standard";
}

/** Width used by the supplied desktop reference: roughly 43% of the content window. */
export function preferredOutputRailWidth(viewportWidth: number, minWidth: number, maxWidth: number): number {
  const requested = viewportWidth <= 760 ? Math.round(viewportWidth * 0.86) : Math.round(viewportWidth * 0.432);
  return Math.min(maxWidth, Math.max(minWidth, requested));
}
