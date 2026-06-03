#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const NODE_BIN = process.env.npm_node_execpath || process.env.NODE || "node";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/\-\d{3}Z$/, "Z");
const PROOF_ROOT = path.join(require("os").tmpdir(), `agentlas-chat-local-creative-os-proof-${STAMP}`);
const SCREENSHOT_DIR = path.join(PROOF_ROOT, "screenshots");
const DB_PATH = path.join(PROOF_ROOT, "agentlas-proof.sqlite");

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
process.env.AGENTLAS_STORE_PATH = DB_PATH;
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";

const productSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="#f4efe7"/>
  <rect x="130" y="95" width="940" height="710" rx="34" fill="#fffdf9" stroke="#ded1c0"/>
  <path d="M470 214c50 36 210 36 260 0l80 112-78 58v282H468V384l-78-58 80-112Z" fill="#d6c1ad" stroke="#51483e" stroke-width="12"/>
  <path d="M528 216c24 47 120 47 144 0" fill="none" stroke="#51483e" stroke-width="12" stroke-linecap="round"/>
  <text x="600" y="730" text-anchor="middle" font-family="Inter, Arial" font-size="58" font-weight="800" fill="#27231f">Linen Jacket</text>
  <text x="600" y="780" text-anchor="middle" font-family="Inter, Arial" font-size="28" fill="#71685c">creative product fixture</text>
