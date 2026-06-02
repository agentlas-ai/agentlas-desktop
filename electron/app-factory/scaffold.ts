import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDesignCss } from "../surface-design";
import type {
  AgentlasSurfaceAppRoute,
  AgentlasSurfaceConnectorSpec,
  AgentlasSurfaceManifest,
  AgentlasSurfaceToolSpec,
  AppFactoryGeneratedFile,
  AppFactoryScaffoldRequest,
  AppFactoryScaffoldResult,
  JsonObject,
} from "../../shared/types";

interface ScaffoldOptions {
  baseDir: string;
  now?: string;
}

interface ScaffoldFile {
  path: string;
  kind: AppFactoryGeneratedFile["kind"];
  content: string;
}

const FORBIDDEN_FILE_CHARS = /[^a-z0-9._-]+/g;

export async function scaffoldServiceApp(
  request: AppFactoryScaffoldRequest,
  options: ScaffoldOptions,
): Promise<AppFactoryScaffoldResult> {
  const manifest = request.manifest;
  if (manifest.kind !== "surface" || (manifest.layout !== "service-app" && !manifest.app)) {
    throw new Error("App Factory can only scaffold app-backed surfaces.");
  }
  if (!path.isAbsolute(options.baseDir)) {
    throw new Error("App Factory baseDir must be an absolute path.");
  }

  const now = options.now ?? new Date().toISOString();
  const appName = manifest.app?.name?.trim() || manifest.title.trim() || "Agentlas App";
  const slug = slugify(appName);
  const appId = `${slug}-${shortId(request.surfaceId || `${appName}:${now}`)}`;
  const rootPath = path.join(options.baseDir, "agentlas-apps", appId);
  const files = buildServiceAppFiles(manifest, { appId, appName, now });

  await fs.mkdir(rootPath, { recursive: true });
  const written: AppFactoryGeneratedFile[] = [];
  for (const file of files) {
    const absPath = path.join(rootPath, file.path);
    assertInside(rootPath, absPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, file.content, "utf8");
    written.push({
      path: file.path,
      kind: file.kind,
      bytes: Buffer.byteLength(file.content, "utf8"),
    });
  }
  ensureGitRepository(rootPath);

  return {
    appId,
    appName,
    rootPath,
    previewPath: path.join(rootPath, "src", "index.html"),
    setupPath: path.join(rootPath, "SETUP.md"),
    smokePath: path.join(rootPath, "tests", "smoke.mjs"),
    createdAt: now,
    files: written,
    summary: `${appName} scaffolded with ${written.length} files, ${connectorsOf(manifest).length} connectors, and ${routesOf(manifest).length} routes.`,
  };
}

export function buildServiceAppFiles(
  manifest: AgentlasSurfaceManifest,
  ctx: { appId: string; appName: string; now: string },
): ScaffoldFile[] {
  const routes = routesOf(manifest);
  const connectors = connectorsOf(manifest);
  const tools = toolsOf(manifest);
  const launch = rowsOf(manifest, "launch", "launch-checklist");
  const artifacts = rowsOf(manifest, "artifacts", "artifacts");
  const business = manifest.app?.business ?? objectData(manifest, "business");
  const deployment = manifest.app?.deployment ?? {};
  const operations = buildOperationsState(manifest, { appId: ctx.appId, appName: ctx.appName, now: ctx.now });
  const routeFiles = buildRouteFiles(manifest, routes, operations, ctx);
  const appData = {
    id: ctx.appId,
    generatedAt: ctx.now,
    manifest,
    routes,
    connectors,
    tools,
    launch,
    artifacts,
    operations,
  };

  return [
    { path: "README.md", kind: "doc", content: readme(manifest, routes, connectors, ctx) },
    { path: ".gitignore", kind: "config", content: gitignore() },
    { path: "SETUP.md", kind: "doc", content: setupGuide(manifest, connectors, ctx) },
    { path: "LAUNCH.md", kind: "doc", content: launchGuide(manifest, business, launch, ctx) },
    { path: "agentlas.app.json", kind: "config", content: prettyJson(appData) },
    { path: "data/operations.json", kind: "data", content: prettyJson(operations) },
    { path: "mcp/required-connectors.json", kind: "config", content: prettyJson({ connectors }) },
    { path: "tools/required-tools.json", kind: "config", content: prettyJson({ tools }) },
    { path: "src/data/app.json", kind: "data", content: prettyJson(appData) },
    { path: "src/data/operations.json", kind: "data", content: prettyJson(operations) },
    { path: "src/runtime/commerce-store.mjs", kind: "source", content: commerceStoreScript() },
    { path: "src/runtime/provider-tasks.json", kind: "data", content: prettyJson({ tasks: operations.providerTasks }) },
    { path: "src/index.html", kind: "source", content: htmlPreview(manifest, routes, connectors, launch, operations, ctx) },
    ...routeFiles,
    { path: "scripts/serve.mjs", kind: "source", content: serveScript() },
    { path: "tests/smoke.mjs", kind: "test", content: smokeTestScript(ctx.appName) },
    {
      path: "artifacts/scaffold-report.md",
      kind: "doc",
      content: scaffoldReport(manifest, routes, connectors, artifacts, deployment, ctx),
    },
  ];
}

function ensureGitRepository(rootPath: string): void {
  try {
    void spawnSync("git", ["init"], {
      cwd: rootPath,
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // Git is a convenience for generated-app portability, not a scaffold blocker.
  }
}

function gitignore(): string {
  return `node_modules/
dist/
.DS_Store
*.log
.env
ops/provider-browser-workspace/
ops/provider-browser-screenshots/
`;
}

export async function refreshServiceAppViews(rootPath: string, now = new Date().toISOString()): Promise<{
  files: string[];
  refreshedAt: string;
}> {
  const appJsonPath = path.join(rootPath, "agentlas.app.json");
  const operationsPath = path.join(rootPath, "data", "operations.json");
  assertInside(rootPath, appJsonPath);
  assertInside(rootPath, operationsPath);
  const rawApp = JSON.parse(await fs.readFile(appJsonPath, "utf8")) as unknown;
  if (!isObject(rawApp)) throw new Error("Invalid agentlas.app.json.");
  const manifest = isObject(rawApp.manifest)
    ? (rawApp.manifest as unknown as AgentlasSurfaceManifest)
    : ({
        version: "0.1",
        kind: "surface",
        title: "Agentlas App",
        domain: "app",
        layout: "service-app",
        data: {},
        widgets: [],
      } satisfies AgentlasSurfaceManifest);
  const operations = JSON.parse(await fs.readFile(operationsPath, "utf8")) as JsonObject;
  const routes = routesOf(manifest);
  const connectors = connectorsOf(manifest);
  const launch = rowsOf(manifest, "launch", "launch-checklist");
  const appName = manifest.app?.name?.trim() || manifest.title.trim() || "Agentlas App";
  const files: ScaffoldFile[] = [
    { path: "src/index.html", kind: "source", content: htmlPreview(manifest, routes, connectors, launch, operations, { appName }) },
    ...buildRouteFiles(manifest, routes, operations, { appName, now }),
  ];
  const written: string[] = [];
  for (const file of files) {
    const absPath = path.join(rootPath, file.path);
    assertInside(rootPath, absPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, file.content, "utf8");
    written.push(file.path);
  }
  return { files: written, refreshedAt: now };
}

function buildRouteFiles(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  operations: JsonObject,
  ctx: { appName: string; now: string },
): ScaffoldFile[] {
  const files: ScaffoldFile[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const routePath = routeSourcePath(route.path);
    if (!routePath || seen.has(routePath)) continue;
    seen.add(routePath);
    files.push({
      path: routePath,
      kind: "source",
      content: routePageHtml(manifest, route, routes, operations, ctx),
    });
  }
  return files;
}

function buildOperationsState(
  manifest: AgentlasSurfaceManifest,
  ctx: { appId: string; appName: string; now: string },
): JsonObject {
  const connectors = connectorsOf(manifest);
  const actions = manifest.actions ?? [];
  const products = rowsOf(manifest, "products", "products");
  const orders = rowsOf(manifest, "orders", "orders");
  const metrics = rowsOf(manifest, "metrics", "metrics");
  const assets = rowsOf(manifest, "assets", "media");
  const launch = rowsOf(manifest, "launch", "launch-checklist");
  const providerTasks = actions
    .filter((action) =>
      [
        "connect-service",
        "delegate-browser",
        "request-credential",
        "request-payment-approval",
        "generate",
        "install-mcp",
        "deploy-preview",
        "publish-as-tool",
      ].includes(action.type),
    )
    .map((action) => ({
      id: action.id,
      label: action.label,
      type: action.type,
      status: "waiting-for-agentlas-approval",
      permission: action.permission ?? "write",
      prompt: action.prompt ?? null,
    }));
  const paymentConnectors = connectors.filter((connector) => connector.type === "payment");
  const databaseConnectors = connectors.filter((connector) => connector.type === "database");
  const imageConnectors = connectors.filter((connector) => connector.type === "model" || /image|video|generation/i.test(connector.id + connector.name));
  const capabilityManifest = buildCapabilityManifest(manifest, connectors, actions, ctx.now);

  return {
    schemaVersion: "0.1",
    appId: ctx.appId,
    appName: ctx.appName,
    generatedAt: ctx.now,
    domain: manifest.domain,
    lifecycle: {
      status: "scaffolded",
      stage: "draft-to-scaffolded",
      reversible: true,
      archivePath: null,
      restoredAt: null,
      updatedAt: ctx.now,
      summary: "Generated app is a reversible Agentlas OS object.",
    },
    trust: jsonValue({
      evidence: manifest.evidence ?? [],
      claims: manifest.claims ?? [],
      capabilities: capabilityManifest.capabilities,
      budget: manifest.budget ?? null,
      jobs: manifest.jobs ?? [],
    }),
    capabilityManifest,
    providerTasks,
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      type: connector.type,
      status: connector.status ?? "proposed",
      auth: connector.auth ?? "user-approval",
      purpose: connector.purpose ?? null,
      envKey: connector.auth && connector.auth !== "none" ? envKeyFor(connector) : null,
    })),
    ledgers: {
      payments: paymentConnectors.map((connector) => ({
        provider: connector.name,
        status: "approval-required",
        mode: "provider-checkout",
        evidenceKind: "estimated",
      })),
      databases: databaseConnectors.map((connector) => ({
        provider: connector.name,
        status: "credential-required",
        mode: "agentlas-vault",
        evidenceKind: "estimated",
      })),
      imageGeneration: imageConnectors.map((connector) => ({
        provider: connector.name,
        status: "budget-gated",
        mode: "agentlas-generation-job",
        evidenceKind: "estimated",
      })),
    },
    collections: {
      products,
      orders,
      metrics,
      assets,
      launch,
      customers: [],
      events: [
        {
          at: ctx.now,
          actor: "agentlas-app-factory",
          type: "scaffold",
          summary: "Created local operations ledger from declarative surface manifest.",
        },
      ],
    },
  };
}

function buildCapabilityManifest(
  manifest: AgentlasSurfaceManifest,
  connectors: AgentlasSurfaceConnectorSpec[],
  actions: AgentlasSurfaceManifest["actions"],
  now: string,
): JsonObject {
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const hasConnector = (type: string, pattern?: RegExp) =>
    connectors.some((connector) => connector.type === type || (pattern ? pattern.test(`${connector.id} ${connector.name} ${connector.purpose ?? ""}`) : false));
  const hasAction = (type: string) => Array.isArray(actions) && actions.some((action) => action.type === type);
  const capabilities: JsonObject[] = declared.map((capability) => ({
    ...capability,
    source: stringValue((capability as JsonObject).source) || "surface-manifest",
    status: stringValue((capability as JsonObject).status) || "declared",
  })) as JsonObject[];
  const ensure = (capability: JsonObject) => {
    const id = stringValue(capability.id);
    if (!id || capabilities.some((item) => stringValue(item.id) === id)) return;
    capabilities.push(capability);
  };

  ensure({
    id: "generated-app-filesystem",
    type: "filesystem",
    purpose: "Create and update this generated app package, views, ledgers, MCP adapter, and reversible lifecycle metadata.",
    scope: "generated-app-root",
    approval: "once",
    access: "read-write-under-app-root",
    reversible: true,
    dataClasses: ["source-files", "operations-ledger", "preview-assets"],
    status: "approved-by-scaffold-action",
    source: "agentlas-app-factory",
  });
  if (connectors.length || hasAction("delegate-browser")) {
    ensure({
      id: "provider-browser-delegation",
      type: "browser-session",
      purpose: "Operate provider setup pages in a controlled browser profile and request secure OS/provider inputs for passwords, OTP, legal identity, CAPTCHA, terms, and paid checkout.",
      scope: "declared-provider-console-pages",
      approval: "once",
      allowlist: connectors.map((connector) => defaultProviderUrlForCapability(connector)).filter((url): url is string => Boolean(url)),
      dataClasses: ["sanitized-url", "page-title", "operator-status", "screenshot-path"],
      secretPolicy: "browser-profile-opaque-never-exported",
      status: "requires-user-approval-before-visible-launch",
      source: "agentlas-app-factory",
    });
  }
  if (hasConnector("payment") || hasAction("request-payment-approval")) {
    ensure({
      id: "payment-scope-approval",
      type: "payment",
      purpose: "Let the agent continue through payment-provider setup only after an explicit merchant, amount, recurrence, and card-handling approval.",
      scope: "declared-payment-providers",
      approval: "per-action",
      dataClasses: ["merchant", "quote", "recurrence", "receipt-metadata"],
      cardHandling: "provider-checkout-only",
      inputPath: "provider-checkout-or-tokenized-payment-ui",
      secretPolicy: "raw-card-cvv-cvc-never-in-agentlas-json",
      status: "approval-gated",
      source: "agentlas-app-factory",
    });
  }
  if (connectors.some((connector) => connector.auth && connector.auth !== "none") || hasAction("request-credential")) {
    ensure({
      id: "credential-vault",
      type: "credential",
      purpose: "Store provider API keys or OAuth setup outputs in Agentlas vault, writing only presence and fingerprint metadata into app ledgers.",
      scope: "declared-connector-env-keys",
      approval: "once",
      dataClasses: ["env-key-name", "credential-presence", "credential-fingerprint"],
      secretPolicy: "raw-secrets-never-in-manifest-chat-or-generated-files",
      status: "vault-gated",
      source: "agentlas-app-factory",
    });
  }
  if (hasConnector("model", /image|video|generation/i) || hasAction("generate")) {
    ensure({
      id: "generation-budget",
      type: "model-generation",
      purpose: "Generate image or video assets from approved briefs with budget limits, resumable jobs, and cost evidence.",
      scope: "declared-generation-jobs",
      approval: "per-run",
      dataClasses: ["brief", "prompt", "generated-asset-path", "cost-estimate"],
      budgetGated: true,
      status: "budget-gated",
      source: "agentlas-app-factory",
    });
  }
  if (manifest.domain === "ecommerce" || hasConnector("database")) {
    ensure({
      id: "commerce-pii-ledger",
      type: "pii",
      purpose: "Represent customer, order, refund, fulfillment, and support fields in the local operations dashboard before any live store connection.",
      scope: "local-commerce-ledger",
      approval: "once",
      dataClasses: ["customer", "order", "shipping-status", "support-note"],
      storage: "local-generated-app-json-until-live-provider-approved",
      status: "local-first",
      source: "agentlas-app-factory",
    });
  }

  return {
    version: "0.1",
    kind: "agentlas-app-capability-manifest",
    generatedAt: now,
    policy: "deny-by-default",
    approvalModel: "object-capability",
    capabilities,
    constraints: [
      "Renderer executes declarative manifests only; no model-generated code is executed in the UI.",
      "Passwords, OTPs, raw cards, CVV/CVC, cookies, provider tokens, and generated secrets stay out of chat, manifests, logs, and JSON artifacts.",
      "Provider browser profiles are opaque credential containers and must not be inspected or exported.",
      "Costly generation is budget gated and must expose estimate/spend evidence.",
      "Filesystem mutations remain scoped to the generated app root and reversible through the app lifecycle.",
    ],
  };
}

