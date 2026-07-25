// Convergence smoke for the generic publish auto-fix: whatever the agent folder
// contains, packageAndReviewCloudAgent must remediate it to zero blockers and
// end in an uploadable (dry-run) package — never a dead-end block.
//
// Run: npm run build:electron && electron scripts/smoke-publish-convergence.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const { packageAndReviewCloudAgent } = require("../dist/electron/cloud-agents/package");
const { remediateBlockers } = require("../dist/electron/hephaestus/publish-autofix");

function mkAgent(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-agent-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content === "@symlink") { try { fs.symlinkSync("/usr/bin/python3", abs); } catch {} }
    else fs.writeFileSync(abs, content);
  }
  return dir;
}
function blockerFindings(review) {
  return (review?.findings ?? []).filter((f) => f.severity === "blocker");
}
let failures = 0;
const check = (name, cond, extra) => { console.log(`   ${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); if (!cond) failures++; };

// A credential-SHAPED but entirely synthetic string, assembled at runtime so no
// literal key appears in source (avoids secret-scanner false positives). It only
// exists to prove the scanner fires and the redactor removes it. NOT a live key.
const REAL_SHAPED = ["sk", "ant", "api03"].join("-") + "-" + "A9d".repeat(30);

async function main() {
  // ── ①  Mason's exact case + real secret + installer + junk, no model ──────
  console.log("\n[① 지저분한 에이전트 전부 → 결정적 경로(모델 없음)로도 무조건 업로드까지 수렴]");
  const junky = mkAgent({
    "agent.md": "# 주식 시세 봇\nKIS 오픈API로 국내 주식 현재가를 조회하는 에이전트.\n",
    ".agentlas/agent-card.json": JSON.stringify({
      name: "주식 시세 봇", tagline: "국내 주식 현재가 조회",
      localized: { titleEn: "Stock Price Bot", titleKo: "주식 시세 봇", descriptionEn: "Looks up Korean stock prices.", descriptionKo: "국내 주식 현재가를 조회합니다." },
    }),
    // Mason's false positive: documentation placeholders that trip the keyword heuristic.
    "references/byok.md": "# BYOK\n- Anthropic: `x-api-key: sk-ant-...`\n- Moonshot: `Authorization: Bearer sk-moon-...`\n필드명 예시: authHeader: \"x-api-key\"\n",
    // A real-shaped secret embedded inside a KEPT content file → must be redacted, not blocked.
    "config/notes.md": `설정 예시\n\napi_key = "${REAL_SHAPED}"\n계속 사용하세요.\n`,
    // Remote-shell installer → defanged or excluded.
    "install.md": "# 설치\n```\ncurl https://example.com/install.sh | bash\n```\n",
    // Deterministic file-backstop cases.
    ".env": `KIS_APP_SECRET=${REAL_SHAPED}\n`,
    ".venv/pyvenv.cfg": "home=/usr\n",
    ".venv/bin/python": "@symlink",
    "__pycache__/x.pyc": "junk",
  });
  const t0 = Date.now();
  const res = await packageAndReviewCloudAgent(
    { rootPath: junky, visibility: "marketplace", dryRun: true },
    { activeRuntime: null, locale: "ko" },
  ).catch((e) => ({ status: "error", _err: String(e) }));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   status=${res.status} (${secs}s)${res._err ? " err=" + res._err.slice(0, 160) : ""}`);
  const blk = blockerFindings(res.review);
  check("blocked 아님 (수렴해서 업로드 가능)", res.status !== "blocked" && res.status !== "error", `status=${res.status}`);
  check("blocker finding 0개", blk.length === 0, blk.map((f) => f.file + ":" + f.id).join(", "));
  check("remediation 액션 기록됨", Array.isArray(res.remediation) && res.remediation.length > 0,
    (res.remediation || []).map((a) => `${a.action}:${a.file}`).slice(0, 8).join(" | "));

  // 사용자 원본 폴더는 절대 안 바뀜
  check("원본 references/byok.md 무손상", fs.readFileSync(path.join(junky, "references/byok.md"), "utf8").includes("sk-ant-..."));
  check("원본 .env 무손상", fs.existsSync(path.join(junky, ".env")));

  // 업로드 번들에 진짜 시크릿 값이 없어야 (리댁트/제외 확인)
  if (res.bundlePath && fs.existsSync(res.bundlePath)) {
    const bundle = fs.readFileSync(res.bundlePath, "utf8");
    check("업로드 번들에 진짜 시크릿 값 없음", !bundle.includes(REAL_SHAPED));
    check("업로드 번들에 .env / .venv 없음", !/"path":\s*"\.env"|"path":\s*"\.venv\//.test(bundle));
  } else {
    check("bundlePath 존재", false, "no bundle");
  }
  fs.rmSync(junky, { recursive: true, force: true });

  // ── ②  깨끗한 에이전트 → remediation 없이 그대로 통과 ──────────────────
  console.log("\n[② 깨끗한 에이전트 → 손 안 대고 통과]");
  const clean = mkAgent({
    "agent.md": "# helper\nA plain assistant that summarizes text.\n",
    ".agentlas/agent-card.json": JSON.stringify({
      name: "helper", tagline: "summarize",
      localized: { titleEn: "Helper", titleKo: "도우미", descriptionEn: "Summarizes text.", descriptionKo: "텍스트를 요약합니다." },
    }),
  });
  const res2 = await packageAndReviewCloudAgent(
    { rootPath: clean, visibility: "marketplace", dryRun: true },
    { activeRuntime: null, locale: "ko" },
  ).catch((e) => ({ status: "error", _err: String(e) }));
  console.log(`   status=${res2.status}`);
  check("blocked 아님", res2.status !== "blocked" && res2.status !== "error");
  // A clean agent's content is never touched; a routing card may still be
  // auto-generated (that is provisioning, not mangling).
  const contentEdits = (res2.remediation || []).filter((a) => a.action === "redacted" || a.action === "excluded");
  check("깨끗본 내용은 손 안 댐 (redact/exclude 0)", contentEdits.length === 0,
    contentEdits.map((a) => `${a.action}:${a.file}`).join(","));
  fs.rmSync(clean, { recursive: true, force: true });

  // ── ③  remediateBlockers 단위: 결정적 시크릿 리댁트 ───────────────────
  console.log("\n[③ remediateBlockers 단위 — 결정적 시크릿 리댁트]");
  const unit = mkAgent({ "keys.md": `token = "${REAL_SHAPED}"\n` });
  const r = await remediateBlockers({
    folder: unit,
    blockers: [{ id: "generic-unquoted-secret::keys.md", file: "keys.md", category: "secret", message: "unquoted credential value" }],
    active: null,
    deterministicOnly: true,
    locale: "ko",
  });
  const after = fs.readFileSync(path.join(unit, "keys.md"), "utf8");
  check("시크릿 값 리댁트됨", !after.includes(REAL_SHAPED), after.trim().slice(0, 60));
  check("changed=true + redacted 액션", r.changed && r.actions.some((a) => a.action === "redacted"));
  fs.rmSync(unit, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? "✅ 전체 통과" : `❌ ${failures}개 실패`}  — smoke-publish-convergence`);
  app.exit(failures === 0 ? 0 : 1);
}
app.whenReady().then(main).catch((e) => { console.error("SMOKE FAIL:", e); app.exit(1); });
