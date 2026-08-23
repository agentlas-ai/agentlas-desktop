// One 화면 표면 계약 게이트 — 눈으로만 잡히던 두 결함을 코드로 못박는다.
//
// 오너 지적 2026-08-23:
//   ① 첨부 칩이 입력창보다 왼쪽으로 튀어나온다(작업 중 컴포저만 좁아지는데 첨부는 안 좁아짐).
//   ② 사용자 말풍선이 검은 배경인데 글자도 검다 — 본문 렌더러가 인라인으로 var(--ink) 를
//      박아 클래스의 color 를 이긴다.
//
// 지키는 계약(픽셀값이 아니라 관계):
//   A. 컴포저 위에 쌓이는 줄(첨부·오류·칩·스티어링)은 컴포저와 **같은 폭 규칙**을 함께 받는다.
//   B. 배경을 어둡게 만든 말풍선은 그 안에서 잉크 변수도 함께 뒤집는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "renderer/components/one/OneShell.module.css"), "utf8");

// ── A. 컴포저 스택은 같은 폭 규칙을 공유한다 ───────────────────────────────
const STACK = [".composer", ".steeringQueue", ".oneTurnAgentChips", ".attachmentTray", ".attachmentError"];
// 폭을 좁히는 선택자 묶음을 찾아, 컴포저가 들어간 묶음에는 나머지도 전부 들어 있어야 한다.
const narrowing = [...css.matchAll(/([^{}]*\.composer[^{}]*)\{\s*width:\s*min\(720px/g)].map((m) => m[1]);
assert.ok(narrowing.length > 0, "the composer must still have a narrowed width rule to compare against");
for (const selector of narrowing) {
  for (const member of STACK) {
    assert.ok(
      selector.includes(member),
      `${member} must narrow together with .composer, otherwise its left edge no longer lines up (selector: ${selector.trim().slice(0, 120)})`,
    );
  }
}

// ── B. 어두운 말풍선은 잉크를 함께 뒤집는다 ────────────────────────────────
// 본문 렌더러가 인라인 var(--ink) 를 쓴다는 사실이 이 계약의 근거다.
const markdown = readFileSync(path.join(root, "renderer/components/Markdown.tsx"), "utf8");
assert.match(markdown, /color: "var\(--ink\)"/, "this gate assumes the renderer inlines var(--ink); re-check if that changed");

const blocks = [...css.matchAll(/\.message\[data-role="user"\] \.messageBody \{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(blocks.length > 0, "the user bubble must still be styled here");
for (const block of blocks) {
  const background = block.match(/background:\s*(#[0-9a-fA-F]{3,8})/);
  if (!background) continue;
  const hex = background[1].replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  const luminance = (parseInt(full.slice(0, 2), 16) * 299 + parseInt(full.slice(2, 4), 16) * 587 + parseInt(full.slice(4, 6), 16) * 114) / 1000;
  if (luminance >= 128) continue; // 밝은 말풍선은 기본 잉크로 읽힌다
  assert.match(block, /--ink:\s*#[0-9a-fA-F]{3,8}/, "a dark user bubble must redefine --ink so inlined body text stays readable");
  assert.match(block, /--ink-soft:\s*#[0-9a-fA-F]{3,8}/, "a dark user bubble must redefine --ink-soft too");
}

// ── C. 설정 시트: 아이콘 없는 행은 3열 격자에 넣지 않는다 ──────────────────
// .toolRow 는 `36px minmax(0,1fr) auto` 다. 아이콘을 안 넣는 행이 그것을 쓰면 제목이 36px 칸에
// 갇혀 "알려…/데스…/방해…" 로 잘린다(브리핑 시트에서 실제로 그랬다 — 2026-08-23).
const settingsCss = readFileSync(path.join(root, "renderer/components/one/OneSettings.module.css"), "utf8");
const settingsTsx = readFileSync(path.join(root, "renderer/components/one/OneSettings.tsx"), "utf8");
assert.match(settingsCss, /\.settingRow \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "an icon-less setting row needs a two-column rule");
assert.match(settingsCss, /\.settingCopy strong \{[^}]*font-size: 13px/, "sheet body text must not reuse the 11px sidebar size");
// 시트 안에서 사이드바용 railCopy 를 다시 쓰면 글씨가 8~11px 로 작아진다.
const sheetBody = settingsTsx.slice(settingsTsx.indexOf("function BriefingSettings"));
assert.doesNotMatch(sheetBody, /styles\.railCopy/, "the settings sheet must not reuse the sidebar copy style");

// ── D. 시트 폭은 내용이 정한다 ─────────────────────────────────────────────
// 전부 wide(1120px)로 열면 스위치 두 개짜리 설정도 도구 목록과 같은 폭을 차지한다.
assert.match(settingsTsx, /const SHEET_WIDTH: Record<OneSettingsKey, OneBottomSheetSize>/, "each settings pane must choose its own width");
assert.doesNotMatch(settingsTsx, /size="wide"/, "the settings sheet must not hard-code one width for every pane");

console.log("one surface PASS: composer stack aligned, dark bubble ink flipped, icon-less rows two-column, sheet width follows content");
