// 자체 런타임(BYOK·Ollama·LM Studio·MLX)이 실제로 일할 수 있게 하는 **내장 도구**.
//
// ★왜 있나. 이 런타임들은 벤더 CLI가 없어서 도구가 전부 MCP에서 왔다. 그런데
// BYOK 러너(electron/runtime/byok.ts)에는 도구 루프 자체가 없었고(파일 안에 "tool"
// 문자열 0회), 로컬 루프는 붙은 MCP 서버에서만 도구를 가져왔다 — filesystem MCP를
// 사용자가 직접 붙이지 않으면 "코드를 답변에 적어주기만 하고 파일은 하나도 못 고치는"
// 실행이 된다. 도구를 남의 CLI에서 빌려오지 못하는 런타임에는 우리가 쥐여 줘야 한다.
//
// 경로 안전 규칙은 Agentlas 터미널 engine/agentlas-tools.cjs 에서 이미 굳은 것을
// 그대로 옮겼다(그 사본은 터미널 자체 코드이고 데스크탑에는 없었다). 새로 유도하지
// 않는 이유는 하나 — 아래 규칙들은 전부 실제 공격 표면에 대응하는 것이고, 다시 쓰면
// 그중 하나를 빠뜨린다:
//   · 절대경로·상위 traversal은 **정규화 전에** 거부(`safe/../file`도 거부)
//   · Windows 경로 방언도 POSIX 호스트에서 거부(준비/테스트 호스트가 달라도 동일)
//   · 심볼릭 링크는 realpath로 풀어 **작업 폴더 밖이면 거부**
//   · O_NOFOLLOW + fstat 로 "정규 파일"만 열기(경합 중 특수 파일 교체 방어)
//   · 쓰기는 임시 파일 + rename — 하드링크로 바깥 inode를 건드리지 못하게
//
// 권한 등급(minPerm)은 사용자가 고른 권한 칩과 같은 축이다. read 실행에서는
// write_file 이 목록에 아예 없다 — "있는데 거절"이 아니라 "없다".
import { FILE_OBSERVATION_MAX_BYTES, observeWorkspaceFile, type FileObservation } from "./file-observation";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import { classifyLaunchEscape, launchEscapeDenialReason } from "./write-sandbox-launch-guard";
import { PERMISSION_ESCALATION_MARKER } from "./permission-escalation";
import type { RuntimeToolKind } from "./runtime-tool-kind";
import { closestNames, didYouMean, unknownArgumentMessage } from "./did-you-mean";

export type ToolPermission = "read" | "write" | "full";

const PERM_RANK: Record<ToolPermission, number> = { read: 0, write: 1, full: 2 };

export interface BuiltinToolContext {
  /** 작업 폴더. 모든 경로 인자는 이 안으로 봉쇄된다. */
  cwd: string;
  permission: ToolPermission;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * The write-permission shell: wraps one command so that it runs in an OS sandbox that writes only inside the working
   * folder (electron/runtime/confined-shell.ts). This is the boundary a CLI runtime's workspace-write sandbox gives its
   * commands. Injected only where such a boundary exists (macOS Seatbelt, Linux bubblewrap); without it, `bash` stays a
   * full-permission tool.
   */
  confineShell?: (command: string) => { file: string; args: string[] };
  /** Main-owned native browser download; no caller-selected path or profile. */
  historyWork?: (name:string,args:Record<string,unknown>)=>Promise<unknown>;
  browserDownload?: (url: string) => Promise<{id:string;fileName:string;bytes:number;savePath:string}>;
  /**
   * 사용자에게 묻고 **답을 기다리는** 함수. 주입으로 받는 이유는 이 파일이 electron 을
   * import 하면 안 되기 때문이다(터미널·서버도 같은 도구를 쓸 수 있어야 한다).
   *
   * 없으면 `ask_user` 도구가 목록에 뜨지 않는다 — 물을 수 없는 표면에서 "물어보는
   * 도구"를 보여 주면 모델은 그걸 쓰고 영원히 기다린다.
   */
  askUser?: (input: {
    question: string;
    options?: { label: string; description?: string }[];
    allowFreeText?: boolean;
  }) => Promise<{ status: "answered"; answer: string } | { status: string }>;
  /**
   * 멀티모달 슬롯으로 그림을 그린다. askUser 와 같은 이유로 주입이다 — 이 파일은
   * electron 을 import 하지 않는다.
   *
   * 멀티모달은 대화 런타임과 **다른 자리**다. orchestrator 가 claude 여도 이 슬롯이
   * codex 면 codex 의 image_gen 이 그린다(shared/runtime-roles.ts multimodal).
   * 주입이 없으면 `generate_image` 는 목록에 뜨지 않는다.
   */
  generateImage?: (input: { prompt: string }) => Promise<{
    ok: boolean;
    /** data:image/…;base64,… — 채팅·사이드바가 그대로 렌더한다. */
    src?: string;
    /** 실제로 그린 엔진. 지어낸 값이 아니라 실행 결과다. */
    engine?: string;
    message?: string;
    /** Main-only source path. It is never serialized into tool text. */
    artifactPath?: string;
  }>;
}

