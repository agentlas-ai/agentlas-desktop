import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "../store/db";
import { agentFolderPath } from "../agents/files";
import { agentHomeRoot, agentStateDir, ensureAgentStateDir, ownedAgentFolder } from "../agents/home";
import { getRoute } from "../agents/routes";
import { userDataPath } from "../runtime-paths";
import { oneProfileAvatarSegment, captureOneAvatarOwner, commitOneAvatarPointer, readOneAvatarPointer } from "../store/one-profile";

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AGENT_ID_RE = /^[a-f0-9-]{16,80}$/i;

export function decodeOneTeamAvatarDataUrl(value: string): { bytes: Buffer; extension: "png" | "jpg" | "webp" } {
  const match = IMAGE_DATA_URL_RE.exec(value);
  if (!match) throw new Error("The character image must be a PNG, JPEG, or WebP data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || bytes.toString("base64") !== match[2]) {
    throw new Error("The character image is invalid or larger than 2 MiB.");
  }
  const extension = match[1] === "jpeg" ? "jpg" : match[1] as "png" | "webp";
  return { bytes, extension };
}

const AVATAR_EXTENSIONS = ["png", "jpg", "webp"] as const;

function safeAvatarSlug(slug: string | null | undefined): slug is string {
  return Boolean(slug) && slug !== "." && slug !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(slug as string);
}

/**
 * 팀원 사진이 있을 수 있는 폴더들, 읽는 순서대로 — 사진을 읽고 쓰는 모든 곳(화면의 `agentlas://one-avatar/<id>`, 폰 미러링, 저장, 폴더 이동)이 이 한 답을 쓴다.
 * ① 그 에이전트 폴더의 상태 폴더(`<에이전트 폴더>/.agentlas-local/`) — 정본. 이 컴퓨터에만 있고 업로드·해시·스냅샷에 들지 않는다(사진은 허브로 안 나간다).
 *  ② 에이전트 폴더 맨 위 — 폴더째 옮긴 직후 사진을 상태 폴더로 옮기기 전의 자리.
 *  ③ 예전 자리 `userData/agents/<slug>/` — 아직 옮기지 못한 사진(다른 볼륨 등)을 제자리에서 읽는다.
 */
function oneTeamAvatarFolders(agentId: string, slugs: ReadonlyArray<string | null | undefined>): string[] {
  const folders: string[] = [];
  const installed = slugs.find(safeAvatarSlug);
  if (installed) {
    try {
      const row = { id: agentId, slug: installed };
      const state = agentStateDir(row, getRoute(agentId));
      if (state) folders.push(state);
      const owned = ownedAgentFolder(row);
      if (owned) folders.push(path.join(owned, ".agentlas-local"), owned);
    } catch { /* the old place below still answers */ }
  }
  for (const slug of new Set(slugs)) if (safeAvatarSlug(slug)) folders.push(agentFolderPath(slug));
  return [...new Set(folders)];
}

