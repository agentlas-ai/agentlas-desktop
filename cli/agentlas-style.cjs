"use strict";

/*
 * Global terminal reply style for Agentlas.
 *
 * This is intentionally kept outside individual agent prompts so imported,
 * cloud-installed, company, native-CLI, and BYOK agents all share one contract.
 */

function detectResponseLanguage(prompt, fallback) {
  const text = String(prompt || "");
  if (/\b(answer|reply|respond|write)\s+in\s+(english|en)\b/i.test(text)) return "en";
  if (/(영어로|영문으로|english로)/i.test(text)) return "en";
  if (/(한국어로|한글로|한글\s*답|korean으로)/i.test(text)) return "ko";
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (hangul >= 2 && hangul >= latin * 0.15) return "ko";
  if (latin >= 2 && hangul === 0) return "en";
  return fallback === "ko" ? "ko" : "en";
}

function responseLanguageDirective(lang) {
  return lang === "ko"
    ? [
        "응답 언어: 한국어.",
        "이번 사용자 메시지가 다른 언어를 명시적으로 요구하지 않는 한 한국어만 사용하세요.",
        "제품명, 명령어, 파일 경로, 코드 식별자처럼 번역하면 안 되는 고유명사만 원문을 유지하세요.",
        "한 문단 안에서 한국어와 영어 설명을 섞지 마세요.",
      ].join("\n")
    : [
        "Response language: English.",
        "Use English only unless this user message explicitly asks for another language.",
        "Keep product names, commands, file paths, and code identifiers unchanged.",
        "Do not mix Korean and English explanatory prose in the same reply.",
      ].join("\n");
}

function responseStyleDirective() {
  return [
    "Global Agentlas reply style:",
    "Use normal Markdown when it aids clarity — **bold** for emphasis, `code`/code blocks for code,",
    "paths, and commands, and # headings, - bullets, or 1. numbered lists for structure.",
    "Keep replies concise; make the first sentence concrete and action-oriented.",
    "Do not expose hidden chain-of-thought — give the result and a short rationale.",
  ].join("\n");
}

function responseDirective(lang) {
  return responseLanguageDirective(lang) + "\n\n" + responseStyleDirective();
}

let EMOJI_RE = null;
try {
  EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\uFE0F\\u200D]+", "gu");
} catch {
  EMOJI_RE = /[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/g;
}

function sanitizeAssistantText(text) {
  return String(text || "")
    .replace(EMOJI_RE, "")
    .replace(/\*\*/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}-{3,}\s*$/gm, "")
    .replace(/[ \t]+[-–—][ \t]+/g, ": ");
}

function createStreamingSanitizer() {
  let pending = "";
  return {
    reset() {
      pending = "";
    },
    push(chunk) {
      let value = pending + String(chunk || "");
      pending = "";
      if (value.endsWith("*")) {
        pending = "*";
        value = value.slice(0, -1);
      }
      return sanitizeAssistantText(value);
    },
    flush() {
      const value = sanitizeAssistantText(pending);
      pending = "";
      return value;
    },
  };
}

module.exports = {
  createStreamingSanitizer,
  detectResponseLanguage,
  responseDirective,
  responseLanguageDirective,
  responseStyleDirective,
  sanitizeAssistantText,
};