export interface BuiltinToolRunResult {
  content: string;
  /** Only actual builtin filesystem code produces this; never parsed from tool text. */
  fileObservation?: FileObservation;
  downloadId?: string;
  /** Host-structured evidence; model prose and JSON output cannot populate it. */
  artifactPaths?: readonly string[];
  /** Optional visual feedback for the model's next tool-loop turn. */
  imageDataUrl?: string;
}

export interface BuiltinTool {
  name: string;
  minPerm: ToolPermission;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: BuiltinToolContext): Promise<string | BuiltinToolRunResult> | string | BuiltinToolRunResult;
}

function pathDenied(reason: string): never {
  throw new Error(`workspace path denied: ${reason}`);
}

/**
 * A plugin's skills are not workspace files. The prompts name a plugin router by its install path
 * (`.../plugins/<slug>/skills/<name>/SKILL.md`), which a CLI runtime opens wherever it is, but this loop's file tools stay inside the
 * working folder and the harness is the way in. A refusal for such a path says which id to open instead of leaving the model to try
 * relative guesses. Path text only: nothing is read and the folder boundary is unchanged.
 */
function pluginSkillHint(input: unknown): string {
  if (typeof input !== "string") return "";
  const found = /(?:^|[\\/])plugins[\\/]([a-z0-9][a-z0-9._-]*)[\\/]skills(?=[\\/]|$)(?:[\\/]([a-z0-9][a-z0-9._-]*))?/i.exec(input);
  if (!found) return "";
  return ` A plugin's skills are opened through the harness, not these file tools: harness_describe id "plugin:${found[1]}/${found[2] ?? "index"}" (the router is "plugin:${found[1]}/index").`;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function getWorkspaceRoot(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    pathDenied("working folder is invalid");
  }
  const root = fs.realpathSync(path.resolve(cwd));
  if (!fs.statSync(root).isDirectory()) pathDenied("working folder is not a directory");
  return root;
}

/** The nearest existing ancestor resolved through symlinks, with the missing tail re-appended. */
function realPrefixPath(target: string): string {
  const tail: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function validateRelativePath(root: string, input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    pathDenied("path must be a non-empty string");
  }
  const pluginHint = pluginSkillHint(input);
  // path.resolve()가 정규화해 없애기 **전에** traversal을 거부한다. 지금 바깥으로
  // 나가는 것만이 아니라 `safe/../file` 자체를 거부하는 것이 의도다.
  if (input.split(/[\\/]+/u).some((segment) => segment === "..")) {
    pathDenied(`parent traversal is not allowed${pluginHint}`);
  }




  if (path.isAbsolute(input)) {
    const lexical = path.resolve(input);
    const inside = contained(root, lexical) ? lexical : realPrefixPath(lexical);
    if (!contained(root, inside)) pathDenied(`absolute path is outside the working folder; use a path relative to it${pluginHint}`);
    return path.relative(root, inside) || ".";
  }
  // 두 방언 모두 검사한다. 다른 방언의 Windows 절대/UNC 경로(POSIX 호스트) 또는 POSIX 절대
  // 경로(Windows 호스트)는 여전히 무효다.
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    pathDenied(`absolute paths are not allowed${pluginHint}`);
  }
  return input;
}

function lexicalPath(root: string, input: unknown): string {
  const candidate = path.resolve(root, validateRelativePath(root, input));
  if (!contained(root, candidate)) pathDenied("path leaves the working folder");
  return candidate;
}

/**
 * A missing file names the closest entries of the folder it was looked for in, so a misspelled name can be corrected without
 * another list_dir. Safe by construction: only inside the working folder (the folder is resolved through symlinks and
 * must be contained, exactly what list_dir may read at the same permission), only entry names, never contents, and
 * only text added to the error: the missing path is not opened under a near name.
 */
function nearEntriesHint(root: string, candidate: string): string {
  try {
    const folder = fs.realpathSync(path.dirname(candidate));
    if (!contained(root, folder)) return "";
    const near = closestNames(path.basename(candidate), fs.readdirSync(folder).slice(0, 400));
    return near.length ? ` Did you mean ${near.map((name) => path.relative(root, path.join(folder, name)).split(path.sep).join("/")).join(", ")}?` : "";
  } catch {
    return "";
  }
}

function resolveExistingIn(cwd: string, input: unknown): string {
  const root = getWorkspaceRoot(cwd);
  const candidate = lexicalPath(root, input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && error instanceof Error) error.message += nearEntriesHint(root, candidate) + pluginSkillHint(input);
    throw error;
  }
  if (!contained(root, real)) pathDenied("symbolic link leaves the working folder");
  return real;
}

