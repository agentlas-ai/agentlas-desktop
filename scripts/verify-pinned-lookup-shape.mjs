// 주소를 고정하는 lookup 이 Node 가 실제로 부르는 형식으로 답하는지 검사한다.
//
// 왜 (2026-08-23 실측, 웹에서 같은 결함을 먼저 잡았다):
//   DNS rebinding 을 막으려고 요청의 주소 해석을 검사한 주소로 못 박는다. 그런데 Node 는
//   소켓을 열 때 그 함수를 `{ hints, all: true }` 로 부르고, `all` 이 켜져 있으면 콜백은
//   `(err, [{ address, family }])` **배열**을 받아야 한다. 언제나 단일 값으로 답하면
//   Node 가 주소를 undefined 로 읽어 ERR_INVALID_IP_ADDRESS 로 죽는다.
//
//   웹에서는 이것 때문에 **원격 MCP 호출이 100% 실패**하고 있었다. 여기서는 사이트 배포
//   확인이 언제나 실패한다 — 배포는 됐는데 "확인 실패"로 보이는 자리다.
//
//   타입 검사도 단위 테스트도 코드 리뷰도 이것을 못 본다. 형식이 맞는지는 Node 만 안다.
//   그래서 **Node 가 부르는 것과 같은 모양으로 실제로 불러** 답을 확인한다.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 저장소에서 lookup 을 손으로 구현한 곳을 찾는다 — 파일 이름을 못박지 않는다. */
function findPinnedLookups(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { findPinnedLookups(full, found); continue; }
    if (!/\.(ts|mjs|cjs|js)$/.test(entry.name)) continue;
    if (!statSync(full).isFile()) continue;
    const body = readFileSync(full, "utf8");
    // 소켓 요청에 lookup 을 넘기는 곳만 찾는다. 이름 해석 도우미(dns.lookup 재수출 등)는
    // 대상이 아니다. 탐지 기준은 **요청 옵션에 lookup 을 붙였는가** 하나로 둔다 —
    // 콜백을 어떻게 쓰는지로 찾으면 형변환 한 겹에도 놓친다(실제로 놓쳤다).
    if (!/^\s*lookup:\s*\w/m.test(body)) continue;
    if (!/LookupFunction|hostname/.test(body)) continue;
    found.push({ file: path.relative(root, full), body });
  }
  return found;
}

let failures = 0;
function check(label, ok, why) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}${why ? ` — ${why}` : ""}`); }
}

console.log("pinned lookup shape");

const sites = findPinnedLookups(path.join(root, "electron"));
check(`found hand-written socket lookups (${sites.length})`, sites.length > 0);
for (const site of sites) {
  check(
    `★ ${site.file} answers the all:true form`,
    /\.all\b/.test(site.body) && /\[\{\s*address:/.test(site.body),
    "answering (err, address, family) always makes Node read undefined and the request always fails",
  );
}

// Node 가 부르는 그대로 불러 본다. 소스 검사만으로는 형식이 맞는지 증명되지 않는다.
const server = createServer((_request, response) => { response.writeHead(200); response.end("ok"); });
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

const good = (hostname, options, callback) => {
  if (options && options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};
const reached = await new Promise((resolve) => {
  const request = httpRequest(
    { protocol: "http:", hostname: "example.com", port, path: "/", method: "GET", lookup: good },
    (response) => resolve(response.statusCode),
  );
  request.on("error", () => resolve(0));
  request.end();
});
server.close();
check("★ the both-shapes form actually connects (live call verified)", reached === 200, `status ${reached}`);

if (failures > 0) {
  console.error(`\npinned lookup shape FAILED (${failures})`);
  process.exit(1);
}
console.log("\npinned lookup shape PASS: every hand-written lookup answers the form Node uses");
