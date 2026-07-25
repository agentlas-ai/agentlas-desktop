// 활성 백엔드 → 실제 러너로 라우팅하는 invocation runner.
// PRD §3.1 6단계 BYOC: 사용자 머신에서 사용자의 구독/키로 직접 호출.
// chatId 기반 — chat에서 agent + project 컨텍스트 lookup.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectRuntimes } from "../runtime/detect";
// Stormbreaker Loop — 목표 분해/연속 실행/검증 가능한 오류 repair를 감독(비차단·실패-무해).
import { superviseStormbreaker, type StormbreakerHandle } from "../hephaestus/stormbreaker-supervisor";
import { isNetworkAutoEnabled, isStormbreakerAutoEnabled } from "../hephaestus/supervisor";
import { careerGraphIngest, hepCall, routeOnly, stormbreakerHarness } from "../hephaestus/commands";
import { normalizeRecommendation } from "../hephaestus/recommendation";
import {
  buildStormbreakerLongRunPrompt,
  buildStormbreakerContinuationPrompt,
  CONTINUOUS_MODE_MAX_PASSES,
  STORMBREAKER_LONG_RUN_SCHEDULE,
  STORMBREAKER_LOOP_PROTOCOL,
  STORMBREAKER_MAX_EXECUTION_PASSES,
  stripStormbreakerContinueMarker,
} from "../hephaestus/loop-engineering";
import { getAgentById, listInstalledAgents } from "./registry";
import { buildEffectiveAgentSystemPrompt } from "../agents/files";
import {
  autoRouteStatus,
  autoRouteSystemPreamble,
  isGlobalOrchestrator,
  isPlainConversationalPrompt,
  selectAutoRoutedAgent,
  shouldAutoEngageNetworkWorkforce,
  shouldForceHubFirstWorkforce,
  type AutoRouteChoice,
} from "../agents/auto-router";
import { assembleSystemPrompt } from "../system-agents/assemble";
import { AUTOMATION_SUPERVISOR_SYSTEM_AGENT } from "../system-agents/automation-supervisor";
import { ROUTER_AGENT_ID, ROUTER_SYSTEM_AGENT } from "../system-agents/router";
import {
  appendChatMessage,
  autoTitleFromFirstMessage,
  getChat,
  getChatWorkingFolder,
  listChatMessages,
  setChatWorkingFolder,
} from "../store/chats";
import { getProject } from "../store/projects";
import { touchRuntimeSession } from "../store/runtime-sessions";
import { getInterviewMode, isTrivialPrompt } from "../store/interview-mode";
import { getFirm, listFirms } from "../store/firms";
import { recordBorrowedAgentCareer } from "../agents/borrowed-profiles";
import {
  activeBorrowedOwnerScopeKey,
  borrowedMemoryKey,
} from "../agents/borrowed-owner-scope";
import { getResolvedOrg } from "../store/org-spec";
import { runFirmInvocation } from "./firm-orchestrator";
import {
  BorrowedAgentUnavailableError,
  requireBorrowedAgentSpecs,
  runBorrowedTaskForceInvocation,
  type BorrowedAgentSpec,
  type WorkforceLeaderRunnerEvidence,
} from "./borrowed-task-force";
import {
  emitWorkforceBenchmarkSelectionArtifacts,
  isWorkforceLeaderRuntimeAllowed,
  parseWorkforceCommand,
  runWorkforceSelection,
  type WorkforcePrepareCheckpointReceipt,
  workforceFailureCode,
} from "./workforce-orchestrator";
import { runSwarmInvocation } from "./swarm-run";
import { getAgentGroup, listAgentGroups, resolveAgentGroupForRuntime } from "../store/agent-groups";
import {
  getOneOnboardingExecutionAuthorization,
  oneOnboardingStarterGroupReference,
} from "../one/onboarding";
import { canReadActivatedFolderMemory, recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import {
  ingestWorkingFolderOntologyInBackground,
  queryWorkingFolderOntologyContext,
} from "../ontology/project-runtime";
import {
  buildExperienceContext,
  buildExperienceRoutingPrior,
  type ExperienceRoutingPrior,
} from "../experience/context";
import { promoteExperienceCandidatesForRun } from "../experience/store";
import { maybeProposeEvolutionFromRun } from "../agents/evolution-triggers";
import { writeEvolutionProposalsForProject, evolutionSessionContextLine } from "../agents/evolution-hep";
import { resolveDesktopOperationalRuntimeSession } from "../ontology/operational-runtime-session";
import { operationalRuntimeOverlayMatchesTask } from "../ontology/operational-runtime-contract";
import { resolveDesktopTasteRuntimeSession } from "../ontology/taste-runtime-session";
import { tasteRuntimeOverlayMatchesTask } from "../ontology/taste-runtime-contract";
import {
  curateReply,
  recordTerminalMemoryTurn,
  stripReplyMemoryEventsReadOnly,
} from "../memory/curator";
import { stripAllMemoryEventBlocks } from "../memory/events";
import {
  runSemanticMemoryReview,
} from "../memory/semantic-curator";
import { harvestCompactionSummaries } from "../memory/compaction-harvest";
import { parseMemoryEvents } from "../memory/events";
import { APP_BUILDER_SLUG } from "../architecture/manifest";
import { memoryEmitterPromptFor } from "../system-agents/memory";
import { AUTOMATION_PROTOCOL, parseAutomations } from "../automation-emitter";
import { SURFACE_CLOSE_FENCE, SURFACE_OPEN_FENCE, parseSurfaces } from "../surface-emitter";
import { buildOneSurfaceFromMarkdown, chooseOneSurfaceForDisplay, resolveOneMarkdownSurfaceIntent } from "../one/markdown-surface";
import { createAutomation, listAutomations, updateAutomation, updateAutomationGraph } from "../store/automations";
import { projectContextKey, recordContextSourceMarker, tryRecordRunEvent } from "../store/run-events";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import {
  resolveSiteAgentAppInlineMcpConfigForDispatch,
} from "../site/agent-app-mcp-config-policy";
import { listInstalledServers as listInstalledMcpServers } from "../mcp-tools/registry";
import { getAgentApp } from "../store/agent-apps";
import { autoSelectMcpTools, buildMcpAutoSelectionPrompt } from "../mcp-tools/auto-select";
import { runMcpKeyElicitationGate } from "./run-key-elicitation";
import { bridgeHubPluginCandidates } from "../mcp-tools/hub-plugin-bridge";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { buildAgentAppRunnerEnv, buildRunnerEnv, restrictedRunnerEnv } from "../runtime/env-resolver";
import { agentRunCwd } from "../runtime/exec";
import {
  normalizeRemoteInvocationPermission,
  revalidateInvocationWorkspaceBinding,
  type InvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import { type Runner, SURFACE_INTENT_MARKER, UNATTENDED_NO_ASK_DIRECTIVE } from "../runtime/runner";
import { pickActive, pickRunner, selectAgentAppRuntimeForTargets, selectExactRuntime, selectRuntimeForTargets } from "../runtime/selection";
import { pickLocale, tStatus } from "../runtime/status-i18n";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import {
  oneTeamRuntimeBinding,
  oneTeamRuntimeBindingMatches,
  type OneTeamRuntimeBinding,
} from "../one/team-preflight";
import {
  exactOneParticipantEffectivePrompt,
  validatedOneParticipantEffectivePromptMap,
  type OneParticipantExecutionSnapshot,
  type OneParticipantEffectivePromptSnapshot,
} from "../one/task-kind";
import {
  mainOneAttachmentContext,
  redactOneAttachmentEvent,
  redactOneAttachmentText,
} from "../one/attachments";
import type {
  Chat,
  AppFactoryAppRecord,
  InstalledAgent,
  McpInvocationEvent,
  McpInvocationRequest,
  AgentlasSurfaceManifest,
  JsonObject,
  OrchestrationTarget,
  RecStage,
  RecRouterAgent,
  RuntimeStatus,
} from "../../shared/types";

const ONE_LOCAL_ARTIFACT_PATH_KEYS = ["path", "filePath", "localPath", "file"] as const;
const ONE_LOCAL_ARTIFACT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac",
  ".pdf", ".docx", ".txt", ".md", ".xlsx", ".csv", ".json", ".zip",
]);

