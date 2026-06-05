#!/usr/bin/env node
/*
 * Agentlas terminal CLI (Phase 1).
 *
 * 앱(GUI)과 같은 데이터를 공유한다 — 같은 userData의 SQLite, 같은 keychain(env).
 * Electron-as-Node로 실행되도록 설계: 앱이 번들한 네이티브 모듈(better-sqlite3 / keytar)을
 * 그대로 require 한다. (래퍼: ELECTRON_RUN_AS_NODE=1 <Agentlas execPath> <이 파일> ...)
 *
 * 명령:
 *   agentlas list                  설치된 에이전트/회사 + 활성 런타임
 *   agentlas cd <agent>            에이전트 폴더 경로 출력 (CLAUDE.md/AGENTS.md/GEMINI.md 생성)
 *                                  → cd "$(agentlas cd seo)" && claude
 *   agentlas run <agent> [prompt]  활성(또는 --runtime) CLI로 1회 실행. prompt 없으면 stdin.
 *   agentlas chat <agent>          대화형 REPL
 *   agentlas env [list]            공유 env 키 목록 (이름만)
 *   agentlas multimodal            이미지/영상/음성 전역 fallback provider
 *   agentlas doctor                런타임/데이터 점검
 *   agentlas help
 *
 * 옵션: --runtime claude-code|codex|gemini
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

// ── 앱과 동일한 userData 경로 (electron app.getPath('userData')와 일치) ──
function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

const SERVICE = "com.agentlas.desktop";
const ENV_PREFIX = "env:";
const MULTIMODAL_META_KEY = "multimodal_settings";
// 도구 사용 권한 (read|write|full). 빌드/파일 생성이 기본 동작이므로 기본값 write.
// `--permission full` 로 셸 명령 포함 전체 자동(npm/mkdir 등) 허용. main()에서 설정.
let PERMISSION = "write";
let PERMISSION_EXPLICIT = false; // true once --permission is passed (overrides saved prefs)

function dbPath() {
  return path.join(userDataDir(), "agentlas.sqlite");
}

function openDb() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    fail(`데이터를 찾을 수 없습니다: ${p}\nAgentlas 앱을 한 번 실행해 에이전트를 설치하세요.`);
  }
  try {
    const Database = require("better-sqlite3");
    return new Database(p, { readonly: false, fileMustExist: true });
  } catch (e) {
    try {
      return openNodeSqliteDb(p);
    } catch (fallbackError) {
      fail(
        "SQLite 런타임을 불러올 수 없습니다. Agentlas 앱을 한 번 실행한 뒤 다시 시도하세요.\n" +
          String((fallbackError && fallbackError.message) || (e && e.message) || fallbackError),
      );
    }
  }
}

function openNodeSqliteDb(p) {
  installNodeSqliteWarningFilter();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(p);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      };
    },
    transaction(fn) {
      return (...args) => {
        db.exec("BEGIN");
        try {
          const result = fn(...args);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* ignore rollback failure */
          }
          throw err;
        }
      };
    },
    close: () => db.close(),
  };
}

function installNodeSqliteWarningFilter() {
  if (process.__agentlasSqliteWarningFilter) return;
  Object.defineProperty(process, "__agentlasSqliteWarningFilter", { value: true });
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const message = typeof warning === "string" ? warning : String((warning && warning.message) || warning || "");
    if (/SQLite is an experimental feature/i.test(message)) return;
    return originalEmitWarning(warning, ...args);
  };
}

function readKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

