import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * 첫 페어링을 중계로 받는 프레임 규약 (2026-09-13).
 *
 * ★ 왜 있는가
 *   첫 페어링은 폰이 QR 의 LAN 주소로 직접 요청해야만 됐다. 폰이 다른 와이파이·LTE 에
 *   있으면 그 한 번을 영영 못 넘었다(실사고 2026-09-13). 이제 LAN 이 안 닿으면 같은 요청을
 *   우리 중계로 보낸다.
 *
 * ★ 중계가 내용을 못 바꾸는 이유
 *   폰과 데스크탑만 아는 값은 QR 코드다. 데스크탑 메모리엔 그 SHA-256 만 남으므로 서명 키는
 *   sha256(code) 이고, 폰은 코드를 요청에서 **빼고** 보낸다. 중계는 키를 모르므로 요청도
 *   응답도 위조할 수 없다. 응답 서명에는 요청 서명이 섞여 있어 다른 요청의 응답을 끼워 넣지도
 *   못한다.
 *
 * ★ 이 규약은 폰 앱(Dart)에 한 벌 더 있다
 *   mobile/app/lib/core/transport/relay_pairing.dart. 문자열 하나라도 다르면 서명이 안 맞는다.
 */

export const RELAY_PAIR_REQUEST_TYPE = "pair.relay.request";
export const RELAY_PAIR_RESPONSE_TYPE = "pair.relay.response";
export const RELAY_PAIR_REFUSED_TYPE = "pair.relay.refused";
const REQUEST_LABEL = "agentlas.pair.relay.request.v1";
const RESPONSE_LABEL = "agentlas.pair.relay.response.v1";
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 16 * 1024;

/**
 * 폰이 코드를 뺀 채 보내므로 파서의 형식 검사를 통과시킬 자리표시. 실제 대조는
 * pairing.exchange 가 서명에 쓴 코드 해시로 한다 — 이 값은 어디에도 대조되지 않는다.
 */
export const RELAY_PAIR_CODE_PLACEHOLDER = "relay_signed_code_0000";

export function relayPairRequestMac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(`${REQUEST_LABEL}\n${body}`, "utf8").digest("base64url");
}

export function relayPairResponseMac(key: Buffer, requestMac: string, status: number, body: string): string {
  return createHmac("sha256", key)
    .update(`${RESPONSE_LABEL}\n${requestMac}\n${status}\n${body}`, "utf8")
    .digest("base64url");
}

export function relayPairMacMatches(expected: string, actual: string): boolean {
  if (!MAC_PATTERN.test(actual)) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RelayPairRequestFrame {
  body: string;
  mac: string;
}

export function parseRelayPairRequestFrame(text: string): RelayPairRequestFrame | null {
  if (Buffer.byteLength(text) > MAX_BODY_BYTES * 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;
  const keys = Object.keys(frame).sort().join(",");
  if (keys !== "body,mac,type,v") return null;
  if (frame.type !== RELAY_PAIR_REQUEST_TYPE || frame.v !== 1) return null;
  if (typeof frame.body !== "string" || Buffer.byteLength(frame.body) > MAX_BODY_BYTES) return null;
  if (typeof frame.mac !== "string" || !MAC_PATTERN.test(frame.mac)) return null;
  return { body: frame.body, mac: frame.mac };
}

export function relayPairRefusedFrame(code: "pairing_unavailable" | "pairing_denied" | "invalid_pairing_request"): string {
  return JSON.stringify({ type: RELAY_PAIR_REFUSED_TYPE, v: 1, code });
}

export function relayPairResponseFrame(key: Buffer, requestMac: string, status: number, body: string): string {
  return JSON.stringify({
    type: RELAY_PAIR_RESPONSE_TYPE,
    v: 1,
    status,
    body,
    mac: relayPairResponseMac(key, requestMac, status, body),
  });
}
