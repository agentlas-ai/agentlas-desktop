const assert = require("node:assert/strict");

const manifest = require("../dist/electron/architecture/manifest.js");
const { isAppBuilderWorthyPrompt, selectAutoRoutedAgent } = require("../dist/electron/agents/auto-router.js");

const appBuilder = manifest.BUILTIN_AGENTS.find((agent) => agent.slug === "agentlas-app-builder");
assert.ok(appBuilder, "agentlas-app-builder must be present in BUILTIN_AGENTS");
assert.equal(appBuilder.visibility, "background", "agentlas-app-builder must stay hidden/background");
assert.equal(appBuilder.role, "builder", "agentlas-app-builder must use the builder role");
assert.equal(manifest.builtinAgentId(appBuilder.slug), "builtin-agentlas-app-builder");
assert.match(manifest.ARCHITECTURE_VERSION, /^1\.(?:[5-9]|\d{2,})\./, "architecture version must be bumped past 1.4.x");

const installedAgents = manifest.BUILTIN_AGENTS.map((agent) => ({
  id: manifest.builtinAgentId(agent.slug),
  slug: agent.slug,
  name: agent.name,
  nameEn: agent.nameEn,
  tagline: agent.tagline,
  taglineEn: agent.taglineEn,
  systemPrompt: agent.systemPrompt,
  mcpServers: [],
  envRequirements: [],
  preferredBackend: null,
  trustGrade: "A",
  installedAt: "2026-06-03T00:00:00.000Z",
  tone: agent.tone,
  visibility: agent.visibility,
}));

const cases = [
  {
    locale: "ko",
    prompt: "Agentlas Apps Generate 모드가 켜져 있다. 사용자가 카드뉴스 전용 앱을 만들어달라고 했다.",
  },
  {
    locale: "ko",
    prompt: "내장 앱 빌더로 리서치 대시보드 앱 만들어줘",
  },
  {
    locale: "en",
    prompt: "Apps Generate mode is enabled. Generate an internal app for client onboarding.",
  },
  {
    locale: "en",
    prompt: "Use the app builder to create a workflow dashboard app.",
  },
];

for (const item of cases) {
  const choice = selectAutoRoutedAgent(item.prompt, installedAgents, item.locale);
  assert.ok(choice, `expected an auto-route for: ${item.prompt}`);
  assert.equal(choice.agent.slug, "agentlas-app-builder", `expected App Builder for: ${item.prompt}`);
  assert.equal(isAppBuilderWorthyPrompt(item.prompt), true, `expected app-worthy prompt: ${item.prompt}`);
}

const negativeCases = [
  { locale: "ko", prompt: "안녕" },
  { locale: "ko", prompt: "고마워" },
  { locale: "en", prompt: "hello" },
  { locale: "ko", prompt: "오늘 한 문단으로 답해줘" },
  { locale: "ko", prompt: "카드뉴스 주제 하나만 추천해줘" },
];

for (const item of negativeCases) {
  const choice = selectAutoRoutedAgent(item.prompt, installedAgents, item.locale);
  assert.ok(choice, `expected a safe fallback route for: ${item.prompt}`);
  assert.notEqual(choice.agent.slug, "agentlas-app-builder", `must not ask to create an App for: ${item.prompt}`);
  assert.equal(isAppBuilderWorthyPrompt(item.prompt), false, `expected non-app-worthy prompt: ${item.prompt}`);
}

console.log(`app-builder routing smoke passed (${cases.length} positive, ${negativeCases.length} negative, ${manifest.BUILTIN_AGENTS.length} built-ins, v${manifest.ARCHITECTURE_VERSION})`);
