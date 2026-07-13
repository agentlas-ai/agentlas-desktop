// Agent App public deployment backend.
//
// Security boundaries:
// - renderer input can select only a fixed provider/project; it cannot choose a
//   Keychain account, executable, command, local source path, or external URL.
// - deployment source is the canonical, registry-bound
//   ~/.agentlas/site/agentapp/<app>/astryx-app tree.
// - provider secrets and Vercel/Railway BYOK secrets are read in Electron main,
//   passed through a child environment or stdin/HTTPS request body, and never
//   written to the package, argv, result, persisted Site metadata, or logs.
// - Render deploys an unverified user-owned Git repository, so its service is
//   created without a BYOK secret. The user must add that secret in Render.
// - account creation, provider terms, plan/billing choices, and browser login
//   remain user actions. This module never accepts them on the user's behalf.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import type { LookupFunction } from "node:net";
import { app, shell } from "electron";
import type { ChildProcess } from "node:child_process";
import type { RuntimeBackend } from "../../shared/types";
import type {
  SiteAgentAppPublishRequest,
  SiteAgentAppPublishResult,
  SiteAgentAppDeploymentRecord,
  SiteAgentAppNativePublishApproval,
  SiteLlmProvider,
  SiteProjectMeta,
  SitePublishProvider,
  SitePublishProviderStatus,
} from "../../shared/site-studio";
import { getAgentApp } from "../store/agent-apps";
import {
  deleteSecret,
  describeApiKey,
  ensureApiKeyDescriptor,
  readApiKey,
  readSecret,
  setSecret,
} from "../secrets/vault";
import {
  detachedSpawnOpts,
  killCliTree,
  spawnCli,
  withCliPath,
} from "../runtime/exec";
import {
  getSiteProject,
  appendSiteAgentAppDeployment,
  siteAgentAppsRoot,
} from "./store";

const COMMAND_OUTPUT_LIMIT = 512 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const RENDER_API_TIMEOUT_MS = 30_000;
const DEPLOY_VERIFY_ATTEMPTS = 5;
const DEPLOY_VERIFY_REQUEST_TIMEOUT_MS = 6_000;
const DEPLOY_VERIFY_RETRY_DELAY_MS = 1_500;
const ARTIFACT_FILE_LIMIT = 4_000;
const ARTIFACT_TOTAL_LIMIT = 96 * 1024 * 1024;
const ARTIFACT_SINGLE_FILE_LIMIT = 20 * 1024 * 1024;
const JSON_FILE_LIMIT = 512 * 1024;

const PROVIDER_TOKEN_KEYS: Record<SitePublishProvider, string> = {
  vercel: "site-publish:vercel:access-token",
  railway: "site-publish:railway:account-token",
  render: "site-publish:render:api-key",
};

const PROVIDER_TOKEN_ENV: Record<SitePublishProvider, string> = {
  // Current Vercel CLI reads this natively. Keeping it out of --token avoids
  // process-list and shell-history exposure.
  vercel: "VERCEL_TOKEN",
  // An account/workspace token is required because publish always creates a
  // fresh Railway project. A project-scoped RAILWAY_TOKEN is intentionally not used.
  railway: "RAILWAY_API_TOKEN",
  render: "RENDER_API_KEY",
};

const LLM_ENV: Record<SiteLlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

const APP_ACCESS_ENV = "AGENTLAS_APP_ACCESS_KEY";
const APP_INSTANCE_BUDGET_ENV = "AGENTLAS_APP_INSTANCE_DAILY_BUDGET";

const VERCEL_HEALTH_FUNCTION = `// Main-owned publish health probe. It performs no inference and reads no secret.\nexport default function handler(request, response) {\n  if (request.method !== "GET" && request.method !== "HEAD") {\n    response.status(405).json({ ok: false });\n    return;\n  }\n  response.status(200).json({ ok: true });\n}\n`;

const PROVIDER_CLI: Record<SitePublishProvider, string> = {
  vercel: "vercel",
  railway: "railway",
  render: "render",
};

const PROVIDER_URLS: Record<SitePublishProvider, Record<SiteProviderUrlKind, string>> = {
  vercel: {
    signup: "https://vercel.com/signup",
    token: "https://vercel.com/account/settings/tokens",
    login: "https://vercel.com/login",
    dashboard: "https://vercel.com/dashboard",
    docs: "https://vercel.com/docs/cli",
  },
  railway: {
    signup: "https://railway.com/login",
    token: "https://railway.com/account/tokens",
    login: "https://railway.com/login",
    dashboard: "https://railway.com/dashboard",
    docs: "https://docs.railway.com/cli",
  },
  render: {
    signup: "https://dashboard.render.com/register",
    token: "https://dashboard.render.com/u/settings#api-keys",
    login: "https://dashboard.render.com/login",
    dashboard: "https://dashboard.render.com/",
    docs: "https://render.com/docs/cli",
  },
};

const FREE_PLAN_NOTES: Record<SitePublishProvider, string> = {
  vercel: "Vercel Hobby는 개인·비상업 용도 정책이 적용됩니다. 계정과 사용 목적 적합성은 사용자가 확인해야 합니다.",
  railway: "Railway Free는 제한된 월 크레딧을 사용합니다. 초과 사용과 계정 요금제는 사용자가 확인해야 합니다.",
  render: "Render Free 웹 서비스는 유휴 시 중지될 수 있으며 데모 용도에 적합합니다. 프로덕션 SLA가 아닙니다.",
};

const CONSENT_BOUNDARY = {
  accountCreation: "user-only",
  providerLogin: "user-only",
  providerTerms: "user-only",
  planAndBilling: "user-only",
  deployment: "explicit-request-only",
  llmKeyTransfer: "explicit-request-only",
  renderLlmKeyTransfer: "never",
  autonomousAccountCreation: false,
  autonomousTermsAcceptance: false,
  autonomousPlanChange: false,
} as const;

const SKIPPED_SOURCE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".vercel",
  ".railway",
  "coverage",
  ".next",
  ".turbo",
]);

const TEXT_SOURCE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);

const EMBEDDED_SECRET_PATTERN = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{20,}|\brnd_[A-Za-z0-9_-]{20,}|\bvca_[A-Za-z0-9_-]{20,})/;

export type SiteProviderUrlKind = "signup" | "token" | "login" | "dashboard" | "docs";
export type SitePublishProviderPage = "signup" | "token" | "login";

export type SiteAgentAppPublishConsent = {
  /** The user already owns or created the provider account. */
  providerAccountReady: boolean;
  /** The user handled any provider terms/consent directly on the provider surface. */
  providerTermsHandledByUser: boolean;
  /** The user reviewed the provider plan and any possible billing/usage limits. */
  planConfirmedByUser: boolean;
  /** Approval for this concrete public deployment. */
  deploymentApproved: boolean;
  /** Approval for Vercel/Railway only; Render never receives the Keychain value. */
  llmKeyTransferApproved: boolean;
};

export type SiteAgentAppPublishBackendRequest = SiteAgentAppPublishRequest & {
  consent: SiteAgentAppPublishConsent;
  appAccessKey?: string;
  /** Optional Vercel scope or Railway workspace selected by the user. */
  providerAccountId?: string;
  /** Render workspace/owner ID. Required for Render API service creation. */
  renderOwnerId?: string;
  renderBranch?: string;
  renderRootDir?: string;
  /** Render cannot upload a local directory; the user must confirm the repo contains this generated package. */
  renderRepositoryContainsValidatedPackage?: boolean;
};

export type SiteAgentAppPublishUserAction = {
  code:
    | "account-required"
    | "terms-required"
    | "plan-required"
    | "deployment-approval-required"
    | "llm-key-transfer-approval-required"
    | "llm-key-missing"
    | "app-access-key-required"
    | "native-approval-required"
    | "provider-cli-missing"
    | "provider-login-required"
    | "render-repository-required"
    | "render-owner-required"
    | "render-source-confirmation-required"
    | "render-llm-key-required"
    | "deployment-verification-required"
    | "deployment-contract-missing"
    | "provider-action-required";
  message: string;
  url?: string;
};

export type SiteAgentAppPublishBackendResult = SiteAgentAppPublishResult & {
  status: "published" | "needs-user-action" | "failed";
  packageValidated: boolean;
  providerSource: "local-folder" | "user-confirmed-git-repository";
  userAction?: SiteAgentAppPublishUserAction;
  consentBoundary: typeof CONSENT_BOUNDARY;
};

export type SiteAgentAppPublishProviderStatus = SitePublishProviderStatus & {
  cliInstalled: boolean;
  cliVersion: string | null;
  tokenStored: boolean;
  ready: boolean;
  reason: string | null;
};

export type SiteAgentAppPublishConnectResult = {
  ok: boolean;
  provider: SitePublishProvider;
  status: SiteAgentAppPublishProviderStatus;
  userAction?: SiteAgentAppPublishUserAction;
  consentBoundary: typeof CONSENT_BOUNDARY;
};

export type SiteAgentAppPublishTokenResult = {
  ok: boolean;
  provider: SitePublishProvider;
  stored: boolean;
  status: SiteAgentAppPublishProviderStatus;
  consentBoundary: typeof CONSENT_BOUNDARY;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
};

type ArtifactFile = {
  relativePath: string;
  bytes: number;
  sha256: string;
};

type JsonRecord = Record<string, unknown>;

type ValidatedArtifact = {
  project: SiteProjectMeta;
  sourceRoot: string;
  files: ArtifactFile[];
  packageJson: JsonRecord;
  binding: JsonRecord;
  projectName: string;
  artifactDigest: string;
};

type PreparedProviderSession = {
  provider: "vercel" | "railway";
  executable: string;
  cliVersion: string | null;
  token: string | null;
  env: NodeJS.ProcessEnv;
  accountLabel: string;
  connectionMethod: "token" | "cli";
};

type PreparedRenderSession = {
  provider: "render";
  apiKey: string;
  apiKeyIdentity: string;
  apiKeyFingerprint: string;
  accountLabel: string;
  observedAccountLabel: string | null;
  connectionMethod: "token";
};

type DeploymentAttemptState = {
  deploymentId: string;
  projectId: string;
  artifactAppRecordId: string;
  artifactDigest: string;
  intentDigest: string;
  provider: SitePublishProvider;
  llmProvider: SiteLlmProvider;
  accountLabel: string;
  accountScope: string | null;
  providerProjectId: string | null;
  providerServiceId: string | null;
  providerServiceName: string | null;
  url: string | null;
  transferredSecrets: string[];
  appAccessKeyFingerprint: string | null;
  mutated: boolean;
};

export type SiteAgentAppPublishExecutionOptions = {
  /** Electron main supplies this; absence always fails closed for Vercel/Railway. */
  confirmNativeApproval?: (details: SiteAgentAppNativePublishApproval) => Promise<boolean>;
  /** Internal test seam only. The renderer/IPC contract cannot provide this. */
  verifyDeployment?: (
    provider: "vercel" | "railway",
    url: string,
    appAccessKey: string,
  ) => Promise<SiteDeploymentVerificationResult>;
};

export type SiteDeploymentVerificationResult = {
  ok: boolean;
  pageStatus: number | null;
  healthStatus: number | null;
  apiStatus: number | null;
  apiErrorCode: string | null;
  reason: string | null;
};

type SiteDeploymentProbeResult = { status: number; body: string };

export type SiteDeploymentVerificationDependencies = {
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  requestProbe?: (input: {
    url: string;
    address: string;
    family: 4 | 6;
    timeoutMs: number;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<SiteDeploymentProbeResult>;
  attempts?: number;
  retryDelayMs?: number;
};

const lockedPublishProviders = new Set<SitePublishProvider>();
const lockedPublishLlmProviders = new Set<SiteLlmProvider>();

export function isSitePublishProviderCredentialLocked(provider: SitePublishProvider): boolean {
  return lockedPublishProviders.has(provider);
}

export function isSitePublishLlmCredentialLocked(provider: SiteLlmProvider): boolean {
  return lockedPublishLlmProviders.has(provider);
}

function acquirePublishCredentialLock(
  provider: SitePublishProvider,
  llmProvider: SiteLlmProvider | null,
): (() => void) | null {
  if (lockedPublishProviders.has(provider) || (llmProvider && lockedPublishLlmProviders.has(llmProvider))) return null;
  lockedPublishProviders.add(provider);
  if (llmProvider) lockedPublishLlmProviders.add(llmProvider);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockedPublishProviders.delete(provider);
    if (llmProvider) lockedPublishLlmProviders.delete(llmProvider);
  };
}

class PublishFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly userAction?: SiteAgentAppPublishUserAction,
    readonly providerMutated = false,
  ) {
    super(message);
    this.name = "PublishFailure";
  }
}

function isProvider(value: unknown): value is SitePublishProvider {
  return value === "vercel" || value === "railway" || value === "render";
}

