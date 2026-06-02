import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceManifest,
  JsonObject,
  SurfaceApprovalKind,
  SurfaceJobCostSummary,
} from "@/lib/types";

export interface SurfaceApprovalSubject {
  id: string;
  manifest: AgentlasSurfaceManifest;
  jobSummary?: SurfaceJobCostSummary;
}

export interface SurfaceApprovalRequirement {
  scopeKey: string;
  message: string;
  persist: boolean;
  kind: SurfaceApprovalKind;
  title: string;
  summary: string;
  metadata: JsonObject;
}

const MUTATING_ACTIONS = new Set([
  "scaffold-agent-team",
  "scaffold-app",
  "operate-app",
  "install-mcp",
  "deploy-preview",
  "scaffold-tool",
  "install-tool-mcp",
  "run-smoke-test",
  "run-tool-smoke",
  "materialize-asset-pack",
]);

const DELEGATED_ACTIONS = new Set([
  "connect-service",
  "delegate-browser",
  "request-credential",
  "request-payment-approval",
  "generate",
]);

const AGENT_FIRST_ACTIONS = new Set([
  "scaffold-agent-team",
  "scaffold-app",
  "operate-app",
  "install-mcp",
  "deploy-preview",
  "scaffold-tool",
  "install-tool-mcp",
  "run-smoke-test",
  "run-tool-smoke",
  "materialize-asset-pack",
  "connect-service",
  "delegate-browser",
  "request-credential",
  "generate",
]);

