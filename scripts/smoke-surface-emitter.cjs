#!/usr/bin/env node
const assert = require("node:assert/strict");
const { parseSurfaces } = require("../dist/electron/surface-emitter.js");

const valid = [
  "Short answer.",
  "<<agentlas-surface>>",
  JSON.stringify({
    version: "0.1",
    kind: "surface",
    title: "Launch Creative Studio",
    domain: "creative",
    layout: "creative-studio",
    data: {
      shots: {
        type: "table",
        rows: [{ scene: "Hook", prompt: "Close-up product reveal" }],
      },
    },
    widgets: [
      { type: "brief-panel", data: "shots" },
      { type: "storyboard", data: "shots" },
      { type: "asset-board", data: "shots" },
    ],
    actions: [
      { id: "generate", label: "Generate variants", type: "generate", permission: "write" },
    ],
    evidence: [{ id: "plan", kind: "estimated", source: "Smoke test plan" }],
    capabilities: [
      { id: "image_generation", type: "model-generation", purpose: "Generate smoke variants", approval: "once" },
    ],
    budget: { currency: "USD", limit: 1, spent: 0, approvalThreshold: 0.25 },
    jobs: [
      {
        id: "job_generate_variants",
        label: "Generate variants",
        status: "queued",
        costEstimate: 0.1,
        currency: "USD",
        resumable: true,
      },
    ],
  }),
  "<</agentlas-surface>>",
].join("\n");

const parsed = parseSurfaces(valid);
assert.equal(parsed.cleanedText, "Short answer.");
assert.equal(parsed.surfaces.length, 1);
assert.equal(parsed.surfaces[0].manifest.layout, "creative-studio");
assert.equal(parsed.surfaces[0].manifest.widgets.length, 3);

const serviceApp = [
  "Built the app blueprint.",
  "<<agentlas-surface>>",
  JSON.stringify({
    version: "0.1",
    kind: "surface",
    title: "Trip Revenue Desk",
    domain: "travel",
    layout: "service-app",
    app: {
      name: "Trip Revenue Desk",
      appType: "saas",
      routes: [{ path: "/", label: "Deals" }],
      connectors: [{ id: "booking", name: "Booking.com MCP", type: "mcp", status: "verified" }],
      tools: [
        {
          id: "price-normalizer",
          name: "Price Normalizer",
          description: "Normalize package prices before quote comparison.",
          kind: "normalizer",
          parameters: [{ name: "price", type: "number", required: true }],
        },
      ],
      deployment: { target: "agentlas desktop", readiness: "prototype" },
      business: { pricing: "$49/mo", launchMetric: "3 paid quotes" },
    },
    data: {
      launch: { type: "launch-checklist", rows: [{ item: "Working preview", status: "ready" }] },
    },
    widgets: [
      { type: "app-shell", data: "routes" },
      { type: "mcp-builder", data: "connectors" },
      { type: "launch-checklist", data: "launch" },
    ],
    actions: [
      { id: "scaffold", label: "Scaffold this app", type: "scaffold-app", permission: "write" },
      { id: "build-tool", label: "Build price tool", type: "scaffold-tool", toolId: "price-normalizer" },
      { id: "deploy", label: "Deploy preview", type: "deploy-preview", permission: "full" },
    ],
    capabilities: [
      { id: "app_filesystem", type: "filesystem", purpose: "Write and archive generated launch app files", approval: "once" },
    ],
  }),
  "<</agentlas-surface>>",
].join("\n");

const parsedServiceApp = parseSurfaces(serviceApp);
assert.equal(parsedServiceApp.cleanedText, "Built the app blueprint.");
assert.equal(parsedServiceApp.surfaces.length, 1);
assert.equal(parsedServiceApp.surfaces[0].manifest.layout, "service-app");
assert.equal(parsedServiceApp.surfaces[0].manifest.app.name, "Trip Revenue Desk");
assert.equal(parsedServiceApp.surfaces[0].manifest.app.tools.length, 1);
assert.equal(parsedServiceApp.surfaces[0].manifest.actions.length, 3);

