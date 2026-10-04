// macOS·윈도우 CLI 설치 — npm·Node·.cmd 없이 공식 네이티브 실행파일 하나를 받아 둔다.
//
// ★ 왜 (오너 지시 2026-09-23): "연결을 누르면 유저는 로그인만 하게. 어떤 상황에서도 실패하지 않게."
//   초보 사용자는 설치가 한 번 막히면 앱을 지운다. 기존 윈도우 경로는 실패 자리가 너무 많았다:
//     · 번들 node.exe 를 앱 밖으로 복사(백신·동기화·잠김) — 1.2.34 에서 비치명화
//     · npm 이 시스템 프록시·윈도우 인증서 저장소를 모른다(회사망·TLS 검사 → 전멸)
//     · npm 캐시 손상, 레지스트리 순간 장애
//     · postinstall 이 cmd.exe 로 도는데, 우리가 쓴 .cmd 심이 UTF-8 절대경로를 담는다 —
//       cmd.exe 는 배치 파일을 OEM 코드페이지(한국어 윈도우 CP949)로 읽으므로 사용자 이름이
//       한글이면 경로가 깨져 **매번** 실패한다.
//   claude-code · codex · grok 은 npm 에 플랫폼별 패키지로 **공식 네이티브 exe** 를 싣고 있다
//   (래퍼 패키지의 postinstall 이 하는 일도 결국 그 exe 를 꺼내 두는 것이다). 그 exe 하나만
//   받아 두면 위 실패 자리가 전부 사라진다.
//
// 다운로드는 Electron net(크로미움 네트워크 스택)을 먼저 쓴다 — 시스템 프록시·PAC·윈도우
// 인증서 저장소를 그대로 따르므로 브라우저가 되는 망이면 된다. 무결성은 이 릴리스에 고정된
// sha512 로 검증하므로, 미러로 받아도 공급망은 같다.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { Unzip, UnzipInflate } from "fflate";

export type NativeCliKind = "claude-code" | "codex" | "grok" | "kimi";

type PlatformKey = "win32-x64" | "win32-arm64" | "darwin-x64" | "darwin-arm64";

interface NativeArtifact {
  /** npm 레지스트리 tarball 경로(호스트 제외). 미러마다 같은 경로를 쓴다. */
  tarballPath: string;
  /** npm dist.integrity or the official release SHA-256 normalized to base64. */
  integrity: string;
  /** Exact official asset URL for releases distributed outside npm. */
  url?: string;
}

type NativeLayout =
  /** tarball 안 파일 하나가 곧 실행파일. */
  | { kind: "single"; entry: string; exe: string; brotli?: boolean; zip?: boolean }
  /** tarball 안 디렉터리를 통째로 풀고, 그 안의 exe 를 쓴다(codex 는 옆 리소스가 필요하다). */
  | { kind: "tree"; prefixByPlatform: Partial<Record<PlatformKey, string>>; exe: string };

interface NativePin {
  version: string;
  bin: string;
  artifacts: Partial<Record<PlatformKey, NativeArtifact>>;
  layout: NativeLayout;
  darwinLayout: NativeLayout;
}

/**
 * 릴리스가 검증한 정확한 공식 패키지. install-cli.ts CLI_PLAN 의 version 과 같아야 한다 —
 * 다르면 네이티브 경로는 건너뛰고 npm 경로가 CLI_PLAN 판으로 설치한다(옛 판을 설치하지 않는다).
 * Darwin pins come from the official registry dist.integrity and tarball layouts for these exact versions.
 * Provider wrapper optionalDependencies declare the same per-platform native payloads.
 */
