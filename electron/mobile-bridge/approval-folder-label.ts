import path from "node:path";

/**
 * The "Folder" line of an approval card on the phone (Agentlas 2.0 desktop values S3 ④, pair rig round 2 D8).
 *
 * The approval record's `cwd` is the real folder path. A project that Agentlas made for the owner lives at
 * `~/.agentlas/projects/<slug>-<uuid>`, and the phone shows the last two parts of whatever it gets, so the owner read
 * `projects/pairrig-alpha-960d46dc-8846-…` instead of the project's own name ("PairRig Alpha"). The phone only draws
 * this value (mobile agentlas_screen.dart:10187-10194, 10321/10332; personal_one_request_card.dart:44 — no path logic),
 * so the projection sends the name a person gave the project, in the same `cwd` slot: every phone build shows it, and the
 * host path (home folder, uuid) no longer travels to the phone at all.
 *
 * Only when the approval's folder IS the chat's project folder (or inside it: `<name>/<relative path>`). Any other folder,
 * a chat without a project, an empty name — the path stays exactly as before.
 * No new value: the name is the project's `name`. Nothing is stored.
 */
export interface ApprovalFolderFacts {
  /** The project of the conversation the approval was asked in, or null. */
  projectOfChat(chatId: string): { name: string; folderPath: string | null } | null;
}

export function phoneApprovalFolder(
  cwd: string,
  chatId: string | undefined,
  facts: ApprovalFolderFacts,
  clean: (text: string) => string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!chatId) return cwd;
  let project: { name: string; folderPath: string | null } | null = null;
  try { project = facts.projectOfChat(chatId); } catch { return cwd; }
  const folder = project?.folderPath?.trim();
  if (!project || !folder) return cwd;
  const name = clean(project.name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim());
  if (!name) return cwd;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  let relative: string;
  try { relative = flavor.relative(flavor.resolve(folder), flavor.resolve(cwd)); } catch { return cwd; }
  if (relative === "") return name;
  if (relative === ".." || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)) return cwd;
  return `${name}/${relative.split(/[\\/]+/).filter(Boolean).join("/")}`;
}
