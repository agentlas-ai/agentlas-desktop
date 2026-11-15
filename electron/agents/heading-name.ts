/**
 * The agent name a markdown title stands for. A package's `manifest.md` is titled after the FILE ("Manifest — Excel helper", "Manifest: Excel
 * helper"), so reading its first heading as the agent's name renamed an agent the first time its folder was re-read (desktop trial
 * team.list / home.tree / room participants showed "Manifest — 엑셀 도우미"). The file label is cut off and the name after it is
 * kept; a title that is only the file label ("Manifest") names nothing and returns "".
 */
const FILE_LABEL_PREFIX = /^manifest\s*(?:[-–—:·|]\s*|\s+of\s+|\s+for\s+)(.+)$/i;
const FILE_LABEL_ONLY = /^(?:manifest|manifest\.md|매니페스트)$/i;

export function agentNameFromHeading(cleaned: string): string {
  const text = cleaned.trim();
  if (!text || FILE_LABEL_ONLY.test(text)) return "";
  const stripped = FILE_LABEL_PREFIX.exec(text)?.[1]?.trim();
  return stripped ? stripped : text;
}
