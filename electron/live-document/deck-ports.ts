import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ZipPackage } from "./zip";
import { parseXml } from "./xml-lite";
import { DECK_OUTPUT_MAX_BYTES, DECK_SCRIPT_MAX_CHARS, DECK_TIMEOUT_DEFAULT_MS, runDeckScript } from "./deck-run";
import { lintDeck, type DeckLintReport } from "./deck-lint";

/*
 * Harness ports that let a model design a NEW deck in code (document.deck.build) and check any deck (document.deck.lint).
 *
 * Why a port and not the model's own shell: the person's computer may have neither pptxgenjs nor python-pptx, a runtime may have
 * no shell at all, and a model's shell is not the place to enforce a boundary. The port runs the model's pptxgenjs script with the
 * library this app ships, in the sandbox of live-document/deck-run.ts, checks what came out (a package PowerPoint can open, then the
 * lint) and opens the file in the Document tab so document.render, document.read and document.apply work on it at once.
 *
 * A deck that already exists is edited with document.apply, never rebuilt from a script: build replaces only a file this same port
 * wrote earlier (same bytes on disk), so a rebuild loop cannot clobber the person's own file.
 *
 * No electron import (the daemon loads the harness).
 */

type Outcome =
  | { status: "ok"; data: unknown; produced?: readonly string[] }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

interface Ctx { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full" }

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const refused = (reason: string, next?: string, data?: unknown): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}), ...(data !== undefined ? { data } : {}) });
const writable = (ctx: Ctx) => ctx.permission === "write" || ctx.permission === "full";

/**
 * The next step for a deck run that failed in this app's deck runtime rather than in the script (deck-run.ts classifyDeckFailure:
 * the bundled library or one of its packages could not be loaded, the sandboxed child could not start or did not start the
 * script in time, the finished file could not be saved). Retrying with an edited script cannot help, so the model is told so.
 */
export const DECK_HOST_FAILURE_NEXT = "this is a fault of this app's deck runtime, not of your script: do not build again with the same or an edited script. Build the deck with document.create and document.apply instead, and tell the person the deck builder failed (deck_runtime_failed)";

/** path -> sha256 of the bytes this port last wrote there. Per process, like live-document/ports.ts createdInRun. */
const builtHere = new Map<string, string>();
const BUILT_LIMIT = 256;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export const DECK_PORT_SCHEMAS = {
  build: {
    type: "object", required: ["path", "script"],
    properties: {
      path: { type: "string", description: "absolute path of the new .pptx (its folder must exist). An existing file is replaced only if this port wrote it earlier (rebuild loop)." },
      script: { type: "string", maxLength: DECK_SCRIPT_MAX_CHARS, description:
        "JavaScript body for pptxgenjs 4.x. It runs as the body of an async function with `pptxgen` (the class; require('pptxgenjs') is the same) and require('path') only: no fs, no network, no other module. "
        + "Write const pres = new pptxgen(); set pres.layout = 'LAYOUT_WIDE' first (13.33 x 7.5 in; the default canvas is 10 x 5.625 in); build every slide; end with return pres (pres.writeFile() is optional and its file name is ignored). "
        + "Colours are 6 hex digits (a value pptxgenjs cannot read becomes black and is reported in `logs`). Pictures by absolute path via addImage({ path }). Charts with pres.addChart (native). Korean text: fontFace 'Malgun Gothic'. console output, including the library's own warnings, comes back in `logs`. Limits: 60 s, 200000 characters." },
    },
  },
  lint: {
    type: "object",
    properties: {
      path: { type: "string", description: "absolute path of a .pptx (any maker)" },
      sessionId: { type: "string", description: "or the session of a deck open in the Document tab (its file on disk is checked)" },
    },
  },
} as const;

async function store() {
  return import("./store");
}

/** What PowerPoint refuses and a generator can easily get wrong: malformed slide XML, a colour that is not 6 hex digits, a part the package does not hold. */
export function validateDeckPackage(bytes: Uint8Array): string[] {
  const issues: string[] = [];
  let pkg: ZipPackage;
  try { pkg = new ZipPackage(bytes); } catch { return ["the file is not a zip package"]; }
  for (const required of ["[Content_Types].xml", "ppt/presentation.xml"]) if (!pkg.has(required)) issues.push(`missing part ${required}`);
  const slides = pkg.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (!slides.length) issues.push("the deck has no slides");
  const badColors = new Set<string>();
  for (const name of slides) {
    const xml = pkg.text(name) ?? "";
    try { parseXml(xml); } catch { issues.push(`${name} is not well-formed XML`); continue; }
    for (const match of xml.matchAll(/<a:srgbClr val="([^"]*)"/g)) if (!/^[0-9a-fA-F]{6}$/.test(match[1])) badColors.add(match[1]);
  }
  if (badColors.size) issues.push(`colour value(s) ${[...badColors].slice(0, 4).map((c) => JSON.stringify(c)).join(", ")} are not 6 hex digits: write FF0000, and use the transparency option instead of an alpha pair`);
  const types = pkg.text("[Content_Types].xml") ?? "";
  for (const name of slides) if (!types.includes(`PartName="/${name}"`)) issues.push(`${name} has no content type entry`);
  return issues;
}

function summary(report: DeckLintReport, limit: number) {
  return { ok: report.ok, slides: report.slides, errors: report.errors, warnings: report.warnings, visualSlides: report.visualSlides, findings: report.findings.slice(0, limit), more: Math.max(0, report.findings.length - limit) };
}