/** 사진을 정본 자리(에이전트 폴더의 상태 폴더)에 쓴다. 에이전트 루트를 지금 쓸 수 없으면(드라이브 분리 등) 예전 자리에 쓴다 — 읽는 쪽이 둘 다 본다. */
export function writeOneTeamAvatar(input: { agentId: string; slug: string; bytes: Buffer; extension: "png" | "jpg" | "webp" }): string {
  const row = getDb().prepare("SELECT slug FROM installed_agents WHERE id = ?").get(input.agentId) as { slug?: string } | undefined;
  const installedSlug = row?.slug ?? input.slug;
  const state = ensureAgentStateDir({ id: input.agentId, slug: installedSlug }, getRoute(input.agentId));
  const dir = state.ok ? state.dir : agentFolderPath(input.slug);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `one-avatar.${input.extension}`);
  const tempPath = path.join(dir, `.one-avatar.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, input.bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* successful rename consumes it */ }
  }
  // 이 에이전트의 다른 사진(다른 확장자, 옛 자리에 남은 것)은 새 사진에 가려져 읽히지 않는다: 남겨 두면 쌓이기만 하고, 확장자 순서에 따라 옛 얼굴이 다시 나온다.
  for (const folder of oneTeamAvatarFolders(input.agentId, [installedSlug, input.slug])) {
    for (const extension of AVATAR_EXTENSIONS) {
      const other = path.join(folder, `one-avatar.${extension}`);
      if (other !== finalPath) { try { fs.unlinkSync(other); } catch { /* 없으면 그만 */ } }
    }
  }
  return finalPath;
}

/** 만들다 실패한 팀원의 사진을 지운다(사진 파일만 — 폴더는 만든 쪽이 치운다). */
export function removeOneTeamAvatarFiles(agentId: string, slug: string): void {
  for (const folder of oneTeamAvatarFolders(agentId, [slug])) {
    for (const extension of AVATAR_EXTENSIONS) { try { fs.unlinkSync(path.join(folder, `one-avatar.${extension}`)); } catch { /* 없으면 그만 */ } }
  }
}

/*
 * One 자신의 초상.
 *
 * 팀원의 초상은 그 에이전트 폴더에 산다. One 은 설치된 에이전트가 아니라 그런 폴더가 없어서,
 * 처음에는 One 만 프리셋 캐릭터로 제한했다 — 같은 창을 쓰는데 One 에서만 두 탭이 사라지는
 * 것은 통일이 아니라 구멍이다(오너 지적 2026-08-23). 그래서 One 전용 자리를 만든다.
 *
 * 자리가 하나뿐이라 id 가 필요 없다. 아이콘 값은 `one-avatar:self` 하나로 고정한다.
 */
export const ONE_SELF_AVATAR_ICON = "one-avatar:self";

function oneSelfAvatarDir(): string {
  // 초상도 프로필처럼 계정마다다(계정 하나 = One 하나). 업데이트 전 프로필을 이어받은 One 은
  // 옛 자리를 그대로 쓰고, 다른 계정은 accounts/<불투명 키> 아래 자기 자리를 쓴다.
  const segment = oneProfileAvatarSegment();
  return segment ? userDataPath("one-profile", "accounts", segment) : userDataPath("one-profile");
}

/** Main only: write an immutable image before atomically publishing its pointer. */
export function setOneSelfAvatarImage(input: { dataUrl: string; expectedVersion: number; oneId?: string }) {
  const owner = captureOneAvatarOwner();
  if (owner.version !== input.expectedVersion || (input.oneId !== undefined && input.oneId !== owner.oneId)) throw Object.assign(new Error("One profile changed; reload and try again"), { code: "one_profile_version_conflict" });
  const decoded = decodeOneTeamAvatarDataUrl(input.dataUrl);
  const b = decoded.bytes;
  const valid = decoded.extension === "png" ? b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : decoded.extension === "jpg" ? b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
    : b.length >= 12 && b.toString("ascii",0,4) === "RIFF" && b.toString("ascii",8,12) === "WEBP";
  if (!valid) throw new Error("The character image has an invalid signature.");
  if (oneProfileAvatarSegment() !== owner.segment) throw Object.assign(new Error("One profile changed; reload and try again"), { code: "one_profile_version_conflict" });
  const dir = oneSelfAvatarDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `one-avatar-${randomUUID()}.${decoded.extension}`;
  const fd = fs.openSync(path.join(dir, filename), "wx", 0o600);
  try { fs.writeFileSync(fd, decoded.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // On POSIX make the directory entry durable before publishing its pointer.
  // Windows does not support opening directories this way; the file is still flushed.
  if (process.platform !== "win32") {
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { fs.closeSync(dirFd); }
  }
  return commitOneAvatarPointer(owner, filename);
}

export function writeOneSelfAvatar(input: { bytes: Buffer; extension: "png" | "jpg" | "webp" }): string {
  const dir = oneSelfAvatarDir();
  fs.mkdirSync(dir, { recursive: true });
  // 확장자가 바뀌면 옛 파일이 남아 해석 순서에 따라 옛 얼굴이 계속 나온다.
  for (const extension of ["png", "jpg", "webp"] as const) {
    if (extension === input.extension) continue;
    try { fs.unlinkSync(path.join(dir, `one-avatar.${extension}`)); } catch { /* 없으면 그만 */ }
  }
  const finalPath = path.join(dir, `one-avatar.${input.extension}`);
  const tempPath = path.join(dir, `.one-avatar.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, input.bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* successful rename consumes it */ }
  }
  return finalPath;
}

