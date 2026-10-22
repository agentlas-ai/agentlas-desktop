import { copyGeneratedImageIntoWorkspace } from "../multimodal/workspace-image-copy";
import { beginAdapterEffectRun } from "../invocation/adapter-effect-context";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
import { AntigravityEffectCoverage } from "./antigravity-effect-coverage";
import {
  antigravityConversationGone, antigravityConversationHome, antigravityStopReasonCode, antigravityStoreHomes,
  attestAntigravityMetadataSteps, readAntigravityAnswerStopReason,
} from "./antigravity-conversation-metadata";
import { antigravityEffortNeedsHelp, antigravityEffortPlan, probeAntigravityEffortLevels } from "./antigravity-effort";
import { reportModelEffort } from "./model-call-ledger";
import { attendedTurnStartsFresh, unattendedFreshSessionStatus } from "./unattended-session-turns";
import { observeMainMcpEffects, mcpEffectArgumentsDigest, mainMcpExecutionCompletion, type MainMcpEffectReceipt } from "../mcp-tools/effect-receipts";
import { recordMainExecutionProofs } from "../long-run/execution-proof";
// Antigravity CLI (agy) — 감지 + 실호출.
// Google 계정의 Antigravity 구독 런타임만 지원한다.
import path from "node:path";
import { acquireAgyMcpLease } from "./agy-mcp-lease";
import { scheduledRootAgySignal, withAgyDispatchAncestry } from "./scheduled-root-context";
import { preparedMcpBindings, preparedMcpTransport } from "../mcp-tools/prepared-transport";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import fs from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure, RunnerFailureKind } from "./runner";
import type { RuntimeToolKind } from "../../shared/runtime-tool-kind";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "./project-residency";
import { normalEndToolEvidence, settleNormalEnd } from "../../shared/turn-settlement";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { cumulativeSurfaceGateText, childExitReason, ensureChildCloseAfterExit, startCliHeartbeat, startCliSilenceGuard, runtimeSilentTimeoutFailure, cliToolSilenceWindowMs, wrapSystemPrompt, markRefusedBeforeDispatch, preDispatchRefusal, runnerRefusedBeforeDispatch } from "./runner";
import { announceToolDenied } from "./tool-approval";
import {
  acknowledgeStableTurnContext,
  cliHistoryContextTokens,
  dedupeStableTurnContext,
  invalidateStableTurnContext,
  renderConversationContext,
} from "./continuity";
import { agentContextColdBootstrapForRequest, agentContextDeliveryForRequest, agentContextSessionKey } from "./agent-context";
import { waitForRetiredCliExit } from "./retired-cli-exit";
import { tStatus } from "./status-i18n";
import { selectionFor } from "../capabilities/one-capabilities";
import { agyProductHomePath, agySpawnHome, agySpawnsInPersonalHome, withAgyProductHome } from "./antigravity-personal-context";
import { runtimeRequestRefusal } from "../../shared/runtime-capabilities";
import { configuredIdentity, type InstallChannel } from "../install-identity";
import { isAgentlasProductHome, productHomeRefusedOnThisHost } from "./product-home-identity";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, standardAntigravityBinDirs, windowsCliCommandBudget } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import { parseAgyModels, unsupportedDiscovery, type DiscoveryOutcome } from "../../shared/model-discovery";
import { resolveEffectiveContextWindow, UNKNOWN_CONTEXT_WINDOW } from "../../shared/models";
import { settleDiscovery } from "./model-discovery-store";
import { clearRuntimeSession, getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { createHash } from "node:crypto";
import {
  MCP_PROXY_CONTROL_FILE_ENV,
  MCP_PROXY_LAUNCH_ENV,
  MCP_PROXY_SERVER_KEY_ENV,
  MCP_PROXY_SESSION_ENV,
  MCP_PROXY_TARGET_ENV,
} from "../mcp-tools/proxy-channel";
import {
  mcpProxyLaunchResidentKey,
  promoteMcpProxyLaunch,
  revokeMcpProxyResidentKey,
} from "../mcp-tools/proxy-session";
import { BROWSER_CDP_LAUNCHER_BASENAME } from "../mcp-tools/browser-cdp-launcher";
import { observeCliExecutableIdentity } from "./cli-executable-identity";
import { currentUiLocale } from "../ui-locale";
import { userDataPath } from "../runtime-paths";
import { isResidencyExemptAgent, resolveAgentResidencySource } from "./agent-residency";
import { residencyDisabledFor } from "./claude-session";
import {
  antigravityPoolKey,
  antigravitySessionPool,
  antigravityResidentSessionAlive,
  bindAntigravityPersistentMcpScope,
  openAntigravityResidentSession,
  retireSupersededAntigravitySessions,
  writeAntigravityResidentTurn,
  type AntigravityResidentOwner,
  type AntigravityResidentSession,
  type AcpSessionLease,
} from "./antigravity-session";

// Picks the Korean or English human-readable string for the current UI locale.
const L = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

   
                                                     
                                             
                                  
   

const ANTIGRAVITY_KIND = "antigravity";
// `agy models` is a network-backed catalog. A cold 1.1.26 fetch can remain
// silent for more than five seconds before returning a complete list; timing
// it out there leaves a first-time user's picker empty despite a healthy CLI.
export const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 12_000;

export function antigravityCandidatePaths(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...(platform === "win32"
      ? [
          "agy.cmd",
          "agy.exe",
          path.join(home, ".local", "bin", "agy.exe"),
          path.join(home, ".local", "bin", "agy.cmd"),
          ...standardAntigravityBinDirs(env, platform).flatMap((dir) => [path.join(dir, "agy.exe"), path.join(dir, "agy.cmd")]),
        ]
      : []),
    "agy",
    path.join(home, ".local/bin/agy"),
    path.join(home, ".agentlas/npm/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
}

const AGY_CANDIDATES = antigravityCandidatePaths();

export async function firstAvailableAntigravityCandidate(
  paths: string[],
  available: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (const p of paths) {
    if (await available(p)) return p;
  }
  return null;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  return firstAvailableAntigravityCandidate(paths, async (candidate) => {
    if (!path.isAbsolute(candidate)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      return (await probeCliVersion(candidate, 2000)) !== null;
    }
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

export interface AntigravityProbe {
  path: string;
  version: string;
  /** Model ids to offer (last-good ids when discovery failed — see `discovery.stale`). */
  models: string[];
                                                                                                      
  discovery: DiscoveryOutcome;
}

export function isAgyBinaryPath(binary: string | undefined): boolean {
  return /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(String(binary ?? ""));
}

async function probeAgyModels(binary: string): Promise<DiscoveryOutcome> {
  if (!isAgyBinaryPath(binary)) return unsupportedDiscovery("not-agy-binary");
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(binary, ["models"], {
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
    } catch (err) {
      resolve(settleDiscovery("antigravity", { stdout: "", models: [], exitCode: null, source: "cli" }));
      return;
    }
    let settled = false;
    let stdout = "";
    const probeDecoder = new StringDecoder("utf8");
                                                                
    //   gemini-3.7-flash-high\tGemini 3.7 Flash (High)
    // 줄 전체를 식별자로 검사하던 예전 파서는 탭·공백·괄호 때문에 14줄을 전부 버리고
    // 0개를 반환했다 — 예외도 로그도 없이 모델 선택기가 비어 Gemini 3.7이 보이지 않았다.
    // 같은 1.1.x 안에서 형식이 바뀌었으므로 버전 게이트로는 잡을 수 없는 종류의 드리프트다.
    // 파서는 shared/model-discovery.ts(parseAgyModels)로 옮겨 픽스처 테스트가 가능하고,
    // 결과는 DiscoveryOutcome으로 분류된다: stdout이 있는데 0개면 `failed`(수확량 회귀).
    const finish = (input: { timedOut?: boolean; exitCode?: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(settleDiscovery("antigravity", { stdout, models: parseAgyModels(stdout), source: "cli", ...input }));
    };
    const timer = setTimeout(() => {
      killCliTree(child, 250);
      // agy 1.1.x prints the complete catalog but can keep its non-interactive
      // pipe alive. Preserve the validated stdout instead of turning a healthy
      // catalog into an empty engine-setting picker.
      finish({ timedOut: parseAgyModels(stdout).length === 0 });
    }, ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 32_768) stdout = (stdout + probeDecoder.write(chunk)).slice(0, 32_768);
    });
    child.on("error", () => finish({ exitCode: null }));
    child.on("close", (code) => {
      stdout += probeDecoder.end();
      finish({ exitCode: code });
    });
  });
}

  
                                   
  
                                                              
                                                            
                                                                    
                                                      
                         
                                                                   
                                                         
                                   
   
export const ANTIGRAVITY_MODEL_DISCOVERY_FRESH_MS = 10 * 60_000;
export const ANTIGRAVITY_MODEL_DISCOVERY_FAILED_RETRY_MS = 60_000;
let agyModelsCache: { binary: string; at: number; outcome: DiscoveryOutcome } | null = null;
let agyModelsFlight: { binary: string; promise: Promise<DiscoveryOutcome> } | null = null;

/** 런타임 교체·재로그인 등 감지 캐시를 비울 때 — 값은 남기고 다음 탐지에서 뒤에서 새로 본다. */
export function invalidateAntigravityModelDiscovery(): void {
  if (agyModelsCache) agyModelsCache = { ...agyModelsCache, at: 0 };
}

export function cachedAgyModelDiscovery(
  binary: string,
  probe: (binary: string) => Promise<DiscoveryOutcome> = probeAgyModels,
  now: number = Date.now(),
): Promise<DiscoveryOutcome> {
  const refresh = (): Promise<DiscoveryOutcome> => {
    if (agyModelsFlight?.binary === binary) return agyModelsFlight.promise;
    const promise = probe(binary)
      .then((outcome) => {
        agyModelsCache = { binary, at: Date.now(), outcome };
        return outcome;
      })
      .finally(() => { if (agyModelsFlight?.promise === promise) agyModelsFlight = null; });
    agyModelsFlight = { binary, promise };
    return promise;
  };
  const cached = agyModelsCache?.binary === binary ? agyModelsCache : null;
  if (!cached) return refresh();
  const ttl = cached.outcome.status === "ok" ? ANTIGRAVITY_MODEL_DISCOVERY_FRESH_MS : ANTIGRAVITY_MODEL_DISCOVERY_FAILED_RETRY_MS;
  if (now - cached.at >= ttl) void refresh().catch(() => undefined);
  return Promise.resolve(cached.outcome);
}

export async function probeAntigravity(): Promise<AntigravityProbe | null> {
  const found = await firstExisting(AGY_CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  const discovery = await cachedAgyModelDiscovery(found);
  return { path: found, version, models: discovery.models, discovery };
}

async function getBin(opts?: { source?: string }): Promise<string | null> {
  if (opts?.source) {
    return isAgyBinaryPath(opts.source) ? firstExisting([opts.source]) : null;
  }
  return firstExisting(AGY_CANDIDATES);
}

/** Browser-only prompts cannot use the private prompt-file bootstrap. The
 * actual argv byte boundary, selected model capacity, and protected current
 * instructions jointly determine how much historical context can be replayed.
 * An unknown model uses the conservative shared fallback, never a claimed
 * discovered capacity. */
export const AGY_ARGV_PROMPT_LIMIT = 100_000;

export function buildAntigravityPrompt(req: RunnerRequest, maxPromptBytes = AGY_ARGV_PROMPT_LIMIT, sessionRules = ""): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.antigravity.prompt).
  // `sessionRules` (permission-dependent) follows the wrapped system sections instead of leading the whole prompt.
  const sys = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
    undefined,
    undefined,
    undefined,
    req.surfaceGate,
    "antigravity",
    req.sciencePromptProfile,
    req.judgmentOnly === true ? "host-judgment" : undefined,
      undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
  );
  // 새 세션 시드: 턴 컨텍스트는 시스템 섹션 뒤에, 히스토리는 연속성 프레이밍+압축과 함께.
  const turnContext = req.turnContext?.trim();
  const systemSection = `[SYSTEM]\n${sys}${sessionRules.trim() ? `\n\n${sessionRules.trimEnd()}` : ""}${turnContext ? `\n\n${turnContext}` : ""}`;
  const currentSection = `${tStatus(req.locale, "histThisSection")}\n${req.userPrompt}`;
  const compose = (historyBlock?: string): string =>
    [systemSection, "", ...(historyBlock ? [historyBlock, ""] : []), currentSection].join("\n");
  if (!req.browserOnly) {
    return req.history.length === 0
      ? compose()
      : compose(renderConversationContext(req.history, req.locale, cliHistoryContextTokens(ANTIGRAVITY_KIND, req.model)).block);
  }

  // The system/current turn and session rules are never clipped to make room
  // for history. A long current request fails explicitly at the argv boundary.
  const capacity = resolveEffectiveContextWindow("antigravity", req.model, false);
  const modelWindow = capacity.contextWindow ?? UNKNOWN_CONTEXT_WINDOW;
  // Reserve 20% of the model window for output and provider/tool framing. A
  // UTF-8 byte is a conservative text-token upper bound, not an exact tokenizer.
  const effectiveMaxBytes = Math.min(maxPromptBytes, Math.floor(modelWindow * 0.8));
  const protectedBytes = Buffer.byteLength(compose(), "utf8");
  if (!Number.isSafeInteger(maxPromptBytes) || protectedBytes > effectiveMaxBytes) {
    throw new Error(`BROWSER_ONLY_PROMPT_TOO_LARGE: protected prompt requires ${protectedBytes} UTF-8 bytes; effective model/argv budget is ${effectiveMaxBytes}`);
  }
  if (req.history.length === 0) return compose();
  const historyBytes = effectiveMaxBytes - protectedBytes - 2; // two separating newlines
  if (historyBytes <= 0) {
    throw new Error(`BROWSER_ONLY_PROMPT_TOO_LARGE: protected prompt requires ${protectedBytes} UTF-8 bytes; effective model/argv budget is ${effectiveMaxBytes}`);
  }
  // renderConversationContext reserves 40% of its supplied window for the
  // current/system turn. UTF-8 bytes conservatively bound text-token cost.
  let contextWindow = Math.min(modelWindow, Math.floor(historyBytes / 0.6));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const block = renderConversationContext(req.history, req.locale, contextWindow).block;
    const prompt = compose(block);
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes <= effectiveMaxBytes) return prompt;
    const excess = bytes - effectiveMaxBytes;
    contextWindow = Math.max(0, contextWindow - Math.ceil((excess + 256) / 0.6));
  }
  throw new Error(`BROWSER_ONLY_PROMPT_TOO_LARGE: history cannot fit within the ${effectiveMaxBytes}-byte model/argv boundary`);
}

// Kept as a local alias for callers that are not concerned with the prompt's
// transport boundary. Tests and diagnostics use the named export above.
const buildPrompt = buildAntigravityPrompt;

   
                                      
  
                                                                    
                                                                                 
                                                    
                                              
  
                                                       
                                                                                       
                                                                            
  
                                 
                                
                                           
                                                                        
  
                                                                 
                                    
                                               
  
                                                      
                                                                                   
                                                                      
                                                                       
                                       
                                                                 
                                                
                                                          
                                                         
   
export function antigravityPermissionArgs(
  permission?: "read" | "write" | "full",
  browserOnly = false,
  /** The scoped-read browser profile (antigravityBrowserProfile): its project grants are the whole gate. */
  browserScopedRead = false,
): string[] {
  




  if (browserOnly) return browserScopedRead ? ["--sandbox"] : ["--dangerously-skip-permissions", "--sandbox"];
  if (permission === "full") return ["--dangerously-skip-permissions"];
  if (permission === "write") return ["--dangerously-skip-permissions", "--sandbox"];
  return [];
}

const AGY_BROWSER_PROJECT_ID = "agentlas-browser-automation-v1";
const AGY_BROWSER_POLICY_MARKER = "agentlas.desktop.browser-policy.v1";

export interface AntigravityBrowserProjectPolicy {
  projectId: string;
  workspace: string;
  configPath: string;
}

/**
 * Create the Agentlas-owned Antigravity project used by browser-only runs.
 * It is intentionally outside every user project and carries only the canonical
 * Agentlas Browser MCP. The CLI's headless permission gate is opened separately
 * because project allow-rules do not authorize MCP calls in print mode; shell,
 * file, and provider-native browser fallbacks remain outside the serialized
 * server set and are denied by the runtime prompt/rail.
 */
export async function ensureAntigravityBrowserProjectPolicy(
  home = os.homedir(),
  /** The HOME agy is spawned with (agySpawnHome): the project file goes into ITS projects folder, never the person's
   * own one while a product mirror exists (R-101). The workspace stays under the person's HOME. */
  configHome = home,
): Promise<AntigravityBrowserProjectPolicy> {
  const workspace = path.join(home, ".agentlas", "runtime-homes", "antigravity-browser-v1");
  const configDir = path.join(configHome, ".gemini", "config", "projects");
  const configPath = path.join(configDir, `${AGY_BROWSER_PROJECT_ID}.json`);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  if (await fs.stat(configPath).then(() => true, () => false)) {
    try {
      const current = JSON.parse(await fs.readFile(configPath, "utf8")) as { agentlasOwner?: string };
      if (current.agentlasOwner !== AGY_BROWSER_POLICY_MARKER) {
        throw new Error("Antigravity browser policy id is already owned by another project");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already owned")) throw error;
      throw new Error("Existing Antigravity browser policy is unreadable; refusing to overwrite it");
    }
  }

  const policy = {
    id: AGY_BROWSER_PROJECT_ID,
    name: "Agentlas Browser Automation",
    agentlasOwner: AGY_BROWSER_POLICY_MARKER,
    projectResources: {
      resources: [{ folderUri: pathToFileURL(workspace).href }],
    },
    permissionGrants: {
      permissionGrants: {
        allow: ["mcp(agentlas-browser/*)"],
        deny: ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)"],
      },
    },
    settings: {
      fileAccessPolicy: "AGENT_SETTING_POLICY_DENY",
      internetPolicy: "AGENT_SETTING_POLICY_DENY",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_NEVER",
    },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(policy, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, configPath);
  return { projectId: AGY_BROWSER_PROJECT_ID, workspace, configPath };
}

























const AGY_BROWSER_READ_PROJECT_ID = "agentlas-browser-automation-v2";
const AGY_BROWSER_READ_POLICY_MARKER = "agentlas.desktop.browser-read-policy.v2";
                                                                                                   
const AGY_SCOPED_READ_MIN_VERSION = [1, 4, 0] as const;

export type AntigravityBrowserProfile = "scoped-read" | "legacy";

                                                                                                                          
export function antigravityBrowserProfile(version: string | null | undefined, platform: NodeJS.Platform = process.platform): AntigravityBrowserProfile {
  if (platform !== "darwin" && platform !== "linux") return "legacy";
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version?.trim() ?? "");
  if (!match) return "legacy";
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! !== AGY_SCOPED_READ_MIN_VERSION[index]) return parts[index]! > AGY_SCOPED_READ_MIN_VERSION[index]! ? "scoped-read" : "legacy";
  }
  return "scoped-read";
}

                                                                                                                             
function agyResolvedPath(target: string): string {
  let head = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(head), ...rest); }
    catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(target);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** The scoped-read project document (pure; deterministic for one machine so concurrent runs write the same bytes). */
