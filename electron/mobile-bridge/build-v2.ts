import { buildKeyOfTurn, headRecordOf, listBuilds, openBuild, readBuildFileOf, type WorkbenchEnv } from "../hephaestus/build-workbench";
import { filesOfBuild, previewPorts as realPreviewPorts } from "../hephaestus/build-workbench-ipc";
import { previewBusy, previewMessages, previewRestart, previewSend, type PreviewPorts } from "../hephaestus/build-preview";
import { buildIdOfExternalRun } from "../hephaestus/build-turn-tracked";
import { sanitizeMobileBridgeText } from "./sanitize";
import { MOBILE_BUILD_V2_LIMITS as LIMITS, validateMobileBuildV2Params, type MobileBuildV2Method } from "../../shared/mobile-build-v2";
import type { BuildListItem, BuildWorkbenchRefusal } from "../../shared/build-workbench";

/*
 * Phone reads of the saved Builds (build2.list / build2.open / build2.files / build2.file.read; contracts/mobile-bridge-2.0.md section 9), and since PB-D the Preview of the agent
 * being built (build2.preview.send / restart / read) and "which Build is my run" (build2.forRun), contracts/phone-build2.md. Preview is the Build window's own: the same
 * session in the same memory, the same `previewSend` with the same ports (hephaestus/build-workbench-ipc.ts `previewPorts`), nothing remembered (hephaestus/build-preview.ts). A projection over
 * what the Build window already keeps (hephaestus/build-workbench.ts: `listBuilds`, `openBuild`, the file tree and the file reader, the same functions): no table,
 * no copy, no timer, no model call. Every answer is read when asked and bounded. Text goes through the bridge's own redaction (a path or a key-like word is masked
 * in place), so no answer carries the Build folder's path; the folder, its grant and the runtime are not fields of any answer here.
 *
 * A refusal is `{ ok:false, code }`, a BuildWorkbenchRefusal machine code and never a sentence (the Build window's `detail` is dropped). The checks of "which file may be
 * read" are the Build window's (hephaestus/build-scope.ts): a relative portable path, every part looked at with lstat, a link followed only to a place inside the folder,
 * the real path inside the real folder, private files not served.
 * No Electron import: the daemon hosts the phone bridge too (there `env()` is null: the answer is `owner_unavailable`).
 */

export interface BuildV2Deps {
  /** The Build window's environment, or null when this process does not hold it (the background service). */
  env(): Promise<WorkbenchEnv | null>;
  /** The Preview ports of the window (default: the real ones); a gate passes a fake runner. */
  previewPorts?: (env: WorkbenchEnv, runtimeOverride: unknown, stored: boolean) => Promise<PreviewPorts>;
}

type Json = Record<string, unknown>;
const refuse = (code: BuildWorkbenchRefusal): { ok: false; code: BuildWorkbenchRefusal } => ({ ok: false, code });

/** Display text: redacted by the bridge's own rules and cut by characters. Line fields are also flattened to one line. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string" || !value) return "";
  const clean = sanitizeMobileBridgeText(value, max * 4 + 16).replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}
/** Message / file text: redacted, line breaks kept, never cut by the redaction itself (the callers bound the size before). */
function body(value: string): string {
  return sanitizeMobileBridgeText(value, Buffer.byteLength(value, "utf8") * 2 + 64);
}

function itemOf(item: BuildListItem): Json {
  return {
    id: item.id, kind: item.kind, title: line(item.title, LIMITS.lineTextMax), lastLine: line(item.lastLine, LIMITS.lineTextMax), state: item.state,
    progress: item.progress, questionCount: item.questionCount, agentId: item.agentId, name: item.name === null ? null : line(item.name, 80),
    hasPendingAvatar: item.hasPendingAvatar, folderAvailable: item.folderAvailable, createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

/** The newest Preview messages that fit one answer (the same byte budget as `build2.open`); the order shown is the conversation's. */
function previewMessagesOf(buildKey: string): Array<{ role: "user" | "assistant"; text: string; at: string }> {
  const all = previewMessages(buildKey);
  const out: Array<{ role: "user" | "assistant"; text: string; at: string }> = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const message = all[i]!;
    const chars = Array.from(message.text);
    const cut = chars.length > LIMITS.messageCharsMax;
    const text = body(cut ? chars.slice(0, LIMITS.messageCharsMax).join("") : message.text);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > LIMITS.messagesBytesMax && out.length > 0) break;
    out.unshift({ role: message.role, text: cut ? `${text}…` : text, at: message.at });
  }
  return out;
}

