/*
 * 사이언스가 이 앱에게 요구하는 것을 한 벌로 채워 준다.
 *
 * 사이언스는 이제 자기 저장소(agentlas-science)에 산다. 그쪽 코드 7만 줄은 이 파일
 * 하나만 지나서 데스크탑에 닿는다 — 함수 30개 남짓이 전부다.
 *
 * OS 권한이 필요해 사이언스가 가져가지 못한 넷(파일 고르기 창 둘, 논문 PDF 렌더,
 * 서명된 실행기)은 `electron/science-host/` 에 남아 있고 여기서 함께 넘긴다.
 *
 * 부팅 때 한 번 installScienceHost() 를 부르면 그 뒤로는 사이언스가 알아서 쓴다.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { installScienceHost } from "agentlas-science";

import { detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, withCliPath } from "./runtime/exec";
import { resolveManagedNodeRuntime } from "./runtime/managed-node";
import { userDataPath } from "./runtime-paths";
import { currentUiLocale } from "./ui-locale";
import { ensureScienceRuntimeChat, latestDurableAssistantMessage, setChatRuntimeSelection } from "./store/chats";
import { getMeta, setMeta } from "./store/meta";
import { getDb } from "./store/db";
import { evictRuntimeSessionsForChat } from "./store/runtime-sessions";
import { listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered } from "./store/run-events";
import { agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles } from "./agents/files";
import { invocationService } from "./invocation/service";
import { captureScienceInvocationBinding } from "./invocation/workspace-binding";
import { RUNTIME_BACKEND_SET } from "../shared/runtime-backends";
import { RUNTIME_KIND_SET } from "../shared/runtime-kinds";
import { productExtensionSignedPayload } from "../shared/product-extension";
import type { InstalledMcpServer } from "../shared/types";
import { registerPreparedMcpConfig } from "./mcp-tools/prepared-transport";

/*
 * 사이언스 화면 묶음을 검증해 주는 쪽은 확장 설치기다. 사이언스가 그 판정을 되묻기
 * 때문에 서로를 부르는 모양이 되는데, 아래 위임은 **부를 때** 해석되므로 모듈이
 * 실리는 순서에 걸리지 않는다.
 */
import {
  activeScienceExtension,
  resolveExactVerifiedScienceRenderer,
  resolveExactVerifiedScienceRendererExecutor,
  resolveExactVerifiedScienceRendererExecutorBinding,
  resolveVerifiedScienceRenderer,
  resolveVerifiedScienceRendererExecutor,
} from "./extensions/science";

// OS 권한이 필요해 데스크탑에 남은 넷
import { renderManuscriptPdf, resolveTectonic } from "./science-host/render-pdf";
import { persistedWorkbookReadback, readPersistedScienceWorkbook } from "./science-host/workbook-intake-ipc";

let installed = false;

/**
 * Keep the Desktop side of this bridge structural. The pinned Science package
 * predates its exported name, while newer Science builds call this same shape.
 */
interface ScienceMcpPreparedRegistration {
  path: string;
  configKey: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  isCurrent: () => boolean;
}

/**
 * Science's package owns the loopback grant, while Desktop Main owns the
 * prepared-transport admission registry. Keep the bridge here so a renderer
 * or an extension cannot mint a prepared binding by itself.
 */