function loadMultimodalCatalog() {
  try {
    return require("../dist/shared/multimodal.js");
  } catch {
    const providers = [
      { id: "codex-cli-image", modality: "image", label: "Codex CLI image", labelKo: "Codex CLI 이미지", envKeys: [], billing: "subscription", defaultModel: "runtime-default" },
      { id: "openai-image", modality: "image", label: "OpenAI Images API", labelKo: "OpenAI 이미지 API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "gpt-image-2" },
      { id: "google-image", modality: "image", label: "Google Gemini Image", labelKo: "Google Gemini 이미지", envKeys: ["GOOGLE_API_KEY"], billing: "paid-api", defaultModel: "gemini-image" },
      { id: "runway-video", modality: "video", label: "Runway API", labelKo: "Runway API", envKeys: ["RUNWAY_API_KEY"], billing: "paid-api", defaultModel: "gen4.5" },
      { id: "google-veo", modality: "video", label: "Google Veo", labelKo: "Google Veo", envKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"], billing: "provider-billing", defaultModel: "veo" },
      { id: "openai-sora", modality: "video", label: "OpenAI Sora API", labelKo: "OpenAI Sora API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "sora" },
      { id: "openai-audio", modality: "audio", label: "OpenAI Audio", labelKo: "OpenAI 오디오", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "gpt-4o-mini-tts" },
      { id: "elevenlabs-audio", modality: "audio", label: "ElevenLabs", labelKo: "ElevenLabs", envKeys: ["ELEVENLABS_API_KEY"], billing: "paid-api", defaultModel: "eleven_multilingual_v2" },
      { id: "deepgram-audio", modality: "audio", label: "Deepgram", labelKo: "Deepgram", envKeys: ["DEEPGRAM_API_KEY"], billing: "paid-api", defaultModel: "nova-3" },
      { id: "replicate-video", modality: "video", label: "Replicate", labelKo: "Replicate", envKeys: ["REPLICATE_API_TOKEN"], billing: "paid-api", defaultModel: "provider-model" },
    ];
    const defaults = { imageProvider: "codex-cli-image", videoProvider: "runway-video", audioProvider: "openai-audio" };
    return {
      MULTIMODAL_PROVIDERS: providers,
      DEFAULT_MULTIMODAL_SETTINGS: defaults,
      normalizeMultimodalSettings: (input) => ({ ...defaults, ...(input || {}) }),
      selectedMultimodalEnvKeys: (settings) => {
        const ids = new Set([settings.imageProvider, settings.videoProvider, settings.audioProvider]);
        return [...new Set(providers.filter((p) => ids.has(p.id)).flatMap((p) => p.envKeys || []))].sort();
      },
    };
  }
}

// ── 데이터 접근 ────────────────────────────────────────────
const PRIVATE_WEB_AGENT_FINGERPRINTS = new Set([
  "880db20e11cd945e5777b5aaf73c10f24de3e2e190d13631b5f3ed0e4796821c",
  "a0dba10416f15dac84202902284780ee23f31eda9dc068ccf6a28276b585ea36",
  "479d879189166bf9bde1b0cd939db746bf8c1b94f2aad553d08cf7b4a2204f9e",
  "79c16e0347312aceb57c0ec7ee6bb6ebd0118984cc716f9cd56db63d18679183",
  "56ff55fcc909461b5fc449fdb3d685c6cceeb10d59836d9a91faf3ceb41896a4",
  "978dd8a262d86397bbdaca13bbec5be313a68fb2d5c609330888818641af8079",
]);
const BACKGROUND_AGENT_FINGERPRINTS = new Set([
  "9011fb75e638676e23a36f86ea689b6e4de17cb5b5954b36810b5239ab077f0b",
  "0331d654916d648797d31598e3e18eb7fd49166e91783ab9d731648b6e855b90",
]);
const BACKGROUND_ROLES = new Set(["orchestrator", "pm", "curator", "governance"]);
function policyNormalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function policyFingerprint(value) {
  const normalized = policyNormalize(value);
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex") : null;
}
function agentFingerprints(agent) {
  return [agent.slug, agent.name, agent.name_en, agent.tagline, agent.tagline_en]
    .map(policyFingerprint)
    .filter(Boolean);
}
function isPrivateWebOnlyAgentCli(agent) {
  if (policyNormalize(agent.visibility) === "private") return true;
  if (policyNormalize(agent.role) === "meta") return true;
  return agentFingerprints(agent).some((value) => PRIVATE_WEB_AGENT_FINGERPRINTS.has(value));
}
function isBackgroundAgentCli(agent) {
  if (isPrivateWebOnlyAgentCli(agent)) return false;
  if (policyNormalize(agent.visibility) === "background") return true;
  if (agent.builtin && BACKGROUND_ROLES.has(policyNormalize(agent.role))) return true;
  return agentFingerprints(agent).some((value) => BACKGROUND_AGENT_FINGERPRINTS.has(value));
}
function listPublicAgents(db) {
  return db.prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC").all()
    .filter((agent) => !isPrivateWebOnlyAgentCli(agent))
    .map((agent) => ({ ...agent, visibility: isBackgroundAgentCli(agent) ? "background" : "visible" }));
}
function listAgents(db) {
  return listPublicAgents(db).filter((agent) => agent.visibility !== "background");
}
function listRoutableAgents(db) {
  return listPublicAgents(db);
}
function activeRuntime(db) {
  try {
    return db.prepare("SELECT * FROM active_runtime WHERE id = 1").get() || null;
  } catch {
    return null;
  }
}
function getMultimodalSettingsCli(db) {
  const mm = loadMultimodalCatalog();
  let raw = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(MULTIMODAL_META_KEY);
    raw = row && row.value;
  } catch {
    raw = null;
  }
  try {
    return mm.normalizeMultimodalSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return mm.normalizeMultimodalSettings(null);
  }
}
function saveMultimodalSettingsCli(db, patch) {
  const mm = loadMultimodalCatalog();
  const next = mm.normalizeMultimodalSettings({ ...getMultimodalSettingsCli(db), ...patch, updatedAt: new Date().toISOString() });
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(MULTIMODAL_META_KEY, JSON.stringify(next));
  } catch (e) {
    fail("multimodal settings 저장 실패: " + e.message);
  }
  return next;
}
function routesMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir(), "agent-routes.json"), "utf8"));
  } catch {
    return {};
  }
}
function resolveAgent(db, query) {
  if (!String(query || "").trim()) return null;
  const agents = listAgents(db);
  const q = (query || "").toLowerCase();
  return (
    agents.find((a) => a.slug === query || a.id === query) ||
    agents.find((a) => (a.name || "").toLowerCase() === q || (a.name_en || "").toLowerCase() === q) ||
    agents.find((a) => (a.slug || "").toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.name_en || "").toLowerCase().includes(q)) ||
    null
  );
}
const GLOBAL_ORCHESTRATOR_SLUG = "agentlas-orchestrator";
const ROUTE_STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "make", "build", "create", "agent", "agents", "please", "좀", "해주세요", "해줘", "만들어", "붙여", "연결", "작업", "요청"]);
const ROUTE_HINTS = [
  {
    slug: "agentlas-app-builder",
    terms: [
      "apps generate",
      "app builder",
      "make an app",
      "build an app",
      "create an app",
      "generated app",
      "generate app",
      "internal app",
      "dedicated app",
      "workflow app",
      "dashboard app",
      "studio app",
      "service-app",
      "creative-studio",
      "scaffold-app",
      "operate-app",
      "앱빌더",
      "앱 빌더",
      "앱 만들어",
      "앱 만들",
      "전용 앱",
      "내장 앱",
      "내부 앱",
      "생성 앱",
      "워크플로우 앱",
      "대시보드 앱",
      "스튜디오 앱",
    ],
    reasonKo: "Agentlas 안에서 열리는 내부 App 생성/설계 요청입니다",
    reasonEn: "the request is to create or design an internal Agentlas App",
  },
  {
    slug: "agentlas-memory-curator",
    terms: ["memory", "remember", "recall", "request_context", "context_json", "메모리", "기억", "회상", "저장"],
    reasonKo: "기억 저장/검색/스코프 품질을 다루는 요청입니다",
    reasonEn: "the request concerns memory storage, recall, or scope quality",
  },
  {
    slug: "agentlas-task-bias",
    terms: ["bias", "sitemap", "evidence", "completion", "coverage", "편향", "사이트맵", "증거", "검증"],
    reasonKo: "작업 편향, 사이트맵, 검증 증거를 다루는 요청입니다",
    reasonEn: "the request concerns task bias, sitemap, or validation evidence",
  },
  {
    slug: "agentlas-pm-soul",
    terms: ["project", "plan", "decision", "handoff", "continuity", "프로젝트", "계획", "결정", "연속성", "핸드오프"],
    reasonKo: "프로젝트 연속성/결정/조율이 중심인 요청입니다",
    reasonEn: "the request is centered on project continuity, decisions, or coordination",
  },
];
function routeNormalize(value) {
  return String(value || "").toLowerCase().replace(/[_/]+/g, "-");
}
function routeTokenize(value) {
  const matches = routeNormalize(value).match(/[a-z0-9][a-z0-9-]{1,}|[가-힣]{2,}/g) || [];
  const expanded = matches.flatMap((term) => term.split("-").filter(Boolean).concat(term));
  return [...new Set(expanded.filter((term) => term.length >= 2 && !ROUTE_STOP_WORDS.has(term)))];
}
function routeHaystack(agent) {
  return routeNormalize([
    agent.slug,
    agent.name,
    agent.name_en,
    agent.tagline,
    agent.tagline_en,
    String(agent.system_prompt || "").slice(0, 3500),
  ].join("\n"));
}
const APP_BUILDER_EXPLICIT_TERMS = [
  "apps generate", "app builder", "make an app", "build an app", "create an app",
  "generate app", "generated app", "internal app", "dedicated app", "workflow app",
  "dashboard app", "studio app", "service-app", "creative-studio", "scaffold-app",
  "operate-app", "앱빌더", "앱 빌더", "앱 만들어", "앱 만들", "전용 앱", "내장 앱",
  "내부 앱", "생성 앱", "워크플로우 앱", "대시보드 앱", "스튜디오 앱",
];
const APP_BUILDER_REPEAT_TERMS = [
  "automation", "automate", "automatic", "recurring", "repeat", "scheduled",
  "scheduler", "every day", "every week", "workflow", "pipeline", "cron",
  "자동화", "자동", "반복", "정기", "매일", "매주", "스케줄", "예약",
  "워크플로우", "파이프라인",
];
const APP_BUILDER_SURFACE_TERMS = [
  "dashboard", "studio", "editor", "settings", "state", "save", "saved",
  "export", "import", "approve", "approval", "review", "queue", "table",
  "filter", "template", "memory", "profile", "대시보드", "스튜디오", "편집",
  "수정", "설정", "상태", "저장", "내보내기", "불러오기", "승인", "검토",
  "큐", "목록", "테이블", "필터", "템플릿", "학습", "메모리", "프로필",
];
const APP_BUILDER_ACTION_TERMS = [
  "build", "create", "generate", "compose", "manage", "track", "research",
  "analyze", "monitor", "render", "convert", "만들", "생성", "작성", "관리",
  "추적", "리서치", "조사", "분석", "모니터", "렌더", "변환",
];
const TRIVIAL_ROUTE_PROMPTS = new Set(["hi", "hello", "hey", "thanks", "thankyou", "안녕", "안녕하세요", "고마워", "감사", "뭐해"]);
function routeIncludesTerm(haystack, term) {
  return haystack.includes(routeNormalize(term));
}
function routeMatchedTerms(promptText, terms) {
  return [...new Set(terms.filter((term) => routeIncludesTerm(promptText, term)))];
}
function isTrivialRoutePrompt(promptText) {
  const compact = String(promptText || "").replace(/\s+/g, " ").trim();
  const stripped = compact.replace(/[.!?~。！？,，ㅋㅎ\s]/g, "");
  if (!stripped) return true;
  if (stripped.length <= 18 && TRIVIAL_ROUTE_PROMPTS.has(stripped)) return true;
  const words = compact.split(/\s+/).filter(Boolean);
  return words.length <= 3 && TRIVIAL_ROUTE_PROMPTS.has(stripped);
}
function isAppBuilderWorthyRoutePrompt(prompt) {
  const promptText = routeNormalize(prompt);
  if (!promptText.trim() || isTrivialRoutePrompt(promptText)) return false;
  const explicit = routeMatchedTerms(promptText, APP_BUILDER_EXPLICIT_TERMS);
  if (explicit.length) return true;
  const repeat = routeMatchedTerms(promptText, APP_BUILDER_REPEAT_TERMS);
  const surface = routeMatchedTerms(promptText, APP_BUILDER_SURFACE_TERMS);
  const action = routeMatchedTerms(promptText, APP_BUILDER_ACTION_TERMS);
  const signalCount = new Set([...repeat, ...surface, ...action]).size;
  if (repeat.length && (surface.length || action.length)) return true;
  if (surface.length >= 2 && action.length) return true;
  return signalCount >= 4;
}
function routeHint(promptText, agent, lang) {
  const hint = ROUTE_HINTS.find((item) => item.slug === agent.slug);
  if (!hint) return { score: 0, terms: [], reason: "" };
  if (hint.slug === "agentlas-app-builder" && !isAppBuilderWorthyRoutePrompt(promptText)) {
    return { score: 0, terms: [], reason: "" };
  }
  const terms = hint.terms.filter((term) => promptText.includes(routeNormalize(term)));
  if (!terms.length) return { score: 0, terms: [], reason: "" };
  return { score: 12 + terms.length * 3, terms, reason: lang === "ko" ? hint.reasonKo : hint.reasonEn };
}
function scoreRouteAgent(prompt, promptTerms, agent, lang) {
  const promptText = routeNormalize(prompt);
  if (agent.slug === "agentlas-app-builder" && !isAppBuilderWorthyRoutePrompt(promptText)) {
    return {
      agent,
      score: 0,
      reason: lang === "ko"
        ? "전용 App을 만들 만큼 반복·상태·편집·자동화가 뚜렷하지 않아 App Builder 라우트를 보류했습니다"
        : "the request does not clearly need a dedicated App with durable workflow, state, editing, or automation",
      terms: [],
    };
  }
  const haystack = routeHaystack(agent);
  let score = 0;
  const terms = [];
  for (const name of [agent.slug, agent.name, agent.name_en].filter(Boolean)) {
    const n = routeNormalize(name);
    if (n && promptText.includes(n)) {
      score += 20;
      terms.push(name);
    }
  }
  for (const term of promptTerms) {
    if (haystack.includes(term)) {
      score += term.length >= 5 ? 3 : 2;
      terms.push(term);
    }
  }
  const hint = routeHint(promptText, agent, lang);
  score += hint.score;
  terms.push(...hint.terms);
  const unique = [...new Set(terms)].slice(0, 6);
  const reason = hint.reason || (lang === "ko"
    ? unique.length
      ? `요청어 ${unique.map((term) => `"${term}"`).join(", ")}가 이 에이전트의 역할/트리거와 가장 가깝습니다`
      : "명확한 전문 라우트가 없어 기본 프로젝트 조율 에이전트가 가장 안전합니다"
    : unique.length
      ? `request terms ${unique.map((term) => `"${term}"`).join(", ")} best match this agent's role/triggers`
      : "no specialist matched clearly, so the default project coordinator is safest");
  return { agent, score, reason, terms: unique };
}
function autoRouteAgent(db, prompt, lang) {
  const agents = listRoutableAgents(db).filter((agent) => agent.slug !== GLOBAL_ORCHESTRATOR_SLUG);
  if (!agents.length) return null;
  const terms = routeTokenize(prompt);
  const ranked = agents.map((agent) => scoreRouteAgent(prompt, terms, agent, lang || prefsLang())).sort((a, b) => b.score - a.score);
  if (ranked[0] && ranked[0].score > 0) return ranked[0];
  const fallback = agents.find((agent) => agent.slug === "agentlas-pm-soul") || agents[0];
  return {
    agent: fallback,
    score: 0,
    reason: (lang || prefsLang()) === "ko"
      ? "명확한 전문 에이전트가 없어 기본 프로젝트 조율 경로를 선택했습니다"
      : "no specialist matched clearly, so Agentlas chose the default coordination route",
    terms: [],
  };
}
function autoRouteNote(choice, lang) {
  const name = (lang || prefsLang()) === "ko" ? choice.agent.name : choice.agent.name_en || choice.agent.name;
  return (lang || prefsLang()) === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.`
    : `Selected agent: ${name}. Reason: ${choice.reason}.`;
}
function autoRoutePreamble(choice, lang) {
  const resolvedLang = lang || prefsLang();
  const appBuilderNeedsConsent = choice.agent && choice.agent.slug === "agentlas-app-builder";
  const instruction = appBuilderNeedsConsent
    ? resolvedLang === "ko"
      ? [
          "이 요청은 Agentlas 안에서 열리는 전용 App으로 만드는 것이 적합할 수 있지만, 사용자가 아직 전용 App 생성을 명시적으로 승인하지 않았습니다.",
          "실제 App 파일 생성, Agentlas Surface Manifest emit, scaffold-app/operate-app 액션 선언을 하지 마세요.",
          "대신 먼저 한 문장으로 확인 질문만 하세요: \"이 요청은 Agentlas 안에서 열리는 전용 App으로 만들면 더 편합니다. 전용 App으로 만들어 진행할까요?\"",
          "사용자가 동의하면 다음 메시지에서 App Builder 작업을 진행하세요.",
        ].join("\n")
      : [
          "This request may be a good fit for a dedicated Agentlas App, but the user has not explicitly approved dedicated App creation yet.",
          "Do not create App files, emit an Agentlas Surface Manifest, or declare scaffold-app/operate-app actions.",
          "Ask one confirmation question first: \"This would work better as a dedicated App inside Agentlas. Should I create that App for you?\"",
          "If the user agrees, proceed with the App Builder flow on the next message.",
        ].join("\n")
    : resolvedLang === "ko"
      ? "사용자는 에이전트를 직접 지정하지 않았습니다. 위 라우팅 결정을 첫 줄에 짧게 밝힌 뒤, 선택된 에이전트로 바로 작업하세요."
      : "The user did not explicitly choose an agent. Briefly state the route above in the first line, then work as the selected agent.";
  return [
    "## Agentlas automatic routing",
    "",
    autoRouteNote(choice, lang),
    instruction,
  ].join("\n");
}
function agentFolder(agent) {
  const routes = routesMap();
  const r = routes[agent.id];
  if (r && r.path) return r.path; // 로컬 임포트는 원본 폴더
  return path.join(userDataDir(), "agents", agent.slug);
}

// ── 로컬 폴더 임포트 (앱의 electron/agents/import-local.ts 와 동일 규칙) ──
// 터미널에서 "폴더 드래그" = `agentlas import <path>`. 앱과 같은 DB/라우트를 공유한다.
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readFileSafe(p, maxChars) {
  try { const s = fs.readFileSync(p, "utf8"); return maxChars ? s.slice(0, maxChars) : s; } catch { return ""; }
}
function readFirst(dir, names, maxChars) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (exists(p) && !isDir(p)) { const s = readFileSafe(p, maxChars || 8000); if (s) return s; }
  }
  return "";
}
function detectRuntimeLabels(dir) {
  const labels = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDir(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDir(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (!labels.length) labels.push("generic");
  return labels;
}
// 팀 감지 — 루트뿐 아니라 .claude/ 중첩 구조도 인식한다 (appbridge 처럼).
function detectKind(dir) {
  const rootMarkers = ["TEAM.md", "ceo", "hr-departments", "projects"];
  for (const m of rootMarkers) if (exists(path.join(dir, m))) return "team";
  const nestedMarkers = [".claude/ceo", ".claude/hr-departments", ".claude/agents", ".claude/orgspec.yaml"];
  for (const m of nestedMarkers) if (exists(path.join(dir, m))) return "team";
  return "agent";
}
function readImportName(dir) {
  const text = readFirst(dir, ["manifest.md", "AGENT.md", "CLAUDE.md", "README.md"], 2000);
  const m = text.match(/^#\s+(.+)$/m);
  if (m) { const n = m[1].replace(/\(.*?\)/g, "").trim().slice(0, 60); if (n) return n; }
  return path.basename(dir);
}
function readImportTagline(dir) {
  const text = readFirst(dir, ["README.md", "soul.md", "AGENT.md"], 2000);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 140);
  }
  // 팀 orgspec mission 첫 줄 fallback
  const org = readFileSafe(path.join(dir, ".claude", "orgspec.yaml"), 4000);
  const mm = org.match(/mission:\s*\|?\s*\n?\s*(.+)/);
  if (mm) return mm[1].trim().slice(0, 140);
  return "";
}
const IMPORT_ENV_RE = /\b[A-Z][A-Z0-9_]{2,}(?:API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SERVICE_ACCOUNT|WEBHOOK_SECRET|CREDENTIALS|KEY)\b/g;
const IMPORT_PROCESS_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})/g;
const IMPORT_DOTENV_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;
const IMPORT_ENV_IGNORES = new Set(["CI", "HOME", "LANG", "NODE_ENV", "PATH", "PORT", "PWD", "SHELL", "TERM", "TMPDIR", "USER"]);
function detectImportEnvRequirements(dir, extraText) {
  const files = [".env", ".env.local", ".env.example", ".env.sample", ".env.template", "env.example", "README.md", "AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "manifest.md", "package.json", ".mcp.json"];
  const found = new Map();
  const add = (key, source, required) => {
    if (!key || IMPORT_ENV_IGNORES.has(key) || key.length < 4 || key.length > 96 || !/^[A-Z][A-Z0-9_]+$/.test(key)) return;
    const entry = found.get(key) || { sources: new Set(), required: false };
    entry.sources.add(source);
    entry.required = entry.required || required;
    found.set(key, entry);
  };
  const collect = (text, source) => {
    if (!text) return;
    for (const m of text.matchAll(IMPORT_DOTENV_LINE_RE)) add(m[1], source, true);
    for (const m of text.matchAll(IMPORT_PROCESS_ENV_RE)) add(m[1], source, true);
    for (const m of text.matchAll(IMPORT_ENV_RE)) add(m[0], source, source.includes(".env"));
  };
  for (const name of files) collect(readFileSafe(path.join(dir, name), 256 * 1024), name);
  collect(extraText || "", "system prompt");
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, info]) => ({
    key,
    label: key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()),
    labelEn: key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()),
    required: info.required,
    hint: "Detected in " + [...info.sources].slice(0, 3).join(", "),
    hintEn: "Detected in " + [...info.sources].slice(0, 3).join(", "),
  }));
}
// 팀이면 CEO 두뇌를 시스템 프롬프트로 잡고, 임의 cwd에서도 동작하도록 절대경로 헤더를 붙인다.
function buildImportSystemPrompt(dir, name, kind) {
  if (kind === "team") {
    const ceoBrain = readFileSafe(path.join(dir, ".claude", "ceo", "AGENT.md"));
    const rootAgents = readFileSafe(path.join(dir, "AGENTS.md"));
    const rootClaude = readFileSafe(path.join(dir, "CLAUDE.md"));
    const nestedClaude = readFileSafe(path.join(dir, ".claude", "CLAUDE.md"));
    let brain = ceoBrain || rootAgents || rootClaude || nestedClaude;
    const claudeRoot = path.join(dir, ".claude");
    const header =
      `You are the CEO / orchestrator of the "${name}" agent team, now launched through Agentlas.\n\n` +
      `TEAM ROOT: ${dir}\n` +
      `Team definition (org spec, playbooks, department & role agents) lives under: ${claudeRoot}\n` +
      `When the instructions below reference team files with relative paths (e.g. ./playbook.md, ../orgspec.yaml, .claude/...), resolve them as ABSOLUTE paths under that team root and read them as needed.\n\n` +
      `TARGET PROJECT: your current working directory is the user's target project. Do ALL building, file creation, and delivery in the current working directory — never inside the team root. Route work to the right department/specialist, sequence multi-step work, keep a brief CEO-style status in Korean, and apply read-only-first safety gates for high-risk actions (billing/auth/security/deploy).\n\n` +
      `--- TEAM BRAIN ---\n`;
    return (header + (brain || `Act as the orchestrating CEO of ${name}.`)).slice(0, 16000);
  }
  const sys = readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  return sys || `You are ${name}, a locally imported agent.`;
}
function importLocalFolderCli(db, absPath) {
  const dir = path.resolve(absPath);
  if (!isDir(dir)) fail(`폴더가 아닙니다: ${absPath}`);
  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  const kind = detectKind(dir);
  const name = readImportName(dir);
  const tagline = readImportTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt = buildImportSystemPrompt(dir, name, kind);
  const envRequirements = detectImportEnvRequirements(dir, systemPrompt);
  const envReqsJson = JSON.stringify(envRequirements);

  // 같은 경로가 이미 임포트돼 있으면 그 에이전트를 갱신(멱등).
  const routes = routesMap();
  let existingId = null;
  for (const [aid, r] of Object.entries(routes)) {
    if (r && path.resolve(r.path || "") === dir) { existingId = aid; break; }
  }
  const now = new Date().toISOString();
  const TONES = ["blue", "green", "purple", "amber", "peach"];
  let id, slug;
  if (existingId) {
    id = existingId;
    const row = db.prepare("SELECT slug FROM installed_agents WHERE id=?").get(id);
    slug = row ? row.slug : null;
    if (slug) {
      if (columnExists(db, "installed_agents", "visibility")) {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, env_requirements_json=?, visibility='visible' WHERE id=?")
          .run(name, name, tagline, tagline, systemPrompt, envReqsJson, id);
      } else {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, env_requirements_json=? WHERE id=?")
          .run(name, name, tagline, tagline, systemPrompt, envReqsJson, id);
      }
    } else { existingId = null; }
  }
  if (!existingId) {
    const base = "local-" + (path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent");
    slug = base; let n = 1;
    while (db.prepare("SELECT 1 FROM installed_agents WHERE slug=?").get(slug)) slug = `${base}-${++n}`;
    id = require("node:crypto").randomUUID();
    let h = 0; for (let i = 0; i < slug.length; i++) h = (h << 5) - h + slug.charCodeAt(i);
    const tone = TONES[Math.abs(h) % TONES.length];
    if (columnExists(db, "installed_agents", "visibility")) {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, visibility) VALUES (?,?,?,?,?,?,?,'[]',?,NULL,'A',?,?,0,'visible')",
      ).run(id, slug, name, name, tagline, tagline, systemPrompt, envReqsJson, now, tone);
    } else {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin) VALUES (?,?,?,?,?,?,?,'[]',?,NULL,'A',?,?,0)",
      ).run(id, slug, name, name, tagline, tagline, systemPrompt, envReqsJson, now, tone);
    }
  }
  // 라우트 저장
  routes[id] = { agentId: id, path: dir, runtime, labels, kind, importedAt: now };
  fs.writeFileSync(path.join(userDataDir(), "agent-routes.json"), JSON.stringify(routes, null, 2), "utf8");

  // 팀이면 회사(firm)로도 등록 → 앱 FIRMS 목록 + `agentlas firm <slug>` 사용 가능. slug 기준 멱등.
  let firm = null;
  if (kind === "team") {
    try { firm = upsertLocalTeamFirmCli(db, dir, id, slug, name, tagline); } catch { /* best-effort */ }
  }
  return { id, slug, name, tagline, runtime, labels, kind, path: dir, updated: !!existingId, firmSlug: firm ? firm.slug : null };
}
// 팀 폴더 → 회사(firm) upsert (앱의 upsertLocalTeamFirm 과 동일). slug 기준 멱등.
function readTeamDepartmentsCli(dir) {
  for (const root of [path.join(dir, "hr-departments"), path.join(dir, ".claude", "hr-departments")]) {
    try {
      if (isDir(root)) {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name).sort();
      }
    } catch { /* continue */ }
  }
  return [];
}
function deptLabelCli(name) {
  return name.replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function upsertLocalTeamFirmCli(db, dir, ceoAgentId, agentSlug, name, tagline) {
  if (!tableExists(db, "firms")) return null;
  const depts = readTeamDepartmentsCli(dir);
  const orgChart = [
    { agentSlug, agentId: ceoAgentId, role: "CEO", reportsTo: null },
    ...depts.map((d) => ({ agentSlug: `${agentSlug}-${d}`, agentId: "", role: deptLabelCli(d), reportsTo: agentSlug })),
  ];
  const firmSlug = `firm-${agentSlug}`;
  const chartJson = JSON.stringify(orgChart);
  const existing = db.prepare("SELECT id FROM firms WHERE slug=?").get(firmSlug);
  if (existing) {
    db.prepare("UPDATE firms SET name=?, name_en=?, tagline=?, tagline_en=?, persona=?, ceo_agent_id=?, org_chart_json=? WHERE id=?")
      .run(name, name, tagline, tagline, "", ceoAgentId, chartJson, existing.id);
    return { id: existing.id, slug: firmSlug };
  }
  const id = require("node:crypto").randomUUID();
  db.prepare(
    "INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, firmSlug, name, name, tagline, tagline, "", ceoAgentId, chartJson, new Date().toISOString());
  return { id, slug: firmSlug };
}
function cmdImport(db, absPath) {
  if (!absPath) fail("사용법: agentlas import <폴더경로>");
  const r = importLocalFolderCli(db, absPath);
  out(`${r.updated ? "갱신" : "임포트"} 완료: ${r.name}  (${r.kind})`);
  out(`  slug:    ${r.slug}`);
  out(`  runtime: ${r.runtime}  [${r.labels.join(", ")}]`);
  out(`  path:    ${r.path}`);
  if (r.firmSlug) out(`  firm:    ${r.firmSlug}  (FIRMS 등록됨 — 앱 사이드바 + 'agentlas firm ${r.firmSlug}')`);
  out("");
  out(`실행: agentlas ${r.slug} "..."   ·   agentlas run ${r.slug} "..."   (대상 프로젝트 폴더에서 실행)`);
}

// ── Agentlas Cloud packaging / marketplace ────────────────────────────────
// Packaging/security review runs locally. Agentlas Cloud gets only package data,
// hashes, and local-review evidence; no platform-owned LLM call is used.
const CLOUD_MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const CLOUD_MAX_FILE_BYTES = 512 * 1024;
const CLOUD_MAX_FILES = 400;
const CLOUD_TEXT_EXTS = new Set([".cjs", ".css", ".csv", ".js", ".json", ".jsonl", ".md", ".mjs", ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const CLOUD_AGENT_FILES = new Set(["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md", "agent.md", "manifest.md", "system-prompt.md"]);
const CLOUD_SKIP_DIRS = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "out", "release"]);
const CLOUD_BLOCKED_FILE_RE = [/^\.env(?:\..*)?$/i, /^id_rsa(?:\.pub)?$/i, /^credentials(?:\..*)?$/i, /^secrets?(?:\..*)?$/i, /(?:^|[._-])service-account(?:[._-]|$)/i, /\.(?:key|pem|p12|pfx|mobileprovision)$/i];
const CLOUD_SECRET_RE = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, "private key material"],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/, "OpenAI-style API key"],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  ["generic-secret", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, "hard-coded credential"],
];

function parseCloudFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

async function cmdCloud(db, args, runtimeOverride) {
  const sub = args[0] || "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    out([
      "agentlas cloud",
      "",
      "  package <path> [--json]             package + static security review",
      "  publish <path> [--dry-run] [--llm-review] [--slug name]",
      "                                      register with submitter-paid local review",
      "  install <slug>                      download/install from Agentlas Cloud marketplace",
      "",
      "Model cost rule: Agentlas Cloud does not run a platform-owned LLM here.",
      "--llm-review uses only this machine's active CLI/BYOK/Ollama runtime.",
    ].join("\n"));
    return;
  }
  if (sub === "install") return cmdCloudInstall(db, args[1]);
  if (sub !== "package" && sub !== "publish") fail("usage: agentlas cloud <package|publish|install> ...");
  const flags = parseCloudFlags(args.slice(1));
  const root = flags._[0];
  if (!root) fail(`usage: agentlas cloud ${sub} <path>`);
  const dryRun = sub === "package" || Boolean(flags["dry-run"]);
  const result = await packageCloudAgentCli(db, root, {
    slug: typeof flags.slug === "string" ? flags.slug : undefined,
    visibility: flags.visibility === "private-link" ? "private-link" : "marketplace",
    llmReview: Boolean(flags["llm-review"]),
    dryRun,
    runtimeOverride,
  });
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  printCloudPackageResult(result);
  if (sub === "publish" && result.status === "blocked") process.exit(1);
}

