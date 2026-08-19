import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  InstalledMcpServer,
  McpBuildAttachmentReceipt,
  McpBuildCandidate,
  McpBuildFallbackReceipt,
  McpBuildReceiptItem,
  McpBuildReceiptReason,
  McpTransport,
  RuntimeSelection,
} from "../../shared/types";
import { hasEnvVar } from "../secrets/vault";
import { testServerConnection } from "./client";
import { buildMcpConfigFile, type McpConfigResult } from "./mcp-config";
import { installFromCatalog, listInstalledServers } from "./registry";
import { installHubPlugin } from "./hub-plugin-bridge";
import { installedServerMatchesPluginSlug } from "../../shared/plugin-slug";
import { runtimeKindSupportsMcpTransport } from "../../shared/runtime-mcp";
import { userDataPath } from "../runtime-paths";

export interface InternalMcpBuildCandidate {
  public: McpBuildCandidate;
  serverId: string | null;
  envKeys: string[];
  transport: McpTransport;
  /**
   * Hub-sourced candidate. Hub plugins are not in the local catalog, so
   * `installCatalog` cannot materialize them — they install through the Hub
   * manifest instead. Without this the model could pick a Hub tool and the
   * approval would silently attach nothing.
   */
  hub?: { slug: string; manifestUrl: string };
  /**
   * Hub plugin that ships skills instead of an MCP server
   * (`packageShape.mcpReference === "none"`). There is nothing to connect, so the
   * capability travels to the builder as a declared skill rather than being
   * reported as a broken attachment — measured 2026-08-17: Documents,
   * Presentations and Spreadsheets showed as "Failed · 3" while being perfectly
   * healthy skill bundles.
   */
  skillBundle?: { slug: string; name: string; intent: string; capabilities: string[] };
}

export interface ResolvedMcpBuildAttachment {
  receipt: McpBuildAttachmentReceipt;
  config: McpConfigResult | null;
  compactSummary: string;
  /** Exact value-free binding between a consented candidate and one serialized MCP key. */
  runtimeBindings: Array<{ candidateId: string; serverId: string; configKey: string }>;
  /** Main-only single recovery hook. It never broadens the user's selected candidates. */
  recoverRuntimeFailure?: (failedCandidateId: string) => Promise<ResolvedMcpBuildAttachment | null>;
}

export interface McpAttachmentResolverDependencies {
  listInstalled: () => InstalledMcpServer[];
  installCatalog: (catalogId: string) => InstalledMcpServer;
  /** Hub plugin install. Same host path the Hub screen uses. */
  installHub: (input: { slug: string; manifestUrl: string }) => Promise<InstalledMcpServer | null>;
  hasEnv: (key: string) => Promise<boolean>;
  testServer: (server: InstalledMcpServer) => Promise<{
    connected: boolean;
    missingEnv: string[];
  }>;
  buildConfig: (serverIds: string[], planId: string) => Promise<McpConfigResult | null>;
}

const DEFAULT_DEPS: McpAttachmentResolverDependencies = {
  listInstalled: listInstalledServers,
  installCatalog: installFromCatalog,
  installHub: async ({ slug, manifestUrl }) => {
    const result = await installHubPlugin({ slug, manifestUrl, approveLocalExecution: true });
    const connected = result.receipts.find((entry) => entry.action === "connected" || entry.action === "already-installed");
    if (!connected) return null;
    return listInstalledServers().find((server) => installedServerMatchesPluginSlug(server, slug)) ?? null;
  },
  hasEnv: hasEnvVar,
  testServer: (server) => testServerConnection(server, { timeoutMs: 15_000 }),
  buildConfig: (serverIds, planId) =>
    buildMcpConfigFile({
      serverIds,
      skipDefaultSeed: true,
      configKey: `build-${planId}`,
    }),
};

/**
 * ★This used to be a second hand-written copy of "which runtime can receive
 * MCP", and it drifted from the one in electron/mcp/client.ts the moment the
 * ACP runner learned to translate our config into `session/new.mcpServers`.
 * Both now derive from shared/runtime-mcp.ts, where each runtime's answer is
 * stated once with the evidence for it.
 */
export function isRuntimeMcpCompatible(
  runtime: RuntimeSelection | null,
  transport: McpTransport,
): boolean {
  if (!runtime) return false;
  return runtimeKindSupportsMcpTransport(runtime.kind, transport);
}

