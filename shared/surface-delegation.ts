import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceCapability,
  AgentlasSurfaceConnectorSpec,
  AgentlasSurfaceManifest,
  JsonObject,
} from "./types";

export const AGENTLAS_OS_FALLBACK_LADDER = [
  "installed-mcp-or-api",
  "browser-delegation",
  "provider-console-account-or-app",
  "agentlas-vault-credential",
  "approved-provider-checkout",
  "alternate-provider",
  "generated-local-helper-or-tool",
  "explicit-human-handoff-only-for-legal-identity-or-provider-block",
] as const;

export type AgentlasDelegationStepKind =
  | "connector"
  | "browser"
  | "credential"
  | "payment-approval"
  | "budget"
  | "local-tool"
  | "reversible-write";

export type AgentlasDelegationStepStatus =
  | "ready"
  | "needs-approval"
  | "needs-secret"
  | "needs-payment-approval"
  | "blocked-by-contract"
  | "planned";

export interface AgentlasSurfaceCredentialRequest {
  id: string;
  label: string;
  envKey: string;
  provider?: string;
  purpose?: string;
  inputMode: "agentlas-vault" | "provider-page" | "oauth-browser";
  requiredWhen?: string;
  status?: "not-requested" | "saved" | "missing" | "not-needed" | string;
}

export interface AgentlasSurfacePaymentRequest {
  id: string;
  merchant: string;
  amount?: number;
  currency?: string;
  quoteRequired?: boolean;
  recurrence: "one-time" | "monthly" | "annual" | "usage-based" | "unknown" | string;
  approvalMode: "explicit-before-checkout" | "explicit-before-spend" | string;
  cardHandling: "provider-checkout" | "agentlas-secure-field" | "no-card-storage" | string;
  status?: "not-requested" | "approved" | "declined" | "not-needed" | string;
}

export interface AgentlasSurfaceAutonomyPolicy {
  mode: "agent-first" | "supervised" | string;
  allowedWithoutPrompt: string[];
  checkpoints: string[];
  noDeadEndReasons: string[];
  destructiveActions: string[];
}

export interface AgentlasDelegationStep {
  id: string;
  kind: AgentlasDelegationStepKind;
  label: string;
  status: AgentlasDelegationStepStatus;
  details: string[];
  actionIds: string[];
  capabilityIds: string[];
  connectorIds: string[];
}

export interface AgentlasSurfaceDelegationPlan {
  mode: "agent-operated";
  autonomy: AgentlasSurfaceAutonomyPolicy;
  fallbackLadder: string[];
  steps: AgentlasDelegationStep[];
  credentialRequests: AgentlasSurfaceCredentialRequest[];
  paymentRequests: AgentlasSurfacePaymentRequest[];
  issues: string[];
}

const CONNECTOR_ACTION_TYPES = new Set([
  "connect-service",
  "delegate-browser",
  "request-credential",
  "install-mcp",
  "scaffold-tool",
]);
const SERVICE_OPERATION_ACTION_TYPES = new Set([
  "connect-service",
  "delegate-browser",
  "request-credential",
  "request-payment-approval",
  "operate-app",
]);
const CREDENTIAL_AUTH = new Set(["api-key", "oauth", "user-approval"]);
const READY_CONNECTOR_STATUS = new Set(["verified", "configured", "ready"]);
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|cookie|session|private[_-]?key|card[_-]?number|cvv|cvc)/i;
const REQUIRED_NO_DEAD_END_LADDER = [
  "browser-delegation",
  "alternate-provider",
  "generated-local-helper-or-tool",
];
const REQUIRED_NO_DEAD_END_REASONS = [
  "missing-api",
  "missing-mcp",
  "unsupported-region",
  "provider-console-complexity",
  "credential-missing",
  "paid-service-required",
];
const REQUIRED_AGENT_FIRST_AUTONOMY = [
  "browser-navigation",
  "provider-account-signup",
  "provider-app-creation",
  "api-key-creation",
  "webhook-setup",
  "alternate-provider-switch",
];
const REQUIRED_SECURE_CHECKPOINTS = [
  "password-entry",
  "otp-entry",
  "legal-identity-confirmation",
];
const REQUIRED_PAYMENT_CHECKPOINTS = [
  "card-or-cvv-entry",
  "payment-submit",
];

