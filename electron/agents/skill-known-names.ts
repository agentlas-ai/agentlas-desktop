import path from "node:path";
import { getDb } from "../store/db";
import { NAME_CAP, isCommonName, usableNames } from "./skill-redact";

/**
 * The names the owner's own data uses, for agents/skill-redact.ts: the signed-in account's name and the members of the organization, project names and project folder
 * names, chat titles. Read when a learning change is prepared (a few times a day at most), never kept. Each source answers on its own; one that cannot be read leaves the others. Never throws.
 *
 * Priority order (the replacement cap keeps the first names, Agentlas 2.0 E-1): people and the account first, projects next, chat titles last and only in the room that is left.
 * An ordinary word as a project or folder name (`app`, `web`, `test`) and a chat title that is one short word are not private names (E-2): they would blank ordinary words and refuse ordinary skill names.
 * `incomplete` is true when a source or the cap left names out, so the card can say that some names may not be hidden.
 */
export interface KnownPrivateNames { names: string[]; incomplete: boolean }

const PEOPLE_LIMIT = 500, PROJECT_LIMIT = 2000, CHAT_LIMIT = 1000;

/** A chat title is a name only when it is specific: several words, or long enough that an ordinary sentence does not contain it by chance. */
function chatTitleIsName(title: string): boolean {
  const text = title.trim();
  if (!text || isCommonName(text)) return false;
  const nonAscii = /[^\x00-\x7f]/.test(text);
  return text.split(/\s+/).length >= 3 || text.length >= (nonAscii ? 8 : 16);
}

export function collectKnownPrivateNames(): KnownPrivateNames {
  const people: string[] = [], projects: string[] = [], chats: string[] = [];
  let incomplete = false;
  const rows = (sql: string): Array<Record<string, unknown>> => { try { return getDb().prepare(sql).all() as Array<Record<string, unknown>>; } catch { return []; } };
  try {
    // The account's own name; the auth module is only loaded when a change is prepared.
    const session = (require("../auth") as typeof import("../auth")).getAuthSession();
    if (session.signedIn && session.name) people.push(session.name);
  } catch { /* signed out, or no Electron in this process */ }
  const members = rows(`SELECT display_name FROM one_org_members WHERE display_name IS NOT NULL LIMIT ${PEOPLE_LIMIT}`);
  if (members.length >= PEOPLE_LIMIT) incomplete = true;
  for (const row of members) if (typeof row.display_name === "string") people.push(row.display_name);
  const projectRows = rows(`SELECT name, folder_path FROM projects LIMIT ${PROJECT_LIMIT}`);
  if (projectRows.length >= PROJECT_LIMIT) incomplete = true;
  for (const row of projectRows) {
    if (typeof row.name === "string" && !isCommonName(row.name)) projects.push(row.name);
    if (typeof row.folder_path === "string" && row.folder_path) {
      for (const base of [path.win32.basename(row.folder_path.replace(/\/+$/, "")), path.posix.basename(row.folder_path.replace(/\\+$/, ""))]) if (base && !isCommonName(base)) projects.push(base);
    }
  }
  const chatRows = rows(`SELECT title FROM chats ORDER BY updated_at DESC LIMIT ${CHAT_LIMIT}`);
  if (chatRows.length >= CHAT_LIMIT) incomplete = true;
  for (const row of chatRows) if (typeof row.title === "string" && chatTitleIsName(row.title)) chats.push(row.title);
  const names = [...people, ...projects, ...chats];
  // Names the cap will leave out are the last ones; say so.
  if (usableNames(names, Number.MAX_SAFE_INTEGER).length > NAME_CAP) incomplete = true;
  return { names, incomplete };
}
