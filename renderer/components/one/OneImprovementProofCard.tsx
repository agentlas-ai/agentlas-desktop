"use client";

import type {
  OneImprovementChangeV1,
  OneImprovementComparisonRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneImprovementResult,
} from "@shared/one-improvement-proof";
import { redactSecrets } from "@shared/secret-patterns";
import styles from "./OneImprovementProofCard.module.css";

type Locale = "ko" | "en";

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", {
    maximumFractionDigits: 3,
  }).format(value);
}

function resultLabel(result: OneImprovementResult, ko: boolean): string {
  const labels: Record<OneImprovementResult, [string, string]> = {
    improved: ["개선", "Improved"],
    no_change: ["변화 없음", "No change"],
    regression: ["나빠짐", "Worse"],
  };
  return labels[result][ko ? 0 : 1];
}

function evidenceTypeLabel(change: OneImprovementChangeV1, ko: boolean): string {
  const labels: Record<OneImprovementChangeV1["evidenceType"], [string, string]> = {
    measured: ["측정", "Measured"],
    estimate: ["추정", "Estimate"],
    qualitative: ["말로 확인", "Qualitative check"],
  };
  return labels[change.evidenceType][ko ? 0 : 1];
}

function changeKindLabel(change: OneImprovementChangeV1, ko: boolean): string {
  const labels: Record<OneImprovementChangeV1["kind"], [string, string]> = {
    instruction_reduction: ["지시 감소", "Fewer instructions"],
    time_reduction: ["시간 감소", "Time reduction"],
    revision_reduction: ["수정 감소", "Fewer revisions"],
    quality_improvement: ["품질 변화", "Quality change"],
    risk_avoidance: ["위험 회피", "Risk avoidance"],
  };
  return labels[change.kind][ko ? 0 : 1];
}

function assetTypeLabel(asset: OneImprovementReusedAssetV1, ko: boolean): string {
  const labels: Record<OneImprovementReusedAssetV1["assetType"], [string, string]> = {
    memory: ["기억한 선호", "Saved preference"],
    agent: ["전담 도우미", "Personal helper"],
    team: ["팀", "Team"],
    experience: ["작업 방식", "Saved approach"],
    automation: ["미리 해두기", "Prepared routine"],
  };
  return labels[asset.assetType][ko ? 0 : 1];
}