export function createBuildV2(deps: BuildV2Deps): { call(method: string, args: unknown): Promise<Json> } {
  return {
    async call(method, rawArgs) {
      const params = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Json : {};
      // The same closed check the wire parser ran, again here: an in-process caller meets the same rule.
      const problem = validateMobileBuildV2Params(method, params);
      if (problem) throw new TypeError(`${method}: ${problem}`);
      let env: WorkbenchEnv | null;
      try { env = await deps.env(); } catch { return refuse("owner_unavailable"); }
      if (!env) return refuse("owner_unavailable");
      try {
        switch (method as MobileBuildV2Method) {
          case "build2.forRun": {
            // The saved Build of a run this Desktop started for the phone (the phone's own run id is not a saved turn's id: hephaestus/build-turn-tracked.ts keeps the pairing in memory).
            const buildId = buildIdOfExternalRun(params.runId as string);
            const key = buildId ? buildKeyOfTurn(env, buildId) : null;
            return key ? { ok: true, buildKey: key } : refuse("build_not_found");
          }
          case "build2.preview.read":
            return { ok: true, messages: previewMessagesOf(params.buildKey as string), busy: previewBusy(params.buildKey as string) };
          case "build2.preview.restart":
            previewRestart(params.buildKey as string);
            return { ok: true };
          case "build2.preview.send": {
            const buildKey = params.buildKey as string;
            // The runtime is the build's saved one; a saved runtime that is gone falls back to the active one (`stored`), exactly as the window's send does.
            const record = headRecordOf(env, buildKey);
            const ports = await (deps.previewPorts ?? realPreviewPorts)(env, record?.runtime ?? undefined, true);
            const answer = await previewSend(ports, buildKey, params.text);
            if (!answer.ok) return refuse(answer.code);
            const chars = Array.from(answer.reply);
            return { ok: true, reply: body(chars.length > LIMITS.messageCharsMax ? `${chars.slice(0, LIMITS.messageCharsMax).join("")}…` : answer.reply) };
          }
          case "build2.list": {
            const page = listBuilds(env, { cursor: params.cursor, limit: params.limit ?? LIMITS.listDefault });
            return { ok: true, items: page.items.map(itemOf), next: page.nextCursor };
          }
          case "build2.open": {
            // readOnly: a phone's read does not move the pointer the Desktop's Build window resumes from.
            const opened = openBuild(env, params.buildKey, { readOnly: true });
            if (!opened.ok) return refuse(opened.code);
            const source = opened.opened;
            // The newest messages win the byte budget; the order shown is the conversation's.
            const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
            let bytes = 0, truncated = source.messagesTruncated;
            for (let i = source.messages.length - 1; i >= 0; i -= 1) {
              const message = source.messages[i]!;
              const chars = Array.from(message.text);
              const cut = chars.length > LIMITS.messageCharsMax;
              const text = body(cut ? chars.slice(0, LIMITS.messageCharsMax).join("") : message.text);
              bytes += Buffer.byteLength(text, "utf8");
              if (bytes > LIMITS.messagesBytesMax && messages.length > 0) { truncated = true; break; }
              messages.unshift({ role: message.role, text: cut ? `${text}…` : text });
            }
            return {
              ok: true, build: itemOf(source.build), messages, messagesTruncated: truncated, turnDefaults: { mode: source.turnDefaults.mode },
              continuable: source.continuable, continuableReason: source.continuableReason,
            };
          }
          case "build2.files": {
            const tree = await filesOfBuild(env, params.buildKey);
            if (!tree.ok) return refuse(tree.code);
            return { ok: true, nodes: tree.nodes.map((node) => ({ path: node.path, type: node.type, state: node.state, size: node.size })), truncated: tree.truncated };
          }
          default: {
            const read = readBuildFileOf(env, params.buildKey, params.path, params.sinceLine);
            if (!read.ok) return refuse(read.code);
            const file = read.file;
            const content = file.binary ? "" : body(file.content);
            return { ok: true, file: { path: file.path, content, byteLength: file.byteLength, lineCount: file.lineCount, binary: file.binary, truncated: file.truncated, startLine: file.startLine } };
          }
        }
      } catch {
        // A store that cannot be read is a code (the phone words it); the Desktop's log has the cause where the window's channels log it.
        return refuse("owner_unavailable");
      }
    },
  };
}
