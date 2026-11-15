// 프로젝트 코드 색인(코드맵 5파일)의 자리 — 엔진 `agentlas_cloud/code_index_location.py`와 같은 규칙을 TS 로 옮긴 한 곳 (오너).
//
// 색인은 지금까지 프로젝트 폴더 안(`<프로젝트>/.agentlas/code-map/`)에 있었다. 스위치(`memory_layout=split-1`)가 켜지면 엔진은 프로젝트 기억 폴더 옆에 쓴다:
//   `<기억 루트>/owners/<sha256(소유자)>/projects/<sha256(프로젝트 키)[:32]>/index/<sha256(실제 경로)[:12]>/`
// 이 파일은 "어느 폴더인가"만 답한다. 형식·생성기·쿼리는 그대로다. 읽기는 새 자리·옛 자리 중 **완전한** 쪽(셋 파일 `project-map.json`·`manifest.json`·`.cache.json`),
// 둘 다 완전하면 manifest 가 엄밀히 늦은 쪽(같으면 새 것). 읽기는 루트 DB 도 소유자 레지스트리도 만들지 않는다. 쓰기(비상 생성기)는 스위치가 정확히 `split-1` 일 때만 새 자리.
// ★엔진 규칙과 다르게 만들지 않는다 — 입력표(`mem/project-index-vectors`)를 파이썬과 TS 가 같이 돌려 맞춘다. 규칙이 바뀌면 엔진 쪽이 먼저다.
// ★Electron 을 가져오지 않는다(활성화 검사·안전 읽기는 읽는 순간에만 늦게 불러온다). 데몬·시험이 같은 파일을 읽는다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentlasHomeDir } from "../agents/home";
import { folderIsWritable } from "../fs/writable-folder";

export const INDEX_DIRNAME = "index";
export const LEGACY_PARTS = [".agentlas", "code-map"] as const;
export const CORE_FILES = ["project-map.json", "manifest.json", ".cache.json"] as const;
export const ALL_FILES = ["project-map.json", "project-map.md", "project-seed.json", ".cache.json", "manifest.json"] as const;
/**
 * 엔진과 같은 숫자: Windows 는 260자에서 멈추고, 그 밖에서는 터무니없는 루트만 막는다(엔진 `agentlas_cloud/code_index_location.py:49` 와 같은 줄).
 * basis: 바깥 제약 — Windows MAX_PATH 260(NUL 포함 259)에서 `\` 와 이 폴더의 가장 긴 파일 이름(project-seed.json 17자)을 뺀 값을 올림해 20자 여유를 둔 240.
 * 엔진이 같은 숫자로 같은 자리를 정하므로 데스크탑 혼자 올리면 둘이 다른 폴더를 가리킨다(엔진은 읽기 전용이라 이번에는 올리지 않았다. 엔진에는 `long_path.py` 도우미가
 * 있으나 이 가드는 그 위에서도 240이다; Node 의 fs 가 긴 절대 경로를 `\\?\` 로 처리하는지는 이 Mac에서 확인할 수 없어 Windows VM 시험 대기열에 있다).
 * 닿으면: indexDir() 가 null → codeMapDir() 가 옛 자리(`<프로젝트>/.agentlas/code-map/`)를 가리킨다 — 지도가 사라지는 것은 아니다. 이전에는 말이 없었고,
 * 이제 프로젝트마다 한 번 로그 한 줄(`index_path_too_long`: 프로젝트 해시·글자 수·한도)이 남는다. 그 밖의 900: 정한 값 — 근거 없음.
 */
export const MAX_PATH_CHARS = process.platform === "win32" ? 240 : 900;
export const SPLIT_LAYOUT = "split-1";
const MARKER_RELATIVE = [".agentlas", "memory-map.json"];
const MAX_MARKER_BYTES = 4 * 1024 * 1024;

export type IndexFileName = "project-seed.json" | "project-map.json";

