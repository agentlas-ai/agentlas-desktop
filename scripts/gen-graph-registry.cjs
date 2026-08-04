#!/usr/bin/env node
/*
 * 레지스트리 → 코드 생성 (06 §2.1 "사본 금지(WP-R4)", §13.3 "3목록 코드젠 지점").
 *
 * 왜: 레지스트리가 **대조만** 하면 손으로 쓴 선언이 여전히 남고, 드리프트는
 * 검출은 되지만 계속 생긴다. 한 선언에서 코드를 만들면 두 번째 선언 자체가 없다.
 *
 *   node scripts/gen-graph-registry.cjs          생성물을 쓴다
 *   node scripts/gen-graph-registry.cjs --check  다르면 실패한다 (CI·게이트용)
 *
 * ★생성물을 손으로 고쳐 게이트를 통과시키는 것은 금지 — 다음 생성에서 소실된다.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const regDir = path.join(root, "shared", "graph-registry");
const outFile = path.join(root, "shared", "graph-vocabulary.generated.ts");

const read = (name) => JSON.parse(fs.readFileSync(path.join(regDir, `${name}.json`), "utf8"));
const errors = read("errors");
const journal = read("journal");
const blocks = read("blocks");
const fields = read("fields");

const quoted = (values) => values.map((v) => `"${v}"`).join(" | ");
const list = (values) => values.map((v) => `  "${v}",`).join("\n");

// 제품이 실제로 내는 코드만 상수로 만든다. specified(스펙만)는 아직 코드가 아니고,
// tooling(게이트 러너용)은 제품 어휘가 아니다 — 섞으면 "있는 것"과 "있을 것"이 뭉개진다.
const liveErrors = errors.errors
  .filter((e) => e.status === "implemented")
  .map((e) => e.code)
  .sort();
const journalKinds = journal.kinds.map((k) => k.kind).sort();
const nodeKinds = blocks.blocks.map((b) => b.kind).filter((k) => k !== "loop").sort();

// 카드 매핑은 06 §8.2가 "빌드타임 생성되는 1벌"로 못박은 것 — 손으로 쓴 두 번째 표 금지.
const cardMap = errors.errors
  .filter((e) => e.cardKey)
  .sort((a, b) => (a.code < b.code ? -1 : 1))
  .map((e) => `  ${e.code}: { cardKey: "${e.cardKey}", nextActions: [${(e.nextActions ?? []).map((a) => `"${a}"`).join(", ")}] },`)
  .join("\n");
const verbatimCodes = errors.errors.filter((e) => e.verbatim === true).map((e) => e.code).sort();

// 필드 등급표 — 미지값을 어떻게 다뤄야 하는지 코드가 물어볼 수 있게.
const gradeMap = fields.fields
  .slice()
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .map((f) => `  ${JSON.stringify(f.name)}: "${f.grade}",`)
  .join("\n");

const banner = `// ⚠️ 생성된 파일입니다. 손으로 고치지 마세요 — 다음 생성에서 사라집니다.
//
// 정본: shared/graph-registry/*.json
// 생성: node scripts/gen-graph-registry.cjs
// 검사: node scripts/gen-graph-registry.cjs --check  (게이트가 이걸 부릅니다)
//
// 왜 생성하는가 (06 §2.1 WP-R4 "사본 금지"):
//   같은 어휘를 두 곳에 손으로 쓰면 반드시 갈라진다. 이 저장소는 그 사고를
//   여러 번 겪었다 — 스펙은 정본대로인데 코드는 자기 이름을 쓰고 있었다.
//   선언은 한 곳(레지스트리)이고 코드는 여기서 나온다.
`;

const body = `${banner}
/** 이 계층의 네임스페이스. 미지 major는 fail-closed. */
export const GRAPH_WIRE = "graph/1" as const;

/** 제품이 실제로 내는 오류 코드 전부. 여기 없는 코드를 내면 적합성 게이트가 실패한다. */
export const GRAPH_ERROR_CODES = [
${list(liveErrors)}
] as const;
export type GraphErrorCode = (typeof GRAPH_ERROR_CODES)[number];

