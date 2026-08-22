#!/usr/bin/env node
// 브라우저 자격증명 레일이 하나로 유지되는지 지키는 게이트.
//
// 배경(2026-08-19 실측): 사용자의 로그인이 서랍 다섯 개로 갈라져 있었다 —
// ~/.agentlas/chrome-cdp-profile, ~/.agentlas/browser-profile,
// <userData>/mcp/browser-profiles/<key>, 앱 팩토리가 앱마다 만든 browser-profile,
// ~/.cache/playwright_hf_profile. 그래서 사용자가 어딘가에 로그인해 둬도 실행은 자주
// 로그인 0개짜리 창을 잡았고, X 자동화는 평생 로그아웃 창을 몰면서 "게시 완료"를 기록했다.
//
// 이 게이트가 지키는 계약 네 가지:
//  1) 카탈로그의 브라우저 도구는 자기 --user-data-dir 을 들지 않는다(전용 런처를 통해 CDP 로 붙는다).
//  2) mcp-config 가 실행 키마다 프로필을 새로 파지 않는다.
//  3) 런처 파일은 계약 번호를 들고 다니고, 두 writer 모두 다운그레이드하지 않는다.
//  4) Workforce worker가 Codex에서도 Main이 만든 MCP override를 받아 provider-global
//     Playwright가 별도 창을 여는 경로로 새지 않는다.
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
  // Built-ins are now declared by the plugin manifest and resolved in one host
  // adapter; catalog.ts intentionally contains only the two derived row calls.
  const builtin = read("electron/plugins/builtin.ts") ?? "";
  const browserManifest = read("plugins/agentlas-browser/plugin.json") ?? "";
  const launcherRefs = [...browserManifest.matchAll(/"resolver"\s*:\s*"browser-cdp"/g)].length;
  check(
    "catalog-browser-tools-share-launcher",
    launcherRefs >= 2
      && /"browser-cdp"\s*:\s*\(\)\s*=>/.test(builtin)
      && /BROWSER_CDP_LAUNCHER_BASENAME/.test(builtin),
    `브라우저 카탈로그 항목이 공용 런처를 가리키는 곳이 ${launcherRefs}곳뿐입니다. playwright 와 agentlas-browser 둘 다 같은 런처를 실행해야 같은 로그인 상태를 봅니다.`,
  );
}

