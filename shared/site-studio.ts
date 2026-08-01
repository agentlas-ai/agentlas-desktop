// Site design studio — shared contract between main, preload, and renderer.
//
// Web/mobile Site previews remain DESIGN-ONLY screens: one self-contained HTML
// document per screen in an opaque-origin sandbox. Agent App is a separate,
// explicit lane: main materializes a pinned React + Astryx package, owns its
// loopback runtime capability, and validates any public deployment. This file
// owns both shared contracts without allowing preview HTML or secrets to cross
// into the executable package.

export const SITE_SCREEN_MAX_BYTES = 512_000;

/** Site home template lanes. Existing projects without this field load as web. */
export type SiteSurface = "web" | "mobile" | "agent-app";

export type SiteAgentAppTargetKind = "agent" | "team" | "firm";

/** Renderer may nominate only a stable kind/id pair; Electron main resolves display data. */
export type SiteAgentAppTargetRef = {
  kind: SiteAgentAppTargetKind;
  id: string;
};

/** Main-owned snapshot persisted with an Agent App project. */
export type SiteAgentAppTarget = SiteAgentAppTargetRef & {
  name: string;
  description: string;
  memberCount: number;
};

export type SiteAstryxTemplate = "ai-chat-landing" | "ai-chat" | "form-two-column";

export const SITE_ASTRYX_VERSION = "0.1.4" as const;

export type SitePublishProvider = "vercel" | "railway" | "render";

export type SiteLlmProvider = "openai" | "anthropic" | "google";

export type SiteAgentAppPublishStatus =
  | "provisioning"
  | "published"
  | "configuration-required"
  | "verification-required"
  | "failed";

export type SiteAgentAppPublishRecord = {
  provider: SitePublishProvider;
  /**
   * `configuration-required` means the provider resource exists, but it must
   * not be presented as a working public deployment yet.
   * `verification-required` means Vercel/Railway returned a resource receipt,
   * but `/`, `/healthz`, and the authenticated no-inference `/api/run`
   * invalid-input contract have not all passed bounded HTTPS checks.
   */
  status: SiteAgentAppPublishStatus;
  url: string | null;
  providerProjectId: string | null;
  publishedAt: string;
  /** Secret values are never persisted; this is the selected provider only. */
  llmProvider: SiteLlmProvider;
  reason: string | null;
};

/**
 * Append-only provider mutation event. The project owns this ledger rather
 * than a generated artifact so rebuilds cannot erase remote-resource truth.
 * Secret values are never stored; `transferredSecrets` contains environment
 * variable names only so deletion can warn what may remain provider-side.
 */
export type SiteAgentAppDeploymentRecord = SiteAgentAppPublishRecord & {
  ledgerEntryId: string;
  deploymentId: string;
  phase:
    | "mutation-attempted"
    | "resource-created"
    | "service-created"
    | "secret-transfer-attempted"
    | "secret-transferred"
    | "verification-required"
    | "configuration-required"
    | "published"
    | "failed";
  recordedAt: string;
  artifactAppRecordId: string;
  artifactDigest: string | null;
  intentDigest: string | null;
  providerAccountLabel: string | null;
  providerAccountScope: string | null;
  providerServiceId: string | null;
  providerServiceName: string | null;
  transferredSecrets: string[];
  /** Full SHA-256 only; never the passcode itself. */
  appAccessKeyFingerprint: string | null;
};