export const NATIVE_CLI_PINS: Record<NativeCliKind, NativePin> = {
  kimi: {
    version: "0.28.0",
    bin: "kimi",
    // Official manifest.json at the exact @moonshot-ai/kimi-code@0.28.0 release.
    // Its Darwin ZIPs contain one Mach-O executable named `kimi`; no Node wrapper.
    artifacts: {
      "darwin-arm64": {
        tarballPath: "kimi-code-darwin-arm64.zip",
        url: "https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai%2Fkimi-code%400.28.0/kimi-code-darwin-arm64.zip",
        integrity: "sha256-VV6RYOA0uLUjpliIOXA26VA5nmbCRBVSDQXWHSVtl8w=",
      },
      "darwin-x64": {
        tarballPath: "kimi-code-darwin-x64.zip",
        url: "https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai%2Fkimi-code%400.28.0/kimi-code-darwin-x64.zip",
        integrity: "sha256-Hbib2ivzjCSaYbTj20/cSYH9G4bwV7dWGB1v1ZCv5kk=",
      },
    },
    layout: { kind: "single", entry: "kimi", exe: "kimi", zip: true },
    darwinLayout: { kind: "single", entry: "kimi", exe: "kimi", zip: true },
  },
  "claude-code": {
    version: "2.1.214",
    bin: "claude",
    artifacts: {
      "darwin-arm64": {
        tarballPath: "@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.214.tgz",
        integrity: "sha512-z99kjSImARBWdE6lGoCXSi83tbiabtIv7vtFyuwrHD56WZTFSguedBb9F8wlUncEEfUVtqHKa9nCZ55j6spiIA==",
      },
      "darwin-x64": {
        tarballPath: "@anthropic-ai/claude-code-darwin-x64/-/claude-code-darwin-x64-2.1.214.tgz",
        integrity: "sha512-rmETY21bPyPPyPCd4UnOnLLBOyQCSQtIjjBb26dBtqh6mLjA5qZKOMv+Uta+GBzpAWd+nxA8oro28QUVT8CGYw==",
      },
      "win32-x64": {
        tarballPath: "@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.214.tgz",
        integrity: "sha512-iK9gLQSs2+bJuRV2qdrYQ4bj7VVZQKp2+TXzI89WMsxwuot0ZyY59Ei3lJ7bMfeIOAUaRFLqYFq36QMg4Cnddw==",
      },
      "win32-arm64": {
        tarballPath: "@anthropic-ai/claude-code-win32-arm64/-/claude-code-win32-arm64-2.1.214.tgz",
        integrity: "sha512-aSxjth4QhmxDZlK3bLhSs689RSiciK3WNX5ZTVjXfQgIUn9zZ8TaFreV4nHAmIKGh3AM1s30IXABiinTR8MrwA==",
      },
    },
    layout: { kind: "single", entry: "package/claude.exe", exe: "claude.exe" },
    darwinLayout: { kind: "single", entry: "package/claude", exe: "claude" },
  },
  codex: {
    version: "0.144.6",
    bin: "codex",
    artifacts: {
      "darwin-arm64": {
        tarballPath: "@openai/codex/-/codex-0.144.6-darwin-arm64.tgz",
        integrity: "sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==",
      },
      "darwin-x64": {
        tarballPath: "@openai/codex/-/codex-0.144.6-darwin-x64.tgz",
        integrity: "sha512-THRyPG0zSU6M8NQAge1LHEHsJDnoH4BpKsfJHB/qe3Fm+Wf6zqAmWJFlOKzBm27m0K2Hq3za4Ac2I5p5i4yp/A==",
      },
      "win32-x64": {
        tarballPath: "@openai/codex/-/codex-0.144.6-win32-x64.tgz",
        integrity: "sha512-dN39VnjEthKz5io1RNWwZDtErdSn07nW3pGUgvlA6DMxgm/nuGaIAZO/sG/Hgxq/x5j9HteAENfrFgVkpZ0lFg==",
      },
      "win32-arm64": {
        tarballPath: "@openai/codex/-/codex-0.144.6-win32-arm64.tgz",
        integrity: "sha512-SpMjXJLW43JzMP0K62mVcYfmFcpk0BK4AOgYmWSfyZHs3iRtHMd0UYw7605n/9lwkT2EqbwQLT2omZFeKJFzwA==",
      },
    },
    layout: {
      kind: "tree",
      prefixByPlatform: {
        "win32-x64": "package/vendor/x86_64-pc-windows-msvc/",
        "win32-arm64": "package/vendor/aarch64-pc-windows-msvc/",
      },
      exe: "bin/codex.exe",
    },
    darwinLayout: {
      kind: "tree",
      prefixByPlatform: {
        "darwin-arm64": "package/vendor/aarch64-apple-darwin/",
        "darwin-x64": "package/vendor/x86_64-apple-darwin/",
      },
      exe: "bin/codex",
    },
  },
  grok: {
    version: "0.2.103",
    bin: "grok",
    artifacts: {
      "darwin-arm64": {
        tarballPath: "@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-0.2.103.tgz",
        integrity: "sha512-+LRy78gIie+svz8NpkHJvbBYpqR02oWBQDexr0sp8rNzjMcvmjWvBp8riht+I10uNaRtWiXu2FAyFBAAgukPHw==",
      },
      "darwin-x64": {
        tarballPath: "@xai-official/grok-darwin-x64/-/grok-darwin-x64-0.2.103.tgz",
        integrity: "sha512-pGzPJiAaMp0MRbWPJ+x7UXzaJ8SonOVOHxuSXrrVjh6E4Kl8KOslLiKOi8AE3gUQu6eSBNnxusBjYikxlBO3Pg==",
      },
      "win32-x64": {
        tarballPath: "@xai-official/grok-win32-x64/-/grok-win32-x64-0.2.103.tgz",
        integrity: "sha512-xjyORxCUTwkwnhC1UvabrLsa9h/8KQtOKPldG78tCb9pFRlgSrbKZrOZMxj2fQ7R8w9LOF5ILDCmDjGGaoCOjg==",
      },
      "win32-arm64": {
        tarballPath: "@xai-official/grok-win32-arm64/-/grok-win32-arm64-0.2.103.tgz",
        integrity: "sha512-sVpBKGmJw3qhBxHjjfoLdEQbAfV+IqOrODk66IxoHBraZ5qtv2VdBJ4G/RgCLmckMJsFv8SfgzRPjbjhsa/Thw==",
      },
    },
    layout: { kind: "single", entry: "package/bin/grok.exe.br", exe: "grok.exe", brotli: true },
    darwinLayout: { kind: "single", entry: "package/bin/grok.br", exe: "grok", brotli: true },
  },
};

