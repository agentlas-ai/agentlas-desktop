#!/usr/bin/env node
// 런타임 능력 서술자 프로브 — shared/runtime-capabilities.ts 의 **표면적** 주장
// (CLI 플래그·명령 경로)을 설치된 CLI 실물에 대조한다.
//
// ★왜 있나 (UNIVERSAL-RUNTIME-FEATURES-PLAN §4.5-a): 능력표 15행 중 3행이 리서치
// 한 번에 반증됐고, 전부 "CLI 버전이 오르면 바뀌는" 표면적 항목이었다. 표면적
// 항목을 손으로 관리하면 그 자체가 손 목록 병이다 — CLI 를 올린 날 이 게이트가
// 어긋남을 알린다.
//
// 판정 규칙:
//   · CLI 미설치 → SKIP + 사유 (검사 못 한 것을 통과로 위장하지 않는다)
//   · 설치됨 + 플래그가 --help 에 있음 → OK
//   · 설치됨 + 플래그가 --help 에 없음 → DRIFT (--check 면 exit 1)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

// 서술자는 TS 라서 여기선 소스를 정적으로 읽는다(값 실행 아님 — 플래그 문자열만).
const descriptorSource = readFileSync(join(repo, "shared", "runtime-capabilities.ts"), "utf8");

/** kind → 설치 후보 경로(널리 알려진 곳만). 없으면 SKIP. */
const CLI_CANDIDATES = {
  "claude-code": ["claude", "/opt/homebrew/bin/claude", join(homedir(), ".local/bin/claude")],
  codex: ["codex", join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex"],
  antigravity: ["agy", join(homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy"],
  grok: [join(homedir(), ".grok/bin/grok"), "grok", "/opt/homebrew/bin/grok"],
};

/** 서술자의 표면적 주장 — kind, 주장한 플래그, 그 플래그를 확인할 help 인보케이션. */
const SURFACE_CLAIMS = [
  { kind: "grok", flag: "--system-prompt-override", helpArgs: ["--help"] },
  { kind: "grok", flag: "--resume", helpArgs: ["--help"] },
  { kind: "grok", flag: "--permission-mode", helpArgs: ["--help"] },
  { kind: "antigravity", flag: "--conversation", helpArgs: ["--help"] },
  { kind: "antigravity", flag: "--dangerously-skip-permissions", helpArgs: ["--help"] },
  { kind: "codex", flag: "--image", helpArgs: ["exec", "--help"] },
  { kind: "codex", flag: "resume", helpArgs: ["exec", "--help"] },
  { kind: "codex", flag: "--dangerously-bypass-hook-trust", helpArgs: ["exec", "--help"] },
  { kind: "grok", flag: "--json-schema", helpArgs: ["--help"] },
  { kind: "antigravity", flag: "--json-schema", helpArgs: ["--help"] },
  { kind: "codex", flag: "--output-schema", helpArgs: ["exec", "--help"] },
  { kind: "claude-code", flag: "--json-schema", helpArgs: ["--help"] },
  { kind: "claude-code", flag: "--mcp-config", helpArgs: ["--help"] },
  { kind: "claude-code", flag: "--permission-mode", helpArgs: ["--help"] },
];

/** 서술자의 명령 표면 주장 → 실물 디렉터리 존재는 참고 정보(없어도 드리프트 아님 —
 *  사용자가 명령을 안 만들었을 뿐일 수 있다). */
const COMMAND_SURFACES = [
  { kind: "claude-code", dir: join(homedir(), ".claude", "commands") },
  { kind: "codex", dir: join(homedir(), ".codex", "prompts") },
  { kind: "cursor", dir: join(homedir(), ".cursor", "commands") },
  { kind: "antigravity", dir: join(homedir(), ".gemini", "config", "skills") },
];

function findCli(candidates) {
  for (const c of candidates) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      try {
        execFileSync(process.platform === "win32" ? "where" : "which", [c], { stdio: "pipe" });
        return c;
      } catch {
        /* not on PATH */
      }
    }
  }
  return null;
}

const helpCache = new Map();
function helpText(bin, helpArgs) {
  const key = `${bin}\0${helpArgs.join(" ")}`;
  if (helpCache.has(key)) return helpCache.get(key);
  // ★stdout+stderr 둘 다 — agy 는 --help 를 stderr 로 쓴다(실측 1.1.14). stdout 만
  // 보면 설치돼 있어도 "플래그 없음"으로 오판해 프로브가 거짓 DRIFT 를 낸다.
  const run = spawnSync(bin, helpArgs, { stdio: "pipe", timeout: 10_000 });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  helpCache.set(key, text);
  return text;
}

let drift = 0;
let skipped = 0;
const versions = {};

for (const claim of SURFACE_CLAIMS) {
  const bin = findCli(CLI_CANDIDATES[claim.kind] ?? []);
  if (!bin) {
    skipped += 1;
    console.log(`SKIP  ${claim.kind} ${claim.flag} — CLI not installed on this machine`);
    continue;
  }
  if (!versions[claim.kind]) {
    try {
      versions[claim.kind] = execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 10_000 }).toString().trim().split("\n")[0];
    } catch {
      versions[claim.kind] = "version unknown";
    }
  }
  const text = helpText(bin, claim.helpArgs);
  if (text.includes(claim.flag)) {
    console.log(`OK    ${claim.kind} ${claim.flag} (${versions[claim.kind]})`);
  } else {
    drift += 1;
    console.log(`DRIFT ${claim.kind} ${claim.flag} — not in \`${claim.helpArgs.join(" ")}\` output of ${bin} (${versions[claim.kind]}). Update shared/runtime-capabilities.ts or the runner.`);
  }
}