function assertProvider(value: unknown): SitePublishProvider {
  if (!isProvider(value)) throw new Error("지원하지 않는 Site 배포 provider입니다.");
  return value;
}

function cleanSingleLine(value: unknown, max = 160): string {
  return String(value ?? "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\0\r\n<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeOptionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(text)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return text;
}

function providerProjectName(project: SiteProjectMeta): string {
  const base = cleanSingleLine(project.agentAppArtifact?.appName || project.name, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent-app";
  return `agentlas-${base.slice(0, 40)}-${project.id.replace(/-/g, "").slice(0, 8)}`;
}

function minimalCliEnv(extra: NodeJS.ProcessEnv = {}, interactive = false): NodeJS.ProcessEnv {
  const sourcePath = withCliPath({ PATH: process.env.PATH ?? "" }).PATH ?? process.env.PATH ?? "";
  const env: NodeJS.ProcessEnv = {
    PATH: sourcePath,
    HOME: app.getPath("home"),
    TMPDIR: app.getPath("temp"),
    LANG: process.env.LANG || "en_US.UTF-8",
    NO_COLOR: "1",
  };
  for (const key of ["USER", "LOGNAME", "SHELL", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!interactive) env.CI = "1";
  return { ...env, ...extra };
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length <= COMMAND_OUTPUT_LIMIT
    ? next
    : next.slice(next.length - COMMAND_OUTPUT_LIMIT);
}

async function runCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCli(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnFailed: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null, spawnFailed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnFailed });
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendOutput(stderr, chunk); });
    child.stdin?.on("error", () => {
      // Provider may exit before consuming stdin. Never log the attempted payload.
    });
    if (input.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(input.stdin);

    const timer = setTimeout(() => {
      timedOut = true;
      killCliTree(child, 1_500);
    }, input.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, false));
  });
}

async function executableCandidates(command: string): Promise<string[]> {
  const envPath = withCliPath({ PATH: process.env.PATH ?? "" }).PATH ?? "";
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  if (command === "railway") dirs.unshift(path.join(app.getPath("home"), ".railway", "bin"));
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return [...new Set(dirs.flatMap((dir) => extensions.map((extension) => path.join(dir, `${command}${extension}`))))];
}

async function resolveExecutable(command: string): Promise<string | null> {
  for (const candidate of await executableCandidates(command)) {
    try {
      await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      return await fs.realpath(candidate);
    } catch {
      // Try the next fixed PATH candidate.
    }
  }
  return null;
}

async function storedProviderToken(provider: SitePublishProvider): Promise<string | null> {
  const value = await readSecret(PROVIDER_TOKEN_KEYS[provider]);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseVersion(output: string): string | null {
  const clean = cleanSingleLine(output, 200);
  const match = clean.match(/(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? (clean || null);
}

function jsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findNamedString(value: unknown, keys: Set<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamedString(item, keys);
      if (found) return found;
    }
    return null;
  }
  if (!jsonRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && child.trim()) return child.trim();
  }
  for (const child of Object.values(value)) {
    const found = findNamedString(child, keys);
    if (found) return found;
  }
  return null;
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {
    const firstObject = trimmed.indexOf("{");
    const firstArray = trimmed.indexOf("[");
    const start = firstObject < 0 ? firstArray : firstArray < 0 ? firstObject : Math.min(firstObject, firstArray);
    if (start < 0) return null;
    try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
  }
}

