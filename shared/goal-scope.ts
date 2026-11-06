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
  // Unknown permission: no model is ever given the run receipt, so this sentence is host-only text
  // (see isHostScopeCriterion); it is kept byte-stable so stored contracts are still recognized.
  return input.locale === "ko"
    ? `실행 영수증에 적힌 선언된 작업 폴더와 실제 부여된 권한을 확인하고, 그 경계와 원문의 명시적 제약을 기준으로 범위를 판단해야 합니다.${explicit}`
    : `Assess scope against the declared working folder and the granted permission recorded in the run receipt, together with the explicit constraints in the original request.${explicit}`;
}

type CriterionLike = string | { id?: string; text: string };
const flatText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The host's own scope sentences, produced by the same function that writes them (no copy of the wording lives
 * anywhere else). Called without `originalRequest` the sentence is exactly the fixed lead-in of any stored scope
 * criterion, whatever tail (request quote, receipt instruction) was appended later.
 */
const HOST_SCOPE_LEAD_INS: readonly string[] = (["read", "write", "full", undefined] as const).flatMap((permission) =>
  (["ko", "en"] as const).map((locale) => flatText(goalScopeCriterion({ permission, locale }))));

/**
 * True for the host-written scope criterion. Permission and working folder are enforced by the tool/runtime layer;
 * no model ever receives the run receipt, so a model can neither confirm nor refute this sentence. It is therefore
 * not something to judge, to hand to a worker, or to let block a Goal. The user's explicit constraints live in the
 * requested-outcome criterion (REQUEST: ...), which stays.
 */
export function isHostScopeCriterion(criterion: CriterionLike): boolean {
  if (typeof criterion !== "string" && criterion.id === "scope") return true;
  const text = flatText(typeof criterion === "string" ? criterion : criterion.text);
  return HOST_SCOPE_LEAD_INS.some((lead) => text.startsWith(lead));
}

/** The criteria a model may be shown or asked to judge: every criterion except the host-scope one, order kept. */
export function effectiveAcceptanceCriteria<T extends CriterionLike>(criteria: readonly T[]): T[] {
  return criteria.filter((criterion) => !isHostScopeCriterion(criterion));
}