function receiptItem(
  candidate: InternalMcpBuildCandidate,
  status: McpBuildReceiptItem["status"],
  reason: McpBuildReceiptReason,
): McpBuildReceiptItem {
  return {
    candidateId: candidate.public.id,
    catalogId: candidate.public.catalogId,
    name: candidate.public.name,
    capability: candidate.public.capability,
    status,
    reason,
    fallbackGroup: candidate.public.fallbackGroup,
  };
}

async function allKeysPresent(
  keys: string[],
  deps: McpAttachmentResolverDependencies,
): Promise<boolean> {
  const checks = await Promise.all(keys.map((key) => deps.hasEnv(key).catch(() => false)));
  return checks.every(Boolean);
}

function currentServer(
  candidate: InternalMcpBuildCandidate,
  deps: McpAttachmentResolverDependencies,
): InstalledMcpServer | null {
  const installed = deps.listInstalled();
  if (candidate.serverId) {
    const exact = installed.find((server) => server.id === candidate.serverId);
    if (exact) return exact;
  }
  return candidate.public.catalogId
    ? installed.find((server) => server.catalogId === candidate.public.catalogId) ?? null
    : null;
}

interface GroupResolutionState {
  ordered: InternalMcpBuildCandidate[];
  cursor: number;
  attached: { item: McpBuildReceiptItem; serverId: string } | null;
  missingKey: McpBuildReceiptItem[];
  failed: McpBuildReceiptItem[];
  degraded: McpBuildReceiptItem[];
  unavailable: string[];
}

function createGroupState(candidates: InternalMcpBuildCandidate[]): GroupResolutionState {
  return {
    // The system-global registry is the first authority. A lower-priority MCP
    // the user already installed must be tried before a higher-priority catalog
    // suggestion that would need installation. Priority only breaks ties inside
    // the same source/readiness class.
    ordered: [...candidates].sort((a, b) => {
      const aInstalled = a.public.source === "system-registry" && a.public.installed ? 1 : 0;
      const bInstalled = b.public.source === "system-registry" && b.public.installed ? 1 : 0;
      if (bInstalled !== aInstalled) return bInstalled - aInstalled;
      if (a.public.source !== b.public.source) {
        return a.public.source === "system-registry" ? -1 : 1;
      }
      if (b.public.priority !== a.public.priority) return b.public.priority - a.public.priority;
      return a.public.id.localeCompare(b.public.id);
    }),
    cursor: 0,
    attached: null,
    missingKey: [],
    failed: [],
    degraded: [],
    unavailable: [],
  };
}

