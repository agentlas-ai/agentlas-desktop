/**
 * The one-runtime "did not answer" header of a finished recovery walk (mcp/client.ts, code runtime-recovery-exhausted). It names the typed
 * cause the runtime stopped with, so the header and the body line under it (shared/owner-failure-class.ts waitingOwnerLine: "사용 한도")
 * say the same thing; only a cause the walk could not type falls back to "a problem on the provider's side".
 */
export type RuntimeStopKind = "quota" | "rate_limit" | "auth" | "refused" | "empty" | "exit" | "timeout" | "unavailable" | "unsupported";

export function runtimeStoppedLine(input: { kind: RuntimeStopKind | string; name: string; ownMachine: boolean; attempts: number; locale: "ko" | "en" }): string {
  const { kind, name, ownMachine, attempts } = input;
  const ko = input.locale === "ko";
  const more = ko ? " 자세한 원인은 자세히에서 볼 수 있어요." : " The details hold the cause.";
  // The usage limit and the request limit are the person's account with that provider, not an outage on its side.
  if (kind === "quota") return ko ? `${name}의 사용 한도에 걸려 답을 받지 못했습니다.${more}` : `${name} hit its usage limit and did not answer.${more}`;
  if (kind === "rate_limit") return ko ? `${name}의 요청 제한에 걸려 답을 받지 못했습니다.${more}` : `${name} hit its request limit and did not answer.${more}`;
  return ko
    ? `${name} ${ownMachine ? "모델이" : "쪽 문제로"} ${attempts}번 시도했지만 답을 받지 못했습니다.${more}`
    : `${name} did not answer after ${attempts} attempt${attempts === 1 ? "" : "s"}${ownMachine ? "" : " (a provider-side problem)"}.${more}`;
}
