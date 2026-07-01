// 인바운드 webhook 트리거 서버(설계 §3.4 Tier 2) — 로컬 HTTP 리스너 하나로 모든 webhook
// 트리거를 받는다(자동화당 소켓 X, 설계 §3.3 "webhook은 소켓 1개 공유"). auth.ts:282의
// http.createServer 로컬 리스너 선례를 그대로 따른다.
//
// 라우팅: POST http://127.0.0.1:<port>/webhook/<token> → token으로 자동화를 찾아 fire.
// per-automation 토큰이 인증을 대신한다(추측 불가한 랜덤 토큰 = capability URL).
//
// ⚠️ 한계(설계 §6 열린질문 #1): 데스크톱은 공인 URL이 없다. 이 리스너는 127.0.0.1에만
//    바인딩되므로 외부(GitHub/Stripe 등)가 직접 때릴 수 없다. 실사용하려면 터널(ngrok류)이나
//    Hub 릴레이가 필요하다 — 별도 스코프. 지금은 로컬 통합/테스트/같은 머신의 프로세스 전용.
//    TODO(P2+): 터널/릴레이 연동 — 공인 endpoint를 받아 이 로컬 포트로 포워딩하거나,
//               Hub가 webhook을 대신 받아 데스크톱으로 push(백엔드 작업 필요).
import http from "node:http";
import type { Automation } from "../../shared/types";
import { listEnabledByTrigger } from "../store/automations";
import { evaluateCondition } from "./condition";

let server: http.Server | null = null;
let boundPort = 0;

/** webhook 발사 시 호출할 실행 함수(트리거 매니저가 주입). */
type RunFn = (automationId: string, ctx?: { output?: string }) => Promise<void>;
let runFn: RunFn | null = null;

/** token → enabled webhook 자동화 조회(요청마다 최신 상태 반영). */
function findByToken(token: string): Automation | null {
  if (!token) return null;
  const autos = listEnabledByTrigger("webhook");
  for (const a of autos) {
    if (a.trigger && a.trigger.kind === "webhook" && a.trigger.token === token) return a;
  }
  return null;
}

/** 요청 본문을 최대 크기까지 읽어 문자열로. 과도한 본문은 잘라 폭주 방지. */
function readBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total <= maxBytes) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * webhook 리스너 기동 — 이미 떠 있으면 재사용(포트 유지). 127.0.0.1의 임의 포트에 바인딩한다.
 * @returns 바인딩된 포트(0이면 실패).
 */
export function startWebhookServer(run: RunFn): Promise<number> {
  runFn = run;
  if (server && boundPort) return Promise.resolve(boundPort);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      // 경로: /webhook/<token>. POST만 허용.
      const match = /^\/webhook\/([A-Za-z0-9._-]+)\/?$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
        return;
      }
      const token = match[1];
      const automation = findByToken(token);
      if (!automation) {
        // 토큰 미매치 — 존재/비존재를 구분 노출하지 않도록 동일 404.
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      void readBody(req).then((body) => {
        // onlyIf 게이트 1회 평가(설계 §3.4). body 전체를 {{body}}로 노출.
        const cond = automation.trigger && "onlyIf" in automation.trigger ? automation.trigger.onlyIf : undefined;
        const vars = { body, output: body };
        if (!evaluateCondition(cond, vars)) {
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"fired":false}');
          return;
        }
        if (runFn) {
          void runFn(automation.id, { output: body }).catch(() => {
            /* 실행 오류는 스케줄러가 run_history에 기록 */
          });
        }
        res.writeHead(202, { "content-type": "application/json" }).end('{"ok":true,"fired":true}');
      });
    });

    srv.on("error", () => {
      server = null;
      boundPort = 0;
      resolve(0);
    });

    // 0 = OS가 빈 포트 배정. 127.0.0.1 전용 바인딩(외부 노출 없음 — 위 ⚠️ 참고).
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      boundPort = typeof addr === "object" && addr ? addr.port : 0;
      server = srv;
      resolve(boundPort);
    });
  });
}

/** 현재 리스너의 로컬 base URL(디버그/설정 표시용). 미기동이면 null. */
export function webhookBaseUrl(): string | null {
  return boundPort ? `http://127.0.0.1:${boundPort}` : null;
}

/** 특정 자동화의 webhook 수신 URL(로컬). 사용자가 소스에 등록할 capability URL(로컬 한정). */
export function webhookUrlFor(token: string): string | null {
  return boundPort ? `http://127.0.0.1:${boundPort}/webhook/${token}` : null;
}

/** 리스너 정지(앱 종료/테스트). */
export function stopWebhookServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
    boundPort = 0;
  }
  runFn = null;
}