async function packageCloudAgentCli(db, root, opts) {
  const rootPath = path.resolve(root);
  let st;
  try { st = fs.statSync(rootPath); } catch { fail(`폴더를 찾을 수 없습니다: ${root}`); }
  if (!st.isDirectory()) fail(`폴더가 아닙니다: ${root}`);
  const scan = scanCloudFolderCli(rootPath);
  const name = cloudReadName(rootPath);
  const slug = cloudSlug(opts.slug || name || path.basename(rootPath));
  const packageHash = cloudHashPackage(scan.included);
  const manifest = {
    version: "0.1",
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline: cloudReadTagline(rootPath),
    agentKind: cloudInferKind(rootPath),
    runtimeLabels: detectRuntimeLabels(rootPath),
    visibility: opts.visibility || "marketplace",
    rootFingerprint: sha(rootPath),
    packageHash,
    fileCount: scan.files.length,
    includedFileCount: scan.included.length,
    totalBytes: scan.totalBytes,
    createdAt: new Date().toISOString(),
    billingMode: opts.llmReview ? "submitter-local-runtime" : "static-only",
    costOwner: opts.llmReview ? "submitter" : "none",
    security: cloudSecuritySummary(scan.findings),
  };
  const packageDir = cloudPackageDir(slug);
  fs.mkdirSync(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.manifest.json");
  const bundlePath = path.join(packageDir, "package.bundle.json");
  const bundle = { manifest, files: scan.included, source: { packagedBy: "agentlas-cli", packagedAt: manifest.createdAt, costOwner: manifest.costOwner } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  const review = opts.llmReview
    ? await runCloudLocalReviewCli(db, rootPath, manifest, scan.findings, opts.runtimeOverride)
    : cloudStaticReview(scan.findings);
  const allFindings = [...scan.findings, ...review.findings.filter((f) => !scan.findings.some((s) => s.id === f.id))];
  manifest.security = cloudSecuritySummary(allFindings);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify({ ...bundle, manifest }, null, 2) + "\n", "utf8");
  const blocked = review.verdict === "fail" || allFindings.some((f) => f.severity === "blocker");
  let registration = null;
  let status = blocked ? "blocked" : opts.dryRun ? "dry-run" : "ready";
  if (!blocked && !opts.dryRun) {
    registration = await registerCloudAgentCli(manifest, bundlePath, review, opts.visibility || "marketplace");
    status = "registered";
  }
  return {
    status,
    rootPath,
    packageDir,
    manifestPath,
    bundlePath,
    manifest,
    files: scan.files,
    review,
    registration,
    summary: status === "registered" ? `Registered ${slug}.` : status === "blocked" ? `Blocked: ${review.summary}` : `Ready: ${slug}.`,
  };
}

function scanCloudFolderCli(rootPath) {
  const files = [];
  const included = [];
  const findings = [];
  let totalBytes = 0;
  let count = 0;
  let hasDefinition = false;
  function addFinding(kind, severity, category, message, file, remediation) {
    findings.push({ id: `${kind}-${sha(file || message).slice(0, 10)}`, severity, category, message, ...(file ? { file } : {}), ...(remediation ? { remediation } : {}) });
  }
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootPath, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        addFinding("symlink", "blocker", "policy", "Symbolic links are not allowed in cloud agent packages.", rel, "Replace the symlink with an ordinary file or remove it.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "symlink-blocked" });
        continue;
      }
      if (entry.isDirectory()) {
        if (!CLOUD_SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      count++;
      if (count > CLOUD_MAX_FILES) {
        addFinding("file-count-limit", "blocker", "size", `Package has more than ${CLOUD_MAX_FILES} files.`, "", "Publish a focused agent/team folder.");
        continue;
      }
      if (CLOUD_AGENT_FILES.has(entry.name)) hasDefinition = true;
      const stat = fs.statSync(abs);
      totalBytes += stat.size;
      const digest = sha(fs.readFileSync(abs));
      if (CLOUD_BLOCKED_FILE_RE.some((re) => re.test(entry.name))) {
        addFinding("blocked-file", "blocker", "secret", "Secret-bearing file names are not allowed in cloud packages.", rel, "Remove credentials and publish only env key names.");
        files.push({ path: rel, bytes: stat.size, sha256: digest, kind: "binary", included: false, reason: "secret-file-blocked" });
        continue;
      }
      if (stat.size > CLOUD_MAX_FILE_BYTES) {
        addFinding("large-file", "high", "size", `File exceeds ${CLOUD_MAX_FILE_BYTES} bytes.`, rel, "Move large assets out of the package.");
        files.push({ path: rel, bytes: stat.size, sha256: digest, kind: "binary", included: false, reason: "file-too-large" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isText = CLOUD_TEXT_EXTS.has(ext) || CLOUD_AGENT_FILES.has(entry.name);
      if (!isText) {
        files.push({ path: rel, bytes: stat.size, sha256: digest, kind: "binary", included: false, reason: "binary-skipped" });
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      for (const [id, re, label] of CLOUD_SECRET_RE) {
        if (re.test(text)) addFinding(id, "blocker", "secret", `Possible ${label} found in package content.`, rel, "Remove the value and require users to configure their own key.");
      }
      if (/(?:curl|wget)[^\n|&;]+[|]\s*(?:sh|bash)/i.test(text)) {
        addFinding("curl-pipe-shell", "high", "network", "Remote shell install pattern detected.", rel, "Use explicit, reviewable install steps.");
      }
      files.push({ path: rel, bytes: stat.size, sha256: digest, kind: "text", included: true });
      included.push({ path: rel, bytes: stat.size, sha256: digest, contentBase64: Buffer.from(text, "utf8").toString("base64") });
    }
  }
  walk(rootPath);
  if (!hasDefinition) addFinding("missing-agent-definition", "blocker", "structure", "No agent definition file was found.", "", "Add AGENTS.md, CLAUDE.md, GEMINI.md, AGENT.md, or README.md at the package root.");
  if (totalBytes > CLOUD_MAX_TOTAL_BYTES) addFinding("package-size-limit", "blocker", "size", `Package exceeds ${CLOUD_MAX_TOTAL_BYTES} bytes.`, "", "Publish a smaller agent folder.");
  files.sort((a, b) => a.path.localeCompare(b.path));
  included.sort((a, b) => a.path.localeCompare(b.path));
  return { files, included, findings, totalBytes };
}

function cloudStaticReview(findings) {
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const high = findings.filter((f) => f.severity === "high").length;
  return {
    mode: "static-only",
    verdict: blockers ? "fail" : high ? "needs-review" : "pass",
    costOwner: "none",
    summary: blockers || high ? `${blockers} blocker(s), ${high} high-risk finding(s).` : "Static package review passed.",
    findings,
    reviewedAt: new Date().toISOString(),
  };
}

async function runCloudLocalReviewCli(db, rootPath, manifest, staticFindings, runtimeOverride) {
  let text = "";
  const system = [
    "You are the Agentlas Cloud package security reviewer.",
    "This review runs locally on the submitter machine using the submitter's own CLI/BYOK/local runtime.",
    "Agentlas Cloud and the platform owner must not pay for this model call.",
    "Return strict JSON only: {\"verdict\":\"pass|fail|needs-review\",\"summary\":\"...\",\"findings\":[{\"severity\":\"blocker|high|medium|low|info\",\"category\":\"secret|policy|size|structure|runtime|network|review\",\"message\":\"...\",\"file\":\"optional\",\"remediation\":\"optional\"}]}",
  ].join("\n");
  const prompt = `Review this package manifest and static scan.\n\n${JSON.stringify({ manifest, staticFindings }, null, 2)}`;
  const rt = resolveRuntime(db, runtimeOverride);
  if (rt.mode === "api") {
    text = await runApi(rt.backend, rt.model, system, prompt);
  } else {
    const env = await buildChildEnvCli(db, { cwd: rootPath });
    text = await captureRuntime(rt.kind, system, prompt, { cwd: rootPath, permission: "read", env });
  }
  const parsed = parseCloudReviewJson(text);
  const llmFindings = parsed.findings.map((f, i) => ({
    id: f.id || `local-runtime-review-${i + 1}`,
    severity: normalizeCloudSeverity(f.severity),
    category: normalizeCloudCategory(f.category),
    message: String(f.message || "Reviewer finding"),
    ...(typeof f.file === "string" ? { file: f.file } : {}),
    ...(typeof f.remediation === "string" ? { remediation: f.remediation } : {}),
  }));
  const findings = [...staticFindings, ...llmFindings];
  return {
    mode: "local-runtime",
    verdict: parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "needs-review"
      ? parsed.verdict
      : findings.some((f) => f.severity === "blocker") ? "fail" : "needs-review",
    costOwner: "submitter",
    runtimeLabel: rt.mode === "api" ? `${rt.backend}${rt.model ? " · " + rt.model : ""}` : rt.kind,
    summary: parsed.summary || "Local runtime review completed.",
    findings,
    reviewedAt: new Date().toISOString(),
    rawText: String(text || "").slice(0, 4000),
  };
}

async function registerCloudAgentCli(manifest, bundlePath, review, visibility) {
  const cookie = await cloudSessionCookieCli();
  if (!cookie) fail("agentlas.cloud 로그인이 필요합니다. 데스크톱 앱에서 로그인하거나 AGENTLAS_SESSION을 설정하세요.");
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const resp = await fetch(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ manifest, bundle, review, visibility, billing: { modelCallsPaidBy: review.costOwner, localRuntime: review.runtimeLabel || null } }),
  });
  if (!resp.ok) fail(`Agentlas Cloud 등록 실패 ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  const json = await resp.json();
  return {
    cloudId: json.cloudId || crypto.randomUUID(),
    slug: json.slug || manifest.slug,
    url: json.url,
    marketplaceUrl: json.marketplaceUrl,
    registeredAt: json.registeredAt || new Date().toISOString(),
    dryRun: false,
  };
}

async function cloudSessionCookieCli() {
  if (process.env.AGENTLAS_SESSION) return `agentlas_session=${process.env.AGENTLAS_SESSION}`;
  const keytar = readKeytar();
  if (!keytar) return null;
  try {
    const value = await keytar.getPassword("Agentlas Session", "default");
    return value ? `agentlas_session=${value}` : null;
  } catch {
    return null;
  }
}

async function cmdCloudInstall(db, slug) {
  if (!slug) fail("usage: agentlas cloud install <slug>");
  const listing = await fetchCloudManifestCli(slug);
  if (!listing) fail(`cloud agent를 찾을 수 없습니다: ${slug}`);
  const agent = persistCloudListingCli(db, listing);
  out(`✓ installed ${agent.slug} — ${agent.name}`);
  if (agent.localPath) out(`  files: ${agent.localPath}`);
}

async function fetchCloudManifestCli(slug) {
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
  const headers = { "content-type": "application/json" };
  const cookie = await cloudSessionCookieCli();
  if (cookie) headers.cookie = cookie;
  const resp = await fetch(`${base.replace(/\/$/, "")}/tools/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "marketplace.get_manifest", params: { name: "marketplace.get_manifest", arguments: { kind: "agent", slug } } }),
  });
  if (!resp.ok) fail(`marketplace.get_manifest 실패 ${resp.status}`);
  const json = await resp.json();
  if (json.error) fail(`marketplace.get_manifest: ${json.error.message || "unknown error"}`);
  return json.result || null;
}

function persistCloudListingCli(db, listing) {
  const slug = cloudSlug(listing.slug || listing.name || "cloud-agent");
  const existing = db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(slug);
  const now = new Date().toISOString();
  const envReqs = JSON.stringify(listing.envRequirements || []);
  const mcpServers = JSON.stringify(listing.mcpServers || []);
  if (existing) {
    db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, mcp_servers_json=?, env_requirements_json=?, trust_grade=?, visibility=? WHERE slug=?")
      .run(listing.name || slug, listing.nameEn || listing.name || slug, listing.tagline || "", listing.taglineEn || listing.tagline || "", listing.systemPrompt || "", mcpServers, envReqs, listing.trustGrade || "unknown", listing.visibility || "visible", slug);
    const localPath = materializeCloudListingCli(existing.id, slug, listing);
    return { ...existing, slug, name: listing.name || slug, ...(localPath ? { localPath } : {}) };
  }
  const id = crypto.randomUUID();
  const hasVisibility = columnExists(db, "installed_agents", "visibility");
  if (hasVisibility) {
    db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)")
      .run(id, slug, listing.name || slug, listing.nameEn || listing.name || slug, listing.tagline || "", listing.taglineEn || listing.tagline || "", listing.systemPrompt || "", mcpServers, envReqs, listing.trustGrade || "unknown", now, listing.tone || "blue", listing.visibility || "visible");
  } else {
    db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)")
      .run(id, slug, listing.name || slug, listing.nameEn || listing.name || slug, listing.tagline || "", listing.taglineEn || listing.tagline || "", listing.systemPrompt || "", mcpServers, envReqs, listing.trustGrade || "unknown", now, listing.tone || "blue");
  }
  const localPath = materializeCloudListingCli(id, slug, listing);
  return { id, slug, name: listing.name || slug, ...(localPath ? { localPath } : {}) };
}

function materializeCloudListingCli(agentId, slug, listing) {
  const pkg = listing.cloudPackage;
  if (!pkg || !Array.isArray(pkg.files) || pkg.files.length === 0) return null;
  const dir = path.join(userDataDir(), "cloud-agent-installs", slug);
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, ".agentlas-cloud-package.json");
  let currentHash = null;
  try {
    currentHash = JSON.parse(fs.readFileSync(markerPath, "utf8")).packageHash || null;
  } catch {}
  const overwrite = currentHash !== pkg.packageHash;
  for (const file of pkg.files) {
    const target = resolveCloudInstallPathCli(dir, file.path);
    const bytes = Buffer.from(String(file.contentBase64 || ""), "base64");
    if (bytes.length !== Number(file.bytes) || sha(bytes) !== String(file.sha256 || "").toLowerCase()) {
      fail(`cloud package file integrity failed: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (overwrite || !fs.existsSync(target)) fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ agentId, packageHash: pkg.packageHash, installedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  return dir;
}

function resolveCloudInstallPathCli(root, relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    fail(`unsafe cloud package path: ${relPath}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    fail(`unsafe cloud package path: ${relPath}`);
  }
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`cloud package path escapes install folder: ${relPath}`);
  }
  return target;
}

