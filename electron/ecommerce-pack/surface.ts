import { isPrimarilyKorean, preferredLocaleFromText } from "../../shared/detect-language";
// Business/ecommerce OS seed: vague commerce intent -> declarative service-app.
// This keeps the same Agentlas Surface contract as model-emitted manifests:
// no executable UI code, explicit capabilities, delegation, budget, evidence,
// and reversible app/tool actions.
import type { AgentlasSurfaceManifest, JsonObject } from "../../shared/types";
import {
  AGENTLAS_OS_FALLBACK_LADDER,
  SURFACE_AUTONOMY_ALLOWED_WITHOUT_PROMPT,
  SURFACE_AUTONOMY_CHECKPOINTS,
  SURFACE_AUTONOMY_DESTRUCTIVE_ACTIONS,
  SURFACE_AUTONOMY_NO_DEAD_END_REASONS,
} from "../../shared/surface-delegation";

interface CommerceProfile {
  business: string;
  category: string;
  audience: string;
  region: string;
  tone: string;
}

// 판정기가 고르는 카테고리 열거. "commerce"가 중립 기본값이다 — 판정 불가/미연결이면
// 항상 중립으로 남고, 어떤 단어장도 카테고리를 확정하지 않는다.
export const COMMERCE_CATEGORY_LABELS = ["womens-clothing", "fashion", "beauty", "commerce"] as const;
export type CommerceCategory = (typeof COMMERCE_CATEGORY_LABELS)[number];

export const COMMERCE_CATEGORY_JUDGMENT_KIND = "ecommerce-ops-category";

