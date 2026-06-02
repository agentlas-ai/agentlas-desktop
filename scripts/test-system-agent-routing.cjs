// 임시 테스트 — 온디맨드 디스커버리 라우팅(miss/over-trigger) 격리 검증.
const assert = require("node:assert/strict");
const { assembleSystemPrompt } = require("../dist/electron/system-agents/index.js");

// 실제 데스크톱 온디맨드 후보를 모사한 모듈 4종(+ alwaysOn 안전 모듈).
const modules = [
  {
    id: "surface",
    title: "Interactive surface builder",
    // 강신호만(모호한 report/table 제외) — 트리거 신뢰도는 키워드 품질이 좌우(over-trigger 방지)
    keywords: ["dashboard", "app", "interactive", "chart", "storefront", "operating", "대시보드", "앱", "차트", "스토어", "운영"],
    description: "Build an interactive mini-app / dashboard / operating surface for the user.",
    load: () => "[SURFACE_PROTOCOL ~16KB]",
  },
  {
    id: "connection",
    title: "Connect external accounts",
    keywords: ["connect", "account", "api key", "slack", "gmail", "github", "stripe", "oauth", "연결", "계정", "키"],
    description: "Help the user sign up / log in / create API keys for a third-party provider.",
    load: () => "[GLOBAL_CONNECTION_SKILL ~7KB]",
  },
  {
    id: "automation",
    title: "Schedule recurring automation",
    keywords: ["schedule", "every", "daily", "weekly", "monday", "recurring", "automate", "cron", "매일", "매주", "반복", "자동화"],
    description: "Register a recurring scheduled automation that runs the agent on a cadence.",
    load: () => "[AUTOMATION_PROTOCOL ~600c]",
  },
  {
    id: "safety",
    title: "Safety & identity rules",
    keywords: [],
    description: "Always-on safety/identity rules. Never gated.",
    load: () => "[SAFETY RULES]",
    alwaysOn: true,
  },
];

const CORE = "[CORE ~1.5KB: identity + output-contract + discovery-hint]";
const agent = { id: "desktop-chat", core: CORE, modules };

const cases = [
  { q: "make me a sales dashboard with charts and tables", expect: ["safety", "surface"] },
  { q: "connect my slack and gmail accounts please", expect: ["safety", "connection"] },
  { q: "run this report every monday morning automatically", expect: ["safety", "automation"] },
  { q: "안녕 오늘 기분 어때?", expect: ["safety"] }, // 단순 대화 → 코어만 (+alwaysOn)
  { q: "내 쇼핑몰 주문 대시보드 만들어줘", expect: ["safety", "surface"] },
];

let pass = 0;
for (const c of cases) {
  const r = assembleSystemPrompt(agent, c.q, { threshold: 0.8, maxModules: 3 });
  const got = r.loadedModuleIds.slice().sort();
  const want = c.expect.slice().sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} "${c.q}"`);
  console.log(`   loaded=[${r.loadedModuleIds.join(", ")}]  chars=${r.chars}  scores=${r.scores.map((s) => `${s.id}:${s.score.toFixed(2)}`).join(", ") || "(none)"}`);
  if (ok) pass++;
  else console.log(`   EXPECTED=[${c.expect.join(", ")}]`);
}

// 토큰 절감 증명: 단순 대화는 코어만(~안전 포함), full 24KB 대비.
const simple = assembleSystemPrompt(agent, "안녕", { threshold: 0.8 });
const full = CORE.length + modules.reduce((n, m) => n + m.load().length, 0);
console.log(`\nsimple-chat assembled chars=${simple.chars}  vs  always-on-all≈${full}  → 단순 대화에서 무거운 모듈 0개 로드`);

console.log(`\n${pass}/${cases.length} synthetic routing cases passed`);

// ── 실제 desktop-chat 시스템 에이전트 spec으로 라우팅 검증 ──
const { DESKTOP_CHAT_AGENT } = require("../dist/electron/system-agents/desktop-chat/index.js");
const realCases = [
  { q: "build me an interactive sales dashboard with charts", expect: ["surface"] },
  { q: "connect my stripe account please", expect: ["connection"] },
  { q: "run this report every monday morning", expect: ["automation"] },
  { q: "what is 2 + 2?", expect: [] }, // 단순 질문 → 코어만(무거운 모듈 0)
  { q: "내 쇼핑몰 운영 대시보드 만들어줘", expect: ["surface"] },
  { q: "내 슬랙 계정 연결해줘", expect: ["connection"] },
];
let rpass = 0;
console.log("\n=== real desktop-chat spec ===");
for (const c of realCases) {
  const r = assembleSystemPrompt(DESKTOP_CHAT_AGENT, c.q, { threshold: 0.8, maxModules: 3 });
  const got = r.loadedModuleIds.slice().sort();
  const ok = JSON.stringify(got) === JSON.stringify(c.expect.slice().sort());
  console.log(`${ok ? "✓" : "✗"} "${c.q}" → [${r.loadedModuleIds.join(", ") || "core-only"}]`);
  if (ok) rpass++;
  else console.log(`   EXPECTED=[${c.expect.join(", ")}]  scores=${r.scores.map((s) => `${s.id}:${s.score.toFixed(2)}`).join(", ")}`);
}
console.log(`\n${rpass}/${realCases.length} real-spec routing cases passed`);

// ── 메모리 시스템 에이전트 spec ──
const { MEMORY_SYSTEM_AGENT, MEMORY_CORE } = require("../dist/electron/system-agents/memory/index.js");
const memCases = [
  { q: "remember that I prefer dark mode", expect: ["memory-schema"] },
  { q: "이 결정을 기억해줘", expect: ["memory-schema"] },
  { q: "what's the weather like?", expect: [] }, // 단순 질문 → 스키마 미로드(코어 트리거만)
];
let mpass = 0;
console.log("\n=== memory system agent spec ===");
for (const c of memCases) {
  const r = assembleSystemPrompt(MEMORY_SYSTEM_AGENT, c.q, { threshold: 0.4, maxModules: 1 });
  const got = r.loadedModuleIds.slice().sort();
  const ok = JSON.stringify(got) === JSON.stringify(c.expect.slice().sort());
  console.log(`${ok ? "✓" : "✗"} "${c.q}" → [${r.loadedModuleIds.join(", ") || "core-only"}]  chars=${r.chars}`);
  if (ok) mpass++;
}
// 코어가 emit에 필요한 enum을 항상 포함(capability 보존)
const coreOk = MEMORY_CORE.includes("memory_kind") && MEMORY_CORE.includes("suggested_scope") && MEMORY_CORE.includes("Never record secrets");
console.log(`core always carries kinds/scopes + safety: ${coreOk ? "✓" : "✗"}`);
console.log(`\n${mpass}/${memCases.length} memory routing cases passed`);

process.exit(pass === cases.length && rpass === realCases.length && mpass === memCases.length && coreOk ? 0 : 1);
