// 에이전트 폴더가 "어디에 있는지"를 푸는 한 곳. (Agentlas 2.0 설계 B §3.2, 작업 묶음)
//
// 이 파일은 위치를 **풀고**, 그 폴더가 앱의 것인지 사용자의 것인지 가른다(`classifyAgentFolder`). 폴더를 옮기는 것은 home-move.ts, 라우트를 바꾸는 것은
// routes.ts 다. 만드는 것은 상태 폴더·소유 표식 도우미 두 곳뿐이다. 지금 사용자 기기의 모든 설치 형태는 이 묶음 전과 같은 경로로 풀린다.
//
// ★ Electron 을 가져오지 않는다. 데몬(agentlasd)이 Electron 없이 이 모듈을 읽는다. 라우트(`agent-routes.json`, 정의 위치의 정본)는
//   routes.ts 가 읽는데 거기엔 `electron` import 가 있으므로, 라우트는 부르는 쪽이 `getRoute(id)` 로 읽어 인자로 넘긴다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_LOCAL_STATE_DIRECTORIES } from "../../shared/upload-scan-catalog.generated";
import { userDataDir } from "../runtime-paths";

export interface AgentHomeRow {
  /** installed_agents.id */
  id: string;
  slug: string;
}
export interface AgentHomeRoute {
  path?: string | null;
}
export type AgentHomeSource = "route" | "home" | "legacy";
export interface AgentHomeResolution {
  dir: string;
  /** 라우트가 가리키는 폴더(로컬 임포트·클라우드 복원 사본)인가. 예전 `resolveDir().isLocal` 과 같은 뜻. */
  isLocal: boolean;
  /** route: 라우트가 가리키는 곳 / home: 에이전트 루트 안에서 소유 표식이 맞는 폴더 / legacy: 아직 `userData/agents/<slug>` 에 남아 있는 폴더(옮기기 전). */
  source: AgentHomeSource;
}

/** 새 에이전트 폴더를 예전 위치(`userData/agents`)가 아니라 에이전트 루트 안에 만든다(부터 항상 참 — 위치 해석 시험이 읽는다). */
export const NEW_AGENT_FOLDERS_IN_HOME = true;

export const AGENT_LOCAL_STATE_FOLDER: string = AGENT_LOCAL_STATE_DIRECTORIES[0];
export const AGENT_OWNER_FILE = "owner.json";
const ROOT_SETTINGS_FILE = "agents-root.json";
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * `~/.agentlas` (환경 `AGENTLAS_HOME` 이 우선). 엔진·데몬·훅이 읽는 것과 같은 곳.
 * 단 `AGENTLAS_HOME` 이 없고 userData 가 OS 임시 폴더 아래이면(시험이 `app.setPath("userData", 임시)` 로 격리한 경우) 그 userData 옆의 임시 홈을
 * 돌려준다 — 안 그러면 격리 안 된 시험이 사용자의 실제 `~/.agentlas/agents` 에 폴더를 만든다. 운영·개발 프로필은 임시 폴더 아래가 아니라 경로가 같다.
 * (`AGENTLAS_STORE_PATH` 로 판단하지 않는다 — 데몬이 정식 실행에서도 쓴다.)
 */
export function agentlasHomeDir(): string {
  // 상대 경로는 cwd 에 따라 다른 곳을 가리키므로 버린다(다른 환경변수와 같은 규칙). 값을 *주었다면* 임시 userData 판정을 하지 않는다.
  if (process.env.AGENTLAS_HOME?.trim()) return absoluteEnv("AGENTLAS_HOME") ?? path.join(os.homedir(), ".agentlas");
  return temporaryUserDataHome() ?? path.join(os.homedir(), ".agentlas");
}

/**
 * Main 이 정한 홈을 자식 프로세스(데몬·엔진)에 `AGENTLAS_HOME` 으로 명시적으로 알리는 환경 조각. 임시 userData 규칙이 홈을 바꾼 경우에만 값이 있다 —
 * 정식 실행(운영·개발 프로필)은 `~/.agentlas` 그대로라 빈 객체이고 자식의 경로는 변경 전과 같다. 자식은 같은 규칙을 다시 풀지 않는다(`TMPDIR` 가 다르면
 * Main 과 홈이 갈린다 — 감사 35). 이미 `AGENTLAS_HOME` 이 환경에 있으면 자식이 상속하므로 빈 객체.
 */
export function agentlasHomeEnvForChildren(): Record<string, string> {
  if (process.env.AGENTLAS_HOME?.trim()) return {};
  const chosen = agentlasHomeDir();
  return chosen === path.join(os.homedir(), ".agentlas") ? {} : { AGENTLAS_HOME: chosen };
}

// 규칙의 입력(임시 폴더·홈·userData 두 값)은 실행 중 바뀌지 않는다: 같은 입력이면 파일 시스템을 다시 풀지 않는다(호출당 realpath 3~4번 + userInfo 가 에이전트 400개
// 패스에서 2,400번 돌던 것 — 감사 35). 입력이 바뀌면(시험이 TMPDIR·HOME 을 바꾼다, 데몬이 userData 를 나중에 주입한다) 자연히 다시 계산한다.
let temporaryHomeMemo: { key: string; value: string | null } | null = null;

