// Publish auto-fix — before a Hub/Cloud publish, the user's strongest connected
// model reviews the package and remediates it so "any agent" can publish:
//   - artifacts and secrets the model marks are excluded from the published copy
//   - missing bilingual metadata (localized titleEn/Ko + descriptionEn/Ko) is
//     translated by the model and written into .agentlas/agent-card.json
//
// Safety is NOT delegated to the model: a deterministic backstop always excludes
// secret-bearing files and symlinks regardless of what the model says, so a wrong
// or adversarial model judgment can never leak a real secret to the public Hub.
//
// The original folder is never mutated. Everything happens in a throwaway copy;
// the caller publishes the returned clean folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerRequest } from "../runtime/runner";
import { pickRunner } from "../runtime/selection";
import { detectRuntimes } from "../runtime/detect";
import { securityScan } from "./commands";

// Deterministic safety backstop — a secret/artifact match here is ALWAYS
// excluded, even if the model omitted it. This is the never-publish-a-secret
// invariant, not a substitute for the model's broader judgment.
const NEVER_PUBLISH_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__",
  ".venv", "venv", ".env.d", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".tox", ".gradle", ".idea", ".terraform",
]);
const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\.(?!example$|sample$|template$).*)?$/i, // .env / .env.local — but keep .env.example
  /^id_rsa(?:\.pub)?$/i,
  /^credentials(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
  /(?:^|[._-])service-account(?:[._-]|$)/i,
  /\.(?:key|pem|p12|pfx|mobileprovision)$/i,
];

export interface PublishAutofixResult {
  ready: boolean;
  /** Clean, publishable folder (a temp copy). Only set when ready. */
  packageFolder: string | null;
  excluded: string[];
  localizedFilled: boolean;
  /** Findings the model could NOT auto-fix; publish stays blocked with these. */
  remainingBlockers: Array<{ path?: string; message: string }>;
  model: string | null;
  /** Cleanup — always call after the caller finishes with packageFolder. */
  cleanup: () => void;
}

interface ModelPlan {
  exclude: string[];
  localized: { titleEn: string; titleKo: string; descriptionEn: string; descriptionKo: string } | null;
  acknowledgeWarns: Array<{ path?: string; type?: string; reason?: string }>;
}

const COST_RANK: Record<string, number> = { frontier: 3, balanced: 2, economy: 1 };

/** Pick the strongest connected runtime; fall back to the active one. */
export async function pickStrongestRunner(active: RuntimeStatus | null): Promise<{
  runner: Runner;
  runtime: RuntimeStatus;
  label: string;
} | null> {
  let detected: RuntimeStatus[] = [];
  try {
    detected = await detectRuntimes();
  } catch {
    detected = active ? [active] : [];
  }
  const runnable = detected
    .map((rt) => {
      const picked = pickRunner(rt);
      return picked ? { runtime: rt, runner: picked.runner, label: picked.label } : null;
    })
    .filter((entry): entry is { runtime: RuntimeStatus; runner: Runner; label: string } => entry !== null);
  if (runnable.length === 0) {
    if (!active) return null;
    const picked = pickRunner(active);
    return picked ? { runner: picked.runner, runtime: active, label: picked.label } : null;
  }
  const strength = (rt: RuntimeStatus): number => {
    const model = rt.model ?? undefined;
    const profile = model ? rt.allocationModelProfiles?.[model] : undefined;
    const tier = profile?.costTier
      ?? Object.values(rt.allocationModelProfiles ?? {}).map((p) => p.costTier).find(Boolean);
    return tier ? COST_RANK[tier] ?? 0 : 0;
  };
  runnable.sort((a, b) => strength(b.runtime) - strength(a.runtime) || Number(b.runtime.active) - Number(a.runtime.active));
  return runnable[0];
}

function relDirParts(rel: string): string[] {
  return rel.split("/").slice(0, -1);
}