export function buildSurfaceDelegationPlan(manifest: AgentlasSurfaceManifest): AgentlasSurfaceDelegationPlan {
  const actions = manifest.actions ?? [];
  const capabilities = manifest.capabilities ?? [];
  const connectors = manifest.app?.connectors ?? [];
  const delegation = objectValue(manifest.delegation);
  const declaredCredentials = credentialRequestsFromDelegation(delegation);
  const declaredPayments = paymentRequestsFromDelegation(delegation);
  const credentialRequests = mergeCredentialRequests([
    ...declaredCredentials,
    ...credentialRequestsFromConnectors(connectors),
    ...credentialRequestsFromActions(actions),
  ]);
  const paymentRequests = mergePaymentRequests([
    ...declaredPayments,
    ...paymentRequestsFromConnectors(connectors),
    ...paymentRequestsFromActions(actions),
  ]);
  const steps: AgentlasDelegationStep[] = [];
  const issues: string[] = [];

  const connectorActions = actions.filter((action) => CONNECTOR_ACTION_TYPES.has(action.type));
  const browserCapabilities = capabilities.filter((capability) => capability.type === "browser-session");
  const credentialCapabilities = capabilities.filter((capability) => capability.type === "credential");
  const paymentCapabilities = capabilities.filter((capability) =>
    ["payment", "payment-method", "human-approval"].includes(capability.type),
  );
  const filesystemCapabilities = capabilities.filter((capability) => capability.type === "filesystem");
  const modelGenerationCapabilities = capabilities.filter((capability) => capability.type === "model-generation");

  for (const connector of connectors) {
    const auth = stringValue(connector.auth) || "user-approval";
    const status = stringValue(connector.status) || "proposed";
    const needsSetup = !READY_CONNECTOR_STATUS.has(status);
    if (!needsSetup) continue;
    const actionIds = connectorActions.map((action) => action.id);
    const capabilityIds = matchingCapabilityIds(capabilities, ["browser-session", "credential", "external-api", "network"]);
    steps.push({
      id: `connector:${connector.id}`,
      kind: "connector",
      label: `Connect ${connector.name}`,
      status: CREDENTIAL_AUTH.has(auth) || status === "missing-credential" ? "needs-secret" : "needs-approval",
      details: [
        `Auth: ${auth}`,
        `Status: ${status}`,
        "Agent should operate MCP/API first, then browser/provider console, then vault credential, then alternate provider or local tool.",
      ],
      actionIds,
      capabilityIds,
      connectorIds: [connector.id],
    });
    if (actionIds.length === 0) {
      issues.push(`Connector "${connector.id}" needs setup but no connect-service/delegate-browser/request-credential/install action is declared.`);
    }
    if (capabilityIds.length === 0) {
      issues.push(`Connector "${connector.id}" needs setup but no browser/credential/network capability is declared.`);
    }
  }

  if (browserCapabilities.length > 0 || actions.some((action) => action.type === "delegate-browser")) {
    steps.push({
      id: "browser-delegation",
      kind: "browser",
      label: "Agent-operated browser session",
      status: "needs-approval",
      details: [
        "Use the logged-in browser or provider web console when no direct MCP/API is available.",
        "User only types passwords, one-time codes, or legally sensitive identity confirmations into provider/secure UI.",
      ],
      actionIds: actions.filter((action) => action.type === "delegate-browser" || action.type === "connect-service").map((action) => action.id),
      capabilityIds: browserCapabilities.map((capability) => capability.id),
      connectorIds: connectors.map((connector) => connector.id),
    });
  }

  for (const request of credentialRequests) {
    steps.push({
      id: `credential:${request.id}`,
      kind: "credential",
      label: request.label.toLowerCase().startsWith("save ") ? request.label : `Save ${request.label}`,
      status: request.status === "saved" ? "ready" : "needs-secret",
      details: [
        `Vault key: ${request.envKey}`,
        request.provider ? `Provider: ${request.provider}` : "Provider: declared by surface",
        "Secret value must go through Agentlas vault or provider page, not ordinary chat or generated source.",
      ],
      actionIds: actions.filter((action) => action.type === "request-credential" || action.type === "connect-service").map((action) => action.id),
      capabilityIds: credentialCapabilities.map((capability) => capability.id),
      connectorIds: connectors.filter((connector) => connectorNameMatchesRequest(connector, request)).map((connector) => connector.id),
    });
    if (credentialCapabilities.length === 0) {
      issues.push(`Credential request "${request.id}" exists but no credential capability is declared.`);
    }
  }

  for (const request of paymentRequests) {
    const hasQuote = request.quoteRequired === true || (typeof request.amount === "number" && Boolean(request.currency));
    steps.push({
      id: `payment:${request.id}`,
      kind: "payment-approval",
      label: `Approve payment for ${request.merchant}`,
      status: request.status === "approved" ? "ready" : "needs-payment-approval",
      details: [
        request.quoteRequired ? "Amount: quoted at checkout" : `Amount: ${request.currency ?? "?"} ${request.amount ?? "?"}`,
        `Recurrence: ${request.recurrence}`,
        `Card handling: ${request.cardHandling}`,
      ],
      actionIds: actions.filter((action) => action.type === "request-payment-approval" || action.type === "connect-service").map((action) => action.id),
      capabilityIds: paymentCapabilities.map((capability) => capability.id),
      connectorIds: connectors.filter((connector) => connector.type === "payment").map((connector) => connector.id),
    });
    if (paymentCapabilities.length === 0) {
      issues.push(`Payment request "${request.id}" exists but no payment/human-approval capability is declared.`);
    }
    if (!hasQuote) {
      issues.push(`Payment request "${request.id}" must declare amount+currency or quoteRequired:true.`);
    }
    if (!request.merchant || !request.recurrence || !request.approvalMode || !request.cardHandling) {
      issues.push(`Payment request "${request.id}" is missing merchant, recurrence, approvalMode, or cardHandling.`);
    }
  }

  if ((manifest.jobs ?? []).some((job) => Number(job.costEstimate ?? 0) > 0 || Number(job.costSpent ?? 0) > 0)) {
    steps.push({
      id: "budget-gate",
      kind: "budget",
      label: "Generation spend gate",
      status: "needs-approval",
      details: [
        `Budget: ${manifest.budget?.currency ?? "USD"} ${manifest.budget?.spent ?? 0}/${manifest.budget?.limit ?? "not declared"}`,
        `Approval threshold: ${manifest.budget?.approvalThreshold ?? "not declared"}`,
      ],
      actionIds: actions.filter((action) => action.type === "generate" || action.type === "materialize-asset-pack").map((action) => action.id),
      capabilityIds: modelGenerationCapabilities.map((capability) => capability.id),
      connectorIds: [],
    });
  }

  if (actions.some((action) => action.permission === "write" || action.permission === "full")) {
    steps.push({
      id: "reversible-writes",
      kind: "reversible-write",
      label: "Reversible workspace changes",
      status: filesystemCapabilities.length > 0 ? "ready" : "blocked-by-contract",
      details: ["Generated files, tools, apps, and MCP installs must register archive/undo operations."],
      actionIds: actions.filter((action) => action.permission === "write" || action.permission === "full").map((action) => action.id),
      capabilityIds: filesystemCapabilities.map((capability) => capability.id),
      connectorIds: [],
    });
  }

  for (const action of actions) {
    if (action.type !== "request-payment-approval") continue;
    const payment = objectValue(action.payment);
    if (!payment) {
      issues.push(`Payment action "${action.id}" must include a payment contract object.`);
      continue;
    }
    const quoteRequired = booleanValue(payment.quoteRequired);
    const amount = numberValue(payment.amount);
    const currency = stringValue(payment.currency);
    if (!stringValue(payment.merchant) || !stringValue(payment.recurrence) || !stringValue(payment.approvalMode)) {
      issues.push(`Payment action "${action.id}" must declare merchant, recurrence, and approvalMode.`);
    }
    if (quoteRequired !== true && (amount === undefined || !currency)) {
      issues.push(`Payment action "${action.id}" must declare amount+currency or quoteRequired:true.`);
    }
  }

  for (const request of credentialRequests) {
    if (SECRET_KEY_RE.test(request.envKey) && request.envKey.includes("=")) {
      issues.push(`Credential request "${request.id}" appears to include a secret value in envKey.`);
    }
  }

  const unresolvedConnectors = connectors.filter((connector) => !READY_CONNECTOR_STATUS.has(stringValue(connector.status) || "proposed"));
  const serviceActions = actions.filter((action) => SERVICE_OPERATION_ACTION_TYPES.has(action.type));
  const requiresNoDeadEndContract =
    unresolvedConnectors.length > 0 ||
    serviceActions.length > 0 ||
    credentialRequests.length > 0 ||
    paymentRequests.length > 0;
  if (requiresNoDeadEndContract) {
    issues.push(...explicitNoDeadEndContractIssues({
      delegation,
      autonomy: objectValue(delegation?.autonomy) ?? objectValue(delegation?.autonomyPolicy),
      paymentRequired: paymentRequests.length > 0 || actions.some((action) => action.type === "request-payment-approval"),
      connectorIds: unresolvedConnectors.map((connector) => connector.id),
      actionIds: serviceActions.map((action) => action.id),
    }));
  }

  return {
    mode: "agent-operated",
    autonomy: autonomyPolicyFromDelegation(delegation),
    fallbackLadder: stringArray(delegation?.fallbackLadder).length
      ? stringArray(delegation?.fallbackLadder)
      : [...AGENTLAS_OS_FALLBACK_LADDER],
    steps: dedupeSteps(steps),
    credentialRequests,
    paymentRequests,
    issues: [...new Set(issues)],
  };
}