/** 색인 자리를 푸는 데 필요한 둘: 기억 루트와 소유자(엔진이 `context` 명령을 받을 때 보는 것과 같은 것). 소유자 없음 = 옛 자리. */
export interface IndexContext {
  memoryRoot: string;
  /** 앞의 것이 읽기·쓰기 기준. 뒤의 것은 지우기에서만 함께 본다(현재 계정이 엔진의 기본 소유자와 다를 때). */
  owners: readonly string[];
}

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// --- 파이썬과 같게 맞추는 작은 규칙들 ----------------------------------------------------------------------------------------------

/** 파이썬 `str.encode("utf-8", errors="replace")` 는 짝 없는 서로게이트를 `?` 로 바꾼다(Node 는 U+FFFD). 경로 해시 입력이 같아야 한다. */
function pyUtf8(value: string): Buffer {
  return Buffer.from(value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "?"), "utf8");
}
const shaPath = (value: string): string => createHash("sha256").update(pyUtf8(value)).digest("hex");
/** 파이썬 `str.strip()` 이 공백으로 치는 글자(JS `trim` 과 다르다: `\x1c-\x1f`·`\x85` 는 공백, BOM `\ufeff` 는 아니다). */
function pyBlank(value: string): boolean {
  return /^[\t-\r\x1c- \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(value);
}
const charLength = (value: string): number => Array.from(value).length;

/** 파이썬 `os.path.realpath`(엄격하지 않음): 있는 만큼 링크를 풀고 없는 꼬리는 그대로 붙인다(끊어진 링크는 가리키는 곳까지 따라간다 — 파이썬과 같다). Windows 는 실제 대소문자(`native`). */
export function realPathLoose(target: string): string {
  const real = (p: string): string => (process.platform === "win32" ? fs.realpathSync.native(p) : fs.realpathSync(p));
  const absolute = path.resolve(target);
  try { return real(absolute); } catch { /* 없는 꼬리가 있다 */ }
  // 끊어진 링크: 파이썬 `os.path.realpath` 는 링크가 가리키는 (없는) 경로로 푼다. 드라이브가 빠진 프로젝트의 색인 자리가 엔진과 어긋나지 않게(G).
  try { if (fs.lstatSync(absolute).isSymbolicLink()) { const to = fs.readlinkSync(absolute); return realPathLoose(path.isAbsolute(to) ? to : path.join(path.dirname(absolute), to)); } } catch { /* 링크가 아니거나 못 읽는다 */ }
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    current = parent;
    try { return path.join(real(current), ...tail); } catch { /* 더 위로 */ }
  }
}

/** `path:` + sha256(실제 경로): 엔진 `project_identity.path_key` 와 같은 열쇠(프로젝트 저장소 폴더 이름의 뿌리, 결함 11). 실제 경로는 `realPathLoose`(파이썬 `realpath` 와 같은 풀이). */
export const pathKeyOfReal = (real: string): string => "path:" + shaPath(real);
export const projectPathKey = (projectPath: string): string => pathKeyOfReal(realPathLoose(projectPath));

/** `sha256(실제 경로)[:12]` — `cp -r` 복사본은 표식의 uid 를 같이 가져가지만 색인은 따로 갖는다. */
export function indexPathHash(projectPath: string): string { return shaPath(realPathLoose(projectPath)).slice(0, 12); }

/**
 * 표식 파일의 `projectUid`(없거나 못 읽으면 null). 한 턴에 컨텍스트 하나를 만들 때 이 함수가 약 열 번 불리므로 파일을 매번 읽어 풀지 않는다(G): 표식 파일의 (크기, 수정 시각, inode)가
 * 그대로이면 지난번 답을 쓴다 — 바뀌었으면 다시 읽는다(변경 표시로 무효화). 크기 상한 MARKER_CACHE_MAX 개(가장 오래 안 쓴 것부터 버린다). 읽는 곳이 이 함수 하나뿐이라 따로 지울 일은 없다.
 */
