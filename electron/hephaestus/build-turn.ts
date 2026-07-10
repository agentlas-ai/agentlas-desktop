/** 인터뷰 응답에는 파일 산출물이 없으므로 완료 신호가 있는 턴만 보안 스캔한다. */
export function isCompletedBuildTurn(text: unknown): boolean {
  return typeof text === "string" && /(?:^|\n)\s*BUILD_COMPLETE\s*:/i.test(text);
}
