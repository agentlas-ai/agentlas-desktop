import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { installScienceHost, scienceStore, SCIENCE_HOST_CONTRACT_VERSION, SCIENCE_HOST_REQUIRED_CAPABILITIES } from "agentlas-science";
import { desktopAliveRuntime } from "../alive-runtime";
import { desktopAliveClock } from "../alive-clock";
import { scienceCriterionReviewHost } from "../science-host/criterion-review";
import { mintForwardSteeringRecoveryCapability } from "../science-host/recovery-mint";
import { scienceEvidenceCollectionHost } from "../runtime/science-collection-boundary";
import { inspectLegacyForwardRecoveryBoundary, reconcileScienceBoundary, type ScienceRuntimeBoundaryInput } from "../long-run/science-boundary";
import { projectScienceLoopLongRun } from "../long-run/science-projection";
import { detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, withCliPath } from "../runtime/exec";
import { resolveManagedNodeRuntime } from "../runtime/managed-node";
import { isPackagedRuntime, runtimeResourcesPath, userDataPath } from "../runtime-paths";
import { currentUiLocale } from "../ui-locale";
import { ensureScienceRuntimeChat, latestDurableAssistantMessage, setChatRuntimeSelection } from "../store/chats";
import { getMeta, setMeta } from "../store/meta";
import { getDb } from "../store/db";
import { evictRuntimeSessionsForChat } from "../store/runtime-sessions";
import { listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered } from "../store/run-events";
import { agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles } from "../agents/files";
import { invocationService } from "../invocation/service";
import { captureScienceInvocationBinding } from "../invocation/workspace-binding";
import { RUNTIME_BACKEND_SET } from "../../shared/runtime-backends";
import { RUNTIME_KIND_SET } from "../../shared/runtime-kinds";
import { productExtensionSignedPayload } from "../../shared/product-extension";
import type { InstalledMcpServer } from "../../shared/types";
import { registerPreparedMcpConfig } from "../mcp-tools/prepared-transport";
import { activeScienceExtension, resolveExactVerifiedScienceRenderer, resolveExactVerifiedScienceRendererExecutor,
  resolveExactVerifiedScienceRendererExecutorBinding, resolveVerifiedScienceRenderer, resolveVerifiedScienceRendererExecutor } from "../extensions/science";
import { probePdfLatexProfile } from "../science-host/pdflatex";
import { listScienceTypesetProfileCatalog } from "../science-host/typeset-profile-catalog";
import { renderManuscriptPdf, resolveTectonic } from "../science-host/render-pdf";

interface PreparedRegistration {
  path: string; configKey: string; command: string; args: string[];
  env: Record<string, string>; isCurrent: () => boolean;
}

