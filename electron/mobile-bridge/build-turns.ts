// The phone's Build turns (Agentlas 2.0 PB-D, contracts/phone-build2.md sections 2 and 4): a new Build, the answer to an interview, and the continuation of a saved Build all run
// as a TRACKED Build turn (hephaestus/build-turn-tracked.ts), the same function the Build window's `hephaestus:build` runs. So a phone Build is a Build of the list (it has a
// Build key and a saved conversation row), it cannot run beside the window's Build, and its "n/6" is the window's.
//
// This file only ASSEMBLES the turn. What the model reads is not decided here: a new Build sends the owner's words as before, an interview answer sends the answer text the bridge built,
// and a continuation carries the saved conversation by `planPhoneBuildTurn` (shared/build-turn.ts, the Build screen's own restore). Nothing here parses a person's words.
//
// No Electron import (the folder grant, the workspace folder and the environment arrive as dependencies), so a gate drives it with a fake runner and a temp database.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { FsPathGrant, HephaestusBuildEvent, HephaestusBuildRequest } from "../../shared/types";
import { planPhoneBuildTurn } from "../../shared/build-turn";
import { buildKeyOfTurn, headRecordOf, openBuild, type WorkbenchEnv } from "../hephaestus/build-workbench";
import { activeBuilds, buildIdOfExternalRun, noteExternalRun, runTrackedBuildTurn, type TrackedBuildDeps } from "../hephaestus/build-turn-tracked";
import { readBuilderConversation } from "../hephaestus/builder-conversation-store";
import { transferMobileBuildInterviewWitness } from "../hephaestus/mobile-interview-witness";

/** The words a refused continuation answers with (`build.start` `refusal.code`): BuildWorkbenchRefusal words, plus `another_build_active` and the new `build_changed`. */
export type PhoneBuildContinueRefusal =
  | "build_not_found" | "folder_unavailable" | "owner_unavailable" | "build_turn_active" | "another_build_active" | "agent_running" | "root_move_active" | "build_changed";

/** A refusal found while a turn was being assembled (after the phone had its answer): the run ends as failed, the word is in the log. */
export class PhoneBuildTurnError extends Error {
  constructor(readonly code: PhoneBuildContinueRefusal | "build_unavailable") { super(code); this.name = "PhoneBuildTurnError"; }
}

/** What the bridge hands `buildActions.run` (cloud-actions.ts `MobileBridgeBuildRunInput`, structurally). */
export interface PhoneBuildRunInput {
  runId: string;
  goal: string;
  locale: "ko" | "en";
  sink: (event: HephaestusBuildEvent) => void;
  signal: AbortSignal;
  workspace?: string;
  runtimeSessionId?: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  attachments?: Array<{ path: string; name: string }>;
  mode?: "single" | "team" | "package";
  continueBuild?: { buildKey: string; seenUpdatedAt: string };
}

export interface PhoneBuildTurnsDeps {
  /** The window's environment with the folder grant (hephaestus/build-workbench-ipc.ts `phoneBuildTurnEnv`); null = this process has no Build window backend. */
  turnEnv(): Promise<WorkbenchEnv | null>;
  /** The deps the window's turn runs with (registered by ipc.ts); null = none. */
  trackedDeps(): TrackedBuildDeps | null;
  /** "agent_running" / "root_move_active" while the agent of an Edit is busy; null = free (hephaestus/build-workbench-ipc.ts `buildTurnRefusal`). */
  agentBusy(folder: string): Promise<"agent_running" | "root_move_active" | null>;
  /** A fresh folder for a new phone Build (`Documents/Agentlas Mobile Builds/...`). */
  createWorkspace(signal?: AbortSignal): Promise<string>;
  grantFolder(folder: string): FsPathGrant;
  grantFile(file: string): FsPathGrant;
  newId(): string;
}

