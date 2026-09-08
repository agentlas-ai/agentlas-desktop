import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  resolveMcpNeeds,
  type McpGoalNeedContext,
  type McpNeedCandidate,
  type McpRuntimeCapabilities,
  type ResolvedMcpNeeds,
} from "./need-resolver";
import os from "node:os";
import path from "node:path";
import { supersededByLivePeer } from "../plugins/builtin";
import { MCP_TOOL_CATALOG } from "./catalog";
import { installFromCatalog, listInstalledServers } from "./registry";
import { testServerConnection } from "./client";
import { readEnvVar } from "../secrets/vault";
import { getSource as getMarketSource } from "../marketplace";
import { resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import { buildToolAccessNotice } from "../../shared/tool-access-notice";
import { listPendingHubPluginApprovals } from "./hub-plugin-bridge";
import { judgedComputerUse } from "../system-agents/judged-tool-mode";
import { isKeylessPlaywrightMcpDuplicate } from "./mcp-config";
import type {
  AutomationHubMode,
  AutomationToolMode,
  InstalledMcpServer,
  MarketplaceListing,
  McpToolCatalogEntry,
} from "../../shared/types";

/** Main-owned binding; never populated from renderer input or model text. */
export interface ActiveGoalToolScope {
  goalId: string;
  revision: number;
  permission: "read" | "write" | "full";
  /** Host-read contract fields from the same active revision. */
  objective?: string;
  acceptanceCriteria?: readonly string[];
}

export interface GoalToolSelectionReceipt {
  goalId: string;
  revision: number;
  scopeHash: string;
  selectedIds: string[];
}

export interface AutoSelectedMcpTool {
  id: string;
  name: string;
  reason: string;
  installed: boolean;
  missingEnv: string[];
  required: boolean;
  state:
    | "ready"
    | "missing-key"
    | "install-failed"
    | "probe-failed"
    | "disabled"
    | "server-unavailable"
    | "host-failure";
}

export interface HubPluginCandidate {
  slug: string;
  name: string;
  reason: string;
  installCli?: string;
  manifestUrl?: string;
  category?: string;
  score: number;
}

export interface AutoSelectedMcpContext {
  /** Main-only scope for a provided-credentials retry in this invocation. */
  goalSelectionScope?: Omit<GoalToolSelectionReceipt, "selectedIds">;
  /** Main-only dispatch guard; never serialized into a selection receipt. */
  goalSelectionIsCurrent?: () => boolean;
  /** Main-computed host binding after exact product-name and judgment rules. */
  effectiveToolMode: AutomationToolMode;
  tools: AutoSelectedMcpTool[];
  localInventory: string[];
  localPluginCount: number;
  hubPluginCount: number;
  hubPlugins: HubPluginCandidate[];
  hubPluginError?: string;
  /**
   * 이미 이 기계에 붙어 있지만 로컬 실행 승인을 기다리며 꺼져 있는 도구 이름들.
   * 새로 설치하라고 권하기 전에 이것부터 말해야 한다 — 사용자는 이미 받아 놓았다.
   */
  pendingApprovalTools?: string[];
  /** True when the resident judge actually decided this run's optional tool set. */
  needsDecided: boolean;
  /** Value-free note: nothing was decided, or the candidate inventory was capped. */
  needsNote?: string;
  /**
   * Why nothing was decided, and whether that cost anything.
   *
   * "undecided" and "there was nothing to decide" are different facts with different next actions,
   * and collapsing them made the product warn on every single message. A plain request with no
   * optional tool in play produced the same alarming card as a browser task whose judge was dead.
   */
  needsOutcome?: {
    decided: boolean;
    /** Candidates the judge was actually offered. Zero means there was nothing to decide. */
    candidateCount: number;
    reason: string;
  };
}

export interface AutoSelectMcpDependencies {
  listInstalledServers: () => InstalledMcpServer[];
  installFromCatalog: (catalogId: string) => InstalledMcpServer;
  readEnvVar: (key: string) => Promise<string | null>;
  testServerConnection: (server: InstalledMcpServer, signal?: AbortSignal) => Promise<{
    connected: boolean;
    missingEnv: string[];
  }>;
  /** The only thing allowed to pick an optional tool. Injectable so tests can pin a verdict. */
  resolveNeeds: (input: {
    task: string;
    candidates: McpNeedCandidate[];
    goal?: McpGoalNeedContext;
    runtimeCapabilities?: McpRuntimeCapabilities;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<ResolvedMcpNeeds>;
}

/** Build a deterministic fixed-assignment result for an agent whose One Team
 * tools toggle is off. No resident judge, Hub search, install, or probe is
 * allowed in this mode; the member's declared MCP ids are the complete set. */
async function fixedAssignmentContext(input: {
  agentName: string;
  userPrompt: string;
  systemPrompt: string;
  workingFolder?: string | null;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  /** Abort the optional tool-need judgment when the parent invocation stops. */
  signal?: AbortSignal;
  fixedServerIds: string[];
  installedServers: InstalledMcpServer[];
}): Promise<AutoSelectedMcpContext> {
  const wanted = new Set(input.fixedServerIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()));
  const tools = input.installedServers
    .filter((server) => wanted.has(server.id) || (server.catalogId ? wanted.has(server.catalogId) : false))
    .map((server) => ({
      id: server.catalogId || server.id,
      name: server.nameEn || server.name,
      reason: "fixed assignment from this One Team member",
      installed: true,
      missingEnv: [],
      required: false,
      state: server.enabled && server.configurationValid !== false ? "ready" as const : "disabled" as const,
    }));
  return {
    effectiveToolMode: resolveAutomationToolMode({
      toolMode: input.toolMode,
      name: input.agentName,
      promptTemplate: input.userPrompt,
      targetLabel: input.workingFolder,
      judged: judgedComputerUse,
    }),
    tools,
    localInventory: input.installedServers.map((server) => server.catalogId || server.id).sort(),
    localPluginCount: tools.length,
    hubPluginCount: 0,
    hubPlugins: [],
    needsDecided: true,
    needsNote: "Automatic MCP selection is off for this One Team member; only fixed assignments were attached.",
  };
}

const DEFAULT_AUTO_SELECT_DEPS: AutoSelectMcpDependencies = {
  listInstalledServers,
  installFromCatalog,
  readEnvVar,
  // The browser host may need to open Chrome and attach over CDP on its first
  // run. Three seconds was shorter than a warm local probe and made clean
  // installs look unavailable before the bundled host could answer tools/list.
  testServerConnection: (server, signal) => testServerConnection(server, {
    signal,
    // A missing uv runtime is provisioned inside this same cancellable deadline.
    timeoutMs: server.command === "uvx" || server.command === "uv"
      ? 45_000
      : server.catalogId === "agentlas-browser" || server.catalogId === "playwright" ? 20_000 : 3_000,
  }),
  resolveNeeds: resolveMcpNeeds,
};

// Tool selection is decided by resolveMcpNeeds() (electron/mcp-tools/need-resolver.ts),
// which asks the connected model what the task actually needs. The keyword tables that used
// to live here are GONE on purpose: a word in a prompt must never attach a tool or raise a
// credential prompt — that is what handed users a Brave Search key request (and a stalled
// run) for a Reddit posting job whose text merely said "조사".
//
// What may still pin a tool without the model: an EXPLICIT user choice (toolMode) and the
// credential-free Hub routing resolver. Those are settings, not word matches.
const HUB_PLUGIN_LOOKUP_TIMEOUT_MS = 8_000;
const HUB_PLUGIN_CANDIDATE_LIMIT = 8;
/** Hub inventory offered to the resident judge in one call. */
const HUB_PLUGIN_INVENTORY_LIMIT = 60;

const LOCAL_PLUGIN_SCAN_DIRS = [
  path.join(os.homedir(), ".codex", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "marketplaces"),
  path.join(os.homedir(), ".agentlas", "plugins"),
];

function normalize(text: string): string {
  return text.toLowerCase();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Hub plugin lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function missingRequiredEnv(
  entry: McpToolCatalogEntry,
  readSecret: (key: string) => Promise<string | null>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const requirement of entry.envRequirements) {
    if (!requirement.required) continue;
    const value = await readSecret(requirement.key);
    if (!value) missing.push(requirement.key);
  }
  return missing;
}

function readDirectoryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function listLocalPluginInventory(installed: Set<string>): string[] {
  const inventory = new Set<string>();
  for (const entry of MCP_TOOL_CATALOG) inventory.add(entry.id);
  for (const id of installed) inventory.add(id);
  for (const dir of LOCAL_PLUGIN_SCAN_DIRS) {
    for (const name of readDirectoryNames(dir)) inventory.add(name);
  }
  return Array.from(inventory).sort((a, b) => a.localeCompare(b));
}

export function isHubPluginListing(listing: MarketplaceListing): boolean {
  return listing.entityKind === "plugin" || listing.source === "hub-plugin" || listing.kind === "hub-plugin";
}

/** One line of inventory text for the resident judge — what this plugin does, in words. */
export function hubListingDescription(listing: MarketplaceListing): string {
  return (
    [listing.taglineEn, listing.tagline, listing.category, listing.developer]
      .filter(Boolean)
      .join(" · ") || "Agentlas Hub plugin"
  );
}

/**
 * 명시적으로 초기화된 프로젝트 폴더인가. `.agentlas` 존재가 그 표식이고, 터미널의 펜스 적용도
 * 같은 기준을 쓴다(임의 cwd 에 스캐폴딩을 만들지 않는다는 계약과 동일선).
 * 판정 불가(경로 없음/접근 불가)는 **프로젝트가 아님**으로 본다 — 좁히기는 확실할 때만 한다.
 */
// ── ④ 후속 턴 재사용 (per-conversation selection memo) ─────────────────────
// 같은 대화 안에서 도구 구성이 바뀔 이유는 거의 없는데, 이 선택기는 매 턴
//   ① 판정 2회(LLM) ② 고른 서버 **최대 10개를 새로 띄워 접속 확인**
// 을 전부 다시 했다. 실제 자원을 먹는 쪽은 ②다(매번 프로세스 spawn).
//
// 두 단계로 아낀다. 어느 쪽도 "의미"로 판단하지 않는다 — 구조가 같을 때만 재사용한다.
//   1단계: 대화·모드·설치목록·과제문 서명이 **전부 같으면** 지난 결과를 그대로 돌려준다.
//   2단계: 서명이 달라 다시 판정하더라도, 이 대화에서 방금 접속에 성공한 서버는 다시 띄우지 않는다.
//          실패한 서버는 캐시하지 않는다 — 사용자가 바로 그걸 고치는 중일 수 있다.
const SELECTION_MEMO_TTL_MS = 5 * 60_000;
const SELECTION_MEMO_MAX = 40;

interface SelectionMemoEntry {
  context: AutoSelectedMcpContext;
  at: number;
}

const selectionMemo = new Map<string, SelectionMemoEntry>();
/**
 * ── 캐시 안정 sticky 도구셋 (2026-08-18) ──────────────────────────────────
 * 위 1단계 메모는 키에 과제문 해시가 들어가 **새 턴에서는 절대 히트하지 않는다** —
 * 그래서 턴마다 선택이 새로 돌았고, 조합이 조금만 달라져도 런타임 도구 목록이 바뀌어
 * 프롬프트 캐시가 그 지점부터 전부 무효가 됐다(실측: 도구/MCP 델타가 있던 턴의 캐시
 * 붕괴율 28.8% vs 없던 턴 2.2%, 데스크탑 히트율 34.6% vs baseline 97.7%).
 *
 * 같은 대화(structuralKey)의 후속 턴은 지난 도구셋을 **합집합으로만** 넓힌다:
 *  - 이번 턴 선택 ⊆ sticky → 도구셋 불변 → MCP config 바이트 동일 → 캐시 보존
 *  - 이번 턴이 새 도구를 요구 → sticky ∪ fresh (딱 1회 캐시 브레이크, 축소는 없음)
 * 상태(ready/missing-key)는 이번 턴 선택분이 우선하고, 이월분은 지난 상태를 유지한다.
 * TTL은 대화 호흡에 맞춰 1단계보다 길게 둔다. 자격 증명 변경 시 invalidate가 함께 비운다.
 */
const STICKY_SELECTION_TTL_MS = 30 * 60_000;
const stickySelectionMemo = new Map<string, SelectionMemoEntry>();
// Process-local selection hints, not grants or a durable checkpoint. A Goal retains
// only exact IDs; current configuration, secrets and connection are checked each turn.
const goalSelectionMemo = new Map<string, { scopeKey: string; selectedIds: string[] }>();
/** key = `${structuralKey}\u0000${serverId}` → 마지막 접속 성공 시각 */
const probeMemo = new Map<string, number>();

/** 메모는 여러 턴에 걸쳐 살아 있다 — 호출부가 만진 흔적이 다음 턴으로 새면 안 된다. */
function cloneContext(context: AutoSelectedMcpContext): AutoSelectedMcpContext {
  return {
    ...context,
    tools: context.tools.map((tool) => ({ ...tool, missingEnv: [...tool.missingEnv] })),
    localInventory: [...context.localInventory],
    hubPlugins: context.hubPlugins.map((plugin) => ({ ...plugin })),
    ...(context.pendingApprovalTools ? { pendingApprovalTools: [...context.pendingApprovalTools] } : {}),
  };
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function memoSet<V>(store: Map<string, V>, key: string, value: V): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > SELECTION_MEMO_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * 자격 증명이 새로 저장되면 세상이 바뀐다 — 그때는 아무 메모도 믿으면 안 된다.
 * (키 요청 시트가 값을 받은 뒤 부르는 reselect 경로가 이걸 통과한다.)
 */
export function invalidateMcpSelectionMemo(): void {
  selectionMemo.clear();
  probeMemo.clear();
  stickySelectionMemo.clear();
}

function isExplicitProjectFolder(workingFolder?: string | null): boolean {
  const folder = typeof workingFolder === "string" ? workingFolder.trim() : "";
  if (!folder) return false;
  try {
    return fs.existsSync(path.join(folder, ".agentlas"));
  } catch {
    return false;
  }
}

/** Fetch the Hub plugin inventory. NOTHING is scored or filtered by words here — the
 *  listings are handed to the resident judge as candidates and it names the ones the
 *  task actually needs. */
export async function fetchHubPluginInventory(hubAllowed: boolean): Promise<{
  listings: MarketplaceListing[];
  hubPluginCount: number;
  hubPluginError?: string;
}> {
  if (!hubAllowed) return { listings: [], hubPluginCount: 0 };
  try {
    const listings = await withTimeout(getMarketSource().searchAgents(""), HUB_PLUGIN_LOOKUP_TIMEOUT_MS);
    const plugins = listings.filter(isHubPluginListing);
    return { listings: plugins, hubPluginCount: plugins.length };
  } catch (err) {
    return {
      listings: [],
      hubPluginCount: 0,
      hubPluginError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function autoSelectMcpTools(input: {
  userPrompt: string;
  systemPrompt: string;
  agentName: string;
  workingFolder?: string | null;
  /** Capabilities proven by Main for this exact invocation. Missing means unknown. */
  runtimeCapabilities?: McpRuntimeCapabilities;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  /** Abort the optional tool-need judgment when the parent invocation stops. */
  signal?: AbortSignal;
  /** 같은 채팅의 후속 턴을 알아보기 위한 대화 식별자. 없으면 재사용하지 않는다. */
  conversationId?: string | null;
  /** Main re-reads the active durable binding before reusing a selection. */
  resolveActiveGoalScope?: () => ActiveGoalToolScope | null;
  /** Host ledger adapters return only exact IDs, never cached connection states. */
  readGoalSelection?: (scope: Omit<GoalToolSelectionReceipt, "selectedIds">) => string[];
  writeGoalSelection?: (receipt: GoalToolSelectionReceipt) => void;
  /** Supplied only by the host credential gate after its typed provided outcome. */
  credentialRetry?: GoalToolSelectionReceipt;
  /** 자격 증명 입력 직후의 재선택 — 메모를 무시하고 처음부터 다시 고른다. */
  bypassSelectionMemo?: boolean;
  /** One Team per-member tool policy. Omitted means the normal automatic mode. */
  autoSelectTools?: boolean;
  /** Installed MCP ids declared by the bound One Team member when auto mode is off. */
  fixedServerIds?: string[];
  /** Graph-declared tool ids; canonical browser declarations suppress duplicate probing. */
  requiredToolCatalogIds?: string[];
}, injectedDeps: Partial<AutoSelectMcpDependencies> = {}): Promise<AutoSelectedMcpContext> {
  const deps: AutoSelectMcpDependencies = { ...DEFAULT_AUTO_SELECT_DEPS, ...injectedDeps };
  // The task as written, not lowercased and not tokenized — the resident judge reads it.
  // Agent name and user prompt come first because the resolver truncates the tail.
  const taskText = [input.agentName, input.userPrompt, input.workingFolder ?? "", input.systemPrompt]
    .filter(Boolean)
    .join("\n");
  // Does this automation actually have to drive a human-facing web UI? The same
  // resident tool-needs judgment below decides that by selecting the Browser or
  // Computer Use candidate. A separate prejudge used to ask the model the same
  // question first; a cold One Team turn therefore paid for two model calls
  // before any worker started. Cached historical judgment is still accepted as
  // a warm hint, but this function issues exactly one fresh judgment.
  // 설치 목록 읽기는 로컬 DB 조회다 — 판정보다 앞에 두어야 메모 지문을 만들 수 있다.
  let initialInstalledServers: InstalledMcpServer[] = [];
  try {
    initialInstalledServers = deps.listInstalledServers();
  } catch {
    initialInstalledServers = [];
  }
  if (input.autoSelectTools === false) {
    return fixedAssignmentContext({
      agentName: input.agentName,
      userPrompt: input.userPrompt,
      systemPrompt: input.systemPrompt,
      workingFolder: input.workingFolder,
      toolMode: input.toolMode,
      hubMode: input.hubMode,
      fixedServerIds: input.fixedServerIds ?? [],
      installedServers: initialInstalledServers,
    });
  }
  const activeGoalScope = input.resolveActiveGoalScope?.() ?? null;
  const runtimeCapabilities: McpRuntimeCapabilities = {
    nativeBrowser: input.runtimeCapabilities?.nativeBrowser ?? "unknown",
    nativeWebSearch: input.runtimeCapabilities?.nativeWebSearch ?? "unknown",
  };
  const registryFingerprint = (servers: InstalledMcpServer[]): string => createHash("sha256").update(servers
    .map((server) => JSON.stringify([server.id, server.catalogId, server.enabled, server.configurationValid !== false,
      server.transport, server.command, server.args, server.url, server.envKeys, server.installedAt]))
    .sort().join("\n")).digest("hex");
  const installedFingerprint = registryFingerprint(initialInstalledServers);
  let expectedInstalledFingerprint = installedFingerprint;
  if (input.bypassSelectionMemo) invalidateMcpSelectionMemo();
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  const structuralKeyFor = (fingerprint: string): string => conversationId
    ? [conversationId, input.toolMode ?? "auto", input.hubMode ?? "auto", runtimeCapabilities.nativeBrowser,
      fingerprint, [...(input.requiredToolCatalogIds ?? [])].sort().join(",")].join("\u0000")
    : "";
  const structuralKey = structuralKeyFor(installedFingerprint);
  const goalScopeKeyFor = (fingerprint: string): string => activeGoalScope && structuralKey
    ? JSON.stringify([structuralKeyFor(fingerprint), activeGoalScope, input.workingFolder ?? ""])
    : "";
  const goalScopeKey = goalScopeKeyFor(installedFingerprint);
  const previousGoalSelection = conversationId ? goalSelectionMemo.get(conversationId) : undefined;
  if (previousGoalSelection?.scopeKey !== goalScopeKey && conversationId) goalSelectionMemo.delete(conversationId);
  const receiptScope = activeGoalScope && goalScopeKey ? {
    goalId: activeGoalScope.goalId,
    revision: activeGoalScope.revision,
    scopeHash: createHash("sha256").update(goalScopeKey).digest("hex"),
  } : null;
  let priorSelectedIds: string[] = previousGoalSelection?.scopeKey === goalScopeKey
    ? previousGoalSelection.selectedIds : [];
  if (receiptScope && input.readGoalSelection) {
    // A ledger read failure cannot fall back to older in-memory authority.
    try { priorSelectedIds = input.readGoalSelection(receiptScope); } catch { priorSelectedIds = []; }
  }
  const retainedIds = new Set(priorSelectedIds);
  const retry = input.credentialRetry;
  if (input.bypassSelectionMemo && receiptScope && retry?.goalId === receiptScope.goalId
    && retry.revision === receiptScope.revision && retry.scopeHash === receiptScope.scopeHash) {
    for (const id of retry.selectedIds) retainedIds.add(id);
  }
  const goalBindingStillCurrent = (): boolean => Boolean(activeGoalScope && !input.signal?.aborted
    && JSON.stringify(input.resolveActiveGoalScope?.() ?? null) === JSON.stringify(activeGoalScope));
  const goalScopeStillCurrent = (): boolean => goalBindingStillCurrent()
    && registryFingerprint(deps.listInstalledServers()) === expectedInstalledFingerprint;
  const memoKey = structuralKey ? `${structuralKey}\u0000${shortHash(taskText)}` : "";
  if (memoKey && !activeGoalScope) {
    const hit = selectionMemo.get(memoKey);
    if (hit && Date.now() - hit.at < SELECTION_MEMO_TTL_MS) return cloneContext(hit.context);
    if (hit) selectionMemo.delete(memoKey);
  }

  let effectiveToolMode = resolveAutomationToolMode({
    toolMode: input.toolMode,
    name: input.agentName,
    promptTemplate: input.userPrompt,
    targetLabel: input.workingFolder,
    judged: judgedComputerUse,
  });
  const installed = new Set(
    initialInstalledServers
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const hubAllowed = input.hubMode !== "local-only";
  const localInventory = listLocalPluginInventory(installed);
  // Generic social/web actions currently resolve to Computer Use first, but a
  // missing native driver must not strand a task that the authenticated
  // Agentlas Browser can safely complete. Explicit Computer Use selections
  // remain strict and never receive this browser fallback.
  const automaticHostDecision = input.toolMode == null || input.toolMode === "auto";

  // ── ① 프로젝트 우선 (project-first narrowing) ────────────────────────────
  // 프로젝트를 여는 이유는 그 안에 이미 갖춰 둔 것을 먼저 쓰라는 뜻이다. 그런데 이 선택기는
  // 프로젝트 턴에서도 Hub 카탈로그 전체(실측 140개)를 매 턴 판정기에 밀어 넣고 있었다.
  //
  // Hub 를 **잃는 것이 아니다**: `hephaestus-network` 는 항상 핀으로 붙어 있어서 모델이 정말
  // 필요할 때 런타임에 해소한다(agentlas_resolve_plugins). 여기서 빼는 것은 "미리 판정하기"뿐이다.
  // 그래서 프로젝트 턴에서는 Hub 인벤토리를 **가져오지도 않는다** — 5분 캐시가 비어 있을 때의
  // 8초 대기까지 함께 사라진다.
  const projectScoped = isExplicitProjectFolder(input.workingFolder);
  const offerHubToJudge = hubAllowed && !projectScoped;
  const hubInventory = await fetchHubPluginInventory(offerHubToJudge);

  // ── Pins: settings and explicit user choices. These are the ONLY tools that may be
  // attached without the resident judge, and none of them can raise a key prompt on its
  // own (the browser/CUA hosts are local, the Hub resolver has no env requirement).
  // Browser and Computer Use are EXACT host bindings. The competing host is never added —
  // not as a pin, not as a candidate, not as a quiet fallback. Missing host authority must
  // fail closed rather than silently drive a different surface.
  const blockedByHostBinding = (id: string): boolean => {
    if (effectiveToolMode === "browser") return id === "playwright" || id === "cua-driver";
    if (effectiveToolMode === "computer-use") return id === "playwright";
    return false;
  };

  // A same-capability peer that receives a host-injected channel makes this tool's
  // capability a strict subset (PLUGIN-SPEC §2.9). `playwright` is the live case: same
  // launcher, same Chrome profile, same 27 tools — but no AGENTLAS_BROWSER_APPROVAL_FILE,
  // so its requestApproval always lands on "denied" and it can never complete an
  // irreversible action. Offering it in auto mode lets judgment pick the strictly weaker
  // twin and then fail at the approval step for a reason the model was never told.
  //
  // ★The peer must actually be usable. Dropping the subset when its superset is missing or
  // disabled would delete the capability outright rather than upgrade it.
  const liveServerIds = new Set(
    initialInstalledServers
      .filter((server) => server.enabled)
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const pinnedReasons = new Map<string, string>();
  if (hubAllowed) {
    pinnedReasons.set("hephaestus-network", "always available routing/plugin resolver");
  }
  if (effectiveToolMode === "browser") {
    pinnedReasons.set("agentlas-browser", "Browser plugin (real-login CDP) for this automation");
  }
  if (effectiveToolMode === "computer-use") {
    pinnedReasons.set(
      "cua-driver",
      input.toolMode === "computer-use"
        ? "user-selected Computer Use for this automation"
        : "Agentlas policy selected Computer Use for human web/social automation",
    );
  }
  // Everything pinned so far is a host binding or the routing resolver — these outrank both
  // the judge's picks and the installed-convenience pins added next.
  const hostBindingPins = new Set(pinnedReasons.keys());
  // Anything the user already installed and enabled stays available every run. Dropping the
  // keyword scorer must never REMOVE a capability the user set up — it only stops unconfigured
  // tools from being force-attached. A pin here can still be dropped below if it turns out to
  // need a credential, so this can never produce a key prompt on its own.
  for (const server of initialInstalledServers) {
    if (!server.catalogId || !server.enabled) continue;
    if (server.catalogId === "brave-search"
      && runtimeCapabilities.nativeWebSearch === "available"
      && !(input.requiredToolCatalogIds ?? []).includes("brave-search")) continue;
    // `local-only` is an execution boundary, not merely a catalog filter. The
    // Network resolver starts the federated Workforce runtime and was being
    // re-attached as an installed convenience pin even after Hub routing had
    // been explicitly disabled. Besides violating the boundary, its cold
    // connection probe dominated ordinary One Team startup. One may opt into
    // Network on a later host-owned turn; local standing workers must not.
    if (server.catalogId === "hephaestus-network" && !hubAllowed) continue;
    // In automatic mode these are mutually exclusive host bindings, not
    // convenience tools. Leave them in the one resident judgment's candidate
    // menu instead of silently pinning both before the decision exists.
    if (
      automaticHostDecision
      && effectiveToolMode === "auto"
      && (server.catalogId === "agentlas-browser" || server.catalogId === "cua-driver" || server.catalogId === "playwright")
    ) continue;
    if (pinnedReasons.has(server.catalogId) || blockedByHostBinding(server.catalogId)) continue;
    pinnedReasons.set(server.catalogId, "already installed and enabled by the user");
  }

  const localCandidates: McpNeedCandidate[] = MCP_TOOL_CATALOG.filter((entry) => {
    if (pinnedReasons.has(entry.id) || blockedByHostBinding(entry.id)) return false;
    if (entry.id === "lazyweb") return false;
    // Codex/Claude/Antigravity already expose a native web-search tool. Keep
    // Brave available only when the user explicitly pins that exact MCP; an
    // optional catalog judge must never turn an ordinary research prompt into
    // a blocking API-key sheet when the active runtime can search itself.
    if (entry.id === "brave-search"
      && runtimeCapabilities.nativeWebSearch === "available"
      && !(input.requiredToolCatalogIds ?? []).includes("brave-search")) return false;
    if (entry.id === "hephaestus-network") return hubAllowed;
    return true;
  }).map((entry) => ({
    id: entry.id,
    name: entry.nameEn || entry.name,
    description: entry.descriptionEn || entry.description,
    origin: "local" as const,
    needsCredential: entry.envRequirements.some((requirement) => requirement.required),
  }));

  const hubOffered = hubInventory.listings.slice(0, HUB_PLUGIN_INVENTORY_LIMIT);
  const hubCandidates: McpNeedCandidate[] = hubOffered.map((listing) => ({
    id: listing.slug,
    name: listing.nameEn || listing.name || listing.slug,
    description: hubListingDescription(listing),
    origin: "hub" as const,
  }));

  // Offer one optional Browser surface. A vanilla custom Playwright launcher
  // otherwise wins the same need judgment and opens a second, unlinked page.
  // Exact assignments and configured servers retain their original identity.
  const requiredServerIds = new Set(input.requiredToolCatalogIds ?? []);
  const canonicalBrowserOffered = localCandidates.some((candidate) => candidate.id === "agentlas-browser")
    || pinnedReasons.has("agentlas-browser");
  const canonicalBrowserAvailable = canonicalBrowserOffered && initialInstalledServers.some((server) =>
    server.catalogId === "agentlas-browser" && server.enabled && server.configurationValid !== false,
  );
  const optionalBrowserDuplicates = new Set(initialInstalledServers
    .filter((server) => canonicalBrowserAvailable && !server.catalogId && !requiredServerIds.has(server.id)
      && isKeylessPlaywrightMcpDuplicate(server))
    .map((server) => server.id));

  // User-registered custom servers are inventory too, so an unconfigured one can be named by
  // the judge instead of prompting for its key on every unrelated run.
  const customCandidates: McpNeedCandidate[] = initialInstalledServers
    .filter((server) => !server.catalogId && !optionalBrowserDuplicates.has(server.id))
    .map((server) => ({
      id: server.id,
      name: server.nameEn || server.name,
      description: "user-registered custom MCP server",
      origin: "local" as const,
      needsCredential: server.envKeys.length > 0,
    }));

  // ONE judgment call decides the whole optional tool set — Hub entries offered first.
  const needsCandidates = [...hubCandidates, ...localCandidates, ...customCandidates];
  const needsCandidateCount = needsCandidates.length;
  const needs = await deps.resolveNeeds({
    task: taskText,
    candidates: needsCandidates,
    ...(activeGoalScope?.objective && activeGoalScope.acceptanceCriteria ? { goal: {
      objective: activeGoalScope.objective,
      acceptanceCriteria: activeGoalScope.acceptanceCriteria,
    } } : {}),
    runtimeCapabilities,
    signal: input.signal,
    timeoutMs: 15_000,
  });
  const neededIds = new Set(needs.needed);
  // Reuse only exact prior choices in the same still-active host scope. Inserting
  // IDs before normal resolution prevents carrying stale ready/credential states.
  if (goalScopeStillCurrent()) {
    for (const id of retainedIds) neededIds.add(id);
  } else retainedIds.clear();
  if (automaticHostDecision) {
    const choseBrowser = neededIds.has("agentlas-browser");
    const choseComputerUse = neededIds.has("cua-driver");
    if (choseBrowser) effectiveToolMode = "browser";
    else if (choseComputerUse) effectiveToolMode = "computer-use";
  }
  if (effectiveToolMode === "browser") {
    pinnedReasons.set("agentlas-browser", "Browser plugin (real-login CDP) selected for this run");
    hostBindingPins.add("agentlas-browser");
  } else if (effectiveToolMode === "computer-use") {
    pinnedReasons.set("cua-driver", "Computer Use selected for this run");
    hostBindingPins.add("cua-driver");
    if (input.toolMode == null) {
      pinnedReasons.set("agentlas-browser", "authenticated browser fallback for policy-selected Computer Use");
      hostBindingPins.add("agentlas-browser");
    }
  }
  const cappedHub = Math.max(0, hubInventory.listings.length - hubOffered.length);
  const needsNote = [
    needs.decided
      ? ""
      : "The optional-tool judgment did not return a selection. Only configured tools and revalidated selections from this active Goal are available.",
    cappedHub > 0 ? `${cappedHub} further Hub plugins were not offered to the selector this run.` : "",
    // 조용히 줄이지 않는다 — 왜 Hub 후보가 없는지 영수증에 남긴다.
    projectScoped && hubAllowed
      ? "Project-first: Hub plugins were not pre-judged this run because this is an initialized project folder. Hub stays reachable at runtime through hephaestus-network."
      : "",
    needs.omitted.length > 0 ? `${needs.omitted.length} candidates exceeded the selector inventory cap.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Rank before the probe cap so a convenience pin can never crowd out a host binding or a
  // capability the judge said the task actually needs.
  const pickRank = (id: string): number => {
    if (hostBindingPins.has(id)) return 0;
    if (neededIds.has(id)) return 1;
    return 2;
  };
  const picked = MCP_TOOL_CATALOG.filter((entry) => {
    if (!pinnedReasons.has(entry.id) && !neededIds.has(entry.id)) return false;
    if (blockedByHostBinding(entry.id)) return false;
    // An explicit pin is a settings-level decision and outranks this rule.
    {
      const peer = supersededByLivePeer({
        toolId: entry.id,
        pinned: pinnedReasons.has(entry.id),
        liveServerIds,
      });
      if (peer) {
        // Never drop something silently — a capability that vanished without a word reads
        // as "the tool did not exist" the next time someone debugs this.
        console.log(`[auto-select] dropped ${entry.id}: superseded by ${peer} (host channel)`);
        return false;
      }
    }
    return true;
  })
    .sort((a, b) => pickRank(a.id) - pickRank(b.id))
    .slice(0, 10);

  const resolved = await Promise.allSettled(picked.map(async (entry): Promise<AutoSelectedMcpTool> => {
    // `required` is a host binding, never a selection outcome — so it follows the mode the
    // **user** chose, not the mode this run's judgment landed on.
    //
    // 이 구분은 이미 아래 mayRequestCredentials 에 있었지만 여기에는 없었다. 드러나지 않은
    // 이유는 텍스트 판정으로 computer-use 가 되는 경로가 **한 번도 살아 있지 않았기 때문**이다
    // (peekJudgment 가 judge() 와 다른 구분자로 키를 만들어 영구 미스였다 — 같은 커밋에서 수리).
    // 그 경로가 살아나는 순간 정책이 고른 모드가 host binding 행세를 하게 된다.
    const required =
      input.toolMode === "browser" && entry.id === "agentlas-browser" ||
      input.toolMode === "computer-use" && entry.id === "cua-driver";
    const base = {
      id: entry.id,
      name: entry.nameEn || entry.name,
      reason:
        pinnedReasons.get(entry.id) ??
        (retainedIds.has(entry.id) && !needs.needed.includes(entry.id)
          ? "previous selection in this active Goal, revalidated for this run"
          : `resident judgment: ${needs.reason || "the task needs this capability"}`),
      required,
    };
    const missingEnv = await missingRequiredEnv(entry, deps.readEnvVar);
    if (missingEnv.length > 0) return { ...base, installed: false, missingEnv, state: "missing-key" };

    let server = deps.listInstalledServers().find((candidate) =>
      candidate.catalogId === entry.id || candidate.id === entry.id);
    if (!server && retainedIds.has(entry.id) && !needs.needed.includes(entry.id)) {
      return { ...base, installed: false, missingEnv: [], state: "server-unavailable" };
    }
    if (!server) {
      try {
        server = deps.installFromCatalog(entry.id);
        installed.add(entry.id);
        if (activeGoalScope && server) {
          // This selector may install its fresh choice. Accept only that exact
          // added row: changes/removals elsewhere still invalidate the binding.
          const afterInstall = deps.listInstalledServers();
          const added = afterInstall.filter((candidate) => candidate.id === server!.id);
          if (added.length === 1 && registryFingerprint(added) === registryFingerprint([server])
            && registryFingerprint(afterInstall.filter((candidate) => candidate.id !== server!.id)) === expectedInstalledFingerprint) {
            expectedInstalledFingerprint = registryFingerprint(afterInstall);
          }
        }
      } catch {
        return { ...base, installed: false, missingEnv: [], state: "install-failed" };
      }
    }
    if (!server) return { ...base, installed: false, missingEnv: [], state: "server-unavailable" };
    if (!server.enabled || server.configurationValid === false) return { ...base, installed: false, missingEnv: [], state: "disabled" };
    if (activeGoalScope) {
      const missingConfiguredEnv: string[] = [];
      for (const key of server.envKeys) if (!await deps.readEnvVar(key)) missingConfiguredEnv.push(key);
      if (missingConfiguredEnv.length) return { ...base, installed: false, missingEnv: missingConfiguredEnv, state: "missing-key" };
    }
    // 이 대화에서 방금 붙었던 서버는 다시 띄우지 않는다. **성공만** 기억한다.
    const probeKey = structuralKey ? `${structuralKey}\u0000${server.id}` : "";
    if (probeKey && !activeGoalScope) {
      const lastOk = probeMemo.get(probeKey);
      if (lastOk !== undefined && Date.now() - lastOk < SELECTION_MEMO_TTL_MS) {
        return { ...base, installed: true, missingEnv: [], state: "ready" };
      }
    }
    try {
      const status = await deps.testServerConnection(server, input.signal);
      if (status.missingEnv.length > 0) {
        return { ...base, installed: false, missingEnv: [...new Set(status.missingEnv)].sort(), state: "missing-key" };
      }
      if (!status.connected) return { ...base, installed: false, missingEnv: [], state: "probe-failed" };
    } catch {
      return { ...base, installed: false, missingEnv: [], state: "probe-failed" };
    }
    if (probeKey) memoSet(probeMemo, probeKey, Date.now());
    return { ...base, installed: true, missingEnv: [], state: "ready" };
  }));
  const result: AutoSelectedMcpTool[] = resolved.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    const entry = picked[index];
    return {
      id: entry.id,
      name: entry.nameEn || entry.name,
      reason: pinnedReasons.get(entry.id) ?? "resident judgment: the task needs this capability",
      installed: false,
      missingEnv: [],
      required: false,
      state: "host-failure",
    };
  });

  // ── THE INVARIANT ────────────────────────────────────────────────────────────
  // A credential prompt may exist ONLY for a tool the resident judge named, or one the user
  // bound to this automation by hand. Nothing else may ever reach "missing-key": that state
  // is what opens the pre-launch key sheet and stalls the run. A convenience pin that turns
  // out to need a key is dropped silently — the run continues without it.
  const mayRequestCredentials = (toolId: string): boolean =>
    neededIds.has(toolId) ||
    (input.toolMode === "browser" && toolId === "agentlas-browser") ||
    (input.toolMode === "computer-use" && toolId === "cua-driver");
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const tool = result[index];
    if (tool.state === "missing-key" && !mayRequestCredentials(tool.id)) result.splice(index, 1);
  }

  // 사용자가 손수 등록한 커스텀 MCP(카탈로그에 없는 catalogId=null)는 위 MCP_TOOL_CATALOG
  // 스캔에 잡히지 않아 채팅 런타임(.mcp.json)에서 늘 누락됐다 — 명시적으로 추가한 서버이므로
  // 항상 후보에 포함한다. remote(헤더 없는 URL)는 envKeys가 비어 바로 사용 가능하고,
  // 헤더/키가 필요한 서버는 vault에 값이 있을 때만 installed로 잡힌다.
  let latestInstalledServers: InstalledMcpServer[] = [];
  try {
    latestInstalledServers = deps.listInstalledServers();
  } catch {
    latestInstalledServers = [];
  }
  // Agentlas Browser is the authenticated host binding. A keyless custom
  // Playwright row is a structurally equivalent empty-profile launcher; even
  // probing it for inventory would start a second Chrome before mcp-config
  // gets a chance to collapse its declaration to the canonical server. Keep
  // explicit profiles/env and runs without this host binding untouched.
  const canonicalBrowserSelected =
    (effectiveToolMode === "browser" && pinnedReasons.has("agentlas-browser"))
    || input.requiredToolCatalogIds?.includes("agentlas-browser") === true;
  for (const server of latestInstalledServers) {
    if (server.catalogId) continue;
    if (!requiredServerIds.has(server.id)
      && (canonicalBrowserSelected || optionalBrowserDuplicates.has(server.id))
      && isKeylessPlaywrightMcpDuplicate(server)) continue;
    if (result.some((tool) => tool.id === server.id)) continue;
    const missingEnv: string[] = [];
    for (const key of server.envKeys) {
      const value = await deps.readEnvVar(key);
      if (!value) missingEnv.push(key);
    }
    let state: AutoSelectedMcpTool["state"] = missingEnv.length > 0 ? "missing-key" : "ready";
    if (state === "ready" && (!server.enabled || server.configurationValid === false)) state = "disabled";
    if (state === "ready") {
      try {
        const status = await deps.testServerConnection(server, input.signal);
        if (status.missingEnv.length > 0) {
          missingEnv.push(...status.missingEnv.filter((key) => !missingEnv.includes(key)));
          state = "missing-key";
        } else if (!status.connected) {
          state = "probe-failed";
        }
      } catch {
        state = "probe-failed";
      }
    }
    // Same invariant as the catalog pins: a custom server that is ready stays available, but
    // an unconfigured one only surfaces (and only asks for its key) when the task needs it.
    if (state === "missing-key" && !neededIds.has(server.id)) continue;
    result.push({
      id: server.id,
      name: server.nameEn || server.name,
      reason: "user-added custom MCP (always available)",
      installed: state === "ready",
      missingEnv,
      required: false,
      state,
    });
  }

  // Hub candidates are the plugins the resident judge named — never a word-scored guess.
  // Undecided runs surface none and let the model resolve plugins live through
  // agentlas_resolve_plugins / hephaestus-network instead.
  const hubPlugins: HubPluginCandidate[] = hubOffered
    .filter((listing) => neededIds.has(listing.slug))
    .slice(0, HUB_PLUGIN_CANDIDATE_LIMIT)
    .map((listing) => ({
      slug: listing.slug,
      name: listing.nameEn || listing.name || listing.slug,
      reason: `resident judgment: ${needs.reason || "the task needs this plugin"}`,
      installCli: listing.installCli,
      manifestUrl: listing.manifestUrl || listing.detailUrl,
      category: listing.category,
      score: 100,
    }));

  // 이미 이 기계에 붙어 있고 켜기만 하면 되는 것 — 새 설치를 권하기 전에 알려야 한다.
  // 조회 실패는 이 실행을 막지 않는다(고지가 한 줄 짧아질 뿐).
  let pendingApprovalTools: string[] = [];
  try {
    pendingApprovalTools = listPendingHubPluginApprovals().map(
      (row) => `${row.slug} (${[row.command, ...row.args].filter(Boolean).join(" ")})`,
    );
  } catch {
    pendingApprovalTools = [];
  }

  // Connection probes await external work. Close the binding/configuration race
  // again before any retained-only capability reaches the runtime config.
  if (retainedIds.size && !goalScopeStillCurrent()) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (retainedIds.has(result[index].id) && !needs.needed.includes(result[index].id)) result.splice(index, 1);
    }
  }
  const finalReceiptScope = receiptScope && goalScopeStillCurrent() ? { ...receiptScope,
    scopeHash: createHash("sha256").update(goalScopeKeyFor(expectedInstalledFingerprint)).digest("hex"),
  } : null;
  const dispatchIds = new Set(result.filter((tool) => tool.state === "ready").map((tool) => tool.id));
  const dispatchFingerprint = (): string => registryFingerprint(deps.listInstalledServers()
    .filter((server) => dispatchIds.has(server.id) || (server.catalogId && dispatchIds.has(server.catalogId))));
  const selectedServerFingerprint = dispatchFingerprint();
  const context: AutoSelectedMcpContext = {
    ...(finalReceiptScope ? { goalSelectionScope: finalReceiptScope } : {}),
    ...(activeGoalScope ? { goalSelectionIsCurrent: () => Boolean(finalReceiptScope)
      && goalBindingStillCurrent() && dispatchFingerprint() === selectedServerFingerprint } : {}),
    effectiveToolMode,
    tools: result,
    localInventory,
    localPluginCount: localInventory.length,
    hubPluginCount: hubInventory.hubPluginCount,
    hubPlugins,
    ...(pendingApprovalTools.length > 0 ? { pendingApprovalTools } : {}),
    needsDecided: needs.decided,
    needsOutcome: { decided: needs.decided, candidateCount: needsCandidateCount, reason: needs.reason },
    ...(needsNote ? { needsNote } : {}),
    ...(hubInventory.hubPluginError ? { hubPluginError: hubInventory.hubPluginError } : {}),
  };
  // ── sticky 합집합 병합 — 같은 대화의 도구셋은 넓어지기만 한다(캐시 보존) ──
  if (goalScopeKey && conversationId && goalScopeStillCurrent()) {
    const selectedIds = context.tools.filter((tool) => neededIds.has(tool.id) && tool.state === "ready").map((tool) => tool.id);
    const finalGoalScopeKey = goalScopeKeyFor(expectedInstalledFingerprint);
    memoSet(goalSelectionMemo, conversationId, { scopeKey: finalGoalScopeKey, selectedIds });
    if (receiptScope && input.writeGoalSelection) {
      // Persistence is a selection hint, not a prerequisite for this tool run.
      try { input.writeGoalSelection({ ...receiptScope,
        scopeHash: createHash("sha256").update(finalGoalScopeKey).digest("hex"), selectedIds }); } catch { /* No durable hint was saved. */ }
    }
  }
  if (!activeGoalScope && structuralKey && needs.decided) {
    const sticky = stickySelectionMemo.get(structuralKey);
    if (sticky && Date.now() - sticky.at <= STICKY_SELECTION_TTL_MS) {
      const freshIds = new Set(context.tools.map((tool) => tool.id));
      const carried = sticky.context.tools
        .filter((tool) => !freshIds.has(tool.id))
        .map((tool) => ({ ...tool, missingEnv: [...tool.missingEnv] }));
      if (carried.length > 0) context.tools = [...context.tools, ...carried];
    }
    memoSet(stickySelectionMemo, structuralKey, { context: cloneContext(context), at: Date.now() });
  }
  // 모델이 못 닿아 아무것도 못 정한 실행은 기억하지 않는다 — 그 침묵을 다음 턴까지 굳히면 안 된다.
  if (!activeGoalScope && memoKey && needs.decided) memoSet(selectionMemo, memoKey, { context: cloneContext(context), at: Date.now() });
  return context;
}

export function buildMcpAutoSelectionPrompt(
  selected: AutoSelectedMcpContext,
  opts?: { toolMode?: AutomationToolMode; hubMode?: AutomationHubMode },
): string {
  // 붙은 도구가 없을 때 침묵하지 않는다. 이전에는 여기서 빈 문자열을 반환해, 도구가
  // 하나도 없는 실행에 **아무 안내도 나가지 않았다** — 도구가 없다는 사실 자체가
  // 에이전트가 알아야 할 정보이고, 그때가 바로 설치를 권해야 하는 순간이다.
  // 공통 고지는 표면 무관하게 shared/tool-access-notice.ts가 만든다.
  const installed = selected.tools.filter((tool) => tool.installed);
  const blocked = selected.tools.filter((tool) => !tool.installed && tool.missingEnv.length > 0);
  const unavailable = selected.tools.filter((tool) => tool.state !== "ready");
  const browserReady = installed.some((tool) => tool.id === "agentlas-browser");
  const computerUseSelected = selected.tools.some((tool) => tool.id === "cua-driver");
  const computerUseReady = installed.some((tool) => tool.id === "cua-driver");
  const modeLine =
    opts?.toolMode === "browser"
      ? "This automation is bound to Agentlas Browser (real-login CDP). Use only that browser host for web work; never create a fresh Playwright profile."
      : opts?.toolMode === "computer-use"
        ? "This automation explicitly selected Computer Use mode; use desktop/screen tools for UI work."
        : "";
  const hubLine =
    opts?.hubMode === "hub-first"
      ? "This automation is Hub-first: prefer Agentlas Hub specialists/plugins through hephaestus-network before local fallbacks."
      : opts?.hubMode === "hub-allowed"
        ? "This automation may use Agentlas Hub specialists/plugins through hephaestus-network when local tools are insufficient."
        : opts?.hubMode === "local-only"
          ? "This automation is local-only: do not use Agentlas Hub routing or borrowed Hub agents."
          : "";
  const hubCandidates =
    selected.hubPlugins.length > 0
      ? `Relevant Hub plugin candidates: ${selected.hubPlugins
          .map((plugin) =>
            `${plugin.slug} (${plugin.name}; ${plugin.reason}${plugin.installCli ? `; install: ${plugin.installCli}` : ""})`,
          )
          .join("; ")}.`
      : selected.hubPluginCount > 0
        ? "Hub plugin catalog is available; resolve plugin needs dynamically before declaring a tool unavailable."
        : selected.hubPluginError
          ? `Hub plugin catalog lookup failed for this run: ${selected.hubPluginError}.`
          : "";
  const inventoryPreview = selected.localInventory.slice(0, 24).join(", ");
  const inventoryMore = selected.localInventory.length > 24 ? `, +${selected.localInventory.length - 24} more` : "";
  return [
    "Agentlas MCP plugin auto-selection is active.",
    `Agentlas plugin universe is active: ${selected.localPluginCount} local plugin/tool entries + ${selected.hubPluginCount} Hub plugins.`,
    modeLine,
    hubLine,
    computerUseReady
      ? "Computer Use is available for desktop/screen interaction. Prefer Agentlas Browser for authenticated web pages when both tools can complete the task."
      : computerUseSelected && browserReady
        ? "The native Computer Use driver is unavailable in this run. Do not claim OS-level control; use Agentlas Browser only for work that stays inside the authenticated browser."
        : computerUseSelected
          ? "The native Computer Use driver is unavailable in this run. Do not claim screen interaction or OS-level control."
          : "",
    selected.localInventory.length > 0
      ? `Local inventory for Hub plugin resolution: ${inventoryPreview}${inventoryMore}.`
      : "",
    selected.needsNote ? `Tool selection note: ${selected.needsNote}` : "",
    hubCandidates,
    "Use the available MCP tools directly when they are relevant. Do not ask the user to install a tool that is already listed as available.",
    // 표면 공통 고지 — 붙은 도구·승인 대기·Hub 조회 가능 여부·설치 경계를 한 벌로 낸다.
    // 터미널과 OS 플러그인이 같은 문장을 쓰므로, 여기서만 문구를 바꾸면 안 된다.
    buildToolAccessNotice({
      availableTools: installed.map((tool) => `${tool.id} (${tool.name})`),
      blockedTools: blocked.map((tool) => `${tool.id} missing ${tool.missingEnv.join(", ")}`),
      pendingApprovalTools: selected.pendingApprovalTools ?? [],
      hubCatalogAvailable: selected.hubPluginCount > 0 && !selected.hubPluginError,
      hubCatalogError: selected.hubPluginError ?? null,
    }),
    "Only ask the user when the selected Hub plugin requires login, OAuth, credentials, paid/credit approval, or a macOS/browser permission. Include the exact plugin slug or install command in that question.",
    unavailable.length > 0
      ? `Unavailable MCP state (value-free): ${unavailable
          .map((tool) => `${tool.id}=${tool.state}${tool.required ? "(required)" : ""}`)
          .join("; ")}. Healthy MCPs remain available; degrade only the function that depends on an unavailable capability.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