const delegatedService = [
  "Connected app.",
  "<<agentlas-surface>>",
  JSON.stringify({
    version: "0.1",
    kind: "surface",
    title: "Provider Setup Desk",
    domain: "creative",
    layout: "service-app",
    app: {
      name: "Provider Setup Desk",
      routes: [{ path: "/", label: "Setup" }],
      connectors: [
        { id: "higgsfield", name: "Higgsfield", type: "api", auth: "api-key", status: "missing-credential" },
      ],
    },
    data: {
      setup: { type: "launch-checklist", rows: [{ item: "Provider credential", status: "missing" }] },
    },
    widgets: [{ type: "launch-checklist", data: "setup" }],
    actions: [
      { id: "connect", label: "Connect service", type: "connect-service", permission: "full" },
      {
        id: "credential",
        label: "Save key",
        type: "request-credential",
        permission: "full",
        envKey: "HIGGSFIELD_API_KEY",
      },
      {
        id: "payment",
        label: "Approve checkout",
        type: "request-payment-approval",
        permission: "full",
        payment: {
          merchant: "Higgsfield",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
        },
      },
    ],
    capabilities: [
      { id: "browser", type: "browser-session", purpose: "Operate provider console", approval: "per-run" },
      { id: "credential", type: "credential", purpose: "Store provider key in Agentlas vault", approval: "per-action" },
      { id: "payment", type: "human-approval", purpose: "Approve checkout before spend", approval: "per-action" },
    ],
    delegation: {
      mode: "agent-operated",
      autonomy: {
        mode: "agent-first",
        allowedWithoutPrompt: [
          "browser-navigation",
          "provider-account-signup",
          "provider-app-creation",
          "api-key-creation",
          "webhook-setup",
          "alternate-provider-switch",
        ],
        checkpoints: [
          "password-entry",
          "otp-entry",
          "legal-identity-confirmation",
          "card-or-cvv-entry",
          "payment-submit",
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
      credentials: [{ id: "higgsfield-key", label: "Higgsfield API key", envKey: "HIGGSFIELD_API_KEY" }],
      payments: [
        {
          id: "higgsfield-checkout",
          merchant: "Higgsfield",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
        },
      ],
      fallbackLadder: [
        "installed-mcp-or-api",
        "browser-delegation",
        "provider-console-account-or-app",
        "agentlas-vault-credential",
        "approved-provider-checkout",
        "alternate-provider",
        "generated-local-helper-or-tool",
      ],
    },
  }),
  "<</agentlas-surface>>",
].join("\n");
const parsedDelegatedService = parseSurfaces(delegatedService);
assert.equal(parsedDelegatedService.surfaces.length, 1);
assert.equal(parsedDelegatedService.surfaces[0].manifest.title, "Provider Setup Desk");

const missingDelegation = parseSurfaces(
  [
    "Missing setup.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Missing Provider",
      domain: "creative",
      layout: "service-app",
      app: {
        name: "Missing Provider",
        connectors: [{ id: "video", name: "Video Provider", type: "api", auth: "api-key", status: "missing-credential" }],
      },
      data: { setup: { type: "launch-checklist", rows: [{ item: "Provider", status: "missing" }] } },
      widgets: [{ type: "launch-checklist", data: "setup" }],
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(missingDelegation.surfaces.length, 0);
assert.match(missingDelegation.errors.join("\n"), /missing-service-requires-delegation-path/);

const implicitFallbackOnly = parseSurfaces(
  [
    "Implicit fallback.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Implicit Provider Fallback",
      domain: "creative",
      layout: "service-app",
      app: {
        name: "Implicit Provider Fallback",
        connectors: [{ id: "video", name: "Video Provider", type: "api", auth: "api-key", status: "missing-credential" }],
      },
      data: { setup: { type: "launch-checklist", rows: [{ item: "Provider", status: "missing" }] } },
      widgets: [{ type: "launch-checklist", data: "setup" }],
      actions: [
        { id: "connect", label: "Connect provider", type: "connect-service", permission: "full" },
        { id: "credential", label: "Save key", type: "request-credential", permission: "full", envKey: "VIDEO_PROVIDER_API_KEY" },
      ],
      capabilities: [
        { id: "browser", type: "browser-session", purpose: "Operate provider setup", approval: "once" },
        { id: "credential", type: "credential", purpose: "Store provider key in Agentlas vault", approval: "per-action" },
      ],
      delegation: {
        mode: "agent-operated",
        autonomy: {
          mode: "agent-first",
          allowedWithoutPrompt: [
            "browser-navigation",
            "provider-account-signup",
            "provider-app-creation",
            "api-key-creation",
            "webhook-setup",
            "alternate-provider-switch",
          ],
          checkpoints: [
            "password-entry",
            "otp-entry",
            "legal-identity-confirmation",
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
      },
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(implicitFallbackOnly.surfaces.length, 0);
assert.match(implicitFallbackOnly.errors.join("\n"), /explicit delegation\.fallbackLadder/);

const secret = valid.replace('"shots"', '"apiKey"');
const rejected = parseSurfaces(secret);
assert.equal(rejected.surfaces.length, 0);
assert.equal(rejected.cleanedText, "Short answer.");
assert.ok(rejected.errors.length > 0);

const cardSecret = valid.replace('"shots"', '"cardNumber"');
const rejectedCard = parseSurfaces(cardSecret);
assert.equal(rejectedCard.surfaces.length, 0);
assert.ok(rejectedCard.errors.length > 0);

const invalid = parseSurfaces(
  [
    "Needs repair.",
    "<<agentlas-surface>>",
    JSON.stringify({ kind: "surface", title: "Broken", domain: "qa", layout: "table", data: {} }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(invalid.surfaces.length, 0);
assert.match(invalid.errors.join("\n"), /valid data set|valid widget/);

const catalogRepaired = parseSurfaces(
  [
    "Catalog aliases.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Repairable Commerce App",
      domain: "ecommerce",
      layout: "mini_app",
      data: {
        items: [{ name: "Hero product", trust: "estimated" }],
      },
      widgets: [{ type: "data_table" }],
      actions: [{ id: "connect", label: "Connect provider", type: "connect" }],
      capabilities: [{ id: "browser", type: "browser-session", purpose: "Operate provider setup", approval: "once" }],
      delegation: {
        mode: "agent-operated",
        autonomy: {
          mode: "agent-first",
          allowedWithoutPrompt: [
            "browser-navigation",
            "provider-account-signup",
            "provider-app-creation",
            "api-key-creation",
            "webhook-setup",
            "alternate-provider-switch",
          ],
          checkpoints: [
            "password-entry",
            "otp-entry",
            "legal-identity-confirmation",
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
        fallbackLadder: [
          "installed-mcp-or-api",
          "browser-delegation",
          "alternate-provider",
          "generated-local-helper-or-tool",
        ],
      },
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(catalogRepaired.surfaces.length, 1);
assert.equal(catalogRepaired.surfaces[0].manifest.layout, "service-app");
assert.equal(catalogRepaired.surfaces[0].manifest.data.items.type, "table");
assert.equal(catalogRepaired.surfaces[0].manifest.widgets[0].type, "table");
assert.equal(catalogRepaired.surfaces[0].manifest.widgets[0].data, "items");
assert.equal(catalogRepaired.surfaces[0].manifest.actions[0].type, "connect-service");
assert.ok(catalogRepaired.diagnostics.some((diagnostic) => diagnostic.severity === "repaired"));

const unsupportedWidget = parseSurfaces(
  [
    "Unsupported widget.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Unsupported Widget",
      domain: "qa",
      layout: "dashboard",
      data: {
        items: { type: "table", rows: [{ name: "Row", trust: "estimated" }] },
      },
      widgets: [{ type: "magic-canvas", data: "items" }],
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(unsupportedWidget.surfaces.length, 0);
assert.match(unsupportedWidget.errors.join("\n"), /unsupported-widget/);
assert.ok(unsupportedWidget.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-widget"));

const untrustedNumber = parseSurfaces(
  [
    "Looks good.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Revenue Dashboard",
      domain: "finance",
      layout: "dashboard",
      data: {
        metrics: { type: "table", rows: [{ label: "MRR", value: "$49,000" }] },
      },
      widgets: [{ type: "table", data: "metrics" }],
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(untrustedNumber.surfaces.length, 0);
assert.match(untrustedNumber.errors.join("\n"), /important-values-require-evidence/);

const remoteWithoutAllowlist = parseSurfaces(
  [
    "Asset board.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Remote Asset Board",
      domain: "creative",
      layout: "creative-studio",
      data: {
        assets: { type: "media", rows: [{ title: "Hero", url: "https://cdn.example.com/hero.png", evidenceIds: ["e1"] }] },
      },
      widgets: [{ type: "asset-board", data: "assets" }],
      evidence: [{ id: "e1", kind: "claimed", source: "Example CDN" }],
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(remoteWithoutAllowlist.surfaces.length, 0);
assert.match(remoteWithoutAllowlist.errors.join("\n"), /remote-media-requires-allowlist/);

const executablePayload = parseSurfaces(
  [
    "Unsafe.",
    "<<agentlas-surface>>",
    JSON.stringify({
      version: "0.1",
      kind: "surface",
      title: "Unsafe Surface",
      domain: "qa",
      layout: "report",
      data: { report: { type: "markdown", value: "<script>alert(1)</script>" } },
      widgets: [{ type: "report", data: "report" }],
    }),
    "<</agentlas-surface>>",
  ].join("\n"),
);
assert.equal(executablePayload.surfaces.length, 0);
assert.match(executablePayload.errors.join("\n"), /no-executable-payloads/);

console.log("surface-emitter smoke passed");