async function renderApiRequest(
  apiKey: string,
  pathname: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_API_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(`https://api.render.com/v1${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: controller.signal,
    });
    const raw = (await response.text()).slice(0, COMMAND_OUTPUT_LIMIT);
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function accountLabelFromOutput(provider: SitePublishProvider, output: string): string | null {
  const parsed = parseJsonOutput(output);
  if (parsed) {
    const value = findNamedString(parsed, new Set(["name", "username", "email", "workspaceName"]));
    if (value) return cleanSingleLine(value, 120) || null;
  }
  const clean = cleanSingleLine(output, 160)
    .replace(/^Logged in as\s+/i, "")
    .replace(/^Vercel CLI\s+\S+\s*/i, "")
    .trim();
  if (!clean || /not logged|unauthenticated|error/i.test(clean)) return null;
  return provider === "render" ? null : clean.slice(0, 120);
}

async function probeProviderConnection(
  provider: SitePublishProvider,
  executable: string | null,
  token: string | null,
): Promise<{ connected: boolean; accountLabel: string | null; method: "token" | "cli" | null; reason: string | null }> {
  if (provider === "render") {
    if (!token) {
      return {
        connected: false,
        accountLabel: null,
        method: null,
        reason: "Render API key가 저장되어 있지 않습니다.",
      };
    }
    try {
      const response = await renderApiRequest(token, "/services?limit=1");
      if (response.ok) {
        const label = cleanSingleLine(findNamedString(response.body, new Set(["name", "ownerName"])) ?? "", 120) || null;
        return { connected: true, accountLabel: label, method: "token", reason: null };
      }
      return { connected: false, accountLabel: null, method: null, reason: `Render API 인증이 거부되었습니다 (HTTP ${response.status}).` };
    } catch {
      return { connected: false, accountLabel: null, method: null, reason: "Render API 연결을 확인할 수 없습니다." };
    }
  }
  if (!executable) {
    return { connected: false, accountLabel: null, method: null, reason: `${PROVIDER_CLI[provider]} CLI가 설치되어 있지 않습니다.` };
  }
  const args = provider === "vercel"
    ? ["whoami", "--no-color"]
    : provider === "railway"
      ? ["whoami"]
      : ["workspaces", "--output", "json", "--confirm"];
  const result = await runCommand({
    executable,
    args,
    cwd: app.getPath("home"),
    // Use the exact credential snapshot supplied by the caller. Re-reading
    // Keychain here would permit a token-swap race while a native dialog is up.
    env: minimalCliEnv(token ? { [PROVIDER_TOKEN_ENV[provider]]: token } : {}),
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || result.timedOut || result.spawnFailed) {
    return { connected: false, accountLabel: null, method: null, reason: `${provider} 로그인이 필요합니다.` };
  }
  return {
    connected: true,
    accountLabel: accountLabelFromOutput(provider, `${result.stdout}\n${result.stderr}`),
    method: token ? "token" : "cli",
    reason: null,
  };
}

async function capturePreparedProviderSession(
  provider: "vercel" | "railway",
): Promise<PreparedProviderSession> {
  const token = await storedProviderToken(provider);
  const executable = await resolveExecutable(PROVIDER_CLI[provider]);
  if (!executable) throw new PublishFailure("provider-cli-missing", `${PROVIDER_CLI[provider]} CLI가 없습니다.`, {
    code: "provider-cli-missing",
    message: `${PROVIDER_CLI[provider]} CLI를 설치한 뒤 다시 시도해 주세요.`,
    url: PROVIDER_URLS[provider].docs,
  });
  const version = await runCommand({
    executable,
    args: ["--version"],
    cwd: app.getPath("home"),
    env: minimalCliEnv(),
    timeoutMs: 5_000,
  });
  const cliVersion = version.code === 0 ? parseVersion(`${version.stdout}\n${version.stderr}`) : null;
  const connection = await probeProviderConnection(provider, executable, token);
  if (!connection.connected || !connection.method) {
    throw new PublishFailure("provider-login-required", connection.reason || `${provider} 로그인이 필요합니다.`, {
      code: "provider-login-required",
      message: connection.reason || `${provider} 로그인이 필요합니다.`,
      url: PROVIDER_URLS[provider].token,
    });
  }
  const accountLabel = cleanSingleLine(connection.accountLabel ?? "", 120);
  if (!accountLabel) {
    throw new PublishFailure("provider-account-unidentified", `${provider} 계정 identity를 확인할 수 없습니다.`, {
      code: "provider-login-required",
      message: `${provider} CLI에서 로그인 계정 identity를 확인한 뒤 다시 시도해 주세요.`,
      url: PROVIDER_URLS[provider].dashboard,
    });
  }
  return {
    provider,
    executable,
    cliVersion,
    token,
    env: minimalCliEnv(token ? { [PROVIDER_TOKEN_ENV[provider]]: token } : {}),
    accountLabel,
    connectionMethod: connection.method,
  };
}

async function reverifyPreparedProviderSession(session: PreparedProviderSession): Promise<void> {
  const executable = await fs.realpath(session.executable).catch(() => null);
  if (executable !== session.executable) {
    throw new PublishFailure("provider-session-changed", "Provider CLI identity가 승인 중 변경되었습니다.", {
      code: "provider-login-required",
      message: "Provider CLI 또는 계정 상태가 변경되었습니다. 다시 확인해 주세요.",
      url: PROVIDER_URLS[session.provider].dashboard,
    });
  }
  const connection = await probeProviderConnection(session.provider, session.executable, session.token);
  if (
    !connection.connected ||
    connection.method !== session.connectionMethod ||
    cleanSingleLine(connection.accountLabel ?? "", 120) !== session.accountLabel
  ) {
    throw new PublishFailure("provider-session-changed", "Provider 계정 identity가 승인 중 변경되었습니다.", {
      code: "provider-login-required",
      message: "승인 화면에 표시된 provider 계정과 현재 계정이 다릅니다. 다시 시도해 주세요.",
      url: PROVIDER_URLS[session.provider].dashboard,
    });
  }
}

async function capturePreparedRenderSession(ownerId: string): Promise<PreparedRenderSession> {
  const apiKey = await storedProviderToken("render");
  if (!apiKey) throw new PublishFailure("provider-login-required", "Render API key가 Keychain에 없습니다.", {
    code: "provider-login-required",
    message: "Render API key를 생성해 Keychain에 저장해 주세요.",
    url: PROVIDER_URLS.render.token,
  });
  const connection = await probeProviderConnection("render", null, apiKey);
  if (!connection.connected || connection.method !== "token") {
    throw new PublishFailure("provider-login-required", connection.reason || "Render API 인증이 필요합니다.", {
      code: "provider-login-required",
      message: connection.reason || "Render API key를 다시 확인해 주세요.",
      url: PROVIDER_URLS.render.token,
    });
  }
  const observedAccountLabel = cleanSingleLine(connection.accountLabel ?? "", 120) || null;
  return {
    provider: "render",
    apiKey,
    apiKeyIdentity: `OS credential vault / secret:${PROVIDER_TOKEN_KEYS.render}`,
    apiKeyFingerprint: fullFingerprint(apiKey),
    accountLabel: observedAccountLabel ?? `owner:${ownerId}`,
    observedAccountLabel,
    connectionMethod: "token",
  };
}

async function reverifyPreparedRenderSession(session: PreparedRenderSession): Promise<void> {
  const current = await storedProviderToken("render");
  if (!current || fullFingerprint(current) !== session.apiKeyFingerprint) {
    throw new PublishFailure("provider-session-changed", "Render API key가 native 승인 중 변경되었습니다.", {
      code: "provider-login-required",
      message: "승인 화면에 표시된 Render API key fingerprint와 현재 Keychain 값이 다릅니다. 다시 시도해 주세요.",
      url: PROVIDER_URLS.render.token,
    });
  }
  const connection = await probeProviderConnection("render", null, session.apiKey);
  const observedAccountLabel = cleanSingleLine(connection.accountLabel ?? "", 120) || null;
  if (
    !connection.connected ||
    connection.method !== "token" ||
    observedAccountLabel !== session.observedAccountLabel
  ) {
    throw new PublishFailure("provider-session-changed", "승인된 Render API key를 다시 검증할 수 없습니다.", {
      code: "provider-login-required",
      message: "Render API key와 승인 화면의 계정 identity를 확인한 뒤 다시 시도해 주세요.",
      url: PROVIDER_URLS.render.token,
    });
  }
}

export async function getSiteAgentAppPublishProviderStatus(
  providerInput: SitePublishProvider,
): Promise<SiteAgentAppPublishProviderStatus> {
  const provider = assertProvider(providerInput);
  const token = await storedProviderToken(provider);
  // Render is API-only. Never discover or execute an unrelated binary named
  // `render`, even if one happens to exist on PATH.
  const executable = provider === "render" ? null : await resolveExecutable(PROVIDER_CLI[provider]);
  let cliVersion: string | null = null;
  if (executable) {
    const version = await runCommand({
      executable,
      args: ["--version"],
      cwd: app.getPath("home"),
      env: minimalCliEnv(),
      timeoutMs: 5_000,
    });
    if (version.code === 0) cliVersion = parseVersion(`${version.stdout}\n${version.stderr}`);
  }
  const connection = await probeProviderConnection(provider, executable, token);
  const cliRequired = provider !== "render";
  const ready = connection.connected && (!cliRequired || Boolean(executable));
  return {
    provider,
    connected: connection.connected,
    accountLabel: connection.accountLabel,
    connectionMethod: connection.method,
    freePlanNote: FREE_PLAN_NOTES[provider],
    signupUrl: PROVIDER_URLS[provider].signup,
    tokenUrl: PROVIDER_URLS[provider].token,
    cliInstalled: Boolean(executable),
    cliVersion,
    tokenStored: Boolean(token),
    ready,
    reason: ready ? null : connection.reason,
  };
}

export async function listSiteAgentAppPublishProviderStatuses(): Promise<SiteAgentAppPublishProviderStatus[]> {
  return Promise.all(([
    "vercel",
    "railway",
    "render",
  ] as const).map((provider) => getSiteAgentAppPublishProviderStatus(provider)));
}

function validateProviderToken(value: string): string {
  const token = String(value ?? "").trim();
  if (token.length < 12 || token.length > 4_096 || /[\0-\x20\x7f]/.test(token)) {
    throw new Error("Provider token 형식이 올바르지 않습니다.");
  }
  return token;
}

export async function saveSiteAgentAppPublishProviderToken(input: {
  provider: SitePublishProvider;
  token: string;
}): Promise<SiteAgentAppPublishTokenResult> {
  const provider = assertProvider(input.provider);
  if (isSitePublishProviderCredentialLocked(provider)) {
    throw new Error("이 provider credential은 native 게시 승인 또는 배포 중에는 변경할 수 없습니다.");
  }
  const token = validateProviderToken(input.token);
  await setSecret(PROVIDER_TOKEN_KEYS[provider], token);
  const status = await getSiteAgentAppPublishProviderStatus(provider);
  return { ok: status.connected, provider, stored: true, status, consentBoundary: CONSENT_BOUNDARY };
}

export async function removeSiteAgentAppPublishProviderToken(
  providerInput: SitePublishProvider,
): Promise<SiteAgentAppPublishTokenResult> {
  const provider = assertProvider(providerInput);
  if (isSitePublishProviderCredentialLocked(provider)) {
    throw new Error("이 provider credential은 native 게시 승인 또는 배포 중에는 변경할 수 없습니다.");
  }
  await deleteSecret(PROVIDER_TOKEN_KEYS[provider]);
  const status = await getSiteAgentAppPublishProviderStatus(provider);
  return { ok: true, provider, stored: false, status, consentBoundary: CONSENT_BOUNDARY };
}

export async function openSiteAgentAppPublishProviderUrl(input: {
  provider: SitePublishProvider;
  kind: SiteProviderUrlKind;
}): Promise<{ opened: boolean; provider: SitePublishProvider; kind: SiteProviderUrlKind }> {
  const provider = assertProvider(input.provider);
  if (input.kind !== "signup" && input.kind !== "token" && input.kind !== "login" && input.kind !== "dashboard" && input.kind !== "docs") {
    throw new Error("지원하지 않는 provider URL 종류입니다.");
  }
  await shell.openExternal(PROVIDER_URLS[provider][input.kind]);
  return { opened: true, provider, kind: input.kind };
}

export async function connectSiteAgentAppPublishProvider(
  providerInput: SitePublishProvider,
): Promise<SiteAgentAppPublishConnectResult> {
  const provider = assertProvider(providerInput);
  if (isSitePublishProviderCredentialLocked(provider)) {
    const status = await getSiteAgentAppPublishProviderStatus(provider);
    return {
      ok: false,
      provider,
      status,
      userAction: {
        code: "native-approval-required",
        message: "이 provider는 native 게시 승인 또는 배포 중이므로 로그인 상태를 변경할 수 없습니다.",
      },
      consentBoundary: CONSENT_BOUNDARY,
    };
  }
  const current = await getSiteAgentAppPublishProviderStatus(provider);
  if (current.ready) return { ok: true, provider, status: current, consentBoundary: CONSENT_BOUNDARY };
  if (provider === "render") {
    return {
      ok: false,
      provider,
      status: current,
      userAction: {
        code: "provider-login-required",
        message: current.tokenStored
          ? current.reason || "저장된 Render API key를 다시 확인해 주세요."
          : "Render API key를 생성해 Keychain에 저장해 주세요.",
        url: PROVIDER_URLS.render.token,
      },
      consentBoundary: CONSENT_BOUNDARY,
    };
  }
  const executable = await resolveExecutable(PROVIDER_CLI[provider]);
  if (!executable) {
    return {
      ok: false,
      provider,
      status: current,
      userAction: {
        code: "provider-cli-missing",
        message: `${PROVIDER_CLI[provider]} CLI를 설치하거나 provider token을 저장해 주세요.`,
        url: PROVIDER_URLS[provider].docs,
      },
      consentBoundary: CONSENT_BOUNDARY,
    };
  }
  const result = await runCommand({
    executable,
    args: ["login"],
    cwd: app.getPath("home"),
    // Login itself must not inherit any saved token; it is an explicit browser
    // authorization flow owned by the user.
    env: minimalCliEnv({}, true),
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  const status = await getSiteAgentAppPublishProviderStatus(provider);
  if (result.code === 0 && status.connected) {
    return { ok: true, provider, status, consentBoundary: CONSENT_BOUNDARY };
  }
  return {
    ok: false,
    provider,
    status,
    userAction: {
      code: "provider-login-required",
      message: result.timedOut
        ? "브라우저에서 provider 로그인을 완료한 뒤 다시 연결해 주세요."
        : "Provider 로그인이 완료되지 않았습니다. 브라우저 로그인 또는 token 저장이 필요합니다.",
      url: PROVIDER_URLS[provider].token,
    },
    consentBoundary: CONSENT_BOUNDARY,
  };
}

// Compact IPC-facing aliases. The longer names above remain useful internally
// and preserve a discoverable Site Agent App namespace.
export async function listSitePublishProviderStatuses(): Promise<SiteAgentAppPublishProviderStatus[]> {
  return listSiteAgentAppPublishProviderStatuses();
}

export async function saveSitePublishProviderToken(
  provider: SitePublishProvider,
  token: string,
): Promise<SiteAgentAppPublishTokenResult> {
  return saveSiteAgentAppPublishProviderToken({ provider, token });
}

export async function removeSitePublishProviderToken(
  provider: SitePublishProvider,
): Promise<SiteAgentAppPublishTokenResult> {
  return removeSiteAgentAppPublishProviderToken(provider);
}

export async function openSitePublishProviderPage(
  provider: SitePublishProvider,
  page: SitePublishProviderPage,
): Promise<{ opened: boolean; provider: SitePublishProvider; page: SitePublishProviderPage }> {
  const result = await openSiteAgentAppPublishProviderUrl({ provider, kind: page });
  return { opened: result.opened, provider: result.provider, page };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBoundedCanonicalFile(
  root: string,
  filePath: string,
  limit: number,
): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  if (!isInside(root, resolved)) throw new Error("배포 artifact 파일 경로가 안전하지 않습니다.");
  const canonical = await fs.realpath(resolved);
  if (canonical !== resolved || !isInside(root, canonical)) {
    throw new Error("배포 artifact에 symlink 또는 root 밖 경로가 포함되어 있습니다.");
  }
  const handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("배포 artifact 파일 크기 또는 형식이 올바르지 않습니다.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readJsonObject(root: string, filePath: string, limit = JSON_FILE_LIMIT): Promise<JsonRecord> {
  const bytes = await readBoundedCanonicalFile(root, filePath, limit);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error(`${path.basename(filePath)} JSON이 손상되었습니다.`);
  }
  if (!jsonRecord(value)) throw new Error(`${path.basename(filePath)} 형식이 올바르지 않습니다.`);
  return value;
}

function assertSafeArtifactFileName(relativePath: string): void {
  const base = path.basename(relativePath).toLowerCase();
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === ".yarnrc" ||
    base === ".netrc" ||
    base === ".pypirc" ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(base)
  ) {
    throw new Error(`배포 artifact에 허용되지 않는 secret 파일이 있습니다: ${relativePath}`);
  }
}

async function validateArtifactTree(sourceRoot: string): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      if (entry.name.includes("\0") || entry.name === "." || entry.name === "..") {
        throw new Error("배포 artifact 파일명이 올바르지 않습니다.");
      }
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(sourceRoot, absolute);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("배포 artifact 경로가 root 밖을 가리킵니다.");
      }
      if (entry.isSymbolicLink()) throw new Error(`배포 artifact에 symlink가 있습니다: ${relativePath}`);
      if (entry.isDirectory()) {
        if (SKIPPED_SOURCE_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`배포 artifact에 일반 파일이 아닌 항목이 있습니다: ${relativePath}`);
      assertSafeArtifactFileName(relativePath);
      const canonical = await fs.realpath(absolute);
      if (canonical !== path.resolve(absolute) || !isInside(sourceRoot, canonical)) {
        throw new Error(`배포 artifact 파일 경로가 변경되었거나 안전하지 않습니다: ${relativePath}`);
      }
      const stat = await fs.lstat(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARTIFACT_SINGLE_FILE_LIMIT) {
        throw new Error(`배포 artifact 파일이 너무 크거나 안전하지 않습니다: ${relativePath}`);
      }
      total += stat.size;
      if (files.length >= ARTIFACT_FILE_LIMIT || total > ARTIFACT_TOTAL_LIMIT) {
        throw new Error("배포 artifact가 허용된 파일 수 또는 전체 크기를 초과했습니다.");
      }
      const bytes = await readBoundedCanonicalFile(sourceRoot, canonical, ARTIFACT_SINGLE_FILE_LIMIT);
      if (bytes.byteLength !== stat.size) throw new Error(`배포 artifact 파일이 검증 중 변경되었습니다: ${relativePath}`);
      files.push({
        relativePath,
        bytes: stat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (stat.size <= 1024 * 1024 && TEXT_SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
        const text = bytes.toString("utf8");
        if (EMBEDDED_SECRET_PATTERN.test(text)) {
          throw new Error(`배포 artifact 소스에 secret 값으로 보이는 문자열이 있습니다: ${relativePath}`);
        }
      }
    }
  };
  await walk(sourceRoot);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function artifactTreeDigest(files: ArtifactFile[]): string {
  const digest = createHash("sha256");
  digest.update("agentlas-site-publish-artifact-v1\0", "utf8");
  for (const file of files) {
    digest.update(`${Buffer.byteLength(file.relativePath, "utf8")}:`, "utf8");
    digest.update(file.relativePath, "utf8");
    digest.update(`\0${file.bytes}\0${file.sha256}\0`, "utf8");
  }
  return digest.digest("hex");
}

function nestedRecord(value: JsonRecord, key: string): JsonRecord | null {
  const child = value[key];
  return jsonRecord(child) ? child : null;
}

function dependencyVersion(packageJson: JsonRecord, section: string, name: string): string | null {
  const dependencies = nestedRecord(packageJson, section);
  return typeof dependencies?.[name] === "string" ? dependencies[name] as string : null;
}

function scriptValue(packageJson: JsonRecord, name: string): string | null {
  const scripts = nestedRecord(packageJson, "scripts");
  return typeof scripts?.[name] === "string" ? (scripts[name] as string).trim() : null;
}

function assertProjectBinding(project: SiteProjectMeta, binding: JsonRecord): void {
  const target = nestedRecord(binding, "target");
  const design = nestedRecord(binding, "designSystem");
  const runtime = nestedRecord(binding, "runtime");
  if (
    !project.agentAppTarget ||
    target?.kind !== project.agentAppTarget.kind ||
    target?.name !== project.agentAppTarget.name ||
    target?.description !== project.agentAppTarget.description ||
    target?.memberCount !== project.agentAppTarget.memberCount ||
    Object.prototype.hasOwnProperty.call(target ?? {}, "id") ||
    design?.package !== "@astryxdesign/core" ||
    design?.version !== "0.1.4" ||
    runtime?.mode !== "same-origin-agent-runtime" ||
    runtime?.localEndpoint !== "/__agentlas/v1/run" ||
    runtime?.publicEndpoint !== "/api/run"
  ) {
    throw new Error("Astryx public runtime binding이 Site 프로젝트와 일치하지 않습니다.");
  }
  const forbiddenKeys = new Set([
    "systemprompt",
    "memory",
    "credentials",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "capability",
    "secret",
  ]);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!jsonRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (forbiddenKeys.has(normalized)) {
        throw new Error(`Public binding에 허용되지 않는 필드가 있습니다: ${key}`);
      }
      inspect(child);
    }
  };
  inspect(binding);
}

async function validateDeployableContract(
  artifact: ValidatedArtifact,
  provider: SitePublishProvider,
  llmProvider: SiteLlmProvider,
): Promise<void> {
  const fileSet = new Set(artifact.files.map((file) => file.relativePath.replaceAll(path.sep, "/")));
  if (!scriptValue(artifact.packageJson, "build")) {
    throw new PublishFailure("deployment-contract-missing", "Astryx package에 production build script가 없습니다.", {
      code: "deployment-contract-missing",
      message: "Agent App을 다시 생성해 public runtime 계약을 포함해 주세요.",
    });
  }
  if (provider === "vercel" && !["api/run.mjs", "api/run.js", "api/run.cjs", "api/run.ts"].some((file) => fileSet.has(file))) {
    throw new PublishFailure("deployment-contract-missing", "Vercel /api/run 함수가 없습니다.", {
      code: "deployment-contract-missing",
      message: "Agent App을 다시 생성해 Vercel public runtime을 포함해 주세요.",
    });
  }
  if ((provider === "railway" || provider === "render") && (!fileSet.has("server.mjs") || !scriptValue(artifact.packageJson, "start"))) {
    throw new PublishFailure("deployment-contract-missing", `${provider} 실행 서버 계약이 없습니다.`, {
      code: "deployment-contract-missing",
      message: "Agent App을 다시 생성해 server.mjs와 start script를 포함해 주세요.",
    });
  }
  const sourceFiles = artifact.files.filter((file) => /\.(?:cjs|js|mjs|ts)$/.test(file.relativePath));
  let source = "";
  for (const file of sourceFiles) {
    if (file.bytes > 1024 * 1024) continue;
    source += `\n${(await readBoundedCanonicalFile(artifact.sourceRoot, path.join(artifact.sourceRoot, file.relativePath), 1024 * 1024)).toString("utf8")}`;
  }
  if (!source.includes(LLM_ENV[llmProvider]) || source.includes(`VITE_${LLM_ENV[llmProvider]}`)) {
    throw new PublishFailure("deployment-contract-missing", "선택한 BYOK provider의 server-only env 계약이 없습니다.", {
      code: "deployment-contract-missing",
      message: "Agent App을 다시 생성해 선택한 LLM provider runtime을 포함해 주세요.",
    });
  }
  if (!source.includes(APP_ACCESS_ENV) || source.includes(`VITE_${APP_ACCESS_ENV}`)) {
    throw new PublishFailure("deployment-contract-missing", "공개 Agent App access-key 계약이 없습니다.", {
      code: "deployment-contract-missing",
      message: "Agent App을 다시 생성해 server-only access-key 인증 계약을 포함해 주세요.",
    });
  }
}

async function validateSiteAgentAppArtifact(
  projectId: string,
  provider: SitePublishProvider,
  llmProvider: SiteLlmProvider,
): Promise<ValidatedArtifact> {
  const project = getSiteProject(projectId);
  const artifact = project.agentAppArtifact;
  if (project.surface !== "agent-app" || !project.agentAppTarget || !artifact || artifact.status !== "ready") {
    throw new Error("배포 가능한 ready 상태의 Agent App artifact가 없습니다.");
  }
  const record = getAgentApp(artifact.appRecordId);
  if (
    !record ||
    record.surfaceId !== `site:${project.id}` ||
    record.scaffold.appId !== artifact.appId ||
    path.resolve(record.rootPath) !== path.resolve(artifact.rootPath)
  ) {
    throw new Error("Site 프로젝트와 AppFactory registry binding이 일치하지 않습니다.");
  }
  const allowedRoot = await fs.realpath(siteAgentAppsRoot());
  const artifactRoot = await fs.realpath(artifact.rootPath);
  if (!isInside(allowedRoot, artifactRoot)) throw new Error("Agent App artifact가 허용된 Site root 밖에 있습니다.");
  const recordRoot = await fs.realpath(record.rootPath);
  if (recordRoot !== artifactRoot) throw new Error("Agent App registry canonical root가 일치하지 않습니다.");
  const sourceRoot = await fs.realpath(path.join(artifactRoot, "astryx-app"));
  if (!isInside(artifactRoot, sourceRoot)) throw new Error("Astryx package root가 Agent App artifact 밖에 있습니다.");

  const packageJson = await readJsonObject(sourceRoot, path.join(sourceRoot, "package.json"));
  const binding = await readJsonObject(sourceRoot, path.join(sourceRoot, "public", "agentlas.binding.json"));
  if (
    dependencyVersion(packageJson, "dependencies", "@astryxdesign/core") !== "0.1.4" ||
    dependencyVersion(packageJson, "dependencies", "@astryxdesign/theme-neutral") !== "0.1.4" ||
    dependencyVersion(packageJson, "dependencies", "react") !== "19.1.0"
  ) {
    throw new Error("Astryx/React dependency pin이 Agentlas Site 계약과 일치하지 않습니다.");
  }
  assertProjectBinding(project, binding);
  const files = await validateArtifactTree(sourceRoot);
  const validated: ValidatedArtifact = {
    project,
    sourceRoot,
    files,
    packageJson,
    binding,
    projectName: providerProjectName(project),
    artifactDigest: artifactTreeDigest(files),
  };
  await validateDeployableContract(validated, provider, llmProvider);
  return validated;
}

async function copyValidatedArtifact(artifact: ValidatedArtifact): Promise<string> {
  const createdRoot = await fs.mkdtemp(path.join(app.getPath("temp"), "agentlas-site-publish-"));
  const temporaryRoot = await fs.realpath(createdRoot);
  await fs.chmod(temporaryRoot, 0o700).catch(() => undefined);
  try {
    for (const file of artifact.files) {
      const source = path.join(artifact.sourceRoot, file.relativePath);
      const destination = path.join(temporaryRoot, file.relativePath);
      if (!isInside(temporaryRoot, destination)) throw new Error("배포 package 복사 경로가 안전하지 않습니다.");
      const canonical = await fs.realpath(source);
      if (canonical !== path.resolve(source) || !isInside(artifact.sourceRoot, canonical)) {
        throw new Error("배포 package 복사 중 source 경로가 변경되었습니다.");
      }
      const handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.bytes) throw new Error("배포 package 복사 중 source 파일이 변경되었습니다.");
        bytes = await handle.readFile();
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
          throw new Error("배포 package 복사 중 source 내용이 변경되었습니다.");
        }
      } finally {
        await handle.close();
      }
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
    }
    return temporaryRoot;
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function prepareDeploymentArtifact(
  artifact: ValidatedArtifact,
  provider: "vercel" | "railway",
): Promise<{ root: string; digest: string }> {
  const root = await copyValidatedArtifact(artifact);
  try {
    if (provider === "vercel") {
      const healthPath = path.join(root, "api", "healthz.mjs");
      await fs.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(healthPath, VERCEL_HEALTH_FUNCTION, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await fs.readFile(healthPath, "utf8");
        if (existing !== VERCEL_HEALTH_FUNCTION) {
          throw new Error("Vercel /healthz publish shim이 main-owned 계약과 충돌합니다.");
        }
      }
    }
    const files = await validateArtifactTree(root);
    return { root, digest: artifactTreeDigest(files) };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function requireConsent(input: SiteAgentAppPublishBackendRequest): SiteAgentAppPublishBackendResult | null {
  const common = {
    ok: false,
    provider: input.provider,
    status: "needs-user-action" as const,
    packageValidated: false,
    providerSource: input.provider === "render" ? "user-confirmed-git-repository" as const : "local-folder" as const,
    consentBoundary: CONSENT_BOUNDARY,
  };
  if (!input.consent?.providerAccountReady) return {
    ...common,
    reason: "Provider 계정 준비가 필요합니다.",
    userAction: { code: "account-required", message: "Provider 계정 생성과 로그인은 사용자가 직접 완료해야 합니다.", url: PROVIDER_URLS[input.provider].signup },
  };
  if (!input.consent.providerTermsHandledByUser) return {
    ...common,
    reason: "Provider 약관 확인이 필요합니다.",
    userAction: { code: "terms-required", message: "Provider 약관과 필수 동의는 provider 화면에서 사용자가 직접 처리해야 합니다.", url: PROVIDER_URLS[input.provider].dashboard },
  };
  if (!input.consent.planConfirmedByUser) return {
    ...common,
    reason: "Provider plan 확인이 필요합니다.",
    userAction: { code: "plan-required", message: FREE_PLAN_NOTES[input.provider], url: PROVIDER_URLS[input.provider].dashboard },
  };
  if (!input.consent.deploymentApproved) return {
    ...common,
    reason: "배포 승인이 필요합니다.",
    userAction: { code: "deployment-approval-required", message: "이 Agent App의 공개 배포를 명시적으로 승인해 주세요." },
  };
  // A Render repository is user-controlled and is not cryptographically tied
  // to the validated local artifact. Never authorize or perform a Keychain
  // secret transfer to that trust boundary.
  if (input.provider !== "render" && !input.consent.llmKeyTransferApproved) return {
    ...common,
    reason: "BYOK secret 전송 승인이 필요합니다.",
    userAction: { code: "llm-key-transfer-approval-required", message: "선택한 BYOK 키를 provider secret storage로 복사하는 작업을 승인해 주세요." },
  };
  return null;
}

function assertCommandSucceeded(
  result: CommandResult,
  code: string,
  message: string,
  provider: SitePublishProvider,
  providerMutated = false,
): void {
  if (result.code === 0 && !result.timedOut && !result.spawnFailed) return;
  const suffix = result.timedOut ? " (시간 초과)" : result.spawnFailed ? " (CLI 실행 실패)" : "";
  throw new PublishFailure(code, `${message}${suffix}`, {
    code: "provider-action-required",
    message: `${message} Provider dashboard에서 상태를 확인한 뒤 다시 시도해 주세요.`,
    url: PROVIDER_URLS[provider].dashboard,
  }, providerMutated);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return null;
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

const unsafeDeploymentAddresses = (() => {
  const block = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) block.addSubnet(network, prefix, "ipv4");
  block.addAddress("::", "ipv6");
  block.addAddress("::1", "ipv6");
  // Node's BlockList maps IPv4 checks through IPv4-mapped IPv6 internally.
  // Blocking the entire ::ffff:0:0/96 range would therefore reject every
  // public IPv4 address too; the IPv4 ranges above still match mapped private
  // addresses such as ::ffff:127.0.0.1.
  block.addSubnet("fc00::", 7, "ipv6");
  block.addSubnet("fe80::", 10, "ipv6");
  block.addSubnet("ff00::", 8, "ipv6");
  block.addSubnet("2001:db8::", 32, "ipv6");
  return block;
})();

class UnsafeDeploymentAddressError extends Error {
  constructor() {
    super("배포 검증 대상 DNS가 private, loopback, link-local 또는 예약 주소를 반환했습니다.");
    this.name = "UnsafeDeploymentAddressError";
  }
}

/** Restrict verification to provider-generated domains; custom URLs are not fetched. */
export function normalizeProviderDeploymentUrl(
  provider: "vercel" | "railway",
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("배포 검증 URL이 없습니다.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("배포 검증 URL 형식이 올바르지 않습니다."); }
  const hostname = url.hostname.toLowerCase();
  const suffix = provider === "vercel" ? ".vercel.app" : ".up.railway.app";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !hostname.endsWith(suffix) ||
    hostname === suffix.slice(1)
  ) {
    throw new Error(`${provider}가 생성한 ${suffix} HTTPS URL만 자동 검증할 수 있습니다.`);
  }
  return `https://${hostname}/`;
}

async function defaultResolveDeploymentHost(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows
    .filter((row): row is { address: string; family: 4 | 6 } => row.family === 4 || row.family === 6)
    .map((row) => ({ address: row.address, family: row.family }));
}

async function defaultRequestDeploymentProbe(input: {
  url: string;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<SiteDeploymentProbeResult> {
  const target = new URL(input.url);
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, input.address, input.family);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | null = null;
    const finish = (error: Error | null, result?: SiteDeploymentProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { status: 0, body: "" });
    };
    const timer = setTimeout(() => {
      request?.destroy(new Error("deployment-verification-timeout"));
    }, input.timeoutMs);
    timer.unref?.();
    request = httpsRequest({
      protocol: "https:",
      hostname: target.hostname,
      port: 443,
      method: input.method,
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      lookup: pinnedLookup,
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.1",
        "User-Agent": "Agentlas-Site-Deploy-Verify/1",
        ...(input.headers ?? {}),
        ...(input.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(input.body)) }),
      },
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (bytes >= JSON_FILE_LIMIT) return;
        const remaining = JSON_FILE_LIMIT - bytes;
        const value = Buffer.from(chunk).subarray(0, remaining);
        bytes += value.length;
        chunks.push(value);
      });
      response.once("end", () => {
        finish(null, { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        request?.destroy();
      });
      response.once("error", (error) => finish(error));
    });
    request.once("error", (error) => finish(error));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

