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
 *   agentlas ontology              현재 프로젝트 온톨로지 inbox/source 상태
 *   agentlas update                최신 Desktop 공개 릴리즈 확인/설치
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

function readPackageVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
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
    fail(`Agentlas data was not found: ${p}\nOpen Agentlas Desktop once to install agents, then run this command again.`);
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
// 메타-빌더(에이전트/팀/회사 생성) — 약한 키워드 점수 경쟁에서 빼고, 명시적 build 의도일 때만 직행 라우팅.
const META_BUILDER_SLUGS = ["agentlas-core-engine-meta-agent-builtin", "agentlas-meta-agent"];
const NON_GENERIC_ROUTE_SLUGS = new Set([GLOBAL_ORCHESTRATOR_SLUG, ...META_BUILDER_SLUGS]);
const AGENT_BUILD_TERMS = [
  "build an agent", "build a team", "build me an agent", "build me a team", "make an agent",
  "make a team", "create an agent", "create a team", "agent team", "agent for me",
  "scaffold a team", "scaffold an agent", "build a company", "create a company",
  "new agent team", "set up an agent", "set up a team", "spin up an agent",
  "에이전트팀", "에이전트 팀", "에이전트 만들", "에이전트를 만들", "에이전트 좀 만들",
  "에이전트 생성", "에이전트 구축", "팀 만들", "팀을 만들", "팀 생성", "회사 만들",
  "회사를 만들", "에이전트 하나 만들",
];
// 한국어 조사("하나만","좀","를")가 끼면 고정 구문 매칭이 깨지므로, 엔티티+동사 근접 규칙을 보강한다.
const BUILD_ENTITY_RE = /(에이전트|agent|팀|team|회사|company)/i;
const BUILD_VERB_RE = /(만들|만든|생성|구축|구성해|꾸려|세팅|패키징|scaffold|build|create|\bmake\b|set\s?up|spin\s?up)/i;
function isAgentBuildIntent(prompt) {
  const p = routeNormalize(prompt);
  if (!p.trim() || isTrivialRoutePrompt(p)) return false;
  if (AGENT_BUILD_TERMS.some((term) => p.includes(routeNormalize(term)))) return true;
  // 예: "단일 에이전트 하나만 만들어줘", "팀 좀 꾸려줘", "make me an agent"
  return BUILD_ENTITY_RE.test(p) && BUILD_VERB_RE.test(p);
}
function resolveMetaBuilder(db) {
  try {
    const rows = db
      .prepare("SELECT * FROM installed_agents WHERE slug IN ('agentlas-core-engine-meta-agent-builtin','agentlas-meta-agent')")
      .all();
    for (const slug of META_BUILDER_SLUGS) {
      const a = rows.find((r) => r.slug === slug);
      if (a) return a;
    }
  } catch {
    /* ignore */
  }
  return null;
}
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
    // 4자 미만 일반 단어("team","agent" 등)가 프롬프트에 우연히 들어가 +20을 독식하지 않도록 가드.
    if (n && n.length >= 4 && promptText.includes(n)) {
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
  const resolvedLang = lang || prefsLang();
  // 명확한 "에이전트/팀/회사 만들기" 의도 → 메타-빌더로 직행 (약한 키워드 점수에 밀리지 않게).
  if (isAgentBuildIntent(prompt)) {
    const meta = resolveMetaBuilder(db);
    if (meta) {
      return {
        agent: meta,
        score: 1000,
        reason:
          resolvedLang === "ko"
            ? "새 에이전트/팀/회사를 만드는 요청이라 메타에이전트(빌더)로 라우팅했습니다"
            : "the request is to build a new agent/team/company, so it routes to the meta-agent (builder)",
        terms: [],
      };
    }
  }
  const agents = listRoutableAgents(db).filter((agent) => !NON_GENERIC_ROUTE_SLUGS.has(agent.slug));
  if (!agents.length) return null;
  const terms = routeTokenize(prompt);
  const ranked = agents.map((agent) => scoreRouteAgent(prompt, terms, agent, resolvedLang)).sort((a, b) => b.score - a.score);
  if (ranked[0] && ranked[0].score > 0) return ranked[0];
  const fallback = agents.find((agent) => agent.slug === "agentlas-pm-soul") || agents[0];
  return {
    agent: fallback,
    score: 0,
    reason: resolvedLang === "ko"
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
const CLOUD_TEXT_EXTS = new Set([".cjs", ".css", ".csv", ".html", ".js", ".json", ".jsonl", ".md", ".mjs", ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const CLOUD_AGENT_FILES = new Set(["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md", "agent.md", "manifest.md", "system-prompt.md"]);
const CLOUD_SKIP_DIRS = new Set([".git", ".next", ".studio-runtime", ".turbo", "build", "coverage", "dist", "node_modules", "out", "release"]);
const CLOUD_BLOCKED_FILE_RE = [/^\.env(?:\..*)?$/i, /^id_rsa(?:\.pub)?$/i, /^credentials(?:\..*)?$/i, /^secrets?(?:\..*)?$/i, /(?:^|[._-])service-account(?:[._-]|$)/i, /\.(?:key|pem|p12|pfx|mobileprovision)$/i];
const CLOUD_ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const CLOUD_ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const CLOUD_ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);
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
      "  wizard <path> [--name name] [--json] generate/repair agentlas.json",
      "  security scan <path> [--strict]     scan risky instructions and secret paths",
      "  runtime bundle <path> [--json]      compile runtime bundle from agentlas.json",
      "  runtime read-agent-file <path> <file>",
      "                                      lazy read with allow/deny gates",
      "  field-test [--json]                 run local Cloud contract field test",
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
  const cloudRuntime = require("./agentlas-cloud-runtime.cjs");
  if (sub === "wizard") {
    const flags = parseCloudFlags(args.slice(1));
    const root = flags._[0];
    if (!root) fail("usage: agentlas cloud wizard <path> [--name name]");
    const result = cloudRuntime.runWizard(root, { name: typeof flags.name === "string" ? flags.name : undefined });
    out(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.manifest.name} (${result.manifest.entry})`);
    return;
  }
  if (sub === "security") {
    const action = args[1];
    if (action !== "scan") fail("usage: agentlas cloud security scan <path> [--strict]");
    const flags = parseCloudFlags(args.slice(2));
    const root = flags._[0];
    if (!root) fail("usage: agentlas cloud security scan <path> [--strict]");
    const report = cloudRuntime.scanFolder(root);
    out(JSON.stringify(report, null, 2));
    if (flags.strict && report.verdict === "BLOCK") process.exit(1);
    return;
  }
  if (sub === "runtime") {
    const action = args[1];
    if (action === "bundle") {
      const root = args[2];
      if (!root) fail("usage: agentlas cloud runtime bundle <path>");
      out(JSON.stringify(cloudRuntime.compileBundle(root), null, 2));
      return;
    }
    if (action === "read-agent-file") {
      const root = args[2];
      const targetPath = args[3];
      if (!root || !targetPath) fail("usage: agentlas cloud runtime read-agent-file <path> <file>");
      out(JSON.stringify(cloudRuntime.readAgentFile(root, targetPath), null, 2));
      return;
    }
    fail("usage: agentlas cloud runtime <bundle|read-agent-file> ...");
  }
  if (sub === "field-test") {
    const flags = parseCloudFlags(args.slice(1));
    const result = cloudRuntime.runFieldTest();
    out(flags.json ? JSON.stringify(result, null, 2) : `${result.suite}: ${result.status}`);
    if (result.status !== "PASS") process.exit(1);
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
  const routingCard = readCloudRoutingCardCli(rootPath);
  if (routingCard.finding) scan.findings.push(routingCard.finding);
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
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    createdAt: new Date().toISOString(),
    billingMode: opts.llmReview ? "submitter-local-runtime" : "static-only",
    costOwner: opts.llmReview ? "submitter" : "none",
    security: cloudSecuritySummary(scan.findings),
  };
  if (routingCard.card) manifest.routingCard = routingCard.card;
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

function readCloudRoutingCardCli(rootPath) {
  const abs = path.join(rootPath, CLOUD_ROUTING_CARD_PATH);
  if (!fs.existsSync(abs)) {
    return {
      finding: {
        id: "routing-card-required",
        severity: "blocker",
        category: "structure",
        file: CLOUD_ROUTING_CARD_PATH,
        message: "Cloud registration requires a Hephaestus Network routing card.",
        remediation: "Add .agentlas/routing-card.json before publishing. In Hephaestus packages, run the routing-card migration or package verifier.",
      },
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cloudRoutingCardFinding("routing-card-invalid", "Routing card must be a JSON object.", "Replace .agentlas/routing-card.json with a routing-card/2.0 object.");
    }
    const problem = cloudRoutingCardProblem(parsed);
    if (problem) {
      return cloudRoutingCardFinding("routing-card-invalid", `Routing card is invalid: ${problem}`, "Fix .agentlas/routing-card.json before publishing.");
    }
    return { card: parsed };
  } catch {
    return cloudRoutingCardFinding("routing-card-invalid-json", "Routing card is not valid JSON.", "Fix .agentlas/routing-card.json before publishing.");
  }
}

function cloudRoutingCardFinding(id, message, remediation) {
  return {
    finding: {
      id,
      severity: "blocker",
      category: "structure",
      file: CLOUD_ROUTING_CARD_PATH,
      message,
      remediation,
    },
  };
}

function cloudRoutingCardProblem(card) {
  if (card.schemaVersion !== "routing-card/2.0") return "schemaVersion must be routing-card/2.0";
  if (typeof card.id !== "string" || !card.id.trim()) return "id must be a non-empty string";
  if (card.type !== "agent" && card.type !== "team" && card.type !== "plugin") return "type must be agent, team, or plugin";
  if (typeof card.name !== "string" || !card.name.trim()) return "name must be a non-empty string";
  if (typeof card.summary !== "string" || !card.summary.trim()) return "summary must be a non-empty string";
  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) return "capabilities must be a non-empty array";
  for (const capability of card.capabilities) {
    if (typeof capability !== "string" || !CLOUD_ROUTING_CARD_CAPABILITY_RE.test(capability)) {
      return `capability ${JSON.stringify(capability)} must be snake_case with at least two words`;
    }
  }
  if (typeof card.routing_status !== "string" || !CLOUD_ROUTING_CARD_STATUSES.has(card.routing_status)) {
    return "routing_status must be draft, searchable, candidate, routing_ready, or trusted";
  }
  return null;
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
    headers: { "content-type": "application/json", cookie, origin: base },
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
  // 서버(register/route.ts hashPackage)와 바이트 동일해야 한다: 경로 코드포인트 순 정렬.
  // 정렬 없이 스캔 순서로 해시하면 대소문자 혼합 경로 패키지(AGENTS.md + agents/…)가
  // 전부 package_hash_mismatch로 거절된다(2026-07-02 근본 수정).
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
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

function localCredentialConfigCli(arch) {
  return {
    mapFile: arch.localCredentialsMapFile || "local-credentials.map.json",
    envExampleFile: arch.projectEnvExampleFile || ".env.example",
    signingDir: arch.projectSigningDir || "signing",
    credentialsDir: arch.projectCredentialsDir || "credentials",
    readmeFile: arch.projectCredentialsReadmeFile || "README.md",
  };
}
function projectEnvIdCli(projectPath) {
  const raw = path.basename(projectPath || runCwd() || "project") || "project";
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROJECT";
}
function projectScopedGlobalEnvKeyCli(projectPath, key) {
  return `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_${key}`;
}
function projectScopedEnvValuesCli(values, projectPath) {
  const prefix = `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_`;
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(prefix)) continue;
    const actualKey = key.slice(prefix.length);
    if (/^[A-Z][A-Z0-9_]*$/.test(actualKey)) result[actualKey] = value;
  }
  return result;
}
function localCredentialsMapSkeletonCli(projectPath, projectName, cfg) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    kind: "agentlas-local-credential-store",
    projectName,
    projectRoot: projectPath,
    createdAt: now,
    updatedAt: now,
    envFiles: [".env", ".env.local"],
    secretDirs: [cfg.signingDir, cfg.credentialsDir],
    entries: [],
  };
}
const CREDENTIAL_INDEX_SECTION_CLI = "## Local Credential Index (read first)";
function credentialIndexSectionContentCli(arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const mapFile = (arch && arch.localCredentialsMapFile) || "local-credentials.map.json";
  return `${CREDENTIAL_INDEX_SECTION_CLI}

- For deploy, release, store, billing, auth, API, or cloud work, read
  .agentlas/${mapFile} before saying a credential is missing.
- Real values may live in .env, .env.local, ${cfg.signingDir}/,
  ${cfg.credentialsDir}/, local keychain/vault, or project-scoped global env
  keys like AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME>.
- Keep this memory value-free: record env names, local relative paths, owner,
  stale-check notes, and validation commands only.

| Need | Look here first | Memory record |
|------|-----------------|---------------|
| Scalar env key | .env or .env.local | env name only |
| Store/signing file | ${cfg.signingDir}/ | relative path only |
| App/provider config | ${cfg.credentialsDir}/ | relative path only |
| Shared local env | AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME> | project-scoped env name |
`;
}
function projectSoulTemplateCli(projectName, arch) {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by Agentlas.

${credentialIndexSectionContentCli(arch)}

## Project Purpose

## Current State

## Decisions

## Risks

## Auto-curated memory
`;
}
function ensureSoulCredentialIndexCli(projectPath, projectName, arch) {
  const memoryDir = (arch && arch.memoryDir) || ".agentlas";
  const soulFile = (arch && arch.soulFile) || "project-soul-memory.md";
  const dir = path.join(projectPath, memoryDir);
  const soul = path.join(dir, soulFile);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(soul)) {
    fs.writeFileSync(soul, projectSoulTemplateCli(projectName, arch), "utf8");
    return soul;
  }
  let content = "";
  try { content = fs.readFileSync(soul, "utf8"); } catch { content = ""; }
  if (!content.includes(CREDENTIAL_INDEX_SECTION_CLI)) {
    const section = credentialIndexSectionContentCli(arch);
    const marker = "\n## Project Purpose";
    const next = content.includes(marker)
      ? content.replace(marker, `\n${section}\n## Project Purpose`)
      : `${content.trimEnd()}\n\n${section}\n`;
    fs.writeFileSync(soul, next.endsWith("\n") ? next : next + "\n", "utf8");
  }
  return soul;
}
function envExampleContentCli(cfg) {
  return `# Agentlas local project environment.
# Copy this file to .env and fill real values only on this machine.

# File-path style for tools that expect a local JSON credential file.
SUPPLY_JSON_KEY=${cfg.signingDir}/google-play.json

# Inline JSON style for tools that support reading a credential directly from env.
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
`;
}
function signingReadmeContentCli(cfg) {
  return `# ${cfg.signingDir}/

Put release signing material here when this project needs local deploy or store
automation. This folder is ignored by git except for this README.

Examples:

- Google Play release JSON used by SUPPLY_JSON_KEY
- Apple signing certificates or provisioning profiles
- Notarization or release upload keys

Do not commit files from this folder.
`;
}
function credentialsReadmeContentCli(cfg) {
  return `# ${cfg.credentialsDir}/

Put app or service configuration files here when this project needs local runtime
access. This folder is ignored by git except for this README.

Examples:

- Android google-services.json
- iOS GoogleService-Info.plist
- provider config files used only by this local project

Do not commit files from this folder.
`;
}
function ensureAgentlasCredentialIgnoreCli(projectPath, cfg) {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const marker = "# Agentlas local credentials";
  const block = `${marker}
.env
.env.local
.env.*.local
._*
${cfg.signingDir}/*
!${cfg.signingDir}/
!${cfg.signingDir}/${cfg.readmeFile}
${cfg.credentialsDir}/*
!${cfg.credentialsDir}/
!${cfg.credentialsDir}/${cfg.readmeFile}
`;
  let existing = "";
  try { existing = fs.readFileSync(gitignorePath, "utf8"); } catch { existing = ""; }
  if (existing.includes(marker)) {
    if (!/^\._\*$/m.test(existing)) fs.writeFileSync(gitignorePath, `${existing.trimEnd()}\n._*\n`, "utf8");
    return;
  }
  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  fs.writeFileSync(gitignorePath, next.endsWith("\n") ? next : next + "\n", "utf8");
}
function ensureLocalCredentialStoreCli(projectPath, projectName, arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const dir = path.join(projectPath, (arch && arch.memoryDir) || ".agentlas");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.signingDir), { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.credentialsDir), { recursive: true });
  const envExample = path.join(projectPath, cfg.envExampleFile);
  if (!fs.existsSync(envExample)) fs.writeFileSync(envExample, envExampleContentCli(cfg), "utf8");
  const signingReadme = path.join(projectPath, cfg.signingDir, cfg.readmeFile);
  if (!fs.existsSync(signingReadme)) fs.writeFileSync(signingReadme, signingReadmeContentCli(cfg), "utf8");
  const credentialsReadme = path.join(projectPath, cfg.credentialsDir, cfg.readmeFile);
  if (!fs.existsSync(credentialsReadme)) fs.writeFileSync(credentialsReadme, credentialsReadmeContentCli(cfg), "utf8");
  const mapPath = path.join(dir, cfg.mapFile);
  if (!fs.existsSync(mapPath)) {
    fs.writeFileSync(mapPath, JSON.stringify(localCredentialsMapSkeletonCli(projectPath, projectName, cfg), null, 2) + "\n", "utf8");
  }
  ensureAgentlasCredentialIgnoreCli(projectPath, cfg);
  return { cfg, mapPath };
}
function readJsonObjectCli(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function upsertLocalCredentialMapCli(projectPath, projectName, arch, entry) {
  const { cfg, mapPath } = ensureLocalCredentialStoreCli(projectPath, projectName, arch || loadArch());
  const data = readJsonObjectCli(mapPath, localCredentialsMapSkeletonCli(projectPath, projectName, cfg));
  const now = new Date().toISOString();
  data.updatedAt = now;
  if (!Array.isArray(data.entries)) data.entries = [];
  const id = entry.id || `${entry.provider || "credential"}:${(entry.env || []).join(",") || (entry.localFiles || []).join(",")}`;
  const clean = {
    id,
    provider: entry.provider || "unknown",
    env: Array.isArray(entry.env) ? [...new Set(entry.env.filter(Boolean))] : [],
    localFiles: Array.isArray(entry.localFiles) ? [...new Set(entry.localFiles.filter(Boolean))] : [],
    owner: entry.owner || "project",
    valueMaterialized: Boolean(entry.valueMaterialized),
    storage: Array.isArray(entry.storage) ? [...new Set(entry.storage.filter(Boolean))] : [],
    requiredFor: Array.isArray(entry.requiredFor) ? [...new Set(entry.requiredFor.filter(Boolean))] : [],
    lastVerified: entry.lastVerified || null,
    staleCheck: entry.staleCheck || null,
    updatedAt: now,
  };
  const idx = data.entries.findIndex((row) => row && row.id === id);
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...clean };
  else data.entries.push(clean);
  fs.writeFileSync(mapPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function safeCredentialDestRelCli(destRel) {
  const rel = path.normalize(String(destRel || "")).replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || rel === "." || rel.startsWith("../") || rel.includes("\0")) {
    fail("credential destination must be a relative path inside the project");
  }
  return rel;
}

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    ensureLocalCredentialStoreCli(projectPath, name, arch);
    ensureSoulCredentialIndexCli(projectPath, name, arch);
    const sitemap = path.join(dir, arch.sitemapFile);
    if (!fs.existsSync(sitemap)) {
      const now = new Date().toISOString();
      fs.writeFileSync(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2), "utf8");
    }
    const skillRegistryFile = arch.skillRegistryFile || "skill-registry.json";
    const skillTrialsFile = arch.skillTrialsFile || "skill-trials.jsonl";
    const curatorDecisionsFile = arch.curatorDecisionsFile || "curator-decisions.jsonl";
    const ontologyRuntimeFile = arch.ontologyRuntimeFile || "ontology-runtime.json";
    const ontologySourceManifestFile = arch.ontologySourceManifestFile || "ontology-sources.json";
    const ontologyInboxDir = arch.ontologyInboxDir || "ontology-inbox";
    const ontologyDbFile = arch.ontologyDbFile || "ontology-runtime.sqlite";
    const superOntologyContractFile = arch.superOntologyContractFile || "super-ontology-contract.json";
    const superOntologyOpenWorldCoverageFile =
      arch.superOntologyOpenWorldCoverageFile || "super-ontology-open-world-coverage.json";
    const superOntologyConsensusCoordinationFile =
      arch.superOntologyConsensusCoordinationFile || "super-ontology-consensus-coordination.json";
    const superOntologyTaskCoverageFile = arch.superOntologyTaskCoverageFile || "super-ontology-task-coverage.json";
    const superOntologyAssuranceCaseFile = arch.superOntologyAssuranceCaseFile || "super-ontology-assurance-case.json";
    const superOntologyContextualFlowFile = arch.superOntologyContextualFlowFile || "super-ontology-contextual-flow.json";
    const superOntologyCausalImpactFile = arch.superOntologyCausalImpactFile || "super-ontology-causal-impact.json";
    const superOntologyKnowledgeHomeostasisFile =
      arch.superOntologyKnowledgeHomeostasisFile || "super-ontology-knowledge-homeostasis.json";
    const superOntologyAdversarialProvenanceFile =
      arch.superOntologyAdversarialProvenanceFile || "super-ontology-adversarial-provenance.json";
    const superOntologyEpistemicCalibrationFile =
      arch.superOntologyEpistemicCalibrationFile || "super-ontology-epistemic-calibration.json";
    const superOntologySemanticAlignmentFile =
      arch.superOntologySemanticAlignmentFile || "super-ontology-semantic-alignment.json";
    const superOntologyResilienceControlFile =
      arch.superOntologyResilienceControlFile || "super-ontology-resilience-control.json";
    const superOntologyInvariantVerificationFile =
      arch.superOntologyInvariantVerificationFile || "super-ontology-invariant-verification.json";
    const superOntologyObservabilityTelemetryFile =
      arch.superOntologyObservabilityTelemetryFile || "super-ontology-observability-telemetry.json";
    const superOntologyObjectiveProxyValidityFile =
      arch.superOntologyObjectiveProxyValidityFile || "super-ontology-objective-proxy-validity.json";
    const superOntologyStakeholderPreferenceGovernanceFile =
      arch.superOntologyStakeholderPreferenceGovernanceFile ||
      "super-ontology-stakeholder-preference-governance.json";
    const superOntologyNormativeAuthorityDriftFile =
      arch.superOntologyNormativeAuthorityDriftFile ||
      "super-ontology-normative-authority-drift.json";
    const superOntologySideEffectContainmentFile =
      arch.superOntologySideEffectContainmentFile ||
      "super-ontology-side-effect-containment.json";
    const superOntologySourceLineageVersionFile =
      arch.superOntologySourceLineageVersionFile ||
      "super-ontology-source-lineage-version.json";
    const superOntologyEntityIdentityResolutionFile =
      arch.superOntologyEntityIdentityResolutionFile ||
      "super-ontology-entity-identity-resolution.json";
    const superOntologyTemporalStateTransitionFile =
      arch.superOntologyTemporalStateTransitionFile ||
      "super-ontology-temporal-state-transition.json";
    const superOntologyCapabilityDelegationAuthorityFile =
      arch.superOntologyCapabilityDelegationAuthorityFile ||
      "super-ontology-capability-delegation-authority.json";
    const superOntologyPrivacyConfidentialityBoundaryFile =
      arch.superOntologyPrivacyConfidentialityBoundaryFile ||
      "super-ontology-privacy-confidentiality-boundary.json";
    const superOntologyStrategicIncentiveCompatibilityFile =
      arch.superOntologyStrategicIncentiveCompatibilityFile ||
      "super-ontology-strategic-incentive-compatibility.json";
    const superOntologyReflexiveFeedbackStabilityFile =
      arch.superOntologyReflexiveFeedbackStabilityFile ||
      "super-ontology-reflexive-feedback-stability.json";
    const superOntologyReplaysFile = arch.superOntologyReplaysFile || "super-ontology-replays.jsonl";
    const superOntologyEvidenceFile = arch.superOntologyEvidenceFile || "super-ontology-evidence.jsonl";
    const superOntologyMemoryBridgeFile = arch.superOntologyMemoryBridgeFile || "super-ontology-memory-bridge.jsonl";
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
    const ontologyInbox = path.join(dir, ontologyInboxDir);
    if (!fs.existsSync(ontologyInbox)) fs.mkdirSync(ontologyInbox, { recursive: true });
    const ontologyRuntime = path.join(dir, ontologyRuntimeFile);
    if (!fs.existsSync(ontologyRuntime)) {
      fs.writeFileSync(ontologyRuntime, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-runtime",
        state: "active",
        activation: "automatic",
        projectRoot: projectPath,
        projectName: name,
        dbPath: path.join(dir, ontologyDbFile),
        inboxPath: ontologyInbox,
        sourceManifest: path.join(dir, ontologySourceManifestFile),
        defaultScope: "internal",
        autoIngestPolicy: {
          mode: "inbox_and_registered_sources_only",
          neverScanHomeDirectory: true,
          neverScanSiblingProjects: true,
          crossProjectSearchDefault: "disabled",
          privateScopeDefaultSearch: "excluded",
        },
        promotionMode: {
          operatorManagedLocal: true,
          securityGateMode: "context_folder_routing_only",
          blockingSecurityGate: false,
          notes: "Local promotion is blocked by missing project/folder/owner/evidence/rollback structure, not by a generic security gate.",
        },
        memoryPolicy: {
          durableWrites: "candidate-ticket-only",
          workingMemory: "runtime-cache-only",
        },
      }, null, 2), "utf8");
    }
    const ontologySources = path.join(dir, ontologySourceManifestFile);
    if (!fs.existsSync(ontologySources)) {
      fs.writeFileSync(ontologySources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-source-manifest",
        projectRoot: projectPath,
        sources: [],
      }, null, 2), "utf8");
    }
    for (const fileName of [skillTrialsFile, curatorDecisionsFile]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    const superOntologyContract = path.join(dir, superOntologyContractFile);
    if (!fs.existsSync(superOntologyContract)) {
      fs.writeFileSync(superOntologyContract, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-contract",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimeGraphWriteEnabled: false,
        zeroErrorClaim: false,
        operatorManagedPromotion: {
          enabled: true,
          runtimePromotionModel: "operator_managed_local",
          securityGateMode: "context_folder_routing_only",
          blockingSecurityGate: false,
          requiredBeforePromotion: [
            "project_root",
            "source_folder",
            "owner",
            "evidence_refs",
            "rollback_or_replay_path",
          ],
          publicExportRemainsValueFree: true,
          notes: "Local operators may promote when structure and ownership are explicit. Security labels are routing metadata, not a generic runtime stop sign.",
        },
        layers: [
          "source_intake",
          "evidence_packet",
          "belief_ledger",
          "knowledge_capsule",
          "affordance_action_binding",
          "agentlas_integration_contract",
          "memory_curator_bridge",
          "open_world_coverage_contract",
          "consensus_coordination_contract",
          "task_coverage_contract",
          "contextual_flow_contract",
          "causal_impact_contract",
          "assurance_case_contract",
          "knowledge_homeostasis_contract",
          "adversarial_provenance_contract",
          "epistemic_calibration_contract",
          "semantic_alignment_contract",
          "resilience_control_contract",
          "invariant_verification_contract",
          "observability_telemetry_contract",
          "objective_proxy_validity_contract",
          "stakeholder_preference_governance_contract",
          "normative_authority_drift_contract",
          "side_effect_containment_contract",
          "source_lineage_version_contract",
          "entity_identity_resolution_contract",
          "temporal_state_transition_contract",
          "capability_delegation_authority_contract",
          "privacy_confidentiality_boundary_contract",
          "strategic_incentive_compatibility_contract",
          "reflexive_feedback_stability_contract",
          "promotion_readiness",
          "promotion_replay_drill",
          "architecture_sync_review",
        ],
        evidenceLedgers: {
          replays: `.agentlas/${superOntologyReplaysFile}`,
          promotionEvidence: `.agentlas/${superOntologyEvidenceFile}`,
          memoryTickets: `.agentlas/${arch.logFile}`,
          memoryCuratorBridge: `.agentlas/${superOntologyMemoryBridgeFile}`,
          openWorldCoverage: `.agentlas/${superOntologyOpenWorldCoverageFile}`,
          consensusCoordination: `.agentlas/${superOntologyConsensusCoordinationFile}`,
          taskCoverage: `.agentlas/${superOntologyTaskCoverageFile}`,
          contextualFlow: `.agentlas/${superOntologyContextualFlowFile}`,
          causalImpact: `.agentlas/${superOntologyCausalImpactFile}`,
          assuranceCase: `.agentlas/${superOntologyAssuranceCaseFile}`,
          knowledgeHomeostasis: `.agentlas/${superOntologyKnowledgeHomeostasisFile}`,
          adversarialProvenance: `.agentlas/${superOntologyAdversarialProvenanceFile}`,
          epistemicCalibration: `.agentlas/${superOntologyEpistemicCalibrationFile}`,
          semanticAlignment: `.agentlas/${superOntologySemanticAlignmentFile}`,
          resilienceControl: `.agentlas/${superOntologyResilienceControlFile}`,
          invariantVerification: `.agentlas/${superOntologyInvariantVerificationFile}`,
          observabilityTelemetry: `.agentlas/${superOntologyObservabilityTelemetryFile}`,
          objectiveProxyValidity: `.agentlas/${superOntologyObjectiveProxyValidityFile}`,
          stakeholderPreferenceGovernance: `.agentlas/${superOntologyStakeholderPreferenceGovernanceFile}`,
          normativeAuthorityDrift: `.agentlas/${superOntologyNormativeAuthorityDriftFile}`,
          sideEffectContainment: `.agentlas/${superOntologySideEffectContainmentFile}`,
          sourceLineageVersion: `.agentlas/${superOntologySourceLineageVersionFile}`,
          entityIdentityResolution: `.agentlas/${superOntologyEntityIdentityResolutionFile}`,
          temporalStateTransition: `.agentlas/${superOntologyTemporalStateTransitionFile}`,
          capabilityDelegationAuthority: `.agentlas/${superOntologyCapabilityDelegationAuthorityFile}`,
          privacyConfidentialityBoundary: `.agentlas/${superOntologyPrivacyConfidentialityBoundaryFile}`,
          strategicIncentiveCompatibility: `.agentlas/${superOntologyStrategicIncentiveCompatibilityFile}`,
          reflexiveFeedbackStability: `.agentlas/${superOntologyReflexiveFeedbackStabilityFile}`,
        },
        hardStops: [
          "zero_error_claim",
          "raw_source_to_graph_write",
          "forbidden_context_join",
          "whole_graph_exposure",
          "tool_authority_without_provenance",
          "missing_open_world_coverage_contract",
          "proposal_example_equals_all_tasks",
          "unknown_combination_to_runtime_write",
          "untested_modality_to_memory_write",
          "implicit_degradation_as_complete_data",
          "adversarial_source_as_authority",
          "forbidden_authority_to_action",
          "missing_consensus_coordination_contract",
          "agent_agreement_as_truth",
          "majority_vote_as_write_authority",
          "debate_stability_as_proof",
          "model_judge_as_final_evidence",
          "distributed_replica_merge_without_review",
          "route_sync_without_quorum",
          "last_writer_wins_architecture_update",
          "peer_pressure_to_memory_write",
          "validator_disagreement_to_release",
          "appbridge_source_of_truth_write",
          "missing_rollback",
          "missing_shadow_or_canary_evidence",
          "missing_memory_curator_bridge",
          "missing_task_coverage_contract",
          "missing_contextual_flow_contract",
          "forbidden_context_flow",
          "missing_causal_impact_contract",
          "missing_assurance_case_contract",
          "missing_knowledge_homeostasis_contract",
          "error_budget_overrun_continues",
          "critical_homeostasis_runtime_write",
          "privacy_incident_public_export",
          "missing_adversarial_provenance_contract",
          "prompt_injection_as_instruction",
          "forged_provenance_as_trusted_source",
          "poisoned_source_to_memory",
          "tool_output_tampering_to_action",
          "stale_trusted_source_replay_as_current_truth",
          "missing_epistemic_calibration_contract",
          "uncalibrated_confidence_to_answer",
          "unknown_state_to_runtime_write",
          "conflicting_sources_as_current_truth",
          "low_retrieval_relevance_as_confident_answer",
          "wide_judge_interval_to_regulated_answer",
          "missing_semantic_alignment_contract",
          "same_label_as_same_meaning",
          "embedding_similarity_as_exact_match",
          "close_match_as_transitive_truth",
          "generated_label_as_ontology_class",
          "appbridge_route_as_source_ontology_edit",
          "same_individual_without_stable_identifier",
          "unit_label_without_unit_compatibility",
          "source_conflict_to_memory_merge",
          "no_match_promoted_to_weak_match",
          "missing_resilience_control_contract",
          "validator_disagreement_to_graph_write",
          "retrieval_drift_to_current_answer",
          "semantic_regression_to_memory_merge",
          "curator_backlog_to_direct_memory_write",
          "tool_error_spike_to_unbounded_retry",
          "sync_drift_to_release_surface",
          "degraded_parser_to_ontology_class",
          "emergency_stop_bypass_by_route",
          "missing_invariant_verification_contract",
          "memory_write_without_ticket_invariant",
          "graph_write_without_evidence_invariant",
          "tool_action_without_authority_invariant",
          "public_export_without_flow_invariant",
          "route_sync_without_source_contract_invariant",
          "rollback_not_observed_after_violation",
          "emergency_stop_transition_bypassed",
          "unordered_multi_agent_write",
          "non_idempotent_replay_mutation",
          "missing_observability_telemetry_contract",
          "write_without_trace_id",
          "memory_ticket_without_span_lineage",
          "tool_action_without_audit_receipt",
          "public_export_with_stale_metric",
          "route_sync_without_correlation_id",
          "release_seed_when_audit_sink_down",
          "redaction_missing_in_telemetry",
          "metric_green_without_sample_size",
          "alert_suppressed_during_degraded_mode",
          "shadow_replay_not_recorded",
          "repair_without_before_after_snapshot",
          "rollback_without_observed_event",
          "unobservable_runtime_write",
          "missing_objective_proxy_validity_contract",
          "metric_improvement_as_goal_completion",
          "approval_rate_as_trust",
          "benchmark_score_as_reliability",
          "test_pass_rate_as_maintainability",
          "open_rate_as_customer_value",
          "self_judge_score_as_truth",
          "edge_count_as_knowledge_quality",
          "short_term_profit_as_compliance",
          "cost_per_execution_as_sustainability",
          "reward_score_as_quality",
          "label_leakage_as_accuracy",
          "green_dashboard_as_health",
          "proxy_optimization_without_countermetric",
          "optimization_without_stakeholder_map",
          "metric_gaming_without_probe",
          "reward_tampering_to_promotion",
          "construct_underdefined_to_runtime_write",
          "unvalidated_proxy_to_public_release",
          "missing_stakeholder_preference_governance_contract",
          "single_stakeholder_preference_as_global_goal",
          "owner_preference_as_all_stakeholders",
          "majority_preference_as_rights_clearance",
          "average_utility_over_protected_constraint",
          "hidden_affected_party",
          "missing_appeal_path",
          "missing_dissent_capture",
          "strategic_preference_report_as_truth",
          "preference_aggregation_without_rule",
          "preference_conflict_to_runtime_write",
          "consent_absent_to_personalization",
          "minority_harm_hidden_by_aggregate",
          "irreversible_action_without_stakeholder_review",
          "private_preference_to_public_release",
          "cross_context_preference_reuse_without_scope",
          "role_power_as_legitimacy",
          "arrow_impossibility_ignored",
          "manipulable_vote_as_stable_preference",
          "stakeholder_map_missing_for_release",
          "missing_normative_authority_drift_contract",
          "stale_policy_as_current_rule",
          "wrong_jurisdiction_as_valid_policy",
          "draft_policy_as_enforced_rule",
          "superseded_contract_as_current_authority",
          "terms_of_service_without_effective_date",
          "local_custom_as_global_policy",
          "internal_preference_as_legal_requirement",
          "policy_exception_without_owner",
          "conflicting_authorities_without_precedence",
          "regulation_summary_as_primary_law",
          "compliance_claim_without_citation",
          "policy_translation_as_authoritative_text",
          "expired_consent_as_current_permission",
          "missing_retention_or_deletion_rule",
          "cross_border_transfer_without_jurisdiction",
          "licensing_constraint_ignored",
          "audit_requirement_missing_before_release",
          "emergency_exception_without_expiry",
          "legal_advice_without_review",
          "missing_side_effect_containment_contract",
          "read_permission_as_write_permission",
          "preview_as_send",
          "dry_run_result_as_committed",
          "non_idempotent_retry_to_external_action",
          "irreversible_action_without_human_approval",
          "deletion_without_recovery_plan",
          "payment_without_idempotency_key",
          "customer_message_without_review",
          "release_without_rollback",
          "connector_write_without_scope",
          "cross_tool_chain_without_transaction",
          "compensation_plan_missing",
          "blast_radius_unknown",
          "idempotency_key_missing",
          "external_commit_without_receipt",
          "partial_failure_without_saga_state",
          "physical_action_without_safety_interlock",
          "scheduled_action_without_cancellation",
          "side_effect_logging_missing",
          "hosted_tool_without_local_side_effect_wrapper",
          "missing_source_lineage_version_contract",
          "filename_as_version",
          "latest_folder_as_current_source",
          "pdf_export_as_primary_source",
          "summary_as_primary_source",
          "ocr_text_without_source_span",
          "spreadsheet_sheet_without_workbook_revision",
          "email_attachment_without_message_context",
          "duplicate_title_as_same_artifact",
          "checksum_missing_for_authoritative_source",
          "stale_cache_as_current_record",
          "connector_snapshot_without_capture_time",
          "transitive_derivation_as_primary_source",
          "merged_record_without_parent_refs",
          "redacted_copy_as_complete_source",
          "translation_as_authoritative_source",
          "chunk_without_source_span",
          "embedding_hit_without_artifact_version",
          "memory_fact_without_lineage",
          "public_export_without_lineage_evidence",
          "training_example_without_dataset_version",
          "graph_edge_without_derivation_chain",
          "superseded_source_to_runtime_write",
          "lineage_cycle_unresolved",
          "missing_entity_identity_resolution_contract",
          "name_as_identity",
          "email_domain_as_company",
          "fuzzy_match_as_merge",
          "embedding_cluster_as_identity",
          "llm_canonical_name_as_id",
          "crm_id_cross_tenant_merge",
          "recycled_employee_id_as_same_person",
          "redacted_name_as_public_identity",
          "stale_alias_as_current_entity",
          "relationship_edge_without_identity_evidence",
          "memory_note_as_identity_authority",
          "missing_temporal_state_transition_contract",
          "current_snapshot_as_truth",
          "missing_valid_time",
          "missing_transaction_time",
          "local_timestamp_as_global_order",
          "spreadsheet_order_as_event_order",
          "llm_summary_as_event_log",
          "late_event_ignored",
          "retroactive_correction_without_tx_history",
          "future_effective_as_current",
          "expired_state_as_active",
          "deleted_state_without_tombstone",
          "non_idempotent_replay",
          "materialized_view_as_source_of_truth",
          "projection_without_version",
          "recurring_event_without_rule",
          "timezone_free_deadline",
          "state_transition_without_precondition",
          "partial_failure_as_success",
          "clock_skew_as_fact",
          "scheduled_job_without_receipt",
          "memory_fact_without_validity_interval",
          "graph_edge_without_temporal_bounds",
          "missing_capability_delegation_authority_contract",
          "role_as_capability",
          "oauth_scope_as_task_permission",
          "api_key_as_actor",
          "read_access_as_write_authority",
          "parent_agent_unbounded_delegation",
          "delegation_chain_missing",
          "purpose_mismatch_authority",
          "capability_without_caveats",
          "stale_capability_token_as_current",
          "cross_context_capability_reuse",
          "capability_escalation_by_tool_choice",
          "subagent_exceeds_parent_authority",
          "human_consent_reused_for_new_purpose",
          "permission_prompt_as_policy",
          "tool_schema_as_authorization",
          "cached_auth_decision_without_fresh_context",
          "break_glass_without_expiry",
          "admin_role_as_all_actions",
          "shared_service_account_as_identity",
          "task_goal_as_permission",
          "hidden_tool_call_without_policy_decision",
          "missing_privacy_confidentiality_boundary_contract",
          "pii_as_normal_fact",
          "secret_as_graph_label",
          "confidential_deck_as_public_context",
          "consent_missing_for_personal_data",
          "legal_basis_missing_for_processing",
          "purpose_reuse_without_privacy_review",
          "training_on_private_material",
          "public_export_without_redaction",
          "retention_expired_memory",
          "data_subject_delete_ignored",
          "cross_tenant_context_bleed",
          "customer_data_as_public_demo",
          "personal_life_as_company_context",
          "employee_note_as_hr_decision",
          "inferred_sensitive_attribute_to_output",
          "redacted_text_reidentified",
          "connector_cache_as_allowed_use",
          "screenshot_ocr_without_classification",
          "embedding_of_secret_without_policy",
          "vector_search_private_neighbor_leak",
          "shared_memory_without_audience_boundary",
          "confidential_source_to_untrusted_model",
          "legal_privilege_lost_by_disclosure",
          "missing_strategic_incentive_compatibility_contract",
          "self_report_as_truth",
          "kpi_as_objective",
          "commission_report_as_fact",
          "manager_approval_as_no_conflict",
          "vendor_claim_as_source_quality",
          "customer_rating_as_value",
          "agent_vote_as_independent_signal",
          "benchmark_score_as_general_capability",
          "cheap_provider_as_best_provider",
          "data_provider_label_as_quality",
          "compliance_attestation_as_compliance",
          "peer_pressure_as_consensus",
          "hidden_affiliation_as_neutral_review",
          "survey_response_as_stable_preference",
          "retention_metric_as_satisfaction",
          "access_request_as_need_to_know",
          "family_pressure_as_user_preference",
          "approval_chain_as_truthfulness",
          "cost_saving_as_system_health",
          "strategic_silence_as_no_risk",
          "collusive_agents_as_quorum",
          "mechanism_missing_to_runtime_write",
          "incentive_conflict_to_memory_write",
          "reward_model_as_human_goal",
          "missing_reflexive_feedback_stability_contract",
          "observation_after_intervention_as_neutral_truth",
          "recommendation_effect_as_preference",
          "self_generated_content_as_training_data",
          "model_output_as_source_corpus",
          "dashboard_change_as_system_improvement",
          "metric_response_as_real_world_gain",
          "repeated_retrieval_as_relevance",
          "agent_self_score_as_external_feedback",
          "closed_loop_without_counterfactual",
          "runaway_feedback_to_runtime_write",
          "oscillation_as_adaptation",
          "delayed_harm_ignored",
          "synthetic_data_loop_as_real_distribution",
          "intervention_without_stop_condition",
          "user_adaptation_as_stable_preference",
          "market_response_as_causal_truth",
          "personal_nudge_as_identity_change",
          "training_on_ai_outputs_without_real_anchor",
          "feedback_loop_to_memory_write",
          "feedback_loop_to_policy_write",
          "externality_free_assumption",
          "correlation_as_causation",
          "unsupported_claim",
          "direct_durable_memory_write",
          "raw_prompt_or_secret_memory_capture",
        ],
        promotionPolicy: {
          shadowRequired: true,
          canaryRequiredForMixedContext: true,
          rollbackRequired: true,
          syncReviewRequired: true,
          appbridgeSourceWritesBlocked: true,
          memoryCuratorBridgeRequired: true,
          openWorldCoverageRequired: true,
          unknownCombinationRuntimeWritesBlocked: true,
          uncoveredModalityRuntimeWritesBlocked: true,
          consensusCoordinationRequired: true,
          agentAgreementRuntimeWritesBlocked: true,
          majorityVoteRuntimeWritesBlocked: true,
          splitBrainRuntimeWritesBlocked: true,
          taskCoverageRequired: true,
          contextualFlowRequired: true,
          causalImpactRequired: true,
          assuranceCaseRequired: true,
          knowledgeHomeostasisRequired: true,
          adversarialProvenanceRequired: true,
          untrustedSourceRuntimeWritesBlocked: true,
          epistemicCalibrationRequired: true,
          uncalibratedRuntimeWritesBlocked: true,
          semanticAlignmentRequired: true,
          highAuthorityAlignmentReviewRequired: true,
          unreviewedSemanticRuntimeWritesBlocked: true,
          resilienceControlRequired: true,
          degradedRuntimeWritesBlocked: true,
          emergencyStopBypassBlocked: true,
          invariantVerificationRequired: true,
          runtimeInvariantWritesBlocked: true,
          forbiddenTransitionBlocked: true,
          observabilityTelemetryRequired: true,
          unobservableRuntimeWritesBlocked: true,
          auditSinkRequired: true,
          crossSurfaceCorrelationRequired: true,
          objectiveProxyValidityRequired: true,
          proxyOptimizationRuntimeWritesBlocked: true,
          countermetricRequired: true,
          metricGamingProbeRequired: true,
          stakeholderPreferenceGovernanceRequired: true,
          singleStakeholderRuntimeWritesBlocked: true,
          aggregationRuleRequired: true,
          appealPathRequired: true,
          normativeAuthorityDriftRequired: true,
          stalePolicyRuntimeWritesBlocked: true,
          jurisdictionScopeRequired: true,
          authorityHierarchyRequired: true,
          sideEffectContainmentRequired: true,
          irreversibleRuntimeActionsBlocked: true,
          idempotencyKeyRequired: true,
          compensationPlanRequired: true,
          sourceLineageVersionRequired: true,
          unversionedSourceRuntimeWritesBlocked: true,
          derivedArtifactPromotionBlocked: true,
          lineageRepairRequired: true,
          entityIdentityResolutionRequired: true,
          ambiguousIdentityRuntimeWritesBlocked: true,
          identityMergeReviewRequired: true,
          identityRollbackRequired: true,
          temporalStateTransitionRequired: true,
          timelessStateRuntimeWritesBlocked: true,
          eventReplayRequired: true,
          projectionVersionRequired: true,
          capabilityDelegationAuthorityRequired: true,
          unscopedCapabilityRuntimeWritesBlocked: true,
          delegationChainRequired: true,
          capabilityAttenuationRequired: true,
          purposeBoundCapabilityRequired: true,
          directDurableMemoryWritesBlocked: true,
          privacyConfidentialityBoundaryRequired: true,
          unclassifiedPrivateRuntimeWritesBlocked: true,
          privacyBoundaryReviewRequired: true,
          publicTrainingDisclosureFlagRequired: true,
          deletionAndRetentionStateRequired: true,
          crossTenantPrivacyBleedBlocked: true,
          strategicIncentiveCompatibilityRequired: true,
          incentiveConflictRuntimeWritesBlocked: true,
          mechanismReviewRequired: true,
          independentVerificationRequired: true,
          collusionCheckRequired: true,
          mechanismRedesignRequired: true,
          reflexiveFeedbackStabilityRequired: true,
          postInterventionRuntimeWritesBlocked: true,
          feedbackHoldoutRequired: true,
          realWorldAnchorRequired: true,
          dampingAndStopConditionRequired: true,
          modelCollapseLoopBlocked: true,
        },
        surfacePolicy: {
          desktopTerminal: {
            defaultDecision: "shadow_required",
            notes: "Local graph-write behavior needs permission audit and replay.",
          },
          appbridge: {
            defaultDecision: "blocked",
            notes: "AppBridge remains a route adapter, never the source of truth.",
          },
        },
      }, null, 2), "utf8");
    }
    const superOntologyOpenWorldCoverage = path.join(dir, superOntologyOpenWorldCoverageFile);
    if (!fs.existsSync(superOntologyOpenWorldCoverage)) {
      fs.writeFileSync(superOntologyOpenWorldCoverage, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-open-world-coverage",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "lower_authority_before_unknown_combination_write",
        worldFamilies: [
          "personal_life",
          "company_operations",
          "public_research",
          "scientific_observation",
          "social_institutional",
          "creative_media",
          "regulated_health",
          "legal_compliance",
          "industrial_physical",
          "environmental_geospatial",
          "software_enterprise",
          "education",
          "finance_compliance",
          "multimodal_brand",
          "unknown_mixed",
        ],
        modalities: [
          "text",
          "table",
          "slide",
          "pdf",
          "hwp",
          "image",
          "video",
          "audio",
          "sensor",
          "code",
          "database",
          "email",
          "calendar",
          "web",
          "geospatial",
        ],
        faultModels: [
          "none",
          "explicit_error",
          "implicit_degradation",
          "mixed_fault",
          "missing_field",
          "stale_source",
          "adversarial_source",
          "permission_gap",
          "semantic_ambiguity",
          "causal_gap",
        ],
        authorityStates: [
          "public_allowed",
          "owner_authority_present",
          "authority_unknown",
          "regulated_requires_review",
          "forbidden",
        ],
        coverageGaps: [
          "covered",
          "new_combination",
          "underrepresented_world",
          "missing_fault_fixture",
          "missing_modality_fixture",
          "missing_authority_fixture",
        ],
        requiredGates: [
          "task_coverage",
          "contextual_flow",
          "epistemic_calibration",
          "semantic_alignment",
          "adversarial_provenance",
          "causal_impact",
          "knowledge_homeostasis",
          "resilience_control",
          "invariant_verification",
          "memory_curator_bridge",
          "assurance_case",
          "shadow_canary_replay",
          "owner_review",
        ],
        samplingActions: [
          "allow_as_research_fixture",
          "add_fixture",
          "ask_clarify",
          "shadow_replay",
          "quarantine",
          "block",
          "require_owner_review",
        ],
        promotionDecisions: [
          "candidate_only",
          "shadow_required",
          "sync_review_required",
          "blocked",
        ],
        researchBasis: [
          "open_world_evaluation",
          "professional_agent_benchmarks",
          "real_computer_environment_benchmarks",
          "ontology_oriented_kg_construction",
          "enterprise_ontology_scope_limits",
          "no_free_lunch",
          "zero_trust_architecture",
        ],
        hardStops: [
          "missing_open_world_coverage_contract",
          "proposal_example_equals_all_tasks",
          "unknown_combination_to_runtime_write",
          "untested_modality_to_memory_write",
          "implicit_degradation_as_complete_data",
          "adversarial_source_as_authority",
          "forbidden_authority_to_action",
          "open_world_case_without_shadow_replay",
          "open_world_case_without_owner_or_sync_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyConsensusCoordination = path.join(dir, superOntologyConsensusCoordinationFile);
    if (!fs.existsSync(superOntologyConsensusCoordination)) {
      fs.writeFileSync(superOntologyConsensusCoordination, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-consensus-coordination",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "treat_agent_agreement_as_candidate_signal_not_write_authority",
        coordinationTopologies: [
          "independent_parallel",
          "star_orchestrator",
          "round_robin",
          "majority_vote",
          "weighted_vote",
          "debate",
          "owner_review_board",
          "distributed_replicas",
          "cross_runtime_sync",
        ],
        failureModes: [
          "majority_corruption",
          "peer_pressure",
          "sycophancy",
          "split_brain",
          "stale_replica",
          "double_write",
          "authority_escalation",
          "validator_disagreement",
          "collusion",
          "unreliable_judge",
          "network_partition",
          "race_condition",
        ],
        requiredGates: [
          "adversarial_provenance",
          "epistemic_calibration",
          "semantic_alignment",
          "knowledge_homeostasis",
          "resilience_control",
          "invariant_verification",
          "memory_curator_bridge",
          "assurance_case",
          "shadow_canary_replay",
          "owner_review",
          "sync_gate",
        ],
        consensusPolicies: [
          "independent_verification",
          "stability_detection",
          "evidence_weighted",
          "unanimity_for_high_risk",
          "owner_tiebreak",
          "quorum_plus_veto",
          "read_only_shadow",
          "two_phase_commit",
          "crdt_merge_with_review",
          "block",
        ],
        conflictResolutions: [
          "ask_clarify",
          "quarantine",
          "shadow_replay",
          "owner_review",
          "sync_review",
          "rollback",
          "emergency_stop",
          "merge_as_contested",
          "reject",
          "read_only_mode",
        ],
        researchBasis: [
          "multi_agent_consensus_risk",
          "peer_pressure_research",
          "distributed_systems_consensus",
          "ontology_conflict_resolution",
          "assurance_case",
          "zero_trust_architecture",
        ],
        hardStops: [
          "missing_consensus_coordination_contract",
          "agent_agreement_as_truth",
          "majority_vote_as_write_authority",
          "debate_stability_as_proof",
          "model_judge_as_final_evidence",
          "distributed_replica_merge_without_review",
          "route_sync_without_quorum",
          "last_writer_wins_architecture_update",
          "peer_pressure_to_memory_write",
          "validator_disagreement_to_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyContextualFlow = path.join(dir, superOntologyContextualFlowFile);
    if (!fs.existsSync(superOntologyContextualFlow)) {
      fs.writeFileSync(superOntologyContextualFlow, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-contextual-flow",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "contextual_flow_required_before_boundary_crossing",
        flowStages: [
          "user_to_agent",
          "agent_to_tool",
          "tool_to_agent",
          "agent_to_agent",
          "agent_to_memory",
          "agent_to_output",
          "agent_to_public_surface",
        ],
        contexts: ["personal", "company", "customer", "public", "regulated", "agent_internal"],
        requiredParameters: [
          "source_context",
          "target_context",
          "sender_role",
          "recipient_role",
          "subject_role",
          "attribute_type",
          "transmission_principle",
          "purpose",
          "authority_basis",
          "sensitivity",
          "retention_policy",
          "audit_refs",
        ],
        decisions: ["allow", "redact", "aggregate_only", "review_required", "block"],
        researchBasis: [
          "contextual_integrity",
          "privacy_flow_graph",
          "multi_agent_contextual_privacy",
          "compositional_privacy",
          "information_flow_control",
          "nist_ai_rmf_gai_profile",
          "w3c_prov",
          "stpa_mode_confusion",
        ],
        hardStops: [
          "same_user_means_all_contexts_joinable",
          "tool_response_as_need_to_know",
          "public_output_after_private_handoff",
          "raw_prompt_or_transcript_to_memory",
          "customer_data_to_public_surface_without_consent",
          "regulated_data_to_training_without_consent_delete_path",
          "agent_internal_trace_to_user_output",
          "cross_project_join_without_scope_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyCausalImpact = path.join(dir, superOntologyCausalImpactFile);
    if (!fs.existsSync(superOntologyCausalImpact)) {
      fs.writeFileSync(superOntologyCausalImpact, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-causal-impact",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "counterfactual_required_before_state_change",
        causalClaimTypes: [
          "correlation_only",
          "causal_hypothesis",
          "intervention",
          "counterfactual",
          "temporal_causal",
          "memory_intervention",
          "multi_agent_plan",
          "external_side_effect",
          "physical_or_train",
        ],
        requiredChecks: [
          "intervention_target",
          "expected_outcomes",
          "adverse_outcomes",
          "counterfactual_checks",
          "observability",
          "reversibility",
          "blast_radius",
          "blocked_write_surfaces",
          "rollback_plan",
        ],
        decisions: [
          "allow_read",
          "draft_only",
          "review_required",
          "shadow_required",
          "block",
        ],
        researchBasis: [
          "causal_rag",
          "causal_counterfactual_rag",
          "counterfactual_benchmark",
          "causal_planning",
          "causal_memory_intervention",
          "structural_causal_model",
          "resilience_engineering",
          "systems_theory",
        ],
        hardStops: [
          "correlation_as_causation",
          "retrieved_relation_as_action_permission",
          "missing_counterfactual_check",
          "missing_adverse_outcome",
          "missing_blast_radius",
          "missing_observability",
          "state_change_without_rollback",
          "physical_action_without_human_protocol",
          "training_without_consent_or_delete_path",
          "multi_agent_write_without_ordered_handoff",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyAssuranceCase = path.join(dir, superOntologyAssuranceCaseFile);
    if (!fs.existsSync(superOntologyAssuranceCase)) {
      fs.writeFileSync(superOntologyAssuranceCase, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-assurance-case",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "evidence_linked_claim_required",
        claimTypes: [
          "scope_boundary",
          "source_provenance",
          "knowledge_integrity",
          "memory_safety",
          "action_safety",
          "task_coverage",
          "world_coverage",
          "promotion_safety",
          "sync_integrity",
          "red_team_reporting",
          "rejected_overclaim",
        ],
        evidenceKinds: [
          "schema_check",
          "fixture_check",
          "public_safety_check",
          "typecheck",
          "build",
          "sync_check",
          "shadow_replay",
          "canary_replay",
          "rollback_drill",
          "constraint_validation",
          "provenance_standard",
          "official_standard",
          "red_team_report",
          "human_review",
          "rejected_claim",
        ],
        validators: [
          "json_schema",
          "jsonl_fixture_checker",
          "public_safety_scan",
          "typecheck",
          "sync_gate",
          "shadow_canary_replay",
          "rollback_drill",
          "provenance_ledger",
          "constraint_shape",
          "red_team_question_bank",
          "human_review_queue",
        ],
        researchBasis: [
          "assurance_case",
          "argument_graph",
          "compliance_by_construction",
          "w3c_prov",
          "w3c_shacl",
          "nist_ai_rmf_gai_profile",
          "genai_red_team_reporting",
          "llm_kg_construction",
          "ontology_validation",
          "no_free_lunch",
        ],
        hardStops: [
          "unsupported_claim",
          "missing_required_evidence",
          "hidden_missing_evidence",
          "missing_validator",
          "missing_residual_risk",
          "missing_rollback_plan",
          "perfect_or_zero_error_claim",
          "red_team_without_followup",
          "runtime_claim_without_shadow_or_canary",
          "appbridge_source_of_truth_claim",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyKnowledgeHomeostasis = path.join(dir, superOntologyKnowledgeHomeostasisFile);
    if (!fs.existsSync(superOntologyKnowledgeHomeostasis)) {
      fs.writeFileSync(superOntologyKnowledgeHomeostasis, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-knowledge-homeostasis",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "homeostasis_required_before_runtime_or_memory_write",
        signals: [
          "contradiction_rate",
          "stale_claim_age",
          "schema_violation_rate",
          "parser_error_rate",
          "unsupported_claim_rate",
          "repair_backlog",
          "replay_failure_rate",
          "drift_rate",
          "source_freshness",
          "authority_expiry",
          "privacy_incident",
          "promotion_evidence_gap",
          "user_correction_rate",
          "runtime_desync_rate",
        ],
        decisions: [
          "continue",
          "quarantine",
          "degrade_to_read_only",
          "require_review",
          "replay",
          "repair",
          "rollback",
          "block_promotion",
          "retire",
        ],
        requiredParameters: [
          "monitored_artifact",
          "scope_id",
          "surface",
          "signal_type",
          "measurement",
          "severity",
          "affected_contexts",
          "affected_lenses",
          "affected_claims",
          "affected_surfaces",
          "error_budget",
          "control_decision",
          "automation_level",
          "escalation",
          "evidence_refs",
          "rollback_plan",
          "memory_curator_policy",
          "public_export_policy",
        ],
        researchBasis: [
          "shacl_validation",
          "kg_repair_evaluation",
          "ontology_change_propagation",
          "truth_maintenance",
          "data_observability",
          "resilience_engineering",
          "homeostatic_control",
          "w3c_prov",
          "nist_ai_rmf",
          "ai_agent_index",
        ],
        hardStops: [
          "error_budget_overrun_continues",
          "critical_homeostasis_runtime_write",
          "privacy_incident_public_export",
          "appbridge_route_as_source_authority",
          "stale_claim_as_current_truth",
          "parser_error_as_complete_source",
          "missing_homeostasis_evidence",
          "memory_write_without_ticket_or_quarantine",
          "runtime_desync_ignored",
          "literal_perfection_claim",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyAdversarialProvenance = path.join(dir, superOntologyAdversarialProvenanceFile);
    if (!fs.existsSync(superOntologyAdversarialProvenance)) {
      fs.writeFileSync(superOntologyAdversarialProvenance, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-adversarial-provenance",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "zero_trust_provenance_required_before_retrieval_memory_tool_or_public_seed",
        sourceChannels: [
          "upload",
          "web",
          "email",
          "chat",
          "tool_response",
          "connector",
          "memory_recall",
          "public_repo",
          "media_asset",
          "appbridge_route",
          "generated_artifact",
          "dataset",
        ],
        attackVectors: [
          "prompt_injection",
          "instruction_smuggling",
          "data_poisoning",
          "provenance_forgery",
          "citation_spoofing",
          "tool_output_tampering",
          "ocr_hidden_text",
          "cross_context_exfiltration",
          "supply_chain_tampering",
          "memory_poisoning",
          "social_engineering",
          "model_policy_bypass",
          "media_provenance_conflict",
          "stale_trusted_source_replay",
        ],
        trustBoundaries: [
          "untrusted_external",
          "user_private",
          "company_internal",
          "customer_confidential",
          "public_web",
          "runtime_tool",
          "agent_internal",
          "memory_store",
          "release_artifact",
        ],
        instructionPolicies: [
          "treat_as_data_only",
          "strip_instructions",
          "quote_only",
          "sandbox_tool_output",
          "require_signature",
          "require_human_review",
          "block",
        ],
        retrievalPolicies: [
          "exclude_from_retrieval",
          "metadata_only",
          "citation_only",
          "quarantined_candidate",
          "low_trust_retrieval",
          "allow_after_verification",
        ],
        memoryPolicies: [
          "no_memory",
          "quarantine_ticket",
          "redact_then_ticket",
          "supersede_after_review",
          "discard",
        ],
        toolPolicies: [
          "no_tool_use",
          "dry_run_only",
          "allowlisted_read_only",
          "require_human_approval",
          "block_external_effect",
        ],
        promotionDecisions: [
          "allow_read",
          "quarantine",
          "review_required",
          "shadow_required",
          "block",
          "retire_source",
        ],
        requiredParameters: [
          "source_channel",
          "attack_vector",
          "trust_boundary",
          "claimed_authority",
          "observed_artifact",
          "provenance_evidence",
          "integrity_checks",
          "instruction_policy",
          "retrieval_policy",
          "memory_policy",
          "tool_policy",
          "promotion_decision",
          "required_controls",
          "must_not_do",
          "evidence_refs",
          "rollback_plan",
        ],
        researchBasis: [
          "owasp_llm_top10",
          "mitre_atlas",
          "nist_adversarial_ml",
          "slsa_provenance",
          "in_toto_attestation",
          "c2pa_content_credentials",
          "zero_trust_architecture",
          "information_flow_control",
          "adversarial_rag",
          "secure_rag_prompt_injection",
        ],
        hardStops: [
          "prompt_injection_as_instruction",
          "instruction_smuggling_as_policy",
          "poisoned_source_to_memory",
          "forged_provenance_as_trusted_source",
          "spoofed_citation_as_grounded_fact",
          "tool_output_tampering_to_action",
          "hidden_ocr_instruction_as_user_intent",
          "cross_context_exfiltration",
          "unsigned_release_artifact",
          "route_output_as_source_write_authority",
          "stale_trusted_source_replay_as_current_truth",
          "missing_adversarial_provenance_evidence",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyEpistemicCalibration = path.join(dir, superOntologyEpistemicCalibrationFile);
    if (!fs.existsSync(superOntologyEpistemicCalibration)) {
      fs.writeFileSync(superOntologyEpistemicCalibration, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-epistemic-calibration",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "calibrated_uncertainty_required_before_answer_memory_tool_or_public_seed",
        contextTypes: [
          "user_personal",
          "company_internal",
          "customer_confidential",
          "public_web",
          "regulated",
          "scientific",
          "software",
          "finance_compliance",
          "physical",
          "creative",
          "agent_internal",
          "mixed_context",
          "multimodal",
          "appbridge_route",
          "release_surface",
        ],
        claimTypes: [
          "factual_answer",
          "graph_edge",
          "ontology_class",
          "relation_mapping",
          "action_plan",
          "memory_write",
          "tool_action",
          "public_export",
          "legal_or_policy",
          "financial_estimate",
          "scientific_claim",
          "physical_action",
          "creative_generation",
          "route_sync",
          "generated_artifact",
        ],
        uncertaintySources: [
          "missing_evidence",
          "conflicting_sources",
          "low_retrieval_relevance",
          "distribution_shift",
          "ambiguous_intent",
          "insufficient_permissions",
          "temporal_staleness",
          "noisy_ocr",
          "model_disagreement",
          "tool_inconclusive",
          "causal_unknown",
          "private_context_gap",
          "benchmark_gap",
          "low_calibration_support",
          "adversarial_source_uncertain",
          "no_ground_truth",
        ],
        epistemicStates: [
          "known_enough_for_read",
          "partially_supported",
          "contested",
          "underspecified",
          "out_of_distribution",
          "uncalibrated",
          "unknowable_for_now",
        ],
        calibrationSignals: [
          "conformal_set_size",
          "confidence_interval",
          "prediction_set",
          "abstention_score",
          "evidence_coverage",
          "retrieval_entropy",
          "contradiction_score",
          "judge_interval",
          "self_eval_none_of_above",
          "ensemble_disagreement",
          "holdout_error_rate",
          "calibration_error",
          "ood_score",
          "human_feedback_gap",
        ],
        confidenceBands: [
          "calibrated_high",
          "calibrated_medium",
          "calibrated_low",
          "uncalibrated",
          "unknown",
        ],
        riskTiers: ["low", "moderate", "high", "critical"],
        allowedOutputs: [
          "answer_with_caveat",
          "ask_clarifying_question",
          "retrieve_more",
          "cite_only",
          "draft_only",
          "human_review",
          "abstain",
          "block",
          "shadow_replay",
        ],
        requiredParameters: [
          "context_type",
          "claim_type",
          "uncertainty_source",
          "epistemic_state",
          "calibration_signal",
          "confidence_band",
          "risk_tier",
          "allowed_output",
          "required_controls",
          "blocked_shortcuts",
          "evidence_refs",
          "research_basis",
          "memory_policy",
          "tool_policy",
          "public_export_policy",
          "rollback_plan",
        ],
        researchBasis: [
          "conformal_prediction",
          "conformal_risk_control",
          "selective_prediction",
          "abstention_policy",
          "llm_self_evaluation",
          "verbalized_confidence_calibration",
          "rag_uncertainty_benchmark",
          "nist_ai_rmf",
          "ood_detection",
          "human_in_the_loop",
          "calibration_error",
          "uncertainty_alignment",
        ],
        hardStops: [
          "missing_evidence_as_complete_answer",
          "conflicting_sources_as_current_truth",
          "low_retrieval_relevance_as_confident_answer",
          "ambiguous_intent_to_memory_write",
          "distribution_shift_to_financial_estimate",
          "stale_policy_as_current_policy",
          "model_disagreement_as_consensus",
          "noisy_ocr_as_ontology_class",
          "inconclusive_tool_output_to_action",
          "causal_unknown_to_physical_action",
          "benchmark_gap_to_public_release",
          "uncalibrated_route_sync",
          "adversarial_uncertainty_to_graph_edge",
          "wide_judge_interval_to_regulated_answer",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySemanticAlignment = path.join(dir, superOntologySemanticAlignmentFile);
    if (!fs.existsSync(superOntologySemanticAlignment)) {
      fs.writeFileSync(superOntologySemanticAlignment, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-semantic-alignment",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "scoped_candidate_alignment_required_before_graph_memory_or_public_seed",
        sourceContexts: [
          "company_internal",
          "user_personal",
          "customer_confidential",
          "public_web",
          "regulated",
          "scientific",
          "software_schema",
          "finance_compliance",
          "multimodal_ocr",
          "appbridge_route",
          "release_surface",
          "cross_team",
          "legacy_system",
          "mixed_context",
          "generated_artifact",
        ],
        artifactTypes: [
          "glossary",
          "database_schema",
          "spreadsheet",
          "presentation",
          "contract",
          "policy_doc",
          "source_code",
          "ticket",
          "email",
          "pdf",
          "image_ocr",
          "ontology",
          "knowledge_graph",
          "app_route",
          "generated_output",
        ],
        alignmentIntents: [
          "synonym_discovery",
          "schema_column_match",
          "class_alignment",
          "property_alignment",
          "entity_resolution",
          "hierarchy_mapping",
          "relation_mapping",
          "unit_mapping",
          "business_process_mapping",
          "compliance_mapping",
          "source_system_merge",
          "ontology_change",
          "release_sync",
          "memory_merge",
          "no_match_detection",
        ],
        candidateRelations: [
          "exact_match",
          "close_match",
          "broad_match",
          "narrow_match",
          "related_match",
          "equivalent_class",
          "equivalent_property",
          "same_individual",
          "synonym",
          "no_match",
          "conflict",
        ],
        alignmentScopes: [
          "local_task",
          "project",
          "team",
          "company",
          "customer",
          "regulated_domain",
          "public_export",
          "appbridge_route",
          "release_surface",
        ],
        ambiguityTypes: [
          "homonym",
          "synonym",
          "polysemy",
          "abbreviation",
          "language_variant",
          "unit_mismatch",
          "temporal_version",
          "scope_collision",
          "granularity_mismatch",
          "relation_direction_unknown",
          "entity_class_confusion",
          "ocr_noise",
          "source_conflict",
          "generated_label",
          "missing_definition",
        ],
        validationChecks: [
          "candidate_retrieval",
          "bidirectional_check",
          "contradiction_check",
          "disjointness_check",
          "transitivity_check",
          "sample_instance_check",
          "roundtrip_query_check",
          "shacl_validation",
          "owl_consistency",
          "kgcl_diff",
          "human_owner_review",
          "rollback_drill",
          "shadow_replay",
          "relation_direction_check",
          "unit_compatibility",
        ],
        researchBasis: [
          "skos_mapping",
          "owl_reasoning",
          "shacl_validation",
          "kgcl_change_language",
          "llm_schema_matching",
          "retrieval_augmented_ontology_matching",
          "human_in_loop_schema_discovery",
          "schema_rollup_drilldown",
          "entity_resolution",
          "data_contracts",
          "provenance_review",
          "ontology_change_management",
        ],
        hardStops: [
          "same_label_as_same_meaning",
          "embedding_similarity_as_exact_match",
          "close_match_as_transitive_truth",
          "abbreviation_without_owner_glossary",
          "broad_or_narrow_without_direction_check",
          "generated_label_as_ontology_class",
          "ocr_label_as_property_alignment",
          "appbridge_route_as_source_ontology_edit",
          "source_conflict_to_memory_merge",
          "customer_confidential_mapping_to_public_export",
          "release_sync_without_rollback",
          "ontology_change_without_diff",
          "same_individual_without_stable_identifier",
          "unit_label_without_unit_compatibility",
          "no_match_promoted_to_weak_match",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyResilienceControl = path.join(dir, superOntologyResilienceControlFile);
    if (!fs.existsSync(superOntologyResilienceControl)) {
      fs.writeFileSync(superOntologyResilienceControl, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-resilience-control",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "degrade_authority_before_runtime_graph_memory_tool_or_sync_write",
        controlLoopPhases: ["monitor", "analyze", "plan", "execute", "learn", "sync"],
        operatingModes: [
          "nominal",
          "watch",
          "degraded",
          "shadow_only",
          "read_only",
          "quarantine",
          "owner_review",
          "rollback",
          "emergency_stop",
        ],
        degradationSignals: [
          "contradiction_spike",
          "validator_disagreement",
          "retrieval_drift",
          "semantic_alignment_regression",
          "provenance_gap",
          "memory_curator_backlog",
          "tool_error_spike",
          "user_correction_spike",
          "unknown_task_family",
          "context_flow_violation",
          "causal_impact_uncertain",
          "sync_drift",
          "model_judge_divergence",
          "latency_budget_overrun",
          "replay_failure",
          "permission_boundary_unknown",
          "sensor_or_parser_degraded",
          "external_side_effect_detected",
        ],
        hazardTypes: [
          "unsafe_control_action",
          "missing_feedback",
          "delayed_feedback",
          "wrong_mode",
          "authority_escalation",
          "control_loop_oscillation",
          "stale_process_model",
          "degraded_sensor",
          "conflicting_controller",
          "runaway_repair",
          "unbounded_retry",
          "brittle_threshold",
          "silent_fail_open",
          "operator_overload",
        ],
        controlDecisions: [
          "continue",
          "observe",
          "ask_clarify",
          "retrieve_more",
          "shadow_only",
          "read_only",
          "quarantine",
          "require_owner_review",
          "rollback",
          "emergency_stop",
        ],
        requiredFeedback: [
          "fresh_source_retrieval",
          "validator_matrix",
          "curator_queue_depth",
          "tool_trace",
          "source_identity_check",
          "contextual_flow_replay",
          "causal_impact_review",
          "semantic_alignment_replay",
          "epistemic_calibration_replay",
          "architecture_sync_diff",
          "rollback_confirmation",
          "owner_review_ticket",
        ],
        researchBasis: [
          "mape_k",
          "self_adaptive_systems",
          "stpa",
          "unsafe_control_actions",
          "robustness_analysis",
          "degradation_state_analysis",
          "agentic_self_awareness",
          "adaptive_hierarchical_kg",
          "resilience_engineering",
          "cybernetics_feedback",
          "incident_command",
          "sociotechnical_escalation",
        ],
        hardStops: [
          "validator_disagreement_to_graph_write",
          "retrieval_drift_to_current_answer",
          "semantic_regression_to_memory_merge",
          "provenance_gap_to_tool_authority",
          "curator_backlog_to_direct_memory_write",
          "tool_error_spike_to_unbounded_retry",
          "unknown_task_to_normal_execution",
          "context_flow_violation_to_public_export",
          "sync_drift_to_release_surface",
          "judge_divergence_to_regulated_answer",
          "degraded_parser_to_ontology_class",
          "rollback_failure_to_runtime_promotion",
          "emergency_stop_bypass_by_route",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyInvariantVerification = path.join(dir, superOntologyInvariantVerificationFile);
    if (!fs.existsSync(superOntologyInvariantVerification)) {
      fs.writeFileSync(superOntologyInvariantVerification, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-invariant-verification",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "runtime_monitor_required_before_graph_memory_tool_route_release_or_public_write",
        eventStreams: [
          "source_intake",
          "evidence_packet",
          "belief_update",
          "semantic_alignment",
          "resilience_mode",
          "memory_ticket",
          "graph_write",
          "tool_call",
          "public_export",
          "route_sync",
          "release_seed",
          "rollback",
          "emergency_stop",
        ],
        invariantTypes: [
          "safety",
          "liveness",
          "ordering",
          "separation",
          "cardinality",
          "idempotency",
          "provenance",
          "authority",
          "consent",
          "rollback",
          "audit",
          "determinism",
        ],
        temporalOperators: ["always", "never", "eventually", "until", "before", "after", "within", "once"],
        monitors: [
          "json_schema",
          "event_sequence",
          "state_machine",
          "temporal_logic",
          "property_test",
          "shadow_replay",
          "model_check",
          "sync_check",
          "curator_ticket_audit",
          "human_owner_review",
        ],
        violationActions: [
          "block",
          "reject",
          "quarantine",
          "rollback",
          "emergency_stop",
          "ask_clarify",
          "review_required",
          "shadow_only",
        ],
        researchBasis: [
          "runtime_verification",
          "temporal_logic",
          "model_checking",
          "contract_based_design",
          "assume_guarantee_contracts",
          "finite_state_monitor",
          "agent_runtime_monitoring",
          "formal_methods_for_planning",
          "formal_skill_verification",
          "multi_agent_safety_invariants",
          "memory_safety_invariants",
          "audit_log_invariants",
        ],
        hardStops: [
          "memory_write_without_ticket_invariant",
          "graph_write_without_evidence_invariant",
          "tool_action_without_authority_invariant",
          "public_export_without_flow_invariant",
          "route_sync_without_source_contract_invariant",
          "rollback_not_observed_after_violation",
          "emergency_stop_transition_bypassed",
          "unordered_multi_agent_write",
          "non_idempotent_replay_mutation",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyObservabilityTelemetry = path.join(dir, superOntologyObservabilityTelemetryFile);
    if (!fs.existsSync(superOntologyObservabilityTelemetry)) {
      fs.writeFileSync(superOntologyObservabilityTelemetry, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-observability-telemetry",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "observability_required_before_runtime_graph_memory_tool_route_release_or_public_write",
        eventTypes: [
          "source_intake",
          "evidence_packet",
          "belief_update",
          "graph_write",
          "memory_ticket",
          "tool_action",
          "public_export",
          "route_sync",
          "release_seed",
          "repair_event",
          "rollback",
          "emergency_stop",
        ],
        failureModes: [
          "missing_trace_id",
          "dropped_span",
          "partial_log",
          "stale_metric",
          "redaction_gap",
          "audit_sink_down",
          "clock_skew",
          "sample_bias",
          "alert_suppression",
          "replay_not_recorded",
          "repair_without_snapshot",
          "cross_surface_correlation_missing",
        ],
        requiredTelemetry: [
          "trace_id",
          "span_id",
          "parent_span_id",
          "correlation_id",
          "source_ref",
          "evidence_ref",
          "actor_role",
          "authority_state",
          "decision_state",
          "risk_tier",
          "redaction_policy",
          "retention_policy",
          "clock_source",
          "checksum",
          "before_snapshot_ref",
          "after_snapshot_ref",
          "rollback_ref",
          "alert_ref",
          "audit_sink_ref",
          "sample_size",
        ],
        traceStates: ["complete", "partial", "missing", "corrupted", "untrusted", "redacted"],
        auditChannels: [
          "jsonl_ledger",
          "otel_trace",
          "memory_ticket",
          "sync_log",
          "release_log",
          "tool_receipt",
          "owner_review_queue",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "shadow_required",
          "sync_review_required",
          "quarantine",
          "rollback",
          "emergency_stop",
          "blocked",
        ],
        researchBasis: [
          "agent_execution_provenance",
          "agent_observability_telemetry",
          "trace_reasoning_benchmark",
          "opentelemetry",
          "w3c_trace_context",
          "sre_monitoring",
          "nist_ai_rmf_gai_profile",
          "runtime_assurance",
          "audit_log_invariants",
          "data_observability",
        ],
        hardStops: [
          "missing_observability_telemetry_contract",
          "write_without_trace_id",
          "memory_ticket_without_span_lineage",
          "tool_action_without_audit_receipt",
          "public_export_with_stale_metric",
          "route_sync_without_correlation_id",
          "release_seed_when_audit_sink_down",
          "redaction_missing_in_telemetry",
          "metric_green_without_sample_size",
          "alert_suppressed_during_degraded_mode",
          "shadow_replay_not_recorded",
          "repair_without_before_after_snapshot",
          "rollback_without_observed_event",
          "unobservable_runtime_write",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyObjectiveProxyValidity = path.join(dir, superOntologyObjectiveProxyValidityFile);
    if (!fs.existsSync(superOntologyObjectiveProxyValidity)) {
      fs.writeFileSync(superOntologyObjectiveProxyValidity, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-objective-proxy-validity",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "construct_validity_required_before_metric_driven_runtime_graph_memory_tool_route_release_or_public_write",
        constructs: [
          "user_value",
          "business_outcome",
          "safety",
          "quality",
          "truthfulness",
          "trust",
          "learning",
          "wellbeing",
          "compliance",
          "fairness",
          "reliability",
          "maintainability",
          "environmental_impact",
          "financial_return",
          "operational_efficiency",
          "reputation",
        ],
        proxyMetrics: [
          "approval_rate",
          "open_rate",
          "click_rate",
          "benchmark_score",
          "test_pass_rate",
          "self_judge_score",
          "ontology_edge_count",
          "memory_recall_count",
          "short_term_profit",
          "cost_per_execution",
          "green_dashboard_percentage",
          "reward_score_delta",
        ],
        validityGaps: [
          "construct_underdefined",
          "proxy_not_construct",
          "proxy_overoptimized",
          "benchmark_contamination",
          "reward_tampering",
          "metric_gaming",
          "stakeholder_harm_hidden",
          "short_term_metric_long_term_harm",
          "sample_not_representative",
          "measurement_noninvariance",
          "label_leakage",
          "evaluator_conflict",
          "target_shift",
        ],
        goodhartModes: [
          "regressional",
          "extremal",
          "causal",
          "adversarial",
          "campbell_law",
          "reward_hacking",
          "proxy_gaming",
          "benchmark_gaming",
        ],
        requiredValidityEvidence: [
          "construct_definition",
          "stakeholder_map",
          "countermetric",
          "negative_control",
          "holdout_distribution",
          "baseline_comparison",
          "item_level_analysis",
          "causal_path",
          "gaming_probe",
          "benchmark_provenance",
          "human_owner_review",
          "longitudinal_check",
          "measurement_invariance_check",
          "sample_size",
          "error_bar",
          "rollback_plan",
        ],
        countermetrics: [
          "harm_rate",
          "complaint_rate",
          "long_term_retention",
          "quality_review_score",
          "fairness_delta",
          "safety_incident_rate",
          "source_grounding_rate",
          "maintenance_burden",
          "cost_per_success",
          "reversal_rate",
          "learning_transfer",
          "user_trust_signal",
          "denominator",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "shadow_required",
          "human_review_required",
          "redesign_metric",
          "quarantine",
          "block_optimization",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "goodharts_law",
          "campbells_law",
          "construct_validity",
          "psychometrics",
          "measurement_theory",
          "reward_hacking",
          "specification_gaming",
          "benchmark_validity",
          "ai_risk_management",
          "sociotechnical_evaluation",
          "causal_inference",
          "program_evaluation",
        ],
        hardStops: [
          "missing_objective_proxy_validity_contract",
          "metric_improvement_as_goal_completion",
          "approval_rate_as_trust",
          "benchmark_score_as_reliability",
          "test_pass_rate_as_maintainability",
          "open_rate_as_customer_value",
          "self_judge_score_as_truth",
          "edge_count_as_knowledge_quality",
          "short_term_profit_as_compliance",
          "cost_per_execution_as_sustainability",
          "reward_score_as_quality",
          "label_leakage_as_accuracy",
          "green_dashboard_as_health",
          "proxy_optimization_without_countermetric",
          "optimization_without_stakeholder_map",
          "metric_gaming_without_probe",
          "reward_tampering_to_promotion",
          "construct_underdefined_to_runtime_write",
          "unvalidated_proxy_to_public_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyStakeholderPreferenceGovernance = path.join(
      dir,
      superOntologyStakeholderPreferenceGovernanceFile,
    );
    if (!fs.existsSync(superOntologyStakeholderPreferenceGovernance)) {
      fs.writeFileSync(superOntologyStakeholderPreferenceGovernance, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-stakeholder-preference-governance",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "stakeholder_preference_governance_required_before_multi_party_runtime_graph_memory_tool_route_release_or_public_write",
        stakeholderRoles: [
          "individual_user",
          "project_owner",
          "team_member",
          "manager",
          "executive",
          "customer",
          "customer_end_user",
          "legal_compliance",
          "security_privacy",
          "sales_marketing",
          "operations_support",
          "finance_procurement",
          "public_audience",
          "regulator",
          "minority_or_vulnerable_group",
          "future_maintainer",
          "student",
          "teacher",
          "parent_guardian",
          "patient_or_caregiver",
        ],
        preferenceSignals: [
          "explicit_instruction",
          "approval_vote",
          "ranking",
          "policy_requirement",
          "legal_obligation",
          "contractual_constraint",
          "customer_feedback",
          "complaint",
          "usage_behavior",
          "accessibility_need",
          "safety_objection",
          "privacy_preference",
          "quality_review",
          "maintenance_burden",
          "cost_constraint",
          "minority_report",
          "professional_standard",
          "recency_check",
        ],
        conflictTypes: [
          "stakeholder_conflict",
          "value_tradeoff",
          "rights_constraint",
          "consent_boundary",
          "power_asymmetry",
          "minority_harm",
          "short_term_long_term_conflict",
          "private_public_tension",
          "role_scope_collision",
          "regulatory_conflict",
          "resource_allocation_conflict",
          "strategic_misreporting",
          "preference_drift",
          "unrepresented_party",
        ],
        aggregationRules: [
          "consent_required",
          "veto_for_rights",
          "owner_review",
          "policy_precedence",
          "weighted_deliberation",
          "ranked_choice",
          "majority_with_veto",
          "pareto_screen",
          "minimax_regret",
          "rawlsian_priority",
          "human_governance_board",
          "case_by_case_review",
          "no_aggregation_allowed",
        ],
        requiredGovernanceEvidence: [
          "stakeholder_map",
          "preference_source",
          "scope_of_authority",
          "affected_party_analysis",
          "aggregation_rule",
          "rights_constraint_check",
          "minority_report",
          "dissent_capture",
          "consent_record",
          "appeal_path",
          "rollback_plan",
          "review_owner",
          "tradeoff_rationale",
          "public_private_boundary",
          "recency_check",
          "policy_or_contract_ref",
          "manipulation_probe",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "human_review_required",
          "policy_review_required",
          "consent_required",
          "redesign_tradeoff",
          "quarantine",
          "block_write",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "social_choice_theory",
          "arrow_impossibility",
          "gibbard_satterthwaite",
          "pluralistic_alignment",
          "multi_stakeholder_alignment",
          "deliberative_democracy",
          "stakeholder_theory",
          "value_sensitive_design",
          "participatory_design",
          "procedural_justice",
          "ai_risk_management",
          "human_subjects_ethics",
          "governance_risk_compliance",
        ],
        hardStops: [
          "missing_stakeholder_preference_governance_contract",
          "single_stakeholder_preference_as_global_goal",
          "owner_preference_as_all_stakeholders",
          "majority_preference_as_rights_clearance",
          "average_utility_over_protected_constraint",
          "hidden_affected_party",
          "missing_appeal_path",
          "missing_dissent_capture",
          "strategic_preference_report_as_truth",
          "preference_aggregation_without_rule",
          "preference_conflict_to_runtime_write",
          "consent_absent_to_personalization",
          "minority_harm_hidden_by_aggregate",
          "irreversible_action_without_stakeholder_review",
          "private_preference_to_public_release",
          "cross_context_preference_reuse_without_scope",
          "role_power_as_legitimacy",
          "arrow_impossibility_ignored",
          "manipulable_vote_as_stable_preference",
          "stakeholder_map_missing_for_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyNormativeAuthorityDrift = path.join(
      dir,
      superOntologyNormativeAuthorityDriftFile,
    );
    if (!fs.existsSync(superOntologyNormativeAuthorityDrift)) {
      fs.writeFileSync(superOntologyNormativeAuthorityDrift, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-normative-authority-drift",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "normative_authority_required_before_policy_legal_compliance_contract_license_consent_or_runtime_write",
        authorityTypes: [
          "law",
          "regulation",
          "contract",
          "terms_of_service",
          "internal_policy",
          "security_policy",
          "privacy_policy",
          "data_retention_policy",
          "license",
          "standard",
          "professional_guideline",
          "customer_commitment",
          "board_decision",
          "manager_directive",
          "emergency_exception",
        ],
        scopeDimensions: [
          "jurisdiction",
          "effective_date",
          "expiry_date",
          "organization",
          "workspace",
          "role",
          "customer_segment",
          "data_category",
          "system_surface",
          "action_type",
          "retention_period",
          "transfer_region",
          "license_scope",
          "exception_scope",
        ],
        conflictTypes: [
          "stale_authority",
          "wrong_jurisdiction",
          "draft_vs_enforced",
          "superseded_rule",
          "authority_conflict",
          "exception_misuse",
          "translation_mismatch",
          "summary_vs_primary_source",
          "role_authority_gap",
          "license_conflict",
          "retention_conflict",
          "cross_border_conflict",
          "emergency_override",
          "professional_boundary",
        ],
        effectiveTimeStates: [
          "current",
          "stale",
          "future_effective",
          "expired",
          "draft",
          "superseded",
          "unknown",
          "exception_active",
          "emergency_exception",
        ],
        jurisdictionStates: [
          "in_scope",
          "out_of_scope",
          "mixed",
          "unknown",
          "cross_border",
          "local_only",
          "global_claim_unverified",
        ],
        authorityHierarchyRules: [
          "primary_source_precedence",
          "newer_version_precedence",
          "contract_clause_precedence",
          "stricter_rule_precedence",
          "local_law_precedence",
          "internal_policy_after_law",
          "exception_requires_owner_expiry",
          "human_legal_review",
          "no_precedence_available",
        ],
        requiredAuthorityEvidence: [
          "primary_source_ref",
          "effective_date",
          "version_id",
          "jurisdiction_scope",
          "authority_owner",
          "precedence_rule",
          "exception_owner",
          "expiry_or_review_date",
          "policy_citation",
          "contract_clause",
          "license_text",
          "retention_rule",
          "transfer_rule",
          "review_owner",
          "rollback_plan",
          "audit_trail",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "human_review_required",
          "policy_review_required",
          "legal_review_required",
          "security_review_required",
          "quarantine",
          "block_write",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "legal_informatics",
          "governance_risk_compliance",
          "policy_as_code",
          "compliance_automation",
          "temporal_knowledge_graphs",
          "deontic_logic",
          "defeasible_reasoning",
          "regulatory_change_management",
          "records_management",
          "data_protection",
          "software_supply_chain_governance",
          "provenance_standards",
          "rights_expression_language",
          "ai_management_systems",
        ],
        hardStops: [
          "missing_normative_authority_drift_contract",
          "stale_policy_as_current_rule",
          "wrong_jurisdiction_as_valid_policy",
          "draft_policy_as_enforced_rule",
          "superseded_contract_as_current_authority",
          "terms_of_service_without_effective_date",
          "local_custom_as_global_policy",
          "internal_preference_as_legal_requirement",
          "policy_exception_without_owner",
          "conflicting_authorities_without_precedence",
          "regulation_summary_as_primary_law",
          "compliance_claim_without_citation",
          "policy_translation_as_authoritative_text",
          "expired_consent_as_current_permission",
          "missing_retention_or_deletion_rule",
          "cross_border_transfer_without_jurisdiction",
          "licensing_constraint_ignored",
          "audit_requirement_missing_before_release",
          "emergency_exception_without_expiry",
          "legal_advice_without_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySideEffectContainment = path.join(
      dir,
      superOntologySideEffectContainmentFile,
    );
    if (!fs.existsSync(superOntologySideEffectContainment)) {
      fs.writeFileSync(superOntologySideEffectContainment, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-side-effect-containment",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "containment_required_before_external_file_finance_release_message_route_memory_training_or_physical_action",
        sideEffectClasses: [
          "file_mutation",
          "external_message",
          "payment_or_finance",
          "customer_record_update",
          "public_release",
          "account_permission_change",
          "data_transfer",
          "memory_write",
          "training_update",
          "code_execution",
          "physical_actuation",
          "scheduled_job",
          "multi_system_workflow",
          "legal_or_compliance_commitment",
        ],
        actionSurfaces: [
          "local_file_system",
          "email_or_chat",
          "crm_or_customer_system",
          "payment_or_procurement",
          "public_web_or_social",
          "release_pipeline",
          "cloud_admin",
          "database_write",
          "memory_curator",
          "training_pipeline",
          "physical_or_sensor",
          "appbridge_route",
          "hosted_connector",
          "shell_or_code_runner",
        ],
        reversibilityStates: [
          "read_only",
          "preview_only",
          "reversible",
          "compensable",
          "retryable_after_pivot",
          "irreversible",
          "unknown",
        ],
        transactionBoundaries: [
          "single_local_transaction",
          "saga_compensating_transaction",
          "external_api_commit",
          "human_approval_boundary",
          "two_phase_commit_required",
          "no_transaction_boundary",
          "scheduled_future_commit",
          "physical_world_boundary",
        ],
        idempotencyStates: [
          "idempotent_key_present",
          "idempotent_by_design",
          "non_idempotent",
          "duplicate_risk_unknown",
          "retry_guard_missing",
          "replay_safe_dry_run",
        ],
        blastRadii: [
          "user_local",
          "workspace",
          "customer",
          "organization",
          "public",
          "financial",
          "legal_compliance",
          "physical_safety",
          "cross_system",
          "cross_border_data",
        ],
        externalCommitStates: [
          "not_committed",
          "dry_run_only",
          "pending_human_commit",
          "committed_with_receipt",
          "partial_commit",
          "ambiguous_commit",
          "scheduled_commit",
          "irreversible_commit",
        ],
        requiredContainmentEvidence: [
          "user_intent_span",
          "tool_scope",
          "auth_scope",
          "idempotency_key",
          "dry_run_receipt",
          "preflight_diff",
          "approval_receipt",
          "transaction_log",
          "compensation_action",
          "rollback_snapshot",
          "cancellation_path",
          "rate_limit_budget",
          "blast_radius_bound",
          "external_commit_receipt",
          "audit_trace",
          "policy_gate_ref",
          "memory_ticket_ref",
          "safety_interlock",
          "operator_owner",
          "post_action_verification",
        ],
        decisions: [
          "allow_read",
          "allow_dry_run",
          "prepare_only",
          "ask_clarify",
          "human_approval_required",
          "policy_review_required",
          "security_review_required",
          "containment_required",
          "block_execute",
          "rollback",
          "compensate",
          "emergency_stop",
        ],
        researchBasis: [
          "excessive_agency",
          "least_privilege",
          "systems_security_engineering",
          "saga_pattern",
          "compensating_transaction",
          "idempotent_workflow",
          "human_in_the_loop",
          "complete_mediation",
          "rate_limiting",
          "auditability",
          "safety_engineering",
          "transaction_processing",
          "secure_agent_guardrails",
          "disaster_recovery",
        ],
        hardStops: [
          "missing_side_effect_containment_contract",
          "read_permission_as_write_permission",
          "preview_as_send",
          "dry_run_result_as_committed",
          "non_idempotent_retry_to_external_action",
          "irreversible_action_without_human_approval",
          "deletion_without_recovery_plan",
          "payment_without_idempotency_key",
          "customer_message_without_review",
          "release_without_rollback",
          "connector_write_without_scope",
          "cross_tool_chain_without_transaction",
          "compensation_plan_missing",
          "blast_radius_unknown",
          "idempotency_key_missing",
          "external_commit_without_receipt",
          "partial_failure_without_saga_state",
          "physical_action_without_safety_interlock",
          "scheduled_action_without_cancellation",
          "side_effect_logging_missing",
          "hosted_tool_without_local_side_effect_wrapper",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySourceLineageVersion = path.join(
      dir,
      superOntologySourceLineageVersionFile,
    );
    if (!fs.existsSync(superOntologySourceLineageVersion)) {
      fs.writeFileSync(superOntologySourceLineageVersion, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-source-lineage-version",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "lineage_required_before_graph_memory_public_training_tool_or_route_authority",
        documentFamilies: [
          "policy",
          "contract",
          "sales_deck",
          "spreadsheet",
          "hwp_doc",
          "pdf_export",
          "email_attachment",
          "crm_record",
          "code_artifact",
          "dataset",
          "model_artifact",
          "sensor_log",
          "meeting_notes",
          "public_web_page",
        ],
        sourceArtifactTypes: [
          "primary_document",
          "derived_document",
          "exported_pdf",
          "spreadsheet_workbook",
          "sheet_tab",
          "email_message",
          "attachment",
          "connector_record",
          "database_snapshot",
          "web_snapshot",
          "chunk",
          "embedding_vector",
          "summary",
          "translation",
          "redacted_copy",
          "dataset_snapshot",
          "model_checkpoint",
          "sensor_batch",
        ],
        requiredLineageEvidence: [
          "source_uri",
          "source_checksum",
          "content_hash",
          "version_id",
          "revision_id",
          "effective_date",
          "capture_time",
          "transformation_log",
          "derivation_chain",
          "parent_artifact_ref",
          "primary_source_ref",
          "authority_owner",
          "approval_record",
          "deprecation_record",
          "supersedes_ref",
          "checksum_or_signature",
          "connector_snapshot_id",
          "parser_version",
          "chunk_span",
          "memory_ticket_ref",
          "audit_trace",
          "rollback_snapshot",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "lineage_repair_required",
          "source_owner_review_required",
          "deprecate",
          "quarantine",
          "block_graph_write",
          "block_memory_write",
          "block_public_export",
          "rollback",
        ],
        hardStops: [
          "missing_source_lineage_version_contract",
          "filename_as_version",
          "latest_folder_as_current_source",
          "pdf_export_as_primary_source",
          "summary_as_primary_source",
          "ocr_text_without_source_span",
          "spreadsheet_sheet_without_workbook_revision",
          "email_attachment_without_message_context",
          "duplicate_title_as_same_artifact",
          "checksum_missing_for_authoritative_source",
          "stale_cache_as_current_record",
          "connector_snapshot_without_capture_time",
          "transitive_derivation_as_primary_source",
          "merged_record_without_parent_refs",
          "redacted_copy_as_complete_source",
          "translation_as_authoritative_source",
          "chunk_without_source_span",
          "embedding_hit_without_artifact_version",
          "memory_fact_without_lineage",
          "public_export_without_lineage_evidence",
          "training_example_without_dataset_version",
          "graph_edge_without_derivation_chain",
          "superseded_source_to_runtime_write",
          "lineage_cycle_unresolved",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyEntityIdentityResolution = path.join(
      dir,
      superOntologyEntityIdentityResolutionFile,
    );
    if (!fs.existsSync(superOntologyEntityIdentityResolution)) {
      fs.writeFileSync(superOntologyEntityIdentityResolution, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-entity-identity-resolution",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "identity_evidence_required_before_canonical_graph_memory_public_training_tool_or_route_authority",
        entityFamilies: [
          "person",
          "company",
          "customer_account",
          "vendor",
          "product",
          "project",
          "model",
          "location",
          "team",
          "patient_or_user",
          "device",
          "document",
        ],
        mentionArtifactTypes: [
          "name_string",
          "alias",
          "email_address",
          "phone_number",
          "domain",
          "crm_id",
          "employee_id",
          "spreadsheet_row",
          "external_uri",
          "embedding_cluster",
          "llm_generated_canonical",
          "redacted_identifier",
        ],
        requiredIdentityEvidence: [
          "canonical_entity_id",
          "source_system_id",
          "entity_type",
          "source_uri",
          "source_span",
          "negative_evidence",
          "disambiguating_attributes",
          "temporal_validity",
          "tenant_or_context_id",
          "privacy_basis",
          "owner_review",
          "merge_policy",
          "split_policy",
          "tombstone_record",
          "audit_trace",
          "rollback_snapshot",
        ],
        hardStops: [
          "missing_entity_identity_resolution_contract",
          "name_as_identity",
          "email_domain_as_company",
          "fuzzy_match_as_merge",
          "embedding_cluster_as_identity",
          "llm_canonical_name_as_id",
          "crm_id_cross_tenant_merge",
          "recycled_employee_id_as_same_person",
          "redacted_name_as_public_identity",
          "stale_alias_as_current_entity",
          "relationship_edge_without_identity_evidence",
          "memory_note_as_identity_authority",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyTemporalStateTransition = path.join(
      dir,
      superOntologyTemporalStateTransitionFile,
    );
    if (!fs.existsSync(superOntologyTemporalStateTransition)) {
      fs.writeFileSync(superOntologyTemporalStateTransition, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-temporal-state-transition",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "temporal_state_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_or_customer_authority",
        stateSubjectFamilies: [
          "person",
          "company",
          "customer_account",
          "vendor",
          "product",
          "project",
          "policy",
          "contract",
          "dataset",
          "model",
          "document",
          "workflow",
          "task",
          "asset",
          "device",
          "payment",
          "permission",
          "release",
          "memory_fact",
          "graph_edge",
        ],
        eventArtifactTypes: [
          "timestamp",
          "valid_interval",
          "transaction_record",
          "event_log_entry",
          "state_snapshot",
          "spreadsheet_row",
          "document_revision",
          "calendar_event",
          "webhook_event",
          "connector_delta",
          "message_thread",
          "scheduled_job",
          "audit_log",
          "migration_batch",
          "derived_projection",
          "llm_summary",
          "memory_note",
          "graph_edge",
        ],
        requiredTemporalEvidence: [
          "valid_time",
          "transaction_time",
          "event_id",
          "event_sequence",
          "source_uri",
          "source_span",
          "pre_state",
          "post_state",
          "transition_guard",
          "idempotency_key",
          "replay_log",
          "rollback_snapshot",
          "projection_version",
          "owner_review",
          "audit_trace",
          "tombstone_record",
          "scheduler_receipt",
          "post_action_verification",
        ],
        hardStops: [
          "missing_temporal_state_transition_contract",
          "current_snapshot_as_truth",
          "missing_valid_time",
          "missing_transaction_time",
          "local_timestamp_as_global_order",
          "spreadsheet_order_as_event_order",
          "llm_summary_as_event_log",
          "late_event_ignored",
          "retroactive_correction_without_tx_history",
          "future_effective_as_current",
          "expired_state_as_active",
          "deleted_state_without_tombstone",
          "non_idempotent_replay",
          "materialized_view_as_source_of_truth",
          "projection_without_version",
          "recurring_event_without_rule",
          "timezone_free_deadline",
          "stale_cache_as_current",
          "state_transition_without_precondition",
          "partial_failure_as_success",
          "clock_skew_as_fact",
          "scheduled_job_without_receipt",
          "memory_fact_without_validity_interval",
          "graph_edge_without_temporal_bounds",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyCapabilityDelegationAuthority = path.join(
      dir,
      superOntologyCapabilityDelegationAuthorityFile,
    );
    if (!fs.existsSync(superOntologyCapabilityDelegationAuthority)) {
      fs.writeFileSync(superOntologyCapabilityDelegationAuthority, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-capability-delegation-authority",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "capability_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_customer_or_physical_authority",
        principalTypes: [
          "human_user",
          "delegated_agent",
          "child_agent",
          "service_account",
          "oauth_client",
          "api_key_holder",
          "mcp_tool",
          "scheduler",
          "workflow_runner",
          "enterprise_connector",
          "browser_session",
          "unknown_principal",
        ],
        capabilityArtifactTypes: [
          "role",
          "group_membership",
          "oauth_scope",
          "api_key",
          "service_account_key",
          "session_cookie",
          "tool_schema",
          "policy_decision",
          "approval_record",
          "delegation_token",
          "agent_identity_token",
          "signed_attestation",
          "capability_token",
          "cached_authorization_decision",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "scheduled_authority",
          "permission_authority",
          "financial_authority",
          "release_authority",
          "customer_output_authority",
          "physical_authority",
        ],
        requiredCapabilityEvidence: [
          "actor_identity",
          "agent_identity",
          "user_intent",
          "task_id",
          "workflow_step",
          "delegation_chain",
          "parent_capability",
          "policy_decision",
          "policy_version",
          "resource_id",
          "operation",
          "scope",
          "purpose",
          "caveat_set",
          "consent_record",
          "owner_approval",
          "time_bound",
          "recipient_bound",
          "environment_context",
          "proof_of_possession",
          "revocation_check",
          "audit_trace",
          "rollback_snapshot",
          "post_action_verification",
        ],
        hardStops: [
          "role_as_capability",
          "oauth_scope_as_task_permission",
          "api_key_as_actor",
          "read_access_as_write_authority",
          "parent_agent_unbounded_delegation",
          "delegation_chain_missing",
          "purpose_mismatch_authority",
          "capability_without_caveats",
          "stale_capability_token_as_current",
          "cross_context_capability_reuse",
          "capability_escalation_by_tool_choice",
          "subagent_exceeds_parent_authority",
          "human_consent_reused_for_new_purpose",
          "permission_prompt_as_policy",
          "tool_schema_as_authorization",
          "cached_auth_decision_without_fresh_context",
          "break_glass_without_expiry",
          "admin_role_as_all_actions",
          "shared_service_account_as_identity",
          "task_goal_as_permission",
          "hidden_tool_call_without_policy_decision",
        ],
        researchBasis: [
          "least_privilege",
          "zero_trust",
          "abac",
          "rebac",
          "capability_security",
          "macaroons",
          "zanzibar",
          "oauth_oidc",
          "oidc_agents",
          "agentic_jwt",
          "privilege_control",
          "contextual_integrity",
          "policy_as_code",
          "proof_of_possession",
          "auditability",
          "delegation_logic",
          "threat_modeling",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyPrivacyConfidentialityBoundary = path.join(
      dir,
      superOntologyPrivacyConfidentialityBoundaryFile,
    );
    if (!fs.existsSync(superOntologyPrivacyConfidentialityBoundary)) {
      fs.writeFileSync(superOntologyPrivacyConfidentialityBoundary, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-privacy-confidentiality-boundary",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "privacy_boundary_evidence_required_before_graph_memory_public_training_tool_route_customer_output_personalization_retrieval_or_analytics_authority",
        dataClassifications: [
          "public",
          "internal",
          "confidential",
          "restricted",
          "regulated_pii",
          "sensitive_pii",
          "credentials_or_secret",
          "financial",
          "health",
          "legal_privileged",
          "biometric",
          "location",
          "behavioral_profile",
          "inferred_sensitive",
          "unknown",
        ],
        boundarySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "customer_output_authority",
          "personalization_authority",
          "retrieval_authority",
          "analytics_authority",
        ],
        requiredPrivacyEvidence: [
          "data_classification",
          "sensitivity_label",
          "source_span",
          "data_subject_category",
          "controller_or_owner",
          "processing_purpose",
          "legal_basis_or_owner_approval",
          "consent_or_confidentiality_basis",
          "audience",
          "minimization_reason",
          "redaction_policy",
          "retention_policy",
          "deletion_or_legal_hold_state",
          "transfer_basis",
          "model_trust_tier",
          "training_allowed_flag",
          "public_disclosure_allowed_flag",
          "access_policy_decision",
          "audit_trace",
          "rollback_snapshot",
          "breach_response_owner",
          "reidentification_risk_assessment",
          "vector_index_policy",
          "memory_write_scope",
        ],
        hardStops: [
          "pii_as_normal_fact",
          "secret_as_graph_label",
          "confidential_deck_as_public_context",
          "consent_missing",
          "legal_basis_missing",
          "purpose_reuse_without_review",
          "training_on_private_material",
          "public_export_without_redaction",
          "retention_expired_memory",
          "data_subject_delete_ignored",
          "cross_tenant_context_bleed",
          "customer_data_as_demo",
          "personal_life_as_company_context",
          "employee_note_as_hr_decision",
          "inferred_sensitive_attribute_public",
          "redacted_text_reidentified",
          "connector_cache_as_allowed_use",
          "screenshot_ocr_without_classification",
          "embedding_of_secret_without_policy",
          "vector_search_leaks_private_neighbors",
          "shared_memory_without_audience_boundary",
          "confidential_source_in_prompt_to_untrusted_model",
          "trade_secret_as_embedding_neighbor",
          "legal_privilege_lost_by_disclosure",
        ],
        researchBasis: [
          "nist_privacy_framework",
          "nist_pii_confidentiality",
          "oecd_privacy_principles",
          "gdpr_principles",
          "contextual_integrity",
          "data_minimization",
          "purpose_limitation",
          "privacy_by_design",
          "information_flow_control",
          "privacy_risk_management",
          "reidentification_risk",
          "secrets_management",
          "records_retention",
          "zero_trust",
          "auditability",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyStrategicIncentiveCompatibility = path.join(
      dir,
      superOntologyStrategicIncentiveCompatibilityFile,
    );
    if (!fs.existsSync(superOntologyStrategicIncentiveCompatibility)) {
      fs.writeFileSync(superOntologyStrategicIncentiveCompatibility, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-strategic-incentive-compatibility",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "incentive_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_or_personalization_authority",
        incentiveSignalTypes: [
          "kpi_bonus",
          "commission",
          "promotion",
          "cost_savings",
          "approval_rate",
          "benchmark_score",
          "customer_rating",
          "retention_metric",
          "compliance_attestation",
          "vote_power",
          "access_grant",
          "data_payment",
          "social_status",
          "family_pressure",
          "none_declared",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "release_authority",
          "financial_authority",
          "hiring_authority",
          "policy_authority",
          "customer_output_authority",
          "analytics_authority",
          "evaluation_authority",
          "personalization_authority",
        ],
        requiredIncentiveEvidence: [
          "principal_id",
          "agent_id",
          "role_or_delegation",
          "private_information_inventory",
          "objective_function",
          "payoff_or_reward_model",
          "conflict_of_interest_disclosure",
          "strategic_behavior_hypothesis",
          "counterfactual_truthfulness_check",
          "holdout_or_audit_sample",
          "independent_verification",
          "collusion_check",
          "peer_pressure_check",
          "mechanism_constraint",
          "counter_incentive",
          "review_owner",
          "appeal_or_challenge_path",
          "audit_trace",
          "rollback_snapshot",
          "post_decision_monitoring",
          "data_quality_contribution",
          "budget_or_transfer_rule",
          "incentive_compatibility_argument",
          "residual_incentive_risk",
        ],
        hardStops: [
          "self_report_as_truth",
          "kpi_as_objective",
          "commission_report_as_fact",
          "manager_approval_as_no_conflict",
          "vendor_claim_as_source_quality",
          "customer_rating_as_value",
          "agent_vote_as_independent_signal",
          "benchmark_score_as_general_capability",
          "cheap_provider_as_best_provider",
          "data_provider_label_as_quality",
          "compliance_attestation_as_compliance",
          "peer_pressure_as_consensus",
          "hidden_affiliation_as_neutral_review",
          "survey_response_as_stable_preference",
          "retention_metric_as_satisfaction",
          "access_request_as_need_to_know",
          "family_pressure_as_user_preference",
          "approval_chain_as_truthfulness",
          "cost_saving_as_system_health",
          "strategic_silence_as_no_risk",
          "collusive_agents_as_quorum",
          "mechanism_missing_to_runtime_write",
          "incentive_conflict_to_memory_write",
          "reward_model_as_human_goal",
        ],
        researchBasis: [
          "mechanism_design",
          "incentive_compatibility",
          "principal_agent_theory",
          "information_asymmetry",
          "moral_hazard",
          "adverse_selection",
          "strategic_classification",
          "goodhart_law",
          "campbell_law",
          "game_theory",
          "multi_agent_systems",
          "nist_ai_rmf",
          "nist_genai_profile",
          "oecd_ai_principles",
          "auditability",
          "human_factors",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyTaskCoverage = path.join(dir, superOntologyTaskCoverageFile);
    const superOntologyReflexiveFeedbackStability = path.join(dir, superOntologyReflexiveFeedbackStabilityFile);
    if (!fs.existsSync(superOntologyReflexiveFeedbackStability)) {
      fs.writeFileSync(superOntologyReflexiveFeedbackStability, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-reflexive-feedback-stability",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "feedback_stability_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_physical_or_personalization_authority",
        interventionTypes: [
          "recommendation",
          "ranking",
          "notification",
          "automation",
          "memory_write",
          "retrieval_biasing",
          "dashboard_metric",
          "pricing_or_budget_change",
          "training_update",
          "route_update",
          "access_policy_change",
          "social_prompt",
          "customer_message",
          "physical_action",
          "none_declared",
        ],
        loopSignalTypes: [
          "post_intervention_observation",
          "behavior_change",
          "data_distribution_shift",
          "self_generated_content",
          "model_output_reuse",
          "metric_response",
          "user_adaptation",
          "agent_self_evaluation",
          "market_response",
          "social_contagion",
          "scheduler_replay",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "release_authority",
          "financial_authority",
          "hiring_authority",
          "policy_authority",
          "customer_output_authority",
          "analytics_authority",
          "evaluation_authority",
          "personalization_authority",
          "physical_authority",
        ],
        requiredFeedbackEvidence: [
          "intervention_id",
          "pre_intervention_baseline",
          "feedback_path_map",
          "time_lag_window",
          "post_intervention_observation",
          "counterfactual_or_holdout",
          "real_world_data_anchor",
          "synthetic_data_ratio",
          "stability_margin_or_error_budget",
          "damping_or_rate_limit",
          "saturation_bound",
          "externality_map",
          "affected_stakeholders",
          "monitoring_trace",
          "rollback_snapshot",
          "stop_condition",
          "owner_review",
          "residual_feedback_risk",
        ],
        hardStops: [
          "observation_after_intervention_as_neutral_truth",
          "recommendation_effect_as_preference",
          "self_generated_content_as_training_data",
          "model_output_as_source_corpus",
          "dashboard_change_as_system_improvement",
          "metric_response_as_real_world_gain",
          "repeated_retrieval_as_relevance",
          "agent_self_score_as_external_feedback",
          "closed_loop_without_counterfactual",
          "runaway_feedback_to_runtime_write",
          "oscillation_as_adaptation",
          "delayed_harm_ignored",
          "synthetic_data_loop_as_real_distribution",
          "intervention_without_stop_condition",
          "user_adaptation_as_stable_preference",
          "market_response_as_causal_truth",
          "personal_nudge_as_identity_change",
          "training_on_ai_outputs_without_real_anchor",
          "feedback_loop_to_memory_write",
          "feedback_loop_to_policy_write",
          "externality_free_assumption",
        ],
        researchBasis: [
          "performative_prediction",
          "control_theory",
          "cybernetics",
          "systems_dynamics",
          "model_collapse",
          "distribution_shift",
          "causal_inference",
          "reinforcement_learning_feedback",
          "human_factors",
          "fairness_feedback_loops",
          "nist_ai_rmf",
          "safety_engineering",
          "ecological_feedback",
          "social_contagion",
        ],
      }, null, 2), "utf8");
    }

    if (!fs.existsSync(superOntologyTaskCoverage)) {
      fs.writeFileSync(superOntologyTaskCoverage, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-task-coverage",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        taskFamilies: [
          "retrieve_answer",
          "summarize_synthesize",
          "draft_artifact",
          "transform_format",
          "analyze_decide",
          "plan_sequence",
          "coordinate_social",
          "execute_tool",
          "monitor_repair",
          "personalize_memory",
          "regulated_boundary",
          "multimodal_generate",
          "physical_or_sensor",
          "software_change",
          "financial_or_compliance",
          "education_or_coaching",
        ],
        affordanceTypes: [
          "read",
          "draft",
          "write",
          "publish",
          "execute",
          "physical",
          "train",
        ],
        evidenceModes: [
          "citation",
          "current_approved_source",
          "owner_authority",
          "policy_or_law",
          "measurement_or_dataset",
          "license_or_consent",
          "runtime_test",
          "rollback_plan",
        ],
        defaultDecision: "classify_before_action",
        hardStops: [
          "missing_task_family",
          "missing_affordance_type",
          "missing_evidence_mode",
          "write_without_rollback",
          "publish_execute_physical_or_train_without_authority",
        ],
      }, null, 2), "utf8");
    }
    for (const fileName of [
      superOntologyReplaysFile,
      superOntologyEvidenceFile,
      superOntologyMemoryBridgeFile,
    ]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    return dir;
  } catch { return null; }
}

const ONTOLOGY_SUPPORTED_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv"]);

function ontologyPathsForCli(projectPath) {
  const arch = loadArch();
  const root = path.resolve(projectPath || process.cwd());
  const memoryDir = path.join(root, arch.memoryDir || ".agentlas");
  return {
    root,
    memoryDir,
    configPath: path.join(memoryDir, arch.ontologyRuntimeFile || "ontology-runtime.json"),
    sourceManifestPath: path.join(memoryDir, arch.ontologySourceManifestFile || "ontology-sources.json"),
    inboxPath: path.join(memoryDir, arch.ontologyInboxDir || "ontology-inbox"),
    dbPath: path.join(memoryDir, arch.ontologyDbFile || "ontology-runtime.sqlite"),
  };
}

function readJsonSafeCli(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafeCli(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function ontologySourceManifestSkeletonCli(root) {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-ontology-source-manifest",
    projectRoot: root,
    sources: [],
  };
}

function ensureOntologyCli(projectPath) {
  const paths = ontologyPathsForCli(projectPath);
  ensureProjectMemoryCli(paths.root, path.basename(paths.root) || "Project");
  fs.mkdirSync(paths.inboxPath, { recursive: true });
  if (!fs.existsSync(paths.sourceManifestPath)) {
    writeJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  }
  return paths;
}

function listOntologyInboxCli(inboxPath) {
  try {
    if (!fs.existsSync(inboxPath)) return [];
    return fs.readdirSync(inboxPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const full = path.join(inboxPath, entry.name);
        const stat = fs.statSync(full);
        const isDir = entry.isDirectory();
        const ext = path.extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          path: full,
          kind: isDir ? "dir" : "file",
          size: isDir ? 0 : stat.size,
          supported: isDir || ONTOLOGY_SUPPORTED_EXTS.has(ext),
        };
      })
      .slice(0, 80);
  } catch {
    return [];
  }
}

function readOntologySourcesCli(sourceManifestPath) {
  const manifest = readJsonSafeCli(sourceManifestPath, { sources: [] });
  return Array.isArray(manifest.sources) ? manifest.sources : [];
}

function ontologyUsageLinesCli() {
  return [
    "Ontology commands:",
    "  /ontology                         turn on/show this project's ontology",
    "  /ontology list                    list inbox files and registered folders",
    "  /ontology open                    open the project ontology inbox",
    "  /ontology add ./docs              register a folder as private project knowledge",
    "  /ontology company ./docs          register company docs as private",
    "  /ontology personal ~/notes        register personal docs as private",
    "",
    "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
    "",
    "Safety: only the current project inbox and registered folders are used.",
    "No home folder or sibling project scan is started.",
  ];
}

function shellSplitCli(text) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of String(text || "")) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function expandUserPathCli(value) {
  const v = String(value || "").trim();
  if (v === "~") return os.homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return path.join(os.homedir(), v.slice(2));
  return v;
}

function cleanOntologyPathTokenCli(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^[`"']+|[`"',;]+$/g, "");
}

function resolveOntologyPathCli(value, cwd) {
  const clean = expandUserPathCli(cleanOntologyPathTokenCli(value));
  return path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd || process.cwd(), clean);
}

function inferOntologyKindCli(value, text) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["company", "work", "business", "corp", "team", "회사", "업무", "팀", "조직"].includes(v) || /(company|work|business|corp|team|회사|업무|조직)/i.test(hay)) return "company";
  if (["personal", "private-life", "life", "me", "개인", "내자료", "일상"].includes(v) || /(personal|private-life|\bme\b|개인|내\s*자료|일상)/i.test(hay)) return "personal";
  if (["project", "repo", "프로젝트", "레포"].includes(v) || /(project|repo|프로젝트|레포)/i.test(hay)) return "project";
  return "project";
}

function inferOntologyScopeCli(value, text, kind) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["public", "open", "공개"].includes(v) || /(public|open|공개)/i.test(hay)) return "public";
  if (["internal", "team", "내부", "팀"].includes(v) || /(internal|team-only|company-wide|내부|팀\s*공유|회사\s*공유)/i.test(hay)) return "internal";
  if (["private", "secret", "local", "비공개", "개인"].includes(v) || /(private|secret|local-only|비공개|개인만|나만)/i.test(hay)) return "private";
  return kind === "company" || kind === "personal" ? "private" : "private";
}

function isOntologyPathishCli(token, cwd, allowExistingName) {
  const clean = cleanOntologyPathTokenCli(token);
  if (!clean || clean === "." || clean === "..") return true;
  if (/^(?:~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(clean)) return true;
  if (clean.includes("/") || clean.includes("\\")) return true;
  if (allowExistingName) {
    try {
      return fs.existsSync(resolveOntologyPathCli(clean, cwd));
    } catch {
      return false;
    }
  }
  return false;
}

function findOntologyPathTokenCli(tokens, cwd, text) {
  const lower = String(text || "").toLowerCase();
  const addIntent = /(add|register|attach|source|folder|watch|sync|추가|등록|붙|연결|폴더|자료|문서)/i.test(lower);
  const skip = new Set([
    "add", "register", "attach", "source", "sources", "folder", "folders", "watch", "sync", "use",
    "company", "personal", "project", "private", "internal", "public", "work", "business",
    "추가", "등록", "붙여", "붙여줘", "연결", "켜줘", "켜", "회사", "개인", "프로젝트", "자료", "문서", "폴더", "비공개", "내부", "공개",
  ]);
  for (const token of tokens) {
    const clean = cleanOntologyPathTokenCli(token);
    if (!clean || skip.has(clean.toLowerCase())) continue;
    if (isOntologyPathishCli(clean, cwd, addIntent)) return clean;
  }
  return null;
}

function parseOntologyNaturalArgsCli(text, cwd) {
  const raw = String(text || "").trim();
  if (!raw) return ["status"];
  const lower = raw.toLowerCase();
  if (/^(?:help|\?|도움|사용법)\b/i.test(raw)) return ["help"];
  if (/(?:^|\s)(?:list|ls|sources?|status|show|상태|목록|리스트)(?:\s|$)/i.test(raw)) return ["list"];
  if (/(?:^|\s)(?:open|inbox|finder|열어|열기|인박스)(?:\s|$)/i.test(raw)) return ["open"];
  const tokens = shellSplitCli(raw);
  const kind = inferOntologyKindCli(null, raw);
  const scope = inferOntologyScopeCli(null, raw, kind);
  let source = findOntologyPathTokenCli(tokens, cwd, raw);
  if (!source && /(?:this folder|current folder|here|이\s*폴더|현재\s*폴더|지금\s*폴더|여기)/i.test(raw)) source = ".";
  const wantsAdd = Boolean(source) || /(add|register|attach|source|watch|sync|추가|등록|붙|연결)/i.test(lower);
  if (wantsAdd) {
    if (!source) return ["add"];
    return ["add", source, "--kind", kind, "--scope", scope];
  }
  if (/(enable|activate|start|turn on|켜|시작|활성)/i.test(lower)) return ["status"];
  return ["status"];
}

function formatOntologyStatusCli(paths) {
  const sources = readOntologySourcesCli(paths.sourceManifestPath);
  const inbox = listOntologyInboxCli(paths.inboxPath);
  const lines = [
    "Ontology: active",
    `  project: ${paths.root}`,
    `  inbox:  ${paths.inboxPath}`,
    `  db:     ${paths.dbPath}`,
    "  policy: inbox_and_registered_sources_only",
    "  scan:   no home folder, no sibling projects",
    "",
    `Inbox (${inbox.length}):`,
  ];
  for (const item of inbox) lines.push(`  ${item.supported ? "✓" : "!"} ${item.name}  ${item.supported ? "supported" : "adapter pending"}`);
  if (!inbox.length) lines.push("  (empty)");
  lines.push("", `Sources (${sources.length}):`);
  for (const source of sources) {
    const sourcePath = path.resolve(String(source.path || ""));
    lines.push(`  ${fs.existsSync(sourcePath) ? "✓" : "!"} ${sourcePath}  ${source.kind || "project"} / ${source.scope || "internal"}`);
  }
  if (!sources.length) lines.push("  (none)");
  lines.push(
    "",
    "Add sources:",
    "  /ontology add ./docs",
    "  /ontology company ./docs",
    "  /ontology personal ~/notes",
    "",
    "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
  );
  return lines;
}

function registerOntologySourceCli(paths, source, kind, scope, cwd) {
  if (!source) throw new Error("usage: /ontology add <path>  or  /ontology company ./docs");
  const sourcePath = resolveOntologyPathCli(source, cwd || paths.root);
  if (!fs.existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);
  const manifest = readJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  const nextSources = (Array.isArray(manifest.sources) ? manifest.sources : [])
    .filter((item) => path.resolve(String(item.path || "")) !== sourcePath);
  nextSources.push({ path: sourcePath, kind, scope, registeredAt: new Date().toISOString() });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-ontology-source-manifest";
  manifest.projectRoot = paths.root;
  manifest.sources = nextSources;
  writeJsonSafeCli(paths.sourceManifestPath, manifest);
  return [
    `Registered ontology source: ${sourcePath}`,
    `  kind:  ${kind}`,
    `  scope: ${scope}`,
    "  copy:  no",
    "  scan:  only this registered folder, not home/sibling projects",
  ];
}

function runOntologyCli(args, opts) {
  opts = opts || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  const projectPath = path.resolve(opts.projectPath || cwd);
  const normalizedArgs = Array.isArray(args) ? args : [];
  const sub = normalizedArgs[0] || "status";
  const paths = ensureOntologyCli(projectPath);
  if (sub === "status" || sub === "list") {
    return formatOntologyStatusCli(paths);
  }
  if (sub === "open") {
    if (!opts.noOpen) openLocalPathCli(paths.inboxPath);
    return [`Opened ontology inbox: ${paths.inboxPath}`];
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return ontologyUsageLinesCli();
  }
  if (sub === "add") {
    const flags = parseCloudFlags(normalizedArgs.slice(1));
    const source = flags._[0];
    const kind = inferOntologyKindCli(flags.kind || flags._[1], normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[2], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, source, kind, scope, cwd);
  }
  if (["company", "personal", "project"].includes(String(sub).toLowerCase())) {
    const flags = parseCloudFlags(normalizedArgs.slice(1));
    const kind = inferOntologyKindCli(sub, normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[1], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, flags._[0], kind, scope, cwd);
  }
  if (isOntologyPathishCli(sub, cwd, true)) {
    return registerOntologySourceCli(paths, sub, inferOntologyKindCli(null, normalizedArgs.join(" ")), inferOntologyScopeCli(null, normalizedArgs.join(" "), "project"), cwd);
  }
  return runOntologyCli(parseOntologyNaturalArgsCli(normalizedArgs.join(" "), cwd), opts);
}

function runOntologyNaturalCli(text, opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  return runOntologyCli(parseOntologyNaturalArgsCli(text, cwd), { ...(opts || {}), cwd });
}

function cmdOntology(args) {
  try {
    for (const line of runOntologyCli(args, { cwd: process.cwd(), projectPath: process.cwd() })) out(line);
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

function openLocalPathCli(targetPath) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    spawn(command, [targetPath], { detached: true, stdio: "ignore" }).unref();
  } catch {
    out(`Open manually: ${targetPath}`);
  }
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
  const style = require("./agentlas-style.cjs");
  if (!events.length || !tableExists(db, "memory_entries")) return style.sanitizeAssistantText(cleaned);
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
  return style.sanitizeAssistantText(cleaned);
}

function langDirective(lang) {
  return require("./agentlas-style.cjs").responseDirective(lang);
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
  // 언어/말투 지시를 맨 앞에 둔다. imported/cloud/company agents도 같은 전역 계약을 따른다.
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
      "When the task needs Slack, Gmail, Google Cloud, Firebase, a database, store release access, or another third-party service, open the provider website with the browser tool when available, guide the user one tiny step at a time, and save the issued credential with `agentlas creds save --provider <name> --key <ENV_NAME> --value \"<value>\" --project \"<cwd>\"` or `agentlas creds file --source <path> --provider <name> --env <ENV_NAME> --project \"<cwd>\"`.",
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
    // one-shot(`agentlas "작업"`)도 REPL과 동일한 리치 렌더(⏺ 툴 / └ 결과 / 토큰)로 출력한다.
    const { runNativeTurn } = require("./agentlas-native-host.cjs");
    const { Ui } = require("./agentlas-ui.cjs");
    const ui = new Ui({ lang: prefsLang() });
    let mcpServers = [];
    if (permission !== "read") {
      try {
        mcpServers = db.prepare("SELECT id, name, transport, command, args_json, enabled FROM mcp_servers WHERE enabled=1 AND transport='stdio'").all();
      } catch { /* ignore */ }
    }
    ui.beginTurn();
    const res = await runNativeTurn({
      kind: rt.kind,
      bin: which(RUNTIME_BIN[rt.kind]) || RUNTIME_BIN[rt.kind],
      prompt,
      systemPrompt: sys,
      cwd,
      permission,
      session: {},
      model: null,
      effort: null,
      mcpServers,
      env,
      ui,
    });
    ui.endTurn();
    return res.error ? 1 : 0;
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
function readVaultEnvValuesCli(keys, projectPath) {
  const keytar = readKeytar();
  const result = {};
  if (!keytar || !keys.length) return Promise.resolve(result);
  return Promise.all(
    keys.map((key) =>
      Promise.resolve()
        .then(async () => {
          if (projectPath) {
            const scoped = await keytar.getPassword(SERVICE, ENV_PREFIX + projectScopedGlobalEnvKeyCli(projectPath, key)).catch(() => null);
            if (scoped) {
              result[key] = scoped;
              return;
            }
          }
          const value = await keytar.getPassword(SERVICE, ENV_PREFIX + key).catch(() => null);
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
  const globalCredentials = {
    ...readDotEnvFileCli(path.join(userDataDir(), "credentials.env")),
    ...readDotEnvFileCli(path.join(os.homedir(), ".agentlas", "credentials.env")),
  };
  apply(globalCredentials, false);
  if (ctx && ctx.projectPath) apply(projectScopedEnvValuesCli(globalCredentials, ctx.projectPath), true);
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
  const vaultValues = await readVaultEnvValuesCli([...keys].filter((key) => !env[key]), ctx && ctx.projectPath);
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
    detectResponseLanguage: (prompt, fallback) => require("./agentlas-style.cjs").detectResponseLanguage(prompt, fallback),
    sanitizeAssistantText: (text) => require("./agentlas-style.cjs").sanitizeAssistantText(text),
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
    // REPL-safe 마켓플레이스 설치: fail()(process.exit) 대신 Error를 throw 해 REPL이 직접 렌더하게 한다.
    cloudInstall: async (db_, slug) => {
      if (typeof fetch !== "function") throw new Error("이 런타임에 fetch가 없습니다(앱 런타임 필요).");
      const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
      const headers = { "content-type": "application/json" };
      const cookie = await cloudSessionCookieCli();
      if (cookie) headers.cookie = cookie;
      let resp;
      try {
        resp = await fetch(`${base.replace(/\/$/, "")}/tools/call`, {
          method: "POST",
          headers,
          body: JSON.stringify({ method: "marketplace.get_manifest", params: { name: "marketplace.get_manifest", arguments: { kind: "agent", slug } } }),
        });
      } catch (e) {
        throw new Error(`마켓플레이스 연결 실패: ${(e && e.message) || e}`);
      }
      if (!resp.ok) {
        const authHint = resp.status === 401 || resp.status === 403 ? " — 로그인이 필요합니다 (앱에서 로그인 또는 AGENTLAS_SESSION 설정)" : "";
        throw new Error(`마켓플레이스 응답 ${resp.status}${authHint}`);
      }
      const json = await resp.json();
      if (json.error) throw new Error(json.error.message || "marketplace error");
      const listing = json.result;
      if (!listing) throw new Error(`마켓플레이스에서 찾을 수 없음: ${slug}`);
      return persistCloudListingCli(db_, listing);
    },
    hasCloudSession: async () => {
      try { return !!(await cloudSessionCookieCli()); } catch { return false; }
    },
    mcpServers: (db_) => {
      try {
        return db_.prepare("SELECT id, name, name_en, transport, command, args_json, url, env_keys_json, enabled FROM mcp_servers ORDER BY installed_at ASC").all();
      } catch {
        return [];
      }
    },
    // CLI 세션 영속화(이어하기 /resume): 네이티브 런타임 세션ID를 cli-sessions.json에 저장.
    sessionsLoad: () => {
      try { return JSON.parse(fs.readFileSync(path.join(userDataDir(), "cli-sessions.json"), "utf8")) || []; } catch { return []; }
    },
    sessionsSave: (list) => {
      try { fs.writeFileSync(path.join(userDataDir(), "cli-sessions.json"), JSON.stringify((list || []).slice(0, 30), null, 2), "utf8"); } catch { /* ignore */ }
    },
    ontologyCommand: (text, ctx) => runOntologyNaturalCli(text, {
      cwd: (ctx && ctx.cwd) || projectCwd(),
      projectPath: (ctx && ctx.cwd) || projectCwd(),
    }),
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
    doctor: async (db_, ui) => {
      ui.line("");
      ui.info("userData: " + userDataDir());
      ui.info("db: " + (fs.existsSync(dbPath()) ? "OK" : "없음"));
      const ar = activeRuntime(db_);
      ui.info("활성 런타임: " + (ar ? ar.kind : "(없음)"));
      // CLI 런타임: 설치 + 로그인(인증 파일) 휴리스틱
      const home = os.homedir();
      const authFiles = {
        "claude-code": [path.join(home, ".claude.json"), path.join(home, ".claude", ".credentials.json")],
        codex: [path.join(home, ".codex", "auth.json")],
        gemini: [path.join(home, ".gemini", "oauth_creds.json"), path.join(home, ".gemini", "google_accounts.json")],
      };
      const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
      for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
        const installed = !!which(bin);
        const authed = (authFiles[kind] || []).some(has);
        ui.info(`  ${kind.padEnd(12)} ${!installed ? "미설치" : authed ? "설치됨 · 로그인" : "설치됨 · 로그인 미확인"}`);
      }
      // BYOK 키 (keytar) + 클라우드 세션
      const byok = [];
      for (const b of ["anthropic", "openai", "google", "upstage"]) {
        try { if (await apiKey(b)) byok.push(b); } catch { /* keytar 미사용 */ }
      }
      ui.info("BYOK 키: " + (byok.length ? byok.join(", ") : "(없음 — 앱 설정 → BYOK)"));
      let cloud = false;
      try { cloud = !!(await cloudSessionCookieCli()); } catch { /* ignore */ }
      ui.info("클라우드 세션: " + (cloud ? "로그인됨" : "로그아웃"));
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
async function cmdCredsFile(db, args) {
  const f = parseCredFlags(args);
  const source = typeof f.source === "string" ? f.source : typeof f.path === "string" ? f.path : "";
  if (!source) fail("usage: agentlas creds file --source <path> [--provider <name>] [--env <ENV_NAME>] [--dest <relative-path>] [--project <path>] [--force]");
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(db);
  if (!project) fail("creds file requires a project path");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : "credential_file";
  const envKey = typeof f.env === "string" && f.env ? f.env.trim() : "";
  if (envKey && !/^[A-Z][A-Z0-9_]*$/.test(envKey)) fail("credential env name must look like ENV_NAME");

  const arch = loadArch();
  const cfg = localCredentialConfigCli(arch);
  const projectName = path.basename(project) || "Project";
  ensureLocalCredentialStoreCli(project, projectName, arch);
  ensureSoulCredentialIndexCli(project, projectName, arch);

  const sourceAbs = path.resolve(runCwd(), source);
  let stat;
  try { stat = fs.statSync(sourceAbs); } catch { fail(`credential source not found: ${source}`); }
  if (!stat.isFile()) fail(`credential source is not a file: ${source}`);

  const base = path.basename(sourceAbs);
  const lower = base.toLowerCase();
  const defaultDir = lower.includes("google-services") || lower.includes("googleservice-info")
    ? cfg.credentialsDir
    : cfg.signingDir;
  const destRel = safeCredentialDestRelCli(
    typeof f.dest === "string" && f.dest ? f.dest : path.join(defaultDir, base),
  );
  const destAbs = path.join(project, destRel);
  if (!path.resolve(destAbs).startsWith(path.resolve(project) + path.sep)) {
    fail("credential destination must stay inside the project");
  }
  if (fs.existsSync(destAbs) && !f.force) fail(`credential destination already exists: ${destRel} (use --force to replace)`);

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, destAbs);
  try { fs.chmodSync(destAbs, 0o600); } catch { /* best-effort */ }

  const targets = [destRel];
  if (envKey) {
    try { upsertEnvLine(path.join(project, ".env"), envKey, destRel); targets.push("project .env"); }
    catch (e) { process.stderr.write(".env write failed: " + e.message + "\n"); }
    const scopedKey = projectScopedGlobalEnvKeyCli(project, envKey);
    try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), scopedKey, destAbs); targets.push("global project env"); } catch { /* best-effort */ }
    try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), scopedKey, destAbs); } catch { /* best-effort */ }
  }

  upsertLocalCredentialMapCli(project, projectName, arch, {
    id: typeof f.id === "string" && f.id ? f.id : `${provider}:${envKey || destRel}`,
    provider,
    env: envKey ? [envKey] : [],
    localFiles: [destRel],
    owner: "project",
    valueMaterialized: true,
    storage: envKey ? ["project_file", "project_env", "global_project_env"] : ["project_file"],
    requiredFor: typeof f.requiredFor === "string" && f.requiredFor ? [f.requiredFor] : [],
    staleCheck: typeof f.staleCheck === "string" && f.staleCheck ? f.staleCheck : "Validate access before release or deploy.",
  });

  out(`✓ saved credential file for ${provider} — ${targets.join(", ")}.`);
}
async function cmdCreds(db, args) {
  const sub = args[0];
  if (sub === "file") return cmdCredsFile(db, args.slice(1));
  if (sub !== "save") {
    fail('usage: agentlas creds save --provider <name> --key <ENV_NAME> --value <value> [--project <path>] OR agentlas creds file --source <path> [--env <ENV_NAME>]');
  }
  const f = parseCredFlags(args.slice(1));
  const key = typeof f.key === "string" ? f.key.trim() : "";
  const value = f.value === undefined || f.value === true ? "" : String(f.value);
  if (!key || !value) fail("creds save requires --key and --value");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : key;
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(db);
  const targets = [];
  const arch = loadArch();
  const projectName = project ? path.basename(project) || "Project" : "Project";
  if (project) {
    ensureLocalCredentialStoreCli(project, projectName, arch);
    ensureSoulCredentialIndexCli(project, projectName, arch);
  }

  // 1) keychain vault — project-scoped when a project is active.
  const keytar = readKeytar();
  if (keytar) {
    const vaultKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
    try { await keytar.setPassword(SERVICE, ENV_PREFIX + vaultKey, value); targets.push(project ? "project vault" : "vault"); }
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
        `\n- Connected ${provider}: ${key} saved in local credential store during first setup.\n`,
        "utf8",
      );
    } catch { /* best-effort */ }
    try {
      upsertLocalCredentialMapCli(project, projectName, arch, {
        id: `${provider}:${key}`,
        provider,
        env: [key],
        localFiles: [],
        owner: "project",
        valueMaterialized: true,
        storage: ["project_env", "project_vault", "global_project_env"],
        staleCheck: "Validate access before release or deploy.",
      });
    } catch { /* best-effort */ }
  }
  // 4) 전역 로컬 env — 프로젝트가 있으면 프로젝트 이름이 붙은 키로 저장
  const globalKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
  try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), globalKey, value); targets.push(project ? "global project env" : "global memory"); } catch { /* best-effort */ }
  try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), globalKey, value); } catch { /* best-effort */ }

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
  out(`db: ${fs.existsSync(dbPath()) ? "OK" : "missing"}`);
  const ar = activeRuntime(db);
  out(`active runtime: ${ar ? ar.kind : "(none)"}`);
  for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
    const p = which(bin);
    out(`  ${kind.padEnd(12)} ${p ? "installed: " + p : "not found on PATH"}`);
  }
}

function cmdVersion() {
  out(`agentlas ${readPackageVersion()}`);
}

function parseUpdateFlags(args) {
  const flags = {
    check: false,
    force: false,
    json: false,
    launch: true,
    url: process.env.AGENTLAS_DESKTOP_UPDATE_URL || "https://agentlas.cloud/api/desktop/latest",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--no-launch") flags.launch = false;
    else if (arg === "--url") flags.url = args[++i] || flags.url;
    else if (arg === "--help" || arg === "-h" || arg === "help") flags.help = true;
    else fail(`알 수 없는 update 옵션: ${arg}`);
  }
  return flags;
}

function cmdUpdateHelp() {
  out(
    [
      "agentlas update",
      "",
      "  update              최신 공개 Desktop 릴리즈를 확인하고 설치",
      "  update --check      설치하지 않고 현재/최신 버전만 확인",
      "  update --force      같은 버전이어도 다시 설치",
      "  update --json       상태를 JSON으로 출력",
      "",
      "macOS는 notarized DMG를 내려받아 검증한 뒤 /Applications/Agentlas.app을 교체합니다.",
      "Windows/Linux는 현재 자동 설치 대신 최신 다운로드 위치를 안내합니다.",
    ].join("\n"),
  );
}

function versionParts(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function macReleaseArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return null;
}

async function fetchDesktopRelease(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!resp.ok) fail(`업데이트 정보를 가져오지 못했습니다: ${resp.status}`);
    const json = await resp.json();
    if (!json || typeof json !== "object" || !json.version) fail("업데이트 정보 형식이 올바르지 않습니다.");
    return json;
  } catch (error) {
    const message = error && error.name === "AbortError" ? "요청 시간이 초과되었습니다." : String((error && error.message) || error);
    fail(`업데이트 확인 실패: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function findCurrentArtifact(release) {
  const arch = macReleaseArch();
  if (!arch || !Array.isArray(release.artifacts)) return null;
  return release.artifacts.find((artifact) => artifact && artifact.arch === arch && artifact.available !== false) || null;
}

function desktopReleaseUrl(release) {
  if (release.releaseRepositoryUrl && release.releaseTag) return `${String(release.releaseRepositoryUrl).replace(/\/$/, "")}/releases/tag/${release.releaseTag}`;
  return "https://github.com/agentlas-ai/agentlas-desktop/releases/latest";
}

function formatUpdateSummary(status) {
  const lines = [
    `현재 버전: ${status.currentVersion}`,
    `최신 버전: ${status.latestVersion}${status.releaseTag ? ` (${status.releaseTag})` : ""}`,
    `상태: ${status.updateAvailable ? "업데이트 가능" : "최신 상태"}`,
  ];
  if (status.releaseUrl) lines.push(`릴리즈: ${status.releaseUrl}`);
  if (status.downloadUrl) lines.push(`다운로드: ${status.downloadUrl}`);
  return lines.join("\n");
}

async function cmdUpdate(args) {
  const flags = parseUpdateFlags(args);
  if (flags.help) return cmdUpdateHelp();
  const currentVersion = readPackageVersion();
  const release = await fetchDesktopRelease(flags.url);
  const latestVersion = String(release.version || "");
  const artifact = findCurrentArtifact(release);
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;
  const status = {
    currentVersion,
    latestVersion,
    releaseTag: release.releaseTag || null,
    ready: release.ready === true,
    notarized: release.notarized === true,
    platform: process.platform,
    arch: process.arch,
    updateAvailable,
    releaseUrl: desktopReleaseUrl(release),
    downloadUrl: artifact ? artifact.url : null,
  };

  if (flags.json) return out(JSON.stringify(status, null, 2));
  out(formatUpdateSummary(status));
  if (flags.check) return;
  if (release.ready !== true) fail("최신 릴리즈가 아직 공개 설치 가능 상태가 아닙니다.");
  if (!updateAvailable && !flags.force) return out("이미 최신 버전입니다.");
  if (process.platform !== "darwin") return out("이 OS는 아직 자동 설치를 지원하지 않습니다. 위 릴리즈/다운로드 링크에서 최신 설치 파일을 받으세요.");
  if (!artifact || !artifact.url) fail("현재 Mac에 맞는 DMG를 찾지 못했습니다.");
  await installMacDesktopUpdate(release, artifact, flags);
}

function requirePath(commandPath, label) {
  if (!fs.existsSync(commandPath)) fail(`업데이트에 필요한 도구가 없습니다: ${label}`);
  return commandPath;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = Boolean(options.capture);
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) return resolve(result);
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(`${path.basename(command)} 실패 (${code})${detail ? `\n${detail}` : ""}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadUpdateFile(url, destination, artifact) {
  const resp = await fetch(url);
  if (!resp.ok) fail(`다운로드 실패: ${resp.status}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destination, bytes);
  if (artifact.sizeBytes && bytes.length !== Number(artifact.sizeBytes)) {
    fail(`다운로드 크기가 맞지 않습니다: expected=${artifact.sizeBytes} actual=${bytes.length}`);
  }
  if (artifact.sha256) {
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256) fail(`다운로드 해시가 맞지 않습니다: ${actual}`);
  }
}

function parseHdiutilMountPoint(output) {
  const line = String(output || "").split(/\r?\n/).find((item) => item.includes("/Volumes/"));
  if (!line) return "";
  return line.slice(line.indexOf("/Volumes/")).trim();
}

function macAppInstallPath() {
  if (process.env.AGENTLAS_APP_PATH) return process.env.AGENTLAS_APP_PATH;
  const match = String(process.execPath || "").match(/^(.*?Agentlas\.app)(?:\/|$)/);
  if (match && match[1]) return match[1];
  return "/Applications/Agentlas.app";
}

async function installMacDesktopUpdate(release, artifact, flags) {
  const hdiutil = requirePath("/usr/bin/hdiutil", "hdiutil");
  const xcrun = requirePath("/usr/bin/xcrun", "xcrun");
  const spctl = requirePath("/usr/sbin/spctl", "spctl");
  const osascript = requirePath("/usr/bin/osascript", "osascript");
  const ditto = requirePath("/usr/bin/ditto", "ditto");
  const plistBuddy = requirePath("/usr/libexec/PlistBuddy", "PlistBuddy");
  const mv = requirePath("/bin/mv", "mv");
  const rm = requirePath("/bin/rm", "rm");
  const open = requirePath("/usr/bin/open", "open");
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-update."));
  const fileName = artifact.fileName || `Agentlas-${release.version}-${artifact.arch || macReleaseArch()}.dmg`;
  const dmgPath = path.join(tmpDir, fileName);
  let mountPoint = "";
  let backupPath = "";
  const targetApp = macAppInstallPath();

  try {
    out(`다운로드: ${fileName}`);
    await downloadUpdateFile(artifact.url, dmgPath, artifact);
    out("검증: DMG, notarization, Gatekeeper");
    await runCommand(hdiutil, ["verify", dmgPath]);
    await runCommand(xcrun, ["stapler", "validate", dmgPath]);
    await runCommand(spctl, ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmgPath]);

    const mount = await runCommand(hdiutil, ["attach", "-nobrowse", "-readonly", dmgPath], { capture: true });
    mountPoint = parseHdiutilMountPoint(mount.stdout);
    const sourceApp = mountPoint ? path.join(mountPoint, "Agentlas.app") : "";
    if (!sourceApp || !fs.existsSync(sourceApp)) fail("DMG 안에서 Agentlas.app을 찾지 못했습니다.");

    const installedVersion = await runCommand(plistBuddy, ["-c", "Print :CFBundleShortVersionString", path.join(sourceApp, "Contents", "Info.plist")], { capture: true });
    const appVersion = installedVersion.stdout.trim();
    if (appVersion !== String(release.version)) fail(`앱 버전이 릴리즈와 다릅니다: release=${release.version} app=${appVersion}`);
    await runCommand(spctl, ["-a", "-vv", sourceApp]);

    out("설치: 기존 Agentlas 종료 후 앱 교체");
    await runCommand(osascript, ["-e", 'tell application "Agentlas" to quit'], { capture: true, allowFailure: true });
    await sleep(2_000);
    if (fs.existsSync(targetApp)) {
      backupPath = `${targetApp}.backup.${Date.now()}`;
      await runCommand(mv, [targetApp, backupPath]);
    }
    await runCommand(ditto, [sourceApp, targetApp]);
    if (fs.existsSync(lsregister)) await runCommand(lsregister, ["-f", targetApp], { allowFailure: true });

    try {
      await runCommand(spctl, ["-a", "-vv", targetApp]);
    } catch (error) {
      if (backupPath && fs.existsSync(backupPath)) {
        await runCommand(rm, ["-rf", targetApp], { allowFailure: true });
        await runCommand(mv, [backupPath, targetApp], { allowFailure: true });
      }
      throw error;
    }

    if (backupPath && fs.existsSync(backupPath)) await runCommand(rm, ["-rf", backupPath], { allowFailure: true });
    if (flags.launch) await runCommand(open, ["-a", "Agentlas"], { allowFailure: true });
    out(`Agentlas ${release.version} 설치 완료.`);
  } finally {
    if (mountPoint) await runCommand(hdiutil, ["detach", mountPoint], { allowFailure: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Oberon 필름 스튜디오 (터미널 헤드리스 렌더) ───────────
// GUI 없이 매니페스트 하나로 영상 렌더를 돌린다. 손으로 쓰던 JSON+env 노가다 대신:
//   agentlas oberon scaffold my.json      → 편집 가능한 렌더 매니페스트 생성
//   agentlas oberon render my.json         → full Electron 렌더 스폰 + 진행률 스트리밍
//   agentlas oberon list                   → 최근 렌더 산출물
// 프롬프트는 직접 채우거나 `agentlas run oberon-film-studio "<브리프>"`로 에이전트가 채운다
// (OpenMontage "어시스턴트=오케스트레이터" 스킴).

function oberonRepoRoot() {
  return path.resolve(__dirname, "..");
}

function oberonParseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

function oberonSampleTitles(title) {
  const koStyle = (over) => ({
    fontName: "Pretendard",
    fontStack: '"Pretendard", system-ui, sans-serif',
    fontCategory: "humanist_sans",
    cjk: true,
    sizePct: 5,
    weight: 700,
    tracking: 0,
    case: "none",
    position: "center",
    fill: "#FFFFFF",
    safeAreaPct: 10,
    ...over,
  });
  return {
    aspectRatio: "16:9",
    titleCard: { kind: "title", lines: [title], style: koStyle({ sizePct: 9, outline: { color: "rgba(0,0,0,0.45)", widthPx: 2 } }), bg: "#000000", durationSec: 2 },
    endCard: { kind: "end_card", lines: ["AGENTLAS"], style: koStyle({ sizePct: 7, cjk: false }), bg: "#0A0A0A", durationSec: 1.5 },
    lowerThirds: [],
    subtitles: [],
    subtitleStyle: koStyle({ sizePct: 4.6, weight: 600, position: "lower_center", boxBg: "rgba(0,0,0,0.34)", outline: { color: "rgba(0,0,0,0.9)", widthPx: 3 }, safeAreaPct: 8 }),
    rationale: "scaffold 기본 타이포 — 한국어 본문/자막은 CJK 폰트 강제",
  };
}

function oberonScaffold(args) {
  const { flags, rest } = oberonParseFlags(args);
  const outPath = path.resolve(rest[0] || "oberon-manifest.json");
  const title = flags.title || "My Oberon Film";
  const aspect = flags.aspect || "16:9";
  const shotCount = Math.max(1, Math.min(Number(flags.shots) || 2, 12));
  const shots = Array.from({ length: shotCount }, (_, i) => ({
    shotId: `SH_${String(i + 1).padStart(3, "0")}`,
    index: i,
    durationSec: 4,
    aspectRatio: aspect,
    providerId: "google-veo",
    providerMode: "text_to_video",
    prompt: `((샷 ${i + 1} 프롬프트를 여기에 — 카메라/피사체/조명/무드. 'agentlas run oberon-film-studio' 로 에이전트가 채우게 할 수 있다.))`,
    negativePrompt: "low quality, blurry, distorted text, watermark",
  }));
  const manifest = {
    productionId: `oberon-${Date.now().toString(36)}`,
    title,
    aspectRatio: aspect,
    maxShots: shotCount,
    takesPerShot: 1,
    provider: flags.provider || "google-gemini-veo",
    model: flags.model || "veo-3.1-lite-generate-001",
    resolution: flags.resolution || "720p",
    shots,
  };
  if (flags.titles) manifest.titles = oberonSampleTitles(title);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8");
  out(`✓ 매니페스트 생성: ${outPath}`);
  out(`  · 샷 ${shotCount}개 · ${aspect} · ${manifest.provider}`);
  out(`  · 프롬프트를 채운 뒤:  agentlas oberon render ${path.basename(outPath)}`);
  out(`  · 또는 에이전트로 채우기:  agentlas run oberon-film-studio "30초 향수 광고 트레일러"`);
  if (!flags.titles) out(`  · 타이틀/자막 번인 샘플 포함하려면 --titles 플래그`);
}

function oberonRender(args) {
  const { flags, rest } = oberonParseFlags(args);
  if (!rest[0]) fail("렌더할 매니페스트 경로가 필요합니다:  agentlas oberon render <manifest.json>");
  const manifestPath = path.resolve(rest[0]);
  if (!fs.existsSync(manifestPath)) fail(`매니페스트를 찾을 수 없습니다: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return fail(`매니페스트 JSON 파싱 실패: ${e.message}`);
  }
  if (!Array.isArray(manifest.shots) || !manifest.shots.length) fail("매니페스트에 shots[] 가 비어 있습니다.");

  const root = oberonRepoRoot();
  const script = path.join(root, "scripts", "render-oberon-live-request.cjs");
  const builtRender = path.join(root, "dist", "electron", "oberon", "render.js");
  if (!fs.existsSync(script)) fail(`헤드리스 렌더 스크립트가 없습니다(패키지 앱에는 미포함): ${script}`);
  if (!fs.existsSync(builtRender)) fail(`Electron 빌드가 필요합니다. 먼저:  npm run build:electron   (없는 파일: ${builtRender})`);

  // --max-shots 등 오버라이드가 있으면 사용자 매니페스트는 그대로 두고 임시 패치본을 만든다.
  let reqPath = manifestPath;
  const overrides = {};
  if (flags["max-shots"]) overrides.maxShots = Number(flags["max-shots"]);
  if (flags["takes"]) overrides.takesPerShot = Number(flags["takes"]);
  if (flags["resolution"]) overrides.resolution = flags["resolution"];
  if (Object.keys(overrides).length) {
    const patched = { ...manifest, ...overrides };
    reqPath = path.join(os.tmpdir(), `oberon-req-${Date.now().toString(36)}.json`);
    fs.writeFileSync(reqPath, JSON.stringify(patched, null, 2), "utf8");
  }

  const deliveryDir = path.resolve(flags.delivery || path.join(path.dirname(manifestPath), `${slugifyOberon(manifest.title)}-delivery`));

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // full Electron으로 부팅
  childEnv.OBERON_LIVE_VEO = "1";
  childEnv.OBERON_LIVE_REQUEST_FILE = reqPath;
  childEnv.OBERON_LIVE_DELIVERY_DIR = deliveryDir;
  if (flags["max-polls"]) childEnv.OBERON_LIVE_MAX_POLLS = String(flags["max-polls"]);
  if (flags["poll-ms"]) childEnv.OBERON_LIVE_POLL_MS = String(flags["poll-ms"]);
  if (flags.open) childEnv.OBERON_LIVE_OPEN_DELIVERY = "1";

  out(`▶ Oberon 렌더: "${manifest.title}"  (${manifest.shots.length}샷, 최대 ${overrides.maxShots ?? manifest.maxShots ?? 3})`);
  out(`  매니페스트: ${manifestPath}`);
  out(`  납품 폴더:  ${deliveryDir}`);
  if (manifest.titles) out(`  타이틀/자막 번인: 활성 → *_titled.mp4 추가 생성`);

  if (flags["dry-run"]) {
    out("\n[dry-run] 실행할 명령:");
    out(`  ${process.execPath} ${script}`);
    out("  env: OBERON_LIVE_VEO=1");
    out(`       OBERON_LIVE_REQUEST_FILE=${reqPath}`);
    out(`       OBERON_LIVE_DELIVERY_DIR=${deliveryDir}`);
    out("  (full Electron · GEMINI_API_KEY/GOOGLE_CLOUD_PROJECT 볼트 필요)");
    return;
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let buf = "";
    const handle = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        oberonRenderLine(line, files);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", (c) => process.stderr.write(c));
    child.on("close", (code) => {
      if (code === 0) {
        out(`\n✓ 렌더 완료 — 납품 폴더: ${deliveryDir}`);
        const titled = files.filter((f) => f.kind && f.kind.startsWith("titled"));
        if (titled.length) out(`  타이틀/자막 번인본: ${titled.map((f) => f.name).join(", ")}`);
      } else {
        process.stderr.write(`\n✖ 렌더 실패 (exit ${code})\n`);
        process.exitCode = code || 1;
      }
      resolve();
    });
  });
}

function oberonRenderLine(line, files) {
  let m;
  if ((m = line.match(/^POLL status=(\S+) phase=(\S+) clips=(\S+) percent=(\d+)/))) {
    const [, status, phase, clips, pct] = m;
    const bar = oberonBar(Number(pct));
    process.stdout.write(`\r⏳ ${bar} ${String(pct).padStart(3)}%  ${phase}  clips ${clips}   `);
    if (status === "succeeded") process.stdout.write("\n");
    return;
  }
  if ((m = line.match(/^FILE kind=(\S+) name=(\S+) bytes=(\d+)/))) {
    files.push({ kind: m[1], name: m[2], bytes: Number(m[3]) });
    return;
  }
  if ((m = line.match(/^DELIVERY kind=(\S+) name=(\S+) path=(\S+) bytes=(\d+)/))) {
    out(`  📦 ${m[1].padEnd(11)} ${m[2]}  (${oberonBytes(Number(m[4]))})`);
    return;
  }
  if (line.startsWith("WARNINGS=")) {
    out(`  ⚠ ${line.slice("WARNINGS=".length)}`);
    return;
  }
  if (line.startsWith("JOB=") || line.startsWith("OUT_DIR=")) return; // 내부 추적
  if (/=(present|missing)$/.test(line)) return; // 키 존재 점검 라인
  if (line.trim()) out(`  ${line}`);
}

function oberonBar(pct) {
  const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
}

function oberonBytes(n) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + "MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + "KB";
  return n + "B";
}

function slugifyOberon(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[^\w가-힣-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .slice(0, 48) || "oberon"
  );
}

function oberonList() {
  const dir = path.join(userDataDir(), "oberon");
  if (!fs.existsSync(dir)) {
    out("아직 렌더 산출물이 없습니다.  agentlas oberon scaffold my.json  으로 시작하세요.");
    return;
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      const files = (() => {
        try {
          return fs.readdirSync(full);
        } catch {
          return [];
        }
      })();
      return { name: d.name, full, mtime, files };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 15);
  if (!entries.length) {
    out("아직 렌더 산출물이 없습니다.");
    return;
  }
  out(`최근 Oberon 렌더 (${dir}):\n`);
  for (const e of entries) {
    const masters = e.files.filter((f) => /master|titled/.test(f) && /\.(mp4|mov)$/.test(f));
    const when = e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ") : "";
    out(`  ${when}  ${e.name}`);
    if (masters.length) out(`            ${masters.join(", ")}`);
  }
  out(`\n폴더 열기:  agentlas oberon open`);
}

function oberonOpen(args) {
  const target = args[0] ? path.resolve(args[0]) : path.join(userDataDir(), "oberon");
  if (!fs.existsSync(target)) fail(`경로가 없습니다: ${target}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
  out(`폴더 열기: ${target}`);
}

function oberonHelp() {
  out(
    [
      "agentlas oberon — 터미널에서 AI 필름 렌더",
      "",
      "  oberon scaffold [out.json] [--title T] [--aspect 16:9] [--shots N] [--titles]",
      "                         편집 가능한 렌더 매니페스트 생성 (--titles: 타이틀/자막 번인 샘플 포함)",
      "  oberon render <manifest.json> [--delivery DIR] [--max-shots N] [--open] [--dry-run]",
      "                         full Electron 렌더 스폰 + 진행률 스트리밍 (GEMINI_API_KEY 볼트 필요)",
      "  oberon list            최근 렌더 산출물",
      "  oberon open [path]     산출물 폴더 열기",
      "",
      "프롬프트는 직접 채우거나, 에이전트에게:  agentlas run oberon-film-studio \"30초 향수 광고\"",
    ].join("\n"),
  );
}

async function cmdOberon(args) {
  const sub = args[0] || "help";
  const rest = args.slice(1);
  switch (sub) {
    case "scaffold":
    case "new":
      return oberonScaffold(rest);
    case "render":
      return oberonRender(rest);
    case "list":
    case "ls":
      return oberonList(rest);
    case "open":
      return oberonOpen(rest);
    case "help":
    case "--help":
    case "-h":
      return oberonHelp();
    default:
      fail(`알 수 없는 oberon 하위명령: ${sub}  (scaffold|render|list|open|help)`);
  }
}

function cmdHelp() {
  out(
    [
      "agentlas — local agent terminal",
      "",
      "  agentlas              open the terminal (status card, then pick an agent)",
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
      "  oberon <sub>          AI film render from the terminal (scaffold|render|list) — see: oberon help",
      "  ontology              project-local ontology status/list/add; inside REPL use /ontology",
      "  cloud wizard <path>   create/repair agentlas.json for Cloud MCP calls",
      "  cloud security scan <path>",
      "                        risk-screen an agent folder before run/publish",
      "  cloud runtime bundle <path>",
      "                        compile manifest-based runtime bundle",
      "  cloud field-test      run local Cloud contract fixture test",
      "  cloud package <path>  package + static security review for Agentlas Cloud",
      "  cloud publish <path>  register after local review (submitter runtime only)",
      "  cloud install <slug>  download/install a cloud marketplace agent",
      "  creds save ...        save an issued key (project vault + project .env + project-scoped global env)",
      "  creds file ...        copy a credential file into signing/credentials and set an env path",
      "  update                check and install the latest Agentlas Desktop release",
      "  doctor                check runtimes and data",
      "  setup                 re-run first-launch setup (language · runtime · permission)",
      "  version               print the Agentlas CLI version",
      "",
      "Options: --runtime claude-code|codex|gemini  ·  --permission read|write|full (default write)  ·  --version",
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
  if (cmd === "version" || cmd === "--version" || cmd === "-V") return cmdVersion();
  if (cmd === "update") return cmdUpdate(rest.slice(1));

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
    case "oberon":
    case "film":
      return cmdOberon(rest.slice(1));
    case "ontology":
      return cmdOntology(rest.slice(1));
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