/** 무결성이 고정돼 있으므로 어느 미러에서 받아도 같은 바이트다. 공식 레지스트리가 먼저. */
const REGISTRY_HOSTS = ["https://registry.npmjs.org/", "https://registry.npmmirror.com/"];
const MARKER = ".agentlas-native.json";
// An extracted executable can still fail its first real --version launch.
// Keep it out of detection even if an antivirus temporarily locks its marker.
const rejectedExecutables = new Set<string>();
/** 이 시간 동안 한 바이트도 안 오면 끊고 다음 수단으로 간다(느린 망은 괜찮다). */
const STALL_MS = 60_000;
const ROUNDS = 3;

function platformKey(): PlatformKey | null {
  if (process.platform !== "win32" && process.platform !== "darwin") return null;
  if (process.arch === "x64" || process.arch === "arm64") return `${process.platform}-${process.arch}`;
  return null;
}

export function isNativeCliKind(kind: string): kind is NativeCliKind {
  return Object.prototype.hasOwnProperty.call(NATIVE_CLI_PINS, kind);
}

export function nativeCliSupported(kind: string): kind is NativeCliKind {
  const key = platformKey();
  return isNativeCliKind(kind) && key !== null && !!NATIVE_CLI_PINS[kind].artifacts[key];
}

/**
 * 설치 루트 후보. 홈 아래가 기본이고(우리 npm prefix 안이라 기존 "Agentlas 관리본" 판정을
 * 그대로 받는다), 홈에 쓸 수 없는 기계(리디렉션·보호 폴더)를 위해 %LOCALAPPDATA% 를 둔다.
 */
export function nativeCliRoots(): string[] {
  const roots = [path.join(os.homedir(), ".agentlas", "npm", "native")];
  const local = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && local) roots.push(path.join(local, "Agentlas", "native-cli"));
  return roots;
}

function installDir(root: string, kind: NativeCliKind, key: PlatformKey): string {
  return path.join(root, kind, `${NATIVE_CLI_PINS[kind].version}-${key}`);
}

function layoutFor(kind: NativeCliKind, key: PlatformKey): NativeLayout {
  const pin = NATIVE_CLI_PINS[kind];
  return key.startsWith("darwin-") ? pin.darwinLayout : pin.layout;
}

function exeRelative(kind: NativeCliKind, key: PlatformKey): string {
  const layout = layoutFor(kind, key);
  return layout.kind === "single" ? layout.exe : layout.exe.split("/").join(path.sep);
}