function deploymentAddressIsUnsafe(address: string, family: 4 | 6): boolean {
  return unsafeDeploymentAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Bounded, inference-free HTTPS verification for the public static page,
 * /healthz, and the authenticated invalid-input /api/run contract. DNS is
 * checked and then pinned into the TLS request to avoid a resolve/check/fetch
 * rebinding gap.
 */
export async function verifySiteAgentAppDeployment(
  provider: "vercel" | "railway",
  inputUrl: string,
  appAccessKey: string,
  dependencies: SiteDeploymentVerificationDependencies = {},
): Promise<SiteDeploymentVerificationResult> {
  const accessKey = validateAppAccessKey(appAccessKey);
  const rootUrl = normalizeProviderDeploymentUrl(provider, inputUrl);
  const pageUrl = rootUrl;
  const healthUrl = new URL("/healthz", rootUrl).toString();
  const apiUrl = new URL("/api/run", rootUrl).toString();
  const resolveHost = dependencies.resolveHost ?? defaultResolveDeploymentHost;
  const requestProbe = dependencies.requestProbe ?? defaultRequestDeploymentProbe;
  const attempts = Math.max(1, Math.min(10, Math.floor(dependencies.attempts ?? DEPLOY_VERIFY_ATTEMPTS)));
  const retryDelayMs = Math.max(0, Math.min(10_000, Math.floor(dependencies.retryDelayMs ?? DEPLOY_VERIFY_RETRY_DELAY_MS)));
  let pageStatus: number | null = null;
  let healthStatus: number | null = null;
  let apiStatus: number | null = null;
  let apiErrorCode: string | null = null;
  let reason = "배포 URL이 아직 준비되지 않았습니다.";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const hostname = new URL(rootUrl).hostname;
      const addresses = await resolveHost(hostname);
      if (!addresses.length || addresses.some((entry) => deploymentAddressIsUnsafe(entry.address, entry.family))) {
        throw new UnsafeDeploymentAddressError();
      }
      const address = addresses[attempt % addresses.length];
      const [page, health, api] = await Promise.all([
        requestProbe({ url: pageUrl, ...address, timeoutMs: DEPLOY_VERIFY_REQUEST_TIMEOUT_MS, method: "GET" }),
        requestProbe({ url: healthUrl, ...address, timeoutMs: DEPLOY_VERIFY_REQUEST_TIMEOUT_MS, method: "GET" }),
        requestProbe({
          url: apiUrl,
          ...address,
          timeoutMs: DEPLOY_VERIFY_REQUEST_TIMEOUT_MS,
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessKey}`,
            "Content-Type": "application/json",
          },
          // This fails in validateInputs before usage accounting or providerCall.
          body: "{}",
        }),
      ]);
      pageStatus = page.status;
      healthStatus = health.status;
      apiStatus = api.status;
      try {
        const parsed = JSON.parse(api.body) as { error?: { code?: unknown } };
        apiErrorCode = typeof parsed?.error?.code === "string" ? parsed.error.code : null;
      } catch {
        apiErrorCode = null;
      }
      if (
        pageStatus >= 200 && pageStatus < 300 &&
        healthStatus >= 200 && healthStatus < 300 &&
        apiStatus === 400 && apiErrorCode === "invalid-input"
      ) {
        return { ok: true, pageStatus, healthStatus, apiStatus, apiErrorCode, reason: null };
      }
      reason = `공개 페이지 HTTP ${pageStatus || "응답 없음"}, /healthz HTTP ${healthStatus || "응답 없음"}, 인증된 /api/run contract HTTP ${apiStatus || "응답 없음"} (${apiErrorCode ?? "expected invalid-input 없음"}).`;
    } catch (error) {
      reason = cleanSingleLine(error instanceof Error ? error.message : String(error), 500) || "배포 HTTPS 검증에 실패했습니다.";
      if (error instanceof UnsafeDeploymentAddressError) {
        return { ok: false, pageStatus, healthStatus, apiStatus, apiErrorCode, reason };
      }
    }
    if (attempt + 1 < attempts && retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }
  }
  return { ok: false, pageStatus, healthStatus, apiStatus, apiErrorCode, reason };
}

function findHttpsUrl(value: unknown): string | null {
  if (typeof value === "string") return safeHttpsUrl(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findHttpsUrl(child);
      if (found) return found;
    }
    return null;
  }
  if (!jsonRecord(value)) return null;
  for (const key of ["url", "domain", "deploymentUrl", "serviceDomain", "dashboardUrl"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      const normalized = candidate.startsWith("http") ? candidate : `https://${candidate}`;
      const found = safeHttpsUrl(normalized);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = findHttpsUrl(child);
    if (found) return found;
  }
  return null;
}

function collectProviderUrlCandidates(value: unknown, candidates: string[]): void {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (candidate) candidates.push(candidate);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectProviderUrlCandidates(child, candidates);
    return;
  }
  if (!jsonRecord(value)) return;
  for (const child of Object.values(value)) collectProviderUrlCandidates(child, candidates);
}

/** Select the provider-generated public domain, never the first dashboard URL in CLI output. */
export function providerGeneratedUrlFromCommandOutput(
  provider: "vercel" | "railway",
  output: string,
): string | null {
  const candidates: string[] = [];
  const withoutAnsi = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  for (const match of withoutAnsi.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    candidates.push(match[0].replace(/[),.;]+$/, ""));
  }
  collectProviderUrlCandidates(parseJsonOutput(withoutAnsi), candidates);
  for (const candidate of candidates) {
    const withScheme = /^https:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      return normalizeProviderDeploymentUrl(provider, withScheme);
    } catch {
      // Inspect/dashboard/custom URLs are intentionally skipped. Automatic
      // verification is restricted to the generated provider suffix.
    }
  }
  return null;
}