/** No Electron window, notification, or file-picker is constructed by this host. */
export function installDaemonScienceHost(input: {
  ownerEpoch: string;
  assertOwner(): void;
  assertExecution(): void;
  presentQuestion(question: unknown): void;
}) {
  let questionUiRelease: string | null = null;
  const releases = new Set<() => void>();
  const currentRelease = () => {
    const release = activeScienceExtension();
    return release ? createHash("sha256").update(productExtensionSignedPayload(release.manifest)).digest("hex") : null;
  };
  const project = (snapshot: Parameters<typeof projectScienceLoopLongRun>[0]) => {
    projectScienceLoopLongRun(snapshot, { hostOwnerKind: "daemon", appInstanceId: input.ownerEpoch, assertOwner: input.assertOwner });
  };
  const registerPrepared = (registration: PreparedRegistration) => {
    input.assertExecution();
    const server: InstalledMcpServer = {
      id: registration.configKey, catalogId: registration.configKey, name: "Agentlas Science", nameEn: "Agentlas Science",
      transport: "stdio", command: registration.command, args: [...registration.args], url: null,
      envKeys: [], configurationValid: true, enabled: true, installedAt: new Date().toISOString(),
    };
    registerPreparedMcpConfig({ path: registration.path,
      servers: [{ configKey: registration.configKey, server,
        transport: { command: registration.command, args: [...registration.args], env: { ...registration.env } }, runtimeRoot: null }],
      runtimeEnv: {}, isCurrent: () => { input.assertExecution(); return registration.isCurrent(); },
    });
  };
  const boundRuntimeChat = (boundary: Omit<ScienceRuntimeBoundaryInput, "expectedRuntimeChatId">) => {
    input.assertExecution();
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
  const fencedInvocation = new Proxy(invocationService, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "start" || key === "steer") input.assertExecution();
        return Reflect.apply(value, target, args);
      };
    },
  });
  const aliveRuntime = { ...desktopAliveRuntime,
    start: (...args: Parameters<typeof desktopAliveRuntime.start>) => { input.assertExecution(); return desktopAliveRuntime.start(...args); },
  };
  const aliveClock = {
    schedule: (beat: Parameters<typeof desktopAliveClock.schedule>[0]) => {
      input.assertExecution();
      const releaseClock = desktopAliveClock.schedule({ ...beat, onBeat: () => { input.assertExecution(); beat.onBeat(); } });
      const release = () => { releases.delete(release); releaseClock(); };
      releases.add(release);
      return release;
    },
  };
  // These existing persisted-read functions never call a picker. Resolve them
  // only for an actual workbook read, not when loading the headless runtime.
  const workbook = () => require("../science-host/workbook-intake-ipc") as typeof import("../science-host/workbook-intake-ipc");
  input.assertOwner();
  const compatibility = installScienceHost({
    aliveRuntime, aliveClock,
    spawnCli: (...args: Parameters<typeof spawnCli>) => { input.assertExecution(); return spawnCli(...args); },
    killCliTree, probeCliVersion: (...args: Parameters<typeof probeCliVersion>) => { input.assertExecution(); return probeCliVersion(...args); },
    withCliPath, detachedSpawnOpts, resolveManagedNodeRuntime,
    ensureScienceRuntimeChat: (...args: Parameters<typeof ensureScienceRuntimeChat>) => { input.assertExecution(); return ensureScienceRuntimeChat(...args); },
    latestDurableAssistantMessage,
    setChatRuntimeSelection: (...args: Parameters<typeof setChatRuntimeSelection>) => { input.assertExecution(); return setChatRuntimeSelection(...args); },
    getMeta,
    setMeta: (...args: Parameters<typeof setMeta>) => { input.assertExecution(); return setMeta(...args); },
    getDb, evictRuntimeSessionsForChat, listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered,
    agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles,
    invocationService: fencedInvocation, captureScienceInvocationBinding,
    userDataPath, currentUiLocale, productExtensionSignedPayload, RUNTIME_BACKEND_SET, RUNTIME_KIND_SET,
    registerScienceMcpPreparedConfig: registerPrepared,
    researcherQuestionUi: {
      isAvailable: () => Boolean(questionUiRelease && questionUiRelease === currentRelease()),
      present: input.presentQuestion,
    },
    activeScienceExtension, resolveVerifiedScienceRenderer, resolveExactVerifiedScienceRenderer,
    resolveVerifiedScienceRendererExecutor, resolveExactVerifiedScienceRendererExecutor, resolveExactVerifiedScienceRendererExecutorBinding,
    isPackagedHost: isPackagedRuntime, renderManuscriptPdf, resolveTectonic,
    readPersistedScienceWorkbook: (...args: Parameters<ReturnType<typeof workbook>["readPersistedScienceWorkbook"]>) => workbook().readPersistedScienceWorkbook(...args),
    persistedWorkbookReadback: (...args: Parameters<ReturnType<typeof workbook>["persistedWorkbookReadback"]>) => workbook().persistedWorkbookReadback(...args),
    sciencePluginRoot: () => {
      const resources = runtimeResourcesPath();
      const candidates = [path.resolve(__dirname, "..", "plugins"), path.resolve(__dirname, "..", "..", "plugins"),
        path.resolve(__dirname, "..", "..", "..", "plugins"),
        resources ? path.join(resources, "app.asar.unpacked", "dist", "plugins") : null];
      return candidates.find(candidate => candidate && fs.existsSync(path.join(candidate, "agentlas-science-statistics"))) ?? null;
    },
    sciencePublicPluginPinsPath: () => {
      const file = path.resolve(__dirname, "..", "public-plugin-manifest-pins.json");
      return fs.existsSync(file) ? file : null;
    },
    detectRuntimes: async () => (await import("../runtime/detect")).detectRuntimes(),
    listRuntimeModels: async (...args: Parameters<typeof import("../runtime/providers")["listRuntimeModels"]>) => (await import("../runtime/providers")).listRuntimeModels(...args),
  } as never, {
    contractVersion: SCIENCE_HOST_CONTRACT_VERSION, capabilities: SCIENCE_HOST_REQUIRED_CAPABILITIES,
    execution: {
      mintForwardSteeringRecoveryCapability: (...args: Parameters<typeof mintForwardSteeringRecoveryCapability>) => {
        input.assertExecution(); return mintForwardSteeringRecoveryCapability(...args);
      },
      evidenceCollection: scienceEvidenceCollectionHost,
      criterionReview: { ...scienceCriterionReviewHost,
        start: (...args: Parameters<typeof scienceCriterionReviewHost.start>) => { input.assertExecution(); return scienceCriterionReviewHost.start(...args); },
      },
      registerMcpPreparedConfig: registerPrepared,
      reconcileScienceBoundary: boundary => reconcileScienceBoundary({ ...boundary, expectedRuntimeChatId: boundRuntimeChat(boundary) }),
      inspectLegacyForwardRecoveryBoundary: boundary => inspectLegacyForwardRecoveryBoundary({ ...boundary, expectedRuntimeChatId: boundRuntimeChat(boundary) }),
    },
    workspace: { captureInvocationBinding: captureScienceInvocationBinding },
    render: { renderManuscriptPdf, resolveTectonic, probePdfLatexProfile, listTypesetProfiles: listScienceTypesetProfileCatalog },
    runtimeCatalog: {
      detectRuntimes: async () => (await (await import("../runtime/detect")).detectRuntimes()).map(runtime => ({ ...runtime, availableModels: runtime.availableModels ?? [] })),
      listRuntimeModels: async (...args) => (await import("../runtime/providers")).listRuntimeModels(...args),
    },
    projection: { project },
  });
  if (compatibility.status !== "compatible") throw new Error(compatibility.code);
  return {
    project,
    registerQuestionUi() {
      input.assertExecution();
      questionUiRelease = currentRelease();
      if (!questionUiRelease) throw new Error("science-researcher-question-ui-release-unavailable");
      return { releaseSha256: questionUiRelease };
    },
    stopClock() { for (const release of [...releases]) release(); },
  };
}