function defaultProviderUrlForCapability(connector: AgentlasSurfaceConnectorSpec): string | undefined {
  const explicit = stringValue((connector as unknown as JsonObject).setupUrl);
  if (explicit) return explicit;
  const id = `${connector.id} ${connector.name}`.toLowerCase();
  if (connector.type === "payment" || id.includes("stripe") || id.includes("payment")) return "https://dashboard.stripe.com/register";
  if (connector.type === "database" || id.includes("database") || id.includes("supabase")) return "https://supabase.com/dashboard/projects";
  if (connector.type === "model" || /image|video|generation/.test(id)) return "https://platform.openai.com/api-keys";
  if (connector.type === "api" || connector.auth === "oauth") return "https://vercel.com/new";
  return undefined;
}

function readme(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  connectors: AgentlasSurfaceConnectorSpec[],
  ctx: { appName: string; now: string },
): string {
  const app = manifest.app;
  return `# ${md(ctx.appName)}

> ${md(app?.tagline || app?.valueProp || manifest.title)}

Generated by Agentlas App Factory on ${ctx.now}.

## Why This Exists

${md(app?.valueProp || "This is an agent-made service app scaffold. It turns a one-off AI answer into a reusable workflow that can be operated, tested, and launched.")}

## Quick Start

\`\`\`bash
node tests/smoke.mjs
node scripts/serve.mjs
\`\`\`

Then open the printed local URL and inspect \`src/index.html\`.

## Screens

${routes.map((route) => `- \`${route.path}\` - ${md(route.label)}${route.purpose ? `: ${md(route.purpose)}` : ""}`).join("\n") || "- No routes declared yet."}

## Connectors

${connectors.map((c) => `- ${md(c.name)} (\`${c.type}\`) - ${md(c.status || "proposed")}${c.purpose ? `: ${md(c.purpose)}` : ""}`).join("\n") || "- No connectors declared yet."}

## Agent-made Tools

${toolsOf(manifest).map((t) => `- ${md(t.name)} (\`${md(t.kind || "tool")}\`) - ${md(t.description)}`).join("\n") || "- No local tools declared yet."}

## Launch Standard

This scaffold is not production by itself. It is the first launch package:

- App shell and preview
- Connector inventory
- Credential setup guide
- Smoke test
- Launch offer notes

Run the smoke test before sharing this app with anyone.
`;
}

function setupGuide(
  manifest: AgentlasSurfaceManifest,
  connectors: AgentlasSurfaceConnectorSpec[],
  ctx: { appName: string },
): string {
  const rows = connectors.length ? connectors : [];
  return `# ${md(ctx.appName)} Setup

This file is generated for the operator who will make the agent-made app real.
It keeps credentials out of the manifest and records exactly which services are
needed before launch.

## Required Connectors

${rows
  .map((c) => {
    const envKey = envKeyFor(c);
    const authLine =
      c.auth && c.auth !== "none"
        ? `\n  - Credential: \`${envKey}\` via \`${c.auth}\``
        : "\n  - Credential: none declared";
    const saveLine =
      c.auth && c.auth !== "none"
        ? `\n  - Save command: \`agentlas creds save --provider ${slugify(c.id || c.name)} --key ${envKey} --value <value> --project .\``
        : "";
    return `- ${md(c.name)}\n  - Type: \`${c.type}\`\n  - Status: ${md(c.status || "proposed")}\n  - Purpose: ${md(c.purpose || "Used by the generated app workflow.")}${authLine}${saveLine}`;
  })
  .join("\n") || "- No external connector is required yet."}

## MCP Notes

- MCP connectors should be installed through Agentlas Library > MCPs when a catalog entry exists.
- API keys should be saved through Agentlas credential storage, not pasted into source files.
- OAuth/user-approval connectors need an explicit user approval flow before launch.

## Launch Gate

1. Run \`node tests/smoke.mjs\`.
2. Open the preview with \`node scripts/serve.mjs\`.
3. Verify every connector marked \`verified\` has live evidence.
4. Move any \`missing-credential\` connector to verified or remove the feature.
`;
}

function launchGuide(
  manifest: AgentlasSurfaceManifest,
  business: Record<string, unknown> | undefined,
  launchRows: JsonObject[],
  ctx: { appName: string },
): string {
  return `# ${md(ctx.appName)} Launch Pack

## Audience

${md(stringValue(manifest.app?.audience) || stringValue(business?.audience) || "Audience not declared.")}

## Offer

${md(stringValue(manifest.app?.valueProp) || stringValue(business?.offer) || "Offer not declared.")}

## Pricing

${md(stringValue(business?.pricing) || "Pricing not declared.")}

## First Launch Metric

${md(stringValue(business?.launchMetric) || "Launch metric not declared.")}

## Launch Checklist

${launchRows.map((row) => `- [${stringValue(row.status) === "ready" ? "x" : " "}] ${md(stringValue(row.item) || stringValue(row.label) || "Launch item")} - ${md(stringValue(row.status) || "todo")}`).join("\n") || "- [ ] Add launch checklist."}
`;
}

