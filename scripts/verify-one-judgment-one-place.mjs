#!/usr/bin/env node
// 판정은 한 곳에서만 한다 — 사본 스캐너.
//
// 왜 이 게이트가 필요한가 (오너 질문 2026-08-20: "사본이 왜 많아").
// 그래프에서 반복해서 묻는 질문은 둘뿐이다:
//   ① 이 **노드**가 바깥을 바꾸나
//   ② 이 **도구 호출**이 바깥을 바꿨나
// 그런데 이 둘의 답이 손으로 쓴 사본으로 흩어져 있었고, 사본마다 아는 범위가 달랐다.
// 오늘 실측한 것만:
//   · code 노드 mutation 이 재생 보호 밖 → 이미 나간 발송이 그래프 편집 후 다시 나감
//   · `list_dir` 이 "메일 보냄"의 증거로 세어짐
//   · 읽기만 한 실패가 automation_ambiguous_side_effect 로 굳어 자동화 영구 잠김
//   · emitter 모양의 출력 노드가 다섯 곳에서 "바깥에 안 나감"으로 읽힘
//     (도구 모드·패키지 경고·권한 판정·발행 심사·패치 승인)
//
// 사본은 게으름이 아니라 **정본에 물어볼 수 없어서** 생겼다:
//   · 정본 시그니처가 호출자가 가진 정보를 못 받거나(risksOfConfig 는 config 만 받았다)
//   · 정본 이름이 그 질문처럼 안 들리거나(classifyTool 은 "화면 라벨"로 태어났다)
//   · 같은 질문이 세 개로 보이거나("예비 조회인가"만 물어 절반만 정본을 썼다)
//   · 사본을 만들어도 컴파일러가 아무 말도 안 하거나.
// 앞의 셋은 고쳤다. 이 게이트가 넷째를 맡는다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);

/** 정본들. 이 파일들 안에서는 규칙을 **쓰는** 것이 당연하다. */
const CANONICAL = new Set([
  "shared/graph-node-protocol.ts",   // ① nodeCanChangeTheOutsideWorld / defaultNodeEffect
  "shared/tool-activity.ts",         // ② couldHaveChangedTheOutsideWorld / isHostPreflightTool
  "shared/tool-taxonomy.ts",         // ②의 이름 표
  "electron/workflow/run-graph.ts",  // 커널의 effect 해석기(nodeEffect) — ①의 원천
]);

/**
 * 검사 대상. renderer 는 화면이라 라벨용 분기가 정상이므로 뺀다
 * (화면이 실행 규칙을 다시 쓰면 그건 다른 게이트가 잡는다: graph-canvas-parity).
 */
const ROOTS = ["shared", "electron"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next-build", "out"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * 주석은 규칙을 **설명**한다 — 코드로 오해하면 옳은 문서가 게이트를 깬다.
 *
 * ★지우지 않고 **같은 길이의 공백으로 덮는다.** 처음 판은 그냥 지웠고, 그러자 신고한
 *   줄 번호가 실제 파일과 안 맞아 사람이 그 자리를 못 찾았다. 위치를 못 주는 신고는
 *   신고가 아니다.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, (rest) => " ".repeat(rest.length)))
    .join("\n");
}

const PATTERNS = [
  {
    id: "노드가 바깥을 바꾸나",
    // agent/action/output 조합으로 효과를 판정하는 손 목록.
    re: /type\s*===\s*"(?:agent|action|output)"[\s\S]{0,120}?type\s*===\s*"(?:agent|action|output)"/,
    canonical: "nodeDeclaresOutwardEffect(node) / nodeCouldHaveActedOutside(node)  ← shared/graph-node-protocol",
    why: "노드 종류 목록으로 효과를 판정하면 code 노드의 mutation 이 빠진다 "
      + "(오늘 실측: 이미 나간 발송이 그래프 편집 후 다시 나갔다).",
  },
  {
    id: "노드가 바깥을 바꾸나",
    // 선언된 effect 만 보는 판정. 기본값이 mutation 인 출력 노드가 안 보인다.
    re: /(?:config\??\.\s*effect|str\(\s*\w+\.config\s*,\s*"effect"\s*\))\s*===\s*"mutation"/,
    canonical: "nodeDeclaresOutwardEffect(node) / nodeCouldHaveActedOutside(node)  ← shared/graph-node-protocol",
    why: "선언된 effect 만 보면 emitter 가 만든 출력 노드(칸 자체가 없음)가 "
      + "\"바깥에 안 나감\"으로 읽힌다. 그 노드의 기본값은 나가는 것이다.",
  },
  {
    id: "도구 호출이 바깥을 바꿨나",
    /*
     * 도구 이름 손 목록으로 읽기/쓰기를 가르는 곳.
     * ★"read"/"write"/"full" 같은 **권한 이름**은 도구 이름이 아니다. 처음 판에서
     *   그걸 안 갈라 오폭 4건이 났다 — 우는 늑대 게이트는 없는 것보다 나쁘다.
     *   그래서 런타임의 실제 도구 이름이 **둘 이상** 같이 있을 때만 사본으로 본다.
     */
    re: /(?:"(?:Grep|Glob|WebFetch|WebSearch|list_dir|read_file|view_file|codebase_search|notebookread|readmcpresource)"[\s\S]{0,160}){2}/i,
    canonical: "couldHaveChangedTheOutsideWorld(name)  ← shared/tool-activity",
    why: "런타임마다 읽기 도구 이름이 다르다(claude Read / grok list_dir / agy view_file). "
      + "손 목록은 구조적으로 못 따라가고, 빠진 이름이 발송의 '증거'가 된다.",
  },
];

