#!/usr/bin/env node
// Contract for the renderer judged style/format sites (batch: renderer bridge):
//   - trex routeStyleJudged / routeModeJudged
//   - cardnews isCardnewsAppJudged
//   - generated-app resolveGeneratedAppVisualOutput (+ blueprint override)
//   - the judgeLabelViaBridge helper's bridge/no-bridge contract
// Pattern under test: explicit user choice wins upstream (closed-form); the
// judged verdict decides; with NO bridge/model verdict the site returns the
// NEUTRAL non-keyword default (never the wordlist guess). The keyword tables
// survive only as the judge's prior.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

// Mutable judgment double, swapped between cases.
const judgmentDouble = {
  judgeLabelViaBridge: async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "default double" }),
  judgeSubsetViaBridge: async () => ({ selected: [], source: "fallback", reason: "default double" }),
};

const moduleCache = new Map();
function loadTs(relPath, extraMap = {}) {
  const abs = path.join(root, relPath);
  if (moduleCache.has(abs)) return moduleCache.get(abs).exports;
  const source = fs.readFileSync(abs, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} };
  moduleCache.set(abs, mod);
  const localRequire = (specifier) => {
    if (specifier in extraMap) return extraMap[specifier];
    if (specifier === "@/lib/judgment") return judgmentDouble;
    if (specifier === "@shared/brand-safety") return require(path.join(root, "dist/shared/brand-safety.js"));
    if (specifier.startsWith("@/") || specifier.startsWith("@shared/")) return {};
    if (specifier.startsWith(".")) {
      const resolved = path.join(path.dirname(abs), `${specifier}.ts`);
      // The engines import ./judgment relatively; route them to the double too.
      if (path.relative(root, resolved) === path.join("renderer", "lib", "judgment.ts")) return judgmentDouble;
      return loadTs(path.relative(root, resolved), extraMap);
    }
    return require(specifier);
  };
  Function("exports", "module", "require", output)(mod.exports, mod, localRequire);
  return mod.exports;
}