async function advanceFallbackGroup(input: {
  state: GroupResolutionState;
  runtime: RuntimeSelection | null;
  deps: McpAttachmentResolverDependencies;
}): Promise<void> {
  while (!input.state.attached && input.state.cursor < input.state.ordered.length) {
    const candidate = input.state.ordered[input.state.cursor];
    input.state.cursor += 1;
    if (!isRuntimeMcpCompatible(input.runtime, candidate.transport)) {
      input.state.degraded.push(receiptItem(candidate, "degraded", "runtime_incompatible"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }
    if (!(await allKeysPresent(candidate.envKeys, input.deps))) {
      input.state.missingKey.push(receiptItem(candidate, "missing_key", "missing_key"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }

    let server = currentServer(candidate, input.deps);
    if (!server && candidate.hub) {
      let hubError: unknown = null;
      try {
        server = await input.deps.installHub(candidate.hub);
      } catch (err) {
        server = null;
        hubError = err;
      }
      if (!server) {
        // 스킬 묶음(연결할 MCP 서버가 없는 플러그인)은 고장이 아니다. 설치가
        // 깨진 것과 같은 칸에 넣으면 정상 자산이 빨간 실패로 보고된다.
        // 스킬 묶음은 붙일 서버가 없는 게 정상이다. 요약을 통해 빌더에게 스킬로 전달되므로
        // 여기서는 "연결 실패"가 아니라 상태만 남긴다.
        const reason = hubError === null ? "no_connectable_server" : "install_failed";
        input.state[hubError === null ? "degraded" : "failed"].push(
          receiptItem(candidate, hubError === null ? "degraded" : "failed", reason),
        );
        input.state.unavailable.push(candidate.public.id);
        continue;
      }
    }
    if (!server && candidate.public.catalogId) {
      try {
        server = input.deps.installCatalog(candidate.public.catalogId);
      } catch {
        input.state.failed.push(receiptItem(candidate, "failed", "install_failed"));
        input.state.unavailable.push(candidate.public.id);
        continue;
      }
    }
    if (!server) {
      input.state.failed.push(receiptItem(candidate, "failed", "server_unavailable"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }
    if (!server.enabled) {
      input.state.degraded.push(receiptItem(candidate, "degraded", "disabled"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }
    if (!(await allKeysPresent(server.envKeys, input.deps))) {
      input.state.missingKey.push(receiptItem(candidate, "missing_key", "missing_key"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }

    let status: { connected: boolean; missingEnv: string[] };
    try {
      status = await input.deps.testServer(server);
    } catch {
      status = { connected: false, missingEnv: [] };
    }
    if (status.missingEnv.length > 0) {
      input.state.missingKey.push(receiptItem(candidate, "missing_key", "missing_key"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }
    if (!status.connected) {
      input.state.failed.push(receiptItem(candidate, "failed", "connection_failed"));
      input.state.unavailable.push(candidate.public.id);
      continue;
    }

    input.state.attached = {
      item: receiptItem(candidate, "attached", "attached"),
      serverId: server.id,
    };
  }
}

function markRemainingGroupHostFailure(state: GroupResolutionState): void {
  const accounted = new Set([
    ...state.missingKey,
    ...state.failed,
    ...state.degraded,
    ...(state.attached ? [state.attached.item] : []),
  ].map((item) => item.candidateId));
  for (const candidate of state.ordered) {
    if (!accounted.has(candidate.public.id)) {
      state.degraded.push(receiptItem(candidate, "degraded", "host_failure"));
      state.unavailable.push(candidate.public.id);
    }
  }
  state.attached = null;
  state.cursor = state.ordered.length;
}

/** Skill-only plugins the user approved. They reach the builder as capabilities, not servers. */
function compactSkillSummary(bundles: NonNullable<InternalMcpBuildCandidate["skillBundle"]>[]): string {
  if (bundles.length === 0) return "";
  return [
    "",
    "Approved Agentlas skill plugins (no MCP server — bundle these as package skills):",
    ...bundles.map((b) => `- ${b.slug} (${b.name}): ${b.intent}${b.capabilities.length ? ` [${b.capabilities.join("/")}]` : ""}`),
    "Declare each one in the package's skills and in docs/tool-selection.md. Do not",
    "invent an MCP server for them and do not report them as a failed connection.",
  ].join("\n");
}

function compactReceiptSummary(receipt: McpBuildAttachmentReceipt): string {
  const ids = (items: McpBuildReceiptItem[]) =>
    items.map((item) => item.catalogId ?? item.candidateId).slice(0, 12).join(",") || "none";
  return [
    "MCP attachment receipt (main-verified; IDs/status only):",
    `attached=${ids(receipt.attached)}`,
    `skipped=${ids(receipt.skipped)}`,
    `missing_key=${ids(receipt.missingKey)}`,
    `failed=${ids(receipt.failed)}`,
    `degraded=${ids(receipt.degraded)}`,
    receipt.fallback.length
      ? `fallback=${receipt.fallback.map((item) => `${item.fromCandidateId}->${item.toCandidateId}`).join(",")}`
      : "fallback=none",
  ].join("\n");
}

/**
 * Apply one already-validated consent. Each fallback group resolves in isolation;
 * a broken server can never prevent healthy peers or empty-MCP mode from running.
 */
export async function resolveApprovedMcpCandidates(input: {
  planId: string;
  candidates: InternalMcpBuildCandidate[];
  selectedCandidateIds: string[];
  runtime: RuntimeSelection | null;
  deps?: McpAttachmentResolverDependencies;
  allowRuntimeRecovery?: boolean;
}): Promise<ResolvedMcpBuildAttachment> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.public.id, candidate]));
  const selected = new Set(input.selectedCandidateIds);
  for (const id of selected) {
    if (!candidateById.has(id)) throw new Error("MCP consent contains a candidate outside its plan.");
  }

  const skipped = input.candidates
    .filter((candidate) => !selected.has(candidate.public.id))
    .map((candidate) => receiptItem(candidate, "skipped", "not_selected"));
  const selectedCandidates = input.candidates.filter((candidate) => selected.has(candidate.public.id));
  const groups = new Map<string, InternalMcpBuildCandidate[]>();
  for (const candidate of selectedCandidates) {
    const bucket = groups.get(candidate.public.fallbackGroup) ?? [];
    bucket.push(candidate);
    groups.set(candidate.public.fallbackGroup, bucket);
  }

  const groupEntries = [...groups.values()];
  const groupStates = groupEntries.map(createGroupState);
  const settled = await Promise.allSettled(
    groupStates.map((state) => advanceFallbackGroup({ state, runtime: input.runtime, deps })),
  );
  for (let groupIndex = 0; groupIndex < settled.length; groupIndex += 1) {
    const item = settled[groupIndex];
    if (item.status === "rejected") markRemainingGroupHostFailure(groupStates[groupIndex]);
  }

  let config: McpConfigResult | null = null;
  // Final config generation is part of fallback readiness, not an afterthought.
  // If a connected primary is omitted by JIT serialization (for example, an env
  // key disappeared), advance only that group and rebuild. Every rejection
  // consumes one candidate, so the selected-candidate bound prevents loops.
  for (let attempt = 0; attempt <= selectedCandidates.length; attempt += 1) {
    const active = groupStates.flatMap((state) => state.attached ? [state.attached] : []);
    if (active.length === 0) {
      config = null;
      break;
    }
    let nextConfig: McpConfigResult | null = null;
    try {
      nextConfig = await deps.buildConfig(active.map((entry) => entry.serverId), input.planId);
    } catch {
      nextConfig = null;
    }
    const included = new Set(nextConfig?.includedServerIds ?? []);
    const rejectedStates = groupStates.filter(
      (state) => state.attached && !included.has(state.attached.serverId),
    );
    if (rejectedStates.length === 0) {
      config = nextConfig;
      break;
    }
    for (const state of rejectedStates) {
      const rejected = state.attached!;
      state.degraded.push({
        ...rejected.item,
        status: "degraded",
        reason: "configuration_rejected",
      });
      state.unavailable.push(rejected.item.candidateId);
      state.attached = null;
    }
    const advanced = await Promise.allSettled(
      rejectedStates.map((state) => advanceFallbackGroup({ state, runtime: input.runtime, deps })),
    );
    for (let index = 0; index < advanced.length; index += 1) {
      if (advanced[index].status === "rejected") markRemainingGroupHostFailure(rejectedStates[index]);
    }
  }

  const included = new Set(config?.includedServerIds ?? []);
  const attached: McpBuildReceiptItem[] = [];
  const missingKey: McpBuildReceiptItem[] = [];
  const failed: McpBuildReceiptItem[] = [];
  const degraded: McpBuildReceiptItem[] = [];
  const fallback: McpBuildFallbackReceipt[] = [];
  for (const state of groupStates) {
    missingKey.push(...state.missingKey);
    failed.push(...state.failed);
    degraded.push(...state.degraded);
    if (state.attached && included.has(state.attached.serverId)) {
      attached.push(state.attached.item);
      for (const candidate of state.ordered.slice(state.cursor)) {
        skipped.push(receiptItem(candidate, "skipped", "fallback_not_needed"));
      }
      if (state.unavailable.length > 0) {
        fallback.push({
          group: state.attached.item.fallbackGroup,
          fromCandidateId: state.unavailable[0],
          toCandidateId: state.attached.item.candidateId,
          reason: "fallback_used",
        });
      }
    } else if (state.attached) {
      // Defensive last gate: no receipt may claim attachment unless the exact
      // server survived the final serialized config.
      degraded.push({ ...state.attached.item, status: "degraded", reason: "configuration_rejected" });
      state.attached = null;
    }
  }
  if (attached.length === 0) config = null;

  const order = new Map(input.candidates.map((candidate, index) => [candidate.public.id, index]));
  const sortItems = (items: McpBuildReceiptItem[]) =>
    items.sort((a, b) => (order.get(a.candidateId) ?? 999) - (order.get(b.candidateId) ?? 999));
  const receipt: McpBuildAttachmentReceipt = {
    planId: input.planId,
    resolvedAt: new Date().toISOString(),
    attached: sortItems(attached),
    skipped: sortItems(skipped),
    missingKey: sortItems(missingKey),
    failed: sortItems(failed),
    degraded: sortItems(degraded),
    fallback,
    emptyMode: attached.length === 0,
    hostReceiptStored: false,
    hostReceiptWarning: null,
  };
  const attachedByServerId = new Map(
    groupStates.flatMap((state) => state.attached ? [[state.attached.serverId, state.attached.item.candidateId] as const] : []),
  );
  const runtimeBindings = (config?.includedServers ?? []).flatMap((server) => {
    const candidateId = attachedByServerId.get(server.serverId);
    return candidateId ? [{ candidateId, serverId: server.serverId, configKey: server.configKey }] : [];
  });
  const resolvedAttachment: ResolvedMcpBuildAttachment = {
    receipt,
    config,
    compactSummary: compactReceiptSummary(receipt)
      + compactSkillSummary(
          input.candidates
            .filter((candidate) => selected.has(candidate.public.id) && candidate.skillBundle)
            .map((candidate) => candidate.skillBundle!),
        ),
    runtimeBindings,
  };

  if (input.allowRuntimeRecovery !== false && config && receipt.attached.length > 0) {
    resolvedAttachment.recoverRuntimeFailure = async (failedCandidateId) => {
      const failedItem = receipt.attached.find((item) => item.candidateId === failedCandidateId);
      if (!failedItem || !selected.has(failedCandidateId)) return null;
      const healthyCandidateIds = receipt.attached
        .filter((item) => item.candidateId !== failedCandidateId)
        .map((item) => item.candidateId);
      const remainingSelected = [...selected].filter((candidateId) => candidateId !== failedCandidateId);
      const recovered = await resolveApprovedMcpCandidates({
        planId: input.planId,
        candidates: input.candidates,
        selectedCandidateIds: remainingSelected,
        runtime: input.runtime,
        deps,
        allowRuntimeRecovery: false,
      });
      const recoveredIds = new Set(recovered.receipt.attached.map((item) => item.candidateId));
      // Every originally healthy capability must remain exact. The failed
      // capability may use an approved same-group fallback; without one it is
      // explicitly unavailable while unrelated Build work continues. If no
      // healthy MCP remains, the resolver's emptyMode is authoritative.
      if (healthyCandidateIds.some((id) => !recoveredIds.has(id))) {
        return null;
      }
      const replacement = recovered.receipt.attached.find((item) =>
        item.fallbackGroup === failedItem.fallbackGroup && item.candidateId !== failedCandidateId);
      recovered.receipt.skipped = recovered.receipt.skipped.filter((item) => item.candidateId !== failedCandidateId);
      recovered.receipt.degraded.push({
        ...failedItem,
        status: "degraded",
        reason: "runtime_startup_failed",
      });
      if (replacement && !recovered.receipt.fallback.some((item) =>
        item.fromCandidateId === failedCandidateId && item.toCandidateId === replacement.candidateId)) {
        recovered.receipt.fallback.push({
          group: failedItem.fallbackGroup,
          fromCandidateId: failedCandidateId,
          toCandidateId: replacement.candidateId,
          reason: "fallback_used",
        });
      }
      recovered.compactSummary = compactReceiptSummary(recovered.receipt);
      try {
        recovered.receipt.hostReceiptStored = true;
        recovered.receipt.hostReceiptWarning = null;
        persistHostMcpBuildReceipt(recovered.receipt);
      } catch {
        recovered.receipt.hostReceiptStored = false;
        recovered.receipt.hostReceiptWarning = "receipt_storage_failed";
      }
      return recovered;
    };
  }
  return resolvedAttachment;
}

export function emptyMcpBuildReceipt(planId: string): McpBuildAttachmentReceipt {
  return {
    planId,
    resolvedAt: new Date().toISOString(),
    attached: [],
    skipped: [],
    missingKey: [],
    failed: [],
    degraded: [],
    fallback: [],
    emptyMode: true,
    hostReceiptStored: false,
    hostReceiptWarning: null,
  };
}

/** Host-local receipt. Never place this runtime/account state inside an agent package. */
export function persistHostMcpBuildReceipt(receipt: McpBuildAttachmentReceipt): string {
  const dir = userDataPath("mcp", "build-receipts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const safeId = receipt.planId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "unknown";
  const target = path.join(dir, `${safeId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ schemaVersion: "mcp-build-host-receipt/1.0", ...receipt }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temp, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}