const offenders = [];
for (const rootName of ROOTS) {
  for (const file of walk(path.join(root, rootName))) {
    const rel = path.relative(root, file);
    if (CANONICAL.has(rel)) continue;
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const pattern of PATTERNS) {
      const hit = source.match(pattern.re);
      if (!hit) continue;
      const line = source.slice(0, hit.index).split("\n").length;
      /*
       * ★예외는 **이름으로 선언**한다. 조용한 허용목록을 두면 다음 사람이 거기 한 줄
       *   더하고 끝내고, 그게 사본이 자라는 방식이다. 왜 다른 질문인지 소스에 적혀
       *   있어야 통과한다(정본 근처 20줄 안).
       */
      const raw = readFileSync(file, "utf8").split("\n");
      const near = raw.slice(Math.max(0, line - 12), line + 4).join("\n");
      if (/judgment-exempt:/.test(near)) continue;
      offenders.push({ rel, line, pattern, snippet: hit[0].replace(/\s+/g, " ").slice(0, 90) });
    }
  }
}

/*
 * ★게이트가 자기 자신을 시험한다. 규칙이 하나도 안 걸리는 코드에서는 이 게이트가
 *   "통과"인지 "아무것도 못 재는지" 구분되지 않는다(이 저장소가 여러 번 당한 공짜 초록).
 *
 *   ★처음 판은 **정본 파일 안에서** 규칙이 발견되는지로 시험했다. 그런데 정본이
 *     좋아지면(노드 종류 목록을 defaultNodeEffect 호출로 바꾸자) 그 패턴이 사라져
 *     "스캐너가 죽었다"고 오보했다 — 옳은 수리가 게이트를 깨는 모양이다.
 *     시험은 **고정 픽스처**로 한다. 픽스처는 리팩터링이 지우지 못한다.
 */
const FIXTURES = [
  {
    why: "노드 종류 목록으로 효과를 판정하는 사본",
    code: 'const ids = g.nodes.filter((node) => node.type === "agent" || node.type === "action" || node.type === "output");',
  },
  {
    why: "선언된 effect 만 보는 사본",
    code: 'const outward = nodes.some((n) => n.config?.effect === "mutation");',
  },
  {
    why: "도구 이름 손 목록 사본",
    code: 'const READ_ONLY = ["Grep", "Glob", "list_dir", "view_file", "WebFetch"];',
  },
];
const missed = FIXTURES.filter((fx) => !PATTERNS.some((p) => p.re.test(fx.code)));
if (missed.length > 0) {
  console.error("one-judgment-one-place: 스캐너가 **알려진 사본**을 못 잡습니다 — 검사가 죽었습니다:");
  for (const fx of missed) console.error(`  - ${fx.why}\n      ${fx.code}`);
  console.error("  (정규식이 낡았습니다. 통과로 세면 안 됩니다.)");
  process.exit(1);
}

/* 그리고 정본 자신은 이 규칙에 걸리면 안 된다 — 걸린다면 정본이 사본을 품은 것이다. */
const canonicalOffenders = [...CANONICAL].filter((rel) => {
  const source = withoutComments(readFileSync(path.join(root, rel), "utf8"));
  return PATTERNS.some((p) => p.re.test(source)) && !/judgment-exempt:/.test(readFileSync(path.join(root, rel), "utf8"));
});
if (canonicalOffenders.includes("shared/graph-node-protocol.ts")) {
  console.error("one-judgment-one-place: 정본이 자기 규칙을 손으로 다시 적고 있습니다:");
  console.error("  - shared/graph-node-protocol.ts (resolveNodeEffect 를 거치지 않고 노드 종류를 나열)");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`one-judgment-one-place: 정본 밖에서 판정하는 곳 ${offenders.length}건\n`);
  for (const o of offenders) {
    console.error(`  ${o.rel}:${o.line}  [${o.pattern.id}]`);
    console.error(`    ${o.snippet}`);
    console.error(`    → 대신: ${o.pattern.canonical}`);
    console.error(`    이유: ${o.pattern.why}`);
    console.error("    (정말 다른 질문이라면 그 줄 위에 `// judgment-exempt: <왜 다른 질문인지>` 를 적으세요.)\n");
  }
  process.exit(1);
}

console.log(`one-judgment-one-place ok — 정본 ${CANONICAL.size}곳, 규칙 ${PATTERNS.length}종, 사본 0건`);