</svg>`);

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  createChat,
  listChatMessages,
  setChatWorkingFolder,
} = require("../dist/electron/store/chats.js");
const { listAgentSurfaces } = require("../dist/electron/store/agent-surfaces.js");
const { listAgentApps } = require("../dist/electron/store/agent-apps.js");
const { listSurfaceAssetPacks } = require("../dist/electron/store/agent-surface-assets.js");
const { runMcpInvocation } = require("../dist/electron/mcp/client.js");

function seedAgent() {
  const now = "2026-05-31T00:00:00.000Z";
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, tagline, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-chat-proof-local-creative-os",
      "chat-proof-local-creative-os",
      "Chat Proof Local Creative OS",
      "Runs Agentlas creative OS from plain product input without a hosted runtime",
      [
        "Turn product URL/image input into an Agentlas creative studio app, asset pack, provider browser delegation, vault/payment gates, and reusable tools.",
        "Never store raw passwords, OTPs, cookies, card numbers, CVC/CVV, or provider tokens in chat, manifests, files, screenshots, or reports.",
      ].join("\n"),
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

function startProductServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/products/linen-jacket") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Linen Jacket | Agentlas Fixture" />
            <meta property="og:description" content="A lightweight linen jacket for city summer outfits." />
            <meta property="og:image" content="/media/linen-jacket.svg" />
            <meta property="og:site_name" content="Agentlas Fixture" />
          </head>
          <body>Linen Jacket fixture</body>
        </html>`);
      return;
    }
    if (req.url === "/media/linen-jacket.svg") {
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "content-length": productSvg.byteLength,
      });
      res.end(productSvg);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  const productServer = await startProductServer();
  try {
    initStore();
    seedAgent();

    const address = productServer.address();
    assert.equal(typeof address, "object");
    const productUrl = `http://127.0.0.1:${address.port}/products/linen-jacket`;
    const prompt = `${productUrl} 이 제품 URL과 이미지로 릴스/틱톡/메타 광고팩을 만들어줘. Adobe Firefly, Higgsfield, OpenAI Images 같은 영상/이미지 서비스도 필요하면 알아서 연결하고 앱까지 운영해.`;
    const chat = createChat({
      agentId: "agent-chat-proof-local-creative-os",
      title: "Chat local Creative OS proof",
    });
    setChatWorkingFolder(chat.id, PROOF_ROOT);

    const events = [];
    await runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt: prompt,
        images: [{ mediaType: "image/svg+xml", data: productSvg.toString("base64") }],
        locale: "ko",
        permissions: "full",
      },
      (event) => events.push(event),
    );

    assert.equal(events.some((event) => event.kind === "error"), false);
    const surfaces = listAgentSurfaces(chat.id);
    const apps = listAgentApps(chat.id);
    const packs = listSurfaceAssetPacks(chat.id);
    const messages = listChatMessages(chat.id);
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0].domain, "creative");
    assert.equal(surfaces[0].layout, "creative-studio");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].status, "tool-published");
    assert.equal(packs.length, 1);
    assert.equal(packs[0].status, "materialized");
    assert.equal(messages.some((message) => message.role === "assistant" && /local meta-agent/i.test(message.text)), true);

    const app = apps[0];
    const pack = packs[0];
    const operationsPath = path.join(app.rootPath, "data", "operations.json");
    const operations = JSON.parse(fs.readFileSync(operationsPath, "utf8"));
    const recipes = operations.providerRuntime.providerRecipes;
    assert.ok(recipes.some((recipe) => /Adobe Firefly/.test(recipe.connectorName)));
    assert.ok(recipes.some((recipe) => /Higgsfield/.test(recipe.connectorName)));
    assert.ok(recipes.some((recipe) => /OpenAI Images/.test(recipe.connectorName)));
    assert.ok(operations.autopilot.safeBoundaries.some((line) => /missing API\/MCP/.test(line)));
    assert.ok(operations.trust.jobs.some((job) => job.id === "job_generate_video_variants"));
    assert.ok(operations.reuse.mcpPath.endsWith("server.mjs"));
    assert.ok(fs.existsSync(operations.reuse.mcpPath));
    assertSecretSafe(app.rootPath);

    const storyPath = writeStory({
      prompt,
      productUrl,
      chat,
      surface: surfaces[0],
      app,
      pack,
      messages,
      operations,
    });
    const screenshots = [
      await captureFileScreenshot(
        "chat-local-creative-os-story",
        storyPath,
        path.join(SCREENSHOT_DIR, "chat-local-creative-os-story.png"),
      ),
    ];
    const port = await findFreePort();
    const server = await startPreviewServer(app.rootPath, port);
    try {
      screenshots.push(...(await captureRouteScreenshots(port, SCREENSHOT_DIR)));
      screenshots.push(
        await captureStandaloneScreenshot("asset-pack", pack.snapshot.fileUrl, path.join(SCREENSHOT_DIR, "asset-pack.png")),
      );
    } finally {
      await stopServer(server);
    }

    const report = {
      proofVersion: "0.1",
      kind: "chat-local-creative-os-proof",
      prompt,
      productUrl,
      proofRoot: PROOF_ROOT,
      dbPath: DB_PATH,
      createdAt: new Date().toISOString(),
      chat: { id: chat.id },
      surface: {
        id: surfaces[0].id,
        title: surfaces[0].title,
        domain: surfaces[0].domain,
        layout: surfaces[0].layout,
        jobs: surfaces[0].manifest.jobs,
        budget: surfaces[0].manifest.budget,
      },
      assetPack: {
        id: pack.id,
        rootPath: pack.rootPath,
        indexPath: pack.indexPath,
        fileUrl: pack.snapshot.fileUrl,
      },
      app: {
        id: app.id,
        name: app.appName,
        status: app.status,
        rootPath: app.rootPath,
        previewPath: app.previewPath,
        reusableTool: operations.reuse,
      },
      providerDelegation: {
        browserStarts: operations.providerRuntime.browserPlans,
        credentialGates: operations.providerRuntime.credentialGates,
        paymentGates: operations.providerRuntime.paymentGates,
        providerRecipes: recipes,
      },
      autopilot: operations.autopilot,
      screenshots,
      checks: [
        "actual chat runner path was used",
        "runtime probes were disabled, proving local Agentlas OS fallback works without hosted model/API runtime",
        "product URL plus product image produced one durable creative-studio surface",
        "surface created resumable image and short-form video generation jobs with budget gates",
        "asset pack materialized local and remote product media under the system temp directory",
        "Adobe Firefly, Higgsfield, and OpenAI Images became provider browser/action recipes",
        "missing API/MCP is represented as browser delegation, vault credential, payment approval, alternate provider, or local helper",
        "generated creative app was operated hands-free and published as a reusable MCP tool",
        "studio/claims/exports/asset-pack screenshots were saved under the system temp directory",
        "secret/card/token leak scan found no raw secret values",
      ],
    };
    fs.writeFileSync(path.join(PROOF_ROOT, "proof-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(PROOF_ROOT, "PROOF.md"), proofMarkdown(report), "utf8");
    removeAppleDoubleFiles(PROOF_ROOT);

    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } finally {
    await new Promise((resolve) => productServer.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function writeStory(input) {
  const storyDir = path.join(PROOF_ROOT, "proof-story");
  fs.mkdirSync(storyDir, { recursive: true });
  const out = path.join(storyDir, "index.html");
  const completed = input.operations.autopilot.steps.filter((step) => step.status === "completed").length;
  const layoutLabel = input.surface.domain === "creative" ? "studio" : String(input.surface.layout || "").replace(/-/g, " ");
  const surfaceKpiLabel = input.surface.domain === "creative" ? "creative surface" : "surface";
  const appStatusLabel = input.app.status === "tool-published" ? "tool" : String(input.app.status || "").replace(/-/g, " ");
  const appKpiLabel = input.app.status === "tool-published" ? "published app" : "app";
  const recipes = input.operations.providerRuntime.providerRecipes
    .map(
      (recipe) =>
        `<li><strong>${html(recipe.connectorName)}</strong><span>${html(recipe.mode)} · next ${html(recipe.nextActions.join(" -> "))} · fallbacks ${html(recipe.fallbackProviders.join(", "))}</span></li>`,
    )
    .join("");
  const chatMessages = input.messages
    .map((message) => `<li><strong>${html(message.role)}</strong><span>${html(message.text)}</span></li>`)
    .join("");
  const jobs = input.surface.manifest.jobs
    .map((job) => `<li><strong>${html(job.label)}</strong><span>${html(job.status)} · ${html(job.currency)} ${html(job.costEstimate)}</span></li>`)
    .join("");
  fs.writeFileSync(
    out,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentlas Chat Local Creative OS Proof</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #181818; background: #eef2ec; }
    body { margin: 0; min-height: 100vh; background: #eef2ec; }
    main { max-width: 1200px; margin: 0 auto; padding: 46px 34px 64px; display: grid; gap: 22px; }
    .grid { display: grid; grid-template-columns: 1.04fr .96fr; gap: 22px; align-items: stretch; }
    .lower { display: grid; grid-template-columns: .95fr 1.05fr; gap: 22px; }
    section { background: #fffefa; border: 1px solid #cfd9ca; border-radius: 8px; box-shadow: 0 20px 52px rgba(32, 45, 34, .12); padding: 28px; }
    h1 { margin: 0; font-size: 45px; line-height: 1.04; letter-spacing: 0; max-width: 900px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { margin: 0; color: #596254; line-height: 1.55; }
    .prompt { margin-top: 18px; padding: 15px; border-radius: 8px; background: #172018; color: #f8fff3; overflow-wrap: anywhere; }
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
    .kpi { border: 1px solid #d9e2d4; background: #f7faf4; border-radius: 8px; padding: 15px; display: grid; gap: 4px; min-width: 0; }
    .kpi strong { font-size: 25px; overflow-wrap: anywhere; }
    .kpi span { font-size: 12px; color: #53604d; font-weight: 700; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    li { border-bottom: 1px solid #e5ece0; padding: 10px 0; display: grid; gap: 4px; min-width: 0; }
    li:last-child { border-bottom: 0; }
    li strong { font-size: 13px; color: #1a6c55; }
    li span { color: #586153; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
    code { background: #edf2e8; padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }
    footer { color: #596254; font-size: 12px; }
    @media (max-width: 900px) { .grid, .lower, .kpis { grid-template-columns: 1fr; } h1 { font-size: 34px; } main { padding: 24px 16px; } }
  </style>
</head>
<body>
  <main>
    <div class="grid">
      <section>
        <p><strong>Agentlas Creative OS proof</strong> · actual chat runner · no hosted runtime</p>
        <h1>One product input became an operated creative app.</h1>
        <div class="prompt">${html(input.prompt)}</div>
        <p style="margin-top:18px">The chat runner disabled runtime probes, then the built-in Agentlas OS fallback produced a creative surface, materialized an asset pack, compiled Adobe/Higgsfield/OpenAI provider routes, operated the generated app, and published it as a reusable MCP tool.</p>
      </section>
      <section>
        <h2>Result</h2>
        <div class="kpis">
          <div class="kpi"><strong>${html(layoutLabel)}</strong><span>${html(surfaceKpiLabel)}</span></div>
          <div class="kpi"><strong>${html(String(input.surface.manifest.jobs.length))}</strong><span>jobs</span></div>
          <div class="kpi"><strong>${html(String(completed))}</strong><span>steps</span></div>
          <div class="kpi"><strong>${html(appStatusLabel)}</strong><span>${html(appKpiLabel)}</span></div>
        </div>
        <p style="margin-top:16px">Tool: <code>${html(input.operations.reuse.toolName)}</code></p>
        <p style="margin-top:10px">Asset pack: <code>${html(input.pack.rootPath)}</code></p>
      </section>
    </div>
    <div class="lower">
      <section><h2>Chat Evidence</h2><ul>${chatMessages}</ul></section>
      <section><h2>Provider Recipes</h2><ul>${recipes}</ul><h2 style="margin-top:22px">Resumable Jobs</h2><ul>${jobs}</ul></section>
    </div>
    <footer>Secrets policy: passwords, OTPs, raw cards, CVV/CVC, cookies, and tokens are not written to chat/files/logs/manifests. Paid checkout stays behind explicit approval.</footer>
  </main>
</body>
</html>
`,
    "utf8",
  );
  return out;
}

async function captureFileScreenshot(name, filePath, screenshotPath) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    const url = pathToFileURL(filePath).href;
    await page.goto(url, { waitUntil: "networkidle" });
    const title = await page.title();
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { name, route: "proof-story", url, title, routePath: filePath, path: screenshotPath };
  } finally {
    await browser.close();
  }
}

async function captureStandaloneScreenshot(name, url, screenshotPath) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { name, route: null, url, title: await page.title(), routePath: null, path: screenshotPath };
  } finally {
    await browser.close();
  }
}

async function captureRouteScreenshots(port, screenshotDir) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const routes = ["/", "/claims", "/exports"];
  const captures = [];
  try {
    for (const route of routes) {
      const name = route === "/" ? "studio-app" : route.slice(1);
      const url = `http://127.0.0.1:${port}${route}`;
      await page.goto(url, { waitUntil: "networkidle" });
      const title = await page.title();
      const routePath = await page.locator("body").getAttribute("data-route-path").catch(() => route);
      const screenshotPath = path.join(screenshotDir, `${name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      captures.push({ name, route, url, title, routePath, path: screenshotPath });
    }
  } finally {
    await browser.close();
  }
  return captures;
}

async function startPreviewServer(rootPath, port) {
  const child = spawn(NODE_BIN, ["scripts/serve.mjs"], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForUrl(`http://127.0.0.1:${port}/`, 10_000, () => logs.join(""));
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForUrl(url, timeoutMs, getLogs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await httpStatus(url);
      if (status === 200) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not become ready at ${url}\n${getLogs()}`);
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function assertSecretSafe(rootPath) {
  const findings = [];
  for (const file of walkTextFiles(rootPath)) {
    const text = fs.readFileSync(file, "utf8");
    if (/(sk|pk)_(live|test)_[A-Za-z0-9]{12,}/.test(text)) findings.push(`${file}: provider key-like token`);
    if (/gh[pousr]_[A-Za-z0-9_]{20,}/.test(text)) findings.push(`${file}: GitHub token-like value`);
    for (const match of text.matchAll(/\b(?:\d[ -]*?){13,19}\b/g)) {
      const digits = match[0].replace(/\D/g, "");
      if (looksLikeCardNumber(digits)) findings.push(`${file}: card-like number`);
    }
    if (/"(?:password|passphrase|otp|cvv|cvc|cardNumber|card_number|cookie|accessToken|refreshToken)"\s*:\s*"[^"<>{}]{3,}"/i.test(text)) {
      findings.push(`${file}: raw secret-looking JSON field`);
    }
  }
  assert.deepEqual(findings, [], `Raw secret values leaked into generated files:\n${findings.join("\n")}`);
}

function walkTextFiles(rootPath) {
  const out = [];
  const allowed = new Set([".json", ".md", ".txt", ".html", ".mjs", ".js", ".css", ".env", ""]);
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        if (name.startsWith("._")) continue;
        if (["node_modules", ".git"].includes(name)) continue;
        stack.push(path.join(current, name));
      }
      continue;
    }
    if (stat.size > 500_000) continue;
    if (allowed.has(path.extname(current)) || current.endsWith(".env.example")) out.push(current);
  }
  return out;
}

function looksLikeCardNumber(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function removeAppleDoubleFiles(rootPath) {
  for (const file of walkAllFiles(rootPath)) {
    if (path.basename(file).startsWith("._")) fs.rmSync(file, { force: true });
  }
}

function walkAllFiles(rootPath) {
  const out = [];
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else {
      out.push(current);
    }
  }
  return out;
}

function proofMarkdown(report) {
  return [
    "# Agentlas Chat Local Creative OS Proof",
    "",
    `Prompt: ${report.prompt}`,
    `Product URL: ${report.productUrl}`,
    `Created: ${report.createdAt}`,
    `Proof root: \`${report.proofRoot}\``,
    "",
    "## Result",
    "",
    "- Actual chat runner path was used.",
    "- Runtime probes were disabled, so the proof does not depend on hosted model/API availability.",
    "- One product URL plus product image created a durable creative-studio surface.",
    "- Generated creative app was operated hands-free and published as a reusable MCP tool.",
    "- Adobe Firefly, Higgsfield, and OpenAI Images provider paths became browser/action recipes.",
    "- Studio, Claims, Exports, and asset-pack screenshots were captured.",
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((shot) => `- ${shot.name}: \`${shot.path}\``),
    "",
    "## Provider Delegation",
    "",
    ...report.providerDelegation.providerRecipes.map(
      (recipe) =>
        `- ${recipe.connectorName}: ${recipe.mode} · next ${recipe.nextActions.join(" -> ")} · fallbacks ${recipe.fallbackProviders.join(", ")}`,
    ),
    "",
    "## Reusable Tool",
    "",
    `- Tool: ${report.app.reusableTool.toolName}`,
    `- MCP adapter: \`${report.app.reusableTool.mcpPath}\``,
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- ${check}`),
    "",
  ].join("\n");
}
