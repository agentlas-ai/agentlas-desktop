#!/usr/bin/env node
/**
 * 회귀: 2026-08-22~23 철회된 릴리스가 그대로 설치된 사고.
 *
 * 사고: 1.0.31/1.0.32 가 실행 즉시 크래시라 공개 후 몇 시간 만에 내렸다. 그런데
 * 그 사이에 이미 내려받아 둔 앱은 "설치" 를 누르면 그대로 깔았다 — 설치 직전에
 * 피드를 다시 보는 곳이 없어서, 며칠 전 정보로 앱을 교체했다. 깔린 뒤에는 앱이
 * 안 켜지므로 스스로 업데이트해서 빠져나올 수도 없었다.
 *
 * 계약(installOnce 진입 직후, 되돌릴 수 없는 일을 하기 전):
 *  1) 피드가 다른 버전을 말하면 → 설치하지 않고, 받아둔 것을 버리고, 다시 확인한다.
 *  2) 피드를 못 읽으면 → 설치하지 않는다 (fail-closed). 못 읽은 것은 허락이 아니다.
 *  3) 피드가 같은 버전을 말하면 → 평소대로 설치한다.
 *
 * 이 게이트는 컨트롤러를 실제로 돌려서 잰다. 소스에 문자열이 있는지가 아니라,
 * 설치가 실제로 거절되는지를 본다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const built = path.join(root, "dist", "electron", "updater", "controller.js");
assert.ok(fs.existsSync(built), "dist 가 없다 — 먼저 npm run build:electron");
const { DesktopUpdaterController } = require(built);

const TARGET = "0.7.29";
const compatibility = {
  minimumSourceAppVersion: "0.7.0",
  minimumRuntimeVersion: "1.0.4",
  minimumSchemaVersion: 35,
  targetSchemaVersion: 53,
  bundledRuntimeVersion: "1.1.12",
};

class FakeUpdater {
  constructor(updateInfo) {
    this.updateInfo = updateInfo;
    this.listeners = new Map();
    this.quitAndInstallCalls = 0;
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
  }
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(listener);
    return this;
  }
  removeListener(event, listener) {
    const all = this.listeners.get(event) || [];
    const at = all.indexOf(listener);
    if (at !== -1) all.splice(at, 1);
    return this;
  }
  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
  }
  async checkForUpdates() {
    // 현실을 그대로: 철회 뒤 다시 확인하면 피드는 이제 다른 버전을 말한다.
    if (this.nextUpdateInfo) this.updateInfo = this.nextUpdateInfo;
    this.emit("update-available", this.updateInfo);
    return { isUpdateAvailable: true, updateInfo: this.updateInfo };
  }
  async downloadUpdate() {
    this.emit("update-downloaded", this.updateInfo);
    return [];
  }
  quitAndInstall() {
    this.quitAndInstallCalls += 1;
  }
}

function makeLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-withdrawn-guard-"));
  const bundle = path.join(base, "Applications", "Agentlas.app");
  const execPath = path.join(bundle, "Contents", "MacOS", "Agentlas");
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, "#!/bin/sh\n");
  const userDataPath = path.join(base, "userData");
  const homePath = path.join(base, "home");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  return { base, execPath, resourcesPath: path.join(bundle, "Contents", "Resources"), userDataPath, homePath };
}

async function scenario(name, { offeredVersion, becomes }) {
  const layout = makeLayout();
  const updater = new FakeUpdater({ version: TARGET, agentlasCompatibility: compatibility });
  const states = [];
  let capturedContinuity = 0;
  const controller = new DesktopUpdaterController({
    updater,
    currentVersion: () => "0.7.28",
    platform: "darwin",
    execPath: layout.execPath,
    resourcesPath: layout.resourcesPath,
    userDataPath: layout.userDataPath,
    homePath: layout.homePath,
    uid: process.getuid(),
    runtimeVersion: () => "1.1.12",
    databaseSchemaVersion: () => 51,
    offeredVersion,
    inspectInstalledAppTrust: async () => ({ ok: true }),
    captureContinuity: async () => {
      capturedContinuity += 1;
      return { schemaVersion: 2, backupPath: path.join(layout.base, "backup"), capturedAt: new Date(0).toISOString() };
    },
    verifyContinuity: async () => ({ ok: true, violations: [] }),
    broadcast: (state) => states.push(structuredClone(state)),
    revealPath: () => {},
    schedule: false,
    now: () => 1_800_000_000_000,
    logger: { log() {}, warn() {}, error() {} },
  });
  await controller.init();
  await controller.check();
  if (becomes) updater.nextUpdateInfo = { version: becomes, agentlasCompatibility: compatibility };
  assert.equal(controller.getState().status, "downloaded", `${name}: 준비 단계에서 downloaded 가 아니다`);
  const result = await controller.install();
  // 거절 뒤 자동으로 다시 받는 흐름이 끝나기를 기다린다.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { name, result, updater, states, capturedContinuity, controller };
}

// ── 1) 철회/추월: 피드가 다른 버전을 말한다 ───────────────────────────────────
{
  const { result, updater, capturedContinuity, controller, states } = await scenario("철회", {
    offeredVersion: async () => "0.7.31",
    becomes: "0.7.31",
  });
  assert.equal(result.accepted, false, "철회된 버전인데 설치를 수락했다");
  assert.equal(updater.quitAndInstallCalls, 0, "철회된 버전인데 네이티브 설치로 넘어갔다");
  assert.equal(capturedContinuity, 0, "설치를 거절하면서 되돌릴 수 없는 준비 단계를 밟았다");
  assert.ok(
    states.some((state) => state.status === "checking"),
    "받아둔 것을 버리고 다시 확인하지 않았다 — 거절만 하면 사용자는 갇힌다",
  );
  const settled = controller.getState();
  assert.equal(settled.version, "0.7.31", `거절 뒤 지금 제공되는 버전으로 옮겨가야 한다 (지금: ${settled.version})`);
  console.log(`  철회: 설치 거절 → 다시 확인 → 지금 제공되는 ${settled.version} 로 이동 ✓`);
}

// ── 2) 피드를 못 읽음: 못 읽은 것은 허락이 아니다 ─────────────────────────────
{
  const { result, updater, capturedContinuity } = await scenario("피드 불가", {
    offeredVersion: async () => null,
  });
  assert.equal(result.accepted, false, "피드를 못 읽었는데 설치를 수락했다 — fail-open");
  assert.equal(updater.quitAndInstallCalls, 0, "피드를 못 읽었는데 네이티브 설치로 넘어갔다");
  assert.equal(capturedContinuity, 0, "확인 못 한 채 준비 단계를 밟았다");
  console.log("  피드 불가: 설치 거절(fail-closed) ✓");
}

// ── 3) 던지는 피드도 같다 ─────────────────────────────────────────────────────
{
  const { result, updater } = await scenario("피드 예외", {
    offeredVersion: async () => { throw new Error("network down"); },
  });
  assert.equal(result.accepted, false, "피드 읽기가 던졌는데 설치를 수락했다");
  assert.equal(updater.quitAndInstallCalls, 0, "피드 읽기가 던졌는데 네이티브 설치로 넘어갔다");
  console.log("  피드 예외: 설치 거절 ✓");
}

// ── 4) 정상: 같은 버전이면 평소대로 깔린다 (가드가 전부를 막으면 안 된다) ──────
{
  const { result, updater, capturedContinuity } = await scenario("정상", {
    offeredVersion: async () => TARGET,
  });
  assert.equal(result.accepted, true, "지금도 제공되는 버전인데 설치가 막혔다 — 가드가 과하다");
  assert.equal(updater.quitAndInstallCalls, 1, "정상 경로에서 네이티브 설치가 호출되지 않았다");
  assert.equal(capturedContinuity, 1, "정상 경로에서 복구 사본을 뜨지 않았다");
  console.log("  정상: 그대로 설치 ✓");
}

console.log("updater withdrawn-release guard PASS: 철회·확인불가는 설치를 거절하고, 지금 제공되는 버전만 깔린다");