export async function documentDeckBuild(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run");
  if (!writable(ctx)) return refused("permission_read_only", "building writes a new file; this run may not write");
  const target = str(args.path).trim();
  if (!path.isAbsolute(target)) return refused("path_not_absolute", "pass the absolute path of the new .pptx");
  const file = path.resolve(target);
  if (path.extname(file).toLowerCase() !== ".pptx") return refused("format_unsupported", "document.deck.build writes a .pptx; use document.create for docx, xlsx or hwpx");
  const folder = path.dirname(file);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return refused("folder_missing", folder);
  if (fs.existsSync(file)) {
    const digest = sha256(new Uint8Array(fs.readFileSync(file)));
    if (builtHere.get(file) !== digest) return refused("file_exists", "this port replaces only a deck it wrote itself; pick a new file name, or edit the existing deck with document.open and document.apply");
  }
  const run = await runDeckScript({ script: str(args.script), timeoutMs: DECK_TIMEOUT_DEFAULT_MS });
  if (!run.ok) {
    const next = run.code === "deck_runtime_unavailable" ? "this computer cannot run the deck sandbox; build the deck with document.create and document.apply instead"
      : run.code === "deck_runtime_failed" ? DECK_HOST_FAILURE_NEXT
      : run.code === "deck_script_failed" ? "fix the script and call document.deck.build again (the error names the line where one is known)"
      : run.code === "deck_script_timeout" ? "draw fewer elements or remove loops; the limit is 60 seconds" : undefined;
    return refused(run.code, next ? `${run.reason}. ${next}` : run.reason, { ...(run.cause ? { cause: run.cause } : {}), ...(run.line ? { line: run.line } : {}), ...(run.logs?.length ? { logs: run.logs } : {}), ...(run.isolation ? { isolation: run.isolation } : {}) });
  }
  if (run.bytes.length > DECK_OUTPUT_MAX_BYTES) return refused("deck_output_invalid", "the deck is larger than the 60 MB limit");
  const issues = validateDeckPackage(run.bytes);
  if (issues.length) return refused("deck_output_invalid", `PowerPoint may refuse this file: ${issues.join("; ")}. Fix the script and build again.`);
  let report: DeckLintReport;
  try { report = lintDeck(run.bytes); } catch (error) { return refused("deck_output_invalid", error instanceof Error ? error.message.slice(0, 200) : "the deck could not be read"); }
  // Write beside the target and rename: a reader never sees half a file.
  const staging = path.join(folder, `.${path.basename(file)}.agentlas-${process.pid}.tmp`);
  try {
    fs.writeFileSync(staging, run.bytes, { mode: 0o644 });
    fs.renameSync(staging, file);
  } catch (error) {
    try { fs.rmSync(staging, { force: true }); } catch { /* best effort */ }
    return refused("write_failed", error instanceof Error ? error.message.slice(0, 200) : "the file could not be written");
  }
  builtHere.set(file, sha256(run.bytes));
  if (builtHere.size > BUILT_LIMIT) builtHere.delete(builtHere.keys().next().value as string);
  let sessionId: string | undefined, openNote: string | undefined;
  try {
    const meta = await (await store()).openLiveDocument({ chatId: ctx.chatId, path: file });
    sessionId = meta.sessionId;
  } catch (error) { openNote = `the file is written but could not be opened in the Document tab (${(error as { reason?: string })?.reason ?? "open failed"}); document.open retries`; }
  return { status: "ok", produced: [file], data: {
    path: file, ...(sessionId ? { sessionId } : {}), ...(openNote ? { note: openNote } : {}), slides: report.slides, bytes: run.bytes.length, isolation: run.isolation, seconds: run.seconds,
    ...(run.logs.length ? { logs: run.logs } : {}), lint: summary(report, 12),
    next: `${run.logs.length ? "read logs first (pptxgenjs prints its repairs there); " : ""}${sessionId ? "document.render { sessionId } shows the slides and the boxes that overflow; " : ""}document.deck.lint lists every finding; fix the script and call document.deck.build again with the same path. Edits to the finished deck: document.apply.`,
  } };
}

export async function documentDeckLint(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  let file = str(args.path).trim();
  const sessionId = str(args.sessionId).trim();
  if (!file && sessionId) {
    try {
      const snapshot = await (await store()).liveDocumentSnapshot(sessionId);
      if (snapshot.meta.chatId !== ctx.chatId) return refused("session_not_in_this_chat", "document.list shows this conversation's sessions");
      file = snapshot.meta.path;
    } catch (error) { const reason = (error as { reason?: unknown })?.reason; return refused(typeof reason === "string" ? reason : "session_unknown"); }
  }
  if (!file) return refused("path_missing", "pass path (absolute) or sessionId");
  if (!path.isAbsolute(file)) return refused("path_not_absolute", "pass the absolute path of the .pptx");
  const resolved = path.resolve(file);
  if (path.extname(resolved).toLowerCase() !== ".pptx") return refused("format_unsupported", "document.deck.lint reads .pptx files");
  let bytes: Uint8Array;
  try {
    const info = fs.statSync(resolved);
    if (!info.isFile()) return refused("file_unreadable", "not a file");
    if (info.size > DECK_OUTPUT_MAX_BYTES) return refused("file_too_large", "larger than 60 MB");
    bytes = new Uint8Array(fs.readFileSync(resolved));
  } catch { return refused("file_missing", resolved); }
  try {
    const report = lintDeck(bytes);
    return { status: "ok", data: { path: resolved, ...report, next: report.ok ? "no errors; document.render shows how the slides look" : "fix the errors first (each finding says what and how), then lint again" } };
  } catch (error) { return refused("file_unreadable", error instanceof Error ? error.message.slice(0, 200) : "the deck could not be read"); }
}

