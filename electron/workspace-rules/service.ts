import path from "node:path";
import { getMemoryDb, memoryRoot, memoryStorePath, activeMemoryOwnerNamespace } from "../memory/database";
import { memoryClassificationRules, workspaceRulesOn } from "../memory/classification";
import { workspaceRulesLimits } from "../../shared/memory-classification";
import {
  WORKSPACE_RULES_PICK_META_KEY, WORKSPACE_RULES_PICK_RANK,
  type WorkspaceRulesAccountKind, type WorkspaceRulesAddPickedResult, type WorkspaceRulesCandidates, type WorkspaceRulesOpenResult, type WorkspaceRulesPickNotice, type WorkspaceRulesStatus, type WorkspaceRulesWriteResult,
} from "../../shared/workspace-rules";
import { clearWorkspaceRules, lookAtRulesFile, readWorkspaceRules, rulesLoadView, saveWorkspaceRules, updateWorkspaceRules, type RulesUpdateResult } from "./file";
import { collectCandidates, fileLineKeys, ruleLineKey } from "./candidates";
import { workspaceRulesFilePath } from "./piece";

/*
 * "My rules" for the renderer (Agentlas 2.0 P4; and 6): the state of the owner's rules file, its writes, and the one-time pick list. Called by the six renderer-only channels in ipc.ts and by nothing else.
 *
 * WHO WRITES THE FILE: only `saveWorkspaceRules`, `clearWorkspaceRules` and `updateWorkspaceRules` in file.ts, and this file calls them from exactly three places: `workspaceRulesSave`, `workspaceRulesClear`
 * and `workspaceRulesAddPicked`, each an owner action behind an IPC channel. The pick list (`candidates.ts`) only reads stored lines. No agent, tool, hook, migration step or timer reaches any of them.
 * WHO WRITES THE PICK STATE: `workspaceRulesAddPicked` (`done`) and `workspaceRulesPickNotice` (`offered` / `dismissed`), one row `workspace_rules_pick` of the owner's root `memory_store_meta` (no new table or column).
 * Read by `workspaceRulesGet` only; the row goes when that owner's memory store is deleted (the store is one file in the owner folder).
 *
 * THE OWNER: the folder and the pick row are those of the memory owner at the moment of the call (`activeMemoryOwnerNamespace`). The fingerprint a screen holds carries the owner, so after an account switch a save made from
 * the other account's screen is refused (`rules_changed`) instead of landing in this account's file. Signed out is an owner of its own (`signed-out:`), as is a machine with no account (`device-local:`).
 *
 * Switch off: everything here still works (the screen can show and edit the file); `state: "off"` tells the screen that no turn loads it yet.
 */

export interface WorkspaceRulesDeps {
  /** The signed-in account's label (email, else name), "" when nobody is signed in. The first account on a machine inherits the machine-wide (device-local) folder, so the label is the session's, not the folder kind's. */
  accountLabel: () => string;
  /** An agent's display name from its id. */
  agentName: (agentId: string | null) => string;
  /** Asks the computer to open a file in its own program; resolves to "" when it did, else the system's refusal text (Electron's `shell.openPath`). Main only; a gate supplies a fake. */
  openPath: (file: string) => Promise<string>;
}
let deps: WorkspaceRulesDeps = { accountLabel: () => "", agentName: (id) => id ?? "", openPath: async (file) => (require("electron") as typeof import("electron")).shell.openPath(file) }; // eslint-disable-line @typescript-eslint/no-require-imports
/** The Electron side supplies the account and the agent registry (ipc.ts); a gate may supply fakes. */
export function configureWorkspaceRules(next: Partial<WorkspaceRulesDeps>): void { deps = { ...deps, ...next }; }

interface Env { file: string; ownerKey: string; ownerNamespace: string; accountKind: WorkspaceRulesAccountKind }

function resolveEnv(): Env {
  const ownerNamespace = activeMemoryOwnerNamespace();
  const store = memoryStorePath(ownerNamespace);
  return {
    file: workspaceRulesFilePath(store),
    ownerKey: path.basename(path.dirname(store)),
    ownerNamespace,
    accountKind: ownerNamespace.startsWith("signed-out:") ? "signed-out" : ownerNamespace.startsWith("device-local:") ? "device-local" : "account",
  };
}

