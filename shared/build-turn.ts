/** A build is complete only when its final non-empty line is the package receipt. */
export function isCompletedBuildTurn(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const lastLine = text.replace(/\r/g, "").trimEnd().split("\n").at(-1) ?? "";
  return /^[ \t]*BUILD_COMPLETE[ \t]*:[ \t]*\S.*$/i.test(lastLine);
}
