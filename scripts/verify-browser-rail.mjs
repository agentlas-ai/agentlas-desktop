#!/usr/bin/env node
// 브라우저 자격증명 레일이 하나로 유지되는지 지키는 게이트.
//
// 배경(2026-08-19 실측): 사용자의 로그인이 서랍 다섯 개로 갈라져 있었다 —
// ~/.agentlas/chrome-cdp-profile, ~/.agentlas/browser-profile,
// <userData>/mcp/browser-profiles/<key>, 앱 팩토리가 앱마다 만든 browser-profile,
// ~/.cache/playwright_hf_profile. 그래서 사용자가 어딘가에 로그인해 둬도 실행은 자주
// 로그인 0개짜리 창을 잡았고, X 자동화는 평생 로그아웃 창을 몰면서 "게시 완료"를 기록했다.
//
// 이 게이트가 지키는 계약 세 가지:
//  1) 카탈로그의 브라우저 도구는 자기 --user-data-dir 을 들지 않는다(전용 런처를 통해 CDP 로 붙는다).
//  2) mcp-config 가 실행 키마다 프로필을 새로 파지 않는다.
//  3) 런처 파일은 계약 번호를 들고 다니고, 두 writer 모두 다운그레이드하지 않는다.
//
// 실패하면 사유를 말한다 — 조용히 통과시키면 이 결함은 사용자 머신에서만 드러난다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

function read(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    failures.push(`${rel} 이(가) 없습니다 — 게이트가 검사할 대상을 잃었습니다.`);
    return null;
  }
  return fs.readFileSync(abs, "utf8");
}

function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

// 1) 카탈로그의 브라우저 항목이 자기 프로필을 들지 않는다.
const catalog = read("electron/mcp-tools/catalog.ts");
if (catalog) {
  const forked = [...catalog.matchAll(/"--user-data-dir"/g)].length;
  check(
    "catalog-no-own-profile",
    forked === 0,
    `catalog.ts 에 --user-data-dir 인자가 ${forked}개 남아 있습니다. 브라우저 도구는 전용 런처를 통해 CDP 로 붙어야 하고, 자기 프로필을 열면 자격증명 서랍이 하나 더 생깁니다.`,
  );
  const launcherRefs = [...catalog.matchAll(/agentlas-browser-cdp\.mjs/g)].length;
  check(
    "catalog-browser-tools-share-launcher",
    launcherRefs >= 2,
    `브라우저 카탈로그 항목이 공용 런처를 가리키는 곳이 ${launcherRefs}곳뿐입니다. playwright 와 agentlas-browser 둘 다 같은 런처를 실행해야 같은 로그인 상태를 봅니다.`,
  );
}

// 2) mcp-config 가 실행 키마다 프로필을 파지 않는다.
const mcpConfig = read("electron/mcp-tools/mcp-config.ts");
if (mcpConfig) {
  check(
    "mcp-config-no-per-key-profile",
    !/userDataPath\(\s*"mcp"\s*,\s*"browser-profiles"/.test(mcpConfig),
    "mcp-config.ts 가 다시 <userData>/mcp/browser-profiles/<key> 를 만들고 있습니다. 실행 키마다 새 프로필은 곧 로그인 0개짜리 창입니다.",
  );
}

// 3) 런처 계약 번호와 다운그레이드 금지.
const launcher = read("electron/mcp-tools/browser-cdp-launcher.ts");
if (launcher) {
  const declared = launcher.match(/BROWSER_CDP_LAUNCHER_CONTRACT\s*=\s*(\d+)/);
  check(
    "launcher-declares-contract",
    Boolean(declared),
    "browser-cdp-launcher.ts 에 BROWSER_CDP_LAUNCHER_CONTRACT 가 없습니다. 계약 번호가 없으면 두 writer 가 서로 덮어씁니다.",
  );
  // 소스 문자열을 정규식으로 훑는 대신, **빌드 산출물이 실제로 만드는 파일**에 표식이 있는지 본다.
  // 소스 검사는 "쓴 것 같다"만 증명하고, 산출물 검사는 "설치될 파일에 있다"를 증명한다.
  const built = path.join(root, "dist/electron/mcp-tools/browser-cdp-launcher.js");
  if (fs.existsSync(built)) {
    const mod = fs.readFileSync(built, "utf8");
    const emitted = mod.match(/@agentlas-browser-cdp-contract\s*(\$\{[^}]+\}|\d+)/);
    check(
      "launcher-source-carries-marker",
      Boolean(emitted),
      "빌드된 런처 소스에 계약 표식이 없습니다. 설치된 파일이 자기 번호를 들고 있어야 상대 writer 가 읽을 수 있습니다.",
    );
  } else {
    check(
      "launcher-source-carries-marker",
      /LAUNCHER_CONTRACT_MARKER\}\s*\$\{BROWSER_CDP_LAUNCHER_CONTRACT\}/.test(launcher),
      "런처 소스 본문에 계약 표식이 실리지 않습니다(dist 가 없어 소스로 검사했습니다).",
    );
  }
  check(
    "launcher-refuses-downgrade",
    /installed !== null && installed > BROWSER_CDP_LAUNCHER_CONTRACT/.test(launcher),
    "materializeBrowserCdpLauncher 가 더 높은 계약을 덮어씁니다. 다운그레이드는 사용자가 눈치채지 못하는 동작 변경입니다.",
  );
}

// 4) 반대편 writer(Agentlas-OS)도 같은 규칙을 지킨다 — 있으면 검사하고, 없으면 사유를 남긴다.
const osAdapter = path.resolve(
  root,
  "..",
  "Agentlas-OS",
  "agentlas_cloud/research/adapters/agentlas_browser.py",
);
if (fs.existsSync(osAdapter)) {
  const py = fs.readFileSync(osAdapter, "utf8");
  check(
    "os-writer-refuses-downgrade",
    /installed is not None and installed >= BUNDLED_LAUNCHER_CONTRACT/.test(py),
    "Agentlas-OS 의 materialize_launcher 가 다시 무조건 덮어씁니다. 두 writer 중 하나라도 규칙을 안 지키면 파일은 계속 뒤집힙니다.",
  );
} else {
  checks.push({ name: "os-writer-refuses-downgrade", ok: true, skipped: true });
  console.log("SKIP os-writer-refuses-downgrade — Agentlas-OS 체크아웃이 이 위치에 없습니다.");
}

for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.skipped ? " (skipped)" : ""}`);
}
if (failures.length > 0) {
  console.error("\nbrowser-rail 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
