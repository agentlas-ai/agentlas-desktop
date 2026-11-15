/**
 * The form of a skill file a learning change creates (Agentlas 2.0 decision and), checked by code, not by a model.
 *
 * A model's answer for `skills/<name>/SKILL.md` is first put right here: a fence around the whole answer, CRLF, a name that is not the folder's,
 * a missing description, a frontmatter that was never closed, one of the four sections the owner reads (when to use, when not to use, how to
 * verify, how to undo) left out. None of that is shown to the owner as an error and none of it costs a second model call; the corrected file is
 * what the diff shows, so the owner reads exactly what would be written.
 *
 * Only what code cannot invent is an issue: an empty body, a name with no letter or digit, a file past the size a skill may have, a credential.
 * An issue is the one place the existing "host's refusal text, one more round" path is used (workspace-service.ts prepareAgentWorkspaceFromMemory),
 * and a second failure keeps the lesson as memory without telling the owner.
 *
 * Pure functions: no Electron, no database, no file access. Callers pass the skill roots, the text the agent has now, and the secret check.
 */
import { redactPrivate, usableNames, type RedactionKind } from "./skill-redact";

/** A line the corrector puts in a section the model left out. Fixed text, so the owner can see what was not specified. */
export const SKILL_UNSPECIFIED = "Not specified — ask the owner before relying on this.";
export const SKILL_MAX_LINES = 500;
export const SKILL_MAX_BYTES = 20 * 1024;
const DESCRIPTION_MAX = 1024;
const NAME_MAX = 64;

export type SkillFixCode =
  | "fence_stripped" | "bom_removed" | "crlf_normalized" | "frontmatter_added" | "frontmatter_closed" | "name_set" | "description_filled"
  | "description_truncated" | "section_added" | "trailing_newline" | "folder_renamed" | "file_name_case";
export type SkillIssueCode = "skill_body_empty" | "skill_name_invalid" | "skill_name_private" | "skill_too_large" | "skill_secret";
export interface SkillIssue { code: SkillIssueCode; path: string; message: string }
export interface SkillFormatResult {
  /** The file as it should be written (corrected even when `issues` is not empty). */
  text: string;
  /** Machine codes of what was put right; a `section_added` code carries the section after a colon. */
  fixed: string[];
  issues: SkillIssue[];
}