function sealOneLocalArtifactPaths(
  manifest: AgentlasSurfaceManifest,
  resultFolder: string | undefined,
): AgentlasSurfaceManifest {
  if (!resultFolder || !path.isAbsolute(resultFolder)) return manifest;
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(resultFolder));
  } catch {
    return manifest;
  }
  const insideRoot = (candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const sealRow = (row: JsonObject): JsonObject => {
    const next = { ...row };
    for (const key of ONE_LOCAL_ARTIFACT_PATH_KEYS) {
      const value = row[key];
      if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("://")) continue;
      const candidate = path.resolve(root, value.trim());
      if (!insideRoot(candidate)) continue;
      try {
        const canonical = fs.realpathSync.native(candidate);
        const stat = fs.lstatSync(candidate);
        if (canonical === candidate && stat.isFile()) next[key] = canonical;
      } catch {
        // A claimed file that is absent or linked never gains local authority.
      }
    }
    return next;
  };
  const verifiedArtifactRow = (row: JsonObject): JsonObject | null => {
    const claimedPath = ONE_LOCAL_ARTIFACT_PATH_KEYS
      .map((key) => row[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const claimedLabel = [row.label, row.name, row.title]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const claim = (claimedPath || claimedLabel || "").trim();
    if (!claim || claim.includes("://")) return null;
    const candidate = path.isAbsolute(claim) ? path.resolve(claim) : path.resolve(root, claim);
    if (!insideRoot(candidate) || !ONE_LOCAL_ARTIFACT_EXTENSIONS.has(path.extname(candidate).toLocaleLowerCase())) return null;
    try {
      const canonical = fs.realpathSync.native(candidate);
      const stat = fs.lstatSync(candidate);
      if (canonical !== candidate || !stat.isFile()) return null;
      return {
        ...row,
        label: claimedLabel?.trim() || path.basename(canonical),
        path: canonical,
      };
    } catch {
      return null;
    }
  };
  return {
    ...manifest,
    data: Object.fromEntries(Object.entries(manifest.data).map(([key, dataset]) => {
      if (dataset.type !== "artifacts" && dataset.type !== "media") return [key, dataset];
      if (dataset.type === "artifacts") {
        return [key, {
          ...dataset,
          ...(Array.isArray(dataset.rows) ? { rows: dataset.rows.flatMap((row) => {
            const verified = verifiedArtifactRow(row);
            return verified ? [verified] : [];
          }) } : {}),
          ...(Array.isArray(dataset.items) ? { items: dataset.items.flatMap((item) => {
            const verified = verifiedArtifactRow(item);
            return verified ? [verified] : [];
          }) } : {}),
        }];
      }
      return [key, {
        ...dataset,
        ...(Array.isArray(dataset.rows) ? { rows: dataset.rows.map((row) => sealRow(row)) } : {}),
        ...(Array.isArray(dataset.items) ? { items: dataset.items.map((item) => sealRow(item)) } : {}),
      }];
    })),
  };
}

function mainOneProfileContext(req: McpInvocationRequest): string {
  const value = (req as McpInvocationRequest & { oneProfileContext?: unknown }).oneProfileContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}

type MainBoundOneInvocationRequest = McpInvocationRequest & {
  oneTeamExecutionPolicy?: "solo_locked" | "confirmed_existing_roster" | "confirmed_external_workforce";
  oneTeamRuntimeBinding?: OneTeamRuntimeBinding;
  oneParticipantExecutionSnapshot?: OneParticipantExecutionSnapshot;
};

function mainOneTeamExecutionPolicy(
  req: McpInvocationRequest,
): MainBoundOneInvocationRequest["oneTeamExecutionPolicy"] {
  const value = (req as MainBoundOneInvocationRequest).oneTeamExecutionPolicy;
  return value === "solo_locked"
    || value === "confirmed_existing_roster"
    || value === "confirmed_external_workforce"
    ? value
    : undefined;
}

function mainOneTeamRuntimeBinding(req: McpInvocationRequest): OneTeamRuntimeBinding | undefined {
  const value = (req as MainBoundOneInvocationRequest).oneTeamRuntimeBinding;
  return value && typeof value === "object" ? value : undefined;
}

function mainOneParticipantExecutionSnapshot(req: McpInvocationRequest): unknown {
  return (req as MainBoundOneInvocationRequest).oneParticipantExecutionSnapshot;
}

type EventSink = (ev: McpInvocationEvent) => void;
const careerGraphRefreshTriggered = new Set<string>();

/**
 * Some host CLIs occasionally stop immediately after opening the hidden
 * memory JSON fence. A language-qualified fence at end-of-message cannot be a
 * valid closing fence, so keeping it only creates an empty black code block in
 * One and Work. Bare closing fences and every complete code block are left
 * untouched.
 */
/** One 복구 패스 프롬프트 — 실패한 필수 단계를 모델이 직접 재실행해 스스로 완주하게 한다. */
function buildOneRecoveryPrompt(previousText: string, attempt: number): string {
  const clipped = previousText.length > 6_000 ? previousText.slice(-6_000) : previousText;
  return [
    `Recovery pass ${attempt}: at least one required tool step failed earlier in this run, so the work is not finished yet.`,
    "Continue the same task in this conversation and finish it completely:",
    "1. Identify which step failed.",
    "2. Re-execute that step now with your tools, or take a working alternative path to the same outcome.",
    "3. Verify the outcome with tool evidence, then write the complete final result for the user.",
    "Never apologize, never describe internal errors, and never ask the user to retry — deliver the finished result.",
    "Your previous visible output was:",
    "<previous-output>",
    clipped,
    "</previous-output>",
  ].join("\n");
}

function stripDanglingLanguageFence(text: string): string {
  return text.replace(/\n[ \t]*```[A-Za-z0-9_+.-]+[ \t]*$/u, "").trim();
}

function invocationFailure(
  req: McpInvocationRequest,
  fallbackCode: string,
  error: unknown,
): { code: string; message: string } {
  if (req.agentAppMode) return untrustedRuntimeFailurePayload();
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function throwIfInvocationAborted(signal: AbortSignal | undefined, locale: "ko" | "en"): void {
  if (signal?.aborted) throw new Error(tStatus(locale, "aborted"));
}

/** 방출된 "agent" 필드(id/slug/표시명, 대소문자 무시)를 설치 에이전트로 해석. 못 찾으면 null. */
function resolveInstalledAgentLoose(query: string): InstalledAgent | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const direct = getAgentById(query.trim());
  if (direct) return direct;
  const all = listInstalledAgents();
  return (
    all.find((ag) => ag.slug.toLowerCase() === needle) ??
    all.find(
      (ag) =>
        ag.name.trim().toLowerCase() === needle ||
        (ag.nameEn ?? "").trim().toLowerCase() === needle,
    ) ??
    null
  );
}

function cleanPathCandidate(raw: string | undefined): string | null {
  const cleaned = raw?.trim().replace(/^`|`$/g, "").replace(/[),.;]+$/g, "");
  if (!cleaned || !path.isAbsolute(cleaned)) return null;
  return cleaned;
}

export function inferWorkingFolderFromPrompt(prompt: string): string | null {
  const explicit = prompt.match(
    /(?:(?:project|working|workspace|target|output)?\s*(?:folder|directory|dir)|(?:작업|프로젝트|워크스페이스|대상|출력)\s*(?:루트|폴더|디렉터리|경로))\s*(?:only|전용|만)?[^/]*(\/(?:Volumes|Users|tmp|private\/tmp)\/[^\s`"'<>]+)/i,
  );
  const candidate = cleanPathCandidate(explicit?.[1]);
  if (!candidate) return null;
  try {
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch (err) {
    console.error("[workspace] failed to create inferred working folder:", err);
    return null;
  }
}

function refreshCareerGraphInBackground(projectPath: string, sink: EventSink, locale: "ko" | "en"): void {
  let key: string;
  try {
    key = path.resolve(projectPath);
  } catch {
    return;
  }
  if (careerGraphRefreshTriggered.has(key)) return;
  careerGraphRefreshTriggered.add(key);
  void careerGraphIngest(key, { cwd: key, timeoutMs: 20_000 })
    .then((res) => {
      if (!res.ok) return;
      const counts = (res.json as { nodes?: number; edges?: number } | null) ?? {};
      sink({
        kind: "tool-use",
        status:
          locale === "ko"
            ? `Career Graph 색인 갱신: nodes=${counts.nodes ?? "?"}, edges=${counts.edges ?? "?"}`
            : `Career Graph refreshed: nodes=${counts.nodes ?? "?"}, edges=${counts.edges ?? "?"}`,
      });
    })
    .catch(() => {
      // Best-effort only. The canonical Markdown/JSONL files remain readable.
    });
}

function buildAppEditUserPrompt(prompt: string, appRecord: AppFactoryAppRecord, locale: "ko" | "en"): string {
  const appRoute = `/apps/generated?id=${appRecord.id}`;
  const manifestJson = JSON.stringify(appRecord.manifest, null, 2).slice(0, 7000);
  const guide =
    locale === "ko"
      ? [
          "기존 Agentlas 생성 App 수정 요청이다.",
          "새 App이나 새 Surface를 만들지 말고, 아래 App rootPath의 기존 구현 파일을 수정하라.",
          "사용자 저장 상태, 편집본, 데이터 파일은 보존하고 필요한 변경만 적용하라.",
          "수정 뒤 가능하면 타입체크/스모크/렌더 검증을 실행하고 결과를 짧게 한국어로 보고하라.",
        ].join("\n")
      : [
          "This is an edit request for an existing generated Agentlas App.",
          "Do not create a new App or new Surface. Modify the existing implementation under the App rootPath below.",
          "Preserve saved state, user edits, and data files; apply only the requested changes.",
          "After editing, run a focused typecheck/smoke/render verification when practical and report briefly.",
        ].join("\n");
  return [
    guide,
    "",
    `App id: ${appRecord.id}`,
    `App name: ${appRecord.appName}`,
    `Apps registry route: ${appRoute}`,
    `Root path: ${appRecord.rootPath}`,
    `Launch URL: ${appRecord.scaffold.launchUrl || appRecord.previewPath}`,
    `Dev command: ${appRecord.scaffold.devCommand || "node scripts/serve.mjs"}`,
    `Preview path: ${appRecord.previewPath}`,
    `Status: ${appRecord.status}`,
    "",
    "Current manifest:",
    manifestJson,
    "",
    `User edit request:\n${prompt}`,
    "",
    locale === "ko"
      ? `완료 후 CTA: [Apps에서 확인하기](${appRoute})`
      : `Finish with CTA: [Open in Apps](${appRoute})`,
  ].join("\n");
}

function hasPriorConversationContext(chatId: string): boolean {
  return listChatMessages(chatId, 4).some(
    (m) => (m.role === "user" || m.role === "assistant") && Boolean((m.text ?? "").trim()),
  );
}

function buildGoalUserPrompt(prompt: string, locale: "ko" | "en"): string {
  const guide =
    locale === "ko"
      ? [
          "Agentlas Goal mode가 켜져 있다.",
          "사용자의 문장을 단발 요청이 아니라 달성할 목표로 다뤄라.",
          "목표를 명확히 재정의하고, 바로 실행할 다음 행동과 검증 기준을 포함해 진행하라.",
        ].join("\n")
      : [
          "Agentlas Goal mode is enabled.",
          "Treat the user's message as a goal to pursue, not as a one-off request.",
          "Restate the goal clearly, proceed with the next concrete action, and include verification criteria.",
        ].join("\n");
  return `${guide}\n\nUser goal:\n${prompt}`;
}

function buildPlanUserPrompt(prompt: string, locale: "ko" | "en"): string {
  const guide =
    locale === "ko"
      ? [
          "Agentlas Plan mode가 켜져 있다.",
          "바로 실행으로 뛰어들기 전에 사용자에게 읽히는 짧은 작업 계획을 먼저 세워라.",
          "계획에는 작업 순서, 실제 확인할 증거, 위험하거나 아직 모르는 부분을 포함하라.",
          "필요한 실행은 계획 뒤에 이어서 하되, 완료라고 말할 때는 실제 검증 결과를 함께 말하라.",
        ].join("\n")
      : [
          "Agentlas Plan mode is enabled.",
          "Before jumping into execution, first write a concise user-facing work plan.",
          "Include the order of work, the evidence you will verify, and any risks or unknowns.",
          "Then proceed when appropriate, and only call the work complete with real verification results.",
        ].join("\n");
  return `${guide}\n\nUser request:\n${prompt}`;
}

function buildRecommendedPipelineUserPrompt(prompt: string, stages: RecStage[], locale: "ko" | "en"): string {
  const stageLines = stages
    .map((stage) =>
      [
        `${stage.order}. ${stage.kind}`,
        stage.agentId ? `agent: ${stage.agentName ?? stage.agentId} (${stage.agentId})` : undefined,
        stage.consumes?.length ? `consumes: ${stage.consumes.join(", ")}` : undefined,
        stage.produces?.length ? `produces: ${stage.produces.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
  const guide =
    locale === "ko"
      ? [
          "Agentlas 추천 파이프라인 모드가 켜져 있다.",
          "아래 stage들을 단순 장식이 아니라 실행 계약으로 취급하라.",
          "먼저 각 stage에 들어갈 input packet을 정하라: inputType, inputKind, brief, consumes, expectedOutput, constraints.",
          "각 stage의 산출물을 다음 stage 입력으로 넘기고, 마지막에 하나의 사용자 답변으로 종합하라.",
          "실제로 별도 로컬/Hub 에이전트를 호출할 수 없는 stage가 있으면, 그 한계를 숨기지 말고 현재 런타임의 오케스트레이션으로 처리했다고 표시하라.",
        ].join("\n")
      : [
          "Agentlas recommended pipeline mode is enabled.",
          "Treat the stages below as an execution contract, not visual decoration.",
          "First define each stage input packet: inputType, inputKind, brief, consumes, expectedOutput, and constraints.",
          "Carry each stage output into the next stage, then synthesize one final answer for the user.",
          "If a stage cannot call a separate local/Hub agent, say so plainly and execute it as orchestration inside the current runtime.",
        ].join("\n");
  return [guide, "", "Recommended stages:", stageLines, "", "User request:", prompt].join("\n");
}

/**
 * 추천 시트 네트워크 모드에서 고른 Hub 에이전트를 hep-call 로 빌려와(BYOM) 프롬프트 앞에
 * borrow 지시를 붙인다. BYOC 라 실행은 데스크탑 런타임(사용자 LLM)이 한다 — 엔진은 빌려올
 * 에이전트와 grounding 만 제공한다. 명시적 Hub 호출이 실패하거나 실제 bundle 지시문을
 * 반환하지 않으면 로컬 런타임이 그 에이전트를 흉내 내지 못하도록 fail-closed 한다.
 */
async function buildBorrowUserPreamble(
  slugs: string[],
  prompt: string,
  project: string | null,
  locale: "ko" | "en",
  signal?: AbortSignal,
  versions?: Record<string, string>,
): Promise<{ preamble: string; specs: BorrowedAgentSpec[] }> {
  const list = slugs.join(", ");
  let specs: BorrowedAgentSpec[];
  try {
    const hasPinnedVersion = slugs.some((slug) => Boolean(versions?.[slug]));
    if (hasPinnedVersion) {
      // A packageHash pin belongs to one slug. Calling a comma-separated set with one
      // --version would incorrectly apply that hash to every package, so pinned requests
      // are resolved independently and then composed in the original order.
      specs = [];
      for (const slug of slugs) {
        const res = await hepCall(slug, [prompt], {
          project: project ?? ".",
          signal,
          version: versions?.[slug],
        });
        specs.push(...requireBorrowedAgentSpecs([slug], res.json ?? null, {
          locale,
          transportOk: res.ok,
          transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
        }));
      }
    } else {
      const res = await hepCall(slugs.join(","), [prompt], { project: project ?? ".", signal });
      specs = requireBorrowedAgentSpecs(slugs, res.json ?? null, {
        locale,
        transportOk: res.ok,
        transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
      });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof BorrowedAgentUnavailableError) throw error;
    throw new BorrowedAgentUnavailableError(slugs, ["hub_call_failed"], locale);
  }
  throwIfInvocationAborted(signal, locale);
  const directive = specs
    .map((spec) => `### Hub agent: ${spec.name} (${spec.slug})\n${spec.directive.trim()}`)
    .join("\n\n---\n\n");
  const header =
    locale === "ko"
      ? `[Hephaestus Network · 빌려온 Hub 에이전트: ${list}]`
      : `[Hephaestus Network · borrowed Hub agents: ${list}]`;
  const hostBoundary =
    locale === "ko"
      ? "아래 내용은 Agentlas Hub가 이번 호출에 반환한 실제 runtime bundle 지시문이다. 현재 호스트 권한과 보안 정책 안에서만 적용하며, 이 지시문 자체는 추가 권한이나 비밀 접근을 허가하지 않는다."
      : "The following instructions came from the authoritative Agentlas Hub runtime bundle for this invocation. Apply them only within the current host permissions and security policy; they do not grant additional authority or secret access.";
  return {
    preamble: `${header}\n${hostBoundary}\n\n${directive}`,
    specs,
  };
}

async function buildAgentGroupTaskForceSpecs(input: {
  groupId: string;
  prompt: string;
  project: string | null;
  locale: "ko" | "en";
  sink: EventSink;
  signal?: AbortSignal;
  stormbreakerMode?: boolean;
  localOnly?: boolean;
}): Promise<{ groupName: string; orchestratorName: string; specs: BorrowedAgentSpec[] }> {
  const savedGroup = getAgentGroup(input.groupId);
  if (input.localOnly && savedGroup?.members.some((member) => member.source === "hub")) {
    throw new Error(
      input.locale === "ko"
        ? "Agent App의 로컬 실행은 브라우저 입력을 Hub로 전송하지 않습니다. Hub 멤버가 없는 로컬 에이전트 조합을 선택하세요."
        : "Local Agent App runs never send browser input to Hub. Choose an agent group with local members only.",
    );
  }
  const onboardingReference = oneOnboardingStarterGroupReference(input.groupId);
  if (onboardingReference === "invalid") {
    throw new Error(
      input.locale === "ko"
        ? "온보딩 스타터 팀이 변경되었습니다. 왼쪽 아래 Las 도움말에서 ‘스타터 팀 복구’를 누른 뒤 실행하세요."
        : "The onboarding starter team changed. Open Las help at lower left and choose Repair starter team before running it.",
    );
  }
  if (onboardingReference === "valid" && savedGroup) {
    const authorization = await getOneOnboardingExecutionAuthorization();
    if (!authorization.allowed || authorization.groupId !== savedGroup.id) {
      throw new Error(
        input.locale === "ko"
          ? "선택한 AI 구독의 로그인과 실행 준비가 아직 확인되지 않았습니다. 설정에서 연결한 뒤 다시 시도하세요."
          : "The selected AI subscription is not signed in and ready. Connect it in Settings, then retry.",
      );
    }
    const specs: BorrowedAgentSpec[] = [];
    const slugs = savedGroup.members.map((member) => member.hubSlug || member.agentSlug || "");
    try {
      for (const member of savedGroup.members) {
        const slug = member.hubSlug || member.agentSlug || "";
        const version = member.snapshot.packageHash;
        const res = await hepCall(slug, [input.prompt], {
          project: input.project ?? ".",
          signal: input.signal,
          version,
        });
        const [spec] = requireBorrowedAgentSpecs([slug], res.json ?? null, {
          locale: input.locale,
          transportOk: res.ok,
          transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
        });
        if (!spec) throw new BorrowedAgentUnavailableError([slug], [`missing_directive:${slug}`], input.locale);
        if (member.hubEntityKind === "team" && !spec.executionGraph) {
          throw new BorrowedAgentUnavailableError([slug], ["team_execution_graph_unavailable"], input.locale);
        }
        specs.push({
          ...spec,
          entityKind: member.hubEntityKind === "team" ? "team" : "agent",
          source: "hub",
          routeLabel: "Hub · pinned onboarding starter",
          warnings: [],
        });
      }
    } catch (error) {
      if (input.signal?.aborted || error instanceof BorrowedAgentUnavailableError) throw error;
      throw new BorrowedAgentUnavailableError(slugs, ["hub_call_failed"], input.locale);
    }
    throwIfInvocationAborted(input.signal, input.locale);
    return {
      groupName: savedGroup.name,
      orchestratorName: savedGroup.orchestratorName,
      specs,
    };
  }
  const resolved = await resolveAgentGroupForRuntime(input.groupId, { allowHub: !input.localOnly });
  if (!resolved) {
    throw new Error(
      input.locale === "ko"
        ? `에이전트 조합을 찾을 수 없습니다: ${input.groupId}`
        : `Agent group not found: ${input.groupId}`,
    );
  }
  for (const skipped of resolved.skipped) {
    input.sink({
      kind: "tool-use",
      status:
        input.locale === "ko"
          ? `조합 멤버 제외: ${skipped.name} (${skipped.warnings.join(", ")})`
          : `Skipped group member: ${skipped.name} (${skipped.warnings.join(", ")})`,
    });
  }
  const skippedHubMembers = resolved.skipped.filter((member) => member.source === "hub");
  if (skippedHubMembers.length > 0) {
    const skippedById = new Map(resolved.group.members.map((member) => [member.id, member]));
    const slugs = skippedHubMembers.map((member) => {
      const saved = skippedById.get(member.id);
      return saved?.hubSlug || saved?.agentSlug || member.name;
    });
    const reasons = skippedHubMembers.flatMap((member, index) =>
      member.warnings.map((warning) => `${slugs[index]}:${warning}`),
    );
    throw new BorrowedAgentUnavailableError(slugs, reasons, input.locale);
  }
  const hubMembers = resolved.members.filter((member) => member.source === "hub");
  const hubSlugs = hubMembers.map((member) => member.slug);
  let hubSpecs = new Map<string, BorrowedAgentSpec>();
  if (hubSlugs.length > 0) {
    try {
      const hasPinnedVersion = hubMembers.some((member) => Boolean(member.packageHash));
      if (hasPinnedVersion) {
        const specs: BorrowedAgentSpec[] = [];
        for (const member of hubMembers) {
          const res = await hepCall(member.slug, [input.prompt], {
            project: input.project ?? ".",
            signal: input.signal,
            version: member.packageHash,
          });
          specs.push(...requireBorrowedAgentSpecs([member.slug], res.json ?? null, {
            locale: input.locale,
            transportOk: res.ok,
            transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
          }));
        }
        hubSpecs = new Map(specs.map((spec) => [spec.slug, spec]));
      } else {
        const res = await hepCall(hubSlugs.join(","), [input.prompt], {
          project: input.project ?? ".",
          signal: input.signal,
        });
        hubSpecs = new Map(requireBorrowedAgentSpecs(hubSlugs, res.json ?? null, {
          locale: input.locale,
          transportOk: res.ok,
          transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
        }).map((spec) => [spec.slug, spec]));
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (error instanceof BorrowedAgentUnavailableError) throw error;
      throw new BorrowedAgentUnavailableError(hubSlugs, ["hub_call_failed"], input.locale);
    }
    throwIfInvocationAborted(input.signal, input.locale);
  }
  const specs = resolved.members.map((member): BorrowedAgentSpec => {
    const hub = member.source === "hub" ? hubSpecs.get(member.slug) : null;
    if (member.source === "hub" && !hub) {
      throw new BorrowedAgentUnavailableError([member.slug], [`missing_directive:${member.slug}`], input.locale);
    }
    if (member.source === "hub" && member.entityKind === "team" && !hub?.executionGraph) {
      throw new BorrowedAgentUnavailableError([member.slug], ["team_execution_graph_unavailable"], input.locale);
    }
    return {
      slug: member.slug,
      name: hub?.name || member.name,
      directive: member.source === "hub" ? hub!.directive : member.directive,
      entityKind: member.entityKind === "team" ? "team" : "agent",
      source: member.source,
      routeLabel: member.routeLabel,
      warnings: member.warnings,
      installedAgentId: member.installedAgentId,
      firmId: member.firmId,
      agentDefinitionId: hub?.agentDefinitionId,
      agentReleaseId: hub?.agentReleaseId,
      packageHash: hub?.packageHash,
      localized: hub?.localized,
      executionGraph: hub?.executionGraph,
    };
  });
  if (specs.length === 0) {
    throw new Error(
      input.locale === "ko"
        ? "이 에이전트 조합에는 현재 실행 가능한 멤버가 없습니다."
        : "This agent group has no runnable members right now.",
    );
  }
  return {
    groupName: resolved.group.name,
    orchestratorName: resolved.group.orchestratorName,
    specs,
  };
}

function orchestrationTargetKey(target: OrchestrationTarget): string {
  if (target.source === "local") {
    if (target.entityKind === "agent") return `local:agent:${target.agentId}`;
    if (target.entityKind === "team") return `local:team:${target.firmId}`;
    return `local:group:${target.groupId}`;
  }
  return `${target.source}:${target.entityKind}:${target.slug.trim().toLowerCase()}`;
}

function requireOrchestrationTargets(value: unknown): OrchestrationTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("A task force requires between 1 and 32 exact targets.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid task-force target at index ${index}.`);
    }
    const target = raw as Record<string, unknown>;
    const source = target.source;
    const entityKind = target.entityKind;
    if (source === "local" && entityKind === "agent" && typeof target.agentId === "string" && target.agentId.trim()) {
      return { source, entityKind, agentId: target.agentId.trim() };
    }
    if (source === "local" && entityKind === "team" && typeof target.firmId === "string" && target.firmId.trim()) {
      return { source, entityKind, firmId: target.firmId.trim() };
    }
    if (source === "local" && entityKind === "group" && typeof target.groupId === "string" && target.groupId.trim()) {
      return { source, entityKind, groupId: target.groupId.trim() };
    }
    if (
      (source === "cloud" || source === "hub") &&
      (entityKind === "agent" || entityKind === "team") &&
      typeof target.slug === "string" &&
      target.slug.trim()
    ) {
      return { source, entityKind, slug: target.slug.trim() };
    }
    throw new Error(`Invalid task-force target at index ${index}.`);
  });
}

async function buildStructuredTaskForceSpecs(input: {
  targets: OrchestrationTarget[];
  prompt: string;
  project: string | null;
  locale: "ko" | "en";
  signal?: AbortSignal;
  /** Main-owned One snapshot. When present, local directives must not re-read disk. */
  localEffectivePrompts?: ReadonlyMap<string, OneParticipantEffectivePromptSnapshot>;
}): Promise<BorrowedAgentSpec[]> {
  if (input.targets.length === 0 || input.targets.length > 32) {
    throw new Error("A task force requires between 1 and 32 exact targets.");
  }
  const seen = new Set<string>();
  const targets = input.targets.filter((target) => {
    const key = orchestrationTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const specs: BorrowedAgentSpec[] = [];
  for (const target of targets) {
    if (target.source === "local" && target.entityKind === "agent") {
      const locator = target.agentId.split("/").pop() || target.agentId;
      const matches = listInstalledAgents().filter((candidate) => candidate.id === target.agentId || candidate.slug === locator);
      const agent = matches.length === 1 ? matches[0] : null;
      if (!agent) throw new Error(`Installed agent is unavailable: ${target.agentId}`);
      if (agent.kind === "team") {
        throw new Error(`Installed team package must resolve to a Team/Firm target: ${target.agentId}`);
      }
      const frozenPrompt = input.localEffectivePrompts
        ? exactOneParticipantEffectivePrompt(input.localEffectivePrompts, agent.id, agent.slug)
        : null;
      if (input.localEffectivePrompts && frozenPrompt === null) {
        throw new Error(`Installed agent is outside the exact One prompt snapshot: ${target.agentId}`);
      }
      specs.push({
        slug: `installed:${agent.slug}`,
        name: agent.nameEn || agent.name,
        directive: frozenPrompt ?? buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt),
        entityKind: "agent",
        source: "installed",
        routeLabel: "Installed",
        installedAgentId: agent.id,
      });
      continue;
    }
    if (target.source === "local" && target.entityKind === "team") {
      const locator = target.firmId.split("/").pop() || target.firmId;
      const matches = listFirms().filter((candidate) => candidate.id === target.firmId || candidate.slug === locator);
      const firm = matches.length === 1 ? matches[0] : null;
      if (!firm) throw new Error(`Installed team is unavailable: ${target.firmId}`);
      specs.push({
        slug: `firm:${firm.slug}`,
        name: firm.nameEn || firm.name,
        directive: `Preserve the installed team hierarchy for ${firm.nameEn || firm.name}.`,
        entityKind: "team",
        source: "firm",
        routeLabel: "Installed Team",
        installedAgentId: firm.ceoAgentId,
        firmId: firm.id,
      });
      continue;
    }
    if (target.source === "local" && target.entityKind === "group") {
      const matches = listAgentGroups().filter((candidate) => candidate.id === target.groupId);
      const group = matches.length === 1 ? matches[0] : null;
      if (!group) throw new Error(`Agent group is unavailable: ${target.groupId}`);
      specs.push({
        slug: `group:${group.id}`,
        name: group.name,
        directive: `Use the saved Agent Group orchestrator "${group.orchestratorName}" and preserve its member boundaries.`,
        entityKind: "group",
        source: "group",
        routeLabel: "Agent Group",
        groupId: group.id,
      });
      continue;
    }
    // Exact Core selector keeps scope + entity kind + slug through Hub lookup.
    const ref = `${target.source}/${target.entityKind}/${target.slug}`;
    const res = await hepCall(ref, [input.prompt], { project: input.project ?? ".", signal: input.signal });
    const [remote] = requireBorrowedAgentSpecs([target.slug], res.json ?? null, {
      locale: input.locale,
      transportOk: res.ok,
      transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
    });
    if (!remote) throw new BorrowedAgentUnavailableError([target.slug], ["missing_directive"], input.locale);
    if (!remote.entityKind || remote.entityKind !== target.entityKind) {
      throw new BorrowedAgentUnavailableError(
        [target.slug],
        [`entity_kind_mismatch:${remote.entityKind ?? "unproven"}->${target.entityKind}`],
        input.locale,
      );
    }
    if (target.entityKind === "team" && !remote.executionGraph) {
      throw new BorrowedAgentUnavailableError([target.slug], ["team_execution_graph_unavailable"], input.locale);
    }
    specs.push({
      ...remote,
      entityKind: target.entityKind,
      source: target.source,
      routeLabel: target.source === "cloud" ? "Agent Cloud" : "Hub",
    });
  }
  return specs;
}

function selectAppBuilderForExistingAppEdit(
  agents: InstalledAgent[],
  locale: "ko" | "en",
): AutoRouteChoice | null {
  const agent = agents.find((candidate) => candidate.slug === APP_BUILDER_SLUG);
  if (!agent) return null;
  return {
    agent,
    reason:
      locale === "ko"
        ? "기존 Agentlas App 수정 요청이라 숨은 App Builder 라우트를 선택했습니다"
        : "the request edits an existing Agentlas App, so Agentlas selected the hidden App Builder route",
    matchedTerms: ["existing-app-edit"],
  };
}

function selectAppBuilderForAppsGenerate(
  agents: InstalledAgent[],
  locale: "ko" | "en",
): AutoRouteChoice | null {
  const agent = agents.find((candidate) => candidate.slug === APP_BUILDER_SLUG);
  if (!agent) return null;
  return {
    agent,
    reason:
      locale === "ko"
        ? "사용자가 Apps Generate 모드를 명시적으로 켜서 숨은 App Builder 라우트를 선택했습니다"
        : "the user explicitly enabled Apps Generate mode, so Agentlas selected the hidden App Builder route",
    matchedTerms: ["apps-generate-mode"],
  };
}

function buildRouterAgentEscalationPrompt(input: {
  routerAgent: RecRouterAgent;
  userPrompt: string;
  effectiveUserPrompt: string;
  locale: "ko" | "en";
  selectedAgent: InstalledAgent;
  autoRoute: AutoRouteChoice | null;
  borrowedAgents?: string[];
}): string {
  const context = input.routerAgent.context ?? {};
  const contextHasQuery = typeof context.query === "string" && context.query.trim().length > 0;
  const payload = {
    routerAgent: input.routerAgent.agent,
    reason: input.routerAgent.reason,
    locale: input.locale,
    query: contextHasQuery ? context.query : input.userPrompt,
    effectiveQuery: input.effectiveUserPrompt,
    deterministicContext: context,
    currentDesktopRoute: input.autoRoute
      ? {
          agentId: input.autoRoute.agent.id,
          slug: input.autoRoute.agent.slug,
          name: input.autoRoute.agent.nameEn || input.autoRoute.agent.name,
          reason: input.autoRoute.reason,
          matchedTerms: input.autoRoute.matchedTerms,
        }
      : {
          agentId: input.selectedAgent.id,
          slug: input.selectedAgent.slug,
          name: input.selectedAgent.nameEn || input.selectedAgent.name,
        },
    borrowedAgents: input.borrowedAgents ?? [],
  };
  return [
    input.routerAgent.directive ||
      "Resolve this low-confidence routing decision with the Router Agent before answering.",
    "",
    "Router escalation payload:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildRouterAgentSystemPreamble(input: {
  routerAgent: RecRouterAgent;
  userPrompt: string;
  effectiveUserPrompt: string;
  locale: "ko" | "en";
  selectedAgent: InstalledAgent;
  autoRoute: AutoRouteChoice | null;
  borrowedAgents?: string[];
}): { preamble: string; loadedModuleIds: string[] } | null {
  const agentId = input.routerAgent.agent.trim();
  if (!agentId || (agentId !== ROUTER_AGENT_ID && agentId !== ROUTER_SYSTEM_AGENT.id)) return null;
  const escalationPrompt = buildRouterAgentEscalationPrompt(input);
  const assembled = assembleSystemPrompt(ROUTER_SYSTEM_AGENT, escalationPrompt, {
    threshold: 0.4,
    maxModules: 2,
  });
  const preamble = [
    "## Agentlas Router Agent escalation",
    "",
    assembled.systemPrompt,
    "",
    "### Escalation directive",
    escalationPrompt,
  ].join("\n");
  return { preamble, loadedModuleIds: assembled.loadedModuleIds };
}

type AutomationRegistrationResult = {
  action: "created" | "updated";
  name: string;
  schedule: string;
  targetType: "agent" | "firm" | "hub";
  targetId: string;
  nextRunAt: string | null;
  graph: boolean;
};

function automationActionLabel(action: AutomationRegistrationResult["action"], locale: "ko" | "en"): string {
  if (locale === "ko") return action === "created" ? "등록" : "업데이트";
  return action === "created" ? "created" : "updated";
}

function automationRegistrationToolName(action: AutomationRegistrationResult["action"]): string {
  return action === "created" ? "automation.create" : "automation.update";
}

function automationRegistrationResultText(item: AutomationRegistrationResult, locale: "ko" | "en"): string {
  const action = automationActionLabel(item.action, locale);
  if (locale === "ko") {
    return `${item.name} ${action} 완료 · ${item.schedule}${item.graph ? " · 워크플로우 그래프 포함" : ""}`;
  }
  return `${item.name} ${action} · ${item.schedule}${item.graph ? " · workflow graph included" : ""}`;
}

function automationFinalSummary(items: AutomationRegistrationResult[], locale: "ko" | "en"): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => {
    const action = automationActionLabel(item.action, locale);
    const nextRun =
      item.nextRunAt && locale === "ko"
        ? ` · 다음 실행 ${item.nextRunAt}`
        : item.nextRunAt
          ? ` · next run ${item.nextRunAt}`
          : "";
    return `- ${item.name} · ${action} · ${item.schedule}${nextRun}`;
  });
  return locale === "ko"
    ? [`자동화 ${items.length}개를 설정했습니다.`, ...lines, "자동화 화면에서 바로 확인할 수 있습니다."].join("\n")
    : [`Set up ${items.length} automation${items.length === 1 ? "" : "s"}.`, ...lines, "You can review it in Automations."].join("\n");
}

function automationPermissionRequiredText(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "자동화는 저장하지 않았습니다. 쓰기 권한으로 다시 실행하세요."
    : "Automation was not saved. Run again with write permission.";
}

function appendAutomationSummary(text: string, summary: string): string {
  const trimmed = text.trim();
  if (!summary.trim()) return trimmed;
  if (!trimmed) return summary;
  return `${trimmed}\n\n${summary}`;
}

function isAutomationSetupRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const explicitAutomation =
    /자동화|오토메이션|예약|리마인드|반복|정기|cron|automation|automate|schedule|scheduled|recurring|reminder/.test(text);
  const setupVerb =
    /걸어|걸자|설정|등록|만들|추가|켜줘|해줘|해라|해놔|set\s*up|create|add|register|turn\s+on|remind/.test(text);
  const recurringCadence =
    /매일|매주|매월|매시간|매\s*아침|매\s*저녁|매\s*분기|daily|weekly|monthly|hourly|every\s+\w+|each\s+\w+/.test(text);
  return (explicitAutomation && setupVerb) || (recurringCadence && setupVerb);
}