function htmlPreview(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  connectors: AgentlasSurfaceConnectorSpec[],
  launchRows: JsonObject[],
  operations: JsonObject,
  ctx: { appName: string },
): string {
  const app = manifest.app;
  const op = normalizeOperationsForHtml(operations);
  const labels = appUiLabels(manifest);
  const storyboardRows = rowsOf(manifest, "shots", "media");
  const previewUrl = localPreviewUrl(manifest, operations);
  const primaryItems = labels.primaryCollection === "assets" ? op.assets : op.products;
  const visibleItems = storyboardRows.length ? storyboardRows : primaryItems;
  const firstRoute = routes[0]?.path || "/";
  const serviceCount = Math.max(op.connectors.length, connectors.length);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(ctx.appName)}</title>
    <style>
      ${buildDesignCss()}
      .cockpit { min-height: 680px; display: grid; grid-template-columns:minmax(0,0.95fr) minmax(420px,1.05fr); gap: clamp(22px, 4vw, 56px); align-items: center; padding: clamp(28px, 5vw, 64px); background: radial-gradient(circle at 82% 18%, rgba(41,87,255,0.28), transparent 28%), radial-gradient(circle at 18% 86%, rgba(216,92,74,0.22), transparent 32%), linear-gradient(135deg, #101010, #17231d 56%, #10222a); color: white; }
      .hero-copy { display:grid; gap:18px; min-width:0; }
      .eyebrow { width:max-content; max-width:100%; color:#a7f3d0; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.18); border-radius:999px; padding:7px 10px; font-size:12px; font-weight:900; text-transform:uppercase; }
      h1 { margin: 0; font-size: clamp(46px, 7vw, 92px); line-height: 0.88; max-width: 900px; letter-spacing:0; }
      .hero-copy p { margin: 0; max-width: 760px; color: #d6d9df; font-size:16px; }
      .hero-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
      .hero-actions a, .hero-actions span { border-radius:999px; padding:10px 13px; font-weight:900; font-size:12px; text-decoration:none; }
      .hero-actions a { background:#fffefa; color:#111; }
      .hero-actions span { background:rgba(167,243,208,0.16); color:#bbf7d0; border:1px solid rgba(167,243,208,0.28); }
      .launch-canvas { display:grid; grid-template-columns:1fr 0.78fr; gap:14px; min-width:0; }
      .store-frame, .agent-stack, .mini-frame, .delegation-card, .screen-card, .pipeline-card, .runtime-card, .card { border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); }
      .store-frame { min-height:420px; display:grid; grid-template-rows:auto minmax(0,1fr); overflow:hidden; box-shadow:0 34px 90px rgba(15,23,42,0.25); }
      .store-top { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px; border-bottom:1px solid var(--line); background:#f8faf7; }
      .traffic { display:flex; gap:6px; }
      .traffic span { width:10px; height:10px; border-radius:50%; background:#f87171; }
      .traffic span:nth-child(2) { background:#fbbf24; }
      .traffic span:nth-child(3) { background:#34d399; }
      .store-url { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:12px; font-weight:800; }
      .store-body { display:grid; grid-template-columns:1fr 0.72fr; gap:12px; padding:14px; background:linear-gradient(145deg, #fffefa, #eef5ff); }
      .visual-stack { display:grid; gap:10px; min-width:0; }
      .visual-card { position:relative; overflow:hidden; min-height:145px; display:grid; align-content:end; gap:3px; padding:12px; border:1px solid var(--line); border-radius:8px; background:linear-gradient(140deg, #f8e2d8, #dcefe7 52%, #dce6f6); color:#201f1b; }
      .visual-card:first-child { min-height:246px; }
      .visual-card img { position:absolute; inset:8px; width:calc(100% - 16px); height:calc(100% - 16px); object-fit:contain; }
      .visual-card.has-image::after { content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(20,18,16,0.42)); }
      .visual-card strong, .visual-card span { position:relative; z-index:1; overflow-wrap:anywhere; }
      .visual-card.has-image strong, .visual-card.has-image span { color:white; text-shadow:0 1px 8px rgba(0,0,0,0.35); }
      .visual-card span { color:#606963; font-size:12px; }
      .checkout-panel { display:grid; gap:10px; align-content:start; }
      .checkout-panel h2 { margin:0; font-size:18px; }
      .checkout-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding:10px; border:1px solid var(--line); border-radius:8px; background:white; }
      .checkout-row strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .agent-stack { display:grid; gap:12px; padding:14px; box-shadow:0 28px 70px rgba(15,23,42,0.2); }
      .agent-stack h2 { margin:0; font-size:18px; }
      .mini-frame { padding:12px; display:grid; gap:7px; }
      .mini-frame strong { font-size:18px; line-height:1; }
      .mini-frame small { color:var(--muted); }
      .os-map { display:grid; gap:10px; }
      .os-step { display:grid; grid-template-columns:34px minmax(0,1fr); gap:8px 10px; align-items:center; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
      .os-step .dot { width:34px; height:34px; border-radius:50%; display:grid; place-items:center; background:var(--dark); color:white; font-weight:950; font-size:12px; }
      .os-step > div { display:grid; gap:3px; min-width:0; }
      .os-step strong, .os-step small { min-width:0; overflow-wrap:anywhere; }
      .os-step small { color:var(--muted); }
      .os-step .pill { grid-column:2; justify-self:start; }
      main { display:grid; gap:1px; background:var(--line); }
      section, details { background:var(--paper); padding:24px clamp(18px, 4vw, 42px); min-width:0; }
      .section-head { display:flex; justify-content:space-between; align-items:end; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
      .section-head h2, .section-head h3 { margin:0; font-size:22px; }
      .section-head p { margin:4px 0 0; color:var(--muted); max-width:740px; }
      .impact-band { display:grid; grid-template-columns:1.25fr repeat(4, minmax(120px, 1fr)); gap:10px; align-items:stretch; background:var(--paper); }
      .impact-cell { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:14px; display:grid; gap:4px; align-content:center; min-height:96px; }
      .impact-cell.lead { background:#151513; color:white; }
      .impact-cell strong { font-size:26px; line-height:1; overflow-wrap:anywhere; }
      .impact-cell span { color:var(--muted); font-size:12px; }
      .impact-cell.lead span { color:#d8ded7; }
      .workbench { display:grid; grid-template-columns:minmax(280px,1fr) 6px minmax(320px,0.55fr); gap:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--line); align-items:stretch; }
      .workbench-pane { background:var(--paper); padding:16px; min-width:0; overflow:auto; }
      .workbench-pane.secondary { background:var(--panel); }
      .workbench-resizer { cursor:ew-resize; background:var(--line); touch-action:none; min-width:6px; }
      .workbench-resizer:hover, .workbench-resizer.active { background:#b8c0cc; }
      nav, .screen-grid, .grid, .delegation-grid, .runtime-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; }
      nav a, .screen-card { color:var(--ink); text-decoration:none; display:grid; gap:8px; padding:13px; min-height:110px; }
      nav a strong, .screen-card strong { font-size:16px; overflow-wrap:anywhere; }
      nav a small, .screen-card small { color:var(--muted); }
      .delegation-grid { grid-template-columns:repeat(4, minmax(170px, 1fr)); }
      .delegation-card { padding:14px; min-height:150px; display:grid; gap:8px; align-content:start; }
      .delegation-card strong { font-size:16px; }
      .delegation-card small { color:var(--muted); }
      .pipeline { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
      .pipeline-card { padding:14px; display:grid; gap:12px; }
      .runtime-drawer summary { cursor:pointer; font-weight:950; font-size:18px; }
      .runtime-drawer p { color:var(--muted); margin:6px 0 16px; }
      .runtime-card { padding:12px; display:grid; gap:8px; align-content:start; }
      .runtime-card h3 { margin:0; font-size:13px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
      .card { padding: 12px; }
      .card small { color: var(--muted); display: block; margin-top: 5px; }
      .metric { min-height:92px; align-content:end; }
      .metric strong { display:block; font-size: 28px; line-height:1; letter-spacing: 0; }
      .lane { display:grid; gap: 10px; margin-top: 16px; }
      .row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap: 10px; align-items:center; border: 1px solid var(--line); border-radius: 8px; background: white; padding: 11px 12px; }
      .row strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .connector { display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-areas: "badge name" ". status"; gap: 2px 10px; align-items: center; border-bottom: 1px solid var(--line); padding: 10px 0; }
      .connector strong { grid-area: name; min-width: 0; overflow-wrap: anywhere; line-height: 1.25; }
      .badge { border-radius: 7px; background: var(--soft); color: var(--accent); font-size: 10px; font-weight: 900; padding: 5px 6px; text-align: center; }
      .connector .badge { grid-area: badge; }
      .status { grid-area: status; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
      .runtime-block { display:grid; gap: 7px; margin-top: 18px; }
      .runtime-block h3 { margin: 0; font-size: 13px; }
      .micro-card { border: 1px solid var(--line); border-radius: 8px; background: white; padding: 10px; display: grid; gap: 4px; }
      .micro-card strong, .micro-card code { overflow-wrap: anywhere; }
      .micro-card code { font-size: 11px; color: var(--accent); background: var(--soft); padding: 2px 5px; border-radius: 5px; width: fit-content; }
      .storyboard-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
      .shot-card { border:1px solid var(--line); border-radius:8px; background:var(--panel); overflow:hidden; display:grid; min-width:0; }
      .shot-card img { width:100%; height:170px; object-fit:cover; display:block; background:var(--field); border-bottom:1px solid var(--line); }
      .shot-card .shot-body { display:grid; gap:6px; padding:12px; min-width:0; }
      .shot-card strong { overflow-wrap:anywhere; }
      .shot-card .camera { color:var(--accent); font-size:12px; }
      .shot-card .scene { color:var(--muted); font-size:12px; line-height:1.45; }
      .web-studio { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--panel); }
      .web-studio .bar { display:flex; align-items:center; gap:8px; min-height:38px; padding:8px 10px; border-bottom:1px solid var(--line); }
      .web-studio iframe { width:100%; height:min(720px, 72vh); border:0; display:block; background:white; }
      .operator-panel { border: 1px solid rgba(41,87,255,0.22); border-radius: 8px; background: linear-gradient(180deg, #f9fbff, #fffefa); padding: 14px; display:grid; gap:12px; }
      .operator-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:10px; }
      .operator-card { border:1px solid var(--line); border-radius:8px; background:white; padding:10px; display:grid; gap:4px; }
      .operator-card strong { font-size:20px; line-height:1; }
      .operator-card small { color:var(--muted); }
      .operator-policy { display:grid; gap:6px; }
      .pill { border-radius: 999px; padding: 4px 8px; background: #f4f4f2; color: var(--muted); font-size: 11px; font-weight: 800; }
      .pill.approval, .pill.queued, .pill.missing, .pill.required { background:#fff7ed; color:var(--warn); }
      .pill.ready, .pill.verified { background:#ecfdf5; color:var(--ok); }
      .pill.risk { background:#fff1f2; color:var(--risk); }
      @media (max-width: 1180px) { .cockpit, .launch-canvas, .workbench, .pipeline, .impact-band { grid-template-columns:1fr !important; } .workbench-resizer { display:none; } .delegation-grid { grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); } }
      @media (max-width: 720px) { .cockpit { padding:24px; min-height:auto; } .store-body { grid-template-columns:1fr; } h1 { font-size:42px; } section, details { padding:20px 16px; } }
    </style>
  </head>
  <body>
    <header class="cockpit">
      <div class="hero-copy">
        <span class="eyebrow">Agentlas OS generated this app</span>
        <h1>${html(appHeroHeadline(manifest, ctx.appName))}</h1>
        <p>${html(app?.valueProp || app?.tagline || manifest.title)}</p>
        <p>Agentlas turns a plain request into an operating app: it can create provider accounts, operate consoles, request secure credentials, ask for payment approval, and fall back to browser or local helpers when no API/MCP exists.</p>
        <div class="hero-actions">
          <a href="${html(previewUrl || firstRoute)}">${html(previewUrl ? "Open web studio" : "Open the live app")}</a>
          <span>No API? browser + alternate provider + local helper</span>
          <span>${html(op.reuse.status ? "Reusable tool published" : "Persistent OS object")}</span>
        </div>
      </div>
      ${launchCanvasHtml(manifest, routes, op, visibleItems, labels, previewUrl || firstRoute)}
    </header>
    <main>
      <section class="impact-band" aria-label="Agentlas generated app summary">
        <div class="impact-cell lead"><span>Agentlas output</span><strong>${html(app?.name || manifest.title)}</strong><span>not a chat transcript, a durable OS object</span></div>
        <div class="impact-cell"><span>${html(storyboardRows.length ? "storyboard shots" : labels.metricLabel)}</span><strong data-stat="products">${html(visibleItems.length)}</strong><span>rendered in the app</span></div>
        <div class="impact-cell"><span>Provider tasks</span><strong data-stat="providerTasks">${html(op.providerTasks.length)}</strong><span>operated by the agent</span></div>
        <div class="impact-cell"><span>Services</span><strong data-stat="connectors">${html(serviceCount)}</strong><span>API, browser, or fallback</span></div>
        <div class="impact-cell"><span>Jobs</span><strong data-stat="jobs">${html(op.jobs.length)}</strong><span>budgeted and resumable</span></div>
      </section>
      ${storyboardRows.length ? storyboardSectionHtml(storyboardRows) : ""}
      ${previewUrl ? webStudioSectionHtml(previewUrl) : ""}
      <section>
        <div class="section-head">
          <div>
            <h2>What Agentlas built</h2>
            <p>Generated screens, local runtime data, provider plans, and reusable tool packaging from one surface manifest.</p>
          </div>
          <span class="pill ready">launchable app package</span>
        </div>
        <div class="workbench" data-resizable-split="generated-workbench">
          <div class="workbench-pane">
            <nav aria-label="Generated app screens">
              ${routes.map((route) => `<a class="screen-card" href="${html(route.path)}"><strong>${html(route.label)}</strong><small>${html(route.purpose || route.status || "Generated app route")}</small><span class="pill ${statusClass(route.status)}">${html(route.status || "ready")}</span></a>`).join("\n              ")}
            </nav>
            <div class="lane">
              <h3>${html(storyboardRows.length ? "Storyboard" : labels.primaryHeading)}</h3>
              <div data-list="products">
                ${productRowsHtml(visibleItems, storyboardRows.length ? storyboardLabels() : labels)}
              </div>
            </div>
          </div>
          <div class="workbench-resizer" role="separator" aria-label="Resize workbench split" aria-orientation="vertical"></div>
          <div class="workbench-pane secondary">
            ${operatorConsoleHtml(op)}
          </div>
        </div>
      </section>
      <section>
        <div class="section-head">
          <div>
            <h2>Delegated Operations OS</h2>
            <p>The user asks for the outcome. Agentlas handles provider console work and asks only for secure checkpoints it cannot legally or safely infer.</p>
          </div>
          <span class="pill ready">no dead-end contract</span>
        </div>
        <div class="delegation-grid">
          ${delegatedOperationsCardsHtml()}
        </div>
      </section>
      <section>
        <div class="section-head">
          <div>
            <h2>Launch pipeline</h2>
            <p>These are operating tasks, not instructions for the user to finish manually.</p>
          </div>
        </div>
        <div class="pipeline">
          <div class="pipeline-card">
            <h3>Operating tasks</h3>
            <div data-list="providerTasks">
              ${providerTaskRowsHtml(op.providerTasks)}
            </div>
          </div>
          <div class="pipeline-card">
            <h3>Launch checklist</h3>
            <div class="grid">
              ${launchRows.map((row) => `<div class="card"><strong>${html(stringValue(row.item) || stringValue(row.label) || "Launch item")}</strong><small>${html(stringValue(row.status) || "todo")}</small></div>`).join("\n              ")}
            </div>
          </div>
        </div>
      </section>
      <details class="runtime-drawer">
        <summary>Developer runtime evidence</summary>
        <p>Agent-facing contracts stay inspectable here, but they are no longer the first thing a human sees.</p>
        <div class="runtime-grid">
          <div class="runtime-card">
            <h3>Connectors</h3>
            <div data-list="connectors">
              ${connectorRowsHtml(op.connectors.length ? op.connectors : connectors)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Capability Manifest</h3>
            <div data-list="capabilities">
              ${capabilityRowsHtml(op.capabilities)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Browser Start Plan</h3>
            <div data-list="browserPlans">
              ${browserPlanRowsHtml(op.browserPlans)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Provider Recipes</h3>
            <div data-list="providerRecipes">
              ${providerRecipeRowsHtml(op.providerRecipes)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>No-Dead-End Strategy</h3>
            <div data-list="noDeadEndStrategy">
              ${noDeadEndRowsHtml(op.noDeadEndStrategy)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Provider Sessions</h3>
            <div data-list="browserSessions">
              ${providerSessionRowsHtml(op.browserSessions)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Provider Launches</h3>
            <div data-list="browserLaunches">
              ${providerLaunchRowsHtml(op.browserLaunches)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Vault Keys</h3>
            <div data-list="credentialGates">
              ${credentialGateRowsHtml(op.credentialGates)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Credential Resolution</h3>
            <div data-list="credentialResolution">
              ${credentialResolutionRowsHtml(op.credentialResolution)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>OS Object Lifecycle</h3>
            <div data-list="lifecycle">
              ${lifecycleRowsHtml(op.lifecycle)}
            </div>
          </div>
          <div class="runtime-card">
            <h3>Reusable Tool</h3>
            <div data-list="reusableTool">
              ${reusableToolRowsHtml(op.reuse)}
            </div>
          </div>
        </div>
      </details>
    </main>
    <script type="module">
${generatedWorkbenchSplitScript()}
${operationsHydrationScript()}
    </script>
  </body>
</html>
`;
}

function launchCanvasHtml(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  op: ReturnType<typeof normalizeOperationsForHtml>,
  primaryItems: JsonObject[],
  labels: ReturnType<typeof appUiLabels>,
  firstRoute: string,
): string {
  const app = manifest.app;
  const rows = primaryItems.length ? primaryItems.slice(0, 3) : [{ name: labels.itemFallback, status: "planned", trust: "estimated" }];
  const browserStarts = Math.max(op.browserSessions.length, op.browserPlans.length);
  return `<div class="launch-canvas" aria-label="Generated app preview and OS operation flow">
        <div class="store-frame">
          <div class="store-top">
            <div class="traffic" aria-hidden="true"><span></span><span></span><span></span></div>
            <div class="store-url">${html(firstRoute)} · ${html(app?.appType || manifest.layout || "generated app")}</div>
            <span class="pill ready">running</span>
          </div>
          <div class="store-body">
            <div class="visual-stack">
              ${rows
                .map((row) => {
                  const src = assetSrc(row.assetPath || row.imagePath || row.path || row.imageUrl || row.thumbnail || row.url);
                  return `<div class="visual-card ${src ? "has-image" : ""}">${src ? `<img src="${html(src)}" alt="${html(row.name || row.label || labels.itemFallback)}" loading="lazy" />` : ""}<strong>${html(row.name || row.label || labels.itemFallback)}</strong><span>${html(row.status || row.imageStatus || "planned")} · ${html(row.trust || "estimated")}</span></div>`;
                })
                .join("\n              ")}
            </div>
            <div class="checkout-panel">
              <h2>App the user can operate</h2>
              <div class="checkout-row"><strong>${html(routes[0]?.label || "Home")}</strong><span class="pill ready">screen</span></div>
              <div class="checkout-row"><strong>${html(routes[1]?.label || "Workflow")}</strong><span class="pill ready">screen</span></div>
              <div class="checkout-row"><strong>${html(op.reuse.status ? "Tool published" : "Tool package")}</strong><span class="pill ${statusClass(op.reuse.status || "planned")}">${html(op.reuse.status || "planned")}</span></div>
              <div class="checkout-row"><strong>Provider work</strong><span class="pill ${browserStarts ? "ready" : "approval"}">${html(String(browserStarts))}</span></div>
            </div>
          </div>
        </div>
        <aside class="agent-stack">
          <h2>From request to operating app</h2>
          <div class="os-map">
            ${osStoryStepsHtml(manifest, routes, op, primaryItems.length)}
          </div>
          <div class="mini-frame"><strong>Agent can continue</strong><small>Signup, console setup, API keys, browser sessions, payment scope, local fallbacks, and reusable MCP packaging are OS actions.</small></div>
          <div class="mini-frame"><strong>Human stays high leverage</strong><small>Only secure credential input, identity/terms liability, CAPTCHA, or paid checkout approval interrupts the agent.</small></div>
        </aside>
      </div>`;
}

function storyboardSectionHtml(rows: JsonObject[]): string {
  return `<section>
        <div class="section-head">
          <div>
            <h2>Storyboard</h2>
            <p>The generated app keeps the actual shot plan visible inside Agentlas, even when video generation is not available.</p>
          </div>
          <span class="pill ready">${html(String(rows.length))} shots</span>
        </div>
        <div class="storyboard-grid">
          ${rows.map((row, index) => shotCardHtml(row, index + 1)).join("\n          ")}
        </div>
      </section>`;
}

function shotCardHtml(row: JsonObject, index: number): string {
  const src = assetSrc(row.imagePath || row.path || row.imageUrl || row.thumbnail || row.url);
  const title = stringValue(row.caption) || stringValue(row.title) || `Shot ${index}`;
  const scene = stringValue(row.scene) || stringValue(row.description) || stringValue(row.imagePrompt);
  const camera = stringValue(row.camera);
  return `<article class="shot-card">
            ${src ? `<img src="${html(src)}" alt="${html(title)}" loading="lazy" />` : ""}
            <div class="shot-body">
              <span class="pill ready">SHOT ${html(String(index))}</span>
              <strong>${html(title)}</strong>
              ${camera ? `<span class="camera">${html(camera)}</span>` : ""}
              ${scene ? `<span class="scene">${html(scene)}</span>` : ""}
            </div>
          </article>`;
}

function webStudioSectionHtml(previewUrl: string): string {
  return `<section>
        <div class="section-head">
          <div>
            <h2>Web Studio</h2>
            <p>This generated app also opens as a local web workspace, so the storyboard can be edited and regenerated outside the chat transcript.</p>
          </div>
          <a class="pill ready" href="${html(previewUrl)}">Open web</a>
        </div>
        <div class="web-studio">
          <div class="bar"><span class="pill ready">live</span><a href="${html(previewUrl)}">${html(previewUrl)}</a></div>
          <iframe src="${html(previewUrl)}" title="Generated app web studio"></iframe>
        </div>
      </section>`;
}

function delegatedOperationsCardsHtml(): string {
  const rows = [
    {
      title: "Account concierge",
      detail: "Agent opens provider consoles, signs up or logs in when authorized, creates projects, apps, keys, webhooks, and workspaces.",
      status: "browser-first",
    },
    {
      title: "Credential vault",
      detail: "User can enter IDs, passwords, API keys, and tokens through secure OS inputs; app ledgers store only presence and fingerprints.",
      status: "vault-gated",
    },
    {
      title: "Payment proxy",
      detail: "Agent can prepare checkout and continue after explicit merchant, amount, recurrence, and card-handling approval.",
      status: "approval",
    },
    {
      title: "No-dead-end resolver",
      detail: "Missing MCP/API, region blocks, or provider complexity become browser delegation, alternate provider, or generated local helper.",
      status: "recoverable",
    },
  ];
  return rows
    .map((row) => `<div class="delegation-card"><span class="pill ${statusClass(row.status)}">${html(row.status)}</span><strong>${html(row.title)}</strong><small>${html(row.detail)}</small></div>`)
    .join("\n          ");
}

function appHeroHeadline(manifest: AgentlasSurfaceManifest, appName: string): string {
  const business = manifest.app?.business ?? objectData(manifest, "business");
  const offer = stringValue(business?.offer) || stringValue(manifest.app?.valueProp);
  if (offer) return offer;
  const domain = manifest.domain ? `${manifest.domain} ` : "";
  return `One request became a running ${domain}app`;
}

function osStoryStepsHtml(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  op: ReturnType<typeof normalizeOperationsForHtml>,
  primaryCount: number,
): string {
  const appType = stringValue(manifest.app?.appType) || manifest.layout || "app";
  const browserStarts = Math.max(op.browserSessions.length, op.browserPlans.length);
  const published = stringValue(op.reuse.status) || stringValue(op.lifecycle.status) || "scaffolded";
  const rows = [
    {
      title: "Plain-language intent",
      detail: `${manifest.domain || "domain"} request captured as a declarative surface manifest.`,
      status: "claimed",
    },
    {
      title: "Launchable app shell",
      detail: `${routes.length} route${routes.length === 1 ? "" : "s"} generated for a ${appType} workflow.`,
      status: routes.length ? "ready" : "planned",
    },
    {
      title: "Assets and operating data",
      detail: `${primaryCount} catalog/asset row${primaryCount === 1 ? "" : "s"} plus ${op.jobs.length} resumable job${op.jobs.length === 1 ? "" : "s"}.`,
      status: primaryCount ? "verified" : "estimated",
    },
    {
      title: "Provider operation path",
      detail: `${op.connectors.length} service${op.connectors.length === 1 ? "" : "s"}, ${browserStarts} browser handoff${browserStarts === 1 ? "" : "s"}, no-dead-end fallback.`,
      status: browserStarts || op.connectors.length ? "ready" : "planned",
    },
    {
      title: "Reusable OS object",
      detail: `Lifecycle: ${published}; downstream agents can call the generated tool when published.`,
      status: published,
    },
  ];
  return rows
    .map((row, index) => `<div class="os-step"><span class="dot">${index + 1}</span><div><strong>${html(row.title)}</strong><small>${html(row.detail)}</small></div><span class="pill ${statusClass(row.status)}">${html(row.status)}</span></div>`)
    .join("\n        ");
}

function routePageHtml(
  manifest: AgentlasSurfaceManifest,
  route: AgentlasSurfaceAppRoute,
  routes: AgentlasSurfaceAppRoute[],
  operations: JsonObject,
  ctx: { appName: string },
): string {
  const app = manifest.app;
  const op = normalizeOperationsForHtml(operations);
  const collections = collectionsForHtml(operations);
  const routeKey = `${route.path} ${route.label} ${route.purpose ?? ""}`.toLowerCase();
  const pageTitle = route.label || ctx.appName;
  const content = routeContentHtml(manifest, routeKey, operations);
  const primaryCount = routeKey.includes("catalog") || routeKey.includes("store") ? collections.products.length : Math.max(collections.metrics.length, collections.products.length, collections.assets.length);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(pageTitle)} - ${html(ctx.appName)}</title>
    <style>
      ${buildDesignCss()}
      .top { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:24px; align-items:end; padding:30px clamp(18px, 4vw, 48px) 24px; border-bottom:1px solid var(--line); background:linear-gradient(115deg, #fffefa 0%, #fffefa 52%, #e7f0ff 52.2%, #e6f7ee 100%); }
      .eyebrow { margin:0 0 8px; width:max-content; max-width:100%; border-radius:999px; padding:5px 9px; background:#e7f6ed; color:var(--green); font-size:11px; font-weight:950; text-transform:uppercase; }
      h1 { margin:0; font-size:clamp(34px, 5vw, 72px); line-height:0.92; letter-spacing:0; }
      .top p { margin:9px 0 0; max-width:760px; color:var(--muted); }
      nav { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
      nav a { border:1px solid var(--line); border-radius:8px; padding:8px 10px; color:var(--ink); background:var(--paper); text-decoration:none; font-size:12px; font-weight:850; }
      nav a.active { background:var(--ink); color:white; border-color:var(--ink); }
      main { display:grid; gap:24px; padding:24px clamp(18px, 4vw, 42px) 42px; }
      .impact-strip { display:grid; grid-template-columns:1.2fr repeat(4, minmax(120px, 1fr)); gap:10px; align-items:stretch; }
      .impact-cell { border:1px solid var(--line); border-radius:8px; background:var(--white); padding:13px; display:grid; gap:4px; min-height:86px; align-content:center; }
      .impact-cell.lead { background:#171715; color:white; }
      .impact-cell strong { font-size:22px; line-height:1; overflow-wrap:anywhere; }
      .impact-cell span { color:var(--muted); font-size:12px; }
      .impact-cell.lead span { color:#d8ded7; }
      .hero { min-height:300px; display:grid; grid-template-columns:minmax(0, 1.1fr) minmax(280px, 0.9fr); gap:24px; align-items:stretch; }
      .hero-copy { display:grid; align-content:center; gap:14px; padding:12px 0; }
      .hero-copy h2 { margin:0; font-size:clamp(32px, 5vw, 64px); line-height:0.95; max-width:760px; }
      .hero-copy p { margin:0; color:var(--muted); max-width:620px; font-size:16px; }
      .lookbook { min-height:300px; display:grid; grid-template-columns:1fr 0.78fr; gap:12px; }
      .media-slot { border:1px solid var(--line); border-radius:8px; min-height:150px; background:linear-gradient(145deg, #f6e7dc, #dce9dc 52%, #d7e3ef); display:grid; align-content:end; padding:14px; color:#292722; overflow:hidden; position:relative; }
      .media-slot::before { content:""; position:absolute; inset:18px 18px auto auto; width:42%; height:36%; border:1px solid rgba(41,39,34,0.16); background:rgba(255,255,255,0.38); }
      .media-slot.has-image { background:#f7f4ef; }
      .media-slot.has-image::before { display:none; }
      .media-slot img { position:absolute; inset:8px; width:calc(100% - 16px); height:calc(100% - 16px); object-fit:contain; }
      .media-slot.has-image::after { content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(20,18,16,0.34)); }
      .media-slot strong, .media-slot span { position:relative; }
      .media-slot.has-image strong, .media-slot.has-image span { z-index:1; color:white; text-shadow:0 1px 8px rgba(0,0,0,0.35); }
      .media-slot strong { font-size:15px; }
      .media-slot span { color:#54564f; font-size:12px; }
      .storyboard-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
      .shot-card { border:1px solid var(--line); border-radius:8px; background:var(--white); overflow:hidden; display:grid; min-width:0; }
      .shot-card img { width:100%; height:170px; object-fit:cover; display:block; background:var(--field); border-bottom:1px solid var(--line); }
      .shot-card .shot-body { display:grid; gap:6px; padding:12px; min-width:0; }
      .shot-card strong { overflow-wrap:anywhere; }
      .shot-card .camera { color:var(--blue); font-size:12px; }
      .shot-card .scene { color:var(--muted); font-size:12px; line-height:1.45; }
      .web-studio { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--white); }
      .web-studio .bar { display:flex; align-items:center; gap:8px; min-height:38px; padding:8px 10px; border-bottom:1px solid var(--line); }
      .web-studio iframe { width:100%; height:min(720px, 72vh); border:0; display:block; background:white; }
      .stack { display:grid; gap:12px; }
      .section { display:grid; gap:12px; }
      .section h2, .section h3 { margin:0; }
      .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; }
      .item, .wide-item, .ledger, .table-row { border:1px solid var(--line); border-radius:8px; background:var(--white); padding:13px; }
      .item { display:grid; gap:8px; min-height:112px; }
      .item-image { width:100%; aspect-ratio:4 / 3; object-fit:cover; border-radius:7px; border:1px solid var(--line); background:var(--field); }
      .wide-item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; }
      .wide-item strong, .item strong { overflow-wrap:anywhere; }
      .meta { color:var(--muted); font-size:12px; }
      .pill { border-radius:999px; padding:4px 8px; background:var(--field); color:var(--muted); font-size:11px; font-weight:850; width:max-content; max-width:100%; overflow-wrap:anywhere; }
      .pill.ready, .pill.verified { background:#e7f6ed; color:var(--green); }
      .pill.claimed { background:#e8f0fb; color:var(--blue); }
      .pill.estimated, .pill.approval, .pill.queued, .pill.required, .pill.missing { background:#fff4dc; color:var(--gold); }
      .pill.unverified, .pill.risk { background:#fff1f2; color:var(--risk); }
      .table { display:grid; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--white); }
      .table-row { border-width:0 0 1px; border-radius:0; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(110px,0.5fr) minmax(110px,0.5fr); gap:12px; align-items:center; }
      .table-row:last-child { border-bottom:0; }
      .ledger { display:grid; gap:7px; }
      .ledger code { color:var(--blue); background:#eef5ff; border-radius:5px; padding:2px 5px; width:max-content; max-width:100%; overflow-wrap:anywhere; }
      .micro-card { border:1px solid var(--line); border-radius:8px; background:var(--white); padding:10px; display:grid; gap:4px; }
      .micro-card strong, .micro-card code { overflow-wrap:anywhere; }
      .micro-card code { color:var(--blue); background:#eef5ff; border-radius:5px; padding:2px 5px; width:max-content; max-width:100%; }
      .operator-panel { border:1px solid #cbd5e1; border-radius:8px; background:#f8fafc; padding:14px; display:grid; gap:12px; }
      .operator-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; }
      .operator-card { border:1px solid var(--line); border-radius:8px; background:var(--white); padding:10px; display:grid; gap:4px; }
      .operator-card strong { font-size:20px; line-height:1; }
      .operator-card small { color:var(--muted); }
      .operator-policy { display:grid; gap:6px; }
      .trust { display:flex; flex-wrap:wrap; gap:8px; }
      @media (max-width: 860px) { .top, .hero, .impact-strip { grid-template-columns:1fr; } nav { justify-content:flex-start; } .lookbook { grid-template-columns:1fr; } .table-row { grid-template-columns:1fr; } }
    </style>
  </head>
  <body data-route-path="${html(route.path)}">
    <header class="top">
      <div>
        <p class="eyebrow">Agentlas generated route</p>
        <h1>${html(pageTitle)}</h1>
        <p>${html(route.purpose || app?.valueProp || manifest.title)}</p>
      </div>
      <nav aria-label="Generated app screens">
        ${routes.map((item) => `<a href="${html(item.path)}" class="${item.path === route.path ? "active" : ""}">${html(item.label)}</a>`).join("\n        ")}
      </nav>
    </header>
    <main>
      ${routeImpactStripHtml(manifest, op, primaryCount)}
      ${content}
      ${operatorConsoleSectionHtml(operations)}
      ${localRuntimeSectionHtml(operations)}
      <section class="section">
        <h3>Runtime State</h3>
        <div class="grid">
          <div class="ledger"><strong>${html(op.providerTasks.length)}</strong><span class="meta">provider tasks</span></div>
          <div class="ledger"><strong>${html(op.connectors.length)}</strong><span class="meta">declared connectors</span></div>
          <div class="ledger"><strong>${html(op.jobs.length)}</strong><span class="meta">resumable jobs</span></div>
          <div class="ledger"><strong>${html(collections.events.length)}</strong><span class="meta">ledger events</span></div>
        </div>
      </section>
    </main>
  </body>
</html>
`;
}

function operatorConsoleSectionHtml(operations: JsonObject): string {
  return `<section class="section">
        <h3>Agent Operator Console</h3>
        ${operatorConsoleHtml(normalizeOperationsForHtml(operations))}
      </section>`;
}

function routeImpactStripHtml(
  manifest: AgentlasSurfaceManifest,
  op: ReturnType<typeof normalizeOperationsForHtml>,
  primaryCount: number,
): string {
  const browserStarts = Math.max(op.browserSessions.length, op.browserPlans.length);
  const published = stringValue(op.reuse.status) || stringValue(op.lifecycle.status) || "scaffolded";
  const rows = [
    ["Routes", String((manifest.app?.routes ?? []).length || "ready"), "generated screens"],
    ["Assets", String(primaryCount), "catalog/data rows"],
    ["Providers", String(op.connectors.length), `${browserStarts} browser handoffs`],
    ["Reuse", published, "OS object state"],
  ];
  return `<section class="impact-strip" aria-label="Agentlas generated app summary">
        <div class="impact-cell lead"><strong>${html(manifest.app?.name || manifest.title)}</strong><span>agent-built app, not a chat transcript</span></div>
        ${rows.map(([label, value, detail]) => `<div class="impact-cell"><span>${html(label)}</span><strong>${html(value)}</strong><span>${html(detail)}</span></div>`).join("\n        ")}
      </section>`;
}

function operatorConsoleHtml(op: ReturnType<typeof normalizeOperationsForHtml>): string {
  const rows = operatorStatusRows(op);
  return `<div class="operator-panel" data-list="operatorConsole">
          <div class="operator-grid">
            ${rows.map((row) => `<div class="operator-card"><span class="pill ${statusClass(row.status)}">${html(row.status)}</span><strong>${html(row.value)}</strong><small>${html(row.label)}</small><small>${html(row.detail)}</small></div>`).join("\n            ")}
          </div>
          <div class="operator-policy">
            <div class="micro-card"><strong>Agent-first external-service operation</strong><small>Missing API/MCP paths become controlled browser delegation, alternate provider, generated local helper, or local fallback.</small></div>
            <div class="micro-card"><strong>Secure input concierge</strong><small>The user may provide account, credential, identity, or payment details through Agentlas vault, provider pages, or tokenized payment UI; only fingerprints, approvals, and receipts return to app ledgers.</small></div>
          </div>
        </div>`;
}

function operatorStatusRows(op: ReturnType<typeof normalizeOperationsForHtml>): Array<{ label: string; value: string; detail: string; status: string }> {
  const paymentGates = op.providerTasks.filter((task) => stringValue(task.type) === "request-payment-approval").length;
  const credentialGates = op.credentialGates.length || op.providerTasks.filter((task) => stringValue(task.type) === "request-credential").length;
  const secureSessions = op.browserSessions.filter((session) =>
    /checkpoint|required|login|signup|payment|captcha/i.test(`${session.status || ""} ${session.blockerKind || ""}`),
  ).length;
  const noDeadEndStatus = stringValue(op.noDeadEndStrategy.status) || (op.connectors.length ? "planned" : "not-needed");
  const resultReady = op.browserSessions.filter((session) => session.agentCanContinue === true || stringValue(session.resultStatus)).length;
  const published = stringValue(op.reuse.status) || stringValue(op.lifecycle.status) || "scaffolded";
  return [
    {
      label: "External services",
      value: String(op.connectors.length),
      detail: op.connectors.length ? "Declared provider surfaces the agent can operate." : "No external provider declared yet.",
      status: op.connectors.length ? "ready" : "planned",
    },
    {
      label: "Browser delegation",
      value: String(Math.max(op.browserSessions.length, op.browserPlans.length)),
      detail: "Controlled provider profiles with resumable handoff artifacts.",
      status: op.browserSessions.length || op.browserPlans.length ? "ready" : "planned",
    },
    {
      label: "Secure checkpoints",
      value: String(credentialGates + paymentGates + secureSessions),
      detail: "Vault/provider/payment UI for secrets, identity, card/CVV, CAPTCHA, and paid submit.",
      status: credentialGates + paymentGates + secureSessions > 0 ? "approval-required" : "ready",
    },
    {
      label: "No-dead-end policy",
      value: noDeadEndStatus,
      detail: "MCP/API absence must have browser, alternate-provider, or local-helper fallback.",
      status: noDeadEndStatus,
    },
    {
      label: "Provider results",
      value: String(resultReady),
      detail: "Sanitized status returned for later agents without exposing secrets.",
      status: resultReady > 0 ? "ready" : "planned",
    },
    {
      label: "Reusable OS object",
      value: published,
      detail: "This generated app can persist, archive/restore, and become another agent's tool.",
      status: published,
    },
  ];
}

function routeContentHtml(manifest: AgentlasSurfaceManifest, routeKey: string, operations: JsonObject): string {
  const app = manifest.app;
  const collections = collectionsForHtml(operations);
  const trust = isObject(operations.trust) ? operations.trust : {};
  const budget = isObject(trust.budget) ? trust.budget : manifest.budget;
  const evidence = Array.isArray(trust.evidence) ? trust.evidence.filter(isObject) : manifest.evidence ?? [];
  const claims: JsonObject[] = Array.isArray(trust.claims)
    ? trust.claims.filter(isObject)
    : (manifest.claims ?? []).map((claim) => jsonValue(claim));
  if (routeKey.includes("store") || routeKey.includes("front")) {
    return `<section class="hero">
        <div class="hero-copy">
          <span class="pill estimated">launch preview - source gated</span>
          <h2>${html(app?.business?.offer || app?.name || manifest.title)}</h2>
          <p>${html(app?.tagline || app?.valueProp || "Agent-made storefront generated from the surface manifest.")}</p>
          <div class="trust">
            ${evidence.slice(0, 3).map((item) => `<span class="pill ${statusClass(item.kind)}">${html(item.kind || "evidence")} · ${html(item.label || item.source || "source")}</span>`).join("\n            ")}
          </div>
        </div>
        <div class="lookbook">
          ${storefrontMediaHtml(collections.products)}
        </div>
      </section>
      <section class="section">
        <h3>Product Cards</h3>
        <div class="grid">
          ${collections.products.map((row) => productCardHtml(row)).join("\n          ") || emptyStateHtml("No storefront products yet", "The catalog tool will append product rows after sourcing or image generation.")}
        </div>
      </section>`;
  }
  if (routeKey.includes("catalog") || routeKey.includes("product")) {
    return `<section class="section">
        <h2>Catalog Workbench</h2>
        <div class="table">
          ${collections.products.map((row) => catalogRowHtml(row)).join("\n          ") || emptyStateHtml("No catalog rows", "Products are generated from manifest data and preserved through the operations ledger.")}
        </div>
      </section>
      <section class="section">
        <h3>Assets</h3>
        <div class="grid">
          ${collections.assets.map((row) => assetCardHtml(row)).join("\n          ") || emptyStateHtml("No assets materialized", "Image/video generation stays budget-gated until approved.")}
        </div>
      </section>`;
  }
  if (routeKey.includes("order") || routeKey.includes("fulfillment")) {
    return `<section class="section">
        <h2>Order Operations</h2>
        <div class="grid">
          ${collections.orders.map((row) => orderLaneHtml(row)).join("\n          ") || emptyStateHtml("No order lanes", "Orders will be written only after a payment provider and database are connected.")}
        </div>
      </section>
      <section class="section">
        <h3>Event Ledger</h3>
        <div class="table">
          ${collections.events.map((row) => eventRowHtml(row)).join("\n          ") || emptyStateHtml("No events", "App actions append resumable events here.")}
        </div>
      </section>`;
  }
  if (routeKey.includes("finance") || routeKey.includes("payment") || routeKey.includes("payout")) {
    return `<section class="section">
        <h2>Finance And Approval Gates</h2>
        <div class="grid">
          ${ledgerCardsHtml(operations)}
        </div>
      </section>
      <section class="section">
        <h3>Budget</h3>
        <div class="wide-item">
          <strong>${html(stringValue(budget?.currency) || "USD")} ${html(stringValue(budget?.spent) || "0")} spent / ${html(stringValue(budget?.limit) || "not declared")} limit</strong>
          <span class="pill approval">approval threshold ${html(stringValue(budget?.approvalThreshold) || "n/a")}</span>
        </div>
      </section>
      <section class="section">
        <h3>Claims</h3>
        <div class="grid">
          ${claims.map((claim) => claimCardHtml(claim)).join("\n          ") || emptyStateHtml("No claims declared", "Launch candidates require claim checking before promotion.")}
        </div>
      </section>`;
  }
  return `<section class="section">
      <h2>Operations Route</h2>
      <div class="grid">
        ${collections.metrics.map((row) => metricCardHtml(row)).join("\n        ") || emptyStateHtml("No route metrics", "Metrics appear after the agent writes verified or estimated operating state.")}
      </div>
    </section>
    <section class="section">
      <h3>Provider Tasks</h3>
      <div class="table">
        ${providerTaskRowsHtml(normalizeOperationsForHtml(operations).providerTasks)}
      </div>
    </section>`;
}

function localRuntimeSectionHtml(operations: JsonObject): string {
  const runtime = isObject(operations.localRuntime) ? operations.localRuntime : {};
  if (!runtime.status) return "";
  const database = isObject(runtime.database) ? runtime.database : {};
  const payment = isObject(runtime.payment) ? runtime.payment : {};
  const imageGeneration = isObject(runtime.imageGeneration) ? runtime.imageGeneration : {};
  const hosting = isObject(runtime.hosting) ? runtime.hosting : {};
  const rows = [
    ["Payment", payment.status, payment.provider || payment.checkoutUrl || "Agentlas checkout sandbox"],
    ["Database", database.status, database.path || "local store"],
    ["Images", imageGeneration.status, `${stringValue(imageGeneration.assetCount) || "0"} assets`],
    ["Hosting", hosting.status, "local preview"],
  ];
  return `<section class="section">
        <h3>Local Commerce Stack</h3>
        <div class="grid">
          ${rows.map(([label, status, detail]) => `<div class="ledger"><span class="pill ${statusClass(status)}">${html(status || "pending")}</span><strong>${html(label)}</strong><span class="meta">${html(detail || "")}</span></div>`).join("\n          ")}
        </div>
      </section>`;
}

function storefrontMediaHtml(products: JsonObject[]): string {
  const rows = products.length ? products.slice(0, 3) : [{ name: "Generated product visual", imageStatus: "waiting-for-budget", trust: "estimated" }];
  return rows
    .map((row, index) => {
      const src = assetSrc(row.assetPath || row.path || row.imageUrl);
      return `<div class="media-slot ${src ? "has-image" : ""}" style="min-height:${index === 0 ? 300 : 144}px">${src ? `<img src="${html(src)}" alt="${html(row.name || row.label || "Product visual")}" loading="lazy" />` : ""}<strong>${html(row.name || row.label || "Product visual")}</strong><span>${html(row.imageStatus || row.status || "planned")} · ${html(row.trust || "estimated")}</span></div>`;
    })
    .join("\n          ");
}

function productCardHtml(row: JsonObject): string {
  const src = assetSrc(row.assetPath || row.path || row.imageUrl);
  return `<article class="item">
    ${src ? `<img class="item-image" src="${html(src)}" alt="${html(row.name || row.label || "Product")}" loading="lazy" />` : ""}
    <span class="pill ${statusClass(row.trust || row.status)}">${html(row.trust || row.status || "estimated")}</span>
    <strong>${html(row.name || row.label || "Product")}</strong>
    <span class="meta">Image: ${html(row.imageStatus || "not declared")} · Copy: ${html(row.copyStatus || "not declared")}</span>
  </article>`;
}

function catalogRowHtml(row: JsonObject): string {
  return `<div class="table-row"><strong>${html(row.name || row.label || "Product")}</strong><span>${html(row.imageStatus || row.status || "planned")}</span><span class="pill ${statusClass(row.trust)}">${html(row.trust || "estimated")}</span></div>`;
}

function assetCardHtml(row: JsonObject): string {
  const src = assetSrc(row.path || row.assetPath || row.url);
  return `<div class="item">${src ? `<img class="item-image" src="${html(src)}" alt="${html(row.name || row.label || row.path || "Asset")}" loading="lazy" />` : ""}<strong>${html(row.name || row.label || row.path || "Asset")}</strong><span class="meta">${html(row.status || row.kind || "planned")}</span><span class="pill ${statusClass(row.trust)}">${html(row.trust || "estimated")}</span></div>`;
}

function orderLaneHtml(row: JsonObject): string {
  return `<div class="item"><span class="pill ${statusClass(row.status)}">${html(row.status || "planned")}</span><strong>${html(row.lane || row.name || row.label || "Order lane")}</strong><span class="meta">${html(row.trust || "estimated")} state from operations ledger</span></div>`;
}

function eventRowHtml(row: JsonObject): string {
  return `<div class="table-row"><strong>${html(row.summary || row.type || "Event")}</strong><span>${html(row.actor || "agentlas")}</span><span class="meta">${html(row.at || "")}</span></div>`;
}

function metricCardHtml(row: JsonObject): string {
  return `<div class="item"><strong>${html(row.label || row.name || "Metric")}</strong><span class="meta">${html(row.value || row.status || "pending")}</span><span class="pill ${statusClass(row.trust)}">${html(row.trust || "estimated")}</span></div>`;
}

function ledgerCardsHtml(operations: JsonObject): string {
  const ledgers = isObject(operations.ledgers) ? operations.ledgers : {};
  const rows = [
    ...ledgerItems("Payment", ledgers.payments),
    ...ledgerItems("Database", ledgers.databases),
    ...ledgerItems("Generation", ledgers.imageGeneration),
  ];
  return rows.map((row) => `<div class="ledger"><span class="pill ${statusClass(row.status)}">${html(row.status)}</span><strong>${html(row.provider)}</strong><code>${html(row.mode)}</code><span class="meta">${html(row.group)} · ${html(row.evidenceKind || "estimated")}</span></div>`).join("\n          ") || emptyStateHtml("No finance ledger", "Payment, database, and generation ledgers are created from declared connectors.");
}

function ledgerItems(group: string, value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(isObject).map((row) => ({
        ...row,
        group,
        provider: row.provider || group,
        status: row.status || "pending",
        mode: row.mode || "agentlas-gated",
      }))
    : [];
}

function claimCardHtml(claim: JsonObject): string {
  return `<div class="item"><span class="pill ${statusClass(claim.kind || claim.status)}">${html(claim.kind || claim.status || "claim")}</span><strong>${html(claim.text || claim.id || "Claim")}</strong><span class="meta">${html(claim.status || "needs-review")}</span></div>`;
}

function emptyStateHtml(title: string, detail: string): string {
  return `<div class="item"><strong>${html(title)}</strong><span class="meta">${html(detail)}</span></div>`;
}

function assetSrc(value: unknown): string | undefined {
  const raw = stringValue(value)?.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/(?:Users|Volumes|tmp|private\/tmp)\//.test(raw) && /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(raw)) {
    return pathToFileURL(raw).href;
  }
  const clean = raw.replace(/^\/+/, "");
  if (!/^[a-z0-9._/-]+$/i.test(clean) || clean.includes("..")) return undefined;
  return `/${clean}`;
}

function productRowsHtml(products: JsonObject[], labels: ReturnType<typeof appUiLabels> = appUiLabels()): string {
  return products.map((row) => `<div class="row"><strong>${html(row.caption || row.scene || row.name || row.label || row.title || row.id || labels.itemFallback)}</strong><span class="pill ${statusClass(row.status || row.trust)}">${html(row.status || row.trust || "planned")}</span></div>`).join("\n          ") || `<div class="card"><strong>${html(labels.emptyTitle)}</strong><small>${html(labels.emptyDetail)}</small></div>`;
}

function localPreviewUrl(manifest: AgentlasSurfaceManifest, operations: JsonObject): string | null {
  const runtime = isObject(operations.localRuntime) ? operations.localRuntime : {};
  const url = stringValue(runtime.previewUrl) || stringValue(manifest.app?.deployment?.previewUrl);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function storyboardLabels(): ReturnType<typeof appUiLabels> {
  return {
    primaryCollection: "assets",
    metricLabel: "storyboard shots",
    primaryHeading: "Storyboard",
    itemFallback: "Shot",
    emptyTitle: "No storyboard shots declared",
    emptyDetail: "The generated app should write shot rows before it is considered ready.",
  };
}

function appUiLabels(manifest?: AgentlasSurfaceManifest): {
  primaryCollection: "products" | "assets";
  metricLabel: string;
  primaryHeading: string;
  itemFallback: string;
  emptyTitle: string;
  emptyDetail: string;
} {
  if (manifest?.domain === "creative" || manifest?.layout === "creative-studio") {
    return {
      primaryCollection: "assets",
      metricLabel: "creative assets",
      primaryHeading: "Creative Assets",
      itemFallback: "Asset",
      emptyTitle: "No creative assets declared",
      emptyDetail: "Agent will append generated or imported media through the operations ledger.",
    };
  }
  return {
    primaryCollection: "products",
    metricLabel: "catalog items",
    primaryHeading: "Product Catalog",
    itemFallback: "Product",
    emptyTitle: "No products declared",
    emptyDetail: "Agent will append catalog rows through the operations ledger.",
  };
}

function providerTaskRowsHtml(tasks: JsonObject[]): string {
  return tasks.map((task) => `<div class="row"><strong>${html(task.label)}</strong><span class="pill ${statusClass(task.status)}">${html(task.status)}</span></div>`).join("\n          ") || `<div class="card"><strong>No provider tasks declared</strong><small>Connectors can still be added by later surface updates.</small></div>`;
}

function connectorRowsHtml(connectors: Array<JsonObject | AgentlasSurfaceConnectorSpec>): string {
  return connectors.map((c) => `<div class="connector"><span class="badge">${html(String(c.type || "mcp").slice(0, 3).toUpperCase())}</span><strong>${html(c.name)}</strong><span class="status">${html(c.status || "proposed")}</span></div>`).join("\n        ");
}

function capabilityRowsHtml(capabilities: JsonObject[]): string {
  return capabilities.map((capability) => `<div class="micro-card"><strong>${html(capability.id || capability.type || "Capability")}</strong><small>${html(capability.type || "capability")} · ${html(capability.approval || "approval")} · ${html(capability.status || "declared")}</small>${capability.scope ? `<code>${html(capability.scope)}</code>` : ""}</div>`).join("\n          ") || `<div class="micro-card"><strong>No capability manifest yet</strong><small>Generated apps should declare network, filesystem, PII, payment, and generation capabilities before live operation.</small></div>`;
}

function browserPlanRowsHtml(plans: JsonObject[]): string {
  return plans.map((plan) => `<div class="micro-card"><strong>${html(plan.connectorName || plan.connectorId || "Provider")}</strong><small>${html(plan.startUrl || "")}</small>${plan.envKey ? `<code>${html(plan.envKey)}</code>` : ""}</div>`).join("\n          ") || `<div class="micro-card"><strong>No browser start plan yet</strong><small>Run provider tasks to create resumable provider starts.</small></div>`;
}

function providerRecipeRowsHtml(recipes: JsonObject[]): string {
  return recipes.map((recipe) => `<div class="micro-card"><strong>${html(recipe.connectorName || recipe.connectorId || "Provider recipe")}</strong><small>${html(recipe.status || "planned")} · ${html(recipe.mode || "api-or-browser")}</small>${Array.isArray(recipe.requiredEnvKeys) && recipe.requiredEnvKeys.length ? `<code>${html(recipe.requiredEnvKeys.join(", "))}</code>` : ""}${recipe.localFallback ? `<small>${html(recipe.localFallback)}</small>` : ""}</div>`).join("\n          ") || `<div class="micro-card"><strong>No provider recipes yet</strong><small>Run provider tasks to compile API/browser execution recipes.</small></div>`;
}

function noDeadEndRowsHtml(strategy: JsonObject): string {
  const plans = Array.isArray(strategy.plans) ? strategy.plans.filter(isObject) : [];
  if (!plans.length) {
    return `<div class="micro-card"><strong>No no-dead-end strategy yet</strong><small>Run provider tasks to compile MCP/API, browser, alternate-provider, and local-helper fallbacks.</small></div>`;
  }
  const violations = Array.isArray(strategy.violations) ? strategy.violations.filter((item): item is string => typeof item === "string") : [];
  const rows = plans.map((plan) => `<div class="micro-card"><strong>${html(plan.connectorName || plan.connectorId || "Provider")}</strong><small>${html(plan.status || "recoverable")} · ${html(plan.currentBestPath || "fallback-ladder")}</small>${plan.localFallback ? `<small>${html(plan.localFallback)}</small>` : ""}${Array.isArray(plan.fallbackProviders) && plan.fallbackProviders.length ? `<code>${html(plan.fallbackProviders.join(", "))}</code>` : ""}</div>`).join("\n          ");
  return `${rows}${violations.length ? `<div class="micro-card"><strong>Contract violations</strong><small>${html(violations.join("; "))}</small></div>` : ""}`;
}

function providerSessionRowsHtml(sessions: JsonObject[]): string {
  return sessions.map((session) => `<div class="micro-card"><strong>${html(session.connectorName || session.connectorId || "Provider")}</strong><small>${html(session.status || "planned")} · ${html(session.blockerKind || "none")}${session.nextAction ? ` · next: ${html(session.nextAction)}` : ""}${session.resultStatus ? ` · result: ${html(session.resultStatus)}` : ""}</small>${session.resultSummary ? `<small>${html(session.resultSummary)}</small>` : ""}${codeRefHtml("Launch", session.resumeCommand || session.resumeLauncherPath)}${codeRefHtml("Queue", session.actionQueuePath)}${codeRefHtml("Checkpoint", session.checkpointManifestPath)}${codeRefHtml("Handoff", session.handoffPath)}${codeRefHtml("Result", session.resultPath)}${codeRefHtml("Shot", session.screenshotPath)}</div>`).join("\n          ") || `<div class="micro-card"><strong>No provider session evidence yet</strong><small>Capture browser sessions to prove provider handoff readiness.</small></div>`;
}

function providerLaunchRowsHtml(launches: JsonObject[]): string {
  return launches.map((launch) => `<div class="micro-card"><strong>${html(launch.connectorName || launch.connectorId || "Provider launch")}</strong><small>${html(launch.status || "dry-run")} · ${html(launch.launched ? "browser opened" : "ready")}${launch.resultStatus ? ` · result: ${html(launch.resultStatus)}` : ""}</small>${codeRefHtml("Launch", launch.launcherPath)}${codeRefHtml("Queue", launch.actionQueuePath)}${codeRefHtml("Result", launch.resultPath)}</div>`).join("\n          ") || `<div class="micro-card"><strong>No provider launch yet</strong><small>Resume a provider session from Agentlas to create launch evidence.</small></div>`;
}

function credentialGateRowsHtml(gates: JsonObject[]): string {
  return gates.map((gate) => `<div class="micro-card"><strong>${html(gate.label || gate.envKey || "Credential")}</strong><code>${html(gate.envKey || "ENV_KEY")}</code><small>${html(gate.inputMode || "agentlas-vault")}</small></div>`).join("\n          ") || `<div class="micro-card"><strong>No vault keys yet</strong><small>Credential gates are generated from connector auth.</small></div>`;
}

function credentialResolutionRowsHtml(items: JsonObject[]): string {
  return items.map((item) => `<div class="micro-card"><strong>${html(item.label || item.envKey || "Credential")}</strong><small>${html(item.status || "secure-input-required")}</small>${item.fingerprint ? `<code>${html(item.fingerprint)}</code>` : ""}</div>`).join("\n          ") || `<div class="micro-card"><strong>No credential resolution yet</strong><small>Resolve vault/env credentials after provider signup or API key creation.</small></div>`;
}

function lifecycleRowsHtml(lifecycle: JsonObject): string {
  const status = stringValue(lifecycle.status) || "scaffolded";
  const summary = stringValue(lifecycle.summary) || "Generated app remains reversible.";
  const archivePath = stringValue(lifecycle.archivePath);
  return `<div class="micro-card"><strong>${html(status)}</strong><small>${html(summary)}</small><code>${html(lifecycle.reversible === false ? "not reversible" : "reversible archive/restore")}</code>${codeRefHtml("Archive", archivePath)}</div>`;
}

function reusableToolRowsHtml(reuse: JsonObject): string {
  const status = stringValue(reuse.status);
  if (!status) {
    return `<div class="micro-card"><strong>Not published yet</strong><small>Publish this app as a reusable local MCP tool for other agents.</small></div>`;
  }
  return `<div class="micro-card"><strong>${html(stringValue(reuse.toolName) || "Reusable app tool")}</strong><small>${html(stringValue(reuse.summary) || status)}</small>${reuse.mcpServerId ? `<code>${html(reuse.mcpServerId)}</code>` : ""}${codeRefHtml("MCP", reuse.mcpPath)}</div>`;
}

function codeRefHtml(label: string, value: unknown): string {
  const raw = stringValue(value);
  if (!raw) return "";
  return `<code title="${html(raw)}">${html(label)}: ${html(shortPathLabel(raw))}</code>`;
}

function shortPathLabel(value: string): string {
  const quoted = value.match(/"([^"]+)"/)?.[1];
  const clean = (quoted || value).replace(/^node\s+/, "").trim();
  return path.basename(clean) || clean.slice(0, 80);
}

function normalizeOperationsForHtml(operations: JsonObject): {
  connectors: JsonObject[];
  providerTasks: JsonObject[];
  products: JsonObject[];
  assets: JsonObject[];
  jobs: JsonObject[];
  capabilities: JsonObject[];
  browserPlans: JsonObject[];
  providerRecipes: JsonObject[];
  noDeadEndStrategy: JsonObject;
  browserSessions: JsonObject[];
  browserLaunches: JsonObject[];
  credentialGates: JsonObject[];
  credentialResolution: JsonObject[];
  lifecycle: JsonObject;
  reuse: JsonObject;
} {
  const collections = isObject(operations.collections) ? operations.collections : {};
  const trust = isObject(operations.trust) ? operations.trust : {};
  const providerRuntime = isObject(operations.providerRuntime) ? operations.providerRuntime : {};
  return {
    connectors: Array.isArray(operations.connectors) ? operations.connectors.filter(isObject) : [],
    providerTasks: Array.isArray(operations.providerTasks) ? operations.providerTasks.filter(isObject) : [],
    products: Array.isArray(collections.products) ? collections.products.filter(isObject) : [],
    assets: Array.isArray(collections.assets) ? collections.assets.filter(isObject) : [],
    jobs: Array.isArray(trust.jobs) ? trust.jobs.filter(isObject) : [],
    capabilities: Array.isArray((isObject(operations.capabilityManifest) ? operations.capabilityManifest : {}).capabilities)
      ? ((operations.capabilityManifest as JsonObject).capabilities as unknown[]).filter(isObject)
      : Array.isArray(trust.capabilities) ? trust.capabilities.filter(isObject) : [],
    browserPlans: Array.isArray(providerRuntime.browserPlans) ? providerRuntime.browserPlans.filter(isObject) : [],
    providerRecipes: Array.isArray(providerRuntime.providerRecipes) ? providerRuntime.providerRecipes.filter(isObject) : [],
    noDeadEndStrategy: isObject(providerRuntime.noDeadEndStrategy) ? providerRuntime.noDeadEndStrategy : {},
    browserSessions: Array.isArray(providerRuntime.browserSessions) ? providerRuntime.browserSessions.filter(isObject) : [],
    browserLaunches: Array.isArray(providerRuntime.browserLaunches) ? providerRuntime.browserLaunches.filter(isObject) : [],
    credentialGates: Array.isArray(providerRuntime.credentialGates) ? providerRuntime.credentialGates.filter(isObject) : [],
    credentialResolution: Array.isArray(providerRuntime.credentialResolution) ? providerRuntime.credentialResolution.filter(isObject) : [],
    lifecycle: isObject(operations.lifecycle) ? operations.lifecycle : {},
    reuse: isObject(operations.reuse) ? operations.reuse : {},
  };
}

function collectionsForHtml(operations: JsonObject): {
  products: JsonObject[];
  orders: JsonObject[];
  metrics: JsonObject[];
  assets: JsonObject[];
  events: JsonObject[];
} {
  const collections = isObject(operations.collections) ? operations.collections : {};
  return {
    products: Array.isArray(collections.products) ? collections.products.filter(isObject) : [],
    orders: Array.isArray(collections.orders) ? collections.orders.filter(isObject) : [],
    metrics: Array.isArray(collections.metrics) ? collections.metrics.filter(isObject) : [],
    assets: Array.isArray(collections.assets) ? collections.assets.filter(isObject) : [],
    events: Array.isArray(collections.events) ? collections.events.filter(isObject) : [],
  };
}

function statusClass(value: unknown): string {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("ready") || raw.includes("verified") || raw.includes("pass") || raw.includes("connected") || raw.includes("active") || raw.includes("materialized") || raw.includes("recoverable") || raw.includes("published")) return "ready";
  if (raw.includes("approval") || raw.includes("queued") || raw.includes("missing") || raw.includes("required")) return "approval";
  if (raw.includes("fail") || raw.includes("risk") || raw.includes("blocked")) return "risk";
  return "";
}

function generatedWorkbenchSplitScript(): string {
  return `(() => {
  const split = document.querySelector('[data-resizable-split="generated-workbench"]');
  if (!split) return;
  const handle = split.querySelector('.workbench-resizer');
  if (!handle) return;
  const storageKey = 'agentlas.generated-workbench.left';
  const minLeft = 280;
  const minRight = 320;
  const handleWidth = 6;
  let left = 0;
  try {
    const saved = Number.parseInt(localStorage.getItem(storageKey) || '', 10);
    if (Number.isFinite(saved)) left = saved;
  } catch {}
  const apply = () => {
    if (window.matchMedia('(max-width: 1180px)').matches) {
      split.style.gridTemplateColumns = '';
      return;
    }
    const total = split.clientWidth || 1000;
    if (!left) left = Math.max(minLeft, Math.round(total * 0.62));
    const maxLeft = Math.max(minLeft, total - minRight - handleWidth);
    left = Math.max(minLeft, Math.min(maxLeft, left));
    split.style.gridTemplateColumns = left + 'px ' + handleWidth + 'px minmax(' + minRight + 'px, 1fr)';
  };
  apply();
  window.addEventListener('resize', apply);
  handle.addEventListener('pointerdown', (event) => {
    const startX = event.clientX;
    const startLeft = left || Math.round((split.clientWidth || 1000) * 0.62);
    handle.classList.add('active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent) => {
      left = startLeft + moveEvent.clientX - startX;
      apply();
    };
    const up = () => {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(storageKey, String(left)); } catch {}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    event.preventDefault();
  });
})();`;
}

function operationsHydrationScript(): string {
  return `const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const cls = (value) => {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("ready") || raw.includes("verified") || raw.includes("pass") || raw.includes("connected") || raw.includes("active") || raw.includes("materialized") || raw.includes("recoverable") || raw.includes("published")) return "ready";
  if (raw.includes("approval") || raw.includes("queued") || raw.includes("missing") || raw.includes("required")) return "approval";
  if (raw.includes("fail") || raw.includes("risk") || raw.includes("blocked")) return "risk";
  return "";
};
const setStat = (name, value) => {
  const node = document.querySelector('[data-stat="' + name + '"]');
  if (node) node.textContent = String(value ?? 0);
};
const fileLabel = (value) => {
  const raw = String(value ?? "").trim();
  const quoted = raw.match(/"([^"]+)"/)?.[1];
  const clean = String(quoted || raw).replace(/^node\\s+/, "").trim();
  return clean.split(/[\\\\/]/).filter(Boolean).pop() || clean.slice(0, 80);
};
const codeRef = (label, value) => value ? '<code title="' + esc(value) + '">' + esc(label + ': ' + fileLabel(value)) + '</code>' : '';
const row = (label, status) => '<div class="row"><strong>' + esc(label) + '</strong><span class="pill ' + cls(status) + '">' + esc(status || "planned") + '</span></div>';
const connector = (item) => '<div class="connector"><span class="badge">' + esc(String(item.type || "mcp").slice(0, 3).toUpperCase()) + '</span><strong>' + esc(item.name || item.id || "Connector") + '</strong><span class="status">' + esc(item.status || "proposed") + '</span></div>';
const capability = (item) => '<div class="micro-card"><strong>' + esc(item.id || item.type || "Capability") + '</strong><small>' + esc(item.type || "capability") + ' · ' + esc(item.approval || "approval") + ' · ' + esc(item.status || "declared") + '</small>' + (item.scope ? '<code>' + esc(item.scope) + '</code>' : '') + '</div>';
const browserPlan = (item) => '<div class="micro-card"><strong>' + esc(item.connectorName || item.connectorId || "Provider") + '</strong><small>' + esc(item.startUrl || "") + '</small>' + (item.envKey ? '<code>' + esc(item.envKey) + '</code>' : '') + '</div>';
const providerRecipe = (item) => '<div class="micro-card"><strong>' + esc(item.connectorName || item.connectorId || "Provider recipe") + '</strong><small>' + esc(item.status || "planned") + ' · ' + esc(item.mode || "api-or-browser") + '</small>' + (Array.isArray(item.requiredEnvKeys) && item.requiredEnvKeys.length ? '<code>' + esc(item.requiredEnvKeys.join(", ")) + '</code>' : '') + (item.localFallback ? '<small>' + esc(item.localFallback) + '</small>' : '') + '</div>';
const noDeadEndPlan = (item) => '<div class="micro-card"><strong>' + esc(item.connectorName || item.connectorId || "Provider") + '</strong><small>' + esc(item.status || "recoverable") + ' · ' + esc(item.currentBestPath || "fallback-ladder") + '</small>' + (item.localFallback ? '<small>' + esc(item.localFallback) + '</small>' : '') + (Array.isArray(item.fallbackProviders) && item.fallbackProviders.length ? '<code>' + esc(item.fallbackProviders.join(", ")) + '</code>' : '') + '</div>';
const providerSession = (item) => '<div class="micro-card"><strong>' + esc(item.connectorName || item.connectorId || "Provider") + '</strong><small>' + esc(item.status || "planned") + ' · ' + esc(item.blockerKind || "none") + (item.nextAction ? ' · next: ' + esc(item.nextAction) : '') + (item.resultStatus ? ' · result: ' + esc(item.resultStatus) : '') + '</small>' + (item.resultSummary ? '<small>' + esc(item.resultSummary) + '</small>' : '') + codeRef("Launch", item.resumeCommand || item.resumeLauncherPath) + codeRef("Queue", item.actionQueuePath) + codeRef("Handoff", item.handoffPath) + codeRef("Result", item.resultPath) + codeRef("Shot", item.screenshotPath) + '</div>';
const providerLaunch = (item) => '<div class="micro-card"><strong>' + esc(item.connectorName || item.connectorId || "Provider launch") + '</strong><small>' + esc(item.status || "dry-run") + ' · ' + esc(item.launched ? "browser opened" : "ready") + (item.resultStatus ? ' · result: ' + esc(item.resultStatus) : '') + '</small>' + codeRef("Launch", item.launcherPath) + codeRef("Queue", item.actionQueuePath) + codeRef("Result", item.resultPath) + '</div>';
const credentialGate = (item) => '<div class="micro-card"><strong>' + esc(item.label || item.envKey || "Credential") + '</strong><code>' + esc(item.envKey || "ENV_KEY") + '</code><small>' + esc(item.inputMode || "agentlas-vault") + '</small></div>';
const credentialResolution = (item) => '<div class="micro-card"><strong>' + esc(item.label || item.envKey || "Credential") + '</strong><small>' + esc(item.status || "secure-input-required") + '</small>' + (item.fingerprint ? '<code>' + esc(item.fingerprint) + '</code>' : '') + '</div>';
const lifecycleCard = (item) => '<div class="micro-card"><strong>' + esc(item.status || "scaffolded") + '</strong><small>' + esc(item.summary || "Generated app remains reversible.") + '</small><code>' + esc(item.reversible === false ? "not reversible" : "reversible archive/restore") + '</code>' + codeRef("Archive", item.archivePath) + '</div>';
const reusableTool = (item) => item && item.status ? '<div class="micro-card"><strong>' + esc(item.toolName || "Reusable app tool") + '</strong><small>' + esc(item.summary || item.status) + '</small>' + (item.mcpServerId ? '<code>' + esc(item.mcpServerId) + '</code>' : '') + codeRef("MCP", item.mcpPath) + '</div>' : '<div class="micro-card"><strong>Not published yet</strong><small>Publish this app as a reusable local MCP tool for other agents.</small></div>';
const operatorRows = ({ connectors, tasks, browserPlans, browserSessions, credentialGates, noDeadEndStrategy, reuse, lifecycle }) => {
  const paymentGates = tasks.filter((item) => item.type === "request-payment-approval").length;
  const credentialCount = credentialGates.length || tasks.filter((item) => item.type === "request-credential").length;
  const secureSessions = browserSessions.filter((item) => /checkpoint|required|login|signup|payment|captcha/i.test(String(item.status || "") + " " + String(item.blockerKind || ""))).length;
  const noDeadEndStatus = noDeadEndStrategy.status || (connectors.length ? "planned" : "not-needed");
  const resultReady = browserSessions.filter((item) => item.agentCanContinue === true || item.resultStatus).length;
  const published = reuse.status || lifecycle.status || "scaffolded";
  return [
    { label: "External services", value: connectors.length, detail: connectors.length ? "Declared provider surfaces the agent can operate." : "No external provider declared yet.", status: connectors.length ? "ready" : "planned" },
    { label: "Browser delegation", value: Math.max(browserSessions.length, browserPlans.length), detail: "Controlled provider profiles with resumable handoff artifacts.", status: browserSessions.length || browserPlans.length ? "ready" : "planned" },
    { label: "Secure checkpoints", value: credentialCount + paymentGates + secureSessions, detail: "Vault/provider/payment UI for secrets, identity, card/CVV, CAPTCHA, and paid submit.", status: credentialCount + paymentGates + secureSessions > 0 ? "approval-required" : "ready" },
    { label: "No-dead-end policy", value: noDeadEndStatus, detail: "MCP/API absence must have browser, alternate-provider, or local-helper fallback.", status: noDeadEndStatus },
    { label: "Provider results", value: resultReady, detail: "Sanitized status returned for later agents without exposing secrets.", status: resultReady > 0 ? "ready" : "planned" },
    { label: "Reusable OS object", value: published, detail: "This generated app can persist, archive/restore, and become another agent's tool.", status: published }
  ];
};
const operatorConsole = (input) => '<div class="operator-grid">' + operatorRows(input).map((item) => '<div class="operator-card"><span class="pill ' + cls(item.status) + '">' + esc(item.status) + '</span><strong>' + esc(item.value) + '</strong><small>' + esc(item.label) + '</small><small>' + esc(item.detail) + '</small></div>').join("") + '</div><div class="operator-policy"><div class="micro-card"><strong>Agent-first external-service operation</strong><small>Missing API/MCP paths become controlled browser delegation, alternate provider, generated local helper, or local fallback.</small></div><div class="micro-card"><strong>Secure input concierge</strong><small>The user may provide account, credential, identity, or payment details through Agentlas vault, provider pages, or tokenized payment UI; only fingerprints, approvals, and receipts return to app ledgers.</small></div></div>';
async function refreshOperations() {
  try {
    const res = await fetch("./data/operations.json", { cache: "no-store" });
    if (!res.ok) return;
    const db = await res.json();
    const collections = db.collections || {};
    const trust = db.trust || {};
    const providerRuntime = db.providerRuntime || {};
    const products = Array.isArray(collections.products) ? collections.products : [];
    const assets = Array.isArray(collections.assets) ? collections.assets : [];
    const isCreative = db.domain === "creative";
    const primaryItems = isCreative ? assets : products;
    const emptyTitle = isCreative ? "No creative assets declared" : "No products declared";
    const emptyDetail = isCreative ? "Agent will append generated or imported media through the operations ledger." : "Agent will append catalog rows through the operations ledger.";
    const fallbackLabel = isCreative ? "Asset" : "Product";
    const tasks = Array.isArray(db.providerTasks) ? db.providerTasks : [];
    const connectors = Array.isArray(db.connectors) ? db.connectors : [];
    const capabilities = Array.isArray(db.capabilityManifest?.capabilities) ? db.capabilityManifest.capabilities : (Array.isArray(trust.capabilities) ? trust.capabilities : []);
    const jobs = Array.isArray(trust.jobs) ? trust.jobs : [];
    const browserPlans = Array.isArray(providerRuntime.browserPlans) ? providerRuntime.browserPlans : [];
    const providerRecipes = Array.isArray(providerRuntime.providerRecipes) ? providerRuntime.providerRecipes : [];
    const noDeadEndStrategy = providerRuntime.noDeadEndStrategy && typeof providerRuntime.noDeadEndStrategy === "object" ? providerRuntime.noDeadEndStrategy : {};
    const noDeadEndPlans = Array.isArray(noDeadEndStrategy.plans) ? noDeadEndStrategy.plans : [];
    const noDeadEndViolations = Array.isArray(noDeadEndStrategy.violations) ? noDeadEndStrategy.violations : [];
    const browserSessions = Array.isArray(providerRuntime.browserSessions) ? providerRuntime.browserSessions : [];
    const browserLaunches = Array.isArray(providerRuntime.browserLaunches) ? providerRuntime.browserLaunches : [];
    const credentialGates = Array.isArray(providerRuntime.credentialGates) ? providerRuntime.credentialGates : [];
    const credentialResolutions = Array.isArray(providerRuntime.credentialResolution) ? providerRuntime.credentialResolution : [];
    const lifecycle = db.lifecycle || {};
    const reuse = db.reuse || {};
    setStat("products", primaryItems.length);
    setStat("providerTasks", tasks.length);
    setStat("connectors", connectors.length);
    setStat("jobs", jobs.length);
    const productList = document.querySelector('[data-list="products"]');
    if (productList) productList.innerHTML = primaryItems.length ? primaryItems.map((item) => row(item.name || item.label || item.title || item.id || fallbackLabel, item.status || item.trust || "planned")).join("") : '<div class="card"><strong>' + esc(emptyTitle) + '</strong><small>' + esc(emptyDetail) + '</small></div>';
    const taskList = document.querySelector('[data-list="providerTasks"]');
    if (taskList) taskList.innerHTML = tasks.length ? tasks.map((item) => row(item.label || item.id || "Task", item.status || "waiting")).join("") : '<div class="card"><strong>No provider tasks declared</strong><small>Connectors can still be added by later surface updates.</small></div>';
    const connectorList = document.querySelector('[data-list="connectors"]');
    if (connectorList) connectorList.innerHTML = connectors.map(connector).join("");
    const capabilityList = document.querySelector('[data-list="capabilities"]');
    if (capabilityList) capabilityList.innerHTML = capabilities.length ? capabilities.map(capability).join("") : '<div class="micro-card"><strong>No capability manifest yet</strong><small>Generated apps should declare network, filesystem, PII, payment, and generation capabilities before live operation.</small></div>';
    const browserList = document.querySelector('[data-list="browserPlans"]');
    if (browserList) browserList.innerHTML = browserPlans.length ? browserPlans.map(browserPlan).join("") : '<div class="micro-card"><strong>No browser start plan yet</strong><small>Run provider tasks to create resumable provider starts.</small></div>';
    const providerRecipeList = document.querySelector('[data-list="providerRecipes"]');
    if (providerRecipeList) providerRecipeList.innerHTML = providerRecipes.length ? providerRecipes.map(providerRecipe).join("") : '<div class="micro-card"><strong>No provider recipes yet</strong><small>Run provider tasks to compile API/browser execution recipes.</small></div>';
    const noDeadEndList = document.querySelector('[data-list="noDeadEndStrategy"]');
    if (noDeadEndList) noDeadEndList.innerHTML = noDeadEndPlans.length ? noDeadEndPlans.map(noDeadEndPlan).join("") + (noDeadEndViolations.length ? '<div class="micro-card"><strong>Contract violations</strong><small>' + esc(noDeadEndViolations.join("; ")) + '</small></div>' : '') : '<div class="micro-card"><strong>No no-dead-end strategy yet</strong><small>Run provider tasks to compile MCP/API, browser, alternate-provider, and local-helper fallbacks.</small></div>';
    const operatorLists = document.querySelectorAll('[data-list="operatorConsole"]');
    operatorLists.forEach((node) => { node.innerHTML = operatorConsole({ connectors, tasks, browserPlans, browserSessions, credentialGates, noDeadEndStrategy, reuse, lifecycle }); });
    const browserSessionList = document.querySelector('[data-list="browserSessions"]');
    if (browserSessionList) browserSessionList.innerHTML = browserSessions.length ? browserSessions.map(providerSession).join("") : '<div class="micro-card"><strong>No provider session evidence yet</strong><small>Capture browser sessions to prove provider handoff readiness.</small></div>';
    const browserLaunchList = document.querySelector('[data-list="browserLaunches"]');
    if (browserLaunchList) browserLaunchList.innerHTML = browserLaunches.length ? browserLaunches.map(providerLaunch).join("") : '<div class="micro-card"><strong>No provider launch yet</strong><small>Resume a provider session from Agentlas to create launch evidence.</small></div>';
    const credentialList = document.querySelector('[data-list="credentialGates"]');
    if (credentialList) credentialList.innerHTML = credentialGates.length ? credentialGates.map(credentialGate).join("") : '<div class="micro-card"><strong>No vault keys yet</strong><small>Credential gates are generated from connector auth.</small></div>';
    const credentialResolutionList = document.querySelector('[data-list="credentialResolution"]');
    if (credentialResolutionList) credentialResolutionList.innerHTML = credentialResolutions.length ? credentialResolutions.map(credentialResolution).join("") : '<div class="micro-card"><strong>No credential resolution yet</strong><small>Resolve vault/env credentials after provider signup or API key creation.</small></div>';
    const lifecycleList = document.querySelector('[data-list="lifecycle"]');
    if (lifecycleList) lifecycleList.innerHTML = lifecycleCard(lifecycle);
    const reusableToolList = document.querySelector('[data-list="reusableTool"]');
    if (reusableToolList) reusableToolList.innerHTML = reusableTool(reuse);
  } catch {
    // The generated app still works as a static preview if opened without the local server.
  }
}
refreshOperations();`;
}

function commerceStoreScript(): string {
  return `#!/usr/bin/env node
// Generated by Agentlas App Factory.
// Local operations ledger helper. It never calls external providers and never
// stores raw secrets; provider credentials belong in Agentlas vault.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = path.join(root, "data", "operations.json");
const command = process.argv[2] || "status";

async function readDb() {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function writeDb(db) {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2) + "\\n", "utf8");
  await fs.mkdir(path.join(root, "src", "data"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "data", "operations.json"), JSON.stringify(db, null, 2) + "\\n", "utf8");
}

const db = await readDb();

if (command === "status") {
  console.log(JSON.stringify({
    appName: db.appName,
    connectors: db.connectors?.length || 0,
    providerTasks: db.providerTasks?.length || 0,
    products: db.collections?.products?.length || 0,
    orders: db.collections?.orders?.length || 0,
    paymentStatus: db.ledgers?.payments?.map((item) => item.status) || [],
    databaseStatus: db.ledgers?.databases?.map((item) => item.status) || [],
    imageStatus: db.ledgers?.imageGeneration?.map((item) => item.status) || []
  }, null, 2));
} else if (command === "append-event") {
  const summary = process.argv.slice(3).join(" ").trim();
  if (!summary) throw new Error("append-event requires a summary.");
  db.collections = db.collections || {};
  db.collections.events = Array.isArray(db.collections.events) ? db.collections.events : [];
  db.collections.events.push({ at: new Date().toISOString(), actor: "operator", type: "manual-event", summary });
  await writeDb(db);
  console.log("event appended");
} else if (command === "mark-task") {
  const id = process.argv[3];
  const status = process.argv[4];
  if (!id || !status) throw new Error("mark-task requires <taskId> <status>.");
  const task = (db.providerTasks || []).find((item) => item.id === id);
  if (!task) throw new Error("task not found: " + id);
  task.status = status;
  await writeDb(db);
  console.log("task updated");
} else {
  throw new Error("Unknown command: " + command);
}
`;
}

function serveScript(): string {
  return `import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const port = Number(process.env.PORT || 4177);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function isInside(file) {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "/");
  } catch {
    return null;
  }
}

async function resolveTarget(urlPathname) {
  const decoded = safeDecode(urlPathname);
  if (!decoded) return { status: 400 };
  const pathname = decoded === "/" ? "/index.html" : decoded;
  const primary = path.join(root, pathname);
  if (!isInside(primary)) return { status: 403 };
  try {
    const stat = await fs.stat(primary);
    if (stat.isDirectory()) return { target: path.join(primary, "index.html") };
    return { target: primary };
  } catch {
    if (path.extname(primary)) return { target: primary };
    return { target: path.join(primary, "index.html") };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", \`http://localhost:\${port}\`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const resolved = await resolveTarget(url.pathname);
  if (resolved.status === 400) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (resolved.status === 403 || !resolved.target || !isInside(resolved.target)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(resolved.target);
    res.writeHead(200, { "content-type": mime[path.extname(resolved.target)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, () => {
  console.log(\`Preview: http://localhost:\${port}\`);
});
`;
}

function smokeTestScript(appName: string): string {
  return `import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "agentlas.app.json"), "utf8"));
const operations = JSON.parse(await fs.readFile(path.join(root, "data", "operations.json"), "utf8"));
const html = await fs.readFile(path.join(root, "src", "index.html"), "utf8");
const collections = operations.collections && typeof operations.collections === "object" ? operations.collections : {};
const assets = Array.isArray(collections.assets) ? collections.assets : [];
const shotData = manifest.manifest?.data?.shots;
const shots = shotData && typeof shotData === "object" && Array.isArray(shotData.rows) ? shotData.rows : [];
const forbiddenFileChars = /[^a-z0-9._-]+/g;
const slugify = (value) => {
  const slug = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(forbiddenFileChars, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "route";
};
const routeSourcePath = (routePath) => {
  const clean = String(routePath || "/").split("?")[0].split("#")[0].trim();
  if (!clean || clean === "/") return null;
  const segments = clean.replace(/^\\/+/, "").split("/").filter(Boolean).map((segment) => slugify(segment.replace(/^:/, "")));
  return segments.length ? path.join(root, "src", ...segments, "index.html") : null;
};

assert.equal(manifest.manifest.kind, "surface");
assert.ok(manifest.manifest.layout === "service-app" || manifest.manifest.app, "manifest must be service-app or app-backed");
assert.ok(manifest.manifest.app?.name || manifest.manifest.title);
assert.ok(Array.isArray(manifest.routes), "routes must be an array");
assert.ok(Array.isArray(manifest.connectors), "connectors must be an array");
assert.ok(Array.isArray(manifest.tools), "tools must be an array");
assert.equal(operations.schemaVersion, "0.1");
assert.ok(Array.isArray(operations.connectors), "operations.connectors must be an array");
assert.ok(Array.isArray(operations.providerTasks), "operations.providerTasks must be an array");
assert.ok(operations.collections && typeof operations.collections === "object", "operations collections required");
assert.match(html, /data-stat="providerTasks"/, "preview must hydrate provider task status from operations data");
assert.match(html, /data-list="browserPlans"/, "preview must expose provider browser start plan");
assert.match(html, /data-list="providerRecipes"/, "preview must expose provider action recipes");
assert.match(html, /data-list="noDeadEndStrategy"/, "preview must expose no-dead-end provider fallback strategy");
assert.match(html, /data-list="operatorConsole"/, "preview must expose the agent operator console");
assert.match(html, /data-list="browserSessions"/, "preview must expose provider browser session evidence");
assert.match(html, /data-list="credentialResolution"/, "preview must expose credential resolution status");
assert.match(html, /data-list="lifecycle"/, "preview must expose reversible OS object lifecycle");
assert.match(html, /data-list="reusableTool"/, "preview must expose app-as-tool reuse state");
if (shots.length) {
  assert.match(html, /Storyboard/, "preview must render storyboard section when shot rows exist");
  assert.match(html, /shot-card/, "preview must render storyboard shot cards");
}
await fs.access(path.join(root, "src", "index.html"));
await fs.access(path.join(root, "src", "data", "operations.json"));
await fs.access(path.join(root, "src", "runtime", "commerce-store.mjs"));
await fs.access(path.join(root, "SETUP.md"));
await fs.access(path.join(root, "LAUNCH.md"));
for (const route of manifest.routes) {
  const routeFile = routeSourcePath(route.path);
  if (!routeFile) continue;
  const routeHtml = await fs.readFile(routeFile, "utf8");
  assert.match(routeHtml, /Agentlas generated route/, "route page must be generated from manifest routes");
  assert.match(routeHtml, /Runtime State/, "route page must expose generated app runtime state");
  if (assets.length && /store|front|catalog|product/i.test(String(route.path + " " + route.label))) {
    assert.match(routeHtml, /<img\\b/, "asset-backed route page must render materialized images");
  }
}
for (const asset of assets) {
  if (!asset || typeof asset !== "object" || typeof asset.path !== "string") continue;
  if (/^https?:\\/\\//i.test(asset.path)) continue;
  const clean = asset.path.replace(/^\\/+/, "");
  assert.ok(!clean.includes(".."), "asset path must stay inside src");
  await fs.access(path.join(root, "src", clean));
}

console.log(${JSON.stringify(`${appName} smoke passed`)});
`;
}

function scaffoldReport(
  manifest: AgentlasSurfaceManifest,
  routes: AgentlasSurfaceAppRoute[],
  connectors: AgentlasSurfaceConnectorSpec[],
  artifacts: JsonObject[],
  deployment: Record<string, unknown>,
  ctx: { appName: string; appId: string; now: string },
): string {
  return `# Scaffold Report

App: ${md(ctx.appName)}
ID: \`${ctx.appId}\`
Generated: ${ctx.now}

## Manifest

- Domain: ${md(manifest.domain)}
- Layout: ${md(manifest.layout)}
- Readiness: ${md(stringValue(deployment.readiness) || "prototype")}

## Routes

${routes.map((route) => `- \`${route.path}\` ${md(route.label)} - ${md(route.status || "planned")}`).join("\n") || "- None"}

## Connectors

${connectors.map((c) => `- ${md(c.name)} - ${md(c.type)} / ${md(c.status || "proposed")}`).join("\n") || "- None"}

## Declared Artifacts

${artifacts.map((a) => `- ${md(stringValue(a.name) || stringValue(a.path) || "Artifact")} - ${md(stringValue(a.status) || "planned")}`).join("\n") || "- None"}
`;
}

function routesOf(manifest: AgentlasSurfaceManifest): AgentlasSurfaceAppRoute[] {
  const fromApp = manifest.app?.routes ?? [];
  if (fromApp.length) return fromApp.map(normalizeRoute).filter(Boolean);
  return rowsOf(manifest, "routes", "routes").map(normalizeRoute).filter(Boolean);
}

function connectorsOf(manifest: AgentlasSurfaceManifest): AgentlasSurfaceConnectorSpec[] {
  const fromApp = manifest.app?.connectors ?? [];
  if (fromApp.length) return fromApp.map(normalizeConnector).filter(Boolean);
  return rowsOf(manifest, "connectors", "connectors").map(normalizeConnector).filter(Boolean);
}

function toolsOf(manifest: AgentlasSurfaceManifest): AgentlasSurfaceToolSpec[] {
  const fromApp = manifest.app?.tools ?? [];
  if (fromApp.length) return fromApp.map(normalizeTool).filter(Boolean);
  return rowsOf(manifest, "tools", "tools").map(normalizeTool).filter(Boolean);
}

function rowsOf(manifest: AgentlasSurfaceManifest, name: string, type: string): JsonObject[] {
  const direct = manifest.data[name];
  const data = direct ?? Object.values(manifest.data).find((d) => d.type === type);
  if (!data) return [];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function objectData(manifest: AgentlasSurfaceManifest, name: string): JsonObject | undefined {
  const data = manifest.data[name];
  return data?.value && isObject(data.value) ? data.value : undefined;
}

function normalizeRoute(raw: unknown): AgentlasSurfaceAppRoute {
  const row = isObject(raw) ? raw : {};
  return {
    path: stringValue(row.path) || "/",
    label: stringValue(row.label) || stringValue(row.name) || "App",
    purpose: stringValue(row.purpose) || stringValue(row.description),
    status: stringValue(row.status) || "planned",
  };
}

function normalizeConnector(raw: unknown): AgentlasSurfaceConnectorSpec {
  const row = isObject(raw) ? raw : {};
  const name = stringValue(row.name) || "Connector";
  return {
    ...row,
    id: stringValue(row.id) || slugify(name),
    name,
    type: stringValue(row.type) || "mcp",
    purpose: stringValue(row.purpose) || stringValue(row.description),
    auth: stringValue(row.auth) || "user-approval",
    status: stringValue(row.status) || "proposed",
  };
}

function normalizeTool(raw: unknown): AgentlasSurfaceToolSpec {
  const row = isObject(raw) ? raw : {};
  const name = stringValue(row.name) || "Agent Tool";
  return {
    id: stringValue(row.id) || slugify(name),
    name,
    description: stringValue(row.description) || stringValue(row.purpose) || "Agent-made local tool",
    domain: stringValue(row.domain),
    kind: stringValue(row.kind) || "validator",
    inputSchema: isObject(row.inputSchema) ? row.inputSchema : undefined,
    parameters: Array.isArray(row.parameters)
      ? row.parameters.filter(isObject).map((p) => ({
          ...p,
          name: stringValue(p.name) || "input",
          type: stringValue(p.type) || "string",
          required: Boolean(p.required),
        }))
      : undefined,
    outputs: Array.isArray(row.outputs) ? row.outputs.filter(isObject) : undefined,
    examples: Array.isArray(row.examples) ? row.examples.filter(isObject) : undefined,
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonValue(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function envKeyFor(connector: AgentlasSurfaceConnectorSpec): string {
  const base = slugify(connector.id || connector.name).replace(/-/g, "_").toUpperCase();
  if (connector.auth === "oauth") return `${base}_OAUTH_CLIENT`;
  if (connector.auth === "user-approval") return `${base}_USER_APPROVAL`;
  return `${base}_API_KEY`;
}

function routeSourcePath(routePath: string): string | null {
  const clean = String(routePath || "/").split("?")[0].split("#")[0].trim();
  if (!clean || clean === "/") return null;
  const segments = clean
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => slugify(segment.replace(/^:/, "")));
  return segments.length ? `src/${segments.join("/")}/index.html` : null;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(FORBIDDEN_FILE_CHARS, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agentlas-app";
}

function shortId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside scaffold root: ${target}`);
  }
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").trim();
}

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
