/*
 * Science 호스트 설치기 — Main 과 데몬이 부르는 하나.
 *
 * 전에는 Main(`electron/science-host.ts`)과 데몬(`electron/daemon/science-host.ts`)이 같은 SDK
 * 포트를 따로 채웠고 9곳이 갈라져 있었다. 한쪽만 고친 수리가 다른 쪽에 빠지는 일을 막으려고
 * 여기 한 벌로 모았다(docs/2026-10-28-science-harness-unify/PLAN.md §4 S1).
 *
 * 호스트마다 다른 것은 인자 셋뿐이다.
 *   - hostKind: Goal 대기 소유자 종류(desktop/daemon)와 투영 소유자(데몬 임대)
 *   - presentQuestion: 연구자 질문을 띄우는 곳(Main 창 / 데몬 이벤트)
 *   - workbook: 워크북 읽기 모듈(Main 은 이미 실린 것, 데몬은 실제로 읽을 때 처음 싣는다)
 * 나머지는 전에 데몬만 하던 엄격한 규칙을 두 호스트 모두에 쓴다.
 *   - 상태를 바꾸는 포트는 모두 fence.assertExecution() 을 먼저 지난다.
 *   - projectResearchState 가 실패하면 "unavailable" 로 닫는다.
 *   - 플러그인 위치 후보 4곳, 표식 폴더가 안에 있는 첫 후보.
 *   - 한 프로세스에서 두 번째 설치는 거절한다(SDK 는 조용히 바꿔 끼우므로).
 *   - detectRuntimes 는 인자 없이 부른다(SDK 가 인자를 넘긴 적이 없다).
 *
 * 이 파일은 electron 모듈을 싣지 않는다. 패키지 데몬에는 electron 이 없다
 * (scripts/test-daemon-science-headless.cjs 가 막힌 상태로 싣어 본다).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { installScienceHost, scienceRuntimeRole, scienceStore, SCIENCE_HOST_CONTRACT_VERSION, SCIENCE_HOST_REQUIRED_CAPABILITIES } from "agentlas-science";
import { createScienceQuestionHost } from "./question-continuation";
import { scienceAliveCoreHost } from "./alive-core";
import { scienceLocalSpecialistHost } from "./local-specialists";
import { scienceLocalEmbeddingHost } from "./local-embedding";
import { ScienceQuestionRecoveryPresenter } from "./work-recovery";
import { inspectScienceRuntimeSelectionAvailability } from "./runtime-selection-availability";
import { scienceCriterionReviewHost } from "./criterion-review";
import { scienceAliveDesktopTools, scienceDesktopTools } from "./desktop-tool-bridge";
import { mintForwardSteeringRecoveryCapability } from "./recovery-mint";
import { assertScienceRecoveryRuntimeAdmitted } from "./recovery-runtime-admission";
import { projectResearchState } from "./research-state-projection";
import { scienceCodexProductConfig } from "./codex-product-config";
import { bindScienceCodexProductSessionStore } from "./codex-session-store";
import { scienceHostGoalWake, readScienceHostGoalWake, cancelScienceHostGoalWake, recordScienceHostGoalOwnerControl } from "./goal-wake";
import { recordSciencePublicationHostOutputs } from "./publication-outputs";
import { recordScienceArtifactHostOutputs } from "./artifact-outputs";
import { createScienceCanonicalGoalWaitOwner, installScienceCanonicalGoalWaitOwner } from "./goal-wait";
import { probePdfLatexProfile } from "./pdflatex";
import { configureScienceMathPython } from "./math-python";
import { listScienceTypesetProfileCatalog } from "./typeset-profile-catalog";
import { renderManuscriptPdf, resolveTectonic } from "./render-pdf";
import type * as WorkbookIntake from "./workbook-intake-ipc";
import { withHostInvocationAdmission } from "../invocation/host-admission";
import { listOwnerDirections, SURFACE_OWNED_DIRECTION_PREFIXES, takeUndeliveredOwnerDirections } from "../invocation/carried-owner-followups";
import { installScienceStoreSchemaRejectionReader } from "../invocation/science-schema-rejection";
import { invocationService } from "../invocation/service";
import { captureScienceInvocationBinding } from "../invocation/workspace-binding";
import { scienceEvidenceCollectionHost } from "../runtime/science-collection-boundary";
import { desktopAliveRuntime } from "../alive-runtime";
import { desktopAliveClock } from "../alive-clock";
import { inspectLegacyForwardRecoveryBoundary, reconcileScienceBoundary, type ScienceRuntimeBoundaryInput } from "../long-run/science-boundary";
import { projectScienceLoopLongRun } from "../long-run/science-projection";
import { readCanonicalGoalWait, holdCanonicalGoalWait, cancelCanonicalGoalWaitScope, setCanonicalGoalWaitOwnerProvider } from "../long-run/canonical-owner-waits";
import { detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, withCliPath } from "../runtime/exec";
import { resolveManagedNodeRuntime } from "../runtime/managed-node";
import { isPackagedRuntime, runtimeResourcesPath, userDataPath } from "../runtime-paths";
import { currentUiLocale } from "../ui-locale";
import { ensureScienceRuntimeChat, latestDurableAssistantMessage, setChatRuntimeSelection } from "../store/chats";
import { getMeta, setMeta } from "../store/meta";
import { getDb } from "../store/db";
import { commitSurfaceViewMessage, importSurfaceConversation, readSurfaceConversation, surfaceRuntimeInputRows } from "../store/surface-conversation";
import { SCIENCE_SURFACE_PACK } from "../store/surface-conversation-schema";
import { evictRuntimeSessionsForChat } from "../store/runtime-sessions";
import { listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered } from "../store/run-events";
import { agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles } from "../agents/files";
import { activeScienceExtension, resolveExactVerifiedScienceRenderer, resolveExactVerifiedScienceRendererExecutor,
  resolveExactVerifiedScienceRendererExecutorBinding, resolveVerifiedScienceRenderer, resolveVerifiedScienceRendererExecutor } from "../extensions/science";
import { registerPreparedMcpConfig } from "../mcp-tools/prepared-transport";
import { RUNTIME_BACKEND_SET } from "../../shared/runtime-backends";
import { RUNTIME_KIND_SET } from "../../shared/runtime-kinds";
import { productExtensionSignedPayload } from "../../shared/product-extension";
import { runStopCause, runStopCopy } from "../../shared/invocation-host-stop";
import type { InstalledMcpServer } from "../../shared/types";

export type ScienceHostKind = "main" | "daemon";

/** The two checks every host supplies. Neither one may be a no-op stand-in for the other. */
export interface ScienceHostFence {
  /** This process still owns the host (daemon lease, Main process identity). */
  assertOwner(): void;
  /** Execution admission is open. Every state-changing port calls this before it acts. */
  assertExecution(): void;
}

