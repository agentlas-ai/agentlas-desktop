// Keychain 접근을 "죽일 수 있는 곳"으로 옮기는 얇은 층.
//
// ★왜 있나 (실측 2026-08-19). macOS 키체인 항목에는 그것을 만든 프로그램의 ACL 이 붙는다.
//   다른 실행 파일이 같은 항목을 읽으려 하면 OS 가 "접근을 허용하시겠습니까" 를 띄우는데,
//   **띄울 화면이 없는 호스트**(플러그인 CLI, hep-graph, cron, 데몬 없는 터미널)에서는
//   그 물음에 답할 사람이 없어 `keytar.getPassword` 가 **영영 돌아오지 않는다**.
//
//   그리고 이건 "느린 호출" 이 아니라 **이벤트 루프 정지**다. 같은 프로세스에 걸어 둔
//   `setTimeout` 조차 발화하지 않는 것을 측정했다(25s 타이머가 2분 넘게 안 돎). 그래서
//   `Promise.race([call, timeout])` 같은 자바스크립트 상한은 **원리적으로 이 상황을 못 구한다** —
//   상한을 세는 코드 자체가 같이 멈춘다.
//
//   실제 피해: 자동화 그래프의 에이전트 노드가 도구를 고르며 자격증명 유무를 확인하는데
//   (mcp-tools/auto-select → vault.readEnvVar), 그 한 번의 읽기에서 실행 전체가 멈췄다.
//   화면에는 "실행 중"만 남고, 노드 상한(1시간)이 지나야 겨우 죽는다.
//
// 그래서 답할 화면이 없는 호스트에서는 키체인 호출을 **자식 프로세스**에서 한다.
// 자식이 멈추면 부모는 멀쩡하므로 상한이 실제로 동작하고, 시간이 지나면 죽여서 회수한다.
// Electron 안(데스크탑 앱·데몬)에서는 사람이 그 물음에 답할 수 있으므로 예전처럼 직접 부른다 —
// 여기서 상한을 걸면 사용자가 프롬프트를 읽는 동안 정상 요청이 취소된다.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { runWithCredentialRecovery } from "./recovery-state";