function resolveOneSelfAvatarPath(): string | null {
  const dir = oneSelfAvatarDir();
  const pointer = readOneAvatarPointer();
  const candidates = pointer ? [pointer] : ["one-avatar.png", "one-avatar.jpg", "one-avatar.webp"];
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) continue;
      const realDir = fs.realpathSync.native(dir);
      const realFile = fs.realpathSync.native(candidate);
      const relative = path.relative(realDir, realFile);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
    } catch {
      // Try the next supported extension.
    }
  }
  return null;
}

/** Move bundle (Agentlas 2.0 O-M3b): the bytes of the personal agent's own portrait, or null (none, unreadable, over 2 MiB). */
export function readOneSelfAvatarBytes(): Buffer | null {
  try {
    const file = resolveOneSelfAvatarPath();
    if (!file) return null;
    const st = fs.statSync(file);
    return st.size > 0 && st.size <= 2 * 1024 * 1024 ? fs.readFileSync(file) : null;
  } catch { return null; }
}

/** Resolve only a portrait owned by a real local One Team seat. */
export function resolveOneTeamAvatarProtocolPath(rawUrl: string): string | null {
  let agentId = "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "agentlas:" || url.hostname !== "one-avatar" || url.hash) return null;
    agentId = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (url.search && (agentId !== "self" || !/^\?v=[1-9][0-9]*$/.test(url.search) || !Number.isSafeInteger(Number(url.search.slice(3))))) return null;
  } catch {
    return null;
  }
  // One 자신의 초상은 좌석이 아니라 프로필에 속한다.
  if (agentId === "self") return resolveOneSelfAvatarPath();
  if (!AGENT_ID_RE.test(agentId)) return null;
  const db = getDb();
  let row = db.prepare(`
    SELECT member.agent_slug AS slug, agent.slug AS installed_slug, member.icon
    FROM installed_agents agent
    JOIN one_org_members member ON member.installed_agent_id = agent.id
    WHERE agent.id = ? AND member.icon = ?
    ORDER BY member.archived_at IS NULL DESC, member.updated_at DESC
    LIMIT 1
  `).get(agentId, `one-avatar:${agentId}`) as { slug?: string; installed_slug?: string; icon?: string } | undefined;
  // 좌석(One 팀원)이 아닌 에이전트의 사진: 설치된 에이전트이고 외형이 허용하는 종류(비공개·배경·회사 참조가 아님)이면 같은 자리에서 읽는다.
  if (!row?.slug) {
    const plain = db.prepare("SELECT slug, visibility, entity_kind FROM installed_agents WHERE id = ?").get(agentId) as { slug?: string; visibility?: string | null; entity_kind?: string | null } | undefined;
    if (!plain?.slug || plain.visibility === "private" || plain.visibility === "background" || plain.entity_kind === "company-reference") return null;
    row = { slug: plain.slug, installed_slug: plain.slug };
  }
  if (!row?.slug) return null;
  // The portrait lives in the agent's own state folder. One written by an older build is still at the seat's original slug under
  // userData/agents (a later package import can change installed_agents.slug without moving it) until the folder move brings it over.
  for (const dir of oneTeamAvatarFolders(agentId, [row.installed_slug, row.slug])) {
    for (const extension of AVATAR_EXTENSIONS) {
      const candidate = path.join(dir, `one-avatar.${extension}`);
      try {
        if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) continue;
        const realDir = fs.realpathSync.native(dir);
        const realFile = fs.realpathSync.native(candidate);
        const relative = path.relative(realDir, realFile);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
      } catch {
        // Try the next supported extension or the next place.
      }
    }
  }
  return null;
}

/** The folders a seat portrait may be served from: the app profile and the agent root (the mobile preview refuses anything else). */
export function oneTeamAvatarRoots(): string[] {
  return [userDataPath(), agentHomeRoot()];
}