function resolveWritableIn(cwd: string, input: unknown): string {
  const root = getWorkspaceRoot(cwd);
  const candidate = lexicalPath(root, input);
  const missing: string[] = [];
  let cursor = candidate;

  // existsSync 가 아니라 lstat 을 쓴다 — 깨진 심볼릭 링크를 알아채고 fail-closed 로
  // 만든다. mkdir 이 작업 폴더 밖에 부작용을 낼 수 있기 전에 가장 가까운 실재
  // 조상을 먼저 해소한다.
  for (;;) {
    try {
      fs.lstatSync(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) pathDenied("no existing workspace ancestor");
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(cursor);
  } catch (error) {
    if (fs.lstatSync(cursor).isSymbolicLink()) pathDenied("symbolic link target is unavailable");
    throw error;
  }
  if (!contained(root, realAncestor)) pathDenied("symbolic link leaves the working folder");
  const ancestorStat = fs.statSync(realAncestor);
  if (missing.length === 0 && !ancestorStat.isFile()) pathDenied("only regular files may be written");
  if (missing.length > 0 && !ancestorStat.isDirectory()) pathDenied("write parent is not a directory");
  const destination = path.join(realAncestor, ...missing);
  if (!contained(root, destination)) pathDenied("path leaves the working folder");
  return destination;
}

function safeOpenFlags(): number {
  if (process.platform === "win32") return 0;
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  // 정규화와 open 사이에 특수 파일이 끼어들어도 영원히 멈추지 않게 한다 —
  // 아래 fstat 이 그 경우를 거부한다.
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  return noFollow | nonBlock;
}

function openRegularFile(file: string, flags: number, mode?: number): number {
  const fd = fs.openSync(file, flags | safeOpenFlags(), mode);
  try {
    if (!fs.fstatSync(fd).isFile()) pathDenied("only regular files are allowed");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readUtf8File(file: string): string {
  if (!fs.statSync(file).isFile()) pathDenied("only regular files may be read");
  const fd = openRegularFile(file, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * read_file on a file above FILE_OBSERVATION_MAX_BYTES (no file observation is
 * possible there). The tool used to read the whole file into one string on the
 * host thread, Main or the daemon, and then return at most 20,000 characters:
 * a 500 MB log blocked the host for seconds and allocated the whole file.
 *
 * This returns exactly what that code returned, but reads in 1 MiB steps on
 * the libuv pool and keeps only what the result needs:
 * - the selected lines are located on raw bytes. 0x0A always decodes to "\n"
 *   and never belongs to a multi-byte or invalid sequence, so line k starts
 *   right after the k-th 0x0A byte;
 * - each step is decoded up to the last byte that cannot continue an earlier
 *   sequence, so the pieces concatenate to the whole-file decode;
 * - the first 20,000 UTF-16 units and the total length give the same
 *   truncate() text. Decoding goes in 64 KiB steps, so each piece is a
 *   short-lived young-generation string, not a large object kept until a
 *   full GC.
 */
const READ_FILE_STEP_BYTES = 1024 * 1024;
const READ_FILE_DECODE_STEP_BYTES = 64 * 1024;
const READ_FILE_MAX_CHARS = 20_000;

function readAt(fd: number, buffer: Buffer, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, position, (error, bytesRead) => (error ? reject(error) : resolve(bytesRead)));
  });
}

/** Byte offset just after the `count`-th 0x0A at or after `from`, or null when the file has fewer. */
async function offsetAfterNewlines(fd: number, count: number, from = 0): Promise<number | null> {
  if (count <= 0) return from;
  const buffer = Buffer.allocUnsafe(READ_FILE_STEP_BYTES);
  let position = from;
  let seen = 0;
  for (;;) {
    const read = await readAt(fd, buffer, position);
    if (!read) return null;
    let index = buffer.indexOf(0x0a, 0);
    while (index !== -1 && index < read) {
      seen += 1;
      if (seen === count) return position + index + 1;
      index = buffer.indexOf(0x0a, index + 1);
    }
    position += read;
  }
}

async function countNewlines(fd: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(READ_FILE_STEP_BYTES);
  let position = 0;
  let seen = 0;
  for (;;) {
    const read = await readAt(fd, buffer, position);
    if (!read) return seen;
    let index = buffer.indexOf(0x0a, 0);
    while (index !== -1 && index < read) { seen += 1; index = buffer.indexOf(0x0a, index + 1); }
    position += read;
  }
}

/** truncate(decode(bytes[from, to)), READ_FILE_MAX_CHARS); `to` null = end of file. */
async function truncatedTextBetween(fd: number, from: number, to: number | null): Promise<string> {
  const buffer = Buffer.allocUnsafe(READ_FILE_DECODE_STEP_BYTES);
  let position = from;
  let carry = Buffer.alloc(0);
  let head = "";
  let length = 0;
  const take = (piece: string): void => {
    length += piece.length;
    if (head.length < READ_FILE_MAX_CHARS) head += piece.slice(0, READ_FILE_MAX_CHARS + 1 - head.length);
  };
  for (;;) {
    const want = to === null ? buffer.length : Math.min(buffer.length, to - position);
    const read = want > 0 ? await readAt(fd, want === buffer.length ? buffer : buffer.subarray(0, want), position) : 0;
    if (!read) break;
    position += read;
    const bytes = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
    let split = bytes.length - 1;
    while (split >= 0 && (bytes[split] & 0xc0) === 0x80) split -= 1;
    // A lead byte in the last three may still need continuation bytes from the next step.
    const cut = split >= 0 && split >= bytes.length - 3 ? split : bytes.length;
    take(bytes.toString("utf8", 0, cut));
    carry = Buffer.from(bytes.subarray(cut));
  }
  if (carry.length) take(carry.toString("utf8"));
  return length <= READ_FILE_MAX_CHARS ? head : truncationText(head.slice(0, READ_FILE_MAX_CHARS), length - READ_FILE_MAX_CHARS);
}

/** Array.prototype.slice index normalization, as lines.slice(start, end) applied it. */
function sliceIndex(value: number, length: number): number {
  const integer = Math.trunc(value);
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}

async function readLargeTextFile(file: string, offset: number | undefined, limit: number | undefined): Promise<string> {
  const fd = openRegularFile(file, fs.constants.O_RDONLY);
  try {
    if (!offset && !limit) return await truncatedTextBetween(fd, 0, null);
    // Same arithmetic as the in-memory path below.
    const start = Math.max(0, (offset || 1) - 1);
    const end = limit ? start + limit : Number.POSITIVE_INFINITY;
    // Only a negative end needs the line count (slice counts it from the end).
    const lineCount = Math.trunc(end) < 0 ? (await countNewlines(fd)) + 1 : Number.POSITIVE_INFINITY;
    const first = sliceIndex(start, lineCount);
    const last = sliceIndex(end, lineCount);
    if (last <= first) return "";
    const from = await offsetAfterNewlines(fd, first);
    if (from === null) return "";
    const lineEnd = last === Number.POSITIVE_INFINITY ? null : await offsetAfterNewlines(fd, last - first, from);
    return await truncatedTextBetween(fd, from, lineEnd === null ? null : lineEnd - 1);
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_DATA_URL_PREFIX = "data:image/png;base64,";
const IMAGE_DATA_URL_MAX_CHARS = 8_000_000;
/** Extensions generate_image's save_as accepts: the two image types the generator can return, JPEG under either spelling. */
const IMAGE_SAVE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg"];
const IMAGE_MAX_BYTES = Math.min(FILE_OBSERVATION_MAX_BYTES,
  Math.floor((IMAGE_DATA_URL_MAX_CHARS - IMAGE_DATA_URL_PREFIX.length) / 4) * 3);
const IMAGE_MAX_PIXELS = 16_000_000;
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Validate bounded PNG pixels without loading a native decoder or executing a helper. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const invalid = () => { throw new Error("read_image_invalid_png"); };
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8, width = 0, height = 0, depth = 0, channels = 0, palette = false, ended = false, dataEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8), chunk = bytes.subarray(offset + 8, end - 4);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) crc = PNG_CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) invalid();
    if (offset === 8 && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) invalid();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); depth = chunk[8];
      const color = chunk[9], depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (!width || !height || width * height > IMAGE_MAX_PIXELS || !depths[color]?.includes(depth)
        || chunk[10] !== 0 || chunk[11] !== 0) invalid();
      if (chunk[12] !== 0) throw new Error("read_image_interlaced_png_unsupported");
      palette = color !== 3;
    } else if (type === "PLTE") {
      if (data.length || !length || length > 768 || length % 3) invalid();
      palette = true;
    } else if (type === "IDAT") {
      if (!palette || dataEnded) invalid();
      data.push(chunk);
    } else if (type === "IEND") {
      if (length || !data.length || end !== bytes.length) invalid();
      ended = true; offset = end; break;
    } else {
      if (!/^[a-z][A-Za-z]{3}$/.test(type)) invalid(); // Unknown critical chunks cannot be decoded safely.
      if (data.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length) invalid();
  const rowBytes = Math.ceil(width * channels * depth / 8), decodedBytes = (rowBytes + 1) * height;
  if (decodedBytes > 40_000_000) throw new Error("read_image_pixel_capacity_exceeded");
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: decodedBytes });
  if (pixels.length !== decodedBytes) invalid();
  for (let row = 0; row < height; row++) if (pixels[row * (rowBytes + 1)] > 4) invalid();
  return { width, height };
}

