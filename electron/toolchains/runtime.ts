// Adaptive Toolchain runtime overlay — the only toolchain code on the graph hot path.
//
// Contract with run-graph (three calls per agent node):
//   const tc = beginNodeToolchain(...)      before the prompt is final
//   prompt += tc.promptBlock                 empty unless an approved overlay applies
//   tc.observeTool(ev.tool)                  for every tool event of the node
//   tc.finish({ resultFolder })              after the invocation returns or throws
//
// Every function here swallows its own failures. A crystallization is an
// acceleration, never a dependency: when anything is off the node runs exactly
// as it did before (tracing-JIT side exit back to the interpreter).

import fs from "node:fs";
import path from "node:path";

import {
  applyActiveObservation,
  applyShadowObservation,
  nodeDefinitionDigest,
  parseShellRead,
  shadowReadMatches,
  shellCommandOf,
  toolClassOf,
  type Crystallization,
  type ShadowObservation,
} from "../../shared/toolchain";
import type { WorkflowNode } from "../../shared/types";
import { revalidateInvocationWorkspaceBinding, type InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { agentRunCwd } from "../runtime/exec";
import { tryRecordRunEvent } from "../store/run-events";
import { TOOLCHAIN_NODE_DIGEST_EVENT, overlayEligibleNodes } from "./learner";
import { mutateToolchainState, readToolchainState, ToolchainStateConflict } from "./store";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BLOCK_CHARS = 8_000;

export interface NodeToolchainSession {
  /** Appended to the node prompt. Empty unless an approved overlay applied. */
  readonly promptBlock: string;
  observeTool(tool: { name?: string; args?: unknown; result?: unknown; isError?: boolean } | undefined): void;
  finish(input: { resultFolder?: string | null }): void;
}

const INERT: NodeToolchainSession = { promptBlock: "", observeTool: () => undefined, finish: () => undefined };

function normalizeRelative(target: string): string {
  return target.replace(/^\.\//, "");
}

/** Guarded host read: inside the folder (after symlinks), a regular bounded file. */
function readTail(folder: string, target: string, lines: number): { ok: true; text: string } | { ok: false; reasonCode: string } {
  try {
    const root = fs.realpathSync(folder);
    const file = fs.realpathSync(path.resolve(root, target));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reasonCode: "path_outside_folder" };
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reasonCode: "not_a_file" };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, reasonCode: "file_too_large" };
    const all = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    const text = all.slice(-Math.max(1, Math.min(lines, 200))).join("\n");
    return { ok: true, text: text.length > MAX_BLOCK_CHARS ? text.slice(text.length - MAX_BLOCK_CHARS) : text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reasonCode: code === "ENOENT" ? "file_missing" : "read_failed" };
  }
}

function update(automationId: string, crystallizationId: string, apply: (item: Crystallization) => Crystallization): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mutateToolchainState(automationId, (current) => {
        const index = current.crystallizations.findIndex((item) => item.id === crystallizationId);
        if (index < 0) return null;
        const next = apply(current.crystallizations[index]);
        if (next === current.crystallizations[index]) return null;
        const crystallizations = current.crystallizations.slice();
        crystallizations[index] = next;
        return { ...current, crystallizations };
      });
      return;
    } catch (error) {
      if (!(error instanceof ToolchainStateConflict)) return;
    }
  }
}

