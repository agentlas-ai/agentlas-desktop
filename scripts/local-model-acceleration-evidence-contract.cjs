#!/usr/bin/env node
/*
 * 로컬 모델 가속·엔진 검증 계약 (2026-09-13).
 *
 * 세 가지를 실제 함수 호출로 못 박는다 — 소스 문자열 대조가 아니다.
 *  1. 가속 증거는 엔진 로그에서만 나온다: 실측 Metal 로그 → gpu:true 29/29, 층이 안 오르면 cpu,
 *     로그가 비면 unknown. `--list-devices` 출력은 장치 표로 읽힌다(Vulkan 이름 포함).
 *  2. 엔진 카탈로그: 플랫폼·아키텍처당 한 행, 윈도우 x64 는 GPU 가능 빌드(CPU 빌드는 영원히 CPU 였다).
 *  3. 내장 Node 검증기: 맥 배포본에서 우리 Developer ID 로 다시 서명된 bin/node 를 받아들이되,
 *     서명이 없거나 다른 파일이 손대졌으면 여전히 거부한다. 설치된 /Applications/Agentlas.app 이
 *     있으면 실제 codesign 경로까지 통과해야 한다(없으면 그 항목만 건너뛴다).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const acceleration = require(path.join(root, "dist/electron/local-model-hub/acceleration.js"));
const catalog = require(path.join(root, "dist/electron/local-model-hub/catalog.js"));
const hardware = require(path.join(root, "dist/electron/local-model-hub/hardware.js"));
const managedNode = require(path.join(root, "dist/electron/runtime/managed-node.js"));

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };

// ── 1. 엔진 로그 → 가속 증거 ─────────────────────────────────────────────────
const metalLog = [
  '{"type":"log","time":1,"level":"info","msg":"llama_prepare_model_devices: using device MTL0 (Apple M4 Max) (unknown id) - 38338 MiB free\\n"}',
  '{"type":"log","time":2,"level":"info","msg":"load_tensors: offloaded 29/29 layers to GPU\\n"}',
  '{"type":"log","time":3,"level":"info","msg":"srv  llama_server: model loaded\\n"}',
].join("\n");
const metal = acceleration.parseEngineLoadLog(metalLog);
eq(metal.gpu, true, "Metal 로그는 GPU 가속으로 읽혀야 한다");
eq(metal.backend, "metal");
eq(metal.offloadedLayers, 29); eq(metal.totalLayers, 29);
eq(metal.devices[0].name, "Apple M4 Max");

const vulkanLog = [
  '{"type":"log","time":1,"level":"info","msg":"llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 4070) (0000:01:00.0) - 11900 MiB free\\n"}',
  '{"type":"log","time":2,"level":"info","msg":"load_tensors: offloaded 37/37 layers to GPU\\n"}',
].join("\n");
const vulkan = acceleration.parseEngineLoadLog(vulkanLog);
eq(vulkan.gpu, true, "Vulkan 로그도 GPU 가속으로 읽혀야 한다"); eq(vulkan.backend, "vulkan"); eq(vulkan.offloadedLayers, 37);

const noOffload = acceleration.parseEngineLoadLog([
  '{"type":"log","time":1,"level":"info","msg":"llama_prepare_model_devices: using device Vulkan0 (Intel UHD) (x) - 512 MiB free\\n"}',
  '{"type":"log","time":2,"level":"info","msg":"load_tensors: offloaded 0/33 layers to GPU\\n"}',
].join("\n"));
eq(noOffload.gpu, false, "GPU 가 보여도 층이 0 이면 CPU 실행이다"); eq(noOffload.backend, "cpu");

const quiet = acceleration.parseEngineLoadLog('{"type":"log","time":1,"level":"info","msg":"srv  llama_server: model loaded\\n"}');
eq(quiet.gpu, false); eq(quiet.backend, "unknown", "증거가 없으면 unknown 이지 cpu 가 아니다");

const devices = acceleration.parseEngineDeviceList("Available devices:\n  MTL0: Apple M4 Max (38338 MiB, 38338 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n");
eq(devices.length, 2); eq(devices[0].gpu, true); eq(devices[0].accelerator, "metal"); eq(devices[1].gpu, false);
eq(devices[0].memoryBytes, 38338 * 1048576);
const vkDevices = acceleration.parseEngineDeviceList("Available devices:\n  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 16000 MiB free)\n");
eq(vkDevices[0].accelerator, "vulkan"); eq(vkDevices[0].gpu, true);
eq(acceleration.parseEngineDeviceList("garbage\n").length, 0, "모르는 줄에서 장치를 지어내지 않는다");

// ── 2. 엔진 카탈로그 ────────────────────────────────────────────────────────
const engines = catalog.localEngineCatalog();
const keys = engines.map((row) => `${row.platform}:${row.arch}`);
eq(new Set(keys).size, keys.length, "플랫폼·아키텍처당 엔진 행은 하나");
const winX64 = catalog.compatibleEnginePackage("win32", "x64").item;
ok(winX64 && winX64.accelerator !== "cpu", "윈도우 x64 엔진은 GPU 가능 빌드여야 한다(CPU 빌드는 가속이 원리적으로 없다)");
ok(/vulkan/.test(winX64.fileName), "윈도우 x64 는 Vulkan 아카이브(NVIDIA·AMD·Intel 공통 드라이버)");
eq(catalog.compatibleEnginePackage("darwin", "arm64").item.accelerator, "metal");
const linux = catalog.compatibleEnginePackage("linux", "x64").item;
ok(linux && linux.accelerator === "vulkan" && /ubuntu-vulkan/.test(linux.fileName), "리눅스 x64 도 Vulkan 아카이브로 GPU 가능(AppImage/deb 가 실제로 배포된다)");
eq(catalog.compatibleEnginePackage("linux", "arm64").item, null, "없는 행은 지어내지 않는다");

// ── 2b. 내장 Node 리눅스 잠금 = fetch 스크립트와 동일 ─────────────────────────
const fetcher = fs.readFileSync(path.join(root, "scripts/fetch-node-runtime.mjs"), "utf8");
const linuxBlock = /"linux:x64":\s*\{([\s\S]*?)\n\s*\},/.exec(fetcher)?.[1] ?? "";
const managedSource = fs.readFileSync(path.join(root, "electron/runtime/managed-node.ts"), "utf8");
const managedLinux = /"linux:x64":\s*\{([\s\S]*?)\n\s*\},/.exec(managedSource)?.[1] ?? "";
for (const key of ["nodeSha256", "npmCliSha256", "runtimeTreeSha256"]) {
  const expected = new RegExp(`${key}:\\s*"([a-f0-9]{64})"`).exec(linuxBlock)?.[1];
  const actual = new RegExp(`${key}:\\s*"([a-f0-9]{64})"`).exec(managedLinux)?.[1];
  ok(expected && actual === expected, `리눅스 내장 Node 잠금 ${key} 는 fetch 스크립트와 같아야 한다`);
}
ok(/archiveSha256:\s*"783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8"/.test(managedLinux), "리눅스 tarball 해시 잠금");

// ── 2c. 윈도우 앱-로컬 VC++ 런타임 ─────────────────────────────────────────
const installer = require(path.join(root, "dist/electron/local-model-hub/engine-installer.js"));
const redistRoot = path.join(root, "build-resources/vc-redist");
const manifest = JSON.parse(fs.readFileSync(path.join(redistRoot, "manifest.json"), "utf8"));
const { createHash } = require("node:crypto");
eq(installer.WINDOWS_CRT_FILES.length, 3);
for (const item of installer.WINDOWS_CRT_FILES) {
  const file = path.join(redistRoot, "x64", item.fileName);
  const bytes = fs.readFileSync(file);
  eq(createHash("sha256").update(bytes).digest("hex"), item.sha256, `${item.fileName} 는 소스 잠금 해시와 같아야 한다`);
  eq(bytes.byteLength, item.byteLength);
  eq(manifest.files[item.fileName].sha256, item.sha256, `${item.fileName} 매니페스트 해시`);
  // PE32+ x64
  eq(bytes.toString("ascii", 0, 2), "MZ"); const pe = bytes.readUInt32LE(60);
  eq(bytes.readUInt16LE(pe + 4), 0x8664, `${item.fileName} 는 x64 PE`);
}
ok(/electron\/local-model-hub\/engine-installer/.test(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8")) || /vc-redist/.test(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8")), "빌더가 vc-redist 를 리소스로 싣는다");
async function windowsRuntimeChecks() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lmh-crt-"));
  try {
    const sysRoot = path.join(temp, "Windows"); fs.mkdirSync(path.join(sysRoot, "System32"), { recursive: true });
    const engineDir = path.join(temp, "engine"); fs.mkdirSync(engineDir);
    const make = (opts) => new installer.LocalEngineInstaller(path.join(temp, "engines"), { platform: "win32", arch: "x64", windowsRuntimeDir: path.join(redistRoot, "x64"), windowsSystemRoot: sysRoot, ...opts });
    const placed = await make().placeWindowsRuntime(engineDir);
    eq(placed.length, 3, "시스템에 없으면 세 DLL 을 실행파일 옆에 놓는다");
    ok(fs.existsSync(path.join(engineDir, "msvcp140.dll")));
    fs.writeFileSync(path.join(sysRoot, "System32", "msvcp140.dll"), "system");
    const engineDir2 = path.join(temp, "engine2"); fs.mkdirSync(engineDir2);
    const placed2 = await make().placeWindowsRuntime(engineDir2);
    eq(placed2.join(","), "vcruntime140.dll,vcruntime140_1.dll", "시스템에 있는 DLL 은 건드리지 않는다");
    const bad = path.join(temp, "bad"); fs.mkdirSync(bad);
    for (const item of installer.WINDOWS_CRT_FILES) fs.writeFileSync(path.join(bad, item.fileName), "tampered");
    await assert.rejects(make({ windowsRuntimeDir: bad }).placeWindowsRuntime(path.join(temp, "engine3")), /engine_windows_runtime_sha256_mismatch/);
    checks += 1;
    eq((await make({ platform: "darwin", arch: "arm64" }).placeWindowsRuntime(engineDir)).length, 0, "맥에서는 아무것도 안 한다");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// ── 3. 하드웨어 적합도: 관측된 GPU 만 '권장' ────────────────────────────────
// (2c 의 비동기 검사는 파일 끝에서 await 한다)
const model = catalog.localModelCatalog()[0];
const base = { schemaVersion: 1, profileId: "hardware:test", observedAt: new Date().toISOString(), platform: "win32", arch: "x64", cpuModel: "x", logicalCpuCount: 8,
  totalMemoryBytes: 32 * 2 ** 30, availableMemoryBytes: 24 * 2 ** 30, memoryKind: "system", vramBytes: null, diskAvailableBytes: 500 * 2 ** 30, engineDevices: [] };
eq(hardware.estimateLocalModelFit({ ...base, accelerator: "unknown", acceleratorEvidence: "not-observed" }, model).class, "runnable", "GPU 를 본 적 없으면 '권장' 이 아니다");
eq(hardware.estimateLocalModelFit({ ...base, accelerator: "vulkan", acceleratorEvidence: "engine-observed", vramBytes: 12 * 2 ** 30 }, model).class, "recommended", "엔진이 GPU 를 보고했으면 권장");
const tiny = hardware.estimateLocalModelFit({ ...base, accelerator: "vulkan", acceleratorEvidence: "engine-observed", vramBytes: 256 * 2 ** 20 }, model);
eq(tiny.class, "may_be_slow", "GPU 메모리가 모델보다 작으면 느릴 수 있음");
ok(tiny.reasonCodes.includes("gpu_memory_smaller_than_model"));

// ── 4. 내장 Node 검증기 — 맥 재서명 규칙 ───────────────────────────────────
const policy = JSON.parse(fs.readFileSync(path.join(root, "build-resources/macos-release-signing-policy.json"), "utf8"));
ok(managedNode.MAC_RELEASE_NODE_REQUIREMENT.includes(`"${policy.teamIdentifier}"`), "검증기의 팀 식별자는 릴리스 서명 정책과 같아야 한다");
ok(fs.readFileSync(path.join(root, "build-resources/after-sign-trust.cjs"), "utf8").includes("validateManagedNodeRuntimeRoot"), "afterSign 훅이 서명 뒤 런타임 검증기를 다시 돌린다");

const fixture = path.join(root, "build-resources/node-runtime");
const fixtureManifest = path.join(fixture, "agentlas-node-runtime.json");
if (fs.existsSync(fixtureManifest) && JSON.parse(fs.readFileSync(fixtureManifest, "utf8")).platform === "darwin") {
  const arch = JSON.parse(fs.readFileSync(fixtureManifest, "utf8")).arch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lmh-node-"));
  try {
    const copy = path.join(temp, "runtime");
    fs.cpSync(fixture, copy, { recursive: true, verbatimSymlinks: true });
    eq(managedNode.validateManagedNodeRuntimeRoot(copy, "darwin", arch).ok, true, "업스트림 그대로면 통과");
    // 서명이 바뀐 것처럼 bin/node 를 바꾼다.
    fs.appendFileSync(path.join(copy, "bin/node"), Buffer.alloc(288));
    managedNode.setMacReleaseNodeSignatureVerifierForTests(() => false);
    const unsigned = managedNode.validateManagedNodeRuntimeRoot(copy, "darwin", arch);
    eq(unsigned.ok, false, "우리 서명이 아니면 거부"); assert.match(unsigned.reason, /checksum/);
    let asked = 0;
    managedNode.setMacReleaseNodeSignatureVerifierForTests((node) => { asked += 1; return node === path.join(copy, "bin/node"); });
    eq(managedNode.validateManagedNodeRuntimeRoot(copy, "darwin", arch).ok, true, "우리 팀 서명이면 트리 지문에 잠금값을 대입해 통과");
    eq(asked, 1, "서명 검증은 해시가 다를 때만 한 번");
    fs.appendFileSync(path.join(copy, "lib/node_modules/npm/bin/npm-cli.js"), "// tampered\n");
    eq(managedNode.validateManagedNodeRuntimeRoot(copy, "darwin", arch).ok, false, "서명된 node 와 별개로 다른 파일이 손대지면 거부");
    managedNode.setMacReleaseNodeSignatureVerifierForTests(null);
    eq(managedNode.validateManagedNodeRuntimeRoot(copy, "win32", arch).ok, false, "윈도우에는 이 예외가 없다");
  } finally {
    managedNode.setMacReleaseNodeSignatureVerifierForTests(null);
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log("[skip] build-resources/node-runtime 이 없거나 맥용이 아니라 재서명 시나리오는 건너뜀");
}

const installed = "/Applications/Agentlas.app/Contents/Resources/node-runtime";
if (process.platform === "darwin" && fs.existsSync(path.join(installed, "agentlas-node-runtime.json"))) {
  const real = managedNode.validateManagedNodeRuntimeRoot(installed, "darwin", process.arch);
  eq(real.ok, true, `설치된 서명 배포본의 bin/node 는 실제 codesign 경로로 통과해야 한다: ${real.reason ?? ""}`);
} else {
  console.log("[skip] 설치된 Agentlas.app 이 없어 실제 codesign 경로는 건너뜀");
}

windowsRuntimeChecks().then(() => { console.log(JSON.stringify({ ok: true, checks })); }).catch((error) => { console.error(error); process.exit(1); });