function directionLabel(
  direction: Extract<OneImprovementChangeV1, { evidenceType: "measured" }>["comparisonDirection"],
  ko: boolean,
): string {
  if (direction === "lower_is_better") return ko ? "낮을수록 좋음" : "Lower is better";
  return ko ? "높을수록 좋음" : "Higher is better";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ReferenceList({ values, emptyLabel }: { values: readonly string[]; emptyLabel: string }) {
  const refs = unique(values);
  if (refs.length === 0) return <span className={styles.muted}>{emptyLabel}</span>;
  return <span className={styles.refList}>{refs.map((ref) => <code key={ref}>{ref}</code>)}</span>;
}

function ComparisonFacts({
  change,
  comparison,
  locale,
}: {
  change: OneImprovementChangeV1;
  comparison: OneImprovementComparisonRecord | undefined;
  locale: Locale;
}) {
  const ko = locale === "ko";
  const comparisonAvailable = comparison != null;

  if (change.evidenceType === "measured") {
    return <dl className={styles.factGrid}>
      <div><dt>{ko ? "기준값" : "Baseline"}</dt><dd>{formatNumber(change.baseline, locale)}</dd></div>
      <div><dt>{ko ? "현재값" : "Current"}</dt><dd>{formatNumber(change.current, locale)}</dd></div>
      <div><dt>{ko ? "단위" : "Unit"}</dt><dd>{redactSecrets(change.unit)}</dd></div>
      <div><dt>{ko ? "방향" : "Direction"}</dt><dd>{directionLabel(change.comparisonDirection, ko)}</dd></div>
    </dl>;
  }

  if (change.evidenceType === "estimate") {
    return <>
      <dl className={styles.factGrid}>
        <div><dt>{ko ? "비교 기준" : "Compared with"}</dt><dd>{comparisonAvailable ? (ko ? "지난번 결과" : "Previous result") : (ko ? "확인할 수 없음" : "Unavailable")}</dd></div>
        <div><dt>{ko ? "이번 결과" : "This result"}</dt><dd>{comparisonAvailable ? (ko ? "확인됨" : "Checked") : (ko ? "확인할 수 없음" : "Unavailable")}</dd></div>
        <div><dt>{ko ? "추정 변화" : "Estimated change"}</dt><dd>{formatNumber(change.estimate.value, locale)}</dd></div>
        <div><dt>{ko ? "단위" : "Unit"}</dt><dd>{redactSecrets(change.estimate.unit)}</dd></div>
      </dl>
      <p className={styles.boundary}>{ko
        ? "정확히 재기 어려운 값이라 추정으로 표시했습니다. 계산 근거와 방법은 아래에서 확인할 수 있어요."
        : "This value is shown as an estimate because it could not be measured exactly. You can review the basis and method below."}</p>
      <dl className={styles.method}>
        <div><dt>{ko ? "추정 근거" : "Estimate basis"}</dt><dd>{redactSecrets(change.estimate.basis)}</dd></div>
        <div><dt>{ko ? "방법" : "Method"}</dt><dd>{redactSecrets(change.estimate.method)}</dd></div>
      </dl>
    </>;
  }

  return <>
    <dl className={styles.factGrid}>
      <div><dt>{ko ? "지난번 확인" : "Previous checks"}</dt><dd>{change.baselineRefs.length}{ko ? "개" : ""}</dd></div>
      <div><dt>{ko ? "이번 확인" : "Current checks"}</dt><dd>{change.currentRefs.length}{ko ? "개" : ""}</dd></div>
      <div><dt>{ko ? "단위" : "Unit"}</dt><dd>{ko ? "수치 단위 없음" : "Not numeric"}</dd></div>
      <div><dt>{ko ? "확인 방법" : "Check method"}</dt><dd>{ko ? "같은 기준으로 직접 비교" : "Compared using the same criteria"}</dd></div>
    </dl>
    <p className={styles.boundary}>{ko
      ? "말로 확인한 변화는 억지로 숫자로 바꾸지 않았습니다."
      : "A qualitative change is not converted into a made-up number."}</p>
  </>;
}

export function OneImprovementProofCard({
  record,
  locale,
  onManageAsset,
}: {
  record: OneImprovementProofRecord;
  locale: Locale;
  onManageAsset: (asset: OneImprovementReusedAssetV1) => void;
}) {
  const ko = locale === "ko";
  const proof = record.proof;
  const comparisonByChange = new Map(record.comparisons.map((item) => [item.changeRef, item]));
  const resultCounts: Record<OneImprovementResult, number> = { improved: 0, no_change: 0, regression: 0 };
  record.comparisons.forEach((comparison) => { resultCounts[comparison.result] += 1; });

  const receiptRefs = unique([
    ...proof.receiptRefs,
    ...proof.reusedAssets.flatMap((asset) => asset.receiptRefs),
    ...record.comparisons.flatMap((comparison) => comparison.receiptRefs),
  ]);
  const evidenceRefs = unique([
    ...record.trustedEvidenceRefs,
    ...record.comparisons.flatMap((comparison) => [
      comparison.comparisonEvidenceRef,
      ...comparison.evidenceRefs,
      ...(comparison.measurementEvidenceRefs ?? []),
      ...(comparison.rubricEvidenceRefs ?? []),
    ]),
  ]);
  const verificationRefs = unique(record.comparisons.flatMap((comparison) => [
    comparison.baselineOutputVerificationRef,
    comparison.baselineOutcomeVerificationRef,
    comparison.currentOutputVerificationRef,
    comparison.currentOutcomeVerificationRef,
  ]));

  return (
    <details className={styles.card} data-attribution-status={proof.attributionStatus}>
      <summary className={styles.summary}>
        <span className={styles.summaryRow}>
          <span className={styles.titleBlock}>
            <span className={styles.eyebrow}>{ko ? "지난번과 비교" : "Compared with last time"}</span>
            <span className={styles.title} id={`${proof.improvementProofId}-title`}>
              {ko ? "지난번보다 달라진 점" : "What changed since last time"}
            </span>
            <span className={styles.subtitle}>{ko
              ? `저장해둔 기억이나 팀 ${proof.reusedAssets.length}개 활용 · ${record.comparisons.length}개 항목 비교`
              : `Used ${proof.reusedAssets.length} saved preference or team item${proof.reusedAssets.length === 1 ? "" : "s"} · compared ${record.comparisons.length} item${record.comparisons.length === 1 ? "" : "s"}`}</span>
          </span>
          <span className={styles.summaryResults} aria-label={ko ? "비교 결과 요약" : "Comparison result summary"}>
            {(["improved", "no_change", "regression"] as const).map((result) => (
              resultCounts[result] > 0 && <span key={result} className={styles.result} data-result={result}>
                {resultLabel(result, ko)} {resultCounts[result]}
              </span>
            ))}
          </span>
        </span>
      </summary>

      <div className={styles.content} aria-labelledby={`${proof.improvementProofId}-title`}>
        <p className={styles.intro}>{ko
          ? "전에 저장한 기억이나 팀을 다시 쓴 뒤 무엇이 달라졌는지 보여드려요. 좋아진 점뿐 아니라 그대로이거나 나빠진 점도 숨기지 않습니다."
          : "This shows what changed after One reused something you saved. Improvements, unchanged results, and worse results are all shown."}</p>
        <p className={styles.boundary} data-attribution-status={proof.attributionStatus}>{proof.attributionStatus === "established"
          ? (ko
              ? "이번 변화와 다시 사용한 항목의 연결을 확인했습니다. 아래에 적힌 범위를 넘어 원인을 단정하지 않습니다."
              : "The link between this change and the reused item was confirmed. One does not claim more than the comparisons below.")
          : (ko
              ? "다시 사용한 항목과 변화가 함께 보였지만, 그것 때문에 달라졌다고 단정할 수는 없습니다."
              : "The reused item and the change appeared together, but One cannot claim that one caused the other.")}</p>

        <ol className={styles.comparisonList}>
          {proof.changes.map((change) => {
            const comparison = comparisonByChange.get(change.changeRef);
            return <li key={change.changeRef} className={styles.comparison} data-result={comparison?.result ?? "unknown"}>
              <header className={styles.comparisonHeader}>
                <span className={styles.changeMeta}>
                  <span className={styles.evidenceType}>{evidenceTypeLabel(change, ko)}</span>
                  <span>{changeKindLabel(change, ko)}</span>
                </span>
                {comparison
                  ? <span className={styles.result} data-result={comparison.result}>{resultLabel(comparison.result, ko)}</span>
                  : <span className={styles.result} data-result="unknown">{ko ? "비교 참조 없음" : "Comparison unavailable"}</span>}
              </header>
              <p className={styles.statement}>{redactSecrets(change.statement)}</p>
              <ComparisonFacts change={change} comparison={comparison} locale={locale} />
            </li>;
          })}
        </ol>

        <section className={styles.assets} aria-labelledby={`${proof.improvementProofId}-assets`}>
          <div className={styles.sectionHeading}>
            <h4 id={`${proof.improvementProofId}-assets`}>{ko ? "이번에 다시 사용한 것" : "Reused this time"}</h4>
            <span>{ko ? "누르면 해당 설정을 엽니다" : "Opens its settings"}</span>
          </div>
          <ul>
            {proof.reusedAssets.map((asset) => {
              return <li key={asset.assetRef}>
                <span className={styles.assetText}>
                  <span><b>{redactSecrets(asset.label)}</b><em>{assetTypeLabel(asset, ko)}</em></span>
                  <small>{ko ? "다음에도 끄거나 바꿀 수 있어요" : "You can change or turn this off anytime"}</small>
                </span>
                <button
                  type="button"
                  onClick={() => onManageAsset(asset)}
                  aria-label={`${ko ? "관리" : "Manage"}: ${redactSecrets(asset.label)}`}
                >{ko ? "설정 보기" : "View settings"}</button>
              </li>;
            })}
          </ul>
        </section>

        <details className={styles.references}>
          <summary>{ko ? "어떻게 확인했나요?" : "How was this checked?"}</summary>
          <dl>
            <div><dt>{ko ? "작업 기록" : "Work records"}</dt><dd>{receiptRefs.length}{ko ? "개" : ""}</dd></div>
            <div><dt>{ko ? "비교한 자료" : "Compared evidence"}</dt><dd>{evidenceRefs.length}{ko ? "개" : ""}</dd></div>
            <div><dt>{ko ? "결과 확인" : "Result checks"}</dt><dd>{verificationRefs.length}{ko ? "개" : ""}</dd></div>
          </dl>
          <details className={styles.technicalRecords}>
            <summary>{ko ? "기록 번호 보기" : "Show record numbers"}</summary>
            <dl>
              <div><dt>{ko ? "이번 일" : "Current work"}</dt><dd><code>{proof.taskId}</code> · v{record.currentTaskVersion}</dd></div>
              <div><dt>{ko ? "작업 기록" : "Work records"}</dt><dd><ReferenceList values={receiptRefs} emptyLabel={ko ? "없음" : "None"} /></dd></div>
              <div><dt>{ko ? "비교 자료" : "Evidence records"}</dt><dd><ReferenceList values={evidenceRefs} emptyLabel={ko ? "없음" : "None"} /></dd></div>
              <div><dt>{ko ? "결과 확인" : "Verification records"}</dt><dd><ReferenceList values={verificationRefs} emptyLabel={ko ? "없음" : "None"} /></dd></div>
            </dl>
          </details>
        </details>

        <footer className={styles.footer}>
          <span>{ko ? "확인한 시각" : "Checked at"} · {formatDate(proof.generatedAt, locale)}</span>
        </footer>
      </div>
    </details>
  );
}
