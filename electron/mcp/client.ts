// 활성 백엔드 → 실제 러너로 라우팅하는 invocation runner.
// PRD §3.1 6단계 BYOC: 사용자 머신에서 사용자의 구독/키로 직접 호출.
// chatId 기반 — chat에서 agent + project 컨텍스트 lookup.
import fs from "node:fs";
import path from "node:path";
import { detectRuntimes } from "../runtime/detect";
import { getAgentById, listInstalledAgents } from "./registry";
import {
  autoRouteStatus,
  autoRouteSystemPreamble,
  isGlobalOrchestrator,
  selectAutoRoutedAgent,
} from "../agents/auto-router";
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
import { recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import { curateReply } from "../memory/curator";
import { MEMORY_EMITTER_BLOCK } from "../architecture/manifest";
import { AUTOMATION_PROTOCOL, parseAutomations } from "../automation-emitter";
import { createAutomation } from "../store/automations";
import { runClaudeCode } from "../runtime/claude-code";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { runCodex } from "../runtime/codex";
import { runGemini } from "../runtime/gemini";
import {
  runAnthropicByok,
  runGoogleByok,
  runOpenAIByok,
  runUpstageByok,
} from "../runtime/byok";
import { runOllama } from "../runtime/ollama";
import type { Runner } from "../runtime/runner";
import { pickLocale, tStatus } from "../runtime/status-i18n";
import type {
  McpInvocationEvent,
  McpInvocationRequest,
  RuntimeStatus,
} from "../../shared/types";

type EventSink = (ev: McpInvocationEvent) => void;

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  "byok:anthropic": "Anthropic API",
  "byok:openai": "OpenAI API",
  "byok:google": "Google API",
  "byok:upstage": "Upstage Solar API",
};

function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (active.kind === "claude-code") return { runner: runClaudeCode, label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: runCodex, label: RUNNER_LABEL.codex };
  if (active.kind === "gemini") return { runner: runGemini, label: RUNNER_LABEL.gemini };
  if (active.kind === "ollama")
    return { runner: runOllama, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "byok") {
    if (active.backend === "anthropic")
      return { runner: runAnthropicByok, label: RUNNER_LABEL["byok:anthropic"] };
    if (active.backend === "openai")
      return { runner: runOpenAIByok, label: RUNNER_LABEL["byok:openai"] };
    if (active.backend === "google")
      return { runner: runGoogleByok, label: RUNNER_LABEL["byok:google"] };
    if (active.backend === "upstage")
      return { runner: runUpstageByok, label: RUNNER_LABEL["byok:upstage"] };
  }
  return null;
}

