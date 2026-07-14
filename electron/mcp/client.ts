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
  isEscalationWorthyPrompt,
  isGlobalOrchestrator,
  isPlainConversationalPrompt,
  selectAutoRoutedAgent,
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
import { getInterviewMode, isTrivialPrompt } from "../store/interview-mode";
import { getFirm } from "../store/firms";
import { getResolvedOrg } from "../store/org-spec";
import { runFirmInvocation } from "./firm-orchestrator";
import {
  BorrowedAgentUnavailableError,
  requireBorrowedAgentSpecs,
  runBorrowedTaskForceInvocation,
  type BorrowedAgentSpec,
} from "./borrowed-task-force";
import { runSwarmInvocation } from "./swarm-run";
import { getAgentGroup, resolveAgentGroupForRuntime } from "../store/agent-groups";
import { canReadActivatedFolderMemory, recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import { buildExperienceContext } from "../experience/context";
import { resolveDesktopOperationalRuntimeSession } from "../ontology/operational-runtime-session";
import { operationalRuntimeOverlayMatchesTask } from "../ontology/operational-runtime-contract";
import { resolveDesktopTasteRuntimeSession } from "../ontology/taste-runtime-session";
import { tasteRuntimeOverlayMatchesTask } from "../ontology/taste-runtime-contract";
import { curateReply, stripReplyMemoryEventsReadOnly } from "../memory/curator";
import { stripAllMemoryEventBlocks } from "../memory/events";
import { harvestCompactionSummaries } from "../memory/compaction-harvest";
import { parseMemoryEvents } from "../memory/events";
import { APP_BUILDER_SLUG } from "../architecture/manifest";
import { memoryEmitterPromptFor } from "../system-agents/memory";
import { AUTOMATION_PROTOCOL, parseAutomations } from "../automation-emitter";
import { parseSurfaces } from "../surface-emitter";
import { createAutomation, listAutomations, updateAutomation, updateAutomationGraph } from "../store/automations";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import {
  resolveSiteAgentAppInlineMcpConfigForDispatch,
} from "../site/agent-app-mcp-config-policy";
import { listInstalledServers as listInstalledMcpServers } from "../mcp-tools/registry";
import { getAgentApp } from "../store/agent-apps";
import { autoSelectMcpTools, buildMcpAutoSelectionPrompt } from "../mcp-tools/auto-select";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { buildAgentAppRunnerEnv, buildRunnerEnv } from "../runtime/env-resolver";
import { agentRunCwd } from "../runtime/exec";
import {
  enforceMobileReadOnlyPermission,
  isMobileReadRuntimeAllowed,
  revalidateInvocationWorkspaceBinding,
  type InvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import { type Runner, SURFACE_INTENT_MARKER } from "../runtime/runner";
import { pickActive, pickRunner, selectAgentAppRuntimeForTargets, selectRuntimeForTargets } from "../runtime/selection";
import { pickLocale, tStatus } from "../runtime/status-i18n";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import type {
  Chat,
  AppFactoryAppRecord,
  InstalledAgent,
  McpInvocationEvent,
  McpInvocationRequest,
  RecStage,
  RecRouterAgent,
  RuntimeStatus,
} from "../../shared/types";

type EventSink = (ev: McpInvocationEvent) => void;
const careerGraphRefreshTriggered = new Set<string>();

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

function inferWorkingFolderFromPrompt(prompt: string): string | null {
  const explicit = prompt.match(
    /(?:project|working|workspace|target|output)?\s*(?:folder|directory|dir)\s*(?:only)?[^/]*(\/(?:Volumes|Users|tmp|private\/tmp)\/[^\s`"'<>]+)/i,
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

// 라우팅 질의에 이 채팅의 최근 대화를 붙인다. 후속/되물음 메시지가 맥락 없이 단독 해석돼
// 엉뚱한 에이전트로 위임되던 문제를 막는다 — 판단은 라우터 모델에 맡기되 컨텍스트를 준다.
function buildContextualRoutingQuery(chatId: string, prompt: string): string {
  const recent = listChatMessages(chatId, 6)
    .filter((m) => (m.role === "user" || m.role === "assistant") && (m.text ?? "").trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240)}`);
  if (recent.length === 0) return prompt;
  return [
    "Recent conversation (for routing continuity):",
    recent.join("\n"),
    "",
    `New request to route: ${prompt}`,
    "If this is a follow-up to the conversation above (e.g. a question about work already done, or a small refinement), it can be answered in the current context — do NOT route to an unrelated new agent.",
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
): Promise<string> {
  const list = slugs.join(", ");
  let specs: BorrowedAgentSpec[];
  try {
    const res = await hepCall(slugs.join(","), [prompt], { project: project ?? ".", signal });
    specs = requireBorrowedAgentSpecs(slugs, res.json ?? null, {
      locale,
      transportOk: res.ok,
      transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
    });
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
  return `${header}\n${hostBoundary}\n\n${directive}`;
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
  const hubSlugs = resolved.members.filter((member) => member.source === "hub").map((member) => member.slug);
  let hubSpecs = new Map<string, BorrowedAgentSpec>();
  if (hubSlugs.length > 0) {
    try {
      const res = await hepCall(hubSlugs.join(","), [input.prompt], {
        project: input.project ?? ".",
        signal: input.signal,
      });
      hubSpecs = new Map(requireBorrowedAgentSpecs(hubSlugs, res.json ?? null, {
        locale: input.locale,
        transportOk: res.ok,
        transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
      }).map((spec) => [spec.slug, spec]));
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
    return {
      slug: member.slug,
      name: hub?.name || member.name,
      directive: member.source === "hub" ? hub!.directive : member.directive,
      source: member.source,
      routeLabel: member.routeLabel,
      warnings: member.warnings,
      installedAgentId: member.installedAgentId,
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

/** Main-process-only invocation provenance. Never deserialize this from IPC/wire input. */
export interface InvocationExecutionContext {
  source: "automation" | "site-studio";
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
): Promise<{ finalText?: string; tokens?: number; stormbreakerContinueRequested: boolean; resultFolder?: string }> {
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
  const normalizedPermission = workspaceBinding
    ? enforceMobileReadOnlyPermission(req.permissions)
    : req.permissions === "write" || req.permissions === "full"
      ? req.permissions
      : "read";
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
  sink = (ev: McpInvocationEvent) => {
    if (ev.kind === "final" && ev.text?.trim()) {
      finalTextFromSink = ev.text.trim();
    }
    callerSink(runtimeAgentId && !ev.runtimeAgentId ? { ...ev, runtimeAgentId } : ev);
  };
  const earlyResult = () => ({
    finalText: finalTextFromSink || undefined,
    stormbreakerContinueRequested: false,
    resultFolder: resolvedResultFolder,
  });
  const locale = pickLocale(req);
  const chat = getChat(req.chatId);
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return earlyResult();
  }
  // Mobile runs and unattended read automations cross a stronger boundary than
  // an interactive Desktop read. Only Main derives this bit; it is never taken
  // from the renderer request.
  const restrictedReadBoundary =
    Boolean(workspaceBinding) || (executionContext?.source === "automation" && !canWrite);
  const suppressProjectBinding = executionContext?.source === "site-studio";
  // Site Studio owns a project-scoped hidden conversation, but that identity is
  // not authority to consume an arbitrary Desktop Project. Freeze the effective
  // project id once in Main so a stale/tampered chat row cannot re-enter through
  // context notes, Experience selection, firm delegation, or curation.
  const invocationProjectId = suppressProjectBinding ? null : chat.projectId;
  let agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return earlyResult();
  }
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
  const borrowedAgentSlugs = [...new Set((req.borrowAgents ?? []).map((slug) => slug.trim()).filter(Boolean))];
  let explicitBorrowUserPreamble: string | null = null;
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
      explicitBorrowUserPreamble = await buildBorrowUserPreamble(
        borrowedAgentSlugs,
        effectiveUserPrompt,
        workspaceBinding
          ? boundMobileWorkingFolder
          : suppressProjectBinding
            ? null
            : getChatWorkingFolder(chat.id),
        locale,
        signal,
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

  const installedAgents = listInstalledAgents();
  // Agent Apps are request/response surfaces, not durable chat continuations.
  // An earlier browser request must not influence a later caller's routing.
  const hasPriorContext = req.agentAppMode ? false : hasPriorConversationContext(chat.id);
  // plain 대화(인사/맞장구)는 라우팅 전체를 건너뛰고 기본 LLM이 즉답 — 전문 에이전트로
  // 잘못 위임되거나 아래 Hephaestus 에스컬레이션 선지연을 무는 엣지케이스를 없앤다.
  const plainConversation = !isTargetAppEdit && isPlainConversationalPrompt(req.userPrompt);
  const autoRoute = req.agentAppMode
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

  // 자동화 Hub 정책: 사용자가 "Hub까지 사용"을 켜둔 경우, 로컬 타깃만 고집하지 않고
  // 실행 전에 Hephaestus Network 라우터로 Hub 후보를 찾아 BYOM bundle 지시를 프롬프트에 붙인다.
  // local-only는 명시적으로 이 경로를 막는다.
  if (
    !req.agentAppMode &&
    req.hubMode &&
    req.hubMode !== "local-only" &&
    borrowedAgentSlugs.length === 0 &&
    !plainConversation &&
    !isTargetAppEdit
  ) {
    try {
      // 라우터가 후속 메시지를 맥락 없이 단독 해석하지 않도록 최근 대화를 함께 싣는다 —
      // "자동화 건거 맞지?" 같은 되물음은 앞 대화를 보면 새 에이전트 위임이 아니라 현재
      // 맥락에서 답할 일임을 라우터 모델이 스스로 판단한다(키워드 분류 대신 컨텍스트 제공).
      const routingQuery = buildContextualRoutingQuery(chat.id, effectiveUserPrompt);
      const routeRes = await routeOnly(routingQuery, {
        project: workingFolder ?? undefined,
        runtime: "desktop-automation",
        ...(req.hubMode === "hub-first"
          ? { hubOnly: true, scope: "network" as const }
          : { allowLocal: true }),
        timeoutMs: req.hubMode === "hub-first" ? 12_000 : 6_000,
        signal,
      });
      throwIfInvocationAborted(signal, locale);
      const norm = normalizeRecommendation(routeRes.json, effectiveUserPrompt);
      const hubSlugs = norm.agents
        .filter((candidate) => candidate.source === "hub")
        .map((candidate) => candidate.id.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (hubSlugs.length > 0) {
        sink({
          kind: "tool-use",
          status:
            locale === "ko"
              ? `Hub 후보를 자동화에 연결합니다: ${hubSlugs.join(", ")}`
              : `Connecting Hub candidates to automation: ${hubSlugs.join(", ")}`,
        });
        const automaticBorrowPreamble = await buildBorrowUserPreamble(
          hubSlugs,
          effectiveUserPrompt,
          workingFolder,
          locale,
          signal,
        );
        effectiveUserPrompt = `${automaticBorrowPreamble}\n\nRequest:\n${effectiveUserPrompt}`;
      }
    } catch (err) {
      throwIfInvocationAborted(signal, locale);
      console.error("[automation] Hub resolver failed:", err);
      sink({
        kind: "tool-use",
        status:
          locale === "ko"
            ? "Hub 후보 확인에 실패해 로컬 도구로 계속합니다."
            : "Hub candidate lookup failed; continuing with local tools.",
      });
    }
  }

  // ── Hephaestus Router Agent 에스컬레이션 판단 ──
  // 이전에는 기본 채팅(글로벌 오케스트레이터)의 모든 메시지가 이 동기 호출을 최대 15초까지
  // 기다렸다 — 짧은 단일 작업까지 선지연을 물던 주범. 멀티도메인/파이프라인 신호가 있는
  // 복합 요청에만 에스컬레이션하고 타임아웃도 4초로 줄인다(실패/타임아웃 시 조용히 진행).
  let routerAgent = req.agentAppMode ? undefined : req.routerAgent;
  if (
    !req.agentAppMode &&
    !routerAgent &&
    isNetworkAutoEnabled() && // hep-network 자동 개입 — 대시보드 토글(기본 OFF)일 때만 자동 에스컬레이션
    isGlobalOrchestrator(agent) &&
    !hasPriorContext &&
    isEscalationWorthyPrompt(req.userPrompt)
  ) {
    try {
      const routingQuery = buildContextualRoutingQuery(chat.id, effectiveUserPrompt);
      const routeRes = await routeOnly(routingQuery, {
        project: workingFolder ?? undefined,
        allowLocal: true,
        timeoutMs: 4_000,
        signal,
      });
      throwIfInvocationAborted(signal, locale);
      const norm = normalizeRecommendation(routeRes.json, effectiveUserPrompt);
      if (norm.routerAgent) {
        routerAgent = norm.routerAgent;
      }
    } catch (err) {
      throwIfInvocationAborted(signal, locale);
      console.error("[routing] Dynamic Hephaestus routing check failed:", err);
    }
  }

  const runtimes = await detectRuntimes();
  throwIfInvocationAborted(signal, locale);
  const runtimeTargets = [
    { scope: "agent" as const, targetId: agent.id },
    { scope: "firm" as const, targetId: chat.firmId },
  ];
  const runtimeChoice = req.agentAppMode
    ? selectAgentAppRuntimeForTargets(runtimes, runtimeTargets)
    : selectRuntimeForTargets(runtimes, runtimeTargets);
  if (!runtimeChoice) {
    sink({
      kind: "error",
      error: { code: "no-runtime", message: tStatus(locale, "errNoRuntime") },
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

  const active = runtimeChoice.active;
  const picked = runtimeChoice.picked;
  if (restrictedReadBoundary && !isMobileReadRuntimeAllowed(active.kind)) {
    const restrictedSource = workspaceBinding ? "mobile" : "automation";
    sink({
      kind: "error",
      error: {
        code:
          restrictedSource === "mobile"
            ? "mobile-runtime-not-read-sandboxed"
            : "automation-runtime-not-read-sandboxed",
        message:
          restrictedSource === "mobile"
            ? locale === "ko"
              ? "이 런타임은 모바일 읽기 전용 경계가 검증되지 않았습니다. Desktop에서 BYOK 또는 Ollama를 선택하세요."
              : "This runtime has no verified Mobile read-only boundary. Select BYOK or Ollama on Desktop."
            : locale === "ko"
              ? "이 런타임은 무인 읽기 자동화의 격리 경계가 검증되지 않았습니다. BYOK 또는 Ollama를 선택하세요."
              : "This runtime has no verified boundary for unattended read automation. Select BYOK or Ollama.",
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

  // Stormbreaker is an executable Goal/UltraCode mode, not only a prompt
  // suffix. Non-trivial explicit/automatic requests enter the bounded swarm
  // path. Agent App and restricted-read invocations must never enter it.
  const explicitStormbreakerRequest = /^\s*(?:hep-network\s+--stormbreaker|stormbreaker)\b/i.test(req.userPrompt);
  const stormbreakerEngaged = !req.agentAppMode && !restrictedReadBoundary && (
    chat.kind === "division" ||
    chat.continuousMode === true ||
    explicitStormbreakerRequest ||
    isStormbreakerAutoEnabled()
  );
  const stormbreakerSwarm =
    !req.agentAppMode &&
    !restrictedReadBoundary &&
    chat.kind !== "division" &&
    !chat.continuousMode &&
    (explicitStormbreakerRequest || isStormbreakerAutoEnabled()) &&
    !isTrivialPrompt(req.userPrompt);

  // ── MCP 툴 브리지 ──────────────────────────────────────────
  // Claude Code/Codex 러너에는 요청/에이전트 문맥으로 필요한 MCP 플러그인을 자동 선택한 뒤
  // 런타임별 설정으로 직렬화해 넘긴다. env가 필요한 플러그인은 vault 값이 있을 때만 자동 설치한다.
  let mcpConfigPath: string | undefined;
  let mcpAllowedTools: string[] | undefined;
  let mcpCodexConfigArgs: string[] | undefined;
  let mcpRuntimeEnv: Record<string, string> | undefined;
  let mcpAutoSelectionPrompt = "";
  const runtimeCanUseMcp = active.kind === "claude-code" || active.kind === "codex";
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
  if (runtimeCanUseMcp && !req.agentAppMode && canWrite) {
    try {
      const selectedContext = await autoSelectMcpTools({
        userPrompt: effectiveUserPrompt,
        systemPrompt: buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt),
        agentName: agent.nameEn || agent.name,
        workingFolder,
        toolMode: req.toolMode,
        hubMode: req.hubMode,
      });
      mcpAutoSelectionPrompt = buildMcpAutoSelectionPrompt(selectedContext, {
        toolMode: req.toolMode,
        hubMode: req.hubMode,
      });
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
      const cfg = await buildMcpConfigFile({
        ...(req.mcpBrowserProfileKey ? { browserProfileKey: req.mcpBrowserProfileKey } : {}),
        catalogIds: installedTools.map((tool) => tool.id),
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

  // ── Agent Group 오케스트레이션 ───────────────────────────
  // 저장된 그룹은 firm/division보다 상위의 라우팅 묶음이다. 실행 직전에
  // installed agents, org chart, live Hub catalog/bundle을 다시 풀어서 최신 경로로 호출한다.
  if (chat.agentGroupId) {
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
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: runnerEnv.env,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "agent-group-failed", err) });
    }
    return earlyResult();
  }

  // ── Hub borrowed task force ─────────────────────────────────
  // 추천 시트에서 Hub 에이전트 2개 이상을 고른 경우: 단일 프롬프트에 "여러 전문가를 적용"이라고
  // 뭉개지 않고, 로컬 오케스트레이터가 에이전트별 입력 패킷을 설계한 뒤 각 borrowed agent를
  // 별도 세션으로 병렬 실행하고 최종 종합한다.
  // 명시적 Hub borrow는 swarm보다 먼저 실행한다. 그렇지 않으면 swarm이 req.borrowAgents를
  // 소비하지 않은 채 로컬 워커만 실행해 Hub 권한/번들 검증을 우회할 수 있다.
  if (borrowedAgentSlugs.length > 1 && chat.kind !== "division") {
    try {
      await runBorrowedTaskForceInvocation({
        req: { ...req, borrowAgents: borrowedAgentSlugs },
        chat,
        orchestratorAgent: agent,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: runnerEnv.env,
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
    !req.agentAppMode &&
    (chat.swarmMode || stormbreakerSwarm) &&
    borrowedAgentSlugs.length === 0 &&
    chat.kind !== "division"
  ) {
    try {
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
        req,
        chat,
        orchestratorAgent: agent,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        runnerEnv: runnerEnv.env,
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
  if (chat.firmId) {
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
            active,
            runtimes,
            picked,
            workingFolder,
            ...(workspaceBinding ? { workspaceBinding } : {}),
            ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
            mcpConfigPath,
            mcpAllowedTools,
            mcpCodexConfigArgs,
            agentAppMcpRuntimeEnv: mcpRuntimeEnv,
            onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
            runnerEnv: runnerEnv.env,
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
  let systemPrompt = buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt);
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
    systemPrompt =
      `## Briefing gate (before executing)\n` +
      `First judge silently: are the goal, constraints and success criteria of this request specific enough ` +
      `that a stranger would produce the same result? If YES — proceed normally and ask NOTHING. ` +
      `If NO (execution-shaped but ambiguous): ask ONE batch of 3-5 <<agentlas-ask>> questions covering the ` +
      `weakest of: what NOT to do (anti-scope), smallest acceptable version, done signal, audience. ` +
      `Then STOP and wait. After the answers arrive, restate the goal in one sentence and proceed — never ask a second batch; ` +
      `record what is still open as explicit assumptions instead. 'decide later' is a valid answer (record as deferred). ` +
      `Never use this gate for greetings, pure questions, or already-specific instructions.\n\n${systemPrompt}`;
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
  const memoryReadPath = workingFolder && (
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
      });
      if (memoryContext) systemPrompt = `${systemPrompt}\n\n${memoryContext}`;
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
      systemPrompt = `${systemPrompt}\n\n${applicableRemoteOperational.directive}`;
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
          projectPath: workingFolder,
          environment: { platform: process.platform, arch: process.arch, runtimeKind: active.kind },
          basePackageHash: agent.packageHash ?? null,
          task: effectiveUserPrompt,
          reservedApproxTokens: applicableTasteSnapshot?.overlay.estimatedTokens ?? 0,
        });
        if (experienceContext.prompt) systemPrompt = `${systemPrompt}\n\n${experienceContext.prompt}`;
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
    systemPrompt = `${systemPrompt}\n\n${applicableTasteSnapshot.directive}`;
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
    systemPrompt = `${systemPrompt}\n\n${memoryEmitterPromptFor(effectiveUserPrompt)}`;
  }
  if (mcpAutoSelectionPrompt) systemPrompt = `${systemPrompt}\n\n${mcpAutoSelectionPrompt}`;
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
    systemPrompt = `${systemPrompt}\n\n${coreHarness.system_prompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`;
  }
  // 사용자 채팅에서만 자동화 생성 protocol 주입 (백그라운드 automation 실행 세션은 제외 → 재귀 방지)
  if (chat.kind !== "division" && canWrite) systemPrompt = `${systemPrompt}\n\n${AUTOMATION_PROTOCOL}`;

  const history = req.agentAppMode ? [] : listChatMessages(chat.id, 80);

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  if (!req.agentAppMode) {
    appendChatMessage(chat.id, "user", req.userPrompt);
    if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);
  }

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

  try {
    const runtimeUserPrompt = explicitBorrowUserPreamble
      ? `${explicitBorrowUserPreamble}\n\nRequest:\n${effectiveUserPrompt}`
      : effectiveUserPrompt;
    const runnerReq = {
      systemPrompt,
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
      forceSurface: undefined,
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
    const runnerEvents = {
      onStatus: (status: string) => sink({ kind: "tool-use", status }),
      // A partial JSON fence cannot be safely sanitized. Restricted runs are
      // final-only so cancel/error can never persist an unfinished Memory block.
      onPartial: (text: string) => {
        if (!restrictedReadBoundary) {
          sink({ kind: "partial", text: partialFloor ? `${partialFloor}\n${text}` : text });
        }
      },
      // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
      onTool: (name: string, args?: string, result?: string, id?: string, isError?: boolean) =>
        sink({ kind: "tool-use", tool: { name, args, result, id, isError } }),
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
    const continuousMode = !req.agentAppMode && !restrictedReadBoundary && chat.kind !== "division" && chat.continuousMode === true;
    const maxPasses = req.agentAppMode
      ? 1
      : continuousMode
        ? CONTINUOUS_MODE_MAX_PASSES
        : STORMBREAKER_MAX_EXECUTION_PASSES;
    let restrictedDiscardedMemoryEvents = 0;
    const sanitizeRestrictedPass = (passResult: Awaited<ReturnType<Runner>>) => {
      if (!restrictedReadBoundary) return passResult;
      const parsed = stripAllMemoryEventBlocks(passResult.text);
      restrictedDiscardedMemoryEvents += parsed.events.length;
      return { ...passResult, text: parsed.cleanedText };
    };
    let activeRunnerReq = runnerReq;
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
        appendChatMessage(chat.id, "assistant", continuation.text);
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
      let surfaceParse = parseSurfaces(displayText);
      if (surfaceParse.surfaces.length > 0 || surfaceParse.errors.length > 0) {
        displayText =
          surfaceParse.cleanedText.trim() ||
          (locale === "ko"
            ? "앱/패널 자동 생성은 꺼져 있습니다. 채팅 답변만 표시합니다."
            : "Automatic App/workbench generation is disabled. Showing chat output only.");
      }
    } catch (err) {
      console.error("[surface] parseSurfaces failed:", err);
    }
    if (!req.agentAppMode) {
      try {
        const curationContext = {
          projectPath: activePath,
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
          borrowedAgentSlugs,
        };
        const { cleanedText } = restrictedReadBoundary
          ? stripReplyMemoryEventsReadOnly(
              displayText,
              curationContext,
              restrictedDiscardedMemoryEvents,
            )
          : curateReply(displayText, curationContext);
        // Restricted cleanup may intentionally remove the entire response. Never
        // restore the raw control block through the ordinary empty-text fallback.
        displayText = restrictedReadBoundary ? cleanedText : cleanedText || displayText;
      } catch (err) {
        console.error("[architecture] curateReply failed:", err);
      }
    }

    // 컴팩션 요약 수집 — Claude Code가 이번 세션에서 컨텍스트를 자동 압축했다면 그 요약을
    // 큐레이터 인테이크(session/hypothesis) 티어로만 흘려보낸다. 심사·승격은 Curator 에이전트 몫.
    // 실패-무해: 트랜스크립트가 없거나(다른 런타임) 요약이 없으면 조용히 0건.
    try {
      if (!req.agentAppMode && !restrictedReadBoundary && result.sessionId) {
        harvestCompactionSummaries({
          sessionId: result.sessionId,
          cwd: workingFolder,
          ctx: {
            projectPath: activePath,
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
    const displayWithFloor = partialFloor ? `${partialFloor}\n${displayText}` : displayText;
    if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", displayWithFloor);
    // 연속 패스에서 result.tokens는 마지막 패스만 반영 — 라이브 누적 최고치와 큰 쪽을 확정치로.
    sink({ kind: "final", text: displayWithFloor, tokens: Math.max(result.tokens ?? 0, liveUsageHigh) || undefined });
    return {
      finalText: displayWithFloor,
      tokens: result.tokens,
      stormbreakerContinueRequested,
      resultFolder: resolvedResultFolder,
    };
  } catch (err) {
    sink({ kind: "error", error: invocationFailure(req, "runner-failed", err) });
    return earlyResult();
  }
}