function automationLivePrelude(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "자동화 요청을 확인하고 있습니다. 실행 주기와 작업 내용을 정리한 뒤 바로 등록까지 이어가겠습니다.\n\n"
    : "Checking the automation request. I will resolve the schedule and task details, then register it.\n\n";
}

/** 활성 런타임 + 러너를 한 번에 선택 (오케스트레이터/리졸버 공용). */
export async function pickActiveRunner(): Promise<
  { runner: Runner; label: string; active: RuntimeStatus } | null
> {
  const list = await detectRuntimes();
  const active = pickActive(list);
  if (!active) return null;
  const picked = pickRunner(active);
  if (!picked) return null;
  return { runner: picked.runner, label: picked.label, active };
}

/** Main-process-only invocation provenance. Never deserialize this from IPC/wire input.
 *  - automation / site-studio / trex: 무인 실행 — 질문에 답할 사람이 없다(unattended).
 *  - telegram: 원격 대화형 — 질문이 평문으로 전달되고 사용자가 다음 메시지로 답한다.
 *  context 미지정(undefined)은 렌더러/모바일 대화형 경로다. 새 헤드리스 통합은 반드시
 *  여기 source를 추가하고 넘겨라 — 안 넘기면 대화형으로 오인된다(fail-open). */
export interface InvocationExecutionContext {
  source: "automation" | "site-studio" | "telegram" | "trex";
  /** Main-owned workflow node identity; keeps Memory Tickets distinct within one parent run. */
  nodeId?: string;
  /** Durable logical graph occurrence shared by resume runs. */
  occurrenceId?: string;
  /**
   * Main-process-only checkpoint hook. It fires immediately after Hub response
   * validation and before any borrowed worker starts, closing the crash window
   * that a final invocation result alone would leave.
   */
  onWorkforcePrepareReceipt?: (receipt: WorkforcePrepareCheckpointReceipt) => void;
}

export interface McpInvocationResult {
  finalText?: string;
  tokens?: number;
  stormbreakerContinueRequested: boolean;
  resultFolder?: string;
  /** Trusted main-process metadata; never accepted from model/tool event text. */
  workforcePrepareReceipt?: WorkforcePrepareCheckpointReceipt;
}

/** 질문에 답할 사람이 없는 실행인가 — UNATTENDED_NO_ASK_DIRECTIVE 부착 기준. */
function isUnattendedExecution(executionContext?: InvocationExecutionContext): boolean {
  return (
    executionContext?.source === "automation" ||
    executionContext?.source === "site-studio" ||
    executionContext?.source === "trex"
  );
}

function oneTaskSurfaceRecipe(prompt: string, ko: boolean): string | null {
  if (/(?:여행|trip|itinerary)/i.test(prompt) && /(?:일정|동선|예산|schedule|route|budget)/i.test(prompt)) {
    return ko
      ? "이 여행 결과의 Surface에는 data.schedule={type:'timeline',items:[{title,detail,status,evidenceIds}]}와 widgets.timeline, data.costs={type:'pricing',currency:'KRW',limit,items:[{label,amount,verificationStatus,evidenceIds}]}와 widgets.cost-summary, data.checklist={type:'launch-checklist',items:[{label,status}]}와 widgets.launch-checklist를 반드시 각각 넣으세요. 숫자·날짜가 있는 일정/비용 항목에는 반드시 Surface evidence에 존재하는 id를 evidenceIds로 연결하고, 출처 없는 추정값에는 trust:'estimated'를 넣으세요. 일정·예산·체크리스트를 markdown이나 하나의 table로 합치지 마세요. 좌표를 실제로 확인했을 때만 data.routes={type:'routes',items:[{label,latitude,longitude,evidenceIds}]}와 widgets.map을 추가하세요."
      : "This travel Surface must separately include data.schedule={type:'timeline',items:[{title,detail,status,evidenceIds}]} with widgets.timeline, data.costs={type:'pricing',currency,limit,items:[{label,amount,verificationStatus,evidenceIds}]} with widgets.cost-summary, and data.checklist={type:'launch-checklist',items:[{label,status}]} with widgets.launch-checklist. Every schedule or cost item containing a number or date must reference ids that exist in Surface evidence; use trust:'estimated' for an unsupported estimate. Do not flatten the schedule, budget, and checklist into markdown or one table. Add data.routes={type:'routes',items:[{label,latitude,longitude,evidenceIds}]} with widgets.map only for coordinates actually verified.";
  }
  if (/(?:문제(?:집)?\s*해설|풀이|영어\s*(?:공부|회화|학습)|worksheet|study\s+plan|explain\s+the\s+(?:problem|answer))/i.test(prompt)) {
    return ko
      ? "학습 결과는 핵심 설명을 data.summary markdown으로, 풀이·학습 단계를 data.steps table로, 사용자가 할 일을 data.checklist launch-checklist로 분리하세요. 정답만 쓰지 말고 단계의 순서를 보존하세요."
      : "Separate the learning result into a concise data.summary markdown explanation, ordered data.steps table, and data.checklist launch-checklist for practice. Preserve the reasoning steps instead of returning only the answer.";
  }
  if (/(?:문서|워드|word\s+(?:문서|file|document)|report)/i.test(prompt)) {
    return ko
      ? "문서 결과는 data.summary markdown과, 실제 파일 생성에 성공한 경우에만 data.artifacts={type:'artifacts',items:[{label,type}]} 및 widgets.report를 사용하세요. 존재하지 않는 파일을 선언하지 마세요."
      : "Use data.summary markdown for the document result and data.artifacts={type:'artifacts',items:[{label,type}]} only when the file was actually created. Never declare a nonexistent file.";
  }
  if (/(?:엑셀|excel|스프레드시트|spreadsheet)/i.test(prompt)) {
    return ko
      ? "스프레드시트 결과는 실제 행·열을 data.table과 widgets.table로 보존하고, 실제 파일 생성에 성공한 경우에만 data.artifacts를 추가하세요."
      : "Preserve actual rows and columns in data.table with widgets.table, and add data.artifacts only if the spreadsheet file was actually created.";
  }
  if (/(?:사진|이미지|영상|비디오|photo|image|video)/i.test(prompt)) {
    return ko
      ? "미디어 결과는 실제 입력·생성 자산만 data.media와 widgets.asset-board로 보존하고, 자막·장면·출력 파일은 각각 별도 데이터로 두세요. 생성하지 않은 이미지를 미리보기처럼 선언하지 마세요."
      : "Use data.media with widgets.asset-board only for actual input or generated assets, keeping scenes, captions, and output files separate. Never declare media that was not created.";
  }
  return null;
}

function deterministicOneCompletionCopy(
  prompt: string,
  surface: AgentlasSurfaceManifest,
  locale: "ko" | "en",
): string {
  const types = new Set(Object.values(surface.data).map((dataset) => dataset.type));
  if (types.has("artifacts") || types.has("media")) {
    return locale === "ko"
      ? "요청한 결과와 파일을 준비했어요. 아래에서 바로 확인할 수 있어요."
      : "Your result and files are ready. You can review them below.";
  }
  if (types.has("timeline") || (/(?:여행|trip|itinerary)/i.test(prompt) && types.has("pricing"))) {
    return locale === "ko"
      ? "일정과 비용, 준비할 내용을 한눈에 정리했어요."
      : "I organized the schedule, costs, and preparations below.";
  }
  if (types.has("table")) {
    return locale === "ko"
      ? "확인한 내용과 비교 결과를 한눈에 정리했어요."
      : "I organized the checked details and comparison below.";
  }
  return locale === "ko"
    ? "필요한 결과만 보기 쉽게 정리했어요."
    : "I organized the result so it is easy to review.";
}

/**
 * Renderer → main IPC 진입점. chatId 기반.
 * 1) chat → agent + project lookup → system prompt 조립
 * 2) 사용자 메시지를 chat_messages에 영구화
 * 3) 활성 런타임 선택 → 러너에 위임
 */