const MARKER_CACHE_MAX = 64;
const markerUidCache = new Map<string, { stamp: string; uid: string | null }>();
function markerUid(projectPath: string): string | null {
  const file = path.join(projectPath, ...MARKER_RELATIVE);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { markerUidCache.delete(file); return null; }
  if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return null;
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  const hit = markerUidCache.get(file);
  if (hit && hit.stamp === stamp) { markerUidCache.delete(file); markerUidCache.set(file, hit); return hit.uid; }
  let uid: string | null = null;
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff+/, ""));
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = (payload as { projectUid?: unknown }).projectUid;
      if (typeof value === "string" && !pyBlank(value)) uid = value;
    }
  } catch { /* 표식 깨짐 → 경로 해시 */ }
  markerUidCache.set(file, { stamp, uid });
  while (markerUidCache.size > MARKER_CACHE_MAX) markerUidCache.delete(markerUidCache.keys().next().value as string);
  return uid;
}

/** 엔진 `project_identity.project_key`: 표식의 `projectUid`, 없거나 못 읽으면 `path:` + sha256(실제 경로). 던지지 않고 쓰지 않는다. */
export function folderProjectKeyOf(projectPath: string): string {
  try { const uid = markerUid(projectPath); if (uid !== null) return uid; } catch { /* 표식 없음·깨짐 → 경로 해시 */ }
  return "path:" + shaPath(realPathLoose(projectPath));
}

// --- 엔진이 보는 기억 루트·소유자 -----------------------------------------------------------------------------------------------------

function expandUser(value: string): string {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(1)) : value;
}

/** 엔진 `memory_runtime.memory_root()`: `AGENTLAS_MEMORY_ROOT`, 없으면 `AGENTLAS_HOME/memory`(데스크탑이 `withDesktopEngineHost` 로 같은 홈을 넘긴다). 절대 경로가 아니면 null. */
export function engineMemoryRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const explicit = (env.AGENTLAS_MEMORY_ROOT ?? "").trim();
    const root = explicit ? expandUser(explicit)
      : path.join(expandUser((env.AGENTLAS_HOME ?? "").trim() || (env === process.env ? agentlasHomeDir() : "~/.agentlas")), "memory");
    return path.isAbsolute(root) ? path.resolve(root) : null;
  } catch { return null; }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/;
function safeId(value: string): string | null {
  return SAFE_ID.test(value) && !value.includes("..") && !/^[A-Za-z]:\//.test(value) ? value : null;
}
const REGISTRY_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/**
 * 엔진 `memory_runtime.owner_binding(create=False)` 가 이 환경에서 내는 소유자. 환경의 이름공간이 있으면 그것, 없으면 레지스트리의 기기 id(`device-local:<id>`).
 * 레지스트리가 없으면(만든 적 없음)·링크이면·깨졌으면 null — 엔진도 옛 자리를 쓴다. 읽기만 한다(레지스트리를 만들지 않는다).
 * 호스트 묶음 파일(`AGENTLAS_MEMORY_BINDING_*`)이 환경에 있으면 엔진이 서명을 확인한 뒤 이름공간을 쓴다 — 여기서는 확인할 수 없으니 이름공간을 그대로 믿는다.
 */
export function engineIndexOwner(memoryRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const explicit = (env.AGENTLAS_MEMORY_OWNER_NAMESPACE ?? "").trim();
    const bindingFile = env.AGENTLAS_MEMORY_BINDING_FILE, bindingRevision = env.AGENTLAS_MEMORY_BINDING_REVISION;
    if (bindingFile || bindingRevision) return bindingFile && bindingRevision && explicit ? safeId(explicit) : null;
    if (explicit) return safeId(explicit);
    const registry = path.join(memoryRoot, "registry.json");
    if (fs.lstatSync(registry).isSymbolicLink()) return null;
    const record = JSON.parse(fs.readFileSync(registry, "utf8")) as { schemaVersion?: unknown; deviceCustodyId?: unknown };
    return record && record.schemaVersion === "agentlas.memory-registry.v1" && typeof record.deviceCustodyId === "string" && REGISTRY_UUID.test(record.deviceCustodyId)
      ? "device-local:" + record.deviceCustodyId : null;
  } catch { return null; }
}