function railwayProjectId(value: unknown): string | null {
  if (!jsonRecord(value)) return null;
  const project = jsonRecord(value.project) ? value.project : null;
  const candidate = project?.id ?? value.projectId ?? value.id;
  return typeof candidate === "string" && /^[A-Za-z0-9-]{6,100}$/.test(candidate) ? candidate : null;
}

async function loadLlmKey(provider: SiteLlmProvider): Promise<string> {
  const key = await readApiKey(provider as RuntimeBackend);
  if (!key) {
    throw new PublishFailure("llm-key-missing", `${provider} BYOK 키가 Keychain에 없습니다.`, {
      code: "llm-key-missing",
      message: `Settings에서 ${provider} BYOK 키를 먼저 저장해 주세요.`,
    });
  }
  return key;
}

function validateAppAccessKey(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  if (key.length < 32 || key.length > 256 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new PublishFailure("app-access-key-required", "공개 Agent App access passcode가 필요합니다.", {
      code: "app-access-key-required",
      message: "32~256자의 공백 없는 printable ASCII access passcode를 입력해 주세요.",
    });
  }
  return key;
}

function fullFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function assertApprovedArtifactCopy(
  approvedDigest: string,
  packageRoot: string,
): Promise<void> {
  const copiedFiles = await validateArtifactTree(packageRoot);
  if (artifactTreeDigest(copiedFiles) === approvedDigest) return;
  throw new PublishFailure("approved-artifact-changed", "Native 승인에 표시된 배포 artifact가 변경되었습니다.", {
    code: "deployment-contract-missing",
    message: "승인된 artifact와 실제 배포 package가 다릅니다. Agent App을 다시 생성한 뒤 게시해 주세요.",
  });
}

async function deployVercel(
  artifact: ValidatedArtifact,
  packageRoot: string,
  input: SiteAgentAppPublishBackendRequest,
  session: PreparedProviderSession,
  accountScope: string | undefined,
  llmKey: string,
  appAccessKey: string,
  attempt: DeploymentAttemptState,
): Promise<{ url: string; providerProjectId: string }> {
  if (session.provider !== "vercel") throw new Error("Vercel provider session이 일치하지 않습니다.");
  const executable = session.executable;
  const env = session.env;
  const scopeArgs = accountScope ? ["--scope", accountScope] : [];
  // The provider may commit this mutation and lose the CLI response. Record
  // the deterministic project intent before spawning so a timeout cannot
  // erase orphan-resource truth or allow an automatic duplicate retry.
  attempt.mutated = true;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "mutation-attempted",
    reason: "Vercel project link/create mutation을 시작했습니다. 응답이 유실되면 receipt는 알 수 없지만 원격 resource가 존재할 수 있습니다.",
  });
  const link = await runCommand({
    executable,
    args: ["link", "--yes", "--project", artifact.projectName, "--cwd", packageRoot, "--no-color", ...scopeArgs],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(link, "vercel-link-failed", "Vercel project 연결에 실패했습니다.", "vercel", true);
  const projectJson = await readJsonObject(packageRoot, path.join(packageRoot, ".vercel", "project.json"));
  const providerProjectId = typeof projectJson.projectId === "string" && projectJson.projectId.trim()
    ? projectJson.projectId.trim().slice(0, 200)
    : artifact.projectName;
  attempt.providerProjectId = providerProjectId;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "resource-created",
    reason: "Vercel project가 연결되었습니다. 아직 공개 검증은 완료되지 않았습니다.",
  });

  const selector = await runCommand({
    executable,
    args: ["env", "add", "AGENTLAS_LLM_PROVIDER", "production", "--force", "--cwd", packageRoot, "--no-color", ...scopeArgs],
    cwd: packageRoot,
    env,
    stdin: `${input.llmProvider}\n`,
  });
  assertCommandSucceeded(selector, "vercel-env-failed", "Vercel runtime provider 설정에 실패했습니다.", "vercel", true);

  attempt.transferredSecrets = [...new Set([...attempt.transferredSecrets, APP_ACCESS_ENV])];
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transfer-attempted",
    reason: `${APP_ACCESS_ENV} secret 전송을 시작했습니다. 응답이 유실되면 provider에 남아 있을 수 있습니다.`,
  });
  const accessSecret = await runCommand({
    executable,
    args: ["env", "add", APP_ACCESS_ENV, "production", "--sensitive", "--force", "--cwd", packageRoot, "--no-color", ...scopeArgs],
    cwd: packageRoot,
    env,
    stdin: `${appAccessKey}\n`,
  });
  assertCommandSucceeded(accessSecret, "vercel-access-secret-failed", "Vercel app access secret 저장에 실패했습니다.", "vercel", true);
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transferred",
    reason: `${APP_ACCESS_ENV}가 Vercel server secret storage에 전송되었습니다.`,
  });

  attempt.transferredSecrets = [...new Set([...attempt.transferredSecrets, LLM_ENV[input.llmProvider]])];
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transfer-attempted",
    reason: `${LLM_ENV[input.llmProvider]} secret 전송을 시작했습니다. 응답이 유실되면 provider에 남아 있을 수 있습니다.`,
  });
  const secret = await runCommand({
    executable,
    args: ["env", "add", LLM_ENV[input.llmProvider], "production", "--sensitive", "--force", "--cwd", packageRoot, "--no-color", ...scopeArgs],
    cwd: packageRoot,
    env,
    stdin: `${llmKey}\n`,
  });
  assertCommandSucceeded(secret, "vercel-secret-failed", "Vercel sensitive env 저장에 실패했습니다.", "vercel", true);
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transferred",
    reason: `${LLM_ENV[input.llmProvider]}가 Vercel server secret storage에 전송되었습니다.`,
  });

  const deployment = await runCommand({
    executable,
    args: ["deploy", "--prod", "--yes", "--cwd", packageRoot, "--no-color", ...scopeArgs],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(deployment, "vercel-deploy-failed", "Vercel production deploy에 실패했습니다.", "vercel", true);
  const url = providerGeneratedUrlFromCommandOutput("vercel", `${deployment.stdout}\n${deployment.stderr}`);
  if (!url) throw new PublishFailure("vercel-url-missing", "Vercel 배포 URL을 확인할 수 없습니다.", {
    code: "provider-action-required",
    message: "Vercel dashboard에서 배포 URL과 상태를 확인해 주세요.",
    url: PROVIDER_URLS.vercel.dashboard,
  }, true);
  attempt.url = url;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "resource-created",
    reason: "Vercel production URL을 받았으며 공개 contract 검증을 기다리고 있습니다.",
  });
  return { url, providerProjectId };
}