export function lintSurfaceDelegation(manifest: AgentlasSurfaceManifest): string[] {
  return buildSurfaceDelegationPlan(manifest).issues;
}

function explicitNoDeadEndContractIssues(input: {
  delegation?: JsonObject;
  autonomy?: JsonObject;
  paymentRequired: boolean;
  connectorIds: string[];
  actionIds: string[];
}): string[] {
  const issues: string[] = [];
  const delegation = input.delegation;
  const autonomy = input.autonomy;
  const context = [
    input.connectorIds.length ? `connectors: ${input.connectorIds.join(", ")}` : "",
    input.actionIds.length ? `actions: ${input.actionIds.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  if (!delegation) {
    issues.push(`Provider/service operation requires explicit delegation.mode="agent-operated" and fallbackLadder (${context || "service operation"}).`);
    return issues;
  }
  if (stringValue(delegation.mode) !== "agent-operated") {
    issues.push('Provider/service operation requires delegation.mode="agent-operated".');
  }
  const ladder = stringArray(delegation.fallbackLadder);
  if (ladder.length === 0) {
    issues.push("Provider/service operation requires an explicit delegation.fallbackLadder; relying on defaults is not enough for Agentlas OS admission.");
  } else {
    for (const step of REQUIRED_NO_DEAD_END_LADDER) {
      if (!ladder.includes(step)) {
        issues.push(`delegation.fallbackLadder must include "${step}" so missing API/MCP does not become a dead end.`);
      }
    }
  }
  if (!autonomy) {
    issues.push("Provider/service operation requires delegation.autonomy with agent-first permissions and secure checkpoints.");
    return issues;
  }
  if (stringValue(autonomy.mode) !== "agent-first") {
    issues.push('delegation.autonomy.mode must be "agent-first" for provider setup flows.');
  }
  const allowed = stringArray(autonomy.allowedWithoutPrompt);
  for (const item of REQUIRED_AGENT_FIRST_AUTONOMY) {
    if (!allowed.includes(item)) {
      issues.push(`delegation.autonomy.allowedWithoutPrompt must include "${item}".`);
    }
  }
  const noDeadEndReasons = stringArray(autonomy.noDeadEndReasons);
  for (const item of REQUIRED_NO_DEAD_END_REASONS) {
    if (!noDeadEndReasons.includes(item)) {
      issues.push(`delegation.autonomy.noDeadEndReasons must include "${item}".`);
    }
  }
  const checkpoints = stringArray(autonomy.checkpoints);
  for (const item of REQUIRED_SECURE_CHECKPOINTS) {
    if (!checkpoints.includes(item)) {
      issues.push(`delegation.autonomy.checkpoints must include secure checkpoint "${item}".`);
    }
  }
  if (input.paymentRequired) {
    for (const item of REQUIRED_PAYMENT_CHECKPOINTS) {
      if (!checkpoints.includes(item)) {
        issues.push(`payment-capable delegation.autonomy.checkpoints must include "${item}".`);
      }
    }
  }
  return issues;
}

function credentialRequestsFromDelegation(delegation?: JsonObject): AgentlasSurfaceCredentialRequest[] {
  const raw = [...objectArray(delegation?.credentials), ...objectArray(delegation?.secrets)];
  return raw
    .map((item, idx): AgentlasSurfaceCredentialRequest | null => {
      const envKey = stringValue(item.envKey) || stringValue(item.key);
      if (!envKey) return null;
      const request: AgentlasSurfaceCredentialRequest = {
        id: stringValue(item.id) || slugify(envKey) || `credential-${idx + 1}`,
        label: stringValue(item.label) || stringValue(item.name) || envKey,
        envKey,
        inputMode: credentialInputMode(item.inputMode),
      };
      const provider = stringValue(item.provider);
      const purpose = stringValue(item.purpose);
      const requiredWhen = stringValue(item.requiredWhen);
      const status = stringValue(item.status);
      if (provider) request.provider = provider;
      if (purpose) request.purpose = purpose;
      if (requiredWhen) request.requiredWhen = requiredWhen;
      if (status) request.status = status;
      return request;
    })
    .filter((item): item is AgentlasSurfaceCredentialRequest => item !== null);
}

function credentialRequestsFromConnectors(connectors: AgentlasSurfaceConnectorSpec[]): AgentlasSurfaceCredentialRequest[] {
  return connectors
    .filter((connector) => CREDENTIAL_AUTH.has(stringValue(connector.auth) || ""))
    .map((connector) => {
      const envKey = stringValue(connector.envKey) || connectorEnvKey(connector);
      return {
        id: `connector-${connector.id}-credential`,
        label: `${connector.name} credential`,
        envKey,
        provider: connector.name,
        purpose: connector.purpose,
        inputMode: connector.auth === "oauth" ? "oauth-browser" : "agentlas-vault",
        requiredWhen: `Using ${connector.name}`,
        status: connector.status === "verified" || connector.status === "configured" ? "saved" : "missing",
      };
    });
}

function credentialRequestsFromActions(actions: AgentlasSurfaceAction[]): AgentlasSurfaceCredentialRequest[] {
  return actions
    .filter((action) => action.type === "request-credential")
    .map((action, idx) => {
      const envKey = stringValue(action.envKey) || stringValue(action.key) || `AGENTLAS_SURFACE_${idx + 1}_SECRET`;
      return {
        id: action.id,
        label: action.label || envKey,
        envKey,
        provider: stringValue(action.provider),
        purpose: action.prompt,
        inputMode: credentialInputMode(action.inputMode),
        requiredWhen: stringValue(action.requiredWhen),
        status: stringValue(action.status) || "missing",
      };
    });
}

function paymentRequestsFromDelegation(delegation?: JsonObject): AgentlasSurfacePaymentRequest[] {
  return objectArray(delegation?.payments)
    .map((item, idx) => paymentRequestFromObject(item, stringValue(item.id) || `payment-${idx + 1}`))
    .filter((item): item is AgentlasSurfacePaymentRequest => item !== null);
}

function paymentRequestsFromConnectors(connectors: AgentlasSurfaceConnectorSpec[]): AgentlasSurfacePaymentRequest[] {
  return connectors
    .filter((connector) => connector.type === "payment")
    .map((connector) => ({
      id: `connector-${connector.id}-payment`,
      merchant: connector.name,
      quoteRequired: true,
      recurrence: "unknown",
      approvalMode: "explicit-before-checkout",
      cardHandling: "provider-checkout",
      status: connector.status === "verified" || connector.status === "configured" ? "approved" : "not-requested",
    }));
}

function paymentRequestsFromActions(actions: AgentlasSurfaceAction[]): AgentlasSurfacePaymentRequest[] {
  return actions
    .filter((action) => action.type === "request-payment-approval")
    .map((action) => paymentRequestFromObject(objectValue(action.payment) ?? (action as unknown as JsonObject), action.id))
    .filter((item): item is AgentlasSurfacePaymentRequest => item !== null);
}

function paymentRequestFromObject(raw: JsonObject, fallbackId: string): AgentlasSurfacePaymentRequest | null {
  const merchant = stringValue(raw.merchant) || stringValue(raw.provider) || stringValue(raw.name);
  if (!merchant) return null;
  return {
    id: stringValue(raw.id) || fallbackId,
    merchant,
    amount: numberValue(raw.amount),
    currency: stringValue(raw.currency),
    quoteRequired: booleanValue(raw.quoteRequired),
    recurrence: stringValue(raw.recurrence) || "unknown",
    approvalMode: stringValue(raw.approvalMode) || "explicit-before-checkout",
    cardHandling: stringValue(raw.cardHandling) || "provider-checkout",
    status: stringValue(raw.status) || "not-requested",
  };
}

function autonomyPolicyFromDelegation(delegation?: JsonObject): AgentlasSurfaceAutonomyPolicy {
  const raw = objectValue(delegation?.autonomy) ?? objectValue(delegation?.autonomyPolicy);
  return {
    mode: stringValue(raw?.mode) || "agent-first",
    allowedWithoutPrompt: stringArray(raw?.allowedWithoutPrompt).length
      ? stringArray(raw?.allowedWithoutPrompt)
      : [
          "browser-navigation",
          "provider-account-signup",
          "provider-app-creation",
          "api-key-creation",
          "webhook-setup",
          "local-file-write",
          "mcp-adapter-generation",
          "local-tool-scaffold",
          "local-preview-deploy",
          "alternate-provider-switch",
        ],
    checkpoints: stringArray(raw?.checkpoints).length
      ? stringArray(raw?.checkpoints)
      : [
          "password-entry",
          "otp-entry",
          "legal-identity-confirmation",
          "terms-or-compliance-attestation",
          "card-or-cvv-entry",
          "payment-submit",
          "budget-threshold-exceeded",
          "destructive-delete-or-archive",
        ],
    noDeadEndReasons: stringArray(raw?.noDeadEndReasons).length
      ? stringArray(raw?.noDeadEndReasons)
      : [
          "missing-api",
          "missing-mcp",
          "unsupported-region",
          "provider-console-complexity",
          "credential-missing",
          "paid-service-required",
        ],
    destructiveActions: stringArray(raw?.destructiveActions).length
      ? stringArray(raw?.destructiveActions)
      : ["delete-files", "archive-os-object", "unregister-mcp", "revoke-credential", "cancel-paid-service"],
  };
}

function mergeCredentialRequests(requests: AgentlasSurfaceCredentialRequest[]): AgentlasSurfaceCredentialRequest[] {
  const map = new Map<string, AgentlasSurfaceCredentialRequest>();
  for (const request of requests) {
    const existing = map.get(request.envKey);
    map.set(request.envKey, existing ? { ...request, ...existing, status: existing.status ?? request.status } : request);
  }
  return [...map.values()];
}

function mergePaymentRequests(requests: AgentlasSurfacePaymentRequest[]): AgentlasSurfacePaymentRequest[] {
  const map = new Map<string, AgentlasSurfacePaymentRequest>();
  for (const request of requests) {
    const key = [
      request.merchant.toLowerCase(),
      request.quoteRequired === true ? "quote" : request.amount ?? "",
      request.currency ?? "",
      request.recurrence,
    ].join(":");
    const existing = map.get(key);
    map.set(key, existing ? { ...request, ...existing, status: existing.status ?? request.status } : request);
  }
  return [...map.values()];
}

function dedupeSteps(steps: AgentlasDelegationStep[]): AgentlasDelegationStep[] {
  const map = new Map<string, AgentlasDelegationStep>();
  for (const step of steps) map.set(step.id, step);
  return [...map.values()];
}

function matchingCapabilityIds(capabilities: AgentlasSurfaceCapability[], types: string[]): string[] {
  return capabilities.filter((capability) => types.includes(capability.type)).map((capability) => capability.id);
}

function connectorNameMatchesRequest(connector: AgentlasSurfaceConnectorSpec, request: AgentlasSurfaceCredentialRequest): boolean {
  const provider = request.provider?.toLowerCase();
  if (!provider) return false;
  return connector.name.toLowerCase() === provider || connector.id.toLowerCase() === provider;
}

function connectorEnvKey(connector: AgentlasSurfaceConnectorSpec): string {
  const base = slugify(connector.id || connector.name).replace(/-/g, "_").toUpperCase();
  if (connector.auth === "oauth") return `${base}_OAUTH_TOKEN`;
  if (connector.auth === "user-approval") return `${base}_USER_APPROVAL`;
  return `${base}_API_KEY`;
}

function credentialInputMode(value: unknown): AgentlasSurfaceCredentialRequest["inputMode"] {
  const v = stringValue(value);
  if (v === "provider-page" || v === "oauth-browser") return v;
  return "agentlas-vault";
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function objectValue(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