// ───────────────────────── 에이전트 사진 바꾸기 ─────────────────────────
// 사진은 그 에이전트 폴더의 상태 폴더(`.agentlas-local/one-avatar.<확장자>`)에 산다 — 이 컴퓨터에만 있고 업로드·패키지 해시·동기화 비교에 들지 않는다(상태 폴더 제외 규칙).
// 폰에는 외형 응답에 넣지 않고 기존 미리보기 경로(`one.avatar.get` → `one-avatar:<에이전트 id>`)로만 보인다 — 구 폰의 외형 응답 키는 그대로다.
// 개인 에이전트(One)의 사진은 `setOneSelfAvatarImage`(데스크탑 IPC 와 폰 `one.avatar.set` 이 같은 함수)가 맡는다.

function imageSignatureValid(decoded: { bytes: Buffer; extension: "png" | "jpg" | "webp" }): boolean {
  const b = decoded.bytes;
  return decoded.extension === "png" ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : decoded.extension === "jpg" ? b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
    : b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
}

function visibleAgentRow(agentId: string): { slug: string } | "not-found" | "not-visible" {
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return "not-found";
  const row = getDb().prepare("SELECT slug, visibility, entity_kind FROM installed_agents WHERE id = ?").get(agentId) as { slug?: string; visibility?: string | null; entity_kind?: string | null } | undefined;
  if (!row?.slug) return "not-found";
  if (row.visibility === "private" || row.visibility === "background" || row.entity_kind === "company-reference") return "not-visible";
  return { slug: row.slug };
}

/** 설치된 에이전트의 사진을 바꾼다(데스크탑에서). 이미지 검증은 팀원 사진과 같다(PNG·JPEG·WebP, 2MiB, 시그니처). 던지지 않는다. */
export function setAgentAvatar(agentId: string, dataUrl: unknown): { ok: true; agentId: string; icon: string } | { ok: false; code: "agent_not_found" | "agent_not_visible" | "image_invalid" | "write_failed"; detail?: string } {
  const row = visibleAgentRow(agentId);
  if (row === "not-found") return { ok: false, code: "agent_not_found" };
  if (row === "not-visible") return { ok: false, code: "agent_not_visible" };
  let decoded: { bytes: Buffer; extension: "png" | "jpg" | "webp" };
  try { decoded = decodeOneTeamAvatarDataUrl(String(dataUrl ?? "")); } catch (error) { return { ok: false, code: "image_invalid", detail: error instanceof Error ? error.message : String(error) }; }
  if (!imageSignatureValid(decoded)) return { ok: false, code: "image_invalid", detail: "signature" };
  // 에이전트 루트를 지금 쓸 수 없으면(드라이브 분리) 저장하지 않는다: 예전 자리에 폴더를 만들면 드라이브가 돌아왔을 때 사진이 두 곳으로 갈린다(`writeOneTeamAvatar` 의 옛 자리 쓰기는 팀 만들기 경로 몫).
  if (!ensureAgentStateDir({ id: agentId, slug: row.slug }, getRoute(agentId)).ok) return { ok: false, code: "write_failed", detail: "root_unavailable" };
  try { writeOneTeamAvatar({ agentId, slug: row.slug, ...decoded }); } catch (error) { return { ok: false, code: "write_failed", detail: (error as NodeJS.ErrnoException).code ?? "write" }; }
  return { ok: true, agentId, icon: `one-avatar:${agentId}` };
}

/** 사진을 지운다(없으면 아무것도 하지 않는다). */
export function clearAgentAvatar(agentId: string): { ok: true; agentId: string } | { ok: false; code: "agent_not_found" } {
  const row = getDb().prepare("SELECT slug FROM installed_agents WHERE id = ?").get(agentId) as { slug?: string } | undefined;
  if (!row?.slug || !AGENT_ID_RE.test(agentId)) return { ok: false, code: "agent_not_found" };
  removeOneTeamAvatarFiles(agentId, row.slug);
  return { ok: true, agentId };
}