/** 데스크탑이 엔진 `context` 명령을 띄울 때 엔진이 보는 것과 같은 (기억 루트, 소유자). `extraOwners` 는 지우기 때 함께 볼 다른 소유자(현재 계정). */
export function defaultIndexContext(extraOwners: readonly string[] = []): IndexContext {
  const memoryRoot = engineMemoryRoot();
  if (!memoryRoot) return { memoryRoot: "", owners: [] };
  const primary = engineIndexOwner(memoryRoot);
  return { memoryRoot, owners: [...new Set([...(primary ? [primary] : []), ...extraOwners.filter(Boolean)])] };
}

// --- 자리 ---------------------------------------------------------------------------------------------------------------------------

export function legacyIndexDir(projectPath: string): string { return path.join(projectPath, ...LEGACY_PARTS); }

function accountFolder(ctx: IndexContext, owner: string): string { return path.join(ctx.memoryRoot, "owners", sha(owner)); }

function isLinkOrUnknown(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ENOTDIR" || code === "EBADF" || code === "ELOOP");
  }
}

/** `target` 이나 그 위(`boundary` 까지)에 링크가 있는가(있는 부분만). 못 보면 true. */
function linksInside(target: string, boundary: string): boolean {
  let part = target;
  for (;;) {
    if (part === boundary) return false;
    if (isLinkOrUnknown(part)) return true;
    const parent = path.dirname(part);
    if (parent === part) return false;
    part = parent;
  }
}

/** 새 자리 폴더의 경로(검사 전). 소유자가 없으면 null. 경로만 계산하고 아무것도 만들지 않는다. */
function indexTarget(projectPath: string, ctx: IndexContext): string | null {
  const owner = ctx.owners[0];
  if (!owner || !ctx.memoryRoot) return null;
  const folder = path.join(accountFolder(ctx, owner), "projects", sha(folderProjectKeyOf(projectPath)).slice(0, 32));
  return path.join(folder, INDEX_DIRNAME, indexPathHash(projectPath));
}

/** 새 자리 폴더. 소유자가 없거나 링크가 있거나 경로가 너무 길면 null(= 옛 자리를 쓴다). 경로만 계산하고 아무것도 만들지 않는다. */
export function indexDir(projectPath: string, ctx: IndexContext = defaultIndexContext()): string | null {
  try {
    const target = indexTarget(projectPath, ctx);
    if (!target) return null;
    const chars = charLength(target);
    if (chars > MAX_PATH_CHARS) { tellPathTooLongOnce(projectPath, chars); return null; }
    if (linksInside(target, ctx.memoryRoot)) return null;
    return target;
  } catch { return null; }
}

/** 길이 때문에 막힌 것을 이미 말한 프로젝트(경로 해시). 프로세스당 한 번씩만 말하고, 256개를 넘으면 더는 말하지 않는다(메모리 상한). */
const toldTooLong = new Set<string>();
// basis: 정한 값 — 근거 없음. 한 프로세스가 로그로 말하는 프로젝트 수의 상한(Set 크기): 넘으면 새 프로젝트는 말없이 옛 자리를 쓴다(이 줄이 사라질 뿐 동작은 같다).
const TOLD_TOO_LONG_MAX = 256;
function tellPathTooLongOnce(projectPath: string, chars: number): void {
  try {
    const key = indexPathHash(projectPath);
    if (toldTooLong.has(key) || toldTooLong.size >= TOLD_TOO_LONG_MAX) return;
    toldTooLong.add(key);
    // No path in the line (a path names the person's folders); the hash is the same 12 characters the index folder itself is named by.
    console.info("[project-index]", JSON.stringify({ code: "index_path_too_long", project: key, chars, maxChars: MAX_PATH_CHARS }));
  } catch { /* a log line cannot refuse */ }
}

