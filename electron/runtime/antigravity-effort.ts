











import { spawnCli } from "./exec";
import type { ModelEffortApplication } from "./model-call-ledger";

/** agy 1.4.0's `--effort` levels; the installed CLI's own help decides which of them it takes. */
export const ANTIGRAVITY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const SUFFIX_RE = /-(none|minimal|low|medium|high|xhigh|max)$/u;

/** The thinking level an agy model id fixes (its `-<level>` suffix), or null for a base id. */
export function antigravityModelEffort(model: string | null | undefined): string | null {
  const id = model?.trim();
  if (!id) return null;
  return SUFFIX_RE.exec(id)?.[1] ?? null;
}

/** `--effort` levels printed by `agy --help` (`(low|medium|high|xhigh|max)`); empty when the flag is absent. */
export function parseAntigravityEffortHelp(help: string): string[] {
  const match = /--effort\b[^\n(]*\(([a-z0-9|, ]+)\)/iu.exec(help);
  if (!match) return [];
  return match[1]!.split(/[|,]/u).map((level) => level.trim().toLowerCase()).filter(Boolean);
}

export interface AntigravityEffortPlan {
  /** Extra argv for the spawn: `["--effort", level]` or nothing. */
  args: string[];
  /** The ledger fact (reportModelEffort). */
  application: ModelEffortApplication;
  /** RunnerResult.appliedEffort: the level the run is known to use, or null when none was set by this runner. */
  applied: string | null;
}

/**
 * What to send for `requested` on `model`, given the levels the installed CLI's help lists (null: not probed because no
 * flag would be sent). A suffixed id applies its own level: a different requested level is recorded as such (applied =
 * the id's level, requested = the chip's), never sent as a conflicting flag.
 */
export function antigravityEffortPlan(
  model: string | null | undefined,
  requested: string | null | undefined,
  helpLevels: readonly string[] | null,
): AntigravityEffortPlan {
  const want = requested?.trim().toLowerCase() || null;
  const fixed = antigravityModelEffort(model);
  if (fixed) {
    return { args: [], applied: fixed, application: { status: "applied", applied: fixed, requested: want, wire: "--model" } };
  }
  if (!want) return { args: [], applied: null, application: { status: "not_requested" } };
  if (!model?.trim()) return { args: [], applied: null, application: { status: "unsupported", requested: want, reason: "agy_effort_needs_explicit_model" } };
  if (!(ANTIGRAVITY_EFFORT_LEVELS as readonly string[]).includes(want)) {
    return { args: [], applied: null, application: { status: "unsupported", requested: want, reason: "agy_effort_level_unsupported" } };
  }
  if (!helpLevels || !helpLevels.includes(want)) {
    return { args: [], applied: null, application: { status: "unsupported", requested: want,
      reason: helpLevels && helpLevels.length > 0 ? "agy_effort_level_unsupported" : "agy_effort_flag_unavailable" } };
  }
  return { args: ["--effort", want], applied: want, application: { status: "applied", applied: want, requested: want, wire: "--effort" } };
}

/** Whether a help probe is needed: only a base model id with a requested level can get the flag. */
export function antigravityEffortNeedsHelp(model: string | null | undefined, requested: string | null | undefined): boolean {
  return Boolean(model?.trim() && requested?.trim() && !antigravityModelEffort(model));
}

const helpCache = new Map<string, Promise<string[]>>();

/**
 * `agy --help` levels for one executable generation (cli-executable-identity.ts). agy prints its usage on stderr. A failed
 * or timed-out probe answers [] and is not cached, so the next turn asks again.
 */
export function probeAntigravityEffortLevels(bin: string, generation: string, timeoutMs = 4000): Promise<string[]> {
  const key = `${generation}\0${bin}`;
  const cached = helpCache.get(key);
  if (cached) return cached;
  const probe = new Promise<string[] | null>((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string[] | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child: ReturnType<typeof spawnCli>;
    try { child = spawnCli(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? parseAntigravityEffortHelp(out) : null));
  });
  const levels = probe.then((value) => {
    if (value === null) helpCache.delete(key);
    return value ?? [];
  });
  if (helpCache.size >= 16) helpCache.delete(helpCache.keys().next().value!);
  helpCache.set(key, levels);
  return levels;
}
