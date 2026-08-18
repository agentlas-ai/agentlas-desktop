#!/usr/bin/env node
/*
 * Core → Desktop 코드젠: 소스 실패 코드 목록 하나만.
 *
 * 병(실측): Core(agentlas_cloud/workforce/federation.py)는 19개를 올리는데
 * Desktop의 workforce-orchestrator.ts는 손으로 적은 18개를 갖고 있었다. 빠진 것은
 * `source_circuit_open` — Core가 source_service.py에서 실제로 올리는 코드다.
 * 영수증 검증(workforce-orchestrator.ts)이 그 코드를 못 알아보고 영수증 자체를
 * `hub_source_receipt_invalid`로 판정해, 사용자에게는 "차단기가 열렸으니 재시도"가
 * 아니라 "영수증이 잘못됐다"고 나갔다. 정본이 하나이므로 손 목록은 없어야 한다.
 *
 *   node scripts/gen-workforce-source-failure-codes.cjs          생성물을 쓴다
 *   node scripts/gen-workforce-source-failure-codes.cjs --check  다르면 실패한다
 *
 * 정본: Agentlas-OS/agentlas_cloud/workforce/federation.py
 *       WORKFORCE_SOURCE_FAILURE_CODES
 * 생성물: electron/mcp-tools/workforce-protocol-contract.json
 *       sourceFailureCodes (top-level; protocolMetadata must mirror Core's advertised keys EXACTLY, and Core does not advertise the codes there)
 *
 * Agentlas-OS가 체크아웃돼 있지 않은 머신에서는 사유를 찍고 SKIP한다 — 부재를
 * 통과로 위장하지 않되, 저장소 하나만 가진 개발자를 막지도 않는다.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const contractFile = path.join(root, "electron", "mcp-tools", "workforce-protocol-contract.json");
const coreRoot = process.env.AGENTLAS_OS_REPO || path.resolve(root, "..", "Agentlas-OS");
const coreFile = path.join(coreRoot, "agentlas_cloud", "workforce", "federation.py");

const check = process.argv.includes("--check");

if (!fs.existsSync(coreFile)) {
  console.log(
    `SKIP workforce source failure codes — Core가 없다: ${coreFile}\n` +
      "  (Agentlas-OS를 형제 디렉터리로 체크아웃하거나 AGENTLAS_OS_REPO를 지정하면 검사한다)",
  );
  process.exit(0);
}

const coreSrc = fs.readFileSync(coreFile, "utf8");
const block = /^WORKFORCE_SOURCE_FAILURE_CODES = \(\n([\s\S]*?)\n\)/m.exec(coreSrc);
if (!block) {
  console.error("CONFORMANCE_GATE_FAILED — Core에서 WORKFORCE_SOURCE_FAILURE_CODES를 찾지 못했다.");
  console.error(`  파일: ${coreFile}`);
  process.exit(1);
}
const codes = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
if (codes.length === 0) {
  console.error("CONFORMANCE_GATE_FAILED — Core의 소스 실패 코드 목록이 비어 있다.");
  process.exit(1);
}
if (new Set(codes).size !== codes.length) {
  console.error("CONFORMANCE_GATE_FAILED — Core의 소스 실패 코드에 중복이 있다.");
  process.exit(1);
}

const contract = JSON.parse(fs.readFileSync(contractFile, "utf8"));
const current = contract.sourceFailureCodes;
const same = Array.isArray(current) && current.length === codes.length
  && current.every((code, i) => code === codes[i]);

if (check) {
  if (!same) {
    const missing = codes.filter((code) => !(current || []).includes(code));
    const extra = (current || []).filter((code) => !codes.includes(code));
    console.error("CONFORMANCE_GATE_FAILED — Desktop의 소스 실패 코드가 Core와 다르다.");
    if (missing.length) console.error(`  Desktop에 없는 코드: ${missing.join(", ")}`);
    if (extra.length) console.error(`  Core에 없는 코드: ${extra.join(", ")}`);
    if (!missing.length && !extra.length) console.error("  순서가 다르다(정본 순서를 그대로 쓴다).");
    console.error("  고치는 법: node scripts/gen-workforce-source-failure-codes.cjs");
    process.exit(1);
  }
  console.log(`ok workforce source failure codes (${codes.length}) — Core와 일치`);
  process.exit(0);
}

if (same) {
  console.log(`unchanged — workforce source failure codes (${codes.length})`);
  process.exit(0);
}
// ★최상위 필드로 쓴다 — protocolMetadata는 Core가 광고하는 키 집합과 정확히
// 일치해야 하고(client.ts의 exact key check), Core는 실패 코드를 거기 광고하지
// 않는다. v1.0.25 프리플라이트가 이 배치 오류를 "metadata keys are incompatible"로
// 실측해 잡았다.
delete contract.protocolMetadata.sourceFailureCodes;
contract.sourceFailureCodes = codes;
fs.writeFileSync(contractFile, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(root, contractFile)} — ${codes.length} source failure codes from Core`);
