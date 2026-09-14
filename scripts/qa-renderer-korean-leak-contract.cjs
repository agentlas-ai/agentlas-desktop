#!/usr/bin/env node
"use strict";
/*
 * 영어 화면에 한국어가 새지 않는가 — 데스크탑 renderer 판(Science 판: agentlas-science scripts/ui-korean-leak-contract.cjs).
 * 오너 신고 2026-09-14("took 20초")에서 시작했다. renderer 는 키 사전(i18n.tsx t/tFor)과 컴포넌트 안의 언어 삼항
 * (`ko ? … : …`, `locale === "ko" ? …`, `locale === "en" ? … : …`), `{ko:, en:}`·`name/nameEn` 짝을 쓴다.
 * 이 계약은 그 한국어 갈래(JSX 포함)를 지운 뒤에도 남는 한글 조각을 센다. 남은 것은 영어 화면에 그대로 나오는 문구다.
 *   node scripts/qa-renderer-korean-leak-contract.cjs            → 누수 목록, 1건이라도 있으면 exit 1
 *   node scripts/qa-renderer-korean-leak-contract.cjs --summary  → 파일별 개수만
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", process.env.AGENTLAS_KOREAN_LEAK_ROOT || "renderer");
const SKIP = [
  /[\\/]app[\\/]\(no-shell\)[\\/]surface-preview[\\/]/, // QA-only preview: notFound() in production unless NEXT_PUBLIC_AGENTLAS_QA_SURFACES=1
  /[\\/]library[\\/]agents[\\/]transform\.js$/,            // one-off codemod script, never imported by the app
  /node_modules/, /[\\/]\.next/, /[\\/]public[\\/]/, /[\\/]private[\\/]/, /[\\/]lib[\\/]i18n\.tsx$/, /\.d\.ts$/, /one-conversation-locale\.ts$/];
function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (SKIP.some((rule) => rule.test(full))) return [];
    if (entry.isDirectory()) return listFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [full] : [];
  });
}

const blankRange = (text, start, end) => text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
function literalEnd(text, start) {
  const quote = text[start];
  let i = start + 1;
  if (quote !== "`") {
    for (; i < text.length; i++) { if (text[i] === "\\") { i++; continue; } if (text[i] === quote || text[i] === "\n") return i + 1; }
    return i;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (depth === 0) { if (c === "`") return i + 1; if (c === "$" && text[i + 1] === "{") { depth = 1; i++; } continue; }
    if (c === "`" || c === "\"" || c === "'") { i = literalEnd(text, i) - 1; continue; }
    if (c === "{") depth++; else if (c === "}") depth--;
  }
  return i;
}
// Scan one expression branch starting at `from`; returns the index where it ends (top-level `:` for a ternary's
// true branch, or `,` `;` `)` `}` `]` or an unmatched closer / JSX close for the false branch).
function branchEnd(text, from, stopAtColon) {
  let depth = 0; let nested = 0; let i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\"" || c === "'" || c === "`") { i = literalEnd(text, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; continue; }
    if (depth > 0) continue;
    if (c === "?" && text[i + 1] !== "." && text[i + 1] !== "?") { nested++; continue; }
    if (c === ":") { if (nested === 0) { if (stopAtColon) return i; } else nested--; continue; }
    if (c === "," || c === ";") return i;
    if (!stopAtColon && c === "\n" && /^\s*[<)]/.test(text.slice(i + 1, i + 40))) return i;
  }
  return i;
}
function closingBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\"" || c === "'" || c === "`") { i = literalEnd(text, i) - 1; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") { depth--; if (depth === 0) return i; }
  }
  return text.length;
}
function applyRanges(text, ranges) {
  if (!ranges.length) return text;
  const chars = text.split("");
  for (const [from, to] of ranges) for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}
function scrub(source) {
  // comments first (one pass each), then collect every Korean-branch range on that text and blank them once
  let text = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  text = text.replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/[^\n]/g, " "));
  if (!/[가-힣]/u.test(text)) return text;
  // regex literals match user input (e.g. /실패|failed/), they are never shown on screen
  text = text.replace(/(^|[(,=:\[!&|?{};>\n]|\breturn|\bmatch\(|\btest\()(\s*)\/(?![*/\s])((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\])+)\/([dgimsuy]*)/g,
    (m, lead, space, body, flags) => `${lead}${space}/${body.replace(/[^\n]/g, " ")}/${flags}`);
  const ranges = [];
  for (const pattern of [/(?:\b(?:ko|isKo|isKorean|korean|koUi|isKoUi)|\w*(?:IsKo|IsKorean|isKorean)\(\)|\b\w*[kK]o(?:Ref)?\.current)\s*\)?\s*\?(?![.?])/g, /\b\w*(?:locale|Locale|lang|Lang|language|Language|loc)(?:\(\))?\s*===\s*["']ko["']\s*\)?\s*\?/g, /["']ko["']\s*===\s*\w+\s*\?/g]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[0].length;
      ranges.push([start, branchEnd(text, start, true)]);
    }
  }
  for (const pattern of [/\b\w*(?:locale|Locale|lang|Lang|language|Language|loc)\s*===\s*["']en["']\s*\)?\s*\?/g, /\b\w*(?:locale|Locale|lang|Lang|language|Language|loc)\s*!==\s*["']ko["']\s*\)?\s*\?/g, /\b(?:en|isEn|isEnglish)\s*\?(?![.?])/g]) {
    for (const match of text.matchAll(pattern)) {
      const colon = branchEnd(text, match.index + match[0].length, true);
      if (text[colon] !== ":") continue;
      ranges.push([colon + 1, branchEnd(text, colon + 1, false)]);
    }
  }
  const LIT = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;
  for (const pattern of [
    /\b(?:ko\w*|\w+Ko)\s*:/g,
    new RegExp(String.raw`\b(\w+)\s*:(?=\s*` + LIT + String.raw`\s*,\s*\1En\s*:)`, "g"),
    new RegExp(String.raw`\[(?=\s*` + LIT + String.raw`\s*,\s*` + LIT + String.raw`\s*\])`, "g"),
    /\b(?:L|bi|pickKoEn|koEn)\(/g,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[0].length;
      ranges.push([start, branchEnd(text, start, false)]);
    }
  }
  // Korean-only maps: const LABELS_KO = {...} / const KO: Record<…> = {...} (their English twin is chosen by locale)
  for (const match of text.matchAll(/\bconst\s+(?:ko|\w*(?:KO|Ko|_ko))\b[^=\n]*=\s*[{[]/g)) {
    const open = match.index + match[0].length - 1;
    ranges.push([open, closingBracket(text, open) + 1]);
  }
  // guards: `if (!ko) return English;` / `if (locale === "en") { return […]; }` → the rest of that block is the Korean path;
  // `if (ko) return 한국어;` / `if (language === "ko") { … }` → that statement or block
  const LOCALE_NAME = String.raw`\w*(?:locale|Locale|lang|Lang|language|Language)(?:\(\))?`;
  const guardEnglish = new RegExp(String.raw`\bif\s*\(\s*(?:!\s*(?:ko|isKo)|` + LOCALE_NAME + String.raw`\s*(?:!==\s*["']ko["']|===\s*["']en["']))\s*\)\s*`, "g");
  const guardKorean = new RegExp(String.raw`\bif\s*\(\s*(?:ko|isKo|` + LOCALE_NAME + String.raw`\s*===\s*["']ko["'])\s*\)\s*`, "g");
  const statementEnd = (from) => (text[from] === "{" ? closingBracket(text, from) + 1 : branchEnd(text, from, false));
  const blockEnd = (from) => {
    let depth = 0; let i = from;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\"" || c === "'" || c === "`") { i = literalEnd(text, i) - 1; continue; }
      if (c === "{") depth++; else if (c === "}") { if (depth === 0) break; depth--; }
    }
    return i;
  };
  for (const match of text.matchAll(guardEnglish)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = statementEnd(bodyStart);
    if (!/\breturn\b/.test(text.slice(bodyStart, bodyEnd))) continue;
    ranges.push([bodyEnd, blockEnd(bodyEnd)]);
  }
  for (const match of text.matchAll(guardKorean)) {
    const bodyStart = match.index + match[0].length;
    ranges.push([bodyStart, statementEnd(bodyStart)]);
  }
  // comparisons against Korean literals parse input, they do not render: m[1] === "선택"
  for (const match of text.matchAll(/[!=]==\s*(?=["'`])/g)) {
    const start = match.index + match[0].length;
    ranges.push([start, literalEnd(text, start)]);
  }
  // Korean-only string constants: const EXAMPLE_GOAL_KO = "…";
  for (const match of text.matchAll(/\bconst\s+\w*_KO\s*(?::[^=\n]+)?=/g)) {
    const start = match.index + match[0].length;
    ranges.push([start, branchEnd(text, start, false)]);
  }
  // arrays mixing Korean and English literals are bilingual tuples or keyword lists: ["◎", "Agents", "에이전트"], tags: ["ai", "모델"]
  for (const match of text.matchAll(/\[/g)) {
    const end = closingBracket(text, match.index);
    if (end - match.index > 600) continue;
    const body = text.slice(match.index + 1, end);
    const literals = [...body.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)];
    if (literals.length < 2 || !literals.some((l) => /[가-힣]/u.test(l[0])) || !literals.some((l) => !/[가-힣]/u.test(l[0]) && /[A-Za-z]{2}/.test(l[0]))) continue;
    for (const l of literals) if (/[가-힣]/u.test(l[0])) ranges.push([match.index + 1 + l.index, match.index + 1 + l.index + l[0].length]);
  }
  // matching and logging calls never render: .includes("기획"), .startsWith, console.error("…")
  for (const match of text.matchAll(/\.(?:includes|startsWith|endsWith|indexOf|test|match|split|replace|replaceAll)\(|\bconsole\.\w+\(/g)) {
    const open = match.index + match[0].length - 1;
    ranges.push([open, closingBracket(text, open) + 1]);
  }
  // bilingual helper calls of any name: text("English", "한국어"), bi(locale, "한국어", "English"), L(ko, en) …
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\s*\(/g)) {
    let i = match.index + match[0].length;
    const args = [];
    let argStart = i; let depth = 0;
    for (; i < text.length && args.length < 5; i++) {
      const c = text[i];
      if (c === "\"" || c === "'" || c === "`") { i = literalEnd(text, i) - 1; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; continue; }
      if (c === ")" || c === "]" || c === "}") { if (depth === 0) { args.push([argStart, i]); break; } depth--; continue; }
      if (c === "," && depth === 0) { args.push([argStart, i]); argStart = i + 1; }
    }
    if (args.length < 2) continue;
    const literalArgs = args.map(([from, to]) => {
      const raw = text.slice(from, to).trim();
      // a literal, or a concatenation/ternary of literals ("…" + (x ? "…" : "") + "…")
      return /^[("'`]/.test(raw) && /["'`]/.test(raw) && !/=>|\bfunction\b/.test(raw) ? { from, to, raw } : null;
    });
    const korean = literalArgs.filter((arg) => arg && /[가-힣]/u.test(arg.raw));
    const english = literalArgs.filter((arg) => arg && !/[가-힣]/u.test(arg.raw) && /[A-Za-z]{2}/.test(arg.raw));
    if (korean.length && english.length) for (const arg of korean) ranges.push([arg.from, arg.to]);
  }
  return applyRanges(text, ranges);
}

const files = listFiles(root);
const leaks = [];
for (const file of files) {
  const text = scrub(fs.readFileSync(file, "utf8"));
  const INTENTIONAL = [
    /^한국어로 (?:바꾸기|전환)$/u, // the switch-to-Korean control is written in Korean on purpose
  ];
  text.split("\n").forEach((lineText, index) => {
    if (!/[가-힣]/u.test(lineText)) return;
    for (const piece of lineText.split(/["'`<>{}$]/)) {
      const segment = piece.replace(/^[\s:·,;()=|&?!]+|[\s:·,;(=|&?]+$/g, "");
      if (/[가-힣]/u.test(segment) && !INTENTIONAL.some((rule) => rule.test(segment))) leaks.push({ file: path.relative(path.resolve(__dirname, ".."), file), line: index + 1, segment: segment.slice(0, 100) });
    }
  });
}
if (process.argv.includes("--summary")) {
  const byFile = new Map();
  for (const leak of leaks) byFile.set(leak.file, (byFile.get(leak.file) || 0) + 1);
  console.log(`renderer Korean leaks: ${leaks.length} in ${byFile.size} of ${files.length} files`);
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(5)}  ${file}`);
  process.exit(0);
}
if (leaks.length) {
  console.error(`RENDERER_KOREAN_LEAK — ${leaks.length} fragment(s):\n${leaks.map((l) => `${l.file}:${l.line}: ${l.segment}`).join("\n")}`);
  process.exit(1);
}
console.log(`PASS qa-renderer-korean-leak-contract (${files.length} files)`);