/** 완성 표식까지 있는 설치본의 실행파일. 반쯤 풀린 폴더는 절대 돌려주지 않는다. */
export function nativeCliExecutable(kind: NativeCliKind): string | null {
  const key = platformKey();
  if (!key || !isNativeCliKind(kind)) return null;
  const pin = NATIVE_CLI_PINS[kind];
  const artifact = pin.artifacts[key];
  if (!artifact) return null;
  for (const root of nativeCliRoots()) {
    const dir = installDir(root, kind, key);
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as { version?: string; integrity?: string };
      if (marker.version !== pin.version || marker.integrity !== artifact.integrity) continue;
      const exe = path.join(dir, exeRelative(kind, key));
      if (rejectedExecutables.has(path.resolve(exe))) continue;
      if (fs.statSync(exe).isFile()) {
        fs.accessSync(exe, fs.constants.X_OK);
        assertExecutableFormat(exe, key);
        return exe;
      }
    } catch {
      // 다음 루트
    }
  }
  return null;
}

/** Retire only this provider's owned completion marker before npm fallback. */
export function invalidateNativeCliExecutable(kind: NativeCliKind, executable: string): boolean {
  const key = platformKey();
  if (!key || !isNativeCliKind(kind)) return false;
  for (const root of nativeCliRoots()) {
    const dir = installDir(root, kind, key);
    const expected = path.join(dir, exeRelative(kind, key));
    if (path.resolve(expected) !== path.resolve(executable)) continue;
    rejectedExecutables.add(path.resolve(expected));
    try {
      fs.rmSync(path.join(dir, MARKER), { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 실행 PATH 맨 앞에 둘 디렉터리 — 설치가 끝난 것만. */
export function nativeCliBinDirs(): string[] {
  const dirs: string[] = [];
  for (const kind of Object.keys(NATIVE_CLI_PINS) as NativeCliKind[]) {
    const exe = nativeCliExecutable(kind);
    if (exe) dirs.push(path.dirname(exe));
  }
  return dirs;
}

/** 감지 후보 맨 앞에 끼울 절대경로(설치된 경우만). */
export function nativeCliCandidates(kind: NativeCliKind): string[] {
  const exe = nativeCliExecutable(kind);
  return exe ? [exe] : [];
}

export function isNativeCliPath(candidate: string): boolean {
  const resolved = path.resolve(candidate).toLowerCase();
  return nativeCliRoots().some((root) => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

export interface NativeInstallOptions {
  force?: boolean;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}

function checkCancelled(options: NativeInstallOptions): void {
  if (options.signal?.aborted) throw new Error("install-cancelled");
}

function progress(options: NativeInstallOptions, line: string): void {
  try { options.onOutput?.(line); } catch { /* UI failures do not affect installation. */ }
}

function assertExecutableFormat(file: string, key: PlatformKey): void {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8);
  try { if (fs.readSync(fd, head, 0, head.length, 0) < head.length) throw new Error("executable-format-invalid"); }
  finally { fs.closeSync(fd); }
  if (key.startsWith("win32-")) {
    if (head[0] !== 0x4d || head[1] !== 0x5a) throw new Error("executable-format-invalid");
  } else {
    // Exact platform artifacts are thin 64-bit Mach-O; reject wrappers and a wrong CPU.
    const cpu = key === "darwin-arm64" ? 0x0100000c : 0x01000007;
    if (head.readUInt32LE(0) !== 0xfeedfacf || head.readUInt32LE(4) !== cpu) throw new Error("executable-format-invalid");
  }
}

// ── 다운로드 ──────────────────────────────────────────────────────────

type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
}>;

/** 크로미움 스택(시스템 프록시·인증서)을 먼저, 안 되면 Node 스택. */
function fetchStacks(): Array<{ name: string; fetch: FetchLike }> {
  const stacks: Array<{ name: string; fetch: FetchLike }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { net?: { fetch?: FetchLike } };
    if (typeof electron?.net?.fetch === "function") {
      const netFetch = electron.net.fetch.bind(electron.net);
      stacks.push({ name: "electron-net", fetch: netFetch });
    }
  } catch {
    // 테스트·node 환경
  }
  if (typeof globalThis.fetch === "function") {
    stacks.push({ name: "node", fetch: globalThis.fetch.bind(globalThis) as unknown as FetchLike });
  }
  return stacks;
}

function integrityAlgorithm(expected: string): "sha256" | "sha512" {
  return expected.startsWith("sha256-") ? "sha256" : "sha512";
}

function integrityOf(hash: crypto.Hash, expected: string): string {
  return `${integrityAlgorithm(expected)}-${hash.digest("base64")}`;
}

async function hashExisting(file: string, hash: crypto.Hash, options: NativeInstallOptions = {}): Promise<number> {
  checkCancelled(options);
  let size = 0;
  try {
    for await (const chunk of fs.createReadStream(file)) {
      checkCancelled(options);
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
  } catch (error) {
    checkCancelled(options);
    throw error;
  }
  return size;
}

async function downloadOnce(
  stack: { name: string; fetch: FetchLike },
  url: string,
  partial: string,
  expected: string,
  options: NativeInstallOptions = {},
): Promise<"ok" | "mismatch"> {
  checkCancelled(options);
  let hash = crypto.createHash(integrityAlgorithm(expected));
  let offset = fs.existsSync(partial) ? await hashExisting(partial, hash, options) : 0;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("install-cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  let bytes = offset;
  let reported = bytes;
  let stall: NodeJS.Timeout | undefined;
  const arm = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new Error("download-stalled")), STALL_MS);
  };
  arm();
  try {
    const response = await stack.fetch(url, {
      signal: controller.signal,
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    });
    if (offset > 0 && (response.status === 400 || response.status === 405 || response.status === 501)) {
      // Some official release hosts reject Range; retry from zero instead of reusing a stuck partial.
      fs.rmSync(partial, { force: true });
      throw new Error("download-range-unsupported");
    }
    if (response.status === 416 && offset > 0) {
      // 이미 끝까지 받은 조각 — 검증으로 넘어간다.
    } else {
      if (!response.ok || !response.body) throw new Error(`download-http-${response.status}`);
      if (offset > 0 && response.status !== 206) {
        // 서버가 이어받기를 거절했다 — 처음부터.
        hash = crypto.createHash(integrityAlgorithm(expected));
        offset = 0;
      }
      const out = fs.createWriteStream(partial, { flags: offset > 0 ? "a" : "w" });
      try {
        for await (const chunk of Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream)) {
          checkCancelled(options);
          arm();
          const buffer = chunk as Buffer;
          bytes += buffer.length;
          if (bytes - reported >= 4 * 1024 * 1024) {
            reported = bytes;
            progress(options, `native download: ${Math.floor(bytes / 1024 / 1024)} MiB`);
          }
          hash.update(buffer);
          if (!out.write(buffer)) await new Promise<void>((resolve, reject) => {
            const done = () => { out.removeListener("error", failed); resolve(); };
            const failed = (error: Error) => { out.removeListener("drain", done); reject(error); };
            out.once("drain", done);
            out.once("error", failed);
          });
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      }
    }
  } finally {
    if (stall) clearTimeout(stall);
    options.signal?.removeEventListener("abort", cancel);
  }
  checkCancelled(options);
  if (integrityOf(hash, expected) === expected) return "ok";
  fs.rmSync(partial, { force: true });
  return "mismatch";
}

async function downloadVerified(artifact: NativeArtifact, cacheDir: string, notes: string[], options: NativeInstallOptions = {}): Promise<string | null> {
  checkCancelled(options);
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, path.basename(artifact.tarballPath));
  const partial = `${target}.partial`;
  // 전에 끝까지 받아 검증까지 마친 파일이 있으면 다시 받지 않는다(재시도·다른 루트용).
  if (fs.existsSync(target)) {
    const hash = crypto.createHash(integrityAlgorithm(artifact.integrity));
    await hashExisting(target, hash, options);
    if (integrityOf(hash, artifact.integrity) === artifact.integrity) return target;
    fs.rmSync(target, { force: true });
  }
  const stacks = fetchStacks();
  const urls = artifact.url ? [artifact.url] : REGISTRY_HOSTS.map((host) => host + artifact.tarballPath);
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const url of urls) {
      for (const stack of stacks) {
        try {
          checkCancelled(options);
          progress(options, `native download: ${stack.name}, attempt ${round + 1}`);
          const result = await downloadOnce(stack, url, partial, artifact.integrity, options);
          if (result === "ok") {
            await renameWithRetry(partial, target, options);
            return target;
          }
          notes.push(`${stack.name}@${new URL(url).host}:integrity-mismatch`);
        } catch (error) {
          checkCancelled(options);
          notes.push(`${stack.name}@${new URL(url).host}:${errorCode(error)}`);
        }
      }
    }
    await delay(1_500 * (round + 1), options);
  }
  return null;
}