async function deployRailway(
  artifact: ValidatedArtifact,
  packageRoot: string,
  input: SiteAgentAppPublishBackendRequest,
  session: PreparedProviderSession,
  accountScope: string | undefined,
  llmKey: string,
  appAccessKey: string,
  attempt: DeploymentAttemptState,
): Promise<{ url: string; providerProjectId: string }> {
  if (session.provider !== "railway") throw new Error("Railway provider session이 일치하지 않습니다.");
  const executable = session.executable;
  const env = session.env;
  attempt.mutated = true;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "mutation-attempted",
    reason: "Railway project create mutation을 시작했습니다. 응답이 유실되면 receipt는 알 수 없지만 원격 resource가 존재할 수 있습니다.",
  });
  const init = await runCommand({
    executable,
    args: ["init", "--name", artifact.projectName, ...(accountScope ? ["--workspace", accountScope] : []), "--json"],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(init, "railway-init-failed", "새 Railway project 생성에 실패했습니다.", "railway", true);
  const initProjectId = railwayProjectId(parseJsonOutput(init.stdout));
  if (initProjectId) {
    attempt.providerProjectId = initProjectId;
    await persistPublishReceipt({
      attempt,
      status: "provisioning",
      phase: "resource-created",
      reason: "Railway init 응답에서 project ID를 받았습니다. 아직 service와 공개 검증은 완료되지 않았습니다.",
    });
  }

  const status = await runCommand({ executable, args: ["status", "--json"], cwd: packageRoot, env });
  assertCommandSucceeded(status, "railway-status-failed", "새 Railway project 상태를 확인할 수 없습니다.", "railway", true);
  const providerProjectId = railwayProjectId(parseJsonOutput(status.stdout))
    ?? initProjectId;
  if (!providerProjectId) throw new PublishFailure("railway-project-id-missing", "새 Railway project ID를 확인할 수 없습니다.", {
    code: "provider-action-required",
    message: "Railway dashboard에서 새 project를 확인해 주세요.",
    url: PROVIDER_URLS.railway.dashboard,
  }, true);
  attempt.providerProjectId = providerProjectId;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "resource-created",
    reason: "Railway project가 생성되었습니다. 아직 service와 공개 검증은 완료되지 않았습니다.",
  });

  const serviceName = `${artifact.projectName}-web`.slice(0, 80);
  attempt.providerServiceName = serviceName;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "mutation-attempted",
    reason: `Railway service ${serviceName} create mutation을 시작했습니다. 응답이 유실되면 service가 존재할 수 있습니다.`,
  });
  const addService = await runCommand({
    executable,
    args: ["add", "--service", serviceName, "--json"],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(addService, "railway-service-failed", "새 Railway service 생성에 실패했습니다.", "railway", true);
  const parsedService = parseJsonOutput(`${addService.stdout}\n${addService.stderr}`);
  attempt.providerServiceId = findNamedString(parsedService, new Set(["serviceId", "id"]));
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "service-created",
    reason: "Railway service가 생성되었습니다. 아직 secret과 공개 검증은 완료되지 않았습니다.",
  });

  const link = await runCommand({
    executable,
    args: ["link", "--project", providerProjectId, "--environment", "production", "--service", serviceName, "--json"],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(link, "railway-link-failed", "새 Railway project/service 명시 연결에 실패했습니다.", "railway", true);

  const selector = await runCommand({
    executable,
    args: ["variable", "set", "AGENTLAS_LLM_PROVIDER", "--stdin", "--skip-deploys", "--service", serviceName, "--environment", "production", "--json"],
    cwd: packageRoot,
    env,
    stdin: `${input.llmProvider}\n`,
  });
  assertCommandSucceeded(selector, "railway-env-failed", "Railway runtime provider 설정에 실패했습니다.", "railway", true);

  attempt.transferredSecrets = [...new Set([...attempt.transferredSecrets, APP_ACCESS_ENV])];
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transfer-attempted",
    reason: `${APP_ACCESS_ENV} secret 전송을 시작했습니다. 응답이 유실되면 provider에 남아 있을 수 있습니다.`,
  });
  const accessSecret = await runCommand({
    executable,
    args: ["variable", "set", APP_ACCESS_ENV, "--stdin", "--skip-deploys", "--service", serviceName, "--environment", "production", "--json"],
    cwd: packageRoot,
    env,
    stdin: `${appAccessKey}\n`,
  });
  assertCommandSucceeded(accessSecret, "railway-access-secret-failed", "Railway app access secret 저장에 실패했습니다.", "railway", true);
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transferred",
    reason: `${APP_ACCESS_ENV}가 Railway server secret storage에 전송되었습니다.`,
  });

  attempt.transferredSecrets = [...new Set([...attempt.transferredSecrets, LLM_ENV[input.llmProvider]])];
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transfer-attempted",
    reason: `${LLM_ENV[input.llmProvider]} secret 전송을 시작했습니다. 응답이 유실되면 provider에 남아 있을 수 있습니다.`,
  });
  const secret = await runCommand({
    executable,
    args: ["variable", "set", LLM_ENV[input.llmProvider], "--stdin", "--skip-deploys", "--service", serviceName, "--environment", "production", "--json"],
    cwd: packageRoot,
    env,
    stdin: `${llmKey}\n`,
  });
  assertCommandSucceeded(secret, "railway-secret-failed", "Railway secret variable 저장에 실패했습니다.", "railway", true);
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "secret-transferred",
    reason: `${LLM_ENV[input.llmProvider]}가 Railway server secret storage에 전송되었습니다.`,
  });

  // Always pass the validated package path as the archive root and the newly
  // created project/service explicitly. The Desktop repository's current
  // Railway link is never consulted.
  const deployment = await runCommand({
    executable,
    args: ["up", packageRoot, "--path-as-root", "--project", providerProjectId, "--environment", "production", "--service", serviceName, "--json"],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(deployment, "railway-deploy-failed", "Railway local-folder deploy에 실패했습니다.", "railway", true);

  const domain = await runCommand({
    executable,
    args: ["domain", "--service", serviceName, "--json"],
    cwd: packageRoot,
    env,
  });
  assertCommandSucceeded(domain, "railway-domain-failed", "Railway public domain 생성에 실패했습니다.", "railway", true);
  const url = providerGeneratedUrlFromCommandOutput("railway", `${domain.stdout}\n${domain.stderr}`);
  if (!url) throw new PublishFailure("railway-url-missing", "Railway public URL을 확인할 수 없습니다.", {
    code: "provider-action-required",
    message: "Railway dashboard에서 service domain을 확인해 주세요.",
    url: PROVIDER_URLS.railway.dashboard,
  }, true);
  attempt.url = url;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "resource-created",
    reason: "Railway generated domain을 받았으며 공개 contract 검증을 기다리고 있습니다.",
  });
  return { url, providerProjectId };
}

function validateRenderRepository(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublishFailure("render-repository-required", "Render는 Git repository가 필요합니다.", {
      code: "render-repository-required",
      message: "Render는 로컬 폴더를 직접 업로드하지 않습니다. 검증된 package를 Git repository에 올린 뒤 URL을 입력해 주세요.",
      url: PROVIDER_URLS.render.dashboard,
    });
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new Error("Render repository URL 형식이 올바르지 않습니다.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  ) {
    throw new Error("Render repository는 credential이 없는 공개 HTTPS Git URL이어야 합니다.");
  }
  return url.toString().replace(/\/$/, "").slice(0, 2_048);
}

function validateRelativeRoot(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const root = String(value).trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!root || root.startsWith("/") || root.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Render rootDir 형식이 올바르지 않습니다.");
  }
  return root.slice(0, 300);
}

type ValidatedRenderIntent = {
  repositoryUrl: string;
  ownerId: string;
  branch: string;
  rootDir: string | null;
  serviceName: string;
};

function validateRenderIntent(
  artifact: ValidatedArtifact,
  input: SiteAgentAppPublishBackendRequest,
  deploymentId: string,
): ValidatedRenderIntent {
  const repositoryUrl = validateRenderRepository(input.renderRepositoryUrl);
  if (!input.renderRepositoryContainsValidatedPackage) {
    throw new PublishFailure("render-source-confirmation-required", "Render repository source 확인이 필요합니다.", {
      code: "render-source-confirmation-required",
      message: "입력한 repository/branch/rootDir에 현재 검증된 Astryx package와 동일한 server runtime이 있는지 사용자가 확인해야 합니다.",
      url: PROVIDER_URLS.render.dashboard,
    });
  }
  const ownerId = safeOptionalIdentifier(input.renderOwnerId, "Render owner ID");
  if (!ownerId) throw new PublishFailure("render-owner-required", "Render workspace owner ID가 필요합니다.", {
    code: "render-owner-required",
    message: "Render workspace를 선택해 owner ID를 제공해 주세요.",
    url: PROVIDER_URLS.render.dashboard,
  });
  const branch = input.renderBranch ? cleanSingleLine(input.renderBranch, 200) : "main";
  if (!branch || (input.renderBranch && /[\0\r\n]/.test(input.renderBranch))) throw new Error("Render branch 형식이 올바르지 않습니다.");
  const rootDir = validateRelativeRoot(input.renderRootDir) ?? null;
  return {
    repositoryUrl,
    ownerId,
    branch,
    rootDir,
    serviceName: `${artifact.projectName}-${deploymentId.replace(/-/g, "").slice(0, 8)}`.slice(0, 100),
  };
}

function publishIntentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function renderIntentDigest(
  artifactDigest: string,
  llmProvider: SiteLlmProvider,
  intent: ValidatedRenderIntent,
): string {
  return publishIntentDigest({
    schemaVersion: 1,
    provider: "render",
    artifactDigest,
    repositoryUrl: intent.repositoryUrl,
    ownerId: intent.ownerId,
    branch: intent.branch,
    rootDir: intent.rootDir,
    serviceName: intent.serviceName,
    llmProvider,
    transferredSecrets: [],
  });
}

async function deployRender(
  input: SiteAgentAppPublishBackendRequest,
  intent: ValidatedRenderIntent,
  session: PreparedRenderSession,
  attempt: DeploymentAttemptState,
): Promise<{ url: string; providerProjectId: string }> {
  // Fetch can lose the response after Render commits the service. Persist the
  // exact deterministic intent before POST so deletion and retry remain safe.
  attempt.mutated = true;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "mutation-attempted",
    reason: `Render service ${intent.serviceName} create mutation을 시작했습니다. 응답이 유실되면 receipt는 알 수 없지만 service가 존재할 수 있습니다.`,
  });
  const response = await renderApiRequest(session.apiKey, "/services", {
    method: "POST",
    body: {
      type: "web_service",
      name: intent.serviceName,
      ownerId: intent.ownerId,
      repo: intent.repositoryUrl,
      autoDeploy: "no",
      branch: intent.branch,
      ...(intent.rootDir ? { rootDir: intent.rootDir } : {}),
      // The selector and cost guard are non-secret configuration. The selected
      // LLM key is deliberately absent because this Git source is not attested.
      envVars: [
        { key: "AGENTLAS_LLM_PROVIDER", value: input.llmProvider },
        { key: APP_INSTANCE_BUDGET_ENV, value: "100" },
      ],
      serviceDetails: {
        runtime: "node",
        plan: "free",
        region: "oregon",
        numInstances: 1,
        healthCheckPath: "/healthz",
        renderSubdomainPolicy: "enabled",
        envSpecificDetails: {
          buildCommand: "npm install --ignore-scripts --no-audit --no-fund && npm run build",
          startCommand: "npm start",
        },
      },
    },
  });
  if (!response.ok) {
    if (response.status >= 500) attempt.mutated = true;
    throw new PublishFailure("render-create-failed", `Render service 생성이 거부되었습니다 (HTTP ${response.status}).`, {
      code: "provider-action-required",
      message: "Render workspace의 Git 연결, Free plan 사용 가능 여부, repository 접근 권한을 확인해 주세요.",
      url: PROVIDER_URLS.render.dashboard,
    }, response.status !== 400 && response.status !== 401 && response.status !== 403);
  }
  const service = jsonRecord(response.body) && jsonRecord(response.body.service) ? response.body.service : null;
  const providerProjectId = typeof service?.id === "string" ? service.id.slice(0, 200) : "";
  const url = findHttpsUrl(service?.serviceDetails) ?? findHttpsUrl(service);
  attempt.providerProjectId = providerProjectId || null;
  attempt.providerServiceId = providerProjectId || null;
  attempt.providerServiceName = intent.serviceName;
  attempt.url = url;
  await persistPublishReceipt({
    attempt,
    status: "provisioning",
    phase: "service-created",
    reason: "Render service 생성 요청이 성공했습니다. LLM/app secret은 전송되지 않았습니다.",
  });
  if (!providerProjectId || !url) {
    throw new PublishFailure("render-receipt-missing", "Render service receipt에 ID 또는 URL이 없습니다.", {
      code: "provider-action-required",
      message: "Render dashboard에서 생성된 service 상태와 URL을 확인해 주세요.",
      url: PROVIDER_URLS.render.dashboard,
    }, true);
  }
  return { url, providerProjectId };
}

async function persistPublishReceipt(input: {
  attempt: DeploymentAttemptState;
  status: SiteAgentAppDeploymentRecord["status"];
  phase: SiteAgentAppDeploymentRecord["phase"];
  reason: string | null;
}): Promise<void> {
  const recordedAt = new Date().toISOString();
  appendSiteAgentAppDeployment(input.attempt.projectId, {
    ledgerEntryId: randomUUID(),
    deploymentId: input.attempt.deploymentId,
    provider: input.attempt.provider,
    status: input.status,
    phase: input.phase,
    url: input.attempt.url,
    providerProjectId: input.attempt.providerProjectId,
    publishedAt: recordedAt,
    recordedAt,
    llmProvider: input.attempt.llmProvider,
    reason: input.reason ? cleanSingleLine(input.reason, 1_000) : null,
    artifactAppRecordId: input.attempt.artifactAppRecordId,
    artifactDigest: input.attempt.artifactDigest,
    intentDigest: input.attempt.intentDigest,
    providerAccountLabel: input.attempt.accountLabel,
    providerAccountScope: input.attempt.accountScope,
    providerServiceId: input.attempt.providerServiceId,
    providerServiceName: input.attempt.providerServiceName,
    transferredSecrets: [...input.attempt.transferredSecrets],
    appAccessKeyFingerprint: input.attempt.appAccessKeyFingerprint,
  });
}