export type KeychainCredential = { account: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

// One native request per exact operation/resource. Keep failed requests latched:
// a renderer refresh or background retry is not a new user permission decision.
// Successful reads are cached by vault; this layer only coalesces native work.
const nativeRequests = new Map<string, Promise<unknown>>();
const failedRequests = new Set<string>();

function requestKey(operation: string, service: string, account: string): string {
  return JSON.stringify([operation, service, account]);
}

function sharedNativeRequest<T>(operation: "read" | "list", service: string, account: string, run: () => Promise<T>, explicit = false): Promise<T> {
  const key = requestKey(operation, service, account);
  const current = nativeRequests.get(key);
  if (current) return current as Promise<T>;
  if (failedRequests.has(key) && !explicit) return Promise.reject(new KeychainUnavailableError(operation, account || null, "automatic retry suppressed", true));
  const started = Promise.resolve().then(() => runWithCredentialRecovery({ operation, service, account }, explicit, run));
  nativeRequests.set(key, started);
  void started.then(
    () => { failedRequests.delete(key); if (nativeRequests.get(key) === started) nativeRequests.delete(key); },
    () => {
      failedRequests.add(key);
      if (nativeRequests.get(key) === started) nativeRequests.delete(key);
    },
  );
  return started;
}

/**
 * 이 호스트가 키체인 승인 프롬프트에 답할 수 있는가 = 화면이 있는가.
 *
 * ★`process.versions.electron` 로 판정하면 안 된다. 데몬(agentlasd)은
 *   `ELECTRON_RUN_AS_NODE=1 electron …` 로 도는데(daemon/main.ts 참고), 그때도
 *   그 값은 그대로 있으면서 **창도 app 객체도 없다**. 즉 "Electron 이다" 는
 *   "물어볼 수 있다" 를 뜻하지 않는다 — 데몬이 정확히 이 착각으로 멈춘다.
 *   `process.type === "browser"` 는 GUI 메인 프로세스일 때만 참이다.
 */
export function keychainPromptsAreAnswerable(): boolean {
  return (process as NodeJS.Process & { type?: string }).type === "browser";
}

export function keychainCallTimeoutMs(): number {
  const raw = Number(process.env.AGENTLAS_KEYCHAIN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
  return DEFAULT_TIMEOUT_MS;
}

export class KeychainUnavailableError extends Error {
  readonly code = "keychain_unavailable";
  readonly account: string | null;
  readonly operation: string;
  readonly automaticRetrySuppressed: boolean;
  constructor(operation: string, account: string | null, reason: string, automaticRetrySuppressed = false) {
    super(
      `keychain_unavailable: ${operation}${account ? ` ${account}` : ""} — ${reason}. `
      + "저장소 접근을 완료하지 못했습니다. 같은 요청을 자동으로 반복하지 않습니다.",
    );
    this.name = "KeychainUnavailableError";
    this.account = account;
    this.operation = operation;
    this.automaticRetrySuppressed = automaticRetrySuppressed;
  }
}

/**
 * 자식에게 넘길 keytar 의 **실물 경로**.
 *
 * ★내 옆에서만 찾으면 안 된다. 실측 2026-08-20: 터미널이 내려받아 쓰는 벤더 코어에는
 *   keytar 가 **일부러 빠져 있다**(네이티브 ABI 라 호스트가 자기 것을 갖는다 —
 *   vendor-desktop-core.cjs 의 skip 목록). 그 트리 안에서 도는 이 파일이
 *   `createRequire(__filename).resolve("keytar")` 를 부르면 던지고, 그 예외가
 *   `Cannot find module 'keytar'` 로 새어 나가 **그래프 노드를 죽였다**.
 *   호스트의 모듈 훅은 `require` 를 가로채지만 `resolve` 는 가로채지 않으므로,
 *   호스트가 자기 경로를 이 봉투(AGENTLAS_KEYTAR_PATH)에 담아 알려 준다.
 *
 * 찾지 못하는 것은 오류가 아니라 **사실**이다 — 그때는 keychain_unavailable 로
 * 말하고, 부르는 쪽이 비밀 없이 갈 수 있으면 가게 둔다.
 */
function resolveKeytarPath(): string | null {
  const declared = String(process.env.AGENTLAS_KEYTAR_PATH || "").trim();
  if (declared) {
    try {
      return createRequire(__filename).resolve(declared);
    } catch {
      /* 봉투가 낡았을 수 있다 — 아래 기본 해석으로 넘어간다 */
    }
  }
  try {
    return createRequire(__filename).resolve("keytar");
  } catch {
    return null;
  }
}

/**
 * 자식 프로세스 한 번. 비밀 값은 **stdin 으로만** 넘긴다 —
 * argv 는 같은 사용자의 `ps` 에 그대로 보이므로 저장할 값을 실을 수 없다.
 * 읽은 값은 stdout(파이프)으로만 돌아온다.
 */
function runKeychainChild(
  op: "get" | "set" | "delete" | "find",
  service: string,
  account: string,
  stdinValue: string | null,
): Promise<{ value?: string | null; accounts?: string[]; error?: string }> {
  const keytarPath = resolveKeytarPath();
  if (!keytarPath) {
    return Promise.resolve({
      error: "keytar 모듈을 찾을 수 없습니다(이 호스트에 키체인 백엔드가 없음)",
    });
  }
  const script = `
const [modPath, op, service, account] = process.argv.slice(1);
const keytar = require(modPath);
let stdin = "";
const done = (payload) => { process.stdout.write(JSON.stringify(payload)); process.exit(0); };
const fail = (e) => done({ error: e && e.message ? e.message : String(e) });
const go = async () => {
  if (op === "get") return done({ value: await keytar.getPassword(service, account) });
  if (op === "set") { await keytar.setPassword(service, account, stdin); return done({ ok: true }); }
  if (op === "delete") { await keytar.deletePassword(service, account); return done({ ok: true }); }
  if (op === "find") {
    const rows = await keytar.findCredentials(service);
    return done({ accounts: rows.map((r) => r.account) });
  }
  return fail(new Error("unknown op"));
};
process.stdin.on("data", (c) => { stdin += c.toString("utf8"); });
process.stdin.on("end", () => { go().catch(fail); });
`;
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["-e", script, keytarPath, op, service, account],
      { timeout: keychainCallTimeoutMs(), killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ error: error.killed ? "timed out" : (error.message || "child failed") });
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || "{}")));
        } catch {
          resolve({ error: "child returned unreadable output" });
        }
      },
    );
    child.stdin?.end(stdinValue ?? "");
  });
}

