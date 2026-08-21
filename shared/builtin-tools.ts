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
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export type ToolPermission = "read" | "write" | "full";

const PERM_RANK: Record<ToolPermission, number> = { read: 0, write: 1, full: 2 };

export interface BuiltinToolContext {
  /** 작업 폴더. 모든 경로 인자는 이 안으로 봉쇄된다. */
  cwd: string;
  permission: ToolPermission;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
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
  }>;
}

export interface BuiltinTool {
  name: string;
  minPerm: ToolPermission;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: BuiltinToolContext): Promise<string> | string;
}

function pathDenied(reason: string): never {
  throw new Error(`workspace path denied: ${reason}`);
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

function validateRelativePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    pathDenied("path must be a non-empty string");
  }
  // 두 방언 모두 검사한다. Windows 절대/UNC 경로는 POSIX 호스트에서 준비·테스트되더라도
  // 여전히 무효여야 한다(그 반대도 마찬가지).
  if (
    path.isAbsolute(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input)
  ) {
    pathDenied("absolute paths are not allowed");
  }
  // path.resolve()가 정규화해 없애기 **전에** traversal을 거부한다. 지금 바깥으로
  // 나가는 것만이 아니라 `safe/../file` 자체를 거부하는 것이 의도다.
  if (input.split(/[\\/]+/u).some((segment) => segment === "..")) {
    pathDenied("parent traversal is not allowed");
  }
  return input;
}

function lexicalPath(root: string, input: unknown): string {
  const candidate = path.resolve(root, validateRelativePath(input));
  if (!contained(root, candidate)) pathDenied("path leaves the working folder");
  return candidate;
}

function resolveExistingIn(cwd: string, input: unknown): string {
  const root = getWorkspaceRoot(cwd);
  const candidate = lexicalPath(root, input);
  const real = fs.realpathSync(candidate);
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

function writeUtf8File(file: string, content: string): void {
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
    fs.writeFileSync(fd, content, "utf8");
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
  return s.length <= max ? s : `${s.slice(0, max)}\n…(${s.length - max} chars truncated)`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
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
      let content = readUtf8File(file);
      const offset = num(args.offset);
      const limit = num(args.limit);
      if (offset || limit) {
        const lines = content.split("\n");
        const start = Math.max(0, (offset || 1) - 1);
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return truncate(content, 20_000);
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
      return `${existed ? "overwrote" : "created"} ${file} (${content.length} bytes)`;
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
      return `edited ${file} (${count} replacement${count > 1 ? "s" : ""})`;
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
    name: "generate_image",
    minPerm: "read",
    description:
      "Generate an image from a text prompt using the multimodal runtime slot. Returns the engine that drew it and a data: URI the chat renders inline. Write the prompt yourself — this tool does not rewrite it. Use it when the user asks for a picture, diagram, illustration, or mockup.",
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
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.generateImage) return "No multimodal runtime is attached to this run.";
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return "prompt is required.";
      const r = await ctx.generateImage({ prompt });
      // 실패는 실패라고 말한다 — 모델이 "그렸다"고 쓰지 않도록 결과 문장이 분명해야 한다.
      if (!r.ok || !r.src) return `Image generation failed: ${r.message || "no image was produced"}`;
      return JSON.stringify({ ok: true, engine: r.engine ?? "unknown", src: r.src });
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
      // ★비동기 spawn 을 쓴다. 터미널 사본은 spawnSync 였는데, 데스크탑에서 그러면
      // 명령이 끝날 때까지 **메인 프로세스 전체가 멈춘다**(UI·다른 실행·IPC 포함).
      // 최대 10분짜리 도구가 앱을 10분 얼리는 것은 도구가 아니라 결함이다.
      return await new Promise<string>((resolve, reject) => {
        const child = spawn("bash", ["-lc", command], {
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
          resolve(`${head}\n${body}`);
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

/** 이 권한에서 **존재하는** 도구들. 부족한 도구는 목록에 아예 없다. */
export function allowedBuiltinTools(
  permission: ToolPermission,
  opts: { canAskUser?: boolean; canGenerateImage?: boolean } = {},
): BuiltinTool[] {
  const rank = PERM_RANK[permission] ?? 0;
  return BUILTIN_TOOLS.filter((tool) => {
    if (PERM_RANK[tool.minPerm] > rank) return false;
    // 물을 표면이 없으면 묻는 도구도 없다 — 있는데 못 쓰는 도구는 함정이다.
    if (tool.name === "ask_user" && !opts.canAskUser) return false;
    // 멀티모달 슬롯이 비어 있으면 그리는 도구도 없다. "있는데 못 그림"은 함정이다.
    if (tool.name === "generate_image" && !opts.canGenerateImage) return false;
    return true;
  });
}

export function builtinToolByName(name: string): BuiltinTool | undefined {
  return BY_NAME.get(name);
}

/** OpenAI 함수 호출 형식. */
export function builtinToolsAsOpenAi(permission: ToolPermission, opts: { canAskUser?: boolean; canGenerateImage?: boolean } = {}): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return allowedBuiltinTools(permission, opts).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Anthropic 도구 형식. */
export function builtinToolsAsAnthropic(permission: ToolPermission, opts: { canAskUser?: boolean; canGenerateImage?: boolean } = {}): {
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
 * 도구 하나를 실행한다. 권한 부족·알 수 없는 도구·실행 오류는 **던지지 않고**
 * `ok:false` 로 돌려준다 — 모델이 그 문장을 읽고 다른 길을 찾을 수 있어야 하고,
 * 도구 실패가 실행 전체를 죽이면 안 된다.
 */
export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ ok: boolean; content: string }> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, content: `unknown tool: ${name}` };
  if (PERM_RANK[tool.minPerm] > (PERM_RANK[ctx.permission] ?? 0)) {
    return {
      ok: false,
      content: `permission denied: '${name}' requires '${tool.minPerm}' but this run has '${ctx.permission}'.`,
    };
  }
  try {
    return { ok: true, content: String(await tool.run(args ?? {}, ctx)) };
  } catch (error) {
    return { ok: false, content: `${name} error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