(async () => {
  // ── trex style routing ──
  const styles = loadTs("renderer/lib/trex/styles.ts");
  const arabicBusinessTopic = "عرض نتائج الربع المالي الثالث لمجلس الإدارة مع مؤشرات الأداء";
  assert.equal(styles.routeStyle(arabicBusinessTopic), null, "documented wordlist miss: Arabic business topic");
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    assert.equal(spec.kind, "trex-style-route");
    assert.ok(spec.labels.includes("none"), "none must stay a valid style verdict");
    return { verdict: "consulting", source: "llm", reason: "quarterly board reporting" };
  };
  assert.equal(await styles.routeStyleJudged(arabicBusinessTopic), "consulting",
    "the judged verdict must pick a style the wordlists missed");
  judgmentDouble.judgeLabelViaBridge = async () => ({ verdict: "none", source: "llm", reason: "keep default" });
  assert.equal(await styles.routeStyleJudged("리뷰 정리해줘 (보고 아님)"), null,
    "a judged none must veto an incidental wordlist hit");
  judgmentDouble.judgeLabelViaBridge = async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "no model" });
  // NO model → null (neutral legacy look), NOT the keyword style the router would give.
  assert.equal(styles.routeStyle("분기 실적 보고 자료"), "consulting", "the keyword router alone WOULD pick a style");
  assert.equal(await styles.routeStyleJudged("분기 실적 보고 자료"), null,
    "no model must not keyword-infer a style — it keeps the neutral default");

  // ── trex mode routing ──
  const model = loadTs("renderer/lib/trex/model.ts");
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    assert.equal(spec.kind, "trex-mode-route");
    return { verdict: "diagrammatic", source: "llm", reason: "academic mechanism" };
  };
  assert.equal(await model.routeModeJudged("شرح آلية التفاعل الكيميائي للندوة الأكاديمية"), "diagrammatic",
    "the judged mode must fire on wordlist-miss phrasing");
  judgmentDouble.judgeLabelViaBridge = async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "no model" });
  // NO model → the neutral base mode "editorial", NOT the keyword mode.
  assert.equal(model.routeMode("월드컵 순위 정리"), "hybrid", "the keyword router alone WOULD pick hybrid");
  assert.equal(await model.routeModeJudged("월드컵 순위 정리"), "editorial",
    "no model must not keyword-infer a mode — it keeps the neutral editorial base");
  assert.equal(model.routeMode("random topic"), "editorial", "deterministic default unchanged");

  // ── cardnews detection ──
  const cardnews = loadTs("renderer/lib/cardnews-engine.ts");
  const appRecord = (fields) => ({ appName: fields.name, manifest: { title: fields.title ?? "", app: { tagline: fields.tagline ?? "" }, widgets: [] } });
  const arabicCardApp = appRecord({ name: "صانع بطاقات", title: "منشورات دوّارة للشبكات الاجتماعية", tagline: "صور متسلسلة" });
  assert.equal(cardnews.isCardnewsApp(arabicCardApp), false, "documented wordlist miss");
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    assert.equal(spec.kind, "cardnews-app-detect");
    return { verdict: "yes", source: "llm", reason: "carousel maker" };
  };
  assert.equal(await cardnews.isCardnewsAppJudged(arabicCardApp), true,
    "the judged verdict must recognize a card-news app the wordlist missed");
  judgmentDouble.judgeLabelViaBridge = async () => ({ verdict: "no", source: "llm", reason: "insta-cart grocery app" });
  assert.equal(await cardnews.isCardnewsAppJudged(appRecord({ name: "Insta-cart order helper" })), false,
    "a judged no must veto the insta substring false positive");
  judgmentDouble.judgeLabelViaBridge = async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "no model" });
  const cardKeywordApp = appRecord({ name: "카드뉴스 메이커" });
  assert.equal(cardnews.isCardnewsApp(cardKeywordApp), true, "the wordlist alone WOULD flag this as card-news");
  assert.equal(await cardnews.isCardnewsAppJudged(cardKeywordApp), false,
    "no model → neutral 'not card-news', never the keyword verdict");

  // ── generated-app visual output ──
  const generated = loadTs("renderer/lib/generated-app-engine.ts");
  const visualApp = { appName: "لوحات إعلانات", id: "app1", manifest: { title: "منشئ ملصقات", domain: "marketing", layout: "service-app", app: { tagline: "ملصقات تسويقية للحملات" } } };
  assert.equal(generated.lexicalGeneratedAppVisualOutput(visualApp), false, "documented wordlist miss");
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    assert.equal(spec.kind, "generated-app-visual-output");
    return { verdict: "yes", source: "llm", reason: "poster maker" };
  };
  assert.equal(await generated.resolveGeneratedAppVisualOutput(visualApp), true);
  // The blueprint override is closed-form: the caller passes the judged verdict in.
  const overridden = generated.buildGeneratedAppBlueprint(visualApp, "en", { isVisualOutputOverride: true });
  assert.equal(overridden.isVisualOutput, true);
  assert.deepEqual(overridden.exportFormats, ["png", "jpg", "json", "markdown"]);
  // A keyword-visual app: the wordlist WOULD say visual, but no override / no model
  // must NOT keyword-infer it.
  const koreanVisualApp = { appName: "카드 디자인 스튜디오", id: "app2", manifest: { title: "카드 이미지 메이커", domain: "creative", layout: "creative-studio", app: { tagline: "인스타 카드 이미지 디자인" } } };
  assert.equal(generated.lexicalGeneratedAppVisualOutput(koreanVisualApp), true, "the wordlist alone WOULD flag this app visual");
  const fallbackBlueprint = generated.buildGeneratedAppBlueprint(koreanVisualApp, "en");
  assert.equal(fallbackBlueprint.isVisualOutput, false, "no judged override → neutral non-visual, never the keyword verdict");
  judgmentDouble.judgeLabelViaBridge = async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "no model" });
  assert.equal(await generated.resolveGeneratedAppVisualOutput(koreanVisualApp), false,
    "no model → neutral non-visual, never the keyword verdict");

  // ── oberon judged brief (format/genre/tone/setting) ──
  const infer = loadTs("renderer/lib/oberon/infer.ts");
  const arabicBrief = {
    title: "إعلان المقهى",
    prompt: "أعلن عن مقهى دافئ في ثلاثين ثانية بمشاعر حميمة داخل مقهى صغير",
    references: [],
    locale: "en",
  };
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    if (spec.kind === "oberon-brief-format") return { verdict: "commercial_30", source: "llm", reason: "30s ad" };
    if (spec.kind === "oberon-brief-genre") return { verdict: "commercial", source: "llm", reason: "ad" };
    if (spec.kind === "oberon-brief-setting") return { verdict: "카페", source: "llm", reason: "café" };
    throw new Error(`unexpected kind ${spec.kind}`);
  };
  judgmentDouble.judgeSubsetViaBridge = async (spec) => {
    assert.equal(spec.kind, "oberon-brief-tone");
    return { selected: ["warm"], source: "llm", reason: "cozy" };
  };
  const judgedBrief = await infer.judgeBriefFromPrompt(arabicBrief);
  assert.equal(judgedBrief.format, "commercial_30", "the judged format must fire on wordlist-miss phrasing");
  assert.equal(judgedBrief.genre, "commercial");
  assert.deepEqual(judgedBrief.tone, ["warm", "cinematic"], "judged tones keep the cinematic baseline");
  assert.equal(judgedBrief.setting, "카페", "a judged setting the prompt never spelled out is honored");
  assert.equal(judgedBrief.durationSec, 30, "duration follows the judged format");
  // Explicit user-picked format is closed-form: never judged, never overridden.
  judgmentDouble.judgeLabelViaBridge = async (spec) => {
    assert.notEqual(spec.kind, "oberon-brief-format", "an explicit format must never reach the judge");
    return { verdict: spec.fallback, source: "fallback", reason: "no model" };
  };
  judgmentDouble.judgeSubsetViaBridge = async () => ({ selected: [], source: "fallback", reason: "no model" });
  const explicitFormat = await infer.judgeBriefFromPrompt({ ...arabicBrief, format: "trailer" });
  assert.equal(explicitFormat.format, "trailer");
  assert.equal(explicitFormat.aspect, "2.39:1");
  // NO model → the NEUTRAL non-keyword brief (explicit format kept), never the
  // wordlist inference.
  judgmentDouble.judgeLabelViaBridge = async (spec) => ({ verdict: spec.fallback, source: "fallback", reason: "no model" });
  judgmentDouble.judgeSubsetViaBridge = async () => ({ selected: [], source: "fallback", reason: "no model" });
  const keywordBrief = { title: "우주 전투", prompt: "우주에서 벌어지는 로봇 액션 예고편, 네온 톤, 우주 기지 배경", references: [], locale: "ko" };
  const keywordInferred = infer.inferBriefFromPrompt(keywordBrief);
  assert.equal(keywordInferred.genre, "scifi", "the wordlist inference alone WOULD pick a keyword genre");
  assert.equal(keywordInferred.format, "trailer", "the wordlist inference alone WOULD pick a keyword format");
  const fallbackBrief = await infer.judgeBriefFromPrompt(keywordBrief);
  assert.deepEqual(fallbackBrief, infer.neutralBriefFromPrompt(keywordBrief),
    "no model must produce the NON-keyword neutral brief");
  assert.notEqual(fallbackBrief.genre, keywordInferred.genre, "the no-model brief must not equal the keyword genre");
  assert.equal(fallbackBrief.genre, "commercial", "neutral genre follows the base format, not keywords");
  assert.equal(fallbackBrief.setting, "", "no-model setting is empty, never keyword-extracted");

  // ── judgeLabelViaBridge contract ──
  let bridgeApi = null;
  const judgment = loadTs("renderer/lib/judgment.ts", { "./ipc": { ipc: () => bridgeApi } });
  const spec = { kind: "trex-mode-route", labels: ["editorial", "hybrid"], input: "topic", fallback: "editorial" };
  assert.deepEqual(await judgment.judgeLabelViaBridge(spec), {
    verdict: "editorial", source: "fallback", reason: "judgment bridge unavailable",
  }, "no preload bridge = labeled fallback, never a throw");
  bridgeApi = { judgment: { judge: async () => ({ verdict: "hybrid", source: "llm", confidence: 0.9, reason: "sports" }) } };
  assert.equal((await judgment.judgeLabelViaBridge(spec)).verdict, "hybrid", "an llm verdict from the bridge decides");
  bridgeApi = { judgment: { judge: async () => ({ verdict: "not-a-label", source: "llm", confidence: 0.9, reason: "?" }) } };
  assert.equal((await judgment.judgeLabelViaBridge(spec)).verdict, "editorial",
    "an out-of-label bridge verdict falls back to the deterministic choice");
  bridgeApi = { judgment: { judge: async () => { throw new Error("ipc down"); } } };
  assert.equal((await judgment.judgeLabelViaBridge(spec)).source, "fallback", "a bridge failure is a labeled fallback");

  console.log(JSON.stringify({ ok: true }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
