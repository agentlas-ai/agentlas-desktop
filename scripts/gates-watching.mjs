/*
 * 이 파일을 지키는 게이트가 무엇인지 답한다.
 *
 * 왜: 게이트가 구현 문장을 못박고 있으면, 화면을 고친 사람은 자기가 무엇을 깼는지 커밋
 * 전까지 모른다(2026-08-23: 출력 레일에 앱 탭을 더하자 One Team 화면 계약 게이트가 깨졌고,
 * 그 게이트는 자동 실행 경로가 한 곳도 없어 손으로 돌렸을 때에야 드러났다).
 * 편집 시점에 "이 파일은 이 게이트가 물고 있다"를 알리면 같은 커밋에서 함께 고칠 수 있다.
 *
 * 사용:
 *   node scripts/gates-watching.mjs renderer/components/one/OneShell.tsx
 *   node scripts/gates-watching.mjs --hook      # stdin 으로 호스트 훅 payload 를 받는다
 *
 * 판정은 문자열 언급이다(경로를 변수에 담아 읽는 게이트가 흔해서 readFileSync 만 보면 놓친다).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_RE = /^(test|verify)-.*\.(cjs|mjs)$/;

export function gatesWatching(relative) {
  if (!relative) return [];
  const dir = path.join(root, "scripts");
  const hits = [];
  for (const name of fs.readdirSync(dir)) {
    if (!GATE_RE.test(name)) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    if (text.includes(relative)) hits.push(`scripts/${name}`);
  }
  return hits;
}

function toRelative(value) {
  if (!value) return "";
  const absolute = path.resolve(value);
  if (!absolute.startsWith(`${root}${path.sep}`)) return "";
  return path.relative(root, absolute);
}

// 이 파일은 도구이자 모듈이다. 다른 스크립트가 `gatesWatching` 만 쓰려고 import 했을 때
// CLI 출력이 섞이면 안 된다 — 직접 실행됐을 때만 CLI 로 행동한다.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const hookMode = process.argv.includes("--hook");

if (invokedDirectly && !hookMode) {
  const relative = toRelative(process.argv[2]) || process.argv[2] || "";
  const hits = gatesWatching(relative);
  if (!hits.length) console.log(`gates-watching: ${relative || "(no path)"} — 물고 있는 게이트 없음`);
  else console.log(`gates-watching: ${relative} — ${hits.length}개\n${hits.map((h) => `  ${h}`).join("\n")}`);
  process.exit(0);
}

// 훅 모드도 직접 실행일 때만. import 한 쪽의 stdin 을 읽어 버리면 안 된다.
if (!invokedDirectly) {
  // 모듈로 불렸다 — CLI 동작은 아무것도 하지 않는다.
} else {

// 훅 모드: 실패해도 편집을 막지 않는다. 알림이 임무다.
let payload = {};
try {
  const raw = fs.readFileSync(0, "utf8");
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch { payload = {}; }

const input = payload.tool_input || payload.toolInput || {};
const relative = toRelative(input.file_path || input.filePath || input.notebook_path || input.path || "");
const hits = relative ? gatesWatching(relative) : [];

if (!hits.length) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const shown = hits.slice(0, 8);
const context = [
  `이 파일은 게이트 ${hits.length}개가 물고 있습니다: ${shown.join(", ")}${hits.length > shown.length ? ` 외 ${hits.length - shown.length}개` : ""}`,
  "그 게이트가 구현 문장을 못박고 있으면 이번 편집으로 깨집니다.",
  "같은 커밋에서 게이트도 새 계약으로 갱신하세요(구현 문자열이 아니라 계약을 단언할 것).",
  "확인: cd agentlas_desktop && npm run gate:freshness:check",
].join(" ");

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: payload.hook_event_name || "PostToolUse",
    additionalContext: context,
  },
})}\n`);

}
