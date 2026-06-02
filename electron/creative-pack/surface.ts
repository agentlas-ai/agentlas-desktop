// First deep vertical seed: product URL/image -> declarative Creative Studio.
// This is not a hand-built UI. It produces the same safe Surface Manifest that
// any agent can emit, so the trusted renderer, state ledger, asset packer, and
// approval gates remain the execution path.
import type {
  AgentlasSurfaceManifest,
  ImageAttachment,
  JsonObject,
} from "../../shared/types";
import { AGENTLAS_OS_FALLBACK_LADDER } from "../../shared/surface-delegation";

export interface ProductMetadata {
  url?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  retrievedAt?: string;
}

interface CreativeSeedInput {
  prompt: string;
  images?: ImageAttachment[];
  metadata?: ProductMetadata;
  now?: string;
}

const CREATIVE_TERMS =
  /(ad|ads|advert|creative|campaign|social|reels|tiktok|instagram|youtube|shorts|video|image|asset|product|shop|store|marketing|광고|소셜|릴스|틱톡|인스타|영상|이미지|에셋|제품|상품|쇼핑몰|상세페이지|마케팅)/i;

export function shouldSeedCreativeAdPack(prompt: string, images?: ImageAttachment[]): boolean {
  const urls = extractUrls(prompt);
  if (images?.length && CREATIVE_TERMS.test(prompt)) return true;
  if (urls.length === 0) return false;
  const trimmed = prompt.trim();
  const urlOnly = urls.length === 1 && trimmed === urls[0];
  return (
    urlOnly ||
    CREATIVE_TERMS.test(prompt) ||
    /제품|상품|url/i.test(prompt) ||
    urls.some((url) => /product|products|item|shop|store|goods|commerce|\/p\/|\/dp\//i.test(url))
  );
}

export async function prepareCreativeAdPackManifest(input: {
  prompt: string;
  images?: ImageAttachment[];
  now?: string;
}): Promise<AgentlasSurfaceManifest | null> {
  if (!shouldSeedCreativeAdPack(input.prompt, input.images)) return null;
  const url = extractUrls(input.prompt)[0];
  const metadata = url ? await fetchProductMetadata(url, input.now) : undefined;
  return buildCreativeAdPackManifest({
    prompt: input.prompt,
    images: input.images,
    metadata,
    now: input.now,
  });
}

export function buildCreativeAdPackManifest(input: CreativeSeedInput): AgentlasSurfaceManifest {
  const now = input.now ?? new Date().toISOString();
  const productUrl = input.metadata?.url ?? extractUrls(input.prompt)[0];
  const origin = productUrl ? safeOrigin(productUrl) : null;
  const imageOrigin = input.metadata?.imageUrl ? safeOrigin(input.metadata.imageUrl) : null;
  const productName = cleanTitle(input.metadata?.title) || productFromUrl(productUrl) || "Product";
  const description = input.metadata?.description || "No product description extracted yet.";
  const channel = inferChannel(input.prompt);
  const evidence = [
    ...(productUrl
      ? [
          {
            id: "product_page",
            kind: "claimed",
            label: "Product page",
            source: input.metadata?.siteName || origin || "Product URL",
            url: productUrl,
            retrievedAt: input.metadata?.retrievedAt || now,
            confidence: input.metadata?.title ? 0.78 : 0.45,
          },
        ]
      : []),
    ...((input.images ?? []).slice(0, 3).map((_, idx) => ({
      id: `user_image_${idx + 1}`,
      kind: "claimed",
      label: `User product image ${idx + 1}`,
      source: "User-provided image attachment",
      retrievedAt: now,
      confidence: 0.9,
    }))),
    {
      id: "creative_plan_estimate",
      kind: "estimated",
      label: "Creative plan",
      source: "Agentlas creative seed generator",
      retrievedAt: now,
      confidence: 0.55,
    },
  ] as AgentlasSurfaceManifest["evidence"];

  const assetRows: JsonObject[] = [
    ...((input.images ?? []).slice(0, 3).map((image, idx) => ({
      id: `user_image_${idx + 1}`,
      title: `Product image ${idx + 1}`,
      dataUrl: `data:${image.mediaType};base64,${image.data}`,
      status: "provided",
      evidenceIds: [`user_image_${idx + 1}`],
    }))),
    ...(input.metadata?.imageUrl
      ? [
          {
            id: "product_hero_remote",
            title: "Product hero from page",
            url: input.metadata.imageUrl,
            status: "referenced",
            evidenceIds: ["product_page"],
          },
        ]
      : []),
  ];

  const shots: JsonObject[] = [
    {
      scene: "Hook",
      duration: "2s",
      prompt: `Open with a clean, high-contrast reveal of ${productName}. Focus on one immediate visual reason to stop scrolling.`,
      model: "auto-image-or-video",
      status: "planned",
      evidenceIds: ["creative_plan_estimate"],
    },
    {
      scene: "Problem",
      duration: "3s",
      prompt: `Show the daily friction ${productName} solves. Keep the claim visual, not numerical, unless a verified source is added.`,
      model: "auto-video",
      status: "planned",
      evidenceIds: ["creative_plan_estimate"],
    },
    {
      scene: "Proof",
      duration: "3s",
      prompt: `Use the product page details as claimed source material: ${description.slice(0, 180)}.`,
      model: "auto-image-or-video",
      status: "planned",
      evidenceIds: productUrl ? ["product_page"] : ["creative_plan_estimate"],
    },
    {
      scene: "CTA",
      duration: "2s",
      prompt: `Close with a direct ${channel} call-to-action for ${productName}. Avoid price or performance promises unless verified.`,
      model: "auto-video",
      status: "planned",
      evidenceIds: ["creative_plan_estimate"],
    },
  ];

  const allowlist = [origin, imageOrigin].filter((value): value is string => Boolean(value));
  return {
    version: "0.1",
    kind: "surface",
    title: `${productName} Social Ad Pack`,
    domain: "creative",
    layout: "creative-studio",
    app: {
      name: `${productName} Ad Studio`,
      tagline: "Turns product inputs into reviewable social ad assets and export packs.",
      appType: "creative-tool",
      audience: "Solo founders, ecommerce operators, and growth teams.",
      valueProp: "One product input becomes storyboard, source-checked claims, asset queue, and reusable export pack.",
      routes: [
        { path: "/", label: "Studio", purpose: "Review brief, shots, assets, and exports." },
        { path: "/claims", label: "Claims", purpose: "Separate verified, claimed, estimated, and unverified statements." },
        { path: "/exports", label: "Exports", purpose: "Package channel-ready prompts, captions, and media assets." },
      ],
      connectors: [
        ...(productUrl
          ? [
              {
                id: "product-page",
                name: "Product URL fetch",
                type: "api",
                purpose: "Read public product metadata and media references.",
                auth: "none",
                status: "verified",
              },
            ]
          : []),
        {
          id: "openai-images",
          name: "OpenAI Images",
          type: "model",
          purpose: "Generate image variants after budget approval.",
          auth: "api-key",
          setupUrl: "https://platform.openai.com/api-keys",
          status: "proposed",
        },
        {
          id: "adobe-firefly",
          name: "Adobe Firefly",
          type: "model",
          purpose: "Generate commercially oriented image/video creative when the operator prefers Adobe's creative suite.",
          auth: "user-approval",
          setupUrl: "https://firefly.adobe.com/",
          status: "proposed",
        },
        {
          id: "higgsfield",
          name: "Higgsfield",
          type: "model",
          purpose: "Generate social-first video/image variations for TikTok, Reels, Shorts, and product ads.",
          auth: "user-approval",
          setupUrl: "https://higgsfield.ai/",
          status: "proposed",
        },
      ],
      tools: [
        {
          id: "claim-checker",
          name: "Creative Claim Checker",
          description: "Flags product claims that lack source evidence before launch.",
          kind: "validator",
          parameters: [{ name: "claims", type: "array", required: true }],
          safety: { externalCalls: false, fileWrites: false, requiresApproval: false },
        },
      ],
      deployment: { target: "agentlas desktop", readiness: "prototype" },
      business: {
        audience: "ecommerce marketers",
        offer: "Product URL to launch-ready social ad pack",
        pricing: "TBD after offer and provider-cost validation",
        moat: "Every pack becomes a reusable Agentlas OS asset with state, evidence, and generated tools.",
        launchMetric: "first asset pack exported within 5 minutes",
      },
    },
    data: {
      brief: {
        type: "json",
        value: {
          product: productName,
          productUrl: productUrl ?? "not provided",
          channel,
          description,
          source: productUrl ? "product URL" : "user image/prompt",
        },
      },
      shots: { type: "table", rows: shots },
      assets: { type: "media", rows: assetRows },
      exports: {
        type: "table",
        rows: [
          { channel, format: channel === "Instagram Feed" ? "4:5" : "9:16", status: "draft", caption: `${productName} launch caption draft` },
          { channel: "TikTok", format: "9:16", status: "draft", caption: `Fast hook + proof + CTA for ${productName}` },
          { channel: "Meta Ads", format: "1:1", status: "draft", caption: `Static creative concept for ${productName}` },
        ],
      },
      modelProviders: {
        type: "table",
        rows: [
          {
            provider: "OpenAI Images",
            role: "image variants and product compositions",
            setupUrl: "https://platform.openai.com/api-keys",
            status: "candidate",
            trust: "estimated",
            evidenceIds: ["creative_plan_estimate"],
          },
          {
            provider: "Adobe Firefly",
            role: "commercial creative suite workflow",
            setupUrl: "https://firefly.adobe.com/",
            status: "candidate",
            trust: "estimated",
            evidenceIds: ["creative_plan_estimate"],
          },
          {
            provider: "Higgsfield",
            role: "social video/image generation workflow",
            setupUrl: "https://higgsfield.ai/",
            status: "candidate",
            trust: "estimated",
            evidenceIds: ["creative_plan_estimate"],
          },
        ],
      },
      launch: {
        type: "launch-checklist",
        rows: [
          { item: "Source labels attached to product facts", status: productUrl ? "ready" : "needs-review" },
          { item: "User decisions preserve-user state", status: "ready" },
          { item: "Budget gate before generation", status: "ready" },
          { item: "Materialized asset pack", status: "pending" },
        ],
      },
    },
    widgets: [
      { type: "brief-panel", data: "brief" },
      { type: "storyboard", data: "shots" },
      { type: "asset-board", data: "assets" },
      { type: "model-router", data: "modelProviders" },
      { type: "export-pack", data: "exports" },
      { type: "launch-checklist", data: "launch" },
    ],
    actions: [
      { id: "asset-pack", label: "Materialize asset pack", type: "materialize-asset-pack", permission: "write" },
      { id: "operate-creative-os", label: "Operate creative OS", type: "operate-app", permission: "full" },
      {
        id: "connect-creative-services",
        label: "Connect creative services",
        type: "connect-service",
        permission: "full",
        prompt:
          "Use Agentlas browser delegation to connect any required generation, ad, storage, or export service. If no MCP/API exists, create the provider app/API key in the provider console and save credentials through the Agentlas vault path.",
      },
      {
        id: "delegate-provider-browser",
        label: "Operate provider browser",
        type: "delegate-browser",
        permission: "full",
        prompt:
          "Open and operate the chosen provider console/signup/login flow. Ask the user only for passwords, OTPs, legal identity confirmation, or payment approval in secure UI.",
      },
      {
        id: "request-provider-credential",
        label: "Save provider credential",
        type: "request-credential",
        permission: "full",
        envKey: "CREATIVE_PROVIDER_API_KEY",
        provider: "Selected creative generation provider",
        inputMode: "agentlas-vault",
        prompt:
          "Request the generated API key or OAuth token through the Agentlas vault path and save it as CREATIVE_PROVIDER_API_KEY.",
      },
      {
        id: "approve-provider-checkout",
        label: "Approve provider checkout",
        type: "request-payment-approval",
        permission: "full",
        payment: {
          merchant: "Selected creative generation or ad provider",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
        },
        prompt:
          "Pause at checkout, show merchant, quoted amount/currency, recurrence, and what will be purchased. Continue only after explicit user approval.",
      },
      { id: "scaffold", label: "Scaffold production app", type: "scaffold-app", permission: "write" },
      { id: "claim-tool", label: "Build claim checker", type: "scaffold-tool", toolId: "claim-checker", permission: "write" },
    ],
    evidence,
    claims: [
      {
        id: "claim_product_identity",
        text: `The product input appears to be ${productName}.`,
        kind: productUrl ? "claimed" : "unverified",
        evidenceIds: productUrl ? ["product_page"] : [],
        status: "needs-review",
      },
      {
        id: "claim_creative_plan",
        text: "Storyboard prompts are estimated creative recommendations, not verified performance claims.",
        kind: "estimated",
        evidenceIds: ["creative_plan_estimate"],
        status: "needs-review",
      },
    ],
    capabilities: [
      ...(allowlist.length
        ? [
            {
              id: "product_metadata_network",
              type: "network",
              purpose: "Read public product metadata and download declared product media into the asset pack.",
              approval: "once",
              allowlist,
            },
          ]
        : []),
      {
        id: "asset_pack_filesystem",
        type: "filesystem",
        purpose: "Write the reusable creative asset pack to the local workspace.",
        approval: "once",
      },
      {
        id: "creative_model_generation",
        type: "model-generation",
        purpose: "Generate image/video variants from approved storyboard shots.",
        approval: "once",
      },
      {
        id: "creative_browser_delegation",
        type: "browser-session",
        purpose: "Operate provider web consoles when a direct MCP/API connector is missing.",
        approval: "per-run",
        allowlist: allowlist.length ? allowlist : undefined,
      },
      {
        id: "creative_provider_credentials",
        type: "credential",
        purpose: "Request login, API key, or OAuth credentials through the Agentlas vault flow when a provider requires them.",
        approval: "per-action",
        dataClasses: ["credential", "oauth"],
      },
      {
        id: "creative_paid_checkout_approval",
        type: "human-approval",
        purpose: "Require explicit merchant, amount, currency, recurrence, and user approval before paid checkout or generation spend.",
        approval: "per-action",
        dataClasses: ["payment-approval"],
      },
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
        destructiveActions: ["delete-files", "archive-os-object", "unregister-mcp", "revoke-credential", "cancel-paid-service"],
      },
      fallbackLadder: [...AGENTLAS_OS_FALLBACK_LADDER],
      browser: {
        purpose: "Operate provider consoles, signup/login, key creation, and checkout when no direct MCP/API exists.",
        startUrls: productUrl ? [productUrl] : [],
        allowlist,
      },
      credentials: [
        {
          id: "creative_provider_key",
          label: "Creative provider API key or OAuth token",
          envKey: "CREATIVE_PROVIDER_API_KEY",
          provider: "Selected creative generation provider",
          inputMode: "agentlas-vault",
          requiredWhen: "A chosen generation/export provider requires an API key or OAuth token.",
          status: "missing",
        },
      ],
      payments: [
        {
          id: "creative_provider_checkout",
          merchant: "Selected creative generation or ad provider",
          quoteRequired: true,
          recurrence: "unknown",
          approvalMode: "explicit-before-checkout",
          cardHandling: "provider-checkout",
          status: "not-requested",
        },
      ],
    },
    budget: { currency: "USD", limit: 5, spent: 0, approvalThreshold: 1, unit: "surface" },
    jobs: [
      { id: "job_generate_variants", label: "Generate visual variants", status: "queued", costEstimate: 0.5, currency: "USD", resumable: true },
      { id: "job_generate_video_variants", label: "Generate short-form video variants", status: "queued", costEstimate: 1.25, currency: "USD", resumable: true },
    ],
    stateSchema: {
      fields: [
        { path: "/data/shots/rows", owner: "user", merge: "preserve-user", description: "User shot approvals and rejections." },
        { path: "/data/exports/rows", owner: "user", merge: "preserve-user", description: "User-edited channel export decisions." },
      ],
    },
    provenance: productUrl
      ? [{ source: input.metadata?.siteName || origin || "Product URL", url: productUrl, retrievedAt: input.metadata?.retrievedAt || now }]
      : [{ source: "User prompt or image", retrievedAt: now }],
  };
}