/** 저널 종류. 06 §7 — 전부 uiKey 또는 no-ui를 갖는다. */
export const GRAPH_JOURNAL_KINDS = [
${list(journalKinds)}
] as const;
export type GraphJournalKindGenerated = (typeof GRAPH_JOURNAL_KINDS)[number];

/** 노드 종류. 반복(loop)은 노드가 아니라 그래프의 성질이라 여기 없다. */
export const GRAPH_NODE_KINDS = [
${list(nodeKinds)}
] as const;
export type GraphNodeKindGenerated = (typeof GRAPH_NODE_KINDS)[number];

/**
 * 오류 코드 → 화면 카드 매핑 **1벌** (06 §8.2).
 * 손으로 쓴 두 번째 매핑 표가 발견되면 게이트 실패다.
 */
export const GRAPH_ERROR_CARDS: Record<string, { cardKey: string; nextActions: string[] }> = {
${cardMap}
};

/**
 * 카드 어휘가 없는 코드 — **원문 그대로** 노출한다(제목=코드, 본문=사유).
 * 조용한 삼킴 금지: 매핑이 없다고 오류를 안 보여주는 것이 가장 나쁘다.
 */
export const GRAPH_VERBATIM_CODES = [
${list(verbatimCodes)}
] as const;

/**
 * 필드 등급 (06 §2.3). 모르는 값을 만났을 때 어떻게 할지가 여기서 나온다:
 *   critical   → 거절 + 코드 (fail-closed)
 *   degradable → 그 항목만 강등, 나머지는 정상 처리
 *   extension  → must-ignore 하되 버리지 말고 통과
 */
export const GRAPH_FIELD_GRADES: Record<string, "critical" | "degradable" | "extension"> = {
${gradeMap}
};

/**
 * ★모르는 값을 만났을 때 **그 항목만** 강등한다 (06 §2.3 degradable / §2.5).
 *
 * 이 함수가 있는 이유: 이 플랫폼은 "닫힌 열거형에 클라이언트가 모르는 값 1개가 오자
 * **후보집합을 통째로 폐기**한" 사고를 겪었다. 런타임 구버전은 코드 23개만 알고
 * 신버전은 33개를 보내는데, 구버전이 모르는 1개를 만나면 전부 버렸다.
 *
 * 표면끼리 판이 다른 것은 정상이다(데스크탑이 스키마 정본이고 터미널은 뒤따라온다).
 * 그러니 모르는 값은 **원문을 보존한 채** 항목 단위로 강등하고 나머지는 정상 처리한다.
 * 집합 폐기·스트림 절단·에러 승격은 전부 금지.
 */
export type Degradable<T extends string> = { known: T } | { unknown: string };

export function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): Degradable<T> {
  const text = typeof value === "string" ? value : String(value ?? "");
  return (allowed as readonly string[]).includes(text)
    ? { known: text as T }
    : { unknown: text };
}

