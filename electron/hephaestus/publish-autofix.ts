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
import type { CloudAgentPublishStage, RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerRequest } from "../runtime/runner";
import { pickRunner } from "../runtime/selection";
import { detectRuntimes } from "../runtime/detect";
import { securityScan } from "./commands";
import { looksSecret, redactSecrets } from "../../shared/secret-patterns";

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
  // `credentials/` and `signing/` match the secret-name patterns as FOLDERS, so
  // the whole folder was dropped including the README the product writes into
  // it — the note telling an installer what to put there. The generated
  // .gitignore keeps exactly that file (`credentials/*` plus
  // `!credentials/README.md`); this keeps the same one.
  if (/^(?:credentials|signing)\/README\.md$/i.test(rel)) return false;
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
      // Directory names are matched only against the never-publish DIRECTORY
      // list. Running the secret FILE patterns over a directory name is what
      // made `credentials/` disappear whole — folder and README together —
      // even though the product writes that README precisely to be read by
      // whoever installs the package.
      const neverPublishHere = entry.isDirectory()
        ? relDirParts(`${rel}/x`).some((part) => NEVER_PUBLISH_DIRS.has(part))
        : isNeverPublish(rel);
      if (neverPublishHere || extraExclude.has(rel)) {
        excluded.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        // ★ A FILE THAT DID NOT COPY MUST NOT VANISH QUIETLY.
        //
        //   `entry.isFile()` is what readdir saw a moment ago. By the time the
        //   copy runs the path may be something else — the swap-a-regular-file-
        //   for-a-FIFO race is the sharp version, and a copy that blocks or
        //   throws left the file out of the package with nothing recorded.
        //   Measured 2026-08-18: the FIFO case ended `verdict: "pass"`, zero
        //   findings, empty remediation, and `fifo.md` simply not there.
        //
        //   Re-check the type without following links, copy, and treat any
        //   failure as an exclusion the caller will report by name.
        const target = path.join(dest, rel);
        try {
          const current = fs.lstatSync(abs);
          if (!current.isFile()) {
            excluded.push(rel);
            continue;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // ★ THE SNAPSHOT MUST BE A SNAPSHOT.
          //
          //   The publish gate compares fstat before and after every read, so a
          //   file that changes mid-scan is refused. That protection guards the
          //   COPY — and nothing guarded the copying itself. Measured
          //   2026-08-18: a file appended to while this pass was reading it was
          //   copied in its half-written state and published, with zero
          //   findings, because the scan then read a copy that was perfectly
          //   stable. Compare size/mtime/inode across the copy, retry once for
          //   an ordinary save landing at the wrong moment, and record an
          //   exclusion rather than shipping bytes nobody chose to publish.
          let copied = false;
          for (let attempt = 0; attempt < 2 && !copied; attempt += 1) {
            const before = fs.lstatSync(abs);
            fs.copyFileSync(abs, target);
            const after = fs.lstatSync(abs);
            copied =
              before.size === after.size
              && before.mtimeMs === after.mtimeMs
              && before.ino === after.ino
              && after.size === fs.lstatSync(target).size;
          }
          if (!copied) {
            fs.rmSync(target, { force: true });
            excluded.push(rel);
          }
        } catch {
          try {
            fs.rmSync(target, { force: true });
          } catch {
            /* best effort */
          }
          excluded.push(rel);
        }
      } else {
        // Neither a directory nor a regular file — a FIFO, socket or device,
        // including one that replaced a regular file between readdir and now.
        // The old code had no branch here at all: such an entry was skipped
        // without being copied AND without being recorded, so it left the
        // package with nothing said about it.
        excluded.push(rel);
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

  // The cleaned copy is the publish INPUT, not the final verdict. autofix never
  // dead-ends a publish on its own: it always hands back a throwaway copy for the
  // caller's generic remediation loop (remediateBlockers, driven by the real
  // publish gate scanAgentFolder) to take to zero blockers and upload.
  return { ready: true, packageFolder: dest, excluded, localizedFilled, remainingBlockers: [], model: modelName, cleanup };
}

/** A publish-gate blocker to remediate. `file` is relative to the package folder. */
export interface RemediationBlocker {
  id: string;
  file: string;
  category: string;
  message: string;
}

/** What the remediation did to one file — surfaced to the user as stage feedback. */
export interface RemediationAction {
  file: string;
  action: "redacted" | "rewritten" | "excluded" | "kept";
  detail: string;
}

const MAX_REMEDIABLE_BYTES = 512 * 1024;
const TEXT_EXT = /\.(?:md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|kt|c|h|cpp|php|pl|sql|html?|css|xml|csv|tsv|properties|dockerfile|gitignore|editorconfig)$/i;

function isTextFile(abs: string, rel: string): boolean {
  if (/(?:^|\/)dockerfile$/i.test(rel) || /(?:^|\/)makefile$/i.test(rel)) return true;
  if (!TEXT_EXT.test(rel)) {
    // Sniff: treat as text if the first bytes have no NUL.
    try {
      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(512);
      const read = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      return !buf.subarray(0, read).includes(0);
    } catch {
      return false;
    }
  }
  return true;
}

interface FileFix {
  action: "rewrite" | "exclude" | "keep";
  content?: string;
  reason: string;
}

function safeFixJson(text: string): FileFix {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "keep", reason: "no plan" };
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { action: "keep", reason: "unparseable plan" };
  }
  const action = obj.action === "rewrite" || obj.action === "exclude" ? obj.action : "keep";
  return {
    action,
    content: typeof obj.content === "string" ? obj.content : undefined,
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 300) : "",
  };
}

