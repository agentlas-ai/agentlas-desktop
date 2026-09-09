/**
 * Build the scope portion of an automatic Goal contract from facts already
 * carried by the host. This is descriptive text only: it never grants or
 * changes tool permissions.
 */
export function goalScopeCriterion(input: {
  permission?: "read" | "write" | "full";
  originalRequest?: string;
  locale: "ko" | "en";
}): string {
  // A restriction at the end of the request is just as binding as one at the start.
  const request = input.originalRequest?.replace(/\s+/g, " ").trim();
  const explicit = request
    ? input.locale === "ko"
      ? ` 원문의 명시적 제약은 다음 요청에 그대로 적용됩니다: ${JSON.stringify(request)}`
      : ` Explicit constraints remain those stated in the original request: ${JSON.stringify(request)}`
    : "";
  if (input.permission === "read") {
    return input.locale === "ko"
      ? `읽기 권한으로 실행되므로 파일을 만들거나 고치지 않아야 합니다.${explicit}`
      : `This run has read permission, so it must not create or modify files.${explicit}`;
  }
  if (input.permission === "write") {
    return input.locale === "ko"
      ? `쓰기 권한으로 실행되며 선언된 작업 폴더 안에서 변경해야 합니다.${explicit}`
      : `This run has write permission and changes must stay within the declared working folder.${explicit}`;
  }
  if (input.permission === "full") {
    return input.locale === "ko"
      ? `전체 권한으로 실행되며 전체 권한 자체로 작업 폴더 경계를 추가하지 않습니다.${explicit}`
      : `This run has full permission; full permission itself does not add a working-folder boundary.${explicit}`;
  }
  return input.locale === "ko"
    ? `실행 영수증의 실제 권한과 원문의 명시적 제약을 기준으로 범위를 확인해야 합니다.${explicit}`
    : `Assess scope from the actual permission in the run receipt and the explicit constraints in the original request.${explicit}`;
}
