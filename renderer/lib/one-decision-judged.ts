// Renderer-side judged risk/disposition for the One DecisionCard. The Desktop
// render pass has no synchronous model, so it warms the resident judge through
// the narrow judgment bridge and re-renders once the verdict lands. normalizeOneDecision
// FAILS CLOSED (highest risk, approval required) until/unless a model verdict
// arrives — it never keyword-decides. When the bridge/model is unavailable the
// readers stay empty (fail closed) and `modelUnavailable` drives the plain
// connect-a-model note.

import { useEffect, useState } from "react";
import {
  ONE_DECISION_JUDGE_TIMEOUT_MS,
  lexicalOneDecisionDisposition,
  lexicalOneDecisionRiskLevel,
  oneDecisionJudgmentTexts,
  type OneDecisionAuthorityReadiness,
  type OneDecisionJudgedReaders,
  type OneDecisionOptionDisposition,
  type OneDecisionRiskLevel,
} from "@shared/one-decision";
import type { PendingConfirmation } from "@shared/types";
import { judgeLabelViaBridge } from "@/lib/judgment";

const RISK_LABELS: readonly OneDecisionRiskLevel[] = ["R0", "R1", "R2", "R3", "R4"];
const DISPOSITION_LABELS: readonly OneDecisionOptionDisposition[] = ["choice", "approve", "reject", "modify"];
const AUTHORITY_READINESS_LABELS: readonly OneDecisionAuthorityReadiness[] = ["ready", "needs_details"];

export interface JudgedOneDecisionState {
  /** Peek readers for normalizeOneDecision; empty until a model verdict lands. */
  readers: OneDecisionJudgedReaders;
  /** true once a warm attempt found NO connected model — surface connect-a-model. */
  modelUnavailable: boolean;
}

export function useJudgedOneDecision(
  confirmation: Pick<PendingConfirmation, "question" | "header" | "options">,
): JudgedOneDecisionState {
  const texts = oneDecisionJudgmentTexts(confirmation);
  const key = `${texts.combined}\u0000${texts.options.join("\u0000")}`;
  const [risk, setRisk] = useState<Record<string, OneDecisionRiskLevel>>({});
  const [disposition, setDisposition] = useState<Record<string, OneDecisionOptionDisposition>>({});
  const [authorityReadiness, setAuthorityReadiness] = useState<Record<string, OneDecisionAuthorityReadiness>>({});
  const [modelUnavailable, setModelUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lexicalDispositions = texts.options.map(lexicalOneDecisionDisposition);
        const [riskVerdict, readinessVerdict, dispositionVerdicts] = await Promise.all([
          judgeLabelViaBridge<OneDecisionRiskLevel>({
            kind: "one-decision-risk",
            labels: RISK_LABELS,
            input: texts.combined,
            fallback: lexicalOneDecisionRiskLevel(texts.combined, lexicalDispositions),
            timeoutMs: ONE_DECISION_JUDGE_TIMEOUT_MS,
          }),
          judgeLabelViaBridge<OneDecisionAuthorityReadiness>({
            kind: "one-decision-authority-readiness",
            labels: AUTHORITY_READINESS_LABELS,
            input: texts.combined,
            fallback: "needs_details",
            timeoutMs: ONE_DECISION_JUDGE_TIMEOUT_MS,
          }),
          Promise.all(texts.options.map((optionText) =>
            judgeLabelViaBridge<OneDecisionOptionDisposition>({
              kind: "one-decision-disposition",
              labels: DISPOSITION_LABELS,
              input: optionText,
              fallback: lexicalOneDecisionDisposition(optionText),
              timeoutMs: ONE_DECISION_JUDGE_TIMEOUT_MS,
            }).then((verdict) => ({ optionText, verdict })),
          )),
        ]);
        if (cancelled) return;
        const nextDisposition: Record<string, OneDecisionOptionDisposition> = {};
        for (const { optionText, verdict } of dispositionVerdicts) nextDisposition[optionText] = verdict.verdict;
        setRisk({ [texts.combined]: riskVerdict.verdict });
        setAuthorityReadiness({ [texts.combined]: readinessVerdict.verdict });
        setDisposition(nextDisposition);
        setModelUnavailable(false);
      } catch {
        if (cancelled) return;
        setRisk({});
        setAuthorityReadiness({});
        setDisposition({});
        setModelUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-warm whenever the decision text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    readers: {
      risk: (combined) => risk[combined] ?? null,
      disposition: (optionText) => disposition[optionText] ?? null,
      authorityReadiness: (combined) => authorityReadiness[combined] ?? null,
    },
    modelUnavailable,
  };
}
