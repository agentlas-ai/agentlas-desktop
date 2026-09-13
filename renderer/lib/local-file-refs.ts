/*
 * 공백이 든 절대 경로를 하나의 파일 참조로 잡는다.
 *
 * 왜: 결과 레일의 "답변이 언급한 파일" 스캐너는 낱말 경계(공백)에서 경로를 끊는다. 그래서
 * `/Users/x/Library/Application Support/Agentlas/…/hello.txt` 는 `Support/Agentlas/…/hello.txt` 라는
 * **상대** 참조로 읽혔고, 그것을 작업 폴더에 다시 붙여 "…/projects/<id>/Support/Agentlas/…/hello.txt" —
 * 존재하지 않는 경로 — 를 "있던 자리에 없습니다" 로 그렸다(프로덕션 1.2.0 실측 2026-09-13).
 * Work 가 새 프로젝트에 쓰는 기본 폴더가 바로 `Application Support` 아래라 모든 새 사용자가 맞는 자리다.
 *
 * 규칙: 디렉터리 조각(슬래시로 끝나는 부분)에만 한 칸 공백을 허용하고, 파일 이름 조각에는 허용하지 않는다.
 * 그래야 "/tmp/dir we made b.txt" 같은 문장을 통째로 경로로 오독하지 않는다. 공백이 든 조각이 하나도
 * 없으면 여기서 잡지 않는다 — 그 경우는 기존 스캐너가 이미 옳게 읽는다.
 */
export const LOCAL_FILE_EXTENSIONS =
  "png|jpe?g|gif|webp|avif|svg|pdf|html?|mdx?|jsonl?|txt|csv|tsv|docx?|xlsx?|pptx?|zip|mp4|webm|mov|m4v|ogv|mp3|wav|rtf|pages";

const SEG = "[^\\s\\/`'\"<>)]+";
const SPACED_SEG = `${SEG}(?: ${SEG})+`;
const ABSOLUTE_WITH_SPACES = new RegExp(
  `(?:^|[\\s(\`])((?:file:\\/\\/)?\\/(?:${SEG}\\/)*(?:${SPACED_SEG}\\/)(?:${SEG}(?: ${SEG})*\\/)*[^\\s\\/\`'"<>)]*?\\.(?:${LOCAL_FILE_EXTENSIONS}))(?=$|[\\s\`).,;:])`,
  "gi",
);

export interface AbsoluteFileRefSpan {
  ref: string;
  start: number;
  end: number;
}

/** 공백이 든 절대 파일 경로 참조와 그 위치. 위치는 뒤이은 낱말 단위 스캔에서 가려 두는 데 쓴다. */
export function absoluteFileRefsWithSpaces(text: string): AbsoluteFileRefSpan[] {
  const out: AbsoluteFileRefSpan[] = [];
  for (const match of text.matchAll(ABSOLUTE_WITH_SPACES)) {
    const ref = match[1];
    if (!ref) continue;
    const start = (match.index ?? 0) + match[0].indexOf(ref);
    out.push({ ref, start, end: start + ref.length });
  }
  return out;
}

/** 잡힌 구간을 같은 길이의 공백으로 가린 본문 — 낱말 단위 스캐너가 꼬리를 다시 잡지 못하게. */
export function maskSpans(text: string, spans: readonly AbsoluteFileRefSpan[]): string {
  if (spans.length === 0) return text;
  let masked = text;
  for (const span of spans) masked = masked.slice(0, span.start) + " ".repeat(span.end - span.start) + masked.slice(span.end);
  return masked;
}