// 서술자 소스가 주장 플래그를 실제로 담고 있는지도 본다 — 주장 목록과 서술자가
// 서로 어긋나면 이 프로브 자체가 죽은 검사다.
for (const claim of SURFACE_CLAIMS) {
  if (claim.flag.startsWith("--") && !descriptorSource.includes(claim.flag)) {
    // 서술자에 없는 플래그를 프로브만 주장 — 러너 배선 전용 플래그면 정상이라 정보만.
    console.log(`NOTE  probe checks ${claim.kind} ${claim.flag} but the descriptor does not mention it (runner-level flag)`);
  }
}

for (const surface of COMMAND_SURFACES) {
  console.log(`${existsSync(surface.dir) ? "DIR   " : "ABSENT"} ${surface.kind} command surface ${surface.dir}`);
}

/*
 * ★훅 강제 상태 — 이건 플래그 유무가 아니라 **실측 결과**라서 프로브가 재측정하지
 * 않는다(도구를 실제로 실행시켜야 알 수 있다). 대신 서술자에 적힌 판정을 그대로
 * 보고해, "아직 안 한 것"이 사람 기억이 아니라 출력에 남게 한다.
 */
const HOOK_STATUS = [
  ["claude-code", "WIRED   PreToolUse via --settings (measured 2026-08-04)"],
  ["grok", "WIRED   grok agent --plugin-dir (measured 2026-08-19)"],
  ["antigravity", "REFUTED PreToolUse does not fire on the headless path (measured 2026-08-19) — MCP tools still gated by the proxy"],
  ["codex", "UNPROBED enforcement re-probe blocked until the usage limit clears"],
  ["cursor", "UNMEASURABLE cursor-agent is not installed on this machine"],
  ["kimi", "UNMEASURABLE kimi is not installed on this machine"],
];
console.log("");
for (const [kind, status] of HOOK_STATUS) console.log(`HOOK  ${kind}: ${status}`);
console.log(`\nprobe summary: drift=${drift} skipped=${skipped}`);
if (check && drift > 0) {
  console.error("probe-runtime-capabilities: descriptor drifted from installed CLIs (see DRIFT lines)");
  process.exit(1);
}