// ── tar(.gz) 풀기 — 필요한 항목만, 스트리밍으로 ─────────────────────────

class ByteReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private done = false;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.size < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) { this.done = true; break; }
      this.chunks.push(next.value);
      this.size += next.value.length;
    }
  }

  /** 스트림 끝이면 null. */
  async read(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.size === 0 && this.done) return null;
    if (this.size < n) throw new Error("archive-truncated");
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.size -= n;
    return all.subarray(0, n);
  }

  async pipe(n: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.size === 0) throw new Error("archive-truncated");
      const head = this.chunks.shift()!;
      const take = Math.min(left, head.length);
      await sink(head.subarray(0, take));
      if (take < head.length) this.chunks.unshift(head.subarray(take));
      this.size -= take;
      left -= take;
    }
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function tarSize(block: Buffer): number {
  const field = block.subarray(124, 136);
  if (field[0] & 0x80) {
    // base-256
    let value = 0;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
    return value;
  }
  const text = tarString(block, 124, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

function paxPath(data: Buffer): string | null {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

/**
 * pick(name) 이 대상 경로를 돌려주는 항목만 쓴다. 대상은 호출자가 스테이징 폴더 안으로
 * 계산하고, 여기서 한 번 더 그 밖으로 못 나가게 막는다.
 */
async function extractTarGz(
  archive: string,
  stagingRoot: string,
  pick: (name: string) => { dest: string; brotli?: boolean } | null,
  options: NativeInstallOptions = {},
): Promise<number> {
  checkCancelled(options);
  const source = fs.createReadStream(archive);
  const unzip = source.pipe(zlib.createGunzip());
  source.once("error", (error) => unzip.destroy(error));
  const cancel = () => { source.destroy(); unzip.destroy(new Error("install-cancelled")); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const reader = new ByteReader(unzip);
  const root = path.resolve(stagingRoot) + path.sep;
  let pendingName: string | null = null;
  let written = 0;
  try {
    for (;;) {
      checkCancelled(options);
      const header = await reader.read(512);
      if (!header || header.every((byte) => byte === 0)) break;
      const size = tarSize(header);
      const padded = Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] || 0x30);
      if (type === "x" || type === "L") {
        const data = (await reader.read(padded)) ?? Buffer.alloc(0);
        const body = data.subarray(0, size);
        pendingName = type === "x" ? paxPath(body) ?? pendingName : tarString(body, 0, body.length);
        continue;
      }
      if (type === "g") { await reader.read(padded); continue; }
      const prefix = tarString(header, 345, 155);
      const baseName = tarString(header, 0, 100);
      const name = pendingName ?? (prefix ? `${prefix}/${baseName}` : baseName);
      pendingName = null;
      const target = (type === "0" || type === "\0") ? pick(name) : null;
      if (!target) {
        if (padded) await reader.read(padded);
        continue;
      }
      const dest = path.resolve(target.dest);
      if (!dest.startsWith(root)) throw new Error("archive-path-escape");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      const decoder = target.brotli ? zlib.createBrotliDecompress() : null;
      const sinkDone = new Promise<void>((resolve, reject) => {
        out.once("finish", resolve);
        out.once("error", reject);
        decoder?.once("error", reject);
      });
      // Attach immediately so an early stream error cannot become an unhandled rejection.
      void sinkDone.catch(() => {});
      const writable: NodeJS.WritableStream = decoder ?? out;
      if (decoder) decoder.pipe(out);
      const cancelOutput = () => {
        const error = new Error("install-cancelled");
        decoder?.destroy(error);
        out.destroy(error);
      };
      options.signal?.addEventListener("abort", cancelOutput, { once: true });
      try {
        await reader.pipe(size, async (chunk) => {
          checkCancelled(options);
          if (!writable.write(chunk)) await new Promise<void>((resolve, reject) => {
            const done = () => { writable.removeListener("error", failed); resolve(); };
            const failed = (error: Error) => { writable.removeListener("drain", done); reject(error); };
            writable.once("drain", done);
            writable.once("error", failed);
          });
        });
        writable.end();
        await sinkDone;
      } finally {
        options.signal?.removeEventListener("abort", cancelOutput);
        decoder?.destroy();
        out.destroy();
      }
      if (padded > size) await reader.read(padded - size);
      written += 1;
    }
    return written;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    source.destroy();
    unzip.destroy();
  }
}

/** Stream the pinned official ZIP without buffering the full native executable. */
async function extractZip(
  archive: string,
  stagingRoot: string,
  pick: (name: string) => { dest: string; brotli?: boolean } | null,
  options: NativeInstallOptions,
): Promise<number> {
  checkCancelled(options);
  const source = fs.createReadStream(archive);
  const root = path.resolve(stagingRoot) + path.sep;
  const outputs: fs.WriteStream[] = [];
  const completed: Promise<void>[] = [];
  const decoders: Array<{ terminate: () => void }> = [];
  let failure: Error | null = null;
  let count = 0;
  const cancel = () => {
    const error = new Error("install-cancelled");
    source.destroy(error);
    for (const output of outputs) output.destroy(error);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const unzip = new Unzip((file) => {
    const target = pick(file.name);
    if (!target) return;
    const dest = path.resolve(target.dest);
    if (!dest.startsWith(root)) throw new Error("archive-path-escape");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const output = fs.createWriteStream(dest);
    outputs.push(output);
    decoders.push(file);
    const done = new Promise<void>((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    });
    void done.catch(() => {});
    completed.push(done);
    file.ondata = (error, data, final) => {
      if (error) { failure = error; output.destroy(error); return; }
      if (options.signal?.aborted) { cancel(); return; }
      if (data.length) output.write(data);
      if (final) output.end();
    };
    file.start();
    count += 1;
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of source) {
      checkCancelled(options);
      unzip.push(chunk as Buffer, false);
      if (failure) throw failure;
      for (const output of outputs) {
        if (output.writableNeedDrain) await new Promise<void>((resolve, reject) => {
          const done = () => { output.removeListener("error", failed); resolve(); };
          const failed = (error: Error) => { output.removeListener("drain", done); reject(error); };
          output.once("drain", done);
          output.once("error", failed);
        });
      }
    }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    checkCancelled(options);
    await Promise.all(completed);
    return count;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    source.destroy();
    for (const decoder of decoders) decoder.terminate();
    for (const output of outputs) output.destroy();
  }
}

// ── 설치 ───────────────────────────────────────────────────────────────

function delay(ms: number, options: NativeInstallOptions = {}): Promise<void> {
  checkCancelled(options);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error("install-cancelled")); };
    const timer = setTimeout(() => { options.signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    options.signal?.addEventListener("abort", cancel, { once: true });
  });
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9-]+$/i.test(message) ? message : "error";
}

