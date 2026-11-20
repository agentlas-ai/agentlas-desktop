/** The title a taskforce row may hold: what the taskforce forms accept (one line, at most 80 characters). Null when nothing usable is left. */
export function groupRoomTitleOf(title: string | null | undefined): string | null {
  const clean = Array.from(String(title ?? "").normalize("NFC").replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim()).slice(0, 80).join("").trim();
  return clean || null;
}
