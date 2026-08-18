#!/usr/bin/env node
/*
 * shared/upload-scan-catalog.generated.ts 가 정본과 같은지 확인한다.
 *
 * 정본: agentlas/AgentsAtlas/app/src/lib/agentlas-cloud/upload-scan-catalog.json
 * 생성: (agentlas/AgentsAtlas/app) node scripts/gen-upload-scan-catalog.mjs
 *
 * 왜 이 게이트가 필요한가: 업로드/시크릿 스캔 어휘를 세 제품이 각자 손으로
 * 적어 두었고 이미 갈려 있었다. `.bat`·`.cmd`·`.jsx` 는 데스크탑만 스캔해서
 * 서버(등록 API)와 터미널 업로드는 그 파일들을 열지도 않았고, `.studio-runtime`
 * 은 터미널만 건너뛰어 데스크탑이 로컬 스튜디오 런타임 상태를 허브로 올렸다.
 *
 * 웹 저장소가 없으면 사유를 찍고 SKIP한다 — 부재를 통과로 위장하지 않는다.
 */
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const generated = path.join(root, "shared", "upload-scan-catalog.generated.ts");
const webApp = process.env.AGENTLAS_WEB_APP
  || path.resolve(root, "..", "agentlas", "AgentsAtlas", "app");
const generator = path.join(webApp, "scripts", "gen-upload-scan-catalog.mjs");

if (!fs.existsSync(generated)) {
  console.error("CONFORMANCE_GATE_FAILED — shared/upload-scan-catalog.generated.ts 가 없다.");
  console.error("  고치는 법: (agentlas/AgentsAtlas/app) node scripts/gen-upload-scan-catalog.mjs");
  process.exit(1);
}
if (!fs.existsSync(generator)) {
  console.log(
    `SKIP upload-scan-catalog — 정본 저장소가 없다: ${generator}\n` +
      "  (agentlas 를 형제 디렉터리로 체크아웃하거나 AGENTLAS_WEB_APP 을 지정하면 검사한다)",
  );
  process.exit(0);
}

try {
  const out = execFileSync(process.execPath, [generator, "--check"], {
    cwd: webApp,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(out);
  console.log("ok upload-scan-catalog — 정본과 일치");
} catch (error) {
  process.stdout.write(error.stdout || "");
  process.stderr.write(error.stderr || "");
  console.error("CONFORMANCE_GATE_FAILED — 업로드 스캔 카탈로그가 정본과 다르다.");
  process.exit(1);
}