/** 강등된 항목을 사람에게 보여줄 문구. **원문을 지우지 않는다.** */
export function degradedLabel(value: Degradable<string>, locale: "ko" | "en" = "ko"): string {
  if ("known" in value) return value.known;
  return locale === "ko"
    ? \`알 수 없음 (원문: \${value.unknown})\`
    : \`unknown (raw: \${value.unknown})\`;
}

/** 목록에서 모르는 항목만 강등하고 **아무것도 버리지 않는다**. */
export function readEnumList<T extends string>(
  values: readonly unknown[],
  allowed: readonly T[],
): Degradable<T>[] {
  return values.map((value) => readEnum(value, allowed));
}

/** 이 코드를 사람에게 어떻게 보여줄지. 매핑이 없으면 원문 노출이 정답이다. */
export function graphErrorPresentation(code: string): {
  cardKey: string | null;
  nextActions: string[];
  verbatim: boolean;
} {
  const mapped = GRAPH_ERROR_CARDS[code];
  if (mapped) return { cardKey: mapped.cardKey, nextActions: mapped.nextActions, verbatim: false };
  return { cardKey: null, nextActions: [], verbatim: true };
}
`;

// ── 터미널 미러 (CJS) ──────────────────────────────────────────────────────
// 06 §13.3 "3목록 코드젠": 한 선언에서 여러 표면이 나온다. 터미널은 데스크탑과 **같은
// SQLite**를 읽는데 스키마 판이 뒤따라오므로(터미널 v86 vs 데스크탑 v89), 모르는 값을
// 만나는 일이 정상적으로 일어난다. 그때 통째로 버리지 않게 같은 어휘를 준다.
const terminalOut = path.resolve(root, "..", "agentlas_terminal", "engine", "graph", "vocabulary.generated.cjs");
const terminalBody = `// ⚠️ 생성된 파일입니다. 손으로 고치지 마세요.
// 정본: agentlas_desktop/shared/graph-registry/*.json
// 생성: (agentlas_desktop) node scripts/gen-graph-registry.cjs
//
// 터미널은 데스크탑과 같은 DB를 읽지만 스키마 판이 뒤따라온다. 모르는 값을 만나는 것은
// 고장이 아니라 정상이며, 그때 **그 항목만** 강등하고 나머지는 정상 처리한다.
"use strict";

const GRAPH_WIRE = "graph/1";
const GRAPH_ERROR_CODES = ${JSON.stringify(liveErrors)};
const GRAPH_JOURNAL_KINDS = ${JSON.stringify(journalKinds)};
const GRAPH_NODE_KINDS = ${JSON.stringify(nodeKinds)};

/** 모르는 값은 원문을 보존한 채 항목 단위로 강등한다. 집합 폐기 금지. */
function readEnum(value, allowed) {
  const text = typeof value === "string" ? value : String(value == null ? "" : value);
  return allowed.includes(text) ? { known: text } : { unknown: text };
}

function degradedLabel(value, lang) {
  if (value && typeof value === "object" && "known" in value) return value.known;
  const raw = value && value.unknown ? value.unknown : "";
  return lang === "en" ? \`unknown (raw: \${raw})\` : \`알 수 없음 (원문: \${raw})\`;
}

module.exports = {
  GRAPH_WIRE, GRAPH_ERROR_CODES, GRAPH_JOURNAL_KINDS, GRAPH_NODE_KINDS,
  readEnum, degradedLabel,
};
`;

if (process.argv.includes("--check")) {
  if (fs.existsSync(path.dirname(terminalOut))) {
    if (!fs.existsSync(terminalOut) || fs.readFileSync(terminalOut, "utf8") !== terminalBody) {
      console.error("CONFORMANCE_GATE_FAILED — 터미널 미러가 레지스트리와 다릅니다(G3).");
      console.error("  고치는 법: node scripts/gen-graph-registry.cjs");
      process.exit(1);
    }
  }
}

if (process.argv.includes("--check")) {
  if (!fs.existsSync(outFile)) {
    console.error(`CONFORMANCE_GATE_FAILED — 생성물이 없습니다: ${path.relative(root, outFile)}`);
    console.error("  고치는 법: node scripts/gen-graph-registry.cjs");
    process.exit(1);
  }
  const current = fs.readFileSync(outFile, "utf8");
  if (current !== body) {
    console.error("CONFORMANCE_GATE_FAILED — 레지스트리와 생성물이 다릅니다(G1).");
    console.error("  고치는 법: node scripts/gen-graph-registry.cjs 를 다시 돌리고 커밋하세요.");
    console.error("  ★생성물을 손으로 고쳐 통과시키지 마세요 — 다음 생성에서 사라집니다.");
    process.exit(1);
  }
  console.log(
    `graph registry codegen ok — 오류 ${liveErrors.length} · 저널 ${journalKinds.length} · `
    + `노드 ${nodeKinds.length} · 카드매핑 ${Object.keys(errors.errors.filter((e) => e.cardKey)).length} · `
    + `필드등급 ${fields.fields.length}`,
  );
  process.exit(0);
}

fs.writeFileSync(outFile, body);
console.log(`생성: ${path.relative(root, outFile)}`);
if (fs.existsSync(path.dirname(terminalOut))) {
  fs.writeFileSync(terminalOut, terminalBody);
  console.log(`생성: ${terminalOut}`);
} else {
  console.log("  (터미널 저장소가 없어 미러는 건너뜀 — 같이 있을 때만 만듭니다)");
}
console.log(`  오류 코드 ${liveErrors.length} · 저널 kind ${journalKinds.length} · 노드 종류 ${nodeKinds.length} · 필드 등급 ${fields.fields.length}`);