function printCloudPackageResult(result) {
  out(`${result.status === "blocked" ? "✖" : "✓"} ${result.summary}`);
  out(`  slug:    ${result.manifest.slug}`);
  out(`  files:   ${result.manifest.includedFileCount}/${result.manifest.fileCount}`);
  out(`  hash:    ${result.manifest.packageHash}`);
  out(`  bundle:  ${result.bundlePath}`);
  out(`  review:  ${result.review.mode} · cost=${result.review.costOwner}${result.review.runtimeLabel ? " · " + result.review.runtimeLabel : ""}`);
  const findings = result.review.findings || [];
  if (findings.length) {
    out("  findings:");
    for (const f of findings.slice(0, 20)) out(`    - ${f.severity} ${f.file ? f.file + ": " : ""}${f.message}`);
  }
  if (result.registration) out(`  cloud:   ${result.registration.marketplaceUrl || result.registration.url || result.registration.cloudId}`);
}

function cloudReadName(rootPath) {
  const text = cloudReadFirst(rootPath, ["agent.md", "AGENT.md", "README.md", "CLAUDE.md", "AGENTS.md"], 2000);
  const heading = text.match(/^#\s+(.+)$/m);
  return (heading ? heading[1] : path.basename(rootPath)).replace(/\s+/g, " ").trim().slice(0, 80);
}
function cloudReadTagline(rootPath) {
  const text = cloudReadFirst(rootPath, ["README.md", "agent.md", "AGENT.md"], 3000);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 160);
  }
  return "Portable Agentlas cloud agent package.";
}
function cloudReadFirst(rootPath, names, maxChars) {
  for (const name of names) {
    const file = path.join(rootPath, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= CLOUD_MAX_FILE_BYTES) return fs.readFileSync(file, "utf8").slice(0, maxChars);
    } catch { /* continue */ }
  }
  return "";
}
function cloudInferKind(rootPath) {
  for (const name of ["TEAM.md", "team.json", "agents", "team", "departments", "hr-departments"]) {
    if (fs.existsSync(path.join(rootPath, name))) return "team";
  }
  return "agent";
}
function cloudPackageDir(slug) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(userDataDir(), "cloud-agent-packages", `${slug}-${stamp}`);
}
function cloudHashPackage(files) {
  const h = crypto.createHash("sha256");
  for (const file of files) {
    h.update(file.path);
    h.update("\0");
    h.update(file.sha256);
    h.update("\0");
  }
  return h.digest("hex");
}
function cloudSecuritySummary(findings) {
  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  return { verdict: blockerCount ? "fail" : highCount ? "needs-review" : "pass", blockerCount, highCount, findingCount: findings.length };
}
function parseCloudReviewJson(text) {
  const candidate = String(text || "").match(/\{[\s\S]*\}/);
  if (!candidate) return { verdict: "needs-review", summary: "Local runtime returned non-JSON review output.", findings: [{ severity: "medium", category: "review", message: "Review output could not be parsed as strict JSON." }] };
  try {
    const parsed = JSON.parse(candidate[0]);
    return { verdict: parsed.verdict, summary: parsed.summary, findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
  } catch {
    return { verdict: "needs-review", summary: "Local runtime returned invalid JSON.", findings: [{ severity: "medium", category: "review", message: "Review output could not be parsed as strict JSON." }] };
  }
}
function normalizeCloudSeverity(value) {
  return ["blocker", "high", "medium", "low", "info"].includes(value) ? value : "medium";
}
function normalizeCloudCategory(value) {
  return ["secret", "policy", "size", "structure", "runtime", "network", "review"].includes(value) ? value : "review";
}
function cloudSlug(value) {
  return (String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agentlas-cloud-agent");
}
function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ── Agentlas 아키텍처 (앱과 동일한 빌트인 에이전트 + 메모리) ────────────
// cli/architecture.data.json은 컴파일된 manifest에서 생성됨(scripts/gen-cli-architecture.mjs).
let _arch = null;
function loadArch() {
  if (_arch) return _arch;
  try {
    _arch = require("./architecture.data.json");
  } catch {
    _arch = { version: "0", agents: [], emitterBlock: "", eventsHeading: "## Memory Events", memoryDir: ".agentlas", soulFile: "project-soul-memory.md", sitemapFile: "sitemap.json", logFile: "memory-log.jsonl", kinds: [], scopes: [] };
  }
  return _arch;
}
function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}
function columnExists(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
}
function ensureMemoryContextColumn(db) {
  try {
    if (tableExists(db, "memory_entries") && !columnExists(db, "memory_entries", "context_json")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  } catch { /* ignore */ }
}
// 앱의 seedBuiltinAgents와 동일한 멱등·버전 게이팅 로직(CJS 버전). 스키마가 아직 v12가 아니면
// (= 앱이 마이그레이션 전) 건너뜀 — 앱을 한 번 켜면 마이그레이션+시드가 수행된다.
function seedBuiltins(db) {
  const arch = loadArch();
  if (!arch.agents || !arch.agents.length) return;
  if (!tableExists(db, "meta") || !columnExists(db, "installed_agents", "builtin")) return;
  let installedVersion = null;
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key='architecture_version'").get();
    installedVersion = r ? r.value : null;
  } catch { return; }
  if (installedVersion === arch.version) {
    try {
      const have = db.prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE builtin=1").get();
      if (have.n >= arch.agents.length) return;
    } catch { /* fallthrough */ }
  }
  const now = new Date().toISOString();
  try {
    const tx = db.transaction(() => {
      const hasVisibility = columnExists(db, "installed_agents", "visibility");
      for (const def of arch.agents) {
        const visibility = def.visibility || "background";
        const existing = db.prepare("SELECT id FROM installed_agents WHERE id=? OR slug=?").get(def.id, def.slug);
        if (existing) {
          if (hasVisibility) {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A', visibility=? WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, visibility, existing.id);
          } else {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A' WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, existing.id);
          }
        } else {
          if (hasVisibility) {
            db.prepare(
              "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?,?)",
            ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role, visibility);
          } else {
            db.prepare(
              "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?)",
            ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role);
          }
        }
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('architecture_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(arch.version);
    });
    tx();
  } catch { /* best-effort */ }
}

const SECRET_RE = [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i];

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    const soul = path.join(dir, arch.soulFile);
    if (!fs.existsSync(soul)) {
      fs.writeFileSync(soul, `# Project Soul Memory: ${name}\n\nDurable memory for this project folder, maintained by Agentlas.\n\n## Project Purpose\n\n## Current State\n\n## Decisions\n\n## Risks\n\n## Auto-curated memory\n`, "utf8");
    }
    const sitemap = path.join(dir, arch.sitemapFile);
    if (!fs.existsSync(sitemap)) {
      const now = new Date().toISOString();
      fs.writeFileSync(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2), "utf8");
    }
    const skillRegistryFile = arch.skillRegistryFile || "skill-registry.json";
    const skillTrialsFile = arch.skillTrialsFile || "skill-trials.jsonl";
    const curatorDecisionsFile = arch.curatorDecisionsFile || "curator-decisions.jsonl";
    const skillRegistry = path.join(dir, skillRegistryFile);
    if (!fs.existsSync(skillRegistry)) {
      fs.writeFileSync(skillRegistry, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-skill-lifecycle-registry",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        defaultTier: "candidate",
        runtimeFirstClassRecallEnabled: false,
        predicatesRequired: true,
        curatorQuarantineRequired: true,
        evidenceLedgers: {
          trials: `.agentlas/${skillTrialsFile}`,
          curatorDecisions: `.agentlas/${curatorDecisionsFile}`,
          memoryEvents: `.agentlas/${arch.logFile}`,
        },
        hardStops: [
          "permission_change",
          "credential_change",
          "payment_or_billing_effect",
          "regulated_or_irreversible_side_effect",
          "same_authority_patch_and_validator",
          "holdout_contamination",
          "missing_rollback_snapshot",
        ],
        effectiveErrorBudgetTerms: [
          "first_class_error_mass",
          "quarantine_false_accept_estimate",
          "blind_spot_estimate",
          "drift_estimate",
        ],
        niches: [],
        skills: [],
        rolloutPolicy: {
          staticOnlyCanApprove: false,
          sandboxRequired: true,
          holdoutRequired: true,
          shadowRequiredForFastPathChanges: true,
          lowRiskCanaryOnly: true,
          severeFailureTolerance: 0,
        },
      }, null, 2), "utf8");
    }
    for (const fileName of [skillTrialsFile, curatorDecisionsFile]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    return dir;
  } catch { return null; }
}
function logCli(projectPath, rec) {
  if (!projectPath) return;
  try {
    const dir = ensureProjectMemoryCli(projectPath);
    if (!dir) return;
    fs.appendFileSync(path.join(dir, loadArch().logFile), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* ignore */ }
}
function coerceText(v, max) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}
function coerceNullableText(v, max) {
  if (v === null) return null;
  return coerceText(v, max);
}
function normalizeRequestContext(ev, ctx, projectPath) {
  const raw = ev && ev.request_context && typeof ev.request_context === "object" ? ev.request_context : {};
  const triggerTerms = Array.isArray(raw.trigger_terms)
    ? [...new Set(raw.trigger_terms.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))]
        .slice(0, 12)
        .map((x) => x.slice(0, 40))
    : undefined;
  const cwd = coerceNullableText(raw.cwd_at_request, 500) ?? ctx.cwdAtRequest ?? ctx.cwd ?? ctx.projectPath ?? null;
  const targetProject = coerceNullableText(raw.target_project, 120) ?? ctx.projectId ?? null;
  const targetPath = coerceNullableText(raw.target_path, 500) ?? projectPath ?? null;
  const out = {};
  const userIntent = coerceText(raw.user_intent, 240);
  const outcome = coerceNullableText(raw.outcome, 240);
  if (userIntent) out.user_intent = userIntent;
  if (triggerTerms && triggerTerms.length) out.trigger_terms = triggerTerms;
  if (cwd !== undefined) out.cwd_at_request = cwd;
  if (targetProject !== undefined) out.target_project = targetProject;
  if (targetPath !== undefined) out.target_path = targetPath;
  out.cross_context = typeof raw.cross_context === "boolean" ? raw.cross_context : !!(cwd && targetPath && cwd !== targetPath);
  if (outcome !== undefined) out.outcome = outcome;
  if (SECRET_RE.some((re) => re.test(JSON.stringify(out)))) return {};
  return Object.keys(out).length ? out : {};
}
function contextLine(json) {
  try {
    const ctx = JSON.parse(json || "{}");
    const parts = [
      ctx.user_intent || ctx.userIntent,
      (ctx.target_project || ctx.targetProject) ? `target:${ctx.target_project || ctx.targetProject}` : null,
      Array.isArray(ctx.trigger_terms || ctx.triggerTerms) && (ctx.trigger_terms || ctx.triggerTerms).length
        ? `terms:${(ctx.trigger_terms || ctx.triggerTerms).join(",")}`
        : null,
    ].filter(Boolean);
    return parts.length ? ` (context: ${parts.join("; ").slice(0, 180)})` : "";
  } catch {
    return "";
  }
}
// 작업 폴더 반복 방문 → 활성화(.agentlas 생성). 앱의 activation.ts와 동일한 정책(2회).
function recordCliFolderVisit(db, projectPath) {
  if (!tableExists(db, "folder_activity")) return { activated: false };
  const now = new Date().toISOString();
  try {
    const row = db.prepare("SELECT visits, activated_at FROM folder_activity WHERE path=?").get(projectPath);
    let visits, activatedAt;
    if (row) {
      visits = row.visits + 1; activatedAt = row.activated_at;
      db.prepare("UPDATE folder_activity SET visits=?, last_seen=? WHERE path=?").run(visits, now, projectPath);
    } else {
      visits = 1; activatedAt = null;
      db.prepare("INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?,?,NULL,?,?)").run(projectPath, visits, now, now);
    }
    if (!activatedAt && visits >= 2) {
      db.prepare("UPDATE folder_activity SET activated_at=? WHERE path=?").run(now, projectPath);
      ensureProjectMemoryCli(projectPath);
      activatedAt = now;
    }
    return { activated: !!activatedAt };
  } catch { return { activated: false }; }
}
// `agentlas run` 등이 호출된 작업 디렉터리 → 활성 프로젝트 경로(또는 null).
function activeProjectPath(db) {
  try {
    const cwd = process.cwd();
    if (cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return null;
    const v = recordCliFolderVisit(db, cwd);
    return v.activated ? cwd : null;
  } catch { return null; }
}
function cliMemoryContext(db, projectPath) {
  const sections = [];
  const arch = loadArch();
  ensureMemoryContextColumn(db);
  if (projectPath) {
    try {
      const soulPath = path.join(projectPath, arch.memoryDir, arch.soulFile);
      if (fs.existsSync(soulPath)) {
        let s = fs.readFileSync(soulPath, "utf8");
        if (s.length > 1800) s = s.slice(0, 1800) + "\n…(truncated)";
        if (s.trim()) sections.push(`### Project memory (${projectPath})\n${s.trim()}`);
      }
    } catch { /* ignore */ }
  }
  if (tableExists(db, "memory_entries")) {
    try {
      const rows = projectPath
        ? db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE superseded_at IS NULL AND scope!='session' AND (project_path=? OR (project_path IS NULL AND scope IN ('user_identity','team_memory','agent_team'))) ORDER BY created_at DESC LIMIT 12").all(projectPath)
        : db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE project_path IS NULL AND scope!='session' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 12").all();
      if (rows.length) sections.push((projectPath ? "### Recent curated memory\n" : "### Curated memory (global)\n") + rows.map((r) => `- [${r.kind}] ${r.content}${contextLine(r.context_json)}`).join("\n"));
    } catch { /* ignore */ }
  }
  if (!sections.length) return "";
  return "## Agentlas memory (read before answering; five-scope + request_context recall)\n\n" + sections.join("\n\n");
}
function parseMemoryEventsCli(text) {
  const heading = loadArch().eventsHeading;
  const idx = text.lastIndexOf(heading);
  if (idx < 0) return { events: [], cleaned: text.trim() };
  const after = text.slice(idx + heading.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events = [];
  if (fence) { try { const d = JSON.parse(fence[1].trim()); if (Array.isArray(d)) events = d; } catch { /* ignore */ } }
  let cut = text.length;
  if (fence && fence.index != null) cut = idx + heading.length + fence.index + fence[0].length;
  else cut = idx;
  return { events, cleaned: (text.slice(0, idx) + text.slice(cut)).trim() };
}
function curateCliReply(db, text, ctx) {
  const { events, cleaned } = parseMemoryEventsCli(text);
  if (!events.length || !tableExists(db, "memory_entries")) return cleaned;
  ensureMemoryContextColumn(db);
  const arch = loadArch();
  const { randomUUID } = require("node:crypto");
  const now = new Date().toISOString();
  for (const ev of events) {
    const content = ev && typeof ev.content === "string" ? ev.content.trim() : "";
    if (!content) continue;
    if (ev.sensitivity === "secret" || SECRET_RE.some((re) => re.test(content))) continue;
    const kind = arch.kinds.includes(ev.memory_kind) ? ev.memory_kind : "fact";
    let scope = ev.suggested_scope === "agent_team"
      ? "team_memory"
      : arch.scopes.includes(ev.suggested_scope) ? ev.suggested_scope : "session";
    const kindAllowsUserIdentity = ["fact", "decision", "preference", "procedure"].includes(kind);
    if (scope === "user_identity" && (ev.confidence !== "high" || !kindAllowsUserIdentity)) scope = "session";
    if (scope === "discard" || scope === "session") { logCli(ctx.projectPath, { action: scope, kind, content, at: now }); continue; }
    if (scope === "project" && !ctx.projectPath) scope = "team_memory";
    const ppath = scope === "project" ? ctx.projectPath : null;
    const requestContext = normalizeRequestContext(ev, ctx, ppath);
    try {
      const dup = db.prepare("SELECT 1 FROM memory_entries WHERE scope=? AND kind=? AND lower(trim(content))=? AND superseded_at IS NULL AND (project_path IS ? OR project_path=?) LIMIT 1").get(scope, kind, content.toLowerCase(), ppath, ppath);
      if (dup) continue;
      db.prepare("INSERT INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,context_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(), scope, kind, content, ctx.projectId || null, ppath, ctx.agentId || null, null, ev.confidence || "medium", ev.sensitivity || "internal", JSON.stringify(Array.isArray(ev.evidence_refs) ? ev.evidence_refs : []), JSON.stringify(requestContext), now);
      logCli(ctx.projectPath, { action: "written", scope, kind, content, request_context: requestContext, at: now });
    } catch { /* ignore */ }
  }
  return cleaned;
}
// 선택된 인터페이스 언어를 권위적으로 못박는 지시. 입력 언어 미러링을 막아
// "영어로 설정했는데 한글이 나오는" 문제를 차단한다 (desktop status-i18n.sysGuide와 동일 원칙).
function langDirective(lang) {
  return lang === "ko"
    ? "사용자의 인터페이스 언어는 한국어입니다. 사용자가 어떤 언어로 입력하든 항상 한국어로 답변하세요. 사용자가 이번 메시지에서 다른 언어로 답하라고 명시적으로 요청할 때만 그 언어를 쓰세요."
    : "The user's interface language is English. Always reply in English, regardless of the language the user writes in. Only use another language if the user explicitly asks you to in this message.";
}

function prefsLang() {
  try {
    return require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en";
  } catch {
    return "en";
  }
}

function augmentSystem(db, baseSystem, ctx, withEmitter) {
  const arch = loadArch();
  let sys = baseSystem || "";
  // 언어 지시를 맨 앞에 — 하위 CLI(claude/codex/gemini)의 입력-언어 미러링보다 우선하도록.
  const lang = (ctx && ctx.lang) || prefsLang();
  sys = langDirective(lang) + (sys ? "\n\n" + sys : "");
  const connectionSkill = loadGlobalConnectionSkill();
  if (connectionSkill) sys += "\n\n" + connectionSkill;
  const mem = cliMemoryContext(db, ctx && ctx.projectPath);
  if (mem) sys += "\n\n" + mem;
  if (withEmitter && arch.emitterBlock) sys += "\n\n" + arch.emitterBlock;
  return sys;
}

function loadGlobalConnectionSkill() {
  try {
    return require("../dist/electron/runtime/global-skill.js").GLOBAL_CONNECTION_SKILL || "";
  } catch {
    return [
      "## Connecting accounts for the user (always-on background skill)",
      "When the task needs Slack, Gmail, Google Cloud, Firebase, a database, or another third-party service, open the provider website with the browser tool when available, guide the user one tiny step at a time, and save the issued credential with `agentlas creds save --provider <name> --key <ENV_NAME> --value \"<value>\" --project \"<cwd>\"`.",
      "Do not lecture the user about security in this local single-user setup; make the connection effortless.",
    ].join("\n\n");
  }
}

// ── 런타임 CLI 스폰 ────────────────────────────────────────
const RUNTIME_BIN = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

// 활성 런타임 → 실행 방식 결정. CLI(claude/codex/gemini) 또는 API(BYOK/Ollama).
function resolveRuntime(db, override) {
  if (override) {
    if (!RUNTIME_BIN[override]) fail(`알 수 없는 런타임: ${override} (claude-code|codex|gemini)`);
    return { mode: "cli", kind: override };
  }
  const ar = activeRuntime(db);
  if (ar && RUNTIME_BIN[ar.kind]) return { mode: "cli", kind: ar.kind };
  if (ar && ar.kind === "byok" && ar.backend) return { mode: "api", backend: ar.backend, model: ar.model };
  if (ar && ar.kind === "ollama") return { mode: "api", backend: "ollama", model: ar.model };
  // 폴백: 설치된 CLI 탐지
  for (const kind of Object.keys(RUNTIME_BIN)) {
    if (which(RUNTIME_BIN[kind])) return { mode: "cli", kind };
  }
  fail("사용할 런타임이 없습니다. CLI(claude/codex/gemini)를 설치하거나 앱에서 API 키/Ollama를 설정하세요.");
}

// ── API 러너 (BYOK / Ollama) — 비스트리밍, 최종 텍스트 반환 ──
const DEFAULT_API_MODEL = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.1",
  upstage: "solar-pro2",
};
async function apiKey(backend) {
  const keytar = readKeytar();
  if (!keytar) return null;
  return keytar.getPassword(SERVICE, "byok:" + backend);
}
async function runApi(backend, model, system, prompt) {
  model = model || DEFAULT_API_MODEL[backend];
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  if (backend === "ollama") {
    const resp = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`Ollama ${resp.status} — 'ollama serve' 실행/모델 확인`);
    const j = await resp.json();
    return (j.message && j.message.content) || "";
  }
  const key = await apiKey(backend);
  if (!key) fail(`${backend} API 키가 없습니다. 앱 설정 → BYOK에서 키를 등록하세요.`);
  if (backend === "anthropic") {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`Anthropic ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.content && j.content[0] && j.content[0].text) || "";
  }
  if (backend === "openai" || backend === "upstage") {
    const base = backend === "upstage" ? "https://api.upstage.ai/v1" : "https://api.openai.com/v1";
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`OpenAI ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  if (backend === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) fail(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    const c = j.candidates && j.candidates[0];
    return (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || "";
  }
  fail("지원하지 않는 backend: " + backend);
}

// 1회 실행 — CLI면 spawn(스트리밍 stdout), API면 호출 후 텍스트 출력. 종료코드 반환.
// ctx = { projectPath, agentId } — 메모리 주입/큐레이션에 사용.
async function executeOnce(db, system, prompt, override, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = projectCwd();
  const rt = resolveRuntime(db, override);
  if (rt.mode === "cli") {
    // 네이티브 CLI는 자체 세션을 가지므로 emitter는 넣지 않고(노이즈 방지) 메모리 컨텍스트만 주입.
    const sys = augmentSystem(db, system, ctx, false);
    const cwd = ctx.projectPath || projectCwd();
    const permission = ctx.permission || "write";
    const env = await buildChildEnvCli(db, { ...ctx, cwd });
    process.stderr.write(`▸ ${rt.kind} · ${permission} · ${cwd}\n`);
    return spawnRuntime(rt.kind, sys, prompt, { cwd, permission, env });
  }
  // API 경로 — emitter 동봉 → 답변에서 메모리 이벤트를 파싱·큐레이션하고 블록은 제거.
  const sys = augmentSystem(db, system, ctx, true);
  const env = await buildChildEnvCli(db, { ...ctx, cwd: ctx.cwd || projectCwd() });
  Object.assign(process.env, env);
  process.stderr.write(`▸ ${rt.backend}${rt.model ? " · " + rt.model : ""}\n`);
  const text = await runApi(rt.backend, rt.model, sys, prompt);
  const cleaned = curateCliReply(db, text || "", ctx);
  process.stdout.write((cleaned || "").trim() + "\n");
  return 0;
}

// API 백엔드용 간이 대화형 REPL (네이티브 인터랙티브가 없는 BYOK/Ollama).
// 매 턴 메모리 컨텍스트 + emitter를 주입하고 답변에서 메모리를 큐레이션한다.
function apiRepl(db, backend, model, system, label, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = ctx.cwd || projectCwd();
  const readline = require("node:readline");
  process.stderr.write(`▸ ${label} (${backend}${model ? " · " + model : ""}) — 종료: /exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = () =>
    rl.question("\nyou › ", async (line) => {
      const tt = (line || "").trim();
      if (tt === "/exit" || tt === "/quit") return rl.close();
      if (!tt) return ask();
      try {
        const sys = augmentSystem(db, system, ctx, true);
        const text = await runApi(backend, model, sys, tt);
        const cleaned = curateCliReply(db, text || "", ctx);
        process.stdout.write("\n" + (cleaned || "").trim() + "\n");
      } catch (e) {
        process.stderr.write("✖ " + (e && e.message) + "\n");
      }
      ask();
    });
  ask();
}

function which(cmd) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const extra = [
    path.join(os.homedir(), ".claude/local"),
    path.join(os.homedir(), ".codex/bin"),
    path.join(os.homedir(), ".gemini/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of [...paths, ...extra]) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function runCwd() {
  const dir = path.join(userDataDir(), "agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

function cliMcpConfigPath() {
  const dir = path.join(userDataDir(), "mcp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "agentlas-cli-mcp.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
    }, null, 2),
    "utf8",
  );
  return file;
}

const CODEX_PLAYWRIGHT_MCP_ARGS = [
  "-c", 'mcp_servers.playwright.command="npx"',
  "-c", 'mcp_servers.playwright.args=["-y","@playwright/mcp@latest"]',
];

// 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리(= 대상 프로젝트).
// 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 안전한 전용 폴더로 폴백한다.
function projectCwd() {
  try {
    const cwd = process.cwd();
    if (!cwd || cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return runCwd();
    return cwd;
  } catch {
    return runCwd();
  }
}

function parseDotEnvCli(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function readDotEnvFileCli(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return {};
    return parseDotEnvCli(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function readDotEnvDirCli(dir) {
  return { ...readDotEnvFileCli(path.join(dir, ".env")), ...readDotEnvFileCli(path.join(dir, ".env.local")) };
}
function agentEnvRequirementsCli(db, agentId) {
  if (!agentId) return [];
  try {
    const row = db.prepare("SELECT env_requirements_json FROM installed_agents WHERE id=?").get(agentId);
    const parsed = JSON.parse((row && row.env_requirements_json) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function agentEnvDirCli(agentId) {
  if (!agentId) return null;
  const route = routesMap()[agentId];
  if (route && route.path) return route.path;
  return null;
}
function readVaultEnvValuesCli(keys) {
  const keytar = readKeytar();
  const result = {};
  if (!keytar || !keys.length) return Promise.resolve(result);
  return Promise.all(
    keys.map((key) =>
      keytar
        .getPassword(SERVICE, ENV_PREFIX + key)
        .then((value) => {
          if (value) result[key] = value;
        })
        .catch(() => {}),
    ),
  ).then(() => result);
}
async function buildChildEnvCli(db, ctx) {
  const env = { ...process.env };
  const apply = (values, overwrite) => {
    for (const [key, value] of Object.entries(values || {})) {
      if (!value) continue;
      if (!overwrite && env[key]) continue;
      env[key] = value;
    }
  };
  apply(readDotEnvFileCli(path.join(userDataDir(), "credentials.env")), false);
  apply(readDotEnvFileCli(path.join(os.homedir(), ".agentlas", "credentials.env")), false);
  if (ctx && ctx.cwd) apply(readDotEnvDirCli(ctx.cwd), true);
  if (ctx && ctx.projectPath) apply(readDotEnvDirCli(ctx.projectPath), true);
  const agentDir = agentEnvDirCli(ctx && ctx.agentId);
  if (agentDir) apply(readDotEnvDirCli(agentDir), true);

  const mm = loadMultimodalCatalog();
  const settings = getMultimodalSettingsCli(db);
  const keys = new Set(mm.selectedMultimodalEnvKeys(settings));
  for (const req of agentEnvRequirementsCli(db, ctx && ctx.agentId)) {
    if (req && req.key) keys.add(req.key);
  }
  const vaultValues = await readVaultEnvValuesCli([...keys].filter((key) => !env[key]));
  apply(vaultValues, false);
  env.AGENTLAS_MULTIMODAL_IMAGE_PROVIDER = settings.imageProvider;
  env.AGENTLAS_MULTIMODAL_VIDEO_PROVIDER = settings.videoProvider;
  env.AGENTLAS_MULTIMODAL_AUDIO_PROVIDER = settings.audioProvider;
  return env;
}

// 권한 → 네이티브 CLI 권한 모드 매핑 (앱의 claude-code.ts 와 동일 의미).
//   read=기본(헤드리스에서 위험 툴 자동 거부) · write=편집 허용 · full=셸 포함 전체 자동.
function buildArgs(kind, systemPrompt, prompt, permission) {
  if (kind === "claude-code") {
    const perm =
      permission === "full"
        ? ["--permission-mode", "bypassPermissions"]
        : permission === "write"
          ? ["--permission-mode", "acceptEdits"]
          : [];
    const mcp = permission === "write" || permission === "full"
      ? ["--mcp-config", cliMcpConfigPath(), "--allowedTools", "mcp__playwright"]
      : [];
    return ["-p", prompt, "--append-system-prompt", systemPrompt, ...perm, ...mcp];
  }
  if (kind === "codex") {
    // codex exec: browser/account setup flows must not stall on approval prompts.
    const perm =
      permission === "full" || permission === "write"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", "read-only", "--ask-for-approval", "never"];
    const mcp = permission === "write" || permission === "full" ? CODEX_PLAYWRIGHT_MCP_ARGS : [];
    return ["exec", "--skip-git-repo-check", ...perm, ...mcp, `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  }
  if (kind === "gemini") {
    const perm = permission === "full" || permission === "write" ? ["--yolo"] : [];
    return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`, ...perm];
  }
  return [prompt];
}

// `claude` 치면 바로 대화형 세션 뜨듯이 — 에이전트 폴더(CLAUDE.md/AGENTS.md/GEMINI.md 보유)에서
// 네이티브 CLI를 인자 없이(대화형) 실행. 에이전트 페르소나는 그 폴더의 프로젝트 지시로 자동 로드. (A+B 결합)
// 보스턴테리어 터미널(대화형 TUI)로 진입. agentlas 가 항상 "호스트"다 —
// 활성 런타임이 claude/codex/gemini면 native-host로 headless 구동해 이 TUI 안에서 렌더하고,
// BYOK/Ollama면 자체 에이전트 루프(api-agent)를 돌린다. (apiRepl/네이티브 인계는 대체됨)
function launchInteractive(db, agent, runtimeOverride) {
  const subject = {
    kind: "agent",
    id: agent.id,
    slug: agent.slug,
    label: agent.name,
    system: agent.system_prompt || `You are ${agent.name}.`,
    capAgent: agent,
  };
  return launchTui(db, subject, runtimeOverride);
}

// REPL이 필요로 하는 DB 헬퍼들을 한 객체로 노출 (중복 구현 방지).
function buildHelpers(db) {
  return {
    which,
    RUNTIME_BIN,
    augmentSystem: (db_, base, ctx, emit) => augmentSystem(db_, base, ctx, emit),
    curateCliReply: (db_, text, ctx) => curateCliReply(db_, text, ctx),
    apiKey: (backend) => apiKey(backend),
    eventsHeading: () => loadArch().eventsHeading,
    defaultApiModel: (backend) => DEFAULT_API_MODEL[backend],
    buildChildEnv: (db_, ctx) => buildChildEnvCli(db_, ctx),
    multimodalStatus: (db_) => multimodalStatusCli(db_),
    setMultimodal: (db_, modality, providerId) => setMultimodalCli(db_, modality, providerId),
    resolveAgent,
    resolveFirm,
    listAgents,
    listFirms,
    firmSystemPrompt,
    autoRouteAgent: (db_, prompt, lang) => autoRouteAgent(db_, prompt, lang),
    autoRouteNote: (choice, lang) => autoRouteNote(choice, lang),
    autoRoutePreamble: (choice, lang) => autoRoutePreamble(choice, lang),
    cliMemoryContext: (db_, pp) => cliMemoryContext(db_, pp),
    importLocal: (db_, p) => importLocalFolderCli(db_, p),
    // /cwd 로 작업 폴더를 바꿀 때 그 폴더의 활성 프로젝트 경로(또는 null)를 재계산 — activeProjectPath의 명시-dir 버전.
    projectPathFor: (db_, dir) => {
      try {
        if (!dir || dir === os.homedir() || dir === userDataDir() || dir === runCwd()) return null;
        const v = recordCliFolderVisit(db_, dir);
        return v.activated ? dir : null;
      } catch {
        return null;
      }
    },
    doctor: (db_, ui) => {
      ui.line("");
      ui.info("userData: " + userDataDir());
      ui.info("db: " + (fs.existsSync(dbPath()) ? "OK" : "없음"));
      const ar = activeRuntime(db_);
      ui.info("활성 런타임: " + (ar ? ar.kind : "(없음)"));
      for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
        const p = which(bin);
        ui.info(`  ${kind.padEnd(12)} ${p ? "설치됨" : "미설치"}`);
      }
    },
  };
}

function launchTui(db, subject, runtimeOverride) {
  let startRepl, config;
  try {
    ({ startRepl } = require("./agentlas-repl.cjs"));
    config = require("./agentlas-config.cjs");
  } catch (e) {
    fail("Failed to load the terminal UI module: " + (e && e.message));
  }
  const dir = userDataDir();
  const prefs = config.loadPrefs(dir);
  // Runtime: explicit --runtime wins; else a saved default (cli kind, installed); else app's active runtime.
  let override = runtimeOverride;
  if (!override && prefs.runtime && prefs.runtime !== "auto" && RUNTIME_BIN[prefs.runtime] && which(RUNTIME_BIN[prefs.runtime])) {
    override = prefs.runtime;
  }
  const runtime = resolveRuntime(db, override);
  // Permission: explicit --permission wins; else the saved default; else "write".
  const permission = PERMISSION_EXPLICIT ? PERMISSION : prefs.permission || PERMISSION;
  startRepl({
    db,
    subject,
    runtime,
    permission,
    cwd: projectCwd(),
    projectPath: activeProjectPath(db),
    helpers: buildHelpers(db),
    prefs,
    savePrefs: (p) => config.savePrefs(dir, p),
  });
}

function spawnRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  return new Promise((resolve) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    const child = spawn(bin, buildArgs(kind, systemPrompt, prompt, opts.permission), {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: opts.env || process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(`\n실행 실패(${kind}): ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function captureRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  return new Promise((resolve, reject) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    const child = spawn(bin, buildArgs(kind, systemPrompt, prompt, opts.permission), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(`${kind} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout.trim() || stderr.trim());
    });
  });
}

// ── 명령 구현 ──────────────────────────────────────────────
function cmdList(db) {
  const agents = listAgents(db);
  const ar = activeRuntime(db);
  let lang = "en";
  try { lang = require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en"; } catch { /* default en */ }
  const nm = (a) => (lang === "en" && a.name_en && a.name_en !== a.name ? a.name_en : a.name);
  out(`Active runtime: ${ar ? `${ar.kind}${ar.backend ? " · " + ar.backend : ""}${ar.model ? " · " + ar.model : ""}` : "(none)"}`);
  out(`${agents.length} agent(s) installed:`);
  const routes = routesMap();
  for (const a of agents) {
    const local = routes[a.id] ? "  [local]" : "";
    const arch = a.builtin ? "  [architecture]" : "";
    out(`  ${a.slug.padEnd(28)} ${nm(a)}${arch}${local}`);
  }
  const firms = listFirms(db);
  if (firms.length) {
    out(`\n${firms.length} company(ies):`);
    for (const f of firms) out(`  ${f.slug.padEnd(28)} ${nm(f)}  (CEO)`);
  }
  out("\nRun: agentlas <agent>  ·  agentlas firm <firm>  ·  agentlas run <agent> \"...\"");
}

function ensureNativeFiles(agent, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const sys = agent.system_prompt || `You are ${agent.name}.`;
  writeIfMissing(path.join(folder, "system-prompt.md"), sys);
  const header = `# ${agent.name}\n\n${agent.tagline || ""}\n\n${sys}\n`;
  // 네이티브 CLI가 프로젝트 지시로 자동 인식하는 파일들
  writeIfMissing(path.join(folder, "CLAUDE.md"), header);
  writeIfMissing(path.join(folder, "AGENTS.md"), header);
  writeIfMissing(path.join(folder, "GEMINI.md"), header);
}
function writeIfMissing(file, content) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function cmdCd(db, query) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  const folder = agentFolder(agent);
  ensureNativeFiles(agent, folder);
  // 경로만 stdout으로 (cd "$(agentlas cd seo)") — 안내는 stderr로.
  process.stderr.write(`# ${agent.name} — 네이티브 CLI 컨텍스트(CLAUDE.md/AGENTS.md/GEMINI.md) 준비됨\n`);
  process.stdout.write(folder + "\n");
}

async function cmdRun(db, query, prompt, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) {
    const routedPrompt = [query, prompt].filter(Boolean).join(" ").trim() || (await readStdin());
    if (!routedPrompt || !routedPrompt.trim()) fail("프롬프트가 비어 있습니다. agentlas run <agent> \"...\" 또는 agentlas run \"...\" 형식으로 입력하세요.");
    return cmdAutoRun(db, routedPrompt.trim(), runtimeOverride);
  }
  let userPrompt = prompt;
  if (!userPrompt) userPrompt = await readStdin();
  if (!userPrompt || !userPrompt.trim()) fail("프롬프트가 비어 있습니다. agentlas run <agent> \"...\" 또는 stdin으로 전달하세요.");
  process.stderr.write(`▸ ${agent.name}\n`);
  const code = await executeOnce(db, agent.system_prompt || "", userPrompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: agent.id, permission: PERMISSION });
  process.exit(code);
}

async function cmdAutoRun(db, prompt, runtimeOverride) {
  const lang = prefsLang();
  const choice = autoRouteAgent(db, prompt, lang);
  if (!choice) fail("자동 라우팅할 에이전트가 없습니다. agentlas list로 설치 상태를 확인하세요.");
  process.stderr.write(`▸ ${choice.agent.name} (auto)\n`);
  process.stderr.write(`  ${autoRouteNote(choice, lang)}\n`);
  const sys = `${autoRoutePreamble(choice, lang)}\n\n${choice.agent.system_prompt || ""}`;
  const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, {
    projectPath: activeProjectPath(db),
    agentId: choice.agent.id,
    permission: PERMISSION,
  });
  process.exit(code);
}

// chat / open / 에이전트명 단독 → 네이티브 CLI 대화형 세션 (claude처럼 바로 접속)
function cmdOpen(db, query, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  launchInteractive(db, agent, runtimeOverride);
}

// ── 회사(firm) — CEO 위임 실행 ─────────────────────────────
function listFirms(db) {
  try {
    return db.prepare("SELECT * FROM firms ORDER BY installed_at DESC").all();
  } catch {
    return [];
  }
}
function resolveFirm(db, query) {
  if (!String(query || "").trim()) return null;
  const firms = listFirms(db);
  const q = (query || "").toLowerCase();
  return (
    firms.find((f) => f.slug === query || f.id === query) ||
    firms.find((f) => (f.name || "").toLowerCase() === q) ||
    firms.find((f) => (f.slug || "").toLowerCase().includes(q) || (f.name || "").toLowerCase().includes(q)) ||
    null
  );
}
function firmSystemPrompt(db, firm) {
  const ceo = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(firm.ceo_agent_id);
  let roster = "";
  try {
    const org = JSON.parse(firm.org_chart_json);
    roster = org
      .map((n) => `  - ${n.role}: ${n.agentSlug}${n.reportsTo ? ` (reports to ${n.reportsTo})` : ""}`)
      .join("\n");
  } catch {
    /* ignore */
  }
  const base = (ceo && ceo.system_prompt) || `You are the CEO of ${firm.name}.`;
  return `${base}\n\n[FIRM] 당신은 '${firm.name}' 회사의 CEO입니다. 사용자 명령을 부서에 위임해 처리하세요.\n조직도:\n${roster}`;
}
async function cmdFirm(db, query, prompt, runtimeOverride) {
  const firm = resolveFirm(db, query);
  if (!firm) fail(`회사를 찾을 수 없습니다: ${query}`);
  const sys = firmSystemPrompt(db, firm);
  if (prompt && prompt.trim()) {
    process.stderr.write(`▸ ${firm.name} CEO\n`);
    const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: firm.ceo_agent_id, permission: PERMISSION });
    process.exit(code);
  }
  // 대화형 — agentlas TUI. CEO 페르소나를 system으로, 작업은 현재 폴더에서.
  const subject = {
    kind: "firm",
    id: firm.ceo_agent_id,
    slug: firm.slug,
    label: firm.name + " CEO",
    system: sys,
    capAgent: { name: firm.name, name_en: firm.name_en || firm.name, tagline: firm.tagline, system_prompt: sys },
  };
  return launchTui(db, subject, runtimeOverride);
}

// ── creds: 발급된 외부 키를 vault + 프로젝트 .env + 전역 메모리에 저장 ──────────
// 백그라운드 연결 스킬(global-skill.ts)이 브라우저로 키 발급을 마친 뒤 이 명령을 호출한다.
// 로컬·단일 사용자 환경 — 평문 저장을 의도적으로 허용(사용 편의 우선).
function parseCredFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        f[a.slice(2)] = next;
        i++;
      } else {
        f[a.slice(2)] = true;
      }
    }
  }
  return f;
}
function upsertEnvLine(file, key, value) {
  let body = "";
  try { body = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const line = `${key}=${value}`;
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
  if (re.test(body)) body = body.replace(re, line);
  else body = body ? body.replace(/\n?$/, "\n") + line + "\n" : line + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}
async function cmdCreds(db, args) {
  const sub = args[0];
  if (sub !== "save") {
    fail('usage: agentlas creds save --provider <name> --key <ENV_NAME> --value <value> [--project <path>]');
  }
  const f = parseCredFlags(args.slice(1));
  const key = typeof f.key === "string" ? f.key.trim() : "";
  const value = f.value === undefined || f.value === true ? "" : String(f.value);
  if (!key || !value) fail("creds save requires --key and --value");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : key;
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(db);
  const targets = [];

  // 1) keychain vault — MCP 실행 시 자식 env로 자동 주입되는 정본 저장소
  const keytar = readKeytar();
  if (keytar) {
    try { await keytar.setPassword(SERVICE, ENV_PREFIX + key, value); targets.push("vault"); }
    catch (e) { process.stderr.write("vault save failed: " + e.message + "\n"); }
  }
  // 2) 프로젝트 .env (평문)
  if (project) {
    try { upsertEnvLine(path.join(project, ".env"), key, value); targets.push("project .env"); }
    catch (e) { process.stderr.write(".env write failed: " + e.message + "\n"); }
    // 3) 프로젝트 메모리 노트 (.agentlas/project-soul-memory.md) — 값 자체는 .env/vault에, 여기엔 사실만
    try {
      const soulDir = path.join(project, ".agentlas");
      fs.mkdirSync(soulDir, { recursive: true });
      fs.appendFileSync(
        path.join(soulDir, "project-soul-memory.md"),
        `\n- Connected ${provider}: ${key} saved (vault + .env) during first setup.\n`,
        "utf8",
      );
    } catch { /* best-effort */ }
  }
  // 4) 전역 메모리 (평문) — 프로젝트와 무관하게 재사용
  try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), key, value); targets.push("global memory"); } catch { /* best-effort */ }
  try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), key, value); } catch { /* best-effort */ }

  out(`✓ connected ${provider} — saved ${key} to ${targets.join(", ") || "(nowhere — check keytar)"}.`);
}

