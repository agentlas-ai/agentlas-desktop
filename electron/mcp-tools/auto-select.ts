import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  resolveMcpNeeds,
  type McpGoalNeedContext,
  type McpNeedCandidate,
  type McpRuntimeCapabilities,
  type McpTaskContext,
  type ResolvedMcpNeeds,
} from "./need-resolver";
import os from "node:os";
import path from "node:path";
import { pluginSlugForToolId, supersededByLivePeer } from "../plugins/builtin";
import { MCP_TOOL_CATALOG } from "./catalog";
import { installFromCatalog, listInstalledServers } from "./registry";
import { testServerConnection, requiredMcpManualEnvKeys } from "./client";
import { resolveMcpOAuthAccessToken } from "./oauth";
import { vaultUrlKey } from "../opencrab/constants";
import { credentialVaultKey } from "./credential-refs";
import { readEnvVarAliased as readEnvVar } from "../secrets/env-alias";
import { KeychainUnavailableError } from "../secrets/keychain-host";
import { getSource as getMarketSource } from "../marketplace";
import { listBundledHubPlugins } from "../../shared/bundled-hub-catalog";
import { resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import { listPendingHubPluginApprovals } from "./hub-plugin-bridge";
import { judgedComputerUse } from "../system-agents/judged-tool-mode";
import { isKeylessPlaywrightMcpDuplicate } from "./mcp-config";
import {
  listInstalledPluginCandidates,
  pluginCandidateId,
  pluginSlugFromCandidateId,
  type InstalledPluginCandidate,
} from "../plugins/plugin-candidates";
import { hasExplicitMention, selectedPluginRouterPrompt } from "../plugins/router-prompt";
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
  /** Exact value-free observation from the invocation's owned prepared binding. */
  connectionOutcome?: import("../one/one-original-mcp-credential").OneMcpScopedOutcome;
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

/**
 * Typed run-record code: a selection chose the Agentlas Browser, the owner did not bind it, and its host was not ready,
 * so the run continued without the browser (need-resolver: the judge must never block the run). Only an owner binding
 * (toolMode "browser", an explicit catalog assignment, an @mention of the plugin) keeps the before-model refusal.
 */
export const AGENTLAS_BROWSER_WITHDRAWN_CODE = "agentlas-browser-host-unavailable-continued-without-browser";

/** An installed plugin the relevance routing attached to this turn (skills inlined, tools attached). */
/** Catalog id of the One Team tool set (plugin agentlas-one-team). */
export const ONE_TEAM_BASELINE_TOOL_ID = "one-team";

export interface RoutedPluginSelection {
  slug: string;
  name: string;
  reason: string;
  /** judge = resident judgment; local-relevance = deterministic fallback; retained = same active Goal;
   *  requested = the model asked for it in the previous turn of this conversation;
   *  baseline = the host always carries it for this kind of conversation (group room: One Team). */
  source: "judge" | "local-relevance" | "retained" | "requested" | "baseline";
  hasSkills: boolean;
  toolIds: string[];
  /** A declared workflow of the plugin the owner asked for from a button or menu (plugins/owner-capability-request.ts). */
  workflow?: string;
}

export interface AutoSelectedMcpContext {
  /** Main-only scope for a provided-credentials retry in this invocation. */
  goalSelectionScope?: Omit<GoalToolSelectionReceipt, "selectedIds">;
  /** Main-only dispatch guard; never serialized into a selection receipt. */
  goalSelectionIsCurrent?: () => boolean;
  /** Main-computed host binding after exact product-name and judgment rules. */
  effectiveToolMode: AutomationToolMode;
  /**
   * The Browser host binding a selection (not the owner) chose, withdrawn because that host was not ready: this run
   * proceeds without the browser instead of being refused. Value-free; the run record and a tool-use event carry it.
   */
  hostBindingWithdrawn?: {
    code: typeof AGENTLAS_BROWSER_WITHDRAWN_CODE;
    host: "agentlas-browser";
    state: AutoSelectedMcpTool["state"] | "not-selected";
    /** judge = this turn's judgment; carried = an earlier choice in this Goal/conversation (retained or agent-requested). */
    selectedBy: "judge" | "carried";
  };
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
  /** Installed plugins routed to this turn. Their router text is inlined in the turn context. */
  routedPlugins?: RoutedPluginSelection[];
  /** Who chose the optional set: the judge, the deterministic fallback, or nobody. */
  selectionSource?: "judge" | "local-relevance" | "none";
  /** Value-free note: nothing was decided, or the candidate inventory was capped (receipt; not prompt text). */
  needsNote?: string;
  /** Hub plugins left off this run's shelf; the prompt names only this count (harness_search finds them). */
  hubNotOffered?: number;
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
  resolveOAuthAccessToken: (serverId: string, serverUrl?: string) => Promise<string | null>;
  testServerConnection: (server: InstalledMcpServer, signal?: AbortSignal) => Promise<{
    connected: boolean;
    missingEnv: string[];
  }>;
  /** Main's current original-run selection and prepared proxy probe. A saved
   * reference alone is not a connection; scoped failures never read global env. */
  probeScopedServer?: (server: InstalledMcpServer, signal?: AbortSignal) => Promise<
    { route: "legacy" } | { route: "scoped"; available: boolean; connected: boolean;
      outcome?: import("../one/one-original-mcp-credential").OneMcpScopedOutcome }
  >;
  /** The only thing allowed to pick an optional tool. Injectable so tests can pin a verdict. */
  resolveNeeds: (input: {
    task: string;
    taskContext?: McpTaskContext;
    candidates: McpNeedCandidate[];
    goal?: McpGoalNeedContext;
    runtimeCapabilities?: McpRuntimeCapabilities;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<ResolvedMcpNeeds>;
  /** Installed plugin manifests as routing candidates (injectable for isolated tests). */
  listPluginCandidates: () => InstalledPluginCandidate[];
}

async function scopedServerProbe(
  server: InstalledMcpServer, deps: AutoSelectMcpDependencies, signal?: AbortSignal,
): Promise<{ route: "scoped"; available: boolean; connected: boolean;
  outcome?: import("../one/one-original-mcp-credential").OneMcpScopedOutcome } | null> {
  if (!deps.probeScopedServer) return null;
  try {
    const result = await deps.probeScopedServer(server, signal);
    if (result?.route === "legacy") return null;
    if (result?.route === "scoped" && typeof result.available === "boolean"
      && typeof result.connected === "boolean") {
      if (result.outcome === undefined) return { route: "scoped", available: result.available, connected: result.connected };
      const outcome = result.outcome;
      if (outcome.retryAllowed !== false) throw new Error("invalid_scoped_outcome");
      if (outcome.kind === "outcome-unknown" && Object.keys(outcome).sort().join("|") === "kind|retryAllowed") {
        return { route: "scoped", available: false, connected: false, outcome: Object.freeze({ kind: outcome.kind, retryAllowed: false }) };
      }
      if (outcome.kind === "http-rejected" && Object.keys(outcome).sort().join("|") === "category|kind|retryAllowed|status"
        && Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599) {
        const category = outcome.status === 401 ? "authentication" : outcome.status === 403 ? "permission"
          : outcome.status === 402 ? "billing" : outcome.status === 429 ? "quota" : "http";
        if (outcome.category !== category) throw new Error("invalid_scoped_outcome");
        return { route: "scoped", available: false, connected: false,
          outcome: Object.freeze({ kind: outcome.kind, status: outcome.status, category, retryAllowed: false }) };
      }
    }
  } catch { /* A failed native resolver is unavailable, never a legacy grant. */ }
  return { route: "scoped", available: false, connected: false };
}

/** Translate only machine-checked observations. Remote bodies and error prose
 * never enter this user/model receipt, and an unknown result is not resubmitted. */
export function describeScopedMcpOutcome(outcome: NonNullable<AutoSelectedMcpTool["connectionOutcome"]>, locale: string): string {
  if (outcome.kind === "outcome-unknown") return locale.startsWith("ko")
    ? "전송 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다."
    : "The request outcome is unknown. No automatic retry.";
  const labels = locale.startsWith("ko")
    ? { authentication: "제공자가 인증을 거부했습니다", permission: "제공자가 요청 권한을 거부했습니다",
      billing: "제공자가 결제 오류를 반환했습니다", quota: "제공자가 요청 한도 오류를 반환했습니다", http: "제공자가 연결 오류를 반환했습니다" }
    : { authentication: "The provider rejected authentication", permission: "The provider rejected request permission",
      billing: "The provider returned a billing error", quota: "The provider returned a request-limit error", http: "The provider returned a connection error" };
  return `${labels[outcome.category]} (HTTP ${outcome.status}). ${locale.startsWith("ko") ? "자동으로 다시 보내지 않습니다." : "No automatic retry."}`;
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
  resolveOAuthAccessToken: resolveMcpOAuthAccessToken,
  // The browser host may need to open Chrome and attach over CDP on its first
  // run. Three seconds was shorter than a warm local probe and made clean
  // installs look unavailable before the bundled host could answer tools/list.
  testServerConnection: (server, signal) => testServerConnection(server, {
    signal,
    // A missing uv runtime is provisioned inside this same cancellable deadline.
    timeoutMs: server.command === "uvx" || server.command === "uv"
      ? 45_000
      : server.catalogId === "agentlas-browser" || server.catalogId === "playwright" ? 20_000 : 12_000,
  }),
  resolveNeeds: resolveMcpNeeds,
  listPluginCandidates: () => listInstalledPluginCandidates(),
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
/** Project turns keep local-first: a shorter Hub shelf for the same single judgment. */
const HUB_PLUGIN_PROJECT_INVENTORY_LIMIT = 20;

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

/**
 * Read one of this connection's keys where the runtime reads it (credential-refs.ts, NH29). A connection that owns its
 * key keeps it under its own Vault key; a same-named global key is a different account and never stands in for it.
 * Every presence check below goes through here, so selection and the run config agree on "missing".
 */
function readServerEnv(server: InstalledMcpServer, key: string, deps: AutoSelectMcpDependencies): Promise<string | null> {
  return deps.readEnvVar(credentialVaultKey(server, key));
}

async function serverHasOAuth(server: InstalledMcpServer, deps: AutoSelectMcpDependencies): Promise<boolean> {
  if (server.transport === "stdio" || !server.url) return false;
  const endpointKey = vaultUrlKey(server.url);
  const endpoint = endpointKey ? await readServerEnv(server, endpointKey, deps) : server.url;
  return endpoint ? Boolean(await deps.resolveOAuthAccessToken(server.id, endpoint)) : false;
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
// 60분: 프롬프트 캐시 1시간 수명과 같다 — 그보다 먼저 도구셋이 줄면 살아 있는 캐시를 스스로 깨게 된다.
const STICKY_SELECTION_TTL_MS = 60 * 60_000;
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
    ...(context.routedPlugins ? { routedPlugins: context.routedPlugins.map((plugin) => ({ ...plugin, toolIds: [...plugin.toolIds] })) } : {}),
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
    // The search merges the bundled catalog (113 rows) ahead of live Hub rows, and the judge is offered only the
    // first HUB_PLUGIN_INVENTORY_LIMIT, so a plugin published to the Hub after this build was never offered.
    // Hub-only plugins go first; the order is otherwise kept.
    const bundled = new Set(listBundledHubPlugins().map((row) => row.slug.toLowerCase()));
    const plugins = listings.filter(isHubPluginListing);
    plugins.sort((a, b) => Number(bundled.has(a.slug.toLowerCase())) - Number(bundled.has(b.slug.toLowerCase())));
    return { listings: plugins, hubPluginCount: plugins.length };
  } catch (err) {
    const bundled = listBundledHubPlugins();
    return {
      listings: bundled,
      hubPluginCount: bundled.length,
      hubPluginError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A selection can outlive its Goal by seconds: the resident judgment alone takes ~8s. */
export const GOAL_SCOPE_RESELECTION_LIMIT = 2;

/**
 * Run a selection until the Goal binding it was made under is still the Goal binding.
 *
 * A selection reads the chat's active Goal first and judges tool needs afterwards (seconds). The Goal can end or be
 * revised in that window without anything being wrong: the previous turn's background verifier settles the Goal
 * `verifying -> completed` while the owner's next message is already preparing, or an owner amendment lands as a new
 * revision. The selection's own `goalSelectionIsCurrent` then turns false, and the dispatch guard used to fail the
 * whole turn (`mcp_goal_tool_scope_changed`, 2026-10-17: a second message after a finished task never ran, while the same
 * request in a fresh chat did). The Goal's authority is read again instead: an ended Goal no longer scopes the turn
 * (a plain selection), a revised one scopes it under its new revision. A binding that keeps moving through every
 * allowed re-read is real churn, and that last context is returned as is so the dispatch guard still stops the run.
 */
export async function selectUntilGoalScopeSettled(
  select: () => Promise<AutoSelectedMcpContext>,
  opts: { limit?: number; onReselect?: (attempt: number) => void } = {},
): Promise<AutoSelectedMcpContext> {
  const limit = opts.limit ?? GOAL_SCOPE_RESELECTION_LIMIT;
  let context = await select();
  for (let attempt = 1; attempt <= limit && context.goalSelectionIsCurrent && !context.goalSelectionIsCurrent(); attempt += 1) {
    opts.onReselect?.(attempt);
    context = await select();
  }
  return context;
}

export async function autoSelectMcpTools(input: {
  userPrompt: string;
  systemPrompt: string;
  agentName: string;
  workingFolder?: string | null;
  /** Capabilities proven by Main for this exact invocation. Missing means unknown. */
  runtimeCapabilities?: McpRuntimeCapabilities;
  /**
   * The runtime's own config would expose an outside browser (e.g. the owner's
   * Codex `playwright` server) to this run. Capability priority then attaches
   * the Agentlas browser so the outside one is closed instead of used.
   */
  runtimeOutsideBrowser?: boolean;
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
  /**
   * The conversation is a One group room (a taskforce seat). A group room is a team by
   * definition, so every turn, goal passes included, carries the One Team tool set without
   * the model having to request it first (production 2026-10-10 04:57-07:00: goal passes only
   * retained earlier requests and ran without it). Main-derived from the stored seat, never
   * from renderer input; the control capability still enforces who may dispatch.
   */
  groupRoom?: boolean;
  /**
   * The conversation is Agentlas Finance: a Work chat of the signed-in owner's Finance project. The Finance plugin is a baseline
   * capability there, so its router rides every turn without an @finance mention (an ordinary question otherwise never reaches
   * the finance.* operations). Main-derived from the stored project binding (assertFinanceWorkChatOwner), never from renderer input.
   */
  /** Plugins the conversation's project binding attaches on every turn, with their routing reason (Main-derived). */
  projectBaselinePlugins?: readonly { readonly slug: string; readonly reason: string }[];
  /**
   * The run is a teammate working on a hand-off from a group room (Main-derived from the dispatch row). It carries
   * One Team's room_say tool only: no router text is inlined, and the control capability offers nothing else.
   */
  roomMember?: boolean;
  /** Installed MCP ids declared by the bound One Team member when auto mode is off. */
  fixedServerIds?: string[];
  /** Graph-declared tool ids; canonical browser declarations suppress duplicate probing. */
  requiredToolCatalogIds?: string[];
  /**
   * Installed plugin slugs the model asked for during the previous turn of this
   * conversation (agentlas_resolve_plugins / tool_search result, or opening the
   * plugin's router). Main-derived from tool events, never from renderer input.
   * Only already-installed plugins are honoured; Hub installs keep the owner gate.
   */
  requestedPluginSlugs?: string[];
  /** A plugin workflow the owner's own gesture asked this turn to carry (plugins/owner-capability-request.ts). Main-read typed data. */
  ownerRequestedWorkflows?: ReadonlyArray<{ plugin: string; workflow: string }>;
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
  let pluginCandidates: InstalledPluginCandidate[] = [];
  try { pluginCandidates = deps.listPluginCandidates(); } catch { pluginCandidates = []; }
  const pluginBySlug = new Map(pluginCandidates.map((plugin) => [plugin.slug, plugin]));
  const pluginFingerprint = shortHash(pluginCandidates.map((plugin) => `${plugin.slug}:${plugin.toolIds.join(",")}`).join("|"));
  let expectedInstalledFingerprint = installedFingerprint;
  if (input.bypassSelectionMemo) invalidateMcpSelectionMemo();
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  const structuralKeyFor = (fingerprint: string): string => conversationId
    ? [conversationId, input.toolMode ?? "auto", input.hubMode ?? "auto", runtimeCapabilities.nativeBrowser,
      input.runtimeOutsideBrowser === true ? "outside-browser" : "", input.groupRoom === true ? "group-room" : "", (input.projectBaselinePlugins ?? []).map((plugin) => `project-baseline:${plugin.slug}`).sort().join("+"), input.roomMember === true ? "room-member" : "", fingerprint, [...(input.requiredToolCatalogIds ?? [])].sort().join(","), pluginFingerprint].join("\u0000")
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
  const requestedPluginSlugs = [...new Set((input.requestedPluginSlugs ?? []).filter((slug) => pluginBySlug.has(slug)))].sort();
  const ownerWorkflows = (input.ownerRequestedWorkflows ?? []).filter((row) => pluginBySlug.has(row.plugin));
  const memoKey = structuralKey ? `${structuralKey}\u0000${shortHash(taskText)}\u0000${requestedPluginSlugs.join(",")}\u0000${ownerWorkflows.map((row) => `${row.plugin}/${row.workflow}`).join(",")}` : "";
  if (memoKey && !activeGoalScope) {
    const hit = selectionMemo.get(memoKey);
    const selectedRemote = hit && initialInstalledServers.some(server => server.transport !== "stdio"
      && hit.context.tools.some(tool => tool.id === server.id || tool.id === server.catalogId));
    if (hit && !selectedRemote && Date.now() - hit.at < SELECTION_MEMO_TTL_MS) return cloneContext(hit.context);
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
  /*
   * Owner rule 2026-10-13: the host never decides the browser/computer-use surface from words
   * in the request or the Goal objective. A URL, domain or "in the browser" phrase is only a
   * typed target the model reads; the surface comes from (1) the owner's explicit binding
   * (input.toolMode / automation toolMode / graph tool node) or (2) the model's structured
   * selection below (resolveNeeds -> agentlas-browser / cua-driver in neededIds). When neither
   * speaks, the mode stays neutral "auto" — there is no lexical fallback.
   */

  // ── ① 프로젝트 우선 (project-first narrowing) ────────────────────────────
  // 프로젝트를 여는 이유는 그 안에 이미 갖춰 둔 것을 먼저 쓰라는 뜻이다. 그런데 이 선택기는
  // 프로젝트 턴에서도 Hub 카탈로그 전체(실측 140개)를 매 턴 판정기에 밀어 넣고 있었다.
  //
  // Hub 를 **잃는 것이 아니다**: `hephaestus-network` 는 항상 핀으로 붙어 있어서 모델이 정말
  // 필요할 때 런타임에 해소한다(agentlas_resolve_plugins). 여기서 빼는 것은 "미리 판정하기"뿐이다.
  // 그래서 프로젝트 턴에서는 Hub 인벤토리를 **가져오지도 않는다** — 5분 캐시가 비어 있을 때의
  // 8초 대기까지 함께 사라진다.
  const projectScoped = isExplicitProjectFolder(input.workingFolder);
  // ★Owner 2026-09-23: plugin search is routing too. A project turn still sees a
  // capped Hub shelf (suggestions only — nothing from the Hub is installed without
  // the owner's approval); local plugins and installed tools stay first.
  const offerHubToJudge = hubAllowed;
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
  // Host bindings and the routing resolver outrank optional capabilities.
  const hostBindingPins = new Set(pinnedReasons.keys());
  // Installed integrations remain eligible in the resident judge's menu. Only
  // host bindings, explicit requests and the active Goal are pinned; enabling a
  // hundred catalog entries must not attach a hundred servers to every turn.

  const pluginToolIds = new Set(pluginCandidates.flatMap((plugin) => plugin.toolIds));
  // Capability priority (owner 2026-09-24): built-in and Agentlas-published providers
  // are marked so the judge and the dedupe prefer them over an outside equivalent.
  const agentlasToolIds = new Set(pluginCandidates.filter((plugin) => plugin.agentlas).flatMap((plugin) => plugin.toolIds));
  const isAgentlasTool = (id: string): boolean => agentlasToolIds.has(id) || pluginSlugForToolId(id) !== null;
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
  }).map((entry) => {
    const needsCredential = entry.envRequirements.some((requirement) => requirement.required);
    return {
      id: entry.id,
      name: entry.nameEn || entry.name,
      description: entry.descriptionEn || entry.description,
      origin: "local" as const,
      needsCredential,
      ...(isAgentlasTool(entry.id) ? { agentlas: true } : {}),
      // A tool shipped by an installed plugin is the owner's own choice; the
      // deterministic fallback may attach it when it is credential-free.
      ...(!needsCredential && pluginToolIds.has(entry.id) ? { fallbackEligible: true } : {}),
    };
  });

  const hubOffered = hubInventory.listings.slice(0, projectScoped ? HUB_PLUGIN_PROJECT_INVENTORY_LIMIT : HUB_PLUGIN_INVENTORY_LIMIT);
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

  // Installed plugins that ship skills are first-class candidates next to MCP tools.
  // Built from each manifest — no per-plugin table. implicit:"never" plugins stay
  // unmentioned unless the user names them.
  // Only an explicit whole-token `@mention` selects (router-prompt.hasExplicitMention);
  // a substring of another word, quoted text or code never does.
  const mentionedPlugin = (plugin: InstalledPluginCandidate): boolean => hasExplicitMention(input.userPrompt, plugin.mention);
  const skillCandidates: McpNeedCandidate[] = pluginCandidates
    .filter((plugin) => plugin.hasSkills && (plugin.implicit !== "never" || mentionedPlugin(plugin)))
    .map((plugin) => ({
      id: pluginCandidateId(plugin.slug),
      name: plugin.name,
      description: plugin.description,
      origin: "local" as const,
      kind: "skill-plugin" as const,
      fallbackEligible: true,
      ...(plugin.agentlas ? { agentlas: true } : {}),
    }));

  // ONE judgment call decides the whole optional tool set — Hub entries offered first.
  const needsCandidates = [...hubCandidates, ...localCandidates, ...customCandidates, ...skillCandidates];
  const needsCandidateCount = needsCandidates.length;
  const needs = await deps.resolveNeeds({
    // The judge reads this turn's request on its own; agent name, folder and the
    // standing system prompt travel as separate background (see McpTaskContext).
    task: input.userPrompt,
    taskContext: {
      agentName: input.agentName,
      workingFolder: input.workingFolder ?? null,
      agentInstructions: input.systemPrompt,
    },
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
  const explicitlyAssignedIds = new Set<string>();
  for (const id of requiredServerIds) {
    const server = initialInstalledServers.find((candidate) => candidate.id === id || candidate.catalogId === id);
    const selectedId = server?.catalogId || server?.id || id;
    neededIds.add(selectedId);
    explicitlyAssignedIds.add(selectedId);
    pinnedReasons.set(selectedId, "explicitly assigned to this run");
  }
  // ── Deterministic fallback — selection must never be empty merely because the
  // judge timed out or could not run. Same candidates, local relevance only, and
  // only installed credential-free entries: no install, no key prompt, no change
  // of the browser/computer-use host binding. An unrelated task selects nothing.
  // Coordinator decision 2026-09-29 (soak 1.2.50): an undecided judgment falls back to the
  // baseline set only (below), never to local-relevance guesses — those attached
  // science-statistics and research-director to a YouTube metrics teammate.
  const selectionSource = (needs.decided ? "judge" : "none") as "judge" | "local-relevance" | "none";
  const fallbackIds: string[] = [];
  // Reuse only exact prior choices in the same still-active host scope. Inserting
  // IDs before normal resolution prevents carrying stale ready/credential states.
  if (goalScopeStillCurrent()) {
    for (const id of retainedIds) neededIds.add(id);
  } else retainedIds.clear();

  // ── Routed plugins: skills inlined for this turn, the plugin's own tools attached with them.
  const routedPlugins: RoutedPluginSelection[] = [];
  const routePlugin = (slug: string, source: RoutedPluginSelection["source"], reason: string, workflow?: string): void => {
    const plugin = pluginBySlug.get(slug);
    if (!plugin || routedPlugins.some((routed) => routed.slug === slug)) return;
    routedPlugins.push({ slug, name: plugin.name, reason, source, hasSkills: plugin.hasSkills, toolIds: [...plugin.toolIds], ...(workflow ? { workflow } : {}) });
    for (const toolId of plugin.toolIds) {
      const entry = MCP_TOOL_CATALOG.find((candidate) => candidate.id === toolId);
      if (!entry || blockedByHostBinding(toolId)) continue;
      // A tool that needs a key may prompt only when the judge itself chose its plugin.
      if (source !== "judge" && entry.envRequirements.some((requirement) => requirement.required)) continue;
      neededIds.add(toolId);
    }
  };
  // The owner's gesture is the strongest signal of this turn: it routes first, with the workflow it named.
  for (const row of ownerWorkflows) routePlugin(row.plugin, "requested", `requested by the owner: ${row.workflow}`, row.workflow);
  for (const id of needs.needed) {
    const slug = pluginSlugFromCandidateId(id);
    if (slug) routePlugin(slug, "judge", `resident judgment: ${needs.reason || "the task is in this plugin's domain"}`);
  }
  for (const id of fallbackIds) {
    const slug = pluginSlugFromCandidateId(id);
    if (slug) routePlugin(slug, "local-relevance", "local relevance ranking (the resident judge did not answer)");
  }
  for (const id of retainedIds) {
    const slug = pluginSlugFromCandidateId(id);
    if (slug) routePlugin(slug, "retained", "previous routing in this active Goal");
  }
  for (const slug of requestedPluginSlugs) routePlugin(slug, "requested", "requested by the agent in the previous turn of this conversation");
  for (const plugin of pluginCandidates) {
    if (mentionedPlugin(plugin)) routePlugin(plugin.slug, "requested", `explicit ${plugin.mention} mention`);
  }
  for (const plugin of input.projectBaselinePlugins ?? []) routePlugin(plugin.slug, "baseline", plugin.reason);
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
  // Capability priority (shared/capability-priority.ts): the runtime would otherwise hand
  // this run an outside browser from the owner's own config (production 1.2.50: Codex
  // drove the owner's `playwright` server after an undecided judgment, and every navigate
  // raised an ungated MCP approval prompt). Attach the Agentlas browser as an ordinary
  // selection — the host mode stays "auto", so a failed probe keeps the old fallback
  // instead of blocking the run.
  if (
    automaticHostDecision
    && effectiveToolMode === "auto"
    && input.runtimeOutsideBrowser === true
    && canonicalBrowserAvailable
    && !neededIds.has("agentlas-browser")
  ) {
    neededIds.add("agentlas-browser");
    pinnedReasons.set("agentlas-browser", "capability priority: replaces the runtime's outside browser (Playwright-style server in the owner's config)");
  }
  const cappedHub = Math.max(0, hubInventory.listings.length - hubOffered.length);
  const needsNote = [
    needs.decided
      ? ""
      : selectionSource === "local-relevance"
        ? `no optional-tool judgment this run, local relevance attached ${fallbackIds.join(", ")}`
        : "no optional-tool judgment this run, configured tools only",
    cappedHub > 0 ? `${cappedHub} more Hub plugins not offered (harness_search finds them)` : "",
    // 조용히 줄이지 않는다 — 왜 Hub 후보가 없는지 영수증에 남긴다.
    projectScoped && hubAllowed && cappedHub > 0
      ? "project-first: short Hub shelf for this folder; full Hub via hephaestus-network"
      : "",
    needs.omitted.length > 0 ? `${needs.omitted.length} candidates exceeded the selector inventory cap.` : "",
  ]
    .filter(Boolean)
    .join("; ");

  // Baseline capability (owner 2026-09-29 "agentlas browser면 다 되야 하는거 아니냐"): the
  // Agentlas browser is core, not an optional pick. A run under a writable active Goal or a
  // One Team member's run gets it whatever the judge said (soak 1.2.50: t5/t7 teammates had
  // no browser and reached for the owner's Playwright / Computer Use instead). Host mode
  // stays "auto", so a failed probe keeps the old fallback instead of blocking the run.
  const writableGoalRun = activeGoalScope !== null && activeGoalScope.permission !== "read";
  const oneTeamMemberRun = input.autoSelectTools === true;
  if (
    automaticHostDecision
    && effectiveToolMode === "auto"
    && (writableGoalRun || oneTeamMemberRun)
    && canonicalBrowserAvailable
    && !blockedByHostBinding("agentlas-browser")
    && !neededIds.has("agentlas-browser")
  ) {
    neededIds.add("agentlas-browser");
    pinnedReasons.set("agentlas-browser", writableGoalRun
      ? "baseline capability: runs under a writable Goal always carry the Agentlas browser"
      : "baseline capability: One Team member runs always carry the Agentlas browser");
  }

  // Baseline capability: a group room is a team by definition (see AutoSelect input.groupRoom).
  // Carried by every turn, not only by turns whose judge or earlier request named it. It is
  // exempt from the probe cap (like an explicit assignment) so other picks cannot crowd it out.
  const baselineIds = new Set<string>();
  if (input.groupRoom === true && !blockedByHostBinding(ONE_TEAM_BASELINE_TOOL_ID)
    && MCP_TOOL_CATALOG.some((entry) => entry.id === ONE_TEAM_BASELINE_TOOL_ID)) {
    baselineIds.add(ONE_TEAM_BASELINE_TOOL_ID);
    neededIds.add(ONE_TEAM_BASELINE_TOOL_ID);
    pinnedReasons.set(ONE_TEAM_BASELINE_TOOL_ID, "baseline capability: a group room is a team, so every turn carries One Team");
    const owner = pluginCandidates.find((plugin) => plugin.toolIds.includes(ONE_TEAM_BASELINE_TOOL_ID));
    if (owner && !routedPlugins.some((routed) => routed.slug === owner.slug)) {
      routedPlugins.push({ slug: owner.slug, name: owner.name, reason: "baseline capability: group room", source: "baseline",
        hasSkills: owner.hasSkills, toolIds: [...owner.toolIds] });
    }
  }

  if (input.roomMember === true && !baselineIds.has(ONE_TEAM_BASELINE_TOOL_ID) && !blockedByHostBinding(ONE_TEAM_BASELINE_TOOL_ID)
    && MCP_TOOL_CATALOG.some((entry) => entry.id === ONE_TEAM_BASELINE_TOOL_ID)) {
    baselineIds.add(ONE_TEAM_BASELINE_TOOL_ID);
    neededIds.add(ONE_TEAM_BASELINE_TOOL_ID);
    pinnedReasons.set(ONE_TEAM_BASELINE_TOOL_ID, "baseline capability: a teammate working from a group room can post to the room (room_say)");
  }

  // Rank before the probe cap so a convenience pin can never crowd out a host binding or a
  // capability the judge said the task actually needs.
  const pickRank = (id: string): number => {
    if (hostBindingPins.has(id)) return 0;
    if (explicitlyAssignedIds.has(id) || baselineIds.has(id)) return 1;
    if (neededIds.has(id)) return 2;
    return 3;
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
    .filter((entry, index) => index < 10 || hostBindingPins.has(entry.id) || explicitlyAssignedIds.has(entry.id) || baselineIds.has(entry.id));

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
    const existingServer = deps.listInstalledServers().find(candidate => candidate.catalogId === entry.id || candidate.id === entry.id);
    const scoped = existingServer ? await scopedServerProbe(existingServer, deps, input.signal) : null;
    if (scoped) {
      const state: AutoSelectedMcpTool["state"] = !existingServer!.enabled || existingServer!.configurationValid === false
        ? "disabled" : scoped.outcome ? "probe-failed" : !scoped.available ? "host-failure" : scoped.connected ? "ready" : "probe-failed";
      return { ...base, installed: state === "ready", missingEnv: [], state,
        ...(scoped.outcome ? { connectionOutcome: scoped.outcome } : {}) };
    }
    const hasOAuth = existingServer && existingServer.transport !== "stdio"
      ? await serverHasOAuth(existingServer, deps) : false;
    const manualKeys = existingServer && hasOAuth ? requiredMcpManualEnvKeys(existingServer, true) : null;
    // An installed row may own its keys; a fresh catalog install has no references, so the bare name is its slot.
    const missingEnv = await missingRequiredEnv(manualKeys
      ? { ...entry, envRequirements: entry.envRequirements.filter(requirement => manualKeys.includes(requirement.key)) }
      : entry, existingServer ? (key) => readServerEnv(existingServer, key, deps) : deps.readEnvVar);
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
      for (const key of requiredMcpManualEnvKeys(server, hasOAuth)) if (!await readServerEnv(server, key, deps)) missingConfiguredEnv.push(key);
      if (missingConfiguredEnv.length) return { ...base, installed: false, missingEnv: missingConfiguredEnv, state: "missing-key" };
    }
    // 이 대화에서 방금 붙었던 서버는 다시 띄우지 않는다. **성공만** 기억한다.
    const probeKey = structuralKey ? `${structuralKey}\u0000${server.id}` : "";
    if (probeKey && !activeGoalScope && server.transport === "stdio") {
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
      required: input.toolMode === "browser" && entry.id === "agentlas-browser"
        || input.toolMode === "computer-use" && entry.id === "cua-driver",
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

  // Custom servers participate in the same task judgment as catalog entries.
  // Probe and attach only selected or explicitly assigned servers; installing
  // the full Hub catalog must not open every remote connection on each turn.
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
    if (!neededIds.has(server.id) && !requiredServerIds.has(server.id)) continue;
    if (!requiredServerIds.has(server.id)
      && (canonicalBrowserSelected || optionalBrowserDuplicates.has(server.id))
      && isKeylessPlaywrightMcpDuplicate(server)) continue;
    if (result.some((tool) => tool.id === server.id)) continue;
    const missingEnv: string[] = [];
    let state: AutoSelectedMcpTool["state"] = !server.enabled || server.configurationValid === false
      ? "disabled" : "ready";
    const scoped = state === "ready" ? await scopedServerProbe(server, deps, input.signal) : null;
    if (scoped) state = scoped.outcome ? "probe-failed" : !scoped.available ? "host-failure" : scoped.connected ? "ready" : "probe-failed";
    if (state === "ready" && !scoped) {
      try {
        const hasOAuth = await serverHasOAuth(server, deps);
        for (const key of requiredMcpManualEnvKeys(server, hasOAuth)) {
          const value = await readServerEnv(server, key, deps);
          if (!value) missingEnv.push(key);
        }
        if (missingEnv.length > 0) state = "missing-key";
      } catch (error) {
        if (!(error instanceof KeychainUnavailableError)) throw error;
        // An unavailable host read is not a missing key. Retain the typed
        // degradation without blocking other configured capabilities.
        missingEnv.length = 0;
        state = "host-failure";
      }
    }
    if (state === "ready" && !scoped) {
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
    result.push({
      id: server.id,
      name: server.nameEn || server.name,
      reason: requiredServerIds.has(server.id) ? "explicitly assigned to this run"
        : retainedIds.has(server.id) && !needs.needed.includes(server.id)
          ? "previous selection in this active Goal, revalidated for this run"
          : "resident judgment: the task needs this custom MCP",
      installed: state === "ready",
      missingEnv,
      required: false,
      state,
      ...(scoped?.outcome ? { connectionOutcome: scoped.outcome } : {}),
    });
  }

  // ── A selected Browser binding is not an owner binding ─────────────────────────────────────
  // An automatic decision lands on "browser" whenever the browser is among the selected ids: this turn's judge, an
  // earlier choice retained in the Goal, or a plugin the agent asked for last turn. client.ts refuses a "browser" run
  // whose authenticated host is not ready before any model call — right for the owner's own binding (an automation
  // or graph bound to the browser, an explicit catalog assignment, an @mention of the plugin), wrong for a selection:
  // a 0.6B resident judge sent 4/4 plain file/shell Work turns to agentlas-browser and every one was refused
  // (QA 2026-10-28). A selection that cannot be honored proceeds without the browser; the tool stays in the result
  // with its real state so the turn context lists it as unavailable, and the withdrawal is a typed record.
  let hostBindingWithdrawn: AutoSelectedMcpContext["hostBindingWithdrawn"];
  const browserOwnerBound = input.toolMode === "browser"
    || explicitlyAssignedIds.has("agentlas-browser")
    || pluginCandidates.some((plugin) => plugin.toolIds.includes("agentlas-browser") && mentionedPlugin(plugin));
  if (automaticHostDecision && effectiveToolMode === "browser" && !browserOwnerBound) {
    const browser = result.find((tool) => tool.id === "agentlas-browser");
    if (browser?.state !== "ready") {
      effectiveToolMode = "auto";
      const judged = needs.needed.includes("agentlas-browser")
        || routedPlugins.some((plugin) => plugin.source === "judge" && plugin.toolIds.includes("agentlas-browser"));
      hostBindingWithdrawn = { code: AGENTLAS_BROWSER_WITHDRAWN_CODE, host: "agentlas-browser",
        state: browser?.state ?? "not-selected", selectedBy: judged ? "judge" : "carried" };
    }
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
  // A connection probe may legitimately refresh launcher metadata in the MCP
  // registry. Rebase the receipt once, after all probes and retained-tool
  // pruning, instead of treating that host-owned refresh as a Goal revision.
  // Any later change is still caught below, and materialized configs retain
  // their own exact binding lease for the lifetime of the runtime call.
  if (activeGoalScope && goalBindingStillCurrent()) {
    expectedInstalledFingerprint = registryFingerprint(deps.listInstalledServers());
  }
  const finalReceiptScope = receiptScope && goalScopeStillCurrent() ? { ...receiptScope,
    scopeHash: createHash("sha256").update(goalScopeKeyFor(expectedInstalledFingerprint)).digest("hex"),
  } : null;
  const context: AutoSelectedMcpContext = {
    ...(finalReceiptScope ? { goalSelectionScope: finalReceiptScope } : {}),
    // Once Main has selected and materialized this turn's immutable config,
    // unrelated registry metadata changes must not revoke the running Goal.
    // The config lease/assertCurrent path still verifies the exact prepared
    // bindings; this callback owns only Goal revision continuity.
    ...(activeGoalScope ? { goalSelectionIsCurrent: () => Boolean(finalReceiptScope)
      && goalBindingStillCurrent() } : {}),
    effectiveToolMode,
    ...(hostBindingWithdrawn ? { hostBindingWithdrawn } : {}),
    tools: result,
    localInventory,
    localPluginCount: localInventory.length,
    hubPluginCount: hubInventory.hubPluginCount,
    hubPlugins,
    ...(pendingApprovalTools.length > 0 ? { pendingApprovalTools } : {}),
    needsDecided: needs.decided,
    ...(routedPlugins.length > 0 ? { routedPlugins } : {}),
    selectionSource,
    needsOutcome: { decided: needs.decided, candidateCount: needsCandidateCount, reason: needs.reason },
    ...(needsNote ? { needsNote } : {}),
    ...(cappedHub > 0 ? { hubNotOffered: cappedHub } : {}),
    ...(hubInventory.hubPluginError ? { hubPluginError: hubInventory.hubPluginError } : {}),
  };
  // ── sticky 합집합 병합 — 같은 대화의 도구셋은 넓어지기만 한다(캐시 보존) ──
  if (goalScopeKey && conversationId && goalScopeStillCurrent()) {
    const selectedIds = [
      ...context.tools.filter((tool) => neededIds.has(tool.id) && tool.state === "ready").map((tool) => tool.id),
      ...routedPlugins.map((plugin) => pluginCandidateId(plugin.slug)),
    ];
    const finalGoalScopeKey = goalScopeKeyFor(expectedInstalledFingerprint);
    memoSet(goalSelectionMemo, conversationId, { scopeKey: finalGoalScopeKey, selectedIds });
    if (receiptScope && input.writeGoalSelection) {
      // Persistence is a selection hint, not a prerequisite for this tool run.
      try { input.writeGoalSelection({ ...receiptScope,
        scopeHash: createHash("sha256").update(finalGoalScopeKey).digest("hex"), selectedIds }); } catch { /* No durable hint was saved. */ }
    }
  }
  if (!activeGoalScope && structuralKey && (needs.decided || selectionSource === "local-relevance")) {
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
  // A withdrawn browser reflects this moment's host state; the next turn must look at the host again.
  if (!activeGoalScope && memoKey && needs.decided && !hostBindingWithdrawn) memoSet(selectionMemo, memoKey, { context: cloneContext(context), at: Date.now() });
  return context;
}

export function buildMcpAutoSelectionPrompt(
  selected: AutoSelectedMcpContext,
  opts?: { toolMode?: AutomationToolMode; hubMode?: AutomationHubMode; userPrompt?: string },
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
      ? "mode: Agentlas Browser (real-login CDP) only for web work; no fresh Playwright profile"
      : opts?.toolMode === "computer-use"
        ? "mode: Computer Use; desktop/screen tools for UI work"
        : "";
  const hubLine =
    opts?.hubMode === "hub-first"
      ? "hub: first; prefer Hub specialists/plugins via hephaestus-network before local fallbacks"
      : opts?.hubMode === "hub-allowed"
        ? "hub: allowed via hephaestus-network when local tools are insufficient"
        : opts?.hubMode === "local-only"
          ? "hub: local-only; no Hub routing or borrowed Hub agents"
          : "";
  // 붙은 도구의 이름·설명·입력 스키마는 MCP 도구 스키마로 이미 전달된다(2026-10-13: 이름 나열, "도구를 쓰라",
  // 플러그인 우주 개수, 로컬 인벤토리, Hub 조회 안내는 프롬프트에서 뺐다). 스키마로 알 수 없는 것만 남긴다:
  // 후보 플러그인, 꺼진 것(승인 대기)·자격증명 대기·불능 상태, 도구가 0개라는 사실.
  const hubCandidates =
    selected.hubPlugins.length > 0
      ? `hub candidates: ${JSON.stringify(selected.hubPlugins.map(plugin => ({ slug: plugin.slug, name: plugin.name, reason: plugin.reason, ...(plugin.installCli ? { installCli: plugin.installCli } : {}) })))}`
      : selected.hubPluginError
        ? `hub catalog unreachable (${selected.hubPluginError}) → say so; never "no such tool"`
        : "";
  const pendingApproval = (selected.pendingApprovalTools ?? []).filter((name) => name.trim().length > 0);
  // Declared parts (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.turn-context.tools-selection): the state of the
  // tools this conversation selected (sticky per goal/conversation), then what this request retrieved last — the Hub
  // shelf (its "more" count is listings minus the plugins offered for this request) and the routed plugin routers.
  const inventoryLines = [
    installed.length === 0 && pendingApproval.length === 0 && blocked.length === 0 ? "tools: none" : "",
    computerUseSelected && !computerUseReady
      ? browserReady
        ? "computer use: unavailable → no OS-level control; browser covers only the signed-in browser"
        : "computer use: unavailable → no screen or OS-level control"
      : "",
    pendingApproval.length > 0
      ? `approval pending: ${JSON.stringify(pendingApproval)}; current grant first; ask only missing authorization`
      : "",
    blocked.length > 0
      ? `credentials missing: ${JSON.stringify(blocked.map(tool => ({ id: tool.id, missingEnv: tool.missingEnv })))}; Vault/key/browser reuse first; hide values; ask only affected task`
      : "",
    unavailable.length > 0
      ? `MCP unavailable: ${JSON.stringify(unavailable.map(tool => ({ id: tool.id, state: tool.state, required: Boolean(tool.required), ...(tool.connectionOutcome ? { reason: describeScopedMcpOutcome(tool.connectionOutcome, "en") } : {}) })))}; degrade dependent work only`
      : "",
  ].filter(Boolean).join("\n");
  const retrievedLines = [
    // The selection receipt (needsNote) stays in the ledger; the model only needs what it can act on.
    selected.hubNotOffered ? `hub: ${selected.hubNotOffered} more plugins (harness_search)` : "",
    hubCandidates,
    selectedPluginRouterPrompt(selected.routedPlugins ?? [], opts?.userPrompt ?? ""),
  ].filter(Boolean).join("\n");
  return purposePrompt([
    { id: "purpose.mcp.selection.mode", revision: 2, stability: "configuration", changeTriggers: ["runtime", "permission"], text: [modeLine, hubLine].filter(Boolean).join("\n") },
    { id: "purpose.mcp.selection.inventory", revision: 3, stability: "task-context", changeTriggers: ["capability-inventory", "connector-inventory", "plugin-inventory", "tool-grant"], text: inventoryLines },
    // r2 (2026-10-28): an owner-requested plugin workflow (a screen's button or menu) carries its skill text after its pointer.
    { id: "purpose.mcp.selection.retrieved", revision: 2, stability: "turn-context", changeTriggers: ["retrieval", "plugin-inventory", "owner-input"], text: retrievedLines },
  ]);
}