function temporaryUserDataHome(): string | null {
  // 터미널 엔진과 같은 userData 덮어쓰기 변수(`AGENTLAS_USER_DATA_DIR`)도 본다 — 이 변수만 주는 시험은 Electron 의 기본 userData 를 그대로 둔다.
  const candidates: string[] = [];
  const override = absoluteEnv("AGENTLAS_USER_DATA_DIR");
  if (override) candidates.push(override);
  try { candidates.push(userDataDir()); } catch { /* userData 를 모르는 호스트는 예전 그대로 */ }
  const tmp = os.tmpdir(), home = os.homedir();
  const key = JSON.stringify([tmp, home, candidates, process.env.APPDATA ?? null, process.env.XDG_CONFIG_HOME ?? null]);
  if (temporaryHomeMemo?.key === key) return temporaryHomeMemo.value;
  let accountHome: string | null = null;
  try { accountHome = os.userInfo().homedir; } catch { /* passwd 항목이 없는 계정(임의 UID 컨테이너) */ }
  const configDirs = [process.env.APPDATA, process.env.XDG_CONFIG_HOME].filter((dir): dir is string => Boolean(dir && path.isAbsolute(dir)));
  const value = decideTemporaryHome({ tmp, home, accountHome, candidates, configDirs });
  temporaryHomeMemo = { key, value };
  return value;
}

/** 시험용: 임시 홈 규칙의 기억을 비운다(입력이 같아도 파일 시스템을 다시 풀게 한다). */
export function resetTemporaryHomeMemoForTests(): void {
  temporaryHomeMemo = null;
}

/** 아직 없는 폴더도 가장 가까운 기존 상위를 풀어 비교한다(`/var` → `/private/var` 같은 별칭 때문에). */
function realOrAncestor(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); } catch { /* 없는 쪽을 한 칸 올린다 */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 임시 userData 규칙의 판정(순수: 경로 모듈과 "실제 경로" 함수를 받는다 — 세 운영체제의 경로 모양을 같은 시험 벡터로 잠근다).
 * 후보(userData) 중 OS 임시 폴더 *안*에 있고, 홈의 OS 표준 설정 폴더 안이 아니면 `<후보>/agentlas-home`, 아니면 null.
 *  - 계정 홈이 임시 폴더이거나 그 아래이면(TMPDIR 를 홈으로 둔 사용자) 규칙을 쓰지 않는다. passwd 의 홈이라 시험이 HOME 을 바꿔도 그대로다.
 *  - 프로필이 홈의 표준 설정 폴더(`Library/Application Support`·`AppData/Roaming`·`.config`·`snap`·`.var/app`, `APPDATA`·`XDG_CONFIG_HOME`) 안이면 규칙을 쓰지 않는다:
 *    TMPDIR 가 홈과 프로필 사이에 있는 구성(`TMPDIR=~/Library`)과, passwd 항목이 없고 `HOME` 이 `/tmp` 아래인 구성의 실제 프로필을 임시로 오인하지 않는다.
 *    단 그 변수 자체가 OS 임시 폴더 안이면 설정 폴더로 보지 않는다(시험이 `XDG_CONFIG_HOME=/tmp/…` 로 격리하는 구성도 임시로 본다).
 *    (홈 "안"이면 전부 쓰지 않는 것이 아니다 — Windows 는 `%TEMP%` 가 홈 안이라 임시 userData 시험이 그 규칙을 받아야 한다.)
 */
export function decideTemporaryHome(input: {
  tmp: string; home: string; accountHome: string | null; candidates: readonly string[]; configDirs?: readonly string[];
  real?: (value: string) => string; pathApi?: Pick<typeof path, "join" | "relative" | "isAbsolute" | "resolve">;
}): string | null {
  const api = input.pathApi ?? path;
  const real = input.real ?? realOrAncestor;
  const inside = (root: string, target: string): boolean => { const rel = api.relative(root, target); return rel !== "" && !rel.startsWith("..") && !api.isAbsolute(rel); };
  const temp = real(input.tmp);
  if (input.accountHome) { const account = real(input.accountHome); if (account === temp || inside(temp, account)) return null; }
  // passwd 항목이 없는 계정(임의 UID 컨테이너)은 `HOME` 이 곧 홈이다 — 그 홈이 임시 폴더 안이면 사용자의 진짜 홈이 거기 있는 것이다(시험은 passwd 가 있는 기계에서 HOME 을 바꾼다, #7).
  if (!input.accountHome && input.home) { const own = real(input.home); if (own === temp || inside(temp, own)) return null; }
  const homes = [input.home, ...(input.accountHome ? [input.accountHome] : [])].filter(Boolean);
  // 설정 폴더 변수(`APPDATA`·`XDG_CONFIG_HOME`)가 사용자의 프로필 표지인가. 지금의 임시 폴더 변수 *안*이라는 이유만으로 "시험이 만든 격리 폴더"로 보면 정식 구성이 임시로 오판된다 —
  // `TMPDIR=/data` + `XDG_CONFIG_HOME=/data/config`, `TEMP=D:\` + `APPDATA=D:\AppData\Roaming`, `TMPDIR=/run/user/1000` 아래의 설정(사용자의 에이전트·기억이 빈 것처럼 보였다, #7).
  // 그래서 격리 폴더로 보는 것은 OS 가 정한 *사용자별 임시 자리*(Windows `<홈>\AppData\Local\Temp`, macOS `/var/folders`) 안의 설정 폴더뿐이다(#4: 시험이 거기에 격리한다).
  // ★정식이 이기는 구성: 설정 폴더 변수가 `/tmp`·`/var/tmp` 아래(`XDG_CONFIG_HOME=/tmp/u-config`)이면 시험 격리와 경로로 구분할 수 없다 — 사용자의 기억이 안 보이는 것이 시험 오염보다 나쁘므로 정식으로 본다.
  //   시험은 `AGENTLAS_HOME` 을 명시해 격리한다(그 구성의 시험은 규칙에 기대지 않는다).
  const userTempAreas = [...homes.map((home) => api.join(home, "AppData", "Local", "Temp")), "/var/folders", "/private/var/folders"].map(real);
  const configDirs = [...homes.flatMap((home) => [api.join(home, "Library", "Application Support"), api.join(home, ".config"), api.join(home, "AppData", "Roaming"), api.join(home, "snap"), api.join(home, ".var", "app")]),
    ...(input.configDirs ?? []).filter((dir) => { const resolved = real(dir); return !userTempAreas.some((area) => resolved === area || inside(area, resolved)); })].filter(Boolean).map(real);
  const found = input.candidates.find((candidate) => { const profile = real(candidate); return inside(temp, profile) && !configDirs.some((dir) => inside(dir, profile)); });
  return found ? api.join(found, "agentlas-home") : null;
}

function defaultAgentHomeRoot(): string {
  return path.join(agentlasHomeDir(), "agents");
}

function absoluteEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}