/** 백신이 갓 쓴 파일을 잠깐 잡는 건 흔하다 — 잠깐 기다렸다 다시 한다. */
async function renameWithRetry(from: string, to: string, options: NativeInstallOptions = {}): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    checkCancelled(options);
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      if ((code === "ENOTEMPTY" || code === "EEXIST") && fs.existsSync(to)) {
        try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* 다음 시도 */ }
      }
      await delay(250 * (attempt + 1), options);
    }
  }
  throw last;
}

async function installInto(
  root: string,
  kind: NativeCliKind,
  key: PlatformKey,
  archive: string,
  options: NativeInstallOptions = {},
): Promise<string> {
  checkCancelled(options);
  const pin = NATIVE_CLI_PINS[kind];
  const finalDir = installDir(root, kind, key);
  const staging = `${finalDir}.staging-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const layout = layoutFor(kind, key);
    progress(options, "native extract: verified archive");
    const pick = (name: string) => {
      if (layout.kind === "single") {
        return name === layout.entry ? { dest: path.join(staging, layout.exe), brotli: layout.brotli } : null;
      }
      const prefix = layout.prefixByPlatform[key];
      if (!prefix || !name.startsWith(prefix) || name.length === prefix.length) return null;
      const relative = name.slice(prefix.length).split("/").filter(Boolean);
      if (relative.some((part) => part === ".." || part === ".")) return null;
      return { dest: path.join(staging, ...relative) };
    };
    const count = layout.kind === "single" && layout.zip
      ? await extractZip(archive, staging, pick, options)
      : await extractTarGz(archive, staging, pick, options);
    checkCancelled(options);
    const exe = path.join(staging, exeRelative(kind, key));
    if (!count || !fs.statSync(exe).isFile()) throw new Error("archive-missing-executable");
    assertExecutableFormat(exe, key);
    if (key.startsWith("darwin-")) {
      // Codex also carries ripgrep; extracted native tools must be executable.
      const chmodTree = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          checkCancelled(options);
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) chmodTree(full);
          else if (entry.isFile()) fs.chmodSync(full, 0o700);
        }
      };
      chmodTree(staging);
    }
    checkCancelled(options);
    progress(options, "native verify: executable format and permissions");
    checkCancelled(options);
    // 표식은 마지막에 쓴다 — 표식이 있는 폴더만 완성본이다.
    fs.writeFileSync(path.join(staging, MARKER), JSON.stringify({
      kind,
      version: pin.version,
      integrity: pin.artifacts[key]!.integrity,
      installedAt: new Date().toISOString(),
    }));
    const backup = `${staging}.previous`;
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, backup);
    try {
      await renameWithRetry(staging, finalDir, options);
      const executable = path.join(finalDir, exeRelative(kind, key));
      rejectedExecutables.delete(path.resolve(executable));
      return executable;
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(finalDir)) fs.renameSync(backup, finalDir);
      throw error;
    } finally {
      if (fs.existsSync(backup) && fs.existsSync(finalDir)) fs.rmSync(backup, { recursive: true, force: true });
    }
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 청소 실패는 무해 */ }
    throw error;
  }
}

function pruneOlder(root: string, kind: NativeCliKind, keep: string): void {
  try {
    for (const entry of fs.readdirSync(path.join(root, kind))) {
      const full = path.join(root, kind, entry);
      if (full === keep) continue;
      // 돌고 있는 옛 exe 는 윈도우가 지우게 두지 않는다 — 실패는 무해하다.
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* 다음에 */ }
    }
  } catch {
    // 폴더 없음
  }
}

export type NativeInstallResult =
  | { ok: true; executable: string; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

/**
 * 고정 판의 공식 네이티브 실행파일을 설치한다. 실패해도 예외를 던지지 않고 사유만 돌려준다 —
 * 호출자는 다음 수단(npm 경로)으로 넘어간다.
 */
async function installNativeCliAttempt(kind: NativeCliKind, expectedVersion: string, options: NativeInstallOptions): Promise<NativeInstallResult> {
  if (options.signal?.aborted) return { ok: false, reason: "install-cancelled", notes: [] };
  const notes: string[] = [];
  const key = platformKey();
  if (!key || !isNativeCliKind(kind)) return { ok: false, reason: "platform-unsupported", notes };
  const pin = NATIVE_CLI_PINS[kind];
  const artifact = pin.artifacts[key];
  if (!artifact) return { ok: false, reason: "platform-unsupported", notes };
  if (pin.version !== expectedVersion) return { ok: false, reason: "pin-version-mismatch", notes };
  const existing = nativeCliExecutable(kind);
  if (existing && !options.force) return { ok: true, executable: existing, notes };
  let lastReason = "install-roots-unwritable";
  for (const root of nativeCliRoots()) {
    try {
      fs.mkdirSync(root, { recursive: true });
      const archive = await downloadVerified(artifact, path.join(root, ".download"), notes, options);
      if (!archive) return { ok: false, reason: "download-unavailable", notes };
      const executable = await installInto(root, kind, key, archive, options);
      try { fs.rmSync(archive, { force: true }); } catch { /* 캐시 청소 실패는 무해 */ }
      pruneOlder(root, kind, path.dirname(kind === "codex" ? path.dirname(executable) : executable));
      return { ok: true, executable, notes };
    } catch (error) {
      if (options.signal?.aborted) return { ok: false, reason: "install-cancelled", notes };
      lastReason = errorCode(error);
      notes.push(`root:${lastReason}`);
      // 다음 루트(%LOCALAPPDATA%)
    }
  }
  return { ok: false, reason: lastReason, notes };
}

/** One bounded native attempt before the managed npm fallback. */
export async function installNativeCli(kind: NativeCliKind, expectedVersion: string, options: NativeInstallOptions = {}): Promise<NativeInstallResult> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 5 * 60_000);
  try {
    const result = await installNativeCliAttempt(kind, expectedVersion, { ...options, signal: controller.signal });
    return timedOut && !result.ok ? { ...result, reason: "install-timeout" } : result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** 테스트 전용 — 실제 tarball 로 풀기 경로를 검증한다. */
export const __nativeCliTest = { extractTarGz, extractZip, installInto, downloadVerified, assertExecutableFormat, platformKey };
