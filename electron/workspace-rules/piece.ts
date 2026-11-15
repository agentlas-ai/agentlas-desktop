import path from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeKind } from "../../shared/types";
import { workspaceRulesLimits, type ClassificationRules } from "../../shared/memory-classification";
import { cutAtLineBoundary, readWorkspaceRules, type WorkspaceRulesFileState } from "./file";

/*
 * The prompt module `workspace.rules`: what the owner's rules file puts into a turn.
 *
 *   id workspace.rules, revision 1, stability versioned-content, change cause workspace-rules, channel desktop.main.turn-context.collector, place: right before project.instructions
 *
 * The frame is exactly this (no path, no time, no JSON, no instruction sentence of its own; the same text gives the same bytes):
 *
 *   [Workspace rules <first 12 hex of the sha256 of the text>; replaces earlier copies]
 *   <the text without its closed block comments>
 *   [/Workspace rules]
 *
 * A file that is missing or unreadable gives no piece. A file that is there and holds nothing gives the body `(none)`, so a session that follows an earlier copy stops following a rule the owner removed.
 * The text is the first `loadMaxBytes` (4,096) of the file, at a line boundary; a runtime that sends the piece again every turn gets the first `smallWindowMaxBytes` (1,024).
 * This file never reads the switch and never decides who gets the piece: `loadsWorkspaceRules` (scope.ts) does, and the caller asks it first.
 * No Electron import (the background service and the gates load it).
 */

export const WORKSPACE_RULES_FILE_NAME = "WORKSPACE.md";
/** The module declaration (the composition ledger registers it from here; mcp/client.ts declares the same id, lifetime and cause at its collector slot, where the gates need literals). */
export const WORKSPACE_RULES_MODULE = { id: "workspace.rules", revision: 1, stability: "versioned-content", changeTriggers: ["workspace-rules"] } as const;

/**
 * Runtimes whose adapter sends the collector's kept blocks again on every turn (they do not read `turnContextStable`, or send the context in front of the user message each turn):
 * kimi, grok, cursor, and every API or local runtime. Claude Code, Codex, Antigravity and an ACP agent keep the piece in their session and take it again only when its text changed.
 * Measured with the capture harness (second turn, every kind) and read in `runtime/kimi.ts`, `grok.ts`, `cursor.ts`, `serving-prefix.ts`.
 */
const RESENT_EVERY_TURN: ReadonlySet<string> = new Set<RuntimeKind>(["kimi", "grok", "cursor", "byok", "agentlas", "agentlas-local", "ollama", "lmstudio", "mlx"]);
export function workspaceRulesResentEveryTurn(kind: string | null | undefined): boolean { return typeof kind === "string" && RESENT_EVERY_TURN.has(kind); }

export function workspaceRulesFilePath(memoryStorePath: string): string { return path.join(path.dirname(memoryStorePath), WORKSPACE_RULES_FILE_NAME); }

export interface WorkspaceRulesPiece { text: string | null; state: WorkspaceRulesFileState; fingerprint: string; loadedBytes: number }

/** The frame around an already cut body. */
export function frameWorkspaceRules(body: string): { text: string; fingerprint: string } {
  const fingerprint = createHash("sha256").update(body, "utf8").digest("hex");
  return { text: `[Workspace rules ${fingerprint.slice(0, 12)}; replaces earlier copies]\n${body}\n[/Workspace rules]`, fingerprint };
}

/** Reads the file and frames it for a runtime. Never throws; a failure is `{ text: null, state: "rules_unreadable" }`. */
export function buildWorkspaceRulesPiece(memoryStorePath: string, runtimeKind: string | null | undefined, rules: ClassificationRules | null): WorkspaceRulesPiece {
  try {
    const limits = workspaceRulesLimits(rules);
    const read = readWorkspaceRules(workspaceRulesFilePath(memoryStorePath), { loadMaxBytes: limits.loadMaxBytes, readMaxBytes: limits.readMaxBytes });
    if (read.state === "missing" || read.state === "rules_unreadable") return { text: null, state: read.state, fingerprint: "", loadedBytes: 0 };
    if (read.state === "empty") { const framed = frameWorkspaceRules("(none)"); return { text: framed.text, state: "empty", fingerprint: framed.fingerprint, loadedBytes: 0 }; }
    const window = workspaceRulesResentEveryTurn(runtimeKind) ? Math.min(limits.smallWindowMaxBytes, limits.loadMaxBytes) : limits.loadMaxBytes;
    const body = cutAtLineBoundary(read.text, window).text;
    if (!body.trim()) { const framed = frameWorkspaceRules("(none)"); return { text: framed.text, state: "empty", fingerprint: framed.fingerprint, loadedBytes: 0 }; }
    const framed = frameWorkspaceRules(body);
    return { text: framed.text, state: "ok", fingerprint: framed.fingerprint, loadedBytes: Buffer.byteLength(body, "utf8") };
  } catch {
    return { text: null, state: "rules_unreadable", fingerprint: "", loadedBytes: 0 };
  }
}
