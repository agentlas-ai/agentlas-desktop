/**
 * Why a text preview came back empty, said out loud.
 *
 * The reader has always known the reason and passed it up. Both result rails threw it away and
 * printed one sentence — "The file content is unavailable." — for a missing file, a binary file, an
 * unrecognised extension, and a file that is simply empty. A person watching a run finish and then
 * being told the output cannot be read, with no cause and nothing to do, reasonably concludes the
 * product is broken.
 *
 * An empty file is not a failure and must not be dressed as one.
 */
/*
 * ★"아직 안 읽었다"는 판정이 아니라 상태다.
 *
 * 결과 패널은 미디어·링크 파일의 자리표시로 reason:"binary" 를 쓰고 있었다. 예전엔 그것이
 * "내용을 읽을 수 없습니다"라는 애매한 한 문장으로 흡수돼 티가 안 났는데, 사유별 문장을
 * 만들자 순수 UTF-8 한글 텍스트 파일을 "글자가 아닌 파일"이라고 **단정**하게 됐다.
 * 애매한 문장이 확실하게 틀린 문장이 된 것이다(QA 실측 2026-09-07, note.txt 7바이트).
 * 자리표시에는 자리표시의 이름을 준다.
 */
export type FilePreviewReason = "binary" | "too-large" | "not-text-ext" | "missing" | "not-a-file" | "not-read";

export function filePreviewEmptyMessage(
  reason: FilePreviewReason | undefined,
  locale: string,
  name?: string,
  /** 같은 이름의 파일이 여러 개일 때 어느 것인지 못 가리던 결함 — 경로가 있으면 함께 말한다. */
  fullPath?: string,
): string {
  const ko = locale === "ko";
  const shown = fullPath && fullPath !== name ? `${name ?? fullPath} (${fullPath})` : name;
  const subject = shown ? `"${shown}"` : ko ? "이 파일" : "this file";
  switch (reason) {
    case "missing":
      return ko
        ? `${subject}이(가) 있던 자리에 없습니다. 실행이 끝난 뒤 옮겨지거나 지워졌을 수 있습니다.`
        : `${subject} is no longer where it was recorded. It may have been moved or removed after the run finished.`;
    case "not-a-file":
      return ko
        ? `${subject}은(는) 일반 파일이 아니라 폴더이거나 바로가기입니다.`
        : `${subject} is not a regular file — it is a directory or a link.`;
    case "not-read":
      return ko
        ? `${subject}의 내용은 아직 읽지 않았습니다. 외부 앱으로 열어 보세요.`
        : `${subject} has not been read here. Open it in an external application.`;
    case "binary":
      return ko
        ? `${subject}은(는) 글자가 아닌 파일이라 여기서는 못 보여 줍니다. 외부 앱으로 열어 보세요.`
        : `${subject} is not text, so it cannot be shown here. Open it in an external application.`;
    case "not-text-ext":
      return ko
        ? `${subject}의 형식은 미리보기가 지원되지 않습니다. 외부 앱으로 열어 보세요.`
        : `${subject} has a format this preview does not support. Open it in an external application.`;
    case "too-large":
      return ko
        ? `${subject}이(가) 미리보기 한도보다 커서 앞부분만 읽었습니다.`
        : `${subject} is larger than the preview limit, so only the beginning was read.`;
    default:
      // No reason and no content means the file really is empty. Say that plainly rather than
      // implying a failure.
      return ko ? `${subject}은(는) 비어 있습니다.` : `${subject} is empty.`;
  }
}