// 2) mcp-config 가 실행 키마다 프로필을 파지 않는다.
const mcpConfig = read("electron/mcp-tools/mcp-config.ts");
if (mcpConfig) {
  check(
    "agent-browser-host-is-headless",
    /AGENTLAS_CDP_HEADLESS:\s*"1"/.test(mcpConfig),
    "에이전트 브라우저 런타임은 외부 Chrome 창 대신 One Browser 레일용 headless CDP 호스트를 사용해야 합니다.",
  );
  check(
    "mcp-wrapper-preserves-browser-headless",
    /"AGENTLAS_BROWSER_APPROVAL_FILE",\s*"AGENTLAS_CDP_HEADLESS"/.test(mcpConfig),
    "MCP 자식 환경 래퍼가 AGENTLAS_CDP_HEADLESS를 제거합니다. 설정에만 값을 넣어도 실제 Chrome은 외부 창으로 열립니다.",
  );
  check(
    "mcp-config-no-per-key-profile",
    !/userDataPath\(\s*"mcp"\s*,\s*"browser-profiles"/.test(mcpConfig),
    "mcp-config.ts 가 다시 <userData>/mcp/browser-profiles/<key> 를 만들고 있습니다. 실행 키마다 새 프로필은 곧 로그인 0개짜리 창입니다.",
  );
}

// 3) Workforce의 exact tool grant는 Codex에도 같은 서버 launch contract를 전달한다.
// JSON configPath만 넘기면 Claude는 맞지만 Codex는 ~/.codex/config.toml의 동명 서버를
// 사용한다. 그 결과 Agentlas Browser가 아니라 별도 Playwright 창이 열리고 One rail은
// task URL만 알 뿐 실제 CDP target을 찾지 못한다.
const workforceInventory = read("electron/mcp/workforce-tool-inventory.ts");
if (workforceInventory) {
  check(
    "workforce-codex-uses-main-mcp-override",
    /mcpCodexConfigArgs\s*=\s*config\.codexConfigArgs/.test(workforceInventory)
      && /mcpCodexConfigArgs,/.test(workforceInventory),
    "Workforce grant가 config.codexConfigArgs를 runner에 전달하지 않습니다. Codex의 provider-global Playwright가 별도 브라우저를 열 수 있습니다.",
  );
}

// 4) Exact Browser isolation must cross the saved One Taskforce boundary and
// Codex must enforce it by ignoring provider-global config on one-shot turns.
const client = read("electron/mcp/client.ts") ?? "";
const taskForce = read("electron/mcp/borrowed-task-force.ts") ?? "";
const codex = read("electron/runtime/codex.ts") ?? "";
check(
  "taskforce-propagates-browser-isolation",
  /isolatedMcpConfig \? \{ isolatedMcpConfig: true as const \} : \{\}/.test(client)
    && /isolatedMcpConfig: p\.isolatedMcpConfig/.test(taskForce),
  "One Taskforce가 Main의 exact Browser 격리 표식을 planner/worker/synthesis 러너로 전달하지 않습니다.",
);
check(
  "codex-enforces-browser-isolation",
  /runReq\.isolatedMcpConfig \? \["--ignore-user-config"\] : \[\]/.test(codex)
    && /!runReq\.isolatedMcpConfig/.test(codex),
  "Codex 격리 턴이 provider-global MCP/plugin 설정을 읽거나 app-server 상주 경로로 들어갈 수 있습니다.",
);
check(
  "codex-preserves-exact-mcp-tool-name",
  /item\.type === "mcp_tool_call" && item\.tool/.test(codex)
    && /item\.server \? `\$\{item\.server\}\.\$\{item\.tool\}` : item\.tool/.test(codex)
    && /exactMcpName \?\?\s*item\.name/.test(codex),
  "Codex one-shot 스트림이 MCP server/tool 이름을 mcp_tool_call 봉투명으로 뭉갭니다. One은 browser_navigate를 Taskforce Browser 레일에 귀속할 수 없습니다.",
);

// 5) 이미 저장된 generic Codex events도 브라우저 결과 증거가 있을 때만
// 회수한다. 과거 Taskforce를 다시 열었을 때 빈 레일로 퇴행하지 않아야 한다.
const oneActivityTimeline = read("renderer/components/one/OneActivityTimeline.tsx") ?? "";
check(
  "one-rail-recovers-proven-legacy-navigation",
  /toolName === "mcp_tool_call"/.test(oneActivityTimeline)
    && /page\\\.goto/.test(oneActivityTimeline)
    && /isLegacyProvenNavigation/.test(oneActivityTimeline),
  "이전 mcp_tool_call 이벤트의 완료 결과가 실제 page.goto를 증명해도 Browser 레일 URL로 복구되지 않습니다.",
);
check(
  "one-rail-retries-until-cdp-ready",
  /const scheduleRetry =/.test(oneActivityTimeline)
    && /result\.sessionId && result\.frame\.available/.test(oneActivityTimeline)
    && /scheduleRetry\(\)/.test(oneActivityTimeline),
  "브라우저 이벤트가 CDP 기동보다 먼저 오거나 같은 URL을 재사용하면 최초 1회 실패 뒤 레일이 영구히 빈 화면으로 남습니다.",
);
check(
  "one-browser-shell-matches-native-controls",
  /browserTabBar/.test(oneActivityTimeline)
    && /browserNavigationBar/.test(oneActivityTimeline)
    && /normalizedBrowserAddress/.test(oneActivityTimeline)
    && /action: "back"/.test(oneActivityTimeline)
    && /action: "forward"/.test(oneActivityTimeline)
    && /action: "reload"/.test(oneActivityTimeline)
    && /action: "navigate"/.test(oneActivityTimeline),
  "One Browser 레일에 탭, 주소창, 뒤로, 앞으로, 새로고침 중 하나가 빠졌습니다. 단순 이미지 프레임이 아니라 실제 인앱 브라우저 셸이어야 합니다.",
);
check(
  "one-browser-never-opens-external-window",
  !/focusLiveTarget/.test(oneActivityTimeline),
  "One Browser 레일이 여전히 Open 버튼으로 외부 Chrome 창을 전면에 올립니다. 결과 페이지는 One 오른쪽 사이드바 안에 남아야 합니다.",
);

// 6) 런처 계약 번호와 다운그레이드 금지.
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
  check(
    "launcher-defaults-agent-browser-headless",
    /AGENTLAS_CDP_HEADLESS \|\| '1'/.test(launcher)
      && /toLowerCase\(\) !== '0'/.test(launcher),
    "호출자가 환경 힌트를 빠뜨리면 자동화 Chrome이 다시 외부 창으로 열립니다. 명시적 로그인만 별도 headful 경로를 사용해야 합니다.",
  );
}

const liveView = read("electron/browser/live-view.ts") ?? "";
check(
  "one-browser-navigation-reaches-cdp-target",
  /Page\.getNavigationHistory/.test(liveView)
    && /Page\.navigateToHistoryEntry/.test(liveView)
    && /Page\.reload/.test(liveView)
    && /Page\.navigate/.test(liveView),
  "브라우저 셸 버튼이 장식뿐입니다. 뒤로, 앞으로, 새로고침, 주소 이동을 rail-owned CDP target에 전달해야 합니다.",
);
check(
  "one-browser-rail-owns-durable-target",
  /railTargetIdsByUrl/.test(liveView)
    && /method: "PUT"/.test(liveView)
    && /\/json\/new\?/.test(liveView)
    && /ensureRailTarget\(port, preferred\)/.test(liveView),
  "One Browser 레일이 worker의 임시 탭을 빌려 씁니다. worker 종료 뒤에도 결과 화면을 보존하는 rail-owned CDP target이 필요합니다.",
);
check(
  "one-browser-web-keeps-desktop-viewport",
  /WEB_VIEWPORT\s*=\s*\{\s*width:\s*1_280,\s*height:\s*800\s*\}/.test(liveView)
    && /const viewport = phone \? PHONE_VIEWPORT : WEB_VIEWPORT/.test(liveView)
    && /Emulation\.setDeviceMetricsOverride/.test(liveView),
  "Web 탭이 출력 레일 폭을 레이아웃 viewport로 사용합니다. 1280×800 데스크톱 화면을 레일 안에 축소 렌더링해야 Phone 탭과 구분됩니다.",
);

// 7) 반대편 writer(Agentlas-OS)도 같은 규칙을 지킨다 — 있으면 검사하고, 없으면 사유를 남긴다.
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
