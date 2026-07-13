#!/usr/bin/env node
// Playwright Electron 스모크 — 빌드된 앱을 띄우고 상단 메뉴를 실제 클릭(Next <Link> soft nav)으로
// 순회하며 콘솔/페이지 오류, raw-RSC 누수, 페이지 렌더 여부, 스크린샷을 수집한다.
//
// 사전: `npm run build` (dist/electron + dist/renderer). 실행: `npm run e2e:smoke`.
// 스크린샷은 release-local/e2e-shots/ 에 저장(gitignore). 오류가 1건이라도 있으면 exit 1.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release-local", "e2e-shots");
fs.mkdirSync(OUT, { recursive: true });

const main = path.join(ROOT, "dist", "electron", "main.js");
if (!fs.existsSync(main)) {
  console.error("[e2e] dist/electron/main.js 가 없습니다. 먼저 `npm run build` 하세요.");
  process.exit(2);
}

const errors = [];
const results = [];

// 외부 리소스 로드 실패(예: 샘플 데이터가 참조하는 죽은 CDN 미디어)는 앱 버그가 아니므로 무시한다.
// 실제 JS 오류(pageerror)와 앱 자체 콘솔 오류만 실패로 본다.
const isResourceLoad = (t) => /Failed to load resource|net::ERR|ERR_/i.test(t);

const app = await electron.launch({
  args: [main],
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "production",
    AGENTLAS_E2E: "1",
    AGENTLAS_E2E_AUTH: "1",
    AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
  },
  timeout: 30000,
});
const win = await app.firstWindow({ timeout: 30000 });
win.on("console", (m) => {
  if (m.type() === "error" && !isResourceLoad(m.text())) errors.push(m.text().slice(0, 240));
});
win.on("pageerror", (e) => errors.push("PAGEERR " + String(e).slice(0, 240)));
await win.waitForLoadState("domcontentloaded").catch(() => {});
await win.waitForTimeout(2500);
await win
  .evaluate(() => {
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "qa-suppressed");
    window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
    window.sessionStorage.setItem("agentlas.import.prompted", "1");
    window.location.href = "/dashboard";
  })
  .catch(() => {});
await win.waitForLoadState("domcontentloaded").catch(() => {});
await win.waitForTimeout(1200);

async function snap(name) {
  await win.waitForTimeout(1100);
  const text = await win.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  await win.screenshot({ path: path.join(OUT, name + ".png") }).catch(() => {});
  results.push({ name, url: win.url().replace("agentlas://app", ""), rawNext: text.includes("self.__next_f"), len: text.length });
}
async function hover(label) {
  try {
    await win.getByText(label, { exact: true }).first().hover({ timeout: 2000 });
    await win.waitForTimeout(350);
  } catch {
    /* dropdown 미존재 */
  }
}
async function clickLink(href) {
  const loc = win.locator(`a[href="${href}"]`).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.click({ timeout: 3000, force: true });
    return true;
  } catch {
    return false;
  }
}
async function openRoute(href) {
  if (await clickLink(href)) return true;
  await win
    .evaluate((target) => {
      window.location.href = target;
    }, href)
    .catch(() => {});
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  return true;
}
async function openTile(name, shot) {
  await hover("Agent Apps");
  await clickLink("/apps");
  await win.waitForTimeout(900);
  try {
    await win.getByText(name, { exact: false }).first().click({ timeout: 3000 });
    await snap(shot);
  } catch {
    results.push({ name: shot, error: "tile not found: " + name });
  }
}

await snap("00-dashboard");
await openRoute("/automation");
await snap("00b-automation");
await hover("Agent Forge");
if (await openRoute("/build")) await snap("01-build");
await hover("Agent Forge");
if (await openRoute("/library/agents")) await snap("02-agents");
if (await openRoute("/library/agent-groups")) await snap("02b-agent-groups");
await openTile("스타트업 창업자 스튜디오", "03-startup-studio");
await openTile("크리에이티브", "04-creative-studio");
await openTile("커머스", "05-ecommerce");
await hover("Hub");
if (await openRoute("/marketplace")) await snap("06-marketplace");
await hover("Hub");
if (await openRoute("/cloud")) await snap("07-cloud");
if (await openRoute("/settings")) await snap("08-settings");
if (await openRoute("/library/env")) await snap("09-environment");

await app.close().catch(() => {});

const rawNextPages = results.filter((r) => r.rawNext).map((r) => r.url);
console.log(JSON.stringify({ results, errorTotal: errors.length, errors: errors.slice(0, 30), rawNextPages, shotsDir: OUT }, null, 2));
if (errors.length > 0 || rawNextPages.length > 0) {
  console.error(`[e2e] FAIL — console/page errors: ${errors.length}, raw-RSC pages: ${rawNextPages.length}`);
  process.exit(1);
}
console.log("[e2e] PASS — no console/page errors, no raw-RSC leakage.");