/** Durable link from a Site project to its generated AppFactory artifact. */
export type SiteAgentAppArtifact = {
  schemaVersion: 1;
  appRecordId: string;
  appId: string;
  /** Agent App cards intentionally use the selected agent/team name. */
  appName: string;
  /** Main-owned absolute path, always contained by ~/.agentlas/site/agentapp. */
  rootPath: string;
  sourceScreenId: string;
  status: "scaffolded" | "building" | "ready" | "failed";
  launchUrl: string | null;
  thumbnail: {
    path: string;
    width: 1280;
    height: 720;
    updatedAt: string;
  } | null;
  publish: SiteAgentAppPublishRecord | null;
  /**
   * Binds the projected publish badge to one exact artifact/intent deployment.
   * Rebuilds clear this while the project-level historical ledger remains.
   */
  publishBinding?: {
    deploymentId: string;
    artifactDigest: string;
    intentDigest: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  failureReason: string | null;
};

export type SitePublishProviderStatus = {
  provider: SitePublishProvider;
  connected: boolean;
  accountLabel: string | null;
  connectionMethod: "token" | "cli" | null;
  freePlanNote: string;
  signupUrl: string;
  tokenUrl: string;
};

export type SiteAgentAppPublishRequest = {
  projectId: string;
  provider: SitePublishProvider;
  llmProvider: SiteLlmProvider;
  /** Render can only create a service from a Git repository or image. */
  renderRepositoryUrl?: string;
};

export type SiteAgentAppPublishResult = {
  ok: boolean;
  provider: SitePublishProvider;
  url?: string;
  providerProjectId?: string;
  reason?: string;
};

export type SiteRemoteDeploymentRetention = {
  deploymentId: string;
  provider: SitePublishProvider;
  status: SiteAgentAppPublishRecord["status"];
  url: string | null;
  providerProjectId: string | null;
  providerServiceId: string | null;
  providerServiceName: string | null;
  transferredSecrets: string[];
  dashboardUrl: string;
  message: string;
};

export type SiteDeleteProjectResult = {
  ok: boolean;
  code?: "remote-deployment-acknowledgement-required";
  message: string;
  /** Remote resources are never deleted by the local Site-project delete path. */
  remoteDeploymentRetained: SiteRemoteDeploymentRetention | null;
  /** Every distinct historical provider resource, newest first. */
  remoteDeploymentsRetained: SiteRemoteDeploymentRetention[];
  localCleanup?: {
    artifactRemoved: boolean;
    appRegistrationRemoved: boolean;
    hiddenSessionsRemoved: number;
  };
};

export type SitePublishProviderPage = "signup" | "token" | "login";

/** Every irreversible provider-side choice remains an explicit user action. */
export type SiteAgentAppPublishConsent = {
  providerAccountReady: boolean;
  providerTermsHandledByUser: boolean;
  planConfirmedByUser: boolean;
  deploymentApproved: boolean;
  /**
   * Renderer acknowledgement only. Electron main always requires a separate
   * native confirmation before Vercel/Railway secret transfer or deployment.
   */
  llmKeyTransferApproved: boolean;
};

export type SiteAgentAppPublishBackendRequest = SiteAgentAppPublishRequest & {
  consent: SiteAgentAppPublishConsent;
  /**
   * One-time public API bearer passcode for Vercel/Railway. It is transferred
   * to provider secret storage only after native main-process confirmation and
   * is never persisted in Site metadata. Render configures this manually.
   */
  appAccessKey?: string;
  providerAccountId?: string;
  renderOwnerId?: string;
  renderBranch?: string;
  renderRootDir?: string;
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

/** Exact, value-free summary shown by Electron main in the native deploy dialog. */
export type SiteAgentAppNativePublishApproval = {
  projectId: string;
  projectName: string;
  appName: string;
  artifactDigest: string;
  provider: SitePublishProvider;
  providerAccountLabel: string;
  providerConnectionMethod: "token" | "cli";
  providerAccountScope: string | null;
  providerCliVersion: string | null;
  llmProvider: SiteLlmProvider;
  /** Logical Keychain item; never a secret value. */
  llmKeyIdentity: string;
  /** Version from main-owned Keychain metadata when available. */
  llmKeyVersion: string | null;
  /** SHA-256 prefix from main-owned Keychain metadata when available. */
  llmKeyFingerprint: string | null;
  /** SHA-256 fingerprint of the one-time public API passcode, never its value. */
  appAccessKeyFingerprint: string | null;
  /** Canonical digest of the exact provider/account/repository/service intent. */
  intentDigest: string;
  /** Render provider API key identity; values never leave Electron main. */
  providerApiKeyIdentity?: string;
  providerApiKeyFingerprint?: string;
  renderIntent?: {
    repositoryUrl: string;
    ownerId: string;
    branch: string;
    rootDir: string | null;
    serviceName: string;
  };
  planWarning: string;
};

export type SiteAgentAppPublishConsentBoundary = {
  accountCreation: "user-only";
  providerLogin: "user-only";
  providerTerms: "user-only";
  planAndBilling: "user-only";
  deployment: "explicit-request-only";
  llmKeyTransfer: "explicit-request-only";
  renderLlmKeyTransfer: "never";
  autonomousAccountCreation: false;
  autonomousTermsAcceptance: false;
  autonomousPlanChange: false;
};

export type SiteAgentAppPublishBackendResult = SiteAgentAppPublishResult & {
  status: "published" | "needs-user-action" | "failed";
  packageValidated: boolean;
  providerSource: "local-folder" | "user-confirmed-git-repository";
  /** A provider resource can exist while remaining unusable until userAction is completed. */
  userAction?: SiteAgentAppPublishUserAction;
  consentBoundary: SiteAgentAppPublishConsentBoundary;
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
  consentBoundary: SiteAgentAppPublishConsentBoundary;
};

export type SiteAgentAppPublishTokenResult = {
  ok: boolean;
  provider: SitePublishProvider;
  stored: boolean;
  status: SiteAgentAppPublishProviderStatus;
  consentBoundary: SiteAgentAppPublishConsentBoundary;
};

export type SiteAgentAppRuntimeStatus = {
  projectId: string;
  running: boolean;
  origin: string | null;
  activeRun: boolean;
};

export type SiteAgentAppLaunchResult = SiteAgentAppRuntimeStatus & {
  ok: boolean;
  /** Capability fragments are never returned to the renderer or persisted. */
  opened: boolean;
  reason?: string;
};

export type SiteAgentAppThumbnailResult = {
  ok: boolean;
  projectId: string;
  dataUrl?: string;
  updatedAt?: string;
  reason?: string;
};

/**
 * Main-resolved, JSON-only input/output contract stored at project creation.
 * It intentionally cannot carry prompts, memory, credentials, or executable code.
 */
export type SiteAgentAppContractInput = {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  label: string;
  description: string;
  required: boolean;
  format: "text" | "textarea";
  options: string[];
  defaultValue: string | number | boolean | null;
};

export type SiteAgentAppContractOutput = {
  name: string;
  label: string;
  type: string;
  description: string;
};

export type SiteAgentAppCapabilityIssue = {
  /** Value-free catalog/policy identifier. Never a path, key name, or provider response. */
  id: string;
  reason:
    | "not-allowlisted"
    | "blocked-by-agent-app-policy"
    | "consent-required"
    | "not-installed"
    | "key-missing"
    | "not-configured"
    | "runtime-unavailable";
};

/**
 * Persisted declaration only. Availability is re-checked in Electron main for
 * every run, so this snapshot never carries a config path or credential.
 */
export type SiteAgentAppCapabilityProfile = {
  schemaVersion: 1;
  source: "none" | "declared-package" | "declared-routing-card" | "composed-target";
  /** Exact, policy-approved read-only MCP catalog ids requested by the package. */
  readonlyMcpCatalogIds: string[];
  /** Unsafe or unsupported declared capabilities, using value-free reasons. */
  unavailable: SiteAgentAppCapabilityIssue[];
};

/**
 * Main-owned decision for one frozen Agent App capability declaration. The
 * renderer can request a review, but cannot mint or submit this receipt.
 * Values, key names, commands, URLs, and filesystem paths never enter it.
 */
export type SiteAgentAppMcpConsentReceipt = {
  schemaVersion: 1;
  receiptId: string;
  projectId: string;
  /** SHA-256 of the policy version plus the sorted catalog-id declaration. */
  recommendationDigest: string;
  /** SHA-256 of the exact value-free readiness rows displayed for approval. */
  readinessDigest: string;
  decision: "approved" | "declined";
  /** Empty for a decline; otherwise only ids that were ready at approval time. */
  approvedCatalogIds: string[];
  decidedAt: string;
};

export type SiteAgentAppMcpCredentialMode = "key-required" | "keyless";
export type SiteAgentAppMcpKeyState = "present" | "missing" | "not-required" | "unknown";
export type SiteAgentAppMcpReadiness = "ready" | "not-installed" | "missing-key" | "not-configured";

/** Renderer-safe row. It deliberately excludes env/key names and executable configuration. */
export type SiteAgentAppMcpRecommendationRow = {
  catalogId: string;
  name: string;
  mark: string;
  credentialMode: SiteAgentAppMcpCredentialMode;
  installed: boolean;
  enabled: boolean;
  keyState: SiteAgentAppMcpKeyState;
  readiness: SiteAgentAppMcpReadiness;
};

/** Fresh main-process recommendation plus the durable consent state. */
export type SiteAgentAppMcpRecommendation = {
  schemaVersion: 1;
  projectId: string;
  targetName: string;
  status: "not-required" | "review-required" | "approved" | "declined";
  rows: SiteAgentAppMcpRecommendationRow[];
  /** Unsupported declaration ids stay visible but can never become grants. */
  blocked: SiteAgentAppCapabilityIssue[];
  /** Stable digest over the exact displayed rows, including ready/key/install state. */
  readinessDigest: string;
  receiptId: string | null;
  decidedAt: string | null;
};

export type SiteAgentAppContractSnapshot = {
  schemaVersion: 1;
  /** Package declaration wins; inference is an explicit compatibility fallback. */
  source: "declared-package" | "declared-routing-card" | "composed-target" | "inferred-fallback";
  inputs: SiteAgentAppContractInput[];
  outputs: SiteAgentAppContractOutput[];
  capabilities: SiteAgentAppCapabilityProfile;
};

/**
 * Safe visual decisions copied from the accepted sandbox preview into the real
 * Astryx source tree. No HTML, CSS, scripts, or arbitrary theme tokens cross
 * this boundary.
 */
export type SiteAgentAppVisualSnapshot = {
  schemaVersion: 1;
  colorMode: "system" | "light" | "dark";
  accent: "neutral" | "blue" | "teal" | "purple" | "orange";
  density: "compact" | "comfortable" | "spacious";
  radius: "sharp" | "soft" | "round";
  headline: string;
  description: string;
  inputHeading: string;
  outputHeading: string;
  runLabel: string;
  emptyOutput: string;
};

/** Per-field clamp budgets for the selection payload (Orca-style). */
export const SITE_GRAB_BUDGET = {
  textSnippet: 400,
  htmlSnippet: 2_000,
  selector: 300,
  classes: 300,
  consoleMessage: 500,
} as const;

export type SiteScreenMeta = {
  id: string;
  projectId: string;
  name: string;
  fileName: string;
  createdAt: string;
  updatedAt: string;
  /** Non-null when this screen is one of N variants of the same brief. */
  variantGroup: string | null;
  variantLabel: string | null;
};

export type SiteProjectMeta = {
  id: string;
  name: string;
  /** Web/mobile retain the existing Site canvas pipeline; Agent App is Astryx-only. */
  surface: SiteSurface;
  agentAppTarget: SiteAgentAppTarget | null;
  astryxTemplate: SiteAstryxTemplate | null;
  /** Frozen at selection time so later profile-copy or heuristic changes cannot drift this app. */
  agentAppContract: SiteAgentAppContractSnapshot | null;
  /** Main-owned MCP recommendation decision. Never accepted from renderer input. */
  agentAppMcpConsent: SiteAgentAppMcpConsentReceipt | null;
  /** Last accepted preview's allowlisted visual decisions, applied to the runnable Astryx app. */
  agentAppVisual: SiteAgentAppVisualSnapshot | null;
  /** Runnable artifact, real thumbnail, and public deployment receipt for Agent App projects. */
  agentAppArtifact: SiteAgentAppArtifact | null;
  /** Append-only remote deployment truth, independent from rebuildable artifacts. */
  agentAppDeployments?: SiteAgentAppDeploymentRecord[];
  createdAt: string;
  updatedAt: string;
  screens: SiteScreenMeta[];
};

/**
 * Renderer-facing Site DTO. Main-owned artifact and thumbnail paths are
 * intentionally absent; every operation crosses IPC again using project ids.
 */
export type SiteAgentAppArtifactPublic = Omit<SiteAgentAppArtifact, "rootPath" | "thumbnail"> & {
  thumbnail: Omit<NonNullable<SiteAgentAppArtifact["thumbnail"]>, "path"> | null;
};

export type SiteProjectPublicMeta = Omit<SiteProjectMeta, "agentAppArtifact"> & {
  agentAppArtifact: SiteAgentAppArtifactPublic | null;
};

/** Site generation returns only the label the renderer actually displays. */
export type SiteAgentAppScaffoldSummary = {
  appName: string;
};

export type SiteProjectOperation = "generate" | "edit" | "handoff" | "publish" | "delete";

/**
 * 사람이 읽는 Site Copilot 대화 기록. 런타임에 넘기는 내부 HTML 프롬프트와 분리해
 * 프로젝트 폴더에만 저장한다. 따라서 재시작 뒤에도 사용자에게는 짧은 피드백만 복원된다.
 */
export type SiteConversationEntry = {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** 사용자가 선택해 수정한 대상의 짧은 식별자. */
  context?: string | null;
};

/**
 * Site Studio에서 사용자가 고른 로컬 작업공간으로 넘긴 불변 디자인 리비전.
 * 실제 경로는 선택한 워크스페이스 내부의 상대 경로만 공개해, Build 프롬프트가
 * 어느 파일을 시각 기준으로 삼아야 하는지 명확히 한다.
 */
export type SiteWorkspaceHandoff = {
  projectId: string;
  revision: string;
  /** 워크스페이스 루트 기준의 디자인 레퍼런스 폴더. */
  relativePath: string;
  screenCount: number;
  /** Build 입력칸에 그대로 이어지는 사용자용 구현 요청. */
  buildPrompt: string;
};

/**
 * Site 실행 중 renderer로만 보내는 실시간 상태. 실제 처리 단계와 사용자용 피드백만
 * 노출하며, 모델의 비공개 추론이나 내부 프롬프트/HTML은 담지 않는다.
 */
export type SiteActivityEvent =
  | { type: "message"; projectId: string; runId: string; entry: SiteConversationEntry }
  | { type: "status"; projectId: string; runId: string; text: string }
  | { type: "feedback-reset"; projectId: string; runId: string }
  | { type: "feedback-delta"; projectId: string; runId: string; delta: string }
  | { type: "complete"; projectId: string; runId: string };

export type SiteSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Curated computed-style subset captured on selection. Mirrors the fields a
 * designer actually reasons about; intentionally small to keep prompts cheap.
 */
export type SiteSelectionStyles = {
  display: string;
  position: string;
  width: string;
  height: string;
  margin: string;
  padding: string;
  color: string;
  backgroundColor: string;
  border: string;
  borderRadius: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  textAlign: string;
  zIndex: string;
};

export type SiteSelectionPayload = {
  /** data-agentlas-id of the selected element ("a" + source offset). */
  id: string;
  tagName: string;
  selector: string;
  role: string | null;
  ariaLabel: string | null;
  classes: string;
  textSnippet: string;
  htmlSnippet: string;
  styles: SiteSelectionStyles;
  /** Viewport-relative rect in CSS pixels. */
  rect: SiteSelectionRect;
  /** Page-relative rect (rect + scroll offsets). */
  pageRect: SiteSelectionRect;
  nearby: {
    parent: string | null;
    prev: string | null;
    next: string | null;
  };
  page: {
    title: string;
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
};

/** Messages posted from the sandboxed design iframe to the host renderer. */
export type SiteGuestMessage =
  | { type: "ready" }
  | { type: "select"; payload: SiteSelectionPayload }
  | { type: "scroll"; x: number; y: number }
  | { type: "console"; level: "error" | "warn"; message: string }
  | { type: "pageError"; message: string };

/** Messages posted from the host renderer into the design iframe. */
export type SiteHostMessage =
  | { type: "setMode"; mode: "browse" | "select" }
  | { type: "restoreScroll"; x: number; y: number }
  | { type: "clearSelection" }
  | { type: "highlight"; id: string }
  | { type: "setOverlayVisible"; visible: boolean };

/** Envelope key carried by every message across the iframe boundary. */
export const SITE_MESSAGE_KEY = "__agentlasSite";

export type SiteGuestEnvelope = {
  [SITE_MESSAGE_KEY]: string;
  message: SiteGuestMessage;
};

export type SiteHostEnvelope = {
  [SITE_MESSAGE_KEY]: string;
  message: SiteHostMessage;
};

/** One taggable element extracted by the tagger; offsets index the SOURCE html. */
export type SiteTaggedElement = {
  id: string;
  tagName: string;
  /** Offset of "<" of the open tag in the source document. */
  start: number;
  /** Offset just past the element (past "</tag>" or past a void/self-closing open tag). */
  end: number;
};

export type SiteContractResult = {
  ok: boolean;
  errors: string[];
};

const EXTERNAL_RESOURCE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /<script[^>]*\ssrc\s*=/i, label: "외부 <script src>" },
  { re: /<link[^>]+href\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 <link href>" },
  { re: /<img[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 <img src>" },
  { re: /<(?:video|audio|source|track)[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 미디어 src" },
  { re: /<iframe\b/i, label: "<iframe>" },
  { re: /url\(\s*["']?(?:https?:)?\/\//i, label: "CSS url() 외부 참조" },
  { re: /@import\b/i, label: "CSS @import" },
];

/**
 * Validate the generated screen against the design-only contract:
 * a complete, self-contained HTML document with no external resource loads.
 * (Anchors may point anywhere — the sandbox blocks navigation anyway.)
 */
export function validateSiteScreenHtml(html: string): SiteContractResult {
  const errors: string[] = [];
  const trimmed = html.trim();
  if (!trimmed) {
    return { ok: false, errors: ["빈 문서"] };
  }
  if (new TextEncoder().encode(trimmed).length > SITE_SCREEN_MAX_BYTES) {
    errors.push(`문서가 ${Math.round(SITE_SCREEN_MAX_BYTES / 1000)}KB 예산을 초과`);
  }
  if (!/<!doctype\s+html/i.test(trimmed) && !/<html[\s>]/i.test(trimmed)) {
    errors.push("완전한 HTML 문서가 아님 (<!doctype html> 또는 <html> 필요)");
  }
  if (!/<body[\s>]/i.test(trimmed)) {
    errors.push("<body>가 없음");
  }
  for (const { re, label } of EXTERNAL_RESOURCE_PATTERNS) {
    if (re.test(trimmed)) {
      errors.push(`외부 리소스 금지 위반: ${label}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function clampSiteText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Extract a fenced HTML document from a model reply (```html ... ``` or raw). */
export function extractSiteHtmlFromReply(reply: string): string | null {
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(reply);
  const candidate = (fence ? fence[1] : reply).trim();
  const docStart = candidate.search(/<!doctype\s+html|<html[\s>]/i);
  if (docStart < 0) return null;
  const endMatch = /<\/html\s*>/i.exec(candidate);
  const docEnd = endMatch ? endMatch.index + endMatch[0].length : candidate.length;
  return candidate.slice(docStart, docEnd).trim();
}