type SettingsRoot = { state: "none" } | { state: "invalid" } | { state: "set"; path: string };

/** `agents-root.json` 읽기. 파일이 없으면 none, 있는데 못 읽거나 모양이 틀리면 invalid(어디를 가리키는지 모른다), 맞으면 그 절대경로. */
function readSettingsRoot(): SettingsRoot {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(agentlasHomeDir(), ROOT_SETTINGS_FILE), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "invalid" };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as { v?: unknown; path?: unknown };
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.path !== "string" || !path.isAbsolute(parsed.path)) return { state: "invalid" };
    return { state: "set", path: path.resolve(parsed.path) };
  } catch {
    return { state: "invalid" };
  }
}

function isDirectory(target: string): boolean {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

/**
 * 에이전트 루트. 환경 `AGENTLAS_AGENT_HOME` → `~/.agentlas/agents-root.json`(`{"v":1,"path":"/절대/경로"}`) → `~/.agentlas/agents`.
 * 엔진의 `agents_root()` 와 같은 규칙이고 같은 고정 표(`contracts/test-vectors/agent-home-root-vectors.json`)를 읽는다.
 * (`AGENTLAS_AGENTS_DIR` 은 시험 격리 전용이라 엔진에 없었고 루트를 갈라놓아 에 없앴다.) 읽기만 하며 아무것도 만들지 않는다. 예외를 던지지 않는다.
 * 읽기용이다 — 설정된 루트가 지금 없으면 다음 후보로 내려간다. 상태를 *쓰는* 곳은 `agentHomeRootStatus()` 를 본다(쓰기 위치가 갈라지면 안 된다).
 */
export function agentHomeRoot(): string {
  const fromEnv = absoluteEnv("AGENTLAS_AGENT_HOME");
  if (fromEnv) return fromEnv;
  const settings = readSettingsRoot();
  if (settings.state === "set" && isDirectory(settings.path)) return settings.path;
  return defaultAgentHomeRoot();
}

export type AgentHomeRootStatus =
  | { configured: false; available: true; path: string }
  | { configured: true; available: true; path: string }
  | { configured: true; available: false; path: string | null; reason: "missing" | "settings-invalid" };

/**
 * 쓰기용 루트 판정. 루트가 *설정돼* 있는데(환경변수 또는 agents-root.json) 지금 폴더가 아니면(드라이브 분리·이름 변경·권한) `available:false` —
 * 기본 루트로 떨어져 새 상태를 만들지 않는다(드라이브가 돌아오면 기억이 두 곳으로 갈라진다). 설정이 아예 없으면 기본 루트(만들 수 있음).
 * 설정 파일이 있는데 못 읽거나 모양이 틀리면 어디를 가리키는지 모르므로 역시 쓸 수 없음으로 본다. 예외를 던지지 않는다.
 */
export function agentHomeRootStatus(): AgentHomeRootStatus {
  // 환경변수가 있으면 그것이 유일한 권위다(엔진 `_configured_candidates` 와 같다). 없는 폴더이면 설정 파일의 루트가 몰래 이어받지 않는다 —
  // 읽기는 환경변수 경로를 보는데 쓰기만 설정 파일 루트로 가면 기억이 두 곳으로 갈라진다.
  const env = absoluteEnv("AGENTLAS_AGENT_HOME");
  if (env) return isDirectory(env) ? { configured: true, available: true, path: env } : { configured: true, available: false, path: env, reason: "missing" };
  const settings = readSettingsRoot();
  if (settings.state === "set") {
    return isDirectory(settings.path) ? { configured: true, available: true, path: settings.path } : { configured: true, available: false, path: settings.path, reason: "missing" };
  }
  if (settings.state === "invalid") return { configured: true, available: false, path: null, reason: "settings-invalid" };
  return { configured: false, available: true, path: defaultAgentHomeRoot() };
}

/** 예전 설치 위치(`userData/agents`). 클라우드 설치 트랜잭션과 3파일 에이전트가 지금도 여기에 산다. 이 정의가 유일하다. */
export function legacyAgentsRoot(): string {
  return path.resolve(userDataDir(), "agents");
}

function idSuffix(id: string): string {
  return createHash("sha256").update(String(id ?? "")).digest("hex").slice(0, 6);
}

/**
 * 폴더 이름. NFKC → 소문자 → [^a-z0-9] 는 '-' → 앞뒤 '-' 제거 → 36자 절단. 비었거나 'local' 이면 `agent-<id6>`(한국어 전용 이름 같은 것이 한 폴더로 모이지
 * 않게; id 가 없으면 'agent'), Windows 예약어면 뒤에 '-agent'. 소문자 ASCII 뿐이라 대소문자만 다른 이름이 충돌할 수 없다.
 */
export function safeHomeName(slug: string, id?: string): string {
  const base = String(slug ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  if (!base || base === "local") return id ? `agent-${idSuffix(id)}` : "agent";
  return WINDOWS_RESERVED_NAME.test(base) ? `${base}-agent` : base;
}

/** 예전 위치의 폴더 이름. 정상 슬러그는 그대로, `..`·빈 값·구분자가 든 값은 위치 밖을 가리키지 못하게 `safeHomeName` 으로 바꾼다. */
export function legacyFolderName(row: AgentHomeRow): string {
  const slug = row?.slug;
  if (typeof slug === "string" && slug && slug !== "." && slug !== ".." && !/[\\/\0]/.test(slug)) return slug;
  return safeHomeName(typeof slug === "string" ? slug : "", row?.id);
}

function ownerAgentId(folder: string): string | null | undefined {
  // string: 소유 표식이 있고 그 id / null: 폴더는 있는데 표식이 없거나 읽을 수 없음 / undefined: 폴더가 없음
  try {
    if (!fs.statSync(folder).isDirectory()) return null;
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder, AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE), "utf8").replace(/^\uFEFF/, "")) as { agentId?: unknown };
    return typeof parsed?.agentId === "string" ? parsed.agentId : null;
  } catch {
    return null;
  }
}