function pickActive(list: RuntimeStatus[]): RuntimeStatus | null {
  return list.find((r) => r.active) ?? list[0] ?? null;
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

function buildAppsGenerateUserPrompt(prompt: string, locale: "ko" | "en"): string {
  const guide =
    locale === "ko"
      ? [
          "Agentlas Apps Generate 모드가 켜져 있다.",
          "사용자의 목표를 Agentlas Desktop 안에서 실행되는 하나의 Apps 패키지로 만들어라.",
          "Apps는 Electron/Next renderer 안에서 열리는 앱스토어형 앱이며, 필요하면 자체 UI, UX, 백엔드 어댑터, MCP 도구, credential vault 요구사항, 생성 자산, 서브 엔진을 가진다.",
          "자산, vault 자격증명, MCP 서버, 로컬 파일, 생성물은 Apps 자체가 아니라 Apps를 구동하기 위한 장치이자 부산물로 취급한다.",
          "사용자가 이미 쓰는 Agentlas 채팅의 어떤 AI와 대화하더라도 설치된 Apps를 호출할 수 있게 설계하라.",
          "가능하면 실제 파일을 생성/수정하고, 구현 범위가 크면 최소 실행 가능한 Apps 구조와 다음 단계만 명확히 남겨라.",
        ].join("\n")
      : [
          "Agentlas Apps Generate mode is enabled.",
          "Turn the user's goal into one Apps package that runs inside Agentlas Desktop.",
          "An App is an app-store-style application opened inside the Electron/Next renderer, with its own UI, UX, backend adapters, MCP tools, credential-vault requirements, generated assets, and sub-engines when needed.",
          "Assets, vault credentials, MCP servers, local files, and generated artifacts are support devices or byproducts for running the App, not separate top-level products.",
          "Design it so any AI used in Agentlas Desktop chat can call installed Apps.",
          "Create or edit real files when possible; if the scope is large, leave a minimal runnable Apps structure plus clear next steps.",
        ].join("\n");
  return `${guide}\n\nUser goal:\n${prompt}`;
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

function appendAppsGenerateCta(text: string, prompt: string, locale: "ko" | "en"): string {
  if (/\/apps\/[a-z0-9-]+/i.test(text)) return text;
  const wantsDocumentApp =
    /document|docstudio|report|paper|writer|text|liner|genspark|문서|리포트|논문|글쓰기|라이너|젠스파크/i.test(prompt);
  const appPath = wantsDocumentApp ? "/apps/document-studio" : "/apps";
  const label = locale === "ko" ? "Apps에서 확인하기" : "Open in Apps";
  const note =
    locale === "ko"
      ? "생성된 App은 Agentlas Desktop의 Apps 표면에서 열 수 있습니다."
      : "The generated App can be opened from the Agentlas Desktop Apps surface.";
  return `${text.trim()}\n\n---\n${note}\n\n[${label}](${appPath})`;
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
): Promise<void> {
  // 한 마이크로태스크 양보 — ipc:run 핸들러가 { runId }를 반환하고 렌더러가 이벤트 채널을
  // 구독한 뒤에야 sink가 발화하도록 보장한다. 이게 없으면 동기 early-return(no-chat/no-agent)
  // 에러가 구독 전에 발화돼 렌더러가 종료 이벤트를 놓치고 busy(정지 버튼)가 영구 고착된다.
  await Promise.resolve();
  const locale = pickLocale(req);
  const chat = getChat(req.chatId);
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return;
  }
  let agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return;
  }
  const effectiveUserPrompt = req.appsGenerateMode
    ? buildAppsGenerateUserPrompt(req.userPrompt, locale)
    : req.goalMode
      ? buildGoalUserPrompt(req.userPrompt, locale)
      : req.userPrompt;

  const autoRoute = isGlobalOrchestrator(agent)
    ? selectAutoRoutedAgent(effectiveUserPrompt, listInstalledAgents(), locale)
    : null;
  if (autoRoute) {
    sink({ kind: "tool-use", status: autoRouteStatus(autoRoute, locale) });
    agent = autoRoute.agent;
  }

  const runtimes = await detectRuntimes();
  const active = pickActive(runtimes);
  if (!active) {
    sink({
      kind: "error",
      error: { code: "no-runtime", message: tStatus(locale, "errNoRuntime") },
    });
    return;
  }

  const picked = pickRunner(active);
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
    return;
  }

  // 사용자가 프롬프트 안에 "project folder: /abs/path"처럼 명시하면, 채팅 워킹 폴더로
  // 자동 고정한다. firm 경로도 단일 에이전트 경로와 같은 cwd/MCP 구성을 받아야 한다.
  const existingWorkingFolder = getChatWorkingFolder(chat.id);
  const projectWorkingFolder = chat.projectId ? getProject(chat.projectId)?.folderPath ?? null : null;
  const inferredWorkingFolder =
    existingWorkingFolder || projectWorkingFolder ? null : inferWorkingFolderFromPrompt(effectiveUserPrompt);
  if (inferredWorkingFolder) setChatWorkingFolder(chat.id, inferredWorkingFolder);
  const workingFolder = existingWorkingFolder ?? projectWorkingFolder ?? inferredWorkingFolder;

  // ── MCP 툴 브리지 ──────────────────────────────────────────
  // Claude Code/Codex 러너 + write/full 권한일 때만, 설치·활성 MCP 서버(브라우저 Playwright 포함)를
  // 런타임별 설정으로 직렬화해 넘긴다. read 권한이나 다른 런타임에서는 생략.
  let mcpConfigPath: string | undefined;
  let mcpAllowedTools: string[] | undefined;
  let mcpCodexConfigArgs: string[] | undefined;
  const runtimeCanUseMcp = active.kind === "claude-code" || active.kind === "codex";
  if (runtimeCanUseMcp && (req.permissions === "write" || req.permissions === "full")) {
    try {
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
            picked,
            workingFolder,
            mcpConfigPath,
            mcpAllowedTools,
            mcpCodexConfigArgs,
            locale,
            sink,
            signal,
          });
        } catch (err) {
          // 오케스트레이션 실패 → 무한 스피너 방지: 에러 이벤트 emit
          const msg = err instanceof Error ? err.message : String(err);
          sink({ kind: "error", error: { code: "firm-failed", message: msg } });
        }
        return;
      }
    }
  }

  // 프로젝트 컨텍스트 노트가 있으면 system prompt 뒤에 append
  let systemPrompt = agent.systemPrompt;
  if (autoRoute) {
    systemPrompt = `${autoRouteSystemPreamble(autoRoute, locale)}\n\n${systemPrompt}`;
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
  // 사용자 채팅에서만 자동화 생성 protocol 주입 (백그라운드 automation 실행 세션은 제외 → 재귀 방지)
  if (chat.kind !== "division") systemPrompt = `${systemPrompt}\n\n${AUTOMATION_PROTOCOL}`;

  const history = listChatMessages(chat.id, 80);

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  appendChatMessage(chat.id, "user", req.userPrompt);
  if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);

  sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });

  try {
    const result = await picked.runner(
      {
        systemPrompt,
        history,
        userPrompt: effectiveUserPrompt,
        images: req.images,
        backendLabel: picked.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
        signal,
        permission: req.permissions,
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        // 사용자가 지정한 워킹 폴더(프로젝트)에서 에이전트를 실행 — 빌드/파일 생성이 거기서 일어난다.
        // 활성화(2회 방문) 게이팅과 무관하게, 폴더가 지정돼 있으면 즉시 cwd로 사용한다.
        cwd: workingFolder ?? undefined,
        locale,
      },
      {
        onStatus: (status) => sink({ kind: "tool-use", status }),
        onPartial: (text) => sink({ kind: "partial", text }),
        // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
        onTool: (name, args) => sink({ kind: "tool-use", tool: { name, args } }),
      },
    );

    // 항상-켜진 큐레이터: 답변 끝의 "## Memory Events" 블록을 파싱해 안전·스코프·중복 처리 후
    // 내구 메모리에 기록하고, 사용자에게 보이는 텍스트에서는 그 블록을 제거한다(추가 LLM 호출 없음).
    let displayText = result.text;
    // 에이전트가 "## Automation" 블록을 넣었으면 → 현재 chat의 타깃(firm/agent)으로 자동화 등록 + 블록 제거.
    // (백그라운드 automation 실행 세션은 제외 → 자동화가 자동화를 만드는 재귀 방지)
    if (chat.kind !== "division") {
      try {
        const { automations: autos, cleanedText } = parseAutomations(displayText);
        for (const a of autos) {
          createAutomation({
            name: a.name,
            scheduleHuman: a.schedule,
            targetType: chat.firmId ? "firm" : "agent",
            targetId: chat.firmId ?? chat.agentId,
            promptTemplate: a.prompt,
            createdBy: "agent",
          });
        }
        displayText = cleanedText;
      } catch (err) {
        console.error("[automation] parseAutomations failed:", err);
      }
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

    appendChatMessage(chat.id, "assistant", displayText);
    sink({ kind: "final", text: displayText, tokens: result.tokens });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sink({ kind: "error", error: { code: "runner-failed", message: msg } });
  }
}
