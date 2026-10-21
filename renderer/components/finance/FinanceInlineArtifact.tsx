"use client";
import type { FinanceAIResult, FinanceReport, FinanceWorkspace } from "@shared/finance";
import { financeReportComputeMetrics, financeReportCompositionTitle, financeReportDirection, financeReportLocale, financeReportProseBlocks, financeReportSourceBlock, financeReportSourceRecords, selectFinanceReportSections, type FinanceReportSourceRecord } from "@shared/finance-report-presentation";
import { ChartBlock } from "@/components/ChartBlock";
import { IconExpand, IconPlus, IconChat, IconFileText } from "@/components/Icon";
import { FinanceReportProse, FinanceReportSources, financeLocalizedReportChartSpec } from "./FinanceReportView";
import { financeArtifactTitle } from "./FinanceArtifactGallery";
import { FinanceBriefText } from "./FinanceMonitorReceipts";
import styles from "./FinanceInlineArtifact.module.css";

/** `sources`: the provider records the report names, kept with the answer so the card can say where its values came from (an older answer has none). */
export interface FinanceInlineSnapshot { report: FinanceReport; ownerScope: string | null; revision: number; sources?: readonly FinanceReportSourceRecord[] }
/** Bind only successful, committed output. Copies keep earlier answers unchanged by later report edits. */
export function financeInlineSnapshots(response: FinanceAIResult, committed: FinanceWorkspace, operationsApplied: boolean, before: FinanceWorkspace): FinanceInlineSnapshot[] {
  if (!operationsApplied || response.status && response.status !== "ok") return [];
  const ids = new Set<string>();
  for (const operation of response.operations ?? []) {
    switch (operation.type) {
      case "report.add": ids.add(operation.report.id); break;
      case "report.refresh":
        for (const report of committed.reports) if (report.parentReportId === operation.reportId && !before.reports.some(previous => previous.id === report.id)) ids.add(report.id);
        break;
      case "report.update": case "report.section.update": case "report.section.remove": case "report.section.move": ids.add(operation.reportId); break;
    }
  }
  return committed.reports.filter(report => ids.has(report.id)).map(report => ({ report: structuredClone(report), ownerScope: committed.ownerScope, revision: committed.revision, sources: financeReportSourceRecords(report, committed.sources) }));
}
export function financeInlineCurrent(snapshot: FinanceInlineSnapshot, workspace: FinanceWorkspace): boolean {
  return snapshot.ownerScope === workspace.ownerScope && workspace.reports.some(report => report.id === snapshot.report.id && JSON.stringify(report) === JSON.stringify(snapshot.report));
}
export function FinanceInlineResponseText({ text, ko, progressive }: { text: string; ko: boolean; progressive: boolean }) {
  return progressive && !!text.trim()
    ? <details className={styles.details}><summary>{ko ? "응답 설명" : "Response explanation"}</summary><FinanceBriefText value={text} ko={ko}/></details>
    : <FinanceBriefText value={text} ko={ko}/>;
}
export function FinanceInlineArtifact({ snapshot, messageId, locale, current, busy, onExpand, onOpen, onPin, onContinue }: {
  snapshot: FinanceInlineSnapshot; messageId: string; locale: string; current?: boolean; busy: boolean;
  onExpand?: (sectionId: string) => void; onOpen?: () => void; onPin?: (sectionId: string) => void; onContinue?: (sectionId?: string) => void;
}) {
  const { report } = snapshot, language = financeReportLocale(report, locale), ko = locale === "ko";
  const sections = selectFinanceReportSections(report), charts = sections.filter(section => section.presentation !== "narrative" && section.presentation !== "comparison" && section.widget?.chartType !== "table").flatMap(section => {
    const spec = financeLocalizedReportChartSpec(section, language); return spec ? [{ section, spec }] : [];
  });
  const allMetrics = sections.flatMap(section => financeReportComputeMetrics(section, language)), metrics = allMetrics.slice(0, 4);
  const prose = sections.filter(section => section.narrative.trim()).flatMap(section => financeReportProseBlocks(section.narrative));
  const first = charts[0]?.section, title = (first && financeReportCompositionTitle(first, language)) ?? financeArtifactTitle(report.title), sourceBlock = financeReportSourceBlock(report, snapshot.sources, language);
  return <section className={styles.card} lang={language} dir={financeReportDirection(report, locale)} aria-label={title}>
    <header className={styles.header}><h3 title={title}>{title}</h3><div className={styles.actions}>
      {first && onExpand && <button type="button" onClick={() => onExpand(first.id)} aria-label={`${ko ? "차트 확대" : "Expand chart"} · ${title}`} title={ko ? "차트 확대" : "Expand chart"}><IconExpand size={17}/></button>}
      {onOpen && <button type="button" disabled={!current || busy} onClick={onOpen} aria-label={`${ko ? "문서 열기" : "Open document"} · ${title}`} title={ko ? "문서 열기" : "Open document"}><IconFileText size={17}/></button>}
      {first && onPin && <button type="button" disabled={!current || busy} onClick={() => onPin(first.id)} aria-label={`${ko ? "대시보드에 고정" : "Pin to dashboard"} · ${title}`} title={ko ? "대시보드에 고정" : "Pin to dashboard"}><IconPlus size={17}/></button>}
    </div></header>
    {metrics.length > 0 && <dl className={styles.metrics}>{metrics.map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd title={String(metric.value)}>{metric.display} {metric.unit && <small>{metric.unit}</small>}</dd></div>)}</dl>}
    {allMetrics.length > 4 && <details className={styles.details}><summary>{ko ? "추가 지표" : "More metrics"}</summary><dl className={styles.metrics}>{allMetrics.slice(4).map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd title={String(metric.value)}>{metric.display} {metric.unit && <small>{metric.unit}</small>}</dd></div>)}</dl></details>}
    {charts.map(({ section, spec }, index) => <div className={styles.chart} key={section.id}>{charts.length > 1 && <h4>{financeReportCompositionTitle(section, language) ?? section.title}</h4>}<ChartBlock code={JSON.stringify(spec)} presetSpec={spec} blockId={`finance-inline-${messageId}-${report.id}-${section.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p>{ko ? "차트를 표시하지 못했습니다." : "Chart unavailable."}</p>}/>{index > 0 && onPin && <button type="button" className={styles.secondary} disabled={!current || busy} onClick={() => onPin(section.id)}>{ko ? "이 차트 고정" : "Pin this chart"}</button>}</div>)}
    {!!prose.length && <div className={styles.prose}><FinanceReportProse value={prose[0].text} language={language}/>{prose.length > 1 && <details className={styles.details}><summary>{ko ? "설명 더 보기" : "Read more"}</summary>{prose.slice(1).map((block, index) => <FinanceReportProse key={index} value={block.text} language={language}/>)}</details>}</div>}
    {sourceBlock && <FinanceReportSources block={sourceBlock} dir={financeReportDirection(report, locale)}/>}
    {(onContinue || current === false) && <footer className={styles.footer}>{onContinue && <button type="button" className={styles.continue} disabled={!current || busy} onClick={() => onContinue(first?.id)}><IconChat size={16}/>{ko ? "이 결과로 계속" : "Continue with this result"}</button>}{current === false && <span>{ko ? "저장 결과가 변경되었습니다." : "The saved result has changed."}</span>}</footer>}
  </section>;
}