const NOTICES: readonly WorkspaceRulesPickNotice[] = ["none", "offered", "dismissed", "done"];
function readPickNotice(): WorkspaceRulesPickNotice {
  try {
    const row = getMemoryDb().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(WORKSPACE_RULES_PICK_META_KEY) as { value?: string } | undefined;
    return (NOTICES as readonly string[]).includes(row?.value ?? "") ? row!.value as WorkspaceRulesPickNotice : "none";
  } catch { return "none"; }
}
/** Moves the "shown once" state forward only (none < offered < dismissed < done); a lower or equal value changes nothing. */
function raisePickNotice(to: WorkspaceRulesPickNotice): WorkspaceRulesPickNotice {
  const now = readPickNotice();
  if (WORKSPACE_RULES_PICK_RANK[to] <= WORKSPACE_RULES_PICK_RANK[now]) return now;
  try {
    getMemoryDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(WORKSPACE_RULES_PICK_META_KEY, to);
    return to;
  } catch { return now; }
}

function candidatesFor(env: Env, fileText: string): WorkspaceRulesCandidates {
  const rules = memoryClassificationRules();
  try {
    return collectCandidates({ rootDb: getMemoryDb(), memoryRoot: memoryRoot(), owner: env.ownerNamespace, limits: workspaceRulesLimits(rules), rules, fileText, nameOf: (id) => { try { return deps.agentName(id); } catch { return id ?? ""; } } });
  } catch { return { personal: [], heard: [] }; }
}

export function workspaceRulesGet(): WorkspaceRulesStatus {
  const env = resolveEnv();
  const rules = memoryClassificationRules();
  const limits = workspaceRulesLimits(rules);
  const read = readWorkspaceRules(env.file, { loadMaxBytes: limits.loadMaxBytes, readMaxBytes: limits.readMaxBytes });
  const look = lookAtRulesFile(env.file, env.ownerKey);
  const picks = candidatesFor(env, look.text);
  const pickNotice = readPickNotice();
  let label = "";
  try { label = String(deps.accountLabel() ?? ""); } catch { label = ""; }
  return {
    state: (() => { try { return workspaceRulesOn() && rules !== null ? "on" : "off"; } catch { return "off"; } })(),
    accountKind: env.accountKind, accountLabel: label,
    fileState: read.state, text: look.text, fingerprint: look.fingerprint,
    bytes: read.bytes, loadedBytes: read.loadedBytes, overflowLines: read.overflowLines,
    loadMaxBytes: limits.loadMaxBytes, smallWindowMaxBytes: limits.smallWindowMaxBytes,
    editable: look.kind === "text" || look.kind === "missing", clearable: look.kind !== "unsafe",
    candidatesAvailable: picks.personal.length + picks.heard.length,
    seeded: pickNotice === "done", pickNotice,
  };
}

const asResult = (result: RulesUpdateResult): WorkspaceRulesWriteResult => (result.ok ? { ok: true, fingerprint: result.fingerprint } : { ok: false, code: result.code });

function assertBase(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_rules_input_invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key)) || typeof value.baseFingerprint !== "string" || value.baseFingerprint.length > 128) throw new Error("workspace_rules_input_invalid");
  return value;
}

/** The owner saved the whole text. */
export async function workspaceRulesSave(input: unknown): Promise<WorkspaceRulesWriteResult> {
  const value = assertBase(input, ["text", "baseFingerprint"]);
  if (typeof value.text !== "string") throw new Error("workspace_rules_input_invalid");
  const env = resolveEnv();
  return asResult(await saveWorkspaceRules(env.file, env.ownerKey, value.text, value.baseFingerprint));
}

/** The owner emptied the file (it stays, empty: a turn says "(none)"). */
export async function workspaceRulesClear(input: unknown): Promise<WorkspaceRulesWriteResult> {
  const value = assertBase(input, ["baseFingerprint"]);
  const env = resolveEnv();
  return asResult(await clearWorkspaceRules(env.file, env.ownerKey, value.baseFingerprint));
}

