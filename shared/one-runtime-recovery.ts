export type OneRuntimeRecoveryCode =
  | "one-runtime-auth-required"
  | "one-runtime-unavailable";

export function classifyOneRuntimeFailure(error: unknown): OneRuntimeRecoveryCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/signed out|not logged in|not authenticated|unauthenticated|(login|log in|sign in|auth|oauth|credential|token|session).*(expired|invalid|required|missing|failed)|로그인.*(만료|필요|실패|되어 있지)|인증.*(만료|필요|실패)/iu.test(normalized)) {
    return "one-runtime-auth-required";
  }
  if (/(no active runner|runner unavailable|runtime unavailable|runtime disconnected|no runtime|llm.*(unavailable|disconnected)|실행 연결.*(없|끊)|llm.*(연결|사용).*(없|불가))/iu.test(normalized)) {
    return "one-runtime-unavailable";
  }
  return null;
}