/** Missing credentials return null; failed native access remains unavailable.
 * A timeout or rejection is not evidence that the credential does not exist.
 */
export async function keychainGet(
  service: string,
  account: string,
  direct: () => Promise<string | null>,
  explicit = false,
): Promise<string | null> {
  return sharedNativeRequest("read", service, account, async () => {
    if (keychainPromptsAreAnswerable()) {
      try { return await direct(); }
      catch { throw new KeychainUnavailableError("read", account, "native request rejected"); }
    }
    const result = await runKeychainChild("get", service, account, null);
    if (result.error) throw new KeychainUnavailableError("read", account, result.error);
    return result.value ?? null;
  }, explicit);
}

/** Call only from a deliberate user retry for this exact credential. Passive
 * discovery, polling and startup recovery must keep using keychainGet.
 */
export function retryKeychainReadFromUser(
  service: string,
  account: string,
  direct: () => Promise<string | null>,
): Promise<string | null> {
  return keychainGet(service, account, direct, true);
}

/** 쓰기·삭제는 실패를 삼키지 않는다 — 저장했다고 착각하는 쪽이 더 나쁘다. */
export async function keychainSet(
  service: string,
  account: string,
  value: string,
  direct: () => Promise<void>,
): Promise<void> {
  await runWithCredentialRecovery({ operation: "read", service, account }, true, async () => {
    if (keychainPromptsAreAnswerable()) await direct();
    else {
      const result = await runKeychainChild("set", service, account, value);
      if (result.error) throw new KeychainUnavailableError("write", account, result.error);
    }
  });
  failedRequests.delete(requestKey("read", service, account));
}

export async function keychainDelete(
  service: string,
  account: string,
  direct: () => Promise<void>,
): Promise<void> {
  await runWithCredentialRecovery({ operation: "read", service, account }, true, async () => {
    if (keychainPromptsAreAnswerable()) await direct();
    else {
      const result = await runKeychainChild("delete", service, account, null);
      if (result.error) throw new KeychainUnavailableError("delete", account, result.error);
    }
  });
  failedRequests.delete(requestKey("read", service, account));
}

/** 계정 목록. 비밀 값은 자식이 아예 돌려주지 않는다 — 필요한 건 이름뿐이다. */
export async function keychainListAccounts(
  service: string,
  direct: () => Promise<string[]>,
  explicit = false,
): Promise<string[]> {
  return sharedNativeRequest("list", service, "", async () => {
    if (keychainPromptsAreAnswerable()) {
      try { return await direct(); }
      catch { throw new KeychainUnavailableError("list", null, "native request rejected"); }
    }
    const result = await runKeychainChild("find", service, "", null);
    if (result.error) throw new KeychainUnavailableError("list", null, result.error);
    return result.accounts ?? [];
  }, explicit);
}

/** Explicit retry of the list operation only; credential read latches remain. */
export function retryKeychainListFromUser(service: string, direct: () => Promise<string[]>): Promise<string[]> {
  return keychainListAccounts(service, direct, true);
}
