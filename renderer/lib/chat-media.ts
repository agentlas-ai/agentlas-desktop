/**
 * Which local outputs the chat shows as themselves instead of a link: pictures and videos sit in the conversation
 * with no frame, audio gets a player, slides and documents get a cover tile that opens the right panel.
 */
export type ChatMediaKind = "image" | "video" | "audio" | "presentation" | "document" | "spreadsheet";

const KIND_BY_EXTENSION: Readonly<Record<string, ChatMediaKind>> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", svg: "image", bmp: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio", aac: "audio", weba: "audio",
  ppt: "presentation", pptx: "presentation", pptm: "presentation", ppsx: "presentation", odp: "presentation", key: "presentation",
  pdf: "document", doc: "document", docx: "document", docm: "document", rtf: "document", odt: "document", pages: "document", hwp: "document", hwpx: "document",
  xls: "spreadsheet", xlsx: "spreadsheet", xlsm: "spreadsheet", ods: "spreadsheet", numbers: "spreadsheet",
};

const BADGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ppt: "PPT", pptx: "PPT", pptm: "PPT", ppsx: "PPT", odp: "ODP", key: "KEY",
  pdf: "PDF", doc: "DOC", docx: "DOC", docm: "DOC", rtf: "RTF", odt: "ODT", pages: "PAGES", hwp: "HWP", hwpx: "HWP",
  xls: "XLS", xlsx: "XLS", xlsm: "XLS", ods: "ODS", numbers: "NUM",
};

function extensionOf(path: string): string {
  const name = path.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function chatMediaKindOfPath(path: string): ChatMediaKind | null {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? null;
}

/** The type mark on a document tile; the tile's colour is keyed by the same text. */
export function chatMediaBadge(path: string): string {
  return BADGE_BY_EXTENSION[extensionOf(path)] ?? "FILE";
}

export interface ChatMediaLink<T> {
  label: string;
  kind: ChatMediaKind;
  target: T;
}

/**
 * Takes the local output links out of one paragraph. A sentence keeps its words (a link's label stays as plain text) and the media
 * goes under it; a paragraph that was nothing but those links leaves no text at all. `resolve` answers null for anything that is
 * not a local output, which stays a link. Code spans and images are left alone; a file linked twice in one paragraph shows once.
 */
export function splitChatMediaLinks<T extends { path: string }>(
  text: string,
  resolve: (href: string, label: string) => T | null,
): { text: string; media: ChatMediaLink<T>[] } {
  const media: ChatMediaLink<T>[] = [];
  const seen = new Set<string>();
  const stripped = text.replace(/`[^`]*`|(!?)\[([^\]]+)\]\(([^)]+)\)/g, (whole, bang: string | undefined, label: string | undefined, href: string | undefined) => {
    if (label === undefined || href === undefined) return whole;
    const target = resolve(href, label);
    const kind = target ? chatMediaKindOfPath(target.path) : null;
    // Image syntax stays an image, unless it names something an image element cannot show (a model writes ![clip](clip.mp4) too).
    if (!target || !kind || (bang && kind === "image")) return whole;
    if (!seen.has(target.path)) { seen.add(target.path); media.push({ label, kind, target }); }
    return `\u0000${label}\u0001`;
  });
  if (!media.length) return { text, media };
  const onlyLinks = !stripped.replace(/\u0000[^\u0001]*\u0001/g, "").replace(/[\s.,;:!?·•\-–—|/()[\]]+/g, "");
  return { text: onlyLinks ? "" : stripped.replace(/[\u0000\u0001]/g, ""), media };
}
