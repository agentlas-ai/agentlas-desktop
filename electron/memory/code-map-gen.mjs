#!/usr/bin/env node
// 프로젝트 지도 생성기 v5 — Tier-0 MAP. 의존성 0.
//   심볼(+줄번호) · 참조그래프 · 중요도(노이즈필터) · 증분 · 문서인덱스 · 진입점
//   + 위생(hygiene): .gitignore 존중 · 쓰레기/레거시 제외 · 고아 코드 정리후보
// 출력: <project>/.agentlas/code-map/{project-map.json, project-map.md, .cache.json}
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
// 프로젝트 1개당 1개 — 프로젝트의 .agentlas/code-map/ 에 저장(설계와 일치). 환경변수로 덮어쓰기 가능.
const OUT_DIR = process.env.CODE_MAP_OUT || path.join(ROOT, ".agentlas", "code-map");
const CACHE = path.join(OUT_DIR, ".cache.json");

const IGNORE_DIRS = new Set([".git","node_modules",".godot","build","dist","out","release",".next",".firebase",".venv","venv","env","__pycache__","site-packages","vendor","coverage",".cache",".turbo","ios","android",".gradle","Pods",".agentlas",".agentlas_memory"]);
// 빌드 산출물 디렉토리: IGNORE_DIRS + macOS .app 번들(전체 앱 복사본 → 소스 아님)
const ignoredDirName = (name) => IGNORE_DIRS.has(name) || name.endsWith(".app");
// 쓰레기/레거시 — 코드맵 인덱스에서 제외 + 정리 후보로 따로 보고
const JUNK_DIR = /(^|[\\/])(_?(trash|legacy|deprecated|archive|backups?|old))([\\/]|$)/i;
const JUNK_FILE = /(\.(bak|old|orig|tmp|temp|swp|rej)$|~$|\.DS_Store$|[ _-]copy( \d+)?\.[^.]+$|\.(deprecated|backup)\.)/i;
const isJunk = (r) => JUNK_FILE.test(path.basename(r)) || JUNK_DIR.test(r);
const CODE_EXT = new Set([".gd",".ts",".tsx",".js",".mjs",".cjs",".py",".proto"]);
const MAX_FILE_BYTES = 400 * 1024;
const REF_CAP = 50;

const STOP = new Set(("get set has new del add run init main self this val value values data datum id ids index idx key keys name names path paths type types list item items node nodes text size width height pos position rect area body line min max sum str num int float bool dict arr out src dst tmp ret obj fn cb arg args kwargs print return null true false void label color colors panel button buttons row rows box font font_size margin offset child children parent root _ready _init _process _input _physics_process _enter_tree _exit_tree _draw _notification _to_string build make load read write render register generate update create start stop open close show hide draw title icon image img url uri href style count total flag mode state status kind tag step x y z w h dx dy uv col enum const var let func def title_ko title_en subtitle slot_id callable read_text").split(/\s+/).filter(Boolean));
const isCodegen = (r) => /(^|\/)tools\//.test(r) && /^(generate|register|write|render|build|make|compile|emit)_/.test(path.basename(r));
const distinctive = (raw) => { const n = raw.toLowerCase(); return n.length >= 5 && !STOP.has(n) && (/_/.test(raw) || /[a-z][A-Z]/.test(raw) || raw.length >= 8); };

// 라인 단위 심볼 패턴 → {name, kind, line}
const LINE_RULES = {
  gd: [[/^\s*class_name\s+(\w+)/, "class"],[/^\s*func\s+(\w+)/, "func"],[/^\s*signal\s+(\w+)/, "signal"],[/^\s*@export\b.*\bvar\s+(\w+)/, "export"]],
  ts: [[/^\s*export\s+(?:async\s+)?function\s+(\w+)/, "fn"],[/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/, "class"],[/^\s*export\s+(?:const|let|var)\s+(\w+)/, "const"],[/^\s*export\s+(?:type|interface)\s+(\w+)/, "type"],[/^\s*(?:async\s+)?function\s+(\w+)/, "fn"],[/^\s*class\s+(\w+)/, "class"]],
  py: [[/^\s*(?:async\s+)?def\s+(\w+)/, "def"],[/^\s*class\s+(\w+)/, "class"]],
  proto: [[/^\s*message\s+(\w+)/, "message"],[/^\s*service\s+(\w+)/, "service"],[/^\s*rpc\s+(\w+)/, "rpc"]],
};
const EXT_LANG = { ".gd":"gd",".ts":"ts",".tsx":"ts",".js":"ts",".mjs":"ts",".cjs":"ts",".py":"py",".proto":"proto" };

