/**
 * 커넥터 C47 — 코드에서 그래프를 켠다.
 *
 * 이 패키지가 하는 일은 **문을 두드리는 것뿐**이다. "켜도 되는가"의 판단은 제품 안의
 * 한 곳(shared/graph-run-request.ts)이 하고, 여기는 그 판단을 그대로 받아 돌려준다.
 * 판단을 여기서 다시 하면 같은 그래프가 부르는 쪽에 따라 다르게 돈다 — 이 커넥터가
 * 없애려는 상태가 정확히 그것이다.
 *
 * 전송은 stdio다. Agentlas 실행 파일을 `--graph-surface`로 띄워 줄 단위 JSON을 주고받는다.
 * 포트도, 토큰도, 네트워크도 없다.
 *
 * ★아직 npm에 올리지 않았다. 배포는 별건의 결정이고, 올리지 않은 것을 올렸다고 적지 않는다.
 *   지금은 이 저장소 안에서 경로로 불러 쓴다.
 *
 *   import { openGraphSurface } from "./packages/graph-sdk/index.mjs";
 *   const surface = openGraphSurface({ binary: "/Applications/Agentlas.app/Contents/MacOS/Agentlas" });
 *   const graphs = await surface.listGraphs();
 *   const started = await surface.runGraph("아침 요약", { topic: "환율" });
 *   await surface.close();
 */
import { spawn } from "node:child_process";

/**
 * 커넥터 C39 — 이 SDK가 말하는 판. Agentlas와 major가 다르면 **시작하지 않는다**.
 * 조용히 진행하면 부른 쪽은 모르는 모양의 답을 받고 자기 코드가 고장 난 줄 안다.
 */
export const GRAPH_WIRE = "graph/1";

/** 거절은 던지지 않는다 — 코드·사유·행동을 그대로 돌려준다. 던지면 사유가 스택으로 뭉개진다. */
export class GraphSurfaceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphSurfaceUnavailableError";
  }
}

export function openGraphSurface(options = {}) {
  const binary = options.binary ?? process.env.AGENTLAS_BINARY;
  if (!binary) {
    throw new GraphSurfaceUnavailableError(
      "Agentlas 실행 파일 경로가 필요합니다. binary 옵션이나 AGENTLAS_BINARY 환경변수로 알려 주세요.",
    );
  }
  const child = spawn(binary, ["--graph-surface"], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  let closedReason = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const settle = pending.get(message.id);
      if (!settle) continue;
      pending.delete(message.id);
      settle(message);
    }
  });
  const fail = (reason) => {
    closedReason = reason;
    for (const [, settle] of pending) settle({ error: { message: reason } });
    pending.clear();
  };
  child.on("error", (err) => fail(err.message));
  child.on("exit", (code) => fail(`그래프 표면이 종료되었습니다 (code ${code}).`));

  const call = (method, params) => new Promise((resolve, reject) => {
    if (closedReason) { reject(new GraphSurfaceUnavailableError(closedReason)); return; }
    const id = ++nextId;
    pending.set(id, (message) => {
      if (message.error) reject(new GraphSurfaceUnavailableError(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  let handshaked = false;
  const handshake = async () => {
    if (handshaked) return;
    // major가 다르면 서버가 SCHEMA_UNSUPPORTED_MAJOR로 거절하고, 그 사유가 그대로 올라온다.
    await call("initialize", { wire: GRAPH_WIRE });
    handshaked = true;
  };

  const readContent = (result) => {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new GraphSurfaceUnavailableError("그래프 표면이 읽을 수 있는 응답을 주지 않았습니다.");
    }
    return JSON.parse(text);
  };

  return {
    /** 부를 수 있는 그래프 목록. 꺼진 것도 함께 온다. */
    async listGraphs() {
      await handshake();
      return readContent(await call("tools/call", { name: "agentlas_list_graphs", arguments: {} }));
    },
    /**
     * 그래프 하나를 실행 요청한다. 돌아오는 것은 **접수 여부**다 — 실행 자체는 Agentlas가 한다.
     * 켤 수 없으면 `{ ok: false, code, reason, nextAction }`이 그대로 온다.
     */
    async runGraph(ref, input, opts = {}) {
      await handshake();
      return readContent(await call("tools/call", {
        name: "agentlas_run_graph",
        arguments: { ref, ...(input ? { input } : {}), ...(opts.dryRun ? { dryRun: true } : {}) },
      }));
    },
    async close() {
      child.stdin.end();
      child.kill();
    },
  };
}