export function beginNodeToolchain(input: {
  runId: string;
  automationId: string;
  node: WorkflowNode;
  dryRun: boolean;
  workspaceBinding?: InvocationWorkspaceBinding | null;
}): NodeToolchainSession {
  try {
    if (input.dryRun) return INERT;
    if (!overlayEligibleNodes({ version: 1, nodes: [input.node], edges: [] }).length) return INERT;
    const nodeDigest = nodeDefinitionDigest(input.node);
    // Case identity for the learner (plan rule R8). A hash only — no prompt, no path.
    tryRecordRunEvent({ runId: input.runId, kind: TOOLCHAIN_NODE_DIGEST_EVENT, automationId: input.automationId,
      nodeId: input.node.id, payload: { nodeDigest } });
    const item = readToolchainState(input.automationId).crystallizations
      .find((entry) => entry.nodeDigest === nodeDigest && entry.kind === "state_file_read"
        && (entry.state === "shadow" || entry.state === "active"));
    if (!item) return INERT;

    let expectedFolder: string | null = null;
    try {
      expectedFolder = (input.workspaceBinding ? revalidateInvocationWorkspaceBinding(input.workspaceBinding) : null) ?? agentRunCwd();
    } catch {
      expectedFolder = null;
    }
    const target = normalizeRelative(item.target);
    const folderAgrees = Boolean(item.folder && expectedFolder && item.folder === expectedFolder);
    const read = folderAgrees ? readTail(item.folder as string, target, item.lines ?? 10) : null;
    const guardFailure = !folderAgrees ? (item.folder ? "folder_changed" : "folder_unknown")
      : read && !read.ok ? read.reasonCode : null;

    let agentResult: string | null = null;
    let agentReread = false;
    let promptBlock = "";
    if (item.state === "active" && read?.ok) {
      promptBlock = [
        "",
        "",
        `[Agentlas Toolchain — read by the host just before this step]`,
        `The last ${item.lines ?? 10} lines of ${target} are below. Use them instead of reading the file again; read it yourself only if you need more than this.`,
        `--- ${target} (last ${item.lines ?? 10} lines) ---`,
        read.text,
        `--- end ---`,
      ].join("\n");
    }

    return {
      promptBlock,
      observeTool(tool) {
        try {
          if (!tool?.name || tool.result === undefined || tool.isError) return;
          if (toolClassOf(tool.name, tool.args) !== "shell_read") return;
          const shellRead = parseShellRead(shellCommandOf(tool.args));
          if (!shellRead || normalizeRelative(shellRead.path) !== target) return;
          agentReread = true;
          if (agentResult === null) agentResult = typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result);
        } catch { /* observation is advisory */ }
      },
      finish({ resultFolder }) {
        try {
          const observedFolder = typeof resultFolder === "string" && resultFolder ? resultFolder : null;
          const now = new Date().toISOString();
          if (item.state === "shadow") {
            let observation: ShadowObservation;
            if (guardFailure || !read?.ok) observation = "unavailable";
            else if (observedFolder && observedFolder !== item.folder) observation = "unavailable";
            else if (agentResult === null) observation = "not_read";
            else observation = shadowReadMatches(read.text, agentResult) ? "match" : "mismatch";
            update(input.automationId, item.id, (current) => {
              let next = applyShadowObservation(current, observation, now);
              if (observedFolder && observedFolder !== current.folder) {
                // Environment changed: learn the new folder, restart the streak.
                next = { ...next, folder: observedFolder, shadow: { ...next.shadow, consecutiveMatches: 0 }, updatedAt: now };
              }
              return next;
            });
            tryRecordRunEvent({ runId: input.runId, kind: "toolchain_shadow_compare", automationId: input.automationId,
              nodeId: input.node.id, payload: { crystallizationId: item.id, observation, ...(guardFailure ? { reasonCode: guardFailure } : {}) } });
            return;
          }
          // active
          const injected = promptBlock.length > 0;
          const fallbackReason = !injected ? guardFailure ?? "read_failed"
            : observedFolder && observedFolder !== item.folder ? "folder_changed" : null;
          update(input.automationId, item.id, (current) => applyActiveObservation(current,
            fallbackReason ? { kind: "fallback", reasonCode: fallbackReason } : { kind: "applied", agentReread }, now));
          tryRecordRunEvent({ runId: input.runId, kind: fallbackReason ? "toolchain_fallback" : "toolchain_overlay_applied",
            automationId: input.automationId, nodeId: input.node.id,
            payload: { crystallizationId: item.id, ...(fallbackReason ? { reasonCode: fallbackReason } : { agentReread }) } });
        } catch { /* learning must never fail a node */ }
      },
    };
  } catch {
    return INERT;
  }
}
