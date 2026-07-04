#!/usr/bin/env node
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release-local", "oberon-motion-app");
fs.mkdirSync(OUT, { recursive: true });

const main = path.join(ROOT, "dist", "electron", "main.js");
if (!fs.existsSync(main)) {
  console.error("[oberon-motion-app] dist/electron/main.js is missing. Run npm run build first.");
  process.exit(2);
}

const errors = [];
const app = await electron.launch({
  args: [main],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "production", AGENTLAS_E2E: "1" },
  timeout: 30_000,
});

const win = await app.firstWindow({ timeout: 30_000 });
win.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error" && !/Failed to load resource|net::ERR|ERR_/i.test(text)) {
    errors.push(text.slice(0, 300));
  }
});
win.on("pageerror", (err) => errors.push(`PAGEERR ${String(err).slice(0, 300)}`));

await win.waitForLoadState("domcontentloaded").catch(() => {});
await win.evaluate(() => {
  window.localStorage.setItem("agentlas.onboarded", "1");
  window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
  window.sessionStorage.setItem("agentlas.import.prompted", "1");
  window.location.href = "/apps";
});
await win.waitForLoadState("domcontentloaded").catch(() => {});
await win.getByText(/에이전트 앱 4개|4 agent apps/).waitFor({ timeout: 20_000 });
const motionMenuVisible = (await win.getByText(/Oberon 모션그래픽 스튜디오|Oberon Motiongraphic Studio/).count()) > 0;
if (motionMenuVisible) {
  errors.push("Oberon Motiongraphic Studio is still visible in the Apps menu.");
}
await win.screenshot({ path: path.join(OUT, "01-apps-catalog.png"), fullPage: true });

await win.evaluate(() => {
  window.location.href = "/oberon";
});
await win.getByText("애니메이션", { exact: true }).waitFor({ timeout: 20_000 });
const oldMotionCardVisible = (await win.getByText("로고 · 텍스트", { exact: true }).count()) > 0;
await win.screenshot({ path: path.join(OUT, "01b-oberon-animation-only.png"), fullPage: true });
if (oldMotionCardVisible) {
  errors.push("Legacy Oberon motion graphics card is still visible.");
}
await win.evaluate(() => {
  window.location.href = "/oberon-motion";
});
await win.getByRole("heading", { name: /Oberon Motiongraphic Studio/ }).waitFor({ timeout: 20_000 });
await win.screenshot({ path: path.join(OUT, "02-motion-app.png"), fullPage: true });

await win.getByRole("button", { name: /샘플 렌더 테스트/ }).click();
await win
  .locator(".motion-status")
  .filter({ hasText: "Preview QA" })
  .filter({ hasText: /pass/i })
  .waitFor({ timeout: 6_000 });

await win.getByRole("button", { name: /Hephaestus 라우팅 확인/ }).click();
await win.waitForFunction(() => {
  const text = document.body?.innerText ?? "";
  return /selected|receipt|fail|pass/.test(text) && !/라우팅 확인 중/.test(text);
}, null, { timeout: 60_000 }).catch(() => {});
await win
  .locator(".motion-status")
  .filter({ hasText: "Preview QA" })
  .filter({ hasText: /pass/i })
  .waitFor({ timeout: 6_000 });
await win.screenshot({ path: path.join(OUT, "03-motion-app-tested.png"), fullPage: true });

const text = await win.evaluate(() => document.body?.innerText ?? "");
const selectedVisible = /paid\/oberon-motiongraphic-studio|oberon-motiongraphic-studio/.test(text);
const renderPassVisible = /Preview QA[\s\S]{0,80}pass/i.test(text);

await app.close().catch(() => {});

const result = {
  ok: errors.length === 0 && !motionMenuVisible && selectedVisible && renderPassVisible,
  motionMenuVisible,
  selectedVisible,
  renderPassVisible,
  errors,
  shotsDir: OUT,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
