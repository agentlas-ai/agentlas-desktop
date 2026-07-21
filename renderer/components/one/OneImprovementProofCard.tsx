"use client";

import type {
  OneImprovementChangeV1,
  OneImprovementComparisonRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneImprovementResult,
} from "@shared/one-improvement-proof";
import { redactSecrets } from "@shared/secret-patterns";
import { tFor, type Locale } from "@/lib/i18n";
import styles from "./OneImprovementProofCard.module.css";

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

function resultLabel(result: OneImprovementResult, locale: Locale): string {
  if (result === "improved") return tFor(locale, "one.proof.result.improved");
  if (result === "no_change") return tFor(locale, "one.proof.result.no_change");
  return tFor(locale, "one.proof.result.regression");
}

function evidenceTypeLabel(change: OneImprovementChangeV1, locale: Locale): string {
  if (change.evidenceType === "measured") return tFor(locale, "one.proof.evidence.measured");
  if (change.evidenceType === "estimate") return tFor(locale, "one.proof.evidence.estimate");
  return tFor(locale, "one.proof.evidence.qualitative");
}

function changeKindLabel(change: OneImprovementChangeV1, locale: Locale): string {
  if (change.kind === "instruction_reduction") return tFor(locale, "one.proof.kind.instruction_reduction");
  if (change.kind === "time_reduction") return tFor(locale, "one.proof.kind.time_reduction");
  if (change.kind === "revision_reduction") return tFor(locale, "one.proof.kind.revision_reduction");
  if (change.kind === "quality_improvement") return tFor(locale, "one.proof.kind.quality_improvement");
  return tFor(locale, "one.proof.kind.risk_avoidance");
}

function assetTypeLabel(asset: OneImprovementReusedAssetV1, locale: Locale): string {
  if (asset.assetType === "memory") return tFor(locale, "one.proof.asset.memory");
  if (asset.assetType === "agent") return tFor(locale, "one.proof.asset.agent");
  if (asset.assetType === "team") return tFor(locale, "one.proof.asset.team");
  if (asset.assetType === "experience") return tFor(locale, "one.proof.asset.experience");
  return tFor(locale, "one.proof.asset.automation");
}

