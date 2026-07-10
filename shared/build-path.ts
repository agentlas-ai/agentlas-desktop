/** BUILD_COMPLETE의 한 줄 폴더명을 공백까지 보존하고 workspace 밖 경로는 거부한다. */
export function packagePathFromText(workspace: string, assistantText: string): string | null {
  // Completion and delivery must share one receipt. Looking for the first
  // marker in the whole reply lets an example or stale earlier marker select a
  // different folder even though the final line completed the turn.
  const lastLine = assistantText.replace(/\r/g, "").trimEnd().split("\n").at(-1) ?? "";
  const match = lastLine.match(/^[ \t]*BUILD_COMPLETE[ \t]*:[ \t]*([^\r\n]+)$/i);
  if (!match) return null;
  let value = match[1].trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const closing = value.indexOf(quote, 1);
    if (closing < 0) return null;
    value = value.slice(1, closing).trim();
  }
  if (!value || value.includes("\0")) return null;

  const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedValue = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalizedWorkspace || !normalizedValue) return null;
  const absolute = normalizedValue.startsWith("/") || /^[A-Za-z]:\//.test(normalizedValue);
  const segmentSource = normalizedValue.startsWith("/") ? normalizedValue.slice(1) : normalizedValue;
  const segments = segmentSource.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return null;

  if (absolute) {
    const lowerWorkspace = normalizedWorkspace.toLowerCase();
    const lowerValue = normalizedValue.toLowerCase();
    if (lowerValue !== lowerWorkspace && !lowerValue.startsWith(`${lowerWorkspace}/`)) return null;
    return normalizedValue;
  }
  const workspaceName = normalizedWorkspace.split("/").pop() ?? normalizedWorkspace;
  if (normalizedValue === workspaceName) return null;
  return `${normalizedWorkspace}/${normalizedValue}`;
}