function attemptFromDeploymentRecord(record: SiteAgentAppDeploymentRecord): DeploymentAttemptState {
  return {
    deploymentId: record.deploymentId,
    projectId: "",
    artifactAppRecordId: record.artifactAppRecordId,
    artifactDigest: record.artifactDigest ?? "0".repeat(64),
    intentDigest: record.intentDigest ?? "0".repeat(64),
    provider: record.provider,
    llmProvider: record.llmProvider,
    accountLabel: record.providerAccountLabel ?? "unknown",
    accountScope: record.providerAccountScope,
    providerProjectId: record.providerProjectId,
    providerServiceId: record.providerServiceId,
    providerServiceName: record.providerServiceName,
    url: record.url,
    transferredSecrets: [...record.transferredSecrets],
    appAccessKeyFingerprint: record.appAccessKeyFingerprint,
    mutated: true,
  };
}

function latestDeploymentRecord(
  project: SiteProjectMeta,
  predicate: (record: SiteAgentAppDeploymentRecord) => boolean,
): SiteAgentAppDeploymentRecord | null {
  return [...(project.agentAppDeployments ?? [])].reverse().find(predicate) ?? null;
}

function needsActionResult(
  provider: SitePublishProvider,
  packageValidated: boolean,
  source: SiteAgentAppPublishBackendResult["providerSource"],
  action: SiteAgentAppPublishUserAction,
  reason = action.message,
): SiteAgentAppPublishBackendResult {
  return {
    ok: false,
    provider,
    status: "needs-user-action",
    packageValidated,
    providerSource: source,
    reason,
    userAction: action,
    consentBoundary: CONSENT_BOUNDARY,
  };
}

function isLlmProvider(value: unknown): value is SiteLlmProvider {
  return value === "openai" || value === "anthropic" || value === "google";
}

function existingRenderConfigurationResult(
  projectId: string,
): SiteAgentAppPublishBackendResult | null {
  const project = getSiteProject(projectId);
  const receipt = project.agentAppArtifact?.publish;
  if (
    project.surface !== "agent-app" ||
    project.agentAppArtifact?.status !== "ready" ||
    receipt?.provider !== "render" ||
    receipt.status !== "configuration-required" ||
    !receipt.url ||
    !receipt.providerProjectId
  ) return null;

  const requiredEnvironmentVariable = LLM_ENV[receipt.llmProvider];
  const message = receipt.reason ||
    `Render service는 이미 생성되었지만 secret 설정이 남았습니다. Render dashboard에서 ${requiredEnvironmentVariable}와 ${APP_ACCESS_ENV}를 직접 추가해 주세요.`;
  return {
    ok: false,
    provider: "render",
    status: "needs-user-action",
    packageValidated: true,
    providerSource: "user-confirmed-git-repository",
    url: receipt.url,
    providerProjectId: receipt.providerProjectId,
    reason: message,
    userAction: {
      code: "render-llm-key-required",
      message,
      url: PROVIDER_URLS.render.dashboard,
    },
    consentBoundary: CONSENT_BOUNDARY,
  };
}

function deploymentVerificationActionResult(input: {
  provider: "vercel" | "railway";
  url: string | null;
  providerProjectId: string;
  reason: string;
}): SiteAgentAppPublishBackendResult {
  const message = `Provider resource는 생성되었지만 공개 페이지, /healthz, 인증된 무추론 /api/run contract 검증이 완료되지 않았습니다. ${input.reason}`;
  return {
    ok: false,
    provider: input.provider,
    status: "needs-user-action",
    packageValidated: true,
    providerSource: "local-folder",
    ...(input.url ? { url: input.url } : {}),
    providerProjectId: input.providerProjectId,
    reason: message,
    userAction: {
      code: "deployment-verification-required",
      message: `${message} 유료 LLM 추론은 호출하지 않았습니다. Provider dashboard 상태를 확인한 뒤 다시 검증해 주세요.`,
      url: PROVIDER_URLS[input.provider].dashboard,
    },
    consentBoundary: CONSENT_BOUNDARY,
  };
}

async function runDeploymentVerification(
  provider: "vercel" | "railway",
  inputUrl: string,
  appAccessKey: string,
  options: SiteAgentAppPublishExecutionOptions,
): Promise<{ url: string | null; verification: SiteDeploymentVerificationResult }> {
  let url: string;
  try {
    url = normalizeProviderDeploymentUrl(provider, inputUrl);
  } catch (error) {
    return {
      url: null,
      verification: {
        ok: false,
        pageStatus: null,
        healthStatus: null,
        apiStatus: null,
        apiErrorCode: null,
        reason: cleanSingleLine(error instanceof Error ? error.message : String(error), 500),
      },
    };
  }
  try {
    const verification = options.verifyDeployment
      ? await options.verifyDeployment(provider, url, appAccessKey)
      : await verifySiteAgentAppDeployment(provider, url, appAccessKey);
    if (
      !verification ||
      typeof verification.ok !== "boolean" ||
      (verification.pageStatus !== null && !Number.isInteger(verification.pageStatus)) ||
      (verification.healthStatus !== null && !Number.isInteger(verification.healthStatus)) ||
      (verification.apiStatus !== null && !Number.isInteger(verification.apiStatus)) ||
      (verification.apiErrorCode !== null && typeof verification.apiErrorCode !== "string")
    ) throw new Error("배포 검증 결과 형식이 올바르지 않습니다.");
    return { url, verification };
  } catch (error) {
    return {
      url,
      verification: {
        ok: false,
        pageStatus: null,
        healthStatus: null,
        apiStatus: null,
        apiErrorCode: null,
        reason: cleanSingleLine(error instanceof Error ? error.message : String(error), 500) || "배포 HTTPS 검증에 실패했습니다.",
      },
    };
  }
}

async function recoverExistingDeploymentVerification(
  request: SiteAgentAppPublishBackendRequest,
  options: SiteAgentAppPublishExecutionOptions,
): Promise<SiteAgentAppPublishBackendResult | null> {
  const projectId = request.projectId;
  const project = getSiteProject(projectId);
  const receipt = project.agentAppArtifact?.publish;
  if (
    project.surface !== "agent-app" ||
    project.agentAppArtifact?.status !== "ready" ||
    (receipt?.provider !== "vercel" && receipt?.provider !== "railway") ||
    receipt.status !== "verification-required" ||
    !receipt.providerProjectId
  ) return null;

  let appAccessKey: string;
  try {
    appAccessKey = validateAppAccessKey(request.appAccessKey);
  } catch {
    return needsActionResult(receipt.provider, true, "local-folder", {
      code: "app-access-key-required",
      message: "기존 배포의 인증된 무추론 contract를 다시 확인하려면 배포 때 승인한 app access passcode를 입력해 주세요.",
    });
  }
  const existingRecord = latestDeploymentRecord(project, (record) =>
    record.provider === receipt.provider &&
    record.providerProjectId === receipt.providerProjectId &&
    record.url === receipt.url,
  );
  if (existingRecord?.appAccessKeyFingerprint && fullFingerprint(appAccessKey) !== existingRecord.appAccessKeyFingerprint) {
    return needsActionResult(receipt.provider, true, "local-folder", {
      code: "app-access-key-required",
      message: "입력한 app access passcode fingerprint가 이 배포에서 승인한 값과 일치하지 않습니다.",
    });
  }
  const attempt = existingRecord
    ? { ...attemptFromDeploymentRecord(existingRecord), projectId }
    : {
        deploymentId: `legacy-verification:${projectId}:${receipt.providerProjectId}`,
        projectId,
        artifactAppRecordId: project.agentAppArtifact.appRecordId,
        artifactDigest: "0".repeat(64),
        intentDigest: "0".repeat(64),
        provider: receipt.provider,
        llmProvider: receipt.llmProvider,
        accountLabel: "unknown",
        accountScope: null,
        providerProjectId: receipt.providerProjectId,
        providerServiceId: null,
        providerServiceName: null,
        url: receipt.url,
        transferredSecrets: [APP_ACCESS_ENV, LLM_ENV[receipt.llmProvider]],
        appAccessKeyFingerprint: fullFingerprint(appAccessKey),
        mutated: true,
      } satisfies DeploymentAttemptState;

  if (!receipt.url) {
    return deploymentVerificationActionResult({
      provider: receipt.provider,
      url: null,
      providerProjectId: receipt.providerProjectId,
      reason: receipt.reason || "Provider가 안전하게 검증할 수 있는 generated URL을 반환하지 않았습니다.",
    });
  }
  const checked = await runDeploymentVerification(receipt.provider, receipt.url, appAccessKey, options);
  if (!checked.verification.ok || !checked.url) {
    const reason = checked.verification.reason || "공개 endpoint가 아직 준비되지 않았습니다.";
    await persistPublishReceipt({
      attempt: { ...attempt, url: checked.url ?? receipt.url },
      status: "verification-required",
      phase: "verification-required",
      reason,
    });
    return deploymentVerificationActionResult({
      provider: receipt.provider,
      url: checked.url ?? receipt.url,
      providerProjectId: receipt.providerProjectId,
      reason,
    });
  }
  await persistPublishReceipt({
    attempt: { ...attempt, url: checked.url },
    status: "published",
    phase: "published",
    reason: null,
  });
  return {
    ok: true,
    provider: receipt.provider,
    status: "published",
    packageValidated: true,
    providerSource: "local-folder",
    url: checked.url,
    providerProjectId: receipt.providerProjectId,
    consentBoundary: CONSENT_BOUNDARY,
  };
}

function existingIncompleteMutationResult(
  request: SiteAgentAppPublishBackendRequest,
): SiteAgentAppPublishBackendResult | null {
  const project = getSiteProject(request.projectId);
  const artifact = project.agentAppArtifact;
  if (!artifact) return null;
  const latestByDeployment = new Map<string, SiteAgentAppDeploymentRecord>();
  for (const record of project.agentAppDeployments ?? []) latestByDeployment.set(record.deploymentId, record);
  const existing = [...latestByDeployment.values()].reverse().find((record) =>
    record.provider === request.provider &&
    record.artifactAppRecordId === artifact.appRecordId &&
    (record.status === "provisioning" || record.status === "failed") &&
    Boolean(record.providerProjectId || record.providerServiceId || record.providerServiceName || record.url),
  ) ?? null;
  if (!existing) return null;
  const identity = [existing.providerProjectId, existing.providerServiceId, existing.providerServiceName, existing.url].filter(Boolean).join(" · ");
  return needsActionResult(request.provider, true, request.provider === "render" ? "user-confirmed-git-repository" : "local-folder", {
    code: "provider-action-required",
    message: `이 artifact의 이전 배포가 provider를 변경했습니다 (${identity}). 중복 resource를 만들지 않도록 자동 재배포를 중단했습니다. Provider dashboard에서 기존 resource와 남은 secret을 확인해 주세요.`,
    url: PROVIDER_URLS[request.provider].dashboard,
  });
}

