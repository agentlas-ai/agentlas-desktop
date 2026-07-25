#!/usr/bin/env node
// Contract for the judged Telegram intents (electron/telegram/judged-intents.ts):
// the resident judge decides automation-report control and read-vs-write goal mode
// by meaning; the wordlists are hints and remain only the labeled fallback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.disableHardwareAcceleration();
// Hermetic: the un-injected paths must fall back deterministically, never reach a live model.
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-telegram-judged-"));
app.setPath("userData", tempDir);

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const {
      lexicalAutomationReportIntent,
      resolveTelegramAutomationReportIntent,
      resolveTelegramGoalIntent,
      lexicalTelegramWriteIntent,
    } = require("../dist/electron/telegram/judged-intents.js");

    // ── Deterministic fallback verdicts stay exactly today's regex behavior ──
    assert.equal(lexicalAutomationReportIntent("자동화 끝나면 여기로 보고해줘"), "enable");
    assert.equal(lexicalAutomationReportIntent("자동화 보고 이제 그만 꺼줘"), "disable");
    assert.equal(lexicalAutomationReportIntent("자동화 보고 상태 확인해줘"), "status");
    assert.equal(lexicalAutomationReportIntent("레딧에 올릴 글을 정리해줘"), "none");

    // (a) The judge double WINS — including phrasing every wordlist misses (Arabic).
    const judgeSays = (verdict) => async (spec) => {
      assert.equal(spec.kind, "telegram-automation-report-intent");
      assert.ok(spec.labels.includes("none"), "the judge must be allowed to answer none");
      return { verdict, source: "llm", confidence: 0.9, reason: "pinned" };
    };
    const arabicEnable = await resolveTelegramAutomationReportIntent(
      "أخبرني هنا عندما تنتهي الأتمتة في كل مرة",
      { judgeFn: judgeSays("enable") },
    );
    assert.deepEqual(arabicEnable, { intent: "enable", source: "llm" },
      "a judged enable verdict must fire on wordlist-miss phrasing");
    // A judged "none" vetoes a wordlist false positive (ordinary request mentioning automation reports).
    const veto = await resolveTelegramAutomationReportIntent(
      "자동화 보고 상태 페이지를 새로 만들어줘",
      { judgeFn: judgeSays("none") },
    );
    assert.deepEqual(veto, { intent: "none", source: "llm" },
      "a judged none verdict must override the wordlist status hit");

    // (b) No model = today's regex verdict, labeled fallback.
    const judgeDown = async (spec) => ({ verdict: spec.fallback, source: "fallback", confidence: 0, reason: "no model" });
    const fallbackStatus = await resolveTelegramAutomationReportIntent(
      "자동화 보고 상태 확인해줘",
      { judgeFn: judgeDown },
    );
    assert.deepEqual(fallbackStatus, { intent: "status", source: "fallback" });
    // Un-injected + no runtime probes: still today's verdict, labeled.
    const hermetic = await resolveTelegramAutomationReportIntent("자동화 끝나면 여기로 보고해줘", { timeoutMs: 2000 });
    assert.deepEqual(hermetic, { intent: "enable", source: "fallback" });

    // ── Goal mode (read vs write) ──
    assert.equal(lexicalTelegramWriteIntent("랜딩 페이지 만들어줘"), true);
    assert.equal(lexicalTelegramWriteIntent("서울 날씨 알려줘"), false);
    // (a) Judge double wins: an Arabic build request the verb wordlist misses.
    const arabicBuild = await resolveTelegramGoalIntent("اصنع لي صفحة هبوط لمنتجي مع نموذج تسجيل", {
      judgeBooleanFn: async (spec) => {
        assert.equal(spec.kind, "telegram-invocation-goal-mode");
        return { value: true, verdict: { verdict: "yes", source: "llm", confidence: 0.9, reason: "build request" } };
      },
    });
    assert.deepEqual(arabicBuild, { write: true, source: "llm" });
    // A judged "no" vetoes an incidental make-verb hit ("what makes a good site?").
    const readVeto = await resolveTelegramGoalIntent("What makes a good landing page? Just explain.", {
      judgeBooleanFn: async () => ({ value: false, verdict: { verdict: "no", source: "llm", confidence: 0.85, reason: "question" } }),
    });
    assert.deepEqual(readVeto, { write: false, source: "llm" });
    // (b) No model = the verb-wordlist verdict, labeled fallback.
    const goalFallback = await resolveTelegramGoalIntent("랜딩 페이지 만들어줘", {
      judgeBooleanFn: async (spec) => ({
        value: spec.fallback,
        verdict: { verdict: spec.fallback ? "yes" : "no", source: "fallback", confidence: 0, reason: "no model" },
      }),
    });
    assert.deepEqual(goalFallback, { write: true, source: "fallback" });

    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
    process.exit(exitCode);
  }
})();
