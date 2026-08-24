import path from "node:path";
import { app } from "electron";
import { createChat, appendChatMessage } from "../store/chats";
import { getProject } from "../store/projects";
import {
  getAgentAppBySurface,
  recordAgentAppOperation,
  recordScaffoldedApp,
} from "../store/agent-apps";
import {
  getSurfaceAssetPackBySurface,
  recordMaterializedSurfaceAssetPack,
} from "../store/agent-surface-assets";
import { scaffoldServiceApp } from "../app-factory/scaffold";
import { runAppFactoryAutopilot } from "../app-factory/operations";
import { materializeSurfaceAssetPack } from "../surface-assets/materialize";
import { createCommerceAgentTeam } from "../meta-agent/commerce-team";
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceManifest,
  AppFactoryAppRecord,
  AppFactoryAutopilotResult,
  Chat,
  McpInvocationEvent,
  MetaAgentTeamFactoryResult,
  SurfaceAssetPackRecord,
} from "../../shared/types";
import { userDataPath } from "../runtime-paths";

type EventSink = (ev: McpInvocationEvent) => void;

export interface HandsFreeAgentOsResult {
  ran: boolean;
  reason?: string;
  team?: MetaAgentTeamFactoryResult;
  firmChatId?: string;
  app?: AppFactoryAppRecord;
  assetPack?: SurfaceAssetPackRecord;
  autopilot?: AppFactoryAutopilotResult;
  summary: string;
}

export interface HandsFreeAgentOsRequest {
  chat: Chat;
  surfaceId: string;
  manifest: AgentlasSurfaceManifest;
  workingFolder?: string | null;
  sink?: EventSink;
  locale?: "ko" | "en";
}

export function shouldRunHandsFreeAgentOs(manifest: AgentlasSurfaceManifest): boolean {
  if (manifest.kind !== "surface") return false;
  if (!manifest.app) return false;
  if (manifest.layout !== "service-app" && manifest.layout !== "creative-studio") return false;
  if (!findAction(manifest, "operate-app")) return false;
  return manifest.delegation?.autonomy?.mode === "agent-first";
}