export function antigravityBrowserReadPolicy(input: { realHome: string; spawnHome: string; productHomes: readonly string[] }): Record<string, unknown> {
  const appData = (home: string) => path.join(home, ".gemini", "antigravity-cli");
  const realHome = agyResolvedPath(input.realHome);
  const homes = [...new Set([input.realHome, ...input.productHomes, input.spawnHome].map(agyResolvedPath))];
  const reads = homes.flatMap((home) => [
    `read_file(${path.join(appData(home), "mcp")})`,
    // A product HOME holds Agentlas conversations only; the real HOME's brain is the person's own sessions.
    ...(home === realHome ? [] : [`read_file(${path.join(appData(home), "brain")})`]),
  ]);
  return {
    id: AGY_BROWSER_READ_PROJECT_ID,
    name: "Agentlas Browser Automation (workspace read)",
    agentlasOwner: AGY_BROWSER_READ_POLICY_MARKER,
    permissionGrants: {
      permissionGrants: {
        allow: ["mcp(*)", ...reads],
        deny: ["command(*)", "write_file(*)", "read_url(*)"],
      },
    },
    settings: {
      fileAccessPolicy: "AGENT_SETTING_POLICY_DENY",
      internetPolicy: "AGENT_SETTING_POLICY_DENY",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_NEVER",
    },
  };
}

/**
 * Writes the scoped-read project into the projects folder of the HOME agy is spawned with (a product HOME links it to
 * the person's, the folder the legacy browser project already uses). Rewritten only when its bytes differ; a file of
 * that id owned by anything else is never overwritten.
 */
export function ensureAntigravityBrowserReadProjectPolicy(spawnHome: string, realHome = os.homedir()): { projectId: string; configPath: string } {
  const configDir = path.join(spawnHome, ".gemini", "config", "projects");
  const configPath = path.join(configDir, `${AGY_BROWSER_READ_PROJECT_ID}.json`);
  const text = `${JSON.stringify(antigravityBrowserReadPolicy({ realHome, spawnHome,
    productHomes: [agyProductHomePath(realHome, false), agyProductHomePath(realHome, true)] }), null, 2)}\n`;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let current: string | null = null;
  try { current = readFileSync(configPath, "utf8"); } catch { /* none yet */ }
  if (current !== null) {
    let owner: unknown;
    try { owner = (JSON.parse(current) as { agentlasOwner?: unknown }).agentlasOwner; }
    catch { throw new Error("Existing Antigravity browser read policy is unreadable; refusing to overwrite it"); }
    if (owner !== AGY_BROWSER_READ_POLICY_MARKER) throw new Error("Antigravity browser read policy id is already owned by another project");
  }
  if (current !== text) {
    const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, configPath);
  }
  return { projectId: AGY_BROWSER_READ_PROJECT_ID, configPath };
}

/** Antigravity headless args: one-shot prompt argv or resident stream-json stdin. */
export function buildAntigravitySpawnArgs(
  model: string | undefined,
  prompt = "",
  addDirectories: string[] = [],
  permission?: "read" | "write" | "full",
                                                                
  outputSchema?: Record<string, unknown>,
     
                                                        
                                                     
     
  resumeConversationId?: string,
  /** Browser-only project: a bare id is the legacy profile; `scopedRead` drops the CLI bypass (antigravityPermissionArgs). */
  browserProject?: string | { projectId: string; scopedRead: boolean },
  inputFormat?: "stream-json",
  /** `["--effort", level]` from antigravityEffortPlan, or nothing (a suffixed model id already fixes the level). */
  effortArgs: readonly string[] = [],
): string[] {
  const modelArgs = model && model.trim() ? ["--model", model.trim(), ...effortArgs] : [];
  const browserProjectId = typeof browserProject === "string" ? browserProject : browserProject?.projectId;
  const browserScopedRead = typeof browserProject === "object" && browserProject.scopedRead === true;
  const directoryArgs = [...new Set(addDirectories.filter((value) => value.trim()))]
    .flatMap((value) => ["--add-dir", value]);
    
                                                                           
                                                        
                                                    
     
    
                                                                
                   
     
  return [
    ...modelArgs, ...directoryArgs,
    ...(browserProjectId ? ["--project", browserProjectId] : []),
    ...antigravityPermissionArgs(permission, Boolean(browserProjectId), browserScopedRead),
    "--output-format", "stream-json",
    "--print-timeout", "30m",
    ...(inputFormat ? ["--input-format", inputFormat] : []),
    ...(outputSchema ? ["--json-schema", JSON.stringify(outputSchema)] : []),
    ...(resumeConversationId ? ["--conversation", resumeConversationId] : []),
    ...(inputFormat ? [] : ["--prompt", prompt]),
  ];
}


/** Metadata is only a freshness preflight; Main still owns scope and byte sealing. */
export function freshAgyArtifactPaths(paths: readonly string[], invocationStartedAtMs: number): string[] {
  if (!Number.isFinite(invocationStartedAtMs)) return [];
  return paths.filter((candidate) => {
    if (!path.isAbsolute(candidate) || /[\u0000\r\n]/u.test(candidate)) return false;
    try {
      const stat = lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
        && stat.mtimeMs >= invocationStartedAtMs;
    } catch {
      return false;
    }
  });
}

const AGY_GENERATED_IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;
const AGY_CONVERSATION_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const AGY_GENERATED_IMAGE_MAX_BYTES = 24 * 1_024 * 1_024;