function regularFile(file: string): boolean {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}

/** 지도를 읽는 데 필요한 셋 파일이 모두 정규 파일이면 manifest 의 mtime(ms), 아니면 null. */
export function completeStamp(folder: string | null): number | null {
  if (!folder) return null;
  try {
    if (!CORE_FILES.every(name => regularFile(path.join(folder, name)))) return null;
    return fs.statSync(path.join(folder, "manifest.json")).mtimeMs;
  } catch { return null; }
}

/** 읽기: 새·옛 중 완전한 것(둘 다면 manifest 가 엄밀히 늦은 쪽, 같으면 새 것). 쓰기(`forWrite`): 스위치가 켜졌을 때만 새 자리. */
export function codeMapDir(projectPath: string, options: { forWrite?: boolean; ctx?: IndexContext } = {}): string {
  const ctx = options.ctx ?? defaultIndexContext();
  const old = legacyIndexDir(projectPath);
  const fresh = indexDir(projectPath, ctx);
  if (fresh === null) return old;
  if (options.forWrite) return writeSwitchOn(ctx) ? fresh : old;
  const newStamp = completeStamp(fresh), oldStamp = completeStamp(old);
  if (newStamp === null && oldStamp === null) {
    // 어느 쪽도 완전하지 않다: 무언가 가진 쪽을 가리켜 진단이 그것을 말하게 한다. 같으면 옛 자리.
    return regularFile(path.join(fresh, "project-map.json")) && !regularFile(path.join(old, "project-map.json")) ? fresh : old;
  }
  if (newStamp === null) return old;
  if (oldStamp === null) return fresh;
  return newStamp >= oldStamp ? fresh : old;
}

/** 소유자 뿌리 DB 의 `memory_layout` 이 정확히 `split-1` 인가. 읽기 전용으로 따로 열고(250ms), 못 읽으면 꺼짐. 읽기 경로는 부르지 않는다. */
export function writeSwitchOn(ctx: IndexContext = defaultIndexContext()): boolean {
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } | null = null;
  try {
    const owner = ctx.owners[0];
    if (!owner || !ctx.memoryRoot) return false;
    const file = path.join(accountFolder(ctx, owner), "memory.sqlite");
    if (!fs.statSync(file).isFile()) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as new (file: string, options: { readonly: boolean; fileMustExist: boolean; timeout: number }) => NonNullable<typeof db>;
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 250 });
    const row = db.prepare("SELECT value FROM memory_store_meta WHERE key=?").get("memory_layout") as { value?: unknown } | undefined;
    return row?.value === SPLIT_LAYOUT;
  } catch { return false; } finally { try { db?.close(); } catch { /* 이미 닫힘 */ } }
}

/** 새 자리의 위쪽 폴더를 만들고(소유자만) 쓸 수 있는지 본다. 못 하면 false = 옛 자리를 계속 쓴다. 마지막 폴더는 만들지 않는다(쓰는 쪽이 만든다). */
export function newPlaceWritable(folder: string): boolean {
  try {
    const missing: string[] = [];
    for (let part = path.dirname(folder); !fs.existsSync(part); part = path.dirname(part)) missing.unshift(part);
    for (const part of missing) fs.mkdirSync(part, { mode: 0o700 });
    return folderIsWritable(path.dirname(folder));
  } catch { return false; }
}

/**
 * 비상 생성기(`code-map-gen.mjs`)가 쓸 폴더(`CODE_MAP_OUT`). 스위치가 꺼졌거나 새 자리를 만들 수 없으면 null — 환경값을 주지 않으면 생성기는 옛 자리에 쓴다(바이트까지 이전과 같다).
 * 비상 생성기는 manifest 를 쓰지 않는다: 이 폴더는 "완전"하지 않지만, 옛 자리에 지도가 없으면 읽기 규칙이 이 폴더를 가리킨다.
 */