export function isNeverPublish(rel: string): boolean {
  if (relDirParts(rel).some((part) => NEVER_PUBLISH_DIRS.has(part))) return true;
  const name = rel.split("/").pop() ?? rel;
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

function walkFiles(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        out.push(`@symlink:${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (NEVER_PUBLISH_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(base);
  return out;
}

function safeModelJson(text: string): ModelPlan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed: unknown = {};
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = {};
    }
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const exclude = Array.isArray(obj.exclude) ? obj.exclude.filter((v): v is string => typeof v === "string") : [];
  const rawLoc = obj.localized as Record<string, unknown> | undefined;
  const localized = rawLoc && ["titleEn", "titleKo", "descriptionEn", "descriptionKo"].every((k) => typeof rawLoc[k] === "string" && (rawLoc[k] as string).trim())
    ? {
        titleEn: String(rawLoc.titleEn).trim(),
        titleKo: String(rawLoc.titleKo).trim(),
        descriptionEn: String(rawLoc.descriptionEn).trim(),
        descriptionKo: String(rawLoc.descriptionKo).trim(),
      }
    : null;
  const acknowledgeWarns = Array.isArray(obj.acknowledgeWarns)
    ? obj.acknowledgeWarns.filter((v): v is Record<string, unknown> => !!v && typeof v === "object").map((v) => ({
        path: typeof v.path === "string" ? v.path : undefined,
        type: typeof v.type === "string" ? v.type : undefined,
        reason: typeof v.reason === "string" ? String(v.reason).slice(0, 400) : undefined,
      }))
    : [];
  return { exclude, localized, acknowledgeWarns };
}

function readAgentCard(base: string): { file: string; data: Record<string, unknown> } | null {
  for (const rel of [".agentlas/agent-card.json", "agentlas.json"]) {
    const file = path.join(base, rel);
    if (fs.existsSync(file)) {
      try {
        return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> };
      } catch {
        return { file, data: {} };
      }
    }
  }
  return null;
}

function localizedMissing(base: string): boolean {
  const card = readAgentCard(base);
  const loc = (card?.data.localized ?? (card?.data.publicProfile as Record<string, unknown> | undefined)?.localized) as Record<string, unknown> | undefined;
  if (!loc) return true;
  return !["titleEn", "titleKo", "descriptionEn", "descriptionKo"].every((k) => typeof loc[k] === "string" && (loc[k] as string).trim());
}

async function runModelReview(
  runner: Runner,
  runtime: RuntimeStatus,
  label: string,
  base: string,
  scanText: string,
  needLocalized: boolean,
  signal: AbortSignal | undefined,
  locale: "ko" | "en",
): Promise<ModelPlan> {
  const files = walkFiles(base).slice(0, 400);
  const card = readAgentCard(base);
  const cardName = card && typeof card.data.name === "string" ? card.data.name : "";
  const cardTagline = card && typeof card.data.tagline === "string" ? card.data.tagline : "";
  // Give the model THIS agent's real identity so any translation is faithful,
  // not a generic placeholder.
  const defRel = ["agent.md", "AGENTS.md", "AGENT.md", "agentlas.json", "README.md"].find((r) => fs.existsSync(path.join(base, r)));
  let defExcerpt = "";
  if (defRel) {
    try {
      defExcerpt = fs.readFileSync(path.join(base, defRel), "utf8").slice(0, 1800);
    } catch {
      defExcerpt = "";
    }
  }
  const system = [
    "You review an Agentlas agent package before it is published to the PUBLIC Agentlas Hub.",
    "Decide, generically, what must be removed and fix bilingual metadata. Return JSON only, no prose.",
    "EXCLUDE from the published package (add relative paths to `exclude`): local build artifacts and",
    "developer junk (virtualenvs, caches, lockfile-only tooling dirs, editor config, OS cruft), symlinks,",
    "and any secret-bearing file (real .env with values, private keys, credentials). Keep instructional",
    "files and env KEY-NAME templates like .env.example. Never exclude the agent definition, README, or skills.",
    needLocalized
      ? "The package is missing verified bilingual metadata. Produce `localized` with titleEn, titleKo, descriptionEn, descriptionKo. Base it STRICTLY on the provided `agent` object (its real name, tagline, and definitionExcerpt) — translate THIS specific agent faithfully into natural English and Korean. Do NOT invent a generic name or capabilities the agent does not have."
      : "Bilingual metadata is present; set `localized` to null.",
    "For prompt-injection / destructive-command WARN findings that are actually benign (documentation, examples, the agent's own legitimate instructions), list them in `acknowledgeWarns` with {path,type,reason}. Do NOT acknowledge anything that is a real secret or a real exfiltration.",
    'Return exactly: {"exclude":[],"localized":null,"acknowledgeWarns":[]}',
  ].join("\n");
  const user = JSON.stringify({
    agent: { name: cardName, tagline: cardTagline, definitionExcerpt: defExcerpt },
    files,
    symlinks: files.filter((f) => f.startsWith("@symlink:")),
    staticScan: scanText.slice(0, 6000),
  });
  // A slow or stuck model must never block publishing forever — bound the
  // review and fall back to the deterministic backstop if it runs long.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 90_000);
  if (signal) {
    if (signal.aborted) timeout.abort();
    else signal.addEventListener("abort", () => timeout.abort(), { once: true });
  }
  const req: RunnerRequest = {
    systemPrompt: system,
    history: [],
    userPrompt: user,
    backendLabel: label,
    model: runtime.model ?? undefined,
    longContext: false,
    effort: runtime.effort ?? "medium",
    permission: "read",
    cwd: base,
    env: {},
    signal: timeout.signal,
    locale,
  } as RunnerRequest;
  try {
    const result = await runner(req, { onPartial: () => {}, onStatus: () => {}, onTool: () => {} });
    return safeModelJson(result.text ?? "");
  } catch {
    return { exclude: [], localized: null, acknowledgeWarns: [] };
  } finally {
    clearTimeout(timer);
  }
}

function copyClean(src: string, dest: string, extraExclude: Set<string>): string[] {
  const excluded: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(src, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        excluded.push(rel);
        continue;
      }
      if (isNeverPublish(rel) || extraExclude.has(rel)) {
        excluded.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const target = path.join(dest, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(abs, target);
      }
    }
  };
  walk(src);
  return excluded;
}

function writeLocalized(base: string, localized: ModelPlan["localized"]): boolean {
  if (!localized) return false;
  const card = readAgentCard(base);
  const file = card?.file ?? path.join(base, ".agentlas", "agent-card.json");
  const data = card?.data ?? {};
  data.localized = { ...(data.localized as Record<string, unknown> | undefined), ...localized };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return true;
}

function writeLlmJudgment(base: string, plan: ModelPlan, model: string | null): void {
  if (plan.acknowledgeWarns.length === 0) return;
  const file = path.join(base, ".agentlas", "security-llm-judgment.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    schemaVersion: "1",
    judgedAt: new Date(0).toISOString(),
    model: model ?? "",
    verdict: "WARN",
    findings: plan.acknowledgeWarns.map((w) => ({
      verdict: "WARN",
      type: w.type ?? "other",
      path: w.path ?? "",
      message: (w.reason ?? "Reviewed as benign by the connected model.").slice(0, 500),
      redacted: false,
    })),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Review + remediate a package for publish. Returns a clean temp folder to
 * publish, or the remaining blockers if the model could not clear them.
 */
export async function autofixForPublish(input: {
  folder: string;
  active: RuntimeStatus | null;
  signal?: AbortSignal;
  locale?: "ko" | "en";
}): Promise<PublishAutofixResult> {
  const base = path.resolve(input.folder);
  const locale = input.locale ?? "ko";
  const noop: PublishAutofixResult["cleanup"] = () => {};

  const initialScan = await securityScan(base, { strict: true, signal: input.signal }).catch(() => null);
  const scanText = initialScan ? `${initialScan.stdout ?? ""}\n${initialScan.stderr ?? ""}`.trim() : "";

  const picked = await pickStrongestRunner(input.active);
  const modelName = picked?.runtime.model ?? picked?.runtime.kind ?? null;
  const plan = picked
    ? await runModelReview(picked.runner, picked.runtime, picked.label, base, scanText, localizedMissing(base), input.signal, locale)
    : { exclude: [], localized: null, acknowledgeWarns: [] };

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-publish-"));
  const cleanup = () => {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  const extraExclude = new Set(plan.exclude.map((p) => p.replace(/^\.?\//, "")));
  const excluded = copyClean(base, dest, extraExclude);

  const localizedFilled = writeLocalized(dest, plan.localized);
  writeLlmJudgment(dest, plan, modelName);

  // Re-scan the cleaned copy against the model's acknowledgment. Anything still
  // BLOCK-level (real secret value, exfiltration) survives and blocks publish.
  const judgmentPath = path.join(dest, ".agentlas", "security-llm-judgment.json");
  const hasJudgment = fs.existsSync(judgmentPath);
  const finalScan = await securityScan(dest, {
    strict: true,
    signal: input.signal,
    ...(hasJudgment ? { llmJudgmentPath: judgmentPath, acknowledgeWarn: true } : {}),
  }).catch(() => null);
  const finalOut = finalScan ? `${finalScan.stdout ?? ""}`.trim() : "";
  const ready = Boolean(finalScan?.ok) && !/BLOCK|blocker/i.test(finalOut);

  const remainingBlockers = ready
    ? []
    : finalOut
        .split("\n")
        .filter((line) => /BLOCK|blocker/i.test(line))
        .slice(0, 12)
        .map((line) => ({ message: line.trim() }));

  if (!ready) {
    cleanup();
    return { ready: false, packageFolder: null, excluded, localizedFilled, remainingBlockers, model: modelName, cleanup: noop };
  }
  return { ready: true, packageFolder: dest, excluded, localizedFilled, remainingBlockers: [], model: modelName, cleanup };
}