function cmdEnv(db) {
  const keytar = readKeytar();
  if (!keytar) fail("keytar 모듈을 불러올 수 없습니다(앱 런타임으로 실행 필요).");
  keytar
    .findCredentials(SERVICE)
    .then((creds) => {
      const keys = creds.map((c) => c.account).filter((a) => a.startsWith(ENV_PREFIX)).map((a) => a.slice(ENV_PREFIX.length));
      out(`공유 env 키 ${keys.length}개 (값은 표시 안 함):`);
      for (const k of keys.sort()) out(`  ${k}`);
    })
    .catch((e) => fail("env 조회 실패: " + e.message));
}

async function multimodalStatusCli(db) {
  const mm = loadMultimodalCatalog();
  const settings = getMultimodalSettingsCli(db);
  const ids = { image: settings.imageProvider, video: settings.videoProvider, audio: settings.audioProvider };
  const keytar = readKeytar();
  const rows = [];
  for (const modality of ["image", "video", "audio"]) {
    const provider = mm.MULTIMODAL_PROVIDERS.find((p) => p.id === ids[modality]);
    if (!provider) continue;
    const env = [];
    for (const key of provider.envKeys || []) {
      let hasValue = Boolean(process.env[key]);
      if (!hasValue && keytar) {
        try { hasValue = Boolean(await keytar.getPassword(SERVICE, ENV_PREFIX + key)); } catch { hasValue = false; }
      }
      env.push({ key, hasValue });
    }
    rows.push({ modality, provider, env, ready: env.every((e) => e.hasValue) });
  }
  return rows;
}
function setMultimodalCli(db, modality, providerId) {
  const mm = loadMultimodalCatalog();
  if (!["image", "video", "audio"].includes(modality)) fail("usage: agentlas multimodal set <image|video|audio> <provider-id>");
  const provider = mm.MULTIMODAL_PROVIDERS.find((p) => p.id === providerId && p.modality === modality);
  if (!provider) fail(`provider를 찾을 수 없습니다: ${providerId} (${modality})`);
  const key = modality === "image" ? "imageProvider" : modality === "video" ? "videoProvider" : "audioProvider";
  return saveMultimodalSettingsCli(db, { [key]: providerId });
}
async function cmdMultimodal(db, args) {
  const sub = args[0] || "status";
  const mm = loadMultimodalCatalog();
  if (sub === "set") {
    const settings = setMultimodalCli(db, args[1], args[2]);
    out(`✓ multimodal ${args[1]} provider → ${args[2]}`);
    out(`  image=${settings.imageProvider}  video=${settings.videoProvider}  audio=${settings.audioProvider}`);
    return;
  }
  if (sub === "providers") {
    for (const modality of ["image", "video", "audio"]) {
      out(`${modality}:`);
      for (const p of mm.MULTIMODAL_PROVIDERS.filter((x) => x.modality === modality)) {
        out(`  ${p.id.padEnd(22)} ${p.label}${p.envKeys && p.envKeys.length ? "  env: " + p.envKeys.join(",") : "  env: none"}`);
      }
    }
    out("\nSet: agentlas multimodal set <image|video|audio> <provider-id>");
    return;
  }
  const rows = await multimodalStatusCli(db);
  out("Multimodal fallback:");
  for (const row of rows) {
    const env = row.env.length ? row.env.map((e) => `${e.key}:${e.hasValue ? "set" : "missing"}`).join(" ") : "no key";
    out(`  ${row.modality.padEnd(5)} ${row.provider.id.padEnd(20)} ${row.provider.label}  ${env}`);
  }
  out("\nCommands: agentlas multimodal providers  ·  agentlas multimodal set image openai-image");
}