function readWorkspaceImage(cwd: string, input: unknown): BuiltinToolRunResult {
  const file = resolveExistingIn(cwd, input), fd = openRegularFile(file, fs.constants.O_RDONLY);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.size || stat.size > IMAGE_MAX_BYTES) throw new Error("read_image_byte_capacity_exceeded");
    bytes = Buffer.alloc(stat.size);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) throw new Error("read_image_file_changed");
      count += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, count)) throw new Error("read_image_file_changed");
  } finally { fs.closeSync(fd); }
  const dimensions = pngDimensions(bytes);
  const observation = observeWorkspaceFile(cwd, String(input), "read", bytes);
  if (!observation) throw new Error("read_image_observation_unavailable");
  return {
    content: JSON.stringify({ mediaType: "image/png", relativePath: observation.relativePath,
      sha256: observation.sha256, bytes: observation.bytes, ...dimensions }),
    fileObservation: observation,
    imageDataUrl: `${IMAGE_DATA_URL_PREFIX}${bytes.toString("base64")}`,
  };
}

function writeUtf8File(file: string, content: string): void {
  writeFileAtomic(file, content);
}

function writeFileAtomic(file: string, content: string | Buffer): void {
  // 기존 inode 를 잘라내지 않고 새 inode 로 교체한다. 작업 폴더의 항목이 바깥 파일로의
  // 하드링크라면, 이 방식은 작업 폴더 경로만 갱신하고 다른 링크의 inode 는 못 바꾼다.
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.agentlas-${process.pid}-${randomUUID()}.tmp`,
  );
  let targetMode = 0o600;
  let targetOwner: { uid: number; gid: number } | null = null;
  try {
    const existing = fs.statSync(file);
    if (existing.isFile()) {
      targetMode = existing.mode & 0o777;
      targetOwner = { uid: existing.uid, gid: existing.gid };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  let fd: number | null = null;
  try {
    fd = openRegularFile(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    if (typeof content === "string") fs.writeFileSync(fd, content, "utf8"); else fs.writeFileSync(fd, content);
    if (targetOwner) {
      try { fs.fchownSync(fd, targetOwner.uid, targetOwner.gid); } catch { /* best-effort */ }
    }
    try { fs.fchmodSync(fd, targetMode); } catch { /* Windows/best-effort */ }
    try { fs.fsyncSync(fd); } catch { /* best-effort durability */ }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      // Windows 의 renameSync 는 기존 대상을 대체하지 않는다.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    }
  } finally {
    if (fd != null) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

function truncate(value: unknown, max: number): string {
  const s = String(value);
  return s.length <= max ? s : truncationText(s.slice(0, max), s.length - max);
}

function truncationText(head: string, dropped: number): string {
  return `${head}\n…(${dropped} chars truncated)`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  {name:"history_work_draft",minPerm:"write",description:"Produce one immutable canonical finite-record declaration for the currently registered personal file. No file paths, execution identifiers or oracle cases.",parameters:{type:"object",properties:{program:{type:"object"}},required:["program"],additionalProperties:false},run:async(args,ctx)=>{if(!ctx.historyWork)throw new Error("history_work_original_scope_required");return JSON.stringify(await ctx.historyWork("history_work_draft",args));}},
  {name:"history_work_apply",minPerm:"write",description:"Request separate employee native review of the already admitted finite-record file change. This does not itself approve the change.",parameters:{type:"object",properties:{},additionalProperties:false},run:async(args,ctx)=>{if(!ctx.historyWork||Object.keys(args).length)throw new Error("history_work_original_scope_required");return JSON.stringify(await ctx.historyWork("history_work_apply",args));}},
  {
    name: "list_dir",
    minPerm: "read",
    description: "List files and folders in a directory (relative to the working folder).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: working folder)" } },
    },
    run(args, ctx) {
      const dir = resolveExistingIn(ctx.cwd, str(args.path) || ".");
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = entries
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return `${dir}\n${lines.join("\n")}`;
    },
  },
  {
    name: "read_file",
    minPerm: "read",
    description: "Read a UTF-8 text file. Optionally from a line offset.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line" },
        limit: { type: "number", description: "max lines" },
      },
      required: ["path"],
    },
    run(args, ctx) {
      const file = resolveExistingIn(ctx.cwd, args.path);
      const stat = fs.statSync(file);
      if (!stat.isFile()) pathDenied("only regular files may be read");
      // Same result, read off the host thread (readLargeTextFile). Files at or
      // below the cap keep the in-memory path and their file observation.
      if (stat.size > FILE_OBSERVATION_MAX_BYTES) return readLargeTextFile(file, num(args.offset), num(args.limit)).then((content) => ({ content }));
      let content = readUtf8File(file);
      const fileObservation = observeWorkspaceFile(ctx.cwd, String(args.path), "read", content);
      const offset = num(args.offset);
      const limit = num(args.limit);
      if (offset || limit) {
        const lines = content.split("\n");
        const start = Math.max(0, (offset || 1) - 1);
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return { content: truncate(content, 20_000), ...(fileObservation ? { fileObservation } : {}) };
    },
  },
  {
    name: "read_image",
    minPerm: "read",
    description: "Read the pixels of a non-interlaced PNG image inside the working folder. Use a relative path. Returns the image for visual interpretation, with a verified file hash; maximum 6 MB and 16 million pixels.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, maxLength: 700, description: "PNG image path relative to the working folder" } },
      required: ["path"],
      additionalProperties: false,
    },
    run(args, ctx) {
      if (Object.keys(args).length !== 1 || typeof args.path !== "string" || !args.path || args.path.length > 700) throw new Error("read_image_invalid_input");
      return readWorkspaceImage(ctx.cwd, args.path);
    },
  },
  {
    name: "write_file",
    minPerm: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run(args, ctx) {
      const content = str(args.content);
      if (content === undefined) throw new Error("content must be a string");
      const file = resolveWritableIn(ctx.cwd, args.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      writeUtf8File(file, content);
      const fileObservation = observeWorkspaceFile(ctx.cwd, String(args.path), "write", content);
      // The written file is this run's artifact, as claude's Write and codex's file
      // change already are (their runners bind the path). Without it a host-loop run
      // (serving/BYOK/local) that wrote a file left the result rail empty.
      return { content: `${existed ? "overwrote" : "created"} ${file} (${Buffer.byteLength(content, "utf8")} bytes)`, artifactPaths: [file], ...(fileObservation ? { fileObservation } : {}) };
    },
  },
  {
    name: "edit_file",
    minPerm: "write",
    description:
      "Replace an exact substring in a file. old_string must occur exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    run(args, ctx) {
      const oldString = str(args.old_string);
      const newString = str(args.new_string);
      if (!oldString) throw new Error("old_string must be non-empty");
      if (newString === undefined) throw new Error("new_string must be a string");
      const file = resolveExistingIn(ctx.cwd, args.path);
      const src = readUtf8File(file);
      if (!src.includes(oldString)) throw new Error("old_string not found");
      const count = src.split(oldString).length - 1;
      if (args.replace_all !== true && count > 1) {
        throw new Error(`old_string occurs ${count}× (use replace_all or add context)`);
      }
      const out = args.replace_all === true
        ? src.split(oldString).join(newString)
        : src.replace(oldString, newString);
      writeUtf8File(file, out);
      const fileObservation = observeWorkspaceFile(ctx.cwd, String(args.path), "edit", out);
      return { content: `edited ${file} (${count} replacement${count > 1 ? "s" : ""})`, artifactPaths: [file], ...(fileObservation ? { fileObservation } : {}) };
    },
  },
  {
    name: "ask_user",
    minPerm: "read",
    description:
      "Ask the person a question and wait for their answer. Use this when a decision is theirs to make — never guess a requirement, a scope boundary, or a destructive choice. Returns their answer as text.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in the user's language." },
        options: {
          type: "array",
          description: "Concrete choices, when the answer is a selection. Free text stays possible.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
          },
        },
      },
      required: ["question"],
    },
    async run(args, ctx) {
      if (!ctx.askUser) throw new Error("this surface cannot ask the user");
      const question = str(args.question);
      if (!question) throw new Error("question must be a non-empty string");
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const options = rawOptions
        .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
        .map((o) => ({
          label: String(o.label ?? "").trim(),
          ...(str(o.description) ? { description: String(o.description) } : {}),
        }))
        .filter((o) => o.label);
      const outcome = await ctx.askUser({ question, options, allowFreeText: true });
      if (outcome.status === "answered") return (outcome as { answer: string }).answer;
      /*
       * 답이 없으면 **그 사실을 그대로** 돌려준다. 여기서 기본값을 지어내면 모델은
       * 사람이 고른 줄 알고 진행하고, 사용자는 자기가 하지 않은 결정을 떠안는다.
       */
      throw new Error(
        outcome.status === "no-surface"
          ? "no one is available to answer here — continue without this decision, or stop and say what you need"
          : `the question was not answered (${outcome.status})`,
      );
    },
  },
  {
    name: "browser_download",
    minPerm: "write",
    description: "Download an explicit HTTPS URL (or allowed localhost URL) using this task’s browser session. Saved to app-owned downloads and verified with a bounded-memory streaming SHA-256. Active progress may continue within the Goal time budget; 60 seconds without byte progress stops the transfer. Returns only after completed bytes are verified. No arbitrary destination/profile inputs.",
    parameters: {type:"object",properties:{url:{type:"string",maxLength:8192}},required:["url"],additionalProperties:false},
    async run(args,ctx) {
      if (!ctx.browserDownload) throw new Error("browser_download_scope_unavailable");
      if (Object.keys(args).length !== 1 || typeof args.url !== "string" || !args.url || args.url.length > 8192) throw new Error("browser_download_invalid_input");
      const result = await ctx.browserDownload(args.url);
      return {content:JSON.stringify({downloadId:result.id,fileName:result.fileName,bytes:result.bytes,state:"completed"}),downloadId:result.id,artifactPaths:[result.savePath]};
    },
  },
  {
    name: "generate_image",
    minPerm: "read",
    description:
      "Generate an image from a text prompt using the multimodal runtime slot. Returns the engine that drew it and a data: URI the chat renders inline. To keep the image as a file in the working folder, pass save_as (a relative path ending .png, .jpg or .jpeg; needs write permission). Write the prompt yourself — this tool does not rewrite it. Use it when the user asks for a picture, diagram, illustration, or mockup.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to draw, in English, as concretely as you can. Say the subject, composition, and style. Do not ask for text inside the image — generators render letters badly.",
          minLength: 1,
          maxLength: 4000,
        },
        save_as: {
          type: "string",
          description: "Optional. Keep the image as this file in the working folder, e.g. assets/logo.png (.png, .jpg or .jpeg). Needs write permission. If the generator draws the other type, the file is saved with the matching extension and the result says so.",
          maxLength: 300,
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.generateImage) return "No multimodal runtime is attached to this run.";
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return "prompt is required.";
      const saveAs = typeof args.save_as === "string" ? args.save_as.trim() : "";
      if (saveAs) {
        // Everything that can be known before the generation is checked before it: the generator is paid, and a refusal after it loses
        // the image. A read-only run, an extension no image type can match, and a path that leaves the working folder (absolute, "..",
        // a symlink out) are refused here. What the generator returns (PNG or JPEG) is only known afterwards; the path is resolved
        // again below, right before the write, so a link swapped during the generation is still caught.
        if (PERM_RANK[ctx.permission] < PERM_RANK.write) throw new Error(`permission denied: save_as needs 'write' but this run has '${ctx.permission}'.`);
        if (!IMAGE_SAVE_EXTENSIONS.includes(path.extname(saveAs).toLowerCase())) throw new Error("save_as must end with .png, .jpg or .jpeg.");
        resolveWritableIn(ctx.cwd, saveAs);
      }
      const r = await ctx.generateImage({ prompt });
      // 실패는 실패라고 말한다 — 모델이 "그렸다"고 쓰지 않도록 결과 문장이 분명해야 한다.
      if (!r.ok || !r.src) return `Image generation failed: ${r.message || "no image was produced"}`;
      if (saveAs) {



        const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(r.src);
        if (!match) return `Image generated by ${r.engine ?? "unknown"} but it is not a PNG or JPEG, so it was not saved to ${saveAs}.`;
        const kind = match[1] === "png" ? "png" : "jpeg";
        const bytes = Buffer.from(match[2], "base64");
        if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) throw new Error("the image is empty or too large to save.");
        // The generator decides the type. A name whose extension says the other type would hold a PNG as ".jpg" (or the reverse);
        // the paid image is not thrown away for that: it is saved with the extension of its own type, and the result says so.
        // A file the owner did not name is never replaced for it.
        const requestedExt = path.extname(saveAs).toLowerCase();
        const matches = kind === "png" ? requestedExt === ".png" : requestedExt === ".jpg" || requestedExt === ".jpeg";
        const target = matches ? saveAs : `${saveAs.slice(0, saveAs.length - requestedExt.length)}${kind === "png" ? ".png" : ".jpg"}`;
        const file = resolveWritableIn(ctx.cwd, target);
        if (!matches && fs.existsSync(file)) {
          return {
            content: `Image generated by ${r.engine ?? "unknown"} as a ${kind.toUpperCase()}, but save_as ends ${requestedExt} and ${path.basename(file)} already exists, so nothing was saved. The image is shown in the chat.`,
            ...(r.artifactPath ? { artifactPaths: [r.artifactPath] } : {}),
            imageDataUrl: r.src,
          };
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const existed = fs.existsSync(file);
        writeFileAtomic(file, bytes);
        const fileObservation = observeWorkspaceFile(ctx.cwd, target, "write", bytes);
        return {
          content: JSON.stringify({
            ok: true, engine: r.engine ?? "unknown", saved_to: file, bytes: bytes.length, replaced: existed,
            ...(matches ? {} : { note: `The generator drew a ${kind.toUpperCase()}, so the file was saved as ${path.basename(file)}, not ${path.basename(saveAs)}.` }),
          }),
          artifactPaths: [file],
          ...(fileObservation ? { fileObservation } : {}),
          imageDataUrl: r.src,
        };
      }
      return {
        content: JSON.stringify({ ok: true, engine: r.engine ?? "unknown", src: r.src }),
        ...(r.artifactPath ? { artifactPaths: [r.artifactPath] } : {}),
        imageDataUrl: r.src,
      };
    },
  },
  {
    name: "bash",
    minPerm: "full",
    description: "Run a shell command in the working folder. Requires 'full' permission.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
      required: ["command"],
    },
    async run(args, ctx) {
      const command = str(args.command);
      if (!command) throw new Error("command must be a non-empty string");
      const requested = num(args.timeout_ms);
      const timeout = Math.min(Math.max(requested && requested > 0 ? requested : 120_000, 1_000), 600_000);
      // Below full permission the command runs in the working-folder sandbox. A command that would start a process outside
      // it through an OS launcher is refused first: the sandbox cannot stop that (same rule as Claude Code write runs).
      const confined = ctx.permission !== "full";
      if (confined && !ctx.confineShell) throw new Error(`permission denied: 'bash' requires 'full' but this run has '${ctx.permission}'.`);
      const escape = confined ? classifyLaunchEscape(command) : null;
      if (escape) throw new Error(launchEscapeDenialReason(escape, PERMISSION_ESCALATION_MARKER));
      const launch = confined ? ctx.confineShell!(command) : { file: "bash", args: ["-lc", command] };
      // ★비동기 spawn 을 쓴다. 터미널 사본은 spawnSync 였는데, 데스크탑에서 그러면
      // 명령이 끝날 때까지 **메인 프로세스 전체가 멈춘다**(UI·다른 실행·IPC 포함).
      // 최대 10분짜리 도구가 앱을 10분 얼리는 것은 도구가 아니라 결함이다.
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.file, launch.args, {
          cwd: ctx.cwd,
          env: ctx.env ?? process.env,
        });
        let out = "";
        let err = "";
        let bytes = 0;
        const MAX_BYTES = 8 * 1024 * 1024;
        let overflowed = false;
        let settled = false;
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          finish(null, `timed out after ${timeout}ms`);
        }, timeout);
        const onAbort = () => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          finish(null, "cancelled");
        };
        ctx.signal?.addEventListener("abort", onAbort, { once: true });

        const collect = (chunk: Buffer, into: "out" | "err") => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            overflowed = true;
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            return;
          }
          if (into === "out") out += chunk.toString("utf8");
          else err += chunk.toString("utf8");
        };
        child.stdout?.on("data", (c: Buffer) => collect(c, "out"));
        child.stderr?.on("data", (c: Buffer) => collect(c, "err"));

        function finish(code: number | null, note?: string): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          let head = `exit ${code == null ? "?" : code}`;
          if (note) head += ` (${note})`;
          else if (overflowed) head += " (output exceeded 8MB, truncated)";
          const body = truncate([out, err].join("\n").trim() || "(no output)", 12_000);
          const content = `${head}\n${body}`;
          if (code !== 0 || note || overflowed) reject(new Error(content));
          else resolve(content);
        }
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => finish(code));
      });
    },
  },
];

const BY_NAME = new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));

/**




 */
export const BUILTIN_TOOL_KINDS: Readonly<Record<string, RuntimeToolKind>> = Object.freeze({
  history_work_draft: "other", history_work_apply: "edit",
  list_dir: "read", read_file: "read", read_image: "read", write_file: "edit", edit_file: "edit", ask_user: "other",
  browser_download: "fetch", generate_image: "edit", bash: "execute",
});

/** `bash` at write permission, inside the working-folder sandbox (BuiltinToolContext.confineShell). */
function confinedShellAllowed(name: string, permission: ToolPermission, confined: boolean): boolean {
  return name === "bash" && permission === "write" && confined;
}

/** 이 권한에서 **존재하는** 도구들. 부족한 도구는 목록에 아예 없다. */
export function allowedBuiltinTools(
  permission: ToolPermission,
  opts: { canAskUser?: boolean; canGenerateImage?: boolean; canBrowserDownload?: boolean; historyWorkTools?:readonly string[]; canConfineShell?: boolean } = {},
): BuiltinTool[] {
  const rank = PERM_RANK[permission] ?? 0;
  return BUILTIN_TOOLS.filter((tool) => {
    if (PERM_RANK[tool.minPerm] > rank && !confinedShellAllowed(tool.name, permission, opts.canConfineShell === true)) return false;
    if (tool.name.startsWith("history_work_") && !opts.historyWorkTools?.includes(tool.name)) return false;
    // 물을 표면이 없으면 묻는 도구도 없다 — 있는데 못 쓰는 도구는 함정이다.
    if (tool.name === "ask_user" && !opts.canAskUser) return false;
    // 멀티모달 슬롯이 비어 있으면 그리는 도구도 없다. "있는데 못 그림"은 함정이다.
    if (tool.name === "generate_image" && !opts.canGenerateImage) return false;
    if (tool.name === "browser_download" && !opts.canBrowserDownload) return false;
    return true;
  });
}

export function builtinToolByName(name: string): BuiltinTool | undefined {
  return BY_NAME.get(name);
}

/** OpenAI 함수 호출 형식. */
export function builtinToolsAsOpenAi(permission: ToolPermission, opts: { canAskUser?: boolean; canGenerateImage?: boolean; canBrowserDownload?: boolean; historyWorkTools?:readonly string[]; canConfineShell?: boolean } = {}): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return allowedBuiltinTools(permission, opts).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Anthropic 도구 형식. */
export function builtinToolsAsAnthropic(permission: ToolPermission, opts: { canAskUser?: boolean; canGenerateImage?: boolean; canBrowserDownload?: boolean; historyWorkTools?:readonly string[]; canConfineShell?: boolean } = {}): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}[] {
  return allowedBuiltinTools(permission, opts).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/**
 * A failed call that also sent a name the tool does not take (read_file {file_path}) says what the tool takes and which
 * declared name is closest. Added to the failure only; the call is never retried with the near name. Silent when the
 * tool takes the argument or the failure cannot come from a wrong name (extra keys are otherwise harmless).
 */
function builtinArgumentHint(tool: BuiltinTool, args: Record<string, unknown>): string {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object") return "";
  const declared = Object.keys(properties);
  const unknown = Object.keys(args).filter((key) => !declared.includes(key) && !key.startsWith("_agentlas"));
  if (!unknown.length) return "";
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required as string[] : [];
  const missing = required.some((key) => args[key] === undefined);
  if (!missing && !unknown.some((key) => closestNames(key, declared).length)) return "";
  return ` ${unknownArgumentMessage(tool.name, unknown, declared)}`;
}

/**
 * 도구 하나를 실행한다. 권한 부족·알 수 없는 도구·실행 오류는 **던지지 않고**
 * `ok:false` 로 돌려준다 — 모델이 그 문장을 읽고 다른 길을 찾을 수 있어야 하고,
 * 도구 실패가 실행 전체를 죽이면 안 된다.
 */
export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolRunResult & { ok: boolean }> {
  const tool = BY_NAME.get(name);
  if (!tool) { const near = didYouMean(name, BY_NAME.keys()); return { ok: false, content: `unknown tool: ${name}${near ? `.${near}` : ""}` }; }
  if (PERM_RANK[tool.minPerm] > (PERM_RANK[ctx.permission] ?? 0) && !confinedShellAllowed(name, ctx.permission, !!ctx.confineShell)) {
    return {
      ok: false,
      content: `permission denied: '${name}' requires '${tool.minPerm}' but this run has '${ctx.permission}'.`,
    };
  }
  try {
    const value = await tool.run(args ?? {}, ctx);
    if (value && typeof value === "object" && typeof value.content === "string") {
      return {
        ok: true,
        content: value.content,
        ...(value.fileObservation ? { fileObservation: value.fileObservation } : {}),
        ...(value.downloadId ? { downloadId: value.downloadId } : {}),
        ...(value.artifactPaths?.length ? { artifactPaths: [...value.artifactPaths] } : {}),
        ...(value.imageDataUrl ? { imageDataUrl: value.imageDataUrl } : {}),
      };
    }
    return { ok: true, content: String(value) };
  } catch (error) {
    return { ok: false, content: `${name} error: ${error instanceof Error ? error.message : String(error)}${builtinArgumentHint(tool, args ?? {})}` };
  }
}
