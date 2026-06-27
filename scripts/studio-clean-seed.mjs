#!/usr/bin/env node
// studio-pack 의 데모 studio-data.json 에서 모든 데모 내용·외부 URL 을 제거해 "유효하지만 빈" board
// 시드(clean-studio-data.json)를 만든다. SPA 는 유효한 board 를 받으면 baked 데모 샘플 대신 이 빈
// board 를 렌더한다 → 목업 데이터 없음. 생성물은 런타임에 로컬(userData)에 쓰인다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "studio-pack", "web", "dist", "studio-data.json");
const OUT = path.join(ROOT, "studio-pack", "clean-studio-data.json");

if (!fs.existsSync(SRC)) {
  console.error("[studio-clean] 원본 studio-data.json 없음:", SRC);
  process.exit(2);
}

const URL_RE = /^(https?:|data:|blob:|\/\/)/i;
// 비울 prose 키(사람이 읽는 데모 텍스트). 짧은 enum/type/id 필드는 보존해 렌더 크래시를 막는다.
const PROSE_KEYS = new Set([
  "oneLiner", "customer", "problem", "headline", "summary", "note", "description", "desc",
  "body", "caption", "title", "subtitle", "text", "detail", "rationale", "insight",
  "source", "evidence", "quote", "label", "value", "name", "bigStat", "stat", "copy",
]);
// 렌더가 의존하는 enum/tone/status/type/id 류만 보존: 짧고, 공백 없고, ASCII 식별자형.
// (한글 등 비-ASCII 짧은 문자열은 데모 콘텐츠로 보고 제거 — 예: appName "단골노트")
function isEnumLike(s) {
  return s.length <= 24 && /^[A-Za-z0-9_.:\/-]+$/.test(s);
}

// 재귀 클린: URL 제거, 데모 prose 제거, 동적 배열 비움. enum/type/짧은 라벨·숫자·불리언은 보존.
function clean(v, key) {
  if (Array.isArray(v)) return []; // 동적 리스트(competitors/personas/trends/sources/assets/blocks…) 비움
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clean(val, k);
    return out;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (URL_RE.test(t)) return ""; // 외부 미디어/CDN 제거(불필요한 fetch·404 방지)
    if (PROSE_KEYS.has(key)) return ""; // 데모 텍스트 제거
    if (isEnumLike(t)) return v; // tone/status/type/id 등 보존
    return ""; // 그 외 긴 문자열은 데모 prose 로 보고 제거
  }
  return v; // 숫자/불리언/null 보존(구조 의존)
}

const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
const cleaned = clean(data, "");
cleaned.name = ""; // 데모 "단골노트" 제거
fs.writeFileSync(OUT, JSON.stringify(cleaned), "utf8");
console.log("[studio-clean] wrote", OUT, "(", fs.statSync(OUT).size, "bytes )");