export function workspaceRulesCandidates(): WorkspaceRulesCandidates {
  const env = resolveEnv();
  return candidatesFor(env, lookAtRulesFile(env.file, env.ownerKey).text);
}

/** The owner picked lines: each goes to the END of the file as one line, only if it still loads (`rules_full` otherwise) and is not already there. The stored lines are not touched. */
export async function workspaceRulesAddPicked(input: unknown): Promise<WorkspaceRulesAddPickedResult> {
  const value = assertBase(input, ["ids", "baseFingerprint"]);
  const limits = workspaceRulesLimits(memoryClassificationRules());
  if (!Array.isArray(value.ids) || value.ids.length > limits.candidateMaxLines * 2 || value.ids.some((id) => typeof id !== "string" || !id || id.length > 200)) throw new Error("workspace_rules_input_invalid");
  const ids = [...new Set(value.ids as string[])];
  const env = resolveEnv();
  const pre = lookAtRulesFile(env.file, env.ownerKey);
  const offered = candidatesFor(env, pre.text);
  const byId = new Map<string, string>();
  for (const row of [...offered.personal, ...offered.heard]) byId.set(row.id, row.text);
  let added = 0, alreadyThere = 0, unknown = 0;
  const result = await updateWorkspaceRules(env.file, env.ownerKey, value.baseFingerprint, (look) => {
    // The file must be what the candidates were computed against; if it moved since, the screen reads again.
    if (look.kind === "text" ? look.text !== pre.text : pre.kind !== "missing") return { code: "rules_changed" };
    added = 0; alreadyThere = 0; unknown = 0;
    const have = fileLineKeys(look.text);
    const lines: string[] = [];
    for (const id of ids) {
      const text = byId.get(id);
      if (text === undefined) { unknown += 1; continue; }
      const key = ruleLineKey(text);
      if (have.has(key)) { alreadyThere += 1; continue; }
      have.add(key); lines.push(text);
    }
    if (!lines.length) return { text: look.text };
    const head = look.text && !look.text.endsWith("\n") ? `${look.text}\n` : look.text;
    const next = `${head}${lines.join("\n")}\n`;
    // "Added but not loaded" is never produced: the whole text, with the new lines, must fit the load cap.
    if (rulesLoadView(next, limits.loadMaxBytes).bodyBytes > limits.loadMaxBytes) return { code: "rules_full" };
    added = lines.length;
    return { text: next };
  });
  if (!result.ok) return { ok: false, code: result.code };
  if (added > 0) raisePickNotice("done");
  return { ok: true, fingerprint: result.fingerprint, added, alreadyThere, unknown };
}

/**
 * The owner pressed [Open file]: this computer's own editor opens the rules file. Reads nothing into the answer and writes nothing: the editor is another program and may save the file as it likes
 * (the next `get` then reads what it wrote, and a save made from an older screen is refused with `rules_changed`). Only a regular file is opened, never a link, a folder or a device.
 */
export async function workspaceRulesOpenFile(): Promise<WorkspaceRulesOpenResult> {
  const env = resolveEnv();
  const look = lookAtRulesFile(env.file, env.ownerKey);
  if (look.kind === "missing") return { ok: false, code: "rules_file_missing" };
  if (look.kind === "unsafe") return { ok: false, code: "rules_unreadable" };
  try { return (await deps.openPath(env.file)) === "" ? { ok: true } : { ok: false, code: "rules_open_failed" }; }
  catch { return { ok: false, code: "rules_open_failed" }; }
}

/** The pick notice was shown (`offered`) or the owner closed it (`dismissed`). Forward only; `done` is set by picking. */
export function workspaceRulesPickNotice(input: unknown): { pickNotice: WorkspaceRulesPickNotice } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => k !== "state") || !["offered", "dismissed"].includes(String((input as { state?: unknown }).state))) throw new Error("workspace_rules_input_invalid");
  resolveEnv();
  return { pickNotice: raisePickNotice((input as { state: WorkspaceRulesPickNotice }).state) };
}