export async function publishSiteAgentApp(
  request: SiteAgentAppPublishBackendRequest,
  options: SiteAgentAppPublishExecutionOptions = {},
): Promise<SiteAgentAppPublishBackendResult> {
  const provider = assertProvider(request.provider);
  if (!isLlmProvider(request.llmProvider)) throw new Error("지원하지 않는 BYOK LLM provider입니다.");
  const source: SiteAgentAppPublishBackendResult["providerSource"] =
    provider === "render" ? "user-confirmed-git-repository" : "local-folder";
  const existingVerification = await recoverExistingDeploymentVerification(request, options);
  if (existingVerification) return existingVerification;
  const incompleteMutation = existingIncompleteMutationResult(request);
  if (incompleteMutation) return incompleteMutation;
  // Recover the durable receipt before checking credentials, consent, or
  // repository fields. Returning this existing user action is read-only and
  // must never create a second Render service on retry/reopen.
  if (provider === "render") {
    const existing = existingRenderConfigurationResult(request.projectId);
    if (existing) return existing;
  }
  const consentResult = requireConsent(request);
  if (consentResult) return consentResult;

  let packageValidated = false;
  let temporaryRoot: string | null = null;
  let deploymentArtifactDigest = "";
  let releaseCredentialLock: (() => void) | null = null;
  let preparedSession: PreparedProviderSession | null = null;
  let preparedRenderSession: PreparedRenderSession | null = null;
  let attempt: DeploymentAttemptState | null = null;
  let llmKey = "";
  let appAccessKey = "";
  try {
    const artifact = await validateSiteAgentAppArtifact(request.projectId, provider, request.llmProvider);
    packageValidated = true;

    if (provider === "render") {
      releaseCredentialLock = acquirePublishCredentialLock(provider, null);
      if (!releaseCredentialLock) return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "Render provider credential을 사용하는 다른 native 게시 승인이 진행 중입니다.",
      });
      const deploymentId = randomUUID();
      const intent = validateRenderIntent(artifact, request, deploymentId);
      preparedRenderSession = await capturePreparedRenderSession(intent.ownerId);
      temporaryRoot = await copyValidatedArtifact(artifact);
      deploymentArtifactDigest = artifactTreeDigest(await validateArtifactTree(temporaryRoot));
      const intentDigest = renderIntentDigest(deploymentArtifactDigest, request.llmProvider, intent);
      attempt = {
        deploymentId,
        projectId: request.projectId,
        artifactAppRecordId: artifact.project.agentAppArtifact?.appRecordId ?? "",
        artifactDigest: deploymentArtifactDigest,
        intentDigest,
        provider,
        llmProvider: request.llmProvider,
        accountLabel: preparedRenderSession.accountLabel,
        accountScope: intent.ownerId,
        providerProjectId: null,
        providerServiceId: null,
        providerServiceName: intent.serviceName,
        url: null,
        transferredSecrets: [],
        appAccessKeyFingerprint: null,
        mutated: false,
      };
      if (!options.confirmNativeApproval) return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "Electron main native Render service 생성 확인이 필요합니다.",
      });
      const approved = await options.confirmNativeApproval({
        projectId: artifact.project.id,
        projectName: artifact.project.name,
        appName: artifact.project.agentAppArtifact?.appName || artifact.project.name,
        artifactDigest: deploymentArtifactDigest,
        provider,
        providerAccountLabel: preparedRenderSession.accountLabel,
        providerConnectionMethod: "token",
        providerAccountScope: intent.ownerId,
        providerCliVersion: null,
        llmProvider: request.llmProvider,
        llmKeyIdentity: "not read or transferred for Render",
        llmKeyVersion: null,
        llmKeyFingerprint: null,
        appAccessKeyFingerprint: null,
        intentDigest,
        providerApiKeyIdentity: preparedRenderSession.apiKeyIdentity,
        providerApiKeyFingerprint: preparedRenderSession.apiKeyFingerprint,
        renderIntent: {
          repositoryUrl: intent.repositoryUrl,
          ownerId: intent.ownerId,
          branch: intent.branch,
          rootDir: intent.rootDir,
          serviceName: intent.serviceName,
        },
        planWarning: FREE_PLAN_NOTES.render,
      });
      if (!approved) return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "사용자가 native Render service 생성을 취소했습니다. Provider 변경은 수행하지 않았습니다.",
      });
      await reverifyPreparedRenderSession(preparedRenderSession);
      await assertApprovedArtifactCopy(deploymentArtifactDigest, temporaryRoot);
      const revalidatedIntent = validateRenderIntent(artifact, request, deploymentId);
      if (renderIntentDigest(deploymentArtifactDigest, request.llmProvider, revalidatedIntent) !== intentDigest) {
        throw new PublishFailure("render-intent-changed", "Render service intent가 native 승인 중 변경되었습니다.", {
          code: "native-approval-required",
          message: "승인된 repository/account/service intent와 현재 요청이 다릅니다. 다시 확인해 주세요.",
        });
      }
      // Render deploys from a user-owned Git repo. It never receives or claims
      // to receive this local folder, selected Keychain LLM secret, or app key.
      const deployed = await deployRender(request, revalidatedIntent, preparedRenderSession, attempt);
      const requiredEnvironmentVariable = LLM_ENV[request.llmProvider];
      const message = `Render service는 생성되었지만 secret은 전송하지 않았습니다. Render dashboard에서 ${requiredEnvironmentVariable}와 ${APP_ACCESS_ENV}를 직접 추가해 주세요.`;
      await persistPublishReceipt({
        attempt: { ...attempt, url: deployed.url, providerProjectId: deployed.providerProjectId, providerServiceId: deployed.providerProjectId },
        status: "configuration-required",
        phase: "configuration-required",
        reason: message,
      });
      return {
        ok: false,
        provider,
        status: "needs-user-action",
        packageValidated: true,
        providerSource: source,
        url: deployed.url,
        providerProjectId: deployed.providerProjectId,
        reason: message,
        userAction: {
          code: "render-llm-key-required",
          message,
          url: PROVIDER_URLS.render.dashboard,
        },
        consentBoundary: CONSENT_BOUNDARY,
      };
    }

    // The renderer passcode and checkbox are only proposal data. From this
    // point through deploy, Electron main owns an exclusive credential lock.
    appAccessKey = validateAppAccessKey(request.appAccessKey);
    releaseCredentialLock = acquirePublishCredentialLock(provider, request.llmProvider);
    if (!releaseCredentialLock) {
      return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "같은 provider 또는 LLM credential을 사용하는 다른 native 게시 승인이 진행 중입니다.",
      });
    }

    preparedSession = await capturePreparedProviderSession(provider);
    const accountScope = safeOptionalIdentifier(
      request.providerAccountId,
      provider === "vercel" ? "Vercel scope" : "Railway workspace",
    );
    // Descriptor metadata never reads the secret value. Legacy keys simply
    // show version/fingerprint unavailable until after the first approval.
    const keyDescriptor = await describeApiKey(request.llmProvider as RuntimeBackend);
    const deploymentArtifact = await prepareDeploymentArtifact(artifact, provider);
    temporaryRoot = deploymentArtifact.root;
    deploymentArtifactDigest = deploymentArtifact.digest;
    const appAccessKeyFingerprint = fullFingerprint(appAccessKey);
    const intentDigest = publishIntentDigest({
      schemaVersion: 1,
      provider,
      artifactDigest: deploymentArtifactDigest,
      accountLabel: preparedSession.accountLabel,
      accountScope: accountScope ?? null,
      llmProvider: request.llmProvider,
      llmKeyFingerprint: keyDescriptor?.fingerprint ?? null,
      appAccessKeyFingerprint,
      transferredSecrets: [APP_ACCESS_ENV, LLM_ENV[request.llmProvider]],
    });
    attempt = {
      deploymentId: randomUUID(),
      projectId: request.projectId,
      artifactAppRecordId: artifact.project.agentAppArtifact?.appRecordId ?? "",
      artifactDigest: deploymentArtifactDigest,
      intentDigest,
      provider,
      llmProvider: request.llmProvider,
      accountLabel: preparedSession.accountLabel,
      accountScope: accountScope ?? null,
      providerProjectId: null,
      providerServiceId: null,
      providerServiceName: provider === "vercel" ? artifact.projectName : `${artifact.projectName}-web`.slice(0, 80),
      url: null,
      transferredSecrets: [],
      appAccessKeyFingerprint,
      mutated: false,
    };

    if (!options.confirmNativeApproval) {
      return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "Electron main native 배포 확인이 필요합니다.",
      });
    }
    const approved = await options.confirmNativeApproval({
      projectId: artifact.project.id,
      projectName: artifact.project.name,
      appName: artifact.project.agentAppArtifact?.appName || artifact.project.name,
      artifactDigest: deploymentArtifactDigest,
      provider,
      providerAccountLabel: preparedSession.accountLabel,
      providerConnectionMethod: preparedSession.connectionMethod,
      providerAccountScope: accountScope ?? null,
      providerCliVersion: preparedSession.cliVersion,
      llmProvider: request.llmProvider,
      llmKeyIdentity: `OS credential vault / byok:${request.llmProvider}`,
      llmKeyVersion: keyDescriptor?.version ?? null,
      llmKeyFingerprint: keyDescriptor?.fingerprint ?? null,
      appAccessKeyFingerprint,
      intentDigest,
      planWarning: FREE_PLAN_NOTES[provider],
    });
    if (!approved) {
      return needsActionResult(provider, true, source, {
        code: "native-approval-required",
        message: "사용자가 native 배포 확인을 취소했습니다. Secret 전송과 provider 변경은 수행하지 않았습니다.",
      });
    }

    // Reverify with the exact captured credential; never re-read a renderer-
    // swappable provider token after native approval.
    await reverifyPreparedProviderSession(preparedSession);
    // The native dialog binds the final publish tree, including the main-owned
    // Vercel health shim. Re-hash that private copy immediately before any
    // secret read or provider mutation.
    await assertApprovedArtifactCopy(deploymentArtifactDigest, temporaryRoot);
    const currentIntentDigest = publishIntentDigest({
      schemaVersion: 1,
      provider,
      artifactDigest: deploymentArtifactDigest,
      accountLabel: preparedSession.accountLabel,
      accountScope: accountScope ?? null,
      llmProvider: request.llmProvider,
      llmKeyFingerprint: keyDescriptor?.fingerprint ?? null,
      appAccessKeyFingerprint: fullFingerprint(appAccessKey),
      transferredSecrets: [APP_ACCESS_ENV, LLM_ENV[request.llmProvider]],
    });
    if (currentIntentDigest !== intentDigest) {
      throw new PublishFailure("publish-intent-changed", "Native 승인 중 배포 intent가 변경되었습니다.", {
        code: "native-approval-required",
        message: "승인된 artifact/account/secret fingerprint와 현재 배포 intent가 다릅니다. 다시 확인해 주세요.",
      });
    }
    // The LLM value is first read only after native approval. Its main-owned
    // descriptor must still match before the first provider mutation.
    llmKey = await loadLlmKey(request.llmProvider);
    const actualKeyFingerprint = fullFingerprint(llmKey);
    if (keyDescriptor && actualKeyFingerprint !== keyDescriptor.fingerprint) {
      throw new PublishFailure("llm-key-changed", "LLM Keychain key가 native 승인 중 변경되었습니다.", {
        code: "llm-key-missing",
        message: "승인 화면에 표시된 LLM key identity와 현재 Keychain 값이 다릅니다. 다시 시도해 주세요.",
      });
    }
    if (!keyDescriptor) await ensureApiKeyDescriptor(request.llmProvider as RuntimeBackend, llmKey);

    const deployed = provider === "vercel"
      ? await deployVercel(artifact, temporaryRoot, request, preparedSession, accountScope, llmKey, appAccessKey, attempt)
      : await deployRailway(artifact, temporaryRoot, request, preparedSession, accountScope, llmKey, appAccessKey, attempt);
    const checked = await runDeploymentVerification(provider, deployed.url, appAccessKey, options);
    if (!checked.verification.ok || !checked.url) {
      const reason = checked.verification.reason || "공개 endpoint가 아직 준비되지 않았습니다.";
      await persistPublishReceipt({
        attempt: { ...attempt, url: checked.url ?? deployed.url, providerProjectId: deployed.providerProjectId },
        status: "verification-required",
        phase: "verification-required",
        reason,
      });
      return deploymentVerificationActionResult({
        provider,
        url: checked.url,
        providerProjectId: deployed.providerProjectId,
        reason,
      });
    }
    await persistPublishReceipt({
      attempt: { ...attempt, url: checked.url, providerProjectId: deployed.providerProjectId },
      status: "published",
      phase: "published",
      reason: null,
    });
    return {
      ok: true,
      provider,
      status: "published",
      packageValidated: true,
      providerSource: source,
      url: checked.url,
      providerProjectId: deployed.providerProjectId,
      consentBoundary: CONSENT_BOUNDARY,
    };
  } catch (error) {
    if (error instanceof PublishFailure && error.userAction) {
      if (attempt && packageValidated && (attempt.mutated || error.providerMutated)) {
        attempt.mutated = true;
        await persistPublishReceipt({
          attempt,
          status: "failed",
          phase: "failed",
          reason: error.message,
        }).catch(() => undefined);
      }
      return {
        ...needsActionResult(provider, packageValidated, source, error.userAction, error.message),
        ...(attempt?.url ? { url: attempt.url } : {}),
        ...(attempt?.providerProjectId ? { providerProjectId: attempt.providerProjectId } : {}),
      };
    }
    const reason = cleanSingleLine(error instanceof Error ? error.message : String(error), 1_000) || "배포에 실패했습니다.";
    if (attempt?.mutated && packageValidated) {
      await persistPublishReceipt({
        attempt,
        status: "failed",
        phase: "failed",
        reason,
      }).catch(() => undefined);
    }
    return {
      ok: false,
      provider,
      status: "failed",
      packageValidated,
      providerSource: source,
      reason,
      ...(attempt?.url ? { url: attempt.url } : {}),
      ...(attempt?.providerProjectId ? { providerProjectId: attempt.providerProjectId } : {}),
      consentBoundary: CONSENT_BOUNDARY,
    };
  } finally {
    llmKey = "";
    appAccessKey = "";
    if (preparedSession) {
      preparedSession.token = null;
      preparedSession.env[PROVIDER_TOKEN_ENV[preparedSession.provider]] = "";
    }
    if (preparedRenderSession) preparedRenderSession.apiKey = "";
    releaseCredentialLock?.();
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
