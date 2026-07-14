#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "site-landing");
const AGENT_APP_NAMES = Array.from({ length: 10 }, (_, index) => `Agent ${String(index + 1).padStart(2, "0")}`);

const landingSource = fs.readFileSync(path.join(root, "renderer/components/site/SiteLanding.tsx"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "renderer/app/(shell)/site/page.tsx"), "utf8");
assert.match(pageSource, /recommendAgentAppMcp\(\{ projectId: candidate\.id \}\)/,
  "Site must refresh main-owned MCP readiness instead of trusting persisted consent alone");
assert.match(landingSource, /function mcpCardPresentation[\s\S]*liveApprovalReady/,
  "Agent App cards must combine durable consent with fresh MCP readiness");
assert.match(pageSource, /setAgentAppMcpLiveStates\(\{\}\)[\s\S]*agentAppMcpRecommendation/,
  "a readiness refresh must clear old card truth before the async lookup");
assert.doesNotMatch(landingSource, /agentAppMcpConsent\?\.decision/,
  "persisted approval alone must never drive an Agent App card checkmark");
assert.match(landingSource, /recommendation\.rows\.length === 0 && recommendation\.blocked\.length > 0/,
  "blocked-only declarations must receive an explicit card state");
assert.match(pageSource, /readonlyMcpCatalogIds\.length[\s\S]{0,160}capabilities\?\.unavailable\.length/,
  "blocked-only Agent Apps must remain in live MCP refresh and review");

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/** A real, decodable 1280x720 PNG fixture rather than a CSS or SVG stand-in. */
function createThumbnailDataUrl(width = 1280, height = 720) {
  const rowBytes = 1 + width * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inRail = x < 210;
      const inHeader = y < 84;
      const inPanel = x > 278 && x < 1194 && y > 142 && y < 626;
      const inAction = x > 980 && x < 1150 && y > 39 && y < 69;
      const [r, g, b] = inAction
        ? [15, 123, 101]
        : inRail
          ? [20, 48, 40]
          : inHeader
            ? [244, 249, 247]
            : inPanel
              ? [255, 255, 255]
              : [232, 242, 238];
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function installSiteFixtures({ thumbnailDataUrl }) {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const contract = {
    schemaVersion: 1,
    source: "declared-package",
    inputs: [{
      name: "request",
      type: "string",
      label: "Request",
      description: "Work to perform",
      required: true,
      format: "textarea",
      options: [],
      defaultValue: null,
    }],
    outputs: [{ name: "result", label: "Result", type: "markdown", description: "Agent response" }],
    capabilities: {
      schemaVersion: 1,
      source: "declared-package",
      readonlyMcpCatalogIds: ["agentlas-time"],
      unavailable: [],
    },
  };
  const visual = {
    schemaVersion: 1,
    colorMode: "light",
    accent: "teal",
    density: "spacious",
    radius: "soft",
    headline: "What should we work on?",
    description: "Run this agent from a focused Astryx interface.",
    inputHeading: "Input",
    outputHeading: "Output",
    runLabel: "Run agent",
    emptyOutput: "The result will appear here.",
  };
  const projects = [
    {
      id: "site-web",
      name: "Marketing landing page",
      surface: "web",
      agentAppTarget: null,
      astryxTemplate: null,
      agentAppContract: null,
      agentAppVisual: null,
      agentAppArtifact: null,
      createdAt: yesterday,
      updatedAt: now,
      screens: [],
    },
    {
      id: "site-mobile",
      name: "Companion mobile app",
      surface: "mobile",
      agentAppTarget: null,
      astryxTemplate: null,
      agentAppContract: null,
      agentAppVisual: null,
      agentAppArtifact: null,
      createdAt: yesterday,
      updatedAt: now,
      screens: [],
    },
    ...Array.from({ length: 10 }, (_, index) => {
      const appName = `Agent ${String(index + 1).padStart(2, "0")}`;
      const projectId = `site-agent-app-${index + 1}`;
      return {
        id: projectId,
        // The gallery contract must prefer the selected target name over this workspace name.
        name: `Workspace ${String(index + 1).padStart(2, "0")}`,
        surface: "agent-app",
        agentAppTarget: {
          kind: index % 4 === 1 ? "team" : index % 4 === 2 ? "firm" : index % 4 === 3 ? "group" : "agent",
          id: `target-${index + 1}`,
          name: appName,
          description: `${appName} test fixture`,
          memberCount: index % 4 === 0 ? 1 : 3,
        },
        astryxTemplate: index % 2 === 0 ? "ai-chat" : "form-two-column",
        agentAppContract: index === 4 ? {
          ...contract,
          capabilities: {
            ...contract.capabilities,
            readonlyMcpCatalogIds: [],
            unavailable: [{ id: "brave-search", reason: "not-allowlisted" }],
          },
        } : contract,
        agentAppVisual: visual,
        agentAppMcpConsent: index < 4 ? {
          schemaVersion: 1,
          receiptId: "00000000-0000-4000-8000-000000000001",
          projectId,
          recommendationDigest: "a".repeat(64),
          decision: "approved",
          approvedCatalogIds: ["agentlas-time"],
          decidedAt: now,
        } : null,
        agentAppArtifact: {
          schemaVersion: 1,
          appRecordId: `app-record-${index + 1}`,
          appId: `app-${index + 1}`,
          appName,
          rootPath: `/tmp/agentlas-site/${projectId}`,
          sourceScreenId: `screen-${index + 1}`,
          status: "ready",
          launchUrl: null,
          thumbnail: {
            path: `/tmp/agentlas-site/${projectId}/artifacts/thumbnail.png`,
            width: 1280,
            height: 720,
            updatedAt: now,
          },
          publish: null,
          createdAt: yesterday,
          updatedAt: now,
          failureReason: null,
        },
        createdAt: yesterday,
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
        screens: [],
      };
    }),
  ];

  const site = window.agentlas.site || (window.agentlas.site = {});
  site.listProjects = async () => projects;
  site.contentAvailable = async () => ({ ready: true, agent: "web-master" });
  site.agentAppThumbnail = async ({ projectId }) => ({
    ok: true,
    projectId,
    dataUrl: thumbnailDataUrl,
    updatedAt: now,
  });
  site.agentAppMcpRecommendation = async ({ projectId }) => {
    if (projectId === "site-agent-app-3") throw new Error("registry lookup unavailable");
    const degraded = projectId === "site-agent-app-2";
    const zeroReady = projectId === "site-agent-app-4";
    const blockedOnly = projectId === "site-agent-app-5";
    return {
      schemaVersion: 1,
      projectId,
      targetName: projectId,
      // These degraded fixtures deliberately retain an old approval. The card
      // must still fail closed from the live rows below.
      status: blockedOnly ? "not-required" : "approved",
      rows: blockedOnly ? [] : [{
        catalogId: "agentlas-time",
        name: "System Time",
        mark: "T",
        credentialMode: "keyless",
        installed: !zeroReady,
        enabled: !zeroReady,
        keyState: "not-required",
        readiness: degraded || zeroReady ? "not-configured" : "ready",
      }],
      blocked: blockedOnly ? [{ id: "brave-search", reason: "not-allowlisted" }] : [],
      receiptId: "live-receipt",
      decidedAt: now,
    };
  };
  // Publishing QA is read-only. Every mutating bridge method fails if the UI accidentally
  // invokes it; status reads and Keychain-presence reads are the only permitted operations.
  const mutationCalls = [];
  window.__sitePublishQa = { mutationCalls, mcpReviewCalls: [] };
  site.reviewAgentAppMcp = async ({ projectId }) => {
    window.__sitePublishQa.mcpReviewCalls.push(projectId);
    return site.agentAppMcpRecommendation({ projectId });
  };
  const publishStatuses = ["vercel", "railway", "render"].map((provider) => ({
    provider,
    connected: true,
    accountLabel: `${provider}-qa-account`,
    connectionMethod: provider === "railway" ? "cli" : "token",
    freePlanNote: `${provider} QA plan boundary`,
    signupUrl: `https://example.invalid/${provider}/signup`,
    tokenUrl: `https://example.invalid/${provider}/token`,
    cliInstalled: true,
    cliVersion: "qa-only",
    tokenStored: provider !== "railway",
    ready: true,
    reason: null,
  }));
  site.listPublishProviderStatuses = async () => publishStatuses;
  const forbidMutation = async (name) => {
    mutationCalls.push(name);
    throw new Error(`QA must not invoke ${name}`);
  };
  site.savePublishProviderToken = async () => forbidMutation("savePublishProviderToken");
  site.removePublishProviderToken = async () => forbidMutation("removePublishProviderToken");
  site.openPublishProviderPage = async () => forbidMutation("openPublishProviderPage");
  site.connectPublishProvider = async () => forbidMutation("connectPublishProvider");
  site.publishAgentApp = async () => forbidMutation("publishAgentApp");

  const secrets = window.agentlas.secrets || (window.agentlas.secrets = {});
  secrets.hasApiKey = async (provider) => ["openai", "anthropic", "google"].includes(provider);
  secrets.saveApiKey = async () => forbidMutation("saveApiKey");

  const groups = window.agentlas.agentGroups || (window.agentlas.agentGroups = {});
  groups.listResolved = async () => [
    {
      id: "group-qa",
      name: "리서치 스쿼드",
      description: "조사와 검증을 함께 수행합니다.",
      members: [
        { id: "agent-2", kind: "agent", name: "빌더 에이전트" },
        { id: "agent-3", kind: "agent", name: "리서치 에이전트" },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    Math.max(metrics.document, metrics.body) <= metrics.viewport + 2,
    `${label} overflows horizontally: ${Math.max(metrics.document, metrics.body)}px > ${metrics.viewport}px`,
  );
  return metrics;
}

async function resetSiteLandingScroll(page) {
  await page.locator("main").last().evaluate((node) => {
    node.scrollTop = 0;
  });
}

async function waitForGalleryPngs(page, expectedCount) {
  await page.waitForFunction((count) => {
    const section = document.querySelector('section[aria-labelledby="agent-apps-heading"]');
    const images = Array.from(section?.querySelectorAll("article button[aria-pressed] > span:first-child > img") || []);
    return images.length === count && images.every((image) => image.complete && image.naturalWidth === 1280 && image.naturalHeight === 720);
  }, expectedCount);
}

async function assertGalleryLayout(page, expectedNames) {
  const section = page.locator('section[aria-labelledby="agent-apps-heading"]');
  const cards = section.locator("article");
  assert.equal(await cards.count(), expectedNames.length, `expected ${expectedNames.length} visible Agent App cards`);
  assert.deepEqual(await cards.locator("h3").allTextContents(), expectedNames, "card titles must be the selected agent names");

  await waitForGalleryPngs(page, expectedNames.length);
  const imageContract = await cards.evaluateAll((rows) => rows.map((card) => {
    const frame = card.querySelector("button[aria-pressed] > span:first-child");
    const image = frame?.querySelector("img");
    const box = frame?.getBoundingClientRect();
    return {
      directChildren: frame ? Array.from(frame.children).map((child) => child.tagName) : [],
      src: image?.getAttribute("src") || "",
      naturalWidth: image?.naturalWidth || 0,
      naturalHeight: image?.naturalHeight || 0,
      ratio: box && box.height ? box.width / box.height : 0,
      x: card.getBoundingClientRect().x,
      y: card.getBoundingClientRect().y,
    };
  }));
  for (const [index, item] of imageContract.entries()) {
    assert.deepEqual(item.directChildren, ["IMG"], `card ${index + 1} must show only a real image in its screenshot frame`);
    assert.match(item.src, /^data:image\/png;base64,/, `card ${index + 1} thumbnail is not a PNG data URL`);
    assert.equal(item.naturalWidth, 1280, `card ${index + 1} PNG width drifted`);
    assert.equal(item.naturalHeight, 720, `card ${index + 1} PNG height drifted`);
    assert.ok(Math.abs(item.ratio - 16 / 9) < 0.02, `card ${index + 1} frame is not 16:9 (${item.ratio})`);
  }
  return imageContract;
}

async function openReadyAgentAppPublishDialog(page) {
  const publishButton = page.locator("header").getByRole("button", { name: /^(게시|Publish)$/ });
  if (await publishButton.isDisabled()) {
    await page.locator('section[aria-labelledby="agent-apps-heading"] article button[aria-pressed]').first().click();
  }
  assert.equal(await publishButton.isEnabled(), true, "a ready Agent App selection must enable Publish");
  await publishButton.click();
  const dialog = page.getByRole("dialog", { name: AGENT_APP_NAMES[0] });
  await dialog.waitFor();
  await dialog.getByText("vercel-qa-account", { exact: true }).waitFor();
  return dialog;
}

function publishScope(dialog) {
  return dialog
    .getByRole("heading", { name: /공개 범위 확인|Confirm public scope/ })
    .locator("xpath=ancestor::section[1]");
}

async function assertNoPublishMutations(page) {
  const calls = await page.evaluate(() => window.__sitePublishQa?.mutationCalls || []);
  assert.deepEqual(calls, [], `read-only publishing QA invoked mutating bridge methods: ${calls.join(", ")}`);
}

async function checkEveryConsent(scope, expectedCount = 5) {
  const checkboxes = scope.locator('input[type="checkbox"]');
  assert.equal(await checkboxes.count(), expectedCount, `public deployment must require exactly ${expectedCount} explicit consents`);
  for (let index = 0; index < expectedCount; index += 1) await checkboxes.nth(index).check();
  assert.ok((await checkboxes.evaluateAll((nodes) => nodes.every((node) => node.checked))), "not every deployment consent remained checked");
  return checkboxes;
}

async function waitForAllUnchecked(checkboxes, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await checkboxes.evaluateAll((nodes) => nodes.length > 0 && nodes.every((node) => !node.checked))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function waitForInputValue(input, expected, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await input.inputValue() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function assertPublishDialogContract(page, dialog) {
  const hostingTabs = dialog.getByRole("tablist", { name: /호스팅 Provider|Hosting provider/ });
  const providerTabs = hostingTabs.getByRole("tab");
  assert.equal(await providerTabs.count(), 3, "publishing must expose exactly Vercel, Railway, and Render tabs");
  assert.deepEqual(
    await providerTabs.evaluateAll((tabs) => tabs.map((tab) => tab.querySelector("b")?.textContent?.trim() || "")),
    ["Vercel", "Railway", "Render"],
    "hosting provider tab order drifted",
  );

  const vercelTab = hostingTabs.getByRole("tab", { name: /^Vercel/ });
  const railwayTab = hostingTabs.getByRole("tab", { name: /^Railway/ });
  const renderTab = hostingTabs.getByRole("tab", { name: /^Render/ });
  assert.equal(await vercelTab.getAttribute("aria-selected"), "true", "Vercel must be the initial provider tab");

  const providerTokenInput = dialog.getByLabel("Provider access token");
  assert.equal(await providerTokenInput.getAttribute("type"), "password", "provider token must use a password field");
  assert.equal(await providerTokenInput.getAttribute("autocomplete"), "off", "provider token autocomplete must stay disabled");
  const providerSecretRow = providerTokenInput.locator("xpath=..");
  assert.ok(await providerSecretRow.getByRole("button", { name: /Keychain에 저장|Save to Keychain/ }).isDisabled(), "empty provider token must not be saved");
  assert.equal(await providerSecretRow.getByRole("button", { name: /삭제|Remove/ }).count(), 1, "stored Vercel token status is not visible");

  const llmTabs = dialog.getByRole("tablist", { name: /LLM Provider|LLM provider/ });
  assert.equal(await llmTabs.getByRole("tab").count(), 3, "OpenAI, Anthropic, and Google LLM tabs must all be present");
  assert.equal(await llmTabs.locator('i[data-ready="true"]').count(), 3, "all three mock Keychain-presence statuses must render");
  const llmInput = dialog.getByRole("textbox", { name: "OPENAI_API_KEY" });
  assert.equal(await llmInput.getAttribute("type"), "password", "LLM key must use a password field");
  assert.equal(await llmInput.getAttribute("autocomplete"), "off", "LLM key autocomplete must stay disabled");
  assert.equal(await llmInput.inputValue(), "", "LLM key presence must never reveal the stored key value");
  assert.equal(await llmInput.locator("xpath=..").getByRole("button", { name: /키 교체|Replace key/ }).count(), 1, "Keychain presence must expose only the replace action");

  const scope = publishScope(dialog);
  const scopeText = (await scope.innerText()).replace(/\s+/g, " ");
  assert.match(scopeText, /설명\+I\/O 기반 BYOK 런타임|description and I\/O/, "public projection disclosure is missing");
  assert.match(scopeText, /로컬 메모리.*파일.*도구|without local memory, files, or tools/, "local-private-state exclusion is missing");
  assert.match(scopeText, /추론 API.*app passcode|inference API is protected by the app passcode/, "passcode-protected public API disclosure is missing");
  assert.match(scopeText, /서버 secret|server secrets/, "Keychain-to-hosting secret transfer disclosure is missing");
  const consentBoxes = scope.locator('input[type="checkbox"]');
  assert.equal(await consentBoxes.count(), 5, "public deployment must render five explicit consent checkboxes");
  assert.ok(await consentBoxes.evaluateAll((nodes) => nodes.every((node) => !node.checked)), "deployment consents must start unchecked");

  const accountField = dialog.getByLabel(/팀 \/ Workspace ID|Team \/ workspace ID/);
  await accountField.fill("vercel-team-qa");
  const appAccessInput = dialog.getByLabel("AGENTLAS_APP_ACCESS_KEY");
  assert.equal(await appAccessInput.getAttribute("type"), "password", "app access passcode must use a password field");
  assert.equal(await appAccessInput.getAttribute("autocomplete"), "new-password", "app access passcode must not reuse a stored browser credential");
  await dialog.getByRole("button", { name: /안전하게 생성|Generate securely/ }).click();
  assert.match(await appAccessInput.inputValue(), /^[\x21-\x7E]{32,256}$/, "generator must create a valid high-entropy app passcode");
  await checkEveryConsent(scope);
  const vercelPublish = dialog.getByRole("button", { name: /Vercel에 게시|Vercel publish/ });
  assert.equal(await vercelPublish.isEnabled(), true, "ready account + Keychain key + app passcode + five consents must enable Vercel publish");

  await railwayTab.click();
  await dialog.getByText("railway-qa-account", { exact: true }).waitFor();
  assert.equal(await railwayTab.getAttribute("aria-selected"), "true", "Railway tab did not activate");
  await waitForInputValue(dialog.getByLabel(/팀 \/ Workspace ID|Team \/ workspace ID/), "", "provider account/workspace ID leaked across provider selection");
  await waitForAllUnchecked(consentBoxes, "provider-specific consent leaked from Vercel to Railway");
  assert.equal(await dialog.getByRole("button", { name: /Railway에 게시|Railway publish/ }).isDisabled(), true, "Railway publish must require fresh provider consent");

  await checkEveryConsent(scope);
  const anthropicTab = llmTabs.getByRole("tab", { name: /^Anthropic/ });
  await anthropicTab.click();
  const anthropicTransfer = scope.getByRole("checkbox", { name: /ANTHROPIC_API_KEY/ });
  await waitForAllUnchecked(anthropicTransfer, "LLM key-transfer consent leaked from OpenAI to Anthropic");
  assert.equal(await dialog.getByRole("button", { name: /Railway에 게시|Railway publish/ }).isDisabled(), true, "LLM provider switch must require fresh key-transfer consent");
  assert.equal(await dialog.getByRole("textbox", { name: "ANTHROPIC_API_KEY" }).inputValue(), "", "Anthropic Keychain presence must not reveal a key value");

  await renderTab.click();
  await dialog.getByText("render-qa-account", { exact: true }).waitFor();
  assert.equal(await renderTab.getAttribute("aria-selected"), "true", "Render tab did not activate");
  await waitForAllUnchecked(consentBoxes, "provider consent leaked from Railway to Render");
  const repositoryInput = dialog.getByLabel(/Git 저장소 URL|Git repository URL/);
  const ownerInput = dialog.getByLabel(/Render Owner ID|Render owner ID/);
  const branchInput = dialog.getByLabel(/브랜치|Branch/);
  const rootInput = dialog.getByLabel(/Root directory/);
  const sourceConfirm = dialog.getByRole("checkbox", { name: /현재 검증된 Agent App 패키지|currently validated Agent App package/ });
  assert.equal(await branchInput.inputValue(), "main", "Render branch must default to main");
  assert.equal(await rootInput.inputValue(), "", "Render root directory must remain optional");
  assert.equal(await sourceConfirm.isChecked(), false, "Render source confirmation must start unchecked");
  const renderPublish = dialog.getByRole("button", { name: /Render에 게시|Render publish/ });
  assert.equal(await renderPublish.isDisabled(), true, "Render publish must remain disabled without repository proof");
  await repositoryInput.fill("https://github.com/agentlas/qa-only");
  await ownerInput.fill("render-owner-qa");
  await sourceConfirm.check();
  await checkEveryConsent(scope, 4);
  assert.equal(await renderPublish.isEnabled(), true, "Render publish must enable only after repo fields, source confirmation, provider status, and four consents");

  await assertNoPublishMutations(page);
  return {
    providerTabs: 3,
    llmTabs: 3,
    explicitConsents: { vercelRailway: 5, render: 4 },
    providerConsentReset: true,
    llmTransferConsentReset: true,
    renderSourceConfirmation: true,
    secretValuesExposed: false,
  };
}

async function main() {
  assert.ok(fs.existsSync(path.join(distDir, "site.html")), "dist/renderer/site.html is missing; run npm run build:renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const thumbnailDataUrl = createThumbnailDataUrl();
  const pngBytes = Buffer.from(thumbnailDataUrl.split(",")[1], "base64");
  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "thumbnail fixture is not a PNG");

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const proof = { recordedAt: new Date().toISOString(), desktop: {}, mobile: {} };
  try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await desktop.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ teamRoster: true, hiredRoster: true }));
    await desktop.addInitScript(installSiteFixtures, { thumbnailDataUrl });
    const page = await desktop.newPage();
    const errors = collectErrors(page);
    await page.goto(`${baseUrl}/site.html`, { waitUntil: "networkidle", timeout: 20_000 });
    await page.getByRole("heading", { name: /아이디어를 실제 인터페이스로|Turn an idea into a working interface/ }).waitFor();

    const desktopOverflow = await assertNoHorizontalOverflow(page, "desktop landing");
    const background = await page.locator("main").last().evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.equal(background, "rgb(255, 255, 255)", "Site landing must use a white background");
    assert.equal(await page.getByRole("heading", { name: "Use a template" }).count(), 1);

    const templateSection = page.locator('section[aria-labelledby="site-template-heading"]');
    const templateButtons = templateSection.locator("button");
    assert.equal(await templateButtons.count(), 3, "Site must expose exactly three template cards");
    const templateLabels = await templateButtons.evaluateAll((buttons) => buttons.map((button) => {
      const labels = Array.from(button.querySelectorAll("b"));
      return labels.at(-1)?.textContent?.trim() || "";
    }));
    assert.deepEqual(templateLabels, ["Web", "Mobile", "Agent App"], "template order must be Web, Mobile, Agent App");

    const firstPageLayout = await assertGalleryLayout(page, AGENT_APP_NAMES.slice(0, 9));
    const agentAppCards = page.locator('section[aria-labelledby="agent-apps-heading"] article');
    const mcpButtonAt = (index) => agentAppCards.nth(index).locator("button[data-status]");
    const normalMcp = mcpButtonAt(0);
    await normalMcp.getByText(/MCP 1\/1 (?:설정됨|configured)/).waitFor();
    assert.equal(await normalMcp.getAttribute("data-status"), "ready");

    const revokedKeyMcp = mcpButtonAt(1);
    await revokedKeyMcp.getByText(/MCP (?:검토|review)/).waitFor();
    assert.equal(await revokedKeyMcp.getAttribute("data-status"), "review",
      "key removal must downgrade an old approval to review");
    assert.doesNotMatch(await revokedKeyMcp.innerText(), /✓|1\/1/,
      "key removal must not retain a checkmark or inferred ready count");

    const registryFailureMcp = mcpButtonAt(2);
    await registryFailureMcp.getByText("MCP offline", { exact: true }).waitFor();
    assert.equal(await registryFailureMcp.getAttribute("data-status"), "offline",
      "a failed live lookup must render offline rather than a persisted approval");
    assert.doesNotMatch(await registryFailureMcp.innerText(), /✓|1\/1/);

    const zeroReadyMcp = mcpButtonAt(3);
    await zeroReadyMcp.getByText(/MCP (?:검토|review)/).waitFor();
    assert.equal(await zeroReadyMcp.getAttribute("data-status"), "review");
    assert.doesNotMatch(await zeroReadyMcp.innerText(), /✓|1\/1/,
      "zero live-ready rows must not be presented as ready");
    const blockedMcp = mcpButtonAt(4);
    await blockedMcp.getByText(/MCP (?:차단|blocked)/).waitFor();
    assert.equal(await blockedMcp.getAttribute("data-status"), "blocked");
    await blockedMcp.click();
    await page.waitForFunction(() => window.__sitePublishQa?.mcpReviewCalls?.includes("site-agent-app-5"));
    const rowTolerance = 2;
    assert.ok(firstPageLayout.slice(0, 3).every((item) => Math.abs(item.y - firstPageLayout[0].y) <= rowTolerance), "desktop gallery first row must contain three cards");
    assert.ok(firstPageLayout[3].y > firstPageLayout[0].y + 20, "desktop gallery fourth card must begin the second row");
    assert.ok(Math.abs(firstPageLayout[0].x - firstPageLayout[3].x) <= rowTolerance, "desktop gallery must wrap after three columns");

    const pagination = page.getByRole("navigation", { name: /Agent App 페이지|Agent App pages/ });
    assert.equal(await pagination.count(), 1, "ten Agent Apps must show pagination");
    assert.match((await pagination.innerText()).replace(/\s+/g, " "), /1\s*\/\s*2/, "first page indicator is missing");
    await pagination.getByRole("button", { name: /다음|Next/ }).click();
    await assertGalleryLayout(page, AGENT_APP_NAMES.slice(9));
    assert.match((await pagination.innerText()).replace(/\s+/g, " "), /2\s*\/\s*2/, "second page indicator is missing");
    await pagination.getByRole("button", { name: /이전|Previous/ }).click();
    await assertGalleryLayout(page, AGENT_APP_NAMES.slice(0, 9));

    const publishButton = page.locator("header").getByRole("button", { name: /^(게시|Publish)$/ });
    assert.equal(await publishButton.isDisabled(), true, "Publish must be disabled before an Agent App is selected");
    const firstSelection = page.locator('section[aria-labelledby="agent-apps-heading"] article button[aria-pressed]').first();
    await firstSelection.click();
    assert.equal(await firstSelection.getAttribute("aria-pressed"), "true", "Agent App card did not retain its selected state");
    assert.equal(await publishButton.isEnabled(), true, "selecting a ready Agent App must enable Publish");
    assert.match(await page.locator("header").innerText(), new RegExp(AGENT_APP_NAMES[0]), "header must identify the selected Agent App");

    const publishDialog = await openReadyAgentAppPublishDialog(page);
    const publishContract = await assertPublishDialogContract(page, publishDialog);
    const desktopPublishOverflow = await assertNoHorizontalOverflow(page, "desktop publish dialog");
    await publishDialog.getByLabel(/Git 저장소 URL|Git repository URL/).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outDir, "site-publish-desktop-render-1280x960.png"), fullPage: false });
    await publishDialog.getByRole("tab", { name: /^Vercel/ }).click();
    await publishDialog.getByText("vercel-qa-account", { exact: true }).waitFor();
    const desktopAccessPasscode = publishDialog.getByLabel("AGENTLAS_APP_ACCESS_KEY");
    await publishDialog.getByRole("button", { name: /안전하게 생성|Generate securely/ }).click();
    assert.match(await desktopAccessPasscode.inputValue(), /^[\x21-\x7E]{32,256}$/, "desktop proof must contain a valid generated app passcode");
    await desktopAccessPasscode.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outDir, "site-publish-desktop-1280x960.png"), fullPage: false });
    await publishDialog.getByRole("button", { name: /닫기|Close/ }).click();
    await publishDialog.waitFor({ state: "detached" });
    await assertNoPublishMutations(page);

    await templateButtons.nth(2).click();
    const agentPicker = page.getByRole("dialog", { name: /앱으로 만들 에이전트 선택|Choose an agent for this app/ });
    await agentPicker.waitFor();
    const mineTab = agentPicker.getByRole("tab", { name: /내 에이전트|My agents/ });
    const multiTab = agentPicker.getByRole("tab", { name: /멀티에이전트|Multi-agent/ });
    assert.equal(await mineTab.getAttribute("aria-selected"), "true", "My agents must be the default picker tab");
    assert.ok(await agentPicker.getByRole("option", { name: /리서치 에이전트|Research Agent/ }).count(), "My agents picker is empty");
    await multiTab.click();
    assert.equal(await multiTab.getAttribute("aria-selected"), "true", "Multi-agent tab did not activate");
    assert.ok(await agentPicker.getByRole("option", { name: /런치크루팀|LaunchCrewTeam/ }).count(), "team choice is missing");
    assert.ok(await agentPicker.getByRole("option", { name: /Founder HQ/ }).count(), "firm choice is missing");
    const groupChoice = agentPicker.getByRole("option", { name: /리서치 스쿼드/ });
    assert.ok(await groupChoice.count(), "agent group choice is missing");
    await groupChoice.click();
    await agentPicker.getByRole("button", { name: /이 에이전트로 만들기|Use this agent/ }).click();
    await page.getByRole("button", { name: /리서치 스쿼드.*Astryx/ }).waitFor();

    await resetSiteLandingScroll(page);
    await page.screenshot({ path: path.join(outDir, "site-desktop-1280x960.png"), fullPage: false });
    proof.desktop = {
      background,
      templates: templateLabels,
      firstPageCards: 9,
      pages: 2,
      columns: 3,
      overflow: desktopOverflow,
      publishOverflow: desktopPublishOverflow,
      publishContract,
      errors: [...new Set(errors)],
    };
    assert.deepEqual(proof.desktop.errors, [], `desktop console errors: ${proof.desktop.errors.join("\n")}`);
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mobile.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ teamRoster: true }));
    await mobile.addInitScript(installSiteFixtures, { thumbnailDataUrl });
    const mobilePage = await mobile.newPage();
    const mobileErrors = collectErrors(mobilePage);
    await mobilePage.goto(`${baseUrl}/site.html`, { waitUntil: "networkidle", timeout: 20_000 });
    await mobilePage.getByRole("heading", { name: /아이디어를 실제 인터페이스로|Turn an idea into a working interface/ }).waitFor();
    const mobileOverflow = await assertNoHorizontalOverflow(mobilePage, "mobile landing");
    assert.equal(await mobilePage.locator('section[aria-labelledby="site-template-heading"] button').count(), 3);
    await waitForGalleryPngs(mobilePage, 9);
    const mobileRatios = await mobilePage.locator('section[aria-labelledby="agent-apps-heading"] article button[aria-pressed] > span:first-child').evaluateAll((frames) => frames.map((frame) => {
      const box = frame.getBoundingClientRect();
      return box.width / box.height;
    }));
    assert.ok(mobileRatios.every((ratio) => Math.abs(ratio - 16 / 9) < 0.02), "mobile Agent App frames must remain 16:9");
    await resetSiteLandingScroll(mobilePage);
    await mobilePage.screenshot({ path: path.join(outDir, "site-mobile-390x844.png"), fullPage: false });

    const mobilePublishDialog = await openReadyAgentAppPublishDialog(mobilePage);
    const mobileHostingTabs = mobilePublishDialog.getByRole("tablist", { name: /호스팅 Provider|Hosting provider/ });
    assert.equal(await mobileHostingTabs.getByRole("tab").count(), 3, "mobile publish dialog lost a provider tab");
    await mobileHostingTabs.getByRole("tab", { name: /^Render/ }).click();
    const mobileRepositoryInput = mobilePublishDialog.getByLabel(/Git 저장소 URL|Git repository URL/);
    await mobileRepositoryInput.waitFor();
    assert.equal(await publishScope(mobilePublishDialog).locator('input[type="checkbox"]').count(), 4, "mobile Render dialog must omit the inapplicable secret-transfer consent");
    const mobileSourceConfirm = mobilePublishDialog.getByRole("checkbox", { name: /현재 검증된 Agent App 패키지|currently validated Agent App package/ });
    assert.equal(await mobileSourceConfirm.count(), 1, "mobile Render source confirmation is missing");
    const mobilePublishOverflow = await assertNoHorizontalOverflow(mobilePage, "mobile publish dialog");
    const mobileDialogMetrics = await mobilePublishDialog.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    assert.ok(mobileDialogMetrics.scrollWidth <= mobileDialogMetrics.clientWidth + 2, `mobile publish dialog overflows internally: ${mobileDialogMetrics.scrollWidth}px > ${mobileDialogMetrics.clientWidth}px`);
    assert.ok(mobileDialogMetrics.clientWidth <= mobileDialogMetrics.viewportWidth + 2, "mobile publish dialog is wider than the viewport");
    await mobileSourceConfirm.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await mobilePage.evaluate(() => window.scrollTo(0, 0));
    await mobilePage.screenshot({ path: path.join(outDir, "site-publish-mobile-render-390x844.png"), fullPage: false });
    await mobileHostingTabs.getByRole("tab", { name: /^Vercel/ }).click();
    await mobilePublishDialog.getByText("vercel-qa-account", { exact: true }).waitFor();
    const mobileAccessPasscode = mobilePublishDialog.getByLabel("AGENTLAS_APP_ACCESS_KEY");
    await mobilePublishDialog.getByRole("button", { name: /안전하게 생성|Generate securely/ }).click();
    assert.match(await mobileAccessPasscode.inputValue(), /^[\x21-\x7E]{32,256}$/, "mobile proof must contain a valid generated app passcode");
    await mobileAccessPasscode.scrollIntoViewIfNeeded();
    await mobilePage.evaluate(() => window.scrollTo(0, 0));
    await mobilePage.screenshot({ path: path.join(outDir, "site-publish-mobile-390x844.png"), fullPage: false });
    await assertNoPublishMutations(mobilePage);
    proof.mobile = {
      overflow: mobileOverflow,
      publishOverflow: mobilePublishOverflow,
      publishDialog: mobileDialogMetrics,
      errors: [...new Set(mobileErrors)],
    };
    assert.deepEqual(proof.mobile.errors, [], `mobile console errors: ${proof.mobile.errors.join("\n")}`);
    await mobile.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  fs.writeFileSync(path.join(outDir, "proof-summary.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`Site landing behavior contract passed. Proof: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
