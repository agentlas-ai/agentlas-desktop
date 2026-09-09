"use client";

/** Historical host request, not a projection of the invocation's current state.
 * Keep the original text in the message ledger; internal resume instructions
 * and verifier payloads are not user-facing task instructions.
 */
export function HostContinuationNotice({ locale }: { text: string; locale: "ko" | "en" }) {
  return <p
    data-host-notice="goal-continuation"
    role="status"
    style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}
  >{locale === "ko" ? "자동 이어가기 요청" : "Automatic continuation requested"}</p>;
}
