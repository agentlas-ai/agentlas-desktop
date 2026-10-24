/**
 * Limits for an agent's always-on instruction file (the canonical entry read on every run).
 *
 * Both values come from the hosts that load such files, not from this product:
 * - hardBytes: Codex reads AGENTS.md project instructions only up to `project_doc_max_bytes`,
 *   32 KiB by default (https://developers.openai.com/codex/guides/agents-md). Text past it is not read there.
 * - softLines: Claude Code asks for instruction files under 200 lines because longer files consume
 *   context and reduce adherence (https://code.claude.com/docs/en/memory).
 *
 * Measured 2026-10-20 on the owner profile: no installed (non-builtin) agent exceeds hardBytes; five exceed softLines.
 */
export const ALWAYS_ON_INSTRUCTION_LIMITS = { hardBytes: 32 * 1024, softLines: 200 } as const;

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).byteLength;

export interface AlwaysOnInstructionSize {
  bytes: number;
  lines: number;
}

export interface AlwaysOnInstructionChange {
  path: string | null;
  before: AlwaysOnInstructionSize;
  after: AlwaysOnInstructionSize;
  hardBytes: number;
  softLines: number;
  overHard: boolean;
  overSoft: boolean;
}

export function alwaysOnInstructionSize(text: string): AlwaysOnInstructionSize {
  if (!text) return { bytes: 0, lines: 0 };
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { bytes: byteLength(text), lines: body.split(/\r?\n/).length };
}

export function alwaysOnInstructionChange(path: string | null, beforeText: string, afterText: string): AlwaysOnInstructionChange {
  const before = alwaysOnInstructionSize(beforeText);
  const after = alwaysOnInstructionSize(afterText);
  const { hardBytes, softLines } = ALWAYS_ON_INSTRUCTION_LIMITS;
  return { path, before, after, hardBytes, softLines, overHard: after.bytes > hardBytes, overSoft: after.lines > softLines };
}

/**
 * Lines present in `after` more often than in `before` (a multiset difference), so a moved
 * line is not counted as added and a duplicated line is.
 */
export function addedLines(beforeText: string, afterText: string): string[] {
  const remaining = new Map<string, number>();
  for (const line of beforeText.split(/\r?\n/)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of afterText.split(/\r?\n/)) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added.push(line);
  }
  return added;
}

/**
 * Bytes a learning change may add to the always-on file: one trigger line per skill it creates.
 * A skill is opened only when the always-on text names it (harness2 `_check_skills`), so that
 * line is the one growth a learning change is allowed. Every other new byte must be paid for by
 * shortening or merging existing lines, or live in the skill, a script, a guard or memory.
 */
export function learningTriggerAllowance(beforeText: string, afterText: string, newSkillNames: readonly string[]): number {
  if (!newSkillNames.length) return 0;
  const used = new Set<string>();
  let allowance = 0;
  for (const line of addedLines(beforeText, afterText)) {
    const name = newSkillNames.find((skill) => !used.has(skill) && line.includes(skill));
    if (!name) continue;
    used.add(name);
    allowance += byteLength(line) + 1;
  }
  return allowance;
}
