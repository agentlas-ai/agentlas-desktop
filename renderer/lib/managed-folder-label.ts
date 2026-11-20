// A folder as a person reads it. The app keeps a project's own folder (a project made with "Decide later") under
// agentlas-home/projects/<project name>-<uuid>; the uuid keeps two projects of one name apart on disk and means nothing on screen.
const TRAILING_UUID = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One folder name with the internal id suffix of an app-managed project folder removed. */
export function plainFolderName(name: string): string {
  return name.replace(TRAILING_UUID, "") || name;
}

/** The last `parts` segments of a path for display, each plain; an app-managed project folder reads as the project's folder name alone. */
export function plainFolderTail(path: string, parts = 2): string {
  const segments = path.replace(/[\x00-\x1f\x7f]/g, "").split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1) ?? "";
  if (TRAILING_UUID.test(last)) return plainFolderName(last);
  return segments.slice(-parts).map(plainFolderName).join("/");
}