type WorkbookPorts = Pick<typeof WorkbookIntake, "readPersistedScienceWorkbook" | "persistedWorkbookReadback">;

export interface ScienceHostInstallInput {
  hostKind: ScienceHostKind;
  fence: ScienceHostFence;
  /** Epoch that owns goal waits and projections here; null when this process is not the owner right now. */
  ownerEpoch(): string | null;
  /** Main: the verified Science window. Daemon: the event stream to an attached GUI. */
  presentQuestion(question: unknown): void;
  /** Main passes its loaded module; the daemon resolves it only for an actual workbook read. */
  workbook(): WorkbookPorts;
}

export interface ScienceHostHandle {
  readonly hostKind: ScienceHostKind;
  project(snapshot: Parameters<typeof projectScienceLoopLongRun>[0]): void;
  registerQuestionUi(): { releaseSha256: string };
  /** Stops reminders only (Main's before-quit). */
  stopQuestionPresenter(): void;
  /** Closes goal waits, reminders and every alive clock this host scheduled. Safe to call more than once. */
  stop(): void;
}

/** Keep the Desktop side of this bridge structural: the pinned Science package predates its exported name. */
interface ScienceMcpPreparedRegistration {
  path: string; configKey: string; command: string; args: string[];
  env: Record<string, string>; isCurrent: () => boolean;
}

let installedHostKind: ScienceHostKind | null = null;
/** Science's own owner directions in the common current-turn store (PLAN S3); other surfaces' rows are never Science's. */
export const SCIENCE_DIRECTION_PREFIX = SURFACE_OWNED_DIRECTION_PREFIXES[0]!;