function hasSupportedGeneratedImageSignature(file: string, extension: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const header = Buffer.alloc(12);
    const length = readSync(fd, header, 0, header.length, 0);
    if (extension === ".png") {
      return length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (extension === ".jpg" || extension === ".jpeg") {
      return length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    }
    return extension === ".webp" && length >= 12
      && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP";
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Antigravity's `generate_image` completion currently returns an empty output,
 * while the provider writes one timestamped image into its exact conversation
 * directory. Admit that image only from the structured tool completion: UUID
 * conversation, bounded ImageName, fresh regular file, real directory, and
 * matching image bytes. The staged copy then enters the ordinary Main-owned
 * task/run binding; provider storage never crosses the Mobile bridge directly.
 */
export function stageFreshAgyGeneratedImage(input: {
  conversationId?: string;
  imageName?: string;
  invocationStartedAtMs: number;
  destinationRoot: string;
  home?: string;
  excludedSources?: ReadonlySet<string>;
}): { sourcePath: string; artifactPath: string } | null {
  const conversationId = input.conversationId?.trim() ?? "";
  const imageName = input.imageName?.trim() ?? "";
  if (!AGY_CONVERSATION_ID_RE.test(conversationId)
    || !AGY_GENERATED_IMAGE_NAME_RE.test(imageName)
    || !Number.isFinite(input.invocationStartedAtMs)
    || !path.isAbsolute(input.destinationRoot)) return null;
  try {
    const sourceDir = path.resolve(
      input.home ?? os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
    );
    if (realpathSync(sourceDir) !== sourceDir || lstatSync(sourceDir).isSymbolicLink()) return null;
    const escapedName = imageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const filenameRe = new RegExp(`^${escapedName}_[0-9]{10,17}\\.(?:png|jpe?g|webp)$`, "iu");
    const now = Date.now();
    const candidates = readdirSync(sourceDir)
      .filter((name) => filenameRe.test(name))
      .map((name) => path.join(sourceDir, name))
      .filter((candidate) => !input.excludedSources?.has(candidate))
      .flatMap((candidate) => {
        try {
          const stat = lstatSync(candidate);
          const extension = path.extname(candidate).toLowerCase();
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
            || stat.size > AGY_GENERATED_IMAGE_MAX_BYTES
            || stat.mtimeMs < input.invocationStartedAtMs || stat.mtimeMs > now + 5_000
            || !hasSupportedGeneratedImageSignature(candidate, extension)) return [];
          return [{ candidate, extension, mtimeMs: stat.mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.candidate.localeCompare(b.candidate));
    const selected = candidates[0];
    if (!selected) return null;
    mkdirSync(input.destinationRoot, { recursive: true, mode: 0o700 });
    const destinationRoot = path.resolve(input.destinationRoot);
    if (realpathSync(destinationRoot) !== destinationRoot || lstatSync(destinationRoot).isSymbolicLink()) return null;
    const artifactPath = path.join(destinationRoot, `antigravity-${randomUUID()}${selected.extension}`);
    try {
      copyFileSync(selected.candidate, artifactPath, fsConstants.COPYFILE_EXCL);
      chmodSync(artifactPath, 0o600);
      return { sourcePath: selected.candidate, artifactPath };
    } catch {
      rmSync(artifactPath, { force: true });
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * agy stream-json 한 줄을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * agent_response의 text_delta를 본문으로 누적하고, DONE의 usage를 집계한다.
 */
/**
 * 막힌 도구 한 건. `reason` 이 이 실행을 죽일지 말지를 가른다.
 *
 * - `approval`: 헤드리스에 승인할 사람이 없어 거부됐다. 권한을 올리면 풀린다.
 * - `boundary`: agy 자신의 하드코딩된 보호 경계다. **권한으로는 절대 못 연다.**
 */
export interface AntigravityDenial {
  tool: string;
  detail: string;
  reason: "approval" | "boundary";
}

   
                                                          
  
                                                                               
                                       
  
                                 
                                                  
                                                                                                         
                                                                                                   
                            
                                                           
                                                  
                                                                                      
                                                                                                           
                                                                                                    
                                     
  
                                                                  
                                                                              
                                                       
                                                                
                                                                              
               
  
                                                         
                                                 
   
export function antigravityDenialReason(message: string): AntigravityDenial["reason"] {
  return /\bhardcoded system protection boundary\b/i.test(message) ? "boundary" : "approval";
}

   
                                                      
  
                                                             
                                  
  
                                                           
                                                              
                                                                
                                                        
                                                                                      
                                                   
   
export function antigravityEmptyRunOutcome(input: {
  answered: boolean;
  toolsAllowed: boolean;
  denials: readonly AntigravityDenial[];
  locale?: string;
}): { kind: "refused" | "empty"; message: string } | undefined {
  if (input.answered) return undefined;
  const approval = input.denials.filter((d) => d.reason === "approval");
  const boundary = input.denials.filter((d) => d.reason === "boundary");
  if (approval.length > 0) {
    const names = approval.map((d) => d.tool).join(", ");
    return {
      kind: "refused",
      message: !input.toolsAllowed
        ? `Antigravity cannot use tools under read permission: this CLI has no way to allow read-only tools headlessly, so every call (${names}) is auto-denied and the run returns nothing. Raise the permission to write, or pick another runtime for read-only work.`
        : `Antigravity produced no answer because ${approval.length === 1 ? "a tool call was" : `${approval.length} tool calls were`} auto-denied for missing approval: ${names}. ${approval[0]?.detail ?? ""}`.trim(),
    };
  }
  if (boundary.length > 0) {
    const names = boundary.map((d) => d.tool).join(", ");
    const ko = `Antigravity 가 답을 내지 못했습니다. ${names} 호출이 Antigravity 자체의 보호 경계에 막혔습니다 — 이 경계는 Antigravity 안에 고정되어 있어 권한을 올려도 열리지 않습니다. 승인이 없어서가 아니므로 같은 턴을 다시 시도합니다.`;
    const en = `Antigravity produced no answer: ${names} hit Antigravity's own built-in protection boundary. That boundary is fixed inside Antigravity and raising the permission does not open it. This is not a missing approval, so the same turn is retried.`;
    return { kind: "empty", message: input.locale === "ko" ? ko : en };
  }
  return undefined;
}

/**



 */
const AGY_TOOL_KINDS: Readonly<Record<string, RuntimeToolKind>> = {
  run_command: "execute", send_command_input: "execute",
  write_to_file: "edit", replace_file_content: "edit", multi_replace_file_content: "edit",
  view_file: "read", view_file_outline: "read", view_code_item: "read", list_dir: "read", command_status: "read",
  grep_search: "search", find_by_name: "search", codebase_search: "search",
  read_url_content: "fetch", search_web: "fetch",
};
function agyToolKind(toolName: string): RuntimeToolKind {
  return Object.prototype.hasOwnProperty.call(AGY_TOOL_KINDS, toolName) ? AGY_TOOL_KINDS[toolName] : "other";
}

export function reduceAgyLine(
  line: string,
  state: {
    text: string;
    finalResponse?: string;
    inputTokens: number;
    outputTokens: number;
    usagePairObserved?: boolean;
    /** 승인이 없어 거부된 도구 호출 — 구조 신호로 모은다(문구 판별이 아니다). */
    deniedTools?: AntigravityDenial[];
       
                                                             
                                                                    
                                                         
                                                
       
    conversationId?: string;
       
                                                                                                                      
                                                                                                                 
                                                                               
       
    firstUserInputStepIndex?: number;
    /** step_index of the newest `agent_response` step this run streamed: the answer attempt whose stop reason agy persisted. */
    lastAgentResponseStepIndex?: number;
    /** result 이벤트의 status/error — 표식이지 문구 판별이 아니다. */
    resultStatus?: string;
    resultConversationId?: string;
    resultError?: string;
    resultErrorCode?: string;
    resultRetryAfterHint?: string;
    /**






 */
    schemaBound?: boolean;
    /** JSON of `result.structured_output`: the schema-accepted answer of a `--json-schema` run. */
    structuredOutput?: string;
  },
): {
  delta?: string;
  activity?: string;
  approvalDenied?: AntigravityDenial;
    
                                         
    
                                                                
                                                     
                                                         
                            
     
  tool?: {
    name: string;
    id: string;
    failed: boolean;
                                                                                             
    args?: string;
    /** `tool_info.output` — DONE 스텝에만 온다. */
    result?: string;
    done: boolean;
    /** Exact output argument from a successful, known write operation; never prose. */
    artifactPaths?: string[];
    /** Typed kind from agy's native tool name (shared/runtime-tool-kind.ts); consumers never read `name` for it. */
    kind?: RuntimeToolKind;
  };
} {
  let ev: {
    event?: string;
    conversation_id?: string;
    result?: {
      status?: string;
      response?: string;
      conversation_id?: string;
                                                                   
      denied_actions?: Array<{ action?: string; display_name?: string }>;
         
                                                                  
                                                            
                                                                                                    
                                                                  
                                                
         
      error?: string | {
        message?: unknown;
        code?: unknown;
        error_code?: unknown;
        errorCode?: unknown;
        retry_after?: unknown;
        retryAfter?: unknown;
      };
      /** Optional provider-owned machine fields. Unknown or malformed values are ignored. */
      error_code?: unknown;
      errorCode?: unknown;
      retry_after?: unknown;
      retryAfter?: unknown;
                                                                                                          
      structured_output?: unknown;
    };
    step_update?: {
      conversation_id?: string;
      step_type?: string; text_delta?: string; state?: string;
      tool_name?: string;
      tool_info?: {
        name?: string;
        parameters?: unknown;
        output?: unknown;
        error?: { type?: string; message?: string };
      };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return {}; // 비-JSON 잡음(경고 등)은 본문이 아니다 — 평문 모드로 오인해 섞으면 산출물이 오염된다.
  }
  // 유효한 JSON 이지만 이벤트가 아닌 줄(`null`, 숫자, 배열)은 잡음이다. 이 함수는 stdout data 리스너 안에서 불리므로
  // 여기서 던지면 메인 프로세스의 uncaughtException 이 된다 — 아래 속성 접근 전에 모양부터 거른다.
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return {};
                                                        
  state.conversationId ??=
    ev.conversation_id ?? ev.result?.conversation_id ?? ev.step_update?.conversation_id;
    
                                                 
                                                                    
                                                    
                                                        
                                                        
                                         
     
  if (ev.event === "result" && ev.result) {
    if (typeof ev.result.response === "string") state.finalResponse = ev.result.response;
    // The typed final answer of a `--json-schema` run (see schemaBound); `response` holds every draft of the turn.
    if (state.schemaBound && Object.hasOwn(ev.result, "structured_output") && ev.result.structured_output !== undefined) {
      try { state.structuredOutput = JSON.stringify(ev.result.structured_output); } catch { /* unserializable: no typed answer */ }
    }
    state.resultStatus = typeof ev.result.status === "string" ? ev.result.status : undefined;
    state.resultConversationId = typeof (ev.result.conversation_id ?? ev.conversation_id) === "string"
      ? ev.result.conversation_id ?? ev.conversation_id : undefined;
    const structuredError = ev.result.error && typeof ev.result.error === "object" && !Array.isArray(ev.result.error)
      ? ev.result.error
      : undefined;
    // 런타임이 말한 사유를 그대로 들고 간다 — 이것이 있으면 그것이 곧 실패 표식이다.
    const errorMessage = typeof ev.result.error === "string" ? ev.result.error : structuredError?.message;
    if (typeof errorMessage === "string" && errorMessage.trim()) state.resultError = errorMessage.trim();
    const errorCode = normalizeAntigravityFailureCode(
      ev.result.error_code ?? ev.result.errorCode
      ?? structuredError?.code ?? structuredError?.error_code ?? structuredError?.errorCode,
    );
    const retryAfterHint = normalizeAntigravityRetryAfter(
      ev.result.retry_after ?? ev.result.retryAfter
      ?? structuredError?.retry_after ?? structuredError?.retryAfter,
    );
    if (errorCode) state.resultErrorCode = errorCode;
    if (retryAfterHint) state.resultRetryAfterHint = retryAfterHint;
      
                                                            
      
                                                                         
                                                     
                                                    
                                                     
                                                            
                                                                              
                                                   
                                                 
       
    for (const denied of Array.isArray(ev.result.denied_actions) ? ev.result.denied_actions : []) {
      const tool = String(denied?.display_name || denied?.action || "").trim();
      if (!tool) continue;
      const already = (state.deniedTools ??= []);
      if (already.some((d) => d.tool === tool)) continue;
      already.push({
        tool,
        detail: `Antigravity auto-denied "${tool}" because headless mode has nobody to approve it.`,
                                                                          
        reason: "approval",
      });
    }
    return { activity: "result" };
  }
  // step_update가 아닌 이벤트(init·checkpoint 등)도 프로세스가 살아 진행 중이라는 신호다.
  if (ev.event !== "step_update" || !ev.step_update) {
    return ev.event ? { activity: String(ev.event) } : {};
  }
  const step = ev.step_update;
  if (step.step_type === "user_input" && state.firstUserInputStepIndex === undefined) {
    const index = (step as { step_index?: unknown }).step_index;
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) state.firstUserInputStepIndex = index;
  }
  // A `--json-schema` run submits its answer through agy's built-in `finish` tool (see schemaBound): a rejected
  // submission is a schema retry inside agy, not a tool the run used, so it is neither shown nor counted as an action.
  if (state.schemaBound && step.step_type === "tool" && (step.tool_name || step.tool_info?.name) === "finish") {
    return { activity: "finish" };
  }

    
                                                         
                                                                  
                                                                                
                                                                          
    
                                                  
                                                     
                                           
    
                                                          
                                    
     
  if (step.step_type === "tool" && step.state === "ERROR") {
    const message = step.tool_info?.error?.message ?? "";
    if (/\bdenied permission\b|\bpermission denied\b|\brequires? approval\b/i.test(message)) {
        
                                                          
                                                      
                                                                 
                                                              
         
      const denial: AntigravityDenial = {
        tool: step.tool_name || step.tool_info?.name || "tool",
        detail: message,
        reason: antigravityDenialReason(message),
      };
      (state.deniedTools ??= []).push(denial);
      return { activity: `denied:${denial.tool}`, approvalDenied: denial };
    }
  }

  if (step.step_type === "tool") {
    const name = step.tool_name || step.tool_info?.name || "";
    if (name) {
        
                                                           
                                                           
                                                                                
                                                      
         
      let params = step.tool_info?.parameters;
      let displayName = name;
      let envelope: unknown = params;
      if (name === "call_mcp_tool" && typeof params === "string") {
        try { envelope = JSON.parse(params); } catch { /* Preserve malformed provider data verbatim. */ }
      }
      if (name === "call_mcp_tool" && envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
        const call = envelope as { ServerName?: unknown; ToolName?: unknown; Arguments?: unknown };
        if (typeof call.ServerName === "string" && /^[a-zA-Z0-9_-]+$/u.test(call.ServerName)
          && typeof call.ToolName === "string" && /^[a-zA-Z0-9_-]+$/u.test(call.ToolName)
          && call.Arguments && typeof call.Arguments === "object" && !Array.isArray(call.Arguments)) {
          displayName = `mcp__${call.ServerName}__${call.ToolName}`;
          params = call.Arguments;
        }
      }
      const output = step.tool_info?.output;
      let structuredOutput: unknown = output;
      if (typeof output === "string") {
        try { structuredOutput = JSON.parse(output); } catch { /* Plain MCP result text remains display-only. */ }
      }
      const outputRecord = (name === "call_mcp_tool" || name.startsWith("mcp__"))
        && structuredOutput && typeof structuredOutput === "object" && !Array.isArray(structuredOutput)
        ? structuredOutput as Record<string, unknown> : null;
      const failed = step.state === "ERROR" || step.tool_info?.error != null
        || outputRecord?.isError === true || outputRecord?.is_error === true
        || (outputRecord?.error != null && outputRecord.error !== false);
      const validErrorFlags = !outputRecord || ["isError", "is_error"].every((key) =>
        !(key in outputRecord) || typeof outputRecord[key] === "boolean");
      // A completed screenshot writes its exact filename. Do not promote read,
      // shell, unknown-server, or arbitrary result-link paths into output evidence.
      const filename = params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).filename : undefined;
      const artifactPaths = step.state === "DONE" && !failed && validErrorFlags
        && displayName === "mcp__agentlas-browser__browser_take_screenshot"
        && typeof filename === "string" && path.isAbsolute(filename)
        && !/[\u0000\r\n]/u.test(filename) && /\.(?:png|jpe?g)$/iu.test(filename)
        ? [filename] : [];
      const stringify = (value: unknown): string | undefined => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };
      const stepIndex = (ev.step_update as { step_index?: unknown } | undefined)?.step_index;
      const done = step.state === "DONE" || step.state === "ERROR";
      return {
        activity: `tool:${name}`,
        tool: {
          name: displayName,
          id: `agy-tool:${name}:${typeof stepIndex === "number" ? stepIndex : (step.state ?? "")}`,
          failed,
          args: stringify(params),
          result: done ? (stringify(output) ?? (step.state === "ERROR" ? (step.tool_info?.error?.message ?? "error") : "")) : undefined,
          done,
          ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
          kind: agyToolKind(name),
        },
      };
    }
  }

  if (step.step_type !== "agent_response") {
      
                                                            
                                                           
                                                                
                                           
       
    return { activity: step.step_type || "step" };
  }
  const responseIndex = (step as { step_index?: unknown }).step_index;
  if (typeof responseIndex === "number" && Number.isSafeInteger(responseIndex) && responseIndex >= 0) state.lastAgentResponseStepIndex = responseIndex;
  const delta = typeof step.text_delta === "string" ? step.text_delta : "";
  if (delta) state.text += delta;
  if (step.usage) {
    state.inputTokens = step.usage.input_tokens ?? state.inputTokens;
    state.outputTokens = step.usage.output_tokens ?? state.outputTokens;
    state.usagePairObserved = step.state === "DONE"
      && Number.isSafeInteger(step.usage.input_tokens) && step.usage.input_tokens! >= 0
      && Number.isSafeInteger(step.usage.output_tokens) && step.usage.output_tokens! >= 0
      && step.usage.input_tokens! + step.usage.output_tokens! <= Number.MAX_SAFE_INTEGER;
  }
  return delta ? { delta } : { activity: "agent_response" };
}

export function buildAgyPromptBootstrap(promptFile: string): string {
  return `request: read ${JSON.stringify(promptFile)} fully, follow exactly; never reveal the path.`;
}

function antigravityWindowsBootstrapAllowed(req: RunnerRequest): boolean {
  return (req.permission === "write" || req.permission === "full")
    && !req.browserOnly && !req.untrustedNoTools && !req.restrictedReadBoundary
    && !req.isolatedMcpConfig && !req.ephemeralToolGrant && !req.workforceRuntimeToolGrant
    && !req.simulation;
}

function antigravityWindowsPromptFailure(
  req: RunnerRequest,
  code: "agy_windows_argv_budget_exceeded" | "agy_windows_prompt_bootstrap_not_authorized",
): RunnerFailure {
  return { kind: "refused", source: "marker", runtime: "antigravity", providerCode: code,
    message: req.locale === "ko"
      ? "Antigravity 요청이 Windows 명령 길이 경계를 초과했습니다. 현재 권한과 요청 내용을 유지하며 실행할 수 없어 CLI 프로세스를 시작하지 않았습니다."
      : "The Antigravity CLI process was not started because this request exceeds the Windows command boundary and cannot run with its current content and permissions." };
}


/**
 * agy 의 구조화된 provider code를 실패 종류로 옮긴다 — **순수 함수**.
 * `result.error`는 사용자가 읽을 사유로만 보존하며 분류 근거로 쓰지 않는다.
 */
const AGY_MACHINE_CODE_RE = /^(?:[A-Z][A-Z0-9_.:-]{0,63}|[1-9][0-9]{2})$/u;

/** Preserve only bounded provider-owned codes; never promote an error sentence into a code. */
export function normalizeAntigravityFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value).trim().toUpperCase();
  return AGY_MACHINE_CODE_RE.test(code) ? code : undefined;
}

/** Keep an ISO or compact relative retry hint only when it arrived in its own provider field. */
export function normalizeAntigravityRetryAfter(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 86_400) {
    return `in ${value}s`;
  }
  if (typeof value !== "string") return undefined;
  const hint = value.trim();
  if (!hint || hint.length > 80 || /[\r\n\u0000]/u.test(hint)) return undefined;
  if (/^(?:in\s+)?(?:(?:\d{1,2})h)?(?:(?:\d{1,3})m)?(?:(?:\d{1,5})s)?$/iu.test(hint)
    && /\d/u.test(hint)) {
    return hint.startsWith("in ") ? hint : `in ${hint}`;
  }
  const parsed = Date.parse(hint);
  return Number.isFinite(parsed) && /T/u.test(hint) ? new Date(parsed).toISOString() : undefined;
}

/*
 * agy 1.4+ prints one typed line on stderr for an API-class failure of a turn:
 *   AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): …","status":"RESOURCE_EXHAUSTED","error_code":429,
 *               "code_kind":"http","retryable":true,"error_id":"<uuid>-1"}
 while the result frame on stdout carries only the sentence (`error`, no code field). Observed on agy 1.4.3 (a real quota
 rejection, and HTTP 400/401/403/5xx from a fake model API): an API failure names `status` and `error_code` with
 `code_kind: "http"`; a safety block
 * and every other executor failure are the generic UNKNOWN / gRPC 2, which is why those keep going to the stop-reason
 * store (antigravityStopReasonCode). Only the typed keys are read: `short_error` and the `error` sentence are never
 * classified, and `retryable` is not read (a quota says true as well, so it cannot tell a quota from a brief throttle).
 */
const AGY_ERROR_PREFIX = /^\s*AGY_ERROR:\s*(\{.*\})\s*$/u;
const AGY_ERROR_LINE_MAX = 4_096;
const AGY_ERROR_SCAN_TAIL = 65_536;
const AGY_ERROR_STATUS_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const AGY_ERROR_KIND_RE = /^[a-z][a-z0-9_]{0,15}$/u;

function agyErrorObjects(stderr: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const tail = stderr.length > AGY_ERROR_SCAN_TAIL ? stderr.slice(-AGY_ERROR_SCAN_TAIL) : stderr;
  for (const line of tail.split(/\r?\n/u)) {
    if (line.length > AGY_ERROR_LINE_MAX) continue;
    const match = AGY_ERROR_PREFIX.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch { /* a malformed line is no evidence */ }
  }
  return out;
}

/** How long a resident turn that ended on an error with no machine code waits for the AGY_ERROR line on stderr. */
const AGY_ERROR_STDERR_GRACE_MS = 300;

/** A complete (newline-terminated) AGY_ERROR line is already in the stderr text: nothing more to wait for. */
function completeAgyErrorLineSeen(stderr: string): boolean {
  const tail = stderr.length > AGY_ERROR_SCAN_TAIL ? stderr.slice(-AGY_ERROR_SCAN_TAIL) : stderr;
  return /(?:^|\n)\s*AGY_ERROR:[^\n]*\n/u.test(tail);
}

/**
 * The typed provider code of the turn's AGY_ERROR line, or undefined: no line, a generic UNKNOWN / gRPC-2 line (the safety
 * class: left to the stop-reason store), a malformed line, or several lines that disagree (then the failure stays exactly
 * as it was). The code is the `status` name when it is typed, else the HTTP `error_code` of an `http` line.
 */
export function readAntigravityErrorLine(stderr: string): string | undefined {
  const codes = new Set<string>();
  for (const line of agyErrorObjects(stderr)) {
    const status = typeof line.status === "string" && AGY_ERROR_STATUS_RE.test(line.status) ? line.status : undefined;
    const kind = typeof line.code_kind === "string" && AGY_ERROR_KIND_RE.test(line.code_kind) ? line.code_kind : undefined;
    const http = kind === "http" && typeof line.error_code === "number" && Number.isSafeInteger(line.error_code)
      ? normalizeAntigravityFailureCode(line.error_code) : undefined;
    const typedStatus = status && status !== "UNKNOWN" ? normalizeAntigravityFailureCode(status) : undefined;
    const code = typedStatus ?? http;
    if (code) codes.add(code);
  }
  return codes.size === 1 ? [...codes][0] : undefined;
}

/**
 * One bounded status line of the turn's last AGY_ERROR, keys and typed values only (no sentence, no id), so the next real
 * failure of any code (a 503, a new status) leaves its raw shape in the run record. Nothing free-form is copied, so no
 * token or path can ride along.
 */
export function antigravityErrorStatusLine(stderr: string): string | undefined {
  const line = agyErrorObjects(stderr).at(-1);
  if (!line) return undefined;
  const parts: string[] = [];
  if (typeof line.status === "string" && AGY_ERROR_STATUS_RE.test(line.status)) parts.push(`status=${line.status}`);
  if (typeof line.error_code === "number" && Number.isSafeInteger(line.error_code)) parts.push(`error_code=${line.error_code}`);
  if (typeof line.code_kind === "string" && AGY_ERROR_KIND_RE.test(line.code_kind)) parts.push(`code_kind=${line.code_kind}`);
  if (typeof line.retryable === "boolean") parts.push(`retryable=${line.retryable}`);
  const keys = Object.keys(line).filter((key) => /^[a-z][a-z0-9_]{0,31}$/u.test(key)).slice(0, 12);
  if (keys.length > 0) parts.push(`keys=${keys.join(",")}`);
  return parts.length > 0 ? `[agy-error] ${parts.join(" ")}` : undefined;
}

/** Classify only exact machine codes. A provider error field without one remains refused. */
export function antigravityFailureKind(_error: string, providerCode?: string): RunnerFailureKind {
  switch (normalizeAntigravityFailureCode(providerCode)) {
    case "500":
    case "502":
    case "503":
    case "504":
    case "UNAVAILABLE":
    case "INTERNAL":
      return "unavailable";
    case "429":
    case "RESOURCE_EXHAUSTED":
    case "QUOTA_EXCEEDED":
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
      return "quota";
    case "401":
    case "UNAUTHENTICATED":
    case "AUTHENTICATION_REQUIRED":
    case "INVALID_CREDENTIALS":
      return "auth";
    case "408":
    case "DEADLINE_EXCEEDED":
    case "TIMEOUT":
    case "TIMED_OUT":
      return "timeout";
    case "UNIMPLEMENTED":
    case "UNSUPPORTED_CLIENT":
      return "unsupported";
    default:
      return "refused";
  }
}

/** A terminal ERROR is a failure even when the provider omitted its reason. */
export function antigravityResultFailure(state: {
  resultStatus?: string; resultError?: string; resultErrorCode?: string;
}): { kind: RunnerFailureKind; message: string } | null {
  if (!state.resultError && !state.resultErrorCode && state.resultStatus?.toUpperCase() !== "ERROR") return null;
  // Without a code or explanation, do not infer a permanent refusal or quota.
  return { kind: state.resultError || state.resultErrorCode
    ? antigravityFailureKind(state.resultError ?? "", state.resultErrorCode) : "exit",
  message: state.resultError ?? "Antigravity reported an error status without a reason." };
}

/** Antigravity exit 0 완주의 실패 판별 — 순수 함수(게이트가 픽스처 주입). */
export function antigravityExitFailure(
  stdout: string,
  stderr: string,
  runtime: typeof ANTIGRAVITY_KIND = ANTIGRAVITY_KIND,
): RunnerFailure | undefined {
  const combined = [stdout, stderr].map((value) => value.trim()).filter(Boolean).join("\n");
  if (/\bUNSUPPORTED_CLIENT\b/i.test(combined)) {
    return {
      kind: "unsupported",
      message: combined.slice(0, 400),
      runtime,
      source: "marker",
    };
  }
  const refusal = detectRuntimeRefusal(combined);
  return refusal ? { kind: refusal.kind, message: refusal.message, runtime, source: "heuristic" } : undefined;
}

   
                                                  
  
                                                                  
                                                                      
                                                                 
                                                                  
                                                                 
   
/**
 * 우리가 agy 설정 파일에 넣은 MCP 서버 키 → 지금 그 정확한 transport를 쓰는 실행 수.
 *
 * agy 는 HOME 마다 설정 파일이 하나뿐이라 그 HOME 으로 도는 동시 실행이 같은 파일을 공유한다. 계수 없이
 * 정리하면 먼저 끝난 실행이 아직 도는 실행의 도구를 지운다 — 그래프에서 노드 둘이 병렬로 도는
 * 흔한 경우가 정확히 그 모양이다. 프로세스 안 계수는 동일 프로세스 공유만 담당하고, 별도 lifetime
 * lease가 설치 간 충돌을 막는다. 계수는 **설정 파일마다** 따로다: 제품 HOME(일반·One)과 개인 HOME
 * 폴백은 서로 다른 파일이라, 한 파일의 계수가 다른 파일의 판단(공유·충돌)에 섞이면 안 된다.
 */
interface AgyMcpFileState {
  refcount: Map<string, number>;
  active: Map<string, AgyMcpServerEntry>;
  /** See AgyMcpReplacement. */
  replacements: Map<string, AgyMcpReplacement>;
}
const AGY_MCP_FILE_STATE = new Map<string, AgyMcpFileState>();
function agyMcpFileState(configPath: string): AgyMcpFileState {
  const key = path.resolve(configPath);
  let state = AGY_MCP_FILE_STATE.get(key);
  if (!state) {
    state = { refcount: new Map(), active: new Map(), replacements: new Map() };
    AGY_MCP_FILE_STATE.set(key, state);
  }
  return state;
}
let agyMcpMutationTail: Promise<void> = Promise.resolve();

async function withAgyMcpMutationLock<T>(action: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = agyMcpMutationTail;
  agyMcpMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

/** The agy MCP config of a HOME. Product runs pass the HOME agy is spawned with (agySpawnHome), never the default. */
export function agyMcpConfigPath(home = os.homedir()): string {
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

interface AgyMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** agy 의 URL 형 필드명 — 실물 설정의 lazyweb 항목이 이 모양이다. */
  serverUrl?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface AgyMcpReplacement {
  previous: AgyMcpServerEntry;
  staged: AgyMcpServerEntry;
}

// An agy config can be shared by installed and source Desktop instances (the
// person's HOME fallback). Keep the previous Agentlas-owned browser entry while a
// newer instance is using the canonical key, then restore it when the last local
// reference ends (AgyMcpFileState.replacements).

interface AgyGlobalMcpConfig {
  mcpServers?: Record<string, AgyMcpServerEntry>;
  [key: string]: unknown;
}

// Some fresh vendor installs create an empty file. Treat only blank bytes as
// empty config, and preserve those bytes until the final local binding ends.
const AGY_MCP_BLANK_CONFIGS = new Map<string, { raw: string; mode: number }>();

function parseAgyGlobalMcpConfig(raw: string): AgyGlobalMcpConfig {
  if (!raw.trim()) return { mcpServers: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as AgyGlobalMcpConfig;
  } catch {
    // Never expose config contents or a JSON parser's input excerpt.
    throw new Error("agy_mcp_global_config_unavailable");
  }
}

async function readAgyGlobalMcpConfig(configPath: string): Promise<AgyGlobalMcpConfig> {
  let raw: string;
  try { raw = await fs.readFile(configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw new Error("agy_mcp_global_config_unavailable");
  }
  return parseAgyGlobalMcpConfig(raw);
}

function isAgyMcpEntryEqual(left: AgyMcpServerEntry | undefined, right: AgyMcpServerEntry | undefined): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function requestedAgyMcpEntry(server: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): AgyMcpServerEntry | null {
  return server.command
    ? {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    }
    : server.url
      ? {
        serverUrl: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
      }
      : null;
}

/**
 * Recognise an Agentlas-owned browser proxy left by another Desktop instance.
 *
 * agy has one process-wide mcp_config.json, so a source/dev Desktop otherwise
 * reuses the installed app's approval channel and gets denied by the wrong
 * run. User MCP entries are left untouched: all four proxy markers plus the
 * canonical Agentlas Browser launcher must be present before this returns true.
 */
export type AgyBrowserEntryDisposition = "ignore" | "quarantine" | "reconcile";

   
                                                
  
                                                        
                                                   
                                                
                                                        
                                                   
   
export function agyBrowserEntryDisposition(input: {
  owned: boolean; requested: boolean; heldByThisProcess: boolean;
}): AgyBrowserEntryDisposition {
  if (!input.owned) return "ignore";
  if (input.requested) return "reconcile";
  if (input.heldByThisProcess) return "ignore";
  return "quarantine";
}

   
                        
  
                                                               
                                                           
                                                            
                                                               
                                               
   
export function isAgentlasWrittenMcpEntry(entry: AgyMcpServerEntry): boolean {
  if (isAgentlasOwnedBrowserMcpEntry(entry)) return true;
  return Object.keys(entry.env ?? {}).some(
    (key) => key.startsWith("AGENTLAS_AGY_MCP_") || key.startsWith("AGENTLAS_MCP_PROXY_"),
  );
}

export function isAgentlasOwnedBrowserMcpEntry(
  entry: AgyMcpServerEntry,
): boolean {
  if (
    !entry.command
    || !Array.isArray(entry.args)
    || entry.args.length !== 1
    || path.basename(entry.args[0] ?? "") !== "proxy-child.cjs"
  ) return false;
  const env = entry.env;
  if (
    !env
    || env.ELECTRON_RUN_AS_NODE !== "1"
    || typeof env[MCP_PROXY_CONTROL_FILE_ENV] !== "string"
    || typeof env[MCP_PROXY_SERVER_KEY_ENV] !== "string"
    || typeof env[MCP_PROXY_SESSION_ENV] !== "string"
    || typeof env[MCP_PROXY_TARGET_ENV] !== "string"
  ) return false;
  let target: { command?: unknown; args?: unknown; env?: unknown };
  try {
    target = JSON.parse(env[MCP_PROXY_TARGET_ENV]);
  } catch {
    return false;
  }
  if (!target || typeof target !== "object" || !Array.isArray(target.args)) return false;
  const targetArgs = target.args.filter((arg): arg is string => typeof arg === "string");
  return targetArgs.length === target.args.length
    && targetArgs.some((arg) => path.basename(arg) === BROWSER_CDP_LAUNCHER_BASENAME);
}

/**
 * A previous Desktop process can leave its Agentlas-owned entry in agy's
 * process-wide config after the run itself has settled. In particular, the old
 * keyless Playwright duplicate then keeps an empty-profile Chromium alive even
 * though the next Graph run selected the authenticated Agentlas Browser.
 *
 * Only recognise the exact Agentlas proxy envelope and inspect its value-free
 * launch shape. A user-owned Playwright entry, a server with credentials, or an
 * explicit profile is never classified as ours and is never pruned.
 */
export function isStaleAgentlasPlaywrightProxyEntry(entry: AgyMcpServerEntry): boolean {
  if (!entry.command || path.resolve(entry.command) !== path.resolve(process.execPath)) return false;
  if (!Array.isArray(entry.args) || entry.args.length !== 1 || path.basename(entry.args[0] ?? "") !== "proxy-child.cjs") {
    return false;
  }
  const env = entry.env;
  if (!env || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  if (
    typeof env[MCP_PROXY_CONTROL_FILE_ENV] !== "string" ||
    typeof env[MCP_PROXY_SERVER_KEY_ENV] !== "string" ||
    typeof env[MCP_PROXY_SESSION_ENV] !== "string" ||
    typeof env[MCP_PROXY_TARGET_ENV] !== "string"
  ) return false;

  let target: { command?: unknown; args?: unknown; env?: unknown };
  try {
    target = JSON.parse(env[MCP_PROXY_TARGET_ENV]);
  } catch {
    return false;
  }
  if (typeof target.command !== "string" || !Array.isArray(target.args)) return false;
  let command = path.basename(target.command).toLowerCase();
  let args = target.args.filter((arg): arg is string => typeof arg === "string");
  if (args.length !== target.args.length) return false;
  let targetEnv = target.env;
  // mcp-config runs external stdio servers through the least-privilege child
  // wrapper before the approval proxy. Unwrap only that exact value-free
  // envelope; a non-empty vault mapping means the server has credentials and
  // therefore is not the disposable duplicate handled here.
  if (
    path.resolve(target.command) === path.resolve(process.execPath) &&
    args.length >= 5 &&
    path.basename(args[0] ?? "") === "mcp-child-env-wrapper.cjs"
  ) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(args[2] ?? "");
    } catch {
      return false;
    }
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).length > 0) return false;
    if (!targetEnv || typeof targetEnv !== "object" || Array.isArray(targetEnv)) return false;
    if (Object.keys(targetEnv).some((key) => key !== "ELECTRON_RUN_AS_NODE")) return false;
    if ((targetEnv as Record<string, unknown>).ELECTRON_RUN_AS_NODE !== "1") return false;
    command = path.basename(args[3] ?? "").toLowerCase();
    args = args.slice(4);
    targetEnv = {};
  }
  if (targetEnv && (typeof targetEnv !== "object" || Array.isArray(targetEnv) || Object.keys(targetEnv).length > 0)) return false;
  if (command !== "npx" && command !== "npx.cmd" && command !== "node" && command !== "node.exe") return false;
  if (args.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))) return false;
  const packageToken = /^@playwright\/mcp(?:@[^\s]+)?$/i;
  return command === "npx" || command === "npx.cmd"
    ? args.some((arg) => packageToken.test(arg.trim()))
    : args.some((arg) => /(?:^|[\\/])@playwright[\\/]mcp(?:[\\/]|$)/i.test(arg));
}

/**
 * 이 실행이 승인받은 MCP 서버들을 agy 설정 파일에 **더하고**, 실행이 끝나면 우리가
 * 더한 키만 되돌린다 — grok 러너의 `grok mcp add/remove` 리컨실과 같은 계약이다.
 * 그 파일은 agy 가 실제로 읽는 HOME 의 것이다(R-101): 제품 HOME 미러의 자기 파일이고,
 * 미러가 없을 때만(Windows·로그인 파일 없음·링크 불가·AGENTLAS_AGY_KEEP_HOME=1) 사람의 ~/.gemini 파일이다.
 *
 * 규칙:
 * - 이미 있는 사용자 키는 절대 건드리지 않는다. 단, 다른 Agentlas Desktop 인스턴스가
 *   남긴 **우리 소유의 canonical browser proxy**는 현재 실행의 proxy로 잠시 교체하고,
 *   마지막 실행이 끝나면 원래 항목을 복원한다. source/dev와 설치 앱이 같은 agy 전역
 *   키를 공유하기 때문에 이 예외가 없으면 dev가 production 승인 채널을 재사용한다.
 *   cleanup은 우리가 넣거나 교체한 값이 아직 그대로일 때만 수행한다.
 * - 전역 파일이 깨진 JSON 이면 **덮어쓰지 않는다** — 사용자 설정을 지키는 쪽이
 *   이 실행에 도구를 주는 것보다 우선이고, 그 사실을 상태줄로 말한다(정직한 강등).
 * - 동시 실행은 exact transport entry만 공유한다. 같은 키의 다른 승인 채널은
 *   기존 실행이 끝나기를 제한 시간 동안 기다리고, 계속 바쁘면 spawn 전에 종료한다.
 */
/** AGY does not expand shell-style aliases in MCP env overrides. Keep vault
 * values in the child process environment, never in its shared config file. */
export function inheritAgyMcpSecretAliases(
  env: Record<string, string> | undefined,
  runtimeEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return env;
  const result = { ...env };
  for (const [key, value] of Object.entries(result)) {
    if (!/^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key)) continue;
    if (value !== `\${${key}}` || !runtimeEnv[key] || runtimeEnv[key] === value) {
      throw new Error("agy_mcp_secret_binding_unavailable");
    }
    delete result[key];
  }
  if (result.AGENTLAS_MCP_PROXY_TARGET) {
    const target = JSON.parse(result.AGENTLAS_MCP_PROXY_TARGET);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("agy_mcp_proxy_target_invalid");
    }
    result.AGENTLAS_MCP_PROXY_TARGET = JSON.stringify({ ...target,
      env: inheritAgyMcpSecretAliases(target.env, runtimeEnv) });
  }
  return result;
}