function cmdDoctor(db) {
  out(`userData: ${userDataDir()}`);
  out(`db: ${fs.existsSync(dbPath()) ? "OK" : "없음"}`);
  const ar = activeRuntime(db);
  out(`활성 런타임: ${ar ? ar.kind : "(없음)"}`);
  for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
    const p = which(bin);
    out(`  ${kind.padEnd(12)} ${p ? "설치됨: " + p : "미설치(PATH에 없음)"}`);
  }
}

function cmdHelp() {
  out(
    [
      "agentlas — the Boston Terrier terminal",
      "",
      "  agentlas              open the terminal (mascot splash, then pick an agent)",
      "  agentlas \"prompt\"     auto-route to the best agent, then run once",
      "  agentlas <agent>      jump straight into a chat with one agent",
      "  open <agent>          same as above (explicit)",
      "  firm <firm> [cmd]     delegate to a company's CEO (interactive if no cmd)",
      "  run [agent] [prompt]  one-shot — omit agent to auto-route (reads stdin if no prompt)",
      "  import <path>         import a local folder (agent or team)",
      "  cd <agent>            print the agent folder — cd \"$(agentlas cd seo)\" && claude",
      "  list                  agents/companies + active runtime",
      "  env                   shared env key names",
      "  multimodal            image/video/audio fallback providers",
      "  cloud package <path>  package + static security review for Agentlas Cloud",
      "  cloud publish <path>  register after local review (submitter runtime only)",
      "  cloud install <slug>  download/install a cloud marketplace agent",
      "  creds save ...        save an issued key (vault + project .env + global memory)",
      "  doctor                check runtimes and data",
      "  setup                 re-run first-launch setup (language · runtime · permission)",
      "",
      "Options: --runtime claude-code|codex|gemini  ·  --permission read|write|full (default write)",
    ].join("\n"),
  );
}

