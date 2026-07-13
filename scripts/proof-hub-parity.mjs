import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outDir = path.resolve(process.cwd(), process.env.HUB_PARITY_ARTIFACT_DIR ?? path.join("artifacts", "hub-parity"));
const liveUrl = process.env.AGENTLAS_WEB_HUB_URL ?? "https://agentlas.cloud/marketplace";
const desktopUrl = process.env.AGENTLAS_DESKTOP_HUB_URL ?? "http://127.0.0.1:3100/marketplace";
const viewport = { width: 1440, height: 980 };

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();

async function capture(name, url, initScript) {
  const context = await browser.newContext({ viewport });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  const snapshot = await page.evaluate(() => {
    const body = document.body;
    const main = document.querySelector("main") ?? body;
    const headings = Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 12).map((node) => node.textContent?.trim()).filter(Boolean);
    const buttons = Array.from(document.querySelectorAll("button,a")).slice(0, 32).map((node) => node.textContent?.trim()).filter(Boolean);
    const tabs = Array.from(document.querySelectorAll('[role="tab"],button')).map((node) => node.textContent?.trim()).filter((text) => /team|plugin|agent|팀|플러그인|에이전트/i.test(text ?? ""));
    const bodyStyle = getComputedStyle(body);
    const mainStyle = getComputedStyle(main);
    const firstCard = document.querySelector("article, [class*=card], [class*=Card]");
    const cardStyle = firstCard ? getComputedStyle(firstCard) : null;
    return {
      title: document.title,
      url: location.href,
      bodyTextLength: body.innerText.trim().length,
      headings,
      buttons,
      tabs,
      styles: {
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        mainBackground: mainStyle.backgroundColor,
        cardBackground: cardStyle?.backgroundColor ?? null,
        cardBorder: cardStyle?.borderColor ?? null,
        cardRadius: cardStyle?.borderRadius ?? null,
      },
    };
  });
  await context.close();
  return { name, url, errors, snapshot };
}

const desktopInit = () => {
  try {
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "qa-suppressed");
    window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
  } catch {}
  const now = new Date().toISOString();
  const agent = {
    id: "agent-1",
    slug: "builder-agent",
    name: "Builder Agent",
    nameEn: "Builder Agent",
    tagline: "Build execution agent",
    taglineEn: "Build execution agent",
    kind: "agent",
    tone: "purple",
    visibility: "local",
    systemPrompt: "# Builder",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
  };
  const firm = {
    id: "firm-1",
    slug: "founder-hq",
    name: "Founder HQ",
    nameEn: "Founder HQ",
    tagline: "Team for founder work",
    taglineEn: "Team for founder work",
    ceoAgentId: "agent-1",
    orgChart: [{ agentSlug: "builder-agent", agentId: "agent-1", role: "Builder", reportsTo: null }],
  };
  const plugins = [
    {
      id: "slack",
      name: "Slack",
      description: "Workspace notification and collaboration bridge.",
      status: "available",
      tools: ["send_message"],
      installed: false,
    },
  ];
  window.agentlas = {
    app: {
      getLocale: async () => "en-US",
      getVersion: async () => "0.2.32",
    },
    locale: { get: () => "en", set: () => {} },
    auth: {
      getSession: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signInWithGoogle: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signOut: async () => ({ signedIn: false }),
    },
    cloud: { getState: async () => ({ status: "idle" }) },
    updater: {
      getState: async () => ({ status: "idle" }),
      check: async () => ({ status: "idle" }),
      install: async () => {},
    },
    fs: { pickDirectory: async () => "/tmp/agentlas-hub-parity" },
    team: { list: async () => [agent], install: async () => agent, importLocalFolder: async () => agent },
    firms: { list: async () => [firm], install: async () => firm, getResolvedOrg: async () => ({ firmId: firm.id, ceo: { name: "Builder Agent", agentId: agent.id }, divisions: [] }) },
    agentGroups: {
      list: async () => [],
      listResolved: async () => [],
      getResolved: async () => null,
      create: async (input) => ({ id: "group-1", ...input, members: input.members ?? [], createdAt: now, updatedAt: now }),
      update: async (id, patch) => ({ id, name: patch.name ?? "QA Group", description: patch.description ?? "", orchestratorName: patch.orchestratorName ?? "QA Group Orchestrator", members: patch.members ?? [], createdAt: now, updatedAt: now }),
      removeMember: async () => ({ id: "group-1", name: "QA Group", description: "", orchestratorName: "QA Group Orchestrator", members: [], createdAt: now, updatedAt: now }),
      remove: async () => {},
    },
    mcpTools: {
      listCatalog: async () => plugins,
      listInstalled: async () => [],
      install: async (id) => ({ ok: true, id, catalogId: id, installedAt: now }),
    },
    marketplace: {
      listBundles: async () => [],
      listFirms: async () => [firm],
      search: async () => [agent],
      status: async () => ({ mode: "mcp", baseUrl: "mock", online: true, usingFallback: false, lastError: null, lastCheckedAt: now }),
      listMine: async () => [],
      bookmarks: async () => [],
      bookmarkAdd: async (listing) => ({ slug: listing.slug, listing, bookmarkedAt: now }),
      bookmarkRemove: async () => {},
    },
    hephaestus: {
      status: async () => ({ available: true, version: "0.0.0-proof" }),
      startStudio: async () => ({ ok: true, url: "/surface-preview" }),
    },
  };
};

try {
  const live = await capture("agentlas-web-marketplace", liveUrl);
  const desktop = await capture("desktop-marketplace", desktopUrl, desktopInit);
  const proof = {
    ok: live.errors.length === 0 && desktop.errors.length === 0,
    recordedAt: new Date().toISOString(),
    viewport,
    liveUrl,
    desktopUrl,
    live,
    desktop,
  };
  fs.writeFileSync(path.join(outDir, "hub-parity-proof.json"), JSON.stringify(proof, null, 2) + "\n", "utf8");
  if (!proof.ok) {
    console.error(JSON.stringify(proof, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await browser.close();
}
