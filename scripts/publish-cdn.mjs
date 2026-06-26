#!/usr/bin/env node
// release/ 산출물을 웹/CDN 으로 업로드한다.
//
// 배경: 데스크탑 소스 레포는 비공개라 GitHub Releases(공개 다운로드)를 쓰지 않는다. 대신
// electron-builder 의 generic 피드(electron-builder.yml publish.url = https://agentlas.cloud/
// desktop/release)에 산출물 + latest*.yml 을 올려 electron-updater 가 폴링하게 한다.
// electron-builder 의 generic provider 는 "다운로드 전용"이라 자동 업로드를 하지 않으므로, 이
// 스크립트가 업로드를 담당한다.
//
// 설정(둘 중 하나):
//   1) S3 호환:  CDN_S3_BUCKET=my-bucket  [CDN_S3_PREFIX=desktop/release]  [CDN_S3_ENDPOINT=https://...]
//                + AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (aws cli 사용)
//   2) 커스텀:   CDN_UPLOAD_CMD="rsync -a {dir}/ user@host:/var/www/desktop/release/"
//                ({dir} 는 release 디렉터리로 치환)
//
//   CDN_PUBLISH_REQUIRED=1  설정이 없으면 에러로 종료(CI 가드). 기본은 경고 후 no-op(로컬 친화).
//   CDN_FEED_BASE          확인용(기본 https://agentlas.cloud/desktop/release)
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(repoRoot, "release");
const feedBase = process.env.CDN_FEED_BASE || "https://agentlas.cloud/desktop/release";
const required = process.env.CDN_PUBLISH_REQUIRED === "1";

function fail(msg) {
  console.error(`[publish-cdn] ${msg}`);
  process.exit(1);
}
function warnNoop(msg) {
  console.warn(`[publish-cdn] ${msg}`);
  if (required) process.exit(1);
  process.exit(0);
}

if (!existsSync(releaseDir)) {
  warnNoop(`release/ 디렉터리가 없습니다. 먼저 빌드/패키징하세요. (대상 피드: ${feedBase})`);
}

// 업로드 대상: 설치 산출물 + 업데이트 피드 + blockmap. (.yml 은 no-cache, 나머지는 캐시)
const all = readdirSync(releaseDir).filter((f) => {
  const p = path.join(releaseDir, f);
  return statSync(p).isFile();
});
const shippable = all.filter((f) =>
  /\.(dmg|zip|exe|appimage|deb|blockmap)$/i.test(f) || /^latest.*\.yml$/i.test(f),
);
if (shippable.length === 0) {
  warnNoop("release/ 에 업로드할 산출물(.dmg/.zip/.exe/.AppImage/.deb/latest*.yml)이 없습니다.");
}

console.log(`[publish-cdn] feed = ${feedBase}`);
console.log(`[publish-cdn] ${shippable.length} artifact(s):`);
for (const f of shippable) console.log(`  · ${f}`);

// ── 1) 커스텀 업로드 명령 ────────────────────────────────────────────────
if (process.env.CDN_UPLOAD_CMD) {
  const cmd = process.env.CDN_UPLOAD_CMD.replaceAll("{dir}", releaseDir);
  console.log(`[publish-cdn] running custom upload: ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot });
  console.log("[publish-cdn] custom upload complete.");
  process.exit(0);
}

// ── 2) S3 호환(aws cli) ──────────────────────────────────────────────────
if (process.env.CDN_S3_BUCKET) {
  const bucket = process.env.CDN_S3_BUCKET;
  const prefix = (process.env.CDN_S3_PREFIX || "desktop/release").replace(/^\/+|\/+$/g, "");
  const endpointArgs = process.env.CDN_S3_ENDPOINT ? ["--endpoint-url", process.env.CDN_S3_ENDPOINT] : [];
  try {
    execFileSync("aws", ["--version"], { stdio: "ignore" });
  } catch {
    fail("aws cli 가 없습니다. awscli 설치 후 다시 실행하거나 CDN_UPLOAD_CMD 를 쓰세요.");
  }
  for (const f of shippable) {
    const src = path.join(releaseDir, f);
    const dst = `s3://${bucket}/${prefix}/${f}`;
    // 업데이트 피드(yml)는 항상 최신이어야 하므로 no-cache, 산출물은 1년 캐시.
    const cacheArgs = /^latest.*\.yml$/i.test(f)
      ? ["--cache-control", "no-cache, max-age=0, must-revalidate"]
      : ["--cache-control", "public, max-age=31536000, immutable"];
    console.log(`[publish-cdn] → ${dst}`);
    execFileSync("aws", ["s3", "cp", src, dst, ...cacheArgs, ...endpointArgs], { stdio: "inherit" });
  }
  console.log(`[publish-cdn] S3 upload complete → s3://${bucket}/${prefix}/ (feed: ${feedBase})`);
  process.exit(0);
}

// ── 미설정 ────────────────────────────────────────────────────────────────
warnNoop(
  [
    "업로드 대상이 설정되지 않았습니다. 다음 중 하나를 설정하세요:",
    "  · S3 호환:  CDN_S3_BUCKET=<bucket> [CDN_S3_PREFIX=desktop/release] [CDN_S3_ENDPOINT=<url>] + AWS 키",
    '  · 커스텀:   CDN_UPLOAD_CMD="rsync -a {dir}/ user@host:/var/www/desktop/release/"',
    `대상 피드 URL: ${feedBase}  (electron-builder.yml publish.url 과 일치해야 함)`,
    "CI 에서 강제하려면 CDN_PUBLISH_REQUIRED=1 설정.",
  ].join("\n"),
);