export function surfaceApprovalRequirement(
  surface: SurfaceApprovalSubject,
  action: AgentlasSurfaceAction,
): SurfaceApprovalRequirement | null {
  const guarded = MUTATING_ACTIONS.has(action.type) || DELEGATED_ACTIONS.has(action.type);
  if (!guarded) return null;

  const manifest = surface.manifest;
  const capabilities = (manifest.capabilities ?? []).filter((capability) => capability.approval !== "none");
  const budget = manifest.budget;
  const summary = surface.jobSummary;
  const activeJobs = (manifest.jobs ?? []).filter(
    (job) => job.status === "queued" || job.status === "running" || job.status === "paused",
  );
  const jobEstimate =
    summary?.costEstimate ??
    activeJobs.reduce((sum, job) => sum + (typeof job.costEstimate === "number" ? job.costEstimate : 0), 0);
  const spent = summary?.costSpent ?? (typeof budget?.spent === "number" ? budget.spent : 0);
  const threshold =
    summary?.approvalThreshold ?? (typeof budget?.approvalThreshold === "number" ? budget.approvalThreshold : undefined);
  const limit = summary?.budgetLimit ?? (typeof budget?.limit === "number" ? budget.limit : undefined);
  const budgetGate =
    Boolean(budget || summary) &&
    ((threshold !== undefined && spent + jobEstimate >= threshold) ||
      (limit !== undefined && spent + jobEstimate > limit));
  const fullWithoutCapabilities = action.permission === "full" && capabilities.length === 0;
  const delegatedWithoutCapabilities = DELEGATED_ACTIONS.has(action.type) && capabilities.length === 0;
  const agentFirst =
    stringValue(isObject(manifest.delegation) ? manifest.delegation.mode : undefined) === "agent-operated" &&
    stringValue(isObject(manifest.delegation) && isObject(manifest.delegation.autonomy) ? manifest.delegation.autonomy.mode : undefined) !==
      "supervised";
  const checkpointAction = action.type === "request-payment-approval" || budgetGate || fullWithoutCapabilities || delegatedWithoutCapabilities;

  if (agentFirst && AGENT_FIRST_ACTIONS.has(action.type) && !checkpointAction) return null;

  if (capabilities.length === 0 && !budgetGate && !fullWithoutCapabilities && !delegatedWithoutCapabilities) return null;

  const currency = summary?.currency || budget?.currency || manifest.jobs?.find((job) => job.currency)?.currency || "USD";
  const capabilityKey = capabilities.map((capability) => capability.id).sort().join(",");
  const payment = isObject(action.payment) ? action.payment : undefined;
  const paymentScope =
    payment && action.type === "request-payment-approval"
      ? [
          stringValue(payment.merchant) || "merchant",
          payment.quoteRequired === true ? "quote" : `${stringValue(payment.currency) || "currency"}-${stringValue(payment.amount) || "amount"}`,
          stringValue(payment.recurrence) || "recurrence",
        ].join(":")
      : "";
  const scopeKey = [
    "surface-action",
    surface.id,
    action.id,
    action.type,
    capabilityKey || "no-capability",
    budget?.limit ?? "",
    budget?.approvalThreshold ?? "",
    paymentScope,
  ].join(":");

  const kind = approvalKind(action, budgetGate, fullWithoutCapabilities);
  const metadata: JsonObject = {
    actionId: action.id,
    actionType: action.type,
    permission: action.permission ?? "write",
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      type: capability.type,
      approval: capability.approval ?? "once",
    })),
    budget: budget
      ? {
          currency,
          spent,
          limit: limit ?? null,
          queuedEstimate: jobEstimate,
          approvalThreshold: threshold ?? null,
        }
      : null,
    payment:
      payment && action.type === "request-payment-approval"
        ? {
            merchant: stringValue(payment.merchant) || "not declared",
            quoteRequired: payment.quoteRequired === true,
            amount: typeof payment.amount === "number" ? payment.amount : null,
            currency: stringValue(payment.currency) || null,
            recurrence: stringValue(payment.recurrence) || "unknown",
            approvalMode: stringValue(payment.approvalMode) || "explicit-before-checkout",
            cardHandling: stringValue(payment.cardHandling) || "provider-checkout",
          }
        : null,
  };

  const lines = [
    `${action.label} needs Agentlas OS approval.`,
    "",
    capabilities.length
      ? `Declared capabilities: ${capabilities.map((capability) => `${capability.type}:${capability.id}`).join(", ")}`
      : "Declared capabilities: none",
    budget
      ? `Budget: ${currency} ${spent}${limit !== undefined ? `/${limit}` : ""}${
          jobEstimate ? `, queued estimate ${jobEstimate}` : ""
        }`
      : "Budget: not declared",
    payment && action.type === "request-payment-approval"
      ? `Payment: ${stringValue(payment.merchant) || "merchant not declared"}, ${
          payment.quoteRequired === true
            ? "quoted at checkout"
            : `${stringValue(payment.currency) || "currency"} ${stringValue(payment.amount) || "amount"}`
        }, ${stringValue(payment.recurrence) || "unknown recurrence"}`
      : "",
    fullWithoutCapabilities
      ? "Warning: this action asks for full permission but the manifest declares no capability scope."
      : "",
    delegatedWithoutCapabilities
      ? "Warning: this delegated action has no declared capability scope."
      : "",
    "",
    "Approve to continue?",
  ].filter(Boolean);

  const persist =
    capabilities.length > 0 &&
    capabilities.every((capability) => capability.approval === undefined || capability.approval === "once") &&
    !fullWithoutCapabilities &&
    !delegatedWithoutCapabilities &&
    action.type !== "request-payment-approval" &&
    action.type !== "request-credential" &&
    !budgetGate;

  return {
    scopeKey,
    message: lines.join("\n"),
    persist,
    kind,
    title: action.label,
    summary: lines.join("\n"),
    metadata,
  };
}

function approvalKind(
  action: AgentlasSurfaceAction,
  budgetGate: boolean,
  fullWithoutCapabilities: boolean,
): SurfaceApprovalKind {
  if (action.type === "request-payment-approval") return "payment";
  if (action.type === "request-credential") return "credential";
  if (action.type === "delegate-browser" || action.type === "connect-service") return "browser-session";
  if (budgetGate) return "budget";
  if (fullWithoutCapabilities) return "full-permission";
  return "capability";
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