export async function runMcpInvocation(
  req: McpInvocationRequest,
  sink: EventSink,
  signal?: AbortSignal,
  workspaceBinding?: InvocationWorkspaceBinding,
  executionContext?: InvocationExecutionContext,
): Promise<McpInvocationResult> {
  // 한 마이크로태스크 양보 — ipc:run 핸들러가 { runId }를 반환하고 렌더러가 이벤트 채널을
  // 구독한 뒤에야 sink가 발화하도록 보장한다. 이게 없으면 동기 early-return(no-chat/no-agent)
  // 에러가 구독 전에 발화돼 렌더러가 종료 이벤트를 놓치고 busy(정지 버튼)가 영구 고착된다.
  await Promise.resolve();
  // IPC runs already carry the renderer/main-owned id. Direct integrations (Telegram,
  // site generation, legacy scripts) still receive one internal identity so their
  // content-free memory curation receipts are not silently lost.
  if (!req.runId) req = { ...req, runId: `direct-${randomUUID()}` };
  if (req.agentAppMode) {
    // Browser-shaped input can never widen the main-owned Site runtime
    // authority. Normalize before any goal, Hub, routing, or App branch.
    req = {
      ...req,
      permissions: "read",
      toolMode: "auto",
      hubMode: "local-only",
      borrowAgents: [],
      taskForceTargets: undefined,
      pipelineStages: undefined,
      routerAgent: undefined,
      mcpBrowserProfileKey: undefined,
      planMode: false,
      goalMode: false,
      appsGenerateMode: false,
      targetAppId: undefined,
      targetAppAction: undefined,
      images: undefined,
    };
  }
  // Every caller, including legacy/direct integrations, crosses the same
  // fail-closed boundary. Unknown or omitted permission is read-only.
  const normalizedPermission = normalizeRemoteInvocationPermission(req.permissions);
  if (req.permissions !== normalizedPermission) req = { ...req, permissions: normalizedPermission };
  const canWrite = normalizedPermission === "write" || normalizedPermission === "full";
  // A Mobile run consumes only the main-owned snapshot captured at the Bridge
  // boundary. Revalidate after the async handoff and never consult the mutable
  // chat/project folder fields again for this run.
  const boundMobileWorkingFolder: string | null = workspaceBinding
    ? revalidateInvocationWorkspaceBinding(workspaceBinding)
    : null;
  const callerSink = sink;
  let runtimeAgentId: string | undefined;
  let finalTextFromSink = "";
  let resolvedResultFolder: string | undefined;
  let workforcePrepareReceipt: WorkforcePrepareCheckpointReceipt | undefined;
  sink = (rawEvent: McpInvocationEvent) => {
    const ev = redactOneAttachmentEvent(req, rawEvent);
    if (ev.kind === "final" && ev.text?.trim()) {
      finalTextFromSink = ev.text.trim();
    }
    callerSink(runtimeAgentId && !ev.runtimeAgentId ? { ...ev, runtimeAgentId } : ev);
  };
  const earlyResult = () => ({
    finalText: finalTextFromSink || undefined,
    stormbreakerContinueRequested: false,
    resultFolder: resolvedResultFolder,
    workforcePrepareReceipt,
  });
  const locale = pickLocale(req);
  const oneTeamExecutionPolicy = mainOneTeamExecutionPolicy(req);
  const boundOneTeamRuntime = mainOneTeamRuntimeBinding(req);
  if (oneTeamExecutionPolicy) {
    const exactLocalTargets = req.taskForceTargets?.every((target) =>
      target.source === "local" && target.entityKind === "agent");
    if (
      oneTeamExecutionPolicy === "confirmed_existing_roster"
      && (!boundOneTeamRuntime || !req.taskForceTargets?.length || !exactLocalTargets)
    ) {
      sink({
        kind: "error",
        error: {
          code: "one-team-binding-invalid",
          message: locale === "ko"
            ? "확정된 One 팀의 실행 바인딩이 유효하지 않아 실행을 중단했습니다."
            : "The confirmed One team binding is invalid, so execution was stopped.",
        },
      });
      return earlyResult();
    }
    if (
      oneTeamExecutionPolicy === "solo_locked"
      && /^\s*(?:\/?workforce\b|\/?hep-network\b)/i.test(req.userPrompt)
    ) {
      sink({
        kind: "error",
        error: {
          code: "one-team-preflight-required",
          message: locale === "ko"
            ? "외부 팀을 부르기 전에 One의 팀 제안과 명시적 확인이 필요합니다."
            : "One must show a team proposal and receive explicit confirmation before external recruitment.",
        },
      });
      return earlyResult();
    }
    if (
      oneTeamExecutionPolicy === "confirmed_external_workforce"
      && (!boundOneTeamRuntime || !/^\s*\/?workforce\b/i.test(req.userPrompt))
    ) {
      sink({
        kind: "error",
        error: {
          code: "one-workforce-binding-invalid",
          message: locale === "ko"
            ? "확인된 One Workforce 실행 바인딩이 유효하지 않아 시작하지 않았습니다."
            : "The confirmed One Workforce binding is invalid, so execution did not start.",
        },
      });
      return earlyResult();
    }
    req = {
      ...req,
      sessionRouting: false,
      hubMode: oneTeamExecutionPolicy === "confirmed_external_workforce" ? "hub-first" : "local-only",
      borrowAgents: [],
      borrowVersions: undefined,
      pipelineStages: undefined,
      routerAgent: undefined,
      taskForceTargets: oneTeamExecutionPolicy === "confirmed_existing_roster"
        ? req.taskForceTargets
        : undefined,
    };
  }
  const chat = getChat(req.chatId);
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return earlyResult();
  }
  // Freeze conversation state before this turn becomes durable. Every routing
  // decision and model history below must see only earlier turns; otherwise the
  // current request is duplicated as both history and the active user prompt.
  const history = req.agentAppMode ? [] : listChatMessages(chat.id, 80);
  const priorHistory = history;
  const hadPriorConversationContext = req.agentAppMode
    ? false
    : hasPriorConversationContext(chat.id);
  // Group, firm, borrowed-task-force, and Stormbreaker branches return before
  // the ordinary single-run persistence point. Keep the visible request durable
  // exactly once regardless of which executable orchestrator owns it.
  let userMessagePersisted = false;
  const persistUserMessage = () => {
    if (req.agentAppMode || userMessagePersisted) return;
    appendChatMessage(chat.id, "user", req.userPrompt);
    if (priorHistory.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);
    userMessagePersisted = true;
  };
  // The user's turn belongs to the conversation even when routing, provider
  // authentication, or a later authority check fails before model dispatch.
  // Persist it at the first safe point after the exact local chat is resolved;
  // later orchestration branches keep calling this idempotent helper.
  persistUserMessage();
  // A paired phone and a direct scheduled run use the normal Desktop runtime
  // contract. Multi-hop unattended orchestration has a narrower Main-authored
  // boundary below so planner/worker/synthesis output cannot smuggle memory
  // control events across hops without reducing direct Mobile/scheduled runs.
  const restrictedReadBoundary = false;
  const restrictedOrchestrationBoundary =
    executionContext?.source === "automation" && !canWrite;
  // An unattended read automation may work in its selected folder, but it must
  // not silently inherit mutable Desktop-only project notes, activated memory,
  // ontology, or project-scoped Experience. This is deliberately narrower than
  // `restrictedReadBoundary`: the selected runtime and its read tools remain
  // available, preserving Desktop/Mobile execution parity.
  const suppressMutableProjectContext =
    executionContext?.source === "automation" && !canWrite;
  // Permission still controls normal Desktop write authority. It is unrelated
  // to whether the request originated from a paired phone.
  const projectReadOnlyBoundary = !canWrite || restrictedReadBoundary;
  const suppressProjectBinding = executionContext?.source === "site-studio";
  // Site Studio owns a project-scoped hidden conversation, but that identity is
  // not authority to consume an arbitrary Desktop Project. Freeze the effective
  // project id once in Main so a stale/tampered chat row cannot re-enter through
  // context notes, Experience selection, firm delegation, or curation.
  const invocationProjectId = suppressProjectBinding || suppressMutableProjectContext
    ? null
    : chat.projectId;
  let agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return earlyResult();
  }
  const oneParticipantEffectivePrompts = oneTeamExecutionPolicy
    ? validatedOneParticipantEffectivePromptMap(mainOneParticipantExecutionSnapshot(req))
    : null;
  if (oneTeamExecutionPolicy) {
    const targetIds = oneTeamExecutionPolicy === "confirmed_existing_roster"
      ? (req.taskForceTargets ?? []).flatMap((target) =>
          target.source === "local" && target.entityKind === "agent" ? [target.agentId] : [])
      : [];
    const expectedIds = [agent.id, ...targetIds];
    const actualIds = oneParticipantEffectivePrompts
      ? [...oneParticipantEffectivePrompts.keys()]
      : [];
    const exactIds = new Set(expectedIds).size === expectedIds.length
      && [...expectedIds].sort().join("\u0000") === [...actualIds].sort().join("\u0000");
    const exactSlugs = exactIds && expectedIds.every((agentId) => {
      const liveAgent = getAgentById(agentId);
      const frozen = oneParticipantEffectivePrompts?.get(agentId);
      return Boolean(liveAgent && frozen && liveAgent.slug === frozen.agentSlug && liveAgent.kind !== "team");
    });
    if (!oneParticipantEffectivePrompts || !exactIds || !exactSlugs) {
      sink({
        kind: "error",
        error: {
          code: "one-participant-prompt-snapshot-invalid",
          message: locale === "ko"
            ? "확정된 One 참여자의 실행 프롬프트 스냅샷이 유효하지 않아 실행을 중단했습니다."
            : "The exact One participant prompt snapshot is invalid, so execution was stopped.",
        },
      });
      return earlyResult();
    }
  }
  const effectivePromptFor = (candidate: InstalledAgent): string => {
    if (!oneParticipantEffectivePrompts) {
      return buildEffectiveAgentSystemPrompt(candidate.id, candidate.systemPrompt);
    }
    const frozen = exactOneParticipantEffectivePrompt(
      oneParticipantEffectivePrompts,
      candidate.id,
      candidate.slug,
    );
    if (frozen === null) {
      throw new Error(`One participant prompt snapshot is unavailable: ${candidate.id}`);
    }
    return frozen;
  };
  runtimeAgentId = agent.id;
  const targetApp = req.targetAppId ? getAgentApp(req.targetAppId) : null;
  const isTargetAppEdit = Boolean(targetApp && req.targetAppAction === "edit");
  if (req.targetAppId && !targetApp) {
    sink({
      kind: "error",
      error: {
        code: "app-not-found",
        message:
          locale === "ko"
            ? `수정할 App을 찾을 수 없습니다: ${req.targetAppId}`
            : `Could not find the App to edit: ${req.targetAppId}`,
      },
    });
    return earlyResult();
  }
  let effectiveUserPrompt = isTargetAppEdit && targetApp
    ? buildAppEditUserPrompt(req.userPrompt, targetApp, locale)
    : req.goalMode
      ? buildGoalUserPrompt(req.userPrompt, locale)
      : req.planMode
        ? buildPlanUserPrompt(req.userPrompt, locale)
        : req.userPrompt;
  if (oneTeamExecutionPolicy) {
    const taskSurfaceRecipe = oneTaskSurfaceRecipe(req.userPrompt, locale === "ko");
    const lockedBoundary = locale === "ko"
      ? [
          "[Agentlas One 실행 경계]",
          oneTeamExecutionPolicy === "confirmed_existing_roster"
            ? "Main이 확정한 기존 설치 로스터만 사용하세요. 다른 에이전트나 팀을 검색·대여·채용하거나 결제를 시도하지 마세요."
            : oneTeamExecutionPolicy === "confirmed_external_workforce"
              ? "사용자가 이 요청에 필요한 Hub Workforce 편성과 실행을 확인했습니다. Hub가 검증하고 고정한 정확한 릴리스만 사용하고, 대체 후보를 조용히 끼워 넣지 마세요."
              : "이 요청은 단일 에이전트 실행입니다. 다른 에이전트나 팀을 검색·대여·채용하거나 결제를 시도하지 마세요.",
          "최종 답변에 '사용 에이전트:', '사용 스킬:' 같은 라우팅 보고를 쓰지 말고 사용자에게 필요한 답부터 바로 시작하세요.",
          "이 경계를 넓혀야 한다면 실행하지 말고 One에서 새 팀 검토가 필요하다고 알리세요.",
          `조사·비교·일정·문서·미디어처럼 구조화할 수 있는 최종 결과는 긴 평문으로 끝내지 말고, 검증한 사실과 출처를 담은 정확히 하나의 기계 판독 Surface를 답변 맨 끝에 ${SURFACE_OPEN_FENCE} JSON ${SURFACE_CLOSE_FENCE} 형식으로 반환하세요. "Agentlas Surface"라는 Markdown 제목이나 가짜 표로 대신하지 마세요. 비교는 data.table·widgets.table/source-matrix, 날짜별 일정은 data.timeline·widgets.timeline, 좌표가 확인된 이동 경로는 data.routes·widgets.map, 예산은 data.pricing의 currency·limit·items(label, amount, verificationStatus), 실제로 만든 파일만 data.artifacts를 사용하세요. 좌표·금액·파일을 추측해 채우지 마세요.`,
          "Surface의 제목·요약·data.summary에는 사용자가 받을 완성된 결론만 쓰세요. '이제 검색하겠습니다', 도구 호출 계획, 진행 상황, 메모리나 작업 폴더를 확인한 과정은 넣지 마세요. 반환 전에 추천 제목·설명·표의 제품명과 숫자가 서로 모순되지 않는지 다시 확인하세요.",
          "비교 표에는 choice 열을 두고 정확히 한 행만 recommended로 표시하세요. 추천 행을 포함한 모든 행은 사용자가 결정할 핵심 열을 구체적인 값이나 '확인하지 못함' 같은 정직한 상태로 채우세요. 대시(—), 빈칸, 임시 문구로 채우지 말고, 근거가 부족하면 추천을 단정하지 마세요. Surface 문자열 안에는 URL이나 Markdown 링크 문법을 넣지 말고 출처는 evidence에만 넣으세요.",
          ...(taskSurfaceRecipe ? [taskSurfaceRecipe] : []),
          "[/Agentlas One 실행 경계]",
        ].join("\n")
      : [
          "[Agentlas One execution boundary]",
          oneTeamExecutionPolicy === "confirmed_existing_roster"
            ? "Use only the exact existing installed roster confirmed by Main. Do not search for, borrow, recruit, or pay any other agent or team."
            : oneTeamExecutionPolicy === "confirmed_external_workforce"
              ? "The user confirmed Hub Workforce selection and execution for this request. Use only the exact releases validated and pinned by Hub, and never silently substitute another candidate."
              : "This is a single-agent run. Do not search for, borrow, recruit, or pay any other agent or team.",
          "Never include routing reports such as 'Agents used:' or 'Skills used:' in the final answer. Start directly with the answer the user needs.",
          "If the boundary is insufficient, stop and say that a new One team review is required.",
          `For a structured final result such as research, comparison, schedule, document, or media work, do not end with a long plain-text answer. Return exactly one machine-readable Surface at the very end in the form ${SURFACE_OPEN_FENCE} JSON ${SURFACE_CLOSE_FENCE}. Do not substitute a Markdown heading named "Agentlas Surface" or a fake text table. Use data.table with widgets.table/source-matrix for comparisons, data.timeline with widgets.timeline for dated plans, data.routes with widgets.map only for verified coordinates, data.pricing with currency, limit, and items(label, amount, verificationStatus) for budgets, and data.artifacts only for files that were actually created. Never invent coordinates, prices, or files to fill a Surface.`,
          "Write only the finished user-facing conclusion in the Surface title, summary, and data.summary. Never include future tool plans, progress narration, or checks of memory and work folders. Before returning, verify that the recommendation title, explanation, product names, and numbers in every table do not contradict one another.",
          "For a comparison table, include a choice column and mark exactly one row recommended. Fill every decision-critical cell in every row, including the recommended row, with a concrete value or an honest state such as 'not verified'. Never use dashes, blanks, or placeholder copy. If the evidence is insufficient, do not make a definitive recommendation. Put no URL or Markdown link syntax inside Surface strings; keep sources only in evidence.",
          ...(taskSurfaceRecipe ? [taskSurfaceRecipe] : []),
          "[/Agentlas One execution boundary]",
        ].join("\n");
    effectiveUserPrompt = `${lockedBoundary}\n\n${effectiveUserPrompt}`;
  }
  if (req.sessionRouting) {
    const incumbentRoster = [
      agent.nameEn || agent.name || agent.slug,
      ...chat.hiredAgents.map((card) => card.name || card.slug),
    ].filter(Boolean);
    const sessionRoutingPolicy = locale === "ko"
      ? [
          "[Agentlas 세션 팀 정책]",
          `현재 세션 팀: ${incumbentRoster.join(", ")}`,
          "이 팀이 요청을 수행할 수 있으면 그대로 수행하세요. 매 메시지마다 전역 에이전트를 검색하거나 다른 에이전트 이름을 끼워 넣지 마세요.",
          "현재 팀에 실제 역량·도구 공백이 있을 때만 사용 가능한 Agentlas Workforce/Hephaestus 도구로 Agent Hub 또는 Cloud에서 필요한 최소 인원만 동적으로 보강하세요.",
          "보강이 필요하면 이유와 새로 합류한 역할만 짧게 알리고, 관련 없는 휴면 에이전트는 언급하지 마세요.",
          "[/Agentlas 세션 팀 정책]",
        ].join("\n")
      : [
          "[Agentlas session-team policy]",
          `Current session team: ${incumbentRoster.join(", ")}`,
          "If this team can complete the request, keep it and execute. Do not globally search or inject unrelated agent names on every message.",
          "Only on a genuine capability or tool gap, use available Agentlas Workforce/Hephaestus tools to recruit the minimum required role from Agent Hub or Cloud.",
          "When recruiting, state the gap and the newly joined role briefly; never mention unrelated dormant agents.",
          "[/Agentlas session-team policy]",
        ].join("\n");
    effectiveUserPrompt = `${sessionRoutingPolicy}\n\n${effectiveUserPrompt}`;
  }
  // `/hep-network` now enters the host-LLM Agent Workforce Ontology path.
  // The old lexical recommendation path remains available only as the explicit
  // compatibility command `/hep-network --legacy`.
  const workforceCommand = parseWorkforceCommand(req.userPrompt, req.agentAppMode === true);
  const workforceBenchmarkMode = workforceCommand.kind === "workforce" && workforceCommand.benchmarkMode;
  let explicitWorkforceGoal = workforceCommand.kind === "workforce" ? workforceCommand.goal : null;
  const explicitNetworkGoal = workforceCommand.kind === "legacy-network" ? workforceCommand.goal : null;
  if (workforceCommand.kind !== "none") {
    const routedGoal = workforceCommand.goal;
    if (!routedGoal) {
      sink({
        kind: "error",
        error: {
          code: "hep-network-goal-required",
          message: locale === "ko" ? "Workforce에 실행할 요청을 입력하세요." : "Provide a goal for Workforce.",
        },
      });
      return earlyResult();
    }
    req = { ...req, userPrompt: routedGoal, borrowAgents: undefined, taskForceTargets: undefined };
    effectiveUserPrompt = routedGoal;
  }
  const borrowedAgentSlugs = [...new Set((req.borrowAgents ?? []).map((slug) => slug.trim()).filter(Boolean))];
  let explicitBorrowUserPreamble: string | null = null;
  let explicitBorrowSpecs: BorrowedAgentSpec[] = [];
  let explicitBorrowMemoryKeys: string[] = [];
  const explicitBorrowOwnerScopeKey = activeBorrowedOwnerScopeKey();
  if (req.pipelineStages && req.pipelineStages.length > 0) {
    effectiveUserPrompt = buildRecommendedPipelineUserPrompt(effectiveUserPrompt, req.pipelineStages, locale);
  }

  // 추천 시트 네트워크 모드(단일) — 고른 Hub 에이전트를 빌려와 프롬프트 앞에 borrow 지시를 붙인다(BYOM).
  // 2개 이상은 아래 Borrowed Task Force 실행기로 분기해 plan → parallel delegate → synthesize를 수행한다.
  const shouldPrepareBorrowPreamble =
    borrowedAgentSlugs.length > 0 &&
    (borrowedAgentSlugs.length === 1 || Boolean(chat.agentGroupId) || chat.kind === "division");
  if (shouldPrepareBorrowPreamble) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Hub 에이전트 빌리는 중: ${borrowedAgentSlugs.join(", ")}`
          : `Borrowing Hub agents: ${borrowedAgentSlugs.join(", ")}`,
    });
    try {
      const preparedBorrow = await buildBorrowUserPreamble(
        borrowedAgentSlugs,
        effectiveUserPrompt,
        workspaceBinding
          ? boundMobileWorkingFolder
          : suppressProjectBinding
            ? null
            : getChatWorkingFolder(chat.id),
        locale,
        signal,
        req.borrowVersions,
      );
      explicitBorrowUserPreamble = preparedBorrow.preamble;
      explicitBorrowSpecs = preparedBorrow.specs;
      explicitBorrowMemoryKeys = preparedBorrow.specs.map((spec) =>
        borrowedMemoryKey(spec.agentDefinitionId!, spec.agentReleaseId!)
      );
      // Saved Agent Groups have their own planner/worker system prompts, so pass the
      // already-verified Hub bundle into that orchestration request. Ordinary single
      // invocations attach the same user-level preamble to every immediate pass below.
      if (chat.agentGroupId) {
        effectiveUserPrompt = `${explicitBorrowUserPreamble}\n\nRequest:\n${effectiveUserPrompt}`;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      sink({ kind: "error", error: { code: "borrowed-agent-unavailable", message } });
      return earlyResult();
    }
  }

  const runtimes = await detectRuntimes();
  throwIfInvocationAborted(signal, locale);
  if (boundOneTeamRuntime && !oneTeamRuntimeBindingMatches(boundOneTeamRuntime, runtimes)) {
    sink({
      kind: "error",
      error: {
        code: "one-team-runtime-changed",
        message: locale === "ko"
          ? "팀 확인 후 활성 런타임이 바뀌었습니다. 현재 상태로 팀을 다시 검토해주세요."
          : "The active runtime changed after team confirmation. Review the team again against the current runtime.",
      },
    });
    return earlyResult();
  }
  const installedAgents = listInstalledAgents();
  // Agent Apps are request/response surfaces, not durable chat continuations.
  // An earlier browser request must not influence a later caller's routing.
  const hasPriorContext = hadPriorConversationContext;
  // plain 대화(인사/맞장구)는 라우팅 전체를 건너뛰고 기본 LLM이 즉답 — 전문 에이전트로
  // 잘못 위임되거나 아래 Hephaestus 에스컬레이션 선지연을 무는 엣지케이스를 없앤다.
  const plainConversation = !isTargetAppEdit && isPlainConversationalPrompt(req.userPrompt);
  const hubWorkforceRequested = shouldForceHubFirstWorkforce({
    agentAppMode: req.agentAppMode === true,
    hubMode: req.hubMode,
    borrowedAgentCount: borrowedAgentSlugs.length,
    plainConversation,
    targetAppEdit: isTargetAppEdit,
  });
  // Scheduled runs already carry an explicit target and their own Hub policy.
  // Applying the global chat auto-route here used to turn every default
  // `hub-allowed` automation into Workforce before the selected agent could run.
  const automaticWorkforceEligible = !oneTeamExecutionPolicy && !req.sessionRouting && shouldAutoEngageNetworkWorkforce({
    agentAppMode: req.agentAppMode === true,
    networkAutoEnabled: isNetworkAutoEnabled(),
    globalOrchestrator: isGlobalOrchestrator(agent),
    hasPriorContext,
    executionSource: executionContext?.source,
    prompt: req.userPrompt,
  });
  const preRouteProjectPath = suppressMutableProjectContext
    ? null
    : workspaceBinding
    ? boundMobileWorkingFolder
    : suppressProjectBinding
      ? null
      : getChatWorkingFolder(chat.id) ?? (
        invocationProjectId ? getProject(invocationProjectId)?.folderPath ?? null : null
      );
  const experiencePriors = new Map<string, ExperienceRoutingPrior>();
  if (!req.agentAppMode && !hasPriorContext && !plainConversation && isGlobalOrchestrator(agent)) {
    for (const candidate of installedAgents) {
      if (isGlobalOrchestrator(candidate)) continue;
      const candidateRuntime = req.runtimeSelection
        ? selectExactRuntime(runtimes, req.runtimeSelection)
        : selectRuntimeForTargets(runtimes, [{ scope: "agent", targetId: candidate.id }]);
      if (!candidateRuntime) continue;
      try {
        const prior = buildExperienceRoutingPrior({
          agentId: candidate.id,
          projectId: invocationProjectId,
          projectPath: preRouteProjectPath,
          environment: {
            platform: process.platform,
            arch: process.arch,
            runtimeKind: candidateRuntime.active.kind,
          },
          basePackageHash: candidate.packageHash ?? null,
          task: effectiveUserPrompt,
        });
        if (prior) experiencePriors.set(candidate.id, prior);
      } catch (error) {
        console.warn(`[experience] pre-route evidence unavailable for ${candidate.slug}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }
  const autoRoute = req.agentAppMode
    ? null
    : oneTeamExecutionPolicy || explicitWorkforceGoal || explicitNetworkGoal || hubWorkforceRequested || automaticWorkforceEligible
      ? null
    : req.sessionRouting
      ? null
    : isTargetAppEdit
    ? selectAppBuilderForExistingAppEdit(installedAgents, locale)
    : req.appsGenerateMode
      ? selectAppBuilderForAppsGenerate(installedAgents, locale)
    : hasPriorContext
      ? null
    : !plainConversation && isGlobalOrchestrator(agent)
      ? // 앱 생성 모드만 무매치 폴백 허용 — 일반 챗은 확신(이름/힌트급 매치) 없으면 위임하지 않고
        // 오케스트레이터가 그냥 답한다("사용 에이전트: PM Soul" 소음/오배정 반복 제거).
        selectAutoRoutedAgent(effectiveUserPrompt, installedAgents, locale, {
          allowFallback: false,
          experiencePriors,
        })
      : null;
  if (autoRoute) {
    agent = autoRoute.agent;
    runtimeAgentId = agent.id;
    sink({ kind: "tool-use", status: autoRouteStatus(autoRoute, locale) });
  }

  // 사용자가 프롬프트 안에 "project folder: /abs/path"처럼 명시하면, 채팅 워킹 폴더로
  // 자동 고정한다. firm 경로도 단일 에이전트 경로와 같은 cwd/MCP 구성을 받아야 한다.
  const existingWorkingFolder = workspaceBinding
    ? boundMobileWorkingFolder
    : suppressProjectBinding
      ? null
      : getChatWorkingFolder(chat.id);
  const projectWorkingFolder = workspaceBinding
    ? null
    : invocationProjectId
      ? getProject(invocationProjectId)?.folderPath ?? null
      : null;
  const inferredWorkingFolder =
    workspaceBinding || !canWrite || existingWorkingFolder || projectWorkingFolder
      ? null
      : inferWorkingFolderFromPrompt(req.userPrompt);
  if (inferredWorkingFolder) setChatWorkingFolder(chat.id, inferredWorkingFolder);
  const targetAppWorkingFolder = !workspaceBinding && !suppressProjectBinding && targetApp
    ? path.resolve(targetApp.rootPath)
    : null;
  const workingFolder: string | null = suppressProjectBinding
    ? null
    : workspaceBinding
      ? boundMobileWorkingFolder
      : targetAppWorkingFolder ?? existingWorkingFolder ?? projectWorkingFolder ?? inferredWorkingFolder;
  // Even a global chat executes in a concrete local folder. Persist it in the
  // run receipt so generated files do not become undiscoverable after reload.
  resolvedResultFolder = workingFolder ?? agentRunCwd();

  if (explicitNetworkGoal) {
    try {
      const routed = await routeOnly(explicitNetworkGoal, {
        project: workingFolder ?? undefined,
        hubOnly: true,
        scope: "network",
        timeoutMs: 12_000,
        signal,
      });
      throwIfInvocationAborted(signal, locale);
      const recommendation = normalizeRecommendation(routed.json, explicitNetworkGoal);
      const targets = recommendation.agents.map((candidate) => candidate.target);
      if (targets.length === 0) {
        throw new Error("Hephaestus Network returned no executable exact targets.");
      }
      req = { ...req, taskForceTargets: targets, borrowAgents: undefined };
      sink({
        kind: "tool-use",
        status: locale === "ko"
          ? `Hephaestus Network가 ${targets.length}개 실행 단위를 선택했습니다.`
          : `Hephaestus Network selected ${targets.length} execution unit(s).`,
      });
    } catch (error) {
      throwIfInvocationAborted(signal, locale);
      sink({ kind: "error", error: invocationFailure(req, "hep-network-route-failed", error) });
      return earlyResult();
    }
  }

  // 자동화 Hub 정책: 명시적인 Hub-first만 Workforce를 선행 구성한다.
  // hub-allowed(로컬 우선)는 선택된 에이전트를 먼저 실행하고, local-only는
  // 이 경로를 막는다. 정확한 Hub 대상은 borrowAgents 경로가 별도로 소유한다.
  if (!explicitWorkforceGoal && !explicitNetworkGoal && hubWorkforceRequested) {
    explicitWorkforceGoal = effectiveUserPrompt;
    sink({
      kind: "tool-use",
      status: locale === "ko"
        ? "Hub 자동화 요청을 Agent Workforce 온톨로지로 구성합니다."
        : "Building the Hub automation through Agent Workforce Ontology.",
    });
  }

  // ── Network auto escalation ──
  // 복합 요청의 자동 Network 개입도 lexical routerAgent 선택이 아니라 Workforce 경로를
  // 사용한다. 명시적으로 공급된 routerAgent는 기존 호환 실행을 위해 그대로 보존한다.
  let routerAgent = req.agentAppMode ? undefined : req.routerAgent;
  if (!explicitWorkforceGoal && !explicitNetworkGoal && !routerAgent && automaticWorkforceEligible) {
    explicitWorkforceGoal = effectiveUserPrompt;
    sink({
      kind: "tool-use",
      status: locale === "ko"
        ? "Network 자동 개입을 Agent Workforce 온톨로지로 구성합니다."
        : "Building the Network auto-route through Agent Workforce Ontology.",
    });
  }

  const runtimeTargets = [
    { scope: "agent" as const, targetId: agent.id },
    { scope: "firm" as const, targetId: chat.firmId },
  ];
  const runtimeChoice = req.runtimeSelection
    ? selectExactRuntime(runtimes, req.runtimeSelection)
    : req.agentAppMode
    ? selectAgentAppRuntimeForTargets(runtimes, runtimeTargets)
    : selectRuntimeForTargets(runtimes, runtimeTargets);
  if (!runtimeChoice) {
    sink({
      kind: "error",
      error: {
        code: req.runtimeSelection ? "pinned-runtime-unavailable" : "no-runtime",
        message: req.runtimeSelection
          ? `Pinned automation runtime is unavailable: ${req.runtimeSelection.kind}${req.runtimeSelection.model ? ` · ${req.runtimeSelection.model}` : ""}`
          : tStatus(locale, "errNoRuntime"),
      },
    });
    return earlyResult();
  }

  if (runtimeChoice.unavailableOverride) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `지정된 런타임(${runtimeChoice.unavailableOverride.selection.kind})을 찾지 못해 전역 활성 런타임으로 실행합니다.`
          : `The assigned runtime (${runtimeChoice.unavailableOverride.selection.kind}) is unavailable, so Agentlas is using the global active runtime.`,
    });
  }
  if (req.agentAppMode && "fallbackFromKind" in runtimeChoice && runtimeChoice.fallbackFromKind) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `${runtimeChoice.fallbackFromKind} 런타임은 Agent App 격리를 증명할 수 없어 안전한 무도구 런타임으로 실행합니다.`
          : `${runtimeChoice.fallbackFromKind} cannot prove Agent App isolation; using a safe stateless no-tool runtime.`,
    });
  }

  let active = runtimeChoice.active;
  let picked = runtimeChoice.picked;
  if (boundOneTeamRuntime && oneTeamRuntimeBinding(active).digest !== boundOneTeamRuntime.digest) {
    sink({
      kind: "error",
      error: {
        code: "one-team-runtime-selection-changed",
        message: locale === "ko"
          ? "확인한 런타임과 실제 실행 런타임이 달라 실행을 중단했습니다."
          : "The runtime selected for execution differs from the confirmed runtime, so execution was stopped.",
      },
    });
    return earlyResult();
  }
  if (!picked) {
    sink({
      kind: "error",
      error: {
        code: "no-runner",
        message: tStatus(locale, "errNoRunner", {
          kind: active.kind,
          backend: active.backend,
        }),
      },
    });
    return earlyResult();
  }
  if (explicitWorkforceGoal && !isWorkforceLeaderRuntimeAllowed(active.kind)) {
    sink({
      kind: "error",
      error: {
        code: "workforce-leader-runtime-unsupported",
        message: locale === "ko"
          ? `선택한 ${active.kind} 런타임은 Workforce 리더의 로컬 무권한 경계가 검증되지 않았습니다. 다른 모델로 몰래 대체하지 않고 실행을 중단했습니다.`
          : `The selected ${active.kind} runtime has no verified local no-authority boundary for the Workforce leader. Execution was stopped without a hidden model fallback.`,
      },
    });
    return earlyResult();
  }

  // Stormbreaker is an executable Goal/UltraCode mode, not only a prompt
  // suffix. Non-trivial explicit/automatic requests enter the bounded swarm
  // path. Agent App and restricted-read invocations must never enter it.
  // Slash input is a first-class Desktop surface, not merely a terminal alias.
  // Keep the historical no-slash chips working while accepting `/hep-storm`.
  const stormbreakerPrefix = /^\s*(?:\/?hep-storm|\/?hep-network\s+--stormbreaker|\/?stormbreaker)\b\s*/i;
  const explicitStormbreakerRequest = stormbreakerPrefix.test(req.userPrompt);
  const explicitStormbreakerGoal = explicitStormbreakerRequest
    ? req.userPrompt.replace(stormbreakerPrefix, "").trim() || req.userPrompt
    : req.userPrompt;
  const stormbreakerEngaged = !oneTeamExecutionPolicy && !req.agentAppMode && !restrictedReadBoundary && (
    chat.kind === "division" ||
    chat.continuousMode === true ||
    explicitStormbreakerRequest ||
    isStormbreakerAutoEnabled()
  );
  const stormbreakerSwarm =
    !oneTeamExecutionPolicy &&
    !req.agentAppMode &&
    !restrictedReadBoundary &&
    chat.kind !== "division" &&
    !chat.continuousMode &&
    (explicitStormbreakerRequest || isStormbreakerAutoEnabled()) &&
    // `/hep-storm` is a routing slug, not a trivial task. Classify the goal
    // after removing the explicit command so slash input reaches the same
    // executable swarm path as the Composer Stormbreaker chip.
    !isTrivialPrompt(explicitStormbreakerRequest ? explicitStormbreakerGoal : req.userPrompt);

  // ── MCP 툴 브리지 ──────────────────────────────────────────
  // Claude Code/Codex 러너에는 요청/에이전트 문맥으로 필요한 MCP 플러그인을 자동 선택한 뒤
  // 런타임별 설정으로 직렬화해 넘긴다. env가 필요한 플러그인은 vault 값이 있을 때만 자동 설치한다.
  let mcpConfigPath: string | undefined;
  let mcpAllowedTools: string[] | undefined;
  let mcpCodexConfigArgs: string[] | undefined;
  let mcpRuntimeEnv: Record<string, string> | undefined;
  let mcpAutoSelectionPrompt = "";
  const runtimeCanUseMcp =
    active.kind === "claude-code" ||
    active.kind === "codex" ||
    active.kind === "grok" ||
    active.kind === "ollama" ||
    active.kind === "lmstudio" ||
    active.kind === "mlx";
  const agentAppToolGrant = req.agentAppMode ? req.agentAppRuntimeToolGrant : undefined;
  let acceptedAgentAppInlineMcpConfig: string | undefined;
  const markAgentAppMcpRuntimeUnavailable = () => {
    if (agentAppToolGrant) agentAppToolGrant.runtimeStatus = "runtime-unavailable";
  };
  const agentAppCapabilityRuntimeEligible =
    req.agentAppMode &&
    "capabilityRuntimeEligible" in runtimeChoice &&
    runtimeChoice.capabilityRuntimeEligible === true;
  if (agentAppToolGrant && !agentAppCapabilityRuntimeEligible) {
    // Runtime selection can change between Site's JIT preflight and dispatch.
    // Degrade to the stateless no-tool path rather than passing the grant to a
    // runtime that cannot prove the exact capability boundary.
    markAgentAppMcpRuntimeUnavailable();
  } else if (agentAppToolGrant) {
    const toolSet = new Set(agentAppToolGrant.mcpAllowedTools);
    const exactTools =
      toolSet.size === agentAppToolGrant.mcpAllowedTools.length &&
      validSiteAgentAppMcpGrantTools(
        agentAppToolGrant.mcpAllowedTools,
        agentAppToolGrant.availableCatalogIds,
      );
    const exactCatalog = new Set(agentAppToolGrant.availableCatalogIds).size === agentAppToolGrant.availableCatalogIds.length;
    const runtimeEnvKeys = Object.keys(agentAppToolGrant.mcpRuntimeEnv);
    const exactEnvAliases = runtimeEnvKeys.length === 0;
    let exactConfig = false;
    try {
      acceptedAgentAppInlineMcpConfig = resolveSiteAgentAppInlineMcpConfigForDispatch(
        agentAppToolGrant,
        listInstalledMcpServers(),
      ) ?? undefined;
      exactConfig = Boolean(acceptedAgentAppInlineMcpConfig);
    } catch {
      exactConfig = false;
    }
    if (
      agentAppToolGrant.schemaVersion !== 1 ||
      agentAppToolGrant.runtimeStatus !== "prepared" ||
      !exactTools ||
      !exactCatalog ||
      !exactEnvAliases ||
      !exactConfig
    ) {
      // The MCP row/config may be removed or replaced after Site's JIT
      // preflight. Keep the Agent App itself available in stateless no-tool
      // mode and let finalDisclosure report the exact degraded capability.
      markAgentAppMcpRuntimeUnavailable();
    } else {
      agentAppToolGrant.runtimeStatus = "accepted";
      // Pass the compact canonical serialization derived from the exact bytes
      // just revalidated above so delayed firm/group execution never re-opens
      // a mutable preflight pathname. The Claude runner alone may snapshot
      // these exact bytes for a Windows `.cmd` invocation's argv ceiling.
      mcpConfigPath = acceptedAgentAppInlineMcpConfig;
      mcpAllowedTools = [...agentAppToolGrant.mcpAllowedTools];
      mcpRuntimeEnv = { ...agentAppToolGrant.mcpRuntimeEnv };
    }
  }
  // Workforce capability choice belongs to the same top host LLM that owns the
  // roster. The ordinary lexical auto-selector may search/install broad tools,
  // so it is never an authority source for an explicit Workforce execution.
  if (runtimeCanUseMcp && !req.agentAppMode && !oneTeamExecutionPolicy && canWrite && !explicitWorkforceGoal) {
    try {
      const autoSelectInput = {
        userPrompt: effectiveUserPrompt,
        systemPrompt: buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt),
        agentName: agent.nameEn || agent.name,
        workingFolder,
        toolMode: req.toolMode,
        hubMode: req.hubMode,
      };
      let selectedContext = await autoSelectMcpTools(autoSelectInput);
      // ── 실행 전 API 키 요청 게이트 (대화형 렌더러 런 전용) ──────────────
      // matched 도구가 missing-key면 렌더러 시트(mcp-key-request 이벤트)로 키를
      // 요청하고 제한 시간만큼만 기다린다. 값은 렌더러가 기존 env:set으로 vault에
      // 직접 저장하고, 여기로는 완료 신호만 돌아온다(mcp:supplyRunKeys).
      // 무인 실행(automation/site-studio/trex/telegram/agent-app)은 사람에게 절대
      // 블록되지 않는다 — interactive:false로 게이트 전체가 no-op.
      const keyGate = await runMcpKeyElicitationGate({
        runId: req.runId,
        // 데스크탑 렌더러 대화형 런만. workspaceBinding(모바일)은 시트를 렌더링할
        // 화면이 없으므로 제외 — 모바일 런이 120초 헛대기하는 일이 없어야 한다.
        interactive: !executionContext && !req.agentAppMode && !workspaceBinding,
        context: selectedContext,
        sink,
        signal,
        reselect: () => autoSelectMcpTools(autoSelectInput),
      });
      selectedContext = keyGate.context;
      if (keyGate.outcome !== "skipped") {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · credential request",
            // Value-free receipt: tool ids + outcome only, never key values.
            result: `${keyGate.outcome}: ${selectedContext.tools
              .filter((tool) => tool.state === "missing-key")
              .map((tool) => tool.id)
              .join(", ") || "all requested tools unlocked"}`,
          },
        });
      }
      mcpAutoSelectionPrompt = buildMcpAutoSelectionPrompt(selectedContext, {
        toolMode: req.toolMode,
        hubMode: req.hubMode,
      });
      if (keyGate.fallbackPrompt) {
        // 거절/시간초과 폴백 — 남은 도구들로 대안을 찾으라는 정직한 지시 블록.
        mcpAutoSelectionPrompt = `${mcpAutoSelectionPrompt}\n${keyGate.fallbackPrompt}`.trim();
      }
      if (selectedContext.hubPluginCount > 0 || selectedContext.localPluginCount > 0) {
        const hubCandidates =
          selectedContext.hubPlugins.length > 0
            ? `\nHub candidates: ${selectedContext.hubPlugins
                .map((plugin) => `${plugin.slug}: ${plugin.reason}`)
                .join("\n")}`
            : "";
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · universe",
            result: `${selectedContext.localPluginCount} local plugin/tool entries + ${selectedContext.hubPluginCount} Hub plugins${hubCandidates}`,
          },
        });
      }
      if (selectedContext.hubPluginError) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · Hub lookup",
            result: selectedContext.hubPluginError,
          },
        });
      }
      const selectedTools = selectedContext.tools;
      const installedTools = selectedTools.filter((tool) => tool.installed);
      const degradedTools = selectedTools.filter((tool) => tool.state !== "ready");
      if (
        req.toolMode === "browser" &&
        !selectedTools.some((tool) => tool.id === "agentlas-browser" && tool.state === "ready")
      ) {
        throw new Error(
          locale === "ko"
            ? "로그인된 Agentlas Browser 호스트를 확인할 수 없어 자동화를 실행하지 않았습니다. Agentlas Browser를 다시 연결한 뒤 재시도하세요."
            : "The authenticated Agentlas Browser host is unavailable. The automation was blocked before model execution; reconnect Agentlas Browser and retry.",
        );
      }
      if (installedTools.length > 0) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · auto-select",
            result: installedTools.map((tool) => `${tool.id}: ${tool.reason}`).join("\n"),
          },
        });
      }
      if (degradedTools.length > 0) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · degraded capabilities",
            // Value-free state receipt: never include an MCP error body because
            // remote servers may reflect a credential or private URL in it.
            result: degradedTools
              .map((tool) => `${tool.id}: ${tool.state}${tool.required ? " (required function only)" : ""}`)
              .join("\n"),
          },
        });
      }
      // Hub 후보 브리지 — resolve된 후보를 프롬프트 텍스트로 끝내지 않고 실제 서버로
      // 연결한다(원격 http/sse는 자동, stdio는 승인 대기로 등록). 실패는 런에 영향 없음.
      let hubBridgedServerIds: string[] = [];
      if (selectedContext.hubPlugins.length > 0) {
        try {
          const bridged = await bridgeHubPluginCandidates(selectedContext.hubPlugins);
          hubBridgedServerIds = bridged.liveServerIds;
          if (bridged.receipts.length > 0) {
            sink({
              kind: "tool-use",
              tool: {
                name: "Agentlas Plugins · Hub bridge",
                result: bridged.receipts
                  .map((receipt) =>
                    `${receipt.slug} → ${receipt.serverName} [${receipt.transport}] ${receipt.action}` +
                    (receipt.reason ? ` (${receipt.reason})` : ""))
                  .join("\n"),
              },
            });
          }
        } catch (bridgeError) {
          console.warn("[mcp] hub plugin bridge failed:", bridgeError);
        }
      }
      const cfg = await buildMcpConfigFile({
        ...(req.mcpBrowserProfileKey ? { browserProfileKey: req.mcpBrowserProfileKey } : {}),
        catalogIds: [...installedTools.map((tool) => tool.id), ...hubBridgedServerIds],
      });
      if (cfg) {
        mcpConfigPath = cfg.configPath;
        mcpAllowedTools = cfg.allowedTools;
        mcpCodexConfigArgs = cfg.codexConfigArgs;
        mcpRuntimeEnv = cfg.runtimeEnv;
      }
    } catch (err) {
      console.error("[mcp] buildMcpConfigFile failed:", err);
    }
  }

  const runnerEnv = req.agentAppMode
    ? { env: buildAgentAppRunnerEnv(process.env, mcpRuntimeEnv), injectedKeys: [] }
    : await buildRunnerEnv(agent, workingFolder ?? undefined, {
        restrictedReadBoundary,
      });
  const orchestrationRunnerEnv = restrictedOrchestrationBoundary
    ? restrictedRunnerEnv()
    : runnerEnv.env;
  throwIfInvocationAborted(signal, locale);
  if (mcpRuntimeEnv && !req.agentAppMode) Object.assign(runnerEnv.env, mcpRuntimeEnv);
  // Runtime detection/routing can take time. Check the capability again at the
  // last shared point before any direct, group, firm, swarm, or borrowed runner
  // can start. A deleted/replaced directory cannot inherit the earlier check.
  if (workspaceBinding) revalidateInvocationWorkspaceBinding(workspaceBinding);
  let coreStormbreakerHarnessPromise: ReturnType<typeof stormbreakerHarness> | null = null;
  const loadCoreStormbreakerHarness = () => {
    coreStormbreakerHarnessPromise ??= stormbreakerHarness({
      cwd: resolvedResultFolder,
      signal,
    });
    return coreStormbreakerHarnessPromise;
  };

  // ── Agent Workforce Ontology ────────────────────────────────
  // The active host model owns both the job-analysis work order and the final
  // semantic roster decision. Main calls Hub MCP only for content-only search,
  // deterministic validation, and exact immutable release preparation.
  if (explicitWorkforceGoal) {
    try {
      const workforceLeaderRunnerEvidence: WorkforceLeaderRunnerEvidence[] = [];
      const workforce = await runWorkforceSelection({
        goal: explicitWorkforceGoal,
        occurrenceId: executionContext?.occurrenceId ?? req.runId,
        inputModalities: req.images?.length ? ["modality:image"] : [],
        active,
        benchmarkMode: workforceBenchmarkMode,
        sourcePolicy: req.hubMode === "hub-first" ? "hub-required" : "network",
        signal,
        sink,
        auditSchemaAttempt: (attempt) => tryRecordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_schema_attempt",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...attempt },
        }),
        auditHubToolObservation: (observation) => tryRecordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_hub_tool_observation",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...observation },
        }),
        auditHubToolSupersession: (supersession) => tryRecordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_hub_tool_supersession",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...supersession },
        }),
        auditLeaderDecisionSupersession: (supersession) => tryRecordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_leader_decision_supersession",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...supersession },
        }),
        auditWorkOrderRefinement: (refinement) => tryRecordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_work_order_refinement",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...refinement },
        }),
        leader: async (turn) => {
          throwIfInvocationAborted(signal, locale);
          const result = await picked.runner(
            {
              systemPrompt: turn.systemPrompt,
              history: [],
              userPrompt: turn.userPrompt,
              // Attachments stay inside the selected local/BYOM leader runtime. Hub receives
              // only the validated redacted WorkOrder, never image bytes or attachment paths.
              images: req.images,
              backendLabel: picked.label,
              model: active.model ?? undefined,
              longContext: active.longContextEnabled ?? false,
              effort: active.effort ?? undefined,
              signal,
              permission: "read",
              restrictedReadBoundary: restrictedOrchestrationBoundary || undefined,
              env: orchestrationRunnerEnv,
              untrustedNoTools: true,
              cwd: undefined,
              chatId: turn.invocationId,
              locale,
            },
            {
              onStatus: (status) => sink({
                kind: "tool-use",
                status,
                agentId: "workforce:leader",
                agentName: "Agentlas Workforce Leader",
                role: "workforce-leader",
                tier: 1,
                phase: "plan",
              }),
              onPartial: () => {},
              onTool: (name, args, resultText, id, isError) => sink({
                kind: "tool-use",
                tool: { name, args, result: resultText, id, isError },
                agentId: "workforce:leader",
                agentName: "Agentlas Workforce Leader",
                role: "workforce-leader",
                tier: 1,
                phase: "plan",
              }),
            },
          );
          workforceLeaderRunnerEvidence.push({
            invocationId: turn.invocationId,
            runtime: { ...active },
            result: { appliedEffort: result.appliedEffort },
          });
          return result.text;
        },
      });
      workforcePrepareReceipt = workforce.prepareCheckpointReceipt;
      executionContext?.onWorkforcePrepareReceipt?.(workforcePrepareReceipt);
      emitWorkforceBenchmarkSelectionArtifacts(sink, workforceBenchmarkMode, workforce);
      tryRecordRunEvent({
        runId: req.runId ?? `task-force:${chat.id}`,
        kind: "workforce_selection_receipt",
        chatId: chat.id,
        nodeId: "workforce:leader",
        agentId: agent.id,
        payload: {
          receiptId: workforce.receipt.receiptId,
          workOrderId: workforce.receipt.workOrderId,
          selectionReceiptId: workforce.receipt.selectionReceiptId,
          preparationReceiptId: workforce.receipt.preparationReceiptId,
          candidateSetDigest: workforce.receipt.candidateSetDigest,
          ontologyVersion: workforce.receipt.ontologyVersion,
          decisionOwner: workforce.receipt.decisionOwner,
          decisionModel: workforce.receipt.decisionModel,
          historyInfluence: workforce.receipt.historyInfluence,
          executionContext: workforce.receipt.executionContext,
          executionContextDigest: workforce.receipt.executionContextDigest,
          idealTeam: workforce.receipt.idealTeam,
          executableTeam: workforce.receipt.executableTeam,
          unfilledPosts: workforce.receipt.unfilledPosts,
          substitutions: workforce.receipt.substitutions,
          preparedReleases: workforce.receipt.preparedReleases,
          mcpCalls: workforce.receipt.mcpCalls,
          hubToolObservations: workforce.receipt.hubToolObservations,
          hubToolSupersessions: workforce.receipt.hubToolSupersessions,
          leaderDecisionSupersessions: workforce.receipt.leaderDecisionSupersessions,
          leaderInvocations: workforce.receipt.leaderInvocations,
          schemaAttempts: workforce.receipt.schemaAttempts,
          workOrderRefinements: workforce.receipt.workOrderRefinements,
        },
      });
      const execution = await runBorrowedTaskForceInvocation({
        req: { ...req, userPrompt: explicitWorkforceGoal, borrowAgents: undefined, taskForceTargets: undefined },
        chat,
        orchestratorAgent: agent,
        taskForceName: locale === "ko" ? "Agent Workforce TF" : "Agent Workforce task force",
        taskForceKind: "task-force",
        taskForceSpecs: workforce.specs,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
        workforceSelectionReceipt: workforce.receipt,
        workforceLeaderRunnerEvidence,
        benchmarkMode: workforceBenchmarkMode,
        requireAllWorkers: true,
      });
      if (!execution.ok) {
        sink({
          kind: "error",
          error: {
            code: "workforce-verification-failed",
            message: execution.verifierIssues?.join(", ") || "Workforce structural verification failed.",
          },
        });
      }
    } catch (error) {
      throwIfInvocationAborted(signal, locale);
      const failureCode = workforceFailureCode(error);
      sink({
        kind: "error",
        error: failureCode
          ? {
              code: failureCode,
              message: error instanceof Error ? error.message : String(error),
            }
          : invocationFailure(req, "workforce-execution-failed", error),
      });
    }
    return earlyResult();
  }

  // ── Exact temporary top-level task force ──────────────────
  // A recommendation is an ephemeral roster, not a chat binding mutation.
  // Main validates every discriminated target against live inventory before
  // handing one execution unit per Agent, Team, or Group to the orchestrator.
  if (req.taskForceTargets !== undefined) {
    try {
      const targets = requireOrchestrationTargets(req.taskForceTargets);
      const taskForceSpecs = await buildStructuredTaskForceSpecs({
        targets,
        prompt: effectiveUserPrompt,
        project: workingFolder,
        locale,
        signal,
        ...(oneParticipantEffectivePrompts
          ? { localEffectivePrompts: oneParticipantEffectivePrompts }
          : {}),
      });
      await runBorrowedTaskForceInvocation({
        req: { ...req, userPrompt: effectiveUserPrompt },
        chat,
        orchestratorAgent: agent,
        ...(oneParticipantEffectivePrompts
          ? { orchestratorEffectivePrompt: effectivePromptFor(agent) }
          : {}),
        taskForceName: locale === "ko" ? "임시 태스크포스" : "Temporary task force",
        taskForceKind: "task-force",
        taskForceSpecs,
        priorHistory,
        resolveGroupTaskForce: ({ groupId, prompt, signal: nestedSignal }) => buildAgentGroupTaskForceSpecs({
          groupId,
          prompt,
          project: workingFolder,
          locale,
          sink,
          signal: nestedSignal,
          localOnly: req.agentAppMode || req.hubMode === "local-only",
        }),
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "task-force-failed", err) });
    }
    return earlyResult();
  }

  // ── Agent Group 오케스트레이션 ───────────────────────────
  // 저장된 그룹은 firm/division보다 상위의 라우팅 묶음이다. 실행 직전에
  // installed agents, org chart, live Hub catalog/bundle을 다시 풀어서 최신 경로로 호출한다.
  if (chat.agentGroupId) {
    if (!oneTeamExecutionPolicy) {
      try {
        const groupRun = await buildAgentGroupTaskForceSpecs({
          groupId: chat.agentGroupId,
          prompt: effectiveUserPrompt,
          project: workingFolder,
          locale,
          sink,
          signal,
          localOnly: req.agentAppMode || req.hubMode === "local-only",
        });
        await runBorrowedTaskForceInvocation({
          req: { ...req, userPrompt: effectiveUserPrompt },
          chat,
          orchestratorAgent: {
            ...agent,
            name: groupRun.orchestratorName || agent.name,
            nameEn: groupRun.orchestratorName || agent.nameEn || agent.name,
          },
          taskForceName: groupRun.groupName,
          taskForceKind: "agent-group",
          taskForceSpecs: groupRun.specs,
          priorHistory,
          resolveGroupTaskForce: ({ groupId, prompt, signal: nestedSignal }) => buildAgentGroupTaskForceSpecs({
            groupId,
            prompt,
            project: workingFolder,
            locale,
            sink,
            signal: nestedSignal,
            localOnly: req.agentAppMode || req.hubMode === "local-only",
          }),
          active,
          runtimes,
          picked,
          runtimeOverride: runtimeChoice.override,
          workingFolder,
          ...(workspaceBinding ? { workspaceBinding } : {}),
          ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
          mcpConfigPath,
          mcpAllowedTools,
          mcpCodexConfigArgs,
          agentAppMcpRuntimeEnv: mcpRuntimeEnv,
          onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
          runnerEnv: orchestrationRunnerEnv,
          locale,
          sink,
          signal,
        });
      } catch (err) {
        sink({ kind: "error", error: invocationFailure(req, "agent-group-failed", err) });
      }
      return earlyResult();
    }
  }

  // ── Hub borrowed task force ─────────────────────────────────
  // 추천 시트에서 Hub 에이전트 2개 이상을 고른 경우: 단일 프롬프트에 "여러 전문가를 적용"이라고
  // 뭉개지 않고, 로컬 오케스트레이터가 에이전트별 입력 패킷을 설계한 뒤 각 borrowed agent를
  // 별도 세션으로 병렬 실행하고 최종 종합한다.
  // 명시적 Hub borrow는 swarm보다 먼저 실행한다. 그렇지 않으면 swarm이 req.borrowAgents를
  // 소비하지 않은 채 로컬 워커만 실행해 Hub 권한/번들 검증을 우회할 수 있다.
  const directBorrowedTeam = explicitBorrowSpecs.length === 1
    && explicitBorrowSpecs[0].entityKind === "team"
    ? explicitBorrowSpecs[0]
    : null;
  if (directBorrowedTeam && chat.kind !== "division") {
    try {
      await runBorrowedTaskForceInvocation({
        req: { ...req, userPrompt: effectiveUserPrompt, borrowAgents: undefined },
        chat,
        orchestratorAgent: agent,
        taskForceName: directBorrowedTeam.name,
        taskForceKind: "task-force",
        taskForceSpecs: [directBorrowedTeam],
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "borrowed-team-failed", message: msg } });
    }
    return earlyResult();
  }
  if (borrowedAgentSlugs.length > 1 && chat.kind !== "division") {
    try {
      await runBorrowedTaskForceInvocation({
        req: { ...req, borrowAgents: borrowedAgentSlugs },
        chat,
        orchestratorAgent: agent,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "borrowed-task-force-failed", message: msg } });
    }
    return earlyResult();
  }

  // ── 스웜 모드 ──
  // 켜져 있으면 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업(emergent A2A). 동시성=사용자 슬라이더.
  // Explicit single borrow also bypasses swarm: its verified Hub user preamble
  // must reach the selected primary runtime unchanged instead of being discarded.
  if (
    !oneTeamExecutionPolicy &&
    !req.agentAppMode &&
    (chat.swarmMode || stormbreakerSwarm) &&
    borrowedAgentSlugs.length === 0 &&
    chat.kind !== "division"
  ) {
    try {
      persistUserMessage();
      const coreHarness = stormbreakerSwarm
        ? await loadCoreStormbreakerHarness()
        : undefined;
      if (stormbreakerSwarm && !chat.swarmMode) {
        sink({
          kind: "tool-use",
          status: locale === "ko"
            ? "Stormbreaker · Goal/UltraCode 병렬 작업 분해와 런타임 자동 배정을 시작합니다."
            : "Stormbreaker · starting Goal/UltraCode parallel decomposition with automatic runtime allocation.",
        });
      }
      await runSwarmInvocation({
        // Persist the exact user command above, but give workers the actual
        // goal rather than a route slug that could be mistaken for work.
        req: stormbreakerSwarm ? { ...req, userPrompt: explicitStormbreakerGoal } : req,
        chat,
        orchestratorAgent: agent,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
        stormbreakerMode: stormbreakerSwarm,
        stormbreakerHarness: coreHarness,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "swarm-failed", message: msg } });
    }
    return earlyResult();
  }

  // ── 멀티 에이전트 firm 오케스트레이션 ──
  // 회사 채팅이고 정규화된 조직에 본부/전문가가 있으면 3-tier 오케스트레이터로 분기.
  // (본부가 없는 firm은 아래 단일 CEO 경로 — 기존 동작 유지)
  if (!oneTeamExecutionPolicy && chat.firmId) {
    const firm = getFirm(chat.firmId);
    if (firm) {
      const org = getResolvedOrg(firm);
      if (org.divisions.length > 0) {
        try {
          const firmUserPrompt = explicitBorrowUserPreamble
            ? `${explicitBorrowUserPreamble}\n\nRequest:\n${effectiveUserPrompt}`
            : effectiveUserPrompt;
          await runFirmInvocation({
            req: { ...req, userPrompt: firmUserPrompt },
            chat: { id: chat.id, projectId: invocationProjectId, firmId: chat.firmId },
            org,
            ceoAgent: agent,
            priorHistory,
            active,
            runtimes,
            picked,
            workingFolder,
            ...(workspaceBinding ? { workspaceBinding } : {}),
            ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
            mcpConfigPath,
            mcpAllowedTools,
            mcpCodexConfigArgs,
            agentAppMcpRuntimeEnv: mcpRuntimeEnv,
            onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
            runnerEnv: orchestrationRunnerEnv,
            locale,
            sink,
            signal,
          });
        } catch (err) {
          // 오케스트레이션 실패 → 무한 스피너 방지: 에러 이벤트 emit
          sink({ kind: "error", error: invocationFailure(req, "firm-failed", err) });
        }
        return earlyResult();
      }
    }
  }

  // 프로젝트 컨텍스트 노트가 있으면 system prompt 뒤에 append
  let systemPrompt = effectivePromptFor(agent);
  // ── 턴 컨텍스트 — 사용자 프롬프트에 따라 매 턴 달라지는 주입(메모리 캡슐·온톨로지·
  // MCP 자동선택·브리핑 게이트·Experience/Taste)은 시스템 프롬프트가 아니라 여기 모은다.
  // 시스템 프롬프트를 턴마다 바꾸면 CLI 세션 지문이 매번 달라져 대화 연속성이 전멸한다
  // (2026-07-16 사고: 매 턴 fingerprint_changed → 세션 폐기 → "이전 세션을 보면~").
  // 세션 지원 러너는 새 세션이면 시스템 프롬프트 뒤에 붙이고, resume 턴이면 사용자
  // 메시지 앞에 싣는다. 세션 미지원 러너에는 기존처럼 시스템 프롬프트에 합쳐 전달한다.
  const turnContextParts: string[] = [];
  // One context remains Main-selected regardless of whether the chat is shown
  // in Desktop or on its paired Mobile remote.
  const approvedOneContext = (!workspaceBinding || workspaceBinding.source === "mobile-one") && !req.agentAppMode
    ? mainOneProfileContext(req)
    : "";
  if (approvedOneContext) turnContextParts.push(approvedOneContext);
  const approvedOneAttachmentContext = !workspaceBinding && !req.agentAppMode
    ? mainOneAttachmentContext(req)
    : "";
  if (approvedOneAttachmentContext) turnContextParts.push(approvedOneAttachmentContext);
  if (autoRoute) {
    systemPrompt = `${autoRouteSystemPreamble(
      autoRoute,
      locale,
      isTargetAppEdit ? "app-edit" : req.appsGenerateMode ? "apps-generate" : "default",
    )}\n\n${systemPrompt}`;
  }
  const routerAgentPreamble = routerAgent
    ? buildRouterAgentSystemPreamble({
        routerAgent: routerAgent,
        userPrompt: req.userPrompt,
        effectiveUserPrompt,
        locale,
        selectedAgent: agent,
        autoRoute,
        borrowedAgents: req.borrowAgents,
      })
    : null;
  if (routerAgentPreamble) {
    systemPrompt = `${routerAgentPreamble.preamble}\n\n${systemPrompt}`;
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Router Agent 에스컬레이션 적용: ${routerAgentPreamble.loadedModuleIds.join(", ") || "core"}`
          : `Router Agent escalation applied: ${routerAgentPreamble.loadedModuleIds.join(", ") || "core"}`,
    });
  }
  // ── 브리핑 인터뷰 게이트(smart 모드 전용) ─────────────────────────────
  // 모호한 실행형 요청이면 실행 전에 배치 질문(3-5)을 강제한다. 판단은 모델이 턴 안에서
  // 인라인으로 수행(추가 LLM 콜/지연 0). trivial 프롬프트는 주입 자체를 건너뛴다(하드 어서션:
  // 사소한 요청에 질문 0개). 기본 모드는 build-only라 챗에는 꺼져 있다.
  if (
    !req.agentAppMode &&
    getInterviewMode() === "smart" &&
    chat.kind !== "division" &&
    !isTrivialPrompt(req.userPrompt)
  ) {
    turnContextParts.push(
      `## Briefing gate (before executing)\n` +
      `First judge silently: are the goal, constraints and success criteria of this request specific enough ` +
      `that a stranger would produce the same result? If YES — proceed normally and ask NOTHING. ` +
      `If NO (execution-shaped but ambiguous): ask ONE batch of 3-5 <<agentlas-ask>> questions covering the ` +
      `weakest of: what NOT to do (anti-scope), smallest acceptable version, done signal, audience. ` +
      `Then STOP and wait. After the answers arrive, restate the goal in one sentence and proceed — never ask a second batch; ` +
      `record what is still open as explicit assumptions instead. 'decide later' is a valid answer (record as deferred). ` +
      `Never use this gate for greetings, pure questions, or already-specific instructions.`,
    );
  }
  if (invocationProjectId) {
    const project = getProject(invocationProjectId);
    if (project?.contextNote) {
      systemPrompt = `${systemPrompt}\n\n${tStatus(locale, "projectContext", {
        name: project.name,
      })}\n${project.contextNote}`;
    }
  }
  // 회사 채팅이면 firm 정보를 system prompt에 주입 — CEO가 자기 회사를 알 수 있게
  if (chat.firmId) {
    const firm = getFirm(chat.firmId);
    if (firm) {
      const roster = firm.orgChart
        .map(
          (n) =>
            `  - ${n.role}: ${n.agentSlug}${
              n.reportsTo ? ` ${tStatus(locale, "firmReportSuffix", { to: n.reportsTo })}` : ""
            }`,
        )
        .join("\n");
      systemPrompt =
        `${systemPrompt}\n\n` +
        `${tStatus(locale, "firmContext", { name: firm.name })}\n` +
        `${tStatus(locale, "firmCeoGuide")}\n` +
        `${tStatus(locale, "firmOrgChart")}\n${roster}\n` +
        tStatus(locale, "firmDelegateNote");
    }
  }

  // ── Agentlas 아키텍처: 메모리 주입 + 항상-켜진 큐레이터 ──────────────
  // 워킹 폴더에서 반복 작업하면 그 폴더가 활성화되고, 그때부터 프로젝트 메모리(.agentlas)를
  // 시스템 프롬프트에 주입한다. 폴더가 없거나 아직 활성 전이면 전역 메모리를 주입.
  // 채팅별 폴더가 없으면 프로젝트의 작업 폴더(folderPath)를 기본 cwd로 사용한다.
  let activePath: string | null = null;
  if (!req.agentAppMode && canWrite && workingFolder) {
    try {
      const visit = await recordFolderVisit(workingFolder, undefined, {
        permission: normalizedPermission,
        restrictedReadBoundary,
        agentAppMode: req.agentAppMode,
      });
      if (visit.activated) activePath = workingFolder;
    } catch (err) {
      console.error("[architecture] recordFolderVisit failed:", err);
    }
  }
  const memoryReadPath = workingFolder && !suppressMutableProjectContext && (
    activePath === workingFolder ||
    canReadActivatedFolderMemory(workingFolder, {
      permission: normalizedPermission,
      restrictedReadBoundary,
      agentAppMode: req.agentAppMode,
    })
  )
    ? workingFolder
    : null;
  if (!req.agentAppMode) {
    if (activePath) refreshCareerGraphInBackground(activePath, sink, locale);
    try {
      // `agent` may have changed through auto-routing above. Scope memory to the
      // actual executing agent so another agent's agent_repo never leaks in.
      const memoryContext = buildMemoryContext(memoryReadPath, agent.id, {
        materializeCodeMap: Boolean(activePath && canWrite),
        taskPrompt: effectiveUserPrompt,
        projectId: invocationProjectId,
        // Content-free recall observability — records which sources (pm_soul /
        // code_map / sitemap / memory) actually entered this turn's prompt.
        runId: req.runId ?? null,
        chatId: chat.id,
      });
      if (memoryContext) turnContextParts.push(memoryContext);
      // hep 발화 표면 — 프로젝트 작업 폴더에 대기 중 성장 제안 요약 파일을 쓰고(호스트가
      // 읽게), 고위험 대기분이 있으면 세션 컨텍스트에 한 줄 주입. 실패-무해.
      if (workingFolder && canWrite && !projectReadOnlyBoundary) {
        try {
          const growth = writeEvolutionProposalsForProject(workingFolder);
          const line = evolutionSessionContextLine(growth.pending, locale === "ko" ? "ko" : "en");
          if (line) turnContextParts.push(line);
        } catch (err) {
          console.warn("[evolution-hep] proposals file/context deferred:", err);
        }
      }
      if (memoryReadPath) {
        const ontologyContext = await queryWorkingFolderOntologyContext(memoryReadPath, effectiveUserPrompt, {
          readOnly: projectReadOnlyBoundary,
        });
        if (ontologyContext.used) turnContextParts.push(ontologyContext.context);
        // The query above is deliberately read-only so a slow ingest never
        // blocks the answer, but that path never fills the DB. When this turn
        // has write authority over the folder, kick off a background ingest so
        // the next turn has something to retrieve — without it the folder
        // ontology stays provisioned-but-empty forever (0 rows across projects).
        if (activePath && canWrite && !restrictedReadBoundary) {
          ingestWorkingFolderOntologyInBackground(memoryReadPath);
        }
      }
    } catch (err) {
      console.error("[architecture] buildMemoryContext failed:", err);
    }
  }
  let remoteOperationalSnapshot: Awaited<ReturnType<typeof resolveDesktopOperationalRuntimeSession>> = null;
  if (!req.agentAppMode) {
    try {
      // Runs before Taste so a previously approved next-session loadout is
      // activated once for this new chat. The local task and chat id stay local.
      remoteOperationalSnapshot = await resolveDesktopOperationalRuntimeSession({
        sessionId: chat.id,
        installedAgentId: agent.id,
      });
    } catch (err) {
      console.error("[architecture] Hub Operational runtime overlay skipped:", err);
    }
  }
  let tasteSnapshot: Awaited<ReturnType<typeof resolveDesktopTasteRuntimeSession>> = null;
  if (!req.agentAppMode) {
    try {
      tasteSnapshot = await resolveDesktopTasteRuntimeSession({
        sessionId: chat.id,
        installedAgentId: agent.id,
      });
    } catch (err) {
      // A missing/offline/revoked/malformed Taste projection degrades to the
      // exact base agent and cannot block the invocation.
      console.error("[architecture] Taste runtime overlay skipped:", err);
    }
  }
  const applicableTasteSnapshot = tasteSnapshot && tasteRuntimeOverlayMatchesTask(tasteSnapshot.overlay, effectiveUserPrompt)
    ? tasteSnapshot
    : null;
  if (!req.agentAppMode) {
    const applicableRemoteOperational = remoteOperationalSnapshot && operationalRuntimeOverlayMatchesTask(
      remoteOperationalSnapshot.overlay,
      effectiveUserPrompt,
    ) ? remoteOperationalSnapshot : null;
    if (applicableRemoteOperational) {
      turnContextParts.push(applicableRemoteOperational.directive);
      sink({
        kind: "tool-use",
        status: locale === "ko"
          ? "문제 해결 경험 적용 · 이 대화에 고정"
          : "Problem-solving experience applied · fixed for this conversation",
      });
    } else {
      try {
        const experienceContext = buildExperienceContext({
          agentId: agent.id,
          projectId: invocationProjectId,
          projectPath: suppressMutableProjectContext ? null : workingFolder,
          environment: { platform: process.platform, arch: process.arch, runtimeKind: active.kind },
          basePackageHash: agent.packageHash ?? null,
          task: effectiveUserPrompt,
          reservedApproxTokens: applicableTasteSnapshot?.overlay.estimatedTokens ?? 0,
        });
        if (experienceContext.prompt) {
          turnContextParts.push(experienceContext.prompt);
          if (req.runId) {
            recordContextSourceMarker({
              runId: req.runId,
              chatId: chat.id,
              agentId: agent.id,
              source: "experience",
              approxTokens: Math.ceil(Buffer.byteLength(experienceContext.prompt, "utf8") / 3),
              projectKey: projectContextKey(invocationProjectId, suppressMutableProjectContext ? null : workingFolder),
            });
          }
        }
      } catch (err) {
        // Experience is an optional host-local projection. A damaged/missing
        // projection can never block the base agent or Memory architecture.
        console.error("[architecture] buildExperienceContext failed:", err);
      }
    }
  }
  if (!req.agentAppMode && applicableTasteSnapshot) {
    // Taste stays a separate, lower-authority aesthetic overlay. The exact
    // verified snapshot is frozen for this chat and can change only when a
    // new runtime session starts.
    turnContextParts.push(applicableTasteSnapshot.directive);
    sink({
      kind: "tool-use",
      status: locale === "ko"
        ? "취향 경험 적용 · 이 대화에 고정"
        : "Taste preference applied · fixed for this conversation",
    });
  }
  // Compact core is always on; the full schema is loaded only for explicit
  // memory tasks. This keeps the recurring contract under ~150 tokens.
  if (!req.agentAppMode && !restrictedReadBoundary) {
    turnContextParts.push(memoryEmitterPromptFor(effectiveUserPrompt));
  }
  if (mcpAutoSelectionPrompt) turnContextParts.push(mcpAutoSelectionPrompt);
  if (!req.agentAppMode && chat.kind === "division" && (req.toolMode || req.hubMode)) {
    const supervisor = assembleSystemPrompt(
      AUTOMATION_SUPERVISOR_SYSTEM_AGENT,
      [effectiveUserPrompt, req.toolMode ?? "", req.hubMode ?? ""].join("\n"),
      { threshold: 0.6, maxModules: 3 },
    );
    systemPrompt = `${systemPrompt}\n\n${supervisor.systemPrompt}`;
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Automation Supervisor 적용: ${supervisor.loadedModuleIds.join(", ") || "core"}`
          : `Automation Supervisor applied: ${supervisor.loadedModuleIds.join(", ") || "core"}`,
    });
  }
  // Stormbreaker Loop — 이제 무조건 주입이 아니라 명시적 개입 조건에서만 켠다(대시보드 토글 기본 OFF).
  // 항상 켜지는 경로: division(백그라운드 자동화 인프라), continuousMode(계속 라이브), 명시 프리픽스
  // (`stormbreaker …` / `hep-network --stormbreaker …` = 컴포저 칩·추천 pipeline 선택).
  if (stormbreakerEngaged) {
    let coreHarness: Awaited<ReturnType<typeof stormbreakerHarness>>;
    try {
      coreHarness = await loadCoreStormbreakerHarness();
    } catch (err) {
      sink({
        kind: "error",
        error: {
          code: "stormbreaker-core-harness-unavailable",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return earlyResult();
    }
    // division(무인 시드)은 기존처럼 시스템 프롬프트에. 인터랙티브 채팅은 engaged가 턴 단위
    // 상태이므로 턴 컨텍스트로 — resume 세션에서도 이번 턴에 확실히 전달된다.
    if (chat.kind === "division") {
      systemPrompt = `${systemPrompt}\n\n${coreHarness.system_prompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`;
    } else {
      turnContextParts.push(`${coreHarness.system_prompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`);
    }
  }
  // 사용자 채팅에서만 자동화 생성 protocol 주입 (백그라운드 automation 실행 세션은 제외 → 재귀 방지)
  if (chat.kind !== "division" && canWrite) {
    systemPrompt = `${systemPrompt}\n\n${AUTOMATION_PROTOCOL}`;
    // 자동화형 요청이면 턴 컨텍스트로도 전달 — read 권한으로 시작해 protocol 없이 생성된
    // resume 세션에서도 자동화 계약이 이번 턴에 도달하게 한다.
    if (isAutomationSetupRequest(req.userPrompt)) turnContextParts.push(AUTOMATION_PROTOCOL);
  }
  // 무인 실행은 질문을 받을 사람이 없다. ASK_PROTOCOL(래퍼가 앞에 주입)보다 뒤에 오는 최종
  // 지침으로 질문 fence를 금지하고, 안전한 기본값이 없으면 "NEEDS-INPUT:"으로 명시적 실패를
  // 유도한다. automation-result.ts 분류기가 이 계약을 짝으로 감지한다(조용한 가짜 성공 방지).
  if (isUnattendedExecution(executionContext)) {
    systemPrompt = `${systemPrompt}\n\n${UNATTENDED_NO_ASK_DIRECTIVE}`;
  }

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  persistUserMessage();

  sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });
  if (chat.kind !== "division" && canWrite && isAutomationSetupRequest(req.userPrompt)) {
    sink({ kind: "partial", text: automationLivePrelude(locale) });
  }

  // Stormbreaker 슈퍼바이저 — 활성·가용하면 이 실행을 scope→route→gate 로 감독한다(비차단).
  // division(백그라운드 firm 하위) 세션은 제외(재귀/노이즈 방지). 실패/부재 시 null → no-op.
  let stormbreaker: StormbreakerHandle | null = null;
  if (chat.kind !== "division" && stormbreakerEngaged) {
    stormbreaker = superviseStormbreaker({
      query: req.userPrompt,
      cwd: resolvedResultFolder,
      emit: (tool) => sink({ kind: "tool-use", tool }),
      signal,
    });
  }

  // Main-authored before model execution. The renderer/model never controls
  // Memory Ticket identity, so success/error/cancel handling converges.
  const memoryTurnId = `chat:${chat.id}:run:${req.runId ?? randomUUID()}:node:${executionContext?.nodeId ?? "root"}`;
  let modelTurnStarted = false;
  try {
    const runtimeUserPrompt = explicitBorrowUserPreamble
      ? `${explicitBorrowUserPreamble}\n\nRequest:\n${effectiveUserPrompt}`
      : effectiveUserPrompt;
    // 세션 지원 러너(claude-code/codex/gemini/kimi)는 턴 컨텍스트를 분리 전달해 러너가
    // 새 세션/resume에 맞게 배치한다. 그 외 stateless 러너는 기존처럼 시스템 프롬프트에 합친다.
    const turnContext = turnContextParts.filter((part) => part && part.trim()).join("\n\n");
    const sessionCapableRuntime =
      active.kind === "claude-code" || active.kind === "codex" || active.kind === "gemini" || active.kind === "kimi";
    const runnerReq = {
      systemPrompt: sessionCapableRuntime || !turnContext
        ? systemPrompt
        : `${systemPrompt}\n\n${turnContext}`,
      ...(sessionCapableRuntime && turnContext ? { turnContext } : {}),
      history,
      userPrompt: runtimeUserPrompt,
      images: req.images,
      backendLabel: picked.label,
      model: active.model ?? undefined,
      longContext: active.longContextEnabled ?? false,
      effort: active.effort ?? undefined,
      signal,
      permission: req.permissions,
      ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
      ...(isUnattendedExecution(executionContext) ? { unattended: true as const } : {}),
      // 세션 지문 시드 — 항상 전달한다. 인터랙티브 채팅은 (chatId, agentId)만이 세션
      // 정체성이라 모델/effort/권한/턴별 주입이 바뀌어도 같은 CLI 세션을 이어간다
      // (무조건 세션 유지 계약, 2026-07-16). 무인 실행은 기존 안정 시드를 유지한다.
      ...(req.agentAppMode
        ? {}
        : {
            sessionFingerprintSeed: JSON.stringify(
              isUnattendedExecution(executionContext)
                ? {
                    agentId: agent.id,
                    agentSystemPrompt: agent.systemPrompt,
                    permission: req.permissions,
                    runtime: req.runtimeSelection ?? {
                      kind: active.kind,
                      backend: active.backend,
                      model: active.model,
                      effort: active.effort,
                    },
                    toolMode: req.toolMode,
                    hubMode: req.hubMode,
                  }
                : {
                    v: "agentlas.chat-session-seed.v1",
                    chatId: chat.id,
                    agentId: agent.id,
                    executionMode: oneTeamExecutionPolicy ? "one-task-surface-v1" : "conversation",
                  },
            ),
          }),
      // 세션 resume 키 — CLI 러너가 (chatId, kind)별 세션을 재사용해
      // 시스템 프롬프트/히스토리를 매 턴 재전송하지 않게 한다.
      chatId: req.agentAppMode ? `site-agent-app:${req.runId ?? randomUUID()}` : chat.id,
      mcpConfigPath,
      mcpAllowedTools,
      mcpCodexConfigArgs,
      env: runnerEnv.env,
      untrustedNoTools: req.agentAppMode === true,
      untrustedAllowedMcpTools: req.agentAppMode ? mcpAllowedTools : undefined,
      onAgentAppMcpRuntimeUnavailable: req.agentAppMode
        ? markAgentAppMcpRuntimeUnavailable
        : undefined,
      // 사용자가 지정한 워킹 폴더(프로젝트)에서 에이전트를 실행 — 빌드/파일 생성이 거기서 일어난다.
      // 활성화(2회 방문) 게이팅과 무관하게, 폴더가 지정돼 있으면 즉시 cwd로 사용한다.
      cwd: req.agentAppMode ? undefined : workingFolder ?? undefined,
      locale,
      // A confirmed One Task is a result surface, not an ordinary chat turn.
      // Force the declarative protocol while casual One conversation remains
      // lightweight and plain-text capable.
      forceSurface: oneTeamExecutionPolicy ? true : undefined,
    };
    // 라이브 토큰은 러너 1회 실행 기준 누적치 — Stormbreaker 연속 패스에서 다음 패스가
    // 0부터 다시 세도 표시가 뒤로 가지 않도록 이전 패스 최고치를 floor로 더한다.
    let liveUsageFloor = 0;
    let liveUsageHigh = 0;
    // partial도 같은 문제 — 패스가 바뀌면 러너 누적이 0부터 다시 시작해 렌더러 본문이
    // 통째로 줄고(전문 교체) 이전 패스 도구 카드 앵커가 붕괴한다. 이전 패스 전문을 floor로
    // 접두해 본문/앵커 좌표계를 패스 전체에 걸쳐 단조로 유지한다. (continuousMode는 패스마다
    // 별도 assistant 메시지를 남기므로 제외 — 접두하면 내용이 중복된다)
    let partialFloor = "";
    const observedOneSourceUrls = new Set<string>();
    let observedOneToolEvidence = false;
    let observedOneToolFailure = false;
    // 복구 패스 판정용 패스 단위 계수 — 복구 패스가 "도구 성공 증거 있음 + 무오류"로
    // 끝났을 때에만 실패 흔적을 지운다(도구 없이 말로만 끝내는 가짜 성공 방지).
    let passToolFailures = 0;
    let passToolSuccesses = 0;
    const oneToolFailureBlocksCompletion = () => Boolean(oneTeamExecutionPolicy && observedOneToolFailure);
    const collectObservedSourceUrls = (value?: string) => {
      if (!value || !oneTeamExecutionPolicy || observedOneSourceUrls.size >= 32) return;
      for (const match of value.matchAll(/https:\/\/[^\s"'<>\\)\]]+/g)) {
        if (observedOneSourceUrls.size >= 32) break;
        try {
          const parsed = new URL(match[0]);
          if (parsed.protocol === "https:" && !parsed.username && !parsed.password) observedOneSourceUrls.add(parsed.href);
        } catch {
          // Tool output is untrusted text; malformed URLs are ignored.
        }
      }
    };
    const runnerEvents = {
      onStatus: (status: string) => sink({ kind: "tool-use", status }),
      // A partial JSON fence cannot be safely sanitized. Restricted runs are
      // final-only so cancel/error can never persist an unfinished Memory block.
      onPartial: (text: string) => {
        if (!projectReadOnlyBoundary) {
          sink({ kind: "partial", text: partialFloor ? `${partialFloor}\n${text}` : text });
        }
      },
      // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
      onTool: (name: string, args?: string, result?: string, id?: string, isError?: boolean) => {
        if (isError) {
          observedOneToolFailure = true;
          passToolFailures += 1;
        }
        if (!isError) {
          passToolSuccesses += 1;
          collectObservedSourceUrls(args);
          collectObservedSourceUrls(result);
          // Some provider runners emit a successful tool completion without
          // echoing its result text back through this callback. The signed
          // invocation event is still enough to admit an explicitly
          // unverified deterministic fallback; file claims remain subject to
          // the separate exact-result-folder filesystem seal below.
          if (oneTeamExecutionPolicy && name.trim()) observedOneToolEvidence = true;
        }
        sink({ kind: "tool-use", tool: { name, args, result, id, isError } });
      },
      // 라이브 누적 토큰 — 상태줄 "{N}s · {tokens} tokens" 실시간 갱신.
      onUsage: (tokens: number) => {
        liveUsageHigh = Math.max(liveUsageHigh, liveUsageFloor + tokens);
        sink({ kind: "usage", tokens: liveUsageHigh });
      },
      // reasoning(thinking) 구간 신호 — 상태줄 "생각 중…" 회전 + "N초 동안 생각함".
      onThinking: (phase: "start" | "end", durationMs?: number) =>
        sink({ kind: "reasoning", reasoning: { phase, durationMs } }),
    };
    const advanceUsageFloor = () => {
      liveUsageFloor = liveUsageHigh;
    };
    // "계속 라이브로" 모드: 채팅에 켜져 있으면 짧은 상한(3턴)에서 멈춰 30분 간격 백그라운드로
    // 넘기지 않고, 같은 채팅에서 라이브 스트리밍을 계속 이어간다(사실상 무제한, 안전 상한만).
    const continuousMode = !req.agentAppMode && !projectReadOnlyBoundary && chat.kind !== "division" && chat.continuousMode === true;
    const maxPasses = req.agentAppMode
      ? 1
      : continuousMode
        ? CONTINUOUS_MODE_MAX_PASSES
        : STORMBREAKER_MAX_EXECUTION_PASSES;
    let restrictedDiscardedMemoryEvents = 0;
    const sanitizeRestrictedPass = (passResult: Awaited<ReturnType<Runner>>) => {
      if (!projectReadOnlyBoundary) return passResult;
      const parsed = stripAllMemoryEventBlocks(passResult.text);
      restrictedDiscardedMemoryEvents += parsed.events.length;
      return { ...passResult, text: parsed.cleanedText };
    };
    let activeRunnerReq = runnerReq;
    modelTurnStarted = true;
    let result = await picked.runner(activeRunnerReq, runnerEvents);
    result = sanitizeRestrictedPass(result);
    advanceUsageFloor();
    for (let pass = 2; pass <= maxPasses; pass += 1) {
      const continuation = stripStormbreakerContinueMarker(result.text);
      if (!continuation.shouldContinue || signal?.aborted) {
        result = { ...result, text: continuation.text };
        break;
      }
      result = { ...result, text: continuation.text };
      if (!continuousMode && continuation.text.trim()) {
        // 다음 패스가 확정된 순간에만 이전 패스 전문을 partial floor에 적립 —
        // 단일 패스(대다수)는 floor가 비어 있어 기존 경로와 완전히 동일하다.
        partialFloor = partialFloor ? `${partialFloor}\n${continuation.text}` : continuation.text;
      }
      if (continuousMode) {
        // 이 턴의 완료된 결과를 즉시 별도 assistant 메시지로 남긴다 — 화면엔 새 말풍선이
        // 계속 이어 붙는 것처럼 보이고, 앱이 중간에 꺼져도 그때까지 기록은 남는다.
        appendChatMessage(chat.id, "assistant", redactOneAttachmentText(req, continuation.text));
        // 세션 워터마크 전진 — 다음 resume 턴이 방금 자기 답변을 gap으로 재주입하지 않게.
        if (sessionCapableRuntime) touchRuntimeSession(chat.id, active.kind);
        sink({
          kind: "tool-use",
          status:
            locale === "ko" ? `계속 진행 중 · ${pass}턴째 (안 끊기고 이어짐)` : `Continuing · pass ${pass} (uninterrupted)`,
        });
      }
      stormbreaker?.continuePass({
        pass,
        reason: "runner reported more safe Stormbreaker work remains",
      });
      const continuationPrompt = buildStormbreakerContinuationPrompt(result.text, pass);
      activeRunnerReq = {
        ...runnerReq,
        // Remote Hub instructions stay at user authority. Reattach the exact
        // verified preamble for stateless BYOK passes without promoting it into
        // the local system prompt.
        userPrompt: explicitBorrowUserPreamble
          ? `${explicitBorrowUserPreamble}\n\nContinuation request:\n${continuationPrompt}`
          : continuationPrompt,
        images: undefined,
      };
      result = await picked.runner(activeRunnerReq, runnerEvents);
      result = sanitizeRestrictedPass(result);
      advanceUsageFloor();
    }
    // ── One 완주 규범 ─────────────────────────────────────────────
    // 도구 한 번의 실패 흔적이 남은 채로 턴을 "다시 해달라"로 끝내지 않는다.
    // 같은 대화 안에서 스스로 복구 패스를 돌려 막힌 단계를 재실행하고 결과까지
    // 완주한다. 복구 패스가 도구 성공 증거를 남기고 무오류로 끝났을 때에만
    // 실패 흔적을 지운다 — 말로만 "됐다"고 하는 가짜 성공은 통과하지 못한다.
    if (oneTeamExecutionPolicy && !req.agentAppMode) {
      const ONE_RECOVERY_MAX_PASSES = 2;
      for (let attempt = 1; attempt <= ONE_RECOVERY_MAX_PASSES && observedOneToolFailure && !signal?.aborted; attempt += 1) {
        sink({
          kind: "tool-use",
          status: locale === "ko" ? "막힌 단계를 다시 진행하는 중…" : "Retrying a blocked step…",
        });
        if (!continuousMode && result.text.trim()) {
          partialFloor = partialFloor ? `${partialFloor}\n${result.text}` : result.text;
        }
        passToolFailures = 0;
        passToolSuccesses = 0;
        const recoveryPrompt = buildOneRecoveryPrompt(result.text, attempt);
        activeRunnerReq = {
          ...runnerReq,
          userPrompt: explicitBorrowUserPreamble
            ? `${explicitBorrowUserPreamble}\n\nContinuation request:\n${recoveryPrompt}`
            : recoveryPrompt,
          images: undefined,
        };
        result = await picked.runner(activeRunnerReq, runnerEvents);
        result = sanitizeRestrictedPass(result);
        advanceUsageFloor();
        if (passToolFailures === 0 && passToolSuccesses > 0) observedOneToolFailure = false;
      }
    }
    const finalContinuation = stripStormbreakerContinueMarker(result.text);
    const stormbreakerContinueRequested = !req.agentAppMode && finalContinuation.shouldContinue;
    result = { ...result, text: finalContinuation.text };
    // continuousMode는 안전 상한(20,000턴)이 사실상 안 걸리므로 정상적으론 이 분기에 안 들어온다.
    // 혹시라도 상한에 닿았는데 아직 할 일이 있다고 하면(진짜 폭주 등) 작업을 잃지 않도록 기존
    // 백그라운드 30분 자동화로 안전하게 이어받는다.
    if (!req.agentAppMode && stormbreakerContinueRequested && chat.kind !== "division" && canWrite) {
      const marker = `Source chat: ${chat.id}`;
      const existingContinuation = listAutomations().find(
        (automation) => automation.enabled && automation.promptTemplate.includes(marker),
      );
      // A hidden continuation is a new invocation, not a trusted continuation
      // of the current process. Pin an explicit single Hub hire as a Hub target
      // so the scheduler performs a fresh authoritative hepCall on every run.
      const continuationHubSlug = borrowedAgentSlugs.length === 1 ? borrowedAgentSlugs[0] : null;
      if (
        existingContinuation &&
        continuationHubSlug &&
        (existingContinuation.targetType !== "hub" || existingContinuation.targetId !== continuationHubSlug)
      ) {
        // Upgrade a continuation created by an older build instead of letting its
        // stale local agent/firm target bypass Hub revalidation on the next tick.
        updateAutomation(existingContinuation.id, {
          targetType: "hub",
          targetId: continuationHubSlug,
        });
      }
      if (!existingContinuation) {
        createAutomation({
          name: `Stormbreaker continuation · ${chat.title || agent.name}`,
          scheduleHuman: STORMBREAKER_LONG_RUN_SCHEDULE,
          targetType: continuationHubSlug ? "hub" : chat.firmId ? "firm" : "agent",
          targetId: continuationHubSlug ?? chat.firmId ?? chat.agentId,
          promptTemplate: buildStormbreakerLongRunPrompt({
            sourceChatId: chat.id,
            previousOutput: result.text,
            userPrompt: req.userPrompt,
            workingFolder,
          }),
          createdBy: "agent",
        });
        sink({
          kind: "tool-use",
          tool: {
            name: "Stormbreaker Loop · long-run",
            result: `More safe work remains after ${STORMBREAKER_MAX_EXECUTION_PASSES} immediate passes. Queued a hidden ${STORMBREAKER_LONG_RUN_SCHEDULE} continuation that reuses its own durable session and disables itself when the marker stops.`,
          },
        });
      }
    }

    // Chat must not auto-escalate into App/Workbench generation. If a model emits
    // the legacy surface-intent marker, strip it below instead of doing a second
    // app/surface pass.

    // 항상-켜진 큐레이터: 답변 끝의 "## Memory Events" 블록을 파싱해 안전·스코프·중복 처리 후
    // 내구 메모리에 기록하고, 사용자에게 보이는 텍스트에서는 그 블록을 제거한다(추가 LLM 호출 없음).
    let displayText = result.text.split(SURFACE_INTENT_MARKER).join("").trim();
    // 에이전트가 "## Automation" 블록을 넣었으면 → 현재 chat의 타깃(firm/agent)으로 자동화 등록 + 블록 제거.
    // (백그라운드 automation 실행 세션은 제외 → 자동화가 자동화를 만드는 재귀 방지)
    const automationRegistrations: AutomationRegistrationResult[] = [];
    let automationPermissionRequired = false;
    if (req.agentAppMode) {
      // Browser output is untrusted display text. Strip host control envelopes
      // without executing or persisting them.
      try {
        displayText = parseAutomations(displayText).cleanedText;
      } catch {
        // Malformed blocks remain ordinary text and never reach registration.
      }
      displayText = parseMemoryEvents(displayText).cleanedText;
    } else if (chat.kind !== "division") {
      try {
        const { automations: autos, cleanedText, errors } = parseAutomations(displayText);
        if (errors.length > 0) {
          // 조용히 드롭하지 않고 표면화(설계 §2.5) — 로그로 남겨 진단 가능하게.
          console.warn("[automation] parse warnings:", errors.join("; "));
        }
        if (autos.length > 0 && !canWrite) {
          automationPermissionRequired = true;
          sink({
            kind: "tool-use",
            tool: {
              name: "automation.permission-required",
              args: JSON.stringify({ requested: autos.length, requiredPermission: "write" }),
              result: automationPermissionRequiredText(locale),
            },
          });
        } else if (autos.length > 0) {
          sink({
            kind: "tool-use",
            status:
              locale === "ko"
                ? `자동화 ${autos.length}개 설정 중`
                : `Setting up ${autos.length} automation${autos.length === 1 ? "" : "s"}`,
          });
        }
        for (const a of canWrite ? autos : []) {
          // 모델이 "agent" 필드로 실행 주체를 지정하면 설치 에이전트로 해석(id → slug → 표시명).
          // 미지정/미해석이면 기존처럼 현재 챗 타깃 — 오케스트레이터 챗에서 만든 자동화가 항상
          // 오케스트레이터에 묶여 매 실행 라우팅 홉을 타던 문제의 수정.
          const named = a.agent ? resolveInstalledAgentLoose(a.agent) : null;
          const hubAgent = a.hubAgent?.trim();
          const targetType = hubAgent ? "hub" : named ? "agent" : chat.firmId ? "firm" : "agent";
          const targetId = hubAgent || (named ? named.id : (chat.firmId ?? chat.agentId));
          // 이름 기준 idempotent 등록: 같은 이름이 이미 있으면 갱신 — 모델이 다음 턴에 다듬어
          // 재방출할 때 같은 작업이 중복 등록되던 문제의 수정(프로토콜에도 명시).
          const dup = listAutomations().find(
            (x) => x.name.trim().toLowerCase() === a.name.trim().toLowerCase(),
          );
          if (dup) {
            const updated = updateAutomation(dup.id, {
              scheduleHuman: a.schedule,
              targetType,
              targetId,
              promptTemplate: a.prompt,
              // schedule_json은 항상 방출값으로 — stale spec이 새 토큰을 덮는 것 방지.
              scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
              // tz는 방출됐을 때만 갱신(미방출 재방출이 기존 tz를 시스템 tz로 되돌리지 않게).
              ...(a.tz && a.tz.trim() ? { timezone: a.tz } : {}),
            });
            // 그래프는 방출됐을 때만 교체 — 사용자가 캔버스에서 편집한 그래프를 지우지 않는다.
            const updatedWithGraph = a.graph ? updateAutomationGraph(dup.id, a.graph) : updated;
            const registration: AutomationRegistrationResult = {
              action: "updated",
              name: updatedWithGraph.name,
              schedule: updatedWithGraph.scheduleHuman,
              targetType: updatedWithGraph.targetType,
              targetId: updatedWithGraph.targetId,
              nextRunAt: updatedWithGraph.nextRunAt,
              graph: Boolean(updatedWithGraph.graph),
            };
            automationRegistrations.push(registration);
            sink({
              kind: "tool-use",
              tool: {
                name: automationRegistrationToolName(registration.action),
                args: JSON.stringify({
                  name: registration.name,
                  schedule: registration.schedule,
                  targetType: registration.targetType,
                  targetId: registration.targetId,
                  graph: registration.graph,
                }),
                result: automationRegistrationResultText(registration, locale),
              },
            });
          } else {
            const created = createAutomation({
              name: a.name,
              scheduleHuman: a.schedule,
              targetType,
              targetId,
              promptTemplate: a.prompt,
              createdBy: "agent",
              // 구조화 스케줄 + steps→그래프를 통과시켜 챗 생성 자동화가 graph_json/schedule_json을 저장.
              scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
              timezone: a.tz && a.tz.trim() ? a.tz : null,
              graphJson: a.graph ?? null,
            });
            const registration: AutomationRegistrationResult = {
              action: "created",
              name: created.name,
              schedule: created.scheduleHuman,
              targetType: created.targetType,
              targetId: created.targetId,
              nextRunAt: created.nextRunAt,
              graph: Boolean(created.graph),
            };
            automationRegistrations.push(registration);
            sink({
              kind: "tool-use",
              tool: {
                name: automationRegistrationToolName(registration.action),
                args: JSON.stringify({
                  name: registration.name,
                  schedule: registration.schedule,
                  targetType: registration.targetType,
                  targetId: registration.targetId,
                  graph: registration.graph,
                }),
                result: automationRegistrationResultText(registration, locale),
              },
            });
          }
        }
        displayText = cleanedText;
      } catch (err) {
        console.error("[automation] parseAutomations failed:", err);
      }
    }
    if (automationRegistrations.length > 0) {
      displayText = appendAutomationSummary(displayText, automationFinalSummary(automationRegistrations, locale));
    }
    if (automationPermissionRequired) {
      displayText = appendAutomationSummary(displayText, automationPermissionRequiredText(locale));
    }
    try {
      const surfaceParse = parseSurfaces(displayText);
      if (surfaceParse.diagnostics.some((diagnostic) => diagnostic.code === "surface-parse-failed")) {
        displayText = locale === "ko"
          ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
          : "Something went wrong while preparing this result, so it is not complete.";
      } else {
        const parsedOneSurface = req.oneMode === true
          && surfaceParse.errors.length === 0
          && surfaceParse.surfaces.length === 1
          ? sealOneLocalArtifactPaths(surfaceParse.surfaces[0].manifest, resolvedResultFolder)
          : null;
        const rawDeterministicOneSurface = req.oneMode === true
          && oneTeamExecutionPolicy
          ? buildOneSurfaceFromMarkdown({
              // A model may append an invalid hidden Surface after an otherwise
              // useful cited answer. The parser already removed that untrusted
              // block; keep the clean visible Markdown eligible for the same
              // deterministic, closed validator instead of discarding both.
              markdown: surfaceParse.cleanedText.trim() || displayText,
              fallbackTitle: chat.title,
              taskPrompt: req.userPrompt,
              observedSourceUrls: [...observedOneSourceUrls],
              allowUncitedStructured: observedOneToolEvidence,
              // The resident judge picks the fallback surface layout by meaning;
              // the travel/product regexes stay as the labeled fallback.
              judgedIntent: await resolveOneMarkdownSurfaceIntent(req.userPrompt ?? "").catch(
                () => undefined,
              ),
            })
          : null;
        const deterministicOneSurface = rawDeterministicOneSurface
          ? sealOneLocalArtifactPaths(rawDeterministicOneSurface, resolvedResultFolder)
          : null;
        const oneSurface = chooseOneSurfaceForDisplay(parsedOneSurface, deterministicOneSurface);
        const usedDeterministicOneSurface = Boolean(
          deterministicOneSurface && oneSurface === deterministicOneSurface,
        );
        // A pretty manifest cannot turn a failed required tool step into a
        // successful One result. Keep the manifest out of the renderer and
        // finish this invocation through the failure channel below.
        if (oneSurface && !oneToolFailureBlocksCompletion()) {
          sink({
            kind: "surface",
            surfaceId: `surface:${req.runId ?? chat.id}:1`,
            surface: oneSurface,
            runtimeAgentId,
            agentName: agent.name,
            role: "orchestrator",
            tier: 1,
            phase: "synthesize",
          });
        }
        if (oneToolFailureBlocksCompletion()) {
          // 복구 패스를 이미 스스로 돌린 뒤에도 남은 실패 — 사용자에게 재시도를
          // 지시하지 않고, 사실만 조용히 말한다. 다음 메시지는 자동으로 이어진다.
          displayText = locale === "ko"
            ? "여러 번 다시 시도했지만 한 단계가 끝까지 확인되지 않았어요. 지금까지 진행한 내용은 위에 남겨뒀어요."
            : "I retried this several times, but one step could not be fully completed. Everything done so far is shown above.";
        } else if (usedDeterministicOneSurface && deterministicOneSurface) {
          displayText = deterministicOneCompletionCopy(req.userPrompt, deterministicOneSurface, locale);
        } else if (surfaceParse.surfaces.length > 0 || surfaceParse.errors.length > 0) {
          displayText =
            surfaceParse.cleanedText.trim() ||
            (parsedOneSurface
              ? locale === "ko"
                ? "요청하신 결과를 정리했어요."
                : "Here's your result."
              : locale === "ko"
                ? "여기 채팅으로 답변을 정리해 드렸어요."
                : "I've written the answer here in chat.");
        }
      }
    } catch {
      // Defensive fallback for failures outside an individual manifest. Never
      // retain or log the rejected model body because it may contain a local
      // path or another Main-private Surface transport value.
      displayText = locale === "ko"
        ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
        : "Something went wrong while preparing this result, so it is not complete.";
      console.error("[surface] parseSurfaces failed");
    }
    if (!req.agentAppMode || projectReadOnlyBoundary) {
      try {
        const curationContext = {
          turnId: memoryTurnId,
          // Activated read identity scopes the DB episode even when this turn
          // cannot write project files. The read-only curator path records only
          // a one-way hash and never appends project artifacts.
          projectPath: memoryReadPath,
          projectId: invocationProjectId,
          agentId: agent.id,
          chatId: chat.id,
          runId: req.runId,
          cwdAtRequest: workingFolder,
          experienceIntake: {
            platform: process.platform,
            arch: process.arch,
            runtimeKind: active.kind,
            basePackageHash: agent.packageHash ?? null,
            taskHint: effectiveUserPrompt,
          },
          // 단일 borrow 실행 — 빌린 에이전트의 agent_repo 배움을 그 전역 둥지로 미러링.
          borrowedAgentSlugs:
            activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
              ? explicitBorrowMemoryKeys
              : [],
        };
        const semanticOptions = projectReadOnlyBoundary
          ? {}
          : await runSemanticMemoryReview({
              replyText: displayText,
              runner: picked.runner,
              backendLabel: picked.label,
              model: active.model ?? undefined,
              effort: active.effort ?? undefined,
              env: runnerEnv.env,
              locale,
              signal,
              hasProject: Boolean(memoryReadPath),
              hasAgent: Boolean(agent.id),
            });
        const { cleanedText } = projectReadOnlyBoundary
          ? stripReplyMemoryEventsReadOnly(
              displayText,
              curationContext,
              restrictedDiscardedMemoryEvents,
            )
          : curateReply(displayText, curationContext, semanticOptions);
        // Restricted cleanup may intentionally remove the entire response. Never
        // restore the raw control block through the ordinary empty-text fallback.
        displayText = projectReadOnlyBoundary ? cleanedText : cleanedText || displayText;
      } catch (err) {
        console.error("[architecture] curateReply failed:", err);
        try {
          recordTerminalMemoryTurn({
            turnId: memoryTurnId,
            projectPath: req.agentAppMode ? null : memoryReadPath,
            projectId: req.agentAppMode ? null : invocationProjectId,
            agentId: agent.id,
            chatId: chat.id,
            runId: req.runId,
            cwdAtRequest: req.agentAppMode ? null : workingFolder,
            borrowedAgentSlugs:
              activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
                ? explicitBorrowMemoryKeys
                : [],
          }, "curation_failed");
        } catch (ticketError) {
          console.error("[memory] curation failure receipt failed:", ticketError);
        }
        const stripped = stripAllMemoryEventBlocks(displayText).cleanedText.trim();
        displayText = stripped || (locale === "ko"
          ? "응답은 완료됐지만 메모리 제어 블록을 안전하게 정리하지 못해 본문을 숨겼습니다."
          : "The response completed, but its memory control block could not be safely finalized, so the body was withheld.");
      }
    }

    // A successful direct Hub borrow is a first-class owner career event. The
    // immutable identity came from the exact runtime bundle prepared for this
    // invocation; a mid-run account switch suppresses both career and memory
    // writes instead of assigning the result to the newly active account.
    if (
      !oneToolFailureBlocksCompletion()
      && activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
    ) {
      for (const spec of explicitBorrowSpecs) {
        recordBorrowedAgentCareer({
          ownerScopeKey: explicitBorrowOwnerScopeKey,
          slug: spec.slug,
          agentDefinitionId: spec.agentDefinitionId!,
          agentReleaseId: spec.agentReleaseId!,
          entityKind: spec.entityKind,
          source: spec.source ?? "hub",
          localized: spec.localized!,
          runId: req.runId ?? `chat:${chat.id}:turn:${memoryTurnId}`,
          resolution: {
            runtime: active,
            source: runtimeChoice.override ? "manual-override" : "safe-fallback",
          },
        });
      }
    }

    // 인터랙티브 성공 턴의 outcome-attested 자동 승격 — 이 턴의 큐레이션이 방금
    // 만든 경험 후보(영수증에 run_id로 연결됨)를, durable 시작 영수증이 있는
    // 성공 런에 한해 'local-run-receipt' 방식으로 승격한다. 실패/차단 턴
    // (oneToolFailureBlocksCompletion)과 read-only 경계 턴은 승격하지 않으며,
    // 승격 실패는 경고로만 남기고 사용자 턴을 깨지 않는다(후보는 보존됨).
    if (!req.agentAppMode && !projectReadOnlyBoundary && req.runId && !oneToolFailureBlocksCompletion()) {
      try {
        const outcome = promoteExperienceCandidatesForRun({ agentId: agent.id, runId: req.runId });
        if (outcome.eligible > 0) {
          console.log(
            `[experience] interactive run promoted ${outcome.promoted}/${outcome.eligible} candidate(s) ` +
              `(agent ${agent.id}, run ${req.runId})`,
          );
          // Content-free ledger marker so live run-receipt promotion is queryable
          // (the live "0 run-receipt promotions" symptom was unmeasurable before).
          tryRecordRunEvent({
            runId: req.runId,
            kind: "experience_auto_promotion",
            chatId: chat.id,
            agentId: agent.id,
            payload: { eligible: outcome.eligible, promoted: outcome.promoted, method: "local-run-receipt" },
          });
        }
      } catch (err) {
        console.warn("[experience] interactive outcome promotion deferred:", err);
      }
      // Phase 2 — 일반 실행 증거(반복 실패 / 승격 누적 / 반복 교정)에서 자가진화 제안 트리거.
      // 결정적 카운터라 저비용(임베딩/LLM 없음). 저위험은 자동 적용+undo, 고위험은 4표면 승인.
      // 어떤 예외도 사용자 턴을 깨지 않는다(모듈 내부에서 삼킴).
      try {
        const growth = maybeProposeEvolutionFromRun({ agentId: agent.id, chatId: chat.id });
        if (growth) {
          console.log(
            `[evolution-triggers] ${growth.kind} proposal ${growth.proposalId} ` +
              `(${growth.riskTier}${growth.autoApplied ? ", auto-applied" : ", pending approval"})`,
          );
        }
      } catch (err) {
        console.warn("[evolution-triggers] normal-run trigger deferred:", err);
      }
    }

    // 컴팩션 요약 수집 — Claude Code가 이번 세션에서 컨텍스트를 자동 압축했다면 그 요약을
    // 큐레이터 인테이크(session/hypothesis) 티어로만 흘려보낸다. 심사·승격은 Curator 에이전트 몫.
    // 실패-무해: 트랜스크립트가 없거나(다른 런타임) 요약이 없으면 조용히 0건.
    try {
      if (!req.agentAppMode && !projectReadOnlyBoundary && result.sessionId) {
        harvestCompactionSummaries({
          sessionId: result.sessionId,
          cwd: workingFolder,
          ctx: {
            projectPath: memoryReadPath,
            projectId: invocationProjectId,
            agentId: agent.id,
            chatId: chat.id,
            cwdAtRequest: workingFolder,
            experienceIntake: {
              platform: process.platform,
              arch: process.arch,
              runtimeKind: active.kind,
              basePackageHash: agent.packageHash ?? null,
              taskHint: effectiveUserPrompt,
            },
          },
        });
      }
    } catch (err) {
      console.error("[architecture] harvestCompactionSummaries failed:", err);
    }

    // App generation from chat is disabled: do not append Apps CTAs or route
    // ordinary chat output into installed/generated App surfaces.

    // Stormbreaker 최종 게이트 — 답변 표출 직전 리뷰/증거 게이트(비차단·실패-무해).
    if (stormbreaker) {
      await stormbreaker.finish({ workspace: workingFolder ?? undefined, permission: req.permissions });
    }

    // 다중 패스(비-continuousMode)면 이전 패스 전문을 접두 — 라이브에서 보이던 본문/도구
    // 앵커 좌표계가 final에서도 유지된다. 단일 패스는 floor가 비어 그대로.
    const displayWithFloor = stripDanglingLanguageFence(redactOneAttachmentText(
      req,
      partialFloor ? `${partialFloor}\n${displayText}` : displayText,
    ));
    if (!req.agentAppMode) {
      appendChatMessage(chat.id, "assistant", displayWithFloor);
      // 세션 워터마크 전진 — 이 kind의 세션은 방금 답변까지 봤다. 다음 resume 턴의
      // gap-replay가 자기 답변을 중복 주입하지 않고, 스웜/다른 러너 턴만 메우게 된다.
      if (sessionCapableRuntime) touchRuntimeSession(chat.id, active.kind);
    }
    if (oneToolFailureBlocksCompletion()) {
      sink({
        kind: "error",
        error: {
          code: "one-required-step-failed",
          message: locale === "ko"
            ? "한 단계가 끝까지 확인되지 않아 완료로 표시하지 않았습니다."
            : "One step was not fully verified, so this is not marked complete.",
        },
      });
      return {
        finalText: displayWithFloor,
        tokens: result.tokens,
        stormbreakerContinueRequested,
        resultFolder: resolvedResultFolder,
        workforcePrepareReceipt,
      };
    }
    // 연속 패스에서 result.tokens는 마지막 패스만 반영 — 라이브 누적 최고치와 큰 쪽을 확정치로.
    sink({ kind: "final", text: displayWithFloor, tokens: Math.max(result.tokens ?? 0, liveUsageHigh) || undefined });
    return {
      finalText: displayWithFloor,
      tokens: result.tokens,
      stormbreakerContinueRequested,
      resultFolder: resolvedResultFolder,
      workforcePrepareReceipt,
    };
  } catch (err) {
    if (modelTurnStarted) {
      try {
        recordTerminalMemoryTurn({
          turnId: memoryTurnId,
          projectPath: memoryReadPath,
          projectId: invocationProjectId,
          agentId: agent.id,
          chatId: chat.id,
          runId: req.runId,
          cwdAtRequest: workingFolder,
          borrowedAgentSlugs:
            activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
              ? explicitBorrowMemoryKeys
              : [],
        }, signal?.aborted ? "cancelled" : "failed");
      } catch (ticketError) {
        console.error("[memory] terminal turn receipt failed:", ticketError);
      }
    }
    sink({ kind: "error", error: invocationFailure(req, "runner-failed", err) });
    return earlyResult();
  }
}