const SECTIONS: ReadonlyArray<{ key: string; heading: string; pattern: RegExp }> = [
  { key: "when_to_use", heading: "When to use", pattern: /^#{1,6}\s*(?:when\s+to\s+(?:use|apply)|use\s+(?:this\s+skill\s+)?when|applies\s+when|triggers?)\b/i },
  { key: "when_not_to_use", heading: "When not to use", pattern: /^#{1,6}\s*(?:when\s+not\s+to\s+(?:use|apply)|do\s*n[o']?t\s+use|don['’]t\s+use|not\s+for|limits|limitations)\b/i },
  { key: "verify", heading: "Verify", pattern: /^#{1,6}\s*(?:verify|verification|how\s+to\s+verify|validation|success\s+criteria|check(?:s|ing)?)\b/i },
  { key: "undo", heading: "Undo", pattern: /^#{1,6}\s*(?:undo|rollback|roll\s+back|revert|how\s+to\s+undo)\b/i },
];

/** The folder name a skill gets from a name the model chose: lowercase letters, digits, dot, underscore, hyphen; at most 64. Empty when nothing is left. */
export function skillSlug(raw: string): string {
  const slug = raw.normalize("NFKC").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return slug.slice(0, NAME_MAX).replace(/[^a-z0-9]+$/g, "");
}

/** `skills/<folder>/SKILL.md` (any of the roots, the file name in any case) → its parts; null when the path is not a skill file. */
export function skillPathParts(filePath: string, roots: readonly string[]): { root: string; folder: string; file: string } | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const root of roots) {
    if (!normalized.startsWith(`${root}/`)) continue;
    const rest = normalized.slice(root.length + 1).split("/");
    if (rest.length === 2 && /^skill\.md$/i.test(rest[1]) && rest[0]) return { root, folder: rest[0], file: rest[1] };
  }
  return null;
}

interface Frontmatter { entries: Array<{ key: string; lines: string[] }>; bodyStart: number }
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
  }
  return trimmed;
}
/** The value of a key as one line: block scalars and indented continuations are joined with a space. */
function entryValue(entry: { lines: string[] }): string {
  const first = entry.lines[0].replace(/^[^:]*:/, "").trim();
  const rest = entry.lines.slice(1).map(line => line.trim()).filter(Boolean);
  if (/^[|>][+-]?\d*$/.test(first)) return rest.join(" ");
  return unquote([first, ...rest].filter(Boolean).join(" "));
}
function parseFrontmatter(lines: string[]): { frontmatter: Frontmatter | null; closed: boolean } {
  if (lines[0]?.trim() !== "---") return { frontmatter: null, closed: true };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) if (lines[index].trim() === "---") { end = index; break; }
  let closed = true, headEnd = end;
  if (end < 0) {
    // A frontmatter that was never closed: its lines are the leading `key: value` lines (and their indented continuations).
    closed = false;
    headEnd = 1;
    while (headEnd < lines.length && (/^[A-Za-z][\w-]*\s*:/.test(lines[headEnd]) || (/^\s+\S/.test(lines[headEnd]) && headEnd > 1))) headEnd += 1;
  }
  const entries: Frontmatter["entries"] = [];
  for (const line of lines.slice(1, headEnd)) {
    if (/^[A-Za-z][\w-]*\s*:/.test(line)) entries.push({ key: line.slice(0, line.indexOf(":")).trim().toLowerCase(), lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
  }
  return { frontmatter: { entries, bodyStart: closed ? end + 1 : headEnd }, closed };
}
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][^:#"'\\\n]*$/.test(value) && !/\s$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value) ? value : JSON.stringify(value);
}
function firstSentence(body: string): string {
  const prose = body.split("\n").map(line => line.trim()).filter(line => line && !/^(?:#{1,6}\s|```|---$|[-*]\s*$)/.test(line));
  const source = prose[0] ?? body.split("\n").map(line => line.replace(/^#{1,6}\s*/, "").trim()).find(Boolean) ?? "";
  const cleaned = source.replace(/^[-*>\d.)\s]+/, "").replace(/[*_`]/g, "").trim();
  const match = /^(.{8,}?[.!?。])(?:\s|$)/.exec(cleaned);
  return (match ? match[1] : cleaned).slice(0, DESCRIPTION_MAX).trim();
}
/** Headings outside code fences, with their line index. */
function headings(lines: string[]): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  let fence = "";
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = ""; return; }
    if (!fence && /^#{1,6}\s/.test(line)) out.push({ index, text: line });
  });
  return out;
}

/**
 * Puts one skill file right. `folder` is the folder name the file will have (already a slug). Idempotent: the result of a correction passes unchanged.
 * `looksSecret` is the host's credential check. `knownNames` are names the folder must not carry (see {@link skillNamePrivate}).
 */
export function formatSkillFile(input: { path: string; folder: string; text: string; looksSecret?: (text: string) => boolean }): SkillFormatResult {
  const fixed: string[] = [], issues: SkillIssue[] = [];
  let text = input.text;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); fixed.push("bom_removed"); }
  if (text.includes("\r")) { text = text.replace(/\r\n?/g, "\n"); fixed.push("crlf_normalized"); }
  let lines = text.split("\n");
  // The whole answer wrapped in one code fence (the model's habit); a skill that merely ends in a fenced block starts with its frontmatter, not a fence.
  const opening = /^(`{3,}|~{3,})[\w-]*\s*$/.exec(lines[0]?.trim() ?? "");
  if (opening) {
    let last = lines.length - 1;
    while (last > 0 && !lines[last].trim()) last -= 1;
    if (last > 0 && lines[last].trim().startsWith(opening[1][0].repeat(opening[1].length)) && /^(`+|~+)$/.test(lines[last].trim())) {
      lines = lines.slice(1, last); fixed.push("fence_stripped");
    }
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  const parsed = parseFrontmatter(lines);
  let entries: Frontmatter["entries"] = parsed.frontmatter?.entries ?? [];
  let body = parsed.frontmatter ? lines.slice(parsed.frontmatter.bodyStart).join("\n") : lines.join("\n");
  if (parsed.frontmatter && !parsed.closed) fixed.push("frontmatter_closed");
  if (!parsed.frontmatter) fixed.push("frontmatter_added");
  body = body.replace(/^\n+/, "");

  const nameEntry = entries.find(entry => entry.key === "name"), descEntry = entries.find(entry => entry.key === "description");
  const folder = input.folder;
  let head = [...entries];
  if (!nameEntry || entryValue(nameEntry) !== folder || !/^name:/.test(nameEntry.lines[0])) {
    if (nameEntry) head = head.map(entry => entry === nameEntry ? { key: "name", lines: [`name: ${folder}`] } : entry);
    else head = [{ key: "name", lines: [`name: ${folder}`] }, ...head];
    fixed.push("name_set");
  }
  const description = descEntry ? entryValue(descEntry) : "";
  if (description && descEntry && !/^description:/.test(descEntry.lines[0]) && description.length <= DESCRIPTION_MAX) {
    // The key written in another case ("Description:") is not the key a skill reader looks for.
    head = head.map(entry => entry === descEntry ? { key: "description", lines: [`description: ${yamlScalar(description)}`] } : entry);
    fixed.push("description_filled");
  } else if (!description) {
    const derived = firstSentence(body);
    if (derived) {
      const lineFor = { key: "description", lines: [`description: ${yamlScalar(derived)}`] };
      head = descEntry ? head.map(entry => entry === descEntry ? lineFor : entry) : [...head.slice(0, head.findIndex(entry => entry.key === "name") + 1), lineFor, ...head.slice(head.findIndex(entry => entry.key === "name") + 1)];
      fixed.push("description_filled");
    }
  } else if (description.length > DESCRIPTION_MAX) {
    head = head.map(entry => entry === descEntry ? { key: "description", lines: [`description: ${yamlScalar(description.slice(0, DESCRIPTION_MAX).trimEnd())}`] } : entry);
    fixed.push("description_truncated");
  }

  // The four sections.
  const bodyLines = body.split("\n");
  const found = headings(bodyLines);
  const missing = SECTIONS.filter(section => !found.some(heading => section.pattern.test(heading.text)));
  const bodyText = body.trim();
  if (!bodyText) issues.push({ code: "skill_body_empty", path: input.path, message: "The skill body is empty; write what the skill does and when to use it." });
  if (bodyText) {
    let out = body.replace(/\s+$/, "");
    for (const section of missing) { out += `\n\n## ${section.heading}\n\n${SKILL_UNSPECIFIED}`; fixed.push(`section_added:${section.key}`); }
    body = out;
  }
  const rebuilt = `---\n${head.flatMap(entry => entry.lines).join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
  text = `${rebuilt.replace(/\s+$/, "")}\n`;
  if (!input.text.replace(/\r\n?/g, "\n").endsWith("\n") && !fixed.includes("fence_stripped")) fixed.push("trailing_newline");
  // A skill that was already right keeps its bytes: the rebuild above is only used when something was put right.
  if (!fixed.length) text = input.text;
  if (!/[a-z0-9]/.test(folder)) issues.push({ code: "skill_name_invalid", path: input.path, message: "The skill name needs letters or digits; name the folder after what the skill does." });
  if (Buffer.byteLength(text) > SKILL_MAX_BYTES || text.split("\n").length > SKILL_MAX_LINES) issues.push({ code: "skill_too_large", path: input.path, message: `A skill may have at most ${SKILL_MAX_LINES} lines and ${SKILL_MAX_BYTES / 1024} KB; keep the core and move detail into files next to it.` });
  if (input.looksSecret?.(text)) issues.push({ code: "skill_secret", path: input.path, message: "Remove credential-like values from the skill." });
  return { text, fixed, issues };
}

/** The description of a skill file as one line ("" when it has none). */
export function skillDescription(text: string): string {
  const entry = parseFrontmatter(text.replace(/\r\n?/g, "\n").split("\n")).frontmatter?.entries.find(item => item.key === "description");
  return entry ? entryValue(entry) : "";
}

/**
 * Whether a skill folder name carries one of the names the owner's own data uses (a project, a person, an account): the name would travel with the skill.
 * The same names the text replacement uses (`usableNames`: no generic or too short word), compared on whole hyphen-separated parts, so a project folder called `app`
 * or `test` does not refuse every `apply-...` / `run-tests-...` skill (E-2). `knownNames` is already the owner's list; a person's name stays a name at any length it has.
 */
export function skillNamePrivate(folder: string, knownNames: readonly string[]): boolean {
  const parts = (text: string): string => skillSlug(text).replace(/[._]+/g, "-");
  const haystack = `-${parts(folder) || folder.toLowerCase()}-`;
  return usableNames(knownNames).some(name => {
    const value = parts(name);
    return value.length >= 3 && haystack.includes(`-${value}-`);
  });
}

export interface SkillChangeInput { path: string; afterContent: string; [key: string]: unknown }
export interface RefinedSkill { path: string; name: string; description: string; fixes: string[] }
export interface RefinedChanges {
  changes: SkillChangeInput[];
  skills: RefinedSkill[];
  /** Values replaced by `[가림]` in what the change would write (skill files whole, other files only on the lines the change adds). */
  redactedCount: number;
  redactedKinds: Partial<Record<RedactionKind, number>>;
  issues: SkillIssue[];
}
/**
 * The compiler's answer put right: each skill file formatted and its private values replaced, every other file's added lines cleaned the same way,
 * folder renames carried into the trigger line that names the skill. A change that is not a string (a delete) passes through.
 */
export function refineCompilerChanges(input: {
  changes: readonly SkillChangeInput[];
  roots: readonly string[];
  /** The text the agent has now at a path, or null. */
  currentText: (path: string) => string | null;
  knownNames: readonly string[];
  looksSecret?: (text: string) => boolean;
}): RefinedChanges {
  const skills: RefinedSkill[] = [], issues: SkillIssue[] = [], kinds: Partial<Record<RedactionKind, number>> = {};
  let redactedCount = 0;
  const renames: Array<{ from: string; to: string }> = [];
  const count = (result: { count: number; kinds: Partial<Record<RedactionKind, number>> }) => {
    redactedCount += result.count;
    for (const [kind, n] of Object.entries(result.kinds)) kinds[kind as RedactionKind] = (kinds[kind as RedactionKind] ?? 0) + (n ?? 0);
  };
  const out: SkillChangeInput[] = [];
  for (const change of input.changes) {
    if (!change || typeof change.path !== "string" || typeof change.afterContent !== "string") { out.push(change); continue; }
    const parts = skillPathParts(change.path, input.roots);
    if (!parts) {
      const current = input.currentText(change.path);
      const known = new Set((current ?? "").split("\n").map(line => line.trim()));
      let lineCount = 0, kindCount: Partial<Record<RedactionKind, number>> = {};
      const cleaned = change.afterContent.split("\n").map(line => {
        if (known.has(line.trim())) return line;
        const result = redactPrivate(line, { names: input.knownNames });
        lineCount += result.count;
        for (const [kind, n] of Object.entries(result.kinds)) kindCount = { ...kindCount, [kind]: (kindCount[kind as RedactionKind] ?? 0) + (n ?? 0) };
        return result.text;
      }).join("\n");
      count({ count: lineCount, kinds: kindCount });
      out.push({ ...change, afterContent: cleaned });
      continue;
    }
    const slug = skillSlug(parts.folder);
    const folder = slug || parts.folder;
    const fileName = "SKILL.md";
    const fixes: string[] = [];
    if (folder !== parts.folder) { renames.push({ from: parts.folder, to: folder }); fixes.push("folder_renamed"); }
    if (parts.file !== fileName) fixes.push("file_name_case");
    const newPath = `${parts.root}/${folder}/${fileName}`;
    const formatted = formatSkillFile({ path: newPath, folder, text: change.afterContent });
    const redacted = redactPrivate(formatted.text, { names: input.knownNames });
    count(redacted);
    issues.push(...formatted.issues);
    // The credential check reads what would be written, after private values are replaced (a link's token is already gone by then).
    if (input.looksSecret?.(redacted.text)) issues.push({ code: "skill_secret", path: newPath, message: "Remove credential-like values from the skill." });
    if (skillNamePrivate(folder, input.knownNames)) issues.push({ code: "skill_name_private", path: newPath, message: "Do not put a project, person or account name in the skill name; name it after the procedure." });
    skills.push({ path: newPath, name: folder, description: skillDescription(redacted.text).slice(0, 240), fixes: [...fixes, ...formatted.fixed] });
    out.push({ ...change, path: newPath, afterContent: redacted.text });
  }
  // A folder the corrector renamed is still named by its old name in the trigger line another change writes; carry the new name there.
  const final = renames.length ? out.map(change => {
    if (!change || typeof change.afterContent !== "string" || skillPathParts(change.path, input.roots)) return change;
    let content = change.afterContent;
    for (const rename of renames) content = content.split(`the ${rename.from} skill`).join(`the ${rename.to} skill`).split(`skills/${rename.from}/`).join(`skills/${rename.to}/`);
    return content === change.afterContent ? change : { ...change, afterContent: content };
  }) : out;
  return { changes: final, skills, redactedCount, redactedKinds: kinds, issues };
}