/**
 * 폴더의 소유 표식(`.agentlas-local/owner.json`)이 이름 붙인 id 전부: `agentId` 와 별칭 `ids[]`(같은 폴더를 가리키던 다른 행). 표식이 없거나 읽을 수 없거나
 * 링크이면 빈 목록. 엔진의 `memory_stores._owner_ids` 와 같은 규칙이다. 던지지 않는다.
 */
export function ownerIds(folder: string): string[] {
  try {
    const file = path.join(folder, AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE);
    if (fs.lstatSync(file).isSymbolicLink()) return [];
    const payload = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { agentId?: unknown; ids?: unknown };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const found: unknown[] = [payload.agentId, ...(Array.isArray(payload.ids) ? payload.ids : [])];
    return [...new Set(found.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

/** 이 폴더의 소유 표식이 이 id 를 이름 붙였는가. 던지지 않는다. */
function ownsFolder(folder: string, id: string): boolean {
  return Boolean(id) && ownerIds(folder).includes(id);
}

/**
 * 표식 파일 쓰기: 임시 파일에 쓰고 fsync 한 뒤 rename 한다. 전원이 끊겨도 파일은 옛 내용이거나 새 내용이고 빈 파일이 되지 않는다(감사 29-6: fsync 없이 쓴
 * 표식이 0바이트로 남아 스텁이 둘로 갈렸다). `keepExisting` 이면 이미 있는 파일은 건드리지 않고 false 를 돌려준다. 못 쓰면 던진다.
 */
export function writeFileDurable(file: string, text: string, options: { keepExisting?: boolean } = {}): boolean {
  if (options.keepExisting) {
    try { if (fs.statSync(file).size > 0) return false; } catch { /* 없다: 쓴다 */ }
  }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(temp); } catch { /* the rename consumed it */ }
  }
  ownerIndex = null;
  return true;
}

// `{id → 폴더}`: 에이전트 루트 바로 아래에서 소유 표식이 그 id 를 이름 붙인 폴더(이름순 첫 폴더 — 엔진 `agent_folder_index` 와 같은 답). 루트 폴더의 mtime 으로
// 프로세스 안에서 캐시한다. 이 프로세스가 표식을 쓰면(writeFileDurable) 버린다. 폴더 이름이 슬러그에서 나오지 않는 에이전트(옮긴 로컬 임포트, 이미 생긴 상태 폴더)를
// 찾는 데만 쓴다 — 슬러그에서 나오는 두 이름은 색인 없이 바로 읽는다.
let ownerIndex: { root: string; stamp: number; byId: Map<string, string> } | null = null;

/** 캐시를 버린다(폴더를 옮기거나 지운 쪽이 부른다). */
export function invalidateOwnerIndex(): void {
  ownerIndex = null;
}

function ownerIndexFor(root: string): Map<string, string> {
  let stamp: number;
  try { stamp = fs.statSync(root).mtimeMs; } catch { return new Map(); }
  if (ownerIndex && ownerIndex.root === root && ownerIndex.stamp === stamp) return ownerIndex.byId;
  const byId = new Map<string, string>();
  let names: string[] = [];
  try { names = fs.readdirSync(root).sort(); } catch { return new Map(); }
  for (const name of names) {
    const folder = path.join(root, name);
    for (const id of ownerIds(folder)) if (!byId.has(id)) byId.set(id, folder);
  }
  ownerIndex = { root, stamp, byId };
  return byId;
}

function homeCandidates(row: AgentHomeRow, root: string = agentHomeRoot()): string[] {
  const name = safeHomeName(row.slug, row.id);
  return [path.join(root, name), path.join(root, `${name}-${idSuffix(row.id)}`)];
}

/**
 * 에이전트 루트 안에서 소유 표식이 이 행의 id 를 이름 붙인 폴더, 없으면 null. 슬러그에서 나오는 두 이름을 먼저 보고(파일 두 개), 없으면 색인을 본다 —
 * 옮긴 로컬 임포트는 폴더 이름이 슬러그(`local-<이름>`)가 아니라 원래 폴더 이름이라 이름만으로는 찾지 못한다(감사 29-2: 그래서 같은 에이전트의 상태 폴더가 따로 생겼다).
 * 던지지 않는다.
 */
export function ownedAgentFolder(row: AgentHomeRow, root: string = agentHomeRoot()): string | null {
  const id = typeof row?.id === "string" ? row.id : "";
  if (!id) return null;
  try {
    const candidates = homeCandidates(row, root);
    for (const candidate of candidates) if (ownsFolder(candidate, id)) return candidate;
    const indexed = ownerIndexFor(root).get(id);
    if (indexed && ownsFolder(indexed, id)) return indexed;
    // 표식 파일이 있는데 읽을 수 없다(전원 차단으로 빈 파일): 폴더의 다른 증거가 이 행을 가리키면 이 행의 폴더다 — 표식을 다시 쓴다. 이것이 없으면 같은 스텁이
    // `-id6` 이름으로 한 번 더 만들어져 둘로 갈린다(감사 29-6). 표식을 쓴 적이 없는 폴더는 여기 오지 않는다(이웃의 것일 수 있다).
    for (const candidate of candidates) {
      if (!hasUnreadableOwnerMarker(candidate) || !provenByOtherEvidence(candidate, row)) continue;
      try { writeFileDurable(path.join(candidate, AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE), JSON.stringify({ schema: 1, agentId: id }) + "\n"); } catch { /* 읽기 전용: 증거만으로 답한다 */ }
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function hasUnreadableOwnerMarker(folder: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(folder, AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE));
    return stat.isFile() && ownerIds(folder).length === 0;
  } catch {
    return false;
  }
}

/** 소유 표식 말고 이 폴더가 이 행의 것임을 말하는 증거: 출처 표식이 이 행의 예전 스텁 자리에서 옮겨 왔다고 적었거나, 스텁의 manifest.md 가 이 행의 id 를 적었다. */
function provenByOtherEvidence(folder: string, row: AgentHomeRow): boolean {
  try {
    const origin = JSON.parse(fs.readFileSync(path.join(folder, AGENT_LOCAL_STATE_FOLDER, "origin.json"), "utf8").replace(/^\uFEFF/, "")) as { kind?: unknown; from?: unknown };
    if (origin?.kind === "moved" && typeof origin.from === "string" && path.resolve(origin.from) === path.join(legacyAgentsRoot(), legacyFolderName(row))) return true;
  } catch { /* no readable origin: try the manifest */ }
  try {
    return fs.readFileSync(path.join(folder, "manifest.md"), "utf8").split(/\r?\n/).includes(`**id**: ${row.id}`);
  } catch {
    return false;
  }
}

/** 정의 파일이 없는 폴더인가 — 안에 상태 폴더(`.agentlas-local`)만 있다(제자리 등록한 에이전트의 앱 쪽 폴더, 정의보다 먼저 생긴 상태 폴더). */
export function isStateOnlyFolder(folder: string): boolean {
  try {
    const names = fs.readdirSync(folder).filter((name) => name !== ".DS_Store" && name !== "Thumbs.db");
    return names.length > 0 && names.every((name) => name === AGENT_LOCAL_STATE_FOLDER);
  } catch {
    return false;
  }
}

/** 에이전트 루트 안에서 이 행의 폴더 이름(이미 소유한 폴더 → 비어 있는 이름 → 남의 것이면 `-id6`). 계산만 한다. */
function homeFolderName(row: AgentHomeRow, root: string = agentHomeRoot()): string {
  const owned = ownedAgentFolder(row, root);
  if (owned) return path.basename(owned);
  const [plain, suffixed] = homeCandidates(row, root);
  if (ownerAgentId(plain) === undefined) return path.basename(plain);
  if (ownerAgentId(suffixed) === undefined) return path.basename(suffixed);
  // 두 이름이 모두 남의 폴더(사용자가 만든 같은 이름)이면 그 안에 상태를 쓰지 않는다(감사 33-6): 이 에이전트의 id 로만 정해지는 자기 이름.
  const own = `agent-${idSuffix(row.id)}`;
  return ownerAgentId(path.join(root, own)) === undefined ? own : `${own}-state`;
}

/**
 * 이 행의 폴더가 실제로 어디인가. 던지지 않는다 — 단 예전 위치를 계산하려면 `setUserDataDir()` 가 먼저 불려 있어야 한다(없으면 `userDataDir()` 가 던진다).
 *  ① 라우트(`agent-routes.json`)가 있으면 그 경로 — 정의 위치의 정본.
 *  ② 에이전트 루트 안의 폴더가 이 행의 소유 표식(`.agentlas-local/owner.json`)을 가졌으면 그것. 표식 없는 폴더는 이웃(엔진 설치본 등)의 것일 수 있어 가져가지 않는다.
 *  ③ 예전 위치 `userData/agents/<slug>` 에 아직 폴더가 있으면 그곳(옮기는 일은 home-move.ts 가 한다).
 *  ④ 그 밖에는 에이전트 루트 안의 새 이름(`homeFolderName`) — 새 폴더는 여기에 태어난다.
 */
export function resolveAgentHome(row: AgentHomeRow, route?: AgentHomeRoute | null, options: { createInHome?: boolean } = {}): AgentHomeResolution {
  if (route && typeof route.path === "string" && route.path) return { dir: route.path, isLocal: true, source: "route" };
  const owned = ownedAgentFolder(row);
  const ownedIsStateOnly = owned ? isStateOnlyFolder(owned) : false;
  if (owned && !ownedIsStateOnly) return { dir: owned, isLocal: false, source: "home" };
  const legacy = path.join(legacyAgentsRoot(), legacyFolderName(row));
  // 정의 없는 상태 전용 폴더는 정의 폴더가 아니다: 정의가 아직 예전 위치에 있으면 그곳이 이 에이전트의 폴더다(감사 29-2: 상태 폴더가 먼저 생긴 스텁의
  // 정의가 화면에서 사라지고 DB 사본으로 다시 만들어졌다). 예전 위치에도 없으면 그 폴더가 만들 곳이다 — 한 에이전트는 한 폴더.
  if (owned && !fs.existsSync(legacy)) return { dir: owned, isLocal: false, source: "home" };
  // 새 폴더는 에이전트 루트에 태어난다. `createInHome: false` 는 "예전 위치 기본값"을 보는 시험이 쓴다(제품 호출처는 넘기지 않는다).
  if ((options.createInHome ?? NEW_AGENT_FOLDERS_IN_HOME) && !fs.existsSync(legacy)) return { dir: path.join(agentHomeRoot(), homeFolderName(row)), isLocal: false, source: "home" };
  return { dir: legacy, isLocal: false, source: "legacy" };
}

export function agentHomeDir(row: AgentHomeRow, route?: AgentHomeRoute | null, options: { createInHome?: boolean } = {}): string {
  return resolveAgentHome(row, route, options).dir;
}

/**
 * 이 컴퓨터에만 두는 상태(기억·원장·출처 표식)의 폴더. 정의가 어디 있든(라우트가 사용자 폴더·git 저장소를 가리켜도) 항상 에이전트 루트 안이다.
 * 계산만 한다 — 만들지 않는다. 설정된 루트가 지금 없으면 `null`("지금 쓸 수 없음") — 기본 루트로 떨어지지 않는다. 던지지 않는다.
 */
export function agentStateDir(row: AgentHomeRow, route?: AgentHomeRoute | null): string | null {
  try {
    const root = agentHomeRootStatus();
    if (!root.available) return null;
    // 한 에이전트 = 한 폴더: 정의 폴더가 에이전트 루트 안의 앱 폴더이면 상태는 그 폴더 안이다(표식이 아직 없어도 — 라우트가 증거다).
    if (route && typeof route.path === "string" && route.path && !ownedAgentFolder(row, root.path)) {
      const cls = classifyAgentFolder(route.path);
      if (cls.owner === "app" && cls.appRoot === "agent-home" && path.dirname(cls.unit) === path.resolve(root.path)) return path.join(cls.unit, AGENT_LOCAL_STATE_FOLDER);
    }
    return path.join(root.path, homeFolderName(row, root.path), AGENT_LOCAL_STATE_FOLDER);
  } catch {
    return null;
  }
}

export type EnsureAgentStateDirResult =
  | { ok: true; dir: string }
  | { ok: false; dir: null; reason: "root-unavailable" | "write-failed"; message: string };

/**
 * 상태 폴더를 만들고 안에 `.gitignore`(`*`)를 둔다 — 사용자의 git 저장소가 이 폴더를 커밋하지 않게. 이미 있는 파일은 건드리지 않는다.
 * 던지지 않는다: 루트가 설정돼 있는데 지금 없거나(드라이브 분리) 폴더를 만들 수 없으면(읽기 전용·권한) `ok:false` 를 돌려준다.
 * 호출자는 기억 없이 계속 돌고(또는 중앙 저장소를 쓰고) 사용자에게 한 줄로 알린다.
 */
export function ensureAgentStateDir(row: AgentHomeRow, route?: AgentHomeRoute | null): EnsureAgentStateDirResult {
  const dir = agentStateDir(row, route);
  if (!dir) return { ok: false, dir: null, reason: "root-unavailable", message: "The agent folder location is not available right now." };
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    // 소유 표식. 없으면 다음 계산에서 이 폴더가 "표식 없는 이웃"으로 보여 이름이 `-id6` 쪽으로 바뀐다(상태가 두 곳으로 갈라진다).
    writeFileDurable(path.join(dir, AGENT_OWNER_FILE), JSON.stringify({ schema: 1, agentId: row.id }) + "\n", { keepExisting: true });
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, dir: null, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Agent Cloud·Hub 가 설치하는 패키지의 폴더 — 설치·업데이트·복원·제거가 모두 이 한 답을 쓴다.
 *  ① 라우트가 이미 설치된 패키지(`source: agent-cloud|hub`)의 앱 폴더를 가리키면 그곳이다: 옮긴 뒤의 업데이트가 옮긴 자리를 다시 쓴다(옛 자리에 새로 만들어
 *     옮긴 쪽을 고아로 두지 않는다).
 *  ② 그 밖에는 `resolveAgentHome` 과 같다: 표식이 맞는 폴더 → 남아 있는 예전 폴더(`userData/agents/<slug>`, 1.x 가 쓰던 자리) → 에이전트 루트 안의 새 이름.
 *  ③ 단, 라우트가 에이전트 루트 안의 *로컬 패키지*(사용자가 만든 것, `local-import`)를 가리키면 그 폴더는 설치가 덮어쓰는 대상이 아니다 — 같은 행에 클라우드
 *     사본을 받을 때 예전에도 로컬 폴더는 그대로 남았다. 다른 이름의 새 폴더를 쓴다.
 * 계산만 한다. `userDataDir()` 를 모르면 던진다(예전과 같다).
 */
export function managedAgentFolder(row: AgentHomeRow, route?: (AgentHomeRoute & { source?: string | null }) | null): string {
  const routed = route && typeof route.path === "string" && route.path ? classifyAgentFolder(route.path) : null;
  const routedUnit = routed && routed.owner === "app" && !routed.nested && (routed.appRoot === "agent-home" || routed.appRoot === "legacy-agents") ? routed : null;
  if (routedUnit && (route!.source === "agent-cloud" || route!.source === "hub")) return routedUnit.unit;
  const resolved = path.resolve(resolveAgentHome(row, null).dir);
  if (routedUnit && routedUnit.appRoot === "agent-home" && resolved === routedUnit.unit) {
    const [plain, suffixed] = homeCandidates(row);
    return [plain, suffixed].find((candidate) => path.resolve(candidate) !== routedUnit.unit && !fs.existsSync(candidate)) ?? suffixed;
  }
  return resolved;
}

// ───────────────────────────── 폴더 소유 판정 ─────────────────────────────
// "이 폴더는 앱이 만든 것인가, 사용자의 것인가" 를 가르는 한 곳. 두 곳이 이것을 읽는다:
//   ① 폴더를 옮길지(home-move.ts)  ② 에이전트를 지울 때 휴지통으로 보낼지(agent-forget.ts isUserOwnedFolder).
// 앱 소유 = 앱이 만드는 네 루트의 *바로 아래 폴더*(그 안의 팀 구성원 폴더 포함; 단 `generated-agent-os` 는 `.agentlas/generated-teams/<슬러그>` 가 단위):
//   agent-home(`agentHomeRoot()`)  legacy-agents(`userData/agents`)  generated-agent-os(`userData/generated-agent-os`)  engine-builder(`~/.agentlas/agentlas-agent`)
// 그 밖은 전부 사용자 소유다 — `~/.agentlas` 아래의 다른 곳(projects, one …)도 포함한다. 한 번 틀리면 사용자의 폴더가 휴지통으로 가므로
// 모르면 사용자 것이다. 앱 루트 안이어도 사용자 것으로 보는 경우: 링크(심볼릭)를 지나는 경로, 안에 `.git` 이 있는 폴더, 점으로 시작하는 이름(임시·백업).

export type AppFolderRoot = "agent-home" | "legacy-agents" | "generated-agent-os" | "engine-builder";
export type UserFolderReason = "outside-app-roots" | "symlink" | "git-repo" | "internal-name" | "app-root-itself" | "unreadable";
export type FolderOwnership =
  | { owner: "app"; /** 앱 루트 바로 아래의 폴더(옮기는 단위). */ unit: string; appRoot: AppFolderRoot; /** 이 폴더가 단위 안쪽(팀 구성원 등)인가. */ nested: boolean }
  | { owner: "user"; reason: UserFolderReason };

/** `~/.agentlas/agentlas-agent` — 엔진이 예전에 빌드 결과를 두던 곳. */
export function engineBuilderHome(): string {
  return path.join(agentlasHomeDir(), "agentlas-agent");
}

/** `userData/generated-agent-os` — 앱이 만든 팀 패키지의 예전 위치. */
export function generatedAgentOsRoot(): string {
  return path.resolve(userDataDir(), "generated-agent-os");
}

function appFolderRoots(): Array<{ kind: AppFolderRoot; root: string }> {
  const roots: Array<{ kind: AppFolderRoot; root: string }> = [{ kind: "agent-home", root: agentHomeRoot() }];
  // userData 를 모르는 호스트(데몬이 아직 주입 전)에서도 던지지 않는다 — 그 두 루트만 빠진다.
  try { roots.push({ kind: "legacy-agents", root: legacyAgentsRoot() }, { kind: "generated-agent-os", root: generatedAgentOsRoot() }); } catch { /* userData unknown */ }
  roots.push({ kind: "engine-builder", root: engineBuilderHome() });
  return roots.map((item) => ({ kind: item.kind, root: path.resolve(item.root) }));
}

function relativeInside(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative === "") return "";
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

/** 실제 경로(링크를 푼 것). 대상이 아직 없으면 있는 가장 깊은 윗길을 풀고 나머지를 그대로 붙인다. 던지지 않는다. */
function realPathOrSelf(target: string): string {
  const pending: string[] = [];
  let cursor = path.resolve(target);
  for (;;) {
    try { return pending.length ? path.join(fs.realpathSync.native(cursor), ...pending.reverse()) : fs.realpathSync.native(cursor); }
    catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      pending.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * 이 폴더의 소유. 던지지 않는다. 폴더가 아직 없어도 경로만으로 판정한다(지우기 직전·만들 곳 판정에 쓰인다).
 * 단위의 `.git` 은 단위 폴더만 본다 — 윗길까지 거슬러 올라가면 홈 폴더가 dotfiles 저장소인 기기에서 아무것도 옮기지 못한다.
 */
export function classifyAgentFolder(folder: string): FolderOwnership {
  try {
    if (typeof folder !== "string" || !folder || !path.isAbsolute(folder)) return { owner: "user", reason: "unreadable" };
    const target = path.resolve(folder);
    const realTarget = realPathOrSelf(target);
    for (const { kind, root } of appFolderRoots()) {
      const lexical = relativeInside(root, target);
      const real = relativeInside(realPathOrSelf(root), realTarget);
      if (lexical === null && real === null) continue;
      // 한쪽 잣대로만 루트 안이거나, 두 잣대가 가리키는 아래 경로가 다르면 링크가 끼어 있다 — 사용자의 구성이다.
      if (lexical === null || real === null || lexical !== real) return { owner: "user", reason: "symlink" };
      if (lexical === "") return { owner: "user", reason: "app-root-itself" };
      const segments = lexical.split(path.sep);
      // 앱이 프로젝트 없이 만든 팀은 `generated-agent-os/.agentlas/generated-teams/<슬러그>` 에 태어난다(commerce-team.ts): 점으로 시작하는 이름이지만 앱의 것이고 그 폴더가 옮기는 단위다.
      const generatedTeam = kind === "generated-agent-os" && segments.length >= 3 && segments[0] === ".agentlas" && segments[1] === "generated-teams" && !segments[2].startsWith(".");
      if (!generatedTeam && segments[0].startsWith(".")) return { owner: "user", reason: "internal-name" };
      const unit = generatedTeam ? path.join(root, ".agentlas", "generated-teams", segments[2]) : path.join(root, segments[0]);
      try { if (fs.lstatSync(unit).isSymbolicLink()) return { owner: "user", reason: "symlink" }; } catch { /* 아직 없는 단위 */ }
      if (fs.existsSync(path.join(unit, ".git"))) return { owner: "user", reason: "git-repo" };
      return { owner: "app", unit, appRoot: kind, nested: segments.length > (generatedTeam ? 3 : 1) };
    }
    return { owner: "user", reason: "outside-app-roots" };
  } catch {
    return { owner: "user", reason: "unreadable" };
  }
}

/** 소유 표식 + 상태 폴더 `.gitignore` 를 *없을 때만* 쓴다(이미 있는 것은 건드리지 않는다). 새 폴더를 만드는 쪽이 부른다. 던지지 않는다. */
export function ensureAgentOwnerMarker(folder: string, agentId: string): boolean {
  try {
    const state = path.join(folder, AGENT_LOCAL_STATE_FOLDER);
    fs.mkdirSync(state, { recursive: true });
    try { fs.writeFileSync(path.join(state, ".gitignore"), "*\n", { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    writeFileDurable(path.join(state, AGENT_OWNER_FILE), JSON.stringify({ schema: 1, agentId }) + "\n", { keepExisting: true });
    return true;
  } catch {
    return false;
  }
}
