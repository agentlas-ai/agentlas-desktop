"use client";

import type { FinanceNativeResult as NativeResult } from "@shared/finance-native-ui";
import { FinanceAssetResults } from "./FinanceAssetResults";
import { FinanceHoldingsReview, type FinanceHoldingsSettlement } from "./FinanceHoldingsReview";
import { FinanceInlineArtifact } from "./FinanceInlineArtifact";
import { FinanceInlineQueryResult } from "./FinanceInlineQueryResult";

/** Pure retained-result presentation inside Work's existing UiInstance, never a second transcript or model loop. */
export function FinanceNativeResult({ result, instanceId, revision, resultRef, locale, instanceState = "ready", fallbackText = "", onSettle }: {
  result: NativeResult; instanceId: string; revision: number; resultRef: string; locale: "ko" | "en";
  /** The card's own lifetime, for views that wait for the owner (holdings review). */
  instanceState?: string; fallbackText?: string; onSettle?: (settlement: FinanceHoldingsSettlement) => Promise<unknown>;
}) {
  const { view } = result, ko = locale === "ko";
  // A review waits for the owner's Save; the card owns that decision, the model has no write operation.
  if (view.kind === "holdings") return <FinanceHoldingsReview draft={view.draft} instanceState={instanceState} fallbackText={fallbackText} locale={locale} onSettle={onSettle}/>;
  if (view.kind === "search") return <FinanceAssetResults result={view.result} query={view.query} ko={ko} watchlistIds={new Set()}/>;
  if (view.kind === "query") return <FinanceInlineQueryResult messageId={`${instanceId}-${revision}`} locale={locale}
    snapshot={{ ownerScope: result.ownerScope, revision, entry: { datasetId: resultRef, kind: "query", request: view.request, assets: [], result: view.result } }}/>;
  const coverage = view.coverage;
  return <>
    {coverage && coverage.missingPositions > 0 && <p role="status">{ko ? `가격을 확인한 보유 항목 ${coverage.pricedPositions}/${coverage.positions} · ${coverage.missingPositions}개 항목 미확인` : `Priced holdings ${coverage.pricedPositions}/${coverage.positions} · ${coverage.missingPositions} unavailable`}</p>}
    {view.kind === "report" ? <FinanceInlineArtifact messageId={`${instanceId}-${revision}`} locale={locale} busy={false}
      snapshot={{ report: view.report, ownerScope: result.ownerScope, revision: view.workspaceRevision, sources: view.sources }}/>
      : <p role="status">{ko ? "확인된 완전한 통화 그룹이 없어 비중을 표시하지 않았습니다." : "No complete verified currency group is available for an allocation chart."}</p>}
  </>;
}