export function emergencyCodeMapOut(projectPath: string, ctx: IndexContext = defaultIndexContext()): string | null {
  const place = codeMapDir(projectPath, { forWrite: true, ctx });
  return place !== legacyIndexDir(projectPath) && newPlaceWritable(place) ? place : null;
}

// --- 읽기 (활성화 게이트 선통과) ---------------------------------------------------------------------------------------------------------

type SafeRead = typeof import("./safe-project-read");
type Activation = typeof import("../architecture/activation");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const safeRead = (): SafeRead => require("./safe-project-read") as SafeRead;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const activated = (projectPath: string): boolean => (require("../architecture/activation") as Activation).verifyActivatedFolderIdentity(projectPath);

const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean =>
  b.isFile() && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && (a.dev === b.dev || a.dev === 0n || b.dev === 0n);

/** 새 자리의 파일 하나를 한도 안에서 읽는다(링크·덩치·읽는 사이의 교체는 null). 새 자리는 프로젝트 폴더 밖이라 `.agentlas` 안전 읽기를 지나지 않고, 여기서 같은 검사를 한다. */
function readNewPlaceText(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) return null;
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    if (!sameFile(opened, fs.lstatSync(file, { bigint: true }))) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 읽기뿐이다 */ } } }
}

async function readNewPlaceTextAsync(file: string, maxBytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = await fs.promises.lstat(file, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)) return null;
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) return null;
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    if (!sameFile(opened, await fs.promises.lstat(file, { bigint: true }))) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch { return null; } finally { try { await handle?.close(); } catch { /* 읽기뿐이다 */ } }
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/**
 * 코드 색인 파일 하나를 JSON 으로. 활성화된 폴더만 읽는다(`verifyActivatedFolderIdentity` 를 먼저). 옛 자리가 가리켜지면 예전 안전 읽기를 그대로 쓴다(바이트·부수 효과 이전과 같다).
 * 새 자리의 파일은 출처 카탈로그에 올리지 않는다(만들어 낸 파생물이고 `.agentlas` 밖이다).
 */
export function readProjectIndexJson<T>(projectPath: string, name: IndexFileName, maxBytes: number, ctx?: IndexContext): T | null {
  if (!activated(projectPath)) return null;
  const dir = codeMapDir(projectPath, { ctx });
  if (dir === legacyIndexDir(projectPath)) return safeRead().readActivatedProjectMemoryJson<T>(projectPath, `code-map/${name}`, maxBytes);
  const parsed = parseJson<T>(readNewPlaceText(path.join(dir, name), maxBytes));
  return parsed !== null && activated(projectPath) ? parsed : null;
}

export async function readProjectIndexJsonAsync<T>(projectPath: string, name: IndexFileName, maxBytes: number, ctx?: IndexContext): Promise<T | null> {
  if (!activated(projectPath)) return null;
  const dir = codeMapDir(projectPath, { ctx });
  if (dir === legacyIndexDir(projectPath)) return safeRead().readActivatedProjectMemoryJsonAsync<T>(projectPath, `code-map/${name}`, maxBytes);
  const parsed = parseJson<T>(await readNewPlaceTextAsync(path.join(dir, name), maxBytes));
  return parsed !== null && activated(projectPath) ? parsed : null;
}

/** 그 색인 파일이 지금 가리키는 자리에 한도 안의 정규 파일로 있는가. */
export function projectIndexFileExists(projectPath: string, name: IndexFileName, maxBytes: number, ctx?: IndexContext): boolean {
  if (!activated(projectPath)) return false;
  const dir = codeMapDir(projectPath, { ctx });
  if (dir === legacyIndexDir(projectPath)) return safeRead().activatedProjectMemoryFileExists(projectPath, `code-map/${name}`, maxBytes);
  try {
    const stat = fs.lstatSync(path.join(dir, name));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes && activated(projectPath);
  } catch { return false; }
}