function registerScienceMcpPreparedConfig(input: ScienceMcpPreparedRegistration): void {
  const server: InstalledMcpServer = {
    id: input.configKey,
    catalogId: input.configKey,
    name: "Agentlas Science",
    nameEn: "Agentlas Science",
    transport: "stdio",
    command: input.command,
    args: [...input.args],
    url: null,
    // Prepared transports do not resolve credentials through the global
    // registry. Their exact values stay in the Main-only WeakMap created by
    // registerPreparedMcpConfig.
    envKeys: [],
    configurationValid: true,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
  registerPreparedMcpConfig({
    path: input.path,
    servers: [{
      configKey: input.configKey,
      server,
      transport: { command: input.command, args: [...input.args], env: { ...input.env } },
      runtimeRoot: null,
    }],
    runtimeEnv: {},
    isCurrent: input.isCurrent,
  });
}

/** 부팅에서 한 번만 부른다. 두 번 불러도 안전하다. */
export function installDesktopScienceHost(): void {
  if (installed) return;
  installed = true;
  installScienceHost({
    // 실행
    spawnCli, killCliTree, probeCliVersion, withCliPath, detachedSpawnOpts,
    resolveManagedNodeRuntime,
    // 저장소
    ensureScienceRuntimeChat, latestDurableAssistantMessage, setChatRuntimeSelection,
    getMeta, setMeta, getDb, evictRuntimeSessionsForChat,
    listPendingScienceRuntimeOutboxEvents, markScienceRuntimeOutboxDelivered,
    // 에이전트 파일
    agentFolderPath, buildEffectiveAgentSystemPrompt, materializeAgentFiles,
    // 모델 호출
    invocationService, captureScienceInvocationBinding,
    // 플랫폼
    userDataPath, currentUiLocale, productExtensionSignedPayload,
    RUNTIME_BACKEND_SET, RUNTIME_KIND_SET,
    registerScienceMcpPreparedConfig,
    // 확장 검증
    activeScienceExtension,
    resolveVerifiedScienceRenderer,
    resolveExactVerifiedScienceRenderer,
    resolveVerifiedScienceRendererExecutor,
    resolveExactVerifiedScienceRendererExecutor,
    resolveExactVerifiedScienceRendererExecutorBinding,
    // OS 권한이 필요한 넷
    isPackagedHost: () => app.isPackaged,
    renderManuscriptPdf, resolveTectonic,
    readPersistedScienceWorkbook, persistedWorkbookReadback,
    /*
     * 내장 플러그인이 어디 있는지. 사이언스가 자기 위치로 추측하던 자리인데, 저장소가
     * 갈리면서 그 추측이 빗나갔다. 이 앱은 답을 알고 있으므로 알려 준다.
     *
     * ★실측(2026-09-10): `dist/electron/plugins`는 과학 플러그인과 무관한
     *   `electron/plugins/*.ts`(에이전트 플러그인 빌더/materialize) 컴파일 산출물이며,
     *   이름만 "plugins"로 같다. 후보 디렉터리 자체의 존재만 보면 이 무관한 폴더가
     *   먼저 걸려 진짜 위치(`agentlas_desktop/plugins/`)를 절대 못 본다 — 그 안엔
     *   science 하위 폴더가 하나도 없어 모든 science 플러그인이
     *   science-plugin-runtime-unavailable 로 죽는다. 반드시 함께 번들되는
     *   science 플러그인 하나(`agentlas-science-statistics`)를 표식으로 그 후보
     *   **안에** 있는지까지 확인한다.
     */
    sciencePluginRoot: () => {
      const packaged = process.resourcesPath
        ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "plugins")
        : null;
      const compiled = path.resolve(__dirname, "plugins");
      const source = path.resolve(__dirname, "..", "..", "plugins");
      for (const candidate of [compiled, source, packaged]) {
        if (candidate && fs.existsSync(path.join(candidate, "agentlas-science-statistics"))) return candidate;
      }
      return null;
    },
    /** 내장 플러그인 매니페스트 핀. 이 앱의 빌드가 만들고 이 앱이 위치를 안다. */
    sciencePublicPluginPinsPath: () => {
      const compiled = path.resolve(__dirname, "public-plugin-manifest-pins.json");
      return fs.existsSync(compiled) ? compiled : null;
    },
    // 런타임 탐색 — 사이언스는 이것을 동적으로만 부른다
    detectRuntimes: async (...args: unknown[]) => (await import("./runtime/detect")).detectRuntimes(...(args as Parameters<typeof import("./runtime/detect")["detectRuntimes"]>)),
    listRuntimeModels: async (...args: unknown[]) => (await import("./runtime/providers")).listRuntimeModels(...(args as Parameters<typeof import("./runtime/providers")["listRuntimeModels"]>)),
  } as never);
}