// ── 유틸 ──────────────────────────────────────────────────
function out(s) {
  process.stdout.write(s + "\n");
}
function fail(msg) {
  process.stderr.write("✖ " + msg + "\n");
  process.exit(1);
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

// ── 엔트리 ─────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  let runtimeOverride = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runtime") {
      runtimeOverride = argv[++i];
    } else if (argv[i] === "--permission" || argv[i] === "-P") {
      const p = (argv[++i] || "").toLowerCase();
      if (!["read", "write", "full"].includes(p)) fail(`알 수 없는 권한: ${p} (read|write|full)`);
      PERMISSION = p;
      PERMISSION_EXPLICIT = true;
    } else {
      rest.push(argv[i]);
    }
  }
  const cmd = rest[0] || "";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cmdHelp();

  const db = openDb();

  // Agentlas 아키텍처 빌트인 에이전트를 보장(앱과 동일, 멱등·버전 게이팅). 스키마가 준비됐을 때만.
  try { seedBuiltins(db); } catch { /* best-effort */ }

  // 인자 없이 `agentlas` → 에이전트 1개면 바로 대화형, 아니면 목록 + 사용법
  if (cmd === "") {
    const agents = listAgents(db);
    if (agents.length === 1) return launchInteractive(db, agents[0], runtimeOverride);
    return launchTui(db, null, runtimeOverride); // splash + interactive agent picker
  }

  switch (cmd) {
    case "list":
      return cmdList(db);
    case "import":
      return cmdImport(db, rest[1]);
    case "cd":
      return cmdCd(db, rest[1]);
    case "run":
      return cmdRun(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "chat":
    case "open":
      return cmdOpen(db, rest[1], runtimeOverride);
    case "firm":
      return cmdFirm(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "env":
      return cmdEnv(db);
    case "multimodal":
      return cmdMultimodal(db, rest.slice(1));
    case "cloud":
      return cmdCloud(db, rest.slice(1), runtimeOverride);
    case "creds":
      return cmdCreds(db, rest.slice(1));
    case "doctor":
      return cmdDoctor(db);
    case "setup": {
      // re-run the first-launch onboarding wizard (language → runtime → permission)
      const cfg = require("./agentlas-config.cjs");
      const dir = userDataDir();
      const p = cfg.loadPrefs(dir);
      delete p.onboarded;
      cfg.savePrefs(dir, p);
      return launchTui(db, null, runtimeOverride);
    }
    default: {
      // 알려진 명령이 아니면 에이전트명 → (없으면) 회사명 → 대화형 세션
      const agent = resolveAgent(db, cmd);
      if (agent) return launchInteractive(db, agent, runtimeOverride);
      const firm = resolveFirm(db, cmd);
      if (firm) return cmdFirm(db, cmd, "", runtimeOverride);
      const prompt = rest.join(" ").trim();
      if (prompt) return cmdAutoRun(db, prompt, runtimeOverride);
      fail(`에이전트/회사를 찾을 수 없습니다: ${cmd}  (agentlas list 로 확인)`);
    }
  }
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