function directionLabel(
  direction: Extract<OneImprovementChangeV1, { evidenceType: "measured" }>["comparisonDirection"],
  locale: Locale,
): string {
  if (direction === "lower_is_better") return tFor(locale, "one.proof.direction.lower");
  return tFor(locale, "one.proof.direction.higher");
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
  const comparisonAvailable = comparison != null;

  if (change.evidenceType === "measured") {
    return <dl className={styles.factGrid}>
      <div><dt>{tFor(locale, "one.proof.facts.baseline")}</dt><dd>{formatNumber(change.baseline, locale)}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.current")}</dt><dd>{formatNumber(change.current, locale)}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.unit")}</dt><dd>{redactSecrets(change.unit)}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.direction")}</dt><dd>{directionLabel(change.comparisonDirection, locale)}</dd></div>
    </dl>;
  }

  if (change.evidenceType === "estimate") {
    return <>
      <dl className={styles.factGrid}>
        <div><dt>{tFor(locale, "one.proof.facts.compared_with")}</dt><dd>{comparisonAvailable ? tFor(locale, "one.proof.facts.previous_result") : tFor(locale, "one.proof.facts.unavailable")}</dd></div>
        <div><dt>{tFor(locale, "one.proof.facts.this_result")}</dt><dd>{comparisonAvailable ? tFor(locale, "one.proof.facts.checked") : tFor(locale, "one.proof.facts.unavailable")}</dd></div>
        <div><dt>{tFor(locale, "one.proof.facts.estimated_change")}</dt><dd>{formatNumber(change.estimate.value, locale)}</dd></div>
        <div><dt>{tFor(locale, "one.proof.facts.unit")}</dt><dd>{redactSecrets(change.estimate.unit)}</dd></div>
      </dl>
      <p className={styles.boundary}>{tFor(locale, "one.proof.estimate_boundary")}</p>
      <dl className={styles.method}>
        <div><dt>{tFor(locale, "one.proof.facts.estimate_basis")}</dt><dd>{redactSecrets(change.estimate.basis)}</dd></div>
        <div><dt>{tFor(locale, "one.proof.facts.method")}</dt><dd>{redactSecrets(change.estimate.method)}</dd></div>
      </dl>
    </>;
  }

  return <>
    <dl className={styles.factGrid}>
      <div><dt>{tFor(locale, "one.proof.facts.previous_checks")}</dt><dd>{change.baselineRefs.length}{tFor(locale, "one.proof.count_suffix")}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.current_checks")}</dt><dd>{change.currentRefs.length}{tFor(locale, "one.proof.count_suffix")}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.unit")}</dt><dd>{tFor(locale, "one.proof.facts.not_numeric")}</dd></div>
      <div><dt>{tFor(locale, "one.proof.facts.check_method")}</dt><dd>{tFor(locale, "one.proof.facts.same_criteria")}</dd></div>
    </dl>
    <p className={styles.boundary}>{tFor(locale, "one.proof.qualitative_boundary")}</p>
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
            <span className={styles.eyebrow}>{tFor(locale, "one.proof.eyebrow")}</span>
            <span className={styles.title} id={`${proof.improvementProofId}-title`}>
              {tFor(locale, "one.proof.title")}
            </span>
            <span className={styles.subtitle}>{tFor(locale, "one.proof.subtitle", {
              assets: proof.reusedAssets.length,
              items: record.comparisons.length,
              s1: proof.reusedAssets.length === 1 ? "" : "s",
              s2: record.comparisons.length === 1 ? "" : "s",
            })}</span>
          </span>
          <span className={styles.summaryResults} aria-label={tFor(locale, "one.proof.results_aria")}>
            {(["improved", "no_change", "regression"] as const).map((result) => (
              resultCounts[result] > 0 && <span key={result} className={styles.result} data-result={result}>
                {resultLabel(result, locale)} {resultCounts[result]}
              </span>
            ))}
          </span>
        </span>
      </summary>

      <div className={styles.content} aria-labelledby={`${proof.improvementProofId}-title`}>
        <p className={styles.intro}>{tFor(locale, "one.proof.intro")}</p>
        <p className={styles.boundary} data-attribution-status={proof.attributionStatus}>{proof.attributionStatus === "established"
          ? tFor(locale, "one.proof.attribution_established")
          : tFor(locale, "one.proof.attribution_correlated")}</p>

        <ol className={styles.comparisonList}>
          {proof.changes.map((change) => {
            const comparison = comparisonByChange.get(change.changeRef);
            return <li key={change.changeRef} className={styles.comparison} data-result={comparison?.result ?? "unknown"}>
              <header className={styles.comparisonHeader}>
                <span className={styles.changeMeta}>
                  <span className={styles.evidenceType}>{evidenceTypeLabel(change, locale)}</span>
                  <span>{changeKindLabel(change, locale)}</span>
                </span>
                {comparison
                  ? <span className={styles.result} data-result={comparison.result}>{resultLabel(comparison.result, locale)}</span>
                  : <span className={styles.result} data-result="unknown">{tFor(locale, "one.proof.comparison_unavailable")}</span>}
              </header>
              <p className={styles.statement}>{redactSecrets(change.statement)}</p>
              <ComparisonFacts change={change} comparison={comparison} locale={locale} />
            </li>;
          })}
        </ol>

        <section className={styles.assets} aria-labelledby={`${proof.improvementProofId}-assets`}>
          <div className={styles.sectionHeading}>
            <h4 id={`${proof.improvementProofId}-assets`}>{tFor(locale, "one.proof.reused_title")}</h4>
            <span>{tFor(locale, "one.proof.reused_hint")}</span>
          </div>
          <ul>
            {proof.reusedAssets.map((asset) => {
              return <li key={asset.assetRef}>
                <span className={styles.assetText}>
                  <span><b>{redactSecrets(asset.label)}</b><em>{assetTypeLabel(asset, locale)}</em></span>
                  <small>{tFor(locale, "one.proof.asset_note")}</small>
                </span>
                <button
                  type="button"
                  onClick={() => onManageAsset(asset)}
                  aria-label={tFor(locale, "one.proof.manage_aria", { label: redactSecrets(asset.label) })}
                >{tFor(locale, "one.proof.view_settings")}</button>
              </li>;
            })}
          </ul>
        </section>

        <details className={styles.references}>
          <summary>{tFor(locale, "one.proof.how_checked")}</summary>
          <dl>
            <div><dt>{tFor(locale, "one.proof.label.work_records")}</dt><dd>{receiptRefs.length}{tFor(locale, "one.proof.count_suffix")}</dd></div>
            <div><dt>{tFor(locale, "one.proof.label.compared_evidence")}</dt><dd>{evidenceRefs.length}{tFor(locale, "one.proof.count_suffix")}</dd></div>
            <div><dt>{tFor(locale, "one.proof.label.result_checks")}</dt><dd>{verificationRefs.length}{tFor(locale, "one.proof.count_suffix")}</dd></div>
          </dl>
          <details className={styles.technicalRecords}>
            <summary>{tFor(locale, "one.proof.show_record_numbers")}</summary>
            <dl>
              <div><dt>{tFor(locale, "one.proof.label.current_work")}</dt><dd><code>{proof.taskId}</code> · v{record.currentTaskVersion}</dd></div>
              <div><dt>{tFor(locale, "one.proof.label.work_records")}</dt><dd><ReferenceList values={receiptRefs} emptyLabel={tFor(locale, "one.proof.none")} /></dd></div>
              <div><dt>{tFor(locale, "one.proof.label.evidence_records")}</dt><dd><ReferenceList values={evidenceRefs} emptyLabel={tFor(locale, "one.proof.none")} /></dd></div>
              <div><dt>{tFor(locale, "one.proof.label.verification_records")}</dt><dd><ReferenceList values={verificationRefs} emptyLabel={tFor(locale, "one.proof.none")} /></dd></div>
            </dl>
          </details>
        </details>

        <footer className={styles.footer}>
          <span>{tFor(locale, "one.proof.checked_at")} · {formatDate(proof.generatedAt, locale)}</span>
        </footer>
      </div>
    </details>
  );
}