export async function fetchProductMetadata(url: string, now?: string): Promise<ProductMetadata> {
  const retrievedAt = now ?? new Date().toISOString();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Agentlas/0.2 creative-surface-preview" },
    });
    clearTimeout(timeout);
    const text = await res.text();
    return {
      url,
      title: meta(text, "og:title") || title(text),
      description: meta(text, "og:description") || meta(text, "description"),
      imageUrl: absolutize(meta(text, "og:image") || meta(text, "twitter:image"), url),
      siteName: meta(text, "og:site_name") || safeHost(url),
      retrievedAt,
    };
  } catch {
    return { url, siteName: safeHost(url), retrievedAt };
  }
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((match) => match[0]);
}

function title(html: string): string | undefined {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim());
}

function meta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return decodeHtml(html.match(re)?.[1]?.trim());
}

function decodeHtml(value: string | undefined): string | undefined {
  return value
    ?.replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolutize(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function safeHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function productFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return cleanTitle(last?.replace(/[-_]+/g, " ")) || parsed.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function cleanTitle(value?: string): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").replace(/\s*[|–—-]\s*[^|–—-]{2,}$/u, "").trim();
  return cleaned || undefined;
}

function inferChannel(prompt: string): string {
  if (/tiktok|틱톡/i.test(prompt)) return "TikTok";
  if (/feed|피드/i.test(prompt)) return "Instagram Feed";
  if (/youtube|shorts|쇼츠/i.test(prompt)) return "YouTube Shorts";
  return "Instagram Reels";
}