export type CommerceCategoryJudge = (spec: {
  kind: string;
  question: string;
  labels: readonly CommerceCategory[];
  input: string;
  guidance?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<{ verdict: CommerceCategory | null; source: "llm" | "unavailable"; confidence: number; reason: string }>;

const COMMERCE_TERMS =
  /(shop|store|commerce|ecommerce|e-commerce|mall|boutique|catalog|checkout|payment|orders|inventory|fashion|clothing|apparel|쇼핑몰|커머스|이커머스|스토어|상점|결제|주문|재고|의류|옷|패션|여성복|여자옷)/i;

/**
 * Lexical prefilter — a HINT for the pack-intent judge, never a gate and never
 * a seed source. Contract (unified 2026-08-20): with NO connected model the
 * seed is NEUTRAL — the pack does not appear, regardless of what this matches.
 */
export function shouldSeedEcommerceOps(prompt: string): boolean {
  return COMMERCE_TERMS.test(prompt);
}

export async function prepareEcommerceOpsManifest(input: {
  prompt: string;
  now?: string;
  judgeSubsetFn?: import("../pack-intents").OnePackIntentJudge;
  judgeCategoryFn?: CommerceCategoryJudge;
}): Promise<AgentlasSurfaceManifest | null> {
  // ONE judged pack-intent decision shared with the creative seed (subset cache):
  // "make the font small", "restore my backup" hit the commerce wordlist and used
  // to seed an e-commerce ops surface, while a genuine store request phrased
  // without the listed words could never seed. The prefilter is a hint, not a
  // gate; with NO connected model we do NOT seed from the keyword prefilter — the
  // pack simply does not appear (undecided).
  const { resolveOnePackIntents } = await import("../pack-intents");
  const intents = await resolveOnePackIntents({
    prompt: input.prompt,
    judgeSubsetFn: input.judgeSubsetFn,
  });
  if (intents.source !== "llm" || !intents.selected.includes("ecommerce-ops")) return null;
  return buildEcommerceOpsManifest({
    prompt: input.prompt,
    now: input.now,
    category: await resolveCommerceCategory(input.prompt, input.judgeCategoryFn),
  });
}

/**
 * 2026-08-20: 정규식(inferCommerceProfile)이 사업 카테고리를 확정해 산출물 내용에
 * 쓰던 것을 판정기 경유로 교체. 판정 불가면 null → 중립 "commerce" 프로필.
 */
export async function resolveCommerceCategory(
  prompt: string,
  judgeFn?: CommerceCategoryJudge,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CommerceCategory | null> {
  if (!prompt.trim()) return null;
  try {
    let judge = judgeFn;
    if (!judge) {
      const { judgeRequired } = await import("../system-agents/judgment");
      judge = judgeRequired as unknown as CommerceCategoryJudge;
    }
    const verdict = await judge({
      kind: COMMERCE_CATEGORY_JUDGMENT_KIND,
      question:
        "Which commerce category does this business intent describe: womens-clothing (an online store for women's clothing), fashion (clothing/apparel in general), beauty (cosmetics/beauty products), or commerce (any other or unclear category)?",
      labels: COMMERCE_CATEGORY_LABELS,
      input: prompt.slice(0, 2_000),
      guidance:
        "Judge the business the user actually wants to run, in any language. When the niche is unclear or mixed, choose commerce.",
      timeoutMs: opts.timeoutMs ?? 8_000,
      signal: opts.signal,
    });
    return verdict.source === "llm" ? verdict.verdict : null;
  } catch {
    return null;
  }
}

export function buildEcommerceOpsManifest(input: {
  prompt: string;
  now?: string;
  /** Judged category; null/omitted → neutral "commerce" profile. */
  category?: CommerceCategory | null;
}): AgentlasSurfaceManifest {
  const now = input.now ?? new Date().toISOString();
  const profile = commerceProfileFor(input.category ?? null, input.prompt);
  const evidence = [
    {
      id: "user_business_intent",
      kind: "claimed",
      label: "User business intent",
      source: "User prompt",
      retrievedAt: now,
      confidence: 0.9,
    },
    {
      id: "commerce_os_plan",
      kind: "estimated",
      label: "Commerce operating plan",
      source: "Agentlas ecommerce OS seed generator",
      retrievedAt: now,
      confidence: 0.55,
    },
  ] as AgentlasSurfaceManifest["evidence"];

  const routes = [
    { path: "/", label: "Command", purpose: "Daily operating dashboard for launch tasks, blockers, and agent handoffs.", status: "planned" },
    { path: "/storefront", label: "Storefront", purpose: "Review brand, product cards, sections, and conversion copy.", status: "planned" },
    { path: "/catalog", label: "Catalog", purpose: "Manage product ideas, images, SKU state, margin assumptions, and source labels.", status: "planned" },
    { path: "/orders", label: "Orders", purpose: "Track paid orders, fulfillment status, refunds, and customer messages.", status: "planned" },
    { path: "/finance", label: "Finance", purpose: "Monitor payment setup, fees, payout readiness, and estimate-vs-verified numbers.", status: "planned" },
  ];

  const connectors = [
    {
      id: "payment-provider",
      name: "Payment provider",
      type: "payment",
      purpose: "Create checkout, payment keys, webhooks, and payout readiness after explicit approval.",
      auth: "user-approval",
      status: "proposed",
    },
    {
      id: "commerce-database",
      name: "Commerce database",
      type: "database",
      purpose: "Persist products, orders, customers, assets, and dashboard state.",
      auth: "api-key",
      status: "proposed",
    },
    {
      id: "image-generation",
      name: "Codex image generation",
      type: "model",
      purpose: "Generate product/lifestyle visuals from approved creative briefs and budget.",
      auth: "user-approval",
      status: "proposed",
    },
    {
      id: "storefront-host",
      name: "Storefront host",
      type: "api",
      purpose: "Publish the storefront preview or deployment target.",
      auth: "oauth",
      status: "proposed",
    },
  ];

  const tools = [
    {
      id: "catalog-normalizer",
      name: "Catalog Normalizer",
      description: "Normalize product ideas into consistent SKU, image, copy, and evidence fields.",
      kind: "normalizer",
      parameters: [
        { name: "items", type: "array", required: true },
        { name: "currency", type: "string", required: false },
      ],
      safety: { externalCalls: false, fileWrites: false, requiresApproval: false },
    },
    {
      id: "margin-checker",
      name: "Margin Checker",
      description: "Flags missing cost, fee, shipping, and tax assumptions before a product is marked launch-ready.",
      kind: "validator",
      parameters: [{ name: "product", type: "object", required: true }],
      safety: { externalCalls: false, fileWrites: false, requiresApproval: false },
    },
    {
      id: "order-risk-router",
      name: "Order Risk Router",
      description: "Routes order exceptions to refund, fulfillment, customer support, or finance follow-up lanes.",
      kind: "router",
      parameters: [{ name: "order", type: "object", required: true }],
      safety: { externalCalls: false, fileWrites: false, requiresApproval: false },
    },
  ];

  const productRows: JsonObject[] = [
    {
      name: `${profile.category} hero item`,
      status: "idea",
      imageStatus: "needs-generation",
      copyStatus: "draft",
      trust: "estimated",
      evidenceIds: ["commerce_os_plan"],
    },
    {
      name: `${profile.category} bundle`,
      status: "idea",
      imageStatus: "needs-generation",
      copyStatus: "draft",
      trust: "estimated",
      evidenceIds: ["commerce_os_plan"],
    },
  ];

  return {
    version: "0.1",
    kind: "surface",
    title: `${profile.business} Commerce OS`,
    domain: "ecommerce",
    layout: "service-app",
    app: {
      name: `${profile.business} Commerce OS`,
      tagline: `Agent-operated storefront, catalog, payment, database, image, and order desk for ${profile.category}.`,
      appType: "saas",
      audience: profile.audience,
      valueProp:
        "The agent team turns a business intent into a launchable commerce operating app with reversible setup and visible trust gates.",
      routes,
      connectors,
      tools,
      deployment: { target: "Agentlas desktop local preview, then hosted storefront when approved", readiness: "prototype" },
      business: {
        audience: profile.audience,
        offer: `${profile.category} storefront launch and operations desk`,
        pricing: "Estimated only until payment provider, fulfillment, and ad spend are connected.",
        moat: "The storefront, catalog tools, payment setup, and operations dashboard become reusable Agentlas OS assets.",
        launchMetric: "First verified checkout test and first sourced catalog item.",
      },
    },
    data: {
      brief: {
        type: "json",
        value: {
          business: profile.business,
          category: profile.category,
          audience: profile.audience,
          region: profile.region,
          tone: profile.tone,
          userIntent: input.prompt,
        },
      },
      routes: { type: "table", rows: routes.map((route) => ({ ...route, evidenceIds: ["commerce_os_plan"] })) },
      connectors: { type: "table", rows: connectors.map((connector) => ({ ...connector, evidenceIds: ["commerce_os_plan"] })) },
      products: { type: "table", rows: productRows },
      orders: {
        type: "table",
        rows: [
          { lane: "New orders", status: "waiting-for-payment-provider", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { lane: "Fulfillment exceptions", status: "waiting-for-database", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
        ],
      },
      metrics: {
        type: "table",
        rows: [
          { label: "Payment readiness", value: "approval required", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { label: "Database readiness", value: "connector required", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { label: "Image pipeline", value: "budget gate required", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
        ],
      },
      launch: {
        type: "launch-checklist",
        rows: [
          { item: "Create commerce agent team", status: "planned", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { item: "Connect payment provider through browser delegation", status: "approval-required", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { item: "Connect database and store credentials in Agentlas vault", status: "approval-required", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { item: "Generate product imagery after budget approval", status: "queued", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { item: "Run storefront smoke test", status: "pending", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
        ],
      },
      artifacts: {
        type: "artifacts",
        rows: [
          { name: "Storefront preview", status: "not-scaffolded", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { name: "Operating dashboard", status: "not-scaffolded", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
          { name: "Agent team package", status: "planned", trust: "estimated", evidenceIds: ["commerce_os_plan"] },
        ],
      },
    },
    widgets: [
      { type: "brief-panel", data: "brief" },
      { type: "app-shell", data: "routes" },
      { type: "connector-matrix", data: "connectors" },
      { type: "table", data: "products" },
      { type: "workflow", data: "orders" },
      { type: "cost-summary", data: "metrics" },
      { type: "launch-checklist", data: "launch" },
      { type: "deployment-plan", data: "artifacts" },
    ],
    actions: [
      { id: "create-commerce-team", label: "Create commerce agent team", type: "scaffold-agent-team", permission: "write" },
      {
        id: "connect-commerce-stack",
        label: "Connect commerce stack",
        type: "connect-service",
        permission: "full",
        prompt:
          "Use Agentlas OS delegation to connect payment, database, storefront host, and image provider. If an MCP/API is missing, use browser delegation and provider console setup.",
      },
      {
        id: "delegate-commerce-browser",
        label: "Operate provider browser",
        type: "delegate-browser",
        permission: "full",
        prompt:
          "Open provider pages, create apps/API keys/webhooks, and pause only for password, OTP, legal identity, or checkout approval in secure UI.",
      },
      {
        id: "request-commerce-credentials",
        label: "Save commerce credentials",
        type: "request-credential",
        permission: "full",
        envKey: "COMMERCE_PROVIDER_CREDENTIALS",
        provider: "Selected payment/database/storefront providers",
        inputMode: "agentlas-vault",
        prompt: "Save provider API keys or OAuth tokens through Agentlas vault. Never paste secrets into chat or source files.",
      },
      {
        id: "approve-commerce-checkout",
        label: "Approve commerce checkout",
        type: "request-payment-approval",
        permission: "full",
        payment: {
          merchant: "Selected commerce/payment/storefront provider",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
        },
        prompt:
          "Pause at checkout, show merchant, amount/currency, recurrence, and purpose. Continue only after explicit approval.",
      },
      { id: "generate-catalog-images", label: "Generate catalog images", type: "generate", permission: "write" },
      { id: "scaffold-commerce-app", label: "Scaffold commerce app", type: "scaffold-app", permission: "write" },
      { id: "operate-commerce-os", label: "Operate commerce OS", type: "operate-app", permission: "full" },
      { id: "install-commerce-mcps", label: "Prepare MCP adapters", type: "install-mcp", permission: "write" },
      { id: "run-commerce-smoke", label: "Run storefront smoke", type: "run-smoke-test", permission: "write" },
      { id: "deploy-commerce-preview", label: "Package preview", type: "deploy-preview", permission: "full" },
      { id: "publish-commerce-app-tool", label: "Publish app as tool", type: "publish-as-tool", permission: "write" },
      { id: "build-catalog-tool", label: "Build catalog tool", type: "scaffold-tool", toolId: "catalog-normalizer", permission: "write" },
    ],
    evidence,
    claims: [
      {
        id: "claim_business_intent",
        text: `The user wants to create or operate a ${profile.category} commerce business.`,
        kind: "claimed",
        evidenceIds: ["user_business_intent"],
        status: "needs-review",
      },
      {
        id: "claim_operating_plan",
        text: "The connector, route, and dashboard plan is an estimated launch architecture until providers are connected and smoke-tested.",
        kind: "estimated",
        evidenceIds: ["commerce_os_plan"],
        status: "needs-review",
      },
    ],
    capabilities: [
      {
        id: "commerce_app_filesystem",
        type: "filesystem",
        purpose: "Write reversible storefront, dashboard, MCP adapter, and local tool packages.",
        approval: "once",
      },
      {
        id: "commerce_external_services",
        type: "external-api",
        purpose: "Connect payment, database, storefront, image, analytics, and deployment providers.",
        approval: "once",
        allowlist: [
          "https://stripe.com",
          "https://dashboard.stripe.com",
          "https://portone.io",
          "https://supabase.com",
          "https://shopify.com",
          "https://github.com",
          "https://openai.com",
        ],
      },
      {
        id: "commerce_browser_delegation",
        type: "browser-session",
        purpose: "Operate provider signup/login/app/key/webhook flows when no MCP/API is available.",
        approval: "per-run",
      },
      {
        id: "commerce_credentials",
        type: "credential",
        purpose: "Store provider API keys and OAuth tokens through Agentlas vault.",
        approval: "per-action",
        dataClasses: ["credential", "oauth"],
      },
      {
        id: "commerce_customer_pii",
        type: "pii",
        purpose: "Collect customer contact/order data only inside declared database and storefront flows.",
        approval: "once",
        dataClasses: ["customer-email", "shipping-address", "order-history"],
      },
      {
        id: "commerce_payment_method",
        type: "payment-method",
        purpose: "Let the agent proceed through provider checkout only after explicit approval in secure UI.",
        approval: "per-action",
        dataClasses: ["payment-approval"],
      },
      {
        id: "commerce_paid_checkout_approval",
        type: "human-approval",
        purpose: "Require explicit merchant, amount, currency, recurrence, and approval before paid checkout.",
        approval: "per-action",
      },
      {
        id: "commerce_image_generation",
        type: "model-generation",
        purpose: "Generate product and lifestyle images after budget approval.",
        approval: "once",
      },
    ],
    delegation: {
      mode: "agent-operated",
      autonomy: {
        mode: "agent-first",
        allowedWithoutPrompt: [...SURFACE_AUTONOMY_ALLOWED_WITHOUT_PROMPT],
        checkpoints: [...SURFACE_AUTONOMY_CHECKPOINTS],
        noDeadEndReasons: [...SURFACE_AUTONOMY_NO_DEAD_END_REASONS],
        destructiveActions: [...SURFACE_AUTONOMY_DESTRUCTIVE_ACTIONS],
      },
      fallbackLadder: [...AGENTLAS_OS_FALLBACK_LADDER],
      browser: {
        purpose: "Operate provider consoles, signup/login, key creation, webhook setup, and checkout.",
        startUrls: ["https://stripe.com", "https://supabase.com", "https://shopify.com", "https://openai.com"],
        allowlist: ["https://stripe.com", "https://dashboard.stripe.com", "https://supabase.com", "https://shopify.com", "https://openai.com"],
      },
      credentials: [
        {
          id: "commerce_provider_credentials",
          label: "Commerce provider API keys or OAuth tokens",
          envKey: "COMMERCE_PROVIDER_CREDENTIALS",
          provider: "Selected payment/database/storefront providers",
          inputMode: "agentlas-vault",
          requiredWhen: "A provider app, webhook, database, or storefront connection produces credentials.",
          status: "missing",
        },
      ],
      payments: [
        {
          id: "commerce_provider_checkout",
          merchant: "Selected commerce/payment/storefront provider",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
        },
      ],
    },
    budget: { currency: "USD", limit: 10, spent: 0, approvalThreshold: 1, unit: "surface" },
    jobs: [
      {
        id: "catalog-image-generation",
        label: "Generate initial catalog imagery",
        status: "queued",
        costEstimate: 1,
        currency: "USD",
        resumable: true,
      },
    ],
    stateSchema: {
      fields: [
        { path: "/data/products/rows", owner: "user", merge: "preserve-user", description: "Operator edits product ideas and launch status." },
        { path: "/data/orders/rows", owner: "agent", merge: "append", description: "Agent appends order and fulfillment events." },
        { path: "/data/launch/rows", owner: "user", merge: "preserve-user", description: "User-approved launch checks survive re-emits." },
      ],
    },
    provenance: [
      { source: "User prompt", note: "Business intent supplied by the user.", retrievedAt: now },
      { source: "Agentlas ecommerce OS seed generator", note: "Estimated operating plan; providers not connected yet.", retrievedAt: now },
    ],
  };
}

/**
 * Deterministic copy per JUDGED category. No regex reads the prompt here:
 * the category is a judgment-service verdict (resolveCommerceCategory) or
 * null, and null yields the neutral "commerce" profile. Language detection
 * (isPrimarilyKorean) only picks the region copy, never the category.
 */
function commerceProfileFor(category: CommerceCategory | null, prompt: string): CommerceProfile {
  const isKorean = isPrimarilyKorean(prompt);
  const region = isKorean ? "Korea-first, global-ready" : "Global-ready";
  switch (category) {
    case "womens-clothing":
      return {
        business: "Women's Clothing",
        category: "women's clothing",
        audience: "Women shopping online for curated everyday and seasonal outfits.",
        region,
        tone: "editorial, clean, conversion-focused",
      };
    case "fashion":
      return {
        business: "Fashion",
        category: "fashion",
        audience: "Online shoppers in the declared niche.",
        region,
        tone: "editorial, clean, conversion-focused",
      };
    case "beauty":
      return {
        business: "Beauty",
        category: "beauty",
        audience: "Online shoppers in the declared niche.",
        region,
        tone: "clear, trustworthy, conversion-focused",
      };
    default:
      return {
        business: "Commerce",
        category: "commerce",
        audience: "Online shoppers in the declared niche.",
        region,
        tone: "clear, trustworthy, conversion-focused",
      };
  }
}
