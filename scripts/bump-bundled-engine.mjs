#!/usr/bin/env node
/*
 * 앱에 실리는 Agentlas OS 핀을 최신 공개 릴리스로 올린다.
 *
 * 왜 스크립트인가 (오너 결정 2026-07-28: "자동화한다"):
 *   빌드 때마다 최신을 **받아오는** 방식은 쓸 수 없다. 핀은 불변 커밋이어야 하고
 *   (`package.json` 의 `agentlasBundledRuntimeSource.commit`), 그 불변성이
 *   재현 가능한 빌드와 서명 릴리스 무결성의 근거다. 매번 latest 를 당기면 같은 태그가
 *   서로 다른 바이트를 만들어낸다.
 *
 *   그래서 자동화하는 것은 **핀을 올리는 일**이다. 사람이 잊어서 번들이 뒤처지던 것이
 *   원래 문제였고, 그건 이 스크립트가 없앤다. 커밋 SHA 를 실제 릴리스에서 읽어 박으므로
 *   불변성은 그대로다.
 *
 * 하는 일
 *   1. Agentlas-OS 최신 릴리스 태그와 그 커밋 SHA 를 읽는다(`gh`).
 *   2. 이미 최신이면 아무것도 안 하고 끝낸다.
 *   3. `package.json` 의 bundledRuntimeVersion / ref / commit 을 갱신한다.
 *   4. `npm run ensure:engine` 이 그 핀대로 체크아웃을 맞추게 안내한다.
 *
 * 검증은 기존 게이트가 한다 — `ensure:engine` 이 manifest 버전과 커밋을 대조하고,
 * `release-preflight` 가 워크포스 계약을 **엄격하게** 검사한다. 프로토콜이 실제로
 * 달라졌으면 여기서 걸려야 하고, 그게 그 친 friction 이 있어야 할 자리다.
 *
 * 사용:
 *   node scripts/bump-bundled-engine.mjs           올린다
 *   node scripts/bump-bundled-engine.mjs --check   뒤처졌는지만 보고 (CI 용, 뒤처지면 exit 1)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const checkOnly = process.argv.includes("--check");

const fail = (message) => {
  console.error(`[bump-engine] ${message}`);
  process.exit(1);
};

const desktop = JSON.parse(readFileSync(packagePath, "utf8"));
const source = desktop.agentlasBundledRuntimeSource ?? {};
const currentVersion = String(desktop.agentlasUpdateCompatibility?.bundledRuntimeVersion ?? "").trim();
const repository = String(source.repository ?? "").trim();
if (!currentVersion || !repository) fail("package.json 에 번들 런타임 핀이 없다");

// `owner/name` 만 뽑는다. gh 는 URL 대신 이 형태를 받는다.
const slug = repository.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");

let release;
try {
  release = JSON.parse(execFileSync("gh", [
    "release", "view", "--repo", slug, "--json", "tagName,targetCommitish",
  ], { encoding: "utf8" }));
} catch (error) {
  fail(`최신 릴리스를 읽지 못했다 (gh 인증/네트워크 확인): ${error.message.split("\n")[0]}`);
}

const latestTag = String(release.tagName ?? "").trim();
if (!/^v\d+\.\d+\.\d+/.test(latestTag)) fail(`릴리스 태그 형식이 예상과 다르다: ${latestTag}`);
const latestVersion = latestTag.slice(1);

if (latestVersion === currentVersion) {
  console.log(`[bump-engine] 이미 최신이다 (v${currentVersion})`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`[bump-engine] 번들 엔진이 뒤처졌다: v${currentVersion} → ${latestTag}`);
  console.error("[bump-engine] 올리려면: node scripts/bump-bundled-engine.mjs && npm run ensure:engine");
  process.exit(1);
}

// `targetCommitish` 는 브랜치 이름일 수 있다. 태그가 가리키는 **커밋**을 직접 해석한다 —
// 핀의 요점이 불변성이므로 여기서 브랜치를 박으면 의미가 없다.
let commit;
try {
  commit = JSON.parse(execFileSync("gh", [
    "api", `repos/${slug}/commits/${latestTag}`, "--jq", "{sha: .sha}",
  ], { encoding: "utf8" })).sha;
} catch (error) {
  fail(`태그 커밋을 해석하지 못했다: ${error.message.split("\n")[0]}`);
}
if (!/^[0-9a-f]{40}$/.test(String(commit ?? ""))) fail(`커밋 SHA 형식이 아니다: ${commit}`);

desktop.agentlasUpdateCompatibility.bundledRuntimeVersion = latestVersion;
desktop.agentlasBundledRuntimeSource = { ...source, ref: latestTag, commit };
writeFileSync(packagePath, `${JSON.stringify(desktop, null, 2)}\n`);

// 릴리스 워크플로에도 **같은 핀이 손으로 복사돼 있다**(2026-07-28 실측: 4곳).
// package.json 만 올리면 워크플로가 옛 커밋을 체크아웃하고, 릴리스 게이트가
// "release.yml does not pin only <version>" 으로 막는다. 자동화가 반쪽이면
// 사람이 잊는 자리만 옮긴 것이지 없앤 게 아니다.
const workflowFiles = [
  ".github/workflows/release.yml",
  ".github/workflows/release-signed-mac.yml",
];
const previousRef = `v${currentVersion}`;
const previousCommit = String(source.commit ?? "").trim().toLowerCase();
let rewritten = 0;
for (const relative of workflowFiles) {
  const file = path.join(root, relative);
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const next = body
    .split(`HEPHAESTUS_REF: ${previousRef}`).join(`HEPHAESTUS_REF: ${latestTag}`)
    .split(`HEPHAESTUS_COMMIT: ${previousCommit}`).join(`HEPHAESTUS_COMMIT: ${commit}`);
  if (next !== body) {
    writeFileSync(file, next);
    rewritten += 1;
  }
}

// 옛 핀이 남아 있으면 조용히 넘어가지 않는다 — 남은 한 곳이 빌드를 옛 엔진으로 굽는다.
const leftovers = workflowFiles.filter((relative) => {
  try {
    return readFileSync(path.join(root, relative), "utf8").includes(previousCommit);
  } catch {
    return false;
  }
});
if (leftovers.length) {
  fail(`워크플로에 옛 핀이 남았다: ${leftovers.join(", ")} — 손으로 확인하라`);
}

// 릴리스 문서에도 같은 핀 문장이 박혀 있다("This release binds Agentlas OS vX at Y.").
// `release-preflight` 가 **현재 릴리스 섹션에만** 그 문장을 요구하므로, 과거 기록은
// 절대 건드리지 않는다 — 옛 릴리스가 옛 엔진을 물었다는 것은 사실이고 지워선 안 된다.
const bindingLine = (version, sha) => `This release binds Agentlas OS v${version} at ${sha}.`;
const currentSection = (body, header, next) => {
  const start = body.indexOf(header);
  if (start === -1) return null;
  const end = body.indexOf(next, start + header.length);
  return { start, end: end === -1 ? body.length : end };
};
const docTargets = [
  { file: "README.md", header: `· v${desktop.version} —`, next: "\n- **" },
  { file: "CHANGELOG.md", header: `## ${desktop.version} —`, next: "\n## " },
];
for (const target of docTargets) {
  const file = path.join(root, target.file);
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // README 는 현재 릴리스 항목이 "- **…" 로 시작하므로 헤더 앞의 여는 표식까지 찾는다.
  const headerIndex = body.indexOf(target.header);
  if (headerIndex === -1) {
    fail(`${target.file} 에서 현재 릴리스(v${desktop.version}) 섹션을 못 찾았다`);
  }
  const from = target.file === "README.md" ? body.lastIndexOf("- **", headerIndex) : headerIndex;
  const region = currentSection(body.slice(from), body.slice(from, from + 4), target.next);
  const sectionEnd = region ? from + region.end : body.length;
  const section = body.slice(from, sectionEnd);
  const oldLine = bindingLine(currentVersion, previousCommit);
  if (!section.includes(oldLine)) {
    fail(`${target.file} 현재 릴리스 섹션에 옛 바인딩 문장이 없다 — 손으로 확인하라`);
  }
  // 섹션 안에 같은 문장이 여러 번 있을 수 있다(같은 블록에 이전 항목이 섞인 경우).
  // **첫 번째**만 바꾼다. 그게 이 릴리스 자신의 바인딩이다.
  writeFileSync(
    file,
    body.slice(0, from) + section.replace(oldLine, bindingLine(latestVersion, commit)) + body.slice(sectionEnd),
  );
}

console.log(`[bump-engine] v${currentVersion} → ${latestTag} (${commit.slice(0, 12)})`);
console.log(`[bump-engine] 워크플로 ${rewritten}개 · 문서 ${docTargets.length}종 갱신`);
console.log("[bump-engine] 다음: npm run ensure:engine && node scripts/release-preflight.mjs");
