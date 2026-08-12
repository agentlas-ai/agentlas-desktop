// Agent OS surface emitter.
// Agents can emit a hidden <<agentlas-surface>> JSON block. The main process
// validates and strips it, then sends a typed `surface` event to the renderer.
// This is deliberately declarative: no model-generated HTML/JS/React executes.
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceBudget,
  AgentlasSurfaceCapability,
  AgentlasSurfaceClaim,
  AgentlasSurfaceDataSet,
  AgentlasSurfaceEvidence,
  AgentlasSurfaceJob,
  AgentlasSurfaceManifest,
  AgentlasSurfaceProvenance,
  AgentlasSurfaceStateField,
  AgentlasSurfaceWidget,
  JsonObject,
  JsonValue,
} from "../shared/types";
import { SURFACE_TRUST_REGISTRY, lintSurfaceTrust } from "./surface-trust";

// 울타리 문자열의 정본은 shared/agent-control-blocks.ts 한 곳이다. 표면마다 상수를
// 다시 적으면 스트리퍼 하나가 이 마커를 모르는 채로 남아 원문이 새어 나간다
// (2026-08-12 사용자 제보: followups + surface 동시 노출).
export { AGENT_SURFACE_OPEN as SURFACE_OPEN_FENCE, AGENT_SURFACE_CLOSE as SURFACE_CLOSE_FENCE } from "../shared/agent-control-blocks";
import { AGENT_SURFACE_OPEN, AGENT_SURFACE_CLOSE } from "../shared/agent-control-blocks";
const SURFACE_OPEN_FENCE = AGENT_SURFACE_OPEN;
const SURFACE_CLOSE_FENCE = AGENT_SURFACE_CLOSE;

const MAX_SURFACES_PER_REPLY = 3;
const MAX_SURFACE_BYTES = 300_000;
const FORBIDDEN_KEY_RE =
  /(api[_-]?key|token|secret|password|authorization|cookie|session|private[_-]?key|card[_-]?number|cvv|cvc)/i;

