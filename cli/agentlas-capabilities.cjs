"use strict";
/*
 * Runtime capability registry (core) + capability-aware auto-routing.
 *
 * User-verified (2026-05): images are produced by the native CLIs themselves —
 *   codex  → Imagen,  gemini → nano-banana (Gemini 2.5 Flash Image),  claude → NO image gen.
 * BYOK: openai (gpt-image) and google (imagen) can do images; anthropic/ollama cannot.
 *
 * So a multi-LLM team = each agent runs on a runtime whose capabilities match its job:
 * an image/design agent auto-routes to gemini/codex, a coding agent to claude/codex.
 */

// keyed by runtime "spec": cli kind (claude-code|codex|gemini) or api backend (anthropic|openai|google|ollama)
const RUNTIME_CAPS = {
  "claude-code": { code: true, image: false, label: "claude" },
  codex: { code: true, image: true, label: "codex" }, // Imagen
  gemini: { code: true, image: true, label: "gemini" }, // nano-banana
  anthropic: { code: true, image: false, label: "anthropic" },
  openai: { code: true, image: true, label: "openai" }, // gpt-image
  google: { code: true, image: true, label: "google" }, // imagen
  ollama: { code: true, image: false, label: "ollama" },
  upstage: { code: true, image: false, label: "solar" }, // Upstage Solar — Korean sovereign LLM (OpenAI-compatible)
};

const CLI_KINDS = ["claude-code", "codex", "gemini"];

function capsFor(spec) {
  return RUNTIME_CAPS[spec] || { code: true, image: false, label: spec || "?" };
}

// runtime object ⇄ spec string
function specOf(rt) {
  if (!rt) return "";
  return rt.mode === "cli" ? rt.kind : rt.backend;
}
function runtimeFromSpec(spec) {
  return CLI_KINDS.includes(spec) ? { mode: "cli", kind: spec } : { mode: "api", backend: spec, model: null };
}

// Does this agent's job involve generating/handling images?
const IMAGE_HINTS = [
  /image/i, /이미지/, /그림/, /\bdesign\b/i, /디자인/, /쇼핑몰/, /상품\s*(사진|이미지|상세)/, /상세\s*페이지/,
  /thumbnail/i, /썸네일/, /banner/i, /배너/, /poster/i, /포스터/, /visual/i, /비주얼/, /illustrat/i, /일러스트/,
  /로고/, /\blogo\b/i, /사진/, /photo/i, /nano-?banana/i, /imagen/i, /이미지\s*생성/, /그래픽/, /graphic/i,
];
// 빌더/메타/조율/거버넌스 역할은 (이미지 에이전트를 *만들* 수는 있어도) 스스로 이미지를 생산하지 않는다.
// 이런 역할이 system_prompt에 "이미지/디자인"을 언급한다는 이유로 gemini로 끌려가면 코드/빌드 품질이 떨어진다.
const NON_IMAGE_ROLES = new Set(["meta", "builder", "orchestrator", "pm", "curator", "governance"]);
function needsImage(agent) {
  if (!agent) return false;
  if (NON_IMAGE_ROLES.has(String(agent.role || "").toLowerCase())) return false;
  const hay = `${agent.name || ""} ${agent.name_en || ""} ${agent.tagline || ""} ${agent.tagline_en || ""} ${agent.system_prompt || ""}`;
  return IMAGE_HINTS.some((re) => re.test(hay));
}

// Auto-pick a runtime spec for an agent given installed CLI kinds and the session default spec.
// Image agents route to an installed image-capable runtime; otherwise keep the session default.
function autoRuntimeFor(agent, { installedKinds, activeSpec }) {
  if (needsImage(agent)) {
    if (capsFor(activeSpec).image) return activeSpec;
    for (const k of ["gemini", "codex"]) if ((installedKinds || []).includes(k)) return k;
  }
  return activeSpec;
}

// short capability badge for display
function badge(spec) {
  const c = capsFor(spec);
  return c.image ? "🖼" : "";
}

module.exports = { RUNTIME_CAPS, CLI_KINDS, capsFor, specOf, runtimeFromSpec, needsImage, autoRuntimeFor, badge };
