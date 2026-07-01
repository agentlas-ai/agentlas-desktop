// 스트리밍 마크다운 세그먼트 분할 — 빈 줄 경계(펜스 코드블록 밖)에서 완결 세그먼트를 잘라
// 캐시에 고정한다. 스트리밍 중 매 partial마다 누적 전문을 처음부터 재파싱하는 대신,
// 완결 세그먼트는 React.memo로 재사용하고 마지막(미완결) 세그먼트만 재파싱하게 하는 기반.
// append-only 스트림을 가정하고, 아니면(리셋/재동기화) 전체를 재계산한다. 순수 함수 — 테스트 가능.

export interface SegmentCache {
  /** 캐시가 계산된 시점의 전체 텍스트 — startsWith로 append-only 검증. */
  source: string;
  /** 완결(불변) 세그먼트들. */
  closed: string[];
  /** 미완결 tail의 시작 오프셋. 이 지점의 펜스 상태는 항상 "밖"이다. */
  tailStart: number;
}

export function splitStreamingSegments(
  text: string,
  cache: SegmentCache | null,
): { segments: string[]; cache: SegmentCache } {
  let closed: string[];
  let segStart: number;
  if (cache && text.length >= cache.source.length && text.startsWith(cache.source)) {
    closed = cache.closed;
    segStart = cache.tailStart;
  } else {
    closed = [];
    segStart = 0;
  }
  // tail 구간만 라인 단위 스캔 — 펜스 밖의 빈 줄에서 자른다. 마지막 미완 라인은 판단 보류.
  let appended: string[] | null = null;
  let inFence = false;
  let lineStart = segStart;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    if (nl < 0) break;
    const line = text.slice(lineStart, nl);
    if (line.startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && line.trim() === "") {
      const seg = text.slice(segStart, nl + 1);
      if (seg.trim() !== "") {
        if (!appended) appended = [];
        appended.push(seg);
        segStart = nl + 1;
      }
    }
    lineStart = nl + 1;
  }
  const nextClosed = appended ? closed.concat(appended) : closed;
  const tail = text.slice(segStart);
  const segments = tail.trim() !== "" ? nextClosed.concat(tail) : nextClosed.slice();
  return { segments, cache: { source: text, closed: nextClosed, tailStart: segStart } };
}