async function llmFixFile(
  runner: Runner,
  runtime: RuntimeStatus,
  label: string,
  rel: string,
  content: string,
  messages: string[],
  signal: AbortSignal | undefined,
  locale: "ko" | "en",
): Promise<FileFix> {
  const system = [
    "You remediate ONE file in an Agentlas agent package so it passes a public-Hub security scan and can be uploaded.",
    "The goal is ALWAYS a successful upload — fix the file, do not give up.",
    "Return JSON only: {\"action\":\"rewrite\"|\"exclude\",\"content\":\"<full fixed file when rewriting>\",\"reason\":\"...\"}.",
    "Rules:",
    "- Real secret VALUES (API keys, tokens, passwords, private keys): replace ONLY the value with a clear placeholder like <YOUR_API_KEY> or ${API_KEY}. Keep the surrounding docs/code intact.",
    "- Documentation examples / format specs / field names that merely LOOK like keys (e.g. `sk-ant-...`, `x-api-key` header names): make them unambiguous placeholders (e.g. `sk-ant-<YOUR_KEY>`) so the scanner is satisfied, preserving the explanation.",
    "- Remote-shell-install patterns (curl … | sh): rewrite into explicit, reviewable steps (download, verify, run) or an inert fenced example.",
    "- If and only if the file is pure local junk / a real credential file with nothing reusable, return action \"exclude\".",
    "- Prefer rewrite over exclude. When rewriting, return the COMPLETE file content, changed minimally.",
  ].join("\n");
  const user = JSON.stringify({ file: rel, blockers: messages.slice(0, 8), content: content.slice(0, 24000) });
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
    cwd: process.cwd(),
    env: {},
    signal: timeout.signal,
    locale,
  } as RunnerRequest;
  try {
    const result = await runner(req, { onPartial: () => {}, onStatus: () => {}, onTool: () => {} });
    return safeFixJson(result.text ?? "");
  } catch {
    return { action: "keep", reason: "model unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remediate an arbitrary set of publish-gate blockers in-place inside the
 * throwaway package folder. GENERIC: it does not care what the blocker is — it
 * asks the connected model to fix each offending file (redact secrets to
 * placeholders, defang installers, rewrite), and if the model can't or the
 * blocker is a secret, a deterministic redaction guarantees the value is gone.
 * The loop that calls this owns escalation to file-exclude as a last resort, so
 * the package always converges to zero blockers and uploads.
 */
export async function remediateBlockers(input: {
  folder: string;
  blockers: RemediationBlocker[];
  active: RuntimeStatus | null;
  locale?: "ko" | "en";
  signal?: AbortSignal;
  deterministicOnly?: boolean;
  onStage?: (stage: CloudAgentPublishStage, detail?: string) => void;
}): Promise<{ changed: boolean; actions: RemediationAction[] }> {
  const folder = path.resolve(input.folder);
  const locale = input.locale ?? "ko";
  const actions: RemediationAction[] = [];
  let changed = false;

  // Group blockers by real, in-folder file.
  const byFile = new Map<string, RemediationBlocker[]>();
  for (const b of input.blockers) {
    if (!b.file) continue;
    const abs = path.resolve(folder, b.file);
    if (!abs.startsWith(folder + path.sep)) continue;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) continue;
    const list = byFile.get(b.file) ?? [];
    list.push(b);
    byFile.set(b.file, list);
  }

  const picked = input.deterministicOnly ? null : await pickStrongestRunner(input.active);

  for (const [rel, group] of byFile) {
    const abs = path.resolve(folder, rel);
    let content = "";
    let readable = true;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_REMEDIABLE_BYTES || !isTextFile(abs, rel)) readable = false;
      else content = fs.readFileSync(abs, "utf8");
    } catch {
      readable = false;
    }
    const isSecret = group.some((b) => b.category === "secret");
    const messages = group.map((b) => b.message);

    // 1) Model remediation (skipped for a binary/oversized file or deterministic pass).
    if (readable && picked) {
      input.onStage?.("remediating", rel);
      const fix = await llmFixFile(picked.runner, picked.runtime, picked.label, rel, content, messages, input.signal, locale);
      if (fix.action === "exclude") {
        try {
          fs.rmSync(abs, { force: true });
          actions.push({ file: rel, action: "excluded", detail: fix.reason || "model excluded" });
          changed = true;
          continue;
        } catch {
          /* fall through to deterministic net */
        }
      } else if (fix.action === "rewrite" && typeof fix.content === "string" && fix.content.trim() && fix.content !== content) {
        content = fix.content;
        try {
          fs.writeFileSync(abs, content, "utf8");
          actions.push({ file: rel, action: "rewritten", detail: fix.reason || "model rewrite" });
          changed = true;
        } catch {
          /* fall through */
        }
      }
    }

    // 2) Deterministic secret net — a secret VALUE must be gone regardless of the
    //    model. Applied whenever the file still looks like it carries a credential.
    if (readable && isSecret && looksSecret(content)) {
      const redacted = redactSecrets(content, "<REDACTED>");
      if (redacted !== content) {
        try {
          fs.writeFileSync(abs, redacted, "utf8");
          actions.push({ file: rel, action: "redacted", detail: "deterministic secret redaction" });
          changed = true;
        } catch {
          /* keep going; the loop escalates to exclude */
        }
      }
    }
  }

  return { changed, actions };
}
