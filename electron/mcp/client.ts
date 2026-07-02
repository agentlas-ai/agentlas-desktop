// 활성 백엔드 → 실제 러너로 라우팅하는 invocation runner.
// PRD §3.1 6단계 BYOC: 사용자 머신에서 사용자의 구독/키로 직접 호출.
// chatId 기반 — chat에서 agent + project 컨텍스트 lookup.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectRuntimes } from "../runtime/detect";
// Stormbreaker Loop — 목표 분해/연속 실행/검증 가능한 오류 repair를 감독(비차단·실패-무해).
import { superviseStormbreaker, type StormbreakerHandle } from "../hephaestus/stormbreaker-supervisor";
import { hepCall, routeOnly } from "../hephaestus/commands";
import { normalizeRecommendation } from "../hephaestus/recommendation";
import {
  buildStormbreakerLongRunPrompt,
  buildStormbreakerContinuationPrompt,
  CONTINUOUS_MODE_MAX_PASSES,
  STORMBREAKER_LONG_RUN_SCHEDULE,
  STORMBREAKER_LOOP_PROTOCOL,
  STORMBREAKER_MAX_EXECUTION_PASSES,
  STORMBREAKER_MAX_REPAIR_PASSES,
  stripStormbreakerContinueMarker,
} from "../hephaestus/loop-engineering";
import { getAgentById, listInstalledAgents } from "./registry";
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
import { getFirm } from "../store/firms";
import { getResolvedOrg } from "../store/org-spec";
import { runFirmInvocation } from "./firm-orchestrator";
import {
  normalizeBorrowedAgentSpecs,
  runBorrowedTaskForceInvocation,
  type BorrowedAgentSpec,
} from "./borrowed-task-force";
import { runSwarmInvocation } from "./swarm-run";
import { resolveAgentGroupForRuntime } from "../store/agent-groups";
import { recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import { curateReply } from "../memory/curator";
import { MEMORY_EMITTER_BLOCK } from "../architecture/manifest";
import { APP_BUILDER_SLUG } from "../architecture/manifest";
import { AUTOMATION_PROTOCOL, parseAutomations } from "../automation-emitter";
import { SURFACE_PROTOCOL, parseSurfaces, type SurfaceManifestDiagnostic } from "../surface-emitter";
import { runHandsFreeAgentOs, shouldRunHandsFreeAgentOs } from "../agent-os/hands-free";
import { prepareCreativeAdPackManifest } from "../creative-pack/surface";
import { prepareEcommerceOpsManifest } from "../ecommerce-pack/surface";
import { createAutomation, listAutomations } from "../store/automations";
import { recordAgentSurface } from "../store/agent-surfaces";
import { getAgentApp } from "../store/agent-apps";
import { autoSelectMcpTools, buildMcpAutoSelectionPrompt } from "../mcp-tools/auto-select";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { buildRunnerEnv } from "../runtime/env-resolver";
import { type Runner, SURFACE_INTENT_MARKER } from "../runtime/runner";
import { pickActive, pickRunner, selectRuntimeForTargets } from "../runtime/selection";
import { pickLocale, tStatus } from "../runtime/status-i18n";
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

function buildAppsGenerateUserPrompt(prompt: string, locale: "ko" | "en"): string {
  const guide =
    locale === "ko"
      ? [
          "Agentlas Apps Generate 모드가 켜져 있다.",
          "사용자의 목표를 Agentlas Desktop Apps 목록에 등록되는 하나의 로컬 웹앱으로 만들어라.",
          "반드시 Agentlas Surface Manifest를 emit하라: <<agentlas-surface>> JSON 블록을 포함하고, layout은 service-app 또는 creative-studio, app.routes/connectors/tools, launch 체크리스트, scaffold-app action, operate-app action을 선언한다.",
          "사용자 앱 UI는 Agentlas Desktop renderer 안에 만들지 마라. 구현 파일 생성은 Agentlas App Factory가 surface manifest를 받아 처리하고, 실행은 `http://localhost:3000` 같은 launchUrl 로컬 웹앱에서 이뤄진다.",
          "Apps는 generated app 목록, 실행 링크, 파일 경로, 작업 ledger를 보관하는 런처다. 실제 앱 UI/UX와 웹 런타임은 로컬 브라우저 기반으로 설계한다.",
          "자산, vault 자격증명, MCP 서버, 로컬 파일, 생성물은 Apps 자체가 아니라 Apps를 구동하기 위한 장치이자 부산물로 취급한다.",
          "사용자가 이미 쓰는 Agentlas 채팅의 어떤 AI와 대화하더라도 설치된 Apps를 호출할 수 있게 설계하라.",
          "응답은 사용자의 언어로 짧게 요약하고, 숨은 사고 과정은 노출하지 않는다.",
        ].join("\n")
      : [
          "Agentlas Apps Generate mode is enabled.",
          "Turn the user's goal into one local web app registered in the Agentlas Desktop Apps list.",
          "You MUST emit an Agentlas Surface Manifest: include a <<agentlas-surface>> JSON block, use layout service-app or creative-studio, and declare app.routes/connectors/tools, a launch checklist, a scaffold-app action, and an operate-app action.",
          "Do not build the user app UI inside the Agentlas Desktop renderer. Agentlas App Factory creates implementation files from the surface manifest, and execution happens through a launchUrl local web app such as http://localhost:3000.",
          "Apps is the generated-app registry, launcher, file-path surface, and operations ledger. Design the actual app UI/UX and web runtime for a local browser.",
          "Assets, vault credentials, MCP servers, local files, and generated artifacts are support devices or byproducts for running the App, not separate top-level products.",
          "Design it so any AI used in Agentlas Desktop chat can call installed Apps.",
          "Keep the visible reply concise, match the user's language, and do not expose hidden chain-of-thought.",
        ].join("\n");
  return `${guide}\n\nUser goal:\n${prompt}`;
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
 * 에이전트와 grounding 만 제공한다. 오프라인/허브 미연결이면 hep-call 이 비어도 슬러그를
 * 명시한 기본 지시로 폴백한다(런타임이 시도하도록).
 */
async function buildBorrowDirective(
  slugs: string[],
  prompt: string,
  project: string | null,
  locale: "ko" | "en",
): Promise<string> {
  const list = slugs.join(", ");
  let directive = "";
  try {
    const res = await hepCall(slugs.join(","), [prompt], { project: project ?? "." });
    const j = (res.json ?? null) as Record<string, unknown> | null;
    const top = j?.directive;
    if (typeof top === "string" && top.trim()) {
      directive = top.trim();
    } else {
      const agents = Array.isArray(j?.agents) ? (j!.agents as Array<Record<string, unknown>>) : [];
      const fromAgent = agents.map((a) => a?.directive).find((d) => typeof d === "string" && d.trim());
      if (typeof fromAgent === "string") directive = fromAgent.trim();
    }
  } catch {
    // 오프라인/허브 미연결 → 기본 지시로 폴백.
  }
  const header =
    locale === "ko"
      ? `[Hephaestus Network · 빌려온 Hub 에이전트: ${list}]`
      : `[Hephaestus Network · borrowed Hub agents: ${list}]`;
  const body =
    directive ||
    (locale === "ko"
      ? "위 빌려온 전문가 에이전트(들)를 현재 프로젝트에 attach해서 아래 요청을 처리해줘. 각 에이전트의 실제 전문성을 적용하고 결과를 종합해."
      : "Apply the borrowed specialist agent(s) above to the request below, attached to the current project. Use each agent's actual expertise and synthesize the result.");
  return `${header}\n${body}\n\nRequest:\n${prompt}`;
}

async function buildAgentGroupTaskForceSpecs(input: {
  groupId: string;
  prompt: string;
  project: string | null;
  locale: "ko" | "en";
  sink: EventSink;
}): Promise<{ groupName: string; orchestratorName: string; specs: BorrowedAgentSpec[] }> {
  const resolved = await resolveAgentGroupForRuntime(input.groupId);
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
  const hubSlugs = resolved.members.filter((member) => member.source === "hub").map((member) => member.slug);
  let hubSpecs = new Map<string, BorrowedAgentSpec>();
  if (hubSlugs.length > 0) {
    try {
      const res = await hepCall(hubSlugs.join(","), [input.prompt], { project: input.project ?? "." });
      hubSpecs = new Map(normalizeBorrowedAgentSpecs(hubSlugs, res.json ?? null).map((spec) => [spec.slug, spec]));
    } catch {
      hubSpecs = new Map(normalizeBorrowedAgentSpecs(hubSlugs, null).map((spec) => [spec.slug, spec]));
    }
  }
  const specs = resolved.members.map((member): BorrowedAgentSpec => {
    const hub = member.source === "hub" ? hubSpecs.get(member.slug) : null;
    return {
      slug: member.slug,
      name: hub?.name || member.name,
      directive: hub?.directive || member.directive,
      source: member.source,
      routeLabel: member.routeLabel,
      warnings: member.warnings,
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

function appendAppsGenerateCta(text: string, prompt: string, locale: "ko" | "en"): string {
  if (/\/apps\/[a-z0-9-]+/i.test(text)) return text;
  const wantsDocumentApp =
    /document|docstudio|report|paper|writer|text|문서|리포트|논문|글쓰기/i.test(prompt);
  const appPath = wantsDocumentApp ? "/apps/document-studio" : "/apps";
  const label = locale === "ko" ? "Apps에서 확인하기" : "Open in Apps";
  const note =
    locale === "ko"
      ? "생성된 App은 Agentlas Desktop의 Apps 표면에서 열 수 있습니다."
      : "The generated App can be opened from the Agentlas Desktop Apps surface.";
  return `${text.trim()}\n\n---\n${note}\n\n[${label}](${appPath})`;
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

function buildSurfaceRepairPrompt(
  invalidText: string,
  errors: string[],
  diagnostics: SurfaceManifestDiagnostic[] = [],
): string {
  return [
    "Repair the Agentlas Surface Manifest in the prior assistant output.",
    "Return a short natural-language sentence plus exactly one corrected <<agentlas-surface>> JSON block.",
    "Do not add new facts, prices, citations, credentials, code, HTML, JavaScript, CSS, or scripts.",
    "Preserve the user's visible answer intent, but fix only the manifest structure.",
    "",
    "Validation errors:",
    ...errors.map((error) => `- ${error}`),
    ...(diagnostics.length > 0
      ? [
          "",
          "Structured diagnostics JSON:",
          JSON.stringify(
            diagnostics.map((diagnostic) => ({
              code: diagnostic.code,
              severity: diagnostic.severity,
              path: diagnostic.path,
              message: diagnostic.message,
              repairHint: diagnostic.repairHint,
            })),
            null,
            2,
          ),
        ]
      : []),
    "",
    SURFACE_PROTOCOL,
    "",
    "Invalid assistant output:",
    invalidText,
  ].join("\n");
}

async function runLocalAgentOsIntent(
  input: {
    req: McpInvocationRequest;
    chat: Chat;
    agent: InstalledAgent;
    workingFolder?: string | null;
    reason: string;
  },
  sink: EventSink,
): Promise<boolean> {
  if (input.chat.kind === "division") return false;
  const ecommerceManifest = prepareEcommerceOpsManifest({
    prompt: input.req.userPrompt,
  });
  const manifest =
    ecommerceManifest ??
    (await prepareCreativeAdPackManifest({
      prompt: input.req.userPrompt,
      images: input.req.images,
    }));
  if (!manifest || !shouldRunHandsFreeAgentOs(manifest)) return false;

  const history = listChatMessages(input.chat.id, 80);
  appendChatMessage(input.chat.id, "user", input.req.userPrompt);
  if (history.length === 0) autoTitleFromFirstMessage(input.chat.id, input.req.userPrompt);

  sink({
    kind: "thinking",
    status: `Local Agentlas OS meta-agent is preparing a ${manifest.domain} surface`,
  });
  const surfaceId = randomUUID();
  recordAgentSurface({
    id: surfaceId,
    chatId: input.chat.id,
    projectId: input.chat.projectId,
    agentId: input.agent.id,
    manifest,
  });
  sink({ kind: "surface", surfaceId, surface: manifest });

  try {
    const osResult = await runHandsFreeAgentOs({
      chat: input.chat,
      surfaceId,
      manifest,
      workingFolder: input.workingFolder,
      sink,
    });
    const lifecycleLabel =
      manifest.domain === "ecommerce"
        ? "created the commerce agent team/app lifecycle"
        : manifest.domain === "creative"
          ? "materialized the creative asset pack/app lifecycle"
          : "materialized the domain app lifecycle";
    let displayText = [
      "Agentlas local meta-agent handled this without a hosted model runtime.",
      `Reason: ${input.reason}`,
      `It created the declarative ${manifest.domain} Agentlas OS surface, ${lifecycleLabel}, and operated the generated app through reversible OS actions.`,
      `Agentlas OS: ${osResult.summary}`,
    ].join("\n\n");
    try {
      const { cleanedText } = curateReply(displayText, {
        projectPath: null,
        projectId: input.chat.projectId ?? null,
        agentId: input.agent.id,
        chatId: input.chat.id,
        cwdAtRequest: input.workingFolder,
      });
      displayText = cleanedText || displayText;
    } catch (err) {
      console.error("[architecture] curateReply failed for local Agent OS:", err);
    }
    appendChatMessage(input.chat.id, "assistant", displayText);
    sink({ kind: "final", text: displayText });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink({ kind: "error", error: { code: "local-agent-os-failed", message } });
    return true;
  }
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
): Promise<{ finalText?: string; tokens?: number; stormbreakerContinueRequested: boolean }> {
  // 한 마이크로태스크 양보 — ipc:run 핸들러가 { runId }를 반환하고 렌더러가 이벤트 채널을
  // 구독한 뒤에야 sink가 발화하도록 보장한다. 이게 없으면 동기 early-return(no-chat/no-agent)
  // 에러가 구독 전에 발화돼 렌더러가 종료 이벤트를 놓치고 busy(정지 버튼)가 영구 고착된다.
  await Promise.resolve();
  const locale = pickLocale(req);
  const chat = getChat(req.chatId);
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return { stormbreakerContinueRequested: false };
  }
  let agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return { stormbreakerContinueRequested: false };
  }
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
    return { stormbreakerContinueRequested: false };
  }
  let effectiveUserPrompt = isTargetAppEdit && targetApp
    ? buildAppEditUserPrompt(req.userPrompt, targetApp, locale)
    : req.appsGenerateMode
    ? buildAppsGenerateUserPrompt(req.userPrompt, locale)
    : req.goalMode
      ? buildGoalUserPrompt(req.userPrompt, locale)
      : req.planMode
        ? buildPlanUserPrompt(req.userPrompt, locale)
        : req.userPrompt;
  const borrowedAgentSlugs = [...new Set((req.borrowAgents ?? []).map((slug) => slug.trim()).filter(Boolean))];
  if (req.pipelineStages && req.pipelineStages.length > 0) {
    effectiveUserPrompt = buildRecommendedPipelineUserPrompt(effectiveUserPrompt, req.pipelineStages, locale);
  }

  // 추천 시트 네트워크 모드(단일) — 고른 Hub 에이전트를 빌려와 프롬프트 앞에 borrow 지시를 붙인다(BYOM).
  // 2개 이상은 아래 Borrowed Task Force 실행기로 분기해 plan → parallel delegate → synthesize를 수행한다.
  if (borrowedAgentSlugs.length === 1) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Hub 에이전트 빌리는 중: ${borrowedAgentSlugs.join(", ")}`
          : `Borrowing Hub agents: ${borrowedAgentSlugs.join(", ")}`,
    });
    effectiveUserPrompt = await buildBorrowDirective(
      borrowedAgentSlugs,
      effectiveUserPrompt,
      getChatWorkingFolder(chat.id),
      locale,
    );
  }

  const installedAgents = listInstalledAgents();
  // plain 대화(인사/맞장구)는 라우팅 전체를 건너뛰고 기본 LLM이 즉답 — 전문 에이전트로
  // 잘못 위임되거나 아래 Hephaestus 에스컬레이션 선지연을 무는 엣지케이스를 없앤다.
  const plainConversation = !req.appsGenerateMode && !isTargetAppEdit && isPlainConversationalPrompt(req.userPrompt);
  const autoRoute = isTargetAppEdit
    ? selectAppBuilderForExistingAppEdit(installedAgents, locale)
    : !plainConversation && (req.appsGenerateMode || isGlobalOrchestrator(agent))
      ? selectAutoRoutedAgent(effectiveUserPrompt, installedAgents, locale)
      : null;
  if (autoRoute) {
    sink({ kind: "tool-use", status: autoRouteStatus(autoRoute, locale) });
    agent = autoRoute.agent;
  }

  // 사용자가 프롬프트 안에 "project folder: /abs/path"처럼 명시하면, 채팅 워킹 폴더로
  // 자동 고정한다. firm 경로도 단일 에이전트 경로와 같은 cwd/MCP 구성을 받아야 한다.
  const existingWorkingFolder = getChatWorkingFolder(chat.id);
  const projectWorkingFolder = chat.projectId ? getProject(chat.projectId)?.folderPath ?? null : null;
  const inferredWorkingFolder =
    existingWorkingFolder || projectWorkingFolder ? null : inferWorkingFolderFromPrompt(req.userPrompt);
  if (inferredWorkingFolder) setChatWorkingFolder(chat.id, inferredWorkingFolder);
  const targetAppWorkingFolder = targetApp ? path.resolve(targetApp.rootPath) : null;
  const workingFolder = targetAppWorkingFolder ?? existingWorkingFolder ?? projectWorkingFolder ?? inferredWorkingFolder;

  // ── Hephaestus Router Agent 에스컬레이션 판단 ──
  // 이전에는 기본 채팅(글로벌 오케스트레이터)의 모든 메시지가 이 동기 호출을 최대 15초까지
  // 기다렸다 — 짧은 단일 작업까지 선지연을 물던 주범. 멀티도메인/파이프라인 신호가 있는
  // 복합 요청에만 에스컬레이션하고 타임아웃도 4초로 줄인다(실패/타임아웃 시 조용히 진행).
  let routerAgent = req.routerAgent;
  if (
    !routerAgent &&
    (req.appsGenerateMode ||
      (isGlobalOrchestrator(agent) && isEscalationWorthyPrompt(req.userPrompt)))
  ) {
    try {
      const routeRes = await routeOnly(effectiveUserPrompt, {
        project: workingFolder ?? undefined,
        allowLocal: true,
        timeoutMs: 4_000,
      });
      const norm = normalizeRecommendation(routeRes.json, effectiveUserPrompt);
      if (norm.routerAgent) {
        routerAgent = norm.routerAgent;
      }
    } catch (err) {
      console.error("[routing] Dynamic Hephaestus routing check failed:", err);
    }
  }

  const runtimes = await detectRuntimes();
  const runtimeChoice = selectRuntimeForTargets(runtimes, [
    { scope: "agent", targetId: agent.id },
    { scope: "firm", targetId: chat.firmId },
  ]);
  if (!runtimeChoice) {
    const handled = await runLocalAgentOsIntent(
      {
        req,
        chat,
        agent,
        workingFolder,
        reason: "No local CLI/BYOK runtime is active, so the built-in Agentlas OS meta-agent took over.",
      },
      sink,
    );
    if (handled) return { stormbreakerContinueRequested: false };
    sink({
      kind: "error",
      error: { code: "no-runtime", message: tStatus(locale, "errNoRuntime") },
    });
    return { stormbreakerContinueRequested: false };
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

  const active = runtimeChoice.active;
  const picked = runtimeChoice.picked;
  if (!picked) {
    const handled = await runLocalAgentOsIntent(
      {
        req,
        chat,
        agent,
        workingFolder,
        reason: `Runtime ${active.kind} is available but has no supported runner, so the built-in Agentlas OS meta-agent took over.`,
      },
      sink,
    );
    if (handled) return { stormbreakerContinueRequested: false };
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
    return { stormbreakerContinueRequested: false };
  }

  // ── MCP 툴 브리지 ──────────────────────────────────────────
  // Claude Code/Codex 러너에는 요청/에이전트 문맥으로 필요한 MCP 플러그인을 자동 선택한 뒤
  // 런타임별 설정으로 직렬화해 넘긴다. env가 필요한 플러그인은 vault 값이 있을 때만 자동 설치한다.
  let mcpConfigPath: string | undefined;
  let mcpAllowedTools: string[] | undefined;
  let mcpCodexConfigArgs: string[] | undefined;
  let mcpAutoSelectionPrompt = "";
  const runtimeCanUseMcp = active.kind === "claude-code" || active.kind === "codex";
  if (runtimeCanUseMcp) {
    try {
      const selectedTools = await autoSelectMcpTools({
        userPrompt: effectiveUserPrompt,
        systemPrompt: agent.systemPrompt,
        agentName: agent.nameEn || agent.name,
        workingFolder,
      });
      mcpAutoSelectionPrompt = buildMcpAutoSelectionPrompt(selectedTools);
      const installedTools = selectedTools.filter((tool) => tool.installed);
      if (installedTools.length > 0) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · auto-select",
            result: installedTools.map((tool) => `${tool.id}: ${tool.reason}`).join("\n"),
          },
        });
      }
      const cfg = await buildMcpConfigFile();
      if (cfg) {
        mcpConfigPath = cfg.configPath;
        mcpAllowedTools = cfg.allowedTools;
        mcpCodexConfigArgs = cfg.codexConfigArgs;
      }
    } catch (err) {
      console.error("[mcp] buildMcpConfigFile failed:", err);
    }
  }

  const runnerEnv = await buildRunnerEnv(agent, workingFolder ?? undefined);

  // ── Agent Group 오케스트레이션 ───────────────────────────
  // 저장된 그룹은 firm/division보다 상위의 라우팅 묶음이다. 실행 직전에
  // installed agents, org chart, live Hub catalog/bundle을 다시 풀어서 최신 경로로 호출한다.
  if (chat.agentGroupId && chat.kind !== "division") {
    try {
      const groupRun = await buildAgentGroupTaskForceSpecs({
        groupId: chat.agentGroupId,
        prompt: effectiveUserPrompt,
        project: workingFolder,
        locale,
        sink,
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
        picked,
        workingFolder,
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        runnerEnv: runnerEnv.env,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "agent-group-failed", message: msg } });
    }
    return { stormbreakerContinueRequested: false };
  }

  // ── Hub borrowed task force ─────────────────────────────────
  // 추천 시트에서 Hub 에이전트 2개 이상을 고른 경우: 단일 프롬프트에 "여러 전문가를 적용"이라고
  // 뭉개지 않고, 로컬 오케스트레이터가 에이전트별 입력 패킷을 설계한 뒤 각 borrowed agent를
  // 별도 세션으로 병렬 실행하고 최종 종합한다.
  // ── 스웜 모드 ──
  // 켜져 있으면 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업(emergent A2A). 동시성=사용자 슬라이더.
  if (chat.swarmMode && chat.kind !== "division") {
    try {
      await runSwarmInvocation({
        req,
        chat,
        orchestratorAgent: agent,
        active,
        picked,
        workingFolder,
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        runnerEnv: runnerEnv.env,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "swarm-failed", message: msg } });
    }
    return { stormbreakerContinueRequested: false };
  }

  if (borrowedAgentSlugs.length > 1 && chat.kind !== "division") {
    try {
      await runBorrowedTaskForceInvocation({
        req: { ...req, borrowAgents: borrowedAgentSlugs },
        chat,
        orchestratorAgent: agent,
        active,
        picked,
        workingFolder,
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        runnerEnv: runnerEnv.env,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink({ kind: "error", error: { code: "borrowed-task-force-failed", message: msg } });
    }
    return { stormbreakerContinueRequested: false };
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
          await runFirmInvocation({
            req: { ...req, userPrompt: effectiveUserPrompt },
            chat: { id: chat.id, projectId: chat.projectId, firmId: chat.firmId },
            org,
            ceoAgent: agent,
            active,
            runtimes,
            picked,
            workingFolder,
            mcpConfigPath,
            mcpAllowedTools,
            mcpCodexConfigArgs,
            runnerEnv: runnerEnv.env,
            locale,
            sink,
            signal,
          });
        } catch (err) {
          // 오케스트레이션 실패 → 무한 스피너 방지: 에러 이벤트 emit
          const msg = err instanceof Error ? err.message : String(err);
          sink({ kind: "error", error: { code: "firm-failed", message: msg } });
        }
        return { stormbreakerContinueRequested: false };
      }
    }
  }

  // 프로젝트 컨텍스트 노트가 있으면 system prompt 뒤에 append
  let systemPrompt = agent.systemPrompt;
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
  if (chat.projectId) {
    const project = getProject(chat.projectId);
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
  if (workingFolder) {
    try {
      const visit = recordFolderVisit(workingFolder);
      if (visit.activated) activePath = workingFolder;
    } catch (err) {
      console.error("[architecture] recordFolderVisit failed:", err);
    }
  }
  try {
    const memoryContext = buildMemoryContext(activePath);
    if (memoryContext) systemPrompt = `${systemPrompt}\n\n${memoryContext}`;
  } catch (err) {
    console.error("[architecture] buildMemoryContext failed:", err);
  }
  // 모든 대화에 메모리 이벤트 emitter를 동봉 → 큐레이터가 전역적으로 기억을 관리.
  systemPrompt = `${systemPrompt}\n\n${MEMORY_EMITTER_BLOCK}`;
  if (mcpAutoSelectionPrompt) systemPrompt = `${systemPrompt}\n\n${mcpAutoSelectionPrompt}`;
  // Stormbreaker Loop — 일반 채팅과 백그라운드 자동화 모두 같은 목표 분해/연속 실행 계약을 공유한다.
  systemPrompt = `${systemPrompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`;
  // 사용자 채팅에서만 자동화 생성 protocol 주입 (백그라운드 automation 실행 세션은 제외 → 재귀 방지)
  if (chat.kind !== "division") systemPrompt = `${systemPrompt}\n\n${AUTOMATION_PROTOCOL}`;

  const history = listChatMessages(chat.id, 80);

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  appendChatMessage(chat.id, "user", req.userPrompt);
  if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);

  sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });

  // Stormbreaker 슈퍼바이저 — 활성·가용하면 이 실행을 scope→route→gate 로 감독한다(비차단).
  // division(백그라운드 firm 하위) 세션은 제외(재귀/노이즈 방지). 실패/부재 시 null → no-op.
  let stormbreaker: StormbreakerHandle | null = null;
  if (chat.kind !== "division") {
    stormbreaker = superviseStormbreaker({
      query: req.userPrompt,
      cwd: workingFolder ?? undefined,
      emit: (tool) => sink({ kind: "tool-use", tool }),
      signal,
    });
  }

  try {
    const runnerReq = {
      systemPrompt,
      history,
      userPrompt: effectiveUserPrompt,
      images: req.images,
      backendLabel: picked.label,
      model: active.model ?? undefined,
      longContext: active.longContextEnabled ?? false,
      effort: active.effort ?? undefined,
      signal,
      permission: req.appsGenerateMode ? "read" : req.permissions,
      // 세션 resume 키 — CLI 러너가 (chatId, kind)별 세션을 재사용해
      // 시스템 프롬프트/히스토리를 매 턴 재전송하지 않게 한다.
      chatId: chat.id,
      mcpConfigPath,
      mcpAllowedTools,
      mcpCodexConfigArgs,
      env: runnerEnv.env,
      // 사용자가 지정한 워킹 폴더(프로젝트)에서 에이전트를 실행 — 빌드/파일 생성이 거기서 일어난다.
      // 활성화(2회 방문) 게이팅과 무관하게, 폴더가 지정돼 있으면 즉시 cwd로 사용한다.
      cwd: workingFolder ?? undefined,
      locale,
      forceSurface: req.appsGenerateMode || undefined,
    };
    const runnerEvents = {
      onStatus: (status: string) => sink({ kind: "tool-use", status }),
      onPartial: (text: string) => sink({ kind: "partial", text }),
      // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
      onTool: (name: string, args?: string, result?: string, id?: string, isError?: boolean) =>
        sink({ kind: "tool-use", tool: { name, args, result, id, isError } }),
    };
    // "계속 라이브로" 모드: 채팅에 켜져 있으면 짧은 상한(3턴)에서 멈춰 30분 간격 백그라운드로
    // 넘기지 않고, 같은 채팅에서 라이브 스트리밍을 계속 이어간다(사실상 무제한, 안전 상한만).
    const continuousMode = chat.kind !== "division" && chat.continuousMode === true;
    const maxPasses = continuousMode ? CONTINUOUS_MODE_MAX_PASSES : STORMBREAKER_MAX_EXECUTION_PASSES;
    let activeRunnerReq = runnerReq;
    let result = await picked.runner(activeRunnerReq, runnerEvents);
    for (let pass = 2; pass <= maxPasses; pass += 1) {
      const continuation = stripStormbreakerContinueMarker(result.text);
      if (!continuation.shouldContinue || signal?.aborted) {
        result = { ...result, text: continuation.text };
        break;
      }
      result = { ...result, text: continuation.text };
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
      activeRunnerReq = {
        ...runnerReq,
        userPrompt: buildStormbreakerContinuationPrompt(result.text, pass),
        images: undefined,
      };
      result = await picked.runner(activeRunnerReq, runnerEvents);
    }
    const finalContinuation = stripStormbreakerContinueMarker(result.text);
    const stormbreakerContinueRequested = finalContinuation.shouldContinue;
    result = { ...result, text: finalContinuation.text };
    // continuousMode는 안전 상한(20,000턴)이 사실상 안 걸리므로 정상적으론 이 분기에 안 들어온다.
    // 혹시라도 상한에 닿았는데 아직 할 일이 있다고 하면(진짜 폭주 등) 작업을 잃지 않도록 기존
    // 백그라운드 30분 자동화로 안전하게 이어받는다.
    if (stormbreakerContinueRequested && chat.kind !== "division") {
      const marker = `Source chat: ${chat.id}`;
      const exists = listAutomations().some((automation) => automation.enabled && automation.promptTemplate.includes(marker));
      if (!exists) {
        createAutomation({
          name: `Stormbreaker continuation · ${chat.title || agent.name}`,
          scheduleHuman: STORMBREAKER_LONG_RUN_SCHEDULE,
          targetType: chat.firmId ? "firm" : "agent",
          targetId: chat.firmId ?? chat.agentId,
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

    // 2차 패스(모델 판단 surface 게이트): 1차에서 무거운 SURFACE_PROTOCOL을 안 줬는데 모델이
    // "이건 surface가 낫다"고 판단해 마커만 냈으면 → 풀 프로토콜을 강제 주입(forceSurface)하고 재호출.
    // 사용자가 "대시보드"라 말 안 해도 와우모먼트가 뜬다(키워드 의존 X). 단순/일회성은 마커가 안 와 1패스로 끝.
    if (chat.kind !== "division" && result.text.trim().includes(SURFACE_INTENT_MARKER)) {
      sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });
      activeRunnerReq = { ...runnerReq, forceSurface: true };
      result = await picked.runner(activeRunnerReq, runnerEvents);
    }

    // 항상-켜진 큐레이터: 답변 끝의 "## Memory Events" 블록을 파싱해 안전·스코프·중복 처리 후
    // 내구 메모리에 기록하고, 사용자에게 보이는 텍스트에서는 그 블록을 제거한다(추가 LLM 호출 없음).
    let displayText = result.text.split(SURFACE_INTENT_MARKER).join("").trim();
    // 에이전트가 "## Automation" 블록을 넣었으면 → 현재 chat의 타깃(firm/agent)으로 자동화 등록 + 블록 제거.
    // (백그라운드 automation 실행 세션은 제외 → 자동화가 자동화를 만드는 재귀 방지)
    if (chat.kind !== "division") {
      try {
        const { automations: autos, cleanedText, errors } = parseAutomations(displayText);
        if (errors.length > 0) {
          // 조용히 드롭하지 않고 표면화(설계 §2.5) — 로그로 남겨 진단 가능하게.
          console.warn("[automation] parse warnings:", errors.join("; "));
        }
        for (const a of autos) {
          createAutomation({
            name: a.name,
            scheduleHuman: a.schedule,
            targetType: chat.firmId ? "firm" : "agent",
            targetId: chat.firmId ?? chat.agentId,
            promptTemplate: a.prompt,
            createdBy: "agent",
            // 구조화 스케줄 + steps→그래프를 통과시켜 챗 생성 자동화가 graph_json/schedule_json을 저장.
            scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
            timezone: a.tz && a.tz.trim() ? a.tz : null,
            graphJson: a.graph ?? null,
          });
        }
        displayText = cleanedText;
      } catch (err) {
        console.error("[automation] parseAutomations failed:", err);
      }
    }
    try {
      let surfaceParse = parseSurfaces(displayText);
      let surfaceText = displayText;
      let surfaceVisibleText = surfaceParse.cleanedText || displayText;
      let repairRuntimeSessionId = result.sessionId;
      for (let repairAttempt = 1; repairAttempt <= STORMBREAKER_MAX_REPAIR_PASSES; repairAttempt += 1) {
        const needsRepair =
          surfaceParse.surfaces.length === 0 &&
          surfaceParse.errors.length > 0 &&
          surfaceText.includes("<<agentlas-surface>>");
        if (!needsRepair) break;
        try {
          const reason = surfaceParse.errors.slice(0, 2).join("; ") || "surface manifest validation failed";
          stormbreaker?.repair({
            stage: "Agentlas surface manifest",
            reason,
            attempt: repairAttempt,
          });
          sink({ kind: "tool-use", status: `Repairing Agentlas surface manifest (${repairAttempt}/${STORMBREAKER_MAX_REPAIR_PASSES})` });
          const repaired = await picked.runner(
            {
              ...activeRunnerReq,
              history,
              userPrompt: buildSurfaceRepairPrompt(surfaceText, surfaceParse.errors, surfaceParse.diagnostics),
              images: undefined,
              runtimeSessionId: repairRuntimeSessionId,
            },
            {
              onStatus: (status) => sink({ kind: "tool-use", status }),
              onPartial: () => {},
              onTool: (name, args, result, id, isError) =>
                sink({ kind: "tool-use", tool: { name, args, result, id, isError } }),
            },
          );
          if (repaired.sessionId) repairRuntimeSessionId = repaired.sessionId;
          const repairedText = repaired.text.split(SURFACE_INTENT_MARKER).join("").trim();
          const repairedParse = parseSurfaces(repairedText);
          if (repairedParse.surfaces.length > 0) {
            surfaceParse = repairedParse;
            surfaceVisibleText = repairedParse.cleanedText || surfaceVisibleText;
            break;
          }
          surfaceText = repairedText;
          surfaceParse = repairedParse;
        } catch (err) {
          console.error("[surface] repair failed:", err);
          break;
        }
      }
      displayText = surfaceParse.surfaces.length > 0 ? (surfaceParse.cleanedText || surfaceVisibleText) : surfaceVisibleText;
      if (surfaceParse.surfaces.length === 0) {
        const seededEcommerceSurface = prepareEcommerceOpsManifest({
          prompt: req.userPrompt,
        });
        if (seededEcommerceSurface) {
          sink({ kind: "tool-use", status: "Preparing Ecommerce OS surface from business intent" });
          surfaceParse = {
            surfaces: [{ manifest: seededEcommerceSurface }],
            cleanedText: displayText,
            errors: [],
            diagnostics: [],
          };
          displayText = [
            displayText.trim(),
            "Prepared an Ecommerce OS surface from the business intent. Review the storefront, payment/database delegation, image budget, and operating dashboard in the Workbench.",
          ]
            .filter(Boolean)
            .join("\n\n");
        }
      }
      if (surfaceParse.surfaces.length === 0) {
        const seededCreativeSurface = await prepareCreativeAdPackManifest({
          prompt: req.userPrompt,
          images: req.images,
        });
        if (seededCreativeSurface) {
          sink({ kind: "tool-use", status: "Preparing Creative Studio surface from product input" });
          surfaceParse = {
            surfaces: [{ manifest: seededCreativeSurface }],
            cleanedText: displayText,
            errors: [],
            diagnostics: [],
          };
          displayText = [
            displayText.trim(),
            "Prepared a Creative Studio surface from the product input. Review the storyboard, trust labels, assets, and export pack in the Workbench.",
          ]
            .filter(Boolean)
            .join("\n\n");
        }
      }
      const handsFreeSummaries: string[] = [];
      for (const s of surfaceParse.surfaces) {
        const surfaceId = randomUUID();
        recordAgentSurface({
          id: surfaceId,
          chatId: chat.id,
          projectId: chat.projectId,
          agentId: agent.id,
          manifest: s.manifest,
        });
        sink({
          kind: "surface",
          surfaceId,
          surface: s.manifest,
        });
        if (shouldRunHandsFreeAgentOs(s.manifest)) {
          try {
            const osResult = await runHandsFreeAgentOs({
              chat,
              surfaceId,
              manifest: s.manifest,
              workingFolder,
              sink,
            });
            if (osResult.ran) handsFreeSummaries.push(osResult.summary);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[agent-os] hands-free run failed:", err);
            sink({ kind: "tool-use", status: `Agentlas OS paused for review: ${message}` });
            handsFreeSummaries.push(`Agentlas OS prepared the surface, but app operation needs review: ${message}`);
          }
        }
      }
      if (handsFreeSummaries.length > 0) {
        displayText = [displayText.trim(), ...handsFreeSummaries.map((summary) => `Agentlas OS: ${summary}`)]
          .filter(Boolean)
          .join("\n\n");
      }
    } catch (err) {
      console.error("[surface] parseSurfaces failed:", err);
    }
    try {
      const { cleanedText } = curateReply(displayText, {
        projectPath: activePath,
        projectId: chat.projectId ?? null,
        agentId: chat.agentId,
        chatId: chat.id,
        cwdAtRequest: workingFolder,
      });
      displayText = cleanedText || displayText;
    } catch (err) {
      console.error("[architecture] curateReply failed:", err);
    }

    if (req.appsGenerateMode) {
      displayText = appendAppsGenerateCta(displayText, req.userPrompt, locale);
    }

    // Stormbreaker 최종 게이트 — 답변 표출 직전 리뷰/증거 게이트(비차단·실패-무해).
    if (stormbreaker) {
      await stormbreaker.finish({ workspace: workingFolder ?? undefined, permission: req.permissions });
    }

    appendChatMessage(chat.id, "assistant", displayText);
    sink({ kind: "final", text: displayText, tokens: result.tokens });
    return { finalText: displayText, tokens: result.tokens, stormbreakerContinueRequested };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sink({ kind: "error", error: { code: "runner-failed", message: msg } });
    return { stormbreakerContinueRequested: false };
  }
}
