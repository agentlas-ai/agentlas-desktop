// DESKTOP_MOBILE_BRIDGE: Cloud-action and build adapters for the Mobile Bridge
// authority.
//
// These are NOT a second authority. Every method delegates to the exact same
// Desktop internals that Electron IPC uses today:
//   - registered uploads  → cloud-agents/registered-upload + packageAndReviewCloudAgent
//     (the `cloudAgents:saveRegisteredPrivate` path, pinned to private-link/static-only)
//   - cloud delete → the authenticated cargo.* McpSource client
//   - remote build → hephaestus/builder runHephaestusBuild with an explicit
//     empty MCP consent (Mobile never auto-attaches MCP servers)
// Tests inject fakes through MobileBridgeAuthority options; production omits
// the option and gets these defaults.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionCookieHeader } from "../auth";
import { getCargoSource, invalidateMyAgentsCache } from "../marketplace";
import { registeredUploadOptions, registeredUploadRoot } from "../cloud-agents/registered-upload";
import type {
  CloudAgentDeleteResult,
  CloudAgentPackageResult,
  CloudAgentRegisteredTarget,
  CloudAgentRegisteredUploadOption,
  HephaestusBuildEvent,
} from "../../shared/types";

/** Matches cloud-agents/package.ts exclusions closely enough for an estimate. */
const ESTIMATE_SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
]);
const ESTIMATE_FILE_CAP = 400;

export interface MobileBridgeCloudAgentActions {
  /** True when this Desktop holds an authenticated agentlas.cloud session. */
  hasCloudSession(): boolean;
  listRegisteredUploadOptions(): CloudAgentRegisteredUploadOption[];
  /** Bounded local file-count estimate for an upload preview. Read-only. */
  estimateUploadFileCount(target: CloudAgentRegisteredTarget): number;
  /** The `cloudAgents:saveRegisteredPrivate` path: private-link + static-only. */
  saveRegisteredPrivate(target: CloudAgentRegisteredTarget): Promise<CloudAgentPackageResult>;
  deleteMyAgent(slug: string): Promise<CloudAgentDeleteResult>;
}

export interface MobileBridgeBuildRunInput {
  runId: string;
  goal: string;
  locale: "ko" | "en";
  sink: (event: HephaestusBuildEvent) => void;
  signal: AbortSignal;
}

export interface MobileBridgeBuildApprovalInput {
  runId: string;
  goal: string;
  locale: "ko" | "en";
}

export type MobileBridgeBuildApprovalDecision =
  | { approved: true }
  | { approved: false; code: "desktop_approval_denied" | "desktop_approval_unavailable" };

export interface MobileBridgeBuildActions {
  /** A per-run, Desktop-local native confirmation. Paired-device auth is insufficient. */
  requestLocalApproval(input: MobileBridgeBuildApprovalInput): Promise<MobileBridgeBuildApprovalDecision>;
  /**
   * Prepare a main-owned workspace and drive one Hephaestus build to its
   * terminal state. The returned promise settles only when the run is over;
   * progress flows exclusively through `sink`.
   */
  run(input: MobileBridgeBuildRunInput): Promise<void>;
}

function countCandidateFiles(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    if (count >= ESTIMATE_FILE_CAP) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= ESTIMATE_FILE_CAP) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ESTIMATE_SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  };
  walk(root);
  return count;
}

function requireCargoSource(): NonNullable<ReturnType<typeof getCargoSource>> {
  const source = getCargoSource();
  if (!source) throw new Error("Agent Cloud client is unavailable on this Desktop");
  return source;
}

export function createDesktopMobileBridgeCloudAgentActions(): MobileBridgeCloudAgentActions {
  return {
    hasCloudSession: () => Boolean(getSessionCookieHeader()),
    listRegisteredUploadOptions: () => registeredUploadOptions(),
    estimateUploadFileCount: (target) => countCandidateFiles(registeredUploadRoot(target).rootPath),
    saveRegisteredPrivate: async (target) => {
      const source = registeredUploadRoot(target);
      const { packageAndReviewCloudAgent } = await import("../cloud-agents/package");
      return packageAndReviewCloudAgent({
        ...source,
        visibility: "private-link",
        reviewMode: "static-only",
      });
    },
    // 선반을 바꿨으면 캐시도 같이 바뀌어야 한다. 무효화하지 않으면 방금 지운
    // 에이전트가 최대 5분 동안 폰의 Cloud 탭에 그대로 남는다.
    deleteMyAgent: async (slug) => {
      const result = await requireCargoSource().deleteMyAgent(slug);
      invalidateMyAgentsCache();
      return result;
    },
  };
}

async function createMobileBuildWorkspace(): Promise<string> {
  // Lazy electron import keeps this module loadable by plain-node tooling that
  // injects fake build actions and never calls the desktop default.
  const { app } = await import("electron");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workspace = path.join(
    app.getPath("documents"),
    "Agentlas Mobile Builds",
    `build-${stamp}-${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

export function createDesktopMobileBridgeBuildActions(): MobileBridgeBuildActions {
  return {
    async requestLocalApproval(input) {
      // Reuse Desktop's native warning-dialog approval pattern. No Mobile RPC
      // can synthesize this decision, and a headless/no-window Desktop fails
      // closed instead of silently granting full runner authority.
      const { app, BrowserWindow, dialog } = await import("electron");
      if (!app.isReady()) return { approved: false, code: "desktop_approval_unavailable" };
      const parent = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
        ?? null;
      if (!parent || parent.isDestroyed()) {
        return { approved: false, code: "desktop_approval_unavailable" };
      }
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
      const ko = input.locale === "ko";
      const visibleGoal = input.goal
        .replace(/[\u0000-\u001f]+/g, " ")
        .trim()
        .slice(0, 1_000);
      const result = await dialog.showMessageBox(parent, {
        type: "warning",
        buttons: ko ? ["거부", "이번 빌드 승인"] : ["Deny", "Approve this build"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: ko ? "Mobile 전체권한 빌드 승인" : "Approve full-access Mobile build",
        message: ko
          ? "연결된 Mobile이 이 Mac에서 전체권한 Hephaestus Build를 요청했습니다."
          : "A paired Mobile requested a full-access Hephaestus Build on this Mac.",
        detail: ko
          ? `요청:\n${visibleGoal}\n\n승인하면 로컬 파일 쓰기와 shell 도구를 사용할 수 있습니다. 이 승인에는 이번 run만 포함됩니다.`
          : `Request:\n${visibleGoal}\n\nApproval permits local file writes and shell tools for this run only.`,
      });
      return result.response === 1
        ? { approved: true }
        : { approved: false, code: "desktop_approval_denied" };
    },
    async run(input) {
      const workspace = await createMobileBuildWorkspace();
      // Mobile builds never auto-connect MCP servers: consent is the reviewed
      // empty fallback plan, the same shape a renderer without a reachable
      // recommendation service submits.
      const { applyMcpBuildConsent } = await import("../mcp-tools/build-plan");
      const applied = await applyMcpBuildConsent({
        request: input.goal,
        consent: {
          planId: `renderer-mcp-unavailable-mobile-${randomUUID()}`,
          selectedCandidateIds: [],
          fallbackReason: "recommendation_unavailable",
        },
      });
      const { runHephaestusBuild } = await import("../hephaestus/builder");
      await runHephaestusBuild(
        input.runId,
        {
          request: input.goal,
          workspace,
          runtimePinned: false,
          ...(applied.runtime ? { runtime: applied.runtime } : {}),
          mcpAttachment: applied.attachment,
          locale: input.locale,
        },
        input.sink,
        input.signal,
        input.locale,
      );
    },
  };
}
