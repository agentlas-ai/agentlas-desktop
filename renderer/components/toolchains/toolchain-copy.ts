// Toolchain wording for the One rail (OneToolchains). A Toolchain is an MCP tool for an app or web page
// the agents used to operate by hand; the rail only names where each one stands.

export type ToolchainCopy = ReturnType<typeof toolchainCopy>;

export function toolchainCopy(locale: string) {
  const ko = locale === "ko";
  return {
    title: ko ? "툴체인" : "Toolchains",
    unavailable: ko ? "이 화면에서는 툴체인을 불러올 수 없습니다." : "Toolchains are unavailable here.",
    viewAll: ko ? "전체 보기" : "View all",
    failed: ko ? "처리하지 못했습니다" : "Could not complete",
    errors: {
      no_isolated_runtime: ko
        ? "도구 없이 시험할 수 있는 모델이 연결돼 있지 않습니다. 시험 요청에 '게시해 줘' 같은 문장이 섞이므로 도구가 꺼진 모델(Claude 등)이 필요합니다."
        : "No model that can run with tools disabled is connected. Test requests include phrases like \"post this\", so a tool-free model (e.g. Claude) is required.",
      cold_start_unavailable: ko ? "시험용 모델 호출이 실패했습니다. 잠시 뒤 다시 시도하세요." : "The test model call failed. Try again shortly.",
      unreadable: ko ? "시험 모델의 답을 읽지 못했습니다. 다시 시도하세요." : "Could not read the test model's answer. Try again.",
    },
  };
}

/** Main refusals carry a machine code; say what it means, never the code. */
export function toolchainErrorText(error: unknown, copy: ToolchainCopy): string {
  const message = String(error instanceof Error ? error.message : error ?? "");
  if (/no_isolated_runtime/.test(message)) return copy.errors.no_isolated_runtime;
  if (/toolchain_cold_start_unavailable/.test(message)) return copy.errors.cold_start_unavailable;
  if (/toolchain_cold_start_(?:generation|selection)_unreadable/.test(message)) return copy.errors.unreadable;
  return copy.failed;
}