const sameFolder = (a: string, b: string): boolean => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return a === b; } };
/** The reviewed-empty MCP plan a phone Build always uses: it never auto-connects MCP servers (cloud-actions.ts header). A fresh plan id each time. */
const emptyMcpConsent = (): HephaestusBuildRequest["mcpConsent"] => ({ planId: `renderer-mcp-unavailable-mobile-${randomUUID()}`, selectedCandidateIds: [], fallbackReason: "recommendation_unavailable" });

export function createPhoneBuildTurns(deps: PhoneBuildTurnsDeps) {
  /** Is anything a Build turn running (the window's or a phone's)? The same registry the window's "BUILD_ALREADY_ACTIVE" reads. */
  const anyBuildActive = (): boolean => activeBuilds.size > 0;

  /**
   * Before anything starts or is recorded: may this phone continue this Build now? null = yes. The order is fixed (the first that holds is the answer):
   * not found, folder gone, THIS Build is running, ANOTHER Build is running, the Build moved on since the phone saw it, the agent of an Edit is busy.
   */
  async function precheckContinue(input: { buildKey: string; seenUpdatedAt: string }): Promise<PhoneBuildContinueRefusal | null> {
    let env: WorkbenchEnv | null;
    try { env = await deps.turnEnv(); } catch { return "owner_unavailable"; }
    if (!env) return "owner_unavailable";
    try {
      // readOnly: checking must not move the pointer the window resumes from.
      const opened = openBuild(env, input.buildKey, { readOnly: true });
      if (!opened.ok) return opened.code === "build_not_found" ? "build_not_found" : "owner_unavailable";
      const build = opened.opened;
      if (build.continuableReason === "folder_unavailable") return "folder_unavailable";
      if (env.isRunning(build.folder)) return "build_turn_active";
      if (env.anyBuildActive() || anyBuildActive()) return "another_build_active";
      if (build.build.updatedAt !== input.seenUpdatedAt) return "build_changed";
      return await deps.agentBusy(build.folder);
    } catch { return "owner_unavailable"; }
  }

  async function assembleContinue(input: PhoneBuildRunInput, continuation: { buildKey: string; seenUpdatedAt: string }): Promise<{ req: Omit<HephaestusBuildRequest, "clientRunId">; skipMcpApply: boolean }> {
    const refusal = await precheckContinue(continuation);
    if (refusal) throw new PhoneBuildTurnError(refusal);
    const env = await deps.turnEnv();
    if (!env) throw new PhoneBuildTurnError("owner_unavailable");
    // The window's own open: it records the folder alias, makes the folder grant and moves the resume pointer to this Build's newest row.
    const opened = openBuild(env, continuation.buildKey);
    if (!opened.ok) throw new PhoneBuildTurnError(opened.code === "build_not_found" ? "build_not_found" : "owner_unavailable");
    const build = opened.opened;
    const record = headRecordOf(env, continuation.buildKey);
    const grant = build.workspaceGrant as FsPathGrant | null;
    if (!record || !grant) throw new PhoneBuildTurnError(record ? "folder_unavailable" : "build_not_found");
    const plan = planPhoneBuildTurn({ saved: record, agentLinked: build.turnDefaults.mode === "package", sessionResumable: build.sessionResumable });
    // A runtime session is carried only when the saved row can prove it (its runtime was recorded) and the folder is where that session ran.
    const carry = plan.carrySession && Boolean(record.runtimeSessionId) && record.runtime !== null && sameFolder(record.workspace, build.folder);
    return {
      skipMcpApply: carry,
      req: {
        request: input.goal,
        workspaceGrant: grant,
        mcpConsent: emptyMcpConsent(),
        runtimePinned: carry,
        locale: input.locale,
        ...(plan.history.length > 0 ? { history: plan.history } : {}),
        ...(plan.mode ? { mode: plan.mode } : {}),
        ...(carry ? { runtimeSessionId: record.runtimeSessionId!, runtime: record.runtime! } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments.map((file) => ({ grant: deps.grantFile(file.path), name: file.name })) } : {}),
      },
    };
  }

  async function assembleAnswer(input: PhoneBuildRunInput): Promise<{ req: Omit<HephaestusBuildRequest, "clientRunId">; skipMcpApply: boolean }> {
    const workspace = input.workspace!;
    let carry: { runtimeSessionId: string; runtime: NonNullable<HephaestusBuildRequest["runtime"]> } | null = null;
    const previousId = buildIdOfExternalRun(input.runId);
    let env: WorkbenchEnv | null = null;
    try { env = await deps.turnEnv(); } catch { env = null; }
    const previous = previousId && env ? readBuilderConversation(env.db, env.owner, previousId) : null;
    if (previous && env && input.runtimeSessionId && previous.runtimeSessionId === input.runtimeSessionId && previous.runtime
      && (previous.status === "waiting-user" || previous.status === "completed") && sameFolder(previous.workspace, workspace)) {
      carry = { runtimeSessionId: input.runtimeSessionId, runtime: previous.runtime };
      // The resume check compares with the newest saved Build conversation: point it at the turn that asked the questions (what the window's open does).
      const key = buildKeyOfTurn(env, previousId);
      if (key) openBuild(env, key);
    }
    return {
      skipMcpApply: true,
      req: {
        request: input.goal,
        workspaceGrant: deps.grantFolder(workspace),
        mcpConsent: emptyMcpConsent(),
        runtimePinned: carry !== null,
        locale: input.locale,
        ...(input.history?.length ? { history: input.history } : {}),
        ...(carry ? carry : {}),
        ...(input.attachments?.length ? { attachments: input.attachments.map((file) => ({ grant: deps.grantFile(file.path), name: file.name })) } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      },
    };
  }

  async function assembleNew(input: PhoneBuildRunInput): Promise<{ req: Omit<HephaestusBuildRequest, "clientRunId">; skipMcpApply: boolean }> {
    const workspace = await deps.createWorkspace(input.signal);
    input.signal.throwIfAborted();
    return {
      skipMcpApply: false,
      req: {
        request: input.goal,
        workspaceGrant: deps.grantFolder(workspace),
        mcpConsent: emptyMcpConsent(),
        runtimePinned: false,
        locale: input.locale,
        ...(input.attachments?.length ? { attachments: input.attachments.map((file) => ({ grant: deps.grantFile(file.path), name: file.name })) } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      },
    };
  }

  /** One phone Build turn, to its end: settles when the turn is over and its terminal event has been delivered to `input.sink`. Throws when the turn could not start. */
  async function run(input: PhoneBuildRunInput): Promise<void> {
    input.signal.throwIfAborted();
    const base = deps.trackedDeps();
    if (!base) throw new PhoneBuildTurnError("build_unavailable");
    const assembled = input.continueBuild ? await assembleContinue(input, input.continueBuild) : input.workspace ? await assembleAnswer(input) : await assembleNew(input);
    input.signal.throwIfAborted();
    const trackedId = deps.newId();
    // The interview witness (hephaestus/mobile-interview-witness.ts): evidence that the owner answered, tied to the run id and cancel signal the Builder is handed. The Builder is handed the
    // tracked turn's, so the witness is re-bound to them at the moment the turn starts.
    const withWitness: TrackedBuildDeps = {
      ...base,
      runBuild: (runId, resolved, emit, signal, locale, onRuntimeResolved) => {
        transferMobileBuildInterviewWitness(input, resolved as unknown as { request: string; workspace: string }, { runId, signal });
        return base.runBuild(runId, resolved, emit, signal, locale, onRuntimeResolved);
      },
    };
    noteExternalRun(input.runId, trackedId);
    const started = await runTrackedBuildTurn(withWitness, { ...assembled.req, clientRunId: trackedId }, {
      window: null, immediate: true, deliver: input.sink, signal: input.signal, skipMcpApply: assembled.skipMcpApply, recoverable: false,
    });
    await started.done;
  }

  return { precheckContinue, anyBuildActive, run };
}

export type PhoneBuildTurns = ReturnType<typeof createPhoneBuildTurns>;