function extractSymbols(src, lang) {
  const rules = LINE_RULES[lang]; const out = []; const seen = new Set();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [re, kind] of rules) { const m = re.exec(lines[i]); if (m && m[1] && !seen.has(m[1])) { seen.add(m[1]); out.push({ n: m[1], k: kind, l: i + 1 }); break; } }
    if (out.length >= 60) break;
  }
  return out;
}
function tokenize(src) { return [...new Set((src.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).map((t) => t.toLowerCase()))]; }
function docHeadings(src) {
  const lines = src.split("\n"); let title = ""; const heads = [];
  for (let l of lines) { const m = /^(#{1,3})\s+(.+)/.exec(l); if (m) { const t = m[2].trim().slice(0, 80); if (!title) title = t; if (heads.length < 12) heads.push(t); } }
  if (!title) for (let l of lines) { l = l.trim(); if (l) { title = l.slice(0, 80); break; } }
  return { title, heads };
}

// git 저장소면 git ls-files 로 .gitignore 를 자동 존중(추적+미추적-비무시).
// → vendored/빌드산출물/무시된 쓰레기는 애초에 안 들어옴. 비-git이면 수동 walk.
const _gitCache = new Map();
function gitFiles(dir) {
  if (_gitCache.has(dir)) return _gitCache.get(dir);
  let res = null;
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard -z", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 });
    res = out.split("\0").filter(Boolean);
  } catch { res = null; }
  _gitCache.set(dir, res); return res;
}
function collect(dir) {
  const g = gitFiles(dir);
  if (g) {
    const out = [];
    for (const rp of g) { if (isJunk(rp)) continue; if (rp.split("/").some((p) => ignoredDirName(p))) continue; out.push(path.join(dir, rp)); }
    return out;
  }
  const files = []; const stack = [dir];
  while (stack.length) { const d = stack.pop(); let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { const full = path.join(d, e.name);
      if (e.isDirectory()) { if (ignoredDirName(e.name) || e.name.startsWith(".") || JUNK_DIR.test(e.name + "/")) continue; stack.push(full); }
      else if (e.isFile()) { if (isJunk(path.relative(dir, full))) continue; files.push(full); } } }
  return files;
}
const rel = (p) => path.relative(ROOT, p);
// 정리 후보 스캐너: 실제 디스크를 훑어 쓰레기/레거시를 뽑음(git 무시 여부와 무관 — 못 지운 것도 보고).
function scanJunk(root) {
  const hits = []; const stack = [root];
  while (stack.length && hits.length < 300) { const d = stack.pop(); let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { const full = path.join(d, e.name); const r = rel(full);
      if (e.isDirectory()) {
        if (JUNK_DIR.test(e.name + "/")) { let n = 0; try { n = collect(full).length; } catch {} hits.push({ path: r + "/", kind: "dir", reason: "legacy/backup 폴더", files: n }); continue; }
        if (ignoredDirName(e.name) || e.name.startsWith(".")) continue;
        stack.push(full);
      } else if (e.isFile() && JUNK_FILE.test(e.name)) hits.push({ path: r, kind: "file", reason: "백업/임시 파일명" });
    } }
  return hits;
}
function firstMeaningfulLine(file) { try { for (let l of fs.readFileSync(file, "utf8").split("\n")) { l = l.replace(/^#+\s*/, "").trim(); if (l && !l.startsWith("![") && !l.startsWith("<!--")) return l.slice(0, 100); } } catch {} return ""; }
function detectModules() {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !ignoredDirName(e.name) && !e.name.startsWith(".") && !JUNK_DIR.test(e.name + "/"))
    .map((t) => { const dir = path.join(ROOT, t.name); const has = (f) => fs.existsSync(path.join(dir, f)); const deepHas = (f) => collect(dir).some((p) => path.basename(p) === f);
      let role = "모듈";
      if (has("project.godot") || deepHas("project.godot")) role = "Godot 게임";
      else if (has("package.json")) { try { role = `Node/TS (${JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name || t.name})`; } catch { role = "Node/TS"; } }
      else if (has("firebase.json") || deepHas("firebase.json")) role = "Firebase";
      else if (has("requirements.txt") || has("pyproject.toml")) role = "Python";
      else if (has("README.md")) role = firstMeaningfulLine(path.join(dir, "README.md")) || "모듈";
      return { id: t.name, path: t.name, role }; });
}
function dirPurpose(dir, filesInDir) {
  const readme = ["README.md","readme.md","README"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (readme) { const l = firstMeaningfulLine(readme); if (l) return l; }
  const counts = {}; for (const f of filesInDir) { const x = path.extname(f); if (x) counts[x] = (counts[x] || 0) + 1; }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0]} 위주 (${filesInDir.length}개 파일)` : `${filesInDir.length}개 파일`;
}
// 진입점 휴리스틱
function detectEntryPoints() {
  const eps = [];
  for (const f of collect(ROOT)) {
    const r = rel(f); const base = path.basename(f); const ext = path.extname(f);
    if (base === "package.json") { try { const pj = JSON.parse(fs.readFileSync(f, "utf8")); if (pj.main) eps.push({ path: path.join(path.dirname(r), pj.main), why: `package.json main (${pj.name||""})` }); const start = pj.scripts && (pj.scripts.start || pj.scripts.serve || pj.scripts.dev); if (start) eps.push({ path: r, why: `npm start: ${String(start).slice(0,60)}` }); } catch {} }
    else if (/^(main|index|app|server)\.(ts|js|mjs|py)$/.test(base)) eps.push({ path: r, why: "진입 파일명" });
    else if (base === "project.godot") eps.push({ path: r, why: "Godot 프로젝트 루트" });
    else if (ext === ".py") { try { if (/if\s+__name__\s*==\s*["']__main__["']/.test(fs.readFileSync(f, "utf8").slice(0, 4000))) eps.push({ path: r, why: "python __main__" }); } catch {} }
  }
  // 우선순위: 실제 앱 진입(web/server/functions/game) ↑, QA 스크립트 ↓
  const pri = (e) => /^(web|server|functions)\//.test(e.path) || /package\.json|npm start/.test(e.why) ? 0
    : /project\.godot/.test(e.why) ? 1 : /^game\//.test(e.path) ? 2 : /^tools\/qa\//.test(e.path) ? 9 : 5;
  return eps.map((e) => ({ ...e, _p: pri(e) })).sort((a, b) => a._p - b._p || a.path.localeCompare(b.path)).slice(0, 40).map(({ _p, ...e }) => e);
}

// ── 메인 ─────────────────────────────────────────────────────────
const t0 = Date.now();
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : { code: {}, docs: {} };
const allFiles = collect(ROOT);
const byExt = {}; for (const f of allFiles) { const x = path.extname(f) || "(none)"; byExt[x] = (byExt[x] || 0) + 1; }

const nextCache = { code: {}, docs: {} };
let reread = 0, reused = 0;
const codeData = {}; // rel → {symbols:[{n,k,l}], tokens}
const docData = {};  // rel → {title, heads}
for (const f of allFiles) {
  const ext = path.extname(f); let st; try { st = fs.statSync(f); } catch { continue; }
  const r = rel(f); const mt = st.mtimeMs;
  if (CODE_EXT.has(ext)) {
    if (st.size > MAX_FILE_BYTES) continue;
    const c = cache.code[r];
    if (c && c.mtime === mt) { codeData[r] = { symbols: c.symbols, tokens: c.tokens }; nextCache.code[r] = c; reused++; continue; }
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    const symbols = extractSymbols(src, EXT_LANG[ext]); const tokens = tokenize(src);
    codeData[r] = { symbols, tokens }; nextCache.code[r] = { mtime: mt, symbols, tokens }; reread++;
  } else if (ext === ".md" && st.size <= MAX_FILE_BYTES) {
    const c = cache.docs[r];
    if (c && c.mtime === mt) { docData[r] = { title: c.title, heads: c.heads }; nextCache.docs[r] = c; reused++; continue; }
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    const { title, heads } = docHeadings(src);
    docData[r] = { title, heads }; nextCache.docs[r] = { mtime: mt, title, heads }; reread++;
  }
}

// 심볼/참조 인덱스
// prototype 없는 맵: 토큰이 "constructor"/"toString" 같은 예약어여도 안전(실제 더티 데이터가 잡아낸 버그)
const defIndex = Object.create(null), display = Object.create(null), fileSymbols = Object.create(null); const rankSet = new Set();
for (const [r, { symbols }] of Object.entries(codeData)) {
  if (!symbols.length) continue; fileSymbols[r] = symbols;
  for (const s of symbols) { const name = s.n.toLowerCase(); (defIndex[name] ||= []).push({ f: r, l: s.l }); if (!display[name]) display[name] = s.n; if (distinctive(s.n)) rankSet.add(name); }
}
const refCount = Object.create(null), refIndex = Object.create(null);
for (const [r, { tokens }] of Object.entries(codeData)) for (const tk of tokens) { if (!rankSet.has(tk)) continue; refCount[tk] = (refCount[tk] || 0) + 1; (refIndex[tk] ||= []); if (refIndex[tk].length < REF_CAP) refIndex[tk].push(r); }

// 모듈 간 의존 엣지: refModule 이 defModule 의 심볼을 쓴다 → "refModule → defModule"
const moduleOf = (f) => f.split(path.sep)[0];
const crossModule = Object.create(null);
for (const [sym, files] of Object.entries(refIndex)) {
  const def = (defIndex[sym] || [])[0]; if (!def) continue; const dm = moduleOf(def.f);
  for (const rf of files) { const rm = moduleOf(rf); if (rm && dm && rm !== dm) { const k = `${rm} → ${dm}`; crossModule[k] = (crossModule[k] || 0) + 1; } }
}
const moduleEdges = Object.entries(crossModule).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([e, n]) => ({ edge: e, weight: n }));

// 문서 인덱스: 제목/헤딩 토큰 → 문서들
const docIndex = Object.create(null);
const docs = Object.entries(docData).map(([p, d]) => ({ path: p, title: d.title }));
for (const [p, d] of Object.entries(docData)) { const toks = new Set((`${d.title} ${(d.heads||[]).join(" ")}`.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []).map((t) => t.toLowerCase())); for (const tk of toks) { (docIndex[tk] ||= []); if (docIndex[tk].length < 20) docIndex[tk].push(p); } }

// 디렉토리/모듈/진입점
const dirFiles = {}; for (const f of allFiles) { const d = path.dirname(rel(f)); (dirFiles[d] ||= []).push(f); }
const dirs = Object.keys(dirFiles).filter((d) => d !== "." && d.split(path.sep).length <= 2).sort().map((d) => ({ path: d, files: dirFiles[d].length, purpose: dirPurpose(path.join(ROOT, d), dirFiles[d]) }));
const modules = detectModules();
const entryPoints = detectEntryPoints();

const topSymbols = Object.entries(refCount).map(([name, refs]) => { const defs = defIndex[name] || []; const def = defs.find((x) => !isCodegen(x.f)) || defs[0]; return { name: display[name] || name, key: name, refs, defAt: def ? `${def.f}:${def.l}` : null }; })
  .filter((s) => s.defAt && !isCodegen(s.defAt.split(":")[0])).sort((a, b) => b.refs - a.refs).slice(0, 30);

// ── 위생(hygiene): 정리 후보 ──────────────────────────────────────
// 1) 쓰레기/레거시 파일·폴더(디스크 스캔). 2) 고아 코드 = 변별 심볼이 어디서도 안 쓰이는 파일.
const junk = scanJunk(ROOT);
const entrySet = new Set(entryPoints.map((e) => e.path));
const orphanCandidates = [];
for (const [r, syms] of Object.entries(fileSymbols)) {
  if (entrySet.has(r)) continue;                                   // 진입점은 참조 0이어도 정상
  if (/(^|\/)(tools|scripts|tests?|__tests__|spec|migrations?|examples?)\//.test(r)) continue; // 독립실행/테스트 제외
  const distinct = syms.filter((s) => distinctive(s.n));
  if (!distinct.length) continue;                                  // 변별 심볼 없으면 판단 보류
  const usedElsewhere = distinct.some((s) => (refIndex[s.n.toLowerCase()] || []).some((f) => f !== r));
  if (!usedElsewhere) orphanCandidates.push({ path: r, symbols: distinct.slice(0, 4).map((s) => s.n) });
}
orphanCandidates.sort((a, b) => a.path.localeCompare(b.path));

const cacheJson = JSON.stringify(nextCache);
const fingerprintHash = `sha256:${createHash("sha256").update(cacheJson).digest("hex")}`;
const projectRootHash = `sha256:${createHash("sha256").update(ROOT).digest("hex")}`;

const map = {
  schemaVersion: "agentlas.code-map.v2", project: path.basename(ROOT),
  projectRootHash, fingerprintHash, generatedAt: new Date(Date.now()).toISOString(),
  stats: { totalFiles: allFiles.length, codeFiles: Object.keys(codeData).length, docs: docs.length, symbols: Object.keys(defIndex).length, rankable: rankSet.size, refsEdges: Object.values(refCount).reduce((a, b) => a + b, 0), entryPoints: entryPoints.length, junk: junk.length, orphans: orphanCandidates.length, reread, reused, genMs: Date.now() - t0 },
  modules, entryPoints, moduleEdges, byExt: Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 20)),
  hygiene: { junk, orphanCandidates: orphanCandidates.slice(0, 100) },
  topSymbols, dirs, fileSymbols, defIndex, refIndex, refCount, docs, docIndex,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "project-map.json"), JSON.stringify(map, null, 2));

// 주입용 시드. 전체 지도는 refIndex/defIndex/docIndex/fileSymbols 때문에 이 저장소에서
// 33MB까지 커졌고, 그 크기가 read 캡을 넘겨 지도가 6개월 가까이 조용히 죽어 있었다.
// 턴에 주입되는 건 사실 아래 몇 필드뿐이므로(모듈/진입점/최다참조), 큰 인덱스는
// find 도구 몫으로 남기고 주입은 이 작은 파일만 읽는다.
const seed = {
  schemaVersion: map.schemaVersion, project: map.project, projectRootHash, fingerprintHash, generatedAt: map.generatedAt,
  stats: map.stats, modules, entryPoints, moduleEdges, byExt: map.byExt, topSymbols, dirs,
};
fs.writeFileSync(path.join(OUT_DIR, "project-seed.json"), JSON.stringify(seed, null, 2));
fs.writeFileSync(CACHE, cacheJson);

const md = [
  `# ${map.project} — 프로젝트 지도 (agentlas.code-map.v2)`, ``,
  `생성 ${map.generatedAt} · ${map.stats.genMs}ms · 파일 ${map.stats.totalFiles} · 코드 ${map.stats.codeFiles} · 문서 ${map.stats.docs} · 심볼 ${map.stats.symbols} · 참조 ${map.stats.refsEdges}`,
  `증분: 다시읽음 ${reread} / 재사용 ${reused}`, ``,
  `## 모듈`, ...modules.map((m) => `- **${m.id}** — ${m.role}`), ``,
  `## 진입점`, ...entryPoints.slice(0, 12).map((e) => `- \`${e.path}\` — ${e.why}`), ``,
  `## 가장 중심적인 코드 (참조순)`, ...topSymbols.slice(0, 12).map((s) => `- \`${s.name}\` — ${s.refs}곳 · ${s.defAt}`), ``,
  `## 정리 후보 (코드맵에서 제외됨) — 쓰레기 ${junk.length} · 고아 ${orphanCandidates.length}`,
  ...(junk.length ? junk.slice(0, 8).map((j) => `- 🗑 \`${j.path}\` — ${j.reason}${j.kind === "dir" ? ` (${j.files}개)` : ""}`) : ["- (쓰레기/레거시 파일 없음)"]),
  ...(orphanCandidates.length ? [`- 🪦 고아 코드 ${orphanCandidates.length}개 (아무도 안 쓰는 심볼만 보유) — \`find.mjs --orphans\` 로 전체 목록`] : []),
  ``,
  `## 사용법`, "- `find.mjs <검색어>` 어디 / `--refs <심볼>` 누가쓰나 / `--doc <키워드>` 문서 / `--top` 중심 / `--dir <폴더>` 폴더조각 / `--orphans` 정리후보",
].join("\n");
fs.writeFileSync(path.join(OUT_DIR, "project-map.md"), md);
console.log(JSON.stringify({ ok: true, ...map.stats, modules: modules.length, dirs: dirs.length }, null, 2));