export async function projectIndexFileExistsAsync(projectPath: string, name: IndexFileName, maxBytes: number, ctx?: IndexContext): Promise<boolean> {
  return projectIndexFileExists(projectPath, name, maxBytes, ctx);
}

// --- 지우기 ---------------------------------------------------------------------------------------------------------------------------

export interface IndexRemoval { removed: number; left: number }

async function removeTree(target: string, boundary: string): Promise<boolean> {
  try {
    if (linksInside(target, boundary)) return false;
    await fs.promises.rm(target, { recursive: true, force: true });
    return !fs.existsSync(target);
  } catch { return false; }
}

/**
 * 프로젝트 하나의 색인을 지운다(프로젝트 행이 지워진 뒤). 지우는 것은 이 폴더의 항목뿐이다: 이름이 `sha256(실제 경로)[:12]` 이거나 manifest 의 `projectRoot` 가 이 폴더인 항목
 * (같은 uid 를 쓰는 `cp -r` 복사본의 색인·다른 프로젝트의 색인은 그대로). 기억 키(프로젝트 id)와 폴더 키가 달라도, 폴더의 키가 바뀌어(표식이 나중에 생김) 다른 `projects/<키>/` 아래에 남은 것도
 * 같은 규칙으로 찾는다. 폴더 경로가 없는 프로젝트는 id 로 이름 붙은 저장소의 `index/` 전체. 사용자 폴더의 `.agentlas/code-map/` 은 건드리지 않는다.
 * 끝난 뒤 경로를 다시 읽어 남은 수를 센다. 던지지 않는다.
 */
export async function removeProjectIndex(project: { id: string; path: string | null }, ctx: IndexContext = defaultIndexContext()): Promise<IndexRemoval> {
  const out: IndexRemoval = { removed: 0, left: 0 };
  if (!ctx.memoryRoot) return out;
  const folder = project.path ? realPathLoose(project.path) : null;
  const hash = project.path ? indexPathHash(project.path) : null;
  for (const owner of ctx.owners) {
    try {
      const account = accountFolder(ctx, owner);
      const projects = path.join(account, "projects");
      let children: string[];
      try { children = await fs.promises.readdir(projects); } catch { continue; }
      const byId = project.id ? sha(project.id).slice(0, 32) : null;
      for (const child of children) {
        const base = path.join(projects, child);
        const index = path.join(base, INDEX_DIRNAME);
        let entries: string[];
        try {
          if ((await fs.promises.lstat(base)).isSymbolicLink() || (await fs.promises.lstat(index)).isSymbolicLink()) continue;
          entries = await fs.promises.readdir(index);
        } catch { continue; }
        let touched = false;
        for (const entry of entries) {
          const target = path.join(index, entry);
          let mine = !project.path && child === byId;
          if (!mine && hash) {
            mine = entry === hash;
            if (!mine) {
              try {
                const manifest = JSON.parse(await fs.promises.readFile(path.join(target, "manifest.json"), "utf8")) as { projectRoot?: unknown };
                mine = typeof manifest.projectRoot === "string" && manifest.projectRoot !== "" && realPathLoose(manifest.projectRoot) === folder;
              } catch { /* manifest 없음 = 누구 것인지 모른다: 건드리지 않는다 */ }
            }
          }
          if (!mine) continue;
          touched = true;
          if (await removeTree(target, account)) out.removed += 1; else out.left += 1;
        }
        // 이 프로젝트의 것을 지운 폴더만, 비었으면 껍데기를 치운다(저장소 파일이 있으면 rmdir 이 거절한다). 다른 프로젝트의 폴더는 건드리지 않는다.
        if (touched) { try { await fs.promises.rmdir(index); await fs.promises.rmdir(base); } catch { /* 비어 있지 않다 */ } }
      }
    } catch { out.left += 1; }
  }
  return out;
}