export const SURFACE_DISCOVERY_CATALOG = {
  version: "0.1",
  primitive: "Agentlas Surface Manifest",
  layouts: [
    "report",
    "table",
    "dashboard",
    "map-list",
    "timeline",
    "workflow",
    "form",
    "creative-studio",
    "service-app",
  ],
  widgets: [
    "map",
    "chart",
    "form",
    "report",
    "brief-panel",
    "storyboard",
    "shot-list",
    "asset-board",
    "model-router",
    "rights-provenance",
    "export-pack",
    "cost-summary",
    "source-matrix",
    "app-shell",
    "service-blueprint",
    "mcp-builder",
    "tool-builder",
    "connector-matrix",
    "launch-checklist",
    "pricing-model",
    "deployment-plan",
    "table",
    "cards",
    "timeline",
    "workflow",
    "issue-tree",
  ],
  actions: [
    "agent-followup",
    "copy",
    "generate",
    "retry",
    "export",
    "open-file",
    "external-link",
    "scaffold-agent-team",
    "scaffold-app",
    "operate-app",
    "install-mcp",
    "run-smoke-test",
    "deploy-preview",
    "scaffold-tool",
    "run-tool-smoke",
    "install-tool-mcp",
    "materialize-asset-pack",
    "connect-service",
    "delegate-browser",
    "request-credential",
    "request-payment-approval",
    "save-as-product",
    "publish-as-tool",
  ],
  trustContract: {
    evidenceKinds: ["verified", "claimed", "estimated", "unverified"],
    requiredFor: ["numbers", "prices", "dates", "legal/tax claims", "finance metrics", "launch proof"],
    capabilityTypes: [
      "network",
      "filesystem",
      "pii",
      "payment",
      "payment-method",
      "credential",
      "browser-session",
      "external-api",
      "model-generation",
      "human-approval",
    ],
    delegationFallbackLadder: [
      "installed-mcp-or-api",
      "browser-delegation",
      "provider-console-account-or-app",
      "agentlas-vault-credential",
      "approved-provider-checkout",
      "alternate-provider",
      "generated-local-helper-or-tool",
      "explicit-human-handoff-only-for-legal-identity-or-provider-block",
    ],
    autonomy: {
      defaultMode: "agent-first",
      allowedWithoutPrompt: [
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
      checkpoints: [
        "password-entry",
        "otp-entry",
        "legal-identity-confirmation",
        "terms-or-compliance-attestation",
        "card-or-cvv-entry",
        "payment-submit",
        "budget-threshold-exceeded",
        "destructive-delete-or-archive",
      ],
      noDeadEndReasons: [
        "missing-api",
        "missing-mcp",
        "unsupported-region",
        "provider-console-complexity",
        "credential-missing",
        "paid-service-required",
      ],
    },
    stateOwners: ["agent", "user", "derived"],
    rules: SURFACE_TRUST_REGISTRY,
    admissionGates: [
      "Provider/service operation requires explicit delegation.mode='agent-operated'; defaults are not enough.",
      "delegation.fallbackLadder must explicitly include browser-delegation, alternate-provider, and generated-local-helper-or-tool.",
      "delegation.autonomy.noDeadEndReasons must explicitly cover missing-api, missing-mcp, unsupported-region, provider-console-complexity, credential-missing, and paid-service-required.",
      "delegation.autonomy.allowedWithoutPrompt must let the agent navigate provider consoles, sign up, create provider apps/API keys/webhooks, and switch providers.",
      "Payment-capable surfaces must include card-or-cvv-entry and payment-submit as secure checkpoints.",
    ],
  },
  domainPacks: [
    {
      id: "creative-social-ad-pack",
      when: "User provides product URL, product image, campaign brief, or asks for ads/videos/assets.",
      goal: "Turn product input into a reviewable, launchable social ad production mini-app.",
      preferredLayouts: ["creative-studio", "service-app"],
      requiredDataSets: {
        brief: "json: product, audience, channel, constraints, brand notes",
        shots: "table: scene, duration, prompt, model, status, evidenceIds",
        assets: "media: generated or imported assets with status, url/src, evidenceIds",
        exports: "table: channel, format, caption, file, status",
        launch: "launch-checklist: budget gate, rights check, smoke/review checks",
      },
      requiredWidgets: [
        "brief-panel",
        "storyboard",
        "shot-list",
        "asset-board",
        "model-router",
        "rights-provenance",
        "export-pack",
        "cost-summary",
        "launch-checklist",
      ],
      requiredGovernance: [
        "capabilities entry for model-generation before image/video/audio generation",
        "budget with currency, limit, spent, approvalThreshold",
        "jobs with stable ids, status, costEstimate, resumable true when generation is async",
        "stateSchema fields for user-owned shot approvals/rejections using merge: preserve-user",
        "claims/evidence marking any performance, price, rights, or factual claim",
      ],
      suggestedActions: [
        { id: "asset-pack", type: "materialize-asset-pack", label: "Materialize asset pack" },
        { id: "scaffold", type: "scaffold-app", label: "Scaffold production app" },
        { id: "build-prompt-tool", type: "scaffold-tool", label: "Build prompt QA tool" },
        { id: "smoke", type: "run-smoke-test", label: "Run launch smoke" },
        { id: "deploy", type: "deploy-preview", label: "Package preview" },
      ],
    },
    {
      id: "ecommerce-operator-os",
      when: "User wants to start, operate, or automate an ecommerce/shop/store business.",
      goal: "Turn commerce intent into a launchable storefront and operating dashboard with payment, database, catalog, image, order, and support workflows.",
      preferredLayouts: ["service-app", "workflow", "dashboard"],
      requiredDataSets: {
        brief: "json: business, category, audience, region, tone, constraints",
        products: "table: name, status, imageStatus, copyStatus, evidenceIds/trust",
        orders: "table/workflow: lane, status, owner, evidenceIds/trust",
        connectors: "table: payment, database, storefront host, image generation, analytics, fulfillment",
        launch: "launch-checklist: provider setup, credentials, payment approval, smoke tests, rollback",
      },
      requiredWidgets: [
        "brief-panel",
        "app-shell",
        "connector-matrix",
        "table",
        "workflow",
        "cost-summary",
        "launch-checklist",
        "deployment-plan",
      ],
      requiredGovernance: [
        "browser-session, credential, payment-method/human-approval, pii, filesystem, external-api, and model-generation capabilities",
        "budget with currency, limit, spent, approvalThreshold before image/video/product generation spend",
        "delegation credentials/payments/fallbackLadder for provider signup/login/key/checkout flows",
        "stateSchema fields for user-owned product and launch approvals using merge: preserve-user",
        "claims/evidence marking provider readiness, launch metrics, revenue, margin, and cost claims",
      ],
      suggestedActions: [
        { id: "connect-commerce-stack", type: "connect-service", label: "Connect commerce stack" },
        { id: "delegate-commerce-browser", type: "delegate-browser", label: "Operate provider browser" },
        { id: "approve-commerce-checkout", type: "request-payment-approval", label: "Approve commerce checkout" },
        { id: "create-commerce-team", type: "scaffold-agent-team", label: "Create commerce agent team" },
        { id: "scaffold-commerce-app", type: "scaffold-app", label: "Scaffold commerce app" },
        { id: "build-catalog-tool", type: "scaffold-tool", label: "Build catalog tool" },
        { id: "run-commerce-smoke", type: "run-smoke-test", label: "Run storefront smoke" },
      ],
    },
  ],
};

const SURFACE_DATA_TYPES = [
  "table",
  "timeline",
  "cards",
  "metrics",
  "markdown",
  "media",
  "routes",
  "connectors",
  "launch-checklist",
  "pricing",
  "artifacts",
  "tools",
  "json",
] as const;

const ALLOWED_LAYOUTS = new Set(SURFACE_DISCOVERY_CATALOG.layouts);
const ALLOWED_WIDGETS = new Set(SURFACE_DISCOVERY_CATALOG.widgets);
const ALLOWED_ACTIONS = new Set(SURFACE_DISCOVERY_CATALOG.actions);
const ALLOWED_DATA_TYPES = new Set<string>(SURFACE_DATA_TYPES);

const LAYOUT_ALIASES: Record<string, string> = {
  "kanban": "workflow",
  "board": "dashboard",
  "app": "service-app",
  "mini-app": "service-app",
  "studio": "creative-studio",
};

const WIDGET_ALIASES: Record<string, string> = {
  "data-table": "table",
  "datatable": "table",
  "grid": "cards",
  "card-list": "cards",
  "asset-grid": "asset-board",
  "asset-gallery": "asset-board",
  "story-board": "storyboard",
  "kanban": "workflow",
  "checklist": "launch-checklist",
  "sources": "source-matrix",
  "source-list": "source-matrix",
  "router": "model-router",
};

const ACTION_ALIASES: Record<string, string> = {
  "follow-up": "agent-followup",
  "followup": "agent-followup",
  "generate-assets": "materialize-asset-pack",
  "generate-asset-pack": "materialize-asset-pack",
  "connect": "connect-service",
  "browser-delegation": "delegate-browser",
  "credential": "request-credential",
  "payment-approval": "request-payment-approval",
  "smoke-test": "run-smoke-test",
  "publish-tool": "publish-as-tool",
};

const DATA_TYPE_ALIASES: Record<string, string> = {
  "checklist": "launch-checklist",
  "launch": "launch-checklist",
  "asset": "media",
  "assets": "media",
  "image": "media",
  "images": "media",
  "video": "media",
  "videos": "media",
  "object": "json",
  "route-list": "routes",
  "connector-list": "connectors",
};

export const SURFACE_PROTOCOL = [
  "## Interactive surfaces",
  "",
  "When the result would be meaningfully better as an interactive mini-app instead of plain text,",
  "emit one safe surface block at the end of your answer:",
  "",
  SURFACE_OPEN_FENCE,
  "{",
  '  "version": "0.1",',
  '  "kind": "surface",',
  '  "title": "Short title",',
  '  "domain": "travel | research | finance | creative | legal | ecommerce | ...",',
  '  "layout": "map-list | report | table | dashboard | timeline | workflow | form | creative-studio | service-app",',
  '  "app": {',
  '    "name": "Launchable app name",',
  '    "tagline": "What it does",',
  '    "appType": "saas | internal-tool | marketplace-agent | automation | creative-tool",',
  '    "audience": "Who would buy or use this",',
  '    "valueProp": "Why this should exist",',
  '    "routes": [ { "path": "/", "label": "Dashboard", "purpose": "..." } ],',
  '    "connectors": [ { "id": "booking", "name": "Booking.com", "type": "mcp", "purpose": "...", "status": "proposed" } ],',
  '    "tools": [ { "id": "price-normalizer", "name": "Price Normalizer", "description": "Normalize hotel/flight prices", "kind": "normalizer", "parameters": [ { "name": "price", "type": "number", "required": true } ] } ],',
  '    "deployment": { "target": "agentlas desktop/web", "readiness": "prototype" },',
  '    "business": { "offer": "...", "pricing": "...", "launchMetric": "..." }',
  '  },',
  '  "data": { "items": { "type": "table", "rows": [] } },',
  '  "widgets": [ { "type": "table", "data": "items" } ],',
  '  "actions": [ { "id": "create-team", "label": "Create agent team", "type": "scaffold-agent-team", "prompt": "..." }, { "id": "scaffold", "label": "Scaffold app", "type": "scaffold-app", "prompt": "..." }, { "id": "operate", "label": "Operate OS", "type": "operate-app", "permission": "full" }, { "id": "connect", "label": "Connect service", "type": "connect-service", "prompt": "Open browser and connect the required account." }, { "id": "build-tool", "label": "Build local tool", "type": "scaffold-tool", "toolId": "price-normalizer" } ],',
  '  "evidence": [ { "id": "src_1", "kind": "verified | claimed | estimated | unverified", "source": "Name", "url": "https://...", "retrievedAt": "ISO time", "confidence": 0.8 } ],',
  '  "claims": [ { "id": "claim_1", "text": "A checkable statement or number shown in the surface", "kind": "verified | claimed | estimated", "evidenceIds": ["src_1"], "status": "unchecked | passed | failed | needs-review" } ],',
  '  "capabilities": [ { "id": "network_search", "type": "network | filesystem | pii | payment | payment-method | credential | browser-session | external-api | model-generation | human-approval", "purpose": "...", "approval": "once", "allowlist": ["https://example.com"] } ],',
  '  "delegation": { "mode": "agent-operated", "autonomy": { "mode": "agent-first", "allowedWithoutPrompt": ["browser-navigation", "provider-account-signup", "provider-app-creation", "api-key-creation", "webhook-setup", "local-file-write", "mcp-adapter-generation", "local-preview-deploy", "alternate-provider-switch"], "checkpoints": ["password-entry", "otp-entry", "captcha-solving", "legal-identity-confirmation", "card-or-cvv-entry", "payment-submit", "budget-threshold-exceeded", "destructive-delete-or-archive"], "noDeadEndReasons": ["missing-api", "missing-mcp", "unsupported-region", "provider-console-complexity", "credential-missing", "paid-service-required"] }, "credentials": [ { "id": "provider_key", "label": "Provider API key", "envKey": "PROVIDER_API_KEY", "inputMode": "agentlas-vault", "status": "missing" } ], "payments": [ { "id": "checkout", "merchant": "Provider", "quoteRequired": true, "recurrence": "one-time", "approvalMode": "explicit-before-checkout", "cardHandling": "provider-checkout" } ], "fallbackLadder": ["installed-mcp-or-api", "browser-delegation", "provider-console-account-or-app", "agentlas-vault-credential", "approved-provider-checkout", "alternate-provider", "generated-local-helper-or-tool"] },',
  '  "budget": { "currency": "USD", "limit": 5, "spent": 0, "approvalThreshold": 1, "unit": "surface" },',
  '  "stateSchema": { "fields": [ { "path": "/data/items/rows", "owner": "user | agent | derived", "merge": "preserve-user" } ] },',
  '  "jobs": [ { "id": "job_1", "label": "Generate variants", "status": "queued", "costEstimate": 0.5, "currency": "USD", "resumable": true } ],',
  '  "provenance": [ { "source": "Name", "url": "https://...", "retrievedAt": "ISO time" } ]',
  "}",
  SURFACE_CLOSE_FENCE,
  "",
  "Rules:",
  "- Use this machine-readable catalog when choosing layout, widgets, actions, trust fields, and the first deep vertical:",
  JSON.stringify(SURFACE_DISCOVERY_CATALOG),
  "- Use this for travel boards, cited reports, finance dashboards, creative storyboards, asset boards, legal issue trees, order tables, checklists, maps, timelines, and similar work surfaces.",
  "- When the user need implies a reusable business/product, emit layout: service-app with app, routes, connectors, launch checklist, deployment plan, pricing, scaffold/deploy actions, and an operate-app action so Agentlas can run the app lifecycle autonomously.",
  "- When the agent needs a missing deterministic helper, declare app.tools and add scaffold-tool/run-tool-smoke actions. Agentlas will generate a safe local MCP/CLI tool scaffold; do not include executable code.",
  "- When the result contains usable media, storyboard, captions, or exports, add materialize-asset-pack so Agentlas can write a portable local asset pack. Remote media downloads require a declared network/external-api allowlist; no model-generated code executes.",
  "- The wow moment is not only a report: propose the MCPs/APIs/services the agent would connect, the app screens it would ship, and the launch proof still missing.",
  "- Never stop at 'missing API/MCP'. If a service connector is missing, declare the needed capability and add connect-service/delegate-browser/request-credential/request-payment-approval actions so Agentlas can use browser delegation, credential vault, provider checkout, or a generated local helper.",
  "- Default to delegation.autonomy.mode='agent-first': the agent should navigate provider consoles, sign up, create apps/API keys/webhooks, scaffold files/tools, and switch providers without asking at every step. Pause only at secure checkpoints: passwords, OTPs, legal identity, terms/compliance attestations, card/CVV entry, payment submit, budget threshold, or destructive delete/archive.",
  "- If the work requires signing up, logging in, creating a provider app/key, or paying a provider, declare delegation.mode='agent-operated' with credentials/payments/fallbackLadder. fallbackLadder must explicitly include browser-delegation, alternate-provider, and generated-local-helper-or-tool; defaults are not enough. delegation.autonomy must explicitly include agent-first permissions, secure checkpoints, and noDeadEndReasons for missing-api, missing-mcp, unsupported-region, provider-console-complexity, credential-missing, and paid-service-required. The user should only type secrets/one-time codes/card details into provider or Agentlas secure UI; never ordinary chat.",
  "- Every important number/fact must be marked as verified, claimed, estimated, or unverified through evidence/claims. If you lack a source, mark it estimated or unverified; never present it as a confident KPI.",
  "- Any surface that can call external services, collect PII, request credentials, use browser login sessions, write files, take payments, or spend money must declare capabilities and a budget. Expensive model-generation jobs need a budget gate and resumable job ids.",
  "- Payment actions must specify merchant, amount/currency, recurrence, and approval mode in capabilities or app connectors. Do not put raw card numbers or passwords in the manifest.",
  "- For user-editable app state, declare stateSchema fields and owners. Use owner:user plus merge:preserve-user for edits that a later agent response must not overwrite.",
  "- Mutating actions such as scaffold-agent-team, scaffold-app, operate-app, install-mcp, scaffold-tool, install-tool-mcp, and deploy-preview are durable OS actions and must be reversible through the registry.",
  "- Declare data, widgets, actions, and provenance only. Do not include HTML, JavaScript, React, CSS, scripts, iframes, or event handlers.",
  "- Do not include secrets, passwords, tokens, cookies, private keys, or hidden credentials in the JSON.",
  "- Keep the chat answer short; the surface carries the structured result.",
].join("\n");

export interface ParsedSurface {
  manifest: AgentlasSurfaceManifest;
}

export interface SurfaceManifestDiagnostic {
  code: string;
  severity: "error" | "repaired";
  path: string;
  message: string;
  repairHint?: string;
}

export function parseSurfaces(text: string): {
  surfaces: ParsedSurface[];
  cleanedText: string;
  errors: string[];
  diagnostics: SurfaceManifestDiagnostic[];
} {
  if (!text.includes(SURFACE_OPEN_FENCE)) return { surfaces: [], cleanedText: text.trim(), errors: [], diagnostics: [] };

  const surfaces: ParsedSurface[] = [];
  const errors: string[] = [];
  const diagnostics: SurfaceManifestDiagnostic[] = [];
  let remaining = text;
  let cleaned = "";

  while (remaining.length > 0) {
    const open = remaining.indexOf(SURFACE_OPEN_FENCE);
    if (open < 0) {
      cleaned += remaining;
      break;
    }

    cleaned += remaining.slice(0, open);
    const afterOpen = remaining.slice(open + SURFACE_OPEN_FENCE.length);
    const close = afterOpen.indexOf(SURFACE_CLOSE_FENCE);
    if (close < 0) {
      // Incomplete block. Hide it from users rather than exposing raw protocol.
      errors.push("Surface block is missing the closing fence.");
      diagnostics.push(
        makeDiagnostic(
          "missing-close-fence",
          "$",
          "Surface block is missing the closing fence.",
          "Emit one complete <<agentlas-surface>> ... <</agentlas-surface>> block.",
        ),
      );
      break;
    }

    const body = afterOpen.slice(0, close).trim();
    if (surfaces.length < MAX_SURFACES_PER_REPLY) {
      try {
        const parsed = parseOneSurface(body);
        diagnostics.push(...(parsed.diagnostics ?? []));
        if (parsed.manifest) surfaces.push({ manifest: parsed.manifest });
        else errors.push(parsed.error ?? "Surface manifest was rejected.");
      } catch {
        // Surface JSON is untrusted model output. Keep the parser total even
        // when validation hits hostile recursion, and never log or retain the
        // rejected body because it may contain Main-private transport values.
        const diagnostic = makeDiagnostic(
          "surface-parse-failed",
          "$",
          "Surface manifest could not be safely validated.",
          "Emit a smaller and shallower manifest using only the trusted Surface catalog.",
        );
        diagnostics.push(diagnostic);
        errors.push(formatDiagnostics([diagnostic]));
      }
    }

    remaining = afterOpen.slice(close + SURFACE_CLOSE_FENCE.length);
  }

  return { surfaces, cleanedText: cleaned.trim(), errors, diagnostics };
}

function parseOneSurface(body: string): {
  manifest: AgentlasSurfaceManifest | null;
  error?: string;
  diagnostics?: SurfaceManifestDiagnostic[];
} {
  if (Buffer.byteLength(body, "utf8") > MAX_SURFACE_BYTES) {
    const diagnostics = [
      makeDiagnostic(
        "surface-too-large",
        "$",
        `Surface block exceeds ${MAX_SURFACE_BYTES} bytes.`,
        "Reduce row counts, media payloads, and verbose notes; store large artifacts as files/assets.",
      ),
    ];
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  const stripped = stripJsonFence(body);
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (err) {
    const diagnostics = [
      makeDiagnostic(
        "invalid-json",
        "$",
        err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON.",
        "Return strict JSON only inside the surface block.",
      ),
    ];
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  return validateSurfaceManifest(raw);
}

function stripJsonFence(body: string): string {
  return body
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function validateSurfaceManifest(raw: unknown): {
  manifest: AgentlasSurfaceManifest | null;
  error?: string;
  diagnostics?: SurfaceManifestDiagnostic[];
} {
  const diagnostics: SurfaceManifestDiagnostic[] = [];
  if (!isJsonObject(raw)) {
    diagnostics.push(makeDiagnostic("not-object", "$", "Surface manifest must be a JSON object."));
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  if (hasForbiddenKey(raw)) {
    diagnostics.push(
      makeDiagnostic(
        "forbidden-secret-key",
        "$",
        "Surface manifest contains a forbidden secret-like key.",
        "Move credentials/cards/tokens into Agentlas vault or provider checkout; store only opaque status/fingerprint metadata.",
      ),
    );
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  if (raw.kind !== "surface") {
    diagnostics.push(makeDiagnostic("invalid-kind", "$.kind", 'Surface manifest kind must be "surface".'));
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }

  const version = stringValue(raw.version) || "0.1";
  const title = stringValue(raw.title);
  const domain = stringValue(raw.domain);
  const layout = canonicalCatalogValue(raw.layout, ALLOWED_LAYOUTS, LAYOUT_ALIASES, "$.layout", "layout", diagnostics);
  if (!title) {
    diagnostics.push(makeDiagnostic("missing-title", "$.title", "Surface manifest requires title."));
  }
  if (!domain) {
    diagnostics.push(makeDiagnostic("missing-domain", "$.domain", "Surface manifest requires domain."));
  }
  if (!layout) {
    diagnostics.push(
      makeDiagnostic(
        "unsupported-layout",
        "$.layout",
        `Surface layout must be one of: ${[...ALLOWED_LAYOUTS].join(", ")}.`,
        "Pick the closest layout from the injected Surface Manifest catalog.",
      ),
    );
  }
  if (!title || !domain || !layout) {
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }

  const data = validateDataSets(raw.data, diagnostics);
  const widgets = validateWidgets(raw.widgets, diagnostics, data);
  if (!data) {
    diagnostics.push(
      makeDiagnostic(
        "missing-data",
        "$.data",
        "Surface manifest requires at least one valid data set.",
        'Declare data like {"items":{"type":"table","rows":[...]}} or {"brief":{"type":"json","value":{...}}}.',
      ),
    );
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  if (!widgets || widgets.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        "missing-widget",
        "$.widgets",
        "Surface manifest requires at least one valid widget.",
        `Use a trusted widget from the catalog: ${[...ALLOWED_WIDGETS].join(", ")}.`,
      ),
    );
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }

  const actions = validateActions(raw.actions, diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  const provenance = validateProvenance(raw.provenance);
  const evidence = validateEvidence(raw.evidence);
  const claims = validateClaims(raw.claims);
  const capabilities = validateCapabilities(raw.capabilities);
  const budget = validateBudget(raw.budget);
  const stateSchema = validateStateSchema(raw.stateSchema);
  const jobs = validateJobs(raw.jobs);

  const manifest: AgentlasSurfaceManifest = {
      ...raw,
      version,
      kind: "surface",
      title,
      domain,
      layout,
      data,
      widgets,
      ...(actions ? { actions } : {}),
      ...(provenance ? { provenance } : {}),
      ...(evidence ? { evidence } : {}),
      ...(claims ? { claims } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(budget ? { budget } : {}),
      ...(stateSchema ? { stateSchema } : {}),
      ...(jobs ? { jobs } : {}),
  };
  const trustErrors = lintSurfaceTrust(manifest);
  if (trustErrors.length > 0) {
    for (const error of trustErrors) {
      diagnostics.push(makeDiagnostic("trust-rule", "$", error, "Repair the manifest contract; do not remove the user-facing fact or action unless it is unsupported."));
    }
    return { manifest: null, error: formatDiagnostics(diagnostics), diagnostics };
  }
  return { manifest, diagnostics };
}

function validateDataSets(raw: unknown, diagnostics: SurfaceManifestDiagnostic[]): Record<string, AgentlasSurfaceDataSet> | null {
  if (!isJsonObject(raw)) return null;
  const out: Record<string, AgentlasSurfaceDataSet> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) {
      diagnostics.push(makeDiagnostic("invalid-data-key", `$.data.${key}`, `Data set key "${key}" is not portable.`));
      continue;
    }
    const normalized = normalizeDataSet(key, value, diagnostics);
    if (!normalized) continue;
    const type = canonicalCatalogValue(normalized.type, ALLOWED_DATA_TYPES, DATA_TYPE_ALIASES, `$.data.${key}.type`, "data type", diagnostics);
    if (!type) {
      diagnostics.push(
        makeDiagnostic(
          "unsupported-data-type",
          `$.data.${key}.type`,
          `Data set "${key}" uses unsupported type "${String(normalized.type)}".`,
          `Use one of: ${[...ALLOWED_DATA_TYPES].join(", ")}.`,
        ),
      );
      continue;
    }
    const dataSet: AgentlasSurfaceDataSet = { ...normalized, type };
    if (normalized.columns !== undefined && !isStringArray(normalized.columns)) delete dataSet.columns;
    if (type === "table" && isStringArray(normalized.columns) && Array.isArray(normalized.rows)) {
      const columns = normalized.columns;
      const repairedRows = normalized.rows.flatMap((row) => {
        if (!Array.isArray(row)) return isJsonObject(row) ? [row] : [];
        const item: JsonObject = { trust: "unverified" };
        columns.forEach((column, index) => {
          const cell = row[index];
          if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || Array.isArray(cell) || isJsonObject(cell)) {
            item[column] = cell;
          }
        });
        return [item];
      });
      if (repairedRows.length > 0) {
        dataSet.rows = repairedRows;
        if (normalized.rows.some((row) => Array.isArray(row))) {
          diagnostics.push(makeDiagnostic(
            "table-array-rows-repaired",
            `$.data.${key}.rows`,
            `Table data set "${key}" was repaired from positional rows using its declared columns.`,
            undefined,
            "repaired",
          ));
        }
      } else {
        delete dataSet.rows;
      }
    } else if (normalized.rows !== undefined && !isJsonObjectArray(normalized.rows)) {
      delete dataSet.rows;
    }
    if (normalized.items !== undefined && !isJsonObjectArray(normalized.items)) delete dataSet.items;
    if (normalized.summary !== undefined && typeof normalized.summary !== "string") delete dataSet.summary;
    out[key] = dataSet;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function validateWidgets(
  raw: unknown,
  diagnostics: SurfaceManifestDiagnostic[],
  data: Record<string, AgentlasSurfaceDataSet> | null,
): AgentlasSurfaceWidget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AgentlasSurfaceWidget[] = [];
  const dataKeys = data ? Object.keys(data) : [];
  for (const [index, item] of raw.slice(0, 40).entries()) {
    if (!isJsonObject(item)) continue;
    const type = canonicalCatalogValue(item.type, ALLOWED_WIDGETS, WIDGET_ALIASES, `$.widgets[${index}].type`, "widget", diagnostics);
    if (!type) continue;
    let dataRef = stringValue(item.data);
    if (!dataRef && dataKeys.length === 1) {
      dataRef = dataKeys[0];
      diagnostics.push(
        makeDiagnostic(
          "widget-data-repaired",
          `$.widgets[${index}].data`,
          `Widget "${type}" was repaired to point at the only declared data set "${dataRef}".`,
          undefined,
          "repaired",
        ),
      );
    }
    out.push({ ...item, type, data: dataRef, title: stringValue(item.title) });
  }
  return out.length > 0 ? out : null;
}

function validateActions(raw: unknown, diagnostics: SurfaceManifestDiagnostic[]): AgentlasSurfaceAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceAction[] = [];
  for (const [index, item] of raw.slice(0, 30).entries()) {
    if (!isJsonObject(item)) continue;
    const id = stringValue(item.id);
    const label = stringValue(item.label);
    const type = canonicalCatalogValue(item.type, ALLOWED_ACTIONS, ACTION_ALIASES, `$.actions[${index}].type`, "action", diagnostics);
    if (!id || !label || !type) continue;
    out.push({ ...item, id, label, type });
  }
  return out.length > 0 ? out : undefined;
}

function validateProvenance(raw: unknown): AgentlasSurfaceProvenance[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceProvenance[] = [];
  for (const item of raw.slice(0, 80)) {
    if (!isJsonObject(item)) continue;
    const source = stringValue(item.source);
    if (!source) continue;
    out.push({ ...item, source });
  }
  return out.length > 0 ? out : undefined;
}

function validateEvidence(raw: unknown): AgentlasSurfaceEvidence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceEvidence[] = [];
  for (const item of raw.slice(0, 120)) {
    if (!isJsonObject(item)) continue;
    const id = stringValue(item.id);
    const kind = stringValue(item.kind) || "unverified";
    if (!id) continue;
    out.push({
      ...item,
      id,
      kind,
      label: stringValue(item.label),
      source: stringValue(item.source),
      url: stringValue(item.url),
      retrievedAt: stringValue(item.retrievedAt),
      confidence: numberValue(item.confidence),
      note: stringValue(item.note),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateClaims(raw: unknown): AgentlasSurfaceClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceClaim[] = [];
  for (const item of raw.slice(0, 160)) {
    if (!isJsonObject(item)) continue;
    const id = stringValue(item.id);
    const text = stringValue(item.text);
    if (!id || !text) continue;
    out.push({
      ...item,
      id,
      text,
      kind: stringValue(item.kind),
      evidenceIds: isStringArray(item.evidenceIds) ? item.evidenceIds : undefined,
      status: stringValue(item.status),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateCapabilities(raw: unknown): AgentlasSurfaceCapability[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceCapability[] = [];
  for (const item of raw.slice(0, 80)) {
    if (!isJsonObject(item)) continue;
    const id = stringValue(item.id);
    const type = stringValue(item.type);
    const purpose = stringValue(item.purpose);
    if (!id || !type || !purpose) continue;
    out.push({
      ...item,
      id,
      type,
      purpose,
      scope: stringValue(item.scope),
      approval: stringValue(item.approval),
      allowlist: isStringArray(item.allowlist) ? item.allowlist : undefined,
      dataClasses: isStringArray(item.dataClasses) ? item.dataClasses : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateBudget(raw: unknown): AgentlasSurfaceBudget | undefined {
  if (!isJsonObject(raw)) return undefined;
  const budget: AgentlasSurfaceBudget = {
    ...raw,
    currency: stringValue(raw.currency),
    limit: numberValue(raw.limit),
    spent: numberValue(raw.spent),
    approvalThreshold: numberValue(raw.approvalThreshold),
    unit: stringValue(raw.unit),
  };
  return budget.limit !== undefined || budget.spent !== undefined || budget.approvalThreshold !== undefined
    ? budget
    : undefined;
}

function validateStateSchema(raw: unknown): { fields?: AgentlasSurfaceStateField[]; [key: string]: unknown } | undefined {
  if (!isJsonObject(raw)) return undefined;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.slice(0, 120).flatMap((item): AgentlasSurfaceStateField[] => {
        if (!isJsonObject(item)) return [];
        const path = stringValue(item.path);
        const owner = stringValue(item.owner);
        if (!path || !owner) return [];
        return [{ ...item, path, owner, description: stringValue(item.description), merge: stringValue(item.merge) }];
      })
    : undefined;
  return fields?.length ? { ...raw, fields } : undefined;
}

function validateJobs(raw: unknown): AgentlasSurfaceJob[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentlasSurfaceJob[] = [];
  for (const item of raw.slice(0, 80)) {
    if (!isJsonObject(item)) continue;
    const id = stringValue(item.id);
    const label = stringValue(item.label);
    const status = stringValue(item.status);
    if (!id || !label || !status) continue;
    out.push({
      ...item,
      id,
      label,
      status,
      costEstimate: numberValue(item.costEstimate),
      costSpent: numberValue(item.costSpent),
      currency: stringValue(item.currency),
      resumable: typeof item.resumable === "boolean" ? item.resumable : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeDataSet(
  key: string,
  value: unknown,
  diagnostics: SurfaceManifestDiagnostic[],
): (JsonObject & { type?: JsonValue }) | null {
  if (Array.isArray(value)) {
    const rows = value.filter(isJsonObject);
    if (rows.length === 0) return null;
    const artifactLike = /(?:artifact|file|output|deliverable)/i.test(key)
      && rows.some((row) => ["path", "filePath", "localPath", "file", "name"].some((field) => typeof row[field] === "string"));
    diagnostics.push(
      makeDiagnostic(
        "dataset-array-repaired",
        `$.data.${key}`,
        `Data set "${key}" was repaired from a bare array to an ${artifactLike ? "artifact" : "table"} dataset.`,
        undefined,
        "repaired",
      ),
    );
    if (artifactLike) {
      return {
        type: "artifacts",
        items: rows.map((row) => ({ ...row, ...(typeof row.trust === "string" ? {} : { trust: "unverified" }) })),
      };
    }
    return { type: "table", rows };
  }
  if (!isJsonObject(value)) return null;
  const type = stringValue(value.type);
  if (type) return value;
  if (isJsonObjectArray(value.rows)) {
    diagnostics.push(
      makeDiagnostic(
        "dataset-type-repaired",
        `$.data.${key}.type`,
        `Data set "${key}" was repaired with type "table" because it contains rows.`,
        undefined,
        "repaired",
      ),
    );
    return { ...value, type: "table" };
  }
  if (isJsonObjectArray(value.items)) {
    diagnostics.push(
      makeDiagnostic(
        "dataset-type-repaired",
        `$.data.${key}.type`,
        `Data set "${key}" was repaired with type "cards" because it contains items.`,
        undefined,
        "repaired",
      ),
    );
    return { ...value, type: "cards" };
  }
  if (value.value !== undefined) {
    diagnostics.push(
      makeDiagnostic(
        "dataset-type-repaired",
        `$.data.${key}.type`,
        `Data set "${key}" was repaired with type "json" because it contains a value field.`,
        undefined,
        "repaired",
      ),
    );
    return { ...value, type: "json" };
  }
  return null;
}

function canonicalCatalogValue(
  raw: unknown,
  allowed: Set<string>,
  aliases: Record<string, string>,
  path: string,
  label: string,
  diagnostics: SurfaceManifestDiagnostic[],
): string | undefined {
  const value = stringValue(raw);
  if (!value) return undefined;
  if (allowed.has(value)) return value;
  const key = normalizeCatalogKey(value);
  const exact = [...allowed].find((item) => normalizeCatalogKey(item) === key);
  if (exact) {
    if (exact !== value) {
      const codeLabel = label.replace(/\s+/g, "-");
      diagnostics.push(
        makeDiagnostic(
          `${codeLabel}-case-repaired`,
          path,
          `Surface ${label} "${value}" was normalized to "${exact}".`,
          undefined,
          "repaired",
        ),
      );
    }
    return exact;
  }
  const alias = aliases[key] ?? aliases[value] ?? aliases[value.toLowerCase()];
  if (alias && allowed.has(alias)) {
    const codeLabel = label.replace(/\s+/g, "-");
    diagnostics.push(
      makeDiagnostic(
        `${codeLabel}-alias-repaired`,
        path,
        `Surface ${label} "${value}" was repaired to trusted catalog entry "${alias}".`,
        undefined,
        "repaired",
      ),
    );
    return alias;
  }
  diagnostics.push(
    makeDiagnostic(
      `unsupported-${label.replace(/\s+/g, "-")}`,
      path,
      `Surface ${label} "${value}" is not in the trusted catalog.`,
      `Use one of: ${[...allowed].join(", ")}.`,
    ),
  );
  return undefined;
}

function normalizeCatalogKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function makeDiagnostic(
  code: string,
  path: string,
  message: string,
  repairHint?: string,
  severity: SurfaceManifestDiagnostic["severity"] = "error",
): SurfaceManifestDiagnostic {
  return repairHint ? { code, severity, path, message, repairHint } : { code, severity, path, message };
}

function formatDiagnostics(diagnostics: SurfaceManifestDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const items = errors.length > 0 ? errors : diagnostics;
  return items
    .map((diagnostic) => {
      const hint = diagnostic.repairHint ? ` Repair hint: ${diagnostic.repairHint}` : "";
      return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}${hint}`;
    })
    .join("\n");
}

function hasForbiddenKey(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v));
  if (!isJsonObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) return true;
    if (hasForbiddenKey(nested)) return true;
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonObjectArray(value: unknown): value is JsonObject[] {
  return Array.isArray(value) && value.every(isJsonObject);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
