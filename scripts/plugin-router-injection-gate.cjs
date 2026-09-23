#!/usr/bin/env node
"use strict";
/*
 * plugin-router-injection-gate — 설치된 플러그인의 라우터가 실제로 프롬프트에 들어가는가.
 *
 * 이 게이트가 지키는 것은 규격 §4.1 이 지적한 구멍이다: 스킬 번들이
 * ~/.agentlas/plugins/<slug>/skills/ 에 착지해도 그것을 **읽는 코드가 없으면** 플러그인은
 * 존재하지 않는 것과 같다. 파일 착지와 모델 도달은 다른 사건이다.
 *
 * 예산도 함께 지킨다 — 플러그인이 늘어날수록 커지는 것은 목록(플러그인당 몇 줄)이어야 하고,
 * 라우터 전문은 이번 턴에 호출된 것만이어야 한다.
 *
 * 실행: node scripts/plugin-router-injection-gate.cjs   (npm run build:electron 이후)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIST = path.resolve(__dirname, "..", "dist");
const mod = path.join(DIST, "electron/plugins/router-prompt.js");
if (!fs.existsSync(mod)) {
  console.log("SKIP — dist/ not built. Run `npm run build:electron` first.");
  process.exit(0);
}
const { pluginRouterPrompt, resetPluginRouterCache } = require(mod);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// 설치본이 없으면 이 게이트는 판정할 대상이 없다 — 통과로 위장하지 않고 그렇게 말한다.
const root = path.join(os.homedir(), ".agentlas", "plugins");
const installed = fs.existsSync(root)
  ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
  : [];
const withRouter = installed.filter((slug) => fs.existsSync(path.join(root, slug, "skills", "index", "SKILL.md")));
if (!withRouter.length) {
  console.log(`SKIP — no installed plugin ships a router (checked ${root}). Boot the app once to materialize built-ins.`);
  process.exit(0);
}

resetPluginRouterCache();
const slug = withRouter[0];
const mention = `@${slug}`;
const listOnly = pluginRouterPrompt("write me a haiku about tuesday");
const invoked = pluginRouterPrompt(`${mention} redesign this screen`);

check("router-bearing plugin appears in the always-on list", listOnly.includes(mention), `looked for ${mention}`);
check("the list names the router file so the model can open it", /Router: .*SKILL\.md/.test(listOnly));
check("the list explains $skill / @tool resolution", listOnly.includes("`$name`") && listOnly.includes("`@name`"));
// 2026-09-23: a missing tool is no longer a stop — the rule is "use native abilities,
// resolve installed/Hub plugins, and never describe work you could not carry out".
check("the list carries the honesty rule about missing tools", /Never describe work you could not carry out/.test(listOnly));
check("the list routes a missing tool to plugin resolution instead of a dead end",
  /agentlas_resolve_plugins/.test(listOnly) && !/say so and stop/i.test(listOnly));

const routerBody = fs.readFileSync(path.join(root, slug, "skills", "index", "SKILL.md"), "utf8");
const marker = (routerBody.split("\n").find((l) => l.startsWith("# ")) || "# Skill Purpose").trim();
check("mentioning the plugin inlines its full router", invoked.includes(marker), `marker ${JSON.stringify(marker)}`);
check("not mentioning it does NOT inline the full router (budget)", !listOnly.includes(marker));
check("invoked prompt is larger than the list", invoked.length > listOnly.length, `${listOnly.length} → ${invoked.length}`);

// 예산: 목록은 **플러그인당** 몇 줄이어야 한다. 예전에는 목록 전체를 라우터 하나와 비교했는데,
// 설치된 플러그인이 늘면(과학 번들 20여 개) 목록 전체는 정당하게 커진다 — 그 비교는 설치 개수를
// 재고 있었지 규칙을 재고 있지 않았다(2026-09-23: 5908 vs 1266 로 거짓 FAIL). 이제 두 가지를 잰다:
// 고정 머리말(사용법·정직 규칙)은 상한이 있고, 플러그인 한 개의 블록은 몇 줄(이름·설명·라우터 경로·
// 스킬 목록)을 넘지 않으며 라우터 전문을 싣지 않는다.
const firstBlock = listOnly.indexOf("\n### @");
const preamble = firstBlock >= 0 ? listOnly.slice(0, firstBlock) : listOnly;
const blocks = firstBlock >= 0 ? listOnly.slice(firstBlock + 1).split(/\n(?=### @)/) : [];
const PER_PLUGIN_BUDGET = 900;
const oversized = blocks.filter((block) => block.length > PER_PLUGIN_BUDGET || block.split("\n").filter(Boolean).length > 5);
check("the fixed preamble stays bounded", preamble.length < 2400, `preamble ${preamble.length}`);
check("each plugin's always-on block is a few lines, not its router",
  blocks.length > 0 && oversized.length === 0,
  `${blocks.length} blocks, largest ${Math.max(0, ...blocks.map((b) => b.length))} chars${oversized.length ? `; oversized: ${oversized.map((b) => b.split("\n")[0]).join(", ")}` : ""}`);

console.log(failed ? `\n${failed} failure(s)` : "\nrouter injection OK");
process.exit(failed ? 1 : 0);