// Unknown/nested callers stay bounded, including the initial foreign lease
// acquisition. Only Main-attested independent scheduled roots may wait until
// caller cancellation/deadline. Never wait holding the mutation lock.
const AGY_MCP_LOCAL_CONTENTION_MS = 30_000;
class AgyMcpLocalContention extends Error {
  constructor() { super("agy_mcp_local_contention"); }
}

function waitForAgyMcpContentionRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function reconcileAgyMcpServers(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
  runtimeEnv: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
  /**
   * The agy config file this run's servers are staged into: the one of the HOME agy is spawned with
   * (agyMcpConfigPath(agySpawnHome(env))) — the product mirror's own file, the person's file only when no mirror exists.
   */
  configPath: string = agyMcpConfigPath(),
): Promise<{ cleanup: () => Promise<void>; assertReady?: () => Promise<void>; failure?: RunnerFailure }> {
  const deadline = new AbortController();
  const scheduledSignal = scheduledRootAgySignal(signal);
  const callerSignal = scheduledSignal ?? signal;
  const attemptSignal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  const timer = scheduledSignal ? undefined : setTimeout(
    () => deadline.abort(new Error("agy_mcp_scope_busy")), AGY_MCP_LOCAL_CONTENTION_MS,
  );
  let nextWaitNotice = 0;
  try {
    for (;;) {
      try {
        return await reconcileAgyMcpServersAttempt(mcpConfigPath, onStatus, runtimeEnv, attemptSignal, configPath);
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (deadline.signal.aborted) throw deadline.signal.reason;
        if (!(error instanceof AgyMcpLocalContention)) throw error;
        if (Date.now() >= nextWaitNotice) {
          nextWaitNotice = Date.now() + 10_000;
          try { onStatus("[agy-mcp-scope] phase=waiting reason=local-contention"); } catch { /* observer only */ }
        }
        await waitForAgyMcpContentionRetry(attemptSignal);
      }
    }
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (!deadline.signal.aborted) throw error;
    return { cleanup: async () => {}, failure: { kind: "unavailable", source: "marker", runtime: "antigravity",
      providerCode: "agy_mcp_scope_busy", message: "Antigravity MCP configuration remained busy for 30 seconds; no model was started." } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reconcileAgyMcpServersAttempt(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
  runtimeEnv: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  configPath: string,
): Promise<{ cleanup: () => Promise<void>; assertReady?: () => Promise<void>; failure?: RunnerFailure }> {
  const noop = { cleanup: async () => {} };
  const fileState = agyMcpFileState(configPath);
  let lease: Awaited<ReturnType<typeof acquireAgyMcpLease>>;
  try { lease = await acquireAgyMcpLease(configPath, { signal,
    onWait: () => onStatus("[agy-mcp-scope] phase=waiting reason=lease-contention"),
  }); }
  catch (error) {
    if (signal?.aborted) throw error;
    return { ...noop, failure: { kind: "refused", source: "marker", runtime: "antigravity",
      providerCode: error instanceof Error && error.message === "agy_mcp_lease_owner_unverified" ? error.message : "agy_mcp_scope_conflict",
      message: "Antigravity MCP configuration ownership could not be verified." } };
  }
  let bound: Awaited<ReturnType<typeof reconcileAgyMcpServersUnderLease>> | undefined;
  try {
    signal?.throwIfAborted();
    const global = await readAgyGlobalMcpConfig(configPath);
    const requested = mcpConfigPath ? JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) : {};
    const browser = global.mcpServers?.["agentlas-browser"];
    if (browser && isAgentlasOwnedBrowserMcpEntry(browser)) {
      const requestedBrowser = requested.mcpServers?.["agentlas-browser"];
      if (requestedBrowser) {
        const previousControl = browser.env?.[MCP_PROXY_CONTROL_FILE_ENV];
        const nextControl = requestedBrowser.env?.[MCP_PROXY_CONTROL_FILE_ENV];
        // A foreign extant channel is not proven stale. Old Desktop versions do
        // not know about this lease, so never overwrite their live/unknown grant.
        if (previousControl !== nextControl && typeof previousControl === "string") {
          const knownLocal = (fileState.refcount.get("agentlas-browser") ?? 0) > 0
            && isAgyMcpEntryEqual(browser, fileState.active.get("agentlas-browser"));
          // Do not classify Main's exact active entry as an unknown foreign
          // owner. The mutation-locked check below re-reads it and either
          // shares the exact requested binding or signals bounded contention.
          if (!knownLocal) {
            try { await fs.stat(previousControl); throw new Error("agy_mcp_foreign_owner_unverified"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        }
      } else if (!mcpConfigPath) {
        // 이 실행은 MCP 설정 자체가 없어 아래 조정 단계가 한 줄도 돌지 않는다 — 격리할
        // 수단이 없으므로, 남의 승인 통로를 물려받지 않도록 예전처럼 여기서 세운다.
        throw new Error("agy_mcp_browser_binding_missing");
      }
      // 설정이 있는데 브라우저만 요청하지 않은 실행은 세우지 않는다. 아래 조정 단계가
      // 그 항목을 이 실행 동안만 격리하고 끝나면 되돌린다. 예전에는 여기서도 거절해서,
      // 브라우저를 한 번 쓴 기계에서는 Science 의 agy 실행이 영영 시작되지 못했다.
    }
    bound = await reconcileAgyMcpServersUnderLease(mcpConfigPath, onStatus, runtimeEnv, lease.generation, signal, configPath);
    if (bound.failure) { await lease.release(); return bound; }
    const stagedConfig = await readAgyGlobalMcpConfig(configPath);
    signal?.throwIfAborted();
    const guardedKeys = Object.keys(stagedConfig.mcpServers ?? {}).filter((key) => stagedConfig.mcpServers?.[key]?.env?.AGENTLAS_AGY_MCP_GENERATION === lease.generation);
    const assertReady = async () => {
      signal?.throwIfAborted();
      await lease.assertOwned();
      const current = await readAgyGlobalMcpConfig(configPath);
      for (const key of guardedKeys) {
        const entry = current.mcpServers?.[key];
        if (!isAgyMcpEntryEqual(entry, stagedConfig.mcpServers?.[key])) {
          throw new Error("agy_mcp_configuration_drift");
        }
      }
      signal?.throwIfAborted();
      onStatus(`[agy-mcp-scope] phase=load generation=${lease.generation}`);
    };
    onStatus(`[agy-mcp-scope] phase=staged generation=${lease.generation}`);
    const admitted = bound;
    return { assertReady, cleanup: async () => { try { await admitted.cleanup(); } finally { await lease.release(); } } };
  } catch (error) {
    try { await bound?.cleanup(); } finally { await lease.release().catch(() => {}); }
    if (signal?.aborted) throw error;
    if (error instanceof AgyMcpLocalContention) throw error;
    const code = error instanceof Error && /^agy_mcp_[a-z_]+$/.test(error.message) ? error.message : "agy_mcp_config_unavailable";
    return { ...noop, failure: { kind: "refused", source: "marker", runtime: "antigravity",
      providerCode: code, message: "Antigravity MCP configuration could not be bound to this authorized run." } };
  }
}

async function reconcileAgyMcpServersUnderLease(
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void,
  runtimeEnv: NodeJS.ProcessEnv,
  generation: string | undefined,
  signal: AbortSignal | undefined,
  globalPath: string,
): Promise<{ cleanup: () => Promise<void>; failure?: RunnerFailure }> {
  const noop = { cleanup: async () => {} };
  // In-process sharing of THIS config file (agyMcpFileState); another file's counts never decide here.
  const { refcount: liveRefcount, active: liveEntries, replacements: liveReplacements } = agyMcpFileState(globalPath);
  if (!mcpConfigPath) return noop;
  let requested: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> };
  try {
    if (runtimeEnv.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
      const rows = preparedMcpBindings(mcpConfigPath);
      if (!rows.some((row) => row.configKey === "agentlas-browser" && row.server.catalogId === "agentlas-browser")) {
        throw new Error("native_browser_mcp_binding_required");
      }
      for (const row of rows) preparedMcpTransport(row, row.server);
    }
    requested = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
    for (const server of Object.values(requested.mcpServers ?? {})) {
      const aliases = Object.keys(server.env ?? {}).filter((key) => /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key)).sort();
      server.env = inheritAgyMcpSecretAliases(server.env, runtimeEnv);
      if (generation) server.env = { ...server.env, AGENTLAS_AGY_MCP_CONFIG: globalPath,
        AGENTLAS_AGY_MCP_GENERATION: generation, AGENTLAS_AGY_MCP_SERVER_KEY: Object.entries(requested.mcpServers ?? {}).find(([, value]) => value === server)?.[0] ?? "" };
      if (aliases.length) {
        // Removing overlays must not make different live grants appear equal
        // to the global-config concurrency guard. Only a digest is persisted.
        server.env = { ...server.env, AGENTLAS_MCP_RUN_BINDING: createHash("sha256")
          .update(JSON.stringify(aliases.map((key) => [key, runtimeEnv[key]]))).digest("hex") };
      }
      if (generation) {
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
          : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
        server.env = { ...server.env, AGENTLAS_AGY_MCP_ENTRY_INTEGRITY: createHash("sha256")
          .update(JSON.stringify(canonical(requestedAgyMcpEntry(server)))).digest("hex") };
      }
    }
  } catch {
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport could not read its authorized run configuration.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_config_unavailable",
      },
    };
  }
  let entries = Object.entries(requested.mcpServers ?? {});
  // 요청한 서버가 하나도 없어도 그냥 나가지 않는다 — 공용 설정에 남은 브라우저 항목을
  // 격리해야 할 수 있다. 정말 할 일이 없으면 아래에서 (added 0 + 변경 없음) 로 빠진다.

  return withAgyMcpMutationLock(async () => {
    signal?.throwIfAborted();
    let parsed: AgyGlobalMcpConfig;
    let blankOriginal: { raw: string; mode: number } | undefined;
    try {
      const raw = await fs.readFile(globalPath, "utf8");
      parsed = parseAgyGlobalMcpConfig(raw);
      if (!raw.trim()) blankOriginal = { raw, mode: (await fs.stat(globalPath)).mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        parsed = { mcpServers: {} };
      } else {
        onStatus("antigravity: existing mcp_config.json is unreadable — run stopped before model execution");
        return {
          cleanup: async () => {},
          failure: {
            kind: "refused",
            message: "Antigravity MCP transport could not safely reconcile its global configuration.",
            runtime: "antigravity",
            source: "marker",
            providerCode: "agy_mcp_global_config_unavailable",
          },
        };
      }
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") parsed.mcpServers = {};

  // An agy process reads one global MCP file. Sharing is safe only when the
  // exact transport entry is already active; a matching key alone can point
  // at another chat's approval proxy. Only positively identified local
  // contention may retry; configuration drift still fails closed.
    const collidedWithUserEntry: string[] = [];
    let localContention = false;
    for (const [key, server] of entries) {
    const live = liveRefcount.get(key);
    const requestedEntry = requestedAgyMcpEntry(server);
    if (live === undefined) {
      // 우리가 지난 실행에 남긴 항목은 '다른 전송 범위'가 아니라 우리 것이다 —
      // 거절하지 말고 아래에서 이번 실행의 항목으로 갈아 끼운다.
      if (isAgentlasWrittenMcpEntry(parsed.mcpServers[key] ?? {})) continue;
      if (!parsed.mcpServers[key] || isAgyMcpEntryEqual(parsed.mcpServers[key], requestedEntry ?? undefined)) continue;
      





      collidedWithUserEntry.push(key);
      continue;
    }
    const activeEntry = liveEntries.get(key);
    if (requestedEntry && isAgyMcpEntryEqual(activeEntry, requestedEntry)
      && isAgyMcpEntryEqual(parsed.mcpServers[key], activeEntry)) continue;
    if (live > 0 && requestedEntry && isAgyMcpEntryEqual(parsed.mcpServers[key], activeEntry)) {
      localContention = true;
      continue;
    }
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport is already in use by a different authorized run.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_scope_conflict",
      },
    };
    }
    // No writes or refcount changes precede this check. Throwing unwinds the
    // mutation lock and this attempt's lease reference before any retry wait.
    if (localContention) throw new AgyMcpLocalContention();
    signal?.throwIfAborted();

  if (collidedWithUserEntry.length) {
    entries = entries.filter(([key]) => !collidedWithUserEntry.includes(key));
    onStatus(`antigravity: ${collidedWithUserEntry.join(", ")} — ${L(
      "사용자가 Antigravity에 직접 등록한 같은 이름의 MCP 항목이 있어 이번 실행에는 Agentlas 쪽 항목을 붙이지 않습니다",
      "the user already registered a same-named MCP entry directly in Antigravity, so this run does not attach the Agentlas entry",
    )}`);
  }

  const writeGlobal = async (value: typeof parsed): Promise<void> => {
    // 임시 파일 + rename — 시작 중인 다른 agy 가 반쯤 쓰인 파일을 읽지 않게 한다.
    const tmp = `${globalPath}.agentlas-${process.pid}-${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    const blank = blankOriginal ?? AGY_MCP_BLANK_CONFIGS.get(globalPath);
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...(blank ? { mode: blank.mode } : {}) });
    if (blank) await fs.chmod(tmp, blank.mode);
    await fs.rename(tmp, globalPath);
  };

  const requestedKeys = new Set(entries.map(([key]) => key));
  const canonicalBrowserRequested = requestedKeys.has("agentlas-browser");
  let globalDirty = false;
  if (canonicalBrowserRequested) {
    for (const [key, server] of Object.entries(parsed.mcpServers)) {
      if (requestedKeys.has(key) || liveRefcount.has(key)) continue;
      if (!isStaleAgentlasPlaywrightProxyEntry(server)) continue;
      delete parsed.mcpServers[key];
      globalDirty = true;
    }
  }

  // 이번 실행이 브라우저를 쓰지 않으면, 남아 있는 Agentlas 소유 항목을 실행 동안만
  // 치워 둔다. 이 프로세스의 다른 실행이 들고 있으면 그 실행의 것이므로 건드리지 않는다.
  const BROWSER_KEY = "agentlas-browser";
  let quarantinedBrowser: AgyMcpServerEntry | undefined;
  if (agyBrowserEntryDisposition({
    owned: Boolean(parsed.mcpServers[BROWSER_KEY])
      && isAgentlasOwnedBrowserMcpEntry(parsed.mcpServers[BROWSER_KEY] ?? {}),
    requested: canonicalBrowserRequested,
    heldByThisProcess: liveRefcount.has(BROWSER_KEY),
  }) === "quarantine") {
    quarantinedBrowser = parsed.mcpServers[BROWSER_KEY];
    delete parsed.mcpServers[BROWSER_KEY];
    globalDirty = true;
    onStatus(L(
      "antigravity: 다른 실행이 남긴 브라우저 도구 설정을 이번 실행 동안만 치워 둡니다",
      "antigravity: setting aside the browser tool config left by another run, for this run only",
    ));
  }

  const added: string[] = [];
  const stagedEntries = new Map<string, AgyMcpServerEntry>();
  const previousRefcounts = new Map<string, number | undefined>();
  const previousActiveEntries = new Map<string, AgyMcpServerEntry | undefined>();
  const previousReplacements = new Map<string, AgyMcpReplacement | undefined>();
  const rememberProcessState = (key: string) => {
    if (previousRefcounts.has(key)) return;
    previousRefcounts.set(key, liveRefcount.get(key));
    previousActiveEntries.set(key, liveEntries.get(key));
    previousReplacements.set(key, liveReplacements.get(key));
  };
  for (const [key, server] of entries) {
    if (parsed.mcpServers[key]) {
      /*
       * ★이미 있는 키 — 두 경우가 섞여 있다.
       *
       * (a) 사용자가 직접 등록한 서버: 우리 것이 아니므로 소유하지 않는다.
       * (b) **동시에 도는 다른 실행이 방금 넣은 서버**: 이걸 그냥 건너뛰면, 먼저 넣은
       *     실행이 끝나면서 지워 버려 이 실행은 도중에 도구를 잃는다. 실행 하나가
       *     끝났다고 다른 실행의 도구가 사라지면 안 된다.
       * (c) 다른 Agentlas Desktop 설치/소스 인스턴스가 남긴 browser proxy: 같은
       *     canonical 키를 써야 하는 agy 특성상 이번 실행의 proxy로 잠시 교체한다.
       *
       * 그래서 우리가 넣은 키는 참조 계수로 센다. 계수가 0이 될 때만 걷어낸다.
       */
      if (
        !liveRefcount.has(key)
        && isAgentlasWrittenMcpEntry(parsed.mcpServers[key])
      ) {
        rememberProcessState(key);
        const staged: AgyMcpServerEntry = {
          command: server.command,
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
          ...(server.url ? { serverUrl: server.url } : {}),
          ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
        };
        const previous = parsed.mcpServers[key];
        parsed.mcpServers[key] = staged;
        liveReplacements.set(key, { previous, staged });
        stagedEntries.set(key, staged);
        added.push(key);
        liveRefcount.set(key, 1);
        liveEntries.set(key, staged);
        globalDirty = true;
        continue;
      }
      const live = liveRefcount.get(key);
      if (live !== undefined) {
        rememberProcessState(key);
        liveRefcount.set(key, live + 1);
        liveEntries.set(key, parsed.mcpServers[key]);
        stagedEntries.set(key, parsed.mcpServers[key]);
        added.push(key);
      }
      continue;
    }
    const staged = requestedAgyMcpEntry(server);
    if (!staged) {
      continue;
    }
    rememberProcessState(key);
    parsed.mcpServers[key] = staged;
    stagedEntries.set(key, staged);
    added.push(key);
    liveRefcount.set(key, (liveRefcount.get(key) ?? 0) + 1);
    liveEntries.set(key, staged);
  }
  if (added.length === 0 && !globalDirty) return noop;
  try {
    await writeGlobal(parsed);
    if (blankOriginal) AGY_MCP_BLANK_CONFIGS.set(globalPath, blankOriginal);
  } catch (error) {
    for (const key of previousRefcounts.keys()) {
      const previousRefcount = previousRefcounts.get(key);
      const previousActive = previousActiveEntries.get(key);
      const previousReplacement = previousReplacements.get(key);
      if (previousRefcount === undefined) liveRefcount.delete(key);
      else liveRefcount.set(key, previousRefcount);
      if (previousActive === undefined) liveEntries.delete(key);
      else liveEntries.set(key, previousActive);
      if (previousReplacement === undefined) liveReplacements.delete(key);
      else liveReplacements.set(key, previousReplacement);
    }
    onStatus(`antigravity: could not stage MCP servers (${error instanceof Error ? error.message : String(error)}) — run stopped before model execution`);
    return {
      cleanup: async () => {},
      failure: {
        kind: "refused",
        message: "Antigravity MCP transport could not stage its authorized run configuration.",
        runtime: "antigravity",
        source: "marker",
        providerCode: "agy_mcp_stage_failed",
      },
    };
  }
  if (added.length === 0) return noop;
  let cleaned = false;
  return {
    cleanup: async () => withAgyMcpMutationLock(async () => {
      if (cleaned) return;
      cleaned = true;
      let current: typeof parsed | null = null;
      try {
        // 실행 중 남이 고쳤을 수 있으니 다시 읽고, 우리가 더한 키만 걷어낸다.
        current = JSON.parse(await fs.readFile(globalPath, "utf8")) as typeof parsed;
        if (!current.mcpServers || typeof current.mcpServers !== "object") current = null;
      } catch (error) {
        console.error("[antigravity] mcp cleanup read failed:", error);
      }
      try {
        let dirty = false;
        for (const key of added) {
          const live = (liveRefcount.get(key) ?? 1) - 1;
          if (live > 0) {
            // 다른 실행이 아직 이 서버를 쓰고 있다 — 계수만 내리고 남겨 둔다.
            liveRefcount.set(key, live);
            continue;
          }
          liveRefcount.delete(key);
          liveEntries.delete(key);
          const staged = stagedEntries.get(key);
          const replacement = liveReplacements.get(key);
          if (!current || !isAgyMcpEntryEqual(current.mcpServers![key], staged)) {
            // Another Desktop instance changed the key after us. Never remove
            // or restore a value that this run can no longer identify.
            if (replacement) liveReplacements.delete(key);
            continue;
          }
          if (replacement) {
            current.mcpServers![key] = replacement.previous;
            liveReplacements.delete(key);
            dirty = true;
          } else if (current.mcpServers![key]) {
            delete current.mcpServers![key];
            dirty = true;
          }
        }
        // 격리해 둔 브라우저 항목은 그 자리가 여전히 비어 있을 때만 되돌린다.
        // 그 사이 다른 실행이 새로 넣었다면 그것이 지금의 주인이다.
        if (quarantinedBrowser && current && !current.mcpServers![BROWSER_KEY]) {
          current.mcpServers![BROWSER_KEY] = quarantinedBrowser;
          dirty = true;
        }
        const blank = AGY_MCP_BLANK_CONFIGS.get(globalPath);
        if (blank && liveRefcount.size === 0) {
          // Restore only when removing our last exact entry leaves no foreign
          // servers or metadata. Drift must never authorize a blank overwrite.
          const empty = current && Object.keys(current).length === 1
            && current.mcpServers && Object.keys(current.mcpServers).length === 0;
          if (dirty && empty) {
            const tmp = `${globalPath}.agentlas-${process.pid}-${randomUUID()}.tmp`;
            await fs.writeFile(tmp, blank.raw, { encoding: "utf8", mode: blank.mode });
            await fs.chmod(tmp, blank.mode);
            await fs.rename(tmp, globalPath);
            dirty = false;
          }
          AGY_MCP_BLANK_CONFIGS.delete(globalPath);
        }
        if (dirty && current) await writeGlobal(current);
      } catch (error) {
        console.error("[antigravity] mcp cleanup failed:", error);
      }
    }),
  };
  });
}

export type AgyPersonalMcpMigration =
  | { status: "disabled" | "done" | "busy" | "unavailable" | "clean" }
  | { status: "migrated"; removed: string[]; backupPath: string };

/**















 */
export async function migrateAgyPersonalMcpConfig(input: { realHome: string; markerDir?: string;
  /** Tests name the channel; production reads the configured install identity (Main and daemon configure it). */
  installChannel?: InstallChannel | null; }): Promise<AgyPersonalMcpMigration> {
  if (process.env.AGENTLAS_AGY_PERSONAL_MCP_MIGRATION === "0") return { status: "disabled" };
  const channel = input.installChannel !== undefined ? input.installChannel : configuredIdentity()?.channel ?? null;
  if (channel !== "official" && channel !== "local-candidate") return { status: "disabled" };
  const configPath = agyMcpConfigPath(input.realHome);
  const markerDir = input.markerDir ?? userDataPath("agy-product-home");
  const marker = path.join(markerDir, `personal-mcp-migration-v1-${createHash("sha256").update(path.resolve(input.realHome)).digest("hex").slice(0, 12)}.json`);
  const markerExists = () => fs.stat(marker).then(() => true, () => false);
  const writeMarker = async (record: Record<string, unknown>) => {
    await fs.mkdir(markerDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(marker, `${JSON.stringify({ schemaVersion: "agentlas.agy-personal-mcp-migration.v1", at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  };
  if (await markerExists()) return { status: "done" };
  try { await fs.access(path.dirname(configPath)); }
  catch { await writeMarker({ status: "clean" }); return { status: "clean" }; }
  let lease: Awaited<ReturnType<typeof acquireAgyMcpLease>>;
  try { lease = await acquireAgyMcpLease(configPath, { signal: AbortSignal.timeout(2_000) }); }
  catch { return { status: "busy" }; }
  try {
    return await withAgyMcpMutationLock(async (): Promise<AgyPersonalMcpMigration> => {
      if (await markerExists()) return { status: "done" };
      if (agyMcpFileState(configPath).refcount.size > 0) return { status: "busy" };
      let raw: string;
      try { raw = await fs.readFile(configPath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "unavailable" };
        await writeMarker({ status: "clean" });
        return { status: "clean" };
      }
      let parsed: AgyGlobalMcpConfig;
      try { parsed = parseAgyGlobalMcpConfig(raw); } catch { return { status: "unavailable" }; }
      const servers = parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : {};
      const removed = Object.keys(servers).filter((key) => isAgentlasWrittenMcpEntry(servers[key] ?? {}));
      if (removed.length === 0) { await writeMarker({ status: "clean" }); return { status: "clean" }; }
      const mode = (await fs.stat(configPath)).mode & 0o777;
      const backupPath = `${configPath}.agentlas-migration-${new Date().toISOString().replace(/[:.]/g, "")}.bak`;
      await fs.writeFile(backupPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const next = { ...parsed, mcpServers: Object.fromEntries(Object.entries(servers).filter(([key]) => !removed.includes(key))) };
      const tmp = `${configPath}.agentlas-${process.pid}-${randomUUID()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode });
      await fs.chmod(tmp, mode);
      await fs.rename(tmp, configPath);
      await writeMarker({ status: "migrated", removed, backup: path.basename(backupPath) });
      console.info(`[agy-mcp-scope] personal-config migration removed=${removed.join(",")} backup=${path.basename(backupPath)}`);
      return { status: "migrated", removed, backupPath };
    });
  } finally {
    await lease.release().catch(() => undefined);
  }
}

/**
 * A persisted Antigravity conversation belongs to the exact selected model
 * and filesystem-observed executable that produced it. This is not a semantic
 * version claim or a substitute for Agentlas-owned cross-model context.
 */
export function antigravitySessionFingerprint(
  req: Pick<RunnerRequest, "chatId" | "sessionFingerprintSeed" | "systemPrompt" | "model" | "unattendedNoAsk">,
  executableFingerprint: string,
): string | null {
  if (!req.chatId) return null;
  return createHash("sha256")
    .update("agy-session-v3\0")
    .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
    // The system `ask:` module is left out for RunnerRequest.unattendedNoAsk (team workers): a thread seeded with it is another conversation.
    .update(!req.sessionFingerprintSeed && req.unattendedNoAsk ? "\0unattended-no-ask" : "")
    .update("\0")
    // A provider conversation is model-owned. Agentlas may bridge a model
    // switch with its durable transcript, but must not pass the old model's
    // native --conversation id to the new resident process.
    .update("\0model\0")
    .update(req.model?.trim() ?? "")
    .update("\0executable\0")
    .update(executableFingerprint)
    .digest("hex");
}

type AntigravityBrowserResidentScope = { key: string; handles: string[] };

/**
 * Browser residency is admitted only for one Main-owned canonical browser
 * binding. The per-turn config may be a new sealed file, but its proxy handle
 * must belong to the stable resident scope before AGY is allowed to reuse its
 * PID. Any extra server, copied handle, or missing resident key downgrades to
 * the existing one-shot path.
 */
function antigravityBrowserResidentScope(configPath: string | undefined): AntigravityBrowserResidentScope | null {
  if (!configPath) return null;
  let bindings: ReturnType<typeof preparedMcpBindings>;
  try { bindings = preparedMcpBindings(configPath); } catch { return null; }
  if (bindings.length !== 1 || bindings[0]?.server.catalogId !== "agentlas-browser") return null;
  const handles: string[] = [];
  for (const binding of bindings) {
    let transport: ReturnType<typeof preparedMcpTransport>;
    try { transport = preparedMcpTransport(binding, binding.server); } catch { return null; }
    const handle = transport.kind === "stdio" ? transport.env[MCP_PROXY_LAUNCH_ENV] : undefined;
    if (typeof handle !== "string" || !/^[a-f0-9-]{36}$/.test(handle)) return null;
    const key = mcpProxyLaunchResidentKey(handle);
    if (!key) return null;
    handles.push(handle);
  }
  const key = mcpProxyLaunchResidentKey(handles[0]!);
  return key ? { key, handles } : null;
}

/**
 * The attempt resumed a stored conversation agy no longer holds: the host found no conversation file before dispatch
 * (`dispatched: false`), or agy reported another conversation id or began the turn at step 0 of an empty conversation
 * and the process was stopped (`dispatched: true`). `replayable` is false when that run had already produced text or a
 * tool step (it may have acted). runPreparedAntigravity re-runs a replayable turn once in a fresh conversation seeded
 * with the conversation it lost.
 */
const AGY_CONVERSATION_LOST = Symbol("agy-conversation-lost");
type AntigravityAttemptResult = RunnerResult & { [AGY_CONVERSATION_LOST]?: { dispatched: boolean; replayable: boolean } };

/** Whether this run already started an agy process or wrote a turn to one (RuntimeTurnDelivery "not-dispatched" otherwise). */
interface AntigravityDispatchState { attempted: boolean }

function antigravityConversationLostFailure(locale: string | undefined): RunnerFailure {
  return { kind: "unavailable", runtime: "antigravity", source: "marker", providerCode: "agy_conversation_lost",
    message: locale === "ko"
      ? "저장된 Antigravity 대화가 더 이상 없습니다. 이전 대화 없이 답한 내용은 결과로 쓰지 않습니다."
      : "The stored Antigravity conversation no longer exists. An answer given without the earlier conversation is not used as a result." };
}

/**








 */
async function runPreparedAntigravity(
  req: RunnerRequest,
  events: RunnerEvents,
  bin: string,
  executableFingerprint: string,
  executableGeneration: string,
  agyAdditionalDirs: string[] = [],
                                                                                                             
  legacyExecutableFingerprint?: string,
  dispatch: AntigravityDispatchState = { attempted: false },
): Promise<RunnerResult> {
  const attempt = (freshReason: "session_not_found" | null) => runPreparedAntigravityAttempt(req, events, bin, executableFingerprint,
    executableGeneration, agyAdditionalDirs, legacyExecutableFingerprint, dispatch, freshReason);
  const first = await attempt(null);
  const lost = first[AGY_CONVERSATION_LOST];
  if (!lost) return first;
  const { [AGY_CONVERSATION_LOST]: _lost, ...refusal } = first;
  if (!lost.replayable) return refusal;
  // A per-chat binding resumes with the chat's history in hand; an agent-context handle needs the journal seed.
  const carried = agentContextDeliveryForRequest(req) === null || (await agentContextColdBootstrapForRequest(req)) !== null;
  if (!attendedTurnStartsFresh("session_not_found", carried)) return refusal;
  events.onStatus(unattendedFreshSessionStatus(ANTIGRAVITY_KIND, "session_not_found"));
  if (req.chatId) {
    const ownerId = req.runtimeSessionOwnerId ?? req.agentId;
    clearRuntimeSession(req.chatId, ANTIGRAVITY_KIND, ownerId, { isolateOwner: req.runtimeSessionOwnerId != null });
  }
  const fresh = await attempt("session_not_found");
  // The lost run reached agy before it was stopped, so the turn as a whole was dispatched.
  if (lost.dispatched && fresh.turnDelivery === "not-dispatched") {
    const { turnDelivery: _delivery, ...dispatched } = fresh;
    return dispatched;
  }
  return fresh;
}

async function runPreparedAntigravityAttempt(
  req: RunnerRequest,
  events: RunnerEvents,
  bin: string,
  executableFingerprint: string,
  executableGeneration: string,
  agyAdditionalDirs: string[],
  legacyExecutableFingerprint: string | undefined,
  dispatch: AntigravityDispatchState,
  /** The stored conversation is gone: start a fresh one even when the record would resume it. */
  freshReason: "session_not_found" | null,
): Promise<AntigravityAttemptResult> {
  // A fresh conversation gets the full prompt; a resumed one (--conversation) gets this turn's input only.
  let runReq = req;
  const runtimeSessionOwnerId = runReq.runtimeSessionOwnerId ?? runReq.agentId;
  const isolateRuntimeSessionOwner = runReq.runtimeSessionOwnerId != null;
  if (!freshReason) events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  /*
   * ★세션 재개 — agy 는 `--conversation <id>` 를 갖고 있었는데 우리가 안 썼다.
   *
   * 그동안 이 러너는 매 턴 시스템 프롬프트 + 전체 히스토리를 다시 보냈다. 대화가
   * 길어질수록 느려지고 컨텍스트 한도에 먼저 부딪히는 이유가 그것이다. 지문이 바뀌면
   * (시스템 프롬프트·모델이 달라지면) 이어가지 않는다 — 다른 계약의 대화를 물려받는
   * 것은 히스토리를 다시 보내는 비용보다 나쁘다.
   */
  const agyFingerprint = antigravitySessionFingerprint(runReq, executableFingerprint);
  // A record an older build saved under the device-number fingerprint (no reboot since) resumes once and is saved again
  // under agyFingerprint when the turn ends.
  const agyLegacyFingerprint = legacyExecutableFingerprint ? antigravitySessionFingerprint(runReq, legacyExecutableFingerprint) : null;
  const agySavedMatches = (saved: string) => saved === agyFingerprint || (agyLegacyFingerprint !== null && saved === agyLegacyFingerprint);
  const agySaved = !assertScienceRecoveryRequest(runReq, "antigravity") && runReq.chatId
    ? getRuntimeSession(runReq.chatId, ANTIGRAVITY_KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  /*
   * Under the common agent-context journal (native-harness NH11) the conversation is the binding's acknowledged native
   * handle, never this runner's own per-chat record: a generation rotated at 80% must not resume the conversation it left.
   * The record still proves the handle was produced by this executable and model (antigravitySessionFingerprint); without
   * that proof the session is cold and is seeded from the journal, the host facts ahead of any summary (NH13).
   */
  const commonContext = agentContextDeliveryForRequest(runReq) !== null;
  const commonHandle = commonContext ? runReq.runtimeSessionId?.trim() || null : null;
  const storedResumeId = commonContext
    ? (commonHandle && agySaved && agyFingerprint && agySavedMatches(agySaved.fingerprint) && agySaved.sessionId === commonHandle ? commonHandle : null)
    : agySaved && agyFingerprint && agySavedMatches(agySaved.fingerprint) ? agySaved.sessionId : null;
  // A conversation agy no longer holds is never resumed again: this attempt starts a fresh one (runPreparedAntigravity).
  const agyResumeId = freshReason ? null : storedResumeId;
  if (freshReason && storedResumeId && runReq.chatId) {
    invalidateStableTurnContext({ chatId: runReq.chatId, runtimeKind: ANTIGRAVITY_KIND, sessionId: storedResumeId });
  }
  if (commonContext && commonHandle && !agyResumeId) {
    const bootstrap = await agentContextColdBootstrapForRequest(runReq);
    if (!bootstrap) {
      return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: freshReason
        ? antigravityConversationLostFailure(runReq.locale)
        : { kind: "unavailable", runtime: "antigravity", source: "marker",
          providerCode: "agy_native_handle_unverified",
          message: runReq.locale === "ko" ? "Antigravity 대화를 이 실행 파일·모델로 이어갈 수 없고, 기록에서 새 대화를 시작할 자료도 없습니다."
            : "The Antigravity conversation cannot continue on this executable and model, and no journal seed is available for a new one." } };
    }
    // The current input is the one this runner already staged; only the earlier conversation comes from the journal.
    runReq = { ...runReq, history: [...bootstrap.history], turnContext: bootstrap.turnContext };
    events.onStatus(`[runtime-session] cold kind=antigravity reason=${freshReason ?? "handle_unverified"}`);
  }
    
                                                                                                                    
                                                                                                                   
                                                                                      
     
  const effortLevels = antigravityEffortNeedsHelp(runReq.model, runReq.effort)
    ? await probeAntigravityEffortLevels(bin, executableGeneration) : null;
  const effortPlan = antigravityEffortPlan(runReq.model, runReq.effort, effortLevels);
  reportModelEffort(effortPlan.application);
  // Blocks the resumed conversation already holds are sent once per conversation (the common stable-block contract).
  const stableContext = agyResumeId ? dedupeStableTurnContext({ chatId: runReq.chatId, runtimeKind: ANTIGRAVITY_KIND, sessionId: agyResumeId,
    contextFingerprint: createHash("sha256").update(JSON.stringify([agyFingerprint, runtimeSessionOwnerId ?? null, runReq.systemPrompt,
      runReq.locale, runReq.permission, runReq.model ?? null])).digest("hex"),
    turnContext: runReq.turnContext, stableBlocks: runReq.turnContextStable }) : null;
  const resumeTurnInput = [(stableContext?.text ?? runReq.turnContext)?.trim(), runReq.userPrompt].filter(Boolean).join("\n\n");
  // A fresh prompt is built below, once the session rules it embeds are known.
  let prompt = agyResumeId ? resumeTurnInput : "";

  /*
   * ★이 실행이 실제로 도구를 쓸 수 있는가 — 권한 플래그와 세션 규칙이 같은 답을 써야 한다.
   * 두 곳이 어긋나면(플래그는 열고 프롬프트는 금지, 또는 그 반대) 모델은 자기가 무엇을
   * 할 수 있는지 모르게 된다. 무도구 격리 실행은 러너 진입에서 이미 거부되므로
   * (untrustedNoTools·restrictedReadBoundary), 여기서는 권한 칩만 보면 된다.
   */
  const agyToolsAllowed = runReq.browserOnly
    || runReq.permission === "write"
    || runReq.permission === "full";
  // agy reads the person's GEMINI.md, skills, plugins, hooks and MCP servers from HOME; a product run gets a mirrored HOME
  // without them (only One gets back what the person switched on). The HOME it returns is also where this run's MCP
  // servers and browser project are written (R-101): the mirror's own files, the person's ~/.gemini only when no mirror
  // exists (Windows, no sign-in file, links refused, AGENTLAS_AGY_KEEP_HOME=1).
  const agyProductEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    try { return withAgyProductHome(env, selectionFor(runReq.agentId, undefined, runReq.chatId)); }
    catch { return env; }
  };
  const agyRunEnv = agyProductEnv({ ...(req.env ?? process.env) });
  const agyRunHome = agySpawnHome(agyRunEnv);
  if (agySpawnsInPersonalHome(agyRunEnv)) {
    // A gate or script (no install identity) on the account's own HOME gets no mirror (product-home-identity.ts), so
    // this run would write the person's ~/.gemini (MCP config, conversations): it is refused before anything is written.
    if (productHomeRefusedOnThisHost(agyRunHome)) {
      return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: { kind: "unavailable",
        runtime: "antigravity", source: "marker", providerCode: "agy_unconfigured_host_personal_home",
        message: "Antigravity would run in the person's own home from a host with no install identity; nothing was started." } };
    }
    if (agyToolsAllowed) events.onStatus("[agy-mcp-scope] target=personal-home reason=product-home-unavailable");
  } else if (agyRunEnv.AGENTLAS_AGY_REAL_HOME && isAgentlasProductHome(agyRunHome)) {
    

    void migrateAgyPersonalMcpConfig({ realHome: agyRunEnv.AGENTLAS_AGY_REAL_HOME }).catch(() => undefined);
  }
    
                                                                                                                  
                                                                                                                       
                                                                                                         
     
  const browserProfile: AntigravityBrowserProfile | null = runReq.browserOnly
    ? antigravityBrowserProfile(await probeCliVersion(bin))
    : null;
  const browserProject: { projectId: string; scopedRead: boolean } | null = browserProfile === "scoped-read"
    ? { projectId: AGY_BROWSER_READ_PROJECT_ID, scopedRead: true }
    : browserProfile === "legacy"
      ? { projectId: (await ensureAntigravityBrowserProjectPolicy(undefined, agyRunHome)).projectId, scopedRead: false }
      : null;
  const ensureBrowserReadPolicy = (env: NodeJS.ProcessEnv): void => {
    if (browserProject?.scopedRead) ensureAntigravityBrowserReadProjectPolicy(env.HOME || os.homedir(), env.AGENTLAS_AGY_REAL_HOME || os.homedir());
  };

  // One-shot agy has no stdin prompt input. Its oversized prompt needs a
  // private file, whereas a resident stream-json process receives the full
  // prompt on stdin. Do not stage a one-shot file before residency admission:
  // that ephemeral directory would make long Goal turns ineligible for reuse.
  let agyPromptDirectory: string | null = null;
  let spawnPrompt = prompt;
    
                                                     
    
                                                            
                                                  
                                                 
                               
     
  /*
   * ★스폰 cwd 와 등록 폴더는 **같은 값**이어야 한다 — 그래서 변수 하나로 둔다.
   *
   * 예전에는 둘이 따로 계산됐고 기본값이 달랐다. cwd 는 `req.cwd ?? agentRunCwd()` 로
   * 폴백했는데 등록 목록은 `req.cwd` 가 없으면 **빈 채로** 남았다. 프로젝트를 고르지
   * 않은 실행(일반 대화가 파일을 만드는 흔한 경우)에서는 `--add-dir` 가 인자에서 통째로
   * 사라졌고, agy 는 등록된 워크스페이스가 없으니 쓰기를 자기 스크래치
   * (~/.gemini/antigravity-cli/scratch)로 돌렸다. 모델은 "만들었다"고 답하고 사용자가
   * 연 폴더는 비어 있다. 실행 중 프로세스의 인자와 cwd 를 직접 떠서 확인했다.
   */
  // A browser-only run works in the same folder as every other run of the step (the room's or the run's folder): it
  // used to run in the legacy profile's private runtime home and could not reach the step's files.
  const agyWorkDir = runReq.cwd ?? agentRunCwd();
  let agyReadDirs = [agyWorkDir, ...agyAdditionalDirs];
    
                                            
    
                                                        
                                                                
                                                                   
                                                         
                                                 
     
    
                                           
    
                                                     
                                                    
                                            
                                                 
    
                                                  
                                           
    
                                                 
                                                       
                                                            
                                                 
                                              
                            
     
  const sessionRules = [
    "Non-interactive session rules:",
    ...(runReq.browserOnly
      ? [
          "- tools: only the Agentlas Browser MCP, pre-approved; use it directly",
          
          ...(browserProject?.scopedRead
            ? ["- files: read-only, this workspace only",
              "- never: run_command, file writes, provider-native browser tools, another Playwright runtime"]
            : ["- never: run_command, file tools, provider-native browser tools, another Playwright runtime"]),
          "- never print or pass cookies, auth headers, session tokens",
          "- report only observed results",
        ]
      : agyToolsAllowed
      ? [
          "- tools: available, pre-approved; do the work for real in workspace files (printed code is not work)",
          "- never run a long-lived process in the foreground (dev server, watcher, `npm run dev`, `vite`, `next dev`, `tail -f`): the session waits for exit and hangs until timeout; start detached (`npm run dev >/tmp/dev.log 2>&1 &`), poll the URL, report it; an already listening server is done",
          "- final text: report of what you changed",
        ]
      : [
        "- tools: cannot be approved here; do not attempt",
        "- no files: your final text IS the deliverable (the next step reads only it); put the COMPLETE contents in it",
      ]),
    "",
  ].join("\n");
  const browserPromptBudget = runReq.browserOnly
    ? Math.min(
        AGY_ARGV_PROMPT_LIMIT,
        Math.floor((resolveEffectiveContextWindow("antigravity", runReq.model, false).contextWindow ?? UNKNOWN_CONTEXT_WINDOW) * 0.8),
      )
    : AGY_ARGV_PROMPT_LIMIT;
  if (!agyResumeId) {
    prompt = runReq.browserOnly ? buildPrompt(runReq, browserPromptBudget, sessionRules) : buildPrompt(runReq, AGY_ARGV_PROMPT_LIMIT, sessionRules);
  }
  // Resume turns carry no system section, so the rules still lead them; a fresh prompt already embeds them.
  spawnPrompt = agyResumeId ? `${sessionRules}\n${prompt}` : prompt;
  const protectedSpawnPrompt = spawnPrompt;
  const spawnPromptBytes = Buffer.byteLength(spawnPrompt, "utf8");
  if (runReq.browserOnly && spawnPromptBytes > browserPromptBudget) {
    throw new Error(
      `BROWSER_ONLY_PROMPT_TOO_LARGE: ${spawnPromptBytes} UTF-8 bytes exceed the ${browserPromptBudget}-byte model/argv boundary`,
    );
  }
  const oneShotSpawnArgs = (): string[] => buildAntigravitySpawnArgs(
    req.model, spawnPrompt, agyReadDirs, agyToolsAllowed ? req.permission : undefined,
    req.outputSchema?.schema, agyResumeId ?? undefined, browserProject ?? undefined, undefined, effortPlan.args,
  );
  const oneShotSpawnEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = agyProductEnv({ ...(req.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" });
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";
    return env;
  };
  const oneShotWindowsBudgetFailure = (): RunnerFailure | null => {
    if (process.platform !== "win32") return null;
    const budget = windowsCliCommandBudget(bin, oneShotSpawnArgs(), { env: oneShotSpawnEnv(), cwd: agyWorkDir });
    return budget && !budget.fits
      ? antigravityWindowsPromptFailure(req, "agy_windows_argv_budget_exceeded") : null;
  };
  const prepareOneShotPrompt = async (): Promise<RunnerFailure | null> => {
    req.signal?.throwIfAborted();
    if (process.platform === "win32") {
      const failure = oneShotWindowsBudgetFailure();
      if (!failure || agyPromptDirectory) return failure;
      if (!antigravityWindowsBootstrapAllowed(req)) {
        return antigravityWindowsPromptFailure(req, "agy_windows_prompt_bootstrap_not_authorized");
      }
    } else if (spawnPromptBytes <= AGY_ARGV_PROMPT_LIMIT || agyPromptDirectory) return null;
    agyPromptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-antigravity-prompt-"));
    try {
      req.signal?.throwIfAborted();
      try {
        await fs.chmod(agyPromptDirectory, 0o700);
      } catch {
        // Windows 등 chmod 미지원 환경
      }
      const agyPromptFile = path.join(agyPromptDirectory, "request.txt");
      req.signal?.throwIfAborted();
      await fs.writeFile(agyPromptFile, process.platform === "win32" ? protectedSpawnPrompt : prompt, { encoding: "utf8", mode: 0o600 });
      req.signal?.throwIfAborted();
      spawnPrompt = process.platform === "win32"
        ? `${sessionRules}\n${buildAgyPromptBootstrap(agyPromptFile)}`
        : buildAgyPromptBootstrap(agyPromptFile);
        
                                      
        
                                                    
                                                   
                                                                    
                                                
        
                                                                            
                                                                               
         
      agyReadDirs = [agyPromptDirectory, agyWorkDir, ...agyAdditionalDirs];
      return oneShotWindowsBudgetFailure();
    } catch (error) {
      await fs.rm(agyPromptDirectory, { recursive: true, force: true });
      throw error;
    }
  };
  const cleanupAgyPrompt = (): void => {
    if (!agyPromptDirectory) return;
    try {
      rmSync(agyPromptDirectory, { recursive: true, force: true });
    } catch {
      // 앱 종료/백신 잠금 등은 다음 OS temp 정리로 폴백한다.
    }
  };

  /*
   * ★MCP 서버 전달 — 승인된 서버를 agy 전역 설정에 리컨실한다(위 reconcileAgyMcpServers).
   * 도구가 닫힌 읽기 실행에는 붙이지 않는다: agy 헤드리스는 권한 플래그 없이 모든 도구
   * 호출을 자동 거부하므로, 서버를 붙여 봐야 "가진 척"만 된다(거짓 표시 금지).
   */
  let mcpReconcile: Awaited<ReturnType<typeof reconcileAgyMcpServers>> = { cleanup: async () => {} };
  let residentProtocolFallback = false;
  try {
    req.signal?.throwIfAborted();
    if (agyToolsAllowed) mcpReconcile = await reconcileAgyMcpServers(req.mcpConfigPath, events.onStatus, req.env ?? process.env, req.signal, agyMcpConfigPath(agyRunHome));
    req.signal?.throwIfAborted();
    if (mcpReconcile.failure) return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: mcpReconcile.failure };
    if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
      if (!req.mcpConfigPath) throw new Error("native_browser_mcp_config_required");
      for (const row of preparedMcpBindings(req.mcpConfigPath)) preparedMcpTransport(row, row.server);
    }
    if ("assertReady" in mcpReconcile) {
      try { await mcpReconcile.assertReady?.(); }
      catch (error) {
        if (req.signal?.aborted) throw error;
        return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: { kind: "refused", source: "marker", runtime: "antigravity",
        providerCode: "agy_mcp_configuration_drift", message: "Antigravity MCP scope changed before model execution." } }; }
    }
    req.signal?.throwIfAborted();
    const browserResidentScope = runReq.browserOnly
      ? antigravityBrowserResidentScope(runReq.mcpConfigPath)
      : null;
    let residentLease: AcpSessionLease<AntigravityResidentSession> | null = null;
    // A journal-backed turn keys its resident process by the journal, as codex, claude-code and the ACP runners do: the
    // conversations of one seat's agent share a journal and so one conversation in agy (session-scope.ts), and two resident
    // processes holding it would each keep a transcript the other's turns never reached. Everything else keys by its conversation.
    const residentSessionKey = commonContext && runReq.agentContext && !runReq.minimalObservation && !runReq.untrustedNoTools
      && !runReq.scienceRecoveryCapability && !runReq.restrictedReadBoundary && !runReq.judgmentOnly
      ? agentContextSessionKey(runReq.agentContext) : undefined;
    const residentBaseOwner: AntigravityResidentOwner = {
      chatId: residentSessionKey ?? runReq.chatId ?? "",
      sessionOwnerId: runtimeSessionOwnerId ?? null,
      isolateOwner: isolateRuntimeSessionOwner,
      generation: executableGeneration,
      model: runReq.model?.trim() || null,
    };
    const residentArgs = buildAntigravitySpawnArgs(
      runReq.model,
      "",
      agyReadDirs,
      agyToolsAllowed ? runReq.permission : undefined,
      runReq.outputSchema?.schema,
      agyResumeId ?? undefined,
      browserProject ?? undefined,
      "stream-json",
      effortPlan.args,
    );
    const residencyEligible = Boolean(
      runReq.chatId
      && agyFingerprint
      && !residencyDisabledFor(ANTIGRAVITY_KIND, runReq.env ?? process.env)
      && !runReq.untrustedNoTools
      && (!runReq.browserOnly || Boolean(browserResidentScope))
      && (!runReq.isolatedMcpConfig || Boolean(browserResidentScope))
      && !runReq.ephemeralToolGrant
      && !runReq.singleUse
      && !runReq.workforceRuntimeToolGrant
      // Attachment staging and a resident process have different workspace
      // authority. Let the existing one-shot path handle those turns.
      && agyAdditionalDirs.length === 0
    );
    if (residencyEligible && runReq.chatId && agyFingerprint) {
      const pool = antigravitySessionPool();
      const key = antigravityPoolKey({
        chatId: residentSessionKey ?? runReq.chatId,
        fingerprint: agyFingerprint,
        sessionOwnerId: runtimeSessionOwnerId ?? null,
        isolateOwner: isolateRuntimeSessionOwner,
        executableGeneration,
        cwd: agyWorkDir,
        bin,
        model: runReq.model?.trim() || null,
        ...(browserResidentScope
          ? { mcpConfigPath: `resident-browser:${browserResidentScope.key}` }
          : runReq.mcpConfigPath ? { mcpConfigPath: runReq.mcpConfigPath } : {}),
        ...(runReq.toolBrokerSettingsPath ? { toolBrokerSettingsPath: runReq.toolBrokerSettingsPath } : {}),
        args: residentArgs,
        env: runReq.env ?? process.env,
      });
      // The full key is part of the owner boundary.  A changed MCP/broker,
      // cwd, environment, or argv scope must retire the previous idle seat;
      // otherwise it can occupy the global 12h budget while never being
      // eligible for this turn again.
      const residentOwner: AntigravityResidentOwner = { ...residentBaseOwner, scopeKey: key };
      await retireSupersededAntigravitySessions(pool, residentOwner);
      if ((commonContext || freshReason) && !agyResumeId) {
        // A cold common-context turn, or a fresh one after a lost conversation, starts a new conversation; an idle
        // process of this key holds an earlier one in memory.
        const stale = pool.retireIdleMatching((session) => session.executableOwner.scopeKey === key);
        if (stale.busy) throw markRefusedBeforeDispatch(Object.assign(new Error("runtime_session_owner_busy"), { code: "runtime_session_owner_busy" }));
        await Promise.all(stale.retired.map((session) => waitForRetiredCliExit(session.child)));
      }
      try {
        residentLease = await pool.acquire(
          key,
          {
            agentId: runReq.agentId ?? null,
            nodeId: runReq.orchestrationAgentId ?? runReq.agentId ?? null,
            chatId: runReq.chatId ?? null,
            ...(residentSessionKey ? { sessionScopeKey: residentSessionKey } : {}),
            projectId: runReq.workProjectId ?? null,
            runtimeKind: ANTIGRAVITY_KIND,
            source: resolveAgentResidencySource(runReq.agentId),
            reaperExempt: isResidencyExemptAgent(runReq.agentId),
          },
          async () => {
            const residentEnv = agyProductEnv({ ...(runReq.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: "true" });
            ensureBrowserReadPolicy(residentEnv);
            return openAntigravityResidentSession({
            executableOwner: residentOwner,
            bin,
            args: residentArgs,
            cwd: agyWorkDir,
            env: residentEnv,
            onPersistentMcpScopeClose: (key, owner) => { revokeMcpProxyResidentKey(key, owner); },
            });
          },
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) {
          throw error;
        }
        // An unavailable stream-input protocol is a capability downgrade, not
        // a reason to fail a valid one-shot run.
        events.onStatus("[residency] disabled kind=" + ANTIGRAVITY_KIND + " reason=spawn-failed");
        console.warn("[residency] antigravity degraded to one-shot:", error instanceof Error ? error.message : String(error));
        residentLease = null;
      }
    }
    try {
      if (!residentLease) {
        const failure = await prepareOneShotPrompt();
        if (failure) return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure };
      }
      req.signal?.throwIfAborted();
      const result = await runAgyProcess(residentLease);
      const conversationLost = Boolean(result[AGY_CONVERSATION_LOST]);
      let browserResidentPromoted = false;
      if (residentLease && browserResidentScope && !result.failure && !residentProtocolFallback) {
        try {
          for (const handle of browserResidentScope.handles) {
            const owner = promoteMcpProxyLaunch(handle);
            bindAntigravityPersistentMcpScope(residentLease.session, owner.key, owner.owner);
          }
          browserResidentPromoted = true;
        } catch (error) {
          // A browser scope that cannot be promoted must not leave a live AGY
          // process attached to a one-shot proxy. Discarding below is the safe
          // downgrade; the completed turn itself remains a valid result.
          console.warn("[residency] browser MCP promotion refused:", error instanceof Error ? error.message : String(error));
        }
      }
      if (residentLease) {
        // A completed provider result keeps a live resident reusable. Abort or
        // a dead process is discarded by the pool's alive check, so no broken
        // or per-run authority crosses the next turn. The close reason is the
        // typed lifecycle fact (acp-session-pool.ts discard): a Stop is a
        // shutdown, a healthy process whose browser scope stays one-shot is
        // turn-complete, and only a process bound to a conversation agy no
        // longer holds is an error.
        if (req.signal?.aborted) antigravitySessionPool().discard(residentLease, "shutdown");
        else if (conversationLost) antigravitySessionPool().discard(residentLease, "error");
        else if (browserResidentScope && !browserResidentPromoted) antigravitySessionPool().discard(residentLease, "turn-complete");
        else antigravitySessionPool().release(residentLease);
        residentLease = null;
      }
      if (residentProtocolFallback) {
        // The resident process died or rejected the write before emitting any
        // text/tool activity. Its effect scope is already closed above, so a
        // one-shot retry cannot duplicate an accepted provider action.
        residentProtocolFallback = false;
        const failure = await prepareOneShotPrompt();
        // "not-dispatched" only when the resident never accepted the turn's write; otherwise the delivery is unknown.
        if (failure) return { text: "", ownerControlTerminal: "uncertain", ...(dispatch.attempted ? {} : { turnDelivery: "not-dispatched" as const }), failure };
        req.signal?.throwIfAborted();
        return await runAgyProcess(null);
      }
      return result;
    } catch (error) {
      if (residentLease) {
        antigravitySessionPool().discard(residentLease, req.signal?.aborted ? "shutdown" : "error");
        residentLease = null;
      }
      throw error;
    }
  } finally {
    try { await mcpReconcile.cleanup(); } finally { cleanupAgyPrompt(); }
  }

  function runAgyProcess(
    residentLease: AcpSessionLease<AntigravityResidentSession> | null = null,
  ): Promise<AntigravityAttemptResult> {
  const residentSession = residentLease?.session ?? null;
  req.signal?.throwIfAborted();
  /** Nothing of this run reached agy yet: a refusal here is RuntimeTurnDelivery "not-dispatched" (runner.ts). */
  const notDispatched = (): { turnDelivery?: "not-dispatched" } => (dispatch.attempted ? {} : { turnDelivery: "not-dispatched" });
  if (!residentSession) {
    const failure = oneShotWindowsBudgetFailure();
    if (failure) return Promise.resolve({ text: "", ownerControlTerminal: "uncertain", ...notDispatched(), failure });
  }
  // Antigravity는 빈 prompt를 거부하므로 긴 요청만 private 파일 bootstrap으로 우회한다.
  const env = oneShotSpawnEnv();
  // A resident already found its project when it started; a one-shot reads it now.
  if (!residentSession) ensureBrowserReadPolicy(env);
  /*
   * A process started with `--conversation <id>` for this turn (one-shot, or a resident opened for it) resumes the
   * stored conversation. A resident reused from an earlier turn of this key holds its conversation in memory instead.
   */
  const resumesStoredConversation = Boolean(agyResumeId) && (!residentSession || residentLease?.fresh === true);
  if (resumesStoredConversation && antigravityConversationGone(antigravityConversationHome(env), agyResumeId!)) {
    events.onStatus("[runtime-session] resume_failed kind=antigravity reason=session_not_found source=store");
    return Promise.resolve({ text: "", ownerControlTerminal: "uncertain", ...notDispatched(),
      failure: antigravityConversationLostFailure(runReq.locale), [AGY_CONVERSATION_LOST]: { dispatched: dispatch.attempted, replayable: true } });
  }
  const effectBindings = runReq.mcpConfigPath ? preparedMcpBindings(runReq.mcpConfigPath) : [];
  const effectRun = beginAdapterEffectRun({ adapterKind: "antigravity", chatId: runReq.chatId, agentId: runReq.agentId });
  const hostEffects = new Map<string, MainMcpEffectReceipt>(), claimedEffects = new Set<string>();
  const executionClaims: Array<{operationId: string; outputDigest: string | null; receipt: MainMcpEffectReceipt}> = [];
  let hostReceiptOverflow = false;
  const detachEffects = observeMainMcpEffects(effectBindings, receipt => {
    if (hostEffects.size >= 4096 && !hostEffects.has(receipt.id)) { hostReceiptOverflow = true; return; }
    hostEffects.set(receipt.id, receipt);
  });
  const effectCoverage = new AntigravityEffectCoverage(effectRun?.scopeId ?? randomUUID(), (server, tool, args, failed, operationId, outputDigest) => {
    const digest = mcpEffectArgumentsDigest(args);
    // Reconcile the complete closed multiset, not arrival-order/FIFO: concurrent
    // identical requests may finish in reverse order. Any unmatched/pending
    // host request still makes the whole scope incomplete below.
    const candidates = [...hostEffects.values()].filter(row => !claimedEffects.has(row.id) && row.server === server && row.tool === tool && row.argumentsDigest === digest && row.failed === failed);
    const exact = candidates.find(row => outputDigest && mainMcpExecutionCompletion(row, effectBindings)?.outputDigests.includes(outputDigest));
    const receipt = exact ?? candidates[0];
    if (receipt) claimedEffects.add(receipt.id);
    if (exact) executionClaims.push({operationId,outputDigest,receipt:exact});
    return receipt;
  }, () => hostEffects.size - claimedEffects.size + Number(hostReceiptOverflow), attestAntigravityMetadataSteps,
  { structuredAnswerChannel: Boolean(runReq.outputSchema) });
  let effectExitCode: number | null = null, effectStdoutEnded = false;
  return new Promise<AntigravityAttemptResult>((resolve, reject) => {
    const invocationStartedAtMs = Date.now();
    /** Whether an earlier attempt of this run (a dead resident) already reached agy. */
    const dispatchedBefore = dispatch.attempted;

    let child: ReturnType<typeof spawnCli>;
    if (residentSession) {
      child = residentSession.child;
    } else {
      try {
        req.signal?.throwIfAborted();
        const failure = oneShotWindowsBudgetFailure();
        if (failure) { resolve({ text: "", ownerControlTerminal: "uncertain", ...notDispatched(), failure }); return; }
        child = spawnCli(
          bin,
          oneShotSpawnArgs(),
          {
            stdio: ["ignore", "pipe", "pipe"],
            env,
            // 등록 폴더와 반드시 같은 값 — 위 agyWorkDir 주석 참고.
            cwd: agyWorkDir,
            ...detachedSpawnOpts(),
          },
        );
      } catch (error) {
        cleanupAgyPrompt();
        if (residentLease) antigravitySessionPool().discard(residentLease, "error");
        // spawn itself threw: no process exists, so nothing of this attempt reached agy.
        const thrown = error instanceof Error ? error : new Error(String(error));
        reject(dispatchedBefore || req.signal?.aborted ? thrown : preDispatchRefusal(thrown, "antigravity-spawn", "agy_spawn_failed"));
        return;
      }
      dispatch.attempted = true;
      trackRunChild(child);
    }
    // 취소 — Stop 누르면 자식 프로세스 트리 종료.
    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderr = "";
    // A resident process settles on the result frame, but agy writes its typed AGY_ERROR line to stderr, a separate pipe
    // that can arrive just after it. An errored turn that named no machine code waits (bounded) for that one line.
    let residentErrorGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEmit = 0;
    /** agy stream-json 누적 상태 — 본문은 text_delta만, 사용량은 DONE에서. */
    const agyState: {
      text: string;
      finalResponse?: string;
      inputTokens: number;
      outputTokens: number;
      usagePairObserved?: boolean;
      deniedTools?: AntigravityDenial[];
      conversationId?: string;
      firstUserInputStepIndex?: number;
      lastAgentResponseStepIndex?: number;
      resultStatus?: string;
      resultConversationId?: string;
      resultError?: string;
      resultErrorCode?: string;
      resultRetryAfterHint?: string;
      schemaBound?: boolean;
      structuredOutput?: string;
    } = { text: "", inputTokens: 0, outputTokens: 0, schemaBound: Boolean(runReq.outputSchema) };
    const announcedDenials = new Set<string>();
    const reportedAgyTools = new Set<string>();
    const stagedAgyGeneratedImageSources = new Set<string>();
    let agyLineBuf = "";
    let settled = false;
    let resultSeen = false;
    /** agy reported another conversation than the one this process was told to resume (the stored one is gone). */
    let conversationLost: { acted: boolean } | null = null;
    // Assigned before either child listener is attached. Resident turns call
    // this on the provider result event; one-shot turns call it on close.
    let settle: (code: number | null) => void = () => {};

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const clearAgyHeartbeatOnly = startCliHeartbeat(child, events.onStatus, "agy");
    // ★호스트 소유 침묵 한도(runner.ts startCliSilenceGuard). 이 러너는 도구 시작/끝을 구분해 보고하지 않아 긴 도구를
    //   침묵으로 오인하지 않도록 한도를 도구 상한(90분)과 같게 둔다. 가드는 트리만 죽이고 settle 이 유일한 정산이다.
    const silenceLimitMs = cliToolSilenceWindowMs(req.env ?? process.env);
    const silence = startCliSilenceGuard(child, {
      label: "agy", onStatus: events.onStatus, windowMs: silenceLimitMs, toolWindowMs: silenceLimitMs, kill: () => killCliTree(child),
    });
    const clearAgyHeartbeat = (): void => { clearAgyHeartbeatOnly(); silence.stop(); };
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    if (!residentSession) {
      ensureChildCloseAfterExit(child, () => {
        events.onStatus("agy: process exited without closing its output — settling the run");
      });
    }
    const consumeAgyLine = (line: string): void => {
      // A resident process can emit a trailing/duplicate line after its
      // result. The result is the per-turn boundary; never route late data to
      // the next turn's sink.
      if (residentSession && resultSeen) return;
      // Output of a conversation that was stopped because it is not the stored one is never shown or used.
      if (conversationLost && !conversationLost.acted) return;
      const trimmedLine = line.trim();
      if (!trimmedLine) return;
      const normalizedLine = effectCoverage.normalizeLine(trimmedLine);
      effectCoverage.observe(normalizedLine);
      const actedBefore = reportedAgyTools.size > 0 || Boolean(agyState.text) || (agyState.deniedTools?.length ?? 0) > 0;
      // A well-formed JSON line of the wrong shape (e.g. a non-string tool_name) must not throw out of the stdout
      // data listener: that is an uncaughtException in Main. Treat it as noise; the terminal result still decides.
      let step: ReturnType<typeof reduceAgyLine>;
      try { step = reduceAgyLine(normalizedLine, agyState); }
      catch { events.onStatus("agy: ignored an event line with an unexpected shape"); step = {}; }
        
                                                                                                                         
                                                                                                                         
                                                                                                                        
                                                                                                                           
                                                                                                                           
                                                                                                 
         
      const lostSignal = !resumesStoredConversation || conversationLost ? null
        : agyState.conversationId && agyState.conversationId !== agyResumeId ? "conversation_id"
          : agyState.firstUserInputStepIndex === 0 ? "empty_conversation" : null;
      if (lostSignal) {
        const acted = actedBefore || Boolean(step.tool || step.delta || step.approvalDenied);
        conversationLost = { acted };
        events.onStatus(`[runtime-session] resume_failed kind=antigravity reason=session_not_found source=${lostSignal}${acted ? " acted=1" : ""}`);
        killCliTree(child);
        if (!acted) return;
      }
      // 도구 호출을 화면으로 올린다 — 같은 도구가 진행(ACTIVE)/완료(DONE)로 두 번 오면 같은
      // id 로 갱신된다(ACTIVE 1회 + DONE 1회만 올린다; 반복 ACTIVE는 무시).
      if (step.tool) {
        const key = `${step.tool.id}:${step.tool.done ? "done" : "active"}`;
        if (!reportedAgyTools.has(key)) {
          reportedAgyTools.add(key);
          const toolArtifactPaths = [...(step.tool.artifactPaths ?? [])];
          if (step.tool.done && !step.tool.failed && step.tool.name === "generate_image"
            && runReq.chatId) {
            let imageName: string | undefined;
            try {
              const parsed = JSON.parse(step.tool.args ?? "null") as { ImageName?: unknown } | null;
              if (typeof parsed?.ImageName === "string") imageName = parsed.ImageName;
            } catch {
              // Malformed provider arguments never gain filesystem authority.
            }
            const scope = createHash("sha256")
              .update(`${runReq.chatId}\0${invocationStartedAtMs}`)
              .digest("hex")
              .slice(0, 32);
            const staged = stageFreshAgyGeneratedImage({
              conversationId: agyState.conversationId,
              imageName,
              invocationStartedAtMs,
              destinationRoot: userDataPath("generated-assets", "antigravity", scope),
              home: env.HOME,
              excludedSources: stagedAgyGeneratedImageSources,
            });
            if (staged) {
              stagedAgyGeneratedImageSources.add(staged.sourcePath);
              toolArtifactPaths.push(staged.artifactPath);
              // The image lives outside the run folder; give later steps (uploads,
              // documents) a working-folder copy and say where it is.
              const workspaceCopy = copyGeneratedImageIntoWorkspace({ cwd: runReq.cwd, permission: runReq.permission,
                sourcePath: staged.artifactPath, label: "image" });
              if (workspaceCopy) events.onStatus(`[image] generated image copied to ${workspaceCopy}`);
            }
          }
          const artifactPaths = freshAgyArtifactPaths(toolArtifactPaths, invocationStartedAtMs);
          events.onTool?.(step.tool.name, step.tool.args, step.tool.result, effectCoverage.toolId(step.tool.id), step.tool.failed, artifactPaths,
            undefined, undefined, step.tool.kind);
        }
      }
      /*
       * ★막힌 도구는 **즉시** 말한다. 이 실행은 뒤에서 SUCCESS + 빈 응답으로 끝나기 때문에,
       * 여기서 알리지 않으면 사용자는 아무 일도 일어나지 않은 화면만 보게 된다.
       */
      // The structured `result.denied_actions` field is the source of truth (reduceAgyLine); when the vendor's step-level
      // error wording drifts and no step announced anything, announce from that field instead of staying silent.
      const denial = step.approvalDenied
        ?? (step.activity === "result" && announcedDenials.size === 0
          ? (agyState.deniedTools ?? []).find((d) => d.reason === "approval") : undefined);
      if (denial && !announcedDenials.has(denial.tool)) {
        announcedDenials.add(denial.tool);
        const tool = denial.tool;
        if (denial.reason === "boundary") {
          /*
           * ★승인 시트를 **열지 않는다**. 아무리 승인해도 열리지 않는 경계이기 때문이다.
           * 여기에 시트를 띄우면 사용자는 자기가 풀 수 있는 문제로 오해하고 누른다 —
           * 그리고 아무 일도 일어나지 않는다. 사실만 한 줄로 남기고 실행은 계속 간다.
           */
          const ko = `${tool} 호출이 Antigravity 자체의 보호 경계에 막혔습니다. 이 경계는 Antigravity 안에 고정되어 있어 권한을 올려도 열리지 않습니다. 실행은 계속됩니다.`;
          const en = `${tool} was blocked by Antigravity's own built-in protection boundary. That boundary is fixed inside Antigravity and raising the permission does not open it. The run continues.`;
          events.onNotice?.({
            level: "warning",
            code: "runtime-protected-path",
            message: runReq.locale === "ko" ? ko : en,
            i18n: { ko, en },
          });
        } else {
          // 시트로도 올린다 — onNotice 는 대화에 남는 사실이고, 이건 지금 결정할 자리다.
          announceToolDenied({
                ...(runReq.signal ? { signal: runReq.signal } : {}),
            runtime: "antigravity",
            sessionKey: `antigravity:${runReq.chatId ?? runReq.cwd ?? "default"}`,
            tool,
            detail: denial.detail,
            cwd: runReq.cwd,
            deniedBy: "runtime-headless",
          });
          const ko = `승인이 필요한 도구 호출이 자동 거부됐습니다: ${tool}. 이 실행에는 승인할 사람이 붙어 있지 않아 런타임이 스스로 거부한 것이며, 사용자가 거절한 것이 아닙니다. 권한을 올리면 이어서 진행됩니다.`;
          const en = `A tool call needing approval was auto-denied: ${tool}. This run has nobody to approve it, so the runtime denied it itself — you did not reject it. Raising the permission lets it continue.`;
          events.onNotice?.({
            level: "warning",
            code: "approval-required",
            message: runReq.locale === "ko" ? ko : en,
            i18n: { ko, en },
          });
        }
      }
      const now = Date.now();
      if (step.delta && now - lastEmit > 80 && agyState.text) {
        events.onPartial(agyState.text);
        lastEmit = now;
      } else if (step.activity && now - lastEmit > 5000) {
        // 델타 없는 활동(도구 스텝·생각) — 워치독 시계용. 5초 한도로 소음 억제.
        events.onStatus(`agy: ${step.activity}`);
        lastEmit = now;
      }
      if (step.activity === "result") {
        resultSeen = true;
      }
      if (residentSession && step.activity === "result") {
        // Let the current line finish all reductions/emissions before closing
        // this sink. This also isolates duplicate result lines in the same
        // stdout chunk.
        if (agyState.resultError && !agyState.resultErrorCode && !completeAgyErrorLineSeen(stderr)) {
          residentErrorGraceTimer = setTimeout(() => settle(0), AGY_ERROR_STDERR_GRACE_MS);
        } else queueMicrotask(() => settle(0));
      }
    };
    const consumeAgyText = (text: string): void => {
      // stream-json 라인 파싱 — 델타가 생존 신호이자 본문이다.
      agyLineBuf += text;
      let nl = agyLineBuf.indexOf("\n");
      while (nl >= 0) {
        const line = agyLineBuf.slice(0, nl);
        agyLineBuf = agyLineBuf.slice(nl + 1);
        consumeAgyLine(line);
        nl = agyLineBuf.indexOf("\n");
      }
    };
    if (!residentSession) {
      child.stdout?.on("data", (chunk: Buffer) => { silence.touch(); consumeAgyText(stdoutDecoder.write(chunk)); });
      child.stderr?.on("data", (chunk: Buffer) => {
        silence.touch();
        stderr += stderrDecoder.write(chunk);
      });
    }

    settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (residentErrorGraceTimer) { clearTimeout(residentErrorGraceTimer); residentErrorGraceTimer = undefined; }
      effectExitCode = code;
      // A resident process intentionally keeps stdout open. For coverage,
      // the accepted provider `result` is the per-turn terminal boundary;
      // physical EOF is only the terminal proof for one-shot runs.
      effectStdoutEnded = residentSession
        ? code === 0 && resultSeen
        : child.stdout?.readableEnded === true;
      if (residentSession && !resultSeen && !req.signal?.aborted && !conversationLost
        && !agyState.text && reportedAgyTools.size === 0) {
        // Safe downgrade: no model text or tool frame was accepted, so the
        // failed resident transport has no effect to replay.
        residentProtocolFallback = true;
      }
      // A child may end on a UTF-8 code-point boundary or without a trailing
      // newline. Flush both decoder tails before deciding which result arrived.
      if (!residentSession) {
        consumeAgyText(stdoutDecoder.end());
        stderr += stderrDecoder.end();
        if (agyLineBuf.trim()) {
          consumeAgyLine(agyLineBuf);
          agyLineBuf = "";
        }
      }
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지(일관성+안전).
      clearAgyHeartbeat();
      if (!residentSession) {
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
      } else if (residentSession.active) {
        residentSession.active = null;
        residentSession.completedTurns += 1;
      }
      cleanupAgyPrompt();
      req.signal?.removeEventListener("abort", onAbort);
      if (resultSeen && agyState.usagePairObserved) {
        events.onTerminalObservedUsage?.({ inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens });
      }
      if (req.signal?.aborted) {
        reject(abortReasonError(req));
        return;
      }
      // A run stopped on another conversation id: never its text, its conversation id or a saved binding.
      if (conversationLost) {
        resolve({ text: "", ownerControlTerminal: "uncertain", failure: antigravityConversationLostFailure(runReq.locale),
          [AGY_CONVERSATION_LOST]: { dispatched: true, replayable: !conversationLost.acted },
          ...(resultSeen && agyState.usagePairObserved
            ? { observedUsage: { inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens } } : {}) });
        return;
      }
      // ★침묵 한도로 호스트가 끝낸 시도 — 이 settle 이 유일한 정산이다(취소는 위에서 처리했고, result 를 받은 턴은 해당 없다).
      if (silence.tripped && !resultSeen) {
        resolve({ text: "", ownerControlTerminal: "uncertain",
          failure: runtimeSilentTimeoutFailure("antigravity", silence.trippedWith?.limitMs ?? silenceLimitMs) });
        return;
      }
      /*
       * ★A turn that ended on a reported error names no machine code on any stream surface: result.error is one sentence,
       * the error_message steps carry no field and AGY_ERROR on stderr is UNKNOWN / gRPC 2 for a safety block and for every
       * other executor failure alike (agy 1.4.3, antigravity-conversation-metadata.ts). The typed reason is in the
       * conversation store agy persists: the stop reason of the turn's last answer attempt (11 = CONTENT_FILTER). It is read
       * from that attempt's own step_index, never by words; any miss leaves the failure exactly as it was.
       */
      // A typed AGY_ERROR line on stderr (quota, sign-in, brief outage) is the machine value the result
      // frame lacks. Order: the result frame's own code, then this line, then the stop-reason store below.
      if (agyState.resultError) {
        if (!agyState.resultErrorCode) {
          const lineCode = readAntigravityErrorLine(stderr);
          if (lineCode) agyState.resultErrorCode = lineCode;
        }
        const errorStatus = antigravityErrorStatusLine(stderr);
        if (errorStatus) { try { events.onStatus(errorStatus); } catch { /* observer only */ } }
      }
      if (agyState.resultError && !agyState.resultErrorCode && agyState.conversationId
        && agyState.lastAgentResponseStepIndex !== undefined) {
        const stopCode = antigravityStopReasonCode(readAntigravityAnswerStopReason(
          agyState.conversationId, agyState.lastAgentResponseStepIndex, antigravityStoreHomes(env)));
        if (stopCode) agyState.resultErrorCode = stopCode;
      }
      if (code === 0) {
        /*
         * ★exit 0이어도 산출물이 산출물인지 본다 — 표식과 미지원 클라이언트 검사는
         * 예전엔 exit≠0 분기에만 있어서, 조용히 exit 0으로 끝나는 거절이 정상 답이 됐다.
         * (표식 우선, 휴리스틱은 runtime-refusal.ts 한 곳 — 출처를 heuristic으로 남긴다.)
         */
        // ★최종 result.response가 정본 — 델타 누적은 오염될 수 있는 표시용이다.
        // If the final event itself is malformed, prefer a clean accumulated
        // response. If every candidate contains U+FFFD, fail closed instead of
        // persisting a visibly corrupted answer.
        // A `--json-schema` run answers on its typed channel, result.structured_output (the accepted `finish` submission);
        // its result.response is every draft of the turn joined, never the answer. An agy that reports no typed answer
        // keeps the earlier reading.
        const structuredAnswer = runReq.outputSchema ? agyState.structuredOutput : undefined;
        const responseCandidates = (structuredAnswer !== undefined ? [structuredAnswer] : [agyState.finalResponse, agyState.text])
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        const agyBody = responseCandidates.find((value) => !value.includes("\uFFFD"));
        if (responseCandidates.length > 0 && !agyBody) {
          reject(new Error("Antigravity returned malformed UTF-8 output"));
          return;
        }
        const body = agyBody ?? "";
        const trimmed = body.trim();
        // The drafts streamed as partials were not the answer; the last partial is (as Claude's StructuredOutput channel).
        if (structuredAnswer !== undefined && trimmed) events.onPartial(trimmed);
          
                                   
          
                                                                   
                                                                     
                                                     
                         
          
                                                   
                                                                
           
        const denied = agyState.deniedTools ?? [];
          
                                                        
          
                                                                          
                                                      
                                                       
                                                         
                                                    
                                                  
           
        // 판정 근거는 새로 만들지 않는다 — 도구를 열었는지는 이미 agyToolsAllowed 가 안다.
        const structural = !agyToolsAllowed;
          
                                                            
          
                                              
                                                              
                                                                      
                                                               
                                                              
                                                      
                                                                    
           
        const resultFailure = antigravityResultFailure(agyState);
        const runtimeSaidWhy = resultFailure
          ? {
            kind: resultFailure.kind,
            message: resultFailure.message,
            runtime: "antigravity" as const,
            source: "marker" as const,
            ...(agyState.resultErrorCode ? { providerCode: agyState.resultErrorCode } : {}),
            ...(agyState.resultRetryAfterHint ? { retryAfterHint: agyState.resultRetryAfterHint } : {}),
            exitCode: 0,
          }
          : undefined;
          
                                                                
                                                                             
                                                                             
                                                                       
           
        // agy's own SUCCESS result is a normal end, settled by the shared rule (R-065): a tool-only run completed with an
        // empty text; only one with neither text nor a reported tool is the empty failure below.
        const agyEnd = settleNormalEnd({ text: trimmed, toolCalls: new Set([...reportedAgyTools].map((key) => key.replace(/:(?:active|done)$/u, ""))).size });
        const deniedOutcome = antigravityEmptyRunOutcome({
          answered: Boolean(trimmed),
          toolsAllowed: !structural,
          denials: denied,
          locale: runReq.locale,
        });
        const failure = runtimeSaidWhy ?? (deniedOutcome
          ? {
            kind: deniedOutcome.kind,
            message: deniedOutcome.message,
            runtime: "antigravity" as const,
            // 경계 판정은 문구에서 나온다 — 출처를 marker 로 속이지 않는다(runtime-refusal.ts 규약).
            source: deniedOutcome.kind === "empty" ? ("heuristic" as const) : ("marker" as const),
          }
          : antigravityExitFailure(body, stderr)
            
                                
            
                                                                        
                                                           
                                                         
                                                            
                                                            
                                                                   
            
                                                                
                                      
             
          ?? (agyEnd.outcome === "empty"
            ? {
              kind: "empty" as const,
              message: runReq.locale === "ko"
                ? "Antigravity 가 아무 답도 내지 않고 실행을 끝냈습니다. 이 턴은 결과로 인정하지 않습니다."
                : "Antigravity ended the run without producing any answer. This turn is not counted as a result.",
              runtime: "antigravity" as const,
              source: "exit" as const,
            }
            : undefined));
        /*
         * ★대화 ID 를 저장해야 재개가 다음 턴에 실제로 걸린다. 이 한 줄이 없으면
         * `--conversation` 배선은 영원히 죽은 코드다 — 저장 없이는 되돌릴 ID 가 없다.
         * 실패한 턴은 저장하지 않는다: 답이 없는 대화를 이어가면 다음 턴이 그 실패를
         * 문맥으로 물려받는다.
         */
        if (runReq.chatId && agyFingerprint && agyState.conversationId && !failure) {
          saveRuntimeSession(runReq.chatId, ANTIGRAVITY_KIND, agyState.conversationId, agyFingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
        }
        const completed = Boolean(resultSeen && agyState.resultStatus === "SUCCESS" && !failure && agyEnd.outcome === "completed"
          && Boolean(agyState.conversationId?.trim())
          && (!agyResumeId || agyState.conversationId === agyResumeId)
          && (!agyState.resultConversationId || agyState.resultConversationId === agyState.conversationId));
        if (completed && stableContext?.delivery && agyState.conversationId) {
          acknowledgeStableTurnContext(stableContext.delivery, { sessionId: agyState.conversationId, acknowledgementId: randomUUID() });
        }
        resolve({
          text: trimmed,
          ownerControlTerminal: completed ? "completed" : "uncertain",
          ...(failure ? { failure } : {}),
          ...(completed ? normalEndToolEvidence(agyEnd) : {}),
          // The conversation this turn ran on: the common journal acknowledges it as the binding's native handle (NH11).
          ...(!failure && agyState.conversationId?.trim() ? { sessionId: agyState.conversationId } : {}),
          ...(resultSeen && agyState.usagePairObserved
            ? {
              tokens: agyState.outputTokens,
              observedUsage: { inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens },
              // The last agent_response step's input: the context the next request starts from (the common 80% rule).
              ...(agyState.inputTokens > 0 ? { contextInputTokens: agyState.inputTokens } : {}),
            }
            : {}),
        });
      } else if (antigravityResultFailure(agyState)) {
          
                                                  
          
                                                                  
                                                               
                                                               
           
        const resultFailure = antigravityResultFailure(agyState)!;
        resolve({
          text: "",
          ownerControlTerminal: "uncertain",
          failure: {
            kind: resultFailure.kind,
            message: resultFailure.message,
            runtime: "antigravity",
            source: "marker",
            ...(agyState.resultErrorCode ? { providerCode: agyState.resultErrorCode } : {}),
            ...(agyState.resultRetryAfterHint ? { retryAfterHint: agyState.resultRetryAfterHint } : {}),
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
          ...(resultSeen && agyState.usagePairObserved
            ? { observedUsage: { inputTokens: agyState.inputTokens, outputTokens: agyState.outputTokens } }
            : {}),
        });
      } else {
        resolve({
          text: "",
          ownerControlTerminal: "uncertain",
          failure: {
            kind: "exit",
            message: `Antigravity exited without a structured provider failure.${childExitReason(code, stderr) ? ` ${childExitReason(code, stderr)}` : ""}`,
            runtime: "antigravity",
            source: "exit",
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
        });
      }
    };

    if (!residentSession) {
      child.once("close", (code) => settle(typeof code === "number" ? code : null));
    }
    if (!residentSession) {
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearAgyHeartbeat();
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        cleanupAgyPrompt();
        req.signal?.removeEventListener("abort", onAbort);
        // A child with no pid never started (ENOENT, EACCES): nothing of this attempt reached agy.
        if (child.pid === undefined && !dispatchedBefore && !req.signal?.aborted) {
          dispatch.attempted = false;
          reject(preDispatchRefusal(err, "antigravity-spawn", "agy_spawn_failed"));
          return;
        }
        reject(err);
      });
    } else {
      residentSession.active = {
        onLine: (line) => { silence.touch(); consumeAgyLine(line); },
        onStderr: (chunk) => {
          silence.touch(); stderr += chunk;
          // The awaited AGY_ERROR line is complete: settle now instead of waiting out the grace.
          if (residentErrorGraceTimer && completeAgyErrorLineSeen(stderr)) {
            clearTimeout(residentErrorGraceTimer); residentErrorGraceTimer = undefined;
            queueMicrotask(() => settle(0));
          }
        },
        onDeath: (code) => settle(code),
      };
      if (!antigravityResidentSessionAlive(residentSession)
        || !writeAntigravityResidentTurn(
          residentSession,
          residentLease?.fresh && !agyResumeId
            ? spawnPrompt
            : resumeTurnInput,
        )) {
        residentSession.active = null;
        settle(null);
      } else {
        dispatch.attempted = true;
      }
    }
  }).then(result => {
    effectRun?.complete(effectCoverage.finish({ exitCode: effectExitCode, stdoutEnded: effectStdoutEnded, cancelled: req.signal?.aborted === true, failed: !!result.failure }));
    if (effectRun && !result.failure) recordMainExecutionProofs({scopeId:effectRun.scopeId,bindings:effectBindings,signal:req.signal,claims:executionClaims});
    // The effort level this process ran at (antigravity-effort.ts); null when this runner set none.
    return { ...result, appliedEffort: effortPlan.applied };
  }, error => {
    effectRun?.complete(effectCoverage.finish({ exitCode: effectExitCode, stdoutEnded: effectStdoutEnded, cancelled: req.signal?.aborted === true, failed: true }));
    throw error;
  }).finally(detachEffects);
  }
};

/**
 * A configured tool surface must not silently become an answer-only read run. The condition is the declared
 * readWithTools limit (shared/runtime-capabilities.ts RUNTIME_REQUEST_LIMITS), the row selectors filter on.
 */
export function antigravityReadToolFailure(req: RunnerRequest): RunnerFailure | undefined {
  if (runtimeRequestRefusal(ANTIGRAVITY_KIND, { permission: req.permission, browserOnly: req.browserOnly,
    mcpConfigPath: req.mcpConfigPath, mcpAllowedTools: req.mcpAllowedTools }) !== "read_tools_unsupported") return undefined;
  return {
    kind: "refused", runtime: "antigravity", source: "marker",
    providerCode: "agy_read_tools_unsupported",
    message: req.locale === "ko"
      ? "Antigravity의 현재 헤드리스 실행은 읽기 권한을 유지하며 선택된 도구를 사용할 수 없습니다. 같은 읽기 권한을 지원하는 허용된 런타임이 필요합니다."
      : "Antigravity cannot use the configured tools while preserving read permission in this headless runtime. Use an allowed runtime supporting the same read scope.",
  };
}

export const runAntigravity: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => withAgyDispatchAncestry(async () => {
  const dispatch: AntigravityDispatchState = { attempted: false };
  try {
  assertScienceRecoveryRequest(req, "antigravity");
  // Propagate root lifetime through preparation, final pre-spawn checks and
  // the child itself; an inherited detached callback cannot outlive its grant.
  const scheduledSignal = scheduledRootAgySignal(req.signal);
  if (scheduledSignal) req = { ...req, signal: scheduledSignal };
  req.signal?.throwIfAborted();
  // agy 1.1.26 exposes terminal sandboxing and slash-command suppression,
  // but neither removes built-in tools or inherited global MCP servers. A
  // read permission without auto-approval is not a verified no-tools envelope.
  // Refuse before discovery, attachment staging, MCP reconciliation or spawn;
  // trusted invocations retain their existing permission and session contracts.
  // Both refusals are the declared limits selectors filter on (shared/runtime-capabilities.ts RUNTIME_REQUEST_LIMITS).
  const declaredRefusal = runtimeRequestRefusal(ANTIGRAVITY_KIND, { untrustedNoTools: req.untrustedNoTools,
    judgmentOnly: req.judgmentOnly, restrictedReadBoundary: req.restrictedReadBoundary });
  if (req.untrustedNoTools && declaredRefusal === "untrusted_no_tools_unsupported") {
    throw new RuntimeJudgmentRefusal(
      "antigravity",
      req.locale === "ko"
        ? "현재 Antigravity CLI에서 기본 도구와 기존 MCP 서버를 모두 차단하는 격리가 검증되지 않아 비신뢰 실행을 시작할 수 없습니다. 격리 실행을 지원하는 런타임이 필요합니다."
        : "Antigravity CLI has no verified isolation that disables all built-in tools and inherited MCP servers. This untrusted run cannot start; use a runtime with verified isolation.",
    );
  }
  if (declaredRefusal === "restricted_read_unsupported") {
    throw markRefusedBeforeDispatch(new Error(
      "Antigravity is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    ));
  }
  const readToolFailure = antigravityReadToolFailure(req);
  if (readToolFailure) return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: readToolFailure };
  // A gate or script (no install identity) in the account's own HOME: no product mirror can exist (product-home-identity.ts),
  // so the person's CLI is not even probed.
  if (productHomeRefusedOnThisHost(agySpawnHome(req.env ?? process.env))) {
    return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: { kind: "unavailable",
      runtime: "antigravity", source: "marker", providerCode: "agy_unconfigured_host_personal_home",
      message: "Antigravity would run in the person's own home from a host with no install identity; nothing was started." } };
  }
  const bin = await getBin({ source: req.runtimeSource });
  if (!bin) throw markRefusedBeforeDispatch(new Error(tStatus(req.locale, "errCliMissingAntigravity")));
  const executableIdentity = observeCliExecutableIdentity({
    bin,
    cwd: req.cwd ?? agentRunCwd(),
    env: req.env ?? process.env,
  });
  if (!executableIdentity) throw markRefusedBeforeDispatch(new Error(tStatus(req.locale, "errCliMissingAntigravity")));
  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;
  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  }
  return await runPreparedAntigravity(
    runReq,
    events,
    executableIdentity.executable,
    executableIdentity.fingerprint,
    executableIdentity.generation,
    stagedImages.directory ? [stagedImages.directory] : [],
    executableIdentity.legacyFingerprint,
    dispatch,
  );
  } catch (error) {
    // Every throw before an agy process started or a resident accepted the turn is a refusal before dispatch
    // (RuntimeTurnDelivery "not-dispatched", runner.ts preDispatchRefusal keeps its innermost machine code): the
    // untrusted/read-boundary refusals, attachment staging, an oversized browser prompt, a task browser scope without
    // its config, a busy resident owner. The graph and the owner's turn then fail with that cause instead of "may have
    // acted". A Stop keeps its abort; an already marked refusal is rethrown as it is.
    if (dispatch.attempted || req.signal?.aborted || runnerRefusedBeforeDispatch(error)) throw error;
    throw preDispatchRefusal(error, "antigravity-prepare", "agy_pre_dispatch_refused");
  }
});
