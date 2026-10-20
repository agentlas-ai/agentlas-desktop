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
  /** Resume after the last complete line, even inside a long unfinished fence. */
  scanStart?: number;
  fence?: { marker: string; length: number } | null;
}

export function splitStreamingSegments(
  text: string,
  cache: SegmentCache | null,
): { segments: string[]; cache: SegmentCache } {
  let closed: string[];
  let segStart: number;
  const appendOnly = cache && text.length >= cache.source.length && text.startsWith(cache.source);
  if (appendOnly) {
    closed = cache.closed;
    segStart = cache.tailStart;
  } else {
    closed = [];
    segStart = 0;
  }
  // tail 구간만 라인 단위 스캔 — 펜스 밖의 빈 줄에서 자른다. 마지막 미완 라인은 판단 보류.
  let appended: string[] | null = null;
  // A blank-line segment can remain open for thousands of lines (code, tables,
  // lists, visual JSON). Previously every token rescanned all those lines from
  // tailStart. Keep the scanner's fence state and resume at the incomplete line.
  // Older in-memory caches have no cursor and safely take the original scan.
  let fence = appendOnly && cache.scanStart != null ? cache.fence ?? null : null;
  let lineStart = appendOnly && cache.scanStart != null ? cache.scanStart : segStart;
  // There was no newline in the previous unfinished line. Search only the
  // appended suffix; a single very long JSON/code line must not be searched
  // from its beginning for every chunk. Parse the full line once it completes.
  let searchStart = appendOnly && cache.scanStart != null ? cache.source.length : lineStart;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", searchStart);
    if (nl < 0) break;
    const line = text.slice(lineStart, nl);
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceLine && !fence) {
      fence = { marker: fenceLine[1][0], length: fenceLine[1].length };
    } else if (fenceLine && fence && fenceLine[1][0] === fence.marker
      && fenceLine[1].length >= fence.length && !fenceLine[2].trim()) {
      fence = null;
    } else if (!fence && line.trim() === "") {
      const seg = text.slice(segStart, nl + 1);
      if (seg.trim() !== "") {
        if (!appended) appended = [];
        appended.push(seg);
        segStart = nl + 1;
      }
    }
    lineStart = nl + 1;
    searchStart = lineStart;
  }
  const nextClosed = appended ? closed.concat(appended) : closed;
  const tail = text.slice(segStart);
  const segments = tail.trim() !== "" ? nextClosed.concat(tail) : nextClosed.slice();
  return { segments, cache: { source: text, closed: nextClosed, tailStart: segStart, scanStart: lineStart, fence } };
}

/** A tool row can never split the data inside a code or native UI fence. */
export function snapMarkdownAnchor(text: string, raw: number): number {
  let anchor = Math.min(Math.max(raw, 0), text.length);
  if (anchor !== 0 && anchor !== text.length && text[anchor - 1] !== "\n" && text[anchor] !== "\n") {
    const newline = text.indexOf("\n", anchor);
    anchor = newline < 0 ? text.length : newline + 1;
  }
  let fence: { marker: string; length: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const next = newline < 0 ? text.length : newline + 1;
    const line = text.slice(lineStart, newline < 0 ? text.length : newline);
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (match && !fence && lineStart < anchor) {
      fence = { marker: match[1][0], length: match[1].length, start: lineStart };
    } else if (match && fence && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
      if (lineStart >= anchor) return next;
      fence = null;
    }
    if (next >= anchor && !fence) return anchor;
    if (newline < 0) break;
    lineStart = next;
  }
  return fence ? fence.start : anchor;
}