export async function runHandsFreeAgentOs(
  input: HandsFreeAgentOsRequest,
): Promise<HandsFreeAgentOsResult> {
  const existing = getAgentAppBySurface(input.chat.id, input.surfaceId);
  if (existing && existing.status === "tool-published") {
    return {
      ran: false,
      reason: "already-operated",
      app: existing,
      summary: `Agentlas OS already operated ${existing.appName} and published it as a reusable tool.`,
    };
  }
  if (!shouldRunHandsFreeAgentOs(input.manifest)) {
    return {
      ran: false,
      reason: "not-agent-first-service-app",
      summary: "Surface is not an agent-first service app.",
    };
  }

  const baseDir = resolveBaseDir(input.chat, input.workingFolder);
  const action = findAction(input.manifest, "operate-app") ?? findAction(input.manifest, "scaffold-app");
  const emit = (status: string) => input.sink?.({ kind: "tool-use", status });

  let team: MetaAgentTeamFactoryResult | undefined;
  let firmChatId: string | undefined;
  let operatorAgentId = input.chat.agentId;
  if (input.manifest.domain === "ecommerce") {
    emit("Agentlas OS is creating a domain agent team");
    team = createCommerceAgentTeam({
      chatId: input.chat.id,
      surfaceId: input.surfaceId,
      manifest: input.manifest,
      baseDir,
    });
    const firmChat = createChat({
      firmId: team.firm.id,
      projectId: input.chat.projectId,
      title: `${team.firm.name} operations`,
      kind: "division",
      // 하위 실행 세션은 자기를 부른 대화의 표면을 물려받는다. 넘기지 않으면
      // createChat 이 조용히 "work" 로 떨어뜨려, One 에서 시작한 일인데 그 세션이
      // 낸 승인 요청을 누르면 Work 로 끌려간다.
      originSurface: input.chat.originSurface === "one" ? "one" : "work",
    });
    firmChatId = firmChat.id;
    operatorAgentId = team.agent.id;
  } else {
    emit("Agentlas OS is assigning the current agent as the app operator");
  }

  let assetPack: SurfaceAssetPackRecord | undefined;
  const assetPackAction = findAction(input.manifest, "materialize-asset-pack");
  if (assetPackAction) {
    const existingPack = getSurfaceAssetPackBySurface(input.chat.id, input.surfaceId);
    if (existingPack) {
      assetPack = existingPack;
    } else {
      emit("Agentlas OS is materializing the reusable asset pack");
      const snapshot = await materializeSurfaceAssetPack(
        {
          chatId: input.chat.id,
          surfaceId: input.surfaceId,
          actionId: assetPackAction.id,
          manifest: input.manifest,
        },
        { baseDir, downloadRemoteAssets: input.manifest.domain === "creative" },
      );
      assetPack = recordMaterializedSurfaceAssetPack({
        chatId: input.chat.id,
        projectId: input.chat.projectId,
        agentId: operatorAgentId,
        surfaceId: input.surfaceId,
        actionId: assetPackAction.id,
        manifest: input.manifest,
        snapshot,
      });
    }
  }

  emit("Agentlas OS is scaffolding a reversible service app");
  const scaffold = await scaffoldServiceApp(
    {
      chatId: input.chat.id,
      surfaceId: input.surfaceId,
      actionId: action?.id ?? "operate-app",
      manifest: input.manifest,
    },
    { baseDir },
  );
  const appRecord = recordScaffoldedApp({
    chatId: input.chat.id,
    projectId: input.chat.projectId,
    agentId: operatorAgentId,
    surfaceId: input.surfaceId,
    actionId: action?.id ?? "operate-app",
    manifest: input.manifest,
    scaffold,
  });

  emit("Agentlas OS is operating the app with local fallbacks and secure gates");
  const autopilot = await runAppFactoryAutopilot({
    rootPath: scaffold.rootPath,
    budgetApproved: true,
    approvedBy: "agentlas-hands-free-os",
    approvalReason:
      "Operate a non-destructive, reversible Agentlas OS app from an agent-first business intent.",
    credentialSource: "agentlas-env-vault",
    captureProviderSessions: false,
    browserMode: "plan-only",
  });
  recordAgentAppOperation(
    appRecord.id,
    "run-autopilot",
    autopilot.status === "operated",
    autopilot,
    autopilot.status === "operated"
      ? "tool-published"
      : autopilot.smoke?.ok === false
        ? "smoke-failed"
        : "operations-ready",
  );

  const operatedApp = getAgentAppBySurface(input.chat.id, input.surfaceId) ?? appRecord;
  const locale = input.locale ?? "en";
  const completed = autopilot.steps.filter((step) => step.status === "completed").length;
  const operatorName = team?.firm.name ?? input.manifest.app?.name ?? input.manifest.title;
  const summary =
    autopilot.status === "operated"
      ? locale === "ko"
        ? `Agentlas OS가 ${operatorName}를 실행했고, ${scaffold.appName} 앱 준비와 ${completed}개 운영 단계를 완료해 재사용 가능한 도구로 게시했습니다.`
        : `Agentlas OS operated ${operatorName}, scaffolded ${scaffold.appName}, completed ${completed} operating step(s), packaged a preview, and published the app as a reusable tool.`
      : locale === "ko"
        ? `Agentlas OS가 ${operatorName}와 ${scaffold.appName}을 준비했고, ${formatWaitingOn(autopilot.waitingOn, locale)} 단계에서 멈췄습니다.`
        : `Agentlas OS prepared ${operatorName} and ${scaffold.appName}, then paused on ${formatWaitingOn(autopilot.waitingOn, locale)}.`;

  appendChatMessage(
    input.chat.id,
    "system",
    [
      "Agentlas OS operated this surface hands-free.",
      team ? `Team: ${team.firm.name}` : `Operator: ${operatorName}`,
      `App: ${scaffold.appName}`,
      assetPack ? `Asset pack: ${assetPack.rootPath}` : null,
      `Status: ${autopilot.status}`,
      `Reusable tool: ${autopilot.appTool?.mcpPath ?? "pending"}`,
      "Secure boundary: passwords, OTPs, raw card data, cookies, and tokens stay outside chat/files/logs; paid checkout waits for explicit approval.",
    ].filter(Boolean).join("\n"),
  );
  emit(summary);

  return {
    ran: true,
    team,
    firmChatId,
    app: operatedApp,
    assetPack,
    autopilot,
    summary,
  };
}

function formatWaitingOn(waitingOn: string[], locale: "ko" | "en"): string {
  const labels = waitingOn.map((item) => waitingOnLabel(item, locale));
  const unique = Array.from(new Set(labels.filter(Boolean)));
  if (unique.length === 0) return locale === "ko" ? "사용자 검토" : "review";
  return unique.join(locale === "ko" ? ", " : ", ");
}

function waitingOnLabel(code: string, locale: "ko" | "en"): string {
  const normalized = code.trim().toLowerCase();
  if (locale === "ko") {
    if (normalized === "secure-provider-input") return "보안 제공자 로그인/승인";
    if (normalized === "credential-vault-input") return "자격 증명 Vault 연결";
    if (normalized === "payment-approval") return "결제 승인";
    return "사용자 검토";
  }
  if (normalized === "secure-provider-input") return "secure provider login/approval";
  if (normalized === "credential-vault-input") return "credential vault connection";
  if (normalized === "payment-approval") return "payment approval";
  return "review";
}

function findAction(
  manifest: AgentlasSurfaceManifest,
  type: AgentlasSurfaceAction["type"],
): AgentlasSurfaceAction | null {
  return manifest.actions?.find((action) => action.type === type) ?? null;
}

function resolveBaseDir(chat: Chat, workingFolder?: string | null): string {
  if (workingFolder) return workingFolder;
  const project = chat.projectId ? getProject(chat.projectId) : null;
  if (project?.folderPath) return project.folderPath;
  try {
    return userDataPath("generated-agent-os");
  } catch {
    return path.join(process.cwd(), ".agentlas", "generated-agent-os");
  }
}