/** Candidates for the bundled Science plugins, judged by a marker plugin inside (dist/electron/plugins is unrelated). */
export function scienceHostPluginRootCandidates(dir: string, resources: string | null): string[] {
  return [path.resolve(dir, "..", "plugins"), path.resolve(dir, "..", "..", "plugins"),
    path.resolve(dir, "..", "..", "..", "plugins"),
    ...(resources ? [path.join(resources, "app.asar.unpacked", "dist", "plugins")] : [])];
}

export function installScienceHostFor(input: ScienceHostInstallInput): ScienceHostHandle {
  if (input.hostKind !== "main" && input.hostKind !== "daemon") throw new Error("science_host_kind_invalid");
  if (installedHostKind) throw new Error("science_host_already_installed");
  const { fence } = input;
  configureScienceMathPython();
  const goalWaitOwnerKind = input.hostKind === "main" ? "desktop" as const : "daemon" as const;
  let closed = false;
  const goalWait = createScienceCanonicalGoalWaitOwner({
    owner: () => {
      const epoch = closed || scienceRuntimeRole() !== "execution-owner" ? null : input.ownerEpoch();
      return epoch ? { kind: goalWaitOwnerKind, epoch } : null;
    },
    assertExecution: () => { if (closed) throw new Error("science_goal_wait_host_closed"); fence.assertExecution(); },
    assertCurrentOwner: expected => {
      if (closed || scienceRuntimeRole() !== "execution-owner" || expected.kind !== goalWaitOwnerKind
        || expected.epoch !== input.ownerEpoch()) throw new Error("science_goal_wait_owner_changed");
      fence.assertExecution();
    },
    intake: { read: readCanonicalGoalWait, hold: holdCanonicalGoalWait },
    cancelScope: cancelCanonicalGoalWaitScope,
  });
  let questionUiRelease: string | null = null;
  const releases = new Set<() => void>();
  const currentRelease = () => {
    const release = activeScienceExtension();
    return release ? createHash("sha256").update(productExtensionSignedPayload(release.manifest)).digest("hex") : null;
  };
  const questionUiAvailable = () => Boolean(questionUiRelease && questionUiRelease === currentRelease());
  const questionRecovery = new ScienceQuestionRecoveryPresenter({
    references: () => scienceStore().researcherQuestions().openReferences(),
    read: ref => scienceStore().researcherQuestions().presentationScope(ref.projectId, ref.conversationId, ref.questionId),
    available: questionUiAvailable,
    assertOwner: fence.assertOwner,
    present: input.presentQuestion,
  });
  // Projection owner kind: the daemon projects under its lease; Main keeps the desktop owner row.
  const project = (snapshot: Parameters<typeof projectScienceLoopLongRun>[0]) => {
    if (input.hostKind === "main") { projectScienceLoopLongRun(snapshot); return; }
    const appInstanceId = input.ownerEpoch();
    if (!appInstanceId) throw new Error("science_projection_owner_invalid");
    projectScienceLoopLongRun(snapshot, { hostOwnerKind: "daemon", appInstanceId, assertOwner: fence.assertOwner });
  };
  const registerPrepared = (registration: ScienceMcpPreparedRegistration) => {
    fence.assertExecution();
    // Prepared transports do not resolve credentials through the global registry; their
    // exact values stay in the Main-only WeakMap created by registerPreparedMcpConfig.
    const server: InstalledMcpServer = {
      id: registration.configKey, catalogId: registration.configKey, name: "Agentlas Science", nameEn: "Agentlas Science",
      transport: "stdio", command: registration.command, args: [...registration.args], url: null,
      envKeys: [], configurationValid: true, enabled: true, installedAt: new Date().toISOString(),
    };
    registerPreparedMcpConfig({ path: registration.path,
      servers: [{ configKey: registration.configKey, server,
        transport: { command: registration.command, args: [...registration.args], env: { ...registration.env } }, runtimeRoot: null }],
      runtimeEnv: {}, isCurrent: () => { fence.assertExecution(); return registration.isCurrent(); },
    });
  };
  const boundRuntimeChat = (boundary: Omit<ScienceRuntimeBoundaryInput, "expectedRuntimeChatId">) => {
    fence.assertExecution();
    const store = scienceStore();
    const turn = store.getTurnForProject(boundary.projectId, boundary.turnId);
    const binding = store.getConversationRuntimeBinding(boundary.projectId, boundary.conversationId);
    if (!turn || !binding || turn.conversationId !== boundary.conversationId
      || turn.invocationRunId !== boundary.invocationRunId || turn.runtimeChatId !== binding.runtimeChatId) {
      throw new Error("science_runtime_boundary_run_binding_mismatch");
    }
    return binding.runtimeChatId;
  };
  // Invocation owns provider sessions and the prepared MCP registry in this same
  // process. Cancels/settlement stay callable after execution admission closes.
  const admittedInvocation = withHostInvocationAdmission(invocationService, fence.assertExecution);
  const fencedInvocation = new Proxy(admittedInvocation, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "start" || key === "steer" || key === "steerCurrentTurn") fence.assertExecution();
        return Reflect.apply(value, target, args);
      };
    },
  });
  const aliveRuntime = { ...desktopAliveRuntime,
    start: (...args: Parameters<typeof desktopAliveRuntime.start>) => { fence.assertExecution(); return desktopAliveRuntime.start(...args); },
  };
  const aliveClock = {
    schedule: (beat: Parameters<typeof desktopAliveClock.schedule>[0]) => {
      fence.assertExecution();
      const releaseClock = desktopAliveClock.schedule({ ...beat, onBeat: () => { fence.assertExecution(); beat.onBeat(); } });
      const release = () => { releases.delete(release); releaseClock(); };
      releases.add(release);
      return release;
    },
  };
  fence.assertOwner();
  const compatibility = installScienceHost({
    ...{ aliveCore: scienceAliveCoreHost },
    aliveRuntime, aliveClock,
    // 실행
    spawnCli: (...args: Parameters<typeof spawnCli>) => { fence.assertExecution(); return spawnCli(...args); },
    killCliTree, probeCliVersion: (...args: Parameters<typeof probeCliVersion>) => { fence.assertExecution(); return probeCliVersion(...args); },
    withCliPath, detachedSpawnOpts, resolveManagedNodeRuntime,
    // 저장소
    ensureScienceRuntimeChat: (...args: Parameters<typeof ensureScienceRuntimeChat>) => { fence.assertExecution(); return ensureScienceRuntimeChat(...args); },
    latestDurableAssistantMessage,
    setChatRuntimeSelection: (...args: Parameters<typeof setChatRuntimeSelection>) => { fence.assertExecution(); return setChatRuntimeSelection(...args); },
    getMeta,
    setMeta: (...args: Parameters<typeof setMeta>) => { fence.assertExecution(); return setMeta(...args); },
    getDb, evictRuntimeSessionsForChat, listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered,
    // 에이전트 파일
    agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles,
    // 모델 호출
    invocationService: fencedInvocation, captureScienceInvocationBinding,
    // 플랫폼
    userDataPath, currentUiLocale, productExtensionSignedPayload, RUNTIME_BACKEND_SET, RUNTIME_KIND_SET,
    registerScienceMcpPreparedConfig: registerPrepared,
    researcherQuestionUi: {
      // Registration proves that this installed renderer implements durable list + human answer.
      // The view need not remain open: questions can be read again when it is reopened.
      isAvailable: questionUiAvailable,
      present: (question: unknown) => { fence.assertOwner(); questionRecovery.present(question); },
    },
    // 확장 검증
    activeScienceExtension, resolveVerifiedScienceRenderer, resolveExactVerifiedScienceRenderer,
    resolveVerifiedScienceRendererExecutor, resolveExactVerifiedScienceRendererExecutor, resolveExactVerifiedScienceRendererExecutorBinding,
    // OS 권한이 필요한 것
    isPackagedHost: isPackagedRuntime, renderManuscriptPdf, resolveTectonic,
    readPersistedScienceWorkbook: (...args: Parameters<WorkbookPorts["readPersistedScienceWorkbook"]>) => input.workbook().readPersistedScienceWorkbook(...args),
    persistedWorkbookReadback: (...args: Parameters<WorkbookPorts["persistedWorkbookReadback"]>) => input.workbook().persistedWorkbookReadback(...args),
    /*
     * 내장 플러그인 위치. ★실측(2026-09-10): `dist/electron/plugins` 는 과학 플러그인과 무관한
     * 컴파일 산출물이라 폴더가 있다는 것만으로 고르면 진짜 위치를 못 본다. 함께 번들되는
     * `agentlas-science-statistics` 가 후보 **안에** 있는지까지 본다.
     */
    sciencePluginRoot: () => scienceHostPluginRootCandidates(__dirname, runtimeResourcesPath())
      .find(candidate => fs.existsSync(path.join(candidate, "agentlas-science-statistics"))) ?? null,
    /** 내장 플러그인 매니페스트 핀. 이 앱의 빌드가 만들고 이 앱이 위치를 안다. */
    sciencePublicPluginPinsPath: () => {
      const file = path.resolve(__dirname, "..", "public-plugin-manifest-pins.json");
      return fs.existsSync(file) ? file : null;
    },
    // 런타임 탐색 — 사이언스는 이것을 동적으로만, 인자 없이 부른다
    detectRuntimes: async () => (await import("../runtime/detect")).detectRuntimes(),
    listRuntimeModels: async (...args: Parameters<typeof import("../runtime/providers")["listRuntimeModels"]>) => (await import("../runtime/providers")).listRuntimeModels(...args),
  } as never, {
    contractVersion: SCIENCE_HOST_CONTRACT_VERSION, capabilities: SCIENCE_HOST_REQUIRED_CAPABILITIES,
    execution: {
      ...{ decisions: createScienceQuestionHost(fence.assertExecution).port },
      ...{ goalWait: goalWait.sdkHost },
      ...{ recordArtifactOutputs: (scope: Parameters<typeof recordScienceArtifactHostOutputs>[0]) => {
        fence.assertExecution(); return recordScienceArtifactHostOutputs(scope);
      } },
      ...{ recordPublicationOutputs: (scope: Parameters<typeof recordSciencePublicationHostOutputs>[0]) => {
        fence.assertExecution(); return recordSciencePublicationHostOutputs(scope);
      } },
      ...{ readHostGoalWake: (scope: Parameters<typeof readScienceHostGoalWake>[0]) => {
        fence.assertOwner(); return readScienceHostGoalWake(scope);
      }, cancelHostGoalWake: (scope: Parameters<typeof cancelScienceHostGoalWake>[0]) => {
        fence.assertOwner(); return cancelScienceHostGoalWake(scope);
      }, recordHostGoalOwnerControl: (scope: Parameters<typeof recordScienceHostGoalOwnerControl>[0]) => {
        fence.assertExecution(); return recordScienceHostGoalOwnerControl(scope);
      } },
      ...{ hostGoalWake: <T extends { runId: string }>(scope: Parameters<typeof scienceHostGoalWake>[0], start: () => T) => {
        fence.assertExecution(); return scienceHostGoalWake(scope, () => { fence.assertExecution(); return start(); });
      } },
      localSpecialists: {
        list: scope => { fence.assertExecution(); return scienceLocalSpecialistHost.list(scope); },
        prepare: scope => { fence.assertExecution(); return scienceLocalSpecialistHost.prepare(scope); },
        bind: scope => { fence.assertExecution(); return scienceLocalSpecialistHost.bind(scope); },
        assertCurrent: (...args) => { fence.assertExecution(); return scienceLocalSpecialistHost.assertCurrent(...args); },
        assertTurnScope: scope => { fence.assertExecution(); return scienceLocalSpecialistHost.assertTurnScope(scope); },
        verifyReturn: scope => { fence.assertExecution(); return scienceLocalSpecialistHost.verifyReturn(scope); },
      },
      ...{ codexProductConfig: scienceCodexProductConfig },
      ...{ bindCodexProductSessionStore: (home: string) => { fence.assertExecution(); bindScienceCodexProductSessionStore(home); } },
      ...{ projectResearchState: async (projectionInput: Parameters<typeof projectResearchState>[0]) => {
        try {
          fence.assertExecution();
          const result = await projectResearchState(projectionInput);
          fence.assertExecution();
          return result;
        } catch {
          return { status: "unavailable" as const, code: "research_state_projection_host_unavailable", usage: "unknown" as const };
        }
      } },
      mintForwardSteeringRecoveryCapability: (...args: Parameters<typeof mintForwardSteeringRecoveryCapability>) => {
        fence.assertExecution();
        // Which runtimes may carry a recovery turn comes from the shared runtime table, not a hand list.
        assertScienceRecoveryRuntimeAdmitted(args[0]?.runtimeSelection);
        return mintForwardSteeringRecoveryCapability(...args);
      },
      evidenceCollection: scienceEvidenceCollectionHost,
      criterionReview: { ...scienceCriterionReviewHost,
        start: (...args: Parameters<typeof scienceCriterionReviewHost.start>) => { fence.assertExecution(); return scienceCriterionReviewHost.start(...args); },
      },
      ...{ desktopTools: {
        list: (...args: Parameters<typeof scienceDesktopTools.list>) => { fence.assertExecution(); return scienceDesktopTools.list(...args); },
        call: (...args: Parameters<typeof scienceDesktopTools.call>) => { fence.assertExecution(); return scienceDesktopTools.call(...args); },
      } },
      ...{ aliveDesktopTools: {
        list: (...args: Parameters<typeof scienceAliveDesktopTools.list>) => { fence.assertExecution(); return scienceAliveDesktopTools.list(...args); },
        call: (...args: Parameters<typeof scienceAliveDesktopTools.call>) => { fence.assertExecution(); return scienceAliveDesktopTools.call(...args); },
      } },
      registerMcpPreparedConfig: registerPrepared,
      // PLAN S2: this host takes Science as one server of its shared tool chain (science-host/tool-server.ts). A Science
      // build that knows the member mints that server and names no Science-only discovery tool in its prompts.
      ...{ commonToolServer: { version: 1 as const } },
      // PLAN S3: a Science owner direction into a running turn is the common current-turn steer (InvocationService
      // steerCurrentTurn: native mid-turn delivery or the run's next boundary, the same rows Work and One write), and what
      // the run never took is handed back to Science at its turn's end instead of becoming a Work turn on the hidden chat.
      // Stop is the common cancel already (SDK cancel -> invocationService.cancel). A Science build that knows the member
      // writes no Science steering row; an older build keeps its own steering path.
      ...{ commonSteering: {
        version: 1 as const,
        steer: (direction: { runtimeChatId: string; invocationRunId: string; intentId: string; text: string }) => {
          fence.assertExecution();
          if (typeof direction?.intentId !== "string" || !direction.intentId.startsWith(SCIENCE_DIRECTION_PREFIX)) throw new Error("science_direction_intent_invalid");
          return invocationService.steerCurrentTurn({ chatId: direction.runtimeChatId, intentId: direction.intentId,
            expectedRunId: direction.invocationRunId, text: direction.text });
        },
        list: (scope: { runtimeChatId: string }) => {
          fence.assertOwner();
          return listOwnerDirections({ chatId: scope.runtimeChatId, intentPrefix: SCIENCE_DIRECTION_PREFIX });
        },
        takeUndelivered: (scope: { runtimeChatId: string; invocationRunId: string }) => {
          fence.assertExecution();
          return takeUndeliveredOwnerDirections({ chatId: scope.runtimeChatId, runId: scope.invocationRunId, intentPrefix: SCIENCE_DIRECTION_PREFIX })
            .map(({ intentId, text }) => ({ intentId, text }));
        },
      } },
      // PLAN S4: a question for the owner is the common question ledger (agentlas-turn ask_form / host-loop ask_user ->
      // the canonical decision reader above, the phone's canonical question bank): a Science build that knows the member
      // lists no Science-only researcher-question opener.
      ...{ commonQuestions: { version: 1 as const } },
      // PLAN S5: a Science turn's tool calls go through the common Work journal (invocation/main-work-recovery.ts): admit before
      // dispatch, finish with how the call ended, an identical repeat of a call whose answer was lost is refused, a lost outcome
      // blocks only its own step, and the next turn carries the common recovery packet. Which Science tools are effect-free reads
      // comes from the tool server's own declarations (host-tool-servers.ts). A Science build that knows the member sets
      // `commonWorkRecovery` on its turns and records no Science forward-recovery basis; an older build keeps its own recovery.
      ...{ commonWorkRecovery: { version: 1 as const } },
      // PLAN S6: a Science conversation's record is its common chat (the hidden chat Desktop already keeps for it, tagged with the
      // Science pack). Science commits what its screen shows there first, under its own message ID (store/surface-conversation.ts),
      // reads its conversation back from there, and copies a conversation recorded before the switch once. Its own message table
      // stays as the read model its research records point to. A Science build that knows the member marks its turns
      // `surfaceConversation`; an older build keeps its own message table as its only record.
      ...{ commonConversation: {
        version: 1 as const,
        commit: (row: { runtimeChatId: string; messageId: string; role: "user" | "assistant" | "system"; text: string; createdAt: string }) => {
          fence.assertExecution();
          return commitSurfaceViewMessage({ pack: SCIENCE_SURFACE_PACK, chatId: row?.runtimeChatId, messageId: row?.messageId,
            role: row?.role, text: row?.text, createdAt: row?.createdAt });
        },
        read: (scope: { runtimeChatId: string; messageIds: string[] }) => {
          fence.assertOwner();
          return readSurfaceConversation({ pack: SCIENCE_SURFACE_PACK, chatId: scope?.runtimeChatId, messageIds: scope?.messageIds ?? [] });
        },
        runtimeInputRows: (scope: { runtimeChatId: string; runIds: string[] }) => {
          fence.assertOwner();
          return surfaceRuntimeInputRows({ pack: SCIENCE_SURFACE_PACK, chatId: scope?.runtimeChatId, runIds: scope?.runIds ?? [] });
        },
        importLegacy: (input: { runtimeChatId: string; rows: Array<{ messageId: string; role: "user" | "assistant" | "system"; text: string; createdAt: string }>; runtimeInputRowIds: string[] }) => {
          fence.assertExecution();
          return importSurfaceConversation({ pack: SCIENCE_SURFACE_PACK, chatId: input?.runtimeChatId, rows: input?.rows ?? [],
            runtimeInputRowIds: input?.runtimeInputRowIds ?? [] });
        },
      } },
      // One stop wording for Science, Work, One and the phone (shared/invocation-host-stop.ts): the owner's Stop is not a failure.
      ...{ runStopNotice: (facts: { status?: unknown; hostStopCause?: unknown }, locale?: unknown) => {
        const cause = runStopCause(facts ?? {});
        return cause ? { cause, ...runStopCopy(cause, locale === "en" ? "en" : "ko") } : null;
      } },
      reconcileScienceBoundary: boundary => reconcileScienceBoundary({ ...boundary, expectedRuntimeChatId: boundRuntimeChat(boundary) },
        { hostLost: (runId) => { const receipt = invocationService.receipt(runId); return receipt === null || receipt.status === "interrupted"; } }),
      inspectLegacyForwardRecoveryBoundary: boundary => inspectLegacyForwardRecoveryBoundary({ ...boundary, expectedRuntimeChatId: boundRuntimeChat(boundary) }),
    },
    ...{ localEmbedding: scienceLocalEmbeddingHost },
    workspace: { captureInvocationBinding: captureScienceInvocationBinding },
    render: { renderManuscriptPdf, resolveTectonic, probePdfLatexProfile, listTypesetProfiles: listScienceTypesetProfileCatalog },
    runtimeCatalog: {
      // Optional health facade also works while the installed Science declaration
      // is older; the exact pinned package can consume it without a contract downgrade.
      ...{ inspectSelectionAvailability: inspectScienceRuntimeSelectionAvailability },
      detectRuntimes: async () => (await (await import("../runtime/detect")).detectRuntimes()).map(runtime => ({ ...runtime, availableModels: runtime.availableModels ?? [] })),
      listRuntimeModels: async (...args) => (await import("../runtime/providers")).listRuntimeModels(...args),
    },
    projection: { project },
  });
  if (compatibility.status !== "compatible") throw new Error(compatibility.code);
  installedHostKind = input.hostKind;
  // Science turns can run in either host, so both read the pre-dispatch schema-rejection proof.
  installScienceStoreSchemaRejectionReader(scienceStore);
  installScienceCanonicalGoalWaitOwner(goalWait);
  setCanonicalGoalWaitOwnerProvider(goalWait.provider);
  return {
    hostKind: input.hostKind,
    project,
    registerQuestionUi() {
      fence.assertExecution();
      questionUiRelease = currentRelease();
      if (!questionUiRelease) throw new Error("science-researcher-question-ui-release-unavailable");
      questionRecovery.restore();
      return { releaseSha256: questionUiRelease };
    },
    stopQuestionPresenter() { questionRecovery.stop(); },
    stop() {
      if (!closed) {
        closed = true;
        installScienceCanonicalGoalWaitOwner(null);
        setCanonicalGoalWaitOwnerProvider(null);
      }
      questionRecovery.stop(); for (const release of [...releases]) release();
    },
  };
}
